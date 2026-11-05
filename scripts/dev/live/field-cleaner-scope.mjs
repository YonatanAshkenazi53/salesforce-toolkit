// Live, read-only: Field Cleaner's scope switch (2026-11-05, a colleague's
// first day: "show the dependencies that are required for deleting the field,
// and also the other mentions that don't, and allow to scan both"). On the npc
// fixture field Account.SFTK_FC_Test_Status__c (layout, Lightning page, flows,
// report type): scan 🔍 Everything → two sections with their counts; switch to
// 🔒 What blocks the delete → the list shown again from the same scan; scan
// again in that scope → the cheap scan, the "not read" line; 👀 Other mentions
// → scanned, blockers hidden but counted in the delete zone. Nothing written.
const dump = async (h, sel, n = 2500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
const sections = h => h.eval(`[...document.querySelectorAll('.fc-section')].map(s => s.querySelector('.fc-section-title').textContent + ' = ' + s.querySelector('.fc-section-n').textContent + ' [' + [...s.querySelectorAll('.fc-group-label')].map(g => g.textContent + ' ' + g.nextElementSibling.textContent.trim()).join(', ') + ']')`);
async function scan(h, tag) {
  const calls0 = await h.eval(`(window.__sftkBg || 0)`);
  await h.eval(`(() => { window.__sftkOldRes = document.querySelector('#fcResults')?.innerHTML; document.querySelector('#fcScanBtn').click(); return true; })()`);
  await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 300000, 1000);
  await h.sleep(1500);
  h.log(`── ${tag} ──`);
  h.log('sections:', JSON.stringify(await sections(h)));
  h.log('status:', await dump(h, '.fc-status-hd', 300) || await dump(h, '.fc-clean', 300));
  h.log('unread line:', await dump(h, '.fc-fact-warn', 400) || '(none)');
  h.log('delete zone:', await dump(h, '#fcDeleteZone', 500) || await dump(h, '.fc-clean-sub', 300));
  void calls0;
}
async function setScope(h, s) {
  await h.eval(`document.querySelector('#fcScope [data-scope="${s}"]').click()`); await h.sleep(900);
  h.log(`scope → ${s}:`, 'help:', (await dump(h, '#fcScopeHelp', 120)).slice(0, 120) + '…', '| cost:', await dump(h, '#fcApiCost', 200), '| button:', await h.eval(`document.querySelector('#fcScanBtn')?.textContent.trim()`));
}

export default async function (h) {
  await h.login('npc');
  await h.popup('fields');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', 'Account');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', 'SFTK_FC_Test_Status__c');
  h.log('switch shown:', await h.eval(`document.querySelector('#fcScopeWrap')?.style.display === ''`), '| active:', await h.eval(`document.querySelector('#fcScope .active')?.dataset.scope`), '| cost:', await dump(h, '#fcApiCost', 200));
  await setScope(h, 'both');
  await scan(h, 'scan: everything');
  await h.shot(h.shots + '/fs-1-everything.png');
  await setScope(h, 'blockers');
  h.log('shown again from the same scan →', JSON.stringify(await sections(h)));
  await h.shot(h.shots + '/fs-2-blockers-view.png');
  await scan(h, 'scan: what blocks the delete');
  await h.shot(h.shots + '/fs-3-blockers-scan.png');
  await setScope(h, 'mentions');
  h.log('after a blockers-only scan the mentions need a scan →', await h.eval(`document.querySelector('#fcScanBtn')?.textContent.trim()`));
  await scan(h, 'scan: other mentions');
  await h.shot(h.shots + '/fs-4-mentions-scan.png');
  await setScope(h, 'both');
  h.log('both after a mentions scan →', await h.eval(`document.querySelector('#fcScanBtn')?.textContent.trim()`), '| sections now:', JSON.stringify(await sections(h)));
  await h.eval("document.querySelector('#sftkDarkToggle')?.click()"); await h.sleep(1200);
  await scan(h, 'scan: everything (dark)');
  await h.shot(h.shots + '/fs-5-everything-dark.png');
  h.log('persisted scope:', JSON.stringify(await h.eval(`chrome.storage.local.get('sftk_fc_scope')`)));
}
