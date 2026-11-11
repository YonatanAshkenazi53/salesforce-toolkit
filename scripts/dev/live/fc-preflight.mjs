// ✂ Remove known BEFORE the click (user 2026-11-11): the demo field is scanned and nothing is pressed. Every row whose
// ✂ would be refused must already say so — the button off, the reason under the row. READ-ONLY: nothing is written.
//   FIELD=SFTK_Live_Blk__c (default) · DARK=1 for the dark theme
const FIELD = process.env.FIELD || 'SFTK_Live_Blk__c';
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
export default async function (h) {
  await h.login('npc');
  await h.popup('fields');
  await h.watchErrors();
  if (process.env.DARK) await h.eval("(() => { document.documentElement.setAttribute('data-theme', 'dark'); document.body.classList.add('dark'); return true; })()");
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', process.env.OBJ || 'Account');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', FIELD);
  await h.eval(`(() => { document.querySelector('#fcScanBtn').click(); return true; })()`);
  await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000);
  h.log('STATUS:', (await h.eval("document.querySelector('.fc-summary, #fcSummary, .fc-status')?.innerText || ''")).replace(/\s+/g, ' ').slice(0, 200));
  h.log('ALL ROWS:', JSON.stringify(await h.eval("[...document.querySelectorAll('.fc-item')].map(i => (i.closest('.fc-group')?.id || '').replace('fcGroup_', '') + ': ' + (i.querySelector('.fc-item-name')?.innerText.trim() || '') + ' {' + [...i.querySelectorAll('.fc-item-btns button')].map(b => b.innerText.trim()).join(' ') + '}')")));
  const t0 = Date.now();
  // the pre-check walks the rows one by one: wait until the count of notes stops growing
  let last = -1, same = 0;
  while (same < 6 && Date.now() - t0 < 240000) { await h.sleep(2500); const n = await h.eval("document.querySelectorAll('.fc-item-pre').length"); same = n === last ? same + 1 : 0; last = n; }
  const rows = await h.eval(`[...document.querySelectorAll('.fc-item')].filter(i => i.querySelector('.fc-item-pre')).map(i => ({
    name: i.querySelector('.fc-item-name')?.innerText.trim(), group: i.closest('.fc-group')?.querySelector('.fc-group-title, .fc-group-name')?.innerText.trim() || '',
    note: i.querySelector('.fc-item-pre').innerText, off: !!i.querySelector('.fc-pre-no[disabled]'), live: !!i.querySelector('.fc-edit-btn[data-swap="0"][data-way="edit"]'),
    others: [...i.querySelectorAll('.fc-item-btns button:not([disabled])')].map(b => b.innerText.trim()).join(' | ') }))`);
  h.log(`rows that say ✂ is not possible, before any click (${rows.length}), settled after ${Math.round((Date.now() - t0) / 1000)}s:`);
  for (const r of rows) h.log(`  ${r.group} · ${r.name} → ${r.note} · button off: ${r.off} · a live ✂ left: ${r.live} · still offered: ${r.others}`);
  h.log('⚡ row:', (await h.eval("document.querySelector('#fcFixEvery')?.innerText || ''")).replace(/\s+/g, ' '));
  const first = await h.eval("(() => { const n = document.querySelector('.fc-item-pre'); if (!n) return false; n.scrollIntoView({ block: 'center' }); return true; })()");
  await h.sleep(600);
  await h.shot(h.shots + `/preflight${process.env.DARK ? '-dark' : ''}.png`);
  if (rows.some(r => !r.off || r.live)) throw new Error('a row says ✂ is not possible but still offers it');
  h.log(first ? '✅ every refusal is on the page before the click' : 'ℹ no row refuses ✂ on this field right now');
}
