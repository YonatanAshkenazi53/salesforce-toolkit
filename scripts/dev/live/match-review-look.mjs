// Live: 🔗 Pair records by hand (Match review, redrawn 2026-10-31). The Accounts tree is scanned,
// the dialog opened and screenshotted light and dark; a source record is picked, the ranked
// candidates read; one pair is made and taken back again (the pair lives in the throwaway
// profile's memory only — nothing is written to Salesforce). Also: ⚠ Needs a decision with its
// per-copy question folded behind the merge.
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
  // Needs a decision: the question is folded when a side has copies
  await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="amb"]')?.click() || document.querySelector('[data-dep-tab="amb"]')?.click()`); await h.sleep(1000);
  h.log('AMB fold present:', await h.eval(`!!document.querySelector('.ds-amb-match-fold')`), '| open:', await h.eval(`document.querySelector('.ds-amb-match-fold')?.open`), '| summary:', await dump(h, '.ds-amb-match-fold > summary', 200));
  await h.eval(`(() => { document.querySelector('.ds-amb-group')?.scrollIntoView({ block: 'start' }); return true; })()`); await h.sleep(300);
  await h.shot(h.shots + '/mr-0-amb-folded.png');
  // the dialog
  await h.eval(`document.querySelector('#dsDepMatchReview')?.click()`);
  await h.waitFor("!!document.querySelector('.ds-mm-grid')", 30000, 300); await h.sleep(800);
  h.log('DIALOG:', await h.modalText(2200));
  h.log('candidates for the first record:', await h.eval(`[...document.querySelectorAll('.ds-mm-cand')].map(c => c.querySelector('.ds-mm-sim b').textContent + ' ' + c.querySelector('.ds-mm-word').textContent + ' → ' + c.querySelector('.ds-mm-name').textContent.trim()).join(' | ')`));
  await h.shot(h.shots + '/mr-1-light.png');
  await h.eval(`(() => { document.documentElement.classList.add('ds-dark'); return true; })()`); await h.sleep(1200);
  await h.shot(h.shots + '/mr-2-dark.png');
  // pick "SFTK CX Europe GmbH" on the left, see the ranking
  await h.eval(`(() => { const el = [...document.querySelectorAll('[data-mm-src]')].find(e => /Europe/.test(e.textContent)); el?.click(); return !!el; })()`); await h.sleep(500);
  h.log('candidates for Europe GmbH:', await h.eval(`[...document.querySelectorAll('.ds-mm-cand')].map(c => c.querySelector('.ds-mm-sim b').textContent + ' ' + c.querySelector('.ds-mm-word').textContent + ' → ' + c.querySelector('.ds-mm-name').textContent.trim()).join(' | ')`));
  h.log('why (first):', await h.eval(`document.querySelector('.ds-mm-sim')?.title`));
  // pair the first candidate, then take it back
  const before = await h.eval(`document.querySelectorAll('[data-mm-src]').length`);
  await h.eval(`document.querySelector('[data-mm-pair]')?.click()`); await h.sleep(1200);
  h.log('after pair — source rows:', await h.eval(`document.querySelectorAll('[data-mm-src]').length`), 'was', before, '| made:', await dump(h, '.ds-mm-made', 300), '| memory:', await dump(h, '.ds-mm-foot .ds-dep-muted', 120));
  await h.shot(h.shots + '/mr-3-paired-dark.png');
  await h.eval(`document.querySelector('[data-mm-unpair]')?.click()`); await h.sleep(1200);
  h.log('after unpair — source rows:', await h.eval(`document.querySelectorAll('[data-mm-src]').length`), '| made present:', await h.eval(`!!document.querySelector('.ds-mm-made')`), '| memory:', await dump(h, '.ds-mm-foot .ds-dep-muted', 120));
  await h.eval(`document.querySelector('#dsMmClose')?.click()`); await h.sleep(500);
  await h.eval(`(() => { document.documentElement.classList.remove('ds-dark'); return true; })()`);
}
