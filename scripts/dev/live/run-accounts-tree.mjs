// End-to-end run of one fixture deployment (PROFILE env, default the Accounts tree), PASSES env for repeats.
// Read both orgs, report what the page says, select every Insert row on every
// object (+ every Changed row → overwrite), deploy, wait, report the log.
const SHOTS = process.env.LOCALAPPDATA + '/Temp/sftk-headless-shots/';
const dump = async (h, sel, n = 1200) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).replace(/\n+/g, ' | ');
export default async function (h) {
  await h.login('npc');
  await h.login('npc2');
  await h.studio('');
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK CX — Accounts tree';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  h.log('deployment:', NAME);
  if (!id) throw new Error('fixture profile missing');
  const passes = Number(process.env.PASSES || 1);
  for (let pass = 1; pass <= passes; pass++) {
  h.log(`===== PASS ${pass} of ${passes} =====`);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`);
  await h.sleep(1500);
  h.log('offline card:', await h.eval(`!!document.querySelector('.ds-rec-card-warn') && document.querySelector('.ds-rec-card-warn').innerText.includes('not open')`));
  // first visit: "Read both orgs now"; later visits open on the last scan → Refresh
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", Number(process.env.SCAN_WAIT || 120000), 1000);
  await h.sleep(2500);
  h.log('PLAN:', await dump(h, '.ds-dep-plan', 1600));
  // children are scanned on demand: scan each one via its "Scan" button until none is left
  // one click per child, like a user (there is no "scan all children" — a finding)
  const scanFailed = [];
  for (let i = 0; i < 20; i++) {
    const which = await h.eval(`(() => { const skip = new Set(${JSON.stringify(scanFailed)}); const b = [...document.querySelectorAll('[data-dep-scan]')].find(b => !/Rescan/.test(b.textContent) && !skip.has(b.dataset.depScan)); return b ? b.dataset.depScan : null; })()`);
    if (which === null) break;
    await h.eval(`(() => { const b = document.querySelector('[data-dep-scan="${which}"]'); b.click(); })()`);
    h.log('scanning child', which);
    await h.waitFor(`(() => { const b = document.querySelector('[data-dep-scan="${which}"]'); return !b || !b.disabled; })()`, Number(process.env.SCAN_WAIT || 90000), 1000);
    await h.sleep(800);
    const ok = await h.eval(`/Rescan/.test(document.querySelector('[data-dep-scan="${which}"]')?.textContent || '')`);
    if (!ok) { scanFailed.push(which); h.log('  scan FAILED for', which, '| toast:', (await h.eval(`[...document.querySelectorAll('.ds-toast')].map(t => t.innerText).join(' || ')`)).slice(0, 400)); }
  }
  h.log('children that could not be scanned:', JSON.stringify(scanFailed));
  h.log('PLAN after child scans:', await dump(h, '.ds-dep-plan', 2000));
  h.log('PARENTS:', await dump(h, '#dsDepOrder', 900));
  h.log('NOTES:', await dump(h, '.ds-dep-notes, .ds-rec-dups', 1200));
  h.log('TREE:', await dump(h, '#dsDepTree', 700));
  await h.shot(SHOTS + 'run1-plan.png');
  // select everything insertable / changed on every object
  const objs = await h.eval(`[...document.querySelectorAll('.ds-dep-objtab, [data-dep-obj]')].map(b => b.dataset.depObj).filter((v, i, a) => v !== undefined && a.indexOf(v) === i)`);
  h.log('objects:', JSON.stringify(objs));
  for (const o of objs) {
    for (const tab of ['ins', 'chg']) {
      await h.eval(`(() => { const b = document.querySelector('[data-dep-obj="${o}"][data-dep-tab="${tab}"]'); if (b) b.click(); })()`);
      await h.sleep(500);
      const clicked = await h.eval(`(() => { const b = document.querySelector('[data-dep-bulk="all"]'); if (b && !b.disabled) { b.click(); return true; } return false; })()`);
      await h.sleep(300);
      const cnt = await h.eval(`document.querySelectorAll('#dsDepList input[type=checkbox]:checked, #dsDepList .ds-dep-row.ds-dep-row-on').length`);
      h.log(`  ${o || 'root'}/${tab}: bulk=${clicked} selected=${cnt} | ${(await dump(h, '#dsDepList', 260))}`);
    }
  }
  h.log('SUMMARY:', await dump(h, '#dsDepSummary', 500));
  await h.shot(SHOTS + 'run1-selected.png');
  const runDisabled = await h.eval(`document.querySelector('#dsRecRunBtn')?.disabled`);
  h.log('run button disabled:', runDisabled);
  if (runDisabled) continue;
  const histBefore = await h.eval('_history.length');
  await h.click('#dsRecRunBtn');
  await h.sleep(2500);
  // confirms: the combined plan modal (Proceed, now sftkConfirmDestructive —
  // campaign 3 phase 2), then possibly typed (dev org → none expected)
  for (let i = 0; i < 4; i++) {
    const m = await h.modalText(900);
    if (!m) break;
    h.log('MODAL:', m);
    if (await h.eval(`!!document.querySelector('#sftkConfirmProd')`)) { h.log('typed gate shown — org is dev, unexpected'); break; }
    const ok = await h.eval(`(() => { const b = document.querySelector('#sftkConfirmGo') || document.querySelector('#dsRecDelOk') || [...document.querySelectorAll('#dsModalBox button')].find(b => /proceed|deploy|confirm|ok/i.test(b.textContent) && !b.disabled); if (b) { b.click(); return b.textContent.trim(); } return null; })()`);
    h.log('clicked:', ok);
    await h.sleep(2000);
  }
  // the run is over when its History entry exists (written before "Reconcile
  // complete"); the post-run refresh then wipes the progress log, so keep the
  // last text seen while waiting
  let lastLog = '';
  for (let i = 0; i < Number(process.env.RUN_WAIT || 300); i++) {
    const t = await h.eval(`document.querySelector('#dsRecProgress')?.innerText || ''`);
    if (t) lastLog = t;
    if (await h.eval(`_history.length > ${histBefore}`)) break;
    await h.sleep(1000);
  }
  await h.sleep(2000);
  h.log('RUN LOG (last seen):', lastLog.split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ').slice(-3500));
  await h.shot(SHOTS + 'run1-done.png');
  // the post-run auto refresh repaints the page; wait until it has landed before leaving
  await h.sleep(4000);
  await h.waitFor("!document.querySelector('#dsDepRefresh')?.disabled && /scanned (just now|\d+ ?s)/.test(document.querySelector('.ds-view-header, .ds-dep-page')?.innerText || 'scanned just now')", 60000, 1000);
  await h.sleep(1500);
  h.log('PLAN after run:', await dump(h, '.ds-dep-plan', 1600));
  await h.eval(`navigateToView('history')`);
  await h.waitFor("!!document.querySelector('.ds-history-card, .ds-history-item')", 20000, 500);
  await h.sleep(1000);
  h.log('HISTORY:', await dump(h, '.ds-history-card, .ds-history-item, #dsMain', 1800));
  await h.eval(`document.querySelectorAll('details').forEach(d => d.open = true)`);
  const raw = (await h.eval(`(document.querySelector('.ds-history-card .ds-err-raw, .ds-history-item .ds-err-raw')?.innerText || '')`)).split(String.fromCharCode(10)).filter(Boolean);
  for (const line of raw) h.log('RAW:', line.slice(0, 700));
  await h.shot(SHOTS + 'run1-history.png');
  }
}
