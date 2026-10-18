// Screenshot the basemap preview at a true iPhone viewport (390x844 @2x).
// `chrome --headless --window-size` can't go below ~500 px wide, so this
// drives Chrome over the DevTools protocol and sets the device metrics.
//
//   node tools/basemap_shot.mjs [midtown les bk wburg qns stg all ...]
//   node tools/basemap_shot.mjs --tiles midtown   OSM tiles over it at 50% (alignment; needs network)
//   node tools/basemap_shot.mjs --serve           just serve; open the printed URL in a browser
//   → app/test/out/basemap/<view>[_tiles].png
//
// Serves app/src/static on 127.0.0.1 (random port) plus tools/basemap_preview.html
// at /basemap_preview.html, so the preview uses the vendored Leaflet and the
// same data/basemap.json the app fetches. Works offline unless --tiles.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC = path.join(ROOT, 'app', 'src', 'static');
const PREVIEW = path.join(ROOT, 'tools', 'basemap_preview.html');
const OUT = path.join(ROOT, 'app', 'test', 'out', 'basemap');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const args = process.argv.slice(2);
const tiles = args.includes('--tiles'), serveOnly = args.includes('--serve');
const named = args.filter(a => !a.startsWith('--'));
const views = named.length ? named : ['midtown', 'les'];
const TYPES = {'.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png'};

// Minimal static server, confined to app/src/static (+ the preview page).
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = rel === '/basemap_preview.html' ? PREVIEW : path.join(STATIC, rel);
  if ((file !== PREVIEW && !file.startsWith(STATIC + path.sep)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {'content-type': TYPES[path.extname(file)] || 'application/octet-stream'});
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
if (serveOnly) {
  console.log(`serving ${base}/basemap_preview.html?v=midtown  (ctrl-c to stop)`);
  await new Promise(() => {});
}

// Launch Chrome and wait for its DevTools websocket.
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'basemap-shot-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-proxy-server', '--disable-gpu', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', `--user-data-dir=${prof}`, '--remote-debugging-port=0', 'about:blank'],
  {stdio: ['ignore', 'ignore', 'pipe']});
const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  chrome.stderr.on('data', d => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolve(m[1]);
  });
  chrome.on('exit', c => reject(new Error('chrome exited ' + c)));
  setTimeout(() => reject(new Error('chrome did not start')), 20000);
});

// Tiny CDP client over the built-in WebSocket.
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const pending = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const {resolve, reject} = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, {resolve, reject});
  ws.send(JSON.stringify({id, method, params, sessionId}));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failed = false;
try {
  const {targetId} = await send('Target.createTarget', {url: 'about:blank'});
  const {sessionId} = await send('Target.attachToTarget', {targetId, flatten: true});
  const s = (m, p) => send(m, p, sessionId);
  await s('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 2, mobile: true});
  fs.mkdirSync(OUT, {recursive: true});
  for (const v of views) {
    await s('Page.navigate', {url: `${base}/basemap_preview.html?v=${encodeURIComponent(v)}${tiles ? '&tiles=1' : ''}`});
    let state;
    for (let i = 0; i < 100 && !state; i++) {
      await sleep(150);
      state = (await s('Runtime.evaluate', {expression: 'window.__ready', returnByValue: true})).result.value;
    }
    await sleep(tiles ? 2500 : 400);  // let canvas paint (and tiles) settle
    const {data} = await s('Page.captureScreenshot', {format: 'png'});
    const file = path.join(OUT, `${v.replace(/[^\w-]/g, '_')}${tiles ? '_tiles' : ''}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`${state === true ? 'ok  ' : 'FAIL'} ${v} → ${path.relative(ROOT, file)}${state === true ? '' : ' (ready=' + state + ')'}`);
    if (state !== true) failed = true;
  }
} finally {
  ws.close();
  server.close();
  // Chrome keeps writing to its profile until it exits; wait before removing it.
  const exited = new Promise(r => chrome.once('exit', r));
  chrome.kill();
  await Promise.race([exited, sleep(5000)]);
  try { fs.rmSync(prof, {recursive: true, force: true, maxRetries: 5, retryDelay: 200}); } catch { /* temp dir; OS cleans up */ }
}
process.exit(failed ? 1 : 0);
