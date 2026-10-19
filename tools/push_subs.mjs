// The phones that get lock-screen alerts. Each phone turns alerts on in the
// installed app and shows a code (its push subscription, sealed with the trip
// key); paste it here, then copy the list to the PUSH_SUBS secret for Actions.
//
//   node tools/push_subs.mjs add CODE     (or: pbpaste | node tools/push_subs.mjs add; several codes,
//                                          one per line, are fine; so is one code broken over lines)
//   node tools/push_subs.mjs list         device ids, push hosts, when added
//   node tools/push_subs.mjs remove ID    a device id from list (a unique prefix is enough)
//   node tools/push_subs.mjs secret       PUSH_SUBS secret <- the file (runs gh)
//
// The list is .secrets/push_subs.txt (PUSH_SUBS_FILE overrides), one code per
// line. Endpoints and keys are never printed: only the device id (first 12 hex
// of sha256(endpoint), the same id the app and updater/push.mjs show) and the
// push service host.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {loadKey} from './tripcrypt.mjs';
import {codeLines, openCode, subsFile} from '../updater/push.mjs';

const REPO = '5j4d7mkd4j-byte/tripbook';
const fail = msg => { console.error(`push_subs: ${msg}`); process.exit(1); };

function readList() {
  try { return codeLines(fs.readFileSync(subsFile(), 'utf8')); } catch { return []; }
}
function writeList(lines) {
  const f = subsFile();
  fs.mkdirSync(path.dirname(f), {recursive: true, mode: 0o700});
  const tmp = f + '.tmp';
  try { fs.unlinkSync(tmp); } catch {}  // a leftover would keep its old mode
  fs.writeFileSync(tmp, lines.map(l => l + '\n').join(''), {mode: 0o600});
  fs.renameSync(tmp, f);
}
// [{line, d}] with d null for a line that does not open.
const opened = (lines, key) => lines.map(line => { try { return {line, d: openCode(line, key)}; } catch { return {line, d: null}; } });
const day = at => at && !isNaN(Date.parse(at)) ? new Date(at).toISOString().slice(0, 10) : '?';

async function stdinText() {
  if (process.stdin.isTTY) return '';
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
}

// The pasted text as codes: one code (line breaks from a wrapped paste removed), or
// failing that, each word on its own. [{code, d}] or [{code, why}].
function codesIn(text, key) {
  const one = text.replace(/\s+/g, '');
  const words = text.split(/[\s,;]+/).filter(Boolean);
  const read = code => { try { return {code, d: openCode(code, key)}; } catch (e) { return {code, why: e.message}; } };
  const whole = read(one);
  return whole.d || words.length < 2 ? [whole] : words.map(read);
}

async function add(arg) {
  const text = String(arg && arg !== '-' ? arg : await stdinText());
  if (!text.trim()) fail('no code (pass it as an argument or on stdin)');
  const key = loadKey();
  const got = codesIn(text, key);
  const bad = got.filter(g => !g.d);
  if (bad.length) fail(got.length === 1 ? `that code is not usable: ${bad[0].why}` : `${bad.length} of ${got.length} codes are not usable (nothing added)`);
  let rows = opened(readList(), key);
  for (const {code, d} of got) {
    const same = rows.filter(r => r.d && r.d.endpoint === d.endpoint);
    rows = [...rows.filter(r => !same.includes(r)), {line: code, d}];
    console.log(`${same.length ? 'replaced' : 'added'} ${d.id} (${d.host})${d.ua ? ' ' + d.ua : ''}`);
  }
  writeList(rows.map(r => r.line));
  console.log(`${rows.length} device(s) in ${path.relative(process.cwd(), subsFile()) || subsFile()}; run "node tools/push_subs.mjs secret" to update Actions`);
}

function list() {
  const lines = readList();
  if (!lines.length) { console.log('no devices yet'); return; }
  const key = loadKey();
  opened(lines, key).forEach(({d}, i) => console.log(d
    ? `${d.id}  ${d.host.padEnd(28)} added ${day(d.at)}${d.ua ? '  ' + d.ua : ''}`
    : `line ${i + 1}: could not open (wrong trip key or a damaged code)`));
}

function remove(id) {
  id = String(id || '').trim().toLowerCase();
  if (!/^[0-9a-f]{4,12}$/.test(id)) fail('give a device id from "list" (at least 4 hex characters)');
  const rows = opened(readList(), loadKey());
  const ids = new Set(rows.filter(r => r.d && r.d.id.startsWith(id)).map(r => r.d.id));
  if (!ids.size) fail('no such device');
  if (ids.size > 1) fail('that prefix matches more than one device');
  writeList(rows.filter(r => !(r.d && ids.has(r.d.id))).map(r => r.line));
  console.log(`removed ${[...ids][0]}; run "node tools/push_subs.mjs secret" to update Actions`);
}

// gh reads the secret value from stdin, so it never appears in a command line.
function secret() {
  const lines = readList();
  if (!lines.length) fail('no devices to upload');
  // Only codes that open with the trip key (Actions has the same key as TRIP_KEY): any
  // other would just be counted as unreadable on every run.
  const ok = opened(lines, loadKey()).filter(r => r.d).map(r => r.line);
  if (!ok.length) fail('none of the codes open with this trip key; nothing uploaded');
  if (ok.length < lines.length) console.error(`push_subs: ${lines.length - ok.length} code(s) that do not open left out; "list" shows which`);
  const gh = spawn('gh', ['secret', 'set', 'PUSH_SUBS', '-R', REPO], {stdio: ['pipe', 'inherit', 'inherit']});
  gh.on('error', () => fail('could not run gh'));
  gh.stdin.on('error', () => {});  // gh gone before reading: 'close' or 'error' reports it
  gh.on('close', code => {
    if (code) fail(`gh exited with ${code}`);
    console.log(`PUSH_SUBS set (${ok.length} device(s))`);
  });
  gh.stdin.end(ok.join('\n') + '\n');
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'add') await add(arg);
  else if (cmd === 'list') list();
  else if (cmd === 'remove') remove(arg);
  else if (cmd === 'secret') secret();
  else { console.error('usage: push_subs.mjs add CODE | list | remove ID | secret'); process.exit(2); }
} catch (e) {
  fail(e.message);  // loadKey's messages name files, never key material
}
