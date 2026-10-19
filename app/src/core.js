/* Core runtime: helpers, device storage, decryption, data loading and polling,
   the router and the shell. Screens live in screens/*.js and register with
   N.screen(); app/CONTRACT.md is the reference for screen authors. */
(() => {
'use strict';
const N = window.N = {};
const D = document, W = window;
N.cfg = Object.assign({owner: '5j4d7mkd4j-byte', repo: 'tripbook', live: 'live', build: 'dev'}, W.__CFG || {});
N.debug = !!W.__FIXTURE || /[?&]debug\b/.test(location.search);
// Follows the system setting live, so turning on Reduce Motion takes effect at once.
const RM = matchMedia('(prefers-reduced-motion: reduce)');
N.reduce = RM.matches;
RM.addEventListener('change', e => { N.reduce = e.matches; });

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
// A meta line: the non-empty parts joined with ' · ', each kept whole so a separator never ends a line.
N.mline = (...parts) => N.h`${parts.filter(p => p != null && p !== false && String(p) !== '').map((p, i) => N.h`${i ? ' · ' : ''}<span class="nw">${p}</span>`)}`;
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
  // Same shape as N.dur: no zero part ("1h", not "1h 0m"; "2d", not "2d 0h").
  return d ? (h ? `${d}d ${h}h` : `${d}d`) : h ? (m % 60 ? `${h}h ${m % 60}m` : `${h}h`) : `${m} min`;
};
// A flight number as people read it: carrier, no-break space, number ("AA 1234").
N.flightNo = l => {
  if (!l) return '';
  const num = l.num || String(l.flight || '').replace(/^\D+/, '');
  const car = l.carrier || (String(l.flight || '').match(/^\D+/) || ['AA'])[0];
  return num ? `${car}\u00a0${num}` : String(l.flight || 'Flight');
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
N.meta = {status: {fetched_at: null, error: null}, files: {},
  rate: {limit: null, remaining: null, reset: null, via: null, at: null}, poll: null};
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
const lastBytes = {}, oldBytes = {};
const checkedMs = d => Date.parse(d && d.checked_at) || 0;
async function accept(name, buf, source) {
  if (same(lastBytes[name], buf) || same(oldBytes[name], buf)) return false;
  const doc = await unseal(KEY, buf);
  // raw.githubusercontent.com can be minutes behind the API: never step back to an older check.
  // (Unless the one held claims a time well past this phone's clock, so it cannot block every later check.)
  const held = name === 'status' ? checkedMs(N.data.status) : 0;
  if (held && held < Date.now() + 5 * 60000 && checkedMs(doc) < held) { oldBytes[name] = buf; return false; }
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
// A request that never answers (captive Wi-Fi) would hold N.refresh, and with it every later check.
const within = ms => W.AbortSignal && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
async function getFile(n) {
  const r = await fetch(`${fileUrl(n)}?b=${Date.now()}`, {cache: 'no-store', signal: within(60000)});
  if (!r.ok) throw new Error(`${n} ${r.status}`);
  return r.arrayBuffer();
}
const LIVE_KEY = 'live/status.bin';
// api.github.com is current but allows 60 unauthenticated requests an hour per IP (a 304
// counts too, so nothing is gained by revalidating), shared by every phone on the same
// Wi-Fi. Its X-RateLimit headers go in N.meta.rate. With RATE_KEEP or fewer left, or after
// a 403/429, the app reads raw.githubusercontent.com until the hour resets; raw is
// CDN-cached for about 5 minutes (query strings are ignored), so it can be behind.
// apiShare() is what is left of the hour split over what is left of the budget: checks
// closer together than that read raw instead, so the waits never grow to save requests.
const RATE_KEEP = 3;
const apiResting = () => { const m = N.meta.rate; return m.reset > Date.now() && m.remaining != null && m.remaining <= RATE_KEEP; };
const apiShare = () => {
  const m = N.meta.rate, left = m.reset - Date.now();
  return left > 0 && m.remaining != null ? left / Math.max(m.remaining - RATE_KEEP, 1) : 0;
};
let lastApi = 0;
function readRate(r) {
  const m = N.meta.rate, h = k => r.headers.get(k);
  if (h('x-ratelimit-limit')) m.limit = +h('x-ratelimit-limit');
  if (h('x-ratelimit-remaining')) m.remaining = +h('x-ratelimit-remaining');
  if (h('x-ratelimit-reset')) m.reset = +h('x-ratelimit-reset') * 1000;
  if (r.status === 403 || r.status === 429) {
    // Out of requests, or a secondary limit: rest until the reset (or Retry-After, or 10 min).
    const after = +h('retry-after') || 0;
    m.remaining = 0;
    m.reset = Math.max(m.reset > Date.now() ? m.reset : 0, after ? Date.now() + after * 1000 : 0) || Date.now() + 10 * 60000;
  }
  m.at = new Date().toISOString();
}
// force (start, Check now, back online) uses the API whenever it is not resting.
async function getLive(force) {
  const {owner, repo, live} = N.cfg;
  if (!apiResting() && (force || Date.now() - lastApi >= apiShare() - 15000)) {
    lastApi = Date.now();
    try {
      const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/status.bin?ref=${live}`,
        {cache: 'no-store', headers: {Accept: 'application/vnd.github.raw'}, signal: within(20000)});
      readRate(r);
      if (!r.ok) throw new Error('api ' + r.status);
      const buf = await r.arrayBuffer();
      N.meta.rate.via = 'api';
      return buf;
    } catch {}
  }
  const r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${live}/status.bin?t=${Date.now()}`, {cache: 'no-store', signal: within(20000)});
  if (!r.ok) throw new Error('raw ' + r.status);
  N.meta.rate.via = 'raw';
  return r.arrayBuffer();
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
    jobs.push(fromNet('status', LIVE_KEY, () => getLive(force))
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
// How long to wait before the next status check while the app is on screen:
//   hot window (3 h before a departure until takeoff): about a minute, timed for half a
//     minute after the cloud's next check is due (checked_at + run.cadence_s; checked_at
//     is when that check started and it is published some seconds later), 20-90 s
//   travel window: 5 min; any other time: 15 min
// A tight API budget does not stretch the wait: checks closer together than apiShare()
// read raw instead ('share'). While the API is resting, raw is read and the wait ends
// just after the reset.
// → {wait (ms), why: 'hot'|'travel'|'idle', api: 'ok'|'share'|'rest'}
N.pollPlan = () => {
  const SEC = 1000, now = Date.now(), m = N.meta.rate;
  let hot = null, win = null;
  try { hot = N.hotWindow && N.hotWindow(); win = N.travelWindow && N.travelWindow(); } catch {}
  let wait, why, api = 'ok';
  if (hot) {
    const st = N.data.status, cad = (st && st.run && +st.run.cadence_s || 60) * SEC;
    const due = Date.parse(st && st.checked_at) + cad + 30 * SEC;
    wait = Number.isFinite(due) ? ((due - N.now().getTime()) % cad + cad) % cad : 60 * SEC;
    if (wait < 20 * SEC) wait += cad;
    wait = Math.min(Math.max(wait, 20 * SEC), 90 * SEC);
    why = 'hot';
  } else { wait = (win ? 5 : 15) * 60 * SEC; why = win ? 'travel' : 'idle'; }
  if (apiResting()) { wait = Math.min(wait, m.reset - now + 2 * SEC); api = 'rest'; }
  else if (apiShare() - 15 * SEC > wait) api = 'share';
  return {wait: Math.round(wait), why, api};
};
let pollT = 0;
function schedule() {
  clearTimeout(pollT);
  N.meta.poll = null;
  // Hidden: no timer. Coming back to the screen checks at once (visibilitychange below).
  if (W.__FIXTURE || D.hidden) return;
  const p = N.pollPlan();
  p.wait = Math.max(p.wait, lastLive + 26000 - Date.now());   // past the 25 s throttle
  p.next = new Date(Date.now() + p.wait).toISOString();
  N.meta.poll = p;
  pollT = setTimeout(() => { if (!D.hidden) N.refresh(); }, p.wait);
}
N.online = () => navigator.onLine !== false;
D.addEventListener('visibilitychange', () => {
  if (D.hidden) { clearTimeout(pollT); N.meta.poll = null; return; }
  N.refresh(); tickNow();
});
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
// How the next navigation started: 'go' (N.go), 'tab', 'back', or null. With null,
// navigate() reads the history entry: one the app has shown before is the browser's
// own back or forward, a fresh one is a plain <a href> link and counts as 'go'.
// Everything but 'go' returns to the old scroll spot.
let navKind = null;
N.go = (h, replace = false) => {
  h = String(h).replace(/^#/, '');
  if (decodeURIComponent(location.hash.slice(1)) === h) { navKind = null; return; }
  navKind = navKind || 'go';
  if (replace) location.replace('#' + h); else location.hash = h;
};
let depth = 0;
N.back = () => {
  const def = cur && cur.def;
  navKind = 'back';
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
  // The spacers match the menu and wallet buttons' widths, so the wordmark sits where it does on every other screen.
  if (!N.unlocked()) return N.h`<span class="tbb" aria-hidden="true"></span><span class="wm">nyc.</span><span class="av-sp" aria-hidden="true"></span>`;
  const left = def.back
    ? N.h`<button class="tbb" data-act="back" aria-label="Back">${N.icon('arrow-left')}</button>`
    : N.h`<button class="tbb" data-act="menu" aria-label="Menu" aria-expanded="false">${N.icon('menu-2')}</button>`;
  // On Wallet itself the button would only point back at this screen.
  const right = def.name === 'wallet' ? N.h`<span class="av-sp" aria-hidden="true"></span>`
    : N.h`<button class="av" data-act="go" data-arg="wallet" aria-label="Wallet">${N.icon('wallet')}</button>`;
  return N.h`${left}<a class="wm" href="#today" aria-label="Today">nyc.</a>${right}`;
}

// The thin line under the top bar: offline or old flight data.
// How old is too old follows how often the cloud checks (cadence, seconds): every minute in
// the hot window, every 10 minutes on travel days, about hourly otherwise. When the cloud
// says it is checking less often than that (run.cadence_s) and its next check is not yet
// 5 min overdue, its word is used, so a minute-old nag never shows for a 10-min check.
N.fresh = () => {
  const st = N.data.status;
  const at = st && st.checked_at;
  const age = at ? Math.round((N.now() - new Date(at)) / 60000) : null;
  const win = N.travelWindow ? N.travelWindow() : null;
  const hot = N.hotWindow ? N.hotWindow() : null;
  const said = st && st.run && [60, 600, 3600].includes(+st.run.cadence_s) ? +st.run.cadence_s : 0;
  const cadence = Math.max(hot ? 60 : win ? 600 : 3600, age != null && age * 60 <= said + 300 ? said : 0);
  let level = 'fresh';
  if (age == null) level = 'stale';
  else if (cadence === 60) level = age > 6 ? 'stale' : age > 3 ? 'neutral' : 'fresh';
  else if (cadence === 600) level = age > 20 ? 'stale' : age >= 10 ? 'neutral' : 'fresh';
  else if (age > 150) level = 'stale';
  // Times read where the traveller is: the hot leg's airport (a connection is in Eastern time).
  const hl = hot && hot.legId && N.leg(hot.legId);
  return {at, age, level, window: win, hot, cadence,
    every: cadence === 60 ? 'every minute' : cadence === 600 ? 'every 10 minutes' : 'every hour',
    text: at ? `Checked ${stamp(at, hl && hl.from || (win === 'ret' ? 'LGA' : 'PHX'))}` : 'Not checked yet'};
};
// "2:52p" today, "Sun 2:52p" on an earlier day.
const stamp = (at, ap) => N.ymd(at, ap) === N.ymd(N.now(), ap) ? N.time(at, ap) : `${N.date(at, ap).split(' ')[0]} ${N.time(at, ap)}`;
// Only the flight and airport screens carry it; elsewhere flight freshness is noise.
// A screen can opt in with strip: true or out with strip: false.
const STRIP_ON = ['today', 'flights', 'flight', 'connect', 'airports', 'airport'];
function stripHtml(def) {
  if (!N.unlocked() || def.strip === false || (def.strip !== true && !STRIP_ON.includes(def.name))) return '';
  const f = N.fresh();
  if (!N.online()) {
    return N.h`<div class="strip off" role="status">${N.icon('wifi-off')}<span class="grow ell">Offline · flight status ${f.at ? `from ${N.ago(f.at)}` : 'not loaded'}</span></div>`;
  }
  if (f.level === 'stale' && (f.window || f.hot)) {
    return N.h`<button class="strip" style="width:100%" data-act="refresh" role="status">${N.icon('refresh')}<span class="grow ell">${f.at ? `Flight status checked ${N.ago(f.at)}` : 'Flight status not loaded'}</span><b>${f.at ? 'Refresh' : 'Load'}</b></button>`;
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
      body: N.h`<div class="co plain">${N.icon('alert-circle')}<span><b>This screen hit a problem.</b> Your saved data is safe. <button class="chip" data-act="reload">Reload</button></span></div>`};
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
const scrollMem = new Map();
async function navigate() {
  const route = N.route();
  // Entries the app has painted carry {nyc:1}; see navKind.
  const seen = !!(history.state && history.state.nyc);
  const kind = navKind || (seen ? null : 'go'); navKind = null;
  if (!seen) try { history.replaceState(Object.assign({}, history.state, {nyc: 1}), ''); } catch (e) { /* Safari rate limit */ }
  let def = screens[route.name];
  if (!N.unlocked()) def = screens.unlock;
  else if (!def || def.name === 'unlock') { N.go('today', true); return; }
  if (cur && cur.def.name === cur.route.name) scrollMem.set(cur.route.hash, el.view.scrollTop);
  const seq = ++navSeq;
  const dir = direction(cur, def);
  // Switching tabs crossfades; opening or leaving a screen also slides a little.
  const tab = cur && typeof cur.def.nav === 'number' && typeof def.nav === 'number' && !cur.def.back && !def.back;
  closeMenu(true);
  const moving = [el.hero, el.body];
  if (cur && dir && !N.reduce && cur.def !== def) {
    await Promise.all(moving.map(n => anim(n, [{opacity: 1}, {opacity: 0}], {duration: 90, easing: 'ease-in'})));
    if (seq !== navSeq) return;
  }
  if (cur && cur.cleanup) { try { cur.cleanup(); } catch (e) { N.report(e, 'cleanup'); } }
  const ctx = ctxFor(def, route);
  const same = cur && cur.def === def;
  const st = el.view.scrollTop;
  cur = {def, route, ctx, cleanup: null, at: performance.now()};
  cur.cleanup = paint(def, ctx);
  el.view.scrollTop = same && def.keepScroll ? st : 0;
  // Screens with keepScroll manage their own return spot.
  const y = kind !== 'go' && !def.keepScroll && scrollMem.get(route.hash);
  if (y) { el.view.scrollTop = y; requestAnimationFrame(() => { if (cur && cur.route === route) el.view.scrollTop = y; }); }
  if (dir && !N.reduce && !same) {
    const from = tab ? 'none' : `translateX(${12 * dir}px)`;
    moving.forEach(n => anim(n, [{opacity: 0, transform: from}, {opacity: 1, transform: 'none'}], {duration: 220}));
  }
}

// Re-render the current screen when data it uses changes; values in [data-k]
// elements that changed get a short highlight, except in the first 2s on a screen,
// when fresh data arriving is not news.
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
  if (performance.now() - cur.at < 2000) return;
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
  // A hot window that opens while a 5-15 min wait is pending: plan again now, not after it.
  const p = N.meta.poll;
  if (p && p.why !== 'hot' && !busy) { try { if (N.hotWindow()) schedule(); } catch {} }
}

// ---------- menu ----------
function menuHtml() {
  const t = N.data.trip, w = N.wallet();
  const hotel = t && t.hotel;
  const range = t ? `${N.date(t.trip.start + 'T16:00:00Z', 'NYC').replace(/^\w+ /, '')}–${N.date(t.trip.end + 'T16:00:00Z', 'NYC').replace(/^\w+ /, '')}` : '';
  const rows = [
    ['wallet', 'wallet', 'Wallet & seats', w.aa_code ? 'Saved on this phone' : 'Private to you'],
    ['hotel', 'building', 'Hotel', hotel ? hotel.name : 'Not added yet'],
    ['calendar', 'calendar-plus', 'Add to Calendar', 'Flights with alerts'],
    ['settings', 'settings', 'Settings', 'Theme, alerts, leave buffer'],
    ['data', 'refresh', 'Data & updates', 'Flight status and offline maps'],
  ];
  return N.h`<div class="mhd"><button class="tbb" data-act="menu" aria-label="Close menu">${N.icon('x')}</button><span class="wm">nyc.</span><span class="av-sp" aria-hidden="true"></span></div>
  <div class="mbody gut">
    <div class="smr mme"><span class="av">${N.icon('user')}</span>
      <div><b>${(w.names || [])[0] ? `${w.names[0].split(' ')[0]}’s trip` : 'Your trip'}</b>${t ? N.h`<small class="tn">${N.mline(t.trip.title, range)}</small>` : ''}</div></div>
    <div class="mrows">${rows.map(r => N.h`<button class="smr mr" data-act="go" data-arg="${r[0]}"><span class="mi">${N.icon(r[1])}</span><span class="mt">${r[2]}<small>${r[3]}</small></span>${N.icon('chevron-right')}</button>`)}</div>
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
// Swipe the menu left, or drag the page peek, to close it. The finger is tracked 1:1;
// on release a flick or enough travel closes, otherwise it springs back. Horizontal
// drags never start within 20px of the left edge, which belongs to iOS's back swipe.
const SETTLE = 'transform .28s var(--ease),opacity .28s var(--ease),border-radius .28s var(--ease),visibility 0s .28s';
let dragged = 0;
function menuDrag(node, axis, move, closes, settle) {
  let g = null;
  node.addEventListener('pointerdown', ev => {
    g = el.app.classList.contains('mo') && ev.isPrimary && ev.button < 1 && !(axis === 'x' && ev.clientX < 20)
      ? {id: ev.pointerId, x: ev.clientX, y: ev.clientY, d: 0, v: 0, t: ev.timeStamp, on: false} : null;
  });
  node.addEventListener('pointermove', ev => {
    if (!g || ev.pointerId !== g.id) return;
    const dx = ev.clientX - g.x, dy = ev.clientY - g.y;
    if (!g.on) {
      if (Math.hypot(dx, dy) < 8) return;
      if ((Math.abs(dx) > Math.abs(dy)) !== (axis === 'x')) { g = null; return; }
      g.on = true;
      try { node.setPointerCapture(ev.pointerId); } catch {}
      node.style.transition = 'none';
    }
    const d = axis === 'x' ? dx : dy, dt = ev.timeStamp - g.t;
    if (dt > 0) g.v = (d - g.d) / dt;
    g.d = d; g.t = ev.timeStamp;
    move(d);
  });
  const up = ev => {
    if (!g || ev.pointerId !== g.id) return;
    const {on, d, t} = g, v = ev.timeStamp - t > 80 ? 0 : g.v;
    g = null;
    if (!on) return;
    dragged = Date.now();
    node.style.transition = SETTLE;
    const shut = ev.type === 'pointerup' && closes(d, v);
    settle(shut);
    if (shut) closeMenu();
    setTimeout(() => { node.style.transition = ''; if (shut) node.style.opacity = node.style.transform = ''; }, 300);
  };
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', up);
}
function menuGestures() {
  menuDrag(el.menu, 'x', d => {
    const x = d < 0 ? d : d * .2;
    el.menu.style.transform = `translateX(${x}px)`;
    el.menu.style.opacity = Math.max(.3, 1 + Math.min(0, x) / 300);
  }, (d, v) => d < -60 || v < -.5, shut => {
    if (shut) { el.menu.style.opacity = 0; return; }
    el.menu.style.transform = el.menu.style.opacity = '';
  });
  // Pulling the peek up reveals the page; pulling it down is resisted. Either closes.
  menuDrag(el.view, 'y', d => {
    el.view.style.transform = `translateY(calc(100% - 132px - env(safe-area-inset-bottom,0px) + ${d < 0 ? d : d * .35}px))`;
  }, (d, v) => Math.abs(d) > 40 || Math.abs(v) > .5, () => { el.view.style.transform = ''; });
}

// ---------- actions ----------
const GLOBAL = {
  go: (e, ev, ctx, arg) => {
    closeMenu(true);
    if (e.closest('.nv')) {
      // Tapping the tab you are on goes back to the top.
      if (cur && cur.route.hash === arg) { el.view.scrollTo({top: 0, behavior: N.reduce ? 'auto' : 'smooth'}); return; }
      navKind = 'tab';
    }
    N.go(arg);
  },
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
  // iOS only shows :active pressed states once the page listens for touches.
  D.addEventListener('touchstart', () => {}, {passive: true});
  D.addEventListener('click', dispatch('click'));
  D.addEventListener('input', dispatch('input'));
  D.addEventListener('change', dispatch('input'));
  // A drag that just closed or settled the menu must not also count as a tap.
  el.app.addEventListener('click', ev => { if (Date.now() - dragged < 400) { ev.stopPropagation(); ev.preventDefault(); } }, true);
  el.view.addEventListener('click', ev => { if (el.app.classList.contains('mo')) { ev.stopPropagation(); ev.preventDefault(); closeMenu(); } }, true);
  menuGestures();
  // The top bar gets an edge once the page scrolls under it.
  let scrollFrame = 0;
  el.view.addEventListener('scroll', () => {
    if (!scrollFrame) scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; el.view.classList.toggle('scrolled', el.view.scrollTop > 4); });
  }, {passive: true});
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
