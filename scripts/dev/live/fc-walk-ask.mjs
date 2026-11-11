// ✂ Remove all in one take (user 2026-11-11): the walk never passes over an item in silence. Where ✂ cannot work the
// dialog says why and asks for the whole component. READ-ONLY here: every "cannot remove" dialog is answered
// "Skip this one", and the first ordinary ✂ confirm is cancelled (which stops the walk) — nothing is written.
//   FIELD=SFTK_Live_Blk__c (default) · DARK=1
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
  await h.sleep(25000);   // the pre-check settles
  h.log('⚡ row:', (await h.eval("document.querySelector('#fcFixEvery')?.innerText || ''")).replace(/\s+/g, ' '));
  h.log('open rows:', await h.eval("document.querySelectorAll('.fc-fix-pair, .fc-del-pair').length"), '· pre-refused:', await h.eval("document.querySelectorAll('.fc-pre-no').length"));
  const pressed = await h.eval("(() => { const b = document.querySelector('.fc-fix-every[data-swap=\"0\"]'); if (!b || b.disabled) return null; const t = b.innerText; b.click(); return t; })()");
  if (!pressed) throw new Error('no ✂ Remove all button');
  h.log('pressed:', pressed);
  let asked = 0, shot = false;
  for (let i = 0; i < 60; i++) {
    try { await h.waitFor("!!document.querySelector('#sftkConfirmCancel')", 90000, 400); } catch (_) { h.log('no further dialog — the walk ended'); break; }
    const d = await h.eval(`(() => { const w = document.querySelector('.fc-cf-why'); const m = document.querySelector('#sftkConfirmCancel').closest('.sftk-cf, .modal, [role=dialog]') || document.body;
      return { why: w ? w.innerText.replace(/\\s+/g, ' ') : '', title: (m.querySelector('.sftk-cf-title, h2, h3')?.innerText || '').replace(/\\s+/g, ' '), cancel: document.querySelector('#sftkConfirmCancel').innerText, go: document.querySelector('#sftkConfirmGo')?.innerText || '' }; })()`);
    if (!d.why) { h.log(`an ordinary confirm (“${d.title}”) — cancelled here, which stops the walk (nothing written)`); await h.eval("(() => { document.querySelector('#sftkConfirmCancel').click(); return true; })()"); break; }
    asked++;
    h.log(`ASK ${asked}: “${d.title}” · buttons: [${d.cancel}] [${d.go}] · ${d.why.slice(0, 260)}`);
    if (!/Skip this one/.test(d.cancel)) throw new Error('the dialog has no “Skip this one”');
    if (!shot) { await h.shot(h.shots + `/walk-ask${process.env.DARK ? '-dark' : ''}.png`); shot = true; }
    await h.eval("(() => { document.querySelector('#sftkConfirmCancel').click(); return true; })()");
    await h.sleep(1200);
  }
  await h.sleep(1500);
  const left = await h.eval("[...document.querySelectorAll('.fc-item-pre')].filter(n => /^Left as it is|Remove is not possible here/.test(n.innerText)).length");
  h.log(`asked about ${asked} item(s) that ✂ cannot handle; ${left} skipped and marked “Left as it is”`);
  if (!asked) throw new Error('the walk asked about nothing — on the demo field the formula fields come first and have no ✂');
  if (left !== asked) throw new Error(`skipped ${asked} but ${left} rows say so`);
  h.log('✅ the walk stops on what ✂ cannot handle, says why, and offers the whole component / skip / stop');
}
