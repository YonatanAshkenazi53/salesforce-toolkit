// LIVE, WRITES to npc, END TO END: the standard — a field with every blocker kind on it is deleted from the tool
// in clicks. Scan (blockers) → 🗑 on every row → the real flow's "Delete versions · flow off" → Re-scan → the gate
// offers Delete Field → confirm → the field is gone (the caller checks with the CLI and rebuilds the fixture).
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
const confirm = async h => { await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 30000, 200); await h.eval(`(() => { const a = document.getElementById('sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`); await h.sleep(200); await h.eval(`(() => { const g = document.getElementById('sftkConfirmGo'); g.disabled = false; g.click(); return true; })()`); };
const settled = (h, id) => h.waitFor(`(() => { const it = document.getElementById('fcItem_${id}'); return !!it && (it.classList.contains('fc-item-fixed') || !!it.parentElement.querySelector('.fc-inline-err, .fc-item-err')); })()`, 240000, 500);
const outcome = (h, id) => h.eval(`(() => { const it = document.getElementById('fcItem_${id}'); return { fixed: it.classList.contains('fc-item-fixed'), text: (it.querySelector('.fc-item-ok')?.innerText || it.parentElement.querySelector('.fc-inline-err, .fc-item-err')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 200) }; })()`);
const scan = async h => { await h.eval(`document.querySelector('#fcScanBtn').click()`); await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000); await h.sleep(1500); };
export default async function (h) {
  await h.login('npc');
  await h.popup('fields');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', 'Account');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', 'SFTK_Live_Blk__c');
  await h.eval(`document.querySelector('#fcScope [data-scope="blockers"]').click()`); await h.sleep(300);
  await scan(h);
  h.log('before:', await h.eval(`document.querySelector('.fc-status-hd')?.innerText.replace(/\\s+/g, ' ')`));
  // 1. every 🗑
  const btns = await h.eval(`[...document.querySelectorAll('.fc-del-btn')].map(b => ({ type: b.dataset.type, id: b.dataset.id, name: b.dataset.name }))`);
  let ok = 0, bad = [];
  for (const b of btns) {
    await h.eval(`document.querySelector('.fc-del-btn[data-id="${b.id}"][data-type="${b.type}"]').click()`);
    await confirm(h);
    await settled(h, b.id);
    const o = await outcome(h, b.id);
    if (o.fixed) ok++; else bad.push(`${b.type} ${b.name}: ${o.text}`);
  }
  h.log(`🗑 ${ok} of ${btns.length} deleted${bad.length ? ' — failed: ' + bad.join(' | ') : ''}`);
  // 2. the real flow: "Delete versions · flow off"
  const flowBtn = await h.eval(`(() => { const b = [...document.querySelectorAll('.fc-fix-btn[data-type="Flow"][data-way="off"]')].find(x => !x.disabled); return b ? { id: b.dataset.id, name: b.dataset.name } : null; })()`);
  if (flowBtn) {
    await h.eval(`document.querySelector('.fc-fix-btn[data-type="Flow"][data-way="off"][data-id="${flowBtn.id}"]').click()`);
    await confirm(h);
    await settled(h, flowBtn.id);
    h.log('flow:', JSON.stringify(await outcome(h, flowBtn.id)));
  } else h.log('no rewritable flow button found');
  h.log('gate after the deletes:', await h.eval(`(document.querySelector('.fc-delete-zone')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 300)`));
  await h.shot(h.shots + '/e2e-1-after-deletes.png');
  // 3. re-scan → the gate
  await scan(h);
  h.log('after re-scan:', await h.eval(`document.querySelector('.fc-status-hd, .fc-clean')?.innerText.replace(/\\s+/g, ' ').slice(0, 300)`));
  h.log('blockers left:', JSON.stringify(await h.eval(`[...document.querySelectorAll('#fcSectionBlockers .fc-group')].map(g => g.querySelector('.fc-group-label').textContent + ' ' + g.querySelector('.fc-group-count').textContent.trim())`)));
  const del = await h.eval(`(() => { const b = document.querySelector('#fcDeleteBtn, #fcDelFreeBtn, #fcDelBtn'); return b ? { id: b.id, text: b.textContent.trim(), disabled: b.disabled } : null; })()`);
  h.log('delete button:', JSON.stringify(del));
  await h.shot(h.shots + '/e2e-2-gate.png');
  if (!del || del.disabled) { h.log('STOP: the gate is not open'); return; }
  // 4. delete the field
  await h.eval(`document.getElementById('${del.id}').click()`);
  await confirm(h);
  await h.waitFor("!!document.querySelector('.fc-deleted, .fc-del-done, .fc-clean-icon') || /deleted/i.test(document.querySelector('#fcDeleteZone, #fcResults')?.innerText || '')", 300000, 1000).catch(() => {});
  await h.sleep(2000);
  h.log('after Delete Field:', await h.eval(`(document.querySelector('#fcDeleteZone, #fcResults')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 400)`));
  await h.shot(h.shots + '/e2e-3-deleted.png');
}
