function formatRupees(value) {
  return `₹${Math.round(value).toLocaleString('en-IN')}`;
}

function timeAgo(ts) {
  if (!ts) return 'not yet checked';
  const diffMin = Math.round((Date.now() - ts) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  return `${diffHr}h ago`;
}

async function loadWatchlist() {
  const { items } = await chrome.runtime.sendMessage({ type: 'PRICESCOUT_GET_WATCHLIST' });
  const listEl = document.getElementById('watchlist-list');
  const emptyEl = document.getElementById('empty-state');
  const countEl = document.getElementById('watch-count');

  countEl.textContent = String(items.length);
  listEl.innerHTML = '';

  if (items.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  items
    .sort((a, b) => b.addedAt - a.addedAt)
    .forEach((item) => {
      const row = document.createElement('div');
      row.className = 'watch-item';
      const statusText =
        item.status === 'triggered'
          ? `<span class="watch-status-triggered">Target hit!</span>`
          : `target <strong>${formatRupees(item.targetPrice)}</strong>`;

      row.innerHTML = `
        <img class="watch-thumb" src="${item.thumbnailUrl || ''}" alt="" />
        <div class="watch-info">
          <div class="watch-title">${escapeHtml(item.title)}</div>
          <div class="watch-meta">
            now ${formatRupees(item.lastCheckedPrice)} · ${statusText}
          </div>
          <div class="watch-meta">checked ${timeAgo(item.lastCheckedAt)}</div>
        </div>
        <button class="watch-remove" data-asin="${item.asin}" aria-label="Remove">✕</button>
      `;
      listEl.appendChild(row);
    });

  listEl.querySelectorAll('.watch-remove').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'PRICESCOUT_REMOVE_FROM_WATCHLIST', asin: btn.dataset.asin });
      loadWatchlist();
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function loadSettings() {
  const { settings } = await chrome.runtime.sendMessage({ type: 'PRICESCOUT_GET_SETTINGS' });
  const select = document.getElementById('interval-select');
  select.value = String(settings.checkIntervalMinutes);
  select.addEventListener('change', async () => {
    await chrome.runtime.sendMessage({
      type: 'PRICESCOUT_UPDATE_SETTINGS',
      settings: { checkIntervalMinutes: parseInt(select.value, 10) },
    });
  });
}

loadWatchlist();
loadSettings();
