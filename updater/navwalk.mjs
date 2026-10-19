#!/usr/bin/env node
/* Walking minutes between gates, worked out the way the app's airport map does it.

     echo '{"pairs": [["ABC", "A1", "C9"]]}' | node updater/navwalk.mjs
     -> {"v":1,"src":"bin","m":[12],"err":[]}

   updater/alerts.py runs this so a connection alert quotes the same walk as the app
   (model.js N.walk takes N.navWalk's minutes when the map has both gates). The path
   code is not copied: app/src/screens/nav.js itself runs in a sandbox with a stand-in
   N, and its own N.navWalk answers, so speeds, gate matching and routing are the app's.

   m[i] is N.navWalk(...pairs[i]): minutes, or null when the map has no route or does not
   know a gate (alerts.py then guesses from the concourse letters, as N.walk does).
   err lists the pairs whose lookup threw inside nav.js (null in m; not worth keeping).

   Map data, the first that opens:
     --guide FILE    a sealed guide, default docs/data/guide.bin (what the phones have),
                     key from TRIP_KEY or .secrets via tools/tripcrypt.mjs
     --nav-dir DIR   DIR/<CODE>.json attached to the airports of DIR/../guide.json the way
                     app/build.mjs does (to every code when there is no guide.json);
                     default guide/nav, which only exists on the Mac
   With --nav-dir and no --guide, only the directory is used.

   Gates come on stdin, never in argv. stdout holds only the JSON answer. A failure is
   one fixed line on stderr (no gates, no map data) and a non-zero exit.
*/
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {open, loadKey, ROOT} from '../tools/tripcrypt.mjs';

const NAV_JS = path.join(ROOT, 'app/src/screens/nav.js');
const MAX_PAIRS = 64;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function fail(why, code = 1) {
  process.stderr.write(`navwalk: ${why}\n`);
  process.exit(code);
}

// ---------- map data ----------
function fromBin(file) {
  if (!fs.existsSync(file)) return null;
  const g = open(fs.readFileSync(file), loadKey());
  return g && typeof g === 'object' && g.airports ? g : null;
}

// As app/build.mjs data(): guide/nav/<CODE>.json rides along on guide.airports[CODE].
function fromDir(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const gj = path.join(dir, '..', 'guide.json');
  const all = !fs.existsSync(gj);
  const guide = all ? {airports: {}} : JSON.parse(fs.readFileSync(gj, 'utf8'));
  if (!guide.airports || typeof guide.airports !== 'object') guide.airports = {};
  let n = 0;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    const code = path.basename(f, '.json').toUpperCase();
    if (!guide.airports[code]) {
      if (!all) continue;
      guide.airports[code] = {};
    }
    guide.airports[code].nav = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    n++;
  }
  return n ? guide : null;
}

export function loadGuide({guideFile = null, navDir = null} = {}) {
  const tries = [];
  if (guideFile || !navDir) tries.push(['bin', () => fromBin(guideFile || path.join(ROOT, 'docs/data/guide.bin'))]);
  if (navDir || !guideFile) tries.push(['json', () => fromDir(navDir || path.join(ROOT, 'guide/nav'))]);
  for (const [src, load] of tries) {
    let g = null;
    try { g = load(); } catch { g = null; }
    if (g) return {src, guide: g};
  }
  return null;
}

// ---------- nav.js in a sandbox ----------
// nav.js at load time reads N.h and N.icon, keeps `document`, defines N.navWalk and
// registers its screen. Everything else it touches runs only when the screen draws.
export function loadNav(guide, file = NAV_JS) {
  const errs = [];
  const N = {
    data: {guide},
    h: (s, ...v) => s.reduce((a, x, i) => a + x + (i < v.length ? String(v[i]) : ''), ''),
    icon: () => '',
    screen: () => {},
    report: (e, where) => { errs.push(String(where || '')); },
  };
  // model.js, word for word.
  N.guideFor = code => N.data.guide && N.data.guide.airports && N.data.guide.airports[code] || null;
  const ctx = vm.createContext({N, window: {}, document: {}, navigator: {}});
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, {filename: 'nav.js', timeout: 5000});
  if (typeof N.navWalk !== 'function') throw new Error('no N.navWalk');
  return {walk: N.navWalk, errs};
}

// m[i] for pairs[i] (number or null), and the indices whose lookup threw.
export function walkPairs(nav, pairs) {
  const m = [], err = [];
  pairs.forEach((p, i) => {
    const ok = Array.isArray(p) && p.length === 3 && p.every(x => typeof x === 'string' && x.length <= 40);
    if (!ok) { m.push(null); return; }
    const before = nav.errs.length;
    let v = null;
    try { v = nav.walk(p[0], p[1], p[2]); } catch { v = null; nav.errs.push('throw'); }
    if (nav.errs.length > before) err.push(i);
    m.push(typeof v === 'number' && Number.isFinite(v) ? v : null);
  });
  return {m, err};
}

function main() {
  let req;
  try { req = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { fail('bad input', 2); }
  const pairs = req && Array.isArray(req.pairs) ? req.pairs : null;
  if (!pairs || pairs.length > MAX_PAIRS) fail('bad input', 2);
  const got = loadGuide({guideFile: arg('--guide'), navDir: arg('--nav-dir')});
  if (!got) fail('no map data', 3);
  let nav;
  try { nav = loadNav(got.guide); } catch (e) { fail(`nav.js did not load (${e && e.name || 'Error'})`); }
  const {m, err} = walkPairs(nav, pairs);
  process.stdout.write(JSON.stringify({v: 1, src: got.src, m, err}) + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
