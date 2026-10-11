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
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(overflow <= 0, `overflows by ${overflow}px`);
  // body hides horizontal overflow, so also check nothing is drawn off-screen
  const offscreen = await phone.evaluate(() =>
    [...document.querySelectorAll("header *, .editor *, footer *")]
      .filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > window.innerWidth + 0.5)
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
const inRange = sample.filter((e) => e.mood);
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
  assert(/tagged Sleep, mood was lower \(2\.0 vs 4\.0\) and anxiety was higher \(4\.0 vs 2\.0\)/.test(text), text);
  assert(text.includes("not causes"), "caveat");
});

await test("hard days trigger the gentle note", async () => {
  const hard = inRange.filter((e) => fromKeyDays(e.date) < 14 && (e.mood <= 2 || e.anxiety >= 4)).length;
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

const phone2 = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
phone2.on("pageerror", (e) => errors.push(e.message));
await phone2.goto(url);
await phone2.setInputFiles("#import-file", sampleFile);
await phone2.waitForFunction(() => document.querySelector("#stats").textContent.includes("entries"));
await test("check-in and trends fit on a phone", async () => {
  const off = () => phone2.evaluate(() =>
    [...document.querySelectorAll("header *, .editor *, .trends *")]
      .filter((el) => el.getClientRects().length && !el.closest(".scroll, .tooltip") && el.getBoundingClientRect().right > window.innerWidth + 0.5)
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

await browser.close();
server.close();
console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
