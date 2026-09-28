/* No persistent storage: all cached Blobs belong to this document. */
(() => {
  'use strict';
  if (window.__BILI_PAGE_CACHE_CORE__) return;
  const allowedHost = h => /(^|\.)(bilivideo\.com|bilivideo\.cn|bilivideo\.net|akamaized\.net)$/.test(h);
  function key(url) {
    try {
      const u = new URL(url, location.href);
      if (u.protocol !== 'https:' || !allowedHost(u.hostname)) return null;
      // Keep the complete media path, including CID, quality, codec and segment ID.
      return /\.(m4s|mp4)$/i.test(u.pathname) ? u.pathname : null;
    } catch { return null; }
  }
  function range(header, size) {
    if (!header) return { start: 0, end: size - 1, partial: false };
    const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
    if (!m || (!m[1] && !m[2])) return null;
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
    return { start, end, partial: true };
  }
  function createPartialCache(size, type = 'video/mp4') {
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Invalid cache size');
    const blocks = [];
    let cachedBytes = 0;
    return Object.freeze({
      size, type,
      get cachedBytes() { return cachedBytes; },
      add(offset, blob) {
        const end = offset + blob.size;
        if (!Number.isSafeInteger(offset) || offset < 0 || !blob.size || end > size) throw new Error('Invalid cache range');
        let lo = 0, hi = blocks.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (blocks[mid].offset < offset) lo = mid + 1; else hi = mid; }
        if ((lo && blocks[lo - 1].end > offset) || (lo < blocks.length && blocks[lo].offset < end)) throw new Error('Cache ranges overlap');
        blocks.splice(lo, 0, { offset, end, blob });
        cachedBytes += blob.size;
      },
      slice(start, end, mime = type) {
        // A request is local only when every requested byte is committed.
        // Never fill holes with zeroes or return a shorter successful response.
        const parts = [];
        let position = start;
        for (const block of blocks) {
          if (block.end <= position) continue;
          if (block.offset > position) return null;
          const stop = Math.min(end, block.end);
          parts.push(block.blob.slice(position - block.offset, stop - block.offset));
          position = stop;
          if (position === end) return new Blob(parts, { type: mime });
        }
        return null;
      },
      clear() { blocks.length = 0; cachedBytes = 0; }
    });
  }
  function responseFor(blob, header) {
    const r = range(header, blob.size);
    if (!r) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
    const payload = blob.slice(r.start, r.end + 1, blob.type);
    if (payload === null) return null;
    const headers = {
      'Content-Type': blob.type || 'video/mp4',
      'Content-Length': String(r.end - r.start + 1),
      'Accept-Ranges': 'bytes'
    };
    if (r.partial) headers['Content-Range'] = `bytes ${r.start}-${r.end}/${blob.size}`;
    return new Response(payload, {
      status: r.partial ? 206 : 200, statusText: r.partial ? 'Partial Content' : 'OK', headers
    });
  }
  const originalFetch = window.fetch;
  const nativeFetch = originalFetch.bind(window);
  function sourceUrls(track) {
    const mediaKey = key(track.url);
    return mediaKey ? [...new Set([track.url, ...(track.backups || [])])].filter(url => key(url) === mediaKey) : [];
  }
  async function rankSources(urls, signal) {
    // Compare only server-provided mirrors of the same media file. Bound both
    // traffic and time; probe data never becomes part of the video cache.
    const hosts = new Set();
    const candidates = urls.filter(url => {
      const host = new URL(url).hostname;
      if (hosts.has(host)) return false;
      hosts.add(host); return true;
    }).slice(0, 4);
    if (candidates.length < 2) return { urls, speed: 0 };
    const measurements = [];
    let next = 0;
    const probeSize = 256 * 1024;
    await Promise.allSettled(Array.from({ length: 2 }, async () => {
      while (next < candidates.length) {
        signal.throwIfAborted();
        const url = candidates[next++], started = performance.now();
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), 3000);
        let response, reader;
        try {
          response = await nativeFetch(url, {
            headers: { Range: `bytes=0-${probeSize - 1}` }, credentials: 'omit', cache: 'no-store',
            signal: AbortSignal.any([signal, timeout.signal])
          });
          const match = /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
          if (response.status !== 206 || !match || Number(match[1]) !== Math.min(probeSize, Number(match[2])) - 1) continue;
          const expected = Number(match[1]) + 1;
          let loaded = 0;
          reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            loaded += value.byteLength;
            if (loaded > expected) throw new Error('Unexpected response length during speed check');
          }
          if (loaded === expected) measurements.push({ url, speed: loaded * 1000 / Math.max(1, performance.now() - started) });
        } catch {} finally {
          clearTimeout(timer);
          timeout.abort();
          if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          else if (response?.body) await response.body.cancel().catch(() => {});
        }
      }
    }));
    signal.throwIfAborted();
    measurements.sort((a, b) => b.speed - a.speed);
    const ranked = measurements.map(m => m.url);
    return { urls: [...ranked, ...urls.filter(url => !ranked.includes(url))], speed: measurements[0]?.speed || 0 };
  }
  async function download(track, signal, progress, options = {}) {
    const chunkSize = 4 * 1024 * 1024;
    const maxSize = 12 * 1024 ** 3;
    const concurrency = [1, 4, 8].includes(options.concurrency) ? options.concurrency : 4;
    const session = options.session || {}, parts = session.parts ||= new Map(), pending = new Map();
    const failure = new AbortController();
    const activeSignal = AbortSignal.any([signal, failure.signal]);
    let completed = [...parts.values()].reduce((n, b) => n + b.size, 0), total = session.total || 0, mime = session.mime || 'video/mp4', partial = session.partial !== false;
    const trackKey = key(track.url);
    if (!trackKey) throw new Error('This media URL is not supported');
    if (session.key && session.key !== trackKey) throw new Error('The selected track changed. Clear the cache first.');
    session.key = trackKey;
    let urls = sourceUrls(track), measuredSpeed = 0, bestTransferRate = 0, lastSelection = 0, selecting = null;
    const autoSource = options.autoSource !== false;
    const notifySource = phase => options.onSource?.({ phase, host: new URL(urls[0]).hostname });
    async function selectSource() {
      notifySource('testing');
      const result = await rankSources(urls, activeSignal);
      activeSignal.throwIfAborted();
      urls = result.urls; measuredSpeed = result.speed; lastSelection = performance.now();
      notifySource(measuredSpeed ? 'selected' : 'fallback');
    }
    const report = () => progress(completed + [...pending.values()].reduce((a, b) => a + b, 0), total);
    async function fetchPart(offset, end) {
      let lastError;
      for (let attempt = 0; attempt < Math.max(3, urls.length); attempt++) {
        activeSignal.throwIfAborted();
        const stalled = new AbortController();
        let idleTimer, response, committed = false;
        const started = performance.now();
        const activity = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => stalled.abort(new DOMException('No data received from the video server for 60 seconds', 'TimeoutError')), 60000);
        };
        try {
          activity();
          response = await nativeFetch(urls[attempt % urls.length], {
            headers: { Range: `bytes=${offset}-${end}` },
            credentials: 'omit', cache: 'no-store',
            signal: AbortSignal.any([activeSignal, stalled.signal])
          });
          activity();
          if (response.status !== 206 && !(response.status === 200 && offset === 0)) {
            await response.body?.cancel();
            throw new Error(`Video server returned HTTP ${response.status}`);
          }
          if (offset === 0) {
            mime = response.headers.get('Content-Type') || mime;
            partial = response.status === 206;
          }
          const cr = response.headers.get('Content-Range');
          const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr || '');
          if (response.status === 206 && (!match || Number(match[1]) !== offset || Number(match[2]) !== Math.min(end, Number(match[3]) - 1))) {
            await response.body?.cancel();
            throw new Error('The server did not return a valid byte range');
          }
          const expected = match ? Number(match[2]) - Number(match[1]) + 1 : Number(response.headers.get('Content-Length'));
          const nextTotal = match ? Number(match[3]) : expected;
          if (!Number.isSafeInteger(nextTotal) || nextTotal < 0 || (match && !nextTotal)) throw new Error('Invalid media file size');
          if (total && nextTotal !== total) throw new Error('The media file size changed. Start the cache again.');
          if (nextTotal > maxSize) throw new Error('This track exceeds the 12 GB cache limit');
          total = nextTotal;
          let loaded = 0;
          // Response.blob() uses the browser's streaming Blob writer. Unlike
          // constructing many byte-backed Blobs, it waits for storage limits
          // to initialize and can spill large responses directly to disk.
          const monitored = response.body.pipeThrough(new TransformStream({
            transform(value, stream) {
              activity();
              loaded += value.byteLength;
              if (loaded > maxSize || (expected && loaded > expected)) throw new Error('The media response is larger than expected');
              pending.set(offset, loaded);
              report();
              stream.enqueue(value);
            }
          }));
          const data = await new Response(monitored, { headers: { 'Content-Type': mime } }).blob();
          if (expected && loaded !== expected) throw new Error('Incomplete media response. Retrying.');
          if (!loaded) throw new Error('The server returned an empty media response');
          if (!total && response.status === 200) total = loaded;
          activeSignal.throwIfAborted();
          await data.slice(-1).arrayBuffer();
          activeSignal.throwIfAborted();
          parts.set(offset, data);
          completed += data.size;
          pending.delete(offset);
          committed = true;
          options.onPart?.({ offset, total, blob: data });
          report();
          const elapsed = performance.now() - started;
          const rate = data.size * 1000 / Math.max(1, elapsed);
          const slow = elapsed > 15000 || (elapsed > 5000 && bestTransferRate && rate < bestTransferRate * 0.35);
          bestTransferRate = Math.max(bestTransferRate, rate);
          if (autoSource && urls.length > 1 && slow && total - completed > 4 * chunkSize && performance.now() - lastSelection > 60000 && !selecting) {
            // Keep completed parts. New workers use the revised source order;
            // already active requests can finish on their original source.
            selecting = selectSource();
            try { await selecting; } finally { selecting = null; }
          }
          return data.size;
        } catch (error) {
          if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
          activeSignal.throwIfAborted();
          if (committed) throw error;
          lastError = error;
          pending.delete(offset);
          report();
        } finally { clearTimeout(idleTimer); }
      }
      throw lastError;
    }
    try {
      if (autoSource && new Set(urls.map(url => new URL(url).hostname)).size > 1) await selectSource();
      else notifySource('single');
      // A small first range discovers size/range support before parallel work.
      // If the server responds with a full 200 body, keep that single download.
      const firstSize = parts.get(0)?.size || await fetchPart(0, 256 * 1024 - 1);
      report();
      let next = firstSize;
      if (partial && next < total) {
        const workers = Array.from({ length: Math.min(concurrency, Math.ceil((total - next) / chunkSize)) }, async () => {
          try {
            while (next < total) {
              activeSignal.throwIfAborted();
              const start = next;
              next += chunkSize;
              if (!parts.has(start)) await fetchPart(start, Math.min(start + chunkSize - 1, total - 1));
            }
          } catch (error) { failure.abort(error); throw error; }
        });
        await Promise.allSettled(workers);
        activeSignal.throwIfAborted();
      }
      activeSignal.throwIfAborted();
      if (completed !== total) throw new Error('The cache size does not match the media file');
      return new Blob([...parts].sort((a, b) => a[0] - b[0]).map(([, blob]) => blob), { type: mime });
    } finally {
      session.total = total; session.mime = mime; session.partial = partial;
      if (!options.session) parts.clear();
      pending.clear();
    }
  }
  function install({ entries, observe, hit, metadata }) {
    let enabled = true;
    const p = XMLHttpRequest.prototype;
    const original = { open: p.open, send: p.send, set: p.setRequestHeader, abort: p.abort };
    const requests = new WeakMap();
    const isPlayInfo = u => /(?:\/playurl|\/player\/web\/playurl)(?:\?|$)/.test(u);
    const wrappedFetch = window.fetch = async function(input, init) {
      if (!enabled) return nativeFetch(input, init);
      const u = input instanceof Request ? input.url : String(input);
      const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (method === 'GET') {
        observe(u);
        const blob = entries.get(key(u));
        if (blob) {
          (init?.signal || (input instanceof Request ? input.signal : null))?.throwIfAborted();
          const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
          const local = headers.has('If-Range') ? null : responseFor(blob, headers.get('Range'));
          if (local) {
            hit();
            Object.defineProperty(local, 'url', { value: u });
            return local;
          }
        }
      }
      const response = await nativeFetch(input, init);
      if (enabled && isPlayInfo(u)) response.clone().json().then(data => { if (enabled) metadata(data); }).catch(() => {});
      return response;
    };
    const wrappedOpen = p.open = function(method, url, ...args) {
      const old = requests.get(this);
      if (old?.blobUrl) URL.revokeObjectURL(old.blobUrl);
      if (old?.local) for (const prop of ['status', 'statusText', 'responseURL', 'getResponseHeader', 'getAllResponseHeaders']) delete this[prop];
      if (!enabled) return original.open.call(this, method, url, ...args);
      requests.set(this, { method: String(method).toUpperCase(), url: String(url), async: args[0] !== false, headers: new Headers() });
      return original.open.call(this, method, url, ...args);
    };
    const wrappedSet = p.setRequestHeader = function(name, value) {
      requests.get(this)?.headers.append(name, value);
      return original.set.call(this, name, value);
    };
    const wrappedSend = p.send = function(body) {
      if (!enabled) return original.send.call(this, body);
      const request = requests.get(this);
      if (!request || request.method !== 'GET') return original.send.call(this, body);
      observe(request.url);
      const blob = entries.get(key(request.url));
      const response = blob && request.async && !request.headers.has('If-Range') ? responseFor(blob, request.headers.get('Range')) : null;
      if (response) {
        const selection = range(request.headers.get('Range'), blob.size);
        const payload = selection ? blob.slice(selection.start, selection.end + 1, blob.type) : new Blob([]);
        const blobUrl = URL.createObjectURL(payload);
        const type = this.responseType, timeout = this.timeout;
        request.local = true;
        request.blobUrl = blobUrl;
        original.open.call(this, 'GET', blobUrl, true);
        this.responseType = type;
        this.timeout = timeout;
        this.withCredentials = false;
        Object.defineProperties(this, {
          status: { configurable: true, get: () => this.readyState >= 2 ? response.status : 0 },
          statusText: { configurable: true, get: () => this.readyState >= 2 ? response.statusText : '' },
          responseURL: { configurable: true, get: () => this.readyState >= 2 ? request.url : '' },
          getResponseHeader: { configurable: true, value: name => this.readyState >= 2 ? response.headers.get(name) : null },
          getAllResponseHeaders: { configurable: true, value: () => this.readyState >= 2 ? [...response.headers].map(([k,v]) => `${k}: ${v}\r\n`).join('') : '' }
        });
        this.addEventListener('loadend', () => { URL.revokeObjectURL(blobUrl); request.blobUrl = null; }, { once: true });
        hit();
      } else if (isPlayInfo(request.url)) {
        this.addEventListener('load', () => {
          try { if (enabled) metadata(this.responseType === 'json' ? this.response : JSON.parse(this.responseText)); } catch {}
        }, { once: true });
      }
      return original.send.call(this, body);
    };
    return { nativeFetch, uninstall() {
      enabled = false;
      if (window.fetch === wrappedFetch) window.fetch = originalFetch;
      if (p.open === wrappedOpen) p.open = original.open;
      if (p.send === wrappedSend) p.send = original.send;
      if (p.setRequestHeader === wrappedSet) p.setRequestHeader = original.set;
    } };
  }
  Object.defineProperty(window, '__BILI_PAGE_CACHE_CORE__', { value: { key, range, createPartialCache, responseFor, download, install }, configurable: true });
})();
