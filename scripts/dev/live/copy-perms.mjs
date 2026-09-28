// Live: 👥 Copy Permissions (popup) — copy user A's access to user B in trailheads5.
// Fixture: users sftk.test.a / sftk.test.b (Identity User), A holds the permission set
// SFTK_FC_Test_Access and the public group SFTK Test Group (created by CLI, 2026-09-23).
//   SRC="SFTK Test A" TGT="SFTK Test B"   names typed into the pickers
//   SCAN_ONLY=1   stop at the confirmation (nothing written)
import { undoNewest } from './_undo.mjs';   // UNDO=1: Data Studio › History › ↩ Undo the newest entry afterwards (TYPE_IT=1 for a guarded org)
const dump = async (h, sel, n = 2500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
async function pick(h, role, name) {
  const P = 'uc' + role[0].toUpperCase() + role.slice(1);   // ucSource / ucTarget
  await h.eval(`(() => { const i = document.querySelector('#${P}Input'); i.focus(); i.value = ${JSON.stringify(name)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`[...document.querySelectorAll('#${P}List .uc-drop-item')].some(e => !e.classList.contains('uc-drop-loading') && e.innerText.includes(${JSON.stringify(name)}))`, 120000, 500);
  return h.eval(`(() => { const it = [...document.querySelectorAll('#${P}List .uc-drop-item')].find(e => e.innerText.includes(${JSON.stringify(name)})); it.click(); return it.innerText.replace(/\\s+/g, ' ').slice(0, 120); })()`);
}
export default async function (h) {
  await h.login('npc');
  await h.popup('copy-perms');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#ucSourceInput')", 60000, 500);
  await h.sleep(1500);
  h.log('source:', await pick(h, 'source', process.env.SRC || 'SFTK Test A'));
  await h.sleep(800);
  h.log('target:', await pick(h, 'target', process.env.TGT || 'SFTK Test B'));
  await h.waitFor("!!document.querySelector('.uc-ps-cb, .uc-grp-cb, #ucProfileCb') || /nothing|no permission/i.test(document.querySelector('#ucPreview')?.innerText || '')", 120000, 500);
  await h.sleep(1500);
  h.log('PREVIEW:', await dump(h, '#ucPreview', 2000));
  h.log('boxes:', JSON.stringify(await h.eval(`[...document.querySelectorAll('#ucPreview input[type=checkbox]')].map(c => (c.id || c.className) + ':' + (c.checked ? 'on' : 'off') + (c.disabled ? '(off)' : ''))`)));
  await h.shot(h.shots + '/uc-preview.png');
  h.log('copy button:', await h.eval(`(() => { const b = document.querySelector('#ucCopyBtn'); return b.textContent.trim() + (b.disabled ? ' (off)' : ''); })()`));
  await h.eval(`document.querySelector('#ucCopyBtn').click()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo') || !!document.querySelector('#ucResult')?.innerText", 60000, 500);
  await h.sleep(500);
  const gate = await h.eval(`!!document.querySelector('#sftkConfirmGo')`);
  h.log('CONFIRM shown:', gate, '|', await h.eval(`(document.querySelector('#sftkConfirmGo')?.closest('.sftk-confirm-box, .sftk-confirm, [class*=sftk-confirm]')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 1200)`));
  if (!gate) { h.log('❌ NO CONFIRMATION — the copy ran on the click. RESULT:', await dump(h, '#ucResult', 800)); return; }
  await h.shot(h.shots + '/uc-confirm.png');
  if (process.env.SCAN_ONLY === '1') { await h.eval(`(() => { const c = [...document.querySelectorAll('button')].find(b => /cancel/i.test(b.textContent)); if (c) c.click(); return true; })()`); h.log('SCAN_ONLY — cancelled'); return; }
  await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
  await h.sleep(300);
  h.log('Go enabled:', await h.eval(`!document.querySelector('#sftkConfirmGo')?.disabled`));
  await h.eval(`document.querySelector('#sftkConfirmGo').click()`);
  await h.sleep(400);
  if (await h.eval(`!!document.querySelector('#sftkConfirmProd')`)) {
    await h.eval(`(() => { const i = document.querySelector('#sftkConfirmProd'); i.value = i.placeholder; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await h.eval(`document.querySelector('#sftkConfirmProdGo')?.click()`);
  }
  await h.waitFor("!!document.querySelector('#ucResult')?.innerText && !/Copying/.test(document.querySelector('#ucCopyBtn')?.textContent || '')", 180000, 1000);
  await h.sleep(1000);
  h.log('RESULT:', await dump(h, '#ucResult', 1500));
  await h.shot(h.shots + '/uc-result.png');
  if (process.env.UNDO === '1') await undoNewest(h);
}
