// Live: the public build as the store gets it (SFTK_EXT=dist/store-staging), no org open —
//   • every page boots behind the licence gate: Decline blocks the page, "read again" →
//     Accept lets it through, and the acceptance is remembered across pages
//   • the cut tools are absent: no Debug button, no Pro toggle, no in-app guidance,
//     no Picklists / Sequences / Readiness navigation, no Licenses tab or home card;
//     SFTK_CUT in the packed build lists exactly those
//   • What's New opens on both pages; dark mode toggles on both; the Toolkit without
//     an org shows its session banner instead of a blank page
// Reads nothing from Salesforce.
const NL = String.fromCharCode(10);
const lines = (s, n = 1500) => String(s || '').slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const CUT = ['picklists', 'sequences', 'readiness', 'licenses', 'debug', 'pro', 'guidance'];

export default async function (h) {
  const ext = `chrome-extension://${h.extId}`;
  // ── the licence gate, by hand (h.studio() would accept it for us) ──
  await h.navigate(`${ext}/studio.html`); await h.sleep(2000);
  await h.watchErrors();
  const gate = await h.eval("/I confirm that any consequence/.test(document.body.innerText)");
  h.log(`studio.html: licence gate shown on first open: ${gate}`);
  if (!gate) throw new Error('no licence gate on a fresh profile');
  h.log('GATE:', lines(await h.eval("document.querySelector('#sftkTermsTitle')?.parentElement?.innerText || ''"), 600));
  h.log(`Accept disabled before the box: ${await h.eval("document.querySelector('#sftkTermsYes').disabled")}`);
  await h.click('#sftkTermsNo'); await h.sleep(800);
  const declined = await h.eval("document.body.innerText");
  h.log('after Decline:', lines(declined.slice(0, 400)));
  if (!/close this window|declined/i.test(declined)) throw new Error('Decline did not block the page with its message');
  const navUsable = await h.eval("!!document.querySelector('.ds-nav-btn') && getComputedStyle(document.querySelector('.ds-nav-btn')).pointerEvents !== 'none' && !document.querySelector('#sftkTermsAgain')");
  h.log(`page usable after Decline: ${navUsable} (must be false)`);
  if (navUsable) throw new Error('the page is usable after Decline');
  await h.click('#sftkTermsAgain'); await h.sleep(600);
  await h.eval("(() => { const cb = document.querySelector('#sftkTermsCb'); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
  h.log(`Accept enabled after the box: ${await h.eval("!document.querySelector('#sftkTermsYes').disabled")}`);
  await h.click('#sftkTermsYes'); await h.sleep(1000);
  await h.waitFor("!!document.querySelector('.ds-nav-btn') && !/I confirm that any consequence/.test(document.body.innerText)", 20000, 300);
  h.log(`studio usable after Accept: true · stored: ${await h.eval("new Promise(r => chrome.storage.local.get('sftk_terms_accepted', d => r(JSON.stringify(d.sftk_terms_accepted || null))))")}`);
  // remembered on the other pages
  for (const page of ['popup.html?tab=flows', 'apex-log-viewer.html']) {
    await h.navigate(`${ext}/${page}`); await h.sleep(2000);
    const again = await h.eval("/I confirm that any consequence/.test(document.body.innerText)");
    h.log(`${page}: gate shown again: ${again} (must be false) · title: ${await h.eval('document.title')}`);
    if (again) throw new Error(`${page} asked for the licence again`);
  }

  // ── Data Studio: cut tools absent, What's New, dark mode ──
  await h.studio('#/orgs'); await h.sleep(800);
  const cutList = await h.eval('JSON.stringify(window.SFTK_CUT || null)');
  h.log(`SFTK_CUT in the packed build: ${cutList}`);
  if (cutList !== JSON.stringify(CUT)) throw new Error('SFTK_CUT differs from the release scope');
  const navViews = await h.eval("[...document.querySelectorAll('.ds-nav-btn')].map(b => b.dataset.view)");
  h.log('nav views:', JSON.stringify(navViews));
  for (const v of ['picklists', 'seed', 'readiness']) if (navViews.includes(v)) throw new Error(`nav still offers ${v}`);
  const studioChecks = {
    'Debug button': await h.eval("!!document.querySelector('#dbgBtn')"),
    'Pro toggle': await h.eval("!!document.querySelector('#dsProToggle')"),
    'onboarding (SFTKOnboard)': await h.eval("typeof window.SFTKOnboard !== 'undefined'"),
    'debug logger can switch on': await h.eval("(() => { try { return typeof SFTKDebug !== 'undefined' && SFTKDebug.toggle ? (SFTKDebug.toggle(), !!SFTKDebug.enabled) : false; } catch (_) { return false; } })()"),
    'Licence button': await h.eval("!!document.querySelector('#sftkTermsBtn')"),
  };
  h.log('studio:', JSON.stringify(studioChecks));
  for (const [k, v] of Object.entries(studioChecks)) if (k === 'Licence button' ? !v : v) throw new Error(`studio: ${k} — ${v}`);
  const paletteCut = await h.eval("(() => { const items = (typeof CMD_TOOLKIT !== 'undefined' ? CMD_TOOLKIT : []).filter(t => sftkShips(t.tab)); return items.filter(t => /licen|picklist|sequence|readiness/i.test(t.label)).map(t => t.label); })()");
  h.log('palette Toolkit commands that name a cut tool (as the palette filters them):', JSON.stringify(paletteCut));
  if (paletteCut.length) throw new Error('the palette still offers a cut tool');
  await h.click('#dsWhatsNewTop'); await h.sleep(800);
  const wn = lines(await h.eval("document.querySelector('#dsWhatsNewBody')?.innerText || document.querySelector('#dsModalBox')?.innerText || ''"), 500);
  h.log("studio What's New:", wn);
  if (!wn) throw new Error("What's New opened nothing in Data Studio");
  if (/pro mode|readiness|picklist manager|sequences/i.test(wn)) throw new Error("What's New mentions a cut tool");
  await h.closeModal().catch(() => {}); await h.sleep(300);
  const themeBefore = await h.eval("document.documentElement.dataset.theme || getComputedStyle(document.body).backgroundColor");
  await h.click('#dsDarkToggle'); await h.sleep(600);
  const themeAfter = await h.eval("document.documentElement.dataset.theme || getComputedStyle(document.body).backgroundColor");
  h.log(`studio dark mode: ${themeBefore} → ${themeAfter}`);
  if (themeBefore === themeAfter) throw new Error('the dark toggle changed nothing in Data Studio');
  await h.eval("location.hash = '#/history'"); await h.sleep(800);
  h.log('dark History view draws:', lines(await h.eval("document.querySelector('#dsMain')?.innerText || ''"), 160));
  await h.eval("(() => { for (let i = 0; i < 3 && document.documentElement.classList.contains('ds-dark'); i++) document.getElementById('dsDarkToggle').click(); return true; })()"); await h.sleep(400);   // one button cycles light → dark → OLED → light

  // ── the Toolkit popup without an org: the session banner; cut tabs; What's New; dark ──
  await h.navigate(`${ext}/popup.html`); await h.sleep(2500);
  const banner = await h.eval("(() => { const b = document.querySelector('#sessionError'); return b && b.style.display !== 'none' ? b.innerText : ''; })()");
  h.log('popup without an org — banner:', lines(banner, 300) || '(none)');
  h.log('popup body says:', lines(await h.eval('document.body.innerText'), 300));
  if (!banner && !/open a salesforce|no salesforce tab|sign in|log in/i.test(await h.eval('document.body.innerText'))) throw new Error('the popup shows nothing about the missing org');
  const popupChecks = {
    'Debug button': await h.eval("!!document.querySelector('#dbgBtn')"),
    'Licenses tab': await h.eval("!!document.querySelector('[data-tab=\"licenses\"], #tab-licenses')"),
    'onboarding (SFTKOnboard)': await h.eval("typeof window.SFTKOnboard !== 'undefined'"),
    'Licence button': await h.eval("!!document.querySelector('#sftkTermsBtn')"),
    'History button': await h.eval("!!document.querySelector('#sftkThBtn')"),
  };
  h.log('popup:', JSON.stringify(popupChecks));
  for (const [k, v] of Object.entries(popupChecks)) if (/Licence button|History button/.test(k) ? !v : v) throw new Error(`popup: ${k} — ${v}`);
  h.log('home cards:', JSON.stringify(await h.eval("[...document.querySelectorAll('#homeView [data-tab], #homeView .home-card')].map(c => c.dataset.tab || c.innerText.trim().slice(0, 30))")));
  if (await h.eval("!!document.querySelector('#homeView [data-tab=\"licenses\"]')")) throw new Error('the home page still has a Licenses card');
  await h.click('#dsWhatsNewTop'); await h.sleep(800);
  const pwn = lines(await h.eval("document.querySelector('#tab-whatsnew')?.innerText || document.querySelector('#modalBox')?.innerText || ''"), 400);
  h.log("popup What's New:", pwn);
  if (!pwn) throw new Error("What's New opened nothing in the Toolkit");
  const pBefore = await h.eval("document.documentElement.dataset.theme || getComputedStyle(document.body).backgroundColor");
  await h.click('#sftkDarkToggle'); await h.sleep(600);
  const pAfter = await h.eval("document.documentElement.dataset.theme || getComputedStyle(document.body).backgroundColor");
  h.log(`popup dark mode: ${pBefore} → ${pAfter}`);
  if (pBefore === pAfter) throw new Error('the dark toggle changed nothing in the Toolkit');
  await h.click('#sftkDarkToggle'); await h.sleep(300);
  h.log(`page exceptions during the smoke: ${h.exceptions.length}`);
  if (h.exceptions.length) throw new Error('page exceptions: ' + h.exceptions.join(' ‖ ').slice(0, 500));
  h.log('✓ release smoke: gate (decline blocks, accept remembered), cut tools absent on both pages, What\'s New and dark mode on both, the popup says what is missing without an org');
}
