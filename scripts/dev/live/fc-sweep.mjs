// Live (read-only): 🧭 the whole-org text sweep of Field Cleaner on the demo
// field (Account.SFTK_Live_Blk__c in npc): scan first, then plan (describe +
// list), then read, with the progress bar and the time left logged every few
// seconds; the result's groups compared with the scan's list. Screenshots at
// the plan, mid-run, and the result (light; DARK=1 adds dark).
//   OBJ=Account FIELD=SFTK_Live_Blk__c ORG=npc
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
const txt = async (h, sel, n = 2500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
const setDark = async (h, on) => { await h.eval(`document.body.classList.toggle('sftk-dark', ${on ? 'true' : 'false'}); document.body.classList.remove('sftk-oled'); true`); await h.sleep(on ? 900 : 400); };
const shot = async (h, name) => {
  await h.eval(`document.querySelector('#fcOrgSweep')?.scrollIntoView({ block: 'start' })`); await h.sleep(300);
  await h.shot(h.shots + `/${name}.png`);
  if (process.env.DARK === '1') { await setDark(h, true); await h.shot(h.shots + `/${name}-dark.png`); await setDark(h, false); }
};

export default async function (h) {
  const OBJ = process.env.OBJ || 'Account', FIELD = process.env.FIELD || 'SFTK_Live_Blk__c';
  await h.login(process.env.ORG || 'npc');
  await h.popup('fields');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', OBJ);
  await pick(h, '#fcFieldInput', '#fcFieldDrop', FIELD);
  await h.eval(`document.querySelector('#fcScope [data-scope="all"]')?.click()`); await h.sleep(300);
  await h.eval(`document.querySelector('#fcScanBtn').click()`);
  await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled && !!document.querySelector('#fcOrgSweep')", 600000, 1000);
  await h.sleep(1500);
  h.log('SCAN status:', await txt(h, '#fcStatusLine, .fc-status-hd', 300));
  const scanItems = await h.eval(`[...document.querySelectorAll('#fcResults .fc-item, #fcResults [id^="fcItem_"]')].length`);
  h.log('scan items on screen:', scanItems);
  h.log('SWEEP fact:', await txt(h, '#fcOrgSweep', 500));

  // the plan
  await h.eval(`document.querySelector('#fcSweepPlan').click()`);
  await h.waitFor("!!document.querySelector('#fcSweepGo') || /could not be read/.test(document.querySelector('#fcOrgSweep')?.innerText || '')", 600000, 1000);
  h.log('PLAN:', await txt(h, '#fcOrgSweep', 1800));
  await shot(h, 'sweep-1-plan');
  if (!(await h.eval(`!!document.querySelector('#fcSweepGo')`))) throw new Error('the plan failed');

  // the read, with the live bar
  const t0 = Date.now();
  await h.eval(`document.querySelector('#fcSweepGo').click()`);
  let midShot = false;
  for (let i = 0; i < 900; i++) {
    await h.sleep(2000);
    const meta = await txt(h, '#fcOrgSweep .fc-sweep-meta', 300);
    const running = await h.eval(`!!document.querySelector('#fcSweepStop')`);
    if (i % 3 === 0 && running) h.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, meta);
    if (running && !midShot && /%/.test(meta) && !/^0%/.test(meta.replace(/^.*?(\d+%)/, '$1'))) { midShot = true; await shot(h, 'sweep-2-running'); }
    if (!running) break;
  }
  h.log(`read took ${Math.round((Date.now() - t0) / 1000)}s`);
  const result = await txt(h, '#fcOrgSweep', 6000);
  h.log('RESULT head:', result.slice(0, 1200));
  const groups = await h.eval(`[...document.querySelectorAll('#fcOrgSweep .fc-sweep-grp')].map(g => g.querySelector('.fc-sweep-grp-hd').innerText.replace(/\\s+/g, ' ').trim() + ' :: ' + [...g.querySelectorAll('.fc-sweep-item-hd code')].map(c => c.textContent).join(', '))`);
  h.log('GROUPS:'); for (const g of groups) h.log('   ', g);
  h.log('pills:', await txt(h, '#fcOrgSweep .fc-sweep-sum', 400));
  h.log('notes:', JSON.stringify(await h.eval(`[...document.querySelectorAll('#fcOrgSweep .fc-sweep-why')].map(e => e.innerText).filter(t => /^ℹ/.test(t))`)));
  await shot(h, 'sweep-3-result');
}
