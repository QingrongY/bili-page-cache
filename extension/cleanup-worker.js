importScripts('cache-db.js');
const alarmName = 'bili-cache-expiry';
const sessions = new Map();
async function maintain() {
  // Runs only on startup/install, explicit storage changes or the expiry alarm.
  // No tab access, media requests or page injection.
  await globalThis.__BILI_PAGE_CACHE_DB__.cleanup();
  if ((await globalThis.__BILI_PAGE_CACHE_DB__.stats()).count) await chrome.alarms.create(alarmName, { periodInMinutes: 30 });
}
chrome.runtime.onInstalled.addListener(() => maintain().catch(() => {}));
chrome.runtime.onStartup.addListener(() => maintain().catch(() => {}));
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === alarmName) maintain().catch(() => {}); });
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === 'cache-session-open') {
    if (!sender.tab || sender.frameId !== 0 || !/^https:\/\/www\.bilibili\.com\/(video|bangumi\/play)\//.test(sender.url || '')) return;
    for (const [token, entry] of sessions) if (entry.until < Date.now()) sessions.delete(token);
    const token = crypto.randomUUID();
    sessions.set(token, { tabId: sender.tab.id, until: Date.now() + 15000 }); reply({ token }); return;
  }
  if (message?.type === 'cache-session-connect') {
    const entry = sessions.get(message.token);
    if (sender.url !== chrome.runtime.getURL('storage-frame.html') || !sender.tab || sender.frameId === 0) return;
    sessions.delete(message.token);
    reply({ ok: !!entry && entry.tabId === sender.tab.id && entry.until >= Date.now() }); return;
  }
  if (message?.type === 'cache-before-save') {
    chrome.alarms.create(alarmName, { periodInMinutes: 30 }).then(() => reply({ ok: true }), () => reply({ ok: false }));
    return true;
  }
  if (message?.type !== 'cache-storage-changed') return;
  maintain().then(() => reply({ ok: true }), () => reply({ ok: false }));
  return true;
});
