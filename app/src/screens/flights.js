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
const fno = l => `${l.carrier || 'AA'} ${l.num || String(l.flight || '').replace(/^\D+/, '')}`.trim();
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
const termLabel = t => !t ? '' : /^\d+$/.test(String(t)) ? `T${t}` : `Terminal ${t}`;
const termShort = t => !t ? '' : /^\d+$/.test(String(t)) ? `T${t}` : `Term ${t}`;
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
const levelTone = c => !c ? 'neutral' : cxMade(c) || c.level === 'ok' ? 'ok' : c.level === 'tight' ? 'warn' : 'bad';

// N.legStatus, except a leg well past its arrival with no landing seen reads "Done".
const legSt = l => l && l.state === 'past' && !l.canceled && !l.diverted && l.route_ok !== false ? {text: 'Done', tone: 'neutral'} : N.legStatus(l);
// Status chip, e.g. "On time · checked 4:31a".
function statusChip(l, withChecked, cls = '') {
  const s = legSt(l);
  const chk = withChecked && l.checked_at ? ` · checked ${when(l.checked_at, l.from)}` : '';
  return h`<span class="chip ${chipCls(s.tone)} ${cls}" data-k="st-${l.id}"><span class="dot ${dotCls(s.tone)}"></span>${s.text}${chk}</span>`;
}
// When the updater should look again: every ~10 minutes on a travel day.
function nextCheck(l) {
  if (!l.checked_at || l.state === 'landed' || l.state === 'past' || l.canceled) return '';
  if (N.travelWindow() !== l.dir) return '';
  const nx = N.addMin(l.checked_at, 10);
  return T(nx) > N.now().getTime() ? `Next check about ${N.time(nx, l.from)}` : '';
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
  const next = N.nextLeg();
  const out = legsOf('out'), ret = legsOf('ret');
  const all = out.concat(ret);
  const fresh = h`<span class="chip ob"><span class="dot ${f.level === 'fresh' ? '' : f.level === 'neutral' ? 'neutral' : 'stale'}"></span>${f.at ? `Checked ${when(f.at, f.window === 'ret' ? 'LGA' : 'PHX')}` : f.text}</span>`;
  let ey, line;
  if (!all.length) {
    ey = 'Flights'; line = h`<b>No flights saved</b> on this phone yet`;
  } else if (!next) {
    ey = 'Flights'; line = h`<b>All flights done.</b> Welcome home.`;
  } else if (!next.dep.time) {
    ey = `Next · ${fno(next)} · ${dayLong(next.date)}`;
    line = h`${N.dirLabel(next.dir)} on <b>${dayLong(next.date)}</b>. Times not confirmed yet.`;
  } else if (next.state === 'air') {
    ey = `${fno(next)} · ${next.from} → ${next.to}`;
    line = h`In the air. Lands in ${city(next.to)} in <b class="tn"><span data-until="${next.arr.time}">${N.until(next.arr.time)}</span></b>`;
  } else if (next.state === 'boarding') {
    ey = `${fno(next)} · ${next.from} → ${next.to}`;
    line = h`<b>Boarding now</b>${next.dep.gate ? h` at gate <b>${next.dep.gate}</b>` : ''}. Doors close ${N.time(next.doors, next.from)}.`;
  } else if (next.canceled) {
    ey = `${fno(next)} · ${next.from} → ${next.to}`;
    line = h`<b>${fno(next)} is canceled.</b> Check the AA app for your new flight.`;
  } else if (T(next.dep.time) <= N.now().getTime()) {
    ey = `${fno(next)} · ${next.from} → ${next.to}`;
    line = next.arr.time
      ? h`Due to have left ${city(next.from)}. Lands in ${city(next.to)} around <b class="tn">${N.time(next.arr.time, next.to)}</b>`
      : h`Due to have left ${city(next.from)}. Waiting for the next check.`;
  } else {
    ey = `Next · ${fno(next)} · ${N.date(next.dep.time, next.from)}`;
    line = h`${city(next.from)} to ${city(next.to)} in <b class="tn"><span data-until="${next.dep.time}">${N.until(next.dep.time)}</span></b>`;
  }
  return h`<div class="fl-hero">
    <div class="ey">${ey}</div>
    <h1 class="hl">${line}</h1>
    <div class="wrap fl-hchips">${fresh}${next && next.dep.time && next.state === 'scheduled' ? h`<span class="chip ob tn">${icon('clock')}Leaves ${N.time(next.dep.time, next.from)} ${tzAbbr(next.from, next.dep.time)}</span>` : ''}</div>
  </div>`;
}

const legsSig = () => { try { return N.legs().map(l => l.state).join(','); } catch (e) { return ''; } };

function changesBanner() {
  let ch = [];
  try { ch = N.changes(); } catch (e) { ch = []; }
  if (!ch.length) return '';
  return h`<div class="bn fl-chg rise">${icon('alert-triangle')}<div class="grow">
      <b>Changed since you last looked</b>
      ${ch.slice(0, 5).map(c => h`<span>${String(c && c.text || '').replace(/\bAA(\d)/g, 'AA $1')}</span>`)}
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
  const term = termShort(l.dep.terminal);
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
        <b class="tn fl-t ${depOld ? lateCls(l.dep.est, l.dep.sched) : ''}" data-k="dt-${l.id}">${unknown ? 'Time TBC' : N.time(l.dep.time, l.from)}</b>
        <small>${city(l.from)}${!unknown && tzAbbr(l.from, l.dep.time) ? ' · ' + tzAbbr(l.from, l.dep.time) : ''}</small>
      </div>
      <div class="fl-path" aria-hidden="true"><span class="fl-pl"><span class="fl-line"></span>${icon('plane')}</span><small class="tn">${dur}</small></div>
      <div class="fl-end r">
        <span class="dp fl-code">${l.to}</span>
        ${old(arrOld)}
        <b class="tn fl-t ${arrOld ? lateCls(l.arr.est, l.arr.sched) : ''}" data-k="at-${l.id}">${!l.arr.time ? 'Time TBC' : N.time(l.arr.time, l.to)}</b>
        <small>${city(l.to)}${l.arr.time && tzAbbr(l.to, l.arr.time) ? ' · ' + tzAbbr(l.to, l.arr.time) : ''}</small>
      </div>
    </div>
    <div class="fl-meta">
      <div><small>Gate${term ? ' · ' + term : ''}</small><b data-k="dg-${l.id}">${gate || '—'}</b></div>
      <div><small>Seat${l.seats.length > 1 ? 's' : ''}</small><b class="${l.seats.length ? '' : 'mu'}">${l.seats.length ? l.seats.join(' ') : 'Not added'}</b></div>
      <div><small>Aircraft</small><b class="${p.short ? '' : 'mu'}">${p.short || 'Not known'}</b></div>
    </div>
  </a>`;
}

// A canceled or diverted leg makes the connection moot; say that instead of a level.
// Once the onward flight has left, the connection was made; the level no longer matters.
const cxMade = c => !!(c && c.b && !c.b.canceled && (c.b.dep && c.b.dep.actual || ['air', 'landed'].includes(c.b.state)));
const cxText = c => c && c.a && c.b && (c.a.canceled || c.b.canceled) ? 'Canceled' : c && c.a && c.a.diverted ? 'Diverted' : cxMade(c) ? 'Made it' : c ? c.text : '';
const cxLevel = c => cxMade(c) ? 'ok' : c ? c.level : 'neutral';

function connStrip(dir, legs) {
  if (legs.length < 2) return '';
  const c = conn(dir);
  const at = legs[0].to;
  if (!c) {
    return h`<a class="fl-cx neutral" href="#connect/${dir}">${icon('arrows-exchange')}<div class="grow"><b>Change planes in ${city(at)}</b><small>Connection time shows once times are confirmed</small></div>${icon('chevron-right')}</a>`;
  }
  const walk = c.walk.known ? `walk about ${c.walk.min} min` : 'gates not posted yet';
  return h`<a class="fl-cx ${cxLevel(c)}" href="#connect/${dir}">${icon('arrows-exchange')}<div class="grow">
      <b class="tn" data-k="cx-${dir}">${N.dur(c.ground)} in ${city(at)}</b>
      <small><span class="fl-lv">${cxText(c)}</span>${cxMade(c) ? '' : ` · ${walk}`}</small></div>${icon('chevron-right')}</a>`;
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
      <b>Not confirmed yet</b>
      <span>AA hasn’t published times for ${unconf.map(fno).join(' and ')} on ${dayLong(unconf[0].date)}. They usually appear about 3 days ahead. Your booking in the AA app or on aa.com has the times you were sold.</span>
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
  return h`<section class="sec fl-dir ${done ? 'done' : ''}">
    <div class="fl-dh"><div class="grow"><div class="ey">${dir === 'out' ? 'Outbound' : 'Return'} · ${dayLong(first.date)}</div>
      <h2 class="h2">${N.dirLabel(dir)}</h2></div>${done ? h`<span class="chip cr">${icon('check')}Done</span>` : ''}</div>
    <div class="cn fl-sum">
      <div><small>Total</small><b class="tn">${total != null ? N.dur(total) : '—'}</b><span>${via ? `via ${via}` : 'Nonstop'}</span></div>
      <div><small>Leaves</small><b class="tn">${first.dep.time ? N.time(first.dep.time, first.from) : '—'}</b><span>${first.from}${tzD ? ' · ' + tzD : ''}</span></div>
      <div><small>Lands</small><b class="tn">${last.arr.time ? N.time(last.arr.time, last.to) : '—'}</b><span>${last.to}${tzA ? ' · ' + tzA : ''}</span></div>
    </div>
    ${dirNote(dir, legs)}
    <div class="fl-legs">
      ${legs.map((l, i) => h`${i ? connStrip(dir, legs) : ''}${ticket(l, i, legs.length)}`)}
    </div>
    ${ci && !done ? h`<div class="rw c fl-ci"><span class="ic">${icon(ci.state === 'open' ? 'circle-check' : 'ticket')}</span><div class="grow"><b class="tn">${ci.text}</b><small>${ci.sub}</small></div></div>` : ''}
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
      body: h`<div class="fl">${changesBanner()}${order.map(d => dirSection(d, d === 'out' && doneOut))}
        <div class="sec wrap fl-foot">
          <button class="chip cr fl-btn" data-act="go" data-arg="calendar">${icon('calendar-plus')}Add to Calendar</button>
          <button class="chip cr fl-btn" data-act="go" data-arg="wallet">${icon('wallet')}Seats in Wallet</button>
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
    out.push(h`<div class="bn neutral fx-bn">${icon('info-circle')}<div class="grow"><b>Not confirmed yet</b>
      <span>AA hasn’t published times for ${fno(l)} on ${dayLong(l.date)}. They usually appear about 3 days ahead. Your booking in the AA app or on aa.com has the times you were sold.</span>
      <div class="bx">${trips}</div></div></div>`);
  }
  if (l.fetch_failed) {
    out.push(h`<div class="bn neutral fx-bn">${icon('wifi-off')}<div class="grow"><b>Couldn’t check this flight just now</b>
      <span>Showing the planned times${l.checked_at ? ` and the last good check from ${when(l.checked_at, l.from)}` : ''}. The AA app has the latest gate.</span></div></div>`);
  }
  if (!l.canceled && !l.diverted && l.live) {
    const lines = [];
    const gone = ['air', 'landed', 'past'].includes(l.state);
    if (gone) ch = ch.filter(c => c.k === 'ag' || c.k === 'bg');
    const late = !gone && l.delay_dep > 14 && l.dep.est;
    if (late) lines.push(`Departs ${N.dur(l.delay_dep)} late, now ${N.time(l.dep.est, l.from)}`);
    ch.forEach(c => { if (c.k !== 'd' || !late) lines.push(c.text.replace(fno(l).replace(' ', ''), '').trim().replace(/^./, m => m.toUpperCase())); });
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
  if (!ib || l.departed || l.state === 'air' || l.state === 'landed' || l.state === 'past' || l.canceled) return '';
  const st = String(ib.status || '');
  const here = /land|arriv/i.test(st);
  const t = ib.est && okT(ib.est) ? when(ib.est, l.from) : '';
  const from = !ib.from ? 'its last stop' : city(ib.from) && city(ib.from) !== ib.from ? `${city(ib.from)} (${ib.from})` : ib.from;
  const title = here ? 'Your plane is here' : `Your plane is on its way${ib.flight ? ` as ${ib.flight.replace(/^AA(\d)/, 'AA $1')}` : ''}`;
  const sub = here ? `Landed from ${from}${t ? ` at ${t}` : ''}` : `From ${from}${t ? ` · due ${t}` : ''}${st && !here ? ` · ${st}` : ''}`;
  return h`<div class="fx-row"><span class="ic">${icon(here ? 'circle-check' : 'plane-arrival')}</span><div class="grow"><b>${title}</b><small class="tn" data-k="ib-${l.id}">${sub}</small></div></div>`;
}

function connRow(l, legs) {
  if (legs.length < 2) return '';
  const c = conn(l.dir);
  const isFirst = l === legs[0] || l.id === legs[0].id;
  const at = legs[0].to;
  const other = isFirst ? legs[1] : legs[0];
  let title, sub;
  if (!c) {
    title = isFirst ? `Connect in ${city(at)} to ${fno(other)}` : `Connecting from ${fno(other)}`;
    sub = 'Connection time shows once both flights have times';
  } else {
    title = h`<span class="tn">${N.dur(c.ground)}</span> in ${city(at)} · <span class="fx-lv ${cxLevel(c)}">${cxText(c)}</span>`;
    const g = isFirst
      ? `${fno(other)} boards ${N.time(c.b.board, at)}${c.b.dep.gate ? ` at ${c.b.dep.gate}` : ''}`
      : `${fno(other)} lands ${N.time(c.a.arr.time, at)}${c.a.arr.gate ? ` at ${c.a.arr.gate}` : ''}`;
    sub = `${g} · walk ${c.walk.known ? `about ${c.walk.min} min` : 'time once gates post'}`;
  }
  return h`<a class="fx-row fx-go" href="#connect/${l.dir}"><span class="ic">${icon('arrows-exchange')}</span><div class="grow"><b>${title}</b><small class="tn">${sub}</small></div>${icon('chevron-right')}</a>`;
}

function arrivalRow(l, legs) {
  const last = l.id === legs[legs.length - 1].id;
  if (!last) return '';
  const term = termLabel(l.arr.terminal);
  const where = [term, l.arr.gate ? `Gate ${l.arr.gate}` : ''].filter(Boolean).join(' · ');
  if (l.arr.baggage) {
    return h`<div class="fx-row"><span class="ic">${icon('luggage')}</span><div class="grow"><b data-k="bg-${l.id}">Bags: carousel ${l.arr.baggage}</b><small data-k="ag-${l.id}">${[shortAp(l.to), where].filter(Boolean).join(' · ')}</small></div></div>`;
  }
  const note = l.state === 'landed' ? 'Carousel not posted yet. The AA app and the screens at claim show it.' : 'The carousel posts around landing. The AA app shows it.';
  return h`<div class="fx-row"><span class="ic">${icon('luggage')}</span><div class="grow"><b>Arrive ${shortAp(l.to)}</b><small>${where ? h`<span data-k="ag-${l.id}">${where}</span>. ` : ''}<span data-k="bg-${l.id}">${note}</span></small></div></div>`;
}

function eventsLog(l) {
  const ev = (l.events || []).filter(e => e && e.text).slice().sort((a, b) => (T(b.at) || 0) - (T(a.at) || 0));
  if (!ev.length) return l.live ? h`<div class="sec"><div class="ey">Changes</div><p class="small mu fx-none">No changes logged since checks began.</p></div>` : '';
  return h`<div class="sec"><div class="ey">Changes</div><div class="fx-log">
    ${ev.slice(0, 12).map(e => h`<span class="tn mu">${e.at ? when(e.at, l.from) : ''}</span><span>${e.text}</span>`)}
  </div></div>`;
}

function timesGrid(l) {
  const depOld = l.dep.est && l.dep.sched && Math.abs(N.mins(l.dep.sched, l.dep.est)) >= 5 ? N.time(l.dep.sched, l.from) : '';
  const arrOld = l.arr.est && l.arr.sched && Math.abs(N.mins(l.arr.sched, l.arr.est)) >= 5 ? N.time(l.arr.sched, l.to) : '';
  const div = l.diverted && !l.canceled && !l.arr.actual;
  const dur = div ? `To ${l.diverted}` : l.dep.time && l.arr.time ? N.dur(N.mins(l.dep.time, l.arr.time)) : 'Not confirmed';
  let pos = 50;
  if (l.state === 'air' && l.dep.time && l.arr.time) {
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
  const gone = ['air', 'landed', 'past'].includes(l.state);
  const gateRing = ch.some(c => c.k === (gone ? 'ag' : 'dg') || !gone && c.k === 'dt');
  const timeRing = !gone && (ch.some(c => c.k === 'd') || l.delay_dep > 14);
  const conc = concourse(l.from, l.dep.gate);
  const gateSub = l.dep.gate ? conc || (term ? termLabel(l.dep.terminal) : '') : l.dep.time ? 'Posts closer to departure' : 'Not known yet';
  const seats = l.seats;
  const seatTile = seats.length
    ? h`<div class="tile"><small>Seat${seats.length > 1 ? 's' : ''}</small><b class="tn">${seats.join(' ')}</b><small>${icon('lock')} From Wallet</small></div>`
    : h`<a class="tile fx-tl" href="#wallet"><small>Seat</small><b>Add</b><small class="fx-ln">In Wallet ${icon('chevron-right')}</small></a>`;
  const acTile = p.short || p.info
    ? h`<a class="tile fx-tl" href="#seats/${l.id}"><small>Aircraft</small><b>${p.short || p.code}</b><small class="fx-ln">Seat map ${icon('chevron-right')}</small></a>`
    : h`<div class="tile"><small>Aircraft</small><b class="mu">—</b><small>Not known yet</small></div>`;
  const aTerm = termLabel(l.arr.terminal);
  const first = l.diverted && !l.canceled && l.dep.actual && !l.arr.actual
    ? h`<div class="tile ring"><small>Diverted to</small><b>${l.diverted}</b><small>${city(l.diverted) !== l.diverted ? city(l.diverted) : `Instead of ${l.to}`}</small></div>
      <div class="tile"><small>Took off</small><b class="tn">${l.dep.time ? N.time(l.dep.time, l.from) : '—'}</b><small>${l.from}${tzAbbr(l.from, l.dep.time) ? ' · ' + tzAbbr(l.from, l.dep.time) : ''}</small></div>`
    : gone
    ? h`<div class="tile ${gateRing ? 'ring' : ''}"><small>${l.to} gate${aTerm ? ' · ' + aTerm : ''}</small><b data-k="ag-${l.id}">${l.arr.gate || '—'}</b><small>${l.arr.gate ? concourse(l.to, l.arr.gate) || 'Arrival gate' : 'Not posted yet'}</small></div>
      <div class="tile"><small>${l.arr.actual ? 'Landed' : l.state === 'air' ? 'Lands' : 'Arrived'}</small><b class="tn">${l.arr.time ? N.time(l.arr.time, l.to) : '—'}</b><small class="tn">${l.dep.actual && l.dep.time ? `Took off ${N.time(l.dep.time, l.from)}` : l.to}</small></div>`
    : l.canceled
    ? h`<div class="tile fx-off"><small>Gate${term ? ' · ' + term : ''}</small><b data-k="dg-${l.id}">${l.dep.gate || '—'}</b><small>${l.dep.gate ? 'Was the gate' : 'No gate'}</small></div>
      <div class="tile fx-off"><small>Boards</small><b>—</b><small>Not boarding</small></div>`
    : h`<div class="tile ${gateRing ? 'ring' : ''}"><small>Gate${term ? ' · ' + term : ''}</small><b data-k="dg-${l.id}">${l.dep.gate || '—'}</b><small>${gateSub}</small></div>
      <div class="tile ${timeRing ? 'ring' : ''}"><small>Boards</small><b class="tn" data-k="bd-${l.id}">${l.board ? N.time(l.board, l.from) : '—'}</b><small class="tn">${l.doors ? `Doors close ${N.time(l.doors, l.from)}` : 'About 40 min before'}</small></div>`;
  return h`<div class="tiles fx-tiles">
    ${first}${seatTile}${acTile}
  </div>`;
}

N.screen('flight', {
  nav: 1,
  uses: USES,
  back: 'flights',
  tone: 'cream',
  title: ctx => { const l = findLeg(ctx.param); return l ? `${fno(l)} ${l.from}–${l.to}` : 'Flight'; },
  render(ctx) {
    const l = findLeg(ctx.param);
    if (!l) {
      return {body: h`<div class="fx"><div class="ey">Flight</div><h1 class="h2 fx-nf">That flight isn’t on this trip</h1>
        <p class="small mu">It may have been removed in a trip update.</p><a class="btn" href="#flights">${icon('plane')}All flights</a></div>`};
    }
    const legs = legsOf(l.dir);
    const idx = legs.findIndex(x => x.id === l.id);
    const last = idx === legs.length - 1;
    const ch = changesFor(l.id);
    const nc = nextCheck(l);
    const toLabel = !last ? 'Connect' : l.dir === 'out' ? 'Arrive' : 'Home';
    const from = lc(l.from), to = lc(l.to);
    const guides = [l.from, l.to].filter(c => N.guideFor(c));
    return {body: h`<div class="fx">
      <div class="ey">${N.dirLabel(l.dir)} · ${fno(l)} · Leg ${idx + 1} of ${legs.length}</div>
      <div class="fx-codes" aria-label="${l.from} to ${l.to}">
        <span class="dp fx-from">${l.from}</span>
        <div class="fx-to"><div class="ey">${toLabel}</div><span class="dp">${l.to}</span></div>
      </div>
      ${legBanners(l, ch).map(b => h`<div class="fx-gap">${b}</div>`)}
      <div class="fx-stat">${statusChip(l, true)}${nc ? h`<span class="small mu tn fx-nc">${nc}</span>` : ''}</div>
      ${timesGrid(l)}
      ${tiles(l, ch)}
      <div class="stack8 fx-rows">${inboundRow(l)}${connRow(l, legs)}${arrivalRow(l, legs)}</div>
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
    let st = l && l.state;
    this._st = st;
  },
  tick(ctx) {
    const l = findLeg(ctx.param);
    if (l && this._st && l.state !== this._st) { this._st = l.state; N.rerender(); return; }
    // keep the plane marker moving while in the air
    if (l && l.state === 'air') {
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
  const pts = [['Land', land], ['Board', board], ['Doors', doors], ['Dep', dep]];
  // Land and Doors above the bar, Board and Dep below, when they have room.
  const fits = pl <= 1 && pd >= 38 && pb <= 62;
  if (fits) {
    const lab = (i, st, below) => h`<span class="${i === 2 ? 'cx-doors' : ''}" style="${st}">${below ? '' : h`<small>${pts[i][0]}</small>`}<b class="tn">${N.time(pts[i][1], at)}</b>${below ? h`<small>${pts[i][0]}</small>` : ''}</span>`;
    return h`<div class="cx-tl">
      <div class="cx-up">${lab(0, 'left:0')}${lab(2, `left:${pd.toFixed(1)}%;transform:translateX(calc(-100% - 8px));text-align:right`)}</div>
      ${bar}
      <div class="cx-dn">${lab(1, `left:${pb.toFixed(1)}%;transform:translateX(${pb > 2 ? 6 : 0}px)`, 1)}${lab(3, 'right:0;text-align:right', 1)}</div>
    </div>`;
  }
  return h`<div class="cx-tl">${bar}<div class="cx-grid">${pts.map((p, i) => h`<div class="${i === 2 ? 'cx-doors' : ''}"><small>${p[0]}</small><b class="tn">${N.time(p[1], at)}</b></div>`)}</div></div>`;
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
  const w = useFc ? fc : wx;
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
  const w = bad ? N.walk(null, null) : c ? c.walk : N.walk(ag, bg);
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
  title: ctx => `Connection in ${city((legsOf(ctx.param === 'ret' ? 'ret' : 'out')[0] || {}).to)}`,
  render(ctx) {
    const dir = ctx.param === 'ret' ? 'ret' : 'out';
    const legs = legsOf(dir);
    if (legs[0]) this.back = `flight/${legs[0].id}`;
    if (legs.length < 2) {
      return {hero: h`<div class="cx-h"><div class="ey">Connection</div><h1 class="hl"><b>Nonstop</b>, no connection</h1></div>`,
        body: h`<div class="cx"><a class="btn" href="#flights">${icon('plane')}All flights</a></div>`};
    }
    const c = conn(dir);
    const [a, b] = legs;
    const at = a.to;
    const tone = levelTone(c);
    const bad = a.canceled || b.canceled || a.diverted;
    const hero = h`<div class="cx-h">${hubSvg(a.arr.gate, b.dep.gate)}
      <div class="ey">Connect · ${city(at)}</div>
      <div class="cx-big ${bad && c ? 'was' : ''}">${c ? h`<span class="dp tn" data-k="cx-min">${Math.max(0, c.ground)}</span><span class="dp cx-u">min</span>` : h`<span class="dp cx-unk" data-k="cx-min" aria-label="Minutes not known yet">?</span><span class="dp cx-u">min</span>`}</div>
      <span class="chip ${chipCls(tone)} cx-lvl"><span class="dot ${dotCls(tone)}"></span>${bad ? (a.diverted && !a.canceled ? 'Diverted' : 'Canceled') : c ? cxText(c) : 'Times not confirmed'}</span>
    </div>`;
    let top;
    if (c) {
      const toDoor = N.mins(a.arr.time, b.doors);
      top = h`<div class="cx-sum tn">${bad ? 'Planned: ' : ''}${toDoor > 0 ? `${N.dur(c.ground)} on the ground, ${N.dur(toDoor)} to the door` : `${fno(a)} lands after ${fno(b)}’s doors close`}</div>
        ${timeline(c)}
        <p class="small mu cx-th">${bad ? 'These were the planned times. Your new flight and its times are in the AA app.' : c.free >= 0 ? `About ${N.dur(c.free)} spare before boarding starts${toDoor - 10 - c.walk.min > c.free ? ` and ${N.dur(toDoor - 10 - c.walk.min)} before the doors close` : ''}, after ~10 min to get off the plane and ~${c.walk.min} min walking.` : `Boarding starts before you’re likely to reach the gate (${N.dur(-c.free)} short).${toDoor - 10 - c.walk.min > 0 ? ` That still leaves about ${N.dur(toDoor - 10 - c.walk.min)} before the doors close.` : ' The doors may close before you get there; tell the crew as you land.'}`}${bad ? '' : ' Comfortable at 30+ min spare · Tight 15–29 · At risk under 15.'}</p>`;
    } else {
      top = h`<div class="bn neutral">${icon('info-circle')}<div class="grow"><b>Connection time not known yet</b>
        <span>${legs.filter(l => !l.dep.time).map(fno).join(' and ') || 'These flights'} ${legs.filter(l => !l.dep.time).length > 1 ? 'have' : 'has'} no confirmed times. Once AA publishes them this shows minutes on the ground and when boarding starts.</span>
        <div class="bx">${ext(AA_TRIPS, 'Trips on aa.com')}</div></div></div>`;
    }
    const alert = bad ? h`<div class="bn cx-bn">${icon('alert-triangle')}<div class="grow"><b>${a.canceled ? `${fno(a)} is canceled` : b.canceled ? `${fno(b)} is canceled` : `${fno(a)} diverted to ${a.diverted}`}</b>
      <span>AA rebooks missed connections automatically. Check the AA app for your new flight before walking to a gate.</span></div></div>` : '';
    const legRow = (l, word) => h`<a class="fx-row fx-go" href="#flight/${l.id}"><span class="ic">${icon(word === 'in' ? 'plane-arrival' : 'plane-departure')}</span><div class="grow">
      <b>${fno(l)} · ${l.from} → ${l.to}</b><small class="tn">${word === 'in'
        ? `Lands ${l.arr.time ? N.time(l.arr.time, at) : 'time TBC'}${l.arr.gate ? ` · gate ${l.arr.gate}` : ''}`
        : `Boards ${l.board ? N.time(l.board, at) : 'time TBC'} · departs ${l.dep.time ? N.time(l.dep.time, at) : 'TBC'}${l.dep.gate ? ` · gate ${l.dep.gate}` : ''}`} · ${legSt(l).text}</small></div>${icon('chevron-right')}</a>`;
    return {hero, body: h`<div class="cx">
      ${alert}${top}
      ${guidance(dir, legs, c, bad)}
      <div class="sec wrap cx-chips">${wxChip(at, [a.id, b.id], dir)}${N.guideFor(at) ? h`<a class="chip fl-lk dk2" href="#airport/${lc(at)}">${icon('map')}${at} map &amp; guide</a>` : ''}</div>
      <div class="sec"><div class="ey">The two flights</div><div class="stack8">${legRow(a, 'in')}${legRow(b, 'out')}</div></div>
    </div>`};
  },
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
      return {hero: h`<div class="st-h"><div class="ey">Seat map</div><h1 class="hl"><b>Flight not found</b></h1></div>`,
        body: h`<div class="st"><a class="btn" href="#flights">${icon('plane')}All flights</a></div>`};
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
    const mineRows = mine.map(s => {
      const m = s.match(/^(\d{1,2})([A-K])$/);
      const cab = m && known.get(s);
      if (!cab) return h`<div class="rw"><span class="ic st-ic">${icon('armchair')}</span><div class="grow"><b class="tn">${s}</b><small>Not on this layout. The plane may have been swapped; check the AA app.</small></div></div>`;
      const r = +m[1], L = m[2];
      const why = [...avoidWhy.filter(([set]) => hits(set, r, L)).map(([, t]) => ['avoid', t]), ...goodWhy.filter(([set]) => hits(set, r, L)).map(([, t]) => ['good', t])];
      const exit = cab.exits.has(r);
      return h`<div class="rw"><span class="ic st-ic">${icon('armchair')}</span><div class="grow"><b class="tn">${s} · ${seatPos(cab, L)}</b>
        <small>Row ${r} · ${cab.name}${exit ? ' · exit row' : ''}</small>
        ${why.slice(0, 2).map(([k, t]) => h`<small class="st-why ${k}">${icon(k === 'good' ? 'thumb-up' : 'alert-circle')}${t}</small>`)}</div></div>`;
    });
    const grid = cabins.map(c => {
      const head = h`<div class="st-row st-head" aria-hidden="true">${c.groups.map((g, gi) => h`${gi ? h`<span class="st-ai"></span>` : ''}<span class="st-g" style="--n:${g.length}">${g.map(L => h`<span>${L}</span>`)}</span>`)}</div>`;
      const rows = c.rows.map(r => {
        const exit = c.exits.has(r);
        return h`<div class="st-row ${exit ? 'exit' : ''}">${c.groups.map((g, gi) => h`${gi ? h`<span class="st-ai tn">${r}</span>` : ''}<span class="st-g" style="--n:${g.length}">${g.map(L => {
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
        : h`<a class="fx-row fx-go st-add" href="#wallet"><span class="ic">${icon('armchair')}</span><div class="grow"><b>Add your seats in Wallet</b><small>They’re highlighted here and stay on this phone.</small></div>${icon('chevron-right')}</a>`}
      <div class="st-key" aria-hidden="true">
        <span><i class="st-s me"></i>Yours</span><span><i class="st-s xl"></i>Extra legroom</span><span><i class="st-s good"></i>Good pick</span><span><i class="st-s bad"></i>Avoid</span><span><i class="st-x"></i>Exit row</span>
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
});
})();
