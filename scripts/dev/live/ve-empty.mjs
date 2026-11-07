// Read-only: open ▸ record on the first Insert row of the Accounts-tree fixture deployment and look at the
// source-empty rows (∅ by default), type into one, clear it, screenshot light + dark. No deploy.
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const id = await h.eval(`_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id`);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000); await h.sleep(2000);
  await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="ins"]')?.click()`); await h.sleep(1000);
  const rid = await h.eval(`(() => { const r = [...document.querySelectorAll('#dsDepList .ds-dep-row')].find(x => !/Duplicate Name/.test(x.innerText) && x.querySelector('[data-dep-vals]')); return r ? r.querySelector('[data-dep-vals]').dataset.depVals : null; })()`);
  await h.eval(`document.querySelector('[data-dep-vals="${rid}"]').click()`);
  await h.waitFor("!!document.querySelector('#dsValEdHost tr[data-ve-row]')", 60000, 500); await h.sleep(800);
  h.log('sel note card on page:', await h.eval(`!!document.querySelector('#dsDepSelNote')`));
  const rows = await h.eval(`[...document.querySelectorAll('#dsValEdHost tr[data-ve-row]')].map(tr => ({ f: tr.dataset.veRow, cls: tr.className, ph: tr.querySelector('.ds-ve-in')?.placeholder, nullBtn: tr.querySelector('.ds-ve-null')?.className, title: tr.querySelector('.ds-ve-null')?.title }))`);
  const empties = rows.filter(r => r.cls.includes('ds-ve-empty-dfl'));
  h.log(`rows: ${rows.length} | marked ∅ by default: ${empties.length} | first: ${JSON.stringify(empties[0])}`);
  h.log('a filled row:', JSON.stringify(rows.find(r => !r.cls.includes('ds-ve-empty-dfl') && r.ph !== undefined)));
  const f = empties[0].f;
  await h.eval(`document.querySelector('#dsValEdHost tr[data-ve-row="${f}"]').scrollIntoView({ block: 'start' })`); await h.sleep(400);
  await h.shot(h.shots + '/ve-empty-1.png');
  // ∅ on a marked row: the cursor lands in the box, nothing is set
  await h.eval(`document.querySelector('#dsValEdHost tr[data-ve-row="${f}"] .ds-ve-null').click()`); await h.sleep(300);
  h.log('after ∅ click: focused =', await h.eval(`document.activeElement?.dataset?.veField`), '| classes =', await h.eval(`document.querySelector('#dsValEdHost tr[data-ve-row="${f}"]').className`));
  // type a value: the mark lifts, the row is "on"
  await h.eval(`(() => { const i = document.querySelector('#dsValEdHost tr[data-ve-row="${f}"] .ds-ve-in'); i.value = 'typed 2026-11-07'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await h.sleep(900);
  h.log('typed: classes =', await h.eval(`document.querySelector('#dsValEdHost tr[data-ve-row="${f}"]').className`), '| ∅ =', await h.eval(`document.querySelector('#dsValEdHost tr[data-ve-row="${f}"] .ds-ve-null').className`));
  await h.shot(h.shots + '/ve-empty-2-typed.png');
  // clear it: the mark is back, the stored value is gone
  await h.eval(`(() => { const i = document.querySelector('#dsValEdHost tr[data-ve-row="${f}"] .ds-ve-in'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await h.sleep(900);
  h.log('cleared: classes =', await h.eval(`document.querySelector('#dsValEdHost tr[data-ve-row="${f}"]').className`), '| ph =', await h.eval(`document.querySelector('#dsValEdHost tr[data-ve-row="${f}"] .ds-ve-in').placeholder`), '| stored =', JSON.stringify(await h.eval(`sftkValOvGet(_reconcileProfile.tree, _reconcileProfile.targetOrg, '${rid}')`)));
  await h.eval("document.querySelector('#dsDarkToggle, #sftkDarkToggle, [data-dsaction=\"toggleDark\"]')?.click()"); await h.sleep(1500);
  await h.shot(h.shots + '/ve-empty-3-dark.png');
}
