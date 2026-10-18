// Read Yelp business pages through a real Chrome window (Yelp refuses plain
// scripts on these pages). Chrome must be running with remote debugging:
//
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     --user-data-dir=<profile> --remote-debugging-port=9333 --no-first-run about:blank
//
//   node yelp_browser.mjs <port> <raw_dir> [--tabs 2] [--refresh] [--only alias,alias]
//
// For each place in <raw_dir>/collection.json it writes <raw_dir>/page/<alias>.json
// with the page's structured data, visible text, and photo ids from the food and
// inside photo tabs. Places already saved are skipped. If Yelp shows a challenge
// page the run stops and says so; nothing here tries to get past one.
import fs from 'node:fs';
import path from 'node:path';

const [port, raw, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
const TABS = +opt('--tabs', 2);
const refresh = rest.includes('--refresh');
const only = opt('--only', '') ? new Set(opt('--only', '').split(',')) : null;
const outDir = path.join(raw, 'page');
fs.mkdirSync(outDir, {recursive: true});
const places = JSON.parse(fs.readFileSync(path.join(raw, 'collection.json'), 'utf8')).places
  .filter(p => (!only || only.has(p.id)) && (refresh || !fs.existsSync(path.join(outDir, p.id + '.json'))));
console.log(`${places.length} place(s) to read with ${TABS} tab(s)`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const base = `http://127.0.0.1:${port}`;

class Tab {
  async open() {
    const t = await (await fetch(`${base}/json/new?about:blank`, {method: 'PUT'})).json();
    this.id = t.id;
    this.ws = new WebSocket(t.webSocketDebuggerUrl);
    this.n = 0; this.pend = new Map(); this.loaded = null;
    this.ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && this.pend.has(m.id)) { this.pend.get(m.id)(m); this.pend.delete(m.id); }
      if (m.method === 'Page.loadEventFired' && this.loaded) this.loaded();
    };
    await new Promise(r => this.ws.onopen = r);
    await this.send('Page.enable');
    return this;
  }
  send(method, params = {}) {
    return new Promise(r => { const i = ++this.n; this.pend.set(i, r); this.ws.send(JSON.stringify({id: i, method, params})); });
  }
  async go(url, settle = 2500) {
    const loaded = new Promise(r => { this.loaded = r; setTimeout(r, 20000); });
    await this.send('Page.navigate', {url});
    await loaded; this.loaded = null;
    await sleep(settle);
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  }
  async close() { try { this.ws.close(); await fetch(`${base}/json/close/${this.id}`); } catch {} }
}

const CHALLENGE = `(() => {
  const t = (document.title || '') + ' ' + (document.body ? document.body.innerText.slice(0, 600) : '');
  return /captcha|verify you are (a )?human|unusual activity|access denied|enable JS and disable/i.test(t)
    || !!document.querySelector('iframe[src*="captcha-delivery"], iframe[src*="captcha"]');
})()`;

const BIZ = `(async () => {
  const q = s => [...document.querySelectorAll(s)];
  const more = q('button').find(b => /More Attributes/i.test(b.textContent));
  if (more) { more.click(); await new Promise(r => setTimeout(r, 1200)); }
  const ld = q('script[type="application/ld+json"]').map(s => { try { return JSON.parse(s.textContent); } catch { return null; } }).filter(Boolean);
  const redir = q('a[href*="biz_redir"]').map(a => ({text: a.textContent.trim().slice(0, 80),
    url: decodeURIComponent((a.href.match(/[?&]url=([^&]+)/) || [])[1] || '')})).filter(x => x.url);
  return {url: location.href, title: document.title, ld, redir,
          text: document.body.innerText.slice(0, 40000)};
})()`;

const PHOTOS = `(() => {
  const seen = new Set(), out = [];
  for (const i of document.querySelectorAll('img[src*="bphoto"]')) {
    const m = i.src.match(/bphoto\\/([^/]+)/); if (!m || seen.has(m[1])) continue;
    seen.add(m[1]); out.push([m[1], (i.alt || '').slice(0, 220)]);
  }
  const counts = (document.body.innerText.match(/^(All|Food|Inside|Drink|Menu|Outside) \\((\\d+)\\)$/gm) || []);
  return {photos: out.slice(0, 48), counts};
})()`;

let stop = false, done = 0;
async function worker(k) {
  const tab = await new Tab().open();
  while (!stop && places.length) {
    const p = places.shift();
    const rec = {id: p.id, read_at: new Date().toISOString()};
    try {
      await tab.go(p.yelp);
      if (await tab.eval(CHALLENGE)) { stop = true; console.log(`CHALLENGE on ${p.id}: stopping. Open Chrome, finish the check yourself, then rerun.`); break; }
      rec.biz = await tab.eval(BIZ);
      await sleep(1500 + 800 * Math.random());
      await tab.go(`https://www.yelp.com/biz_photos/${encodeURIComponent(p.id)}?tab=food`, 2000);
      if (await tab.eval(CHALLENGE)) { stop = true; console.log(`CHALLENGE on ${p.id} photos`); break; }
      rec.photos_food = await tab.eval(PHOTOS);
      // the Inside tab is a button on the same page
      const clicked = await tab.eval(`(() => { const b = [...document.querySelectorAll('button,a,[role=tab]')].find(x => /^Inside \\(\\d+\\)$/.test(x.textContent.trim())); if (b) { b.click(); return true; } return false; })()`);
      if (clicked) {
        await sleep(2800);
        const food = new Set(rec.photos_food.photos.map(x => x[0]));
        const ins = await tab.eval(PHOTOS);
        ins.photos = ins.photos.filter(x => !food.has(x[0]));
        rec.photos_inside = ins;
      }
      await sleep(1200 + 800 * Math.random());
      if (stop) break;
      fs.writeFileSync(path.join(outDir, p.id + '.json'), JSON.stringify(rec));
      done++;
      const ldr = (rec.biz.ld || []).find(x => x.openingHours || x.telephone) || {};
      console.log(`[${k}] ${done} ${p.id} | hours=${(ldr.openingHours || []).length} tel=${ldr.telephone || '-'} food=${rec.photos_food?.photos.length} inside=${rec.photos_inside?.photos.length}`);
    } catch (e) {
      console.log(`[${k}] ERROR ${p.id}: ${e.message}`);
    }
  }
  await tab.close();
}
await Promise.all(Array.from({length: TABS}, (_, k) => worker(k)));
console.log(stop ? 'STOPPED (challenge page)' : `finished: ${done} saved`);
process.exit(0);
