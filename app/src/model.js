/* Trip model: merges the planned legs (trip.bin) with the latest checks
   (status.bin) and works out connections, travel windows, leave times and
   what changed since the traveler last looked. Pure functions over N.data. */
(() => {
'use strict';
const N = window.N;
const T = v => v ? new Date(v).getTime() : NaN;
const ok = v => Number.isFinite(v);

// Typical American Airlines domestic timings, minutes before departure.
N.AA = {board: 40, doors: 15, bagdrop: 45};

N.trip = () => N.data.trip && N.data.trip.trip || null;
N.hotel = () => {
  const h = N.data.trip && N.data.trip.hotel;
  if (h) return h;
  const w = N.wallet();
  return w.hotel_address ? {name: w.hotel_name || 'Hotel', address: w.hotel_address, local: true} : null;
};

// One merged leg. Planned values are the fallback for anything the checker has not seen.
function merge(p, s, wallet) {
  s = s || {};
  const sd = s.dep || {}, sa = s.arr || {};
  const live = s.route_ok !== false && !s.fetch_failed && !!s.status;
  const dep = {
    terminal: live && sd.terminal || p.dep_terminal || null,
    gate: live && sd.gate || null,
    sched: live && sd.sched || p.dep,
    est: live && sd.est || null,
    actual: !!(live && sd.actual),
  };
  dep.time = dep.est || dep.sched;
  const arr = {
    terminal: live && sa.terminal || p.arr_terminal || null,
    gate: live && sa.gate || null,
    baggage: live && sa.baggage || null,
    sched: live && sa.sched || p.arr,
    est: live && sa.est || null,
    actual: !!(live && sa.actual),
  };
  arr.time = arr.est || arr.sched;
  const canceled = !!(live && s.canceled);
  const diverted = live && s.diverted_to || null;
  const delay = live ? Math.max(s.delay_dep_min || 0, dep.est && dep.sched ? N.mins(dep.sched, dep.est) : 0) : 0;
  const leg = Object.assign({}, p, {
    dep, arr, live, canceled, diverted,
    status: live ? s.status : null,
    status_detail: live ? s.status_detail : null,
    phase: live ? s.phase : null,
    departed: !!(live && s.departed),
    landed: !!(live && s.landed),
    delay_dep: delay,
    delay_arr: live ? s.delay_arr_min || 0 : 0,
    aircraft: live && s.aircraft || p.aircraft,
    aircraft_code: live && s.aircraft_code || p.aircraft_code,
    inbound: live && s.inbound || null,
    events: s.events || [],
    checked_at: s.checked_at || null,
    source: live ? s.source : null,
    source_note: live ? s.source_note : null,
    route_ok: s.route_ok,
    route_seen: s.route_seen || null,
    fetch_failed: !!s.fetch_failed,
    seats: (wallet.seats && wallet.seats[p.id] || []).filter(Boolean),
  });
  leg.board = dep.time ? N.addMin(dep.time, -N.AA.board) : null;
  leg.doors = dep.time ? N.addMin(dep.time, -N.AA.doors) : null;
  leg.state = state(leg);
  return leg;
}
function state(l) {
  if (l.canceled) return 'canceled';
  if (l.diverted) return 'diverted';
  if (l.landed || l.arr.actual) return 'landed';
  if (l.departed || l.dep.actual) return 'air';
  const now = N.now().getTime();
  if (l.dep.time && now >= T(l.board) && now < T(l.dep.time) + 20 * 60000) return 'boarding';
  if (!l.dep.time) return 'unknown';
  if (now > T(l.arr.time) + 30 * 60000) return 'past';
  return 'scheduled';
}

N.legs = () => {
  const t = N.data.trip;
  if (!t) return [];
  const st = N.data.status && N.data.status.legs || {};
  const w = N.wallet();
  return t.legs.map(p => merge(p, st[p.id], w));
};
N.leg = id => N.legs().find(l => l.id === id) || null;
N.dirLegs = dir => N.legs().filter(l => l.dir === dir).sort((a, b) => a.seq - b.seq);

// Short status words and a tone for chips: ok, warn, bad, neutral.
N.legStatus = l => {
  if (!l) return {text: '—', tone: 'neutral'};
  if (l.canceled) return {text: 'Canceled', tone: 'bad'};
  if (l.diverted) return {text: `Diverted to ${l.diverted}`, tone: 'bad'};
  if (l.route_ok === false) return {text: 'Needs checking', tone: 'warn'};
  if (l.state === 'landed') return {text: 'Landed', tone: 'ok'};
  if (l.state === 'air') return {text: l.delay_arr > 14 ? `In the air · ${N.dur(l.delay_arr)} late` : 'In the air', tone: l.delay_arr > 14 ? 'warn' : 'ok'};
  if (l.state === 'boarding') return {text: 'Boarding', tone: 'ok'};
  if (l.delay_dep > 14) return {text: `Delayed ${N.dur(l.delay_dep)}`, tone: 'warn'};
  if (!l.live) return {text: l.confirmed === false ? 'Not confirmed' : 'Scheduled', tone: 'neutral'};
  return {text: l.delay_dep > 4 ? `${l.delay_dep} min late` : 'On time', tone: 'ok'};
};

// ---------- connections ----------
const CONC = ['A', 'B', 'C', 'D', 'E'];
const concourse = g => { const m = String(g || '').trim().toUpperCase().match(/^([A-Z])/); return m ? m[1] : null; };
// Walking minutes between two CLT gates; 15 when a gate is not known yet.
N.walk = (g1, g2) => {
  const a = concourse(g1), b = concourse(g2);
  if (!a || !b) return {min: 15, known: false};
  if (a === b) return {min: 5, known: true, same: true};
  const i = CONC.indexOf(a), j = CONC.indexOf(b);
  return {min: i >= 0 && j >= 0 && Math.abs(i - j) === 1 ? 10 : 20, known: true};
};
// ok: 30+ free minutes before boarding, tight: 15-29, risk: under 15.
N.connection = dir => {
  const [a, b] = N.dirLegs(dir);
  if (!a || !b || !a.arr.time || !b.dep.time) return null;
  const ground = N.mins(a.arr.time, b.dep.time);
  const walk = N.walk(a.arr.gate, b.dep.gate);
  // Plane to gate: about 10 minutes from touchdown to the door opening.
  const free = N.mins(N.addMin(a.arr.time, 10 + walk.min), b.board);
  const level = b.canceled || a.canceled ? 'risk' : free >= 30 ? 'ok' : free >= 15 ? 'tight' : 'risk';
  return {dir, a, b, at: a.to, ground, walk, free, level,
    text: level === 'ok' ? 'Comfortable' : level === 'tight' ? 'Tight' : 'At risk'};
};

// ---------- trip phases ----------
const dayStart = (ymd, ap) => {
  // Midnight local at airport ap, as a timestamp.
  const guess = new Date(ymd + 'T12:00:00Z');
  const p = new Intl.DateTimeFormat('en-US', {timeZone: N.tz(ap), hour: 'numeric', hourCycle: 'h23', minute: 'numeric'}).formatToParts(guess);
  const h = +p.find(x => x.type === 'hour').value, m = +p.find(x => x.type === 'minute').value;
  return guess.getTime() - (h * 60 + m) * 60000;
};
// [start, end] of a direction's travel day: 12h before the first departure
// to 3h after the last arrival, or that whole local day when times are unknown.
N.span = dir => {
  const legs = N.dirLegs(dir);
  if (!legs.length) return null;
  const first = legs[0], last = legs[legs.length - 1];
  const d0 = T(first.dep.time), d1 = T(last.arr.time);
  const day = dayStart(first.date, first.from);
  return [ok(d0) ? d0 - 12 * 3600000 : day, ok(d1) ? d1 + 3 * 3600000 : day + 27 * 3600000];
};
N.travelWindow = () => {
  const now = N.now().getTime();
  for (const d of ['out', 'ret']) { const s = N.span(d); if (s && now >= s[0] && now <= s[1]) return d; }
  return null;
};
// before | out | stay | ret | after
N.phase = () => {
  const w = N.travelWindow();
  if (w) return w;
  const now = N.now().getTime(), o = N.span('out'), r = N.span('ret');
  if (o && now < o[0]) return 'before';
  if (r && now > r[1]) return 'after';
  return 'stay';
};
// The leg to look at now: the first one not yet landed in the current or next direction.
N.nextLeg = () => {
  const legs = N.legs().filter(l => l.state !== 'past' && l.state !== 'landed');
  return legs[0] || null;
};
N.dirLabel = d => d === 'out' ? 'To New York' : 'Home';

// ---------- leave times ----------
// Outbound: home to PHX. Return: hotel to LGA, using the live drive estimate when there is one.
N.leave = dir => {
  const legs = N.dirLegs(dir);
  const first = legs[0];
  if (!first || !first.dep.time) return null;
  const buf = +N.prefs().leave_buffer || 0;
  const g = N.data.guide && N.data.guide.plan && N.data.guide.plan[dir] || {};
  const arriveBefore = g.arrive_before_min || (dir === 'out' ? 105 : 100);
  let drive = g.drive_min || (dir === 'out' ? 25 : 35), source = 'typical';
  const tr = N.data.status && N.data.status.traffic && N.data.status.traffic.to_lga;
  if (dir === 'ret' && tr && tr.min) { drive = tr.min; source = 'traffic'; }
  const at = N.addMin(first.dep.time, -(arriveBefore + drive + buf));
  return {at, arrive: N.addMin(first.dep.time, -arriveBefore), drive, arriveBefore, buffer: buf, source, leg: first,
    bagdrop: N.addMin(first.dep.time, -N.AA.bagdrop)};
};

// ---------- airports, weather ----------
N.airportLive = code => N.data.status && N.data.status.airports && N.data.status.airports[code] || {};
N.guideFor = code => N.data.guide && N.data.guide.airports && N.data.guide.airports[code] || null;

// ---------- changes since last look ----------
// A snapshot per leg of what matters at the airport; the Today and Flights
// screens show anything that differs and clear it with N.markSeen().
const snap = l => ({dg: l.dep.gate, dt: l.dep.terminal, ag: l.arr.gate, bg: l.arr.baggage,
  d: l.dep.time && Math.round(T(l.dep.time) / 60000), c: l.canceled, v: l.diverted});
N.changes = () => {
  const seen = N.get('nyc.seen', {}) || {};
  const out = [];
  N.legs().forEach(l => {
    if (!l.live) return;
    const s = seen[l.id], n = snap(l);
    if (!s) return;
    const add = (k, text) => out.push({leg: l, k, text});
    if (n.c && !s.c) add('c', `${l.flight} is canceled`);
    if (n.v && !s.v) add('v', `${l.flight} diverted to ${n.v}`);
    if (n.dg && s.dg && n.dg !== s.dg) add('dg', `${l.flight} gate ${s.dg} → ${n.dg}`);
    if (n.dt && s.dt && n.dt !== s.dt) add('dt', `${l.flight} terminal ${s.dt} → ${n.dt}`);
    if (n.ag && s.ag && n.ag !== s.ag) add('ag', `${l.flight} arrives at gate ${n.ag} (was ${s.ag})`);
    if (n.bg && s.bg && n.bg !== s.bg) add('bg', `${l.flight} bags now carousel ${n.bg}`);
    if (n.d && s.d && Math.abs(n.d - s.d) >= 5) add('d', `${l.flight} now leaves ${N.time(l.dep.time, l.from)} (${n.d > s.d ? '+' : '−'}${N.dur(n.d - s.d)})`);
  });
  return out;
};
// Record current values; first sight of a leg is recorded silently.
N.markSeen = (ids) => {
  const seen = N.get('nyc.seen', {}) || {};
  N.legs().forEach(l => { if (l.live && (!ids || ids.includes(l.id))) seen[l.id] = snap(l); });
  N.set('nyc.seen', seen);
};
N.on('data', name => {
  if (name !== 'status') return;
  const seen = N.get('nyc.seen', {}) || {};
  let add = false;
  N.legs().forEach(l => { if (l.live && !seen[l.id]) { seen[l.id] = snap(l); add = true; } });
  if (add) N.set('nyc.seen', seen);
});

// ---------- calendar ----------
const icsDate = iso => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsEsc = s => String(s || '').replace(/[\\;,]/g, m => '\\' + m).replace(/\n/g, '\\n');
N.ics = () => {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//nyc//trip//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  N.legs().filter(l => l.dep.sched && l.arr.sched).forEach(l => {
    const seats = l.seats.length ? ` · Seat ${l.seats.join(', ')}` : '';
    lines.push('BEGIN:VEVENT', `UID:${l.id}-${l.date}@nyc.trip`, `DTSTAMP:${icsDate(new Date())}`,
      `DTSTART:${icsDate(l.dep.sched)}`, `DTEND:${icsDate(l.arr.sched)}`,
      `SUMMARY:${icsEsc(`${l.flight} ${l.from} → ${l.to}`)}`,
      `LOCATION:${icsEsc(`${l.from}${l.dep.terminal ? ' Terminal ' + l.dep.terminal : ''}`)}`,
      `DESCRIPTION:${icsEsc(`American ${l.num}${seats}. Check the app for the latest gate.`)}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(l.flight + ' boards soon')}`, `TRIGGER:-PT${N.AA.board + 20}M`, 'END:VALARM',
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(l.flight + ' in 3 hours')}`, 'TRIGGER:-PT3H', 'END:VALARM',
      'END:VEVENT');
  });
  const lv = N.leave('out');
  if (lv) lines.push('BEGIN:VEVENT', `UID:leave-out@nyc.trip`, `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(lv.at)}`,
    `DTEND:${icsDate(N.addMin(lv.at, 15))}`, 'SUMMARY:Leave for PHX', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Leave for the airport', 'TRIGGER:-PT15M', 'END:VALARM', 'END:VEVENT');
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
};
N.actions.ics = () => {
  const blob = new Blob([N.ics()], {type: 'text/calendar'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'nyc-flights.ics';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};

// ---------- maps ----------
// Opens Apple Maps on iPhone (and Google Maps elsewhere) for directions.
N.mapsUrl = (dest, mode = 'r', from) => {
  const q = encodeURIComponent(typeof dest === 'string' ? dest : `${dest.lat},${dest.lon}`);
  const ios = /iPhone|iPad|Macintosh/.test(navigator.userAgent);
  if (ios) return `https://maps.apple.com/?daddr=${q}&dirflg=${mode}${from ? '&saddr=' + encodeURIComponent(from) : ''}`;
  const gm = {r: 'transit', d: 'driving', w: 'walking'}[mode] || 'transit';
  return `https://www.google.com/maps/dir/?api=1&destination=${q}&travelmode=${gm}`;
};
// Distance in metres between two {lat, lon}.
N.dist = (a, b) => {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
N.walkMin = m => Math.max(1, Math.round(m / 80));
N.distText = m => m < 160 ? `${Math.round(m / 0.3048 / 10) * 10} ft` : `${(m / 1609.34).toFixed(m < 1609 ? 2 : 1)} mi`;
})();
