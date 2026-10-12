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
  assert(stored.version === 3, "db version " + stored.version);
  assert(JSON.stringify(stored.rows.sort()) === JSON.stringify([1, null].sort()), "stored: " + JSON.stringify(stored.rows));
  await ctx.close();
});

await test("new backups are version 3 and import without shifting", async () => {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const pg = await ctx.newPage();
  await pg.goto(url);
  await pg.click(scaleBtn("anxiety", 0));
  await pg.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Saved"));
  await pg.click("#open-settings");
  const [download] = await Promise.all([pg.waitForEvent("download"), pg.click("#export")]);
  const backup = JSON.parse(await readFile(await download.path(), "utf8"));
  assert(backup.version === 3 && backup.entries[0].anxiety === 0, JSON.stringify(backup));
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

await browser.close();
server.close();
console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
