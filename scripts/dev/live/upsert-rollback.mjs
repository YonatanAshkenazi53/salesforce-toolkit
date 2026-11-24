// Live: ONE real run that both inserts and updates, then ↩ Roll back of that run — both halves must come back.
// (owner 2026-11-25: "if you do an upsert and I want to undo both inserted records and updated" / "Do it")
// Fixture (made with the sf CLI, Name LIKE 'SFTK UR %'): 6 Accounts in npc with Phone 111-000; 3 of them also in
// npc2 with Phone 999-000 and Description "target value before the run". The run inserts 3 and overwrites 3.
// The caller reads npc2 with the CLI before, between (ROLLBACK=0) and after.
//   ROLLBACK=0   stop after the run (History lives in the headless profile, so the roll back needs the same session)
import { execFileSync } from 'node:child_process';
// the target as the CLI sees it — the proof does not rest on the extension's own read
const target = () => { const out = execFileSync('sf', ['data', 'query', '-o', 'npc2', '-q', `"SELECT Name, Phone, Description FROM Account WHERE Name LIKE 'SFTK UR %' ORDER BY Name"`, '--json'], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] }); return JSON.parse(out.slice(out.indexOf('{'))).result.records.map(r => `${r.Name.replace('SFTK UR ', '')}: ${r.Phone} / ${r.Description}`).join(' · '); };
const dump = async (h, sel, n = 1500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).join(' | ');
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/upsert-rollback/profile.json');
  h.log('TARGET before the run:', target());
  const NAME = 'SFTK UR — upsert and roll back';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (process.env.SKIP_RUN !== '1') {
    await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
    const dir = await h.eval(`(() => { const p = (typeof _reconcileProfile !== 'undefined' && _reconcileProfile) || null; return p ? { src: p.sourceOrg || '', tgt: p.targetOrg || '' } : null; })()`);
    if (!dir || !dir.src.includes('orgfarm-c449e108c2') || !dir.tgt.includes('orgfarm-e2c4511b2b')) throw new Error('the Deploy page is not open npc → npc2');
    await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
    await h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);
    await h.sleep(1500);
    h.log('PLAN:', await dump(h, '.ds-dep-plan', 600));
    for (const tab of ['ins', 'chg']) {
      await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="${tab}"]')?.click()`); await h.sleep(600);
      h.log(`tab ${tab}: all ticked →`, await h.eval(`(() => { const b = document.querySelector('[data-dep-bulk="all"]'); if (!b) return 'no bulk button'; b.click(); return b.textContent; })()`));
      await h.sleep(600);
    }
    h.log('SUMMARY:', await dump(h, '#dsDepSummary', 300));
    await h.shot(h.shots + '/ur-before-run.png');
    const histBefore = await h.eval('_history.length');
    if (await h.eval(`document.querySelector('#dsRecRunBtn')?.disabled`)) { h.log('nothing to run'); process.exitCode = 1; return; }
    await h.click('#dsRecRunBtn'); await h.sleep(2500);
    for (let i = 0; i < 3; i++) { const m = await h.modalText(400); if (!m) break; h.log('DIALOG:', m.split(String.fromCharCode(10)).join(' | ')); await h.eval(`(() => { const b = document.querySelector('#dsRecDelOk') || [...document.querySelectorAll('#dsModalBox button')].find(b => /proceed/i.test(b.textContent)); if (b) b.click(); })()`); await h.sleep(2000); }
    for (let i = 0; i < 600; i++) { if (await h.eval(`_history.length > ${histBefore}`)) break; await h.sleep(1000); }
    await h.sleep(5000);
    h.log('RUN VERDICT:', await dump(h, '.ds-prog-verdict', 700));
    h.log('RUN ENTRY:', await h.eval(`JSON.stringify((e => ({ status: e.status, summary: e.summary, undo: e.undo && { objects: e.undo.objects, skipped: e.undo.skipped } }))(_history[_history.length - 1] || {}))`));
    await h.shot(h.shots + '/ur-run.png');
  }
  h.log('TARGET after the run:', target());
  if (process.env.ROLLBACK === '0') return;

  await h.eval(`navigateToView('history')`);
  await h.waitFor("!!document.querySelector('[data-dsaction=\"rollbackRun\"]')", 20000, 500); await h.sleep(500);
  h.log('HISTORY newest:', await dump(h, '.ds-history-card, .ds-history-item', 600));
  if (!(await h.eval(`!!document.querySelector('[data-dsaction="rollbackRun"]:not([disabled])')`))) { h.log('❌ Roll back is not offered'); process.exitCode = 1; return; }
  await h.eval(`document.querySelector('[data-dsaction="rollbackRun"]:not([disabled])').click()`);
  await h.waitFor("!!document.querySelector('#dsRbGo') || !!document.querySelector('.ds-rec-card-bad')", 300000, 1000);
  await h.sleep(1000);
  h.log('ROLLBACK PAGE:', await dump(h, '.ds-dep-plan', 2500));
  h.log('ROLLBACK RECORDS (current tab):', await dump(h, '#dsRbList', 1500));
  h.log('picks:', await h.eval(`JSON.stringify([...document.querySelectorAll('[data-rb-pick]')].reduce((m, c) => { const k = c.dataset.rbPick.split('|')[0] + (c.checked ? ':on' : ':off'); m[k] = (m[k] || 0) + 1; return m; }, {}))`));
  h.log('summary:', await dump(h, '#dsRbSummary', 300));
  await h.shot(h.shots + '/ur-rollback-plan.png');
  await h.applyDark?.();
  if (!(await h.eval(`!!document.querySelector('#dsRbGo') && !document.querySelector('#dsRbGo').disabled`))) { h.log('❌ Go is not enabled'); process.exitCode = 1; return; }
  await h.eval(`document.querySelector('#dsRbGo').click()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo') || !!document.querySelector('#sftkConfirmProdGo')", 20000, 300); await h.sleep(300);
  h.log('CONFIRM:', await dump(h, '#dsModalBox, .sftk-confirm', 900));
  await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
  await h.sleep(300);
  const rbBefore = await h.eval(`_history.filter(x => x.kind === 'rollback').length`);
  await h.eval(`document.querySelector('#sftkConfirmGo')?.click()`);
  for (let i = 0; i < 600; i++) { if (await h.eval(`_history.filter(x => x.kind === 'rollback').length > ${rbBefore}`)) break; await h.sleep(1000); }
  await h.sleep(2000);
  h.log('ROLLBACK LOG:', await dump(h, '#dsRbLog', 2500));
  h.log('ROLLBACK RESULT:', await dump(h, '#dsRbResult', 800));
  h.log('ROLLBACK ENTRY:', await h.eval(`JSON.stringify((e => ({ status: e.status, summary: e.summary, errors: (e.errors || []).slice(0, 6) }))(_history.filter(x => x.kind === 'rollback').slice(-1)[0] || {}))`));
  await h.shot(h.shots + '/ur-rollback-done.png');
  h.log('TARGET after the roll back:', target());
}
