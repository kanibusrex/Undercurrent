# Undercurrent

*Notice what's beneath the surface.*

A private journal for noticing your mood, anxiety, and what's going on underneath. Everything runs in your browser — your entries never leave your device.

**Live app:** https://kanibusrex.github.io/Undercurrent/

## What it does

- **One entry a day** — a calm, distraction-free writing space with a gentle prompt when you're not sure where to start.
- **Autosave** — every few keystrokes, so nothing is lost if you close the tab.
- **Timeline & search** — browse past days by month, or search everything you've written.
- **Read mode** — entries support light Markdown (headings, **bold**, *italic*, lists, quotes).
- **Private & offline** — an installable PWA. Entries live in your browser's IndexedDB; there's no server and no account.
- **Backups** — export every entry to a JSON file and restore it anytime from **Your data**.

### Coming next

Mood and anxiety check-ins with trends over time, then on-device AI (via WebLLM) that summarizes your weeks and helps you spot patterns — still without anything leaving your device.

## Install

Open the live app and choose **Install** / **Add to Home Screen** in your browser. Installing also asks the browser to protect your entries from being cleared when storage runs low.

## Privacy

There is no backend. Journal entries are stored only in this browser's IndexedDB on this device, and the service worker only caches the app itself. Clearing your browser's site data deletes your entries, so export a backup now and then.

## Not a substitute for care

Undercurrent is a tool for reflection, not a diagnosis or treatment. If you're struggling, please reach out to someone — [find a helpline](https://findahelpline.com) in your country, or in the US call or text **988**.

## Keys

| Key | Action |
|---|---|
| `Alt` + `←` / `→` | Previous / next day |
| `/` | Search entries |
| `Esc` | Clear search |

## Development

No build step — open `index.html` through any static server. Browser tests use Playwright with your installed Chromium:

```sh
npm install
npm test
```
