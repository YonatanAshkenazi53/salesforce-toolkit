// LIVE, WRITES and takes it back: ✂ on a search layout of a PACKAGED object (owner 2026-11-17: "i want it to work as
// well. i dont want the user to edit manually" — the row used to answer "belongs to a package … edited in Setup").
//   1  scan the fixture field, ✂ Remove on the Search Layouts row, confirm      → the row says done, verified by re-read
//   2  ↩ Undo on that row, confirm                                              → the list is scanned again, the row is back
// Fixture: docs/fixtures/packaged-object-fixture. ORG=npc by default.
const ORG = process.env.ORG || 'npc', OBJ = process.env.OBJ || 'dlrs__LookupChild__c', FIELD = process.env.FIELD || 'SFTK_Pkg_Tag__c';
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
const row = h => h.eval(`(() => { const g = document.getElementById('fcGroup_SearchLayout'); const it = g && g.querySelector('.fc-item'); return it ? { fixed: it.classList.contains('fc-item-fixed'), text: it.innerText.replace(/\\s+/g, ' ').slice(0, 400) } : null; })()`);
const confirm = async h => {
  await h.waitFor("!!document.getElementById('sftkConfirmGo')", 60000, 300); await h.sleep(400);
  await h.eval(`(() => { const a = document.getElementById('sftkConfirmAck'); if (a && !a.checked) a.click(); document.getElementById('sftkConfirmGo').click(); return true; })()`);
};

export default async function (h) {
  await h.login(ORG);
  await h.popup('fields');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', OBJ);
  await pick(h, '#fcFieldInput', '#fcFieldDrop', FIELD);
  await h.eval(`(() => { const b = document.querySelector('#fcScope [data-scope="both"]'); if (b) b.click(); return true; })()`); await h.sleep(600);
  await h.eval(`(() => { document.querySelector('#fcScanBtn').click(); return true; })()`);
  await h.waitFor("!document.querySelector('#fcScanBtn').disabled", 600000, 1000);
  await h.sleep(6000);
  const r0 = await row(h);
  h.log('0 row:', JSON.stringify(r0));
  if (!r0) throw new Error('FAILED: the fixture must have a Search Layouts row');

  await h.eval(`(() => { document.querySelector('#fcGroup_SearchLayout .fc-fix-btn[data-swap="0"]').click(); return true; })()`);
  await confirm(h);
  await h.waitFor(`(() => { const it = document.querySelector('#fcGroup_SearchLayout .fc-item'); return !!it && (it.classList.contains('fc-item-fixed') || !!it.querySelector('.fc-item-err')); })()`, 300000, 1000);
  const r1 = await row(h);
  h.log('1 after ✂:', JSON.stringify(r1));
  await h.eval(`(() => { document.getElementById('fcGroup_SearchLayout').scrollIntoView({ block: 'center' }); return true; })()`);
  await h.shot(h.shots + '/slpkg-1-done.png');
  if (!r1.fixed || !/verified by re-reading the org/.test(r1.text)) throw new Error('FAILED: the search layout of a packaged object must be fixed here — ' + r1.text);

  await h.eval(`(() => { document.querySelector('#fcGroup_SearchLayout .fc-item-undo').click(); return true; })()`);
  await confirm(h);
  // the undo deploys, then the list is scanned again: the row comes back open
  await h.waitFor(`(() => { const it = document.querySelector('#fcGroup_SearchLayout .fc-item'); return !!it && !it.classList.contains('fc-item-fixed') && !document.querySelector('#fcScanBtn').disabled; })()`, 300000, 1500);
  const r2 = await row(h);
  h.log('2 after ↩ Undo:', JSON.stringify(r2));
  if (!r2 || r2.fixed) throw new Error('FAILED: after the undo the layout lists the field again');
  h.log(`✓ fc-searchlayout-pkg on ${ORG}: ✂ done and verified on a packaged object, then undone`);
}
