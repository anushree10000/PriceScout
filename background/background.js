// MV3 service worker. Type "module" per manifest — no importScripts needed
// since everything lives in this one file for simplicity (no bundler).

const WATCHLIST_KEY = 'pricescout_watchlist'; // Record<asin, WatchlistItem>
const PRICE_HISTORY_KEY_PREFIX = 'pricescout_price_history_'; // + asin -> Array<{price, at}>
const SETTINGS_KEY = 'pricescout_settings';
const COMMUNITY_KEY_PREFIX = 'pricescout_community_'; // + asin -> { data, fetchedAt }
const ALARM_NAME = 'pricescout-watchlist-check';
const COMMUNITY_TTL_MS = 24 * 60 * 60 * 1000; // 24h — avoid re-hitting Reddit/YouTube every open

const DEFAULT_SETTINGS = {
  checkIntervalMinutes: 60,
  staggerDelayMs: 3000,
  maxHistoryPoints: 120,
};

// ---------- storage helpers ----------

async function getSettings() {
  const { [SETTINGS_KEY]: settings } = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
}

async function getWatchlist() {
  const { [WATCHLIST_KEY]: list } = await chrome.storage.local.get(WATCHLIST_KEY);
  return list ?? {};
}

async function saveWatchlist(list) {
  await chrome.storage.local.set({ [WATCHLIST_KEY]: list });
}

async function getPriceHistory(asin) {
  const key = PRICE_HISTORY_KEY_PREFIX + asin;
  const result = await chrome.storage.local.get(key);
  return result[key] ?? [];
}

async function appendPriceHistory(asin, price) {
  const settings = await getSettings();
  const key = PRICE_HISTORY_KEY_PREFIX + asin;
  const history = await getPriceHistory(asin);
  const last = history[history.length - 1];
  // avoid noisy duplicate points if price hasn't moved
  if (!last || last.price !== price) {
    history.push({ price, at: Date.now() });
  }
  const trimmed = history.slice(-settings.maxHistoryPoints);
  await chrome.storage.local.set({ [key]: trimmed });
  return trimmed;
}

// ---------- offscreen document (real DOM for the service worker) ----------

let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (existing.length > 0) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: 'Parse fetched Amazon product HTML to read current price for watchlist checks.',
  });
  await creatingOffscreen;
  creatingOffscreen = null;
}

async function fetchCurrentPrice(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) return null;
  const html = await res.text();

  await ensureOffscreenDocument();
  const parsed = await chrome.runtime.sendMessage({
    type: 'PRICESCOUT_OFFSCREEN_PARSE_PRICE',
    html,
  });
  if (!parsed?.ok) return null;
  return parsed.price;
}

// ---------- community mentions (Reddit + YouTube, no API key) ----------

function shortenTitleForSearch(title) {
  // Amazon titles are noisy ("OnePlus N6 | 6GB+128GB | Mid... 8000mAh Battery | ...")
  // Take the part before the first separator so search queries stay focused.
  return title.split(/[|,–-]/)[0].trim().slice(0, 80);
}

async function searchReddit(query) {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&limit=5`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return [];
  const data = await res.json();
  return (data?.data?.children ?? []).map((c) => ({
    title: c.data.title,
    url: `https://www.reddit.com${c.data.permalink}`,
    subreddit: c.data.subreddit_name_prefixed,
    score: c.data.score,
    numComments: c.data.num_comments,
  }));
}

async function searchYouTube(query) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query + ' review')}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const html = await res.text();

  // YouTube embeds its search results as JSON in a <script> tag rather than
  // exposing a free search API. This is the standard no-key technique, but
  // it's coupled to YouTube's page structure and can break without notice.
  const match = html.match(/var ytInitialData = (.*?);<\/script>/s);
  if (!match) return [];

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return [];
  }

  const items = [];
  try {
    const sections =
      data.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents;
    outer: for (const section of sections) {
      const results = section?.itemSectionRenderer?.contents ?? [];
      for (const r of results) {
        const vr = r.videoRenderer;
        if (vr?.videoId) {
          items.push({
            title: vr.title?.runs?.map((run) => run.text).join('') ?? 'Untitled video',
            url: `https://www.youtube.com/watch?v=${vr.videoId}`,
            channel: vr.ownerText?.runs?.[0]?.text ?? '',
          });
        }
        if (items.length >= 5) break outer;
      }
    }
  } catch {
    // structure changed — return whatever we managed to parse rather than throwing
  }
  return items;
}

async function getCommunityMentions(asin, title) {
  const key = COMMUNITY_KEY_PREFIX + asin;
  const cached = await chrome.storage.local.get(key);
  const entry = cached[key];
  if (entry && Date.now() - entry.fetchedAt < COMMUNITY_TTL_MS) {
    return entry.data;
  }

  const query = shortenTitleForSearch(title);
  const [reddit, youtube] = await Promise.all([
    searchReddit(query).catch(() => []),
    searchYouTube(query).catch(() => []),
  ]);
  const data = { reddit, youtube, query };
  await chrome.storage.local.set({ [key]: { data, fetchedAt: Date.now() } });
  return data;
}

// ---------- watchlist checking ----------

async function checkAllWatchedItems() {
  const settings = await getSettings();
  const watchlist = await getWatchlist();
  const items = Object.values(watchlist).filter((item) => item.status === 'watching');

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (i > 0) await sleep(settings.staggerDelayMs);

    let currentPrice;
    try {
      currentPrice = await fetchCurrentPrice(item.url);
    } catch {
      continue; // network hiccup — try again next alarm
    }
    if (currentPrice == null) continue;

    await appendPriceHistory(item.asin, currentPrice);

    const latest = await getWatchlist();
    const fresh = latest[item.asin];
    if (!fresh) continue; // removed mid-check

    fresh.lastCheckedPrice = currentPrice;
    fresh.lastCheckedAt = Date.now();

    if (currentPrice <= fresh.targetPrice && fresh.status === 'watching') {
      fresh.status = 'triggered';
      notifyPriceDrop(fresh, currentPrice);
    }
    latest[item.asin] = fresh;
    await saveWatchlist(latest);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function notifyPriceDrop(item, currentPrice) {
  chrome.notifications.create(`pricescout-${item.asin}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Price drop on PriceScout 📉',
    message: `${item.title}\nNow ₹${Math.round(currentPrice).toLocaleString('en-IN')} (target ₹${Math.round(
      item.targetPrice
    ).toLocaleString('en-IN')})`,
    priority: 2,
  });
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (!notificationId.startsWith('pricescout-')) return;
  const asin = notificationId.replace('pricescout-', '');
  const watchlist = await getWatchlist();
  const item = watchlist[asin];
  if (item) chrome.tabs.create({ url: item.url });
});

// ---------- alarm lifecycle ----------

async function ensureAlarm() {
  const settings = await getSettings();
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (existing && existing.periodInMinutes === settings.checkIntervalMinutes) return;
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: settings.checkIntervalMinutes });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) checkAllWatchedItems();
});

// ---------- message router ----------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // keep the channel open for the async response
});

async function handleMessage(message) {
  switch (message.type) {
    case 'PRICESCOUT_GET_WATCH_ITEM': {
      const watchlist = await getWatchlist();
      return { item: watchlist[message.asin] ?? null };
    }

    case 'PRICESCOUT_GET_WATCHLIST': {
      const watchlist = await getWatchlist();
      return { items: Object.values(watchlist) };
    }

    case 'PRICESCOUT_ADD_TO_WATCHLIST': {
      const watchlist = await getWatchlist();
      const now = Date.now();
      watchlist[message.item.asin] = {
        ...message.item,
        status: 'watching',
        addedAt: now,
        lastCheckedAt: now,
      };
      await saveWatchlist(watchlist);
      await ensureAlarm();
      return { ok: true };
    }

    case 'PRICESCOUT_REMOVE_FROM_WATCHLIST': {
      const watchlist = await getWatchlist();
      delete watchlist[message.asin];
      await saveWatchlist(watchlist);
      return { ok: true };
    }

    case 'PRICESCOUT_RESUME_WATCH': {
      const watchlist = await getWatchlist();
      if (watchlist[message.asin]) {
        watchlist[message.asin].status = 'watching';
        await saveWatchlist(watchlist);
      }
      return { ok: true };
    }

    case 'PRICESCOUT_RECORD_PRICE_SNAPSHOT': {
      const history = await appendPriceHistory(message.asin, message.price);
      return { ok: true, history };
    }

    case 'PRICESCOUT_GET_PRICE_HISTORY': {
      const history = await getPriceHistory(message.asin);
      return { history };
    }

    case 'PRICESCOUT_GET_SETTINGS':
      return { settings: await getSettings() };

    case 'PRICESCOUT_UPDATE_SETTINGS': {
      const current = await getSettings();
      const next = { ...current, ...message.settings };
      await chrome.storage.local.set({ [SETTINGS_KEY]: next });
      await ensureAlarm();
      return { ok: true, settings: next };
    }

    case 'PRICESCOUT_GET_COMMUNITY_MENTIONS': {
      try {
        const data = await getCommunityMentions(message.asin, message.title);
        return { ok: true, ...data };
      } catch (err) {
        return { ok: false, error: String(err), reddit: [], youtube: [] };
      }
    }

    default:
      return { ok: false, error: `Unknown message type: ${message.type}` };
  }
}
