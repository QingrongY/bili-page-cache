(() => {
  const operations = new Map(); let port, currentId;
  const changes = new BroadcastChannel('bili-cache-changes');
  changes.onmessage = event => { if (event.data?.clear || (currentId && event.data?.removed === currentId)) { for (const controller of operations.values()) controller.abort(); send({ purged: true }); } };
  const send = value => port?.postMessage(value);
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'cache-purge-all') return;
    for (const controller of operations.values()) controller.abort();
    send({ purged: true }); reply({ ok: true });
  });
  window.addEventListener('message', async event => {
    if (port || event.source !== parent || event.origin !== 'https://www.bilibili.com' || event.data?.source !== 'bili-cache-connect' || !event.ports[0]) return;
    const answer = await chrome.runtime.sendMessage({ type: 'cache-session-connect', token: event.data.token }).catch(() => null);
    if (!answer?.ok || port) return;
    port = event.ports[0];
    port.onmessage = async event => {
      const { id, method, value } = event.data;
      if (method === 'cancel') { operations.get(id)?.abort(); return; }
      if (!['save', 'read', 'remove', 'cleanup', 'revision'].includes(method) || typeof id !== 'string') return;
      const controller = new AbortController(); operations.set(id, controller);
      try {
        const db = globalThis.__BILI_PAGE_CACHE_DB__;
        if (method === 'save' && !(await chrome.runtime.sendMessage({ type: 'cache-before-save' }))?.ok) throw new Error('Could not schedule cleanup. Try saving again.');
        let result;
        if (method === 'read') {
          currentId = [...value.keys].sort().join('\n');
          result = await db.read(value.keys, controller.signal);
          const canonical = url => { try { const u = new URL(url); return u.origin + u.pathname + '?p=' + (u.searchParams.get('p') || '1'); } catch { return ''; } };
          if (result && canonical(result.url) !== value.url && !(value.allowLegacy && !result.url)) result = null;
        } else result = ['cleanup', 'revision'].includes(method) ? await db[method](controller.signal) : await db[method](value, controller.signal);
        if (['save', 'remove', 'cleanup'].includes(method)) await chrome.runtime.sendMessage({ type: 'cache-storage-changed' }).catch(() => {});
        send({ id, result });
      } catch (error) { send({ id, error: { name: error.name, message: error.message } }); }
      finally { operations.delete(id); }
    };
    send({ ready: true });
  });
  window.addEventListener('pagehide', () => { for (const controller of operations.values()) controller.abort(); port?.close(); changes.close(); });
})();
