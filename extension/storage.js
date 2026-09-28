/* Blob messages cross into the extension-owned storage frame without JSON copies. */
(() => {
  if (window.__BILI_PAGE_CACHE_STORE__) return;
  const pending = new Map();
  let frame, ready, disposed = false;
  const origin = window.__BILI_PAGE_CACHE_STORAGE_URL__?.replace(/\/storage-frame\.html$/, '');
  function receive(event) {
    if (event.source !== frame?.contentWindow || event.origin !== origin) return;
    const message = event.data;
    if (message?.source === 'bili-cache-storage-purged') {
      window.postMessage({ source: 'bili-page-cache:command', command: 'pinned-cleared' }, location.origin);
      return;
    }
    if (message?.source !== 'bili-cache-storage-result') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); entry.finish();
    if (message.error) entry.reject(Object.assign(new Error(message.error.message), { name: message.error.name }));
    else entry.resolve(message.result);
  }
  async function connect() {
    if (ready) return ready;
    if (!origin) throw new Error('Storage is not connected. Open the extension and enable it again.');
    ready = new Promise((resolve, reject) => {
      frame = document.createElement('iframe'); frame.hidden = true;
      frame.dataset.biliCacheStorage = 'true';
      const done = event => {
        if (event.source === frame.contentWindow && event.origin === origin && event.data?.source === 'bili-cache-storage-ready') {
          clearTimeout(timeout); window.removeEventListener('message', done); resolve();
        }
      };
      const timeout = setTimeout(() => { window.removeEventListener('message', done); frame.remove(); ready = null; reject(new Error('Could not connect to saved video storage.')); }, 10000);
      window.addEventListener('message', done);
      frame.src = window.__BILI_PAGE_CACHE_STORAGE_URL__; document.documentElement.append(frame);
    });
    return ready;
  }
  async function call(method, value, signal) {
    signal?.throwIfAborted(); await connect(); signal?.throwIfAborted();
    if (disposed) throw new DOMException('Cache closed', 'AbortError');
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        frame?.contentWindow?.postMessage({ source: 'bili-cache-storage', id, method: 'cancel' }, origin);
        pending.delete(id); finish(); reject(signal.reason);
      };
      const finish = () => signal?.removeEventListener('abort', abort);
      signal?.addEventListener('abort', abort, { once: true });
      pending.set(id, { resolve, reject, finish });
      frame.contentWindow.postMessage({ source: 'bili-cache-storage', id, method, value }, origin);
    });
  }
  function closeStorage() {
    if (disposed) return;
    disposed = true;
    for (const entry of pending.values()) { entry.finish(); entry.reject(new DOMException('Cache closed', 'AbortError')); }
    pending.clear(); frame?.remove(); window.removeEventListener('message', receive);
    window.removeEventListener('pagehide', closeStorage);
  }
  window.addEventListener('message', receive); window.addEventListener('pagehide', closeStorage);
  // Unit fixtures explicitly provide DB; production only uses extension storage.
  const db = window.__BILI_PAGE_CACHE_DB__;
  window.__BILI_PAGE_CACHE_STORE__ = Object.freeze(db ? { ...db, close: closeStorage } : {
    ttl: 7 * 86400000,
    save: (value, signal) => call('save', value, signal),
    read: (value, signal) => call('read', value, signal),
    remove: (value, signal) => call('remove', value, signal),
    cleanup: signal => call('cleanup', null, signal),
    stats: signal => call('stats', null, signal),
    close: closeStorage
  });
  // Let an already-completed pre-0.5 cache be pinned without clearing/reloading
  // the movie. The old controller keeps ownership of its playback cache.
  if (window.__BILI_PAGE_CACHE_RUNNING__ && !window.__BILI_PAGE_CACHE_CORE__?.createPartialCache) {
    const store = window.__BILI_PAGE_CACHE_STORE__;
    let current = {}, pinState = { saving: false, pinnedUntil: 0, saveMessage: '' }, savedKeys = [], operation;
    let disposed = false;
    const emit = () => window.postMessage({ source: 'bili-page-cache:pin-state', state: pinState }, location.origin);
    async function command(kind) {
      if (pinState.saving || disposed) return;
      if (kind === 'pin' && !['ready', 'mismatch'].includes(current.phase)) return;
      if (kind === 'unpin' && !savedKeys.length) return;
      operation = new AbortController();
      const signal = operation.signal;
      pinState = { ...pinState, saving: true, saveMessage: kind === 'pin' ? 'Saving. Keep this tab open.' : 'Deleting saved copy...' }; emit();
      try {
        if (kind === 'pin') {
          const kernel = window.player?.__core?.();
          const urls = ['video', 'audio'].map(type => kernel?.getCurrentPlayURLFor?.(type)).filter(url => window.__BILI_PAGE_CACHE_CORE__?.key(url));
          if (urls.length !== current.files) throw new Error('Switch back to the cached quality before saving.');
          const keys = [], blobs = [];
          for (const url of urls) {
            signal.throwIfAborted();
            const response = await fetch(url, { signal });
            if (response.type !== 'default' || response.status !== 200) {
              await response.body?.cancel();
              throw new Error('This track is not fully cached. Switch back to the cached quality.');
            }
            keys.push(window.__BILI_PAGE_CACHE_CORE__.key(url));
            blobs.push(await response.blob());
          }
          const saved = await store.save({ keys, blobs, label: current.label }, signal);
          savedKeys = keys; pinState.pinnedUntil = saved.expiresAt;
          pinState.saveMessage = 'Saved for 7 days.';
        } else {
          await store.remove(savedKeys, signal);
          savedKeys = []; pinState.pinnedUntil = 0;
          pinState.saveMessage = 'Saved copy deleted. This tab still has its cache.';
        }
      } catch (error) {
        pinState.saveMessage = error.name === 'QuotaExceededError' ? 'Not enough storage. The video was not saved.' : error.name === 'AbortError' ? 'Save canceled.' : `Could not save: ${error.message}`;
      } finally { pinState.saving = false; operation = null; if (!disposed) emit(); }
    }
    function dispose() {
      disposed = true; operation?.abort();
      store.close?.();
      window.removeEventListener('message', listener); window.removeEventListener('pagehide', dispose);
      delete window.__BILI_PAGE_CACHE_STORE__;
    }
    function listener(event) {
      if (event.source !== window || event.origin !== location.origin) return;
      if (event.data?.source === 'bili-page-cache:state' && !event.data.panelOnly) {
        current = event.data.state;
        if (current.phase === 'off') dispose();
      }
      if (event.data?.source === 'bili-page-cache:command') {
        const kind = event.data.command;
        if (kind === 'pin' || kind === 'unpin') command(kind);
        else if (kind === 'status') emit();
        else if (kind === 'clear') operation?.abort();
        else if (kind === 'pinned-cleared') { operation?.abort(); savedKeys = []; pinState.pinnedUntil = 0; pinState.saveMessage = 'All saved copies deleted.'; emit(); }
        else if (kind === 'disable') dispose();
      }
    }
    window.addEventListener('message', listener); window.addEventListener('pagehide', dispose);
    window.postMessage({ source: 'bili-page-cache:command', command: 'status' }, location.origin);
  }
})();
