// 🩺 Ask Salesforce rides every scan — the check-only delete, on a field Salesforce refuses, on one whose blocker the
// index did not return (the Aura bundle joins the list), and on one it accepts. Nothing is written.
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
async function run(h, obj, field, tag) {
  await h.popup('fields');
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', obj);
  await pick(h, '#fcFieldInput', '#fcFieldDrop', field);
  await h.eval(`(() => { document.querySelector('#fcScanBtn').click(); return true; })()`);
  await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000);
  // no click: the answer arrives by itself
  await h.waitFor("!!document.querySelector('#fcAskBox') && !document.querySelector('#fcAskBox').hidden && !document.querySelector('#fcAskBtn').disabled", 180000, 1000);
  await h.sleep(1500);
  h.log(`── ${tag}: ${obj}.${field} ──`);
  h.log('estimate:', (await h.eval(`(document.querySelector('.fc-budget, #fcBudget, .fc-scan-cost')?.innerText || '')`)).slice(0, 60));
  h.log('delete note:', await h.eval(`(document.querySelector('#fcDeleteNote, .fc-clean-sub')?.innerText || '')`));
  h.log('delete button:', await h.eval(`(() => { const b = document.querySelector('#fcDelBtn, #fcDelFreeBtn'); return b ? (b.disabled ? 'locked' : 'OPEN') : 'none'; })()`));
  h.log('box:', await h.eval(`document.querySelector('#fcAskBox').innerText`));
  h.log('rows:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.fc-group')].map(g => g.querySelector('.fc-group-label').textContent + ': ' + [...g.querySelectorAll('.fc-item')].map(i => i.querySelector('.fc-item-name')?.textContent.trim() + (i.querySelector('.fc-item-tag') ? ' [' + i.querySelector('.fc-item-tag').textContent + ']' : '') + ' {' + [...i.querySelectorAll('button')].map(b => b.textContent.trim()).join(' ') + '}').join(' / ')).filter(x => /Aura|Other/.test(x))`)));
  await h.eval(`document.querySelector('#fcAskBox').scrollIntoView({ block: 'center' })`); await h.sleep(500);
  await h.shot(`${h.shots}/ask-${tag}-light.png`);
  await h.eval(`(() => { document.body.classList.add('sftk-dark'); document.body.classList.remove('sftk-oled'); return true; })()`); await h.sleep(400);
  await h.shot(`${h.shots}/ask-${tag}-dark.png`);
  await h.eval(`(() => { document.body.classList.remove('sftk-dark'); return true; })()`);
}
export default async function (h) {
  await h.login('npc');
  await h.popup('fields');
  await h.watchErrors();
  await run(h, 'Account', 'SFTK_Live_Blk__c', 'missed');
  await run(h, 'dlrs__LookupChild__c', 'SFTK_Pkg_Tag__c', 'blocked');
  await run(h, 'Account', 'SFTK_Live_Blk2__c', 'free');
}
