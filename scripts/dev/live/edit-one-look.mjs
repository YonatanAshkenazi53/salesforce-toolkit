// Live, read-only: the ONE editor of a record on the Deploy page (user 2026-10-31: "values and
// lookups can become one view … like one tab"). The Accounts-tree deployment is scanned, the
// Insert tab opened, and ✏ edit pressed on two records: one whose parent lookup lands on a
// target record, one whose parent is not there (lands empty). Nothing is typed or saved.
const NL = String.fromCharCode(10);
const dump = async (h, sel, n = 1800) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);

export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const id = await h.eval(`_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id`);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await waitScanned(h); await h.sleep(1500);
  await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="ins"]')?.click() || document.querySelector('[data-dep-tab="ins"]')?.click()`); await h.sleep(1000);
  h.log('ROW LINKS:', await h.eval(`[...document.querySelectorAll('#dsDepList .ds-dep-link')].map(b => b.textContent.trim()).slice(0, 8).join(' | ')`), '| lookups links left:', await h.eval(`document.querySelectorAll('[data-dep-lkp]').length`));
  h.log('ROWS:', await dump(h, '#dsDepList', 900));
  const names = await h.eval(`[...document.querySelectorAll('#dsDepList [data-dep-vals]')].map(b => b.closest('.ds-rec-row, tr, li, div')?.textContent.trim().slice(0, 40))`);
  h.log('editable rows:', JSON.stringify(names).slice(0, 400));
  // first record: ✏ edit
  await h.eval(`document.querySelector('#dsDepList [data-dep-vals]')?.click()`);
  await h.waitFor("!!document.querySelector('#dsVeFilter')", 60000, 300); await h.sleep(2500);
  h.log('EDITOR 1:', await h.modalText(1800));
  h.log('landing lines:', await h.eval(`[...document.querySelectorAll('[data-ve-land]')].map(e => e.textContent.trim()).join(' || ')`));
  // pick a record for the lookup (saved on the throwaway profile only), then take it back
  await h.eval(`(() => { const i = document.querySelector('.ds-ve-lkp-in'); i.value = 'SFTK CX'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await h.waitFor("!!document.querySelector('.ds-ve-lkp-res [data-ve-hit]')", 30000, 200); await h.sleep(300);
  h.log('search hits:', await h.eval(`[...document.querySelectorAll('.ds-ve-lkp-res [data-ve-hit]')].map(b => b.textContent).join(' | ')`));
  await h.eval(`document.querySelector('.ds-ve-lkp-res [data-ve-hit]')?.click()`); await h.sleep(900);
  h.log('after pick — box:', await h.eval(`document.querySelector('.ds-ve-lkp-in')?.value`), '| under it:', await h.eval(`document.querySelector('.ds-ve-lkp-cur')?.textContent.trim()`), '| landing shown:', await h.eval(`document.querySelector('[data-ve-land]')?.style.display !== 'none'`));
  await h.shot(h.shots + '/edit-one-1.png');
  await h.eval(`document.querySelector('[data-ve-lkp-clear]')?.click()`); await h.sleep(700);
  h.log('after clear — box:', JSON.stringify(await h.eval(`document.querySelector('.ds-ve-lkp-in')?.value`)), '| under it:', await h.eval(`document.querySelector('.ds-ve-lkp-cur')?.textContent.trim()`), '| landing shown:', await h.eval(`document.querySelector('[data-ve-land]')?.style.display !== 'none'`));
  await h.eval(`document.querySelector('.ds-ve-lkp-res [data-ve-hit]')?.click()`); await h.sleep(700);   // picked again for the dark shot
  await h.eval(`(() => { document.documentElement.classList.add('ds-dark'); return true; })()`); await h.sleep(1200);   // past the theme transition — a 300 ms shot caught blank buttons
  await h.shot(h.shots + '/edit-one-2-dark.png');
  await h.eval(`(() => { document.documentElement.classList.remove('ds-dark'); return true; })()`);
  await h.closeModal(); await h.sleep(400);
  // a record deeper in the tree, whose parent is not in the target
  const n = await h.eval(`document.querySelectorAll('#dsDepList [data-dep-vals]').length`);
  if (n > 1) {
    await h.eval(`[...document.querySelectorAll('#dsDepList [data-dep-vals]')].slice(-1)[0].click()`);
    await h.waitFor("!!document.querySelector('#dsVeFilter')", 60000, 300); await h.sleep(2500);
    h.log('EDITOR last:', (await h.modalText(600)));
    h.log('landing lines:', await h.eval(`[...document.querySelectorAll('[data-ve-land]')].map(e => e.textContent.trim()).join(' || ')`));
    await h.shot(h.shots + '/edit-one-3-last.png');
    await h.closeModal();
  }
}
