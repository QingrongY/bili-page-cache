(async () => {
  if (window.__BILI_PAGE_CACHE_PANEL__?.version === '0.6.1') { window.__BILI_PAGE_CACHE_PANEL__.show(); return; }
  if (window.__BILI_PAGE_CACHE_PANEL__ || document.querySelector('#bili-page-cache-panel')) {
    await new Promise(resolve => {
      const done = event => {
        if (event.source === window && event.data?.source === 'bili-page-cache:state' && event.data.panelOnly) {
          window.removeEventListener('message', done); resolve();
        }
      };
      window.addEventListener('message', done);
      window.postMessage({ source: 'bili-page-cache:state', state: { phase: 'off' }, panelOnly: true }, location.origin);
    });
  }
  document.querySelectorAll('#bili-page-cache-panel').forEach(panel => panel.remove());
  let host, root;
  let latestState = {}, pinOverride = {};
  const command = (command, options = {}) => window.postMessage({ source: 'bili-page-cache:command', command, ...options }, location.origin);
  function mount() {
    if (host || !/^\/(video|bangumi\/play)\//.test(location.pathname)) return;
    host = document.createElement('div');
    host.id = 'bili-page-cache-panel';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host{all:initial;position:fixed;right:20px;bottom:24px;z-index:2147483646;color:#e6e8eb;font:13px/1.5 system-ui,sans-serif;color-scheme:dark}
        *{box-sizing:border-box}section{width:min(304px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow:auto;background:#202124;border:1px solid #414348;border-radius:12px;padding:16px;box-shadow:0 6px 24px #0004}
        header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}strong{font-size:14px;font-weight:600}button{font:inherit;cursor:pointer;border:1px solid #505258;border-radius:6px;padding:7px 10px;background:#303237;color:#e6e8eb;white-space:nowrap}
        button:hover:not(:disabled){background:#3a3d43}button:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #a8c7fa;outline-offset:2px}
        #fold,#close{background:none;border:0;color:#b8bbc2;padding:0 6px;font-size:18px}p{margin:8px 0 12px;overflow-wrap:anywhere}small{display:block;color:#aeb3bc;font-size:11px}
        progress{width:100%;height:5px;accent-color:#a8c7fa;display:block;margin:12px 0 8px}nav{display:flex;gap:8px;margin-top:12px}#start{background:#a8c7fa;color:#15243c;border-color:#a8c7fa;flex:1;font-weight:600}#start:hover:not(:disabled){background:#c3d7fb}#pin{flex:1}
        button:disabled{opacity:.45;cursor:default}[hidden]{display:none!important}#label{color:#aeb3bc}#stats{font-variant-numeric:tabular-nums}#saved-status{margin-top:8px;overflow-wrap:anywhere}#saved-status:empty{display:none}
        details{margin-top:16px;border-top:1px solid #3b3e44;padding-top:10px}summary{cursor:pointer;color:#b8bbc2;font-size:12px}label{display:flex;align-items:center;gap:7px;margin-top:10px;color:#c3c7cf;font-size:12px}select{margin-left:auto;padding:3px 6px;background:#303237;color:#e6e8eb;border:1px solid #505258;border-radius:4px}input{margin:0;accent-color:#a8c7fa}#source-status,#partial-status{margin-top:4px}
      </style>
      <section aria-label="Bili Cache"><header><strong>Bili Cache</strong><div><button id="fold" aria-label="Collapse panel" aria-expanded="true">−</button><button id="close" aria-label="Close cache" title="Close and clear temporary cache">×</button></div></header>
      <div id="body"><small id="label">Current quality</small><p id="message" role="status">Reading playback details...</p>
      <progress id="progress" aria-label="Download progress" max="100" value="0"></progress><small id="stats"></small>
      <nav><button id="start">Cache video</button><button id="clear">Clear cache</button></nav>
      <nav><button id="pin" disabled title="Available after the download finishes">Save for 7 days</button><button id="unpin" hidden disabled>Delete saved</button></nav><small id="saved-status" role="status"></small>
      <details><summary>Options</summary>
      <label>Connections<select id="concurrency" aria-label="Download connections"><option value="1">1</option><option value="4" selected>4 (default)</option><option value="8">8</option></select></label>
      <label><input id="auto-source" type="checkbox" checked> Choose the fastest server</label><small id="source-status"></small>
      <label><input id="use-partial" type="checkbox" checked> Play downloaded parts</label><small id="partial-status"></small>
      </details></div></section>`;
    document.documentElement.append(host);
    root.querySelector('#start').onclick = () => command('start', { concurrency: Number(root.querySelector('#concurrency').value), autoSource: root.querySelector('#auto-source').checked, usePartial: root.querySelector('#use-partial').checked });
    root.querySelector('#clear').onclick = () => command('clear');
    root.querySelector('#pin').onclick = () => command('pin');
    root.querySelector('#unpin').onclick = () => command('unpin');
    root.querySelector('#close').onclick = () => command('disable');
    root.querySelector('#fold').onclick = () => {
      const body = root.querySelector('#body'); body.hidden = !body.hidden;
      root.querySelector('#fold').textContent = body.hidden ? '+' : '−';
      root.querySelector('#fold').setAttribute('aria-expanded', String(!body.hidden));
      root.querySelector('#fold').setAttribute('aria-label', body.hidden ? 'Expand panel' : 'Collapse panel');
    };
    command('status');
  }
  const bytes = n => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
  const duration = s => {
    const minutes = Math.ceil(s / 60);
    return s >= 3600 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : s >= 60 ? `${minutes}m` : `${Math.ceil(s)}s`;
  };
  function onState(event) {
    if (event.source !== window || event.origin !== location.origin || !root) return;
    if (event.data?.source === 'bili-page-cache:state') latestState = event.data.state;
    else if (event.data?.source === 'bili-page-cache:pin-state') pinOverride = event.data.state;
    else return;
    if (!latestState.phase) return;
    const s = { ...latestState, ...pinOverride };
    if (s.phase === 'off') { destroy(); return; }
    const english = value => typeof value === 'string' && !/\p{Script=Han}/u.test(value);
    // Keep a completed cache running when upgrading from an older interface.
    const fallback = s.phase === 'ready' ? (s.preview ? 'Preview cached.' : 'Video cached.') : s.phase === 'loading' ? 'Downloading video and audio...' : s.phase === 'mismatch' ? 'Switch back to the cached quality and audio track, or cache the new selection.' : s.phase === 'error' ? 'Cache failed. Close the panel and enable it again to retry.' : 'Choose a fixed video quality, then click Cache video.';
    root.querySelector('#message').textContent = english(s.message) ? s.message : fallback;
    const label = english(s.label) && s.label ? s.label : 'Current quality';
    root.querySelector('#label').textContent = `${label}${s.preview ? ' · Preview' : ''}`;
    const rate = s.phase === 'loading' ? ` · ${((s.speed || 0) / 1024 ** 2).toFixed(2)} MB/s${s.remaining ? ` · ${duration(s.remaining)} left` : ''}` : '';
    root.querySelector('#stats').textContent = `${bytes(s.loaded || 0)}${s.total ? ' / ' + bytes(s.total) : ''}${rate}`;
    root.querySelector('#concurrency').disabled = s.phase === 'loading';
    root.querySelector('#auto-source').disabled = s.phase === 'loading';
    root.querySelector('#use-partial').disabled = s.phase === 'loading';
    if (s.phase === 'loading' && typeof s.usePartial === 'boolean') root.querySelector('#use-partial').checked = s.usePartial;
    root.querySelector('#partial-status').textContent = s.phase !== 'loading' ? '' : s.progressive ? `${bytes(s.cachedBytes || 0)} ready. Uncached positions may buffer.` : 'Playback will use the cache when complete.';
    if (s.phase === 'loading' && typeof s.autoSource === 'boolean') root.querySelector('#auto-source').checked = s.autoSource;
    root.querySelector('#source-status').textContent = !s.autoSource || !s.source ? '' : s.source.phase === 'testing' ? 'Checking server speeds...' : s.source.phase === 'selected' ? 'Server selected.' : s.source.phase === 'single' ? 'One server available.' : 'Speed check failed. Using the original server.';
    if (s.phase === 'loading' && s.concurrency) root.querySelector('#concurrency').value = String(s.concurrency);
    const progress = root.querySelector('#progress');
    if (s.phase === 'loading' && !s.total) progress.removeAttribute('value');
    else progress.value = s.total ? Math.min(100, 100 * s.loaded / s.total) : 0;
    root.querySelector('#start').disabled = s.phase === 'loading' || s.phase === 'ready';
    root.querySelector('#start').textContent = s.phase === 'loading' ? 'Downloading...' : s.phase === 'ready' ? 'Cached' : 'Cache video';
    root.querySelector('#clear').textContent = s.phase === 'loading' ? 'Cancel' : 'Clear cache';
    root.querySelector('#pin').disabled = !!s.saving || !['ready', 'mismatch'].includes(s.phase);
    root.querySelector('#pin').textContent = s.saving ? 'Please wait...' : s.pinnedUntil ? 'Renew for 7 days' : 'Save for 7 days';
    root.querySelector('#unpin').disabled = !!s.saving || !s.pinnedUntil;
    root.querySelector('#unpin').hidden = !s.pinnedUntil;
    const expiry = s.pinnedUntil ? `Expires ${new Date(s.pinnedUntil).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.` : '';
    const note = english(s.saveMessage) ? s.saveMessage : s.saving ? 'Saving. Keep this tab open.' : '';
    root.querySelector('#saved-status').textContent = expiry && !s.saving ? (!note || ['Saved for 7 days.', 'Using the saved copy.'].includes(note) ? expiry : `${note} ${expiry}`) : note;

  }
  function onRuntime(message, sender, respond) {
    if (message.command === 'show') { mount(); if (root) root.querySelector('#body').hidden = false; respond({ ok: !!root }); }
  }
  function destroy() {
    host?.remove(); host = null; root = null;
    window.removeEventListener('message', onState);
    window.removeEventListener('pagehide', destroy);
    try { chrome.runtime.onMessage.removeListener(onRuntime); } catch {}
    delete window.__BILI_PAGE_CACHE_PANEL__;
  }
  window.__BILI_PAGE_CACHE_PANEL__ = { version: '0.6.1', show() {
    mount();
    if (root) { root.querySelector('#body').hidden = false; root.querySelector('#fold').textContent = '−'; root.querySelector('#fold').setAttribute('aria-expanded', 'true'); root.querySelector('#fold').setAttribute('aria-label', 'Collapse panel'); }
    command('status');
  } };
  window.addEventListener('message', onState);
  window.addEventListener('pagehide', destroy);
  chrome.runtime.onMessage.addListener(onRuntime);
  mount();
})();
