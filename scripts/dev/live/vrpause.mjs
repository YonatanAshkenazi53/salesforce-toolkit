// Live (2026-10-03, campaign 4 phase 4): ⏸ pause validation rules during a deployment.
// Target trailheads4 holds the two fixture rules (SFTK_CX_Retail_Needs_Website on
// Account, SFTK_CX_Lab_Lead_Needs_Phone on Contact) that normally REFUSE one Account
// and one Contact of the CX tree. The Accounts tree deployment ticks ⏸ validation
// rules, shows the list, deploys the root Inserts, and the run must: list the pause in
// its ONE confirmation, switch the rules OFF (verified) before writing, insert ALL 7
// Accounts (the Retail one too), and switch the rules back ON when it ends. The CLI
// reads the rules before and after; then ↩ Roll back (same session) restores the target.
//   PROFILE (default the Accounts tree) · ROLLBACK=0 keeps the run
import { execSync } from 'node:child_process';
import retryAndRollback from './retry-and-rollback.mjs';

const dump = async (h, sel, n = 1600) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
const cli = (soql, tooling) => {
  const t = execSync(`sf data query -o npc2 ${tooling ? '-t ' : ''}--json -q "${soql}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(t.slice(t.indexOf('{'))).result;
};
const cliRules = h => {
  try {
    h.log('CLI TARGET RULES:', JSON.stringify(cli("SELECT ValidationName, Active FROM ValidationRule WHERE ValidationName LIKE 'SFTK_CX%'", true).records.map(r => `${r.ValidationName}:${r.Active ? 'ON' : 'OFF'}`)));
  } catch (e) { h.log('CLI failed:', e.message.split('\n')[0]); }
};
const cliAccounts = h => {
  try { h.log('CLI TARGET CX ACCOUNTS:', cli("SELECT COUNT() FROM Account WHERE Name LIKE 'SFTK CX%'").totalSize, '· retail (no website):', cli("SELECT COUNT() FROM Account WHERE Name LIKE 'SFTK CX%Retail%'").totalSize); }
  catch (e) { h.log('CLI failed:', e.message.split('\n')[0]); }
};
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);

export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK CX — Accounts tree';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (!id) throw new Error('fixture profile missing');
  cliRules(h); cliAccounts(h);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await waitScanned(h); await h.sleep(2000);
  // ⏸ tick the option and wait for the list
  await h.eval(`(() => { const b = document.querySelector('#dsDepRulePause'); b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await h.waitFor("/will be switched off|switches off ONLY|nothing to pause|could not be listed/.test(document.querySelector('#dsDepRulePauseList')?.innerText || '')", 60000, 500);
  h.log('PAUSE LIST:', await dump(h, '#dsDepRulePauseList', 700));
  // the root Inserts — all of them, the Retail account the rule normally refuses included
  await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="ins"]')?.click()`); await h.sleep(800);
  await h.eval(`document.querySelector('[data-dep-bulk="all"]')?.click()`); await h.sleep(600);
  h.log('SUMMARY:', await dump(h, '#dsDepSummary', 300));
  const histBefore = await h.eval('_history.length');
  await h.click('#dsRecRunBtn'); await h.sleep(2500);
  for (let i = 0; i < 4; i++) {
    const m = await h.modalText(1800); if (!m) break;
    h.log('CONFIRM:', m);
    await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } const b = document.querySelector('#sftkConfirmGo') || [...document.querySelectorAll('#dsModalBox button')].find(x => /confirm|continue|proceed|run|deploy/i.test(x.textContent) && !x.disabled); if (b) b.click(); return !!b; })()`);
    await h.sleep(2000);
  }
  let lastLog = '';
  for (let i = 0; i < 300; i++) {
    const t = await h.eval(`document.querySelector('#dsRecProgress')?.innerText || ''`); if (t) lastLog = t;
    if (await h.eval(`_history.length > ${histBefore}`)) break;
    await h.sleep(1000);
  }
  // the switch-back runs right after the last write; its toast is the end marker
  await h.waitFor("/validation rule\\(s\\) back on in|could NOT be switched back/.test([...document.querySelectorAll('.ds-toast')].map(t => t.innerText).join(' '))", 120000, 500);
  await h.sleep(1000);
  h.log('RUN LOG:', lastLog.split(String.fromCharCode(10)).filter(x => /⏸|▶|rule|Insert|✅|❌|written/.test(x)).join(' | ').slice(0, 1800));
  h.log('TOASTS:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.ds-toast')].map(t => t.innerText.replace(/\\s+/g, ' ').slice(0, 300))`)));
  h.log('RUN SUMMARY:', JSON.stringify(await h.eval(`(() => { const r = _history.filter(x => x.kind !== 'tool' && x.kind !== 'rollback').slice(-1)[0] || {}; return { status: r.status, account: r.summary && r.summary.Account, errors: (r.errors || []).filter(e => !/ℹ|🔗/.test(e)).slice(0, 4) }; })()`)));
  h.log('HISTORY (tool entries):', JSON.stringify(await h.eval(`_history.filter(x => x.kind === 'tool').map(x => (x.title || x.profileName) + ' → ' + x.status)`)));
  h.log('LEFTOVERS IN MEMORY:', JSON.stringify(await h.eval(`(async () => (await chrome.storage.local.get('sftk_vr_run_paused')).sftk_vr_run_paused || {})()`)));
  cliRules(h); cliAccounts(h);
  if (process.env.ROLLBACK === '0') return;
  process.env.SKIP_RUN = '1';
  await retryAndRollback(h);
  h.log('──────── rolled back ────────');
  cliRules(h); cliAccounts(h);
}
