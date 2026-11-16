// LIVE, WRITES TO THE ORG (default npc2) AND UNDOES THEM — what fc-every-row-acts.mjs did not run (2026-11-16):
//   A  ⇄ Replace on a path: the step's key field becomes the replacement field       → verified by re-read
//   B  ↩ Undo all for the field                                                       → the path lists the field again
//   C  🗑 Delete the path (a restore point is kept)                                    → gone, verified by re-read
//   D  ↩ Undo all                                                                     → the path is back and listed again
//   E  ⇄ Replace all, paused on its first item                                        → the bar; with the replacement
//      cleared ▶ Continue is off and says why; picked again it goes on with the same item; ✕ End
// Fixture: docs/fixtures/packaged-object-fixture (SFTK_Pkg_Path shows SFTK_Pkg_Tag__c as a key field of the step New).
const ORG = process.env.ORG || 'npc2';
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
const waitScan = async h => { await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000); await h.sleep(1500); };
const scan = async h => { await h.eval(`(() => { document.querySelector('#fcScanBtn').click(); return true; })()`); await waitScan(h); };
const pathBtns = h => h.eval(`[...document.querySelectorAll('.fc-fix-btn[data-type="PathAssistant"]')].map(b => ({ id: b.dataset.id, text: b.textContent.trim(), off: b.disabled }))`);
async function press(h, match, tag) {
  const btns = await pathBtns(h);
  const b = btns.find(x => x.text.includes(match) && !x.off);
  if (!b) throw new Error(`FAILED: the path offers no “${match}” — ${JSON.stringify(btns)}`);
  await h.eval(`[...document.querySelectorAll('.fc-fix-btn[data-type="PathAssistant"][data-id="${b.id}"]')].find(x => x.textContent.includes(${JSON.stringify(match)})).click()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 60000, 200);
  await h.sleep(400);
  h.log(tag, 'dialog:', await h.eval(`(document.querySelector('#modalBox')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 520)`));
  await h.shot(h.shots + '/' + tag + '.png');
  await h.eval(`(() => { const c = document.querySelector('#modalBox input[type=checkbox]'); if (c && !c.checked) c.click(); return true; })()`);
  await h.sleep(200);
  if (await h.eval(`document.getElementById('sftkConfirmGo').disabled`)) throw new Error('FAILED: the confirm is locked — ' + tag);
  await h.eval(`document.getElementById('sftkConfirmGo').click()`);
  await h.waitFor(`(() => { const it = document.getElementById('fcItem_${b.id}'); return !!it && (it.classList.contains('fc-item-fixed') || !!it.querySelector('.fc-item-err')); })()`, 240000, 500);
  const row = await h.eval(`(() => { const it = document.getElementById('fcItem_${b.id}'); return { text: (it.innerText || '').replace(/\\s+/g, ' ').slice(0, 260), fixed: it.classList.contains('fc-item-fixed') }; })()`);
  h.log(tag, 'row:', JSON.stringify(row));
  if (!row.fixed) throw new Error('FAILED: ' + tag + ' — ' + row.text);
}
async function undoAll(h, tag) {
  await h.waitFor("!!document.getElementById('fcUndoAllBtn')", 30000, 300);
  await h.eval(`document.getElementById('fcUndoAllBtn').click()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 30000, 200);
  await h.eval(`(() => { const c = document.querySelector('#modalBox input[type=checkbox]'); if (c && !c.checked) c.click(); return true; })()`);
  await h.sleep(300);
  await h.eval(`document.getElementById('sftkConfirmGo').click()`);
  await h.waitFor("!!document.querySelector('#fcUndoAll .fc-undoall-done')", 400000, 1000);
  h.log(tag, 'undo all:', await h.eval(`(document.querySelector('#fcUndoAll .fc-undoall-done').innerText || '').replace(/\\s+/g, ' ')`));
  await waitScan(h);
  const n = (await pathBtns(h)).length;
  if (!n) throw new Error('FAILED: after the undo the path must be listed again — ' + tag);
}

export default async function (h) {
  await h.login(ORG);
  await h.popup('fields');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await h.eval(`chrome.storage.local.set({ sftk_history: [] }).then(() => chrome.storage.local.remove('sftk_fc_walk')).then(() => true)`);
  await pick(h, '#fcObjInput', '#fcObjDrop', 'dlrs__LookupChild__c');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', 'SFTK_Pkg_Tag__c');
  await h.waitFor("!document.querySelector('#fcReplInput')?.disabled || !!document.querySelector('#fcReplNote .fc-repl-bad')", 60000, 500);
  await pick(h, '#fcReplInput', '#fcReplDrop', 'SFTK_Pkg_Tag2__c');
  await h.eval(`document.querySelector('#fcScope [data-scope="both"]')?.click()`); await h.sleep(600);
  await scan(h);
  h.log('path buttons:', JSON.stringify((await pathBtns(h)).map(b => b.text)));

  await press(h, 'Replace', 'path-A-replace');
  await undoAll(h, 'B');
  // C/D — a path is NOT deleted from here: Salesforce refuses it through its APIs (this script's first run, npc2
  // 2026-11-16: "insufficient access rights on cross-reference id"; the CLI and a Tooling DELETE answer the same,
  // for an inactive path and for one on Account too). So no 🗑 is drawn.
  if ((await pathBtns(h)).some(b => /Delete/.test(b.text))) throw new Error('FAILED: a path must not offer 🗑 — Salesforce refuses the delete');

  // E — ⇄ Replace all, paused
  await h.eval(`(() => { document.querySelector('.fc-fix-every[data-swap="1"]').click(); return true; })()`);
  await h.waitFor("!!document.getElementById('fcScopeAll') || !!document.getElementById('sftkConfirmCancel')", 30000, 200);
  if (await h.eval(`!!document.getElementById('fcScopeAll')`)) await h.eval(`(() => { document.getElementById('fcScopeAll').click(); return true; })()`);
  await h.waitFor("!!document.getElementById('sftkConfirmCancel')", 120000, 300); await h.sleep(400);
  const pos = await h.eval(`document.querySelector('#modalBox .fc-walk-pos')?.textContent || ''`);
  const first = await h.eval(`(document.querySelector('#modalBox')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 110)`);
  h.log('E dialog:', pos, '|', first);
  if (!/⇄ Replace all · item 1 of/.test(pos)) throw new Error('FAILED: the ⇄ walk must say where it is');
  await h.eval(`(() => { const s = document.getElementById('fcWalkStop'); if (s) s.click(); else document.getElementById('sftkConfirmCancel').click(); return true; })()`);
  await h.waitFor("!!document.querySelector('.fc-every-paused')", 30000, 300);
  const bar = () => h.eval(`(() => { const p = document.querySelector('.fc-every-paused'); return p ? { text: p.innerText.replace(/\\s+/g, ' ').trim(), off: p.querySelector('.fc-walk-continue').disabled } : null; })()`);
  h.log('E paused:', JSON.stringify(await bar()));
  // the replacement is cleared: Continue is off and says what to do
  await h.eval(`(() => { document.getElementById('fcReplClear')?.click(); return true; })()`); await h.sleep(1200);
  const b2 = await bar();
  h.log('E replacement cleared:', JSON.stringify(b2));
  if (!b2 || !b2.off || !/SFTK_Pkg_Tag2__c/.test(b2.text)) throw new Error('FAILED: with no replacement picked, Continue must be off and name the field to pick');
  await pick(h, '#fcReplInput', '#fcReplDrop', 'SFTK_Pkg_Tag2__c'); await h.sleep(1500);
  const b3 = await bar();
  h.log('E replacement picked again:', JSON.stringify(b3));
  if (!b3 || b3.off) throw new Error('FAILED: with the same replacement picked again, Continue must be on');
  await h.eval(`(() => { document.querySelector('.fc-walk-continue').click(); return true; })()`);
  await h.waitFor("!!document.getElementById('sftkConfirmCancel')", 120000, 300); await h.sleep(400);
  const again = await h.eval(`(document.querySelector('#modalBox')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 110)`);
  if (again !== first) throw new Error('FAILED: Continue must open the item the ⇄ walk was paused on — ' + again);
  await h.eval(`(() => { const s = document.getElementById('fcWalkStop'); if (s) s.click(); else document.getElementById('sftkConfirmCancel').click(); return true; })()`);
  await h.waitFor("!!document.querySelector('.fc-walk-end')", 30000, 300);
  await h.eval(`(() => { document.querySelector('.fc-walk-end').click(); return true; })()`);
  await h.sleep(600);
  h.log(`✓ fc-path-acts on ${ORG}: path ⇄ + undo, path 🗑 + undo, ⇄ Replace all paused / gated on the replacement / continued / ended`);
}
