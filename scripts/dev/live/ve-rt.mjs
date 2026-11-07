// Read-only on the orgs: ▸ record on the Accounts-tree fixture — the Record Type row (source's type, the target's picks),
// a pick stored and cleared, and the "not readable" column note. No deploy.
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const id = await h.eval(`_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id`);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000); await h.sleep(2000);
  await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="ins"]')?.click()`); await h.sleep(1000);
  const rid = await h.eval(`(() => { const r = [...document.querySelectorAll('#dsDepList .ds-dep-row')].find(x => /Americas/.test(x.innerText) && x.querySelector('[data-dep-vals]')); return r ? r.querySelector('[data-dep-vals]').dataset.depVals : null; })()`);
  h.log('Americas row id:', rid);
  await h.eval(`document.querySelector('[data-dep-vals="${rid}"]').click()`);
  await h.waitFor("!!document.querySelector('#dsValEdHost tr[data-ve-row]')", 60000, 500); await h.sleep(800);
  const rt = await h.eval(`(() => { const tr = document.querySelector('#dsValEdHost tr[data-ve-row="RecordTypeId"]'); if (!tr) return null; const sel = tr.querySelector('[data-ve-rt]'); return { first: tr === tr.parentElement.firstElementChild, src: tr.querySelector('.ds-ve-src')?.innerText, options: [...sel.options].map(o => o.textContent), value: sel.value, on: tr.classList.contains('ds-ve-row-on') }; })()`);
  h.log('RT row:', JSON.stringify(rt));
  h.log('unreadable note:', await h.eval(`[...document.querySelectorAll('#dsValEdHost .ds-ve-note')].map(n => n.innerText).find(t => /could not be read/.test(t)) || '(none)'`));
  h.log('rows saying not readable:', JSON.stringify(await h.eval(`[...document.querySelectorAll('#dsValEdHost tr[data-ve-row]')].filter(tr => /not readable/.test(tr.querySelector('.ds-ve-src')?.innerText || '')).map(tr => tr.dataset.veRow)`)));
  await h.shot(h.shots + '/ve-rt-1.png');
  // pick B
  await h.eval(`(() => { const sel = document.querySelector('#dsValEdHost [data-ve-rt]'); const o = [...sel.options].find(o => /RT_B/.test(o.textContent)); sel.value = o.value; sel.dispatchEvent(new Event('change')); return true; })()`); await h.sleep(900);
  h.log('after pick: stored =', JSON.stringify(await h.eval(`sftkValOvGet(_reconcileProfile.tree, _reconcileProfile.targetOrg, '${rid}')`)), '| row on =', await h.eval(`document.querySelector('#dsValEdHost tr[data-ve-row="RecordTypeId"]').classList.contains('ds-ve-row-on')`), '| status =', await h.eval(`document.querySelector('#dsVeStatus')?.innerText`));
  await h.shot(h.shots + '/ve-rt-2-picked.png');
  // and back
  await h.eval(`document.querySelector('#dsValEdHost [data-ve-rt-clear]').click()`); await h.sleep(900);
  h.log('after ✕: stored =', JSON.stringify(await h.eval(`sftkValOvGet(_reconcileProfile.tree, _reconcileProfile.targetOrg, '${rid}')`)), '| select =', await h.eval(`document.querySelector('#dsValEdHost [data-ve-rt]').selectedOptions[0].textContent`));
  await h.eval("document.querySelector('#dsDarkToggle, #sftkDarkToggle, [data-dsaction=\"toggleDark\"]')?.click()"); await h.sleep(1500);
  await h.shot(h.shots + '/ve-rt-3-dark.png');
}
