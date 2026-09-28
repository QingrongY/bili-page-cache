const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
let browser;
const mediaUrl = 'https://test.bilivideo.com/upgcxcode/1/2/123/123-1-80.mp4';
const fixture = fs.readFileSync(path.join(__dirname, 'fixture.mp4'));
const large = Buffer.alloc(18 * 1024 ** 2 + 39);
for (let i=0; i<large.length; i++) large[i] = i % 251;
const extension = path.join(__dirname, '..', 'extension');
before(async () => {
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--mute-audio'] });
});
after(async () => { await browser?.close(); });
async function setup(data = fixture, loadCore = true) {
  const page = await browser.newPage();
  const network = { count: 0, urls: new Set(), requests: [], offline: false, failures: 0, active: 0, maxActive: 0, completed: [], delay: () => 0, beforeResponse: async () => {}, ignoreRange: false };
  await page.route('https://www.bilibili.com/**', r => r.fulfill({ contentType:'text/html', body: '<!doctype html><body><video muted controls></video></body>' }));
  await page.route('https://*.bilivideo.com/**', async r => {
    network.count++;
    network.urls.add(r.request().url());
    if (network.offline || network.failures-- > 0) return r.abort();
    const match = network.ignoreRange ? null : /bytes=(\d+)-(\d*)/.exec(r.request().headers().range || '');
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
    const host = new URL(r.request().url()).hostname;
    network.requests.push({ start, end, host });
    network.active++;
    network.maxActive = Math.max(network.maxActive, network.active);
    try {
    await network.beforeResponse(start, host);
    const delay = network.delay(start, host);
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    await r.fulfill({ status: match ? 206 : 200, headers: {
      'Access-Control-Allow-Origin':'*', 'Access-Control-Expose-Headers':'Content-Range,Content-Length',
      'Content-Range':`bytes ${start}-${end}/${data.length}`, 'Content-Type':'video/mp4',
      'Content-Length': String(end-start+1)
    }, body: data.subarray(start,end+1) });
    network.completed.push(start);
    } finally { network.active--; }
  });
  await page.goto('https://www.bilibili.com/video/BVtest');
  if (loadCore) await page.addScriptTag({path:path.join(extension, 'cache-core.js')});
  return { page, network };
}
test('full multi-chunk download, retry, local fetch/XHR ranges and abort', async () => {
  const {page,network}=await setup(large);
  network.failures=1;
  const result=await page.evaluate(async url=>{
    const c=window.__BILI_PAGE_CACHE_CORE__;
    const events=[];
    const blob=await c.download({url},new AbortController().signal,(loaded,total)=>events.push({loaded,total}));
    window.testEntries=new Map([[c.key(url),blob]]);
    c.install({entries:window.testEntries,observe(){},hit(){},metadata(){}});
    return {size:blob.size,last:events.at(-1)};
  },mediaUrl);
  assert.equal(result.size,large.length);
  assert.equal(result.last.loaded,large.length);
  assert.ok(network.count>=4);
  network.offline=true;
  const reads=await page.evaluate(async url=>{
    const res=await fetch(url.replace('test.', 'backup.')+'?renewed=1',{headers:{Range:'bytes=8388605-8388620'}});
    const f={status:res.status,range:res.headers.get('Content-Range'),bytes:[...new Uint8Array(await res.arrayBuffer())]};
    const x=await new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest(); xhr.open('GET',url); xhr.responseType='arraybuffer';xhr.setRequestHeader('Range','bytes=250-265');
      xhr.onerror=reject; xhr.onload=()=>resolve({status:xhr.status,range:xhr.getResponseHeader('Content-Range'),bytes:[...new Uint8Array(xhr.response)],url:xhr.responseURL});xhr.send();
    });
    const suffix=await fetch(url,{headers:{Range:'bytes=-10'}});
    const invalid=await fetch(url,{headers:{Range:'bytes=999999999-'}});
    const ac=new AbortController();ac.abort();let aborted=false;try{await fetch(url,{signal:ac.signal})}catch(e){aborted=e.name==='AbortError'}
    return {f,x,suffix:[...new Uint8Array(await suffix.arrayBuffer())],invalid:invalid.status,aborted};
  },mediaUrl);
  assert.equal(reads.f.status,206);assert.equal(reads.x.status,206);
  assert.deepEqual(reads.f.bytes,[...large.subarray(8388605,8388621)]);
  assert.deepEqual(reads.x.bytes,[...large.subarray(250,266)]);
  assert.equal(reads.x.url,mediaUrl);assert.deepEqual(reads.suffix,[...large.subarray(-10)]);
  assert.equal(reads.invalid,416);assert.equal(reads.aborted,true);
  await page.close();
});

test('parallel ranges finish out of order but assemble byte-exact data; single mode stays serial', async () => {
  const expectedHash = require('node:crypto').createHash('sha256').update(large).digest('hex');
  for (const concurrency of [1, 4, 8]) {
    const { page, network } = await setup(large);
    network.delay = start => start === 256 * 1024 ? 300 : start ? 60 : 0;
    const result = await page.evaluate(async ({ url, concurrency }) => {
      const progress = [];
      const data = await window.__BILI_PAGE_CACHE_CORE__.download({ url }, new AbortController().signal, (loaded, total) => progress.push({ loaded, total }), { concurrency });
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await data.arrayBuffer()))].map(n => n.toString(16).padStart(2, '0')).join('');
      return { hash, validProgress: progress.every(p => p.loaded <= p.total), last: progress.at(-1) };
    }, { url: mediaUrl, concurrency });
    assert.equal(result.hash, expectedHash, 'Out-of-order chunks must reconstruct the entire original file');
    assert.equal(result.validProgress, true);
    assert.equal(result.last.loaded, large.length);
    assert.ok(network.maxActive <= concurrency);
    if (concurrency === 1) assert.equal(network.maxActive, 1);
    else {
      assert.ok(network.maxActive >= 4, 'Several media ranges must be in flight together');
      assert.notEqual(network.completed[1], 256 * 1024, 'Delayed first worker must finish after another worker');
    }
    await page.close();
  }
});

test('a server that ignores Range is downloaded once without parallel duplication', async () => {
  const { page, network } = await setup(large);
  network.ignoreRange = true;
  const size = await page.evaluate(async url => (await window.__BILI_PAGE_CACHE_CORE__.download({ url }, new AbortController().signal, () => {}, { concurrency: 8 })).size, mediaUrl);
  assert.equal(size, large.length);
  assert.equal(network.count, 1);
  await page.close();
});

test('automatic CDN selection chooses the faster mirror and can be disabled', async () => {
  const backup = mediaUrl.replace('test.', 'fast.');
  for (const autoSource of [true, false]) {
    const { page, network } = await setup(large);
    network.delay = (start, host) => host.startsWith('test.') ? 180 : 10;
    const result = await page.evaluate(async ({ url, backup, autoSource }) => {
      const sources = [];
      const blob = await window.__BILI_PAGE_CACHE_CORE__.download({ url, backups: [backup, backup.replace('/123/123-', '/999/999-'), 'https://other.example/video.mp4'] }, new AbortController().signal, () => {}, { autoSource, onSource: source => sources.push(source) });
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(n => n.toString(16).padStart(2, '0')).join('');
      return { sources, hash };
    }, { url: mediaUrl, backup, autoSource });
    assert.equal(result.hash, require('node:crypto').createHash('sha256').update(large).digest('hex'));
    if (autoSource) {
      assert.equal(result.sources.find(s => s.phase === 'selected').host, 'fast.bilivideo.com');
      assert.ok(network.requests.filter(r => r.start > 0).every(r => r.host === 'fast.bilivideo.com'));
      assert.deepEqual([...network.urls].sort(), [mediaUrl, backup].sort(), 'Only mirrors of the same approved media path may be probed');
    } else assert.deepEqual([...network.urls], [mediaUrl], 'Disabling automatic selection must make no probe requests');
    await page.close();
  }
});

test('slow source is re-evaluated without downloading committed chunks again', async () => {
  const data = Buffer.concat([large, large]);
  const { page, network } = await setup(data);
  await page.evaluate(() => {
    window.clockOffset = 0;
    const now = performance.now.bind(performance);
    performance.now = () => now() + window.clockOffset;
  });
  let degraded = false;
  network.beforeResponse = async start => {
    if (start > 0 && !degraded) { degraded = true; await page.evaluate(() => { window.clockOffset = 65000; }); }
  };
  network.delay = (start, host) => host.startsWith('test.') ? degraded ? 220 : 10 : degraded ? 10 : 220;
  const result = await page.evaluate(async url => {
    const sources = [];
    const blob = await window.__BILI_PAGE_CACHE_CORE__.download({ url, backups: [url.replace('test.', 'backup.')] }, new AbortController().signal, () => {}, { concurrency: 1, onSource: source => sources.push(source) });
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(n => n.toString(16).padStart(2, '0')).join('');
    return { sources, hash };
  }, mediaUrl);
  assert.equal(result.hash, require('node:crypto').createHash('sha256').update(data).digest('hex'));
  assert.deepEqual(result.sources.filter(s => s.phase === 'selected').map(s => s.host), ['test.bilivideo.com', 'backup.bilivideo.com']);
  const bulk = network.requests.filter(r => r.start > 0);
  assert.equal(new Set(bulk.map(r => r.start)).size, bulk.length, 'Committed chunks must not be requested again');
  assert.ok(bulk.slice(1).every(r => r.host === 'backup.bilivideo.com'));
  await page.close();
});

test('cancel during automatic probing aborts all probes and never starts a full download', async () => {
  const { page } = await setup(fixture, false);
  await page.evaluate(() => {
    window.probes = { active: 0, requests: 0 };
    window.fetch = async (url, options) => {
      window.probes.requests++;
      return new Response(new ReadableStream({ start(controller) {
        window.probes.active++;
        controller.enqueue(new Uint8Array(1));
        options.signal.addEventListener('abort', () => { window.probes.active--; controller.error(options.signal.reason); }, { once: true });
      } }), { status: 206, headers: { 'Content-Range': 'bytes 0-262143/10000000' } });
    };
  });
  await page.addScriptTag({ path: path.join(extension, 'cache-core.js') });
  await page.evaluate(url => {
    window.cancelProbe = new AbortController();
    window.probeOutcome = window.__BILI_PAGE_CACHE_CORE__.download({ url, backups: ['two.', 'three.', 'four.'].map(host => url.replace('test.', host)) }, window.cancelProbe.signal, () => {}).then(() => 'unexpected success', error => error.name);
  }, mediaUrl);
  await page.waitForFunction(() => window.probes.active === 2);
  const result = await page.evaluate(async () => { window.cancelProbe.abort(); return { name: await window.probeOutcome, ...window.probes }; });
  assert.deepEqual(result, { name: 'AbortError', active: 0, requests: 2 });
  await page.close();
});

test('cancel aborts every active parallel stream and schedules no more chunks', async () => {
  const { page } = await setup(fixture, false);
  await page.evaluate(() => {
    window.streamTest = { active: 0, aborted: 0, requests: 0 };
    window.fetch = async (url, options) => {
      const start = Number(/bytes=(\d+)-/.exec(options.headers.Range)[1]);
      const size = start ? 4 * 1024 ** 2 : 256 * 1024;
      window.streamTest.requests++;
      const body = new ReadableStream({ start(controller) {
        if (!start) { controller.enqueue(new Uint8Array(size)); controller.close(); return; }
        window.streamTest.active++;
        controller.enqueue(new Uint8Array(100));
        options.signal.addEventListener('abort', () => {
          window.streamTest.active--; window.streamTest.aborted++;
          controller.error(options.signal.reason);
        }, { once: true });
      } });
      return new Response(body, { status: 206, headers: { 'Content-Range': `bytes ${start}-${start + size - 1}/${32 * 1024 ** 2}`, 'Content-Type': 'video/mp4' } });
    };
  });
  await page.addScriptTag({ path: path.join(extension, 'cache-core.js') });
  await page.evaluate(url => {
    window.abortDownload = new AbortController();
    window.cancelOutcome = window.__BILI_PAGE_CACHE_CORE__.download({ url }, window.abortDownload.signal, () => {}, { concurrency: 4 }).then(() => 'unexpected success', e => e.name);
  }, mediaUrl);
  await page.waitForFunction(() => window.streamTest.active === 4);
  const result = await page.evaluate(async () => {
    window.abortDownload.abort();
    const name = await window.cancelOutcome;
    return { name, ...window.streamTest };
  });
  assert.deepEqual(result, { name: 'AbortError', active: 0, aborted: 4, requests: 5 });
  await page.close();
});
test('page cache completes, seeks without network, clears and releases on navigation', async () => {
  const {page,network}=await setup();
  await page.evaluate(url=>{
    const v=document.querySelector('video');v.src=url;
    // Metadata/key objects must not veto a user-initiated cache request.
    Object.defineProperty(v,'mediaKeys',{configurable:true,value:{}});
    window.__playinfo__={data:{quality:80,is_drm:true,is_preview:false,durl:[{url}],support_formats:[{quality:80,description:'1080P'}]}};
    window.player={getQuality:()=>({realQ:80}),getManifest:()=>({cid:123}),mediaElement:()=>v};
    window.chrome={runtime:{onMessage:{addListener(){},removeListener(){}}}};
    window.addEventListener('message',e=>{if(e.data?.source==='bili-page-cache:state')window.lastCacheState=e.data.state});
  },mediaUrl);
  await page.addScriptTag({path:path.join(extension,'page.js')});
  await page.addScriptTag({path:path.join(extension,'panel.js')});
  await page.waitForFunction(()=>document.querySelector('video').readyState>=1);
  await page.locator('#bili-page-cache-panel').getByRole('button',{name:'Cache video'}).click();
  await page.waitForFunction(()=>window.lastCacheState?.phase==='ready');
  await page.evaluate(()=>{window.player.getQuality=()=>({realQ:64})});
  await page.waitForFunction(()=>window.lastCacheState?.phase==='mismatch');
  assert.equal(await page.evaluate(()=>window.lastCacheState.files),1,'quality fallback must retain downloaded data');
  await page.evaluate(()=>{window.player.getQuality=()=>({realQ:80})});
  await page.waitForFunction(()=>window.lastCacheState?.phase==='ready');
  network.offline=true;const count=network.count;
  const seek=await page.evaluate(async()=>{
    const v=document.querySelector('video');v.muted=true;
    const times=[];
    for(const time of [10,2,8,0.5]) {
      const start=performance.now();
      await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('seek timeout')),4000);v.addEventListener('seeked',()=>{clearTimeout(t);resolve()},{once:true});v.currentTime=time});
      times.push({target:time,actual:v.currentTime,ms:Math.round(performance.now()-start)});
    }
    return {times,src:v.currentSrc,paused:v.paused};
  });
  assert.match(seek.src,/^blob:/);assert.ok(seek.paused);
  for (const t of seek.times) assert.ok(Math.abs(t.actual-t.target)<0.1, `seek must reach ${t.target}, got ${t.actual}`);
  assert.equal(network.count,count,'completed video seeks must not fetch network data');
  console.log('Offline seek timings:',JSON.stringify(seek.times));
  await page.locator('#bili-page-cache-panel').getByRole('button',{name:'Clear cache',exact:true}).click();
  await page.waitForFunction(()=>window.lastCacheState?.phase==='idle'&&window.lastCacheState.files===0);
  await page.goto('https://www.bilibili.com/video/BVother');
  assert.equal(await page.evaluate(()=>typeof window.__BILI_PAGE_CACHE_RUNNING__),'undefined');
  await page.close();
});
test('manual activation: inactive by default, close restores hooks, SPA navigation disables', async () => {
  const manifest=JSON.parse(fs.readFileSync(path.join(extension,'manifest.json'),'utf8'));
  assert.equal(manifest.content_scripts,undefined);
  assert.equal(manifest.host_permissions,undefined);
  assert.deepEqual(manifest.permissions,['activeTab','scripting','alarms']);
  const {page}=await setup(fixture,false);
  await page.evaluate(()=>{
    window.beforeCache={fetch:window.fetch,open:XMLHttpRequest.prototype.open,send:XMLHttpRequest.prototype.send,set:XMLHttpRequest.prototype.setRequestHeader};
    window.chrome={runtime:{onMessage:{addListener(){},removeListener(){}}}};
    window.liveIntervals=new Set();
    const set=window.setInterval,clear=window.clearInterval;
    window.setInterval=(...args)=>{const id=set(...args);window.liveIntervals.add(id);return id};
    window.clearInterval=id=>{window.liveIntervals.delete(id);clear(id)};
  });
  assert.equal(await page.evaluate(()=>typeof window.__BILI_PAGE_CACHE_RUNNING__),'undefined');
  assert.equal(await page.locator('#bili-page-cache-panel').count(),0);
  const activate=async()=>{for(const file of ['cache-core.js','page.js','panel.js'])await page.addScriptTag({path:path.join(extension,file)})};
  await activate();await activate();
  assert.equal(await page.locator('#bili-page-cache-panel').count(),1);
  assert.equal(await page.evaluate(()=>window.liveIntervals.size),1);
  await page.locator('#bili-page-cache-panel').getByRole('button',{name:'Close cache'}).click();
  await page.waitForFunction(()=>!window.__BILI_PAGE_CACHE_RUNNING__&&!document.querySelector('#bili-page-cache-panel'));
  assert.equal(await page.evaluate(()=>window.fetch===window.beforeCache.fetch&&XMLHttpRequest.prototype.open===window.beforeCache.open&&XMLHttpRequest.prototype.send===window.beforeCache.send&&XMLHttpRequest.prototype.setRequestHeader===window.beforeCache.set),true);
  assert.equal(await page.evaluate(()=>window.liveIntervals.size),0);
  assert.equal(await page.evaluate(()=>typeof window.__BILI_PAGE_CACHE_CORE__),'undefined');
  await activate();
  await page.evaluate(()=>history.pushState({},'', '/video/BVnext'));
  await page.waitForFunction(()=>!window.__BILI_PAGE_CACHE_RUNNING__&&!document.querySelector('#bili-page-cache-panel'));
  assert.equal(await page.evaluate(()=>window.fetch===window.beforeCache.fetch&&window.liveIntervals.size===0),true);
  await page.reload();
  assert.equal(await page.locator('#bili-page-cache-panel').count(),0);
  await page.close();
});

test('late activation reads current kernel tracks without playinfo or request history', async () => {
  const { page, network } = await setup();
  const videoUrl = mediaUrl.replace('.mp4', '.m4s');
  const audioUrl = videoUrl.replace('-1-80.', '-1-30280.');
  await page.evaluate(({ videoUrl, audioUrl }) => {
    window.chrome = { runtime: { onMessage: { addListener() {}, removeListener() {} } } };
    const v = document.querySelector('video');
    window.player = {
      getQuality: () => ({ realQ: 80 }), getManifest: () => ({ cid: 123 }), mediaElement: () => v,
      __core: () => ({
        getMpd: () => ({ video: [{ id: 80, base_url: videoUrl.replace('-1-80.', '-1-OLD.') }], audio: [{ base_url: audioUrl.replace('-1-30280.', '-1-OLD_AUDIO.') }] }),
        getCurrentPlayURLFor: type => type === 'video' ? videoUrl : audioUrl
      })
    };
    window.addEventListener('message', e => { if (e.data?.source === 'bili-page-cache:state') window.lastCacheState = e.data.state; });
  }, { videoUrl, audioUrl });
  await page.addScriptTag({ path: path.join(extension, 'page.js') });
  await page.addScriptTag({ path: path.join(extension, 'panel.js') });
  assert.equal(network.count, 0, 'Enabling must not fetch any media');
  await page.locator('#bili-page-cache-panel').getByRole('button', { name: 'Cache video' }).click();
  await page.waitForFunction(() => window.lastCacheState?.phase === 'ready');
  assert.equal(await page.evaluate(() => window.lastCacheState.files), 2);
  assert.deepEqual([...network.urls].sort(), [videoUrl, audioUrl].sort(), 'Only the selected video and audio are downloaded');
  network.offline = true;
  const count = network.count;
  const lengths = await page.evaluate(async urls => Promise.all(urls.map(async url => (await (await fetch(url)).arrayBuffer()).byteLength)), [videoUrl, audioUrl]);
  assert.deepEqual(lengths, [fixture.length, fixture.length]);
  assert.equal(network.count, count, 'Both current track URLs are served locally');
  await page.locator('#bili-page-cache-panel').getByRole('button', { name: 'Close cache' }).click();
  await page.waitForFunction(() => !window.__BILI_PAGE_CACHE_RUNNING__);
  await page.close();
});

test('late activation reuses the observed playurl request and resolves nested metadata', async () => {
  const { page } = await setup();
  const api = 'https://api.bilibili.com/pgc/player/web/v2/playurl?cid=123&ep_id=456';
  let apiCalls = 0;
  await page.route('https://api.bilibili.com/**', async route => {
    apiCalls++;
    await route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': 'https://www.bilibili.com', 'Access-Control-Allow-Credentials': 'true' }, body: JSON.stringify({ code: 0, data: { playurl_info: { playurl: { quality: 80, dash: { video: [{ id: 80, base_url: mediaUrl }], audio: [] } } } } }) });
  });
  await page.evaluate(async ({ api, mediaUrl }) => {
    await (await fetch(api, { credentials: 'include' })).json();
    await (await fetch(mediaUrl, { headers: { Range: 'bytes=0-100' } })).arrayBuffer();
    window.player = { getQuality: () => ({ realQ: 80 }), getManifest: () => ({ cid: 123 }) };
    window.chrome = { runtime: { onMessage: { addListener() {}, removeListener() {} } } };
    window.addEventListener('message', e => { if (e.data?.source === 'bili-page-cache:state') window.lastCacheState = e.data.state; });
  }, { api, mediaUrl });
  await page.waitForFunction(() => performance.getEntriesByType('resource').some(e => e.name.includes('/playurl?')));
  await page.addScriptTag({ path: path.join(extension, 'page.js') });
  await page.addScriptTag({ path: path.join(extension, 'panel.js') });
  assert.equal(apiCalls, 1, 'Enabling alone must not replay any request');
  await page.locator('#bili-page-cache-panel').getByRole('button', { name: 'Cache video' }).click();
  await page.waitForFunction(() => ['ready', 'error', 'mismatch'].includes(window.lastCacheState?.phase));
  assert.equal(await page.evaluate(() => window.lastCacheState.phase), 'ready', JSON.stringify(await page.evaluate(() => window.lastCacheState)));
  assert.equal(apiCalls, 2);
  assert.equal(await page.evaluate(() => window.lastCacheState.files), 1);
  await page.close();
});
test('installed extension: toolbar permission and popup enable only the chosen tab', async () => {
  const context=await chromium.launchPersistentContext('',{
    channel:'msedge',headless:true,args:['--mute-audio','--enable-unsafe-extension-debugging'],ignoreDefaultArgs:['--disable-extensions']
  });
  try {
    const session=await context.browser().newBrowserCDPSession();
    const {id}=await session.send('Extensions.loadUnpacked',{path:extension});
    for (const videoPath of ['/video/BVactivation', '/bangumi/play/ss123?t=30', '/bangumi/play/ep456']) {
    const page=await context.newPage();
    await page.route('https://www.bilibili.com/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><body>Activation fixture</body>'}));
    await page.goto(`https://www.bilibili.com${videoPath}`);
    await page.evaluate(()=>{window.originalFetch=window.fetch});
    assert.equal(await page.evaluate(()=>typeof window.__BILI_PAGE_CACHE_CORE__),'undefined');
    const {targetInfos}=await session.send('Target.getTargets',{filter:[{type:'tab'}]});
    await session.send('Extensions.triggerAction',{id,targetId:targetInfos.find(t=>t.url===page.url()).targetId});
    // Headless Edge has no visible toolbar popup: load its real extension page
    // after the toolbar action has granted activeTab, and run its actual handler.
    const popup=await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    if (videoPath.includes('/bangumi/')) {
      await popup.evaluate(() => {
        const query = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = async options => (await query(options)).map(tab => {
          delete tab.url;
          delete tab.pendingUrl;
          return tab;
        });
      });
    }
    await page.bringToFront();
    await popup.evaluate(()=>document.querySelector('#show').click());
    await page.waitForSelector('#bili-page-cache-panel',{timeout:10000});
    assert.equal(await page.evaluate(()=>window.fetch===window.originalFetch),false);
    // Updating the installed extension must not unload the page's cache core.
    await page.evaluate(() => { window.coreBeforeReload = window.__BILI_PAGE_CACHE_CORE__; });
    await session.send('Extensions.loadUnpacked', { path: extension });
    assert.equal(await page.evaluate(() => window.coreBeforeReload === window.__BILI_PAGE_CACHE_CORE__ && !!window.__BILI_PAGE_CACHE_RUNNING__), true);
    await page.locator('#bili-page-cache-panel').getByRole('button',{name:'Close cache'}).click();
    await page.waitForFunction(()=>!window.__BILI_PAGE_CACHE_RUNNING__);
    assert.equal(await page.evaluate(()=>window.fetch===window.originalFetch),true);
    await page.reload();
    assert.equal(await page.locator('#bili-page-cache-panel').count(),0);
    assert.equal(await page.evaluate(()=>typeof window.__BILI_PAGE_CACHE_CORE__),'undefined');
    await page.close();
    }
  } finally { await context.close(); }
});

test('popup distinguishes missing tab, unreadable page and unsupported URL without cache injection', async () => {
  const vm = require('node:vm');
  for (const scenario of ['stale-manifest', 'no-tab', 'no-permission', 'unsupported']) {
    const button = {}, status = {}, calls = [];
    const sandbox = {
      URL,
      document: { querySelector: selector => selector === '#show' ? button : status },
      chrome: {
        runtime: { getManifest: () => ({ permissions: scenario === 'stale-manifest' ? [] : ['activeTab', 'scripting'] }) },
        tabs: { query: async options => {
          assert.deepEqual(JSON.parse(JSON.stringify(options)), { active: true, lastFocusedWindow: true });
          return scenario === 'no-tab' ? [] : [{ id: 3 }];
        } },
        scripting: { executeScript: async options => {
          calls.push(options);
          if (scenario === 'no-permission') throw new Error('Cannot access contents of url');
          return [{ documentId: 'test-document', result: 'https://www.bilibili.com/' }];
        } }
      },
      window: { close() { assert.fail('Failed activation must keep the error visible'); } }
    };
    vm.runInNewContext(fs.readFileSync(path.join(extension, 'popup.js'), 'utf8'), sandbox);
    await button.onclick();
    assert.equal(button.disabled, false);
    assert.ok(calls.every(call => !call.files), 'Must not inject cache code into unreadable/unsupported pages');
    assert.match(status.textContent, scenario === 'stale-manifest' ? /permissions are out of date/ : scenario === 'no-tab' ? /No active tab found/ : scenario === 'no-permission' ? /Cannot access this tab/ : /Open a Bilibili video/);
  }
});

test('partial cache serves only fully covered fetch/XHR ranges and sends gaps to the network', async () => {
  const { page, network } = await setup(large);
  await page.evaluate(async url => {
    const c = window.__BILI_PAGE_CACHE_CORE__, cache = c.createPartialCache(18 * 1024 ** 2 + 39);
    const bytes = (start, end) => new Blob([Uint8Array.from({ length: end - start }, (_, i) => (start + i) % 251)]);
    cache.add(128, bytes(128, 256)); cache.add(0, bytes(0, 128)); cache.add(512, bytes(512, 768));
    window.partialCache = cache; window.partialEntries = new Map([[c.key(url), cache]]); window.partialHits = 0;
    c.install({ entries: window.partialEntries, observe() {}, metadata() {}, hit() { window.partialHits++; } });
  }, mediaUrl);
  const result = await page.evaluate(async url => {
    const fetchRange = async range => { const r = await fetch(url, { headers: { Range: range } }); return { status: r.status, range: r.headers.get('Content-Range'), bytes: [...new Uint8Array(await r.arrayBuffer())] }; };
    const covered = await fetchRange('bytes=100-150');
    const gap = await fetchRange('bytes=240-520');
    const xhr = await new Promise((resolve, reject) => { const x = new XMLHttpRequest(); x.open('GET', url); x.responseType = 'arraybuffer'; x.setRequestHeader('Range', 'bytes=100-150'); x.onerror = reject; x.onload = () => resolve({ status: x.status, bytes: [...new Uint8Array(x.response)] }); x.send(); });
    const xhrGap = await new Promise((resolve, reject) => { const x = new XMLHttpRequest(); x.open('GET', url); x.responseType = 'arraybuffer'; x.setRequestHeader('Range', 'bytes=250-270'); x.onerror = reject; x.onload = () => resolve([...new Uint8Array(x.response)]); x.send(); });
    return { covered, gap, xhr, xhrGap, hits: window.partialHits };
  }, mediaUrl);
  assert.equal(result.covered.status, 206);
  assert.deepEqual(result.covered.bytes, [...large.subarray(100, 151)]);
  assert.deepEqual(result.xhr.bytes, result.covered.bytes);
  assert.deepEqual(result.gap.bytes, [...large.subarray(240, 521)]);
  assert.deepEqual(result.xhrGap, [...large.subarray(250, 271)]);
  assert.equal(network.count, 2); assert.equal(result.hits, 2);
  await page.evaluate(() => { window.partialCache.clear(); window.partialEntries.clear(); });
  await page.evaluate(url => fetch(url, { headers: { Range: 'bytes=100-150' } }), mediaUrl);
  assert.equal(network.count, 3, 'Cleared partial data must never be reused');
  await page.close();
});

async function installDashController(page, url, persistent = false) {
  await page.evaluate(url => {
    const v = document.querySelector('video');
    window.player = { getQuality: () => ({ realQ: 80 }), getManifest: () => ({ cid: 123 }), mediaElement: () => v,
      __core: () => ({ getMpd: () => ({ video: [{ id: 80, base_url: url }], audio: [] }), getCurrentPlayURLFor: type => type === 'video' ? url : '' }) };
    window.chrome = { runtime: { onMessage: { addListener() {}, removeListener() {} } } };
    window.addEventListener('message', e => { if (e.data?.source === 'bili-page-cache:state') window.lastCacheState = e.data.state; });
  }, url);
  if (persistent) { await page.addScriptTag({ path: path.join(extension, 'cache-db.js') }); await page.addScriptTag({ path: path.join(extension, 'storage.js') }); }
  await page.addScriptTag({ path: path.join(extension, 'page.js') });
  await page.addScriptTag({ path: path.join(extension, 'panel.js') });
  await page.waitForFunction(() => window.lastCacheState?.phase === 'idle');
}

test('MSE plays committed media while full download is incomplete, then clear releases it', async () => {
  const fragmented = require('node:child_process').execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(__dirname, 'fixture.mp4'), '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'], { maxBuffer: 16 * 1024 ** 2 });
  let offset = 0, firstMediaEnd = 0;
  while (offset < fragmented.length) { const size = fragmented.readUInt32BE(offset), type = fragmented.toString('ascii', offset + 4, offset + 8); offset += size; if (type === 'mdat') { firstMediaEnd = offset; break; } }
  assert.ok(firstMediaEnd > 0 && firstMediaEnd < 256 * 1024);
  const avcc = fragmented.indexOf(Buffer.from('avcC'));
  const codec = 'avc1.' + fragmented.subarray(avcc + 5, avcc + 8).toString('hex');
  const { page, network } = await setup(fragmented);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  network.beforeResponse = async start => { if (start >= 256 * 1024) await gate; };
  try {
    await installDashController(page, mediaUrl);
    await page.locator('#bili-page-cache-panel').getByRole('button', { name: 'Cache video' }).click();
    await page.waitForFunction(() => window.lastCacheState?.cachedBytes === 256 * 1024);
    assert.equal(await page.evaluate(() => window.lastCacheState.phase), 'loading');
    const count = network.count;
    const playable = await page.evaluate(async ({ url, firstMediaEnd, codec }) => {
      const v = document.querySelector('video'); v.muted = true;
      const ms = new MediaSource(); v.src = URL.createObjectURL(ms);
      await new Promise(resolve => ms.addEventListener('sourceopen', resolve, { once: true }));
      const response = await fetch(url, { headers: { Range: `bytes=0-${firstMediaEnd - 1}` } });
      const bytes = await response.arrayBuffer();
      const source = ms.addSourceBuffer(`video/mp4; codecs="${codec},mp4a.40.2"`);
      await new Promise((resolve, reject) => { source.addEventListener('updateend', resolve, { once: true }); source.addEventListener('error', reject, { once: true }); source.appendBuffer(bytes); });
      v.currentTime = 0.1;
      await v.play();
      await new Promise(resolve => setTimeout(resolve, 150));
      v.pause();
      return { time: v.currentTime, buffered: v.buffered.length, localHits: window.lastCacheState.hits, phase: window.lastCacheState.phase };
    }, { url: mediaUrl, firstMediaEnd, codec });
    assert.ok(playable.time > 0.1); assert.ok(playable.buffered > 0);
    assert.equal(playable.phase, 'loading');
    await page.evaluate(() => window.postMessage({ source: 'bili-page-cache:command', command: 'status' }, location.origin));
    await page.waitForFunction(() => window.lastCacheState.hits >= 1);
    assert.equal(network.count, count, 'Playing cached MSE data must not fetch the media server');
    await page.locator('#bili-page-cache-panel').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForFunction(() => window.lastCacheState?.phase === 'idle' && window.lastCacheState.cachedBytes === 0);
  } finally { release(); await page.close(); }
});

test('explicit seven-day pin survives reload, restores without media traffic and can be deleted', async () => {
  const { page, network } = await setup();
  await installDashController(page, mediaUrl, true);
  assert.equal(await page.evaluate(async () => (await indexedDB.databases()).some(db => db.name === 'bili-page-cache-pinned-v1')), false);
  await page.locator('#bili-page-cache-panel').getByRole('button', { name: 'Cache video' }).click();
  await page.waitForFunction(() => window.lastCacheState?.phase === 'ready');
  assert.equal(await page.evaluate(async () => (await indexedDB.databases()).some(db => db.name === 'bili-page-cache-pinned-v1')), false, 'Ordinary full cache must remain temporary');
  await page.locator('#bili-page-cache-panel').getByRole('button', { name: 'Save for 7 days' }).click();
  await page.waitForFunction(() => window.lastCacheState?.pinnedUntil > Date.now() && !window.lastCacheState.saving);
  const expiry = await page.evaluate(() => window.lastCacheState.pinnedUntil);
  assert.ok(Math.abs(expiry - Date.now() - 7 * 86400000) < 10000);
  const count = network.count;
  network.offline = true;
  await page.reload();
  assert.equal(await page.locator('#bili-page-cache-panel').count(), 0);
  await page.addScriptTag({ path: path.join(extension, 'cache-core.js') });
  // Unlike a fresh activation, restoration may go straight to ready.
  await page.evaluate(url => {
    const v = document.querySelector('video');
    window.player = { getQuality: () => ({ realQ: 80 }), getManifest: () => ({ cid: 123 }), mediaElement: () => v, __core: () => ({ getMpd: () => ({ video: [{ id: 80, base_url: url }], audio: [] }), getCurrentPlayURLFor: type => type === 'video' ? url : '' }) };
    window.chrome = { runtime: { onMessage: { addListener() {}, removeListener() {} } } };
    window.addEventListener('message', e => { if (e.data?.source === 'bili-page-cache:state') window.lastCacheState = e.data.state; });
  }, mediaUrl);
  for (const file of ['cache-db.js', 'storage.js', 'page.js', 'panel.js']) await page.addScriptTag({ path: path.join(extension, file) });
  await page.waitForFunction(() => window.lastCacheState?.phase === 'ready');
  assert.equal(await page.evaluate(() => window.lastCacheState.pinnedUntil), expiry);
  const size = await page.evaluate(async url => (await (await fetch(url)).arrayBuffer()).byteLength, mediaUrl);
  assert.equal(size, fixture.length); assert.equal(network.count, count);
  await page.locator('#bili-page-cache-panel').getByRole('button', { name: 'Delete saved', exact: true }).click();
  await page.waitForFunction(() => window.lastCacheState?.pinnedUntil === 0 && !window.lastCacheState.saving);
  assert.equal(await page.evaluate(() => window.lastCacheState.phase), 'ready', 'Removing persisted data must preserve the current temporary cache');
  assert.equal(await page.evaluate(async url => window.__BILI_PAGE_CACHE_STORE__.read([window.__BILI_PAGE_CACHE_CORE__.key(url)]), mediaUrl), null);
  await page.close();
});

test('expired pinned records are unavailable and removed; failed save remains atomic', async () => {
  const { page } = await setup();
  await page.addScriptTag({ path: path.join(extension, 'cache-db.js') });
  await page.addScriptTag({ path: path.join(extension, 'storage.js') });
  const result = await page.evaluate(async () => {
    const store = window.__BILI_PAGE_CACHE_STORE__;
    const saved = await store.save({ keys: ['test-key'], blobs: [new Blob(['test-data'])] });
    const originalNow = Date.now;
    Date.now = () => saved.expiresAt + 1;
    const expired = await store.read(['test-key']);
    Date.now = originalNow;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) { if (this.name === 'catalog') throw new DOMException('Quota exhausted', 'QuotaExceededError'); return put.apply(this, args); };
    let failure;
    try { await store.save({ keys: ['failed-key'], blobs: [new Blob(['new-data'])] }); } catch (error) { failure = error.name; }
    finally { IDBObjectStore.prototype.put = put; }
    const absent = await store.read(['failed-key']);
    return { expired, failure, absent };
  });
  assert.deepEqual(result, { expired: null, failure: 'QuotaExceededError', absent: null });
  await page.close();
});

test('legacy completed cache gains a pin button without losing its local data', async () => {
  const { page, network } = await setup();
  await page.evaluate(url => {
    const core = window.__BILI_PAGE_CACHE_CORE__;
    const blob = new Blob(['already cached']);
    core.install({ entries: new Map([[core.key(url), blob]]), observe() {}, metadata() {}, hit() {} });
    delete core.createPartialCache;
    window.__BILI_PAGE_CACHE_RUNNING__ = true;
    window.player = { __core: () => ({ getCurrentPlayURLFor: type => type === 'video' ? url : '' }) };
    window.chrome = { runtime: { onMessage: { addListener() {}, removeListener() {} } } };
    window.addEventListener('message', e => {
      if (e.data?.source === 'bili-page-cache:command' && e.data.command === 'status') window.postMessage({ source: 'bili-page-cache:state', state: { phase: 'ready', files: 1, loaded: blob.size, total: blob.size, label: 'test' } }, location.origin);
      if (e.data?.source === 'bili-page-cache:pin-state') window.pinState = e.data.state;
    });
  }, mediaUrl);
  await page.addScriptTag({ path: path.join(extension, 'cache-db.js') });
  await page.addScriptTag({ path: path.join(extension, 'storage.js') });
  await page.addScriptTag({ path: path.join(extension, 'panel.js') });
  await page.locator('#bili-page-cache-panel').getByRole('button', { name: 'Save for 7 days' }).click();
  await page.waitForFunction(() => window.pinState?.pinnedUntil > Date.now() && !window.pinState.saving);
  assert.equal(network.count, 0);
  assert.equal(await page.evaluate(async url => (await fetch(url)).text(), mediaUrl), 'already cached');
  assert.equal(await page.evaluate(async url => (await window.__BILI_PAGE_CACHE_STORE__.read([window.__BILI_PAGE_CACHE_CORE__.key(url)])).blobs[0].text(), mediaUrl), 'already cached');
  await page.close();
});

test('extension-owned storage survives the video tab; alarm cleans expiry and popup clears every copy', async () => {
  const context = await chromium.launchPersistentContext('', { channel: 'msedge', headless: true, args: ['--mute-audio', '--enable-unsafe-extension-debugging'], ignoreDefaultArgs: ['--disable-extensions'] });
  try {
    const session = await context.browser().newBrowserCDPSession();
    const { id } = await session.send('Extensions.loadUnpacked', { path: extension });
    const page = await context.newPage();
    await page.route('https://www.bilibili.com/**', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><body>Storage fixture</body>' }));
    await page.goto('https://www.bilibili.com/video/BVstorage');
    const { targetInfos } = await session.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    await session.send('Extensions.triggerAction', { id, targetId: targetInfos.find(t => t.url === page.url()).targetId });
    const popup = await context.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`);
    await page.bringToFront(); await popup.evaluate(() => document.querySelector('#show').click());
    await page.waitForSelector('#bili-page-cache-panel');
    const saved = await page.evaluate(async () => {
      const store = window.__BILI_PAGE_CACHE_STORE__;
      const data = new Uint8Array(2 * 1024 ** 2); data[0] = 23; data[data.length - 1] = 47;
      const saved = await store.save({ keys: ['one'], blobs: [new Blob([data])] });
      const record = await store.read(['one']); const bytes = new Uint8Array(await record.blobs[0].arrayBuffer());
      await store.save({ keys: ['one'], blobs: record.blobs });
      return { expiresAt: saved.expiresAt, length: bytes.length, first: bytes[0], last: bytes.at(-1), siteDatabases: (await indexedDB.databases()).map(db => db.name) };
    });
    assert.equal(saved.length, 2 * 1024 ** 2); assert.equal(saved.first, 23); assert.equal(saved.last, 47);
    assert.ok(!saved.siteDatabases.includes('bili-page-cache-pinned-v1'), 'Pinned data must not be left in Bilibili site storage');
    const manager = await context.newPage(); await manager.goto(`chrome-extension://${id}/popup.html`);
    assert.equal((await manager.evaluate(() => __BILI_PAGE_CACHE_DB__.stats())).count, 1);
    assert.equal(await manager.evaluate(async () => (await chrome.alarms.get('bili-cache-expiry')).periodInMinutes), 30);
    await page.close();
    await manager.evaluate(async () => {
      await new Promise((resolve, reject) => {
        const open = indexedDB.open('bili-page-cache-pinned-v1', 2);
        open.onsuccess = () => {
          const db = open.result, tx = db.transaction(['videos', 'catalog'], 'readwrite');
          for (const name of ['videos', 'catalog']) {
            const store = tx.objectStore(name), req = store.get('one');
            req.onsuccess = () => { req.result.expiresAt = Date.now() - 1000; store.put(req.result); };
          }
          tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); };
        };
      });
      await chrome.alarms.create('bili-cache-expiry', { when: Date.now() + 1000 });
    });
    const workerSession = await context.newCDPSession(manager);
    await workerSession.send('ServiceWorker.enable');
    await workerSession.send('ServiceWorker.stopAllWorkers');
    await manager.waitForFunction(async () => (await __BILI_PAGE_CACHE_DB__.stats()).count === 0, { timeout: 15000 });
    assert.equal(await manager.evaluate(() => __BILI_PAGE_CACHE_DB__.read(['one'])), null);
    await manager.evaluate(async () => {
      for (const key of ['two', 'three']) await __BILI_PAGE_CACHE_DB__.save({ keys: [key], blobs: [new Blob(['saved video'])] });
    });
    await manager.reload(); await manager.waitForFunction(() => !document.querySelector('#clear-all').disabled);
    await manager.locator('#clear-all').click();
    await manager.waitForFunction(() => document.querySelector('#storage-status').textContent.includes('0 bytes'));
    assert.equal((await manager.evaluate(() => __BILI_PAGE_CACHE_DB__.stats())).count, 0);
  } finally { await context.close(); }
});
