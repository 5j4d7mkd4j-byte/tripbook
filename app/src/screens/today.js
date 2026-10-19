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
// Parts joined by "·" that wrap as whole parts; today.css clips the dot that would start a line,
// so no line starts or ends with a lone separator.
const meta = parts => { parts = parts.filter(Boolean); return parts.length ? h`<span class="td-mw"><span class="td-mt">${parts.map(p => h`<span>${p}</span>`)}</span></span>` : ''; };
const subLine = (parts, dot) => h`<div class="sub td-st">${dot || ''}${meta(parts)}</div>`;
// "5 min ago", kept current by core's ticker. Relative, so it reads the same in every time zone.
const ago = iso => h`<span data-ago="${iso}">${N.ago(iso)}</span>`;

// ---------- day and night ----------
// Sunrise and sunset from the NOAA sunrise equation, good to a few minutes: enough to say
// "Clear" and show a moon after dark instead of "Sunny".
const GEO = {PHX: [33.43, -112.01], CLT: [35.21, -80.94], LGA: [40.78, -73.87], NYC: [40.75, -73.98]};
const RAD = Math.PI / 180, J2000 = Date.UTC(2000, 0, 1, 12);
function sunAt(code, ms) {
  const g = GEO[code];
  if (!g || !Number.isFinite(ms)) return null;
  const [lat, lon] = g, sin = d => Math.sin(d * RAD);
  const js = Math.round((ms - J2000) / 864e5 + lon / 360) - lon / 360;
  const M = (357.5291 + 0.98560028 * js) % 360;
  const L = (M + 1.9148 * sin(M) + 0.02 * sin(2 * M) + 0.0003 * sin(3 * M) + 282.9372) % 360;
  const noon = js + 0.0053 * sin(M) - 0.0069 * sin(2 * L);
  const dec = Math.asin(sin(L) * sin(23.4397));
  const cw = Math.max(-1, Math.min(1, (sin(-0.833) - sin(lat) * Math.sin(dec)) / (Math.cos(lat * RAD) * Math.cos(dec))));
  const w = Math.acos(cw) / RAD / 360;
  return {rise: J2000 + (noon - w) * 864e5, set: J2000 + (noon + w) * 864e5};
}
const isNight = (code, ms) => { const s = sunAt(code, ms); return !!s && (ms < s.rise || ms > s.set); };
const NIGHT_IC = {sun: 'moon', 'sun-high': 'moon-stars'};
const nightText = s => String(s || '').replace(/\b(mostly|partly)?\s*sunny\b/gi, (m, q) => !q ? 'clear' : /mostly/i.test(q) ? 'mostly clear' : 'partly cloudy');
// A reading or forecast for a moment after dark says so in words and icon.
const atNight = (w, code, ms) => w && isNight(code, ms) ? {...w, text: scase(nightText(w.text)), icon: NIGHT_IC[w.icon] || w.icon} : w;
const hourIcon = (x, code) => wxIcon(isNight(code, T(x.t)) ? NIGHT_IC[x.icon] || x.icon : x.icon);

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
  // Boarding can start before a late inbound reaches the gate: within an hour of landing
  // the traveller is still walking over, so the connection view (walk, route) leads.
  else if (e === 'boarding') s.mode = idx > 0 && T(legs[idx - 1].arr.time) > t - HOUR ? 'connect' : 'gate';
  else if (e === 'unknown') s.mode = 'unknown';
  else if (idx > 0) s.mode = 'connect';
  else {
    const lv = leaveFor(dir);
    s.lv = lv;
    if (!lv) s.mode = 'unknown';
    else if (t < T(lv.at)) s.mode = 'leave';
    // "Leave now" holds for 15 min, counting the minutes late, then becomes "Get to …".
    else if (t < Math.min(T(lv.at) + 15 * MIN, T(lv.arrive))) s.mode = 'leavenow';
    else if (t < T(lv.arrive)) s.mode = 'goto';
    else s.mode = 'airport';
  }
  return s;
}
// The leave time. On the return it comes from Transit when Transit shares it (N.leaveBy),
// so both screens give the same time; otherwise the model's drive-based time.
// Transit names its directions 'lga' / 'hotel'; 'to-lga' / 'to-hotel' are tried too.
const askTransit = (fn, kind, ...args) => {
  if (typeof fn !== 'function') return null;
  for (const k of [kind, `to-${kind}`]) {
    try { const v = fn(k, ...args); if (v) return v; } catch (e) { /* not a direction Transit knows */ }
  }
  return null;
};
function leaveFor(dir) {
  const lv = N.leave(dir);
  if (!lv || dir !== 'ret') return lv;
  const v = askTransit(N.leaveBy, 'lga');
  const at = v && typeof v === 'object' && !(v instanceof Date) ? v.at || v.leave : v;
  // Only a time that still leaves room to reach the airport is taken.
  return okT(at) && T(at) < T(lv.arrive) ? {...lv, at: new Date(at).toISOString(), source: 'transit'} : lv;
}
// Transit's best route right now when Transit shares it (N.bestRoute): {id, name, mins, leave}.
function transitPick(kind) {
  const r = askTransit(N.bestRoute, kind, N.now());
  return r && r.name ? r : null;
}
const minsText = m => Array.isArray(m) ? `${m[0]}–${m[1]} min` : Number.isFinite(+m) && m !== '' && m != null ? `${+m} min` : '';
// The return leg landed long enough ago that baggage and landing lines are history.
const homeLong = S => S.dir === 'ret' && S.mode === 'arrived' && nowMs() > T(S.leg.arr.time) + 90 * MIN;
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
  const gap = x => Math.abs(T(x.t) - t);
  const pick = (arr, win) => (Array.isArray(arr) ? arr : []).filter(x => x && okT(x.t) && gap(x) <= win).sort((a, b) => gap(a) - gap(b))[0];
  // The saved leg forecast or the hourly one, whichever is nearer the moment (a delay moves the leg time).
  const f = [pick(w.legs, 90 * MIN), pick(w.hourly, 45 * MIN)].filter(Boolean).sort((a, b) => gap(a) - gap(b))[0];
  const obs = T(w.obs_at || w.updated);
  // A reading stamped in the future is bad data, not "now".
  if (!iso && w.temp_f != null && Number.isFinite(obs) && n - obs < 3 * HOUR && n - obs > -10 * MIN) {
    return atNight({temp: w.temp_f, text: scase(w.text), icon: w.icon, precip: w.precip_pct, wind: w.wind_mph, kind: 'now', at: w.obs_at || w.updated}, code, n);
  }
  if (f) return atNight({temp: f.temp_f, text: scase(f.text), icon: f.icon, precip: f.precip_pct, kind: 'fc', at: f.t}, code, T(f.t));
  return null;
}
// Tile-length forecast text: "Chance showers and thunderstorms" → "Chance showers".
const wxShort = s => { s = String(s || ''); const m = s.match(/^(.{6,}?)\s+(?:and|then)\s/i); return s.length > 20 && m ? m[1] : s; };
const wxIcon = n => WX_ICONS.has(n) ? n : 'temperature';
// ---------- pieces ----------
const head = (ey, hl, sub) => h`<header class="td-head"><div class="ey">${ey}</div><h1 class="hl">${hl}</h1>${sub || ''}</header>`;
const until = iso => h`<span class="tn" data-until="${iso}">${N.until(iso)}</span>`;
// The dot follows the flight's status alone (freshness has its own strip): --eb when fine,
// --warn for something to keep an eye on, rose only when late or worse.
function dotTone(st) {
  if (st.tone === 'bad' || (st.tone === 'warn' && /late|delay/i.test(st.text))) return 'td-dbad';
  if (st.tone === 'warn' || (st.tone === 'ok' && /late/i.test(st.text))) return 'td-dcau';
  return st.tone === 'neutral' ? 'neutral' : 'td-dok';
}
const dot = cls => h`<span class="${N.cls('dot', cls)}"></span>`;
// "● On time · checked 5 min ago". The check time is relative, so it reads the same in any zone.
// It turns rose only when it is old and the refresh strip isn't showing (the strip already says so).
function statusLine(l) {
  const f = N.fresh();
  const at = l && l.checked_at || f.at;
  let st = N.legStatus(l);
  // A check made after departure time that still has no takeoff should not read "On time".
  if (l && st.tone === 'ok' && !['air', 'landed'].includes(l.state) && !l.departed && !l.landed && !(l.dep && l.dep.actual)
    && okT(l.dep && l.dep.time) && T(at) > T(l.dep.time) && nowMs() - T(l.dep.time) > 5 * MIN) st = {text: 'Not departed yet', tone: 'warn'};
  const old = f.level === 'stale' && N.online() && !(f.window || f.hot);
  return subLine([
    h`<span data-k="st-${l ? l.id : 'x'}">${st.text}</span>`,
    at ? h`<span class="${old ? 'td-old' : ''}">checked ${ago(at)}</span>` : 'not checked yet',
  ], dot(dotTone(st)));
}
// How the leave time was worked out. Plain text: the buffer lives in Settings, which the menu already reaches.
const srcParts = lv => [
  lv.source === 'transit' ? 'Leave time from Transit' : `Based on a ${lv.drive} min drive${lv.source === 'traffic' ? ' in current traffic' : ''}`,
  lv.buffer ? `${lv.buffer} min extra` : '',
  `${N.dur(lv.arriveBefore)} before departure`,
];
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
        <div class="grow"><div class="td-tkt tn" data-k="time-${l.id}">${time}</div>${statusLine(l)}</div></div>
    </div></a>`;
}
// The same flight as one row, for the hour before leaving when the drive card leads.
function legRow(l) {
  const time = l.dep.time ? `${tmz(l.dep.time, l.from)} → ${tmz(l.arr.time, l.to)}` : 'Times not confirmed';
  return h`<a class="card line td-a td-line" href="#flight/${l.id}"><div class="td-row td-legr"><span class="ic">${icon('plane')}</span>
    <span class="grow"><b>${fno(l)} · ${l.from} → ${l.to}</b><small class="tn" data-k="time-${l.id}">${time}</small>${statusLine(l)}</span>${icon('chevron-right', 'td-chev')}</div></a>`;
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
// Bags close / Boards / Doors close (or Departs) as three cells; the next deadline is ringed
// in ink, and in rose only when the connection is at risk.
function cutoffs(items, ring, risk = false) {
  const t = nowMs();
  const live = items.filter(x => x && x.at);
  const next = ring ? live.find(x => T(x.at) > t) : null;
  return h`<div class="cn td-cn">${live.map(x => {
    const past = T(x.at) <= t;
    return h`<div class="${x === next ? (risk ? 'w' : 'td-nx') : ''}"><small>${x.label}</small><b class="tn"${x.k ? h` data-k="${x.k}"` : ''}>${N.time(x.at, x.ap)}</b><span>${past ? (x.pastText || 'passed') : h`in ${until(x.at)}`}</span></div>`;
  })}</div>`;
}
// One line for security: "Checkpoint A, Level 3 NW · open 24h · PreCheck from 5a".
// The checkpoint is the one the guide's security step sends you to, else one open all night.
const COMPASS = {north: 'N', south: 'S', east: 'E', west: 'W'};
function secLine(code, st) {
  const list = ((N.guideFor(code) || {}).security || []).filter(s => s && s.name);
  if (!list.length) return st ? ln('shield-check', sentences(st.detail, 1)) : '';
  const named = st && list.find(s => new RegExp(`\\b${String(s.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(`${st.title || ''} ${st.detail || ''}`));
  const cp = named || list.find(s => /24\s*h/i.test(s.hours || '')) || list[0];
  const loc = String(cp.where || cp.location || cp.level || '');
  const first = loc.split(/[,;(]/)[0].trim();
  // "northwest corner" → "NW", "south side" → "S".
  const cm = loc.toLowerCase().match(/\b(?:(north|south)[\s-]?(east|west)?|(east|west))(?:ern)?\b/);
  const cmp = cm ? [cm[1], cm[2] || cm[3]].filter(Boolean).map(w => COMPASS[w]).join('') : '';
  const where = first && first.length <= 18 ? `${first}${cmp && !new RegExp(`\\b${cmp}\\b`).test(first) ? ` ${cmp}` : ''}` : '';
  const hrs = String(cp.hours || '');
  const open = /24\s*h/i.test(hrs) ? 'open 24h' : /^\s*\d/.test(hrs) ? `open ${hrs.trim().replace(/\.$/, '')}` : '';
  const pc = String(cp.precheck || '');
  const pre = /^yes\b/i.test(pc) ? 'PreCheck' : /^\s*\d{1,2}(:\d\d)?\s*[ap]/i.test(pc) ? `PreCheck from ${pc.trim().match(/^\d{1,2}(:\d\d)?\s*[ap]/i)[0].replace(/\s+/g, '').toLowerCase()}` : '';
  return ln('shield-check', meta([`${cp.name}${where ? `, ${where}` : ''}`, open, pre]));
}
// The sand card for the drive to the airport. On the travel morning the heading already
// gives the leave time, so the card gives the arrival time and the cutoffs; the days
// before, it carries the leave time as a chip under the title.
function planCard(S, phase) {
  const {lv, leg: l, dir} = S;
  const ap = l.from, t = nowMs();
  const leaving = S.mode === 'leave' || S.mode === 'leavenow';
  const eyeb = phase === 'before' ? `${N.date(l.dep.time, ap).split(' ')[0]} morning · ${placeOf(l)}`
    : S.mode === 'goto' ? `On the way · ${placeOf(l)}` : `${dir === 'out' ? 'Leave home' : 'Leave the hotel'} · ${placeOf(l)}`;
  const curb = stepBy(ap, 'depart', 'door');
  const secStep = stepBy(ap, 'depart', 'shield-check', /security/i);
  const drive = stepBy(ap, 'depart', 'car');
  const cut = h`<span class="tn">${meta([`Bags close ${N.time(lv.bagdrop, ap)}`, `Boards ${N.time(l.board, ap)}`, h`Doors close <span data-k="doors-${l.id}">${N.time(l.doors, ap)}</span>`])}</span>`;
  let rows;
  if (phase === 'before') rows = [];
  else {
    const tip = drive && dropFirst(drive.detail);
    rows = [
      ln('clock', cut),
      leaving && tip && tip !== drive.detail ? ln(/^by (transit|subway|train|bus)/i.test(tip) ? 'train' : 'car', tip) : '',
      !leaving && curb ? stepLn(curb, 1) : '',
      sec(() => secLine(ap, secStep)),
    ].filter(Boolean);
  }
  const chip = phase === 'before' ? h`<span class="chip td-lv">${icon(dir === 'out' ? 'home' : 'building')}<span data-k="leave-${dir}">Leave ${N.time(lv.at, ap)}</span></span>` : '';
  return h`<div class="card sand td-plan">
    <div class="${N.cls('td-planh', chip && 'td-planw')}"><div class="grow"><div class="ey">${eyeb}</div><div class="td-big tn">At ${termLabel(l)} by <span data-k="arrive-${dir}">${N.time(lv.arrive, ap)}</span></div></div>${chip}</div>
    ${phase === 'before' ? h`<p class="td-cut">${cut}</p>` : ''}
    ${rows.length ? h`<div class="td-rows">${rows}</div>` : ''}
    ${phase !== 'before' && S.mode === 'leave' && T(lv.at) - t > 3 * HOUR ? h`<p class="td-cut">Leave in ${until(lv.at)}</p>` : ''}
  </div>`;
}
// Big gate number with boarding and door times. The whole card opens the airport map.
// Airports reads ?gate= (AP-13) when it says so; until then the plain map link is used,
// since an unknown query would end up in the airport code.
const gateHref = (code, gate) => `#airport/${code.toLowerCase()}${gate && N.airportGateLinks ? `?gate=${encodeURIComponent(gate)}` : ''}`;
function gateCard(l, opts = {}) {
  const gate = l.dep.gate, seats = l.seats || [];
  return h`<a class="card td-a td-gate" href="${gateHref(l.from, gate)}">
    <div class="td-gtop"><div class="grow">
      <div class="ey">${fno(l)} · ${l.from} → ${l.to}</div>
      <div class="td-glbl">${[termText(l.dep.terminal).replace(/^T(?=\d)/, 'Terminal '), gate ? 'Gate' : ''].filter(Boolean).join(' · ') || city(l.from)}</div>
    </div>
    ${seats.length ? h`<div class="td-seat"><small>${seats.length > 1 ? 'Seats' : 'Seat'}</small><b class="tn">${seats.join(' · ')}</b></div>` : ''}</div>
    ${gate ? h`<div class="${N.cls('dp td-gnum tn', String(gate).length > 4 && 'td-glong')}" data-k="gate-${l.id}">${gate}</div>` : h`<div class="td-gnone" data-k="gate-${l.id}">Gate not posted yet</div>`}
    ${!gate ? h`<p class="td-p">Check the departure screens or the AA app${opts.hint ? `. ${opts.hint}` : '.'}</p>` : ''}
    ${opts.walk ? h`<div class="td-p">${ln('walk', opts.walk)}</div>` : ''}
    ${cutoffs([
      // While bag drop is still open (first leg only) it is the next hard deadline, so it leads.
      opts.bags ? {label: 'Bags close', at: opts.bags, ap: l.from, pastText: 'closed'} : null,
      {label: 'Boards', at: l.board, ap: l.from, pastText: 'started'},
      {label: 'Doors close', at: l.doors, ap: l.from, k: `doors-${l.id}`, pastText: 'closed'},
      opts.bags ? null : {label: 'Departs', at: l.dep.time, ap: l.from, k: `dep-${l.id}`, pastText: nowMs() - T(l.dep.time) > 5 * MIN ? 'running late' : 'now'},
    ], true, opts.risk)}
    <span class="td-more">${gate ? `Gate ${gate} on the map` : `${port(l.from)} map`}${icon('chevron-right')}</span>
  </a>`;
}
// Two-up tiles.
// Connection words and colour come from the model's level: ink when comfortable,
// --warn when tight, rose only when at risk.
const LEVEL_TXT = {ok: 'Comfortable', tight: 'Tight', risk: 'At risk'};
const levelOf = c => c && LEVEL_TXT[c.level] ? c.level : 'ok';
const levelTxt = c => c.label || LEVEL_TXT[levelOf(c)] || c.text || '';
// Minutes between reaching the gate and doors closing; Number.isFinite guards an older model.
const spareOf = c => Number.isFinite(c.spare) ? c.spare : null;
const spareTxt = c => { const s = spareOf(c); return s == null ? '' : s >= 0 ? `${s} min before doors close` : 'doors may close before you reach the gate'; };
function connTile(dir) {
  const c = N.connection(dir);
  if (!c) return null;
  const tone = {ok: '', tight: 'td-cau', risk: 'td-ring'}[levelOf(c)];
  // A delay can push the landing past the next departure: say that, never "-15 min".
  if (missed(c)) return h`<a class="td-mini td-a td-ring" href="#connect/${dir}"><div class="ey">${city(c.at)}</div><b>Lands after ${fno(c.b)} leaves</b><small>At risk · the AA app shows rebooking</small></a>`;
  return h`<a class="${N.cls('td-mini td-a', tone)}" href="#connect/${dir}"><div class="ey">${city(c.at)}</div><b>${c.ground < 180 ? `${c.ground} min` : N.dur(c.ground)} to connect</b><small>${[levelTxt(c), spareTxt(c)].filter(Boolean).join(' · ')}</small></a>`;
}
// The first leg is due to land at or after the second one's departure.
const missed = c => !!c && Number.isFinite(c.ground) && c.ground <= 0;
function faaWords(f) {
  if (!f || !f.status) return '';
  return f.status === 'normal' ? 'No FAA delays' : f.status === 'ground_stop' ? 'FAA ground stop' : f.status === 'closed' ? 'Airport closed' : 'FAA delays';
}
// Weather at an airport: temperature and sky in ink; rain or FAA delays as a caution line
// (a --warn icon). FAA trouble has its own callout above, so the tile carries no ring.
function wxTile(code, iso) {
  const w = wxAt(code, iso), f = (N.airportLive(code) || {}).faa;
  const bad = f && f.status && f.status !== 'normal';
  if (!w && !bad) return null;
  // A forecast always says which hour it is for, so "Clear" at 7:40pm reads as the forecast it is.
  const small = meta([w && w.kind === 'fc' ? `At ${N.time(w.at, code)}` : '', !bad ? faaWords(f) : '']);
  const caution = [w && w.precip >= 30 ? `${w.precip}% rain` : '', bad ? faaWords(f) : ''].filter(Boolean).join(' · ');
  return h`<a class="td-mini td-a" href="#airport/${code.toLowerCase()}"><div class="ey">${code}</div><b>${w ? h`<span class="tn">${w.temp != null ? `${w.temp}° ` : ''}</span>${wxShort(w.text) || 'Forecast saved'}` : faaWords(f)}</b>${small ? h`<small>${small}</small>` : ''}${caution && w ? h`<small class="td-wc">${icon('alert-triangle')}<span>${caution}</span></small>` : ''}</a>`;
}
function hotelTile() {
  const ht = N.hotel();
  return ht
    ? h`<a class="td-mini td-a" href="#hotel"><div class="ey">Hotel</div><b class="td-clamp">${ht.name || 'Your hotel'}</b>${ht.address ? h`<small class="td-clamp">${ht.address}</small>` : ''}</a>`
    : h`<a class="td-mini td-a" href="#wallet"><div class="ey">Hotel</div><b>Add your hotel in Wallet</b><small>Stays on this phone</small></a>`;
}

// ---------- callouts ----------
// Model text names the flight with no space ("AA1234"); Today writes "AA 1234" everywhere else.
const chgText = c => { const t = String(c && c.text || ''), f = c && c.leg && c.leg.flight; return f && t.startsWith(f) ? fno(c.leg) + t.slice(f.length) : t; };
function changesBn() {
  const ch = N.changes() || [];
  if (!ch.length) return '';
  return h`<div class="bn td-bn" role="status">${icon('bell')}<div class="grow"><b>${ch.length === 1 ? 'Flight change' : `${ch.length} flight changes`}</b>${ch.map(c => h`<span data-k="chg-${c.leg.id}-${c.k}">${chgText(c)}</span>`)}<button class="td-got" data-act="seen">${icon('check')}Got it</button></div></div>`;
}
function alertsFor(codes) {
  const out = [];
  [...new Set(codes.filter(Boolean))].forEach(code => {
    const a = N.airportLive(code) || {};
    const f = a.faa;
    if (f && f.status && f.status !== 'normal') {
      const bad = f.status === 'ground_stop' || f.status === 'closed';
      // The check time is relative ("checked 5 min ago"), so it never needs a time zone.
      out.push(h`<div class="${N.cls('co', bad && 'rose')}" role="status">${icon('alert-triangle')}<span><b>${code} · ${faaWords(f)}.</b> ${f.text || ''}${f.updated ? h` · checked ${ago(f.updated)}` : ''}</span></div>`);
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
// Check-in reminder until the leave time (after that you're on the way), with a dismiss
// that this phone remembers for that flight.
const CI_KEY = 'nyc.ciDismiss';
const ciGone = (dir, c) => { const d = N.get(CI_KEY, null); return !!d && d.dir === dir && d.id === c.leg.id; };
function checkinCo(dir, untilIso) {
  const c = checkin(dir);
  if (!c || !c.open || ciGone(dir, c)) return '';
  if (untilIso && nowMs() >= T(untilIso)) return '';
  return h`<div class="td-ci">${extRow(AA_TRIPS, 'ticket', 'Check-in is open', `${fno(c.leg)} · aa.com or the AA app`)}<button class="td-x" data-act="ciDismiss" data-arg="${dir}" aria-label="Dismiss check-in reminder">${icon('x')}</button></div>`;
}
function staleCo(ap) {
  const f = N.fresh();
  // While core's refresh strip is up (travel window or a hot leg) it says the same thing.
  if (f.level !== 'stale' || f.window || f.hot || !N.online()) return '';
  return h`<button class="co plain td-stale" data-act="refresh">${icon('refresh')}<span class="grow">${meta([f.at ? `Flight info last checked ${when(f.at, ap)}` : 'Flight info not checked yet', 'tap to check now'])}</span></button>`;
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
      statusLine(a)),
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
  // Home for a while: baggage and landing lines are history, so the trip's end state shows.
  if (homeLong(S)) return vAfter();
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
// Minutes past the leave time (0 before it).
const lateBy = lv => Math.max(0, Math.floor((nowMs() - T(lv.at)) / MIN));
// From two hours before leaving, the drive card leads and the flight shrinks to one row.
const compact = S => !!S.lv && nowMs() >= T(S.lv.at) - 2 * HOUR;
function vMorning(S) {
  const {lv, leg: l, dir} = S;
  const ap = l.from, t = nowMs();
  // The leave time is said once, here; the card below gives the arrival time and cutoffs.
  let hl, lead = '';
  if (S.mode === 'leave') {
    hl = T(lv.at) - t > 3 * HOUR
      ? h`Leave for ${termLabel(l)} at<br><b class="tn">${N.time(lv.at, ap)}.</b>`
      : h`Leave <span class="tn" data-k="leave-${dir}">${N.time(lv.at, ap)}</span><br><b>in ${until(lv.at)}.</b>`;
  } else if (S.mode === 'leavenow') {
    const late = lateBy(lv);
    hl = h`Leave for ${termLabel(l)}<br><b>now.</b>`;
    lead = late >= 1 ? h`<span class="td-warn">${late} min late</span>` : `Leave by ${N.time(lv.at, ap)}`;
  } else hl = h`Get to ${termLabel(l, true)}<br>by <b class="tn">${N.time(lv.arrive, ap)}.</b>`;
  const sub = subLine([lead, ...srcParts(lv)]);
  const ci = sec(() => checkinCo(dir, lv.at));
  if (compact(S)) {
    return [
      head(`${longDate(ap)} · ${dayWord(l)}`, hl, sub),
      sec(changesBn),
      sec(() => legAlerts(S.legs)),
      sec(() => planCard(S, 'travel')),
      sec(() => legRow(l)),
      sec(() => delayCo(l)),
      sec(() => alertsFor([l.from, l.to])),
      ci,
      sec(() => tiles([connTile(dir), wxTile(ap, l.dep.time)])),
      dir === 'ret' && sec(retFlag),
    ];
  }
  return [
    head(`${longDate(ap)} · ${dayWord(l)}`, hl, sub),
    sec(changesBn),
    sec(() => legAlerts(S.legs)),
    sec(() => delayCo(l)),
    sec(() => alertsFor([l.from, l.to])),
    ci,
    sec(() => legCard(l)),
    sec(() => planCard(S, 'travel')),
    sec(() => tiles([connTile(dir), wxTile(ap, l.dep.time)])),
    dir === 'ret' && sec(retFlag),
  ];
}
function vGate(S) {
  const l = S.leg, ap = l.from, t = nowMs(), dir = S.dir;
  let hl, sub = statusLine(l);
  if (t < T(l.board)) hl = h`Boarding in<br><b>${until(l.board)}.</b>`;
  else if (t < T(l.doors)) {
    hl = h`Boarding<br><b>now.</b>`;
  } else if (t < T(l.dep.time)) hl = h`Departs<br>at <b class="tn">${N.time(l.dep.time, ap)}.</b>`;
  else hl = h`Waiting to<br><b>depart.</b>`;
  const first = S.idx === 0;
  const before = t < T(l.board) - 10 * MIN;
  const bagAt = first ? N.addMin(l.dep.time, -N.AA.bagdrop) : null;
  const rows = first && before ? [
    sec(() => secLine(ap, stepBy(ap, 'depart', 'shield-check', /security/i))),
    sec(() => { const s = stepBy(ap, 'depart', 'walk'); return s ? stepLn(s, 1) : ''; }),
    sec(() => { const s = stepBy(ap, 'depart', 'coffee'); return s ? stepLn({...s, detail: clause(s.detail)}, 1) : ''; }),
  ].filter(Boolean) : [];
  return [
    head(`${longDate(ap)} · ${placeOf(l)}`, hl, sub),
    sec(changesBn),
    sec(() => legAlerts(S.legs)),
    sec(() => delayCo(l)),
    sec(() => alertsFor([l.from, l.to])),
    sec(() => gateCard(l, {hint: first ? '' : 'Recent gates vary, so don’t assume.', bags: bagAt && t < T(bagAt) ? bagAt : null})),
    // Same pattern as the connection view: the airport steps, then a way into this airport's guide.
    sec(() => lineCard([
      rows.length ? h`<div class="td-lnw">${rows}</div>` : '',
      linkRow(`#airport/${ap.toLowerCase()}`, 'building-airport', `${port(ap)} airport guide`, 'Gates, food, restrooms'),
    ])),
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
      subLine([`${fno(l)} · ${l.from} → ${l.to}`, l.arr.time && T(l.arr.time) > nowMs() ? h`lands in ${until(l.arr.time)}` : ''])),
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
  const lvl = levelOf(c);
  const chip = {ok: 'chip td-lv', tight: 'chip td-lv td-chipc', risk: 'chip td-lv rose'}[lvl];
  const walk = c.walk && c.walk.known
    ? `About ${c.walk.min} min walk, gate ${a.arr.gate} to ${b.dep.gate}`
    : `${a.arr.gate ? `Arriving at gate ${a.arr.gate}; next gate not posted yet` : b.dep.gate ? 'Arrival gate not posted yet' : 'Gates not posted yet'} · plan on about ${c.walk ? c.walk.min : 15} min walking`;
  const lost = missed(c);
  const sp = spareOf(c);
  const spare = lost ? 'Due to land after it leaves. The AA app shows rebooking.'
    : sp == null ? '' : sp >= 0 ? `About ${N.dur(sp)} to spare before doors close` : 'Doors may close before you reach the gate';
  return h`<a class="card sand td-a td-plan" href="#connect/${dir}">
    <div class="td-planh td-planw"><div class="grow"><div class="ey">${city(c.at)} connection</div><div class="td-big tn">${lost ? `Lands after ${fno(b)} leaves` : `${N.dur(c.ground)} on the ground`}</div></div><span class="${chip}">${lost ? 'At risk' : levelTxt(c)}</span></div>
    <div class="td-rows">
      ${ln('plane-departure', h`<b>${fno(b)} boards ${N.time(b.board, b.from)}</b>${b.dep.gate ? h` · gate <span data-k="gate-${b.id}">${b.dep.gate}</span>` : ''}`)}
      ${ln('walk', walk)}
      ${ln('clock', spare)}
    </div>
    <span class="td-more">Connection details${icon('chevron-right')}</span>
  </a>`;
}
// The walking route between the two gates, when this airport has a walking map.
function routeBtn(code, from, to) {
  if (!(N.guideFor(code) || {}).nav) return '';
  const label = from && to ? `Route ${from} → ${to}` : to ? `Route to ${to}` : `${code} walking map`;
  return h`<a class="btn td-btn td-route" href="#nav/${code.toLowerCase()}/@arr/@dep">${icon('route')}<span>${label}</span></a>`;
}
// On the ground between flights. Once boarding has started (or the connection is at risk)
// the heading says where to go now, with the walk and the doors time, and the route leads.
function vConnect(S) {
  const b = S.leg, a = S.legs[S.idx - 1], dir = S.dir;
  const c = N.connection(dir);
  const ap = b.from, t = nowMs();
  const lvl = c ? levelOf(c) : 'ok';
  const atRisk = lvl === 'risk' && !b.canceled;
  const go = t < T(b.doors) && (t >= T(b.board) || atRisk);
  const fromG = a && a.arr.gate, toG = b.dep.gate;
  const walkMin = c && c.walk && c.walk.known ? c.walk.min : null;
  const walk = walkMin != null
    ? `About ${walkMin} min walk from gate ${fromG}`
    : fromG ? `You arrived at gate ${fromG}. Allow 5–20 min to walk.` : 'Allow 5–20 min to walk between concourses.';
  const find = dir === 'out' ? stepBy(ap, 'connect', 'device-mobile') : null;
  const food = dir === 'out' ? stepBy(ap, 'connect', 'tools-kitchen-2') : null;
  let hl, sub;
  if (go) {
    hl = toG ? h`Go to<br><b data-k="gate-hl-${b.id}">${toG} now.</b>` : h`${fno(b)} is<br><b>boarding.</b>`;
    sub = subLine([
      atRisk ? h`<span class="td-warn">At risk</span>` : '',
      walkMin != null ? `${walkMin} min walk` : `${atRisk ? 'a' : 'A'}llow 5–20 min to walk`,
      h`doors close <span class="tn" data-k="doors-${b.id}">${N.time(b.doors, ap)}</span>`,
    ], dot(atRisk ? 'td-dbad' : lvl === 'tight' ? 'td-dcau' : 'td-dok'));
  } else if (t < T(b.board)) {
    hl = h`${fno(b)} boards in<br><b>${until(b.board)}.</b>`;
    sub = statusLine(b);
  } else if (t < T(b.dep.time)) {
    hl = h`Departs<br>at <b class="tn">${N.time(b.dep.time, ap)}.</b>`;
    sub = statusLine(b);
  } else {
    hl = h`Waiting to<br><b>depart.</b>`;
    sub = statusLine(b);
  }
  const route = sec(() => routeBtn(ap, fromG, toG));
  const risk = atRisk && !go
    ? h`<div class="co rose" role="status">${icon('alert-triangle')}<span><b>Connection at risk.</b> ${toG ? `Go straight to gate ${toG}` : 'Find your gate on the departure screens and go straight there'}; skip food until you’re at the gate.</span></div>` : '';
  return [
    head(`${longDate(ap)} · ${city(ap)}`, hl, sub),
    go ? route : '',
    sec(changesBn),
    sec(() => legAlerts(S.legs)),
    risk,
    sec(() => delayCo(b)),
    sec(() => alertsFor([b.from, b.to])),
    sec(() => gateCard(b, {walk: go ? '' : walk, hint: find ? 'Recent gates vary, so don’t assume.' : '', risk: atRisk})),
    go ? '' : route,
    sec(() => lineCard([
      food && !atRisk && !go ? h`<div class="td-lnw">${stepLn(food, 2)}</div>` : '',
      linkRow(`#connect/${dir}`, 'route', 'Connection details', c ? (missed(c) ? c.text : `${N.dur(c.ground)} on the ground · ${levelTxt(c)}`) : ''),
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
// Best way from LGA to the hotel right now → #transit. Transit's own pick (N.bestRoute)
// wins when Transit shares it, so both screens name the same route.
function hotelRoute(prefix = 'Get to') {
  const routes = (guide().transit && guide().transit.to_hotel) || [];
  const tr = traffic('to_hotel');
  const ht = N.hotel();
  const dest = ht ? (ht.name || 'the hotel') : 'the hotel';
  const pick = transitPick('hotel');
  if (!routes.length && !pick) return linkRow('#transit', 'route', `${prefix} ${dest}`, 'Routes aren’t loaded yet · open Transit');
  let best = routes[0] || {}, why = '', mins = '';
  if (pick) {
    best = routes.find(r => r.id === pick.id || r.name === pick.name) || {};
    mins = typeof pick.mins === 'string' ? pick.mins : minsText(pick.mins);
  } else {
    if (tr && tr.min && tr.typical_min && tr.min > tr.typical_min * 1.35) {
      const alt = routes.find(r => !r.traffic_key && /subway|train|q70/i.test(`${r.id} ${r.name}`));
      if (alt) { best = alt; why = `Roads are slow (${tr.min} min by car), so ${alt.name} is steadier.`; }
    }
    mins = best.traffic_key && tr && tr.min ? `${tr.min} min now` : minsText(best.min);
  }
  const name = pick ? pick.name : best.name;
  return h`<a class="card sand td-a td-plan" href="#transit">
    <div class="${N.cls('td-planh', mins && 'td-planw')}"><div class="grow"><div class="ey">${prefix} ${dest}</div><div class="td-big">${name}</div></div>${mins ? h`<span class="chip td-lv tn">${mins}</span>` : ''}</div>
    <div class="td-rows">
      ${best.summary ? ln('route', best.summary) : ''}
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
  // The model counts a leg as down 30 min after its time even without a report: say "due" until one comes in.
  const down = !!(l.arr.actual || l.landed);
  const routes = dir === 'out' && (((guide().transit || {}).to_hotel || []).length || transitPick('hotel'));
  return [
    head(`${longDate(ap)} · ${port(ap)}`,
      down ? (dir === 'out' ? h`Landed at<br><b>${port(ap)}.</b>` : h`Landed in<br><b>${city(ap)}.</b>`)
        : h`Due at ${port(ap)}<br><b class="tn">${N.time(l.arr.time, ap)}.</b>`,
      down ? subLine([fno(l), `landed ${N.time(l.arr.time, ap)}`, termText(l.arr.terminal)], dot('td-dok'))
        : subLine([fno(l), 'landing not confirmed yet'], dot('neutral'))),
    sec(changesBn),
    sec(() => bagsCard(l)),
    dir === 'out' && sec(() => hotelRoute()),
    // The route card already covers getting out of the airport.
    dir === 'out' && ground && !routes ? sec(() => h`<div class="card line td-line td-pad">${stepLn(ground, 3)}</div>`) : '',
    dir === 'out' ? sec(() => tiles([wxTile(ap, null) || wxTile('NYC', null), hotelTile()])) : sec(() => vAfterRows()),
  ];
}
function vTrouble(S) {
  const l = S.leg, ap = l.from;
  const help = stepBy(ap, S.idx > 0 ? 'connect' : 'depart', 'alert-triangle', /wrong/i);
  // A diverted plane is no longer at the departure airport: the date follows the destination's zone.
  const dv = !l.canceled, zap = dv ? l.to : ap;
  return [
    head(dv ? `${longDate(zap)} · ${fno(l)}` : `${longDate(ap)} · ${placeOf(l)}`,
      l.canceled ? h`${fno(l)} is<br><b>canceled.</b>` : h`Diverted to<br><b>${l.diverted}.</b>`,
      statusLine(l)),
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
  // Transit's pick when it shares one, so Today and Transit name the same route.
  const pick = transitPick('lga');
  const best = pick ? {...(routes.find(r => r.id === pick.id || r.name === pick.name) || {}), name: pick.name, min: pick.mins} : routes[0];
  const mins = best ? (typeof best.min === 'string' ? best.min : minsText(best.min)) : '';
  const terminal = stepBy(ap, 'depart', 'door');
  const secStep = stepBy(ap, 'depart', 'shield-check', /security/i);
  return [
    head(`${longDate(ap)} · Travel day`, h`Flying home<br><b>today.</b>`, subLine(['Flight times not confirmed'], dot('td-dcau'))),
    sec(retFlag),
    sec(changesBn),
    sec(() => legAlerts(legs)),
    sec(() => alertsFor([ap, 'CLT'])),
    sec(() => h`<a class="card line td-a td-line td-legs" href="#flights">${legs.map(l => h`<div class="td-leg"><div class="grow"><b>${fno(l)}</b><small>${l.from} → ${l.to}</small></div><span class="td-warn">${l.dep.time ? tmz(l.dep.time, l.from) : 'Time not confirmed'}</span></div>`)}<span class="td-more">Both flights${icon('chevron-right')}</span></a>`),
    sec(() => h`<a class="card sand td-a td-plan" href="#transit">
      <div class="${N.cls('td-planh', mins && 'td-planw')}"><div class="grow"><div class="ey">Getting to ${ap}</div><div class="td-big">${best ? best.name : 'Hotel to the airport'}</div></div>${mins ? h`<span class="chip td-lv tn">${mins}</span>` : ''}</div>
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
// New York now and the next hours. With nothing saved there is nothing to say, so no card.
function nycWeather() {
  const code = (N.airportLive('NYC') || {}).wx ? 'NYC' : 'LGA';
  const w = (N.airportLive(code) || {}).wx;
  const n = nowMs();
  if (!w) return '';
  const cur = wxAt(code, null);
  // With a live reading on top, the hourly row starts after now so it never shows a second, different "Now".
  const live = cur && cur.kind === 'now';
  const hrs = (Array.isArray(w.hourly) ? w.hourly : []).filter(x => x && okT(x.t) && T(x.t) >= n - 30 * MIN && T(x.t) <= n + 12 * HOUR)
    .sort((a, b) => T(a.t) - T(b.t)).filter((x, i) => T(x.t) > n || (i === 0 && !live)).slice(0, 6);
  if (!cur && !hrs.length) return '';
  const upd = w.obs_at || w.updated;
  return h`<div class="card td-wx">
    <div class="td-planh"><div class="grow"><div class="ey">New York weather</div>
      ${cur ? h`<div class="td-wxnow"><span class="td-temp tn" data-k="wx-temp">${cur.temp != null ? `${cur.temp}°` : '—'}</span><span class="grow"><b>${cur.text || ''}</b><small>${meta([cur.kind === 'now' && cur.wind != null ? `Wind ${cur.wind} mph` : '', cur.precip != null ? `${cur.precip}% rain` : '', cur.kind === 'now' ? h`checked ${ago(upd)}` : `forecast for ${N.time(cur.at, 'NYC')}`])}</small></span></div>` : ''}
    </div>${cur ? h`<span class="td-wxi">${icon(wxIcon(cur.icon))}</span>` : ''}</div>
    ${hrs.length ? h`<div class="td-hrs">${hrs.map(x => h`<div class="td-hr"><small>${T(x.t) <= n ? 'Now' : N.time(x.t, 'NYC').replace(':00', '')}</small>${icon(hourIcon(x, code))}<b class="tn">${x.temp_f != null ? `${x.temp_f}°` : '—'}</b>${x.precip_pct >= 20 ? h`<span class="tn">${x.precip_pct}%</span>` : ''}</div>`)}</div>` : ''}
  </div>`;
}
function foodCard() {
  const f = foodNow();
  if (!f.total) return linkRow('#food', 'tools-kitchen-2', 'Food list', 'Not loaded yet · open Food to try again');
  const names = f.open.slice(0, 3).map(x => x.p.name + (x.away != null ? ` (${N.walkMin(x.away)} min)` : ''));
  const sub = f.open.length ? meta(names)
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
    ? subLine([`Flying home ${legDate(r1)}`, h`in ${until(r1.dep.time)}`])
    : retDate ? subLine([`Flying home ${dateOf(retDate)}`, left === 1 ? 'tomorrow' : left > 1 ? `in ${left} days` : 'today']) : '';
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
  // Only offer to clear Wallet when something is actually saved there.
  const w = N.wallet() || {};
  const saved = ['aa_code', 'aa_code_ret', 'hotel_code', 'hotel_name', 'hotel_address', 'notes'].some(k => w[k])
    || (Array.isArray(w.names) && w.names.some(Boolean))
    || Object.values(w.seats || {}).some(s => Array.isArray(s) && s.some(Boolean));
  return lineCard([
    linkRow('#flights', 'plane', 'Trip flights', 'Every leg and what happened'),
    saved ? linkRow('#wallet', 'wallet', 'Clear Wallet details', 'Names, codes and seats are stored only on this phone') : null,
  ]);
}
function vAfter() {
  const trip = N.trip() || {};
  const legs = N.legs();
  const nights = trip.start && trip.end ? dayDiff(trip.start, trip.end) : null;
  const range = trip.start && trip.end ? `${+trip.start.slice(8)}–${dateOf(trip.end).split(' ').slice(1).join(' ')}` : '';
  return [
    head(`${longDate('PHX')} · ${city(trip.home || 'PHX')}`, h`Welcome<br><b>home.</b>`, subLine([trip.title || 'New York', range])),
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
    if (s.mode === 'leavenow' && s.lv) k += `|late${lateBy(s.lv)}`;
    k += `|${compact(s)}|${homeLong(s)}`;
    if (s.mode === 'connect' && s.leg) k += `|${nowMs() >= T(s.leg.board)}`;
    if (s.leg) {
      const n = nowMs(), dep = T(s.leg.dep.time);
      k += `|${n >= dep - N.AA.bagdrop * MIN}|${n >= T(s.leg.board)}|${n >= T(s.leg.doors)}|${n >= dep}|${n > dep + 5 * MIN}`;
    }
  }
  const ci = checkin(ph === 'ret' || ph === 'stay' ? 'ret' : 'out');
  k += `|${ci ? ci.open : ''}|${N.fresh().level}`;
  if (ph === 'stay') k += `|${foodNow().open.length}|${N.hour(N.now(), 'NYC')}|${isNight('NYC', nowMs())}`;
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
    // Hide the check-in reminder for this flight on this phone.
    ciDismiss(t, ev, ctx, dir) {
      const c = checkin(dir === 'ret' ? 'ret' : 'out');
      if (c) N.set(CI_KEY, {dir: dir === 'ret' ? 'ret' : 'out', id: c.leg.id});
      N.rerender();
    },
  },
});
})();
