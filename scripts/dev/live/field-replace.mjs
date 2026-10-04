// Live: Field Cleaner → "Replace with another field" on the fixture
// (docs/fixtures/field-cleaner-fixture: Account.SFTK_FC_Test_Status__c →
// Account.SFTK_FC_Test_Status2__c, the same picklist without "Closed").
//   STEP=scan        pick both fields, scan, report what the page says (nothing written) — default
//   STEP=access      🔑 copy the old field's access to the new field
//   STEP=flow        ⇄ Replace on a flow (FLOW=<label>, default "SFTK FC Test Flow 2")
//   STEP=layout      ⇄ Replace on the first layout row
//   STEP=page        ⇄ Replace on the first Lightning page row
//   STEP=report      ⇄ Replace on the first report row
//   SCAN_ONLY=1      open the dialog, log it, cancel
//   FROM / TO        the two field API names (defaults: the fixture's)
//   UNDO=1           Data Studio › History › ↩ Undo the newest entry afterwards
import { undoNewest } from './_undo.mjs';
const NL = String.fromCharCode(10);
const dump = async (h, sel, n = 2500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
// The shared confirmation: log it, pick the active-version choice when there is one, acknowledge, Go (+ the typed org name when guarded).
async function confirm(h, what, activeMode) {
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 90000, 500);
  await h.sleep(500);
  h.log(`DIALOG (${what}):`, (await h.eval(`(document.querySelector('#modalBox')?.innerText || '')`)).split(NL).map(x => x.trim()).filter(Boolean).join(' | ').slice(0, 3500));
  const modes = await h.eval(`[...document.querySelectorAll('input[name="fcActiveMode"]')].map(r => r.value + (r.disabled ? '(off)' : '') + (r.checked ? '*' : ''))`);
  if (modes.length) {
    h.log('active-version choices:', JSON.stringify(modes));
    if (activeMode) await h.eval(`(() => { const r = document.querySelector('input[name="fcActiveMode"][value="${activeMode}"]'); if (r && !r.disabled) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
  }
  if (process.env.SCAN_ONLY === '1') { await h.eval(`document.querySelector('#sftkConfirmCancel')?.click()`); h.log('SCAN_ONLY — cancelled'); return false; }
  if (process.env.BACKUP !== '1') await h.eval(`(() => { const b = document.querySelector('#fcFlowBackup'); if (b && b.checked) { b.checked = false; b.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
  await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
  await h.sleep(300);
  h.log('Go:', await h.eval(`(() => { const g = document.querySelector('#sftkConfirmGo'); return g.textContent.trim() + (g.disabled ? ' (off)' : ''); })()`));
  if (await h.eval(`document.querySelector('#sftkConfirmGo').disabled`)) { await h.eval(`document.querySelector('#sftkConfirmCancel')?.click()`); return false; }
  await h.eval(`document.querySelector('#sftkConfirmGo').click()`);
  await h.sleep(600);
  if (await h.eval(`!!document.querySelector('#sftkConfirmProd')`)) {
    await h.eval(`(() => { const i = document.querySelector('#sftkConfirmProd'); i.value = i.placeholder; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await h.eval(`document.querySelector('#sftkConfirmProdGo')?.click()`);
  }
  return true;
}
async function fixRow(h, type, name, activeMode) {
  const sel = `.fc-fix-btn[data-type="${type}"]${name ? `[data-name="${name}"]` : ''}:not([disabled]):not(.fc-xml-fix)`;
  const btn = await h.eval(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); return b ? b.textContent.trim() + ' · ' + b.dataset.name : null; })()`);
  h.log(`${type} button:`, btn);
  if (!btn) return;
  await h.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);
  if (!(await confirm(h, type, activeMode))) return;
  await h.waitFor("!document.querySelector('#sftkConfirmGo') && !document.querySelector('.fc-fix-btn[disabled]')", 600000, 1000);
  await h.sleep(2500);
  h.log('DONE LABELS:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.fc-item-ok')].map(e => e.innerText)`)));
  h.log('INLINE ERRORS:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.fc-item-err')].map(e => e.innerText.slice(0, 700))`)));
}

export default async function (h) {
  const FROM = process.env.FROM || 'SFTK_FC_Test_Status__c', TO = process.env.TO || 'SFTK_FC_Test_Status2__c';
  await h.login('npc');
  await h.popup('fields');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', 'Account');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', FROM);
  // step 3: the replacement picker loads the object's describe, then offers fields of the same type only
  await h.waitFor("!document.querySelector('#fcReplInput')?.disabled || !!document.querySelector('#fcReplNote .fc-repl-bad')", 60000, 500);
  h.log('REPLACE STEP:', await dump(h, '#fcReplStep', 700));
  if (process.env.NO_REPLACE !== '1') {
    await h.eval(`(() => { const i = document.querySelector('#fcReplInput'); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
    await h.sleep(500);
    h.log('candidates:', JSON.stringify(await h.eval(`[...document.querySelectorAll('#fcReplDrop .fc-dd-item')].map(e => e.dataset.api)`)));
    await pick(h, '#fcReplInput', '#fcReplDrop', TO);
    h.log('REPLACE NOTE:', await dump(h, '#fcReplNote', 900));
  }
  await h.shot(h.shots + '/fr-picked.png');
  await h.click('#fcScanBtn');
  await h.waitFor("/reference|Nothing references|No references|found|dependenc/i.test(document.querySelector('#fcResults')?.innerText || '') && !/scanning|⏳/i.test(document.querySelector('#fcScanBtn')?.innerText || '')", 180000, 1000);
  await h.sleep(3500);
  h.log('MODE BAR:', await dump(h, '#fcReplBar', 400));
  h.log('RESULTS:', await dump(h, '#fcResults', 3500));
  h.log('fix buttons:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.fc-fix-btn, .fc-fix-all')].map(b => b.textContent.trim() + (b.dataset.name ? ' · ' + b.dataset.name : ''))`)));
  h.log('ACCESS:', await dump(h, '#fcFlsPanel', 700));
  await h.shot(h.shots + '/fr-results.png');
  const step = (process.env.STEP || 'scan').toLowerCase();
  if (step === 'scan') return;
  if (step === 'access') {
    if (!(await h.eval(`!!document.querySelector('#fcFlsCopyBtn')`))) { h.log('no copy-access button'); return; }
    await h.eval(`document.querySelector('#fcFlsCopyBtn').click()`);
    if (!(await confirm(h, 'copy access'))) return;
    await h.waitFor("!document.querySelector('#fcFlsCopyBtn')", 120000, 500);
    await h.sleep(1500);
    h.log('ACCESS after:', await dump(h, '#fcFlsCopy', 700));
  }
  if (step === 'flow')   await fixRow(h, 'Flow', process.env.FLOW || 'SFTK FC Test Flow 2', process.env.ACTIVE || 'replace');
  if (step === 'layout') await fixRow(h, 'Layout', process.env.NAME || '');
  if (step === 'page')   await fixRow(h, 'FlexiPage', process.env.NAME || '');
  if (step === 'report') await fixRow(h, 'Report', process.env.NAME || '');
  h.log('RESULTS after:', await dump(h, '#fcResults', 2500));
  await h.shot(h.shots + '/fr-after.png');
  if (process.env.UNDO === '1') await undoNewest(h);
}
