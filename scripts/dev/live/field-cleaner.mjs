// Live: Field Cleaner on the fixture field Account.SFTK_FC_Test_Status__c
// (trailheads5). Scan → references → the flow fix dialog (replace or delete the
// active version) → execute → the permission-set reference → delete the field.
//   SCAN_ONLY=1   stop after the scan and the first fix dialog (nothing written)
//   ACTIVE=replace|delete   which way for the active version (default: replace when offered)
//   DELETE_FIELD=1          finish by deleting the field itself
import { undoNewest } from './_undo.mjs';   // UNDO=1: Data Studio › History › ↩ Undo the newest entry afterwards (TYPE_IT=1 for a guarded org)
const dump = async (h, sel, n = 2500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
async function pick(h, inputSel, dropSel, api) {
  // the list loads on focus (async) — wait for it before typing, like a user does
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
async function confirmDialog(h, activeMode) {
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 60000, 500);
  await h.sleep(500);
  const text = await h.eval(`(document.querySelector('#sftkConfirmGo')?.closest('.sftk-confirm, .modal, [class*=confirm]')?.innerText || document.body.innerText)`);
  h.log('DIALOG:', text.slice(0, 2500).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | '));
  const modes = await h.eval(`[...document.querySelectorAll('input[name="fcActiveMode"]')].map(r => r.value + (r.disabled ? '(off)' : '') + (r.checked ? '*' : ''))`);
  h.log('active-version choices:', JSON.stringify(modes));
  if (modes.length) {
    const want = activeMode || (modes.some(m => m.startsWith('replace') && !m.includes('(off)')) ? 'replace' : 'delete');
    await h.eval(`(() => { const r = document.querySelector('input[name="fcActiveMode"][value="${want}"]'); if (r && !r.disabled) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
    h.log('chose:', want);
  }
  await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
  await h.sleep(300);
  const goOk = await h.eval(`!document.querySelector('#sftkConfirmGo')?.disabled`);
  h.log('Go enabled:', goOk);
  return goOk;
}
// The shared confirmation (sftk-confirm.js): acknowledge, the word when one is asked, Go, the typed org name when guarded.
async function passConfirm(h, what) {
  await h.waitFor("!!document.querySelector('#sftkConfirmGo') || !!document.querySelector('#fcDepUndo')", 60000, 500);
  if (!(await h.eval(`!!document.querySelector('#sftkConfirmGo')`))) return;
  await h.sleep(300);
  h.log(`CONFIRM (${what}):`, (await h.eval(`(document.querySelector('#modalBox')?.innerText || '')`)).replace(/\s+/g, ' ').slice(0, 500));
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
  await h.login('npc');
  await h.popup('fields');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', 'Account');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', 'SFTK_FC_Test_Status__c');
  h.log('pill:', await dump(h, '#fcPill', 300));
  await h.click('#fcScanBtn');
  await h.waitFor("/reference|Nothing references|No references|found/i.test(document.querySelector('#fcResults')?.innerText || '') && !/scanning|⏳/i.test(document.querySelector('#fcScanBtn')?.innerText || '')", 180000, 1000);
  await h.sleep(2000);
  h.log('RESULTS:', await dump(h, '#fcResults', 3500));
  h.log('DATA VERDICT:', await dump(h, '#fcDataVerdict', 400));
  h.log('DELETE ZONE:', await dump(h, '#fcDeleteZone', 600));
  await h.shot(h.shots + '/fc-results.png');
  if (process.env.DEPRECATE === '1') {
    // 🕐 Deprecate first (label → zz_DEPRECATED…, FLS stripped), then ↩ Undo — nothing else
    h.log('DEP ZONE:', await dump(h, '#fcDepZone', 400));
    await h.eval(`document.querySelector('#fcDepBtn')?.click()`);
    await passConfirm(h, 'deprecate');
    await h.waitFor("!!document.querySelector('#fcDepUndo') || /❌|failed/i.test(document.querySelector('#fcDepZone')?.innerText || '')", 120000, 1000);
    await h.sleep(1000);
    h.log('AFTER DEPRECATE:', await dump(h, '#fcDepZone', 600));
    h.log('errors under zone:', JSON.stringify(await h.eval(`[...document.querySelectorAll('#fcDepZone .fc-error-msg, #fcDepZone [class*=err]')].map(e => e.innerText.slice(0, 300))`)));
    await h.shot(h.shots + '/fc-deprecated.png');
    if (process.env.UNDO === '1') { await undoNewest(h); return; }   // phase 3: Data Studio › History › ↩ Undo
    if (process.env.UNDO !== '0' && await h.eval(`!!document.querySelector('#fcDepUndo')`)) {
      await h.eval(`document.querySelector('#fcDepUndo').click()`);
      await passConfirm(h, 'undo deprecation');
      await h.waitFor("!!document.querySelector('#fcDepBtn') || /❌|failed/i.test(document.querySelector('#fcDepZone')?.innerText || '')", 120000, 1000);
      await h.sleep(1000);
      h.log('AFTER UNDO:', await dump(h, '#fcDepZone', 600));
    }
    return;
  }
  const fixBtns = await h.eval(`[...document.querySelectorAll('.fc-fix-btn')].map(b => (b.dataset.type || '?') + ':' + (b.dataset.name || b.dataset.id) + (b.disabled ? '(off)' : ''))`);
  h.log('fix buttons:', JSON.stringify(fixBtns));
  // the flow first
  // FLOW=<label> picks that flow's ✂ button (several flows may reference the field); default: the first
  const flowSel = process.env.FLOW ? `.fc-fix-btn[data-type="Flow"][data-name="${process.env.FLOW}"]:not([disabled])` : '.fc-fix-btn[data-type="Flow"]:not([disabled])';
  const flowBtn = await h.eval(`!!document.querySelector(${JSON.stringify(flowSel)})`);
  if (!flowBtn) h.log('no flow fix button for', flowSel, '— straight to the other fixes / the delete');
  else {
  h.log('flow button:', await h.eval(`(() => { const b = document.querySelector(${JSON.stringify(flowSel)}); return b.dataset.name + ' (' + b.closest('.fc-item')?.innerText.replace(/\\s+/g, ' ').slice(0, 80) + ')'; })()`));
  await h.eval(`document.querySelector(${JSON.stringify(flowSel)}).click()`);
  // since 2026-10-06 a way that cannot work is refused BEFORE the dialog (an inline error, no confirmation)
  await h.waitFor("!!document.querySelector('#sftkConfirmGo') || !!document.querySelector('.fc-inline-error, .fc-item-err, [class*=inline-err]')", 90000, 500);
  if (!(await h.eval("!!document.querySelector('#sftkConfirmGo')"))) {
    h.log('REFUSED BEFORE THE DIALOG:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.fc-inline-error, .fc-item-err, [class*=inline-err]')].map(e => e.innerText.slice(0, 500))`)));
    if (process.env.SCAN_ONLY === '1') return;
  } else {
  const ok = await confirmDialog(h, process.env.ACTIVE);
  if (process.env.SCAN_ONLY === '1' || !ok) { h.log('SCAN_ONLY / not confirmable — cancelling'); await h.eval(`(() => { const c = [...document.querySelectorAll('button')].find(b => /cancel/i.test(b.textContent)); if (c) c.click(); return true; })()`); return; }
  await h.eval(`document.querySelector('#sftkConfirmGo').click()`);
  // the dialog closes at once; the fix runs on — done when no fix button is still busy (disabled)
  await h.waitFor("!document.querySelector('#sftkConfirmGo') && !document.querySelector('.fc-fix-btn[disabled]')", 600000, 1000);
  await h.sleep(2500);
  h.log('FIXED LABELS:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.fc-item-ok')].map(e => e.innerText)`)));
  h.log('INLINE ERRORS:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.fc-inline-error, .fc-item-err, [class*=inline-err]')].map(e => e.innerText.slice(0, 600))`)));
  h.log('AFTER FLOW FIX — results:', await dump(h, '#fcResults', 3000));
  h.log('snap log:', await dump(h, '#fcSnapLog', 800));
  await h.shot(h.shots + '/fc-after-flow.png');
  }
  }
  // any other fix buttons (permission set etc.). QA 2026-10-06: a flow whose
  // "keeps running" way is refused (an element would be left empty) is pressed
  // again with 🗑 Delete versions · flow off, never the same button twice.
  const tried = new Set();
  for (let i = 0; i < 6; i++) {
    const pick = await h.eval(`(() => {
      const tried = new Set(${JSON.stringify([...tried])});
      for (const b of document.querySelectorAll('.fc-fix-btn:not([disabled])')) {
        const key = b.dataset.type + ':' + (b.dataset.name || b.dataset.id) + ':' + (b.dataset.way || '');
        if (tried.has(key)) continue;
        if (b.dataset.type === 'Flow' && tried.has(b.dataset.type + ':' + (b.dataset.name || b.dataset.id) + ':keep') && b.dataset.way !== 'off') continue;
        b.setAttribute('data-sftk-pick', '1'); return key;
      }
      return null; })()`);
    if (!pick) break;
    tried.add(pick);
    h.log('next fix:', pick);
    // an earlier refusal stays on the page: only a NEW inline error (or the dialog) counts
    const errsBefore = await h.eval("document.querySelectorAll('.fc-inline-error, .fc-item-err, [class*=inline-err]').length");
    await h.eval(`(() => { const b = document.querySelector('.fc-fix-btn[data-sftk-pick]'); b.removeAttribute('data-sftk-pick'); b.click(); return true; })()`);
    await h.waitFor(`!!document.querySelector('#sftkConfirmGo') || document.querySelectorAll('.fc-inline-error, .fc-item-err, [class*=inline-err]').length > ${errsBefore}`, 90000, 500);
    if (!(await h.eval("!!document.querySelector('#sftkConfirmGo')"))) {
      h.log('refused before the dialog:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.fc-inline-error, .fc-item-err, [class*=inline-err]')].slice(-1).map(e => e.innerText.slice(0, 400))`)));
      continue;
    }
    const ok2 = await confirmDialog(h, process.env.ACTIVE);
    if (!ok2) { await h.eval(`(() => { const c = [...document.querySelectorAll('button')].find(b => /cancel/i.test(b.textContent)); if (c) c.click(); return true; })()`); break; }
    await h.eval(`document.querySelector('#sftkConfirmGo').click()`);
    await h.waitFor("!document.querySelector('#sftkConfirmGo') && !document.querySelector('.fc-fix-btn[disabled]')", 600000, 1000);
    await h.sleep(2000);
    h.log('FIXED LABELS:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.fc-item-ok')].map(e => e.innerText)`)));
    h.log('after fix — results:', await dump(h, '#fcResults', 1500));
  }
  h.log('DELETE ZONE now:', await dump(h, '#fcDeleteZone', 600));
  if (process.env.DELETE_FIELD !== '1') return;
  const del = await h.eval(`(() => { const b = document.querySelector('#fcDelBtn') || document.querySelector('#fcDelFreeBtn'); return b ? (b.textContent.trim() + (b.disabled ? '(off)' : '')) : null; })()`);
  h.log('delete button:', del);
  if (!del || del.includes('(off)')) return;
  await h.eval(`(document.querySelector('#fcDelBtn') || document.querySelector('#fcDelFreeBtn')).click()`);
  const ok3 = await confirmDialog(h);
  if (!ok3) return;
  await h.eval(`document.querySelector('#sftkConfirmGo').click()`);
  // doDelete is fire-and-forget behind the dialog: the button reads "Deleting…" until the org answered
  await h.waitFor("!document.querySelector('#sftkConfirmGo') && /Deleting/.test(document.querySelector('#fcDelBtn, #fcDelFreeBtn')?.textContent || '')", 20000, 200).catch(() => h.log('(no Deleting… state seen)'));
  // done = the "Field deleted" card or the delete error (the button vanishes with the results on success)
  await h.waitFor("!!document.querySelector('.fc-error-msg') || !!document.querySelector('.fc-success')", 180000, 500);
  await h.sleep(1500);
  h.log('AFTER DELETE:', await dump(h, '#fcResults', 1500));
  h.log('DELETE ZONE after:', await dump(h, '#fcDeleteZone', 600));
  h.log('DELETE ERROR:', await dump(h, '.fc-error-msg', 600));
  await h.shot(h.shots + '/fc-after-delete.png');
  if (process.env.UNDO === '1') await undoNewest(h);
}
