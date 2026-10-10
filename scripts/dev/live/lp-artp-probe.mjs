// Probe (read-only): which record types and profiles the ARTP tab offers for the fixture page, and what the confirmation lists
export default async function (h) {
  await h.login('npc'); await h.popup('pages');
  await h.waitFor("document.querySelectorAll('.lp-row').length > 0", 240000, 1000);
  await h.eval(`(() => { const r = [...document.querySelectorAll('.lp-row')].find(x => /SFTK LP Test Account Page/i.test(x.querySelector('.lp-row-name')?.textContent || '')); r.click(); return !!r; })()`);
  await h.waitFor("!!document.querySelector('#lpDetailBody .lp-status-bar')", 180000, 1000); await h.sleep(500);
  await h.eval(`document.querySelector('.lp-atab[data-tab="artp"]').click()`); await h.sleep(500);
  h.log('RT list:', await h.eval(`[...document.querySelectorAll('#lpARTPRTList .lp-multi-item')].map(e => e.innerText.trim()).join(' | ')`));
  h.log('apps offered:', await h.eval(`document.querySelectorAll('#lpARTPAppList .lp-app-item').length`), '| Learning Home:', await h.eval(`[...document.querySelectorAll('#lpARTPAppList .lp-app-item')].some(e => /Learning Home/.test(e.innerText))`));
  h.log('profiles offered:', await h.eval(`[...document.querySelectorAll('#lpARTPProfileList .lp-multi-item, #lpARTPProfileList .lp-app-item')].map(e => e.innerText.trim()).slice(0, 12).join(' | ')`));
  await h.eval(`(() => { const app = [...document.querySelectorAll('#lpARTPAppList .lp-app-item')].find(e => /Learning Home/.test(e.innerText)); app.querySelector('input').click(); document.querySelector('#lpARTPRTAll').click(); const p = [...document.querySelectorAll('#lpARTPProfileList .lp-multi-item, #lpARTPProfileList .lp-app-item')].find(e => /System Administrator/.test(e.innerText)); p.querySelector('input').click(); return true; })()`);
  await h.sleep(600);
  h.log('RT boxes checked:', await h.eval(`[...document.querySelectorAll('#lpARTPRTList input[type=checkbox]:checked')].map(c => c.value || c.id).join(', ')`));
  await h.eval(`document.querySelector('#lpAddBtnARTP').click()`); await h.sleep(1500);
  h.log('CONFIRM:', (await h.eval(`(document.querySelector('.sftk-cf-host')?.innerText || document.querySelector('#modalBox')?.innerText || '')`)).replace(/\s+/g, ' ').slice(0, 900));
  await h.eval(`document.querySelector('#sftkConfirmCancel')?.click()`);
  h.log('cancelled — nothing written');
}
