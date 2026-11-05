// Live, read-only: the ▸ record dialog shows the values that are WRITTEN, in the
// boxes (2026-11-05, a colleague's first day: "when I click a record I see an
// empty record; I want to see every value of the record that will be created,
// change any field, and have it remembered if I close the screen by mistake").
// One Insert row: the boxes hold the source's values; a typed Description is
// saved with no Save button (as you type); typing the source's value back
// clears it; ∅ writes empty; Close and open again → still there; the bulk
// dialog keeps its Save. Nothing is deployed.
const NL = String.fromCharCode(10);
const dump = async (h, sel, n = 1500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);
const waitDialog = async h => { await h.waitFor("document.querySelector('#dsModal')?.style.display !== 'none' && document.querySelector('#dsValEdHost') !== window.__sftkOldHost && document.querySelectorAll('#dsValEdHost tr[data-ve-row]').length > 0", 30000, 300); await h.eval('window.__sftkOldHost = document.querySelector("#dsValEdHost"); true'); await h.sleep(1500); };
const stored = (h, id) => h.eval(`JSON.stringify(sftkValOvGet(_reconcileProfile.tree, _reconcileProfile.targetOrg, ${JSON.stringify(id)}))`);
const box = (h, f) => h.eval(`(() => { const i = document.querySelector('input[data-ve-field=${JSON.stringify(f)}]'); return i ? { value: i.value, src: i.dataset.veSrc, on: i.closest('tr').classList.contains('ds-ve-row-on'), err: i.closest('tr').querySelector('.ds-ve-err').textContent } : null; })()`);
const type = (h, f, v) => h.eval(`(() => { const i = document.querySelector('input[data-ve-field=${JSON.stringify(f)}]'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK CX — Accounts tree';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (!id) throw new Error('fixture profile missing');
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await waitScanned(h); await h.sleep(2000);
  await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="ins"]')?.click()`); await h.sleep(1000);
  const row = await h.eval(`(() => { const r = [...document.querySelectorAll('#dsDepList .ds-dep-row')].find(x => !/Duplicate Name/.test(x.innerText) && x.querySelector('[data-dep-vals]')); if (!r) return null; return { id: r.querySelector('[data-dep-vals]').dataset.depVals, name: r.querySelector('.ds-dep-key').textContent.trim() }; })()`);
  h.log('row:', JSON.stringify(row));
  if (!row) throw new Error('no Insert row with a ▸ record button');
  await h.eval(`sftkValOvClear(_reconcileProfile.tree, _reconcileProfile.targetOrg, ${JSON.stringify(row.id)}); storageSaveProfiles()`);   // a clean start

  await h.eval(`document.querySelector('[data-dep-vals="${row.id}"]').click()`);
  await waitDialog(h);
  h.log('DIALOG head:', await h.modalText(500));
  h.log('read error line:', await dump(h, '#dsVeReadErr', 300) || '(none)');
  const filled = await h.eval(`[...document.querySelectorAll('input.ds-ve-in')].filter(i => i.value.trim() !== '').length`);
  const total = await h.eval(`document.querySelectorAll('input.ds-ve-in').length`);
  h.log(`boxes with a value: ${filled} of ${total}`, '| first rows:', await h.eval(`[...document.querySelectorAll('tr[data-ve-row]')].slice(0, 4).map(tr => tr.querySelector('th').firstChild.textContent.trim() + ' = ' + (tr.querySelector('input.ds-ve-in')?.value ?? '(lookup)')).join(' | ')`));
  h.log('Save button present:', await h.eval(`!!document.querySelector('#dsVeSave')`), '| footer:', await dump(h, '.ds-ve-foot', 300));
  await h.shot(h.shots + '/vp-1-dialog.png');
  await h.eval(`(() => { document.documentElement.classList.add('ds-dark'); return true; })()`); await h.sleep(400);
  await h.shot(h.shots + '/vp-1-dialog-dark.png');
  await h.eval(`(() => { document.documentElement.classList.remove('ds-dark'); return true; })()`);

  h.log('── type a Description: saved as you type, no button ──');
  h.log('before:', JSON.stringify(await box(h, 'Description')), '| stored:', await stored(h, row.id));
  await type(h, 'Description', 'typed on the Deploy page 2026-11-05');
  await h.sleep(900);
  h.log('after 0.9s:', JSON.stringify(await box(h, 'Description')), '| stored:', await stored(h, row.id), '| status:', await dump(h, '#dsVeStatus', 100));
  h.log('── a bad number: said on the row, not stored ──');
  await type(h, 'NumberOfEmployees', 'many');
  await h.sleep(900);
  h.log('bad:', JSON.stringify(await box(h, 'NumberOfEmployees')), '| stored:', await stored(h, row.id));
  await type(h, 'NumberOfEmployees', '');
  await h.sleep(900);
  h.log('cleared a source value → written empty?', JSON.stringify(await box(h, 'NumberOfEmployees')), '| stored:', await stored(h, row.id));
  h.log('── ✕ back to the source on that row ──');
  await h.eval(`document.querySelector('[data-ve-clear="NumberOfEmployees"]').click()`); await h.sleep(700);
  h.log('after ✕:', JSON.stringify(await box(h, 'NumberOfEmployees')), '| stored:', await stored(h, row.id));
  h.log('── ∅ on Industry ──');
  await h.eval(`document.querySelector('[data-ve-null="Industry"]').click()`); await h.sleep(700);
  h.log('after ∅:', JSON.stringify(await box(h, 'Industry')), '| stored:', await stored(h, row.id));
  await h.eval(`document.querySelector('#dsVeOnly').click()`); await h.sleep(300);
  h.log('only my changed values →', await h.eval(`[...document.querySelectorAll('tr[data-ve-row]')].filter(tr => tr.style.display !== 'none').map(tr => tr.dataset.veRow).join(', ')`));
  await h.shot(h.shots + '/vp-2-changed.png');

  h.log('── type fast and Close at once: the flush ──');
  await type(h, 'Website', 'https://flushed.example.com');
  await h.eval(`[...document.querySelectorAll('#dsModalBox [data-dsaction="closeModal"]')].pop().click()`); await h.sleep(800);
  h.log('modal open:', await h.eval(`document.querySelector('#dsModal')?.style.display !== 'none'`), '| stored:', await stored(h, row.id), '| badge:', await h.eval(`document.querySelector('[data-dep-vals="${row.id}"]')?.textContent.trim()`));
  h.log('persisted on the profile:', await h.eval(`JSON.stringify(Object.keys((_profiles.find(p => p.id === ${JSON.stringify(id)}).tree.valueOverrides) || {}))`));

  h.log('── open again: the changed values are the boxes ──');
  await h.eval(`document.querySelector('[data-dep-vals="${row.id}"]').click()`);
  await waitDialog(h);
  h.log('Description:', JSON.stringify(await box(h, 'Description')), '| Website:', JSON.stringify(await box(h, 'Website')), '| Industry:', JSON.stringify(await box(h, 'Industry')), '| footer:', await dump(h, '.ds-ve-foot', 200));
  h.log('── ✕ Back to the source on every field ──');
  await h.eval(`document.querySelector('#dsVeClearAll').click()`); await h.sleep(900);
  h.log('modal open:', await h.eval(`document.querySelector('#dsModal')?.style.display !== 'none'`), '| Description:', JSON.stringify(await box(h, 'Description')), '| stored:', await stored(h, row.id));
  await h.closeModal();

  h.log('── many: the bulk dialog keeps its Save ──');
  await h.eval(`(() => { const cbs = [...document.querySelectorAll('#dsDepList [data-dep-push]')].slice(0, 2); cbs.forEach(cb => { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }); return cbs.length; })()`);
  await h.eval(`document.querySelector('[data-dep-vals-many]').click()`);
  await waitDialog(h);
  h.log('MANY head:', await h.modalText(200), '| Save present:', await h.eval(`!!document.querySelector('#dsVeSave')`), '| empty boxes:', await h.eval(`[...document.querySelectorAll('input.ds-ve-in')].every(i => i.value === '')`));
  await h.closeModal();
  await h.eval(`(() => { [...document.querySelectorAll('#dsDepList [data-dep-push]:checked')].forEach(cb => { cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); }); return true; })()`);
}
