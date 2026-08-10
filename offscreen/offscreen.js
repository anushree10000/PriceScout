// This page exists only so the background service worker (which has no `document`)
// can hand off raw HTML and get parsed values back. Kept intentionally selector-identical
// to content/content.js — if Amazon changes markup, update both.

const SELECTORS = {
  priceWhole:
    '.a-price .a-offscreen, #corePrice_feature_div .a-price .a-offscreen, #corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
  availability: '#availability',
};

function parsePriceText(text) {
  if (!text) return null;
  const cleaned = text.replace(/[^\d.]/g, '');
  const value = parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

function extractPriceFromHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const priceEl = doc.querySelector(SELECTORS.priceWhole);
  const price = parsePriceText(priceEl?.textContent);
  const availabilityText = doc.querySelector(SELECTORS.availability)?.textContent?.trim() ?? '';
  const inStock = !/currently unavailable|out of stock/i.test(availabilityText);
  return { price, inStock };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'PRICESCOUT_OFFSCREEN_PARSE_PRICE') return undefined;
  try {
    const result = extractPriceFromHtml(message.html);
    sendResponse({ ok: true, ...result });
  } catch (err) {
    sendResponse({ ok: false, error: String(err) });
  }
  return true;
});
