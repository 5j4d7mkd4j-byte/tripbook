/* Today: the home screen. One glance answers "what do I do next?" at every
   point of the trip: the days before, the travel mornings, the gate, the air,
   the Charlotte connection, landing at LGA, the stay, the return day and after.
   Wallet values (seats, hotel) are only displayed here; nothing from the
   Wallet goes into a link, a log or a request. */
(() => {
'use strict';
const {h, icon} = N;
const T = v => v ? new Date(v).getTime() : NaN;
const okT = v => Number.isFinite(T(v));
const nowMs = () => N.now().getTime();
const MIN = 60000, HOUR = 3600000;
const AA_TRIPS = 'https://www.aa.com/reservation/view/find-your-trip';
const CITY = {PHX: 'Phoenix', CLT: 'Charlotte', LGA: 'New York', NYC: 'New York'};
const PORT = {PHX: 'Sky Harbor', CLT: 'Charlotte', LGA: 'LaGuardia'};
const WX_ICONS = new Set(['cloud-storm', 'snowflake', 'cloud', 'cloud-rain', 'cloud-fog', 'wind', 'sun', 'moon', 'sun-high', 'moon-stars', 'umbrella']);

// ---------- small helpers ----------
// One section failing must never blank the screen: report it and leave it out.
const sec = fn => { try { return fn() || ''; } catch (e) { N.report(e, 'today'); return ''; } };
const city = c => CITY[c] || (N.guideFor(c) || {}).city || c || '';
const port = c => PORT[c] || (N.guideFor(c) || {}).short || c || '';
const fno = l => l ? `${l.carrier || 'AA'} ${l.num || String(l.flight || '').replace(/^\D+/, '')}`.trim() : '';
const tzAbbr = (ap, iso) => {
  try {
    const p = new Intl.DateTimeFormat('en-US', {timeZone: N.tz(ap), timeZoneName: 'short'}).formatToParts(iso ? new Date(iso) : N.now());
    const z = (p.find(x => x.type === 'timeZoneName') || {}).value || '';
    return /^(GMT|UTC)/.test(z) ? '' : z;
  } catch (e) { return ''; }
};
const sameDay = (a, b, ap) => !!a && !!b && N.ymd(a, ap) === N.ymd(b, ap);
// "4:31a" today, "Sun 4:31a" on another day (local to the airport).
const when = (iso, ap) => !iso ? '' : sameDay(iso, N.now(), ap) ? N.time(iso, ap) : `${N.date(iso, ap).split(' ')[0]} ${N.time(iso, ap)}`;
const tmz = (iso, ap) => { if (!iso) return '—'; const z = tzAbbr(ap, iso); return `${N.time(iso, ap)}${z ? ' ' + z : ''}`; };
const longDate = ap => N.date(N.now(), ap, true);
const dateOf = ymd => ymd ? N.date(ymd + 'T16:00:00Z', 'NYC') : '';
const legDate = l => l.dep.time ? N.date(l.dep.time, l.from) : dateOf(l.date);
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
const sentences = (s, n = 2) => {
  const m = String(s || '').match(/[^.!?]+[.!?]+(?=\s|$)/g);
  return (m ? m.slice(0, n).join('') : String(s || '')).trim();
};
const dropFirst = s => { const m = String(s || '').match(/[^.!?]+[.!?]+(?=\s|$)/g); return m && m.length > 1 ? m.slice(1).join('').trim() : String(s || '').trim(); };
// First clause of a sentence: "A is open 24 hours; B opens at 4a." → "A is open 24 hours."
const clause = s => { const c = sentences(s, 1).split(/;\s/)[0].replace(/[.;,]?\s*$/, '.'); return c.length > 1 ? c : String(s || ''); };
const scase = s => { s = String(s || '').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : ''; };
const and = a => a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
const termText = t => !t ? '' : /^\d+$/.test(String(t)) ? `T${t}` : `Terminal ${t}`;
// Where you go for the first leg: "T4" / "Terminal 4", "LGA" / "LGA Terminal B".
function termLabel(l, long = false) {
  if (!l) return '';
  const t = l.dep.terminal;
  if (l.from === 'PHX') return t ? (long ? `Terminal ${t}` : `T${t}`) : (long ? 'Sky Harbor' : 'PHX');
  return long ? `${l.from}${t ? ' Terminal ' + t : ''}` : l.from;
}
const placeOf = l => l.from === 'PHX' ? `PHX ${termText(l.dep.terminal) || ''}`.trim() : l.dep.terminal ? `${l.from} ${termText(l.dep.terminal)}` : city(l.from);
const guide = () => N.data.guide || {};
const steps = (code, kind) => { const g = N.guideFor(code); return g && g.steps && Array.isArray(g.steps[kind]) ? g.steps[kind] : []; };
const stepBy = (code, kind, ic, re) => steps(code, kind).find(s => s && (s.icon === ic || (re && re.test(s.title || '')))) || null;
const traffic = k => N.data.status && N.data.status.traffic && N.data.status.traffic[k] || null;

// ---------- trip state ----------
// Time-based state with live overrides. The model holds a leg at "boarding"
// until 20 min after departure; here a leg counts as gone at its departure
// time unless a fresh check still sees it at the gate.
function eff(l) {
  if (!l) return 'unknown';
  if (l.canceled) return 'canceled';
  if (l.diverted) return 'diverted';
  const t = nowMs(), dep = T(l.dep.time), arr = T(l.arr.time);
  if (l.landed || l.arr.actual) return 'landed';
  if (l.departed || l.dep.actual) return Number.isFinite(arr) && t >= arr + 30 * MIN ? 'landed' : 'air';
  if (!Number.isFinite(dep)) return 'unknown';
  if (t < dep - N.AA.board * MIN) return 'scheduled';
  if (t < dep) return 'boarding';
  const chk = T(l.checked_at);
  if (l.live && chk > dep && t - chk < 20 * MIN && t < dep + 90 * MIN) return 'boarding';
  if (Number.isFinite(arr) ? t < arr : t < dep + 6 * HOUR) return 'air';
  return 'landed';
}
// Where one direction stands: leave | leavenow | goto | airport | gate | air |
// connect | arrived | canceled | diverted | unknown.
function dirState(dir) {
  const legs = N.dirLegs(dir);
  const s = {dir, legs, mode: 'unknown', leg: null, idx: -1, lv: null};
  if (!legs.length) return s;
  const idx = legs.findIndex(l => eff(l) !== 'landed');
  if (idx < 0) { s.mode = 'arrived'; s.leg = legs[legs.length - 1]; s.idx = legs.length - 1; return s; }
  const l = legs[idx], e = eff(l), t = nowMs();
  Object.assign(s, {leg: l, idx, e});
  if (e === 'canceled' || e === 'diverted') s.mode = e;
  else if (e === 'air') s.mode = 'air';
  else if (e === 'boarding') s.mode = 'gate';
  else if (e === 'unknown') s.mode = 'unknown';
  else if (idx > 0) s.mode = 'connect';
  else {
    const lv = N.leave(dir);
    s.lv = lv;
    if (!lv) s.mode = 'unknown';
    else if (t < T(lv.at)) s.mode = 'leave';
    else if (t < T(lv.at) + 10 * MIN) s.mode = 'leavenow';
    else if (t < T(lv.arrive)) s.mode = 'goto';
    else s.mode = 'airport';
  }
  return s;
}
function checkin(dir) {
  const l = N.dirLegs(dir)[0];
  if (!l || !l.dep.time || l.canceled) return null;
  const opens = N.addMin(l.dep.time, -24 * 60);
  return {leg: l, opens, open: nowMs() >= T(opens)};
}
function foodNow() {
  const ps = N.food && N.food.places ? N.food.places() : [];
  const here = N.lastWhere ? N.lastWhere() : null;
  const st = ps.map(p => ({p, hr: N.food.hours(p), away: here ? N.food.away(p, here) : null}));
  const open = st.filter(x => x.hr.state === 'open' || x.hr.state === 'closing');
  open.sort((a, b) => a.away != null && b.away != null ? a.away - b.away : (b.p.rating || 0) - (a.p.rating || 0) || (b.p.reviews || 0) - (a.p.reviews || 0));
  const next = st.filter(x => x.hr.state === 'closed' && x.hr.opensIn != null).sort((a, b) => a.hr.opensIn - b.hr.opensIn)[0] || null;
  return {total: ps.length, open, next, near: !!here};
}
// Weather at an airport for a moment (a leg time) or now: a saved forecast
// near that time, else the last observation if it is recent.
function wxAt(code, iso) {
  const w = (N.airportLive(code) || {}).wx;
  if (!w) return null;
  const n = nowMs(), t = iso ? T(iso) : n;
  if (!Number.isFinite(t)) return null;
  const pick = (arr, win) => (Array.isArray(arr) ? arr : []).filter(x => x && okT(x.t) && Math.abs(T(x.t) - t) <= win)
    .sort((a, b) => Math.abs(T(a.t) - t) - Math.abs(T(b.t) - t))[0];
  const f = pick(w.legs, 90 * MIN) || pick(w.hourly, 45 * MIN);
  const obs = T(w.obs_at || w.updated);
  if (!iso && w.temp_f != null && Number.isFinite(obs) && n - obs < 3 * HOUR) {
    return {temp: w.temp_f, text: scase(w.text), icon: w.icon, precip: w.precip_pct, wind: w.wind_mph, kind: 'now', at: w.obs_at || w.updated};
  }
  if (f) return {temp: f.temp_f, text: scase(f.text), icon: f.icon, precip: f.precip_pct, kind: 'fc', at: f.t};
  return null;
}
// Tile-length forecast text: "Chance showers and thunderstorms" → "Chance showers".
const wxShort = s => { s = String(s || ''); const m = s.match(/^(.{6,}?)\s+(?:and|then)\s/i); return s.length > 20 && m ? m[1] : s; };
const wxIcon = n => WX_ICONS.has(n) ? n : 'temperature';
// "Checkpoint A open 24h · C and D from 3:15a · B from 4:15a" from the guide's free-text hours.
function checkpoints(code) {
  const list = (N.guideFor(code) || {}).security;
  if (!Array.isArray(list)) return '';
  const always = [], groups = new Map();
  for (const s of list) {
    const m = String(s && s.name || '').match(/^Checkpoint\s+(\S+)$/i);
    if (!m) continue;
    const hrs = String(s.hours || '');
    if (/24\s*h/i.test(hrs)) { always.push(m[1]); continue; }
    const o = hrs.match(/^\s*(\d{1,2})(?::(\d{2}))?\s*([ap])/i);
    if (!o) continue;
    const ap = o[3].toLowerCase();
    const key = `${+o[1]}${o[2] ? ':' + o[2] : ''}${ap}`;
    const mins = ((+o[1] % 12) + (ap === 'p' ? 12 : 0)) * 60 + (+o[2] || 0);
    if (!groups.has(key)) groups.set(key, {key, mins, names: []});
    groups.get(key).names.push(m[1]);
  }
  const out = [];
  if (always.length) out.push(`Checkpoint${always.length > 1 ? 's' : ''} ${and(always)} open 24h`);
  [...groups.values()].sort((a, b) => a.mins - b.mins).forEach(g => {
    out.push(`${out.length ? '' : `Checkpoint${g.names.length > 1 ? 's' : ''} `}${and(g.names)} from ${g.key}`);
  });
  return out.join(' · ');
}

// ---------- pieces ----------
const head = (ey, hl, sub) => h`<header class="td-head"><div class="ey">${ey}</div><h1 class="hl">${hl}</h1>${sub || ''}</header>`;
const until = iso => h`<span class="tn" data-until="${iso}">${N.until(iso)}</span>`;
const dotCls = tone => tone === 'ok' ? '' : tone === 'neutral' ? 'neutral' : 'warn';
// "● On time · checked 2:31a" — the time goes rose when the check is old.
function statusLine(l, ap) {
  const st = N.legStatus(l), f = N.fresh();
  const at = l && l.checked_at || f.at;
  const stale = f.level === 'stale';
  return h`<div class="sub td-st"><span class="${N.cls('dot', stale ? 'stale' : dotCls(st.tone))}"></span><span data-k="st-${l ? l.id : 'x'}">${st.text}</span><span aria-hidden="true">·</span><span class="${stale ? 'td-old' : ''}">${at ? `checked ${when(at, ap)}` : 'not checked yet'}</span></div>`;
}
function srcText(lv) {
  const p = [`${lv.drive} min drive${lv.source === 'traffic' ? ' in current traffic' : ''}`];
  if (lv.buffer) p.push(`${lv.buffer} min extra`);
  p.push(`${N.dur(lv.arriveBefore)} before departure`);
  return `Based on ${p.join(' + ')}`;
}
const srcBtn = lv => h`<button class="td-src" data-act="go" data-arg="settings"><span>${srcText(lv)} · <u>change in Settings</u></span></button>`;
const ln = (ic, body) => body ? h`<div class="td-ln">${icon(ic)}<span>${body}</span></div>` : '';
const stepLn = (st, n = 2, ic) => st ? ln(ic || st.icon || 'info-circle', h`<b>${String(st.title || '').replace(/\.$/, '')}.</b> ${sentences(st.detail, n)}`) : '';
const linkRow = (href, ic, title, sub, cls) => h`<a class="${N.cls('td-row td-a', cls)}" href="${href}"><span class="ic">${icon(ic)}</span><span class="grow"><b>${title}</b>${sub ? h`<small>${sub}</small>` : ''}</span>${icon('chevron-right', 'td-chev')}</a>`;
const extRow = (url, ic, title, sub, cls) => h`<a class="${N.cls('td-row td-a', cls)}" href="${url}" target="_blank" rel="noopener"><span class="ic">${icon(ic)}</span><span class="grow"><b>${title}</b>${sub ? h`<small>${sub}</small>` : ''}</span>${icon('external-link', 'td-chev')}</a>`;
const lineCard = rows => { rows = rows.filter(Boolean); return rows.length ? h`<div class="card line td-line">${rows}</div>` : ''; };
const tiles = list => { list = list.filter(Boolean); return list.length ? h`<div class="${N.cls('td-tiles', list.length === 1 && 'td-one')}">${list}</div>` : ''; };

// Illustrations from the approved mockups (fills follow the theme).
const SKYLINE = h`<svg class="il td-sky" viewBox="0 0 190 240" aria-hidden="true"><g class="s1"><rect x="0" y="150" width="30" height="90"/><rect x="34" y="128" width="20" height="112"/><rect x="150" y="140" width="40" height="100"/><rect x="122" y="168" width="30" height="72"/></g><g class="s2"><rect x="104" y="104" width="38" height="136"/><rect x="109" y="84" width="28" height="22"/><rect x="114" y="68" width="18" height="18"/><rect x="119" y="52" width="8" height="18"/><rect x="122" y="22" width="2" height="32"/></g><g class="s3"><rect x="58" y="110" width="32" height="130"/><path d="M58 110a16 16 0 0 1 32 0z"/><path d="M62 98a12 12 0 0 1 24 0z"/><path d="M66 88a8 8 0 0 1 16 0z"/><path d="M70 80a4 4 0 0 1 8 0z"/><path d="M73.3 78L74 38l.7 40z"/></g><g class="s1"><path d="M63 108l3-7 3 7zm8 0l3-9 3 9zm8 0l3-7 3 7zM67 96l2-5 2 5zm10 0l2-5 2 5z"/></g><g class="s4"><rect x="0" y="202" width="46" height="38"/><rect x="48" y="216" width="58" height="24"/><rect x="98" y="196" width="22" height="44"/><rect x="138" y="208" width="52" height="32"/></g></svg>`;
const DESERT = h`<svg class="il td-desert" viewBox="0 0 200 200" aria-hidden="true"><circle class="s2" cx="150" cy="38" r="14"/><circle class="td-moon" cx="157" cy="33" r="13"/><g class="s3"><circle cx="100" cy="28" r="1.8"/><circle cx="118" cy="62" r="1.4"/><circle cx="182" cy="76" r="1.6"/><circle cx="86" cy="60" r="1.4"/></g><path class="s2" d="M0 170C24 150 40 128 60 132c16 3 20-26 44-28 26-2 34 36 58 40 16 3 28 10 38 14v42H0z"/><path class="s1" d="M0 184c40-8 90-6 200 2v14H0z"/><path class="s3" d="M128 196v-84a7 7 0 0 1 14 0v40h8v-20a6 6 0 0 1 12 0v26a8 8 0 0 1-8 8h-12v30zM128 150h-8a8 8 0 0 1-8-8v-18a6 6 0 0 1 12 0v14h4z"/></svg>`;
const illFor = l => l.from === 'PHX' ? DESERT : (l.from === 'LGA' || l.to === 'LGA') ? SKYLINE : '';

// One leg as a ticket card → #flight/<id>.
function legCard(l) {
  const time = l.dep.time ? `${tmz(l.dep.time, l.from)} → ${tmz(l.arr.time, l.to)}` : 'Times not confirmed';
  return h`<a class="card td-a td-tk" href="#flight/${l.id}">${illFor(l)}
    <div class="td-tkc">
      <div class="ey">${fno(l)} · ${legDate(l)}</div>
      <div class="dp td-tkdp">${l.from}<br>${l.to}</div>
      <div class="td-tkr"><span class="fab" aria-hidden="true">${icon('arrow-right')}</span>
        <div class="grow"><div class="td-tkt tn" data-k="time-${l.id}">${time}</div>${statusLine(l, l.from)}</div></div>
    </div></a>`;
}
// The whole outbound (or return) as one ticket → #flights.
function tripCard(legs, label) {
  const a = legs[0], z = legs[legs.length - 1];
  const via = legs.slice(0, -1).map(l => l.to);
  const total = N.mins(a.dep.time, z.arr.time);
  const time = a.dep.time && z.arr.time ? `${tmz(a.dep.time, a.from)} → ${tmz(z.arr.time, z.to)}` : 'Times not confirmed';
  return h`<a class="card td-a td-tk" href="#flights">${SKYLINE}
    <div class="td-tkc">
      <div class="ey">${legDate(a)} · ${label}</div>
      <div class="dp td-tkdp">${a.from}<br>${z.to}</div>
      <div class="td-tkr"><span class="fab" aria-hidden="true">${icon('arrow-right')}</span>
        <div class="grow"><div class="td-tkt tn">${time}</div><div class="td-tks">${via.length ? `via ${via.join(', ')}` : 'Nonstop'}${total != null ? ` · ${N.dur(total)}` : ''}</div></div></div>
    </div></a>`;
}
// Bags close / Boards / Doors close (or Departs) as three cells; the next deadline is ringed.
function cutoffs(items, ring) {
  const t = nowMs();
  const live = items.filter(x => x && x.at);
  const next = ring ? live.find(x => T(x.at) > t) : null;
  return h`<div class="cn td-cn">${live.map(x => {
    const past = T(x.at) <= t;
    return h`<div class="${x === next ? 'w' : ''}"><small>${x.label}</small><b class="tn"${x.k ? h` data-k="${x.k}"` : ''}>${N.time(x.at, x.ap)}</b><span>${past ? (x.pastText || 'passed') : h`in ${until(x.at)}`}</span></div>`;
  })}</div>`;
}
// The sand card for the drive to the airport.
function planCard(S, phase) {
  const {lv, leg: l, dir} = S;
  const ap = l.from, t = nowMs();
  const leaving = S.mode === 'leave' || S.mode === 'leavenow';
  const eyeb = phase === 'before' ? `${N.date(l.dep.time, ap).split(' ')[0]} morning · ${placeOf(l)}`
    : S.mode === 'goto' ? `On the way · ${placeOf(l)}` : `${dir === 'out' ? 'Leave home' : 'Leave the hotel'} · ${placeOf(l)}`;
  const leaveTxt = T(lv.at) > t ? `Leave ${N.time(lv.at, ap)}` : `Leave by ${N.time(lv.at, ap)}`;
  const curb = stepBy(ap, 'depart', 'door');
  const secStep = stepBy(ap, 'depart', 'shield-check', /security/i);
  const drive = stepBy(ap, 'depart', 'car');
  const cps = checkpoints(ap);
  const cut = h`<span class="tn"><span class="td-nw">Bags close ${N.time(lv.bagdrop, ap)}</span> · <span class="td-nw">Boards ${N.time(l.board, ap)}</span> · <span class="td-nw">Doors close <span data-k="doors-${l.id}">${N.time(l.doors, ap)}</span></span></span>`;
  let rows;
  if (phase === 'before') rows = [];
  else {
    const tip = drive && dropFirst(drive.detail);
    rows = [
      ln('clock', cut),
      leaving && tip && tip !== drive.detail ? ln('car', tip) : '',
      !leaving && curb ? stepLn(curb, 1) : '',
      ln('shield-check', cps),
      secStep ? ln('info-circle', leaving ? sentences(dropFirst(secStep.detail), 1) : h`<b>${String(secStep.title || 'Security').replace(/\.$/, '')}:</b> ${sentences(secStep.detail, 2)}`) : '',
    ].filter(Boolean);
  }
  return h`<div class="card sand td-plan">
    <div class="td-planh"><div class="grow"><div class="ey">${eyeb}</div><div class="td-big tn">At ${termLabel(l)} by <span data-k="arrive-${dir}">${N.time(lv.arrive, ap)}</span></div></div>
      ${S.mode === 'goto' && phase !== 'before' ? '' : h`<span class="chip td-lv">${icon(dir === 'out' ? 'home' : 'building')}<span data-k="leave-${dir}">${leaveTxt}</span></span>`}</div>
    ${phase === 'before' ? h`<p class="td-cut">${cut}</p>` : ''}
    ${rows.length ? h`<div class="td-rows">${rows}</div>` : ''}
    ${phase !== 'before' && S.mode === 'leave' && T(lv.at) - t > 3 * HOUR ? h`<p class="td-cut">Leave in ${until(lv.at)}</p>` : ''}
  </div>`;
}
// Big gate number with boarding and door times.
function gateCard(l, opts = {}) {
  const gate = l.dep.gate, seats = l.seats || [];
  return h`<div class="card td-gate">
    <div class="td-gtop"><div class="grow">
      <div class="ey">${fno(l)} · ${l.from} → ${l.to}</div>
      <div class="td-glbl">${[termText(l.dep.terminal).replace(/^T(?=\d)/, 'Terminal '), gate ? 'Gate' : ''].filter(Boolean).join(' · ') || city(l.from)}</div>
    </div>
    ${seats.length ? h`<div class="td-seat"><small>${seats.length > 1 ? 'Seats' : 'Seat'}</small><b class="tn">${seats.join(' · ')}</b></div>` : ''}</div>
    ${gate ? h`<div class="dp td-gnum tn" data-k="gate-${l.id}">${gate}</div>` : h`<div class="td-gnone" data-k="gate-${l.id}">Gate not posted yet</div>`}
    ${!gate ? h`<p class="td-p">Check the departure screens or the AA app${opts.hint ? `. ${opts.hint}` : '.'}</p>` : ''}
    ${opts.walk ? h`<div class="td-p">${ln('walk', opts.walk)}</div>` : ''}
    ${cutoffs([{label: 'Boards', at: l.board, ap: l.from, pastText: 'started'}, {label: 'Doors close', at: l.doors, ap: l.from, k: `doors-${l.id}`, pastText: 'closed'}, {label: 'Departs', at: l.dep.time, ap: l.from, k: `dep-${l.id}`, pastText: 'now'}], true)}
  </div>`;
}
// Two-up tiles.
function connTile(dir) {
  const c = N.connection(dir);
  if (!c) return null;
  const tone = c.level === 'ok' ? '' : 'td-ring';
  return h`<a class="${N.cls('td-mini td-a', tone)}" href="#connect/${dir}"><div class="ey">${city(c.at)}</div><b>${c.ground < 180 ? `${c.ground} min` : N.dur(c.ground)} to connect</b><small>${c.text}${Number.isFinite(c.free) ? (c.free >= 0 ? ` · ${c.free} min spare before boarding` : ` · boarding may start before you reach the gate`) : ''}</small></a>`;
}
function faaWords(f) {
  if (!f || !f.status) return '';
  return f.status === 'normal' ? 'No FAA delays' : f.status === 'ground_stop' ? 'FAA ground stop' : f.status === 'closed' ? 'Airport closed' : 'FAA delays';
}
function wxTile(code, iso) {
  const w = wxAt(code, iso), f = (N.airportLive(code) || {}).faa;
  if (!w && !f) return null;
  const bad = f && f.status && f.status !== 'normal';
  const small = [w && w.kind === 'fc' && iso ? `At ${N.time(w.at, code)}` : '', w && w.precip >= 30 ? `${w.precip}% rain` : '', faaWords(f)].filter(Boolean).join(' · ');
  return h`<a class="${N.cls('td-mini td-a', bad && 'td-ring')}" href="#airport/${code.toLowerCase()}"><div class="ey">${code}${w && w.temp != null ? ` · ${w.temp}°` : ''}</div><b>${w ? wxShort(w.text) || 'Forecast saved' : 'No forecast saved'}</b>${small ? h`<small>${small}</small>` : ''}</a>`;
}
function hotelTile() {
  const ht = N.hotel();
  return ht
    ? h`<a class="td-mini td-a" href="#hotel"><div class="ey">Hotel</div><b class="td-clamp">${ht.name || 'Your hotel'}</b>${ht.address ? h`<small class="td-clamp">${ht.address}</small>` : ''}</a>`
    : h`<a class="td-mini td-a" href="#wallet"><div class="ey">Hotel</div><b>Add your hotel in Wallet</b><small>Stays on this phone</small></a>`;
}

// ---------- callouts ----------
function changesBn() {
  const ch = N.changes() || [];
  if (!ch.length) return '';
  return h`<div class="bn td-bn" role="status">${icon('bell')}<div class="grow"><b>${ch.length === 1 ? 'Flight change' : `${ch.length} flight changes`}</b>${ch.map(c => h`<span data-k="chg-${c.leg.id}-${c.k}">${c.text}</span>`)}<button class="td-got" data-act="seen">${icon('check')}Got it</button></div></div>`;
}
function alertsFor(codes) {
  const out = [];
  // The first code is where you are; another airport's check time carries its zone.
  const hereTz = codes[0] ? N.tz(codes[0]) : null;
  [...new Set(codes.filter(Boolean))].forEach(code => {
    const a = N.airportLive(code) || {};
    const f = a.faa;
    if (f && f.status && f.status !== 'normal') {
      const bad = f.status === 'ground_stop' || f.status === 'closed';
      out.push(h`<div class="${N.cls('co', bad && 'rose')}" role="status">${icon('alert-triangle')}<span><b>${code} · ${faaWords(f)}.</b> ${f.text || ''}${f.updated ? ` · checked ${when(f.updated, code)}${N.tz(code) !== hereTz ? ` ${tzAbbr(code, f.updated)}` : ''}` : ''}</span></div>`);
    }
    const al = a.wx && Array.isArray(a.wx.alerts) ? a.wx.alerts : [];
    al.slice(0, 2).forEach(x => {
      const txt = typeof x === 'string' ? x : x && (x.event || x.headline || x.text) || '';
      if (txt) out.push(h`<div class="co" role="status">${icon('umbrella')}<span><b>${city(code)} weather:</b> ${txt}</span></div>`);
    });
  });
  return out;
}
function legAlerts(legs) {
  return legs.map(l => {
    if (l.canceled) return h`<div class="bn" role="alert">${icon('alert-triangle')}<div class="grow"><b>${fno(l)} is canceled</b><span>AA usually rebooks you automatically. The AA app or aa.com shows the new flight; the AA desk can help too.</span><a class="td-got td-a" href="${AA_TRIPS}" target="_blank" rel="noopener">${icon('external-link')}Open AA Trips</a></div></div>`;
    if (l.diverted) return h`<div class="bn" role="alert">${icon('alert-triangle')}<div class="grow"><b>${fno(l)} diverted to ${l.diverted}</b><span>Stay with the plane and follow crew instructions. The AA app shows rebooking.</span><a class="td-got td-a" href="${AA_TRIPS}" target="_blank" rel="noopener">${icon('external-link')}Open AA Trips</a></div></div>`;
    if (l.route_ok === false) return h`<div class="co" role="status">${icon('alert-circle')}<span><b>${fno(l)} needs checking.</b> The latest check didn’t match the planned route${l.route_seen ? ` (saw ${l.route_seen})` : ''}. Confirm in the AA app.</span></div>`;
    return '';
  }).filter(Boolean);
}
function delayCo(l) {
  if (!l || !(l.delay_dep > 14) || !l.dep.time) return '';
  return h`<div class="co" role="status">${icon('clock')}<span><b>${fno(l)} now leaves ${N.time(l.dep.time, l.from)}, ${N.dur(l.delay_dep)} late.</b> Times here use the new departure. Delays can shrink, so keep to AA’s cutoffs.</span></div>`;
}
function checkinCo(dir, untilIso) {
  const c = checkin(dir);
  if (!c || !c.open) return '';
  if (untilIso && nowMs() >= T(untilIso)) return '';
  return extRow(AA_TRIPS, 'ticket', `Check-in is open for ${fno(c.leg)}`, 'Check in at aa.com or the AA app', 'td-ci');
}
function staleCo(ap) {
  const f = N.fresh();
  if (f.level !== 'stale' || f.window || !N.online()) return '';
  return h`<button class="co plain td-stale" data-act="refresh">${icon('refresh')}<span class="grow">Flight info last checked ${f.at ? when(f.at, ap) : 'never'} · tap to check now</span></button>`;
}
function retFlag() {
  const legs = N.dirLegs('ret');
  if (!legs.length || !legs.some(l => l.confirmed === false && !l.dep.time)) return '';
  return h`<a class="bn td-a td-flag" href="${AA_TRIPS}" target="_blank" rel="noopener" role="status">${icon('alert-triangle')}<div class="grow"><b>Return flights not confirmed yet — check AA Trips</b><span>${legs.map(fno).join(' and ')} have no confirmed times. Today will plan the trip to LGA once they do.</span></div>${icon('external-link', 'td-chev')}</a>`;
}

// ---------- views ----------
function vBefore() {
  const legs = N.dirLegs('out');
  const a = legs[0];
  if (!a) return [vNoTrip()];
  const ap = a.from;
  const lv = N.leave('out');
  const S = lv ? {lv, leg: a, dir: 'out', mode: 'before'} : null;
  const ci = checkin('out');
  const ret = N.dirLegs('ret');
  const unconf = ret.some(l => l.confirmed === false && !l.dep.time);
  return [
    head(`${longDate(ap)} · ${city(ap)}`,
      a.dep.time ? h`Departs in<br><b>${until(a.dep.time)}.</b>` : h`Flying to<br><b>New York.</b>`,
      statusLine(a, ap)),
    sec(() => staleCo(ap)),
    sec(changesBn),
    sec(() => legAlerts(legs)),
    sec(() => delayCo(a)),
    sec(() => checkinCo('out')),
    sec(() => tripCard(legs, 'Outbound')),
    S && sec(() => planCard(S, 'before')),
    sec(() => lineCard([
      ci && !ci.open && h`<div class="td-row"><span class="ic">${icon('ticket')}</span><span class="grow"><b>Check-in opens ${when(ci.opens, ap)}</b><small>24 hours before · aa.com or the AA app</small></span></div>`,
      ret.length && (unconf
        ? extRow(AA_TRIPS, 'plane', `Home ${dateOf(ret[0].date)}`, h`${ret[0].from} → ${ret[ret.length - 1].to} · <span class="td-warn">times not confirmed, check AA Trips</span>`)
        : linkRow('#flights', 'plane', `Home ${legDate(ret[0])}`, `${ret[0].from} → ${ret[ret.length - 1].to}${ret[0].dep.time ? ` · leaves ${tmz(ret[0].dep.time, ret[0].from)}` : ''}`)),
    ])),
    sec(() => tiles([connTile('out'), wxTile(ap, a.dep.time)])),
  ];
}

function vTravel(dir) {
  const S = dirState(dir);
  switch (S.mode) {
    case 'leave': case 'leavenow': case 'goto': return vMorning(S);
    case 'airport': case 'gate': return vGate(S);
    case 'air': return vAir(S);
    case 'connect': return vConnect(S);
    case 'arrived': return vArrived(S);
    case 'canceled': case 'diverted': return vTrouble(S);
    default: return dir === 'ret' ? vRetUnknown(S) : vOutUnknown(S);
  }
}
function dayWord(l) {
  const ap = l.from, today = N.ymd(N.now(), ap);
  const d = l.dep.time ? N.ymd(l.dep.time, ap) : l.date;
  return d === today ? 'Travel day' : dayDiff(today, d) === 1 ? 'Flying tomorrow' : dateOf(d);
}
function vMorning(S) {
  const {lv, leg: l, dir} = S;
  const ap = l.from, t = nowMs();
  let hl;
  if (S.mode === 'leave') {
    hl = T(lv.at) - t > 3 * HOUR
      ? h`Leave for ${termLabel(l)} at<br><b class="tn">${N.time(lv.at, ap)}.</b>`
      : h`Leave for ${termLabel(l)} in<br><b>${until(lv.at)}.</b>`;
  } else if (S.mode === 'leavenow') hl = h`Leave for ${termLabel(l)}<br><b>now.</b>`;
  else hl = h`Get to ${termLabel(l, true)}<br>by <b class="tn">${N.time(lv.arrive, ap)}.</b>`;
  return [
    head(`${longDate(ap)} · ${dayWord(l)}`, hl, srcBtn(lv)),
    sec(changesBn),
    sec(() => legAlerts(S.legs)),
    sec(() => delayCo(l)),
    sec(() => alertsFor([l.from, l.to])),
    sec(() => checkinCo(dir, lv.arrive)),
    sec(() => legCard(l)),
    sec(() => planCard(S, 'travel')),
    sec(() => tiles([connTile(dir), wxTile(ap, l.dep.time)])),
    dir === 'ret' && sec(retFlag),
  ];
}
function vGate(S) {
  const l = S.leg, ap = l.from, t = nowMs(), dir = S.dir;
  let hl, sub = statusLine(l, ap);
  if (t < T(l.board)) hl = h`Boarding in<br><b>${until(l.board)}.</b>`;
  else if (t < T(l.doors)) {
    hl = h`Boarding<br><b>now.</b>`;
  } else if (t < T(l.dep.time)) hl = h`Departs<br>at <b class="tn">${N.time(l.dep.time, ap)}.</b>`;
  else hl = h`Waiting to<br><b>depart.</b>`;
  const first = S.idx === 0;
  const before = t < T(l.board) - 10 * MIN;
  const rows = first && before ? [
    sec(() => { const s = stepBy(ap, 'depart', 'shield-check', /security/i); return s ? stepLn(s, 2) : ''; }),
    sec(() => { const s = stepBy(ap, 'depart', 'walk'); return s ? stepLn(s, 1) : ''; }),
    sec(() => { const s = stepBy(ap, 'depart', 'coffee'); return s ? stepLn({...s, detail: clause(s.detail)}, 1) : ''; }),
  ].filter(Boolean) : [];
  return [
    head(`${longDate(ap)} · ${placeOf(l)}`, hl, sub),
    sec(changesBn),
    sec(() => legAlerts(S.legs)),
    sec(() => delayCo(l)),
    sec(() => alertsFor([l.from, l.to])),
    sec(() => gateCard(l, {hint: first ? '' : 'Recent gates vary, so don’t assume.'})),
    rows.length ? h`<div class="card line td-line td-pad">${rows}</div>` : '',
    sec(() => tiles([first ? connTile(dir) : null, wxTile(l.to, l.arr.time)])),
    dir === 'ret' && sec(retFlag),
  ];
}
function vAir(S) {
  const l = S.leg, dir = S.dir, next = S.legs[S.idx + 1];
  const ap = l.to;
  return [
    head(`${longDate(ap)} · In the air`,
      h`Landing at ${l.to}<br><b class="tn" data-k="arr-${l.id}">${N.time(l.arr.time, ap)}.</b>`,
      h`<div class="sub td-st"><span>${fno(l)} · ${l.from} → ${l.to}</span>${l.arr.time && T(l.arr.time) > nowMs() ? h`<span aria-hidden="true">·</span><span>lands in ${until(l.arr.time)}</span>` : ''}</div>`),
    sec(changesBn),
    sec(() => legAlerts(S.legs)),
    sec(() => alertsFor([l.to])),
    sec(() => legCard(l)),
    next ? sec(() => connCard(dir)) : sec(() => dir === 'out' ? hotelRoute('Next: get to') : landHome(l)),
    sec(() => tiles([wxTile(l.to, l.arr.time), !next && dir === 'out' ? hotelTile() : null])),
  ];
}
// Connection preview while in the air → #connect/<dir>.
function connCard(dir) {
  const c = N.connection(dir);
  if (!c) return '';
  const {a, b} = c;
  const chip = c.level === 'ok' ? 'chip td-lv' : c.level === 'tight' ? 'chip warn' : 'chip rose';
  const walk = c.walk && c.walk.known
    ? `About ${c.walk.min} min walk, gate ${a.arr.gate} to ${b.dep.gate}`
    : `${a.arr.gate ? `Arriving at gate ${a.arr.gate}; next gate not posted yet` : b.dep.gate ? 'Arrival gate not posted yet' : 'Gates not posted yet'} · plan on about ${c.walk ? c.walk.min : 15} min walking`;
  const spare = c.free >= 0 ? `About ${N.dur(c.free)} spare before boarding` : 'Boarding may start before you reach the gate';
  return h`<a class="card sand td-a td-plan" href="#connect/${dir}">
    <div class="td-planh"><div class="grow"><div class="ey">${city(c.at)} connection</div><div class="td-big tn">${N.dur(c.ground)} on the ground</div></div><span class="${chip}">${c.text}</span></div>
    <div class="td-rows">
      ${ln('plane-departure', h`<b>${fno(b)} boards ${N.time(b.board, b.from)}</b> ${b.dep.gate ? h` · gate <span data-k="gate-${b.id}">${b.dep.gate}</span>` : ''}`)}
      ${ln('walk', walk)}
      ${ln('clock', spare)}
    </div>
    <span class="td-more">Connection details${icon('chevron-right')}</span>
  </a>`;
}
function vConnect(S) {
  const b = S.leg, a = S.legs[S.idx - 1], dir = S.dir;
  const c = N.connection(dir);
  const ap = b.from;
  const walk = c && c.walk && c.walk.known
    ? `About ${c.walk.min} min walk from gate ${a.arr.gate}`
    : a && a.arr.gate ? `You arrived at gate ${a.arr.gate}. Allow 5–20 min to walk.` : 'Allow 5–20 min to walk between concourses.';
  const find = dir === 'out' ? stepBy(ap, 'connect', 'device-mobile') : null;
  const food = dir === 'out' ? stepBy(ap, 'connect', 'tools-kitchen-2') : null;
  const risk = c && c.level === 'risk' && !b.canceled
    ? h`<div class="co rose" role="status">${icon('alert-triangle')}<span><b>Connection at risk.</b> ${b.dep.gate ? `Go straight to gate ${b.dep.gate}` : 'Find your gate on the departure screens and go straight there'}; skip food until you’re at the gate.</span></div>` : '';
  return [
    head(`${longDate(ap)} · ${city(ap)}`, h`${fno(b)} boards in<br><b>${until(b.board)}.</b>`, statusLine(b, ap)),
    sec(changesBn),
    sec(() => legAlerts(S.legs)),
    risk,
    sec(() => delayCo(b)),
    sec(() => alertsFor([b.from, b.to])),
    sec(() => gateCard(b, {walk, hint: find ? 'Recent gates vary, so don’t assume.' : ''})),
    sec(() => lineCard([
      food && !(c && c.level === 'risk') ? h`<div class="td-lnw">${stepLn(food, 2)}</div>` : '',
      linkRow(`#connect/${dir}`, 'route', 'Connection details', c ? `${N.dur(c.ground)} on the ground · ${c.text}` : ''),
      linkRow(`#airport/${ap.toLowerCase()}`, 'building-airport', `${port(ap)} airport guide`, 'Gates, food, restrooms'),
    ])),
    sec(() => tiles([wxTile(b.to, b.arr.time)])),
  ];
}
function bagsCard(l) {
  const bg = l.arr.baggage;
  const st = stepBy(l.to, 'arrive', 'luggage', /bag/i);
  return h`<div class="card td-bags">
    <div class="td-planh"><div class="grow"><div class="ey">Baggage claim · ${l.to}</div><div class="td-big" data-k="bag-${l.id}">${bg ? `Carousel ${bg}` : 'Carousel not posted yet'}</div></div><span class="ic">${icon('luggage')}</span></div>
    <p class="td-p">${st ? st.detail : 'The screens in baggage claim and the AA app show the carousel.'}</p>
  </div>`;
}
// Best way from LGA to the hotel right now → #transit.
function hotelRoute(prefix = 'Get to') {
  const routes = (guide().transit && guide().transit.to_hotel) || [];
  const tr = traffic('to_hotel');
  const ht = N.hotel();
  const dest = ht ? (ht.name || 'the hotel') : 'the hotel';
  if (!routes.length) return linkRow('#transit', 'route', `${prefix} ${dest}`, 'Routes aren’t loaded yet · open Transit');
  let best = routes[0], why = '';
  if (tr && tr.min && tr.typical_min && tr.min > tr.typical_min * 1.35) {
    const alt = routes.find(r => !r.traffic_key && /subway|train|q70/i.test(`${r.id} ${r.name}`));
    if (alt) { best = alt; why = `Roads are slow (${tr.min} min by car), so ${alt.name} is steadier.`; }
  }
  const mins = best.traffic_key && tr && tr.min ? `${tr.min} min now` : Array.isArray(best.min) ? `${best.min[0]}–${best.min[1]} min` : best.min ? `${best.min} min` : '';
  return h`<a class="card sand td-a td-plan" href="#transit">
    <div class="td-planh"><div class="grow"><div class="ey">${prefix} ${dest}</div><div class="td-big">${best.name}</div></div>${mins ? h`<span class="chip td-lv tn">${mins}</span>` : ''}</div>
    <div class="td-rows">
      ${ln('route', best.summary)}
      ${why ? ln('traffic-cone', why) : ''}
      ${best.traffic_key && tr && tr.text ? ln('car', tr.text) : ''}
      ${best.cost ? ln('cash', best.cost) : ''}
    </div>
    <span class="td-more">All ways to ${ht ? 'the hotel' : 'Midtown'}${icon('chevron-right')}</span>
  </a>`;
}
function landHome(l) {
  return lineCard([linkRow('#flights', 'plane-arrival', `${fno(l)} lands ${N.time(l.arr.time, l.to)}`, `${port(l.to)}${l.arr.terminal ? ` · ${termText(l.arr.terminal)}` : ''}`)]);
}
function vArrived(S) {
  const l = S.leg, dir = S.dir, ap = l.to;
  const ground = stepBy(ap, 'arrive', 'route', /ground/i);
  return [
    head(`${longDate(ap)} · ${port(ap)}`,
      dir === 'out' ? h`Landed at<br><b>${port(ap)}.</b>` : h`Landed in<br><b>${city(ap)}.</b>`,
      h`<div class="sub td-st"><span class="dot"></span><span>${fno(l)} · ${l.arr.actual || l.landed ? 'landed' : 'scheduled to land'} ${N.time(l.arr.time, ap)}${l.arr.terminal ? ` · ${termText(l.arr.terminal)}` : ''}</span></div>`),
    sec(changesBn),
    sec(() => bagsCard(l)),
    dir === 'out' && sec(() => hotelRoute()),
    dir === 'out' && ground ? sec(() => h`<div class="card line td-line td-pad">${stepLn(ground, 3)}</div>`) : '',
    dir === 'out' ? sec(() => tiles([wxTile(ap, null) || wxTile('NYC', null), hotelTile()])) : sec(() => vAfterRows()),
  ];
}
function vTrouble(S) {
  const l = S.leg, ap = l.from;
  const help = stepBy(ap, S.idx > 0 ? 'connect' : 'depart', 'alert-triangle', /wrong/i);
  return [
    head(`${longDate(ap)} · ${placeOf(l)}`,
      l.canceled ? h`${fno(l)} is<br><b>canceled.</b>` : h`Diverted to<br><b>${l.diverted}.</b>`,
      statusLine(l, ap)),
    sec(changesBn),
    sec(() => legAlerts([l])),
    help ? sec(() => h`<div class="card line td-line td-pad">${stepLn(help, 4)}</div>`) : '',
    sec(() => legCard(l)),
    sec(() => alertsFor([l.from, l.to])),
  ];
}
function vOutUnknown(S) {
  const legs = S.legs;
  if (!legs.length) return [vNoTrip()];
  return [
    head(`${longDate('PHX')} · Travel day`, h`Flying to<br><b>New York.</b>`, h`<p class="td-p">Flight times aren’t loaded. Check the AA app for this morning’s times.</p>`),
    sec(changesBn),
    sec(() => lineCard([extRow(AA_TRIPS, 'ticket', 'Open AA Trips', 'aa.com or the AA app')])),
    sec(() => tripCard(legs, 'Outbound')),
  ];
}
// Return day with no confirmed times: say so plainly and plan the parts we do know.
function vRetUnknown(S) {
  const legs = S.legs;
  if (!legs.length) return [vNoTrip()];
  const ap = legs[0].from;
  const plan = guide().plan && guide().plan.ret || {};
  const routes = (guide().transit && guide().transit.to_lga) || [];
  const tr = traffic('to_lga');
  const best = routes[0];
  const terminal = stepBy(ap, 'depart', 'door');
  const secStep = stepBy(ap, 'depart', 'shield-check', /security/i);
  return [
    head(`${longDate(ap)} · Travel day`, h`Flying home<br><b>today.</b>`, h`<div class="sub td-st"><span class="dot warn"></span><span>Flight times not confirmed</span></div>`),
    sec(retFlag),
    sec(changesBn),
    sec(() => legAlerts(legs)),
    sec(() => alertsFor([ap, 'CLT'])),
    sec(() => h`<a class="card line td-a td-line td-legs" href="#flights">${legs.map(l => h`<div class="td-leg"><div class="grow"><b>${fno(l)}</b><small>${l.from} → ${l.to}</small></div><span class="td-warn">${l.dep.time ? tmz(l.dep.time, l.from) : 'Time not confirmed'}</span></div>`)}<span class="td-more">Both flights${icon('chevron-right')}</span></a>`),
    sec(() => h`<a class="card sand td-a td-plan" href="#transit">
      <div class="td-planh"><div class="grow"><div class="ey">Getting to ${ap}</div><div class="td-big">${best ? best.name : 'Hotel to the airport'}</div></div>${best && Array.isArray(best.min) ? h`<span class="chip td-lv tn">${best.min[0]}–${best.min[1]} min</span>` : ''}</div>
      <div class="td-rows">
        ${tr && tr.text ? ln('car', tr.text) : ''}
        ${plan.note ? ln('info-circle', sentences(plan.note, 1)) : ''}
        ${plan.arrive_before_min ? ln('clock', `Plan to be at ${ap} ${N.dur(plan.arrive_before_min)} before departure once times are confirmed.`) : ''}
      </div>
      <span class="td-more">All ways to ${ap}${icon('chevron-right')}</span></a>`),
    (terminal || secStep) ? sec(() => h`<div class="card line td-line td-pad">${terminal ? stepLn(terminal, 2) : ''}${secStep ? stepLn(secStep, 2) : ''}</div>`) : '',
    sec(() => tiles([wxTile(ap, null), hotelTile()])),
  ];
}
function nycWeather() {
  const code = (N.airportLive('NYC') || {}).wx ? 'NYC' : 'LGA';
  const w = (N.airportLive(code) || {}).wx;
  const n = nowMs();
  if (!w) return h`<div class="card td-wx"><div class="ey">New York weather</div><p class="td-p">Weather isn’t loaded yet. It arrives with the next flight check.</p></div>`;
  const cur = wxAt(code, null);
  const hrs = (Array.isArray(w.hourly) ? w.hourly : []).filter(x => x && okT(x.t) && T(x.t) >= n - 30 * MIN && T(x.t) <= n + 12 * HOUR)
    .sort((a, b) => T(a.t) - T(b.t)).filter((x, i) => i === 0 || T(x.t) > n).slice(0, 6);
  const upd = w.obs_at || w.updated;
  return h`<div class="card td-wx">
    <div class="td-planh"><div class="grow"><div class="ey">New York weather</div>
      ${cur ? h`<div class="td-wxnow"><span class="td-temp tn" data-k="wx-temp">${cur.temp != null ? `${cur.temp}°` : '—'}</span><span class="grow"><b>${cur.text || ''}</b><small>${[cur.kind === 'now' && cur.wind != null ? `Wind ${cur.wind} mph` : '', cur.precip != null ? `${cur.precip}% rain` : '', cur.kind === 'now' ? `checked ${when(upd, 'NYC')}` : `forecast for ${N.time(cur.at, 'NYC')}`].filter(Boolean).join(' · ')}</small></span></div>`
        : h`<p class="td-p">No recent reading${upd ? ` · last checked ${when(upd, 'NYC')}` : ''}. It refreshes with the next flight check.</p>`}
    </div>${cur ? h`<span class="td-wxi">${icon(wxIcon(cur.icon))}</span>` : ''}</div>
    ${hrs.length ? h`<div class="td-hrs">${hrs.map(x => h`<div class="td-hr"><small>${T(x.t) <= n ? 'Now' : N.time(x.t, 'NYC').replace(':00', '')}</small>${icon(wxIcon(x.icon))}<b class="tn">${x.temp_f != null ? `${x.temp_f}°` : '—'}</b>${x.precip_pct >= 20 ? h`<span class="tn">${x.precip_pct}%</span>` : ''}</div>`)}</div>`
      : cur ? h`<p class="td-p td-mu">No hourly forecast saved for the next few hours.</p>` : ''}
  </div>`;
}
function foodCard() {
  const f = foodNow();
  if (!f.total) return linkRow('#food', 'tools-kitchen-2', 'Food list', 'Not loaded yet · open Food to try again');
  const names = f.open.slice(0, 3).map(x => x.p.name + (x.away != null ? ` (${N.walkMin(x.away)} min)` : ''));
  const sub = f.open.length ? names.join(' · ')
    : f.next ? `Next to open: ${f.next.p.name}, ${f.next.hr.short ? f.next.hr.short.replace(/^Opens /, '') : 'soon'}` : 'Check the list for hours';
  return h`<a class="card td-a td-food" href="#food">
    <div class="td-planh"><div class="grow"><div class="ey">Food list${f.near ? ' · nearest first' : ''}</div><div class="td-big" data-k="food-open">${f.open.length ? `${f.open.length} of ${f.total} open now` : 'Nothing open right now'}</div></div><span class="ic">${icon('tools-kitchen-2')}</span></div>
    <p class="td-p">${sub}</p>
    <span class="td-more">Open the list${icon('chevron-right')}</span>
  </a>`;
}
function hotelCard() {
  const ht = N.hotel();
  return ht ? linkRow('#hotel', 'bed', ht.name || 'Your hotel', ht.address || 'Address and directions')
    : linkRow('#wallet', 'bed', 'Add your hotel in Wallet', 'Then Today and Transit can point you there. It stays on this phone.');
}
function returnCard(today) {
  const legs = N.dirLegs('ret');
  if (!legs.length) return '';
  const r1 = legs[0];
  const unconf = legs.some(l => l.confirmed === false && !l.dep.time);
  const ci = checkin('ret');
  const left = dayDiff(today, r1.date);
  return h`<div class="card line td-line">
    <a class="td-a td-legs" href="#flights">
      <div class="ey">Flying home · ${legDate(r1)}</div>
      ${legs.map(l => h`<div class="td-leg"><div class="grow"><b>${fno(l)}</b><small>${l.from} → ${l.to}</small></div><span class="${l.dep.time ? 'tn' : 'td-warn'}">${l.dep.time ? `${N.time(l.dep.time, l.from)} → ${N.time(l.arr.time, l.to)}` : 'Time not confirmed'}</span></div>`)}
    </a>
    ${unconf ? h`<a class="td-a td-flagl" href="${AA_TRIPS}" target="_blank" rel="noopener">${icon('alert-triangle')}<span class="grow">Return flights not confirmed yet — check AA Trips</span>${icon('external-link')}</a>` : ''}
    ${ci ? (ci.open ? extRow(AA_TRIPS, 'ticket', 'Check-in is open', 'Check in at aa.com or the AA app')
      : h`<div class="td-lnci">${ln('ticket', h`<b>Check-in opens ${when(ci.opens, r1.from)}</b> · aa.com or the AA app`)}</div>`)
      : left <= 1 ? h`<div class="td-lnci">${ln('ticket', 'Check-in opens 24 hours before departure, on aa.com or the AA app.')}</div>` : ''}
  </div>`;
}
function vStay() {
  const trip = N.trip() || {};
  const ret = N.dirLegs('ret');
  const r1 = ret[0];
  const today = N.ymd(N.now(), 'NYC');
  const day = trip.start ? dayDiff(trip.start, today) + 1 : null;
  const retDate = r1 && r1.date || trip.end;
  const left = retDate ? dayDiff(today, retDate) : null;
  const hl = left === 1 ? h`Last full day in<br><b>New York.</b>` : day && day >= 1 ? h`Day ${day} in<br><b>New York.</b>` : h`In<br><b>New York.</b>`;
  const sub = r1 && r1.dep.time && T(r1.dep.time) > nowMs()
    ? h`<div class="sub td-st"><span>Flying home ${legDate(r1)} · in ${until(r1.dep.time)}</span></div>`
    : retDate ? h`<div class="sub td-st"><span>Flying home ${dateOf(retDate)} · ${left === 1 ? 'tomorrow' : left > 1 ? `in ${left} days` : 'today'}</span></div>` : '';
  return [
    head(`${longDate('NYC')} · New York`, hl, sub),
    sec(() => staleCo('NYC')),
    sec(changesBn),
    sec(nycWeather),
    sec(foodCard),
    sec(hotelCard),
    sec(() => returnCard(today)),
  ];
}
function vAfterRows() {
  return lineCard([
    linkRow('#flights', 'plane', 'Trip flights', 'All four legs and what happened'),
    linkRow('#wallet', 'wallet', 'Clear Wallet details', 'Names, codes and seats are stored only on this phone'),
  ]);
}
function vAfter() {
  const trip = N.trip() || {};
  const legs = N.legs();
  const nights = trip.start && trip.end ? dayDiff(trip.start, trip.end) : null;
  const range = trip.start && trip.end ? `${+trip.start.slice(8)}–${dateOf(trip.end).split(' ').slice(1).join(' ')}` : '';
  return [
    head(`${longDate('PHX')} · ${city(trip.home || 'PHX')}`, h`Welcome<br><b>home.</b>`, h`<div class="sub td-st"><span>${trip.title || 'New York'}${range ? ` · ${range}` : ''}</span></div>`),
    h`<div class="card td-sum"><div class="td-sumr">
      <div><b class="tn">${legs.length}</b><small>${legs.length === 1 ? 'flight' : 'flights'}</small></div>
      ${nights ? h`<div><b class="tn">${nights}</b><small>${nights === 1 ? 'night' : 'nights'} in New York</small></div>` : ''}
    </div>${SKYLINE}</div>`,
    sec(vAfterRows),
  ];
}
function vNoTrip() {
  return h`<div class="td-empty">${head('Today', h`Trip not<br><b>loaded yet.</b>`, h`<p class="td-p">The flight plan hasn’t reached this phone. Connect to the internet and check again.</p>`)}
    <button class="btn td-btn" data-act="refresh">${icon('refresh')}Check now</button></div>`;
}

// ---------- screen ----------
// A key for "what the screen should show"; tick() re-renders when it moves on.
function modeKey() {
  const ph = N.phase();
  let k = ph;
  if (ph === 'out' || ph === 'ret') {
    const s = dirState(ph);
    k += `|${s.mode}|${s.leg ? s.leg.id : ''}`;
    if (s.mode === 'leave' && s.lv) k += T(s.lv.at) - nowMs() > 3 * HOUR ? '|far' : '|near';
    if (s.leg) k += `|${nowMs() >= T(s.leg.board)}|${nowMs() >= T(s.leg.doors)}|${nowMs() >= T(s.leg.dep.time)}`;
  }
  const ci = checkin(ph === 'ret' || ph === 'stay' ? 'ret' : 'out');
  k += `|${ci ? ci.open : ''}|${N.fresh().level}`;
  if (ph === 'stay') k += `|${foodNow().open.length}|${N.hour(N.now(), 'NYC')}`;
  return k;
}
let lastKey = '';

N.screen('today', {
  nav: 0,
  tone: 'band',
  // 'force' is listed because core's rerender() checks `uses` before a forced repaint.
  uses: ['trip', 'guide', 'status', 'food', 'force'],
  title: 'Today',
  render() {
    let parts;
    try {
      lastKey = modeKey();
      if (!N.data.trip || !N.legs().length) parts = [vNoTrip()];
      else {
        const ph = N.phase();
        parts = ph === 'before' ? vBefore() : ph === 'out' || ph === 'ret' ? vTravel(ph) : ph === 'stay' ? vStay() : vAfter();
      }
    } catch (e) {
      N.report(e, 'today');
      parts = [head('Today', h`Something went<br><b>wrong.</b>`, h`<p class="td-p">This screen hit a problem. Flights, Airports and Transit still work.</p>`)];
    }
    const first = !N.$('#body .td');
    return {hero: '', body: h`<div class="${N.cls('td', first && 'rise')}">${parts.filter(Boolean)}</div>`};
  },
  tick() {
    if (modeKey() !== lastKey) N.rerender();
  },
  actions: {
    seen() { N.markSeen(); N.rerender(); },
  },
});
})();
