// Runs on every Amazon.in product page. No build step — plain ES2020, no imports,
// so it loads exactly as listed in manifest.json with zero bundler dependency.

const SELECTORS = {
  title: '#productTitle',
  priceWhole:
    '.a-price .a-offscreen, #corePrice_feature_div .a-price .a-offscreen, #corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
  ratingPopover: '#acrPopover',
  reviewCountText: '#acrCustomerReviewText',
};

const BUY_SCORE_WEIGHTS = {
  rating: 45,
  reviewVolume: 20,
  priceVsHistory: 35,
  reviewVolumeCeiling: 2000,
};

function getAsinFromUrl() {
  const match = window.location.pathname.match(/\/dp\/([A-Z0-9]{10})/);
  return match ? match[1] : null;
}

function parsePriceText(text) {
  if (!text) return null;
  const cleaned = text.replace(/[^\d.]/g, '');
  const value = parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

function extractProduct() {
  const asin = getAsinFromUrl();
  if (!asin) return null;

  const title = document.querySelector(SELECTORS.title)?.textContent?.trim() ?? '';
  const priceEl = document.querySelector(SELECTORS.priceWhole);
  const price = parsePriceText(priceEl?.textContent);

  const ratingTitle = document.querySelector(SELECTORS.ratingPopover)?.getAttribute('title') ?? '';
  const ratingMatch = ratingTitle.match(/([\d.]+)\s+out of/);
  const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

  const reviewCountText = document.querySelector(SELECTORS.reviewCountText)?.textContent ?? '';
  const reviewCountMatch = reviewCountText.replace(/,/g, '').match(/(\d+)/);
  const reviewCount = reviewCountMatch ? parseInt(reviewCountMatch[1], 10) : 0;

  const thumbnailUrl = document.querySelector('#landingImage, #imgTagWrapperId img')?.getAttribute('src') ?? '';

  if (!title || price == null) return null;

  return {
    asin,
    title,
    price,
    rating,
    reviewCount,
    thumbnailUrl,
    url: `https://www.amazon.in/dp/${asin}`,
  };
}

function computeBuyScore(product, priceHistoryLow) {
  const reasons = [];
  let score = 0;

  if (product.rating != null) {
    const ratingScore = (product.rating / 5) * BUY_SCORE_WEIGHTS.rating;
    score += ratingScore;
    reasons.push(`Rating ${product.rating}/5 → ${ratingScore.toFixed(0)}/${BUY_SCORE_WEIGHTS.rating} pts`);
  } else {
    reasons.push(`No rating available → 0/${BUY_SCORE_WEIGHTS.rating} pts`);
  }

  const volumeRatio = Math.min(product.reviewCount / BUY_SCORE_WEIGHTS.reviewVolumeCeiling, 1);
  const volumeScore = volumeRatio * BUY_SCORE_WEIGHTS.reviewVolume;
  score += volumeScore;
  reasons.push(`${product.reviewCount} reviews → ${volumeScore.toFixed(0)}/${BUY_SCORE_WEIGHTS.reviewVolume} pts`);

  if (priceHistoryLow != null && priceHistoryLow > 0) {
    const ratio = product.price / priceHistoryLow; // 1.0 = at the lowest seen price
    const priceScore = Math.max(0, 1 - (ratio - 1)) * BUY_SCORE_WEIGHTS.priceVsHistory;
    const clamped = Math.min(priceScore, BUY_SCORE_WEIGHTS.priceVsHistory);
    score += clamped;
    reasons.push(
      ratio <= 1
        ? `At/near lowest tracked price → ${clamped.toFixed(0)}/${BUY_SCORE_WEIGHTS.priceVsHistory} pts`
        : `${Math.round((ratio - 1) * 100)}% above lowest tracked price → ${clamped.toFixed(0)}/${BUY_SCORE_WEIGHTS.priceVsHistory} pts`
    );
  } else {
    const neutral = BUY_SCORE_WEIGHTS.priceVsHistory * 0.5;
    score += neutral;
    reasons.push(`No price history yet → ${neutral.toFixed(0)}/${BUY_SCORE_WEIGHTS.priceVsHistory} pts (neutral)`);
  }

  return { score: Math.round(score), reasons };
}

function formatRupees(value) {
  return `₹${Math.round(value).toLocaleString('en-IN')}`;
}

async function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

async function buildPanel(product) {
  const host = document.createElement('div');
  host.id = 'pricescout-host';
  const shadow = host.attachShadow({ mode: 'open' });

  const cssUrl = chrome.runtime.getURL('content/overlay.css');
  const linkEl = document.createElement('link');
  linkEl.rel = 'stylesheet';
  linkEl.href = cssUrl;
  shadow.appendChild(linkEl);

  const { history } = await sendMessage({ type: 'PRICESCOUT_GET_PRICE_HISTORY', asin: product.asin });
  const lowestSeen = history && history.length ? Math.min(...history.map((h) => h.price)) : null;
  const { score, reasons } = computeBuyScore(product, lowestSeen);

  const { item: existingWatch } = await sendMessage({ type: 'PRICESCOUT_GET_WATCH_ITEM', asin: product.asin });

  const suggestedTarget = Math.round(product.price * 0.9);

  const panel = document.createElement('div');
  panel.className = 'pricescout-panel pricescout-collapsed';
  panel.innerHTML = `
    <button class="pricescout-launcher" aria-label="Open PriceScout">🔎</button>
    <div class="pricescout-card" hidden>
      <div class="pricescout-header">
        <span class="pricescout-brand">PriceScout</span>
        <button class="pricescout-close" aria-label="Close">✕</button>
      </div>
      <div class="pricescout-score-row">
        <div class="pricescout-score-badge">${score}</div>
        <div class="pricescout-score-label">Buy Score</div>
      </div>
      <button class="pricescout-reasons-toggle">Why this score? ▾</button>
      <ul class="pricescout-reasons" hidden>
        ${reasons.map((r) => `<li>${r}</li>`).join('')}
      </ul>
      <div class="pricescout-price-row">
        <span>Current price</span>
        <strong>${formatRupees(product.price)}</strong>
      </div>
      ${
        lowestSeen != null
          ? `<div class="pricescout-price-row pricescout-muted"><span>Lowest tracked</span><span>${formatRupees(lowestSeen)}</span></div>`
          : ''
      }
      <div class="pricescout-watch-section">
        ${
          existingWatch
            ? `<div class="pricescout-watching-badge">Watching · alerts at ${formatRupees(existingWatch.targetPrice)}</div>
               <button class="pricescout-stop-watch">Stop watching</button>`
            : `<label class="pricescout-target-label">Alert me at</label>
               <div class="pricescout-target-row">
                 <span>₹</span>
                 <input type="number" class="pricescout-target-input" value="${suggestedTarget}" min="1" />
                 <button class="pricescout-watch-btn">Watch</button>
               </div>`
        }
      </div>
      <div class="pricescout-footer">Checks run in the background · no account needed</div>
    </div>
  `;
  shadow.appendChild(panel);

  const launcher = panel.querySelector('.pricescout-launcher');
  const card = panel.querySelector('.pricescout-card');
  launcher.addEventListener('click', () => {
    const isHidden = card.hasAttribute('hidden');
    if (isHidden) card.removeAttribute('hidden');
    else card.setAttribute('hidden', '');
  });
  panel.querySelector('.pricescout-close').addEventListener('click', () => card.setAttribute('hidden', ''));

  const reasonsToggle = panel.querySelector('.pricescout-reasons-toggle');
  const reasonsList = panel.querySelector('.pricescout-reasons');
  reasonsToggle.addEventListener('click', () => {
    const hidden = reasonsList.hasAttribute('hidden');
    if (hidden) {
      reasonsList.removeAttribute('hidden');
      reasonsToggle.textContent = 'Why this score? ▴';
    } else {
      reasonsList.setAttribute('hidden', '');
      reasonsToggle.textContent = 'Why this score? ▾';
    }
  });

  const watchBtn = panel.querySelector('.pricescout-watch-btn');
  if (watchBtn) {
    watchBtn.addEventListener('click', async () => {
      const input = panel.querySelector('.pricescout-target-input');
      const targetPrice = parseFloat(input.value);
      if (!Number.isFinite(targetPrice) || targetPrice <= 0) return;

      watchBtn.disabled = true;
      watchBtn.textContent = 'Saving…';
      await sendMessage({
        type: 'PRICESCOUT_ADD_TO_WATCHLIST',
        item: {
          asin: product.asin,
          title: product.title,
          thumbnailUrl: product.thumbnailUrl,
          url: product.url,
          targetPrice,
          lastCheckedPrice: product.price,
        },
      });
      renderPanelReplacement(product, targetPrice);
    });
  }

  const stopBtn = panel.querySelector('.pricescout-stop-watch');
  if (stopBtn) {
    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      stopBtn.textContent = 'Removing…';
      await sendMessage({ type: 'PRICESCOUT_REMOVE_FROM_WATCHLIST', asin: product.asin });
      host.remove();
      mountPanel();
    });
  }

  document.body.appendChild(host);

  function renderPanelReplacement() {
    host.remove();
    mountPanel();
  }
}

let mounted = false;
async function mountPanel() {
  const existing = document.getElementById('pricescout-host');
  if (existing) existing.remove();
  const product = extractProduct();
  if (!product) return;
  await buildPanel(product);
  await sendMessage({
    type: 'PRICESCOUT_RECORD_PRICE_SNAPSHOT',
    asin: product.asin,
    price: product.price,
  });
}

function init() {
  mountPanel();
  // Amazon PDPs sometimes rehydrate price/rating async — re-check once, debounced.
  let timeout = null;
  const observer = new MutationObserver(() => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      if (!document.getElementById('pricescout-host')) mountPanel();
    }, 800);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
