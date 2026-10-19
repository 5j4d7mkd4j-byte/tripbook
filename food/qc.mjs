#!/usr/bin/env node
// Quality check for the assembled food bundle (food/food.json) against app/CONTRACT.md.
//
//   node food/qc.mjs              check every place, print problems and the filter facet counts
//   node food/qc.mjs --quiet      problems only (no facet table)
//
// FAIL = breaks the contract or would mislead on the phone (exit code 1).
// WARN = worth a look, not wrong by itself.
// Reads plaintext from gitignored paths only (food/food.json, food/base.json, food/raw/); prints
// place ids and short phrases, never secrets. Node 18+, no dependencies.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(DIR);
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const food = readJSON(path.join(DIR, 'food.json'));
const coll = readJSON(path.join(DIR, 'raw', 'collection.json'));
const base = fs.existsSync(path.join(DIR, 'base.json')) ? readJSON(path.join(DIR, 'base.json')) : { places: [] };
const cats = new Map(base.places.map((p) => [p.id, p._categories || []]));
// Yelp's amenity text list mixes true and false rows, so it is evidence, not proof (see assemble.mjs).
const amenText = new Map(base.places.map((p) => [p.id, p._unconfirmed_amenities || []]));
const quiet = process.argv.includes('--quiet');

const fails = [], warns = [];
const FAIL = (id, m) => fails.push(`${id}: ${m}`);
const WARN = (id, m) => warns.push(`${id}: ${m}`);

// ---------------------------------------------------------------- vocabularies (contract + food screen)

const STYLES = ['sit-down', 'casual', 'counter', 'bar', 'market'];
const MEALS = ['breakfast', 'brunch', 'lunch', 'dinner', 'late'];
// The contract's list plus the extras app/src/screens/food.js has labels and icons for.
const TYPES = new Set(['sit-down', 'casual', 'to-go', 'quick-bite', 'dessert', 'coffee', 'bakery', 'brunch', 'late-night',
  'pizza', 'sandwiches', 'bar', 'date-night', 'groups', 'outdoor', 'reservations']);
const BOROUGHS = new Set(['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island']);
const KEYS = ['id', 'name', 'yelp', 'rating', 'reviews', 'price', 'cuisine', 'style', 'types', 'meals', 'neighborhood',
  'borough', 'address', 'lat', 'lon', 'phone', 'website', 'menu', 'hours', 'hours_note', 'attrs', 'photos', 'summary',
  'loved', 'watch', 'order', 'tips', 'vibe', 'wait', 'good_for', 'price_per_person', 'prices', 'visit', 'popular',
  'menu_sections'];
const PHOTO = /^[A-Za-z0-9_-]{22}$/;
const HHMM = /^([0-4]\d):([0-5]\d)$/;
const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const strArr = (v) => Array.isArray(v) && v.every(isStr);

// The phone's own hours reader (screens/_shared.js), run in a sandbox with a stub N, so "hours parse"
// means exactly what the app will compute.
function loadAppHours() {
  const N = { now: () => new Date(), set() {}, get() {}, emit() {}, dist: () => 0, data: {} };
  const ctx = vm.createContext({ N, window: {}, navigator: {}, Intl, Date, Math, String, Number, Object, Array });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', 'src', 'screens', '_shared.js'), 'utf8'), ctx);
  return N;
}
const APP = loadAppHours();

// ---------------------------------------------------------------- copy check (own words)

// Word shingles: a run of `n` words shared with the Yelp page (reviews, Q&A, "About the Business")
// means a sentence was lifted rather than written. Dish lists (order/popular) are exempt.
const words = (s) => String(s || '').toLowerCase().replace(/[’‘`]/g, "'").match(/[a-z0-9']+/g) || [];
const shingles = (w, n) => { const out = new Set(); for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' ')); return out; };
function copied(text, pageSet, n) {
  const w = words(text);
  const hits = [];
  for (let i = 0; i + n <= w.length; i++) {
    const g = w.slice(i, i + n).join(' ');
    if (pageSet.has(g)) hits.push(g);
  }
  return hits;
}
// Collapse overlapping n-gram hits into the longest shared phrases.
function phrases(hits, n) {
  const out = [];
  for (const h of hits) {
    const last = out.at(-1);
    if (last && last.split(' ').slice(-(n - 1)).join(' ') === h.split(' ').slice(0, n - 1).join(' ')) out[out.length - 1] = `${last} ${h.split(' ').at(-1)}`;
    else out.push(h);
  }
  return out;
}

// ---------------------------------------------------------------- per-place checks

const ids = new Set(coll.places.map((c) => c.id));
const pagePath = (id) => path.join(DIR, 'raw', 'page', `${id}.json`);
const pageCache = new Map();
const pageText = (id) => {
  if (!pageCache.has(id)) pageCache.set(id, fs.existsSync(pagePath(id)) ? readJSON(pagePath(id))?.biz?.text || '' : '');
  return pageCache.get(id);
};
const seen = new Set();
const photoCounts = [];
const copyReport = [];

for (const p of food.places) {
  const id = p.id || '(no id)';
  if (seen.has(id)) FAIL(id, 'duplicate id');
  seen.add(id);
  if (!ids.has(id)) FAIL(id, 'not in raw/collection.json');
  for (const k of KEYS) if (!(k in p)) FAIL(id, `missing key "${k}"`);

  // Identity and Yelp numbers.
  if (!isStr(p.name)) FAIL(id, 'no name');
  if (p.yelp !== `https://www.yelp.com/biz/${encodeURI(id)}`) FAIL(id, `yelp url ${p.yelp}`);
  if (!(typeof p.rating === 'number' && p.rating >= 1 && p.rating <= 5)) FAIL(id, `rating ${p.rating}`);
  if (!(Number.isInteger(p.reviews) && p.reviews >= 0)) FAIL(id, `reviews ${p.reviews}`);
  if (p.price != null && !/^\${1,4}$/.test(p.price)) FAIL(id, `price "${p.price}"`);
  if (p.price == null) WARN(id, 'no $ price (Yelp lists none and no researched spend)');
  if ('price_est' in p && (p.price_est !== true || p.price == null)) FAIL(id, `price_est ${p.price_est} with price ${p.price}`);
  if ('located_in' in p && !isStr(p.located_in)) FAIL(id, 'located_in empty');

  // Facets.
  if (!strArr(p.cuisine) || !p.cuisine.length) FAIL(id, 'cuisine empty');
  if (!STYLES.includes(p.style)) FAIL(id, `style "${p.style}"`);
  if (!strArr(p.types) || !p.types.length) FAIL(id, 'types empty');
  for (const t of p.types || []) if (!TYPES.has(t)) WARN(id, `type "${t}" has no label in the food screen`);
  if (!Array.isArray(p.meals) || !p.meals.length || p.meals.some((m) => !MEALS.includes(m))) FAIL(id, `meals ${JSON.stringify(p.meals)}`);
  if (!isStr(p.neighborhood)) FAIL(id, 'no neighborhood');
  // Abbreviations and alternate spellings the fold() check below cannot see.
  else if (/^(LES|UES|UWS|FiDi|Soho|TriBeCa|NoLita|Dumbo|Hells Kitchen|Meatpacking|Bowery)$/.test(p.neighborhood)) FAIL(id, `neighborhood "${p.neighborhood}" is an alias`);
  if (!BOROUGHS.has(p.borough)) FAIL(id, `borough "${p.borough}"`);

  // Location: inside the five boroughs' bounding box, and on the right side of the river.
  const { lat, lon } = p;
  if (!(lat > 40.49 && lat < 40.92 && lon > -74.26 && lon < -73.70)) FAIL(id, `lat/lon ${lat},${lon} outside NYC`);
  if (p.borough === 'Manhattan' && !(lat > 40.69 && lat < 40.88 && lon > -74.03 && lon < -73.90)) FAIL(id, `lat/lon ${lat},${lon} not in Manhattan`);
  if (p.borough === 'Brooklyn' && !(lat > 40.56 && lat < 40.74 && lon > -74.05 && lon < -73.83)) FAIL(id, `lat/lon ${lat},${lon} not in Brooklyn`);
  if (p.borough === 'Staten Island' && !(lat > 40.49 && lat < 40.66 && lon > -74.26 && lon < -74.04)) FAIL(id, `lat/lon ${lat},${lon} not on Staten Island`);
  if (!isStr(p.address)) WARN(id, 'no street address (map pin only)');
  else if (!/\b(NY|New York)\b/.test(p.address)) WARN(id, `address "${p.address}" lacks city/state`);

  // Hours: well-formed rows, no overlaps, and the app's reader gives a real answer across a week.
  const hrs = Array.isArray(p.hours) ? p.hours : [];
  if (!hrs.length) FAIL(id, 'no hours');
  const byDay = new Map();
  for (const r of hrs) {
    if (!Array.isArray(r) || r.length !== 3 || !Number.isInteger(r[0]) || r[0] < 0 || r[0] > 6 || !HHMM.test(r[1]) || !HHMM.test(r[2])) {
      FAIL(id, `bad hours row ${JSON.stringify(r)}`); continue;
    }
    const o = toMin(r[1]), c = toMin(r[2]);
    if (o >= 1440 || c <= o || c > 2880) FAIL(id, `hours row ${JSON.stringify(r)} out of range`);
    for (const [o2, c2] of byDay.get(r[0]) || []) if (o < c2 && o2 < c) FAIL(id, `overlapping hours on day ${r[0]}`);
    byDay.set(r[0], [...(byDay.get(r[0]) || []), [o, c]]);
  }
  if (hrs.length) {
    // Every 3 hours across one whole week (any week works; this one is on New York summer time, like the trip).
    const states = new Set();
    for (let t = Date.parse('2026-09-21T04:00:00Z'); t < Date.parse('2026-09-28T04:00:00Z'); t += 3 * 3600e3) {
      try {
        const h = APP.food.hours(p, new Date(t));
        if (!h || !['open', 'closing', 'closed'].includes(h.state) || !isStr(h.text)) FAIL(id, `app hours gave ${JSON.stringify(h)}`);
        states.add(h.state);
      } catch (e) { FAIL(id, `app hours threw: ${e.message}`); break; }
    }
    if (!states.has('open') && !states.has('closing')) FAIL(id, 'app hours never show open during the trip week');
  }

  // Photos: valid ids, no repeats, and enough food shots for the detail gallery.
  const ph = p.photos || {};
  const all = [...(ph.food || []), ...(ph.inside || [])];
  if (!Array.isArray(ph.food) || !Array.isArray(ph.inside)) FAIL(id, 'photos.food/inside not arrays');
  for (const x of all) if (!x || !PHOTO.test(x.id || '')) FAIL(id, `bad photo id ${JSON.stringify(x)}`);
  if (new Set(all.map((x) => x.id)).size !== all.length) FAIL(id, 'a photo appears twice');
  const nf = (ph.food || []).length;
  photoCounts.push([id, nf, (ph.inside || []).length]);
  if (!nf) FAIL(id, 'no food photos');
  else if (nf < 5) WARN(id, `only ${nf} food photos`);
  // Popular-dish photos may come from Yelp's dish list rather than the gallery; only the id format matters.
  for (const x of p.popular || []) {
    if (!isStr(x?.name)) FAIL(id, `popular item without name ${JSON.stringify(x)}`);
    if (x?.photo && !PHOTO.test(x.photo)) FAIL(id, `popular "${x.name}" photo id ${x.photo}`);
  }

  // AI overview text.
  const sum = p.summary || '';
  if (!isStr(sum)) FAIL(id, 'empty summary');
  else {
    const sentences = sum.split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/).filter(Boolean).length;
    if (sentences < 2 || sentences > 3) WARN(id, `summary has ${sentences} sentences (contract: 2–3)`);
    if (sum.length < 120 || sum.length > 520) WARN(id, `summary is ${sum.length} chars`);
  }
  for (const k of ['loved', 'watch', 'order', 'tips', 'good_for']) {
    if (!strArr(p[k]) || !p[k].length) FAIL(id, `${k} empty`);
  }
  for (const k of ['vibe', 'wait', 'price_per_person']) if (!isStr(p[k])) FAIL(id, `${k} empty`);
  if (isStr(p.price_per_person) && !/\$\d/.test(p.price_per_person)) WARN(id, `price_per_person "${p.price_per_person}" has no dollar figure`);
  if (!Array.isArray(p.menu_sections)) FAIL(id, 'menu_sections not an array');
  if (typeof p.attrs !== 'object' || !p.attrs || Array.isArray(p.attrs)) FAIL(id, 'attrs not an object');

  // Researched prices and visit style.
  if (p.prices) {
    const pr = p.prices;
    if (!Array.isArray(pr.items) || pr.items.some((x) => !isStr(x.name) || !(x.price > 0))) FAIL(id, 'prices.items malformed');
    if (pr.spend && !(pr.spend.lo > 0 && pr.spend.hi >= pr.spend.lo)) FAIL(id, `prices.spend ${JSON.stringify(pr.spend)}`);
    if (!['high', 'medium', 'low', 'none'].includes(pr.confidence)) FAIL(id, `prices.confidence ${pr.confidence}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pr.checked || '')) WARN(id, `prices.checked ${pr.checked}`);
  } else WARN(id, 'no researched prices');
  if (p.visit) {
    const v = p.visit;
    if (!['grab', 'quick', 'sit', 'market'].includes(v.mode)) FAIL(id, `visit.mode ${v.mode}`);
    if (v.minutes != null && !(Array.isArray(v.minutes) && v.minutes[0] > 0 && v.minutes[1] >= v.minutes[0])) FAIL(id, `visit.minutes ${v.minutes}`);
  }

  // Category consistency: what Yelp calls the place vs the style/types the app filters on.
  const c = cats.get(id) || [];
  const T = new Set(p.types || []);
  const has = (...xs) => c.some((x) => xs.includes(x));
  const lead = c[0];
  if (has('Bakeries', 'Patisserie/Cake Shop', 'Donuts', 'Cupcakes') && !T.has('bakery') && !T.has('dessert')) FAIL(id, `Yelp says bakery (${c.join(', ')}) but types lack bakery/dessert`);
  if (['Bakeries', 'Patisserie/Cake Shop', 'Donuts', 'Cupcakes', 'Bagels'].includes(lead) && !T.has('bakery') && p.style !== 'sit-down') WARN(id, `primary Yelp category "${lead}" but no bakery type`);
  if (['Desserts', 'Ice Cream & Frozen Yogurt', 'Gelato', 'Chocolatiers & Shops'].includes(lead) && !T.has('dessert')) FAIL(id, `primary Yelp category "${lead}" but no dessert type`);
  if (['Coffee & Tea', 'Cafes'].includes(lead) && !T.has('coffee')) WARN(id, `primary Yelp category "${lead}" but no coffee type`);
  if (has('Pizza') && !T.has('pizza')) WARN(id, 'Yelp says pizza but no pizza type');
  if (T.has('pizza') && !has('Pizza') && !p.cuisine.includes('Pizza')) WARN(id, 'pizza type without pizza cuisine');
  const BARS = ['Bars', 'Cocktail Bars', 'Wine Bars', 'Beer Bar', 'Pubs', 'Lounges', 'Speakeasies', 'Dive Bars'];
  if (BARS.includes(lead) && !T.has('bar')) FAIL(id, `primary Yelp category "${lead}" but no bar type`);
  else if (has(...BARS) && !T.has('bar')) WARN(id, `Yelp also files it under ${c.filter((x) => BARS.includes(x)).join('/')} but no bar type`);
  if (p.style === 'bar' && !T.has('bar')) FAIL(id, 'style bar without bar type');
  if (T.has('bakery') && !p.cuisine.some((x) => /bakery|bagel|bread|patisserie|donut/i.test(x))) WARN(id, 'bakery type without a bakery cuisine');
  // Bakeries and dessert shops pour coffee without Yelp calling them cafes.
  if (T.has('coffee') && !T.has('bakery') && !T.has('dessert') && !p.cuisine.some((x) => /coffee|cafe|tea/i.test(x))) WARN(id, 'coffee type without a coffee/cafe cuisine');
  if (p.style === 'sit-down' && !T.has('sit-down')) WARN(id, 'style sit-down without sit-down type');
  if (p.style === 'counter' && !T.has('to-go') && !T.has('quick-bite')) WARN(id, 'counter style without to-go/quick-bite');
  if (T.has('outdoor') && p.attrs?.outdoor === false) FAIL(id, 'outdoor type but attrs.outdoor is false');
  // Reservations: Yelp's widget/links (attrs), its amenity text, or reviewers who booked a table.
  if (T.has('reservations') && p.attrs?.reservations !== true && !(amenText.get(id) || []).includes('Takes reservations') &&
      !/\b(made|make|had|have|got|get|snagged|book(?:ed)?) (?:a |an |our |the )?(?:\w+ )?reservations?\b|\breserve for\b/i.test(pageText(id))) {
    WARN(id, 'reservations type with no evidence on the Yelp page');
  }
  if (p.attrs?.reservations === true && !T.has('reservations') && p.style === 'sit-down') WARN(id, 'takes reservations but no reservations type');
  // The brunch type is "a brunch spot"; a bagel counter serves the brunch hours without being one.
  if (T.has('brunch') && !p.meals.includes('brunch')) WARN(id, 'brunch type without brunch meal');
  if (!T.has('brunch') && p.meals.includes('brunch') && ['sit-down', 'casual'].includes(p.style)) WARN(id, 'brunch meal on a sit-down spot without the brunch type');
  if (T.has('late-night') !== p.meals.includes('late')) WARN(id, `late-night type ${T.has('late-night')} vs late meal ${p.meals.includes('late')}`);
  if (p.meals.includes('brunch') && !hrs.some(([d, o]) => (d === 0 || d === 6) && toMin(o) <= 12 * 60)) WARN(id, 'brunch meal but not open by noon at the weekend');

  // Own words: summary and notes against the page's reviews, Q&A and business blurb.
  if (fs.existsSync(pagePath(id))) {
    const text = pageText(id);
    const w = words(text);
    const s6 = shingles(w, 6);
    const hitsSum = phrases(copied(sum, s6, 6), 6);
    const hitsNotes = ['loved', 'watch', 'tips', 'vibe', 'wait']
      .flatMap((k) => [].concat(p[k] || []).flatMap((s) => phrases(copied(s, s6, 6), 6).map((h) => `${k}: "${h}"`)));
    if (hitsSum.length) FAIL(id, `summary shares page wording: ${hitsSum.map((h) => `"${h}"`).join('; ')}`);
    if (hitsNotes.length) WARN(id, `notes share page wording: ${hitsNotes.join('; ')}`);
    copyReport.push([id, hitsSum.length, hitsNotes.length]);
  } else WARN(id, 'no raw page to check wording against');
}
for (const id of ids) if (!seen.has(id)) FAIL(id, 'in collection but missing from food.json');

// Near-duplicate facet labels: same text once case, accents, punctuation and "the" are ignored.
const fold = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '').replace(/\bthe\b/g, '').replace(/[^a-z0-9]+/g, '');
for (const key of ['cuisine', 'neighborhood']) {
  const labels = new Map();
  for (const p of food.places) for (const v of [].concat(p[key] || [])) {
    const f = fold(v);
    if (!labels.has(f)) labels.set(f, new Set());
    labels.get(f).add(v);
  }
  for (const [, set] of labels) if (set.size > 1) FAIL(key, `near-duplicate labels ${[...set].map((x) => `"${x}"`).join(' / ')}`);
}

// ---------------------------------------------------------------- report

const count = (fn) => {
  const m = new Map();
  for (const p of food.places) for (const v of [].concat(fn(p))) m.set(v ?? '(none)', (m.get(v ?? '(none)') || 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
};
const line = (label, rows) => console.log(`${label} (${rows.length}): ${rows.map(([k, n]) => `${k} ${n}`).join(', ')}`);

console.log(`food.json: ${food.places.length} places; collection: ${ids.size}`);
if (!quiet) {
  line('style', count((p) => p.style));
  line('types', count((p) => p.types));
  line('meals', count((p) => p.meals));
  line('price', count((p) => p.price));
  const est = food.places.filter((p) => p.price_est);
  if (est.length) console.log(`  (${est.length} estimated from researched spend: ${est.map((p) => `${p.id} ${p.price}`).join(', ')})`);
  line('cuisine', count((p) => p.cuisine));
  line('borough', count((p) => p.borough));
  line('neighborhood', count((p) => p.neighborhood));
  const few = photoCounts.filter(([, f]) => f < 5);
  console.log(`photos: food min ${Math.min(...photoCounts.map((x) => x[1]))}, median ${photoCounts.map((x) => x[1]).sort((a, b) => a - b)[photoCounts.length >> 1]}; ` +
    `inside min ${Math.min(...photoCounts.map((x) => x[2]))}; places with < 5 food photos: ${few.length ? few.map(([i, f]) => `${i} (${f})`).join(', ') : 'none'}`);
  console.log(`wording: ${copyReport.filter((r) => r[1]).length} summaries and ${copyReport.filter((r) => r[2]).length} note sets share 6+ words with their Yelp page`);
}
if (warns.length) { console.log(`\nWARN (${warns.length})`); for (const w of warns) console.log(`  - ${w}`); }
if (fails.length) { console.log(`\nFAIL (${fails.length})`); for (const f of fails) console.log(`  - ${f}`); process.exitCode = 1; }
else console.log('\nPASS: no contract failures');
