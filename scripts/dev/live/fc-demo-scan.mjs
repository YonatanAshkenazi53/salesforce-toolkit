const NL = String.fromCharCode(10);
const dump = async (h, sel, n = 2500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
const groups = h => h.eval(`[...document.querySelectorAll('.fc-section')].map(s => ({ section: s.querySelector('.fc-section-title').textContent.slice(0, 2), n: s.querySelector('.fc-section-n').textContent, groups: [...s.querySelectorAll('.fc-group')].map(g => g.querySelector('.fc-group-label').textContent + ' ' + g.querySelector('.fc-group-count').textContent.trim() + ': ' + [...g.querySelectorAll('.fc-item-name')].map(i => i.textContent.trim()).join(' / ')) }))`);
async function scan(h, tag) {
  await h.eval(`(() => { document.querySelector('#fcScanBtn').click(); return true; })()`);
  await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000);
  await h.sleep(1500);
  h.log(`── ${tag} ──`);
  for (const s of await groups(h)) { h.log(`${s.section} ${s.n}`); for (const g of s.groups) h.log('   ', g); }
  h.log('status:', await dump(h, '.fc-status-hd', 300) || await dump(h, '.fc-clean', 300));
  h.log('unread line:', await dump(h, '.fc-fact-warn', 600) || '(none)');
  h.log('blockers by hand:', await dump(h, '.fc-blockers', 800) || '(none)');
  h.log('PB note:', await dump(h, '.fc-pb-note', 300) || '(none)');
  h.log('delete button:', await h.eval(`(() => { const b = document.querySelector('#fcDeleteBtn, #fcDelFreeBtn'); return b ? b.textContent.trim() + (b.disabled ? ' (off)' : ' (ON)') : 'none'; })()`));
}
export default async function (h) {
  await h.login('npc');
  await h.popup('fields');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', 'Account');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', 'SFTK_Live_Blk__c');
  await h.eval(`document.querySelector('#fcScope [data-scope="both"]')?.click()`); await h.sleep(600);
  await scan(h, 'demo fixture: everything');
  h.log('fix buttons:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.fc-group')].map(g => g.querySelector('.fc-group-label').textContent + ' → ' + [...new Set([...g.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean))].join(' / '))`)));
  await h.shot(h.shots + '/demo-1.png');
  await h.eval(`document.querySelector('#fcSectionBlockers')?.scrollIntoView({ block: 'start' })`); await h.sleep(500);
  await h.shot(h.shots + '/demo-2.png');
}
