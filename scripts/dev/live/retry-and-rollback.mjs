// Live: History → ↻ Retry failed on the newest run of a deployment (the Deploy
// page must open with the failed records ticked), then ↩ Roll back that run
// (typed word, plan, execution), reporting what each said.
//   PROFILE = deployment name (default: the Accounts tree)
//   ROLLBACK=0 to skip the rollback
const dump = async (h, sel, n = 1500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).join(' | ');
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK CX — Accounts tree';
  // a fresh profile has no History: run the deployment once (root inserts only) — SKIP_RUN=1 skips it
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (process.env.SKIP_RUN === '1') { h.log('SKIP_RUN: no deployment run'); }
  else {
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);
  await h.sleep(1500);
  await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="ins"]')?.click()`); await h.sleep(500);
  await h.eval(`(() => { const b = document.querySelector('[data-dep-bulk="all"]'); if (b) b.click(); })()`); await h.sleep(500);
  h.log('SUMMARY:', await dump(h, '#dsDepSummary', 300));
  const histBefore = await h.eval('_history.length');
  if (await h.eval(`document.querySelector('#dsRecRunBtn')?.disabled`)) { h.log('nothing to run'); return; }
  await h.click('#dsRecRunBtn'); await h.sleep(2500);
  for (let i = 0; i < 3; i++) { const m = await h.modalText(300); if (!m) break; await h.eval(`(() => { const b = document.querySelector('#dsRecDelOk') || [...document.querySelectorAll('#dsModalBox button')].find(b => /proceed/i.test(b.textContent)); if (b) b.click(); })()`); await h.sleep(2000); }
  for (let i = 0; i < 600; i++) { if (await h.eval(`_history.length > ${histBefore}`)) break; await h.sleep(1000); }
  await h.sleep(6000);
  await h.waitFor("!document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);
  }

  // ── ↻ Retry failed ──
  await h.eval(`document.querySelector('[data-view="history"]')?.click()`);
  await h.waitFor("!!document.querySelector('.ds-history-card, .ds-history-item')", 20000, 500); await h.sleep(800);
  h.log('HISTORY newest:', (await dump(h, '.ds-history-card, .ds-history-item', 700)));
  const retryBtn = await h.eval(`!!document.querySelector('[data-dsaction="retryFailed"]')`);
  h.log('Retry failed offered:', retryBtn);
  if (retryBtn) {
    await h.eval(`document.querySelector('[data-dsaction="retryFailed"]').click()`);
    await h.waitFor("_currentView === 'deploy' && !!document.querySelector('.ds-dep-plan')", 300000, 1000); await h.sleep(2500);
    h.log('RETRY LINE:', (await h.eval(`[...document.querySelectorAll('.ds-rec-card-line')].map(e => e.innerText).find(t => /Retry/.test(t)) || '(no retry line)'`)).slice(0, 400));
    h.log('SUMMARY after retry:', await dump(h, '#dsDepSummary', 300));
    await h.shot(h.shots + '/retry.png');
  }

  // ── ↩ Roll back ──
  if (process.env.ROLLBACK === '0') return;
  await h.eval(`document.querySelector('[data-view="history"]')?.click()`);
  await h.waitFor("!!document.querySelector('[data-dsaction=\"rollbackRun\"]')", 20000, 500); await h.sleep(500);
  // the newest run that CAN be rolled back (a run that wrote nothing offers a disabled button)
  const rbDisabled = !(await h.eval(`!!document.querySelector('[data-dsaction="rollbackRun"]:not([disabled])')`));
  h.log('Roll back available:', !rbDisabled);
  if (rbDisabled) return;
  await h.eval(`document.querySelector('[data-dsaction="rollbackRun"]:not([disabled])').click()`);
  // the plan is complete when the typed input exists, or when the Go button was removed (nothing to do)
  await h.waitFor("!!document.querySelector('#dsUndoTyped') || (!!document.querySelector('#dsUndoPlan')?.innerText && !document.querySelector('#dsUndoGo'))", 300000, 1000);
  await h.sleep(1000);
  h.log('ROLLBACK PLAN:', await dump(h, '#dsUndoPlan', 6000));
  h.log('ROLLBACK LOG (pre):', await dump(h, '#dsUndoLog', 800));
  const forced = await h.eval(`(() => { let n = 0; document.querySelectorAll('[data-undo-force]').forEach(c => { c.checked = true; n++; }); return n; })()`);
  h.log('force boxes ticked:', forced);
  const word = await h.eval(`(document.querySelector('#dsUndoTyped')?.placeholder || '')`);
  h.log('typed word asked:', JSON.stringify(word));
  if (!word) return;
  await h.eval(`(() => { const i = document.querySelector('#dsUndoTyped'); i.value = ${JSON.stringify(word)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.sleep(300);
  h.log('Go enabled:', await h.eval(`!document.querySelector('#dsUndoGo')?.disabled`));
  await h.eval(`document.querySelector('#dsUndoGo')?.click()`);
  for (let i = 0; i < 900; i++) { const t = await h.eval(`document.querySelector('#dsUndoLog')?.innerText || ''`); if (/rolled back|Rollback (complete|finished|done)|✅.*verified|❌/i.test(t) && !/⏳/.test(t.slice(-200))) break; await h.sleep(1000); }
  await h.sleep(2000);
  h.log('ROLLBACK LOG:', await dump(h, '#dsUndoLog', 2500));
  await h.shot(h.shots + '/rollback.png');
  await h.eval(`(() => { if (typeof closeModal === 'function') closeModal(); return true; })()`); await h.sleep(500);
  await h.eval(`document.querySelector('[data-view="history"]')?.click()`); await h.sleep(1500);
  h.log('HISTORY after rollback:', await dump(h, '.ds-history-card, .ds-history-item', 900));
}
