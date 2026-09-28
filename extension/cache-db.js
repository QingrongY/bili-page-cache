/* Extension-owned media storage. All mutations share one IndexedDB transaction. */
(() => {
  const name = 'bili-page-cache-pinned-v1', ttl = 7 * 86400000, defaultLimit = 32 * 1024 ** 3;
  const idFor = keys => [...keys].sort().join('\n');
  const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  const defaults = () => ({ id: 'settings', epoch: 0, limitBytes: defaultLimit });
  async function open(create) {
    if (!create && !(await indexedDB.databases()).some(db => db.name === name)) return null;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 3); let blocked = false;
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('videos')) db.createObjectStore('videos', { keyPath: 'id' }).createIndex('expiresAt', 'expiresAt');
        if (!db.objectStoreNames.contains('catalog')) db.createObjectStore('catalog', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'id' });
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => { blocked = true; reject(new Error('Close other Bili Cache windows and try again.')); };
      req.onsuccess = () => { const db = req.result; if (blocked) { db.close(); return; } db.onversionchange = () => db.close(); resolve(db); };
    });
  }
  async function transaction(create, signal, action) {
    signal?.throwIfAborted();
    const db = await open(create);
    if (!db) return null;
    try {
      signal?.throwIfAborted();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(['videos', 'catalog', 'settings'], 'readwrite');
        let result = null, failure;
        const abort = () => { try { tx.abort(); } catch {} };
        signal?.addEventListener('abort', abort, { once: true });
        const finish = () => signal?.removeEventListener('abort', abort);
        tx.oncomplete = () => { finish(); resolve(result); };
        tx.onabort = () => { finish(); reject(signal?.aborted ? signal.reason : failure || tx.error || new Error('Storage operation canceled')); };
        tx.onerror = () => {};
        Promise.resolve().then(() => action(tx.objectStore('videos'), tx.objectStore('catalog'), tx.objectStore('settings')))
          .then(value => { result = value; }, error => { failure = error; abort(); });
      });
    } finally { db.close(); }
  }
  function purge(videos, catalog) {
    return new Promise((resolve, reject) => {
      const req = videos.index('expiresAt').openKeyCursor(IDBKeyRange.upperBound(Date.now()));
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { const cursor = req.result; if (!cursor) return resolve(); videos.delete(cursor.primaryKey); catalog.delete(cursor.primaryKey); cursor.continue(); };
    });
  }
  const settings = store => request(store.get('settings')).then(value => value || defaults());
  const changed = (message = { changed: true }) => { try { const channel = new BroadcastChannel('bili-cache-changes'); channel.postMessage(message); channel.close(); } catch {} };
  function validate(keys, blobs) {
    if (!Array.isArray(keys) || !keys.length || keys.length > 4 || new Set(keys).size !== keys.length || keys.some(key => typeof key !== 'string' || !key || key.length > 2048)) throw new Error('Invalid media keys');
    if (!Array.isArray(blobs) || keys.length !== blobs.length || blobs.some(blob => !(blob instanceof Blob) || !blob.size || blob.size > 12 * 1024 ** 3)) throw new Error('Wait for the download to finish before saving');
  }
  globalThis.__BILI_PAGE_CACHE_DB__ = Object.freeze({
    ttl, defaultLimit,
    async revision(signal) { return (await transaction(false, signal, (v, c, s) => settings(s)) || defaults()).epoch; },
    async save({ keys, blobs, title, url, label, quality, epoch }, signal) {
      validate(keys, blobs);
      if (epoch === undefined) epoch = await this.revision(signal);
      const id = idFor(keys), bytes = blobs.reduce((n, b) => n + b.size, 0);
      const result = await transaction(true, signal, async (videos, catalog, config) => {
        await purge(videos, catalog);
        const prefs = await settings(config);
        if (epoch !== prefs.epoch) throw new DOMException('Saved videos changed. Click Save again.', 'AbortError');
        const records = await request(catalog.getAll());
        const used = records.filter(record => record.id !== id).reduce((n, record) => n + record.bytes, 0);
        if (used + bytes > prefs.limitBytes) throw new DOMException('Saved storage limit reached. Delete a video or increase the limit.', 'QuotaExceededError');
        const expiresAt = Date.now() + ttl;
        const safeUrl = (() => { try { const u = new URL(url); return u.origin === 'https://www.bilibili.com' && /^\/(video|bangumi\/play)\//.test(u.pathname) ? u.origin + u.pathname + (u.searchParams.has('p') ? '?p=' + encodeURIComponent(u.searchParams.get('p')) : '') : ''; } catch { return ''; } })();
        const meta = { id, bytes, title: String(title || 'Saved video').slice(0, 240), url: safeUrl, label: String(label || 'Current quality').slice(0, 60), quality, expiresAt };
        await request(videos.put({ ...meta, keys, blobs }));
        await request(catalog.put(meta));
        return { expiresAt };
      });
      changed(); return result;
    },
    async read(keys, signal) {
      return transaction(false, signal, async (videos, catalog) => {
        await purge(videos, catalog);
        const record = await request(videos.get(idFor(keys)));
        return record?.expiresAt > Date.now() ? record : null;
      });
    },
    async remove(keys, signal) { return this.removeId(idFor(keys), signal); },
    async removeId(id, signal) {
      await transaction(true, signal, async (videos, catalog, config) => {
        const prefs = await settings(config); prefs.epoch++;
        await request(config.put(prefs));
        await request(videos.delete(id)); await request(catalog.delete(id));
      }); changed({ removed: id });
    },
    async clearAll(signal) {
      await transaction(true, signal, async (videos, catalog, config) => {
        const prefs = await settings(config); prefs.epoch++;
        await request(config.put(prefs));
        await request(videos.clear()); await request(catalog.clear());
      }); changed({ clear: true });
    },
    async setLimit(limitBytes, signal) {
      if (!Number.isSafeInteger(limitBytes) || limitBytes < 1024 ** 3 || limitBytes > 512 * 1024 ** 3) throw new Error('Choose a limit between 1 and 512 GB.');
      await transaction(true, signal, async (videos, catalog, config) => {
        await purge(videos, catalog);
        const records = await request(catalog.getAll());
        if (records.reduce((n, r) => n + r.bytes, 0) > limitBytes) throw new Error('Delete saved videos before lowering this limit.');
        const prefs = await settings(config); prefs.limitBytes = limitBytes; prefs.epoch++;
        await request(config.put(prefs));
      }); changed();
    },
    async cleanup(signal) { await transaction(false, signal, purge); },
    async list(signal) { return await transaction(false, signal, async (v, c) => { await purge(v, c); return request(c.getAll()); }) || []; },
    async stats(signal) {
      return await transaction(false, signal, async (v, c, s) => {
        const records = await request(c.getAll()), prefs = await settings(s);
        return { count: records.length, bytes: records.reduce((n, r) => n + r.bytes, 0), nextExpiry: records.length ? Math.min(...records.map(r => r.expiresAt)) : 0, limitBytes: prefs.limitBytes };
      }) || { count: 0, bytes: 0, nextExpiry: 0, limitBytes: defaultLimit };
    }
  });
})();
