/* Transit: getting between LGA Terminal B and the hotel.
     #transit             both directions: traffic, weather, the options ranked
                          for right now, MTA alerts, map and ride links, tips
     #route/<dir>/<id>    one option step by step, with a street map
                          (dir is hotel or lga; a bare #route/<id> also works)
     #hotel               the hotel, directions, its confirmation (masked) and
                          the nearest places from the food list on a map
   The hotel comes from the trip, or from Wallet when the trip has none. Wallet
   values never leave the phone (CONTRACT: no fetch, no URL, no logs), so a
   hotel typed into Wallet is never put in a maps or ride link, not even as
   coordinates worked out from its address: those links open the app with no
   destination and the page offers the address to copy and paste instead.
   Location is kept in memory by N.where and only read here. */
(() => {
'use strict';
const {h, icon} = N;

// ---------- defensive readers (any field can be missing) ----------
const arr = v => Array.isArray(v) ? v.filter(x => x != null && x !== '') : [];
const str = v => typeof v === 'string' ? v.trim() : (typeof v === 'number' ? String(v) : '');
const txt = v => typeof v === 'string' ? v.trim() : '';
const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
const obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : null;
const hasLL = o => !!o && num(o.lat) != null && num(o.lon) != null;
const web = u => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u.trim())) ? u.trim() : null;
const T = v => { if (v == null || v === '') return null; const t = new Date(v).getTime(); return Number.isFinite(t) ? t : null; };
// N.bestRoute(dir, now) can ask about another moment: nowAt stands in for the clock meanwhile.
let nowAt = null;
const nowMs = () => nowAt != null ? nowAt : N.now().getTime();
const cap1 = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const andJoin = (a, w = 'and') => a.length < 2 ? (a[0] || '') : a.slice(0, -1).join(', ') + ` ${w} ` + a[a.length - 1];
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
  // A trip hotel with no text name, address or pin is junk; it must not hide a Wallet hotel.
  const usable = v => { const o = obj(v); return o && (txt(o.name) || txt(o.address) || hasLL(o)) ? o : null; };
  let ho = usable(safe(() => N.hotel(), 'hotel', null));
  const w = obj(safe(() => N.wallet(), 'wallet', null)) || {};
  // N.hotel() needs an address; a Wallet hotel saved with only a name (and
  // perhaps its confirmation) still belongs on #hotel.
  if (!ho) {
    if (txt(w.hotel_address)) ho = {name: txt(w.hotel_name) || 'Hotel', address: txt(w.hotel_address), local: true};
    else if (txt(w.hotel_name)) ho = {name: txt(w.hotel_name), address: '', local: true};
  } else if (!ho.local && !txt(ho.address) && !hasLL(ho) && txt(w.hotel_address)) {
    // The trip names the hotel but has no address, and the page asks for one in
    // Wallet: once typed, it has to count (it stays private like any Wallet hotel).
    const same = !txt(w.hotel_name) || txt(w.hotel_name).toLowerCase() === txt(ho.name).toLowerCase();
    ho = {name: txt(w.hotel_name) || txt(ho.name), address: txt(w.hotel_address), local: true,
      phone: same ? ho.phone : '', checkin: ho.checkin || ho.check_in, checkout: ho.checkout || ho.check_out};
  }
  if (!ho) return null;
  const address = txt(ho.address);
  let ll = hasLL(ho) ? {lat: ho.lat, lon: ho.lon, exact: true} : null;
  if (!ll && address) { const g = geocode(address); if (g) ll = Object.assign(g, {exact: false}); }
  return {name: txt(ho.name) || 'Hotel', address, phone: str(ho.phone), ll, local: !!ho.local,
    checkin: str(ho.checkin || ho.check_in), checkout: str(ho.checkout || ho.check_out)};
}
const hotelSig = ho => ho ? [ho.name, ho.address, ho.ll ? ho.ll.lat.toFixed(5) + ',' + ho.ll.lon.toFixed(5) : ''].join('|') : '';

// ---------- links ----------
// Destination for maps and rides: LGA, the trip's own hotel, or Midtown when
// there is no hotel address. A Wallet hotel gives null: its address is private
// (CONTRACT: wallet values never go into a URL), so the app opens with no
// destination and the traveller pastes the address.
function destFor(dir, ho) {
  if (dir === 'lga') return LGA_ADDR;
  if (!ho) return MIDTOWN_ADDR;
  if (ho.local) return ho.address ? null : MIDTOWN_ADDR;
  if (ho.address) return ho.address;
  return ho.ll && ho.ll.exact ? {lat: ho.ll.lat, lon: ho.ll.lon} : MIDTOWN_ADDR;
}
const privateDest = (dir, ho) => dir === 'hotel' && !!ho && ho.local && !!ho.address;
const destText = d => typeof d === 'string' ? d : `${d.lat},${d.lon}`;
const gMode = mode => mode === 'd' ? 'driving' : mode === 'w' ? 'walking' : 'transit';
// Google's directions link with no destination opens an empty "to" box.
const googleUrl = (d, mode) => `https://www.google.com/maps/dir/?api=1${d ? `&destination=${enc(destText(d))}` : ''}&travelmode=${gMode(mode)}`;
const appleUrl = (d, mode) => d ? N.mapsUrl(d, mode)
  : /iPhone|iPad|Macintosh/.test(navigator.userAgent) ? `https://maps.apple.com/?dirflg=${mode}` : googleUrl(null, mode);
function uberUrl(dir, ho) {
  let u = 'https://m.uber.com/ul/?action=setPickup&pickup=my_location';
  const d = destFor(dir, ho);
  if (dir === 'lga') u += `&dropoff[latitude]=${LGA.lat}&dropoff[longitude]=${LGA.lon}&dropoff[formatted_address]=${enc(LGA_ADDR)}`;
  else if (d && typeof d === 'object') u += `&dropoff[latitude]=${d.lat}&dropoff[longitude]=${d.lon}`;
  else if (d) u += `&dropoff[formatted_address]=${enc(d)}`;
  return u;
}
// Lyft only takes coordinates: LGA, or the trip hotel's own pin.
function lyftUrl(dir, ho) {
  if (dir === 'lga') return `https://lyft.com/ride?id=lyft&destination[latitude]=${LGA.lat}&destination[longitude]=${LGA.lon}`;
  if (ho && !ho.local && ho.ll && ho.ll.exact) return `https://lyft.com/ride?id=lyft&destination[latitude]=${ho.ll.lat}&destination[longitude]=${ho.ll.lon}`;
  return 'https://lyft.com/ride?id=lyft';
}
// The address as a copy row, for links that can't carry it.
const copyRow = ho => h`<button class="tr-lk tr-lkc tr-copy" data-act="copy" data-copy="${ho.address}">${icon('copy')}<span class="grow">Copy the hotel address<small class="ell">${ho.address}</small></span></button>`;
const PRIVATE_NOTE = 'Wallet details never go into a link, so these open without a destination: copy the address first, then paste it in.';
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
// The guide marks some figures "(inferred)"; the "~" already says it is approximate.
// A bare number is dollars ("5" alone reads as nothing).
const costOf = r => { const c = r && r.cost; return num(c) != null ? `$${c}` : txt(c).replace(/\s*\((?:inferred|estimated?)\)/gi, '').trim(); };
// The price and what comes on top, so the price keeps to one line:
// "~$44–66 + tolls and tip" gives ['~$44–66', 'plus tolls & tip'], "App fare + $1.50 …" ['App fare', 'plus $1.50 …'].
function costParts(r) {
  const c = costOf(r);
  const m = /^(~?\$[\d.,]+(?:\s*[–-]\s*\$?[\d.,]+)?)\s*(.*)$/.exec(c) || /^(.+?)\s+(\+.+)$/.exec(c);
  if (!m || !m[2]) return [c, ''];
  return [m[1], m[2].replace(/^\+\s*/, 'plus ').replace(/\band\b/g, '&')];
}
const rangeOf = m => {
  // [45, 75], a single number, or numeric strings; zero or less is junk.
  const a = (Array.isArray(m) ? m : [m]).map(v => typeof v === 'string' && v.trim() ? Number(v) : v).filter(v => num(v) != null && v > 0).map(Math.round);
  if (!a.length) return null;
  return a.length > 1 && a[1] !== a[0] ? `${a[0]}–${a[1]}` : `${a[0]}`;
};
// The airport guide's ground options (lga-taxi …) as routes, for old links.
const groundOf = () => arr((N.guideFor('LGA') || {}).ground).filter(g => obj(g) && str(g.id));
const groundAsRoute = g => ({id: g.id, mode: g.mode, name: str(g.name) || 'Ground transport', summary: g.where ? `From the ${str(g.where)}.` : '',
  min: g.min, cost: g.cost, best_when: g.good, avoid_when: g.bad,
  steps: arr(g.steps).map(s => typeof s === 'string' ? {icon: groundStepIcon(s, g.mode), text: s} : s),
  traffic_key: g.mode === 'taxi' || g.mode === 'rideshare' ? 'to_hotel' : null});
// A plain-text step gets its own icon when it names a train ("E (or F…", "LIRR …"), not the route's.
function groundStepIcon(t, mode) {
  if (/\b(subway|train|lirr)\b/i.test(t) || /^[ACEBDFMGJZLNQRW1-7](?= \(| or |\/)/.test(t)) return 'train';
  if (/\b(q70|m60|bus)\b/i.test(t)) return 'bus';
  return MODE[mode] ? MODE[mode].icon : 'point';
}
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
// MTA-coloured bullets from N.route (_route.js); plain theme circles if it isn't there.
const bullet = l => !LINE[l] ? ''
  : typeof (N.route && N.route.badge) === 'function' ? N.route.badge(l, 'tr-b')
  : h`<span class="tr-mta" role="img" aria-label="${l + ' train'}">${l}</span>`;
// The lines you ride on route r, in order: subway letters (on a subway route), Q70, M60 and
// LIRR. "E (or F, M, R, 7)" gives the E alone: the others in brackets are fallbacks.
const pathTags = r => {
  if (modeOf(r).kind !== 'transit') return [];
  // Drop "Terminal B", "Level 2", "Gate C3", "74 St" so their letters and numbers aren't read as lines.
  const s = `${str(r.name)} ${str(r.summary)}`.replace(/\([^)]*\)/g, ' ')
    .replace(/\b(terminals?|level|gates?|concourse|doors?|exit)\s+(?:[A-Z]\d{0,2}|\d{1,2})(?:\s*(?:and|or|&)\s*(?:[A-Z]\d{0,2}|\d{1,2}))*\b/gi, ' ')
    .replace(/\b\d+\s*(st|nd|rd|th|av|ave)\b/gi, ' ');
  const sub = str(r.mode) === 'subway';
  return [...new Set(s.match(/\b(?:Q70|M60|LIRR|[ACEBDFMGJZLNQRWS1-7])\b/g) || [])].filter(t => !LINE[t] || sub);
};
const linesIn = r => pathTags(r).filter(l => LINE[l]);
// Tokens an MTA alert can mention for this route.
const tokensOf = pathTags;
const normKey = v => str(v).toUpperCase().replace(/[-\s]?SBS$/, '').replace(/\s+TRAIN$/, '');
const alertKey = a => normKey(a && a.route);
// Every line an alert names: `route` and the `routes` list (one alert can cover A, C and D).
const alertKeys = a => [...new Set([alertKey(a), ...arr(a && a.routes).map(normKey)].filter(Boolean))];
const routeTag = key => LINE[key] ? bullet(key) : h`<span class="tr-rtag">${key || 'MTA'}</span>`;
// The route's lines as one strip: the Q70 tag, then the E. Only for routes with a subway leg.
const tagStrip = (r, cls = '') => linesIn(r).length ? h`<span class="tr-lines${cls}">${pathTags(r).map(routeTag)}</span>` : '';

// ---------- status: traffic, weather, alerts ----------
const status = () => obj(N.data.status) || {};
// "4:12p" today, "Wed 4:12p" within the week, "Wed 23 Sep" further back:
// an old check never reads as today's.
const clock = iso => {
  const at = T(iso);
  if (at == null) return '';
  const t = N.time(iso, 'NYC');
  if (N.ymd(iso, 'NYC') === N.ymd(N.now(), 'NYC')) return t;
  return Math.abs(nowMs() - at) < 6 * 86400000 ? `${N.date(iso, 'NYC').split(' ')[0]} ${t}` : N.date(iso, 'NYC');
};
// "4:12p" today, else the day as the app writes dates ("Sun 18 Oct").
const dayOrTime = iso => T(iso) == null ? '' : N.ymd(iso, 'NYC') === N.ymd(N.now(), 'NYC') ? N.time(iso, 'NYC') : N.date(iso, 'NYC');
// Minutes since the trip data last checked status (null when it never says).
const statusAge = () => { const at = T(str(status().checked_at)); return at == null ? null : (nowMs() - at) / 60000; };
const STALE_MIN = 180, WX_OLD_MIN = 720;
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
    fresh: age != null && age <= 60 && age > -15,
    // Days-old (or undated) drive times say nothing about the road now: show the guide's range instead.
    old: age == null || age > WX_OLD_MIN || age < -15};
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
// A week-old alert is planned work or long cleared; one with no date is kept.
const ALERT_DAYS = 7;
function alerts() {
  const t = obj(status().transit);
  if (!t) return null;
  const old = nowMs() - ALERT_DAYS * 86400000;
  return arr(t.alerts).filter(a => obj(a) && str(a.text) && !(T(a.updated) != null && T(a.updated) < old));
}
// The way an alert's first sentence names ("Manhattan-bound", "Flushing-bound"): 'city', 'lga'
// or null. An alert for the other way from this trip is left out.
const CITY_BOUND = /\b(?:manhattan|world trade center|brooklyn|coney island(?:-stillwell av)?|downtown|34 st-hudson yards|hudson yards|jackson heights|woodside)-bound\b/i;
const LGA_BOUND = /\b(?:queens|jamaica(?:-179 st)?|flushing(?:-main st)?|forest hills(?:-71 av)?|astoria(?:-ditmars blvd)?|ditmars blvd|laguardia(?: airport)?)-bound\b/i;
function wayOf(a) {
  const s = str(a.text).split(/\.\s/)[0], c = s.search(CITY_BOUND), q = s.search(LGA_BOUND);
  if (c < 0 && q < 0) return null;
  return q < 0 || (c >= 0 && c < q) ? 'city' : 'lga';
}
const ourWay = (a, dir) => { const w = wayOf(a); return !w || w === (dir === 'hotel' ? 'city' : 'lga'); };
const alertsFor = (r, list) => { const k = tokensOf(r); return k.length ? (list || []).filter(a => alertKeys(a).some(x => k.includes(x))) : []; };
// The lines on route r that these alerts name, for "E alert below".
const hitKeys = (r, list) => { const k = tokensOf(r); return [...new Set(list.flatMap(a => alertKeys(a).filter(x => k.includes(x))))]; };
const checkedAt = () => { const at = str(status().checked_at); return T(at) != null ? `Checked ${dayOrTime(at)}` : ''; };

// ---------- direction ----------
// The traveller's pick holds for the rest of that New York day; after that the
// page follows the trip again (an app left open from arrival to return day
// would otherwise still say "To hotel").
let chosen = null;   // {dir: 'hotel' | 'lga', day: 'YYYY-MM-DD'} or null
const nyDay = () => N.ymd(N.now(), 'NYC');
const choose = d => { chosen = DIRS[d] ? {dir: d, day: nyDay()} : null; };
const retLeg = () => safe(() => N.dirLegs('ret')[0], 'ret leg', null) || null;
const outLast = () => { const l = safe(() => N.dirLegs('out'), 'out legs', []) || []; return l[l.length - 1] || null; };
// "AA 1234" (N.flightNo), or '' when the leg names no flight.
const fno = l => l && (str(l.flight) || str(l.num)) ? str(N.flightNo(l)) : '';
// To the hotel until the arrival has landed and the evening is over; the next ride after that is to LGA.
function autoDir() {
  const ph = safe(() => N.phase(), 'phase', 'stay');
  if (ph === 'ret' || ph === 'after') return 'lga';
  const l = outLast(), at = l && T(l.arr && l.arr.time);
  if (ph === 'stay' && at != null && nowMs() - at > 6 * 3600000) return 'lga';
  const rd = retLeg() && str(retLeg().date);
  if (/^\d{4}-\d{2}-\d{2}$/.test(rd)) {
    const d = new Date(rd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
    if (N.ymd(N.now(), 'NYC') >= d.toISOString().slice(0, 10)) return 'lga';
  }
  return 'hotel';
}
const curDir = () => chosen && chosen.day === nyDay() ? chosen.dir : autoDir();

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
    const lv = retLeave(), at = lv && T(lv.at);
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
  const al0 = alerts(), al = al0 && al0.filter(a => ourWay(a, dir));
  return {dir, now, t, when, day, min, weekday, rush, night, early: min < 420 && dir === 'lga', lv: dir === 'lga' ? retLeave() : null,
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
  // A train or bus whose own leave time has passed can't make the flight (the car's time is the plan's).
  if (k !== 'car' && c.lv) { const at = leaveAt(r, c.lv); if (at != null && at < c.now) s -= 6; }
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
    // Only alerts on a train or bus that would otherwise have been close to the top.
    const hit = [...new Set(list.filter(x => modeOf(x.r).kind === 'transit' && x.s + 0.5 >= list[0].s).flatMap(x => hitKeys(x.r, alertsFor(x.r, c.recent))))];
    if (hit.length) pro.push(`alerts on the ${andJoin(hit)}`);
    if (c.night) pro.push('trains and buses run less often at this hour');
    let s = pro.length ? `${cap1(andJoin(pro))}, so a car is the easier ride.`
      : m === 'car' && c.early ? 'Early flight: book the day before so the car is waiting when you come down.'
      : m === 'taxi' ? (c.dir === 'hotel' ? 'Official line on the Level 2 curb, just outside baggage claim. Simplest with bags.' : (c.ho ? 'Door to door with bags; the hotel can call one.' : 'Door to door with bags; hail one on any avenue.'))
      : m === 'rideshare' ? 'The price is fixed before you go.' : txt(r.best_when);
    if (c.trafficNow) s += c.slow ? ` Roads are slow: about ${c.tr.min} min by car.` : ` Roads are normal: about ${c.tr.min} min by car.`;
    return s;
  }
  if (m === 'train' && c.nearRail) return `Your hotel is near ${c.nearRail}; the LIRR takes about 11 min from Woodside.`;
  if (m === 'bus' && c.uptown) return 'Your hotel is uptown, on the M60 route.';
  const road = q70 ? ' Only the Q70 part is on the road.' : '';
  if (c.slow && c.tr.delta != null) return `Roads are ${c.tr.delta} min slower than usual.${road}`;
  if (c.rush) return `Weekday rush hour, when cars crawl.${road}`;
  return txt(r.best_when) || 'Steady in any traffic.';
}
function rank(dir) {
  const c = context(dir);
  const list = routesOf(dir).map((r, i) => ({r, i, s: safe(() => score(r, c), 'score', 0)}))
    .sort((a, b) => b.s - a.s || a.i - b.i);
  const best = list[0] || null;
  return {c, list, best, why: best ? safe(() => whyFor(best.r, c, list), 'why', '') : ''};
}
// When the pick is for: arrival, the trip to LGA, or now.
const bestWhen = c => c.when === 'land' ? 'Best when you land' : c.when === 'leave' ? 'Best on the day' : 'Best now';
// The pill on the pick. On the way to LGA it carries the pick's own leave time: a train leaves earlier than a car.
function bestLabel(c, r) {
  const at = c.when === 'leave' && r ? leaveAt(r, c.lv) : null;
  return at != null ? `Best · leave by ${N.time(at, 'NYC')}` : bestWhen(c);
}

// ---------- shared with Today and Airports ----------
// The pick and leave time this screen shows, so every screen names the same ones. A direction is
// 'hotel' or 'lga'; 'to-hotel', 'to_lga' and the like work too. Anything else gives null.
const dirOf = d => ({hotel: 'hotel', 'to-hotel': 'hotel', to_hotel: 'hotel', lga: 'lga', 'to-lga': 'lga', to_lga: 'lga'})[str(d).toLowerCase()] || null;
// The planned leave for the return flight while that flight is still ahead; null without one.
// Its time is for a car (the plan's drive time).
function retLeave() {
  if (safe(() => N.phase(), 'phase', 'stay') === 'after') return null;
  const lv = obj(safe(() => N.leave('ret'), 'leave', null));
  if (!lv || T(lv.at) == null) return null;
  const leg = obj(lv.leg) || {}, dep = T(obj(leg.dep) && leg.dep.time);
  return dep != null && dep < nowMs() ? null : lv;
}
// When to leave on route r for the planned Terminal B arrival (ms): the plan's time for a car,
// the long end of the ride for a train or bus. Null when the route gives no time.
const hiOf = m => { const rg = rangeOf(m); return rg ? +rg.split('–').pop() : null; };
function leaveAt(r, lv) {
  if (!lv || T(lv.at) == null) return null;
  if (modeOf(r).kind === 'car') return T(lv.at);
  const hi = hiOf(r.min), to = T(lv.arrive);
  return hi && to != null ? to - (hi + (num(lv.buffer) || 0)) * 60000 : null;
}
// N.leaveBy('lga') → {at, late, arrive, bagdrop, drive, buffer, source, mode: 'car'}: the plan's
// leave time by car, which the "Leave the hotel by" card always gives. The pick's own time,
// earlier on a train, is N.bestRoute('lga').leave. Only the trip to LGA has one.
N.leaveBy = dir => {
  if (dirOf(dir) !== 'lga') return null;
  const lv = retLeave();
  if (!lv) return null;
  return {at: lv.at, late: T(lv.at) < nowMs(), arrive: lv.arrive || null, bagdrop: lv.bagdrop || null,
    drive: num(lv.drive), buffer: num(lv.buffer) || 0, source: str(lv.source) || 'typical', mode: 'car'};
};
// N.bestRoute(dir, now) → {id, name, mins: '45–75 min', range: [45, 75], leave, label, why}: the
// option marked best on #transit at `now` (a Date, ISO time or ms; the clock when left out).
// `leave` is when to leave the hotel on that route (to LGA only).
N.bestRoute = (dir, now) => {
  const d = dirOf(dir);
  if (!d) return null;
  const prev = nowAt;
  nowAt = now == null ? null : T(now);
  try {
    const R = rank(d);
    if (!R.best) return null;
    const r = R.best.r, rg = rangeOf(r.min), a = rg ? rg.split('–').map(Number) : [];
    const at = d === 'lga' ? leaveAt(r, R.c.lv) : null;
    return {id: str(r.id), name: str(r.name), mins: rg ? `${rg} min` : '', range: a.length ? [a[0], a[a.length - 1]] : null,
      leave: at != null ? new Date(at).toISOString() : null, label: bestLabel(R.c, r), why: R.why};
  } finally { nowAt = prev; }
};

// ---------- shared pieces ----------
function hotelPill(ho) {
  if (!ho) {
    return h`<a class="tr-pill" href="#wallet/hotel">
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
  // Three lines at most; More shows when clampAlerts finds the text was cut.
  return h`<div class="tr-alert">${routeTag(k)}<div class="grow"><p>${text}</p>
    <div class="tr-af">${up ? h`<small>${up}</small>` : ''}<button class="tr-more" data-act="trMore" aria-expanded="false">More</button></div></div></div>`;
}
// Marks the alerts whose text runs past three lines, once the page is laid out and fonts are in.
function clampAlerts(root) {
  const run = () => N.$$('.tr-alert:not(.open)', root).forEach(el => {
    const p = N.$('p', el);
    if (p) el.classList.toggle('cut', p.scrollHeight > p.clientHeight + 2);
  });
  requestAnimationFrame(run);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(run).catch(() => {});
}
const alertActs = {
  trMore(el) {
    const a = el.closest('.tr-alert');
    if (!a) return;
    const open = a.classList.toggle('open');
    el.setAttribute('aria-expanded', String(open));
    el.textContent = open ? 'Less' : 'More';
  },
};
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
    if (at && at > now && at - now < 18 * 3600000) sub = `${fno(l) || 'Your flight'} lands ${N.time(at, 'LGA')} · Terminal B`;
    else if (at && now >= at && now - at < 4 * 3600000) sub = `${l.state === 'landed' ? 'Landed' : 'Arrived about'} ${N.time(at, 'LGA')} · bags and rides on Level 2`;
    else { const n = R.list.length; sub = n ? `${N.plural(n, 'way')} in from Terminal B` : ''; }
  } else {
    // The return day, while it is still ahead (or today).
    const rd = rl && /^\d{4}-\d{2}-\d{2}$/.test(str(rl.date)) && rl.date >= N.ymd(N.now(), 'NYC') ? rl.date : '';
    ey = `${to} → LGA Terminal B${rd ? ' · ' + N.date(rd + 'T16:00:00Z', 'NYC').split(' ').slice(0, 2).join(' ') : ''}`;
    title = 'To LGA';
    // The wait has no time of its own: it is as old as the last status check, and a line length
    // from hours (or days) ago says nothing about the line now.
    const tsa = obj(N.airportLive('LGA').tsa), age = statusAge();
    if (tsa && num(tsa.wait_min) > 0 && age != null && age <= STALE_MIN && age > -15) {
      sub = `Terminal B TSA about ${N.dur(tsa.wait_min)}${num(tsa.pre_min) > 0 ? ` · PreCheck ${N.dur(tsa.pre_min)}` : ''}`;
      if (age > 45) sub += ` (checked ${clock(status().checked_at)})`;
    } else sub = 'AA check-in: Terminal B, Level 3';
  }
  return h`<p class="ey tr-ey">${ey}</p><h1 class="dp tr-dp">${title}</h1>${sub ? h`<p class="tr-hsub">${sub}</p>` : ''}`;
}
function leaveCard(R) {
  const ph = safe(() => N.phase(), 'phase', 'stay');
  if (ph === 'after') return '';
  const rl = retLeg();
  if (!rl) return '';
  const lv0 = obj(safe(() => N.leave('ret'), 'leave', null));
  const lv = lv0 && T(lv0.at) != null ? lv0 : null;
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
      <p class="tr-lp">${fno(rl) || 'The first flight'} to ${str(rl.to) || 'CLT'} has no confirmed departure. Plan to reach Terminal B ${N.dur(before)} before it leaves; the drive is about ${drive} min${tr ? ` (traffic checked ${clock(tr.at)})` : ' with normal traffic'}. Check the AA app for the time.</p>
    </div>`;
  }
  // None once the flight has left.
  if (!retLeave()) return '';
  const leg = obj(lv.leg) || {}, dep = obj(leg.dep) && leg.dep.time, now = nowMs();
  const late = T(lv.at) < now;
  const src = lv.source === 'traffic' && R.c.tr ? `traffic checked ${clock(R.c.tr.at)}` : 'typical traffic';
  const drive = num(lv.drive) != null ? `${Math.round(lv.drive)} min drive (${src})` : '';
  // The plan's time is for a car. A train or bus leaves earlier, so the card says which is which:
  // the pick's time on top, the other way under it while it can still make the flight.
  const tr = R.list.map(x => x.r).find(r => modeOf(r).kind !== 'car' && (leaveAt(r, lv) || 0) >= now) || null;
  const b = R.best && R.best.r, lead = !late && R.c.when === 'leave' && tr && b === tr ? tr : null;
  const at = lead ? leaveAt(lead, lv) : T(lv.at);
  const rg = r => rangeOf(r.min) ? h` · <span class="nw">${rangeOf(r.min)} min</span>` : '';
  const carLn = (pre = '') => h`<p class="tr-lm${pre ? ' tr-lalt' : ''}">${icon('car')}<span>${pre ? h`Or <b>${N.time(lv.at, 'NYC')}</b> by car` : h`<b>By car</b>`}${drive ? h` · <span class="nw">${drive}</span>` : ''}</span></p>`;
  const trLn = (r, pre = '') => h`<p class="tr-lm${pre ? ' tr-lalt' : ''}">${icon(routeIcon(r))}<span>${pre ? h`Or <b>${N.time(leaveAt(r, lv), 'NYC')}</b> on the ${str(r.name)}` : h`<b>${str(r.name)}</b>`}${rg(r)}</span></p>`;
  const alt = late ? '' : lead ? carLn('or') : tr ? trLn(tr, 'or') : '';
  const both = !!alt, buf = num(lv.buffer) ? `, with your ${lv.buffer} min buffer` : '';
  // Once late, "at Terminal B by" would no longer be true: only the flight and bag drop are left.
  const there = !late && T(lv.arrive) != null ? `${both ? 'Both get you to' : 'At'} Terminal B by ${N.time(lv.arrive, 'LGA')}${buf}` : '';
  const flight = T(dep) != null ? `${fno(leg) || 'Your flight'} leaves ${N.time(dep, 'LGA')}` : '';
  const bag = T(lv.bagdrop) != null ? `bag drop closes ${N.time(lv.bagdrop, 'LGA')}` : '';
  const line = [there, [flight, bag].filter(Boolean).join('; ')].filter(Boolean).map(cap1).join('. ');
  const upd = lv.source !== 'traffic' && !late ? ' Traffic updates closer to the time.' : '';
  return h`<div class="card ${late ? 'rose' : 'sand'} tight tr-leave">
    <p class="ey">${late ? 'Past the leave time' : 'Leave the hotel by'}</p>
    <div class="tr-lrow"><b class="tr-big" data-k="tr-leave">${late ? 'Now' : N.time(at, 'NYC')}</b>${late ? '' : h`<span class="tr-in">in <span data-until="${new Date(at).toISOString()}">${N.until(at)}</span></span>`}</div>
    ${lead ? trLn(lead) : carLn()}${alt}
    ${line ? h`<p class="tr-lp">${line}.${upd}</p>` : ''}
  </div>`;
}
function arrivalLine(R) {
  const l = outLast(), at = l && T(l.arr && l.arr.time), now = nowMs();
  if (!at) return '';
  if (at > now && at - now < 18 * 3600000) {
    // The flight number is in the heading above.
    return h`<div class="co plain">${icon('plane-arrival')}<span><b>Landing ${N.time(at, 'LGA')} · Terminal B.</b> Bags are on Level 2; plan on being at the curb around ${N.time(at + 35 * 60000, 'LGA')}.</span></div>`;
  }
  return '';
}
function trafficCard(dir, R) {
  const c = R.c, tr = c.tr, to = dir === 'lga' ? 'to LGA' : c.ho ? 'by car' : 'to Midtown';
  let head, sub = [], foot = '';
  if (tr && !tr.old) {
    head = tr.fresh ? `About ${carRange(tr.min)} min ${to} now` : `About ${carRange(tr.min)} min ${to} at ${clock(tr.at)}`;
    const slowSegs = tr.segs.filter(s => /slow|heavy|jam|stop/i.test(str(s.status)) || (num(s.mph) != null && s.mph < 25));
    const segText = (slowSegs.length ? slowSegs : tr.segs).slice(0, 3).map(s => num(s.mph) != null ? `${str(s.name)} ${Math.round(s.mph)} mph` : str(s.name));
    const lead = tr.slow ? 'Slow' : tr.delta != null && tr.delta <= 3 ? 'Normal' : tr.delta != null ? 'A bit slow' : '';
    sub.push([lead, ...segText].filter(Boolean).join(' · ') || tr.text);
    foot = [tr.typ != null ? `Usually ${tr.typ} min` : '', tr.at ? `${tr.fresh ? 'Checked' : 'Last checked'} ${clock(tr.at)}` : ''].filter(Boolean).join(' · ');
  } else {
    // No reading to go on: the guide's usual drive, and a word on the rush only near it.
    const car = routesOf(dir).find(r => modeOf(r).kind === 'car' && rangeOf(r.min));
    head = `Usually ${car ? rangeOf(car.min) : dir === 'lga' ? '30–60' : '35–75'} min by car`;
    const rush = !c.weekday ? '' : c.min >= 360 && c.min < 600 ? 'Weekday 7–10a runs slow; allow the long end.'
      : c.min >= 840 && c.min < 1140 ? 'Weekday 4–7p is the slowest; allow the long end.' : '';
    if (rush) sub.push(rush);
    if (tr && clock(tr.at)) foot = `Last checked ${clock(tr.at)}`;
  }
  // A reading more than half a day old says nothing about the weather now.
  const age = statusAge(), w = age != null && age > WX_OLD_MIN ? null : c.w, soon = wetSoon(w);
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
    <div class="${N.cls('rw', !sub.length && !foot && 'c')}"><span class="ic">${icon('traffic-lights')}</span><div class="grow">
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
  const c = R.c, hits = alertsFor(r, c.alerts);
  const rg = rangeOf(r.min);
  const [price, extra] = costParts(r);
  const trk = routeTraffic(r, dir, c);
  // The price and the drive time each keep to one line; the row breaks around them.
  const parts = [price ? h`<span class="nw">${price}</span>${extra ? ' ' + extra : ''}` : '',
    trk && trk.fresh ? h`<span class="nw">${trk.min} min drive now</span>` : ''].filter(Boolean);
  return h`<a class="op tr-op${best ? ' best' : ''} rise" style="${`animation-delay:${k * 40}ms`}" href="${'#route/' + dir + '/' + r.id}">
    <span class="ic">${icon(routeIcon(r))}</span>
    <span class="tr-opm">
      <span class="tr-opn"><b>${str(r.name)}</b></span>
      ${tagStrip(r)}
      <small>${parts.length ? parts.map((p, i) => h`${i ? ' · ' : ''}${p}`) : str(r.summary)}</small>
      ${hits.length ? h`<small class="tr-warn">${icon('alert-triangle')}${andJoin(hitKeys(r, hits))} ${hitKeys(r, hits).length > 1 ? 'alerts' : 'alert'} below</small>` : ''}
    </span>
    <span class="tr-opt">${rg ? h`<b>${rg}</b><small>min</small>` : h`<small>Varies</small>`}</span>
    ${icon('chevron-right', 'tr-chev')}
    ${best ? h`<span class="tr-best"><b>${icon('thumb-up')}${bestLabel(c, r)}</b><span>${R.why}</span></span>` : ''}
  </a>`;
}
// Alerts for the lines these routes ride, this way, from the last week. Other lines are left out.
function alertsSec(dir, R) {
  const toks = [...new Set(routesOf(dir).flatMap(tokensOf))];
  if (!toks.length) return '';
  const ey = h`<p class="ey">Subway and bus alerts</p>`;
  const lines = w => toks.length <= 5 ? `the ${andJoin(toks, w)}` : 'the lines on these routes';
  if (!R.c.hasAlerts) {
    return h`<div class="sec">${ey}<div class="co plain">${icon('info-circle')}<span>No MTA check yet. Alerts for ${lines('and')} show here after the next update.</span></div></div>`;
  }
  const rel = R.c.alerts.filter(a => alertKeys(a).some(x => toks.includes(x)));
  const ck = checkedAt(), stale = statusStale();
  if (!rel.length) {
    return h`<div class="sec">${ey}<div class="co plain">${icon('circle-check')}<span>No alerts for ${lines('or')}${ck ? h`<span class="nw"> · ${ck}</span>` : ''}${stale ? '; there may be new ones since' : ''}.</span></div></div>`;
  }
  return h`<div class="sec">${ey}
    <div class="tr-alerts">${rel.map(alertRow)}</div>
    ${stale && ck ? h`<p class="tr-note">${ck}; these may have cleared since.</p>` : ''}
  </div>`;
}
function linksSec(dir, R) {
  const ho = R.c.ho, d = destFor(dir, ho), priv = privateDest(dir, ho);
  const k = R.best ? modeOf(R.best.r).kind : 'car';
  const mode = k === 'transit' ? 'r' : 'd';
  const note = dir !== 'hotel' ? ''
    : !ho ? 'No hotel saved, so these go to Midtown.'
    : !ho.address && !(ho.ll && ho.ll.exact) ? 'The hotel has no address saved, so these go to Midtown.'
    : priv ? PRIVATE_NOTE
    : !(ho.ll && ho.ll.exact) ? 'Lyft opens without a destination; paste the address there.' : '';
  return h`<div class="sec"><p class="ey">Open in</p>
    ${priv ? copyRow(ho) : ''}
    <div class="tr-links${priv ? ' tr-after' : ''}">
      ${ext(appleUrl(d, mode), 'Maps', 'dk2')}
      ${ext(googleUrl(d, mode), 'Google', 'cr')}
      ${ext(uberUrl(dir, ho), 'Uber', 'cr')}
      ${ext(lyftUrl(dir, ho), 'Lyft', 'cr')}
      ${dir === 'hotel' && ho && ho.address && !priv ? h`<button class="chip ghost tr-chip tr-span" data-act="copy" data-copy="${ho.address}">${icon('copy')}Copy address</button>` : ''}
    </div>
    ${note ? h`<p class="tr-note">${note}</p>` : ''}
  </div>`;
}
// "Check MTA service status…" is what this page already does, so it isn't repeated as a tip.
function tipsSec() {
  const tips = arr(TR().tips).map(str).filter(t => t && !/^check (the )?mta service status/i.test(t));
  if (!tips.length) return '';
  return h`<div class="sec"><p class="ey">Good to know</p><div class="card tight tr-tips"><ul>${tips.map(t => h`<li>${t}</li>`)}</ul></div></div>`;
}
function timesNote(ho) {
  const ll = ho && ho.ll;
  if (!ll) return 'Times are door to door between Terminal B and Midtown.';
  return N.dist(ll, MIDTOWN) <= 2500 ? 'Times are door to door between Terminal B and Midtown, where your hotel is.'
    : 'Times are door to door between Terminal B and Midtown; your hotel is farther out, so allow a little more.';
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
const transitSig = () => ['hotel', 'lga'].map(d => { const R = rank(d); return (R.best ? R.best.r.id : '') + bestLabel(R.c, R.best && R.best.r); }).join('|') + curDir()
  // The leave card turns to "Past the leave time" at the car's time.
  + (N.leaveBy('lga') || {}).late;
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
  mount(ctx, view) { clampAlerts(view); },
  tick() {
    const s = safe(transitSig, 'sig', '');
    if (s && s !== lastSig) N.rerender();
  },
  actions: {
    ...alertActs,
    trDir(el, ev, ctx, arg) {
      if (!DIRS[arg] || arg === curDir()) return;
      choose(arg);
      N.$$('.tr-ps button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.arg === arg)));
      const head = N.$('[data-tr="head"]'), body = N.$('[data-tr="dir"]');
      if (!head || !body) { N.rerender(); return; }
      N.swap([[head, 24, 0], [body, 24, 60]], () => {
        const R = rank(arg);
        head.innerHTML = String(safe(() => heroHead(arg, R), 'hero'));
        body.innerHTML = String(dirBody(arg));
        clampAlerts(body);
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
// Maps on the page are still pictures, so every swipe on them scrolls the page; only the
// full-screen map (full) pans and zooms.
async function baseMap(box, alive, full = false) {
  const L = await N.loadLeaflet();
  if (!alive() || !box.isConnected) return null;
  const map = L.map(box, {zoomControl: false, dragging: full, touchZoom: full, scrollWheelZoom: full, doubleClickZoom: full,
    boxZoom: false, keyboard: false, tap: false, inertia: full, zoomSnap: .25, fadeAnimation: false, zoomAnimation: full,
    maxBoundsViscosity: 1, bounceAtZoomLimits: false, attributionControl: false});
  map.attributionControl = L.control.attribution({position: 'bottomleft', prefix: false}).addTo(map);
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
  if (far) { if (fit) N.toast(`You’re about ${Math.round(N.dist(w, LGA) / 1609.34).toLocaleString('en-US')} mi from LGA; the map stays on New York.`); return; }
  if (st.me) st.me.setLatLng(ll);
  else st.me = L.marker(ll, {interactive: false, keyboard: false, zIndexOffset: 500,
    icon: L.divIcon({className: 'tr-pinw', html: '<span class="tr-me"></span>', iconSize: [22, 22], iconAnchor: [11, 11]})}).addTo(st.map);
  if (fit && st.fit) st.fit(true);
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
// Fit for the maps on the page: room above for the pins' heads, and for the Expand button.
const PAD = {paddingTopLeft: [40, 72], paddingBottomRight: [56, 48]};
// Fits st's map to its points, and the "you" dot when asked.
function fitMap(st, pad, withMe) {
  const b = st.L.latLngBounds(st.pts());
  if (withMe && st.me) b.extend(st.me.getLatLng());
  st.map.fitBounds(b, {...pad, maxZoom: st.maxZoom, animate: !!withMe && !N.reduce && st.map.options.zoomAnimation});
}
// Spreads the numbered pins on a page map so none hides another or the hotel pin's head:
// nearest place first, each moved the shortest way that clears the ones already placed.
// The page map never pans, so the spread holds until the next fit.
function spread(map, mks, home) {
  const sz = map.getSize(), hp = map.latLngToContainerPoint(home);
  // The hotel pin's head and its point on the map; the Expand button.
  const taken = [[hp.x, hp.y - 24, 36], [hp.x, hp.y, 22], [sz.x - 32, sz.y - 32, 40]];
  const inside = (x, y) => x > 16 && y > 16 && x < sz.x - 16 && y < sz.y - 16;
  const clear = (x, y) => inside(x, y) && taken.every(([a, b, r]) => Math.hypot(x - a, y - b) >= r);
  mks.forEach(({mk, ll}) => {
    const p = map.latLngToContainerPoint(ll);
    let at = clear(p.x, p.y) ? [p.x, p.y] : null;
    if (!at) {
      const hit = taken.find(([a, b, r]) => Math.hypot(p.x - a, p.y - b) < r);
      const away = hit ? Math.atan2(p.y - hit[1], p.x - hit[0]) : 0;
      for (let d = 8; !at && d <= 72; d += 8) {
        for (let k = 0; k < 12 && !at; k++) {
          const t = away + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * Math.PI / 6;
          const x = p.x + d * Math.cos(t), y = p.y + d * Math.sin(t);
          if (clear(x, y)) at = [x, y];
        }
      }
    }
    at = at || [p.x, p.y];
    taken.push([at[0], at[1], 30]);
    mk.setLatLng(map.containerPointToLatLng(at));
  });
}

// ---------- full-screen map ----------
// The map on the page is a still picture; the whole of it is the button that opens this one,
// which takes every gesture and is held to the area around the trip. It adds a history entry,
// so Back closes it.
let full = null;
const mapCard = (map, label) => h`<div class="tr-mapc">${map}
  <button class="tr-mapa" data-act="trMapOpen" aria-label="${label}"><span class="tr-mapx">${icon('arrows-maximize')}</span></button></div>`;
// Clear of Close and Zoom in at the top right, and of the home indicator. Even left and right,
// so a fit that hits the outline's edge still centres the trip.
const FULL_PAD = {paddingTopLeft: [48, 120], paddingBottomRight: [48, 72]};
function openFull(st) {
  if (full || !st || st.dead) return;
  const app = N.$('#app') || document.body, view = N.$('#view'), nav = N.$('.nv');
  const el = document.createElement('div');
  el.className = 'tr-full' + (N.reduce ? '' : ' tr-full-in');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', st.label);
  el.innerHTML = String(h`<div class="tr-map tr-fmap" data-tr="fmap"></div>
    <div class="tr-fc">
      <button class="tr-zb" data-act="trFullClose" aria-label="Close map">${icon('x')}</button>
      <div class="tr-fz">
        <button class="tr-zb" data-act="trZoom" data-arg="1" aria-label="Zoom in">${icon('plus')}</button>
        <button class="tr-zb" data-act="trZoom" data-arg="-1" aria-label="Zoom out">${icon('minus')}</button>
        <button class="tr-zb" data-act="trFit" aria-label="Show the whole map">${icon('zoom-reset')}</button>
      </div>
    </div>`);
  app.appendChild(el);
  const fs = full = {st, el, view, nav, top: view ? view.scrollTop : 0, prevFocus: document.activeElement,
    dead: false, map: null, L: null, me: null, maxZoom: st.maxZoom, pts: st.pts, off: []};
  if (view) { view.style.overflow = 'hidden'; view.inert = true; }
  if (nav) nav.inert = true;
  try { history.pushState(Object.assign({}, history.state, {trMap: 1}), ''); fs.pushed = true; } catch { /* Close still works */ }
  const onPop = () => closeFull();
  const onKey = ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); shutFull(); } };
  window.addEventListener('popstate', onPop);
  document.addEventListener('keydown', onKey, true);
  fs.off.push(() => window.removeEventListener('popstate', onPop), () => document.removeEventListener('keydown', onKey, true));
  const x = N.$('[data-act="trFullClose"]', el);
  if (x) x.focus({preventScroll: true});
  const box = N.$('[data-tr="fmap"]', el), alive = () => !fs.dead;
  // Without tiles the map is only the offline outline, so it may not show past that outline's edge.
  const offline = !tilesOk(N.tiles(N.isDark()));
  Promise.all([baseMap(box, alive, true), offline ? getBasemap() : null]).then(([res, gj]) => {
    if (!res) return;
    const {L, map} = res;
    fs.L = L; fs.map = map;
    const bb = gj && Array.isArray(gj.bbox) && gj.bbox.length === 4 && gj.bbox.every(Number.isFinite) ? gj.bbox : null;
    const data = bb ? L.latLngBounds([bb[1], bb[0]], [bb[3], bb[2]]) : null;
    // Limits go on before the first view, so opening never starts with a pan back inside them.
    if (data) { map.setMaxBounds(data); map.setMinZoom(map.getBoundsZoom(data, true)); }
    if (st.me) { const p = st.me.getLatLng(); showMe(fs, {lat: p.lat, lon: p.lng}, false); }
    fs.fit = withMe => fitMap(fs, FULL_PAD, withMe);
    fs.fit(true);
    // Held to what opened in view plus a margin around the trip: zoom in and look around, never get lost.
    const hold = map.getBounds().extend(L.latLngBounds(st.pts()).pad(.6));
    const lim = data ? L.latLngBounds([Math.max(hold.getSouth(), data.getSouth()), Math.max(hold.getWest(), data.getWest())],
      [Math.min(hold.getNorth(), data.getNorth()), Math.min(hold.getEast(), data.getEast())]) : hold;
    map.setMaxBounds(lim);
    map.setMinZoom(Math.max(map.getMinZoom(), Math.min(map.getZoom(), map.getBoundsZoom(lim))));
    addBase(L, map, box, alive);
    box.classList.add('tr-ready');
    st.pins(L, map, true);
  }).catch(() => { if (alive() && box.isConnected) { box.classList.add('tr-nomap'); box.innerHTML = String(h`<span class="tr-mapph">${icon('map')}The map didn’t load.</span>`); } });
}
// Close from the button, Escape or a pin: step back over the history entry the map added.
function shutFull(then) {
  const fs = full;
  if (!fs) return;
  fs.then = then;
  if (fs.pushed && history.state && history.state.trMap) {
    history.back();
    setTimeout(() => { if (full === fs) closeFull(); }, 700);   // in case Back never arrives
  } else closeFull();
}
// quiet: the page is going away, so nothing is restored.
function closeFull(quiet = false) {
  const fs = full;
  if (!fs) return;
  full = null;
  fs.dead = true;
  fs.off.forEach(f => { try { f(); } catch { /* already gone */ } });
  if (fs.map) { try { fs.map.remove(); } catch { /* already gone */ } }
  fs.el.remove();
  if (fs.view) { fs.view.style.overflow = ''; fs.view.inert = false; }
  if (fs.nav) fs.nav.inert = false;
  if (quiet) return;
  if (fs.view) fs.view.scrollTop = fs.top;
  if (fs.then) { fs.then(); return; }
  if (fs.prevFocus && fs.prevFocus.isConnected) fs.prevFocus.focus({preventScroll: true});
}
// Map actions on #route and #hotel.
const mapActs = {
  trMapOpen: () => openFull(live.route || live.hotel),
  trFullClose: () => shutFull(),
  trZoom: (el, ev, ctx, arg) => { if (full && full.map) full.map.setZoom(full.map.getZoom() + (+arg || 1)); },
  trFit: () => { if (full && full.map) full.fit(true); },
  trLocate: el => locate(el),
};

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
// N.icon puts the name into markup unescaped, so only a known sprite id gets through.
const stepIcon = n => { const s = txt(n); return /^[a-z0-9-]+$/.test(s) && document.getElementById('i-' + s) ? s : 'point'; };
function stepsList(r) {
  const steps = arr(r.steps).map(s => typeof s === 'string' ? {text: s} : s).filter(s => obj(s) && txt(s.text));
  if (!steps.length) return h`<div class="co plain">${icon('info-circle')}<span>No step-by-step for this one. ${txt(r.summary)}</span></div>`;
  const mins = s => num(s.min) != null && s.min > 0 ? Math.round(s.min) : 0;
  const total = steps.reduce((a, s) => a + mins(s), 0);
  return h`<ol class="tr-steps">${steps.map((s, i) => h`<li class="tr-st rise" style="${`animation-delay:${i * 50}ms`}">
      <span class="tr-sti">${icon(stepIcon(s.icon))}</span>
      <div class="grow"><p>${txt(s.text)}</p>${txt(s.where) ? h`<small>${icon('map-pin')}${txt(s.where)}</small>` : ''}</div>
      ${mins(s) ? h`<span class="tr-stm">${mins(s)} min</span>` : ''}
    </li>`)}</ol>
    ${total ? h`<p class="tr-note">Steps add up to about ${N.dur(total)}${rangeOf(r.min) ? `; allow ${rangeOf(r.min)} min door to door` : ''}.</p>` : ''}`;
}
function routeTop(dir, r, R) {
  const c = R.c;
  const isBest = R.best && R.best.r.id === r.id;
  const uptown = upOnly(r);
  // The guide times run to Midtown; a hotel well outside it gets a word about that.
  const far = c.ho && c.ho.ll && N.dist(c.ho.ll, MIDTOWN) > 2500;
  const span = uptown ? 'Uptown, not Midtown' : !c.ho ? (dir === 'lga' ? 'From Midtown' : 'To Midtown') : far ? 'Allow a little more' : '';
  const [price, extra] = costParts(r);
  const tiles = [
    ['Door to door', rangeOf(r.min) ? `${rangeOf(r.min)} min` : 'Varies', span],
    ['Cost', price || 'Not listed', extra],
  ];
  const tr = routeTraffic(r, dir, c);
  if (tr && !tr.old) tiles.push([tr.fresh ? 'Drive now' : 'Drive', `${tr.min} min`,
    [tr.typ != null ? `usually ${tr.typ}` : '', `${tr.fresh ? 'checked' : 'last checked'} ${clock(tr.at)}`].filter(Boolean).join(' · ')]);
  const hits = alertsFor(r, c.alerts);
  // On the way to LGA the pick's own leave time (a train leaves earlier than a car).
  const lb = R.best && c.when === 'leave' ? leaveAt(R.best.r, c.lv) : null, lbt = lb != null ? N.time(lb, 'NYC') : '';
  return h`
    <div class="tr-tiles">${tiles.map(([s, b, sp]) => h`<div class="tile"><small>${s}</small><b>${b}</b>${sp ? h`<span>${sp}</span>` : ''}</div>`)}</div>
    ${isBest ? h`<div class="co tr-co">${icon('thumb-up')}<span><b>${bestWhen(c)}.</b> ${lbt ? `Leave the hotel by ${lbt}. ` : ''}${R.why}</span></div>`
      : R.best ? h`<a class="co plain tr-co tr-alt" href="${'#route/' + dir + '/' + R.best.r.id}">${icon('arrows-exchange')}<span class="grow"><b>${bestWhen(c)}:</b> ${str(R.best.r.name)}${lbt ? `, leaving the hotel by ${lbt}` : ''}. ${R.why}</span>${icon('chevron-right')}</a>` : ''}
    ${hits.length ? h`<div class="tr-alerts">${hits.map(alertRow)}</div>` : ''}
    ${txt(r.best_when) || txt(r.avoid_when) ? h`<div class="card tight tr-when">
      ${txt(r.best_when) ? h`<div class="rw tr-wr"><span class="ic">${icon('circle-check')}</span><div><b>Good when</b><small>${txt(r.best_when)}</small></div></div>` : ''}
      ${txt(r.avoid_when) ? h`<div class="rw tr-wr"><span class="ic">${icon('alert-circle')}</span><div><b>Skip when</b><small>${txt(r.avoid_when)}</small></div></div>` : ''}
    </div>` : ''}
    <div class="sec"><p class="ey">Step by step</p>${stepsList(r)}</div>
    <div class="sec">${safe(() => whereCard(dir, r), 'where')}</div>`;
}
function routeBottom(dir, r, R) {
  const ho = R.c.ho, d = destFor(dir, ho), k = modeOf(r).kind, priv = privateDest(dir, ho);
  const book = obj(r.book) && web(r.book.url) ? r.book : null;
  const m = str(r.mode);
  const chips = k === 'transit'
    ? [ext(appleUrl(d, 'r'), 'Maps transit', 'dk2'), ext(googleUrl(d, 'r'), 'Google transit', 'cr')]
    : m === 'rideshare'
      ? [ext(uberUrl(dir, ho), 'Uber', 'dk2'), ext(lyftUrl(dir, ho), 'Lyft', 'cr'), ext(appleUrl(d, 'd'), 'Maps', 'cr')]
      : [ext(appleUrl(d, 'd'), 'Maps', 'dk2'), ext(googleUrl(d, 'd'), 'Google', 'cr')];
  return h`
    ${book ? h`<a class="btn alt tr-wide" href="${web(book.url)}" target="_blank" rel="noopener">${icon('ticket')}${str(book.label) || 'Book'}${icon('arrow-up-right')}</a>` : ''}
    <div class="sec"><p class="ey">Open in</p>
      ${priv ? copyRow(ho) : ''}
      <div class="tr-links${chips.length === 3 ? ' n3' : ''}${priv ? ' tr-after' : ''}">${chips}
        ${dir === 'hotel' && ho && ho.address && !priv ? h`<button class="chip ghost tr-chip tr-span" data-act="copy" data-copy="${ho.address}">${icon('copy')}Copy address</button>` : ''}
      </div>
      ${priv ? h`<p class="tr-note">${PRIVATE_NOTE}</p>` : ''}
    </div>`;
}
function upOnly(r) {
  return /uptown only|not a midtown route/i.test(str(r && r.name) + ' ' + str(r && r.summary));
}
function routeMapCard(dir, R, r) {
  const ho = R.c.ho;
  const ends = upOnly(r) ? `for reference; this route ${dir === 'lga' ? 'starts' : 'ends'} uptown, not in Midtown.`
    : `where the guide’s times ${dir === 'lga' ? 'start' : 'end'}.`;
  const base = !ho ? `No hotel saved: the second pin is Midtown, ${ends}`
    : !ho.ll && !ho.address ? `No hotel address saved: the second pin is Midtown, ${ends}`
    : !ho.ll ? 'Your hotel’s address couldn’t be placed on the map, so the second pin is Midtown.'
    : !ho.ll.exact ? 'Hotel pin placed from the street address; it can be off by a block.' : '';
  // With a hotel pinned, an uptown-only line still has to say it doesn't reach the hotel's door.
  const note = ho && ho.ll && upOnly(r)
    ? `${base ? base + ' ' : ''}This route ${dir === 'lga' ? 'starts' : 'ends'} uptown, not at the hotel pin.` : base;
  return h`<div class="sec"><p class="ey">Map</p>
    ${mapCard(h`<div class="tr-map" data-tr="map" role="img" aria-label="${`Map of LGA Terminal B and ${ho && ho.ll ? ho.name : 'Midtown'}`}"><span class="tr-mapph">${icon('map')}Loading map…</span></div>`, 'Open the map')}
    <div class="tr-mapbar">
      <button class="chip cr tr-chip" data-act="trLocate">${icon('current-location')}<span class="tr-locl">Show where I am</span></button>
      <span class="tr-leg">${icon('plane')}LGA ${ho && ho.ll ? h`${icon('bed')}Hotel` : h`${icon('building-skyscraper')}Midtown`}</span>
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
  const end = upOnly(r) ? 'Uptown' : R.c.ho ? R.c.ho.name : 'Midtown';
  const ey = dir === 'lga' ? `${end} → LGA Terminal B` : `LGA Terminal B → ${end}`;
  return {
    // No illustration here: the summary runs full width and would sit on top of it.
    hero: h`<div class="tr-hero">
      <p class="ey tr-ey">${ey}</p>
      <div class="tr-rh"><span class="tr-rhi">${icon(routeIcon(r))}</span><h1 class="tr-rname" style="${`font-size:${nameSize(name)}px`}">${name}</h1></div>
      ${tagStrip(r, ' tr-hl')}
      ${str(r.summary) ? h`<p class="tr-lede">${str(r.summary)}</p>` : ''}
    </div>`,
    body: h`<div class="tr-body">
      <div data-tr="top">${safe(() => routeTop(dir, r, R), 'route top')}</div>
      ${routeMapCard(dir, R, r)}
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
  const tgt = ho && ho.ll ? {lat: ho.ll.lat, lon: ho.ll.lon} : MIDTOWN;
  const st = live.route = {dead: false, map: null, L: null, me: null, sig: mapSig(ho) + f.dir + f.r.id,
    label: `Map of LGA Terminal B and ${ho && ho.ll ? ho.name : 'Midtown'}`, maxZoom: 15,
    pts: () => [[LGA.lat, LGA.lon], [tgt.lat, tgt.lon]],
    // Two landmarks, neither tappable. No line between them: it would read as the road route.
    pins(L, map) {
      L.marker([LGA.lat, LGA.lon], {interactive: false, keyboard: false, icon: pinIcon(L, 'lga', String(icon('plane')))}).addTo(map);
      L.marker([tgt.lat, tgt.lon], {interactive: false, keyboard: false, zIndexOffset: 1000,
        icon: pinIcon(L, ho && ho.ll ? 'ho' : 'mid', String(icon(ho && ho.ll ? 'bed' : 'building-skyscraper')))}).addTo(map);
    }};
  const alive = () => !st.dead;
  st.timer = setTimeout(() => {
    baseMap(box, alive).then(res => {
      if (!res) return;
      const {L, map} = res;
      st.L = L; st.map = map;
      st.fit = withMe => fitMap(st, PAD, withMe);
      st.fit(false);
      addBase(L, map, box, alive);
      box.classList.add('tr-ready');
      st.pins(L, map, false);
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
    clampAlerts(view);
    const unwatch = watchScheme();
    return () => { unwatch(); closeFull(true); stopLive('route'); };
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
      clampAlerts(body);
      return;
    }
    hero.innerHTML = String(out.hero);
    N.$('[data-tr="top"]', body).innerHTML = String(safe(() => routeTop(out.dir, out.r, out.R), 'route top'));
    N.$('[data-tr="bot"]', body).innerHTML = String(safe(() => routeBottom(out.dir, out.r, out.R), 'route bottom'));
    N.$$('.rise', body).forEach(e => e.classList.remove('rise'));   // a refresh shouldn't replay the entrance
    clampAlerts(body);
  },
  actions: {...mapActs, ...alertActs},
});

// ---------- #hotel ----------
let codeShown = false;
const MASK = '••••••';
const hoursOf = p => safe(() => N.food.hours(p, N.now()), 'hours', null) || {};
// The closest places, the ones open now first. The map numbers its pins in the same order.
function nearest(ll, n = 8) {
  const places = safe(() => N.food.places(), 'food', []) || [];
  const shut = x => /^(open|closing)$/.test(str(hoursOf(x.p).state)) ? 0 : 1;
  return places.filter(p => obj(p) && hasLL(p) && str(p.id) && str(p.name))
    .map(p => ({p, m: N.dist(ll, p)})).sort((a, b) => a.m - b.m).slice(0, n)
    .map(x => ({...x, k: shut(x)})).sort((a, b) => a.k - b.k || a.m - b.m);
}
// Open or not, as Food writes it: a dot and the words ("Open till 11p"); closing soon and
// opening later get a caution dot.
function hrsInfo(hr) {
  switch (hr.state) {
    case 'open': return ['open', hr.until == null ? 'Open 24 hours' : hr.short ? 'Open ' + hr.short.replace(/^Till\b/, 'till') : 'Open now'];
    case 'closing': return ['closing', hr.text || 'Closing soon'];
    case 'closed': return hr.short && hr.short !== 'Closed' ? ['closed later', hr.short] : ['closed', 'Closed'];
    default: return null;
  }
}
function placeRow({p, m}, i) {
  const hrs = hrsInfo(hoursOf(p));
  const sub = [str(p.cuisine), str(p.neighborhood)].filter(Boolean).join(' · ');
  const w = N.walkMin(m);
  return h`<a class="tr-place rise" style="${`animation-delay:${i * 35}ms`}" href="${'#place/' + p.id}">
    <span class="tr-num">${i + 1}</span>
    <span class="grow"><b class="ell">${str(p.name)}</b><small class="ell">${sub || 'Food'}</small>
      ${hrs ? h`<small class="${'tr-hrs ' + hrs[0]}"><span class="tr-hd"></span>${hrs[1]}</small>` : ''}</span>
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
  return {a: ok(a) ? N.date(a + 'T16:00:00Z', 'NYC') : null, b: ok(b) ? N.date(b + 'T16:00:00Z', 'NYC') : null, bYmd: ok(b) ? b : '', nights,
    ta: tm(ho.checkin), tb: tm(ho.checkout)};
}
const tripLk = d => d === 'lga'
  ? h`<a class="tr-lk tr-lkc" href="#transit" data-act="trGo" data-arg="lga">${icon('plane-departure')}<span class="grow">From the hotel to LGA</span>${icon('chevron-right')}</a>`
  : h`<a class="tr-lk tr-lkc" href="#transit" data-act="trGo" data-arg="hotel">${icon('plane-arrival')}<span class="grow">From LGA to the hotel</span>${icon('chevron-right')}</a>`;
const telOf = phone => {
  const d = String(phone || '').replace(/[^\d+]/g, '');
  if (d.replace(/\D/g, '').length < 7) return null;
  return 'tel:' + (d.startsWith('+') ? d : d.length === 10 ? '+1' + d : d);
};
function hotelEmpty() {
  return {
    hero: h`<div class="tr-hero"><p class="ey">Hotel</p><h1 class="dp tr-dp tr-he">Your hotel</h1></div>`,
    body: h`<div class="tr-body">
      <div class="card tr-empty">
        <span class="ic">${icon('bed')}</span>
        <p>Add it for directions, a map and food nearby.</p>
        <a class="btn tr-wide" href="#wallet/hotel">${icon('plus')}Add your hotel</a>
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
  // A trip hotel can go into a directions link; a Wallet one never does (see destFor).
  const priv = ho.local && !!ho.address;
  const dest = ho.local ? null : ho.address || (ll && ll.exact ? {lat: ll.lat, lon: ll.lon} : null);
  const sz = Math.max(30, Math.min(56, ho.name.length <= 10 ? 56 : ho.name.length <= 16 ? 44 : ho.name.length <= 24 ? 36 : 30));
  // Check-out day (or the return flight's day, when the hotel has no dates).
  const today = N.ymd(N.now(), 'NYC'), rl = retLeg();
  const outDay = dates.bYmd ? dates.bYmd === today : !!(rl && str(rl.date) === today);
  const trips = h`<div class="stack8 tr-trips">${outDay ? [tripLk('lga'), tripLk('hotel')] : [tripLk('hotel'), tripLk('lga')]}</div>`;
  return {
    hero: h`<div class="tr-hero">
      <p class="ey">${ho.local ? 'Your hotel · saved in Wallet' : 'Your hotel'}</p>
      <h1 class="dp tr-dp tr-hn" style="${`font-size:${sz}px`}">${ho.name}</h1>
      ${ho.address ? h`<div class="tr-addr"><p>${ho.address}</p><button class="tr-ib" data-act="copy" data-copy="${ho.address}" aria-label="Copy address">${icon('copy')}</button></div>`
        : h`<p class="tr-hsub">No address saved. Add it in Wallet for directions and a map.</p>`}
    </div>`,
    body: h`<div class="tr-body">
      <div data-tr="htop">
      ${dates.a || dates.b ? h`<div class="tr-tiles">
        <div class="tile"><small>Check-in</small><b>${dates.a || '—'}</b>${dates.ta ? h`<span>from ${dates.ta}</span>` : ''}</div>
        <div class="tile"><small>Check-out</small><b>${outDay ? 'Today' : dates.b || '—'}</b><span>${[dates.tb ? `by ${dates.tb}` : '', dates.nights ? N.plural(dates.nights, 'night') : ''].filter(Boolean).join(' · ')}</span></div>
      </div>` : ''}
      ${tel ? h`<a class="tr-lk tr-lkc" href="${tel}">${icon('phone')}<span class="grow">Call the hotel<small>${ho.phone}</small></span>${icon('chevron-right')}</a>` : ''}
      ${code ? h`<div class="card tight tr-conf">
        <p class="ey">Hotel confirmation</p>
        <div class="tr-cr"><b class="tr-code" data-tr="code">${codeShown ? code : MASK}</b>
          <button class="tr-ib" data-act="trReveal" aria-pressed="${String(codeShown)}" aria-label="${codeShown ? 'Hide confirmation' : 'Show confirmation'}">${icon(codeShown ? 'eye-off' : 'eye')}</button>
          <button class="tr-ib" data-act="trCopyCode" aria-label="Copy confirmation">${icon('copy')}</button></div>
        <small class="tr-cn">${icon('lock')}Stored only on this phone.</small>
      </div>` : h`<a class="tr-lk tr-lkc" href="#wallet/hotel">${icon('receipt')}<span class="grow">No hotel confirmation saved<small>Add it in Wallet; it stays on this phone</small></span>${icon('chevron-right')}</a>`}
      ${outDay ? trips : ''}
      ${dest ? h`<div class="sec"><p class="ey">Directions to the hotel</p>
        <div class="tr-dirs">
          <a class="tr-db" href="${appleUrl(dest, 'w')}" target="_blank" rel="noopener">${icon('walk')}Walk</a>
          <a class="tr-db" href="${appleUrl(dest, 'r')}" target="_blank" rel="noopener">${icon('train')}Transit</a>
          <a class="tr-db" href="${appleUrl(dest, 'd')}" target="_blank" rel="noopener">${icon('car')}Drive</a>
        </div>
        <p class="tr-note">Directions start from where you are now.</p></div>` : priv ? h`<div class="sec"><p class="ey">Directions to the hotel</p>
        ${copyRow(ho)}
        <div class="tr-links tr-after">${ext(appleUrl(null, 'r'), 'Maps', 'dk2')}${ext(googleUrl(null, 'r'), 'Google', 'cr')}</div>
        <p class="tr-note">${PRIVATE_NOTE}</p></div>` : ''}
      ${outDay ? '' : trips}
      </div>
      ${ll ? h`<div class="sec"><p class="ey">Close by to eat</p>
        ${mapCard(h`<div class="tr-map tr-hmap" data-tr="hmap" role="img" aria-label="Map of the hotel and nearby places to eat"><span class="tr-mapph">${icon('map')}Loading map…</span></div>`, 'Open the map')}
        ${!ll.exact ? h`<p class="tr-note">Hotel pin placed from the street address; it can be off by a block. Walking times are from that pin.</p>` : ''}
        <div data-tr="hnear">${near.length ? h`<div class="tr-places">${near.map(placeRow)}</div>`
          : h`<div class="co plain tr-nofood">${icon('info-circle')}<span>The food list isn’t on this phone yet.</span></div>`}</div>
      </div>` : h`<div class="sec tr-gap">${ho.address ? h`<div class="co plain">${icon('map-pin')}<span>This address couldn’t be placed on the map (it works for Manhattan street addresses between 14th and 125th St).${priv ? '' : ' Directions links still work.'}</span></div>`
          : h`<a class="tr-lk tr-lkc" href="#wallet/hotel">${icon('map-pin')}<span class="grow">Add the hotel address<small>In Wallet, for a map with places to eat nearby</small></span>${icon('chevron-right')}</a>`}
        <a class="tr-lk tr-lkc" href="#food">${icon('tools-kitchen-2')}<span class="grow">Browse the food list</span>${icon('chevron-right')}</a></div>`}
    </div>`,
  };
}
// The hotel map shows the hotel and its nearest places: either changing redraws it.
const hotelMapSig = ho => ho && ho.ll ? mapSig(ho) + '|' + nearest(ho.ll).map(x => x.p.id).join(',') : '';
// Opening hours of the listed places, to notice when "Open until 11p" goes stale.
const hoursSig = () => {
  const ho = hotelInfo();
  return ho && ho.ll ? nearest(ho.ll).map(x => { const r = safe(() => N.food.hours(x.p, N.now()), 'hours', null) || {}; return `${r.short || r.text || ''}/${r.state || ''}`; }).join('|') : '';
};
let lastHours = '';
// Redraws the words on #hotel and keeps the map. False when the page has to be rebuilt.
function softHotel(out) {
  const body = N.$('#body'), hero = N.$('#hero');
  if (!body || !hero) return false;
  const tmp = document.createElement('div');
  tmp.innerHTML = String(out.body);
  const parts = ['htop', 'hnear'].map(k => [N.$(`[data-tr="${k}"]`, body), N.$(`[data-tr="${k}"]`, tmp)]);
  if (parts.some(([a, b]) => !a || !b)) return false;
  hero.innerHTML = String(out.hero);
  parts.forEach(([a, b]) => { a.innerHTML = b.innerHTML; N.$$('.rise', a).forEach(e => e.classList.remove('rise')); });
  return true;
}
function startHotelMap(view) {
  stopLive('hotel');
  const ho = hotelInfo();
  const box = N.$('[data-tr="hmap"]', view);
  if (!ho || !ho.ll || !box) return;
  const near = nearest(ho.ll);
  const st = live.hotel = {dead: false, map: null, L: null, me: null, sig: hotelMapSig(ho),
    label: 'Map of the hotel and nearby places to eat', maxZoom: 17,
    pts: () => [[ho.ll.lat, ho.ll.lon], ...near.map(x => [x.p.lat, x.p.lon])],
    // Numbered pins match the list below. On the page they are a picture, spread apart so each number
    // reads; on the full map they sit at the real spot with a 44px target that opens the place.
    pins(L, map, isFull) {
      const sz = isFull ? 44 : 28;
      const mks = near.map((x, i) => {
        const mk = L.marker([x.p.lat, x.p.lon], {interactive: isFull, keyboard: false, title: isFull ? str(x.p.name) : '', zIndexOffset: -i * 100,
          icon: L.divIcon({className: 'tr-pinw tr-fhit', html: `<span class="tr-fpin">${i + 1}</span>`, iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2]})}).addTo(map);
        if (isFull) mk.on('click', () => shutFull(() => N.go('place/' + x.p.id)));
        return {mk, ll: L.latLng(x.p.lat, x.p.lon)};
      });
      // The hotel is the landmark everything is measured from, so it draws on top; it takes no taps.
      L.marker([ho.ll.lat, ho.ll.lon], {interactive: false, keyboard: false, zIndexOffset: 1000, icon: pinIcon(L, 'ho', String(icon('bed')))}).addTo(map);
      if (!isFull) { st.spread = () => spread(map, mks, L.latLng(ho.ll.lat, ho.ll.lon)); st.spread(); }
    }};
  const alive = () => !st.dead;
  st.timer = setTimeout(() => {
    baseMap(box, alive).then(res => {
      if (!res) return;
      const {L, map} = res;
      st.L = L; st.map = map;
      st.fit = withMe => { fitMap(st, PAD, withMe); if (st.spread) st.spread(); };
      st.fit(false);
      addBase(L, map, box, alive);
      box.classList.add('tr-ready');
      st.pins(L, map, false);
      if (N.whereOk()) N.where().then(w => { if (w) showMe(st, w, false); }).catch(() => {});
    }).catch(() => { if (!st.dead && box.isConnected) { box.classList.add('tr-nomap'); box.innerHTML = String(h`<span class="tr-mapph">${icon('map')}The map didn’t load. The list below still works.</span>`); } });
  }, 300);
}

// Same hotel, places and theme: only the words are redrawn and the map stays.
function hotelUpdate() {
  const view = N.$('#view'), st = live.hotel, ho = hotelInfo();
  lastHours = safe(hoursSig, 'hours sig', '');
  const out = safe(hotelRender, 'hotel', null) || hotelEmpty();
  const keepMap = st && !st.dead && st.sig === hotelMapSig(ho) && N.$('[data-tr="hmap"]', view);
  if (keepMap && softHotel(out)) return;
  const shown = codeShown;
  stopLive('hotel');
  N.$('#hero').innerHTML = String(out.hero);
  N.$('#body').innerHTML = String(out.body);
  codeShown = shown;
  startHotelMap(view);
}

N.screen('hotel', {
  nav: 3,
  back: 'transit',
  tone: 'band',
  uses: ['trip', 'food', 'force'],
  title: 'Hotel',
  render() { lastHours = safe(hoursSig, 'hours sig', ''); return safe(hotelRender, 'hotel', null) || hotelEmpty(); },
  mount(ctx, view) {
    codeShown = false;
    // a fresh render after mount resets the reveal; the code is masked again on entry
    const c = N.$('[data-tr="code"]', view); if (c) c.textContent = MASK;
    const b = N.$('[data-act="trReveal"]', view); if (b) { b.setAttribute('aria-pressed', 'false'); b.innerHTML = String(icon('eye')); b.setAttribute('aria-label', 'Show confirmation'); }
    startHotelMap(view);
    const unwatch = watchScheme();
    return () => { unwatch(); closeFull(true); stopLive('hotel'); codeShown = false; };
  },
  update: hotelUpdate,
  // Places open and close while the page is open: refresh their hours (and the pins, when the
  // open ones move up the list).
  tick() {
    if (safe(hoursSig, 'hours sig', '') !== lastHours) hotelUpdate();
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
    trGo(el, ev, ctx, arg) { if (DIRS[arg]) choose(arg); N.go('transit'); },
    ...mapActs,
  },
});
})();
