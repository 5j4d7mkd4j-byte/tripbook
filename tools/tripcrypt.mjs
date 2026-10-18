// Shared encryption for the trip bundles. File format:
//   "NYC1" + 12-byte IV + AES-256-GCM(gzip(JSON)) + 16-byte tag
// The 32-byte key comes from TRIP_KEY (base64) in the environment, or
// .secrets/trip_key.b64, or is derived from .secrets/passphrase.txt with the
// salt in .secrets/key.json (PBKDF2-SHA256). The browser does the same in core.js.
//
//   node tools/tripcrypt.mjs seal in.json out.bin
//   node tools/tripcrypt.mjs open in.bin [out.json]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEC = path.join(ROOT, '.secrets');
export const ITER = 400000;
export const norm = p => String(p || '').trim().toLowerCase().replace(/\s+/g, '-');

export function seal(obj, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = zlib.gzipSync(Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)), {level: 9});
  return Buffer.concat([Buffer.from('NYC1'), iv, c.update(body), c.final(), c.getAuthTag()]);
}
export function open(buf, key) {
  buf = Buffer.from(buf);
  if (buf.subarray(0, 4).toString() !== 'NYC1') throw new Error('not a trip file');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(4, 16));
  d.setAuthTag(buf.subarray(buf.length - 16));
  const gz = Buffer.concat([d.update(buf.subarray(16, buf.length - 16)), d.final()]);
  return JSON.parse(zlib.gunzipSync(gz).toString());
}
// key.json is public (docs/data/key.json): salt, iterations and a sealed check value.
export function keyInfo(create = false) {
  const f = path.join(SEC, 'key.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!create) return null;
  const info = {v: 1, salt: crypto.randomBytes(16).toString('base64'), iter: ITER};
  fs.mkdirSync(SEC, {recursive: true, mode: 0o700});
  fs.writeFileSync(f, JSON.stringify(info), {mode: 0o600});
  return info;
}
export function loadKey({create = false} = {}) {
  if (process.env.TRIP_KEY) return Buffer.from(process.env.TRIP_KEY.trim(), 'base64');
  const kf = path.join(SEC, 'trip_key.b64');
  if (fs.existsSync(kf)) return Buffer.from(fs.readFileSync(kf, 'utf8').trim(), 'base64');
  const pf = path.join(SEC, 'passphrase.txt');
  if (!fs.existsSync(pf)) throw new Error('no key: set TRIP_KEY or create .secrets/passphrase.txt');
  const info = keyInfo(create);
  if (!info) throw new Error('no .secrets/key.json');
  const key = crypto.pbkdf2Sync(norm(fs.readFileSync(pf, 'utf8')), Buffer.from(info.salt, 'base64'), info.iter, 32, 'sha256');
  fs.writeFileSync(kf, key.toString('base64'), {mode: 0o600});
  return key;
}
export function publicKeyJson(key) {
  const info = keyInfo(true);
  return {v: info.v, salt: info.salt, iter: info.iter, check: seal({ok: true}, key).toString('base64')};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [cmd, a, b] = process.argv.slice(2);
  const key = loadKey();
  if (cmd === 'seal') fs.writeFileSync(b, seal(fs.readFileSync(a, 'utf8'), key));
  else if (cmd === 'open') { const o = JSON.stringify(open(fs.readFileSync(a), key), null, 1); b ? fs.writeFileSync(b, o) : process.stdout.write(o); }
  else { console.error('usage: tripcrypt.mjs seal in.json out.bin | open in.bin [out.json]'); process.exit(2); }
}
