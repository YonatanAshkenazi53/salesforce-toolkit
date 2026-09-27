// Live: ⏻ Flow switches (Dependencies tab) — tick the fixture flows
// (docs/fixtures/flowswitch-fixture: SFTK_FS_Test_Acc1/Acc2 on Account, Con1 on Contact,
// record-triggered, Active), switch them OFF (or ON), type the word, apply, report.
//   MODE=off|on|cycle  (default off; cycle = OFF then ON in the SAME session, so the
//                       remembered active versions are there for ▶ Switch ON)
//   PICK=<regex>       rows to tick (default ^SFTK_FS_Test)
//   ORGS=npc[,npc2]    (default npc)
//   SCAN_ONLY=1        stop after the confirmation text (nothing written)
//   UNDO=1             afterwards: Data Studio › History › ↩ Undo the newest entry (TYPE_IT=1 for a guarded org)
import { undoNewest } from './_undo.mjs';
const dump = async (h, sel, n = 2500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
const PICK = () => process.env.PICK || '^SFTK_FS_Test';

async function waitRows(h) {
  await h.waitFor("document.querySelectorAll('.dep-fb-cb').length > 0 || /could not|no flows|nothing/i.test(document.querySelector('#depFbBody, #depToolPanel')?.innerText || '')", 300000, 1500);
  await h.sleep(1200);
}
async function fixtureRows(h) {
  return h.eval(`[...document.querySelectorAll('.dep-fb-cb')].filter(c => new RegExp(${JSON.stringify(PICK())}).test(c.value)).map(c => c.value + ' grp=' + c.dataset.grp + ' on=' + c.dataset.on + (c.disabled ? ' (LOCKED)' : '') + ' :: ' + (c.closest('label')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 160))`);
}
async function reload(h) {
  // the old rows stay on screen until the fresh read lands — wait for NEW checkbox elements
  await h.eval(`(() => { window.__sftkOldCb = document.querySelector('.dep-fb-cb'); document.querySelector('#depFbReload')?.click(); return true; })()`);
  await h.waitFor("document.querySelectorAll('.dep-fb-cb').length > 0 && document.querySelector('.dep-fb-cb') !== window.__sftkOldCb", 300000, 1000);
  await h.sleep(1200);
}
async function switchOnce(h, mode) {
  h.log(`── ${mode.toUpperCase()} ──`);
  const ticked = await h.eval(`(() => { let n = 0; document.querySelectorAll('.dep-fb-cb').forEach(c => { const want = new RegExp(${JSON.stringify(PICK())}).test(c.value) && !c.disabled; if (c.checked !== want) { c.checked = want; c.dispatchEvent(new Event('change', { bubbles: true })); } if (want) n++; }); return n; })()`);
  h.log('ticked:', ticked, '| count line:', await dump(h, '#depFbCount', 100));
  const btnSel = mode === 'on' ? '#depFbOn' : '#depFbOff';
  h.log('button:', await h.eval(`(() => { const b = document.querySelector(${JSON.stringify(btnSel)}); return b ? b.textContent.trim() + (b.disabled ? ' (off)' : '') : null; })()`));
  await h.eval(`document.querySelector(${JSON.stringify(btnSel)})?.click()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo') || /nothing|none of|already/i.test(document.querySelector('#depFbOut')?.innerText || '')", 120000, 500);
  await h.sleep(500);
  h.log('CONFIRM:', await dump(h, '#modalBox', 2500));
  await h.shot(h.shots + `/fs-confirm-${mode}.png`);
  if (process.env.SCAN_ONLY === '1') { h.log('SCAN_ONLY — cancelling'); await h.eval(`document.querySelector('#sftkConfirmCancel')?.click()`); return false; }
  if (!(await h.eval(`!!document.querySelector('#sftkConfirmWord')`))) { h.log('no confirmation input — stopping'); return false; }
  const word = mode === 'on' ? 'ON' : 'OFF';
  await h.eval(`(() => { const i = document.querySelector('#sftkConfirmWord'); i.value = ${JSON.stringify(word)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.sleep(300);
  h.log('Go enabled:', await h.eval(`!document.querySelector('#sftkConfirmGo')?.disabled`));
  await h.eval(`document.querySelector('#sftkConfirmGo')?.click()`);
  await h.sleep(400);
  if (await h.eval(`!!document.querySelector('#sftkConfirmProd')`)) {
    h.log('TYPED GATE (production):', await dump(h, '#modalBox', 500));
    await h.eval(`(() => { const i = document.querySelector('#sftkConfirmProd'); i.value = i.placeholder; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await h.eval(`document.querySelector('#sftkConfirmProdGo')?.click()`);
  }
  await h.waitFor("/switched (OFF|ON)|❌|stale/.test(document.querySelector('#depFbOut')?.innerText || '')", 600000, 1000);
  await h.sleep(800);
  h.log('REPORT:', await dump(h, '#depFbOut', 3000));
  await h.shot(h.shots + `/fs-report-${mode}.png`);
  await reload(h);
  h.log('after reload:', JSON.stringify(await fixtureRows(h)));
  return true;
}

export default async function (h) {
  for (const o of (process.env.ORGS || 'npc').split(',')) await h.login(o.trim());
  await h.popup('dependencies');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#depBulkBtn')", 240000, 1000);
  await h.sleep(800);
  await h.eval(`document.querySelector('#depBulkBtn').click()`);
  await waitRows(h);
  h.log('fixture rows:', JSON.stringify(await fixtureRows(h), null, 0));
  h.log('rows total:', await h.eval(`document.querySelectorAll('.dep-fb-cb').length`), 'groups:', JSON.stringify(await h.eval(`[...new Set([...document.querySelectorAll('.dep-fb-cb')].map(c => c.dataset.grp))].slice(0, 12)`)));
  h.log('apply-org boxes:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.dep-fb-applyorg')].map(c => c.value + (c.checked ? '*' : '') + (c.disabled ? '(off)' : ''))`)));
  await h.shot(h.shots + '/fs-panel.png');
  const mode = (process.env.MODE || 'off').toLowerCase();
  if (mode === 'cycle') { if (await switchOnce(h, 'off')) await switchOnce(h, 'on'); }
  else await switchOnce(h, mode);
  if (process.env.UNDO === '1') await undoNewest(h);
}
