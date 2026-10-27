// Live: ✏ Values on the Deploy page (user 2026-10-27). One Insert row gets a typed
// Description, the dialog is looked at (one record, then many), the record is
// deployed into the target with it, the CLI reads the value back, and the run
// is rolled back. NOWRITE=1 stops before the deploy (screenshots only).
//   PROFILE = deployment name (default: the Accounts tree)
import { execSync } from 'node:child_process';
import retryAndRollback from './retry-and-rollback.mjs';
const NL = String.fromCharCode(10);
const dump = async (h, sel, n = 1500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);
const TYPED = 'typed on the Deploy page 2026-10-27';
const cli = (h, name) => {
  try {
    const t = execSync(`sf data query -o npc2 --json -q "SELECT Id, Description, Website FROM Account WHERE Name = '${name.replace(/'/g, "\\'")}'"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const recs = JSON.parse(t.slice(t.indexOf('{'))).result.records.map(r => `${r.Id}: ${r.Description} / ${r.Website}`);
    h.log(`CLI TARGET "${name}":`, recs.length, JSON.stringify(recs));
    return recs;
  } catch (e) { h.log('CLI failed:', e.message.split(NL)[0]); return null; }
};

export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK CX — Accounts tree';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (!id) throw new Error('fixture profile missing');
  if (process.env.INSERT === '0') return changedPath(h, NAME);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  const dir = await h.eval(`(() => { const p = _reconcileProfile; return p ? { src: p.sourceOrg || '', tgt: p.targetOrg || '' } : null; })()`);
  if (!dir || !dir.src.includes('trailheads5') || !/orgfarm|dev-ed/.test(dir.tgt)) throw new Error(`direction ${JSON.stringify(dir)} — this script only ever writes trailheads5 → the dev org`);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await waitScanned(h); await h.sleep(2000);
  await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="ins"]')?.click()`); await h.sleep(1000);
  h.log('TOOLBAR:', await dump(h, '.ds-dep-tools', 400));
  // the first Insert row that is not the duplicate name
  const row = await h.eval(`(() => { const r = [...document.querySelectorAll('#dsDepList .ds-dep-row')].find(x => !/Duplicate Name/.test(x.innerText) && x.querySelector('[data-dep-vals]')); if (!r) return null; return { id: r.querySelector('[data-dep-vals]').dataset.depVals, name: r.querySelector('.ds-dep-key').textContent.trim() }; })()`);
  h.log('row:', JSON.stringify(row));
  if (!row) throw new Error('no Insert row with a ✏ values button');
  cli(h, row.name);
  await h.eval(`document.querySelector('[data-dep-vals="${row.id}"]').click()`);
  await h.waitFor("!!document.querySelector('#dsVeSave')", 30000, 300); await h.sleep(1600);
  h.log('DIALOG head:', (await h.modalText(600)));
  h.log('fields:', await h.eval(`document.querySelectorAll('tr[data-ve-row]').length`), '| lookup rows:', await h.eval(`document.querySelectorAll('[data-ve-lkp]').length`));
  await h.shot(h.shots + '/ve-1-dialog.png');
  await h.eval(`(() => { document.documentElement.classList.add('ds-dark'); return true; })()`); await h.sleep(400);
  await h.shot(h.shots + '/ve-1-dialog-dark.png');
  await h.eval(`(() => { document.documentElement.classList.remove('ds-dark'); return true; })()`);
  // a lookup row: picked from the target, in the same dialog
  await h.eval(`(() => { const r = document.querySelector('[data-ve-lkp]'); if (r) r.scrollIntoView({ block: 'center' }); return !!r; })()`); await h.sleep(300);
  h.log('LOOKUP ROW:', await h.eval(`(document.querySelector('[data-ve-lkp]')?.closest('tr')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 300)`));
  await h.eval(`(() => { const i = document.querySelector('[data-ve-lkp] .ds-ve-lkp-in'); if (i) { i.focus(); i.value = 'SFTK'; i.dispatchEvent(new Event('input', { bubbles: true })); } return !!i; })()`); await h.sleep(2500);
  h.log('LOOKUP HITS:', await h.eval(`[...document.querySelectorAll('[data-ve-lkp] [data-ve-hit]')].map(b => b.textContent).slice(0, 6).join(' | ')`));
  await h.shot(h.shots + '/ve-1b-lookup.png');
  // type a Description — and a Website: the fixture's Americas record is Retail with no Website, which the
  // target's validation rule rejects on purpose; a typed Website is exactly the fix a person would make here
  const typed = await h.eval(`(() => { const set = (f, v) => { const i = document.querySelector('input[data-ve-field="' + f + '"]'); if (!i) return false; i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); return i.closest('tr').className; }; return [set('Description', ${JSON.stringify(TYPED)}), set('Website', 'https://americas.example.com'), set('BillingState', 'New York')]; })()`);   // the source's "NY" is no state in the target (state picklists there)
  h.log('typed → row classes:', JSON.stringify(typed));
  await h.eval(`document.querySelector('#dsVeSave').click()`); await h.sleep(1200);
  h.log('badge on the row:', await h.eval(`document.querySelector('[data-dep-vals="${row.id}"]')?.textContent`), '| stored:', await h.eval(`JSON.stringify(sftkValOvGet(_reconcileProfile.tree, _reconcileProfile.targetOrg, "${row.id}"))`));
  h.log('persisted:', await h.eval(`JSON.stringify((_profiles.find(p => p.id === ${JSON.stringify(id)}).tree.valueOverrides) || null)`));
  // many: tick two rows, open the selection editor, look, cancel
  await h.eval(`(() => { const cbs = [...document.querySelectorAll('#dsDepList [data-dep-push]')].slice(0, 2); cbs.forEach(cb => { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }); return cbs.length; })()`);
  await h.eval(`document.querySelector('[data-dep-vals-many]').click()`);
  await h.waitFor("!!document.querySelector('#dsVeSave')", 30000, 300); await h.sleep(1600);
  h.log('MANY head:', (await h.modalText(300)));
  await h.shot(h.shots + '/ve-2-many.png');
  await h.closeModal();
  await h.eval(`(() => { [...document.querySelectorAll('#dsDepList [data-dep-push]:checked')].forEach(cb => { cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); }); return true; })()`);
  if (process.env.NOWRITE === '1') { h.log('NOWRITE: stopping before the deploy'); return; }
  // deploy only that record
  await h.eval(`(() => { const cb = document.querySelector('[data-dep-push="${row.id}"]'); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  h.log('SUMMARY:', await dump(h, '#dsDepSummary', 300));
  const histBefore = await h.eval('_history.length');
  await h.click('#dsRecRunBtn'); await h.sleep(2500);
  for (let i = 0; i < 4; i++) {
    const m = await h.modalText(500); if (!m) break;
    h.log('MODAL:', m.slice(0, 300));
    await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } const b = document.querySelector('#sftkConfirmGo') || [...document.querySelectorAll('#dsModalBox button')].find(b => /proceed|deploy|confirm|ok/i.test(b.textContent) && !b.disabled); if (b) b.click(); return !!b; })()`);
    await h.sleep(2000);
  }
  for (let i = 0; i < 300; i++) { if (await h.eval(`_history.length > ${histBefore}`)) break; await h.sleep(1000); }
  await h.sleep(4000);
  h.log('RUN LOG (✏ lines):', await h.eval(`[...document.querySelectorAll('.ds-prog-note, .ds-prog-line, #dsRecProgress *')].map(e => e.textContent).filter(t => /typed/.test(t)).slice(0, 3).join(' | ')`));
  h.log('HISTORY newest:', await h.eval(`JSON.stringify((_history[0] && (_history[0].warnings || _history[0].diagnostics || [])).filter(x => /typed/.test(String(x))))`));
  h.log('HISTORY errors:', await h.eval(`JSON.stringify((_history[0] && (_history[0].errors || _history[0].errorList || [])).slice(0, 3))`).then(s => s.slice(0, 600)));
  h.log('RUN LOG errors:', await h.eval(`[...document.querySelectorAll('.ds-prog-err')].map(e => e.textContent.trim()).slice(0, 3).join(' | ').slice(0, 600)`));
  await waitScanned(h); await h.sleep(1500);
  const after = cli(h, row.name);
  h.log('TYPED VALUE LANDED:', !!(after && after.some(x => x.includes(TYPED))));
  if (process.env.ROLLBACK === '0') return;
  process.env.SKIP_RUN = '1';
  await retryAndRollback(h);
  h.log('──────── rolled back ────────');
  cli(h, row.name);

  // ── the Changed path: a typed value on a 🟡 Changed row goes through the overwrite ──
  if (process.env.CHANGED === '0') return;
  await changedPath(h, NAME);
}

// the Changed path: a typed value on a 🟡 Changed row goes through the overwrite (INSERT=0 runs only this)
async function changedPath(h, NAME) {
  await h.closeModal();
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);   // looked up again: the rollback helper re-imports the fixture
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(2500);
  h.log('view after runProfile:', await h.eval(`_currentView`), '|', (await h.text('#dsMain')).slice(0, 160).replace(/\s+/g, ' '));
  await h.waitFor("!!(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh'))", 30000, 500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await waitScanned(h); await h.sleep(2000);
  await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="chg"]')?.click()`); await h.sleep(1000);
  const chg = await h.eval(`(() => { const r = document.querySelector('#dsDepList .ds-dep-row [data-dep-vals]'); if (!r) return null; return { id: r.dataset.depVals, tgt: r.dataset.depValsTgt || null, name: r.closest('.ds-dep-row').querySelector('.ds-dep-key').textContent.trim() }; })()`);
  h.log('CHANGED row:', JSON.stringify(chg));
  if (!chg) { h.log('no Changed row — the overwrite path is not exercised'); return; }
  const before = cli(h, chg.name);
  await h.eval(`document.querySelector('[data-dep-vals="${chg.id}"]').click()`);
  await h.waitFor("!!document.querySelector('#dsVeSave')", 30000, 300); await h.sleep(1600);
  h.log('CHANGED dialog columns:', await h.eval(`[...document.querySelectorAll('.ds-ve-table thead th')].map(t => t.textContent.trim()).join(' | ')`));
  await h.shot(h.shots + '/ve-3-changed.png');
  await h.eval(`(() => { const i = document.querySelector('input[data-ve-field="Description"]'); i.value = ${JSON.stringify(TYPED + ' (update)')}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.eval(`document.querySelector('#dsVeSave').click()`); await h.sleep(1200);
  await h.eval(`(() => { const b = document.querySelector('[data-dep-dir="overwrite"][data-dep-id="${chg.id}"]'); b.click(); return true; })()`); await h.sleep(500);
  h.log('SUMMARY:', await dump(h, '#dsDepSummary', 300));
  const hist2 = await h.eval('_history.length');
  await h.click('#dsRecRunBtn'); await h.sleep(2500);
  for (let i = 0; i < 4; i++) {
    const m = await h.modalText(500); if (!m) break;
    h.log('MODAL:', m.slice(0, 200));
    await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } const b = document.querySelector('#sftkConfirmGo') || [...document.querySelectorAll('#dsModalBox button')].find(b => /proceed|deploy|confirm|ok/i.test(b.textContent) && !b.disabled); if (b) b.click(); return !!b; })()`);
    await h.sleep(2000);
  }
  for (let i = 0; i < 300; i++) { if (await h.eval(`_history.length > ${hist2}`)) break; await h.sleep(1000); }
  await h.sleep(4000);
  h.log('HISTORY newest (✏):', await h.eval(`JSON.stringify((_history[0] && (_history[0].warnings || _history[0].diagnostics || [])).filter(x => /typed/.test(String(x))))`));
  await waitScanned(h); await h.sleep(1500);
  const after2 = cli(h, chg.name);
  h.log('TYPED VALUE LANDED (update):', !!(after2 && after2.some(x => x.includes(TYPED + ' (update)'))), '| before:', JSON.stringify(before));
  process.env.SKIP_RUN = '1';
  await retryAndRollback(h);
  h.log('──────── rolled back ────────');
  cli(h, chg.name);

}
