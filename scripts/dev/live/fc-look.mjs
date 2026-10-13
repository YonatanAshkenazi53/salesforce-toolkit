// Look at the Field Cleaner results screen and a flow's confirmation, as the user sees them
// (results v2, 2026-10-13: "a lot of text on the screen … messy"). Read-only: the scan runs, the
// confirmation is opened and cancelled, nothing is written.
//   node scripts/dev/headless-studio.mjs scripts/dev/live/fc-look.mjs
import { } from 'node:fs';
const J = JSON.stringify;
const OLD_FIELD = process.env.FIELD || 'SFTK_FC_Test_Status__c', NEW_FIELD = process.env.NEW_FIELD || 'SFTK_FC_Test_Status2__c';
async function pick(h, input, drop, api) {
  await h.eval(`(() => { const i = document.querySelector(${J(input)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${drop} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${J(input)}); i.value = ${J(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${drop} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${drop} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(900);
}
export default async function (h) {
  await h.login('npc');
  await h.popup('fields');
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', 'Account');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', OLD_FIELD);
  await h.waitFor("!document.querySelector('#fcReplInput')?.disabled", 60000, 500);
  await pick(h, '#fcReplInput', '#fcReplDrop', NEW_FIELD);
  await h.eval(`document.querySelector('#fcScanBtn').click()`);
  await h.waitFor("/reference|Nothing references|No references|found|dependenc|place/i.test(document.querySelector('#fcResults')?.innerText || '') && !/scanning|⏳|Measuring/i.test(document.querySelector('#fcResults')?.innerText || '')", 180000, 1000);
  await h.sleep(2500);
  h.log('STATUS CARD:', (await h.eval(`(document.querySelector('#fcStatus')?.innerText || '').replace(/\\s+/g, ' ')`)).slice(0, 1200));
  await h.eval(`(() => { document.querySelector('#fcStatus')?.scrollIntoView({ block: 'start' }); return true; })()`);
  await h.sleep(400);
  await h.shot(h.shots + '/fc-look-1-status.png');
  await h.eval(`(() => { document.querySelector('#fcGroup_Flow')?.scrollIntoView({ block: 'start' }); return true; })()`);
  await h.sleep(400);
  await h.shot(h.shots + '/fc-look-2-groups.png');
  // a flow's Replace confirmation, opened and cancelled
  const opened = await h.eval(`(() => { const b = document.querySelector('#fcGroup_Flow .fc-fix-btn[data-swap="1"]'); if (!b) return false; b.click(); return true; })()`);
  if (opened) {
    await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 60000, 300);
    await h.sleep(800);
    h.log('DIALOG:', (await h.eval(`(document.querySelector('#modalBox')?.innerText || '').replace(/\\s+/g, ' ')`)).slice(0, 1500));
    await h.shot(h.shots + '/fc-look-3-dialog.png');
    await h.eval(`(() => { document.querySelector('#modalBox details.fc-prev-more')?.setAttribute('open', ''); return true; })()`);
    await h.sleep(300);
    await h.shot(h.shots + '/fc-look-4-dialog-open.png');
    await h.eval(`document.querySelector('#sftkConfirmCancel')?.click()`);
    await h.sleep(500);
  } else h.log('no flow Replace button found');
  const errs = await h.eval(`(window.__sftkErrors || []).slice(0, 5)`);
  h.log('page errors:', JSON.stringify(errs));
}
