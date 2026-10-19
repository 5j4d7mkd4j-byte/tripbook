// airmap.js - the airport map engine, N.airmap.
//
//   load(code)                  sealed indoor_<code> -> prepared airport P (memoised; null = no map)
//   CHIPS, places(P), gates(P)  pickers: POI chips (all default off), route endpoints, gates
//   route(P, from, to, opts)    Dijkstra over the walk graph with nav.js costs, one-way security and exits,
//                               PreCheck lanes only with opts.tsa === 'pre'; opts.shut = POI ids of checkpoints
//                               and lanes closed now (avoided while an open one serves); steps[] in plain words
//   nearest(P, [lon,lat], l)    nearest walkable node and a label for it
//   poisAlong(P, R, chips, n)   chip POIs ranked by the detour they add to a route
//   mount(el, P, opts) -> M     MapLibre GL map (offline: GeoJSON sources, glyphs drawn at runtime from the
//                               app's Inter, icons from the app's sprite); Leaflet fallback, same surface.
//                               opts: route, chips, level, theme, padding, onLevel, onPoi, onReady, and
//                               cover() -> elements over the card that route labels keep clear of (Leaflet)
//
// Endpoints: 'gate:B5' | 'poi:<id>' | 'place:<kind>' (best of that kind for this route) | {pt:[lon,lat], level}.
// Venue data never lives here: it arrives sealed. Location stays in memory.
// Inlined: TinySDF (c) Mapbox, BSD-2-Clause. MapLibre GL JS ships in static/vendor/maplibre with its licence.
(() => {
'use strict';
const W = window, D = document;
const AM = N.airmap = {};

// ---------- constants ----------
const RAD = Math.PI / 180;
const SPEED = {walk: 1.3, outside: 1.3, door: 1.3, moving: 2, stairs: .6};   // metres per second (nav.js)
const FIXED = {escalator: 35, elevator: 75, train: 240, security: 900};      // seconds, unless the edge says
const PRE_SEC = 420;                                                          // a PreCheck lane, seconds
const ONE_WAY = new Set(['security', 'exit']);
const VERT = new Set(['escalator', 'elevator', 'stairs']);
const WALKABLE = new Set(['walk', 'moving', 'door', 'outside', 'security', 'exit']);

// Basic view is the route only. Each chip overlays one family of places.
const CHIP_DEF = [
  {id: 'food', label: 'Food', icon: 'tools-kitchen-2', cats: ['food', 'bar']},
  {id: 'coffee', label: 'Coffee', icon: 'coffee', cats: ['coffee']},
  {id: 'restroom', label: 'Restrooms', icon: 'toilet-paper', cats: ['restroom']},
  {id: 'water', label: 'Water', icon: 'droplet', cats: ['water']},
  {id: 'shop', label: 'Shops', icon: 'shopping-bag', cats: ['shop']},
];
AM.CHIPS = Object.freeze(CHIP_DEF.map(({id, label, icon}) => Object.freeze({id, label, icon})));
const CHIP_OF = {};
for (const c of CHIP_DEF) for (const k of c.cats) CHIP_OF[k] = c.id;
const POI_ICON = {food: 'tools-kitchen-2', bar: 'glass-cocktail', coffee: 'coffee', restroom: 'toilet-paper',
  water: 'droplet', shop: 'shopping-bag'};

// Route endpoints for the From/To pickers, in picker order. POI cat -> place kind.
const PLACE_KINDS = ['curb_dep', 'curb_arr', 'checkin', 'checkpoint', 'precheck', 'baggage', 'rideshare', 'taxi', 'bus',
  'shuttle', 'train', 'subway', 'parking', 'rental_car', 'exit'];
const AA = /\bamerican\b|(^|[^a-z])aa([^a-z]|$)/i;

// ---------- palettes (tokens.css family: cream floors, white corridors, sage route, ink labels) ----------
const THEMES = {
  light: {
    name: 'light',
    bg: '#E6E9E4', foot: '#EEEADD', footLine: '#D5CDB9',
    floor: {terminal: '#F3EFE3', building: '#F3EFE3', landside: '#F3EFE3', checkin: '#F3EFE3', airside: '#F7F4EB',
      concourse: '#F7F4EB', atrium: '#F7F4EB', hall: '#F7F4EB', walkway: '#F7F4EB', food_court: '#F4EEDF',
      baggage: '#EFE9DA', curb: '#E1E2DC', garage: '#DEDFD9', lounge: '#EEE8D8', security: '#EEE8D9'},
    floorLine: '#DBD2BE',
    room: {food: '#F1E5CF', shop: '#EBE4D8', restroom: '#E2E8E8', service: '#ECE7DC', room: '#ECE6DA', lounge: '#E9E4D3',
      baggage: '#ECE5D3', checkin: '#E9E1CE', counter: '#E2D8C2', gatearea: '#E4ECE8', vertical: '#E5DECE',
      void: '#E5E0D3', opentobelow: '#E8E6DF', wall: '#CDC4B0', security: '#EAE3D1'},
    roomLine: '#DAD0BB',
    corr: '#FFFFFF', corrOut: '#F1F0EA', moving: '#D2DED9', train: '#8E9693',
    jet: '#DCD7CA', plane: '#DADDD6', planeLine: '#CBCEC6',
    gateDot: '#7E918D', label: '#16191A', labelMu: '#5F6764', halo: '#F7F4EB', conc: '#4A706D',
    route: '#4A706D', routeCase: '#FFFFFF', chev: '#FFFFFF', routeOther: '#4A706D',
    pin: '#4A706D', pinText: '#FFFFFF', chip: '#FFFFFF',
    you: '#0A84FF', youRing: '#FFFFFF', youAcc: 'rgba(10,132,255,.14)',
    poi: {food: '#B4693F', coffee: '#7C5D49', restroom: '#4F7397', water: '#2E8BB0', shop: '#7D66A0'},
  },
  dark: {
    name: 'dark',
    // Floors sit well clear of the page (--page #121514) so the building reads at a glance;
    // corridors are the lightest surface, as the white ones are in light.
    bg: '#121514', foot: '#1F201C', footLine: '#3A3932',
    floor: {terminal: '#2E2D27', building: '#2E2D27', landside: '#2E2D27', checkin: '#2E2D27', airside: '#34322C',
      concourse: '#34322C', atrium: '#34322C', hall: '#34322C', walkway: '#34322C', food_court: '#36332C',
      baggage: '#35332C', curb: '#252826', garage: '#232625', lounge: '#36342D', security: '#35332C'},
    floorLine: '#4A473F',
    room: {food: '#3E3A33', shop: '#3B3A35', restroom: '#353B3A', service: '#3A3933', room: '#3A3933', lounge: '#393932',
      baggage: '#3B3932', checkin: '#3C3A33', counter: '#423E36', gatearea: '#2F3B3A', vertical: '#403D35',
      void: '#2A2925', opentobelow: '#262826', wall: '#524E45', security: '#3C3932'},
    roomLine: '#4A4840',
    corr: '#4A4943', corrOut: '#353631', moving: '#4A5B57', train: '#7F8784',
    jet: '#3A3934', plane: '#2A2E2D', planeLine: '#3B403E',
    gateDot: '#7FA19C', label: '#EEEBE2', labelMu: '#A9ADA6', halo: '#1E1E1A', conc: '#9CC0BC',
    route: '#9CC0BC', routeCase: '#121514', chev: '#16302D', routeOther: '#9CC0BC',
    pin: '#9CC0BC', pinText: '#121514', chip: '#1A1E1D',
    you: '#0A84FF', youRing: '#FFFFFF', youAcc: 'rgba(10,132,255,.20)',
    poi: {food: '#C98A63', coffee: '#A88672', restroom: '#7E9DBE', water: '#5AAFD0', shop: '#A391C0'},
  },
};

// ---------- geometry ----------
const mPerPx = (z, lat) => 40075016.686 * Math.cos(lat * RAD) / (512 * Math.pow(2, z));
const merc = ([lon, lat]) => [(lon + 180) / 360, (1 - Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2)) / Math.PI) / 2];
const unmerc = ([x, y]) => [x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / RAD];
const dist = (a, b) => {
  const kx = Math.cos((a[1] + b[1]) / 2 * RAD) * 111320;
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110540);
};
function ringCentroid(r) {
  let a = 0, x = 0, y = 0;
  for (let i = 0, n = r.length - 1; i < n; i++) {
    const [x0, y0] = r[i], [x1, y1] = r[i + 1], f = x0 * y1 - x1 * y0;
    a += f; x += (x0 + x1) * f; y += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-14) { const n = r.length; return [r.reduce((s, p) => s + p[0], 0) / n, r.reduce((s, p) => s + p[1], 0) / n]; }
  return [x / (3 * a), y / (3 * a)];
}
function ringArea(r) {
  const kx = Math.cos(r[0][1] * RAD) * 111320, ky = 110540;
  let a = 0;
  for (let i = 0, n = r.length - 1; i < n; i++) a += r[i][0] * kx * r[i + 1][1] * ky - r[i + 1][0] * kx * r[i][1] * ky;
  return Math.abs(a / 2);
}
const fc = features => ({type: 'FeatureCollection', features});
const pt = (p, props) => ({type: 'Feature', properties: props, geometry: {type: 'Point', coordinates: p}});
const ln = (g, props) => ({type: 'Feature', properties: props, geometry: {type: 'LineString', coordinates: g}});
const lprop = (l, o) => (l == null ? o : Object.assign({l}, o));
const EMPTY = fc([]);
const mode = a => { const m = new Map(); let best = a[0], n = 0; for (const x of a) { const c = (m.get(x) || 0) + 1; m.set(x, c); if (c > n) { n = c; best = x; } } return best; };
const shortName = s => String(s || '').replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const natural = (a, b) => String(a).localeCompare(String(b), 'en', {numeric: true});

const FLOOR_K = new Set(['terminal', 'building', 'landside', 'checkin', 'airside', 'concourse', 'atrium', 'hall',
  'walkway', 'food_court', 'baggage', 'curb', 'garage', 'lounge', 'security']);
const FLOOR_ORDER = ['garage', 'curb', 'building', 'terminal', 'landside', 'checkin', 'airside', 'concourse', 'walkway',
  'hall', 'atrium', 'food_court', 'baggage', 'security', 'lounge'];
const ROOM_ORDER = ['void', 'opentobelow', 'room', 'service', 'baggage', 'checkin', 'counter', 'food', 'shop', 'restroom',
  'lounge', 'security', 'gatearea', 'vertical', 'wall'];
const AREA_LABEL = new Set(['atrium', 'food_court', 'baggage', 'garage', 'food', 'shop', 'service', 'checkin',
  'security', 'room']);

// ---------- prep ----------
const prepared = new WeakMap();
function prep(data) {
  let P = prepared.get(data);
  if (P) return P;
  const nodes = new Map();
  for (const n of data.graph.nodes) nodes.set(n[0], {id: n[0], p: [n[1], n[2]], l: n[3]});
  const adj = new Map(), radj = new Map();
  const add = (m, a, v) => { let l = m.get(a); if (!l) m.set(a, l = []); l.push(v); };
  const deg = new Map(), corrEdges = [], secEdges = [];
  for (const r of data.graph.edges) {
    const a = nodes.get(r[0]), b = nodes.get(r[1]);
    if (!a || !b) continue;
    const e = {a: r[0], b: r[1], m: +r[2] || 0, k: r[3], sec: +r[4] || 0, dir: r[5] || ''};
    const f = {from: e.a, to: e.b, e};
    add(adj, e.a, f); add(radj, e.b, f);
    if (!ONE_WAY.has(e.k)) { const g = {from: e.b, to: e.a, e}; add(adj, e.b, g); add(radj, e.a, g); }
    if (e.k === 'security') secEdges.push(e);
    if (WALKABLE.has(e.k) && a.l === b.l) {
      corrEdges.push([a, b, e]);
      deg.set(a.id, (deg.get(a.id) || 0) + 1); deg.set(b.id, (deg.get(b.id) || 0) + 1);
    }
  }
  const gates = (data.gates || []).filter(g => g.p);
  const gateByRef = new Map(gates.map(g => [String(g.ref), g]));
  const pois = (data.pois || []).filter(p => p.p);
  const poiById = new Map(pois.map(p => [p.id, p]));
  const nodePois = new Map();
  for (const p of pois) if (p.node) add(nodePois, p.node, p);
  const levels = new Map((data.levels || []).map(l => [l.id, l]));

  // security lanes: a PreCheck (or CLEAR) lane is a security edge leaving that lane's POI and no checkpoint's
  const at = (id, cat) => (nodePois.get(id) || []).find(p => p.cat === cat);
  const near = (id, cat, max) => {
    const n = nodes.get(id);
    let best = null, bd = max;
    for (const p of pois) {
      if (p.cat !== cat) continue;
      const d = dist(n.p, p.p) + (p.l === n.l ? 0 : 60);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };
  for (const e of secEdges) {
    const cp = at(e.a, 'checkpoint');
    e.lane = !cp && at(e.a, 'precheck') ? 'pre' : !cp && at(e.a, 'clear') ? 'clear' : 'std';
    const named = cp || near(e.a, 'checkpoint', 260);
    e.cp = named ? shortName(named.n) : '';
    e.cpId = named ? named.id : '';
    const lane = e.lane === 'std' ? null : at(e.a, e.lane === 'pre' ? 'precheck' : 'clear');
    e.laneId = lane ? lane.id : '';
    e.hasPre = e.lane === 'std' && !!near(e.a, 'precheck', 120);
  }

  // corridors: walkable same-level edges
  const corr = [];
  for (const [a, b, e] of corrEdges) {
    const spur = (deg.get(a.id) || 0) < 2 || (deg.get(b.id) || 0) < 2;
    corr.push(ln([a.p, b.p], {l: a.l, c: e.k === 'outside' ? 'out' : spur ? 'spur' : 'main'}));
  }
  // floor + room polygons, smaller rooms on top
  const floors = [], rooms = [], foot = [], areaLabels = [];
  for (const u of data.units || []) {
    if (!u.g || !u.g.length || !u.g[0] || u.g[0].length < 4) continue;
    const f = {type: 'Feature', properties: lprop(u.l, {k: u.k}), geometry: {type: 'Polygon', coordinates: u.g}};
    if (u.k === 'footprint' || u.l == null) foot.push(f);
    else if (FLOOR_K.has(u.k)) { f.properties.o = FLOOR_ORDER.indexOf(u.k); floors.push(f); }
    else { f.properties.o = ROOM_ORDER.indexOf(u.k); rooms.push(f); }
    const name = shortName(u.n);
    if (name && u.l != null && AREA_LABEL.has(u.k) && name.length <= 28) {
      const a = ringArea(u.g[0]);
      if (a > 60) areaLabels.push(pt(ringCentroid(u.g[0]), {l: u.l, n: name, k: u.k, a: Math.round(a)}));
    }
  }
  floors.sort((x, y) => x.properties.o - y.properties.o);
  rooms.sort((x, y) => x.properties.o - y.properties.o);
  const lines = [];
  for (const L of data.lines || []) if (L.g && L.g.length > 1) lines.push(ln(L.g, lprop(L.l, {k: L.k, ref: L.ref || ''})));

  // gate points + concourse letters just past each pier tip
  const gateF = gates.map(g => pt(g.p, {l: g.l, ref: String(g.ref), c: g.c || ''}));
  const byC = new Map();
  for (const g of gates) { if (!g.c) continue; (byC.get(g.c) || byC.set(g.c, []).get(g.c)).push(g); }
  const conc = [];
  for (const [c, gs] of byC) {
    const lv = mode(gs.map(g => g.l));
    conc.push(pt(pierTip(gs.filter(g => g.l === lv).map(g => g.p), data.center), {l: lv, t: c.length <= 2 ? c : c.toUpperCase(), big: c.length <= 2 ? 1 : 0}));
  }
  // hold-room tiles where the data maps no gate areas: a band from the main corridor out to each gate door
  const gateAreas = [];
  if (!(data.units || []).some(u => u.k === 'gatearea')) {
    const mains = corr.filter(f => f.properties.c === 'main');
    for (const g of gates) {
      const kx = Math.cos(g.p[1] * RAD) * 111320, ky = 110540;
      let best = null, bd = 50;
      for (const f of mains) {
        if (f.properties.l !== g.l) continue;
        const [a, b] = f.geometry.coordinates;
        const ax = (a[0] - g.p[0]) * kx, ay = (a[1] - g.p[1]) * ky, bx = (b[0] - g.p[0]) * kx, by = (b[1] - g.p[1]) * ky;
        const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
        const t = L2 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / L2)) : 0;
        const qx = ax + vx * t, qy = ay + vy * t, d = Math.hypot(qx, qy);
        if (d < bd) { bd = d; best = [qx, qy]; }
      }
      if (!best || bd < 7) continue;
      const ux = -best[0] / bd, uy = -best[1] / bd, tx = -uy, ty = ux, half = 8.5, a = 3.6, b = bd + 1;
      const q = (s, t) => [g.p[0] + (best[0] + ux * s + tx * t) / kx, g.p[1] + (best[1] + uy * s + ty * t) / ky];
      gateAreas.push({type: 'Feature', properties: {l: g.l}, geometry: {type: 'Polygon', coordinates: [[q(a, -half), q(b, -half), q(b, half), q(a, half), q(a, -half)]]}});
    }
  }
  // one parked aircraft per gate, nose along the stand
  const perGate = new Map();
  for (const s of data.stands || []) {
    if (!s.p) continue;
    let g = gateByRef.get(String(s.ref));
    if (!g) { let best = 90; for (const q of gates) { const d = dist(s.p, q.p); if (d < best) { best = d; g = q; } } }
    if (!g) continue;
    const d = dist(s.p, g.p);
    if (d > 140) continue;
    const cur = perGate.get(g.ref);
    if (!cur || d < cur.d) perGate.set(g.ref, {s, g, d});
  }
  const planes = [], placed = [];
  for (const {s, g} of perGate.values()) {
    const kx = Math.cos(s.p[1] * RAD);
    const [from, to] = s.axis && s.axis.length > 1 ? [s.axis[0], s.axis[s.axis.length - 1]] : [s.p, g.p];
    const rot = Math.atan2((to[0] - from[0]) * kx, to[1] - from[1]) / RAD;
    const back = 20 / 111320, c = [s.p[0] - Math.sin(rot * RAD) * back / kx, s.p[1] - Math.cos(rot * RAD) * back];
    if (placed.some(q => dist(q, c) < 30)) continue;
    placed.push(c);
    planes.push(pt(c, {rot: Math.round(rot)}));
  }
  const poiF = pois.filter(p => CHIP_OF[p.cat]).map(p => pt(p.p, {l: p.l, id: p.id, cat: p.cat, chip: CHIP_OF[p.cat], n: clip(shortName(p.n), 26)}));

  P = {code: data.code, data, nodes, adj, radj, gateByRef, poiById, nodePois, levels,
    geo: {foot: fc(foot), floors: fc(floors), rooms: fc(rooms), corr: fc(corr), lines: fc(lines), gates: fc(gateF),
      conc: fc(conc), planes: fc(planes), pois: fc(poiF), areaLabels: fc(areaLabels), gateAreas: fc(gateAreas)}};
  prepared.set(data, P);
  return P;
}
function pierTip(ps, hub, beyond = 38) {
  const kx = Math.cos(ps[0][1] * RAD) * 111320, ky = 111320;
  const cx = ps.reduce((s, q) => s + q[0], 0) / ps.length, cy = ps.reduce((s, q) => s + q[1], 0) / ps.length;
  if (ps.length < 3) return [cx, cy];
  let sxx = 0, syy = 0, sxy = 0;
  for (const q of ps) { const x = (q[0] - cx) * kx, y = (q[1] - cy) * ky; sxx += x * x; syy += y * y; sxy += x * y; }
  const th = Math.atan2(2 * sxy, sxx - syy) / 2;
  let ux = Math.cos(th), uy = Math.sin(th);
  if (((cx - hub[0]) * kx) * ux + ((cy - hub[1]) * ky) * uy < 0) { ux = -ux; uy = -uy; }
  const ext = Math.max(...ps.map(q => (q[0] - cx) * kx * ux + (q[1] - cy) * ky * uy));
  return [cx + ux * (ext + beyond) / kx, cy + uy * (ext + beyond) / ky];
}
const lvShort = (P, l) => { const x = P.levels.get(l); return x ? x.short : String(l); };

// ---------- routing ----------
function cost(P, v, o) {
  const e = v.e;
  if (o.sf && (e.k === 'stairs' || e.k === 'escalator')) return Infinity;
  if (e.k === 'escalator' && e.dir) {
    const up = P.nodes.get(v.to).l > P.nodes.get(v.from).l;
    if ((e.dir === 'up' && !up) || (e.dir === 'down' && up)) return Infinity;
  }
  if (e.k === 'security') {
    if (o.shut && o.shut.size && (o.shut.has(e.cpId) || o.shut.has(e.laneId))) return Infinity;
    if (e.lane === 'clear') return Infinity;
    if (e.lane === 'pre') return o.tsa === 'pre' ? (e.sec || PRE_SEC) : Infinity;
    return o.tsa === 'pre' && e.hasPre ? Math.min(PRE_SEC, e.sec || PRE_SEC) : (e.sec || FIXED.security);
  }
  if (FIXED[e.k]) return e.sec || FIXED[e.k];
  if (e.sec) return e.sec;
  return e.m / (SPEED[e.k] || 1.3);
}
// single- or multi-source Dijkstra; rev walks edges backwards (distances *to* the sources)
function sssp(P, srcs, o, rev, target) {
  const dd = new Map(), prev = new Map(), H = [];
  const push = (d, n) => { H.push([d, n]); let i = H.length - 1; while (i > 0) { const j = (i - 1) >> 1; if (H[j][0] <= H[i][0]) break; [H[i], H[j]] = [H[j], H[i]]; i = j; } };
  const pop = () => {
    const top = H[0], last = H.pop();
    if (H.length) { H[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < H.length && H[l][0] < H[m][0]) m = l; if (r < H.length && H[r][0] < H[m][0]) m = r; if (m === i) break; [H[i], H[m]] = [H[m], H[i]]; i = m; } }
    return top;
  };
  for (const s of srcs) if (P.nodes.has(s) && !dd.has(s)) { dd.set(s, 0); push(0, s); }
  const G = rev ? P.radj : P.adj;
  while (H.length) {
    const [d, n] = pop();
    if (d > dd.get(n)) continue;
    if (n === target) break;
    for (const v of G.get(n) || []) {
      const c = cost(P, v, o);
      if (!(c < Infinity)) continue;
      const m = rev ? v.from : v.to, nd = d + c, od = dd.get(m);
      if (od === undefined || nd < od) { dd.set(m, nd); prev.set(m, v); push(nd, m); }
    }
  }
  return {dist: dd, prev};
}
function path(P, a, b, o) {
  if (a === b) return {hops: [], sec: 0};
  const r = sssp(P, [a], o, false, b);
  if (!r.prev.has(b)) return null;
  const hops = [];
  for (let n = b; n !== a;) { const v = r.prev.get(n); hops.push({from: v.from, to: v.to, e: v.e, sec: cost(P, v, o)}); n = v.from; }
  hops.reverse();
  return {hops, sec: r.dist.get(b)};
}
function nearestNode(P, p, l) {
  let best = null, bd = Infinity;
  for (const n of P.nodes.values()) {
    if (l != null && n.l !== l) continue;
    if (!(P.adj.get(n.id) || []).length) continue;
    const d = dist(p, n.p);
    if (d < bd) { bd = d; best = n; }
  }
  return best ? {node: best.id, d: bd} : null;
}
const gateStop = g => ({kind: 'gate', ref: String(g.ref), label: `Gate ${g.ref}`, short: `Gate ${g.ref}`, node: g.node, p: g.p, l: g.l});
const poiStop = (q, kind) => ({kind: kind || q.cat, id: q.id, label: shortName(q.n) || q.id, short: clip(shortName(q.n) || q.id, 24),
  node: q.node, p: q.p, l: q.l});
const isAA = q => AA.test(`${q.id} ${q.n || ''} ${q.note || ''}`);

// place kind -> POIs of that kind, AA first
function placePois(P, kind) {
  const cat = kind === 'checkpoint' ? ['checkpoint', 'precheck'] : [kind];
  const out = [];
  for (const q of P.data.pois || []) if (cat.includes(q.cat) && q.p && q.node && P.nodes.has(q.node)) out.push(q);
  return out.sort((a, b) => (isAA(b) - isAA(a)) || natural(shortName(a.n), shortName(b.n)));
}
// candidate stops for an endpoint (several for 'place:<kind>'; each may carry a small penalty in seconds)
function candidates(P, x, o) {
  if (!x) return null;
  if (typeof x === 'object') {
    const p = x.pt || x.p, l = x.level ?? x.l;
    if (x.node && P.nodes.has(x.node)) { const n = P.nodes.get(x.node); return [{kind: 'pt', label: x.label || 'Your location', short: x.label || 'You', node: n.id, p: p || n.p, l: n.l}]; }
    if (!Array.isArray(p)) return null;
    const nn = nearestNode(P, p, P.levels.has(l) ? l : null);
    if (!nn) return null;
    const n = P.nodes.get(nn.node);
    return [{kind: 'pt', label: x.label || 'Your location', short: x.label || 'You', node: n.id, p, l: n.l}];
  }
  const s = String(x), i = s.indexOf(':'), pre = i > 0 ? s.slice(0, i) : '', rest = i > 0 ? s.slice(i + 1) : s;
  const ok = q => q && q.node && P.nodes.has(q.node);
  if (pre === 'gate' || !pre) { const g = P.gateByRef.get(rest); if (ok(g)) return [gateStop(g)]; if (pre) return null; }
  if (pre === 'poi' || !pre) { const q = P.poiById.get(rest); if (ok(q)) return [poiStop(q)]; if (pre) return null; }
  if (pre === 'node') { const n = P.nodes.get(rest); return n ? [{kind: 'node', label: rest, short: rest, node: n.id, p: n.p, l: n.l}] : null; }
  if (pre === 'place' || (!pre && PLACE_KINDS.includes(rest))) {
    let qs = placePois(P, rest);
    if (rest === 'checkpoint' && o.tsa !== 'pre') qs = qs.filter(q => q.cat === 'checkpoint');
    if (o.shut && o.shut.size) { const open = qs.filter(q => !o.shut.has(q.id)); if (open.length) qs = open; }
    if (rest === 'checkin' || rest === 'baggage') {
      const aa = qs.filter(isAA);
      if (aa.length) qs = aa;
      if (rest === 'baggage') { const dom = qs.filter(q => !/intl|international/i.test(`${q.id} ${q.n}`)); if (dom.length) qs = dom; }
    }
    return qs.length ? qs.map(q => Object.assign(poiStop(q, rest), {pen: /priority|premium|first class|oversize/i.test(q.n || '') ? 900 : 0})) : null;
  }
  const n = P.nodes.get(s);
  return n ? [{kind: 'node', label: s, short: s, node: n.id, p: n.p, l: n.l}] : null;
}

function route(P, from, to, opts = {}) {
  if (!P) return null;
  const shut = new Set((Array.isArray(opts.shut) ? opts.shut : []).filter(Boolean));
  // every checkpoint shut (or the only way through is): route as if all were open rather than not at all
  if (shut.size) return route1(P, from, to, opts, shut) || route1(P, from, to, opts, null);
  return route1(P, from, to, opts, null);
}
function route1(P, from, to, opts, shut) {
  const o = {tsa: opts.tsa === 'pre' ? 'pre' : 'std', sf: !!opts.stepFree, shut};
  const raw = [from, ...(opts.via || []), to];
  const cands = raw.map(x => candidates(P, x, o));
  if (cands.some(c => !c || !c.length)) return null;
  // pick the best candidate of each place: cost from the stop before it plus cost on to the next
  const stops = [];
  for (let i = 0; i < raw.length; i++) {
    const cs = cands[i];
    if (cs.length === 1) { stops.push(cs[0]); continue; }
    const df = i > 0 ? sssp(P, [stops[i - 1].node], o, false) : null;
    const dr = i < raw.length - 1 ? sssp(P, cands[i + 1].map(c => c.node), o, true) : null;
    let best = null, bc = Infinity;
    for (const c of cs) {
      const v = (df ? df.dist.get(c.node) ?? Infinity : 0) + (dr ? dr.dist.get(c.node) ?? Infinity : 0) + (c.pen || 0);
      if (v < bc) { bc = v; best = c; }
    }
    if (!best) return null;
    stops.push(best);
  }
  const hops = [], stopAt = new Map();
  let sec = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    const r = path(P, stops[i].node, stops[i + 1].node, o);
    if (!r) return null;
    hops.push(...r.hops); sec += r.sec;
    if (i < stops.length - 2) stopAt.set(hops.length, stops[i + 1]);
  }
  const runs = [], trans = [];
  let cur = null;
  hops.forEach(h => {
    const a = P.nodes.get(h.from), b = P.nodes.get(h.to);
    if (VERT.has(h.e.k) || a.l !== b.l) {
      trans.push({kind: VERT.has(h.e.k) ? h.e.k : h.e.k === 'train' ? 'train' : 'stairs', from: a.l, to: b.l, p: a.p, p2: b.p, sec: h.sec});
      cur = null;
    } else {
      const md = h.e.k === 'train' ? 'train' : h.e.k === 'outside' ? 'outside' : 'walk';
      if (!cur || cur.l !== a.l || cur.mode !== md) { cur = {l: a.l, mode: md, coords: [a.p], m: 0, sec: 0}; runs.push(cur); }
      cur.coords.push(b.p); cur.m += h.e.m; cur.sec += h.sec;
    }
  });
  const A = stops[0], B = stops[stops.length - 1];
  if (runs.length) {
    const f = runs[0], z = runs[runs.length - 1];
    if (f.l === A.l && dist(f.coords[0], A.p) > 1) f.coords.unshift(A.p);
    if (z.l === B.l && dist(z.coords[z.coords.length - 1], B.p) > 1) z.coords.push(B.p);
  }
  const m = Math.round(hops.reduce((s, h) => s + (VERT.has(h.e.k) ? 0 : h.e.m), 0));
  const levels = [];
  for (const l of [A.l, ...hops.map(h => P.nodes.get(h.to).l)]) if (levels[levels.length - 1] !== l && !levels.includes(l)) levels.push(l);
  const s = Math.round(sec);
  return {from: A, to: B, via: stops.slice(1, -1), m, s, mins: hops.length ? Math.max(1, Math.round(s / 60)) : 0, levels,
    steps: steps(P, A, B, hops, stopAt), tsa: o.tsa, runs, trans, hops, code: P.code};
}

// ---------- steps ----------
const fmtM = m => m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`;
const vertWord = k => (k === 'elevator' ? 'the elevator' : k === 'stairs' ? 'the stairs' : 'the escalator');
const isCp = s => /^checkpoint\b/i.test(s);
function steps(P, A, B, hops, stopAt) {
  // segments: walk (incl. doors and outside) | moving | escalator | elevator | stairs | train | security | exit
  const segs = [];
  let seg = null;
  hops.forEach((h, i) => {
    const a = P.nodes.get(h.from), b = P.nodes.get(h.to), k = h.e.k;
    const t = VERT.has(k) || (a.l !== b.l && k !== 'train') ? (VERT.has(k) ? k : 'stairs')
      : k === 'security' || k === 'exit' || k === 'train' || k === 'moving' ? k : 'walk';
    const vert = VERT.has(t);
    const join = seg && seg.t === t && !seg.stop && t !== 'security' && t !== 'exit'
      && (!vert || (b.l > a.l) === seg.up);
    if (!join) { seg = {t, l: a.l, l2: b.l, m: 0, s: 0, out: 0, mv: 0, rides: 0, hops: [], up: b.l > a.l}; segs.push(seg); }
    if (vert && (t !== 'elevator' || !seg.rides)) seg.rides++;
    seg.l2 = b.l; seg.m += vert ? 0 : h.e.m; seg.s += h.sec; seg.hops.push(h);
    if (k === 'outside') seg.out += h.e.m;
    if (stopAt.has(i + 1)) seg.stop = stopAt.get(i + 1);
  });
  // a few steps between two rides the same way is one ride ("Take the escalators up to Level 4")
  for (let i = segs.length - 2; i > 0; i--) {
    const g = segs[i], a = segs[i - 1], b = segs[i + 1];
    if (g.t === 'walk' && g.m < 30 && !g.stop && !a.stop && VERT.has(a.t) && a.t === b.t && a.up === b.up) {
      a.l2 = b.l2; a.s += g.s + b.s; a.rides += b.rides; a.hops.push(...g.hops, ...b.hops); a.stop = b.stop; segs.splice(i, 2);
    }
  }
  // moving walkways shorter than a real ride fold into the walk around them
  for (const g of segs) if (g.t === 'moving' && g.m < 150) { g.t = 'walk'; g.mv = 1; }
  for (let i = segs.length - 1; i > 0; i--) {
    const g = segs[i], a = segs[i - 1];
    if (g.t === 'walk' && a.t === 'walk' && !a.stop) {
      a.m += g.m; a.s += g.s; a.out += g.out; a.mv += g.mv; a.hops.push(...g.hops); a.stop = g.stop; a.l2 = g.l2; segs.splice(i, 1);
    }
  }
  const lv = l => `Level ${lvShort(P, l)}`;
  const poiAt = (node, cat) => (P.nodePois.get(node) || []).find(q => q.cat === cat);
  const target = (g, i) => {
    if (g.stop) return g.stop.label;
    const nx = segs[i + 1];
    if (!nx) return B.label;
    if (VERT.has(nx.t)) return vertWord(nx.t);
    if (nx.t === 'security') { const cp = nx.hops[0].e.cp; return cp && isCp(cp) ? cp : 'security'; }
    if (nx.t === 'exit') return 'the exit';
    if (nx.t === 'train') { const q = poiAt(nx.hops[0].from, 'train'); return q ? shortName(q.n) : 'the train'; }
    if (nx.t === 'moving') return 'the moving walkway';
    return B.label;
  };
  const out = [{kind: 'start', text: `Start at ${A.kind === 'pt' ? 'your location' : A.label}`, level: A.l, m: 0, s: 0}];
  segs.forEach((g, i) => {
    const base = {level: g.l, m: Math.round(g.m), s: Math.round(g.s)};
    const last = i === segs.length - 1;
    if (g.t === 'walk') {
      if (g.m < 4 && !g.stop && !last) return;
      if (g.m < 20 && last && i > 0 && !g.stop) return;   // "Arrive at" says it
      const how = g.m < 20 ? 'Walk a few steps' : `Walk ${fmtM(g.m)}${g.out > g.m / 2 ? ' outside' : ''}`;
      const mv = g.mv && g.m >= 20 ? `, using ${g.mv > 1 ? `${g.mv} moving walkways` : 'the moving walkway'}` : '';
      out.push(Object.assign(base, {kind: 'walk', text: `${how} to ${target(g, i)}${mv}`}, g.stop ? {via: g.stop.id || g.stop.ref || ''} : {}));
    } else if (g.t === 'moving') {
      out.push(Object.assign(base, {kind: 'moving', text: `Take the moving walkway, ${fmtM(g.m)}`}));
    } else if (VERT.has(g.t)) {
      const what = g.rides > 1 && g.t !== 'elevator' ? vertWord(g.t) + 's' : vertWord(g.t);
      out.push(Object.assign(base, {kind: g.t, to: g.l2, text: `Take ${what} ${g.l2 > g.l ? 'up' : 'down'} to ${lv(g.l2)}`}));
    } else if (g.t === 'train') {
      const q = poiAt(g.hops[g.hops.length - 1].to, 'train');
      out.push(Object.assign(base, {kind: 'train', text: `Ride the train${q ? ` to ${shortName(q.n)}` : ''}`}));
    } else if (g.t === 'security') {
      const e = g.hops[0].e, cp = e.cp && isCp(e.cp) ? e.cp : '';
      const pre = e.lane === 'pre' || (e.hasPre && g.s <= PRE_SEC);
      out.push(Object.assign(base, {kind: 'security', pre, cp, text: `Pass security${cp ? ` at ${cp}` : ''}${pre ? ' (TSA PreCheck)' : ''}`}));
    } else if (g.t === 'exit') {
      out.push(Object.assign(base, {kind: 'exit', text: 'Leave the secure area (no way back without security)'}));
    }
    if (g.stop && g.t !== 'walk') out.push({kind: 'walk', text: `Continue to ${g.stop.label}`, level: g.l2, m: 0, s: 0, via: g.stop.id || g.stop.ref || ''});
  });
  out.push({kind: 'arrive', text: `Arrive at ${B.kind === 'pt' ? 'your location' : B.label}`, level: B.l, m: 0, s: 0});
  return out;
}

// ---------- pickers ----------
function places(P) {
  if (!P) return [];
  if (P.placeList) return P.placeList;
  const out = [];
  for (const kind of PLACE_KINDS) {
    if (kind === 'precheck') continue;
    for (const q of placePois(P, kind)) {
      const pre = q.cat === 'precheck';
      out.push({id: q.id, kind, label: shortName(q.n) || q.id, level: q.l, node: q.node, ep: 'poi:' + q.id,
        aa: isAA(q) || undefined, pre: pre || undefined});
    }
  }
  return (P.placeList = out);
}
function gates(P) {
  if (!P) return [];
  return P.gateList || (P.gateList = [...P.gateByRef.values()].filter(g => g.node && P.nodes.has(g.node))
    .map(g => ({ref: String(g.ref), level: g.l, concourse: g.c || ''}))
    .sort((a, b) => natural(a.concourse, b.concourse) || natural(a.ref, b.ref)));
}
function nearest(P, p, level) {
  if (!P || !Array.isArray(p)) return null;
  const nn = nearestNode(P, p, P.levels.has(level) ? level : null);
  if (!nn) return null;
  const n = P.nodes.get(nn.node);
  let label = '', bd = 35;
  for (const g of P.gateByRef.values()) if (g.l === n.l) { const d = dist(g.p, n.p); if (d < bd) { bd = d; label = `Gate ${g.ref}`; } }
  if (!label) {
    bd = 25;
    for (const q of P.data.pois || []) {
      if (!q.p || q.l !== n.l || VERT.has(q.cat)) continue;
      const d = dist(q.p, n.p);
      if (d < bd) { bd = d; label = shortName(q.n); }
    }
  }
  return {node: n.id, level: n.l, dist_m: Math.round(nn.d), label: label || `Level ${lvShort(P, n.l)}`};
}
function poisAlong(P, R, chipIds, limit = 8) {
  if (!P || !R || !R.hops) return [];
  const on = new Set(chipIds || []);
  const o = {tsa: R.tsa || 'std'};
  const nodes = new Set([R.from.node, ...R.hops.map(h => h.to)]);
  const fw = sssp(P, nodes, o, false), bw = sssp(P, nodes, o, true);
  const lvls = new Set(R.levels);
  const out = [];
  for (const q of P.data.pois || []) {
    if (!q.node || !on.has(CHIP_OF[q.cat]) || !lvls.has(q.l)) continue;
    const a = fw.dist.get(q.node), b = bw.dist.get(q.node);
    if (a == null || b == null) continue;
    const det = a + b;
    if (det > 900) continue;
    let near = q.near || '';
    if (!near) {
      let bd = 80;
      for (const g of P.gateByRef.values()) if (g.l === q.l) { const d = dist(g.p, q.p); if (d < bd) { bd = d; near = `Gate ${g.ref}`; } }
    }
    out.push({id: q.id, name: shortName(q.n), cat: q.cat, level: q.l, near, detour_min: Math.round(det / 60), _d: det});
  }
  out.sort((x, y) => x._d - y._d);
  return out.slice(0, limit).map(x => { delete x._d; return x; });
}

// ---------- load ----------
const loads = {};
AM.load = code => {
  const k = String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!k) return Promise.resolve(null);
  return loads[k] || (loads[k] = Promise.resolve(N.sealed('indoor_' + k)).then(d => {
    if (!d || !d.graph || !d.levels) { delete loads[k]; return null; }
    return prep(d);
  }).catch(e => { delete loads[k]; N.report(e, 'airmap ' + k); return null; }));
};
Object.assign(AM, {places, gates, route, nearest, poisAlong, prep});

// ---------- camera ----------
// Fit [lon, lat] points into a box {w, h}. bearing 'route': search for the largest scale, preferring start-below-end.
// o.ext[i] = [left, right, up, down] screen pixels that point i's pin or label needs; o.ends = [start, end] indices
function frame(pts, box, o = {}) {
  const M = pts.map(merc), E = o.ext || [], [i0, i1] = o.ends || [0, pts.length - 1];
  const cx = M.reduce((s, p) => s + p[0], 0) / M.length, cy = M.reduce((s, p) => s + p[1], 0) / M.length;
  const fit = b => {
    const c = Math.cos(b * RAD), s = Math.sin(b * RAD);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const S = M.map(([x, y]) => { const dx = x - cx, dy = y - cy; return [dx * c + dy * s, -dx * s + dy * c]; });
    for (const [x, y] of S) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    let k = Math.min(box.w / Math.max(x1 - x0, 1e-12), box.h / Math.max(y1 - y0, 1e-12));
    let sx = (x0 + x1) / 2, sy = (y0 + y1) / 2;
    if (E.length) {
      // the largest scale at which every point plus its pixel room fits, then centre that padded extent
      const span = (kk, ax) => {
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < S.length; i++) {
          const e = E[i], v = S[i][ax] * kk;
          lo = Math.min(lo, v - (e ? e[ax * 2] : 0)); hi = Math.max(hi, v + (e ? e[ax * 2 + 1] : 0));
        }
        return [lo, hi];
      };
      const fits = kk => { const X = span(kk, 0), Y = span(kk, 1); return X[1] - X[0] <= box.w && Y[1] - Y[0] <= box.h; };
      if (!fits(k)) {
        let a = 0, z = k;
        for (let i = 0; i < 26; i++) { const m = (a + z) / 2; if (fits(m)) a = m; else z = m; }
        k = a || k / 2;
      }
      const X = span(k, 0), Y = span(k, 1);
      sx = (X[0] + X[1]) / 2 / k; sy = (Y[0] + Y[1]) / 2 / k;
    }
    const up = S[i0][1] - S[i1][1];
    return {b, k, up, center: unmerc([cx + sx * c - sy * s, cy + sx * s + sy * c])};
  };
  let best;
  if (o.bearing === 'route') {
    for (let b = -180; b < 180; b += 5) {
      const f = fit(b);
      const score = f.k * (f.up > 0 ? 1 : .8) * (1 - Math.abs(b) / 1800);
      if (!best || score > best.score) best = Object.assign(f, {score});
    }
  } else best = fit(o.bearing || 0);
  return {center: best.center, zoom: Math.min(o.maxZoom || 20, Math.log2(best.k / 512)), bearing: best.b};
}
// the pixel room a route's pins and labels need, so a fit keeps them inside the card: [[lon,lat], [l, r, up, down], level]
function routeRoom(P, R) {
  const out = [];
  for (const f of routeGeo(P, R).points.features) {
    const q = f.properties, p = f.geometry.coordinates;
    if (q.role === 'end') { const w = measure(q.label || '', '650 13.5px Inter') + 28; out.push([p, [w / 2, w / 2, 42, 4], q.l]); }
    else if (q.role === 'start' || q.role === 'via') {
      const tw = q.label ? measure(q.label, '600 12.5px Inter') : 0, w = Math.max(24, Math.min(tw, 128));
      out.push([p, [w / 2, w / 2, 12, tw ? 20 + 16 * Math.ceil(tw / 128) : 12], q.l]);
    } else if (q.role === 'trans') { const w = measure(q.label || '', '650 12.5px Inter') + 44; out.push([p, [w / 2, w / 2, 17, 17], q.l]); }
  }
  return out;
}
const concRoom = f => {
  const q = f.properties, w = q.big ? 30 : measure(q.t, '700 12px Inter') * 1.15 + 6;
  return [w / 2, w / 2, q.big ? 16 : 10, q.big ? 16 : 10];
};
function routeGeo(P, r) {
  if (!r) return {lines: EMPTY, points: EMPTY};
  const lines = r.runs.filter(x => x.coords.length > 1).map((x, i) => ln(x.coords, {l: x.l, mode: x.mode, i}));
  const points = [];
  r.trans.forEach((t, i) => {
    const up = t.to > t.from;
    points.push(pt(t.p, {role: 'trans', l: t.from, to: t.to, kind: t.kind, up: up ? 1 : 0, label: `${up ? 'Up' : 'Down'} to ${lvShort(P, t.to)}`, i}));
    points.push(pt(t.p2, {role: 'arrive', l: t.to, from: t.from, to: t.from, kind: t.kind, up: up ? 1 : 0, label: '', i}));
  });
  // consecutive escalator hops: only the first departure and the last arrival keep a marker
  const keep = points.filter((f, i) => {
    const q = f.properties, t = r.trans[q.i];
    if (q.role === 'trans') { const pv = r.trans[q.i - 1]; return !(pv && pv.to === t.from && pv.kind === t.kind && dist(pv.p2, t.p) < 30); }
    const nx = r.trans[q.i + 1];
    return !(nx && nx.from === t.to && nx.kind === t.kind && dist(t.p2, nx.p) < 30);
  });
  // a departure marker names the level the whole ride ends on
  for (const f of keep) {
    const q = f.properties;
    if (q.role !== 'trans') continue;
    let j = q.i;
    while (r.trans[j + 1] && r.trans[j + 1].from === r.trans[j].to && r.trans[j + 1].kind === r.trans[j].kind && dist(r.trans[j].p2, r.trans[j + 1].p) < 30) j++;
    if (j !== q.i) { q.to = r.trans[j].to; q.label = `${q.up ? 'Up' : 'Down'} to ${lvShort(P, q.to)}`; }
  }
  r.via.forEach((v, i) => keep.push(pt(v.p, {role: 'via', l: v.l, label: v.short, i})));
  keep.push(pt(r.from.p, {role: 'start', l: r.from.l, label: r.from.kind === 'pt' ? '' : r.from.short, ref: r.from.ref || ''}));
  keep.push(pt(r.to.p, {role: 'end', l: r.to.l, label: r.to.kind === 'pt' ? 'You' : r.to.short, ref: r.to.ref || ''}));
  return {lines: fc(lines), points: fc(keep)};
}

// ---------- canvas images (both renderers) ----------
const PR = () => Math.max(2, Math.min(3, Math.ceil(W.devicePixelRatio || 1)));
function iconSvg(name, color, size = 96) {
  const sym = D.getElementById('i-' + name);
  if (!sym) return null;
  const vb = sym.getAttribute('viewBox') || '0 0 24 24';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${size}" height="${size}">${sym.innerHTML.replace(/currentColor/g, color)}</svg>`;
}
const iconCache = new Map();
function iconImage(name, color) {
  const key = name + '|' + color;
  if (!iconCache.has(key)) iconCache.set(key, (async () => {
    const svg = iconSvg(name, color);
    if (!svg) return null;
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    try { await img.decode(); } catch (e) { return null; }
    return img;
  })());
  return iconCache.get(key);
}
const canvas = (w, h) => { const c = D.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h); return c; };
const rr = (x, a, b, w, h, r) => { x.beginPath(); if (x.roundRect) x.roundRect(a, b, w, h, r); else x.rect(a, b, w, h); };
const out = (c, pr) => ({width: c.width, height: c.height, data: new Uint8Array(c.getContext('2d').getImageData(0, 0, c.width, c.height).data.buffer), pixelRatio: pr});
function badge(icon, fill, pr, size = 24) {
  const S = Math.round(size * pr), c = canvas(S, S), x = c.getContext('2d');
  x.fillStyle = '#FFFFFF'; x.beginPath(); x.arc(S / 2, S / 2, S / 2, 0, 7); x.fill();
  x.fillStyle = fill; x.beginPath(); x.arc(S / 2, S / 2, S / 2 - 1.5 * pr, 0, 7); x.fill();
  if (icon) { const g = S * .56; x.drawImage(icon, (S - g) / 2, (S - g) / 2, g, g); }
  return out(c, pr);
}
function pill(text, o, pr) {
  const fs = (o.size || 13) * pr, padX = (o.padX ?? 9) * pr, H = Math.round((o.h || 26) * pr), tail = o.tail ? 6 * pr : 0;
  const font = `${o.weight || 650} ${fs}px Inter, system-ui, sans-serif`;
  const m = canvas(1, 1).getContext('2d'); m.font = font;
  const iw = o.icon ? H * .62 : 0, gap = o.icon && text ? 5 * pr : 0;
  const W2 = Math.round(Math.max(H, padX * 2 + iw + gap + (text ? m.measureText(text).width : 0)));
  const sh = 3 * pr, c = canvas(W2 + sh * 2, H + tail + sh * 2), x = c.getContext('2d');
  x.translate(sh, sh * .6);
  x.shadowColor = 'rgba(0,0,0,.22)'; x.shadowBlur = 4 * pr; x.shadowOffsetY = 1 * pr;
  x.fillStyle = o.fill;
  rr(x, 0, 0, W2, H, H / 2); x.fill();
  if (tail) { x.fillStyle = o.tailFill || o.fill; x.beginPath(); x.moveTo(W2 / 2 - tail, H - 1); x.lineTo(W2 / 2, H + tail); x.lineTo(W2 / 2 + tail, H - 1); x.fill(); }
  x.shadowColor = 'transparent';
  if (o.stroke) { x.lineWidth = 1.5 * pr; x.strokeStyle = o.stroke; rr(x, .75 * pr, .75 * pr, W2 - 1.5 * pr, H - 1.5 * pr, H / 2); x.stroke(); }
  let tx = padX;
  if (o.icon) { x.drawImage(o.icon, tx - 1 * pr, (H - iw) / 2, iw, iw); tx += iw + gap; }
  if (text) { x.fillStyle = o.color; x.font = font; x.textBaseline = 'middle'; x.fillText(text, o.icon ? tx : (W2 - m.measureText(text).width) / 2, H / 2 + .5 * pr); }
  return out(c, pr);
}
function dot(o, pr) {
  const S = Math.round((o.size || 18) * pr), c = canvas(S + 6 * pr, S + 6 * pr), x = c.getContext('2d'), C = c.width / 2;
  x.shadowColor = 'rgba(0,0,0,.25)'; x.shadowBlur = 3 * pr; x.shadowOffsetY = .5 * pr;
  x.fillStyle = o.ring; x.beginPath(); x.arc(C, C, S / 2, 0, 7); x.fill();
  x.shadowColor = 'transparent';
  x.fillStyle = o.fill; x.beginPath(); x.arc(C, C, S / 2 - (o.ringW || 4) * pr, 0, 7); x.fill();
  return out(c, pr);
}
function chevron(pr, color) {
  const S = Math.round(12 * pr), c = canvas(S, S), x = c.getContext('2d'), m = S / 2, u = pr;
  x.strokeStyle = color; x.lineWidth = 1.7 * u; x.lineCap = 'round'; x.lineJoin = 'round';
  x.beginPath(); x.moveTo(m - 1.6 * u, m - 2.8 * u); x.lineTo(m + 1.5 * u, m); x.lineTo(m - 1.6 * u, m + 2.8 * u); x.stroke();
  return out(c, pr);
}
const PLANE_D = 'M32 2C35 2 35.4 7 35.4 12L35.4 24 61 36 61 39.5 35.4 34.5 35 50 44 56 44 58.5 33.4 56.5 32 62 30.6 56.5 20 58.5 20 56 29 50 28.6 34.5 3 39.5 3 36 28.6 24 28.6 12C28.6 7 29 2 32 2Z';
function plane(fill, line, pr) {
  const S = Math.round(64 * pr), c = canvas(S, S), x = c.getContext('2d');
  x.scale(S / 64, S / 64);
  x.fillStyle = fill; x.strokeStyle = line; x.lineWidth = .8; x.lineJoin = 'round';
  const p = new Path2D(PLANE_D); x.fill(p); x.stroke(p);
  return out(c, pr);
}
const VERT_ICON = {escalator: ['escalator-up', 'escalator-down'], elevator: ['elevator', 'elevator'],
  stairs: ['stairs', 'stairs'], train: ['train', 'train']};

// ---------- offline glyphs (TinySDF, inlined: (c) Mapbox, BSD-2-Clause) ----------
const INF = 1e20;
class TinySDF {
  constructor({fontSize = 24, buffer = 3, radius = 8, cutoff = .25, fontFamily = 'sans-serif', fontWeight = 'normal'} = {}) {
    this.buffer = buffer; this.cutoff = cutoff; this.radius = radius;
    const size = this.size = fontSize + buffer * 4;
    const c = canvas(size, size);
    const ctx = this.ctx = c.getContext('2d', {willReadFrequently: true});
    ctx.font = `normal ${fontWeight} ${fontSize}px ${fontFamily}`;
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'; ctx.fillStyle = 'black';
    this.gridOuter = new Float64Array(size * size); this.gridInner = new Float64Array(size * size);
    this.f = new Float64Array(size); this.z = new Float64Array(size + 1); this.v = new Uint16Array(size);
  }
  draw(ch) {
    const mt = this.ctx.measureText(ch);
    const glyphAdvance = mt.width, glyphTop = Math.ceil(mt.actualBoundingBoxAscent), glyphLeft = 0;
    const glyphWidth = Math.max(0, Math.min(this.size - this.buffer, Math.ceil(mt.actualBoundingBoxRight - mt.actualBoundingBoxLeft)));
    const glyphHeight = Math.min(this.size - this.buffer, glyphTop + Math.ceil(mt.actualBoundingBoxDescent));
    const width = glyphWidth + 2 * this.buffer, height = glyphHeight + 2 * this.buffer;
    const len = Math.max(width * height, 0), data = new Uint8ClampedArray(len);
    const glyph = {data, width, height, glyphWidth, glyphHeight, glyphTop, glyphLeft, glyphAdvance};
    if (glyphWidth === 0 || glyphHeight === 0) return glyph;
    const {ctx, buffer, gridInner, gridOuter} = this;
    ctx.clearRect(buffer, buffer, glyphWidth, glyphHeight);
    ctx.fillText(ch, buffer, buffer + glyphTop);
    const img = ctx.getImageData(buffer, buffer, glyphWidth, glyphHeight);
    gridOuter.fill(INF, 0, len); gridInner.fill(0, 0, len);
    for (let y = 0; y < glyphHeight; y++) {
      for (let x = 0; x < glyphWidth; x++) {
        const a = img.data[4 * (y * glyphWidth + x) + 3] / 255;
        if (a === 0) continue;
        const j = (y + buffer) * width + x + buffer;
        if (a === 1) { gridOuter[j] = 0; gridInner[j] = INF; } else { const d = .5 - a; gridOuter[j] = d > 0 ? d * d : 0; gridInner[j] = d < 0 ? d * d : 0; }
      }
    }
    edt(gridOuter, 0, 0, width, height, width, this.f, this.v, this.z);
    edt(gridInner, buffer, buffer, glyphWidth, glyphHeight, width, this.f, this.v, this.z);
    for (let i = 0; i < len; i++) { const d = Math.sqrt(gridOuter[i]) - Math.sqrt(gridInner[i]); data[i] = Math.round(255 - 255 * (d / this.radius + this.cutoff)); }
    return glyph;
  }
}
function edt(data, x0, y0, width, height, gridSize, f, v, z) {
  for (let x = x0; x < x0 + width; x++) edt1d(data, y0 * gridSize + x, gridSize, height, f, v, z);
  for (let y = y0; y < y0 + height; y++) edt1d(data, y * gridSize + x0, 1, width, f, v, z);
}
function edt1d(grid, offset, stride, length, f, v, z) {
  v[0] = 0; z[0] = -INF; z[1] = INF; f[0] = grid[offset];
  for (let q = 1, k = 0, s = 0; q < length; q++) {
    f[q] = grid[offset + q * stride];
    const q2 = q * q;
    do { const r = v[k]; s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2; } while (s <= z[k] && --k > -1);
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < length; q++) { while (z[k + 1] < q) k++; const r = v[k], qr = q - r; grid[offset + q * stride] = f[r] + qr * qr; }
}
// style.glyphs = 'airglyph://{fontstack}/{range}', answered with PBF glyph ranges drawn from Inter. No network.
const WEIGHT = {Regular: 400, Medium: 500, SemiBold: 600, Bold: 700};
let glyphsOn = false;
function glyphProtocol(ml) {
  if (glyphsOn) return;
  glyphsOn = true;
  const sdfs = new Map(), done = new Map();
  ml.addProtocol('airglyph', async params => {
    const m = /^airglyph:\/\/([^/]+)\/(\d+)-(\d+)/.exec(params.url);
    const stack = decodeURIComponent(m[1]), start = +m[2], end = +m[3], key = `${stack}/${start}`;
    if (!done.has(key)) done.set(key, (async () => {
      const w = WEIGHT[stack.split(',')[0].trim().split(' ').pop()] || 500;
      if (D.fonts && D.fonts.load) { try { await D.fonts.load(`${w} 24px Inter`); } catch (e) { /* system font then */ } }
      let sdf = sdfs.get(w);
      if (!sdf) sdfs.set(w, sdf = new TinySDF({fontSize: 24, buffer: 3, radius: 8, cutoff: .25, fontFamily: 'Inter, system-ui, sans-serif', fontWeight: w}));
      const gs = [];
      for (let id = start; id <= end; id++) {
        if (id < 32 || (id >= 127 && id < 160)) continue;
        const g = sdf.draw(String.fromCharCode(id));
        gs.push({id, bitmap: g.glyphWidth && g.glyphHeight ? g.data : null, width: g.glyphWidth, height: g.glyphHeight,
          left: g.glyphLeft, top: g.glyphTop - 27, advance: Math.round(g.glyphAdvance)});
      }
      return encodeGlyphs(stack, `${start}-${end}`, gs);
    })());
    const buf = await done.get(key);
    return {data: buf.slice(0)};
  });
}
class PW {
  constructor() { this.b = []; }
  v(n) { while (n > 127) { this.b.push((n & 127) | 128); n = Math.floor(n / 128); } this.b.push(n); }
  u(f, n) { this.v(f << 3); this.v(n); }
  s(f, n) { this.v(f << 3); this.v(n < 0 ? -2 * n - 1 : 2 * n); }
  bytes(f, a) { this.v(f << 3 | 2); this.v(a.length); for (let i = 0; i < a.length; i++) this.b.push(a[i]); }
  str(f, s) { this.bytes(f, new TextEncoder().encode(s)); }
}
function encodeGlyphs(name, range, glyphs) {
  const st = new PW();
  st.str(1, name); st.str(2, range);
  for (const g of glyphs) {
    const w = new PW();
    w.u(1, g.id);
    if (g.bitmap) w.bytes(2, g.bitmap);
    w.u(3, g.width); w.u(4, g.height); w.s(5, g.left); w.s(6, g.top); w.u(7, g.advance);
    st.bytes(3, w.b);
  }
  const top = new PW();
  top.bytes(1, st.b);
  return new Uint8Array(top.b).buffer;
}

// ---------- library loading ----------
AM.vendor = 'vendor/maplibre/';
let mlLoad = null;
const loadML = () => mlLoad || (mlLoad = new Promise((res, rej) => {
  if (W.maplibregl) { res(W.maplibregl); return; }
  const css = D.createElement('link'); css.rel = 'stylesheet'; css.href = AM.vendor + 'maplibre-gl.css'; D.head.appendChild(css);
  const s = D.createElement('script'); s.src = AM.vendor + 'maplibre-gl.js';
  s.onload = () => (W.maplibregl ? res(W.maplibregl) : rej(new Error('map library missing')));
  s.onerror = () => { mlLoad = null; rej(new Error('map library did not load')); };
  D.head.appendChild(s);
}));
let glOK = null;
function webgl() {
  if (glOK != null) return glOK;
  try {
    const c = D.createElement('canvas'), g = c.getContext('webgl2') || c.getContext('webgl');
    glOK = !!g;
    const x = g && g.getExtension('WEBGL_lose_context');
    if (x) x.loseContext();
  } catch (e) { glOK = false; }
  return glOK;
}

// ---------- GL renderer ----------
const FM = ['Inter Medium'], FS = ['Inter SemiBold'], FB = ['Inter Bold'];
const S = id => 'am-' + id;
// metre-true widths: pixels double with each zoom step, from a whole-airport view (12) to the closest (22)
const metres = (m, lat) => ['interpolate', ['exponential', 2], ['zoom'], 12, m / mPerPx(12, lat), 22, m / mPerPx(22, lat)];
const metresBy = (a, b) => ['interpolate', ['exponential', 2], ['zoom'], 12, a, 22, b];
const lv = level => ['==', ['get', 'l'], level];
const ROUTE_W = ['interpolate', ['exponential', 1.5], ['zoom'], 14, 4, 16, 6.2, 18, 9, 20, 14];
const CASE_W = ['interpolate', ['exponential', 1.5], ['zoom'], 14, 6.5, 16, 9.2, 18, 13, 20, 19];
function specs(lat) {
  const roomColor = T => ['match', ['get', 'k'], ...Object.entries(T.room).flat(), T.room.room];
  const floorColor = T => ['match', ['get', 'k'], ...Object.entries(T.floor).flat(), T.floor.terminal];
  return [
    {id: 'planes', type: 'symbol', source: 'planes', minzoom: 16.4,
      layout: T => ({'icon-image': `am-plane-${T.name}`, 'icon-rotate': ['get', 'rot'], 'icon-rotation-alignment': 'map',
        'icon-size': metres(46 / 64, lat), 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-padding': 0}),
      paint: () => ({'icon-opacity': ['interpolate', ['linear'], ['zoom'], 16.4, 0, 17.2, 1]})},
    {id: 'jet', type: 'line', source: 'lines', minzoom: 15,
      filter: l => ['all', ['==', ['get', 'k'], 'jetbridge'], ['any', ['!', ['has', 'l']], lv(l)]],
      layout: () => ({'line-cap': 'round'}), paint: T => ({'line-color': T.jet, 'line-width': metres(3.2, lat)})},
    {id: 'foot', type: 'fill', source: 'foot', paint: T => ({'fill-color': T.foot, 'fill-antialias': true})},
    {id: 'foot-line', type: 'line', source: 'foot', paint: T => ({'line-color': T.footLine, 'line-width': 1})},
    {id: 'floor', type: 'fill', source: 'floors', filter: l => lv(l), paint: T => ({'fill-color': floorColor(T)})},
    {id: 'floor-line', type: 'line', source: 'floors', filter: l => lv(l),
      paint: T => ({'line-color': T.floorLine, 'line-width': ['interpolate', ['linear'], ['zoom'], 15, .6, 19, 1.2]})},
    {id: 'gate-area', type: 'fill', source: 'gateAreas', minzoom: 15.4, filter: l => lv(l),
      paint: T => ({'fill-color': T.room.gatearea, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 15.4, 0, 16.2, 1]})},
    {id: 'corr', type: 'line', source: 'corr', filter: l => ['all', lv(l), ['!=', ['get', 'c'], 'spur']],
      layout: () => ({'line-cap': 'round', 'line-join': 'round'}),
      paint: T => ({'line-color': ['match', ['get', 'c'], 'out', T.corrOut, T.corr], 'line-width': metresBy(
        ['match', ['get', 'c'], 'main', 5.5 / mPerPx(12, lat), 3.5 / mPerPx(12, lat)],
        ['match', ['get', 'c'], 'main', 5.5 / mPerPx(22, lat), 3.5 / mPerPx(22, lat)])})},
    {id: 'walkway', type: 'line', source: 'lines', filter: l => ['all', ['==', ['get', 'k'], 'walkway'], lv(l)],
      layout: () => ({'line-cap': 'round', 'line-join': 'round'}), paint: T => ({'line-color': T.corr, 'line-width': metres(5, lat)})},
    {id: 'rooms', type: 'fill', source: 'rooms', filter: l => lv(l), paint: T => ({'fill-color': roomColor(T)})},
    {id: 'rooms-line', type: 'line', source: 'rooms', filter: l => ['all', lv(l), ['!=', ['get', 'k'], 'wall']],
      paint: T => ({'line-color': T.roomLine, 'line-width': ['interpolate', ['linear'], ['zoom'], 16, .5, 19, 1]})},
    {id: 'moving', type: 'line', source: 'lines', filter: l => ['all', ['==', ['get', 'k'], 'moving'], lv(l)],
      paint: T => ({'line-color': T.moving, 'line-width': metres(1.8, lat)})},
    {id: 'train', type: 'line', source: 'lines', filter: l => ['all', ['==', ['get', 'k'], 'train'], lv(l)],
      layout: () => ({'line-cap': 'round'}), paint: T => ({'line-color': T.train, 'line-width': 2.5, 'line-dasharray': [2, 1.5]})},
    {id: 'gate-dot', type: 'circle', source: 'gates', minzoom: 14.8, filter: l => lv(l),
      paint: T => ({'circle-color': T.gateDot, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 14.8, 1.3, 18, 3, 20, 4.5],
        'circle-stroke-color': T.halo, 'circle-stroke-width': 1})},
    {id: 'route-other', type: 'line', source: 'route', filter: l => ['!=', ['get', 'l'], l],
      layout: () => ({'line-cap': 'round', 'line-join': 'round'}),
      paint: T => ({'line-color': T.routeOther, 'line-opacity': .7, 'line-width': 3, 'line-dasharray': [1, 1.6]})},
    {id: 'route-case', type: 'line', source: 'route', filter: l => lv(l),
      layout: () => ({'line-cap': 'round', 'line-join': 'round'}), paint: T => ({'line-color': T.routeCase, 'line-width': CASE_W})},
    {id: 'route-line', type: 'line', source: 'route', filter: l => lv(l),
      layout: () => ({'line-cap': 'round', 'line-join': 'round'}), paint: T => ({'line-color': T.route, 'line-width': ROUTE_W})},
    // the chevron fits a 9 px line at size 1, so icon-size follows the route width / 9
    {id: 'route-chev', type: 'symbol', source: 'route', minzoom: 14.6, filter: l => lv(l),
      layout: T => ({'symbol-placement': 'line', 'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 15, 30, 18, 44], 'icon-image': `am-chev-${T.name}`,
        'icon-size': ['interpolate', ['exponential', 1.5], ['zoom'], 14.6, 5 / 9, 16, 6.2 / 9, 18, 1, 20, 14 / 9], 'icon-allow-overlap': true,
        'icon-ignore-placement': true, 'icon-rotation-alignment': 'map', 'icon-keep-upright': false, 'icon-padding': 0}),
      paint: () => ({})},
    // labels: later in this list = placed first
    {id: 'area-label', type: 'symbol', source: 'areaLabels', minzoom: 17.4, filter: l => lv(l),
      layout: () => ({'text-field': ['get', 'n'], 'text-font': FM, 'text-size': ['interpolate', ['linear'], ['zoom'], 17.4, 10.5, 20, 12.5],
        'text-max-width': 7, 'symbol-sort-key': ['-', 0, ['get', 'a']], 'text-padding': 2}),
      paint: T => ({'text-color': T.labelMu, 'text-halo-color': T.halo, 'text-halo-width': 1.2})},
    {id: 'pois', type: 'symbol', source: 'pois', filter: (l, st) => ['all', lv(l), ['in', ['get', 'chip'], ['literal', st.chips]]],
      layout: T => ({'icon-image': ['concat', 'am-poi-', ['get', 'cat'], '-', T.name],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 15, .72, 17.5, .9, 19, 1], 'icon-padding': 1,
        'text-field': ['step', ['zoom'], '', 18, ['get', 'n']], 'text-font': FM, 'text-size': 11.5, 'text-optional': true,
        'text-anchor': 'left', 'text-offset': [1.15, 0], 'text-max-width': 9}),
      paint: T => ({'text-color': T.label, 'text-halo-color': T.halo, 'text-halo-width': 1.4})},
    {id: 'gate-label', type: 'symbol', source: 'gates', minzoom: 14.8,
      filter: (l, st) => ['all', lv(l), ['!', ['in', ['get', 'ref'], ['literal', st.endRefs]]]],
      layout: () => ({'text-field': ['get', 'ref'], 'text-font': FS,
        'text-size': ['interpolate', ['linear'], ['zoom'], 14.8, 10.5, 17.5, 12, 19.5, 14],
        'text-variable-anchor': ['left', 'right', 'top', 'bottom'], 'text-radial-offset': .55, 'text-padding': 1.5}),
      paint: T => ({'text-color': T.label, 'text-halo-color': T.halo, 'text-halo-width': 1.6})},
    {id: 'conc', type: 'symbol', source: 'conc', maxzoom: 16.6,
      layout: () => ({'text-field': ['get', 't'], 'text-font': FB, 'text-size': ['case', ['==', ['get', 'big'], 1], 22, 12],
        'text-letter-spacing': ['case', ['==', ['get', 'big'], 1], 0, .12], 'text-padding': 0}),
      paint: T => ({'text-color': T.conc, 'text-halo-color': T.halo, 'text-halo-width': 2,
        'text-opacity': ['interpolate', ['linear'], ['zoom'], 16, 1, 16.6, 0]})},
    {id: 'route-text', type: 'symbol', source: 'routePts',
      filter: l => ['all', lv(l), ['in', ['get', 'role'], ['literal', ['start', 'via']]]],
      layout: () => ({'text-field': ['get', 'label'], 'text-font': FS, 'text-size': 12.5,
        'text-variable-anchor': ['top', 'left', 'right', 'bottom'], 'text-radial-offset': 1.35, 'text-optional': true, 'text-max-width': 10}),
      paint: T => ({'text-color': T.label, 'text-halo-color': T.halo, 'text-halo-width': 1.8})},
    {id: 'route-pts', type: 'symbol', source: 'routePts',
      filter: l => ['any', lv(l), ['in', ['get', 'role'], ['literal', ['start', 'end']]]],
      layout: () => ({'icon-image': ['get', 'img'], 'icon-anchor': ['get', 'anchor'], 'icon-allow-overlap': true,
        'symbol-sort-key': ['get', 'z'], 'icon-padding': 0}),
      paint: () => ({})},
    {id: 'you-acc', type: 'circle', source: 'you',
      paint: T => ({'circle-color': T.youAcc, 'circle-pitch-alignment': 'map',
        'circle-radius': metresBy(['/', ['get', 'acc'], mPerPx(12, lat)], ['/', ['get', 'acc'], mPerPx(22, lat)])})},
    {id: 'you', type: 'circle', source: 'you',
      paint: T => ({'circle-color': T.you, 'circle-radius': 6.5, 'circle-stroke-color': T.youRing, 'circle-stroke-width': 3,
        'circle-opacity': ['case', ['get', 'here'], 1, .45], 'circle-stroke-opacity': ['case', ['get', 'here'], 1, .6]})},
  ];
}
const SOURCES = ['foot', 'floors', 'rooms', 'corr', 'lines', 'gates', 'gateAreas', 'conc', 'planes', 'pois', 'areaLabels', 'route', 'routePts', 'you'];

async function createGL(ml, box, P, st, hooks) {
  glyphProtocol(ml);
  const d = P.data, b = d.bbox, lat = d.center[1], T0 = THEMES[st.themeName()];
  const map = new ml.Map({
    container: box, center: d.center, zoom: 16, bearing: d.bearing || 0,
    style: {version: 8, glyphs: 'airglyph://{fontstack}/{range}', sources: {}, layers: [{id: S('bg'), type: 'background', paint: {'background-color': T0.bg}}]},
    attributionControl: false, maxZoom: 21, minZoom: 12.5, maxPitch: 0, pitchWithRotate: false, touchPitch: false,
    renderWorldCopies: false, fadeDuration: N.reduce ? 0 : 120, dragRotate: true, keyboard: false,
    maxBounds: b ? [[b[0] - .01, b[1] - .008], [b[2] + .01, b[3] + .008]] : undefined,
    preserveDrawingBuffer: !!st.o.preserveDrawingBuffer,
  });
  map.touchZoomRotate.enableRotation();
  map.on('error', e => { st.lastError = e && e.error; });
  const G = {map, specs: specs(lat), theme: null, route: undefined, endRefs: [], kind: 'gl'};
  await new Promise((res, rej) => {
    const t = setTimeout(() => { try { map.remove(); } catch (e) { /* already gone */ } rej(new Error('map did not load')); }, 15000);
    map.once('load', () => { clearTimeout(t); res(); });
  });
  for (const k of SOURCES) map.addSource(S(k), {type: 'geojson', data: P.geo[k] || EMPTY, buffer: 64, tolerance: .2});

  const pr = PR();
  const put = (id, img, replace) => { if (map.hasImage(id)) { if (!replace) return; map.removeImage(id); } map.addImage(id, img, {pixelRatio: img.pixelRatio}); };
  async function themeImages(T) {
    put(`am-plane-${T.name}`, plane(T.plane, T.planeLine, pr));
    put(`am-chev-${T.name}`, chevron(pr, T.chev));
    const cats = Object.keys(POI_ICON), imgs = await Promise.all(cats.map(c => iconImage(POI_ICON[c], '#FFFFFF')));
    cats.forEach((c, i) => put(`am-poi-${c}-${T.name}`, badge(imgs[i], T.poi[CHIP_OF[c]], pr)));
    put(`am-start-${T.name}`, dot({ring: T.route, fill: '#FFFFFF', size: 18, ringW: 4.5}, pr));
    put(`am-via-${T.name}`, dot({ring: T.route, fill: '#FFFFFF', size: 13, ringW: 3}, pr));
  }
  async function routeImages(T, geo) {
    for (const f of geo.points.features) {
      const q = f.properties;
      if (q.role === 'start') Object.assign(q, {img: `am-start-${T.name}`, anchor: 'center', z: 2});
      else if (q.role === 'via') Object.assign(q, {img: `am-via-${T.name}`, anchor: 'center', z: 3});
      else if (q.role === 'end') {
        // On another floor the end pin stays solid in outline (a faded pin reads as disabled).
        Object.assign(q, {img: `am-end-${q.label}-${T.name}`, imgOff: `am-endo-${q.label}-${T.name}`, anchor: 'bottom', z: 9});
        put(q.img, pill(q.label, {fill: T.pin, color: T.pinText, tail: true, size: 13.5, h: 28}, pr));
        put(q.imgOff, pill(q.label, {fill: T.chip, color: T.label, stroke: T.pin, tailFill: T.pin, tail: true, size: 13.5, h: 28}, pr));
      } else {
        const name = (VERT_ICON[q.kind] || VERT_ICON.stairs)[q.up ? 0 : 1];
        const icon = await iconImage(name, T.route);
        const text = q.role === 'trans' ? q.label : '';
        Object.assign(q, {img: `am-${q.role}-${name}-${text}-${T.name}`, anchor: 'center', z: q.role === 'trans' ? 5 : 4});
        put(q.img, pill(text, {fill: T.chip, color: T.label, stroke: T.route, icon, size: 12.5, h: 28, padX: text ? 9 : 4}, pr));
      }
    }
  }
  G.render = async () => {
    const T = THEMES[st.themeName()], level = st.level;
    const themed = G.theme !== T.name;
    if (themed) await themeImages(T);
    if (st.route !== G.route || themed) {
      const g = routeGeo(P, st.route);
      await routeImages(T, g);
      map.getSource(S('route')).setData(g.lines);
      map.getSource(S('routePts')).setData(g.points);
      G.endRefs = st.route ? [st.route.from.ref, st.route.to.ref].filter(Boolean) : [];
      G.route = st.route;
    }
    const y = st.you;
    map.getSource(S('you')).setData(y ? fc([pt([y.lon, y.lat], {acc: Math.max(3, Math.min(200, y.acc || 10)), here: y.level == null || y.level === level})]) : EMPTY);
    const fst = {chips: st.chips.slice(), endRefs: G.endRefs};
    for (const s of G.specs) {
      const id = S(s.id);
      if (!map.getLayer(id)) {
        map.addLayer(Object.assign({id, type: s.type, source: S(s.source), layout: s.layout ? s.layout(T) : {}, paint: s.paint(T)},
          s.minzoom != null ? {minzoom: s.minzoom} : {}, s.maxzoom != null ? {maxzoom: s.maxzoom} : {},
          s.filter ? {filter: s.filter(level, fst)} : {}));
        continue;
      }
      if (themed) {
        for (const [k, v] of Object.entries(s.paint(T))) map.setPaintProperty(id, k, v);
        if (s.layout) for (const [k, v] of Object.entries(s.layout(T))) map.setLayoutProperty(id, k, v);
      }
      if (s.filter) map.setFilter(id, s.filter(level, fst));
    }
    map.setLayoutProperty(S('route-pts'), 'icon-image', ['case', lv(level), ['get', 'img'], ['coalesce', ['get', 'imgOff'], ['get', 'img']]]);
    map.setPaintProperty(S('route-pts'), 'icon-opacity', ['case', ['any', lv(level), ['==', ['get', 'role'], 'end']], 1, .6]);
    if (themed) map.setPaintProperty(S('bg'), 'background-color', T.bg);
    G.theme = T.name;
  };
  // taps: a level-change marker shows the level it leads to; a POI badge goes to the screen
  map.on('click', e => {
    const p = e.point, bx = [[p.x - 16, p.y - 16], [p.x + 16, p.y + 16]];
    const hits = map.queryRenderedFeatures(bx, {layers: [S('route-pts'), S('pois')]});
    const tr = hits.find(f => f.layer.id === S('route-pts') && f.properties.role === 'trans');
    if (tr) { hooks.level(+tr.properties.to, true); return; }
    const pf = hits.find(f => f.layer.id === S('pois'));
    if (pf) hooks.poi(pf.properties.id);
  });
  G.box = pad => {
    const c = map.getContainer();
    return {w: Math.max(40, c.clientWidth - pad.left - pad.right), h: Math.max(40, c.clientHeight - pad.top - pad.bottom)};
  };
  G.camera = (f, pad, animate) => {
    const o = {center: f.center, zoom: f.zoom, bearing: f.bearing, padding: pad};
    if (animate && !N.reduce) map.easeTo(Object.assign(o, {duration: 650})); else map.jumpTo(o);
  };
  G.fitPts = (pts, pad, o, animate) => { if (pts.length) G.camera(frame(pts, G.box(pad), o), pad, animate); };
  G.bearing = () => map.getBearing();
  G.to = (p, zoom, animate) => map[animate && !N.reduce ? 'easeTo' : 'jumpTo']({center: p, zoom: Math.max(zoom, map.getZoom()), duration: 600});
  G.resize = () => map.resize();
  G.destroy = () => map.remove();
  await G.render();
  return G;
}

// ---------- Leaflet fallback (no rotation; canvas floors, SVG route, DOM labels with greedy placement) ----------
const LL = p => [p[1], p[0]];
const ring = r => r.map(LL);
const interp = (z, stops, base = 1.5) => {
  if (z <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [z1, v1] = stops[i], [z0, v0] = stops[i - 1];
    if (z <= z1) { const t = (Math.pow(base, z - z0) - 1) / (Math.pow(base, z1 - z0) - 1); return v0 + (v1 - v0) * t; }
  }
  return stops[stops.length - 1][1];
};
const LW = {case: [[14, 5], [16, 8.5], [18, 13], [20, 19]], line: [[14, 3], [16, 5.5], [18, 9], [20, 14]]};
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const measure = (() => {
  let ctx; const cache = new Map();
  return (text, font) => {
    const k = font + '|' + text;
    if (!cache.has(k)) { ctx = ctx || canvas(1, 1).getContext('2d'); ctx.font = font; cache.set(k, ctx.measureText(text).width); }
    return cache.get(k);
  };
})();

async function createLF(L, box, P, st, hooks) {
  const d = P.data, b = d.bbox, lat = d.center[1];
  box.classList.add('am-lf');
  const map = L.map(box, {zoomControl: false, attributionControl: false, zoomSnap: 0, zoomDelta: .5, wheelPxPerZoomLevel: 90,
    minZoom: 13.5, maxZoom: 22, maxBounds: b ? [[b[1] - .008, b[0] - .01], [b[3] + .008, b[2] + .01]] : undefined, maxBoundsViscosity: .8,
    bounceAtZoomLimits: false, fadeAnimation: false, tap: false});
  const pane = (n, z, ev) => { const p = map.createPane(n); p.style.zIndex = z; p.style.pointerEvents = ev ? '' : 'none'; return p; };
  pane('am-planes', 380); pane('am-base', 400); pane('am-route', 450); pane('am-lbl', 600, true); pane('am-pins', 650, true);
  map.setView(LL(d.center), 17, {animate: false});
  const cv = L.canvas({pane: 'am-base', padding: .3, tolerance: 0}), sv = L.svg({pane: 'am-route', padding: .3});
  const G = {map, kind: 'leaflet', base: null, labels: [], routeL: null, planes: null, you: null};
  const icon = (html, cls) => L.divIcon({className: '', html: `<div class="am-m ${cls || ''}">${html}</div>`, iconSize: [0, 0]});
  const marker = (p, html, paneName, interactive) => L.marker(LL(p), {icon: icon(html), pane: paneName, interactive: !!interactive, keyboard: false});
  const svgOf = (name, color) => iconSvg(name, color, 16) || '';

  function buildBase(T, level) {
    const outL = [];
    const add = (lyr, m) => { if (m) lyr.__m = m; outL.push(lyr); return lyr; };
    const byKey = (fs, key) => { const g = new Map(); for (const f of fs) { const k = key(f); (g.get(k) || g.set(k, []).get(k)).push(f); } return g; };
    const poly = (fs, style) => L.polygon(fs.map(f => f.geometry.coordinates.map(ring)), Object.assign({renderer: cv, interactive: false}, style));
    const line = (fs, style) => L.polyline(fs.map(f => f.geometry.coordinates.map(LL)), Object.assign({renderer: cv, interactive: false, lineCap: 'round', lineJoin: 'round'}, style));
    const foot = P.geo.foot.features;
    if (foot.length) add(poly(foot, {fillColor: T.foot, fillOpacity: 1, color: T.footLine, weight: 1}));
    const jets = P.geo.lines.features.filter(f => f.properties.k === 'jetbridge' && (f.properties.l == null || f.properties.l === level));
    if (jets.length) add(line(jets, {color: T.jet, weight: 3}), 3.2);
    const floors = P.geo.floors.features.filter(f => f.properties.l === level);
    for (const [k, fs] of [...byKey(floors, f => f.properties.k)].sort((x, y) => x[1][0].properties.o - y[1][0].properties.o)) {
      add(poly(fs, {fillColor: T.floor[k] || T.floor.terminal, fillOpacity: 1, color: T.floorLine, weight: .8}));
    }
    const ga = P.geo.gateAreas.features.filter(f => f.properties.l === level);
    if (ga.length) add(poly(ga, {fillColor: T.room.gatearea, fillOpacity: 1, stroke: false}));
    const corr = P.geo.corr.features.filter(f => f.properties.l === level && f.properties.c !== 'spur');
    const ck = byKey(corr, f => f.properties.c);
    for (const c of ['out', 'main']) if (ck.get(c)) add(line(ck.get(c), {color: c === 'out' ? T.corrOut : T.corr, weight: 2}), c === 'out' ? 3.5 : 5.5);
    const walk = P.geo.lines.features.filter(f => f.properties.k === 'walkway' && f.properties.l === level);
    if (walk.length) add(line(walk, {color: T.corr, weight: 3}), 5);
    const rooms = P.geo.rooms.features.filter(f => f.properties.l === level);
    for (const [k, fs] of [...byKey(rooms, f => f.properties.k)].sort((x, y) => x[1][0].properties.o - y[1][0].properties.o)) {
      add(poly(fs, {fillColor: T.room[k] || T.room.room, fillOpacity: 1, color: T.roomLine, weight: .7, stroke: k !== 'wall'}));
    }
    const mv = P.geo.lines.features.filter(f => f.properties.k === 'moving' && f.properties.l === level);
    if (mv.length) add(line(mv, {color: T.moving, weight: 2}), 1.8);
    const tr = P.geo.lines.features.filter(f => f.properties.k === 'train' && f.properties.l === level);
    if (tr.length) add(line(tr, {color: T.train, weight: 2.5, dashArray: '5 4'}));
    for (const g of P.geo.gates.features) if (g.properties.l === level) {
      const c = L.circleMarker(LL(g.geometry.coordinates), {renderer: cv, interactive: false, radius: 3, fillColor: T.gateDot, fillOpacity: 1, color: T.halo, weight: 1});
      c.__gate = 1; outL.push(c);
    }
    return outL;
  }
  function buildLabels(T, level) {
    const items = [], endRefs = new Set(st.route ? [st.route.from.ref, st.route.to.ref].filter(Boolean) : []);
    for (const g of P.geo.gates.features) {
      const q = g.properties;
      if (q.l !== level || endRefs.has(q.ref)) continue;
      const w = measure(q.ref, '600 12px Inter'), h = 12;
      items.push({m: marker(g.geometry.coordinates, `<span class="am-gt">${esc(q.ref)}</span>`, 'am-lbl'), pri: 3, minz: 15.8, w, h,
        cands: [[6, -h / 2], [-6 - w, -h / 2], [-w / 2, -h - 6], [-w / 2, 6]], kind: 'gate'});
    }
    const on = new Set(st.chips);
    if (on.size) {
      for (const f of P.geo.pois.features) {
        const q = f.properties;
        if (q.l !== level || !on.has(q.chip)) continue;
        const m = marker(f.geometry.coordinates, `<div class="am-poi" style="--c:${T.poi[q.chip]}">${svgOf(POI_ICON[q.cat], '#FFFFFF')}<b>${esc(q.n)}</b></div>`, 'am-lbl', true);
        m.on('click', () => hooks.poi(q.id));
        items.push({m, pri: 2, w: 24, h: 24, cands: [[-12, -12]], kind: 'poi', tw: measure(q.n, '500 12px Inter')});
      }
    }
    for (const f of P.geo.areaLabels.features) {
      const q = f.properties;
      if (q.l !== level) continue;
      const tw = measure(q.n, '500 12px Inter'), w = Math.min(100, tw), h = 14 * Math.ceil(tw / 100);
      items.push({m: marker(f.geometry.coordinates, `<span class="am-al">${esc(q.n)}</span>`, 'am-lbl'), pri: 1 + q.a / 1e6, minz: 17.4, w, h, cands: [[-w / 2, -h / 2]], kind: 'area'});
    }
    for (const f of P.geo.conc.features) {
      const q = f.properties;
      items.push({m: marker(f.geometry.coordinates, `<span class="am-cl${q.big ? '' : ' sm'}">${esc(q.t)}</span>`, 'am-lbl'), pri: 9, maxz: 16.6, w: 0, h: 0, cands: [[0, 0]], kind: 'conc', fixed: true});
    }
    return items.sort((x, y) => y.pri - x.pri);
  }
  function buildPlanes(T) {
    const svg = `<svg viewBox="0 0 64 64"><path d="${PLANE_D}" fill="${T.plane}" stroke="${T.planeLine}" stroke-width=".8" stroke-linejoin="round"/></svg>`;
    return P.geo.planes.features.map(f => marker(f.geometry.coordinates, `<div class="am-pl" style="transform:rotate(${f.properties.rot}deg)">${svg}</div>`, 'am-planes'));
  }
  function buildRoute(T, level) {
    const r = st.route, o = {lines: [], pins: []};
    if (!r) return o;
    const g = routeGeo(P, r);
    const pl = (fs, style) => L.polyline(fs.map(f => f.geometry.coordinates.map(LL)), Object.assign({renderer: sv, interactive: false, lineCap: 'round', lineJoin: 'round'}, style));
    const here = g.lines.features.filter(f => f.properties.l === level), other = g.lines.features.filter(f => f.properties.l !== level);
    if (other.length) o.lines.push(pl(other, {color: T.routeOther, opacity: .7, weight: 3, dashArray: '1 6'}));
    if (here.length) {
      o.lines.push(Object.assign(pl(here, {color: T.routeCase, weight: 8}), {__w: 'case'}));
      o.lines.push(Object.assign(pl(here, {color: T.route, weight: 5}), {__w: 'line'}));
      o.chev = L.polyline([], {renderer: sv, interactive: false, color: T.chev, weight: 2, lineCap: 'round', lineJoin: 'round'});
      o.chevSrc = here.map(f => f.geometry.coordinates.map(LL));
      o.lines.push(o.chev);
    }
    for (const f of g.points.features) {
      const q = f.properties, p = f.geometry.coordinates, off = q.l !== level ? ' am-off' : '';
      // an end on another floor sits under this floor's pins (a "Down to 1" pill stays readable)
      const low = m => (off ? m.setZIndexOffset(-1000) : m);
      if (q.role === 'start') o.pins.push(low(marker(p, `<div class="am-dot${off}" style="--s:18px;--r:4.5px"><b>${q.l === level ? esc(q.label) : ''}</b></div>`, 'am-pins')));
      else if (q.role === 'end') o.pins.push(low(marker(p, `<div class="am-pin${off}">${esc(q.label)}</div>`, 'am-pins')));
      else if (q.l !== level) continue;
      else if (q.role === 'via') o.pins.push(marker(p, `<div class="am-dot" style="--s:13px;--r:3px"><b>${esc(q.label)}</b></div>`, 'am-pins'));
      else {
        const svgTxt = svgOf((VERT_ICON[q.kind] || VERT_ICON.stairs)[q.up ? 0 : 1], T.route);
        const m = marker(p, `<div class="am-tr${q.role === 'trans' ? '' : ' am-tri'}">${svgTxt}${q.role === 'trans' ? esc(q.label) : ''}</div>`, 'am-pins', q.role === 'trans');
        if (q.role === 'trans') m.on('click', () => hooks.level(+q.to, true));
        o.pins.push(m);
      }
    }
    return o;
  }
  function chevrons(src, k) {
    const z = map.getZoom(), res = [], gap = 40;
    for (const line of src) {
      const pts = line.map(p => map.project(p, z));
      let carry = gap / 2;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], c = pts[i], dx = c.x - a.x, dy = c.y - a.y, len = Math.hypot(dx, dy);
        if (!len) continue;
        const ux = dx / len, uy = dy / len;
        for (let t = carry; t < len; t += gap) {
          const cx = a.x + ux * t, cy = a.y + uy * t;
          const tip = [cx + ux * 1.4 * k, cy + uy * 1.4 * k], back = [cx - ux * 1.4 * k, cy - uy * 1.4 * k];
          const l1 = [back[0] - uy * 2.2 * k, back[1] + ux * 2.2 * k], l2 = [back[0] + uy * 2.2 * k, back[1] - ux * 2.2 * k];
          res.push([l1, tip, l2].map(([x, y]) => map.unproject([x, y], z)));
        }
        carry = ((carry - len) % gap + gap) % gap;
      }
    }
    return res;
  }
  function place(gz) {
    const boxes = [];
    const hit = q => boxes.some(o => q[0] < o[2] && q[2] > o[0] && q[1] < o[3] && q[3] > o[1]);
    for (const r of G.routeL ? G.routeL.pins : []) { const p = map.latLngToLayerPoint(r.getLatLng()); boxes.push([p.x - 40, p.y - 36, p.x + 40, p.y + 12]); }
    // what the screen lays over the card (level rail, chips, buttons): a label under it would only peek out
    try {
      const C = map.getContainer().getBoundingClientRect();
      for (const e of st.o.cover ? st.o.cover() : []) {
        const b = e.getBoundingClientRect();
        if (!b.width || !b.height) continue;
        const a = map.containerPointToLayerPoint([b.left - C.left, b.top - C.top]), z = map.containerPointToLayerPoint([b.right - C.left, b.bottom - C.top]);
        boxes.push([a.x, a.y, z.x, z.y]);
      }
    } catch (e) { N.report(e, 'airmap cover'); }
    for (const it of G.labels) {
      const el = it.m.getElement();
      if (!el) continue;
      const inner = el.firstChild;
      let show = !(it.minz && gz < it.minz) && !(it.maxz && gz > it.maxz);
      if (show && !it.fixed) {
        const p = map.latLngToLayerPoint(it.m.getLatLng());
        let ok = null;
        const Wd = it.kind === 'poi' && gz >= 18 ? it.w + 4 + it.tw : it.w;
        for (const [dx, dy] of it.cands) {
          const q = [p.x + dx - 1.5, p.y + dy - 1.5, p.x + dx + Wd + 1.5, p.y + dy + it.h + 1.5];
          if (!hit(q)) { ok = [dx, dy, q]; break; }
        }
        if (!ok && it.kind === 'poi' && Wd !== it.w) { const q = [p.x - 12, p.y - 12, p.x + 12, p.y + 12]; if (!hit(q)) ok = [-12, -12, q, true]; }
        show = !!ok;
        if (ok) {
          boxes.push(ok[2]);
          if (it.kind === 'gate') inner.style.transform = `translate(${ok[0]}px,${ok[1]}px)`;
          if (it.kind === 'poi') inner.querySelector('b').style.display = gz >= 18 && !ok[3] ? '' : 'none';
        }
      }
      inner.classList.toggle('am-hide', !show);
    }
    placeRoute();
  }
  // Labels of the route's dots (the start first, then stops on the way) go right of the dot, else left, below or
  // above; a label hides only when every side would cover a pin, a level pill, another label or leave the card.
  const SIDES = ['am-lL', 'am-lB', 'am-lT'];
  function placeRoute() {
    const C = map.getContainer().getBoundingClientRect();
    if (!C.width || !C.height) return;
    const box = e => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; };
    const taken = [], labs = [];
    for (const r of G.routeL ? G.routeL.pins : []) {
      const w = r.getElement(), inner = w && w.firstChild && w.firstChild.firstChild;   // the pin itself, inside icon()'s .am-m
      if (!inner || !inner.getBoundingClientRect) continue;
      taken.push(box(inner));
      const b = inner.classList.contains('am-dot') ? inner.querySelector('b') : null;
      if (b && b.textContent) labs.push([inner, b]);
    }
    // what the screen lays over the card (its level rail, buttons, chips) counts as taken too
    try { for (const e of st.o.cover ? st.o.cover() : []) { const q = box(e); if (q[2] > q[0] && q[3] > q[1]) taken.push(q); } } catch (e) { N.report(e, 'airmap cover'); }
    labs.sort((a, b) => b[0].offsetWidth - a[0].offsetWidth);
    const hit = q => q[0] < C.left + 2 || q[2] > C.right - 2 || q[1] < C.top + 2 || q[3] > C.bottom - 2 ||
      taken.some(o => q[0] < o[2] && q[2] > o[0] && q[1] < o[3] && q[3] > o[1]);
    for (const [inner, b] of labs) {
      let ok = false;
      b.classList.remove('am-hide');
      for (const s of [''].concat(SIDES)) {
        inner.classList.remove(...SIDES);
        if (s) inner.classList.add(s);
        const q = box(b);
        if (!hit(q)) { taken.push(q); ok = true; break; }
      }
      if (!ok) { inner.classList.remove(...SIDES); b.classList.add('am-hide'); }
    }
  }
  function relayout() {
    const z = map.getZoom(), mpp = mPerPx(z, lat) * 2;
    for (const l of G.base || []) {
      if (l.__m) l.setStyle({weight: Math.max(.6, l.__m / mpp)});
      else if (l.__gate) { l.setRadius(interp(z - 1, [[15.6, 1.6], [18, 3], [20, 4.5]], 1.0001)); l.setStyle({opacity: z - 1 >= 15.6 ? 1 : 0, fillOpacity: z - 1 >= 15.6 ? 1 : 0}); }
    }
    if (G.routeL) {
      for (const l of G.routeL.lines) if (l.__w) l.setStyle({weight: interp(z - 1, LW[l.__w])});
      if (G.routeL.chev) {
        const k = interp(z - 1, LW.line) / 9;
        G.routeL.chev.setStyle({weight: 1.8 * k});
        G.routeL.chev.setLatLngs(z - 1 >= 15.6 ? chevrons(G.routeL.chevSrc, k) : []);
      }
    }
    const pp = map.getPane('am-planes');
    pp.style.setProperty('--am-plane', `${(46 / mpp).toFixed(1)}px`);
    pp.style.display = z - 1 >= 16.6 ? '' : 'none';
    place(z - 1);
  }
  map.on('zoomend', relayout);
  map.on('moveend', placeRoute);
  G.render = async () => {
    const T = THEMES[st.themeName()], level = st.level;
    for (const [k, v] of Object.entries({label: T.label, 'label-mu': T.labelMu, halo: T.halo, conc: T.conc, route: T.route,
      pin: T.pin, 'pin-t': T.pinText, chip: T.chip})) box.style.setProperty(`--am-${k}`, v);
    box.style.background = T.bg;
    const kBase = `${T.name}|${level}`, kRoute = [st.route, T.name, level], kLbl = JSON.stringify([T.name, level, st.chips, G.endKey = st.route ? [st.route.from.ref, st.route.to.ref] : 0]);
    if (G.kBase !== kBase) { (G.base || []).forEach(l => l.remove()); G.base = buildBase(T, level); G.base.forEach(l => l.addTo(map)); G.kBase = kBase; }
    if (G.kPlanes !== T.name) { (G.planes || []).forEach(l => l.remove()); G.planes = buildPlanes(T); G.planes.forEach(l => l.addTo(map)); G.kPlanes = T.name; }
    if (!G.kRoute || G.kRoute.some((v, i) => v !== kRoute[i])) {
      if (G.routeL) [...G.routeL.lines, ...G.routeL.pins].forEach(l => l.remove());
      G.routeL = buildRoute(T, level); G.routeL.lines.forEach(l => l.addTo(map)); G.routeL.pins.forEach(l => l.addTo(map)); G.kRoute = kRoute;
    }
    if (G.kLbl !== kLbl) { G.labels.forEach(it => it.m.remove()); G.labels = buildLabels(T, level); G.labels.forEach(it => it.m.addTo(map)); G.kLbl = kLbl; }
    if (G.you) { G.you.forEach(l => l.remove()); G.you = null; }
    const y = st.you;
    if (y) {
      const away = y.level != null && y.level !== level;
      G.you = [L.circle([y.lat, y.lon], {renderer: sv, radius: Math.max(3, Math.min(200, y.acc || 10)), stroke: false, fillColor: T.you, fillOpacity: .16, interactive: false}),
        marker([y.lon, y.lat], `<div class="am-you${away ? ' away' : ''}"></div>`, 'am-pins')];
      G.you.forEach(l => l.addTo(map));
    }
    relayout();
  };
  const fitB = (pts, pad, maxZoom, animate) => {
    if (!pts.length) return;
    map.fitBounds(pts.map(LL), {paddingTopLeft: [pad.left, pad.top], paddingBottomRight: [pad.right, pad.bottom], maxZoom: maxZoom + 1, animate: !!animate && !N.reduce});
  };
  G.fitPts = (pts, pad, o, animate) => {
    if (!o.ext) return fitB(pts, pad, o.maxZoom || 20, animate);
    const c = map.getContainer(), box = {w: Math.max(40, c.clientWidth - pad.left - pad.right), h: Math.max(40, c.clientHeight - pad.top - pad.bottom)};
    const f = frame(pts, box, Object.assign({}, o, {bearing: 0}));
    // frame() centres the padded box; Leaflet centres the container, so shift by half the padding difference
    const k = 512 * Math.pow(2, f.zoom), m = merc(f.center);
    const ctr = unmerc([m[0] - (pad.left - pad.right) / 2 / k, m[1] - (pad.top - pad.bottom) / 2 / k]);
    map.setView(LL(ctr), f.zoom + 1, {animate: !!animate && !N.reduce});
  };
  G.bearing = () => 0;
  G.to = (p, zoom, animate) => map.setView(LL(p), Math.max(zoom + 1, map.getZoom()), {animate: !!animate && !N.reduce});
  G.resize = () => map.invalidateSize();
  G.destroy = () => map.remove();
  await G.render();
  return G;
}

// ---------- mount ----------
// the screen's level rail sits on the right edge of the card; opts.padding overrides these
const RPAD = {top: 20, bottom: 30, left: 18, right: 64};
const OPAD = {top: 14, bottom: 26, left: 14, right: 60};
const darkMQ = W.matchMedia ? W.matchMedia('(prefers-color-scheme: dark)') : null;
const isDark = () => (N.isDark ? N.isDark() : !!(darkMQ && darkMQ.matches));

AM.mount = (el, P, opts = {}) => {
  const lvls = P ? (P.data.levels || []).map(l => l.id) : [];
  const st = {o: opts, route: opts.route || null, chips: (opts.chips || []).slice(), theme: opts.theme || 'auto', you: null,
    level: null, ready: false, dead: false};
  st.level = opts.level != null && lvls.includes(opts.level) ? opts.level : st.route ? st.route.from.l : P ? P.data.defaultLevel : null;
  st.themeName = () => (st.theme === 'dark' || (st.theme !== 'light' && isDark()) ? 'dark' : 'light');
  let G = null, queue = Promise.resolve(), pendingFit = null;
  el.classList.add('am');
  const box = D.createElement('div'); box.className = 'am-map';
  const attr = D.createElement('div'); attr.className = 'am-attr';
  const at = P && String(P.data.attribution || '');
  attr.textContent = at ? (/openstreetmap/i.test(at) ? '© OpenStreetMap contributors' : clip(at.split(/[;.]/)[0], 48)) : '';
  if (at) attr.title = at;
  el.append(box, attr);
  el.dataset.theme = st.themeName();

  const render = () => { queue = queue.then(() => (G && !st.dead ? G.render() : null)).catch(e => N.report(e, 'airmap render')); return queue; };
  const levelTo = (l, fromMap) => {
    if (!lvls.includes(l) || l === st.level) return;
    st.level = l;
    render();
    if (fromMap) {
      if (opts.onLevel) try { opts.onLevel(l); } catch (e) { N.report(e, 'airmap onLevel'); }
      if (st.route) fitLevel(l);
    }
  };
  const withRoom = (pts, room) => ({pts: pts.concat(room.map(r => r[0])), ext: pts.map(() => null).concat(room.map(r => r[1])), ends: [0, pts.length - 1]});
  const fitLevel = l => {
    if (!G || !st.route) return;
    const pts = st.route.runs.filter(x => x.l === l).flatMap(x => x.coords);
    if (!pts.length) return;
    const w = withRoom(pts, routeRoom(P, st.route).filter(r => r[2] === l));
    G.fitPts(w.pts, opts.padding || RPAD, {bearing: G.bearing(), maxZoom: 19.2, ext: w.ext, ends: w.ends}, true);
  };
  const fit = (what = 'route', animate) => {
    if (!G) { pendingFit = what; return; }
    const pad = opts.padding || (what === 'overview' ? OPAD : RPAD);
    if (what === 'you' && st.you) { G.to([st.you.lon, st.you.lat], 18.5, animate); return; }
    if (what === 'route' && st.route) {
      let pts = st.route.runs.flatMap(x => x.coords);
      if (!pts.length) pts = [st.route.from.p, st.route.to.p];
      const w = withRoom(pts, routeRoom(P, st.route));
      G.fitPts(w.pts, pad, {bearing: 'route', maxZoom: 19.2, ext: w.ext, ends: w.ends}, animate);
      return;
    }
    const d = P.data;
    let pts = (d.gates || []).filter(g => g.l === st.level && g.p).map(g => g.p);
    if (pts.length < 3) pts = d.graph.nodes.filter(n => n[3] === st.level).map(n => [n[1], n[2]]);
    if (pts.length < 3) pts = d.graph.nodes.map(n => [n[1], n[2]]);
    const cf = P.geo.conc.features;
    const w = withRoom(pts, cf.map(f => [f.geometry.coordinates, concRoom(f)]));
    G.fitPts(w.pts, pad, {bearing: d.bearing || 0, maxZoom: 19, ext: w.ext}, animate);
  };
  const hooks = {
    level: levelTo,
    poi: id => {
      const q = P.poiById.get(id);
      if (q && opts.onPoi) try { opts.onPoi({id: q.id, name: shortName(q.n), cat: q.cat, level: q.l, node: q.node, near: q.near || '', note: q.note || '', hours: q.hours || null, p: q.p}); } catch (e) { N.report(e, 'airmap onPoi'); }
    },
  };
  // follow the app theme (and the system, while the app follows it)
  const onTheme = () => { if (st.theme === 'auto') { el.dataset.theme = st.themeName(); render(); } };
  const mo = W.MutationObserver ? new MutationObserver(onTheme) : null;
  if (mo) mo.observe(D.documentElement, {attributes: true, attributeFilter: ['data-theme']});
  if (darkMQ && darkMQ.addEventListener) darkMQ.addEventListener('change', onTheme);
  const ro = W.ResizeObserver ? new ResizeObserver(() => { if (G) G.resize(); }) : null;
  if (ro) ro.observe(el);

  const M = {
    get level() { return st.level; },
    get renderer() { return G ? G.kind : null; },
    get ready() { return st.ready; },
    setRoute(R) {
      R = R || null;
      if (R === st.route) return;
      st.route = R;
      if (R && R.from && lvls.includes(R.from.l) && R.from.l !== st.level) {
        st.level = R.from.l;
        if (opts.onLevel) try { opts.onLevel(st.level); } catch (e) { N.report(e, 'airmap onLevel'); }
      }
      render().then(() => { if (R && st.route === R) fit('route', st.ready); });
    },
    setChips(ids) { st.chips = (ids || []).filter(id => CHIP_OF[id] || CHIP_DEF.some(c => c.id === id)); render(); },
    setLevel(id) { if (lvls.includes(id) && id !== st.level) { st.level = id; render(); if (st.route) fitLevel(id); } },
    setYou(y) {
      const prevL = st.you ? st.you.level : undefined;
      st.you = y && isFinite(y.lon) && isFinite(y.lat) ? {lon: +y.lon, lat: +y.lat, acc: +y.acc || 10, level: y.level ?? null} : null;
      if (st.you && st.you.level != null && st.you.level !== prevL && prevL !== undefined) levelTo(st.you.level, true);
      else render();
    },
    fit(what) { fit(what || 'route', true); },
    setTheme(t) { st.theme = t === 'light' || t === 'dark' ? t : 'auto'; el.dataset.theme = st.themeName(); render(); },
    resize() { if (G) G.resize(); },
    destroy() {
      if (st.dead) return;
      st.dead = true;
      if (mo) mo.disconnect();
      if (darkMQ && darkMQ.removeEventListener) darkMQ.removeEventListener('change', onTheme);
      if (ro) ro.disconnect();
      try { if (G) G.destroy(); } catch (e) { /* already gone */ }
      G = null;
      box.remove(); attr.remove();
      el.classList.remove('am');
    },
  };
  if (!P) return M;

  (async () => {
    const want = opts.renderer || AM.renderer || 'auto';
    if (want !== 'leaflet' && webgl()) {
      try {
        const ml = await loadML();
        if (st.dead) return;
        const g = await createGL(ml, box, P, st, hooks);
        if (st.dead) { g.destroy(); return; }
        G = g;
      } catch (e) {
        G = null;
        box.replaceChildren();
        box.className = 'am-map';
      }
    }
    if (!G && !st.dead) {
      const L = await N.loadLeaflet();
      if (st.dead) return;
      const g = await createLF(L, box, P, st, hooks);
      if (st.dead) { g.destroy(); return; }
      G = g;
    }
    el.classList.add('am-' + G.kind);
    await render();
    fit(pendingFit || (st.route ? 'route' : 'overview'), false);
    st.ready = true;
    if (opts.onReady) try { opts.onReady(M); } catch (e) { N.report(e, 'airmap onReady'); }
  })().catch(e => N.report(e, 'airmap mount'));
  return M;
};
})();
