#!/usr/bin/env node
// Assemble the trip's food bundle from the raw Yelp captures.
//
//   node food/assemble.mjs           raw/{collection,biz/*,page/*}.json  -> food/base.json
//                                    (every non-AI field of the food schema, plus `_`-prefixed helper fields)
//   node food/assemble.mjs --merge   food/base.json + food/ai/<id>.json + food/prices/<id>.json -> food/food.json
//                                    (contract shape {schema, source, collected_at, places}; see app/CONTRACT.md)
//
// Both outputs are plaintext and live in gitignored food/*.json; app/build.mjs encrypts food.json later.
// Node 18+, no dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.join(DIR, 'raw');
const AI_DIR = path.join(DIR, 'ai');
const PRICE_DIR = path.join(DIR, 'prices');
const BASE_FILE = path.join(DIR, 'base.json');
const OUT_FILE = path.join(DIR, 'food.json');
const SOURCE = 'yelp collection';
const MAX_PHOTOS = 30;
const PHOTO_ID = /bphoto\/([A-Za-z0-9_-]{22})\//;

const STYLES = ['sit-down', 'casual', 'counter', 'bar', 'market'];
const MEALS = ['breakfast', 'brunch', 'lunch', 'dinner', 'late'];

// ---------------------------------------------------------------- small helpers

const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const uniq = (a) => [...new Set(a.filter((x) => x != null && x !== ''))];
const lines = (s) => (s || '').split('\n').map((l) => l.trim()).filter(Boolean);
// Loose key for name matching: accents, curly quotes, punctuation and case removed.
const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[’‘`]/g, "'").toLowerCase().replace(/[^a-z0-9']+/g, ' ').trim();

const ENTITIES = { amp: '&', apos: "'", quot: '"', lt: '<', gt: '>', nbsp: ' ' };
// JSON-LD strings on Yelp are HTML-escaped ("Katz&apos;s").
function decode(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Slice of `text` after the `start` marker (searched from `from`), cut at the earliest `ends` marker.
function section(text, start, ends, max = 6000, from = 0) {
  const i = text.indexOf(start, Math.max(0, from));
  if (i < 0) return null;
  const s = text.slice(i + start.length, i + start.length + max);
  let cut = s.length;
  for (const e of ends) {
    const j = s.indexOf(e);
    if (j >= 0 && j < cut) cut = j;
  }
  return s.slice(0, cut);
}

// Strip tracking params and normalise host case; null for anything that is not http(s).
function cleanUrl(u) {
  try {
    const url = new URL(u);
    if (!/^https?:$/.test(url.protocol)) return null;
    for (const k of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|y_source$|referrer$)/i.test(k)) url.searchParams.delete(k);
    }
    return url.toString();
  } catch { return null; }
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

// ---------------------------------------------------------------- hours

const DAY_LONG = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
const DAY_ABBR = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const minutes = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const to24 = (h, m, ap) => ((+h % 12) + (ap === 'PM' ? 12 : 0)) * 60 + +m;

// JSON-LD openingHours: ["Monday 11:30-16:00", "Monday 17:00-21:30", ...]; unlisted days are closed.
// A close at or before the open means "after midnight", so it is pushed past 24:00.
function ldHours(list) {
  const out = [];
  for (const s of list || []) {
    const m = /^(\w+)\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(s).trim());
    if (!m || !(m[1] in DAY_LONG)) continue;
    const o = +m[2] * 60 + +m[3];
    let c = +m[4] * 60 + +m[5];
    if (c <= o) c += 1440;
    out.push([DAY_LONG[m[1]], o, c]);
  }
  return out;
}

// The visible hours table ("Mon / 11:00 AM - 2:00 AM (Next day) / Closed"), used to cross-check JSON-LD.
function textHours(text) {
  const loc = text.indexOf('Location & Hours');
  if (loc < 0) return null;
  const sec = section(text, 'Get directions', ['Open now', 'Closed now', 'Amenities and More',
    'You Might Also Consider', 'About the Business', 'Ask the Community'], 3000, loc);
  if (!sec) return null;
  const out = [];
  let day = null, seen = 0;
  for (const l of lines(sec)) {
    if (l in DAY_ABBR) { day = DAY_ABBR[l]; seen++; continue; }
    if (day == null) continue;
    if (/^Open 24 hours$/i.test(l)) { out.push([day, 0, 1440]); continue; }
    const m = /^(\d{1,2}):(\d{2}) (AM|PM) - (\d{1,2}):(\d{2}) (AM|PM)( \(Next day\))?$/.exec(l);
    if (!m) continue;
    const o = to24(m[1], m[2], m[3]);
    let c = to24(m[4], m[5], m[6]);
    if (m[7] || c <= o) c += 1440;
    out.push([day, o, c]);
  }
  return seen ? out : null;
}

const sortHours = (h) => h.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const hoursKey = (h) => sortHours([...h]).map((r) => r.join('-')).join(',');

// "Closed Mondays", "Closed Mon–Wed", "Closed Mon, Wed"; Monday-first so weekends read naturally.
function hoursNote(hours) {
  if (!hours.length) return 'Hours not listed on Yelp';
  const open = new Set(hours.map((h) => h[0]));
  const order = [1, 2, 3, 4, 5, 6, 0];
  const closed = order.filter((d) => !open.has(d));
  const notes = [];
  if (closed.length === 1) notes.push(`Closed ${LONG[closed[0]]}s`);
  else if (closed.length > 1 && closed.length < 7) {
    // One contiguous run, possibly wrapping the week (Sun–Wed), reads as a range.
    const start = order.findIndex((d, i) => !open.has(d) && open.has(order[(i + 6) % 7]));
    const run = [];
    for (let i = start; !open.has(order[i % 7]) && run.length < 7; i++) run.push(order[i % 7]);
    notes.push(run.length === closed.length
      ? `Closed ${ABBR[run[0]]}–${ABBR[run.at(-1)]}`
      : `Closed ${closed.map((d) => ABBR[d]).join(', ')}`);
  }
  const allDay = order.filter((d) => hours.some((h) => h[0] === d && h[1] === 0 && h[2] >= 1440));
  if (allDay.length) notes.push(`Open 24 hours ${allDay.map((d) => ABBR[d]).join(', ')}`);
  return notes.join('; ') || null;
}

// ---------------------------------------------------------------- page text sections

// "Location & Hours" block: [Located in: <venue>], street lines (incl. "Fl 3"), "City, ST 12345", neighborhoods.
function locationBlock(text) {
  const loc = text.indexOf('Location & Hours');
  if (loc < 0) return null;
  const sec = section(text, 'Suggest an edit', ['Get directions'], 800, loc);
  if (!sec) return null;
  const ls = lines(sec);
  const out = { located_in: null, street: [], city: null, hoods: [] };
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    if (l === 'Located in:') { out.located_in = ls[++i] || null; continue; }
    const m = /^(.+), ([A-Z]{2}) (\d{5})(?:-\d{4})?$/.exec(l);
    if (!out.city && m) { out.city = { line: l, locality: m[1], state: m[2], zip: m[3] }; continue; }
    if (out.city) { if (!out.hoods.length) out.hoods = l.split(/,\s*/); continue; }
    out.street.push(l);
  }
  return out;
}

// Header line after "Claimed"/"Unclaimed": "$$ Ramen, Noodles, Izakaya" (price optional).
function headerCategories(text) {
  const m = /\n[ \t]*(?:Claimed|Unclaimed)[ \t]*\n([^\n]*)\n/.exec(text);
  if (!m) return { price: null, cats: [] };
  const pm = /^(\$+)\s*(.*)$/.exec(m[1].trim());
  const rest = pm ? pm[2] : m[1].trim();
  return { price: pm ? pm[1] : null, cats: rest ? rest.split(/,\s*/) : [] };
}

// Tab-indented label lines of a section ("\tOutdoor seating").
function tabLabels(text, start, ends, max = 3000) {
  const sec = section(text, start, ends, max);
  if (!sec) return [];
  return sec.split('\n').filter((l) => l.startsWith('\t')).map((l) => l.trim()).filter(Boolean);
}

const amenityLabels = (text) => tabLabels(text, 'Amenities and More',
  ['\nShow Less', '\nAbout the Business', '\nAsk the Community', 'More Attributes', '\nRecommended Reviews'], 4000)
  .filter((l) => !/^Powered by /.test(l) && !/^\d+ More Attributes?$/i.test(l));

// "What's the vibe?" tags; Yelp shows only attributes that are true here.
const vibeTags = (text) => tabLabels(text, "What's the vibe?",
  ['People also searched for', 'Highlights from the Business', 'Location & Hours', 'Review Highlights'], 2500)
  .filter((l) => !/^(Open now|Closed now|\d+ more attributes?)$/i.test(l));

// "Highlights from the Business": positive, self-describing badges ("Takes reservations", "Free WiFi").
function businessHighlights(text) {
  const sec = section(text, 'Highlights from the Business',
    ['People also searched for', 'Review Highlights', 'Location & Hours'], 1500);
  return sec ? lines(sec) : [];
}

// Popular items: "[$27.00]\n\nTagliatelle\n\n90 Photos 99 Reviews".
function popularBlock(text) {
  const m = /\n(Popular Dishes|Popular Desserts|Popular Drinks|Popular Items|Most mentioned offerings)\n/.exec(text);
  if (!m) return [];
  const block = section(text.slice(m.index), m[1], ["What's the vibe?", 'Location & Hours', 'Review Highlights',
    'People also searched for', 'Highlights from the Business', 'Amenities and More'], 8000) || '';
  const re = /(?:^|\n)(?:\$([\d,.]+)\n\n)?([^\n$][^\n]*)\n\n(?:(\d[\d,]*) Photos?)?[\s ]*(?:(\d[\d,]*) Reviews?)?(?=\n|$)/g;
  const out = [];
  for (const x of block.matchAll(re)) {
    if (!x[3] && !x[4]) continue;
    const name = x[2].trim();
    if (!name || /^View full menu$/i.test(name) || out.some((p) => norm(p.name) === norm(name))) continue;
    out.push({ name, price: x[1] ? `$${x[1]}` : null, photos: +(x[3] || '0').replace(/,/g, ''), reviews: +(x[4] || '0').replace(/,/g, '') });
  }
  return out;
}

// ---------------------------------------------------------------- cuisine

// Yelp category title -> clean cuisine labels. [] drops generic or non-cuisine categories.
const CUISINE_MAP = {
  'American': ['American'], 'American (New)': ['New American'], 'American (Traditional)': ['American'],
  'Asian Fusion': ['Asian Fusion'], 'Bagels': ['Bagels'], 'Bakeries': ['Bakery'], 'Barbeque': ['BBQ'],
  'Breakfast & Brunch': ['Breakfast & Brunch'], 'Burgers': ['Burgers'], 'Cafes': ['Cafe'], 'Cantonese': ['Chinese'],
  'Caribbean': ['Caribbean'], 'Chicken Shop': ['Chicken'], 'Chicken Wings': ['Chicken'], 'Chinese': ['Chinese'],
  'Chocolatiers & Shops': ['Chocolate', 'Desserts'], 'Cocktail Bars': ['Cocktail Bar'], 'Coffee & Tea': ['Coffee'],
  'Comfort Food': ['Comfort Food'], 'Cupcakes': ['Bakery', 'Desserts'], 'Delis': ['Deli'], 'Desserts': ['Desserts'],
  'Dim Sum': ['Chinese', 'Dumplings'], 'Diners': ['Diner'], 'Donuts': ['Donuts', 'Bakery'], 'Dumplings': ['Dumplings'],
  'Falafel': ['Middle Eastern', 'Falafel'], 'Food Court': ['Food Hall'], 'Food Stands': ['Street Food'],
  'French': ['French'], 'Gelato': ['Ice Cream'], 'Gluten-Free': ['Gluten-Free'], 'Greek': ['Greek'], 'Halal': ['Halal'],
  'Hot Dogs': ['Hot Dogs'], 'Hot Pot': ['Hot Pot'], 'Ice Cream & Frozen Yogurt': ['Ice Cream'], 'Indian': ['Indian'],
  'Italian': ['Italian'], 'Izakaya': ['Japanese', 'Izakaya'], 'Japanese': ['Japanese'], 'Jewish': ['Jewish'],
  'Juice Bars & Smoothies': ['Juice'], 'Korean': ['Korean'], 'Kosher': ['Kosher'], 'Latin American': ['Latin American'],
  'Lebanese': ['Middle Eastern', 'Lebanese'], 'Malaysian': ['Malaysian'], 'Mediterranean': ['Mediterranean'],
  'Mexican': ['Mexican'], 'Middle Eastern': ['Middle Eastern'], 'New American': ['New American'], 'Noodles': ['Noodles'],
  'Pancakes': ['Breakfast & Brunch'], 'Pasta Shops': ['Italian'], 'Patisserie/Cake Shop': ['Bakery', 'Desserts'],
  'Peruvian': ['Latin American', 'Peruvian'], 'Pizza': ['Pizza'], 'Ramen': ['Ramen', 'Japanese'], 'Salad': ['Salad'],
  'Sandwiches': ['Sandwiches'], 'Seafood': ['Seafood'], 'Shanghainese': ['Chinese'], 'Smokehouse': ['Smokehouse'],
  'Soup': ['Soup'], 'Southern': ['Southern'], 'Spanish': ['Spanish'], 'Steakhouses': ['Steakhouse'],
  'Street Vendors': ['Street Food'], 'Sushi Bars': ['Sushi', 'Japanese'], 'Szechuan': ['Chinese', 'Sichuan'],
  'Tacos': ['Tacos', 'Mexican'], 'Taiwanese': ['Taiwanese'], 'Tapas Bars': ['Spanish'], 'Thai': ['Thai'],
  'Tuscan': ['Italian'], 'Ukrainian': ['Ukrainian'], 'Vegan': ['Vegan'], 'Vegetarian': ['Vegetarian'],
  'Vietnamese': ['Vietnamese'], 'Wine Bars': ['Wine Bar'],
  // Not cuisines: style/types cover these.
  'Bars': [], 'Beer Bar': [], 'Beer, Wine & Spirits': [], 'Boating': [], 'Convenience Stores': [], 'Fast Food': [],
  'Food': [], 'Lounges': [], 'Nightlife': [], 'Pubs': [], 'Restaurants': [], 'Specialty Food': [],
  'Venues & Event Spaces': [],
  // Loose spellings the AI pass uses in cuisine_add; folded into the Yelp-derived label.
  'Breakfast': ['Breakfast & Brunch'], 'Brunch': ['Breakfast & Brunch'], 'Juice & Smoothies': ['Juice'],
};
// Clean labels that may also arrive verbatim (e.g. from AI cuisine_add) and map to themselves.
const CLEAN_CUISINES = new Set(Object.values(CUISINE_MAP).flat());
const MAP_KEY_LC = new Map(Object.keys(CUISINE_MAP).map((k) => [k.toLowerCase(), k]));
const unmappedCuisine = new Set();
const stats = { hoursChecked: 0 }; // build diagnostics

function cuisineOf(titles, { strict = true } = {}) {
  const out = [];
  for (const raw of titles) {
    const t = decode(String(raw || '')).trim();
    if (!t) continue;
    const key = Object.hasOwn(CUISINE_MAP, t) ? t : MAP_KEY_LC.get(t.toLowerCase()); // AI text may differ in case
    if (key) out.push(...CUISINE_MAP[key]);
    else if (CLEAN_CUISINES.has(t)) out.push(t);
    else {
      // Unknown title: keep it as-is (title-cased) so nothing is silently lost, and report it.
      const hit = [...CLEAN_CUISINES].find((c) => c.toLowerCase() === t.toLowerCase());
      out.push(hit || t.replace(/\b\w/g, (c) => c.toUpperCase()));
      if (!hit && strict) unmappedCuisine.add(t);
    }
  }
  return uniq(out);
}

// ---------------------------------------------------------------- photos

// " - New York, NY" / " - Long Island City, New York, US." (Title Case city only, so it cannot swallow
// a whole "Name - caption - City, NY" chain).
const BOILER_CITY = /\s+-\s+[A-Z][\w.'’]*(?: [A-Z][\w.'’]*)*,\s*(?:NY|New York)(?:,\s*US)?\.?$/;
const KEYWORD_SET = new Set(['food', 'interior', 'exterior', 'outside', 'inside', 'drinks', 'drink', 'menu']);
const ALT_CUT = 220; // yelp_browser.mjs truncates photo alts to this many characters

// Alt/caption text -> human caption or null.
//   "Via Carota - Poached Pear - food, donuts - Italian Near Me - New York, New York" -> "Poached Pear"
//   "Photo of Via Carota - New York, NY, US. Tagliatelle"                              -> "Tagliatelle"
//   "Katz's Delicatessen - Simple delicious Rueben pastrami - New York, NY"            -> "Simple delicious Rueben pastrami"
// `browserAlt` marks a photo-page alt from yelp_browser.mjs, the only source that can be cut short.
function cleanCaption(raw, name, browserAlt = false) {
  let s = decode(String(raw || '')).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const photoOf = /^Photo of .+? - [^.]+?, [A-Z]{2}, US\.?\s*/.exec(s);
  if (photoOf) s = s.slice(photoOf[0].length);
  else {
    // "... - Comfort Food Near Me - New York, New York"; alts can also be cut off after "Near Me -".
    const yelpAlt = / - [^-]+ Near Me(?: -|$)/.test(s);
    // yelp_browser.mjs keeps only 220 chars of an alt, so a long one loses its "Near Me" tail and
    // ends inside the keyword list or category ("... - food, blue, potato - Bars Nea").
    const cut = browserAlt && !yelpAlt && String(raw).length >= ALT_CUT && s.includes(' - ');
    s = s.replace(BOILER_CITY, '').replace(/\s+-\s+[^-]+ Near Me(?:\s+-.*)?$/, '');
    if (cut) s = s.replace(/\s+-\s*$/, '');
    let segs = s.split(' - ');
    const n = norm(name);
    // Drop the business-name prefix, which may itself contain " - " ("Momofuku Noodle Bar - Uptown").
    // Yelp alts always start with the name, so for them the first segment goes even on a loose mismatch.
    const k = name.split(' - ').length;
    if (segs.length >= k && norm(segs.slice(0, k).join(' - ')) === n) segs = segs.slice(k);
    else if (segs.length > 1 && (yelpAlt || n.startsWith(norm(segs[0])) || norm(segs[0]).startsWith(n))) segs = segs.slice(1);
    // Yelp alts end with an all-lowercase keyword list ("food, donuts"), which can itself contain
    // " - " ("ball, matzoh ball soup - 1qt frozen, soup"): drop that last segment, then any further
    // keyword-looking ones (short plain terms with commas, or a bare tag). Lowercase prose stays:
    // "everything was precooked", and "(nov special)", "|" or "w/" mark a real caption.
    const kwList = (x) => x.includes(',') && x.split(',').every((w) => /^[\p{Ll}\d &'’-]{0,40}$/u.test(w.trim()));
    const isKw = (x) => x === x.toLowerCase() && (kwList(x) || KEYWORD_SET.has(x) || /^[-\s]*$/.test(x));
    if (yelpAlt && segs.length && segs.at(-1) === segs.at(-1).toLowerCase()) segs.pop();
    // Cut alt: with 2+ segments left the last is a partial keyword list/category, so drop it; a lone
    // segment is the caption itself, cut mid-sentence, so keep it and mark the cut.
    let partial = false;
    if (cut && segs.length >= 2) segs.pop();
    else if (cut) partial = true;
    while (segs.length && isKw(segs.at(-1))) segs.pop();
    s = segs.join(' - ');
    if (partial && s) s = `${s.replace(/\s+\S*$/, '').trimEnd()}…`;
  }
  // Bare upload dates ("08/12/24") say nothing about the photo.
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s)) return null;
  s = s.replace(/\s*\(@[\w.]+\)/g, '').trim();
  // Yelp itself shortens long captions inside alts ("dulce de leche (august speci"); show the cut.
  // Only long ones: a short "Pickles ( Half Sour" is the uploader's own typo, not a cut.
  if (s.length >= 100 && (s.match(/\(/g) || []).length > (s.match(/\)/g) || []).length && !s.endsWith('…')) s = `${s}…`;
  // Unwrap quotes only when they enclose the whole caption ('"trompo" of pork' keeps its quotes).
  const q = /^["“”'](.*)["“”']$/.exec(s);
  if (q && !/["“”]/.test(q[1])) s = q[1].trim();
  // Nothing left, or only (part of) the business name.
  if (!s || norm(name).startsWith(norm(s))) return null;
  return s.length > 160 ? `${s.slice(0, 157).trimEnd()}…` : s;
}

// JSON-LD ImageObjects: the first ItemList is the photo gallery (keywords say food/interior/...),
// a second one (258s.jpg) holds popular-dish photos captioned with the dish name.
function ldImages(ld, name) {
  const lists = ld.filter((x) => x && x['@type'] === 'ItemList');
  const gallery = [], dishes = [];
  lists.forEach((L, li) => {
    for (const e of L.itemListElement || []) {
      if (!e || e['@type'] !== 'ImageObject') continue;
      const id = (PHOTO_ID.exec(e.contentUrl || e.url || '') || [])[1];
      if (!id) continue;
      const kw = (e.keywords || []).map((k) => String(k).toLowerCase());
      const isDish = /\/258s\.jpg$/.test(e.url || '') || li > 0;
      const rec = { id, cap: cleanCaption(e.caption, name), kw };
      (isDish ? dishes : gallery).push(rec);
    }
  });
  return { gallery, dishes };
}

function buildPhotos(page, ld, name) {
  const { gallery, dishes } = ldImages(ld, name);
  // LD gallery captions are clean ("Name - caption - New York, NY"), so they win over browser alts,
  // which carry keyword lists; dish-list captions can be truncated, so they only fill gaps.
  const galleryCap = new Map(gallery.filter((p) => p.cap).map((p) => [p.id, p.cap]));
  const dishCap = new Map(dishes.filter((p) => p.cap).map((p) => [p.id, p.cap]));
  const fromBrowser = (list) => (list || []).map(([id, alt]) => ({
    id, cap: galleryCap.get(id) || cleanCaption(alt, name, true) || dishCap.get(id) || null,
  }));

  const insideCand = [
    ...fromBrowser(page?.photos_inside?.photos),
    ...gallery.filter((p) => p.kw.includes('interior') || p.kw.includes('inside')),
  ];
  const foodCand = [
    ...fromBrowser(page?.photos_food?.photos),
    ...dishes,
    ...gallery.filter((p) => p.kw.includes('food')),
    // Drinks only as a last resort (coffee shops and bars with few food shots).
    ...gallery.filter((p) => p.kw.some((k) => k === 'drinks' || k === 'drink')),
  ];
  const seen = new Set();
  const take = (cands) => {
    const out = [];
    for (const p of cands) {
      if (out.length >= MAX_PHOTOS) break;
      if (!p.id || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ id: p.id, cap: p.cap || null });
    }
    return out;
  };
  const inside = take(insideCand); // inside first so a photo tagged both stays in inside
  const food = take(foodCand);
  return { photos: { food, inside }, dishPhotos: dishes };
}

// Photo for a dish name: the dish ItemList first (captions can be truncated), then food captions.
// Matching is on whole words with a crude plural fold ("Brownie" ~ "Brownies").
// A dish-list hit on a shorter name ("Spicy Pork" for "Spicy Pork Bowl") is rejected when the
// photo's gallery caption names a different form right after it ("Spicy pork wrap").
const dishKey = (s) => norm(s).replace(/\b(\w{3,})s\b/g, '$1');
function photoForDish(name, dishPhotos, food) {
  const n = dishKey(name);
  if (!n) return null;
  const galleryCap = new Map(food.filter((p) => p.cap).map((p) => [p.id, ` ${dishKey(p.cap)} `]));
  const fits = (p, short) => {
    const cap = galleryCap.get(p.id);
    const at = cap ? cap.indexOf(` ${short} `) : -1;
    if (at < 0) return true; // caption says nothing about this dish
    const next = cap.slice(at + short.length + 2).split(' ')[0];
    return !next || next.length < 3 || n.slice(short.length).split(' ').includes(next);
  };
  const exact = dishPhotos.find((p) => p.cap && dishKey(p.cap) === n);
  if (exact) return exact.id;
  const pre = dishPhotos.find((p) => {
    const c = p.cap ? dishKey(p.cap) : '';
    return c.length >= 4 && n.startsWith(`${c} `) && fits(p, c);
  });
  if (pre) return pre.id;
  const f = food.find((p) => p.cap && (n.length >= 4 ? ` ${dishKey(p.cap)} `.includes(` ${n} `) : dishKey(p.cap) === n));
  return f ? f.id : null;
}

// ---------------------------------------------------------------- attributes

// Yelp's "Amenities and More" text is lossy: negated attributes are drawn with a struck icon, so
// innerText shows "Takes reservations" / "Drive-thru" / "TV" whether true or false. Only signals that
// carry their own value are trusted here; the ambiguous labels go to `_unconfirmed` for AI review.
const SELF_VALUED = [
  [/^(Quiet|Moderate noise|Loud|Very Loud)$/i, (a, m) => { a.noise = m[1].toLowerCase().replace(' noise', ''); }],
  [/^Full bar$/i, (a) => { a.alcohol = 'full bar'; }],
  [/^Beer & wine only$/i, (a) => { a.alcohol = 'beer & wine'; }],
  [/^Free Wi-?Fi$/i, (a) => { a.wifi = 'free'; }],
  [/^Paid Wi-?Fi$/i, (a) => { a.wifi = 'paid'; }],
  [/^Casual dress$/i, (a) => { a.attire = 'casual'; }],
  [/^Dressy$/i, (a) => { a.attire = 'dressy'; }],
  [/^Formal \(Jacket required\)$/i, (a) => { a.attire = 'formal'; }],
  [/^Best nights on (.+)$/i, (a, m) => { a.best_nights = m[1]; }],
  [/^Health Score\s*(.+)$/i, (a, m) => {
    const v = m[1].trim();
    a.health = /^\d+(\.\d+)?$/.test(v) ? `${Math.round(+v)} violation points` : v;
  }],
];
const AMBIENCE = /^(Casual|Trendy|Classy|Intimate|Romantic|Hipster|Touristy|Upscale|Divey)(, (Casual|Trendy|Classy|Intimate|Romantic|Hipster|Touristy|Upscale|Divey))*$/i;
const GOOD_FOR = /^Good for ((Breakfast|Brunch|Lunch|Dinner|Dessert|Late night)(, (Breakfast|Brunch|Lunch|Dinner|Dessert|Late night))*)$/i;
const PARKING = /^((Street|Garage|Private lot|Validated|Valet) parking)(, ((Street|Garage|Private lot|Validated|Valet) parking))*$/i;

function buildAttrs({ ldBiz, amen, vibe, highlights, text, redir }) {
  const a = {};
  let goodFor = [];
  const unconfirmed = [];

  for (const l of amen) {
    const hit = SELF_VALUED.find(([re]) => re.test(l));
    if (hit) { hit[1](a, hit[0].exec(l)); continue; }
    if (AMBIENCE.test(l)) { a.ambience = l.toLowerCase(); continue; }
    if (GOOD_FOR.test(l)) { goodFor = GOOD_FOR.exec(l)[1].toLowerCase().split(', '); continue; }
    if (PARKING.test(l)) continue; // JSON-LD parking is authoritative (text parking can be negated too)
    unconfirmed.push(l);
  }

  // Vibe tags are positive only.
  for (const t of vibe) {
    if (/^Outdoor seating$/i.test(t)) a.outdoor = true;
    else if (/^Good for groups$/i.test(t)) a.groups = true;
    else if (/^Good for kids$/i.test(t)) a.kids = true;
    else if (/^Dogs allowed$/i.test(t)) a.dogs = true;
    else if (/^Happy hour specials$/i.test(t)) a.happy_hour = true;
    else if (/^Good for working$/i.test(t)) a.good_for_working = true;
    else if (/^(Quiet|Moderate noise|Loud|Very Loud)$/i.test(t)) a.noise ??= t.toLowerCase().replace(' noise', '');
    else if (AMBIENCE.test(t)) a.ambience ??= t.toLowerCase();
  }

  // Business highlights are positive badges.
  const HL = {
    'takes reservations': ['reservations', true], 'outdoor seating': ['outdoor', true], 'free wifi': ['wifi', 'free'],
    'grab-and-go': ['takeout', true], 'vegan friendly': ['vegan', true], 'vegetarian friendly': ['vegetarian', true],
    'gluten-free friendly': ['gluten_free', true], 'large group friendly': ['groups', true], 'pet friendly': ['dogs', true],
    'full bar': ['alcohol', 'full bar'], 'catering service': ['catering', true], 'kitchen open late': ['late_kitchen', true],
    'private events': ['private_events', true], 'lgbtq friendly': ['lgbtq_friendly', true],
  };
  for (const h of highlights) {
    const hit = HL[h.toLowerCase()];
    if (hit) a[hit[0]] = hit[1];
  }

  // JSON-LD: amenityFeature lists true features only; petsAllowed and paymentAccepted are explicit.
  const feats = Array.isArray(ldBiz.amenityFeature) ? ldBiz.amenityFeature : null;
  const parking = [];
  for (const f of feats || []) {
    const n = String(f.name || '').toLowerCase();
    const v = f.value;
    if (n === 'outdoor seating' && v === true) a.outdoor = true;
    else if (n === 'wheelchair accessible' && v === true) a.wheelchair = true;
    else if (n === 'gender neutral restrooms' && v === true) a.gender_neutral_restrooms = true;
    else if (/parking$/.test(n) && v === true) parking.push(n.replace(/ parking$/, ''));
    // LD values: yes_free | yes_corkage (a fee) | no.
    else if (n === 'corkage' && typeof v === 'string') a.corkage = { yes_free: 'free', yes_corkage: 'fee', no: 'no' }[v] || v.replace(/_/g, ' ');
  }
  if (parking.length) a.parking = parking.join(', ');
  // Outdoor false only when both JSON-LD (which lists it whenever true) and the vibe tags omit it.
  if (feats && feats.length && a.outdoor !== true && amen.some((l) => /^Outdoor seating$/i.test(l))) a.outdoor = false;
  if (typeof ldBiz.petsAllowed === 'boolean') a.dogs = a.dogs === true ? true : ldBiz.petsAllowed;
  const pay = Array.isArray(ldBiz.paymentAccepted) ? ldBiz.paymentAccepted : [];
  if (pay.includes('Credit Card')) a.cards = true;
  if (pay.includes('Apple Pay')) a.apple_pay = true;
  if (pay.includes('Android Pay')) a.android_pay = true;

  // Sidebar widgets: Yelp's own reservation/ordering modules are present only when the business supports them.
  if (/\nMake a reservation\n/.test(text) || /\nFind a Table\n/.test(text)) a.reservations = true;
  if (/\nOrder Food\n(Takeout\n)?Delivery\n/.test(text) || /\nOrder Food\nTakeout\n/.test(text)) {
    a.takeout = true;
    if (/\nOrder Food\n(Takeout\n)?Delivery\n/.test(text)) a.delivery = true;
  } else if (/\nOrder Food\n(\n)?Start Order\n/.test(text)) a.takeout = true;

  // Outbound business links on the page (reservation / online ordering).
  for (const r of redir) {
    const host = hostOf(r.url);
    if (/^make reservation|^reserve|^book/i.test(r.text) || /(opentable|resy|sevenrooms|exploretock|tock)\./.test(host)) {
      a.reservations = true;
      a.reserve_url ??= cleanUrl(r.url);
    } else if (/^order (now|online)/i.test(r.text)) {
      a.takeout ??= true;
      a.order_url ??= cleanUrl(r.url);
    }
  }
  return { attrs: a, goodFor, unconfirmed };
}

// ---------------------------------------------------------------- style / types / meals heuristics

const BAR_CATS = new Set(['Bars', 'Cocktail Bars', 'Wine Bars', 'Beer Bar', 'Pubs', 'Lounges', 'Speakeasies', 'Dive Bars']);
const COUNTER_CATS = new Set(['Bakeries', 'Coffee & Tea', 'Cafes', 'Desserts', 'Ice Cream & Frozen Yogurt', 'Gelato',
  'Bagels', 'Delis', 'Donuts', 'Cupcakes', 'Juice Bars & Smoothies', 'Chocolatiers & Shops', 'Street Vendors',
  'Fast Food', 'Falafel', 'Sandwiches', 'Patisserie/Cake Shop', 'Hot Dogs', 'Food Stands']);
const SWEET_CATS = new Set(['Bakeries', 'Coffee & Tea', 'Cafes', 'Desserts', 'Ice Cream & Frozen Yogurt', 'Gelato',
  'Donuts', 'Cupcakes', 'Juice Bars & Smoothies', 'Chocolatiers & Shops', 'Patisserie/Cake Shop']);
const MARKET_CATS = new Set(['Food Court', 'Food Halls', 'Farmers Market']);

function guessStyle(cats, price, attrs) {
  const primary = cats[0];
  if (cats.some((c) => MARKET_CATS.has(c))) return 'market';
  if (BAR_CATS.has(primary)) return 'bar';
  if (COUNTER_CATS.has(primary)) return 'counter';
  if (['Pizza', 'Tacos', 'Burgers', 'Halal'].includes(primary) && price === '$') return 'counter';
  if ((price && price.length >= 3) || attrs.reservations === true) return 'sit-down';
  return 'casual';
}

function guessTypes(cats, style, hours, goodFor, attrs) {
  const t = [];
  if (style === 'sit-down') t.push('sit-down');
  if (style === 'casual' || style === 'market') t.push('casual');
  if (style === 'counter' || attrs.takeout === true) t.push('to-go');
  if (style === 'bar' || cats.some((c) => BAR_CATS.has(c))) t.push('bar');
  const has = (...xs) => cats.some((c) => xs.includes(c));
  if (has('Bakeries', 'Patisserie/Cake Shop', 'Donuts', 'Cupcakes', 'Bagels')) t.push('bakery');
  if (has('Desserts', 'Ice Cream & Frozen Yogurt', 'Gelato', 'Chocolatiers & Shops', 'Cupcakes', 'Donuts', 'Patisserie/Cake Shop')) t.push('dessert');
  if (has('Coffee & Tea', 'Cafes')) t.push('coffee');
  if (has('Pizza')) t.push('pizza');
  if (has('Breakfast & Brunch', 'Pancakes') || goodFor.includes('brunch')) t.push('brunch');
  const lateDays = new Set(hours.filter((h) => h[2] >= 24 * 60).map((h) => h[0]));
  if (lateDays.size >= 2 || goodFor.includes('late night') || attrs.late_kitchen) t.push('late-night');
  return uniq(t);
}

function guessMeals(cats, style, hours, goodFor, attrs) {
  const m = new Set(goodFor.map((g) => (g === 'late night' ? 'late' : g)).filter((g) => MEALS.includes(g)));
  const sweetOnly = cats.length > 0 && cats.every((c) => SWEET_CATS.has(c));
  const any = (fn) => hours.some(fn);
  if (style !== 'bar' && any((h) => h[1] <= 9 * 60 && h[2] >= 10 * 60)) m.add('breakfast');
  const brunchy = cats.includes('Breakfast & Brunch') || goodFor.includes('brunch');
  if (brunchy && any((h) => (h[0] === 0 || h[0] === 6) && h[1] <= 11.5 * 60 && h[2] >= 13 * 60)) m.add('brunch');
  if (!sweetOnly && any((h) => h[1] <= 12.5 * 60 && h[2] >= 14 * 60)) m.add('lunch');
  if (!sweetOnly && any((h) => h[1] <= 19 * 60 && h[2] >= 20.5 * 60)) m.add('dinner');
  const lateDays = new Set(hours.filter((h) => h[2] >= 24 * 60).map((h) => h[0]));
  if (lateDays.size >= 2 || attrs.late_kitchen) m.add('late');
  return MEALS.filter((x) => m.has(x));
}

// ---------------------------------------------------------------- places

const BOROUGH = { 'New York': 'Manhattan', 'Manhattan': 'Manhattan', 'Brooklyn': 'Brooklyn', 'Staten Island': 'Staten Island',
  'Bronx': 'Bronx', 'The Bronx': 'Bronx' };
const QUEENS = /^(Queens|Long Island City|Astoria|Flushing|Jackson Heights|Elmhurst|Sunnyside|Woodside|Ridgewood|Forest Hills|Jamaica|Corona|Bayside)$/;
// Neighborhood fallback for pages without a neighborhood line.
const ZIP_HOOD = { 10301: 'St. George', 10023: 'Upper West Side', 10024: 'Upper West Side', 10025: 'Upper West Side',
  10021: 'Upper East Side', 10028: 'Upper East Side', 10019: 'Midtown West', 10036: "Hell's Kitchen", 10001: 'Chelsea',
  10011: 'Chelsea', 10014: 'West Village', 10012: 'SoHo', 10013: 'Tribeca', 10002: 'Lower East Side', 10003: 'East Village',
  10009: 'East Village', 10007: 'Tribeca', 10018: 'Midtown West' };
const BOGUS_HOOD = /^(Uptown|Downtown|Midtown|New York|Aperitivo & Kitchen)$/i;

function findLdBiz(ld) {
  return ld.find((x) => x && x.openingHours && x.address) ||
    ld.find((x) => x && /Restaurant|LocalBusiness|Bakery|CafeOrCoffeeShop|BarOrPub|FoodEstablishment|Store/.test(x['@type'])) || {};
}

function buildPlace(c, biz, page, warn) {
  const id = c.id;
  const b = page?.biz || {};
  const text = b.text || '';
  const ld = Array.isArray(b.ld) ? b.ld : [];
  const L = findLdBiz(ld);
  const name = decode(c.name || biz?.name || L.name || '').trim();
  const say = (msg) => warn.push(`${id}: ${msg}`);
  if (!page) say('no page capture');

  // Ratings: JSON-LD carries the precise average (4.2); the collection rounds to halves.
  const agg = L.aggregateRating || {};
  const rating = Number.isFinite(+agg.ratingValue) && agg.ratingValue !== undefined ? +agg.ratingValue : c.rating ?? null;
  const reviews = Number.isFinite(+agg.reviewCount) && agg.reviewCount !== undefined ? +agg.reviewCount : c.reviews ?? null;
  const head = headerCategories(text);
  const priceLd = /^\$+$/.test(L.priceRange || '') ? L.priceRange : null;
  const price = priceLd || c.price || head.price || null;

  // Categories in priority order: page header (primary first), collection, breadcrumbs.
  const crumbs = (ld.find((x) => x && x['@type'] === 'BreadcrumbList')?.itemListElement || [])
    .map((e) => decode(e.name)).filter((n) => n && n !== 'Restaurants');
  const cats = uniq([...head.cats.map(decode), ...(c.yelp_categories || []).map((y) => decode(y.title)), ...crumbs]);
  const cuisine = cuisineOf(cats);

  // Address and neighborhood: visible Location block, then JSON-LD, then the map-page scrape.
  const loc = locationBlock(text) || { located_in: null, street: [], city: null, hoods: [] };
  const A = L.address || {};
  let address = null;
  if (loc.street.length && loc.city) address = [...loc.street, loc.city.line].join(', ');
  else if (A.streetAddress) {
    // JSON-LD parts can be missing; join only what is there so no "undefined" reaches the app.
    const tail = [A.addressRegion, A.postalCode].filter(Boolean).join(' ');
    address = [decode(A.streetAddress).replace(/\s*\n\s*/g, ', '), A.addressLocality, tail].filter(Boolean).join(', ');
  }
  else if (biz?.address && /^\d/.test(biz.address)) address = biz.address.replace(/^\d+ (?=\d)/, '');
  if (!address) say(`no street address (lat/lon only)${loc.city ? `; Yelp shows only "${loc.city.line}"` : ''}`);
  const locality = loc.city?.locality || A.addressLocality || (c.city || '').split(',')[0] || null;
  const zip = loc.city?.zip || A.postalCode || null;
  let neighborhood = loc.hoods[0] || null;
  if (!neighborhood && biz?.neighborhood && !BOGUS_HOOD.test(biz.neighborhood)) neighborhood = biz.neighborhood;
  if (!neighborhood && zip && ZIP_HOOD[zip]) neighborhood = ZIP_HOOD[zip];
  if (!neighborhood) say('no neighborhood');
  const borough = BOROUGH[locality] || (QUEENS.test(locality || '') ? 'Queens' : locality);

  // Phone: JSON-LD, else the sidebar "Phone number" line.
  const phone = (L.telephone || '').trim() || (/\nPhone number\n\n(\(\d{3}\)[ -]?\d{3}-\d{4})/.exec(text) || [])[1] || null;

  // Outbound links: menu entries are labelled; the website is the domain-labelled (or unlabelled) link.
  const redir = (b.redir || []).filter((r) => r && r.url);
  const menuLink = redir.find((r) => /^(View full menu|Website menu|Full menu)$/i.test(r.text));
  const siteLink = redir.find((r) => /^[\w-]+(\.[\w-]+)+/.test(r.text || '')) ||
    redir.find((r) => !r.text && !/(opentable|resy|toasttab|chowbus|doordash|ubereats|grubhub|seamless)\./.test(hostOf(r.url))) ||
    redir.find((r) => /^Learn More$/i.test(r.text));
  const website = siteLink ? cleanUrl(siteLink.url) : null;
  const menu = cleanUrl(menuLink?.url) || cleanUrl(biz?.menu_url) || null; // cleanUrl also percent-encodes (bāng-bar)

  // Hours: JSON-LD is primary; the visible table is a cross-check.
  const hLd = ldHours(L.openingHours);
  const hTx = textHours(text);
  let hrs = hLd.length ? hLd : (hTx || []);
  if (hLd.length && hTx) {
    stats.hoursChecked++;
    if (hoursKey(hLd) !== hoursKey(hTx)) say(`hours differ: ld=[${hoursKey(hLd)}] text=[${hoursKey(hTx)}] (using JSON-LD)`);
  }
  hrs = sortHours(hrs);
  const hours = hrs.map(([d, o, cl]) => [d, hhmm(o), hhmm(cl)]);

  // Attributes and the heuristics that lean on them.
  const amen = amenityLabels(text);
  const vibe = vibeTags(text);
  const highlights = businessHighlights(text);
  const { attrs, goodFor, unconfirmed } = buildAttrs({ ldBiz: L, amen, vibe, highlights, text, redir });
  const style = guessStyle(cats, price, attrs);
  const types = guessTypes(cats, style, hrs, goodFor, attrs);
  const meals = guessMeals(cats, style, hrs, goodFor, attrs);

  const { photos, dishPhotos } = buildPhotos(page, ld, name);

  // Popular items from the page; fall back to the Yelp menu's most-reviewed items.
  let pop = popularBlock(text);
  if (!pop.length && Array.isArray(biz?.menu)) {
    pop = biz.menu.flatMap((s) => s.items || []).filter((i) => Array.isArray(i.pop) && i.pop[0] > 0)
      .sort((x, y) => y.pop[0] - x.pop[0]).slice(0, 10)
      .map((i) => ({ name: i.n, price: i.p || null, reviews: i.pop[0], photos: i.pop[1] || 0 }));
  }
  const popular = pop.slice(0, 12).map((p) => {
    const o = { name: p.name };
    if (p.price) o.note = p.price;
    const ph = photoForDish(p.name, dishPhotos, photos.food);
    if (ph) o.photo = ph;
    return o;
  });
  const menu_sections = uniq((biz?.menu || []).map((s) => decode(s?.name || '').trim()));

  const place = {
    id, name,
    yelp: `https://www.yelp.com/biz/${encodeURI(id)}`,
    rating, reviews, price, cuisine, style, types, meals,
    neighborhood, borough, address,
    lat: c.lat ?? biz?.lat ?? null, lon: c.lon ?? biz?.lon ?? null,
    phone, website, menu,
    hours, hours_note: hoursNote(hrs),
    attrs, photos, popular, menu_sections,
  };
  if (loc.located_in) place.located_in = loc.located_in;
  // Helper fields for AI refinement; --merge drops every `_` key.
  place._categories = cats;
  place._unconfirmed_amenities = unconfirmed;
  if (highlights.length) place._highlights = highlights;
  if (pop.length) place._popular_stats = pop.slice(0, 12);
  return place;
}

function build() {
  const coll = readJSON(path.join(RAW, 'collection.json'));
  const warn = [];
  let latestRead = coll.fetched_at ? coll.fetched_at * 1000 : 0;
  const places = coll.places.map((c) => {
    const bizPath = path.join(RAW, 'biz', `${c.id}.json`);
    const pagePath = path.join(RAW, 'page', `${c.id}.json`);
    // One damaged capture should cost that place its details, not abort the whole build.
    const load = (p) => {
      if (!fs.existsSync(p)) return null;
      try { return readJSON(p); } catch (e) { warn.push(`${c.id}: unreadable ${path.relative(DIR, p)} (${e.message})`); return null; }
    };
    const biz = load(bizPath);
    const page = load(pagePath);
    if (page?.read_at) latestRead = Math.max(latestRead, Date.parse(page.read_at) || 0);
    return buildPlace(c, biz, page, warn);
  });
  places.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  for (const t of unmappedCuisine) warn.push(`cuisine: unmapped Yelp category "${t}" kept as-is`);

  const base = { schema: 1, source: SOURCE, collected_at: new Date(latestRead).toISOString(), places };
  fs.writeFileSync(BASE_FILE, JSON.stringify(base, null, 1) + '\n');

  const n = (f) => places.filter(f).length;
  console.log(`base: ${places.length} places -> ${path.relative(process.cwd(), BASE_FILE)}`);
  console.log(`  address ${n((p) => p.address)}, neighborhood ${n((p) => p.neighborhood)}, phone ${n((p) => p.phone)}, ` +
    `website ${n((p) => p.website)}, menu ${n((p) => p.menu)}, hours ${n((p) => p.hours.length)}, popular ${n((p) => p.popular.length)}, ` +
    `menu_sections ${n((p) => p.menu_sections.length)}; hours cross-checked against the page table: ${stats.hoursChecked}`);
  console.log(`  photos: food>=10 ${n((p) => p.photos.food.length >= 10)}, food<10 ${n((p) => p.photos.food.length < 10)}, ` +
    `inside>=5 ${n((p) => p.photos.inside.length >= 5)}, inside=0 ${n((p) => !p.photos.inside.length)}`);
  if (warn.length) { console.log(`warnings (${warn.length}):`); for (const w of warn) console.log(`  - ${w}`); }
  return base;
}

// ---------------------------------------------------------------- merge

const strOrNull = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const strList = (v) => (Array.isArray(v) ? uniq(v.map((x) => (typeof x === 'string' ? x.trim() : null))) : null);
const AI_KEYS = new Set(['id', 'summary', 'loved', 'watch', 'order', 'tips', 'vibe', 'wait', 'good_for', 'price_per_person',
  'style', 'types', 'meals', 'cuisine_add', 'popular']);

function applyAI(p, ai, say) {
  for (const k of Object.keys(ai)) if (!AI_KEYS.has(k)) say(`ignored unknown AI key "${k}"`);
  if (ai.id && ai.id !== p.id) say(`AI id "${ai.id}" does not match file name`);
  for (const k of ['summary', 'vibe', 'wait', 'price_per_person']) { const v = strOrNull(ai[k]); if (v) p[k] = v; }
  for (const k of ['loved', 'watch', 'order', 'tips', 'good_for']) { const v = strList(ai[k]); if (v && v.length) p[k] = v; }
  if (STYLES.includes(ai.style)) p.style = ai.style;
  else if (ai.style) say(`AI style "${ai.style}" not in ${STYLES.join('|')}; kept "${p.style}"`);
  const types = strList(ai.types)?.map((t) => t.toLowerCase());
  if (types?.length) p.types = uniq(types);
  const meals = strList(ai.meals)?.map((m) => m.toLowerCase());
  if (meals?.length) {
    const bad = meals.filter((m) => !MEALS.includes(m));
    if (bad.length) say(`AI meals ${JSON.stringify(bad)} dropped`);
    const ok = MEALS.filter((m) => meals.includes(m));
    if (ok.length) p.meals = ok;
  }
  const add = strList(ai.cuisine_add);
  if (add?.length) p.cuisine = uniq([...p.cuisine, ...cuisineOf(add, { strict: false })]);
  if (Array.isArray(ai.popular) && ai.popular.length) {
    const dishPool = p.popular.filter((x) => x.photo).map((x) => ({ id: x.photo, cap: x.name }));
    // An AI-chosen photo must be one of this place's own photos; anything else would show a
    // stranger's (or no) image, so it falls back to name matching.
    const own = new Set([...p.photos.food, ...p.photos.inside, ...dishPool].map((x) => x.id));
    p.popular = ai.popular.filter((x) => x && strOrNull(x.name)).map((x) => {
      const o = { name: x.name.trim() };
      if (strOrNull(x.note)) o.note = x.note.trim();
      let ph = strOrNull(x.photo);
      if (ph && !own.has(ph)) { say(`popular "${o.name}": photo ${ph} is not one of this place's photos; ignored`); ph = null; }
      ph = ph || photoForDish(o.name, dishPool, p.photos.food);
      if (ph) o.photo = ph;
      return o;
    });
  }
}

// AI tags must agree with the hours the app shows: "late" on a place that closes at 23:00
// (ICHIRAN Times Square) sends someone across town to a closed door. Hours win; each drop is reported.
function checkAgainstHours(p, say) {
  if (!p.hours.length) return;
  const rows = p.hours.map(([d, o, c]) => [d, minutes(o), minutes(c)]);
  const any = (fn) => rows.some(fn);
  const drop = (key, vals, why) => {
    const gone = p[key].filter((v) => vals.includes(v));
    if (!gone.length) return;
    p[key] = p[key].filter((v) => !vals.includes(v));
    say(`${key} ${JSON.stringify(gone)} dropped: ${why}`);
  };
  if (!any((r) => r[2] >= 23.5 * 60)) {
    drop('meals', ['late'], 'never open past 23:30');
    drop('types', ['late-night'], 'never open past 23:30');
  }
  if (!any((r) => r[1] <= 10.5 * 60)) drop('meals', ['breakfast'], 'never open by 10:30');
  if (!any((r) => r[1] <= 14 * 60 && r[2] >= 12 * 60)) drop('meals', ['lunch'], 'never open over midday');
  if (!any((r) => r[2] >= 19 * 60)) drop('meals', ['dinner'], 'always closed by 19:00');
}

// Researched prices (food/prices/<id>.json): real menu items with what they cost, the
// sources they came from and when, and how long a visit takes. Kept apart from the AI
// overview so a re-run of either never clobbers the other.
const ITEM_KINDS = ['main', 'small', 'side', 'sweet', 'drink', 'combo', 'per-lb', 'per-person'];
const SRC_KINDS = ['official', 'ordering', 'delivery', 'press', 'social', 'other'];
const CONF = ['high', 'medium', 'low', 'none'];
const MODES = ['grab', 'quick', 'sit', 'market'];
const SEATING = ['none', 'few', 'counter', 'tables'];
const money = (v) => (Number.isFinite(v) && v > 0 && v < 1000 ? Math.round(v * 100) / 100 : null);

function applyPrices(p, pr, say) {
  if (pr.id && pr.id !== p.id) say(`prices id "${pr.id}" does not match file name`);
  const items = (Array.isArray(pr.items) ? pr.items : []).map((x) => {
    if (!x || !strOrNull(x.name)) return null;
    const price = money(x.price);
    if (price == null) { say(`price item "${x.name}": no usable price`); return null; }
    const o = { name: x.name.trim(), price, kind: ITEM_KINDS.includes(x.kind) ? x.kind : 'main' };
    if (x.ours === true) o.ours = true;
    if (strOrNull(x.note)) o.note = x.note.trim();
    return o;
  }).filter(Boolean);
  const sources = (Array.isArray(pr.sources) ? pr.sources : []).filter((s) => s && /^https?:\/\//.test(s.url || ''))
    .filter((s) => !/(^|\.)yelp\.com\//.test(s.url.replace(/^https?:\/\//, '')))
    .map((s) => ({ url: s.url, label: strOrNull(s.label) || new URL(s.url).hostname.replace(/^www\./, ''),
      kind: SRC_KINDS.includes(s.kind) ? s.kind : 'other', ...(strOrNull(s.as_of) ? { as_of: s.as_of.trim() } : {}) }));
  let spend = null;
  if (pr.spend && money(pr.spend.lo) != null) {
    const lo = money(pr.spend.lo), hi = money(pr.spend.hi) ?? lo;
    spend = { lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
    if (strOrNull(pr.spend.basis)) spend.basis = pr.spend.basis.trim();
  }
  const confidence = CONF.includes(pr.confidence) ? pr.confidence : (items.length ? 'low' : 'none');
  if (items.length || spend) {
    p.prices = { items, spend, sources, confidence, checked: strOrNull(pr.checked) || null };
    if (strOrNull(pr.caveat)) p.prices.caveat = pr.caveat.trim();
  }
  const v = pr.visit;
  if (v && MODES.includes(v.mode)) {
    const mins = Array.isArray(v.minutes) && v.minutes.length === 2 && v.minutes.every((n) => Number.isFinite(n) && n > 0 && n < 400)
      ? [Math.min(...v.minutes), Math.max(...v.minutes)] : null;
    p.visit = { mode: v.mode, minutes: mins, seating: SEATING.includes(v.seating) ? v.seating : null,
      takeout: typeof v.takeout === 'boolean' ? v.takeout : null };
    if (strOrNull(v.note)) p.visit.note = v.note.trim();
  } else if (v) say(`visit mode "${v.mode}" not in ${MODES.join('|')}; dropped`);
}

const KEY_ORDER = ['id', 'name', 'yelp', 'rating', 'reviews', 'price', 'cuisine', 'style', 'types', 'meals',
  'neighborhood', 'borough', 'address', 'located_in', 'lat', 'lon', 'phone', 'website', 'menu', 'hours', 'hours_note',
  'attrs', 'photos', 'summary', 'loved', 'watch', 'order', 'tips', 'vibe', 'wait', 'good_for', 'price_per_person',
  'prices', 'visit', 'popular', 'menu_sections'];

function merge() {
  if (!fs.existsSync(BASE_FILE)) { console.log('base.json missing; building it first'); build(); }
  const base = readJSON(BASE_FILE);
  const warn = [];
  const byId = new Map(base.places.map((p) => [p.id, p]));
  const aiFiles = fs.existsSync(AI_DIR) ? fs.readdirSync(AI_DIR).filter((f) => f.endsWith('.json')) : [];
  const merged = new Set();
  for (const f of aiFiles) {
    const id = f.replace(/\.json$/, '');
    const p = byId.get(id);
    if (!p) { warn.push(`ai/${f}: no such place in base.json`); continue; }
    let ai;
    try { ai = readJSON(path.join(AI_DIR, f)); } catch (e) { warn.push(`ai/${f}: unreadable JSON (${e.message})`); continue; }
    if (!ai || typeof ai !== 'object' || Array.isArray(ai)) { warn.push(`ai/${f}: not an object`); continue; }
    applyAI(p, ai, (m) => warn.push(`${id}: ${m}`));
    merged.add(id);
  }
  const priceFiles = fs.existsSync(PRICE_DIR) ? fs.readdirSync(PRICE_DIR).filter((f) => f.endsWith('.json')) : [];
  const priced = new Set();
  for (const f of priceFiles) {
    const id = f.replace(/\.json$/, '');
    const p = byId.get(id);
    if (!p) { warn.push(`prices/${f}: no such place in base.json`); continue; }
    let pr;
    try { pr = readJSON(path.join(PRICE_DIR, f)); } catch (e) { warn.push(`prices/${f}: unreadable JSON (${e.message})`); continue; }
    if (!pr || typeof pr !== 'object' || Array.isArray(pr)) { warn.push(`prices/${f}: not an object`); continue; }
    applyPrices(p, pr, (m) => warn.push(`${id}: ${m}`));
    if (p.prices) priced.add(id);
  }
  for (const p of base.places) checkAgainstHours(p, (m) => warn.push(`${p.id}: ${m}`));

  const problems = [];
  const places = base.places.map((p) => {
    // Uniform shape in contract order: AI fields default to empty so the app can rely on them
    // existing; helper `_` keys are dropped; extras (located_in) follow address.
    const src = { summary: null, loved: [], watch: [], order: [], tips: [], vibe: null, wait: null, good_for: [],
      price_per_person: null, prices: null, visit: null, ...p };
    const out = {};
    for (const k of KEY_ORDER) if (k in src) out[k] = src[k];
    for (const [k, v] of Object.entries(src)) if (!k.startsWith('_') && !(k in out)) out[k] = v;
    const miss = [];
    if (!strOrNull(out.name)) miss.push('name');
    if (!/^https:\/\/www\.yelp\.com\/biz\/[^/?#]+$/.test(out.yelp || '')) miss.push('yelp');
    if (!(Number.isFinite(out.lat) && out.lat > 40.4 && out.lat < 41.0)) miss.push('lat');
    if (!(Number.isFinite(out.lon) && out.lon > -74.3 && out.lon < -73.6)) miss.push('lon');
    if (miss.length) problems.push(`${p.id}: missing/invalid ${miss.join(', ')}`);
    return out;
  });
  places.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

  const food = { schema: 1, source: base.source || SOURCE, collected_at: base.collected_at, places };
  fs.writeFileSync(OUT_FILE, JSON.stringify(food) + '\n');

  const noAI = places.filter((p) => !merged.has(p.id)).map((p) => p.id);
  const soft = places.filter((p) => !p.address || !p.hours.length || !p.photos.food.length).map((p) =>
    `${p.id}:${!p.address ? ' no address' : ''}${!p.hours.length ? ' no hours' : ''}${!p.photos.food.length ? ' no food photos' : ''}`);
  console.log(`food.json: ${places.length} places, AI merged ${merged.size}/${places.length} ` +
    `(${aiFiles.length} ai files), prices ${priced.size}/${places.length}, visit ${places.filter((p) => p.visit).length}, ${(fs.statSync(OUT_FILE).size / 1024).toFixed(0)} KB -> ${path.relative(process.cwd(), OUT_FILE)}`);
  if (noAI.length) console.log(`  without AI (${noAI.length}): ${noAI.join(', ')}`);
  if (soft.length) console.log(`  soft gaps: ${soft.join('; ')}`);
  if (warn.length) { console.log(`warnings (${warn.length}):`); for (const w of warn) console.log(`  - ${w}`); }
  if (problems.length) {
    console.log(`VALIDATION FAILED (${problems.length}):`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
  } else console.log('  validation: every place has name, yelp, lat, lon');
}

// ---------------------------------------------------------------- main

if (process.argv.includes('--merge')) merge();
else build();
