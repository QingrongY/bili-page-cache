const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '..');
const extension = path.join(root, 'extension');
const sizeGB = Number(process.env.LARGE_GB || 8);
const options = process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : { channel: process.env.BROWSER || 'msedge' };
function diskSize(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  return entries.reduce((n, entry) => {
    const file = path.join(dir, entry.name);
    try { return n + (entry.isDirectory() ? diskSize(file) : fs.statSync(file).size); } catch (error) { if (error.code === 'ENOENT') return n; throw error; }
  }, 0);
}
test('large saved video survives browser restart and deletion releases its files', { timeout: 900000 }, async () => {
  assert.ok(Number.isInteger(sizeGB) && sizeGB >= 2 && sizeGB <= 12);
  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bili-cache-large-'));
  let context, id, sampling, memoryTimer;
  const report = { sizeGB, browser: options, peakBrowserWorkingSet: 0 };
  async function launch() {
    context = await chromium.launchPersistentContext(profile, { ...options, headless: true, args: ['--mute-audio', '--enable-unsafe-extension-debugging', ...(process.env.BLOB_DEBUG ? ['--enable-logging=stderr', '--vmodule=blob*=2'] : [])], ignoreDefaultArgs: ['--disable-extensions'] });
    const session = await context.browser().newBrowserCDPSession();
    ({ id } = await session.send('Extensions.loadUnpacked', { path: extension }));
    const page = await context.newPage(); await page.goto('chrome-extension://' + id + '/popup.html');
    return page;
  }
  try {
    let page = await launch();
    const start = Date.now();
    report.before = diskSize(profile);
    if (process.env.LARGE_DOWNLOAD === '1') {
      const total = sizeGB * 1024 ** 3, blockSize = 4 * 1024 ** 2;
      const block = Buffer.alloc(blockSize * 2);
      for (let i = 0; i < block.length; i++) block[i] = (i % blockSize) % 251;
      let requests = 0;
      const manager = page;
      await manager.evaluate(size => __BILI_PAGE_CACHE_DB__.setLimit(size), sizeGB * 1024 ** 3);
      page = await context.newPage();
      await page.route('https://www.bilibili.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Large storage test</title><video muted></video>' }));
      await page.goto('https://www.bilibili.com/video/BVlarge');
      await page.evaluate(() => {
        const url = 'https://test.bilivideo.com/large.mp4';
        window.player = { getQuality: () => ({ realQ: 120 }), mediaElement: () => document.querySelector('video'), __core: () => ({
          getMpd: () => ({ video: [{ id: 120, base_url: url }], audio: [] }), getCurrentPlayURLFor: type => type === 'video' ? url : ''
        }) };
        window.addEventListener('message', event => { if (event.data?.source === 'bili-page-cache:state') window.lastCacheState = event.data.state; });
      });
      const session = await context.browser().newBrowserCDPSession();
      const { targetInfos } = await session.send('Target.getTargets', { filter: [{ type: 'tab' }] });
      await session.send('Extensions.triggerAction', { id, targetId: targetInfos.find(t => t.url === page.url()).targetId });
      const popup = await context.newPage(); await popup.goto('chrome-extension://' + id + '/popup.html');
      await page.bringToFront(); await popup.evaluate(() => document.querySelector('#show').click());
      await page.waitForSelector('#bili-page-cache-panel');
      await page.route('https://test.bilivideo.com/**', async route => {
        const range = /bytes=(\d+)-(\d+)/.exec(route.request().headers().range);
        const begin = Number(range[1]), end = Math.min(Number(range[2]), total - 1), offset = begin % blockSize;
        requests++; report.rangeRequests = requests;
        await route.fulfill({ status: 206, headers: {
          'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range,Content-Length',
          'Content-Type': 'video/mp4', 'Content-Range': 'bytes ' + begin + '-' + end + '/' + total, 'Content-Length': String(end - begin + 1)
        }, body: block.subarray(offset, offset + end - begin + 1) });
      });
      if (process.platform === 'win32') {
        const cdp = await context.browser().newBrowserCDPSession();
        const sample = async () => {
          try {
            const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
            const ids = processInfo.map(p => p.id).filter(Number.isInteger).join(',');
            const exec = require('node:util').promisify(require('node:child_process').execFile);
            const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command', '(Get-Process -Id ' + ids + ' -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum'], { windowsHide: true });
            report.peakBrowserWorkingSet = Math.max(report.peakBrowserWorkingSet, Number(stdout.trim()) || 0);
          } catch {}
        };
        memoryTimer = setInterval(() => { if (!sampling) sampling = sample().finally(() => { sampling = null; }); }, 1000);
      }
      const downloadStart = Date.now();
      await page.locator('#bili-page-cache-panel').getByRole('button', { name: 'Cache video' }).click();
      await page.waitForFunction(() => ['ready', 'error'].includes(window.lastCacheState?.phase), null, { timeout: 600000 });
      const state = await page.evaluate(() => window.lastCacheState);
      assert.equal(state.phase, 'ready', JSON.stringify(state));
      report.downloadMs = Date.now() - downloadStart; report.rangeRequests = requests;
      await page.locator('#bili-page-cache-panel').getByRole('button', { name: 'Save for 7 days' }).click();
      await page.waitForFunction(() => window.lastCacheState?.pinnedUntil > Date.now() || (!!window.lastCacheState?.saveMessage && !window.lastCacheState.saving), null, { timeout: 180000 });
      assert.ok((await page.evaluate(() => window.lastCacheState)).pinnedUntil, JSON.stringify(await page.evaluate(() => window.lastCacheState)));
      await page.close(); page = manager;
    }
    report.saved = await page.evaluate(async ({ sizeGB, downloaded }) => {
      const db = __BILI_PAGE_CACHE_DB__, MiB = 1024 ** 2;
      await db.setLimit(sizeGB * 1024 ** 3);
      const block = new Uint8Array(4 * MiB);
      for (let i = 0; i < block.length; i++) block[i] = i % 251;
      // Small source blocks keep fixture construction independent of file size.
      const part = new Blob([block]);
      let blob = window.largeBlob || new Blob(Array(sizeGB * 256).fill(part));
      delete window.largeBlob;
      const began = performance.now();
      await chrome.runtime.sendMessage({ type: 'cache-before-save' });
      if (!downloaded) await db.save({ keys: ['/large.mp4'], blobs: [blob], title: 'Large storage test', label: '4K', url: 'https://www.bilibili.com/video/BVlarge' });
      blob = null;
      let quotaError;
      try { await db.save({ keys: ['/extra.mp4'], blobs: [new Blob(['extra'])] }); } catch (error) { quotaError = error.name; }
      let lowerLimitError;
      try { await db.setLimit(1024 ** 3); } catch (error) { lowerLimitError = error.message; }
      return { stats: await db.stats(), quotaError, lowerLimitError, saveMs: performance.now() - began };
    }, { sizeGB, downloaded: process.env.LARGE_DOWNLOAD === '1' });
    assert.equal(report.saved.stats.bytes, sizeGB * 1024 ** 3);
    assert.equal(report.saved.quotaError, 'QuotaExceededError');
    assert.match(report.saved.lowerLimitError, /Delete saved videos/);
    report.onDisk = diskSize(profile);
    clearInterval(memoryTimer); await sampling;
    await context.close(); context = null;
    page = await launch();
    report.restored = await page.evaluate(async () => {
      const db = __BILI_PAGE_CACHE_DB__, record = await db.read(['/large.mp4']), blob = record.blobs[0], samples = [];
      for (const offset of [0, 4 * 1024 ** 2 - 7, 1024 ** 3 + 17, blob.size - 31]) {
        const bytes = [...new Uint8Array(await blob.slice(offset, offset + 31).arrayBuffer())];
        if (!bytes.every((value, index) => value === ((offset + index) % (4 * 1024 ** 2)) % 251)) throw new Error('Restored bytes differ at ' + offset);
        samples.push({ offset, length: bytes.length });
      }
      return { size: blob.size, samples, count: (await db.stats()).count };
    });
    assert.equal(report.restored.size, sizeGB * 1024 ** 3);
    await page.locator('#clear-all').click();
    await page.waitForFunction(async () => (await __BILI_PAGE_CACHE_DB__.stats()).count === 0);
    await page.close();
    await context.close(); context = null;
    report.afterDelete = diskSize(profile);
    for (let attempt = 0; attempt < 20 && report.afterDelete > report.before + 128 * 1024 ** 2; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      report.afterDelete = diskSize(profile);
    }
    if (report.afterDelete > report.before + 128 * 1024 ** 2) {
      page = await launch();
      await page.evaluate(() => __BILI_PAGE_CACHE_DB__.cleanup());
      for (let attempt = 0; attempt < 60 && diskSize(profile) > report.before + 128 * 1024 ** 2; attempt++) await new Promise(resolve => setTimeout(resolve, 500));
      await context.close(); context = null;
      report.afterDelete = diskSize(profile);
    }
    console.log('Disk measurements:', JSON.stringify({ before: report.before, saved: report.onDisk, deleted: report.afterDelete }));
    assert.ok(report.onDisk > report.before + sizeGB * 1024 ** 3 * 0.9, 'Fixture must occupy real disk space');
    assert.ok(report.afterDelete <= report.before + 128 * 1024 ** 2, 'Deleting and closing must release saved and temporary blob files');
    report.elapsedMs = Date.now() - start;
    fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test-results', 'large-storage.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } catch (error) { console.log('Failure measurements:', JSON.stringify(report));
    throw error; } finally {
    clearInterval(memoryTimer); await sampling;
    await context?.close();
    const resolved = path.resolve(profile), tempRoot = path.resolve(require('node:os').tmpdir());
    if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('bili-cache-large-')) throw new Error('Unexpected test profile path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
