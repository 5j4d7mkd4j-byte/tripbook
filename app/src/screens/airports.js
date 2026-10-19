/* Airports: the one you are at or heading to (#airports) and each airport by
   code (#airport/phx|clt|lga). Map first. The hero says where you are going
   (your gate, or the terminal and "Gate TBD"); under it, From and To and the
   walking route on the airport's own indoor map (N.airmap), started from where
   you are once you are there. Then the steps with real times, your flights
   here, getting there or out, food along the route, and the airport's
   reference sections, folded.
   The airport, the visit and the route pick themselves from the clock and,
   when you allow it, your location: within about 5 km of an airport wins.
   Your location, N.airportRoute (from an old #nav link) and the From/To you
   choose stay in memory only; only the Hotel/Home and How choice on an
   arrival is saved, on this phone.
   Seats come only from leg.seats (the Wallet, merged by the model) and are
   only shown on this phone; nothing from the Wallet goes into a link. */
(() => {
'use strict';
const {h, icon, raw} = N;
const T = v => v ? new Date(v).getTime() : NaN;
const okT = v => Number.isFinite(T(v));
const nowMs = () => N.now().getTime();
const str = v => v == null ? '' : String(v);
const arr = v => Array.isArray(v) ? v : [];
const obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : null;
const lc = s => str(s).toLowerCase();
const HR = 3600000;
const DEFAULT_CODES = ['PHX', 'CLT', 'LGA'];
const AA_PHONE = 'tel:+18004337300';

// ---------- data access that never throws ----------
const guide = code => { try { return obj(N.guideFor(code)); } catch (e) { return null; } };
const live = code => { try { return obj(N.airportLive(code)) || {}; } catch (e) { return {}; } };
const legsOf = dir => { try { return arr(N.dirLegs(dir)); } catch (e) { return []; } };
const phase = () => { try { return N.phase(); } catch (e) { return 'before'; } };
const legSt = l => { try { return N.legStatus(l); } catch (e) { return {text: '—', tone: 'neutral'}; } };
const hasIcon = n => !!n && /^[a-z0-9-]+$/.test(n) && !!document.getElementById('i-' + n);
const ic = (n, fb = 'info-circle', cls = '') => icon(hasIcon(n) ? n : fb, cls);
const ext = (url, body, cls = '') => /^(https?:|tel:)/i.test(str(url))
  ? h`<a class="${cls}" href="${url}" target="_blank" rel="noopener">${body}</a>` : '';

// ---------- names and times ----------
const NAMES = {PHX: 'Phoenix', CLT: 'Charlotte', LGA: 'LaGuardia'};
const apName = code => str(guide(code) && guide(code).name).replace(/\s+International\b/i, '').trim() || NAMES[code] || code;
const apCity = code => { const g = guide(code); return str(g && g.city).replace(/\s*\(.*?\)\s*/g, ' ').trim() || {PHX: 'Phoenix', CLT: 'Charlotte', LGA: 'New York'}[code] || code; };
// "AA 123": carrier and number with a no-break space, from the data or the guide's text.
const fnoText = s => str(s).replace(/\b([A-Z]{2})(\d{2,4})\b/g, '$1 $2');
const flightNo = l => {
  if (!l) return '';
  const f = str(l.flight).trim(), m = f.match(/^([A-Z]{2})\s*(\d+)$/);
  return m ? `${m[1]} ${m[2]}` : f || (l.num ? `${l.carrier || 'AA'} ${l.num}` : '');
};
const tzAbbr = (ap, iso) => {
  try {
    const p = new Intl.DateTimeFormat('en-US', {timeZone: N.tz(ap), timeZoneName: 'short'}).formatToParts(iso ? new Date(iso) : N.now());
    const z = (p.find(x => x.type === 'timeZoneName') || {}).value || '';
    return /^(GMT|UTC)/.test(z) ? '' : z;
  } catch (e) { return ''; }
};
// A meta line: parts joined with " · ", each kept whole unless it is long enough to need wrapping.
const meta = parts => parts.filter(Boolean).map((x, i) => h`${i ? ' · ' : ''}${String(x).length <= 28 ? h`<span class="nw">${x}</span>` : x}`);
const sameDay = (a, b, ap) => { try { return !!a && !!b && N.ymd(a, ap) === N.ymd(b, ap); } catch (e) { return false; } };
// "4:31a" today, "Sun 2:31p" on another day (airport-local).
const when = (iso, ap) => !okT(iso) ? '' : sameDay(iso, N.now(), ap) ? N.time(iso, ap) : `${N.date(iso, ap).split(' ')[0]} ${N.time(iso, ap)}`;
const ct = (iso, ap) => N.time(iso, ap).replace(':00', '');   // "5a", "5:15a"
const tmz = (iso, ap) => okT(iso) ? `${N.time(iso, ap)}${tzAbbr(ap, iso) ? ' ' + tzAbbr(ap, iso) : ''}` : '';
const dayOf = (v, code) => v ? N.date(v.at || (v.leg && v.leg.date ? v.leg.date + 'T16:00:00Z' : null), code) : '';
const termLabel = t => !t ? '' : /^\d+$/.test(str(t)) ? `Terminal ${t}` : /^[A-Z]$/i.test(str(t)) ? `Terminal ${str(t).toUpperCase()}` : str(t);
// Minutes after local midnight at the airport.
const localMin = (iso, code) => {
  try {
    const p = new Intl.DateTimeFormat('en-US', {timeZone: N.tz(code), hour: 'numeric', minute: 'numeric', hourCycle: 'h23'}).formatToParts(new Date(iso));
    const g = t => +((p.find(x => x.type === t) || {}).value || 0);
    return (g('hour') % 24) * 60 + g('minute');
  } catch (e) { return null; }
};

// ---------- the trip at this airport ----------
const departed = l => !!l && !l.canceled && !!(l.departed || (l.dep && l.dep.actual) || ['air', 'landed', 'past'].includes(l.state) || (okT(l.dep && l.dep.time) && nowMs() >= T(l.dep.time)));
// What the flight data has confirmed, not what the clock implies: only these say "left" / "landed".
const leftOK = l => !!l && !l.canceled && !!(l.departed || (l.dep && l.dep.actual) || ['air', 'landed'].includes(l.state));
const downOK = l => !!l && !l.canceled && !!(l.landed || (l.arr && l.arr.actual) || l.state === 'landed');

function codes() {
  const out = [];
  for (const d of ['out', 'ret']) legsOf(d).forEach(l => [l.from, l.to].forEach(c => { c = str(c).toUpperCase(); if (/^[A-Z]{3}$/.test(c) && !out.includes(c)) out.push(c); }));
  const ga = obj(N.data.guide && N.data.guide.airports) || {};
  Object.keys(ga).forEach(c => { if (/^[A-Z]{3}$/.test(c) && !out.includes(c)) out.push(c); });
  return (out.length ? out : DEFAULT_CODES.slice()).slice(0, 4);
}
// The airport that matters now: the one you're at (a recent fix within about 5 km)
// first; else by the clock: PHX before the trip and on the leave morning, CLT once
// the first flight is off, LGA after landing and on the return day, then back along the return.
function autoCode() {
  const list = codes();
  const nc = nearCode(list); if (nc) return nc;
  const ph = phase();
  let c = null;
  if (ph === 'out' || ph === 'ret') {
    const legs = legsOf(ph);
    const next = legs.find(l => !departed(l));
    c = next ? next.from : legs.length ? legs[legs.length - 1].to : null;
  } else if (ph === 'stay') {
    const o = legsOf('out'); c = o.length ? o[o.length - 1].to : 'LGA';
  } else {
    const o = legsOf('out'); c = o.length ? o[0].from : 'PHX';
  }
  c = str(c).toUpperCase();
  return list.includes(c) ? c : list[0];
}

// Each time the trip passes through the airport.
// {key, dir, role: depart|connect|arrive, inn (leg landing here), out (leg leaving), leg, at}
function visitsOf(code) {
  const out = [];
  for (const dir of ['out', 'ret']) {
    const legs = legsOf(dir);
    legs.forEach((l, i) => {
      if (l.from === code) {
        const inn = i > 0 && legs[i - 1].to === code ? legs[i - 1] : null;
        out.push({dir, role: inn ? 'connect' : 'depart', inn, out: l});
      } else if (l.to === code && !(legs[i + 1] && legs[i + 1].from === code)) {
        out.push({dir, role: 'arrive', inn: l, out: null});
      }
    });
  }
  out.forEach(v => {
    v.key = `${v.dir}-${v.role}`;
    v.leg = v.out || v.inn;
    v.at = v.role === 'depart' ? v.out.dep.time : v.inn.arr.time;
  });
  return out;
}
function overV(v) {
  if (v.out) return departed(v.out);
  const t = v.inn && v.inn.arr && v.inn.arr.time;
  if (okT(t)) return nowMs() > T(t) + 3 * HR;
  const ph = phase();
  return v.dir === 'out' ? ['stay', 'ret', 'after'].includes(ph) : ph === 'after';
}
const picked = {};   // code → visit key chosen on this phone (memory only)
function curVisit(code, list) {
  if (!list.length) return null;
  const p = picked[code] && list.find(v => v.key === picked[code]);
  return p || list.find(v => !overV(v)) || list[list.length - 1];
}
const roleWord = r => r === 'depart' ? 'Depart' : r === 'connect' ? 'Connect' : 'Arrive';
const gateOf = v => !v ? null : v.role === 'arrive' ? v.inn.arr.gate : v.out.dep.gate;

// ---------- weather, FAA, security ----------
const SHORT_WX = [[/thunder|storm/i, 'Storms'], [/snow|flurr/i, 'Snow'], [/sleet|ice|freezing/i, 'Ice'], [/shower|rain|drizzle/i, 'Rain'],
  [/fog|haze|smoke|mist/i, 'Fog'], [/wind|breez/i, 'Windy'], [/overcast|cloudy/i, 'Cloudy'], [/partly|mostly sunny|mostly clear/i, 'Some sun'], [/sunny|clear/i, 'Clear']];
const shortWx = t => { t = str(t); if (t.length <= 11) return t; const m = SHORT_WX.find(([re]) => re.test(t)); return m ? m[1] : t.split(/\s+/).slice(0, 2).join(' '); };
function wxFor(code, v) {
  const wx = obj(live(code).wx) || {};
  const at = v && v.at;
  if (okT(at)) {
    const id = v.role === 'depart' ? [v.out.id, 'dep'] : [v.inn.id, 'arr'];
    const L = arr(wx.legs).filter(obj);
    const byLeg = L.find(x => x.leg === id[0] && (!x.at || x.at === id[1]));
    const near = (list, win) => list.filter(x => okT(x.t) && Math.abs(T(x.t) - T(at)) <= win).sort((a, b) => Math.abs(T(a.t) - T(at)) - Math.abs(T(b.t) - T(at)))[0];
    const f = byLeg || near(L, 90 * 60000) || near(arr(wx.hourly).filter(obj), 45 * 60000);
    if (f && f.temp_f != null) return {temp: f.temp_f, text: f.text, precip: f.precip_pct, at: f.t || at, fc: true, updated: wx.updated};
  }
  const obs = wx.obs_at || wx.updated;
  if (wx.temp_f != null && okT(obs) && nowMs() - T(obs) < 3 * HR) return {temp: wx.temp_f, text: wx.text, precip: wx.precip_pct, at: obs, fc: false, updated: obs};
  return null;
}
// Guide hours text → {all} | {a, b} minutes after midnight (b may pass 1440) | null.
const clockMin = s => {
  const m = str(s).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m?\.?$/i);
  if (!m) return null;
  let hh = +m[1] % 12; if (/p/i.test(m[3])) hh += 12;
  return hh * 60 + (+m[2] || 0);
};
function hoursRange(s) {
  s = str(s);
  if (/24\s*h|24\/7|around the clock/i.test(s)) return {all: true};
  const m = s.match(/(\d{1,2}(?::\d{2})?\s*[ap])\.?m?\.?\s*(?:[–—-]|to)\s*(\d{1,2}(?::\d{2})?\s*[ap])/i);
  if (!m) return null;
  const a = clockMin(m[1]), b = clockMin(m[2]);
  if (a == null || b == null) return null;
  return {a, b: b <= a ? b + 1440 : b};
}
const openAt = (r, m) => !r || m == null ? null : r.all ? true : (m >= r.a && m < r.b) || (m + 1440 >= r.a && m + 1440 < r.b);
// Guide hours in the app's style: "4:00 a.m.–9:00 p.m." reads "4a–9p".
const apTime = s => str(s).replace(/(\d)\s*([ap])\.?\s?m\.?(?![a-z])/gi, (_, d, p) => d + p.toLowerCase()).replace(/\b(\d{1,2}):00([ap])\b/g, '$1$2');
const clockTxt = m => { m = ((m % 1440) + 1440) % 1440; const hh = Math.floor(m / 60), mm = m % 60; return `${hh % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''}${hh < 12 ? 'a' : 'p'}`; };
// The guide's security step on a departure, if it has one.
const secStep = code => arr(obj(guide(code) && guide(code).steps) ? guide(code).steps.depart : null).filter(obj)
  .find(x => x.icon === 'shield-check' || /security|checkpoint|tsa/i.test(str(x.title))) || null;
// When you go through security on a departure: the guide step, else 90 min before.
function secTime(code, v) {
  if (!v || v.role !== 'depart' || !okT(v.out.dep.time)) return null;
  const s = secStep(code);
  const rel = s && obj(s.rel);
  const m = rel && rel.to === 'dep' && Number.isFinite(+rel.min) ? +rel.min : -90;
  return N.addMin(v.out.dep.time, m);
}
// Checkpoints and lanes shut when you reach security (your security time on a departure, else now), so the
// route goes through one that is open. Hours that cannot be read count as open.
function shutAt(P, code, v) {
  if (!P) return [];
  const st = secTime(code, v), m = localMin(st && T(st) > nowMs() ? st : N.now().toISOString(), code);
  if (m == null) return [];
  return arr(P.data && P.data.pois).filter(q => q && ['checkpoint', 'precheck', 'clear'].includes(q.cat)
    && openAt(hoursRange(q.hours), m) === false).map(q => q.id).sort();
}
// The checkpoint the guide's security step sends you through ("Security at Checkpoint A"), while it is open.
function guideCp(P, code, v) {
  const s = secStep(code), x = s && str(s.title).match(/\bcheckpoint\s+([A-Z0-9]{1,2})\b/i);
  if (!P || !x) return null;
  const qs = arr(P.data && P.data.pois).filter(q => q && q.cat === 'checkpoint' && q.node && lc(shortN(q.n)) === lc(`checkpoint ${x[1]}`));
  return qs.length === 1 && !shutAt(P, code, v).includes(qs[0].id) ? 'poi:' + qs[0].id : null;
}


// ---------- the indoor map, where you are, and the route ----------
const normG = g => str(g).toUpperCase().replace(/\bGATE\b/g, '').replace(/\s+/g, '').replace(/^([A-Z]*)0+(\d)/, '$1$2');
// Indoor maps by code (N.airmap.load): the prepared map, null when there is none on this
// phone, undefined until tried. centers[] is each map's middle, for "which airport am I at".
const Ps = {}, triedAt = {}, centers = {};
const pair = c => { c = arr(c); return c.length >= 2 && Number.isFinite(+c[0]) && Number.isFinite(+c[1]) ? [+c[0], +c[1]] : null; };
function keepP(code, P) {
  Ps[code] = P || null;
  triedAt[code] = Date.now();
  const c = pair(P && P.data ? P.data.center : null);   // [lon, lat]
  if (c) centers[code] = {lat: c[1], lon: c[0]};
}
// The guide's walking map has [lat, lon]; the indoor map [lon, lat].
function centerOf(code) {
  const g = guide(code), c = pair(g && obj(g.nav) ? g.nav.center : null);
  return c ? {lat: c[0], lon: c[1]} : centers[code] || null;
}
// A fix's age against the phone clock and the app clock (a test clock can differ).
const fixAge = w => !w || !Number.isFinite(+w.at) ? Infinity : Math.min(Math.abs(Date.now() - w.at), Math.abs(nowMs() - w.at));
function here(maxAge) {
  let w = null;
  try { w = N.lastWhere ? N.lastWhere() : null; } catch (e) { w = null; }
  return w && Number.isFinite(+w.lat) && Number.isFinite(+w.lon) && fixAge(w) <= maxAge ? w : null;
}
const distTo = (w, code) => {
  const c = centerOf(code);
  if (!w || !c) return Infinity;
  try { const d = N.dist({lat: +w.lat, lon: +w.lon}, c); return Number.isFinite(d) ? d : Infinity; } catch (e) { return Infinity; }
};
const asked = new Set();
const onAirports = () => { const c = N.current && N.current(); return !!(c && c.def) && /^airports?$/.test(c.def.name); };
// An airport with no guide centre gets one from its indoor map, once.
function wantCenter(code) {
  if (asked.has(code) || !N.airmap || Ps[code] !== undefined) return;
  asked.add(code);
  N.airmap.load(code).then(P => { keepP(code, P); if (P && centers[code] && onAirports()) N.rerender(); }).catch(() => {});
}
// The trip airport you are at: a fix from the last 45 min within 5 km of it.
function nearCode(list) {
  const w = here(45 * 60000);
  if (!w) return null;
  let best = null, bd = 5000;
  for (const c of list) { const d = distTo(w, c); if (d < bd) { bd = d; best = c; } }
  if (!best) list.forEach(c => { if (!centerOf(c)) wantCenter(c); });
  return best;
}

// Endpoints are the map's own tokens: 'gate:B11', 'place:baggage', 'poi:<id>' or {pt, level, label}.
const hasPlace = (P, k) => !!P && N.airmap.places(P).some(x => x.kind === k);
const firstPlace = (P, kinds) => { const k = kinds.find(x => !P || hasPlace(P, x)); return k ? 'place:' + k : null; };
// A trip gate as a map ref: exact, else without its letter ("C11" on a map that numbers
// its gates 11, 12…), preferring the concourse with that letter.
function gref(P, gate) {
  const g = normG(gate);
  if (!g) return null;
  if (!P) return 'gate:' + g;
  const refs = [...P.gateByRef.keys()];
  const ex = refs.find(r => normG(r) === g);
  if (ex) return 'gate:' + ex;
  const m = g.match(/^([A-Z]*)(\d+[A-Z]?)$/);
  if (!m) return null;
  const L = m[1], bare = m[2];
  const conc = r => str((P.gateByRef.get(r) || {}).c).toUpperCase();
  const inC = r => !L || new RegExp(`(^|[^A-Z])${L}([^A-Z]|$)`).test(conc(r));
  // A concourse named by a different single letter rules a gate out; a named one ("Eastern") does not.
  const other = r => !!L && /^[A-Z]$/.test(conc(r)) && conc(r) !== L;
  const one = xs => { xs = xs.filter(r => !other(r)); const a = xs.filter(inC); return a.length === 1 ? a[0] : !a.length && xs.length === 1 ? xs[0] : null; };
  const r = one(refs.filter(x => normG(x) === bare)) || one(refs.filter(x => normG(x).replace(/^[A-Z]+/, '') === bare));
  return r ? 'gate:' + r : null;
}
// The carousel the airline posted, when the map names it ("Carousel 5", "Baggage claim 5"), else the nearest one.
function bagRef(P, n) {
  n = str(n).trim().toUpperCase();
  if (!P || !n) return 'place:baggage';
  const num = q => { const x = str(q.n).trim().toUpperCase().match(/(?:^|\s)([A-Z]?\d+[A-Z]?)$/); return x ? x[1] : ''; };
  const qs = arr(P.data && P.data.pois).filter(q => q && q.cat === 'baggage' && q.node && num(q) === n);
  const q = qs.find(x => !/international/i.test(str(x.n))) || (qs.length === 1 ? qs[0] : null);
  return q ? 'poi:' + q.id : 'place:baggage';
}
const KIND_LABEL = {curb_dep: 'Departures curb', curb_arr: 'Arrivals curb', checkin: 'Check-in', checkpoint: 'Security', baggage: 'Baggage claim',
  rideshare: 'Rideshare pickup', taxi: 'Taxi stand', bus: 'Bus stop', shuttle: 'Shuttle', train: 'Train', subway: 'Subway', parking: 'Parking',
  rental_car: 'Rental cars', exit: 'Exit'};
// How you leave on an arrival: [id, label, icon].
const HOW = [['rideshare', 'Rideshare', 'car-suv'], ['taxi', 'Taxi', 'car'], ['transit', 'Transit', 'train'], ['pickup', 'Pickup', 'users']];
function exitKinds(how, out) {
  if (how === 'rideshare') return ['rideshare', 'curb_arr', 'exit'];
  if (how === 'taxi') return ['taxi', 'curb_arr', 'exit'];
  if (how === 'pickup') return ['curb_arr', 'exit'];
  const r = out ? transitPick('hotel') : null;
  return r && /bus|\bq\d+|\bm\d+/i.test(str(r.name)) ? ['bus', 'train', 'subway', 'shuttle', 'curb_arr', 'exit'] : ['train', 'subway', 'bus', 'shuttle', 'curb_arr', 'exit'];
}
// Map overlays, off until you turn them on: [id, label, icon, the map's chip ids].
const OVER = [['food', 'Food', 'tools-kitchen-2', ['food', 'coffee']], ['restroom', 'Restrooms', 'toilet-paper', ['restroom']], ['water', 'Water', 'droplet', ['water']]];
const POI_IC = {food: 'tools-kitchen-2', bar: 'glass-cocktail', coffee: 'coffee', restroom: 'toilet-paper', water: 'droplet', shop: 'shopping-bag'};
const fmtM = m => m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`;
const lvName = (P, l) => { const x = P && P.levels.get(l); return x ? `Level ${x.short || x.id}` : ''; };

// Where you head after landing (Hotel or Home) and how: saved on this phone per airport.
function exitPref(code, v) {
  let all = null;
  try { all = obj(N.get('nyc.ap.exit', null)); } catch (e) { all = null; }
  const saved = obj(all && all[code]) || {};
  const dir = v ? v.dir : 'out';
  const to = saved.to === 'home' || saved.to === 'hotel' ? saved.to : dir === 'ret' ? 'home' : 'hotel';
  let how = HOW.some(x => x[0] === saved.how) ? saved.how : '';
  if (!how) {
    if (to === 'home') how = 'pickup';
    else {
      const r = dir === 'out' ? transitPick('hotel') : null, n = str(r && r.name);
      how = /taxi|cab/i.test(n) ? 'taxi' : /bus|train|subway|rail|metro|express|\bq\d+|\bm\d+/i.test(n) ? 'transit' : 'rideshare';
    }
  }
  return {to, how, set: !!saved.how};
}
// "About 45–60 min to the hotel by …": Transit's own figure, else the guide's ground row.
function exitEta(code, v, ex) {
  if (!v || v.role !== 'arrive' || ex.to !== 'hotel' || v.dir !== 'out' || ex.how === 'pickup') return '';
  if (ex.how === 'transit') {
    const r = transitPick('hotel'), m = r ? minsTxt(r.range || r.mins) : '';
    return m ? `About ${m} to the hotel by ${r.name}` : '';
  }
  const g = guide(code), want = ex.how === 'taxi' ? ['taxi', 'car'] : ['rideshare', 'car'];
  const x = arr(g && g.ground).filter(obj).find(r => want.includes(lc(r.mode)));
  const mn = x ? arr(x.min).filter(n => Number.isFinite(+n)) : [];
  return mn.length ? `About ${mn[0]}${mn[1] != null && +mn[1] !== +mn[0] ? `–${mn[1]}` : ''} min by ${ex.how === 'taxi' ? 'taxi' : 'car'}` : '';
}
// The route this visit needs, before you choose anything.
function defaults(P, code, v, qG, bags, ex) {
  const d = {from: null, to: null, via: [], tbd: false, off: false, gate: ''};
  if (!v) {
    if (qG) {
      d.gate = qG;
      d.from = firstPlace(P, ['curb_dep', 'checkin', 'checkpoint']);
      d.to = gref(P, qG);
      d.off = !!P && !d.to;
    }
    return d;
  }
  if (v.role === 'arrive') {
    const gi = gref(P, v.inn.arr.gate);
    const bg = firstPlace(P, ['baggage']) && bagRef(P, v.inn.arr.baggage);
    d.from = gi || bg;
    d.to = firstPlace(P, exitKinds(ex.how, v.dir === 'out'));
    if (bags > 0 && gi && bg) d.via = [bg];
    return d;
  }
  d.from = v.role === 'connect' ? gref(P, v.inn.arr.gate) : firstPlace(P, ['curb_dep', 'checkin', 'checkpoint']);
  d.gate = str(v.out.dep.gate) || qG;
  d.to = gref(P, d.gate) || (v.role === 'depart' ? guideCp(P, code, v) || firstPlace(P, ['checkpoint']) : null);
  if (v.role === 'depart' && bags > 0 && hasPlace(P, 'checkin') && d.from !== 'place:checkin'
    && (!okT(v.out.dep.time) || nowMs() < T(N.addMin(v.out.dep.time, -N.AA.bagdrop)))) d.via = ['place:checkin'];
  d.tbd = !d.gate;
  d.off = !!d.gate && !!P && !gref(P, d.gate);
  return d;
}
const epKey = x => x && typeof x === 'object' ? `pt:${(+x.pt[0]).toFixed(5)},${(+x.pt[1]).toFixed(5)},${x.level}` : str(x);
// Routes are cached so the same From/To gives the same object (the map skips a redraw).
const RC = new Map();
function routeFor(P, from, to, via, shut) {
  if (!P || !from || !to || !N.airmap) return null;
  via = arr(via); shut = arr(shut);
  const k = `${P.code}|${epKey(from)}|${epKey(to)}|${via.join(',')}|${shut.join(',')}`;
  if (RC.has(k)) return RC.get(k);
  let R = null;
  try {
    R = N.airmap.route(P, from, to, {via, tsa: 'std', shut});
    if (!R && via.length) R = N.airmap.route(P, from, to, {tsa: 'std', shut});
  } catch (e) { N.report(e, 'airports route'); R = null; }
  if (RC.size > 40) RC.clear();
  RC.set(k, R);
  return R;
}
// A chosen endpoint (or an old #nav link's) as a map token; undefined means "use the default".
function tok(P, v, x) {
  if (x == null || x === '') return undefined;
  if (typeof x === 'object') return x;
  const s = str(x).trim();
  if (s === '@arr') return (v && v.inn && gref(P, v.inn.arr.gate)) || undefined;
  if (s === '@dep') return (v && v.out && gref(P, v.out.dep.gate)) || undefined;
  if (s === '@bag') return 'place:baggage';
  if (s === '@here' || !s) return undefined;
  if (s.includes(':')) return s;
  if (KIND_LABEL[s]) return 'place:' + s;
  if (/^[A-Z]{0,2}\d{1,3}[A-Z]?$/i.test(s)) return gref(P, s) || undefined;
  return 'poi:' + s;
}
const shortN = s => str(s).replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
function epLabel(P, x, stop) {
  if (!x) return 'Choose';
  if (typeof x === 'object') return str(x.label) || 'Your location';
  if (stop && stop.kind === 'pt') return 'Your location';
  // A bare "Door" says less than the kind of place it is ("Departures curb").
  if (stop && stop.label) { const l = shortN(stop.label) || stop.label; return /^(doors?|entrance|exit)$/i.test(l) && KIND_LABEL[stop.kind] ? KIND_LABEL[stop.kind] : l; }
  const s = str(x), i = s.indexOf(':'), pre = i > 0 ? s.slice(0, i) : '', rest = i > 0 ? s.slice(i + 1) : s;
  if (pre === 'gate') return `Gate ${rest}`;
  if (pre === 'place') return KIND_LABEL[rest] || rest.replace(/_/g, ' ');
  if (pre === 'poi') { const q = P && P.poiById.get(rest); return q ? shortN(q.n) || 'Place' : 'Place'; }
  return s;
}

const sel = {};   // `${code}|${visit}` → {from, to, via} chosen on this phone (memory only)
// Everything the map, the hero and the route list need, worked out once per paint.
function plan(ctx) {
  const code = codeOf(ctx), list = visitsOf(code), v = curVisit(code, list);
  const P = Ps[code] || null, qG = qGate(ctx);
  let bags = 0;
  try { const w = N.wallet ? N.wallet() : null; bags = w && Number.isFinite(+w.bags) ? +w.bags : 0; } catch (e) { bags = 0; }
  const ex = exitPref(code, v);
  const d = defaults(P, code, v, qG, bags, ex);
  const k = `${code}|${v ? v.key : ''}`, s = sel[k] || {};
  const pf = tok(P, v, s.from), pt = tok(P, v, s.to);
  const userFrom = pf !== undefined, userTo = pt !== undefined;
  let from = userFrom ? pf : d.from;
  const to = userTo ? pt : d.to;
  let via = s.via ? arr(s.via).map(x => tok(P, v, x)).filter(Boolean) : userFrom || userTo ? [] : d.via;
  const shut = shutAt(P, code, v);
  let R = P ? routeFor(P, from, to, via, shut) : null;
  let you = null, fromHere = false;
  const w = here(10 * 60000);
  if (w && P && distTo(w, code) <= 3000) {
    const acc = Number.isFinite(+w.acc) ? +w.acc : 30;
    you = {lon: +w.lon, lat: +w.lat, acc, level: null};
    // At the airport and not choosing a start: the route starts where you are.
    if (!userFrom && to && !(v && overV(v)) && acc <= 150) {
      const lv = R ? R.from.l : P.data.defaultLevel;
      let nn = null;
      try { nn = N.airmap.nearest(P, [you.lon, you.lat], lv); } catch (e) { nn = null; }
      if (nn && nn.dist_m <= 400) {
        const p0 = {pt: [you.lon, you.lat], level: nn.level, label: 'Your location'};
        let R1 = routeFor(P, p0, to, via, shut);
        // Past check-in already (the route would leave the secure area to get back): skip it.
        if (R1 && via.length && !(v && v.role === 'arrive') && arr(R1.steps).some(x => x.kind === 'exit')) { via = []; R1 = routeFor(P, p0, to, via, shut); }
        // Landed with bags and still airside: the way out passes the carousels, so the route goes by them.
        if (R1 && !via.length && !userTo && !s.via && v && v.role === 'arrive' && bags > 0 && hasPlace(P, 'baggage')
          && arr(R1.steps).some(x => x.kind === 'exit')) {
          const bg = bagRef(P, v.inn.arr.baggage), R2 = routeFor(P, p0, to, [bg], shut);
          if (R2) { via = [bg]; R1 = R2; }
        }
        if (R1) { from = p0; R = R1; fromHere = true; you.level = nn.level; }
      }
    }
  }
  return {code, list, v, P, qG, bags, ex, d, from, to, via, R, you, k, fromHere, userFrom, userTo, shut};
}

// ---------- hero ----------
// Where you are going first: the gate (or the terminal and "Gate TBD"), the bags or the way out.
function heroHtml(code, v, list, auto, m) {
  const g = guide(code), P = m ? m.P : null, d = m ? m.d : {};
  const term = !v ? null : v.role === 'connect' ? v.out.dep.terminal || v.inn.arr.terminal : v.role === 'depart' ? v.out.dep.terminal : v.inn.arr.terminal;
  const terms = arr(g && g.terminals).filter(obj);
  const tl = term ? termLabel(term) : terms.length === 1 ? str(terms[0].name) : '';
  // Time and zone never split across lines ("5:59a" / "MST").
  const tz = iso => h`<span class="nw">${tmz(iso, code)}</span>`;
  // Past tense only once the flight data says so; a passed time alone reads "due … · not confirmed yet".
  const said = (l, iso, done, verb, past, what) => l.canceled ? 'canceled' : done ? h`${past} ${tz(iso)}`
    : nowMs() >= T(iso) ? h`${l.state === 'past' ? 'was due' : 'due'} ${tz(iso)} · <span class="nw">${what} not confirmed yet</span>` : h`${verb}${verb ? ' ' : ''}${tz(iso)}`;
  let l1 = '';
  if (v && v.role === 'depart') {
    const l = v.out;
    l1 = okT(l.dep.time) ? h`${flightNo(l)} to ${apCity(l.to)}, ${said(l, l.dep.time, leftOK(l), '', 'left', 'departure')}` : `${flightNo(l)} to ${apCity(l.to)}, time not confirmed`;
  } else if (v && v.role === 'connect') {
    l1 = okT(v.inn.arr.time) && okT(v.out.dep.time)
      ? `${N.dur(N.mins(v.inn.arr.time, v.out.dep.time))} between ${flightNo(v.inn)} and ${flightNo(v.out)}`
      : `${flightNo(v.inn)} in, ${flightNo(v.out)} out, times not confirmed`;
  } else if (v) {
    const l = v.inn;
    l1 = okT(l.arr.time) ? h`${flightNo(l)} from ${apCity(l.from)}, ${said(l, l.arr.time, downOK(l), 'lands', 'landed', 'landing')}` : `${flightNo(l)} from ${apCity(l.from)}, time not confirmed`;
  } else l1 = 'Not on your trip';
  const lg = v ? (v.role === 'arrive' ? v.inn : v.out) : null;
  const boards = lg && v.role !== 'arrive' && !lg.canceled && !departed(lg) && okT(lg.dep.time) ? h`<span class="nw">Boards ${N.time(N.addMin(lg.dep.time, -N.AA.board), code)}</span>` : '';
  // The day is on the visit switch under the hero when there is more than one visit.
  const sub2 = [v && list.length < 2 ? h`<span class="nw">${roleWord(v.role)} ${dayOf(v, code)}</span>` : '', boards].filter(Boolean);
  // Status of the flight that matters here: rose only when the model says it is bad.
  const st = lg ? legSt(lg) : null;
  const stT = st ? str(st.text).split(' · ').pop() : '';
  // "Done" adds nothing to "was due …" or "left …" in the line below.
  const chip = lg && stT && stT !== '—' && stT !== 'Done' ? h`<span class="chip ${st.tone === 'bad' ? 'rose' : 'ob'} ap-hs" data-k="ap-hs-${lg.id}">${stT}</span>` : '';

  // The big line.
  let lab = 'Airport', val = code, long = false, tbd = false, wantBags = false;
  const gate = str(d.gate).toUpperCase();
  if (v && v.role !== 'arrive') {
    if (gate) { lab = v.role === 'connect' ? 'Next gate' : 'Your gate'; val = gate; }
    else {
      // "Terminal 4" shows 4; "Main Terminal" shows Main. With no terminal on the flight,
      // an airport with one terminal still names it.
      const t = str(term || tl).replace(/^terminal\s*/i, '').replace(/\s*terminal$/i, '').trim();
      if (t && t.length <= 3) { lab = 'Terminal'; val = t.toUpperCase(); }
      else if (t && t.length <= 14) { lab = 'Terminal'; val = t; long = t.length > 5; }
      tbd = !v.out.canceled;
    }
  } else if (v) {
    const bag = str(v.inn.arr.baggage);
    wantBags = !!m && m.bags > 0 && !overV(v);
    if (wantBags && bag) { lab = 'Carousel'; val = bag; long = bag.length > 4; }
    else if (wantBags) { lab = 'Next'; val = 'Baggage claim'; long = true; }
    else {
      lab = m && m.ex.to === 'home' ? 'Way home' : 'Way out';
      const kind = typeof d.to === 'string' && d.to.startsWith('place:') ? d.to.slice(6) : '';
      const how = HOW.find(x => m && x[0] === m.ex.how);
      val = kind && kind !== 'exit' ? KIND_LABEL[kind] : how ? how[1] : 'Exit';
      long = true;
    }
  } else if (m && m.qG) { lab = 'Gate'; val = m.qG.toUpperCase(); }

  // The line under it: where the gate is and how long the walk is.
  const sameTo = m && epKey(m.to) === epKey(d.to);
  const R = !m || !P ? null : sameTo && epKey(m.from) === epKey(d.from) || (sameTo && m.fromHere) ? m.R : routeFor(P, d.from, d.to, d.via, m.shut);
  const here2 = !!(m && m.fromHere && R === m.R);
  const walk = R && R.hops && R.hops.length ? `${R.mins} min${arr(R.steps).some(x => x.kind === 'security') ? ' with security' : ' walk'}${here2 ? ' from you' : ''}` : '';
  const gm = [];
  if (v && v.role !== 'arrive' || (!v && m && m.qG)) {
    if (gate && d.off) gm.push(`Gate ${gate} isn’t on this map`);
    else if (gate) {
      const ref = typeof d.to === 'string' && d.to.startsWith('gate:') ? d.to.slice(5) : '';
      const gx = P && ref ? P.gateByRef.get(ref) : null;
      if (gx && gx.c) gm.push(/^[A-Z]$/i.test(str(gx.c)) ? `Concourse ${str(gx.c).toUpperCase()}` : `${gx.c} concourse`);
      if (gx) gm.push(lvName(P, gx.l));
      if (R && R.hops && !R.hops.length) gm.push('You’re at the gate');
      else if (walk) gm.push(walk);
    } else if (tbd) {
      gm.push('Gate shows here once AA posts it');
      if (walk && v.role === 'depart') gm.push(`${R.mins} min${here2 ? ' from you' : ''} to ${R.to && R.to.kind === 'checkpoint' && shortN(R.to.label) || 'security'}`);
    }
  } else if (v) {
    // The time onward to the hotel or home is under the map, with the Hotel/Home and How choice.
    // With bags to collect, the walk to the way out comes after them.
    const out = shortN(R && R.to.label) || 'the way out';
    if (R && R.hops && R.hops.length) {
      gm.push(!wantBags ? `${R.mins} min walk to ${out}` : arr(R === m.R ? m.via : d.via).length ? `${R.mins} min walk via the bags to ${out}` : `Then a ${R.mins} min walk to ${out}`);
    }
  }
  const art = (() => { try { return raw(N.airportIllo ? N.airportIllo(code) || '' : ''); } catch (e) { return ''; } })();
  const showNow = !!m && (code !== auto || !!picked[code] || Object.keys(sel).some(x => x.startsWith(code + '|') && Object.keys(sel[x] || {}).length));
  return h`<div class="${N.cls('ap-hero ap-h2', long && 'ap-hl')}">
    <div class="ap-row">
      <div class="ps ap-ps" role="group" aria-label="Airport">${codes().map(c => h`<button type="button" data-act="ap" data-arg="${lc(c)}" aria-pressed="${c === code ? 'true' : 'false'}">${c}${c === auto ? h`<i class="ap-nd" aria-hidden="true"></i><span class="ap-vh">, now</span>` : ''}</button>`)}</div>
      ${showNow ? h`<button type="button" class="ap-now" data-act="now">${ic('current-location', 'clock')}<span>Now</span></button>` : ''}
    </div>
    <div class="ap-top">
      <div class="ey ap-ey">${meta([apName(code), lab === 'Terminal' ? '' : tl])}</div>
      <div class="ap-lab">${lab}</div>
      <div class="${N.cls('dp ap-big', long && 'long')}" data-k="ap-big-${code}-${v ? v.key : ''}">${val}</div>
      ${gm.length ? h`<p class="ap-gm" id="ap-gm">${meta(gm)}</p>` : ''}
      <div class="ap-sub"><b data-k="ap-h1-${code}-${v ? v.key : ''}">${l1}</b><div class="ap-s2">${chip}<span>${sub2.map((x, i) => h`${i ? ' · ' : ''}${x}`)}${sub2.length ? ' · ' : ''}<span class="nw">${sub2.length ? 'it’s' : 'It’s'} <span class="tn" data-clock="${code}">${N.time(N.now(), code)}</span>${tzAbbr(code) ? ` ${tzAbbr(code)}` : ''} here</span></span></div></div>
    </div>
    ${art}
  </div>`;
}
// ---------- tiles ----------
function tilesHtml(code, v) {
  const L = live(code), faa = obj(L.faa), tsa = obj(L.tsa) || {}, g = guide(code);
  const wx = wxFor(code, v);
  // The label says when (a forecast to the nearest hour), the subline says what.
  const wxT = wx
    ? {l: wx.fc ? `Weather at ${ct(new Date(Math.round(T(wx.at) / HR) * HR).toISOString(), code)}` : 'Weather now',
      b: `${Math.round(+wx.temp)}°`, s: shortWx(wx.text) || 'Forecast', c: /storm|snow|ice|sleet/i.test(str(wx.text)) || +wx.precip >= 60}
    : {l: 'Weather', b: '—', s: 'No reading'};
  const fs = faa && lc(faa.status);
  const faaT = !faa || !fs ? {b: '—', s: 'Not checked'}
    : fs === 'normal' ? {b: 'Normal', s: 'No delays'}
    : fs === 'ground_stop' || fs === 'ground stop' ? {b: 'Ground stop', s: faa.reason ? shortWx(faa.reason) : 'Flights held', w: true}
    : fs === 'closed' ? {b: 'Closed', s: str(faa.reason) || 'Airport closed', w: true}
    : /delay/.test(fs) ? {b: 'Delays', s: faa.avg_min ? `Avg ${faa.avg_min} min` : str(faa.reason) || 'Reported', w: true}
    : {b: str(faa.status).replace(/_/g, ' '), s: str(faa.text) || ''};
  // An old FAA reading says when it is from instead of sounding current.
  if (faa && fs && okT(faa.updated) && nowMs() - T(faa.updated) > 3 * HR) faaT.s = sameDay(faa.updated, N.now(), code) ? `As of ${N.time(faa.updated, code)}` : `As of ${N.date(faa.updated, code).split(' ')[0]}`;
  let third;
  if (v && v.role === 'connect') third = {l: 'Security', b: 'None', s: 'Stay airside'};
  else if (v && v.role === 'arrive') {
    const bag = v.inn.arr.baggage;
    third = bag ? {l: 'Carousel', b: str(bag), s: flightNo(v.inn)} : {l: 'Carousel', b: '—', s: 'After landing'};
  } else if (tsa.wait_min != null && Number.isFinite(+tsa.wait_min)) {
    third = {l: 'TSA wait', b: `${Math.round(+tsa.wait_min)} min`, s: str(tsa.text) || 'Standard lane', c: +tsa.wait_min >= 30};
  } else {
    const ck = arr(g && g.security).filter(obj)[0];
    const at = secTime(code, v);
    if (!ck) third = {l: 'Security', b: '—', s: 'Not in the guide'};
    else {
      const r = hoursRange(ck.hours);
      const m = at ? localMin(at, code) : localMin(N.now().toISOString(), code);
      const o = openAt(r, m);
      // Judged at your security time when there is one, else now.
      third = {l: 'Security',
        b: o == null ? '—' : o ? (r && r.all ? 'Open 24h' : 'Open') : r && !r.all ? `Opens ${clockTxt(r.a)}` : 'Closed',
        s: o == null ? 'Hours not listed' : str(ck.name) || 'Main checkpoint', c: o === false};
    }
  }
  // w: a real problem (rose ring). c: worth a look (amber dot on the subline).
  const cell = (k, label, t) => h`<div class="${t.w ? 'w' : t.c ? 'ap-cw' : ''}"><small>${label}</small><b data-k="${k}">${t.b}</b><span>${t.s}</span></div>`;
  const sfx = `-${code}-${v ? v.key : ''}`;
  return h`<div class="cn ap-cn">${cell('ap-wx' + sfx, wxT.l, wxT)}${cell('ap-faa' + sfx, 'FAA', faaT)}${cell('ap-3' + sfx, third.l, third)}</div>`;
}

// ---------- callouts ----------
function callouts(code, v) {
  const L = live(code), faa = obj(L.faa), wx = obj(L.wx) || {}, g = guide(code);
  const out = [];
  // Every callout leads with what it is in bold, then the detail.
  const co = (tone, ic2, lead, body) => out.push(h`<div class="co ${tone}">${icon(ic2)}<span><b>${lead}</b>${body ? h` ${body}` : ''}</span></div>`);
  const why = x => x ? ` (${x})` : '';
  const fs = faa && lc(faa.status);
  // Rose for what stops you (ground stop, closed, canceled, at risk); amber edge for what slows you.
  if (fs && /ground/.test(fs)) co('rose', 'alert-triangle', 'FAA ground stop.', `Flights at ${code} are being held${why(faa.reason)}.`);
  else if (fs && /delay/.test(fs)) co('ap-warn', 'clock', 'FAA delays.', `Flights at ${code} ${faa.avg_min ? `are averaging ${faa.avg_min} min late` : 'are running late'}${why(faa.reason)}.`);
  else if (fs === 'closed') co('rose', 'alert-triangle', `${code} closed.`, `The FAA lists the airport as closed${why(faa.reason)}.`);
  arr(wx.alerts).slice(0, 2).forEach(a => {
    const t = typeof a === 'string' ? a : obj(a) ? str(a.event || a.headline || a.title) : '';
    const ends = obj(a) && okT(a.ends) ? `Until ${when(a.ends, code)}.` : '';
    if (t) co('ap-warn', 'alert-triangle', `${t.replace(/\.\s*$/, '')}.`, ends);
  });
  const legs = v ? [v.inn, v.out].filter(Boolean) : [];
  legs.forEach(l => {
    if (l.canceled) co('rose', 'alert-triangle', `${flightNo(l)} canceled.`, h`Rebook in the AA app or at an AA counter. <a class="ap-il2" href="${AA_PHONE}" target="_blank" rel="noopener">Call AA</a>`);
    else if (l.diverted) co('rose', 'alert-triangle', `${flightNo(l)} diverted.`, `Now going to ${l.diverted}. Follow the AA app for the new plan.`);
    else if (l.route_ok === false) co('rose', 'alert-circle', 'Flight data mismatch.', `The data for ${flightNo(l)} doesn't match this route. Check the AA app.`);
  });
  // Connection: only when it is tight (amber edge) or at risk (rose), and only until you leave.
  // Same model and words as Flights and Today: spare = reaching the gate to its doors closing.
  let c = null;
  if (v && v.role === 'connect') { try { c = N.connection(v.dir); } catch (e) { c = null; } }
  if (c && c.level !== 'ok' && !v.inn.canceled && !v.out.canceled && !overV(v) && okT(v.inn.arr.time) && okT(v.out.dep.time)) {
    const gt = v.out.dep.gate ? `gate ${v.out.dep.gate}` : 'the next gate';
    const doors = N.time(N.addMin(v.out.dep.time, -N.AA.doors), code), reach = N.time(N.addMin(v.inn.arr.time, 10 + c.walk.min), code);
    co(c.level === 'risk' ? 'rose' : 'ap-warn', 'hourglass', `${c.label} connection.`, c.spare > 0
      ? `About ${N.dur(c.spare)} to spare before doors close at ${gt} (${doors}). Go straight there.`
      : c.spare === 0 ? `The usual walk reaches ${gt} just as doors close (${doors}). Go straight there and watch the AA app.`
      : `The usual walk reaches ${gt} ~${reach}, ${N.dur(-c.spare)} after doors close (${doors}). Go straight there and watch the AA app.`);
  }
  // Delays only while they still matter: the next flight until it leaves, the
  // flight in until it lands.
  if (v && v.out && !v.out.canceled && v.out.delay_dep > 14 && !departed(v.out)) co('ap-warn', 'clock', 'Running late.', `${flightNo(v.out)} is delayed ${N.dur(v.out.delay_dep)}; now departs ${tmz(v.out.dep.time, code)}.`);
  const inn = v && v.inn, late = inn ? +(inn.delay_arr != null ? inn.delay_arr : inn.delay_dep) || 0 : 0;
  if (inn && !inn.canceled && late > 14 && okT(inn.arr.time) && nowMs() < T(inn.arr.time)) co('ap-warn', 'clock', 'Running late.', `${flightNo(inn)} now lands ${tmz(inn.arr.time, code)}, ${N.dur(late)} late.`);
  // The guide's summary, minus what the page already says or the data has answered:
  // its connection length (the hero has it), PreCheck and the checkpoint (in the steps,
  // the Security tile and card), a gate guess once the gate is posted. Hidden once the
  // visit is over, on the return, and on a connection that isn't comfortable. Its first
  // sentence is the lead; a summary that is only the terminal (the hero has it) is dropped.
  const gate = gateOf(v);
  let summ = g && !(v && (overV(v) || (v.dir === 'ret' && v.role !== 'depart') || (c && c.level !== 'ok'))) ? fnoText(g.summary) : '';
  const guess = sentences(summ).find(x => /\busually\b/i.test(x)) || '';
  summ = dropS(summ, /precheck|\bcheckpoint\b|\busually\b|\brecent/i)
    .replace(/^\s*(?:about\s+)?\d+\s*(?:min(?:ute)?s?|h(?:ours?)?)\s+connection\s*[,;:.]\s*/i, '').replace(/^[a-z]/, x => x.toUpperCase());
  const ss = sentences(summ).map(x => x.trim());
  if (ss.length && !(ss.length === 1 && /^terminal\s+\w+\.?$/i.test(ss[0]))) co('', 'info-circle', ss[0], ss.slice(1).join(' '));
  // The hero and the route already say the gate isn't posted; this adds the guide's guess, when it has one.
  if (guess && v && v.role !== 'arrive' && !v.out.canceled && !overV(v) && !gate) co('plain', 'map-pin', 'Gate not posted.', `${guess.trim()} The actual gate shows here and on the map once AA posts it.`);
  return out;
}
// Guide caveats, minus the ones the data has already answered.
function caveats(code, v) {
  const g = guide(code);
  const gatesKnown = v && (v.role === 'arrive' ? !!v.inn.arr.gate : !!v.out.dep.gate && (!v.inn || !!v.inn.arr.gate));
  const retKnown = legsOf('ret').length > 0 && legsOf('ret').every(l => okT(l.dep.time));
  return arr(g && g.caveats).map(fnoText).filter(Boolean).filter(c =>
    !(gatesKnown && /gates?\b.*\bnot\b.*\bassigned|not assigned/i.test(c)) && !(retKnown && /return.*not confirmed/i.test(c)));
}

// ---------- your flights here ----------
function flightsHtml(code, v) {
  if (!v) return '';
  const rows = [];
  const row = (l, inbound) => {
    const st = legSt(l);
    const t = inbound ? l.arr.time : l.dep.time;
    const gate = inbound ? l.arr.gate : l.dep.gate, term = inbound ? l.arr.terminal : l.dep.terminal;
    // Past tense only once the flight data confirms it; a passed time alone is "Due" ("Was due"
    // once the leg is over by the clock and the chip says Done).
    const done = inbound ? downOK(l) : leftOK(l);
    const verb = done ? (inbound ? 'Landed' : 'Left') : l.state === 'past' ? 'Was due' : okT(t) && nowMs() >= T(t) ? 'Due' : inbound ? 'Lands' : 'Departs';
    const stT = str(st.text).split(' · ').pop();
    // The chip already says "Not confirmed"; the line does not repeat it.
    const bits = [okT(t) ? `${verb} ${tmz(t, code)}` : stT === 'Not confirmed' ? '' : 'Time not confirmed',
      gate ? `Gate ${gate}` : 'Gate not posted', term ? termLabel(term) : '', inbound && l.arr.baggage ? `Carousel ${l.arr.baggage}` : ''].filter(Boolean);
    const seats = arr(l.seats).filter(Boolean);
    // Rose only for a real problem; a delay or change gets an amber ring. The chip keeps the
    // part that matters ("In the air · 41 min late" → "41 min late"); the row says the rest.
    const chip = st.tone === 'bad' ? 'rose' : st.tone === 'warn' ? 'cr ap-cw' : 'cr';
    return h`<a class="ap-fl" href="#flight/${l.id}">
      <span class="ic">${icon(inbound ? 'plane-arrival' : 'plane-departure')}</span>
      <div class="grow"><b>${flightNo(l)} ${inbound ? `from ${apCity(l.from)}` : `to ${apCity(l.to)}`}</b>
        <small class="tn">${meta(bits)}</small>
        ${seats.length ? h`<small class="tn">Seats ${seats.join(', ')}</small>` : ''}</div>
      <span class="chip ${chip} ap-fc" data-k="ap-st-${l.id}" title="${st.text}"><span>${stT}</span></span></a>`;
  };
  if (v.inn) rows.push(row(v.inn, true));
  if (v.out) rows.push(row(v.out, false));
  return h`<div class="sec"><div class="ey">Your flights here</div><div class="stack8">${rows}</div></div>`;
}

// ---------- steps ----------
// Guide text as sentences, so a sentence the data has already answered can be dropped.
const sentences = s => str(s).match(/[^.!?]+(?:[.!?]+|$)/g) || [];
const dropS = (s, re) => sentences(s).filter(x => !re.test(x)).join('').trim();
// Transit's pick for a direction when Transit shares it (N.bestRoute): {id, name, mins: '45–60 min',
// range: [45, 60], leave}.
// Transit names its directions 'to-hotel' / 'to-lga'; the bare names are tried too.
function transitPick(kind) {
  if (typeof N.bestRoute !== 'function') return null;
  for (const k of [`to-${kind}`, kind]) {
    try { const r = N.bestRoute(k, N.now()); if (r && r.name) return r; } catch (e) { /* not a direction Transit knows */ }
  }
  return null;
}
const minsTxt = m => Array.isArray(m) ? (m[0] === m[1] ? `${m[0]} min` : `${m[0]}–${m[1]} min`)
  : Number.isFinite(+m) && m !== '' && m != null ? `${+m} min` : /^\d+(–\d+)? min$/.test(str(m)) ? str(m) : '';
function stepsHtml(code, v, m) {
  const g = guide(code);
  const title = !v ? 'Steps' : v.role === 'depart' ? `Leaving from ${code}` : v.role === 'connect' ? `Connecting at ${code}` : `Arriving at ${code}`;
  const head = h`<div class="ey">${title}</div>`;
  if (!v) return h`<section class="sec ap-anc" id="ap-steps">${head}<div class="co plain">${icon('info-circle')}<span><b>Not on your trip.</b> ${code} has no timed steps.</span></div></section>`;
  // A list written for this direction (connect_out / connect_ret) wins over the shared one.
  const gs = obj(g && g.steps) ? g.steps : {};
  const own = arr(gs[`${v.role}_${v.dir}`]).filter(obj);
  let steps = own.length ? own : arr(gs[v.role]).filter(obj);
  if (!steps.length) {
    const msg = v.role === 'arrive' ? 'Ground options are below.' : `The guide has no ${v.role === 'connect' ? 'connection' : 'departure'} steps for ${code} yet.`;
    return h`<section class="sec ap-anc" id="ap-steps">${head}<div class="co plain">${icon('info-circle')}<span><b>No steps saved.</b> ${msg}</span></div></section>`;
  }
  // Steps written for the other direction (CLT on the way home): swap in this
  // visit's flight numbers and drop details that quote the other day's times.
  const other = visitsOf(code).find(x => x.role === v.role && x.dir !== v.dir);
  const swap = [];
  if (other && v.dir === 'ret' && !own.length) {
    if (other.inn && v.inn && flightNo(other.inn) !== flightNo(v.inn)) swap.push([flightNo(other.inn), flightNo(v.inn)]);
    if (other.out && v.out && flightNo(other.out) !== flightNo(v.out)) swap.push([flightNo(other.out), flightNo(v.out)]);
  }
  const reused = swap.length > 0;
  const sub = s => swap.reduce((a, [x, y]) => a.split(x).join(y), fnoText(s));
  const hasClock = s => /\b\d{1,2}(:\d{2})?\s?[ap]\b|\b\d{1,2}\/\d{1,2}\b/i.test(str(s));
  const w = N.wallet ? N.wallet() : {};
  const bags = Number.isFinite(+w.bags) ? +w.bags : 0;
  const over = overV(v);
  const gIn = v.inn ? str(v.inn.arr.gate).toUpperCase() : '', gOut = v.out ? str(v.out.dep.gate).toUpperCase() : '';
  const board = v.out && okT(v.out.dep.time) ? T(N.addMin(v.out.dep.time, -N.AA.board)) : NaN;
  // On a connection, once AA posts the next gate: the walk to it (the map's figure, else a concourse guess).
  let wk = null, c = null;
  if (v.role === 'connect') { try { c = N.connection(v.dir); } catch (e) { c = null; } }
  if (v.role === 'connect' && gOut && typeof N.walk === 'function') { try { wk = N.walk(code, gIn || null, gOut); } catch (e) { wk = null; } }
  // A connection runs on the same clock as its rating (N.connection): the door opens ~10 min after
  // landing, then the walk; so the steps, the callout and Flights agree on when you reach the gate.
  const arrT = v.role === 'connect' && v.inn && okT(v.inn.arr.time) ? v.inn.arr.time : null;
  const walkMin = wk ? wk.min : c && c.walk ? c.walk.min : 15;
  const offAt = arrT ? N.addMin(arrT, 10) : null, reachAt = arrT ? N.addMin(arrT, 10 + walkMin) : null;
  const gateStep = s => v.role === 'connect' && (s.icon === 'device-mobile' || /\bfind\b.*\bgate\b/i.test(str(s.title)));
  // The checkpoint the route goes through (the map may pick another for your gate or the hour).
  const rcp = v.role === 'depart' && m && m.R ? str((arr(m.R.steps).find(x => x.kind === 'security') || {}).cp) : '';
  const walkStep = s => v.role === 'connect' && s.icon === 'route' && /\bwalk\b/i.test(str(s.title));
  const rows = steps.map(s => {
    const rel = obj(s.rel);
    let at = null;
    if (rel && Number.isFinite(+rel.min)) {
      const base = rel.to === 'arr' ? v.inn && v.inn.arr.time : v.out && v.out.dep.time;
      at = okT(base) ? N.addMin(base, +rel.min) : null;
    }
    const meal = s.icon === 'tools-kitchen-2' || s.icon === 'coffee';
    let min = +s.min || 0;
    if (arrT && rel) {
      if (/\bdeplane\b/i.test(str(s.title))) { at = arrT; min = 10; }
      else if (gateStep(s) || walkStep(s)) { at = offAt; if (gOut || walkStep(s)) min = walkMin; }
      else if (meal) at = reachAt;
    }
    // A meal that would start once boarding has is no longer a step.
    if (meal && okT(at) && T(at) >= board) return null;
    // The gate step below names the walk once the gate is known.
    if (walkStep(s) && wk && wk.known) return null;
    const extra = [];
    let t = sub(s.title) || 'Step', detail = reused && hasClock(s.detail) ? '' : sub(s.detail), link = '', hideMin = false;
    if (rcp && s.icon === 'shield-check' && /\bcheckpoint\s+\w+/i.test(t) && !lc(t).includes(lc(rcp))) {
      const ck = arr(g && g.security).filter(obj).find(x => lc(shortN(x.name)) === lc(rcp));
      t = `Security at ${rcp}`;
      detail = ck ? `${[str(ck.where), str(ck.hours) && `open ${apTime(ck.hours)}`].filter(Boolean).join(', ')}.` : '';
    }
    if (s.icon === 'car' && v.role === 'depart' && rel) {
      let lv = null; try { lv = N.leave(v.dir); } catch (e) { lv = null; }
      if (lv && okT(lv.at)) {
        at = lv.at;
        if (lv.source === 'traffic') extra.push(`Uses the latest traffic: about ${lv.drive} min drive`);
        if (lv.buffer) extra.push(`Includes your ${lv.buffer} min buffer`);
      }
    }
    if (s.icon === 'plane-arrival' && gIn) {
      t = `${t} at gate ${gIn}`;
      detail = dropS(detail, /scheduled|recent|gate/i);
    }
    if (gateStep(s) && gOut) {
      t = `Gate ${gOut}${gIn ? ` · from ${gIn}` : ''}${wk && wk.known ? ` · ~${wk.min} min` : ''}`;
      detail = '';
      if (wk && wk.known) hideMin = true;
      if (Ps[code] !== null) link = 'conn';
    }
    // When you reach the gate against its doors, rated like the connection (amber tight, rose at risk).
    if (gateStep(s) && gOut && c && reachAt && okT(v.out.dep.time)) {
      const sp = N.mins(reachAt, N.addMin(v.out.dep.time, -N.AA.doors));
      extra.push({t: meta([`At gate ~${N.time(reachAt, code)}`, `${sp >= 0 ? `${N.dur(sp)} before` : `${N.dur(-sp)} after`} doors close`]),
        cls: c.level === 'risk' ? 'ap-xr' : c.level === 'tight' ? 'ap-xw' : ''});
    }
    if (s.icon === 'luggage' && v.role === 'depart' && v.out && okT(v.out.dep.time)) {
      extra.push(meta([`Bag drop closes ${tmz(N.addMin(v.out.dep.time, -N.AA.bagdrop), code)}`, bags > 0 && `${N.plural(bags, 'checked bag')} in Wallet`]));
    }
    if (s.icon === 'luggage' && v.role === 'arrive' && v.inn.arr.baggage) {
      extra.push(`Carousel ${v.inn.arr.baggage}`);
      detail = dropS(detail, /\bshows the carousel\b/i);
    }
    // Into the city: Transit's best way right now, so both screens give the same minutes.
    if (s.icon === 'building-skyscraper' && v.role === 'arrive' && v.dir === 'out') {
      const r = transitPick('hotel');
      const m = r ? minsTxt(r.range || r.mins) : '';
      if (m) detail = `About ${m} by ${r.name} right now.`;
    }
    if (s.icon === 'plane-departure' && gOut) extra.push(`Gate ${gOut}`);
    return {s, at, title: t, detail, extra, min, hideMin, link};
  }).filter(Boolean);
  // In time order: a late arrival can put "Boarding" before "Land". A step with
  // no time keeps its place after the step before it.
  let last = -Infinity;
  rows.forEach((r, i) => { r.k = okT(r.at) ? (last = T(r.at)) : last; r.i = i; });
  rows.sort((a, b) => a.k - b.k || a.i - b.i);
  const now = nowMs();
  // A step that has started stays "Now" for as long as it takes ("Security
  // 3:30a, about 20 min" is still Now at 3:40a), or a minute if it has no
  // length, so the step in progress never shows as done.
  const endOf = r => T(r.at) + Math.max(r.min * 60000, 60000);
  let lastStarted = -1;
  rows.forEach((r, i) => { if (okT(r.at) && T(r.at) <= now) lastStarted = i; });
  const active = !over && lastStarted >= 0 && endOf(rows[lastStarted]) > now ? lastStarted : -1;
  const upI = over ? -1 : rows.findIndex((r, i) => i > lastStarted && okT(r.at) && T(r.at) > now);
  const nextI = active >= 0 ? active : upI;
  // When the next/now marker next needs to move (read by tick).
  const chg = nextI < 0 ? NaN
    : active >= 0 ? Math.min(endOf(rows[active]), upI >= 0 ? T(rows[upI].at) : Infinity)
    : T(rows[upI].at) - now > 60000 ? T(rows[upI].at) - 60000 : T(rows[upI].at);
  const html = rows.map((r, i) => {
    const next = i === nextI;
    const done = okT(r.at) && !next && (over || T(r.at) <= now);
    const warn = r.s.icon === 'alert-triangle';
    // A finished step is one quiet line: time, tick and title.
    if (done) return h`<li class="ap-st done">
      <div class="ap-tm tn">${N.time(r.at, code)}</div>
      <div class="ap-sd"><span class="ap-si">${icon('check')}</span></div>
      <div class="ap-sb"><b>${r.title}</b></div>
    </li>`;
    return h`<li class="${N.cls('ap-st', next && 'next', warn && 'wn')}"${next && Number.isFinite(chg) ? raw(` data-chg="${Math.round(chg)}"`) : ''}>
      <div class="ap-tm tn">${okT(r.at) ? N.time(r.at, code) : r.s.rel ? '—' : ''}</div>
      <div class="ap-sd"><span class="ap-si">${ic(r.s.icon, 'point')}</span></div>
      <div class="ap-sb"><b>${r.title}</b>
        ${next ? i === active || T(r.at) - now <= 60000 ? h`<span class="ap-in">Now</span>` : h`<span class="ap-in">in <span data-until="${r.at}">${N.until(r.at)}</span></span>` : ''}
        ${r.detail ? h`<small>${r.detail}</small>` : ''}
        ${r.extra.map(x => h`<small class="${N.cls('ap-x', x.cls)}">${x.t || x}</small>`)}
        ${r.min && !r.hideMin ? h`<small class="ap-mn">${icon('clock')}About ${N.dur(r.min)}</small>` : ''}
        ${r.link ? h`<button type="button" class="ap-tb ap-wk ap-sl" data-act="tomap" data-arg="conn">${ic('walk', 'route')}<span>Show on map</span></button>` : ''}</div>
    </li>`;
  });
  const notes = [];
  if (reused) notes.push(h`<p class="ap-note">These steps were written for the outbound connection. Times use your ${v.dir === 'ret' ? 'return' : ''} flights.</p>`);
  if (!okT(v.at)) notes.push(h`<p class="ap-note">Times show once ${flightNo(v.leg)} is confirmed.</p>`);
  return h`<section class="sec ap-anc" id="ap-steps">${head}${notes}<ol class="ap-steps">${html}</ol></section>`;
}

// ---------- lower sections ----------
// A reference section that starts closed: its title, a short note and a chevron.
const fold = (id, title, note, body) => h`<section class="sec ap-anc" id="ap-${id}"><details class="ap-fold">
  <summary><span class="grow"><span class="ey">${title}</span>${note ? h`<small>${note}</small>` : ''}</span>${icon('chevron-down', 'ap-chev')}</summary>
  <div class="ap-fb">${body}</div></details></section>`;
// The rest of a list, opened in place.
const more = (label, body) => h`<details class="ap-more"><summary><span class="grow">${label}</span>${icon('chevron-down', 'ap-chev')}</summary><div class="ap-mb">${body}</div></details>`;

function securityHtml(code, v) {
  const g = guide(code);
  const list = arr(g && g.security).filter(obj);
  const at = secTime(code, v);
  const m = at ? localMin(at, code) : null;
  const role = v ? v.role : '';
  // Through security on the way out (the step's length, at least 20 min, has passed): nothing left to choose.
  if (role === 'depart' && (departed(v.out) || (at && nowMs() >= T(at) + Math.max(+(secStep(code) || {}).min || 0, 20) * 60000))) return '';
  if (!list.length) return role === 'connect' || role === 'arrive' ? ''
    : h`<section class="sec ap-anc" id="ap-sec"><div class="ey">Security</div><div class="co plain">${icon('info-circle')}<span><b>No checkpoint details.</b> The guide has none saved for ${code}.</span></div></section>`;
  const card = s => {
    const r = hoursRange(s.hours);
    const o = m == null ? null : openAt(r, m);
    const state = o == null ? '' : o ? h`<span class="chip cr ap-ok">${icon('circle-check')}Open at ${N.time(at, code)}</span>`
      : h`<span class="chip cr ap-cw">${icon('clock')}${r && !r.all ? `Opens ${clockTxt(r.a)}` : 'Closed then'}</span>`;
    const fact = (label, val) => val ? h`<div><dt>${label}</dt><dd>${val}</dd></div>` : '';
    return h`<div class="ap-ck">
      <div class="rw"><span class="ic">${icon('shield-check')}</span><div class="grow"><b>${str(s.name) || 'Checkpoint'}</b>${s.where ? h`<small>${s.where}</small>` : ''}</div></div>
      ${state ? h`<div class="ap-cks">${state}</div>` : ''}
      <dl class="ap-dl">${fact('Hours', apTime(s.hours) || 'Not listed')}${fact('PreCheck', apTime(s.precheck))}${fact('CLEAR', apTime(s.clear))}</dl>
      ${s.note ? h`<p class="ap-cn2">${s.note}</p>` : ''}
    </div>`;
  };
  // Not going through security here: all of it, closed, for if you need it.
  if (role === 'connect') return fold('sec', 'Security', 'Only if you leave the secure area', h`<div class="stack8">${list.map(card)}</div>`);
  if (role === 'arrive') return fold('sec', 'Security', `For leaving from ${code}`, h`<div class="stack8">${list.map(card)}</div>`);
  // Leaving: the first checkpoint open at your security time, the others closed below it.
  const i = Math.max(0, list.findIndex(x => m == null || openAt(hoursRange(x.hours), m) !== false));
  const rest = list.filter((x, j) => j !== i);
  const lbl = rest.every(x => /checkpoint/i.test(str(x.name))) ? 'Other checkpoints' : 'More options';
  return h`<section class="sec ap-anc" id="ap-sec"><div class="ey">Security</div>
    ${card(list[i])}
    ${rest.length ? more(`${lbl} (${rest.length})`, h`<div class="stack8">${rest.map(card)}</div>`) : ''}</section>`;
}

function foodHtml(code, v) {
  const g = guide(code);
  const list = arr(g && g.food).filter(obj);
  const head = h`<div class="ey">Food and coffee</div>`;
  if (!list.length) return h`<section class="sec ap-anc" id="ap-food">${head}<div class="co plain">${icon('info-circle')}<span><b>No food listed.</b> The guide has none saved for ${code} yet.</span></div></section>`;
  const gate = v ? (v.role === 'arrive' ? v.inn.arr.gate : v.out.dep.gate || (v.inn && v.inn.arr.gate)) : null;
  const gm = normG(gate).match(/^([A-Z]*)(\d+)/);
  const land = f => /before security|landside|pre-?security|ticketing|check-?in|departures|checkpoints?\b/i.test(`${str(f.near)} ${str(f.where)}`) && !/after security|airside/i.test(str(f.where));
  const score = f => {
    if (!gm) return 50;
    const s = `${str(f.near)} ${str(f.where)}`.toUpperCase();
    const q = s.match(/\b([A-E])\s?(\d{1,2})\b/);
    if (gm[1] && q) return q[1] === gm[1] ? Math.abs(+q[2] - +gm[2]) : 100 + Math.abs(+q[2] - +gm[2]);
    const rg = s.match(/\b(\d{1,2})\s?[–-]\s?(\d{1,2})\b/);
    if (!gm[1] && rg) return +gm[2] >= +rg[1] && +gm[2] <= +rg[2] ? 3 : 150;
    if (gm[1] && new RegExp(`\\b${gm[1]}\\b|\\b${gm[1]} (GATES|CONCOURSE)|CONCOURSE ${gm[1]}\\b|${gm[1]} GATES`).test(s)) return 8;
    if (/AA GATES|AMERICAN/.test(s)) return 6;
    if (/ATRIUM|HUB|CENTER|BRIDGE|FOOD HALL|MAIN/.test(s)) return 30;
    return 60;
  };
  // When you'd eat, and never earlier than now: once off the plane on a connection, before
  // boarding on a departure, soon after landing on arrival.
  const role = v && v.role;
  const base = role === 'connect' && okT(v.inn.arr.time) ? N.addMin(v.inn.arr.time, 10)
    : role === 'depart' && okT(v.out.dep.time) ? N.addMin(v.out.dep.time, -N.AA.board - 10)
    : role === 'arrive' && okT(v.inn.arr.time) ? N.addMin(v.inn.arr.time, 20) : null;
  const isNow = !!base && nowMs() >= T(base);
  const eatAt = !base ? null : isNow ? N.now().toISOString() : base;
  const em = eatAt ? localMin(eatAt, code) : null;
  // No time to eat once that is at or past boarding: the list folds away under why.
  const board = role !== 'arrive' && v && v.out && okT(v.out.dep.time) ? T(N.addMin(v.out.dep.time, -N.AA.board)) : NaN;
  const late = !!eatAt && T(eatAt) >= board && !overV(v);
  const openInfo = f => {
    if (em == null) return {open: null};
    const hs = str(f.hours), r = hoursRange(hs);
    if (r) return {open: openAt(r, em), a: r.all ? null : r.a};
    const m = hs.match(/^\s*(?:from|opens?)\s+(\d{1,2}(?::\d{2})?\s*[ap])/i), a = m ? clockMin(m[1]) : null;
    return a == null ? {open: null} : {open: em >= a, a};
  };
  // Leaving: a place that only opens once your flight has gone is left out.
  const dm = v && v.role !== 'arrive' && v.out && okT(v.out.dep.time) ? localMin(v.out.dep.time, code) : null;
  const gone = x => em != null && dm != null && x.open === false && x.a != null && (x.a - em + 1440) % 1440 >= (dm - em + 1440) % 1440;
  const items = list.map((f, i) => Object.assign({f, i, land: land(f), sc: score(f)}, openInfo(f))).filter(x => !gone(x));
  // Near your gate first; places that won't be open in time go last.
  const air = items.filter(x => !x.land).sort((a, b) => (a.open === false) - (b.open === false) || a.sc - b.sc || a.i - b.i);
  const pre = items.filter(x => x.land);
  const row = x => {
    const f = x.f, near = gm && x.sc <= 4 && x.open !== false;
    // "At your gate" only when it is your gate; otherwise where it is ("Near your gate, at B1").
    const mine = h`<span class="ap-me">${!/^[A-Z]{0,2}\d{1,3}$/i.test(str(f.near)) ? 'Near your gate' : normG(f.near) === normG(gate) ? 'At your gate' : `Near your gate, at ${str(f.near).toUpperCase()}`}</span>`;
    const kind = /coffee|caf|espresso|tea\b|starbucks|peet|dunkin/i.test(`${str(f.kind)} ${str(f.name)}`) ? 'coffee' : 'tools-kitchen-2';
    // Where it is goes in the subline ("Near A7"); a gate-area "where" that only repeats the gate letter is dropped.
    const nr = str(f.near), gt = /^[A-Z]{0,2}\d{1,3}$/i.test(nr);
    const where = gt && /^airside,?\s+[A-Z] gates$/i.test(str(f.where)) ? '' : str(f.where);
    // Skip a landmark the location line already starts with ("Atrium · Atrium, upper level").
    const said = !gt && nr && where.toLowerCase().startsWith(nr.toLowerCase());
    const sub = [near || said ? '' : nr ? (gt ? `Near ${nr.toUpperCase()}` : nr) : '', where, apTime(f.hours)];
    // One status per row: open (green dot), opens later (amber dot) or closed (grey dot).
    const st = x.open == null ? '' : x.open ? h`<span class="ap-os on">Open</span>`
      : x.a != null ? h`<span class="ap-os soon">Opens ${clockTxt(x.a)}</span>` : h`<span class="ap-os off">Closed</span>`;
    return h`<div class="ap-fd">
      <span class="ic">${icon(kind)}</span>
      <div class="grow"><b>${str(f.name) || 'Food'}</b><small>${meta([near && mine, ...sub])}</small>${f.note ? h`<small class="ap-fn">${f.note}</small>` : ''}</div>
      ${st}
    </div>`;
  };
  const sortNote = `${gm ? `Nearest to gate ${str(gate).toUpperCase()} first.` : 'Sorted by your gate once AA posts it.'}${em == null ? ''
    : isNow ? ' Shows what’s open now.' : ` Shows what’s open at ${tmz(eatAt, code)}, ${role === 'connect' ? 'once you’re off the plane' : role === 'arrive' ? 'after landing' : 'before boarding'}.`}`;
  // The four nearest stay in view; the rest and anything outside security open below.
  const top = air.slice(0, 4), rest = air.slice(4);
  const preH = pre.length ? h`<div class="ap-subh">${role === 'connect' ? 'Outside security (means screening again)' : role === 'arrive' ? 'Outside security' : 'Before security'}</div><div class="ap-list">${pre.map(row)}</div>` : '';
  const body = h`<p class="ap-note">${sortNote}</p>
    <div class="ap-list">${top.map(row)}</div>
    ${rest.length || pre.length ? more(`More places (${rest.length + pre.length})`, h`${rest.length ? h`<div class="ap-list">${rest.map(row)}</div>` : ''}${preH}`) : ''}`;
  return late ? fold('food', 'Food and coffee', nowMs() >= board ? 'Boarding has started' : 'No time before boarding', body)
    : h`<section class="sec ap-anc" id="ap-food">${head}${body}</section>`;
}

// US phone numbers in guide text become real call/text buttons (at 3am you
// want to tap "Call AA", not copy digits). "AA 800-433-7300 · TSA Cares
// 1-855-787-2227" gives two buttons; "or text 646-…" gives a text button.
function callChips(text) {
  const out = [], re = /(?:\+?1[-.\s])?\(?(\d{3})\)?[-.\s](\d{3})[-.\s](\d{4})\b/g;
  str(text).split(/\s+·\s+|;\s*/).forEach(seg => {
    let m, last = 0;
    while ((m = re.exec(seg))) {
      const before = seg.slice(last, m.index);
      last = re.lastIndex;
      const sms = /\btext\s*$/i.test(before);
      const name = before.replace(/\b(call|text|or|at)\b/gi, '').replace(/[:,()]/g, '').trim().slice(0, 24);
      out.push({href: `${sms ? 'sms' : 'tel'}:+1${m[1]}${m[2]}${m[3]}`, sms, label: `${sms ? 'Text' : 'Call'}${name ? ' ' + name : ''}`, num: `${m[1]}-${m[2]}-${m[3]}`});
    }
    re.lastIndex = 0;
  });
  return out.slice(0, 4);
}
function servicesHtml(code) {
  const g = guide(code);
  const list = arr(g && g.services).filter(obj);
  if (!list.length) return '';
  // Text that held a number loses it: the number is on its own row below.
  const PH = /(?:\+?1[-.\s])?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/;
  return h`<section class="sec ap-anc" id="ap-svc"><div class="ey">Services</div><div class="ap-list">${list.map(s => {
    const calls = callChips(`${str(s.label)} · ${str(s.where)}`);
    const label = PH.test(str(s.label)) ? str(s.where) || 'Phone' : str(s.label) || 'Service';
    const where = PH.test(str(s.label)) || PH.test(str(s.where)) ? '' : str(s.where);
    return h`<div class="ap-sv">
    <span class="ic">${ic(s.icon)}</span><div class="grow"><b>${label}</b>${where ? h`<small>${where}</small>` : ''}
      ${calls.length ? h`<div class="ap-calls">${calls.map(c => h`<a class="ap-call" href="${c.href}">${ic(c.sms ? 'message-circle' : 'phone', 'phone')}<span class="grow">${c.label}</span><span class="tn">${c.num}</span></a>`)}</div>` : ''}</div></div>`;
  })}</div></section>`;
}

const MODE_IC = {car: 'car', taxi: 'car', rideshare: 'car', valet: 'parking', parking: 'parking', garage: 'parking', economy: 'parking',
  bus: 'bus', shuttle: 'bus', van: 'bus', train: 'train', subway: 'train', rail: 'train', lirr: 'train', walk: 'walk'};
// LGA's ground options open Transit's own route for the same way in (#route/hotel/to-hotel-…),
// so both screens show one set of steps and times; the guide's row is the fallback.
const gkey = id => /lirr/i.test(id) ? 'lirr' : /q70/i.test(id) ? 'q70' : /m60/i.test(id) ? 'm60' : /van/i.test(id) ? 'van' : '';
const routeId = x => {
  const k = gkey(str(x.id)), tr = obj(N.data.guide && N.data.guide.transit) || {};
  const r = arr(tr.to_hotel).filter(r => obj(r) && /^[\w-]+$/.test(str(r.id))).find(r => k ? gkey(str(r.id)) === k : r.mode === x.mode && !gkey(str(r.id)));
  return r ? str(r.id) : /^[\w-]+$/.test(str(x.id)) ? str(x.id) : '';
};
function groundHtml(code, v) {
  const g = guide(code);
  const nyc = code === 'LGA';
  const into = !v || v.role === 'arrive';
  // Outside NYC the ground list is written for getting to the airport; an option's
  // `arrive` block rewrites it for the way home (pickup curb instead of drop-off).
  const list = arr(g && g.ground).filter(obj).map(x => (into && !nyc && obj(x.arrive) ? Object.assign({}, x, x.arrive) : x));
  if (!list.length) return '';
  const home = into && !nyc && list.some(x => obj(x.arrive));
  const title = !into ? `Getting to ${code}` : nyc ? `Leaving ${code}` : home ? `Getting home from ${code}` : `To and from ${code}`;
  const rows = list.map(x => {
    const mn = arr(x.min).filter(n => Number.isFinite(+n));
    const t = mn.length ? `${mn[0]}${mn[1] && mn[1] !== mn[0] ? `–${mn[1]}` : ''} min` : '';
    const body = h`<span class="ic">${ic(MODE_IC[lc(x.mode)] || lc(x.mode), 'route')}</span>
      <div class="grow"><b>${str(x.name) || 'Option'}</b>
        <small class="tn">${meta([t, str(x.cost)])}</small>
        ${x.where ? h`<small>${x.where}</small>` : ''}
        ${x.good ? h`<small class="ap-gd">${icon('thumb-up')}${x.good}</small>` : ''}
        ${x.bad ? h`<small class="ap-bd">${icon('alert-circle')}${x.bad}</small>` : ''}</div>`;
    const rid = nyc && into ? routeId(x) : '';
    return rid
      ? h`<a class="ap-gr" href="#route/hotel/${rid}">${body}${icon('chevron-right', 'ap-chev')}</a>`
      : h`<div class="ap-gr">${body}</div>`;
  });
  const tr = nyc ? h`<a class="ap-tr" href="#transit"><span class="ic">${icon('route')}</span><div class="grow"><b>${into ? 'Compare ways into Manhattan' : 'Compare ways to LGA'}</b><small>Taxi, train and bus with today’s times in Transit</small></div>${icon('chevron-right', 'ap-chev')}</a>` : '';
  // Leaving: the steps already cover the trip in, so the full list starts closed.
  if (!into) return fold('ground', title, `${N.plural(list.length, 'option')} with times and costs`, h`${tr}<div class="ap-list">${rows}</div>`);
  return h`<section class="sec ap-anc" id="ap-ground"><div class="ap-sh"><div class="ey">${title}</div></div>
    ${tr}<div class="ap-list">${rows}</div></section>`;
}

// Keep "B16 310 m" and "C 5–9 min" whole in the narrow fact tiles so lines break at the
// " · " separators: gate code + number, number + unit, and digit ranges stay together.
const keepUnit = v => str(v)
  .replace(/(\d)([–-])(?=\d)/g, '$1$2\u2060')
  .replace(/\b([A-Z]\d{0,3}) (?=\d)/g, '$1\u00a0')
  .replace(/(\d) (?=(?:m|min|ft|km|mi|hr|hours?)\b)/g, '$1\u00a0');

// An "M/D" date in guide text is a day of this trip's year (airport-local).
const mdPast = (s, code) => {
  const m = str(s).match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (!m) return false;
  const today = N.ymd(N.now(), code);
  return `${today.slice(0, 4)}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` < today;
};
// A fact that is only a clock time ("4:15a", "~4:20a") is about leaving from here:
// gone once the flight has, or once that time has passed on the day.
const timePast = (f, code) => {
  const t = str(f.value).trim().match(/^~?\s*(\d{1,2}(?::\d{2})?\s*[ap])\.?m?\.?$/i);
  if (!t) return false;
  const d = visitsOf(code).find(x => x.role === 'depart');
  if (!d || !okT(d.out.dep.time)) return false;
  if (departed(d.out)) return true;
  const md = str(f.label).match(/\b\d{1,2}\/\d{1,2}\b/);
  const day = md ? null : N.ymd(d.out.dep.time, code);
  return (md || day === N.ymd(N.now(), code)) && localMin(N.now().toISOString(), code) > clockMin(t[1]);
};
function infoHtml(code, v) {
  const g = guide(code);
  const facts = arr(g && g.facts).filter(obj).filter(f => !mdPast(f.label, code) && !timePast(f, code));
  const tips = arr(g && g.tips).map(fnoText).filter(t => t && !mdPast(t, code));
  const links = arr(g && g.links).filter(obj).filter(l => /^https?:|^tel:/i.test(str(l.url)));
  const cav = caveats(code, v);
  if (!facts.length && !tips.length && !links.length && !cav.length) return '';
  // A long value gets the full row, and so does an odd last tile.
  const long = (f, i) => str(f.value).length > 14 || (i === facts.length - 1 && facts.filter((x, j) => j < i && !(str(x.value).length > 14)).length % 2 === 0);
  const what = [facts.length && 'facts', tips.length && 'tips', cav.length && 'open questions', links.length && 'links'].filter(Boolean);
  const note = what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what[what.length - 1]}` : what[0];
  return fold('info', 'Good to know', note.charAt(0).toUpperCase() + note.slice(1), h`
    ${facts.length ? h`<div class="ap-facts">${facts.map((f, i) => h`<div class="${N.cls('ap-fact', long(f, i) && 'long')}"><small>${str(f.label)}</small><b>${keepUnit(f.value)}</b>${f.detail ? h`<span>${keepUnit(f.detail)}</span>` : ''}</div>`)}</div>` : ''}
    ${tips.length ? h`<div class="ap-subh">Tips</div><ul class="ap-tips">${tips.map(t => h`<li>${icon('check')}<span>${t}</span></li>`)}</ul>` : ''}
    ${cav.length ? h`<div class="ap-subh">Not yet confirmed</div><ul class="ap-tips ap-cav">${cav.map(t => h`<li>${icon('alert-circle')}<span>${t}</span></li>`)}</ul>` : ''}
    ${links.length ? h`<div class="ap-subh">Links</div><div class="ap-list">${links.map(l => ext(l.url, h`<span class="grow"><b>${str(l.label) || str(l.url)}</b>${l.what ? h`<small>${l.what}</small>` : ''}</span>${icon('arrow-up-right', 'ap-chev')}`, 'ap-lk'))}</div>` : ''}`);
}

// ---------- page ----------
const codeOf = ctx => {
  const p = str(ctx && ctx.name === 'airport' ? ctx.param : '').replace(/\?.*$/, '').trim().toUpperCase();
  return p || autoCode();
};
// A gate named in the link (#airport/phx?gate=A22), as Today's gate links send it.
const qGate = ctx => {
  const m = str(ctx && ctx.name === 'airport' ? ctx.param : '').match(/[?&]gate=([^&]+)/);
  const g = m ? m[1].trim() : '';
  return /^[A-Za-z0-9-]{1,6}$/.test(g) ? g : '';
};
N.airportGateLinks = true;
function emptyHero(title, sub) {
  return h`<div class="ap-hero ap-e"><div class="ps ap-ps" role="group" aria-label="Airport">${codes().map(c => h`<button type="button" data-act="ap" data-arg="${lc(c)}" aria-pressed="false">${c}</button>`)}</div>
    <div class="ap-top"><h1 class="hl"><b>${title}</b></h1>${sub ? h`<p class="ap-sub"><span>${sub}</span></p>` : ''}</div></div>`;
}

// ---------- the map card ----------
// The page while it is on screen: {code, hash, k, m, M (the map), rkey/ykey (what the map
// shows), full, pop (a tapped place), pk (the open picker's end), offs, at, sig, html}.
let S = null;
let chipsOn = [];      // map overlays turned on (OVER ids); off until you tap one, memory only
let linked = null;     // the code an old #nav link just opened, to bring the map up
let pending = null;    // what render() wrote, handed to mount() as S.html
// Room for the overlay chips (top) and the level rail and buttons (right).
const PAD = {top: 62, bottom: 30, left: 18, right: 64};
const chipIds = () => OVER.filter(x => chipsOn.includes(x[0])).flatMap(x => x[3]);
const rkeyOf = m => `${epKey(m.from)}>${arr(m.via).map(epKey).join(',')}>${epKey(m.to)}|${m.R ? m.R.s : 'x'}`;
const ykeyOf = m => m.you ? `${m.you.lon.toFixed(5)},${m.you.lat.toFixed(5)},${Math.round(m.you.acc)},${m.you.level}` : '';
const PLACE_IC = {curb_dep: 'car', curb_arr: 'car', checkin: 'luggage', checkpoint: 'shield-check', precheck: 'shield-check', baggage: 'luggage',
  rideshare: 'car-suv', taxi: 'car', bus: 'bus', shuttle: 'bus', train: 'train', subway: 'train', parking: 'car', rental_car: 'car', exit: 'door-exit'};
const concName = c => !c ? 'Gates' : /^[A-Z]$/i.test(c) ? `Concourse ${c.toUpperCase()}` : /concourse|terminal|gates/i.test(c) ? c : `${c} concourse`;
const levelIds = P => arr(P && P.data.levels).map(l => l.id);
const levelOf = (P, arg) => levelIds(P).find(id => String(id) === str(arg));
const isRose = x => String(x).startsWith('<div class="co rose"');

// An old #nav link's From and To, taken once (memory only). "@arr" and "@dep" are what
// the route starts with anyway, so only other places replace the defaults.
function takeRoute(code) {
  const ar = N.airportRoute;
  if (!ar) return;
  N.airportRoute = null;
  if (str(ar.code).toUpperCase() !== code || !(Date.now() - (+ar.at || 0) < 10000)) return;
  const keep = x => { x = str(x).trim(); return x && !/^@(arr|dep|here)$/.test(x) ? x : ''; };
  const s = {}, f = keep(ar.from), t = keep(ar.to), via = arr(ar.via).map(keep).filter(Boolean);
  if (f) s.from = f;
  if (t) s.to = t;
  if (via.length) s.via = via;
  const v = curVisit(code, visitsOf(code));
  sel[`${code}|${v ? v.key : ''}`] = s;
  linked = code;
}

// From and To, and on an arrival where you are heading and how.
function exHtml(m) {
  const {code, v} = m;
  if (!v || v.role !== 'arrive') return '';
  const eta = exitEta(code, v, m.ex);
  return h`<div class="ap-ex">
    <p class="ey ap-exh">${m.ex.to === 'home' ? 'Your way home' : 'Your way out'}</p>
    <div class="seg ap-xto" role="group" aria-label="Heading to">${[['hotel', 'Hotel', 'bed'], ['home', 'Home', 'home']].map(([id, lab, i]) => h`<button type="button" data-act="exitTo" data-arg="${id}" aria-pressed="${String(m.ex.to === id)}">${ic(i, 'map-pin')}${lab}</button>`)}</div>
    <div class="ap-how" role="group" aria-label="How you leave">${HOW.map(([id, lab, i]) => h`<button type="button" class="ap-hw" data-act="exitHow" data-arg="${id}" aria-pressed="${String(m.ex.how === id)}">${ic(i, 'car')}<span>${lab}</span></button>`)}</div>
    ${eta ? h`<p class="ap-eta">${ic('clock')}<span>${eta}</span></p>` : ''}
  </div>`;
}
function ftHtml(m) {
  const {code, P, R, v} = m;
  if (Ps[code] === null) return '';
  const fromL = m.from ? (m.fromHere ? 'Your location' : epLabel(P, m.from, R && R.from)) : v && v.role === 'connect' ? 'Arrival gate not posted' : 'Choose a start';
  const toL = m.to ? epLabel(P, m.to, R && R.to) : v && v.role !== 'arrive' ? 'Gate not posted' : 'Choose a place';
  const btn = (end, lab, val, dot) => h`<button type="button" class="ap-fr" data-act="pick" data-arg="${end}" aria-label="${lab}: ${val}. Choose another">
    <span class="${N.cls('ap-dot', dot)}" aria-hidden="true"></span><span class="grow"><small>${lab}</small><b>${val}</b></span>${ic('chevron-down', 'chevron-right', 'ap-chev')}</button>`;
  return h`<div class="ap-fts"><div class="ap-frs">${btn('from', 'From', fromL, m.fromHere ? 'you' : 'fr')}${btn('to', 'To', toL, 'to')}</div>
    <button type="button" class="ap-sw" data-act="swap" aria-label="Swap start and end">${ic('arrows-sort', 'route')}</button></div>`;
}

// What sits over the map: overlay chips, the level rail, the buttons and a tapped place.
function overHtml(m) {
  const {code, P, R} = m;
  if (Ps[code] === null) return h`<div class="ap-nomap">${ic('map-2', 'map-pin')}<span><b>No map for ${code} on this phone yet.</b> The steps and guide below still work.</span></div>`;
  if (!P) return h`<div class="ap-ml2" role="status"><span class="ap-sp" aria-hidden="true"></span><span>Loading the ${code} map…</span></div>`;
  const cur = S && S.M ? S.M.level : R ? R.from.l : P.data.defaultLevel;
  const onR = new Set(R ? arr(R.levels) : []);
  const lv = arr(P.data.levels).slice().reverse();   // top floor first, like a lift panel
  const full = !!(S && S.full);
  const q = S && S.code === code ? S.pop : null;
  return h`<div class="ap-chips" data-hscroll role="group" aria-label="Show on the map">${OVER.map(([id, lab, i]) => h`<button type="button" class="chip ap-ch" data-act="chip" data-arg="${id}" aria-pressed="${String(chipsOn.includes(id))}">${ic(i, 'map-pin')}${lab}</button>`)}</div>
    ${lv.length > 1 ? h`<div class="ap-rl" role="group" aria-label="Floor">${lv.map(l => h`<button type="button" data-act="lvl" data-arg="${l.id}" aria-pressed="${String(l.id === cur)}" aria-label="${l.name || `Level ${l.short || l.id}`}${onR.has(l.id) ? ', on your route' : ''}">${l.short || l.id}${onR.has(l.id) ? h`<i class="on" aria-hidden="true"></i>` : ''}</button>`)}</div>` : ''}
    <div class="ap-tools2">
      <button type="button" class="ap-tl ap-fs" data-act="${full ? 'unfull' : 'full'}" aria-label="${full ? 'Close the full-screen map' : 'Full-screen map'}">${ic(full ? 'x' : 'arrows-maximize', 'map-2')}</button>
      <button type="button" class="ap-tl" data-act="locate" aria-label="Show where I am">${ic('current-location', 'map-pin')}</button>
      <button type="button" class="ap-tl" data-act="recenter" aria-label="${R ? 'Show the whole route' : 'Show the whole airport'}">${ic(R ? 'route' : 'map', 'route')}</button>
    </div>
    ${q ? h`<div class="ap-pop" role="group" aria-label="${q.name}">
      <span class="ic">${ic(POI_IC[q.cat], 'map-pin')}</span>
      <span class="grow"><b>${q.name}</b><small>${meta([lvName(P, q.level), q.near])}</small></span>
      <button type="button" class="ap-pgo" data-act="pickset" data-arg="to|poi:${q.id}">${ic('route', 'walk')}<span>Route here</span></button>
      <button type="button" class="ap-px" data-act="popx" aria-label="Close">${ic('x')}</button>
    </div>` : ''}`;
}

// ---------- the route, step by step ----------
const STEP_IC = {walk: 'walk', moving: 'walk', train: 'train', elevator: 'elevator', stairs: 'stairs', security: 'shield-check', exit: 'door-exit'};
function stepIcon(x, R) {
  if (x.kind === 'escalator') return x.to != null && x.to < x.level ? 'escalator-down' : 'escalator-up';
  if (x.kind === 'start') return R.from.kind === 'pt' ? 'current-location' : R.from.kind === 'gate' ? 'plane-arrival' : PLACE_IC[R.from.kind] || 'map-pin';
  if (x.kind === 'arrive') return R.to.kind === 'gate' ? 'plane-departure' : /curb|rideshare|taxi/.test(str(R.to.kind)) ? 'car' : PLACE_IC[R.to.kind] || 'flag';
  return STEP_IC[x.kind] || 'walk';
}
function routeHtml(m) {
  const {code, P, R, v} = m;
  if (Ps[code] === null) return '';
  let head = '', body;
  // No route yet: a card that says what it waits on, not a stray grey line.
  const note = (t, i = 'route') => h`<div class="ap-re">${ic(i, 'route')}<span>${t}</span></div>`;
  if (!P) body = note('The route shows here once the map has loaded.');
  else if (R && R.hops && !R.hops.length) body = note(h`<b>You’re there.</b> ${epLabel(P, m.to, R.to)} is where you are.`, 'flag');
  else if (R) {
    head = `${R.mins} min · ${fmtM(R.m)}`;
    const sec = arr(R.steps).some(x => x.kind === 'security');
    // The floor shows where it changes (and on the first step), not on every row.
    body = h`<ol class="ap-rs">${arr(R.steps).map((x, i, xs) => {
      const sm = meta([i && xs[i - 1].level === x.level ? '' : lvName(P, x.level), x.s >= 45 ? `about ${Math.round(x.s / 60)} min` : '']);
      return h`<li><button type="button" class="ap-rr" data-act="step" data-arg="${x.level}">
        <span class="ap-ri">${ic(stepIcon(x, R), 'walk')}</span>
        <span class="grow"><b>${x.text}</b>${sm.length ? h`<small>${sm}</small>` : ''}</span></button></li>`;
    })}</ol>
      ${sec ? h`<p class="ap-rn">Times include a usual wait at security.</p>` : ''}
      ${m.d.off && !m.userTo && m.d.gate ? h`<p class="ap-rn">Gate ${m.d.gate.toUpperCase()} isn’t on this map, so the route ends at security.</p>` : ''}`;
  } else if (v && v.role === 'connect' && !m.from) body = note('Your route starts once AA posts the gate you land at. Or choose a start above.');
  else if (v && v.role !== 'arrive' && !m.to) body = note('Your next gate isn’t posted yet. The route shows here once AA posts it, or choose a place above.');
  else if (!m.to) body = note('Choose where you’re going.');
  else if (!m.from) body = note('Choose where you’re starting.');
  else body = note('No walking route between these on the map.');
  return h`<section class="sec ap-anc" id="ap-route"><div class="ap-sh"><span class="ey">Route</span>${head ? h`<span class="ap-rt tn" data-k="ap-rt">${head}</span>` : ''}</div>${body}</section>`;
}

// Food (and, when their chips are on, restrooms and water) by the detour each adds.
function alongHtml(m) {
  const {P, R} = m;
  if (!P || !R || !R.hops || !R.hops.length || !N.airmap) return '';
  const groups = [['Food and coffee', ['food', 'coffee'], 6]];
  if (chipsOn.includes('restroom')) groups.push(['Restrooms', ['restroom'], 3]);
  if (chipsOn.includes('water')) groups.push(['Water', ['water'], 3]);
  const out = groups.map(([t, ids, n]) => {
    let xs = [];
    try { xs = N.airmap.poisAlong(P, R, ids, n); } catch (e) { xs = []; }
    return xs.length ? h`${groups.length > 1 ? h`<div class="ap-subh">${t}</div>` : ''}<div class="ap-als">${xs.map(x => h`<button type="button" class="ap-al" data-act="poi" data-arg="${x.id}">
      <span class="ic">${ic(POI_IC[x.cat], 'map-pin')}</span><span class="grow"><b>${x.name}</b><small>${meta([x.near, lvName(P, x.level), x.detour_min ? `+${x.detour_min} min` : 'On the way'])}</small></span>${icon('chevron-right', 'ap-chev')}</button>`)}</div>` : '';
  }).filter(Boolean);
  if (!out.length) return '';
  return h`<section class="sec ap-anc" id="ap-along"><div class="ap-sh"><span class="ey">${groups.length > 1 ? 'On your way' : 'Food on your way'}</span></div>${out}</section>`;
}

function headHtml(m, cos) {
  const {code, list, v} = m;
  const seg = list.length > 1 ? h`<div class="seg ap-seg" role="group" aria-label="Which visit">${list.map(x => h`<button type="button" data-act="visit" data-arg="${x.key}" aria-pressed="${x === v ? 'true' : 'false'}">${roleWord(x.role)} ${dayOf(x, code).split(' ').slice(0, 2).join(' ')}</button>`)}</div>` : '';
  const rose = cos.filter(isRose);
  return h`${seg}${rose.length ? h`<div class="stack8 ap-cos">${rose}</div>` : ''}`;
}
function belowHtml(m, cos) {
  const {code, v} = m, g = guide(code);
  const rest = cos.filter(x => !isRose(x));
  return h`${routeHtml(m)}
    ${rest.length ? h`<div class="sec stack8 ap-cos">${rest}</div>` : ''}
    ${stepsHtml(code, v, m)}
    ${flightsHtml(code, v)}
    ${groundHtml(code, v)}
    ${alongHtml(m)}
    ${foodHtml(code, v)}
    ${!g ? h`<div class="sec co plain ap-ng">${icon('info-circle')}<span><b>No guide for ${code}.</b> Only flight and conditions data are shown.</span></div>` : ''}
    ${tilesHtml(code, v)}
    ${securityHtml(code, v)}
    ${servicesHtml(code)}
    ${infoHtml(code, v)}`;
}

function render(ctx) {
  const code = codeOf(ctx);
  const known = codes();
  pending = null;
  if (!/^[A-Z]{3}$/.test(code) || (!known.includes(code) && !guide(code))) {
    return {hero: emptyHero('Airport not on this trip', `“${str(ctx.param).replace(/\?.*$/, '').slice(0, 12)}” isn’t one of your airports.`),
      body: h`<div class="ap-pg"><div class="co plain">${icon('building-airport')}<span><b>Pick an airport.</b> Choose one of yours above, or open the one that matters now.</span></div>
        <div class="wrap ap-ml"><a class="chip cr ap-c44" href="#airports">${icon('current-location')}Airport for right now</a></div></div>`};
  }
  takeRoute(code);
  const auto = autoCode();
  const m = plan(ctx);
  const g = guide(code);
  if (!g && !N.data.trip) {
    return {hero: heroHtml(code, m.v, m.list, auto, m),
      body: h`<div class="ap-pg"><div class="co plain">${icon('info-circle')}<span><b>Guide not loaded.</b> Open the app once with signal to put it on this phone.</span></div></div>`};
  }
  const cos = callouts(code, m.v);
  // The blocks update() patches, kept as written so the first update compares like with like.
  const html = {hero: String(heroHtml(code, m.v, m.list, auto, m)), 'ap-head': String(headHtml(m, cos)), 'ap-ft': String(ftHtml(m)),
    'ap-mo': String(overHtml(m)), 'ap-ex': String(exHtml(m)), 'ap-below': String(belowHtml(m, cos))};
  pending = {code, html};
  const body = h`<div class="ap-pg">
    <div class="ap-head" id="ap-head">${raw(html['ap-head'])}</div>
    <section class="${N.cls('ap-mc ap-anc', Ps[code] === null && 'none')}" id="ap-mc" aria-label="${code} map">
      <div class="ap-ft" id="ap-ft">${raw(html['ap-ft'])}</div>
      <div class="ap-mw"><div class="ap-mh" id="ap-mh"></div><div class="ap-mo" id="ap-mo">${raw(html['ap-mo'])}</div></div>
    </section>
    <div class="ap-exw" id="ap-ex">${raw(html['ap-ex'])}</div>
    <div class="ap-below" id="ap-below">${raw(html['ap-below'])}</div>
  </div>`;
  return {hero: raw(html.hero), body};
}

// ---------- mount, update, teardown ----------
// Replace a block only when its markup changed (the string we last wrote, not the DOM's).
// The clock text ticks on its own (core's data-clock), so it never forces a rewrite.
const unclock = s => String(s || '').replace(/(data-clock="[A-Z]{3}">)[^<]*/g, '$1');
function setH(id, html) {
  const e = document.getElementById(id), s = String(html || '');
  if (!e || !S) return;
  if (unclock(S.html[id]) === unclock(s)) return;
  S.html[id] = s;
  e.innerHTML = s;
}
const paintOverlay = () => { if (S && S.m) setH('ap-mo', overHtml(S.m)); };
function showMap(instant) {
  const mc = document.getElementById('ap-mc');
  if (mc && !(S && S.full)) mc.scrollIntoView({block: 'start', behavior: instant || N.reduce ? 'auto' : 'smooth'});
}
function attachMap(m) {
  const el = document.getElementById('ap-mh');
  if (!S || !el || !m.P || !N.airmap || S.M) return;
  try {
    S.M = N.airmap.mount(el, m.P, {route: m.R, chips: chipIds(), padding: PAD,
      cover: () => document.querySelectorAll('#ap-mo .ap-rl, #ap-mo .ap-tl, #ap-mo .ap-ch, #ap-mo .ap-pop'),
      onLevel: () => paintOverlay(),
      onPoi: q => { if (S) { S.pop = q; paintOverlay(); } },
      onReady: () => paintOverlay()});
    S.rkey = rkeyOf(m);
    S.ykey = ykeyOf(m);
    if (m.you) S.M.setYou(m.you);
  } catch (e) { N.report(e, 'airports map'); S.M = null; }
}
// Full screen: the card covers the page under the top bar; the tab bar steps aside.
function setFull(on) {
  on = !!on;
  const mc = document.getElementById('ap-mc'), view = document.getElementById('view'), app = document.getElementById('app');
  if (S) S.full = on;
  if (mc) {
    const st = document.getElementById('strip');
    mc.style.setProperty('--ap-strip', `${on && st ? st.offsetHeight : 0}px`);
    mc.classList.toggle('full', on);
  }
  if (view) view.classList.toggle('ap-mapfull', on);
  if (app) app.classList.toggle('ap-mapfull', on);
  paintOverlay();
  requestAnimationFrame(() => { if (S && S.M) { S.M.resize(); S.M.fit('route'); } });
}
function closePicker(refocus) {
  const had = document.querySelector('body > .ap-pk');
  document.querySelectorAll('body > .ap-pk').forEach(n => n.remove());
  const end = S && S.pk;
  if (S) S.pk = null;
  if (had && refocus && end) { const b = document.querySelector(`.ap-fr[data-arg="${end}"]`); if (b) b.focus({preventScroll: true}); }
}
function teardown() {
  closePicker();
  const view = document.getElementById('view'), app = document.getElementById('app');
  if (view) view.classList.remove('ap-mapfull');
  if (app) app.classList.remove('ap-mapfull');
  if (!S) return;
  const s = S;
  S = null;
  try { if (s.M) s.M.destroy(); } catch (e) { /* already gone */ }
  s.offs.forEach(f => { try { f(); } catch (e) { /* ignore */ } });
}

let slide = null, slideT = 0;   // switch animation between two airports on the same screen
const sig = ctx => { const code = codeOf(ctx); const list = visitsOf(code); const v = curVisit(code, list); return `${code}|${v ? v.key : ''}|${v ? overV(v) : ''}|${autoCode()}`; };
function mount(ctx, view) {
  teardown();
  const code = codeOf(ctx);
  if (slide && performance.now() - slide.at < 1200 && !N.reduce) {
    const dir = slide.dir;
    [view.querySelector('.ap-top'), document.getElementById('body')].filter(Boolean).forEach((n, i) => {
      if (!n.animate) return;
      n.getAnimations().forEach(a => a.cancel());
      n.animate([{opacity: 0, transform: `translateX(${24 * dir}px)`}, {opacity: 1, transform: 'none'}], {duration: 380, delay: i * 40, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'backwards'});
    });
  }
  slide = null; clearTimeout(slideT);
  const m = plan(ctx);
  const html = pending && pending.code === code ? pending.html : {};
  pending = null;
  S = {code, hash: ctx.hash, k: m.k, m, M: null, rkey: '', ykey: '', full: false, pop: null, pk: null, offs: [], at: performance.now(), sig: sig(ctx), html, wAt: Date.now()};
  const kd = ev => {
    if (ev.key !== 'Escape') return;
    if (document.querySelector('body > .ap-pk')) closePicker(true);
    else if (S && S.full) setFull(false);
  };
  document.addEventListener('keydown', kd);
  S.offs.push(() => document.removeEventListener('keydown', kd));
  if (!document.getElementById('ap-mc')) return teardown;
  // A new fix moves "you" and the start of the route.
  S.offs.push(N.on('where', () => { if (S) N.rerender(); }));
  try { if (N.whereOk && N.whereOk()) N.where().catch(() => {}); } catch (e) { /* no location */ }
  const P = Ps[code];
  if (P) attachMap(m);
  else if (!N.airmap) keepP(code, null);
  else if (P === undefined || Date.now() - (triedAt[code] || 0) > 30000) {
    N.airmap.load(code).then(p => { keepP(code, p); if (S && S.code === code) N.rerender(); })
      .catch(() => { keepP(code, null); if (S && S.code === code) N.rerender(); });
  }
  // Opened from a gate link or an old map link: bring the map up under the bar.
  if (linked === code || qGate(ctx)) requestAnimationFrame(() => { if (S && S.code === code) showMap(true); });
  linked = null;
  return teardown;
}
function repaint(ctx) {
  teardown();
  let out;
  try { out = render(ctx) || {}; } catch (e) {
    N.report(e, 'render airports');
    out = {hero: h`<h1 class="hl">Something went wrong</h1>`, body: h`<div class="co plain">${icon('alert-circle')}<span><b>This screen hit a problem.</b> Your saved data is safe. <button class="chip" data-act="reload">Reload</button></span></div>`};
  }
  const hero = document.getElementById('hero'), body = document.getElementById('body');
  if (hero) hero.innerHTML = String(out.hero || '');
  if (body) body.innerHTML = String(out.body || '');
  document.title = `${codeOf(ctx)} airport · nyc.`;
  try { mount(ctx, document.getElementById('view')); } catch (e) { N.report(e, 'mount airports'); }
}
// A change in place: new times, status, location or a choice. The map stays put and only
// gets a new route or position when those changed; open sections stay open.
function update(ctx) {
  const code = codeOf(ctx);
  if (!S || S.code !== code || S.hash !== ctx.hash || !document.getElementById('ap-mc')) { repaint(ctx); return; }
  const old = new Map(N.$$('[data-k]', document.getElementById('view')).map(e => [e.dataset.k, e.textContent]));
  const below = document.getElementById('ap-below');
  const openK = new Set(below ? [...below.querySelectorAll('details')].map((d, i) => d.open ? `${(d.closest('[id]') || {}).id}|${i}` : '').filter(Boolean) : []);
  const m = plan(ctx);
  S.m = m; S.k = m.k;
  const cos = callouts(code, m.v);
  if (!S.html.hero) S.html.hero = '';
  setH('hero', heroHtml(code, m.v, m.list, autoCode(), m));
  setH('ap-head', headHtml(m, cos));
  setH('ap-ft', ftHtml(m));
  setH('ap-mo', overHtml(m));
  setH('ap-ex', exHtml(m));
  const was = S.html['ap-below'];
  setH('ap-below', belowHtml(m, cos));
  if (below && was !== S.html['ap-below']) {
    [...below.querySelectorAll('details')].forEach((d, i) => { if (openK.has(`${(d.closest('[id]') || {}).id}|${i}`)) d.open = true; });
  }
  const mc = document.getElementById('ap-mc');
  if (mc) mc.classList.toggle('none', Ps[code] === null);
  if (!S.M && m.P) attachMap(m);
  else if (S.M) {
    const rk = rkeyOf(m);
    if (rk !== S.rkey) { S.rkey = rk; S.M.setRoute(m.R); }
    const yk = ykeyOf(m);
    if (yk !== S.ykey) { S.ykey = yk; S.M.setYou(m.you); }
  }
  S.sig = sig(ctx);
  document.title = `${code} airport · nyc.`;
  if (performance.now() - S.at < 2000) return;
  N.$$('[data-k]', document.getElementById('view')).forEach(e => {
    const o = old.get(e.dataset.k);
    if (o != null && o !== e.textContent) { e.classList.remove('chg'); void e.offsetWidth; e.classList.add('chg'); }
  });
}
function tick(ctx) {
  if (!S) return;
  const s = sig(ctx);
  // Also repaint when the highlighted step changes: it comes due (shows Now),
  // or the step in progress ends and the marker moves on.
  const nx = document.querySelector('.ap-pg .ap-st.next[data-chg]');
  const chg = nx ? +nx.dataset.chg : NaN;
  const stepDue = Number.isFinite(chg) && nowMs() >= chg;
  if (s !== S.sig || stepDue) { S.sig = s; N.rerender(); return; }
  // Keep "you" fresh while the page is open (a fix lasts two minutes in _shared).
  if (S && Date.now() - S.wAt > 60000) {
    S.wAt = Date.now();
    try { if (N.whereOk && N.whereOk()) N.where().catch(() => {}); } catch (e) { /* no location */ }
  }
}

// ---------- the From / To picker ----------
function pickerHtml(m, end) {
  const {P, v} = m;
  const curK = epKey(end === 'from' ? m.from : m.to);
  const row = (ep, label, sub, icn) => {
    const on = end === 'from' && ep === '@here' ? m.fromHere : epKey(ep) === curK;
    return h`<button type="button" class="ap-po" data-act="pickset" data-arg="${end}|${ep}" data-q="${lc(`${label} ${sub}`)}"${on ? raw(' aria-current="true"') : ''}>
      <span class="ic">${ic(icn, 'map-pin')}</span><span class="grow"><b>${label}</b>${sub ? h`<small>${sub}</small>` : ''}</span>${on ? ic('check', 'check', 'ap-pkc') : ''}</button>`;
  };
  const sug = [], seen = new Set();
  const add = (ep, label, sub, icn) => { if (ep && !seen.has(ep)) { seen.add(ep); sug.push(row(ep, label, sub, icn)); } };
  if (end === 'from' && m.you) add('@here', 'Your location', 'Start where you are', 'current-location');
  const gi = v && v.inn ? gref(P, v.inn.arr.gate) : null, go = v && v.out ? gref(P, v.out.dep.gate) : null;
  if (gi) add(gi, epLabel(P, gi), 'Where you land', 'plane-arrival');
  if (go) add(go, epLabel(P, go), v.role === 'connect' ? 'Your next gate' : 'Your gate', 'plane-departure');
  if (m.qG) { const q = gref(P, m.qG); if (q) add(q, epLabel(P, q), 'Your gate', 'plane-departure'); }
  const kinds = !v || v.role === 'depart' ? ['curb_dep', 'checkin', 'checkpoint'] : v.role === 'arrive' ? ['baggage', ...exitKinds(m.ex.how, v.dir === 'out').slice(0, 2)] : [];   // a connection stays airside
  kinds.filter(k => hasPlace(P, k)).forEach(k => add('place:' + k, KIND_LABEL[k], 'Best one for your route', PLACE_IC[k]));
  const places = N.airmap.places(P).map(x => row(x.ep, x.label, [KIND_LABEL[x.kind] || '', x.pre ? 'PreCheck' : '', lvName(P, x.level)].filter(Boolean).join(' · '), PLACE_IC[x.kind]));
  const byC = new Map();
  N.airmap.gates(P).forEach(x => { const c = str(x.concourse); if (!byC.has(c)) byC.set(c, []); byC.get(c).push(x); });
  const mine = new Set([gi, go].filter(Boolean).map(x => x.slice(5)));
  const gates = [...byC].map(([c, gs]) => h`<div class="ap-pkg"><div class="ey">${concName(c)}</div><div class="ap-gg">${gs.map(x => {
    const on = epKey('gate:' + x.ref) === curK;
    return h`<button type="button" class="${N.cls('ap-gb', mine.has(x.ref) && 'mine')}" data-act="pickset" data-arg="${end}|gate:${x.ref}" data-q="${lc(`gate ${x.ref} ${c}`)}" aria-label="Gate ${x.ref}, ${lvName(P, x.level)}"${on ? raw(' aria-current="true"') : ''}>${x.ref}</button>`;
  })}</div></div>`);
  const title = end === 'from' ? 'Start from' : 'Go to';
  // Gates first where this end is most likely a gate: a connection, your gate, the gate you land at.
  const gatesFirst = !!v && (v.role === 'connect' || (v.role === 'depart') === (end === 'to'));
  return h`<div class="ap-pkb"></div>
    <div class="ap-pks" role="dialog" aria-modal="true" aria-label="${title}" tabindex="-1">
      <div class="ap-pkh"><b>${title}</b><button type="button" class="ap-pkx" data-act="pkclose" aria-label="Close">${ic('x')}</button></div>
      <label class="ap-pkq">${ic('search')}<input type="search" data-input="pkq" placeholder="Gate or place" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" aria-label="Search gates and places"></label>
      <div class="ap-pkl">
        ${sug.length ? h`<div class="ap-pkg"><div class="ey">Suggested</div>${sug}</div>` : ''}
        ${gatesFirst ? gates : ''}
        ${places.length ? h`<div class="ap-pkg"><div class="ey">Places</div>${places}</div>` : ''}
        ${gatesFirst ? '' : gates}
        <p class="ap-pke" hidden>Nothing here matches.</p>
      </div>
    </div>`;
}
function openPicker(m, end) {
  closePicker();
  const d = document.createElement('div');
  d.className = 'ap-pk';
  d.innerHTML = String(pickerHtml(m, end));
  document.body.appendChild(d);
  // The dim layer closes it (a plain listener: [data-act] would give it the press scale).
  d.querySelector('.ap-pkb').addEventListener('click', () => closePicker(true));
  if (S) S.pk = end;
  const sh = d.querySelector('.ap-pks');
  if (sh) sh.focus({preventScroll: true});
}

const actions = {
  ap(el, ev, ctx, arg) {
    const to = str(arg).toUpperCase(), from = codeOf(ctx);
    if (!/^[A-Z]{3}$/.test(to)) return;
    if (ctx.name === 'airport' && to === from) return;
    N.$$('.ap-ps button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.arg === lc(to))));
    const list = codes();
    const dir = list.indexOf(to) >= list.indexOf(from) ? 1 : -1;
    if (ctx.name !== 'airport' || N.reduce) { N.go('airport/' + lc(to), true); return; }
    const outs = [document.querySelector('.ap-top'), document.getElementById('body')].filter(n => n && n.animate);
    slide = {dir, at: performance.now()};
    // Safety: never leave the page faded out if the route does not change.
    clearTimeout(slideT);
    slideT = setTimeout(() => { outs.forEach(n => n.getAnimations().forEach(a => a.cancel())); slide = null; }, 900);
    Promise.all(outs.map(n => n.animate([{opacity: 1, transform: 'none'}, {opacity: 0, transform: `translateX(${-24 * dir}px)`}],
      {duration: 160, easing: 'ease-in', fill: 'forwards'}).finished.catch(() => {}))).then(() => N.go('airport/' + lc(to), true));
  },
  visit(el, ev, ctx, arg) {
    picked[codeOf(ctx)] = str(arg);
    if (S) S.pop = null;
    N.rerender();
  },
  // Back to what the clock and your location say: this airport, visit and route.
  now(el, ev, ctx) {
    Object.keys(picked).forEach(k => delete picked[k]);
    Object.keys(sel).forEach(k => delete sel[k]);
    if (S) S.pop = null;
    if (ctx.name === 'airport') N.go('airports', true); else N.rerender();
  },
  chip(el, ev, ctx, arg) {
    if (!OVER.some(x => x[0] === arg)) return;
    chipsOn = chipsOn.includes(arg) ? chipsOn.filter(x => x !== arg) : chipsOn.concat(arg);
    if (S && S.M) S.M.setChips(chipIds());
    N.rerender();
  },
  lvl(el, ev, ctx, arg) {
    if (!S || !S.M || !S.m) return;
    const l = levelOf(S.m.P, arg);
    if (l === undefined) return;
    S.M.setLevel(l);
    paintOverlay();
  },
  step(el, ev, ctx, arg) {
    if (!S || !S.m) return;
    const l = levelOf(S.m.P, arg);
    if (S.M && l !== undefined) { if (l === S.M.level) S.M.fit('route'); else S.M.setLevel(l); paintOverlay(); }
    showMap();
  },
  pick(el, ev, ctx, arg) {
    if (!S || !S.m) return;
    if (!S.m.P) { N.toast(Ps[S.code] === null ? `No map for ${S.code} on this phone yet` : 'The map is still loading'); return; }
    openPicker(S.m, arg === 'to' ? 'to' : 'from');
  },
  pkq(el) {
    const q = lc(el.value).trim(), pk = el.closest('.ap-pk');
    if (!pk) return;
    let any = 0;
    pk.querySelectorAll('[data-q]').forEach(b => { const hit = !q || b.dataset.q.includes(q); b.hidden = !hit; if (hit) any++; });
    pk.querySelectorAll('.ap-pkg').forEach(g => { g.hidden = !g.querySelector('[data-q]:not([hidden])'); });
    const e = pk.querySelector('.ap-pke');
    if (e) e.hidden = !!any;
  },
  pickset(el, ev, ctx, arg) {
    const s = str(arg), i = s.indexOf('|'), end = s.slice(0, i), ep = s.slice(i + 1);
    if (!S || !S.m || (end !== 'from' && end !== 'to') || !ep) return;
    const cur = sel[S.m.k] || (sel[S.m.k] = {});
    if (ep === '@here') delete cur.from; else cur[end] = ep;
    cur.via = [];
    closePicker();
    S.pop = null;
    N.rerender();
    showMap();
  },
  pkclose() { closePicker(true); },
  popx() { if (S) { S.pop = null; paintOverlay(); } },
  swap() {
    if (!S || !S.m) return;
    const m = S.m;
    if (!m.from || !m.to) { N.toast('Choose both ends first'); return; }
    sel[m.k] = {from: m.to, to: m.from, via: []};
    S.pop = null;
    N.rerender();
  },
  poi(el, ev, ctx, arg) {
    if (!S || !S.m || !S.m.P) return;
    const q = S.m.P.poiById.get(str(arg));
    if (!q) return;
    S.pop = {id: q.id, name: shortN(q.n) || 'Place', cat: q.cat, level: q.l, near: str(q.near)};
    if (S.M) S.M.setLevel(q.l);
    paintOverlay();
    showMap();
  },
  exitTo(el, ev, ctx, arg) { if (arg === 'hotel' || arg === 'home') saveExit(codeOf(ctx), {to: arg}); },
  exitHow(el, ev, ctx, arg) { if (HOW.some(x => x[0] === arg)) saveExit(codeOf(ctx), {how: arg}); },
  async locate(el, ev, ctx) {
    const code = codeOf(ctx);
    let w = null;
    try { w = await N.where({fresh: true}); } catch (e) { w = null; }
    if (!w) { N.toast('Location is off. Allow it in Settings to see where you are.'); return; }
    if (!S || S.code !== code) return;
    if (distTo(w, code) > 3000) { N.toast(`You’re not at ${code}`); return; }
    if (sel[S.k]) delete sel[S.k].from;
    N.rerender();
    requestAnimationFrame(() => { if (S && S.M) S.M.fit('you'); });
  },
  recenter() { if (S && S.M) S.M.fit('route'); },
  full() { setFull(true); },
  unfull() { setFull(false); },
  // "Show on map" in the steps: the visit's own route.
  tomap(el, ev, ctx) {
    if (S && S.k) delete sel[S.k];
    if (S) S.pop = null;
    N.rerender();
    showMap();
  },
};
// Hotel or Home and How, per airport, on this phone. The way out follows the choice.
function saveExit(code, patch) {
  let all = null;
  try { all = obj(N.get('nyc.ap.exit', null)); } catch (e) { all = null; }
  all = Object.assign({}, all || {});
  all[code] = Object.assign({}, obj(all[code]) || {}, patch);
  N.set('nyc.ap.exit', all);
  if (S) { if (sel[S.k]) delete sel[S.k].to; S.pop = null; }
  N.rerender();
}

// 'force' is listed because core's rerender() checks `uses` before a forced repaint,
// so without it N.rerender() (visit switch, tick, location) would skip this screen.
// update() changes the page in place so the map is not rebuilt on every change.
const def = {nav: 2, tone: 'band', uses: ['trip', 'guide', 'status', 'force'], render, mount, update, tick, actions,
  title: ctx => `${codeOf(ctx)} airport`};
N.screen('airports', Object.assign({}, def));
N.screen('airport', Object.assign({}, def));
})();
