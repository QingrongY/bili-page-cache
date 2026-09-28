(() => {
  'use strict';
  if (location.origin !== 'https://www.bilibili.com' || !/^\/(video|bangumi\/play)\//.test(location.pathname)) return;
  if (window.__BILI_PAGE_CACHE_RUNNING__) return;
  window.__BILI_PAGE_CACHE_RUNNING__ = true;
  const core = window.__BILI_PAGE_CACHE_CORE__;
  const store = window.__BILI_PAGE_CACHE_STORE__;
  const lifetime = new AbortController();
  let saving = false, saveController = null, saveMessage = '', pinnedUntil = 0, pinnedKeys = [];
  const entries = new Map(), seen = new Map(), playInfoUrls = new Map();
  let info = null, controller = null, generation = 0, direct = null, stopped = false;
  let scope = '', lastMetadata = null, lastEmit = 0, cachedQuality = null;
  let targetKeys = new Set(), matchedKeys = new Set(), trackChanged = false;
  let speedSamples = [], job = null, pauseRequested = false;
  let state = { phase: 'idle', message: 'Choose a fixed video quality, play for a few seconds, then cache the video.', loaded: 0, total: 0, hits: 0, label: '', preview: false };
  const player = () => window.player;
  const video = () => (typeof player()?.mediaElement === 'function' ? player().mediaElement() : player()?.mediaElement) || document.querySelector('.bpx-player-video-wrap video, .bilibili-player-video video, video');
  function identity() {
    const u = new URL(location.href);
    let manifest;
    try { manifest = player()?.getManifest?.(); } catch {}
    return `${u.pathname}?p=${u.searchParams.get('p') || '1'}:${manifest?.cid || ''}`;
  }
  function emit(force = false) {
    if (!force && Date.now() - lastEmit < 200) return;
    lastEmit = Date.now();
    let speed = 0;
    if (state.phase === 'loading') {
      const now = performance.now();
      if (speedSamples.length && state.loaded < speedSamples.at(-1).loaded) speedSamples = [];
      speedSamples.push({ time: now, loaded: state.loaded });
      while (speedSamples.length > 2 && speedSamples[1].time < now - 8000) speedSamples.shift();
      const first = speedSamples[0];
      if (now - first.time >= 500) speed = Math.max(0, (state.loaded - first.loaded) * 1000 / (now - first.time));
    } else speedSamples = [];
    const remaining = speed > 0 && state.total > state.loaded ? Math.ceil((state.total - state.loaded) / speed) : null;
    const cachedBytes = [...entries.values()].reduce((sum, entry) => sum + (entry.cachedBytes ?? entry.size), 0);
    window.postMessage({ source: 'bili-page-cache:state', state: { ...state, files: entries.size, cachedBytes, speed, remaining, saving, saveMessage, pinnedUntil } }, location.origin);
  }
  function metadata(data) {
    const find = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 5) return null;
      if (value.dash || value.durl) return value;
      for (const name of ['video_info', 'playurl_info', 'playurl', 'data', 'result']) {
        const found = find(value[name], depth + 1);
        if (found) return found;
      }
      return null;
    };
    const found = find(data);
    if (found?.dash || found?.durl) { info = found; lastMetadata = window.__playinfo__; }
  }
  function rememberPlayInfo(url, time) {
    try {
      const u = new URL(url, location.href);
      if (u.protocol !== 'https:' || !['api.bilibili.com', 'www.bilibili.com'].includes(u.hostname) || !/\/playurl$/.test(u.pathname)) return;
      playInfoUrls.set(u.href, time);
      if (playInfoUrls.size > 16) playInfoUrls.delete(playInfoUrls.keys().next().value);
    } catch {}
  }
  function runtimeMedia() {
    const result = {};
    try {
      const kernel = player()?.__core?.();
      const mpd = kernel?.getMpd?.();
      if (Array.isArray(mpd?.video)) result.dash = mpd;
      for (const type of ['video', 'audio']) {
        const url = kernel?.getCurrentPlayURLFor?.(type);
        if (core.key(url)) result[type] = url;
      }
    } catch {}
    return result;
  }
  const hooks = core.install({ entries,
    observe: url => {
      rememberPlayInfo(url, performance.now());
      const k = core.key(url);
      if (!k) return;
      seen.set(k, { url, time: performance.now() });
      if (seen.size > 256) seen.delete(seen.keys().next().value);
      let cid;
      try { cid = player()?.getManifest?.()?.cid; } catch {}
      if (['loading', 'ready', 'mismatch'].includes(state.phase) && cid && k.split('/').includes(String(cid))) {
        if (!targetKeys.has(k)) { trackChanged = true; matchedKeys.clear(); }
        else {
          matchedKeys.add(k);
          if ([...targetKeys].every(t => matchedKeys.has(t))) trackChanged = false;
        }
      }
    },
    hit: () => { state.hits++; emit(); }, metadata
  });
  // Manual activation may miss the initial response, or the player may retain
  // a reference to fetch from before activation. Resource timings survive both.
  function readResources() {
    for (const entry of performance.getEntriesByType('resource')) {
      if (['fetch', 'xmlhttprequest'].includes(entry.initiatorType)) rememberPlayInfo(entry.name, entry.startTime);
      const k = core.key(entry.name);
      if (k && (!seen.has(k) || seen.get(k).time < entry.startTime)) seen.set(k, { url: entry.name, time: entry.startTime });
    }
    while (seen.size > 256) seen.delete(seen.keys().next().value);
  }
  readResources();
  async function recoverMetadata(signal, run) {
    if (lastMetadata !== window.__playinfo__ || !info) metadata(window.__playinfo__);
    readResources();
    const runtime = runtimeMedia();
    if (runtime.dash || (runtime.video && runtime.audio)) return;
    if (info || core.key(video()?.currentSrc)) return;
    let cid;
    try { cid = player()?.getManifest?.()?.cid; } catch {}
    const candidates = [...playInfoUrls].sort((a, b) => b[1] - a[1]).filter(([url]) => {
      const requestedCid = new URL(url).searchParams.get('cid');
      return !cid || !requestedCid || requestedCid === String(cid);
    });
    if (!candidates.length) return;
    // Repeat only the latest playback-information GET the page itself used,
    // preserving its existing parameters and the user's logged-in session.
    const response = await hooks.nativeFetch(candidates[0][0], {
      credentials: 'include', cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)])
    });
    if (!response.ok) throw new Error(`Could not read playback details (HTTP ${response.status})`);
    const data = await response.json();
    signal.throwIfAborted();
    if (run !== generation || stopped) return;
    metadata(data);
    if (!info) {
      const code = data?.code;
      throw new Error(code ? `No media URLs returned (code ${code})` : 'No media URLs found in the playback response');
    }
    readResources();
  }
  function restoreDirect() {
    if (!direct) return;
    const { element, url, source } = direct;
    if (element.currentSrc === url || element.src === url) {
      const time = element.currentTime, paused = element.paused;
      element.src = source;
      element.addEventListener('loadedmetadata', () => {
        element.currentTime = time;
        if (!paused) element.play().catch(() => {});
      }, { once: true });
    }
    URL.revokeObjectURL(url);
    direct = null;
  }
  function clear(message = 'Temporary cache cleared.', restore = true) {
    generation++;
    job = null; pauseRequested = false;
    controller?.abort(); controller = null;
    saveController?.abort(); saveController = null; saving = false; saveMessage = '';
    for (const entry of entries.values()) entry.clear?.();
    entries.clear(); cachedQuality = null;
    targetKeys.clear(); matchedKeys.clear(); trackChanged = false;
    if (restore) restoreDirect();
    else if (direct) {
      if (direct.element.src === direct.url) {
        direct.element.removeAttribute('src');
        direct.element.load();
      }
      URL.revokeObjectURL(direct.url); direct = null;
    }
    state = { phase: 'idle', message, loaded: 0, total: 0, hits: 0, label: '', preview: false };
    emit(true);
  }
  function urls(track) {
    return { url: track.baseUrl || track.base_url || track.url,
      backups: track.backupUrl || track.backup_url || [], id: track.id, codecs: track.codecs };
  }
  function selectTrack(list, currentUrl) {
    const valid = list.map(urls).filter(t => core.key(t.url));
    // The kernel's currently selected URL takes precedence over the initial MPD
    // and resource history, which can both refer to a previous codec or track.
    if (core.key(currentUrl)) {
      const match = valid.find(t => core.key(t.url) === core.key(currentUrl));
      return { ...(match || {}), url: currentUrl, backups: match ? [...new Set([match.url, ...(match.backups || [])])].filter(url => url !== currentUrl) : [] };
    }
    const observed = valid.map(t => ({ ...t, observed: seen.get(core.key(t.url)) }))
      .filter(t => t.observed).sort((a,b) => b.observed.time - a.observed.time);
    if (observed[0]) return { ...observed[0], url: observed[0].observed.url };
    throw new Error('No active tracks found. Choose a quality and play for a few seconds, then try again.');
  }
  function prepare() {
    if (lastMetadata !== window.__playinfo__ || !info) metadata(window.__playinfo__);
    let element;
    try { element = video(); } catch { element = document.querySelector('video'); }
    if (!element) throw new Error('No video found. Start playback, then try again.');
    const runtime = runtimeMedia();
    if (!info && !runtime.dash && !(runtime.video && runtime.audio) && !core.key(element.currentSrc)) {
      if (document.body?.innerText.includes('\u60a8\u6240\u5728\u7684\u5730\u533a\u65e0\u6cd5\u89c2\u770b')) throw new Error('This video is unavailable in your region. No media URLs were provided.');
      throw new Error('Playback details are not available yet. Play for a few seconds or change quality, then try again.');
    }
    const playback = { ...(info || {}) };
    if (runtime.dash) playback.dash = runtime.dash;
    else if (!playback.dash && runtime.video && runtime.audio) playback.dash = { video: [], audio: [] };
    const q = player()?.getQuality?.();
    const quality = q?.realQ || q?.nowQ || playback.quality;
    const format = playback.support_formats?.find(f => f.quality === quality);
    const label = (format?.new_description || format?.description || '').match(/(?:8K|4K|\d{3,4}[pP]|HDR|Dolby)(?:\+|60)?/i)?.[0] || (element.videoHeight ? element.videoHeight === 2160 ? '4K' : `${element.videoHeight}p` : 'Current quality');
    let tracks;
    const current = element.currentSrc;
    if (core.key(current)) {
      const choices = [...(playback.durl || []), ...(playback.durls || []).flatMap(x => x.durl || [])];
      const match = choices.find(x => core.key(x.url) === core.key(current));
      if (info && !match) throw new Error('The video changed. Wait for it to load, then try again.');
      tracks = [{ ...urls(match || { url: current }), url: current }];
    } else if (playback.dash) {
      const candidates = playback.dash.video?.filter(t => !quality || t.id === quality) || [];
      const audio = [...(playback.dash.audio || []), ...(playback.dash.dolby?.audio || []), ...(playback.dash.flac?.audio ? [playback.dash.flac.audio] : [])];
      tracks = [selectTrack(candidates, runtime.video)];
      if (audio.length || runtime.audio) tracks.push(selectTrack(audio, runtime.audio));
    } else throw new Error('This format is not supported. Use an MP4 or DASH stream.');
    let cid;
    try { cid = player()?.getManifest?.()?.cid; } catch {}
    if (cid && tracks.some(t => !core.key(t.url).split('/').includes(String(cid)))) {
      throw new Error('Playback details belong to another video. Reload the page and try again.');
    }
    return { element, tracks, label, preview: !!playback.is_preview, current, quality };
  }
  async function start(options = {}) {
    if (controller || stopped) return;
    const resume = options.resume && job;
    if (!resume) { clear(); pinnedKeys = []; pinnedUntil = 0; }
    pauseRequested = false;
    const run = generation;
    controller = new AbortController();
    const signal = controller.signal;
    const concurrency = [1, 4, 8].includes(options.concurrency) ? options.concurrency : 4;
    const autoSource = options.autoSource !== false;
    const usePartial = options.usePartial !== false;
    try {
      state.phase = 'loading';
      state.message = 'Reading playback details...';
      emit(true);
      await recoverMetadata(signal, run);
      signal.throwIfAborted();
      if (run !== generation || stopped) return;
      const prepared = prepare();
      if (resume && prepared.tracks.map(t => core.key(t.url)).join('\n') !== job.keys.join('\n')) throw new Error('The selected tracks changed. Clear the cache and start again.');
      const { element, tracks, label, preview, current, quality } = prepared;
      // Native <video src=https://...> requests do not pass through fetch/XHR.
      // Leave that path intact until a complete local MP4 is available.
      const progressive = usePartial && !core.key(current);
      const keys = tracks.map(track => core.key(track.url));
      let saved = null;
      try { if (!resume) saved = await store?.read(keys, signal); }
      catch { signal.throwIfAborted(); saveMessage = 'Could not read the saved copy. Cache the video again.'; }
      signal.throwIfAborted();
      if (run !== generation || stopped) return;
      if (saved && (saved.keys.length !== keys.length || saved.blobs?.length !== keys.length || !keys.every(key => saved.keys.includes(key)) || saved.blobs.some(blob => !(blob instanceof Blob) || !blob.size))) saved = null;
      if (!saved && options.restoreOnly) {
        controller = null; state.phase = 'idle'; state.message = 'Choose a fixed video quality, then click Cache video.'; emit(true); return;
      }
      cachedQuality = quality;
      targetKeys = new Set(tracks.map(t => core.key(t.url)));
      scope = identity();
      if (!resume) job = { keys, sessions: tracks.map(() => ({})) };
      const progress = job.sessions.map(session => ({ loaded: [...(session.parts?.values() || [])].reduce((n, b) => n + b.size, 0), total: session.total || 0 }));
      state = { ...state, phase: 'loading', resumable: false, label, preview, concurrency, autoSource, usePartial, progressive, message: preview ? 'Caching preview...' : 'Downloading video and audio...' };
      emit(true);
      const blobs = saved ? keys.map(key => saved.blobs[saved.keys.indexOf(key)]) : await Promise.allSettled(tracks.map((track, index) => core.download(track, signal, (loaded, total) => {
        if (run !== generation) return;
        progress[index] = { loaded, total };
        state.loaded = progress.reduce((s, x) => s + x.loaded, 0);
        state.total = progress.every(x => x.total) ? progress.reduce((s, x) => s + x.total, 0) : 0;
        emit();
      }, { session: job.sessions[index], concurrency: index === 0 ? concurrency : 1, autoSource, onPart: ({ offset, total, blob }) => {
        if (!progressive || run !== generation || signal.aborted) return;
        const key = core.key(track.url);
        let partial = entries.get(key);
        if (!partial) { partial = core.createPartialCache(total, blob.type); entries.set(key, partial); }
        partial.add(offset, blob);
        emit(true);
      }, onSource: source => {
        if (index !== 0 || run !== generation) return;
        state.source = source;
        emit(true);
      } }).then(blob => {
        if (progressive && run === generation && !signal.aborted) entries.set(core.key(track.url), blob);
        return blob;
      }).catch(error => { if (run === generation) controller?.abort(error); throw error; }))).then(results => { const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason; return results.map(result => result.value); });
      signal.throwIfAborted();
      if (run !== generation) return;
      tracks.forEach((t,i) => entries.set(core.key(t.url), blobs[i]));
      if (saved) {
        pinnedKeys = keys; pinnedUntil = saved.expiresAt;
        state.loaded = state.total = blobs.reduce((sum, blob) => sum + blob.size, 0);
        saveMessage = 'Using the saved copy.';
      }
      if (core.key(current) && element.currentSrc === current) {
        const time = element.currentTime, paused = element.paused;
        const url = URL.createObjectURL(blobs[0]);
        direct = { element, url, source: current };
        state.message = 'Download complete. Loading the cache...';
        emit(true);
        await new Promise((resolve, reject) => {
          const waiting = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
          const cleanup = () => {
            element.removeEventListener('loadedmetadata', loaded);
            element.removeEventListener('seeked', restored);
            element.removeEventListener('error', failed);
            waiting.removeEventListener('abort', aborted);
          };
          const restored = () => { cleanup(); resolve(); };
          const failed = () => { cleanup(); reject(new Error('Could not play the cached video')); };
          const aborted = () => { cleanup(); reject(waiting.reason); };
          const loaded = () => {
            if (paused) element.pause();
            if (time > 0) {
              element.addEventListener('seeked', restored, { once: true });
              element.currentTime = Math.min(time, element.duration);
            } else restored();
          };
          element.addEventListener('loadedmetadata', loaded, { once: true });
          element.addEventListener('error', failed, { once: true });
          waiting.addEventListener('abort', aborted, { once: true });
          element.src = url;
        });
        signal.throwIfAborted();
        if (paused) element.pause();
        else element.play().catch(() => {});
      }
      controller = null; job = null; state.resumable = false;
      updateReadyState();
      emit(true);
    } catch (error) {
      if (run !== generation) return;
      controller?.abort(); controller = null;
      restoreDirect();
      state.resumable = !!job;
      state.loaded = job ? job.sessions.reduce((n, session) => n + [...(session.parts?.values() || [])].reduce((m, b) => m + b.size, 0), 0) : 0;
      state.phase = pauseRequested ? 'paused' : 'error';
      if (pauseRequested) { state.message = 'Download paused.'; emit(true); return; }
      if (error.name === 'AbortError') state.message = 'Download canceled.';
      else if (error.name === 'TimeoutError' || /Failed to fetch|NetworkError/i.test(error.message)) {
        state.message = 'The video server did not respond. Check that the video plays normally, then retry. Reload the page if the link has expired.';
      } else state.message = `${String(error.message || error).replace(/[.\s]+$/, '')}.`;
      emit(true);
    }
  }
  async function pin() {
    if (stopped || saving || !['ready', 'mismatch'].includes(state.phase)) return;
    if (!store) { saveMessage = 'Open the updated extension and enable this page again to save.'; emit(true); return; }
    const keys = [...entries.keys()], blobs = [...entries.values()];
    if (!blobs.length || blobs.some(blob => !(blob instanceof Blob))) return;
    const run = generation;
    saving = true; saveMessage = 'Saving. Keep this tab open.';
    saveController = new AbortController();
    emit(true);
    try {
      const saved = await store.save({ keys, blobs, label: state.label, quality: cachedQuality }, AbortSignal.any([lifetime.signal, saveController.signal]));
      if (run !== generation || stopped) return;
      pinnedKeys = keys; pinnedUntil = saved.expiresAt;
      saveMessage = 'Saved for 7 days.';
    } catch (error) {
      if (run !== generation || stopped) return;
      saveMessage = error.message || 'Could not save. Try again.';
    } finally {
      if (run === generation && !stopped) { saving = false; saveController = null; emit(true); }
    }
  }
  async function unpin() {
    if (stopped || saving || !pinnedKeys.length || !store) return;
    const run = generation;
    saving = true; saveMessage = 'Deleting saved copy...';
    saveController = new AbortController(); emit(true);
    try {
      await store.remove(pinnedKeys, AbortSignal.any([lifetime.signal, saveController.signal]));
      if (run !== generation || stopped) return;
      pinnedKeys = []; pinnedUntil = 0;
      saveMessage = 'Saved copy deleted.';
    } catch {
      if (run === generation && !stopped) saveMessage = 'Could not delete the saved copy. Try again.';
    } finally {
      if (run === generation && !stopped) { saving = false; saveController = null; emit(true); }
    }
  }
  function updateReadyState() {
    let quality;
    try { quality = player()?.getQuality?.()?.realQ; } catch {}
    const mismatch = trackChanged || (quality && cachedQuality && quality !== cachedQuality);
    state.phase = mismatch ? 'mismatch' : 'ready';
    state.message = mismatch
      ? `${state.label} is cached. Switch back to that quality and audio track, or cache the new selection.`
      : state.preview ? 'Preview cached.' : 'Video cached.';
  }
  function onCommand(event) {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'bili-page-cache:command') return;
    switch (event.data.command) {
      case 'start': start(event.data); break;
      case 'pause': if (controller) { pauseRequested = true; controller.abort(); } break;
      case 'pin': pin(); break;
      case 'unpin': unpin(); break;
      case 'pinned-cleared': saveController?.abort(); pinnedKeys = []; pinnedUntil = 0; saveMessage = 'Saved copy deleted.'; emit(true); break;
      case 'clear': clear(); break;
      case 'status': emit(true); break;
      case 'disable': shutdown(); break;
    }
  }
  function shutdown(restore = true) {
    if (stopped) return;
    stopped = true;
    lifetime.abort();
    clear('Cache closed.', restore);
    clearInterval(timer);
    window.removeEventListener('message', onCommand);
    window.removeEventListener('pagehide', onPageHide);
    hooks.uninstall();
    store?.close?.();
    seen.clear(); playInfoUrls.clear(); info = null;
    delete window.__BILI_PAGE_CACHE_RUNNING__;
    delete window.__BILI_PAGE_CACHE_CORE__;
    delete window.__BILI_PAGE_CACHE_STORE__;
    state.phase = 'off';
    emit(true);
  }
  const onPageHide = () => shutdown(false);
  window.addEventListener('message', onCommand);
  window.addEventListener('pagehide', onPageHide);
  scope = identity();
  const timer = setInterval(() => {
    if (pinnedUntil && Date.now() >= pinnedUntil) {
      pinnedUntil = 0; pinnedKeys = []; saveMessage = 'Saved copy expired.';
      store?.cleanup(lifetime.signal).catch(() => {}); emit(true);
    }
    const next = identity();
    if (scope && next !== scope && !(scope.endsWith(':') && next.startsWith(scope))) {
      shutdown(false);
      return;
    }
    scope = next;
    if (['ready', 'loading', 'mismatch'].includes(state.phase)) {
      // Metadata/track changes invalidate the promise that the current picture is cached.
      let quality;
      try { quality = player()?.getQuality?.()?.realQ; } catch {}
      if (state.phase === 'loading' && (trackChanged || (quality && cachedQuality && quality !== cachedQuality))) {
        state.message = `Still caching ${state.label}. Switch back to that quality and audio track to use it.`;
        emit();
      } else if (state.phase !== 'loading') {
        const previous = state.message;
        updateReadyState();
        if (previous !== state.message) emit(true);
      }
      if (state.phase === 'loading') emit();
    }
  }, 1000);
  if (store) {
    store.cleanup(lifetime.signal).catch(() => {});
    try { prepare(); start({ restoreOnly: true }); } catch {}
  }
})();
