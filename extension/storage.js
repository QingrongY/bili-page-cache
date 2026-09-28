/* MAIN world client; storage authority stays in the isolated bridge. */
(() => {
  if (window.__BILI_PAGE_CACHE_STORE__) return;
  const pending = new Map();
  function receive(event) {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'bili-cache-store-result') return;
    const { id, result, error } = event.data, entry = pending.get(id);
    if (!entry) return;
    pending.delete(id); entry.finish();
    error ? entry.reject(Object.assign(new Error(error.message), { name: error.name })) : entry.resolve(result);
  }
  function call(method, value, signal) {
    signal?.throwIfAborted();
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        window.postMessage({ source: 'bili-cache-store', id, method: 'cancel' }, location.origin);
        pending.delete(id); finish(); reject(signal.reason);
      };
      const finish = () => signal?.removeEventListener('abort', abort);
      signal?.addEventListener('abort', abort, { once: true });
      pending.set(id, { resolve, reject, finish });
      window.postMessage({ source: 'bili-cache-store', id, method, value }, location.origin);
    });
  }
  window.addEventListener('message', receive);
  window.__BILI_PAGE_CACHE_STORE__ = Object.freeze({
    ttl: 7 * 86400000,
    save: (value, signal) => call('save', value, signal),
    read: (value, signal) => call('read', value, signal),
    remove: (value, signal) => call('remove', value, signal),
    cleanup: signal => call('cleanup', null, signal),
    close() {
      window.removeEventListener('message', receive);
      for (const entry of pending.values()) { entry.finish(); entry.reject(new DOMException('Cache closed', 'AbortError')); }
      pending.clear();
    }
  });
})();
