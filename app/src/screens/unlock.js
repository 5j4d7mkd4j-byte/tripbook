/* Unlock: the shared trip passphrase is typed once per phone. The derived key
   is kept on the phone; the passphrase itself is never stored. */
(() => {
const {h, icon} = N;
let busy = false;

N.screen('unlock', {
  tone: 'band',
  nav: false,
  static: true,
  strip: false,
  title: 'Unlock',
  render() {
    return {
      hero: h`<div class="unl-hero">
          <div class="ey">Trip companion</div>
          <div class="dp unl-big">New<br>York</div>
          <p class="unl-lede">Flights, connections, airports, the hotel and your food list. Works offline once opened.</p>
        </div>`,
      body: h`<form class="unl" id="unl-form" novalidate>
          <input type="text" name="username" autocomplete="username" value="nyc" hidden>
          <div class="stack">
            <label class="fld"><span>Trip passphrase</span>
              <div class="unl-row">
                <input class="inp" id="unl-pass" name="password" type="password" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="go" aria-describedby="unl-msg">
                <button type="button" class="ibtn unl-eye" data-act="peek" aria-label="Show passphrase" aria-pressed="false">${icon('eye')}</button>
              </div>
            </label>
            <div id="unl-msg" class="err" role="alert" hidden></div>
            <button type="submit" class="btn" id="unl-go" style="width:100%">${icon('lock-open')}Open trip</button>
            <div class="co plain">${icon('shield-check')}<span><b>Once per phone.</b> Type it here once. Anything you add to Wallet later stays on this phone.</span></div>
          </div>
        </form>`,
    };
  },
  mount() {
    // A real form, so iOS Keychain offers to fill and save the passphrase.
    const form = N.$('#unl-form');
    const onSubmit = ev => { ev.preventDefault(); go(); };
    form.addEventListener('submit', onSubmit);
    return () => form.removeEventListener('submit', onSubmit);
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

// bad: the passphrase itself is at fault, so outline the field.
function say(msg, bad = !!msg) {
  const m = N.$('#unl-msg');
  if (!m) return;
  m.textContent = msg || '';
  m.hidden = !msg;
  N.$('#unl-pass').classList.toggle('bad', bad);
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
  if (!err) say('That passphrase didn’t open the trip. Check the spelling; spaces and capitals don’t matter.');
  else say(navigator.onLine === false ? 'No connection. The first unlock needs internet; after that it works offline.' : 'Couldn’t load the trip. Try again.', false);
  inp.select();
}
})();
