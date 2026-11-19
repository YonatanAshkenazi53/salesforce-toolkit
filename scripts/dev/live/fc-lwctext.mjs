// LIVE, WRITES and takes it back: a Lightning web component that only NAMES the field (its template and a string in
// its script — no @salesforce/schema import) is listed by the regular scan under 👀 (owner 2026-11-18: "what about
// lwc and aura components … will they break?" · "why we missed them?" · "Go").
//   GROUP=ApexClassText runs the same round on the Apex class that names the field only inside a string (classes/SFTK_Kind_Dyn)
//   1  scan → the row "Lightning Web Components (name the field as text)", with 🔍 and 🗑; Salesforce accepts the delete
//   2  🔍 → the component's files, the lines that name the field marked
//   3  🗑 Delete, confirm → gone, verified by re-read;  ↩ Undo → the row is back
// Fixture: docs/fixtures/gap-kinds-fixture/kinds-app (lwc/sftkKindText). ORG=npc2 by default.
const ORG = process.env.ORG || 'npc2', OBJ = process.env.OBJ || 'SFTK_Kind__c', FIELD = process.env.FIELD || 'Tag__c';
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
const G = process.env.GROUP ? '#fcGroup_' + process.env.GROUP : '#fcGroup_LwcText';
const row = h => h.eval(`(() => { const g = document.querySelector('${G}'); const it = g && g.querySelector('.fc-item'); return it ? { sev: g.dataset.sev, head: (g.querySelector('.fc-group-hd, .fc-group-head, summary') || g).innerText.replace(/\\s+/g, ' ').slice(0, 160), fixed: it.classList.contains('fc-item-fixed'), text: it.innerText.replace(/\\s+/g, ' ').slice(0, 300) } : null; })()`);
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
  await h.eval(`(() => { document.querySelector('#fcScanBtn').click(); return true; })()`);
  await h.waitFor("!document.querySelector('#fcScanBtn').disabled", 600000, 1000);
  await h.sleep(8000);
  const r0 = await row(h);
  h.log('1 row:', JSON.stringify(r0));
  h.log('1 groups:', await h.eval(`[...document.querySelectorAll('#fcResults .fc-group')].map(g => g.id.replace('fcGroup_', '') + ':' + g.dataset.sev).join(', ')`));
  h.log('1 Salesforce:', await h.eval(`(document.getElementById('fcAskBox') || document.querySelector('.fc-ask') || {}).innerText ? (document.getElementById('fcAskBox') || document.querySelector('.fc-ask')).innerText.replace(/\\s+/g, ' ').slice(0, 200) : ''`));
  if (!r0) throw new Error('FAILED: the component that only names the field must be listed');
  if (r0.sev === 'must' && process.env.MUST !== '1') throw new Error('FAILED: it does not block — it belongs under 👀');
  if (!/Delete/.test(r0.text) || !/Setup/.test(r0.text)) throw new Error('FAILED: the row needs its ways — ' + r0.text);
  await h.eval(`(() => { document.querySelector('${G}').scrollIntoView({ block: 'center' }); return true; })()`);
  await h.shot(h.shots + '/lwctext-1-row.png');

  // 2 — 🔍
  await h.eval(`(() => { document.querySelector('${G} .fc-inspect-btn').click(); return true; })()`);
  await h.waitFor(`(() => { const p = document.querySelector('${G} [id^="fcXml_"]'); return !!p && p.style.display !== 'none' && p.innerText.length > 80; })()`, 60000, 500);
  const insp = await h.eval(`document.querySelector('${G} [id^="fcXml_"]').innerText.replace(/\\s+/g, ' ').slice(0, 500)`);
  h.log('2 inspector:', insp);
  if (!/Tag__c/.test(insp)) throw new Error('FAILED: the inspector must show the files that name the field');
  await h.shot(h.shots + '/lwctext-2-inspect.png');

  // 3 — 🗑, then ↩ Undo
  await h.eval(`(() => { document.querySelector('${G} .fc-del-btn').click(); return true; })()`);
  await confirm(h);
  await h.waitFor(`(() => { const it = document.querySelector('${G} .fc-item'); return !!it && (it.classList.contains('fc-item-fixed') || !!it.querySelector('.fc-item-err')); })()`, 300000, 1000);
  const r3 = await row(h);
  h.log('3 after 🗑:', JSON.stringify(r3));
  if (!r3.fixed || !/verified by re-reading the org/.test(r3.text)) throw new Error('FAILED: the delete must be done and verified — ' + r3.text);
  await h.eval(`(() => { document.querySelector('${G} .fc-item-undo').click(); return true; })()`);
  await confirm(h);
  for (let t = 0; t < 40; t++) {
    await h.sleep(3000);
    const st = await h.eval(`(() => ({ row: (document.querySelector('${G} .fc-item') || {}).innerText || '(no row)', scan: document.querySelector('#fcScanBtn').disabled, modal: (document.getElementById('modalBox') || {}).innerText || '' }))()`);
    if (t % 4 === 0 || /Undone|not finish|did not/.test(st.row)) h.log('  undo…', JSON.stringify(st).replace(/\n/g, ' ').slice(0, 600));
    if (!st.scan && (/did not finish|❌/.test(st.row) || !/Deleted —/.test(st.row))) break;
  }
  const r4 = await row(h);
  h.log('3 after ↩ Undo:', JSON.stringify(r4));
  if (!r4 || r4.fixed) throw new Error('FAILED: after the undo the component is back and listed');
  h.log(`✓ fc-lwctext on ${ORG}: listed under 👀, inspected, deleted and verified, undone`);
}
