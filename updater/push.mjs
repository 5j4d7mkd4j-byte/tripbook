// Web Push sender for the lock-screen alerts: RFC 8030 delivery, RFC 8291
// message encryption (aes128gcm) and RFC 8292 VAPID. node:crypto only, no npm.
//
//   node updater/push.mjs [send] [--json] [--dry-run] < messages.json
//   node updater/push.mjs test [--json] [--dry-run]   "Alerts are on" to every phone
//   node updater/push.mjs devices                      [{id}] on stdout, sends nothing
// Flags: --only ID[,ID] / --skip ID[,ID] pick devices; --budget SEC (default 90,
// at least 5) is when the sending ends: no request starts, waits or runs past it.
//
// stdin is a JSON array of [{title, body, url, tag, ttl?, urgency?, skip?}]. Every
// message goes to every phone except the device ids in its skip (the phones that
// already have it); a phone's messages go in order, phones in parallel. An entry
// without a title is not sent but keeps its place in the result.
// The phone's service worker (app/src/sw.js) receives {v:1, title, body, url, tag, at}.
//
// Inputs:
//   subscriptions  PUSH_SUBS (one sealed code per line), else .secrets/push_subs.txt.
//                  A code is base64url of a trip file (tools/tripcrypt.mjs) holding
//                  {v:1, kind:'push-sub', sub:{endpoint, keys:{p256dh, auth}}, at, ua};
//                  the app makes it when a phone turns alerts on.
//   trip key       tools/tripcrypt.mjs loadKey (TRIP_KEY in Actions).
//   VAPID          VAPID_PRIVATE_KEY (base64url d), else .secrets/vapid.json. It must
//                  match app/vapid_public.txt, the key the phones subscribed with.
//                  VAPID_PUBLIC_KEY and VAPID_SUBJECT override (tests only).
//
// A device id is the first 12 hex of sha256(endpoint); the app shows the same one.
// --json prints {sent, gone:[id], failed, forbidden, too_large, retried, devices:[{id, ok, status}],
// messages:[{ok:[id], failed:[id]}]} on stdout. status is the phone's last HTTP status
// (0 for no answer); messages has one entry per stdin entry, in order, naming the
// phones that accepted it and the ones that did not (gone phones are in neither).
// Device ids are private too: the caller keeps stdout out of public logs. stderr is
// for people: with CI, PUBLIC or GITHUB_ACTIONS set (public Actions logs) it carries
// counts only, never an endpoint, id, host or message text.
// Exit status: 0, even when phones fail; 1 when the keys or subscriptions are
// unusable; 2 for a bad command line or stdin.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ROOT, loadKey, open} from '../tools/tripcrypt.mjs';

const SEC = path.join(ROOT, '.secrets');
const VAPID_PUB_FILE = path.join(ROOT, 'app', 'vapid_public.txt');
export const SUBJECT = 'https://5j4d7mkd4j-byte.github.io/tripbook/';
const truthy = v => !!v && !/^(0|false|no)$/i.test(v);
export const PUBLIC = ['CI', 'PUBLIC', 'GITHUB_ACTIONS'].some(k => truthy(process.env[k]));

const RS = 4096;                 // one record; payloads are far smaller
const MAX_BODY = 4096;           // encrypted bytes a push service must take (RFC 8030; Apple's cap)
const MAX_PAYLOAD = 1536;        // bytes of JSON before encryption
const TIMEOUT = 10000;           // per request
const RETRY_MAX = 10;            // seconds a 429's Retry-After may ask for
const JWT_LIFE = 12 * 3600;      // Apple rejects exp more than 24 h ahead
const URGENCY = new Set(['very-low', 'low', 'normal', 'high']);
const B64U = /^[A-Za-z0-9_+/-]+={0,2}$/;   // Node's base64url decoder takes plain base64 too
const ID = /^[0-9a-f]{12}$/;

const b64u = b => Buffer.from(b).toString('base64url');
const unb64u = s => {
  s = String(s || '').trim();
  if (!B64U.test(s)) throw new Error('not base64url');
  return Buffer.from(s.replace(/=+$/, ''), 'base64url');
};
const say = (msg, detail = '') => process.stderr.write((detail && !PUBLIC ? `${msg} ${detail}` : msg) + '\n');
class ConfigError extends Error {}

// ---------- subscriptions ----------

export const deviceId = endpoint => crypto.createHash('sha256').update(String(endpoint), 'utf8').digest('hex').slice(0, 12);
const loopback = h => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';

// Problems with a decoded push-sub record (empty when it is usable).
export function checkSub(doc) {
  const p = [];
  if (!doc || doc.kind !== 'push-sub') return ['not a push-sub code'];
  const s = doc.sub || {};
  let u = null;
  try { u = new URL(s.endpoint); } catch {}
  // http only for a mock server on this machine (tests)
  if (!u || !(u.protocol === 'https:' || (u.protocol === 'http:' && loopback(u.hostname)))) p.push('endpoint is not an https URL');
  const k = s.keys || {};
  let pub = null, auth = null;
  try { pub = unb64u(k.p256dh); } catch {}
  try { auth = unb64u(k.auth); } catch {}
  // on the curve too: a bad point would only fail later, at send time, looking like a network error
  if (!pub || pub.length !== 65 || pub[0] !== 4 || !onCurve(pub)) p.push('p256dh is not a 65-byte P-256 key');
  if (!auth || auth.length !== 16) p.push('auth is not 16 bytes');
  return p;
}
const onCurve = pub => { try { crypto.ECDH.convertKey(pub, 'prime256v1'); return true; } catch { return false; } };

// A pasted code -> {id, host, endpoint, p256dh, auth, at, ua}. Throws with a reason
// that never quotes the code.
export function openCode(code, key) {
  const raw = String(code || '').replace(/\s+/g, '');
  let doc;
  try { doc = open(unb64u(raw), key); } catch { throw new Error('could not open (wrong trip key or a damaged code)'); }
  const p = checkSub(doc);
  if (p.length) throw new Error(p.join('; '));
  const {endpoint, keys} = doc.sub;
  return {id: deviceId(endpoint), host: new URL(endpoint).host, endpoint, p256dh: unb64u(keys.p256dh),
          auth: unb64u(keys.auth), at: doc.at || null, ua: String(doc.ua || '').slice(0, 40)};
}

export const subsFile = () => process.env.PUSH_SUBS_FILE || path.join(SEC, 'push_subs.txt');
// One code per line; codes never hold spaces or commas, so a line with several is split too.
export const codeLines = text => String(text || '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  .flatMap(l => l.split(/[\s,;]+/)).filter(Boolean);
function subsText() {
  if (process.env.PUSH_SUBS && process.env.PUSH_SUBS.trim()) return process.env.PUSH_SUBS;
  try { return fs.readFileSync(subsFile(), 'utf8'); } catch { return ''; }
}

// {devices, unreadable}: one entry per endpoint (the newest code wins).
export function loadDevices(key) {
  const lines = codeLines(subsText());
  if (!lines.length) return {devices: [], unreadable: 0};
  if (!key) key = loadKey();
  const by = new Map();
  let unreadable = 0;
  for (const line of lines) {
    try {
      const d = openCode(line, key);
      const old = by.get(d.endpoint);
      if (!old || String(d.at || '') >= String(old.at || '')) by.set(d.endpoint, d);
    } catch { unreadable++; }
  }
  return {devices: [...by.values()], unreadable};
}

// ---------- VAPID (RFC 8292) ----------

export function loadVapid() {
  let priv = process.env.VAPID_PRIVATE_KEY, file = null;
  if (!priv || !priv.trim()) {
    try { file = JSON.parse(fs.readFileSync(path.join(SEC, 'vapid.json'), 'utf8')); } catch {}
    priv = file && file.privateKey;
  }
  if (!priv) throw new ConfigError('no VAPID private key (set VAPID_PRIVATE_KEY or create .secrets/vapid.json)');
  let pubText = process.env.VAPID_PUBLIC_KEY;
  if (!pubText || !pubText.trim()) {
    try { pubText = fs.readFileSync(VAPID_PUB_FILE, 'utf8'); } catch { throw new ConfigError('no app/vapid_public.txt'); }
  }
  let d, pub;
  try { d = unb64u(priv); } catch { throw new ConfigError('the VAPID private key is not base64url'); }
  try { pub = unb64u(pubText); } catch { throw new ConfigError('the VAPID public key is not base64url'); }
  // Some tools (node's ECDH getPrivateKey among them) drop a leading zero byte: 1 key in 256.
  if (d.length >= 28 && d.length < 32) d = Buffer.concat([Buffer.alloc(32 - d.length), d]);
  if (d.length !== 32) throw new ConfigError('the VAPID private key is not 32 bytes');
  if (pub.length !== 65 || pub[0] !== 4) throw new ConfigError('the VAPID public key is not a 65-byte P-256 point');
  let derived;
  try {
    const ec = crypto.createECDH('prime256v1');
    ec.setPrivateKey(d);
    derived = ec.getPublicKey();
  } catch { throw new ConfigError('the VAPID private key is not a P-256 key'); }
  if (!derived.equals(pub)) throw new ConfigError('the VAPID private key does not match the public key the app subscribes with');
  const key = crypto.createPrivateKey({format: 'jwk', key: {kty: 'EC', crv: 'P-256', d: b64u(d),
    x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33))}});
  const subject = String(process.env.VAPID_SUBJECT || (file && file.subject) || SUBJECT).trim();
  if (!subjectOk(subject)) throw new ConfigError('the VAPID subject is not a mailto: address or an https URL');
  return {key, pub: b64u(pub), subject};
}

// Apple answers 403 BadJwtToken unless sub is a mailto: address or an https URL
// (and it refuses localhost ones).
export function subjectOk(s) {
  if (/^mailto:[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/i.test(s)) return true;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && !/\s/.test(s) && !!u.hostname && !loopback(u.hostname) && !u.hostname.endsWith('.localhost');
  } catch { return false; }
}

// ES256 JWT for one push service origin (RFC 7515 with an IEEE P1363 signature).
export function vapidJwt(vapid, aud, now = Math.floor(Date.now() / 1000)) {
  const part = o => b64u(JSON.stringify(o));
  const input = `${part({typ: 'JWT', alg: 'ES256'})}.${part({aud, exp: now + JWT_LIFE, sub: vapid.subject})}`;
  const sig = crypto.sign('sha256', Buffer.from(input), {key: vapid.key, dsaEncoding: 'ieee-p1363'});
  return `${input}.${b64u(sig)}`;
}

// ---------- message encryption (RFC 8291) ----------

const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

// The aes128gcm body for one phone: salt | rs | idlen | server public key | ciphertext.
// test only: opts.salt and opts.serverKey (a 32-byte private key) replace the random ones.
export function encrypt(plaintext, uaPublic, authSecret, opts = {}) {
  const data = Buffer.from(plaintext);
  // rs must exceed plaintext + delimiter + tag (RFC 8291 section 4), and the whole
  // body (21-byte header, 65-byte key, record) must fit what Apple accepts.
  if (data.length + 17 >= RS || 21 + 65 + data.length + 17 > MAX_BODY) throw new Error('payload too large for one record');
  const ec = crypto.createECDH('prime256v1');
  if (opts.serverKey) ec.setPrivateKey(opts.serverKey); else ec.generateKeys();
  const asPublic = ec.getPublicKey();
  const secret = ec.computeSecret(uaPublic);
  const ikm = hkdf(secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const salt = opts.salt || crypto.randomBytes(16);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marks the last (and only) record; no padding after it.
  const ct = Buffer.concat([c.update(data), c.update(Buffer.from([2])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(RS, 16);
  head[20] = asPublic.length;
  return Buffer.concat([head, asPublic, ct]);
}

// ---------- messages ----------

// n characters, counted and cut by code point so an emoji is never split in half.
const cut = (s, n) => { const c = [...s]; return c.length > n ? c.slice(0, n - 1).join('').trimEnd() + '…' : s; };
// Control characters go (each would cost 6 bytes of JSON and shows as a box), and so
// does half of a broken emoji.
const text = v => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ')
  .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');
const clean = (v, n) => cut(text(v).replace(/\s+/g, ' ').trim(), n);
// The body keeps its line breaks (a notification shows up to about four lines).
const lines = (v, n) => cut(text(v).replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n')
  .replace(/\n{3,}/g, '\n\n').trim(), n);
// An in-app route ("#flight/out1"): printable ASCII but for " < > \\ and `, at most 200
// characters. Anything else (a page, another site) becomes "#".
const route = v => typeof v === 'string' && /^#[!#-;=?-\[\]-_a-~]{0,199}$/.test(v) ? v : '#';

// The longest start of s that is at most n bytes of UTF-8 (whole characters only).
function fit(s, n) {
  let out = '', used = 0;
  for (const ch of s) {
    used += Buffer.byteLength(ch);
    if (used > n) break;
    out += ch;
  }
  return out;
}

// {v, title, body, url, tag, at} as JSON within MAX_PAYLOAD, shortening the body first.
export function payload(m, at = new Date().toISOString()) {
  const own = typeof m.at === 'string' && m.at.length <= 40 && !isNaN(Date.parse(m.at)) ? m.at : null;
  const p = {v: 1, title: clean(m.title, 120), body: lines(m.body, 600), url: route(m.url), tag: clean(m.tag, 64), at: own || at};
  let json = JSON.stringify(p);
  for (const k of ['body', 'title']) {
    while (Buffer.byteLength(json) > MAX_PAYLOAD && p[k]) {
      const s = p[k].replace(/…$/, '');
      const keep = fit(s, Buffer.byteLength(s) - (Buffer.byteLength(json) - MAX_PAYLOAD) - 3).trimEnd();
      p[k] = keep ? keep + '…' : '';
      json = JSON.stringify(p);
    }
  }
  return json;
}

export const topicOf = tag => crypto.createHash('sha256').update(String(tag), 'utf8').digest('hex').slice(0, 32);
export function headers(m, jwt, vapid) {
  const ttl = m.ttl == null || m.ttl === '' || !Number.isFinite(+m.ttl) ? 3600 : Math.max(0, Math.min(2419200, Math.round(+m.ttl)));
  const h = {
    'TTL': String(ttl),     // required by Apple
    'Urgency': URGENCY.has(m.urgency) ? m.urgency : 'high',
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    'Authorization': `vapid t=${jwt}, k=${vapid.pub}`,
  };
  // A newer message with the same Topic replaces an undelivered older one. Apple refuses
  // some tags that fit RFC 8030's alphabet (400 BadWebPushTopic for a 13-character one), so
  // the Topic is the first 32 hex of the tag's sha256: the same tag always gives the same Topic.
  const tag = clean(m.tag, 64);
  if (tag) h['Topic'] = topicOf(tag);
  return h;
}

// stdin -> one entry per message, null for an entry that can't be sent (no title),
// so results line up with what the caller sent.
function readMessages(input) {
  if (!input.trim()) return [];
  let list;
  try { list = JSON.parse(input); } catch { list = null; }
  if (!Array.isArray(list)) throw new Error('stdin is not a JSON array of messages');
  return list.map(m => m && typeof m === 'object' && !Array.isArray(m) && clean(m.title, 120) ? m : null);
}
// A message's skip: the device ids that already have it.
const skipIds = v => new Set((Array.isArray(v) ? v : []).map(s => String(s).trim().toLowerCase()).filter(s => ID.test(s)));

const TEST = {title: 'Alerts are on', body: 'Gate changes, delays and tight connections will show up here.',
              url: '#today', tag: 'alerts-test', ttl: 600, urgency: 'normal'};

// ---------- delivery ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));
function retryAfter(v) {
  if (v == null || v === '') return 1;
  const s = /^\d+$/.test(v.trim()) ? +v : (Date.parse(v) - Date.now()) / 1000;
  return Number.isFinite(s) ? Math.max(0, s) : 1;
}
const reasonOf = t => { try { return clean(JSON.parse(t).reason, 40).replace(/[^\w .-]/g, ''); } catch { return ''; } };

async function post(endpoint, hdrs, body, timeout) {
  try {
    const r = await fetch(endpoint, {method: 'POST', headers: hdrs, body, redirect: 'manual', signal: AbortSignal.timeout(timeout)});
    // Accepted needs nothing more (a body that never ends would hold the phone until the timeout);
    // otherwise the push service's reason, e.g. Apple's {"reason":"BadJwtToken"}.
    let said = '';
    if (r.status >= 200 && r.status < 300) { if (r.body) r.body.cancel().catch(() => {}); }
    else said = await r.text().catch(() => '');
    return {status: r.status, retryAfter: r.headers.get('retry-after'), reason: reasonOf(said.slice(0, 2000))};
  } catch (e) {
    return {status: 0, reason: e && e.name === 'TimeoutError' ? 'timeout' : 'network'};
  }
}

// Every message to one phone, in order. Stops at the first 404/410.
// per[i] collects which phones took message i.
async function toDevice(d, msgs, vapid, jwtFor, tally, per, opts) {
  const out = {id: d.id, ok: true, status: null};
  const failed = (i, status) => { out.ok = false; out.status = status; tally.failed++; per[i].failed.push(d.id); };
  for (const [i, m] of msgs.entries()) {
    if (!m || m.skip.has(d.id)) continue;
    let body;
    try { body = encrypt(m.json, d.p256dh, d.auth); } catch { failed(i, 0); continue; }
    const hdrs = headers(m, jwtFor(new URL(d.endpoint).origin), vapid);
    if (opts.dry) { tally.built++; continue; }
    // The budget is a hard end (the caller's own timeout is just past it): each request
    // gets what is left of it, and none starts with less than a second.
    const left = () => opts.deadline - Date.now();
    if (left() < 1000) { failed(i, 0); tally.late++; continue; }
    let r = await post(d.endpoint, hdrs, body, Math.min(opts.timeout, left()));
    if (r.status === 429) {
      const wait = retryAfter(r.retryAfter);
      if (wait <= RETRY_MAX && wait * 1000 + 1000 <= left()) {
        tally.retried++;
        await sleep(wait * 1000);
        r = await post(d.endpoint, hdrs, body, Math.min(opts.timeout, left()));
      }
    }
    // A refused Topic costs only the coalescing: send it again without one.
    if (r.status === 400 && r.reason === 'BadWebPushTopic' && hdrs.Topic && left() >= 1000) {
      tally.retried++;
      const {Topic, ...rest} = hdrs;
      r = await post(d.endpoint, rest, body, Math.min(opts.timeout, left()));
    }
    out.status = r.status;
    if (r.reason) out.reason = r.reason;
    if (r.status >= 200 && r.status < 300) { tally.sent++; per[i].ok.push(d.id); continue; }
    if (r.status === 404 || r.status === 410) { out.ok = false; out.gone = true; tally.gone.push(d.id); break; }
    failed(i, r.status);
    if (r.status === 403) tally.forbidden++;
    else if (r.status === 413) tally.too_large++;
    else if (r.status === 0) tally.unreachable++;
  }
  return out;
}

// Sends msgs ([{title, body, url, tag, ttl?, urgency?, skip?}], null entries are
// held places) to devices. Never throws for one phone. opts: dry, budget (s), timeout (ms).
export async function sendAll(devices, msgs, vapid, opts = {}) {
  const jwts = new Map();
  const jwtFor = aud => jwts.get(aud) || jwts.set(aud, vapidJwt(vapid, aud)).get(aud);
  const at = new Date().toISOString();
  const prepared = msgs.map(m => m && {...m, json: payload(m, at), skip: skipIds(m.skip)});
  const per = msgs.map(() => ({ok: [], failed: []}));
  const tally = {sent: 0, gone: [], failed: 0, forbidden: 0, too_large: 0, retried: 0, unreachable: 0, late: 0, built: 0};
  const o = {dry: !!opts.dry, deadline: Date.now() + (opts.budget || 90) * 1000, timeout: opts.timeout || TIMEOUT};
  const results = await Promise.all(devices.map(d => toDevice(d, prepared, vapid, jwtFor, tally, per, o)
    .catch(() => { tally.failed++; return {id: d.id, ok: false, status: 0}; })));
  return {...tally, devices: results, messages: per};
}

// ---------- command line ----------

function parseArgs(argv) {
  const a = {cmd: 'send', json: false, dry: false, only: null, skip: [], budget: 90};
  const list = v => String(v).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const pos = [];
  // A flag's value; a missing one is an error (a bare --only would quietly pick no phones).
  const val = (i, x) => {
    if (argv[i] == null || argv[i].startsWith('--')) throw new Error(`${x} needs a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--json') a.json = true;
    else if (x === '--dry-run') a.dry = true;
    else if (x === '--only') a.only = list(val(++i, x));
    else if (x === '--skip') a.skip = list(val(++i, x));
    else if (x === '--budget') {
      const n = +val(++i, x);
      if (!Number.isFinite(n) || n < 0) throw new Error('--budget needs seconds');
      a.budget = Math.max(5, n);
    }
    else if (x.startsWith('--')) throw new Error(`unknown flag ${x}`);
    else pos.push(x);
  }
  if (pos.length > 1 || (pos[0] && !['send', 'test', 'devices'].includes(pos[0]))) throw new Error('unknown command');
  if (pos[0]) a.cmd = pos[0];
  return a;
}

const readStdin = () => new Promise((res, rej) => {
  if (process.stdin.isTTY) return res('');
  let s = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { s += c; }).on('end', () => res(s)).on('error', rej);
});

const write = s => new Promise(r => process.stdout.write(s + '\n', r));
// The result when nothing was sent: devices as given, every message to no one.
const empty = (msgs, devices = []) => ({sent: 0, gone: [], failed: 0, forbidden: 0, too_large: 0, retried: 0,
  devices, messages: msgs.map(() => ({ok: [], failed: []}))});

async function main() {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) {
    say(`push: ${e.message}`);
    say('usage: push.mjs [send|test|devices] [--json] [--dry-run] [--only ID,..] [--skip ID,..] [--budget SEC] < messages.json');
    return 2;
  }
  let msgs = [];
  if (a.cmd === 'send') {
    try { msgs = readMessages(await readStdin()); } catch (e) { say(`push: ${e.message}`); return 2; }
  } else if (a.cmd === 'test') msgs = [TEST];

  let devices, unreadable;
  try { ({devices, unreadable} = loadDevices()); } catch (e) {
    say(`push: no trip key (${e.message})`);  // loadKey's messages name files, never key material
    return 1;
  }
  if (unreadable) say(`push: ${unreadable} subscription code${unreadable === 1 ? '' : 's'} could not be read`);
  if (unreadable && !devices.length) { say('push: no readable subscriptions (is TRIP_KEY the trip key?)'); return 1; }
  if (a.cmd === 'devices') { await write(JSON.stringify(devices.map(d => ({id: d.id})))); return 0; }

  const all = devices.length, n = msgs.filter(Boolean).length, bad = msgs.length - n;
  devices = devices.filter(d => (!a.only || a.only.some(p => d.id.startsWith(p))) && !a.skip.includes(d.id));
  say(`push: ${devices.length} of ${all} device${all === 1 ? '' : 's'}, ${n} message${n === 1 ? '' : 's'}${a.dry ? ' (dry run)' : ''}`);
  if (bad) say(`push: ${bad} message${bad === 1 ? '' : 's'} without a title not sent`);
  if (!devices.length) { if (a.json) await write(JSON.stringify(empty(msgs))); return 0; }

  let vapid;
  try { vapid = loadVapid(); } catch (e) {
    say(`push: ${e instanceof ConfigError ? e.message : 'could not load the VAPID key'}`);
    return 1;
  }
  if (!n) { if (a.json) await write(JSON.stringify(empty(msgs, devices.map(d => ({id: d.id, ok: true, status: null}))))); return 0; }

  const r = await sendAll(devices, msgs, vapid, {dry: a.dry, budget: a.budget});
  if (!PUBLIC) {
    const host = Object.fromEntries(devices.map(d => [d.id, d.host]));
    for (const d of r.devices) say(`  ${d.id} ${host[d.id]}`, `${d.status ?? 'built'}${d.gone ? ' gone' : ''}${d.reason ? ' ' + d.reason : ''}`);
  }
  const extra = [r.forbidden && `${r.forbidden} forbidden (check the VAPID key)`, r.too_large && `${r.too_large} too large`,
                 r.retried && `${r.retried} retried`, r.unreachable && `${r.unreachable} unreachable`,
                 r.late && `${r.late} over budget`].filter(Boolean);
  say(a.dry ? `push: built ${r.built} request${r.built === 1 ? '' : 's'}, failed ${r.failed}`
            : `push: sent ${r.sent}, gone ${r.gone.length}, failed ${r.failed}${extra.length ? '; ' + extra.join(', ') : ''}`);
  if (a.json) {
    const {unreachable, late, built, ...out} = r;
    await write(JSON.stringify(a.dry ? {...out, dry: true, built} : out));
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  // No message or stack, ever: either could quote a subscription. That includes errors
  // thrown outside main (a socket that fails after its request is done).
  const crash = e => { say('push: unexpected error', e && e.name); process.exit(1); };
  process.on('uncaughtException', crash).on('unhandledRejection', crash);
  main().then(code => { process.exitCode = code; }, crash);
}
