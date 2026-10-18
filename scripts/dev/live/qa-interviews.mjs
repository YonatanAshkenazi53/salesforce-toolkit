// Live QA (2026-10-18): flow interviews on the Flows page, against the Field Cleaner fixture on npc
// (trailheads5), whose flow SFTK_FC_Test_Flow fails ON PURPOSE so failed interviews exist
// (docs/fixtures/field-cleaner-fixture, rebuild.sh). Proved by the CLI, not by the page.
//   1. the chip on the fixture flow says how many failed runs it has, matching the CLI count
//   2. the dialog → "Delete the N failed" → the shared confirmation → CLI: those interviews gone;
//      History has a "Flow interviews" entry that says it has no undo
//   3. the fixture is rebuilt (new failed interviews), then an OBSOLETE version that carries
//      interviews is deleted: the interviews go FIRST (one dialog says so) and the version is
//      deleted (CLI) — before 2026-10-17 Salesforce refused it with DEPENDENCY_EXISTS
// WRITES (deletes interviews and one obsolete version). Rebuild the fixture afterwards.
import { execFileSync } from 'node:child_process';
const FLOW = 'SFTK_FC_Test_Flow', LABEL = 'SFTK FC Test Flow';
const q = (query, tooling = false) => JSON.parse(execFileSync('sf', ['data', 'query', '-o', 'npc', ...(tooling ? ['-t'] : []), '-q', `"${query}"`, '--json'], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).result.records || [];
const versions = () => q(`SELECT Id, VersionNumber, Status FROM Flow WHERE Definition.DeveloperName = '${FLOW}' ORDER BY VersionNumber`, true);
const interviewsOf = ids => {
  const all = ids.flatMap(id => [id, String(id).substring(0, 15)]).map(x => `'${x}'`).join(',');
  return all ? q(`SELECT Id, InterviewStatus, FlowVersionViewId FROM FlowInterview WHERE FlowVersionViewId IN (${all})`) : [];
};
const dialogText = h => h.eval(`(() => { const d = document.querySelector('.sftk-cf'); return d && d.offsetParent ? (d.innerText || '').split(String.fromCharCode(10)).join(' ').slice(0, 400) : ''; })()`);
async function confirmShared(h) {
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 30000, 300);
  await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) a.click(); return true; })()`);
  await h.sleep(300);
  await h.eval(`document.querySelector('#sftkConfirmGo').click()`);
}
async function openFlows(h) {
  await h.popup('flows');
  await h.waitFor("document.querySelectorAll('.flow-group').length > 0", 120000, 500);
  await h.waitFor('typeof _flowInterviews === "object" && _flowInterviews.at > 0', 60000, 500).catch(() => {});
  await h.sleep(800);
}
const groupSel = `[...document.querySelectorAll('.flow-group')].find(g => g.dataset.label === ${JSON.stringify(LABEL)})`;

export default async function (h) {
  await h.login('npc'); await h.watchErrors();
  // ── 1. the chip ──
  await openFlows(h);
  const vs = versions();
  const ints = interviewsOf(vs.map(v => v.Id));
  const failedCli = ints.filter(i => /^error$/i.test(i.InterviewStatus)).length;
  const chip = await h.eval(`(() => { const g = ${groupSel}; return g ? (g.querySelector('.flow-int-chip')?.textContent || 'no chip') : 'no group'; })()`);
  h.log('1. CLI:', vs.length, 'versions,', ints.length, 'interviews,', failedCli, 'failed | chip:', chip);
  if (!failedCli) throw new Error('the fixture has no failed interviews — run docs/fixtures/field-cleaner-fixture/rebuild.sh first');
  if (!chip.includes(`✖ ${failedCli} failed`)) throw new Error(`the chip (${chip}) does not say the ${failedCli} failed interviews the CLI counts`);
  // ── 2. delete the failed ones from the dialog ──
  await h.eval(`${groupSel}.querySelector('.flow-int-chip').click()`); await h.sleep(800);
  h.log('2. dialog:', await dialogText(h));
  await h.eval(`document.querySelector('#fiDelFailed').click()`); await h.sleep(800);
  h.log('2. confirmation:', (await dialogText(h)).slice(0, 300));
  await confirmShared(h);
  await h.waitFor("!!document.querySelector('.sftk-cf') && /deleted|refused/.test(document.querySelector('.sftk-cf').innerText)", 120000, 500);
  h.log('2. result:', await dialogText(h));
  await h.eval(`(() => { const b = document.querySelector('#modalCancel'); if (b) b.click(); return true; })()`);
  const leftFailed = interviewsOf(vs.map(v => v.Id)).filter(i => /^error$/i.test(i.InterviewStatus)).length;
  h.log('2. CLI failed interviews left:', leftFailed, leftFailed === 0 ? '✓' : '❌');
  const entry = await h.eval(`(async () => { const e = (await sftkHistoryAll()).find(x => x.tool === 'Flow interviews'); return e ? JSON.stringify({ status: e.status, undo: e.toolUndo && e.toolUndo.none }) : 'no entry'; })()`);
  h.log('2. History:', entry);
  if (leftFailed) throw new Error('failed interviews are still in the org');

  // ── 3. new interviews, then delete an obsolete version that carries them ──
  h.log('3. rebuilding the fixture for fresh interviews…');
  execFileSync('bash', ['docs/fixtures/field-cleaner-fixture/rebuild.sh', 'npc'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const vs2 = versions();
  const withInt = vs2.filter(v => v.Status !== 'Active').find(v => interviewsOf([v.Id]).length > 0);
  if (!withInt) throw new Error('after the rebuild no obsolete version carries an interview');
  const nInt = interviewsOf([withInt.Id]).length;
  h.log(`3. target: v${withInt.VersionNumber} (${withInt.Status}) with ${nInt} interview(s)`);
  await openFlows(h);
  await h.eval(`(() => { const g = ${groupSel}; g.querySelector('.flow-group-header').click(); return true; })()`); await h.sleep(600);
  const ticked = await h.eval(`(() => { const row = document.querySelector('.version-row[data-id="${withInt.Id}"]'); if (!row) return false; row.querySelector('.version-checkbox').click(); return true; })()`);
  if (!ticked) throw new Error('the version row is not on the page');
  await h.eval(`document.getElementById('deleteBtn').click()`); await h.sleep(1500);
  for (let i = 0; i < 6; i++) {
    const t = await dialogText(h);
    if (!t) break;
    h.log(`3. dialog ${i}:`, t.slice(0, 260));
    if (await h.eval(`!!document.querySelector('#sftkConfirmGo')`)) { await confirmShared(h); }
    else await h.eval(`(() => { const b = document.querySelector('#modalConfirm') || [...document.querySelectorAll('.sftk-cf button')].find(b => !/cancel|scan|backup/i.test(b.textContent) && /anyway|without|continue|proceed|understand|skip|delete|ok/i.test(b.textContent) && !b.disabled); if (b) b.click(); return !!b; })()`);
    await h.sleep(2500);
  }
  await h.waitFor("document.getElementById('progressPanel').style.display === 'none'", 300000, 1000).catch(() => {});
  await h.sleep(2000);
  h.log('3. result:', await dialogText(h));
  const gone = !versions().some(v => v.Id === withInt.Id);
  const intLeft = interviewsOf([withInt.Id]).length;
  h.log(`3. CLI: version ${gone ? 'deleted ✓' : 'STILL THERE ❌'} · its interviews left: ${intLeft}`);
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 5)')).slice(0, 500));
  if (!gone || intLeft) throw new Error('the version or its interviews are still in the org');
}
