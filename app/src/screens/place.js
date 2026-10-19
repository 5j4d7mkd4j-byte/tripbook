/* Place: one spot from the Yelp list. Photos (with a full-screen viewer),
   open now, how far, what to order, what people like and dislike, tips,
   hours, details and a small street map. Route: #place/<yelp alias>.
   Everything shown comes from food.bin, so the page works offline; photos
   and map tiles show a plain tile when they were never saved. */
(() => {
'use strict';
const {h, icon} = N;

// ---------- small, defensive readers (any field can be missing) ----------
const arr = v => Array.isArray(v) ? v.filter(x => x != null && x !== '') : [];
const str = v => typeof v === 'string' ? v.trim() : (typeof v === 'number' ? String(v) : '');
const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
const cap1 = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const web = u => (typeof u === 'string' && /^https?:\/\//i.test(u.trim())) ? u.trim() : null;
const food = () => N.food || {};
const placeFor = ctx => (ctx && ctx.param && food().place) ? food().place(ctx.param) : null;
const photosOf = p => {
  try { return (food().photos ? food().photos(p) : []).filter(x => x && typeof x.id === 'string' && x.id); }
  catch { return []; }
};
const nInside = p => arr(p && p.photos && p.photos.inside).length;
const photoUrl = (id, size) => food().photo ? food().photo(id, size) : '';
const hasLL = o => !!o && num(o.lat) != null && num(o.lon) != null;
// The name as the food list shows it (no " - New York" on the end), from food.js when it's loaded.
const nameOf = p => (typeof N.placeName === 'function' ? N.placeName(p) : '') || str(p && p.name);
// One section failing must never take the whole page down.
const safe = (fn, where) => { try { return fn(); } catch (e) { N.report(e, 'place ' + where); return ''; } };

const toMin = s => { const [a, b] = String(s || '').split(':').map(Number); return (a || 0) * 60 + (b || 0); };
const DAYS_ORDER = [1, 2, 3, 4, 5, 6, 0];

// ---------- links ----------
const ios = () => /iPhone|iPad|Macintosh/.test(navigator.userAgent);
// The place itself on a map (not directions).
const placeUrl = p => {
  const ll = `${p.lat},${p.lon}`;
  return ios() ? `https://maps.apple.com/?q=${encodeURIComponent(nameOf(p) || 'Place')}&ll=${ll}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ll)}`;
};
const destOf = p => str(p.address) || (hasLL(p) ? {lat: p.lat, lon: p.lon} : null);
const telOf = phone => {
  const d = String(phone || '').replace(/[^\d+]/g, '');
  if (!d) return null;
  return 'tel:' + (d.startsWith('+') ? d : d.length === 10 ? '+1' + d : d);
};

// ---------- distance ----------
const FAR = 60000;   // further than this (not in NYC yet) the "from you" chip is left out
// Same cut-offs as the food list, so a card and its page never disagree.
const walkText = m => {
  const w = N.walkMin(m);
  return w <= 30 ? `${w} min walk` : N.distText(m);
};
function distBits(p) {
  const out = [];
  if (!hasLL(p)) return out;
  const m = food().away ? food().away(p) : null;
  if (m != null && m <= FAR) out.push({i: m < 2400 ? 'walk' : 'current-location', t: `${walkText(m)} from you`});
  const ho = N.hotel ? N.hotel() : null;
  if (hasLL(ho)) out.push({i: 'bed', t: `${walkText(N.dist(ho, p))} from hotel`});
  return out;
}
const canLocate = () => !!navigator.geolocation && !N.lastWhere();

// ---------- hours ----------
// Only well-formed [weekday, "HH:MM", "HH:MM"] rows count, for the chip and the table alike,
// so a bad row can't turn into "Closed" or "Open 24 hours".
const HHMM = /^([01]?\d|2[0-4]):[0-5]\d$/;
const validHours = p => arr(p && p.hours).filter(r => Array.isArray(r) && r.length >= 3 && Number.isInteger(r[0]) && r[0] >= 0 && r[0] <= 6
  && HHMM.test(String(r[1])) && HHMM.test(String(r[2])));
const NO_HOURS = {state: 'unknown', text: 'Hours not listed'};
const hoursOf = p => {
  const rows = validHours(p);
  if (!rows.length || !food().hours) return NO_HOURS;
  try { return food().hours({...p, hours: rows}, N.now()) || NO_HOURS; }
  catch { return NO_HOURS; }
};
// One weekday as text, with whole-day spans as "Open 24 hours".
function dayText(p, dd) {
  const rows = validHours(p).filter(r => r[0] === dd);
  if (!rows.length) return 'Closed';
  return rows.map(([, a, b]) => {
    const s = toMin(a); let e = toMin(b);
    if (e <= s) e += 1440;
    return e - s >= 1439 ? 'Open 24 hours' : `${N.clockText(s)}–${N.clockText(e)}`;
  }).join(', ');
}

// ---------- attributes → chips ----------
const ATTRS = [
  // [key, test(value) → [icon, text, warn?] | null]
  ['reservations', v => v === true ? ['calendar-check', 'Takes reservations'] : v === false ? ['calendar', 'No reservations'] : null],
  ['cards', v => v === false ? ['cash', 'Cash only', true] : v === true ? ['credit-card', 'Cards accepted'] : null],
  ['apple_pay', v => v === true ? ['device-mobile', 'Apple Pay'] : null],
  ['wheelchair', v => v === true ? ['wheelchair', 'Wheelchair accessible'] : v === false ? ['wheelchair', 'Not wheelchair accessible', true] : null],
  ['takeout', v => v === true ? ['shopping-bag', 'Takeout'] : v === false ? ['shopping-bag', 'No takeout'] : null],
  ['delivery', v => v === true ? ['scooter', 'Delivery'] : null],
  ['outdoor', v => v === true ? ['sun', 'Outdoor seating'] : null],
  ['noise', v => typeof v === 'string' && v ? ['volume', `${cap1(v)} noise`] : null],
  ['alcohol', v => typeof v === 'string' && v ? [/bar/i.test(v) ? 'glass-full' : 'beer', cap1(v)] : v === false ? ['glass-full', 'No alcohol'] : null],
  ['happy_hour', v => v === true ? ['clock', 'Happy hour'] : null],
  ['late_kitchen', v => v === true ? ['moon', 'Late kitchen'] : null],
  ['groups', v => v === true ? ['users', 'Good for groups'] : null],
  ['kids', v => v === true ? ['baby-carriage', 'Good for kids'] : null],
  ['vegan', v => v === true ? ['leaf', 'Vegan options'] : null],
  ['vegetarian', v => v === true ? ['salad', 'Vegetarian options'] : null],
  ['gluten_free', v => v === true ? ['bread', 'Gluten-free options'] : null],
  ['wifi', v => typeof v === 'string' && v && v !== 'no' ? ['wifi', `${cap1(v)} Wi-Fi`] : null],
  ['good_for_working', v => v === true ? ['briefcase', 'Laptop-friendly'] : null],
  ['dogs', v => v === true ? ['dog', 'Dogs allowed'] : null],
  ['ambience', v => typeof v === 'string' && v ? ['sparkles', cap1(v)] : null],
  ['attire', v => typeof v === 'string' && v ? ['user', `${cap1(v)} dress`] : null],
  ['best_nights', v => typeof v === 'string' && v ? ['moon-stars', `Busiest: ${v.split(/,\s*/).map(d => d.slice(0, 3)).join(', ')}`] : null],
  ['parking', v => typeof v === 'string' && v ? ['parking', `Parking: ${v}`] : null],
  ['health', v => typeof v === 'string' && v ? ['shield-check', /^[A-C]$/.test(v) ? `Health grade ${v}` : /pending/i.test(v) ? 'Health grade pending' : `Inspection: ${v}`] : null],
  ['gender_neutral_restrooms', v => v === true ? ['toilet-paper', 'Gender-neutral restrooms'] : null],
  ['lgbtq_friendly', v => v === true ? ['heart', 'LGBTQ+ friendly'] : null],
  ['corkage', v => v === 'free' ? ['bottle', 'Free corkage'] : null],
  ['catering', v => v === true ? ['tools-kitchen-2', 'Catering'] : null],
  ['private_events', v => v === true ? ['calendar-time', 'Private events'] : null],
];
function attrChips(a) {
  if (!a || typeof a !== 'object') return [];
  const out = [];
  for (const [k, fn] of ATTRS) {
    if (!(k in a)) continue;
    let r = null;
    try { r = fn(a[k]); } catch { r = null; }
    if (r) out.push(r);
  }
  return out;
}

// ---------- pieces ----------
function stars(r) {
  const v = Math.round(N.clamp(r, 0, 5) * 2) / 2;
  const s = [1, 2, 3, 4, 5].map(i => icon(v >= i ? 'star-filled' : v >= i - .5 ? 'star-half-filled' : 'star'));
  return h`<span class="pl-stars" role="img" aria-label="${`Rated ${r} out of 5`}">${s}</span>`;
}
// Display size for the name: big when short, smaller when long or a word is long.
function nameSize(name) {
  const len = name.length;
  const word = Math.max(...name.split(/\s+/).map(w => w.length), 1);
  const byLen = len <= 10 ? 60 : len <= 14 ? 50 : len <= 20 ? 42 : len <= 28 ? 36 : len <= 36 ? 30 : 26;
  const byWord = 350 / (word * .64);
  return [60, 50, 42, 36, 30, 26].find(s => s <= Math.min(byLen, byWord)) || 26;
}

function hoursChip(p) {
  const st = hoursOf(p);
  const tone = st.state === 'open' ? 'ok' : st.state === 'closing' ? 'soon' : st.state === 'closed' ? 'shut' : 'na';
  return h`<span class="${'pl-chip pl-' + tone}"><span class="pl-dot"></span>${st.text || 'Hours not listed'}</span>`;
}
function statusRow(p) {
  const bits = distBits(p);
  const ask = !bits.some(b => b.t.endsWith('from you')) && canLocate() && hasLL(p) && !N.lastWhere();
  return h`${hoursChip(p)}${bits.map(b => h`<span class="pl-chip pl-dist">${icon(b.i)}${b.t}</span>`)}${ask
    ? h`<button class="pl-chip pl-ask" data-act="locate" aria-label="Distance from me">${icon('current-location')}<span>Distance</span></button>` : ''}`;
}

function gallery(p) {
  const list = photosOf(p);
  if (!list.length) {
    return h`<div class="pl-none">${icon('photo')}<span>No photos saved for this place</span></div>`;
  }
  const inside0 = list.length - nInside(p);
  const name = nameOf(p) || 'this place';
  return h`<div class="pl-galw">
    <div class="pl-gal" data-hscroll role="region" aria-label="${`Photos of ${name}`}">${list.map((x, i) => {
      const cap = str(x.cap);
      const label = `Photo ${i + 1} of ${list.length}${cap ? ': ' + cap : ''}${i >= inside0 ? ' (inside)' : ''}. Opens full screen.`;
      return h`<button class="pl-ph pl-fig${list.length === 1 ? ' pl-one' : ''}" data-act="photo" data-arg="${i}" aria-label="${label}">
        <img class="pl-img" src="${photoUrl(x.id, 'l')}" alt="" ${i ? N.raw('loading="lazy"') : N.raw('fetchpriority="high"')} decoding="async">
        ${cap || i >= inside0 ? h`<span class="pl-cap">${i >= inside0 ? h`<b>Inside</b>` : ''}${cap ? h`<span>${cap}</span>` : ''}</span>` : ''}
      </button>`;
    })}</div>
    ${list.length > 1 ? h`<span class="pl-cnt" aria-hidden="true">${icon('photo')}<span data-pl="cnt">1 / ${list.length}</span></span>` : ''}
  </div>`;
}

function heroHtml(p) {
  const name = nameOf(p) || 'Unnamed place';
  const cuisine = arr(p.cuisine).map(str).filter(Boolean).slice(0, 3).join(' · ');
  // A 0 (or out-of-range) rating and a 0 review count mean "no rating", not "rated zero".
  let rating = num(p.rating), reviews = num(p.reviews);
  if (rating != null && !(rating > 0 && rating <= 5)) rating = null;
  if (reviews != null && !(reviews >= 1)) reviews = null;
  if (reviews != null) reviews = Math.round(reviews);
  const price = str(p.price);
  const where = [str(p.located_in) ? `Inside ${str(p.located_in)}` : '', str(p.neighborhood), str(p.borough)].filter(Boolean).join(' · ');
  const meta = [
    rating != null ? h`<span class="pl-rate">${stars(rating)}<b>${rating.toFixed(1)}</b></span>` : '',
    reviews != null ? h`<span>${N.plural(reviews, 'review').replace(/^\d+/, reviews.toLocaleString('en-US'))}</span>` : '',
    price ? h`<span class="pl-price">${price}</span>` : '',
  ].filter(Boolean);
  return h`<div class="pl-hero">
    ${safe(() => gallery(p), 'gallery')}
    <div class="pl-ttl">
      ${cuisine ? h`<div class="ey">${cuisine}</div>` : ''}
      <h1 class="${`dp pl-name pl-t${nameSize(name)}`}">${name}</h1>
      ${meta.length ? h`<div class="pl-meta">${meta.map((m, i) => h`${i ? h`<span class="pl-sep" aria-hidden="true">·</span>` : ''}${m}`)}</div>` : ''}
      ${where ? h`<div class="pl-where">${icon('map-pin')}<span>${where}</span></div>` : ''}
    </div>
    <div class="pl-stat" data-pl="stat">${safe(() => statusRow(p), 'status')}</div>
  </div>`;
}

// The big buttons under the hero: [href, icon, label, aria].
function actList(p) {
  const dest = destOf(p);
  const tel = telOf(p.phone), site = web(p.website), yelp = web(p.yelp), menu = web(p.menu);
  const acts = [];
  if (dest) acts.push([N.mapsUrl(dest, 'w'), 'walk', 'Walk', `Walking directions to ${nameOf(p)}`]);
  if (dest) acts.push([N.mapsUrl(dest, 'r'), 'train', 'Transit', `Transit directions to ${nameOf(p)}`]);
  if (tel) acts.push([tel, 'phone', 'Call', `Call ${nameOf(p)}`]);
  if (site) acts.push([site, 'world', 'Website', `${nameOf(p)} website`]);
  else if (menu) acts.push([menu, 'receipt', 'Menu', `${nameOf(p)} menu`]);
  else if (yelp) acts.push([yelp, 'star', 'Yelp', `${nameOf(p)} on Yelp`]);
  return acts;
}
function quickActs(p) {
  const acts = actList(p);
  if (!acts.length) return '';
  return h`<div class="${'pl-acts pl-n' + acts.length}">${acts.map(([href, i, t, aria]) =>
    h`<a class="pl-act" href="${href}" ${href.startsWith('tel:') ? '' : N.raw('target="_blank" rel="noopener"')} aria-label="${aria}">${icon(i)}<span>${t}</span></a>`)}</div>`;
}

function overview(p) {
  const sum = str(p.summary);
  const facts = [
    ['sparkles', 'Vibe', cap1(str(p.vibe))],
    ['hourglass', 'Wait', cap1(str(p.wait))],
    ['cash', 'Per person', str(p.price_per_person)],
  ].filter(f => f[2]);
  const good = arr(p.good_for).map(str).filter(Boolean);
  if (!sum && !facts.length && !good.length) return '';
  return h`<section class="sec pl-sec">
    <h2 class="ey">Overview</h2>
    ${sum ? h`<p class="pl-sum">${sum}</p>` : ''}
    ${facts.length ? h`<div class="pl-facts">${facts.map(([i, k, v]) => h`<div class="pl-fact"><span class="pl-fi">${icon(i)}</span><div><small>${k}</small><span>${v}</span></div></div>`)}</div>` : ''}
    ${good.length ? h`<div class="pl-good"><span class="pl-lbl">Good for</span><div class="pl-chips">${good.map(g => h`<span class="pl-tag">${cap1(g)}</span>`)}</div></div>` : ''}
  </section>`;
}

function toOrder(p) {
  const pop = arr(p.popular).filter(x => typeof x === 'object' && str(x.name));
  const names = new Set(pop.map(x => norm(x.name)));
  const more = arr(p.order).map(str).filter(Boolean).filter(n => !names.has(norm(n)));
  if (!pop.length && !more.length) return '';
  const list = photosOf(p);
  const at = id => list.findIndex(x => x.id === id);
  return h`<section class="sec pl-sec">
    <h2 class="ey">What to order</h2>
    ${pop.length ? h`<div class="pl-dishes" data-hscroll>${pop.map(d => {
      const id = typeof d.photo === 'string' && d.photo ? d.photo : null;
      const i = id ? at(id) : -1;
      const pic = id
        ? h`<span class="pl-dimg pl-fig"><img class="pl-img" src="${photoUrl(id, '348s')}" alt="" loading="lazy" decoding="async"></span>`
        : h`<span class="pl-dimg pl-dnone">${icon('tools-kitchen-2')}</span>`;
      const inner = h`${pic}<b>${str(d.name)}</b>${str(d.note) ? h`<small>${cap1(str(d.note))}</small>` : ''}`;
      return i >= 0
        ? h`<button class="pl-dish" data-act="photo" data-arg="${i}" aria-label="${`${str(d.name)}. Opens photo.`}">${inner}</button>`
        : h`<div class="pl-dish">${inner}</div>`;
    })}</div>` : ''}
    ${more.length ? h`<div class="pl-also"><span class="pl-lbl">${pop.length ? 'Also worth ordering' : 'Most ordered'}</span><div class="pl-chips">${more.map(n => h`<span class="pl-tag">${n}</span>`)}</div></div>` : ''}
  </section>`;
}

function opinions(p) {
  const loved = arr(p.loved).map(str).filter(Boolean);
  const watch = arr(p.watch).map(str).filter(Boolean);
  const tips = arr(p.tips).map(str).filter(Boolean);
  if (!loved.length && !watch.length && !tips.length) return '';
  const list = (items, i) => h`<ul class="pl-list">${items.map(t => h`<li>${icon(i)}<span>${cap1(t)}</span></li>`)}</ul>`;
  return h`${loved.length || watch.length ? h`<section class="sec pl-sec pl-ops">
      ${loved.length ? h`<div class="card tight pl-love"><h2 class="pl-h3">${icon('thumb-up')}People love</h2>${list(loved, 'check')}</div>` : ''}
      ${watch.length ? h`<div class="card tight sand pl-watch"><h2 class="pl-h3">${icon('alert-triangle')}Watch out</h2>${list(watch, 'point')}</div>` : ''}
    </section>` : ''}
    ${tips.length ? h`<section class="sec pl-sec"><h2 class="ey">Tips</h2><ul class="pl-tips">${tips.map(t => h`<li><span class="pl-fi">${icon('bulb')}</span><span>${cap1(t)}</span></li>`)}</ul></section>` : ''}`;
}

// The week as rows, with runs of days that share hours joined ("Mon–Thu"), or one "Every day" row.
function weekRows(p) {
  const out = [];
  for (const d of DAYS_ORDER) {
    const t = dayText(p, d), last = out[out.length - 1];
    if (last && last.t === t) last.days.push(d); else out.push({t, days: [d]});
  }
  if (out.length === 1) return [{t: out[0].t, label: 'Every day', days: out[0].days}];
  const short = out.some(r => r.days.length > 1);
  return out.map(r => ({...r, label: r.days.length > 1
    ? `${N.dayName(r.days[0])}–${N.dayName(r.days[r.days.length - 1])}` : N.dayName(r.days[0], !short)}));
}
function hoursHtml(p) {
  const rows = validHours(p);
  const note = str(p.hours_note);
  if (!rows.length) {
    return h`<section class="sec pl-sec"><h2 class="ey">Hours</h2>
      <div class="co plain">${icon('clock')}<span>Yelp doesn’t list hours for this place${note ? ` (${note})` : ''}. Call or check its website before you go.</span></div></section>`;
  }
  const today = N.nyNow().day;
  const week = weekRows(p);
  const tr = (cls, label, t) => h`<tr class="${N.cls(cls, t === 'Closed' && 'pl-off')}"><th scope="row">${label}</th><td>${t}</td></tr>`;
  const head = week.length === 1
    ? tr('pl-today', week[0].label, week[0].t)
    : tr('pl-today', h`${N.dayName(today, true)}<span class="pl-tdy">Today</span>`, dayText(p, today));
  return h`<section class="sec pl-sec"><h2 class="ey">Hours</h2>
    <div class="pl-hrs">
      <div class="pl-hnow" data-pl="hnow">${hoursChip(p)}<span class="pl-tz">New York time</span></div>
      <table class="pl-tbl"><tbody>${head}</tbody></table>
      ${week.length > 1 ? h`<details class="pl-hall"><summary><span>All hours</span>${icon('chevron-down')}</summary>
        <table class="pl-tbl"><tbody>${week.map(r => tr(r.days.includes(today) && 'pl-today', r.label, r.t))}</tbody></table>
      </details>` : ''}
      ${note ? h`<p class="pl-note">${icon('info-circle')}<span>${note}</span></p>` : ''}
    </div></section>`;
}

function detailsHtml(p) {
  const chips = attrChips(p.attrs);
  const addr = str(p.address);
  const site = web(p.website), menu = web(p.menu), yelp = web(p.yelp);
  const a = p.attrs && typeof p.attrs === 'object' ? p.attrs : {};
  const reserve = web(a.reserve_url), order = web(a.order_url);
  const tel = telOf(p.phone);
  // anything already a button under the hero (Call, Website…) isn't repeated here
  const shown = new Set(actList(p).map(a => a[0]));
  const links = [
    tel ? [tel, 'phone', str(p.phone), false] : null,
    menu ? [menu, 'receipt', 'Menu', true] : null,
    reserve ? [reserve, 'calendar-check', 'Reserve', true] : null,
    order ? [order, 'shopping-bag', 'Order online', true] : null,
    site ? [site, 'world', 'Website', true] : null,
    yelp ? [yelp, 'star', 'Open in Yelp', true] : null,
  ].filter(l => l && !shown.has(l[0]));
  // Two to a row; a long phone number gets a row of its own, and an odd one out at the end
  // fills its row rather than leaving a half-width button and a gap.
  const wide = links.map(([href, , t]) => href.startsWith('tel:') && t.length > 15);
  const halves = wide.map((w, i) => w ? -1 : i).filter(i => i >= 0);
  if (halves.length % 2) wide[halves[halves.length - 1]] = true;
  const ll = hasLL(p);
  return h`<section class="sec pl-sec"><h2 class="ey">Details</h2>
    ${chips.length ? h`<ul class="pl-dets">${chips.map(([i, t, warn]) => h`<li class="${N.cls(warn && 'pl-warn')}">${icon(i)}<span>${t}</span></li>`)}</ul>`
      : h`<p class="pl-quiet">Yelp lists no extras (reservations, seating, payment) for this place.</p>`}
    <div class="pl-loc">
      ${ll ? h`<div class="pl-map">
        <div class="pl-mapc" data-pl="map" aria-hidden="true"></div>
        <a class="pl-mapa" href="${placeUrl(p)}" target="_blank" rel="noopener" aria-label="${`Show ${nameOf(p)} in Maps`}"></a>
      </div>` : ''}
      <div class="pl-addr">
        <span class="pl-fi">${icon('map-pin')}</span>
        <div class="grow"><b>${addr || (str(p.located_in) ? `Inside ${str(p.located_in)}` : 'No street address listed')}</b>${
          [str(p.neighborhood), str(p.borough)].filter(Boolean).length ? h`<small>${[str(p.neighborhood), str(p.borough)].filter(Boolean).join(' · ')}</small>` : ''}</div>
        ${addr ? h`<button class="pl-copy" data-act="copy" data-arg="${addr}" aria-label="Copy address">${icon('copy')}</button>` : ''}
      </div>
    </div>
    ${links.length ? h`<div class="pl-links">${links.map(([href, i, t, ext], k) =>
      h`<a class="${N.cls('pl-link', wide[k] && 'pl-wide')}" href="${href}" ${ext ? N.raw('target="_blank" rel="noopener"') : ''}>${icon(i)}<span class="ell">${t}</span>${ext ? icon('arrow-up-right', 'pl-ext') : ''}</a>`)}</div>` : ''}
  </section>`;
}

function footer() {
  const at = N.data.food && N.data.food.collected_at;
  const when = at && !isNaN(new Date(at)) ? N.date(at, 'NYC') : '';
  return h`<p class="pl-foot">${icon('star')}<span>Seen on your Yelp list${when ? ` · info collected ${when}` : ''}</span></p>`;
}

function missing() {
  const none = !N.data.food;
  return {
    hero: h`<div class="pl-hero pl-miss"><div class="ey">Food</div><h1 class="hl">${none ? h`Food list <b>not saved yet</b>` : h`Can’t find <b>that place</b>`}</h1></div>`,
    body: h`<div class="stack">
      <div class="co plain">${icon(none ? 'wifi-off' : 'search-off')}<span>${none
        ? 'This phone hasn’t saved the food list yet. Open the app once with a signal and it stays available offline.'
        : 'That link points to a place that isn’t on your saved Yelp list. It may have been dropped the last time the list was updated.'}</span></div>
      <button class="btn" data-act="go" data-arg="food">${icon('tools-kitchen-2')}See all food</button>
    </div>`,
  };
}

// ---------- full-screen photo viewer ----------
let lb = null;          // the open viewer
let reopen = null;      // {id, idx} kept across a same-page re-render
function lbHtml(p, list) {
  const inside0 = list.length - nInside(p);
  return h`<div class="pl-lb-top">
      <span class="pl-lb-n" aria-live="polite" data-pl="lbn"></span>
      <button class="pl-lb-x" data-act="lbClose" aria-label="Close photos">${icon('x')}</button>
    </div>
    <div class="pl-lb-track" data-hscroll>${list.map((x, i) => h`<figure class="pl-lb-s pl-fig">
      <img class="pl-img" alt="${str(x.cap) || `Photo ${i + 1}`}" data-src="${photoUrl(x.id, 'o')}" data-alt="${photoUrl(x.id, 'l')}" decoding="async">
      ${str(x.cap) || i >= inside0 ? h`<figcaption>${i >= inside0 ? h`<b>Inside</b>` : ''}${str(x.cap)}</figcaption>` : ''}
    </figure>`)}</div>
    <button class="pl-lb-b pl-lb-prev" data-act="lbStep" data-arg="-1" aria-label="Previous photo">${icon('chevron-left')}</button>
    <button class="pl-lb-b pl-lb-next" data-act="lbStep" data-arg="1" aria-label="Next photo">${icon('chevron-right')}</button>
    <button class="pl-lb-done" data-act="lbDone" hidden>Done</button>`;
}

// Pinch or double-tap a photo to zoom in (a double-tap goes to 2.5x where you tapped), then drag to
// look around; Done or another double-tap shows the whole photo again. Zoom belongs to the photo on
// screen and is never kept. At 1x the track only scrolls sideways, and a swipe down of more than
// 80px (or a flick) closes the viewer, the backdrop fading as the photo follows the finger.
const ZOOM = 2.5, ZMAX = 4;
function lbGestures(st) {
  const {el, track} = st, done = N.$('.pl-lb-done', el);
  let im = null, s = 1, tx = 0, ty = 0;   // the zoomed photo and its zoom
  let g = null, tap = null, touched = 0, closing = 0;
  const cur = () => st.imgs[st.idx];
  // the photo's untransformed box and the size of the picture drawn in it (object-fit: contain)
  const box = img => {
    const r = img.parentElement.getBoundingClientRect(), bw = img.clientWidth || 1, bh = img.clientHeight || 1;
    const k = img.naturalWidth && img.naturalHeight ? Math.min(bw / img.naturalWidth, bh / img.naturalHeight) : 1;
    return {cx: r.left + img.offsetLeft + bw / 2, cy: r.top + img.offsetTop + bh / 2, bw, bh,
      w: img.naturalWidth ? img.naturalWidth * k : bw, h: img.naturalHeight ? img.naturalHeight * k : bh};
  };
  // how far the zoomed picture can move before an edge comes away from the box edge
  const room = b => [Math.max(0, (b.w * s - b.bw) / 2), Math.max(0, (b.h * s - b.bh) / 2)];
  const give = (v, m) => v > m ? m + (v - m) / 3 : v < -m ? -m + (v + m) / 3 : v;
  const paint = (anim = false) => {
    if (!im) return;
    im.style.transition = anim && !N.reduce ? 'transform .28s var(--ease)' : 'none';
    im.style.transform = s === 1 && !tx && !ty ? '' : `translate3d(${tx}px,${ty}px,0) scale(${s})`;
    el.classList.toggle('pl-lb-z', s > 1);
    if (done && done.hidden !== s <= 1) {
      // Done going away under the focus hands it to Close rather than losing it
      if (s <= 1 && document.activeElement === done) { const x = N.$('.pl-lb-x', el); if (x) x.focus({preventScroll: true}); }
      done.hidden = s <= 1;
    }
    if (s === 1 && !tx && !ty) im = null;
  };
  const unzoom = (anim = true) => { if (!im) return; s = 1; tx = ty = 0; paint(anim); };
  const settle = () => {
    if (s < 1.08) { s = 1; tx = ty = 0; }
    else { s = Math.min(s, ZMAX); const [mx, my] = room(box(im)); tx = N.clamp(tx, -mx, mx); ty = N.clamp(ty, -my, my); }
    paint(true);
  };
  // double-tap: in to 2.5x keeping the tapped spot under the finger, or back out
  const toggle = (x, y) => {
    const img = cur();
    if (!img) return;
    if (im) { unzoom(); return; }
    im = img;
    const b = box(img);
    s = ZOOM;
    const [mx, my] = room(b);
    tx = N.clamp((b.cx - x) * (ZOOM - 1), -mx, mx); ty = N.clamp((b.cy - y) * (ZOOM - 1), -my, my);
    paint(true);
  };
  // swipe down at 1x: the photo follows the finger and the backdrop and controls fade
  const pull = (dx, dy) => {
    const k = Math.min(1, dy / 400);
    const img = cur();
    if (img) { img.style.transition = 'none'; img.style.transform = `translate3d(${dx}px,${dy}px,0) scale(${1 - k * .2})`; }
    el.style.setProperty('--pl-fade', String(1 - Math.min(.85, dy / 320)));
  };
  const letGo = close => {
    const img = cur();
    el.classList.remove('pl-lb-live');
    if (close) {
      if (N.reduce) { closeLb(); return; }
      el.style.setProperty('--pl-fade', '0');
      if (img) { img.style.transition = 'transform .22s ease-in'; img.style.transform = `translate3d(0,${innerHeight}px,0) scale(.8)`; }
      closing = setTimeout(() => { if (lb === st) closeLb(); }, 220);
      return;
    }
    el.classList.remove('pl-lb-bare');
    el.style.setProperty('--pl-fade', '1');
    if (img) { img.style.transition = N.reduce ? 'none' : 'transform .28s var(--ease)'; img.style.transform = ''; }
  };
  const pts = ev => [...ev.touches].map(t => [t.clientX, t.clientY]);
  const mid = p => [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2];
  const gap = p => Math.max(1, Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]));
  const down = ev => {
    touched = performance.now();
    if (closing) return;
    const p = pts(ev), img = cur();
    if (!img) return;
    if (p.length === 2) {
      if (g && g.k === 'drop') letGo(false);
      if (im !== img) { unzoom(false); im = img; }
      // keep the photo square on screen and the spot between the fingers under them
      track.scrollLeft = st.idx * track.clientWidth;
      const b = box(img), m = mid(p);
      g = {k: 'pinch', b, d0: gap(p), s0: s, px: (m[0] - b.cx - tx) / s, py: (m[1] - b.cy - ty) / s};
      return;
    }
    g = p.length === 1 ? {k: '', x0: p[0][0], y0: p[0][1], tx0: tx, ty0: ty, t0: touched, t: touched, dx: 0, dy: 0, vy: 0} : null;
  };
  const move = ev => {
    if (!g) return;
    const p = pts(ev);
    if (g.k === 'pinch') {
      if (p.length < 2) return;
      if (ev.cancelable) ev.preventDefault();
      const m = mid(p);
      s = N.clamp(g.s0 * gap(p) / g.d0, .7, ZMAX * 1.25);
      tx = m[0] - g.b.cx - s * g.px; ty = m[1] - g.b.cy - s * g.py;
      paint();
      return;
    }
    if (p.length !== 1) return;
    const dx = p[0][0] - g.x0, dy = p[0][1] - g.y0;
    if (!g.k) {
      if (Math.hypot(dx, dy) < 8) return;
      g.k = im && im === cur() ? 'pan' : dy > Math.abs(dx) ? 'drop' : 'none';
      if (g.k === 'drop') el.classList.add('pl-lb-live', 'pl-lb-bare');
    }
    if (g.k === 'none') return;
    if (ev.cancelable) ev.preventDefault();
    if (g.k === 'pan') {
      const [mx, my] = room(box(im));
      tx = give(g.tx0 + dx, mx); ty = give(g.ty0 + dy, my);
      paint();
      return;
    }
    const now = performance.now();
    g.vy = .7 * (dy - g.dy) / Math.max(1, now - g.t) + .3 * g.vy;
    g.dx = dx; g.dy = dy; g.t = now;
    pull(dx, Math.max(0, dy));
  };
  const up = ev => {
    const d = g;
    if (!d) return;
    if (d.k === 'pinch') { g = null; settle(); return; }
    if (ev.touches.length) return;
    g = null;
    if (d.k === 'pan') settle();
    else if (d.k === 'drop') letGo(ev.type !== 'touchcancel' && (d.dy > 80 || (d.vy > .5 && d.dy > 24 && performance.now() - d.t < 80)));
    else if (!d.k && ev.type === 'touchend' && performance.now() - d.t0 < 300) {
      const now = performance.now();
      if (tap && now - tap.t < 320 && Math.hypot(tap.x - d.x0, tap.y - d.y0) < 30) { tap = null; toggle(d.x0, d.y0); }
      else tap = {x: d.x0, y: d.y0, t: now};
    }
  };
  // a mouse double-click does what a double-tap does
  const dbl = ev => { if (performance.now() - touched > 800) toggle(ev.clientX, ev.clientY); };
  const opt = {passive: false};
  track.addEventListener('touchstart', down, {passive: true});
  track.addEventListener('touchmove', move, opt);
  track.addEventListener('touchend', up);
  track.addEventListener('touchcancel', up);
  track.addEventListener('dblclick', dbl);
  st.unzoom = unzoom;
  st.zoomed = () => !!im;
  return () => {
    clearTimeout(closing);
    track.removeEventListener('touchstart', down, {passive: true});
    track.removeEventListener('touchmove', move, opt);
    track.removeEventListener('touchend', up);
    track.removeEventListener('touchcancel', up);
    track.removeEventListener('dblclick', dbl);
  };
}
function openLb(p, idx, instant = false) {
  closeLb(true);
  const list = photosOf(p);
  if (!list.length) return;
  idx = N.clamp(Math.round(+idx || 0), 0, list.length - 1);
  const app = N.$('#app') || document.body, view = N.$('#view'), nav = N.$('.nv');
  const el = document.createElement('div');
  el.className = 'pl-lb' + (instant || N.reduce ? '' : ' pl-lb-in');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', `Photos of ${nameOf(p) || 'this place'}`);
  el.innerHTML = String(lbHtml(p, list));
  app.appendChild(el);
  const track = N.$('.pl-lb-track', el), imgs = N.$$('img', track);
  const st = {p, el, track, imgs, n: list.length, idx: -1, prevFocus: document.activeElement, view, nav, off: []};
  lb = st;
  if (view) { view.style.overflow = 'hidden'; view.inert = true; }
  if (nav) nav.inert = true;
  const show = i => {
    i = N.clamp(i, 0, st.n - 1);
    for (const j of [i, i + 1, i - 1]) { const im = imgs[j]; if (im && !im.getAttribute('src') && im.dataset.src) im.src = im.dataset.src; }
    if (i === st.idx) return;
    if (st.unzoom) st.unzoom(false);
    st.idx = i;
    const n = N.$('[data-pl="lbn"]', el); if (n) n.textContent = `${i + 1} / ${st.n}`;
    N.$('.pl-lb-prev', el).disabled = i === 0;
    N.$('.pl-lb-next', el).disabled = i === st.n - 1;
  };
  st.show = show;
  st.off.push(lbGestures(st));
  track.scrollLeft = idx * track.clientWidth;
  show(idx);
  let raf = 0;
  const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => show(Math.round(track.scrollLeft / Math.max(1, track.clientWidth)))); };
  track.addEventListener('scroll', onScroll, {passive: true});
  // Keep the photo in place when the phone rotates or the window resizes.
  const onResize = () => { st.unzoom(false); track.scrollLeft = st.idx * track.clientWidth; };
  window.addEventListener('resize', onResize);
  const onKey = ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); if (st.zoomed()) st.unzoom(); else closeLb(); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); stepLb(1); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); stepLb(-1); }
    else if (ev.key === 'Tab') {
      const f = N.$$('button', el).filter(b => !b.disabled && !b.hidden);
      if (!f.length) return;
      const k = f.indexOf(document.activeElement);
      ev.preventDefault();
      f[(k + (ev.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    }
  };
  document.addEventListener('keydown', onKey, true);
  st.off.push(() => track.removeEventListener('scroll', onScroll), () => window.removeEventListener('resize', onResize),
    () => document.removeEventListener('keydown', onKey, true), () => cancelAnimationFrame(raf));
  const x = N.$('.pl-lb-x', el); if (x) x.focus({preventScroll: true});
}
function stepLb(d) {
  if (!lb) return;
  const i = N.clamp(lb.idx + d, 0, lb.n - 1);
  if (i === lb.idx) return;
  lb.unzoom(false);
  lb.track.scrollTo({left: i * lb.track.clientWidth, behavior: N.reduce ? 'auto' : 'smooth'});
}
// quiet: closing because the page is re-rendering or leaving (no focus moves).
function closeLb(quiet = false) {
  const st = lb;
  if (!st) return;
  lb = null;
  st.off.forEach(f => { try { f(); } catch { /* already gone */ } });
  st.el.remove();
  if (st.view) { st.view.style.overflow = ''; st.view.inert = false; }
  if (st.nav) st.nav.inert = false;
  if (quiet) return;
  // Return to the same photo in the strip on the page.
  const slide = st.view && N.$$('.pl-ph', st.view)[st.idx];
  const gal = slide && slide.parentElement;
  if (gal) gal.scrollLeft = Math.max(0, slide.offsetLeft - 20);
  const back = slide || (st.prevFocus && st.prevFocus.isConnected ? st.prevFocus : null);
  if (back) back.focus({preventScroll: true});
}

// ---------- failed photos ----------
// Swap to the smaller size once, then show a plain tile saying why.
function onImgError(ev) {
  const im = ev.target;
  if (!im || im.tagName !== 'IMG' || !im.classList.contains('pl-img')) return;
  const alt = im.dataset.alt;
  if (alt && im.getAttribute('src') !== alt) { im.dataset.alt = ''; im.src = alt; return; }
  const box = im.closest('.pl-fig');
  if (!box || box.classList.contains('pl-bad')) return;
  box.classList.add('pl-bad');
  const off = !N.online();
  im.insertAdjacentHTML('afterend', String(h`<span class="pl-badm">${icon(off ? 'wifi-off' : 'photo')}<span>${off ? 'Not saved for offline' : 'Photo didn’t load'}</span></span>`));
}

// ---------- map ----------
let basemap = null;
// A failed load isn't kept, so the next page tries again.
const getBasemap = () => basemap || (basemap = fetch('data/basemap.json').then(r => r.ok ? r.json() : null).catch(() => null)
  .then(j => { if (!j || typeof j !== 'object') { basemap = null; return null; } return j; }));
const tok = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
/* Carto's free basemaps started answering every request with an "API KEY
   REQUIRED" watermark tile (checked 18 Oct 2026), so the tile layer is only
   added once N.tiles points somewhere else or carries a key. Until then the
   map is drawn from data/basemap.json alone: land, parks and main roads,
   which also means it looks the same with no signal. */
const tilesOk = t => !!(t && typeof t.url === 'string' && t.url && (!/basemaps\.cartocdn\.com/.test(t.url) || /[?&](api_?key|key|token)=/i.test(t.url)));
async function drawMap(box, p, alive) {
  const L = await N.loadLeaflet();
  if (!alive() || !box.isConnected) return null;
  const t = N.tiles(N.isDark());
  const tiles = tilesOk(t);
  const map = L.map(box, {zoomControl: false, dragging: false, touchZoom: false, scrollWheelZoom: false, doubleClickZoom: false,
    boxZoom: false, keyboard: false, tap: false, inertia: false, zoomSnap: .25, fadeAnimation: false, zoomAnimation: false});
  map.attributionControl.setPrefix(false).setPosition('bottomleft');
  map.setView([p.lat, p.lon], tiles ? 15.75 : 15);
  map.panBy([0, -22], {animate: false}); // the pin stands above its point, so nudge it to look centred
  const pane = map.createPane('plBase');
  pane.style.zIndex = 150;
  pane.style.pointerEvents = 'none';
  // With no streets to draw (basemap not saved, no tile layer) a pin on a flat colour says
  // nothing, so the map is left out and the address card stands alone.
  const blank = () => { if (!tiles && alive() && box.isConnected && box.parentElement) box.parentElement.classList.add('pl-nomap'); };
  getBasemap().then(gj => {
    if (!alive() || !map._loaded) return;
    if (!gj) { blank(); return; }
    try {
      const c = {land: tok('--cr'), park: tok('--ok'), edge: tok('--ln'), road: tok('--tile')};
      const kind = f => f && f.properties && f.properties.k;
      const opts = style => ({pane: 'plBase', interactive: false, style});
      L.geoJSON(gj, {...opts(f => kind(f) === 'park'
        ? {stroke: false, fill: true, fillColor: c.park, fillOpacity: .26}
        : {stroke: false, fill: true, fillColor: c.land, fillOpacity: 1}),
        filter: f => kind(f) === 'land' || kind(f) === 'park'}).addTo(map);
      const roads = f => kind(f) === 'major' || kind(f) === 'road';
      L.geoJSON(gj, {...opts(f => ({color: c.edge, weight: kind(f) === 'major' ? 8 : 6, opacity: 1, fill: false, lineCap: 'round'})), filter: roads}).addTo(map);
      L.geoJSON(gj, {...opts(f => ({color: c.road, weight: kind(f) === 'major' ? 5.5 : 3.5, opacity: 1, fill: false, lineCap: 'round'})), filter: roads}).addTo(map);
      if (!tiles) map.attributionControl.addAttribution('NYC Open Data · US Census');
    } catch { blank(); }
  });
  if (tiles) L.tileLayer(t.url, t.opts).addTo(map);
  L.marker([p.lat, p.lon], {interactive: false, keyboard: false,
    icon: L.divIcon({className: 'pl-pin', html: `<span>${icon('tools-kitchen-2')}</span>`, iconSize: [40, 48], iconAnchor: [20, 46]})}).addTo(map);
  return map;
}

// ---------- screen ----------
N.screen('place', {
  nav: 4,
  back: 'food',
  tone: 'band',
  // 'force' too: core's rerender() checks `uses` before it checks for a forced
  // repaint, so without it the theme switch and N.rerender() skip this screen
  // (and the map would keep the old theme's colours).
  uses: ['food', 'trip', 'force'],
  title: ctx => { const p = placeFor(ctx); return p && nameOf(p) || 'Place'; },
  render(ctx) {
    const p = placeFor(ctx);
    if (!p) return missing();
    return {
      hero: heroHtml(p),
      body: h`<div class="pl-body">
        ${safe(() => quickActs(p), 'actions')}
        ${safe(() => overview(p), 'overview')}
        ${safe(() => toOrder(p), 'order')}
        ${safe(() => opinions(p), 'opinions')}
        ${safe(() => hoursHtml(p), 'hours')}
        ${safe(() => detailsHtml(p), 'details')}
        ${safe(footer, 'footer')}
      </div>`,
    };
  },
  mount(ctx, view) {
    const p = placeFor(ctx);
    if (!p) return null;
    const hash = ctx.hash;
    let dead = false, map = null, raf = 0;
    const app = N.$('#app') || view;
    app.addEventListener('error', onImgError, true);

    // photo counter on the strip
    const gal = N.$('.pl-gal', view), cnt = N.$('[data-pl="cnt"]', view);
    const onGal = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const s = N.$$('.pl-ph', gal);
        if (s.length < 2 || !cnt) return;
        const step = s[1].offsetLeft - s[0].offsetLeft || 1;
        const max = gal.scrollWidth - gal.clientWidth;
        const i = gal.scrollLeft >= max - 4 ? s.length - 1 : N.clamp(Math.round(gal.scrollLeft / step), 0, s.length - 1);
        cnt.textContent = `${i + 1} / ${s.length}`;
      });
    };
    if (gal) gal.addEventListener('scroll', onGal, {passive: true});

    // distance from you
    const paintStat = () => { const el = N.$('[data-pl="stat"]', view); if (el) el.innerHTML = String(safe(() => statusRow(p), 'status')); };
    const offWhere = N.on('where', paintStat);
    if (hasLL(p) && N.whereOk() && N.where) N.where().then(w => { if (!dead && w) paintStat(); }).catch(() => {});

    // small street map, after the page has slid in
    const box = N.$('[data-pl="map"]', view);
    let gen = 0;
    const draw = () => {
      const g = ++gen;
      if (map) { try { map.remove(); } catch { /* already gone */ } map = null; }
      if (box.parentElement) box.parentElement.classList.remove('pl-nomap');
      drawMap(box, p, () => !dead && g === gen).then(m => { if ((dead || g !== gen) && m) m.remove(); else if (m) map = m; })
        .catch(() => { if (!dead && box.isConnected) box.parentElement.classList.add('pl-nomap'); });
    };
    const mt = box ? setTimeout(draw, 320) : 0;
    // the phone switching light/dark by itself doesn't re-render, so recolour the map here
    const mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
    const onScheme = () => { if (!dead && box && map && !document.documentElement.dataset.theme) draw(); };
    if (mq && mq.addEventListener) mq.addEventListener('change', onScheme);

    // re-open the viewer if the page re-rendered under it
    if (reopen && reopen.id === p.id) { const r = reopen; reopen = null; openLb(p, r.idx, true); }
    reopen = null;

    return () => {
      dead = true;
      clearTimeout(mt);
      cancelAnimationFrame(raf);
      offWhere();
      if (mq && mq.removeEventListener) mq.removeEventListener('change', onScheme);
      app.removeEventListener('error', onImgError, true);
      if (gal) gal.removeEventListener('scroll', onGal);
      if (lb) {
        if (N.route().hash === hash) reopen = {id: p.id, idx: lb.idx};
        closeLb(true);
      }
      if (map) { try { map.remove(); } catch { /* already gone */ } map = null; }
    };
  },
  tick(ctx) {
    const p = placeFor(ctx);
    if (!p) return;
    const stat = N.$('[data-pl="stat"] .pl-chip');
    if (stat && !stat.matches('button')) stat.outerHTML = String(hoursChip(p));
    const now = N.$('[data-pl="hnow"] .pl-chip');
    if (now) now.outerHTML = String(hoursChip(p));
  },
  actions: {
    photo(el, ev, ctx, arg) { const p = placeFor(ctx); if (p) openLb(p, +arg || 0); },
    lbClose() { closeLb(); },
    lbDone() { if (lb) lb.unzoom(); },
    lbStep(el, ev, ctx, arg) { stepLb(+arg || 1); },
    async locate(el) {
      if (el.disabled) return;
      el.disabled = true;
      const label = el.lastChild;
      if (label) label.textContent = 'Finding you…';
      let w = null;
      try { w = await N.where({fresh: true}); } catch { w = null; }
      const p = placeFor(N.current() && N.current().ctx);
      // N.where() gives null for "denied" and for "no fix in time" alike, so the wording covers both
      // (same words as the food list). A fix far from this place hides the chip, so say why.
      if (!w) N.toast('Couldn’t get your location. Check Location Services in Settings.');
      else if (p && hasLL(p) && food().away && food().away(p) > FAR) N.toast('You’re not in New York yet. Distances show once you’re there.');
      const box = N.$('[data-pl="stat"]');
      if (p && box) box.innerHTML = String(safe(() => statusRow(p), 'status'));
      if (el.isConnected) { el.disabled = false; if (label) label.textContent = 'Distance'; }
    },
  },
});
})();
