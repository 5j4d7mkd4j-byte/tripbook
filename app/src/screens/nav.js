/* Airport walking map with turn-by-turn directions.
     #nav/<code>                         map, where am I, search, nearby
     #nav/<code>/<from>/<to>[/<via,..>]  a route. from, to and via are POI ids,
                                         gate refs (E12), graph node ids, or
                                         @arr @dep @bag @here
   Routes are worked out on the phone from guide/nav/<CODE>.json, which is
   sealed with the guide, so this works with no signal. Location is kept in
   memory only: never stored, logged or sent. Every class in nav.css starts
   with .na. */
(() => {
const {h, icon} = N;

// ---------- constants ----------
const SPEED = {walk: 1.3, outside: 1.3, door: 1.3, moving: 2, stairs: .6};   // metres per second
const FIXED = {escalator: 35, elevator: 75, train: 240, security: 900};      // seconds, unless the edge says
const ONE_WAY = new Set(['security', 'exit']);
const VERT = new Set(['escalator', 'elevator', 'stairs']);
const RAD = Math.PI / 180;
// POI kind: [icon, colour group, plain name, zoom tier (1 shows first)]
const KIND = {
  gate: ['plane-departure', 'gate', 'Gate', 2],
  checkpoint: ['shield-check', 'sec', 'Security checkpoint', 1],
  precheck: ['shield-check', 'sec', 'TSA PreCheck', 1],
  clear: ['shield-check', 'sec', 'CLEAR', 2],
  restroom: ['toilet-paper', 'rest', 'Restroom', 2],
  family_restroom: ['baby-carriage', 'rest', 'Family restroom', 2],
  food: ['tools-kitchen-2', 'food', 'Food', 2],
  coffee: ['coffee', 'food', 'Coffee', 2],
  bar: ['beer', 'food', 'Bar', 2],
  shop: ['shopping-bag', 'shop', 'Shop', 3],
  water: ['droplet', 'water', 'Water refill', 2],
  charging: ['plug', 'svc', 'Charging', 3],
  baggage: ['luggage', 'bag', 'Baggage claim', 1],
  elevator: ['elevator', 'svc', 'Elevator', 3],
  escalator: ['escalator-up', 'svc', 'Escalator', 3],
  stairs: ['stairs', 'svc', 'Stairs', 3],
  info: ['info-circle', 'svc', 'Information', 1],
  lounge: ['armchair', 'lng', 'Lounge', 1],
  bus: ['bus', 'go', 'Bus', 1],
  shuttle: ['bus', 'go', 'Shuttle', 1],
  taxi: ['car', 'go', 'Taxi', 1],
  rideshare: ['car-suv', 'go', 'Rideshare', 1],
  train: ['train', 'go', 'Train', 1],
  subway: ['train', 'go', 'Subway', 1],
  parking: ['parking', 'go', 'Parking', 2],
  curb_dep: ['door-enter', 'go', 'Departures curb', 1],
  curb_arr: ['door-exit', 'go', 'Arrivals curb', 1],
  exit: ['door-exit', 'go', 'Exit', 2],
  nursing: ['baby-bottle', 'rest', 'Nursing room', 3],
  pet_relief: ['dog', 'svc', 'Pet relief', 3],
  pharmacy: ['pill', 'shop', 'Pharmacy', 3],
  atm: ['cash', 'svc', 'ATM', 3],
  landmark: ['flag', 'svc', 'Landmark', 1],
  service: ['help-circle', 'svc', 'Service desk', 3],
  medical: ['first-aid-kit', 'sec', 'Medical', 2],
  baggage_service: ['luggage', 'svc', 'Baggage service', 3],
  checkin: ['ticket', 'svc', 'Check-in', 1],
  bagdrop: ['luggage', 'svc', 'Bag drop', 2],
  rental_car: ['steering-wheel', 'go', 'Rental cars', 1],
  art: ['palette', 'svc', 'Art', 3],
  quiet: ['moon', 'svc', 'Quiet room', 3],
  smoking: ['smoking', 'svc', 'Smoking area', 3],
  chapel: ['building-church', 'svc', 'Chapel', 3],
  kids: ['mood-kid', 'svc', 'Play area', 3],
};
const kd = k => KIND[k] || ['map-pin', 'svc', 'Place', 3];
const TIER_Z = {1: 16, 2: 17.25, 3: 18.25};
const QUICK = [
  ['rest', 'Restrooms', 'toilet-paper', p => p.k === 'restroom' || p.k === 'family_restroom'],
  ['coffee', 'Coffee', 'coffee', p => p.k === 'coffee'],
  ['food', 'Food', 'tools-kitchen-2', p => p.k === 'food' || p.k === 'bar'],
  ['water', 'Water', 'droplet', p => p.k === 'water'],
  ['charge', 'Charging', 'plug', p => p.k === 'charging'],
  ['admirals', 'Admirals Club', 'armchair', p => p.k === 'lounge' && /admirals/i.test(p.name || '')],
  ['bags', 'Baggage', 'luggage', p => p.k === 'baggage' || p.k === 'baggage_service'],
  ['taxi', 'Taxi', 'car', p => p.k === 'taxi'],
  ['ride', 'Rideshare', 'car-suv', p => p.k === 'rideshare'],
  ['bus', 'Bus', 'bus', p => p.k === 'bus' || p.k === 'shuttle'],
  ['pre', 'PreCheck', 'shield-check', p => p.k === 'precheck'],
];
const NEARBY = [['restroom', 'family_restroom'], ['water'], ['coffee'], ['food'], ['charging']];
const AREA_C = {terminal: 'bld', building: 'bld', landside: 'land', airside: 'air', concourse: 'air', walkway: 'walkw',
  atrium: 'atr', food_court: 'atr', baggage: 'bag', security: 'sec', garage: 'gar', platform: 'plat', curb: 'curb', apron: 'apron', lounge: 'lng'};
const AREA_O = ['apron', 'garage', 'building', 'terminal', 'landside', 'airside', 'curb', 'platform', 'concourse', 'walkway',
  'atrium', 'food_court', 'baggage', 'security', 'lounge'];
const LABEL_K = new Set(['concourse', 'atrium', 'food_court', 'baggage', 'garage', 'lounge', 'terminal', 'security', 'walkway', 'platform']);
const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const LM_SKIP = new Set(['gate', 'elevator', 'escalator', 'stairs', 'charging', 'atm', 'service', 'exit', 'pet_relief']);

// ---------- small helpers ----------
const strip = s => String(s == null ? '' : s).replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
const norm = a => ((a + 180) % 360 + 360) % 360 - 180;
const brg = (a, b) => (Math.atan2(b[0] - a[0], b[1] - a[1]) / RAD + 360) % 360;   // xy in metres: x east, y north
const hyp = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const minT = s => s < 30 ? 'under 1 min' : `${Math.max(1, Math.round(s / 60))} min`;
const minN = s => Math.max(1, Math.round(s / 60));
const nat = (a, b) => String(a).localeCompare(String(b), 'en', {numeric: true});
const normG = s => String(s == null ? '' : s).toUpperCase().replace(/\s+/g, '').replace(/^GATE/, '').replace(/^([A-Z]*)0+(\d)/, '$1$2');
const concOf = g => { const m = normG(g).match(/^([A-Z])\d/); return m ? m[1] : null; };
const numOf = s => { const m = String(s == null ? '' : s).match(/\d+/); return m ? +m[0] : null; };
const enc = s => encodeURIComponent(s).replace(/%40/g, '@');
const T = iso => iso ? new Date(iso).getTime() : NaN;
const tilesOk = t => !!(t && typeof t.url === 'string' && t.url && (!/basemaps\.cartocdn\.com/.test(t.url) || /[?&](api_?key|key|token)=/i.test(t.url)));

// ---------- data prep (cached per nav object) ----------
const cache = new WeakMap();
function prep(nav) {
  if (!nav || !nav.graph || !Array.isArray(nav.graph.nodes)) return null;
  let P = cache.get(nav);
  if (P) return P;
  const c = nav.center || [0, 0], kx = Math.cos(c[0] * RAD);
  const xy = (lat, lon) => [(lon - c[1]) * kx * 111320, (lat - c[0]) * 110540];
  const nodes = new Map();
  for (const n of nav.graph.nodes) {
    if (!n || n.length < 4) continue;
    const [x, y] = xy(n[1], n[2]);
    nodes.set(n[0], {id: n[0], lat: n[1], lon: n[2], level: n[3], name: n[4] || null, x, y});
  }
  const adj = new Map(), corr = new Map();
  const add = (a, v) => { let l = adj.get(a); if (!l) adj.set(a, l = []); l.push(v); };
  for (const r of nav.graph.edges || []) {
    const a = nodes.get(r[0]), b = nodes.get(r[1]);
    if (!a || !b) continue;
    const e = {a: r[0], b: r[1], m: +r[2] || 0, k: r[3], note: r[4] || null, sec: +r[5] || null};
    add(e.a, {from: e.a, to: e.b, e});
    if (!ONE_WAY.has(e.k)) add(e.b, {from: e.b, to: e.a, e});
    if ((e.k === 'walk' || e.k === 'moving' || e.k === 'door' || e.k === 'outside') && a.level === b.level) {
      let l = corr.get(a.level); if (!l) corr.set(a.level, l = []);
      l.push([[a.lat, a.lon], [b.lat, b.lon]]);
    }
  }
  const pois = (nav.pois || []).filter(p => p && nodes.has(p.node) && p.lat != null).map(p => {
    const [x, y] = xy(p.lat, p.lon);
    return Object.assign({}, p, {x, y});
  });
  const byId = new Map(pois.map(p => [p.id, p]));
  const nodePois = new Map(), poisL = new Map(), gatesL = new Map();
  for (const p of pois) {
    (nodePois.get(p.node) || nodePois.set(p.node, []).get(p.node)).push(p);
    (poisL.get(p.level) || poisL.set(p.level, []).get(p.level)).push(p);
    if (p.k === 'gate') (gatesL.get(p.level) || gatesL.set(p.level, []).get(p.level)).push(p);
  }
  const labels = new Map();
  (nav.areas || []).forEach((a, i) => {
    const text = strip(a.label || a.name);
    const ring = a.geom && a.geom[0];
    if (!text || !LABEL_K.has(a.k) || !ring || ring.length < 3) return;
    let la = 0, lo = 0;
    const pts = ring.slice(0, -1);
    pts.forEach(p => { la += p[0]; lo += p[1]; });
    (labels.get(a.level) || labels.set(a.level, []).get(a.level)).push({id: i, text, lat: la / pts.length, lon: lo / pts.length});
  });
  const levels = (nav.levels || []).slice().sort((a, b) => a.id - b.id);
  P = {nav, code: nav.code, nodes, adj, corr, pois, byId, nodePois, poisL, gatesL, labels, levels, xy,
    gates: pois.filter(p => p.k === 'gate')};
  cache.set(nav, P);
  return P;
}
const lvObj = (P, id) => P.levels.find(l => l.id === id) || null;
const lvShort = (P, id) => { const l = lvObj(P, id); return `Level ${l ? l.short || l.id : id}`; };
// "Baggage Claim, level 1" from "Level 1: Baggage Claim"
function lvText(P, id) {
  const l = lvObj(P, id);
  if (!l) return `level ${id}`;
  let rest = String(l.name || '').replace(/^Level\s*\w+\s*[:·–-]\s*/i, '').trim();
  if (/^level\s*\w+$/i.test(rest)) rest = '';
  if (rest.length > 28 && rest.includes(',')) rest = rest.split(',')[0].trim();
  return rest ? `${rest}, level ${l.short || l.id}` : `level ${l.short || l.id}`;
}

// ---------- routing ----------
function cost(P, v, o) {
  const e = v.e;
  if (o.sf && (e.k === 'stairs' || e.k === 'escalator')) return Infinity;
  if (e.k === 'escalator' && e.note) {
    const up = P.nodes.get(v.to).level > P.nodes.get(v.from).level;
    if (/\bup only\b/i.test(e.note) && !up) return Infinity;
    if (/\bdown only\b/i.test(e.note) && up) return Infinity;
  }
  if (e.k === 'security') return o.tsa != null ? Math.max(60, o.tsa * 60) : (e.sec || FIXED.security);
  if (FIXED[e.k]) return e.sec || FIXED[e.k];
  if (e.sec) return e.sec;
  return e.m / (SPEED[e.k] || 1.3);
}
// Dijkstra from one or more nodes; stops at the first target reached.
function search(P, sources, o, targets) {
  const dist = new Map(), prev = new Map(), H = [];
  const push = (d, n) => {
    H.push([d, n]);
    let i = H.length - 1;
    while (i > 0) { const j = (i - 1) >> 1; if (H[j][0] <= H[i][0]) break; [H[i], H[j]] = [H[j], H[i]]; i = j; }
  };
  const pop = () => {
    const top = H[0], last = H.pop();
    if (H.length) {
      H[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < H.length && H[l][0] < H[m][0]) m = l;
        if (r < H.length && H[r][0] < H[m][0]) m = r;
        if (m === i) break;
        [H[i], H[m]] = [H[m], H[i]]; i = m;
      }
    }
    return top;
  };
  for (const s of sources) if (P.nodes.has(s)) { dist.set(s, 0); push(0, s); }
  while (H.length) {
    const [d, n] = pop();
    if (d > dist.get(n)) continue;
    if (targets && targets.has(n)) return {dist, prev, end: n};
    for (const v of P.adj.get(n) || []) {
      const c = cost(P, v, o);
      if (!(c < Infinity)) continue;
      const nd = d + c, od = dist.get(v.to);
      if (od === undefined || nd < od) { dist.set(v.to, nd); prev.set(v.to, v); push(nd, v.to); }
    }
  }
  return {dist, prev, end: null};
}
function pathBetween(P, a, b, o) {
  if (!P.nodes.has(a) || !P.nodes.has(b)) return null;
  if (a === b) return {hops: [], sec: 0};
  const r = search(P, [a], o, new Set([b]));
  if (!r.end) return null;
  const hops = [];
  let n = b, guard = 0;
  while (n !== a && guard++ < 100000) {
    const v = r.prev.get(n);
    hops.push({from: v.from, to: v.to, e: v.e, sec: cost(P, v, o)});
    n = v.from;
  }
  hops.reverse();
  return {hops, sec: r.dist.get(b)};
}

// ---------- flights at this airport ----------
function curDir() {
  const w = N.travelWindow && N.travelWindow();
  if (w) return w;
  const p = N.phase && N.phase();
  return p === 'before' ? 'out' : p ? 'ret' : null;
}
function nearest(list) {
  if (!list.length) return null;
  const now = N.now().getTime();
  const t = l => { const x = T(l.dep.time || l.arr.time); return isNaN(x) ? Infinity : Math.abs(x - now); };
  return list.slice().sort((a, b) => t(a) - t(b) || (a.dir === 'out' ? -1 : 1))[0];
}
function flightsAt(code) {
  let legs = [];
  try { legs = N.legs ? N.legs() : []; } catch (e) { N.report(e, 'nav legs'); }
  const arrs = legs.filter(l => l.to === code), deps = legs.filter(l => l.from === code);
  const dir = curDir();
  const strictA = dir && arrs.find(l => l.dir === dir) || null;
  const strictD = dir && deps.find(l => l.dir === dir) || null;
  const arr = strictA || nearest(arrs);
  const dep = (arr && deps.find(l => l.dir === arr.dir)) || strictD || nearest(deps);
  return {dir, arr, dep, strictA, strictD};
}

// ---------- gates, hubs, endpoints ----------
// Exact ref, then terminal + gate, then a letter-prefixed ref.
function matchGate(P, gate, term) {
  const g = normG(gate);
  if (!g) return null;
  const t = normG(term);
  const inT = p => !t || [p.terminal, p.concourse].some(x => x && normG(x) === t);
  const exact = P.gates.filter(p => normG(p.ref) === g);
  if (exact.length) return exact.find(inT) || exact[0];
  if (t) {
    const tg = P.gates.find(p => normG(p.ref) === t + g);
    if (tg) return tg;
  }
  const m = g.match(/^([A-Z]+)(\d+[A-Z]?)$/);
  if (m) {
    const x = P.gates.find(p => normG(p.ref) === m[2] && [p.terminal, p.concourse].some(c => c && normG(c) === m[1]));
    if (x) return x;
  }
  if (/^\d/.test(g)) {
    const x = P.gates.filter(p => normG(p.ref).replace(/^[A-Z]+/, '') === g);
    if (x.length === 1) return x[0];
    const y = x.filter(inT);
    if (y.length === 1) return y[0];
  }
  return null;
}
function nearestNode(P, lat, lon, level) {
  const [x, y] = P.xy(lat, lon);
  let best = null, bd = Infinity;
  for (const n of P.nodes.values()) {
    if (level != null && n.level !== level) continue;
    const d = (n.x - x) ** 2 + (n.y - y) ** 2;
    if (d < bd) { bd = d; best = n; }
  }
  return best ? {node: best, d: Math.sqrt(bd)} : null;
}
const centroid = ps => ps.reduce((a, p) => [a[0] + p.lat / ps.length, a[1] + p.lon / ps.length], [0, 0]);
// Where to send someone when the gate isn't posted: the concourse, else the
// main airside landmark, else the middle of the gates.
function hubFor(P, conc) {
  if (conc) {
    const re = new RegExp('^Concourse ' + conc + '\\b', 'i');
    let best = null;
    for (const n of P.nodes.values()) if (n.name && re.test(n.name) && (!best || (/entrance/i.test(n.name) && !/entrance/i.test(best.name)))) best = n;
    if (best) return {node: best.id, label: `Concourse ${conc}`};
    const area = (P.nav.areas || []).find(a => a.k === 'concourse' && re.test(a.label || a.name || ''));
    if (area && area.geom && area.geom[0]) {
      const ring = area.geom[0].map(p => ({lat: p[0], lon: p[1]}));
      const c = centroid(ring), nn = nearestNode(P, c[0], c[1], area.level);
      if (nn) return {node: nn.node.id, label: `Concourse ${conc}`};
    }
    const gs = P.gates.filter(p => (p.concourse && normG(p.concourse) === conc) || normG(p.ref).startsWith(conc));
    if (gs.length) {
      const c = centroid(gs), nn = nearestNode(P, c[0], c[1], gs[0].level);
      if (nn) return {node: nn.node.id, label: `Concourse ${conc}`};
    }
  }
  const lm = P.pois.find(p => p.k === 'landmark' && p.side === 'air') || P.pois.find(p => p.k === 'clear' && p.side === 'air');
  if (lm) return {node: lm.node, label: strip(lm.name), poi: lm};
  if (P.gates.length) {
    const c = centroid(P.gates), nn = nearestNode(P, c[0], c[1], P.gates[0].level);
    if (nn) return {node: nn.node.id, label: 'the gates'};
  }
  return null;
}
function poiEnd(key, p, extra) {
  return Object.assign({key, node: p.node, poi: p, kind: p.k === 'gate' ? 'gate' : 'poi',
    label: p.k === 'gate' ? `Gate ${p.ref}` : strip(p.name) || kd(p.k)[2], ref: p.ref || null,
    side: p.side, level: p.level, lat: p.lat, lon: p.lon}, extra || {});
}
function nodeEnd(P, key, id, extra) {
  const n = P.nodes.get(id);
  if (!n) return null;
  return Object.assign({key, node: id, kind: 'node', label: strip(n.name) || 'that spot', level: n.level, lat: n.lat, lon: n.lon}, extra || {});
}
function resolve(st, key) {
  if (!key) return null;
  const P = st.P, fl = st.fl;
  if (key === '@here') {
    const hr = st.manual || st.gpsHere;
    if (!hr) return null;
    return nodeEnd(P, key, hr.node, {kind: 'here', label: hr.label, side: hr.side || null});
  }
  if (key === '@arr' || key === '@dep') {
    const arr = key === '@arr', L = arr ? fl.arr : fl.dep;
    if (!L) return null;
    const s = arr ? L.arr : L.dep;
    const g = matchGate(P, s.gate, s.terminal);
    if (g) return poiEnd(key, g, {leg: L});
    const hb = hubFor(P, concOf(s.gate));
    if (!hb) return null;
    const note = s.gate
      ? `Gate ${s.gate} isn’t on this map — showing the way to ${mid(hb.label)}`
      : `Gate not posted yet — showing the way to ${mid(hb.label)}; this updates when the gate posts`;
    // the same gap at the start of a route reads differently
    const noteFrom = s.gate
      ? `Gate ${s.gate} isn’t on this map — starting from ${hb.label}`
      : `${arr ? 'Arrival gate' : 'Gate'} not posted yet — starting from ${mid(hb.label)}; this updates when it posts`;
    return hb.poi ? poiEnd(key, hb.poi, {kind: 'hub', label: hb.label, note, noteFrom, leg: L})
      : nodeEnd(P, key, hb.node, {kind: 'hub', label: hb.label, side: 'air', note, noteFrom, leg: L});
  }
  if (key === '@bag') {
    const L = fl.arr;
    const bags = P.pois.filter(p => p.k === 'baggage').sort((a, b) => nat(a.ref || a.name, b.ref || b.name));
    if (!bags.length) return null;
    const want = L ? numOf(L.arr.baggage) : null;
    const c = want != null && bags.find(p => numOf(p.ref != null ? p.ref : p.name) === want);
    if (c) return poiEnd(key, c, {leg: L});
    const mid = bags[Math.floor((bags.length - 1) / 2)];
    return poiEnd(key, mid, {kind: 'hub', label: 'Baggage Claim', leg: L,
      note: L && L.arr.baggage ? `Carousel ${L.arr.baggage} isn’t on this map — showing the way to Baggage Claim`
        : 'Carousel not posted yet — showing the way to Baggage Claim; this updates when it posts'});
  }
  const p = P.byId.get(key);
  if (p) return poiEnd(key, p);
  const g = matchGate(P, key);
  if (g) return poiEnd(key, g);
  return nodeEnd(P, key, key);
}
function departFrom(st) {
  const pr = (st.P.nav.presets || []).find(x => x.when === 'depart' && !String(x.from).startsWith('@') && st.P.byId.has(x.from));
  if (pr) return pr.from;
  const c = st.P.pois.find(p => p.k === 'curb_dep') || st.P.pois.find(p => p.k === 'checkin');
  return c ? c.id : null;
}
function defaultFrom(st) {
  if (st.manual || st.gpsHere) return '@here';
  const fl = st.fl;
  if (fl.strictA || (!fl.dir && fl.arr)) return '@arr';
  if (fl.strictD || (!fl.dir && fl.dep)) { const k = departFrom(st); if (k) return k; }
  const hb = hubFor(st.P, null);
  return hb ? (hb.poi ? hb.poi.id : hb.node) : null;
}
const opts = st => ({sf: !!st.sf, tsa: typeof st.tsa === 'number' ? st.tsa : null});

// ---------- route + steps ----------
function buildRoute(st) {
  const P = st.P, pts = [st.A, ...st.V, st.B], o = opts(st);
  let fell = false;
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    let p = pathBetween(P, pts[i].node, pts[i + 1].node, o);
    if (!p && o.sf) { p = pathBetween(P, pts[i].node, pts[i + 1].node, Object.assign({}, o, {sf: false})); if (p) fell = true; }
    if (!p) return null;
    segs.push(p);
  }
  const hops = segs.flatMap(s => s.hops);
  const steps = [];
  // a stop at a checkpoint needs no step of its own: the security step names it
  const cpVia = (x, j) => !!(x && x.poi && /^(checkpoint|precheck|clear)$/.test(x.poi.k)
    && [segs[j], segs[j + 1]].some(g => g && g.hops.some(y => y.e.k === 'security')));
  let side = st.A.side || null;
  segs.forEach((s, i) => {
    const last = i === segs.length - 1;
    const cx = {first: i === 0, start: pts[i], end: pts[i + 1], last, side,
      quietEnd: !last && cpVia(pts[i + 1], i), quietStart: i > 0 && cpVia(pts[i], i - 1)};
    steps.push(...stepsFor(st, s.hops, cx));
    side = cx.sideOut;
  });
  const levels = new Set([st.A.level, st.B.level]);
  hops.forEach(x => { levels.add(P.nodes.get(x.from).level); levels.add(P.nodes.get(x.to).level); });
  return {
    hops, steps, fell, levels,
    sec: segs.reduce((a, s) => a + s.sec, 0),
    walkM: hops.reduce((a, x) => a + (x.e.k === 'train' ? 0 : x.e.m), 0),
    hasSec: hops.some(x => x.e.k === 'security'), hasTrain: hops.some(x => x.e.k === 'train'),
  };
}
// A place name as it reads in a sentence: no "(Level 3)" or ", gate level" tail, and a
// node named only for its floor ("Level 3, top of the escalators") is not a place.
function clean(s) {
  let t = strip(s);
  if (!t || /^level\s*\w+\s*(,|$)/i.test(t)) return null;
  t = t.replace(/,\s*(level\s*\w+|gate level)$/i, '').replace(/^Level \d+[A-Z]?\s+(?=[a-z])/, '')
    // "Atrium, east end" -> "East end of the atrium"
    .replace(/^(.+), (east|west|north|south) end$/i, (m, a, d) => `${d} end of ${mid(a)}`)
    .replace(/^(.+), (center|centre)$/i, (m, a) => `middle of ${mid(a)}`)
    .replace(/^([A-Z][a-z][^,]*), (east|west|north|south)$/i, (m, a, d) => `${d} ${COMMON.test(a.split(' ')[0]) ? a.charAt(0).toLowerCase() + a.slice(1) : a}`);
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : null;
}
// "the food hall", "the Plaza", but "Gate C9" and "Concourse B" stay as they are.
const GENERIC = /^(escalators?|elevators?|stairs|restrooms?|family restroom|food (hall|court)|baggage claim(?! \d)|moving walkways?|check-in|security|main|tsa|arrivals|departures|bus curb|curb|information desk|guest services|ticketing|exit|atrium|plaza|water feature|garage|covered walkway|west|east|north|south|hotel|taxi stand|taxis|rideshare|oversize|bag drop|security checkpoint)\b/i;
const THE_END = /\b(connector|bridge|hub|walkway|rotunda|plaza|atrium|mezzanine|exit|entrance|stop|stand|pickup|counters|buses|shuttles|lanes|desk)$/i;
// first words that are ordinary nouns, so "Rental car counters" reads "the rental car counters"
const COMMON = /^(rental|rideshare|taxi|bus|buses|shuttles?|hotel|parking|cell|baggage|oversize|security|ticket|restrooms?|family|nursing|lost|currency|water|food|information|guest|airline|curb|ride|app|passenger|departures|arrivals|ground|public|main|central|east|west|north|south|hourly|daily|economy)$/i;
function mid(s) {
  if (!s) return s;
  if (/^the /.test(s)) return s;
  if (/^The /.test(s)) return 'the ' + s.slice(4);
  if (/^(Uber|Lyft)\b/.test(s)) return 'the ' + s;
  // "Baggage Claim" reads "the baggage claim": the whole common-noun part goes lower case
  if (GENERIC.test(s)) { const w = s.match(GENERIC)[0]; return 'the ' + (/^[A-Z][a-z]/.test(s) ? w.toLowerCase() + s.slice(w.length) : s); }
  if (!THE_END.test(s.split(',')[0]) || /^(Gate|Door)s?\b/.test(s)) return s;
  return 'the ' + (COMMON.test(s.split(' ')[0]) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
}
const AREA = /\b(plaza|hall|court|claim|atrium|mezzanine|concourse|bridge|hub|lobby|ticketing|check-in|security|checkpoint|terminal|station|platform|curb|garage|gates?)\b/i;
// "Gate C9 is", "the rental car counters are"
const be = s => /\band\b/.test(s) || /[a-z](es|[^su]s)$/.test(String(s).split(',')[0]) ? 'are' : 'is';
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const NUMW = ['', 'one', 'two', 'three', 'four', 'five'];
// "Door 22" for "Door 22, departures curb"
const shortDoor = t => { const m = String(t).match(/^(?:Outside )?(Doors? [A-Z]?\d+[A-Z]?)\b/i); return m ? m[1] : t; };
// A short name for a graph node: its own name, or a landmark POI at it.
function placeName(P, id, gatesOk, skip) {
  const n = P.nodes.get(id);
  if (!n) return null;
  const ok = t => t && !(skip && skip.has(t)) ? t : null;
  const own = ok(clean(n.name));
  if (own) return own;
  const ps = P.nodePois.get(id) || [];
  for (const q of ps) {
    if (q.k === 'gate' ? !gatesOk : kd(q.k)[3] !== 1) continue;
    const t = ok(q.k === 'gate' ? `Gate ${q.ref}` : clean(q.name));
    if (t) return t;
  }
  return null;
}
function nearName(P, n, r, skip, noGates) {
  let best = null, bd = r;
  for (const m of P.nodes.values()) {
    if (!m.name || m.level !== n.level) continue;
    const d = Math.hypot(m.x - n.x, m.y - n.y);
    if (d >= bd) continue;
    const t = clean(m.name);
    if (t && !(skip && skip.has(t))) { bd = d; best = t; }
  }
  for (const p of P.poisL.get(n.level) || []) {
    if (p.k === 'gate' ? noGates : kd(p.k)[3] !== 1) continue;
    const d = Math.hypot(p.x - n.x, p.y - n.y);
    if (d >= bd) continue;
    const t = p.k === 'gate' ? `Gate ${p.ref}` : clean(p.name);
    if (t && !(skip && skip.has(t))) { bd = d; best = t; }
  }
  return best;
}
// A shop or café right at a corner, for turns with no named place.
function shopNear(P, n, r, skip) {
  let best = null, bd = r;
  for (const p of P.poisL.get(n.level) || []) {
    if (LM_SKIP.has(p.k) || !p.name) continue;
    const d = Math.hypot(p.x - n.x, p.y - n.y), t = clean(p.name);
    if (d < bd && t && !(skip && skip.has(t))) { bd = d; best = /^curb/.test(p.k) ? shortDoor(t) : t; }
  }
  return best;
}
// Where p sits relative to a polyline: perpendicular distance, distance
// along it, and which side (x east, y north).
function along(poly, p) {
  let best = {d: Infinity, t: 0, side: 'right'}, acc = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i], vx = b[0] - a[0], vy = b[1] - a[1], L2 = vx * vx + vy * vy, L = Math.sqrt(L2);
    const u = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2)) : 0;
    const qx = a[0] + vx * u, qy = a[1] + vy * u, d = Math.hypot(p[0] - qx, p[1] - qy);
    if (d < best.d) best = {d, t: acc + L * u, side: vx * (p[1] - a[1]) - vy * (p[0] - a[0]) > 0 ? 'left' : 'right'};
    acc += L;
  }
  return best;
}
function turnOf(ang) {
  const a = Math.abs(ang), side = ang > 0 ? 'right' : 'left';
  if (a > 160) return ['Turn around', 'arrow-back-up'];
  if (a > 135) return [`Make a sharp ${side}`, `arrow-sharp-turn-${side}`];
  if (a > 60) return [`Turn ${side}`, `corner-up-${side}`];
  return [`Bear ${side}`, `arrow-bear-${side}`];
}
// One walking stretch (moving walkways included) cut into steps at real turns.
function walkSteps(st, hops, ids, nodes, cx) {
  const P = st.P, xs = nodes.map(n => [n.x, n.y]), cum = [0];
  for (let i = 1; i < xs.length; i++) cum.push(cum[i - 1] + hyp(xs[i - 1], xs[i]));
  const total = cum[cum.length - 1];
  const at = d => {
    d = Math.max(0, Math.min(total, d));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const a = xs[i - 1], b = xs[i], seg = cum[i] - cum[i - 1] || 1, t = (d - cum[i - 1]) / seg;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  // the change of direction from 15 m before d0 to 15 m after d1
  const W = 15;
  const turnAng = (d0, d1) => norm(brg(at(d1), at(d1 + W)) - brg(at(d0 - W), at(d0)));
  const cand = [];
  for (let i = 1; i < xs.length - 1; i++) {
    const d = cum[i];
    if (d < 3 || total - d < 3) continue;
    const ang = turnAng(d, d);
    if (Math.abs(ang) > 30) cand.push({i, d, ang});
  }
  // kinks within 20 m of each other are one turn, or a jog when they cancel out
  const cls = [];
  for (const c of cand) {
    const k = cls[cls.length - 1];
    if (k && c.d - k.end < 20) { k.end = c.d; k.all.push(c); } else cls.push({start: c.d, end: c.d, all: [c]});
  }
  const skip = cx.skip;
  let turns = [];
  for (const k of cls) {
    const net = turnAng(k.start, k.end);
    if (Math.abs(net) < 35) continue;
    const pick = k.all.reduce((a, c) => Math.abs(c.ang) > Math.abs(a.ang) ? c : a);
    // a corner then a bend reads as the corner, not one sharp turn
    const ang = Math.sign(net) * Math.min(Math.abs(net), Math.abs(pick.ang));
    const n = nodes[pick.i];
    turns.push({i: pick.i, d: pick.d, ang, s: k.start, e: k.end,
      name: placeName(P, ids[pick.i], true, skip) || nearName(P, n, 20, skip) || shopNear(P, n, 12, skip)});
  }
  // two turns at the same named place are one way through it (a plaza, a hall)
  for (let j = 1; j < turns.length;) {
    const a = turns[j - 1], b = turns[j];
    if (a.name && a.name === b.name && b.d - a.d < 45) {
      const ang = turnAng(a.s, b.e);
      if (Math.abs(ang) < 35) { turns.splice(j - 1, 2); j = Math.max(1, j - 1); continue; }
      a.ang = ang; a.e = b.e; turns.splice(j, 1); continue;
    }
    j++;
  }
  // a turn in the first metres is only which way to set off; one in the last
  // metres is the side your destination is on
  let head = 0, dropD = null;
  if (turns.length && turns[0].d < 15) head = turns.shift().d;
  if (turns.length && total - turns[turns.length - 1].d < (cx.tail || 8)) dropD = turns.pop().d;
  const bounds = [0, ...turns.map(t => t.i), xs.length - 1];
  const lv = nodes[0].level, out = [];
  for (let j = 0; j < bounds.length - 1; j++) {
    const s = bounds[j], e = bounds[j + 1];
    const poly = xs.slice(s, e + 1), len = cum[e] - cum[s];
    let sec = 0, m = 0, mov = 0, movN = 0;
    for (let k = s; k < e; k++) {
      sec += hops[k].sec; m += hops[k].e.m;
      if (hops[k].e.k === 'moving') { mov += hops[k].e.m; if (k === s || hops[k - 1].e.k !== 'moving') movN++; }
    }
    // toward: the farthest named place on this stretch, else what comes next
    // toward: what this stretch ends at (the escalators, your gate), else the farthest named place on it
    let toward = e === xs.length - 1 ? (cx.atEnd ? cx.end && cx.end.label : cx.nextName) : null;
    for (let k = e; k > s && !toward; k--) toward = placeName(P, ids[k], false, skip);
    const ride = mov >= 30 && mov >= .5 * (m || len), walks = movN > 1 ? 'moving walkways' : 'moving walkway';
    let text, ic, atName = null;
    if (j === 0) {
      const d0 = Math.min(head, Math.max(0, total - 1));
      const b0 = brg(at(d0), at(Math.min(d0 + 25, cum[e])));
      const go = ride ? `take the ${walks}` : `head ${COMPASS[Math.round(b0 / 45) % 8]}`;
      text = cap(`${cx.pre || ''}${go}${toward ? ` toward ${mid(toward)}` : ''}`);
      ic = 'walk';
    } else {
      const t = turns[j - 1], [verb, tic] = turnOf(t.ang);
      atName = t.name;
      text = !atName ? verb : /^Gates [A-Z]?\d+\w*\s*[–-]/.test(atName) ? `${verb} for ${atName}` : `${verb} at ${mid(atName)}`;
      ic = tic;
    }
    const sub = [], nextAt = turns[j] && turns[j].name;
    if (j > 0 && toward && toward !== atName) sub.push(`Toward ${mid(toward)}`);
    if (j > 0 && ride) sub.push(`${cap(walks)} most of the way`);
    else if (!ride && mov >= 20) sub.push(`${cap(walks)} on the way`);
    // gates passed, in walking order
    const passed = [];
    for (const g of P.gatesL.get(lv) || []) {
      const gn = `Gate ${g.ref}`;
      if (skip.has(gn) || gn === toward || gn === atName || gn === nextAt) continue;
      const a = along(poly, [g.x, g.y]);
      if (a.d <= 24 && a.t > 4 && a.t < len - 4) passed.push({ref: g.ref, t: a.t});
    }
    // a range reads low to high: "Pass gates E1–E15"
    const rk = r => { const m = String(r).match(/^([A-Z]*)(\d+)(.*)$/); return m ? [m[1], +m[2], m[3]] : [String(r), 0, '']; };
    const lo = (a, b) => { const x = rk(a.ref), y = rk(b.ref); return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1] || (x[2] < y[2] ? -1 : 1); };
    passed.sort(lo);
    if (passed.length === 1) sub.push(`Pass gate ${passed[0].ref}`);
    else if (passed.length > 1) sub.push(`Pass gates ${passed[0].ref}–${passed[passed.length - 1].ref}`);
    // baggage halls: the carousels you walk past
    const bags = [];
    for (const b of P.poisL.get(lv) || []) {
      if (b.k !== 'baggage' || !b.ref || skip.has(clean(b.name)) || clean(b.name) === toward || clean(b.name) === atName || clean(b.name) === nextAt) continue;
      const a = along(poly, [b.x, b.y]);
      if (a.d <= 20 && a.t > 4 && a.t < len - 4) bags.push(b);
    }
    const bagSet = new Set(bags.map(b => clean(b.name)));
    if (bags.length > 1) {
      bags.sort(lo);
      const word = /^baggage claim/i.test(bags[0].name) ? 'baggage claims' : 'carousels';
      sub.push(`Pass ${word} ${bags[0].ref}–${bags[bags.length - 1].ref}`);
    } else bagSet.clear();
    // one or two landmarks within about 30 m, with the side
    const lms = [];
    for (const p of P.poisL.get(lv) || []) {
      if (LM_SKIP.has(p.k)) continue;
      let name = clean(p.name) || kd(p.k)[2];
      if (/^curb/.test(p.k)) name = shortDoor(name);
      if (skip.has(name)) continue;
      const a = along(poly, [p.x, p.y]);
      if (a.d > 30 || a.t < 2 || a.t > len - 2) continue;
      const tier = kd(p.k)[3];
      const score = (tier === 1 ? 30 : (p.k === 'food' || p.k === 'coffee' || p.k === 'bar') ? 20 : p.k === 'shop' ? 12 : 8) - a.d / 3;
      lms.push({name, side: a.side, score});
    }
    lms.sort((a, b) => b.score - a.score);
    const seen = new Set([toward, atName]);
    const take = len > 150 ? 2 : 1;
    let took = 0;
    for (const l of lms) {
      if (took >= take) break;
      if (seen.has(l.name) || cx.said.has(l.name) || bagSet.has(l.name) || l.name === nextAt) continue;
      seen.add(l.name); cx.said.add(l.name); took++;
      sub.push(`${l.name} on your ${l.side}`);
    }
    out.push({kind: 'walk', icon: ic, text, sub: sub.join(' · '), m: m || len, sec, level: lv,
      pts: nodes.slice(s, e + 1).map(n => [n.lat, n.lon]), at: [nodes[s].lat, nodes[s].lon]});
  }
  // the direction you are walking as you reach the end, for "on your left"
  const dE = dropD != null ? dropD : total;
  if (out.length && total > 2) out[out.length - 1].appr = [at(dE - 25), at(dE)];
  return out;
}
const vertWord = (k, note, many) => k === 'elevator' ? (note && /elevators?\b/i.test(note) ? `the ${strip(note)}` : 'the elevator')
  : k === 'stairs' ? 'the stairs' : many ? 'the escalators' : 'the escalator';
function nextName(P, run) {
  if (!run) return null;
  const k = run.k, e = run.hops[0].e;
  if (VERT.has(k)) return k === 'elevator' ? 'the elevator' : k === 'stairs' ? 'the stairs' : 'the escalators';
  if (k === 'security') return e.note ? mid(strip(e.note)) : 'security';
  if (k === 'exit') return 'the exit';
  if (k === 'door') return e.note || doorName(P, [e.a, e.b]) || 'the doors';
  if (k === 'train') return 'the train';
  return null;
}
function doorName(P, ids) {
  // "Outside Door 21" and "Door 21, check-in hall" are both just Door 21
  const short = t => { const m = t.match(/\bDoors? [A-Z]?\d+[A-Z]?\b/i); return m ? m[0] : t; };
  for (const id of ids) {
    const n = P.nodes.get(id);
    if (n && n.name && /door/i.test(n.name)) return short(strip(n.name));
    const p = (P.nodePois.get(id) || []).find(q => /door/i.test(q.name || ''));
    if (p) return short(strip(p.name));
  }
  return null;
}
// A node is outdoors when it is named so or an outdoor path leaves it.
function outdoor(P, id) {
  const n = P.nodes.get(id);
  return !!(n && /^outside\b/i.test(n.name || '')) || (P.adj.get(id) || []).some(v => v.e.k === 'outside');
}
const levelOf = (P, id) => P.nodes.get(id).level;
// "Security and gates" from "Level 3 · Security and gates"
const lvDesc = (P, id) => { const l = lvObj(P, id); return l ? String(l.name || '').replace(/^Level\s*\w+\s*[:·–-]\s*/i, '').replace(/^level\s*\w+$/i, '').trim() : ''; };
function stepsFor(st, hops, cx) {
  const P = st.P, out = [], said = new Set();
  const nd = id => P.nodes.get(id);
  const ll = n => [n.lat, n.lon];
  // walking and moving walkways are one stretch; each lift, escalator or stair flight its own
  const runs = [];
  for (const x of hops) {
    const k = x.e.k === 'moving' ? 'walk' : x.e.k, g = VERT.has(k) ? 'v:' + k : k;
    const r = runs[runs.length - 1];
    if (r && r.g === g && k !== 'security' && k !== 'exit' && k !== 'door') r.hops.push(x);
    else runs.push({g, k, hops: [x], n: 1});
  }
  // up two floors by escalator with a few steps between is one step
  const dirOf = r => Math.sign(levelOf(P, r.hops[r.hops.length - 1].to) - levelOf(P, r.hops[0].from));
  for (let i = 0; i + 2 < runs.length;) {
    const a = runs[i], w = runs[i + 1], b = runs[i + 2];
    const wm = w.hops.reduce((s, x) => s + x.e.m, 0);
    if (VERT.has(a.k) && w.k === 'walk' && wm < 40 && b.g === a.g && dirOf(a) && dirOf(a) === dirOf(b)) {
      a.hops.push(...w.hops, ...b.hops);
      a.n += b.n;
      (a.mids || (a.mids = [])).push(levelOf(P, b.hops[0].from));
      runs.splice(i + 1, 2);
      continue;
    }
    i++;
  }
  const skip = new Set([cx.start && cx.start.label, cx.end && cx.end.label,
    cx.start && cx.start.poi && clean(cx.start.poi.name), cx.end && cx.end.poi && clean(cx.end.poi.name)].filter(Boolean));
  let side = cx.side;
  runs.forEach((run, ri) => {
    const prev = runs[ri - 1], next = runs[ri + 1], k = run.k;
    const ids = [run.hops[0].from, ...run.hops.map(x => x.to)];
    const nodes = ids.map(nd);
    const m = run.hops.reduce((a, x) => a + x.e.m, 0), sec = run.hops.reduce((a, x) => a + x.sec, 0);
    const e = run.hops[0].e, lv = nodes[0].level;
    const base = {kind: k, m, sec, level: lv, pts: nodes.map(ll), at: ll(nodes[0])};
    let toward = null;
    for (let i = nodes.length - 1; i > 0 && !toward; i--) toward = placeName(P, ids[i], false, skip);
    if (!toward) toward = next ? nextName(P, next) : cx.end.label;
    if (k === 'outside' && !next) toward = cx.end.label;
    if (k === 'walk') {
      let pre = '';
      if (prev) {
        if (VERT.has(prev.k)) pre = prev.k === 'elevator' ? 'Off the elevator, ' : dirOf(prev) > 0 ? 'At the top, ' : 'At the bottom, ';
        else if (prev.k === 'security') pre = 'After security, ';
        else if (prev.k === 'train') pre = 'Off the train, ';
        else if (prev.k === 'exit') pre = 'Past the exit lane, ';
        else if (prev.k === 'door') pre = prev.outward ? 'Outside, ' : 'Inside, ';
      } else if (cx.start && !cx.quietStart && cx.start.kind !== 'here') {
        const sl = cx.start.label.length <= 18 ? cx.start.label : cx.start.label.split(',')[0].replace(/^PHX /, '');
        if (sl.length <= 22) pre = `From ${mid(sl)}, `;
      }
      const nk = next && next.k;
      const tail = !next ? 15 : VERT.has(nk) || nk === 'security' || nk === 'door' || nk === 'exit' ? 10 : 8;
      const sk = prev && prev.top ? new Set([...skip, prev.top, cap(prev.top)]) : skip;
      out.push(...walkSteps(st, run.hops, ids, nodes, {end: cx.end, skip: sk, said, pre, tail, atEnd: !next, nextName: nextName(P, next)}));
    } else if (VERT.has(k)) {
      const to = nodes[nodes.length - 1].level, up = to > lv;
      const note = run.hops.map(x => x.e.note).find(Boolean);
      const what = vertWord(k, note, run.n > 1);
      const ix = id => P.levels.findIndex(l => l.id === id);
      const fl = Math.abs(ix(to) - ix(lv));
      const nogo = t => t && /\b(escalators?|elevators?|stairs|moving|doors?)\b/i.test(t.split(',')[0]) ? null : t;
      const last = nodes[nodes.length - 1];
      const place = nogo(placeName(P, ids[ids.length - 1], false, skip)) || nogo(nearName(P, last, 15, skip, true));
      // name the top only when it is an area you arrive in (the Plaza, baggage claim), not a desk
      const top = place && AREA.test(place.split(',')[0]) ? place.split(',')[0].trim() : null;
      run.top = top;
      const dest = top ? `${mid(top)}, ${lvShort(P, to)}` : lvShort(P, to);
      const sub = [];
      if (fl > 1) sub.push(run.mids && k === 'escalator' ? `${cap(NUMW[fl] || String(fl))} floors: change escalators at ${lvShort(P, run.mids[0])}` : `${cap(NUMW[fl] || String(fl))} floors`);
      if (!top && side === 'land' && lvDesc(P, to)) sub.push(lvDesc(P, to));
      // a note like "one level down from the Plaza" only helps going down
      if (note && !what.includes(strip(note)) && !(up ? /\bdown\b/i : /\bup\b/i).test(note) && !/^(up|down)( only)?\.?$/i.test(note.trim())) sub.push(note);
      out.push(Object.assign(base, {kind: 'vert', toLevel: to,
        icon: k === 'elevator' ? 'elevator' : k === 'stairs' ? 'stairs' : up ? 'escalator-up' : 'escalator-down',
        text: to === lv ? `Take ${what}` : `Take ${what} ${up ? 'up' : 'down'} to ${dest}`,
        sub: sub.join(' · ')}));
    } else if (k === 'security') {
      let name = e.note ? strip(e.note) : null;
      if (!name) {
        const cp = (P.poisL.get(lv) || []).filter(p => p.k === 'checkpoint' || p.k === 'precheck')
          .map(p => ({p, d: Math.hypot(p.x - nodes[0].x, p.y - nodes[0].y)})).sort((a, b) => a.d - b.d)[0];
        name = cp && cp.d < 80 ? strip(cp.p.name) : 'the checkpoint';
      }
      const paren = e.note && (String(e.note).match(/\(([^)]*)\)/) || [])[1];
      const wait = typeof st.tsa === 'number' ? `about ${Math.round(st.tsa)} min now` : `allow about ${minN(sec)} min`;
      out.push(Object.assign(base, {icon: 'shield-check', text: `Clear security at ${mid(name)} — ${wait}`,
        sub: [paren, 'Have your ID and boarding pass out'].filter(Boolean).join(' · ')}));
      side = 'air';
    } else if (k === 'exit') {
      out.push(Object.assign(base, {icon: 'door-exit', text: 'Leave through the exit lane — no re-entry',
        sub: e.note && !/re-?entry/i.test(e.note) ? e.note : ''}));
      side = 'land';
    } else if (k === 'door') {
      const o0 = outdoor(P, ids[0]), o1 = outdoor(P, ids[ids.length - 1]);
      const curbish = x => !!x && (/curb|outside|garage|parking|pickup|taxi|bus|shuttle|rideshare/i.test(x.label || '') || /^(curb|garage|parking|rideshare|taxi|bus|shuttle|transit)/.test((x.poi && x.poi.k) || ''));
      const outward = o0 !== o1 ? o1 : !prev ? !curbish(cx.start) : !next ? curbish(cx.end) : !(prev.k === 'outside');
      const dn = e.note || doorName(P, ids) || 'the doors';
      run.outward = outward;
      out.push(Object.assign(base, {icon: outward ? 'door-exit' : 'door-enter', text: `Go ${outward ? 'out' : 'in'} through ${dn}`, sub: ''}));
    } else if (k === 'outside') {
      const note = run.hops.map(x => x.e.note).find(Boolean);
      out.push(Object.assign(base, {icon: 'walk', text: note || `Walk outside to ${mid(toward) || 'the curb'}`, sub: note && toward ? `Toward ${mid(toward)}` : ''}));
    } else if (k === 'train') {
      const note = String(e.note || '');
      const [nm, freq] = note.split(';').map(s => s.trim());
      const stop = placeName(P, ids[ids.length - 1], false) || nearName(P, nodes[nodes.length - 1], 60) || 'the next stop';
      const n = run.hops.length, stops = n === 1 ? 'one stop' : n === 2 ? 'two stops' : `${n} stops`;
      const name = nm ? (/^the\b/i.test(nm) ? nm : `the ${nm}`) : 'the train';
      out.push(Object.assign(base, {icon: 'train', text: `Ride ${name} ${stops} to ${mid(stop)}`, sub: freq ? `Trains ${freq}` : ''}));
    } else {
      out.push(Object.assign(base, {icon: 'walk', text: toward ? `Walk to ${mid(toward)}` : 'Keep walking', sub: ''}));
    }
  });
  // which side the destination is on, from the way you walk up to it
  const B = cx.end;
  let side2 = null;
  const lastS = out[out.length - 1];
  if (lastS && lastS.appr && B.lat != null) {
    const [p1, p2] = lastS.appr, p = P.xy(B.lat, B.lon);
    if (hyp(p1, p2) > 1 && hyp(p2, p) >= 4) {
      const a = norm(brg(p2, p) - brg(p1, p2));
      side2 = Math.abs(a) < 30 ? null : a > 0 ? 'right' : 'left';
    }
  }
  // fold walking bits under 8 m into a neighbour, and a short walk up to an
  // escalator, checkpoint or door into that step
  const NEXT_OK = new Set(['vert', 'security', 'exit', 'door']);
  for (let i = 0; i < out.length; i++) {
    const s = out[i];
    if (s.kind !== 'walk' || out.length < 2) continue;
    const nx = out[i + 1];
    if (s.m < 20 && nx && NEXT_OK.has(nx.kind)) {
      nx.pts = s.pts.slice(0, -1).concat(nx.pts); nx.m += s.m; nx.sec += s.sec;
      out.splice(i, 1); i--; continue;
    }
    if (s.m >= 8) continue;
    const into = out[i - 1] || nx;
    if (!into) continue;
    if (into === out[i - 1]) into.pts = into.pts.concat(s.pts.slice(1));
    else { into.pts = s.pts.slice(0, -1).concat(into.pts); into.at = s.at; }
    into.m += s.m; into.sec += s.sec;
    out.splice(i, 1); i--;
  }
  out.forEach(s => { delete s.appr; });
  if (cx.last) {
    let text;
    if (!hops.length) text = `You’re at ${mid(B.label)}`;
    else if (B.kind === 'hub' && (B.key === '@arr' || B.key === '@dep')) text = `You’re at ${mid(B.label)} — check the screens for your gate`;
    else text = cap(side2 ? `${mid(B.label)} ${be(B.label)} on your ${side2}` : `${mid(B.label)} ${be(B.label)} ahead`);
    const sub = B.poi ? [B.poi.near && B.poi.k !== 'gate' && !String(B.poi.note || '').includes(B.poi.near) ? B.poi.near : null, B.poi.hours ? `Open ${B.poi.hours}` : null, B.poi.note].filter(Boolean).join(' · ') : '';
    out.push({kind: 'arrive', icon: 'map-pin', text, sub, m: 0, sec: 0, level: B.level, pts: [[B.lat, B.lon]], at: [B.lat, B.lon]});
  } else if (!cx.quietEnd) {
    const k = B.poi && B.poi.k;
    const text = k === 'baggage' ? `Pick up your bags at ${B.label}` : (k === 'checkin' || k === 'bagdrop') ? `Check your bag at ${B.label}` : `Stop at ${mid(B.label)}`;
    out.push({kind: 'via', icon: k === 'baggage' || k === 'bagdrop' ? 'luggage' : k === 'checkin' ? 'ticket' : 'map-pin', text,
      sub: B.note || '', m: 0, sec: 0, level: B.level, pts: [[B.lat, B.lon]], at: [B.lat, B.lon]});
  }
  cx.sideOut = side;
  return out;
}

// ---------- state ----------
let S = null;
function parse(param) {
  const [code, from, to, via] = String(param || '').split('/');
  return {code: (code || '').trim().toUpperCase(), from: from || null, to: to || null, via: via ? via.split(',').filter(Boolean) : []};
}
function makeState(ctx) {
  const q = parse(ctx.param);
  const g = q.code ? N.guideFor(q.code) : null;
  const P = g && g.nav ? prep(g.nav) : null;
  const st = {code: q.code, guide: g, P, name: P ? (g.short || g.name || P.nav.name) : '',
    from: q.from, to: q.to, via: q.via, sf: !!N.get('nyc.nav.sf', false),
    sel: 0, follow: false, place: null, picker: false, q: '', chip: null, full: false,
    fix: null, gpsHere: null, manual: null, far: false, locating: false, heading: null, compass: false,
    g: {}, mk: new Map(), dead: false, timers: new Set()};
  if (!P) return st;
  recompute(st);
  st.level = st.r && st.r.steps.length ? st.r.steps[0].level : (P.nav.default_level != null ? P.nav.default_level : (P.levels[0] || {}).id);
  return st;
}
function recompute(st) {
  const P = st.P;
  st.fl = flightsAt(st.code);
  const tsa = (N.airportLive(st.code) || {}).tsa;
  st.tsa = tsa && typeof tsa.wait_min === 'number' ? tsa.wait_min : null;
  st.depE = resolve(st, '@dep');
  st.arrE = resolve(st, '@arr');
  st.notes = [];
  if (!st.to) { st.A = st.B = st.r = null; st.V = []; st.err = null; st.dc = null; return; }
  let fromKey = st.from || defaultFrom(st);
  st.A = resolve(st, fromKey);
  if (!st.A && fromKey === '@here') {
    fromKey = defaultFrom(Object.assign({}, st, {manual: null, gpsHere: null}));
    st.A = resolve(st, fromKey);
    if (st.A) st.notes.push(`Showing the way from ${st.A.label} — set your spot for directions from where you are`);
  }
  st.B = resolve(st, st.to);
  st.V = (st.via || []).map(k => resolve(st, k)).filter(Boolean);
  st.wait = waitFor(st);
  st.r = st.A && st.B && !st.wait ? buildRoute(st) : null;
  if (!st.wait) [st.A, ...st.V, st.B].forEach((e, i) => { const n = e && (i === 0 && e.noteFrom || e.note); if (n) st.notes.push(n); });
  if (st.r && st.r.fell) st.notes.push('No step-free way found; this route uses stairs or an escalator.');
  st.notes = [...new Set(st.notes)];
  st.err = !st.A ? (st.from === '@arr' || st.from === '@dep' ? 'No flight of yours uses this airport on this trip.' : 'Couldn’t find where to start. Pick your spot below.')
    : !st.B ? (/^@(arr|dep|bag)$/.test(st.to) ? 'No flight of yours uses this airport on this trip.' : 'Couldn’t find that place on this map.')
    : !st.r && !st.wait ? 'No walking route between these two points in the map data.' : null;
  if (st.sel >= (st.r ? st.r.steps.length : 0)) st.sel = 0;
  st.dc = null;
}
// Both ends fell back to the same stand-in spot (neither gate posted yet): no route to draw,
// so say how far apart gates can be here instead. {text, sec} or null.
function waitFor(st) {
  const A = st.A, B = st.B;
  if (!A || !B || st.V.length || A.node !== B.node || (A.kind !== 'hub' && B.kind !== 'hub')) return null;
  if (B.key === '@bag') return {text: 'This updates when the carousel posts.', sec: 0};
  const d = search(st.P, [B.node], opts(st), null).dist;
  let mx = 0;
  for (const g of st.P.gates) { const x = d.get(g.node); if (x != null && x > mx) mx = x; }
  const m = minN(mx);
  return mx > 0 ? {sec: 2 * mx, text: `Every gate here is within ${m} min of ${B.label}, so allow up to ${2 * m} min between gates. This updates when the gates post.`}
    : {sec: 0, text: 'This updates when the gates post.'};
}
const sig = e => e ? `${e.kind}|${e.node}|${e.label}` : '';
function hashFor(st) {
  const c = st.code.toLowerCase();
  if (!st.to) return `nav/${c}`;
  const from = st.from || defaultFrom(st) || '@here';
  return `nav/${c}/${enc(from)}/${enc(st.to)}${st.via && st.via.length ? '/' + st.via.map(enc).join(',') : ''}`;
}
function syncHash(st) {
  try { history.replaceState(history.state, '', '#' + hashFor(st)); } catch { /* ignore */ }
}
// Travel time in seconds from the origin to every node (cached per origin).
function origin(st) {
  if (st.r && st.A) return st.A;
  const k = defaultFrom(st);
  return k ? resolve(st, k) : null;
}
function distMap(st) {
  const o = origin(st);
  if (!o) return null;
  const key = `${o.node}|${st.sf}|${st.tsa}`;
  if (st.dc && st.dc.key === key) return st.dc;
  const r = search(st.P, [o.node], opts(st), null);
  st.dc = {key, dist: r.dist, from: o};
  return st.dc;
}
function arriveAt(st) {
  const now = N.now().getTime();
  let start = now;
  const L = st.A && st.A.key === '@arr' && st.A.leg;
  // about 10 min from touchdown to walking off the plane
  if (L && L.arr.time) { const t = T(L.arr.time) + 10 * 60000; if (t > start) start = t; }
  return new Date(start + (st.r ? st.r.sec * 1000 : 0));
}
function sumParts(st) {
  const r = st.r;
  const what = r.hasSec ? 'with security' : r.hasTrain ? 'with the train' : 'walking';
  // each part stays on one line, so a wrap only happens between parts
  const keep = t => String(t).replace(/ /g, '\u00a0');
  return {min: `${minN(r.sec)} min`, line: [what, r.walkM >= 15 ? N.distText(r.walkM) : null, `get there ${N.time(arriveAt(st), st.code)}`].filter(Boolean).map(keep).join(' · ')};
}
function fromText(A) {
  if (!A) return 'Set where you start';
  if (A.kind === 'here') return /^near /i.test(A.label) ? `From you, ${A.label.charAt(0).toLowerCase()}${A.label.slice(1)}` : `From you at ${A.label}`;
  return `From ${A.label}`;
}
function boarding(st) {
  const L = st.fl && st.fl.dep;
  if (!st.r || !st.B || !L || !L.board || L.canceled || st.B.side === 'land') return null;
  if (st.B.key === '@bag' || st.B.key === '@arr') return null;
  const now = N.now().getTime(), bt = T(L.board);
  if (isNaN(bt) || bt - now > 18 * 3600000 || bt < now - 30 * 60000) return null;
  let back = 0;
  const dep = st.depE;
  if (dep && st.B.node !== dep.node) {
    const p = pathBetween(st.P, st.B.node, dep.node, opts(st));
    if (p) back = p.sec;
  }
  const spare = Math.floor((bt - arriveAt(st).getTime() - back * 1000) / 60000);
  const t = N.time(L.board, st.code);
  const tone = spare >= 15 ? 'ok' : spare >= 0 ? 'tight' : 'risk';
  let text = spare >= 0 ? `Boarding ${t} · ${spare} min to spare`
    : `Boarding ${t} · ${-spare} min after boarding starts — doors close ${N.time(L.doors, st.code)}`;
  if (back >= 60 && spare >= 0) text += `, counting the ${minN(back)} min walk to ${dep.label}`;
  return {tone, text};
}
function connInfo(st) {
  const a = st.fl && st.fl.arr, b = st.fl && st.fl.dep;
  if ((!st.r && !st.wait) || !a || !b || a.dir !== b.dir || b.seq !== a.seq + 1) return null;
  if (!st.A || st.A.key !== '@arr' || !st.B || st.B.key !== '@dep') return null;
  const walk = minN(st.r ? st.r.sec : st.wait.sec), ground = N.mins(a.arr.time, b.dep.time);
  const free = N.mins(N.addMin(a.arr.time, 10 + walk), b.board);
  // the same scale as boarding(): at the gate 15+ min before boarding is on track
  const spare = free != null ? free : ground != null ? ground - 10 - walk - 40 : null;
  const level = a.canceled || b.canceled ? 'risk' : spare == null ? 'tight' : spare >= 15 ? 'ok' : spare >= 0 ? 'tight' : 'risk';
  const gt = (e, g) => e.kind === 'gate' && e.ref ? e.ref : g || 'gate TBA';
  // gates not posted: the walk is the longest it could be, so the spare time is a floor
  const t = b.board && N.time(b.board, st.code);
  const wait = st.wait && t && free != null ? (free >= 0 ? `Boarding ${t} · at least ${free} min to spare`
    : `Boarding ${t} · if the gates are far apart, you reach it ${-free} min after boarding starts`) : null;
  return {head: `Arrive ${gt(st.A, a.arr.gate)} → Depart ${gt(st.B, b.dep.gate)}`, ground, level, wait};
}
const TONE = {ok: 'On track', tight: 'Tight', risk: 'At risk'};
// the folded card's line: no "counting the walk" or "doors close" tail
const shortLine = t => String(t || '').replace(/, counting .*$/, '').replace(/ — doors close .*$/, '');
// The block under the airport name: your connection, or boarding for the gate you're walking to.
function planInfo(st) {
  if ((!st.r && !st.wait) || st.follow) return null;
  if ((st.B && st.B.key === '@bag') || st.V.some(v => v.key === '@bag')) return bagInfo(st);
  const c = connInfo(st), bd = boarding(st);
  if (!c && !bd) return null;
  const checked = checkedText(st, 'Gates');
  const tone = bd ? bd.tone : c.level;
  const line = bd ? bd.text : c.wait ? c.wait : c.ground != null ? `${c.ground} min between flights` : st.r ? `${minN(st.r.sec)} min walk` : 'Gates not posted yet';
  const foot = [checked, (bd || c && c.wait) && c && c.ground != null ? `${c.ground} min between flights` : null].filter(Boolean).join(' · ');
  return {head: c ? c.head : null, tone, word: TONE[tone], line, foot};
}
// Walking to baggage claim: when the flight lands and which carousel, as last checked.
function bagInfo(st) {
  const L = st.fl && st.fl.arr;
  if (!L || L.canceled || L.diverted) return null;
  const t = L.arr.time ? N.time(L.arr.time, st.code) : null;
  const done = L.landed || L.arr.actual, past = L.arr.time && N.now().getTime() >= T(L.arr.time);
  const word = !t ? 'Bags' : done ? `Landed ${t}` : past ? `Due ${t}` : `Lands ${t}`;
  const line = L.arr.baggage ? `Bags on carousel ${L.arr.baggage}` : 'Carousel not posted yet';
  return {head: null, tone: 'info', word, line, foot: checkedText(st, 'Carousel')};
}
// "Gates checked 4:12p", in this airport's time like every other time on the screen.
function checkedText(st, what) {
  const at = N.fresh().at;
  if (!at) return `${what} not checked yet`;
  // an older check says which day, so 2:52p two days ago never reads as today
  const day = N.ymd(at, st.code) === N.ymd(N.now().toISOString(), st.code) ? '' : `${N.date(at, st.code).split(' ')[0]} `;
  return `${what} checked ${day}${N.time(at, st.code)}`;
}
function farText(st) {
  const m = N.dist(st.fix, {lat: st.P.nav.center[0], lon: st.P.nav.center[1]}), mi = m / 1609.34;
  const d = mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi).toLocaleString('en-US')} mi`;
  return `You’re ${d} from ${st.name}. The blue dot shows up when you get there.`;
}

// ---------- HTML ----------
const catOf = e => e && e.poi ? kd(e.poi.k)[1] : e && e.kind === 'here' ? 'me' : 'gate';
const icOf = e => e && e.poi ? kd(e.poi.k)[0] : e && e.kind === 'here' ? 'current-location' : 'map-pin';
function whereRow(st) {
  let ic = 'current-location', t, btn = 'I’m at…';
  if (st.locating) { ic = 'gps'; t = 'Finding you…'; }
  else if (st.manual) { ic = 'map-pin'; t = `You’re at ${st.manual.label}`; btn = 'Change'; }
  else if (st.fix && st.far) t = farText(st);
  else if (st.fix && st.gpsHere) t = `${st.gpsHere.label} · GPS ±${st.fix.acc} m`;
  else if (st.fix) t = `GPS ±${st.fix.acc} m is rough indoors. Pick your gate to be exact.`;
  else t = 'Find yourself with GPS, or pick your gate or a landmark.';
  return h`<div class="na-wr">${icon(ic)}<span class="na-wt" data-k="where">${t}</span><button class="na-pill" data-act="pick">${btn}</button></div>`;
}
function topHtml(st) {
  if (st.follow && st.r) {
    const s = st.r.steps[st.sel], n = st.r.steps.length;
    return h`<div class="na-fb" aria-live="polite">
      <span class="na-fbi">${icon(s.icon)}</span>
      <div class="na-fbt"><b>${s.text}</b>${s.sub ? h`<small>${s.sub}</small>` : ''}<span class="na-fbm">${metaOf(st, s)}</span></div>
    </div>
    <div class="na-fbn">
      <button class="na-ib" data-act="prev" aria-label="Previous step"${st.sel === 0 ? N.raw(' disabled') : ''}>${icon('chevron-left')}</button>
      <span class="na-fbc">Step ${st.sel + 1} of ${n}</span>
      <button class="na-ib" data-act="next" aria-label="Next step"${st.sel >= n - 1 ? N.raw(' disabled') : ''}>${icon('chevron-right')}</button>
    </div>`;
  }
  const pl = planInfo(st);
  // with a route on screen the card folds to one line so the map has the room; tap it for the rest
  if (st.to && pl && !st.topOpen) {
    return h`<button class="na-tc" data-act="topx" aria-expanded="false">
      <b>${st.code}</b><i class="na-tone ${pl.tone}" data-k="tone">${pl.word}</i><span data-k="boards">${shortLine(pl.line)}</span>${icon('chevron-down')}
    </button>${st.locating ? whereRow(st) : ''}`;
  }
  const showWhere = !st.to || st.fix || st.manual || st.locating;
  return h`${st.to && pl ? h`<button class="na-ey na-eyb" data-act="topx" aria-expanded="true" aria-label="${`${st.code} ${st.name}, hide flight details`}"><b>${st.code}</b><span>${st.name}</span>${icon('chevron-up')}</button>`
      : h`<div class="na-ey"><b>${st.code}</b><span>${st.name}</span></div>`}
    ${pl ? h`<div class="na-cn">
      ${pl.head ? h`<span class="na-cnt" data-k="conn">${pl.head}</span>` : ''}
      <span class="na-cnb"><i class="na-tone ${pl.tone}" data-k="tone">${pl.word}</i><span data-k="board">${pl.line}</span></span>
      <span class="na-cnw" data-k="foot">${pl.foot}</span>
    </div>` : ''}
    ${showWhere ? whereRow(st) : ''}`;
}
function floorsHtml(st) {
  if (st.P.levels.length < 2) return '';
  const rl = st.r ? st.r.levels : new Set();
  return h`${st.P.levels.slice().reverse().map(l => h`<button class="na-lv${l.id === st.level ? ' on' : ''}${rl.has(l.id) ? ' rt' : ''}" data-act="lvl" data-arg="${l.id}" aria-pressed="${String(l.id === st.level)}" aria-label="${`Level ${l.short || l.id}: ${strip(String(l.name || '').replace(/^Level\s*\w+\s*[:·–-]\s*/i, ''))}`}">${l.short || l.id}</button>`)}`;
}
function ctlHtml(st) {
  return h`${st.r ? h`<button class="na-fab" data-act="fit" aria-label="Show the whole route">${icon('map')}</button>` : ''}
    <button class="na-fab${st.compass ? ' on' : ''}" data-act="compass" aria-label="Compass" aria-pressed="${String(!!st.compass)}">${icon('compass')}</button>
    <button class="na-fab${st.fix || st.manual ? ' on' : ''}" data-act="locate" aria-label="Find me">${icon(st.locating ? 'gps' : 'current-location')}</button>`;
}
function metaOf(st, s) {
  const lv = st.P.levels.length > 1 ? ` · ${lvShort(st.P, s.level)}` : '';
  if (s.kind === 'arrive' || s.kind === 'via') return lvShort(st.P, s.level);
  if (s.kind === 'vert') return s.toLevel === s.level ? minT(s.sec) : `${minT(s.sec)} · ${lvShort(st.P, s.level)} to ${(lvObj(st.P, s.toLevel) || {}).short || s.toLevel}`;
  if (s.kind === 'security') return `allow ${minT(s.sec)}`;
  if (s.kind === 'train') return `${minT(s.sec)} with the wait`;
  return `${N.distText(s.m)} · ${minT(s.sec)}${lv}`;
}
function cardHtml(st, s, i) {
  return h`<button class="na-card${i === st.sel ? ' on' : ''}" data-act="step" data-arg="${i}" role="listitem" aria-current="${i === st.sel ? 'step' : 'false'}">
    <span class="na-ci k-${s.kind}">${icon(s.icon)}</span>
    <span class="na-cb">
      <span class="na-ct">${s.text}</span>
      ${s.sub ? h`<span class="na-cs">${s.sub}</span>` : ''}
      <span class="na-cm">${`${i + 1}/${st.r.steps.length} · ${metaOf(st, s)}`}</span>
    </span>
  </button>`;
}
function routeHtml(st) {
  const A = st.A, B = st.B, r = st.r;
  const head = h`<div class="na-rh">
    <span class="na-ri c-${catOf(B)}">${icon(icOf(B))}</span>
    <div class="na-rt"><span class="na-to">${st.wait && B.kind === 'hub' ? (B.key === '@bag' ? 'Carousel not posted yet' : 'Gate not posted yet') : B ? B.label : st.to}</span><button class="na-from" data-act="pick" aria-label="${`${fromText(A)}. Change where you start`}"><span>${st.wait && A.kind === 'hub' ? 'Arrival gate not posted yet either' : fromText(A)}${st.V.length ? ` · via ${st.V.map(v => v.label).join(', ')}` : ''}</span>${icon('chevron-down')}</button></div>
    ${A && B ? h`<button class="na-ib" data-act="swap" aria-label="Swap start and end">${icon('arrows-exchange')}</button>` : ''}
    <button class="na-ib" data-act="close" aria-label="Close directions">${icon('x')}</button>
  </div>`;
  if (!r && st.wait) {
    return h`${head}<div class="co na-note">${icon('clock')}<span>${st.wait.text}</span></div>
      <div class="na-acts"><button class="btn alt" data-act="close">Back to the map</button></div>`;
  }
  if (!r) {
    return h`${head}<div class="co rose na-note">${icon('alert-triangle')}<span>${st.err}</span></div>
      <div class="na-acts"><button class="btn alt" data-act="pick">${icon('map-pin')}Set my spot</button><button class="btn alt" data-act="close">Back to the map</button></div>`;
  }
  const dest = B.lat != null ? {lat: B.lat, lon: B.lon} : null;
  const sm = sumParts(st);
  return h`${head}
    <div class="na-sr">
      <p class="na-sm" data-k="sum"><b>${sm.min}</b><span>${sm.line}</span></p>
      <button class="btn na-go" data-act="start">${icon('player-play')}Start</button>
    </div>
    <div class="na-cards" data-hscroll role="list" aria-label="Steps">${r.steps.map((s, i) => cardHtml(st, s, i))}</div>
    ${st.notes.map(n => h`<div class="co na-note">${icon('alert-circle')}<span>${n}</span></div>`)}
    <div class="na-acts">
      <button class="na-tg" data-act="sf" aria-pressed="${String(!!st.sf)}">${icon('accessible')}Step-free</button>
      ${dest ? h`<a class="na-tg" href="${N.mapsUrl(dest, 'w')}" target="_blank" rel="noopener">${icon('external-link')}Apple Maps</a>` : ''}
    </div>
    <h3 class="na-h">All steps</h3>
    <ol class="na-list">${r.steps.map((s, i) => h`<li><button class="na-li${i === st.sel ? ' on' : ''}" data-act="step" data-arg="${i}">
      <span class="na-ci k-${s.kind}">${icon(s.icon)}</span>
      <span class="na-lt"><b>${s.text}</b>${s.sub ? h`<small>${s.sub}</small>` : ''}<em>${metaOf(st, s)}</em></span></button></li>`)}</ol>
    <p class="na-cr">${st.P.nav.source && st.P.nav.source.text || 'Map data © OpenStreetMap contributors (ODbL)'}</p>`;
}
// Where a place is, in words: the data's own note, else the closest gate on its floor.
function nearOf(P, p) {
  if (p.near) return p.near;
  if (p.k === 'gate') return null;
  const c = P.nearC || (P.nearC = new Map());
  if (c.has(p.id)) return c.get(p.id);
  let best = null, bd = 80;
  for (const g of P.gatesL.get(p.level) || []) { const d = N.dist(p, g); if (d < bd) { bd = d; best = g; } }
  const t = best ? `Near ${best.ref}` : null;
  c.set(p.id, t);
  return t;
}
// the kind ("Restroom") unless the name already says it ("Restrooms")
const kindOf = (name, kl) => String(name).toLowerCase().includes(String(kl).toLowerCase()) ? null : kl;
function rowHtml(st, p, dm, sub) {
  const [ic, cat, kl] = kd(p.k);
  const d = dm && dm.dist.get(p.node);
  const name = p.k === 'gate' ? `Gate ${p.ref}` : strip(p.name) || kl;
  const bits = sub != null ? [sub] : [p.k === 'gate' ? (p.concourse ? `Concourse ${p.concourse}` : kl) : kindOf(name, kl), nearOf(st.P, p), st.P.levels.length > 1 ? lvShort(st.P, p.level) : null, p.hours];
  return h`<button class="na-row" data-act="to" data-arg="${p.id}">
    <span class="na-ri c-${cat}">${icon(ic)}</span>
    <span class="na-rtx"><b>${name}</b><small>${bits.filter(Boolean).join(' · ')}</small></span>
    ${d != null ? h`<span class="na-min">${minN(d)}<small>min</small></span>` : h`<span class="na-min na-nr">—</span>`}
  </button>`;
}
function resultsHtml(st) {
  const P = st.P, dm = distMap(st), from = dm && dm.from;
  const by = (a, b) => (dm ? (dm.dist.get(a.node) ?? Infinity) - (dm.dist.get(b.node) ?? Infinity) : 0) || nat(a.name, b.name);
  if (st.chip) {
    const q = QUICK.find(x => x[0] === st.chip);
    const list = P.pois.filter(q[3]).sort(by).slice(0, 12);
    return h`<h3 class="na-h">${q[1]}${from ? ` nearest ${from.label}` : ''}</h3>${list.length ? list.map(p => rowHtml(st, p, dm)) : h`<p class="na-empty">None on this map.</p>`}`;
  }
  const q = st.q.trim().toLowerCase();
  if (q) {
    const words = q.split(/\s+/);
    const hay = p => `${p.name || ''} ${p.ref || ''} ${kd(p.k)[2]} ${p.near || ''} ${p.concourse ? 'concourse ' + p.concourse : ''} ${p.k === 'gate' ? 'gate ' + p.ref : ''}`.toLowerCase();
    const list = P.pois.filter(p => { const s = hay(p); return words.every(w => s.includes(w)); }).sort(by).slice(0, 25);
    return h`<h3 class="na-h">${list.length ? `${N.plural(list.length, 'match', 'matches')}${from ? `, nearest ${from.label} first` : ''}` : 'No matches'}</h3>${list.map(p => rowHtml(st, p, dm))}`;
  }
  // presets for your flights, then the nearest basics, then tips
  const pre = presets(st);
  const near = [];
  if (dm) for (const ks of NEARBY) {
    let best = null, bd = Infinity;
    for (const p of P.pois) if (ks.includes(p.k)) { const d = dm.dist.get(p.node); if (d != null && d < bd) { bd = d; best = p; } }
    if (best) near.push({p: best, d: bd});
  }
  near.sort((a, b) => a.d - b.d);
  const tips = (P.nav.tips || []).slice(0, 3);
  return h`${pre.length ? h`<h3 class="na-h">Your routes here</h3>${pre.map(x => h`<button class="na-row" data-act="preset" data-arg="${x.id}">
      <span class="na-ri c-${catOf(x.B)}">${icon(icOf(x.B))}</span>
      <span class="na-rtx"><b>${x.label}</b><small>${x.sub || `${x.A.label} → ${x.B.label}`}</small></span>
      ${x.min != null ? h`<span class="na-min">${x.min}<small>min</small></span>` : ''}</button>`)}` : ''}
    ${near.length ? h`<h3 class="na-h">Nearest ${from.label}</h3>${near.map(x => rowHtml(st, x.p, dm))}` : ''}
    ${tips.length ? h`<h3 class="na-h">Good to know</h3><ul class="na-tips">${tips.map(t => h`<li>${t}</li>`)}</ul>` : ''}
    <p class="na-cr">${P.nav.source && P.nav.source.text || 'Map data © OpenStreetMap contributors (ODbL)'}</p>`;
}
// a preset whose end is a stand-in (gate or carousel not known yet) says so instead of naming the stand-in as if it were the place
function hubSub(A, B, same) {
  const what = e => e.key === '@bag' ? 'Carousel' : 'Gate';
  const got = e => e.leg ? (e.key === '@bag' ? e.leg.arr.baggage : e.key === '@arr' ? e.leg.arr.gate : e.leg.dep.gate) : null;
  const why = e => got(e) ? `${what(e)} ${got(e)} isn’t on this map` : `${what(e)} not posted yet`;
  const ha = A.kind === 'hub', hb = B.kind === 'hub';
  if (same) return ha && hb ? (got(A) && got(B) ? 'Neither gate is on this map' : 'Gates not posted yet') : why(ha ? A : B);
  if (ha && hb) return `${!got(A) && !got(B) && what(A) !== what(B) ? `${what(A)} and ${what(B).toLowerCase()} not posted yet` : 'Not posted yet'} · ${A.label} → ${B.label}`;
  if (ha) return `${why(A)} · from ${A.label}`;
  if (hb) return `${why(B)} · to ${B.label}`;
  return null;
}
// "From the atrium · no arrival gate yet" (kept short enough for one line)
function standSub(A) {
  const g = A.leg ? (A.key === '@arr' ? A.leg.arr.gate : A.leg.dep.gate) : null;
  return `From ${mid(A.label)} · ${g ? `gate ${g} not on map` : `no ${A.key === '@arr' ? 'arrival ' : ''}gate yet`}`;
}
function presets(st) {
  const fl = st.fl, out = [];
  const a = fl.strictA || (!fl.dir ? fl.arr : null), d = fl.strictD || (!fl.dir ? fl.dep : null);
  const conn = a && d && a.dir === d.dir && d.seq === a.seq + 1;
  for (const pr of st.P.nav.presets || []) {
    if (pr.when === 'connect' && !conn) continue;
    if (pr.when === 'depart' && !(d && !a)) continue;
    if (pr.when === 'arrive' && !(a && !d)) continue;
    const ends = [pr.from, ...(pr.via || []), pr.to].map(k => resolve(st, k));
    if (ends.some(e => !e)) continue;
    let sec = 0, ok = true;
    for (let i = 0; i < ends.length - 1 && ok; i++) {
      const p = pathBetween(st.P, ends[i].node, ends[i + 1].node, opts(st)) || pathBetween(st.P, ends[i].node, ends[i + 1].node, Object.assign(opts(st), {sf: false}));
      if (!p) ok = false; else sec += p.sec;
    }
    if (!ok) continue;
    const A = ends[0], B = ends[ends.length - 1], wait = A.node === B.node && (A.kind === 'hub' || B.kind === 'hub');
    // the start is a stand-in for a gate not posted yet: name where it goes and where it starts, not the gate
    const stand = A.kind === 'hub' && B.kind !== 'hub' && !wait;
    out.push({id: pr.id, label: stand ? `To ${mid(B.label)}` : pr.label, A, B, min: wait ? null : minN(sec),
      sub: stand ? standSub(A) : hubSub(A, B, wait)});
    if (out.length >= 4) break;
  }
  return out;
}
function overviewHtml(st) {
  const chips = QUICK.filter(q => st.P.pois.some(q[3]));
  // search and chips stay pinned at the top of the sheet while the results scroll under them
  return h`<div class="na-qh"><label class="na-q">${icon('search')}<input type="search" data-input="q" value="${st.q}" placeholder="Search gates, food, restrooms…" enterkeyhint="search" autocomplete="off" aria-label="Search this airport">${st.q ? h`<button class="na-qx" data-act="clearq" aria-label="Clear search">${icon('x')}</button>` : ''}</label>
    <div class="na-chips" data-hscroll>${chips.map(q => h`<button class="na-chip${st.chip === q[0] ? ' on' : ''}" data-act="chip" data-arg="${q[0]}" aria-pressed="${String(st.chip === q[0])}">${icon(q[2])}${q[1]}</button>`)}</div></div>
    <div class="na-res">${resultsHtml(st)}</div>`;
}
function placeHtml(st) {
  const p = st.place, [ic, cat, kl] = kd(p.k);
  const dm = distMap(st), d = dm && dm.dist.get(p.node);
  const name = p.k === 'gate' ? `Gate ${p.ref}` : strip(p.name) || kl;
  const sub = [p.k === 'gate' ? (p.concourse ? `Concourse ${p.concourse}` : p.terminal ? `Terminal ${p.terminal}` : kl) : kindOf(name, kl),
    st.P.levels.length > 1 ? lvShort(st.P, p.level) : null, p.side === 'land' ? 'before security' : p.side === 'air' ? 'after security' : null].filter(Boolean).join(' · ');
  return h`<div class="na-rh">
      <span class="na-ri c-${cat}">${icon(ic)}</span>
      <div class="na-rt"><span class="na-to">${name}</span><span class="na-from">${sub}</span></div>
      <button class="na-ib" data-act="unplace" aria-label="Close">${icon('x')}</button>
    </div>
    ${nearOf(st.P, p) ? h`<p class="na-pn">${icon('map-pin')}<span>${nearOf(st.P, p)}</span></p>` : ''}
    ${p.hours ? h`<p class="na-pn">${icon('clock')}<span>Open ${p.hours}</span></p>` : ''}
    ${p.note ? h`<p class="na-pn">${icon('info-circle')}<span>${p.note}</span></p>` : ''}
    <div class="na-acts">
      <button class="btn na-go" data-act="to" data-arg="${p.id}">${icon('navigation')}${d != null && dm.from.node !== p.node ? `Directions · ${minN(d)} min` : 'Directions'}</button>
      <button class="na-tg" data-act="here" data-arg="${p.id}">${icon('map-pin')}I’m here</button>
    </div>`;
}
function followSheet(st) {
  const r = st.r, left = r.steps.slice(st.sel).reduce((a, s) => a + s.sec, 0);
  return h`<div class="na-fs">
    <div class="na-fsx"><b>To ${st.B.label}</b><span data-k="fleft">${minN(left)} min to go · ${N.distText(r.steps.slice(st.sel).reduce((a, s) => a + s.m, 0))}</span></div>
    <button class="btn alt" data-act="end">${icon('player-stop')}End</button>
  </div>`;
}
const sheetMode = st => st.place || st.follow ? ' auto' : st.to ? ' rt' : '';
function sheetHtml(st) {
  if (st.follow && st.r) return followSheet(st);
  if (st.place) return placeHtml(st);
  if (st.to) return routeHtml(st);
  return overviewHtml(st);
}
function pickerHtml(st) {
  return h`<div class="na-pkh"><h2>Where are you?</h2><button class="na-ib" data-act="pickx" aria-label="Close">${icon('x')}</button></div>
    <label class="na-q">${icon('search')}<input type="search" data-input="pq" placeholder="Gate, restaurant, carousel…" autocomplete="off" aria-label="Find your spot"></label>
    <div class="na-pkr">${pickerList(st, '')}</div>`;
}
function pickerList(st, q) {
  const P = st.P;
  q = q.trim().toLowerCase();
  const row = (key, ic, cat, name, sub) => h`<button class="na-row" data-act="here" data-arg="${key}"><span class="na-ri c-${cat}">${icon(ic)}</span><span class="na-rtx"><b>${name}</b>${sub ? h`<small>${sub}</small>` : ''}</span></button>`;
  if (q) {
    const list = P.pois.filter(p => `${p.name} ${p.ref || ''} ${p.near || ''} ${p.k === 'gate' ? 'gate ' + p.ref : ''}`.toLowerCase().includes(q))
      .sort((a, b) => (a.k === 'gate' ? 0 : 1) - (b.k === 'gate' ? 0 : 1) || nat(a.ref || a.name, b.ref || b.name)).slice(0, 30);
    return list.length ? list.map(p => {
      const nm = p.k === 'gate' ? `Gate ${p.ref}` : strip(p.name) || kd(p.k)[2];
      return row(p.id, kd(p.k)[0], kd(p.k)[1], nm, [p.k === 'gate' ? null : kindOf(nm, kd(p.k)[2]), nearOf(P, p), P.levels.length > 1 ? lvShort(P, p.level) : null].filter(Boolean).join(' · '));
    })
      : h`<p class="na-empty">No matches. Try a gate number or a shop name.</p>`;
  }
  const mine = [];
  if (st.arrE && st.arrE.kind === 'gate') mine.push(row('@arr', 'plane', 'gate', `${st.arrE.label}`, 'Where your flight lands'));
  if (st.depE && st.depE.kind === 'gate') mine.push(row('@dep', 'plane-departure', 'gate', `${st.depE.label}`, 'Where your next flight leaves'));
  // Things people say "I'm by the…" about come first; carousels are many and look alike.
  const RK = {landmark: 0, checkpoint: 1, precheck: 1, train: 2, subway: 2, info: 3, baggage: 5}, rank = p => p.k in RK ? RK[p.k] : 4;
  const lms = P.pois.filter(p => kd(p.k)[3] === 1 && p.k !== 'gate').sort((a, b) => rank(a) - rank(b) || kd(a.k)[1].localeCompare(kd(b.k)[1]) || nat(a.name, b.name)).slice(0, 10);
  const groups = new Map();
  for (const g of P.gates.slice().sort((a, b) => nat(a.ref, b.ref))) {
    const k = g.concourse ? `Concourse ${g.concourse}` : g.terminal ? `Terminal ${g.terminal}` : 'Gates';
    (groups.get(k) || groups.set(k, []).get(k)).push(g);
  }
  return h`<button class="na-row" data-act="gps"><span class="na-ri c-me">${icon('current-location')}</span><span class="na-rtx"><b>Use GPS</b><small>Works best near windows and outside</small></span></button>
    ${mine.length ? h`<h3 class="na-h">Your flights</h3>${mine}` : ''}
    <h3 class="na-h">Landmarks</h3>${lms.map(p => { const nm = strip(p.name); return row(p.id, kd(p.k)[0], kd(p.k)[1], nm, [p.k === 'landmark' ? null : kindOf(nm, kd(p.k)[2]), nearOf(P, p), P.levels.length > 1 ? lvShort(P, p.level) : null].filter(Boolean).join(' · ')); })}
    ${[...groups].map(([k, gs]) => h`<h3 class="na-h">${k}</h3><div class="na-gg">${gs.map(g => h`<button class="na-gb" data-act="here" data-arg="${g.id}" aria-label="${`Gate ${g.ref}`}">${g.ref}</button>`)}</div>`)}`;
}
function emptyHtml(st) {
  const ap = N.data.guide && N.data.guide.airports || {};
  const have = Object.keys(ap).filter(c => ap[c] && ap[c].nav);
  return h`<div class="na na-none"><div class="na-nobox">
    <h1 class="na-noh">${st.code ? `No walking map for ${st.code} yet` : 'Walking maps'}</h1>
    <p class="na-nop">${have.length ? 'Pick an airport to see its gates, security, baggage claim and the way between them.' : 'Airport maps arrive with the next data update.'}</p>
    ${have.map(c => h`<button class="na-row" data-act="go" data-arg="${`nav/${c.toLowerCase()}`}"><span class="na-ri c-gate">${icon('building-airport')}</span><span class="na-rtx"><b>${c}</b><small>${ap[c].short || ap[c].name || ''}</small></span>${icon('chevron-right')}</button>`)}
    <button class="btn alt na-nob" data-act="go" data-arg="airports">${icon('arrow-left')}Airports</button>
  </div></div>`;
}
function shellHtml(st) {
  return h`<div class="na" data-code="${st.code}">
    <div class="na-map" role="region" aria-label="${`Walking map of ${st.name}`}"></div>
    <div class="na-top">${topHtml(st)}</div>
    <div class="na-rail"><div class="na-fl">${floorsHtml(st)}</div><div class="na-ctl">${ctlHtml(st)}</div></div>
    <section class="na-sh${sheetMode(st)}" aria-label="Directions">
      <button class="na-grab" data-act="grab" aria-label="Show more" aria-expanded="false"><i></i></button>
      <div class="na-shc">${sheetHtml(st)}</div>
    </section>
    <div class="na-pk" hidden></div>
  </div>`;
}

// ---------- painting ----------
const $ = (st, s) => st.root ? N.$(s, st.root) : null;
function paintTop(st) { const e = $(st, '.na-top'); if (e) e.innerHTML = topHtml(st); }
function paintFloors(st) { const e = $(st, '.na-fl'); if (e) e.innerHTML = floorsHtml(st); }
function paintCtl(st) { const e = $(st, '.na-ctl'); if (e) e.innerHTML = ctlHtml(st); }
function paintSheet(st) {
  const sh = $(st, '.na-sh'), c = $(st, '.na-shc');
  if (!sh || !c) return;
  const inp = N.$('input[data-input="q"]', c);
  if (inp && D.activeElement === inp && !st.to && !st.place && !st.follow) { paintResults(st); return; }
  c.innerHTML = sheetHtml(st);
  sh.classList.toggle('auto', !!(st.place || st.follow));
  sh.classList.toggle('rt', !!(st.to && !st.place && !st.follow));
  c.scrollTop = 0;
  if (st.r && !st.follow && !st.place) requestAnimationFrame(() => scrollCards(st, st.sel, false));
}
function paintResults(st) { const e = $(st, '.na-res'); if (e) e.innerHTML = resultsHtml(st); }
function paintAll(st) { paintTop(st); paintFloors(st); paintCtl(st); paintSheet(st); }
const D = document;
function flashChanged(st, old) {
  N.$$('[data-k]', st.root).forEach(e => {
    const o = old.get(e.dataset.k);
    if (o != null && o !== e.textContent) { e.classList.remove('chg'); void e.offsetWidth; e.classList.add('chg'); }
  });
}
function scrollCards(st, i, smooth) {
  const sc = $(st, '.na-cards');
  if (!sc || !sc.children[i]) return;
  st.progScroll = true;
  sc.scrollTo({left: sc.children[i].offsetLeft - sc.children[0].offsetLeft, behavior: smooth && !N.reduce ? 'smooth' : 'auto'});
  clearTimeout(st.psT);
  st.psT = setTimeout(() => { st.progScroll = false; }, smooth ? 500 : 80);
}
function markSel(st) {
  N.$$('.na-card', st.root).forEach((c, i) => { c.classList.toggle('on', i === st.sel); c.setAttribute('aria-current', i === st.sel ? 'step' : 'false'); });
  N.$$('.na-li', st.root).forEach((c, i) => c.classList.toggle('on', i === st.sel));
}
function selectStep(st, i, o = {}) {
  if (!st.r || !st.r.steps[i]) return;
  st.sel = i;
  const s = st.r.steps[i];
  if (s.level !== st.level) setLevel(st, s.level, true);
  markSel(st);
  if (o.scroll) scrollCards(st, i, true);
  if (st.follow) { paintTop(st); paintSheet(st); }
  drawHl(st);
  if (o.fly !== false) flyStep(st, s);
}
function setLevel(st, lv, quiet) {
  if (lv == null || lv === st.level && quiet) return;
  st.level = lv;
  paintFloors(st);
  if (st.map) { drawBase(st); drawGates(st); drawRoute(st); drawHl(st); drawPins(st); drawMe(st); placeMarkers(st); }
}

// ---------- map ----------
function colors(el) {
  const cs = getComputedStyle(el), g = n => cs.getPropertyValue('--na-' + n).trim();
  const out = {};
  ['bg', 'bld', 'air', 'land', 'atr', 'bag', 'sec', 'gar', 'curb', 'lng', 'walkw', 'plat', 'apron', 'edge', 'corr', 'gate', 'gatec',
    'route', 'routec', 'flow', 'hl', 'me', 'line', 'train', 'road'].forEach(k => { out[k] = g(k); });
  return out;
}
const corrW = z => Math.max(2, Math.min(24, 3.2 * Math.pow(2, z - 17)));
const gateR = z => z >= 19 ? 6.5 : z >= 18 ? 5 : 3.5;
// The clear part of the map: 16px under the top card, 16px over the sheet, 24px in from the left,
// and clear of the button rail on the right.
function pad(st) {
  const top = $(st, '.na-top'), sh = $(st, '.na-sh'), rail = $(st, '.na-rail'), box = $(st, '.na-map');
  const tb = top ? top.offsetTop + top.offsetHeight : 0, sb = sh ? sh.offsetHeight : 0;
  const rl = rail && box && rail.offsetWidth ? box.offsetWidth - rail.offsetLeft + 8 : 24;
  return {paddingTopLeft: [24, tb + 16], paddingBottomRight: [Math.max(24, rl), sb + 16]};
}
// Put ll in the middle of the part of the map you can see (between the top card, the sheet and the buttons).
function centerOn(st, ll, z, how) {
  const m = st.map, o = pad(st);
  const c = m.unproject(m.project(ll, z).add([(o.paddingBottomRight[0] - o.paddingTopLeft[0]) / 2, (o.paddingBottomRight[1] - o.paddingTopLeft[1]) / 2]), z);
  if (how === 'pan') { m.panTo(c, {animate: !N.reduce}); return; }
  if (!how || N.reduce) m.setView(c, z, {animate: false}); else m.flyTo(c, z, {duration: .6});
}
function initMap(st, L) {
  const P = st.P, box = $(st, '.na-map');
  if (!box) return;
  const map = L.map(box, {zoomControl: false, scrollWheelZoom: false, boxZoom: false, keyboard: false, inertia: true,
    zoomSnap: .25, zoomDelta: .5, fadeAnimation: false, attributionControl: false, minZoom: 13, maxZoom: 21});
  st.L = L; st.map = map;
  const pane = (n, z) => { const p = map.createPane(n); p.style.zIndex = z; p.style.pointerEvents = 'none'; };
  pane('naArea', 250); pane('naGate', 380); pane('naRoute', 420); pane('naMk', 600); pane('naPin', 640); pane('naMe', 650);
  st.cv = L.canvas({pane: 'naArea', padding: .5});
  st.cvG = L.canvas({pane: 'naGate', padding: .5});
  st.sv = L.svg({pane: 'naRoute', padding: .5});
  const [s, w, n, e] = P.nav.bbox;
  // Room to pan any corner of the airport clear of the top card and the sheet. The limit has to be at least
  // half a screen past the airport at the widest zoom, or Leaflet pins the view to the airport's middle.
  const cos = Math.cos((s + n) / 2 * Math.PI / 180), mpp = 156543.03 * cos / Math.pow(2, map.getMinZoom()), sz = map.getSize();
  const py = Math.max(.006, (n - s) * .6, sz.y * mpp / 111320 / 2), px = Math.max(.008, (e - w) * .3, sz.x * mpp / (111320 * cos) / 2);
  map.setMaxBounds(L.latLngBounds([s - py, w - px], [n + py, e + px]));
  L.control.attribution({position: 'bottomleft', prefix: false})
    .addAttribution('<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>').addTo(map);
  const t = N.tiles(N.isDark());
  if (tilesOk(t)) L.tileLayer(t.url, Object.assign({}, t.opts, {maxNativeZoom: 19, maxZoom: 21, className: 'na-tiles'})).addTo(map);
  st.c = colors(st.root);
  initialView(st);
  drawAll(st);
  map.on('zoomend', () => onZoom(st));
  map.on('moveend', () => schedulePlace(st));
  map.on('click', ev => onMapTap(st, ev));
  map.on('dragstart', () => { st.userMoved = true; });
  later(st, () => prefetchTiles(st), 2500);
}
function later(st, fn, ms) {
  const t = setTimeout(() => { st.timers.delete(t); if (!st.dead) { try { fn(); } catch (e) { N.report(e, 'nav'); } } }, ms);
  st.timers.add(t);
  return t;
}
function initialView(st) {
  const L = st.L, map = st.map;
  if (st.r) { fitRoute(st, false); return; }
  const here = st.manual || st.gpsHere;
  if (here) { const nd = st.P.nodes.get(here.node); centerOn(st, [nd.lat, nd.lon], 18.5); return; }
  // your flights' gates if there are any, otherwise every gate on this floor
  let pts = [st.arrE, st.depE].filter(e => e && e.lat != null).map(e => [e.lat, e.lon]);
  if (!pts.length) pts = (st.P.gatesL.get(st.level) || st.P.gates).map(p => [p.lat, p.lon]);
  if (!pts.length) pts = [[st.P.nav.bbox[0], st.P.nav.bbox[1]], [st.P.nav.bbox[2], st.P.nav.bbox[3]]];
  const b = L.latLngBounds(pts);
  if (pts.length > 1 && b.getNorthEast().distanceTo(b.getSouthWest()) > 30) map.fitBounds(b, Object.assign(pad(st), {animate: false, maxZoom: 18}));
  else centerOn(st, b.getCenter(), 17.5);
  if (map.getZoom() < 16) centerOn(st, b.getCenter(), 16);
}
function fitRoute(st, animate) {
  if (!st.map || !st.r) return;
  const pts = [];
  st.r.hops.forEach(x => { const a = st.P.nodes.get(x.from), b = st.P.nodes.get(x.to); pts.push([a.lat, a.lon], [b.lat, b.lon]); });
  if (!pts.length) pts.push([st.B.lat, st.B.lon]);
  if (st.A && st.A.kind === 'here' && st.fix && !st.far && !st.manual) pts.push([st.fix.lat, st.fix.lon]);
  const b = st.L.latLngBounds(pts);
  const o = Object.assign(pad(st), {maxZoom: 19});
  // floor-change chips sit 40px above their point; keep the top one clear of the card
  if (st.r.levels && st.r.levels.size > 1) o.paddingTopLeft[1] += 36;
  if (animate && !N.reduce) st.map.flyToBounds(b, Object.assign(o, {duration: .6})); else st.map.fitBounds(b, Object.assign(o, {animate: false}));
}
function flyStep(st, s) {
  if (!st.map) return;
  const o = pad(st);
  const b = st.L.latLngBounds(s.pts.length > 1 ? s.pts : [s.at, s.at]);
  const big = s.pts.length > 1 && b.getNorthEast().distanceTo(b.getSouthWest()) > 25;
  if (big) {
    if (N.reduce) st.map.fitBounds(b, Object.assign(o, {maxZoom: 19.5, animate: false}));
    else st.map.flyToBounds(b, Object.assign(o, {maxZoom: 19.5, duration: .55}));
  } else {
    centerOn(st, s.at, Math.max(st.map.getZoom(), 19), 'fly');
  }
}
function drawAll(st) {
  if (!st.map) return;
  st.c = colors(st.root);
  drawBase(st); drawGates(st); drawRoute(st); drawHl(st); drawPins(st); drawMe(st);
  for (const m of st.mk.values()) m.remove();
  st.mk.clear();
  placeMarkers(st);
}
function drawBase(st) {
  const {L, map, P, c} = st, lv = st.level;
  if (st.g.base) st.g.base.remove();
  const g = st.g.base = L.layerGroup().addTo(map);
  const ord = a => { const i = AREA_O.indexOf(a.k); return i < 0 ? 99 : i; };
  const areas = (P.nav.areas || []).filter(a => a.geom && a.geom.length && a.geom[0].length > 2);
  const fill = a => c[AREA_C[a.k] || 'bld'] || c.bld;
  for (const a of areas) if (a.level !== lv) L.polygon(a.geom, {renderer: st.cv, interactive: false, stroke: false, fill: true, fillColor: fill(a), fillOpacity: .32}).addTo(g);
  for (const a of areas.filter(x => x.level === lv).sort((x, y) => ord(x) - ord(y))) {
    L.polygon(a.geom, {renderer: st.cv, interactive: false, stroke: true, color: c.edge, weight: 1, fill: true, fillColor: fill(a), fillOpacity: 1}).addTo(g);
  }
  const segs = P.corr.get(lv) || [];
  st.corr = segs.length ? L.polyline(segs, {renderer: st.cv, interactive: false, color: c.corr, weight: corrW(map.getZoom()), opacity: 1, lineCap: 'round', lineJoin: 'round'}).addTo(g) : null;
  st.lines = [];
  for (const l of P.nav.lines || []) {
    if (l.level !== lv || !l.geom || l.geom.length < 2) continue;
    const o = l.k === 'train' ? {color: c.train, weight: 5, dashArray: null} : l.k === 'moving' ? {color: c.line, weight: 3, dashArray: '7 6'}
      : l.k === 'road' || l.k === 'curb' ? {color: c.road, weight: 6, dashArray: null} : {color: c.corr, weight: 4, dashArray: '2 6'};
    st.lines.push(L.polyline(l.geom, Object.assign({renderer: st.cv, interactive: false, opacity: .95, lineCap: 'round', lineJoin: 'round'}, o)).addTo(g));
  }
}
function drawGates(st) {
  const {L, map, P, c} = st;
  if (st.g.gates) st.g.gates.remove();
  const g = st.g.gates = L.layerGroup();
  const r = gateR(map.getZoom());
  for (const p of P.gatesL.get(st.level) || []) {
    L.circleMarker([p.lat, p.lon], {renderer: st.cvG, interactive: false, radius: r, stroke: true, color: c.gatec, weight: 1.5, fill: true, fillColor: c.gate, fillOpacity: 1}).addTo(g);
  }
  if (map.getZoom() >= 16.5) g.addTo(map);
}
function routeParts(st) {
  const P = st.P, parts = [];
  let cur = null;
  for (const x of st.r.hops) {
    const a = P.nodes.get(x.from), b = P.nodes.get(x.to);
    if (a.level !== b.level || VERT.has(x.e.k)) { cur = null; parts.push({vert: true, k: x.e.k, a, b}); continue; }
    if (!cur || cur.level !== a.level) { cur = {level: a.level, pts: [[a.lat, a.lon]]}; parts.push(cur); }
    cur.pts.push([b.lat, b.lon]);
  }
  return parts;
}
function drawRoute(st) {
  const {L, map, c} = st, lv = st.level;
  if (st.g.route) st.g.route.remove();
  st.g.route = null; st.badges = [];
  if (!st.r || !st.r.hops.length) return;
  const g = st.g.route = L.layerGroup().addTo(map);
  const parts = routeParts(st);
  const base = {renderer: st.sv, interactive: false, lineCap: 'round', lineJoin: 'round'};
  for (const p of parts) if (!p.vert && p.level !== lv) L.polyline(p.pts, Object.assign({}, base, {color: c.route, weight: 4, opacity: .55, dashArray: '6 8'})).addTo(g);
  for (const p of parts) {
    if (p.vert || p.level !== lv) continue;
    L.polyline(p.pts, Object.assign({}, base, {color: c.routec, weight: 11, opacity: 1})).addTo(g);
    L.polyline(p.pts, Object.assign({}, base, {color: c.route, weight: 6.5, opacity: 1})).addTo(g);
    L.polyline(p.pts, Object.assign({}, base, {color: c.flow, weight: 2.5, opacity: .9, dashArray: '1 13', className: 'na-flow'})).addTo(g);
  }
  const seen = new Set();
  for (const p of parts) {
    if (!p.vert || (p.a.level !== lv && p.b.level !== lv)) continue;
    const here = p.a.level === lv ? p.a : p.b, other = here === p.a ? p.b : p.a;
    if (seen.has(here.id)) continue;
    seen.add(here.id);
    const up = other.level > here.level;
    const ic = p.k === 'elevator' ? 'elevator' : p.k === 'stairs' ? 'stairs' : up ? 'escalator-up' : 'escalator-down';
    const lab = (lvObj(st.P, other.level) || {}).short || other.level;
    L.marker([here.lat, here.lon], {pane: 'naPin', interactive: false, keyboard: false,
      icon: L.divIcon({className: 'na-mkw', html: `<span class="na-vb">${icon(ic)}<b>${N.esc(`To ${lab}`)}</b></span>`, iconSize: [64, 30], iconAnchor: [32, 40]})}).addTo(g);
    st.badges.push({lat: here.lat, lon: here.lon, to: other.level, w: 64});
  }
}
function drawHl(st) {
  const {L, map, c} = st;
  if (!map) return;
  if (st.g.hl) st.g.hl.remove();
  st.g.hl = null;
  if (!st.r || st.place || !st.r.steps[st.sel]) return;
  const s = st.r.steps[st.sel];
  if (s.level !== st.level) return;
  const g = st.g.hl = L.layerGroup().addTo(map);
  if (s.pts.length > 1 && (s.kind === 'walk' || s.kind === 'moving' || s.kind === 'outside' || s.kind === 'door' || s.kind === 'train')) {
    L.polyline(s.pts, {renderer: st.sv, interactive: false, color: c.routec, weight: 13, lineCap: 'round', lineJoin: 'round'}).addTo(g);
    L.polyline(s.pts, {renderer: st.sv, interactive: false, color: c.hl, weight: 7.5, lineCap: 'round', lineJoin: 'round'}).addTo(g);
  }
  L.circleMarker(s.at, {renderer: st.sv, interactive: false, radius: 7, color: c.routec, weight: 3, fill: true, fillColor: c.hl, fillOpacity: 1}).addTo(g);
}
// A pin label and shorter ones to fall back on: "Departures curb, Door 3" -> "Departures curb" -> "Door 3".
function labsOf(t) {
  t = String(t);
  const a = t.match(/^([^,(]{4,}?)\s*[,(]/), d = t.match(/\b(Door|Gate|Carousel) [A-Z]?\d+[A-Z]?\b/);
  return [...new Set([t, a && a[1], d && d[0]].filter(Boolean))];
}
function drawPins(st) {
  const {L, map} = st;
  if (st.g.pins) st.g.pins.remove();
  const g = st.g.pins = L.layerGroup().addTo(map);
  st.reserved = [];
  const pin = (e, cls, ic, label) => {
    if (!e || e.lat == null) return;
    const off = e.level != null && e.level !== st.level;
    const html = `<span class="na-pin ${cls}${off ? ' off' : ''}"><i>${ic ? icon(ic) : ''}</i>${label ? `<b>${N.esc(label)}</b>` : ''}</span>`;
    const m = L.marker([e.lat, e.lon], {pane: 'naPin', interactive: false, keyboard: false,
      icon: L.divIcon({className: 'na-mkw', html, iconSize: [32, 32], iconAnchor: [16, 16]})}).addTo(g);
    st.reserved.push({lat: e.lat, lon: e.lon, w: 32 + (label ? 12 + label.length * 7.6 : 0), m: label ? m : null, labs: label ? labsOf(label) : []});
  };
  // Map labels are short: the sheet already says "Baggage carousel 4".
  const lab = e => e.kind !== 'hub' && e.poi && e.poi.ref && e.poi.k === 'baggage' ? `Carousel ${e.poi.ref}` : e.label;
  if (st.r) {
    if (st.A.kind !== 'here') pin(st.A, 'a', null, lab(st.A));
    st.V.forEach(v => pin(v, 'v', icOf(v), lab(v)));
    pin(st.B, 'b', icOf(st.B), lab(st.B));
  } else {
    // only this direction's gates: on the way home, last week's arrival gate is noise
    const fl = st.fl, arrE = (!fl.dir || fl.strictA) && st.arrE, depE = (!fl.dir || fl.strictD) && st.depE;
    if (arrE) pin(arrE, 'f', 'plane', arrE.kind === 'gate' ? `Arrive ${arrE.ref}` : null);
    if (depE && (!arrE || depE.node !== arrE.node)) pin(depE, 'f', 'plane-departure', depE.kind === 'gate' ? `Depart ${depE.ref}` : null);
  }
  if (st.place) pin(st.place, 'p', kd(st.place.k)[0], null);
}
function drawMe(st) {
  const {L, map, c} = st;
  if (!map) return;
  let pos = null;
  if (st.manual) { const n = st.P.nodes.get(st.manual.node); pos = [n.lat, n.lon]; }
  else if (st.fix && !st.far) pos = [st.fix.lat, st.fix.lon];
  if (!pos) {
    ['me', 'acc', 'link'].forEach(k => { if (st.g[k]) { st.g[k].remove(); st.g[k] = null; } });
    return;
  }
  if (!st.g.me) {
    st.g.me = L.marker(pos, {pane: 'naMe', interactive: false, keyboard: false,
      icon: L.divIcon({className: 'na-mkw', html: '<span class="na-me"><i class="na-cone"></i><i class="na-halo"></i><i class="na-dot"></i></span>', iconSize: [24, 24], iconAnchor: [12, 12]})}).addTo(map);
  } else st.g.me.setLatLng(pos);
  const acc = !st.manual && st.fix ? st.fix.acc : 0;
  if (acc > 0) {
    if (!st.g.acc) st.g.acc = L.circle(pos, {renderer: st.sv, interactive: false, radius: acc, color: c.me, weight: 1, opacity: .5, fillColor: c.me, fillOpacity: .1}).addTo(map);
    else { st.g.acc.setLatLng(pos); st.g.acc.setRadius(acc); }
  } else if (st.g.acc) { st.g.acc.remove(); st.g.acc = null; }
  // a dotted line from the blue dot to where the route starts
  const A = st.r && st.A;
  const lk = A && A.kind === 'here' && !st.manual && A.lat != null && A.level === st.level ? [pos, [A.lat, A.lon]] : null;
  if (lk && N.dist({lat: pos[0], lon: pos[1]}, {lat: A.lat, lon: A.lon}) > 3) {
    if (!st.g.link) st.g.link = L.polyline(lk, {renderer: st.sv, interactive: false, color: c.me, weight: 3.5, opacity: .9, dashArray: '1 8', lineCap: 'round'}).addTo(map);
    else st.g.link.setLatLngs(lk);
  } else if (st.g.link) { st.g.link.remove(); st.g.link = null; }
  drawHeading(st);
}
function drawHeading(st) {
  const el = st.g.me && st.g.me.getElement && st.g.me.getElement();
  const me = el && el.querySelector('.na-me');
  if (!me) return;
  me.classList.toggle('hd', st.compass && st.heading != null);
  if (st.heading != null) me.style.setProperty('--hd', `${Math.round(st.heading)}deg`);
}
function onZoom(st) {
  const z = st.map.getZoom();
  if (st.corr) st.corr.setStyle({weight: corrW(z)});
  if (st.g.gates) {
    st.g.gates.eachLayer(l => l.setRadius(gateR(z)));
    if (z >= 16.5 && !st.map.hasLayer(st.g.gates)) st.g.gates.addTo(st.map);
    if (z < 16.5 && st.map.hasLayer(st.g.gates)) st.g.gates.remove();
  }
  schedulePlace(st);
}
function schedulePlace(st) {
  if (st.placeQ) return;
  st.placeQ = requestAnimationFrame(() => { st.placeQ = 0; if (!st.dead) placeMarkers(st); });
}
// POI icons, gate labels and area names, placed most important first and
// skipped where they would overlap something already placed.
function placeMarkers(st) {
  const {map, L, P} = st;
  if (!map) return;
  const z = map.getZoom(), sz = map.getSize(), lv = st.level;
  const skip = new Set([st.A && st.A.poi && st.A.poi.id, st.B && st.B.poi && st.B.poi.id, st.place && st.place.id,
    ...(st.r ? [] : [st.arrE && st.arrE.poi && st.arrE.poi.id, st.depE && st.depE.poi && st.depE.poi.id])].filter(Boolean));
  const items = [];
  if (z >= 18) {
    for (const g of P.gatesL.get(lv) || []) {
      if (skip.has(g.id)) continue;
      const w = 12 + String(g.ref).length * 8.4;
      items.push({id: 'g:' + g.id, pri: 2, lat: g.lat, lon: g.lon, poi: g, w, h: 22, ax: w / 2, ay: 30, html: `<span class="na-gl">${N.esc(g.ref)}</span>`});
    }
  }
  for (const p of P.poisL.get(lv) || []) {
    if (p.k === 'gate' || skip.has(p.id)) continue;
    const [ic, cat, , tier] = kd(p.k);
    if (z < TIER_Z[tier]) continue;
    const nm = z >= 19 && tier <= 2 ? strip(p.name) : '';
    const w = 28 + (nm ? 8 + nm.length * 7.6 : 0);
    items.push({id: p.id, pri: tier === 1 ? 1 : tier + 1, lat: p.lat, lon: p.lon, poi: p, w, h: 28, ax: 14, ay: 14,
      html: `<span class="na-mk c-${cat}">${icon(ic)}</span>${nm ? `<b class="na-mkn">${N.esc(nm)}</b>` : ''}`});
  }
  if (z >= 15.5 && z < 18.75) {
    for (const a of P.labels.get(lv) || []) {
      const w = a.text.length * 7.8 + 10;
      items.push({id: 'a:' + a.id, pri: 5, lat: a.lat, lon: a.lon, w, h: 20, ax: w / 2, ay: 10, html: `<span class="na-al">${N.esc(a.text)}</span>`});
    }
  }
  const rects = [];
  const pt = (lat, lon) => map.latLngToContainerPoint([lat, lon]);
  // a pin's label sits to its right unless that would put it under the buttons on the right edge
  const lft = st.P.levels.length > 1 ? 64 : 8;
  const chips = (st.badges || []).map(b => { const q = pt(b.lat, b.lon); return [q.x - 34, q.y - 42, q.x + 34, q.y - 8]; });
  const hitsChip = a => chips.some(b => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]);
  for (const r of st.reserved || []) {
    const q = pt(r.lat, r.lon);
    const el = r.m && r.m.getElement(), pe = el && el.firstElementChild, lb = pe && pe.querySelector('b');
    let w = r.w, flip = false;
    if (lb) {
      lb.style.maxWidth = ''; lb.hidden = false;
      const right = sz.x - 64 - (q.x + 16), left = q.x - 16 - lft;
      // the longest name that fits on a side clear of floor chips (right first); else the shortest, best side
      let lw = 0, done = false;
      const rR = n => [q.x - 18, q.y - 18, q.x + 16 + n, q.y + 18], rL = n => [q.x - 16 - n, q.y - 18, q.x + 18, q.y + 18];
      for (const t of r.labs) {
        if (lb.textContent !== t) lb.textContent = t;
        lw = lb.offsetWidth + 6;
        if (lw <= right && !hitsChip(rR(lw))) { flip = false; done = true; break; }
        if (lw <= left && !hitsChip(rL(lw))) { flip = true; done = true; break; }
      }
      if (!done) {
        const t = r.labs.reduce((x, y) => y.length < x.length ? y : x);
        if (lb.textContent !== t) { lb.textContent = t; lw = lb.offsetWidth + 6; }
        flip = lw > right && left > right;
      }
      const room = Math.max(64, Math.floor(flip ? left : right));
      if (lw > room) lb.style.maxWidth = `${room - 6}px`;
      w = 32 + Math.min(lw, room);
      // two pins side by side: the second label goes the other way, or is left off
      const box = f => f ? [q.x + 16 - w, q.y - 18, q.x + 18, q.y + 18] : [q.x - 18, q.y - 18, q.x - 16 + w, q.y + 18];
      const hits = a => rects.some(o => a[0] < o[2] && a[2] > o[0] && a[1] < o[3] && a[3] > o[1]);
      if (hits(box(flip)) && Math.min(lw, Math.floor(flip ? right : left)) >= lw && !hits(box(!flip))) flip = !flip;
      // no side clear of a floor chip: the pin keeps its icon and the sheet names it
      lb.hidden = hits(box(flip)) || (!done && hitsChip(box(flip)));
      if (lb.hidden) w = 32;
      pe.classList.toggle('lf', flip);
    }
    rects.push(flip ? [q.x + 16 - w, q.y - 18, q.x + 18, q.y + 18] : [q.x - 18, q.y - 18, q.x - 16 + w, q.y + 18]);
  }
  rects.push(...chips);
  // labels never sit under the buttons, the floor picker or the map credit
  const mr = map.getContainer().getBoundingClientRect();
  for (const e of st.root ? st.root.querySelectorAll('.na-ctl > *, .na-fl, .na-top, .leaflet-control-attribution') : []) {
    const b = e.getBoundingClientRect();
    if (b.width) rects.push([b.left - mr.left - 4, b.top - mr.top - 4, b.right - mr.left + 4, b.bottom - mr.top + 4]);
  }
  items.sort((a, b) => a.pri - b.pri);
  const keep = new Map();
  for (const it of items) {
    const q = pt(it.lat, it.lon);
    if (q.x < 4 || q.y < 4 || q.x > sz.x - 4 || q.y > sz.y - 4) continue;
    const r = [q.x - it.ax - 2, q.y - it.ay - 2, q.x - it.ax + it.w + 2, q.y - it.ay + it.h + 2];
    // a bare icon may run off the edge; a name never does
    if (it.w > 28 && (r[0] < 0 || r[2] > sz.x || r[1] < 0 || r[3] > sz.y)) continue;
    if (rects.some(o => r[0] < o[2] && r[2] > o[0] && r[1] < o[3] && r[3] > o[1])) continue;
    rects.push(r);
    keep.set(it.id, it);
  }
  for (const [id, m] of st.mk) if (!keep.has(id) || m._na.html !== keep.get(id).html) { m.remove(); st.mk.delete(id); }
  for (const [id, it] of keep) {
    if (st.mk.has(id)) continue;
    const m = L.marker([it.lat, it.lon], {pane: 'naMk', interactive: false, keyboard: false,
      icon: L.divIcon({className: 'na-mkw', html: it.html, iconSize: [it.w, it.h], iconAnchor: [it.ax, it.ay]})}).addTo(map);
    m._na = it;
    st.mk.set(id, m);
  }
}
function onMapTap(st, ev) {
  const map = st.map, p = ev.containerPoint;
  let best = null, bd = 26;
  const test = (lat, lon, item) => { const d = map.latLngToContainerPoint([lat, lon]).distanceTo(p); if (d < bd) { bd = d; best = item; } };
  for (const b of st.badges || []) test(b.lat, b.lon - 0, {level: b.to});
  for (const m of st.mk.values()) if (m._na.poi) test(m._na.lat, m._na.lon, {poi: m._na.poi});
  if (map.getZoom() >= 16.5) for (const g of st.P.gatesL.get(st.level) || []) test(g.lat, g.lon, {poi: g});
  if (st.r) for (const e of [st.A, st.B]) if (e && e.poi && e.level === st.level) test(e.lat, e.lon, {poi: e.poi});
  if (!best) {
    if (st.place) { st.place = null; paintSheet(st); drawPins(st); drawHl(st); placeMarkers(st); }
    return;
  }
  if (best.level != null) { setLevel(st, best.level); return; }
  openPlace(st, best.poi);
}
function openPlace(st, p) {
  st.place = p;
  if (st.full) setFull(st, false);
  paintSheet(st);
  if (st.map) { drawPins(st); drawHl(st); placeMarkers(st); }
  // once the sheet has settled, slide the map if the place ended up under it
  later(st, () => { if (st.place === p) showPt(st, [p.lat, p.lon]); }, 340);
}
function showPt(st, ll) {
  if (!st.map) return;
  const o = pad(st), sz = st.map.getSize(), q = st.map.latLngToContainerPoint(ll);
  if (q.x < o.paddingTopLeft[0] || q.y < o.paddingTopLeft[1] || q.x > sz.x - o.paddingBottomRight[0] || q.y > sz.y - o.paddingBottomRight[1]) {
    centerOn(st, ll, st.map.getZoom(), 'pan');
  }
}
function setFull(st, on) {
  st.full = on;
  const r = st.root;
  if (!r) return;
  r.classList.toggle('full', on);
  const gb = N.$('.na-grab', r);
  if (gb) { gb.setAttribute('aria-expanded', String(on)); gb.setAttribute('aria-label', on ? 'Show more map' : 'Show more'); }
}
function prefetchTiles(st) {
  const t = N.tiles(N.isDark());
  if (!tilesOk(t) || !N.sw || !N.sw.prefetch) return;
  const key = st.code + (N.isDark() ? ':d' : ':l');
  if (fetched.has(key)) return;
  fetched.add(key);
  const [s, w, n, e] = st.P.nav.bbox, urls = [];
  const tx = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
  const ty = (lat, z) => Math.floor((1 - Math.log(Math.tan(lat * RAD) + 1 / Math.cos(lat * RAD)) / Math.PI) / 2 * 2 ** z);
  const subs = String(t.opts && t.opts.subdomains || 'abc');
  for (let z = 16; z <= 19 && urls.length < 600; z++) {
    for (let x = tx(w, z); x <= tx(e, z) && urls.length < 600; x++) {
      for (let y = ty(n, z); y <= ty(s, z) && urls.length < 600; y++) {
        urls.push(t.url.replace('{s}', subs[(x + y) % subs.length]).replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{r}', ''));
      }
    }
  }
  N.sw.prefetch(urls, 'tiles').catch(() => {});
}
const fetched = new Set();

// ---------- where am I ----------
function snap(st) {
  const f = st.fix, P = st.P;
  st.far = N.dist(f, {lat: P.nav.center[0], lon: P.nav.center[1]}) > 1500;
  st.gpsHere = null;
  if (st.far || f.acc > 35) return;
  const nn = nearestNode(P, f.lat, f.lon, st.level) || nearestNode(P, f.lat, f.lon, null);
  if (!nn || nn.d > 60) return;
  const n = nn.node;
  let label = null, bd = 36;
  for (const p of P.poisL.get(n.level) || []) {
    if (p.k !== 'gate' && kd(p.k)[3] !== 1) continue;
    const d = Math.hypot(p.x - n.x, p.y - n.y);
    if (d < bd) { bd = d; label = p.k === 'gate' ? `Gate ${p.ref}` : strip(p.name); }
  }
  if (!label && n.name) label = strip(n.name);
  st.gpsHere = {node: n.id, label: label ? `Near ${label}` : 'Near you', side: null};
}
function setFix(st, w, center) {
  if (!w || st.dead) return;
  const prevNode = st.gpsHere && st.gpsHere.node;
  st.fix = {lat: w.lat, lon: w.lon, acc: Math.max(1, Math.round(w.acc || 0))};
  snap(st);
  drawMe(st);
  if (!st.follow) { const wt = $(st, '.na-top'); if (wt) paintTop(st); }
  paintCtl(st);
  // a route from "here" follows the GPS spot when it moves to another node
  let fitted = false;
  if (st.to && (st.from === '@here' || !st.from) && !st.manual && st.gpsHere && st.gpsHere.node !== prevNode && !st.follow) {
    const now = Date.now();
    if (!st.rrAt || now - st.rrAt > 5000) { st.rrAt = now; fitted = !prevNode; reroute(st, fitted); }
  }
  // a route that this fix just made is framed whole, with you in it, so don't zoom in on the dot
  if (st.map && !st.far && !st.manual && !fitted && (center === 'me' || (center === 'auto' && !st.r))) {
    centerOn(st, [w.lat, w.lon], Math.max(st.map.getZoom(), 18.5), 'fly');
  }
  if (st.follow && st.r && st.fix.acc <= 25) {
    const nx = st.r.steps[st.sel + 1];
    if (nx && N.dist(st.fix, {lat: nx.at[0], lon: nx.at[1]}) <= 20) selectStep(st, st.sel + 1);
    else if (st.map && !st.userMoved) centerOn(st, [st.fix.lat, st.fix.lon], st.map.getZoom(), 'pan');
  }
}
async function locate(st, quiet) {
  if (st.dead) return;
  st.locating = true;
  if (!st.follow) paintTop(st);
  paintCtl(st);
  const w = await N.where({fresh: true});
  if (st.dead) return;
  st.locating = false;
  if (!w) {
    if (!st.follow) paintTop(st);
    paintCtl(st);
    if (!quiet) N.toast('Location is off. Pick your gate or a landmark instead.', 3200);
    return;
  }
  st.manual = null;
  setFix(st, w, quiet ? 'auto' : 'me');
  if (!window.__NYC_WHERE && navigator.geolocation && st.watch == null) {
    try {
      st.watch = navigator.geolocation.watchPosition(p => {
        if (st.dead) return;
        setFix(st, {lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy}, false);
      }, () => {}, {enableHighAccuracy: true, maximumAge: 5000, timeout: 20000});
    } catch { st.watch = null; }
  }
}
async function toggleCompass(st) {
  if (st.compass) { stopCompass(st); paintCtl(st); drawHeading(st); return; }
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) { N.toast('This phone has no compass'); return; }
  if (typeof DOE.requestPermission === 'function') {
    let r = 'denied';
    try { r = await DOE.requestPermission(); } catch { r = 'denied'; }
    if (r !== 'granted') { N.toast('Compass access is off. Turn it on in Safari settings.', 3000); return; }
  }
  if (st.dead) return;
  const fn = e => {
    let hd = e.webkitCompassHeading;
    if (hd == null && e.absolute && e.alpha != null) hd = 360 - e.alpha;
    if (hd == null || isNaN(hd)) return;
    st.heading = hd; st.gotHd = true;
    drawHeading(st);
  };
  const ev = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
  window.addEventListener(ev, fn);
  st.compassOff = () => window.removeEventListener(ev, fn);
  st.compass = true; st.gotHd = false;
  paintCtl(st);
  if (!st.fix && !st.manual) N.toast('Compass on. Find your spot to see which way you face.', 2600);
  later(st, () => { if (st.compass && !st.gotHd) { N.toast('No compass reading on this device'); stopCompass(st); paintCtl(st); } }, 3500);
}
function stopCompass(st) {
  if (st.compassOff) { try { st.compassOff(); } catch { /* ignore */ } }
  st.compassOff = null; st.compass = false;
}

// ---------- route changes ----------
function reroute(st, fit) {
  recompute(st);
  syncHash(st);
  paintAll(st);
  if (st.map) {
    drawRoute(st); drawHl(st); drawPins(st); drawMe(st); placeMarkers(st);
    if (fit) fitRoute(st, true);
  }
}
function setRoute(st, from, to, via) {
  st.from = from; st.to = to; st.via = via || [];
  st.place = null; st.follow = false; st.sel = 0; st.chip = null; st.q = '';
  setFull(st, false);
  recompute(st);
  syncHash(st);
  if (st.r && st.r.steps.length) st.level = st.r.steps[0].level;
  paintAll(st);
  if (st.map) { drawAll(st); fitRoute(st, true); }
}
function setHere(st, key) {
  const e = resolve(st, key);
  if (!e) return;
  st.manual = {node: e.node, label: e.label, side: e.side || null};
  st.picker = false;
  const pk = $(st, '.na-pk');
  if (pk) { pk.hidden = true; pk.innerHTML = ''; }
  st.place = null;
  N.toast(`Set: you’re at ${e.label}`);
  if (st.to) { st.from = '@here'; st.sel = 0; reroute(st, true); if (st.map) drawMe(st); return; }
  if (e.level !== st.level) st.level = e.level;
  st.dc = null;
  paintAll(st);
  if (st.map) {
    drawAll(st);
    centerOn(st, [e.lat, e.lon], Math.max(st.map.getZoom(), 18.5), 'fly');
  }
}

// ---------- actions ----------
const act = fn => (el, ev, ctx, arg) => { const st = S; if (!st || st.dead || !st.P) return; return fn(st, arg, el, ev); };
const actions = {
  locate: act(st => locate(st, false)),
  grab: act(st => { if (st.swiped && Date.now() - st.swiped < 500) return; setFull(st, !st.full); }),
  topx: act(st => { st.topOpen = !st.topOpen; paintTop(st); const b = $(st, '[data-act="topx"]'); if (b) b.focus({preventScroll: true}); }),
  compass: act(st => toggleCompass(st)),
  lvl: act((st, arg) => setLevel(st, +arg)),
  fit: act(st => { st.userMoved = false; fitRoute(st, true); }),
  step: act((st, arg, el) => {
    const i = +arg;
    selectStep(st, i, {scroll: !el.classList.contains('na-card') || true});
    if (el.classList.contains('na-li') && st.full) setFull(st, false);
  }),
  prev: act(st => selectStep(st, Math.max(0, st.sel - 1), {scroll: true})),
  next: act(st => selectStep(st, Math.min(st.r.steps.length - 1, st.sel + 1), {scroll: true})),
  start: act(st => {
    if (!st.r) return;
    st.follow = true; st.userMoved = false;
    setFull(st, false);
    paintTop(st); paintSheet(st);
    selectStep(st, st.sel || 0);
    if (!st.fix && N.whereOk()) locate(st, true);
  }),
  end: act(st => { st.follow = false; paintAll(st); requestAnimationFrame(() => scrollCards(st, st.sel, false)); }),
  sf: act(st => {
    st.sf = !st.sf;
    N.set('nyc.nav.sf', st.sf || null);
    reroute(st, true);
    N.toast(st.sf ? 'Step-free: elevators only' : 'Step-free off');
  }),
  swap: act(st => {
    const a = st.from || defaultFrom(st);
    if (!a) return;
    setRoute(st, st.to, a, (st.via || []).slice().reverse());
  }),
  close: act(st => {
    st.to = null; st.from = null; st.via = []; st.follow = false; st.place = null;
    recompute(st); syncHash(st); setFull(st, false);
    paintAll(st);
    if (st.map) { drawAll(st); }
  }),
  chip: act((st, arg) => {
    st.chip = st.chip === arg ? null : arg;
    st.q = '';
    const inp = $(st, 'input[data-input="q"]');
    if (inp) inp.value = '';
    N.$$('.na-chip', st.root).forEach(b => { const on = b.dataset.arg === st.chip; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    paintResults(st);
    const c = $(st, '.na-shc');
    if (st.chip && !st.full) setFull(st, true);
    if (c) c.scrollTop = 0;
  }),
  q: act((st, arg, el) => {
    st.q = el.value || '';
    st.chip = null;
    N.$$('.na-chip', st.root).forEach(b => { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); });
    paintResults(st);
    const x = $(st, '.na-qx');
    if (!!st.q !== !!x) {
      const lab = $(st, '.na-q');
      if (st.q && lab && !x) lab.insertAdjacentHTML('beforeend', String(h`<button class="na-qx" data-act="clearq" aria-label="Clear search">${icon('x')}</button>`));
      if (!st.q && x) x.remove();
    }
    if (st.q && !st.full) setFull(st, true);
  }),
  clearq: act(st => {
    st.q = '';
    const inp = $(st, 'input[data-input="q"]');
    if (inp) inp.value = '';
    const x = $(st, '.na-qx');
    if (x) x.remove();
    paintResults(st);
  }),
  to: act((st, arg) => {
    const from = st.to && st.from ? st.from : (st.r && st.A ? st.A.key : defaultFrom(st));
    if (!from) { N.toast('Set your spot first'); openPicker(st); return; }
    setRoute(st, from, arg, []);
  }),
  preset: act((st, arg) => {
    const pr = (st.P.nav.presets || []).find(p => p.id === arg);
    if (pr) setRoute(st, pr.from, pr.to, pr.via || []);
  }),
  place: act((st, arg) => { const p = st.P.byId.get(arg); if (p) openPlace(st, p); }),
  unplace: act(st => { st.place = null; paintSheet(st); if (st.map) { drawPins(st); drawHl(st); placeMarkers(st); } }),
  here: act((st, arg) => setHere(st, arg)),
  pick: act(st => openPicker(st)),
  pickx: act(st => { st.picker = false; const pk = $(st, '.na-pk'); if (pk) { pk.hidden = true; pk.innerHTML = ''; } }),
  pq: act((st, arg, el) => { const r = $(st, '.na-pkr'); if (r) r.innerHTML = pickerList(st, el.value || ''); }),
  gps: act(st => {
    st.manual = null; st.picker = false;
    const pk = $(st, '.na-pk');
    if (pk) { pk.hidden = true; pk.innerHTML = ''; }
    locate(st, false);
  }),
};
function openPicker(st) {
  const pk = $(st, '.na-pk');
  if (!pk) return;
  st.picker = true;
  pk.innerHTML = pickerHtml(st);
  pk.hidden = false;
  pk.scrollTop = 0;
}

// ---------- screen ----------
function watchScheme() {
  let mq = null;
  try { mq = matchMedia('(prefers-color-scheme: dark)'); } catch { return () => {}; }
  const fn = () => setTimeout(() => N.rerender(), 0);
  try { mq.addEventListener('change', fn); } catch { return () => {}; }
  return () => { try { mq.removeEventListener('change', fn); } catch { /* ignore */ } };
}
function mount(ctx, view) {
  const st = S;
  if (!st || !st.P) {
    // no map: just keep the list clear of the offline strip
    const nr = N.$('.na', view), strip = N.$('#strip');
    const fit = () => { if (nr) nr.style.setProperty('--na-strip', `${strip && strip.innerHTML.trim() ? strip.offsetHeight : 0}px`); };
    fit();
    let mo = null;
    if (nr && strip && window.MutationObserver) { mo = new MutationObserver(fit); mo.observe(strip, {childList: true, subtree: true, characterData: true}); }
    return () => { if (mo) mo.disconnect(); if (S === st) S = null; };
  }
  const root = N.$('.na', view);
  if (!root) return () => { st.dead = true; if (S === st) S = null; };
  st.root = root;
  const offs = [];
  // keep the floating parts clear of the offline strip, the top card and the sheet
  const strip = N.$('#strip');
  const measure = () => {
    if (st.dead) return;
    st.stripH = strip && strip.innerHTML.trim() ? strip.offsetHeight : 0;
    root.style.setProperty('--na-strip', `${st.stripH}px`);
    const top = $(st, '.na-top'), sh = $(st, '.na-sh');
    if (top) root.style.setProperty('--na-toph', `${top.offsetHeight}px`);
    if (sh) root.style.setProperty('--na-sheeth', `${sh.offsetHeight}px`);
  };
  measure();
  if (strip && window.MutationObserver) {
    const mo = new MutationObserver(measure);
    mo.observe(strip, {childList: true, subtree: true, characterData: true});
    offs.push(() => mo.disconnect());
  }
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => { measure(); if (st.map) { st.map.invalidateSize({pan: false}); schedulePlace(st); } });
    [$(st, '.na-top'), $(st, '.na-sh'), $(st, '.na-map')].forEach(e => e && ro.observe(e));
    offs.push(() => ro.disconnect());
  }
  // step cards: swiping one shows that step
  const onScroll = ev => {
    const sc = ev.target;
    if (!sc.classList || !sc.classList.contains('na-cards') || st.progScroll) return;
    clearTimeout(st.scT);
    st.scT = setTimeout(() => {
      if (st.dead || !st.r) return;
      const kids = sc.children;
      if (!kids.length) return;
      const w = kids.length > 1 ? kids[1].offsetLeft - kids[0].offsetLeft : kids[0].offsetWidth;
      let i = Math.round(sc.scrollLeft / Math.max(1, w));
      if (sc.scrollLeft >= sc.scrollWidth - sc.clientWidth - 2) i = kids.length - 1;
      i = Math.max(0, Math.min(kids.length - 1, i));
      if (i !== st.sel) selectStep(st, i);
    }, 110);
  };
  root.addEventListener('scroll', onScroll, true);
  offs.push(() => root.removeEventListener('scroll', onScroll, true));
  // the grab handle: the sheet follows the finger 1:1; on release a flick (over 0.5 px/ms) or a pull past
  // 40% of the way sets it open or closed, and it settles there. A tap toggles through the grab action.
  const sh = $(st, '.na-sh'), grab = $(st, '.na-grab');
  let dg = null;
  // the sheet's height in the other state, measured with its transition off so nothing moves
  const otherH = () => { root.classList.toggle('full'); const v = sh.offsetHeight; root.classList.toggle('full'); void sh.offsetHeight; return v; };
  const down = ev => {
    if (dg || !sh || sh.classList.contains('auto') || (ev.button != null && ev.button > 0)) return;
    const h0 = sh.getBoundingClientRect().height;
    sh.classList.add('drag');
    const o = otherH();
    dg = {id: ev.pointerId, y0: ev.clientY, h0, lo: st.full ? o : h0, hi: st.full ? h0 : o, pts: [[ev.timeStamp, ev.clientY]], moved: false};
    try { grab.setPointerCapture(ev.pointerId); } catch { /* not supported */ }
  };
  const move = ev => {
    if (!dg || ev.pointerId !== dg.id) return;
    const dy = ev.clientY - dg.y0;
    if (!dg.moved && Math.abs(dy) < 4) return;
    dg.moved = true;
    // 1:1 between closed and open, with a little give past either end
    let ht = dg.h0 - dy;
    if (ht > dg.hi) ht = dg.hi + (ht - dg.hi) / 4; else if (ht < dg.lo) ht = dg.lo - (dg.lo - ht) / 4;
    sh.style.height = `${Math.round(ht)}px`;
    dg.pts.push([ev.timeStamp, ev.clientY]);
    if (dg.pts.length > 10) dg.pts.shift();
    ev.preventDefault();
  };
  const settle = open => {
    const to = open ? dg.hi : dg.lo;
    dg = null;
    sh.classList.remove('drag');
    sh.style.height = `${to}px`;
    setFull(st, open);
    // once there, the stylesheet's size takes over (the same height, so nothing moves)
    let t = null;
    const done = ev => {
      if (ev && ev.target !== sh) return;
      sh.removeEventListener('transitionend', done); clearTimeout(t);
      if (!sh.classList.contains('drag')) sh.style.height = '';
    };
    sh.addEventListener('transitionend', done);
    t = setTimeout(done, 400);
  };
  const up = ev => {
    if (!dg || ev.pointerId !== dg.id) return;
    if (!dg.moved || ev.type === 'pointercancel') {
      const was = dg; dg = null;
      sh.classList.remove('drag');
      if (was.moved) { sh.style.height = ''; st.swiped = Date.now(); }
      return;
    }
    st.swiped = Date.now();
    const t1 = ev.timeStamp, y1 = ev.clientY;
    const p0 = dg.pts.find(p => t1 - p[0] <= 80) || dg.pts[0];
    const v = (y1 - p0[1]) / Math.max(1, t1 - p0[0]);   // px per ms, + is down
    const frac = (sh.getBoundingClientRect().height - dg.lo) / Math.max(1, dg.hi - dg.lo);
    settle(Math.abs(v) > .5 ? v < 0 : st.full ? frac > .6 : frac > .4);
  };
  if (sh && grab) {
    grab.addEventListener('pointerdown', down);
    grab.addEventListener('pointermove', move);
    grab.addEventListener('pointerup', up);
    grab.addEventListener('pointercancel', up);
    offs.push(() => {
      grab.removeEventListener('pointerdown', down); grab.removeEventListener('pointermove', move);
      grab.removeEventListener('pointerup', up); grab.removeEventListener('pointercancel', up);
    });
  }
  offs.push(watchScheme());
  N.loadLeaflet().then(L => {
    if (st.dead || !root.isConnected) return;
    measure();
    initMap(st, L);
    if (st.r) requestAnimationFrame(() => scrollCards(st, st.sel, false));
  }).catch(e => {
    if (st.dead || !root.isConnected) return;
    N.report(e, 'nav map');
    const box = $(st, '.na-map');
    if (box) box.innerHTML = String(h`<p class="na-nomap">${icon('map')}The map didn’t load. The directions below still work.</p>`);
  });
  if (N.whereOk()) locate(st, true);
  return () => {
    st.dead = true;
    offs.forEach(f => { try { f(); } catch { /* ignore */ } });
    if (st.watch != null) { try { navigator.geolocation.clearWatch(st.watch); } catch { /* ignore */ } st.watch = null; }
    stopCompass(st);
    st.timers.forEach(t => clearTimeout(t));
    clearTimeout(st.scT); clearTimeout(st.psT);
    if (st.placeQ) cancelAnimationFrame(st.placeQ);
    if (st.map) { try { st.map.remove(); } catch { /* already gone */ } }
    st.map = null; st.fix = null; st.gpsHere = null; st.manual = null;
    if (S === st) S = null;
  };
}
// Walking minutes between two gates on this airport's map, the same figure the map shows, or null when
// the map or either gate is missing. Needs only the guide data, not this screen.
const WALK = new Map();
N.navWalk = (code, g1, g2) => {
  try {
    const c = String(code || '').trim().toUpperCase();
    const g = c && g1 && g2 ? N.guideFor(c) : null;
    const P = g && g.nav ? prep(g.nav) : null;
    if (!P) return null;
    const k = `${c}|${normG(g1)}|${normG(g2)}`, hit = WALK.get(k);
    if (hit && hit.P === P) return hit.m;
    const a = matchGate(P, g1), b = matchGate(P, g2);
    const p = a && b ? pathBetween(P, a.node, b.node, {sf: false, tsa: null}) : null;
    const m = p ? minN(p.sec) : null;
    WALK.set(k, {P, m});
    return m;
  } catch (e) { N.report(e, 'navWalk'); return null; }
};
N.screen('nav', {
  nav: false, back: 'airports', tone: 'band', strip: undefined,
  uses: ['guide', 'status', 'trip', 'force'],
  title: ctx => `${parse(ctx.param).code || 'Airport'} walking map`,
  render(ctx) {
    S = makeState(ctx);
    if (!S.P) return {hero: '', body: emptyHtml(S)};
    return {hero: '', body: shellHtml(S)};
  },
  mount,
  update(ctx, why) {
    const st = S;
    if (!st || st.dead) return;
    if (why === 'guide') {
      const g = N.guideFor(st.code), P = g && g.nav ? prep(g.nav) : null;
      if (!P) { N.rerender(); return; }
      if (P !== st.P) { st.P = P; st.guide = g; }
    }
    if (!st.P) return;
    const old = new Map(N.$$('[data-k]', st.root || D).map(e => [e.dataset.k, e.textContent]));
    const oldA = st.A, oldB = st.B;
    recompute(st);
    const changed = e => e && (e.key === '@arr' || e.key === '@dep' || e.key === '@bag');
    let msg = null;
    if (st.r && oldB && st.B && changed(st.B) && sig(oldB) !== sig(st.B) && st.B.kind === 'gate') {
      msg = `${oldB.kind === 'gate' ? `Gate changed to ${st.B.ref}` : `Gate ${st.B.ref} posted`}. New route: ${minN(st.r.sec)} min`;
    } else if (st.r && oldA && st.A && changed(st.A) && sig(oldA) !== sig(st.A) && st.A.kind === 'gate') {
      msg = `Arrival gate changed to ${st.A.ref}. New route: ${minN(st.r.sec)} min`;
    }
    const moved = sig(oldA) !== sig(st.A) || sig(oldB) !== sig(st.B);
    if (moved || why === 'force' || why === 'guide' || !st.r) paintAll(st);
    else { paintTop(st); paintLive(st); }
    if (st.map) {
      if (why === 'force' || why === 'guide') drawAll(st);
      else if (moved) { drawRoute(st); drawHl(st); drawPins(st); placeMarkers(st); fitRoute(st, true); }
      else { drawPins(st); placeMarkers(st); }
    }
    if (st.root) flashChanged(st, old);
    if (msg) N.toast(msg, 3200);
  },
  tick() { const st = S; if (st && !st.dead && st.P) paintLive(st); },
  actions,
});
function paintLive(st) {
  const set = (k, v) => { const e = st.root && N.$(`[data-k="${k}"]`, st.root); if (e && v != null && e.textContent !== v) e.textContent = v; };
  if (!st.r) return;
  const se = st.root && N.$('[data-k="sum"]', st.root);
  if (se && !st.follow) {
    const sm = sumParts(st), b = N.$('b', se), t = N.$('span', se);
    if (b && b.textContent !== sm.min) b.textContent = sm.min;
    if (t && t.textContent !== sm.line) t.textContent = sm.line;
  }
  const pl = planInfo(st);
  if (!pl) return;
  if (pl.head) set('conn', pl.head);
  set('board', pl.line); set('boards', shortLine(pl.line)); set('foot', pl.foot); set('tone', pl.word);
  const te = st.root && N.$('[data-k="tone"]', st.root);
  if (te) te.className = `na-tone ${pl.tone}`;
}
})();
