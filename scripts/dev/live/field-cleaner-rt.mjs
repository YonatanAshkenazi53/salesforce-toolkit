// Live: Field Cleaner on a custom report type — the npc fixture SFTK_FC_Test_RT
// ("SFTK FC Test Accounts"), where Account.SFTK_FC_Test_Status__c is the only
// column of its section. Scan → the 📑 Report Types group → ✂ Remove (or
// ⇄ Replace) → the fix verified by re-reading the org → the CLI's view of the
// type printed by the runner afterwards.
//   REPLACE=1   ⇄ Replace with SFTK_FC_Test_Status2__c instead of ✂ Remove
//   UNDO=1      ↩ Undo from History afterwards (same session: the journal lives in this profile)
//   SCAN_ONLY=1 stop after the scan (nothing written)
// Put the fixture back between runs:
//   cd docs/fixtures/field-cleaner-fixture/reporttype && sf project deploy start -o npc --source-dir force-app
import { undoNewest } from './_undo.mjs';
const dump = async (h, sel, n = 2500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
async function passConfirm(h, what) {
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 60000, 500);
  await h.sleep(400);
  h.log(`CONFIRM (${what}):`, (await h.eval(`(document.querySelector('#modalBox')?.innerText || document.body.innerText)`)).replace(/\s+/g, ' ').slice(0, 900));
  await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
  await h.sleep(300);
  await h.eval(`document.querySelector('#sftkConfirmGo')?.click()`);
  await h.sleep(600);
  if (await h.eval(`!!document.querySelector('#sftkConfirmProd')`)) {
    await h.eval(`(() => { const i = document.querySelector('#sftkConfirmProd'); i.value = i.placeholder; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await h.eval(`document.querySelector('#sftkConfirmProdGo')?.click()`);
  }
}

export default async function (h) {
  const replace = process.env.REPLACE === '1';
  await h.login('npc');
  await h.popup('fields');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', 'Account');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', 'SFTK_FC_Test_Status__c');
  if (replace) {
    await h.waitFor("!document.querySelector('#fcReplInput')?.disabled", 60000, 500);
    await pick(h, '#fcReplInput', '#fcReplDrop', 'SFTK_FC_Test_Status2__c');
    h.log('replace note:', await dump(h, '#fcReplNote', 400));
  }
  h.log('cost line:', await dump(h, '#fcScanCost, .fc-scan-cost', 300));
  await h.click('#fcScanBtn');
  // the scan is done when the Report Types group (or the "no references" state) is on the page
  await h.waitFor("!!document.querySelector('.fc-fix-btn[data-type=\"ReportType\"]') || /no references|nothing uses/i.test(document.querySelector('#fcResults')?.innerText || '')", 300000, 1000);
  await h.sleep(1500);
  const groups = await h.eval(`[...document.querySelectorAll('#fcResults details > summary, #fcResults .fc-group-head, #fcResults h3, #fcResults h4')].map(e => e.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean)`);
  h.log('GROUPS:', JSON.stringify(groups));
  const rtRow = await h.eval(`(() => { const b = document.querySelector('.fc-fix-btn[data-type="ReportType"]'); return b ? (b.closest('.fc-item, .fc-row, li, tr, div')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 400) : null; })()`);
  h.log('REPORT TYPE ROW:', rtRow);
  if (!rtRow) { h.log('FAIL: no report type row — is the fixture deployed?'); await h.shot(h.shots + '/fc-rt-noscan.png'); return; }
  await h.eval(`document.querySelector('.fc-fix-btn[data-type="ReportType"]')?.scrollIntoView({ block: 'center' })`);
  await h.sleep(400);
  await h.shot(h.shots + '/fc-rt-scan.png');
  if (process.env.SCAN_ONLY === '1') return;
  const sel = `.fc-fix-btn[data-type="ReportType"][data-swap="${replace ? 1 : 0}"]:not([disabled])`;
  if (!(await h.eval(`!!document.querySelector(${JSON.stringify(sel)})`))) { h.log('FAIL: no fix button', sel, JSON.stringify(await h.eval(`[...document.querySelectorAll('.fc-fix-btn[data-type="ReportType"]')].map(b => b.outerHTML.slice(0, 200))`))); return; }
  await h.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);
  await passConfirm(h, replace ? 'replace' : 'remove');
  await h.waitFor("!document.querySelector('#sftkConfirmGo') && !document.querySelector('.fc-fix-btn[disabled]')", 300000, 1000);
  await h.sleep(2000);
  h.log('FIXED LABELS:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.fc-item-ok')].map(e => e.innerText)`)));
  h.log('INLINE ERRORS:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.fc-inline-error, .fc-item-err, [class*=inline-err]')].map(e => e.innerText.slice(0, 600))`)));
  h.log('snap log:', await dump(h, '#fcSnapLog', 600));
  h.log('tool history:', await dump(h, '#fcToolHist', 900));
  await h.eval(`document.querySelector('.fc-item-ok')?.scrollIntoView({ block: 'center' })`);
  await h.sleep(400);
  await h.shot(h.shots + '/fc-rt-after.png');
  if (process.env.UNDO === '1') { h.log('── undo ──'); h.log('SAID:', await undoNewest(h)); await h.sleep(1500); await h.shot(h.shots + '/fc-rt-undo.png'); }
}
