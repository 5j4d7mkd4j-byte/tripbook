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
const flightNo = l => l ? str(l.flight) || `${l.carrier || 'AA'}${l.num || ''}` : '';
const tzAbbr = (ap, iso) => {
  try {
    const p = new Intl.DateTimeFormat('en-US', {timeZone: N.tz(ap), timeZoneName: 'short'}).formatToParts(iso ? new Date(iso) : N.now());
    const z = (p.find(x => x.type === 'timeZoneName') || {}).value || '';
    return /^(GMT|UTC)/.test(z) ? '' : z;
  } catch (e) { return ''; }
};
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
const clockTxt = m => { m = ((m % 1440) + 1440) % 1440; const hh = Math.floor(m / 60), mm = m % 60; return `${hh % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''}${hh < 12 ? 'a' : 'p'}`; };
// When you go through security on a departure: the guide step, else 90 min before.
function secTime(code, v) {
  if (!v || v.role !== 'depart' || !okT(v.out.dep.time)) return null;
  const st = arr(obj(guide(code) && guide(code).steps) ? guide(code).steps.depart : null).filter(obj);
  const s = st.find(x => x.icon === 'shield-check' || /security|checkpoint|tsa/i.test(str(x.title)));
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
  let l1 = '', l2 = '';
  if (v && v.role === 'depart') {
    const l = v.out;
    l1 = okT(l.dep.time) ? `${flightNo(l)} to ${apCity(l.to)}, ${tmz(l.dep.time, code)}` : `${flightNo(l)} to ${apCity(l.to)}, time not confirmed`;
  } else if (v && v.role === 'connect') {
    l1 = okT(v.inn.arr.time) && okT(v.out.dep.time)
      ? `${N.dur(N.mins(v.inn.arr.time, v.out.dep.time))} between ${flightNo(v.inn)} and ${flightNo(v.out)}`
      : `${flightNo(v.inn)} in, ${flightNo(v.out)} out, times not confirmed`;
  } else if (v) {
    const l = v.inn;
    l1 = okT(l.arr.time) ? `${flightNo(l)} from ${apCity(l.from)}, lands ${tmz(l.arr.time, code)}` : `${flightNo(l)} from ${apCity(l.from)}, time not confirmed`;
  } else l1 = 'Not on your trip';
  l2 = v ? `${roleWord(v.role)} ${dayOf(v, code)}` : '';
  return h`<div class="ap-hero">
    <div class="ps ap-ps" role="group" aria-label="Airport">${codes().map(c => h`<button type="button" data-act="ap" data-arg="${lc(c)}" aria-pressed="${c === code ? 'true' : 'false'}">${c}${c === auto ? h`<i class="ap-nd" aria-hidden="true"></i><span class="ap-vh">, now</span>` : ''}</button>`)}</div>
    <div class="ap-top">
      <div class="ey ap-ey">${apName(code)}${tl ? ` · ${tl}` : ''}</div>
      <div class="dp ap-code" aria-label="${code}">${code}</div>
      <p class="ap-sub"><b data-k="ap-h1">${l1}</b>${l2 ? h`<span>${l2} · local time <span class="tn" data-clock="${code}">${N.time(N.now(), code)}</span></span>` : h`<span>Local time <span class="tn" data-clock="${code}">${N.time(N.now(), code)}</span></span>`}</p>
    </div>
    ${illo(code)}
  </div>`;
}

// ---------- tiles ----------
function tilesHtml(code, v) {
  const L = live(code), faa = obj(L.faa), tsa = obj(L.tsa) || {}, g = guide(code);
  const wx = wxFor(code, v);
  const wxT = wx
    ? {b: `${Math.round(+wx.temp)}°`, s: `${shortWx(wx.text) || 'Forecast'}${wx.fc ? ` at ${ct(wx.at, code)}` : ' now'}`, w: /storm|snow|ice|sleet/i.test(str(wx.text)) || +wx.precip >= 60}
    : {b: '—', s: 'No recent reading'};
  const fs = faa && lc(faa.status);
  const faaT = !faa || !fs ? {b: '—', s: 'Not checked'}
    : fs === 'normal' ? {b: 'Normal', s: 'No delays'}
    : fs === 'ground_stop' || fs === 'ground stop' ? {b: 'Ground stop', s: faa.reason ? str(faa.reason) : 'Flights held', w: true}
    : fs === 'closed' ? {b: 'Closed', s: str(faa.reason) || 'Airport closed', w: true}
    : /delay/.test(fs) ? {b: 'Delays', s: faa.avg_min ? `Avg ${faa.avg_min} min` : str(faa.reason) || 'Reported', w: true}
    : {b: str(faa.status).replace(/_/g, ' '), s: str(faa.text) || ''};
  let third;
  if (v && v.role === 'connect') third = {l: 'Security', b: 'None', s: 'Stay airside'};
  else if (v && v.role === 'arrive') {
    const bag = v.inn.arr.baggage;
    third = bag ? {l: 'Bag claim', b: `Belt ${bag}`, s: flightNo(v.inn)} : {l: 'Bag claim', b: '—', s: 'After landing'};
  } else if (tsa.wait_min != null && Number.isFinite(+tsa.wait_min)) {
    third = {l: 'TSA wait', b: `${Math.round(+tsa.wait_min)} min`, s: str(tsa.text) || 'Standard lane', w: +tsa.wait_min >= 30};
  } else {
    const ck = arr(g && g.security).filter(obj)[0];
    const at = secTime(code, v);
    if (!ck) third = {l: 'Security', b: '—', s: 'Not in the guide'};
    else {
      const r = hoursRange(ck.hours);
      const m = at ? localMin(at, code) : localMin(N.now().toISOString(), code);
      const o = openAt(r, m);
      const nm = str(ck.name).replace(/^Checkpoint\s+/i, '') || 'Main';
      third = {l: at ? `TSA at ${ct(at, code)}` : 'Security now',
        b: o == null ? '—' : o ? 'Open' : r && !r.all ? `Opens ${clockTxt(r.a)}` : 'Closed',
        s: o == null ? 'Hours not listed' : r && r.all ? `${str(ck.name) || nm}, 24h` : str(ck.name) || nm, w: o === false};
    }
  }
  const cell = (k, label, t) => h`<div class="${t.w ? 'w' : ''}"><small>${label}</small><b data-k="${k}">${t.b}</b><span>${t.s}</span></div>`;
  const chk = [faa && okT(faa.updated) ? `FAA ${when(faa.updated, code)}` : '', wx && okT(wx.updated) ? `weather ${when(wx.updated, code)}` : '', okT(tsa.updated) ? `TSA ${when(tsa.updated, code)}` : ''].filter(Boolean);
  return h`<div class="cn ap-cn">${cell('ap-wx', 'Weather', wxT)}${cell('ap-faa', 'FAA', faaT)}${cell('ap-3', third.l, third)}</div>
    <p class="ap-chk">${chk.length ? `Checked: ${chk.join(' · ')}` : 'Conditions not checked yet'}</p>`;
}

// ---------- callouts ----------
function callouts(code, v) {
  const L = live(code), faa = obj(L.faa), wx = obj(L.wx) || {}, g = guide(code);
  const out = [];
  const co = (tone, ic2, body) => out.push(h`<div class="co ${tone}">${icon(ic2)}<span>${body}</span></div>`);
  const fs = faa && lc(faa.status);
  if (fs && /ground/.test(fs)) co('rose', 'alert-triangle', `FAA ground stop at ${code}${faa.reason ? ` (${faa.reason})` : ''}. Flights here are being held.`);
  else if (fs && /delay/.test(fs)) co('rose', 'clock', `FAA reports delays at ${code}${faa.avg_min ? `, averaging ${faa.avg_min} min` : ''}${faa.reason ? ` (${faa.reason})` : ''}.`);
  else if (fs === 'closed') co('rose', 'alert-triangle', `FAA lists ${code} as closed${faa.reason ? ` (${faa.reason})` : ''}.`);
  arr(wx.alerts).slice(0, 2).forEach(a => {
    const t = typeof a === 'string' ? a : obj(a) ? str(a.event || a.headline || a.title) : '';
    const ends = obj(a) && okT(a.ends) ? ` until ${when(a.ends, code)}` : '';
    if (t) co('rose', 'alert-triangle', `${t}${ends}.`);
  });
  const legs = v ? [v.inn, v.out].filter(Boolean) : [];
  legs.forEach(l => {
    if (l.canceled) co('rose', 'alert-triangle', h`${flightNo(l)} is canceled. Rebook in the AA app or at an AA counter. <a class="ap-il2" href="${AA_PHONE}" target="_blank" rel="noopener">Call AA</a>`);
    else if (l.diverted) co('rose', 'alert-triangle', `${flightNo(l)} diverted to ${l.diverted}. Follow the AA app for the new plan.`);
    else if (l.route_ok === false) co('rose', 'alert-circle', `The flight data for ${flightNo(l)} doesn't match this route. Check the AA app.`);
  });
  if (v && v.role === 'connect') {
    let c = null; try { c = N.connection(v.dir); } catch (e) { c = null; }
    if (c && c.level !== 'ok' && !v.inn.canceled && !v.out.canceled) {
      co('rose', 'hourglass', `${c.text} connection: about ${Math.max(0, c.free)} min spare before boarding after the walk. Go straight to ${v.out.dep.gate ? `gate ${v.out.dep.gate}` : 'the next gate'}, then eat.`);
    }
  }
  legs.forEach(l => {
    if (!l.canceled && l.delay_dep > 14 && (v.role !== 'arrive' || l === v.out)) co('', 'clock', `${flightNo(l)} is delayed ${N.dur(l.delay_dep)}; now departs ${tmz(l.dep.time, l.from)}.`);
    else if (!l.canceled && v.role === 'arrive' && l.delay_arr > 14) co('', 'clock', `${flightNo(l)} is running ${N.dur(l.delay_arr)} late; now lands ${tmz(l.arr.time, code)}.`);
  });
  const summ = g && str(g.summary);
  if (summ && !(v && v.dir === 'ret' && v.role === 'connect') && !(v && v.dir === 'ret' && v.role === 'arrive')) co('', 'info-circle', summ);
  if (v && v.role !== 'arrive' && !v.out.canceled && !overV(v) && !v.out.dep.gate) co('plain', 'map-pin', `AA hasn't posted the ${flightNo(v.out)} gate yet. It shows here and on the map once it does.`);
  if (v && v.dir === 'ret' && !okT(v.at)) co('plain', 'calendar', 'Return times aren’t confirmed yet. Step times fill in once they are.');
  return out;
}
// Guide caveats, minus the ones the data has already answered.
function caveats(code, v) {
  const g = guide(code);
  const gatesKnown = v && (v.role === 'arrive' ? !!v.inn.arr.gate : !!v.out.dep.gate && (!v.inn || !!v.inn.arr.gate));
  const retKnown = legsOf('ret').length > 0 && legsOf('ret').every(l => okT(l.dep.time));
  return arr(g && g.caveats).map(str).filter(Boolean).filter(c =>
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
    const bits = [okT(t) ? `${inbound ? 'Lands' : 'Departs'} ${tmz(t, code)}` : 'Time not confirmed',
      gate ? `Gate ${gate}` : 'Gate not posted', term ? termLabel(term) : '', inbound && l.arr.baggage ? `Bags belt ${l.arr.baggage}` : ''].filter(Boolean);
    const seats = arr(l.seats).filter(Boolean);
    const chip = st.tone === 'bad' ? 'rose' : st.tone === 'warn' ? 'warn' : 'cr';
    return h`<a class="ap-fl" href="#flight/${l.id}">
      <span class="ic">${icon(inbound ? 'plane-arrival' : 'plane-departure')}</span>
      <div class="grow"><b>${flightNo(l)} ${inbound ? `from ${apCity(l.from)}` : `to ${apCity(l.to)}`}</b>
        <small class="tn">${bits.join(' · ')}</small>
        ${seats.length ? h`<small class="tn">Seats ${seats.join(', ')}</small>` : ''}</div>
      <span class="chip ${chip} ap-fc" data-k="ap-st-${l.id}">${st.text}</span></a>`;
  };
  if (v.inn) rows.push(row(v.inn, true));
  if (v.out) rows.push(row(v.out, false));
  return h`<div class="sec"><div class="ey">Your flights here</div><div class="stack8">${rows}</div></div>`;
}

// ---------- steps ----------
function stepsHtml(code, v) {
  const g = guide(code);
  const title = !v ? 'Steps' : v.role === 'depart' ? `Leaving from ${code}` : v.role === 'connect' ? `Connecting at ${code}` : `Arriving at ${code}`;
  const head = h`<div class="ey">${title}</div>`;
  if (!v) return h`<section class="sec ap-anc" id="ap-steps">${head}<div class="co plain">${icon('info-circle')}<span>${code} isn’t on your trip, so there are no timed steps here.</span></div></section>`;
  let steps = arr(obj(g && g.steps) ? g.steps[v.role] : null).filter(obj);
  if (!steps.length) {
    const msg = v.role === 'arrive' ? `No arrival steps saved for ${code}. Ground options are below.` : `No ${v.role === 'connect' ? 'connection' : 'departure'} steps saved for ${code} yet.`;
    return h`<section class="sec ap-anc" id="ap-steps">${head}<div class="co plain">${icon('info-circle')}<span>${msg}</span></div></section>`;
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
  const sub = s => swap.reduce((a, [x, y]) => a.split(x).join(y), str(s));
  const hasClock = s => /\b\d{1,2}(:\d{2})?\s?[ap]\b|\b\d{1,2}\/\d{1,2}\b/i.test(str(s));
  const w = N.wallet ? N.wallet() : {};
  const bags = Number.isFinite(+w.bags) ? +w.bags : 0;
  const over = overV(v);
  const rows = steps.map(s => {
    const rel = obj(s.rel);
    let at = null;
    if (rel && Number.isFinite(+rel.min)) {
      const base = rel.to === 'arr' ? v.inn && v.inn.arr.time : v.out && v.out.dep.time;
      at = okT(base) ? N.addMin(base, +rel.min) : null;
    }
    const extra = [];
    if (s.icon === 'car' && v.role === 'depart' && rel) {
      let lv = null; try { lv = N.leave(v.dir); } catch (e) { lv = null; }
      if (lv && okT(lv.at)) {
        at = lv.at;
        if (lv.source === 'traffic') extra.push(`Uses the latest traffic: about ${lv.drive} min drive`);
        if (lv.buffer) extra.push(`Includes your ${lv.buffer} min buffer`);
      }
    }
    if (s.icon === 'luggage' && v.role === 'depart' && v.out && okT(v.out.dep.time)) {
      extra.push(`Bag drop closes ${tmz(N.addMin(v.out.dep.time, -N.AA.bagdrop), code)}${bags > 0 ? ` · ${N.plural(bags, 'checked bag')} in Wallet` : ''}`);
    }
    if (s.icon === 'luggage' && v.role === 'arrive' && v.inn.arr.baggage) extra.push(`Belt ${v.inn.arr.baggage}`);
    if (s.icon === 'plane-departure' && v.out && v.out.dep.gate) extra.push(`Gate ${v.out.dep.gate}`);
    const detail = reused && hasClock(s.detail) ? '' : sub(s.detail);
    return {s, at, title: sub(s.title) || 'Step', detail, extra, min: +s.min || 0};
  });
  const now = nowMs();
  const nextI = over ? -1 : rows.findIndex(r => okT(r.at) && T(r.at) > now);
  const lastTimed = rows.reduce((a, r, i) => okT(r.at) ? i : a, -1);
  const html = rows.map((r, i) => {
    const done = okT(r.at) && (over || (nextI < 0 ? i <= lastTimed && T(r.at) <= now : i < nextI));
    const next = i === nextI;
    const warn = r.s.icon === 'alert-triangle';
    return h`<li class="${N.cls('ap-st', done && 'done', next && 'next', warn && 'wn')}">
      <div class="ap-tm tn">${okT(r.at) ? N.time(r.at, code) : r.s.rel ? '—' : ''}</div>
      <div class="ap-sd"><span class="ap-si">${done ? icon('check') : ic(r.s.icon, 'point')}</span></div>
      <div class="ap-sb"><b>${r.title}</b>
        ${next ? h`<span class="ap-in">in <span data-until="${r.at}">${N.until(r.at)}</span></span>` : ''}
        ${r.detail ? h`<small>${r.detail}</small>` : ''}
        ${r.extra.map(x => h`<small class="ap-x">${x}</small>`)}
        ${r.min && !done ? h`<small class="ap-mn">${icon('clock')}About ${N.dur(r.min)}</small>` : ''}</div>
    </li>`;
  });
  const notes = [];
  if (reused) notes.push(h`<p class="ap-note">These steps were written for the outbound connection. Times use your ${v.dir === 'ret' ? 'return' : ''} flights.</p>`);
  if (!okT(v.at)) notes.push(h`<p class="ap-note">Times show once ${flightNo(v.leg)} is confirmed.</p>`);
  return h`<section class="sec ap-anc" id="ap-steps">${head}${notes}<ol class="ap-steps">${html}</ol></section>`;
}

// ---------- terminal map ----------
const normG = g => str(g).toUpperCase().replace(/\bGATE\b/g, '').replace(/\s+/g, '').replace(/^([A-Z]*)0+(\d)/, '$1$2');
function mapPoints(map) {
  const P = obj(map.points) || {};
  return Object.keys(P).map(id => obj(P[id]) && Number.isFinite(+P[id].x) && Number.isFinite(+P[id].y)
    ? {id, x: +P[id].x, y: +P[id].y, label: str(P[id].label) || id, kind: lc(P[id].kind) || 'poi'} : null).filter(Boolean);
}
function findGate(pts, gate) {
  if (!gate) return null;
  const want = normG(gate);
  if (!want) return null;
  const gates = pts.filter(p => p.kind === 'gate');
  const hit = gates.find(p => normG(p.id) === want || normG(p.label) === want) || pts.find(p => normG(p.id) === want);
  if (hit) return Object.assign({}, hit, {exact: true});
  const m = want.match(/^([A-Z]*)(\d+)/);
  if (!m) return null;
  let best = null, bd = 1e9;
  for (const p of gates) {
    const q = normG(p.label || p.id).match(/^([A-Z]*)(\d+)/);
    if (!q || q[1] !== m[1]) continue;
    const d = Math.abs(+q[2] - +m[2]);
    if (d < bd) { bd = d; best = p; }
  }
  return best && bd <= 6 ? Object.assign({}, best, {exact: false}) : null;
}
// Corridor graph from the map's .m-wall centre lines.
const graphs = {};
function wallGraph(code, svg) {
  if (graphs[code] && graphs[code].svg === svg) return graphs[code].g;
  const nodes = new Map();
  const node = (x, y) => { const k = `${Math.round(x * 10)},${Math.round(y * 10)}`; let n = nodes.get(k); if (!n) { n = {x, y, adj: []}; nodes.set(k, n); } return n; };
  const ds = new Set();
  for (const m of str(svg).matchAll(/<path\b[^>]*\bclass="[^"]*\bm-wall\b[^"]*"[^>]*>/g)) { const d = (m[0].match(/\sd="([^"]*)"/) || [])[1]; if (d) ds.add(d); }
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
const KIND_IC = {security: 'shield-check', hub: 'circle-dot', baggage: 'luggage', taxi: 'car', bus: 'bus', train: 'train', lounge: 'armchair-2',
  food: 'tools-kitchen-2', restroom: 'toilet-paper', parking: 'parking', info: 'info-circle', elevator: 'elevator', stairs: 'stairs', checkin: 'ticket'};
// Everything the map needs for one airport and visit; kept for mount().
const models = {};
function mapModel(code, v) {
  const g = guide(code), map = obj(g && g.map);
  if (!map || !str(map.svg)) return null;
  const vb = str(map.viewBox).trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || vb.some(x => !Number.isFinite(x)) || vb[2] <= 0 || vb[3] <= 0) return null;
  const pts = mapPoints(map);
  const graph = wallGraph(code, map.svg);
  const you = [], used = new Set();
  let route = null, gateLabel = '', gateMissing = false;
  const pin = (p, label, tone) => { if (p) { you.push({x: p.x, y: p.y, label, tone, id: p.id}); used.add(p.id); } };
  const gname = (p, raw2) => p.exact ? str(raw2).toUpperCase() : `Near ${str(raw2).toUpperCase()}`;
  const hub = pts.find(p => p.kind === 'hub');
  if (v && v.role === 'depart') {
    const gp = findGate(pts, v.out.dep.gate);
    const secs = pts.filter(p => p.kind === 'security');
    const pref = arr(g.security).filter(obj).map(s => lc(s.name));
    let sec = null;
    if (gp) {
      const named = secs.find(p => pref[0] && lc(p.label) === pref[0]);
      sec = named || secs.slice().sort((a, b) => Math.hypot(a.x - gp.x, a.y - gp.y) - Math.hypot(b.x - gp.x, b.y - gp.y))[0] || null;
      pin(gp, `${gname(gp, v.out.dep.gate)} · Your gate`, 'you');
      if (sec) { pin(sec, `${sec.label} · Security`, 'via'); route = routeThrough(graph, sec, gp); }
      gateLabel = `Gate ${str(v.out.dep.gate).toUpperCase()}`;
    } else gateMissing = !v.out.dep.gate;
  } else if (v && v.role === 'connect') {
    const a = findGate(pts, v.inn.arr.gate), b = findGate(pts, v.out.dep.gate);
    if (a) pin(a, `${gname(a, v.inn.arr.gate)} · You land`, 'via');
    if (b) pin(b, `${gname(b, v.out.dep.gate)} · Next flight`, 'you');
    if (a && b) route = routeThrough(graph, a, b);
    else if (b && hub) route = routeThrough(graph, hub, b);
    else if (a && hub) route = routeThrough(graph, a, hub);
    gateLabel = b ? `Gate ${str(v.out.dep.gate).toUpperCase()}` : a ? `Gate ${str(v.inn.arr.gate).toUpperCase()}` : '';
    gateMissing = !b && !v.out.dep.gate;
  } else if (v && v.role === 'arrive') {
    const a = findGate(pts, v.inn.arr.gate);
    const bag = v.inn.arr.baggage;
    const claims = pts.filter(p => p.kind === 'baggage');
    let c = bag ? claims.find(p => normG(p.label).replace(/^CLAIM/, '') === normG(bag) || lc(p.id) === `claim-${lc(bag)}`) : null;
    if (a) {
      pin(a, `${gname(a, v.inn.arr.gate)} · You land`, 'you');
      gateLabel = `Gate ${str(v.inn.arr.gate).toUpperCase()}`;
      const to = c || claims.slice().sort((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y))[0];
      if (to) route = routeThrough(graph, a, to);
    } else gateMissing = !v.inn.arr.gate;
    if (c) pin(c, `${c.label} · Your bags`, 'via');
  }
  // Other places worth a bubble, most useful first.
  const PRI = {security: 2, hub: 2, baggage: 2, taxi: 2, bus: 2, train: 2, lounge: 3, checkin: 2, restroom: 4, food: 4};
  const poi = pts.filter(p => p.kind !== 'gate' && !used.has(p.id) && KIND_IC[p.kind]).map(p => ({x: p.x, y: p.y, label: p.label, kind: p.kind,
    pri: PRI[p.kind] || 3, minS: (PRI[p.kind] || 3) >= 4 ? 1.7 : 1, labelS: (PRI[p.kind] || 3) >= 4 ? 3 : 2.2}))
    .sort((a, b) => a.pri - b.pri);
  const gates = pts.filter(p => p.kind === 'gate' && !used.has(p.id)).map(p => ({x: p.x, y: p.y, label: p.label}));
  let focus = null;
  const fp = route || you.map(p => [p.x, p.y]);
  if (fp.length) {
    const xs = fp.map(p => p[0]), ys = fp.map(p => p[1]);
    focus = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  const m = {code, vb, svg: str(map.svg), you, poi, gates, route, focus, gateLabel, gateMissing, pts,
    notes: arr(map.notes).map(str).filter(Boolean), source: map.source};
  models[code] = m;
  return m;
}
function mapHtml(code, v) {
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
  const sub = m.gateLabel ? `${m.gateLabel}${v && v.role === 'connect' && m.you.length > 1 ? ' and your arrival gate' : ''} marked` : m.gateMissing ? 'Your gate shows here once AA posts it' : '';
  const kinds = new Set(m.poi.map(p => p.kind));
  const key = [
    m.you.length ? h`<span><i class="ap-k you"></i>${v && v.role === 'arrive' ? 'Arrival gate' : 'Your gate'}</span>` : '',
    m.route ? h`<span><i class="ap-k rt"></i>Walk</span>` : '',
    h`<span><i class="ap-k gt"></i>Gates</span>`,
    kinds.has('security') || m.you.some(p => /Security/.test(p.label)) ? h`<span><i class="ap-k sc"></i>Security</span>` : '',
    kinds.has('food') ? h`<span><i class="ap-k fd"></i>Food</span>` : '',
  ];
  return h`<section class="sec ap-anc" id="ap-map">
    <div class="ap-sh"><div class="ey">Terminal map</div>${sub ? h`<span class="ap-shs">${sub}</span>` : ''}</div>
    <div class="ap-mv${m.route ? ' has-rt' : ''}" data-hscroll tabindex="0" role="img" aria-label="${`Terminal map of ${code}${m.gateLabel ? `, ${m.gateLabel} marked` : ''}. Pinch, double-tap or use the buttons below to zoom.`}" style="aspect-ratio:${w} / ${hh}">
      <svg class="ap-svg" viewBox="${`${x} ${y} ${w} ${hh}`}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${raw(m.svg)}${d ? raw(`<g class="ap-ov"><path class="ap-rc" d="${d}"/><path class="ap-rt" d="${d}"/></g>`) : ''}</svg>
      <div class="ap-pins" aria-hidden="true"></div>
    </div>
    <div class="ap-tools">
      ${m.gateLabel ? h`<button type="button" class="ap-tb ap-gt" data-act="mapGate">${icon('focus-2')}<span>${m.gateLabel}</span></button>` : ''}
      <span class="grow"></span>
      <button type="button" class="ap-tb ap-z" data-act="mapZoom" data-arg="-1" aria-label="Zoom out">${icon('minus')}</button>
      <button type="button" class="ap-tb ap-z" data-act="mapZoom" data-arg="1" aria-label="Zoom in">${icon('plus')}</button>
      <button type="button" class="ap-tb ap-z" data-act="mapReset" aria-label="Show the whole map">${icon('zoom-reset')}</button>
    </div>
    <p class="ap-cap" aria-live="polite">Pinch, drag or double-tap to zoom. Tap a dot to name it.</p>
    <div class="ap-key" aria-hidden="true">${key}</div>
    ${m.notes.length ? h`<ul class="ap-notes">${m.notes.map(n => h`<li>${n}</li>`)}</ul>` : ''}
    <p class="ap-src">${icon('info-circle')}<span>${src ? `Source: ${src}. ` : ''}Schematic, not to scale. Positions are approximate; follow the airport signs.</span></p>
    ${offLink ? h`<div class="wrap ap-ml">${offLink}</div>` : ''}
  </section>`;
}

// Live map controller for the mounted screen (zoom buttons call into it).
const views = {};   // code → {s, cx, cy}, kept in memory so a refresh keeps your zoom
let ctl = null;
const MAXS = 6;
function mountMap(root, m) {
  const mv = root.querySelector('.ap-mv');
  if (!mv || !m) return null;
  const svg = mv.querySelector('svg.ap-svg'), layer = mv.querySelector('.ap-pins'), cap = root.querySelector('.ap-cap');
  const btnIn = root.querySelector('[data-act="mapZoom"][data-arg="1"]'), btnOut = root.querySelector('[data-act="mapZoom"][data-arg="-1"]');
  const [VX, VY, VW, VH] = m.vb;
  let W = mv.clientWidth || 1, H = mv.clientHeight || 1;
  const st = views[m.code] || (views[m.code] = {s: 1, cx: VX + VW / 2, cy: VY + VH / 2});
  const k0 = () => Math.min(W / VW, H / VH);
  const clampSt = (s, cx, cy) => {
    s = N.clamp(s, 1, MAXS);
    const k = k0() * s, vw = W / k, vh = H / k, mg = 24 / k;
    const fit = (c, vis, lo, len) => vis >= len + 2 * mg ? lo + len / 2 : N.clamp(c, lo - mg + vis / 2, lo + len + mg - vis / 2);
    return {s, cx: fit(cx, vw, VX, VW), cy: fit(cy, vh, VY, VH)};
  };
  Object.assign(st, clampSt(st.s, st.cx, st.cy));

  // Pins: your gate(s) always, then labelled places, then gate numbers when zoomed in.
  const pins = [
    ...m.you.map(p => Object.assign({}, p, {type: 'you', pri: 0, minS: 1, labelS: 1, c: 10})),
    ...m.poi.map(p => Object.assign({}, p, {type: 'poi', c: 13})),
    ...m.gates.map(p => Object.assign({}, p, {type: 'gn', pri: 5, minS: 2.2, labelS: 1, c: 0})),
  ];
  layer.innerHTML = String(h`${pins.map(p => p.type === 'you'
    ? h`<div class="ap-pin ap-you ${p.tone}"><div class="ap-pi"><span class="ap-dot"></span><span class="ap-pl">${p.label}</span></div></div>`
    : p.type === 'poi'
      ? h`<div class="ap-pin ap-poi k-${p.kind}"><div class="ap-pi"><span class="ap-pb">${icon(KIND_IC[p.kind] || 'point')}</span><span class="ap-pl">${p.label}</span></div></div>`
      : h`<div class="ap-pin ap-gn"><div class="ap-pi">${p.label}</div></div>`)}`);
  [...layer.children].forEach((el, i) => { pins[i].el = el; pins[i].in = el.firstElementChild; pins[i].shown = true; pins[i].lab = null; });
  // Measure each pin once with and without its label.
  pins.forEach(p => {
    p.el.classList.add('lb'); p.wl = p.in.offsetWidth; p.hh = p.in.offsetHeight || 26;
    p.el.classList.remove('lb'); p.w0 = p.type === 'poi' ? 26 : p.in.offsetWidth;
    if (p.type === 'you') p.el.classList.add('lb');
  });

  const place = (k, x0, y0) => {
    const boxes = [];
    for (const p of pins) {
      const x = (p.x - x0) * k, y = (p.y - y0) * k;
      let show = st.s >= p.minS - 1e-6 && x > -30 && y > -30 && x < W + 30 && y < H + 30;
      const lab = p.type === 'you' || p.type === 'gn' || st.s >= p.labelS;
      const w = lab ? p.wl : p.w0, hh = p.hh;
      let flip = false, box;
      if (p.type === 'gn') box = [x - w / 2, y - hh / 2, x + w / 2, y + hh / 2];
      else {
        flip = lab && x - p.c + w > W - 6 && x + p.c - w > 6;
        box = flip ? [x + p.c - w, y - hh / 2, x + p.c, y + hh / 2] : [x - p.c, y - hh / 2, x - p.c + w, y + hh / 2];
      }
      if (show && p.type !== 'you') {
        const pad = 3;
        if (boxes.some(b => box[0] < b[2] + pad && box[2] + pad > b[0] && box[1] < b[3] + pad && box[3] + pad > b[1])) show = false;
      }
      if (show) boxes.push(box);
      if (show !== p.shown) { p.el.style.display = show ? '' : 'none'; p.shown = show; }
      if (!show) continue;
      p.el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
      if (p.type === 'poi' && lab !== p.lab) { p.el.classList.toggle('lb', lab); p.lab = lab; }
      if (flip !== p.flip) { p.el.classList.toggle('fl', flip); p.flip = flip; }
    }
  };
  const apply = () => {
    const k = k0() * st.s, vw = W / k, vh = H / k, x0 = st.cx - vw / 2, y0 = st.cy - vh / 2;
    svg.setAttribute('viewBox', `${x0.toFixed(2)} ${y0.toFixed(2)} ${vw.toFixed(2)} ${vh.toFixed(2)}`);
    const z = st.s > 1.01;
    mv.classList.toggle('zoomed', z);
    mv.style.touchAction = z ? 'none' : 'pan-y';
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

  const say = t => { if (cap) cap.textContent = t; };
  const pick = p => {
    const k = k0() * st.s, a = toMap(p);
    let best = null, bd = 22 / k;
    for (const q of m.pts) { const d = Math.hypot(q.x - a.x, q.y - a.y); if (d < bd) { bd = d; best = q; } }
    if (!best) { say(st.s > 1.01 ? 'Drag to move. Double-tap to zoom more.' : 'Pinch, drag or double-tap to zoom. Tap a dot to name it.'); return; }
    const kind = best.kind === 'gate' ? 'Gate' : best.kind === 'security' ? 'Security' : best.kind === 'baggage' ? 'Bag claim' : best.kind === 'food' ? 'Food' : best.kind === 'restroom' ? '' : best.kind === 'lounge' ? 'Lounge' : '';
    say(best.kind === 'gate' ? `Gate ${best.label}` : kind && !best.label.includes(kind) ? `${best.label} · ${kind}` : best.label);
  };

  // Pointer gestures: one finger pans when zoomed, two fingers pinch, double-tap zooms.
  const pts = new Map();
  let gst = null, lastTap = null, tapT = 0, gs = null;
  const begin = () => {
    const a = [...pts.values()];
    if (a.length >= 2) {
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
    if (pts.size) begin(); else gst = null;
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
  const onGE = e => { e.preventDefault(); gs = null; };
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
      if (w && hh && (w !== W || hh !== H)) { W = w; H = hh; Object.assign(st, clampSt(st.s, st.cx, st.cy)); apply(); }
    });
    ro.observe(mv);
  }
  apply();

  const api = {
    busy: () => pts.size > 0 || !!raf,
    zoom: dir => { const s = dir > 0 ? st.s * 1.8 : st.s / 1.8; animTo(s, st.cx, st.cy); },
    reset: () => { animTo(1, VX + VW / 2, VY + VH / 2); say('Pinch, drag or double-tap to zoom. Tap a dot to name it.'); },
    gate: () => {
      if (!m.focus) return;
      const [x0, y0, x1, y1] = m.focus, pad = 26;
      const bw = Math.max(40, x1 - x0 + pad * 2), bh = Math.max(40, y1 - y0 + pad * 2);
      const s = N.clamp(Math.min(W / (bw * k0()), H / (bh * k0())), 1.5, 4);
      animTo(s, (x0 + x1) / 2, (y0 + y1) / 2);
      say(m.you.map(p => p.label).join(' → ') || m.gateLabel);
    },
    cleanup: () => {
      stop(); clearTimeout(tapT);
      on.forEach(([t, f, o]) => mv.removeEventListener(t, f, o || false));
      if (ro) ro.disconnect();
    },
  };
  return api;
}

// ---------- lower sections ----------
function securityHtml(code, v) {
  const g = guide(code);
  const list = arr(g && g.security).filter(obj);
  const at = secTime(code, v);
  const m = at ? localMin(at, code) : null;
  const head = h`<div class="ey">Security</div>`;
  const note = v && v.role === 'connect' ? h`<p class="ap-note">No security on your connection: you stay airside the whole time.</p>`
    : v && v.role === 'arrive' ? h`<p class="ap-note">You won’t go through security on arrival. These are for leaving from ${code}.</p>` : '';
  if (!list.length) return h`<section class="sec ap-anc" id="ap-sec">${head}${note}<div class="co plain">${icon('info-circle')}<span>No checkpoint details saved for ${code}.</span></div></section>`;
  const rows = list.map(s => {
    const r = hoursRange(s.hours);
    const o = m == null ? null : openAt(r, m);
    const state = o == null ? '' : o ? h`<span class="chip cr ap-ok">${icon('circle-check')}Open at ${N.time(at, code)}</span>`
      : h`<span class="chip warn">${icon('clock')}${r && !r.all ? `Opens ${clockTxt(r.a)}` : 'Closed then'}</span>`;
    const fact = (label, val) => val ? h`<div><dt>${label}</dt><dd>${val}</dd></div>` : '';
    return h`<div class="ap-ck">
      <div class="rw"><span class="ic">${icon('shield-check')}</span><div class="grow"><b>${str(s.name) || 'Checkpoint'}</b>${s.where ? h`<small>${s.where}</small>` : ''}</div></div>
      ${state ? h`<div class="ap-cks">${state}</div>` : ''}
      <dl class="ap-dl">${fact('Hours', str(s.hours) || 'Not listed')}${fact('PreCheck', str(s.precheck))}${fact('CLEAR', str(s.clear))}</dl>
      ${s.note ? h`<p class="ap-cn2">${s.note}</p>` : ''}
    </div>`;
  });
  return h`<section class="sec ap-anc" id="ap-sec">${head}${note}<div class="stack8">${rows}</div></section>`;
}

function foodHtml(code, v) {
  const g = guide(code);
  const list = arr(g && g.food).filter(obj);
  const head = h`<div class="ey">Food and coffee</div>`;
  if (!list.length) return h`<section class="sec ap-anc" id="ap-food">${head}<div class="co plain">${icon('info-circle')}<span>No food listed for ${code} yet.</span></div></section>`;
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
  const items = list.map((f, i) => ({f, i, land: land(f), sc: score(f)}));
  const air = items.filter(x => !x.land).sort((a, b) => a.sc - b.sc || a.i - b.i);
  const pre = items.filter(x => x.land);
  const row = x => {
    const f = x.f, near = gm && x.sc <= 4;
    const kind = /coffee|caf|espresso|tea\b|starbucks|peet|dunkin/i.test(`${str(f.kind)} ${str(f.name)}`) ? 'coffee' : 'tools-kitchen-2';
    return h`<div class="ap-fd">
      <span class="ic">${icon(kind)}</span>
      <div class="grow"><b>${str(f.name) || 'Food'}</b><small>${[str(f.where), str(f.hours)].filter(Boolean).join(' · ')}</small>${f.note ? h`<small class="ap-fn">${f.note}</small>` : ''}</div>
      ${f.near ? h`<span class="ap-near${near ? ' me' : ''}">${near ? 'By your gate' : str(f.near)}</span>` : ''}
    </div>`;
  };
  const sortNote = gm ? `Sorted by distance from gate ${str(gate).toUpperCase()}.` : 'Sorted by your gate once AA posts it.';
  return h`<section class="sec ap-anc" id="ap-food">${head}<p class="ap-note">${sortNote}</p>
    <div class="ap-list">${air.map(row)}</div>
    ${pre.length ? h`<div class="ap-subh">Before security</div><div class="ap-list">${pre.map(row)}</div>` : ''}</section>`;
}

function servicesHtml(code) {
  const g = guide(code);
  const list = arr(g && g.services).filter(obj);
  if (!list.length) return '';
  return h`<section class="sec ap-anc" id="ap-svc"><div class="ey">Services</div><div class="ap-list">${list.map(s => h`<div class="ap-sv">
    <span class="ic">${ic(s.icon)}</span><div class="grow"><b>${str(s.label) || 'Service'}</b>${s.where ? h`<small>${s.where}</small>` : ''}</div></div>`)}</div></section>`;
}

const MODE_IC = {car: 'car', taxi: 'car', rideshare: 'car', valet: 'parking', parking: 'parking', garage: 'parking', economy: 'parking',
  bus: 'bus', shuttle: 'bus', van: 'bus', train: 'train', subway: 'train', rail: 'train', lirr: 'train', walk: 'walk'};
function groundHtml(code, v) {
  const g = guide(code);
  const list = arr(g && g.ground).filter(obj);
  if (!list.length) return '';
  const nyc = code === 'LGA';
  const into = !v || v.role === 'arrive';
  const title = into ? `Leaving ${code}` : `Getting to ${code}`;
  const rows = list.map(x => {
    const mn = arr(x.min).filter(n => Number.isFinite(+n));
    const t = mn.length ? `${mn[0]}${mn[1] && mn[1] !== mn[0] ? `–${mn[1]}` : ''} min` : '';
    const body = h`<span class="ic">${ic(MODE_IC[lc(x.mode)] || lc(x.mode), 'route')}</span>
      <div class="grow"><b>${str(x.name) || 'Option'}</b>
        <small class="tn">${[t, str(x.cost)].filter(Boolean).join(' · ')}</small>
        ${x.where ? h`<small>${x.where}</small>` : ''}
        ${x.good ? h`<small class="ap-gd">${icon('thumb-up')}${x.good}</small>` : ''}
        ${x.bad ? h`<small class="ap-bd">${icon('alert-circle')}${x.bad}</small>` : ''}</div>`;
    return nyc && into && x.id && /^[\w-]+$/.test(str(x.id))
      ? h`<a class="ap-gr" href="#route/hotel/${x.id}">${body}${icon('chevron-right', 'ap-chev')}</a>`
      : h`<div class="ap-gr">${body}</div>`;
  });
  return h`<section class="sec ap-anc" id="ap-ground"><div class="ap-sh"><div class="ey">${title}</div></div>
    ${nyc ? h`<a class="ap-tr" href="#transit"><span class="ic">${icon('route')}</span><div class="grow"><b>${into ? 'Compare ways into Manhattan' : 'Compare ways to LGA'}</b><small>Taxi, train and bus with today’s times in Transit</small></div>${icon('chevron-right', 'ap-chev')}</a>` : ''}
    <div class="ap-list">${rows}</div></section>`;
}

function infoHtml(code, v) {
  const g = guide(code);
  const facts = arr(g && g.facts).filter(obj), tips = arr(g && g.tips).map(str).filter(Boolean), links = arr(g && g.links).filter(obj).filter(l => /^https?:|^tel:/i.test(str(l.url)));
  const cav = caveats(code, v);
  if (!facts.length && !tips.length && !links.length && !cav.length) return '';
  return h`<section class="sec ap-anc" id="ap-info">
    ${facts.length ? h`<div class="ey">Good to know</div><div class="ap-facts">${facts.map(f => h`<div class="ap-fact"><small>${str(f.label)}</small><b>${str(f.value)}</b>${f.detail ? h`<span>${f.detail}</span>` : ''}</div>`)}</div>` : ''}
    ${tips.length ? h`<div class="ap-subh">Tips</div><ul class="ap-tips">${tips.map(t => h`<li>${icon('check')}<span>${t}</span></li>`)}</ul>` : ''}
    ${cav.length ? h`<div class="ap-subh">Not yet confirmed</div><ul class="ap-tips ap-cav">${cav.map(t => h`<li>${icon('alert-circle')}<span>${t}</span></li>`)}</ul>` : ''}
    ${links.length ? h`<div class="ap-subh">Links</div><div class="ap-list">${links.map(l => ext(l.url, h`<span class="grow"><b>${str(l.label) || str(l.url)}</b>${l.what ? h`<small>${l.what}</small>` : ''}</span>${icon('arrow-up-right', 'ap-chev')}`, 'ap-lk'))}</div>` : ''}
  </section>`;
}

// ---------- page ----------
const codeOf = ctx => {
  const p = str(ctx && ctx.name === 'airport' ? ctx.param : '').trim().toUpperCase();
  return p || autoCode();
};
function emptyHero(title, sub) {
  return h`<div class="ap-hero ap-e"><div class="ps ap-ps" role="group" aria-label="Airport">${codes().map(c => h`<button type="button" data-act="ap" data-arg="${lc(c)}" aria-pressed="false">${c}</button>`)}</div>
    <div class="ap-top"><h1 class="hl"><b>${title}</b></h1>${sub ? h`<p class="ap-sub"><span>${sub}</span></p>` : ''}</div></div>`;
}
function render(ctx) {
  const code = codeOf(ctx);
  const known = codes();
  if (!/^[A-Z]{3}$/.test(code) || (!known.includes(code) && !guide(code))) {
    return {hero: emptyHero('Airport not on this trip', `“${str(ctx.param).slice(0, 12)}” isn’t one of your airports.`),
      body: h`<div class="ap-pg"><div class="co plain">${icon('building-airport')}<span>Pick one of your airports above, or open the one that matters now.</span></div>
        <div class="wrap ap-ml"><a class="chip cr ap-c44" href="#airports">${icon('current-location')}Airport for right now</a></div></div>`};
  }
  const auto = autoCode();
  const list = visitsOf(code);
  const v = curVisit(code, list);
  const g = guide(code);
  if (!g && !N.data.trip) {
    return {hero: heroHtml(code, v, list, auto),
      body: h`<div class="ap-pg"><div class="co plain">${icon('info-circle')}<span>The airport guide isn’t on this phone yet. Open the app once with signal to load it.</span></div></div>`};
  }
  const seg = list.length > 1 ? h`<div class="seg ap-seg" role="group" aria-label="Which visit">${list.map(x => h`<button type="button" data-act="visit" data-arg="${x.key}" aria-pressed="${x === v ? 'true' : 'false'}">${roleWord(x.role)} ${dayOf(x, code).split(' ').slice(0, 2).join(' ')}</button>`)}</div>` : '';
  const cos = callouts(code, v);
  const arrive = v && v.role === 'arrive';
  const hasGround = !!arr(g && g.ground).length;
  const jumps = [['map', 'Map', 'map-2'], ['sec', 'Security', 'shield-check'], ['food', 'Food', 'tools-kitchen-2'],
    hasGround ? ['ground', arrive ? 'Leaving' : 'Getting here', 'route'] : null, arr(g && g.services).length ? ['svc', 'Services', 'wifi'] : null, ['info', 'Info', 'info-circle']].filter(Boolean);
  const body = h`<div class="ap-pg">
    ${seg}
    ${tilesHtml(code, v)}
    ${cos.length ? h`<div class="stack8 ap-cos">${cos}</div>` : ''}
    ${flightsHtml(code, v)}
    <nav class="ap-jump" data-hscroll aria-label="Jump to">${jumps.map(([id, t, i]) => h`<button type="button" class="ap-j" data-act="jump" data-arg="${id}">${icon(i)}${t}</button>`)}</nav>
    ${stepsHtml(code, v)}
    ${mapHtml(code, v)}
    ${arrive ? groundHtml(code, v) : ''}
    ${securityHtml(code, v)}
    ${foodHtml(code, v)}
    ${servicesHtml(code)}
    ${arrive ? '' : groundHtml(code, v)}
    ${infoHtml(code, v)}
    ${!g ? h`<div class="co plain sec">${icon('info-circle')}<span>No guide saved for ${code} yet; only flight and conditions data are shown.</span></div>` : ''}
  </div>`;
  return {hero: heroHtml(code, v, list, auto), body};
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
  ctl = mountMap(view, models[code]);
  return () => { if (ctl) { ctl.cleanup(); ctl = null; } };
}
function tick(ctx) {
  const s = sig(ctx);
  if (this._sig && s !== this._sig && !(ctl && ctl.busy())) { this._sig = s; N.rerender(); }
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
    if (t) t.scrollIntoView({behavior: N.reduce ? 'auto' : 'smooth', block: 'start'});
  },
  mapZoom(el, ev, ctx, arg) { if (ctl) ctl.zoom(+arg || 1); },
  mapReset() { if (ctl) ctl.reset(); },
  mapGate() { if (ctl) ctl.gate(); },
};

const def = {nav: 2, tone: 'band', uses: ['trip', 'guide', 'status'], render, mount, tick, actions,
  title: ctx => `${codeOf(ctx)} airport`};
N.screen('airports', Object.assign({}, def));
N.screen('airport', Object.assign({}, def));
})();
