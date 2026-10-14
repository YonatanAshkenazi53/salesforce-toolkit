// Live: Deploy page › ⚠ Needs a decision › 🔀 Merge these 2 into one (user
// 2026-10-11: "maybe we can provide merging mechanism? so the user ends up with a
// unique data and without dupes" / "It's only merge into this one. User needs to
// be able to select the merged values"; 2026-10-12: "we need to ship it as 1.0").
//
// WRITES to trailheads5 (npc, the source): the two "SFTK CX Duplicate Name"
// Accounts (Haifa / 1, Eilat / 2 — docs/fixtures/complex-deployment) become one,
// through Salesforce's own merge. The pair is put back afterwards
// (fixture.mjs: restoreDuplicateName). trailheads4 (npc2) is read only.
//   1. the group as drawn: the 🔀 button sits on the trailheads5 side (two copies)
//   2. the picker: both copies side by side, Billing City and Annual Revenue differ
//   3. keep the Haifa copy, take Eilat's city, TYPE a revenue of 7 (the third choice, 2026-10-14) → the shared confirmation
//      (cannot be undone — acknowledged) → Merge now
//   4. the History entry; CLI: one Account left with Eilat / 2, the deleted copy
//      carries MasterRecordId = the record that stayed; trailheads4 unchanged
//   5. after the re-read the name is no longer on the ⚠ tab
//   6. the pair restored (CLI count 2)
import { execSync } from 'node:child_process';
import { restoreDuplicateName } from '../video/fixture.mjs';
const NL = String.fromCharCode(10);
const dump = async (h, sel, n = 1800) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);
const cli = (org, q, all = false) => {
  const t = execSync(`sf data query -o ${org} --json ${all ? '--all-rows ' : ''}-q "${q}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(t.slice(t.indexOf('{'))).result.records;
};
const NAME = 'SFTK CX Duplicate Name';

export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const PROFILE = process.env.PROFILE || 'SFTK CX — Accounts tree';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(PROFILE)})?.id`);
  if (!id) throw new Error('fixture profile missing');

  const before = cli('npc', `SELECT Id, BillingCity, AnnualRevenue FROM Account WHERE Name = '${NAME}' ORDER BY CreatedDate`);
  h.log('0. CLI trailheads5 before:', JSON.stringify(before.map(r => `${r.Id}:${r.BillingCity}/${r.AnnualRevenue}`)));
  if (before.length !== 2) throw new Error(`the fixture pair is not there (${before.length} records) — seed-source.apex / restoreDuplicateName first`);
  const haifa = before.find(r => r.BillingCity === 'Haifa') || before[0];
  const eilat = before.find(r => r !== haifa);
  const tgtBefore = cli('npc2', `SELECT Id, BillingCity FROM Account WHERE Name = '${NAME}'`);
  h.log('0. CLI trailheads4 before:', tgtBefore.length, 'record(s)');

  let survivorId = null;
  try {
    await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
    await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
    await waitScanned(h); await h.sleep(2000);
    await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="amb"]')?.click() || document.querySelector('[data-dep-tab="amb"]')?.click()`);
    await h.sleep(1200);
    h.log('1. GROUP:', await dump(h, '.ds-amb-group', 900));
    const btns = await h.eval(`[...document.querySelectorAll('[data-dep-amb-merge]')].map(b => b.dataset.depAmbMerge + ':' + b.textContent.trim())`);
    h.log('1. merge buttons:', JSON.stringify(btns));
    if (!btns.some(b => b.startsWith('src:'))) throw new Error('no 🔀 button on the source side');
    await h.eval(`(() => { document.querySelector('.ds-dep-amb-intro')?.scrollIntoView({ block: 'start' }); return true; })()`); await h.sleep(300);
    await h.shot(h.shots + '/merge-1-group.png');

    // 2. the picker
    await h.eval(`document.querySelector('[data-dep-amb-merge="src"]').click()`);
    await h.waitFor("!!document.querySelector('.ds-merge-table')", 60000, 300);
    await h.sleep(500);
    h.log('2. PICKER:', await dump(h, '#dsModalBox', 2200));
    const cols = await h.eval(`[...document.querySelectorAll('.ds-merge-table thead th[data-merge-col]')].map(th => th.innerText.replace(/\\s+/g, ' ').trim())`);
    h.log('2. columns:', JSON.stringify(cols));
    const fields = await h.eval(`[...document.querySelectorAll('tr[data-merge-field]')].map(tr => tr.dataset.mergeField)`);
    h.log('2. fields that differ:', JSON.stringify(fields));
    if (!fields.includes('BillingCity') || !fields.includes('AnnualRevenue')) throw new Error('Billing City / Annual Revenue are not offered');
    await h.shot(h.shots + '/merge-2-picker.png');

    // 3. keep Haifa, take Eilat's city and revenue
    const keep = cols.findIndex(c => c.includes(haifa.Id)), other = cols.findIndex(c => c.includes(eilat.Id));
    if (keep < 0 || other < 0) throw new Error('the copies are not the fixture ids');
    await h.eval(`(() => { const r = document.querySelector('input[name="dsMergeKeep"][value="${keep}"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    for (const f of ['BillingCity']) await h.eval(`(() => { const r = document.querySelector('tr[data-merge-field="${f}"] input[value="${other}"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    // the third choice (2026-10-14): a value typed here — Annual Revenue becomes 7, a number neither copy holds
    await h.eval(`(() => { const i = document.querySelector('input[data-merge-custom="AnnualRevenue"]'); i.value = '7'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    h.log('3. same-fields fold:', await h.eval(`(document.querySelector('.ds-merge-samefold summary')?.innerText || 'none')`));
    const picked = await h.eval(`[...document.querySelectorAll('tr[data-merge-field]')].map(tr => tr.dataset.mergeField + '=' + (tr.querySelector('input:checked') || {}).value)`);
    h.log('3. keep column', keep, '| picks:', JSON.stringify(picked));
    await h.eval(`document.querySelector('#dsMergeGo').click()`);
    await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 30000, 300);
    await h.sleep(400);
    h.log('3. CONFIRM:', await dump(h, '#dsModalBox', 1600));
    await h.shot(h.shots + '/merge-3-confirm.png');
    const histBefore = await h.eval('_history.length');
    await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
    await h.sleep(200);
    const goOff = await h.eval(`document.querySelector('#sftkConfirmGo').disabled`);
    if (goOff) throw new Error('Go is still off after the acknowledgement');
    await h.eval(`document.querySelector('#sftkConfirmGo').click()`);
    // a production step would ask for the org's name; the trial org has none
    await h.waitFor(`_history.length > ${histBefore}`, 120000, 500);
    const entry = await h.eval(`(() => { const e = _history[_history.length - 1]; return JSON.stringify({ tool: e.tool, title: e.profileName, status: e.status, what: (e.what || []).map(w => (w.ok ? '✅ ' : '❌ ') + w.text), undo: e.toolUndo }); })()`);
    h.log('4. HISTORY:', entry);
    const E = JSON.parse(entry);
    if (E.status !== 'success') throw new Error('the merge did not succeed: ' + E.what.join(' ‖ '));
    survivorId = haifa.Id;

    // 4. the org
    const after = cli('npc', `SELECT Id, BillingCity, AnnualRevenue FROM Account WHERE Name = '${NAME}'`);
    h.log('4. CLI trailheads5 after:', JSON.stringify(after.map(r => `${r.Id}:${r.BillingCity}/${r.AnnualRevenue}`)));
    if (after.length !== 1 || after[0].Id !== haifa.Id || after[0].BillingCity !== 'Eilat' || Number(after[0].AnnualRevenue) !== 7) throw new Error('the org does not show one record with the chosen values (city from the other copy, revenue typed)');
    const gone = cli('npc', `SELECT Id, IsDeleted, MasterRecordId FROM Account WHERE Id = '${eilat.Id}'`, true);
    h.log('4. CLI the merged copy:', JSON.stringify(gone));
    if (!gone[0] || !gone[0].IsDeleted || gone[0].MasterRecordId !== haifa.Id) throw new Error('the copy is not a merged (deleted) record pointing at the record that stayed');
    const tgtAfter = cli('npc2', `SELECT Id FROM Account WHERE Name = '${NAME}'`);
    h.log('4. CLI trailheads4 after:', tgtAfter.length, 'record(s) —', tgtAfter.length === tgtBefore.length ? 'unchanged' : 'CHANGED');

    // 5. the page after the re-read
    await waitScanned(h); await h.sleep(2000);
    h.log('5. TABS:', await dump(h, '.ds-dep-tabs', 400));
    const still = await h.eval(`[...document.querySelectorAll('.ds-amb-group')].filter(g => g.innerText.includes(${JSON.stringify(NAME)})).length`);
    h.log('5. groups still named', NAME + ':', still);
    const where = await h.eval(`(() => { const out = []; for (const t of ['chg', 'ins', 'sync']) { const b = document.querySelector('[data-dep-obj=""][data-dep-tab="' + t + '"]') || document.querySelector('[data-dep-tab="' + t + '"]'); if (b) out.push(t + ': ' + b.textContent.trim()); } return out.join(' | '); })()`);
    h.log('5. where the name is now:', where);
    await h.shot(h.shots + '/merge-5-after.png');
  } finally {
    // 6. the pair back, whatever happened
    const r = restoreDuplicateName('npc', (...a) => h.log('6.', ...a));
    if (r.failed) h.log('6. RESTORE FAILED — the fixture needs seed-source.apex by hand');
  }
}
