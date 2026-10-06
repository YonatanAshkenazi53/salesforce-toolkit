// Live: Field Cleaner → "Replace with another field" on the fixture
// (docs/fixtures/field-cleaner-fixture: Account.SFTK_FC_Test_Status__c →
// Account.SFTK_FC_Test_Status2__c, the same picklist without "Closed").
//   STEP=scan        pick both fields, scan, report what the page says (nothing written) — default
//   STEP=access      🔑 copy the old field's access to the new field
//   STEP=flow        ⇄ Replace on a flow (FLOW=<label>, default "SFTK FC Test Flow 2")
//   STEP=flowall     the "… in all N Flows" button: one confirmation per FLOW, however many versions are listed
//   STEP=every       "Everything at once": ⇄ Replace all N (SWAP=0: ✂ Remove all N); CANCEL_AT=<n> cancels the n-th dialog (the walk must stop)
//   STEP=layout      ⇄ Replace on the first layout row
//   STEP=page        ⇄ Replace on the first Lightning page row
//   STEP=report      ⇄ Replace on the first report row
//   STEP=copy        📦 Stored values: compare the two fields, then copy (OVER=1 also overwrites; COMPARE_ONLY=1 stops after the compare)
//   STEP=rptscan     📊 the opt-in report sweep (COUNT_ONLY=1 stops at the quoted cost; THEN=report goes on to fix NAME=<report>)
//   ORG=npc2         run on trailheads4 instead of trailheads5
//   SCAN_ONLY=1      open the dialog, log it, cancel
//   SWAP=0           press ✂ Remove instead of ⇄ Replace on the item (replace mode shows both)
//   WAY=keep / off   on a flow that runs on the field: ✂ Remove · flow keeps running, or 🗑 Delete versions · flow off
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
  // every item has two buttons in replace mode: SWAP=0 presses ✂ Remove, the default presses ⇄ Replace
  // a flow that runs on the field has two ✂ buttons: WAY=keep (new active version) or WAY=off (delete the active one too)
  const way = (type === 'Flow' && process.env.WAY) ? `[data-swap="0"][data-way="${process.env.WAY}"]`
    : process.env.SWAP === '0' ? '[data-swap="0"]' : (process.env.NO_REPLACE === '1' ? '' : '[data-swap="1"]');
  const sel = `.fc-fix-btn[data-type="${type}"]${name ? `[data-name="${name}"]` : ''}${way}:not([disabled]):not(.fc-xml-fix)`;
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
  await h.login(process.env.ORG || 'npc');   // ORG=npc2 runs on trailheads4
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
  h.log('FLOW CARDS:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.fc-flow-card')].map(c => c.innerText.replace(/\\s+/g, ' ').slice(0, 600))`)));
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
  if (step === 'copy') {
    await h.waitFor("!!document.querySelector('#fcCopyCompare') || /holds no values|cannot be copied/.test(document.querySelector('#fcCopyVals')?.innerText || '')", 60000, 500);
    h.log('VALUES panel:', await dump(h, '#fcCopyVals', 700));
    if (!(await h.eval(`!!document.querySelector('#fcCopyCompare')`))) return;
    await h.eval(`document.querySelector('#fcCopyCompare').click()`);
    await h.waitFor("!!document.querySelector('#fcCopyGo') || !!document.querySelector('#fcCopyVals .fc-copy-bad')", 300000, 500);
    h.log('PLAN:', await dump(h, '#fcCopyVals', 1500));
    if (process.env.COMPARE_ONLY === '1') return;
    if (process.env.OVER === '1' && await h.eval(`!!document.querySelector('#fcCopyOver')`)) {
      await h.eval(`(() => { const c = document.querySelector('#fcCopyOver'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      await h.sleep(300);
      h.log('PLAN with overwrite:', await dump(h, '#fcCopyVals', 900));
    }
    if (await h.eval(`document.querySelector('#fcCopyGo')?.disabled !== false`)) { h.log('nothing to copy'); return; }
    await h.eval(`document.querySelector('#fcCopyGo').click()`);
    await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 30000, 300); await h.sleep(300);
    // no receipt download in a headless run
    await h.eval(`(() => { const c = document.querySelector('#fcCopyCsv'); if (c && c.checked) { c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
    if (!(await confirm(h, 'copy values'))) return;
    await h.waitFor("!!document.querySelector('#fcCopyResult .fc-copy-res')", 600000, 500);
    await h.sleep(800);
    h.log('COPY RESULT:', await dump(h, '#fcCopyResult', 900));
    h.log('PLAN after:', await dump(h, '#fcCopyVals', 900));
    await h.shot(h.shots + '/fr-copy.png');
    if (process.env.UNDO === '1') await undoNewest(h);
    return;
  }
  if (step === 'rptscan') {
    h.log('REPORT PANEL:', await dump(h, '#fcRptScan', 500));
    await h.eval(`document.querySelector('#fcRptCount').click()`);
    await h.waitFor("!!document.querySelector('#fcRptGo') || /no reports|could not be listed/.test(document.querySelector('#fcRptScan')?.innerText || '')", 120000, 500);
    h.log('QUOTED COST:', await dump(h, '#fcRptScan', 600));
    if (process.env.COUNT_ONLY === '1' || !(await h.eval(`!!document.querySelector('#fcRptGo')`))) return;
    await h.eval(`document.querySelector('#fcRptGo').click()`);
    await h.sleep(700);
    h.log('WHILE RUNNING:', await dump(h, '#fcRptScan', 300));
    await h.waitFor("/Report scan/.test(document.querySelector('#fcRptScan')?.innerText || '')", 900000, 1000);
    await h.sleep(2500);
    h.log('SWEEP RESULT:', await dump(h, '#fcRptScan', 900));
    h.log('fix buttons after the sweep:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.fc-fix-btn:not(.fc-xml-fix), .fc-fix-all')].map(b => b.textContent.trim() + (b.dataset.name ? ' · ' + b.dataset.name : ''))`)));
    await h.shot(h.shots + '/fr-rptscan.png');
    if (process.env.THEN !== 'report') return;
    await fixRow(h, 'Report', process.env.NAME || '');
    h.log('RESULTS after:', await dump(h, '#fcGroup_Report', 900));
    return;
  }
  if (step === 'every') {
    const sel = `.fc-fix-every[data-swap="${process.env.SWAP === '0' ? '0' : '1'}"]`;
    h.log('everything box:', await dump(h, '#fcFixEvery', 400));
    if (!(await h.eval(`!!document.querySelector(${JSON.stringify(sel)})`))) { h.log('no such button'); return; }
    await h.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);
    const cancelAt = Number(process.env.CANCEL_AT) || 0;
    let dialogs = 0;
    for (let i = 0; i < 20; i++) {
      const got = await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 25000, 500).then(() => true).catch(() => false);
      if (!got) break;
      dialogs++;
      const title = await h.eval(`(document.querySelector('#modalBox')?.innerText || '').split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).slice(0, 3).join(' | ').slice(0, 160)`);
      h.log(`dialog ${dialogs}:`, title);
      if (cancelAt === dialogs) { await h.eval(`document.querySelector('#sftkConfirmCancel')?.click()`); h.log('cancelled on purpose'); await h.sleep(1500); continue; }
      await h.eval(`(() => { const r = document.querySelector('input[name="fcActiveMode"][value="replace"]'); if (r && !r.disabled) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } const b = document.querySelector('#fcFlowBackup'); if (b && b.checked) { b.checked = false; b.dispatchEvent(new Event('change', { bubbles: true })); } const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
      await h.sleep(300);
      await h.eval(`document.querySelector('#sftkConfirmGo').click()`);
      await h.waitFor("!document.querySelector('#sftkConfirmGo')", 30000, 300).catch(() => {});
      await h.waitFor("!document.querySelector('.fc-fix-btn[disabled]')", 600000, 1000);
      await h.sleep(1500);
    }
    h.log('dialogs shown:', dialogs);
    h.log('DONE:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.fc-item-fixed .fc-item-ok')].map(e => e.innerText.slice(0, 110))`)));
    h.log('still open:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.fc-fix-pair')].map(e => e.dataset.type + ':' + e.dataset.name)`)));
    h.log('INLINE ERRORS:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.fc-item-err')].map(e => e.innerText.slice(0, 300))`)));
    h.log('everything box after:', await dump(h, '#fcFixEvery', 300));
    h.log('DELETE ZONE:', await dump(h, '#fcDeleteZone', 300));
    return;
  }
  if (step === 'flowall') {
    const allSel = `.fc-fix-all[data-type="Flow"][data-swap="${process.env.SWAP === '0' ? '0' : '1'}"]`;
    h.log('all-buttons offered:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.fc-fix-all[data-type="Flow"]')].map(b => b.textContent.trim())`)));
    const lbl = await h.eval(`(() => { const b = document.querySelector(${JSON.stringify(allSel)}); return b ? b.textContent.trim() : null; })()`);
    h.log('pressing:', lbl);
    if (!lbl) return;
    await h.eval(`document.querySelector(${JSON.stringify(allSel)}).click()`);
    let dialogs = 0;
    for (let i = 0; i < 12; i++) {
      // the next dialog, or the end: no dialog, no busy button, for a few seconds
      const got = await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 25000, 500).then(() => true).catch(() => false);
      if (!got) break;
      dialogs++;
      if (!(await confirm(h, `flow ${dialogs}`, process.env.ACTIVE || 'replace'))) break;
      await h.waitFor("!document.querySelector('#sftkConfirmGo')", 30000, 300).catch(() => {});
      await h.waitFor("!document.querySelector('.fc-fix-btn[disabled]')", 600000, 1000);
      await h.sleep(1500);
    }
    h.log('confirmations asked:', dialogs);
    h.log('FLOW ROWS:', JSON.stringify(await h.eval(`[...document.querySelectorAll('#fcGroup_Flow .fc-item')].map(e => e.innerText.replace(/\s+/g, ' ').slice(0, 170))`)));
    h.log('INLINE ERRORS:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.fc-item-err')].map(e => e.innerText.slice(0, 300))`)));
    await h.shot(h.shots + '/fr-flowall.png');
    return;
  }
  if (step === 'flow')   await fixRow(h, 'Flow', process.env.FLOW || 'SFTK FC Test Flow 2', process.env.ACTIVE || 'replace');
  if (step === 'layout') await fixRow(h, 'Layout', process.env.NAME || '');
  if (step === 'page')   await fixRow(h, 'FlexiPage', process.env.NAME || '');
  if (step === 'report') await fixRow(h, 'Report', process.env.NAME || '');
  h.log('RESULTS after:', await dump(h, '#fcResults', 2500));
  await h.shot(h.shots + '/fr-after.png');
  if (process.env.UNDO === '1') await undoNewest(h);
}
