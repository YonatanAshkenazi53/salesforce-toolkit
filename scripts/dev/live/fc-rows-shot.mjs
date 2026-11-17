// LIVE, READ-ONLY: the rows of a Field Cleaner scan, light and dark, at a few scroll positions — for looking at the
// row design (owner 2026-11-17: "we need to make sure they all have it and that it looks in order … its a mess right
// now … make it easier to understand and lighter"). Also checks: every row has ↗ Setup, and it is the last button.
//   ORG=npc2 OBJ=dlrs__LookupChild__c FIELD=SFTK_Pkg_Tag__c  REPL=<field api> picks a replacement (⇄ shows)  TAG=name prefix
const ORG = process.env.ORG || 'npc2', TAG = process.env.TAG || 'rows';
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
export default async function (h) {
  await h.login(ORG); await h.popup('fields'); await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', process.env.OBJ || 'dlrs__LookupChild__c');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', process.env.FIELD || 'SFTK_Pkg_Tag__c');
  if (process.env.REPL) await pick(h, '#fcReplInput', '#fcReplDrop', process.env.REPL);
  await h.eval(`document.querySelector('#fcScope [data-scope="both"]')?.click()`); await h.sleep(400);
  await h.eval(`(() => { document.querySelector('#fcScanBtn').click(); return true; })()`);
  await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000);
  await h.waitFor("document.querySelectorAll('.fc-item-pre').length > 0", 240000, 1000).catch(() => {}); await h.sleep(2500);
  const rows = await h.eval(`[...document.querySelectorAll('#fcResults .fc-item')].map(it => { const b = [...it.querySelectorAll('.fc-item-btns > button, .fc-item-btns > span > button, .fc-item-btns > a')].filter(x => getComputedStyle(x).display !== 'none'); return { name: (it.querySelector('.fc-item-name')?.textContent || '').trim().slice(0, 28), btns: b.map(x => x.textContent.replace(/\s+/g, ' ').trim()) }; })`);
  for (const r of rows) h.log('  ', r.name.padEnd(30), '|', r.btns.join(' · '));
  const noSetup = rows.filter(r => !/Setup/.test(r.btns[r.btns.length - 1] || ''));
  const groups = await h.eval(`document.querySelectorAll('#fcResults .fc-group').length`);
  const H = await h.eval(`window.innerHeight`);
  for (let i = 0; i < Number(process.env.N || 3); i++) {
    await h.eval(`(() => { const g = document.querySelector('#fcResults .fc-group'); const top = g.getBoundingClientRect().top + window.scrollY - 60; const sc = document.scrollingElement; (document.querySelector('.content, #content, main') || sc).scrollTo?.(0, 0); window.scrollTo(0, top + ${i} * ${H - 120}); return true; })()`);
    await h.eval(`(() => { const g = [...document.querySelectorAll('#fcResults .fc-group')][${i} * 5]; if (g) g.scrollIntoView({ block: 'start' }); return true; })()`);
    await h.sleep(400);
    await h.shot(h.shots + `/${TAG}-${i}.png`);
    await h.eval(`(() => { document.body.classList.add('sftk-dark'); return true; })()`); await h.sleep(500);
    await h.shot(h.shots + `/${TAG}-${i}-dark.png`);
    await h.eval(`(() => { document.body.classList.remove('sftk-dark'); return true; })()`); await h.sleep(300);
  }
  h.log(`rows ${rows.length} · groups ${groups}`);
  if (noSetup.length) throw new Error('FAILED: a row without ↗ Setup as its last button — ' + JSON.stringify(noSetup.slice(0, 6)));
  h.log('✓ every row ends with ↗ Setup');
}
