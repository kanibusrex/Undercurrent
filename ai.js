/* Undercurrent on-device AI.
   Runs a small language model in the browser with WebLLM (WebGPU). Journal text is only
   ever passed to the model running on this device; the only network traffic is the
   one-time download of the library and the model weights.
   This module is loaded only after the person turns AI on. */

export const WEBLLM_URL = "https://esm.run/@mlc-ai/web-llm@0.2.86";

// Chat models, best first. `gb` is the approximate one-time download.
export const MODELS = [
  { id: "Qwen3.5-4B", label: "Best quality", gb: 2.4, vramMB: 3800 },
  { id: "Qwen3.5-2B", label: "Balanced", gb: 1.1, vramMB: 2200 },
  { id: "Qwen3.5-0.8B", label: "Fastest", gb: 0.5, vramMB: 1100 },
];
export const EMBED_MODEL = "snowflake-arctic-embed-s-q0f32-MLC-b4";

/* ---------- device check ---------- */

// Decide whether this device can run a model, and which one to suggest.
export async function detect() {
  if (window.__undercurrentFakeAI) return { supported: true, f16: true, recommended: MODELS[1].id, reason: "test engine" };
  if (!("gpu" in navigator)) {
    return { supported: false, reason: "This browser doesn't support WebGPU, which on-device AI needs. Try a recent Chrome or Edge on a computer, or Safari 26 or later." };
  }
  let adapter = null;
  try { adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }); } catch {}
  if (!adapter) return { supported: false, reason: "Your browser supports WebGPU, but couldn't find a usable graphics processor on this device." };
  const info = adapter.info || {};
  // Tested on an Intel HD 505 (gen 9): every model either hung the GPU (the driver resets
  // long GPU jobs) or produced garbage. Say so up front instead of after a big download.
  const oldIntel = /intel/i.test(info.vendor || "") && /^gen-[5-9]$/i.test(info.architecture || "");
  if (oldIntel) {
    return { supported: false, reason: "This device's graphics chip is too old to run an AI model reliably — in testing, chips like it froze or produced nonsense. A newer laptop, a Mac with Apple silicon, or a recent phone will work." };
  }
  const f16 = adapter.features.has("shader-f16");
  const memoryGB = navigator.deviceMemory || 4; // Chrome caps this at 8
  const phone = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  // Integrated graphics share system memory; older Intel GPUs are also slow.
  const integrated = /intel/i.test(info.vendor || "") && !/xe|arc/i.test(info.architecture || "");
  let recommended = MODELS[0].id;
  if (phone || memoryGB <= 4) recommended = MODELS[2].id;
  else if (integrated || memoryGB < 8) recommended = MODELS[1].id;
  return { supported: true, f16, recommended, gpu: [info.vendor, info.architecture].filter(Boolean).join(" ") };
}

export const fullModelId = (id, f16 = true) => `${id}-${f16 ? "q4f16_1" : "q4f32_1"}-MLC`;

/* ---------- engine ---------- */

let engine = null;
let loadedModel = null;
let loading = null;

export const isLoaded = () => !!engine;

// Load (or reuse) the chat model plus the small search model. `onProgress(fraction, text)`.
export async function load(modelId, { f16 = true, onProgress = () => {} } = {}) {
  const fake = window.__undercurrentFakeAI;
  if (fake) { engine = fake; loadedModel = modelId; onProgress(1, "Ready"); return; }
  const full = fullModelId(modelId, f16);
  if (engine && loadedModel === full) return;
  if (loading) return loading;
  loading = (async () => {
    if (engine) { await engine.unload?.(); engine = null; }
    const webllm = await import(WEBLLM_URL);
    engine = await webllm.CreateMLCEngine([full, EMBED_MODEL], {
      initProgressCallback: (p) => onProgress(p.progress ?? 0, p.text ?? ""),
    });
    loadedModel = full;
  })();
  try { await loading; } finally { loading = null; }
}

export async function unload() {
  if (engine && !window.__undercurrentFakeAI) await engine.unload?.();
  engine = null;
  loadedModel = null;
}

// Remove downloaded model files from this browser.
export async function deleteDownloads() {
  if (window.__undercurrentFakeAI) return;
  await unload();
  for (const name of await caches.keys()) if (/webllm|mlc/i.test(name)) await caches.delete(name);
}

// Some models emit a hidden reasoning block; journaling replies never need it.
const stripThinking = (s) => s.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();

// Chat with the loaded model. Streams through `onToken(textSoFar)` when given.
// Turn low-level GPU failures into something a person can act on.
export function friendlyError(err) {
  const msg = String(err?.message || err || "");
  if (/device (was )?lost|mapAsync|GPUBuffer|out of memory|OOM/i.test(msg)) {
    return "this device's graphics chip stopped responding while running the model. It may not be powerful enough — a smaller model might work, or try a newer device.";
  }
  return msg || "something went wrong";
}

export async function chat(messages, { maxTokens = 300, temperature = 0.4, onToken } = {}) {
  if (!engine) throw new Error("AI isn't loaded");
  if (engine.__fake) return stripThinking(await engine.chat(messages, { maxTokens, onToken }));
  const request = {
    model: loadedModel, messages, max_tokens: maxTokens, temperature,
    extra_body: { enable_thinking: false },
  };
  if (!onToken) {
    const reply = await engine.chat.completions.create(request);
    return stripThinking(reply.choices[0].message.content || "");
  }
  let text = "";
  for await (const chunk of await engine.chat.completions.create({ ...request, stream: true })) {
    text += chunk.choices[0]?.delta?.content || "";
    onToken(stripThinking(text));
  }
  return stripThinking(text);
}

// Embed texts for semantic search. Returns one unit-length vector per text.
export async function embed(texts) {
  if (!engine) throw new Error("AI isn't loaded");
  const vectors = engine.__fake
    ? await engine.embed(texts)
    : (await engine.embeddings.create({ model: EMBED_MODEL, input: texts })).data.map((d) => d.embedding);
  return vectors.map((v) => {
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  });
}

export const cosine = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);

/* ---------- prompts ---------- */

export const SYSTEM = `You are the reflection assistant inside Undercurrent, a private journal. You help the writer notice patterns in their own words.
Rules:
- Be warm, plain and brief. Speak to the writer as "you".
- Describe what the entries say. Never diagnose, never name mental disorders or conditions, never suggest medication or treatment plans.
- If the writer asks whether they have a condition, say you can't tell that and that a doctor or therapist can.
- Only use what is in the entries provided. If something isn't there, say so. Don't invent details or dates.`;

/* ---------- safety: checks that never depend on the model ---------- */
// (Crisis-language detection lives in index.html so it also covers the editor.)

// Replies that try to diagnose are replaced, not shown.
const DIAGNOSIS = /\b(you (have|likely have|probably have|might have|may have|could have|are suffering from|seem to have|appear to have|meet the criteria)|this (is|sounds like|looks like|suggests)|signs of|symptoms of|consistent with|diagnos\w*)\b[^.]{0,60}\b(depression|depressive|anxiety disorder|gad|ptsd|bipolar|adhd|ocd|panic disorder|disorder|insomnia|burnout syndrome)\b/i;
export const SAFE_DIAGNOSIS_REPLY = "I can't tell whether you have a condition — that's something only a doctor or therapist can work out with you. What I can do is point to what your entries describe: how often things like sleep, worry, or low energy come up, and what seemed to help. If those things are weighing on you, they're worth bringing to a professional — your journal and the questionnaire results in Trends are a good place to start that conversation.";
export function guardReply(text) {
  return DIAGNOSIS.test(text) ? SAFE_DIAGNOSIS_REPLY : text;
}

// Pull the first JSON object out of a reply (models sometimes wrap it in prose or code fences).
export function parseJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}
