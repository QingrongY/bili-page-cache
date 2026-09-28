document.querySelector('#show').onclick = async () => {
  const button = document.querySelector('#show');
  button.disabled = true;
  let tab;
  let injectedTarget;
  try {
    const permissions = chrome.runtime.getManifest().permissions || [];
    if (!permissions.includes('activeTab') || !permissions.includes('scripting')) {
      throw new Error('Extension permissions are out of date. Reload Bili Cache in the extensions page, then try again.');
    }
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!Number.isInteger(tab?.id) || tab.id < 0) {
      throw new Error('No active tab found. Open a video tab and try again.');
    }
    // Tab.url can be absent. Read the actual document under activeTab instead
    // of treating missing tab metadata as an unsupported page.
    let page;
    try {
      [page] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => location.href });
    } catch {
      throw new Error('Cannot access this tab. Open the extension from your Bilibili video tab and try again.');
    }
    if (!page?.result || !page.documentId) {
      throw new Error('This page is still loading. Try again when it is ready.');
    }
    const url = new URL(page.result);
    if (url.origin !== 'https://www.bilibili.com' || !/^\/(video|bangumi\/play)\//.test(url.pathname)) {
      throw new Error(`Open a Bilibili video or episode first. Current page: ${url.hostname}${url.pathname}`);
    }
    // Pin both injections to the document that was checked, even if the tab
    // navigates while activation is in progress.
    injectedTarget = { tabId: tab.id, documentIds: [page.documentId] };
    await chrome.scripting.executeScript({ target: injectedTarget, files: ['storage-bridge.js'] });
    await chrome.scripting.executeScript({ target: injectedTarget, world: 'MAIN', files: ['cache-core.js', 'storage.js', 'page.js'] });
    await chrome.scripting.executeScript({ target: injectedTarget, files: ['panel.js'] });
    const [panel] = await chrome.scripting.executeScript({ target: injectedTarget, func: () => !!document.getElementById('bili-page-cache-panel') });
    if (!panel?.result) throw new Error('The page changed before the panel opened. Try again on the video tab.');
    window.close();
  } catch (error) {
    if (injectedTarget) {
      await chrome.scripting.executeScript({ target: injectedTarget, world: 'MAIN', func: () => window.postMessage({ source: 'bili-page-cache:command', command: 'disable' }, location.origin) }).catch(() => {});
    }
    document.querySelector('#status').textContent = error.message || 'Could not open the panel. Reload the video page and try again.';
  } finally { button.disabled = false; }
};
