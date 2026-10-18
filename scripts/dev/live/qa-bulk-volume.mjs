// Live QA (2026-10-18): the engine with a real Bulk API 2.0 job, trailheads5 → the Developer Edition org.
// 100 SFTK VOL accounts (block 007), accounts only. The target's STANDARD Account duplicate rule blocks
// most of these names (their names fuzzy-match each other) — no rule is touched (law 2026-10-08).
//   A. Engine = Bulk, Duplicate rules = Respect: the page's note says Bulk cannot bypass; the run goes as
//      ONE Bulk job ("via Bulk" in History); every refused record is named with DUPLICATES_DETECTED; the
//      counts of the run equal the CLI's. Rolled back.
//   B. Engine = Bulk, Duplicate rules = Bypass: the page warns the run goes through Collections; the run
//      says so in its notes; every record lands (CLI). Rolled back.
// WRITES to the DE org, then removes what it wrote (rollback, then removeVolume as a net).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { removeVolume } from '../video/fixture.mjs';
const NAME = 'QA bulk volume';
const WHERE = "Name LIKE 'SFTK VOL Account 007%'";
const SRC = 'https://trailheads5.my.salesforce.com', TGT = 'https://orgfarm-e2c4511b2b-dev-ed.develop.my.salesforce.com';
const count = () => JSON.parse(execFileSync('sf', ['data', 'query', '-o', 'npc2', '--json', '-q', `"SELECT COUNT() FROM Account WHERE ${WHERE}"`], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).result.totalSize;
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);

async function importProfile(h, mode, dup) {
  const all = JSON.parse(readFileSync('docs/fixtures/complex-deployment/profiles.json', 'utf8'));
  const base = JSON.parse(JSON.stringify(all.find(p => (p.profile || p).name === 'SFTK VOL — Accounts')));
  const prof = base.profile || base;
  Object.assign(prof, { name: NAME, sourceOrg: SRC, targetOrg: TGT, apiMode: mode, duplicateRules: dup });
  if (dup !== 'bypass') delete prof.duplicateRules;
  prof.tree.where = WHERE; prof.tree.children = [];
  mkdirSync('dist/tmp', { recursive: true });
  writeFileSync('dist/tmp/qa-bulk.json', JSON.stringify([base]));
  await h.eval(`(async () => { _profiles = _profiles.filter(p => p.name !== ${JSON.stringify(NAME)}); await storageSaveProfiles(); return true; })()`);
  await h.importProfiles('dist/tmp/qa-bulk.json');
  return h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
}
async function runOnce(h, label, mode, dup) {
  if (count()) { removeVolume('npc2', (...a) => h.log(...a)); }
  const id = await importProfile(h, mode, dup);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await waitScanned(h); await h.sleep(1500);
  h.log(`${label} note on the page:`, await h.eval(`(document.querySelector('#dsDepEngineNote')?.innerText || 'none') + ' | batch input shown: ' + !!document.querySelector('#dsDepBatch')`));
  await h.eval(`document.querySelector('#dsDepTickAll')?.click()`); await h.sleep(1200);
  const ticked = await h.eval('_recSel.push.size');
  const before = await h.eval('_history.length');
  await h.eval(`document.querySelector('#dsRecRunBtn').click()`); await h.sleep(2000);
  for (let i = 0; i < 4; i++) {
    if (await h.eval(`!!document.querySelector('#sftkConfirmGo')`)) {
      await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) a.click(); return true; })()`); await h.sleep(300);
      await h.eval(`document.querySelector('#sftkConfirmGo').click()`); await h.sleep(2000);
    } else if (await h.modalText()) {
      await h.eval(`(() => { const b = [...document.querySelectorAll('#dsModalBox button')].find(b => /proceed|deploy|confirm|ok|continue/i.test(b.textContent)); if (b) b.click(); return !!b; })()`); await h.sleep(1500);
    } else break;
  }
  const t0 = Date.now();
  while ((await h.eval('_history.length')) <= before && Date.now() - t0 < 900000) await h.sleep(2000);
  await h.sleep(3000);
  const e = JSON.parse(await h.eval(`JSON.stringify((() => { const e = _history[_history.length - 1] || {}; return { status: e.status, summary: e.summary, errors: (e.errors || []).slice(0, 12) }; })())`));
  const acc = (e.summary || {}).Account || {};
  const inCli = count();
  h.log(`${label} ticked ${ticked} · status ${e.status} · written ${acc.inserted ?? acc.created} · refused ${acc.insertedFailed ?? acc.failed} · via Bulk ${!!acc.viaBulk} · CLI ${inCli}`);
  for (const x of e.errors) h.log(`${label}   ·`, String(x).slice(0, 220));
  // roll back from History
  await h.eval(`document.querySelector('.ds-nav-btn[data-view="history"]').click()`); await h.sleep(2500);
  const rb0 = await h.eval(`_history.filter(x => x.kind === 'rollback').length`);
  if (await h.eval(`!!document.querySelector('[data-dsaction="rollbackRun"]:not([disabled])')`)) {
    await h.eval(`document.querySelector('[data-dsaction="rollbackRun"]:not([disabled])').click()`);
    await h.waitFor("!!document.querySelector('#dsRbGo')", 300000, 1000).catch(() => {});
    if (await h.eval(`!!document.querySelector('#dsRbGo')`)) {
      await h.eval(`document.querySelector('#dsRbGo').click()`); await h.sleep(1500);
      if (await h.eval(`!!document.querySelector('#sftkConfirmGo')`)) { await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) a.click(); return true; })()`); await h.sleep(300); await h.eval(`document.querySelector('#sftkConfirmGo').click()`); }
      const t1 = Date.now();
      while ((await h.eval(`_history.filter(x => x.kind === 'rollback').length`)) <= rb0 && Date.now() - t1 < 900000) await h.sleep(2000);
    }
  }
  await h.sleep(3000);
  h.log(`${label} after rollback, CLI: ${count()}`);
  return { e, acc, inCli, ticked };
}

export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  const A = await runOnce(h, 'A (Bulk, respect)', 'bulk', 'respect');
  const B = await runOnce(h, 'B (Bulk, bypass)', 'bulk', 'bypass');
  if (count()) removeVolume('npc2', (...a) => h.log(...a));
  const checks = [
    ['A ran as a Bulk job', !!A.acc.viaBulk],
    ['A: written equals the CLI count', Number(A.acc.inserted ?? A.acc.created) === A.inCli],
    ['A: refusals are named DUPLICATES_DETECTED', !(A.acc.insertedFailed || A.acc.failed) || A.e.errors.some(x => /DUPLICATES_DETECTED/.test(x))],
    ['B did NOT run as Bulk', !B.acc.viaBulk],
    ['B says why (Collections)', B.e.errors.some(x => /Bulk API 2\.0 cannot bypass/.test(x))],
    ['B: every record landed', B.inCli === B.ticked],
  ];
  for (const [what, ok] of checks) h.log(ok ? '✓' : '❌', what);
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 5)')).slice(0, 500));
  if (checks.some(c => !c[1])) throw new Error('a Bulk check failed');
}
