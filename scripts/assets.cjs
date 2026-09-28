const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const extension = path.join(root, 'extension');
const options = process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : { channel: process.env.BROWSER || 'msedge' };
(async () => {
  fs.mkdirSync(path.join(root, 'store'), { recursive: true });
  const browser = await chromium.launch({ ...options, headless: true });
  try {
    const page = await browser.newPage();
    const svg = fs.readFileSync(path.join(extension, 'icons/icon.svg'), 'utf8');
    for (const size of [16, 32, 48, 128, 300]) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent('<style>body{margin:0}svg{display:block;width:100%;height:100%}</style>' + svg);
      await page.screenshot({ path: path.join(root, size === 300 ? 'store/logo.png' : 'extension/icons/' + size + '.png'), omitBackground: true });
    }
    const fixturePath = path.join(root, 'tests/fixture.mp4');
    if (!fs.existsSync(fixturePath)) execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', fixturePath]);
    const fixture = fs.readFileSync(fixturePath), url = 'https://test.bilivideo.com/123/example.mp4';
    await page.route('https://www.bilibili.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Example video</title><style>body{background:#f4f5f7}</style><video muted hidden></video>' }));
    await page.route('https://test.bilivideo.com/**', route => route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*', 'Content-Length': String(fixture.length) }, contentType: 'video/mp4', body: fixture }));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('https://www.bilibili.com/video/BVexample');
    await page.evaluate(url => {
      window.chrome = { runtime: { onMessage: { addListener() {}, removeListener() {} } } };
      window.__BILI_CACHE_BRIDGE__ = { command(command, options) { window.postMessage({ source: 'bili-page-cache:command', command, ...options }, location.origin); } };
      window.player = { getQuality: () => ({ realQ: 80 }), mediaElement: () => document.querySelector('video'), __core: () => ({ getMpd: () => ({ video: [{ id: 80, base_url: url }], audio: [] }), getCurrentPlayURLFor: type => type === 'video' ? url : '' }) };
    }, url);
    for (const file of ['cache-core.js', 'page.js', 'panel.js']) await page.addScriptTag({ path: path.join(extension, file) });
    await page.locator('#bili-page-cache-panel').getByRole('button', { name: 'Cache video' }).click();
    await page.locator('#bili-page-cache-panel').getByRole('button', { name: 'Cached', exact: true }).waitFor();
    await page.locator('#bili-page-cache-panel').screenshot({ path: path.join(root, 'docs/panel.png') });
    await page.evaluate(() => { const panel = document.querySelector('#bili-page-cache-panel'); panel.style.cssText = 'right:50%;bottom:50%;transform:translate(50%,50%) scale(1.5)'; });
    await page.screenshot({ path: path.join(root, 'store/cache.png') });
  } finally { await browser.close(); }
  const context = await chromium.launchPersistentContext('', { ...options, headless: true, args: ['--enable-unsafe-extension-debugging'], ignoreDefaultArgs: ['--disable-extensions'] });
  try {
    const session = await context.browser().newBrowserCDPSession();
    const { id } = await session.send('Extensions.loadUnpacked', { path: extension });
    const page = await context.newPage(); await page.goto('chrome-extension://' + id + '/popup.html');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(async () => {
      await __BILI_PAGE_CACHE_DB__.save({ keys: ['/example.mp4'], blobs: [new Blob([new Uint8Array(8 * 1024 ** 2)])], title: 'Example video', label: '1080p', url: 'https://www.bilibili.com/video/BVexample' });
    });
    await page.reload(); await page.locator('#saved-list li').waitFor();
    await page.locator('body').screenshot({ path: path.join(root, 'docs/saved.png') });
    await page.addStyleTag({ content: 'html{background:#f4f5f7}body{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(1.5);border-radius:12px;box-shadow:0 6px 24px #0002}' });
    await page.screenshot({ path: path.join(root, 'store/saved.png') });
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
