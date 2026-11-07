// LIVE, WRITES to npc: 🗑 Delete on the demo field's blockers, one kind at a time, each verified by the tool's
// own re-read and then by the CLI (run by the caller). TYPES=a,b,c limits the kinds. UNDO=1: in the SAME session
// (restore points and History live in the browser profile) the first delete is put back through ↩ Restore under
// the results and the second through ↩ Undo in History. Nothing is written outside the SFTK_Live fixture.
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
const confirm = async h => { await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 20000, 200); await h.eval(`(() => { const a = document.getElementById('sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`); await h.sleep(200); await h.eval(`document.getElementById('sftkConfirmGo').click()`); };
export default async function (h) {
  const only = (process.env.TYPES || '').split(',').map(s => s.trim()).filter(Boolean);
  await h.login('npc');
  await h.popup('fields');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  // OBJ / FIELD: another object's demo field (Lead / Case carry the assignment and escalation rules)
  await pick(h, '#fcObjInput', '#fcObjDrop', process.env.OBJ || 'Account');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', process.env.FIELD || 'SFTK_Live_Blk__c');
  await h.eval(`document.querySelector('#fcScope [data-scope="blockers"]').click()`); await h.sleep(300);
  await h.eval(`document.querySelector('#fcScanBtn').click()`);
  await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000); await h.sleep(1500);
  const btns = await h.eval(`[...document.querySelectorAll('.fc-del-btn')].map(b => ({ type: b.dataset.type, id: b.dataset.id, name: b.dataset.name, label: b.textContent.trim() }))`);
  h.log(`🗑 buttons: ${btns.length}`); for (const b of btns) h.log('   ', b.type, '·', b.name, '·', b.label);
  h.log('no 🗑 (by hand):', JSON.stringify(await h.eval(`[...document.querySelectorAll('#fcSectionBlockers .fc-group')].filter(g => !g.querySelector('.fc-del-btn')).map(g => g.querySelector('.fc-group-label').textContent)`)));
  h.log('badges:', await h.eval(`document.querySelector('.fc-badge-row')?.innerText.replace(/\\s+/g, ' ')`));
  await h.shot(h.shots + '/del-0-buttons.png');
  if (process.env.DARK === '1') { await h.eval("document.querySelector('#sftkDarkToggle')?.click()"); await h.sleep(1500); await h.eval("document.querySelector('#fcSectionBlockers')?.scrollIntoView({ block: 'start' })"); await h.sleep(400); await h.shot(h.shots + '/del-0b-dark.png'); await h.eval("document.querySelector('#sftkDarkToggle')?.click()"); await h.sleep(800); }
  const todo = btns.filter(b => !only.length || only.includes(b.type));
  const results = [];
  for (const b of todo) {
    await h.eval(`document.querySelector('.fc-del-btn[data-id="${b.id}"][data-type="${b.type}"]').click()`);
    await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 20000, 200);
    if (results.length === 0) { h.log('dialog:', await h.eval(`document.querySelector('.sftk-confirm, #sftkConfirmBox, [role=dialog]')?.innerText.replace(/\\s+/g, ' ').slice(0, 400)`)); await h.shot(h.shots + '/del-1-dialog.png'); }
    await confirm(h);
    await h.waitFor(`(() => { const it = document.getElementById('fcItem_${b.id}'); return !!it && (it.classList.contains('fc-item-fixed') || !!it.parentElement.querySelector('.fc-inline-err, .fc-item-err')); })()`, 240000, 500);
    const out = await h.eval(`(() => { const it = document.getElementById('fcItem_${b.id}'); return { fixed: it.classList.contains('fc-item-fixed'), text: (it.querySelector('.fc-item-ok')?.innerText || it.parentElement.querySelector('.fc-inline-err, .fc-item-err')?.innerText || it.innerText).replace(/\\s+/g, ' ').slice(0, 300) }; })()`);
    h.log(out.fixed ? '✅' : '❌', b.type, b.name, '→', out.text);
    results.push({ ...b, ...out });
    await h.sleep(500);
  }
  h.log('gate after:', await h.eval(`(document.querySelector('.fc-delete-zone .fc-blockers')?.innerText || '(no blockers box)').replace(/\\s+/g, ' ').slice(0, 400)`));
  await h.shot(h.shots + '/del-2-after.png');
  if (process.env.UNDO === '1') {
    const done = results.filter(r => r.fixed);
    // ↩ Restore under the results for the first delete
    const snaps = await h.eval(`[...document.querySelectorAll('.fc-snap-restore')].map(b => ({ at: b.dataset.snapAt, row: (b.closest('.fc-snap-row') || b.parentElement)?.innerText.replace(/\\s+/g, ' ').slice(0, 160) }))`);
    h.log('restore points:', JSON.stringify(snaps.slice(0, 4)));
    const first = done[0], snap = snaps.find(s => s.row.includes(first.name)) || snaps[snaps.length - 1];
    if (snap) {
      await h.eval(`document.querySelector('.fc-snap-restore[data-snap-at="${snap.at}"]').click()`);
      await confirm(h);
      try { await h.waitFor(`(() => { const b = document.querySelector('[data-snap-at="${snap.at}"]'); return !b || /Restored|retry/i.test(b.textContent) || !!b.parentElement.querySelector('.fc-inline-err, .fc-snap-err, .sftk-err'); })()`, 240000, 500); } catch (_) { h.log('restore timed out; row says:', await h.eval(`(document.querySelector('[data-snap-at="${snap.at}"]')?.closest('.fc-snap-row, li, div')?.innerText || '').replace(/s+/g, ' ').slice(0, 400)`)); }
      h.log('↩ Restore', first.name, '→', await h.eval(`(document.querySelector('[data-snap-at="${snap.at}"]')?.textContent || '(button gone)').trim()`), '|', await h.eval(`(document.querySelector('[data-snap-at="${snap.at}"]')?.parentElement?.innerText || '').replace(/\\s+/g, ' ').slice(0, 240)`));
      await h.shot(h.shots + '/del-3-restore.png');
    }
    // ↩ Undo in History for the second
    const second = done[1];
    if (second) {
      const entries = await h.eval(`sftkHistoryAll().then(all => all.filter(e => e && e.kind === 'tool' && /deleted|removed/.test(e.profileName || '')).map(e => ({ id: e.id, name: e.profileName })))`);
      h.log('history delete entries:', JSON.stringify(entries.slice(0, 4)));
      const ent = entries.find(e => e.name.includes(second.name));
      if (ent) {
        const p = h.eval(`sftkHistoryUndo(${JSON.stringify(ent.id)}).then(r => JSON.stringify(r).slice(0, 500))`);
        await confirm(h);
        h.log('History undo', second.name, '→', await p);
      } else h.log('no History entry for', second.name);
    }
    await h.shot(h.shots + '/del-4-history.png');
  }
  return results;
}
