// Builds the site into docs/ (GitHub Pages serves main:/docs).
//
//   node app/build.mjs            page + encrypted data
//   node app/build.mjs --no-data  page only (fast, for screen work)
//   node app/build.mjs --out DIR  write somewhere else (tests use a temp dir)
//   node app/build.mjs --lenient  leave out screens that don't parse (tests)
//
// The page is one self-contained index.html: CSS, JS and the icon sprite are
// inlined so the first load is a single request. Trip, guide and food data
// are sealed with tools/tripcrypt.mjs; plaintext never reaches docs/.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {ROOT, seal, open, loadKey, keyInfo, publicKeyJson} from '../tools/tripcrypt.mjs';

const SRC = path.join(ROOT, 'app/src');
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(ROOT, opt('--out', 'docs'));
const read = f => fs.readFileSync(f, 'utf8');
const list = (dir, ext) => fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(ext)).sort().map(f => path.join(dir, f)) : [];
const say = (...a) => console.log(...a);

// ---------- icon sprite ----------
// Each Tabler SVG becomes <symbol id="i-NAME">. The outer svg's paint
// attributes move to a <g> so outline and filled icons both keep their look.
function sprite() {
  const files = list(path.join(SRC, 'icons'), '.svg');
  const syms = files.map(f => {
    const name = path.basename(f, '.svg');
    const svg = read(f).replace(/<!--[\s\S]*?-->/g, '');
    const m = svg.match(/<svg([^>]*)>([\s\S]*?)<\/svg>/);
    if (!m) throw new Error('bad icon ' + name);
    const keep = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'];
    const attrs = [...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].filter(a => keep.includes(a[1])).map(a => `${a[1]}="${a[2]}"`).join(' ');
    const vb = (m[1].match(/viewBox="([^"]*)"/) || [, '0 0 24 24'])[1];
    const body = m[2]
      .replace(/<path stroke="none" d="M0 0h24v24H0z" fill="none"\s*\/>/g, '')
      .replace(/\s*\n\s*/g, '').replace(/\s+\/>/g, '/>');
    return `<symbol id="i-${name}" viewBox="${vb}"><g ${attrs}>${body}</g></symbol>`;
  });
  say(`icons    ${files.length}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true">${syms.join('')}</svg>`;
}

// ---------- CSS / JS ----------
function css() {
  const parts = [path.join(SRC, 'tokens.css'), path.join(SRC, 'base.css'), ...list(path.join(SRC, 'screens'), '.css')];
  return parts.map(f => `/* ${path.relative(SRC, f)} */\n${read(f)}`).join('\n');
}
function js() {
  const base = [path.join(SRC, 'core.js'), path.join(SRC, 'model.js')];
  const screens = list(path.join(SRC, 'screens'), '.js');
  const parts = [];
  for (const f of [...base, ...screens]) {
    const rel = path.relative(SRC, f);
    // A syntax error in one screen would blank the whole app; catch it here.
    // --lenient (used by tests while several screens are being written at
    // once) leaves the broken screen out instead of failing the build.
    try { new Function(read(f)); }
    catch (e) {
      const msg = `${path.relative(ROOT, f)}: ${e.message}`;
      if (flag('--lenient') && screens.includes(f)) { say(`skipped  ${msg}`); continue; }
      throw new Error(msg);
    }
    // Screens are wrapped so one that throws while loading can't stop the
    // screens after it from registering.
    parts.push(screens.includes(f)
      ? `/* ${rel} */\ntry {\n${read(f)}\n} catch (e) { N.report(e, 'load ${rel}'); }`
      : `/* ${rel} */\n${read(f)}`);
  }
  return `${parts.join('\n;\n')}\n;N.start();`;
}

// ---------- static files ----------
function copyDir(from, to, out = []) {
  if (!fs.existsSync(from)) return out;
  fs.mkdirSync(to, {recursive: true});
  for (const e of fs.readdirSync(from, {withFileTypes: true})) {
    if (e.name.startsWith('.') || /_preview\.html$/.test(e.name)) continue;   // dev previews never ship
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b, out);
    else { fs.copyFileSync(a, b); out.push(b); }
  }
  return out;
}

// ---------- data ----------
// Re-sealing changes the bytes (fresh IV) even when nothing changed, which
// would make every phone re-download. Only write when the content changed.
const canon = v => JSON.stringify(v);
function sealIfChanged(name, doc, key) {
  const f = path.join(OUT, 'data', name + '.bin');
  if (fs.existsSync(f)) {
    try { if (canon(open(fs.readFileSync(f), key)) === canon(doc)) { say(`data     ${name}.bin unchanged`); return; } } catch {}
  }
  fs.writeFileSync(f, seal(doc, key));
  say(`data     ${name}.bin ${(fs.statSync(f).size / 1024).toFixed(1)} KB`);
}
function readJson(rel) {
  const f = path.join(ROOT, rel);
  return fs.existsSync(f) ? JSON.parse(read(f)) : null;
}
function data() {
  const key = loadKey({create: true});
  fs.mkdirSync(path.join(OUT, 'data'), {recursive: true});
  const kf = path.join(OUT, 'data', 'key.json');
  let keep = false;
  if (fs.existsSync(kf)) {
    try {
      const kj = JSON.parse(read(kf));
      keep = kj.salt === keyInfo().salt && !!open(Buffer.from(kj.check, 'base64'), key).ok;
    } catch {}
  }
  if (!keep) fs.writeFileSync(kf, JSON.stringify(publicKeyJson(key)));

  const trip = readJson('trip/flights.json');
  if (trip) sealIfChanged('trip', trip, key); else say('data     trip/flights.json missing, skipped');

  const guide = readJson('guide/guide.json');
  if (guide) {
    // Terminal maps are drawn separately (guide/maps.json) and merged per airport.
    const maps = readJson('guide/maps.json');
    const byCode = maps && (maps.airports || maps);
    if (byCode) for (const [code, m] of Object.entries(byCode)) {
      if (guide.airports && guide.airports[code] && m && m.svg) guide.airports[code].map = m;
    }
    // Walking-navigation data (guide/nav/<CODE>.json) rides along the same way.
    for (const f of list(path.join(ROOT, 'guide/nav'), '.json')) {
      const code = path.basename(f, '.json').toUpperCase();
      if (guide.airports && guide.airports[code]) guide.airports[code].nav = JSON.parse(read(f));
    }
    sealIfChanged('guide', guide, key);
  } else say('data     guide/guide.json missing, skipped');

  const food = readJson('food/food.json');
  if (food) sealIfChanged('food', food, key); else say('data     food/food.json missing, skipped');
}

// ---------- build ----------
function build() {
  fs.mkdirSync(OUT, {recursive: true});
  // Remove last build's shell files but keep data/ (sealed bins are compared, not rebuilt).
  for (const e of fs.readdirSync(OUT)) if (e !== 'data') fs.rmSync(path.join(OUT, e), {recursive: true, force: true});

  const copied = copyDir(path.join(SRC, 'static'), OUT);
  const CSS = css(), JS = js(), SPRITE = sprite();
  // Public key for lock-screen alerts (screens/alerts.js). It must be app/vapid_public.txt byte for byte, or
  // Apple refuses every push. It is part of the build id, so a new key also ships a new service worker.
  const vapidFile = path.join(ROOT, 'app/vapid_public.txt');
  const VAPID = fs.existsSync(vapidFile) ? read(vapidFile).trim() : '';
  const id = crypto.createHash('sha256').update(CSS + JS + SPRITE + VAPID + copied.map(f => f + fs.statSync(f).size).join()).digest('hex').slice(0, 10);
  const cfg = VAPID ? {build: id, vapid: VAPID} : {build: id};

  let html = read(path.join(SRC, 'index.html'));
  html = html.replace('/*@CSS*/', () => CSS).replace('<!--@SPRITE-->', () => SPRITE)
    .replace('/*@CFG*/{}', () => JSON.stringify(cfg)).replace('/*@JS*/', () => JS.replace(/<\/script/gi, '<\\/script'));
  for (const tag of ['/*@CSS*/', '<!--@SPRITE-->', '/*@CFG*/', '/*@JS*/']) if (html.includes(tag)) throw new Error('placeholder left: ' + tag);
  fs.writeFileSync(path.join(OUT, 'index.html'), html);

  const band = '#779995';
  const manifest = {
    name: 'nyc.', short_name: 'nyc.', description: 'Flights, airports, getting around and food for the New York trip.',
    start_url: './', scope: './', display: 'standalone', orientation: 'portrait',
    background_color: band, theme_color: band,
    icons: [
      {src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png'},
      {src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png'},
      {src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable'},
    ],
  };
  fs.writeFileSync(path.join(OUT, 'manifest.webmanifest'), JSON.stringify(manifest, null, 1));

  const rel = f => path.relative(OUT, f).split(path.sep).join('/');
  const precache = ['./', 'manifest.webmanifest', ...copied.map(rel).filter(f => !/^data\/.*\.bin$|^data\/key\.json$/.test(f))];
  const sw = read(path.join(SRC, 'sw.js')).replace("'@BUILD'", JSON.stringify(id)).replace('/*@PRECACHE*/[]', JSON.stringify(precache));
  if (sw.includes('@BUILD') || sw.includes('@PRECACHE')) throw new Error('sw.js placeholder left');
  fs.writeFileSync(path.join(OUT, 'sw.js'), sw);
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

  say(`page     index.html ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB (css ${(CSS.length / 1024).toFixed(0)}, js ${(JS.length / 1024).toFixed(0)}, icons ${(SPRITE.length / 1024).toFixed(0)})`);
  say(`static   ${copied.length} files, precache ${precache.length}`);
  if (!flag('--no-data')) data();
  say(`build    ${id} → ${path.relative(ROOT, OUT) || '.'}`);
}

build();
