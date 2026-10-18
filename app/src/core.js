/* Core runtime: helpers, device storage, decryption, data loading and polling,
   the router and the shell. Screens live in screens/*.js and register with
   N.screen(); app/CONTRACT.md is the reference for screen authors. */
(() => {
'use strict';
const N = window.N = {};
const D = document, W = window;
N.cfg = Object.assign({owner: '5j4d7mkd4j-byte', repo: 'tripbook', live: 'live', build: 'dev'}, W.__CFG || {});
N.debug = !!W.__FIXTURE || /[?&]debug\b/.test(location.search);
N.reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- small helpers ----------
N.$ = (s, r = D) => r.querySelector(s);
N.$$ = (s, r = D) => [...r.querySelectorAll(s)];
const ESC = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
N.esc = v => v == null ? '' : String(v).replace(/[&<>"']/g, c => ESC[c]);
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
N.raw = s => s instanceof Raw ? s : new Raw(s == null ? '' : String(s));
const val = v => v == null || v === false ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join('') : N.esc(v);
// Tagged template: interpolations are escaped unless they are N.raw()/N.h results; arrays are joined.
N.h = (str, ...vals) => new Raw(str.reduce((a, s, i) => a + s + (i < vals.length ? val(vals[i]) : ''), ''));
N.icon = (name, cls = '') => new Raw(`<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`);
N.cls = (...a) => a.filter(Boolean).join(' ');
N.plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
N.clamp = (v, a, b) => Math.min(b, Math.max(a, v));

N.report = (e, where = '') => {
  console.error(where, e);
  if (!N.debug) return;
  let box = N.$('#__err');
  if (!box) { box = D.createElement('pre'); box.id = '__err'; D.body.appendChild(box); }
  box.textContent += `${where} ${e && e.stack || e}\n`;
};
W.addEventListener('error', e => N.report(e.error || e.message, 'window'));
W.addEventListener('unhandledrejection', e => N.report(e.reason, 'promise'));

// ---------- events ----------
const subs = {};
N.on = (ev, fn) => { (subs[ev] = subs[ev] || new Set()).add(fn); return () => subs[ev].delete(fn); };
N.emit = (ev, x) => (subs[ev] || []).forEach(fn => { try { fn(x); } catch (e) { N.report(e, 'on ' + ev); } });

// ---------- device storage (never leaves the phone) ----------
N.get = (k, d = null) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
N.set = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
const WALLET0 = {names: [], aa_code: '', aa_code_ret: '', seats: {}, bags: 0, hotel_code: '', hotel_name: '', hotel_address: '', notes: ''};
N.wallet = () => Object.assign({}, WALLET0, N.get('nyc.wallet', {}) || {});
N.setWallet = w => { N.set('nyc.wallet', Object.assign({}, WALLET0, w)); N.emit('wallet'); };
N.seats = legId => (N.wallet().seats[legId] || []).filter(Boolean);
N.prefs = () => Object.assign({leave_buffer: 0}, N.get('nyc.prefs', {}) || {});
N.setPrefs = p => { N.set('nyc.prefs', Object.assign(N.prefs(), p)); N.emit('prefs'); };

// ---------- time ----------
N.now = () => W.__NYC_NOW ? new Date(W.__NYC_NOW) : new Date();
N.TZ = {PHX: 'America/Phoenix', CLT: 'America/New_York', LGA: 'America/New_York', JFK: 'America/New_York',
  EWR: 'America/New_York', NYC: 'America/New_York', DFW: 'America/Chicago', ORD: 'America/Chicago',
  MIA: 'America/New_York', PHL: 'America/New_York', DCA: 'America/New_York', LAX: 'America/Los_Angeles'};
N.tz = ap => N.TZ[ap] || ap && ap.includes('/') && ap || 'America/New_York';
const fmts = {};
const fmt = (tz, o) => { const k = tz + JSON.stringify(o); return fmts[k] || (fmts[k] = new Intl.DateTimeFormat('en-US', Object.assign({timeZone: tz}, o))); };
const parts = (f, d) => { const p = {}; f.formatToParts(d).forEach(x => { p[x.type] = x.value; }); return p; };
const toDate = v => v instanceof Date ? v : new Date(v);
// "4:20a" in the airport's (or zone's) local time
N.time = (iso, ap = 'NYC') => {
  if (!iso) return '—';
  const p = parts(fmt(N.tz(ap), {hour: 'numeric', minute: '2-digit', hour12: true}), toDate(iso));
  return `${p.hour}:${p.minute}${(p.dayPeriod || 'a').charAt(0).toLowerCase()}`;
};
// "Thu 5 Mar" (short) or "Thursday 5 Mar" (long)
N.date = (iso, ap = 'NYC', long = false) => {
  if (!iso) return '—';
  const p = parts(fmt(N.tz(ap), {weekday: long ? 'long' : 'short', day: 'numeric', month: 'short'}), toDate(iso));
  return `${p.weekday} ${p.day} ${p.month}`;
};
N.ymd = (iso, ap = 'NYC') => { const p = parts(fmt(N.tz(ap), {year: 'numeric', month: '2-digit', day: '2-digit'}), toDate(iso)); return `${p.year}-${p.month}-${p.day}`; };
N.hour = (iso, ap = 'NYC') => +parts(fmt(N.tz(ap), {hour: 'numeric', hourCycle: 'h23'}), toDate(iso)).hour;
N.mins = (a, b) => a && b ? Math.round((toDate(b) - toDate(a)) / 60000) : null;
N.addMin = (iso, m) => iso ? new Date(toDate(iso).getTime() + m * 60000).toISOString() : null;
N.dur = m => { if (m == null) return '—'; m = Math.round(Math.abs(m)); if (m < 60) return `${m} min`; const h = Math.floor(m / 60), r = m % 60; return r ? `${h}h ${r}m` : `${h}h`; };
N.until = iso => {
  const m = Math.round((toDate(iso) - N.now()) / 60000);
  if (m <= 0) return 'now';
  const d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m} min`;
};
N.ago = iso => {
  if (!iso) return 'never';
  const m = Math.round((N.now() - toDate(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / 1440)}d ago`;
};

// ---------- crypto ----------
const te = new TextEncoder(), td = new TextDecoder();
N.b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
N.b64e = u => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
N.norm = p => String(p || '').trim().toLowerCase().replace(/\s+/g, '-');
const aesKey = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
async function derive(pass, kj) {
  const base = await crypto.subtle.importKey('raw', te.encode(N.norm(pass)), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name: 'PBKDF2', hash: 'SHA-256', salt: N.b64d(kj.salt), iterations: kj.iter}, base, 256));
}
// File format: "NYC1" + 12-byte IV + AES-256-GCM(gzip(JSON)) with the tag appended.
async function unseal(key, buf) {
  const u = new Uint8Array(buf);
  if (u.length < 32 || td.decode(u.subarray(0, 4)) !== 'NYC1') throw new Error('not a trip file');
  const pt = await crypto.subtle.decrypt({name: 'AES-GCM', iv: u.subarray(4, 16)}, key, u.subarray(16));
  const s = new Blob([pt]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(s).text());
}
let KEY = null;
N.unlocked = () => !!KEY || !!W.__FIXTURE;
async function keyFromStore() {
  const b = N.get('nyc.k');
  if (!b) return null;
  try { return await aesKey(N.b64d(b)); } catch { return null; }
}
// Returns true when the passphrase opens the trip files. The derived key is
// kept on this phone so the passphrase is only typed once.
N.unlock = async pass => {
  const r = await fetch('data/key.json', {cache: 'no-cache'}).catch(() => null) || await cachedResponse('data/key.json');
  if (!r || !r.ok) throw new Error('offline');
  const kj = await r.clone().json();
  storeResponse('data/key.json', r);
  const raw = await derive(pass, kj);
  const key = await aesKey(raw);
  try { await unseal(key, N.b64d(kj.check)); } catch { return false; }
  KEY = key;
  N.set('nyc.k', N.b64e(raw));
  return true;
};
N.lock = async () => {
  N.set('nyc.k', null);
  try { await caches.delete(DATA_CACHE); } catch {}
  location.replace(location.pathname);
};

// ---------- data ----------
// trip, guide, food come from the site; status comes from the live branch.
N.data = {trip: null, guide: null, food: null, status: null};
N.meta = {status: {fetched_at: null, error: null}, files: {}};
const DATA_CACHE = 'nyc-data';
const abs = u => new URL(u, location.href).href;
async function cachedResponse(url) { try { return await (await caches.open(DATA_CACHE)).match(abs(url)) || null; } catch { return null; } }
async function storeResponse(url, res) { try { await (await caches.open(DATA_CACHE)).put(abs(url), res); } catch {} }
const same = (a, b) => {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
};
const lastBytes = {};
async function accept(name, buf, source) {
  if (same(lastBytes[name], buf)) return false;
  const doc = await unseal(KEY, buf);
  lastBytes[name] = buf;
  N.data[name] = doc;
  N.meta.files[name] = {source, at: new Date().toISOString()};
  N.emit('data', name);
  return true;
}
async function fromCache(name, url) {
  const r = await cachedResponse(url);
  if (!r) return false;
  try { return await accept(name, await r.arrayBuffer(), 'saved'); } catch (e) { N.report(e, 'cache ' + name); return false; }
}
async function fromNet(name, url, fetcher) {
  const buf = await fetcher();
  const changed = await accept(name, buf, 'network');
  if (changed) await storeResponse(url, new Response(buf, {headers: {'content-type': 'application/octet-stream'}}));
  return changed;
}
const FILES = ['trip', 'guide', 'food'];
const fileUrl = n => `data/${n}.bin`;
async function getFile(n) {
  const r = await fetch(`${fileUrl(n)}?b=${Date.now()}`, {cache: 'no-store'});
  if (!r.ok) throw new Error(`${n} ${r.status}`);
  return r.arrayBuffer();
}
const LIVE_KEY = 'live/status.bin';
async function getLive() {
  const {owner, repo, live} = N.cfg;
  try {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/status.bin?ref=${live}`,
      {cache: 'no-cache', headers: {Accept: 'application/vnd.github.raw'}});
    if (!r.ok) throw new Error('api ' + r.status);
    return await r.arrayBuffer();
  } catch (e) {
    const r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${live}/status.bin?t=${Date.now()}`, {cache: 'no-store'});
    if (!r.ok) throw new Error('raw ' + r.status);
    return r.arrayBuffer();
  }
}
// First paint from what this phone saved, then the network.
N.loadSaved = async () => {
  if (W.__FIXTURE) { Object.assign(N.data, W.__FIXTURE); return true; }
  KEY = KEY || await keyFromStore();
  if (!KEY) return false;
  await Promise.all([...FILES.map(n => fromCache(n, fileUrl(n))), fromCache('status', LIVE_KEY)]);
  return true;
};
let lastFiles = 0, lastLive = 0, busy = null;
N.refresh = (force = false) => {
  if (W.__FIXTURE || !KEY) return Promise.resolve();
  if (busy) return busy;
  const t = Date.now();
  const jobs = [];
  if (force || t - lastLive > 25000) {
    lastLive = t;
    jobs.push(fromNet('status', LIVE_KEY, getLive)
      .then(() => { N.meta.status = {fetched_at: new Date().toISOString(), error: null}; })
      .catch(e => { N.meta.status.error = String(e.message || e); }));
  }
  if (force || t - lastFiles > 15 * 60000 || FILES.some(n => !N.data[n])) {
    lastFiles = t;
    FILES.forEach(n => jobs.push(fromNet(n, fileUrl(n), () => getFile(n)).catch(e => { N.meta.files[n + '_error'] = String(e.message || e); })));
  }
  busy = Promise.all(jobs).finally(() => { busy = null; N.emit('net'); schedule(); });
  return busy;
};
let pollT = 0;
function schedule() {
  clearTimeout(pollT);
  if (W.__FIXTURE) return;
  const fast = N.travelWindow && N.travelWindow();
  pollT = setTimeout(() => { if (!D.hidden) N.refresh(); else schedule(); }, (fast ? 2 : 10) * 60000);
}
N.online = () => navigator.onLine !== false;
D.addEventListener('visibilitychange', () => { if (!D.hidden) { N.refresh(); tickNow(); } });
W.addEventListener('focus', () => N.refresh());
W.addEventListener('online', () => { N.emit('net'); N.refresh(true); });
W.addEventListener('offline', () => N.emit('net'));

// ---------- theme ----------
N.theme = () => N.get('nyc.theme', 'auto');
N.setTheme = t => {
  N.set('nyc.theme', t === 'auto' ? null : t);
  const root = D.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t; else delete root.dataset.theme;
  const dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  N.$$('meta[name="theme-color"]').forEach(m => { m.content = dark ? '#2E4A47' : '#779995'; m.removeAttribute('media'); });
};

// ---------- toast, swap ----------
let toastT = 0;
N.toast = (msg, ms = 2200) => {
  const t = N.$('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('on'), ms);
};
// Slide a set of elements out, refill them, slide them back in from the other side.
// els: [[element, dx, delayMs]], dir: 1 forward, -1 back.
N.swap = (els, fill, dir = 1) => {
  if (N.reduce) { fill(); return; }
  els.forEach(([el, dx]) => { el.style.transition = 'transform .24s ease, opacity .2s ease'; el.style.opacity = 0; el.style.transform = `translateX(${-dx * dir}px)`; });
  setTimeout(() => {
    fill();
    els.forEach(([el, dx, dl]) => {
      el.style.transition = 'none'; el.style.transform = `translateX(${dx * dir}px)`; void el.offsetWidth;
      el.style.transition = '';
      el.classList.add('sw');
      setTimeout(() => { el.style.opacity = 1; el.style.transform = 'none'; }, dl || 0);
    });
  }, 240);
};

// ---------- router ----------
const screens = N.screens = {};
N.screen = (name, def) => { screens[name] = Object.assign({name, nav: null, tone: 'band', uses: ['trip', 'guide', 'status']}, def); };
N.route = () => {
  const h = decodeURIComponent(location.hash.replace(/^#/, '')) || 'today';
  const i = h.indexOf('/');
  return i < 0 ? {name: h, param: null, hash: h} : {name: h.slice(0, i), param: h.slice(i + 1), hash: h};
};
N.go = (h, replace = false) => {
  h = String(h).replace(/^#/, '');
  if (decodeURIComponent(location.hash.slice(1)) === h) return;
  if (replace) location.replace('#' + h); else location.hash = h;
};
let depth = 0;
N.back = () => {
  const def = cur && cur.def;
  if (depth > 0) { depth -= 2; history.back(); return; }
  N.go(def && def.back || 'today', true);
};

const TABS = [['today', 'sun', 'Today'], ['flights', 'plane', 'Flights'], ['airports', 'building-airport', 'Airports'],
  ['transit', 'route', 'Transit'], ['food', 'tools-kitchen-2', 'Food']];
let cur = null, pillI = null;
const el = {};
const ctxFor = (def, route) => ({name: def.name, param: route.param, hash: route.hash, data: N.data, now: N.now(), wallet: N.wallet()});

function setPill(i) {
  const p = el.pill;
  N.$$('button', el.nav).forEach((b, k) => k === i ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  if (i == null) { p.classList.add('none'); return; }
  p.classList.remove('none');
  const r = pillI == null || i > pillI;
  p.style.transition = N.reduce || pillI == null || pillI === i ? 'none'
    : r ? 'right .3s cubic-bezier(.32,.72,0,1),left .38s cubic-bezier(.32,.72,0,1) .06s'
      : 'left .3s cubic-bezier(.32,.72,0,1),right .38s cubic-bezier(.32,.72,0,1) .06s';
  p.style.left = i * 20 + '%';
  p.style.right = (4 - i) * 20 + '%';
  pillI = i;
}

function topbar(def) {
  // Before the trip is unlocked there is nothing to open, so only the wordmark shows.
  if (!N.unlocked()) return N.h`<span style="width:38px"></span><span class="wm">nyc.</span><span style="width:38px"></span>`;
  const w = N.wallet();
  const empty = !w.aa_code && !(w.names || []).length;
  const left = def.back
    ? N.h`<button class="tbb" data-act="back" aria-label="Back">${N.icon('arrow-left')}</button>`
    : N.h`<button class="tbb" data-act="menu" aria-label="Menu" aria-expanded="false">${N.icon('menu-2')}</button>`;
  return N.h`${left}<a class="wm" href="#today" aria-label="Today">nyc.</a>
    <button class="av" data-act="go" data-arg="wallet" aria-label="Wallet">${N.icon('user')}${empty && N.unlocked() ? N.raw('<span class="bdg"></span>') : ''}</button>`;
}

// The thin line under the top bar: offline or old flight data.
N.fresh = () => {
  const st = N.data.status;
  const at = st && st.checked_at;
  const age = at ? Math.round((N.now() - new Date(at)) / 60000) : null;
  const win = N.travelWindow ? N.travelWindow() : null;
  let level = 'fresh';
  if (age == null) level = 'stale';
  else if (win) level = age > 20 ? 'stale' : age >= 10 ? 'neutral' : 'fresh';
  else if (age > 360) level = 'stale';
  return {at, age, level, window: win, text: at ? `Checked ${N.time(at, win === 'ret' ? 'LGA' : 'PHX')}` : 'Not checked yet'};
};
function stripHtml(def) {
  if (def.strip === false || !N.unlocked()) return '';
  const f = N.fresh();
  if (!N.online()) {
    return N.h`<div class="strip" role="status">${N.icon('wifi-off')}<span class="grow">Offline · showing what this phone saved${f.at ? ` (${N.ago(f.at)})` : ''}</span></div>`;
  }
  if (f.level === 'stale' && f.window) {
    return N.h`<button class="strip" style="width:100%" data-act="refresh" role="status">${N.icon('refresh')}<span class="grow">Flight info is ${f.age == null ? 'not loaded' : N.ago(f.at)} · tap to check now</span></button>`;
  }
  return '';
}
function paintStrip() { if (cur) el.strip.innerHTML = stripHtml(cur.def); }

function paint(def, ctx) {
  let out;
  try { out = def.render(ctx) || {}; }
  catch (e) {
    N.report(e, 'render ' + def.name);
    out = {hero: N.h`<h1 class="hl">Something went wrong</h1>`,
      body: N.h`<div class="co plain">${N.icon('alert-circle')}<span>This screen hit a problem. Your saved data is safe. <button class="chip" data-act="reload">Reload</button></span></div>`};
  }
  el.view.dataset.tone = def.tone || 'band';
  el.view.dataset.screen = def.name;
  el.view.classList.toggle('nonav', def.nav === undefined || def.nav === false);
  el.navWrap.classList.toggle('off', def.nav === undefined || def.nav === false || !N.unlocked());
  el.tb.innerHTML = topbar(def);
  el.strip.innerHTML = stripHtml(def);
  el.hero.innerHTML = String(out.hero || '');
  el.body.innerHTML = String(out.body || '');
  if (def.nav !== false && def.nav !== undefined) setPill(def.nav); else setPill(null);
  D.title = def.title ? `${typeof def.title === 'function' ? def.title(ctx) : def.title} · nyc.` : 'nyc.';
  let cleanup = null;
  if (def.mount) { try { cleanup = def.mount(ctx, el.view) || null; } catch (e) { N.report(e, 'mount ' + def.name); } }
  return cleanup;
}

function direction(from, to) {
  if (!from) return 0;
  if (to.back && !from.def.back) return 1;
  if (from.def.back && !to.back) return -1;
  const a = from.def.nav, b = to.nav;
  if (typeof a === 'number' && typeof b === 'number' && a !== b) return b > a ? 1 : -1;
  return 1;
}
const anim = (node, kf, o) => node.animate ? node.animate(kf, Object.assign({easing: 'cubic-bezier(.32,.72,0,1)', fill: 'both'}, o)).finished.catch(() => {}) : Promise.resolve();

let navSeq = 0;
async function navigate() {
  const route = N.route();
  let def = screens[route.name];
  if (!N.unlocked()) def = screens.unlock;
  else if (!def || def.name === 'unlock') { N.go('today', true); return; }
  const seq = ++navSeq;
  const dir = direction(cur, def);
  closeMenu(true);
  const moving = [el.hero, el.body];
  if (cur && dir && !N.reduce && cur.def !== def) {
    await Promise.all(moving.map(n => anim(n, [{opacity: 1, transform: 'none'}, {opacity: 0, transform: `translateX(${-18 * dir}px)`}], {duration: 150, easing: 'ease-in'})));
    if (seq !== navSeq) return;
  }
  if (cur && cur.cleanup) { try { cur.cleanup(); } catch (e) { N.report(e, 'cleanup'); } }
  const ctx = ctxFor(def, route);
  const same = cur && cur.def === def;
  const st = el.view.scrollTop;
  cur = {def, route, ctx, cleanup: null};
  cur.cleanup = paint(def, ctx);
  el.view.scrollTop = same && def.keepScroll ? st : 0;
  if (dir && !N.reduce && !same) {
    moving.forEach((n, i) => anim(n, [{opacity: 0, transform: `translateX(${24 * dir}px)`}, {opacity: 1, transform: 'none'}], {duration: 420, delay: i * 50}));
  }
}

// Re-render the current screen when data it uses changes; values in [data-k]
// elements that changed get a short highlight.
function rerender(why) {
  if (!cur) return;
  const {def} = cur;
  if (why && def.uses && !def.uses.includes(why) && why !== 'wallet') return;
  if (def.static && why !== 'force') { paintStrip(); return; }
  cur.ctx = ctxFor(def, cur.route);
  if (def.update) { try { def.update(cur.ctx, why); } catch (e) { N.report(e, 'update ' + def.name); } paintStrip(); return; }
  const old = new Map(N.$$('[data-k]', el.view).map(e => [e.dataset.k, e.textContent]));
  const st = el.view.scrollTop;
  if (cur.cleanup) { try { cur.cleanup(); } catch (e) { N.report(e, 'cleanup'); } }
  cur.cleanup = paint(def, cur.ctx);
  el.view.scrollTop = st;
  N.$$('[data-k]', el.view).forEach(e => {
    const o = old.get(e.dataset.k);
    if (o != null && o !== e.textContent) { e.classList.remove('chg'); void e.offsetWidth; e.classList.add('chg'); }
  });
}
N.rerender = () => rerender('force');
N.current = () => cur;

// Live text: <span data-until="ISO">, <span data-ago="ISO">, <span data-clock="PHX">
function tickNow() {
  N.$$('[data-until]').forEach(e => { e.textContent = N.until(e.dataset.until); });
  N.$$('[data-ago]').forEach(e => { e.textContent = N.ago(e.dataset.ago); });
  N.$$('[data-clock]').forEach(e => { e.textContent = N.time(N.now(), e.dataset.clock); });
  if (cur && cur.def.tick) { try { cur.ctx.now = N.now(); cur.def.tick(cur.ctx); } catch (e) { N.report(e, 'tick'); } }
  paintStrip();
}

// ---------- menu ----------
function menuHtml() {
  const t = N.data.trip, w = N.wallet(), f = N.fresh();
  const hotel = t && t.hotel;
  const range = t ? `${N.date(t.trip.start + 'T16:00:00Z', 'NYC').replace(/^\w+ /, '')}–${N.date(t.trip.end + 'T16:00:00Z', 'NYC').replace(/^\w+ /, '')}` : '';
  const rows = [
    ['wallet', 'wallet', 'Wallet & seats', w.aa_code ? 'Saved on this phone' : 'Private to you'],
    ['hotel', 'building', 'Hotel', hotel ? hotel.name : 'Not added yet'],
    ['calendar', 'calendar-plus', 'Add to Calendar', 'Flights with alerts'],
    ['settings', 'settings', 'Settings', 'Theme, leave buffer'],
    ['data', 'refresh', 'Data & updates', f.at ? f.text : 'Not checked yet'],
  ];
  return N.h`<div class="mhd"><button class="tbb" data-act="menu" aria-label="Close menu">${N.icon('x')}</button><span class="wm">nyc.</span><span style="width:38px"></span></div>
  <div class="mbody gut">
    <div class="smr row" style="gap:14px"><span class="av" style="width:64px;height:64px;font-size:28px">${N.icon('user')}</span>
      <div><div style="font-size:22px;font-weight:800">${(w.names || [])[0] ? `${w.names[0].split(' ')[0]}’s trip` : 'Your trip'}</div><div class="tn" style="font-size:15px">${t ? `${t.trip.title} · ${range}` : ''}</div></div></div>
    <div style="margin-top:18px">${rows.map(r => N.h`<button class="smr mr" data-act="go" data-arg="${r[0]}"><span class="mi">${N.icon(r[1])}</span><span class="mt">${r[2]}<small>${r[3]}</small></span>${N.icon('chevron-right')}</button>`)}</div>
    <div class="smr row small" style="margin-top:22px;gap:6px">${N.icon('lock')}Wallet details stay on this phone.</div>
  </div>`;
}
function openMenu() {
  el.menu.innerHTML = menuHtml();
  el.app.classList.add('mo');
  el.view.setAttribute('aria-hidden', 'true');
  N.$$('.smr', el.menu).forEach((r, i) => { r.style.transitionDelay = N.reduce ? '0ms' : `${120 + i * 40}ms`; });
  const b = N.$('[data-act="menu"]', el.tb); if (b) b.setAttribute('aria-expanded', 'true');
  setTimeout(() => { const x = N.$('button', el.menu); if (x) x.focus({preventScroll: true}); }, 50);
}
function closeMenu(quiet) {
  if (!el.app || !el.app.classList.contains('mo')) return;
  N.$$('.smr', el.menu).forEach(r => { r.style.transitionDelay = '0ms'; });
  el.app.classList.remove('mo');
  el.view.removeAttribute('aria-hidden');
  const b = N.$('[data-act="menu"]', el.tb); if (b) { b.setAttribute('aria-expanded', 'false'); if (!quiet) b.focus({preventScroll: true}); }
}

// ---------- actions ----------
const GLOBAL = {
  go: (e, ev, ctx, arg) => { closeMenu(true); N.go(arg); },
  back: () => N.back(),
  menu: () => el.app.classList.contains('mo') ? closeMenu() : openMenu(),
  reload: () => location.reload(),
  refresh: async () => { N.toast('Checking…'); await N.refresh(true); N.toast(N.meta.status.error ? 'Couldn’t reach the update service' : 'Up to date'); },
  copy: async (e, ev, ctx, arg) => {
    const text = arg || e.dataset.copy || e.textContent.trim();
    try { await navigator.clipboard.writeText(text); N.toast('Copied'); }
    catch { N.toast('Couldn’t copy'); }
  },
  theme: (e, ev, ctx, arg) => { N.setTheme(arg); rerender('force'); },
};
N.actions = GLOBAL;
function dispatch(kind) {
  return ev => {
    const t = ev.target.closest(kind === 'click' ? '[data-act]' : '[data-input]');
    if (!t) return;
    const name = kind === 'click' ? t.dataset.act : t.dataset.input;
    const fn = cur && cur.def.actions && cur.def.actions[name] || GLOBAL[name];
    if (!fn) return;
    if (kind === 'click' && t.tagName !== 'INPUT' && t.tagName !== 'LABEL') ev.preventDefault();
    try { const r = fn(t, ev, cur && cur.ctx, t.dataset.arg); if (r && r.catch) r.catch(e => N.report(e, 'action ' + name)); }
    catch (e) { N.report(e, 'action ' + name); }
  };
}

// ---------- service worker ----------
// Offline shell plus cached tiles/photos. A new build takes over quietly: the
// page reloads the next time it is in the background, never mid-tap.
const swWaiters = {};
let swSeq = 0;
function startSW() {
  if (!('serviceWorker' in navigator) || W.__FIXTURE || location.protocol === 'file:') return;
  const had = !!navigator.serviceWorker.controller;
  let pending = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!had) return;
    if (D.hidden) location.reload(); else pending = true;
  });
  D.addEventListener('visibilitychange', () => { if (pending && D.hidden) location.reload(); });
  navigator.serviceWorker.addEventListener('message', e => {
    const m = e.data || {};
    const w = swWaiters[m.type === 'prefetch' ? 'p' + m.id : m.type];
    if (w) w(m);
  });
  navigator.serviceWorker.register('sw.js').then(r => {
    // look for a new build whenever the app comes back to the foreground
    D.addEventListener('visibilitychange', () => { if (!D.hidden) r.update().catch(() => {}); });
  }).catch(e => N.report(e, 'sw'));
}
N.sw = {
  // Save URLs (photos or tiles) on the phone. onProgress({done, failed, total, final}).
  prefetch: (urls, cache, onProgress) => new Promise(res => {
    const c = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!c) { res(null); return; }
    const id = ++swSeq;
    swWaiters['p' + id] = m => { if (onProgress) onProgress(m); if (m.final) { delete swWaiters['p' + id]; res(m); } };
    c.postMessage({type: 'prefetch', id, urls, cache: cache === 'tiles' ? 'nyc-tiles' : 'nyc-photos'});
  }),
  // {counts:{'nyc-tiles':n,'nyc-photos':n}, usage, quota} or null
  usage: () => new Promise(res => {
    const c = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!c) { res(null); return; }
    const t = setTimeout(() => { delete swWaiters.usage; res(null); }, 4000);
    swWaiters.usage = m => { clearTimeout(t); delete swWaiters.usage; res(m); };
    c.postMessage({type: 'usage'});
  }),
};

// ---------- Leaflet (loaded on first map) ----------
// Resolves to window.L. Tiles: N.tiles(dark) gives the Carto URL and attribution.
let leaflet = null;
N.loadLeaflet = () => leaflet || (leaflet = new Promise((res, rej) => {
  if (W.L) { res(W.L); return; }
  const css = D.createElement('link');
  css.rel = 'stylesheet'; css.href = 'vendor/leaflet/leaflet.css';
  D.head.appendChild(css);
  const s = D.createElement('script');
  s.src = 'vendor/leaflet/leaflet.js';
  s.onload = () => res(W.L);
  s.onerror = () => { leaflet = null; rej(new Error('map library did not load')); };
  D.head.appendChild(s);
}));
N.tiles = (dark = N.isDark()) => ({
  url: `https://{s}.basemaps.cartocdn.com/${dark ? 'dark_all' : 'rastertiles/voyager'}/{z}/{x}/{y}{r}.png`,
  opts: {subdomains: 'abcd', maxZoom: 19, detectRetina: false, crossOrigin: true,
    attribution: '© OpenStreetMap contributors © CARTO'},
});
N.isDark = () => {
  const t = D.documentElement.dataset.theme;
  return t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
};

// ---------- start ----------
N.start = async () => {
  startSW();
  el.app = N.$('#app'); el.view = N.$('#view'); el.menu = N.$('#menu');
  el.tb = N.$('.tb', el.view); el.strip = N.$('#strip'); el.hero = N.$('#hero'); el.body = N.$('#body');
  el.navWrap = N.$('.nv'); el.nav = N.$('.nvi'); el.pill = N.$('.nvp');
  el.nav.insertAdjacentHTML('beforeend', TABS.map(([r, i, l]) => `<button data-act="go" data-arg="${r}"><svg class="i" aria-hidden="true"><use href="#i-${i}"/></svg>${l}</button>`).join(''));
  N.setTheme(N.theme());
  D.addEventListener('click', dispatch('click'));
  D.addEventListener('input', dispatch('input'));
  D.addEventListener('change', dispatch('input'));
  el.view.addEventListener('click', ev => { if (el.app.classList.contains('mo')) { ev.stopPropagation(); ev.preventDefault(); closeMenu(); } }, true);
  D.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeMenu(); });
  W.addEventListener('hashchange', () => { depth++; navigate(); });
  N.on('data', rerender);
  N.on('wallet', () => rerender('wallet'));
  N.on('prefs', () => rerender('force'));
  N.on('net', paintStrip);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => N.setTheme(N.theme()));
  setInterval(tickNow, 30000);
  await N.loadSaved();
  navigate();
  if (N.unlocked()) N.refresh(true);
  schedule();
};
// Called by the unlock screen after a good passphrase.
N.afterUnlock = async () => {
  await N.loadSaved();
  await N.refresh(true);
  N.go('today', true);
  navigate();
};
})();
