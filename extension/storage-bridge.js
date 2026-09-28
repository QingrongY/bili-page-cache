/* ISOLATED world: ports and one-use grants never enter the page world. */
(() => {
  if (globalThis.__BILI_CACHE_BRIDGE__) return;
  const pageUrl = () => { const u = new URL(location.href); return u.origin + u.pathname + '?p=' + (u.searchParams.get('p') || '1'); };
  const initialUrl = pageUrl(), pending = new Map();
  let frame, port, ready, grant, keys, closed = false, commandRun = 0, readGrant = false;
  const post = data => window.postMessage(data, location.origin);
  function connect() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error('Could not connect to saved storage. Enable this tab again.')); close(); }, 10000);
      (async () => {
        const { token } = await chrome.runtime.sendMessage({ type: 'cache-session-open' });
        if (!token || closed) throw new Error('Storage session unavailable');
        frame = document.createElement('iframe'); frame.hidden = true;
        frame.dataset.biliCacheStorage = 'true';
        const channel = new MessageChannel(); port = channel.port1;
        port.onmessage = event => {
          const data = event.data;
          if (data.ready) { clearTimeout(timeout); resolve(); return; }
          if (data.purged) { grant = null; post({ source: 'bili-page-cache:command', command: 'pinned-cleared' }); return; }
          const entry = pending.get(data.id);
          if (!entry) return;
          pending.delete(data.id);
          data.error ? entry.reject(Object.assign(new Error(data.error.message), { name: data.error.name })) : entry.resolve(data.result);
        };
        frame.onload = () => frame.contentWindow.postMessage({ source: 'bili-cache-connect', token }, new URL(chrome.runtime.getURL('/')).origin, [channel.port2]);
        frame.src = chrome.runtime.getURL('storage-frame.html'); document.documentElement.append(frame);
      })().catch(error => { clearTimeout(timeout); reject(error); close(); });
    });
    return ready;
  }
  async function rpc(method, value, id = crypto.randomUUID()) {
    await connect();
    if (closed || pageUrl() !== initialUrl) throw new DOMException('Cache closed', 'AbortError');
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); port.postMessage({ id, method, value }); });
  }
  const validKeys = value => Array.isArray(value) && value.length > 0 && value.length <= 4 && value.every(k => typeof k === 'string' && k.startsWith('/') && /\.(m4s|mp4)$/i.test(k) && k.length < 2048);
  const sameKeys = value => validKeys(value) && keys && [...value].sort().join('\n') === keys;
  async function receive(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.source === 'bili-page-cache:state' && event.data.state?.phase === 'off' && !event.data.panelOnly) { close(); return; }
    if (event.data?.source !== 'bili-cache-store') return;
    const { id, method, value } = event.data;
    if (typeof id !== 'string') return;
    if (method === 'cancel') { port?.postMessage({ id, method }); return; }
    try {
      if (closed || pageUrl() !== initialUrl) throw new Error('Enable this video tab again.');
      let payload = value;
      if (method === 'read') {
        if (!validKeys(value) || (keys && !sameKeys(value))) throw new Error('This video is not selected.');
        keys = [...value].sort().join('\n'); payload = { keys: value, url: initialUrl, allowLegacy: readGrant }; readGrant = false;
      } else if (method === 'save' || method === 'remove') {
        const permission = grant; grant = null;
        if (!permission || permission.method !== method || performance.now() > permission.until || !sameKeys(method === 'save' ? value?.keys : value)) throw new Error('Click the button in Bili Cache to continue.');
        payload = method === 'save' ? { ...value, epoch: permission.epoch, url: initialUrl, title: document.title.replace(/[_-]哔哩哔哩.*$/, '').trim() } : value;
      } else if (method !== 'cleanup') throw new Error('Storage action not allowed.');
      const result = await rpc(method, payload, id);
      post({ source: 'bili-cache-store-result', id, result });
    } catch (error) { post({ source: 'bili-cache-store-result', id, error: { name: error.name, message: error.message } }); }
  }
  function close() {
    if (closed) return; closed = true; grant = null;
    port?.close(); frame?.remove();
    for (const entry of pending.values()) entry.reject(new DOMException('Cache closed', 'AbortError'));
    pending.clear(); window.removeEventListener('message', receive); window.removeEventListener('pagehide', close);
    delete globalThis.__BILI_CACHE_BRIDGE__;
  }
  globalThis.__BILI_CACHE_BRIDGE__ = {
    async command(command, options, event) {
      if (command !== 'status' && !event?.isTrusted) return;
      const run = ++commandRun;
      try {
        if (command === 'start' && !options?.resume) { keys = null; grant = null; readGrant = true; }
        if (command === 'pin' || command === 'unpin') {
          grant = null;
          const epoch = await rpc('revision');
          if (run !== commandRun || closed) return;
          grant = { method: command === 'pin' ? 'save' : 'remove', epoch, until: performance.now() + 10000 };
        }
        if (command === 'clear') grant = null;
        post({ source: 'bili-page-cache:command', command, ...options });
        if (command === 'disable') close();
      } catch (error) { post({ source: 'bili-page-cache:pin-state', state: { saving: false, saveMessage: error.message } }); }
    }
  };
  window.addEventListener('message', receive); window.addEventListener('pagehide', close);
})();
