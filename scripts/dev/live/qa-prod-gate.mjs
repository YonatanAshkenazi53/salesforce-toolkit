// Live QA (2026-10-18): every new write path asks for the org's name when the org is treated as
// production. Both orgs are set to "Guard as production" (Connected Orgs' own switch), then each
// confirmation is opened and CANCELLED — nothing is written. The guard is switched off at the end.
//   1. Flows page › delete one obsolete version     2. Flows page › delete the failed interviews
//   3. Deploy page › Deploy (the volume deployment) 4. Tool History › Undo of the newest flow change
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const SRC = 'https://trailheads5.my.salesforce.com', TGT = 'https://orgfarm-e2c4511b2b-dev-ed.develop.my.salesforce.com';
const LABEL = 'SFTK FC Test Flow';
const results = [];
async function guard(h, on) {
  return h.eval(`(async () => { const keys = Object.keys(_orgs).filter(u => /trailheads5|orgfarm-e2c4511b2b/.test(u)); for (const k of keys) _orgs[k].guardAsProd = ${on}; await storageSaveOrgs(); return keys.length; })()`);
}
// answer the tool's own questions until the shared confirmation shows, then read it and Cancel
async function reachConfirm(h, label) {
  for (let i = 0; i < 6; i++) {
    if (await h.eval(`!!document.querySelector('#sftkConfirmGo')`)) break;
    await h.eval(`(() => { const b = document.querySelector('#modalConfirm') || [...document.querySelectorAll('.sftk-cf button, #dsModalBox button')].find(b => !/cancel|scan|backup|close/i.test(b.textContent) && /anyway|without|continue|proceed|understand|skip|delete|ok|deploy/i.test(b.textContent) && !b.disabled); if (b) b.click(); return !!b; })()`);
    await h.sleep(1500);
  }
  const has = await h.eval(`!!document.querySelector('#sftkConfirmGo')`);
  const prod = await h.eval(`(document.querySelector('.sftk-confirm-prodnote')?.innerText || '').trim()`);
  results.push([label, has && !!prod]);
  h.log(`${label}: confirmation ${has ? 'shown' : 'NOT shown'} · production band: ${prod ? prod.slice(0, 120) : 'MISSING'}`);
  await h.eval(`(() => { const c = document.querySelector('#sftkConfirmCancel'); if (c) c.click(); return true; })()`); await h.sleep(800);
  await h.eval(`(() => { if (typeof closeModal === 'function') closeModal(); return true; })()`);
}
export default async function (h) {
  // the popup follows the org opened LAST — the Flows page must be trailheads5, where the fixture flow lives
  await h.login('npc2'); await h.login('npc'); await h.studio(''); await h.watchErrors();
  h.log('guarded orgs:', await guard(h, true));
  try {
    // 1 + 2: the Flows page (the popup reads the same stored orgs)
    await h.popup('flows');
    await h.waitFor("document.querySelectorAll('.flow-group').length > 0", 120000, 500);
    await h.waitFor('typeof _flowInterviews === "object" && _flowInterviews.at > 0', 60000, 500).catch(() => {});
    const g = `[...document.querySelectorAll('.flow-group')].find(g => g.dataset.label === ${JSON.stringify(LABEL)})`;
    await h.eval(`(() => { const i = document.getElementById('searchInput'); i.value = 'SFTK FC Test Flow'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await h.waitFor(`!!${g}`, 60000, 500);
    await h.eval(`(() => { const x = ${g}; x.querySelector('.flow-group-header').click(); return true; })()`); await h.sleep(500);
    await h.eval(`(() => { const r = [...${g}.querySelectorAll('.version-row')].find(r => /Obsolete/.test(r.innerText)); r.querySelector('.version-checkbox').click(); return true; })()`);
    await h.eval(`document.getElementById('deleteBtn').click()`); await h.sleep(1500);
    await reachConfirm(h, '1. flow version delete');
    await h.eval(`(() => { selectedIds.clear(); updateActionBar(); return true; })()`);
    if (await h.eval(`!!${g}?.querySelector('.flow-int-chip')`)) {
      await h.eval(`${g}.querySelector('.flow-int-chip').click()`); await h.sleep(800);
      await h.eval(`(document.querySelector('#fiDelFailed') || document.querySelector('#fiDelAll')).click()`); await h.sleep(1200);
      await reachConfirm(h, '2. interviews delete');
    } else { h.log('2. interviews delete: no interviews on the fixture flow — skipped'); }
    // 4: the undo of a tool change
    if (await h.eval(`!!document.querySelector('#sftkThBtn') && document.querySelector('#sftkThBtn').style.display !== 'none'`)) {
      await h.eval(`document.querySelector('#sftkThBtn').click()`); await h.sleep(1200);
      if (await h.eval(`!!document.querySelector('#sftkThModalList [data-th-undo]:not([disabled])')`)) {
        await h.eval(`document.querySelector('#sftkThModalList [data-th-undo]:not([disabled])').click()`); await h.sleep(1500);
        await reachConfirm(h, '4. undo from the tool History');
      } else h.log('4. undo: no undoable entry in the Flows History — skipped');
      await h.eval(`(() => { const c = document.querySelector('#sftkThClose'); if (c) c.click(); return true; })()`);
    }
    // 3: the Deploy page
    await h.studio('');
    const all = JSON.parse(readFileSync('docs/fixtures/complex-deployment/profiles.json', 'utf8'));
    const base = JSON.parse(JSON.stringify(all.find(p => (p.profile || p).name === 'SFTK VOL — Accounts')));
    const prof = base.profile || base;
    Object.assign(prof, { name: 'QA prod gate', sourceOrg: SRC, targetOrg: TGT }); prof.tree.where = "Name LIKE 'SFTK VOL Account 0070%'"; prof.tree.children = [];
    mkdirSync('dist/tmp', { recursive: true }); writeFileSync('dist/tmp/qa-prod.json', JSON.stringify([base]));
    await h.importProfiles('dist/tmp/qa-prod.json');
    const id = await h.eval(`_profiles.find(p => p.name === 'QA prod gate')?.id`);
    await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
    await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
    await h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000); await h.sleep(1200);
    await h.eval(`document.querySelector('#dsDepTickAll')?.click()`); await h.sleep(800);
    await h.eval(`document.querySelector('#dsRecRunBtn').click()`); await h.sleep(2000);
    await reachConfirm(h, '3. deployment run');
    await h.eval(`(async () => { _profiles = _profiles.filter(p => p.name !== 'QA prod gate'); await storageSaveProfiles(); return true; })()`);
  } finally {
    await h.studio('').catch(() => {});
    h.log('guard switched off for:', await guard(h, false));
  }
  for (const [what, ok] of results) h.log(ok ? '✓' : '❌', what, '— asks for the org name');
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 5)')).slice(0, 500));
  if (results.some(r => !r[1])) throw new Error('a write path skipped the production step');
}
