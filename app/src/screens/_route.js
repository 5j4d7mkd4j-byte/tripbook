/* N.route.*: walking and subway directions, computed on the phone.

   core.js's N.route() (the hash router) stays exactly as it is. This file
   hangs the routing API on that same function with Object.assign, so never
   reassign N.route. Nothing runs on load; data loads on the first ready().

   await N.route.ready()              true once data/walk.json and data/subway.json are
                                      loaded and indexed (once, shared); false if not
   N.route.near({lat,lon}, n=3, {exit})
                                      nearest stations by walking (sync, after ready):
                                      [{id, name, lat, lon, routes, m, min, entrance:{lat,lon,type}}]
                                      exit:true = entrances you can leave by (a destination)
   N.route.walk(from, to)             {m, min, path:[[lat,lon]], bridges:[[i0,i1]], steps:[{text,m,icon}], onGraph}
                                      bridges: index ranges into path that are on a bridge deck.
                                      onGraph:false: an end is >400 m off the street map, so
                                      straight line x1.3, path:[] and bridges:[] (no made-up line).
                                      null: no walk (another island: St George, Governors
                                      Island) or an end >40 km away.
                                      Snap: an end goes to the nearest street/path within 400 m;
                                      a bridge deck wins only if it is within 40 m AND (the
                                      nearest non-bridge is >max(40, deck+25) m away, or the deck
                                      is <=10 m and the non-bridge >deck+15 m), so a spot under
                                      or beside a bridge starts on the street, not the deck.
   await N.route.plan(from, to, {at=N.now(), max=3})
     {far:true} when from is >40 km from Midtown, otherwise
     {walk, transit:[Option], best:'walk'|'transit'|null, nearFrom, nearTo, at, stale,
      noTransit?:true, tooFar?:true}
     Option {min, walkMin, waitMin, rideMin, transfers, summary:'1 → 4', arrive, legs:[
       {kind:'walk', m, min, path, bridges, steps, onGraph, from:{name, entrance?}, to:{name, entrance?}}
       {kind:'ride', route, alt:[ids], short, color, text, dir, headsign, toward, stops, wait,
        min, every:[n]|[lo,hi], from:{stop,name,lat,lon}, to:{stop,name,lat,lon}, path}
       {kind:'transfer', at, min}]}
     alt: other lines that run the same stops (same stop count) between the same two
       stations at that time; show a badge for route and every alt.
     dir: the station's own platform label for that line ("Uptown", "Manhattan"), or ''
       when the feed only has a generic one (Outbound/Inbound) or it repeats the headsign;
       toward = "Uptown · toward Inwood–207 St" or "toward Times Sq–42 St".
     every: minutes between trains (route and alt together) now and 30 min later: [n] when
       the same, [lo,hi] otherwise.
     best: transit options exist -> 'walk' if walking is under 15 min or within 5 min of
       the fastest train, else 'transit'. No transit -> 'walk' if the walk is at most 45 min
       (25 min when onGraph:false), else null with tooFar:true. Trains are not looked up
       when walking is 6 min or less; noTransit:true means they were and none helps.
       transit keeps only options 3+ min faster than walking (all when the walk is >25 min).
     stale: true when `at` is outside subway.json's feed dates. Times still come from the
       weekday/Saturday/Sunday hourly service, so results stay usable; show a quiet note.
   N.route.badge(routeId)             N.h round MTA bullet (.rt-b; diamond for 6X/7X; classic
                                      MTA colours, black text on N/Q/R/W)
   N.route.draw(L, map, part, {dark, ends:true, labels:true, inset:[t,r,b,l]})
                                      draws a Walk, an Option or a Plan (its best) and returns
                                      an L.featureGroup ALREADY ADDED to map. g.getBounds()
                                      to fit, g.remove() to clear. Bridge decks get a road-
                                      coloured band with an edge under the walk line. Station
                                      labels re-pick their side on every moveend/zoomend to
                                      stay inside the map minus inset (px covered by a sheet)
                                      and off the line
   N.route.text(option|walk|plan)     "Walk 4 min to 50 St, 1 train 3 stops to Christopher St–
                                      Stonewall, walk 3 min" / "Walk 12 min (0.6 mi)";
                                      merged lines read "4 or 5 train"

   Private by design: locations are only used in memory, inside these calls.
   The only network use is the two relative data fetches; no coordinates
   are sent anywhere or stored. */
(() => {
'use strict';
const W = typeof window !== 'undefined' ? window : globalThis;
const N = W.N, R = N.route;

// ---------- constants ----------
const MID = {lat: 40.754, lon: -73.984};          // Midtown
const FAR_M = 40000;                              // farther than this: not a NYC trip
const SNAP_M = 400;                               // an end farther from the street map is off it
const BR_SNAP = 40;                               // never start or end on a bridge deck farther than this
const SPEED = 80;                                 // walking, m/min
const STEP_X = 1.3;                               // steps cost and take 30% longer
const CROSS_S = 10;                               // per signalled avenue crossing
const ACC_M = 1300, ACC_MAX = 2000, ACC_N = 6;    // station candidates at each end
const IN_S = 120, OUT_S = 60;                     // street to platform, platform to street
const WAIT_CAP = 900, XFER_DEF = 180, RIDES = 3;  // wait cap, default change, max rides
const WALK_MAX = 45, WALK_OFF = 25;               // with no train: longest walk worth recommending (min), on / off the street map
const LAT0 = 40.73, LON0 = -73.98, RAD = Math.PI / 180;
const KY = 111132.92 - 559.82 * Math.cos(2 * LAT0 * RAD) + 1.175 * Math.cos(4 * LAT0 * RAD);
const KX = 111412.84 * Math.cos(LAT0 * RAD) - 93.5 * Math.cos(3 * LAT0 * RAD);
const px = lon => (lon - LON0) * KX, py = lat => (lat - LAT0) * KY;
const ll = (x, y) => [Math.round((LAT0 + y / KY) * 1e6) / 1e6, Math.round((LON0 + x / KX) * 1e6) / 1e6];
const isPt = p => !!p && p.lat != null && p.lon != null && Number.isFinite(+p.lat) && Number.isFinite(+p.lon);
const gd = (a, b) => {
  const dLat = (b.lat - a.lat) * RAD, dLon = (b.lon - a.lon) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 12742018 * Math.asin(Math.min(1, Math.sqrt(s)));
};
const dash = s => String(s || '').replace(/(\S)-(\S)/g, '$1–$2');
const walkMin = sec => Math.max(1, Math.round(sec / 60));
const distText = m => N.distText ? N.distText(m) : m < 160 ? `${Math.round(m / 0.3048 / 10) * 10} ft` : `${(m / 1609.34).toFixed(m < 1609 ? 2 : 1)} mi`;

// Point in polygon, polygon as projected flat [x0,y0,x1,y1,...]
const inPoly = (x, y, P) => {
  let c = false;
  for (let i = 0, j = P.length - 2; i < P.length; j = i, i += 2) {
    const yi = P[i + 1], yj = P[j + 1];
    if ((yi > y) !== (yj > y) && x < (P[j] - P[i]) * (y - yi) / (yj - yi) + P[i]) c = !c;
  }
  return c;
};
const poly = pts => pts.flatMap(([la, lo]) => [px(lo), py(la)]);
// Generic public parks (rough outlines) so park paths read "Enter Central Park and follow the path".
// Only car-free edges are tested against these.
const box = (s, w, n, e) => [[s, w], [s, e], [n, e], [n, w]];
const PARKS = [
  ['Central Park', [[40.7644, -73.9730], [40.7681, -73.9819], [40.8003, -73.9582], [40.7969, -73.9493]]],
  ['Prospect Park', [[40.6725, -73.9705], [40.6650, -73.9790], [40.6545, -73.9818], [40.6500, -73.9720], [40.6530, -73.9615], [40.6620, -73.9612], [40.6700, -73.9640]]],
  ['Riverside Park', [[40.7770, -73.9935], [40.7800, -73.9850], [40.7985, -73.9725], [40.8120, -73.9640], [40.8270, -73.9545], [40.8300, -73.9600], [40.8000, -73.9800], [40.7800, -73.9950]]],
  ['Washington Square Park', box(40.7298, -73.9993, 40.7320, -73.9955)],
  ['Union Square', box(40.7347, -73.9918, 40.7373, -73.9892)],
  ['Madison Square Park', box(40.7408, -73.9894, 40.7432, -73.9863)],
  ['Bryant Park', box(40.7529, -73.9849, 40.7544, -73.9817)],
  ['Tompkins Square Park', box(40.7254, -73.9838, 40.7279, -73.9798)],
  ['The Battery', box(40.7008, -74.0193, 40.7057, -74.0133)],
  ['McCarren Park', box(40.7186, -73.9543, 40.7238, -73.9478)],
  ['Domino Park', box(40.7130, -73.9698, 40.7158, -73.9672)],
].map(([n, p]) => [n, poly(p)]);
// Manhattan above Houston St: compass turned 29° to the street grid, so 7th Ave runs "north".
const GRID = poly([[40.7265, -74.0130], [40.7580, -74.0080], [40.7700, -73.9960], [40.8000, -73.9750], [40.8300, -73.9550],
  [40.8520, -73.9480], [40.8800, -73.9330], [40.8740, -73.9090], [40.8350, -73.9340], [40.8090, -73.9330], [40.7960, -73.9290],
  [40.7760, -73.9420], [40.7420, -73.9710], [40.7265, -73.9715]]);
const MAJOR = /(\bAve\b|\bAvenue\b|\bBlvd\b|\bBoulevard\b|\bPkwy\b|^Broadway$|^Bowery$|^Central Park [WS]$|^West St$|^(E |W )?Houston St$|^Canal St$|^Delancey St$|^Chambers St$|^(E |W )?(14th|23rd|34th|42nd|57th|59th|72nd|79th|86th|96th|110th|116th|125th|135th|145th|155th) St$)/;
const baseName = s => s.replace(/^(E|W|East|West) /, '');
// 'Brooklyn Bridge', 'E 103rd St Footbridge', 'Manhattan Bridge Pedestrian Path' -> the bridge; 'Bridge St' is a street
const bridgeName = nm => { const m = /^(.*bridge(?: No\. \d+)?)(?: Pedestrian Path)?$/i.exec(nm); return m ? m[1] : null; };

// ---------- state ----------
let G = null, S = null, loading = null;
const stats = {};

// ---------- heap (shared by every search; searches never interleave) ----------
let HN = new Int32Array(1 << 14), HK = new Float64Array(1 << 14), HL = 0, HTOP = 0;
function hpush(n, k) {
  if (HL === HN.length) {
    const a = new Int32Array(HL * 2), b = new Float64Array(HL * 2);
    a.set(HN); b.set(HK); HN = a; HK = b;
  }
  let i = HL++;
  while (i > 0) {
    const pa = (i - 1) >> 1;
    if (HK[pa] <= k) break;
    HN[i] = HN[pa]; HK[i] = HK[pa]; i = pa;
  }
  HN[i] = n; HK[i] = k;
}
function hpop() {
  const n = HN[0]; HTOP = HK[0];
  const ln = HN[--HL], lk = HK[HL];
  let i = 0;
  for (;;) {
    let c = 2 * i + 1;
    if (c >= HL) break;
    if (c + 1 < HL && HK[c + 1] < HK[c]) c++;
    if (HK[c] >= lk) break;
    HN[i] = HN[c]; HK[i] = HK[c]; i = c;
  }
  HN[i] = ln; HK[i] = lk;
  return n;
}

// ---------- walk graph ----------
function loadWalk(w) {
  const nN = w.counts.nodes, nE = w.counts.edges, nSh = w.counts.shape;
  const nd = w.nodes, ed = w.edges, sh = w.shape;
  const X = new Float64Array(nN), Y = new Float64Array(nN), XI = new Int32Array(nN), YI = new Int32Array(nN);
  for (let i = 0, x = 0, y = 0; i < nN; i++) {
    x += nd[2 * i]; y += nd[2 * i + 1];
    XI[i] = x; YI[i] = y; X[i] = px(x / 1e5); Y[i] = py(y / 1e5);
  }
  const EA = new Int32Array(nE), EB = new Int32Array(nE), EN = new Int32Array(nE), EF = new Uint8Array(nE);
  const EM = new Float32Array(nE), EW = new Float32Array(nE), EG = new Float32Array(nE), EP = new Int32Array(nE + 1);
  const nP = 2 * nE + nSh;
  const PX = new Float64Array(nP), PY = new Float64Array(nP), PC = new Float32Array(nP), PE = new Int32Array(nP);
  let a = 0, si = 0, p = 0;
  for (let k = 0; k < nE; k++) {
    const r = 6 * k;
    a += ed[r];
    const b = a + ed[r + 1], ns = ed[r + 5];
    EA[k] = a; EB[k] = b; EN[k] = ed[r + 3]; EF[k] = ed[r + 4]; EP[k] = p;
    PX[p] = X[a]; PY[p] = Y[a]; PC[p] = 0; PE[p] = k; p++;
    let sx = XI[a], sy = YI[a], len = 0;
    for (let j = 0; j < ns; j++, si++) {
      sx += sh[2 * si]; sy += sh[2 * si + 1];
      PX[p] = px(sx / 1e5); PY[p] = py(sy / 1e5);
      len += Math.hypot(PX[p] - PX[p - 1], PY[p] - PY[p - 1]);
      PC[p] = len; PE[p] = k; p++;
    }
    PX[p] = X[b]; PY[p] = Y[b];
    len += Math.hypot(PX[p] - PX[p - 1], PY[p] - PY[p - 1]);
    PC[p] = len; PE[p] = k; p++;
    EG[k] = len;
    const m = ed[r + 2] || len;
    EM[k] = m; EW[k] = m * (EF[k] & 4 ? STEP_X : 1);
  }
  EP[nE] = p;
  // adjacency (CSR)
  const AS = new Int32Array(nN + 1), AE = new Int32Array(2 * nE);
  for (let k = 0; k < nE; k++) { AS[EA[k] + 1]++; AS[EB[k] + 1]++; }
  for (let i = 0; i < nN; i++) AS[i + 1] += AS[i];
  const fill = AS.slice(0, nN);
  for (let k = 0; k < nE; k++) { AE[fill[EA[k]]++] = k; AE[fill[EB[k]]++] = k; }
  // connected components (St George and Governors Island are their own)
  const CO = new Int32Array(nN).fill(-1), q = new Int32Array(nN);
  let nc = 0;
  for (let s = 0; s < nN; s++) {
    if (CO[s] >= 0) continue;
    let h = 0, t = 0;
    q[t++] = s; CO[s] = nc;
    while (h < t) {
      const u = q[h++];
      for (let i = AS[u]; i < AS[u + 1]; i++) {
        const e = AE[i], v = EA[e] === u ? EB[e] : EA[e];
        if (CO[v] < 0) { CO[v] = nc; q[t++] = v; }
      }
    }
    nc++;
  }
  // segment grid for snapping
  const CELL = 150;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < nP; i++) {
    if (PX[i] < x0) x0 = PX[i]; if (PX[i] > x1) x1 = PX[i];
    if (PY[i] < y0) y0 = PY[i]; if (PY[i] > y1) y1 = PY[i];
  }
  const gw = Math.floor((x1 - x0) / CELL) + 1, gh = Math.floor((y1 - y0) / CELL) + 1;
  const CS = new Int32Array(gw * gh + 1);
  const each = fn => {
    for (let k = 0; k < nE; k++) {
      for (let s = EP[k], end = EP[k + 1] - 1; s < end; s++) {
        const ax = Math.floor((Math.min(PX[s], PX[s + 1]) - x0) / CELL), bx = Math.floor((Math.max(PX[s], PX[s + 1]) - x0) / CELL);
        const ay = Math.floor((Math.min(PY[s], PY[s + 1]) - y0) / CELL), by = Math.floor((Math.max(PY[s], PY[s + 1]) - y0) / CELL);
        for (let cy = ay; cy <= by; cy++) for (let cx = ax; cx <= bx; cx++) fn(cy * gw + cx, s);
      }
    }
  };
  each(c => { CS[c + 1]++; });
  for (let i = 0; i < gw * gh; i++) CS[i + 1] += CS[i];
  const CL = new Int32Array(CS[gw * gh]), cf = CS.slice(0, gw * gh);
  each((c, s) => { CL[cf[c]++] = s; });
  const names = w.names;
  const MJ = new Uint8Array(names.length), BN = names.map(baseName);
  names.forEach((s, i) => { MJ[i] = MAJOR.test(s) ? 1 : 0; });
  G = {nN, nE, X, Y, EA, EB, EN, EF, EM, EW, EG, EP, PX, PY, PC, PE, AS, AE, CO, names, MJ, BN,
    x0, y0, gw, gh, CELL, CS, CL, stamp: 0,
    A: {g: new Float64Array(nN), st: new Int32Array(nN), cl: new Int32Array(nN), pr: new Int32Array(nN)},
    D: {g: new Float64Array(nN), st: new Int32Array(nN), cl: new Int32Array(nN)}};
}

// Nearest point on the street map within maxR metres (optionally inside one component).
// A bridge or footbridge deck (flag 2) is taken only when it is clearly the closest thing:
// within BR_SNAP m with no street or path within max(BR_SNAP, d + 25) m, or within 10 m with
// nothing else within d + 15 m. So a point under the Manhattan Bridge or beside the High Line
// snaps to the ground (same rule as tools/walk_build.py check()).
// -> {k edge, t metres along its geometry from node a, f fraction, x, y, d distance} | null
function snap(x, y, maxR, comp = -1) {
  const {x0, y0, gw, gh, CELL, CS, CL, PX, PY, PC, PE, EA, EF, EG, CO} = G;
  const cx = Math.floor((x - x0) / CELL), cy = Math.floor((y - y0) / CELL);
  // [0] ground, [1] bridge deck (only looked for within BR_SNAP)
  const bd = [maxR * maxR, Math.min(maxR, BR_SNAP) ** 2], bp = [-1, -1], bu = [0, 0];
  for (let r = 0; ; r++) {
    const lim = (r - 1) * CELL;
    if (lim > 0 && lim * lim >= bd[0]) break;
    if (lim > maxR) break;
    for (let yy = cy - r; yy <= cy + r; yy++) {
      if (yy < 0 || yy >= gh) continue;
      const full = yy === cy - r || yy === cy + r;
      for (let xx = cx - r; xx <= cx + r; xx += full ? 1 : 2 * r) {
        if (xx < 0 || xx >= gw) continue;
        const c = yy * gw + xx;
        for (let i = CS[c]; i < CS[c + 1]; i++) {
          const s = CL[i];
          if (comp >= 0 && CO[EA[PE[s]]] !== comp) continue;
          const ax = PX[s], ay = PY[s], dx = PX[s + 1] - ax, dy = PY[s + 1] - ay, L2 = dx * dx + dy * dy;
          let u = L2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0;
          u = u < 0 ? 0 : u > 1 ? 1 : u;
          const qx = ax + u * dx - x, qy = ay + u * dy - y, d2 = qx * qx + qy * qy, j = EF[PE[s]] & 2 ? 1 : 0;
          if (d2 < bd[j]) { bd[j] = d2; bp[j] = s; bu[j] = u; }
        }
      }
    }
  }
  let j = 0;
  if (bp[1] >= 0) {
    const db = Math.sqrt(bd[1]), dn = bp[0] >= 0 ? Math.sqrt(bd[0]) : Infinity;
    if (dn > Math.max(BR_SNAP, db + 25) || (db <= 10 && dn > db + 15)) j = 1;
  }
  const p = bp[j], u = bu[j];
  if (p < 0) return null;
  const k = PE[p], t = PC[p] + u * (PC[p + 1] - PC[p]);
  return {k, t, f: EG[k] > 0 ? t / EG[k] : 0, x: PX[p] + u * (PX[p + 1] - PX[p]), y: PY[p] + u * (PY[p + 1] - PY[p]), d: Math.sqrt(bd[j])};
}

// A* between two snaps (same component). -> {cost, end node | -2 (same edge)} or null
function astar(s, t) {
  const {A, EA, EB, EW, AS, AE, X, Y} = G;
  const st = ++G.stamp;
  HL = 0;
  const tx = t.x, ty = t.y;
  let best = Infinity, end = -1;
  if (s.k === t.k) { best = EW[s.k] * Math.abs(s.f - t.f); end = -2; }
  const seed = (n, c) => {
    if (A.st[n] !== st || c < A.g[n]) { A.st[n] = st; A.g[n] = c; A.pr[n] = -1; hpush(n, c + 0.98 * Math.hypot(X[n] - tx, Y[n] - ty)); }
  };
  seed(EA[s.k], EW[s.k] * s.f);
  seed(EB[s.k], EW[s.k] * (1 - s.f));
  const na = EA[t.k], nb = EB[t.k], ta = EW[t.k] * t.f, tb = EW[t.k] * (1 - t.f);
  while (HL) {
    const u = hpop();
    if (A.cl[u] === st) continue;
    if (HTOP >= best) break;
    A.cl[u] = st;
    const gu = A.g[u];
    if (u === na && gu + ta < best) { best = gu + ta; end = u; }
    if (u === nb && gu + tb < best) { best = gu + tb; end = u; }
    for (let i = AS[u], e2 = AS[u + 1]; i < e2; i++) {
      const e = AE[i], v = EA[e] === u ? EB[e] : EA[e];
      if (A.cl[v] === st) continue;
      const ng = gu + EW[e];
      if (A.st[v] !== st || ng < A.g[v]) {
        A.st[v] = st; A.g[v] = ng; A.pr[v] = e;
        hpush(v, ng + 0.98 * Math.hypot(X[v] - tx, Y[v] - ty));
      }
    }
  }
  return end === -1 ? null : {cost: best, end};
}

// Points of edge k from geometry distance t0 to t1 (either direction), flat [x,y,...]
function sub(k, t0, t1) {
  const {EP, PX, PY, PC} = G;
  const a = EP[k], b = EP[k + 1] - 1, out = [];
  const at = tt => {
    for (let p = a; p < b; p++) {
      if (tt <= PC[p + 1] || p === b - 1) {
        const L = PC[p + 1] - PC[p], u = L > 0 ? Math.min(1, Math.max(0, (tt - PC[p]) / L)) : 0;
        out.push(PX[p] + u * (PX[p + 1] - PX[p]), PY[p] + u * (PY[p + 1] - PY[p]));
        return;
      }
    }
  };
  at(t0);
  if (t0 <= t1) { for (let p = a; p <= b; p++) if (PC[p] > t0 && PC[p] < t1) out.push(PX[p], PY[p]); }
  else { for (let p = b; p >= a; p--) if (PC[p] < t0 && PC[p] > t1) out.push(PX[p], PY[p]); }
  at(t1);
  return out;
}

function pieces(s, t, res) {
  const {A, EA, EB, EG, EM} = G;
  const out = [];
  const add = (k, t0, t1, n0, n1) => {
    const m = EG[k] > 0 ? EM[k] * Math.abs(t1 - t0) / EG[k] : (t0 === t1 ? 0 : EM[k]);
    out.push({k, t0, t1, n0, n1, m, pts: sub(k, t0, t1)});
  };
  if (res.end === -2) { add(s.k, s.t, t.t, -1, -1); return out; }
  const chain = [];
  let u = res.end;
  while (A.pr[u] !== -1) {
    const e = A.pr[u], v = EA[e] === u ? EB[e] : EA[e];
    chain.push([e, v, u]); u = v;
  }
  add(s.k, s.t, u === EA[s.k] ? 0 : EG[s.k], -1, u);
  for (let i = chain.length - 1; i >= 0; i--) {
    const [e, from, to] = chain[i], fwd = from === EA[e];
    add(e, fwd ? 0 : EG[e], fwd ? EG[e] : 0, from, to);
  }
  add(t.k, res.end === EA[t.k] ? 0 : EG[t.k], t.t, res.end, -1);
  return out;
}

const bearing = (dx, dy) => (Math.atan2(dx, dy) / RAD + 360) % 360;
const turnD = (b1, b2) => ((b2 - b1 + 540) % 360) - 180;
// bearing leaving the start of a flat point list / arriving at its end, over ~20 m
function headOut(pts) {
  const x = pts[0], y = pts[1];
  for (let i = 2; i < pts.length; i += 2) if (Math.hypot(pts[i] - x, pts[i + 1] - y) >= 20 || i === pts.length - 2) return bearing(pts[i] - x, pts[i + 1] - y);
  return null;
}
function headIn(pts) {
  const n = pts.length, x = pts[n - 2], y = pts[n - 1];
  for (let i = n - 4; i >= 0; i -= 2) if (Math.hypot(x - pts[i], y - pts[i + 1]) >= 20 || i === 0) return bearing(x - pts[i], y - pts[i + 1]);
  return null;
}
function compass(b, x, y) {
  if (inPoly(x, y, GRID)) return ['north', 'east', 'south', 'west'][Math.round((((b - 29) % 360) + 360) % 360 / 90) % 4];
  return ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(b / 45) % 8];
}

function labelOf(pc) {
  const {EF, EN, names} = G, f = EF[pc.k], ni = EN[pc.k], nm = names[ni];
  if (f & 4 && nm === 'steps') return 'steps';
  const bn = bridgeName(nm);
  if (bn) return 'bridge:' + (/^Bridge No/.test(bn) ? 'footbridge' : bn);
  if (f & 2 && ni === 0) return 'bridge:footbridge';
  if (f & 1) {
    const i = Math.floor(pc.pts.length / 4) * 2, x = pc.pts[i], y = pc.pts[i + 1];
    for (const [pn, pp] of PARKS) if (inPoly(x, y, pp)) return 'park:' + pn;
  }
  if (ni === 0) return 'path';
  // "" (and any leftover 'Unnamed St' placeholder) is a street without a name
  if (!nm || /^unnamed\b/i.test(nm)) return f & 1 ? 'path' : 'street';
  return 'st:' + nm;
}
const sameLab = (a, b) => a === b || (a.startsWith('st:') && b.startsWith('st:') && baseName(a.slice(3)) === baseName(b.slice(3)));

function buildSteps(P, dS, dT) {
  let gs = [];
  for (const pc of P) {
    if (pc.pts.length < 4 || (pc.m < 0.5 && P.length > 1)) continue;
    const lab = labelOf(pc), last = gs[gs.length - 1];
    if (last && sameLab(last.lab, lab)) {
      if (last.lab !== lab) last.disp = baseName(lab.slice(3));
      last.m += pc.m; last.pts.push(...pc.pts);
    } else gs.push({lab, m: pc.m, pts: pc.pts.slice()});
  }
  if (!gs.length) return [];
  gs[0].m += dS; gs[gs.length - 1].m += dT;
  // fold tiny bits (<20 m, or <60 m between two bits of the same street or park) into a
  // neighbour, then re-join equal neighbours
  for (let guard = 0; gs.length > 1 && guard < 200; guard++) {
    let i = gs.findIndex(g => g.m < 20);
    if (i < 0) i = gs.findIndex((g, j) => j > 0 && j < gs.length - 1 && g.m < 60 && sameLab(gs[j - 1].lab, gs[j + 1].lab));
    if (i < 0) break;
    const g = gs[i];
    if (i === 0) { const n = gs[1]; n.m += g.m; n.pts = g.pts.concat(n.pts); }
    else { const p = gs[i - 1]; p.m += g.m; p.pts.push(...g.pts); }
    gs.splice(i, 1);
    for (let j = gs.length - 1; j > 0; j--) {
      if (sameLab(gs[j - 1].lab, gs[j].lab)) {
        if (gs[j - 1].lab !== gs[j].lab) gs[j - 1].disp = baseName(gs[j].lab.slice(3));
        gs[j - 1].m += gs[j].m; gs[j - 1].pts.push(...gs[j].pts); gs.splice(j, 1);
      }
    }
  }
  return gs.map((g, i) => {
    const sep = g.lab.indexOf(':'), kind = sep < 0 ? g.lab : g.lab.slice(0, sep);
    let nm = g.disp || (sep < 0 ? '' : g.lab.slice(sep + 1));
    if (/^High Line\b/.test(nm)) nm = 'the ' + nm;
    // only the generic labels read lower case ('the footbridge'); 'E 103rd St Footbridge' keeps its capitals
    const br = nm === 'footbridge' || nm === 'Pedestrian bridge' ? nm.toLowerCase() : nm;
    const out = headOut(g.pts) ?? 0;
    let text, icon;
    if (i === 0) {
      const c = compass(out, g.pts[0], g.pts[1]);
      if (kind === 'park') { text = `Head ${c} through ${nm}`; icon = 'leaf'; }
      else if (kind === 'bridge') { text = `Head ${c} across the ${br}`; icon = 'route'; }
      else if (kind === 'steps') { text = `Head ${c} up the steps`; icon = 'stairs'; }
      else if (kind === 'path') { text = `Head ${c} on the path`; icon = 'navigation'; }
      else if (kind === 'street') { text = `Head ${c}`; icon = 'navigation'; }
      else { text = `Head ${c} on ${nm}`; icon = 'navigation'; }
    } else {
      const d = turnD(headIn(gs[i - 1].pts) ?? out, out), a = Math.abs(d), side = d < 0 ? 'left' : 'right';
      const [T, ti] = a < 25 ? ['Continue', 'arrow-up'] : a < 60 ? [`Bear ${side}`, `arrow-bear-${side}`]
        : a < 150 ? [`Turn ${side}`, `corner-up-${side}`] : [`Turn sharp ${side}`, `arrow-sharp-turn-${side}`];
      if (kind === 'park') { text = `Enter ${nm} and follow the path`; icon = 'leaf'; }
      else if (kind === 'bridge') { text = `Cross the ${br}`; icon = 'route'; }
      else if (kind === 'steps') { text = 'Take the steps'; icon = 'stairs'; }
      else if (kind === 'path') { text = a < 25 ? 'Follow the path' : `${T} onto the path`; icon = ti; }
      else if (kind === 'street') { text = a < 25 ? 'Continue straight' : `${T} onto the side street`; icon = ti; }
      else { text = `${T} onto ${nm}`; icon = ti; }
    }
    return {text, m: Math.round(g.m), icon};
  });
}

// signalled avenue crossings: going straight through a node where a major street crosses
function crossings(P) {
  const {AS, AE, EN, EF, MJ, BN} = G;
  let n = 0;
  for (let i = 0; i < P.length - 1; i++) {
    const v = P[i].n1, a = P[i], b = P[i + 1];
    if (v < 0 || a.pts.length < 4 || b.pts.length < 4) continue;
    const pa = a.pts, pb = b.pts, la = pa.length;
    const d = Math.abs(turnD(bearing(pa[la - 2] - pa[la - 4], pa[la - 1] - pa[la - 3]), bearing(pb[2] - pb[0], pb[3] - pb[1])));
    if (d > 35) continue;
    const n1 = BN[EN[a.k]], n2 = BN[EN[b.k]];
    for (let j = AS[v]; j < AS[v + 1]; j++) {
      const e = AE[j];
      if (e === a.k || e === b.k || EF[e] & 1 || !MJ[EN[e]]) continue;
      const nm = BN[EN[e]];
      if (nm !== n1 && nm !== n2) { n++; break; }
    }
  }
  return n;
}

function offline(a, b, why) {
  const m = gd(a, b) * 1.3, sec = m / SPEED * 60;
  const out = {m: Math.round(m), min: walkMin(sec), sec, path: [], steps: [], onGraph: false, bridges: []};
  if (m > 1) {
    const c = compass(bearing(px(b.lon) - px(a.lon), py(b.lat) - py(a.lat)), px(a.lon), py(a.lat));
    out.steps = [{text: `Head ${c}${why ? ' · ' + why : ''}`, m: out.m, icon: 'compass'}];
  }
  return out;
}

// Walk between two points. A snap may be passed in for either end (station entrances).
function walkCore(a, b, sa, sb) {
  if (!G) return offline(a, b, 'street map not loaded');
  const ax = px(a.lon), ay = py(a.lat), bx = px(b.lon), by = py(b.lat);
  let s = sa || snap(ax, ay, SNAP_M), t = sb || snap(bx, by, SNAP_M);
  if (!s || !t) return offline(a, b, 'no street map here');
  const {CO, EA} = G;
  if (CO[EA[s.k]] !== CO[EA[t.k]]) {
    const t2 = snap(bx, by, SNAP_M, CO[EA[s.k]]), s2 = snap(ax, ay, SNAP_M, CO[EA[t.k]]);
    if (t2 && (!s2 || t2.d <= s2.d)) t = t2;
    else if (s2) s = s2;
    else return null;
  }
  const res = astar(s, t);
  if (!res) return null;
  const P = pieces(s, t, res);
  let m = s.d + t.d, stepsM = 0;
  for (const pc of P) { m += pc.m; if (G.EF[pc.k] & 4) stepsM += pc.m; }
  const cross = crossings(P);
  const sec = (m + (STEP_X - 1) * stepsM) / SPEED * 60 + CROSS_S * cross;
  const path = [], bridges = [];   // bridges: [i0, i1] index ranges of path on a bridge deck
  const put = (x, y) => {
    const q = ll(x, y), l = path[path.length - 1];
    if (!l || l[0] !== q[0] || l[1] !== q[1]) path.push(q);
  };
  if (s.d > 1) path.push([+a.lat, +a.lon]);
  for (const pc of P) {
    if (pc.pts.length < 2) continue;
    put(pc.pts[0], pc.pts[1]);
    const i0 = path.length - 1;
    for (let i = 2; i < pc.pts.length; i += 2) put(pc.pts[i], pc.pts[i + 1]);
    const i1 = path.length - 1, lb = bridges[bridges.length - 1];
    if (G.EF[pc.k] & 2 && i1 > i0) { if (lb && lb[1] === i0) lb[1] = i1; else bridges.push([i0, i1]); }
  }
  if (t.d > 1) path.push([+b.lat, +b.lon]);
  return {m: Math.round(m), min: walkMin(sec), sec, path, bridges, steps: buildSteps(P, s.d, t.d), onGraph: true, cross};
}

// Dijkstra from a point out to maxC (cost metres); costs to every entrance usable from it.
function entCosts(pt, maxC, exit) {
  const E = S.E, out = new Float64Array(E.n).fill(Infinity);
  const x = px(pt.lon), y = py(pt.lat);
  const s = G && snap(x, y, SNAP_M);
  const usable = e => exit ? !E.nx[e] : !E.x[e];
  if (!s) {
    for (let e = 0; e < E.n; e++) if (usable(e)) { const c = 1.3 * Math.hypot(E.X[e] - x, E.Y[e] - y); if (c <= maxC) out[e] = c; }
    return out;
  }
  const {D, EA, EB, EW, AS, AE, CO} = G;
  const st = ++G.stamp, lim = maxC - s.d;
  HL = 0;
  const seed = (n, c) => { if (D.st[n] !== st || c < D.g[n]) { D.st[n] = st; D.g[n] = c; hpush(n, c); } };
  seed(EA[s.k], EW[s.k] * s.f);
  seed(EB[s.k], EW[s.k] * (1 - s.f));
  while (HL) {
    const u = hpop();
    if (D.cl[u] === st) continue;
    if (HTOP > lim) break;
    D.cl[u] = st;
    const gu = D.g[u];
    for (let i = AS[u]; i < AS[u + 1]; i++) {
      const e = AE[i], v = EA[e] === u ? EB[e] : EA[e], ng = gu + EW[e];
      if (D.cl[v] !== st && ng <= lim && (D.st[v] !== st || ng < D.g[v])) { D.st[v] = st; D.g[v] = ng; hpush(v, ng); }
    }
  }
  const comp = CO[EA[s.k]];
  const gAt = n => D.cl[n] === st ? D.g[n] : Infinity;
  for (let e = 0; e < E.n; e++) {
    if (!usable(e)) continue;
    const k = E.k[e];
    let c;
    if (k < 0) c = 1.3 * Math.hypot(E.X[e] - x, E.Y[e] - y);
    else if (CO[EA[k]] !== comp) continue;
    else {
      c = Math.min(gAt(EA[k]) + EW[k] * E.f[e], gAt(EB[k]) + EW[k] * (1 - E.f[e]));
      if (k === s.k) c = Math.min(c, EW[k] * Math.abs(E.f[e] - s.f));
      c += E.d[e] + s.d;
    }
    if (c <= maxC) out[e] = c;
  }
  return out;
}

// ---------- subway ----------
function loadSub(s) {
  const stops = s.stops, nS = stops.length, cx = s.complexes;
  const CSt = cx.map(() => []);
  stops.forEach((st, i) => { if (CSt[st.c]) CSt[st.c].push(i); });
  const en = s.entrances, n = en.length;
  const E = {n, list: en, c: new Int32Array(n), s: new Int32Array(n), x: new Uint8Array(n), nx: new Uint8Array(n),
    X: new Float64Array(n), Y: new Float64Array(n), k: new Int32Array(n).fill(-1), f: new Float64Array(n), d: new Float64Array(n), sn: []};
  en.forEach((e, i) => {
    E.c[i] = e.c; E.s[i] = e.s == null ? -1 : e.s; E.x[i] = e.x ? 1 : 0; E.nx[i] = e.nx ? 1 : 0;
    E.X[i] = px(e.lon); E.Y[i] = py(e.lat);
    const sn = G && snap(E.X[i], E.Y[i], SNAP_M);
    E.sn[i] = sn;
    if (sn) { E.k[i] = sn.k; E.f[i] = sn.f; E.d[i] = sn.d; }
  });
  const P = s.patterns, nP = P.length;
  const lineOf = r => (s.routes[r] && s.routes[r].line) || r;
  const PG = P.map(p => lineOf(p.route)), PS = P.map(p => Int32Array.from(p.stops));
  const CUM = P.map(p => { const c = new Float64Array(p.stops.length); for (let i = 1; i < c.length; i++) c[i] = c[i - 1] + (p.run[i - 1] || 0); return c; });
  const POS = new Int16Array(nP * nS);  // index + 1, 0 = not served
  const SP = Array.from({length: nS}, () => []);
  P.forEach((p, q) => p.stops.forEach((st, i) => { if (!POS[q * nS + st]) POS[q * nS + st] = i + 1; SP[st].push(q, i); }));
  // same-line patterns that serve stops[i] and then stops[i+1]: the trains you could take
  const PQ = P.map((p, q) => p.stops.map((st, i) => {
    const out = [];
    if (i === p.stops.length - 1) return out;
    const nx = p.stops[i + 1], l = SP[st];
    for (let j = 0; j < l.length; j += 2) {
      const r = l[j], ri = l[j + 1];
      if (PG[r] === PG[q] && POS[r * nS + nx] > ri + 1) out.push(r, ri);
    }
    return out;
  }));
  // transfers: listed ones, then 3 min for any other pair inside a complex (and a stop to itself)
  const TR = Array.from({length: nS}, () => new Map());
  for (const [a, b, sec] of s.transfers || []) if (a < nS && b < nS) TR[a].set(b, sec);
  CSt.forEach(l => l.forEach(a => l.forEach(b => { if (!TR[a].has(b)) TR[a].set(b, XFER_DEF); })));
  const TRL = TR.map(m => [...m]);
  S = {raw: s, nS, stops, cx, CSt, E, P, nP, PG, PS, CUM, POS, SP, PQ, TR, TRL, routes: s.routes, hops: s.hops || {}, hopC: new Map()};
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let nyF = null;
function nyClock(d) {
  nyF = nyF || new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23'});
  const p = {};
  nyF.formatToParts(d).forEach(x => { p[x.type] = x.value; });
  return {wd: DAYS.indexOf(p.weekday), sec: (+p.hour % 24) * 3600 + +p.minute * 60 + +p.second};
}
// trains per hour of pattern q at its stop index qi, at tAbs seconds after NY midnight of day wd0
function tph(q, qi, tAbs, wd0) {
  let t = tAbs - S.CUM[q][qi];
  const d = Math.floor(t / 86400);
  t -= d * 86400;
  const wd = (((wd0 + d) % 7) + 7) % 7;
  const T = S.P[q].tph[wd === 0 ? 'su' : wd === 6 ? 'sa' : 'wk'];
  return (T && T[Math.floor(t / 3600)]) || 0;
}

// Frequency-based RAPTOR: exactly k rides in round k. -> journeys [{k, total, legs:[{p,bi,j,b,a}]}]
function raptor(acc, egr, T0, wd0, ban) {
  const {nS, nP, PS, CUM, PG, PQ, TRL} = S;
  const K = RIDES, sz = (K + 1) * nS;
  const tau = new Float64Array(sz).fill(Infinity), rho = new Float64Array(sz).fill(Infinity);
  const tP = new Int32Array(sz), tB = new Int32Array(sz), tJ = new Int32Array(sz), rF = new Int32Array(sz).fill(-1);
  rho.set(acc, 0);
  const out = [];
  for (let k = 1; k <= K; k++) {
    let any = false;
    const base = k * nS, prev = (k - 1) * nS;
    for (let p = 0; p < nP; p++) {
      if (ban.has(PG[p])) continue;
      const st = PS[p], cum = CUM[p], L = st.length, pq = PQ[p];
      let ride = false, dep0 = 0, bi = -1;
      for (let i = 0; i < L; i++) {
        const s = st[i];
        if (ride) {
          const arr = dep0 + cum[i] - cum[bi], ix = base + s;
          if (arr < tau[ix]) { tau[ix] = arr; tP[ix] = p; tB[ix] = bi; tJ[ix] = i; any = true; }
        }
        if (i < L - 1) {
          const r = rho[prev + s];
          if (r < Infinity && tph(p, i, T0 + r, wd0) > 0) {
            let n = 0;
            const l = pq[i];
            for (let j = 0; j < l.length; j += 2) n += tph(l[j], l[j + 1], T0 + r, wd0);
            const dep = r + Math.min(WAIT_CAP, 1800 / Math.max(n, 1));
            if (!ride || dep < dep0 + cum[i] - cum[bi]) { ride = true; dep0 = dep; bi = i; }
          }
        }
      }
    }
    if (!any) break;
    let best = Infinity, bs = -1;
    for (let s = 0; s < nS; s++) {
      if (egr[s] === Infinity) continue;
      const v = tau[base + s] + egr[s];
      if (v < best) { best = v; bs = s; }
    }
    if (bs >= 0) {
      const legs = [];
      let cur = bs;
      for (let r = k; r >= 1; r--) {
        const ix = r * nS + cur, p = tP[ix], bi = tB[ix];
        const b = PS[p][bi];
        legs.unshift({p, bi, j: tJ[ix], b, a: cur});
        if (r > 1) cur = rF[(r - 1) * nS + b];
      }
      out.push({k, total: best, legs});
    }
    if (k < K) {
      for (let s = 0; s < nS; s++) {
        const a = tau[base + s];
        if (a === Infinity) continue;
        for (const [t, sec] of TRL[s]) {
          const v = a + sec;
          if (v < rho[base + t]) { rho[base + t] = v; rF[base + t] = s; }
        }
      }
    }
  }
  return out;
}

const rinfo = id => {
  const r = (S && S.routes[id]) || FALLBACK[id] || null;
  const line = (r && r.line) || id;
  const hex = v => /^[0-9a-f]{6}$/i.test(v || '') ? '#' + v.toUpperCase() : null;
  return {id, line, short: r ? (r.line || r.short || id) : String(id || '?'), color: (r && hex(r.color)) || '#7C858C',
    text: (r && hex(r.text)) || '#FFFFFF', diamond: !!(r && r.line)};
};
// MTA classic colours (same as tools/subway_build.py CLASSIC) for badges drawn before subway.json has loaded
const FALLBACK = (() => {
  const o = {}, put = (ids, color, text = 'FFFFFF') => ids.split(' ').forEach(i => { o[i] = {short: i, color, text}; });
  put('1 2 3', 'EE352E'); put('4 5 6', '00933C'); put('7', 'B933AD'); put('A C E', '0039A6'); put('B D F M', 'FF6319');
  put('G', '6CBE45'); put('J Z', '996633'); put('L', 'A7A9AC'); put('N Q R W', 'FCCC0A', '000000');
  o.GS = {short: 'S', color: '808183', text: 'FFFFFF'}; o.FS = o.GS; o.H = o.GS;
  o.SI = {short: 'SIR', color: '08179C', text: 'FFFFFF'};
  o['6X'] = {short: '6X', line: '6', color: '00933C', text: 'FFFFFF'}; o['7X'] = {short: '7X', line: '7', color: 'B933AD', text: 'FFFFFF'};
  return o;
})();
const trainWord = id => { const r = rinfo(id); return r.short === 'SIR' ? 'SIR' : r.short === 'S' ? 'S shuttle' : `${r.short} train`; };
// "4 or 5 train", "N, Q or R train" when a leg's alt lines make the same trip
const linesWord = l => {
  const sh = [...new Set([l.route, ...(l.alt || [])].map(id => rinfo(id).short))];
  if (sh.length < 2 || sh.some(x => x === 'S' || x === 'SIR')) return trainWord(l.route);
  return `${sh.slice(0, -1).join(', ')} or ${sh[sh.length - 1]} train`;
};

function hopPath(a, b) {
  const lo = Math.min(a, b), hi = Math.max(a, b), key = lo + '-' + hi;
  let pts = S.hopC.get(key);
  if (!pts) {
    const h = S.hops[key];
    if (h && h.length >= 4) {
      pts = [];
      let la = 0, lo2 = 0;
      for (let i = 0; i < h.length; i += 2) { la += h[i]; lo2 += h[i + 1]; pts.push([la / 1e5, lo2 / 1e5]); }
    } else pts = [[S.stops[lo].lat, S.stops[lo].lon], [S.stops[hi].lat, S.stops[hi].lon]];
    S.hopC.set(key, pts);
  }
  return a === lo ? pts : pts.slice().reverse();
}
function ridePath(p, bi, j) {
  const st = S.PS[p], out = [];
  for (let i = bi; i < j; i++) {
    const seg = hopPath(st[i], st[i + 1]);
    for (let k = out.length ? 1 : 0; k < seg.length; k++) out.push(seg[k]);
  }
  return out;
}
const stopRef = i => { const s = S.stops[i]; return {stop: s.id, name: dash(s.name), lat: s.lat, lon: s.lon}; };
const entRef = e => { const x = S.E.list[e]; return {lat: x.lat, lon: x.lon, type: x.type, ...(x.ada ? {ada: 1} : {})}; };

// Platform direction label for a ride, or '' when it would not help: the per-route label
// (stops[].nsr) wins over the platform's, 'Outbound'/'Inbound'/'Last Stop' say nothing to a
// visitor, and 'Grand Central' before 'toward Grand Central–42 St' only repeats the headsign.
const GENERIC_DIR = /^(outbound|inbound|last stop)$/i;
const normName = x => String(x || '').toLowerCase().replace(/\bsquare\b/g, 'sq').replace(/[^a-z0-9]+/g, ' ').trim();
function dirLabel(st, p) {
  const i = p.dir === 'N' ? 0 : 1, r = st.nsr && st.nsr[p.route];
  const lab = ((r ? r[i] : st.ns && st.ns[i]) || '').trim();
  if (!lab || GENERIC_DIR.test(lab)) return '';
  const a = normName(lab), h = normName(p.headsign);
  return h === a || h.startsWith(a + ' ') ? '' : lab;
}

// Exact times for one journey: waits and ride times from every train that runs between the two
// stops with the same number of stops (so 4/5 express and the 6 local are never one leg).
function exact(J, T0, wd0, wAcc, wEgr, from, to) {
  const {P, PG, POS, SP, CUM, nS, TR} = S;
  let t = T0 + wAcc.sec + IN_S, wait = 0, ride = 0, xfer = 0;
  const legs = [{kind: 'walk', m: wAcc.m, min: wAcc.min, path: wAcc.path, bridges: wAcc.bridges || [], steps: wAcc.steps, onGraph: wAcc.onGraph,
    from: {name: (from && from.name) || 'Start'}, to: {name: dash(S.stops[J.legs[0].b].name), entrance: entRef(J.accE)}}];
  const sig = [];
  for (let m = 0; m < J.legs.length; m++) {
    const L = J.legs[m];
    if (m > 0) {
      const pa = J.legs[m - 1].a, x = pa === L.b ? (TR[pa].get(pa) ?? XFER_DEF) : (TR[pa].get(L.b) ?? XFER_DEF);
      t += x; xfer += x;
      const c = S.cx[S.stops[L.b].c];
      legs.push({kind: 'transfer', at: dash(pa === L.b ? S.stops[pa].name : (c && c.name) || S.stops[L.b].name), min: Math.max(1, Math.round(x / 60)),
        ...(pa === L.b && x < 60 ? {across: true} : {})});
    }
    // trains that serve b then a making the same number of stops, grouped by line
    const byLine = new Map(), l = SP[L.b], cnt = L.j - L.bi;
    for (let i = 0; i < l.length; i += 2) {
      const q = l[i], qb = l[i + 1], qa = POS[q * nS + L.a] - 1;
      if (qa - qb !== cnt) continue;
      const v = tph(q, qb, t, wd0);
      if (!(v > 0)) continue;
      const g = byLine.get(PG[q]) || {n: 0, r: 0, n30: 0, route: null, rn: 0};
      g.n += v; g.r += v * (CUM[q][qa] - CUM[q][qb]);
      if (v > g.rn) { g.rn = v; g.route = P[q].route; }
      byLine.set(PG[q], g);
    }
    const own = byLine.get(PG[L.p]);
    if (!own) return null;
    const rideOwn = own.r / own.n;
    const lines = [PG[L.p]];
    for (const [ln, g] of byLine) if (ln !== PG[L.p] && Math.abs(g.r / g.n - rideOwn) <= 120) lines.push(ln);
    let n = 0, rw = 0;
    for (const ln of lines) { const g = byLine.get(ln); n += g.n; rw += g.r; }
    const w = Math.min(WAIT_CAP, 1800 / n), rd = rw / n;
    // service half an hour later, for "every 4–6 min"
    let n30 = 0;
    for (let i = 0; i < l.length; i += 2) {
      const q = l[i], qb = l[i + 1], qa = POS[q * nS + L.a] - 1;
      if (qa - qb === cnt && lines.includes(PG[q])) n30 += tph(q, qb, t + w + 1800, wd0);
    }
    const hw = [Math.max(1, Math.round(60 / n))];
    if (n30 > 0) hw.push(Math.max(1, Math.round(60 / n30)));
    hw.sort((a, b) => a - b);
    const p = P[L.p], ri = rinfo(p.route), st = S.stops[L.b];
    const dirL = dirLabel(st, p), head = dash(p.headsign);
    legs.push({kind: 'ride', route: p.route, alt: lines.slice(1).map(ln => byLine.get(ln).route), short: ri.short, color: ri.color, text: ri.text,
      dir: dirL, headsign: head, toward: (dirL ? dirL + ' · ' : '') + (head ? 'toward ' + head : ''),
      from: stopRef(L.b), to: stopRef(L.a), stops: cnt, wait: Math.round(w / 60), min: Math.max(1, Math.round(rd / 60)),
      every: hw[0] === hw[hw.length - 1] ? [hw[0]] : [hw[0], hw[hw.length - 1]], path: ridePath(L.p, L.bi, L.j)});
    sig.push(L.b + '>' + L.a);
    t += w + rd; wait += w; ride += rd;
  }
  t += OUT_S + wEgr.sec;
  legs.push({kind: 'walk', m: wEgr.m, min: wEgr.min, path: wEgr.path, bridges: wEgr.bridges || [], steps: wEgr.steps, onGraph: wEgr.onGraph,
    from: {name: dash(S.stops[J.legs[J.legs.length - 1].a].name), entrance: entRef(J.egrE)}, to: {name: (to && to.name) || 'Destination'}});
  const total = t - T0, rides = legs.filter(x => x.kind === 'ride');
  return {min: Math.round(total / 60), sec: total, walkMin: wAcc.min + wEgr.min, waitMin: Math.round(wait / 60), rideMin: Math.round(ride / 60),
    transfers: rides.length - 1, summary: rides.map(x => x.short).join(' → '), legs, sig: sig.join('|'), xferMin: Math.round(xfer / 60)};
}

// pick station complexes at one end: up to 6 within 1.3 km, else up to 3 within 2 km
function pickEnds(ec) {
  const E = S.E, best = new Map();
  for (let e = 0; e < E.n; e++) {
    const c = ec[e];
    if (c === Infinity) continue;
    const cx = E.c[e], b = best.get(cx);
    if (b == null || c < b) best.set(cx, c);
  }
  const all = [...best].sort((a, b) => a[1] - b[1]);
  const near = all.filter(x => x[1] <= ACC_M).slice(0, ACC_N);
  return new Set((near.length ? near : all.filter(x => x[1] <= ACC_MAX).slice(0, 3)).map(x => x[0]));
}

function transitFor(from, to, at, walk, max) {
  const {E, CSt, nS} = S;
  const eo = entCosts(from, ACC_MAX, false), ed = entCosts(to, ACC_MAX, true);
  const co = pickEnds(eo), cd = pickEnds(ed);
  if (!co.size || !cd.size) return [];
  const acc = new Float64Array(nS).fill(Infinity), accE = new Int32Array(nS).fill(-1);
  const egr = new Float64Array(nS).fill(Infinity), egrE = new Int32Array(nS).fill(-1);
  const fill = (ec, set, arr, ae, extra) => {
    for (let e = 0; e < E.n; e++) {
      if (ec[e] === Infinity || !set.has(E.c[e])) continue;
      const v = ec[e] / SPEED * 60 + extra;
      for (const s of E.s[e] >= 0 ? [E.s[e]] : CSt[E.c[e]]) if (v < arr[s]) { arr[s] = v; ae[s] = e; }
    }
  };
  fill(eo, co, acc, accE, IN_S);
  fill(ed, cd, egr, egrE, OUT_S);
  const {wd, sec: T0} = nyClock(at);
  // diverse journeys: run again with each line of what we found banned (breadth first, 8 runs)
  const found = new Map(), queue = [[]], tried = new Set();
  for (let runs = 0; queue.length && runs < 8;) {
    const ban = queue.shift(), key = ban.slice().sort().join(',');
    if (tried.has(key)) continue;
    tried.add(key); runs++;
    for (const J of raptor(acc, egr, T0, wd, new Set(ban))) {
      const lines = J.legs.map(l => S.PG[l.p]);
      if (lines.some((x, i) => i && x === lines[i - 1])) continue;
      const sig = J.legs.map(l => `${l.b}>${l.a}:${S.PG[l.p]}`).join('|');
      if (found.has(sig)) continue;
      J.accE = accE[J.legs[0].b]; J.egrE = egrE[J.legs[J.legs.length - 1].a];
      found.set(sig, J);
      for (const ln of new Set(lines)) queue.push([...ban, ln]);
    }
  }
  // exact walking for the entrances actually used
  const wc = new Map();
  const wAt = (e, exit) => {
    const key = (exit ? 'x' : 'a') + e;
    if (!wc.has(key)) {
      const en = S.E.list[e], ep = {lat: en.lat, lon: en.lon}, sn = S.E.sn[e];
      const w = exit ? walkCore(ep, to, sn || null, null) : walkCore(from, ep, null, sn || null);
      wc.set(key, w || offline(exit ? ep : from, exit ? to : ep));
    }
    return wc.get(key);
  };
  let opts = [];
  const seen = new Set();
  for (const J of found.values()) {
    if (J.accE < 0 || J.egrE < 0) continue;
    const o = exact(J, T0, wd, wAt(J.accE, false), wAt(J.egrE, true), from, to);
    if (!o || seen.has(o.sig)) continue;
    seen.add(o.sig);
    o.arrive = new Date(at.getTime() + o.sec * 1000);
    opts.push(o);
  }
  opts.sort((a, b) => a.sec - b.sec || a.transfers - b.transfers);
  // one option per route sequence; drop ones slower than a simpler one, or far slower than the best
  // a change of trains has to save 3+ min over a trip with fewer changes
  const kept = [], bySum = new Set();
  for (const o of opts) {
    if (bySum.has(o.summary)) continue;
    if (opts.some(k => k.transfers < o.transfers && k.sec <= o.sec + 180)) continue;
    if (kept.length && o.min > kept[0].min + 20) continue;
    bySum.add(o.summary); kept.push(o);
  }
  opts = kept.filter(o => !walk || walk.min > 25 || o.min <= walk.min - 3).slice(0, max);
  opts.forEach(o => { delete o.sig; delete o.sec; });
  return opts;
}

function nearList(p, n, exit) {
  if (!S || !isPt(p) || gd(p, MID) > FAR_M) return [];
  const pick = ec => {
    const best = new Map();
    for (let e = 0; e < S.E.n; e++) {
      const c = ec[e];
      if (c === Infinity) continue;
      const b = best.get(S.E.c[e]);
      if (!b || c < b[1]) best.set(S.E.c[e], [e, c]);
    }
    return [...best].sort((a, b) => a[1][1] - b[1][1]);
  };
  let l = pick(entCosts(p, 1500, exit));
  if (l.length < n) l = pick(entCosts(p, 3000, exit));
  if (l.length < n && !(G && snap(px(p.lon), py(p.lat), SNAP_M))) l = pick(entCosts(p, 8000, exit));
  return l.slice(0, n).map(([c, [e, cost]]) => {
    const en = S.E.list[e], ep = {lat: en.lat, lon: en.lon}, cx = S.cx[c];
    const w = exit ? walkCore(ep, p, S.E.sn[e] || null, null) : walkCore(p, ep, null, S.E.sn[e] || null);
    const m = w ? w.m : Math.round(cost), min = w ? w.min : walkMin(cost / SPEED * 60);
    return {id: c, name: dash(cx.name), lat: cx.lat, lon: cx.lon, routes: (cx.routes || []).slice(), m, min, entrance: entRef(e)};
  }).sort((a, b) => a.m - b.m);
}

// ---------- public API ----------
function load(w, s) {
  const t0 = Date.now();
  if (w && !G) { loadWalk(w); stats.walkMs = Date.now() - t0; }
  const t1 = Date.now();
  if (s && !S) { loadSub(s); stats.subwayMs = Date.now() - t1; }
}

const ready = () => loading || (loading = (async () => {
  const get = u => fetch(u).then(r => r.ok ? r.json() : null).catch(() => null);
  const [w, s] = await Promise.all([G ? null : get('data/walk.json'), S ? null : get('data/subway.json')]);
  try { load(w, s); } catch (e) { if (N.report) N.report(e, 'route data'); }
  const ok = !!(G && S);
  if (!ok) loading = null;  // try again next time (offline first run)
  return ok;
})());

const walk = (from, to) => {
  if (!isPt(from) || !isPt(to) || gd(from, MID) > FAR_M || gd(to, MID) > FAR_M) return null;
  const w = walkCore({lat: +from.lat, lon: +from.lon}, {lat: +to.lat, lon: +to.lon});
  if (w) delete w.cross;
  return w;
};

const near = (p, n = 3, o = {}) => nearList(p, n, !!(o && o.exit));

// Trains run on subway.json's weekly pattern (weekday / Saturday / Sunday by the hour), so a
// date past the GTFS feed's range already maps to the same weekday inside it. stale says the
// timetable may have changed since (true outside feed.start..feed.end, NY calendar date).
let ymdF = null;
const staleAt = d => {
  const f = S && S.raw.feed;
  if (!f || !f.start || !f.end) return false;
  ymdF = ymdF || new Intl.DateTimeFormat('en-CA', {timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'});
  const ymd = ymdF.format(d).replace(/\D/g, '');
  return ymd < f.start || ymd > f.end;
};

const plan = async (from, to, o = {}) => {
  if (!isPt(from) || !isPt(to)) return null;
  if (gd(from, MID) > FAR_M) return {far: true};
  const at = o.at != null ? new Date(o.at) : N.now();
  const max = o.max != null ? o.max : 3;
  await ready();
  const a = {lat: +from.lat, lon: +from.lon, name: from.name}, b = {lat: +to.lat, lon: +to.lon, name: to.name};
  const w = gd(to, MID) > FAR_M ? offline(a, b) : walkCore(a, b);
  if (w) delete w.cross;
  const look = !!(S && G) && !(w && w.onGraph && w.min <= 6);
  const transit = look ? transitFor(a, b, at, w, max) : [];
  let best;
  if (transit.length) best = !w ? 'transit' : (w.min < 15 || w.min <= transit[0].min + 5) ? 'walk' : 'transit';
  else best = w && w.min <= (w.onGraph ? WALK_MAX : WALK_OFF) ? 'walk' : null;
  const out = {walk: w, transit, best, nearFrom: nearList(a, 3, false), nearTo: nearList(b, 3, true), at, stale: staleAt(at)};
  if (look && !transit.length) out.noTransit = true;
  if (!best) out.tooFar = true;
  return out;
};

const badge = (id, cls = '') => {
  const r = rinfo(id);
  return N.h`<span class="${['rt-b', r.short.length > 2 ? 'rt-bw' : '', r.diamond ? 'rt-bd' : '', cls].filter(Boolean).join(' ')}" style="--rb:${r.color};--rt:${r.text}" role="img" aria-label="${trainWord(id)}"><span>${r.short}</span></span>`;
};

const pickPart = x => !x ? null : x.transit ? (x.best === 'transit' && x.transit[0] ? x.transit[0] : x.walk) : x;

const text = x => {
  x = pickPart(x);
  if (!x) return '';
  if (!x.legs) return x.m != null ? `Walk ${x.min} min (${distText(x.m)})` : '';
  const out = [], L = x.legs;
  L.forEach((l, i) => {
    if (l.kind === 'walk') {
      if (i === 0) out.push(`Walk ${l.min} min to ${(L[1] && L[1].from && L[1].from.name) || l.to.name}`);
      else out.push(`walk ${l.min} min`);
    } else if (l.kind === 'ride') out.push(`${linesWord(l)} ${l.stops} stop${l.stops === 1 ? '' : 's'} to ${l.to.name}`);
  });
  const s = out.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const tok = (name, d) => {
  try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || d; } catch (e) { return d; }
};
// ---------- label placement (screen space) ----------
const SIDES = [['', 0], ['l', 4], ['ur', 8], ['ul', 10], ['dr', 12], ['dl', 14]];
const sideRect = (k, x, y, w, h) => {
  const X = k === '' ? x + 11 : k === 'l' ? x - 11 - w : k === 'ur' || k === 'dr' ? x + 6 : x - 6 - w;
  const Y = k === '' || k === 'l' ? y - h / 2 : k === 'ur' || k === 'ul' ? y - 8 - h : y + 8;
  return [X, Y, X + w, Y + h];
};
const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
// length of segment a-b inside rect r (Liang-Barsky)
const clipLen = (a, b, r) => {
  const dx = b.x - a.x, dy = b.y - a.y, p = [-dx, dx, -dy, dy], q = [a.x - r[0], r[2] - a.x, a.y - r[1], r[3] - a.y];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return 0; continue; }
    const t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) return 0; if (t > t0) t0 = t; } else { if (t < t0) return 0; if (t < t1) t1 = t; }
  }
  return (t1 - t0) * Math.hypot(dx, dy);
};
function placeLabels(map, labels, lines, dots, inset) {
  const size = map.getSize();
  if (!size.x || !size.y) return;
  const [it, ir, ib, il] = Array.isArray(inset) ? inset : [inset || 0, inset || 0, inset || 0, inset || 0];
  const view = [il + 4, it + 4, size.x - ir - 4, size.y - ib - 4];
  const segs = lines.map(({pts, w}) => ({w, pts: pts.map(p => map.latLngToContainerPoint(p))}));
  const taken = dots.map(([lat, lon, r]) => { const c = map.latLngToContainerPoint([lat, lon]); return [c.x - r, c.y - r, c.x + r, c.y + r]; });
  labels.forEach(m => {
    const el = m.getElement && m.getElement(), sp = el && el.firstChild;
    if (!sp || !sp.offsetWidth) return;
    const w = sp.offsetWidth, h = sp.offsetHeight, c = map.latLngToContainerPoint(m.getLatLng());
    let best = null;
    SIDES.forEach(([k, pref]) => {
      const r = sideRect(k, c.x, c.y, w, h), rr = [r[0] - 2, r[1] - 2, r[2] + 2, r[3] + 2];
      let cost = pref + (1 - overlap(r, view) / (w * h)) * 400;
      taken.forEach(t => { cost += overlap(rr, t) * .5; });
      segs.forEach(({w: sw, pts}) => { for (let i = 1; i < pts.length; i++) cost += clipLen(pts[i - 1], pts[i], rr) * sw; });
      if (!best || cost < best[1]) best = [k, cost, r];
    });
    SIDES.forEach(([k]) => k && sp.classList.toggle('rt-lbl-' + k, k === best[0]));
    taken.push(best[2]);
  });
}

const draw = (L, map, part, o = {}) => {
  const g = L.featureGroup();
  const x = pickPart(part);
  if (!x) return g.addTo(map);
  const dark = o.dark != null ? !!o.dark : !!(N.isDark && N.isDark());
  const C = {acc: tok('--eb', dark ? '#9CC0BC' : '#4A706D'), halo: tok('--sheet', dark ? '#1A1E1D' : '#FDFDFD'), ink: tok('--ink', dark ? '#EEEBE2' : '#16191A'),
    road: tok('--tile', dark ? '#2B2E2A' : '#FDFDFD'), edge: tok('--gh', dark ? 'rgba(238,235,226,.20)' : 'rgba(22,25,26,.28)')};
  const legs = x.legs || [{kind: 'walk', path: x.path || [], bridges: x.bridges}];
  const base = {interactive: false, lineCap: 'round', lineJoin: 'round'};
  const has = l => l.path && l.path.length > 1;
  // a change between two platforms of one complex: a short dotted link, so the route reads as one line
  const links = [];
  legs.forEach((l, i) => {
    const p = legs[i - 1], n = legs[i + 1];
    if (l.kind === 'transfer' && p && n && p.to && n.from && (p.to.lat !== n.from.lat || p.to.lon !== n.from.lon))
      links.push({kind: 'link', path: [[p.to.lat, p.to.lon], [n.from.lat, n.from.lon]]});
  });
  const lines = legs.concat(links);
  // bridge decks the walk crosses, as a road-coloured band, so the dotted line is on a bridge
  // and not over open water (the basemap has no bridge walkways)
  const decks = [];
  legs.forEach(l => { if (l.kind === 'walk' && has(l) && l.bridges) l.bridges.forEach(([i, j]) => { if (j > i) decks.push(l.path.slice(i, j + 1)); }); });
  decks.forEach(d => L.polyline(d, {...base, lineCap: 'butt', color: C.edge, weight: 15, opacity: 1}).addTo(g));
  decks.forEach(d => L.polyline(d, {...base, lineCap: 'butt', color: C.road, weight: 12, opacity: 1}).addTo(g));
  lines.forEach(l => {
    if (has(l)) L.polyline(l.path, {...base, color: C.halo, weight: l.kind === 'ride' ? 11 : 9, opacity: dark ? .7 : .9}).addTo(g);
  });
  lines.forEach(l => {
    if (!has(l)) return;
    if (l.kind === 'ride') L.polyline(l.path, {...base, color: l.color, weight: 6, opacity: 1}).addTo(g);
    else L.polyline(l.path, {...base, color: C.acc, weight: 5, opacity: 1, dashArray: '1 9'}).addTo(g);
  });
  const dot = (p, r, fill, stroke, w) => L.circleMarker(p, {interactive: false, radius: r, fillColor: fill, fillOpacity: 1, color: stroke, weight: w, opacity: 1}).addTo(g);
  legs.forEach(l => {
    const en = l.kind === 'walk' && ((l.to && l.to.entrance) || (l.from && l.from.entrance));
    if (en) dot([en.lat, en.lon], 4.5, C.ink, C.halo, 2);
  });
  const rides = legs.filter(l => l.kind === 'ride');
  rides.forEach(l => {
    dot([l.from.lat, l.from.lon], 6.5, C.halo, l.color, 3.5);
    dot([l.to.lat, l.to.lon], 6.5, C.halo, l.color, 3.5);
  });
  const first = legs.find(has), last = [...legs].reverse().find(has);
  if (o.ends !== false && first && last) {
    dot(first.path[0], 7, C.acc, C.halo, 3);
    dot(last.path[last.path.length - 1], 7, C.ink, C.halo, 3);
  }
  if (o.labels !== false && rides.length) {
    const labels = [];
    const lbl = (p, html, plain) => labels.push(L.marker(p, {interactive: false, keyboard: false, zIndexOffset: -1000,
      icon: L.divIcon({className: 'rt-lblw', html: `<span class="rt-lbl${plain ? ' rt-lbl-t' : ''}">${html}</span>`, iconSize: [0, 0], iconAnchor: [0, 0]})}).addTo(g));
    const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
    rides.forEach((l, i) => {
      const bs = [l.route, ...(l.alt || [])].map(badge).join('');
      lbl([l.from.lat, l.from.lon], `${l.alt && l.alt.length ? `<span class="rt-bs">${bs}</span>` : bs}<span class="rt-ln">${esc(l.from.name)}</span>`);
      if (i === rides.length - 1) lbl([l.to.lat, l.to.lon], `<span class="rt-ln">${esc(l.to.name)}</span>`, true);
    });
    // labels pick a side on screen: inside the map (minus o.inset), off the route, off each other
    const segs = lines.filter(has).map(l => ({pts: l.path, w: l.kind === 'ride' ? 1.5 : 1}));
    const dots = [];
    rides.forEach(l => dots.push([l.from.lat, l.from.lon, 9], [l.to.lat, l.to.lon, 9]));
    if (first && last) dots.push([...first.path[0], 9], [...last.path[last.path.length - 1], 9]);
    const place = () => placeLabels(map, labels, segs, dots, o.inset);
    g.on('add', () => { map.on('zoomend moveend resize', place); place(); });
    g.on('remove', () => map.off('zoomend moveend resize', place));
  }
  return g.addTo(map);
};

Object.assign(R, {ready, near, walk, plan, badge, draw, text,
  _load: load, _stats: stats, _ny: nyClock});
})();
