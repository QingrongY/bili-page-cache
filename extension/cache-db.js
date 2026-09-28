/* Shared by the extension storage frame, popup and cleanup worker. */
(() => {
  const name = 'bili-page-cache-pinned-v1', ttl = 7 * 86400000;
  const idFor = keys => [...keys].sort().join('\n');
  async function open(create) {
    if (!create && !(await indexedDB.databases()).some(db => db.name === name)) return null;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('videos')) db.createObjectStore('videos', { keyPath: 'id' }).createIndex('expiresAt', 'expiresAt');
        if (!db.objectStoreNames.contains('catalog')) db.createObjectStore('catalog', { keyPath: 'id' });
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { const db = req.result; db.onversionchange = () => db.close(); resolve(db); };
    });
  }
  async function transaction(create, signal, action) {
    signal?.throwIfAborted();
    const db = await open(create);
    if (!db) return null;
    try {
      signal?.throwIfAborted();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(['videos', 'catalog'], 'readwrite');
        let result = null;
        const abort = () => { try { tx.abort(); } catch {} };
        signal?.addEventListener('abort', abort, { once: true });
        const finish = () => signal?.removeEventListener('abort', abort);
        tx.oncomplete = () => { finish(); resolve(result); };
        tx.onabort = () => { finish(); reject(signal?.aborted ? signal.reason : tx.error || new Error('Storage operation canceled')); };
        tx.onerror = () => {};
        try { action(tx.objectStore('videos'), tx.objectStore('catalog'), value => { result = value; }); }
        catch (error) { abort(); finish(); reject(error); }
      });
    } finally { db.close(); }
  }
  function purge(videos, catalog) {
    const request = videos.index('expiresAt').openKeyCursor(IDBKeyRange.upperBound(Date.now()));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) { videos.delete(cursor.primaryKey); catalog.delete(cursor.primaryKey); cursor.continue(); }
    };
  }
  globalThis.__BILI_PAGE_CACHE_DB__ = Object.freeze({
    ttl,
    async save({ keys, blobs, label, quality }, signal) {
      if (!keys?.length || keys.length !== blobs?.length || blobs.some(blob => !(blob instanceof Blob) || !blob.size)) throw new Error('Wait for the download to finish before saving');
      const record = { id: idFor(keys), keys, blobs, label, quality, expiresAt: Date.now() + ttl };
      await transaction(true, signal, (videos, catalog) => {
        purge(videos, catalog);
        videos.put(record);
        catalog.put({ id: record.id, bytes: blobs.reduce((n, b) => n + b.size, 0), label, expiresAt: record.expiresAt });
      });
      return { expiresAt: record.expiresAt };
    },
    async read(keys, signal) {
      return transaction(false, signal, (videos, catalog, set) => {
        purge(videos, catalog);
        const request = videos.get(idFor(keys));
        request.onsuccess = () => { if (request.result?.expiresAt > Date.now()) set(request.result); };
      });
    },
    async remove(keys, signal) {
      await transaction(false, signal, (videos, catalog) => { purge(videos, catalog); videos.delete(idFor(keys)); catalog.delete(idFor(keys)); });
    },
    async clearAll(signal) {
      await transaction(false, signal, (videos, catalog) => { videos.clear(); catalog.clear(); });
    },
    async cleanup(signal) { await transaction(false, signal, purge); },
    async stats(signal) {
      return await transaction(false, signal, (videos, catalog, set) => {
        const request = catalog.getAll();
        request.onsuccess = () => set({ count: request.result.length, bytes: request.result.reduce((n, r) => n + r.bytes, 0), nextExpiry: request.result.length ? Math.min(...request.result.map(r => r.expiresAt)) : 0 });
      }) || { count: 0, bytes: 0, nextExpiry: 0 };
    }
  });
})();
