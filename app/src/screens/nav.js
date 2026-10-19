/* Gate-to-gate walking minutes (N.navWalk) and the old #nav links.
     #nav/<code>                         the airport's map on the Airports tab
     #nav/<code>/<from>/<to>[/<via,..>]  the same, routed. from, to and via are POI ids,
                                         gate refs (E12), place kinds or @arr @dep @bag @here
   The map itself lives on the Airports tab (airports.js, drawn by N.airmap). This file
   keeps the walk figure model.js uses, worked out from guide/nav/<CODE>.json, and hands
   any #nav link to the Airports tab in memory: nothing goes in storage or a URL.
   At load time it touches only N.h, N.icon, N.screen, N.report and N.guideFor, so
   updater/navwalk.mjs can run it in a sandbox. Every class in nav.css starts with .na. */
(() => {
const {h} = N;

// ---------- constants (airmap.js uses the same costs) ----------
const SPEED = {walk: 1.3, outside: 1.3, door: 1.3, moving: 2, stairs: .6};   // metres per second
const FIXED = {escalator: 35, elevator: 75, train: 240, security: 900};      // seconds, unless the edge says
const ONE_WAY = new Set(['security', 'exit']);
const RAD = Math.PI / 180;
const minN = s => Math.max(1, Math.round(s / 60));
const normG = s => String(s == null ? '' : s).toUpperCase().replace(/\s+/g, '').replace(/^GATE/, '').replace(/^([A-Z]*)0+(\d)/, '$1$2');

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
  const adj = new Map();
  const add = (a, v) => { let l = adj.get(a); if (!l) adj.set(a, l = []); l.push(v); };
  for (const r of nav.graph.edges || []) {
    const a = nodes.get(r[0]), b = nodes.get(r[1]);
    if (!a || !b) continue;
    const e = {a: r[0], b: r[1], m: +r[2] || 0, k: r[3], note: r[4] || null, sec: +r[5] || null};
    add(e.a, {from: e.a, to: e.b, e});
    if (!ONE_WAY.has(e.k)) add(e.b, {from: e.b, to: e.a, e});
  }
  const gates = (nav.pois || []).filter(p => p && p.k === 'gate' && nodes.has(p.node) && p.lat != null);
  P = {nav, nodes, adj, gates};
  cache.set(nav, P);
  return P;
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
// Dijkstra from a to b with a binary heap.
function pathBetween(P, a, b, o) {
  if (!P.nodes.has(a) || !P.nodes.has(b)) return null;
  if (a === b) return {sec: 0};
  const dist = new Map(), H = [];
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
  dist.set(a, 0); push(0, a);
  while (H.length) {
    const [d, n] = pop();
    if (d > dist.get(n)) continue;
    if (n === b) return {sec: d};
    for (const v of P.adj.get(n) || []) {
      const c = cost(P, v, o);
      if (!(c < Infinity)) continue;
      const nd = d + c, od = dist.get(v.to);
      if (od === undefined || nd < od) { dist.set(v.to, nd); push(nd, v.to); }
    }
  }
  return null;
}

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

// Walking minutes between two gates on this airport's map, or null when the map or either
// gate is missing. Needs only the guide data, not a screen.
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

// ---------- #nav links: hand them to the Airports tab ----------
const dec = s => { try { return decodeURIComponent(s); } catch (e) { return s; } };
function parse(param) {
  const [code, from, to, via] = String(param || '').split('?')[0].split('/');
  return {
    code: String(code || '').replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 4),
    from: from ? dec(from).slice(0, 80) : '',
    to: to ? dec(to).slice(0, 80) : '',
    via: via ? via.split(',').map(dec).filter(Boolean).slice(0, 4) : [],
  };
}
N.screen('nav', {
  nav: false, back: 'airports', tone: 'band',
  uses: [],
  title: ctx => `${parse(ctx.param).code || 'Airport'} map`,
  render(ctx) {
    const p = parse(ctx.param);
    return {hero: '', body: h`<div class="na-go gut" role="status"><span class="na-sp" aria-hidden="true"></span>Opening the ${p.code || 'airport'} map</div>`};
  },
  mount(ctx) {
    const p = parse(ctx.param);
    // In memory only; airports.js reads it once and forgets it.
    N.airportRoute = p.from || p.to ? {code: p.code, from: p.from, to: p.to, via: p.via, at: Date.now()} : null;
    const t = setTimeout(() => N.go(p.code ? `airport/${p.code.toLowerCase()}` : 'airports', true), 0);
    return () => clearTimeout(t);
  },
});
})();
