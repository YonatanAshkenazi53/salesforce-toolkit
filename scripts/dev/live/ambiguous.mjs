// Live (campaign 3, phase 5): the CX fixture's "SFTK CX Duplicate Name" pair.
// Source holds it twice (Haifa, Eilat), the target once. The Deploy page must
// list both source copies under ⚠ Ambiguous (never guess); 📌 pair the first
// with the target's record → the orgs are read again → the other copy is now
// an insert; deploy only that; the CLI must show TWO target accounts with
// that name and distinct Ids; then ↩ Roll back (same session — History lives
// in this throwaway profile) and the CLI shows one again.
//   PROFILE (default the Accounts tree) · ROLLBACK=0 keeps the run
import { execSync } from 'node:child_process';
import retryAndRollback from './retry-and-rollback.mjs';

const dump = async (h, sel, n = 1600) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
const cli = h => {
  try {
    const t = execSync(`sf data query -o npc2 --json -q "SELECT Id, BillingCity FROM Account WHERE Name = 'SFTK CX Duplicate Name'"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const recs = JSON.parse(t.slice(t.indexOf('{'))).result.records.map(r => `${r.Id}:${r.BillingCity}`);
    h.log('CLI TARGET "SFTK CX Duplicate Name":', recs.length, JSON.stringify(recs));
    return recs;
  } catch (e) { h.log('CLI failed:', e.message.split('\n')[0]); return null; }
};
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);

export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK CX — Accounts tree';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (!id) throw new Error('fixture profile missing');
  cli(h);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await waitScanned(h); await h.sleep(2000);
  h.log('PLAN:', await dump(h, '.ds-dep-plan', 900));
  h.log('NOTES:', await dump(h, '.ds-rec-card-warn', 1400));
  // the root object's ⚠ Ambiguous list
  await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="amb"]')?.click() || document.querySelector('[data-dep-tab="amb"]')?.click()`);
  await h.sleep(1200);
  h.log('AMBIGUOUS LIST:', await dump(h, '#dsDepList', 1400));
  await h.shot(h.shots + '/amb-list.png');
  // ⚠ Needs a decision (campaign 4): one select per source record, then 📌 Apply.
  // Say the FIRST copy is the target's record; leave the other undecided.
  const pin = await h.eval(`(() => { const s = document.querySelector('[data-dep-amb-sel]'); if (!s) return null; const o = [...s.options].find(x => x.value && x.value !== '__new__'); if (!o) return null; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return s.dataset.depAmbSel + '|' + o.value; })()`);
  h.log('deciding:', pin, '| apply button:', await h.eval(`(document.querySelector('#dsDepAmbApply') || {}).textContent`));
  if (!pin) return;
  await h.eval(`document.querySelector('#dsDepAmbApply').click()`);
  await h.sleep(2500);
  await waitScanned(h); await h.sleep(2500);
  h.log('PLAN after pin:', await dump(h, '.ds-dep-plan', 900));
  // the OTHER copy must now be an insert — tick only it
  const other = await h.eval(`(() => {
    document.querySelector('[data-dep-obj=""][data-dep-tab="ins"]')?.click();
    return true; })()`);
  await h.sleep(1200);
  const picked = await h.eval(`(() => { const row = [...document.querySelectorAll('#dsDepList .ds-dep-row')].find(r => /SFTK CX Duplicate Name/.test(r.innerText)); const cb = row && row.querySelector('[data-dep-push]'); if (!cb) return null; cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); return cb.dataset.depPush; })()`);
  h.log('insert tab row for the other copy (ticked):', picked, '| other =', other);
  h.log('SUMMARY:', await dump(h, '#dsDepSummary', 300));
  if (!picked) return;
  const histBefore = await h.eval('_history.length');
  await h.click('#dsRecRunBtn'); await h.sleep(2500);
  for (let i = 0; i < 4; i++) {
    const m = await h.modalText(700); if (!m) break;
    h.log('MODAL:', m);
    await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } const b = document.querySelector('#sftkConfirmGo') || [...document.querySelectorAll('#dsModalBox button')].find(b => /proceed|deploy|confirm|ok/i.test(b.textContent) && !b.disabled); if (b) b.click(); return !!b; })()`);
    await h.sleep(2000);
  }
  for (let i = 0; i < 300; i++) { if (await h.eval(`_history.length > ${histBefore}`)) break; await h.sleep(1000); }
  await h.sleep(5000);
  await waitScanned(h); await h.sleep(2000);
  h.log('PLAN after run:', await dump(h, '.ds-dep-plan', 900));
  const after = cli(h);
  h.log('DISTINCT IDS:', after ? new Set(after.map(x => x.split(':')[0])).size : '?');
  if (process.env.ROLLBACK === '0') return;
  process.env.SKIP_RUN = '1';
  await retryAndRollback(h);
  h.log('──────── rolled back ────────');
  cli(h);
}
