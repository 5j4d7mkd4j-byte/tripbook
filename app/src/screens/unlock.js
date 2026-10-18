/* Unlock: the shared trip passphrase is typed once per phone. The derived key
   is kept on the phone; the passphrase itself is never stored. */
(() => {
const {h, icon} = N;
let busy = false;

N.screen('unlock', {
  tone: 'band',
  static: true,
  strip: false,
  title: 'Unlock',
  render() {
    return {
      hero: h`<div class="unl-hero">
          <div class="ey">Trip companion</div>
          <div class="dp unl-big">New<br>York</div>
          <p class="unl-lede">Flights, connections, airports, getting to the hotel, and your food list. Works with no signal once opened.</p>
        </div>`,
      body: h`<div class="stack unl">
          <label class="fld"><span>Trip passphrase</span>
            <div class="unl-row">
              <input class="inp" id="unl-pass" type="password" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="go" aria-describedby="unl-msg">
              <button class="ibtn unl-eye" data-act="peek" aria-label="Show passphrase" aria-pressed="false">${icon('eye')}</button>
            </div>
          </label>
          <div id="unl-msg" class="err" role="alert" hidden></div>
          <button class="btn" id="unl-go" data-act="unlock" style="width:100%">${icon('lock-open')}Open trip</button>
          <div class="co plain">${icon('shield-check')}<span>Typed once on this phone. Names, confirmation codes and seats you add later in Wallet stay on this phone only.</span></div>
        </div>`,
    };
  },
  mount() {
    const inp = N.$('#unl-pass');
    const onKey = ev => { if (ev.key === 'Enter') { ev.preventDefault(); go(); } };
    inp.addEventListener('keydown', onKey);
    return () => inp.removeEventListener('keydown', onKey);
  },
  actions: {
    unlock: () => go(),
    peek(el) {
      const inp = N.$('#unl-pass');
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      el.setAttribute('aria-pressed', String(show));
      el.setAttribute('aria-label', show ? 'Hide passphrase' : 'Show passphrase');
      el.innerHTML = String(icon(show ? 'eye-off' : 'eye'));
    },
  },
});

function say(msg) {
  const m = N.$('#unl-msg');
  if (!m) return;
  m.textContent = msg || '';
  m.hidden = !msg;
  N.$('#unl-pass').classList.toggle('bad', !!msg);
}

async function go() {
  if (busy) return;
  const inp = N.$('#unl-pass'), btn = N.$('#unl-go');
  const pass = inp.value;
  if (!N.norm(pass)) { say('Type the passphrase you were sent.'); inp.focus(); return; }
  busy = true;
  btn.setAttribute('aria-disabled', 'true');
  btn.innerHTML = String(h`${icon('hourglass')}Checking…`);
  say('');
  let ok = false, err = null;
  try { ok = await N.unlock(pass); } catch (e) { err = e; }
  busy = false;
  if (ok) {
    inp.blur();
    btn.innerHTML = String(h`${icon('check')}Opening…`);
    await N.afterUnlock();
    return;
  }
  btn.removeAttribute('aria-disabled');
  btn.innerHTML = String(h`${icon('lock-open')}Open trip`);
  say(err ? 'No connection. The first unlock needs internet; after that it works offline.' : 'That passphrase didn’t open the trip. Check the spelling; spaces and capitals don’t matter.');
  inp.select();
}
})();
