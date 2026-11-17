// LIVE, READ-ONLY (owner 2026-11-17, a screenshot: "why the are aligned to the right?"): a row whose ✂ Remove is not
// possible keeps its NAME on the left and its buttons on the right; the note sits on its own line under them.
const ORG = process.env.ORG || 'npc2';
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
export default async function (h) {
  await h.login(ORG); await h.popup('fields'); await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', 'dlrs__LookupChild__c');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', 'SFTK_Pkg_Tag__c');
  await h.eval(`(() => { document.querySelector('#fcScanBtn').click(); return true; })()`);
  await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000);
  await h.waitFor("document.querySelectorAll('.fc-item-pre').length > 0", 240000, 1000); await h.sleep(2500);
  const rows = await h.eval(`[...document.querySelectorAll('.fc-item:has(> .fc-item-pre)')].map(it => { const n = it.querySelector('.fc-item-name'), b = it.querySelector('.fc-item-btns') || it.querySelector('.fc-fix-pair, .fc-del-pair'), p = it.querySelector('.fc-item-pre'); const r = e => e ? e.getBoundingClientRect() : null; const rn = r(n), rb = r(b), rp = r(p), ri = r(it); return { name: n ? n.textContent.trim().slice(0, 30) : null, nameW: rn && Math.round(rn.width), btnRightGap: rb && Math.round(ri.right - rb.right), preBelow: rp && rb && rp.top >= rb.bottom - 1 }; })`);
  h.log('rows with a note:', JSON.stringify(rows));
  const bad = rows.filter(r => !r.name || r.nameW < 40 || r.btnRightGap > 20 || !r.preBelow);
  await h.eval(`document.querySelector('.fc-item-pre').closest('.fc-group').scrollIntoView({ block: 'start' })`); await h.sleep(400);
  await h.shot(h.shots + '/pre-row.png');
  await h.eval(`(() => { document.body.classList.add('sftk-dark'); return true; })()`); await h.sleep(400);
  await h.shot(h.shots + '/pre-row-dark.png');
  if (!rows.length || bad.length) throw new Error('FAILED: ' + JSON.stringify(bad));
  h.log('✓ every row with a note shows its name, its buttons on the right, the note under them');
}
