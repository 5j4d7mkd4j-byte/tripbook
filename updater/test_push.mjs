// Tests for updater/push.mjs and tools/push_subs.mjs. Plain node, no framework:
//
//   node updater/test_push.mjs
//
// Everything is throwaway: a random trip key, a fresh VAPID key pair, fake
// phones (WebCrypto key pairs, like a browser makes) and a push service mock on
// 127.0.0.1. Nothing reads .secrets/ and nothing leaves this machine.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {seal} from '../tools/tripcrypt.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUSH = path.join(HERE, 'push.mjs');
const SUBS_TOOL = path.join(HERE, '..', 'tools', 'push_subs.mjs');
const {subtle} = crypto.webcrypto;
const B = s => Buffer.from(s, 'base64url');
const b64u = b => Buffer.from(b).toString('base64url');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'push-test-'));

// ---------- throwaway keys and environment ----------

const TRIP_KEY = crypto.randomBytes(32);
// getPrivateKey drops a leading zero byte (1 key in 256); a stored key is all 32.
const d32 = ec => { const d = ec.getPrivateKey(); return Buffer.concat([Buffer.alloc(32 - d.length), d]); };
const vapidEc = crypto.createECDH('prime256v1');
vapidEc.generateKeys();
const VAPID_PUB = b64u(vapidEc.getPublicKey());
const VAPID_PRIV = b64u(d32(vapidEc));
const SUBJECT = 'https://example.test/app/';

const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !/^(CI|PUBLIC|GITHUB_ACTIONS|TRIP_KEY|PUSH_SUBS|PUSH_SUBS_FILE|VAPID_\w+)$/.test(k)));
const ENV = {...clean, TRIP_KEY: TRIP_KEY.toString('base64'), VAPID_PRIVATE_KEY: VAPID_PRIV,
             VAPID_PUBLIC_KEY: VAPID_PUB, VAPID_SUBJECT: SUBJECT, PUSH_SUBS_FILE: path.join(TMP, 'none.txt')};
// push.mjs reads these at call time, so the in-process tests see the same setup.
Object.assign(process.env, {TRIP_KEY: ENV.TRIP_KEY, VAPID_PRIVATE_KEY: VAPID_PRIV, VAPID_PUBLIC_KEY: VAPID_PUB,
                            VAPID_SUBJECT: SUBJECT, PUSH_SUBS_FILE: ENV.PUSH_SUBS_FILE});
for (const k of ['CI', 'PUBLIC', 'GITHUB_ACTIONS', 'PUSH_SUBS']) delete process.env[k];
const P = await import('./push.mjs');

// A phone: a P-256 key pair and auth secret made the way a browser makes them.
async function phone(endpoint, at = '2030-01-01T10:00:00.000Z') {
  const kp = await subtle.generateKey({name: 'ECDH', namedCurve: 'P-256'}, true, ['deriveBits']);
  const pub = Buffer.from(await subtle.exportKey('raw', kp.publicKey));
  const auth = crypto.randomBytes(16);
  const sub = {endpoint, expirationTime: null, keys: {p256dh: b64u(pub), auth: b64u(auth)}};
  const code = seal({v: 1, kind: 'push-sub', sub, at, ua: 'iPhone'}, TRIP_KEY).toString('base64url');
  return {endpoint, priv: kp.privateKey, pub, auth, code, id: P.deviceId(endpoint)};
}

// A real P-256 public key, and a 65-byte one that is not on the curve.
const realPub = () => { const e = crypto.createECDH('prime256v1'); e.generateKeys(); return e.getPublicKey(); };
const OFF_CURVE = Buffer.concat([Buffer.from([4]), Buffer.alloc(63), Buffer.from([1])]);
const offCode = endpoint => seal({v: 1, kind: 'push-sub', sub: {endpoint, keys: {p256dh: b64u(OFF_CURVE), auth: b64u(crypto.randomBytes(16))}},
                                  at: '2030-01-01T00:00:00.000Z'}, TRIP_KEY).toString('base64url');

// An independent RFC 8291 receiver, written against WebCrypto as a browser would.
async function receive(body, ph) {
  body = Buffer.from(body);
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20];
  const asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  assert.equal(rs, 4096);
  assert.equal(idlen, 65);
  assert.ok(ct.length <= rs, 'one record');
  const asKey = await subtle.importKey('raw', asPub, {name: 'ECDH', namedCurve: 'P-256'}, false, []);
  const secret = await subtle.deriveBits({name: 'ECDH', public: asKey}, ph.priv, 256);
  const derive = async (ikm, s, info, bits) => Buffer.from(await subtle.deriveBits(
    {name: 'HKDF', hash: 'SHA-256', salt: s, info: Buffer.from(info)},
    await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), bits));
  const ikm = await derive(secret, ph.auth, Buffer.concat([Buffer.from('WebPush: info\0'), ph.pub, asPub]), 256);
  const cek = await derive(ikm, salt, 'Content-Encoding: aes128gcm\0', 128);
  const nonce = await derive(ikm, salt, 'Content-Encoding: nonce\0', 96);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const pt = Buffer.from(await subtle.decrypt({name: 'AES-GCM', iv: nonce}, key, ct));
  let i = pt.length - 1;
  while (i >= 0 && pt[i] === 0) i--;
  assert.equal(pt[i], 2, 'last-record delimiter');
  return pt.subarray(0, i).toString();
}

// Verifies an ES256 JWT with the VAPID public key and returns its claims.
function verifyJwt(jwt, pubB64u) {
  const [h, c, s] = jwt.split('.');
  const pub = B(pubB64u);
  const key = crypto.createPublicKey({format: 'jwk', key: {kty: 'EC', crv: 'P-256',
    x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33))}});
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), {key, dsaEncoding: 'ieee-p1363'}, B(s)), 'JWT signature');
  assert.deepEqual(JSON.parse(B(h)), {typ: 'JWT', alg: 'ES256'});
  return JSON.parse(B(c));
}

function run(file, args, {env = {}, input = ''} = {}) {
  return new Promise(res => {
    const p = spawn(process.execPath, [file, ...args], {env: {...ENV, ...env}});
    let out = '', err = '';
    p.stdout.on('data', c => { out += c; });
    p.stderr.on('data', c => { err += c; });
    p.on('close', code => res({code, out, err}));
    p.stdin.end(input);
  });
}

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`ok   ${name}`); } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n     ${String(e && e.stack || e).split('\n').slice(0, 4).join('\n     ')}`);
  }
}

// ---------- (a) RFC 8291 Appendix A ----------

await test('a. RFC 8291 Appendix A vector, byte for byte', () => {
  const body = P.encrypt('When I grow up, I want to be a watermelon',
    B('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
    B('BTBZMqHH6r4Tts7J_aSIgg'),
    {salt: B('DGv6ra1nlYgDCS1FRnbzlw'), serverKey: B('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw')});
  assert.equal(body.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_' +
    'yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

// ---------- (b) round trip ----------

await test('b. encrypt -> independent WebCrypto receiver -> same payload', async () => {
  const ph = await phone('https://push.example.test/abc');
  const json = P.payload({title: 'Gate change', body: 'XX100 now leaves from B7.\nBoarding 4:20p.', url: '#flight/t1', tag: 't1-gate'});
  const got = JSON.parse(await receive(P.encrypt(json, ph.pub, ph.auth), ph));
  assert.deepEqual(Object.keys(got), ['v', 'title', 'body', 'url', 'tag', 'at']);
  assert.equal(got.v, 1);
  assert.equal(got.body, 'XX100 now leaves from B7.\nBoarding 4:20p.');
  assert.ok(!isNaN(Date.parse(got.at)));
  // two encryptions of the same text differ (fresh salt and server key)
  assert.notEqual(b64u(P.encrypt(json, ph.pub, ph.auth)), b64u(P.encrypt(json, ph.pub, ph.auth)));
});

await test('b. long text is cut to fit 1.5 KB and still decrypts', async () => {
  const ph = await phone('https://push.example.test/long');
  // 600 three-byte characters are 1.8 KB: the byte limit, not the length cap, has to cut it
  const json = P.payload({title: 'T'.repeat(500), body: '€'.repeat(2000), url: 'https://elsewhere.test/', tag: 'x'});
  assert.ok(Buffer.byteLength(json) <= 1536 && Buffer.byteLength(json) > 1400, `payload ${Buffer.byteLength(json)} bytes`);
  const got = JSON.parse(await receive(P.encrypt(json, ph.pub, ph.auth), ph));
  assert.ok(got.body.endsWith('…') && got.body.length < 500);
  assert.equal(got.title, 'T'.repeat(119) + '…');
  assert.equal(got.url, '#', 'an absolute URL never reaches the phone');
});

await test('b. a code sealed the way the app seals it (WebCrypto + CompressionStream) opens', async () => {
  const sub = {endpoint: 'https://web.push.apple.com/QAbc-_1', expirationTime: null,
               keys: {p256dh: b64u(realPub()), auth: b64u(crypto.randomBytes(16))}};
  const json = JSON.stringify({v: 1, kind: 'push-sub', sub, at: new Date().toISOString(), ua: 'iPhone'});
  const gz = Buffer.from(await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const key = await subtle.importKey('raw', TRIP_KEY, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.randomBytes(12);
  const ct = Buffer.from(await subtle.encrypt({name: 'AES-GCM', iv}, key, gz));
  const code = b64u(Buffer.concat([Buffer.from('NYC1'), iv, ct]));
  const d = P.openCode(code, TRIP_KEY);
  assert.equal(d.endpoint, sub.endpoint);
  assert.equal(d.host, 'web.push.apple.com');
  assert.equal(d.id, crypto.createHash('sha256').update(sub.endpoint).digest('hex').slice(0, 12));
  assert.match(d.id, /^[0-9a-f]{12}$/);
});

await test('b. bad codes are refused with a reason that does not quote them', async () => {
  const bad = obj => seal(obj, TRIP_KEY).toString('base64url');
  const ok = {endpoint: 'https://push.example.test/x', keys: {p256dh: b64u(realPub()), auth: b64u(crypto.randomBytes(16))}};
  assert.equal(P.openCode(bad({v: 1, kind: 'push-sub', sub: ok}), TRIP_KEY).host, 'push.example.test');
  for (const [code, why] of [
    [bad({v: 1, kind: 'other', sub: ok}), /not a push-sub/],
    [bad({v: 1, kind: 'push-sub', sub: {...ok, endpoint: 'http://push.example.test/x'}}), /https/],
    [bad({v: 1, kind: 'push-sub', sub: {...ok, keys: {...ok.keys, p256dh: b64u(crypto.randomBytes(33))}}}), /p256dh/],
    [bad({v: 1, kind: 'push-sub', sub: {...ok, keys: {...ok.keys, p256dh: b64u(OFF_CURVE)}}}), /p256dh/],  // not on P-256
    [bad({v: 1, kind: 'push-sub', sub: {...ok, keys: {...ok.keys, p256dh: b64u(Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]))}}}), /p256dh/],
    [bad({v: 1, kind: 'push-sub', sub: {...ok, keys: {...ok.keys, auth: b64u(crypto.randomBytes(8))}}}), /auth/],
    [seal({v: 1, kind: 'push-sub', sub: ok}, crypto.randomBytes(32)).toString('base64url'), /could not open/],
    ['not a code!', /could not open/]]) {
    assert.throws(() => P.openCode(code, TRIP_KEY), e => why.test(e.message) && !e.message.includes(code.slice(0, 12)));
  }
});

await test('b. payload keeps in-app routes and real times, and drops control characters', () => {
  const at = '2030-01-01T10:00:00.000Z';
  const p = m => JSON.parse(P.payload({title: 'T', ...m}, at));
  for (const u of ['#flights', '#flight/t1', '#place/a%20b', '#route/x?y=1&z=2']) assert.equal(p({url: u}).url, u);
  for (const u of ['javascript:alert(1)', '/flights', 'flights', '//evil.test/', '#a b', '#a"b', '#a<b>', '#a\\b', '#\u00e9',
                   '#' + 'x'.repeat(200), 42, null, undefined]) assert.equal(p({url: u}).url, '#', `url ${String(u).slice(0, 12)}`);
  assert.equal(p({at: '2030-02-02T08:00:00Z'}).at, '2030-02-02T08:00:00Z');
  for (const bad of ['soon', 'x'.repeat(50), 1893456000, {}]) assert.equal(p({at: bad}).at, at);
  const q = p({title: 'Gate\u0000 change\u0007', body: 'one\r\ntwo\rthree\u001b[31m\n\n\n\nfour', tag: 't\u0001x'});
  assert.equal(q.title, 'Gate change');
  assert.equal(q.body, 'one\ntwo\nthree [31m\n\nfour');
  assert.equal(q.tag, 't x');
  // cut by character, never inside an emoji; a lone half of one becomes U+FFFD
  const e = p({title: '\u{1F6EB}'.repeat(130), body: 'a\ud83d b \ude00c'});
  assert.equal(e.title, '\u{1F6EB}'.repeat(119) + '\u2026');
  assert.equal(e.body, 'a\ufffd b \ufffdc');
  assert.ok(Buffer.byteLength(P.payload({title: 'x', body: '"\\'.repeat(2000), tag: 'y'.repeat(99)}, at)) <= 1536);
});

await test('b. encrypt takes up to a 4096-byte body and refuses more', async () => {
  const ph = await phone('https://push.example.test/max');
  const most = 4096 - 21 - 65 - 17;  // header, server key, delimiter + tag
  const body = P.encrypt('x'.repeat(most), ph.pub, ph.auth);
  assert.equal(body.length, 4096);
  assert.equal(await receive(body, ph), 'x'.repeat(most));
  assert.throws(() => P.encrypt('x'.repeat(most + 1), ph.pub, ph.auth), /too large/);
  assert.throws(() => P.encrypt('x', OFF_CURVE, ph.auth));
});

// ---------- (c) VAPID ----------

await test('c. VAPID JWT verifies, with the right aud, exp and sub', () => {
  const v = P.loadVapid();
  const now = Math.floor(Date.now() / 1000);
  const claims = verifyJwt(P.vapidJwt(v, 'https://web.push.apple.com', now), VAPID_PUB);
  assert.deepEqual(claims, {aud: 'https://web.push.apple.com', exp: now + 12 * 3600, sub: SUBJECT});
  assert.ok(claims.exp - now <= 24 * 3600, 'Apple rejects exp more than 24 h ahead');
  assert.equal(v.pub, VAPID_PUB);
});

await test('c. the VAPID subject must be a mailto: address or an https URL Apple accepts', async () => {
  for (const s of [SUBJECT, P.SUBJECT, 'mailto:ops@example.test', 'MAILTO:a.b+c@mail.example.test', 'https://example.test'])
    assert.ok(P.subjectOk(s), s);
  for (const s of ['', 'example.test', 'mailto:ops', 'mailto:ops@localhost', 'mailto: ops@example.test', 'http://example.test/',
                   'https://localhost/', 'https://127.0.0.1/', 'https://[::1]/', 'https://app.localhost/', 'https://exa mple.test/',
                   'https://example.test/ x', 'ftp://example.test/']) assert.ok(!P.subjectOk(s), `refuses ${s}`);
  process.env.VAPID_SUBJECT = 'mailto:ops';
  try { assert.throws(() => P.loadVapid(), /subject/); } finally { process.env.VAPID_SUBJECT = SUBJECT; }
  process.env.VAPID_SUBJECT = '  https://example.test/app/ \n';
  try { assert.equal(P.loadVapid().subject, 'https://example.test/app/', 'trimmed'); } finally { process.env.VAPID_SUBJECT = SUBJECT; }
  const ph = await phone('https://push.example.test/s');
  const r = await run(PUSH, ['test', '--dry-run'], {env: {VAPID_SUBJECT: 'https://localhost/', PUSH_SUBS: ph.code}});
  assert.equal(r.code, 1);
  assert.match(r.err, /subject is not a mailto: address or an https URL/);
  for (const x of [VAPID_PUB, VAPID_PRIV, 'localhost']) assert.ok(!r.err.includes(x) && !r.out.includes(x));
});

await test('c. a private key that does not match the public key fails without printing either', async () => {
  const other = crypto.createECDH('prime256v1');
  other.generateKeys();
  const wrong = b64u(d32(other));
  process.env.VAPID_PRIVATE_KEY = wrong;
  try {
    assert.throws(() => P.loadVapid(), /does not match/);
  } finally { process.env.VAPID_PRIVATE_KEY = VAPID_PRIV; }
  const ph = await phone('https://push.example.test/m');
  const r = await run(PUSH, ['test'], {env: {VAPID_PRIVATE_KEY: wrong, PUSH_SUBS: ph.code}});
  assert.equal(r.code, 1);
  assert.match(r.err, /does not match/);
  for (const s of [wrong, VAPID_PUB, VAPID_PRIV]) assert.ok(!r.err.includes(s) && !r.out.includes(s));
});

await test('c. a private key stored without its leading zero byte still works', () => {
  let ec;
  do { ec = crypto.createECDH('prime256v1'); ec.generateKeys(); } while (ec.getPrivateKey().length === 32);
  const short = ec.getPrivateKey();
  Object.assign(process.env, {VAPID_PRIVATE_KEY: b64u(short), VAPID_PUBLIC_KEY: b64u(ec.getPublicKey())});
  try {
    const v = P.loadVapid();
    const now = Math.floor(Date.now() / 1000);
    assert.equal(verifyJwt(P.vapidJwt(v, 'https://web.push.apple.com', now), v.pub).aud, 'https://web.push.apple.com');
    process.env.VAPID_PRIVATE_KEY = b64u(short.subarray(1));  // a different (wrong) key, not a padded one
    assert.throws(() => P.loadVapid(), /does not match|not a P-256 key/);
    process.env.VAPID_PRIVATE_KEY = b64u(crypto.randomBytes(20));
    assert.throws(() => P.loadVapid(), /not 32 bytes/);
  } finally { Object.assign(process.env, {VAPID_PRIVATE_KEY: VAPID_PRIV, VAPID_PUBLIC_KEY: VAPID_PUB}); }
});

// ---------- (d) delivery against a mock push service ----------

const seen = [];
const hits = {};
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const name = req.url.split('/').pop();
    const n = hits[name] = (hits[name] || 0) + 1;
    seen.push({name, n, t: Date.now(), headers: req.headers, body: Buffer.concat(chunks)});
    const status = {ok: 201, gone: 410, denied: 403, big: 413, busy: n === 1 ? 429 : 201}[name] || 404;
    res.writeHead(status, status === 429 ? {'retry-after': '1'} : {'content-type': 'application/json'});
    res.end(status === 403 ? '{"reason":"BadJwtToken"}' : '');
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
// a port with nothing listening: a network error for one phone
const closed = http.createServer();
await new Promise(r => closed.listen(0, '127.0.0.1', r));
const DEAD = `http://127.0.0.1:${closed.address().port}`;
await new Promise(r => closed.close(r));

const phones = {};
for (const name of ['ok', 'gone', 'busy', 'denied', 'big']) phones[name] = await phone(`${ORIGIN}/push/${name}`);
phones.dead = await phone(`${DEAD}/push/dead`);
const ALL = Object.values(phones);
const SUBS = ALL.map(p => p.code).join('\n');
const MSGS = [
  {title: 'Gate change', body: 'XX100 now leaves from B7.\nBoarding 4:20p.', url: '#flight/t1', tag: 't1-gate'},
  {title: 'Running late', body: 'XX100 is 25 min late.', url: '#flight/t1', tag: 'not a valid topic!', ttl: 900, urgency: 'normal'},
];
const reset = () => { seen.length = 0; for (const k in hits) delete hits[k]; };

let first;
await test('d. send: 201, 410, 429 then 201, 403, 413 and a dead host', async () => {
  reset();
  const r = first = await run(PUSH, ['send', '--json'], {env: {PUSH_SUBS: SUBS}, input: JSON.stringify(MSGS)});
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.equal(out.sent, 4, 'ok x2 + busy x2');
  assert.deepEqual(out.gone, [phones.gone.id]);
  assert.equal(out.failed, 6, 'denied x2 + big x2 + dead x2');
  assert.equal(out.forbidden, 2);
  assert.equal(out.too_large, 2);
  assert.equal(out.retried, 1);
  const dev = Object.fromEntries(out.devices.map(d => [d.id, d]));
  const st = name => [dev[phones[name].id].ok, dev[phones[name].id].status];
  assert.deepEqual(st('ok'), [true, 201]);
  assert.deepEqual(st('gone'), [false, 410]);
  assert.deepEqual(st('busy'), [true, 201]);
  assert.deepEqual(st('denied'), [false, 403]);
  assert.deepEqual(st('big'), [false, 413]);
  assert.deepEqual(st('dead'), [false, 0]);
  assert.equal(dev[phones.denied.id].reason, 'BadJwtToken');
  assert.deepEqual(hits, {ok: 2, gone: 1, busy: 3, denied: 2, big: 2}, 'gone stops after the 410; busy retried once');
});

await test('d. the retry waited for Retry-After', () => {
  const b = seen.filter(s => s.name === 'busy');
  assert.ok(b[1].t - b[0].t >= 900, `waited ${b[1].t - b[0].t} ms`);
  assert.equal(b[0].body.toString('base64'), b[1].body.toString('base64'), 'the same request again');
});

await test('d. request headers and a VAPID JWT for the push service origin', () => {
  const [m1, m2] = seen.filter(s => s.name === 'ok');
  for (const s of [m1, m2]) {
    assert.equal(s.headers['content-encoding'], 'aes128gcm');
    assert.equal(s.headers['content-type'], 'application/octet-stream');
    const [, jwt, k] = s.headers.authorization.match(/^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/) || [];
    assert.equal(k, VAPID_PUB);
    const c = verifyJwt(jwt, VAPID_PUB);
    assert.equal(c.aud, ORIGIN);
    assert.equal(c.sub, SUBJECT);
    assert.ok(c.exp > Date.now() / 1000 + 11 * 3600 && c.exp <= Date.now() / 1000 + 12 * 3600 + 5);
  }
  assert.equal(m1.headers.ttl, '3600');
  assert.equal(m1.headers.urgency, 'high');
  assert.equal(m1.headers.topic, 't1-gate');
  assert.equal(m2.headers.ttl, '900');
  assert.equal(m2.headers.urgency, 'normal');
  assert.equal(m2.headers.topic, undefined, 'no Topic for a tag outside the base64url alphabet');
});

await test('d. each phone decrypts its messages, in order', async () => {
  for (const name of ['ok', 'busy']) {
    const got = [];
    for (const s of seen.filter(x => x.name === name && !(name === 'busy' && x.n === 1))) got.push(JSON.parse(await receive(s.body, phones[name])));
    assert.deepEqual(got.map(g => [g.v, g.title, g.body, g.url, g.tag]),
      MSGS.map(m => [1, m.title, m.body, m.url, m.tag]));
    assert.equal(got[0].at, got[1].at, 'one run, one time');
  }
  // a phone cannot read another phone's message
  await assert.rejects(receive(seen.find(s => s.name === 'ok').body, phones.busy));
});

await test('d. local stderr names devices by id and host only', () => {
  assert.match(first.err, new RegExp(`${phones.ok.id} 127\\.0\\.0\\.1:\\d+ 201 201|${phones.ok.id} 127\\.0\\.0\\.1:\\d+ 201`));
  for (const p of ALL) assert.ok(!first.err.includes(new URL(p.endpoint).pathname), 'no endpoint path');
  for (const m of MSGS) assert.ok(!first.err.includes(m.title) && !first.err.includes(m.body));
});

await test('d. devices, --only, --skip, dedupe and unreadable codes', async () => {
  reset();
  const newer = await phone(phones.ok.endpoint, '2031-01-01T00:00:00.000Z');  // same phone, subscribed again
  const subs = [SUBS, newer.code, 'AAAA', seal({x: 1}, TRIP_KEY).toString('base64url'), '# a comment', ''].join('\n');
  const d = await run(PUSH, ['devices'], {env: {PUSH_SUBS: subs}});
  assert.equal(d.code, 0, d.err);
  assert.deepEqual(JSON.parse(d.out).map(x => x.id).sort(), ALL.map(p => p.id).sort());
  assert.match(d.err, /2 subscription codes could not be read/);
  const r = await run(PUSH, ['test', '--json', '--only', phones.ok.id.slice(0, 6)], {env: {PUSH_SUBS: subs}});
  assert.equal(JSON.parse(r.out).sent, 1);
  const [s] = seen;
  assert.equal(JSON.parse(await receive(s.body, newer)).title, 'Alerts are on', 'the newer subscription wins');
  reset();
  const k = await run(PUSH, ['send', '--json', '--skip', [phones.gone.id, phones.dead.id, phones.big.id].join(',')],
                      {env: {PUSH_SUBS: SUBS}, input: JSON.stringify(MSGS.slice(0, 1))});
  assert.deepEqual(JSON.parse(k.out).devices.map(x => x.id).sort(), [phones.ok.id, phones.busy.id, phones.denied.id].sort());
  assert.ok(!hits.gone && !hits.big);
});

await test('d. --dry-run builds every request and sends none', async () => {
  reset();
  const r = await run(PUSH, ['send', '--json', '--dry-run'], {env: {PUSH_SUBS: SUBS}, input: JSON.stringify(MSGS)});
  const out = JSON.parse(r.out);
  assert.equal(r.code, 0);
  assert.equal(out.dry, true);
  assert.equal(out.built, ALL.length * MSGS.length);
  assert.equal(out.sent, 0);
  assert.equal(seen.length, 0);
});

await test('d. no devices, no messages, bad stdin, wrong trip key', async () => {
  let r = await run(PUSH, ['send', '--json'], {input: JSON.stringify(MSGS)});
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out).devices, []);
  r = await run(PUSH, ['send', '--json'], {env: {PUSH_SUBS: SUBS}, input: ''});
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).devices.length, ALL.length, 'an empty send checks the keys and lists devices');
  r = await run(PUSH, ['send'], {env: {PUSH_SUBS: SUBS}, input: '{"title": "x"}'});
  assert.equal(r.code, 2);
  r = await run(PUSH, ['send'], {env: {PUSH_SUBS: SUBS, TRIP_KEY: crypto.randomBytes(32).toString('base64')}, input: JSON.stringify(MSGS)});
  assert.equal(r.code, 1);
  assert.match(r.err, /no readable subscriptions/);
});

await test('d. per-message results line up with stdin; skip and untitled entries', async () => {
  reset();
  const four = ['ok', 'busy', 'denied', 'gone'];
  const msgs = [
    {title: 'one', body: 'first', url: '#flights', tag: 'm1', skip: [phones.busy.id, 'not-an-id', phones.ok.id.toUpperCase().slice(0, 6)]},
    {title: '  ', body: 'no title'},
    'not a message',
    {title: 'three', body: 'third', url: '#flights', tag: 'm3', skip: phones.ok.id},  // not a list: skips no one
  ];
  const r = await run(PUSH, ['send', '--json'], {env: {PUSH_SUBS: four.map(n => phones[n].code).join('\n')}, input: JSON.stringify(msgs)});
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.equal(out.messages.length, 4);
  const ids = l => l.map(id => Object.keys(phones).find(n => phones[n].id === id)).sort();
  assert.deepEqual(out.messages.map(m => [ids(m.ok), ids(m.failed)]), [
    [['ok'], ['denied']],          // busy skipped it; gone answered 410 (in neither list)
    [[], []], [[], []],            // not sent, places kept
    [['busy', 'ok'], ['denied']],  // busy: 429, then 201 on the retry
  ]);
  assert.deepEqual(out.gone, [phones.gone.id]);
  assert.match(r.err, /push: 4 of 4 devices, 2 messages/);
  assert.match(r.err, /push: 2 messages without a title not sent/);
  const busy = [];
  for (const s of seen.filter(x => x.name === 'busy')) busy.push(JSON.parse(await receive(s.body, phones.busy)).title);
  assert.deepEqual(busy, ['three', 'three'], 'busy got only the message it did not have (sent twice for the 429)');
  // nothing to send: every place still answered, no request made
  reset();
  const e = await run(PUSH, ['send', '--json'], {env: {PUSH_SUBS: phones.ok.code}, input: '[{"body": "x"}, null]'});
  assert.deepEqual(JSON.parse(e.out).messages, [{ok: [], failed: []}, {ok: [], failed: []}]);
  assert.equal(seen.length, 0);
});

await test('d. a phone that never answers times out; an accepted push does not wait for its body', async () => {
  const slow = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url.endsWith('/stream')) { res.writeHead(201); res.write('.'); }  // headers, then a body that never ends
      // /hang: no answer at all
    });
  });
  await new Promise(r => slow.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${slow.address().port}`;
  try {
    const hang = P.openCode((await phone(`${base}/push/hang`)).code, TRIP_KEY);
    const stream = P.openCode((await phone(`${base}/push/stream`)).code, TRIP_KEY);
    const vapid = P.loadVapid();
    let t = Date.now();
    let r = await P.sendAll([stream], [{title: 'x'}], vapid, {timeout: 5000});
    assert.ok(Date.now() - t < 2000, `accepted push took ${Date.now() - t} ms`);
    assert.deepEqual([r.sent, r.devices[0].ok, r.devices[0].status], [1, true, 201]);
    t = Date.now();
    r = await P.sendAll([hang, stream], [{title: 'x'}, {title: 'y'}], vapid, {timeout: 400});
    const took = Date.now() - t;
    assert.ok(took >= 700 && took < 3000, `two timed-out requests took ${took} ms`);
    const d = Object.fromEntries(r.devices.map(x => [x.id, x]));
    assert.deepEqual([d[hang.id].ok, d[hang.id].status, d[hang.id].reason], [false, 0, 'timeout']);
    assert.deepEqual([d[stream.id].ok, d[stream.id].status], [true, 201]);
    assert.deepEqual(r.messages, [{ok: [stream.id], failed: [hang.id]}, {ok: [stream.id], failed: [hang.id]}]);
    assert.equal(r.unreachable, 2);
  } finally {
    slow.closeAllConnections();
    await new Promise(r => slow.close(r));
  }
});

await test('d. the budget is a hard end: requests are cut short, retries and late ones skipped', async () => {
  const hold = http.createServer(req => { req.resume(); });  // never answers
  await new Promise(r => hold.listen(0, '127.0.0.1', r));
  try {
    const hang = P.openCode((await phone(`http://127.0.0.1:${hold.address().port}/push/hang`)).code, TRIP_KEY);
    const busy = P.openCode(phones.busy.code, TRIP_KEY);
    reset();
    const t = Date.now();
    const r = await P.sendAll([hang, busy], [{title: 'x'}, {title: 'y'}], P.loadVapid(), {budget: 1.6});
    const took = Date.now() - t;
    assert.ok(took >= 1300 && took < 2600, `budget 1.6 s took ${took} ms`);
    const d = Object.fromEntries(r.devices.map(x => [x.id, x]));
    assert.deepEqual([d[hang.id].status, d[hang.id].reason], [0, 'timeout'], 'its 10 s timeout cut to what was left');
    assert.equal(r.late, 1, 'hang: y never started');
    assert.equal(r.retried, 0, 'busy: a 1 s Retry-After plus a second does not fit');
    assert.deepEqual(hits, {busy: 2}, 'busy: x got 429 and was not retried; y went out');
    assert.deepEqual([r.messages[0].ok, [...r.messages[0].failed].sort()], [[], [hang.id, busy.id].sort()]);
    assert.deepEqual(r.messages[1], {ok: [busy.id], failed: [hang.id]});
  } finally {
    hold.closeAllConnections();
    await new Promise(r => hold.close(r));
  }
});

await test('d. a flag without its value, a bad budget or command exits 2 and sends nothing', async () => {
  reset();
  for (const args of [['send', '--only'], ['send', '--skip', '--json'], ['test', '--only', '--dry-run'], ['--budget'],
                      ['--budget', 'soon'], ['--budget', '-1'], ['frobnicate'], ['send', 'test'], ['--nope']]) {
    const r = await run(PUSH, args, {env: {PUSH_SUBS: SUBS}, input: JSON.stringify(MSGS)});
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /needs a value|needs seconds|unknown/);
    assert.equal(r.out, '');
  }
  assert.equal(seen.length, 0);
});

await test('d. several codes on one line; an off-curve key counts as unreadable', async () => {
  const one = [phones.ok.code, phones.busy.code].join(' ') + ',' + phones.gone.code + ';' + offCode('https://push.example.test/off');
  const r = await run(PUSH, ['devices'], {env: {PUSH_SUBS: one}});
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out).map(x => x.id).sort(), [phones.ok.id, phones.busy.id, phones.gone.id].sort());
  assert.match(r.err, /^push: 1 subscription code could not be read$/m);
});

// ---------- (e) public logs ----------

await test('e. with CI=1 stderr carries counts only', async () => {
  reset();
  const runs = [
    await run(PUSH, ['send', '--json'], {env: {CI: '1', PUSH_SUBS: SUBS}, input: JSON.stringify(MSGS)}),
    await run(PUSH, ['test', '--dry-run'], {env: {CI: '1', PUSH_SUBS: SUBS}}),
    await run(PUSH, ['devices'], {env: {CI: '1', PUSH_SUBS: SUBS + '\nAAAA'}}),
    await run(PUSH, ['send'], {env: {CI: '1', PUSH_SUBS: SUBS, VAPID_PRIVATE_KEY: b64u(crypto.randomBytes(32))}, input: '[]'}),
    await run(PUSH, ['send', '--json'], {env: {CI: '1', PUSH_SUBS: SUBS + ' ' + offCode(phones.ok.endpoint)},
                                         input: JSON.stringify([...MSGS, {body: MSGS[0].body}].map(m => ({...m, skip: [phones.ok.id]})))}),
    await run(PUSH, ['test'], {env: {CI: '1', PUSH_SUBS: SUBS, VAPID_SUBJECT: 'mailto:nobody'}}),
    await run(PUSH, ['send', '--only', '--json'], {env: {CI: '1', PUSH_SUBS: SUBS}, input: '[]'}),
  ];
  assert.match(runs[0].err, /sent 4, gone 1, failed 6/);
  const secret = [...ALL.flatMap(p => [p.endpoint, new URL(p.endpoint).host, new URL(p.endpoint).pathname, p.id, p.id.slice(0, 6),
                                       b64u(p.pub), b64u(p.auth), p.code.slice(0, 20)]),
                  ...MSGS.flatMap(m => [m.title, m.body, m.body.split('\n')[0], m.tag, m.url]),
                  'XX100', 'B7', 'Alerts are on', '127.0.0.1', 'BadJwtToken', VAPID_PUB, VAPID_PRIV];
  for (const r of runs) {
    for (const s of secret) assert.ok(!r.err.includes(s), `stderr names ${s.length > 16 ? s.slice(0, 8) + '…' : 'a private value'}`);
    for (const line of r.err.trim().split('\n')) assert.match(line, /^(push: |usage: )/, 'one summary line per event');
  }
  assert.match(runs[4].err, /push: 1 subscription code could not be read/);
  assert.match(runs[4].err, /push: 1 message without a title not sent/);
  assert.match(runs[5].err, /push: the VAPID subject is not/);
  assert.equal(runs[6].code, 2);
});

// ---------- tools/push_subs.mjs ----------

await test('push_subs: add, replace, list, remove (temp file, never .secrets)', async () => {
  const file = path.join(TMP, 'subs.txt');
  const env = {PUSH_SUBS_FILE: file};
  const a = await phone('https://web.push.apple.com/QA-device-a');
  const b = await phone('https://fcm.googleapis.com/fcm/send/device-b');
  const a2 = await phone(a.endpoint, '2031-02-02T00:00:00.000Z');
  const outs = [];
  const go = async (...args) => { const r = await run(SUBS_TOOL, args, {env}); outs.push(r.out + r.err); return r; };
  let r = await go('add', a.code);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^added ${a.id} \\(web\\.push\\.apple\\.com\\) iPhone`));
  r = await run(SUBS_TOOL, ['add'], {env, input: `  ${b.code.slice(0, 40)}\n${b.code.slice(40)}\n`});  // pasted with a line break
  outs.push(r.out + r.err);
  assert.match(r.out, new RegExp(`^added ${b.id} \\(fcm\\.googleapis\\.com\\)`));
  r = await go('add', a2.code);
  assert.match(r.out, new RegExp(`^replaced ${a.id}`));
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  r = await go('list');
  assert.match(r.out, new RegExp(`${a.id}\\s+web\\.push\\.apple\\.com\\s+added 2031-02-02`));
  assert.match(r.out, new RegExp(`${b.id}\\s+fcm\\.googleapis\\.com`));
  r = await go('add', 'AAAAnot-a-code');
  assert.equal(r.code, 1);
  assert.match(r.err, /not usable/);
  r = await go('remove', a.id.slice(0, 5));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^removed ${a.id}`));
  assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n'), [b.code]);
  r = await go('remove', 'ffff00');
  assert.equal(r.code, 1);
  const all = outs.join('\n');
  for (const p of [a, b, a2]) {
    for (const s of [new URL(p.endpoint).pathname, b64u(p.pub), b64u(p.auth), p.code.slice(0, 20), 'AAAAnot-a-code']) {
      assert.ok(!all.includes(s), 'push_subs never prints an endpoint path, key or code');
    }
  }
});

await test('push_subs: several codes in one paste; an off-curve or bad one adds nothing', async () => {
  const file = path.join(TMP, 'subs2.txt');
  const env = {PUSH_SUBS_FILE: file};
  const a = await phone('https://web.push.apple.com/QA-device-c');
  const b = await phone('https://web.push.apple.com/QA-device-d');
  let r = await run(SUBS_TOOL, ['add'], {env, input: `${a.code}\n\n${b.code}\n`});
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^added ${a.id} .*\nadded ${b.id} .*\n2 device\\(s\\)`));
  r = await run(SUBS_TOOL, ['add'], {env, input: offCode('https://web.push.apple.com/QA-off')});
  assert.equal(r.code, 1);
  assert.match(r.err, /not usable: p256dh/);
  const c = await phone('https://web.push.apple.com/QA-device-e');
  r = await run(SUBS_TOOL, ['add'], {env, input: `${c.code} AAAAnot-a-code`});
  assert.equal(r.code, 1);
  assert.match(r.err, /1 of 2 codes are not usable \(nothing added\)/);
  assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n'), [a.code, b.code]);
  for (const s of [a.code.slice(0, 20), c.code.slice(0, 20), 'AAAAnot-a-code']) assert.ok(!r.out.includes(s) && !r.err.includes(s));
});

await test('push_subs: secret pipes the readable codes to gh on stdin, never in its arguments', async () => {
  // A stand-in gh in a directory that is the whole PATH, so the real gh can never run.
  const bin = path.join(TMP, 'bin'), got = path.join(TMP, 'gh-got');
  fs.mkdirSync(bin);
  fs.mkdirSync(got);
  const gh = path.join(bin, 'gh');
  const fake = code => fs.writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$@" > '${got}/args'\n/bin/cat > '${got}/stdin'\nexit ${code}\n`, {mode: 0o700});
  const file = path.join(TMP, 'subs3.txt');
  const a = await phone('https://web.push.apple.com/QA-device-f');
  const b = await phone('https://fcm.googleapis.com/fcm/send/device-g');
  const other = seal({v: 1, kind: 'push-sub'}, crypto.randomBytes(32)).toString('base64url');  // another trip key
  fs.writeFileSync(file, [a.code, other, b.code].join('\n') + '\n', {mode: 0o600});
  const env = {PUSH_SUBS_FILE: file, PATH: bin};
  fake(0);
  let r = await run(SUBS_TOOL, ['secret'], {env});
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^PUSH_SUBS set \(2 device\(s\)\)/);
  assert.match(r.err, /1 code\(s\) that do not open left out/);
  assert.deepEqual(fs.readFileSync(path.join(got, 'args'), 'utf8').trim().split('\n'), ['secret', 'set', 'PUSH_SUBS', '-R', '5j4d7mkd4j-byte/tripbook']);
  assert.equal(fs.readFileSync(path.join(got, 'stdin'), 'utf8'), `${a.code}\n${b.code}\n`);
  for (const s of [a.code.slice(0, 20), b.code.slice(0, 20), other.slice(0, 20)]) assert.ok(!r.out.includes(s) && !r.err.includes(s));
  fake(3);
  r = await run(SUBS_TOOL, ['secret'], {env});
  assert.equal(r.code, 1);
  assert.match(r.err, /gh exited with 3/);
  fs.rmSync(gh);
  r = await run(SUBS_TOOL, ['secret'], {env});
  assert.equal(r.code, 1);
  assert.match(r.err, /could not run gh/);
  fs.writeFileSync(file, other + '\n');
  fake(0);
  fs.rmSync(path.join(got, 'stdin'));
  r = await run(SUBS_TOOL, ['secret'], {env});
  assert.equal(r.code, 1);
  assert.match(r.err, /none of the codes open/);
  assert.ok(!fs.existsSync(path.join(got, 'stdin')), 'gh not run');
});

server.close();
fs.rmSync(TMP, {recursive: true, force: true});
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
