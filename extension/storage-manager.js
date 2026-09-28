(() => {
  const db = globalThis.__BILI_PAGE_CACHE_DB__;
  const status = document.querySelector('#storage-status'), clear = document.querySelector('#clear-all'), list = document.querySelector('#saved-list'), limit = document.querySelector('#storage-limit');
  const bytes = n => (n / 1024 ** 3).toFixed(2) + ' GB';
  let refreshing = 0;
  async function refresh() {
    const run = ++refreshing;
    const records = await db.list(), stats = await db.stats();
    if (run !== refreshing) return;
    clear.disabled = !stats.count;
    status.textContent = stats.count ? stats.count + (stats.count === 1 ? ' video' : ' videos') + ' · ' + bytes(stats.bytes) + ' / ' + stats.limitBytes / 1024 ** 3 + ' GB' : 'No saved videos.';
    if (document.activeElement !== limit) limit.value = stats.limitBytes / 1024 ** 3;
    list.replaceChildren();
    for (const record of records.sort((a, b) => b.expiresAt - a.expiresAt)) {
      const item = document.createElement('li'), title = document.createElement(record.url ? 'a' : 'span'), details = document.createElement('small'), remove = document.createElement('button');
      title.textContent = record.title || 'Saved video';
      if (record.url) { title.href = record.url; title.target = '_blank'; title.rel = 'noopener'; }
      details.textContent = (record.label || 'Current quality') + ' · ' + bytes(record.bytes) + ' · Expires ' + new Date(record.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      remove.textContent = 'Delete'; remove.className = 'delete'; remove.setAttribute('aria-label', 'Delete ' + (record.title || 'saved video'));
      remove.onclick = () => action(() => db.removeId(record.id));
      item.append(title, details, remove); list.append(item);
    }
  }
  async function action(work) {
    try {
      await work();
      await chrome.runtime.sendMessage({ type: 'cache-storage-changed' }).catch(() => {});
      await refresh();
    } catch (error) { status.textContent = error.message; clear.disabled = false; }
  }
  clear.onclick = () => action(async () => {
    await db.clearAll();
    await chrome.runtime.sendMessage({ type: 'cache-purge-all' }).catch(() => {});
  });
  document.querySelector('#limit-form').onsubmit = event => { event.preventDefault(); action(() => db.setLimit(Number(limit.value) * 1024 ** 3)); };
  const channel = new BroadcastChannel('bili-cache-changes');
  channel.onmessage = () => refresh().catch(error => { status.textContent = error.message; });
  window.addEventListener('pagehide', () => channel.close(), { once: true });
  refresh().catch(error => { status.textContent = error.message; });
})();
