# PriceScout

An independent Amazon India buy-assistant extension.

A Chrome (Manifest V3) extension that shows a live **buy score** on Amazon India
product pages and lets you **watch a price target**, alerting you via a native
Chrome notification when it's hit — entirely client-side, no server, no account.

## Why this architecture

- **No build step.** Every file is plain ES2020, loaded exactly as listed in
  `manifest.json`. `npm install && npm run build` isn't needed to try it —
  clone and load unpacked.
- **No hardcoded scraping logic scattered around.** Selectors live at the top
  of `content/content.js` and are mirrored in `offscreen/offscreen.js`
  (see note below on why there are two copies).
- **Correct MV3 background pattern.** Service workers have no `document` or
  `DOMParser`. Rather than regex-scraping raw HTML (fragile) or opening a
  hidden tab (intrusive), background price checks hand the fetched HTML to a
  short-lived **offscreen document** (`chrome.offscreen`), which parses it
  with a real `DOMParser` and returns just the price.
- **Alarm-driven, not `setInterval`.** Service workers are killed and revived
  by the browser, so background checks use `chrome.alarms`, which survives
  worker restarts.

## Install (unpacked, for development)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select this folder
4. Visit any `amazon.in` product page — a round PriceScout button appears bottom-right

## How it works

```
┌───────────────┐   scrape + render        ┌──────────────────────────┐
│ content.js    │──────────────────────────▶│  Amazon PDP (live page)  │
│ (per tab)     │                           └──────────────────────────┘
│               │  chrome.runtime.sendMessage
└──────┬────────┘  (watchlist add/remove, price snapshot)
       │
       ▼
┌───────────────┐  chrome.alarms (hourly)   ┌──────────────────────────┐
│ background.js │──────────────────────────▶│ fetch(productUrl)        │
│ (service      │                           │ credentials: 'include'   │
│  worker)      │◀──────────────────────────│ same-origin, no server   │
│               │  raw HTML                 └──────────────────────────┘
│               │
│               │  chrome.runtime.sendMessage
│               ▼
│        ┌──────────────────┐
│        │ offscreen.js      │  DOMParser lives here — SW has none
│        │ (offscreen doc)   │
│        └──────────────────┘
│               │  { price }
│               ▼
│        price ≤ target? → chrome.notifications.create(...)
└───────────────┘
```

## Buy score

A simple, explainable weighted score (0–100), shown with a "Why this score?"
breakdown rather than a bare number:

| Factor | Weight |
|---|---|
| Star rating | 45 |
| Review volume (capped at 2000 reviews) | 20 |
| Price vs. lowest price seen in your tracking history | 35 |

Weights live in `BUY_SCORE_WEIGHTS` at the top of `content/content.js` —
tune them without touching the scoring logic itself.

## Watchlist & notifications
- Click the PriceScout button on any product page → set a target price → **Watch**
- A background alarm (default: hourly, adjustable in the popup) re-fetches
  each watched product's page and checks the price
- Price drop ⇒ native OS notification; clicking it opens the product
- Every check is appended to that product's local price history, which also
  feeds the buy score's "price vs. history" factor over time

## Reddit & YouTube mentions

Expanding "Reddit & YouTube mentions" in the panel searches both platforms
using the product's title (trimmed to the part before the first `|`/`-`
separator, since Amazon titles are usually keyword-stuffed):

- **Reddit** via its public `search.json` endpoint — no API key required,
  but unauthenticated and can be rate-limited under heavy use.
- **YouTube** by parsing the `ytInitialData` JSON that YouTube embeds in its
  search results page — there's no free key-less search API, so this is the
  standard workaround. It's coupled to YouTube's page structure and is the
  single most likely thing to silently break if Google changes their markup;
  it fails closed (shows "No YouTube reviews found" + a manual search link)
  rather than throwing.

Results are cached per-ASIN for 24h in `chrome.storage.local` and fetched
lazily — only when the section is expanded — so it never slows down the
initial buy-score render.

This does **not** feed into the numeric buy score. Turning a handful of
thread/video titles into a real sentiment percentage needs actual NLP, and a
fabricated-looking "82% positive" figure would be less honest than just
showing the links and letting you read them yourself.

## Known limitations (be upfront about these)

- Amazon's markup changes periodically — if the buy score or watchlist
  checks stop working, the selectors in `content/content.js` and
  `offscreen/offscreen.js` are the first place to look.
- Background checks only run while Chrome is open (a killed/closed browser
  means no checks — this is a client-side-only design, by choice).
- Signed-out sessions may see different prices than signed-in ones, since
  `fetch()` carries whatever cookies the browser currently has for
  `amazon.in`.

## Publishing to the Chrome Web Store (free, one-time $5 developer fee)

1. Bump `"version"` in `manifest.json` for each release
2. `zip -r pricescout.zip . -x ".git/*"` (zip the **contents**, not a wrapping folder)
3. Create a one-time developer account at
   https://chrome.google.com/webstore/devconsole (Google charges a single
   $5 registration fee, not per-extension)
4. **New item** → upload the zip → fill in store listing (description,
   screenshots of the panel + popup, at least one 1280×800 promo image)
5. Under **Privacy practices**, disclose: this extension reads Amazon.in
   page content and stores watched products locally (`chrome.storage.local`)
   — no data leaves the browser, no analytics, no remote servers
6. Submit for review (typically a few days for a first submission)

## File map

```
manifest.json
background/background.js     service worker: state, alarms, notifications, message router
content/content.js           scrapes PDP, renders the floating panel, computes buy score
content/overlay.css          shadow-DOM panel styling
offscreen/offscreen.html/.js hidden document providing DOMParser to the service worker
popup/                       toolbar popup: watchlist list + check-interval setting
icons/                       16/48/128px extension icons
```
