// Live, read-only: the merge dialog with MANY copies (user 2026-10-30, twelve copies of
// "Sample Account for Entitlements": "not a good experience" / "you can't know who is the
// owner" / "its hard to understand a bit"). A throwaway deployment of the sample accounts
// is imported, the Deploy page scanned, ⚠ Needs a decision opened, the source-side merge
// dialog screenshotted light and dark — and CANCELLED. Then the two-copy fixture dialog.
const NL = String.fromCharCode(10);
const dump = async (h, sel, n = 1800) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);

async function openMerge(h, profileName, shotBase) {
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(profileName)})?.id`);
  if (!id) throw new Error(`profile missing: ${profileName}`);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await waitScanned(h); await h.sleep(2000);
  await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="amb"]')?.click() || document.querySelector('[data-dep-tab="amb"]')?.click()`);
  await h.sleep(1200);
  h.log('GROUP:', await dump(h, '.ds-amb-group', 600));
  await h.eval(`document.querySelector('[data-dep-amb-merge="src"]')?.click()`);
  await h.waitFor("!!document.querySelector('#dsMergeGo')", 60000, 300); await h.sleep(1800);
  h.log('MERGE DIALOG:', await h.modalText(2600));
  h.log('copies drawn:', await h.eval(`document.querySelectorAll('[data-merge-copy]').length`), '| field rows:', await h.eval(`document.querySelectorAll('.ds-merge-frow').length`), '| options in the first row:', await h.eval(`document.querySelector('.ds-merge-frow')?.querySelectorAll('.ds-merge-opt').length`));
  await h.shot(`${h.shots}/${shotBase}-light.png`);
  await h.eval(`(() => { document.documentElement.classList.add('ds-dark'); return true; })()`); await h.sleep(400);
  await h.shot(`${h.shots}/${shotBase}-dark.png`);
  // pick another copy: every field follows it
  await h.eval(`(() => { const r = document.querySelectorAll('input[name="dsMergeKeep"]')[1]; if (r) { r.click(); } return true; })()`); await h.sleep(300);
  h.log('after ticking copy 2 — kept rows:', await h.eval(`[...document.querySelectorAll('.ds-merge-copy.ds-merge-keep')].map(e => e.querySelector('.ds-merge-copy-lbl').textContent.trim()).join(', ')`), '| options marked as the survivor\'s:', await h.eval(`[...document.querySelectorAll('.ds-merge-opt-keep .ds-merge-optn')].map(e => e.textContent.trim()).join(' | ')`));
  await h.eval(`(() => { document.documentElement.classList.remove('ds-dark'); return true; })()`);
  await h.eval(`document.querySelector('#dsMergeCancel')?.click()`); await h.sleep(600);
  h.log('cancelled; modal open:', await h.eval(`!!document.querySelector('#dsModalBox')?.offsetParent`));
}

export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  await h.importProfiles('scripts/dev/live/merge-many-profile.json');
  await openMerge(h, 'LOOK — Many copies', 'merge-many');
  await h.eval(`navigateToView('profiles')`); await h.sleep(800);
  await openMerge(h, 'SFTK CX — Accounts tree', 'merge-two');
}
