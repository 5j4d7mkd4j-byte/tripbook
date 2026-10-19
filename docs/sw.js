/* Service worker: keeps the app usable with no signal.
   - The shell (page, fonts, icons, Leaflet, basemap) is precached per build.
   - Map tiles and Yelp photos are cached the first time they are seen and
     served from the phone after that (both hosts allow CORS, so responses are
     stored as normal, measurable entries rather than opaque ones).
   - Trip files and flight status are NOT handled here: core.js fetches them
     itself and keeps its own copy in the "nyc-data" cache. */
const BUILD = "0a3f3fbef8";
const SHELL = 'nyc-shell-' + BUILD;
const TILES = 'nyc-tiles', PHOTOS = 'nyc-photos';
const LIMIT = {[TILES]: 3000, [PHOTOS]: 1600};
const PRECACHE = ["./","manifest.webmanifest","data/basemap.json","data/subway.json","data/walk.json","fonts/figtree.woff2","fonts/inter.woff2","fonts/intertight.woff2","icons/apple-touch-icon.png","icons/icon-192.png","icons/icon-512.png","icons/icon-maskable-512.png","vendor/leaflet/images/layers-2x.png","vendor/leaflet/images/layers.png","vendor/leaflet/images/marker-icon-2x.png","vendor/leaflet/images/marker-icon.png","vendor/leaflet/images/marker-shadow.png","vendor/leaflet/leaflet.css","vendor/leaflet/leaflet.js","vendor/maplibre/LICENSE.txt","vendor/maplibre/maplibre-gl.css","vendor/maplibre/maplibre-gl.js"];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // cache: 'reload' skips the HTTP cache so a new build never precaches stale files
    await c.addAll(PRECACHE.map(u => new Request(u, {cache: 'reload'})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('nyc-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

const isTile = u => /(^|\.)basemaps\.cartocdn\.com$/.test(u.hostname);
const isPhoto = u => /(^|\.)yelpcdn\.com$/.test(u.hostname) && u.pathname.includes('/bphoto/');

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin === location.origin) {
    if (/\/data\/[^/]+\.(bin)$/.test(u.pathname) || u.pathname.endsWith('/data/key.json')) return; // core.js owns these
    if (req.mode === 'navigate') { e.respondWith(page(req)); return; }
    e.respondWith(shell(req));
    return;
  }
  if (isTile(u)) { e.respondWith(stored(req, TILES)); return; }
  if (isPhoto(u)) { e.respondWith(stored(req, PHOTOS)); return; }
});

// The page: the precached copy first (instant, works offline). A new build
// arrives as a new service worker, which precaches the new page.
async function page(req) {
  const c = await caches.open(SHELL);
  const hit = await c.match('./') || await c.match('index.html');
  if (hit) return hit;
  try { return await fetch(req); } catch { return new Response('Offline', {status: 503}); }
}

async function shell(req) {
  const c = await caches.open(SHELL);
  const hit = await c.match(req, {ignoreSearch: true});
  if (hit) return hit;
  try {
    const r = await fetch(req);
    if (r.ok && r.type === 'basic') c.put(req, r.clone());
    return r;
  } catch { return new Response('', {status: 504}); }
}

// Cache-first for tiles and photos, trimmed oldest-first past the limit.
const trimming = {};
async function stored(req, name) {
  const c = await caches.open(name);
  const key = req.url;
  const hit = await c.match(key);
  if (hit) return hit;
  try {
    const r = await fetch(key, {mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer'});
    if (r.ok) { await c.put(key, r.clone()); trim(name); }
    return r;
  } catch {
    return new Response('', {status: 504});
  }
}
function trim(name) {
  if (trimming[name]) return;
  trimming[name] = setTimeout(async () => {
    trimming[name] = 0;
    const c = await caches.open(name);
    const keys = await c.keys();
    const extra = keys.length - LIMIT[name];
    for (let i = 0; i < extra; i++) await c.delete(keys[i]);
  }, 4000);
}

// "Save for offline": the page sends a list of photo or tile URLs; they are
// fetched a few at a time and progress is posted back.
self.addEventListener('message', e => {
  const m = e.data || {};
  if (m.type === 'prefetch' && Array.isArray(m.urls)) e.waitUntil(prefetch(m, e.source));
  if (m.type === 'usage') e.waitUntil(usage(e.source));
});
async function prefetch(m, client) {
  const name = m.cache === TILES ? TILES : PHOTOS;
  const c = await caches.open(name);
  const have = new Set((await c.keys()).map(r => r.url));
  const todo = m.urls.filter(u => typeof u === 'string' && /^https:\/\//.test(u) && !have.has(u));
  let done = m.urls.length - todo.length, failed = 0;
  const total = m.urls.length;
  const post = final => client && client.postMessage({type: 'prefetch', id: m.id, done, failed, total, final});
  post(false);
  let i = 0, last = 0;
  const worker = async () => {
    while (i < todo.length) {
      const u = todo[i++];
      try {
        const r = await fetch(u, {mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer'});
        if (r.ok) await c.put(u, r); else failed++;
      } catch { failed++; }
      done++;
      if (Date.now() - last > 250) { last = Date.now(); post(false); }
    }
  };
  await Promise.all(Array.from({length: 4}, worker));
  post(true);
}
async function usage(client) {
  const out = {};
  for (const n of [TILES, PHOTOS]) out[n] = (await (await caches.open(n)).keys()).length;
  let est = null;
  try { est = await navigator.storage.estimate(); } catch {}
  client && client.postMessage({type: 'usage', counts: out, usage: est && est.usage, quota: est && est.quota});
}

// ---------- lock-screen alerts ----------
// The updater pushes {v, title, body, url, tag, at}; url is an in-app route like
// "#flight/<id>". Every push must show a notification: iPhone ends the
// subscription of a web app that receives pushes without showing one.
self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = {body: e.data ? e.data.text() : ''}; }
  if (!m || typeof m !== 'object') m = {body: typeof m === 'string' ? m : ''};   // JSON null, a number, a bare string
  const opts = {
    body: String(m.body || 'Something changed with your flights.'),
    icon: 'icons/icon-192.png',
    // The sender turns a bad route into a bare "#", which would only open Today.
    data: {url: typeof m.url === 'string' && m.url.length > 1 && m.url.startsWith('#') ? m.url : '#flights'},
  };
  // A newer alert with the same tag replaces the old one and still makes a sound.
  if (m.tag) { opts.tag = String(m.tag); opts.renotify = true; }
  if (m.at && !isNaN(Date.parse(m.at))) opts.timestamp = Date.parse(m.at);
  e.waitUntil(self.registration.showNotification(String(m.title || 'nyc.'), opts));
});

// Tapping an alert opens the app on the route it names: an open window is
// focused and told where to go, otherwise a new one opens there.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '#flights';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    const c = all.find(w => w.url.startsWith(self.registration.scope));
    if (c) {
      await c.focus().catch(() => {});
      c.postMessage({type: 'open', url});
      return;
    }
    await self.clients.openWindow(self.registration.scope + url);
  })());
});
