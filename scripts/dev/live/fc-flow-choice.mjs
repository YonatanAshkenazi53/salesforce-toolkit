// The flow dialog's "active version — choose" cards (user 2026-11-11: "kind of hard to understand each scenario here").
// READ-ONLY: opens ✂ on the flow that holds a decision outcome resting on the field, shoots the dialog, cancels.
//   ORG=npc2 (default) · OBJ / FIELD · FLOW=Child Trigger · DARK=1
const FIELD = process.env.FIELD || 'SFTK_Pkg_Tag__c', OBJ = process.env.OBJ || 'dlrs__LookupChild__c', FLOW = process.env.FLOW || 'Child Trigger';
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
export default async function (h) {
  await h.login(process.env.ORG || 'npc2');
  await h.popup('fields');
  await h.watchErrors();
  if (process.env.DARK) await h.eval("(() => { document.documentElement.setAttribute('data-theme', 'dark'); document.body.classList.add('dark'); return true; })()");
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', OBJ);
  await pick(h, '#fcFieldInput', '#fcFieldDrop', FIELD);
  await h.eval(`(() => { document.querySelector('#fcScanBtn').click(); return true; })()`);
  await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000);
  await h.sleep(6000);
  const ok = await h.eval(`(() => { const row = [...document.querySelectorAll('.fc-item')].find(i => i.innerText.includes(${JSON.stringify(FLOW)})); const b = row && [...row.querySelectorAll('.fc-fix-btn')].find(x => /Remove/.test(x.innerText)); if (!b) return false; b.click(); return true; })()`);
  if (!ok) throw new Error('no ✂ button on the flow row');
  await h.waitFor("!!document.querySelector('input[name=fcActiveMode]')", 120000, 500);
  await h.eval("(() => { document.querySelector('.fc-prev-hd')?.scrollIntoView({ block: 'start' }); return true; })()"); await h.sleep(500);
  if (process.env.OPEN) { await h.eval("(() => { const d = document.querySelector('.fc-prev-more'); d.open = true; d.scrollIntoView({ block: 'start' }); return true; })()"); await h.sleep(500); await h.shot(h.shots + '/flow-inside' + (process.env.DARK ? '-dark' : '') + '.png'); }
  h.log('OPTIONS:', (await h.eval("[...document.querySelectorAll('.fc-prev-opt')].map(o => o.innerText.split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ')).join('  ###  ')")).slice(0, 2400));
  await h.shot(h.shots + `/flow-choice${process.env.DARK ? '-dark' : ''}.png`);
  await h.eval("(() => { document.querySelector('#sftkConfirmCancel').click(); return true; })()");
  h.log('✅ cancelled — nothing written');
}
