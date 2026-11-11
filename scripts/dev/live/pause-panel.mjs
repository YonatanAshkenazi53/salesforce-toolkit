// Live (2026-11-08): the ⏸ pause panel on the Deploy page — what this run
// switches off in the target, per object, with a tick on every item.
// Target npc2 holds the flowswitch fixture (SFTK_FS_Test_Acc1/Acc2 on Account,
// Con1 on Contact), two validation rules (Account, Contact) and the standard
// duplicate rules. The Accounts tree deployment: all three options on, then
// Contact's flow and Contact's duplicate rules UNTICKED, every object's inserts
// ticked, ▶ Deploy. The confirmation must name Account's flows/rules/bypass
// and say Contact's flow and duplicate rule are left as they are; the CLI
// reads Con1 still ON during the run... (the run is short, so the CLI reads
// the END state: every flow and rule back ON); History keeps the run; then
// ↩ Roll back (same session).
//   DARK=1 adds dark screenshots · ROLLBACK=0 keeps the run · SCAN_ONLY=1 stops at the confirmation
import { execSync } from 'node:child_process';
import retryAndRollback from './retry-and-rollback.mjs';

const dump = async (h, sel, n = 1600) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
const cli = (h, label, q, tooling) => {
  try {
    const t = execSync(`sf data query -o npc2 --json ${tooling ? '-t ' : ''}-q "${q}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    h.log(label, JSON.stringify(JSON.parse(t.slice(t.indexOf('{'))).result.records.map(r => Object.values(r).filter(v => typeof v !== 'object').join(':'))));
  } catch (e) { h.log('CLI failed:', e.message.split('\n')[0]); }
};
const cliState = h => {
  cli(h, 'CLI FLOWS:', "SELECT ApiName, IsActive FROM FlowDefinitionView WHERE ApiName LIKE 'SFTK_FS_Test%'");
  cli(h, 'CLI RULES:', "SELECT ValidationName, Active FROM ValidationRule WHERE ValidationName LIKE 'SFTK_CX_%'", true);
};
const setDark = async (h, on) => { await h.eval(`document.documentElement.classList.toggle('ds-dark', ${on ? 'true' : 'false'}); true`); await h.sleep(on ? 900 : 400); };
const shot = async (h, name) => {
  await h.eval(`document.querySelector('#dsDepPausePanel')?.scrollIntoView({ block: 'center' })`); await h.sleep(300);
  await h.shot(h.shots + `/${name}.png`);
  if (process.env.DARK === '1') { await setDark(h, true); await h.shot(h.shots + `/${name}-dark.png`); await setDark(h, false); }
};
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);
const panelSettled = h => h.waitFor("(() => { const t = document.querySelector('#dsDepPausePanel')?.innerText || ''; return t.length > 20 && !/⏳/.test(t); })()", 90000, 500);

export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK CX — Accounts tree';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (!id) throw new Error('fixture profile missing');
  cliState(h);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await waitScanned(h); await h.sleep(2000);

  // nothing on → the panel says so
  h.log('PANEL (nothing on):', await dump(h, '#dsDepPausePanel', 400));
  await shot(h, 'pp-0-none');

  // the three options on
  for (const sel of ['#dsDepFlowPause', '#dsDepRulePause']) await h.eval(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await h.eval(`(() => { const s = document.querySelector('#dsDepDupRules'); s.value = 'bypass'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await h.sleep(1500);
  // the select's change re-renders the page: the boxes must still be ticked
  await h.waitFor("document.querySelector('#dsDepFlowPause')?.checked && document.querySelector('#dsDepRulePause')?.checked && document.querySelector('#dsDepDupRules')?.value === 'bypass'", 30000, 300);
  await panelSettled(h);
  h.log('PANEL (all on):', await dump(h, '#dsDepPausePanel', 1500));
  h.log('items:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.ds-dep-pause-cb')].map(c => c.dataset.key + (c.checked ? '' : ' (off)'))`)));
  await shot(h, 'pp-1-all');

  // every object's inserts, so Contact is written too (its automation is then the user's choice)
  const objs = await h.eval(`[...document.querySelectorAll('[data-dep-obj]')].map(b => b.dataset.depObj).filter((v, i, a) => v !== undefined && a.indexOf(v) === i)`);
  for (const o of objs) {
    await h.eval(`(() => { const b = document.querySelector('[data-dep-obj="${o}"][data-dep-tab="ins"]'); if (b) b.click(); })()`); await h.sleep(500);
    await h.eval(`(() => { const b = document.querySelector('[data-dep-bulk="all"]'); if (b && !b.disabled) b.click(); return true; })()`); await h.sleep(400);
  }
  h.log('SUMMARY:', await dump(h, '#dsDepSummary', 300));

  // Contact: its flow and its duplicate rules stay as they are
  for (const key of ['flow:SFTK_FS_Test_Con1', 'dupe:Contact']) {
    const ok = await h.eval(`(() => { const c = document.querySelector('.ds-dep-pause-cb[data-key=${JSON.stringify(key)}]'); if (!c) return false; c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    h.log('unticked', key, ok ? 'ok' : 'NOT FOUND');
    await h.sleep(300);
  }
  h.log('PANEL (Contact narrowed):', await dump(h, '#dsDepPausePanel', 1500));
  h.log('row states:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.ds-dep-pause-row')].map(r => r.querySelector('.ds-dep-pause-name').innerText + ' → ' + r.querySelector('.ds-dep-pause-state').innerText)`)));
  await shot(h, 'pp-2-narrowed');

  const histBefore = await h.eval('_history.length');
  await h.click('#dsRecRunBtn'); await h.sleep(2500);
  for (let i = 0; i < 4; i++) {
    const m = await h.modalText(1500); if (!m) break;
    h.log('CONFIRM:', m.slice(0, 2500));
    if (i === 0) { await h.shot(h.shots + '/pp-3-confirm.png'); if (process.env.DARK === '1') { await setDark(h, true); await h.shot(h.shots + '/pp-3-confirm-dark.png'); await setDark(h, false); } }
    if (process.env.SCAN_ONLY === '1') { h.log('SCAN_ONLY — cancelling'); await h.eval(`(document.querySelector('#sftkConfirmCancel') || [...document.querySelectorAll('#dsModalBox button')].find(b => /cancel/i.test(b.textContent)))?.click()`); return; }
    await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } const b = document.querySelector('#sftkConfirmGo') || [...document.querySelectorAll('#dsModalBox button')].find(b => /proceed|deploy|confirm|ok/i.test(b.textContent) && !b.disabled); if (b) b.click(); return !!b; })()`);
    await h.sleep(2000);
  }
  let lastLog = '';
  for (let i = 0; i < 300; i++) {
    const t = await h.eval(`document.querySelector('#dsRecProgress')?.innerText || ''`); if (t) lastLog = t;
    if (await h.eval(`_history.slice(${histBefore}).some(x => x.kind !== 'tool')`)) break;   // the pauses write tool entries of their own mid-run — wait for the RUN's entry
    await h.sleep(1000);
  }
  await h.waitFor("/flow\\(s\\) back on|rule\\(s\\) back on|could NOT be switched back/.test([...document.querySelectorAll('.ds-toast')].map(t => t.innerText).join(' ') + (document.querySelector('#dsRecProgress')?.innerText || ''))", 180000, 500);
  await h.sleep(1500);
  h.log('RUN LOG:', lastLog.split(String.fromCharCode(10)).filter(x => /⏸|▶|flow|rule|Insert|✅|❌|🔁|duplicate/i.test(x)).join(' | ').slice(0, 2500));
  h.log('HISTORY (newest):', JSON.stringify(await h.eval(`(() => { const x = _history[_history.length - 1]; return x && { kind: x.kind, name: x.profileName, status: x.status, what: (x.what || []).map(w => w.text).slice(0, 12) }; })()`)));
  cliState(h);
  if (process.env.ROLLBACK === '0') return;
  process.env.SKIP_RUN = '1';
  await retryAndRollback(h);
  h.log('──────── rolled back ────────');
}
