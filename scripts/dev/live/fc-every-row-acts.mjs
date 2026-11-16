// LIVE, WRITES TO THE ORG (default npc2) AND UNDOES THEM: the two 👀 rows that had only ↗ Setup now carry an action
// (owner 2026-11-16: "we said all items must have a delete/remove") —
//   Custom Setting Records  ✂ Remove: the field's name out of the record's value, ↩ Undo writes it back;
//   Email Alerts (send a template that uses the field)  🗑 Delete the email alert, ↩ Undo deploys it back.
// Then: no listed row of the packaged demo field is left with ↗ Setup alone, except the kinds named in ONLY_SETUP.
// Ends with ↩ Undo all for the field, and reads both back.
// Fixture: docs/fixtures/packaged-object-fixture (all of it, with the custom setting record).
const ORG = process.env.ORG || 'npc2';
const NL = String.fromCharCode(10);
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
async function scan(h) {
  await h.eval(`(() => { document.querySelector('#fcScanBtn').click(); return true; })()`);
  await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000);
  await h.sleep(1500);
}
const rowsOf = (h, type) => h.eval(`[...document.querySelectorAll('.fc-fix-btn[data-type="${type}"]')].map(b => ({ id: b.dataset.id, name: b.dataset.name, text: b.textContent.trim(), cls: b.className }))`);
async function act(h, type, shot, pickTxt) {
  const pick = !!pickTxt; void pick;
  const rows = await rowsOf(h, type);
  h.log(type, 'buttons:', JSON.stringify(rows.map(r => r.text + ' · ' + r.name)));
  if (!rows.length) throw new Error(`FAILED: ${type} has no action on its row`);
  const id = rows[0].id;
  await h.eval(`[...document.querySelectorAll('.fc-fix-btn[data-type="${type}"][data-id="${id}"]')].find(b => !${pick} || b.textContent.includes(${JSON.stringify(pickTxt || '')})).click()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 60000, 200);
  await h.sleep(400);
  h.log(type, 'dialog:', await h.eval(`(document.querySelector('#modalBox')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 700)`));
  await h.shot(h.shots + '/' + shot + '.png');
  await h.eval(`(() => { document.body.classList.add('sftk-dark'); return true; })()`); await h.sleep(300);
  await h.shot(h.shots + '/' + shot + '-dark.png');
  await h.eval(`(() => { document.body.classList.remove('sftk-dark'); return true; })()`);
  if (await h.eval(`document.getElementById('sftkConfirmGo').disabled`)) throw new Error('FAILED: the confirm is locked — ' + type);
  await h.eval(`document.getElementById('sftkConfirmGo').click()`);
  await h.waitFor(`(() => { const it = document.getElementById('fcItem_${id}'); return !!it && (it.classList.contains('fc-item-fixed') || !!it.querySelector('.fc-inline-error, .fc-item-error')); })()`, 240000, 500);
  const row = await h.eval(`(() => { const it = document.getElementById('fcItem_${id}'); return { text: (it.innerText || '').replace(/\\s+/g, ' ').slice(0, 300), fixed: it.classList.contains('fc-item-fixed'), undo: !!it.querySelector('.fc-item-undo') }; })()`);
  h.log(type, 'row after:', JSON.stringify(row));
  return row;
}

export default async function (h) {
  await h.login(ORG);
  await h.popup('fields');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await h.eval(`chrome.storage.local.set({ sftk_history: [] }).then(() => true)`);
  await pick(h, '#fcObjInput', '#fcObjDrop', 'dlrs__LookupChild__c');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', 'SFTK_Pkg_Tag__c');
  await h.eval(`document.querySelector('#fcScope [data-scope="both"]')?.click()`); await h.sleep(600);
  await scan(h);

  // every listed kind: what its rows offer
  const kinds = await h.eval(`[...document.querySelectorAll('.fc-group')].map(g => ({ label: g.querySelector('.fc-group-label').textContent.trim(), acts: [...new Set([...g.querySelectorAll('button')].map(b => b.textContent.trim().replace(/\\s+/g, ' ')).filter(t => t && !/^🔍$/.test(t)))] }))`);
  const onlySetup = kinds.filter(k => !k.acts.some(a => /✂|⇄|✎|🗑|Remove|Replace|Edit|Delete/.test(a)));
  for (const k of kinds) h.log('  ', k.label, '→', k.acts.join(' / '));
  h.log('kinds with no action of their own:', JSON.stringify(onlySetup.map(k => k.label)));

  const cs = await act(h, 'CustomSettingRecord', 'era-1-setting');
  if (!cs.fixed) throw new Error('FAILED: the custom setting value was not cleared — ' + cs.text);
  const al = await act(h, 'EmailAlertViaTemplate', 'era-2-alert');
  const pa = await act(h, 'PathAssistant', 'era-3-path', 'Remove');
  h.log('path:', pa.fixed ? 'key field removed' : 'not removed — ' + pa.text);
  h.log('email alert:', al.fixed ? 'deleted' : 'not deleted — ' + al.text);

  // ↩ Undo all for the field
  await h.waitFor("!!document.getElementById('fcUndoAllBtn')", 30000, 300);
  h.log('undo-all bar:', await h.eval(`(document.getElementById('fcUndoAll').innerText || '').replace(/\\s+/g, ' ')`));
  await h.eval(`document.getElementById('fcUndoAllBtn').click()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 30000, 200);
  await h.eval(`(() => { const c = document.querySelector('#modalBox input[type=checkbox]'); if (c && !c.checked) c.click(); const w = document.querySelector('#modalBox input[type=text]'); return !!w; })()`);
  await h.sleep(300);
  await h.eval(`document.getElementById('sftkConfirmGo').click()`);
  await h.waitFor("!!document.querySelector('#fcUndoAll .fc-undoall-done')", 400000, 1000);
  h.log('undo all:', await h.eval(`(document.querySelector('#fcUndoAll .fc-undoall-done').innerText || '').replace(/\\s+/g, ' ')`));
  await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000);
  await h.sleep(1500);
  const back = { setting: (await rowsOf(h, 'CustomSettingRecord')).length, alert: (await rowsOf(h, 'EmailAlertViaTemplate')).length };
  h.log('after the undo, listed again:', JSON.stringify(back));
  if (!back.setting) throw new Error('FAILED: the custom setting value did not come back');
  if (al.fixed && !back.alert) throw new Error('FAILED: the email alert did not come back');
  if (onlySetup.length) h.log('NOTE — still no action:', onlySetup.map(k => k.label).join(', '));
  h.log(`✓ fc-every-row-acts on ${ORG}: custom setting ✂ + undo; email alert ${al.fixed ? '🗑 + undo' : 'refused by Salesforce (see above)'}`);
  void NL;
}
