/* Airports: the one you are at or heading to (#airports) and each airport by
   code (#airport/phx|clt|lga). Hero with the giant code, conditions tiles,
   what matters now, your flights here, the steps through the airport with
   real times, a zoomable terminal map with your gate and walking route, then
   security, food near your gate, services, ground transport, facts, tips and
   links.
   Seats come only from leg.seats (the Wallet, merged by the model) and are
   only shown on this phone; nothing from the Wallet goes into a link. */
(() => {
'use strict';
const {h, icon, raw} = N;
const T = v => v ? new Date(v).getTime() : NaN;
const okT = v => Number.isFinite(T(v));
const nowMs = () => N.now().getTime();
const str = v => v == null ? '' : String(v);
const arr = v => Array.isArray(v) ? v : [];
const obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : null;
const lc = s => str(s).toLowerCase();
const HR = 3600000;
const DEFAULT_CODES = ['PHX', 'CLT', 'LGA'];
const AA_PHONE = 'tel:+18004337300';

// ---------- data access that never throws ----------
const guide = code => { try { return obj(N.guideFor(code)); } catch (e) { return null; } };
const live = code => { try { return obj(N.airportLive(code)) || {}; } catch (e) { return {}; } };
const legsOf = dir => { try { return arr(N.dirLegs(dir)); } catch (e) { return []; } };
const phase = () => { try { return N.phase(); } catch (e) { return 'before'; } };
const legSt = l => { try { return N.legStatus(l); } catch (e) { return {text: '—', tone: 'neutral'}; } };
const hasIcon = n => !!n && /^[a-z0-9-]+$/.test(n) && !!document.getElementById('i-' + n);
const ic = (n, fb = 'info-circle', cls = '') => icon(hasIcon(n) ? n : fb, cls);
const ext = (url, body, cls = '') => /^(https?:|tel:)/i.test(str(url))
  ? h`<a class="${cls}" href="${url}" target="_blank" rel="noopener">${body}</a>` : '';

// ---------- names and times ----------
const NAMES = {PHX: 'Phoenix', CLT: 'Charlotte', LGA: 'LaGuardia'};
const apName = code => str(guide(code) && guide(code).name).replace(/\s+International\b/i, '').trim() || NAMES[code] || code;
const apCity = code => { const g = guide(code); return str(g && g.city).replace(/\s*\(.*?\)\s*/g, ' ').trim() || {PHX: 'Phoenix', CLT: 'Charlotte', LGA: 'New York'}[code] || code; };
// "AA 123": carrier and number with a no-break space, from the data or the guide's text.
const fnoText = s => str(s).replace(/\b([A-Z]{2})(\d{2,4})\b/g, '$1 $2');
const flightNo = l => {
  if (!l) return '';
  const f = str(l.flight).trim(), m = f.match(/^([A-Z]{2})\s*(\d+)$/);
  return m ? `${m[1]} ${m[2]}` : f || (l.num ? `${l.carrier || 'AA'} ${l.num}` : '');
};
const tzAbbr = (ap, iso) => {
  try {
    const p = new Intl.DateTimeFormat('en-US', {timeZone: N.tz(ap), timeZoneName: 'short'}).formatToParts(iso ? new Date(iso) : N.now());
    const z = (p.find(x => x.type === 'timeZoneName') || {}).value || '';
    return /^(GMT|UTC)/.test(z) ? '' : z;
  } catch (e) { return ''; }
};
// A meta line: parts joined with " · ", each kept whole unless it is long enough to need wrapping.
const meta = parts => parts.filter(Boolean).map((x, i) => h`${i ? ' · ' : ''}${String(x).length <= 28 ? h`<span class="nw">${x}</span>` : x}`);
const sameDay = (a, b, ap) => { try { return !!a && !!b && N.ymd(a, ap) === N.ymd(b, ap); } catch (e) { return false; } };
// "4:31a" today, "Sun 2:31p" on another day (airport-local).
const when = (iso, ap) => !okT(iso) ? '' : sameDay(iso, N.now(), ap) ? N.time(iso, ap) : `${N.date(iso, ap).split(' ')[0]} ${N.time(iso, ap)}`;
const ct = (iso, ap) => N.time(iso, ap).replace(':00', '');   // "5a", "5:15a"
const tmz = (iso, ap) => okT(iso) ? `${N.time(iso, ap)}${tzAbbr(ap, iso) ? ' ' + tzAbbr(ap, iso) : ''}` : '';
const dayOf = (v, code) => v ? N.date(v.at || (v.leg && v.leg.date ? v.leg.date + 'T16:00:00Z' : null), code) : '';
const termLabel = t => !t ? '' : /^\d+$/.test(str(t)) ? `Terminal ${t}` : /^[A-Z]$/i.test(str(t)) ? `Terminal ${str(t).toUpperCase()}` : str(t);
// Minutes after local midnight at the airport.
const localMin = (iso, code) => {
  try {
    const p = new Intl.DateTimeFormat('en-US', {timeZone: N.tz(code), hour: 'numeric', minute: 'numeric', hourCycle: 'h23'}).formatToParts(new Date(iso));
    const g = t => +((p.find(x => x.type === t) || {}).value || 0);
    return (g('hour') % 24) * 60 + g('minute');
  } catch (e) { return null; }
};

// ---------- the trip at this airport ----------
const departed = l => !!l && !l.canceled && !!(l.departed || (l.dep && l.dep.actual) || ['air', 'landed', 'past'].includes(l.state) || (okT(l.dep && l.dep.time) && nowMs() >= T(l.dep.time)));
// What the flight data has confirmed, not what the clock implies: only these say "left" / "landed".
const leftOK = l => !!l && !l.canceled && !!(l.departed || (l.dep && l.dep.actual) || ['air', 'landed'].includes(l.state));
const downOK = l => !!l && !l.canceled && !!(l.landed || (l.arr && l.arr.actual) || l.state === 'landed');

function codes() {
  const out = [];
  for (const d of ['out', 'ret']) legsOf(d).forEach(l => [l.from, l.to].forEach(c => { c = str(c).toUpperCase(); if (/^[A-Z]{3}$/.test(c) && !out.includes(c)) out.push(c); }));
  const ga = obj(N.data.guide && N.data.guide.airports) || {};
  Object.keys(ga).forEach(c => { if (/^[A-Z]{3}$/.test(c) && !out.includes(c)) out.push(c); });
  return (out.length ? out : DEFAULT_CODES.slice()).slice(0, 4);
}
// The airport that matters now: PHX before the trip and on the leave
// morning, CLT once the first flight is off, LGA after landing and on the
// return day, then back along the return.
function autoCode() {
  const list = codes();
  const ph = phase();
  let c = null;
  if (ph === 'out' || ph === 'ret') {
    const legs = legsOf(ph);
    const next = legs.find(l => !departed(l));
    c = next ? next.from : legs.length ? legs[legs.length - 1].to : null;
  } else if (ph === 'stay') {
    const o = legsOf('out'); c = o.length ? o[o.length - 1].to : 'LGA';
  } else {
    const o = legsOf('out'); c = o.length ? o[0].from : 'PHX';
  }
  c = str(c).toUpperCase();
  return list.includes(c) ? c : list[0];
}

// Each time the trip passes through the airport.
// {key, dir, role: depart|connect|arrive, inn (leg landing here), out (leg leaving), leg, at}
function visitsOf(code) {
  const out = [];
  for (const dir of ['out', 'ret']) {
    const legs = legsOf(dir);
    legs.forEach((l, i) => {
      if (l.from === code) {
        const inn = i > 0 && legs[i - 1].to === code ? legs[i - 1] : null;
        out.push({dir, role: inn ? 'connect' : 'depart', inn, out: l});
      } else if (l.to === code && !(legs[i + 1] && legs[i + 1].from === code)) {
        out.push({dir, role: 'arrive', inn: l, out: null});
      }
    });
  }
  out.forEach(v => {
    v.key = `${v.dir}-${v.role}`;
    v.leg = v.out || v.inn;
    v.at = v.role === 'depart' ? v.out.dep.time : v.inn.arr.time;
  });
  return out;
}
function overV(v) {
  if (v.out) return departed(v.out);
  const t = v.inn && v.inn.arr && v.inn.arr.time;
  if (okT(t)) return nowMs() > T(t) + 3 * HR;
  const ph = phase();
  return v.dir === 'out' ? ['stay', 'ret', 'after'].includes(ph) : ph === 'after';
}
const picked = {};   // code → visit key chosen on this phone (memory only)
function curVisit(code, list) {
  if (!list.length) return null;
  const p = picked[code] && list.find(v => v.key === picked[code]);
  return p || list.find(v => !overV(v)) || list[list.length - 1];
}
const roleWord = r => r === 'depart' ? 'Depart' : r === 'connect' ? 'Connect' : 'Arrive';
const gateOf = v => !v ? null : v.role === 'arrive' ? v.inn.arr.gate : v.out.dep.gate;

// ---------- weather, FAA, security ----------
const SHORT_WX = [[/thunder|storm/i, 'Storms'], [/snow|flurr/i, 'Snow'], [/sleet|ice|freezing/i, 'Ice'], [/shower|rain|drizzle/i, 'Rain'],
  [/fog|haze|smoke|mist/i, 'Fog'], [/wind|breez/i, 'Windy'], [/overcast|cloudy/i, 'Cloudy'], [/partly|mostly sunny|mostly clear/i, 'Some sun'], [/sunny|clear/i, 'Clear']];
const shortWx = t => { t = str(t); if (t.length <= 11) return t; const m = SHORT_WX.find(([re]) => re.test(t)); return m ? m[1] : t.split(/\s+/).slice(0, 2).join(' '); };
function wxFor(code, v) {
  const wx = obj(live(code).wx) || {};
  const at = v && v.at;
  if (okT(at)) {
    const id = v.role === 'depart' ? [v.out.id, 'dep'] : [v.inn.id, 'arr'];
    const L = arr(wx.legs).filter(obj);
    const byLeg = L.find(x => x.leg === id[0] && (!x.at || x.at === id[1]));
    const near = (list, win) => list.filter(x => okT(x.t) && Math.abs(T(x.t) - T(at)) <= win).sort((a, b) => Math.abs(T(a.t) - T(at)) - Math.abs(T(b.t) - T(at)))[0];
    const f = byLeg || near(L, 90 * 60000) || near(arr(wx.hourly).filter(obj), 45 * 60000);
    if (f && f.temp_f != null) return {temp: f.temp_f, text: f.text, precip: f.precip_pct, at: f.t || at, fc: true, updated: wx.updated};
  }
  const obs = wx.obs_at || wx.updated;
  if (wx.temp_f != null && okT(obs) && nowMs() - T(obs) < 3 * HR) return {temp: wx.temp_f, text: wx.text, precip: wx.precip_pct, at: obs, fc: false, updated: obs};
  return null;
}
// Guide hours text → {all} | {a, b} minutes after midnight (b may pass 1440) | null.
const clockMin = s => {
  const m = str(s).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m?\.?$/i);
  if (!m) return null;
  let hh = +m[1] % 12; if (/p/i.test(m[3])) hh += 12;
  return hh * 60 + (+m[2] || 0);
};
function hoursRange(s) {
  s = str(s);
  if (/24\s*h|24\/7|around the clock/i.test(s)) return {all: true};
  const m = s.match(/(\d{1,2}(?::\d{2})?\s*[ap])\.?m?\.?\s*(?:[–—-]|to)\s*(\d{1,2}(?::\d{2})?\s*[ap])/i);
  if (!m) return null;
  const a = clockMin(m[1]), b = clockMin(m[2]);
  if (a == null || b == null) return null;
  return {a, b: b <= a ? b + 1440 : b};
}
const openAt = (r, m) => !r || m == null ? null : r.all ? true : (m >= r.a && m < r.b) || (m + 1440 >= r.a && m + 1440 < r.b);
// Guide hours in the app's style: "4:00 a.m.–9:00 p.m." reads "4a–9p".
const apTime = s => str(s).replace(/(\d)\s*([ap])\.?\s?m\.?(?![a-z])/gi, (_, d, p) => d + p.toLowerCase()).replace(/\b(\d{1,2}):00([ap])\b/g, '$1$2');
const clockTxt = m => { m = ((m % 1440) + 1440) % 1440; const hh = Math.floor(m / 60), mm = m % 60; return `${hh % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''}${hh < 12 ? 'a' : 'p'}`; };
// The guide's security step on a departure, if it has one.
const secStep = code => arr(obj(guide(code) && guide(code).steps) ? guide(code).steps.depart : null).filter(obj)
  .find(x => x.icon === 'shield-check' || /security|checkpoint|tsa/i.test(str(x.title))) || null;
// When you go through security on a departure: the guide step, else 90 min before.
function secTime(code, v) {
  if (!v || v.role !== 'depart' || !okT(v.out.dep.time)) return null;
  const s = secStep(code);
  const rel = s && obj(s.rel);
  const m = rel && rel.to === 'dep' && Number.isFinite(+rel.min) ? +rel.min : -90;
  return N.addMin(v.out.dep.time, m);
}

// ---------- hero ----------
function illo(code) {
  const ill = {
    PHX: '<circle cx="114" cy="34" r="13"/><path d="M48 46h44l-8 24H56z"/><path d="M60 70v74M80 70v74"/><path d="M70 46V22M60 22h20"/><path d="M14 144h112"/><path d="M60 98h20M60 120h20"/>',
    CLT: (() => {
      const c = [70, 84], ends = [[-150, 50], [-100, 56], [-40, 56], [10, 54], [62, 50]];
      return `<circle cx="${c[0]}" cy="${c[1]}" r="15"/>` + ends.map(([deg, r]) => {
        const a = deg * Math.PI / 180, x = (c[0] + Math.cos(a) * r).toFixed(1), y = (c[1] + Math.sin(a) * r).toFixed(1);
        const x1 = (c[0] + Math.cos(a) * 15).toFixed(1), y1 = (c[1] + Math.sin(a) * 15).toFixed(1);
        return `<path d="M${x1} ${y1}L${x} ${y}"/><circle cx="${x}" cy="${y}" r="6"/>`;
      }).join('') + '<path d="M14 144h112"/>';
    })(),
    LGA: '<path d="M8 112Q70 34 132 112"/><path d="M8 100h124"/><path d="M38 100V78M70 100V64M102 100V78"/><path d="M14 126h30M56 134h34M100 126h28"/><path d="M84 30l14-4 10-12 3 2-6 12 12 2 3 4-15 1-9 8h-4l4-9z"/>',
  }[code];
  return ill ? raw(`<svg class="il ap-il" viewBox="0 0 140 150" aria-hidden="true"><g class="lk" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">${ill}</g></svg>`) : '';
}
function heroHtml(code, v, list, auto) {
  const g = guide(code);
  const term = v ? (v.role === 'depart' ? v.out.dep.terminal : v.inn.arr.terminal) : null;
  const terms = arr(g && g.terminals).filter(obj);
  const tl = term ? termLabel(term) : terms.length === 1 ? str(terms[0].name) : '';
  // Time and zone never split across lines ("5:59a" / "MST").
  const tz = iso => h`<span class="nw">${tmz(iso, code)}</span>`;
  // Past tense only once the flight data says so; a passed time alone reads "due … · not confirmed yet".
  const said = (l, iso, done, verb, past, what) => l.canceled ? 'canceled' : done ? h`${past} ${tz(iso)}`
    : nowMs() >= T(iso) ? h`${l.state === 'past' ? 'was due' : 'due'} ${tz(iso)} · <span class="nw">${what} not confirmed yet</span>` : h`${verb}${verb ? ' ' : ''}${tz(iso)}`;
  let l1 = '', l2 = '';
  if (v && v.role === 'depart') {
    const l = v.out;
    l1 = okT(l.dep.time) ? h`${flightNo(l)} to ${apCity(l.to)}, ${said(l, l.dep.time, leftOK(l), '', 'left', 'departure')}` : `${flightNo(l)} to ${apCity(l.to)}, time not confirmed`;
  } else if (v && v.role === 'connect') {
    l1 = okT(v.inn.arr.time) && okT(v.out.dep.time)
      ? `${N.dur(N.mins(v.inn.arr.time, v.out.dep.time))} between ${flightNo(v.inn)} and ${flightNo(v.out)}`
      : `${flightNo(v.inn)} in, ${flightNo(v.out)} out, times not confirmed`;
  } else if (v) {
    const l = v.inn;
    l1 = okT(l.arr.time) ? h`${flightNo(l)} from ${apCity(l.from)}, ${said(l, l.arr.time, downOK(l), 'lands', 'landed', 'landing')}` : `${flightNo(l)} from ${apCity(l.from)}, time not confirmed`;
  } else l1 = 'Not on your trip';
  l2 = v ? h`<span class="nw">${roleWord(v.role)} ${dayOf(v, code)}</span>` : '';
  return h`<div class="ap-hero">
    <div class="ps ap-ps" role="group" aria-label="Airport">${codes().map(c => h`<button type="button" data-act="ap" data-arg="${lc(c)}" aria-pressed="${c === code ? 'true' : 'false'}">${c}${c === auto ? h`<i class="ap-nd" aria-hidden="true"></i><span class="ap-vh">, now</span>` : ''}</button>`)}</div>
    <div class="ap-top">
      <div class="ey ap-ey">${apName(code)}${tl ? ` · ${tl}` : ''}</div>
      <div class="dp ap-code" aria-label="${code}">${code}</div>
      <p class="ap-sub"><b data-k="ap-h1-${code}-${v ? v.key : ''}">${l1}</b><span>${l2 ? h`${l2} · ` : ''}<span class="nw">${l2 ? 'it’s' : 'It’s'} <span class="tn" data-clock="${code}">${N.time(N.now(), code)}</span>${tzAbbr(code) ? ` ${tzAbbr(code)}` : ''} here</span></span></p>
    </div>
    ${illo(code)}
  </div>`;
}

// ---------- tiles ----------
function tilesHtml(code, v) {
  const L = live(code), faa = obj(L.faa), tsa = obj(L.tsa) || {}, g = guide(code);
  const wx = wxFor(code, v);
  // The label says when (a forecast to the nearest hour), the subline says what.
  const wxT = wx
    ? {l: wx.fc ? `Weather at ${ct(new Date(Math.round(T(wx.at) / HR) * HR).toISOString(), code)}` : 'Weather now',
      b: `${Math.round(+wx.temp)}°`, s: shortWx(wx.text) || 'Forecast', c: /storm|snow|ice|sleet/i.test(str(wx.text)) || +wx.precip >= 60}
    : {l: 'Weather', b: '—', s: 'No reading'};
  const fs = faa && lc(faa.status);
  const faaT = !faa || !fs ? {b: '—', s: 'Not checked'}
    : fs === 'normal' ? {b: 'Normal', s: 'No delays'}
    : fs === 'ground_stop' || fs === 'ground stop' ? {b: 'Ground stop', s: faa.reason ? shortWx(faa.reason) : 'Flights held', w: true}
    : fs === 'closed' ? {b: 'Closed', s: str(faa.reason) || 'Airport closed', w: true}
    : /delay/.test(fs) ? {b: 'Delays', s: faa.avg_min ? `Avg ${faa.avg_min} min` : str(faa.reason) || 'Reported', w: true}
    : {b: str(faa.status).replace(/_/g, ' '), s: str(faa.text) || ''};
  // An old FAA reading says when it is from instead of sounding current.
  if (faa && fs && okT(faa.updated) && nowMs() - T(faa.updated) > 3 * HR) faaT.s = sameDay(faa.updated, N.now(), code) ? `As of ${N.time(faa.updated, code)}` : `As of ${N.date(faa.updated, code).split(' ')[0]}`;
  let third;
  if (v && v.role === 'connect') third = {l: 'Security', b: 'None', s: 'Stay airside'};
  else if (v && v.role === 'arrive') {
    const bag = v.inn.arr.baggage;
    third = bag ? {l: 'Carousel', b: str(bag), s: flightNo(v.inn)} : {l: 'Carousel', b: '—', s: 'After landing'};
  } else if (tsa.wait_min != null && Number.isFinite(+tsa.wait_min)) {
    third = {l: 'TSA wait', b: `${Math.round(+tsa.wait_min)} min`, s: str(tsa.text) || 'Standard lane', c: +tsa.wait_min >= 30};
  } else {
    const ck = arr(g && g.security).filter(obj)[0];
    const at = secTime(code, v);
    if (!ck) third = {l: 'Security', b: '—', s: 'Not in the guide'};
    else {
      const r = hoursRange(ck.hours);
      const m = at ? localMin(at, code) : localMin(N.now().toISOString(), code);
      const o = openAt(r, m);
      // Judged at your security time when there is one, else now.
      third = {l: 'Security',
        b: o == null ? '—' : o ? (r && r.all ? 'Open 24h' : 'Open') : r && !r.all ? `Opens ${clockTxt(r.a)}` : 'Closed',
        s: o == null ? 'Hours not listed' : str(ck.name) || 'Main checkpoint', c: o === false};
    }
  }
  // w: a real problem (rose ring). c: worth a look (amber dot on the subline).
  const cell = (k, label, t) => h`<div class="${t.w ? 'w' : t.c ? 'ap-cw' : ''}"><small>${label}</small><b data-k="${k}">${t.b}</b><span>${t.s}</span></div>`;
  const sfx = `-${code}-${v ? v.key : ''}`;
  return h`<div class="cn ap-cn">${cell('ap-wx' + sfx, wxT.l, wxT)}${cell('ap-faa' + sfx, 'FAA', faaT)}${cell('ap-3' + sfx, third.l, third)}</div>`;
}

// ---------- callouts ----------
function callouts(code, v) {
  const L = live(code), faa = obj(L.faa), wx = obj(L.wx) || {}, g = guide(code);
  const out = [];
  // Every callout leads with what it is in bold, then the detail.
  const co = (tone, ic2, lead, body) => out.push(h`<div class="co ${tone}">${icon(ic2)}<span><b>${lead}</b>${body ? h` ${body}` : ''}</span></div>`);
  const why = x => x ? ` (${x})` : '';
  const fs = faa && lc(faa.status);
  // Rose for what stops you (ground stop, closed, canceled, at risk); amber edge for what slows you.
  if (fs && /ground/.test(fs)) co('rose', 'alert-triangle', 'FAA ground stop.', `Flights at ${code} are being held${why(faa.reason)}.`);
  else if (fs && /delay/.test(fs)) co('ap-warn', 'clock', 'FAA delays.', `Flights at ${code} ${faa.avg_min ? `are averaging ${faa.avg_min} min late` : 'are running late'}${why(faa.reason)}.`);
  else if (fs === 'closed') co('rose', 'alert-triangle', `${code} closed.`, `The FAA lists the airport as closed${why(faa.reason)}.`);
  arr(wx.alerts).slice(0, 2).forEach(a => {
    const t = typeof a === 'string' ? a : obj(a) ? str(a.event || a.headline || a.title) : '';
    const ends = obj(a) && okT(a.ends) ? `Until ${when(a.ends, code)}.` : '';
    if (t) co('ap-warn', 'alert-triangle', `${t.replace(/\.\s*$/, '')}.`, ends);
  });
  const legs = v ? [v.inn, v.out].filter(Boolean) : [];
  legs.forEach(l => {
    if (l.canceled) co('rose', 'alert-triangle', `${flightNo(l)} canceled.`, h`Rebook in the AA app or at an AA counter. <a class="ap-il2" href="${AA_PHONE}" target="_blank" rel="noopener">Call AA</a>`);
    else if (l.diverted) co('rose', 'alert-triangle', `${flightNo(l)} diverted.`, `Now going to ${l.diverted}. Follow the AA app for the new plan.`);
    else if (l.route_ok === false) co('rose', 'alert-circle', 'Flight data mismatch.', `The data for ${flightNo(l)} doesn't match this route. Check the AA app.`);
  });
  // Connection: only when it is tight (amber edge) or at risk (rose), and only until you leave.
  // Same model and words as Flights and Today: spare = reaching the gate to its doors closing.
  let c = null;
  if (v && v.role === 'connect') { try { c = N.connection(v.dir); } catch (e) { c = null; } }
  if (c && c.level !== 'ok' && !v.inn.canceled && !v.out.canceled && !overV(v)) {
    const gt = v.out.dep.gate ? `gate ${v.out.dep.gate}` : 'the next gate';
    const doors = N.time(N.addMin(v.out.dep.time, -N.AA.doors), code), reach = N.time(N.addMin(v.inn.arr.time, 10 + c.walk.min), code);
    co(c.level === 'risk' ? 'rose' : 'ap-warn', 'hourglass', `${c.label} connection.`, c.spare > 0
      ? `About ${N.dur(c.spare)} to spare before doors close at ${gt} (${doors}). Go straight there.`
      : c.spare === 0 ? `The usual walk reaches ${gt} just as doors close (${doors}). Go straight there and watch the AA app.`
      : `The usual walk reaches ${gt} ~${reach}, ${N.dur(-c.spare)} after doors close (${doors}). Go straight there and watch the AA app.`);
  }
  // Delays only while they still matter: the next flight until it leaves, the
  // flight in until it lands.
  if (v && v.out && !v.out.canceled && v.out.delay_dep > 14 && !departed(v.out)) co('ap-warn', 'clock', 'Running late.', `${flightNo(v.out)} is delayed ${N.dur(v.out.delay_dep)}; now departs ${tmz(v.out.dep.time, code)}.`);
  const inn = v && v.inn, late = inn ? +(inn.delay_arr != null ? inn.delay_arr : inn.delay_dep) || 0 : 0;
  if (inn && !inn.canceled && late > 14 && okT(inn.arr.time) && nowMs() < T(inn.arr.time)) co('ap-warn', 'clock', 'Running late.', `${flightNo(inn)} now lands ${tmz(inn.arr.time, code)}, ${N.dur(late)} late.`);
  // The guide's summary, minus what the page already says or the data has answered:
  // its connection length (the hero has it), PreCheck and the checkpoint (in the steps,
  // the Security tile and card), a gate guess once the gate is posted. Hidden once the
  // visit is over, on the return, and on a connection that isn't comfortable. Its first
  // sentence is the lead; a summary that is only the terminal (the hero has it) is dropped.
  const gate = gateOf(v);
  let summ = g && !(v && (overV(v) || (v.dir === 'ret' && v.role !== 'depart') || (c && c.level !== 'ok'))) ? fnoText(g.summary) : '';
  const guess = sentences(summ).find(x => /\busually\b/i.test(x)) || '';
  summ = dropS(summ, /precheck|\bcheckpoint\b|\busually\b|\brecent/i)
    .replace(/^\s*(?:about\s+)?\d+\s*(?:min(?:ute)?s?|h(?:ours?)?)\s+connection\s*[,;:.]\s*/i, '').replace(/^[a-z]/, x => x.toUpperCase());
  const ss = sentences(summ).map(x => x.trim());
  if (ss.length && !(ss.length === 1 && /^terminal\s+\w+\.?$/i.test(ss[0]))) co('', 'info-circle', ss[0], ss.slice(1).join(' '));
  if (v && v.role !== 'arrive' && !v.out.canceled && !overV(v) && !gate) co('plain', 'map-pin', 'Gate not posted.', guess ? `${guess.trim()} The actual gate shows here and on the map once AA posts it.`
    : `The ${flightNo(v.out)} gate shows here and on the map once AA posts it.`);
  return out;
}
// Guide caveats, minus the ones the data has already answered.
function caveats(code, v) {
  const g = guide(code);
  const gatesKnown = v && (v.role === 'arrive' ? !!v.inn.arr.gate : !!v.out.dep.gate && (!v.inn || !!v.inn.arr.gate));
  const retKnown = legsOf('ret').length > 0 && legsOf('ret').every(l => okT(l.dep.time));
  return arr(g && g.caveats).map(fnoText).filter(Boolean).filter(c =>
    !(gatesKnown && /gates?\b.*\bnot\b.*\bassigned|not assigned/i.test(c)) && !(retKnown && /return.*not confirmed/i.test(c)));
}

// ---------- your flights here ----------
function flightsHtml(code, v) {
  if (!v) return '';
  const rows = [];
  const row = (l, inbound) => {
    const st = legSt(l);
    const t = inbound ? l.arr.time : l.dep.time;
    const gate = inbound ? l.arr.gate : l.dep.gate, term = inbound ? l.arr.terminal : l.dep.terminal;
    // Past tense only once the flight data confirms it; a passed time alone is "Due" ("Was due"
    // once the leg is over by the clock and the chip says Done).
    const done = inbound ? downOK(l) : leftOK(l);
    const verb = done ? (inbound ? 'Landed' : 'Left') : l.state === 'past' ? 'Was due' : okT(t) && nowMs() >= T(t) ? 'Due' : inbound ? 'Lands' : 'Departs';
    const stT = str(st.text).split(' · ').pop();
    // The chip already says "Not confirmed"; the line does not repeat it.
    const bits = [okT(t) ? `${verb} ${tmz(t, code)}` : stT === 'Not confirmed' ? '' : 'Time not confirmed',
      gate ? `Gate ${gate}` : 'Gate not posted', term ? termLabel(term) : '', inbound && l.arr.baggage ? `Carousel ${l.arr.baggage}` : ''].filter(Boolean);
    const seats = arr(l.seats).filter(Boolean);
    // Rose only for a real problem; a delay or change gets an amber ring. The chip keeps the
    // part that matters ("In the air · 41 min late" → "41 min late"); the row says the rest.
    const chip = st.tone === 'bad' ? 'rose' : st.tone === 'warn' ? 'cr ap-cw' : 'cr';
    return h`<a class="ap-fl" href="#flight/${l.id}">
      <span class="ic">${icon(inbound ? 'plane-arrival' : 'plane-departure')}</span>
      <div class="grow"><b>${flightNo(l)} ${inbound ? `from ${apCity(l.from)}` : `to ${apCity(l.to)}`}</b>
        <small class="tn">${meta(bits)}</small>
        ${seats.length ? h`<small class="tn">Seats ${seats.join(', ')}</small>` : ''}</div>
      <span class="chip ${chip} ap-fc" data-k="ap-st-${l.id}" title="${st.text}"><span>${stT}</span></span></a>`;
  };
  if (v.inn) rows.push(row(v.inn, true));
  if (v.out) rows.push(row(v.out, false));
  return h`<div class="sec"><div class="ey">Your flights here</div><div class="stack8">${rows}</div></div>`;
}

// ---------- steps ----------
// Guide text as sentences, so a sentence the data has already answered can be dropped.
const sentences = s => str(s).match(/[^.!?]+(?:[.!?]+|$)/g) || [];
const dropS = (s, re) => sentences(s).filter(x => !re.test(x)).join('').trim();
// Transit's pick for a direction when Transit shares it (N.bestRoute): {id, name, mins: '45–60 min',
// range: [45, 60], leave}.
// Transit names its directions 'to-hotel' / 'to-lga'; the bare names are tried too.
function transitPick(kind) {
  if (typeof N.bestRoute !== 'function') return null;
  for (const k of [`to-${kind}`, kind]) {
    try { const r = N.bestRoute(k, N.now()); if (r && r.name) return r; } catch (e) { /* not a direction Transit knows */ }
  }
  return null;
}
const minsTxt = m => Array.isArray(m) ? (m[0] === m[1] ? `${m[0]} min` : `${m[0]}–${m[1]} min`)
  : Number.isFinite(+m) && m !== '' && m != null ? `${+m} min` : /^\d+(–\d+)? min$/.test(str(m)) ? str(m) : '';
function stepsHtml(code, v) {
  const g = guide(code);
  const title = !v ? 'Steps' : v.role === 'depart' ? `Leaving from ${code}` : v.role === 'connect' ? `Connecting at ${code}` : `Arriving at ${code}`;
  const head = h`<div class="ey">${title}</div>`;
  if (!v) return h`<section class="sec ap-anc" id="ap-steps">${head}<div class="co plain">${icon('info-circle')}<span><b>Not on your trip.</b> ${code} has no timed steps.</span></div></section>`;
  let steps = arr(obj(g && g.steps) ? g.steps[v.role] : null).filter(obj);
  if (!steps.length) {
    const msg = v.role === 'arrive' ? 'Ground options are below.' : `The guide has no ${v.role === 'connect' ? 'connection' : 'departure'} steps for ${code} yet.`;
    return h`<section class="sec ap-anc" id="ap-steps">${head}<div class="co plain">${icon('info-circle')}<span><b>No steps saved.</b> ${msg}</span></div></section>`;
  }
  // Steps written for the other direction (CLT on the way home): swap in this
  // visit's flight numbers and drop details that quote the other day's times.
  const other = visitsOf(code).find(x => x.role === v.role && x.dir !== v.dir);
  const swap = [];
  if (other && v.dir === 'ret') {
    if (other.inn && v.inn && flightNo(other.inn) !== flightNo(v.inn)) swap.push([flightNo(other.inn), flightNo(v.inn)]);
    if (other.out && v.out && flightNo(other.out) !== flightNo(v.out)) swap.push([flightNo(other.out), flightNo(v.out)]);
  }
  const reused = swap.length > 0;
  const sub = s => swap.reduce((a, [x, y]) => a.split(x).join(y), fnoText(s));
  const hasClock = s => /\b\d{1,2}(:\d{2})?\s?[ap]\b|\b\d{1,2}\/\d{1,2}\b/i.test(str(s));
  const w = N.wallet ? N.wallet() : {};
  const bags = Number.isFinite(+w.bags) ? +w.bags : 0;
  const over = overV(v);
  const gIn = v.inn ? str(v.inn.arr.gate).toUpperCase() : '', gOut = v.out ? str(v.out.dep.gate).toUpperCase() : '';
  const board = v.out && okT(v.out.dep.time) ? T(N.addMin(v.out.dep.time, -N.AA.board)) : NaN;
  // On a connection, once AA posts the next gate: the walk to it (the map's figure, else a concourse guess).
  let wk = null, c = null;
  if (v.role === 'connect') { try { c = N.connection(v.dir); } catch (e) { c = null; } }
  if (v.role === 'connect' && gOut && typeof N.walk === 'function') { try { wk = N.walk(code, gIn || null, gOut); } catch (e) { wk = null; } }
  // A connection runs on the same clock as its rating (N.connection): the door opens ~10 min after
  // landing, then the walk; so the steps, the callout and Flights agree on when you reach the gate.
  const arrT = v.role === 'connect' && v.inn && okT(v.inn.arr.time) ? v.inn.arr.time : null;
  const walkMin = wk ? wk.min : c && c.walk ? c.walk.min : 15;
  const offAt = arrT ? N.addMin(arrT, 10) : null, reachAt = arrT ? N.addMin(arrT, 10 + walkMin) : null;
  const gateStep = s => v.role === 'connect' && (s.icon === 'device-mobile' || /\bfind\b.*\bgate\b/i.test(str(s.title)));
  const walkStep = s => v.role === 'connect' && s.icon === 'route' && /\bwalk\b/i.test(str(s.title));
  const rows = steps.map(s => {
    const rel = obj(s.rel);
    let at = null;
    if (rel && Number.isFinite(+rel.min)) {
      const base = rel.to === 'arr' ? v.inn && v.inn.arr.time : v.out && v.out.dep.time;
      at = okT(base) ? N.addMin(base, +rel.min) : null;
    }
    const meal = s.icon === 'tools-kitchen-2' || s.icon === 'coffee';
    let min = +s.min || 0;
    if (arrT && rel) {
      if (/\bdeplane\b/i.test(str(s.title))) { at = arrT; min = 10; }
      else if (gateStep(s) || walkStep(s)) { at = offAt; if (gOut || walkStep(s)) min = walkMin; }
      else if (meal) at = reachAt;
    }
    // A meal that would start once boarding has is no longer a step.
    if (meal && okT(at) && T(at) >= board) return null;
    // The gate step below names the walk once the gate is known.
    if (walkStep(s) && wk && wk.known) return null;
    const extra = [];
    let t = sub(s.title) || 'Step', detail = reused && hasClock(s.detail) ? '' : sub(s.detail), link = '', hideMin = false;
    if (s.icon === 'car' && v.role === 'depart' && rel) {
      let lv = null; try { lv = N.leave(v.dir); } catch (e) { lv = null; }
      if (lv && okT(lv.at)) {
        at = lv.at;
        if (lv.source === 'traffic') extra.push(`Uses the latest traffic: about ${lv.drive} min drive`);
        if (lv.buffer) extra.push(`Includes your ${lv.buffer} min buffer`);
      }
    }
    if (s.icon === 'plane-arrival' && gIn) {
      t = `${t} at gate ${gIn}`;
      detail = dropS(detail, /scheduled|recent|gate/i);
    }
    if (gateStep(s) && gOut) {
      t = `Gate ${gOut}${gIn ? ` · from ${gIn}` : ''}${wk && wk.known ? ` · ~${wk.min} min` : ''}`;
      detail = '';
      if (wk && wk.known) hideMin = true;
      if (obj(g && g.nav)) link = `#nav/${lc(code)}/@arr/@dep`;
    }
    // When you reach the gate against its doors, rated like the connection (amber tight, rose at risk).
    if (gateStep(s) && gOut && c && reachAt && okT(v.out.dep.time)) {
      const sp = N.mins(reachAt, N.addMin(v.out.dep.time, -N.AA.doors));
      extra.push({t: meta([`At gate ~${N.time(reachAt, code)}`, `${sp >= 0 ? `${N.dur(sp)} before` : `${N.dur(-sp)} after`} doors close`]),
        cls: c.level === 'risk' ? 'ap-xr' : c.level === 'tight' ? 'ap-xw' : ''});
    }
    if (s.icon === 'luggage' && v.role === 'depart' && v.out && okT(v.out.dep.time)) {
      extra.push(meta([`Bag drop closes ${tmz(N.addMin(v.out.dep.time, -N.AA.bagdrop), code)}`, bags > 0 && `${N.plural(bags, 'checked bag')} in Wallet`]));
    }
    if (s.icon === 'luggage' && v.role === 'arrive' && v.inn.arr.baggage) {
      extra.push(`Carousel ${v.inn.arr.baggage}`);
      detail = dropS(detail, /\bshows the carousel\b/i);
    }
    // Into the city: Transit's best way right now, so both screens give the same minutes.
    if (s.icon === 'building-skyscraper' && v.role === 'arrive' && v.dir === 'out') {
      const r = transitPick('hotel');
      const m = r ? minsTxt(r.range || r.mins) : '';
      if (m) detail = `About ${m} by ${r.name} right now.`;
    }
    if (s.icon === 'plane-departure' && gOut) extra.push(`Gate ${gOut}`);
    return {s, at, title: t, detail, extra, min, hideMin, link};
  }).filter(Boolean);
  // In time order: a late arrival can put "Boarding" before "Land". A step with
  // no time keeps its place after the step before it.
  let last = -Infinity;
  rows.forEach((r, i) => { r.k = okT(r.at) ? (last = T(r.at)) : last; r.i = i; });
  rows.sort((a, b) => a.k - b.k || a.i - b.i);
  const now = nowMs();
  // A step that has started stays "Now" for as long as it takes ("Security
  // 3:30a, about 20 min" is still Now at 3:40a), or a minute if it has no
  // length, so the step in progress never shows as done.
  const endOf = r => T(r.at) + Math.max(r.min * 60000, 60000);
  let lastStarted = -1;
  rows.forEach((r, i) => { if (okT(r.at) && T(r.at) <= now) lastStarted = i; });
  const active = !over && lastStarted >= 0 && endOf(rows[lastStarted]) > now ? lastStarted : -1;
  const upI = over ? -1 : rows.findIndex((r, i) => i > lastStarted && okT(r.at) && T(r.at) > now);
  const nextI = active >= 0 ? active : upI;
  // When the next/now marker next needs to move (read by tick).
  const chg = nextI < 0 ? NaN
    : active >= 0 ? Math.min(endOf(rows[active]), upI >= 0 ? T(rows[upI].at) : Infinity)
    : T(rows[upI].at) - now > 60000 ? T(rows[upI].at) - 60000 : T(rows[upI].at);
  const html = rows.map((r, i) => {
    const next = i === nextI;
    const done = okT(r.at) && !next && (over || T(r.at) <= now);
    const warn = r.s.icon === 'alert-triangle';
    // A finished step is one quiet line: time, tick and title.
    if (done) return h`<li class="ap-st done">
      <div class="ap-tm tn">${N.time(r.at, code)}</div>
      <div class="ap-sd"><span class="ap-si">${icon('check')}</span></div>
      <div class="ap-sb"><b>${r.title}</b></div>
    </li>`;
    return h`<li class="${N.cls('ap-st', next && 'next', warn && 'wn')}"${next && Number.isFinite(chg) ? raw(` data-chg="${Math.round(chg)}"`) : ''}>
      <div class="ap-tm tn">${okT(r.at) ? N.time(r.at, code) : r.s.rel ? '—' : ''}</div>
      <div class="ap-sd"><span class="ap-si">${ic(r.s.icon, 'point')}</span></div>
      <div class="ap-sb"><b>${r.title}</b>
        ${next ? i === active || T(r.at) - now <= 60000 ? h`<span class="ap-in">Now</span>` : h`<span class="ap-in">in <span data-until="${r.at}">${N.until(r.at)}</span></span>` : ''}
        ${r.detail ? h`<small>${r.detail}</small>` : ''}
        ${r.extra.map(x => h`<small class="${N.cls('ap-x', x.cls)}">${x.t || x}</small>`)}
        ${r.min && !r.hideMin ? h`<small class="ap-mn">${icon('clock')}About ${N.dur(r.min)}</small>` : ''}
        ${r.link ? h`<a class="ap-tb ap-wk ap-sl" href="${r.link}">${ic('walk', 'route')}<span>Walk me there</span></a>` : ''}</div>
    </li>`;
  });
  const notes = [];
  if (reused) notes.push(h`<p class="ap-note">These steps were written for the outbound connection. Times use your ${v.dir === 'ret' ? 'return' : ''} flights.</p>`);
  if (!okT(v.at)) notes.push(h`<p class="ap-note">Times show once ${flightNo(v.leg)} is confirmed.</p>`);
  return h`<section class="sec ap-anc" id="ap-steps">${head}${notes}<ol class="ap-steps">${html}</ol></section>`;
}

// ---------- terminal map ----------
const normG = g => str(g).toUpperCase().replace(/\bGATE\b/g, '').replace(/\s+/g, '').replace(/^([A-Z]*)0+(\d)/, '$1$2');
const num = v => { const n = +v; return Number.isFinite(n) ? n : NaN; };
const ENT = {amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' '};
const unent = s => str(s).replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (m0, d, x, n) => {
  const c = d ? +d : x ? parseInt(x, 16) : NaN;
  if (Number.isFinite(c)) return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : '';
  return ENT[lc(n)] != null ? ENT[lc(n)] : m0;
});
const attr = (a, k) => { const m = str(a).match(new RegExp(`(?:^|\\s)${k}="([^"]*)"`)); return m ? m[1] : ''; };
// The guide's SVG carries its own text, legend, "you" dot and gate circles. Text is
// lifted out and drawn as HTML pins (sharp, ≥12px at every zoom), the legend is
// dropped (the page has its own key), and gate circles become findable gates.
const preps = {};
function prepSvg(code, svg) {
  const c = preps[code];
  if (c && c.src === svg) return c;
  const texts = [];
  for (const m of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const a = m[1], t = unent(m[2].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    const x = num(attr(a, 'x')), y = num(attr(a, 'y'));
    if (!t || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const an = attr(a, 'text-anchor');
    texts.push({cls: attr(a, 'class'), x, y, fs: num(attr(a, 'font-size')) || 10, fw: num(attr(a, 'font-weight')) || 400,
      al: an === 'middle' ? 'm' : an === 'end' ? 'e' : 's', t});
  }
  const LEG = /^(gates?|food|security|you|your gate|route|walk(ing route)?)$/i;
  const leg = texts.filter(t => LEG.test(t.t));
  let box = null;
  if (leg.length >= 3) {
    const xs = leg.map(t => t.x), ys = leg.map(t => t.y);
    if (Math.max(...xs) - Math.min(...xs) < 12 && Math.max(...ys) - Math.min(...ys) < 120) box = [Math.min(...xs) - 18, Math.min(...ys) - 12, Math.max(...xs) + 2, Math.max(...ys) + 4];
  }
  const inBox = (x0, y0, x1, y1) => box && x0 >= box[0] && y0 >= box[1] && x1 <= box[2] && y1 <= box[3];
  let out = svg.replace(/<text\b[^>]*>[\s\S]*?<\/text>/g, '');
  out = out.replace(/<(circle|rect|line)\b([^>]*?)(?:\/>|>\s*<\/\1>)/g, (m0, tag, a) => {
    if (/(?:^|\s)id="you"/.test(a)) return '';
    if (!box || attr(a, 'data-g')) return m0;
    const n = k => num(attr(a, k));
    if (tag === 'circle') { const r = n('r') || 0; return r <= 5 && inBox(n('cx') - r, n('cy') - r, n('cx') + r, n('cy') + r) ? '' : m0; }
    if (tag === 'rect') return n('width') <= 12 && n('height') <= 12 && inBox(n('x'), n('y'), n('x') + n('width'), n('y') + n('height')) ? '' : m0;
    return inBox(Math.min(n('x1'), n('x2')), Math.min(n('y1'), n('y2')), Math.max(n('x1'), n('x2')), Math.max(n('y1'), n('y2'))) ? '' : m0;
  });
  // Open wall paths are corridor centre lines (older maps); closed ones are floor.
  out = out.replace(/<path\b([^>]*\bclass="[^"]*\bm-wall\b[^"]*")([^>]*)>/g, (m0, a, b) => /\sd="[^"]*[Zz]/.test(m0) || !/\sd="/.test(m0) ? m0 : `<path${a.replace(/m-wall/, 'm-wall ap-open')}${b}>`);
  const keep = texts.filter(t => !(box && LEG.test(t.t)) && !/^↑/.test(t.t));
  const gtexts = keep.filter(t => /\bm-gate\b/.test(t.cls));
  const gates = [];
  for (const m of svg.matchAll(/<circle\b([^>]*)>/g)) {
    const g = attr(m[1], 'data-g');
    const x = num(attr(m[1], 'cx')), y = num(attr(m[1], 'cy'));
    if (!g || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const id = normG(g), n = (id.match(/\d+[A-Z]?$/) || [''])[0];
    // The gate's own number label, drawn beside the concourse: the bubble goes there.
    let lab = null, bd = 18;
    for (const t of gtexts) { const tn = normG(t.t); if (tn !== id && tn !== n) continue; const d = Math.hypot(t.x - x, t.y - t.fs * 0.35 - y); if (d < bd) { bd = d; lab = t; } }
    gates.push({g: id, x, y, lx: lab ? lab.x : x, ly: lab ? lab.y - lab.fs * 0.35 : y, al: lab ? lab.al : 'm'});
  }
  const lbls = keep.filter(t => !/\bm-gate\b/.test(t.cls)).map(t => ({t: t.t, x: t.x, y: t.y - t.fs * 0.35, al: t.al, big: t.fs >= 10, bold: t.fw >= 600, w: t.t.length * t.fs * 0.55}));
  return (preps[code] = {src: svg, svg: out, gates, lbls});
}
// Short names for pins; the full guide text shows when you tap.
const LOC = /^(?:level|l\d|terminal|doors?|food (?:hall|court)|upper|lower|airside|landside|before|after|past|near|by|inside|outside|outer|inner|carousels?|concourse|garage|curb|just|west|east|north|south|cent(?:re|er))\b/i;
function shortLabel(s) {
  const full = str(s).trim();
  const parts = full.split(': ')[0].split(' (')[0].split(', ');
  let out = parts[0];
  for (let i = 1; i < parts.length && !LOC.test(parts[i]); i++) out += ', ' + parts[i];
  out = out.replace(/^American customer service desk/i, 'AA service desk').replace(/^American check-in/i, 'AA check-in').trim();
  out = out.replace(/^(.{4,}?)\s+(near|between|by|beside|next to|across from|opposite)\s+[A-Z0-9].*$/, '$1');
  if (out.length > 30 && /shuttle/i.test(out)) out = 'Shuttles';
  return out || full;
}
function kindOf(id, p) {
  const k = lc(p.kind) || 'poi', L = lc(p.label);
  if (id === 'hub' || k === 'hub') return 'hub';
  if (k === 'bag' || k === 'claim') return 'baggage';
  if (k === 'ride' || k === 'rideshare' || k === 'uber') return 'rideshare';
  if (k === 'info' || k === 'poi') {
    if (/admirals club|lounge|provisions|\bclub\b/.test(L)) return 'lounge';
    if (/check-in|ticketing/.test(L)) return 'checkin';
  }
  return k;
}
function mapPoints(map) {
  const P = obj(map.points) || {};
  return Object.keys(P).map(id => {
    const p = obj(P[id]);
    if (!p || lc(p.kind) === 'line' || !Number.isFinite(num(p.x)) || !Number.isFinite(num(p.y))) return null;
    const full = str(p.label) || id, kind = kindOf(id, p);
    return {id, x: num(p.x), y: num(p.y), full, label: kind === 'gate' ? full : shortLabel(full), kind};
  }).filter(Boolean);
}
// Concourse lines: gates spread evenly from x1,y1 (first gate) to x2,y2 (last); `via` is the
// walk from the airside hub to the line.
function mapLines(map) {
  const P = obj(map.points) || {};
  const pt = q => Array.isArray(q) && Number.isFinite(num(q[0])) && Number.isFinite(num(q[1])) ? [num(q[0]), num(q[1])] : null;
  return Object.keys(P).map(id => {
    const p = obj(P[id]);
    if (!p || lc(p.kind) !== 'line') return null;
    const l = {id, x1: num(p.x1), y1: num(p.y1), x2: num(p.x2), y2: num(p.y2), from: num(p.from), to: num(p.to),
      prefix: normG(p.prefix), for: lc(p.for) || 'gate', via: arr(p.via).map(pt).filter(Boolean), label: str(p.label)};
    return [l.x1, l.y1, l.x2, l.y2].every(Number.isFinite) ? l : null;
  }).filter(Boolean);
}
const onLine = (l, n) => Number.isFinite(l.from) && Number.isFinite(l.to) && n >= Math.min(l.from, l.to) && n <= Math.max(l.from, l.to);
const lineAt = (l, n) => { const t = l.to === l.from ? 0.5 : (n - l.from) / (l.to - l.from); return [l.x1 + (l.x2 - l.x1) * t, l.y1 + (l.y2 - l.y1) * t]; };
function proj(l, p) {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1, L = dx * dx + dy * dy || 1;
  const t = N.clamp(((p.x - l.x1) * dx + (p.y - l.y1) * dy) / L, 0, 1);
  return [l.x1 + dx * t, l.y1 + dy * t];
}
function lineFor(lines, want, p) {
  const m = want.match(/^([A-Z]*)(\d+)/);
  const gl = lines.filter(l => l.for === 'gate');
  const hit = m && gl.find(l => l.prefix === m[1] && onLine(l, +m[2]));
  if (hit) return hit;
  let best = null, bd = 24;
  for (const l of gl) { const q = proj(l, p), d = Math.hypot(q[0] - p.x, q[1] - p.y); if (d < bd) { bd = d; best = l; } }
  return best;
}
function findGate(pts, lines, gate) {
  if (!gate) return null;
  const w0 = normG(gate);
  if (!w0) return null;
  // "B22" at an airport whose gates are plain numbers is gate 22.
  const wants = [...new Set([w0, w0.replace(/^[A-Z]+(?=\d)/, '')])];
  const gates = pts.filter(p => p.kind === 'gate');
  for (const want of wants) {
    const hit = gates.find(p => normG(str(p.id).replace(/^gate-/i, '')) === want || normG(p.label) === want) || pts.find(p => normG(p.id) === want);
    if (hit) return Object.assign({}, hit, {exact: true, line: lineFor(lines, want, hit)});
  }
  // Not drawn: place it on its concourse line by number.
  for (const want of wants) {
    const m = want.match(/^([A-Z]*)(\d+)/);
    const l = m && lines.find(q => q.for === 'gate' && q.prefix === m[1] && onLine(q, +m[2]));
    if (l) { const [x, y] = lineAt(l, +m[2]); return {id: 'gate-' + want, label: want, full: want, kind: 'gate', x, y, exact: true, est: true, line: l}; }
  }
  const m = w0.match(/^([A-Z]*)(\d+)/);
  if (!m) return null;
  let best = null, bd = 1e9;
  for (const p of gates) {
    const q = normG(p.label || p.id).match(/^([A-Z]*)(\d+)/);
    if (!q || q[1] !== m[1]) continue;
    const d = Math.abs(+q[2] - +m[2]);
    if (d < bd) { bd = d; best = p; }
  }
  return best && bd <= 6 ? Object.assign({}, best, {exact: false, line: lineFor(lines, normG(best.label), best)}) : null;
}
// Polyline helpers. Points are [x, y].
const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.6;
const pathTo = (l, p) => [...l.via, proj(l, p), [p.x, p.y]];   // from the hub to p
function tidy(r) {
  if (!r) return null;
  let a = r.filter(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  for (let again = true; again;) {
    again = false;
    a = a.filter((p, i) => i === 0 || !same(p, a[i - 1]));
    for (let i = 1; i + 1 < a.length; i++) {
      const [p, q, s] = [a[i - 1], a[i], a[i + 1]];
      const ux = q[0] - p[0], uy = q[1] - p[1], vx = s[0] - q[0], vy = s[1] - q[1];
      // A middle point on a straight run, or the tip of a there-and-back, adds nothing.
      if (Math.abs(ux * vy - uy * vx) <= 0.01 * Math.hypot(ux, uy) * Math.hypot(vx, vy)) { a.splice(i, 1); again = true; break; }
    }
  }
  return a.length > 1 ? a : null;
}
function between(a, b) {
  const la = a.line, lb = b.line;
  if (!la || !lb) return null;
  if (la === lb) return [[a.x, a.y], proj(la, a), proj(la, b), [b.x, b.y]];
  const A = [...la.via, proj(la, a)], B = [...lb.via, proj(lb, b)];
  let c = 0;
  while (c < A.length && c < B.length && same(A[c], B[c])) c++;
  return [[a.x, a.y], ...A.slice(Math.max(0, c - 1)).reverse(), ...B.slice(c), [b.x, b.y]];
}
const segDist = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1;
  const t = N.clamp(((p.x - a[0]) * dx + (p.y - a[1]) * dy) / L, 0, 1);
  return Math.hypot(a[0] + dx * t - p.x, a[1] + dy * t - p.y);
};
const nearPath = (p, r) => r && r.length > 1 ? Math.min(...r.slice(1).map((q, i) => segDist(p, r[i], q))) : Infinity;
// A route the map's author drew (an M/L path with an id), as points.
function bakedRoute(svg, id) {
  const m = str(svg).match(new RegExp(`<path\\b[^>]*\\bid="${id}"[^>]*>`));
  const d = m && attr(m[0], 'd');
  if (!d || /[^MLml\d\s,.\-e]/.test(d)) return null;
  const out = [];
  let cur = [0, 0];
  for (const c of d.match(/[MLml][^MLml]*/g) || []) {
    const n = (c.slice(1).match(/-?\d*\.?\d+(?:e-?\d+)?/gi) || []).map(Number);
    for (let i = 0; i + 1 < n.length; i += 2) { cur = c[0] === c[0].toLowerCase() ? [cur[0] + n[i], cur[1] + n[i + 1]] : [n[i], n[i + 1]]; out.push(cur); }
  }
  return out.length > 1 ? out : null;
}
// Corridor graph from open .m-wall centre lines (older maps without concourse lines).
const graphs = {};
function wallGraph(code, svg) {
  if (graphs[code] && graphs[code].svg === svg) return graphs[code].g;
  const nodes = new Map();
  const node = (x, y) => { const k = `${Math.round(x * 10)},${Math.round(y * 10)}`; let n = nodes.get(k); if (!n) { n = {x, y, adj: []}; nodes.set(k, n); } return n; };
  const ds = new Set();
  for (const m of str(svg).matchAll(/<path\b[^>]*\bclass="[^"]*\bm-wall\b[^"]*"[^>]*>/g)) { const d = attr(m[0], 'd'); if (d && !/[Zz]/.test(d)) ds.add(d); }
  for (const d of ds) {
    let prev = null;
    for (const c of d.match(/[MLml][^MLml]*/g) || []) {
      const nums = (c.slice(1).match(/-?\d*\.?\d+(?:e-?\d+)?/gi) || []).map(Number);
      for (let i = 0; i + 1 < nums.length; i += 2) {
        const n = node(nums[i], nums[i + 1]);
        if (!(c[0] === 'M' && i === 0) && prev && prev !== n) {
          const w = Math.hypot(prev.x - n.x, prev.y - n.y);
          prev.adj.push([n, w]); n.adj.push([prev, w]);
        }
        prev = n;
      }
    }
  }
  const g = [...nodes.values()];
  graphs[code] = {svg, g};
  return g;
}
function routeThrough(g, a, b) {
  if (!a || !b) return null;
  const straight = [[a.x, a.y], [b.x, b.y]];
  if (!g.length) return straight;
  const near = p => { let best = null, bd = Infinity; for (const n of g) { const d = Math.hypot(n.x - p.x, n.y - p.y); if (d < bd) { bd = d; best = n; } } return best; };
  const s = near(a), t = near(b);
  if (!s || !t) return straight;
  const dist = new Map([[s, 0]]), prev = new Map(), done = new Set();
  for (;;) {
    let u = null, du = Infinity;
    for (const [n, d] of dist) if (!done.has(n) && d < du) { du = d; u = n; }
    if (!u || u === t) break;
    done.add(u);
    for (const [n, w] of u.adj) { const nd = du + w; if (nd < (dist.has(n) ? dist.get(n) : Infinity)) { dist.set(n, nd); prev.set(n, u); } }
  }
  if (!dist.has(t)) return straight;
  const path = [t]; let c = t;
  while (prev.has(c)) { c = prev.get(c); path.unshift(c); }
  const out = [[a.x, a.y]];
  for (const n of path) { const l = out[out.length - 1]; if (Math.hypot(l[0] - n.x, l[1] - n.y) > 0.5) out.push([n.x, n.y]); }
  const l = out[out.length - 1];
  if (Math.hypot(l[0] - b.x, l[1] - b.y) > 0.5) out.push([b.x, b.y]);
  return out.length > 1 ? out : straight;
}
const KIND_IC = {security: 'shield-check', baggage: 'luggage', taxi: 'car', rideshare: 'car-suv', bus: 'bus', train: 'train', lounge: 'armchair-2',
  food: 'tools-kitchen-2', restroom: 'toilet-paper', parking: 'parking', info: 'info-circle', elevator: 'elevator', stairs: 'stairs', checkin: 'ticket', exit: 'door-exit'};
// Which guide checkpoint the map should use: the first one in the guide that is open
// when you go through and that the map shows.
function pickSecurity(code, v, secs) {
  if (!secs.length) return null;
  const at = secTime(code, v), m = at ? localMin(at, code) : null;
  for (const s of arr(guide(code) && guide(code).security).filter(obj)) {
    const name = lc(s.name).replace(/\s*\(.*?\)\s*/g, ' ').trim();
    if (!name) continue;
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const p = secs.find(q => re.test(lc(q.label)) || re.test(lc(q.full)));
    if (p && openAt(hoursRange(s.hours), m) !== false) return p;
  }
  return secs.length === 1 ? secs[0] : null;
}
// Map notes for this visit: no notes about how the map was drawn, and none for
// the other direction ("Coming home: …" on a departure).
function mapNotes(list, v) {
  const role = v ? v.role : '';
  const away = role === 'depart' ? /^(Coming home|Arriving)\b/i : role === 'arrive' ? /^(Leaving|Departing)\b/i
    : role === 'connect' ? /^(Coming home|Arriving|Leaving|Departing)\b/i : null;
  return arr(list).map(str).filter(n => n && !(away && away.test(n)))
    .map(n => n.replace(/\.\s+(?=[A-Z])/g, '.\n').split('\n').filter(s => !/official data|drawn at|third-party/i.test(s)).join(' '))
    .filter(Boolean);
}
// Everything the map needs for one airport and visit; kept for mount().
const models = {};
function mapModel(code, v) {
  const g = guide(code), map = obj(g && g.map);
  if (!map || !str(map.svg)) return null;
  const vb = (Array.isArray(map.viewBox) ? map.viewBox : str(map.viewBox).trim().split(/[\s,]+/)).map(Number);
  if (vb.length !== 4 || vb.some(x => !Number.isFinite(x)) || vb[2] <= 0 || vb[3] <= 0) return null;
  const prep = prepSvg(code, str(map.svg));
  const lines = mapLines(map);
  const pts = mapPoints(map);
  prep.gates.forEach(q => { if (!pts.some(p => p.kind === 'gate' && normG(p.label) === q.g)) pts.push({id: 'gate-' + q.g, x: q.x, y: q.y, label: q.g, full: q.g, kind: 'gate'}); });
  const graph = lines.length ? [] : wallGraph(code, map.svg);
  const hub = pts.find(p => p.kind === 'hub');
  const you = [], used = new Set();
  let route = null, gateLabel = '', gateMissing = false, baked = null;
  const pin = (p, label, tone) => { if (p) { you.push({x: p.x, y: p.y, label, tone, id: p.id}); used.add(p.id); } };
  const gname = (p, raw2) => p.exact ? str(raw2).toUpperCase() : `Near ${str(raw2).toUpperCase()}`;
  const fromHub = p => p.line ? pathTo(p.line, p) : hub ? routeThrough(graph, hub, p) : null;
  if (v && v.role === 'depart') {
    const gp = findGate(pts, lines, v.out.dep.gate);
    const secs = pts.filter(p => p.kind === 'security');
    const pre = bakedRoute(map.svg, 'route-depart');
    const sec = pickSecurity(code, v, secs) || (gp ? secs.slice().sort((a, b) => Math.hypot(a.x - gp.x, a.y - gp.y) - Math.hypot(b.x - gp.x, b.y - gp.y))[0] : null);
    if (sec) pin(sec, /secur|checkpoint|tsa/i.test(str(sec.label)) ? str(sec.label) : `${sec.label} · Security`, 'via');
    if (gp) {
      pin(gp, `${gname(gp, v.out.dep.gate)} · Your gate`, 'you');
      gateLabel = `Gate ${str(v.out.dep.gate).toUpperCase()}`;
      const tail = gp.line ? pathTo(gp.line, gp) : null;
      if (tail && pre && sec && nearPath(sec, pre) < 8 && same(pre[pre.length - 1], tail[0])) route = tidy([...pre, ...tail]);
      else if (tail && sec) route = tidy([[sec.x, sec.y], [sec.x, tail[0][1]], ...tail]);
      else route = tidy(tail || (sec ? routeThrough(graph, sec, gp) : null));
    } else {
      gateMissing = !v.out.dep.gate;
      if (pre && (!sec || nearPath(sec, pre) < 8)) baked = pre;
    }
  } else if (v && v.role === 'connect') {
    const a = findGate(pts, lines, v.inn.arr.gate), b = findGate(pts, lines, v.out.dep.gate);
    if (a) pin(a, `${gname(a, v.inn.arr.gate)} · You land`, 'via');
    if (b) pin(b, `${gname(b, v.out.dep.gate)} · Next flight`, 'you');
    if (a && b) route = tidy(between(a, b) || routeThrough(graph, a, b));
    else if (b) route = tidy(fromHub(b));
    else if (a) { const r = fromHub(a); route = tidy(r && r.slice().reverse()); }
    gateLabel = b ? `Gate ${str(v.out.dep.gate).toUpperCase()}` : a ? `Gate ${str(v.inn.arr.gate).toUpperCase()}` : '';
    gateMissing = !b && !v.out.dep.gate;
  } else if (v && v.role === 'arrive') {
    const a = findGate(pts, lines, v.inn.arr.gate);
    const bag = str(v.inn.arr.baggage).trim();
    const claimL = lines.find(l => l.for === 'baggage');
    const bagPt = pts.find(p => p.kind === 'baggage');
    let c = null;
    if (bag && claimL && /^\d+$/.test(bag) && onLine(claimL, +bag)) { const [x, y] = lineAt(claimL, +bag); c = {id: 'claim-' + bag, x, y, label: `Carousel ${bag}`}; }
    else if (bag) c = pts.find(p => p.kind === 'baggage' && (normG(p.label).replace(/^(CLAIM|CAROUSEL)/, '') === normG(bag) || lc(p.id) === `claim-${lc(bag)}`)) || null;
    const to = c || bagPt;
    if (a) {
      pin(a, `${gname(a, v.inn.arr.gate)} · You land`, 'you');
      gateLabel = `Gate ${str(v.inn.arr.gate).toUpperCase()}`;
      const r = a.line ? pathTo(a.line, a).reverse() : null;
      if (r && to) route = tidy(claimL ? [...r, ...claimL.via, proj(claimL, to), [to.x, to.y]] : [...r, [to.x, to.y]]);
      else if (r) route = tidy(r);
      else if (to) route = tidy(routeThrough(graph, a, to));
    } else {
      gateMissing = !v.inn.arr.gate;
      baked = bakedRoute(map.svg, 'route-arrive');
    }
    if (c) pin(c, `${c.label} · Your bags`, 'via');
  }
  // Other places worth a bubble, most useful first. The hub is a routing point, not a place.
  const PRI = {security: 2, baggage: 2, taxi: 2, rideshare: 2, bus: 2, train: 2, exit: 2, checkin: 2, lounge: 3, info: 3, restroom: 4, food: 4};
  const poi = pts.filter(p => p.kind !== 'gate' && p.kind !== 'hub' && !used.has(p.id) && KIND_IC[p.kind]).map(p => ({x: p.x, y: p.y, label: p.label, kind: p.kind,
    pri: PRI[p.kind] || 3, minS: (PRI[p.kind] || 3) >= 4 ? 1.7 : 1, labelS: (PRI[p.kind] || 3) >= 4 ? 3 : 2.2}))
    .sort((a, b) => a.pri - b.pri);
  // Map words (concourse names, levels, carousel numbers). Skip ones a place bubble already names.
  const lbls = prep.lbls.filter(t => {
    if (/^\d+$/.test(t.t)) return true;
    const cx = t.al === 's' ? t.x + t.w / 2 : t.al === 'e' ? t.x - t.w / 2 : t.x;
    return !pts.some(p => p.kind !== 'gate' && p.kind !== 'hub' && KIND_IC[p.kind] && Math.hypot(p.x - cx, p.y - t.y) < 14);
  }).map(t => ({x: t.x, y: t.y, label: t.t, al: t.al, pri: t.big ? 1 : t.bold ? 2.5 : 3, minS: t.big || t.bold ? 1 : 1.4, cls: t.big ? 'big' : t.bold ? 'bd' : ''}));
  const youIds = new Set(you.map(p => normG(str(p.id).replace(/^gate-/i, ''))));
  const gates = prep.gates.length
    ? prep.gates.filter(q => !youIds.has(q.g)).map(q => ({x: q.lx, y: q.ly, label: q.g, al: q.al}))
    : pts.filter(p => p.kind === 'gate' && !used.has(p.id)).map(p => ({x: p.x, y: p.y, label: p.label, al: 'm'}));
  let focus = null;
  const fp = [...(route || baked || []), ...you.map(p => [p.x, p.y])];
  if (fp.length) {
    const xs = fp.map(p => p[0]), ys = fp.map(p => p[1]);
    focus = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  const m = {code, vb, svg: prep.svg, you, poi, lbls, gates, route, baked: !!baked, focus, gateLabel, gateMissing, pts, lines,
    role: v ? v.role : '', notes: mapNotes(map.notes, v), source: map.source};
  models[code] = m;
  return m;
}
const CAP1 = 'Pinch or double-tap to zoom', CAP2 = 'Drag to move · Done to scroll the page';
function mapHtml(code, v, gq) {
  const g = guide(code);
  const offMap = arr(g && g.links).filter(obj).find(l => /map/i.test(str(l.label)) && /^https?:/i.test(str(l.url)));
  const offLink = offMap ? ext(offMap.url, h`${icon('map')}<span>${str(offMap.label) || 'Official map'}</span>${icon('arrow-up-right')}`, 'chip cr ap-c44') : '';
  const m = mapModel(code, v);
  if (!m) {
    models[code] = null;
    return h`<section class="sec ap-anc" id="ap-map"><div class="ey">Terminal map</div>
      <div class="ap-nomap">${icon('map-2')}<div><b>No terminal map saved for ${code} yet</b><small>The airport’s own map works when you have signal.</small></div></div>
      ${offLink ? h`<div class="wrap ap-ml">${offLink}</div>` : ''}</section>`;
  }
  const [x, y, w, hh] = m.vb;
  const d = m.route ? 'M' + m.route.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('L') : '';
  const src = typeof m.source === 'string' ? m.source : obj(m.source) ? str(m.source.name || m.source.text) : '';
  const both = v && v.role === 'connect' && m.you.length > 1;
  const sub = both ? h`Gates ${str(v.inn.arr.gate).toUpperCase()} ${icon('arrow-right')}<span class="sr">to</span> ${str(v.out.dep.gate).toUpperCase()} marked`
    : m.gateLabel ? `${m.gateLabel} marked` : m.gateMissing ? 'Gate not posted yet' : '';
  const kinds = new Set(m.poi.map(p => p.kind));
  const key = [
    m.you.some(p => p.tone === 'you') ? h`<span><i class="ap-k you"></i>${v && v.role === 'arrive' ? 'Arrival gate' : 'Your gate'}</span>` : '',
    m.route ? h`<span><i class="ap-k rt"></i>Your walk</span>` : '',
    m.baked || (m.role === 'arrive' && /id="route-(taxi|bus|ride)"/.test(m.svg)) ? h`<span><i class="ap-k wk"></i>${m.role === 'arrive' ? 'Ways out' : 'Curb to security'}</span>` : '',
    h`<span><i class="ap-k gt"></i>Gates</span>`,
    kinds.has('security') || m.you.some(p => /Security/.test(p.label)) ? h`<span><i class="ap-k sc"></i>Security</span>` : '',
    kinds.has('food') ? h`<span><i class="ap-k fd"></i>Food</span>` : '',
  ];
  // "Walk me to my gate" opens the walking directions (#nav) at the gate asked for, else your next gate.
  const mine = v && v.out ? str(v.out.dep.gate) : '';
  const wg = gq || (v && v.role !== 'arrive' ? mine : '');
  const walk = wg && obj(g && g.nav) ? h`<a class="ap-tb ap-wk" href="#nav/${lc(code)}/${v && v.role === 'connect' ? '@arr' : '@here'}/${encodeURIComponent(wg)}">${ic('walk', 'route')}<span>${normG(wg) === normG(mine) ? 'Walk me to my gate' : `Walk to gate ${wg.toUpperCase()}`}</span></a>` : '';
  return h`<section class="sec ap-anc" id="ap-map">
    <div class="ap-sh"><div class="ey">Terminal map</div>${sub ? h`<span class="ap-shs">${sub}</span>` : ''}</div>
    <div class="ap-mw">
      <div class="ap-mv${m.route ? ' has-rt' : ''}" data-role="${m.role || 'none'}" tabindex="0" role="img" aria-label="${`Terminal map of ${code}${m.gateLabel ? `, ${m.gateLabel} marked` : ''}. Pinch, double-tap or use the zoom buttons.`}" style="aspect-ratio:${w} / ${hh}">
        <svg class="ap-svg" viewBox="${`${x} ${y} ${w} ${hh}`}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${raw(m.svg)}${d ? raw(`<g class="ap-ov"><path class="ap-rc" d="${d}"/><path class="ap-rt" d="${d}"/></g>`) : ''}</svg>
        <div class="ap-pins" aria-hidden="true"></div>
      </div>
      <button type="button" class="ap-done" data-act="mapReset" hidden>Done</button>
      <div class="ap-zc" role="group" aria-label="Zoom">
        <button type="button" class="ap-z" data-act="mapZoom" data-arg="-1" aria-label="Zoom out">${icon('minus')}</button>
        <button type="button" class="ap-z" data-act="mapZoom" data-arg="1" aria-label="Zoom in">${icon('plus')}</button>
      </div>
    </div>
    ${m.gateLabel || walk ? h`<div class="ap-tools">
      ${m.gateLabel ? h`<button type="button" class="ap-tb ap-gt" data-act="mapGate">${icon('focus-2')}<span>${m.gateLabel}</span></button>` : ''}${walk}
    </div>` : ''}
    <p class="ap-cap" aria-live="polite">${CAP1}</p>
    <div class="ap-key" aria-hidden="true">${key}</div>
    ${m.notes.length ? more(`Terminal notes (${m.notes.length})`, h`<ul class="ap-notes">${m.notes.map(n => h`<li>${n}</li>`)}</ul>`) : ''}
    <p class="ap-src">${icon('info-circle')}<span>${src ? `Source: ${src}. ` : ''}Schematic, not to scale. Positions are approximate; follow the airport signs.</span></p>
    ${offLink ? h`<div class="wrap ap-ml">${offLink}</div>` : ''}
  </section>`;
}

// Live map controller for the mounted screen (zoom buttons call into it).
// views keeps your zoom through a refresh of this page; leaving the page drops it,
// so every visit opens at 1x where a vertical swipe scrolls the page.
const views = {};   // code → {s, cx, cy}
let ctl = null;
const MAXS = 6;
function mountMap(root, m, gq) {
  const mv = root.querySelector('.ap-mv');
  if (!mv || !m) return null;
  const svg = mv.querySelector('svg.ap-svg'), layer = mv.querySelector('.ap-pins'), cap = root.querySelector('.ap-cap');
  const wrap = mv.parentNode, done = root.querySelector('.ap-done'), zc = root.querySelector('.ap-zc');
  const btnIn = root.querySelector('[data-act="mapZoom"][data-arg="1"]'), btnOut = root.querySelector('[data-act="mapZoom"][data-arg="-1"]');
  const [VX, VY, VW, VH] = m.vb;
  let W = mv.clientWidth || 1, H = mv.clientHeight || 1;
  const fresh = !views[m.code];
  const st = views[m.code] || (views[m.code] = {s: 1, cx: VX + VW / 2, cy: VY + VH / 2});
  // A gate asked for in the link (#airport/phx?gate=A22): centre it, and give it a
  // pulsing pin if it isn't already one of yours.
  const gp = gq ? findGate(m.pts, m.lines, gq) : null;
  const gYou = gp && m.you.find(p => Math.hypot(p.x - gp.x, p.y - gp.y) < 1);
  const extra = gp && !gYou ? [{x: gp.x, y: gp.y, label: `Gate ${str(gq).toUpperCase()}`, tone: 'you', q: 1}] : [];
  const k0 = () => Math.min(W / VW, H / VH);
  const clampSt = (s, cx, cy) => {
    s = N.clamp(s, 1, MAXS);
    const k = k0() * s, vw = W / k, vh = H / k, mg = 24 / k;
    const fit = (c, vis, lo, len) => vis >= len + 2 * mg ? lo + len / 2 : N.clamp(c, lo - mg + vis / 2, lo + len + mg - vis / 2);
    return {s, cx: fit(cx, vw, VX, VW), cy: fit(cy, vh, VY, VH)};
  };
  Object.assign(st, clampSt(st.s, st.cx, st.cy));

  // Pins: your gate(s) always, then map words and places by importance, then gate numbers when zoomed in.
  const pins = [
    ...[...m.you, ...extra].map(p => Object.assign({}, p, {type: 'you', pri: 0, minS: 1, labelS: 1, c: 10, q: p.q || p === gYou})),
    ...m.lbls.map(p => Object.assign({}, p, {type: 'lbl', labelS: 1, c: 0})),
    ...m.poi.map(p => Object.assign({}, p, {type: 'poi', c: 13})),
    ...m.gates.filter(p => !extra.length || normG(p.label) !== normG(gq)).map(p => Object.assign({}, p, {type: 'gn', pri: 5, minS: 2.2, labelS: 1, c: 0})),
  ].sort((a, b) => a.pri - b.pri);
  layer.innerHTML = String(h`${pins.map(p => p.type === 'you'
    ? h`<div class="${`ap-pin ap-you ${p.tone}${p.q ? ' q' : ''}`}"><div class="ap-pi"><span class="ap-dot"></span><span class="ap-pl">${p.label}</span></div></div>`
    : p.type === 'poi'
      ? h`<div class="ap-pin ap-poi k-${p.kind}"><div class="ap-pi"><span class="ap-pb">${icon(KIND_IC[p.kind] || 'point')}</span><span class="ap-pl">${p.label}</span></div></div>`
      : p.type === 'lbl'
        ? h`<div class="ap-pin ap-lbl al-${p.al} ${p.cls}"><div class="ap-pi">${p.label}</div></div>`
        : h`<div class="ap-pin ap-gn al-${p.al}"><div class="ap-pi">${p.label}</div></div>`)}`);
  [...layer.children].forEach((el, i) => { pins[i].el = el; pins[i].in = el.firstElementChild; pins[i].shown = true; pins[i].lab = null; });
  // Measure each pin once with and without its label.
  pins.forEach(p => {
    p.el.classList.add('lb'); p.wl = p.in.offsetWidth; p.hh = p.in.offsetHeight || 26;
    const pl = p.in.querySelector('.ap-pl'); p.lw = pl ? pl.offsetWidth : 0;
    p.el.classList.remove('lb'); p.w0 = p.type === 'poi' ? 26 : p.in.offsetWidth;
    if (p.type === 'you') p.el.classList.add('lb');
  });

  // The zoom buttons and the Done pill sit over the map; names keep clear of them.
  let keep = [];
  const measure = () => {
    const r = el => [el.offsetLeft - 4, el.offsetTop - 4, el.offsetLeft + el.offsetWidth + 4, el.offsetTop + el.offsetHeight + 4];
    keep = zc && zc.offsetWidth ? [r(zc)] : [];
    if (done) { const hid = done.hidden; done.hidden = false; keep.doneBox = r(done); done.hidden = hid; }
  };
  const IN = 12;   // names stay this far inside the frame
  const place = (k, x0, y0) => {
    const boxes = keep.slice();
    if (keep.doneBox && st.s > 1.01) boxes.push(keep.doneBox);
    for (const p of pins) {
      const x = (p.x - x0) * k, y = (p.y - y0) * k;
      let show = st.s >= p.minS - 1e-6 && x > -30 && y > -30 && x < W + 30 && y < H + 30;
      let lab = p.type !== 'poi' || st.s >= p.labelS;
      // A place whose name fits on neither side shows just its icon (tap it for the name).
      if (lab && p.type === 'poi' && x - p.c + p.wl > W - IN && x + p.c - p.wl < IN) lab = false;
      const w = lab ? p.wl : p.w0, hh = p.hh;
      let flip = false, box, dn = 0, off = 0;
      if (p.type === 'gn' || p.type === 'lbl') {
        box = p.al === 's' ? [x, y - hh / 2, x + w, y + hh / 2] : p.al === 'e' ? [x - w, y - hh / 2, x, y + hh / 2] : [x - w / 2, y - hh / 2, x + w / 2, y + hh / 2];
        // Map words and gate numbers only show whole and clear of the frame.
        if (box[0] < IN || box[1] < IN / 2 || box[2] > W - IN || box[3] > H - IN / 2) show = false;
      }
      else {
        const fitR = x - p.c + w <= W - IN, fitL = x + p.c - w >= IN;
        flip = lab && !fitR && fitL;
        if (p.type === 'you' && !fitR && !fitL) {
          // Too wide for either side: the name sits under (or over) the dot, kept inside the frame.
          dn = y + 14 + hh <= H - 4 ? 1 : -1;
          off = N.clamp(x - p.lw / 2, IN, Math.max(IN, W - IN - p.lw)) - x;
          const ly = dn > 0 ? y + 14 : y - 14 - hh;
          box = [Math.min(x - p.c, x + off), Math.min(y - p.c, ly), Math.max(x + p.c, x + off + p.lw), Math.max(y + p.c, ly + hh)];
        } else box = flip ? [x + p.c - w, y - hh / 2, x + p.c, y + hh / 2] : [x - p.c, y - hh / 2, x - p.c + w, y + hh / 2];
      }
      if (show && p.type !== 'you') {
        const pad = p.type === 'gn' ? 2 : 3;
        if (boxes.some(b => box[0] < b[2] + pad && box[2] + pad > b[0] && box[1] < b[3] + pad && box[3] + pad > b[1])) show = false;
      }
      p.sx = p.type === 'gn' ? (box[0] + box[2]) / 2 : x; p.sy = y;
      if (show) boxes.push(box);
      if (show !== p.shown) { p.el.style.display = show ? '' : 'none'; p.shown = show; }
      if (!show) continue;
      p.el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
      if (p.type === 'poi' && lab !== p.lab) { p.el.classList.toggle('lb', lab); p.lab = lab; }
      if (flip !== p.flip) { p.el.classList.toggle('fl', flip); p.flip = flip; }
      if (dn !== (p.dn || 0)) { p.el.classList.toggle('dn', dn > 0); p.el.classList.toggle('up', dn < 0); p.dn = dn; }
      if (dn) p.el.style.setProperty('--dx', `${off.toFixed(1)}px`);
    }
  };
  // At 1x the page keeps one-finger vertical drags (pan-y); zoomed, the map takes
  // every drag and the Done pill is the way back to scrolling the page.
  let zoomed = null, said = 0;
  const say = (t, auto) => { if (cap) cap.textContent = t; if (!auto) said = performance.now(); };
  const apply = () => {
    const k = k0() * st.s, vw = W / k, vh = H / k, x0 = st.cx - vw / 2, y0 = st.cy - vh / 2;
    svg.setAttribute('viewBox', `${x0.toFixed(2)} ${y0.toFixed(2)} ${vw.toFixed(2)} ${vh.toFixed(2)}`);
    const z = st.s > 1.01;
    if (z !== zoomed) {
      zoomed = z;
      wrap.classList.toggle('zoomed', z);
      mv.style.touchAction = z ? 'none' : 'pan-y';
      if (done) done.hidden = !z;
      // Keep a name you just tapped on screen rather than swapping in the hint.
      if (performance.now() - said > 600) say(z ? CAP2 : CAP1, true);
    }
    place(k, x0, y0);
    if (btnIn) btnIn.disabled = st.s >= MAXS - 0.01;
    if (btnOut) btnOut.disabled = !z;
  };

  let raf = 0;
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
  const animTo = (s, cx, cy) => {
    const to = clampSt(s, cx, cy);
    stop();
    if (N.reduce) { Object.assign(st, to); apply(); return; }
    const from = Object.assign({}, st), t0 = performance.now(), D = 320;
    const step = t => {
      const u = Math.min(1, (t - t0) / D), e = 1 - Math.pow(1 - u, 3);
      st.s = Math.exp(Math.log(from.s) + (Math.log(to.s) - Math.log(from.s)) * e);
      st.cx = from.cx + (to.cx - from.cx) * e; st.cy = from.cy + (to.cy - from.cy) * e;
      apply();
      raf = u < 1 ? requestAnimationFrame(step) : 0;
    };
    raf = requestAnimationFrame(step);
  };
  const rel = e => { const r = mv.getBoundingClientRect(); return {x: e.clientX - r.left, y: e.clientY - r.top}; };
  const toMap = p => { const k = k0() * st.s; return {x: st.cx - W / (2 * k) + p.x / k, y: st.cy - H / (2 * k) + p.y / k}; };
  // Centre that keeps map point a under screen point p at scale s.
  const about = (a, p, s) => { const k = k0() * N.clamp(s, 1, MAXS); return [a.x - p.x / k + W / (2 * k), a.y - p.y / k + H / (2 * k)]; };
  const zoomAt = (p, s) => { const [cx, cy] = about(toMap(p), p, s); animTo(s, cx, cy); };

  const pick = p => {
    const k = k0() * st.s, a = toMap(p);
    let best = null, bd = 22 / k;
    for (const q of m.pts) { const d = Math.hypot(q.x - a.x, q.y - a.y); if (d < bd) { bd = d; best = q; } }
    if (!best) { say(st.s > 1.01 ? CAP2 : CAP1); return; }
    const name = best.full || best.label;
    const KW = {security: ['Security', /security|checkpoint|tsa/i], baggage: ['Bag claim', /bag|claim|carousel/i], food: ['Food', /food|caf[eé]|coffee|deli|bar\b|restaurant/i], lounge: ['Lounge', /lounge|club|provisions/i]};
    const kw = KW[best.kind];
    say(best.kind === 'gate' ? `Gate ${best.label}` : kw && !kw[1].test(name) ? `${name} · ${kw[0]}` : name);
  };

  // Pointer gestures: one finger pans when zoomed, two fingers pinch, double-tap zooms.
  const pts = new Map();
  let gst = null, lastTap = null, tapT = 0, gs = null, pinched = false, hitT = 0, hitEl = null;
  // A pinch that ends just above 1x goes back to 1x, so the page gets its swipes back.
  const snap = () => { if (st.s > 1 && st.s < 1.08) animTo(1, VX + VW / 2, VY + VH / 2); };
  // The dot under your finger rings at once; its name follows when the tap is sure.
  const hit = p => {
    let best = null, bd = 22;
    for (const q of pins) if (q.shown && q.type !== 'lbl' && Number.isFinite(q.sx)) { const d = Math.hypot(q.sx - p.x, q.sy - p.y); if (d < bd) { bd = d; best = q; } }
    if (hitEl) hitEl.classList.remove('hit');
    clearTimeout(hitT);
    hitEl = best && best.el;
    if (hitEl) { hitEl.classList.add('hit'); hitT = setTimeout(() => { if (hitEl) hitEl.classList.remove('hit'); hitEl = null; }, 150); }
  };
  const begin = () => {
    const a = [...pts.values()];
    if (a.length >= 2) {
      pinched = true;
      const [p, q] = a, mid = {x: (p.x + q.x) / 2, y: (p.y + q.y) / 2};
      gst = {type: 'pinch', d0: Math.hypot(p.x - q.x, p.y - q.y) || 1, s0: st.s, anchor: toMap(mid), moved: 99};
    } else if (a.length === 1) gst = {type: 'pan', last: a[0], start: a[0], moved: 0, t0: performance.now()};
    else gst = null;
  };
  const onDown = e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    stop();
    pts.set(e.pointerId, rel(e));
    try { mv.setPointerCapture(e.pointerId); } catch (x) { /* not capturable */ }
    begin();
    if (pts.size >= 2) clearTimeout(tapT);
    else hit(pts.get(e.pointerId));
  };
  const onMove = e => {
    if (!pts.has(e.pointerId)) return;
    const p = rel(e);
    pts.set(e.pointerId, p);
    if (!gst) return;
    if (gst.type === 'pinch' && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mid = {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
      const s = N.clamp(gst.s0 * d / gst.d0, 1, MAXS);
      const [cx, cy] = about(gst.anchor, mid, s);
      Object.assign(st, clampSt(s, cx, cy)); apply();
      e.preventDefault();
    } else if (gst.type === 'pan') {
      const dx = p.x - gst.last.x, dy = p.y - gst.last.y;
      gst.last = p;
      gst.moved = Math.max(gst.moved, Math.hypot(p.x - gst.start.x, p.y - gst.start.y));
      if (st.s > 1.01) { const k = k0() * st.s; Object.assign(st, clampSt(st.s, st.cx - dx / k, st.cy - dy / k)); apply(); e.preventDefault(); }
    }
  };
  const tap = p => {
    const t = performance.now();
    if (lastTap && t - lastTap.t < 320 && Math.hypot(p.x - lastTap.p.x, p.y - lastTap.p.y) < 30) {
      lastTap = null; clearTimeout(tapT);
      if (st.s >= MAXS - 0.01) animTo(1, VX + VW / 2, VY + VH / 2); else zoomAt(p, Math.min(MAXS, st.s * 2));
      return;
    }
    lastTap = {t, p};
    clearTimeout(tapT);
    tapT = setTimeout(() => pick(p), 330);
  };
  const onUp = e => {
    if (!pts.has(e.pointerId)) return;
    const p = rel(e);
    pts.delete(e.pointerId);
    if (e.type === 'pointerup' && gst && gst.type === 'pan' && gst.moved < 8 && performance.now() - gst.t0 < 450) tap(p);
    if (pts.size) begin(); else { gst = null; if (pinched) { pinched = false; snap(); } }
    if (gst) gst.moved = 99;   // lifting one finger of a pinch is not a tap
  };
  const onWheel = e => {
    if (!e.ctrlKey) return;   // plain wheel and two-finger scroll stay with the page
    e.preventDefault();
    const p = rel(e), s = N.clamp(st.s * Math.exp(-e.deltaY * 0.01), 1, MAXS);
    const [cx, cy] = about(toMap(p), p, s);
    stop(); Object.assign(st, clampSt(s, cx, cy)); apply();
  };
  // Safari: stop the page zooming; trackpad pinch on a Mac only sends gesture events.
  const onGS = e => { e.preventDefault(); gs = pts.size ? null : {s0: st.s, p: rel(e), a: toMap(rel(e))}; };
  const onGC = e => {
    e.preventDefault();
    if (!gs || pts.size || !Number.isFinite(e.scale)) return;
    const s = N.clamp(gs.s0 * e.scale, 1, MAXS); const [cx, cy] = about(gs.a, gs.p, s);
    Object.assign(st, clampSt(s, cx, cy)); apply();
  };
  const onGE = e => { e.preventDefault(); if (gs) snap(); gs = null; };
  const onKey = e => {
    const k = e.key;
    if (k === '+' || k === '=') api.zoom(1);
    else if (k === '-' || k === '_') api.zoom(-1);
    else if (k === '0') api.reset();
    else if (st.s > 1.01 && /^Arrow/.test(k)) {
      const kk = k0() * st.s, d = 48 / kk;
      const dx = k === 'ArrowLeft' ? -d : k === 'ArrowRight' ? d : 0, dy = k === 'ArrowUp' ? -d : k === 'ArrowDown' ? d : 0;
      Object.assign(st, clampSt(st.s, st.cx + dx, st.cy + dy)); apply();
    } else return;
    e.preventDefault();
  };
  const on = [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onUp], ['lostpointercapture', onUp],
    ['wheel', onWheel, {passive: false}], ['gesturestart', onGS], ['gesturechange', onGC], ['gestureend', onGE], ['keydown', onKey]];
  on.forEach(([t, f, o]) => mv.addEventListener(t, f, o || false));
  let ro = null;
  if (window.ResizeObserver) {
    ro = new ResizeObserver(() => {
      const w = mv.clientWidth, hh = mv.clientHeight;
      if (w && hh && (w !== W || hh !== H)) { W = w; H = hh; measure(); Object.assign(st, clampSt(st.s, st.cx, st.cy)); apply(); }
    });
    ro.observe(mv);
  }
  measure();
  apply();
  if (gp && fresh) animTo(2.2, gp.x, gp.y);

  const api = {
    busy: () => pts.size > 0 || !!raf,
    zoom: dir => {
      const f = dir > 0 ? 1.8 : 1 / 1.8, kk = k0() * st.s;
      // + keeps your gate on screen: while it is in view, zoom about it and ease it halfway
      // toward the middle; otherwise (or for −) zoom about the centre.
      const a = m.you.find(p => p.tone === 'you') || m.you[0];
      const seen = dir > 0 && a && Math.abs(a.x - st.cx) * kk < W / 2 && Math.abs(a.y - st.cy) * kk < H / 2;
      animTo(st.s * f, seen ? a.x + (st.cx - a.x) / f / 2 : st.cx, seen ? a.y + (st.cy - a.y) / f / 2 : st.cy);
    },
    reset: () => { animTo(1, VX + VW / 2, VY + VH / 2); say(CAP1); },
    gate: () => {
      if (!m.focus) return;
      const [x0, y0, x1, y1] = m.focus, pad = 26;
      const bw = Math.max(40, x1 - x0 + pad * 2), bh = Math.max(40, y1 - y0 + pad * 2);
      const s = N.clamp(Math.min(W / (bw * k0()), H / (bh * k0())), 1.5, 4);
      const k = k0() * s, hw = W / (2 * k), hv = H / (2 * k), mg = 44 / k;
      let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      // When the whole walk does not fit, keep your gate and its label in view.
      const a = m.you.find(p => p.tone === 'you') || m.you[0];
      if (a) { cx = N.clamp(cx, a.x - hw + mg, a.x + hw - mg); cy = N.clamp(cy, a.y - hv + mg, a.y + hv - mg); }
      animTo(s, cx, cy);
      say(m.you.map(p => p.label).join(' to ') || m.gateLabel);
    },
    cleanup: () => {
      stop(); clearTimeout(tapT); clearTimeout(hitT);
      on.forEach(([t, f, o]) => mv.removeEventListener(t, f, o || false));
      if (ro) ro.disconnect();
    },
  };
  return api;
}

// ---------- lower sections ----------
// A reference section that starts closed: its title, a short note and a chevron.
const fold = (id, title, note, body) => h`<section class="sec ap-anc" id="ap-${id}"><details class="ap-fold">
  <summary><span class="grow"><span class="ey">${title}</span>${note ? h`<small>${note}</small>` : ''}</span>${icon('chevron-down', 'ap-chev')}</summary>
  <div class="ap-fb">${body}</div></details></section>`;
// The rest of a list, opened in place.
const more = (label, body) => h`<details class="ap-more"><summary><span class="grow">${label}</span>${icon('chevron-down', 'ap-chev')}</summary><div class="ap-mb">${body}</div></details>`;

function securityHtml(code, v) {
  const g = guide(code);
  const list = arr(g && g.security).filter(obj);
  const at = secTime(code, v);
  const m = at ? localMin(at, code) : null;
  const role = v ? v.role : '';
  // Through security on the way out (the step's length, at least 20 min, has passed): nothing left to choose.
  if (role === 'depart' && (departed(v.out) || (at && nowMs() >= T(at) + Math.max(+(secStep(code) || {}).min || 0, 20) * 60000))) return '';
  if (!list.length) return role === 'connect' || role === 'arrive' ? ''
    : h`<section class="sec ap-anc" id="ap-sec"><div class="ey">Security</div><div class="co plain">${icon('info-circle')}<span><b>No checkpoint details.</b> The guide has none saved for ${code}.</span></div></section>`;
  const card = s => {
    const r = hoursRange(s.hours);
    const o = m == null ? null : openAt(r, m);
    const state = o == null ? '' : o ? h`<span class="chip cr ap-ok">${icon('circle-check')}Open at ${N.time(at, code)}</span>`
      : h`<span class="chip cr ap-cw">${icon('clock')}${r && !r.all ? `Opens ${clockTxt(r.a)}` : 'Closed then'}</span>`;
    const fact = (label, val) => val ? h`<div><dt>${label}</dt><dd>${val}</dd></div>` : '';
    return h`<div class="ap-ck">
      <div class="rw"><span class="ic">${icon('shield-check')}</span><div class="grow"><b>${str(s.name) || 'Checkpoint'}</b>${s.where ? h`<small>${s.where}</small>` : ''}</div></div>
      ${state ? h`<div class="ap-cks">${state}</div>` : ''}
      <dl class="ap-dl">${fact('Hours', apTime(s.hours) || 'Not listed')}${fact('PreCheck', apTime(s.precheck))}${fact('CLEAR', apTime(s.clear))}</dl>
      ${s.note ? h`<p class="ap-cn2">${s.note}</p>` : ''}
    </div>`;
  };
  // Not going through security here: all of it, closed, for if you need it.
  if (role === 'connect') return fold('sec', 'Security', 'Only if you leave the secure area', h`<div class="stack8">${list.map(card)}</div>`);
  if (role === 'arrive') return fold('sec', 'Security', `For leaving from ${code}`, h`<div class="stack8">${list.map(card)}</div>`);
  // Leaving: the first checkpoint open at your security time, the others closed below it.
  const i = Math.max(0, list.findIndex(x => m == null || openAt(hoursRange(x.hours), m) !== false));
  const rest = list.filter((x, j) => j !== i);
  const lbl = rest.every(x => /checkpoint/i.test(str(x.name))) ? 'Other checkpoints' : 'More options';
  return h`<section class="sec ap-anc" id="ap-sec"><div class="ey">Security</div>
    ${card(list[i])}
    ${rest.length ? more(`${lbl} (${rest.length})`, h`<div class="stack8">${rest.map(card)}</div>`) : ''}</section>`;
}

function foodHtml(code, v) {
  const g = guide(code);
  const list = arr(g && g.food).filter(obj);
  const head = h`<div class="ey">Food and coffee</div>`;
  if (!list.length) return h`<section class="sec ap-anc" id="ap-food">${head}<div class="co plain">${icon('info-circle')}<span><b>No food listed.</b> The guide has none saved for ${code} yet.</span></div></section>`;
  const gate = v ? (v.role === 'arrive' ? v.inn.arr.gate : v.out.dep.gate || (v.inn && v.inn.arr.gate)) : null;
  const gm = normG(gate).match(/^([A-Z]*)(\d+)/);
  const land = f => /before security|landside|pre-?security|ticketing|check-?in|departures|checkpoints?\b/i.test(`${str(f.near)} ${str(f.where)}`) && !/after security|airside/i.test(str(f.where));
  const score = f => {
    if (!gm) return 50;
    const s = `${str(f.near)} ${str(f.where)}`.toUpperCase();
    const q = s.match(/\b([A-E])\s?(\d{1,2})\b/);
    if (gm[1] && q) return q[1] === gm[1] ? Math.abs(+q[2] - +gm[2]) : 100 + Math.abs(+q[2] - +gm[2]);
    const rg = s.match(/\b(\d{1,2})\s?[–-]\s?(\d{1,2})\b/);
    if (!gm[1] && rg) return +gm[2] >= +rg[1] && +gm[2] <= +rg[2] ? 3 : 150;
    if (gm[1] && new RegExp(`\\b${gm[1]}\\b|\\b${gm[1]} (GATES|CONCOURSE)|CONCOURSE ${gm[1]}\\b|${gm[1]} GATES`).test(s)) return 8;
    if (/AA GATES|AMERICAN/.test(s)) return 6;
    if (/ATRIUM|HUB|CENTER|BRIDGE|FOOD HALL|MAIN/.test(s)) return 30;
    return 60;
  };
  // When you'd eat, and never earlier than now: once off the plane on a connection, before
  // boarding on a departure, soon after landing on arrival.
  const role = v && v.role;
  const base = role === 'connect' && okT(v.inn.arr.time) ? N.addMin(v.inn.arr.time, 10)
    : role === 'depart' && okT(v.out.dep.time) ? N.addMin(v.out.dep.time, -N.AA.board - 10)
    : role === 'arrive' && okT(v.inn.arr.time) ? N.addMin(v.inn.arr.time, 20) : null;
  const isNow = !!base && nowMs() >= T(base);
  const eatAt = !base ? null : isNow ? N.now().toISOString() : base;
  const em = eatAt ? localMin(eatAt, code) : null;
  // No time to eat once that is at or past boarding: the list folds away under why.
  const board = role !== 'arrive' && v && v.out && okT(v.out.dep.time) ? T(N.addMin(v.out.dep.time, -N.AA.board)) : NaN;
  const late = !!eatAt && T(eatAt) >= board && !overV(v);
  const openInfo = f => {
    if (em == null) return {open: null};
    const hs = str(f.hours), r = hoursRange(hs);
    if (r) return {open: openAt(r, em), a: r.all ? null : r.a};
    const m = hs.match(/^\s*(?:from|opens?)\s+(\d{1,2}(?::\d{2})?\s*[ap])/i), a = m ? clockMin(m[1]) : null;
    return a == null ? {open: null} : {open: em >= a, a};
  };
  // Leaving: a place that only opens once your flight has gone is left out.
  const dm = v && v.role !== 'arrive' && v.out && okT(v.out.dep.time) ? localMin(v.out.dep.time, code) : null;
  const gone = x => em != null && dm != null && x.open === false && x.a != null && (x.a - em + 1440) % 1440 >= (dm - em + 1440) % 1440;
  const items = list.map((f, i) => Object.assign({f, i, land: land(f), sc: score(f)}, openInfo(f))).filter(x => !gone(x));
  // Near your gate first; places that won't be open in time go last.
  const air = items.filter(x => !x.land).sort((a, b) => (a.open === false) - (b.open === false) || a.sc - b.sc || a.i - b.i);
  const pre = items.filter(x => x.land);
  const row = x => {
    const f = x.f, near = gm && x.sc <= 4 && x.open !== false;
    // "At your gate" only when it is your gate; otherwise where it is ("Near your gate, at B1").
    const mine = h`<span class="ap-me">${!/^[A-Z]{0,2}\d{1,3}$/i.test(str(f.near)) ? 'Near your gate' : normG(f.near) === normG(gate) ? 'At your gate' : `Near your gate, at ${str(f.near).toUpperCase()}`}</span>`;
    const kind = /coffee|caf|espresso|tea\b|starbucks|peet|dunkin/i.test(`${str(f.kind)} ${str(f.name)}`) ? 'coffee' : 'tools-kitchen-2';
    // Where it is goes in the subline ("Near A7"); a gate-area "where" that only repeats the gate letter is dropped.
    const nr = str(f.near), gt = /^[A-Z]{0,2}\d{1,3}$/i.test(nr);
    const where = gt && /^airside,?\s+[A-Z] gates$/i.test(str(f.where)) ? '' : str(f.where);
    // Skip a landmark the location line already starts with ("Atrium · Atrium, upper level").
    const said = !gt && nr && where.toLowerCase().startsWith(nr.toLowerCase());
    const sub = [near || said ? '' : nr ? (gt ? `Near ${nr.toUpperCase()}` : nr) : '', where, apTime(f.hours)];
    // One status per row: open (green dot), opens later (amber dot) or closed (grey dot).
    const st = x.open == null ? '' : x.open ? h`<span class="ap-os on">Open</span>`
      : x.a != null ? h`<span class="ap-os soon">Opens ${clockTxt(x.a)}</span>` : h`<span class="ap-os off">Closed</span>`;
    return h`<div class="ap-fd">
      <span class="ic">${icon(kind)}</span>
      <div class="grow"><b>${str(f.name) || 'Food'}</b><small>${meta([near && mine, ...sub])}</small>${f.note ? h`<small class="ap-fn">${f.note}</small>` : ''}</div>
      ${st}
    </div>`;
  };
  const sortNote = `${gm ? `Nearest to gate ${str(gate).toUpperCase()} first.` : 'Sorted by your gate once AA posts it.'}${em == null ? ''
    : isNow ? ' Shows what’s open now.' : ` Shows what’s open at ${tmz(eatAt, code)}, ${role === 'connect' ? 'once you’re off the plane' : role === 'arrive' ? 'after landing' : 'before boarding'}.`}`;
  // The four nearest stay in view; the rest and anything outside security open below.
  const top = air.slice(0, 4), rest = air.slice(4);
  const preH = pre.length ? h`<div class="ap-subh">${role === 'connect' ? 'Outside security (means screening again)' : role === 'arrive' ? 'Outside security' : 'Before security'}</div><div class="ap-list">${pre.map(row)}</div>` : '';
  const body = h`<p class="ap-note">${sortNote}</p>
    <div class="ap-list">${top.map(row)}</div>
    ${rest.length || pre.length ? more(`More places (${rest.length + pre.length})`, h`${rest.length ? h`<div class="ap-list">${rest.map(row)}</div>` : ''}${preH}`) : ''}`;
  return late ? fold('food', 'Food and coffee', nowMs() >= board ? 'Boarding has started' : 'No time before boarding', body)
    : h`<section class="sec ap-anc" id="ap-food">${head}${body}</section>`;
}

// US phone numbers in guide text become real call/text buttons (at 3am you
// want to tap "Call AA", not copy digits). "AA 800-433-7300 · TSA Cares
// 1-855-787-2227" gives two buttons; "or text 646-…" gives a text button.
function callChips(text) {
  const out = [], re = /(?:\+?1[-.\s])?\(?(\d{3})\)?[-.\s](\d{3})[-.\s](\d{4})\b/g;
  str(text).split(/\s+·\s+|;\s*/).forEach(seg => {
    let m, last = 0;
    while ((m = re.exec(seg))) {
      const before = seg.slice(last, m.index);
      last = re.lastIndex;
      const sms = /\btext\s*$/i.test(before);
      const name = before.replace(/\b(call|text|or|at)\b/gi, '').replace(/[:,()]/g, '').trim().slice(0, 24);
      out.push({href: `${sms ? 'sms' : 'tel'}:+1${m[1]}${m[2]}${m[3]}`, sms, label: `${sms ? 'Text' : 'Call'}${name ? ' ' + name : ''}`, num: `${m[1]}-${m[2]}-${m[3]}`});
    }
    re.lastIndex = 0;
  });
  return out.slice(0, 4);
}
function servicesHtml(code) {
  const g = guide(code);
  const list = arr(g && g.services).filter(obj);
  if (!list.length) return '';
  // Text that held a number loses it: the number is on its own row below.
  const PH = /(?:\+?1[-.\s])?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/;
  return h`<section class="sec ap-anc" id="ap-svc"><div class="ey">Services</div><div class="ap-list">${list.map(s => {
    const calls = callChips(`${str(s.label)} · ${str(s.where)}`);
    const label = PH.test(str(s.label)) ? str(s.where) || 'Phone' : str(s.label) || 'Service';
    const where = PH.test(str(s.label)) || PH.test(str(s.where)) ? '' : str(s.where);
    return h`<div class="ap-sv">
    <span class="ic">${ic(s.icon)}</span><div class="grow"><b>${label}</b>${where ? h`<small>${where}</small>` : ''}
      ${calls.length ? h`<div class="ap-calls">${calls.map(c => h`<a class="ap-call" href="${c.href}">${ic(c.sms ? 'message-circle' : 'phone', 'phone')}<span class="grow">${c.label}</span><span class="tn">${c.num}</span></a>`)}</div>` : ''}</div></div>`;
  })}</div></section>`;
}

const MODE_IC = {car: 'car', taxi: 'car', rideshare: 'car', valet: 'parking', parking: 'parking', garage: 'parking', economy: 'parking',
  bus: 'bus', shuttle: 'bus', van: 'bus', train: 'train', subway: 'train', rail: 'train', lirr: 'train', walk: 'walk'};
// LGA's ground options open Transit's own route for the same way in (#route/hotel/to-hotel-…),
// so both screens show one set of steps and times; the guide's row is the fallback.
const gkey = id => /lirr/i.test(id) ? 'lirr' : /q70/i.test(id) ? 'q70' : /m60/i.test(id) ? 'm60' : /van/i.test(id) ? 'van' : '';
const routeId = x => {
  const k = gkey(str(x.id)), tr = obj(N.data.guide && N.data.guide.transit) || {};
  const r = arr(tr.to_hotel).filter(r => obj(r) && /^[\w-]+$/.test(str(r.id))).find(r => k ? gkey(str(r.id)) === k : r.mode === x.mode && !gkey(str(r.id)));
  return r ? str(r.id) : /^[\w-]+$/.test(str(x.id)) ? str(x.id) : '';
};
function groundHtml(code, v) {
  const g = guide(code);
  const list = arr(g && g.ground).filter(obj);
  if (!list.length) return '';
  const nyc = code === 'LGA';
  const into = !v || v.role === 'arrive';
  // Outside NYC the guide's ground list is written for getting to the airport,
  // so on an arrival it gets a neutral title rather than "Leaving".
  const title = !into ? `Getting to ${code}` : nyc ? `Leaving ${code}` : `To and from ${code}`;
  const rows = list.map(x => {
    const mn = arr(x.min).filter(n => Number.isFinite(+n));
    const t = mn.length ? `${mn[0]}${mn[1] && mn[1] !== mn[0] ? `–${mn[1]}` : ''} min` : '';
    const body = h`<span class="ic">${ic(MODE_IC[lc(x.mode)] || lc(x.mode), 'route')}</span>
      <div class="grow"><b>${str(x.name) || 'Option'}</b>
        <small class="tn">${meta([t, str(x.cost)])}</small>
        ${x.where ? h`<small>${x.where}</small>` : ''}
        ${x.good ? h`<small class="ap-gd">${icon('thumb-up')}${x.good}</small>` : ''}
        ${x.bad ? h`<small class="ap-bd">${icon('alert-circle')}${x.bad}</small>` : ''}</div>`;
    const rid = nyc && into ? routeId(x) : '';
    return rid
      ? h`<a class="ap-gr" href="#route/hotel/${rid}">${body}${icon('chevron-right', 'ap-chev')}</a>`
      : h`<div class="ap-gr">${body}</div>`;
  });
  const tr = nyc ? h`<a class="ap-tr" href="#transit"><span class="ic">${icon('route')}</span><div class="grow"><b>${into ? 'Compare ways into Manhattan' : 'Compare ways to LGA'}</b><small>Taxi, train and bus with today’s times in Transit</small></div>${icon('chevron-right', 'ap-chev')}</a>` : '';
  // Leaving: the steps already cover the trip in, so the full list starts closed.
  if (!into) return fold('ground', title, `${N.plural(list.length, 'option')} with times and costs`, h`${tr}<div class="ap-list">${rows}</div>`);
  return h`<section class="sec ap-anc" id="ap-ground"><div class="ap-sh"><div class="ey">${title}</div></div>
    ${tr}<div class="ap-list">${rows}</div></section>`;
}

// Keep "B16 310 m" and "C 5–9 min" whole in the narrow fact tiles so lines break at the
// " · " separators: gate code + number, number + unit, and digit ranges stay together.
const keepUnit = v => str(v)
  .replace(/(\d)([–-])(?=\d)/g, '$1$2\u2060')
  .replace(/\b([A-Z]\d{0,3}) (?=\d)/g, '$1\u00a0')
  .replace(/(\d) (?=(?:m|min|ft|km|mi|hr|hours?)\b)/g, '$1\u00a0');

// An "M/D" date in guide text is a day of this trip's year (airport-local).
const mdPast = (s, code) => {
  const m = str(s).match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (!m) return false;
  const today = N.ymd(N.now(), code);
  return `${today.slice(0, 4)}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` < today;
};
// A fact that is only a clock time ("4:15a", "~4:20a") is about leaving from here:
// gone once the flight has, or once that time has passed on the day.
const timePast = (f, code) => {
  const t = str(f.value).trim().match(/^~?\s*(\d{1,2}(?::\d{2})?\s*[ap])\.?m?\.?$/i);
  if (!t) return false;
  const d = visitsOf(code).find(x => x.role === 'depart');
  if (!d || !okT(d.out.dep.time)) return false;
  if (departed(d.out)) return true;
  const md = str(f.label).match(/\b\d{1,2}\/\d{1,2}\b/);
  const day = md ? null : N.ymd(d.out.dep.time, code);
  return (md || day === N.ymd(N.now(), code)) && localMin(N.now().toISOString(), code) > clockMin(t[1]);
};
function infoHtml(code, v) {
  const g = guide(code);
  const facts = arr(g && g.facts).filter(obj).filter(f => !mdPast(f.label, code) && !timePast(f, code));
  const tips = arr(g && g.tips).map(fnoText).filter(t => t && !mdPast(t, code));
  const links = arr(g && g.links).filter(obj).filter(l => /^https?:|^tel:/i.test(str(l.url)));
  const cav = caveats(code, v);
  if (!facts.length && !tips.length && !links.length && !cav.length) return '';
  // A long value gets the full row, and so does an odd last tile.
  const long = (f, i) => str(f.value).length > 14 || (i === facts.length - 1 && facts.filter((x, j) => j < i && !(str(x.value).length > 14)).length % 2 === 0);
  const what = [facts.length && 'facts', tips.length && 'tips', cav.length && 'open questions', links.length && 'links'].filter(Boolean);
  const note = what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what[what.length - 1]}` : what[0];
  return fold('info', 'Good to know', note.charAt(0).toUpperCase() + note.slice(1), h`
    ${facts.length ? h`<div class="ap-facts">${facts.map((f, i) => h`<div class="${N.cls('ap-fact', long(f, i) && 'long')}"><small>${str(f.label)}</small><b>${keepUnit(f.value)}</b>${f.detail ? h`<span>${keepUnit(f.detail)}</span>` : ''}</div>`)}</div>` : ''}
    ${tips.length ? h`<div class="ap-subh">Tips</div><ul class="ap-tips">${tips.map(t => h`<li>${icon('check')}<span>${t}</span></li>`)}</ul>` : ''}
    ${cav.length ? h`<div class="ap-subh">Not yet confirmed</div><ul class="ap-tips ap-cav">${cav.map(t => h`<li>${icon('alert-circle')}<span>${t}</span></li>`)}</ul>` : ''}
    ${links.length ? h`<div class="ap-subh">Links</div><div class="ap-list">${links.map(l => ext(l.url, h`<span class="grow"><b>${str(l.label) || str(l.url)}</b>${l.what ? h`<small>${l.what}</small>` : ''}</span>${icon('arrow-up-right', 'ap-chev')}`, 'ap-lk'))}</div>` : ''}`);
}

// ---------- page ----------
const codeOf = ctx => {
  const p = str(ctx && ctx.name === 'airport' ? ctx.param : '').replace(/\?.*$/, '').trim().toUpperCase();
  return p || autoCode();
};
// A gate named in the link (#airport/phx?gate=A22), as Today's gate links send it.
const qGate = ctx => {
  const m = str(ctx && ctx.name === 'airport' ? ctx.param : '').match(/[?&]gate=([^&]+)/);
  const g = m ? m[1].trim() : '';
  return /^[A-Za-z0-9-]{1,6}$/.test(g) ? g : '';
};
N.airportGateLinks = true;
function emptyHero(title, sub) {
  return h`<div class="ap-hero ap-e"><div class="ps ap-ps" role="group" aria-label="Airport">${codes().map(c => h`<button type="button" data-act="ap" data-arg="${lc(c)}" aria-pressed="false">${c}</button>`)}</div>
    <div class="ap-top"><h1 class="hl"><b>${title}</b></h1>${sub ? h`<p class="ap-sub"><span>${sub}</span></p>` : ''}</div></div>`;
}
function render(ctx) {
  const code = codeOf(ctx);
  const known = codes();
  if (!/^[A-Z]{3}$/.test(code) || (!known.includes(code) && !guide(code))) {
    return {hero: emptyHero('Airport not on this trip', `“${str(ctx.param).replace(/\?.*$/, '').slice(0, 12)}” isn’t one of your airports.`),
      body: h`<div class="ap-pg"><div class="co plain">${icon('building-airport')}<span><b>Pick an airport.</b> Choose one of yours above, or open the one that matters now.</span></div>
        <div class="wrap ap-ml"><a class="chip cr ap-c44" href="#airports">${icon('current-location')}Airport for right now</a></div></div>`};
  }
  const auto = autoCode();
  const list = visitsOf(code);
  const v = curVisit(code, list);
  const g = guide(code);
  if (!g && !N.data.trip) {
    return {hero: heroHtml(code, v, list, auto),
      body: h`<div class="ap-pg"><div class="co plain">${icon('info-circle')}<span><b>Guide not loaded.</b> Open the app once with signal to put it on this phone.</span></div></div>`};
  }
  const seg = list.length > 1 ? h`<div class="seg ap-seg" role="group" aria-label="Which visit">${list.map(x => h`<button type="button" data-act="visit" data-arg="${x.key}" aria-pressed="${x === v ? 'true' : 'false'}">${roleWord(x.role)} ${dayOf(x, code).split(' ').slice(0, 2).join(' ')}</button>`)}</div>` : '';
  const cos = callouts(code, v);
  const arrive = v && v.role === 'arrive';
  // Build the sections first so a jump chip only appears when its section is on the page
  // (a chip with nothing to scroll to is a dead button), in the order they appear.
  const S = {steps: stepsHtml(code, v), map: mapHtml(code, v, qGate(ctx)), ground: groundHtml(code, v), sec: securityHtml(code, v),
    food: foodHtml(code, v), svc: servicesHtml(code), info: infoHtml(code, v)};
  const has = k => !!String(S[k] || '').trim();
  const order = arrive ? ['steps', 'map', 'ground', 'sec', 'food', 'svc', 'info'] : ['steps', 'map', 'sec', 'food', 'svc', 'ground', 'info'];
  const label = {steps: ['Steps', 'checklist'], map: ['Map', 'map-2'], sec: ['Security', 'shield-check'], food: ['Food', 'tools-kitchen-2'],
    ground: [!arrive ? 'Getting here' : code === 'LGA' ? 'Leaving' : 'Ground', 'route'], svc: ['Services', 'wifi'], info: ['Info', 'info-circle']};
  // With no guide every section below is an empty state, so say that once up top instead of a jump bar.
  const jumps = g ? order.filter(has) : [];
  const body = h`<div class="ap-pg">
    ${seg}
    ${tilesHtml(code, v)}
    ${cos.length ? h`<div class="stack8 ap-cos">${cos}</div>` : ''}
    ${flightsHtml(code, v)}
    ${!g ? h`<div class="co plain ap-ng">${icon('info-circle')}<span><b>No guide for ${code}.</b> Only flight and conditions data are shown.</span></div>` : ''}
    ${jumps.length > 1 ? h`<nav class="ap-jump" data-hscroll aria-label="Jump to">${jumps.map(id => h`<button type="button" class="ap-j" data-act="jump" data-arg="${id}">${icon(label[id][1])}${label[id][0]}</button>`)}</nav>` : ''}
    ${order.map(k => S[k])}
  </div>`;
  return {hero: heroHtml(code, v, list, auto), body};
}

// The jump bar pins under the top bar; the chip for the section under it is filled.
function mountJump(view) {
  const pg = view.querySelector('.ap-pg'), bar = pg && pg.querySelector('.ap-jump'), sc = document.getElementById('view');
  if (!bar || !sc) return () => {};
  const tb = sc.querySelector('.tb'), strip = document.getElementById('strip');
  const top = (tb ? tb.offsetHeight : 56) + (strip && strip.childElementCount ? strip.offsetHeight : 0);
  pg.style.setProperty('--ap-jt', `${top}px`);
  const chips = [...bar.querySelectorAll('.ap-j')], on = new Set();
  let cur = null, raf = 0;
  const mark = b => {
    if (b === cur) return;
    cur = b;
    chips.forEach(c => c === b ? c.setAttribute('aria-current', 'true') : c.removeAttribute('aria-current'));
    // Keep the filled chip in sight inside the bar.
    if (b && (b.offsetLeft < bar.scrollLeft + 20 || b.offsetLeft + b.offsetWidth > bar.scrollLeft + bar.clientWidth - 20)) {
      bar.scrollTo({left: Math.max(0, b.offsetLeft - 20), behavior: N.reduce ? 'auto' : 'smooth'});
    }
  };
  const line = () => top + bar.offsetHeight + 8;
  // A section counts once it reaches the line under the bar; between two sections the last one stays.
  const io = 'IntersectionObserver' in window ? new IntersectionObserver(es => {
    es.forEach(e => e.isIntersecting ? on.add(e.target.id) : on.delete(e.target.id));
    const b = chips.find(c => on.has('ap-' + c.dataset.arg));
    const first = document.getElementById('ap-' + (chips[0] && chips[0].dataset.arg));
    if (b) mark(b);
    else if (first && first.getBoundingClientRect().top > line()) mark(null);
  }, {root: sc, rootMargin: `-${line()}px 0px -55% 0px`}) : null;
  if (io) chips.forEach(c => { const t = document.getElementById('ap-' + c.dataset.arg); if (t) io.observe(t); });
  // A hairline under the bar only while it is pinned.
  const pin = () => { raf = 0; bar.classList.toggle('stuck', bar.getBoundingClientRect().top <= top + 0.5); };
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(pin); };
  sc.addEventListener('scroll', onScroll, {passive: true});
  pin();
  return () => { if (io) io.disconnect(); sc.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); };
}

let slide = null, slideT = 0;   // switch animation between two airports on the same screen
const sig = ctx => { const code = codeOf(ctx); const list = visitsOf(code); const v = curVisit(code, list); return `${code}|${v ? v.key : ''}|${v ? overV(v) : ''}|${autoCode()}`; };
function mount(ctx, view) {
  const code = codeOf(ctx);
  this._sig = sig(ctx);
  if (slide && performance.now() - slide.at < 1200 && !N.reduce) {
    const dir = slide.dir;
    [view.querySelector('.ap-top'), document.getElementById('body')].filter(Boolean).forEach((n, i) => {
      if (!n.animate) return;
      n.getAnimations().forEach(a => a.cancel());
      n.animate([{opacity: 0, transform: `translateX(${24 * dir}px)`}, {opacity: 1, transform: 'none'}], {duration: 380, delay: i * 40, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'backwards'});
    });
  }
  slide = null; clearTimeout(slideT);
  const fresh = !views[code], hash = ctx.hash, gq = qGate(ctx);
  ctl = mountMap(view, models[code], gq);
  const offJump = mountJump(view);
  // Opened from a gate link: bring the map up under the bar (after core resets the scroll).
  if (gq && fresh && ctl) requestAnimationFrame(() => { const a = document.getElementById('ap-map'); if (a) a.scrollIntoView({block: 'start'}); });
  return () => {
    offJump();
    if (ctl) { ctl.cleanup(); ctl = null; }
    // Leaving the page (not a refresh of it) drops the zoom, so the next visit opens at 1x.
    if (N.route().hash !== hash) delete views[code];
  };
}
function tick(ctx) {
  const s = sig(ctx);
  // Also repaint when the highlighted step changes: it comes due (shows Now),
  // or the step in progress ends and the marker moves on.
  const nx = document.querySelector('.ap-pg .ap-st.next[data-chg]');
  const chg = nx ? +nx.dataset.chg : NaN;
  const stepDue = Number.isFinite(chg) && nowMs() >= chg;
  if (this._sig && (s !== this._sig || stepDue) && !(ctl && ctl.busy())) { this._sig = s; N.rerender(); }
}
const actions = {
  ap(el, ev, ctx, arg) {
    const to = str(arg).toUpperCase(), from = codeOf(ctx);
    if (!/^[A-Z]{3}$/.test(to)) return;
    if (ctx.name === 'airport' && to === from) return;
    N.$$('.ap-ps button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.arg === lc(to))));
    const list = codes();
    const dir = list.indexOf(to) >= list.indexOf(from) ? 1 : -1;
    if (ctx.name !== 'airport' || N.reduce) { N.go('airport/' + lc(to), true); return; }
    const outs = [document.querySelector('.ap-top'), document.getElementById('body')].filter(n => n && n.animate);
    slide = {dir, at: performance.now()};
    // Safety: never leave the page faded out if the route does not change.
    clearTimeout(slideT);
    slideT = setTimeout(() => { outs.forEach(n => n.getAnimations().forEach(a => a.cancel())); slide = null; }, 900);
    Promise.all(outs.map(n => n.animate([{opacity: 1, transform: 'none'}, {opacity: 0, transform: `translateX(${-24 * dir}px)`}],
      {duration: 160, easing: 'ease-in', fill: 'forwards'}).finished.catch(() => {}))).then(() => N.go('airport/' + lc(to), true));
  },
  visit(el, ev, ctx, arg) {
    const code = codeOf(ctx);
    picked[code] = str(arg);
    N.rerender();
  },
  jump(el, ev, ctx, arg) {
    const t = document.getElementById('ap-' + str(arg));
    if (!t) return;
    const d = t.querySelector('details.ap-fold');
    if (d) d.open = true;
    t.scrollIntoView({behavior: N.reduce ? 'auto' : 'smooth', block: 'start'});
  },
  mapZoom(el, ev, ctx, arg) { if (ctl) ctl.zoom(+arg || 1); },
  mapReset() { if (ctl) ctl.reset(); },
  mapGate() { if (ctl) ctl.gate(); },
};

// 'force' is listed because core's rerender() checks `uses` before a forced repaint,
// so without it N.rerender() (visit switch, tick) would skip this screen.
const def = {nav: 2, tone: 'band', uses: ['trip', 'guide', 'status', 'force'], render, mount, tick, actions,
  title: ctx => `${codeOf(ctx)} airport`};
N.screen('airports', Object.assign({}, def));
N.screen('airport', Object.assign({}, def));
})();
