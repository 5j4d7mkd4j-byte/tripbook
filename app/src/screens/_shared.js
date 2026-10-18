/* Helpers shared by several screens. Loads before every screen file (the
   build sorts "_" first). Location never leaves the phone: it is kept in
   memory only and used for distances and "near me" sorting. */
(() => {
// ---------- location ----------
// N.where({fresh}) → Promise<{lat, lon, acc, at} | null>. Asks the system for
// permission the first time; resolves null when denied or unavailable.
// Tests set window.__NYC_WHERE = {lat, lon} to fake a position.
let fix = null, asking = null;
N.lastWhere = () => fix || (window.__NYC_WHERE ? {acc: 20, at: N.now().getTime(), ...window.__NYC_WHERE} : null);
N.where = ({fresh = false} = {}) => {
  if (window.__NYC_WHERE) return Promise.resolve(N.lastWhere());
  if (fix && !fresh && Date.now() - fix.at < 120000) return Promise.resolve(fix);
  if (!navigator.geolocation) return Promise.resolve(null);
  if (asking) return asking;
  asking = new Promise(res => {
    navigator.geolocation.getCurrentPosition(p => {
      fix = {lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy), at: Date.now()};
      N.set('nyc.geo', 1);   // only remembers that location was allowed, never where
      asking = null; N.emit('where', fix); res(fix);
    }, () => { asking = null; res(null); }, {enableHighAccuracy: true, timeout: 12000, maximumAge: 60000});
  });
  return asking;
};
// True once this phone has shared location with the app, so screens can
// fetch it on open instead of waiting for a tap.
N.whereOk = () => !!window.__NYC_WHERE || !!N.get('nyc.geo');

// ---------- New York clock (food hours are local NYC times) ----------
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const nyFmt = new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23'});
N.nyNow = (d = N.now()) => {
  const p = Object.fromEntries(nyFmt.formatToParts(d).map(x => [x.type, x.value]));
  return {day: DAYS.indexOf(p.weekday), min: (+p.hour % 24) * 60 + +p.minute};
};
const toMin = s => { const [h, m] = String(s || '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
// 1290 → "9:30p", 1440 → "12a" (minutes after midnight; past 24:00 wraps)
N.clockText = m => {
  m = ((m % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60), mm = m % 60;
  return `${h % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''}${h < 12 ? 'a' : 'p'}`;
};
N.dayName = (d, long = false) => long ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d] : DAYS[d];

// ---------- food ----------
const F = N.food = {};
// Yelp photo sizes: '348s' square thumb, 'l' ~600px, 'o' original.
F.photo = (id, size = 'l') => id ? `https://s3-media0.fl.yelpcdn.com/bphoto/${encodeURIComponent(id)}/${size}.jpg` : '';
F.photos = p => [...((p && p.photos && p.photos.food) || []), ...((p && p.photos && p.photos.inside) || [])];
F.cover = p => { const a = F.photos(p); return a.length ? a[0].id : null; };
F.place = id => ((N.data.food && N.data.food.places) || []).find(p => p.id === id) || null;
F.places = () => (N.data.food && N.data.food.places) || [];

// Opening hours → {state:'open'|'closing'|'closed'|'unknown', text, short, until}
//   open:    "Open · closes 10p"      closing (≤45 min): "Closes in 20 min"
//   closed:  "Closed · opens 11:30a"  or "Closed · opens Thu 8a"
F.hours = (p, d = N.now()) => {
  const hrs = (p && p.hours) || [];
  if (!hrs.length) return {state: 'unknown', text: 'Hours not listed', short: ''};
  const {day, min} = N.nyNow(d);
  // Intervals as absolute minutes from this Sunday 00:00, including last week's late-night spill.
  const iv = [];
  for (const [dd, a, b] of hrs) {
    let s = toMin(a), e = toMin(b);
    if (e <= s) e += 1440;              // "18:00"-"02:00" style
    for (const wk of [-1, 0, 1]) iv.push([dd * 1440 + s + wk * 10080, dd * 1440 + e + wk * 10080]);
  }
  const t = day * 1440 + min;
  const cur = iv.filter(([s, e]) => s <= t && t < e).sort((x, y) => y[1] - x[1])[0];
  if (cur) {
    const left = cur[1] - t;
    if (cur[1] - cur[0] >= 1439) return {state: 'open', text: 'Open 24 hours', short: 'Open', until: null};
    if (left <= 45) return {state: 'closing', text: `Closes in ${left} min`, short: `Closes ${N.clockText(cur[1])}`, until: cur[1] - t};
    return {state: 'open', text: `Open · closes ${N.clockText(cur[1])}`, short: `Till ${N.clockText(cur[1])}`, until: left};
  }
  const next = iv.filter(([s]) => s > t).sort((x, y) => x[0] - y[0])[0];
  if (!next) return {state: 'closed', text: 'Closed', short: 'Closed'};
  const nd = Math.floor(((next[0] % 10080) + 10080) % 10080 / 1440);
  const when = nd === day && next[0] - t < 1440 ? N.clockText(next[0]) : (next[0] - t < 2880 && nd === (day + 1) % 7 ? 'tomorrow ' : N.dayName(nd) + ' ') + N.clockText(next[0]);
  return {state: 'closed', text: `Closed · opens ${when.trim()}`, short: `Opens ${when.trim()}`, until: null, opensIn: next[0] - t};
};
// Hours for one weekday as text: "8a–3p, 5–10p" or "Closed".
F.dayHours = (p, dd) => {
  const r = ((p && p.hours) || []).filter(h => h[0] === dd).map(([, a, b]) => `${N.clockText(toMin(a))}–${N.clockText(toMin(b))}`);
  return r.length ? r.join(', ') : 'Closed';
};
// Straight-line distance from the last known position, or null.
F.away = (p, here = N.lastWhere()) => (here && p && p.lat != null) ? N.dist(here, {lat: p.lat, lon: p.lon}) : null;
// Photo URLs worth keeping on the phone for offline use: list thumbs plus detail sizes.
F.offlineUrls = (perPlace = 6) => F.places().flatMap(p => {
  const ph = F.photos(p);
  return [ph[0] && F.photo(ph[0].id, '348s'), ...ph.slice(0, perPlace).map(x => F.photo(x.id, 'l'))].filter(Boolean);
});
})();
