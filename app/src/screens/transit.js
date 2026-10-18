/* Transit: getting between LGA Terminal B and the hotel.
     #transit             both directions: traffic, weather, the options ranked
                          for right now, MTA alerts, map and ride links, tips
     #route/<dir>/<id>    one option step by step, with a street map
                          (dir is hotel or lga; a bare #route/<id> also works)
     #hotel               the hotel, directions, its confirmation (masked) and
                          the nearest places from the food list on a map
   The hotel comes from the trip, or from Wallet when the trip has none. Wallet
   values stay on the phone: the only one ever put in a link is the address the
   traveller typed, as the destination of a maps or ride link. Location is kept
   in memory by N.where and only read here. */
(() => {
'use strict';
const {h, icon} = N;

// ---------- defensive readers (any field can be missing) ----------
const arr = v => Array.isArray(v) ? v.filter(x => x != null && x !== '') : [];
const str = v => typeof v === 'string' ? v.trim() : (typeof v === 'number' ? String(v) : '');
const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
const obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : null;
const hasLL = o => !!o && num(o.lat) != null && num(o.lon) != null;
const web = u => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u.trim())) ? u.trim() : null;
const T = v => { if (v == null || v === '') return null; const t = new Date(v).getTime(); return Number.isFinite(t) ? t : null; };
const nowMs = () => N.now().getTime();
const cap1 = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const andJoin = a => a.length < 2 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
const enc = encodeURIComponent;
// One section failing must never take the whole page down.
const safe = (fn, where, fb = '') => { try { return fn(); } catch (e) { N.report(e, 'transit ' + where); return fb; } };

// ---------- places ----------
// Terminal B (approximate; the guide has no coordinates) and a Midtown stand-in
// for when no hotel is saved. The guide's times are to Midtown.
const LGA = {lat: 40.7730, lon: -73.8712, label: 'LGA Terminal B'};
const LGA_ADDR = 'LaGuardia Airport Terminal B, East Elmhurst, NY 11369';
const MIDTOWN = {lat: 40.7549, lon: -73.9840, label: 'Midtown'};
const MIDTOWN_ADDR = 'Midtown Manhattan, New York, NY';
const PENN = {lat: 40.7506, lon: -73.9935}, GCM = {lat: 40.7527, lon: -73.9772};

// ---------- approximate Manhattan geocoder ----------
// Wallet holds only a typed address, and nothing may be sent to a geocoding
// service, so the pin is worked out from the street grid. Good to about a
// block between 14th and 125th Streets; anything else returns null.
const interp = (pts, v) => {
  if (v < pts[0][0]) return null;
  for (let i = 1; i < pts.length; i++) {
    if (v <= pts[i][0]) { const [a, xa] = pts[i - 1], [b, xb] = pts[i]; return xa + (xb - xa) * (v - a) / (b - a); }
  }
  return null;
};
// st: street number; x: metres west of Fifth Avenue (negative is east).
const gridLL = (st, x) => {
  const d = (st - 42) * 80.5;
  return {lat: 40.7535 + (d * 0.8746 + x * 0.4848) / 111320, lon: -73.9805 + (d * 0.4848 - x * 0.8746) / 84325};
};
const WEST = [[0, 0], [100, 280], [200, 545], [300, 810], [400, 1085], [500, 1355], [600, 1625], [700, 1890]];
const UWS = [[0, 810], [100, 1085], [200, 1355], [300, 1490], [400, 1625], [500, 1890]];
const EAST = [[0, 0], [50, 135], [100, 270], [140, 400], [200, 535], [300, 790], [400, 1040], [500, 1290]];
const BWAY_X = [[14, -350], [23, 0], [34, 280], [45, 545], [59, 810], [65, 1085], [72, 1355], [79, 1490], [125, 1490]];
const AVES = [
  [/^(1st|first)$/, -1040, n => n / 20 + 3],
  [/^(2nd|second)$/, -790, n => n / 20 + 3],
  [/^(3rd|third)$/, -535, n => n / 20 + 10],
  [/^lexington$/, -400, n => n / 20 + 22],
  [/^park$/, -270, n => n / 20 + 35],
  [/^madison$/, -135, n => n / 20 + 26],
  [/^(5th|fifth)$/, 0, n => n <= 200 ? n / 20 + 13 : n <= 400 ? n / 20 + 16 : n <= 600 ? n / 20 + 18 : n <= 775 ? n / 20 + 20 : n / 10 - 18],
  [/^(6th|sixth)$|americas/, 280, n => n / 20 - 12],
  [/^(7th|seventh)$/, 545, n => n / 20 + 12],
  [/^(8th|eighth)$/, 810, n => n / 20 + 10],
  [/^(9th|ninth)$/, 1085, n => n / 20 + 13],
  [/^(10th|tenth)$/, 1355, n => n / 20 + 14],
  [/^(11th|eleventh)$/, 1625, n => n / 20 + 15],
  [/^columbus$/, 1085, n => n / 20 + 60],
  [/^amsterdam$/, 1355, n => n / 20 + 59],
  [/^west end$/, 1625, n => n / 20 + 60],
];
function geocode(address) {
  const s = ' ' + String(address || '').toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ') + ' ';
  if (/\b(brooklyn|queens|bronx|staten island|long island city|astoria|jersey|hoboken|flushing|jamaica|newark)\b/.test(s)) return null;
  const inRange = st => st >= 14 && st <= 125;
  // "11 W 53rd St"
  let m = s.match(/\s(\d{1,4})(?:-\d+)?\s+(w|west|e|east)\s+(\d{1,3})(?:st|nd|rd|th)?\s+(st|street)\s/);
  if (m) {
    const n = +m[1], st = +m[3];
    if (!inRange(st)) return null;
    const x = /^w/.test(m[2]) ? interp(st > 59 ? UWS : WEST, n) : interp(EAST, n);
    return x == null ? null : gridLL(st, /^w/.test(m[2]) ? x : -x);
  }
  // "1335 Avenue of the Americas", "151 W 54th"-less forms like "870 7th Ave"
  m = s.match(/\s(\d{1,4})(?:-\d+)?\s+(avenue of the americas|central park west|broadway|[a-z0-9 ]+?)\s+(ave|avenue|av)?\s/);
  if (!m) return null;
  const n = +m[1], name = m[2].trim().replace(/\s+(ave|avenue|av)$/, '');
  if (name === 'central park west') { const st = n / 10 + 60; return inRange(st) ? gridLL(st, 810) : null; }
  if (name === 'broadway') {
    if (n < 756) return null;
    const st = n < 858 ? n / 20 - 29 : n < 1000 ? n / 20 - 25 : n / 20 - 31;
    const x = inRange(st) ? interp(BWAY_X, st) : null;
    return x == null ? null : gridLL(st, x);
  }
  if (!m[3] && !/americas/.test(name)) return null;
  const av = AVES.find(([re]) => re.test(name));
  if (!av) return null;
  const st = av[2](n);
  return inRange(st) ? gridLL(st, av[1]) : null;
}

// ---------- the hotel ----------
// {name, address, phone, ll:{lat, lon, exact}, local, checkin, checkout} or null
function hotelInfo() {
  const ho = obj(safe(() => N.hotel(), 'hotel', null));
  if (!ho) return null;
  const address = str(ho.address);
  let ll = hasLL(ho) ? {lat: ho.lat, lon: ho.lon, exact: true} : null;
  if (!ll && address) { const g = geocode(address); if (g) ll = Object.assign(g, {exact: false}); }
  return {name: str(ho.name) || 'Hotel', address, phone: str(ho.phone), ll, local: !!ho.local,
    checkin: str(ho.checkin || ho.check_in), checkout: str(ho.checkout || ho.check_out)};
}
const hotelSig = ho => ho ? [ho.name, ho.address, ho.ll ? ho.ll.lat.toFixed(5) + ',' + ho.ll.lon.toFixed(5) : ''].join('|') : '';

// ---------- links ----------
// Destination for maps and rides: the address the traveller typed, or a place
// name for LGA and Midtown. Nothing else goes into these URLs.
const destFor = (dir, ho) => dir === 'lga' ? LGA_ADDR : ho && ho.address ? ho.address : ho && ho.ll && ho.ll.exact ? {lat: ho.ll.lat, lon: ho.ll.lon} : MIDTOWN_ADDR;
const destText = d => typeof d === 'string' ? d : `${d.lat},${d.lon}`;
const appleUrl = (d, mode) => N.mapsUrl(d, mode);
const googleUrl = (d, mode) => `https://www.google.com/maps/dir/?api=1&destination=${enc(destText(d))}&travelmode=${mode === 'd' ? 'driving' : mode === 'w' ? 'walking' : 'transit'}`;
function uberUrl(dir, ho) {
  let u = 'https://m.uber.com/ul/?action=setPickup&pickup=my_location';
  if (dir === 'lga') u += `&dropoff[latitude]=${LGA.lat}&dropoff[longitude]=${LGA.lon}&dropoff[formatted_address]=${enc(LGA_ADDR)}`;
  else if (ho && ho.address) u += `&dropoff[formatted_address]=${enc(ho.address)}`;
  else if (ho && ho.ll && ho.ll.exact) u += `&dropoff[latitude]=${ho.ll.lat}&dropoff[longitude]=${ho.ll.lon}`;
  return u;
}
// Lyft only takes coordinates, so a typed Wallet address is not turned into one.
function lyftUrl(dir, ho) {
  if (dir === 'lga') return `https://lyft.com/ride?id=lyft&destination[latitude]=${LGA.lat}&destination[longitude]=${LGA.lon}`;
  if (ho && ho.ll && ho.ll.exact) return `https://lyft.com/ride?id=lyft&destination[latitude]=${ho.ll.lat}&destination[longitude]=${ho.ll.lon}`;
  return 'https://lyft.com/ride?id=lyft';
}
const ext = (url, label, cls = '') => h`<a class="chip ${cls} tr-chip" href="${url}" target="_blank" rel="noopener">${label}${icon('arrow-up-right')}</a>`;

// ---------- guide data ----------
const DIRS = {hotel: {key: 'to_hotel', label: 'To hotel'}, lga: {key: 'to_lga', label: 'To LGA'}};
const other = d => d === 'hotel' ? 'lga' : 'hotel';
const TR = () => obj(N.data.guide && N.data.guide.transit) || {};
const routesOf = dir => arr(TR()[DIRS[dir].key]).filter(r => obj(r) && str(r.id) && str(r.name));
const MODE = {
  taxi: {icon: 'car', kind: 'car'},
  rideshare: {icon: 'device-mobile', kind: 'car'},
  car: {icon: 'steering-wheel', kind: 'car'},
  subway: {icon: 'train', kind: 'transit'},
  train: {icon: 'train', kind: 'transit'},
  bus: {icon: 'bus', kind: 'transit'},
};
const modeOf = r => MODE[str(r && r.mode)] || {icon: 'route', kind: 'other'};
const routeIcon = r => /\bvan\b/i.test(str(r.id).replace(/[-_]/g, ' ')) || /^shared van/i.test(str(r.name)) ? 'users' : modeOf(r).icon;
const rangeOf = m => {
  const a = arr(m).map(Number).filter(Number.isFinite);
  if (!a.length) return null;
  return a.length > 1 && a[1] !== a[0] ? `${a[0]}–${a[1]}` : `${a[0]}`;
};
// The airport guide's ground options (lga-taxi …) as routes, for old links.
const groundOf = () => arr((N.guideFor('LGA') || {}).ground).filter(g => obj(g) && str(g.id));
const groundAsRoute = g => ({id: g.id, mode: g.mode, name: str(g.name) || 'Ground transport', summary: g.where ? `From the ${str(g.where)}.` : '',
  min: g.min, cost: g.cost, best_when: g.good, avoid_when: g.bad,
  steps: arr(g.steps).map(s => typeof s === 'string' ? {icon: MODE[g.mode] ? MODE[g.mode].icon : 'point', text: s} : s),
  traffic_key: g.mode === 'taxi' || g.mode === 'rideshare' ? 'to_hotel' : null});
// The airport-guide entry that describes where a to-hotel route starts.
function groundFor(r) {
  const g = groundOf(); const id = str(r.id), m = str(r.mode);
  if (/lirr/i.test(id)) return g.find(x => /lirr/i.test(x.id)) || g.find(x => /q70/i.test(x.id));
  if (/q70/i.test(id)) return g.find(x => /q70/i.test(x.id));
  if (/m60/i.test(id)) return g.find(x => /m60/i.test(x.id));
  if (/van/i.test(id)) return g.find(x => /van/i.test(x.id));
  return g.find(x => x.mode === m);
}
function findRoute(param) {
  const parts = str(param).split('/').filter(Boolean);
  const id = parts[parts.length - 1] || '';
  const dir = parts.length > 1 && DIRS[parts[0]] ? parts[0] : null;
  for (const d of dir ? [dir] : [curDir(), other(curDir())]) {
    const r = routesOf(d).find(x => x.id === id);
    if (r) return {dir: d, r};
  }
  const g = groundOf().find(x => x.id === id);
  return g ? {dir: 'hotel', r: groundAsRoute(g)} : null;
}

// ---------- subway and bus route names ----------
const LINE = {A: 'ace', C: 'ace', E: 'ace', B: 'bdfm', D: 'bdfm', F: 'bdfm', M: 'bdfm', G: 'g', J: 'jz', Z: 'jz', L: 'l',
  N: 'nqrw', Q: 'nqrw', R: 'nqrw', W: 'nqrw', 1: '123', 2: '123', 3: '123', 4: '456', 5: '456', 6: '456', 7: '7', S: 's'};
// Line bullets are drawn in theme colours: there are no MTA colour tokens yet
// (asked for in core_requests), and colours may only come from tokens.
const bullet = l => LINE[l] ? h`<span class="tr-mta" aria-label="${l + ' train'}">${l}</span>` : '';
const linesIn = r => {
  if (str(r.mode) !== 'subway') return [];
  // Drop "Terminal B", "Level 2", "Gate C3", "74 St" so their letters and numbers aren't read as lines.
  const s = `${str(r.name)} ${str(r.summary)}`
    .replace(/\b(terminals?|level|gates?|concourse|doors?|exit)\s+(?:[A-Z]\d{0,2}|\d{1,2})(?:\s*(?:and|or|&)\s*(?:[A-Z]\d{0,2}|\d{1,2}))*\b/gi, ' ')
    .replace(/\b\d+\s*(st|nd|rd|th|av|ave)\b/gi, ' ');
  return [...new Set((s.match(/\b[ACEBDFMGJZLNQRWS1-7]\b/g) || []))].filter(l => LINE[l]);
};
// Tokens an MTA alert can mention for this route: subway letters, Q70, M60, LIRR.
const tokensOf = r => {
  if (modeOf(r).kind !== 'transit') return [];
  const s = `${str(r.name)} ${str(r.summary)}`.toUpperCase();
  const t = new Set(linesIn(r));
  (s.match(/\b(Q70|M60|LIRR)\b/g) || []).forEach(x => t.add(x));
  return [...t];
};
const alertKey = a => str(a && a.route).toUpperCase().replace(/[-\s]?SBS$/, '').replace(/\s+TRAIN$/, '');
const routeTag = key => LINE[key] ? bullet(key) : h`<span class="tr-rtag">${key || 'MTA'}</span>`;

// ---------- status: traffic, weather, alerts ----------
const status = () => obj(N.data.status) || {};
// "4:12p" today, "Wed 4:12p" within the week, "23 Sep" further back:
// an old check never reads as today's.
const clock = iso => {
  const at = T(iso);
  if (at == null) return '';
  const t = N.time(iso, 'NYC');
  if (N.ymd(iso, 'NYC') === N.ymd(N.now(), 'NYC')) return t;
  const d = N.date(iso, 'NYC').split(' ');
  return Math.abs(nowMs() - at) < 6 * 86400000 ? `${d[0]} ${t}` : `${d[1]} ${d[2]}`;
};
// Minutes since the trip data last checked status (null when it never says).
const statusAge = () => { const at = T(str(status().checked_at)); return at == null ? null : (nowMs() - at) / 60000; };
const STALE_MIN = 180;
const statusStale = () => { const a = statusAge(); return a != null && a > STALE_MIN; };
function trafficFor(key) {
  const st = status(), t = obj(st.traffic);
  const x = t && obj(t[key]);
  if (!x || num(x.min) == null || x.min <= 0) return null;
  const at = str(x.updated) || str(t.updated) || str(st.checked_at) || null;
  const age = at && T(at) != null ? (nowMs() - T(at)) / 60000 : null;
  const typ = num(x.typical_min) && x.typical_min > 0 ? Math.round(x.typical_min) : null;
  const min = Math.round(x.min);
  const delta = typ != null ? min - typ : null;
  const segs = arr(x.segments).filter(s => obj(s) && str(s.name));
  return {min, typ, delta, slow: typ != null && (min / typ >= 1.25 || delta >= 15), segs, text: str(x.text), at,
    fresh: age != null && age <= 60 && age > -15};
}
const carRange = m => { const lo = Math.max(5, 5 * Math.floor(m / 5)); return `${lo}–${lo + 10}`; };
const WET = /rain|shower|drizzle|snow|sleet|storm|thunder/i;
const wetWord = t => /snow|sleet/i.test(t) ? 'snow' : /storm|thunder/i.test(t) ? 'storms' : 'rain';
function weather() {
  const wx = obj(N.airportLive('LGA').wx);
  if (!wx) return null;
  const hourly = arr(wx.hourly).filter(x => obj(x) && T(x.t) != null).sort((a, b) => T(a.t) - T(b.t));
  // The reading itself carries no time: it is as old as the last status check.
  return {temp: num(wx.temp_f), text: str(wx.text), precip: num(wx.precip_pct), wind: num(wx.wind_mph), hourly,
    alerts: arr(wx.alerts).filter(a => obj(a) && (str(a.event) || str(a.headline))),
    at: str(status().checked_at) || null, stale: statusStale()};
}
const isWet = x => (num(x.precip_pct) != null && x.precip_pct >= 50) || WET.test(str(x.text));
// Weather around time t: the nearest hourly entry, or the current reading when t is now.
function wxAt(w, t) {
  if (!w) return null;
  let best = null;
  for (const x of w.hourly) { const d = Math.abs(T(x.t) - t); if (d <= 90 * 60000 && (!best || d < best.d)) best = {d, x}; }
  if (best) return {temp: num(best.x.temp_f), text: str(best.x.text), precip: num(best.x.precip_pct), wet: isWet(best.x), at: best.x.t};
  if (!w.stale && Math.abs(t - nowMs()) <= 60 * 60000) return {temp: w.temp, text: w.text, precip: w.precip, wet: isWet({precip_pct: w.precip, text: w.text}), at: null};
  return null;
}
// First wet hour in the next few hours: {at, word, pct} (at null = now).
function wetSoon(w, from = nowMs(), hours = 4) {
  if (!w) return null;
  if (!w.stale && isWet({precip_pct: w.precip, text: w.text})) return {at: null, word: wetWord(w.text), pct: w.precip};
  const x = w.hourly.find(x => T(x.t) >= from - 30 * 60000 && T(x.t) <= from + hours * 3600000 && isWet(x));
  return x ? {at: T(x.t) <= from + 10 * 60000 ? null : x.t, word: wetWord(x.text), pct: num(x.precip_pct)} : null;
}
const wetLabel = s => s.at ? `${s.word} likely from ${N.time(s.at, 'NYC')}` : `${s.word} now`;
function alerts() {
  const t = obj(status().transit);
  return t ? arr(t.alerts).filter(a => obj(a) && str(a.text)) : null;
}
const alertsFor = (r, list) => { const k = tokensOf(r); return k.length ? (list || []).filter(a => k.includes(alertKey(a))) : []; };
const checkedAt = () => { const at = str(status().checked_at); return T(at) != null ? `Checked ${clock(at)}` : ''; };

// ---------- direction ----------
let chosen = null;   // 'hotel' | 'lga' once the traveller picks one; null follows the trip
const retLeg = () => safe(() => N.dirLegs('ret')[0], 'ret leg', null) || null;
const outLast = () => { const l = safe(() => N.dirLegs('out'), 'out legs', []) || []; return l[l.length - 1] || null; };
function autoDir() {
  const ph = safe(() => N.phase(), 'phase', 'stay');
  if (ph === 'ret' || ph === 'after') return 'lga';
  const rd = retLeg() && str(retLeg().date);
  if (/^\d{4}-\d{2}-\d{2}$/.test(rd)) {
    const d = new Date(rd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
    if (N.ymd(N.now(), 'NYC') >= d.toISOString().slice(0, 10)) return 'lga';
  }
  return 'hotel';
}
const curDir = () => chosen || autoDir();

// ---------- what to take now ----------
// The time the trip will actually happen: after bags on arrival day, the
// planned leave time on return day, otherwise now.
function context(dir) {
  const now = nowMs();
  let t = now, when = 'now';
  if (dir === 'hotel') {
    const l = outLast(), at = l && T(l.arr && l.arr.time);
    if (at && at > now && at - now < 18 * 3600000) { t = at + 35 * 60000; when = 'land'; }
  } else {
    const lv = safe(() => N.leave('ret'), 'leave', null), at = lv && T(lv.at);
    if (at && at > now + 20 * 60000 && at - now < 24 * 3600000) { t = at; when = 'leave'; }
  }
  const {day, min} = N.nyNow(new Date(t));
  const weekday = day >= 1 && day <= 5;
  const rush = weekday && ((min >= 930 && min < 1140) || (min >= 420 && min < 600));
  const night = min < 330 || min >= 1380;
  const tr = trafficFor(DIRS[dir].key);
  const trafficNow = !!(tr && tr.fresh && Math.abs(t - now) <= 45 * 60000);
  const w = weather();
  const wx = wxAt(w, t);
  const ho = hotelInfo();
  const ll = ho && ho.ll;
  let nearRail = null;
  if (ll) { const dp = N.dist(ll, PENN), dg = N.dist(ll, GCM); if (Math.min(dp, dg) <= 800) nearRail = dp <= dg ? 'Penn Station' : 'Grand Central'; }
  const uptown = !!(ll && ll.lat >= 40.797 && ll.lon <= -73.93);
  const al = alerts();
  return {dir, now, t, when, day, min, weekday, rush, night, early: min < 420 && dir === 'lga',
    tr, trafficNow, slow: trafficNow && tr.slow, w, wx, wet: !!(wx && wx.wet), hot: !!(wx && wx.temp != null && wx.temp >= 88),
    // Alerts from an old check are still listed, but they no longer steer the pick.
    ho, nearRail, uptown, alerts: al || [], hasAlerts: !!al, recent: statusStale() ? [] : al || []};
}
function score(r, c) {
  const m = str(r.mode), k = modeOf(r).kind;
  let s = {taxi: 3, rideshare: 2.6, subway: 2.4, train: 1.2, bus: 0.2, car: 0.8}[m];
  if (s == null) s = 1;
  if (m === 'train' && c.nearRail) s = 3.3;
  if (m === 'bus') s = c.uptown ? 3.4 : c.dir === 'hotel' ? -1 : 0.2;
  if (m === 'car' && c.dir === 'lga') s = c.early ? 3.2 : 1;
  if (k === 'car') {
    if (c.slow) s -= 1.4; else if (c.rush && !c.trafficNow) s -= 0.9;
    if (c.wet) s += 0.4;
    if (c.night) s += 0.6;
  }
  if (k === 'transit') {
    if (c.slow || (c.rush && !c.trafficNow)) s += 0.6;
    if (c.night) s -= 1.8;
    if (c.wet) s -= 0.7;
    if (c.hot) s -= 0.4;
    if (alertsFor(r, c.recent).length) s -= 0.5;
  }
  return s;
}
// One line on why the top option is on top.
function whyFor(r, c, list) {
  const m = str(r.mode), k = modeOf(r).kind;
  const q70 = /Q70/.test(str(r.name) + str(r.summary));
  if (k === 'car') {
    const pro = [];
    if (c.wet && c.wx) pro.push(c.wx.at && T(c.wx.at) > c.now + 20 * 60000 ? `${wetWord(c.wx.text)} likely by ${N.time(c.wx.at, 'NYC')}` : `${wetWord(c.wx.text)} at LGA`);
    const hit = [...new Set(list.filter(x => modeOf(x.r).kind === 'transit').flatMap(x => alertsFor(x.r, c.recent).map(alertKey)))];
    if (hit.length) pro.push(`delays on the ${andJoin(hit)}`);
    if (c.night) pro.push('trains and buses run less often at this hour');
    let s = pro.length ? `${cap1(andJoin(pro))}, so a car is the easier ride.`
      : m === 'car' && c.early ? 'Early flight: book the day before so the car is waiting when you come down.'
      : m === 'taxi' ? (c.dir === 'hotel' ? 'Official line on the Level 2 curb, just outside baggage claim. Simplest with bags.' : (c.ho ? 'Door to door with bags; the hotel can call one.' : 'Door to door with bags; hail one on any avenue.'))
      : m === 'rideshare' ? 'The price is fixed before you go.' : str(r.best_when);
    if (c.trafficNow) s += c.slow ? ` Roads are slow: about ${c.tr.min} min by car.` : ` Roads are normal: about ${c.tr.min} min by car.`;
    return s;
  }
  if (m === 'train' && c.nearRail) return `Your hotel is near ${c.nearRail}; the LIRR takes about 11 min from Woodside.`;
  if (m === 'bus' && c.uptown) return 'Your hotel is uptown, on the M60 route.';
  const road = q70 ? ' Only the Q70 part is on the road.' : '';
  if (c.slow && c.tr.delta != null) return `Roads are ${c.tr.delta} min slower than usual.${road}`;
  if (c.rush) return `Weekday rush hour, when cars crawl.${road}`;
  return str(r.best_when) || 'Steady in any traffic.';
}
function rank(dir) {
  const c = context(dir);
  const list = routesOf(dir).map((r, i) => ({r, i, s: safe(() => score(r, c), 'score', 0)}))
    .sort((a, b) => b.s - a.s || a.i - b.i);
  const best = list[0] || null;
  return {c, list, best, why: best ? safe(() => whyFor(best.r, c, list), 'why', '') : ''};
}
const bestLabel = c => c.when === 'land' ? 'Best when you land' : c.when === 'leave' ? `Best for ${N.time(c.t, 'NYC')}` : 'Best now';

// ---------- shared pieces ----------
function hotelPill(ho) {
  if (!ho) {
    return h`<a class="tr-pill" href="#wallet">
      <span class="tr-pin-ic">${icon('map-pin')}</span>
      <span class="grow"><b>Add your hotel in Wallet</b><small>Until then, times and links are to Midtown.</small></span>
      ${icon('chevron-right', 'tr-chev')}</a>`;
  }
  const sub = ho.address || 'No address saved';
  return h`<a class="tr-pill" href="#hotel">
    <span class="tr-pin-ic">${icon('map-pin')}</span>
    <span class="grow"><b class="ell">${ho.name}</b><small class="ell">${sub}</small></span>
    ${icon('chevron-right', 'tr-chev')}</a>`;
}
function alertRow(a) {
  const k = alertKey(a);
  const up = T(a.updated) != null ? `Updated ${clock(a.updated)}` : '';
  // MTA writes lines as "[7]"; show them as the same bullets the routes use.
  const text = str(a.text).split(/\[([A-Z0-9]{1,2})\]/).map((p, i) => i % 2 ? (LINE[p] ? bullet(p) : `[${p}]`) : p);
  return h`<div class="tr-alert">${routeTag(k)}<div class="grow"><p>${text}</p>${up ? h`<small>${up}</small>` : ''}</div></div>`;
}
const BRIDGE = `<svg class="il tr-bridge" viewBox="0 0 220 150" aria-hidden="true"><g class="lk" stroke-width="7"><path d="M8 150Q64 26 122 150"/><path d="M96 150Q154 44 214 150"/></g><g class="lk" stroke-width="4"><path d="M0 104H220"/><path d="M30 104v46M60 104v46M150 104v46M190 104v46"/></g></svg>`;

// ---------- #transit ----------
function heroHead(dir, R) {
  const ho = R.c.ho, to = ho ? ho.name : 'Midtown';
  const rl = retLeg();
  let ey, title, sub = '';
  if (dir === 'hotel') {
    ey = `LGA Terminal B → ${to}`;
    title = 'Into town';
    const l = outLast(), at = l && T(l.arr && l.arr.time), now = nowMs();
    if (at && at > now && at - now < 18 * 3600000) sub = `${str(l.flight)} lands ${N.time(at, 'LGA')} · Terminal B`;
    else if (at && now >= at && now - at < 4 * 3600000) sub = `${l.state === 'landed' ? 'Landed' : 'Arrived about'} ${N.time(at, 'LGA')} · bags and rides on Level 2`;
    else { const n = R.list.length; sub = n ? `${N.plural(n, 'way')} in from Terminal B` : ''; }
  } else {
    ey = `${to} → LGA Terminal B${rl && rl.date ? ' · ' + N.date(rl.date + 'T16:00:00Z', 'NYC').split(' ').slice(0, 2).join(' ') : ''}`;
    title = 'To LGA';
    const tsa = obj(N.airportLive('LGA').tsa);
    if (tsa && num(tsa.wait_min) != null) sub = `Terminal B TSA about ${N.dur(tsa.wait_min)}${tsa.pre_min != null && num(tsa.pre_min) != null ? ` · PreCheck ${tsa.pre_min}` : ''}`;
    else sub = 'AA check-in: Terminal B, Level 3';
  }
  return h`<p class="ey ell tr-ey">${ey}</p><h1 class="dp tr-dp">${title}</h1>${sub ? h`<p class="tr-hsub">${sub}</p>` : ''}`;
}
function leaveCard(R) {
  const ph = safe(() => N.phase(), 'phase', 'stay');
  if (ph === 'after') return '';
  const rl = retLeg();
  if (!rl) return '';
  const lv = safe(() => N.leave('ret'), 'leave', null);
  const g = obj(N.data.guide && N.data.guide.plan && N.data.guide.plan.ret) || {};
  if (!lv) {
    const before = num(g.arrive_before_min) || 100;
    // Today's traffic says nothing about another day: use it only on the return day itself.
    const today = /^\d{4}-\d{2}-\d{2}$/.test(str(rl.date)) && N.ymd(N.now(), 'NYC') === rl.date;
    const tr = today && R.c.tr && R.c.tr.fresh ? R.c.tr : null;
    const drive = tr ? tr.min : num(g.drive_min) || 35;
    const day = rl.date ? N.date(rl.date + 'T16:00:00Z', 'NYC', true) : 'Return day';
    return h`<div class="card sand tight tr-leave">
      <p class="ey">Return · ${day}</p>
      <b class="tr-lt">Flight times aren’t confirmed yet</b>
      <p class="tr-lp">${str(rl.flight) || 'The first flight'} to ${str(rl.to) || 'CLT'} has no confirmed departure. Plan to reach Terminal B ${N.dur(before)} before it leaves; the drive is about ${drive} min${tr ? ` (traffic checked ${clock(tr.at)})` : ' with normal traffic'}. Check the AA app for the time.</p>
    </div>`;
  }
  const at = T(lv.at), dep = lv.leg && lv.leg.dep && lv.leg.dep.time, now = nowMs();
  if (dep && T(dep) < now) return '';
  const late = at < now;
  const src = lv.source === 'traffic' && R.c.tr ? `traffic checked ${clock(R.c.tr.at)}` : 'typical traffic';
  return h`<div class="card ${late ? 'rose' : 'sand'} tight tr-leave">
    <p class="ey">${late ? 'Past the leave time' : 'Leave the hotel by'}</p>
    <div class="tr-lrow"><b class="tr-big" data-k="tr-leave">${late ? 'Now' : N.time(lv.at, 'NYC')}</b>${late ? '' : h`<span class="tr-in">in <span data-until="${lv.at}">${N.until(lv.at)}</span></span>`}</div>
    <p class="tr-lp">${lv.drive} min drive (${src})${lv.buffer ? ` + ${lv.buffer} min buffer` : ''}, at Terminal B by ${N.time(lv.arrive, 'LGA')}. ${str(lv.leg.flight)} leaves ${N.time(dep, 'LGA')}; bag drop closes ${N.time(lv.bagdrop, 'LGA')}.</p>
  </div>`;
}
function arrivalLine(R) {
  const l = outLast(), at = l && T(l.arr && l.arr.time), now = nowMs();
  if (!at) return '';
  if (at > now && at - now < 18 * 3600000) {
    return h`<div class="co plain">${icon('plane-arrival')}<span>${str(l.flight)} lands ${N.time(at, 'LGA')} at Terminal B. Bags are on Level 2; plan on being at the curb around ${N.time(at + 35 * 60000, 'LGA')}.</span></div>`;
  }
  return '';
}
function trafficCard(dir, R) {
  const c = R.c, tr = c.tr, to = dir === 'lga' ? 'to LGA' : c.ho ? 'by car' : 'to Midtown';
  let head, sub = [], foot = '';
  if (tr) {
    head = tr.fresh ? `About ${carRange(tr.min)} min ${to} now` : `About ${carRange(tr.min)} min ${to} at ${clock(tr.at)}`;
    const slowSegs = tr.segs.filter(s => /slow|heavy|jam|stop/i.test(str(s.status)) || (num(s.mph) != null && s.mph < 25));
    const segText = (slowSegs.length ? slowSegs : tr.segs).slice(0, 3).map(s => num(s.mph) != null ? `${str(s.name)} ${Math.round(s.mph)} mph` : str(s.name));
    const lead = tr.slow ? 'Slow' : tr.delta != null && tr.delta <= 3 ? 'Normal' : tr.delta != null ? 'A bit slow' : '';
    sub.push([lead, ...segText].filter(Boolean).join(' · ') || tr.text);
    foot = [tr.typ != null ? `Usually ${tr.typ} min` : '', tr.at ? `${tr.fresh ? 'Checked' : 'Last checked'} ${clock(tr.at)}` : ''].filter(Boolean).join(' · ');
  } else {
    const car = routesOf(dir).find(r => modeOf(r).kind === 'car' && r.min);
    head = 'No traffic check yet';
    sub.push(`Plan on ${car ? rangeOf(car.min) : dir === 'lga' ? '30–60' : '35–75'} min by car; weekday 4–7p is the slowest.`);
  }
  const w = c.w, soon = wetSoon(w);
  let wxLine = '';
  if (w && (w.temp != null || w.text)) {
    const now = [w.temp != null ? `${Math.round(w.temp)}°` : '', w.text ? w.text.toLowerCase() : ''].filter(Boolean).join(' and ');
    const bits = [`${cap1(now)} at LGA${w.stale && T(w.at) != null ? ` when checked ${clock(w.at)}` : ''}`];
    if (soon && soon.at) bits.push(`${soon.word} likely from ${N.time(soon.at, 'NYC')}${soon.pct != null ? ` (${soon.pct}%)` : ''}`);
    if (w.temp != null && w.temp >= 88) bits.push('hot: carry water on the bus and subway');
    const ic = soon ? 'cloud-rain' : w.temp != null && w.temp >= 88 ? 'temperature' : /sun|clear/i.test(w.text) ? 'sun' : 'cloud';
    wxLine = h`<p class="tr-wx">${icon(ic)}<span>${bits.join(' · ')}</span></p>`;
  }
  const wxAlerts = w ? w.alerts.slice(0, 2).map(a => h`<p class="tr-wxa">${icon('alert-triangle')}<span>${str(a.headline) || str(a.event)}</span></p>`) : '';
  return h`<div class="card line tight tr-traffic">
    <div class="rw"><span class="ic">${icon('traffic-lights')}</span><div class="grow">
      <b data-k="tr-traffic-${dir}">${head}</b>
      ${sub.map(s => h`<small>${s}</small>`)}
      ${foot ? h`<small class="tr-foot">${foot}</small>` : ''}
    </div></div>
    ${wxLine}${wxAlerts}
  </div>`;
}
// The traffic reading for routes that drive the road (taxi, rideshare, car service); vans and
// transit get none.
function routeTraffic(r, dir, c) {
  const tk = str(r.traffic_key) || (/^(taxi|rideshare)$/.test(str(r.mode)) ? DIRS[dir].key : '');
  if (!tk) return null;
  return tk === DIRS[dir].key ? c.tr : trafficFor(tk);
}
function optionRow(x, R, dir, k) {
  const r = x.r, best = R.best && R.best.r === r;
  const c = R.c, lines = linesIn(r), hits = alertsFor(r, c.alerts);
  const rg = rangeOf(r.min);
  const meta = [str(r.cost)];
  const trk = routeTraffic(r, dir, c);
  if (trk && trk.fresh) meta.push(`${trk.min} min drive now`);
  const lineTags = lines.length ? h`<span class="tr-lines">${lines.map(bullet)}</span>` : '';
  return h`<a class="op tr-op${best ? ' best' : ''} rise" style="${`animation-delay:${k * 40}ms`}" href="${'#route/' + dir + '/' + r.id}">
    <span class="ic">${icon(routeIcon(r))}</span>
    <span class="grow tr-opm">
      <span class="tr-opn"><b>${str(r.name)}</b></span>
      ${lineTags}
      <small>${meta.filter(Boolean).join(' · ') || str(r.summary)}</small>
      ${hits.length ? h`<small class="tr-warn">${icon('alert-triangle')}${hits.map(alertKey).filter((v, i, a) => a.indexOf(v) === i).join(', ')} alert below</small>` : ''}
      ${best ? h`<span class="tr-best"><b>${icon('thumb-up')}${bestLabel(c)}</b> ${R.why}</span>` : ''}
    </span>
    <span class="tr-opt">${rg ? h`<b>${rg}</b><small>min</small>` : h`<small>Varies</small>`}</span>
  </a>`;
}
function alertsSec(dir, R) {
  const list = alerts();
  const toks = new Set(routesOf(dir).flatMap(tokensOf));
  if (list == null) {
    return h`<div class="sec"><p class="ey">Subway and bus alerts</p><div class="co plain">${icon('info-circle')}<span>No MTA check yet. Alerts for the E, Q70 and other lines on these routes show here once the trip data updates.</span></div></div>`;
  }
  const rel = list.filter(a => toks.has(alertKey(a))), rest = list.filter(a => !toks.has(alertKey(a)));
  const ck = checkedAt();
  if (!list.length) {
    return h`<div class="sec"><p class="ey">Subway and bus alerts</p><div class="co plain">${icon('circle-check')}<span>No alerts for the subway or buses on these routes${ck ? ' · ' + ck : ''}.</span></div></div>`;
  }
  return h`<div class="sec"><p class="ey">Subway and bus alerts</p>
    ${rel.length ? h`<div class="tr-alerts">${rel.slice(0, 6).map(alertRow)}</div>` : ''}
    ${rest.length && rel.length < 6 ? h`${rel.length ? h`<p class="ey tr-sub">Other lines</p>` : ''}<div class="tr-alerts">${rest.slice(0, 6 - rel.length).map(alertRow)}</div>` : ''}
    ${!rel.length ? h`<p class="tr-note">None of these are on the routes above.</p>` : ''}
    ${statusStale() && ck ? h`<p class="tr-note">${ck}; these may have cleared since.</p>` : ''}
  </div>`;
}
function linksSec(dir, R) {
  const ho = R.c.ho, d = destFor(dir, ho);
  const k = R.best ? modeOf(R.best.r).kind : 'car';
  const mode = k === 'transit' ? 'r' : 'd';
  const note = dir === 'hotel' && !ho ? 'No hotel saved, so these go to Midtown.'
    : dir === 'hotel' && ho && !ho.address && !(ho.ll && ho.ll.exact) ? 'The hotel has no address saved, so these go to Midtown.'
    : dir === 'hotel' && ho && ho.local && !(ho.ll && ho.ll.exact) ? 'Lyft opens without a destination; paste the address there.' : '';
  return h`<div class="sec"><p class="ey">Open in</p>
    <div class="wrap tr-links">
      ${ext(appleUrl(d, mode), 'Maps', 'dk2')}
      ${ext(googleUrl(d, mode), 'Google', 'cr')}
      ${ext(uberUrl(dir, ho), 'Uber', 'cr')}
      ${ext(lyftUrl(dir, ho), 'Lyft', 'cr')}
      ${dir === 'hotel' && ho && ho.address ? h`<button class="chip ghost tr-chip" data-act="copy" data-copy="${ho.address}">${icon('copy')}Copy address</button>` : ''}
    </div>
    ${note ? h`<p class="tr-note">${note}</p>` : ''}
  </div>`;
}
function tipsSec() {
  const tips = arr(TR().tips).map(str).filter(Boolean);
  if (!tips.length) return '';
  return h`<div class="sec"><p class="ey">Good to know</p><div class="card tight tr-tips"><ul>${tips.map(t => h`<li>${t}</li>`)}</ul></div></div>`;
}
function timesNote(ho) {
  const ll = ho && ho.ll;
  if (!ll) return 'Times are door to door between Terminal B and Midtown.';
  return N.dist(ll, MIDTOWN) <= 2500 ? 'Times are door to door to Midtown, close to your hotel.'
    : 'Times are door to door to Midtown; your hotel is farther out, so allow a little more.';
}
function dirBody(dir) {
  const R = rank(dir);
  const opts = R.list.length
    ? h`<div class="stack8 tr-opts">${R.list.map((x, k) => optionRow(x, R, dir, k))}</div>`
    : h`<div class="co plain">${icon('info-circle')}<span>The transit guide isn’t loaded on this phone yet. Open the app once with signal to save it.</span></div>`;
  return h`
    ${dir === 'lga' ? safe(() => leaveCard(R), 'leave card') : safe(() => arrivalLine(R), 'arrival')}
    ${safe(() => trafficCard(dir, R), 'traffic')}
    <div class="sec"><p class="ey">Ways to go</p>${opts}
      ${R.list.length ? h`<p class="tr-note">${timesNote(R.c.ho)}</p>` : ''}
    </div>
    ${safe(() => alertsSec(dir, R), 'alerts')}
    ${safe(() => linksSec(dir, R), 'links')}
    ${safe(tipsSec, 'tips')}`;
}
const transitSig = () => ['hotel', 'lga'].map(d => { const R = rank(d); return (R.best ? R.best.r.id : '') + bestLabel(R.c); }).join('|') + curDir();
let lastSig = '';

N.screen('transit', {
  nav: 3,
  tone: 'band',
  // 'force' too: core's rerender() checks `uses` first, so without it N.rerender()
  // (from tick) and the theme switch would skip this screen.
  uses: ['trip', 'guide', 'status', 'force'],
  title: 'Transit',
  render(ctx) {
    const dir = curDir();
    lastSig = safe(transitSig, 'sig', '');
    const R = rank(dir);
    const ho = R.c.ho;
    return {
      hero: h`<div class="tr-hero">${N.raw(BRIDGE)}
        <div data-tr="head">${safe(() => heroHead(dir, R), 'hero')}</div>
        <div class="ps tr-ps" role="group" aria-label="Direction">
          ${['hotel', 'lga'].map(d => h`<button data-act="trDir" data-arg="${d}" aria-pressed="${String(d === dir)}">${DIRS[d].label}</button>`)}
        </div>
      </div>`,
      body: h`<div class="tr-body">
        ${safe(() => hotelPill(ho), 'pill')}
        <div data-tr="dir">${dirBody(dir)}</div>
      </div>`,
    };
  },
  tick() {
    const s = safe(transitSig, 'sig', '');
    if (s && s !== lastSig) N.rerender();
  },
  actions: {
    trDir(el, ev, ctx, arg) {
      if (!DIRS[arg] || arg === curDir()) return;
      chosen = arg;
      N.$$('.tr-ps button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.arg === arg)));
      const head = N.$('[data-tr="head"]'), body = N.$('[data-tr="dir"]');
      if (!head || !body) { N.rerender(); return; }
      N.swap([[head, 24, 0], [body, 24, 60]], () => {
        const R = rank(arg);
        head.innerHTML = String(safe(() => heroHead(arg, R), 'hero'));
        body.innerHTML = String(dirBody(arg));
        lastSig = safe(transitSig, 'sig', '');
      }, arg === 'lga' ? 1 : -1);
    },
  },
});

// ---------- maps (route and hotel) ----------
let basemap = null;
const getBasemap = () => basemap || (basemap = fetch('data/basemap.json').then(r => r.ok ? r.json() : null)
  .then(j => { if (!j) basemap = null; return j; }).catch(() => { basemap = null; return null; }));
const tok = (el, n) => getComputedStyle(el).getPropertyValue(n).trim();
const wz = (base, z) => Math.max(0.4, Math.min(base * Math.pow(2, z - 15), base * 3));
function pinIcon(L, cls, inner, size = [36, 44], anchor = [18, 42]) {
  return L.divIcon({className: 'tr-pinw', html: `<span class="tr-mpin ${cls}">${inner}</span>`, iconSize: size, iconAnchor: anchor});
}
// Draws the offline NYC outline under the tiles, then the tiles. Returns the map.
async function baseMap(box, alive, interactive = true) {
  const L = await N.loadLeaflet();
  if (!alive() || !box.isConnected) return null;
  const map = L.map(box, {zoomControl: false, dragging: interactive, touchZoom: interactive, scrollWheelZoom: false, doubleClickZoom: interactive,
    boxZoom: false, keyboard: false, inertia: true, zoomSnap: .25, fadeAnimation: false, attributionControl: true});
  map.attributionControl.setPrefix(false);
  const pane = map.createPane('trBase');
  pane.style.zIndex = 150;
  pane.style.pointerEvents = 'none';
  map._trPane = 'trBase';
  return {L, map};
}
/* Carto's free basemaps now answer every request with an "API KEY REQUIRED"
   watermark tile, so the tile layer is only added once N.tiles points somewhere
   else or carries a key (the place screen does the same). Until then the map is
   drawn from data/basemap.json alone, which also means it works with no signal. */
const tilesOk = t => !!(t && typeof t.url === 'string' && t.url && (!/basemaps\.cartocdn\.com/.test(t.url) || /[?&](api_?key|key|token)=/i.test(t.url)));
function addBase(L, map, box, alive) {
  const t = N.tiles(N.isDark()), tiles = tilesOk(t);
  getBasemap().then(gj => {
    if (!gj || !alive() || !box.isConnected) return;
    const c = {land: tok(box, '--tr-land'), park: tok(box, '--tr-park'), road: tok(box, '--tr-road'), edge: tok(box, '--tr-edge')};
    const renderer = L.canvas({pane: 'trBase', padding: .3});
    const kind = f => f && f.properties && f.properties.k;
    const opts = (style, filter) => ({pane: 'trBase', renderer, interactive: false, style, filter});
    const area = L.geoJSON(gj, opts(f => kind(f) === 'park'
      ? {stroke: false, fill: true, fillColor: c.park, fillOpacity: .26}
      : {stroke: true, color: c.land, weight: 1, fill: true, fillColor: c.land, fillOpacity: 1}), f => kind(f) === 'land' || kind(f) === 'park').addTo(map);
    const roads = f => kind(f) === 'major' || kind(f) === 'road';
    const caseStyle = f => ({color: c.edge, weight: wz(kind(f) === 'major' ? 8 : 5, map.getZoom()), opacity: 1, fill: false, lineCap: 'round', lineJoin: 'round'});
    const fillStyle = f => ({color: c.road, weight: wz(kind(f) === 'major' ? 5.5 : 3, map.getZoom()), opacity: 1, fill: false, lineCap: 'round', lineJoin: 'round'});
    const cas = L.geoJSON(gj, opts(caseStyle, roads)).addTo(map);
    const fil = L.geoJSON(gj, opts(fillStyle, roads)).addTo(map);
    map.on('zoomend', () => { try { cas.setStyle(caseStyle); fil.setStyle(fillStyle); } catch { /* map gone */ } });
    if (!tiles && area) map.attributionControl.addAttribution('NYC Open Data · US Census');
  });
  if (tiles) L.tileLayer(t.url, t.opts).addTo(map);
}
// Live map state for the route and hotel screens; cleaned on unmount.
const live = {route: null, hotel: null};
function stopLive(k) {
  const st = live[k];
  if (!st) return;
  st.dead = true;
  clearTimeout(st.timer);
  if (st.off) { try { st.off(); } catch { /* ignore */ } }
  if (st.map) { try { st.map.remove(); } catch { /* already gone */ } }
  live[k] = null;
}
// Map colours come from CSS when drawn, so a theme change redraws the map.
const mapSig = ho => hotelSig(ho) + (N.isDark() ? '|dark' : '|light');
// The system theme can flip with no rerender from core (theme "auto"): follow it.
function watchScheme() {
  let mq = null;
  try { mq = matchMedia('(prefers-color-scheme: dark)'); } catch { return () => {}; }
  const fn = () => setTimeout(() => N.rerender(), 0);
  try { mq.addEventListener('change', fn); } catch { return () => {}; }
  return () => { try { mq.removeEventListener('change', fn); } catch { /* ignore */ } };
}
const FAR_M = 80000;
// Adds or moves the "you" dot. fit: refit the view when the fix is in town.
function showMe(st, w, fit) {
  if (!st || st.dead || !st.map || !w || !hasLL(w)) return;
  const L = st.L, ll = [w.lat, w.lon];
  const far = N.dist(w, LGA) > FAR_M;
  if (far) { if (fit) N.toast(`You’re ${N.distText(N.dist(w, LGA))} from LGA; the map stays on New York.`); return; }
  if (st.me) st.me.setLatLng(ll);
  else st.me = L.marker(ll, {interactive: false, keyboard: false, zIndexOffset: 500,
    icon: L.divIcon({className: 'tr-pinw', html: '<span class="tr-me"></span>', iconSize: [22, 22], iconAnchor: [11, 11]})}).addTo(st.map);
  if (fit && st.fit) st.fit(true);
  if (st.onMe) st.onMe(w);
}
async function locate(el) {
  const lab = N.$('.tr-locl', el);
  const was = lab ? lab.textContent : '';
  el.setAttribute('aria-disabled', 'true');
  if (lab) lab.textContent = 'Finding you…';
  const w = await N.where({fresh: true});
  el.removeAttribute('aria-disabled');
  if (lab) lab.textContent = was;
  if (!w) { N.toast('Location is off for this app. Turn it on in Settings › Privacy › Location Services.'); return; }
  showMe(live.route || live.hotel, w, true);
}
const zoomBy = d => { const st = live.route || live.hotel; if (st && st.map) st.map.setZoom(st.map.getZoom() + d); };
const mapControls = () => h`<div class="tr-zoom">
  <button class="tr-zb" data-act="trZoom" data-arg="1" aria-label="Zoom in">${icon('plus')}</button>
  <button class="tr-zb" data-act="trZoom" data-arg="-1" aria-label="Zoom out">${icon('minus')}</button></div>`;

// ---------- #route ----------
function whereCard(dir, r) {
  const m = str(r.mode), k = modeOf(r).kind;
  const lga = N.guideFor('LGA') || {};
  const links = arr(lga.links).filter(l => obj(l) && web(l.url) && str(l.label));
  const link = re => links.find(l => re.test(l.label));
  if (dir === 'lga') {
    const items = [[icon('door'), 'Drop-off', 'Terminal B departures curb, Level 3. AA check-in and bag drop are inside on the same level.'],
      [icon('luggage'), 'Bag drop', 'Closes 45 min before departure.']];
    if (/Q70/.test(str(r.name) + str(r.summary))) items.splice(1, 0, [icon('bus'), 'Q70', 'Terminal C comes first; stay on for Terminal B, then go up to Level 3.']);
    return h`<div class="card tight tr-where"><p class="ey">At Terminal B</p>${items.map(([i, b, s]) => h`<div class="rw tr-wr"><span class="ic">${i}</span><div><b>${b}</b><small>${s}</small></div></div>`)}</div>`;
  }
  const g = groundFor(r);
  let place, how, lk;
  if (m === 'taxi') { place = (g && str(g.where)) || 'Level 2 taxi rank'; how = 'Leave baggage claim for the Level 2 curb and join the official taxi line. Ignore anyone offering rides inside.'; lk = link(/taxi/i); }
  else if (m === 'rideshare') { place = (g && str(g.where)) || 'Garage Level 2, “Ride App Pick Up”'; how = 'Request from baggage claim, where signal is better, then take the covered walkway to the garage.'; lk = link(/rideshare|ride app/i); }
  else if (k === 'transit') { place = (g && str(g.where)) || 'Bus stop outside arrivals, Level 2'; how = /Q70/.test(str(r.name) + str(r.summary)) ? 'Follow the bus signs from baggage claim. The Q70 is free; board at any door.' : 'Follow the bus signs from baggage claim. Tap OMNY or a contactless card; the fare is $3.'; lk = link(/mta|bus|lga to nyc/i); }
  else { place = (g && str(g.where)) || 'Where the operator tells you'; how = 'Most operators meet you at the Level 2 arrivals curb; check your booking.'; lk = link(/van|shuttle/i); }
  return h`<div class="card tight tr-where"><p class="ey">Where at Terminal B</p>
    <div class="rw tr-wr"><span class="ic">${icon('map-pin')}</span><div><b>${place}</b><small>${how}</small></div></div>
    ${lk ? h`<a class="tr-lk" href="${web(lk.url)}" target="_blank" rel="noopener">${icon('map')}<span class="grow">${str(lk.label)}</span>${icon('arrow-up-right')}</a>` : ''}
  </div>`;
}
function stepsList(r) {
  const steps = arr(r.steps).map(s => typeof s === 'string' ? {text: s} : s).filter(s => obj(s) && str(s.text));
  if (!steps.length) return h`<div class="co plain">${icon('info-circle')}<span>No step-by-step for this one. ${str(r.summary)}</span></div>`;
  const total = steps.reduce((a, s) => a + (num(s.min) || 0), 0);
  return h`<ol class="tr-steps">${steps.map((s, i) => h`<li class="tr-st rise" style="${`animation-delay:${i * 50}ms`}">
      <span class="tr-sti">${icon(str(s.icon) || 'point')}</span>
      <div class="grow"><p>${str(s.text)}</p>${str(s.where) ? h`<small>${icon('map-pin')}${str(s.where)}</small>` : ''}</div>
      ${num(s.min) ? h`<span class="tr-stm">${s.min} min</span>` : ''}
    </li>`)}</ol>
    ${total ? h`<p class="tr-note">Steps add up to about ${N.dur(total)}${rangeOf(r.min) ? `; allow ${rangeOf(r.min)} min door to door` : ''}.</p>` : ''}`;
}
function routeTop(dir, r, R) {
  const c = R.c;
  const isBest = R.best && R.best.r.id === r.id;
  const uptown = /uptown only|not a midtown route/i.test(str(r.name) + ' ' + str(r.summary));
  const span = uptown ? 'Uptown, not Midtown' : dir === 'lga' ? (c.ho ? 'Guide times, from Midtown' : 'From Midtown') : (c.ho ? 'Guide times, to Midtown' : 'To Midtown');
  const tiles = [
    ['Door to door', rangeOf(r.min) ? `${rangeOf(r.min)} min` : 'Varies', span],
    ['Cost', str(r.cost) || 'Not listed', ''],
  ];
  const tr = routeTraffic(r, dir, c);
  if (tr) tiles.push([tr.fresh ? 'Drive now' : 'Drive', `${tr.min} min`,
    [tr.typ != null ? `usually ${tr.typ}` : '', `${tr.fresh ? 'checked' : 'last checked'} ${clock(tr.at)}`].filter(Boolean).join(' · ')]);
  const hits = alertsFor(r, c.alerts);
  return h`
    <div class="tr-tiles">${tiles.map(([s, b, sp]) => h`<div class="tile"><small>${s}</small><b>${b}</b>${sp ? h`<span>${sp}</span>` : ''}</div>`)}</div>
    ${isBest ? h`<div class="co tr-co">${icon('thumb-up')}<span><b>${bestLabel(c)}.</b> ${R.why}</span></div>`
      : R.best ? h`<a class="co plain tr-co tr-alt" href="${'#route/' + dir + '/' + R.best.r.id}">${icon('arrows-exchange')}<span class="grow">${bestLabel(c)}: <b>${str(R.best.r.name)}</b>. ${R.why}</span>${icon('chevron-right')}</a>` : ''}
    ${hits.length ? h`<div class="tr-alerts">${hits.map(alertRow)}</div>` : ''}
    ${str(r.best_when) || str(r.avoid_when) ? h`<div class="card tight tr-when">
      ${str(r.best_when) ? h`<div class="rw tr-wr"><span class="ic">${icon('circle-check')}</span><div><b>Good when</b><small>${str(r.best_when)}</small></div></div>` : ''}
      ${str(r.avoid_when) ? h`<div class="rw tr-wr"><span class="ic">${icon('alert-circle')}</span><div><b>Skip when</b><small>${str(r.avoid_when)}</small></div></div>` : ''}
    </div>` : ''}
    <div class="sec"><p class="ey">Step by step</p>${stepsList(r)}</div>
    <div class="sec">${safe(() => whereCard(dir, r), 'where')}</div>`;
}
function routeBottom(dir, r, R) {
  const ho = R.c.ho, d = destFor(dir, ho), k = modeOf(r).kind;
  const book = obj(r.book) && web(r.book.url) ? r.book : null;
  const m = str(r.mode);
  const chips = k === 'transit'
    ? [ext(appleUrl(d, 'r'), 'Maps transit', 'dk2'), ext(googleUrl(d, 'r'), 'Google transit', 'cr')]
    : m === 'rideshare'
      ? [ext(uberUrl(dir, ho), 'Uber', 'dk2'), ext(lyftUrl(dir, ho), 'Lyft', 'cr'), ext(appleUrl(d, 'd'), 'Maps', 'cr')]
      : [ext(appleUrl(d, 'd'), 'Maps', 'dk2'), ext(googleUrl(d, 'd'), 'Google', 'cr')];
  return h`
    ${book ? h`<a class="btn alt tr-wide" href="${web(book.url)}" target="_blank" rel="noopener">${icon('ticket')}${str(book.label) || 'Book'}${icon('arrow-up-right')}</a>` : ''}
    <div class="sec"><p class="ey">Open in</p><div class="wrap tr-links">${chips}
      ${dir === 'hotel' && ho && ho.address ? h`<button class="chip ghost tr-chip" data-act="copy" data-copy="${ho.address}">${icon('copy')}Copy address</button>` : ''}
    </div></div>`;
}
function routeMapCard(dir, R) {
  const ho = R.c.ho;
  const note = !ho ? 'No hotel saved: the second pin is Midtown, where the guide’s times end.'
    : !ho.ll ? 'Your hotel’s address couldn’t be placed on the map, so the second pin is Midtown.'
    : !ho.ll.exact ? 'Hotel pin placed from the street address; it can be off by a block.' : '';
  return h`<div class="sec"><p class="ey">Map</p>
    <div class="tr-mapc">
      <div class="tr-map" data-tr="map" role="img" aria-label="${`Map of LGA Terminal B and ${ho && ho.ll ? ho.name : 'Midtown'}`}"><span class="tr-mapph">${icon('map')}Loading map…</span></div>
      ${mapControls()}
    </div>
    <div class="tr-mapbar">
      <button class="chip cr tr-chip" data-act="trLocate">${icon('current-location')}<span class="tr-locl">Show where I am</span></button>
      ${ho && ho.ll ? h`<span class="tr-leg">${icon('plane')}LGA ${icon('bed')}Hotel</span>` : ''}
    </div>
    ${note ? h`<p class="tr-note">${note}</p>` : ''}
  </div>`;
}
function routeRender(ctx) {
  const f = findRoute(ctx.param);
  if (!f) {
    return {
      hero: h`<div class="tr-hero"><p class="ey">Transit</p><h1 class="hl"><b>Route not found</b></h1></div>`,
      body: h`<div class="tr-body"><div class="co plain">${icon('info-circle')}<span>This option isn’t in the transit guide on this phone. It may have been renamed in an update.</span></div>
        <a class="btn tr-wide" href="#transit">${icon('route')}All ways to go</a></div>`,
    };
  }
  const {dir, r} = f;
  const R = rank(dir);
  const name = str(r.name);
  const ey = dir === 'lga' ? `${R.c.ho ? R.c.ho.name : 'Midtown'} → LGA Terminal B` : `LGA Terminal B → ${R.c.ho ? R.c.ho.name : 'Midtown'}`;
  return {
    // No illustration here: the summary runs full width and would sit on top of it.
    hero: h`<div class="tr-hero">
      <p class="ey ell tr-ey">${ey}</p>
      <div class="tr-rh"><span class="tr-rhi">${icon(routeIcon(r))}</span><h1 class="tr-rname" style="${`font-size:${nameSize(name)}px`}">${name}</h1></div>
      ${linesIn(r).length ? h`<div class="tr-lines tr-hl">${linesIn(r).map(bullet)}</div>` : ''}
      ${str(r.summary) ? h`<p class="tr-lede">${str(r.summary)}</p>` : ''}
    </div>`,
    body: h`<div class="tr-body">
      <div data-tr="top">${safe(() => routeTop(dir, r, R), 'route top')}</div>
      ${routeMapCard(dir, R)}
      <div data-tr="bot">${safe(() => routeBottom(dir, r, R), 'route bottom')}</div>
    </div>`,
    dir, r, R,
  };
}
function nameSize(name) {
  const len = name.length;
  const word = Math.max(...name.split(/\s+/).map(w => w.length), 1);
  const byLen = len <= 10 ? 44 : len <= 16 ? 38 : len <= 24 ? 32 : 28;
  return Math.max(24, Math.min(byLen, Math.floor(300 / (word * .62))));
}
function startRouteMap(ctx, view) {
  stopLive('route');
  const f = findRoute(ctx.param);
  const box = N.$('[data-tr="map"]', view);
  if (!f || !box) return;
  const ho = hotelInfo();
  const st = live.route = {dead: false, map: null, L: null, me: null, sig: mapSig(ho) + f.dir + f.r.id};
  const alive = () => !st.dead;
  st.timer = setTimeout(() => {
    baseMap(box, alive).then(res => {
      if (!res) return;
      const {L, map} = res;
      st.L = L; st.map = map;
      const tgt = ho && ho.ll ? {lat: ho.ll.lat, lon: ho.ll.lon} : MIDTOWN;
      st.fit = (withMe) => {
        const pts = [[LGA.lat, LGA.lon], [tgt.lat, tgt.lon]];
        if (withMe && st.me) pts.push([st.me.getLatLng().lat, st.me.getLatLng().lng]);
        map.fitBounds(L.latLngBounds(pts), {paddingTopLeft: [36, 64], paddingBottomRight: [76, 40], maxZoom: 15, animate: false});
      };
      st.fit(false);
      addBase(L, map, box, alive);
      box.classList.add('tr-ready');
      L.marker([LGA.lat, LGA.lon], {interactive: false, keyboard: false, icon: pinIcon(L, 'lga', String(icon('plane')))}).addTo(map);
      L.marker([tgt.lat, tgt.lon], {interactive: false, keyboard: false,
        icon: pinIcon(L, ho && ho.ll ? 'ho' : 'mid', String(icon(ho && ho.ll ? 'bed' : 'building-skyscraper')))}).addTo(map);
      // dashed line: direction only, not the road route
      L.polyline([[LGA.lat, LGA.lon], [tgt.lat, tgt.lon]], {color: tok(box, '--tr-line'), weight: 2.5, dashArray: '2 7', lineCap: 'round', interactive: false}).addTo(map);
      if (N.whereOk()) N.where().then(w => { if (w) showMe(st, w, false); }).catch(() => {});
    }).catch(() => { if (!st.dead && box.isConnected) { box.classList.add('tr-nomap'); box.innerHTML = String(h`<span class="tr-mapph">${icon('map')}The map didn’t load. Directions links still work.</span>`); } });
  }, 300);
}

N.screen('route', {
  nav: 3,
  back: 'transit',
  tone: 'band',
  uses: ['trip', 'guide', 'status', 'force'],
  title: ctx => { const f = findRoute(ctx.param); return f ? str(f.r.name) : 'Route'; },
  render(ctx) {
    const out = routeRender(ctx);
    return {hero: out.hero, body: out.body};
  },
  mount(ctx, view) {
    startRouteMap(ctx, view);
    const unwatch = watchScheme();
    return () => { unwatch(); stopLive('route'); };
  },
  // Data refreshes keep the map: only the text around it is redrawn.
  update(ctx) {
    const view = N.$('#view'), hero = N.$('#hero'), body = N.$('#body');
    const out = routeRender(ctx);
    const f = findRoute(ctx.param), ho = hotelInfo();
    const sig = f ? mapSig(ho) + f.dir + f.r.id : '';
    const st = live.route;
    if (!f || !st || st.sig !== sig || !N.$('[data-tr="top"]', body)) {
      stopLive('route');
      hero.innerHTML = String(out.hero);
      body.innerHTML = String(out.body);
      startRouteMap(ctx, view);
      return;
    }
    hero.innerHTML = String(out.hero);
    N.$('[data-tr="top"]', body).innerHTML = String(safe(() => routeTop(out.dir, out.r, out.R), 'route top'));
    N.$('[data-tr="bot"]', body).innerHTML = String(safe(() => routeBottom(out.dir, out.r, out.R), 'route bottom'));
  },
  actions: {
    trLocate: el => locate(el),
    trZoom: (el, ev, ctx, arg) => zoomBy(+arg || 1),
  },
});

// ---------- #hotel ----------
let codeShown = false;
const MASK = '••••••';
function nearest(ll, n = 8) {
  const places = safe(() => N.food.places(), 'food', []) || [];
  return places.filter(p => obj(p) && hasLL(p) && str(p.id) && str(p.name))
    .map(p => ({p, m: N.dist(ll, p)})).sort((a, b) => a.m - b.m).slice(0, n);
}
function placeRow({p, m}, i) {
  const hrs = safe(() => N.food.hours(p, N.now()), 'hours', null) || {};
  const sub = [str(p.cuisine), str(p.neighborhood)].filter(Boolean).join(' · ');
  const w = N.walkMin(m);
  return h`<a class="tr-place rise" style="${`animation-delay:${i * 35}ms`}" href="${'#place/' + p.id}">
    <span class="tr-num">${i + 1}</span>
    <span class="grow"><b class="ell">${str(p.name)}</b><small class="ell">${sub || 'Food'}</small>
      ${hrs.short || hrs.text ? h`<small class="tr-hrs ${hrs.state || ''}">${hrs.short || hrs.text}</small>` : ''}</span>
    <span class="tr-pd"><b>${w <= 45 ? `${w} min` : N.distText(m)}</b><small>${w <= 45 ? 'walk' : 'away'}</small></span>
  </a>`;
}
function stayDates(ho) {
  const tr = safe(() => N.trip(), 'trip', null) || {};
  const a = /^\d{4}-\d{2}-\d{2}/.test(ho.checkin) ? ho.checkin.slice(0, 10) : str(tr.start);
  const b = /^\d{4}-\d{2}-\d{2}/.test(ho.checkout) ? ho.checkout.slice(0, 10) : str(tr.end);
  const ok = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
  const nights = ok(a) && ok(b) ? Math.round((T(b + 'T12:00:00Z') - T(a + 'T12:00:00Z')) / 86400000) : null;
  const tm = s => { const m = /T(\d{2}):(\d{2})/.exec(s || ''); return m ? N.clockText(+m[1] * 60 + +m[2]) : ''; };
  return {a: ok(a) ? N.date(a + 'T16:00:00Z', 'NYC') : null, b: ok(b) ? N.date(b + 'T16:00:00Z', 'NYC') : null, nights,
    ta: tm(ho.checkin), tb: tm(ho.checkout)};
}
const telOf = phone => {
  const d = String(phone || '').replace(/[^\d+]/g, '');
  if (d.replace(/\D/g, '').length < 7) return null;
  return 'tel:' + (d.startsWith('+') ? d : d.length === 10 ? '+1' + d : d);
};
function hotelEmpty() {
  return {
    hero: h`<div class="tr-hero"><p class="ey">Hotel</p><h1 class="dp tr-dp">No hotel yet</h1></div>`,
    body: h`<div class="tr-body">
      <div class="card tr-empty">
        <span class="ic">${icon('bed')}</span>
        <b>Add your hotel in Wallet</b>
        <p>Name, address and confirmation number stay on this phone. With an address, this page shows the hotel on a map, directions, and the closest places from the food list.</p>
        <a class="btn tr-wide" href="#wallet">${icon('wallet')}Open Wallet</a>
      </div>
      <a class="tr-lk tr-lkc" href="#transit">${icon('route')}<span class="grow">Getting into town from LGA</span>${icon('chevron-right')}</a>
    </div>`,
  };
}
function hotelRender() {
  const ho = hotelInfo();
  if (!ho) return hotelEmpty();
  const w = N.wallet();
  const dates = stayDates(ho);
  const tel = telOf(ho.phone);
  const ll = ho.ll;
  const near = ll ? nearest(ll) : [];
  const code = str(w.hotel_code);
  const dest = ho.address || (ll && ll.exact ? {lat: ll.lat, lon: ll.lon} : null);
  const sz = Math.max(30, Math.min(56, ho.name.length <= 10 ? 56 : ho.name.length <= 16 ? 44 : ho.name.length <= 24 ? 36 : 30));
  return {
    hero: h`<div class="tr-hero">
      <p class="ey">${ho.local ? 'Your hotel · saved in Wallet' : 'Your hotel'}</p>
      <h1 class="dp tr-dp tr-hn" style="${`font-size:${sz}px`}">${ho.name}</h1>
      ${ho.address ? h`<div class="tr-addr"><p>${ho.address}</p><button class="tr-ib" data-act="copy" data-copy="${ho.address}" aria-label="Copy address">${icon('copy')}</button></div>`
        : h`<p class="tr-hsub">No address saved. Add it in Wallet for directions and a map.</p>`}
    </div>`,
    body: h`<div class="tr-body">
      ${dates.a || dates.b ? h`<div class="tr-tiles">
        <div class="tile"><small>Check-in</small><b>${dates.a || '—'}</b>${dates.ta ? h`<span>from ${dates.ta}</span>` : ''}</div>
        <div class="tile"><small>Check-out</small><b>${dates.b || '—'}</b><span>${[dates.tb ? `by ${dates.tb}` : '', dates.nights ? N.plural(dates.nights, 'night') : ''].filter(Boolean).join(' · ')}</span></div>
      </div>` : ''}
      ${tel ? h`<a class="tr-lk tr-lkc" href="${tel}">${icon('phone')}<span class="grow">Call the hotel<small>${ho.phone}</small></span>${icon('chevron-right')}</a>` : ''}
      ${code ? h`<div class="card tight tr-conf">
        <p class="ey">Hotel confirmation</p>
        <div class="tr-cr"><b class="tr-code" data-tr="code">${codeShown ? code : MASK}</b>
          <button class="tr-ib" data-act="trReveal" aria-pressed="${String(codeShown)}" aria-label="${codeShown ? 'Hide confirmation' : 'Show confirmation'}">${icon(codeShown ? 'eye-off' : 'eye')}</button>
          <button class="tr-ib" data-act="trCopyCode" aria-label="Copy confirmation">${icon('copy')}</button></div>
        <small class="tr-cn">${icon('lock')}Stored only on this phone.</small>
      </div>` : h`<a class="tr-lk tr-lkc" href="#wallet">${icon('receipt')}<span class="grow">No hotel confirmation saved<small>Add it in Wallet; it stays on this phone</small></span>${icon('chevron-right')}</a>`}
      ${dest ? h`<div class="sec"><p class="ey">Directions to the hotel</p>
        <div class="tr-dirs">
          <a class="tr-db" href="${appleUrl(dest, 'w')}" target="_blank" rel="noopener">${icon('walk')}Walk</a>
          <a class="tr-db" href="${appleUrl(dest, 'r')}" target="_blank" rel="noopener">${icon('train')}Transit</a>
          <a class="tr-db" href="${appleUrl(dest, 'd')}" target="_blank" rel="noopener">${icon('car')}Drive</a>
        </div></div>` : ''}
      <div class="stack8 tr-trips">
        <a class="tr-lk tr-lkc" href="#transit" data-act="trGo" data-arg="hotel">${icon('plane-arrival')}<span class="grow">From LGA to the hotel</span>${icon('chevron-right')}</a>
        <a class="tr-lk tr-lkc" href="#transit" data-act="trGo" data-arg="lga">${icon('plane-departure')}<span class="grow">From the hotel to LGA</span>${icon('chevron-right')}</a>
      </div>
      ${ll ? h`<div class="sec"><p class="ey">Close by to eat</p>
        <div class="tr-mapc">
          <div class="tr-map tr-hmap" data-tr="hmap" role="img" aria-label="Map of the hotel and nearby places to eat"><span class="tr-mapph">${icon('map')}Loading map…</span></div>
          ${mapControls()}
        </div>
        ${!ll.exact ? h`<p class="tr-note">Hotel pin placed from the street address; it can be off by a block. Walking times are from that pin.</p>` : ''}
        ${near.length ? h`<div class="tr-places">${near.map(placeRow)}</div>`
          : h`<div class="co plain">${icon('info-circle')}<span>The food list isn’t on this phone yet.</span></div>`}
      </div>` : h`<div class="sec"><div class="co plain">${icon('map-pin')}<span>${ho.address ? 'This address couldn’t be placed on the map (it works for Manhattan street addresses between 14th and 125th St). Directions links still work.' : 'Add the hotel address in Wallet to see it on a map with places nearby.'}</span></div>
        <a class="tr-lk tr-lkc" href="#food">${icon('tools-kitchen-2')}<span class="grow">Browse the food list</span>${icon('chevron-right')}</a></div>`}
    </div>`,
  };
}
function startHotelMap(view) {
  stopLive('hotel');
  const ho = hotelInfo();
  const box = N.$('[data-tr="hmap"]', view);
  if (!ho || !ho.ll || !box) return;
  const st = live.hotel = {dead: false, map: null, L: null, me: null, sig: mapSig(ho)};
  const alive = () => !st.dead;
  const near = nearest(ho.ll);
  st.timer = setTimeout(() => {
    baseMap(box, alive).then(res => {
      if (!res) return;
      const {L, map} = res;
      st.L = L; st.map = map;
      st.fit = (withMe) => {
        const pts = [[ho.ll.lat, ho.ll.lon], ...near.map(x => [x.p.lat, x.p.lon])];
        if (withMe && st.me) pts.push([st.me.getLatLng().lat, st.me.getLatLng().lng]);
        map.fitBounds(L.latLngBounds(pts), {paddingTopLeft: [30, 56], paddingBottomRight: [72, 36], maxZoom: 17, animate: false});
      };
      st.fit(false);
      addBase(L, map, box, alive);
      box.classList.add('tr-ready');
      near.forEach((x, i) => {
        const mk = L.marker([x.p.lat, x.p.lon], {keyboard: false, title: str(x.p.name), riseOnHover: true,
          icon: L.divIcon({className: 'tr-pinw', html: `<span class="tr-fpin">${i + 1}</span>`, iconSize: [28, 28], iconAnchor: [14, 14]})}).addTo(map);
        mk.on('click', () => N.go('place/' + x.p.id));
      });
      L.marker([ho.ll.lat, ho.ll.lon], {interactive: false, keyboard: false, zIndexOffset: 400, icon: pinIcon(L, 'ho', String(icon('bed')))}).addTo(map);
      if (N.whereOk()) N.where().then(w => { if (w) showMe(st, w, false); }).catch(() => {});
    }).catch(() => { if (!st.dead && box.isConnected) { box.classList.add('tr-nomap'); box.innerHTML = String(h`<span class="tr-mapph">${icon('map')}The map didn’t load. The list below still works.</span>`); } });
  }, 300);
}

N.screen('hotel', {
  back: 'transit',
  tone: 'band',
  uses: ['trip', 'food', 'force'],
  title: 'Hotel',
  render() { return safe(hotelRender, 'hotel', null) || hotelEmpty(); },
  mount(ctx, view) {
    codeShown = false;
    // a fresh render after mount resets the reveal; the code is masked again on entry
    const c = N.$('[data-tr="code"]', view); if (c) c.textContent = MASK;
    const b = N.$('[data-act="trReveal"]', view); if (b) { b.setAttribute('aria-pressed', 'false'); b.innerHTML = String(icon('eye')); b.setAttribute('aria-label', 'Show confirmation'); }
    startHotelMap(view);
    const unwatch = watchScheme();
    return () => { unwatch(); stopLive('hotel'); codeShown = false; };
  },
  update(ctx, why) {
    const view = N.$('#view'), st = live.hotel, ho = hotelInfo();
    const out = safe(hotelRender, 'hotel', null) || hotelEmpty();
    const keepMap = st && st.sig === mapSig(ho) && N.$('[data-tr="hmap"]', view);
    if (keepMap && why !== 'wallet') return;   // trip/food refresh or theme kept: nothing else here changes
    const shown = codeShown;
    stopLive('hotel');
    N.$('#hero').innerHTML = String(out.hero);
    N.$('#body').innerHTML = String(out.body);
    codeShown = shown;
    startHotelMap(view);
  },
  actions: {
    trReveal(el) {
      codeShown = !codeShown;
      const c = N.$('[data-tr="code"]');
      if (c) c.textContent = codeShown ? str(N.wallet().hotel_code) || MASK : MASK;
      el.setAttribute('aria-pressed', String(codeShown));
      el.setAttribute('aria-label', codeShown ? 'Hide confirmation' : 'Show confirmation');
      el.innerHTML = String(icon(codeShown ? 'eye-off' : 'eye'));
    },
    async trCopyCode() {
      const code = str(N.wallet().hotel_code);
      if (!code) { N.toast('No confirmation saved'); return; }
      try { await navigator.clipboard.writeText(code); N.toast('Confirmation copied'); }
      catch { N.toast('Couldn’t copy'); }
    },
    trGo(el, ev, ctx, arg) { if (DIRS[arg]) chosen = arg; N.go('transit'); },
    trLocate: el => locate(el),
    trZoom: (el, ev, ctx, arg) => zoomBy(+arg || 1),
  },
});
})();
