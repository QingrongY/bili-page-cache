importScripts('cache-db.js');
const alarmName = 'bili-cache-expiry';
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
  if (message?.type === 'cache-before-save') {
    chrome.alarms.create(alarmName, { periodInMinutes: 30 }).then(() => reply({ ok: true }), () => reply({ ok: false }));
    return true;
  }
  if (message?.type !== 'cache-storage-changed') return;
  maintain().then(() => reply({ ok: true }), () => reply({ ok: false }));
  return true;
});
