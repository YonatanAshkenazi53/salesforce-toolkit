// Live (2026-09-29): ⏸ pause record-triggered flows during a deployment.
// Target trailheads4 holds three no-op record-triggered flows (flowswitch
// fixture: SFTK_FS_Test_Acc1/Acc2 on Account, Con1 on Contact). The Accounts
// tree deployment ticks ⏸, shows the list, deploys the root Inserts, and the
// run must: list the pause in its confirmation, switch the flows OFF (verified)
// before writing, and switch them back ON at their versions when it ends. The
// CLI reads the flows after the run; then ↩ Roll back (same session).
//   PROFILE (default the Accounts tree) · ROLLBACK=0 keeps the run
import { execSync } from 'node:child_process';
import retryAndRollback from './retry-and-rollback.mjs';

const dump = async (h, sel, n = 1600) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
const cliFlows = h => {
  try {
    const t = execSync(`sf data query -o npc2 --json -q "SELECT ApiName, IsActive FROM FlowDefinitionView WHERE ApiName LIKE 'SFTK_FS_Test%'"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    h.log('CLI TARGET FLOWS:', JSON.stringify(JSON.parse(t.slice(t.indexOf('{'))).result.records.map(r => `${r.ApiName}:${r.IsActive ? 'ON' : 'OFF'}`)));
  } catch (e) { h.log('CLI failed:', e.message.split('\n')[0]); }
};
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);

export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK CX — Accounts tree';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (!id) throw new Error('fixture profile missing');
  cliFlows(h);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await waitScanned(h); await h.sleep(2000);
  // ⏸ tick the option and wait for the list
  await h.eval(`(() => { const b = document.querySelector('#dsDepFlowPause'); b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await h.waitFor("/will be switched off|switches off ONLY|nothing to pause|could not be listed/.test(document.querySelector('#dsDepFlowPauseList')?.innerText || '')", 60000, 500);
  h.log('PAUSE LIST:', await dump(h, '#dsDepFlowPauseList', 700));
  // the root Inserts
  await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="ins"]')?.click()`); await h.sleep(800);
  await h.eval(`document.querySelector('[data-dep-bulk="all"]')?.click()`); await h.sleep(600);
  h.log('SUMMARY:', await dump(h, '#dsDepSummary', 300));
  const histBefore = await h.eval('_history.length');
  await h.click('#dsRecRunBtn'); await h.sleep(2500);
  for (let i = 0; i < 4; i++) {
    const m = await h.modalText(1500); if (!m) break;
    h.log('CONFIRM:', m);
    await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } const b = document.querySelector('#sftkConfirmGo') || [...document.querySelectorAll('#dsModalBox button')].find(b => /proceed|deploy|confirm|ok/i.test(b.textContent) && !b.disabled); if (b) b.click(); return !!b; })()`);
    await h.sleep(2000);
  }
  let lastLog = '';
  for (let i = 0; i < 300; i++) {
    const t = await h.eval(`document.querySelector('#dsRecProgress')?.innerText || ''`); if (t) lastLog = t;
    if (await h.eval(`_history.length > ${histBefore}`)) break;
    await h.sleep(1000);
  }
  // the switch-back runs right after the last write; its toast is the end marker
  await h.waitFor("/back on in|could NOT be switched back/.test([...document.querySelectorAll('.ds-toast')].map(t => t.innerText).join(' '))", 120000, 500);
  await h.sleep(1000);
  h.log('RUN LOG:', lastLog.split(String.fromCharCode(10)).filter(x => /⏸|flow|Insert|✅|❌/.test(x)).join(' | ').slice(0, 1500));
  h.log('TOASTS:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.ds-toast')].map(t => t.innerText.replace(/\\s+/g, ' ').slice(0, 300))`)));
  h.log('HISTORY (tool entries):', JSON.stringify(await h.eval(`_history.filter(x => x.kind === 'tool').map(x => x.profileName + ' → ' + x.status + ' · ' + (x.what || []).map(w => w.text).join(' / ')).slice(-2)`)));
  cliFlows(h);
  if (process.env.ROLLBACK === '0') return;
  process.env.SKIP_RUN = '1';
  await retryAndRollback(h);
  h.log('──────── rolled back ────────');
}
