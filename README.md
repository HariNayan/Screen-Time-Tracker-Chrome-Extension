# Site Time Tracker

Chrome extension that tracks how much time you spend on each website. Data stays on your machine — no accounts, no servers, no network requests.

## What it does

Click the extension icon to see a dashboard of where your time went. Two views:

- **Today** — domains you visited today, sorted by time, with a bar chart
- **This Week** — same thing but broken down by day (today, yesterday, and the last 5 days)

Bottom of the popup has buttons to **Export Data** (JSON download) or **Clear All Data**.

Dark/light mode toggle in both the popup and the settings page.

## How tracking works

The background service worker (`background.js`) listens to Chrome tab and window events:

| Event | What happens |
|---|---|
| Switch tabs | Old session ends, new one starts for the active tab's domain |
| Navigate within a tab | Same — ends old, starts new |
| Switch windows | Focus changes to the active tab in the new window |
| Tab closed | Session for that tab is flushed to storage |
| Idle/lock screen | Tracking pauses entirely |
| Unlock/resume | Tracking resumes on whatever tab is active |

A checkpoint alarm fires every 60 seconds. If the current session is still going, it saves the elapsed time as a chunk and resets the start time. This means if Chrome kills the service worker mid-session, you only lose up to 60 seconds of data instead of everything since the last tab switch.

Sessions crossing midnight are split at the boundary — the portion before midnight goes into the previous day's bucket, the portion after goes into today's.

If the gap between checkpoints is longer than 30 minutes (sleep, shutdown, etc.), that time is discarded. Browsing sessions don't get credit for time the computer was off.

## Data format

All data lives in `chrome.storage.local`. Daily usage is stored under keys like `usage:2026-07-07`:

```json
{
  "usage:2026-07-07": {
    "github.com": 5400000,
    "youtube.com": 1200000,
    "stackoverflow.com": 900000
  }
}
```

Values are in milliseconds. The current in-progress session is stored as `currentSession`:

```json
{
  "currentSession": {
    "domain": "github.com",
    "tabId": 123,
    "startTime": 1751923200000
  }
}
```

`currentSession` is persisted so the service worker can resume tracking after being restarted by Chrome. On startup, if the saved session's elapsed time is under 30 minutes, it's flushed and a new session begins for the active tab.

## Settings

Right-click the extension icon → Options (or find it in `chrome://extensions`):

| Setting | What it controls | Range | Default |
|---|---|---|---|
| Idle Threshold | Seconds of inactivity before tracking pauses | 15–300 | 60 |
| Data Retention | Days before old usage data is deleted | 7–365 | 90 |

The idle threshold uses `chrome.idle.setDetectionInterval()` — the actual Chrome idle detection has a minimum of 15 seconds regardless of what you set.

Pruning runs once a day via a Chrome alarm. It compares each `usage:YYYY-MM-DD` key against the retention cutoff and deletes anything older.

## Permissions

```
"permissions": ["tabs", "storage", "alarms", "idle", "downloads"]
```

- `tabs` — read active tab URLs to extract domains
- `storage` — persist usage data locally
- `alarms` — session checkpoints (every 60s) and daily data pruning
- `idle` — detect when the screen is locked or the user is idle
- `downloads` — export data as a JSON file

No `host_permissions`. No content scripts. The extension never makes network requests.

## Ignored URLs

Internal Chrome pages are skipped: `chrome://`, `about:`, `new-tab-page:`. Tabs on these pages don't generate tracking data. If you switch to an ignored page, the current session is ended but no new one starts.

## Popup layout

```
┌──────────────────────────────┐
│ Site Time Tracker    [🌙]    │  ← theme toggle
│ [Today] [This Week]          │  ← view switcher
├──────────────────────────────┤
│ Total Time    Sites Visited  │
│   2h 15m          12         │  ← stats
│ Showing: 2026-07-07          │  ← date range
├──────────────────────────────┤
│ github.com         1h 30m    │
│ ████████████████░░░░         │  ← domain list
│ youtube.com          25m     │
│ ███████░░░░░░░░░░░░░░        │
│ stackoverflow.com    20m     │
│ █████░░░░░░░░░░░░░░░░░       │
│ ...                          │
├──────────────────────────────┤
│ [Export Data] [Clear All]    │  ← footer
└──────────────────────────────┘
```

The week view groups domains under day headers ("Today", "Yesterday", "Mon, Jul 5", etc.). Each day shows its own domain list sorted by time.

## Project files

```
manifest.json    Manifest V3 config — permissions, service worker, popup, options page
background.js    Service worker — session tracking, checkpointing, idle handling, pruning
popup.html       Dashboard markup
popup.css        Dashboard styles (light + dark via CSS custom properties)
popup.js         Dashboard logic — data loading, rendering, theme toggle, export/clear
options.html     Settings page markup + inline styles
options.js       Settings page logic — load/save settings, theme toggle
icons/           Extension icons (16, 48, 128px PNGs)
test.js          Unit tests (run with `node test.js`)
```

## Running tests

```bash
node test.js
```

Tests mock the `chrome.*` APIs and verify session handling, checkpoint splitting, data persistence, and pruning logic.


```
Build by Harinayan 🤖
```
