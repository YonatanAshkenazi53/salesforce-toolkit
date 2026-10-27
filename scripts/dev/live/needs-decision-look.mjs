// Live, read-only: a LOOK at ⚠ Needs a decision and the merge dialog, for the
// 2026-10-27 iteration ("show the dupes in both orgs and offer to merge them…
// the merge experience and matching should be intuitive"). Screenshots only:
// the group as drawn, then the source-side merge dialog, cancelled.
//
// Fixture: "SFTK CX Duplicate Name" — trailheads5 holds it twice (Haifa,
// Eilat), the target once (docs/fixtures/complex-deployment).
const NL = String.fromCharCode(10);
const dump = async (h, sel, n = 1800) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);

export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK CX — Accounts tree';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (!id) throw new Error('fixture profile missing');
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await waitScanned(h); await h.sleep(2000);
  await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="amb"]')?.click() || document.querySelector('[data-dep-tab="amb"]')?.click()`);
  await h.sleep(1200);
  h.log('TOOLBAR:', await dump(h, '.ds-dep-tools', 400));
  h.log('GROUP:', await dump(h, '.ds-amb-group', 1500));
  await h.eval(`(() => { document.querySelector('.ds-dep-amb-intro')?.scrollIntoView({ block: 'start' }); return true; })()`); await h.sleep(300);
  await h.shot(h.shots + '/look-1-group.png');
  // the source-side merge dialog, read-only: it is cancelled
  await h.eval(`document.querySelector('[data-dep-amb-merge="src"]')?.click()`);
  await h.waitFor("!!document.querySelector('#dsMergeGo')", 30000, 300); await h.sleep(1600);
  h.log('MERGE DIALOG:', await h.modalText(1600));
  await h.shot(h.shots + '/look-2-merge.png');
  await h.eval(`document.querySelector('#dsMergeCancel')?.click()`); await h.sleep(500);
  h.log('after cancel, modal open:', await h.eval(`!!document.querySelector('#dsModalBox')?.offsetParent`));
  // 🔀 Merge all: the walk opens the first picker with its place in the walk; Cancel stops it — read-only
  await h.eval(`document.querySelector('[data-dep-amb-mergeall]')?.click()`);
  await h.waitFor("!!document.querySelector('#dsMergeGo')", 30000, 300); await h.sleep(400);
  h.log('MERGE ALL — first dialog title:', (await h.modalText(200)).split(' | ').slice(0, 2).join(' | '));
  await h.eval(`document.querySelector('#dsMergeCancel')?.click()`); await h.sleep(800);
  // the same group in dark mode (the user works in it)
  await h.eval(`(() => { document.documentElement.classList.add('ds-dark'); document.querySelector('.ds-dep-amb-intro')?.scrollIntoView({ block: 'start' }); return true; })()`); await h.sleep(500);
  await h.shot(h.shots + '/look-3-group-dark.png');
  await h.eval(`(() => { document.documentElement.classList.remove('ds-dark'); return true; })()`);
  h.log('after cancel — toast:', await h.eval(`[...document.querySelectorAll('.ds-toast, [class*="toast"]')].map(t => t.innerText.trim()).filter(Boolean).slice(-1).join(' | ').slice(0, 200)`));
}
