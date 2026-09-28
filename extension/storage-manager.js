(() => {
  const db = globalThis.__BILI_PAGE_CACHE_DB__;
  const status = document.querySelector('#storage-status'), clear = document.querySelector('#clear-all');
  async function refresh() {
    await db.cleanup();
    const stats = await db.stats();
    clear.disabled = !stats.count;
    status.textContent = stats.count ? `${stats.count} ${stats.count === 1 ? 'video' : 'videos'} · ${(stats.bytes / 1024 ** 3).toFixed(2)} GB` : 'No saved videos.';
  }
  clear.onclick = async () => {
    clear.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: 'cache-purge-all' }).catch(() => {});
      await db.clearAll();
      await refresh();
      const stats = await db.stats();
      if (stats.count) throw new Error('Another tab is saving a video. Wait for it to finish, then retry.');
      status.textContent = '0 saved videos · 0 bytes';
    } catch (error) { status.textContent = `Could not delete saved videos. ${error.message}`; clear.disabled = false; }
  };
  refresh().catch(error => { status.textContent = `Could not check storage. ${error.message}`; });
})();
