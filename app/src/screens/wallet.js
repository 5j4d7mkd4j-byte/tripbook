/* Wallet, Settings, Data & offline, and Add to Calendar
   (#wallet, #settings, #data, #calendar).
   Wallet values (names, codes, seats, bags, hotel details, notes) are read
   only through N.wallet(), saved only with N.setWallet(), and never logged,
   put in a URL, sent anywhere or written into the calendar file. */
(() => {
'use strict';
const {h, icon} = N;
const R = N.raw;

// ---------- shared ----------
const painted = new WeakSet();
// True on a screen's first paint after navigating to it, so entrance
// animations don't replay when the screen re-renders in place.
const firstPaint = () => {
  const c = N.current();
  if (!c) return true;
  if (painted.has(c)) return false;
  painted.add(c);
  return true;
};
const str = v => v == null ? '' : String(v);
const fmtN = n => Number(n || 0).toLocaleString('en-US');
const mbText = b => { const m = (b || 0) / 1e6; return m < 1 ? `${Math.max(0.1, Math.round(m * 10) / 10)} MB` : `${fmtN(Math.round(m))} MB`; };
const attr = (cond, a) => cond ? R(a) : '';
const pressed = v => v ? 'true' : 'false';
const safe = (fn, d) => { try { const v = fn(); return v == null ? d : v; } catch (e) { return d; } };
const legs = () => safe(() => N.legs(), []);
const leave = dir => safe(() => N.leave(dir), null);
const legName = l => `${l.flight || 'Flight'} · ${l.from || '?'} → ${l.to || '?'}`;
const legDay = l => safe(() => N.date(l.dep && l.dep.sched || (l.date ? l.date + 'T16:00:00Z' : null), l.from), '—');
const T = iso => iso ? new Date(iso).getTime() : NaN;

// The clock the traveler is living on: Phoenix before and after the trip, New York during it.
function zone() {
  const p = safe(() => N.phase(), 'before');
  if (p === 'stay' || p === 'ret') return 'NYC';
  if (p === 'out') {
    const l = safe(() => N.dirLegs('out'), [])[0];
    return l && l.dep && l.dep.time && N.now().getTime() > T(l.dep.time) ? 'NYC' : 'PHX';
  }
  return 'PHX';
}
// "4:12p" today, "Sun 4:12p" this week, "Sun 18 Oct 4:12p" further off
function when(iso, ap) {
  if (!iso) return '';
  if (N.ymd(iso, ap) === N.ymd(N.now(), ap)) return N.time(iso, ap);
  const d = N.date(iso, ap);
  return `${Math.abs(N.now() - new Date(iso)) < 6 * 864e5 ? d.split(' ')[0] : d} ${N.time(iso, ap)}`;
}

// These are task screens (Wallet, Settings, Data, Calendar), so they get a compact header:
// eyebrow and a 28px title, keeping the first control high on the screen.
const bar = (ey, ic, title, sub, id) => h`<div class="wl-hero wl-hero-c">
  <div class="ey wl-ey">${icon(ic)}<span>${ey}</span></div>
  <h1 class="hl wl-hl"><b>${title}</b></h1>
  ${sub ? h`<p class="wl-lede"${id ? R(` id="${id}"`) : ''}>${sub}</p>` : ''}</div>`;
const sec = (id, title, inner, i, rise) => h`<section class="sec${rise ? ' rise' : ''}" style="animation-delay:${i * 45}ms"${title ? R(` aria-labelledby="${id}-t"`) : ''}>
  ${title ? h`<h2 class="ey wl-sh" id="${id}-t">${title}</h2>` : ''}<div id="${id}">${inner}</div></section>`;
const fill = (id, fn) => {
  const el = document.getElementById(id);
  if (!el) return null;
  try { el.innerHTML = String(fn()); } catch (e) { N.report(e, 'wallet.js ' + id); }
  return el;
};
const refocus = sel => { const b = N.$(sel); if (b) b.focus({preventScroll: true}); };
const stepper = (act, val, sub, minus, plus, canDown, canUp) => h`<div class="wl-step">
  <button class="ibtn wl-ib" data-act="${act}" data-arg="-1" aria-label="${minus}"${attr(!canDown, ' aria-disabled="true"')}>${icon('minus')}</button>
  <div class="wl-step-v" aria-live="polite"><b class="tn">${val}</b><span>${sub}</span></div>
  <button class="ibtn wl-ib" data-act="${act}" data-arg="1" aria-label="${plus}"${attr(!canUp, ' aria-disabled="true"')}>${icon('plus')}</button>
</div>`;

// =====================================================================
// Wallet
// =====================================================================
function checkAA(raw, final) {
  const v = str(raw).toUpperCase().replace(/[\s-]+/g, '');
  if (!v) return {ok: true, v: ''};
  if (/^\d+$/.test(v) && v.length >= 10) {
    return {ok: false, v, msg: v.length === 13
      ? 'That’s a 13-digit ticket number. The confirmation code is 6 letters, near the top of your American Airlines email.'
      : 'That looks like a ticket number. The confirmation code is 6 letters, near the top of your American Airlines email.'};
  }
  if (/[^A-Z]/.test(v)) return {ok: false, v, msg: 'Letters only. AA confirmation codes are 6 letters, like ABCDEF.'};
  if (v.length > 6) return {ok: false, v, msg: `That’s ${v.length} letters. AA confirmation codes have 6.`};
  if (v.length < 6) return final ? {ok: false, v, msg: `That’s ${N.plural(v.length, 'letter')}. AA confirmation codes have 6.`} : {ok: false, v, soft: true};
  return {ok: true, v};
}
function checkHotel(raw, final) {
  const v = str(raw).trim().replace(/\s+/g, ' ').toUpperCase();
  if (!v) return {ok: true, v: ''};
  if (v.length > 30) return {ok: false, v, msg: 'That’s longer than a hotel confirmation usually is (30 characters at most).'};
  if (/[^A-Z0-9 \-/#.]/.test(v)) return {ok: false, v, msg: 'Use letters, numbers and dashes only.'};
  if (v.replace(/[^A-Z0-9]/g, '').length < 3) return final ? {ok: false, v, msg: 'That looks too short for a confirmation number.'} : {ok: false, v, soft: true};
  return {ok: true, v};
}
function checkSeat(raw, final) {
  const v = str(raw).toUpperCase().replace(/\s+/g, '');
  if (!v) return {ok: true, v: ''};
  const m = v.match(/^(\d{1,2})([A-F])$/);
  if (m && +m[1] > 0) return {ok: true, v};
  if (!final && /^\d{1,2}$/.test(v)) return {ok: false, v, soft: true};
  return {ok: false, v, msg: 'Seats look like 21C: row number, then a letter A–F.'};
}

const CODES = {
  aa_code: {label: 'AA confirmation code', ph: '6 letters', check: checkAA, max: 20,
    hint: 'Six letters near the top of your American Airlines email.'},
  aa_code_ret: {label: 'Return confirmation code', ph: '6 letters', check: checkAA, max: 20, optional: true, ic: 'ticket',
    add: 'Only if the flights home are a separate booking', hint: 'Only needed if the flights home are on a separate booking.'},
  hotel_code: {label: 'Hotel confirmation', ph: 'Number or code', check: checkHotel, max: 40, optional: true, ic: 'building',
    add: 'Number from the hotel’s email, if you want it handy', hint: ''},
};
const MAX_PEOPLE = 9;

// A wallet saved by an older build, or edited by hand, can hold the wrong
// shapes: a seat that isn't in a list, a name that's a number. The itinerary
// reads seats straight from storage and one bad shape stops every screen, so
// mend the shapes once at load, before the first paint. Values are kept.
(() => {
  try {
    const w = N.get('nyc.wallet', null);
    if (!w || typeof w !== 'object' || Array.isArray(w)) return;
    const txt = v => v == null || typeof v === 'object' ? '' : String(v);
    const list = v => Array.isArray(v) ? v : v == null || typeof v === 'object' ? [] : [v];
    const next = Object.assign({}, w);
    if ('names' in w) next.names = list(w.names).map(txt);
    if ('seats' in w) {
      const seats = {};
      if (w.seats && typeof w.seats === 'object' && !Array.isArray(w.seats)) {
        for (const [k, a] of Object.entries(w.seats)) {
          const b = list(a).map(txt);
          if (b.some(Boolean)) seats[k] = b;
        }
      }
      next.seats = seats;
    }
    if ('bags' in w) next.bags = N.clamp(Math.round(+w.bags) || 0, 0, 9);
    ['aa_code', 'aa_code_ret', 'hotel_code', 'hotel_name', 'hotel_address', 'notes'].forEach(f => { if (f in w) next[f] = txt(w[f]); });
    if (JSON.stringify(next) !== JSON.stringify(w)) N.set('nyc.wallet', next);
  } catch (e) { /* storage blocked: N.wallet() falls back to an empty wallet */ }
})();

const W = {d: null, raw: {seats: {}}, edit: {}, show: {}, err: {}, timers: {}, saveT: 0, savedT: 0, dirty: false, ask: false, jump: ''};

function initDraft() {
  const w = N.wallet();
  const names = (Array.isArray(w.names) ? w.names : []).map(s => str(s).slice(0, 40));
  const seats = {};
  if (w.seats && typeof w.seats === 'object') {
    for (const [k, a] of Object.entries(w.seats)) seats[k] = (Array.isArray(a) ? a : []).map(s => str(s));
  }
  Object.values(W.timers).forEach(clearTimeout);
  clearTimeout(W.saveT);
  W.d = {
    names: names.length ? names : ['', ''],
    seats,
    bags: N.clamp(Math.round(+w.bags || 0), 0, 9),
    aa_code: str(w.aa_code), aa_code_ret: str(w.aa_code_ret), hotel_code: str(w.hotel_code),
    hotel_name: str(w.hotel_name), hotel_address: str(w.hotel_address), notes: str(w.notes),
  };
  W.raw = {seats: JSON.parse(JSON.stringify(seats))};
  W.edit = {}; W.show = {}; W.err = {}; W.timers = {}; W.dirty = false; W.ask = false;
}

const lastFilled = a => { for (let i = (a || []).length - 1; i >= 0; i--) if (a[i]) return i; return -1; };
const seatCount = () => Math.max(1, W.d.names.length, ...Object.values(W.d.seats).map(a => lastFilled(a) + 1),
  ...Object.values(W.raw.seats).map(a => lastFilled(a) + 1));
const firstOf = n => str(n).trim().split(/\s+/)[0] || '';
const seatLabel = i => {
  const n = str(W.d.names[i]).trim(), f = firstOf(n);
  if (!n) return `Traveler ${i + 1}`;
  const twin = W.d.names.some((o, j) => j !== i && firstOf(o).toLowerCase() === f.toLowerCase());
  return twin ? n : f;
};

function cleanNames() {
  const a = W.d.names.map(s => str(s).trim().slice(0, 40));
  const need = Math.max(0, ...Object.values(W.d.seats).map(x => lastFilled(x) + 1));
  while (a.length > need && !a[a.length - 1]) a.pop();
  return a;
}
function cleanSeats(cur) {
  const out = Object.assign({}, cur.seats && typeof cur.seats === 'object' ? cur.seats : {});
  for (const [k, a] of Object.entries(W.d.seats)) {
    const b = Array.from({length: (a || []).length}, (_, i) => a[i] || '');
    while (b.length && !b[b.length - 1]) b.pop();
    if (b.length) out[k] = b; else delete out[k];
  }
  return out;
}
function queueSave() {
  W.dirty = true;
  clearTimeout(W.saveT);
  W.saveT = setTimeout(flush, 450);
}
function flush() {
  clearTimeout(W.saveT);
  if (!W.dirty || !W.d) return;
  W.dirty = false;
  const cur = N.wallet();
  const next = Object.assign({}, cur, {
    names: cleanNames(), seats: cleanSeats(cur), bags: W.d.bags,
    aa_code: W.d.aa_code, aa_code_ret: W.d.aa_code_ret, hotel_code: W.d.hotel_code,
    hotel_name: W.d.hotel_name.trim().slice(0, 80), hotel_address: W.d.hotel_address.trim().slice(0, 160),
    notes: W.d.notes.slice(0, 1000),
  });
  if (JSON.stringify(next) === JSON.stringify(cur)) return;
  N.setWallet(next);
  const ok = JSON.stringify(N.wallet()) === JSON.stringify(next);
  savedNote(ok);
  if (ok) syncBadge();
}
// The top bar's "Wallet is empty" dot, if the shell still draws one. This screen is
// static, so the shell doesn't repaint the bar on save: drop the dot once something is saved.
function syncBadge() {
  const dot = N.$('.tb .av .bdg');
  if (!dot) return;
  const w = N.wallet();
  if (w.aa_code || (w.names || []).length) dot.remove();
}
function savedNote(ok) {
  const el = document.getElementById('wl-saved');
  if (!el) { if (!ok) N.toast('Couldn’t save: this phone’s storage is full or blocked'); return; }
  el.innerHTML = String(ok ? h`${icon('check')}<span>Saved</span>` : h`${icon('alert-triangle')}<span>Couldn’t save: storage is full or blocked</span>`);
  el.classList.toggle('bad', !ok);
  el.classList.add('on');
  clearTimeout(W.savedT);
  W.savedT = setTimeout(() => el.classList.remove('on'), ok ? 1600 : 4000);
}

// ---------- code tiles: masked, input, or a quiet "add" row ----------
const mask = v => '••••' + str(v).slice(-2);
function codeTile(f) {
  const m = CODES[f], v = W.d[f];
  const editing = W.edit[f] || (!v && !m.optional);
  if (!editing && !v) {
    return h`<button class="wl-addrow" id="wl-c-${f}" data-act="wedit" data-arg="${f}">
      <span class="wl-addic">${icon(m.ic)}</span><span class="grow"><b>${m.label}</b><small>${m.add}</small></span>${icon('plus')}</button>`;
  }
  if (!editing) {
    const shown = !!W.show[f];
    return h`<div class="wl-code" id="wl-c-${f}">
      <div class="grow"><small>${m.label}</small>${shown
        ? h`<span class="wl-cv tn">${v}</span>`
        : h`<span class="wl-cv tn" aria-hidden="true">${mask(v)}</span><span class="sr">Hidden, ends in ${str(v).slice(-2).split('').join(' ')}</span>`}</div>
      <button class="wl-cb" data-act="wpeek" data-arg="${f}" aria-label="${shown ? 'Hide' : 'Show for 15 seconds'}" aria-pressed="${pressed(shown)}">${icon(shown ? 'eye-off' : 'eye')}</button>
      <button class="wl-cb" data-act="wcopy" data-arg="${f}" aria-label="Copy ${m.label}">${icon('copy')}</button>
      <button class="wl-cb" data-act="wedit" data-arg="${f}" aria-label="Change ${m.label}">${icon('pencil')}</button>
    </div>`;
  }
  const msg = W.err[f] || '';
  const val = W.raw[f] != null ? W.raw[f] : v;
  return h`<div class="wl-ed" id="wl-c-${f}">
    <label class="fld" for="wl-in-${f}"><span>${m.label}</span></label>
    <div class="wl-inrow"><input class="inp wl-up${msg ? ' bad' : ''}" id="wl-in-${f}" type="text" data-input="wf" data-f="${f}" value="${val}"
      maxlength="${m.max}" placeholder="${m.ph}" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false"
      inputmode="text" enterkeyhint="done" aria-describedby="wl-e-${f}${m.hint ? ` wl-h-${f}` : ''}"${attr(msg, ' aria-invalid="true"')}>
      ${v || m.optional ? h`<button class="ibtn wl-ib" data-act="wdone" data-arg="${f}" aria-label="Done">${icon('check')}</button>` : ''}</div>
    <div class="err" id="wl-e-${f}" role="alert"${attr(!msg, ' hidden')}>${msg}</div>
    ${m.hint ? h`<div class="wl-hint" id="wl-h-${f}">${m.hint}</div>` : ''}
  </div>`;
}
function paintCode(f) {
  const el = document.getElementById('wl-c-' + f);
  if (el) { try { el.outerHTML = String(codeTile(f)); } catch (e) { N.report(e, 'wallet.js code'); } }
}
function setErr(key, msg, input, box) {
  W.err[key] = msg || '';
  if (input) { input.classList.toggle('bad', !!msg); if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
  if (box) { box.textContent = msg || ''; box.hidden = !msg; }
}
function onCode(el, f, final) {
  const m = CODES[f];
  const r = m.check(el.value, final);
  W.raw[f] = el.value;
  W.edit[f] = true;
  if (r.ok && W.d[f] !== r.v) { W.d[f] = r.v; queueSave(); }
  const msg = r.msg ? (final ? `Not saved. ${r.msg}` : r.msg) : '';
  setErr(f, msg, el, document.getElementById('wl-e-' + f));
  if (final) {
    if (r.ok && r.v && el.value !== r.v) el.value = r.v;
    clearTimeout(W.timers['exit:' + f]);
    // Fold back to the masked tile once focus has really left (a tap on Done lands first).
    W.timers['exit:' + f] = setTimeout(() => {
      const inp = document.getElementById('wl-in-' + f);
      if (!inp || document.activeElement === inp) return;
      const rr = m.check(inp.value, true);
      if (rr.ok && (W.d[f] || m.optional)) { flush(); W.edit[f] = false; delete W.raw[f]; paintCode(f); }
    }, 300);
  }
}
function onSeat(el, final) {
  const leg = el.dataset.leg, i = +el.dataset.i;
  if (!leg || !(i >= 0)) return;
  const r = checkSeat(el.value, final);
  (W.raw.seats[leg] = W.raw.seats[leg] || [])[i] = el.value;
  if (r.ok) {
    const a = (W.d.seats[leg] = W.d.seats[leg] || []);
    if ((a[i] || '') !== r.v) { a[i] = r.v; queueSave(); }
    if (final && r.v && el.value !== r.v) el.value = r.v;
  }
  W.err[`seat:${leg}:${i}`] = r.msg ? (final ? `Not saved. ${r.msg}` : r.msg) : '';
  el.classList.toggle('bad', !!r.msg);
  if (r.msg) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
  legErr(leg);
}
function legErr(leg) {
  const box = document.getElementById('wl-e-seat-' + leg);
  if (!box) return;
  const msg = Object.entries(W.err).filter(([k, v]) => v && k.startsWith(`seat:${leg}:`)).map(([, v]) => v)[0] || '';
  box.textContent = msg; box.hidden = !msg;
}
function onField(el, ev) {
  if (!W.d) return;
  const f = el.dataset.f, final = ev.type === 'change';
  if (CODES[f]) { onCode(el, f, final); return; }
  if (f === 'seat') { onSeat(el, final); return; }
  if (f === 'name') {
    const i = +el.dataset.i;
    if (!(i >= 0) || i >= W.d.names.length) return;
    W.d.names[i] = el.value.slice(0, 40);
    N.$$('[data-seatlbl]').forEach(s => { s.textContent = seatLabel(+s.dataset.seatlbl); });
    queueSave();
    return;
  }
  if (f === 'hotel_name' || f === 'hotel_address' || f === 'notes') { W.d[f] = el.value; queueSave(); }
}

// ---------- wallet sections ----------
function bookingHtml() {
  return h`<div class="stack8">${codeTile('aa_code')}${codeTile('aa_code_ret')}</div>
    <a class="wl-link" href="https://www.aa.com/reservation/view/find-your-trip" target="_blank" rel="noopener">${icon('external-link')}Look up the booking on aa.com</a>`;
}
function peopleHtml() {
  const n = W.d.names;
  return h`${n.length ? h`<div class="stack8">${n.map((v, i) => h`<div class="wl-name">
      <label class="sr" for="wl-nm-${i}">Traveler ${i + 1} name</label>
      <input class="inp" id="wl-nm-${i}" type="text" data-input="wf" data-f="name" data-i="${i}" value="${v}" maxlength="40"
        placeholder="Traveler ${i + 1}" autocomplete="off" autocapitalize="words" autocorrect="off" spellcheck="false" enterkeyhint="done">
      <button class="ibtn wl-ib" data-act="wrm" data-arg="${i}" aria-label="Remove traveler ${i + 1}">${icon('x')}</button></div>`)}</div>` : ''}
    ${n.length < MAX_PEOPLE ? h`<button class="btn alt wl-wide wl-add" data-act="wadd">${icon('plus')}Add traveler</button>` : ''}
    <div class="wl-hint">First names are enough. They label the seats below.</div>`;
}
function seatsHtml() {
  const ls = legs();
  if (!ls.length) {
    return h`<div class="co plain">${icon('info-circle')}<span>${N.data.trip ? 'This trip has no flights listed yet.' : 'Seats can be added once the trip has loaded on this phone.'}</span></div>`;
  }
  const n = seatCount();
  return h`${ls.map(l => {
    const err = Object.entries(W.err).filter(([k, v]) => v && k.startsWith(`seat:${l.id}:`)).map(([, v]) => v)[0] || '';
    return h`<div class="wl-leg">
      <div class="wl-leg-h"><b>${legName(l)}</b>${legDay(l) !== '—' ? h`<span>${legDay(l)}</span>` : ''}${l.confirmed === false ? h`<span class="wl-tag">Not confirmed</span>` : ''}</div>
      <div class="wl-seats">${Array.from({length: n}, (_, i) => {
        const raw = (W.raw.seats[l.id] || [])[i];
        const val = raw != null ? raw : ((W.d.seats[l.id] || [])[i] || '');
        const bad = !!W.err[`seat:${l.id}:${i}`];
        return h`<label class="wl-seat"><span data-seatlbl="${i}">${seatLabel(i)}</span>
          <input class="inp wl-si${bad ? ' bad' : ''}" type="text" data-input="wf" data-f="seat" data-leg="${l.id}" data-i="${i}" value="${val}"
            maxlength="3" placeholder="Add seat" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false"
            inputmode="text" enterkeyhint="next" aria-describedby="wl-e-seat-${l.id}"${attr(bad, ' aria-invalid="true"')}></label>`;
      })}</div>
      <div class="err" id="wl-e-seat-${l.id}" role="alert"${attr(!err, ' hidden')}>${err}</div>
    </div>`;
  })}`;
}
function bagsHtml() {
  const b = W.d.bags;
  let note = 'Carry-on only, so there’s no bag drop deadline.';
  if (b > 0) {
    const now = N.now().getTime();
    const lv = ['out', 'ret'].map(leave).find(x => x && x.leg && x.leg.dep && T(x.leg.dep.time) > now);
    note = lv
      ? `Bag drop closes ${N.AA.bagdrop} min before departure: ${N.time(lv.bagdrop, lv.leg.from)} at ${lv.leg.from} on ${N.date(lv.leg.dep.time, lv.leg.from)}.`
      : `AA bag drop closes ${N.AA.bagdrop} min before departure.`;
  }
  return h`${stepper('wbags', b, b === 1 ? 'checked bag' : 'checked bags', 'One fewer bag', 'One more bag', b > 0, b < 9)}
    <div class="wl-hint">${note}</div>`;
}
function hotelHtml() {
  const th = N.data.trip && N.data.trip.hotel;
  const top = th
    ? h`<div class="rw c wl-th"><span class="ic">${icon('building')}</span><div class="grow"><b>${th.name || 'Hotel'}</b>${th.address ? h`<small>${th.address}</small>` : ''}<small>From the trip plan</small></div></div>`
    : h`<div class="stack8">
        <div><label class="fld" for="wl-hn"><span>Hotel name</span></label>
          <input class="inp" id="wl-hn" type="text" data-input="wf" data-f="hotel_name" value="${W.d.hotel_name}" maxlength="80"
            placeholder="As it appears on the booking" autocomplete="off" autocapitalize="words" autocorrect="off" spellcheck="false" enterkeyhint="next"></div>
        <div><label class="fld" for="wl-ha"><span>Street address</span></label>
          <input class="inp" id="wl-ha" type="text" data-input="wf" data-f="hotel_address" value="${W.d.hotel_address}" maxlength="160"
            placeholder="Number, street, New York" autocomplete="off" autocapitalize="words" autocorrect="off" spellcheck="false" enterkeyhint="done"
            aria-describedby="wl-ha-h">
          <div class="wl-hint" id="wl-ha-h">Used for directions to the hotel.</div></div>
      </div>`;
  return h`${top}<div class="wl-gap">${codeTile('hotel_code')}</div>`;
}
function notesHtml() {
  return h`<label class="sr" for="wl-nt">Notes</label>
    <textarea class="inp wl-ta" id="wl-nt" data-input="wf" data-f="notes" rows="4" maxlength="1000" autocomplete="off" autocapitalize="sentences"
      placeholder="Room number, check-in time, anything you want handy">${W.d.notes}</textarea>
    <div class="wl-info">${icon('info-circle')}<span>Don’t add passport, PreCheck or card numbers here.</span></div>`;
}
function clearHtml() {
  if (!W.ask) return h`<button class="btn alt wl-wide wl-clr" data-act="wclear">${icon('trash')}Clear Wallet</button>`;
  return h`<div class="wl-confirm" role="group" aria-labelledby="wl-cq">
    <b id="wl-cq">Clear everything in Wallet?</b>
    <p>Codes, travelers, seats, bags, hotel details and notes are deleted. There’s no backup, so this can’t be undone.</p>
    <div class="row"><button class="btn wl-cancel grow" data-act="wclear-no">Cancel</button>
      <button class="btn rose grow" data-act="wclear-yes">Clear Wallet</button></div></div>`;
}

// ---------- deep links: #wallet/hotel, #wallet/seats[/<leg id>], #wallet/clear ----------
// Scroll the section under the top bar, flash it once and focus its first empty field.
const DEEP = {hotel: 'wl-hotel', seats: 'wl-seats', clear: 'wl-clear'};
function jumpField(box, kind, leg) {
  if (kind === 'clear') return N.$('button', box);
  const all = N.$$(kind === 'seats' ? 'input[data-f="seat"]' : 'input', box);
  const mine = leg ? all.filter(i => i.dataset.leg === leg) : [];
  const pool = mine.length ? mine : all;
  return pool.find(i => !i.value) || pool[0] || N.$('button', box);
}
function jumpTo(param, view) {
  const [kind, leg] = str(param).split('/');
  const box = DEEP[kind] && document.getElementById(DEEP[kind]);
  const part = box && box.closest('section');
  if (!part || !view) return;
  // offsetTop ignores the entrance transforms that getBoundingClientRect would include.
  let y = 0;
  for (let n = part; n && n !== view; n = n.offsetParent) y += n.offsetTop;
  const head = ['.tb', '#strip'].reduce((a, q) => a + ((N.$(q, view) || {}).offsetHeight || 0), 0);
  const top = Math.max(0, Math.min(y - head - 12, view.scrollHeight - view.clientHeight));
  try { view.scrollTo({top, behavior: N.reduce ? 'auto' : 'smooth'}); } catch (e) { view.scrollTop = top; }
  const f = jumpField(box, kind, leg);
  if (f) f.focus({preventScroll: true});
  part.classList.remove('wl-flash'); void part.offsetWidth; part.classList.add('wl-flash');
  clearTimeout(W.timers.flash);
  W.timers.flash = setTimeout(() => part.classList.remove('wl-flash'), 1600);
}

const walletDef = {
  back: 'today', nav: false, static: true, uses: ['trip'], title: 'Wallet',
  render(ctx) {
    const rise = firstPaint();
    if (rise) W.jump = ctx && ctx.param || '';
    initDraft();
    return {
      hero: bar('Codes, seats and notes', 'lock', 'Wallet', 'Saved only on this phone.'),
      body: h`<div class="wl wl-w">
        ${sec('wl-booking', '', bookingHtml(), 0, rise)}
        ${sec('wl-people', 'Travelers', peopleHtml(), 1, rise)}
        ${sec('wl-seats', 'Seats', seatsHtml(), 2, rise)}
        ${sec('wl-bags', 'Checked bags', bagsHtml(), 3, rise)}
        ${sec('wl-hotel', 'Hotel', hotelHtml(), 4, rise)}
        ${sec('wl-notes', 'Notes', notesHtml(), 5, rise)}
        ${sec('wl-clear', '', clearHtml(), 6, rise)}
        <div class="wl-saved" id="wl-saved" role="status" aria-live="polite"></div>
      </div>`,
    };
  },
  mount(ctx, view) {
    const onKey = ev => {
      if (ev.key !== 'Enter' || ev.isComposing) return;
      const t = ev.target;
      if (!t || t.tagName !== 'INPUT' || !t.dataset || !t.dataset.f) return;
      ev.preventDefault();
      if (t.dataset.f === 'seat') {
        const all = N.$$('input[data-f="seat"]', view), nx = all[all.indexOf(t) + 1];
        if (nx) nx.focus(); else t.blur();
      } else t.blur();
    };
    const onVis = () => { if (document.hidden) flush(); };
    view.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', flush);
    // #wallet/hotel and friends: wait for the router to set its own scroll first.
    const jt = W.jump ? setTimeout(() => { const p = W.jump; W.jump = ''; jumpTo(p, view); }, 0) : 0;
    // Seats and hotel depend on the trip file, which can arrive after this screen opened.
    const off = N.on('data', name => {
      if (name !== 'trip') return;
      const a = document.activeElement;
      [['wl-seats', seatsHtml], ['wl-hotel', hotelHtml], ['wl-bags', bagsHtml]].forEach(([id, fn]) => {
        const box = document.getElementById(id);
        if (box && !(a && box.contains(a))) fill(id, fn);
      });
    });
    return () => {
      clearTimeout(jt);
      flush();
      view.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', flush);
      off();
      Object.values(W.timers).forEach(clearTimeout);
      W.timers = {};
      clearTimeout(W.savedT);
    };
  },
  actions: {
    wf: (el, ev) => onField(el, ev),
    wedit(el, ev, ctx, f) {
      if (!CODES[f] || !W.d) return;
      W.edit[f] = true; W.show[f] = false; W.raw[f] = W.d[f]; W.err[f] = '';
      clearTimeout(W.timers['peek:' + f]);
      paintCode(f);
      const inp = document.getElementById('wl-in-' + f);
      if (inp) { inp.focus(); try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) { /* not a text input */ } }
    },
    wdone(el, ev, ctx, f) {
      if (!CODES[f] || !W.d) return;
      const inp = document.getElementById('wl-in-' + f);
      clearTimeout(W.timers['exit:' + f]);
      if (inp) {
        const r = CODES[f].check(inp.value, true);
        if (!r.ok) { setErr(f, `Not saved. ${r.msg}`, inp, document.getElementById('wl-e-' + f)); inp.focus(); return; }
        if (W.d[f] !== r.v) { W.d[f] = r.v; W.dirty = true; }
      }
      flush();
      W.edit[f] = false; delete W.raw[f]; W.err[f] = '';
      paintCode(f);
    },
    wpeek(el, ev, ctx, f) {
      if (!CODES[f] || !W.d) return;
      W.show[f] = !W.show[f];
      clearTimeout(W.timers['peek:' + f]);
      if (W.show[f]) W.timers['peek:' + f] = setTimeout(() => { W.show[f] = false; if (!W.edit[f]) paintCode(f); }, 15000);
      paintCode(f);
      refocus(`#wl-c-${f} [data-act="wpeek"]`);
    },
    async wcopy(el, ev, ctx, f) {
      if (!CODES[f]) return;
      const v = str(N.wallet()[f]);
      if (!v) return;
      try { await navigator.clipboard.writeText(v); N.toast('Copied'); }
      catch (e) { N.toast('Couldn’t copy. Tap the eye to show it instead.'); }
    },
    wadd() {
      if (!W.d || W.d.names.length >= MAX_PEOPLE) return;
      W.d.names.push('');
      fill('wl-people', peopleHtml);
      fill('wl-seats', seatsHtml);
      const inp = document.getElementById('wl-nm-' + (W.d.names.length - 1));
      if (inp) inp.focus();
    },
    wrm(el, ev, ctx, arg) {
      const i = +arg;
      if (!W.d || !(i >= 0) || i >= W.d.names.length) return;
      W.d.names.splice(i, 1);
      [W.d.seats, W.raw.seats].forEach(o => Object.values(o).forEach(a => { if (Array.isArray(a) && a.length > i) a.splice(i, 1); }));
      Object.keys(W.err).forEach(k => { if (k.startsWith('seat:')) delete W.err[k]; });
      W.dirty = true;
      flush();
      fill('wl-people', peopleHtml);
      fill('wl-seats', seatsHtml);
      // The toast already says it's done; don't stack the "Saved" pill under it (a failed save still shows).
      const sv = document.getElementById('wl-saved');
      if (sv && !sv.classList.contains('bad')) { clearTimeout(W.savedT); sv.classList.remove('on'); }
      N.toast('Traveler and their seats removed');
    },
    wbags(el, ev, ctx, arg) {
      if (!W.d) return;
      const b = N.clamp(W.d.bags + (+arg || 0), 0, 9);
      if (b === W.d.bags) return;
      W.d.bags = b; W.dirty = true;
      flush();
      fill('wl-bags', bagsHtml);
      refocus(`#wl-bags [data-arg="${+arg > 0 ? 1 : -1}"]`);
    },
    wclear() {
      W.ask = true;
      const box = fill('wl-clear', clearHtml);
      refocus('#wl-clear [data-act="wclear-no"]');
      if (box && box.scrollIntoView) box.scrollIntoView({block: 'nearest', behavior: N.reduce ? 'auto' : 'smooth'});
    },
    'wclear-no'() {
      W.ask = false;
      fill('wl-clear', clearHtml);
    },
    'wclear-yes'() {
      clearTimeout(W.saveT);
      W.dirty = false;
      N.setWallet({});
      // Repaint the body here (listeners live on #view and document, so mount's work stays valid).
      const body = N.$('#body');
      if (body) { try { body.innerHTML = String(walletDef.render().body); } catch (e) { N.report(e, 'wallet.js clear'); } }
      syncBadge();
      const v = N.$('#view');
      if (v) { try { v.scrollTo({top: 0, behavior: 'instant'}); } catch (e) { v.scrollTop = 0; } }
      N.toast('Wallet cleared');
    },
  },
};
N.screen('wallet', walletDef);

// =====================================================================
// Settings
// =====================================================================
const S = {ask: false};
function themeHtml() {
  const t = N.theme();
  const sys = matchMedia('(prefers-color-scheme: dark)').matches;
  const b = (k, ic, label) => h`<button data-act="theme" data-arg="${k}" aria-pressed="${pressed(t === k)}">${icon(ic)}${label}</button>`;
  const note = t === 'dark' ? 'Always dark.' : t === 'light' ? 'Always light.' : `Matches your iPhone, ${sys ? 'dark' : 'light'} right now.`;
  return h`<div class="seg wl-seg" role="group" aria-label="Theme">${b('auto', 'circle-half-2', 'Auto')}${b('light', 'sun', 'Light')}${b('dark', 'moon', 'Dark')}</div>
    <p class="help">${note}</p>`;
}
function leaveLine(lv, from, buf) {
  const ap = lv.leg.from;
  const reach = N.addMin(lv.at, lv.drive);
  const ahead = N.mins(reach, lv.leg.dep.time);
  const drive = lv.source === 'traffic' ? `${lv.drive} min drive (with traffic)` : `${lv.drive} min drive`;
  return h`<div class="wl-lv"><b>${N.date(lv.at, ap)}: leave ${from} at <span class="tn">${N.time(lv.at, ap)}</span></b>
    <span>${buf ? `That’s ${buf} min earlier than the plan. ` : ''}A ${drive} gets you to ${ap} at ${N.time(reach, ap)}, ${N.dur(ahead)} before ${lv.leg.flight} leaves at ${N.time(lv.leg.dep.time, ap)}.</span></div>`;
}
function bufHtml() {
  const b = N.clamp(+N.prefs().leave_buffer || 0, 0, 60);
  const now = N.now().getTime();
  const ahead = lv => lv && lv.leg && lv.leg.dep && T(lv.leg.dep.time) > now;
  const out = leave('out'), ret = leave('ret');
  const rows = [];
  if (!N.data.trip) rows.push(h`<p class="help">Leave times show here once the trip loads.</p>`);
  else {
    if (ahead(out)) rows.push(leaveLine(out, 'home', b));
    // Flights home still to come, by their date at the departure airport (they may have no times yet).
    const retDue = safe(() => N.dirLegs('ret'), []).some(l => !l.date || l.date >= N.ymd(N.now(), l.from || 'NYC'));
    if (ahead(ret)) rows.push(leaveLine(ret, 'the hotel', b));
    else if (!ret && retDue) rows.push(h`<p class="help">The flights home have no times yet. This extra time applies to them too.</p>`);
    if (!rows.length) rows.push(h`<p class="help">${legs().length ? 'No flights left on this trip.' : 'No flights on this trip yet.'}</p>`);
  }
  return h`${stepper('sbuf', b ? `+${b} min` : 'None', b ? 'added to every leave time' : 'leave at the planned time', '5 minutes less', '5 minutes more', b > 0, b < 60)}
    <div class="wl-col wl-gap">${rows}</div>`;
}
function lockHtml() {
  const off = !N.online();
  if (!S.ask) {
    return h`${off ? h`<div class="co rose">${icon('wifi-off')}<span>You’re offline. Once locked, you can’t unlock until you have signal.</span></div>` : ''}
      <button class="btn alt wl-wide${off ? ' wl-gap' : ''}" data-act="slock">${icon('lock')}Lock this phone</button>
      <p class="help">Locking hides your trip until you enter the passphrase again.</p>`;
  }
  return h`<div class="wl-confirm" role="group" aria-labelledby="wl-lq">
    <b id="wl-lq">Lock nyc. on this phone?</b>
    <p>You’ll need the trip passphrase${off ? ' and a connection' : ''} to get back in.</p>
    <div class="row"><button class="btn wl-cancel grow" data-act="slock-no">Cancel</button>
      <button class="btn rose grow" data-act="slock-yes">Lock now</button></div></div>`;
}
function appHtml() {
  return h`<button class="btn alt wl-wide" data-act="reload">${icon('refresh')}Reload now</button>
    <p class="help">Updates install by themselves the next time you switch away from the app.</p>`;
}
const verHtml = () => h`<p class="wl-ver tn">Version ${str(N.cfg && N.cfg.build).slice(0, 7) || 'dev'}</p>`;
// Lock-screen alerts are set up on #alerts (alerts.js). This row shows their state in one word.
function alertsHtml() {
  const w = N.alerts ? N.alerts.word() : 'Off';
  return h`<a class="wl-card rw c al-row" href="#alerts"><span class="ic">${icon(w === 'Off' ? 'bell-off' : 'bell')}</span>
    <div class="grow"><b>Lock-screen alerts</b><small>Gate changes and delays</small></div>
    <span class="al-w ${w.toLowerCase()}">${w}</span>${icon('chevron-right')}</a>`;
}
function settingsUpdate() {
  fill('wl-s-theme', themeHtml);
  fill('wl-s-al', alertsHtml);
  fill('wl-s-buf', bufHtml);
  fill('wl-s-lock', lockHtml);
}
N.screen('settings', {
  back: 'today', nav: false, uses: ['trip', 'guide', 'status'], title: 'Settings',
  render() {
    const rise = firstPaint();
    if (rise) S.ask = false;
    return {
      hero: bar('This phone', 'settings', 'Settings'),
      body: h`<div class="wl wl-s">
        ${sec('wl-s-theme', 'Theme', themeHtml(), 0, rise)}
        ${sec('wl-s-al', 'Alerts', alertsHtml(), 1, rise)}
        ${sec('wl-s-buf', 'Leave time', bufHtml(), 2, rise)}
        ${sec('wl-s-lock', 'Lock', lockHtml(), 3, rise)}
        ${sec('wl-s-app', 'App', appHtml(), 4, rise)}
        ${verHtml()}
      </div>`,
    };
  },
  update: settingsUpdate,
  mount() {
    // Auto follows the iPhone's appearance, so keep the note under the theme buttons true.
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => fill('wl-s-theme', themeHtml);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  },
  actions: {
    theme(el, ev, ctx, arg) {
      N.setTheme(arg);
      settingsUpdate();
      refocus(`#wl-s-theme [data-arg="${arg}"]`);
    },
    sbuf(el, ev, ctx, arg) {
      const b = N.clamp((+N.prefs().leave_buffer || 0) + (+arg > 0 ? 5 : -5), 0, 60);
      N.setPrefs({leave_buffer: b});
      settingsUpdate();
      refocus(`#wl-s-buf [data-arg="${+arg > 0 ? 1 : -1}"]`);
    },
    slock() { S.ask = true; fill('wl-s-lock', lockHtml); refocus('#wl-s-lock [data-act="slock-no"]'); },
    'slock-no'() { S.ask = false; fill('wl-s-lock', lockHtml); },
    async 'slock-yes'() { S.ask = false; await N.lock(); },
  },
});

// =====================================================================
// Data & offline
// =====================================================================
const JOBS = {photos: {running: false}, tiles: {running: false}};
const PLAN_KEY = 'nyc.offline';   // when photos/maps were last saved (no Wallet data)
const TILE_CAP = 2500;
const STALL_MS = 60000;      // no progress for this long and a save is treated as stopped
// Areas to keep, as [south, west, north, east] and a zoom range.
const AREAS = [
  {b: [40.63, -74.09, 40.835, -73.85], z: [11, 13]},     // all of NYC, zoomed out (matches data/basemap.json)
  {b: [40.698, -74.022, 40.882, -73.906], z: [14, 15]},  // Manhattan
  {b: [40.738, -73.955, 40.79, -73.852], z: [14, 15]},   // LaGuardia and the drive into Manhattan
];
const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
const okLL = p => p && Number.isFinite(+p.lat) && Number.isFinite(+p.lon) && Math.abs(+p.lat) < 85;
function addBox(set, [s, w, n, e], z0, z1) {
  for (let z = z0; z <= z1; z++) {
    for (let x = lon2x(w, z); x <= lon2x(e, z); x++) for (let y = lat2y(n, z); y <= lat2y(s, z); y++) set.add(`${z}/${x}/${y}`);
  }
}
function addAround(set, lat, lon, z, r) {
  const x0 = lon2x(lon, z), y0 = lat2y(lat, z);
  for (let x = x0 - r; x <= x0 + r; x++) for (let y = y0 - r; y <= y0 + r; y++) set.add(`${z}/${x}/${y}`);
}
// Carto's tiles need a key: without one every tile is an "API key required"
// card, so the maps draw land, parks and main roads from data/basemap.json
// and never ask for tiles (the same rule as place.js, food.js and transit.js).
// Only offer to save tiles once a map would actually show them.
const tilesOk = t => !!(t && typeof t.url === 'string' && t.url && (!/basemaps\.cartocdn\.com/.test(t.url) || /[?&](api_?key|key|token)=/i.test(t.url)));
const tilesUsable = () => safe(() => tilesOk(N.tiles(false)), false);
// The same URLs Leaflet asks for: N.tiles() template, its subdomain rule and the @2x retina suffix.
function tileUrl(key, dark) {
  const [z, x, y] = key.split('/').map(Number);
  const t = N.tiles(dark), subs = (t.opts && t.opts.subdomains) || 'abc';
  const retina = (window.devicePixelRatio || 1) > 1 ? '@2x' : '';
  return t.url.replace('{s}', subs[Math.abs(x + y) % subs.length]).replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{r}', retina);
}
let tileMemo = null;
function tilePlan() {
  const dark = N.isDark();
  const hotel = safe(() => N.hotel(), null);
  const places = safe(() => N.food.places(), []);
  const key = `${dark}|${okLL(hotel) ? hotel.lat + ',' + hotel.lon : ''}|${places.length}`;
  if (tileMemo && tileMemo.key === key) return tileMemo;
  const per = dark ? Math.floor(TILE_CAP / 2) : TILE_CAP;
  const set = new Set();
  AREAS.forEach(a => addBox(set, a.b, a.z[0], a.z[1]));
  if (okLL(hotel)) { addAround(set, +hotel.lat, +hotel.lon, 15, 2); addAround(set, +hotel.lat, +hotel.lon, 14, 1); }
  let food = 0;
  for (const p of places) {
    if (!okLL(p)) continue;
    const trial = new Set(set);
    addAround(trial, +p.lat, +p.lon, 15, 1);
    addAround(trial, +p.lat, +p.lon, 14, 0);
    if (trial.size > per) break;
    trial.forEach(k => set.add(k));
    food++;
  }
  const keys = [...set];
  const urls = keys.map(k => tileUrl(k, false)).concat(dark ? keys.map(k => tileUrl(k, true)) : []);
  // Rough sizes of Carto @2x PNGs in Manhattan: about 30 KB light, 20 KB dark.
  const bytes = keys.length * 30e3 + (dark ? keys.length * 20e3 : 0);
  tileMemo = {key, urls, count: urls.length, bytes, dark, food, hotel: okLL(hotel)};
  return tileMemo;
}
function photoPlan() {
  const urls = safe(() => N.food.offlineUrls(6), []);
  const places = safe(() => N.food.places(), []).length;
  const thumbs = urls.filter(u => /\/348s\.jpg$/.test(u)).length;
  return {urls, count: urls.length, places, bytes: thumbs * 20e3 + (urls.length - thumbs) * 70e3};
}
function jobHtml(k) {
  const j = JOBS[k];
  const tiles = k === 'tiles';
  // Without a tile key the maps draw from a file shipped with the app, so there is nothing to save.
  if (tiles && !tilesUsable()) return '';
  const plan = tiles ? tilePlan() : photoPlan();
  const last = (N.get(PLAN_KEY, {}) || {})[k];
  const z = zone();
  const desc = tiles
    ? `Street detail for ${[ 'Manhattan', 'LaGuardia', 'the drive between them', plan.hotel && 'your hotel’s blocks', plan.food && 'the food list’s neighborhoods' ].filter(Boolean).join(', ').replace(/, ([^,]*)$/, ' and $1')}, plus all of NYC zoomed out. ${fmtN(plan.count)} map tiles, about ${mbText(plan.bytes)}.`
    : plan.count ? `${fmtN(plan.count)} photos from ${N.plural(plan.places, 'place')}, about ${mbText(plan.bytes)}.` : 'The food list hasn’t loaded on this phone yet.';
  const extra = tiles ? (plan.dark ? 'Includes the dark map.' : 'Light map only. Save again in dark mode to add the dark map.') : '';
  let status = '', pct = null;
  if (j.running) {
    pct = j.total ? j.done / j.total : 0;
    status = `Saving ${fmtN(j.done)} of ${fmtN(j.total)}…`;
  } else if (j.msg === 'nosw') {
    status = 'Open nyc. from your Home Screen to save for offline.';
  } else if (j.msg === 'none') {
    status = 'Nothing to save yet.';
  } else if (j.msg === 'stalled') {
    const got = Math.max(0, j.done - j.failed);
    pct = j.total ? got / j.total : 0;
    status = `Stopped at ${fmtN(got)} of ${fmtN(j.total)} when the connection dropped. What’s saved stays saved.`;
  } else if (last && last.total) {
    const got = Math.max(0, (last.done || 0) - (last.failed || 0));
    pct = got / last.total;
    status = `Saved ${when(last.at, z)}: ${fmtN(got)} of ${fmtN(last.total)}.${last.failed ? ` ${fmtN(last.failed)} missed. Try again with better signal.` : ''}`;
  }
  const off = !N.online();
  const disabled = j.running || off || !plan.count;
  const label = j.running ? 'Saving…' : off ? 'Needs a connection' : j.msg === 'stalled' ? 'Carry on saving' : last ? (tiles ? 'Save maps again' : 'Save photos again') : (tiles ? 'Save NYC street maps' : 'Save food photos');
  return h`<div class="wl-job" id="wl-job-${k}">
    <div class="rw c"><span class="ic">${icon(tiles ? 'map-2' : 'photo')}</span><div class="grow"><b>${tiles ? 'NYC street maps' : 'Food photos'}</b><small>${desc}</small></div></div>
    ${extra ? h`<p class="help">${extra}</p>` : ''}
    ${pct != null ? h`<div class="wl-bar" role="progressbar" aria-label="${tiles ? 'Map tiles saved' : 'Photos saved'}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct * 100)}"><i style="width:${Math.round(pct * 100)}%"></i></div>` : ''}
    ${status ? h`<p class="help" role="status">${status}</p>` : ''}
    <button class="btn wl-wide wl-gap" data-act="dsave" data-arg="${k}"${attr(disabled, ' aria-disabled="true"')}>${icon(off ? 'wifi-off' : 'download')}${label}</button>
  </div>`;
}
const jobFrame = {};
function paintJob(k) {
  if (jobFrame[k]) return;
  const go = () => {
    jobFrame[k] = 0;
    const el = document.getElementById('wl-job-' + k);
    if (el) { try { el.outerHTML = String(jobHtml(k)); } catch (e) { N.report(e, 'wallet.js job'); } }
  };
  jobFrame[k] = window.requestAnimationFrame ? requestAnimationFrame(go) : setTimeout(go, 16);
}
async function paintUsage() {
  let u = null, bytes = null;
  try { u = N.sw && N.sw.usage ? await N.sw.usage() : null; } catch (e) { u = null; }
  if (u && u.usage != null) bytes = u.usage;
  if (bytes == null && navigator.storage && navigator.storage.estimate) {
    try { bytes = (await navigator.storage.estimate()).usage; } catch (e) { bytes = null; }
  }
  const el = document.getElementById('wl-d-use');
  if (!el) return;
  const c = u && u.counts || null;
  const maps = tilesUsable() || !!(c && c['nyc-tiles']);
  const counts = c ? ` · ${maps ? `${fmtN(c['nyc-tiles'] || 0)} map tiles and ` : ''}${fmtN(c['nyc-photos'] || 0)} photos saved` : '';
  el.innerHTML = String(bytes == null
    ? h`<span>This browser doesn’t say how much storage the app uses.</span>`
    : h`<b>Using ${mbText(bytes)} on this phone</b><span>${counts ? counts.slice(3) + '. ' : ''}The phone keeps up to ${maps ? '3,000 map tiles and ' : ''}1,600 photos; the oldest go first when that fills up.</span>`);
}

// The hero line: when flights were last checked, and a warning once that's old.
function dataSub() {
  const f = safe(() => N.fresh(), {level: 'stale'});
  if (!f.at) return 'Flight status hasn’t been checked yet.';
  const late = f.level === 'stale' && safe(() => N.phase(), 'stay') !== 'after';
  return h`Last checked ${when(f.at, zone())} (<span data-ago="${f.at}">${N.ago(f.at)}</span>).${late ? ' Gates and times may have changed.' : ''}`;
}
function freshHtml() {
  const at = safe(() => N.data.status.checked_at, null);
  const f = safe(() => N.fresh(), {level: 'stale', window: null});
  const ms = N.meta.status || {};
  const off = !N.online();
  // Same cadence the strip uses (the cloud's own run.cadence_s when it is slower): 1, 10 or 60 min.
  const due = at ? T(at) + (+f.cadence || (f.window ? 600 : 3600)) * 1000 : 0;
  const next = due > N.now().getTime() ? ` Next check about ${N.time(new Date(due).toISOString(), zone())}.` : '';
  return h`${ms.error ? h`<div class="co rose">${icon('alert-triangle')}<span>Couldn’t reach the update service (${ms.error}). Showing what this phone saved.</span></div>` : ''}
    ${off ? h`<div class="co plain${ms.error ? ' wl-gap' : ''}">${icon('wifi-off')}<span>You’re offline. Checks start again when you have signal.</span></div>` : ''}
    <button class="btn wl-wide${ms.error || off ? ' wl-gap' : ''}" data-act="refresh"${attr(off, ' aria-disabled="true"')}>${icon('refresh')}Check now</button>
    <p class="help">Flights are checked every minute in the 3 hours before takeoff, every 10 minutes on travel days and hourly otherwise.${next}</p>`;
}
const FILE_ROWS = [
  ['trip', 'plane', 'Flights & hotel', d => `${N.plural((d.legs || []).length, 'flight')}${d.updated_at ? ` · updated ${N.date(d.updated_at, 'NYC')}` : ''}`],
  ['guide', 'building-airport', 'Airport guide', d => `${N.plural(Object.keys(d.airports || {}).length, 'airport')}${d.updated ? ` · updated ${N.date(String(d.updated).length === 10 ? d.updated + 'T16:00:00Z' : d.updated, 'NYC')}` : ''}`],
  ['food', 'tools-kitchen-2', 'Food list', d => `${N.plural((d.places || []).length, 'place')}${d.collected_at ? ` · collected ${N.date(d.collected_at, 'NYC')}` : ''}`],
];
function filesHtml() {
  const z = zone();
  return h`<div class="wl-card wl-rows">${FILE_ROWS.map(([n, ic, title, fn]) => {
    const d = N.data[n], m = N.meta.files[n], err = N.meta.files[n + '_error'];
    let detail = '', src = '';
    if (d) {
      detail = safe(() => fn(d), 'Loaded');
      src = m && m.source === 'network' ? `Downloaded ${when(m.at, z)}` : m && m.source === 'saved' ? 'Opened from this phone’s copy' : '';
      if (err) src = `Latest download failed (${err}); using the saved copy`;
    } else {
      detail = 'Not on this phone yet';
      src = err ? `Download failed (${err})` : !N.online() ? 'Needs a connection to download' : 'Downloading when the app next checks';
    }
    return h`<div class="rw c wl-r"><span class="ic">${icon(ic)}</span><div class="grow"><b>${title}</b><small>${detail}</small>${src ? h`<small>${src}</small>` : ''}</div><span class="dot${d ? (err ? ' neutral' : '') : ' stale'}" aria-label="${d ? 'Saved' : 'Missing'}"></span></div>`;
  })}</div>`;
}
// What works offline depends on which trip files this phone actually has; a file that never
// downloaded is listed as missing rather than promised.
const FILE_WORKS = [['trip', 'Flights, gates and leave times, as last checked'], ['guide', 'Airport guides and transit steps'], ['food', 'Food list and opening hours']];
const hasFile = n => !!safe(() => N.data[n], null);
const WORKS = () => [...FILE_WORKS.filter(([n]) => hasFile(n)).map(([, t]) => t),
  ...(tilesUsable() ? ['Food photos and street maps you’ve saved below or already viewed']
    : ['Maps of land, parks and main roads', 'Food photos you’ve saved below or already viewed']), 'Wallet, seats and notes'];
const MISSING = () => FILE_WORKS.filter(([n]) => !hasFile(n)).map(([, t]) => t.replace(/, as last checked$/, ''));
const NEEDS = ['New gate, delay and traffic checks', 'Directions in Apple Maps'];
const lc = t => t.charAt(0).toLowerCase() + t.slice(1);
function offHtml() {
  return h`<ul class="wl-list">${WORKS().map(t => h`<li>${icon('check')}<span>${t}</span></li>`)}${MISSING().map(t => h`<li class="no">${icon('alert-triangle')}<span>Not on this phone yet: ${lc(t)}</span></li>`)}${NEEDS.map(t => h`<li class="no">${icon('wifi-off')}<span>Needs signal: ${lc(t)}</span></li>`)}</ul>
    <p class="help">For directions with no signal, download New York in Apple Maps first: tap your picture, then Offline Maps.</p>`;
}
function saveHtml() {
  return h`<div class="stack">${jobHtml('photos')}${jobHtml('tiles')}</div>
    <div class="wl-use" id="wl-d-use"><span>Checking storage…</span></div>`;
}
N.screen('data', {
  back: 'today', nav: false, uses: ['trip', 'guide', 'food', 'status'], title: 'Data & updates', keepScroll: true,
  render() {
    const rise = firstPaint();
    return {
      hero: bar('This phone', 'refresh', 'Data & updates', dataSub(), 'wl-d-sub'),
      body: h`<div class="wl wl-d">
        ${sec('wl-d-fresh', '', freshHtml(), 0, rise)}
        ${sec('wl-d-files', 'Trip files', filesHtml(), 1, rise)}
        ${sec('wl-d-off', 'With no signal', offHtml(), 2, rise)}
        ${sec('wl-d-save', 'Save for offline', saveHtml(), 3, rise)}
      </div>`,
    };
  },
  mount() {
    paintUsage();
    const off = N.on('net', () => {
      fill('wl-d-sub', dataSub);
      fill('wl-d-fresh', freshHtml);
      fill('wl-d-files', filesHtml);
      Object.keys(JOBS).forEach(k => { if (!JOBS[k].running) paintJob(k); });
    });
    return off;
  },
  update() {
    fill('wl-d-sub', dataSub);
    fill('wl-d-fresh', freshHtml);
    fill('wl-d-files', filesHtml);
    fill('wl-d-off', offHtml);
    Object.keys(JOBS).forEach(k => { if (!JOBS[k].running) paintJob(k); });
  },
  actions: {
    async dsave(el, ev, ctx, k) {
      const j = JOBS[k];
      if (!j || j.running) return;
      if (k === 'tiles' && !tilesUsable()) return;
      if (!N.online()) { N.toast('Needs a connection'); return; }
      const urls = k === 'tiles' ? tilePlan().urls : photoPlan().urls;
      if (!urls.length) { j.msg = 'none'; paintJob(k); return; }
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* not supported */ }
      const gen = (j.gen || 0) + 1;
      Object.assign(j, {running: true, done: 0, failed: 0, total: urls.length, msg: '', gen});
      paintJob(k);
      const record = (done, failed, total) => {
        const all = N.get(PLAN_KEY, {}) || {};
        all[k] = {at: N.now().toISOString(), done, failed, total};
        N.set(PLAN_KEY, all);
      };
      // The service worker posts progress as files arrive and has no timeout of its
      // own. If nothing arrives for a minute (signal gone, or iOS stopped the worker
      // while the app was in the background), stop showing "Saving…" so the button
      // works again. What it saved stays saved, and the next tap skips those files.
      let quiet = 0;
      const stall = () => {
        if (j.gen !== gen || !j.running) return;
        j.running = false; j.msg = 'stalled';
        const got = Math.max(0, j.done - j.failed);
        record(j.total, j.total - got, j.total);
        paintJob(k); paintUsage();
        N.toast('Saving stopped: the connection went quiet');
      };
      const arm = () => { clearTimeout(quiet); quiet = setTimeout(stall, STALL_MS); };
      arm();
      let res = null;
      try {
        res = N.sw && N.sw.prefetch ? await N.sw.prefetch(urls, k, m => {
          if (j.gen !== gen) return;   // a newer tap took over
          if (m && m.final) return;    // handled once the promise settles
          j.done = +m.done || 0; j.failed = +m.failed || 0; j.total = +m.total || j.total;
          if (!j.running && j.msg === 'stalled') { j.running = true; j.msg = ''; } // it picked up again
          arm();
          paintJob(k);
        }) : null;
      } catch (e) { res = null; }
      if (j.gen !== gen) return;
      clearTimeout(quiet);
      j.running = false;
      if (!res) { j.msg = 'nosw'; paintJob(k); return; }
      j.msg = '';
      const done = +res.done || j.done, failed = +res.failed || 0, total = +res.total || j.total;
      record(done, failed, total);
      paintJob(k);
      paintUsage();
      N.toast(failed ? `Saved ${fmtN(done - failed)} of ${fmtN(total)}` : k === 'tiles' ? 'Street maps saved for offline' : 'Food photos saved for offline');
    },
  },
});

// =====================================================================
// Add to Calendar
// =====================================================================
const AP = {PHX: ['Phoenix Sky Harbor International Airport', 'Phoenix'], CLT: ['Charlotte Douglas International Airport', 'Charlotte'],
  LGA: ['LaGuardia Airport', 'New York']};
const apName = c => { const g = safe(() => N.guideFor(c), null); return (g && g.name) || (AP[c] && AP[c][0]) || c; };
const apCity = c => (AP[c] && AP[c][1]) || c;
const termText = t => t && /^[A-Z0-9]{1,3}$/i.test(String(t)) ? `Terminal\u00a0${String(t).toUpperCase()}` : '';
const icsTime = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsEsc = s => str(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// RFC 5545 line folding: at most 75 octets per line, continuation lines start with a space.
function fold(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = '', n = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (n + b > 75) { out.push(cur); cur = ' '; n = 1; }
    cur += ch; n += b;
  }
  out.push(cur);
  return out.join('\r\n');
}
function calPlan() {
  const now = N.now().getTime();
  const inc = [], out = [];
  // A flight whose day has gone by at its airport, for flights with no times to go on.
  const past = l => !!l.date && l.date < N.ymd(N.now(), l.from || 'NYC');
  for (const l of legs()) {
    const dep = l.dep && l.dep.sched, arr = l.arr && l.arr.sched;
    const timed = dep && arr && Number.isFinite(T(dep)) && Number.isFinite(T(arr));
    const gone = timed ? T(arr) < now : past(l);
    if (gone) out.push({l, why: timed && l.confirmed !== false ? 'flown' : 'past'});
    else if (l.confirmed === false) out.push({l, why: 'unconfirmed'});
    else if (!timed) out.push({l, why: 'notimes'});
    else inc.push(l);
  }
  return {inc, out};
}
// One event per flight. Only flight facts go in: never names, codes or seats.
function buildIcs(list) {
  const stamp = icsTime(N.now());
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//nyc.//Trip flights//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const l of list) {
    const dT = termText(l.dep.terminal).replace(/\u00a0/g, " "), aT = termText(l.arr.terminal).replace(/\u00a0/g, " ");
    const desc = [
      `American Airlines ${l.flight}, ${apCity(l.from)} (${l.from}) to ${apCity(l.to)} (${l.to}).`,
      `Departs ${N.time(l.dep.sched, l.from)} ${apCity(l.from)} time${dT ? ` from ${dT}` : ''}. Arrives ${N.time(l.arr.sched, l.to)} ${apCity(l.to)} time${aT ? ` at ${aT}` : ''}.`,
      'Gates change often: check the nyc. app or the American Airlines app before you head to the gate.',
    ].join('\n');
    L.push('BEGIN:VEVENT',
      `UID:${icsEsc(`${l.id}-${N.ymd(l.dep.sched, l.from).replace(/-/g, '')}-${l.flight}`)}@nyc-trip`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsTime(l.dep.sched)}`,
      `DTEND:${icsTime(l.arr.sched)}`,
      `SUMMARY:${icsEsc(`${l.flight} ${l.from} → ${l.to}`)}`,
      `LOCATION:${icsEsc(`${apName(l.from)} (${l.from})${dT ? `, ${dT}` : ''}`)}`,
      `DESCRIPTION:${icsEsc(desc)}`,
      'STATUS:CONFIRMED', 'TRANSP:OPAQUE',
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(`${l.flight} to ${l.to} leaves in 24 hours`)}`, 'TRIGGER:-PT24H', 'END:VALARM',
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(`${l.flight} to ${l.to} leaves in 3 hours. Check the gate in nyc.`)}`, 'TRIGGER:-PT3H', 'END:VALARM',
      'END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}
const listText = a => a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
function leftOutText(out) {
  const by = why => out.filter(o => o.why === why).map(o => o.l);
  const rows = [];
  const un = by('unconfirmed'), nt = by('notimes'), fl = by('flown'), gone = by('past');
  const days = ls => listText([...new Set(ls.map(legDay))].filter(d => d && d !== '—'));
  if (fl.length) rows.push(`${listText(fl.map(l => l.flight || legName(l)))} already flew, so ${fl.length === 1 ? 'it’s' : 'they’re'} left out.`);
  const gd = days(gone), ud = days(un);
  if (gone.length) rows.push(`${listText(gone.map(legName))} ${gd ? `${gone.length === 1 ? 'was' : 'were'} on ${gd}` : `${gone.length === 1 ? 'is' : 'are'} in the past`}, so ${gone.length === 1 ? 'it’s' : 'they’re'} left out.`);
  if (un.length) rows.push(`${listText(un.map(legName))}${ud ? ` (${ud})` : ''} ${un.length === 1 ? 'isn’t' : 'aren’t'} included: ${un.every(l => l.dir === 'ret') ? 'the flights home aren’t' : un.length === 1 ? 'it isn’t' : 'they aren’t'} confirmed yet. Come back here once ${un.length === 1 ? 'it is' : 'they are'}.`);
  if (nt.length) rows.push(`${listText(nt.map(legName))} ${nt.length === 1 ? 'has' : 'have'} no scheduled times yet, so ${nt.length === 1 ? 'it’s' : 'they’re'} left out.`);
  return rows;
}
const leftOutHtml = out => leftOutText(out).map(t => h`<div class="co plain">${icon('info-circle')}<span>${t}</span></div>`);
let CAL = {text: ''};
N.screen('calendar', {
  back: 'today', nav: false, uses: ['trip', 'guide', 'status'], title: 'Add to Calendar',
  render() {
    const rise = firstPaint();
    const hasTrip = !!N.data.trip;
    const {inc, out} = calPlan();
    CAL = {text: inc.length ? safe(() => buildIcs(inc), '') : '', n: inc.length};
    const t = N.data.trip;
    const asOf = t && t.updated_at ? N.date(t.updated_at, 'NYC') : null;
    const events = inc.map(l => h`<div class="rw c wl-r"><span class="ic">${icon('plane-departure')}</span><div class="grow">
      <b>${legName(l)}</b><small>${legDay(l)} · ${N.time(l.dep.sched, l.from)} → ${N.time(l.arr.sched, l.to)} local</small>
      <small>${apName(l.from)}${termText(l.dep.terminal) ? `, ${termText(l.dep.terminal)}` : ''}</small></div></div>`);
    const add = !hasTrip
      ? h`<div class="co plain">${icon('info-circle')}<span>Your flights appear here once the trip has loaded on this phone.</span></div>`
      : inc.length
        ? h`<div class="wl-card wl-rows">${events}</div><p class="help">Each flight gets an alert the day before and 3 hours before.</p>`
        : h`<div class="wl-card wl-empty"><b>Nothing to add right now</b>${(out.length ? leftOutText(out) : ['There are no upcoming flights with scheduled times.']).map(t => h`<p>${t}</p>`)}</div>`;
    return {
      hero: bar('Flights', 'calendar-plus', 'Add to Calendar'),
      body: h`<div class="wl wl-c">
        ${inc.length ? h`<section class="sec${rise ? ' rise' : ''}">
          <a class="btn wl-wide" id="wl-ics" href="#calendar" download="nyc-flights.ics" type="text/calendar" aria-disabled="true">${icon('calendar-plus')}Add ${N.plural(inc.length, 'flight')} to Calendar</a>
          <button class="btn alt wl-wide wl-gap" id="wl-ics-share" data-act="cshare" hidden>${icon('share')}Share the calendar file</button>
          <p class="help">When Calendar opens, tap Add All. If a file downloads instead, open nyc-flights.ics in the Files app.</p>
        </section>` : ''}
        ${sec('wl-c-what', 'What gets added', add, 1, rise)}
        ${out.length && inc.length ? h`<div class="stack8 wl-gap${rise ? ' rise' : ''}" style="animation-delay:90ms">${leftOutHtml(out)}</div>` : ''}
        ${sec('wl-c-know', 'Good to know', h`<div class="wl-card wl-rows">
          <div class="rw c wl-r"><span class="ic">${icon('alert-triangle')}</span><div class="grow"><b>Calendar won’t update itself</b><small>Gate changes and delays show here, not in Calendar.</small></div></div>
          <div class="rw c wl-r"><span class="ic">${icon('calendar')}</span><div class="grow"><b>Scheduled times${asOf ? ` as of ${asOf}` : ''}</b><small>If the schedule changes, delete these events and add them again.</small></div></div>
        </div>`, 3, rise)}
      </div>`,
    };
  },
  mount(ctx, view) {
    const a = N.$('#wl-ics', view);
    if (!a || !CAL.text) return null;
    let url = null;
    try { url = URL.createObjectURL(new Blob([CAL.text], {type: 'text/calendar;charset=utf-8'})); } catch (e) { url = null; }
    if (!url) return null;
    a.href = url;
    a.removeAttribute('aria-disabled');
    const share = N.$('#wl-ics-share', view);
    try {
      const file = new File([CAL.text], 'nyc-flights.ics', {type: 'text/calendar'});
      if (share && navigator.canShare && navigator.canShare({files: [file]})) share.hidden = false;
    } catch (e) { /* sharing files not supported */ }
    // Give a download that has just started time to read the file before letting it go.
    return () => setTimeout(() => URL.revokeObjectURL(url), 30000);
  },
  actions: {
    async cshare() {
      if (!CAL.text || !navigator.share) return;
      try { await navigator.share({files: [new File([CAL.text], 'nyc-flights.ics', {type: 'text/calendar'})], title: 'Flights'}); }
      catch (e) { /* closed the share sheet */ }
    },
  },
});
})();
