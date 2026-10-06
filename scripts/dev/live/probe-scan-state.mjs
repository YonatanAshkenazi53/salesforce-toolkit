// Probe: does the Flows tab's dependency scan ever report itself finished?
// (QA 2026-10-06: the progress bar stayed at "Building dependency map… 127 / 127"
// and ⬇ Backup with the tree option said one flow was never read.)
export default async function (h) {
  await h.login(process.env.ORG || 'npc');
  await h.popup('flows');
  await h.watchErrors();
  await h.waitFor("document.querySelectorAll('.flow-group').length > 0", 240000, 1000);
  for (let i = 0; i < 24; i++) {
    const st = await h.eval(`(() => { const s = DependencyMap.getScanStatus(); const p = document.querySelector('#scanProgress'); return JSON.stringify({ state: typeof metadataScanState !== 'undefined' ? metadataScanState : '?', running: s.running, complete: s.complete, done: s.done, total: s.total, progressShown: p && p.style.display !== 'none', progressText: document.querySelector('#scanProgressText')?.innerText || '', fetched: DependencyMap.isMetadataFetched(), orgUrl: typeof orgUrl !== 'undefined' ? orgUrl : '?', pending: DependencyMap.pendingCount(allFlows), offerBar: document.querySelector('#scanSubflowBtnWrap')?.innerText.slice(0, 160) || '' }); })()`);
    h.log(`t+${i * 5}s`, st);
    if (JSON.parse(st).state === 'done' || JSON.parse(st).state === 'partial') break;
    await h.sleep(5000);
  }
  // the tree-backup plan for the fixture Draft flow
  h.log('planTreeBackup for SFTK_AV_Test_C:', await h.eval("(() => { const f = allFlows.filter(x => x.ApiName === 'SFTK_AV_Test_C'); const p = planTreeBackup(f); return JSON.stringify({ blocked: p.blocked, add: (p.add || []).length, excluded: p.excluded }); })()"));
  h.log('depMap has SFTK_AV_Test_C:', await h.eval("JSON.stringify({ inMap: 'SFTK_AV_Test_C' in (DependencyMap.getDependencyMap() || {}), calls: (DependencyMap.getFlowCalls ? DependencyMap.getFlowCalls('SFTK_AV_Test_C') : 'n/a') })"));
}
