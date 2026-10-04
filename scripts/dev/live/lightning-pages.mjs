// Live: 📄 Lightning Pages (popup) on the fixtures of docs/fixtures/lightning-page-fixture
// (record page SFTK_LP_Test_Account_Page, app SFTK_LP_Test_App) and, as a second Account page,
// docs/fixtures/field-cleaner-fixture/surfaces (SFTK FC Test Page). CLI-verify between steps
// (describe actionOverrides = org default; CustomApplication.profileActionOverrides = app rows).
//   PAGE="SFTK LP Test Account Page"
//   STEP=detail        open the detail, report it (nothing written)
//   STEP=orgdefault    set as org default (FF=desktop|mobile|both, default desktop)
//   STEP=remove        ✕ the first assignment row (ROW=<text to match> picks another)
//   STEP=cycle         orgdefault, then remove  (the default)
//   STEP=appdefault    App Default for the app labelled APP (default "SFTK LP Test App"); FF=mobile
//   STEP=artp          App + Record Type + Profile: APP, PROFILE (default "Standard User"), RT=<name>|ALL (default: the first)
//   STEP=deactivate    ⏸ Deactivate = remove every assignment of the page
//   STEP=clone         📋 Clone (LABEL, API; COPY=1 ticks "copy assignments")
//   STEP=users         👥 Show affected users on the first profile row
//   STEP=whosees       "Who sees what?" → Show users on the first org-default row
//   SCAN_ONLY=1        open the confirmation, log it, cancel
import { undoNewest } from './_undo.mjs';   // UNDO=1: Data Studio › History › ↩ Undo the newest entry afterwards (TYPE_IT=1 for a guarded org)
const NL = String.fromCharCode(10);
const dump = async (h, sel, n = 2500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
async function openDetail(h, page) {
  await h.eval(`(() => { const i = document.querySelector('#lpSearch'); if (i) { i.value = ${JSON.stringify(page)}; i.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`);
  await h.sleep(800);
  const clicked = await h.eval(`(() => { const r = [...document.querySelectorAll('.lp-row')].find(x => (x.querySelector('.lp-row-name')?.textContent || '').trim() === ${JSON.stringify(page)}); if (!r) return 'row not found among ' + document.querySelectorAll('.lp-row').length; r.click(); return 'opened ' + r.dataset.id; })()`);
  // the detail is ready when its status bar is drawn (the loader names what it is reading meanwhile)
  await h.waitFor("!!document.querySelector('#lpDetailBody .lp-status-bar')", 180000, 1000);
  await h.sleep(1200);
  return clicked;
}
async function modalGo(h, tag) {
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 30000, 300); await h.sleep(300);
  h.log(`CONFIRM (${tag}):`, await h.eval(`(document.querySelector('#modalBox')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 1200)`));
  if (process.env.SCAN_ONLY === '1') { await h.eval(`document.querySelector('#sftkConfirmCancel')?.click()`); h.log('SCAN_ONLY — cancelled'); return false; }
  await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
  await h.sleep(200);
  await h.eval(`document.querySelector('#sftkConfirmGo').click()`);
  await h.sleep(400);
  if (await h.eval(`!!document.querySelector('#sftkConfirmProd')`)) {
    await h.eval(`(() => { const i = document.querySelector('#sftkConfirmProd'); i.value = i.placeholder; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await h.eval(`document.querySelector('#sftkConfirmProdGo')?.click()`);
  }
  return true;
}
// the detail is busy while it shows a loader / "Deploying" / a disabled add button
const settled = "!!document.querySelector('#lpDetailBody .lp-status-bar') && !document.querySelector('.lp-add-progress') && !document.querySelector('#sftkConfirmGo')";
async function after(h, tag) {
  await h.sleep(1500);
  await h.waitFor(settled, 300000, 1000);
  await h.sleep(1500);
  h.log(`RESULT (${tag}):`, await dump(h, '#lpResultNote', 500));
  h.log(`ERRORS (${tag}):`, JSON.stringify(await h.eval(`[...document.querySelectorAll('#lpDetailBody .error-banner, #lpDetailBody .lp-add-err')].filter(e => e.offsetParent !== null && e.innerText.trim()).map(e => e.innerText.trim().slice(0, 500))`)));
  h.log(`DETAIL after ${tag}:`, await dump(h, '#lpDetailBody', 1500));
  await h.shot(`${h.shots}/lp-after-${tag}.png`);
}

export default async function (h) {
  await h.login('npc');
  await h.popup('pages');
  await h.watchErrors();
  await h.waitFor("document.querySelectorAll('.lp-row').length > 0", 240000, 1000);
  await h.sleep(800);
  const step = (process.env.STEP || 'cycle').toLowerCase();
  if (step === 'whosees') {
    await h.eval(`document.querySelector('#lpProfileMapBtn').click()`);
    await h.waitFor("document.querySelectorAll('.lp-wsw-card').length > 0 && !document.querySelector('#lpWswLoad')", 600000, 1000);
    await h.sleep(1000);
    h.log('WHO SEES WHAT:', await dump(h, '#lpDetailBody', 1200));
    const n = await h.eval(`document.querySelectorAll('details.lp-od-users').length`);
    h.log('"Show users" blocks on org-default rows:', n);
    if (n) {
      await h.eval(`(() => { const d = document.querySelector('details.lp-od-users'); d.open = true; d.dispatchEvent(new Event('toggle')); return true; })()`);
      await h.waitFor("!/Loading users/.test(document.querySelector('details.lp-od-users')?.innerText || '')", 120000, 500);
      await h.sleep(500);
      h.log('SHOW USERS:', await dump(h, 'details.lp-od-users', 900));
    }
    await h.shot(h.shots + '/lp-whosees.png');
    return;
  }
  const page = process.env.PAGE || 'SFTK LP Test Account Page';
  h.log('rows:', await h.eval(`document.querySelectorAll('.lp-row').length`), '| open:', await openDetail(h, page));
  h.log('HEADER:', await dump(h, '#lpDetailHeader', 400));
  h.log('DETAIL:', await dump(h, '#lpDetailBody', 1800));
  await h.shot(h.shots + '/lp-detail.png');
  if (step === 'detail') return;

  if (step === 'orgdefault' || step === 'cycle') {
    const ff = (process.env.FF || 'desktop').toLowerCase();
    await h.eval(`document.querySelector('.lp-atab[data-tab="orgdefault"]')?.click()`); await h.sleep(400);
    h.log('org default boxes:', JSON.stringify(await h.eval(`['#lpOrgDefDesktop', '#lpOrgDefMobile'].map(s => { const c = document.querySelector(s); return c ? s + ':' + (c.checked ? 'on' : 'off') + (c.disabled ? '(locked)' : '') : s + ' missing'; })`)));
    await h.eval(`(() => { const set = (s, on) => { const c = document.querySelector(s); if (c && !c.disabled) { c.checked = on; c.dispatchEvent(new Event('change', { bubbles: true })); } }; set('#lpOrgDefDesktop', ${ff !== 'mobile'}); set('#lpOrgDefMobile', ${ff !== 'desktop'}); return true; })()`);
    h.log('add button:', await h.eval(`(() => { const b = document.querySelector('#lpAddBtnOrgDef'); return b ? b.textContent.trim() + (b.disabled ? ' (off)' : '') : 'missing'; })()`));
    await h.eval(`document.querySelector('#lpAddBtnOrgDef')?.click()`);
    await h.sleep(1500);
    if (await h.eval(`!!document.querySelector('#sftkConfirmGo')`)) { if (!(await modalGo(h, 'org default'))) return; }
    await after(h, 'orgdefault');
    if (step === 'orgdefault') { if (process.env.UNDO === '1') await undoNewest(h); return; }
  }
  if (step === 'appdefault') {
    const app = process.env.APP || 'SFTK LP Test App';
    await h.eval(`document.querySelector('.lp-atab[data-tab="appdefault"]')?.click()`); await h.sleep(500);
    h.log('apps offered:', await h.eval(`document.querySelectorAll('#lpAppDefList .lp-appdef-cb').length`), '| hint:', await dump(h, '.lp-draft-hint', 300));
    const ok = await h.eval(`(() => { const row = [...document.querySelectorAll('#lpAppDefList .lp-app-item')].find(r => r.querySelector('.lp-app-item-lbl').innerText.trim() === ${JSON.stringify(app)}); const c = row && row.querySelector('.lp-appdef-cb'); if (!c) return false; c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); const f = row.querySelector('.lp-app-ff-sel'); if (f && ${JSON.stringify(process.env.FF || '')} === 'mobile') f.value = 'Small'; return true; })()`);
    if (!ok) { h.log('app not offered:', app); return; }
    await h.sleep(300);
    h.log('add button:', await h.eval(`(() => { const b = document.querySelector('#lpAddBtnAppDef'); return b ? b.textContent.trim() + (b.disabled ? ' (off)' : '') : 'missing'; })()`));
    await h.eval(`document.querySelector('#lpAddBtnAppDef')?.click()`);
    if (!(await modalGo(h, 'app default'))) return;
    await after(h, 'appdefault');
  }
  if (step === 'artp') {
    const app = process.env.APP || 'SFTK LP Test App', prof = process.env.PROFILE || 'Standard User', rtName = process.env.RT || '';
    await h.eval(`document.querySelector('.lp-atab[data-tab="artp"]')?.click()`); await h.sleep(500);
    const ok = await h.eval(`(() => { const tick = c => { if (!c) return false; c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return true; };
      const txt = c => (c.closest('label')?.innerText || '').trim();
      const a = tick([...document.querySelectorAll('#lpARTPAppList .lp-artp-app-cb')].find(c => txt(c) === ${JSON.stringify(app)}));
      const p = tick([...document.querySelectorAll('#lpARTPProfileList .lp-artp-profile-cb')].find(c => txt(c) === ${JSON.stringify(prof)}));
      const rts = [...document.querySelectorAll('#lpARTPRTList .lp-artp-rt-cb')];
      if (rts.length) tick(${JSON.stringify(rtName)} === 'ALL' ? document.querySelector('#lpARTPRTAll') : (rts.find(c => txt(c) === ${JSON.stringify(rtName)}) || rts[0]));
      return a && p; })()`);
    if (!ok) { h.log('app or profile not offered:', app, prof); return; }
    await h.sleep(300);
    h.log('add button:', await h.eval(`(() => { const b = document.querySelector('#lpAddBtnARTP'); return b ? b.textContent.trim() + (b.disabled ? ' (off)' : '') : 'missing'; })()`));
    await h.eval(`document.querySelector('#lpAddBtnARTP')?.click()`);
    if (!(await modalGo(h, 'app + profile'))) return;
    await after(h, 'artp');
  }
  if (step === 'deactivate') {
    const b = await h.eval(`(() => { const b = document.querySelector('#lpDeactivateBtn'); return b ? b.textContent.trim() + (b.disabled ? ' (off)' : '') : null; })()`);
    h.log('status button:', b, '| an Activate button exists:', await h.eval(`!!document.querySelector('#lpActivateBtn')`));
    if (!b) return;
    await h.eval(`document.querySelector('#lpDeactivateBtn').click()`);
    if (!(await modalGo(h, step))) return;
    await after(h, step);
  }
  if (step === 'clone') {
    const label = process.env.LABEL || 'SFTK LP Clone Test', api = process.env.API || 'SFTK_LP_Clone_Test';
    await h.waitFor("!document.querySelector('#lpCloneBtn')?.disabled", 60000, 500);
    await h.eval(`document.querySelector('#lpCloneBtn').click()`);
    await h.waitFor("!!document.querySelector('#cloneConfirmBtn')", 20000, 300); await h.sleep(300);
    h.log('CLONE DIALOG:', await h.eval(`(document.querySelector('#modalBox')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 900)`));
    h.log('copy assignments box:', await h.eval(`(() => { const c = document.querySelector('#cloneCopyAssignments'); return c ? (c.checked ? 'ticked' : 'not ticked') + (c.disabled ? ' (off)' : '') : 'absent'; })()`));
    await h.eval(`(() => { const set = (s, v) => { const i = document.querySelector(s); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); }; set('#cloneLabel', ${JSON.stringify(label)}); set('#cloneApiName', ${JSON.stringify(api)});
      const c = document.querySelector('#cloneCopyAssignments'); if (c && !c.disabled) { c.checked = ${process.env.COPY === '1'}; c.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
    await h.sleep(300);
    if (process.env.SCAN_ONLY === '1') { await h.eval(`document.querySelector('#modalCancel')?.click()`); return; }
    await h.eval(`document.querySelector('#cloneConfirmBtn').click()`);
    await h.sleep(1000);
    if (await h.eval(`!!document.querySelector('#sftkConfirmGo')`)) { if (!(await modalGo(h, 'clone'))) return; }
    await h.waitFor("!document.querySelector('#cloneConfirmBtn') || !!(document.querySelector('#cloneError')?.innerText || '').trim()", 300000, 1000);
    h.log('clone error:', await dump(h, '#cloneError', 500));
    await after(h, 'clone');
    h.log('HEADER after clone:', await dump(h, '#lpDetailHeader', 300));
  }
  if (step === 'users') {
    const n = await h.eval(`document.querySelectorAll('.lp-users-btn').length`);
    h.log('"Show affected users" buttons:', n);
    if (!n) return;
    const slot = await h.eval(`(() => { const b = document.querySelector('.lp-users-btn'); const s = b.dataset.slot; b.click(); return s; })()`);
    await h.waitFor(`!/Loading users/.test(document.querySelector('#lpUsers${slot}')?.innerText || '')`, 60000, 500);
    await h.sleep(500);
    h.log('USERS:', await dump(h, `#lpUsers${slot}`, 600));
  }
  if (step === 'remove' || step === 'cycle') {
    const want = process.env.ROW || '';
    const rm = await h.eval(`(() => { const rows = [...document.querySelectorAll('.lp-asgn-row')]; const r = rows.find(x => !${JSON.stringify(want)} || x.innerText.includes(${JSON.stringify(want)})); const b = r && r.querySelector('.lp-rm-btn'); if (!b) return 'no remove button among ' + rows.length + ' row(s)'; const t = r.innerText.replace(/\\s+/g, ' ').slice(0, 120); b.click(); return 'clicked ✕ on: ' + t; })()`);
    h.log('remove:', rm);
    if (!rm.startsWith('clicked')) return;
    if (!(await modalGo(h, 'remove'))) return;
    await after(h, 'remove');
  }
  if (process.env.UNDO === '1') await undoNewest(h);
}
