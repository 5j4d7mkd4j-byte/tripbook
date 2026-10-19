/* Lock-screen alerts (#alerts).
   iPhone (iOS 16.4+) can push alerts to a web app that was added to the Home
   Screen. Turning alerts on asks for permission, subscribes this phone and
   turns the subscription into a sealed code ("NYC1" + IV + AES-GCM(gzip(JSON)),
   base64url, the trip-file format) that the traveler sends in the chat. The
   code is kept in 'nyc.push' with this phone's device id (the first 12 hex
   characters of sha256(endpoint)); no Wallet data goes into it. Whether the
   code has been added comes back in status.alerts.devices. */
(() => {
'use strict';
const {h, icon} = N;
const R = N.raw;

// ---------- shared (same look as Settings) ----------
const painted = new WeakSet();
// True on the first paint after navigating here, so entrances don't replay on refills.
const firstPaint = () => {
  const c = N.current();
  if (!c) return true;
  if (painted.has(c)) return false;
  painted.add(c);
  return true;
};
const safe = (fn, d) => { try { const v = fn(); return v == null ? d : v; } catch (e) { return d; } };
// The compact header the other task screens use (wallet.css .wl-hero-c).
const bar = (ey, ic, title) => h`<div class="wl-hero wl-hero-c">
  <div class="ey wl-ey">${icon(ic)}<span>${ey}</span></div>
  <h1 class="hl wl-hl"><b>${title}</b></h1></div>`;
const sec = (id, title, inner, i, rise) => h`<section class="sec${rise ? ' rise' : ''}" style="animation-delay:${i * 45}ms" aria-labelledby="${id}-t">
  <h2 class="ey wl-sh" id="${id}-t">${title}</h2><div id="${id}">${inner}</div></section>`;
const fill = (id, fn) => {
  const el = document.getElementById(id);
  if (!el) return null;
  try { el.innerHTML = String(fn()); } catch (e) { N.report(e, 'alerts.js ' + id); }
  return el;
};
const refocus = sel => { const b = N.$(sel); if (b) b.focus({preventScroll: true}); };
const row = (ic, title, sub, tag = 'div') => h`${R(`<${tag} class="rw c wl-r">`)}<span class="ic">${icon(ic)}</span><div class="grow"><b>${title}</b><small>${sub}</small></div>${R(`</${tag}>`)}`;

// ---------- bytes ----------
const te = new TextEncoder();
const b64u = u => N.b64e(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => N.b64d(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
const hex = u => [...u].map(b => b.toString(16).padStart(2, '0')).join('');

// The updater's sender computes the same id, so status can name this phone without its endpoint.
const devId = async endpoint => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(endpoint))).subarray(0, 6));

// Sealed with the trip key, so only the trip's own tools can open it (tools/tripcrypt.mjs open()).
async function seal(doc) {
  const raw = N.get('nyc.k');
  if (!raw) throw new Error('no trip key');
  const key = await crypto.subtle.importKey('raw', N.b64d(raw), 'AES-GCM', false, ['encrypt']);
  const gz = new Uint8Array(await new Response(new Blob([JSON.stringify(doc)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, gz));   // tag is appended
  const out = new Uint8Array(16 + ct.length);
  out.set(te.encode('NYC1'));
  out.set(iv, 4);
  out.set(ct, 16);
  return b64u(out);
}

// ---------- state ----------
const S = {busy: false, ask: false, show: false, lost: false, sig: ''};
const mine = () => { const p = N.get('nyc.push'); return p && p.code && p.id ? p : null; };
const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const canPush = () => 'Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator;
const perm = () => safe(() => Notification.permission, 'default');
// The public half of the sender's key (build config); a P-256 point is 65 bytes.
const vapid = () => safe(() => { const k = unb64u(String(N.cfg.vapid || '')); return k.length === 65 ? k : null; }, null);
// 'browser' (not on the Home Screen) | 'unsupported' | 'denied' | 'on' | 'nokey' | 'ready'
function state() {
  if (!installed()) return 'browser';
  if (!canPush()) return 'unsupported';
  if (perm() === 'denied') return 'denied';
  if (mine() && perm() === 'granted') return 'on';
  return vapid() ? 'ready' : 'nokey';
}
// This phone in status.alerts.devices ({id, ok, at}), or null when the sender doesn't list it.
function entry() {
  const p = mine(), d = safe(() => N.data.status.alerts.devices, null);
  if (!p || !d) return null;
  const e = Array.isArray(d) ? d.find(x => x === p.id || x && x.id === p.id) : d[p.id];
  return e == null ? null : e;
}
// 'active' | 'waiting' | 'stopped' (the sender's last push to it failed) | 'unknown' (no status yet)
function device() {
  if (!mine()) return 'waiting';
  if (!N.data.status) return 'unknown';
  const e = entry();
  if (e == null) return 'waiting';
  return e === false || e.ok === false ? 'stopped' : 'active';
}
const lastAt = () => safe(() => entry().at, '');
const sig = () => { const s = state(); return s === 'on' ? s + device() + lastAt() : s + S.lost; };

// Resolves once the service worker is running; tests and first loads may have none yet.
const ready = (ms = 4000) => Promise.race([navigator.serviceWorker.ready,
  new Promise((_, no) => setTimeout(() => no(new Error('no service worker')), ms))]);

// A label for the sender's device list; iPadOS reports itself as a Mac with touch.
const model = () => /iPad/.test(navigator.userAgent) || /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1 ? 'iPad' : 'iPhone';
async function save(sub) {
  const doc = {v: 1, kind: 'push-sub', sub: sub.toJSON(), at: new Date().toISOString(), ua: model()};
  N.set('nyc.push', {id: await devId(sub.endpoint), code: await seal(doc), at: Date.now()});
}
// asked: the permission promise, started in the tap itself. fresh: drop the old subscription first.
async function turnOn(asked, fresh) {
  const p = await asked;
  if (p !== 'granted') {
    if (p === 'default') N.toast('Alerts stay off until you tap Allow');
    return;
  }
  const key = vapid();
  // Only reachable from "Turn on again" in a build without the key; keep the old subscription.
  if (!key) { N.toast('Alerts aren’t ready in this version yet'); return; }
  const reg = await ready();
  const same = s => safe(() => b64u(new Uint8Array(s.options.applicationServerKey)) === b64u(key), true);
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another key can't be reused; iPhone also refuses a second one alongside it.
  if (sub && (fresh || !same(sub))) { await sub.unsubscribe().catch(() => {}); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: key});
  await save(sub);
  S.lost = false;
  S.show = false;
  N.toast('Now send the code');
}
// The phone can drop or replace a subscription on its own. Compare with what's saved.
async function check() {
  const p = mine();
  if (!p || state() !== 'on') return false;
  let sub;
  try { sub = await (await ready()).pushManager.getSubscription(); } catch (e) { return false; }
  if (!sub) { N.set('nyc.push', null); S.lost = true; return true; }
  if (await devId(sub.endpoint) === p.id) return false;
  await save(sub);
  return true;
}

// ---------- parts ----------
// Every state opens with what's true now; only 'ready' opens with the button.
const TITLE = {browser: 'Status', unsupported: 'Status', denied: 'Status', nokey: 'Status', ready: 'Turn on'};
const card = (cls, ic, b, sub, extra = '') => h`<div class="wl-card al-st ${cls}" role="status"><div class="rw c"><span class="ic">${icon(ic)}</span>
  <div class="grow"><b>${b}</b><small>${sub}</small></div></div>${extra}</div>`;
// The phone dropped its subscription (lost) or the sender's pushes to it fail (stopped, arg 'again').
const stoppedHtml = arg => card('bad', 'alert-triangle', 'Alerts stopped', 'Turn them on again, then send the new code in the chat.',
  h`<button class="btn wl-wide al-again" data-act="aon"${arg ? R(` data-arg="${arg}"`) : ''}${S.busy ? R(' aria-disabled="true"') : ''}>${icon('refresh')}${S.busy ? 'Turning on…' : 'Turn on again'}</button>`);
function onHtml(s) {
  if (s === 'browser') return card('', 'bell-off', 'Add nyc. to your Home Screen first', 'iPhone only sends alerts to Home Screen apps.');
  if (s === 'unsupported') {
    return card('', 'info-circle', 'Not available on this iPhone', 'Alerts need iOS 16.4 or later. Update in Settings › General › Software Update.');
  }
  if (s === 'nokey') {
    return card('', 'hourglass', 'Not ready yet', 'Alerts come with the next app update, which installs by itself.');
  }
  if (s === 'denied') return card('warn', 'bell-off', 'Notifications are off for nyc.', 'Alerts can’t reach this phone until you allow them.');
  if (S.lost) return stoppedHtml();
  return h`<button class="btn wl-wide" data-act="aon"${S.busy ? R(' aria-disabled="true"') : ''}>${icon('bell')}${S.busy ? 'Turning on…' : 'Turn on alerts'}</button>
    <p class="help">Your iPhone asks first: tap Allow. Then send the code you get here in the chat.</p>`;
}
// The steps out of 'browser' and 'denied', in their own section under the status.
const HOW = {browser: 'How to add it', denied: 'How to allow them'};
function howHtml(s) {
  const rows = s === 'browser'
    ? h`${row('share', 'Tap Share', 'In Safari’s toolbar, or under ⋯ More', 'li')}
      ${row('plus', 'Choose Add to Home Screen', 'Scroll the list if it isn’t showing', 'li')}
      ${row('device-mobile', 'Open nyc. from the new icon', 'Then come back here', 'li')}`
    : h`${row('settings', 'Open the Settings app', 'Your iPhone’s Settings, not this screen', 'li')}
      ${row('bell', 'Tap Notifications, then nyc.', 'Apps are listed A to Z', 'li')}
      ${row('check', 'Turn on Allow Notifications', 'Then come back. This screen updates by itself.', 'li')}`;
  return h`<ol class="wl-card wl-rows al-steps">${rows}</ol>`;
}
function statusHtml() {
  const d = device();
  if (d === 'active') {
    const at = lastAt();
    return h`${card('ok', 'circle-check', 'Active on this phone', at ? h`Last alert <span data-ago="${at}">${N.ago(at)}</span>` : 'Nothing has changed yet.')}
      ${S.show ? '' : h`<button class="wl-link" data-act="ashow" aria-expanded="false">${icon('chevron-down')}Show this phone’s code</button>`}`;
  }
  if (d === 'stopped') return stoppedHtml('again');
  if (d === 'unknown') return card('', 'bell', 'Turned on', 'Confirmed after the next flight check.');
  return card('wait', 'hourglass', 'Waiting for your code', 'Send it in the chat to start alerts.');
}
function codeHtml() {
  const p = mine();
  if (!p) return '';
  const share = typeof navigator.share === 'function';
  // Only the start of the code shows; Copy and Share always take all of it.
  return h`<div class="al-code"><span id="al-cv">${p.code}</span></div>
    <div class="al-btns wl-gap"><button class="btn" data-act="acopy">${icon('copy')}Copy code</button>
      ${share ? h`<button class="btn alt" data-act="ashare">${icon('share')}Share</button>` : ''}</div>
    <p class="help">Each phone has its own code.</p>`;
}
const KINDS = [['door-exit', 'Gate changes'], ['clock', 'Delays of 15 min or more'], ['alert-triangle', 'Cancellations and diversions'], ['arrows-exchange', 'Tight connections']];
const kindsHtml = () => h`<ul class="wl-list al-kinds">${KINDS.map(([ic, t]) => h`<li>${icon(ic)}<span>${t}</span></li>`)}</ul>
  <p class="help">Only this trip’s flights, and only when something changes.</p>`;
function phoneHtml() {
  if (S.ask) {
    return h`<div class="wl-confirm" role="group" aria-labelledby="al-oq">
      <b id="al-oq">Turn off alerts on this phone?</b>
      <p>They stop right away. Turning them back on needs a new code.</p>
      <div class="row"><button class="btn wl-cancel grow" data-act="aoff-no">Cancel</button>
        <button class="btn rose grow" data-act="aoff-yes">Turn off</button></div></div>`;
  }
  // A sample shows locally even when pushes fail, so a stopped phone doesn't get one.
  const sample = device() !== 'stopped';
  return h`${sample ? h`<button class="btn alt wl-wide" data-act="asample">${icon('bell')}Show a sample alert</button>` : ''}
    <button class="btn alt wl-wide${sample ? ' wl-gap' : ''}" data-act="aoff">${icon('bell-off')}Turn off alerts</button>`;
}
function inner(rise) {
  const s = state();
  S.sig = sig();
  const d = s === 'on' && device();
  // A stopped phone's code is dead, and an active one rarely needs it again.
  const code = d && d !== 'stopped' && (d !== 'active' || S.show);
  const parts = s === 'on'
    ? [['al-st', 'Status', statusHtml()], code && ['al-code', 'Your code', codeHtml()], ['al-kinds', 'What you’ll get', kindsHtml()], ['al-ph', 'This phone', phoneHtml()]]
    : [['al-on', S.lost && s === 'ready' ? 'Status' : TITLE[s], onHtml(s)], HOW[s] && ['al-how', HOW[s], howHtml(s)], ['al-kinds', 'What you’ll get', kindsHtml()]];
  return h`${parts.filter(Boolean).map(([id, t, x], i) => sec(id, t, x, i, rise))}`;
}
const paintAll = () => fill('al', () => inner(false));
// Text selected in the code box survives status refreshes that change nothing here.
const update = () => { if (sig() !== S.sig) paintAll(); };
const pick = () => {
  const c = N.$('#al-cv');
  if (!c) return;
  c.classList.add('all');
  const r = document.createRange();
  r.selectNodeContents(c);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
};

// For Settings and Flights: one word for the current state, and a one-time card
// shown once the app is on the Home Screen with alerts still off.
N.alerts = {
  state,
  word() {
    if (state() !== 'on') return 'Off';
    const d = device();
    return d === 'active' || d === 'unknown' ? 'On' : d === 'stopped' ? 'Stopped' : 'Waiting';
  },
  nudge() {
    if (N.get('nyc.push.skip') || state() !== 'ready') return '';
    return h`<div class="bn neutral al-nudge rise">${icon('bell')}<div class="grow">
      <b>Get flight changes on your lock screen</b>
      <span>Gate changes, delays and tight connections, even with the app closed.</span>
      <div class="bx"><a class="chip fl-btn al-go" href="#alerts">Turn on</a><button class="chip fl-btn" data-act="al-skip">Not now</button></div></div></div>`;
  },
};
// Global so the card's button works on whichever screen shows it.
N.actions['al-skip'] = () => { N.set('nyc.push.skip', 1); N.rerender(); };

// Tapping an alert while the app is open: sw.js focuses this window and names the route.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', e => {
    const m = e.data || {};
    if (m.type === 'open' && typeof m.url === 'string' && m.url.length > 1 && m.url.startsWith('#')) N.go(m.url);
  });
}

N.screen('alerts', {
  back: 'settings', nav: false, title: 'Alerts',
  // 'force' too: core's rerender() checks `uses` first, so without it N.rerender() would skip this screen.
  uses: ['status', 'force'],
  render() {
    const rise = firstPaint();
    if (rise) { S.ask = false; S.show = false; }
    return {
      hero: bar('This phone', 'bell', 'Lock-screen alerts'),
      body: h`<div class="wl wl-al" id="al">${inner(rise)}</div>`,
    };
  },
  update,
  mount() {
    // Coming back from the iPhone's Settings (or the Home Screen) can change everything here.
    const look = () => check().then(ch => { if (ch) paintAll(); else update(); }).catch(e => N.report(e, 'alerts check'));
    const vis = () => { if (!document.hidden) look(); };
    document.addEventListener('visibilitychange', vis);
    look();
    return () => document.removeEventListener('visibilitychange', vis);
  },
  actions: {
    aon(el, ev, ctx, arg) {
      if (S.busy) return;
      // iPhone only shows the permission prompt when it's asked straight from the tap,
      // so this comes before anything that waits.
      const p = safe(() => Notification.requestPermission(), null);
      const asked = p && p.then ? p : Promise.resolve(perm());
      S.busy = true;
      fill(arg === 'again' ? 'al-st' : 'al-on', arg === 'again' ? statusHtml : () => onHtml(state()));
      return turnOn(asked, arg === 'again').catch(e => {
        N.report(e, 'alerts on');
        N.toast(N.online() ? 'Couldn’t turn on alerts. Try again.' : 'Turning on alerts needs a signal');
      }).finally(() => {
        S.busy = false;
        paintAll();
        refocus(N.$('#al-code [data-act="acopy"]') ? '#al-code [data-act="acopy"]' : '#al [data-act="aon"]');
      });
    },
    async acopy(el) {
      const p = mine();
      if (!p) return;
      try { await navigator.clipboard.writeText(p.code); }
      catch (e) { pick(); N.toast('Press and hold the code, then tap Copy'); return; }
      el.innerHTML = String(h`${icon('check')}Copied`);
      setTimeout(() => { if (el.isConnected) el.innerHTML = String(h`${icon('copy')}Copy code`); }, 2000);
    },
    async ashare() {
      const p = mine();
      if (!p) return;
      try { await navigator.share({text: p.code}); }
      catch (e) { if (e && e.name !== 'AbortError') N.toast('Couldn’t open Share. Copy the code instead.'); }
    },
    ashow() { S.show = true; paintAll(); refocus('#al-code [data-act="acopy"]'); },
    async asample() {
      if (perm() !== 'granted') { N.toast('Notifications are off for nyc.'); return; }
      try {
        const reg = await ready();
        await reg.showNotification('Sample alert', {body: 'Gate changes, delays and connection warnings show up like this.',
          icon: 'icons/icon-192.png', tag: 'nyc-sample', data: {url: '#alerts'}});
        N.toast('Sample sent');
      } catch (e) { N.report(e, 'alerts sample'); N.toast('Couldn’t show a sample'); }
    },
    aoff() { S.ask = true; fill('al-ph', phoneHtml); refocus('#al-ph [data-act="aoff-no"]'); },
    'aoff-no'() { S.ask = false; fill('al-ph', phoneHtml); refocus('#al-ph [data-act="aoff"]'); },
    async 'aoff-yes'() {
      S.ask = false;
      try { const sub = await (await ready()).pushManager.getSubscription(); if (sub) await sub.unsubscribe(); }
      catch (e) { N.report(e, 'alerts off'); }
      N.set('nyc.push', null);
      S.show = false;
      paintAll();
      N.toast('Alerts turned off');
      refocus('#al-on [data-act="aon"]');
    },
  },
});
})();
