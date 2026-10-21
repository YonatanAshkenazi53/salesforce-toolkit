// Live: Deploy page › ⚠ Needs a decision › 🔀 Merge both sides (user 2026-10-21: "present dupes in
// both source and targets and offer to merge them. once they are merged and have no diff they
// should appear as synced").
//
// WRITES to both orgs: the fixture pair "SFTK CX Duplicate Name" in the source (Haifa / 1,
// Eilat / 2); in the target the fixture's own copy ("Target twin" / 3, seed-target.apex) gets a
// second copy (Haifa / 1) for this run. Merge both sides keeps the Haifa copy in the source and
// the fixture's copy in the target, taking the Haifa values; after the one re-read the name must
// sit under 🟢 Synced. Afterwards the source pair is put back (fixture.mjs) and the target's copy
// gets its fixture values back; the copy created here is the one the merge deleted.
//   1. the group: copies on both sides, three 🔀 buttons (src, tgt, both)
//   2. both: the source picker → confirm → the target picker → confirm → one re-read
//   3. CLI: one record per org, Haifa / 1; the merged copies carry MasterRecordId
//   4. the page: the name is gone from ⚠ and listed under 🟢 Synced
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { restoreDuplicateName } from '../video/fixture.mjs';
const NL = String.fromCharCode(10);
const dump = async (h, sel, n = 1800) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);
const cli = (org, q, all = false) => {
  const t = execSync(`sf data query -o ${org} --json ${all ? '--all-rows ' : ''}-q "${q}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(t.slice(t.indexOf('{'))).result.records;
};
const apex = (org, lines) => {
  const dir = join(process.env.TEMP || resolve('dist'), `sftk-dupboth-${Date.now()}`);
  mkdirSync(dir, { recursive: true }); const f = join(dir, 'run.apex'); writeFileSync(f, lines.join(NL));
  try {
    const out = execFileSync('sf', ['apex', 'run', '-o', org, '--file', `"${f}"`, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true });
    const r = JSON.parse(out.slice(out.indexOf('{'))).result || {};
    if (r.success === false || r.compiled === false) throw new Error(`apex on ${org} failed: ${r.compileProblem || r.exceptionMessage || out.slice(0, 300)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
const NAME = 'SFTK CX Duplicate Name';
const DMO = "Database.DMLOptions dmo = new Database.DMLOptions(); dmo.DuplicateRuleHeader.allowSave = true; dmo.DuplicateRuleHeader.runAsCurrentUser = true; dmo.optAllOrNone = true;";

// one merge dialog: keep the column of keepId; take the listed fields from the column of fromId
// (none: its own values); confirm, acknowledge, go
async function mergeKeep(h, step, keepId, fromId = null, fields = []) {
  await h.waitFor("!!document.querySelector('.ds-merge-table')", 60000, 300); await h.sleep(500);
  const cols = await h.eval(`[...document.querySelectorAll('.ds-merge-table thead th[data-merge-col]')].map(th => th.innerText.replace(/\\s+/g, ' ').trim())`);
  const keep = cols.findIndex(c => c.includes(keepId)), from = fromId ? cols.findIndex(c => c.includes(fromId)) : -1;
  h.log(`${step}. picker columns:`, JSON.stringify(cols), '→ keep', keep, fields.length ? `· ${fields.join(', ')} from ${from}` : '');
  if (keep < 0 || (fromId && from < 0)) throw new Error('the copies are not the expected columns of the picker');
  await h.eval(`(() => { const r = document.querySelector('input[name="dsMergeKeep"][value="${keep}"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  for (const f of fields) {
    const ok = await h.eval(`(() => { const r = document.querySelector('tr[data-merge-field="${f}"] input[value="${from}"]'); if (!r) return false; r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    if (!ok) throw new Error(`${f} is not offered by the picker`);
  }
  await h.eval(`document.querySelector('#dsMergeGo').click()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 30000, 300); await h.sleep(300);
  h.log(`${step}. CONFIRM:`, (await dump(h, '#dsModalBox', 600)));
  const histBefore = await h.eval('_history.length');
  await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
  await h.sleep(200);
  await h.eval(`document.querySelector('#sftkConfirmGo').click()`);
  await h.waitFor(`_history.length > ${histBefore}`, 120000, 500);
  const e = JSON.parse(await h.eval(`(() => { const e = _history[_history.length - 1]; return JSON.stringify({ title: e.profileName, status: e.status }); })()`));
  h.log(`${step}. HISTORY:`, JSON.stringify(e));
  if (e.status !== 'success') throw new Error('the merge did not succeed: ' + e.title);
}

export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const PROFILE = process.env.PROFILE || 'SFTK CX — Accounts tree';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(PROFILE)})?.id`);
  if (!id) throw new Error('fixture profile missing');

  // the source pair as the fixture has it; the target's fixture copy (made if missing) plus one more
  restoreDuplicateName('npc', (...a) => h.log('0.', ...a));
  const had = cli('npc2', `SELECT Id FROM Account WHERE Name = '${NAME}'`);
  apex('npc2', [DMO,
    ...(had.length ? [] : [`Database.insert(new Account(Name='${NAME}', Industry='Energy', BillingCity='Target twin', AnnualRevenue=3), dmo);`]),
    `Database.insert(new Account(Name='${NAME}', Industry='Energy', BillingCity='Haifa', AnnualRevenue=1), dmo);`]);
  const src = cli('npc', `SELECT Id, BillingCity, AnnualRevenue FROM Account WHERE Name = '${NAME}' ORDER BY CreatedDate`);
  const tgt = cli('npc2', `SELECT Id, BillingCity, AnnualRevenue FROM Account WHERE Name = '${NAME}' ORDER BY CreatedDate`);
  h.log('0. CLI source:', JSON.stringify(src.map(r => `${r.Id}:${r.BillingCity}/${r.AnnualRevenue}`)), '| target:', JSON.stringify(tgt.map(r => `${r.Id}:${r.BillingCity}/${r.AnnualRevenue}`)));
  if (src.length !== 2 || tgt.length !== 2) throw new Error('a pair is missing');
  const srcHaifa = src.find(r => r.BillingCity === 'Haifa');
  const tgtFixture = tgt[0], tgtHaifa = tgt[1];   // the fixture's copy is the older one; the Haifa copy was made just now
  const fixtureVals = { BillingCity: tgtFixture.BillingCity, AnnualRevenue: tgtFixture.AnnualRevenue };

  try {
    await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
    await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
    await waitScanned(h); await h.sleep(2000);
    await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="amb"]')?.click() || document.querySelector('[data-dep-tab="amb"]')?.click()`);
    await h.sleep(1200);
    h.log('1. INTRO:', await dump(h, '.ds-dep-amb-intro', 1200));
    const grp = await h.eval(`(() => { const g = [...document.querySelectorAll('.ds-amb-group')].find(g => g.innerText.includes(${JSON.stringify(NAME)})); if (!g) return ''; g.setAttribute('data-demo-grp', '1'); return g.innerText; })()`);
    h.log('1. GROUP:', grp.slice(0, 1200).split(NL).map(x => x.trim()).filter(Boolean).join(' | '));
    if (!grp) throw new Error('the name is not on the ⚠ tab');
    const btns = await h.eval(`[...document.querySelectorAll('[data-demo-grp] [data-dep-amb-merge]')].map(b => b.dataset.depAmbMerge + ':' + b.textContent.trim())`);
    h.log('1. merge buttons:', JSON.stringify(btns));
    if (!['src', 'tgt', 'both'].every(s => btns.some(b => b.startsWith(s + ':')))) throw new Error('expected the three 🔀 buttons');
    const bar = await h.eval(`document.querySelector('[data-demo-grp] .ds-amb-mergebar .ds-dep-muted')?.textContent || ''`);
    h.log('1. bar note:', bar);
    await h.eval(`(() => { document.querySelector('[data-demo-grp]').scrollIntoView({ block: 'start' }); return true; })()`); await h.sleep(300);
    await h.shot(h.shots + '/merge-both-1-group.png');

    // 2. both sides, one after the other
    await h.eval(`document.querySelector('[data-demo-grp] [data-dep-amb-merge="both"]').click()`);
    await mergeKeep(h, '2a (source)', srcHaifa.Id);
    await mergeKeep(h, '2b (target)', tgtFixture.Id, tgtHaifa.Id, ['BillingCity', 'AnnualRevenue']);

    // 3. the orgs
    const srcAfter = cli('npc', `SELECT Id, BillingCity, AnnualRevenue FROM Account WHERE Name = '${NAME}'`);
    const tgtAfter = cli('npc2', `SELECT Id, BillingCity, AnnualRevenue FROM Account WHERE Name = '${NAME}'`);
    h.log('3. CLI source after:', JSON.stringify(srcAfter.map(r => `${r.Id}:${r.BillingCity}/${r.AnnualRevenue}`)), '| target after:', JSON.stringify(tgtAfter.map(r => `${r.Id}:${r.BillingCity}/${r.AnnualRevenue}`)));
    if (srcAfter.length !== 1 || srcAfter[0].Id !== srcHaifa.Id) throw new Error('the source should hold exactly the Haifa copy now');
    if (tgtAfter.length !== 1 || tgtAfter[0].Id !== tgtFixture.Id || tgtAfter[0].BillingCity !== 'Haifa' || Number(tgtAfter[0].AnnualRevenue) !== 1) throw new Error("the target should hold exactly the fixture's copy with the Haifa values now");
    const gone = cli('npc2', `SELECT Id, IsDeleted, MasterRecordId FROM Account WHERE Name = '${NAME}' AND IsDeleted = true`, true);
    h.log('3. CLI target merged copy:', JSON.stringify(gone));

    // 4. the page after the one re-read
    await waitScanned(h); await h.sleep(2000);
    h.log('4. TABS:', await dump(h, '.ds-dep-tabs', 500));
    const still = await h.eval(`[...document.querySelectorAll('.ds-amb-group')].filter(g => g.innerText.includes(${JSON.stringify(NAME)})).length`);
    const where = [];
    for (const t of ['same', 'chg', 'ins', 'amb']) {
      const has = await h.eval(`(() => { const b = document.querySelector('[data-dep-obj=""][data-dep-tab="${t}"]') || document.querySelector('[data-dep-tab="${t}"]'); if (!b) return 'no tab'; b.click(); return (document.querySelector('#dsDepList')?.innerText || '').includes(${JSON.stringify(NAME)}); })()`);
      await h.sleep(300); where.push(`${t}:${has}`);
    }
    h.log('4. groups still on ⚠:', still, '| where the name is now:', where.join(' '));
    await h.eval(`(document.querySelector('[data-dep-obj=""][data-dep-tab="same"]') || document.querySelector('[data-dep-tab="same"]'))?.click()`); await h.sleep(400);
    await h.shot(h.shots + '/merge-both-4-synced.png');
    if (still || !where.includes('same:true')) throw new Error('after the merge the name should be under 🟢 Synced and off ⚠');
    h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 5)')).slice(0, 400));
    h.log('✓ merge both sides: three buttons, two pickers and confirmations, one re-read, the name under 🟢 Synced');
  } finally {
    const r = restoreDuplicateName('npc', (...a) => h.log('5.', ...a));
    if (r.failed) h.log('5. RESTORE FAILED — the fixture needs seed-source.apex by hand');
    try {
      apex('npc2', [DMO,
        `Account a = [SELECT Id FROM Account WHERE Id = '${tgtFixture.Id}']; a.BillingCity = '${fixtureVals.BillingCity}'; a.AnnualRevenue = ${Number(fixtureVals.AnnualRevenue) || 0}; Database.update(a, dmo);`,
        `delete [SELECT Id FROM Account WHERE Id = '${tgtHaifa.Id}'];`]);
      h.log("5. target: the fixture's copy has its values back; the copy made here is gone");
    } catch (e) { h.log('5. target cleanup FAILED:', String(e).slice(0, 200)); }
  }
}
