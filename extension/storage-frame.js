(() => {
  const origin = 'https://www.bilibili.com', operations = new Map();
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'cache-purge-all') return;
    for (const controller of operations.values()) controller.abort();
    parent.postMessage({ source: 'bili-cache-storage-purged' }, origin);
    reply({ ok: true });
  });
  window.addEventListener('message', async event => {
    if (event.source !== parent || event.origin !== origin || event.data?.source !== 'bili-cache-storage') return;
    const { id, method, value } = event.data;
    if (method === 'cancel') { operations.get(id)?.abort(); return; }
    if (!['save', 'read', 'remove', 'cleanup', 'stats'].includes(method) || typeof id !== 'string') return;
    const controller = new AbortController(); operations.set(id, controller);
    try {
      const db = globalThis.__BILI_PAGE_CACHE_DB__;
      if (method === 'save' && !(await chrome.runtime.sendMessage({ type: 'cache-before-save' }))?.ok) throw new Error('Could not schedule cleanup. The video was not saved.');
      const result = ['cleanup', 'stats'].includes(method) ? await db[method](controller.signal) : await db[method](value, controller.signal);
      // Reconcile cleanup after each mutation; the alarm is armed before saving.
      if (['save', 'remove', 'cleanup'].includes(method)) {
        await chrome.runtime.sendMessage({ type: 'cache-storage-changed' }).catch(() => {});
      }
      parent.postMessage({ source: 'bili-cache-storage-result', id, result }, origin);
    } catch (error) {
      parent.postMessage({ source: 'bili-cache-storage-result', id, error: { name: error.name, message: error.message } }, origin);
    } finally { operations.delete(id); }
  });
  window.addEventListener('pagehide', () => { for (const controller of operations.values()) controller.abort(); });
  parent.postMessage({ source: 'bili-cache-storage-ready' }, origin);
})();
