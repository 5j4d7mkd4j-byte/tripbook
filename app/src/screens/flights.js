/* Flights: both directions as tickets (#flights), one leg in detail
   (#flight/<legId>), the Charlotte connection (#connect/out|ret) and a cabin
   seat map drawn from the guide's layout (#seats/<legId>).
   Wallet seats are read with N.seats()/leg.seats and only ever shown here;
   nothing from the Wallet goes into a link or leaves the phone. */
(() => {
'use strict';
const {h, icon, raw} = N;
const T = v => v ? new Date(v).getTime() : NaN;
const okT = v => Number.isFinite(T(v));
const DIRS = ['out', 'ret'];
const AA_TRIPS = 'https://www.aa.com/reservation/view/find-your-trip';
const AA_STATUS = 'https://www.aa.com/travelInformation/flights/status';

// ---------- small helpers ----------
// Carrier and number joined by a no-break space, so the number never wraps away from the carrier.
const fno = l => `${l.carrier || 'AA'}\u00a0${l.num || String(l.flight || '').replace(/^\D+/, '')}`.trim();
const lc = s => String(s || '').toLowerCase();
const gd = () => N.data.guide || {};
const city = code => { const g = N.guideFor(code); return String(g && (g.city || g.short) || {PHX: 'Phoenix', CLT: 'Charlotte', LGA: 'New York'}[code] || code || '').replace(/\s*\(.*?\)\s*/g, ' ').trim(); };
const shortAp = code => { const g = N.guideFor(code); return g && g.short || city(code); };
// "MST", "EDT" for the airport on that date ('' if the browser only knows GMT offsets).
const tzAbbr = (ap, iso) => {
  try {
    const p = new Intl.DateTimeFormat('en-US', {timeZone: N.tz(ap), timeZoneName: 'short'}).formatToParts(iso ? new Date(iso) : N.now());
    const z = (p.find(x => x.type === 'timeZoneName') || {}).value || '';
    return /^(GMT|UTC)/.test(z) ? '' : z;
  } catch (e) { return ''; }
};
const sameDay = (a, b, ap) => !!a && !!b && N.ymd(a, ap) === N.ymd(b, ap);
// "4:31a" today, "Sun 2:31p" on another day (airport-local).
const when = (iso, ap) => !iso ? '' : sameDay(iso, N.now(), ap) ? N.time(iso, ap) : `${N.date(iso, ap).split(' ')[0]} ${N.time(iso, ap)}`;
const dayLong = (ymd) => ymd ? N.date(ymd + 'T16:00:00Z', 'NYC') : '';
const termLabel = t => t ? `Terminal ${t}` : '';
const gateLetter = g => { const m = String(g || '').trim().toUpperCase().match(/^([A-Z])\d/); return m ? m[1] : null; };
const concourse = (ap, gate) => {
  if (!gate) return '';
  const L = gateLetter(gate);
  if (L) return `Concourse ${L}`;
  const n = parseInt(gate, 10);
  if (ap === 'LGA' && n) return n >= 40 ? 'Eastern Concourse' : 'Western Concourse';
  return '';
};
const normSeat = s => String(s || '').toUpperCase().replace(/\s+/g, '');
// "Seats" when there is more than one seat or more than one traveller in the Wallet.
const pax = () => { try { const w = N.wallet() || {}; return Array.isArray(w.names) ? w.names.filter(n => String(n || '').trim()).length : 0; } catch (e) { return 0; } };
const seatWord = l => l.seats.length > 1 || pax() > 1 ? 'Seats' : 'Seat';
const dotCls = tone => tone === 'ok' ? '' : tone === 'neutral' ? 'neutral' : 'warn';
const chipCls = tone => tone === 'bad' ? 'rose' : tone === 'warn' ? 'warn' : '';

// The aircraft for a leg: guide entry (by code) plus a short display name.
const shortPlane = n => String(n || '').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\b(Passenger|Jet|Aircraft)\b/gi, '')
  .replace(/^(Airbus|Boeing|Embraer|Bombardier|Mitsubishi)\s+/i, '').replace(/\s+/g, ' ').trim();
const maker = n => { const m = String(n || '').match(/^(Airbus|Boeing|Embraer|Bombardier|Mitsubishi)\b/i); return m ? m[1] : ''; };
function plane(l) {
  const ac = gd().aircraft || {};
  const live = l && l.aircraft_code, planned = l && l.planned_code;
  const code = live && ac[live] ? live : planned && ac[planned] ? planned : live || planned || null;
  const info = code && ac[code] || null;
  const name = info && info.name || l && l.aircraft || '';
  return {code, info, name, short: shortPlane(name), maker: maker(name)};
}

// Merged legs with the planned aircraft code kept, so a live swap can be spotted.
function legsOf(dir) {
  const plan = N.data.trip && N.data.trip.legs || [];
  return N.dirLegs(dir).map(l => {
    const p = plan.find(x => x.id === l.id) || {};
    l.planned_code = p.aircraft_code || null;
    return l;
  });
}
function findLeg(id) {
  for (const d of DIRS) { const l = legsOf(d).find(x => x.id === id); if (l) return l; }
  return null;
}
const conn = dir => { try { return N.connection(dir); } catch (e) { return null; } };
const levelTone = c => !c ? 'neutral' : cxDone(c) ? 'neutral' : cxMade(c) || c.level === 'ok' ? 'ok' : c.level === 'tight' ? 'warn' : 'bad';

const nowMs = () => N.now().getTime();
// Checks can go quiet (no signal, updater asleep). A leg still "scheduled" 20+ min after
// its departure time has almost certainly left, so stop showing its gate and boarding time.
const dueGone = l => !!(l && l.state === 'scheduled' && !l.canceled && okT(l.dep && l.dep.time) && nowMs() > T(l.dep.time) + 20 * 60000);
// ...and once its arrival time has passed too, it should be on the ground.
const dueDown = l => dueGone(l) && okT(l.arr && l.arr.time) && nowMs() >= T(l.arr.time);
const isGone = l => !!l && (['air', 'landed', 'past'].includes(l.state) || dueGone(l));
// A per-leg stamp that changes whenever what we show for the leg should change.
const stamp = l => l ? `${l.state}${l.state === 'landed' && okT(l.arr && l.arr.time) && nowMs() - T(l.arr.time) >= 90 * 60000 ? '+' : ''}${dueDown(l) ? '>' : dueGone(l) ? '~' : ''}${l.state === 'boarding' && okT(l.doors) && nowMs() >= T(l.doors) ? 'd' : ''}` : '';
// Whole days from today (airport-local) to a leg's date: 0 today, negative once it's gone.
const dayDiff = (ymd, ap) => { const a = Date.parse(`${ymd}T00:00:00Z`), b = Date.parse(`${N.ymd(N.now(), ap)}T00:00:00Z`); return Number.isFinite(a) && Number.isFinite(b) ? Math.round((a - b) / 864e5) : 99; };
// "AA hasn't published times" wording that fits how far off the day is.
function unconfText(names, ymd, ap) {
  const dd = dayDiff(ymd, ap);
  if (dd < 0) return `No times came through for ${names} on ${dayLong(ymd)}. Your booking in the AA app or on aa.com has what you flew.`;
  const day = dd === 0 ? 'today' : `on ${dayLong(ymd)}`;
  const soon = dd > 3 ? ' They usually appear about 3 days ahead.' : '';
  return `AA hasn’t published times for ${names} ${day}.${soon} Your booking in the AA app or on aa.com has the times you were sold.`;
}

// N.legStatus, except a leg well past its arrival with no landing seen reads "Done",
// and one that went quiet after its departure time says where it should be.
const legSt = l => {
  if (l && l.state === 'past' && !l.canceled && !l.diverted && l.route_ok !== false) return {text: 'Done', tone: 'neutral'};
  if (dueGone(l) && l.route_ok !== false) return {text: dueDown(l) ? 'Likely landed' : 'Likely in the air', tone: 'neutral'};
  if (l && !l.dep.time && !l.canceled && l.route_ok !== false && dayDiff(l.date, l.from) < 0) return {text: 'No times saved', tone: 'neutral'};
  return N.legStatus(l);
};
// Its day went by and no times ever came through: talk about it in the past, not "yet".
const lapsed = l => !!(l && !l.dep.time && !l.canceled && dayDiff(l.date, l.from) < 0);
// Status chip, e.g. "On time · checked 4:31a".
function statusChip(l, withChecked, cls = '') {
  const s = legSt(l);
  const chk = withChecked && l.checked_at ? ` · checked ${when(l.checked_at, l.from)}` : '';
  return h`<span class="chip ${chipCls(s.tone)} ${cls}" data-k="st-${l.id}"><span class="dot ${dotCls(s.tone)}"></span>${s.text}${chk}</span>`;
}
const changesFor = id => { try { return N.changes().filter(c => c.leg.id === id); } catch (e) { return []; } };
const ext = (url, label, cls = '', ic = 'arrow-up-right') => url
  ? h`<a class="chip fl-lk ${cls}" href="${url}" target="_blank" rel="noopener">${label}${icon(ic)}</a>` : '';
const flightAware = l => l.num ? `https://www.flightaware.com/live/flight/AAL${encodeURIComponent(l.num)}` : null;

// Check-in opens 24 h before the first departure of a direction.
function checkin(legs) {
  const f = legs[0];
  if (!f) return null;
  const dep = f.dep.sched || f.dep.time;
  if (!dep && dayDiff(f.date, f.from) < 0) return null;
  if (!dep) return {text: 'Check-in opens 24 h before departure', sub: 'Times for this flight aren’t confirmed yet', state: 'unknown'};
  const at = N.addMin(dep, -1440), now = N.now().getTime();
  if (now >= T(f.dep.time || dep)) return null;
  const tz = tzAbbr(f.from, at);
  if (now >= T(at)) return {text: 'Check-in is open', sub: `Opened ${when(at, f.from)}${tz ? ' ' + tz : ''} · AA app or aa.com`, state: 'open'};
  return {text: `Check-in opens ${N.date(at, f.from)}, ${N.time(at, f.from)}${tz ? ' ' + tz : ''}`, sub: '24 h before · AA app or aa.com', state: 'soon', at};
}

// ---------- #flights ----------
function heroList(ctx) {
  const f = N.fresh();
  let next = N.nextLeg();
  const out = legsOf('out'), ret = legsOf('ret');
  const all = out.concat(ret);
  let ey, line, via = false;
  const now = nowMs();
  // When checks have gone quiet and the first leg should be on the ground, the onward
  // flight is what matters now.
  if (next && dueDown(next)) {
    const ls = legsOf(next.dir);
    const after = ls[ls.findIndex(x => x.id === next.id) + 1];
    if (after && after.state !== 'past') { next = after; via = true; }
  }
  // For a while after the last flight of a direction lands, the hero is about that arrival.
  const landed = justIn();
  // The check time reads in the zone of the leg the hero is about, as on that leg's page.
  const fz = landed ? landed.from : next ? next.from : f.window === 'ret' ? 'LGA' : 'PHX';
  // When the stale/offline strip is up it already says when flights were checked; one message is enough.
  const stripOn = (typeof N.unlocked !== 'function' || N.unlocked())
    && ((typeof N.online === 'function' && !N.online()) || (f.level === 'stale' && !!(f.window || f.hot)));
  const fresh = stripOn ? '' : h`<span class="chip ob"><span class="dot ${f.level === 'fresh' ? '' : f.level === 'neutral' ? 'neutral' : 'stale'}"></span>${f.at ? `Checked ${when(f.at, fz)}` : f.text}</span>`;
  if (!all.length) {
    ey = 'Flights'; line = h`<b>No flights saved</b> on this phone yet`;
  } else if (landed) {
    ey = `${fno(landed)} · ${landed.from} → ${landed.to}`;
    line = h`<b>Landed</b> in ${city(landed.to)} at <b class="tn">${N.time(landed.arr.time, landed.to)}</b>.${landed.arr.baggage
      ? h` Bags on <b data-k="hbag">carousel ${landed.arr.baggage}</b>.` : ''}`;
  } else if (!next) {
    ey = 'Flights'; line = h`<b>All flights done.</b> Welcome home.`;
  } else if (!next.dep.time) {
    const dd = dayDiff(next.date, next.from);
    const what = next.dir === 'out' ? 'The flight to New York' : 'The flight home';
    ey = `${dd < 0 ? '' : 'Next · '}${fno(next)} · ${dayLong(next.date)}`;
    line = dd < 0 ? h`${what} was on <b>${dayLong(next.date)}</b>. No times came through.`
      : dd === 0 ? h`${what} is <b>today</b>. Times not confirmed yet.`
      : h`${N.dirLabel(next.dir)} on <b>${dayLong(next.date)}</b>. Times not confirmed yet.`;
  } else if (next.state === 'air') {
    ey = `${fno(next)} · ${next.from} → ${next.to}`;
    line = h`In the air. Lands in ${city(next.to)} in <b class="tn"><span data-until="${next.arr.time}">${N.until(next.arr.time)}</span></b>`;
  } else if (next.state === 'boarding') {
    ey = `${fno(next)} · ${next.from} → ${next.to}`;
    const gate = next.dep.gate ? h` from gate <b>${next.dep.gate}</b>` : '';
    line = okT(next.doors) && T(next.doors) <= now
      ? h`${T(next.dep.time) > now ? 'Leaving' : 'Due to have left'}${gate} at <b class="tn">${N.time(next.dep.time, next.from)}</b>.`
      : h`<b>Boarding now</b>${next.dep.gate ? h` at gate <b>${next.dep.gate}</b>` : ''}. Doors close ${N.time(next.doors, next.from)}.`;
  } else if (next.canceled) {
    ey = `${fno(next)} · ${next.from} → ${next.to}`;
    line = h`<b>${fno(next)} is canceled.</b> Check the AA app for your new flight.`;
  } else if (next.diverted) {
    ey = `${fno(next)} · ${next.from} → ${next.to}`;
    line = h`<b>${fno(next)} diverted to ${next.diverted}.</b> Stay with the plane; the AA app shows the new plan.`;
  } else if (T(next.dep.time) <= now) {
    ey = `${fno(next)} · ${next.from} → ${next.to}`;
    line = !next.arr.time ? h`Due to have left ${city(next.from)}. Waiting for the next check.`
      : T(next.arr.time) <= now ? h`Due to have landed in ${city(next.to)} at <b class="tn">${N.time(next.arr.time, next.to)}</b>. Waiting for the next check.`
      : h`Due to have left ${city(next.from)}. Lands in ${city(next.to)} around <b class="tn">${N.time(next.arr.time, next.to)}</b>`;
  } else if (via && okT(next.board) && T(next.board) > now) {
    ey = `Connection · ${fno(next)} · ${next.from} → ${next.to}`;
    line = h`Change planes in ${city(next.from)}. ${fno(next)} boards in <b class="tn"><span data-until="${next.board}">${N.until(next.board)}</span></b>`;
  } else {
    // A countdown, worded so it can't be read as the flight's length.
    ey = `Next · ${fno(next)} to ${city(next.to)}`;
    line = h`Leaves ${city(next.from)} in <b class="tn"><span data-until="${next.dep.time}">${N.until(next.dep.time)}</span></b>`;
  }
  const leaves = !landed && next && next.dep.time && next.state === 'scheduled' && T(next.dep.time) > now;
  // The clock time (with the day when it isn't today); the headline already says "Leaves".
  const at = leaves ? h`<span class="chip ob tn">${icon('clock')}${via ? `${next.from} · ` : ''}${when(next.dep.time, next.from)} ${tzAbbr(next.from, next.dep.time)}</span>` : '';
  return h`<div class="fl-hero">
    <div class="ey">${ey}</div>
    <h1 class="hl">${line}</h1>
    ${fresh || at ? h`<div class="wrap fl-hchips">${fresh}${at}</div>` : ''}
  </div>`;
}

// The last leg of a direction, landed within the past 90 minutes.
const justIn = () => {
  const n = nowMs();
  return ['out', 'ret'].map(d => legsOf(d).slice(-1)[0])
    .find(l => l && l.state === 'landed' && okT(l.arr && l.arr.time) && n >= T(l.arr.time) && n - T(l.arr.time) < 90 * 60000) || null;
};
// Also the date, so "not confirmed yet" wording turns over at midnight.
const legsSig = () => { try { return N.legs().map(stamp).join(',') + N.ymd(N.now(), 'LGA'); } catch (e) { return ''; } };

function changesBanner() {
  let ch = [];
  try { ch = N.changes(); } catch (e) { ch = []; }
  if (!ch.length) return '';
  return h`<div class="bn fl-chg rise">${icon('alert-triangle')}<div class="grow">
      <b>Changed since you last looked</b>
      ${ch.slice(0, 5).map(c => h`<span>${String(c && c.text || '').replace(/\bAA(\d)/g, 'AA\u00a0$1')}</span>`)}
      <div class="bx"><button class="chip fl-btn" data-act="seen">${icon('check')}Got it</button></div>
    </div></div>`;
}

function ticket(l, i, n) {
  const s = legSt(l);
  const p = plane(l);
  const depOld = l.dep.est && l.dep.sched && Math.abs(N.mins(l.dep.sched, l.dep.est)) >= 5 ? N.time(l.dep.sched, l.from) : '';
  const arrOld = l.arr.est && l.arr.sched && Math.abs(N.mins(l.arr.sched, l.arr.est)) >= 5 ? N.time(l.arr.sched, l.to) : '';
  const dur = l.dep.time && l.arr.time ? N.dur(N.mins(l.dep.time, l.arr.time)) : '';
  const gate = l.dep.gate;
  const term = termLabel(l.dep.terminal);
  const anyOld = !!(depOld || arrOld);
  const old = v => v ? h`<s class="fl-old tn">${v}</s>` : anyOld ? h`<span class="fl-old ph" aria-hidden="true">·</span>` : '';
  const lateCls = (est, sched) => est && sched && N.mins(sched, est) >= 5 ? 'late' : '';
  const unknown = !l.dep.time;
  const label = `${fno(l)}, ${l.from} to ${l.to}, ${s.text}`;
  return h`<a class="fl-tk rise ${l.canceled ? 'bad' : ''}" href="#flight/${l.id}" style="animation-delay:${i * 60}ms" aria-label="${label}">
    <div class="fl-top"><span class="fl-no">${fno(l)}<span class="mu"> · Leg ${l.seq || i + 1} of ${n}</span></span>${statusChip(l)}</div>
    <div class="fl-mid">
      <div class="fl-end">
        <span class="dp fl-code">${l.from}</span>
        ${old(depOld)}
        <b class="tn fl-t ${depOld ? lateCls(l.dep.est, l.dep.sched) : ''}" data-k="dt-${l.id}">${unknown ? (lapsed(l) ? '—' : 'Time TBC') : N.time(l.dep.time, l.from)}</b>
        <small>${city(l.from)}${!unknown && tzAbbr(l.from, l.dep.time) ? ' · ' + tzAbbr(l.from, l.dep.time) : ''}</small>
      </div>
      <div class="fl-path" aria-hidden="true"><span class="fl-pl"><span class="fl-line"></span>${icon('plane')}</span><small class="tn">${dur}</small></div>
      <div class="fl-end r">
        <span class="dp fl-code">${l.to}</span>
        ${old(arrOld)}
        <b class="tn fl-t ${arrOld ? lateCls(l.arr.est, l.arr.sched) : ''}" data-k="at-${l.id}">${!l.arr.time ? (lapsed(l) ? '—' : 'Time TBC') : N.time(l.arr.time, l.to)}</b>
        <small>${city(l.to)}${l.arr.time && tzAbbr(l.to, l.arr.time) ? ' · ' + tzAbbr(l.to, l.arr.time) : ''}</small>
      </div>
    </div>
    <div class="fl-meta">
      <div><small>Gate${term ? ' · ' + term : ''}</small><b data-k="dg-${l.id}">${gate || '—'}</b></div>
      <div><small>${seatWord(l)}</small><b class="${l.seats.length ? '' : 'mu'}">${l.seats.length ? l.seats.join(' ') : 'Not added'}</b></div>
      <div><small>Aircraft</small><b class="${p.short ? '' : 'mu'}">${p.short || 'Not known'}</b></div>
    </div>
  </a>`;
}

// A canceled or diverted leg makes the connection moot; say that instead of a level.
// Once the onward flight has left, the connection was made; the level no longer matters.
const cxMade = c => !!(c && c.b && !c.b.canceled && (c.b.dep && c.b.dep.actual || ['air', 'landed'].includes(c.b.state)));
// With no live word either way, once the onward flight's departure time is well past the
// connection is behind you: say "Done" rather than keep a level that no longer applies.
const cxDone = c => !!(c && c.a && c.b && !c.a.canceled && !c.b.canceled && !c.a.diverted && !cxMade(c) && (c.b.state === 'past' || dueGone(c.b)));
const cxText = c => c && c.a && c.b && (c.a.canceled || c.b.canceled) ? 'Canceled' : c && c.a && c.a.diverted ? 'Diverted' : cxMade(c) ? 'Made it' : cxDone(c) ? 'Done' : c ? c.text : '';
const cxBad = c => !!(c && c.a && c.b && (c.a.canceled || c.b.canceled || c.a.diverted));
// Walking time only helps while the connection is still ahead and on.
const cxQuiet = c => cxMade(c) || cxDone(c) || cxBad(c);
const cxLevel = c => cxMade(c) ? 'ok' : cxDone(c) ? 'neutral' : c ? c.level : 'neutral';

// Tint for the connection row and chip: rose only when it is at risk (or the plan fell through).
const cxCls = c => !c ? 'neutral' : cxBad(c) ? 'risk' : cxLevel(c);
const spareText = c => c.spare >= 0 ? `${c.spare} min to spare` : `${-c.spare} min short`;

// One connection row, used between the tickets (#flights) and on each leg's page (#flight/<leg>).
// On a leg's page (l given) the second line also says when the other flight boards or lands.
function cxRow(dir, legs, l) {
  if (legs.length < 2) return '';
  const c = conn(dir);
  const at = legs[0].to;
  let title, sub;
  if (!c) {
    const old = legs.some(lapsed);
    title = `Change in ${city(at)}`;
    sub = old ? 'No connection times came through' : 'Times not published yet';
  } else {
    title = h`Change in ${city(at)} · <span class="tn">${N.dur(c.ground)}</span>`;
    const lv = h`<span class="cx-lv">${cxText(c)}</span>`;
    let g = '';
    if (l) {
      const isFirst = l.id === legs[0].id;
      const other = isFirst ? legs[1] : legs[0];
      g = isFirst
        ? isGone(other) && !other.canceled ? `${fno(other)} left ${N.time(c.b.dep.time, at)}${c.b.dep.gate ? ` from ${c.b.dep.gate}` : ''}`
          : `${fno(other)} boards ${N.time(c.b.board, at)}${c.b.dep.gate ? ` at ${c.b.dep.gate}` : ''}`
        : `${fno(other)} ${other.state === 'landed' ? 'landed' : other.state === 'past' || dueDown(other) ? 'was due' : 'lands'} ${N.time(c.a.arr.time, at)}${c.a.arr.gate ? ` at ${c.a.arr.gate}` : ''}`;
    }
    sub = h`${lv}${g ? ` · ${g}` : cxQuiet(c) ? '' : ` · ${spareText(c)}`}`;
  }
  return h`<a class="fl-cx ${cxCls(c)}" href="#connect/${dir}"><span class="ic">${icon('arrows-exchange')}</span><div class="grow">
      <b data-k="cx-${dir}">${title}</b><small class="tn">${sub}</small></div>${icon('chevron-right')}</a>`;
}

function dirNote(dir, legs) {
  const odd = legs.filter(l => l.route_ok === false);
  const unconf = legs.filter(l => !l.dep.time || l.confirmed === false && !l.live);
  if (odd.length) {
    return h`<div class="bn neutral fl-note">${icon('alert-circle')}<div class="grow">
      <b>Needs checking</b>
      ${odd.map(l => h`<span>${fno(l)} was last seen flying ${String(l.route_seen || 'a different route').replace(/-/g, '–')}, not ${l.from}–${l.to}.</span>`)}
      <span>Flight numbers often change when the winter schedule starts on 25 Oct. Check Trips in the AA app or on aa.com for the flights you’re actually booked on.</span>
      <div class="bx">${ext(AA_TRIPS, 'Trips on aa.com')}</div></div></div>`;
  }
  if (unconf.length) {
    return h`<div class="bn neutral fl-note">${icon('info-circle')}<div class="grow">
      <b>${dayDiff(unconf[0].date, unconf[0].from) < 0 ? 'No times saved' : 'Not confirmed yet'}</b>
      <span>${unconfText(unconf.map(fno).join(' and '), unconf[0].date, unconf[0].from)}</span>
      <div class="bx">${ext(AA_TRIPS, 'Trips on aa.com')}</div></div></div>`;
  }
  return '';
}

function dirSection(dir, done) {
  const legs = legsOf(dir);
  if (!legs.length) return '';
  const first = legs[0], last = legs[legs.length - 1];
  const total = first.dep.time && last.arr.time ? N.mins(first.dep.time, last.arr.time) : null;
  const via = legs.slice(0, -1).map(l => l.to).join(', ');
  const ci = checkin(legs);
  const tzD = tzAbbr(first.from, first.dep.time), tzA = tzAbbr(last.to, last.arr.time);
  const head = h`<div class="fl-dh"><div class="grow"><div class="ey">${dir === 'out' ? 'Outbound' : 'Return'} · ${dayLong(first.date)}</div>
      <h2 class="h2">${N.dirLabel(dir)}</h2></div>${done ? h`<span class="chip cr">${icon('check')}Done</span>` : ''}</div>`;
  // Before AA publishes any times, one card says so once instead of a row of dashes and TBCs.
  const waiting = !done && !legs.some(l => l.dep.time) && !legs.some(l => lapsed(l) || l.canceled || l.diverted || l.route_ok === false);
  if (waiting) {
    return h`<section class="sec fl-dir">${head}
      <a class="fl-tbc rise" href="#flight/${first.id}"><span class="ic">${icon('calendar-time')}</span><div class="grow">
        <b>${legs.map(fno).join(' + ')}${via ? ` via ${via}` : ''}</b><small>Times not published yet</small></div>${icon('chevron-right')}</a>
    </section>`;
  }
  return h`<section class="sec fl-dir ${done ? 'done' : ''}">
    ${head}
    <div class="cn fl-sum">
      <div><small>Total</small><b class="tn">${total != null ? N.dur(total) : '—'}</b><span>${via ? `via ${via}` : 'Nonstop'}</span></div>
      <div><small>Leaves</small><b class="tn">${first.dep.time ? N.time(first.dep.time, first.from) : '—'}</b><span>${first.from}${tzD ? ' · ' + tzD : ''}</span></div>
      <div><small>Lands</small><b class="tn">${last.arr.time ? N.time(last.arr.time, last.to) : '—'}</b><span>${last.to}${tzA ? ' · ' + tzA : ''}</span></div>
    </div>
    ${dirNote(dir, legs)}
    <div class="fl-legs">
      ${legs.map((l, i) => h`${i ? cxRow(dir, legs) : ''}${ticket(l, i, legs.length)}`)}
    </div>
    ${ci && !done ? h`<div class="rw c fl-ci"><span class="ic">${icon(ci.state === 'open' ? 'circle-check' : 'ticket')}</span><div class="grow"><b>${ci.text}</b><small>${ci.sub}</small></div></div>` : ''}
  </section>`;
}

// Core's rerender() drops 'force' unless it is listed in `uses`.
const USES = ['trip', 'guide', 'status', 'force'];

N.screen('flights', {
  nav: 1,
  uses: USES,
  tone: 'band',
  title: 'Flights',
  render(ctx) {
    if (!N.data.trip) {
      return {hero: h`<div class="fl-hero"><div class="ey">Flights</div><h1 class="hl"><b>No trip data</b> on this phone yet</h1></div>`,
        body: h`<div class="fl"><div class="co plain">${icon('info-circle')}<span>Open the app once with a signal to load the trip. After that it works offline.</span></div></div>`};
    }
    const ph = N.phase();
    const doneOut = ['stay', 'ret', 'after'].includes(ph) && legsOf('out').every(l => l.state === 'landed' || l.state === 'past');
    const order = doneOut ? ['ret', 'out'] : ['out', 'ret'];
    return {
      hero: heroList(ctx),
      body: h`<div class="fl">${changesBanner()}${N.alerts ? N.alerts.nudge() : ''}${order.map(d => dirSection(d, d === 'out' && doneOut))}
        <div class="sec wrap fl-foot">
          <button class="chip cr fl-btn" data-act="go" data-arg="calendar">${icon('calendar-plus')}Add to Calendar</button>
          <button class="chip cr fl-btn" data-act="go" data-arg="wallet/seats">${icon('wallet')}Seats in Wallet</button>
        </div></div>`,
    };
  },
  mount() { this._sig = legsSig(); },
  tick() { const s = legsSig(); if (this._sig && s !== this._sig) { this._sig = s; N.rerender(); } },
  actions: {
    seen() { try { N.markSeen(); } catch (e) { N.report(e, 'markSeen'); } N.rerender(); },
  },
});

// ---------- #flight/<legId> ----------
function legBanners(l, ch) {
  const out = [];
  const trips = ext(AA_TRIPS, 'Trips on aa.com');
  const call = h`<a class="chip fl-lk" href="tel:+18004337300">${icon('phone')}Call AA</a>`;
  if (l.canceled) {
    out.push(h`<div class="bn fx-bn">${icon('alert-triangle')}<div class="grow"><b>${fno(l)} is canceled</b>
      <span>AA usually rebooks you on its own. In the AA app a blue banner means AA is rebooking you; green means you can pick a new flight yourself. Checked bags follow the new booking.</span>
      <div class="bx">${trips}${call}</div></div></div>`);
  } else if (l.diverted) {
    out.push(h`<div class="bn fx-bn">${icon('alert-triangle')}<div class="grow"><b>Diverted to ${l.diverted}</b>
      <span>Stay with the plane and follow the crew. If you miss a connection, AA rebooks you and your bags follow. Watch the AA app for the new plan.</span>
      <div class="bx">${trips}${call}</div></div></div>`);
  }
  if (l.route_ok === false) {
    out.push(h`<div class="bn neutral fx-bn">${icon('alert-circle')}<div class="grow"><b>Needs checking</b>
      <span>On its last check ${fno(l)} was flying ${String(l.route_seen || 'a different route').replace(/-/g, '–')}, not ${l.from}–${l.to}. Flight numbers often change when the winter schedule starts on 25 Oct. Confirm this flight in Trips in the AA app or on aa.com.</span>
      <div class="bx">${trips}</div></div></div>`);
  } else if (!l.dep.time || l.confirmed === false && !l.live) {
    out.push(h`<div class="bn neutral fx-bn">${icon('info-circle')}<div class="grow"><b>${dayDiff(l.date, l.from) < 0 ? 'No times saved' : 'Not confirmed yet'}</b>
      <span>${unconfText(fno(l), l.date, l.from)}</span>
      <div class="bx">${trips}</div></div></div>`);
  }
  if (l.fetch_failed) {
    out.push(h`<div class="bn neutral fx-bn">${icon('wifi-off')}<div class="grow"><b>Couldn’t check this flight just now</b>
      <span>Showing the planned times${l.checked_at ? ` and the last good check from ${when(l.checked_at, l.from)}` : ''}. The AA app has the latest gate.</span></div></div>`);
  }
  if (!l.canceled && !l.diverted && l.live) {
    const lines = [];
    const gone = isGone(l);
    if (gone) ch = ch.filter(c => c.k === 'ag' || c.k === 'bg');
    const late = !gone && l.delay_dep > 14 && l.dep.est;
    if (late) lines.push(`Departs ${N.dur(l.delay_dep)} late, now ${N.time(l.dep.est, l.from)}`);
    ch.forEach(c => { if (c.k !== 'd' || !late) lines.push(c.text.replace(fno(l).replace(/\s/, ''), '').trim().replace(/^./, m => m.toUpperCase())); });
    if (lines.length) {
      const cause = l.status_detail && !/^(on time|scheduled)$/i.test(l.status_detail) ? l.status_detail : '';
      out.push(h`<div class="bn fx-bn">${icon('alert-triangle')}<div class="grow"><b>${lines[0]}</b>
        ${lines.slice(1).map(t => h`<span>${t}</span>`)}${cause ? h`<span>${cause}</span>` : ''}</div></div>`);
    }
  }
  return out;
}

function inboundRow(l) {
  const ib = l.inbound;
  if (!ib || l.departed || isGone(l) || l.canceled || l.diverted) return '';
  const st = String(ib.status || '');
  const here = /land|arriv/i.test(st);
  const t = ib.est && okT(ib.est) ? when(ib.est, l.from) : '';
  const from = !ib.from ? 'its last stop' : city(ib.from) && city(ib.from) !== ib.from ? `${city(ib.from)} (${ib.from})` : ib.from;
  const fl = ib.flight ? ib.flight.replace(/^AA(\d)/, 'AA\u00a0$1') : '';
  const late = !here && t && nowMs() > T(ib.est);
  // Only say "on its way" once the inbound flight has actually left; a Scheduled one has not.
  const going = /route|depart|air|active/i.test(st);
  const as = fl ? ` as ${fl}` : '';
  const title = here ? 'Your plane is here' : late ? `Your plane is due in${as}` : going ? `Your plane is on its way${as}` : `Your plane comes in${as}`;
  const sub = here ? `Landed from ${from}${t ? ` · ${t}` : ''}` : late ? `From ${from} · was due ${t} · no landing reported yet` : `From ${from}${t ? ` · due ${t}` : ''}${st ? ` · ${st}` : ''}`;
  return h`<div class="fx-row"><span class="ic">${icon(here ? 'circle-check' : 'plane-arrival')}</span><div class="grow"><b>${title}</b><small class="tn" data-k="ib-${l.id}">${sub}</small></div></div>`;
}

function arrivalRow(l, legs) {
  const last = l.id === legs[legs.length - 1].id;
  // A canceled or diverted flight won't arrive here as planned; the banner says what to do.
  if (!last || l.canceled || l.diverted) return '';
  const term = termLabel(l.arr.terminal);
  const where = [term, l.arr.gate ? `Gate ${l.arr.gate}` : ''].filter(Boolean).join(' · ');
  if (l.arr.baggage) {
    return h`<div class="fx-row"><span class="ic">${icon('luggage')}</span><div class="grow"><b data-k="bgr-${l.id}">Bags: carousel ${l.arr.baggage}</b><small data-k="agr-${l.id}">${[shortAp(l.to), where].filter(Boolean).join(' · ')}</small></div></div>`;
  }
  // Keys differ from the tiles' "ag-" so core's change flash doesn't pair the wrong nodes.
  const over = l.state === 'past' || dueDown(l) || lapsed(l);
  const note = l.state === 'landed' ? 'Carousel not posted yet. The AA app and the screens at claim show it.' : over ? '' : 'The carousel posts around landing. The AA app shows it.';
  const w = where ? h`<span data-k="agr-${l.id}">${where}</span>` : '';
  const n = note ? h`<span data-k="bgr-${l.id}">${note}</span>` : '';
  return h`<div class="fx-row"><span class="ic">${icon('luggage')}</span><div class="grow"><b>${over ? shortAp(l.to) : `Arrive ${shortAp(l.to)}`}</b>${w || n ? h`<small>${w}${w && n ? '. ' : ''}${n}</small>` : ''}</div></div>`;
}

function eventsLog(l) {
  const ev = (l.events || []).filter(e => e && e.text).slice().sort((a, b) => (T(b.at) || 0) - (T(a.at) || 0));
  if (!ev.length) return '';
  return h`<div class="sec"><div class="ey">Changes</div><div class="fx-log">
    ${ev.slice(0, 12).map(e => h`<span class="tn mu">${e.at ? when(e.at, l.from) : ''}</span><span>${e.text}</span>`)}
  </div></div>`;
}

function timesGrid(l) {
  const depOld = l.dep.est && l.dep.sched && Math.abs(N.mins(l.dep.sched, l.dep.est)) >= 5 ? N.time(l.dep.sched, l.from) : '';
  const arrOld = l.arr.est && l.arr.sched && Math.abs(N.mins(l.arr.sched, l.arr.est)) >= 5 ? N.time(l.arr.sched, l.to) : '';
  const div = l.diverted && !l.canceled && !l.arr.actual;
  const dur = div ? `To ${l.diverted}` : l.dep.time && l.arr.time ? N.dur(N.mins(l.dep.time, l.arr.time)) : lapsed(l) ? 'No times saved' : 'Not confirmed';
  let pos = 50;
  if ((l.state === 'air' || dueGone(l)) && l.dep.time && l.arr.time) {
    pos = N.clamp((N.now() - T(l.dep.time)) / (T(l.arr.time) - T(l.dep.time)) * 100, 6, 94);
  } else if (l.state === 'landed' || l.state === 'past') pos = 94;
  else if (div && l.dep.actual) pos = 50;
  else pos = 6;
  const tzD = tzAbbr(l.from, l.dep.time || l.date + 'T16:00:00Z'), tzA = tzAbbr(l.to, l.arr.time || l.date + 'T16:00:00Z');
  const off = l.canceled && !l.dep.actual;
  const depWord = off ? 'Was to leave' : l.dep.actual ? 'Took off' : l.dep.est && depOld ? 'Now' : 'Departs';
  const arrWord = off || div ? 'Was to land' : l.arr.actual ? 'Landed' : l.arr.est && arrOld ? 'Now' : 'Arrives';
  return h`<div class="fx-times ${off ? 'off' : ''}">
    <div><small class="fx-tw">${depOld ? h`<s class="tn">${depOld}</s> ` : ''}${depWord}</small><div class="tn fx-t" data-k="dt-${l.id}">${l.dep.time ? N.time(l.dep.time, l.from) : '—'}</div><small class="fx-tz">${l.from}${tzD ? ' · ' + tzD : ''}</small></div>
    <div class="fx-mid" aria-hidden="true"><div class="fx-dash"><span style="left:${pos.toFixed(1)}%">${icon('plane-inflight')}</span></div><small class="tn">${dur}</small></div>
    <div class="r ${div ? 'fx-x' : ''}"><small class="fx-tw">${arrOld && !div ? h`<s class="tn">${arrOld}</s> ` : ''}${arrWord}</small><div class="tn fx-t" data-k="at-${l.id}">${l.arr.time ? N.time(l.arr.time, l.to) : '—'}</div><small class="fx-tz">${l.to}${tzA ? ' · ' + tzA : ''}</small></div>
  </div>`;
}

function tiles(l, ch) {
  const p = plane(l);
  const term = termLabel(l.dep.terminal);
  const gone = isGone(l);
  const over = l.state === 'past' || dueDown(l);
  const gateRing = ch.some(c => c.k === (gone ? 'ag' : 'dg') || !gone && c.k === 'dt');
  const timeRing = !gone && (ch.some(c => c.k === 'd') || l.delay_dep > 14);
  const conc = concourse(l.from, l.dep.gate);
  const gateSub = l.dep.gate ? conc || (term ? termLabel(l.dep.terminal) : '') : l.dep.time ? 'Posts closer to departure' : lapsed(l) ? 'Not recorded' : 'Not known yet';
  const seats = l.seats;
  const seatTile = seats.length
    ? h`<div class="tile"><small>${seatWord(l)}</small><b class="tn">${seats.join(' ')}</b><small>${icon('lock')} From Wallet</small></div>`
    : h`<a class="tile fx-tl" href="#wallet/seats/${l.id}"><small>${seatWord(l)}</small><b class="mu">—</b><small class="fx-ln">Add in Wallet ${icon('chevron-right')}</small></a>`;
  const acTile = p.short || p.info
    ? h`<a class="tile fx-tl" href="#seats/${l.id}"><small>Aircraft</small><b>${p.short || p.code}</b><small class="fx-ln">Seat map ${icon('chevron-right')}</small></a>`
    : h`<div class="tile"><small>Aircraft</small><b class="mu">—</b><small>${lapsed(l) ? 'Not recorded' : 'Not known yet'}</small></div>`;
  const aTerm = termLabel(l.arr.terminal);
  const first = l.diverted && !l.canceled && l.dep.actual && !l.arr.actual
    ? h`<div class="tile ring"><small>Diverted to</small><b>${l.diverted}</b><small>${city(l.diverted) !== l.diverted ? city(l.diverted) : `Instead of ${l.to}`}</small></div>
      <div class="tile"><small>Took off</small><b class="tn">${l.dep.time ? N.time(l.dep.time, l.from) : '—'}</b><small>${l.from}${tzAbbr(l.from, l.dep.time) ? ' · ' + tzAbbr(l.from, l.dep.time) : ''}</small></div>`
    : gone
    ? h`<div class="tile ${gateRing ? 'ring' : ''}"><small>${l.to} gate${aTerm ? ' · ' + aTerm : ''}</small><b data-k="ag-${l.id}">${l.arr.gate || '—'}</b><small>${l.arr.gate ? concourse(l.to, l.arr.gate) || 'Arrival gate' : l.state === 'past' ? 'Not recorded' : over ? 'Not known' : 'Not posted yet'}</small></div>
      <div class="tile"><small>${l.arr.actual ? 'Landed' : l.state === 'air' ? 'Lands' : l.state === 'landed' ? 'Arrived' : over ? 'Was due' : 'Due to land'}</small><b class="tn">${l.arr.time ? N.time(l.arr.time, l.to) : '—'}</b><small class="tn">${l.dep.actual && l.dep.time ? `Took off ${N.time(l.dep.time, l.from)}` : l.to}</small></div>`
    : l.canceled
    ? h`<div class="tile fx-off"><small>Gate${term ? ' · ' + term : ''}</small><b data-k="dg-${l.id}">${l.dep.gate || '—'}</b><small>${l.dep.gate ? 'Was the gate' : 'No gate'}</small></div>
      <div class="tile fx-off"><small>Boards</small><b>—</b><small>Not boarding</small></div>`
    : h`<div class="tile ${gateRing ? 'ring' : ''}"><small>Gate${term ? ' · ' + term : ''}</small><b data-k="dg-${l.id}">${l.dep.gate || '—'}</b><small>${gateSub}</small></div>
      <div class="tile ${timeRing ? 'ring' : ''}"><small>Boards</small><b class="tn" data-k="bd-${l.id}">${l.board ? N.time(l.board, l.from) : '—'}</b><small class="tn">${l.doors ? `Doors close ${N.time(l.doors, l.from)}` : lapsed(l) ? 'Not recorded' : 'About 40 min before'}</small></div>`;
  return h`<div class="tiles fx-tiles">
    ${first}${seatTile}${acTile}
  </div>`;
}

N.screen('flight', {
  nav: 1,
  uses: USES,
  back: 'flights',
  tone: 'band',
  title: ctx => { const l = findLeg(ctx.param); return l ? `${fno(l)} ${l.from}–${l.to}` : 'Flight'; },
  render(ctx) {
    const l = findLeg(ctx.param);
    if (!l) {
      // With no trip loaded at all, say so; "removed in an update" would send a traveller looking for a change that never happened.
      const none = !N.data.trip;
      return {hero: h`<div class="fx-h"><div class="ey">Flight</div><h1 class="hl">${none ? h`<b>No trip data</b> on this phone yet` : h`<b>That flight isn’t</b> on this trip`}</h1></div>`,
        body: h`<div class="fx"><p class="small mu fx-nf">${none ? 'Open the app once with a signal to load the trip. After that it works offline.' : 'It may have been removed in a trip update.'}</p><a class="btn" href="#flights">${icon('plane')}All flights</a></div>`};
    }
    const legs = legsOf(l.dir);
    const idx = legs.findIndex(x => x.id === l.id);
    const last = idx === legs.length - 1;
    const ch = changesFor(l.id);
    const onward = !last && legs[idx + 1];
    // Plain words for where this leg fits: "<from> to <via>, then <next flight> to <city>".
    const lede = `${city(l.from)} to ${city(l.to)}${onward ? `, then ${fno(onward)} to ${city(onward.to)}` : ''}`;
    const guides = [l.from, l.to].filter(c => N.guideFor(c));
    const hero = h`<div class="fx-h">
      <div class="ey">${N.dirLabel(l.dir)} · ${fno(l)} · Leg ${idx + 1} of ${legs.length}</div>
      <div class="fx-codes" aria-label="${l.from} to ${l.to}">
        <span class="dp fx-from">${l.from}</span>${icon('arrow-right')}<span class="dp fx-to">${l.to}</span>
      </div>
      <p class="fx-lede">${lede}</p>
      <div class="fx-stat">${statusChip(l, true)}</div>
    </div>`;
    return {hero, body: h`<div class="fx">
      ${legBanners(l, ch).map(b => h`<div class="fx-gap">${b}</div>`)}
      ${timesGrid(l)}
      ${tiles(l, ch)}
      <div class="stack8 fx-rows">${inboundRow(l)}${cxRow(l.dir, legs, l)}${arrivalRow(l, legs)}</div>
      ${eventsLog(l)}
      <div class="sec wrap fx-links">
        ${guides.map((c, i) => h`<a class="chip fl-lk ${i ? 'cr2' : 'dk2'}" href="#airport/${lc(c)}">${icon('map')}${shortAp(c)} guide</a>`)}
        ${ext(flightAware(l), 'FlightAware', 'cr2')}
        ${ext(AA_STATUS, 'aa.com status', 'cr2')}
      </div>
      ${l.source_note && l.live ? h`<p class="small mu fx-src">Source note: ${l.source_note}</p>` : ''}
    </div>`};
  },
  mount(ctx) {
    // Viewing a leg counts as seeing its changes; the banner stays until the next render.
    const l = findLeg(ctx.param);
    if (l && l.live) { try { N.markSeen([l.id]); } catch (e) { N.report(e, 'markSeen'); } }
    this._st = stamp(l);
  },
  tick(ctx) {
    const l = findLeg(ctx.param);
    const st = stamp(l);
    if (l && this._st && st !== this._st) { this._st = st; N.rerender(); return; }
    // keep the plane marker moving while in the air
    if (l && (l.state === 'air' || dueGone(l))) {
      const m = document.querySelector('.fx-dash > span');
      if (m && l.dep.time && l.arr.time) m.style.left = N.clamp((N.now() - T(l.dep.time)) / (T(l.arr.time) - T(l.dep.time)) * 100, 6, 94).toFixed(1) + '%';
    }
  },
});

// ---------- #connect/out|ret ----------
const HUB = {A: [18, 90], B: [54, 28], C: [126, 28], D: [162, 90], E: [126, 152]};
function hubSvg(arrG, depG) {
  const a = gateLetter(arrG), d = gateLetter(depG);
  const hot = new Set([a, d].filter(k => k && HUB[k]));
  const spokes = Object.entries(HUB).map(([k, [x, y]]) => `<path d="M90 90L${x} ${y}"${hot.has(k) ? ' class="cx-hot"' : ''}/>`).join('');
  const dots = Object.entries(HUB).map(([k, [x, y]]) =>
    `<circle cx="${x}" cy="${y}" r="13" class="${hot.has(k) ? 'cx-on' : 'cx-off'}"/><text x="${x}" y="${y + 5}" class="${hot.has(k) ? 'cx-ont' : ''}">${k}</text>`).join('');
  return raw(`<svg class="il cx-hub" viewBox="0 0 180 180" aria-hidden="true"><g class="lk" stroke-width="7" stroke-linecap="round">${spokes}</g>
    <circle cx="90" cy="90" r="22" class="cx-core"/><g class="cx-txt" text-anchor="middle">${dots}</g></svg>`);
}

function timeline(c) {
  const at = c.a.to;
  const land = c.a.arr.time, board = c.b.board, doors = c.b.doors, dep = c.b.dep.time;
  if (![land, board, doors, dep].every(okT)) return '';
  const t0 = Math.min(T(land), T(board)), t1 = Math.max(T(dep), T(land));
  const pct = t => N.clamp((T(t) - t0) / Math.max(1, t1 - t0) * 100, 0, 100);
  const pl = pct(land), pb = pct(board), pd = pct(doors);
  const bar = h`<div class="cx-barw"><div class="cx-bar">
      <span class="cx-s1" style="width:${pb.toFixed(1)}%"></span><span class="cx-s2" style="width:${Math.max(0, pd - pb).toFixed(1)}%"></span><span class="hatch cx-s3" style="width:${Math.max(0, 100 - pd).toFixed(1)}%"></span>
    </div><span class="cx-mk" style="left:${pd.toFixed(1)}%"></span>${pl > 1 ? h`<span class="cx-mk land" style="left:${pl.toFixed(1)}%"></span>` : ''}</div>`;
  const pts = [['Land', land, pl], ['Board', board, pb], ['Doors', doors, pd], ['Dep', dep, pct(dep)]];
  // Each label sits on its own tick: centred on it, or starting/ending at it near the bar's ends.
  // Land and Doors above the bar, Board and Dep below. About 20% of the bar per label.
  const W = 20, GAP = 2;
  const span = p => p < 9 ? [p, p + W] : p > 91 ? [p - W, p] : [p - W / 2, p + W / 2];
  const clear = (i, j) => { const x = span(pts[i][2]), y = span(pts[j][2]); return x[1] + GAP <= y[0] || y[1] + GAP <= x[0]; };
  const lv = c.level === 'risk' || cxBad(c) ? 'risk' : '';
  if (clear(0, 2) && clear(1, 3)) {
    const lab = (i, below) => {
      const p = pts[i][2];
      const st = `left:${p.toFixed(1)}%;transform:translateX(${p < 9 ? '0' : p > 91 ? '-100%' : '-50%'});text-align:${p < 9 ? 'left' : p > 91 ? 'right' : 'center'}`;
      return h`<span class="${i === 2 ? 'cx-doors' : ''}" style="${st}">${below ? '' : h`<small>${pts[i][0]}</small>`}<b class="tn">${N.time(pts[i][1], at)}</b>${below ? h`<small>${pts[i][0]}</small>` : ''}</span>`;
    };
    return h`<div class="cx-tl ${lv}">
      <div class="cx-up">${lab(0)}${lab(2)}</div>
      ${bar}
      <div class="cx-dn">${lab(1, 1)}${lab(3, 1)}</div>
    </div>`;
  }
  // Columns follow the bar left to right, so a late landing (after boarding starts) reads in time order.
  const cols = pts.map((p, i) => [p, i]).sort((x, y) => T(x[0][1]) - T(y[0][1]) || x[1] - y[1]);
  return h`<div class="cx-tl ${lv}">${bar}<div class="cx-grid">${cols.map(([p, i]) => h`<div class="${i === 2 ? 'cx-doors' : ''}"><small>${p[0]}</small><b class="tn">${N.time(p[1], at)}</b></div>`)}</div></div>`;
}

function foodNear(ap, gate) {
  const g = N.guideFor(ap);
  const list = g && Array.isArray(g.food) ? g.food.filter(f => f && f.name) : [];
  const L = gateLetter(gate);
  const re = L ? new RegExp(`\\b${L}(\\d|\\b)`) : null;
  const score = f => { const t = `${f.near || ''} ${f.where || ''}`; return re && re.test(t) ? 0 : /atrium|central|food court/i.test(t) ? 1 : 2; };
  return list.map((f, i) => [score(f), i, f]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).slice(0, 3).map(x => x[2]);
}

// Weather and FAA at the connecting airport. Days ahead, the updater's forecast for the
// leg time (wx.legs, when present) beats "right now"; FAA only matters on the day or when not normal.
function wxChip(code, ids, dir) {
  const a = N.airportLive(code) || {};
  const wx = a.wx || {}, faa = a.faa || {};
  const parts = [];
  const fc = (Array.isArray(wx.legs) ? wx.legs : []).find(x => x && ids.includes(x.leg) && x.temp_f != null && okT(x.t));
  const useFc = fc && T(fc.t) - N.now().getTime() > 2 * 3600e3;
  // "Right now" weather only means something on the travel day itself.
  const w = useFc ? fc : N.travelWindow() === dir ? wx : {};
  if (w.temp_f != null && Number.isFinite(+w.temp_f)) {
    parts.push(`${useFc ? `Forecast for ${N.time(fc.t, code)}: ` : ''}${Math.round(+w.temp_f)}°${w.text ? ' ' + lc(w.text) : ''}${useFc && fc.precip_pct >= 30 ? ` (${fc.precip_pct}% rain)` : ''}`);
  }
  const fs = faa.status;
  let warn = false;
  if (fs === 'delay') { parts.push(`FAA delays${faa.avg_min ? ` · avg ${faa.avg_min} min` : ''}`); warn = true; }
  else if (fs === 'ground_stop') { parts.push('FAA ground stop'); warn = true; }
  else if (fs === 'closed') { parts.push('airport closed (FAA)'); warn = true; }
  else if (fs === 'normal' && N.travelWindow() === dir) parts.push('no FAA delays');
  if (!parts.length) return '';
  const t = parts.join(' · ');
  const ic = warn ? 'alert-triangle' : /rain|shower|storm/i.test(w.text || '') ? 'cloud-rain' : /sun|clear/i.test(w.text || '') ? 'sun' : 'cloud';
  return h`<span class="chip ${warn ? 'warn' : 'cr'} cx-wx">${icon(ic)}${t.charAt(0).toUpperCase() + t.slice(1)}</span>`;
}

function guidance(dir, legs, c, bad) {
  const a = legs[0], b = legs[1];
  const at = a.to;
  const g = N.guideFor(at) || {};
  const rows = [];
  rows.push(['shield-check', 'Stay airside', `Domestic to domestic, so no security again. Bags are checked through to ${b.to}.`]);
  const ag = a.arr.gate, bg = b.dep.gate;
  let gateT, gateS;
  if (bad) {
    gateT = 'Check your new gate first';
    gateS = `${bg ? `${fno(b)} was to leave from ${bg}. ` : ''}A rebooked flight often leaves from a different gate; the AA app shows it.`;
  } else if (bg) {
    gateT = `${fno(b)} leaves from ${bg}`;
    gateS = `${concourse(at, bg)}${ag ? ` · you land at ${ag}` : ''}. Gates can still move, so glance at a screen on the way.`;
  } else {
    gateT = N.travelWindow() === b.dir ? `${fno(b)}’s gate isn’t posted yet` : 'Your next gate posts on the day';
    gateS = `${ag ? `You land at ${ag}. ` : ''}Check the AA app or the first departures screen after you leave the plane. Don’t assume the usual gate.`;
  }
  rows.push(['door', gateT, gateS]);
  const w = bad ? N.walk(at, null, null) : c ? c.walk : N.walk(at, ag, bg);
  const wT = w.known ? (w.same ? `Same concourse, about ${w.min} min` : `About ${w.min} min on foot`) : 'Plan on about 15 min walking';
  const wS = w.known
    ? `${gateLetter(ag)} to ${gateLetter(bg)}${w.same ? '' : ' through the Atrium'}. There’s no train; it’s all walking.`
    : `${bad ? 'Until you know your new gate.' : 'Until both gates post.'} All concourses connect through the Atrium; there’s no train.`;
  rows.push(['walk', wT, wS]);
  const food = foodNear(at, bad ? null : bg);
  if (food.length) {
    rows.push(['tools-kitchen-2', bg && !bad ? `Food near ${gateLetter(bg) ? 'Concourse ' + gateLetter(bg) : 'the gate'}` : 'Food on the way',
      food.map(f => `${f.name}${f.where ? ` (${f.where})` : ''}`).join(' · ') + '. Find the gate first, then eat.']);
  }
  const wrong = (g.steps && g.steps.connect || []).find(s => s && /wrong|miss/i.test(s.title || ''));
  rows.push(['alert-triangle', 'If you miss it', wrong && wrong.detail || 'AA rebooks you on the next flight and your bags follow. The AA app shows the new flight; desks are on each concourse.']);
  return h`<div class="sec stack cx-rows">${rows.map(r => h`<div class="rw"><span class="ic">${icon(r[0])}</span><div class="grow"><b>${r[1]}</b><small>${r[2]}</small></div></div>`)}</div>`;
}

N.screen('connect', {
  nav: 1,
  uses: USES,
  back: 'flights',
  tone: 'band',
  title: ctx => { const l = legsOf(ctx.param === 'ret' ? 'ret' : 'out')[0]; return l ? `Connection in ${city(l.to)}` : 'Connection'; },
  render(ctx) {
    const dir = ctx.param === 'ret' ? 'ret' : 'out';
    const legs = legsOf(dir);
    this.back = legs[0] ? `flight/${legs[0].id}` : 'flights';
    if (!N.data.trip) {
      return {hero: h`<div class="cx-h"><div class="ey">Connection</div><h1 class="hl"><b>No trip data</b> on this phone yet</h1></div>`,
        body: h`<div class="cx"><div class="co plain">${icon('info-circle')}<span>Open the app once with a signal to load the trip. After that it works offline.</span></div></div>`};
    }
    if (legs.length < 2) {
      return {hero: h`<div class="cx-h"><div class="ey">Connection</div><h1 class="hl"><b>Nonstop</b>, no connection</h1></div>`,
        body: h`<div class="cx"><a class="btn" href="#flights">${icon('plane')}All flights</a></div>`};
    }
    const c = conn(dir);
    const [a, b] = legs;
    const at = a.to;
    const tone = levelTone(c);
    const bad = a.canceled || b.canceled || a.diverted;
    const done = !bad && !!c && (cxMade(c) || cxDone(c));
    // The day went by with no times: nothing left to plan for, so no walking or food advice.
    const old = !c && !bad && legs.some(lapsed);
    // The concourse diagram only says something once both gates are known.
    const hub = !!(a.arr.gate && b.dep.gate);
    // Rose only when at risk (or canceled/diverted); a tight connection gets an amber dot.
    const lvCls = tone === 'bad' ? 'rose' : tone === 'warn' ? 'amb' : '';
    const hero = h`<div class="cx-h ${hub ? 'has-hub' : ''}">${hub ? hubSvg(a.arr.gate, b.dep.gate) : ''}
      <div class="ey">Connect · ${city(at)}</div>
      <div class="cx-big ${bad && c ? 'was' : ''}">${c ? h`<span class="dp tn" data-k="cx-min">${Math.max(0, c.ground)}</span><span class="dp cx-u">min</span>` : h`<span class="dp cx-unk" data-k="cx-min" aria-label="Minutes not known yet">?</span><span class="dp cx-u">min</span>`}</div>
      <span class="chip ${lvCls} cx-lvl"><span class="dot ${tone === 'warn' ? 'amb' : dotCls(tone)}"></span>${bad ? (a.diverted && !a.canceled ? 'Diverted' : 'Canceled') : c ? cxText(c) : old ? 'No times saved' : 'Times not confirmed'}</span>
    </div>`;
    // On the ground with the onward flight still ahead: say what is happening now.
    let live = '';
    // Checks gone quiet past the landing time count too, worded as what should be true.
    if (!bad && !done && (a.state === 'landed' || dueDown(a)) && b.dep.time) {
      const n = nowMs(), gate = b.dep.gate;
      const lead = a.state === 'landed' ? 'You’re on the ground.' : `${fno(a)} should be on the ground by now.`;
      if (okT(b.board) && n < T(b.board)) live = h`${lead} ${fno(b)} boards${gate ? ` at ${gate}` : ''} in <b class="tn"><span data-until="${b.board}">${N.until(b.board)}</span></b>, at ${N.time(b.board, at)}.`;
      else if (okT(b.doors) && n < T(b.doors)) live = h`${fno(b)} is boarding now${gate ? ` at ${gate}` : ''}. Doors close at <b class="tn">${N.time(b.doors, at)}</b>.`;
    }
    let top;
    if (c) {
      const toDoor = N.mins(a.arr.time, b.doors);
      // The hero already shows the minutes on the ground; this line is the slack at the gate.
      const sum = toDoor <= 0 ? `${fno(a)} lands after ${fno(b)}’s doors close` : c.spare >= 0 ? `${c.spare} min to spare at the gate` : `About ${-c.spare} min short at the gate`;
      const how = `Allows ~10 min to get off and ~${c.walk.min} min to walk${c.walk.known ? '' : ' until the gates post'}.`
        + (c.free < 0 && c.spare > 0 ? ' Boarding will have started when you get there.' : '')
        + (c.spare < 0 && toDoor > 0 ? ' Tell the crew about your connection as you land.' : '');
      top = h`<div class="cx-sum tn">${bad ? 'Planned: ' : ''}${sum}</div>
        ${timeline(c)}
        ${done ? '' : bad ? h`<p class="small mu cx-th">These were the planned times. Your new flight and its times are in the AA app.</p>`
          : h`<p class="small mu cx-th">${how}</p><p class="small mu cx-th cx-key">Comfortable 20+ · Tight 8–19 · At risk under 8 minutes at the gate before the doors close.</p>`}`;
    } else if (old) {
      top = h`<div class="bn neutral">${icon('info-circle')}<div class="grow"><b>No connection times saved</b>
        <span>${unconfText(legs.filter(l => !l.dep.time).map(fno).join(' and ') || 'these flights', a.date, a.from)}</span>
        <div class="bx">${ext(AA_TRIPS, 'Trips on aa.com')}</div></div></div>`;
    } else {
      top = h`<div class="bn neutral">${icon('info-circle')}<div class="grow"><b>Connection time not known yet</b>
        <span>${legs.filter(l => !l.dep.time).map(fno).join(' and ') || 'These flights'} ${legs.filter(l => !l.dep.time).length > 1 ? 'have' : 'has'} no confirmed times. Once AA publishes them this shows minutes on the ground and when boarding starts.</span>
        <div class="bx">${ext(AA_TRIPS, 'Trips on aa.com')}</div></div></div>`;
    }
    const alert = bad ? h`<div class="bn cx-bn">${icon('alert-triangle')}<div class="grow"><b>${a.canceled ? `${fno(a)} is canceled` : b.canceled ? `${fno(b)} is canceled` : `${fno(a)} diverted to ${a.diverted}`}</b>
      <span>AA rebooks missed connections automatically. Check the AA app for your new flight before walking to a gate.</span></div></div>` : '';
    // Verb tense follows where the flight is, so a landed or gone flight doesn't read as still to come.
    const legRow = (l, word) => h`<a class="fx-row fx-go" href="#flight/${l.id}"><span class="ic">${icon(word === 'in' ? 'plane-arrival' : 'plane-departure')}</span><div class="grow">
      <b>${fno(l)} · ${l.from} → ${l.to}</b><small class="tn">${lapsed(l) ? [dayLong(l.date), legSt(l).text].filter(Boolean).join(' · ') : word === 'in'
        ? `${l.canceled || l.diverted ? 'Was to land' : l.state === 'landed' ? 'Landed' : l.state === 'past' || dueDown(l) ? 'Was due' : 'Lands'} ${l.arr.time ? N.time(l.arr.time, at) : 'time TBC'}${l.arr.gate ? ` · gate ${l.arr.gate}` : ''}`
        : l.canceled ? `Was to leave ${l.dep.time ? N.time(l.dep.time, at) : 'TBC'}${l.dep.gate ? ` · gate ${l.dep.gate}` : ''}`
        : isGone(l) ? `Left ${l.dep.time ? N.time(l.dep.time, at) : 'TBC'}${l.dep.gate ? ` · gate ${l.dep.gate}` : ''}`
        : `Boards ${l.board ? N.time(l.board, at) : 'time TBC'} · departs ${l.dep.time ? N.time(l.dep.time, at) : 'TBC'}${l.dep.gate ? ` · gate ${l.dep.gate}` : ''}`}${lapsed(l) || (word === 'in' && l.state === 'landed' && legSt(l).text === 'Landed') ? '' : ` · ${legSt(l).text}`}</small></div>${icon('chevron-right')}</a>`;
    return {hero, body: h`<div class="cx">
      ${alert}${live ? h`<div class="co cx-now">${icon('clock')}<span>${live}</span></div>` : ''}${top}
      ${done ? h`<div class="sec"><div class="co plain">${icon('circle-check')}<span>${cxMade(c)
        ? `You made this connection. ${fno(b)} left ${city(at)}${b.dep.time ? ` at ${N.time(b.dep.time, at)}` : ''}.`
        : 'This connection is behind you, going by the schedule. No landing or departure came through, so the times above are as planned.'}</span></div></div>` : old ? '' : guidance(dir, legs, c, bad)}
      <div class="sec wrap cx-chips">${done || old ? '' : wxChip(at, [a.id, b.id], dir)}${N.guideFor(at) ? h`<a class="chip fl-lk dk2" href="#airport/${lc(at)}">${icon('map')}${at} map &amp; guide</a>` : ''}</div>
      <div class="sec"><div class="ey">The two flights</div><div class="stack8">${legRow(a, 'in')}${legRow(b, 'out')}</div></div>
    </div>`};
  },
  mount() { this._sig = legsSig(); },
  tick() { const s = legsSig(); if (this._sig && s !== this._sig) { this._sig = s; N.rerender(); } },
});

// ---------- #seats/<legId> ----------
// Seat references in guide text: "13F", "25F–29F", "20A–D", "14–20 A/F", "Rows 34–36", "13A/F".
function seatRefs(text, rows) {
  const out = new Set();
  let s = String(text || '');
  const colon = s.indexOf(':');
  if (colon > 0 && /\d/.test(s.slice(0, colon))) s = s.slice(0, colon);
  const D = '[–-]';
  const add = (r, L) => out.add(`${r}${L}`);
  const range = (a, b) => { const o = []; for (let i = +a; i <= +b && o.length < 60; i++) o.push(i); return o; };
  const lets = (a, b) => { const o = []; for (let c = a.charCodeAt(0); c <= b.charCodeAt(0); c++) o.push(String.fromCharCode(c)); return o; };
  s = s.replace(new RegExp(`rows?\\s+(\\d{1,2})\\s*${D}\\s*(\\d{1,2})`, 'gi'), (m, a, b) => { range(a, b).forEach(r => out.add(`${r}*`)); return ' '; });
  s = s.replace(new RegExp(`\\brow\\s+(\\d{1,2})\\b`, 'gi'), (m, a) => { out.add(`${a}*`); return ' '; });
  s = s.replace(new RegExp(`\\b(\\d{1,2})([A-K])\\s*${D}\\s*(\\d{1,2})([A-K])\\b`, 'g'), (m, a, L1, b, L2) => { range(a, b).forEach(r => lets(L1 < L2 ? L1 : L2, L1 < L2 ? L2 : L1).forEach(L => add(r, L))); return ' '; });
  s = s.replace(new RegExp(`\\b(\\d{1,2})([A-K])\\s*${D}\\s*([A-K])\\b`, 'g'), (m, a, L1, L2) => { lets(L1, L2).forEach(L => add(a, L)); return ' '; });
  s = s.replace(new RegExp(`\\b(\\d{1,2})\\s*${D}\\s*(\\d{1,2})\\s+([A-K](?:\\/[A-K])*)\\b`, 'g'), (m, a, b, Ls) => { range(a, b).forEach(r => Ls.split('/').forEach(L => add(r, L))); return ' '; });
  s = s.replace(/\b(\d{1,2})([A-K](?:\/[A-K])*)\b/g, (m, a, Ls) => { Ls.split('/').forEach(L => add(a, L)); return ' '; });
  return out;
}
const hits = (set, r, L) => set.has(`${r}${L}`) || set.has(`${r}*`);

function layoutOf(info) {
  const cabins = info && info.layout && Array.isArray(info.layout.cabins) ? info.layout.cabins : [];
  return cabins.map(c => {
    const groups = String(c.letters || '').toUpperCase().split(/[-\s|]+/).map(g => g.replace(/[^A-K]/g, '').split('')).filter(g => g.length);
    const from = +c.from, to = +c.to;
    if (!groups.length || !Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 80) return null;
    const missing = new Set((c.missing || []).map(Number));
    const gone = new Set((c.missing_seats || []).map(normSeat));
    const rows = [];
    for (let r = from; r <= to; r++) if (!missing.has(r)) rows.push(r);
    return {name: c.name || 'Cabin', groups, rows, exits: new Set((c.exits || []).map(Number)), gone, note: c.note || '',
      extra: /extra|comfort|plus/i.test(c.name || ''), first: /first|business/i.test(c.name || '')};
  }).filter(Boolean);
}
function seatPos(cab, L) {
  const g = cab.groups;
  const all = g.flat();
  if (L === all[0] || L === all[all.length - 1]) return 'Window';
  for (let i = 0; i < g.length; i++) {
    if ((i > 0 && L === g[i][0]) || (i < g.length - 1 && L === g[i][g[i].length - 1])) return 'Aisle';
  }
  return 'Middle';
}

N.screen('seats', {
  nav: 1,
  uses: USES,
  back: 'flights',
  tone: 'band',
  title: ctx => { const l = findLeg(ctx.param); return l ? `Seats · ${fno(l)}` : 'Seats'; },
  render(ctx) {
    const l = findLeg(ctx.param);
    if (!l) {
      this.back = 'flights';
      const none = !N.data.trip;
      return {hero: h`<div class="st-h"><div class="ey">Seat map</div><h1 class="hl">${none ? h`<b>No trip data</b> on this phone yet` : h`<b>Flight not found</b>`}</h1></div>`,
        body: h`<div class="st"><p class="small mu st-nf">${none ? 'Open the app once with a signal to load the trip. After that it works offline.' : 'It may have been removed in a trip update.'}</p><a class="btn" href="#flights">${icon('plane')}All flights</a></div>`};
    }
    this.back = `flight/${l.id}`;
    const p = plane(l);
    const info = p.info;
    const cabins = layoutOf(info);
    const mine = l.seats.map(normSeat).filter(Boolean);
    const good = new Set(), avoid = new Set();
    const goodWhy = [], avoidWhy = [];
    (info && info.good || []).forEach(t => { const s = seatRefs(t); s.forEach(x => good.add(x)); goodWhy.push([s, t]); });
    (info && info.avoid || []).forEach(t => { const s = seatRefs(t); s.forEach(x => avoid.add(x)); avoidWhy.push([s, t]); });
    const swapped = l.live && l.aircraft_code && l.planned_code && l.aircraft_code !== l.planned_code;
    const hero = h`<div class="st-h">
      <div class="ey">Seat map · ${fno(l)} · ${l.from} → ${l.to}</div>
      <h1 class="hl">${p.maker ? h`${p.maker} ` : ''}<b>${p.short || 'Aircraft not known'}</b></h1>
      ${info && info.config ? h`<p class="st-cfg">${info.config}</p>` : ''}
    </div>`;
    if (!cabins.length) {
      return {hero, body: h`<div class="st">
        <div class="bn neutral">${icon('info-circle')}<div class="grow"><b>${p.short ? `No cabin layout saved for the ${p.short}` : 'Aircraft not known yet'}</b>
          <span>${p.short ? 'The AA app shows the seat map for your booking.' : 'AA assigns the plane closer to the day. The AA app shows the seat map for your booking.'}</span>
          ${l.seatmap || info && info.map_url ? h`<div class="bx">${ext(l.seatmap || info.map_url, 'Full seat map')}</div>` : ''}</div></div>
        ${mine.length ? h`<div class="sec"><div class="ey">Your seats</div><div class="wrap">${mine.map(s => h`<span class="chip cr tn">${icon('armchair')}${s}</span>`)}</div></div>` : ''}
      </div>`};
    }
    // Where each of your seats is, and anything the guide says about it.
    const known = new Map();
    cabins.forEach(c => c.rows.forEach(r => c.groups.flat().forEach(L => { if (!c.gone.has(`${r}${L}`)) known.set(`${r}${L}`, c); })));
    // Who sits where: Wallet seats line up with Wallet names by position (first names, full when two match).
    const wl = N.wallet() || {};
    const rawSeats = Array.isArray(wl.seats && wl.seats[l.id]) ? wl.seats[l.id] : [];
    const people = Array.isArray(wl.names) ? wl.names.map(n => String(n || '').trim()) : [];
    const first = n => n.split(/\s+/)[0] || '';
    const whoSits = s => {
      const i = rawSeats.findIndex(x => normSeat(x) === s);
      const n = i >= 0 ? people[i] || '' : '', f = first(n);
      return !n ? '' : people.some((o, j) => j !== i && first(o).toLowerCase() === f.toLowerCase()) ? n : f;
    };
    const mineRows = mine.map(s => {
      const who = whoSits(s);
      const m = s.match(/^(\d{1,2})([A-K])$/);
      const cab = m && known.get(s);
      if (!cab) return h`<div class="rw"><span class="ic st-ic">${icon('armchair')}</span><div class="grow"><b class="tn">${s}${who ? ` · ${who}` : ''}</b><small>Not on this layout. The plane may have been swapped; check the AA app.</small></div></div>`;
      const r = +m[1], L = m[2];
      const why = [...avoidWhy.filter(([set]) => hits(set, r, L)).map(([, t]) => ['avoid', t]), ...goodWhy.filter(([set]) => hits(set, r, L)).map(([, t]) => ['good', t])];
      const exit = cab.exits.has(r);
      return h`<div class="rw"><span class="ic st-ic">${icon('armchair')}</span><div class="grow"><b class="tn">${s} · ${seatPos(cab, L)}</b>
        <small>${who ? `${who} · ` : ''}Row ${r} · ${cab.name}${exit ? ' · exit row' : ''}</small>
        ${why.slice(0, 2).map(([k, t]) => h`<small class="st-why ${k}">${icon(k === 'good' ? 'thumb-up' : 'alert-circle')}${t}</small>`)}</div></div>`;
    });
    const grid = cabins.map(c => {
      const head = h`<div class="st-row st-head" aria-hidden="true">${c.groups.map((g, gi) => h`${gi ? h`<span class="st-ai"></span>` : ''}<span class="st-g" style="--n:${g.length}">${g.map(L => h`<span>${L}</span>`)}</span>`)}</div>`;
      const rows = c.rows.map(r => {
        const exit = c.exits.has(r);
        const minesHere = c.groups.flat().some(L => mine.includes(`${r}${L}`));
        return h`<div class="${N.cls('st-row', exit && 'exit', minesHere && 'mine')}">${c.groups.map((g, gi) => h`${gi ? h`<span class="st-ai tn">${r}</span>` : ''}<span class="st-g" style="--n:${g.length}">${g.map(L => {
          const id = `${r}${L}`;
          if (c.gone.has(id)) return h`<span class="st-s gone"></span>`;
          const me = mine.includes(id);
          const cls = N.cls('st-s', c.first && 'first', (c.extra || exit) && 'xl', !me && hits(avoid, r, L) && 'bad', !me && hits(good, r, L) && !hits(avoid, r, L) && 'good', me && 'me');
          return h`<span class="${cls}" ${me ? h`aria-label="Your seat ${id}"` : ''}>${me ? L : ''}</span>`;
        })}</span>`)}</div>`;
      });
      return h`<div class="st-cab"><div class="st-cn"><span class="ey">${c.name}</span><span class="small mu tn">Rows ${c.rows[0]}–${c.rows[c.rows.length - 1]}</span></div>
        ${head}${rows}${c.note ? h`<p class="small mu st-note">${c.note}</p>` : ''}</div>`;
    });
    const list = (title, ic, items, cls) => items && items.length ? h`<div class="sec"><div class="ey">${title}</div><div class="stack8">${items.map(t => h`<div class="st-li ${cls}">${icon(ic)}<span>${t}</span></div>`)}</div></div>` : '';
    return {hero, body: h`<div class="st">
      ${swapped ? h`<div class="bn neutral st-gap">${icon('alert-circle')}<div class="grow"><b>Plane may have changed</b><span>The latest check shows ${l.aircraft || l.aircraft_code}. This layout is for the planned ${shortPlane(plane({aircraft_code: l.planned_code}).name) || l.planned_code}; check the AA app seat map.</span></div></div>` : ''}
      ${mine.length ? h`<div class="stack st-mine">${mineRows}</div>`
        : h`<a class="fx-row fx-go st-add" href="#wallet/seats/${l.id}"><span class="ic">${icon('armchair')}</span><div class="grow"><b>Add your seats in Wallet</b><small>They’re highlighted here and stay on this phone.</small></div>${icon('chevron-right')}</a>`}
      <div class="st-key" aria-hidden="true">
        <span><i class="st-s me"></i>Yours</span><span><i class="st-s xl"></i>Legroom</span><span><i class="st-s good"></i>Good</span><span><i class="st-s bad"></i>Avoid</span><span><i class="st-x"></i>Exit</span>
      </div>
      <div class="st-map" role="img" aria-label="Cabin seat map${mine.length ? `, your seats ${mine.join(', ')}` : ''}">
        <div class="st-nose" aria-hidden="true">Front</div>
        ${grid}
      </div>
      ${list('Good seats', 'thumb-up', info.good, 'good')}
      ${list('Seats to avoid', 'alert-circle', info.avoid, 'bad')}
      ${list('Worth knowing', 'info-circle', info.notes, '')}
      ${info.power || info.wifi ? h`<div class="sec stack">
        ${info.power ? h`<div class="rw"><span class="ic">${icon('plug')}</span><div class="grow"><b>Power</b><small>${info.power}</small></div></div>` : ''}
        ${info.wifi ? h`<div class="rw"><span class="ic">${icon('wifi')}</span><div class="grow"><b>Wi-Fi</b><small>${info.wifi}</small></div></div>` : ''}
      </div>` : ''}
      <div class="sec wrap">${ext(info.map_url || l.seatmap, 'Full seat map', 'cr2')}</div>
    </div>`};
  },
  // Open at your row, once per visit (a data refresh keeps wherever you scrolled to).
  mount(ctx, view) {
    const cur = typeof N.current === 'function' ? N.current() : null;
    if (!view || cur && cur.stJumped) return null;
    if (cur) cur.stJumped = true;
    // After the router has set its own scroll; coming back to a spot you scrolled to keeps it.
    const t = setTimeout(() => {
      const row = view.querySelector('.st-row.mine');
      if (!row || view.scrollTop > 4) return;
      const r = row.getBoundingClientRect();
      if (r.top >= 80 && r.bottom <= innerHeight - 120) return;
      try { row.scrollIntoView({block: 'center', behavior: N.reduce ? 'auto' : 'smooth'}); } catch (e) { row.scrollIntoView(); }
    }, 0);
    return () => clearTimeout(t);
  },
});
})();
