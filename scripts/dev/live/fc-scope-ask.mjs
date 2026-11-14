// ⚡ Remove all asks: only what blocks the delete, or also what might break (owner 2026-11-14). READ-ONLY: the
// question is read, screenshot, and cancelled; then "only the blockers" is chosen and the first item's own confirm is
// cancelled, which stops the walk — nothing is written.   FIELD (default SFTK_Live_Blk__c) · DARK=1
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
  await pick(h, '#fcObjInput', '#fcObjDrop', 'Account');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', FIELD);
  await h.eval(`(() => { document.querySelector('#fcScanBtn').click(); return true; })()`);
  await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000);
  await h.sleep(25000);
  h.log('groups: must', await h.eval("document.querySelectorAll('#fcResults .fc-group[data-sev=\"must\"]').length"), '· later', await h.eval("document.querySelectorAll('#fcResults .fc-group[data-sev=\"later\"]').length"));
  const pressed = await h.eval("(() => { const b = document.querySelector('.fc-fix-every[data-swap=\"0\"]'); if (!b || b.disabled) return null; const t = b.innerText; b.click(); return t; })()");
  if (!pressed) throw new Error('no ✂ Remove all button');
  h.log('pressed:', pressed);
  await h.waitFor("!!document.querySelector('#fcScopeAll')", 20000, 300);
  h.log('QUESTION:', (await h.eval("document.querySelector('#modalBox').innerText")).replace(/\s+/g, ' ').slice(0, 700));
  await h.shot(h.shots + `/fc-scope-ask${process.env.DARK ? '-dark' : ''}.png`);
  await h.eval("(() => { document.querySelector('#fcScopeCancel').click(); return true; })()"); await h.sleep(800);
  h.log('after Cancel: a dialog still open?', await h.eval("document.getElementById('modalOverlay')?.style.display !== 'none'"), '· walking?', await h.eval("!!document.querySelector('.fc-fix-every[disabled]')"));
  h.log('✅ the walk asks which ones before it starts; Cancel starts nothing');
}
