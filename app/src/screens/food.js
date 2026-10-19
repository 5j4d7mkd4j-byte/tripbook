/* Food: the saved Yelp list. Search, quick chips, a filter sheet, four sorts
   and a List | Map view. Route: #food. Cards open #place/<yelp alias>.
   Everything comes from the food data already on the phone. Location from
   N.where stays in memory and is only used for distances and sorting. */
(() => {
'use strict';
const {h, icon} = N;
const KEY = 'nyc.food.state';
const FAR = 60000;          // further than this from every spot: not in NYC yet, distances hidden

// ---------- small, defensive readers (any field can be missing) ----------
const arr = v => Array.isArray(v) ? v.filter(x => x != null && x !== '') : [];
const str = v => typeof v === 'string' ? v.trim() : (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
const strs = v => arr(v).map(str).filter(Boolean);
const okLL = (lat, lon) => num(lat) != null && num(lon) != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
const hasLL = o => !!o && okLL(o.lat, o.lon);
const FD = () => N.food || {};
const placesNow = () => { try { const p = FD().places ? FD().places() : []; return Array.isArray(p) ? p : []; } catch { return []; } };
const safe = (fn, d = '', where = '') => { try { return fn(); } catch (e) { N.report(e, 'food ' + where); return d; } };
// lower case, accents and apostrophes gone, punctuation to spaces: "Bāng!" → "bang", "Hell’s" → "hells"
const fold = s => String(s == null ? '' : s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/['’‘`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const kfmt = n => n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
const titleCase = s => String(s).replace(/[-_]+/g, ' ').replace(/^\w/, c => c.toUpperCase());
// a place's name as people say it: Yelp's "Katz's Delicatessen - New York" is just "Katz's Delicatessen". place.js uses it too.
N.placeName = p => { const n = str(p && p.name); return n.replace(/\s+[-–—|]\s+(new york( city)?|nyc|ny)$/i, '').trim() || n; };

// ---------- types: label, icon, tone ----------
// thumbnail tints only; rose is kept for closed and closing, so no food type wears it
const TONES = {eb: ['--pill', '--pillt'], s4: ['--s4', '--page'], ok: ['--ok', '--page'], ink: ['--ink', '--page']};
const tone = t => { const [a, b] = TONES[t] || TONES.eb; return `--fb:var(${a});--ff:var(${b})`; };
const TYPES = {
  'sit-down': ['Sit-down', 'armchair', 'eb'], casual: ['Casual', 'bowl', 'eb'], 'to-go': ['To go', 'shopping-bag', 's4'],
  'quick-bite': ['Quick bite', 'stopwatch', 's4'], dessert: ['Dessert', 'ice-cream-2', 's4'], coffee: ['Coffee', 'coffee', 's4'],
  bakery: ['Bakery', 'bread', 's4'], brunch: ['Brunch', 'egg-fried', 'ok'], 'late-night': ['Late night', 'moon-stars', 'ink'],
  pizza: ['Pizza', 'pizza', 's4'], sandwiches: ['Sandwiches', 'baguette', 's4'], bar: ['Bar', 'glass-cocktail', 'ink'],
  'date-night': ['Date night', 'sparkles', 'ink'], groups: ['Groups', 'users', 'eb'], outdoor: ['Outdoor', 'sun', 'ok'],
  reservations: ['Reservations', 'calendar-check', 'eb'],
};
const typeInfo = t => TYPES[t] || [titleCase(t), 'tools-kitchen-2', 'eb'];
const CHIP_ORDER = ['sit-down', 'casual', 'to-go', 'quick-bite', 'dessert', 'coffee', 'bakery', 'brunch', 'late-night', 'pizza', 'sandwiches', 'bar', 'date-night', 'groups'];
const NOT_CHIPS = new Set(['reservations', 'outdoor']);   // these two live in the filter sheet
const BADGE_ORDER = ['date-night', 'late-night', 'brunch', 'dessert', 'coffee', 'bakery', 'pizza', 'sandwiches', 'bar', 'outdoor', 'groups', 'reservations', 'sit-down', 'casual', 'quick-bite', 'to-go'];
const PRIMARY = ['pizza', 'bakery', 'dessert', 'coffee', 'sandwiches', 'bar', 'brunch', 'date-night', 'late-night', 'sit-down', 'casual', 'quick-bite', 'to-go', 'groups'];
// these say how you eat, not what: the icon comes from the cuisine instead ("Bar" on a steakhouse is not a cocktail)
const GENERIC = new Set(['bar', 'brunch', 'date-night', 'late-night', 'sit-down', 'casual', 'quick-bite', 'to-go', 'groups']);
// the first cuisine can choose between a place's own food types: "Coffee, Bakery" is a coffee shop that bakes
const LEAD = [[/coffee|espresso|cafe|\btea\b/, 'coffee'], [/bakery|bagel|bread|patisserie/, 'bakery'], [/dessert|ice cream|gelato|chocolate|donut|doughnut/, 'dessert'],
  [/pizza/, 'pizza'], [/sandwich|\bdeli\b/, 'sandwiches']];
const CUISINE_ICON = [[/ramen|noodle|hot ?pot|pho\b|udon|dumpling/, 'bowl-chopsticks'], [/soup/, 'soup'], [/seafood|sushi|fish|oyster|poke/, 'fish'],
  [/bbq|barbe|steak|smokehouse|chicken/, 'meat'], [/burger/, 'burger'], [/salad|healthy|vegan|vegetarian/, 'salad'], [/bagel|bakery|bread|patisserie/, 'bread'],
  [/ice cream|gelato|frozen/, 'ice-cream-2'], [/dessert|chocolate|cake|donut|doughnut/, 'cake'], [/cookie/, 'cookie'], [/pizza/, 'pizza'],
  [/sandwich|\bdeli\b/, 'baguette'], [/coffee|espresso|cafe|\btea\b/, 'coffee'], [/cocktail|wine|beer|\bbar\b|pub\b/, 'glass-cocktail', 'drink']];
// first cuisine, in the place's own order, that names a dish; a bar cuisine counts only when it leads ("Italian, Cocktail Bar" is a restaurant)
const cuisineIcon = cuisine => {
  for (let k = 0; k < cuisine.length; k++) {
    const f = fold(cuisine[k]), hit = CUISINE_ICON.find(([re]) => re.test(f));
    if (hit && (k === 0 || hit[2] !== 'drink')) return hit[1];
  }
  return null;
};
function kindOf(types, cuisine) {
  const lead = fold(cuisine[0]), led = LEAD.find(([re, x]) => re.test(lead) && types.includes(x));
  // a dish type leads only when some cuisine backs it: "Dessert" on a French bistro or a food hall is one thing on the menu
  const all = fold(cuisine.join(' ')), backed = x => { const r = LEAD.find(([, y]) => y === x); return !r || !all || r[0].test(all); };
  const t = (led && led[1]) || PRIMARY.find(x => types.includes(x) && backed(x)) || types.find(x => !NOT_CHIPS.has(x)) || null;
  const [, ic, tn] = t ? typeInfo(t) : [null, 'tools-kitchen-2', 'eb'];
  let i = ic;
  // no dish in the cuisine: an egg or a bowl still reads as food on a pin, a sofa or a stopwatch does not
  if (!t || GENERIC.has(t) || !backed(t)) i = cuisineIcon(cuisine) || (t === 'brunch' || t === 'casual' ? ic : 'tools-kitchen-2');
  else if (t === 'dessert') {   // "Desserts, Ice Cream" is an ice cream shop: the more specific sweet wins
    const c = fold(cuisine.join(' ')), hit = CUISINE_ICON.find(([re, x]) => ['ice-cream-2', 'cake', 'cookie'].includes(x) && re.test(c));
    if (hit) i = hit[1];
  }
  return {type: t, icon: i, tone: tn};
}

// ---------- feature flags from attrs, with the types as a backup ----------
const FEATS = [
  ['reservations', 'Takes reservations', 'calendar-check', p => (p.attrs && p.attrs.reservations === true) || strs(p.types).includes('reservations')],
  ['takeout', 'Takeout', 'shopping-bag', p => (p.attrs && p.attrs.takeout === true) || strs(p.types).includes('to-go')],
  ['outdoor', 'Outdoor seating', 'sun', p => (p.attrs && p.attrs.outdoor === true) || (!(p.attrs && p.attrs.outdoor === false) && strs(p.types).includes('outdoor'))],
];
const MEAL_ORDER = ['breakfast', 'brunch', 'lunch', 'dinner', 'late'];
const MEAL_LABEL = {breakfast: 'Breakfast', brunch: 'Brunch', lunch: 'Lunch', dinner: 'Dinner', late: 'Late night'};
const SORTS = [['best', 'Best match'], ['near', 'Nearest'], ['top', 'Top rated'], ['open', 'Open first']];

// ---------- the model, rebuilt only when the places array changes ----------
let modelSrc = null, MODEL = [], BYID = new Map();
function model() {
  const src = placesNow();
  if (src === modelSrc) return MODEL;
  modelSrc = src;
  MODEL = [];
  src.forEach((p, i) => {
    if (!p || typeof p !== 'object') return;
    const id = str(p.id);
    if (!id) return;
    const name = N.placeName(p) || 'Unnamed spot';
    const types = strs(p.types), cuisine = strs(p.cuisine), meals = strs(p.meals).map(x => x.toLowerCase());
    const order = strs(p.order), popular = arr(p.popular).map(x => str(x && x.name)).filter(Boolean);
    const rating = num(p.rating), reviews = num(p.reviews) || 0;
    const price = /^\$+$/.test(str(p.price)) ? str(p.price) : '';
    const tl = types.map(t => typeInfo(t)[0]);
    const pad = a => ' ' + a.map(fold).filter(Boolean).join('  ') + ' ';
    const m = {p, id, i, name, types, cuisine, meals, order, price, rating, reviews,
      hood: str(p.neighborhood), boro: str(p.borough), lat: num(p.lat), lon: num(p.lon), ll: hasLL(p),
      kind: kindOf(types, cuisine),
      dishes: [...order.map(n => ({n, from: 'Order'})), ...popular.filter(n => !order.includes(n)).map(n => ({n, from: 'Popular'}))],
      bayes: rating == null ? 0 : (rating * reviews + 4.2 * 50) / (reviews + 50),
      feat: Object.fromEntries(FEATS.map(([k, , , fn]) => [k, safe(() => !!fn(p), false)])),
      hr: {state: 'unknown'}, d: null};
    m.ix = {
      name: pad([name]),
      tags: pad([...cuisine, ...types, ...tl, str(p.style)]),
      area: pad([m.hood, m.boro]),
      dish: pad(m.dishes.map(x => x.n)),
      text: pad([str(p.summary), str(p.vibe), ...strs(p.good_for), ...strs(p.menu_sections), ...meals]),
    };
    m.dishIx = m.dishes.map(x => ' ' + fold(x.n) + ' ');
    MODEL.push(m);
  });
  BYID = new Map(MODEL.map(m => [m.id, m]));
  return MODEL;
}
const hasData = () => model().length > 0;

// ---------- saved state ----------
const DEF = () => ({view: 'list', sort: 'best', prevSort: 'best', open: false, top: false, types: [], cuisine: [], price: [], meal: [], area: [], attrs: []});
const GROUPS = ['types', 'cuisine', 'price', 'meal', 'area', 'attrs'];
function load() {
  const s = DEF(), v = N.get(KEY, null);
  if (!v || typeof v !== 'object') return s;
  if (v.view === 'map' || v.view === 'list') s.view = v.view;
  if (SORTS.some(x => x[0] === v.sort)) s.sort = v.sort;
  if (SORTS.some(x => x[0] === v.prevSort) && v.prevSort !== 'near') s.prevSort = v.prevSort;
  s.open = v.open === true; s.top = v.top === true;
  for (const g of GROUPS) s[g] = strs(v[g]).slice(0, 60);
  s.attrs = s.attrs.filter(a => FEATS.some(f => f[0] === a));
  return s;
}
let S = load();
const save = () => N.set(KEY, S);
let Q = '';                   // search text: memory only
let V = null;                 // mounted view state
let MV = null;                // map view state
let SH = null;                // open filter sheet
let R = null;                 // last computed results
let memo = null;              // map position kept while a place is open
let lastY = 0;                // list scroll, kept across tabs and places; a re-tap of the tab still goes to the top
let fromName = '';            // the screen we came from (from the hashchange)
let locating = false, staggerNext = true, qT = 0;
window.addEventListener('hashchange', ev => {
  try { fromName = decodeURIComponent(new URL(ev.oldURL).hash.slice(1)).split('/')[0]; } catch { fromName = ''; }
});

// ---------- search ----------
const tokens = q => fold(q).split(' ').filter(Boolean).slice(0, 8);
function tokScore(m, t) {
  const w = ' ' + t, ix = m.ix;
  return ix.name.includes(w) ? 10 : ix.tags.includes(w) ? 6 : ix.area.includes(w) ? 5 : ix.dish.includes(w) ? 4 : ix.text.includes(w) ? 1 : 0;
}
function match(m, toks) {
  let s = 0;
  const used = [];
  for (const t of toks) {
    let b = tokScore(m, t), u = t;
    if (!b && t.length > 3 && t.endsWith('s')) { u = t.slice(0, -1); b = tokScore(m, u); }
    if (!b) return null;
    s += b; used.push(u);
  }
  if (m.ix.name.startsWith(' ' + used.join(' '))) s += 8;
  let dish = null;
  for (let k = 0; k < m.dishes.length && !dish; k++) if (used.some(u => m.dishIx[k].includes(' ' + u))) dish = m.dishes[k];
  return {s, dish};
}

// ---------- filters ----------
const isOpen = m => m.hr.state === 'open' || m.hr.state === 'closing';
function pass(m, f, skip) {
  if (skip !== 'open' && f.open && !isOpen(m)) return false;
  if (skip !== 'top' && f.top && !(m.rating >= 4.5)) return false;
  if (skip !== 'types') for (const t of f.types) if (!m.types.includes(t)) return false;
  if (skip !== 'cuisine' && f.cuisine.length && !f.cuisine.some(c => m.cuisine.includes(c))) return false;
  if (skip !== 'price' && f.price.length && !f.price.includes(m.price)) return false;
  if (skip !== 'meal' && f.meal.length && !f.meal.some(x => m.meals.includes(x))) return false;
  if (skip !== 'area' && f.area.length && !f.area.some(a => (m.boro && a === 'b:' + m.boro) || (m.hood && a === 'n:' + m.hood))) return false;
  if (skip !== 'attrs') for (const a of f.attrs) if (!m.feat[a]) return false;
  return true;
}
const sheetCount = () => (S.top ? 1 : 0) + S.cuisine.length + S.price.length + S.meal.length + S.area.length + S.attrs.length;
const anyFilter = () => S.open || S.types.length > 0 || sheetCount() > 0;
function hoursOf(m, now) {
  try { const r = FD().hours ? FD().hours(m.p, now) : null; return r && r.state ? r : {state: 'unknown', text: 'Hours not listed', short: ''}; }
  catch { return {state: 'unknown', text: 'Hours not listed', short: ''}; }
}
// open now first, closed last. Best keeps quality order inside each group; Open first
// puts the soonest to close at the top and, once closed, the soonest to open
const OPEN_RANK = {open: 0, closing: 0, unknown: 1, closed: 2};
const byOpen = (a, b) => OPEN_RANK[a.hr.state] - OPEN_RANK[b.hr.state];
const nowKey = m => isOpen(m) ? (m.hr.until == null ? 1e6 : m.hr.until) : m.hr.opensIn == null ? 1e6 : m.hr.opensIn;
const byNow = (a, b) => byOpen(a, b) || (nowKey(a) - nowKey(b));
function compute() {
  const M = model();
  const toks = tokens(Q);
  const here = N.lastWhere ? N.lastWhere() : null;
  const now = N.now();
  let nearest = Infinity;
  for (const m of M) {
    m.hr = hoursOf(m, now);
    m.d = here && hasLL(here) && m.ll ? safe(() => N.dist(here, m), null) : null;
    if (m.d != null && m.d < nearest) nearest = m.d;
  }
  const far = !!here && nearest > FAR;
  const hit = new Map();
  for (const m of M) { const r = toks.length ? match(m, toks) : {s: 0, dish: null}; if (r) hit.set(m.id, r); }
  const base = M.filter(m => hit.has(m.id));
  const list = base.filter(m => pass(m, S));
  const near = S.sort === 'near' && here && !far;
  const by = {
    best: (a, b) => (hit.get(b.id).s - hit.get(a.id).s) || byOpen(a, b) || (b.bayes - a.bayes) || a.i - b.i,
    near: (a, b) => ((a.d == null ? 1e12 : a.d) - (b.d == null ? 1e12 : b.d)) || (b.bayes - a.bayes),
    top: (a, b) => ((b.rating == null ? -1 : b.rating) - (a.rating == null ? -1 : a.rating)) || (b.reviews - a.reviews) || a.i - b.i,
    open: (a, b) => byNow(a, b) || (b.bayes - a.bayes),
  };
  list.sort(by[S.sort === 'near' && !near ? 'best' : S.sort] || by.best);
  R = {M, toks, hit, base, list, here, far, near, openAll: M.filter(isOpen).length};
  return R;
}

// ---------- pieces ----------
function stars(r) {
  const v = Math.round(N.clamp(r, 0, 5) * 2) / 2;
  const s = [1, 2, 3, 4, 5].map(i => icon(v >= i ? 'star-filled' : v >= i - .5 ? 'star-half-filled' : 'star'));
  return h`<span class="fd-stars" role="img" aria-label="${`Rated ${r} out of 5`}">${s}</span>`;
}
// stars, score, review count and price on one line: ★★★★½ 4.6 (10k) · $$
function rateHtml(m) {
  const price = m.price ? h`<span class="fd-mu">· ${m.price}</span>` : '';
  if (m.rating == null) return h`<span class="fd-rt"><span class="fd-mu">No rating yet</span>${price}</span>`;
  return h`<span class="fd-rt">${stars(m.rating)}<b>${m.rating.toFixed(1)}</b>${m.reviews ? h`<span class="fd-mu">(${kfmt(m.reviews)})</span>` : ''}${price}</span>`;
}
function stInfo(hr) {
  switch (hr.state) {
    case 'open': return {c: 'fd-open', t: hr.until == null ? 'Open 24 hours' : hr.short ? 'Open ' + hr.short.replace(/^Till\b/, 'till') : 'Open now'};
    case 'closing': return {c: 'fd-closing', t: hr.text || 'Closing soon'};
    case 'closed': return hr.short && hr.short !== 'Closed' ? {c: 'fd-closed fd-later', t: hr.short} : {c: 'fd-closed', t: 'Closed'};
    default: return {c: 'fd-unk', t: 'Hours not listed'};
  }
}
const stChip = m => { const s = stInfo(m.hr); return h`<span class="${'fd-oc fd-hr ' + s.c}" data-fdst="${m.id}"><span class="fd-od"></span>${s.t}</span>`; };
// "Deli · 0.4 mi", then "● Open till 11p" on a line of its own: what it is and how far (the neighbourhood until we
// know where you are), with the hours always in the same place on every card rather than inline on some and wrapped on others.
const miles = d => d < 160 ? `${Math.round(d / 0.3048 / 10) * 10} ft` : `${(d / 1609.34).toFixed(1)} mi`;
function metaHtml(m) {
  const far = m.d != null && !(R && R.far) ? miles(m.d) : '';
  const at = far || m.hood || m.boro;
  const what = [m.cuisine[0], at].filter(Boolean).join(' · ');
  return h`${what ? h`<span class="fd-meta"><span class="fd-mw">${what}</span></span>` : ''}${stChip(m)}`;
}
// first photo with an id, food shots before inside ones; read here rather than through N.food.cover, which throws on a
// null entry or a non-array list and would log an error for every card of one bad record
const coverId = p => {
  const ph = p && p.photos;
  if (!ph || typeof ph !== 'object') return '';
  for (const k of ['food', 'inside']) for (const x of arr(ph[k])) { const id = str(x && x.id); if (id) return id; }
  return '';
};
const thumbUrl = m => safe(() => { const id = coverId(m.p); return id && FD().photo ? FD().photo(id, '348s') : ''; }, '');
function thumb(m, cls, w, hgt) {
  const u = thumbUrl(m);
  return h`<span class="${cls}" style="${tone(m.kind.tone)}">${icon(m.kind.icon, 'fd-ki')}${u
    ? h`<img src="${u}" alt="" loading="lazy" decoding="async" width="${w}" height="${hgt}" onerror="this.remove()">` : ''}</span>`;
}
// a tag that repeats the cuisine on the line above ("Bakery" under "Bakery", "Bar" under "Cocktail Bars") says nothing new
function echoes(t, cuisine) {
  const c = fold(cuisine), r = LEAD.find(([, x]) => x === t);
  if (!c) return false;
  if (r && r[0].test(c)) return true;
  return new RegExp(`\\b${fold(typeInfo(t)[0]).replace(/s$/, '')}s?\\b`).test(c);
}
// every tag is drawn; fitBadges then folds the ones that don't fit on the line into "+N"
function badges(m) {
  const pri = t => { const a = S.types.indexOf(t); return a >= 0 ? a - 100 : (BADGE_ORDER.indexOf(t) + 1 || 99); };
  const ts = m.types.filter(t => !echoes(t, m.cuisine[0])).sort((a, b) => pri(a) - pri(b));
  if (!ts.length) return '';
  return h`<span class="fd-bdgs">${ts.map(t => { const [l, i] = typeInfo(t); return h`<span class="fd-bdg">${icon(i)}${l}</span>`; })}<span class="fd-bdg fd-plus" hidden></span></span>`;
}
// One read pass for every row's widths, then one write pass, so a long list costs a single layout.
function fitBadges() {
  const rows = $$v('.fd-bdgs').map(r => {
    const bs = N.$$('.fd-bdg:not(.fd-plus)', r);
    bs.forEach(b => { b.hidden = false; });
    return {r, bs, more: N.$('.fd-plus', r)};
  });
  const sized = rows.map(x => ({...x, w: x.r.clientWidth, ws: x.bs.map(b => b.offsetWidth)}));
  for (const {bs, more, w, ws} of sized) {
    if (!w || !more) continue;
    let k = 0, x = 0;
    for (; k < bs.length; k++) {
      const nx = x + (k ? 6 : 0) + ws[k], left = bs.length - k - 1;
      if (nx + (left ? 6 + 36 : 0) > w) break;   // room for "+N" whenever something is left over
      x = nx;
    }
    k = Math.max(1, k);
    bs.forEach((b, i) => { b.hidden = i >= k; });
    more.hidden = k >= bs.length;
    more.textContent = '+' + (bs.length - k);
    more.setAttribute('aria-label', `${bs.length - k} more`);
  }
}
function card(m, i, stagger) {
  const hit = R.hit.get(m.id);
  const dish = hit && hit.dish;
  const ord = dish ? {from: dish.from, t: dish.n} : m.order.length ? {from: 'Order', t: m.order[0]} : null;
  const href = 'place/' + m.id;
  return h`<a class="${N.cls('fd-card', stagger && i < 10 && 'rise')}" href="${'#' + href}" data-act="go" data-arg="${href}"${stagger && i < 10 ? h` style="animation-delay:${Math.min(i, 8) * 35}ms"` : ''}>
    ${thumb(m, 'fd-th', 104, 168)}
    <span class="fd-cb">
      <span class="fd-nm">${m.name}</span>
      ${rateHtml(m)}
      ${metaHtml(m)}
      ${ord ? h`<span class="fd-ord"><b>${ord.from}</b> ${ord.t}</span>` : ''}
      ${badges(m)}
    </span>
  </a>`;
}

// ---------- header ----------
function clockText() {
  return safe(() => { const n = N.nyNow(); return `New York · ${N.dayName(n.day)} ${N.clockText(n.min)}`; }, 'New York', 'clock');
}
function statsHtml() {
  const M = model();
  if (!M.length) return h`<span class="chip ob">${icon('tools-kitchen-2')}No spots loaded yet</span>`;
  // one chip: how many are open, or when the first one opens
  const open = R ? R.openAll : 0;
  if (open) return h`<span class="chip ob" data-fdopen><span class="dot"></span>${M.length} saved · ${open} open now</span>`;
  const nx = R ? R.M.filter(m => m.hr.state === 'closed' && m.hr.opensIn != null).sort((a, b) => a.hr.opensIn - b.hr.opensIn)[0] : null;
  const t = nx && /^Opens\b/.test(nx.hr.short || '') ? nx.hr.short.replace(/^Opens\b/, 'First opens') : '';
  return h`<span class="chip ob" data-fdopen><span class="${N.cls('dot', t ? 'fd-dw' : 'neutral')}"></span>${t || `${M.length} saved · none open now`}</span>`;
}
const heroHtml = () => h`<div class="fd-hero">
  <p class="ey fd-ey" data-fdclock>${clockText()}</p>
  <h1 class="dp fd-big">Food</h1>
  <div class="fd-stats" data-fdstats>${statsHtml()}</div>
</div>`;

// ---------- controls ----------
const searchRow = () => h`<div class="fd-srow">
  <div class="fd-search">
    ${icon('search', 'fd-si')}
    <input class="inp fd-q" type="search" data-input="q" value="${Q}" placeholder="Dish, cuisine or area" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" aria-label="Search saved spots">
    <button class="fd-qx" data-act="fdClearQ" aria-label="Clear search"${Q ? '' : N.raw(' hidden')}>${icon('x')}</button>
  </div>
  <button class="fd-fbtn" data-act="fdSheet" aria-haspopup="dialog" aria-label="${sheetCount() ? `Filters, ${sheetCount()} on` : 'Filters'}">${icon('adjustments-horizontal')}<span class="fd-fn" data-fdfn${sheetCount() ? '' : N.raw(' hidden')}>${sheetCount()}</span></button>
</div>`;
const qc = (act, arg, on, inner, off, label) => h`<button class="fd-qc" data-act="${act}" data-arg="${arg}" aria-pressed="${on ? 'true' : 'false'}"${off ? N.raw(' aria-disabled="true"') : ''}${label ? h` aria-label="${label}"` : ''}><span class="fd-qcp">${inner}</span></button>`;
// The quick chips. One that would find nothing is left out unless it's on; with nothing matching,
// only the ones that are on stay (to turn off) and the empty state offers the rest.
function chipsHtml() {
  if (!R) compute();
  const {base} = R, none = !R.list.length;
  const oBase = base.filter(m => pass(m, S, 'open'));
  const openN = oBase.filter(isOpen).length;
  const out = [(openN && !none) || S.open ? qc('fdOpen', '', S.open, h`<span class="fd-od"></span>Open now<span class="fd-n">${openN}</span>`, false, `Open now, ${openN}`) : '',
    none ? '' : qc('fdNear', '', S.sort === 'near', h`${icon('current-location')}${locating ? 'Locating…' : 'Near me'}`, false)];
  const tBase = base.filter(m => pass(m, S, 'types'));
  const seen = new Map();
  for (const m of R.M) for (const t of m.types) if (!NOT_CHIPS.has(t)) seen.set(t, (seen.get(t) || 0) + 1);
  const order = [...CHIP_ORDER.filter(t => seen.has(t)), ...[...seen.keys()].filter(t => !CHIP_ORDER.includes(t)).sort((a, b) => seen.get(b) - seen.get(a))];
  for (const t of order) {
    const on = S.types.includes(t);
    const need = on ? S.types : [...S.types, t];
    const n = tBase.filter(m => need.every(x => m.types.includes(x))).length;
    if (!on && (!n || none)) continue;
    const [l, i] = typeInfo(t);
    out.push(qc('fdType', t, on, h`${icon(i)}${l}<span class="fd-n">${n}</span>`, false, `${l}, ${n}`));
  }
  return out.filter(Boolean);
}
const chipRow = () => { const c = chipsHtml(); return h`<div class="fd-chips" data-hscroll data-fdchips${c.length ? '' : N.raw(' hidden')}>${c}</div>`; };
const barHtml = () => h`<div class="seg fd-seg" role="group" aria-label="View">
    <button data-act="fdView" data-arg="list" aria-pressed="${S.view === 'list' ? 'true' : 'false'}">${icon('layout-list')}List</button>
    <button data-act="fdView" data-arg="map" aria-pressed="${S.view === 'map' ? 'true' : 'false'}">${icon('map-2')}Map</button>
  </div>
  <label class="fd-sort">${icon('arrows-sort', 'fd-sic')}<select data-input="sort" aria-label="Sort">${SORTS.map(([v, l]) => h`<option value="${v}"${S.sort === v ? N.raw(' selected') : ''}>${l}</option>`)}</select>${icon('chevron-down', 'fd-sch')}</label>`;

// ---------- active filters (removable) ----------
function activeList() {
  const a = [];
  if (S.top) a.push(['top', '1', 'Rated 4.5+']);
  S.price.forEach(v => a.push(['price', v, v]));
  S.meal.forEach(v => a.push(['meal', v, MEAL_LABEL[v] || titleCase(v)]));
  S.attrs.forEach(v => { const f = FEATS.find(x => x[0] === v); a.push(['attrs', v, f ? f[1] : v]); });
  S.cuisine.forEach(v => a.push(['cuisine', v, v]));
  S.area.forEach(v => a.push(['area', v, v.slice(2)]));
  return a;
}
const andList = a => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];

// ---------- results ----------
function noteHtml() {
  if (S.sort !== 'near') return '';
  const w = R.here;
  if (!w) return h`<div class="fd-note">${icon('current-location')}<span class="grow">${locating ? 'Finding where you are…' : 'Nearest needs your location. It stays on this phone.'}</span>${locating ? '' : h`<button class="fd-lnk" data-act="fdLocate">Use my location</button>`}</div>`;
  if (R.far) return h`<div class="fd-note">${icon('current-location')}<span class="grow">You’re not in New York yet, so distances are hidden.</span></div>`;
  const age = num(w.at) ? N.now().getTime() - w.at : 0;
  const at = num(w.at) && age > 180000 ? safe(() => N.clockText(N.nyNow(new Date(w.at)).min), '') : '';
  return h`<div class="fd-note">${icon('current-location')}<span class="grow">${at ? `Distances from where you were at ${at}` : 'Distances from where you are'}</span><button class="fd-lnk" data-act="fdLocate">Update</button></div>`;
}
function emptyData() {
  const off = N.online && !N.online();
  return h`<div class="fd-empty">
    <span class="fd-eic">${icon(off ? 'wifi-off' : 'tools-kitchen-2')}</span>
    <h2 class="h2">No saved spots yet</h2>
    <p>${off ? 'The food list loads with the trip data. You’re offline, so it will come the next time you have signal.' : 'The food list loads with the trip data and then stays on this phone for offline use.'}</p>
    ${off ? '' : h`<button class="btn" data-act="refresh">${icon('refresh')}Check now</button>`}
  </div>`;
}
function noMatch() {
  // Same-group picks match any of them (cuisine, price, meal, area), so say "or" there.
  const grp = {};
  activeList().forEach(([g, , l]) => { (grp[g] = grp[g] || []).push(l); });
  const orG = k => grp[k] ? [grp[k].length > 1 ? grp[k].slice(0, -1).join(', ') + ' or ' + grp[k][grp[k].length - 1] : grp[k][0]] : [];
  const names = [S.open && 'Open now', ...S.types.map(t => typeInfo(t)[0]), ...(grp.top || []), ...orG('price'), ...orG('meal'), ...(grp.attrs || []), ...orG('cuisine'), ...orG('area')].filter(Boolean);
  const q = Q.trim();
  const msg = q && names.length ? `No spots match “${q}” with ${andList(names)}.`
    : q ? `No saved spot mentions “${q}”. Try a dish, a cuisine or a neighborhood.`
    : `No spots fit ${andList(names)}.`;
  let hint = '';
  if (S.open) {
    const others = R.base.filter(m => pass(m, S, 'open'));
    if (others.length) {
      const nx = others.filter(m => m.hr.state === 'closed' && m.hr.opensIn != null).sort((a, b) => a.hr.opensIn - b.hr.opensIn)[0];
      hint = h`<div class="fd-hint">${nx ? h`<p>${icon('clock')}<span>First to open: <b>${nx.name}</b>, ${(nx.hr.short || '').replace(/^Opens\b/, 'opens')}</span></p>` : ''}
        <button class="btn alt" data-act="fdOpen">Show all ${others.length} anyway</button></div>`;
    }
  }
  return h`<div class="fd-empty">
    <span class="fd-eic">${icon('search-off')}</span>
    <h2 class="h2">Nothing matches</h2>
    <p>${msg}</p>
    ${hint}
    <div class="fd-ebtns">${anyFilter() ? h`<button class="btn" data-act="fdClearF">Clear filters</button>` : ''}${q ? h`<button class="${anyFilter() ? 'btn alt' : 'btn'}" data-act="fdClearQ">Clear search</button>` : ''}</div>
  </div>`;
}
function resultsHtml(stagger = false) {
  if (!R) compute();
  const {list, M} = R;
  const act = activeList();
  const filtered = list.length !== M.length || anyFilter() || !!Q.trim();
  const head = h`<div class="fd-rh">
    <p class="fd-cnt" role="status">${filtered ? h`<b>${list.length}</b> of ${N.plural(M.length, 'spot')}` : h`<b>${M.length}</b> ${M.length === 1 ? 'spot' : 'spots'}`}</p>
    ${filtered && list.length ? h`<button class="fd-lnk" data-act="fdClearAll">Clear all</button>` : ''}
  </div>
  ${act.length ? h`<div class="fd-acs" data-hscroll>${act.map(([g, v, l]) => h`<button class="fd-ac" data-act="fdDrop" data-arg="${g + '|' + v}" aria-label="${`Remove ${l}`}"><span>${l}${icon('x')}</span></button>`)}</div>` : ''}
  ${noteHtml()}`;
  if (!list.length) return h`${head}${noMatch()}`;
  let cards;
  if (S.sort === 'open') {
    const groups = [['Open now', list.filter(isOpen)], ['Closed now', list.filter(m => m.hr.state === 'closed')], ['Hours not listed', list.filter(m => m.hr.state === 'unknown')]];
    let k = 0;
    cards = groups.filter(g => g[1].length).map(([t, ms]) => h`<h3 class="fd-gh">${t} · ${ms.length}</h3>${ms.map(m => card(m, k++, stagger))}`);
  } else cards = list.map((m, i) => card(m, i, stagger));
  return h`${head}<div class="fd-list">${cards}</div>${footHtml()}`;
}
function footHtml() {
  const d = N.data.food || {};
  const at = typeof d.collected_at === 'string' ? new Date(d.collected_at) : null;   // a stored timestamp, not "now"
  const t = at && Number.isFinite(at.getTime()) ? safe(() => N.date(d.collected_at, 'NYC'), '') : '';
  return h`<p class="fd-foot">${t ? `List saved from Yelp on ${t}. ` : ''}Hours can change, so check before a long trip across town.</p>`;
}
function bodyHtml(stagger = false) {
  if (!hasData()) return emptyData();
  if (S.view === 'map') return h`<div class="fd-mapph" aria-hidden="true"></div>`;
  return h`<div class="fd">
    ${searchRow()}
    ${chipRow()}
    <div class="fd-bar" data-fdbar>${barHtml()}</div>
    <div data-fdres>${resultsHtml(stagger)}</div>
  </div>`;
}

// ---------- painting ----------
const $v = s => V && V.view ? N.$(s, V.view) : null;
const $$v = s => V && V.view ? N.$$(s, V.view) : [];
function paintControls() {
  const c = chipsHtml(), ch = String(h`${c}`);
  $$v('[data-fdchips]').forEach(e => { const x = e.scrollLeft; e.innerHTML = ch; e.hidden = !c.length; e.scrollLeft = x; });
  const bar = $v('[data-fdbar]');
  if (bar) bar.innerHTML = String(barHtml());
  const n = sheetCount();
  $$v('[data-fdfn]').forEach(e => { e.textContent = n; e.hidden = !n; });
  $$v('.fd-fbtn').forEach(e => e.setAttribute('aria-label', n ? `Filters, ${n} on` : 'Filters'));
}
// A restored type chip can sit past the right edge; bring the first one into view once.
function revealChips() {
  $$v('[data-fdchips]').forEach(e => {
    if (e.scrollLeft > 0) return;
    const b = e.querySelector('[data-act="fdType"][aria-pressed="true"]');
    if (b && b.offsetLeft + b.offsetWidth > e.clientWidth) e.scrollLeft = Math.max(0, b.offsetLeft - 56);
  });
}
function paintHero() {
  const c = $v('[data-fdclock]');
  if (c) c.textContent = clockText();
  const s = $v('[data-fdstats]');
  if (s) s.innerHTML = String(statsHtml());
}
function paintBody(stagger = false) {
  const b = $v('#body');
  if (b) b.innerHTML = String(bodyHtml(stagger));
  safe(fitBadges);
}
function refresh() {
  if (!V) return;
  if (!hasData()) { compute(); paintHero(); paintBody(); return; }
  compute();
  paintControls();
  if (S.view === 'map' && MV) syncMap();
  else { const r = $v('[data-fdres]'); if (r) { r.innerHTML = String(resultsHtml()); safe(fitBadges); } }
  paintHero();
  if (SH) paintSheet();
}
const listKey = () => R ? R.list.map(m => m.id).join(',') : '';

// ---------- location ----------
async function locate({pan = false} = {}) {
  if (!N.where) { N.toast('Location isn’t available here'); return null; }
  locating = true; refresh();
  let w = null;
  try { w = await N.where({fresh: true}); } catch { w = null; }
  locating = false;
  if (!V) return w;
  if (!w) N.toast('Couldn’t get your location. Check Location Services in Settings.');
  refresh();
  if (w && pan && MV) panToMe(w);
  return w;
}

// ---------- filter sheet ----------
function optBtn(g, v, label, n, on, ic = '') {
  const off = !n && !on;
  return h`<button class="fd-opt" data-act="fdOpt" data-arg="${g + '|' + v}" aria-pressed="${on ? 'true' : 'false'}"${off ? N.raw(' aria-disabled="true"') : ''}><span class="fd-op">${ic ? icon(ic, 'fd-ost') : ''}<span class="fd-ol">${label}</span><span class="fd-n">${n}</span></span></button>`;
}
function facet(g, keyFn) {
  const base = (R ? R.base : []).filter(m => pass(m, S, g));
  const c = new Map();
  for (const m of base) for (const k of keyFn(m)) c.set(k, (c.get(k) || 0) + 1);
  return c;
}
function allValues(fn) {
  const c = new Map();
  for (const m of model()) for (const k of fn(m)) c.set(k, (c.get(k) || 0) + 1);
  return c;
}
function sheetBody() {
  if (!R) compute();
  const M = model();
  const sec = (t, inner, extra = '') => h`<section class="fd-sec"><h3 class="ey">${t}</h3><div class="fd-opts">${inner}</div>${extra}</section>`;
  const out = [];
  // price
  const pAll = allValues(m => m.price ? [m.price] : []);
  if (pAll.size) {
    const pc = facet('price', m => m.price ? [m.price] : []);
    const noPrice = M.filter(m => !m.price).length;
    out.push(sec('Price', [...pAll.keys()].sort((a, b) => a.length - b.length).map(v => optBtn('price', v, v, pc.get(v) || 0, S.price.includes(v))),
      noPrice ? h`<p class="fd-sh">${N.plural(noPrice, 'spot has', 'spots have')} no price listed${S.price.length ? ' and are hidden while a price is picked' : ''}.</p>` : ''));
  }
  // meal
  const mAll = allValues(m => m.meals);
  if (mAll.size) {
    const mc = facet('meal', m => m.meals);
    const keys = [...MEAL_ORDER.filter(k => mAll.has(k)), ...[...mAll.keys()].filter(k => !MEAL_ORDER.includes(k))];
    out.push(sec('Meal', keys.map(v => optBtn('meal', v, MEAL_LABEL[v] || titleCase(v), mc.get(v) || 0, S.meal.includes(v)))));
  }
  // rating and features
  {
    const tb = (R ? R.base : []).filter(m => pass(m, S, 'top'));
    const topN = tb.filter(m => m.rating >= 4.5).length;
    const ab = (R ? R.base : []).filter(m => pass(m, S, 'attrs'));
    const feats = FEATS.map(([k, l]) => {
      const on = S.attrs.includes(k);
      const need = on ? S.attrs : [...S.attrs, k];
      return optBtn('attrs', k, l, ab.filter(m => need.every(x => m.feat[x])).length, on);
    });
    out.push(sec('Rating and features', [optBtn('top', '1', 'Rated 4.5+', topN, S.top, 'star-filled'), ...feats]));
  }
  // cuisine
  const cAll = allValues(m => m.cuisine);
  if (cAll.size) {
    const cc = facet('cuisine', m => m.cuisine);
    const keys = [...cAll.keys()].sort((a, b) => (cAll.get(b) - cAll.get(a)) || a.localeCompare(b));
    const show = SH && SH.allC ? keys : [...keys.slice(0, 16), ...S.cuisine.filter(k => !keys.slice(0, 16).includes(k))];
    out.push(sec('Cuisine', show.map(v => optBtn('cuisine', v, v, cc.get(v) || 0, S.cuisine.includes(v))),
      keys.length > 16 ? h`<button class="fd-more" data-act="fdMore" data-arg="allC">${SH && SH.allC ? 'Show fewer' : `All ${keys.length} cuisines`}${icon(SH && SH.allC ? 'chevron-up' : 'chevron-down')}</button>` : ''));
  }
  // area
  const bAll = allValues(m => m.boro ? ['b:' + m.boro] : []);
  const nAll = allValues(m => m.hood ? ['n:' + m.hood] : []);
  if (bAll.size || nAll.size) {
    const ac = facet('area', m => [m.boro && 'b:' + m.boro, m.hood && 'n:' + m.hood].filter(Boolean));
    const bk = [...bAll.keys()].sort((a, b) => bAll.get(b) - bAll.get(a));
    const nk = [...nAll.keys()].sort((a, b) => (nAll.get(b) - nAll.get(a)) || a.localeCompare(b));
    const nShow = SH && SH.allN ? nk : [...nk.slice(0, 12), ...S.area.filter(k => k.startsWith('n:') && !nk.slice(0, 12).includes(k))];
    out.push(h`<section class="fd-sec"><h3 class="ey">Area</h3>
      ${bk.length > 1 ? h`<div class="fd-opts">${bk.map(v => optBtn('area', v, v.slice(2), ac.get(v) || 0, S.area.includes(v)))}</div>` : ''}
      ${nk.length ? h`<p class="fd-sub">Neighborhood</p><div class="fd-opts">${nShow.map(v => optBtn('area', v, v.slice(2), ac.get(v) || 0, S.area.includes(v)))}</div>` : ''}
      ${nk.length > 12 ? h`<button class="fd-more" data-act="fdMore" data-arg="allN">${SH && SH.allN ? 'Show fewer' : `All ${nk.length} neighborhoods`}${icon(SH && SH.allN ? 'chevron-up' : 'chevron-down')}</button>` : ''}
    </section>`);
  }
  return out;
}
function sheetHead() {
  const n = sheetCount();
  return h`<h2 class="h2" id="fdSheetT">Filters</h2>${n ? h`<span class="fd-on">${n} on</span>` : ''}<span class="grow"></span>
    ${n ? h`<button class="fd-lnk" data-act="fdClearSheet">Clear</button>` : ''}
    <button class="fd-x" data-act="fdSheetX" aria-label="Close filters">${icon('x')}</button>`;
}
const showText = () => R && R.list.length ? `Show ${N.plural(R.list.length, 'spot')}` : 'No spots match';
function paintSheet(focusArg) {
  if (!SH) return;
  const b = N.$('[data-fdsheet]', SH.el);
  if (b) { const st = b.scrollTop; b.innerHTML = String(h`${sheetBody()}`); b.scrollTop = st; }
  const hd = N.$('[data-fdshd]', SH.el);
  if (hd) hd.innerHTML = String(sheetHead());
  const go = N.$('.fd-show', SH.el);
  if (go) go.textContent = showText();
  if (focusArg) {
    const f = N.$$('[data-arg]', SH.el).find(e => e.dataset.arg === focusArg);
    if (f) f.focus({preventScroll: true});
  }
}
// ---------- touch drags (filter sheet, map preview) ----------
// One finger. The axis is picked after 8px and take() says whether the drag is ours; from then on the page doesn't
// scroll and move() follows the finger 1:1. end() gets the speed in px/ms, zero if the finger rested before lifting.
const SETTLE = 'transform .28s var(--ease),opacity .28s var(--ease)';
function drag(el, {begin = () => true, hold = () => false, take, move, end}) {
  let g = null, quiet = 0;
  const at = ev => ev.touches[0] || ev.changedTouches[0];
  const down = ev => {
    g = null;
    if (ev.touches.length !== 1 || !begin(ev)) return;
    const p = at(ev);
    g = {x0: p.clientX, y0: p.clientY, dx: 0, dy: 0, vx: 0, vy: 0, t: performance.now(), axis: '', on: false, target: ev.target};
  };
  const mv = ev => {
    if (!g) return;
    if (ev.touches.length !== 1) { if (g.on) end(g, true); g = null; return; }
    const p = at(ev), dx = p.clientX - g.x0, dy = p.clientY - g.y0;
    if (!g.axis) {
      if (Math.hypot(dx, dy) < 8) { if (hold(g, dx, dy)) ev.preventDefault(); return; }
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      g.on = take(g, dx, dy);
      if (!g.on) { g = null; return; }
    }
    if (ev.cancelable) ev.preventDefault();
    const now = performance.now(), dt = Math.max(1, now - g.t);
    g.vx = .7 * (dx - g.dx) / dt + .3 * g.vx; g.vy = .7 * (dy - g.dy) / dt + .3 * g.vy;
    g.dx = dx; g.dy = dy; g.t = now;
    move(g);
  };
  const up = ev => {
    const d = g;
    g = null;
    if (!d || !d.on) return;
    if (performance.now() - d.t > 80) d.vx = d.vy = 0;
    quiet = performance.now() + 400;
    end(d, ev.type === 'touchcancel');
  };
  // a drag that lifts over a link or a button must not also press it
  const click = ev => { if (performance.now() < quiet) { ev.preventDefault(); ev.stopPropagation(); } };
  const opt = {passive: false};
  el.addEventListener('touchstart', down, {passive: true});
  el.addEventListener('touchmove', mv, opt);
  el.addEventListener('touchend', up);
  el.addEventListener('touchcancel', up);
  el.addEventListener('click', click, true);
  return () => {
    el.removeEventListener('touchstart', down, {passive: true});
    el.removeEventListener('touchmove', mv, opt);
    el.removeEventListener('touchend', up);
    el.removeEventListener('touchcancel', up);
    el.removeEventListener('click', click, true);
  };
}
// Pull the sheet down from its head, or from the list once it's scrolled to the top. Let go past 40% or with a flick to close.
function sheetDrag(el) {
  const panel = N.$('.fd-panel', el), scrim = N.$('.fd-scrim', el), body = N.$('.fd-pb', el);
  if (!panel || !scrim || !body) return () => {};
  const inBody = g => body.contains(g.target);
  let hgt = 1;
  return drag(panel, {
    begin: ev => !body.contains(ev.target) || body.scrollTop <= 0,
    hold: (g, dx, dy) => inBody(g) && dy > 0 && dy >= Math.abs(dx),
    take: (g, dx, dy) => { hgt = panel.offsetHeight || 1; return g.axis === 'y' && dy > 0; },
    move: g => {
      const y = Math.max(0, g.dy);
      panel.style.transition = scrim.style.transition = 'none';
      panel.style.transform = `translateY(${y}px)`;
      scrim.style.opacity = String(1 - y / hgt);
    },
    end: (g, cancel) => {
      const y = Math.max(0, g.dy);
      if (!cancel && (g.vy > .5 || y > hgt * .4)) { closeSheet(); return; }
      panel.style.transition = SETTLE; scrim.style.transition = '';
      panel.style.transform = ''; scrim.style.opacity = '';
      setTimeout(() => { if (!panel.style.transform) panel.style.transition = ''; }, 300);
    },
  });
}
function openSheet() {
  if (SH || !V) return;
  if (!R) compute();
  const app = N.$('#app') || document.body;
  const el = document.createElement('div');
  el.className = 'fd-modal';
  el.innerHTML = String(h`<button class="fd-scrim" data-act="fdSheetX" aria-label="Close filters" tabindex="-1"></button>
    <div class="fd-panel" role="dialog" aria-modal="true" aria-labelledby="fdSheetT">
      <div class="fd-phd"><span class="fd-grab" aria-hidden="true"></span><div class="fd-phr" data-fdshd>${sheetHead()}</div></div>
      <div class="fd-pb" data-fdsheet>${sheetBody()}</div>
      <div class="fd-pf"><button class="btn fd-show" data-act="fdSheetX">${showText()}</button></div>
    </div>`);
  app.appendChild(el);
  SH = {el, prev: document.activeElement, allC: false, allN: false};
  const nv = N.$('.nv');
  V.view.inert = true; if (nv) nv.inert = true;
  const onKey = ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); closeSheet(); return; }
    if (ev.key === 'Tab') {   // keep focus inside the sheet
      const f = N.$$('button:not([tabindex="-1"]),select,input', el).filter(x => x.offsetParent);
      if (!f.length) return;
      const a = f[0], z = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === a) { ev.preventDefault(); z.focus(); }
      else if (!ev.shiftKey && document.activeElement === z) { ev.preventDefault(); a.focus(); }
    }
  };
  document.addEventListener('keydown', onKey);
  const offDrag = sheetDrag(el);
  SH.off = () => { document.removeEventListener('keydown', onKey); offDrag(); };
  requestAnimationFrame(() => { el.classList.add('on'); const x = N.$('.fd-x', el); if (x) x.focus({preventScroll: true}); });
}
function closeSheet(quiet = false) {
  if (!SH) return;
  const {el, prev, off} = SH;
  SH = null;
  off();
  if (V && V.view) V.view.inert = false;
  const nv = N.$('.nv'); if (nv) nv.inert = false;
  if (quiet || N.reduce) el.remove();
  else {
    // from wherever a drag left it
    const panel = N.$('.fd-panel', el), scrim = N.$('.fd-scrim', el);
    if (panel) { panel.style.transition = ''; panel.style.transform = ''; }
    if (scrim) { scrim.style.transition = ''; scrim.style.opacity = ''; }
    el.classList.remove('on');
    setTimeout(() => el.remove(), 300);
  }
  if (!quiet) {
    const f = prev && prev.isConnected ? prev : $v('.fd-fbtn');
    if (f) f.focus({preventScroll: true});
  }
}

// ---------- map ----------
let basemap = null;
const getBasemap = () => basemap || (basemap = fetch('data/basemap.json').then(r => r.ok ? r.json() : null).catch(() => null)
  .then(j => { if (!j || !Array.isArray(j.features)) basemap = null; return j && Array.isArray(j.features) ? j : null; }));
const tok = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
/* Carto's free basemaps answer every request with an "API KEY REQUIRED"
   watermark tile (checked 18 Oct 2026; place.js does the same check), so the
   tile layer is only added once N.tiles points somewhere else or carries a
   key. Until then the map is drawn from data/basemap.json alone. */
const tilesOk = t => !!(t && typeof t.url === 'string' && t.url && (!/basemaps\.cartocdn\.com/.test(t.url) || /[?&](api_?key|key|token)=/i.test(t.url)));
const NYC = [[40.49, -74.27], [40.92, -73.68]];
const roadW = (base, z) => Math.max(.4, Math.min(base * 2 ** (z - 15), base * 3));
function mapShell() {
  return h`<div class="fd-mapc" role="region" aria-label="Map of saved spots"></div>
    <div class="fd-mload" data-fdmload>${icon('map-2')}<span>Loading map…</span></div>
    <div class="fd-mtop">${searchRow()}${chipRow()}</div>
    <div class="fd-mmsg" data-fdmmsg hidden></div>
    <div class="fd-mbot">
      <p class="fd-moff" data-fdmoff hidden></p>
      <div class="fd-mrow" data-fdmrow>
        <div class="seg fd-seg" role="group" aria-label="View">
          <button data-act="fdView" data-arg="list" aria-pressed="false">${icon('layout-list')}List</button>
          <button data-act="fdView" data-arg="map" aria-pressed="true">${icon('map-2')}Map</button>
        </div>
        <span class="fd-mcount" data-fdmcount role="status"></span>
        <button class="fd-mbtn" data-act="fdFit" aria-label="Show all results">${icon('zoom-reset')}</button>
        <button class="fd-mbtn" data-act="fdLocate" data-arg="pan" aria-label="Show where I am">${icon('current-location')}</button>
      </div>
      <div class="fd-pw" data-fdprev hidden></div>
    </div>
    <p class="fd-attr" data-fdattr></p>`;
}
function openMap() {
  if (!V || MV || !hasData()) return;
  const view = V.view;
  view.scrollTop = 0;
  view.classList.add('fd-mapon');
  const wrap = document.createElement('div');
  wrap.className = 'fd-mapv';
  if (!R) compute();
  wrap.innerHTML = String(mapShell());
  view.appendChild(wrap);
  const my = MV = {wrap, box: N.$('.fd-mapc', wrap), map: null, L: null, markers: new Map(), clusters: [], sel: null, base: [], tiles: null, me: null, hotel: null, offs: [], fitKey: ''};
  my.offs.push(previewDrag(N.$('[data-fdprev]', wrap)));
  const strip = N.$('#strip');
  const setTop = () => wrap.style.setProperty('--fd-strip', `${strip && strip.offsetHeight || 0}px`);
  setTop();
  if (strip && window.ResizeObserver) { const ro = new ResizeObserver(setTop); ro.observe(strip); my.offs.push(() => ro.disconnect()); }
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const onMq = () => setTimeout(restyleMap, 30);
  mq.addEventListener('change', onMq); my.offs.push(() => mq.removeEventListener('change', onMq));
  paintMapUi();
  N.loadLeaflet().then(L => {
    if (MV !== my || !my.box.isConnected) return;
    try { buildMap(L); } catch (e) { N.report(e, 'food map'); mapFail(); }
  }, () => { if (MV === my) mapFail(); });
}
function mapFail() {
  if (!MV) return;
  MV.wrap.classList.add('fd-mfail');   // fit and locate act on the map, so they go with it
  const ld = N.$('[data-fdmload]', MV.wrap); if (ld) ld.hidden = true;
  const m = N.$('[data-fdmmsg]', MV.wrap);
  if (!m) return;
  const off = N.online && !N.online();
  m.innerHTML = String(h`<b>The map didn’t load</b><span>${off ? 'You’re offline and the map wasn’t saved yet.' : 'Something went wrong drawing it.'} The list still works.</span><button class="btn" data-act="fdView" data-arg="list">Show list</button>`);
  m.hidden = false;
}
function buildMap(L) {
  const my = MV;
  my.L = L;
  // the map stops a little past the outermost pins, so a fling can't lose the city
  const pts = model().filter(m => m.ll).map(m => [m.lat, m.lon]);
  const fence = pts.length ? L.latLngBounds(pts).pad(.4) : L.latLngBounds(NYC);
  const map = my.map = L.map(my.box, {zoomControl: false, attributionControl: false, zoomSnap: .25, zoomDelta: .5, minZoom: 10, maxZoom: 18,
    maxBounds: fence, maxBoundsViscosity: 1, keyboard: true, inertia: true});
  const pane = map.createPane('fdBase');
  pane.style.zIndex = 150;
  pane.style.pointerEvents = 'none';
  my.renderer = L.canvas({pane: 'fdBase', padding: .5});
  const t = N.tiles ? N.tiles(N.isDark()) : null;
  if (tilesOk(t)) my.tiles = L.tileLayer(t.url, t.opts).addTo(map);
  // initial view: where we left it (back from a place) or fitted to the results
  const keep = fromName === 'place' && memo && memo.map;
  if (keep && keep.c) map.setView(keep.c, keep.z, {animate: false});
  else fit(false);
  map.on('click', () => select(null));
  map.on('zoomend', onZoom);
  onZoom();
  const ld = N.$('[data-fdmload]', my.wrap); if (ld) ld.hidden = true;
  getBasemap().then(gj => { if (MV !== my) return; if (gj) drawBase(gj); else noBase(); });
  syncMap();
  if (keep && keep.sel && BYID.has(keep.sel)) select(keep.sel, {pan: false});
  memo = null;
}
function baseColors() { return {land: tok('--cr'), park: tok('--ok'), edge: tok('--ln'), road: tok('--tile')}; }
const kindF = f => f && f.properties && f.properties.k;
function baseStyles() {
  const c = baseColors(), z = MV.map.getZoom();
  return {
    area: f => kindF(f) === 'park' ? {stroke: false, fill: true, fillColor: c.park, fillOpacity: .26} : {stroke: false, fill: true, fillColor: c.land, fillOpacity: 1},
    edge: f => ({color: c.edge, weight: roadW(kindF(f) === 'major' ? 8 : 6, z), opacity: 1, fill: false, lineCap: 'round', lineJoin: 'round'}),
    road: f => ({color: c.road, weight: roadW(kindF(f) === 'major' ? 5.5 : 3.5, z), opacity: 1, fill: false, lineCap: 'round', lineJoin: 'round'}),
  };
}
function drawBase(gj) {
  const {L, map} = MV;
  const st = baseStyles();
  const o = {pane: 'fdBase', interactive: false, renderer: MV.renderer};
  const roads = f => kindF(f) === 'major' || kindF(f) === 'road';
  MV.base = [
    ['area', L.geoJSON(gj, {...o, style: st.area, filter: f => kindF(f) === 'land' || kindF(f) === 'park'})],
    ['edge', L.geoJSON(gj, {...o, style: st.edge, filter: roads})],
    ['road', L.geoJSON(gj, {...o, style: st.road, filter: roads})],
  ];
  MV.base.forEach(([, l]) => l.addTo(map));
  const src = str(gj.attribution).replace(/\s*\([^)]*\)/g, '').split(/\s*;\s*/).filter(Boolean).join(' · ');
  const a = N.$('[data-fdattr]', MV.wrap);
  if (a) a.textContent = [src, MV.tiles ? '© OpenStreetMap © CARTO' : ''].filter(Boolean).join(' · ');
}
// without data/basemap.json the pins still sit in the right places; show plain land instead of an empty sea and say why
function noBase() {
  if (!MV || MV.tiles) return;
  MV.wrap.classList.add('fd-nobase');
  const a = N.$('[data-fdattr]', MV.wrap);
  if (a) a.textContent = 'Street map didn’t load. Pins still work.';
}
function restyleMap() {
  if (!MV || !MV.map) return;
  if (MV.base.length) { const st = baseStyles(); MV.base.forEach(([k, l]) => l.setStyle(st[k])); }
  if (MV.tiles && N.tiles) { const t = N.tiles(N.isDark()); if (tilesOk(t)) MV.tiles.setUrl(t.url); }
}
function onZoom() {
  if (!MV || !MV.map) return;
  cluster();
  if (MV.base.length) { const st = baseStyles(); MV.base.forEach(([k, l]) => { if (k !== 'area') l.setStyle(st[k]); }); }
}
// one pin style: an ink dot with the food's icon, ringed when open; the picked one opens into a pill with its rating
const pinHtml = m => String(h`<span class="fd-pv">${icon(m.kind.icon)}${m.rating != null ? h`<b>${m.rating.toFixed(1)}</b>` : ''}</span>`);
function syncMap() {
  if (!MV) return;
  const c = N.$('[data-fdmcount]', MV.wrap), o = N.$('[data-fdmoff]', MV.wrap);
  if (R && c) {
    // the pill only has room for the count; spots with no location get their own line so the note is never cut off
    const on = R.list.filter(m => m.ll).length, off = R.list.length - on;
    c.innerHTML = String(R.list.length ? h`<b>${on}</b><span class="fd-mu1">${on === 1 ? 'spot' : 'spots'}</span>` : 'No spots');
    c.setAttribute('aria-label', R.list.length ? N.plural(on, 'spot') : 'No spots');
    if (o) { o.hidden = !off; o.textContent = off ? `${N.plural(off, 'spot has', 'spots have')} no map location. Find ${off === 1 ? 'it' : 'them'} in the list.` : ''; }
  }
  const msg = N.$('[data-fdmmsg]', MV.wrap);
  if (msg && MV.map) {
    const none = R && !R.list.length;
    msg.hidden = !none;
    if (none) msg.innerHTML = String(h`<b>Nothing matches</b><span>${Q.trim() ? `No spots match “${Q.trim()}”${anyFilter() ? ' with these filters' : ''}.` : 'No spots fit these filters.'}</span>
      <span class="fd-ebtns">${anyFilter() ? h`<button class="btn" data-act="fdClearF">Clear filters</button>` : ''}${Q.trim() ? h`<button class="${anyFilter() ? 'btn alt' : 'btn'}" data-act="fdClearQ">Clear search</button>` : ''}</span>`);
  }
  if (!MV.map || !R) return;
  const {L, map} = MV;
  const want = new Map(R.list.filter(m => m.ll).map((m, i) => [m.id, i]));
  for (const [id, mk] of MV.markers) if (!want.has(id)) { mk.remove(); MV.markers.delete(id); }
  for (const [id, i] of want) {
    const m = BYID.get(id);
    let mk = MV.markers.get(id);
    if (!mk) {
      mk = L.marker([m.lat, m.lon], {keyboard: true, title: m.name, alt: m.name, riseOnHover: true,
        icon: L.divIcon({className: 'fd-pin', html: pinHtml(m), iconSize: [0, 0], iconAnchor: [0, 0]})});
      mk.on('click', ev => { if (ev && ev.originalEvent) L.DomEvent.stopPropagation(ev.originalEvent); select(id); });
      mk.addTo(map);
      MV.markers.set(id, mk);
    }
    mk.setZIndexOffset((want.size - i) * 10 + (id === MV.sel ? 100000 : 0));
    const el = mk.getElement();
    if (el) el.classList.toggle('on', id === MV.sel);
  }
  if (MV.sel && !want.has(MV.sel)) select(null);
  else cluster();
  // where I am, and the hotel when it has a position
  const here = R.here;
  if (here && hasLL(here) && !R.far) {
    if (!MV.me) MV.me = L.marker([here.lat, here.lon], {interactive: false, keyboard: false, zIndexOffset: 200000,
      icon: L.divIcon({className: 'fd-me', html: '<span></span>', iconSize: [0, 0], iconAnchor: [0, 0]})}).addTo(map);
    else MV.me.setLatLng([here.lat, here.lon]);
  } else if (MV.me) { MV.me.remove(); MV.me = null; }
  const ho = safe(() => N.hotel ? N.hotel() : null, null);
  if (hasLL(ho)) {
    if (!MV.hotel) MV.hotel = L.marker([ho.lat, ho.lon], {keyboard: false, title: 'Hotel', zIndexOffset: 150000,
      icon: L.divIcon({className: 'fd-hpin', html: String(h`<span>${icon('bed')}</span>`), iconSize: [0, 0], iconAnchor: [0, 0]})}).addTo(map);
    else MV.hotel.setLatLng([ho.lat, ho.lon]);
  } else if (MV.hotel) { MV.hotel.remove(); MV.hotel = null; }
}
// Below street zoom, pins closer than a bubble's width fold into one ink bubble with a count; tapping it zooms to them.
// Closer in, only pins that would sit on top of each other still fold, until street level where every pin shows.
// Grid cells on the projected map, then any two groups still touching are merged. The picked pin always stays itself.
const CLUSTER_Z = 14, CELL = 48, TIGHT = 36, ALL_Z = 17;
function cluster() {
  if (!MV || !MV.map) return;
  const {L, map} = MV;
  MV.clusters.forEach(c => c.remove());
  MV.clusters = [];
  const hide = new Set();
  const z = map.getZoom(), cell = z < CLUSTER_Z ? CELL : z < ALL_Z ? TIGHT : 0;
  if (cell) {
    const cells = new Map();
    for (const [id, mk] of MV.markers) {
      if (id === MV.sel) continue;
      const p = map.project(mk.getLatLng(), z), k = Math.floor(p.x / cell) + ':' + Math.floor(p.y / cell);
      const g = cells.get(k) || {ids: [], x: 0, y: 0};
      g.ids.push(id); g.x += p.x; g.y += p.y;
      cells.set(k, g);
    }
    const gs = [...cells.values()].map(g => ({ids: g.ids, x: g.x / g.ids.length, y: g.y / g.ids.length}));
    for (let a = 0; a < gs.length; a++) {
      for (let b = a + 1; b < gs.length; b++) {
        const A = gs[a], B = gs[b];
        if (Math.hypot(A.x - B.x, A.y - B.y) >= cell) continue;
        const n = A.ids.length + B.ids.length;
        A.x = (A.x * A.ids.length + B.x * B.ids.length) / n; A.y = (A.y * A.ids.length + B.y * B.ids.length) / n;
        A.ids = A.ids.concat(B.ids);
        gs.splice(b, 1);
        a = -1;   // A moved, so start over
        break;
      }
    }
    for (const g of gs) {
      if (g.ids.length < 2) continue;
      g.ids.forEach(id => hide.add(id));
      const n = g.ids.length, ids = g.ids;
      const c = L.marker(map.unproject([g.x, g.y], z), {keyboard: true, title: `${n} spots, zoom in`, zIndexOffset: 50000,
        icon: L.divIcon({className: 'fd-clu', html: `<span class="fd-cl"><b>${n}</b></span>`, iconSize: [0, 0], iconAnchor: [0, 0]})});
      c.on('click', ev => { if (ev && ev.originalEvent) L.DomEvent.stopPropagation(ev.originalEvent); zoomTo(ids); });
      c.addTo(map);
      MV.clusters.push(c);
    }
  }
  for (const [id, mk] of MV.markers) {
    const on = map.hasLayer(mk);
    if (hide.has(id)) { if (on) mk.remove(); }
    else if (!on) mk.addTo(map);
  }
  paintPins();
}
// a removed marker comes back with a new element, so its classes are set here rather than once
function paintPins() {
  if (!MV) return;
  for (const [id, mk] of MV.markers) {
    const el = mk.getElement(), m = BYID.get(id);
    if (!el || !m) continue;
    el.classList.toggle('on', id === MV.sel);
    el.classList.toggle('fd-po', isOpen(m));
  }
}
function zoomTo(ids) {
  if (!MV || !MV.map) return;
  const {L, map} = MV;
  const ms = ids.map(id => BYID.get(id)).filter(m => m && m.ll);
  if (!ms.length) return;
  const bb = L.latLngBounds(ms.map(m => [m.lat, m.lon]));
  const {t, b} = pads();
  const z = map.getBoundsZoom(bb, false, L.point(80, t + b));
  // a bubble always opens: if its spots already fill the screen, step in on its middle instead
  if (z >= map.getZoom() + .5) map.fitBounds(bb, {paddingTopLeft: [40, t], paddingBottomRight: [40, b], maxZoom: ALL_Z, animate: !N.reduce});
  else map.setView(bb.getCenter(), Math.min(ALL_Z, map.getZoom() + 1.5), {animate: !N.reduce});
}
function pads() {
  const w = MV.wrap, top = N.$('.fd-mtop', w), bot = N.$('.fd-mbot', w);
  const H = w.clientHeight;
  const t = (top ? top.offsetTop + top.offsetHeight : 120) + 18;
  const b = bot ? Math.max(0, H - bot.offsetTop) + 18 : 180;
  return {t, b, H};
}
function fit(animate = true) {
  if (!MV || !MV.map || !R) return;
  const {L, map} = MV;
  let pts = R.list.filter(m => m.ll);
  if (!pts.length) return;
  if (pts.length > 4) {   // leave out far outliers (Staten Island) so Manhattan isn't tiny
    const med = a => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
    const c = {lat: med(pts.map(m => m.lat)), lon: med(pts.map(m => m.lon))};
    const near = pts.filter(m => N.dist(c, m) <= 8000);
    if (pts.length - near.length <= Math.ceil(pts.length * .1)) pts = near.length ? near : pts;
  }
  const {t, b} = pads();
  if (pts.length === 1) {
    map.setView([pts[0].lat, pts[0].lon], 15, {animate});
    map.panBy([0, (b - t) / 2], {animate: false});
    return;
  }
  map.fitBounds(L.latLngBounds(pts.map(m => [m.lat, m.lon])), {paddingTopLeft: [28, t], paddingBottomRight: [28, b], maxZoom: 15, animate});
}
function panToMe(w) {
  if (!MV || !MV.map || !hasLL(w)) return;
  if (R && R.far) { N.toast('You’re not in New York yet'); return; }
  const {t, b} = pads();
  const z = Math.max(MV.map.getZoom(), 15);
  const p = MV.map.project([w.lat, w.lon], z).add([0, (b - t) / 2]);
  MV.map.setView(MV.map.unproject(p, z), z, {animate: true});
}
function previewHtml(m) {
  const href = 'place/' + m.id;
  return h`<a class="fd-prev" href="${'#' + href}" data-act="go" data-arg="${href}">
      ${thumb(m, 'fd-pth', 84, 84)}
      <span class="fd-pbd">
        <span class="fd-nm">${m.name}</span>
        ${rateHtml(m)}
        ${metaHtml(m)}
      </span>
      ${icon('chevron-right', 'fd-pch')}
    </a>
    <button class="fd-px" data-act="fdUnsel" aria-label="Close preview">${icon('x')}</button>`;
}
function select(id, {pan = true} = {}) {
  if (!MV) return;
  const prev = MV.sel;
  MV.sel = id && BYID.has(id) ? id : null;
  for (const k of [prev, MV.sel]) {
    const mk = k && MV.markers.get(k);
    if (mk) mk.setZIndexOffset(k === MV.sel ? 100000 : 0);
  }
  if (prev !== MV.sel) cluster(); else paintPins();
  MV.wrap.classList.toggle('fd-pvon', !!MV.sel);
  const pw = N.$('[data-fdprev]', MV.wrap), row = N.$('[data-fdmrow]', MV.wrap);
  if (!pw || !row) return;
  if (!MV.sel) { pw.hidden = true; pw.innerHTML = ''; row.hidden = false; return; }
  const m = BYID.get(MV.sel);
  pw.innerHTML = String(previewHtml(m));
  pw.hidden = false; row.hidden = true;
  if (pan && MV.map && m.ll) {
    const pt = MV.map.latLngToContainerPoint([m.lat, m.lon]);
    const {t, b, H} = pads();
    const w = MV.wrap.clientWidth;
    let dy = 0, dx = 0;
    if (pt.y > H - b - 10) dy = pt.y - (H - b - 10) + 30;
    else if (pt.y < t + 10) dy = pt.y - (t + 10) - 30;
    if (pt.x < 30) dx = pt.x - 50; else if (pt.x > w - 30) dx = pt.x - (w - 50);
    if (dx || dy) MV.map.panBy([dx, dy], {animate: true});
  }
}
// The preview card: swipe it down to close, sideways for the next or previous spot in the list's order.
function previewDrag(pw) {
  if (!pw) return () => {};
  const style = (tr, tf, op) => { pw.style.transition = tr; pw.style.transform = tf; pw.style.opacity = op; };
  const pins = () => R ? R.list.filter(m => m.ll).map(m => m.id) : [];
  return drag(pw, {
    begin: ev => !!(MV && MV.sel) && (ev.touches[0].clientX > 20),   // the left edge is the system's back swipe
    take: (g, dx, dy) => g.axis === 'y' ? dy > 0 : pins().length > 1,
    move: g => {
      pw.classList.add('fd-drag');
      if (g.axis === 'y') { const y = Math.max(0, g.dy); style('none', `translateY(${y}px)`, String(Math.max(.2, 1 - y / 160))); }
      else style('none', `translateX(${g.dx}px)`, String(Math.max(.4, 1 - Math.abs(g.dx) / 320)));
    },
    end: (g, cancel) => {
      pw.classList.remove('fd-drag');
      const id = MV && MV.sel;
      if (!cancel && id && g.axis === 'y' && (g.dy > 40 || g.vy > .5)) {
        if (N.reduce) { style('', '', ''); select(null); return; }
        style(SETTLE, 'translateY(60%)', '0');
        setTimeout(() => { style('', '', ''); if (MV && MV.sel === id) select(null); }, 200);
        return;
      }
      if (!cancel && id && g.axis === 'x' && (Math.abs(g.dx) > 60 || Math.abs(g.vx) > .5)) {
        const ids = pins(), k = ids.indexOf(id), dir = g.dx < 0 ? 1 : -1;
        if (ids.length > 1) {
          select(ids[(k + dir + ids.length) % ids.length]);
          if (N.reduce) { style('', '', ''); return; }
          style('none', `translateX(${dir * 48}px)`, '0');
          void pw.offsetWidth;
          style(SETTLE, '', '');
          return;
        }
      }
      style(N.reduce ? '' : SETTLE, '', '');
    },
  });
}
function paintMapUi() { if (MV) syncMap(); }
function closeMap() {
  if (!MV) return;
  const my = MV;
  MV = null;
  my.offs.forEach(f => { try { f(); } catch { /* gone */ } });
  if (my.map) { try { my.map.remove(); } catch { /* already gone */ } }
  my.wrap.remove();
  if (V && V.view) V.view.classList.remove('fd-mapon');
}

// ---------- actions ----------
function setView(v) {
  if (v !== 'map' && v !== 'list') return;
  if (v === S.view && (v === 'list' || MV)) return;
  S.view = v; save();
  if (v === 'map') { paintBody(); openMap(); }
  else { closeMap(); compute(); paintBody(); }
}
function setGroupValue(g, v, on) {
  if (g === 'top') { S.top = on; return; }
  if (!GROUPS.includes(g)) return;
  const a = S[g].filter(x => x !== v);
  if (on) a.push(v);
  S[g] = a;
}
function clearSheet() { S.top = false; S.cuisine = []; S.price = []; S.meal = []; S.area = []; S.attrs = []; }
function setSort(v) {
  if (!SORTS.some(x => x[0] === v)) return;
  if (v === S.sort) return;
  if (v === 'near') {
    if (S.sort !== 'near') S.prevSort = S.sort;
    S.sort = 'near'; save(); refresh();
    const before = N.lastWhere && N.lastWhere();
    if (before && !locating) return;   // already have a fix; "Update" refreshes it
    locate().then(w => { if (!w && S.sort === 'near' && !(N.lastWhere && N.lastWhere())) { S.sort = S.prevSort || 'best'; save(); refresh(); } });
    return;
  }
  S.sort = v; save(); refresh();
}
function setQuery(v) {
  clearTimeout(qT);
  if (Q === v) return;
  const before = listKey();
  Q = v;
  refresh();
  if (MV && listKey() !== before) fit(true);
}
const changed = fn => { const before = listKey(); fn(); save(); refresh(); if (MV && listKey() !== before) { select(null); fit(true); } };
const disabled = el => el && el.getAttribute('aria-disabled') === 'true';

const actions = {
  q(el) {
    const v = String(el.value || '');
    const x = el.parentNode && N.$('.fd-qx', el.parentNode);
    if (x) x.hidden = !v;
    clearTimeout(qT);
    qT = setTimeout(() => setQuery(v), 120);
  },
  sort(el) { setSort(el.value); },
  fdClearQ() {
    $$v('.fd-q').forEach(i => { i.value = ''; });
    $$v('.fd-qx').forEach(x => { x.hidden = true; });
    setQuery('');
    const i = $v('.fd-q'); if (i && !MV) i.focus({preventScroll: true});
  },
  fdOpen(el) { if (disabled(el)) return; changed(() => { S.open = !S.open; }); },
  fdType(el, ev, ctx, t) { if (disabled(el) || !t) return; changed(() => setGroupValue('types', t, !S.types.includes(t))); },
  fdNear() {
    if (S.sort === 'near') { setSort(S.prevSort && S.prevSort !== 'near' ? S.prevSort : 'best'); return; }
    setSort('near');
    if (MV) { const w = N.lastWhere && N.lastWhere(); if (w) panToMe(w); else locate({pan: true}); }
  },
  fdLocate(el, ev, ctx, arg) {
    locate({pan: arg === 'pan'});
  },
  fdView(el, ev, ctx, v) { setView(v); },
  fdSheet() { openSheet(); },
  fdSheetX() { closeSheet(); },
  fdOpt(el, ev, ctx, arg) {
    if (disabled(el) || !arg) return;
    const k = arg.indexOf('|'), g = arg.slice(0, k), v = arg.slice(k + 1);
    changed(() => setGroupValue(g, v, g === 'top' ? !S.top : !(S[g] || []).includes(v)));
    paintSheet(arg);
  },
  fdMore(el, ev, ctx, which) { if (!SH) return; SH[which] = !SH[which]; paintSheet(which === 'allC' || which === 'allN' ? null : null); },
  fdClearSheet() { changed(clearSheet); const x = SH && N.$('.fd-x', SH.el); if (x) x.focus({preventScroll: true}); },
  fdDrop(el, ev, ctx, arg) {
    if (!arg) return;
    const k = arg.indexOf('|');
    changed(() => setGroupValue(arg.slice(0, k), arg.slice(k + 1), false));
  },
  fdClearF() { changed(() => { clearSheet(); S.open = false; S.types = []; }); },
  fdClearAll() {
    $$v('.fd-q').forEach(i => { i.value = ''; });
    changed(() => { clearSheet(); S.open = false; S.types = []; Q = ''; });
  },
  fdFit() { select(null); fit(true); },
  fdUnsel() { select(null); },
};

// ---------- screen ----------
N.screen('food', {
  nav: 4,
  tone: 'band',
  // 'force' too, so a theme switch reaches update() and the map recolours.
  uses: ['food', 'trip', 'force'],
  keepScroll: true,
  title: 'Food',
  render() {
    compute();
    return {hero: heroHtml(), body: bodyHtml(staggerNext)};
  },
  mount(ctx, view) {
    staggerNext = false;
    V = {view, offs: [], had: hasData()};
    const onKey = ev => {
      const t = ev.target;
      if (!t || !t.classList || !t.classList.contains('fd-q')) return;
      if (ev.key === 'Enter') { ev.preventDefault(); setQuery(String(t.value || '')); t.blur(); }
      else if (ev.key === 'Escape' && t.value) { ev.preventDefault(); ev.stopPropagation(); actions.fdClearQ(); }
    };
    view.addEventListener('keydown', onKey);
    V.offs.push(() => view.removeEventListener('keydown', onKey));
    V.offs.push(N.on('where', () => refresh()));
    V.offs.push(N.on('net', () => { if (V && !hasData()) paintBody(); }));
    if (N.whereOk && N.whereOk() && N.where) N.where().then(w => { if (w && V) refresh(); }).catch(() => {});
    if (S.view === 'map' && hasData()) openMap();
    else if (lastY) { const y = lastY; requestAnimationFrame(() => { if (V) view.scrollTop = y; }); }
    if (!MV) memo = null;
    requestAnimationFrame(() => { if (V) { safe(revealChips); safe(fitBadges); } });
    // tags are fitted to the line, so a rotation or the web font arriving fits them again
    let fitRaf = 0;
    const refit = () => { cancelAnimationFrame(fitRaf); fitRaf = requestAnimationFrame(() => { if (V) safe(fitBadges); }); };
    window.addEventListener('resize', refit);
    V.offs.push(() => { window.removeEventListener('resize', refit); cancelAnimationFrame(fitRaf); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit, () => {});
    return () => {
      closeSheet(true);
      const to = safe(() => N.route().name, '');
      lastY = view.scrollTop;
      memo = to === 'place' ? {map: MV && MV.map ? {c: MV.map.getCenter(), z: MV.map.getZoom(), sel: MV.sel} : null} : null;
      closeMap();
      clearTimeout(qT);
      if (V) V.offs.forEach(f => { try { f(); } catch { /* gone */ } });
      V = null;
      staggerNext = to !== 'place' && !lastY;   // cards rise in only when the list opens at its top
    };
  },
  update(ctx, why) {
    if (!V) return;
    const has = hasData();
    if (has !== V.had) {
      V.had = has;
      const q = $v('.fd-q');
      if (q && document.activeElement === q) { refresh(); return; }
      if (!has) closeMap();
      compute(); paintHero(); paintBody();
      if (has && S.view === 'map') openMap();
      return;
    }
    refresh();
    if (why === 'force') restyleMap();
  },
  tick() {
    if (!V) return;
    const before = listKey();
    const prevStates = R ? new Map(R.list.map(m => [m.id, m.hr.state + (m.hr.short || '') + (m.hr.text || '')])) : new Map();
    compute();
    paintHero();
    if (listKey() !== before || S.sort === 'open') { refresh(); return; }
    paintControls();
    for (const m of R.list) {
      if (prevStates.get(m.id) === m.hr.state + (m.hr.short || '') + (m.hr.text || '')) continue;
      $$v(`[data-fdst="${CSS.escape(m.id)}"]`).forEach(e => { e.outerHTML = String(stChip(m)); });
    }
    if (MV) paintPins();
  },
  actions,
});
})();
