// LIVE, WRITES TO THE ORG (default npc2) AND UNDOES IT (owner 2026-11-16):
//   "After deletion, we will show an undo button near the deleted/removed metadata items" — the row's own ↩ Undo
//     takes back exactly that row's change: ✂ Remove on the custom setting record → ↩ Undo on the row → confirmed →
//     the value is back (CLI-free: the re-scan lists the record again);
//   "we should remove history from field cleaner page. same for the restore points. we have the activity tab for
//     them" — neither section is on the page; Activity (top bar) has ↩ Restore points, which opens them.
// Fixture: docs/fixtures/packaged-object-fixture.
const ORG = process.env.ORG || 'npc2';
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
const dark = async (h, on) => { await h.eval(`(() => { document.body.classList.toggle('sftk-dark', ${on}); return true; })()`); await h.sleep(300); };
const both = async (h, name) => { await h.shot(h.shots + '/' + name + '.png'); await dark(h, true); await h.shot(h.shots + '/' + name + '-dark.png'); await dark(h, false); };
const T = 'CustomSettingRecord';

export default async function (h) {
  await h.login(ORG);
  await h.popup('fields');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await h.eval(`chrome.storage.local.set({ sftk_history: [] }).then(() => true)`);
  await pick(h, '#fcObjInput', '#fcObjDrop', 'dlrs__LookupChild__c');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', 'SFTK_Pkg_Tag__c');
  await h.eval(`document.querySelector('#fcScope [data-scope="both"]')?.click()`); await h.sleep(600);
  await h.eval(`(() => { document.querySelector('#fcScanBtn').click(); return true; })()`);
  await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000); await h.sleep(1500);

  const page = await h.eval(`({ hist: !!document.getElementById('fcToolHist'), snaps: !!document.getElementById('fcSnapLog'), inline: !!document.querySelector('#fcResults ~ * .sftk-th-inline, .fc-snaplog') })`);
  h.log('on the page:', JSON.stringify(page));
  if (page.hist || page.snaps || page.inline) throw new Error('FAILED: the list of changes and the restore points must not be on the Field Cleaner page');

  // ✂ on the row, then ↩ Undo on the same row
  const id = await h.eval(`document.querySelector('.fc-fix-btn[data-type="${T}"]')?.dataset.id || ''`);
  if (!id) throw new Error('FAILED: fixture — no custom setting record row');
  await h.eval(`document.querySelector('.fc-fix-btn[data-type="${T}"][data-id="${id}"]').click()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 60000, 200); await h.sleep(300);
  await h.eval(`document.getElementById('sftkConfirmGo').click()`);
  await h.waitFor(`!!document.querySelector('#fcItem_${id} .fc-item-undo')`, 120000, 400);
  h.log('row after ✂:', await h.eval(`(document.getElementById('fcItem_${id}').innerText || '').replace(/\\s+/g, ' ')`));
  const entry = await h.eval(`chrome.storage.local.get('sftk_history').then(r => (r.sftk_history || []).map(e => ({ row: e.row, subject: e.subject, title: e.profileName }))[0])`);
  h.log('entry:', JSON.stringify(entry));
  if (!entry || entry.row !== id) throw new Error('FAILED: the History entry must carry the row it was made from');
  await h.eval(`document.getElementById('fcItem_${id}').scrollIntoView({ block: 'center' })`); await h.sleep(300);
  await both(h, 'rowundo-1-fixed');
  await h.eval(`document.querySelector('#fcItem_${id} .fc-item-undo').click()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 60000, 200); await h.sleep(400);
  h.log('undo dialog:', await h.eval(`(document.querySelector('#modalBox')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 420)`));
  await both(h, 'rowundo-2-dialog');
  await h.eval(`(() => { const c = document.querySelector('#modalBox input[type=checkbox]'); if (c && !c.checked) c.click(); const w = document.getElementById('sftkConfirmWord'); if (w) { w.value = w.placeholder || w.dataset.word || ''; w.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`);
  await h.sleep(300);
  if (await h.eval(`document.getElementById('sftkConfirmGo').disabled`)) throw new Error('FAILED: the undo confirmation is locked — ' + await h.eval(`(document.querySelector('#modalBox')?.innerText || '').replace(/\\s+/g, ' ').slice(-200)`));
  await h.eval(`document.getElementById('sftkConfirmGo').click()`);
  // the row says Undone, then the list is scanned again and the record is a row with ✂ once more
  await h.waitFor(`chrome.storage.local.get('sftk_history').then(r => (r.sftk_history || []).some(e => e.undoOf))`, 120000, 400);
  await h.sleep(2500);   // the row says Undone and the scan starts
  h.log('row after ↩:', await h.eval(`(document.getElementById('fcItem_${id}')?.innerText || '(the list is being scanned again)').replace(/\\s+/g, ' ').slice(0, 200)`), '· scanning:', await h.eval(`!!document.querySelector('#fcScanBtn')?.disabled`));
  await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000); await h.sleep(1500);
  const back = await h.eval(`[...document.querySelectorAll('.fc-fix-btn[data-type="${T}"]')].map(b => b.textContent.trim())`);
  const hist = await h.eval(`chrome.storage.local.get('sftk_history').then(r => (r.sftk_history || []).map(e => (e.undoOf ? 'undo: ' : '') + e.status))`);
  h.log('after the undo → row buttons:', JSON.stringify(back), '· history:', JSON.stringify(hist));
  if (!back.length) throw new Error('FAILED: after the row’s undo the record must be listed again');

  // Activity → ↩ Restore points
  await h.eval(`(() => { document.getElementById('sftkFeedBtn').click(); return true; })()`);
  await h.waitFor("!!document.querySelector('#sftkFeedSnaps')", 10000, 200); await h.sleep(500);
  await both(h, 'rowundo-3-activity');
  await h.eval(`(() => { document.getElementById('sftkFeedSnaps').click(); return true; })()`);
  await h.waitFor("!!document.querySelector('#modalBox #fcSnapLog')", 10000, 200); await h.sleep(900);
  const snaps = await h.eval(`({ rows: document.querySelectorAll('#fcSnapLog .fc-snap-row').length, text: (document.querySelector('#modalBox').innerText || '').replace(/\\s+/g, ' ').slice(0, 300) })`);
  h.log('restore points window:', JSON.stringify(snaps));
  if (!snaps.rows) throw new Error('FAILED: the restore point of the ✂ just made must be listed');
  await both(h, 'rowundo-4-restore-points');
  h.log(`✓ fc-row-undo on ${ORG}: the row's ↩ Undo took the change back and the record is listed again; no History / Restore points on the page; Activity opens the restore points`);
}
