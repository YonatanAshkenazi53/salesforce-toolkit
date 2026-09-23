// Live: 📄 Lightning Pages (popup) on the fixture record page SFTK_LP_Test_Account_Page
// (docs/fixtures/lightning-page-fixture, Account, never assigned): open its detail, set it as
// the org default for Desktop (a CustomObject.actionOverrides deploy), read the assignment back,
// then remove it again. CLI-verify between steps.
//   PAGE="SFTK LP Test Account Page"   STEP=detail|orgdefault|remove|cycle (default cycle)   SCAN_ONLY=1
const dump = async (h, sel, n = 2500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
async function openDetail(h, page) {
  await h.eval(`(() => { const i = document.querySelector('#lpSearch'); if (i) { i.value = ${JSON.stringify(page)}; i.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`);
  await h.sleep(800);
  const clicked = await h.eval(`(() => { const r = [...document.querySelectorAll('.lp-row')].find(x => (x.querySelector('.lp-row-name')?.textContent || '').trim() === ${JSON.stringify(page)}); if (!r) return 'row not found among ' + document.querySelectorAll('.lp-row').length; r.click(); return 'opened ' + r.dataset.id; })()`);
  await h.waitFor("!!document.querySelector('#lpDetailBody') && !/Loading/.test(document.querySelector('#lpDetailBody')?.innerText || '')", 120000, 1000);
  await h.sleep(1200);
  return clicked;
}
async function modalGo(h, tag) {
  await h.waitFor("!!document.querySelector('#modalConfirm')", 30000, 300); await h.sleep(300);
  h.log(`CONFIRM (${tag}):`, await h.eval(`(document.querySelector('#modalBox')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 600)`));
  if (process.env.SCAN_ONLY === '1') { await h.eval(`document.querySelector('#modalCancel')?.click()`); h.log('SCAN_ONLY — cancelled'); return false; }
  await h.eval(`document.querySelector('#modalConfirm').click()`);
  return true;
}
export default async function (h) {
  await h.login('npc');
  await h.popup('pages');
  await h.watchErrors();
  await h.waitFor("document.querySelectorAll('.lp-row').length > 0", 240000, 1000);
  await h.sleep(800);
  const page = process.env.PAGE || 'SFTK LP Test Account Page';
  h.log('rows:', await h.eval(`document.querySelectorAll('.lp-row').length`), '| open:', await openDetail(h, page));
  h.log('HEADER:', await dump(h, '#lpDetailHeader', 400));
  h.log('DETAIL:', await dump(h, '#lpDetailBody', 1800));
  await h.shot(h.shots + '/lp-detail.png');
  const step = (process.env.STEP || 'cycle').toLowerCase();
  if (step === 'detail') return;
  if (step === 'orgdefault' || step === 'cycle') {
    await h.eval(`document.querySelector('#lpTabOrgDefault')?.click()`); await h.sleep(400);
    h.log('org default boxes:', JSON.stringify(await h.eval(`['#lpOrgDefDesktop', '#lpOrgDefMobile'].map(s => { const c = document.querySelector(s); return c ? s + ':' + (c.checked ? 'on' : 'off') + (c.disabled ? '(off)' : '') : s + ' missing'; })`)));
    await h.eval(`(() => { const d = document.querySelector('#lpOrgDefDesktop'); if (d && !d.disabled) d.checked = true; const m = document.querySelector('#lpOrgDefMobile'); if (m && !m.disabled) m.checked = false; return true; })()`);
    h.log('add button:', await h.eval(`(() => { const b = document.querySelector('#lpAddBtnOrgDef'); return b ? b.textContent.trim() + (b.disabled ? ' (off)' : '') : 'missing'; })()`));
    await h.eval(`document.querySelector('#lpAddBtnOrgDef')?.click()`);
    await h.sleep(1500);
    if (await h.eval(`!!document.querySelector('#modalConfirm')`)) { if (!(await modalGo(h, 'org default'))) return; }
    await h.waitFor("!/Deploying|⏳/.test((document.querySelector('#lpDetailBody')?.innerText || '') + (document.querySelector('#lpAddErrOrgDef')?.innerText || ''))", 300000, 1000);
    await h.sleep(1500);
    h.log('add error:', await dump(h, '#lpAddErrOrgDef', 400));
    h.log('DETAIL after add:', await dump(h, '#lpDetailBody', 1800));
    await h.shot(h.shots + '/lp-after-add.png');
    if (step === 'orgdefault') return;
  }
  if (step === 'remove' || step === 'cycle') {
    const rm = await h.eval(`(() => { const b = [...document.querySelectorAll('#lpDetailBody button')].find(x => /remove|✕|🗑/i.test(x.textContent) && !/tab|add/i.test(x.id || '')); if (!b) return 'no remove button; buttons: ' + [...document.querySelectorAll('#lpDetailBody button')].map(x => (x.id || '') + ':' + x.textContent.trim()).join(' | ').slice(0, 300); b.click(); return 'clicked ' + b.textContent.trim(); })()`);
    h.log('remove:', rm);
    if (!rm.startsWith('clicked')) return;
    if (!(await modalGo(h, 'remove'))) return;
    await h.waitFor("!/Deploying|⏳/.test(document.querySelector('#lpDetailBody')?.innerText || '')", 300000, 1000);
    await h.sleep(1500);
    h.log('DETAIL after remove:', await dump(h, '#lpDetailBody', 1200));
    await h.shot(h.shots + '/lp-after-remove.png');
  }
}
