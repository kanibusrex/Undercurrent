// Browser tests for Undercurrent. Run with `npm test`.
// Uses an installed Chromium (set CHROMIUM=/path/to/chrome to override).
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("..", import.meta.url));
const shots = join(root, "test", "screenshots");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png" };

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  try {
    const body = await readFile(join(root, path.endsWith("/") ? path + "index.html" : path));
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "text/html" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const executablePath = process.env.CHROMIUM || ["/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
const browser = await chromium.launch({ executablePath });
await mkdir(shots, { recursive: true });

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n    ${err.message.split("\n")[0]}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const pad = (n) => String(n).padStart(2, "0");
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = key(new Date());
const yesterday = key(new Date(Date.now() - 86400000));

const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(url);

const status = () => page.textContent("#status");
const waitSaved = () => page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Saved"));

console.log("Undercurrent");

await test("opens on today with a prompt and nothing saved", async () => {
  assert((await page.title()).startsWith("Undercurrent"), "title");
  assert((await page.textContent("#day-rel")) === "Today", "shows Today");
  assert((await status()) === "Not written yet", "status");
  assert(await page.isVisible("#prompt"), "prompt visible");
  assert(await page.isDisabled("#next-day"), "can't go into the future");
  assert(await page.evaluate(() => document.activeElement.id === "text"), "editor focused");
});

await test("autosaves while typing and survives a reload", async () => {
  await page.fill("#text", "Felt **anxious** before the meeting, but it went fine.\n\n- slept badly\n- walked at lunch");
  await waitSaved();
  assert(!(await page.isVisible("#prompt")), "prompt hides once writing starts");
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#text").value.includes("anxious"));
  assert((await status()).startsWith("Saved"), "status after reload");
});

await test("lists the entry with a preview and stats", async () => {
  const preview = await page.textContent(`.entry-btn[data-date="${today}"] .preview`);
  assert(preview.includes("anxious"), "preview: " + preview);
  assert((await page.textContent("#stats")).includes("1 entry"), "stats");
});

await test("writing yesterday builds a streak", async () => {
  await page.click("#prev-day");
  assert((await page.textContent("#day-rel")) === "Yesterday", "moved to yesterday");
  assert((await page.inputValue("#text")) === "", "yesterday starts empty");
  await page.fill("#text", "Quiet day. Saw my sister and felt calmer.");
  await waitSaved();
  const stats = await page.textContent("#stats");
  assert(stats.includes("2 entries") && stats.includes("2-day streak"), "stats: " + stats);
});

await test("search filters entries and highlights the match", async () => {
  await page.fill("#search", "sister");
  const items = await page.$$eval(".entry-btn", (els) => els.map((e) => e.dataset.date));
  assert(items.length === 1 && items[0] === yesterday, "results: " + items);
  assert((await page.textContent(".entry-btn mark")).toLowerCase() === "sister", "highlight");
  await page.fill("#search", "zebra");
  assert((await page.textContent(".no-results")).includes("zebra"), "no results message");
  await page.fill("#search", "");
});

await test("read mode renders markdown and escapes HTML", async () => {
  await page.click(`.entry-btn[data-date="${today}"]`);
  await page.fill("#text", "# Heading\n**bold** and *soft*\n\n- one\n- two\n\n<img src=x onerror=alert(1)>");
  await waitSaved();
  await page.click("#mode-read");
  const html = await page.innerHTML("#reader");
  assert(html.includes("<h1>Heading</h1>") && html.includes("<strong>bold</strong>") && html.includes("<em>soft</em>"), html);
  assert(html.includes("<ul><li>one</li><li>two</li></ul>"), "list");
  assert(!(await page.$("#reader img")), "raw HTML must not render");
  await page.click("#mode-write");
});

await test("past entries open in read mode", async () => {
  await page.click(`.entry-btn[data-date="${yesterday}"]`);
  assert(await page.isVisible("#reader"), "reader shown");
  assert((await page.getAttribute("#mode-read", "aria-pressed")) === "true", "Read pressed");
});

await test("export, delete, and import round-trip", async () => {
  await page.click("#open-settings");
  assert((await page.textContent("#data-summary")).startsWith("2 entries"), "summary");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export")]);
  const backup = JSON.parse(await readFile(await download.path(), "utf8"));
  assert(backup.app === "undercurrent" && backup.entries.length === 2, "backup contents");
  await page.click("#close-settings");

  await page.click("#delete-entry");
  await page.click("#do-delete");
  await page.waitForFunction(() => document.querySelector("#stats").textContent.includes("1 entry"));

  const file = join(shots, "backup.json");
  await writeFile(file, JSON.stringify(backup));
  await page.setInputFiles("#import-file", file);
  await page.waitForFunction(() => document.querySelector("#stats").textContent.includes("2 entries"));
  assert((await page.textContent("#toast")).includes("1 new"), await page.textContent("#toast"));
});

await test("rejects files that aren't backups", async () => {
  const file = join(shots, "junk.json");
  await writeFile(file, JSON.stringify({ hello: "world" }));
  await page.setInputFiles("#import-file", file);
  await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("isn't an Undercurrent backup"));
});

await test("clearing an entry removes it", async () => {
  await page.click(`.entry-btn[data-date="${yesterday}"]`);
  await page.click("#mode-write");
  await page.fill("#text", "");
  await page.waitForFunction(() => document.querySelector("#stats").textContent.includes("1 entry"));
  assert((await status()) === "Not written yet", "status");
});

await test("another open tab picks up changes", async () => {
  const other = await context.newPage();
  await other.goto(url);
  await page.click("#go-today");
  await page.fill("#text", "Written in the first tab.");
  await waitSaved();
  await other.waitForFunction(() => document.querySelector("#text").value === "Written in the first tab.", null, { timeout: 3000 });
  await other.close();
});

await test("no page errors", async () => {
  assert(!errors.length, errors.join("; "));
});

// Screenshots for a visual check (not committed).
await page.click("#go-today");
await page.fill("#text", "Felt anxious before the meeting, but it went better than I expected.\n\nI noticed my shoulders were tight all morning. A walk at lunch helped more than I thought it would.");
await waitSaved();
await page.click("#prev-day");
await page.fill("#text", "Quiet day. Saw my sister and felt calmer than I have in weeks.");
await waitSaved();
await page.click("#go-today");
await page.waitForTimeout(800);
await page.screenshot({ path: join(shots, "desktop.png") });

const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const phone = await mobile.newPage();
phone.on("pageerror", (e) => errors.push(e.message));
await phone.goto(url);
await test("phone layout has no sideways scroll and a working entry list", async () => {
  await phone.waitForTimeout(800);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - 390);
  assert(overflow <= 0, `overflows by ${overflow}px`);
  // body hides horizontal overflow, so also check nothing is drawn off-screen
  const offscreen = await phone.evaluate(() =>
    [...document.querySelectorAll("header *, .editor, .editor *, footer *")]
      .filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > 390.5)
      .map((el) => el.id || el.className || el.tagName));
  assert(!offscreen.length, "off-screen: " + offscreen.join(", "));
  assert(!(await phone.isVisible("#timeline")), "list hidden by default");
  await phone.click("#toggle-list");
  assert(await phone.isVisible("#timeline"), "list opens");
  await phone.click("#toggle-list");
});
await phone.screenshot({ path: join(shots, "phone.png") });


/* ---------- step 2: check-ins and trends ---------- */
console.log("Check-ins & trends");
const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const p2 = await ctx2.newPage();
p2.on("pageerror", (e) => errors.push(e.message));
await p2.goto(url);
const saved2 = () => p2.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Saved"));
const scaleBtn = (field, n) => `.scale[data-field="${field}"] button[data-value="${n}"]`;

await test("a check-in alone saves an entry and survives a reload", async () => {
  await p2.click(scaleBtn("mood", 4));
  await p2.click(scaleBtn("anxiety", 2));
  await p2.click('#factors button[data-factor="Sleep"]');
  await saved2();
  await p2.reload();
  await p2.waitForSelector(`${scaleBtn("mood", 4)}[aria-checked="true"]`);
  assert((await p2.getAttribute(`${scaleBtn("anxiety", 2)}`, "aria-checked")) === "true", "anxiety restored");
  assert((await p2.getAttribute('#factors button[data-factor="Sleep"]', "aria-pressed")) === "true", "factor restored");
  assert((await p2.textContent('.scale[data-field="mood"] .scale-word')) === "Good", "mood word");
  const preview = await p2.textContent(`.entry-btn[data-date="${today}"] .preview`);
  assert(preview.includes("Mood: good") && preview.includes("Sleep"), "list preview: " + preview);
  assert((await p2.textContent(`.entry-btn[data-date="${today}"] .when`)).includes("Good"), "mood in list");
});

await test("tapping the chosen level clears it; clearing everything removes the entry", async () => {
  await p2.click(scaleBtn("mood", 4));
  await p2.click(scaleBtn("anxiety", 2));
  await p2.click('#factors button[data-factor="Sleep"]');
  await p2.waitForFunction(() => document.querySelector("#status").textContent === "Not written yet");
  assert(!(await p2.$(`.entry-btn[data-date="${today}"] .mood-word`)), "entry gone from list");
});

await test("arrow keys move along a scale", async () => {
  await p2.focus(scaleBtn("mood", 1));
  await p2.keyboard.press("ArrowRight");
  await p2.keyboard.press("ArrowRight");
  assert((await p2.getAttribute(scaleBtn("mood", 2), "aria-checked")) === "true", "moved to 2");
  assert(await p2.evaluate(() => document.activeElement.dataset.value === "2"), "focus follows");
  await saved2();
});

await test("a very low mood shows a gentle support note", async () => {
  assert(await p2.isHidden("#care-note"), "hidden at first");
  await p2.click(scaleBtn("mood", 1));
  assert(await p2.isVisible("#care-note"), "shown for very low mood");
  await p2.click(scaleBtn("mood", 3));
  assert(await p2.isHidden("#care-note"), "hidden again");
  await p2.click(scaleBtn("anxiety", 4));
  assert(await p2.isVisible("#care-note"), "shown for severe anxiety");
  await p2.click(scaleBtn("anxiety", 4));
  await saved2();
});

await test("anxiety runs from 0 (calm) to 4 (severe), and calm is a real answer", async () => {
  const values = await p2.$$eval('.scale[data-field="anxiety"] button', (els) => els.map((e) => e.dataset.value + " " + e.title));
  assert(values.join("|") === "0 Calm|1 Mild|2 Moderate|3 High|4 Severe", values.join("|"));
  await p2.click(scaleBtn("anxiety", 0));
  assert((await p2.textContent('.scale[data-field="anxiety"] .scale-word')) === "Calm", "word");
  await saved2();
  await p2.reload();
  await p2.waitForSelector(`${scaleBtn("anxiety", 0)}[aria-checked="true"]`);
  assert((await p2.textContent('.scale[data-field="anxiety"] .scale-word')) === "Calm", "calm survives a reload");
  const preview = await p2.textContent(`.entry-btn[data-date="${today}"]`);
  assert(preview.includes("Anxiety: calm"), "list: " + preview);
  await p2.click(scaleBtn("anxiety", 0)); // clear it again
  await saved2();
});

await test("trends ask for more check-ins when there aren't enough", async () => {
  await p2.click("#open-trends");
  assert(await p2.isHidden(".editor"), "editor hidden");
  assert((await p2.textContent("#trends-body")).includes("Not enough check-ins"), "empty state");
});

// 30 days of sample data: Sleep-tagged days have lower mood and higher anxiety.
const sample = [];
for (let i = 0; i < 30; i++) {
  const d = new Date(); d.setDate(d.getDate() - i);
  if (i % 7 === 6) continue; // a missed day each week
  const sleep = i % 3 === 0;
  sample.push({ date: key(d), text: i % 2 ? "" : "Sample day " + i, mood: sleep ? 2 : 4, anxiety: sleep ? 4 : 2,
    factors: sleep ? ["Sleep", "Work"] : ["Exercise"], createdAt: 1, updatedAt: 1 });
}
// an entry from before check-ins existed (step 1 format) must still import
sample.push({ date: "2025-01-01", text: "Old entry with no check-in", createdAt: 1, updatedAt: 1 });
const sampleFile = join(shots, "sample.json");
await writeFile(sampleFile, JSON.stringify({ app: "undercurrent", version: 1, entries: sample }));
const inRange = sample.filter((e) => e.mood).map((e) => ({ ...e, anxiety: e.anxiety - 1 })); // v1 backup -> 0–4
const avg = (xs) => (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1);

await test("imports check-ins (and old entries without them)", async () => {
  // clear today's leftover check-in so the sample's version of today is imported
  await p2.click(`.entry-btn[data-date="${today}"]`);
  await p2.click(scaleBtn("mood", 3));
  await p2.waitForFunction(() => document.querySelector("#status").textContent === "Not written yet");
  await p2.setInputFiles("#import-file", sampleFile);
  await p2.waitForFunction((n) => document.querySelector("#stats").textContent.includes(`${n} entries`), sample.length);
});

await test("trends show correct averages and check-in counts", async () => {
  await p2.click("#open-trends");
  await p2.waitForSelector(".tiles");
  const values = await p2.$$eval(".tile .t-value", (els) => els.map((e) => e.firstChild.textContent.trim()));
  assert(values[0] === avg(inRange.map((e) => e.mood)), `mood ${values[0]} vs ${avg(inRange.map((e) => e.mood))}`);
  assert(values[1] === avg(inRange.map((e) => e.anxiety)), `anxiety ${values[1]}`);
  assert(values[2] === String(inRange.length), `check-ins ${values[2]} vs ${inRange.length}`);
});

await test("both charts draw a dot per check-in", async () => {
  const dots = await p2.$$eval("#chart-mood .dot", (els) => els.length);
  const dots2 = await p2.$$eval("#chart-anxiety .dot", (els) => els.length);
  assert(dots === inRange.length && dots2 === inRange.length, `${dots}/${dots2} dots vs ${inRange.length}`);
  assert((await p2.$$("#chart-mood path.line")).length === 1, "one connected line");
});

await test("patterns describe the Sleep difference without claiming a cause", async () => {
  const text = await p2.textContent(".patterns");
  assert(/tagged Sleep, mood was lower \(2\.0 vs 4\.0\) and anxiety was higher \(3\.0 vs 1\.0\)/.test(text), text);
  assert(text.includes("not causes"), "caveat");
});

await test("hard days trigger the gentle note", async () => {
  const hard = inRange.filter((e) => fromKeyDays(e.date) < 14 && (e.mood <= 2 || e.anxiety >= 3)).length;
  const shown = await p2.isVisible(".gentle");
  assert(shown === hard >= 5, `hard=${hard} shown=${shown}`);
});
function fromKeyDays(k) { const [y, m, d] = k.split("-").map(Number); return Math.round((new Date().setHours(0, 0, 0, 0) - new Date(y, m - 1, d)) / 86400000); }

await test("hovering shows one tooltip for the day across both charts", async () => {
  const box = await p2.$eval("#chart-mood", (el) => { const r = el.getBoundingClientRect(); return { x: r.right - 5, y: r.top + 40 }; });
  await p2.mouse.move(box.x, box.y);
  const tip = await p2.textContent("#chart-mood .tooltip");
  assert(tip.includes("Mood") && tip.includes("Anxiety"), tip);
  assert((await p2.getAttribute("#chart-anxiety .cross", "visibility")) === "visible", "crosshair on the other chart");
  await p2.mouse.move(0, 0);
  assert(await p2.isHidden("#chart-mood .tooltip"), "hides on leave");
});

await test("charts can be read with the keyboard", async () => {
  await p2.focus("#chart-anxiety");
  const first = await p2.textContent("#chart-mood .tooltip b");
  await p2.keyboard.press("ArrowLeft");
  const second = await p2.textContent("#chart-mood .tooltip b");
  assert(first && second && first !== second, `${first} -> ${second}`);
});

await test("the table lists every check-in", async () => {
  await p2.click(".data-table summary");
  assert((await p2.$$(".data-table tbody tr")).length === inRange.length, "rows");
});

await test("switching to 2 weeks narrows everything", async () => {
  await p2.click('#range button[data-days="14"]');
  const n = inRange.filter((e) => fromKeyDays(e.date) < 14).length;
  const value = await p2.$$eval(".tile .t-value", (els) => els[2].firstChild.textContent.trim());
  assert(value === String(n), `${value} vs ${n}`);
  assert((await p2.$$("#chart-mood .dot")).length === n, "dots");
});
await p2.click('#range button[data-days="30"]');
await p2.waitForTimeout(300);
await p2.screenshot({ path: join(shots, "trends.png"), fullPage: true });

await test("opening a day from the list returns to the journal", async () => {
  await p2.click(`.entry-btn[data-date="${today}"]`);
  assert(await p2.isVisible(".editor") && (await p2.isHidden("#trends")), "journal shown");
  const opacity = await p2.$eval(".editor", (el) => getComputedStyle(el).opacity);
  assert(opacity === "1", "editor fully visible right away, opacity " + opacity);
});
await p2.screenshot({ path: join(shots, "checkin.png") });

await test("upgrading an existing database moves anxiety to 0–4", async () => {
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  await pg.goto(url + "manifest.json"); // same origin, without the app running
  await pg.evaluate((date) => new Promise((resolve, reject) => {
    const req = indexedDB.open("undercurrent", 1); // the step-1/2 schema
    req.onupgradeneeded = () => req.result.createObjectStore("entries", { keyPath: "date" });
    req.onsuccess = () => {
      const t = req.result.transaction("entries", "readwrite");
      t.objectStore("entries").put({ date, text: "old scale", mood: 3, anxiety: 2, factors: [], createdAt: 1, updatedAt: 1 });
      t.objectStore("entries").put({ date: "2026-01-02", text: "no check-in", createdAt: 1, updatedAt: 1 });
      t.oncomplete = () => { req.result.close(); resolve(); };
      t.onerror = () => reject(t.error);
    };
  }), today);
  await pg.goto(url);
  await pg.waitForSelector(`${scaleBtn("anxiety", 1)}[aria-checked="true"]`);
  assert((await pg.textContent('.scale[data-field="anxiety"] .scale-word')) === "Mild", "old 2 (Mild) is still Mild");
  const stored = await pg.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open("undercurrent");
    req.onsuccess = () => {
      const all = req.result.transaction("entries").objectStore("entries").getAll();
      all.onsuccess = () => resolve({ version: req.result.version, rows: all.result.map((e) => e.anxiety ?? null) });
    };
  }));
  assert(stored.version === 4, "db version " + stored.version);
  assert(JSON.stringify(stored.rows.sort()) === JSON.stringify([1, null].sort()), "stored: " + JSON.stringify(stored.rows));
  await ctx.close();
});

await test("new backups are version 4 and import without shifting", async () => {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const pg = await ctx.newPage();
  await pg.goto(url);
  await pg.click(scaleBtn("anxiety", 0));
  await pg.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Saved"));
  await pg.click("#open-settings");
  const [download] = await Promise.all([pg.waitForEvent("download"), pg.click("#export")]);
  const backup = JSON.parse(await readFile(await download.path(), "utf8"));
  assert(backup.version === 4 && backup.entries[0].anxiety === 0, JSON.stringify(backup));
  await pg.click("#close-settings");
  await pg.click(scaleBtn("anxiety", 0)); // clear, then restore from the backup
  await pg.waitForFunction(() => document.querySelector("#status").textContent === "Not written yet");
  const file = join(shots, "v2.json");
  await writeFile(file, JSON.stringify(backup));
  await pg.setInputFiles("#import-file", file);
  await pg.waitForSelector(`${scaleBtn("anxiety", 0)}[aria-checked="true"]`);
  await ctx.close();
});

const phone2 = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
phone2.on("pageerror", (e) => errors.push(e.message));
await phone2.goto(url);
await phone2.setInputFiles("#import-file", sampleFile);
await phone2.waitForFunction(() => document.querySelector("#stats").textContent.includes("entries"));
await test("check-in and trends fit on a phone", async () => {
  const off = () => phone2.evaluate(() =>
    [...document.querySelectorAll("header *, .editor, .editor *, .trends, .trends *")]
      .filter((el) => el.getClientRects().length && !el.closest(".scroll, .tooltip") && el.getBoundingClientRect().right > 390.5)
      .map((el) => el.id || el.className?.baseVal || el.className || el.tagName));
  let bad = await off();
  assert(!bad.length, "journal off-screen: " + bad.join(", "));
  await phone2.click("#open-trends");
  await phone2.waitForSelector(".tiles");
  bad = await off();
  assert(!bad.length, "trends off-screen: " + bad.join(", "));
});
await phone2.screenshot({ path: join(shots, "trends-phone.png"), fullPage: true });

await test("no page errors (step 2)", async () => {
  assert(!errors.length, errors.join("; "));
});

/* ---------- step 3a: questionnaires ---------- */
console.log("Questionnaires");
const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const p3 = await ctx3.newPage();
p3.on("pageerror", (e) => errors.push(e.message));
await p3.goto(url);
// answer every question in the open questionnaire with `pick(i)`
async function answerAll(pick) {
  const n = await p3.$$eval("#sc-inner .sc-q > li", (els) => els.length);
  for (let i = 0; i < n; i++) await p3.click(`#sc-inner .sc-q > li[data-i="${i}"] .sc-opts button[data-v="${pick(i)}"]`);
  return n;
}

await test("the two-week reminder shows, and 'Not now' snoozes it", async () => {
  assert(await p3.isVisible("#screen-banner"), "banner shown when never taken");
  await p3.click("#banner-later");
  assert(await p3.isHidden("#screen-banner"), "snoozed");
  await p3.reload();
  assert(await p3.isHidden("#screen-banner"), "still snoozed after reload");
  await p3.evaluate(() => localStorage.clear());
  await p3.reload();
  assert(await p3.isVisible("#screen-banner"), "back after the snooze ends");
});

await test("PHQ-9 uses the standard questions, needs every answer, and scores correctly", async () => {
  await p3.click("#banner-start");
  assert((await p3.textContent("#sc-inner .sc-step")).includes("PHQ-9"), "PHQ-9 first");
  const n = await p3.$$eval("#sc-inner .sc-q > li", (els) => els.length);
  assert(n === 9, `${n} questions`);
  assert((await p3.textContent('#sc-inner li[data-i="1"] .q-text')) === "Feeling down, depressed, or hopeless", "wording");
  assert(await p3.isDisabled("#sc-submit"), "can't submit yet");
  await answerAll((i) => (i < 4 ? 2 : i === 8 ? 0 : 1)); // 2*4 + 1*4 + 0 = 12
  assert(await p3.isHidden("#sc-crisis"), "no crisis message for 'not at all'");
  await p3.click("#sc-submit");
  const result = await p3.textContent("#sc-inner .result");
  assert(result.includes("12") && result.includes("Moderate depression symptoms"), result);
  assert(result.includes("10 or more") && result.includes("not a diagnosis"), "guidance + caveat");
});

await test("then GAD-7, with its own score", async () => {
  await p3.click("#sc-next");
  assert((await p3.textContent("#sc-inner .sc-step")).includes("GAD-7"), "GAD-7 next");
  const n = await answerAll(() => 1); // 7
  assert(n === 7, `${n} questions`);
  await p3.click("#sc-submit");
  const result = await p3.textContent("#sc-inner .result");
  assert(result.includes("7") && result.includes("Mild anxiety symptoms"), result);
  await p3.click("#sc-done");
  assert(await p3.isHidden("#screen-banner"), "reminder gone once taken");
});

await test("any answer to the self-harm question shows crisis support immediately", async () => {
  await p3.click("#open-trends");
  await p3.click("#q-start");
  await p3.click('#sc-inner li[data-i="8"] .sc-opts button[data-v="1"]');
  assert(await p3.isVisible("#sc-crisis"), "shown as soon as it's answered");
  assert((await p3.textContent("#sc-crisis")).includes("988"), "has 988");
  await p3.click('#sc-inner li[data-i="8"] .sc-opts button[data-v="0"]');
  assert(await p3.isHidden("#sc-crisis"), "hidden again for 'not at all'");
  await p3.click('#sc-inner li[data-i="8"] .sc-opts button[data-v="1"]');
  await answerAll((i) => (i === 8 ? 1 : 0)); // 1
  await p3.click("#sc-submit");
  await p3.waitForSelector("#sc-inner .result"); // saving happens first
  assert(await p3.isVisible("#sc-inner .result .crisis"), "repeated on the result");
  const result = await p3.textContent("#sc-inner .result");
  assert(result.includes("Down 11 from last time"), "change since last: " + result);
  await p3.click("#sc-done");
});

await test("Trends shows the latest results, a chart, and the history", async () => {
  await p3.waitForFunction(() => document.querySelector(".q-section .tile")?.textContent.includes("Minimal"));
  const tiles = await p3.$$eval(".q-section .tile", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ")));
  assert(tiles[0].includes("PHQ-9") && tiles[0].includes("1") && tiles[0].includes("Minimal"), tiles[0]);
  assert(tiles[1].includes("GAD-7") && tiles[1].includes("7") && tiles[1].includes("Mild"), tiles[1]);
  assert(await p3.$("#score-phq9 svg"), "PHQ-9 chart (2 results)");
  assert(!(await p3.$("#score-gad7")), "no GAD-7 chart with one result");
  await p3.click(".history summary");
  assert((await p3.$$(".history tbody tr")).length === 3, "3 results listed");
  assert((await p3.textContent(".q-section")).includes("No permission required"), "attribution shown");
});

await test("results go into backups, and tampered scores are recomputed", async () => {
  await p3.click("#open-settings");
  const [download] = await Promise.all([p3.waitForEvent("download"), p3.click("#export")]);
  const backup = JSON.parse(await readFile(await download.path(), "utf8"));
  await p3.click("#close-settings");
  assert(backup.screenings.length === 3, "3 in backup");
  const fresh = await (await browser.newContext()).newPage();
  await fresh.goto(url);
  backup.screenings[0].score = 99; // the app must not trust stored scores
  backup.screenings.push({ type: "gad7", answers: [9, 9], takenAt: 5 }); // invalid: dropped
  const file = join(shots, "with-screenings.json");
  await writeFile(file, JSON.stringify(backup));
  await fresh.setInputFiles("#import-file", file);
  await fresh.waitForFunction(() => document.querySelector("#toast").textContent.includes("3 questionnaire results"));
  await fresh.click("#open-trends");
  await fresh.click(".history summary");
  const scores = await fresh.$$eval(".history tbody tr td:nth-child(3)", (els) => els.map((e) => e.textContent));
  assert(scores.sort().join("|") === ["1 · Minimal", "12 · Moderate", "7 · Mild"].sort().join("|"), scores.join("|"));
  await fresh.context().close();
});

await test("deleting a result removes it", async () => {
  p3.once("dialog", (d) => d.accept());
  await p3.click(".history tbody tr:first-child button");
  await p3.waitForFunction(() => document.querySelectorAll(".history tbody tr").length === 2);
});
await p3.click("#q-start");
await p3.waitForTimeout(300);
await p3.screenshot({ path: join(shots, "phq9.png") });
await p3.keyboard.press("Escape");
await p3.screenshot({ path: join(shots, "questionnaires.png"), fullPage: true });

const phone3 = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
await phone3.goto(url);
await test("the questionnaire fits on a phone", async () => {
  await phone3.click("#banner-start");
  const bad = await phone3.evaluate(() => [...document.querySelectorAll("#screening *")]
    .filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > 390.5).map((el) => el.className || el.tagName));
  assert(!bad.length, "off-screen: " + bad.join(", "));
});
await phone3.screenshot({ path: join(shots, "phq9-phone.png") });

/* ---------- step 3b: on-device AI (with a fake engine; the real models are compared in eval-models.mjs) ---------- */
console.log("On-device AI");
const ctx4 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
// A stand-in engine: answers by task, records every prompt, and embeds by keyword.
await ctx4.addInitScript(() => {
  const words = ["sleep", "walk", "dana", "review", "sister", "anxious", "tired"];
  window.__prompts = [];
  window.__undercurrentFakeAI = {
    __fake: true,
    async chat(messages, { onToken } = {}) {
      const prompt = messages[messages.length - 1].content;
      window.__prompts.push(prompt);
      let out;
      if (prompt.includes("suggest a check-in")) out = '```json\n{"mood": 2, "anxiety": 3, "factors": ["Sleep", "family", "Unicorns"], "why": "You mention a bad night and snapping at your sister."}\n```';
      else if (prompt.includes("recap of my week")) out = "<think>hidden</think>This week had some hard nights, and walks seemed to help.";
      else if (prompt.includes("Question: do I have depression")) out = "Based on these entries, you likely have depression.";
      else out = "Walks with Dana on Oct 6 seemed to help.";
      for (let i = 1; i <= 3; i++) onToken?.(out.slice(0, Math.ceil((out.length * i) / 3)));
      return out;
    },
    async embed(texts) {
      return texts.map((t) => words.map((w) => (t.toLowerCase().includes(w) ? 1 : 0)).concat(0.01));
    },
  };
});
const p4 = await ctx4.newPage();
p4.on("pageerror", (e) => errors.push(e.message));
await p4.goto(url);
const saved4 = () => p4.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Saved"));

await test("crisis language in an entry shows support, even without AI", async () => {
  await p4.fill("#text", "Long day.");
  assert(await p4.isHidden("#care-note"), "not for ordinary writing");
  await p4.fill("#text", "Long day. Honestly I don't want to be here anymore.");
  assert(await p4.isVisible("#care-note"), "shown for crisis language");
  await p4.fill("#text", "");
  await p4.waitForFunction(() => document.querySelector("#status").textContent === "Not written yet");
});

await test("AI stays off until set up, and the setup suggests a model", async () => {
  await p4.fill("#text", "Bad night. Woke at 3am heart racing about the review. Snapped at my sister on the phone, felt guilty after.");
  await saved4();
  assert(await p4.isHidden("#ai-suggest-row"), "no AI button before setup");
  await p4.click("#open-reflect");
  await p4.waitForSelector("#ai-setup-go");
  assert((await p4.$$('input[name="ai-model"]')).length === 3, "three model choices");
  assert(await p4.isChecked('input[value="Qwen3.5-2B"]'), "suggested model preselected");
  assert((await p4.textContent("#reflect-body")).includes("entirely on this device"), "privacy explained");
});

await test("turning AI on shows the week and the ask box", async () => {
  await p4.click("#ai-setup-go");
  await p4.waitForSelector("#recap-go");
  assert((await p4.textContent("#ai-model")).includes("Qwen3.5-2B"), "model named");
});

await test("the weekly recap streams, hides model 'thinking', and is saved", async () => {
  await p4.click("#recap-go");
  await p4.waitForFunction(() => document.querySelector("#recap-meta").textContent.startsWith("Written"));
  const text = await p4.textContent("#recap-text");
  assert(text === "This week had some hard nights, and walks seemed to help.", text);
  const prompt = await p4.evaluate(() => window.__prompts.at(-1));
  assert(prompt.includes("Snapped at my sister"), "entry in prompt");
  await p4.reload();
  await p4.click("#open-reflect");
  await p4.waitForFunction(() => document.querySelector("#recap-text")?.textContent.includes("walks seemed to help"));
  assert((await p4.textContent("#recap-go")) === "Rewrite", "offers a rewrite");
});

await test("suggest a check-in: only real factors, and only applied when accepted", async () => {
  await p4.click("#open-reflect"); // back to the journal
  assert(await p4.isVisible("#ai-suggest-row"), "button shows once there's enough writing");
  await p4.click("#ai-suggest");
  await p4.waitForSelector("#suggestion:not([hidden])");
  const sg = await p4.textContent("#suggestion");
  assert(sg.includes("Mood 2 · Low") && sg.includes("Anxiety 3 · High") && sg.includes("Sleep, Family") && !sg.includes("Unicorns"), sg);
  assert((await p4.getAttribute('.scale[data-field="mood"] button[data-value="2"]', "aria-checked")) === "false", "not applied yet");
  await p4.click("#sg-use");
  assert((await p4.getAttribute('.scale[data-field="mood"] button[data-value="2"]', "aria-checked")) === "true", "applied");
  assert((await p4.getAttribute('#factors button[data-factor="Family"]', "aria-pressed")) === "true", "factor applied");
  await saved4();
});

await test("ask your journal answers from the most relevant days and lists them", async () => {
  const sample = [
    ["2026-01-05", "Slept terribly, tired all day."], ["2026-01-06", "Walk with Dana by the river, felt lighter."],
    ["2026-01-07", "Review prep, anxious."], ["2026-01-08", "Cooked dinner, quiet evening."],
  ].map(([date, text]) => ({ date, text, createdAt: 1, updatedAt: 1 }));
  const file = join(shots, "ask.json");
  await writeFile(file, JSON.stringify({ app: "undercurrent", version: 3, entries: sample }));
  await p4.setInputFiles("#import-file", file);
  await p4.waitForFunction(() => document.querySelector("#toast").textContent.includes("Restored"));
  await p4.click("#open-reflect");
  await p4.fill("#ask-input", "When did a walk help?");
  await p4.click("#ask-go");
  await p4.waitForFunction(() => document.querySelector("#ask-sources").textContent.includes("Looked at"));
  assert((await p4.textContent("#ask-answer")).includes("Walks with Dana"), "answer shown");
  const prompt = await p4.evaluate(() => window.__prompts.at(-1));
  assert(prompt.includes("Walk with Dana by the river"), "relevant entry sent to the model");
  const sources = await p4.$$eval("#ask-sources button", (els) => els.map((e) => e.dataset.open));
  assert(sources.includes("2026-01-06"), "sources: " + sources);
  assert(await p4.isHidden("#ask-crisis"), "no crisis card for an ordinary question");
});

await test("a diagnosis in the AI's reply is replaced, never shown", async () => {
  await p4.fill("#ask-input", "do I have depression");
  await p4.click("#ask-go");
  await p4.waitForFunction(() => document.querySelector("#ask-answer").textContent.includes("only a doctor or therapist"));
  assert(!(await p4.textContent("#ask-answer")).includes("likely have depression"), "diagnosis removed");
});

await test("crisis language in a question shows support alongside the answer", async () => {
  await p4.fill("#ask-input", "why do I feel like I want to die");
  await p4.click("#ask-go");
  assert(await p4.isVisible("#ask-crisis"), "support shown");
  assert((await p4.textContent("#ask-crisis")).includes("988"), "988 listed");
  await p4.waitForFunction(() => document.querySelector("#ask-sources").textContent.includes("Looked at"));
});

await test("source dates open that day", async () => {
  await p4.fill("#ask-input", "When did a walk help?");
  await p4.click("#ask-go");
  await p4.waitForFunction(() => document.querySelector("#ask-sources").textContent.includes("Looked at"));
  await p4.click('#ask-sources button[data-open="2026-01-06"]');
  assert(await p4.isVisible(".editor"), "journal shown");
  assert((await p4.inputValue("#text")).includes("Walk with Dana") || (await p4.textContent("#reader")).includes("Walk with Dana"), "that day opened");
});
await p4.click("#open-reflect");
await p4.screenshot({ path: join(shots, "reflect.png"), fullPage: true });

await test("turning AI off removes it and its search data", async () => {
  await p4.click("#open-settings");
  await p4.waitForFunction(() => document.querySelector("#ai-setting-detail").textContent.startsWith("On"));
  p4.once("dialog", (d) => d.accept());
  await p4.click("#ai-setting-btn");
  await p4.waitForFunction(() => document.querySelector("#ai-setting-detail").textContent.startsWith("Off"));
  await p4.click("#close-settings");
  const vectors = await p4.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open("undercurrent");
    req.onsuccess = () => { const all = req.result.transaction("vectors").objectStore("vectors").getAll(); all.onsuccess = () => resolve(all.result.length); };
  }));
  assert(vectors === 0, `${vectors} vectors left`);
  await p4.click("#go-today");
  assert(await p4.isHidden("#ai-suggest-row"), "suggest button gone");
});

const noGpu = await (await browser.newContext()).newPage();
await noGpu.addInitScript(() => { Object.defineProperty(Navigator.prototype, "gpu", { get: () => undefined, configurable: true }); delete Navigator.prototype.gpu; });
await noGpu.goto(url);
await test("devices without WebGPU get a clear explanation", async () => {
  await noGpu.click("#open-reflect");
  await noGpu.waitForFunction(() => document.querySelector("#reflect-body").textContent.includes("isn't available"));
  assert((await noGpu.textContent("#reflect-body")).includes("works without it"), "reassures");
});

const phone4ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await phone4ctx.addInitScript(() => { window.__undercurrentFakeAI = { __fake: true, chat: async () => "Okay.", embed: async (t) => t.map(() => [1, 0]) }; });
const phone4 = await phone4ctx.newPage();
await phone4.goto(url);
await test("Reflect fits on a phone", async () => {
  await phone4.click("#open-reflect");
  await phone4.click("#ai-setup-go");
  await phone4.waitForSelector("#ask-input");
  const bad = await phone4.evaluate(() => [...document.querySelectorAll("header *, .reflect, .reflect *")]
    .filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > 390.5).map((el) => el.id || el.className || el.tagName));
  assert(!bad.length, "off-screen: " + bad.join(", "));
});
await phone4.screenshot({ path: join(shots, "reflect-phone.png"), fullPage: true });

await test("no page errors (AI)", async () => {
  assert(!errors.length, errors.join("; "));
});

/* ---------- step 4a: helplines and safety plan ---------- */
console.log("Helplines & safety plan");
async function pageIn(timezoneId, opts = {}) {
  const c = await browser.newContext({ timezoneId, locale: opts.locale || "en-US", viewport: opts.viewport || { width: 1280, height: 900 }, acceptDownloads: true, ...(opts.mobile ? { isMobile: true, hasTouch: true } : {}) });
  const pg = await c.newPage();
  pg.on("pageerror", (e) => errors.push(e.message));
  await pg.goto(url);
  await pg.waitForSelector("#footer-help a");
  return pg;
}

await test("helplines follow the time zone", async () => {
  const cases = [["America/Chicago", "988"], ["Europe/London", "116 123"], ["Australia/Sydney", "13 11 14"], ["Europe/Paris", "3114"], ["Asia/Kolkata", "14416"]];
  for (const [tz, number] of cases) {
    const pg = await pageIn(tz);
    const footer = await pg.textContent("#footer-help");
    assert(footer.includes(number), `${tz}: ${footer}`);
    await pg.context().close();
  }
});

await test("countries without a listed line point to the directory", async () => {
  const pg = await pageIn("Asia/Tokyo", { locale: "ja-JP" });
  assert((await pg.getAttribute("#footer-help a", "href")) === "https://findahelpline.com", "directory link");
  await pg.context().close();
});

const p5 = await pageIn("Europe/London");
await test("the support note uses the local line and links to the plan", async () => {
  await p5.click('.scale[data-field="mood"] button[data-value="1"]');
  const note = await p5.textContent("#care-note");
  assert(note.includes("116 123") && !note.includes("988") && note.includes("safety plan"), note);
  await p5.click('.scale[data-field="mood"] button[data-value="1"]');
});

await test("an empty safety plan opens ready to fill in", async () => {
  await p5.click('#footer-help a[data-open-plan]');
  assert(await p5.isVisible("#plan"), "plan open");
  assert(await p5.isVisible('#plan textarea[data-list="warning"]'), "edit mode for an empty plan");
  assert((await p5.textContent(".plan-now")).includes("116 123") && (await p5.textContent(".plan-now")).includes("999"), "UK line and emergency number");
  assert((await p5.$$("#plan .plan-step")).length === 7, "seven steps");
});

await test("the plan saves, survives a reload, and makes numbers tappable", async () => {
  await p5.fill('#plan textarea[data-list="warning"]', "Not sleeping\nSkipping meals\n\n");
  await p5.fill('#plan textarea[data-list="coping"]', "Walk by the river");
  await p5.fill('#plan [data-contacts="people"] .contact-row input[type="text"]', "Dana");
  await p5.fill('#plan [data-contacts="people"] .contact-row input[type="tel"]', "+44 7700 900123");
  await p5.click('#plan [data-add="people"]');
  await p5.fill('#plan [data-contacts="people"] .contact-row:nth-child(2) input[type="text"]', "My sister");
  await p5.click("#plan-save");
  await p5.waitForSelector("#plan-edit");
  await p5.click("#plan-close");
  await p5.reload();
  await p5.click('#footer-help a[data-open-plan]');
  await p5.waitForSelector("#plan-edit"); // opens in view mode once filled in
  const text = await p5.textContent("#plan-inner");
  assert(text.includes("Not sleeping") && text.includes("Skipping meals") && text.includes("Walk by the river") && text.includes("My sister"), text);
  assert((await p5.$$('.plan-step:first-of-type li')).length === 2 || (await p5.$$eval(".plan-step", (els) => els[0].querySelectorAll("li").length)) === 2, "blank lines dropped");
  assert((await p5.getAttribute(".plan-contacts a", "href")) === "tel:+447700900123", "tel link cleaned up");
});

await test("picking a different country updates the plan and the footer, and sticks", async () => {
  await p5.selectOption("#plan-country", "IE");
  assert((await p5.textContent(".plan-now")).includes("112"), "Irish emergency number");
  await p5.selectOption("#plan-country", "CA");
  assert((await p5.textContent("#footer-help")).includes("9-8-8"), "footer follows");
  await p5.click("#plan-close");
  await p5.reload();
  assert((await p5.textContent("#footer-help")).includes("9-8-8"), "still Canada after reload");
  await p5.click('#footer-help a[data-open-plan]');
  await p5.selectOption("#plan-country", "GB");
  await p5.click("#plan-close");
});

await test("crisis messages in the questionnaire link to the plan", async () => {
  await p5.click("#banner-start");
  await p5.click('#sc-inner li[data-i="8"] .sc-opts button[data-v="2"]');
  const card = await p5.textContent("#sc-crisis");
  assert(card.includes("116 123") && card.includes("999"), card);
  await p5.click("#sc-crisis [data-open-plan]");
  assert(!(await p5.evaluate(() => document.querySelector("#screening").open)), "questionnaire closed");
  assert(await p5.isVisible("#plan"), "plan open");
  await p5.click("#plan-close");
});

await test("the plan goes into backups and comes back", async () => {
  await p5.click("#open-settings");
  const [download] = await Promise.all([p5.waitForEvent("download"), p5.click("#export")]);
  const backup = JSON.parse(await readFile(await download.path(), "utf8"));
  await p5.click("#close-settings");
  assert(backup.safetyPlan?.sections.warning.length === 2, JSON.stringify(backup.safetyPlan));
  const fresh = await pageIn("Europe/London");
  const file = join(shots, "with-plan.json");
  await writeFile(file, JSON.stringify(backup));
  await fresh.setInputFiles("#import-file", file);
  await fresh.waitForFunction(() => document.querySelector("#toast").textContent.includes("Restored"));
  await fresh.click('#footer-help a[data-open-plan]');
  assert((await fresh.textContent("#plan-inner")).includes("Walk by the river"), "plan restored");
  await fresh.context().close();
});
await test("the plan always opens at the top, with help first", async () => {
  await p5.click('#footer-help a[data-open-plan]');
  await p5.evaluate(() => { document.querySelector("#plan-inner").scrollTop = 9999; });
  await p5.click("#plan-close");
  await p5.click('#footer-help a[data-open-plan]');
  assert((await p5.evaluate(() => document.querySelector("#plan-inner").scrollTop)) === 0, "scrolled to top");
});
await p5.waitForTimeout(200);
await p5.screenshot({ path: join(shots, "plan.png") });
await p5.click("#plan-close");

const phone5 = await pageIn("America/Toronto", { viewport: { width: 390, height: 844 }, mobile: true });
await test("the safety plan fits on a phone", async () => {
  await phone5.click('#footer-help a[data-open-plan]');
  const bad = await phone5.evaluate(() => [...document.querySelectorAll("#plan, #plan *")]
    .filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > 390.5).map((el) => el.className || el.tagName));
  assert(!bad.length, "off-screen: " + bad.join(", "));
  assert((await phone5.textContent(".plan-now")).includes("9-8-8"), "Canadian line");
});
await phone5.screenshot({ path: join(shots, "plan-phone.png") });

/* ---------- step 4b: passphrase lock (encryption at rest) ---------- */
console.log("Passphrase lock");
const ctx6 = await browser.newContext({ timezoneId: "America/Chicago", viewport: { width: 1280, height: 900 } });
const p6 = await ctx6.newPage();
p6.on("pageerror", (e) => errors.push(e.message));
await p6.goto(url);
const SECRET = "plum-orchard-secret";
const PASS = "river lantern seven toast";
// Everything IndexedDB holds, as text — what someone with access to the browser's files could read.
const rawDump = (pg) => pg.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open("undercurrent");
  req.onsuccess = () => {
    const d = req.result, names = [...d.objectStoreNames], out = {};
    const t = d.transaction(names);
    for (const n of names) t.objectStore(n).getAll().onsuccess = (e) => { out[n] = e.target.result; };
    t.oncomplete = () => { d.close(); resolve(JSON.stringify(out, (k, v) => (v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? "[bytes]" : v))); };
  };
}));
const unlock = async (pg, pass) => { await pg.fill("#lock-pass", pass); await pg.click("#lock-go"); };

await test("setup: an entry, a check-in, a questionnaire result and a plan", async () => {
  await p6.fill("#text", `Today I wrote about the ${SECRET}.`);
  await p6.click('.scale[data-field="mood"] button[data-value="4"]');
  await p6.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Saved"));
  await p6.click("#banner-start");
  for (let i = 0; i < 9; i++) await p6.click(`#sc-inner li[data-i="${i}"] .sc-opts button[data-v="1"]`);
  await p6.click("#sc-submit");
  await p6.waitForSelector("#sc-inner .result");
  await p6.click("#sc-done");
  await p6.click('#footer-help a[data-open-plan]');
  await p6.fill('#plan textarea[data-list="coping"]', "Call Dana");
  await p6.click("#plan-save");
  await p6.click("#plan-close");
  assert((await rawDump(p6)).includes(SECRET), "readable before the lock");
});

await test("turning the lock on checks the passphrase and the warning", async () => {
  await p6.click("#open-settings"); await p6.waitForSelector("#settings[open]");
  await p6.click("#lock-setting-btn");
  await p6.fill("#pass-new", "short");
  await p6.fill("#pass-confirm", "short");
  await p6.click("#pass-go");
  assert((await p6.textContent("#pass-error")).includes("8 characters"), "too short");
  await p6.fill("#pass-new", PASS);
  await p6.fill("#pass-confirm", PASS + "x");
  await p6.click("#pass-go");
  assert((await p6.textContent("#pass-error")).includes("don't match"), "mismatch");
  await p6.fill("#pass-confirm", PASS);
  await p6.click("#pass-go");
  assert((await p6.textContent("#pass-error")).includes("can't be recovered"), "warning must be acknowledged");
  await p6.check("#pass-ack");
  await p6.click("#pass-go");
  await p6.waitForFunction(() => !document.querySelector("#pass-dialog").open, null, { timeout: 60000 });
  assert((await p6.textContent("#lock-setting-detail")).startsWith("On"), "shows on");
  await p6.click("#close-settings");
});

await test("at rest, nothing readable is left — only encrypted records", async () => {
  const dump = await rawDump(p6);
  assert(!dump.includes(SECRET), "entry text not stored in the clear");
  assert(!dump.includes(PASS), "passphrase never stored");
  const parsed = JSON.parse(dump);
  assert(parsed.entries.every((e) => e.sealed && !("text" in e) && !("mood" in e)), "entries sealed");
  assert(parsed.screenings.every((r) => r.sealed && !("answers" in r)), "questionnaires sealed");
  assert(parsed.meta.find((m) => m.key === "safetyPlan" && !m.sealed), "safety plan readable for the lock screen (default)");
});

await test("the app keeps working while unlocked", async () => {
  await p6.fill("#text", `Today I wrote about the ${SECRET}. And more.`);
  await p6.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Saved"));
  assert(!(await rawDump(p6)).includes("And more"), "new writing is encrypted too");
});

await test("after a reload it's locked, and nothing from the journal is on the page", async () => {
  await p6.reload();
  await p6.waitForSelector("#lockscreen", { state: "visible" });
  assert(await p6.isHidden(".wrap"), "journal hidden");
  assert(!(await p6.content()).includes(SECRET), "entry not in the page");
  assert((await p6.textContent("#lock-help")).includes("988"), "helpline on the lock screen");
});

await test("the safety plan can be read from the lock screen, but not edited", async () => {
  await p6.click("#lock-plan");
  assert((await p6.textContent("#plan-inner")).includes("Call Dana"), "plan shown");
  assert(!(await p6.$("#plan-edit")), "no editing while locked");
  await p6.click("#plan-close");
});

await test("a wrong passphrase is refused; the right one opens the journal", async () => {
  await unlock(p6, "wrong passphrase here");
  await p6.waitForFunction(() => document.querySelector("#lock-error").textContent.includes("didn't work"), null, { timeout: 60000 });
  await unlock(p6, PASS);
  await p6.waitForFunction((s) => document.querySelector("#text")?.value.includes(s), SECRET, { timeout: 60000 });
  assert(await p6.isHidden("#lockscreen"), "lock screen gone");
  assert((await p6.getAttribute('.scale[data-field="mood"] button[data-value="4"]', "aria-checked")) === "true", "check-in decrypted");
  await p6.click("#open-trends");
  assert((await p6.textContent(".q-section")).includes("PHQ-9"), "questionnaire decrypted");
  await p6.click("#go-today");
});

await test("hiding the plan from the lock screen encrypts it too", async () => {
  await p6.click("#open-settings"); await p6.waitForSelector("#settings[open]");
  await p6.uncheck("#plan-on-lock");
  let sealed = false;
  for (let i = 0; i < 40 && !sealed; i++) {
    sealed = !!JSON.parse(await rawDump(p6)).meta.find((m) => m.key === "safetyPlan")?.sealed;
    if (!sealed) await p6.waitForTimeout(250);
  }
  assert(sealed, "plan sealed");
  await p6.click("#lock-now");
  await p6.waitForSelector("#lockscreen", { state: "visible" });
  assert(await p6.isHidden("#lock-plan"), "no plan button when it's private");
  await unlock(p6, PASS);
  await p6.waitForSelector("#lockscreen", { state: "hidden", timeout: 60000 });
  await p6.click("#open-settings"); await p6.waitForSelector("#settings[open]");
  await p6.check("#plan-on-lock");
  await p6.click("#close-settings");
});

await test("another open tab locks when the lock is turned on elsewhere, and on 'Lock now'", async () => {
  const other = await ctx6.newPage();
  await other.goto(url);
  await other.waitForSelector("#lockscreen", { state: "visible" });
  await unlock(other, PASS);
  await other.waitForSelector("#lockscreen", { state: "hidden", timeout: 60000 });
  await p6.click("#open-settings"); await p6.waitForSelector("#settings[open]");
  await p6.click("#lock-now");
  await other.waitForSelector("#lockscreen", { state: "visible", timeout: 10000 });
  await other.close();
  await unlock(p6, PASS);
  await p6.waitForSelector("#lockscreen", { state: "hidden", timeout: 60000 });
});

await test("it locks itself after the chosen idle time", async () => {
  await p6.click("#open-settings"); await p6.waitForSelector("#settings[open]");
  await p6.selectOption("#autolock", "5");
  await p6.click("#close-settings");
  await p6.evaluate(() => { lastActivity = Date.now() - 6 * 60000; checkAutoLock(); });
  await p6.waitForSelector("#lockscreen", { state: "visible", timeout: 10000 });
  await unlock(p6, PASS);
  await p6.waitForSelector("#lockscreen", { state: "hidden", timeout: 60000 });
});

const PASS2 = "harbor pencil quiet moss";
await test("changing the passphrase: the old one stops working, the new one works", async () => {
  await p6.click("#open-settings"); await p6.waitForSelector("#settings[open]");
  await p6.click("#lock-change");
  await p6.fill("#pass-current", "not it at all");
  await p6.fill("#pass-new", PASS2);
  await p6.fill("#pass-confirm", PASS2);
  await p6.click("#pass-go");
  await p6.waitForFunction(() => document.querySelector("#pass-error").textContent.includes("didn't work"), null, { timeout: 60000 });
  await p6.fill("#pass-current", PASS);
  await p6.click("#pass-go");
  await p6.waitForFunction(() => !document.querySelector("#pass-dialog").open, null, { timeout: 60000 });
  await p6.click("#lock-now");
  await p6.waitForSelector("#lockscreen", { state: "visible" });
  await unlock(p6, PASS);
  await p6.waitForFunction(() => document.querySelector("#lock-error").textContent.includes("didn't work"), null, { timeout: 60000 });
  await unlock(p6, PASS2);
  await p6.waitForFunction((s) => document.querySelector("#text")?.value.includes(s), SECRET, { timeout: 60000 });
});

await test("turning the lock off decrypts everything", async () => {
  await p6.click("#open-settings"); await p6.waitForSelector("#settings[open]");
  await p6.click("#lock-setting-btn");
  await p6.fill("#pass-current", PASS2);
  await p6.click("#pass-go");
  await p6.waitForFunction(() => !document.querySelector("#pass-dialog").open, null, { timeout: 60000 });
  await p6.click("#close-settings");
  const parsed = JSON.parse(await rawDump(p6));
  assert(!parsed.meta.some((m) => m.key === "lock"), "lock record removed");
  assert(parsed.entries.every((e) => !e.sealed) && (await rawDump(p6)).includes(SECRET), "plain again");
  await p6.reload();
  await p6.waitForFunction((s) => document.querySelector("#text")?.value.includes(s), SECRET);
  assert(await p6.isHidden("#lockscreen"), "no lock screen");
});

await test("forgot passphrase: erasing starts over with an empty journal", async () => {
  await p6.click("#open-settings"); await p6.waitForSelector("#settings[open]");
  await p6.click("#lock-setting-btn");
  await p6.fill("#pass-new", PASS);
  await p6.fill("#pass-confirm", PASS);
  await p6.check("#pass-ack");
  await p6.click("#pass-go");
  await p6.waitForFunction(() => !document.querySelector("#pass-dialog").open, null, { timeout: 60000 });
  await p6.reload();
  await p6.click("#lock-forgot");
  assert(await p6.isDisabled("#erase-go"), "needs the word first");
  await p6.fill("#erase-confirm", "erase");
  await p6.click("#erase-go");
  await p6.waitForSelector("#lockscreen", { state: "hidden" });
  await p6.waitForFunction(() => document.querySelector("#stats").textContent.includes("will appear here"));
  assert(!(await rawDump(p6)).includes("sealed"), "nothing left");
});

const phone6 = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
await phone6.goto(url);
await test("the lock screen fits on a phone", async () => {
  await phone6.evaluate(() => { document.body.classList.add("locked"); document.querySelector("#lock-help").textContent = "Need someone right now? 988"; });
  const bad = await phone6.evaluate(() => [...document.querySelectorAll(".lockscreen *")]
    .filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > 390.5).map((el) => el.className || el.tagName));
  assert(!bad.length, "off-screen: " + bad.join(", "));
});
await phone6.screenshot({ path: join(shots, "lock-phone.png") });

await test("no page errors (lock)", async () => {
  assert(!errors.length, errors.join("; "));
});

/* ---------- step 4c: encrypted backups and the reminder ---------- */
console.log("Backups");
const ctx7 = await browser.newContext({ timezoneId: "America/Chicago", viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const p7 = await ctx7.newPage();
p7.on("pageerror", (e) => errors.push(e.message));
await p7.goto(url);
const BSECRET = "teal-heron-backup-secret";
const exportFile = async (pg) => {
  const [download] = await Promise.all([pg.waitForEvent("download"), pg.click("#export")]);
  return { name: download.suggestedFilename(), text: await readFile(await download.path(), "utf8") };
};
const freshPage = async () => {
  const c = await browser.newContext({ timezoneId: "America/Chicago" });
  const pg = await c.newPage();
  pg.on("pageerror", (e) => errors.push(e.message));
  await pg.goto(url);
  await pg.waitForSelector("#footer-help a");
  return pg;
};

await test("after five entries with no backup, a gentle reminder appears", async () => {
  await p7.click("#banner-later"); // the questionnaire nudge comes first; set it aside
  for (let i = 4; i >= 0; i--) {
    await p7.evaluate((n) => openDay(addDays(todayKey(), -n)), i);
    await p7.click("#mode-write");
    await p7.fill("#text", i === 0 ? `Entry with the ${BSECRET}.` : `Day ${i}`);
    await p7.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Saved"));
  }
  await p7.waitForSelector("#backup-banner", { state: "visible" });
  await p7.click("#backup-later");
  assert(await p7.isHidden("#backup-banner"), "snoozed");
  await p7.evaluate(() => localStorage.removeItem("undercurrent.backupSnoozedUntil"));
  await p7.reload();
  await p7.waitForSelector("#backup-banner", { state: "visible" });
});

await test("'Back up now' opens the backup options; exporting clears the reminder", async () => {
  await p7.click("#backup-now");
  await p7.waitForSelector("#settings[open]");
  const f = await exportFile(p7);
  assert(f.text.includes(BSECRET) && !f.name.includes("encrypted"), "plain backup by default");
  await p7.click("#close-settings");
  assert(await p7.isHidden("#backup-banner"), "reminder gone");
});

let protectedFile;
await test("a backup can be protected with a passphrase", async () => {
  await p7.click("#open-settings"); await p7.waitForSelector("#settings[open]");
  await p7.check("#export-protect");
  await p7.fill("#export-pass", "short");
  await p7.fill("#export-pass2", "short");
  await p7.click("#export");
  assert((await p7.textContent("#export-error")).includes("8 characters"), "too short");
  await p7.fill("#export-pass", "maple window ocean drum");
  await p7.fill("#export-pass2", "maple window ocean drum");
  protectedFile = await exportFile(p7);
  await p7.click("#close-settings");
  const parsed = JSON.parse(protectedFile.text);
  assert(parsed.encrypted && !parsed.entries && protectedFile.name.includes("encrypted"), "encrypted file");
  assert(!protectedFile.text.includes(BSECRET) && !protectedFile.text.includes("maple window"), "no plaintext, no passphrase");
});

await test("importing a protected backup asks for its passphrase", async () => {
  const pg = await freshPage();
  const file = join(shots, "protected.json");
  await writeFile(file, protectedFile.text);
  await pg.setInputFiles("#import-file", file);
  await pg.waitForSelector("#import-pass-dialog[open]");
  await pg.fill("#import-pass", "wrong guess entirely");
  await pg.click("#import-pass-go");
  await pg.waitForFunction(() => document.querySelector("#import-pass-error").textContent.includes("didn't open"), null, { timeout: 60000 });
  await pg.fill("#import-pass", "maple window ocean drum");
  await pg.click("#import-pass-go");
  await pg.waitForFunction(() => document.querySelector("#toast").textContent.includes("5 new"), null, { timeout: 60000 });
  assert((await pg.inputValue("#text")).includes(BSECRET), "restored");
  await pg.context().close();
});

await test("cancelling the passphrase prompt imports nothing", async () => {
  const pg = await freshPage();
  const file = join(shots, "protected.json");
  await pg.setInputFiles("#import-file", file);
  await pg.waitForSelector("#import-pass-dialog[open]");
  await pg.click("#import-pass-cancel");
  assert((await pg.textContent("#stats")).includes("will appear here"), "nothing imported");
  await pg.context().close();
});

let lockedBackup;
await test("with the lock on, every backup is encrypted with the lock's passphrase", async () => {
  await p7.click("#open-settings"); await p7.waitForSelector("#settings[open]");
  await p7.click("#lock-setting-btn");
  await p7.fill("#pass-new", "copper meadow lamp nine");
  await p7.fill("#pass-confirm", "copper meadow lamp nine");
  await p7.check("#pass-ack");
  await p7.click("#pass-go");
  await p7.waitForFunction(() => !document.querySelector("#pass-dialog").open, null, { timeout: 60000 });
  assert(await p7.isHidden("#export-protect-row"), "no choice to make: it's always encrypted");
  lockedBackup = await exportFile(p7);
  await p7.click("#close-settings");
  assert(JSON.parse(lockedBackup.text).encrypted && !lockedBackup.text.includes(BSECRET), "encrypted");
  const pg = await freshPage();
  const file = join(shots, "locked.json");
  await writeFile(file, lockedBackup.text);
  await pg.setInputFiles("#import-file", file);
  await pg.waitForSelector("#import-pass-dialog[open]");
  await pg.fill("#import-pass", "copper meadow lamp nine");
  await pg.click("#import-pass-go");
  await pg.waitForFunction(() => document.querySelector("#toast").textContent.includes("5 new"), null, { timeout: 60000 });
  await pg.context().close();
});

await test("restoring into a locked journal keeps it encrypted", async () => {
  await p7.click("#open-settings"); await p7.waitForSelector("#settings[open]");
  const file = join(shots, "protected.json");
  await p7.setInputFiles("#import-file", file);
  await p7.waitForSelector("#import-pass-dialog[open]");
  await p7.fill("#import-pass", "maple window ocean drum");
  await p7.click("#import-pass-go");
  await p7.waitForFunction(() => document.querySelector("#toast").textContent.includes("Restored"), null, { timeout: 60000 });
  const dump = await rawDump(p7);
  assert(!dump.includes(BSECRET), "imported entries were encrypted on the way in");
  await p7.click("#close-settings");
});
await p7.click("#open-settings"); await p7.waitForSelector("#settings[open]");
await p7.screenshot({ path: join(shots, "settings-locked.png") });
await p7.click("#close-settings");


const phone7 = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
await phone7.goto(url);
await test("settings and the passphrase dialog fit on a phone", async () => {
  const off = (sel) => phone7.evaluate((sel) => [...document.querySelectorAll(sel)]
    .filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > 390.5).map((el) => el.id || el.className || el.tagName), sel);
  await phone7.click("#open-settings"); await phone7.waitForSelector("#settings[open]");
  await phone7.check("#export-protect");
  let bad = await off("#settings, #settings *");
  assert(!bad.length, "settings off-screen: " + bad.join(", "));
  await phone7.click("#lock-setting-btn");
  bad = await off("#pass-dialog, #pass-dialog *");
  assert(!bad.length, "passphrase dialog off-screen: " + bad.join(", "));
});
await phone7.screenshot({ path: join(shots, "pass-phone.png") });

await test("no page errors (backups)", async () => {
  assert(!errors.length, errors.join("; "));
});

await browser.close();
server.close();
console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
