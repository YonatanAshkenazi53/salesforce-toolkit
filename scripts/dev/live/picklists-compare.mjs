// Live: Picklist Manager, "Compare across orgs" — the value×org matrix for
// Account.SFTK_FC_Test_Status__c in trailheads5 (New active; Closed, Reviewed inactive) and
// trailheads4 (New, Reviewed, Closed, Archived all active), then one action:
//   MODE=matrix   load and report the matrix only (default)
//   MODE=sync     🔄 Sync from source: source = trailheads5, plan → run → matrix after
//   MODE=bulk     ⏸ Deactivate… the value in VALUE (default Archived) in every org that has it,
//                 FIX=clear|remap|skip (default skip)
//   SCAN_ONLY=1   stop before the run
import { undoNewest } from './_undo.mjs';   // UNDO=1: Data Studio › History › ↩ Undo the newest entry afterwards
const dump = async (h, sel, n = 2500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
async function setSelect(h, sel, match) {
  return h.eval(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); if (!s) return 'no select'; const o = [...s.options].find(o => o.value === ${JSON.stringify(match)}) || [...s.options].find(o => (o.textContent + ' ' + o.value).includes(${JSON.stringify(match)})); if (!o) return 'no option for ' + ${JSON.stringify(match)}; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return 'set ' + o.value; })()`);
}
async function matrix(h) {
  return h.eval(`(() => { const cols = [...document.querySelectorAll('.ds-pk-mx-head .ds-pk-mx-col')].map(c => (c.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60)); const rows = [...document.querySelectorAll('.ds-pk-mx-row:not(.ds-pk-mx-head)')].map(r => (r.querySelector('.ds-pk-mx-val')?.textContent || '?') + ' → ' + [...r.querySelectorAll('.ds-pk-mx-cell')].map(c => (c.classList.contains('ds-pk-mx-absent') ? 'absent' : c.classList.contains('ds-pk-mx-na') ? 'n/a' : c.classList.contains('ds-pk-mx-active') ? 'active' : 'inactive') + '(' + (c.querySelector('.ds-pk-mx-cnt')?.textContent || '') + ')').join(' | ')); return { cols, rows }; })()`);
}
export default async function (h) {
  await h.login('npc'); await h.login('npc2');
  await h.studio('');
  await h.watchErrors();
  await h.eval(`document.querySelector('[data-view="picklists"]')?.click()`);
  await h.waitFor("!!document.querySelector('[data-pk-mode=\"compare\"]')", 60000, 500);
  await h.eval(`document.querySelector('[data-pk-mode="compare"]')?.click()`);
  await h.waitFor("document.querySelectorAll('[data-pk-cmporg]').length > 0 || !!document.querySelector('#dsPkCmpObj')", 60000, 500);
  await h.sleep(800);
  h.log('banner:', await dump(h, '.ds-pk-cmp-config', 300));
  const orgs = await h.eval(`(() => { let n = 0; document.querySelectorAll('[data-pk-cmporg]').forEach(c => { if (!c.checked) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); } n++; }); return n; })()`);
  h.log('org checkboxes ticked:', orgs);
  await h.waitFor("document.querySelectorAll('#dsPkCmpObj option').length > 2", 120000, 500);
  h.log('object:', await setSelect(h, '#dsPkCmpObj', 'Account'));
  await h.waitFor("document.querySelectorAll('#dsPkCmpField option').length > 1 && !/Loading/.test(document.querySelector('#dsPkCmpField')?.innerText || '')", 120000, 500);
  h.log('field:', await setSelect(h, '#dsPkCmpField', 'SFTK_FC_Test_Status__c'));
  await h.sleep(400);
  h.log('cost:', await dump(h, '#dsPkMatrixCost', 300));
  await h.eval(`document.querySelector('#dsPkCmpLoad')?.click()`);
  await h.waitFor("document.querySelectorAll('.ds-pk-mx-row').length > 1 || /could not|failed|error/i.test(document.querySelector('#dsPkBody')?.innerText || '')", 180000, 1000);
  await h.sleep(2500);
  const m = await matrix(h);
  h.log('MATRIX cols:', JSON.stringify(m.cols)); h.log('MATRIX rows:', JSON.stringify(m.rows));
  h.log('buttons:', JSON.stringify(await h.eval(`['#dsPkBulkDeact', '#dsPkBulkDel', '#dsPkSyncBtn'].map(s => { const b = document.querySelector(s); return b ? b.textContent.trim() + (b.disabled ? ' (off)' : '') : s + ' missing'; })`)));
  await h.shot(h.shots + '/pk-matrix.png');
  const mode = (process.env.MODE || 'matrix').toLowerCase();
  if (mode === 'matrix') return;

  if (mode === 'sync') {
    // Campaign 3 phase 2: the plan's Run became the shared confirm dialog's
    // own #sftkConfirmGo footer button; Cancel is #sftkConfirmCancel; the
    // typed production step is #sftkConfirmProd / #sftkConfirmProdCancel.
    // Once confirmed, a SEPARATE progress modal (#dsPkSyncClose) shows the run.
    await h.eval(`document.querySelector('#dsPkSyncBtn')?.click()`);
    await h.waitFor("!!document.querySelector('#sftkConfirmGo') || !!document.querySelector('.ds-toast')", 60000, 500);
    await h.sleep(800);
    if (await h.eval(`!!document.querySelector('#dsPkSyncSrc')`)) h.log('source:', await setSelect(h, '#dsPkSyncSrc', 'trailheads5'));
    await h.sleep(800);
    h.log('PLAN:', await dump(h, '#dsModalBox', 3000));
    await h.waitFor("!document.querySelector('#sftkConfirmGo')?.disabled || /nothing to|no change|identical/i.test(document.querySelector('#dsModalBox')?.innerText || '')", 180000, 1000);
    h.log('AUTO NOTE:', await dump(h, '#dsPkSyncAutoNote', 600));
    h.log('ops:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.ds-sync-one, .ds-sync-op')].map(c => (c.dataset.op || '?') + ':' + (c.dataset.val || '') + (c.checked ? '*' : '') + (c.disabled ? '(off)' : ''))`)));
    h.log('Run:', await h.eval(`(() => { const b = document.querySelector('#sftkConfirmGo'); return b ? b.textContent.trim() + (b.disabled ? ' (off)' : '') : 'missing'; })()`));
    await h.shot(h.shots + '/pk-sync-plan.png');
    if (process.env.SCAN_ONLY === '1') { h.log('SCAN_ONLY — cancelling'); await h.eval(`document.querySelector('#sftkConfirmCancel')?.click()`); return; }
    await h.eval(`(() => { window.__mxOld = document.querySelector('.ds-pk-mx-row'); document.querySelector('#sftkConfirmGo')?.click(); return true; })()`);
    await h.sleep(1500);
    if (await h.eval(`!!document.querySelector('#sftkConfirmProd')`)) { h.log('TYPED GATE:', await dump(h, '#dsModalBox', 500)); await h.eval(`document.querySelector('#sftkConfirmProdCancel')?.click()`); return; }
    await h.waitFor("(document.querySelector('.ds-pk-mx-row') && document.querySelector('.ds-pk-mx-row') !== window.__mxOld) || /done|finished|applied|failed/i.test((document.querySelector('#dsModalBox')?.innerText || '') + [...document.querySelectorAll('.ds-toast')].map(t => t.innerText).join(' '))", 300000, 1000);
    await h.sleep(3000);
    h.log('MODAL after:', await dump(h, '#dsModalBox', 2000));
    h.log('TOASTS:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.ds-toast')].map(t => t.innerText.replace(/\\s+/g, ' ').slice(0, 300))`)));
    await h.eval(`document.querySelector('#dsPkSyncClose')?.click()`); await h.sleep(500);
    await h.eval(`document.querySelector('#dsPkCmpLoad')?.click()`);
    await h.waitFor("document.querySelectorAll('.ds-pk-mx-row').length > 1", 180000, 1000); await h.sleep(2500);
    const m2 = await matrix(h); h.log('MATRIX after:', JSON.stringify(m2.rows));
    await h.shot(h.shots + '/pk-sync-after.png');
    if (process.env.UNDO === '1') await undoNewest(h);
    return;
  }

  if (mode === 'bulk') {
    const value = process.env.VALUE || 'Archived';
    await h.eval(`(() => { const c = document.querySelector('.ds-pk-mx-valchk[data-val=' + JSON.stringify(${JSON.stringify(value)}) + ']'); if (c && !c.checked) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); } return !!c; })()`);
    h.log('orgs in matrix:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.ds-pk-mx-orgchk')].map(c => c.dataset.org + (c.checked ? '*' : '') + (c.disabled ? '(off)' : ''))`)));
    await h.eval(`document.querySelector('#dsPkBulkDeact')?.click()`);
    // Campaign 3 phase 2: Apply became the shared confirm dialog's own
    // #sftkConfirmGo footer button; Cancel is #sftkConfirmCancel; the typed
    // production step is #sftkConfirmProd / #sftkConfirmProdCancel.
    await h.waitFor("!!document.querySelector('#sftkConfirmGo') || !!document.querySelector('.ds-toast')", 60000, 500);
    await h.sleep(800);
    h.log('BULK WIZARD:', await dump(h, '#dsModalBox', 1800));
    h.log('Apply before the check:', await h.eval(`(() => { const b = document.querySelector('#sftkConfirmGo'); return b ? b.textContent.trim() + (b.disabled ? ' (off)' : ' (ENABLED)') : 'missing'; })()`));
    // Apply opens only once every org's automation check answered
    await h.waitFor("!document.querySelector('#sftkConfirmGo')?.disabled", 240000, 1000);
    h.log('IMPACT:', await dump(h, '#dsPkBulkImpact', 800));
    h.log('Apply after the check:', await h.eval(`document.querySelector('#sftkConfirmGo')?.textContent.trim()`));
    const fix = (process.env.FIX || 'skip').toLowerCase();
    await h.eval(`(() => { const r = document.querySelector('input[name="dsPkBulkFix"][value=' + JSON.stringify(${JSON.stringify(fix)}) + ']'); if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } return !!r; })()`);
    if (process.env.SCAN_ONLY === '1') { h.log('SCAN_ONLY — cancelling'); await h.eval(`document.querySelector('#sftkConfirmCancel')?.click()`); return; }
    await h.eval(`document.querySelector('#sftkConfirmGo')?.click()`);
    await h.sleep(1500);
    if (await h.eval(`!!document.querySelector('#sftkConfirmProd')`)) { h.log('TYPED GATE:', await dump(h, '#dsModalBox', 500)); await h.eval(`document.querySelector('#sftkConfirmProdCancel')?.click()`); return; }
    await h.waitFor("/Done|finished/i.test(document.querySelector('#dsPkBulkResult')?.innerText || '')", 300000, 1000);
    await h.sleep(1000);
    h.log('BULK RESULT:', await dump(h, '#dsPkBulkResult', 2000));
    await h.shot(h.shots + '/pk-bulk-result.png');
    await h.eval(`document.querySelector('#dsPkCmpLoad')?.click()`);
    await h.waitFor("document.querySelectorAll('.ds-pk-mx-row').length > 1", 180000, 1000); await h.sleep(2500);
    const m3 = await matrix(h); h.log('MATRIX after:', JSON.stringify(m3.rows));
  }
  if (process.env.UNDO === '1') await undoNewest(h);
}
