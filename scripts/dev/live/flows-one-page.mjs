// Live, writes to the Field Cleaner fixture on npc (trailheads5) and puts it back: the one Flows page
// (2026-10-17) — the view strip, the interview chips, a WHOLE flow deleted (every version, restore points
// kept), then ↩ Undo from the tool's History bringing the versions back as Drafts, verified with the CLI.
//   SFTK_EXT=dist/store-staging node scripts/dev/headless-studio.mjs scripts/dev/live/flows-one-page.mjs
// Afterwards: node -e "import('./scripts/dev/video/fixture.mjs').then(m => m.rebuildFieldCleanerFixture('npc', console.log))"
import { execFileSync } from 'node:child_process';
const FLOW = process.env.FLOW || 'SFTK_FC_Test_Flow4';
const cli = q => JSON.parse(execFileSync('sf', ['data', 'query', '-o', 'npc', '-t', '-q', `"${q}"`, '--json'], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).result.records || [];
const versions = () => cli(`SELECT Id, VersionNumber, Status FROM Flow WHERE Definition.DeveloperName = '${FLOW}' ORDER BY VersionNumber`);
export default async function (h) {
  await h.login('npc'); await h.popup('flows'); await h.watchErrors();
  await h.waitFor("document.querySelectorAll('.flow-group').length > 0", 120000, 500);
  h.log('1. sidebar has no Dependencies button:', await h.eval(`!document.querySelector('.tab-btn[data-tab="dependencies"]')`), '| view strip:', await h.eval(`[...document.querySelectorAll('#flowViews .flow-view-btn')].map(b => b.dataset.view).join(',')`));
  // the views
  for (const v of ['deps', 'switches', 'apiver', 'versions']) {
    await h.eval(`document.querySelector('#flowViews [data-view="${v}"]').click()`);
    if (v === 'switches' || v === 'apiver') await h.waitFor("(document.getElementById('flowToolHost')?.innerText || '').length > 20", 60000, 500).catch(() => {});
    await h.sleep(v === 'versions' ? 800 : 1500);
    h.log(`2. view ${v}:`, 'versions shown', await h.eval(`document.getElementById('flowViewVersions').style.display !== 'none'`), '| deps shown', await h.eval(`document.getElementById('tab-dependencies').style.display !== 'none'`), '| tool panel:', (await h.eval(`(document.getElementById('depToolPanel')?.innerText || '').slice(0, 60).replace(/\\n/g, ' ')`)));
  }
  h.log('2b. deep link to the old tab:', await h.eval(`(() => { navigateToTab('dependencies'); return _flowView + ' / flows tab shown: ' + (document.getElementById('tab-flows').style.display !== 'none'); })()`));
  await h.eval(`setFlowView('versions')`); await h.sleep(500);
  // interviews and the whole-flow button
  h.log('3. interview chips:', await h.eval(`document.querySelectorAll('.flow-int-chip').length`), '| interviews read:', await h.eval(`JSON.stringify({ versions: Object.keys(_flowInterviews.byVersion).length, error: _flowInterviews.error })`), '| whole-flow buttons:', await h.eval(`document.querySelectorAll('.flow-whole-btn').length`));
  h.log('3b. flows loaded:', await h.eval(`allFlows.length`), '| groups:', await h.eval(`Object.keys(flowGroups).length`), '| SFTK labels:', await h.eval(`JSON.stringify(Object.keys(flowGroups).filter(l => /sftk/i.test(l)).slice(0, 12))`), '| page groups with SFTK:', await h.eval(`[...document.querySelectorAll('.flow-group')].filter(g => /sftk/i.test(g.dataset.label || '')).length`));
  const before = versions();
  h.log('4. CLI before:', JSON.stringify(before.map(v => `v${v.VersionNumber} ${v.Status}`)));
  if (!before.length) throw new Error(`${FLOW} is not in the org — rebuild the Field Cleaner fixture first`);
  // the whole flow goes
  const norm = x => String(x || '').replace(/[ _]/g, '').toLowerCase();
  const clicked = await h.eval(`(() => { const want = ${JSON.stringify(norm(FLOW))}; const g = [...document.querySelectorAll('.flow-group')].find(g => String(g.dataset.label || '').replace(/[ _]/g, '').toLowerCase() === want); if (!g) return 'no group'; g.querySelector('.flow-whole-btn').click(); return g.dataset.label; })()`);
  h.log('5. whole flow clicked on group:', clicked, '| summary:', await h.eval(`document.getElementById('selectionSummary').innerText`));
  const hist0 = await h.eval(`(typeof sftkHistoryAll === 'function' ? (await sftkHistoryAll()).length : -1)`).catch(() => -1);
  await h.eval(`document.getElementById('deleteBtn').click()`); await h.sleep(1500);
  // the popup's dialogs are sftkDialog / sftkConfirmDestructive (.sftk-cf), not Data Studio's #dsModalBox
  const dialogText = () => h.eval(`(() => { const d = document.querySelector('.sftk-cf'); return d && d.offsetParent ? (d.innerText || '').split(String.fromCharCode(10)).join(' ').slice(0, 300) : ''; })()`);
  const answerDialog = async () => {
    if (await h.eval(`!!document.querySelector('#sftkConfirmGo')`)) {
      await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) a.click(); const f = document.querySelector('#fcFlowBackup'); if (f && f.checked) f.click(); return true; })()`);
      await h.sleep(300);
      await h.eval(`document.querySelector('#sftkConfirmGo').click()`);
      return 'confirmed';
    }
    return await h.eval(`(() => { const b = document.querySelector('#modalConfirm') || [...document.querySelectorAll('.sftk-cf button')].find(b => !/cancel|scan|backup/i.test(b.textContent) && /anyway|without|continue|proceed|understand|skip|delete|ok/i.test(b.textContent) && !b.disabled); if (b) { b.click(); return 'clicked ' + b.textContent.trim(); } return 'no button'; })()`);
  };
  for (let i = 0; i < 8; i++) {
    const t = await dialogText();
    if (!t) break;
    h.log(`6. dialog ${i}:`, t);
    h.log(`6. →`, await answerDialog());
    await h.sleep(2500);
  }
  await h.waitFor("document.getElementById('progressPanel').style.display === 'none'", 300000, 1000).catch(() => {});
  await h.sleep(2000);
  h.log('7. result dialog:', await dialogText());
  await h.eval(`(() => { if (typeof closeModal === 'function') closeModal(); return true; })()`);
  const after = versions();
  h.log('8. CLI after delete:', JSON.stringify(after.map(v => `v${v.VersionNumber} ${v.Status}`)), after.length === 0 ? '— the flow is gone' : '— STILL THERE');
  // the tool's history: the entry and its undo
  const entry = await h.eval(`(async () => { const all = await sftkHistoryAll(); const e = all.find(x => x.tool === 'Flow delete'); return e ? JSON.stringify({ id: e.id, status: e.status, undo: e.toolUndo && (e.toolUndo.none || (e.toolUndo.steps || []).map(s => s.describe)), note: e.toolUndo && e.toolUndo.note, kb: Math.round(JSON.stringify(e).length / 1024) }) : 'no entry'; })()`);
  h.log('9. history entry:', String(entry).slice(0, 600));
  const id = String(entry).startsWith('{') ? JSON.parse(entry).id : null;
  if (id) {
    // the undo asks its own confirmation: start it, answer the dialog, then read its result
    await h.eval(`(() => { window.__undoResult = null; sftkHistoryUndo(${JSON.stringify(id)}, { onLog: () => {} }).then(r => { window.__undoResult = r || { done: true }; }, e => { window.__undoResult = { error: String(e && e.message || e) }; }); return true; })()`);
    for (let i = 0; i < 6; i++) {
      await h.sleep(1500);
      const t = await dialogText();
      if (t) { h.log(`10. undo dialog ${i}:`, t.slice(0, 200)); h.log('10. →', await answerDialog()); }
      if (await h.eval(`!!window.__undoResult`)) break;
    }
    await h.waitFor('!!window.__undoResult', 600000, 1000).catch(() => {});
    h.log('10. undo result:', JSON.stringify(await h.eval('window.__undoResult')).slice(0, 500));
    await h.sleep(3000);
    const restored = versions();
    h.log('11. CLI after undo:', JSON.stringify(restored.map(v => `v${v.VersionNumber} ${v.Status}`)));
  }
  h.log('page errors:', JSON.stringify(await h.eval(`(window.__sftkErrors || []).slice(0, 5)`)).slice(0, 600));
}
