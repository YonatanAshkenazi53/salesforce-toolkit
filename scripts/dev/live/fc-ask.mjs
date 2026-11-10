// 🩺 Ask Salesforce — the check-only delete, on a field Salesforce refuses and on one it accepts. Nothing is written.
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
  await h.waitFor("!!document.querySelector('#fcAskBtn')", 30000, 500);
  h.log(`── ${tag}: ${obj}.${field} ──`);
  h.log('delete note:', await h.eval(`(document.querySelector('#fcDeleteNote, .fc-clean-sub')?.innerText || '')`));
  await h.eval(`(() => { document.querySelector('#fcAskBtn').click(); return true; })()`);
  await h.waitFor("!document.querySelector('#fcAskBox')?.hidden", 180000, 1000);
  h.log('box class:', await h.eval(`document.querySelector('#fcAskBox').className`));
  h.log('box:', await h.eval(`document.querySelector('#fcAskBox').innerText`));
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
  await run(h, 'dlrs__LookupChild__c', 'SFTK_Pkg_Tag__c', 'blocked');
  await run(h, 'Account', 'SFTK_Live_Blk__c', 'missed');
  await run(h, 'Account', 'SFTK_Live_Blk2__c', 'free');
}
