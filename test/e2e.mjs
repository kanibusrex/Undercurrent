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

await browser.close();
server.close();
console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
