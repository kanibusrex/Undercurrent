// Dev-only: compare WebLLM models on Undercurrent's AI tasks, on this machine's GPU.
// Usage: node test/eval-models.mjs <model-id> [...]   (results printed as JSON)
// Model weights are cached in ~/.cache/undercurrent-eval so reruns don't re-download.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = createServer(async (req, res) => {
  try {
    const body = await readFile(join(root, new URL(req.url, "http://x").pathname));
    res.writeHead(200, { "Content-Type": "text/html" }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

const context = await chromium.launchPersistentContext(join(homedir(), ".cache", "undercurrent-eval"), {
  executablePath: process.env.CHROMIUM || "/usr/bin/chromium",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--ignore-gpu-blocklist", "--use-angle=vulkan"],
});
for (const model of process.argv.slice(2)) {
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") process.stderr.write(`[console] ${m.text()}\n`); });
  await page.goto(`http://127.0.0.1:${server.address().port}/test/eval.html?model=${encodeURIComponent(model)}`);
  let last = "";
  for (;;) {
    const r = await page.evaluate(() => window.__evalResult).catch(() => null);
    if (r && (r.status === "done" || r.status === "error")) { console.log(JSON.stringify(r, null, 2)); break; }
    if (r?.progress && r.progress !== last) { last = r.progress; process.stderr.write(`[${model}] ${last.slice(0, 110)}\n`); }
    await new Promise((res) => setTimeout(res, 5000));
  }
  await page.close();
}
await context.close();
server.close();
