# Undercurrent

*Notice what's beneath the surface.*

A private journal for noticing your mood, anxiety, and what's going on underneath. Everything runs in your browser — your entries never leave your device.

**Live app:** https://kanibusrex.github.io/Undercurrent/

## What it does

- **One entry a day** — a calm, distraction-free writing space with a gentle prompt when you're not sure where to start.
- **Daily check-in** — rate your mood (1 very low to 5 great) and anxiety (0 calm to 4 severe), and tag what's affecting you (sleep, work, family…). A check-in counts on its own, even on days you don't feel like writing.
- **Trends** — average mood and anxiety compared with the previous period, charts over 2 weeks to a year, and **patterns** like "on days you tagged Sleep, anxiety was higher." Every chart has a table view and can be read with the keyboard.
- **Autosave** — every few keystrokes, so nothing is lost if you close the tab.
- **Two-week questionnaires** — the PHQ-9 (depression) and GAD-7 (anxiety), the same short screenings doctors use, scored exactly and tracked over time in Trends. Screening tools, not diagnoses.
- **Reflect (optional on-device AI)** — a gentle recap of your week, a suggested check-in from what you wrote, and answers to questions about your entries, with the days it drew on. The model runs entirely in your browser via [WebLLM](https://github.com/mlc-ai/web-llm); nothing is sent anywhere.
- **Timeline & search** — browse past days by month, or search everything you've written.
- **Read mode** — entries support light Markdown (headings, **bold**, *italic*, lists, quotes).
- **Private & offline** — an installable PWA. Entries live in your browser's IndexedDB; there's no server and no account.
- **Backups** — export every entry to a JSON file and restore it anytime from **Your data**.

### On-device AI

Turn it on from **Reflect**. Your browser downloads a small model once (Qwen3.5 0.8B, 2B or 4B — about 0.5 to 2.4 GB) and runs it on your device's graphics chip with WebGPU, so it works offline afterwards and your writing never leaves the device. It needs a reasonably recent device: a Mac with Apple silicon, a PC with a recent graphics chip, or a recent phone. Older chips (for example Intel HD 500-series) are detected and the feature is switched off, because in testing they froze or produced nonsense.

The AI is told to describe, never diagnose, and Undercurrent doesn't rely on that alone: any reply that tries to diagnose is replaced, and support resources appear whenever your writing or a question contains crisis language — with or without AI.

## Install

Open the live app and choose **Install** / **Add to Home Screen** in your browser. Installing also asks the browser to protect your entries from being cleared when storage runs low.

## Privacy

There is no backend. Journal entries are stored only in this browser's IndexedDB on this device, and the service worker only caches the app itself. Clearing your browser's site data deletes your entries, so export a backup now and then.

## Not a substitute for care

Undercurrent is a tool for reflection, not a diagnosis or treatment. The PHQ-9 and GAD-7 are screening questionnaires; a score of 10 or more is a good reason to talk with a doctor or therapist. Patterns it shows are correlations in what you've logged, not causes. If you log a very low mood, very high anxiety, or several hard days in a row, it gently points you to support. If you're struggling, please reach out to someone — [find a helpline](https://findahelpline.com) in your country, or in the US call or text **988**.

## Keys

| Key | Action |
|---|---|
| `Alt` + `←` / `→` | Previous / next day |
| `/` | Search entries |
| `Esc` | Clear search |

## Credits

PHQ-9 and GAD-7 were developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.

## Development

No build step — open `index.html` through any static server. Browser tests use Playwright with your installed Chromium:

```sh
npm install
npm test
```

The tests use a stand-in AI. To compare real models on your own GPU: `node test/eval-models.mjs Qwen3.5-2B-q4f16_1-MLC` (weights are cached in `~/.cache/undercurrent-eval`).
