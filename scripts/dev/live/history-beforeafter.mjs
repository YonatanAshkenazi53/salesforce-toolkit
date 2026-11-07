// LIVE, WRITES to npc2 (the deploy target), then rolls the run back: the per-field before/after in the History JSON
// export (user 2026-11-07: "ומה עם מה שהבחור מרדיט אמר? משהו עם לפני ואחרי" — promised on r/salesforce 2026-11-03).
// The Accounts tree's Changed Account row is overwritten (source wins); the run's export must list every field the
// update changed with the target's value before and the value written; the CLI reads the record before and after;
// the run is rolled back (retry-and-rollback.mjs, SKIP_RUN=1) and the CLI reads the original again.
import { execSync } from 'node:child_process';
import retryAndRollback from './retry-and-rollback.mjs';
const NL = String.fromCharCode(10);
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 400000, 1000);
const cli = (h, id, fields) => {
  try {
    const t = execSync(`sf data query -o npc2 --json -q "SELECT Id, ${fields.join(', ')} FROM Account WHERE Id = '${id}'"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const r = JSON.parse(t.slice(t.indexOf('{'))).result.records[0] || {};
    delete r.attributes;
    return r;
  } catch (e) { return { cliFailed: e.message.split(NL)[0] }; }
};
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK CX — Accounts tree';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(2500);
  const dir = await h.eval(`JSON.stringify({ src: _reconcileProfile.sourceOrg, tgt: _reconcileProfile.targetOrg })`);
  h.log('direction:', dir);
  if (!/c449e108c2/.test(dir.split('"tgt"')[0]) || !/e2c4511b2b/.test(dir.split('"tgt"')[1])) throw new Error('not npc → npc2 — nothing is written');
  // opening reads every object by itself (2026-11-08): wait for that read to finish
  await h.waitFor(`(() => { const n = [...document.querySelectorAll('.ds-dtree-node')]; return n.length > 1 && !n.some(x => /not counted yet/.test(x.innerText)) && !document.querySelector('#dsDepRefresh')?.disabled; })()`, 600000, 1500);
  await h.sleep(2000);
  h.log('drift rows in the scan:', await h.eval(`((_reconcileProfile.lastScan || {}).drift || []).length`));
  await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="chg"]')?.click()`);
  await h.waitFor("!!document.querySelector('#dsDepList [data-dep-dir=\"overwrite\"]')", 30000, 500).catch(() => {});
  const chg = await h.eval(`(() => { const b = document.querySelector('#dsDepList [data-dep-dir="overwrite"]'); if (!b) return null; const sid = b.dataset.depId; let tgt = null; for (const v of Object.values(_reconcileProfile.lastScan || {})) if (Array.isArray(v)) { const r = v.find(x => x && x.sourceId === sid && x.targetId); if (r) { tgt = r.targetId; break; } } return { id: sid, tgt, name: (b.closest('.ds-dep-row')?.innerText || '').split(String.fromCharCode(10))[0].slice(0, 80) }; })()`);
  h.log('CHANGED row:', JSON.stringify(chg));
  if (!chg) throw new Error('no Changed Account row in the fixture');
  const tgtId = chg.tgt || await h.eval(`(_reconcileProfile.lastScan.drift || []).find(r => r.sourceId === ${JSON.stringify(chg.id)})?.targetId || null`);
  const fields = ['Name', 'Phone', 'Website', 'Description', 'Industry', 'Type', 'BillingCity'];
  const before = cli(h, tgtId, fields);
  h.log('CLI BEFORE', tgtId, JSON.stringify(before));
  await h.eval(`(() => { const b = document.querySelector('[data-dep-dir="overwrite"][data-dep-id="${chg.id}"]'); b.click(); return true; })()`); await h.sleep(500);
  const hist = await h.eval('_history.length');
  await h.click('#dsRecRunBtn'); await h.sleep(2500);
  for (let i = 0; i < 4; i++) {
    const m = await h.modalText(500); if (!m) break;
    await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } const b = document.querySelector('#sftkConfirmGo') || [...document.querySelectorAll('#dsModalBox button')].find(b => /proceed|deploy|confirm|ok/i.test(b.textContent) && !b.disabled); if (b) b.click(); return !!b; })()`);
    await h.sleep(2000);
  }
  for (let i = 0; i < 300; i++) { if (await h.eval(`_history.length > ${hist}`)) break; await h.sleep(1000); }
  await h.sleep(4000);
  const exp = JSON.parse(await h.eval(`JSON.stringify(histExportPayload([_history[0]], _settings, { labels: {} }))`));
  const run = exp.runs[0];
  h.log('RUN:', run.id, run.status, 'updated:', run.totals.updated);
  h.log('EXPORT fieldChanges:', JSON.stringify(run.fieldChanges));
  h.log('EXPORT note:', exp.note.slice(exp.note.indexOf('fieldChanges')));
  const after = cli(h, tgtId, fields);
  h.log('CLI AFTER ', tgtId, JSON.stringify(after));
  // every line agrees with the CLI: before = the record before the run, after = the record now
  const bad = run.fieldChanges.filter(c => c.id === tgtId && fields.includes(c.field) && (String(after[c.field] ?? '') !== String(c.after ?? '') || (!c.beforeHidden && !c.beforeUnread && String(before[c.field] ?? '') !== String(c.before ?? ''))));
  h.log('lines that disagree with the CLI:', JSON.stringify(bad));
  await waitScanned(h).catch(() => {});
  process.env.SKIP_RUN = '1';
  await retryAndRollback(h);
  h.log('──────── rolled back ────────');
  h.log('CLI AFTER ROLLBACK', tgtId, JSON.stringify(cli(h, tgtId, fields)));
}
