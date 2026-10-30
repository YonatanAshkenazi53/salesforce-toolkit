// Live, read-only: the parents card WHILE its checks run (user 2026-10-30: "a loading bar for
// every one on the screen … it can look freezed to the end user"). The Accounts-tree
// deployment is opened and scanned; the card is caught mid-way — one row reading, the rest
// waiting — then again when all have settled. Light and dark.
const NL = String.fromCharCode(10);
const dump = async (h, sel, n = 1800) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');

export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const id = await h.eval(`_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id`);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  // the first row reading, the rest waiting behind it
  await h.waitFor("!!document.querySelector('.ds-dep-pbar-live')", 300000, 200);
  await h.eval(`(() => { const d = document.querySelector('[data-fold="parents"]'); if (d) d.open = true; d?.scrollIntoView({ block: 'start' }); return true; })()`); await h.sleep(250);
  h.log('MID-WAY chip:', await h.eval(`document.querySelector('#dsDepParentsChip')?.textContent`));
  h.log('MID-WAY rows:', await dump(h, '[data-fold="parents"]', 1400));
  h.log('live bars:', await h.eval(`document.querySelectorAll('.ds-dep-pbar-live').length`), '| waiting bars:', await h.eval(`document.querySelectorAll('.ds-dep-pbar:not(.ds-dep-pbar-live)').length`));
  await h.shot(h.shots + '/parents-loading-1.png');
  await h.eval(`(() => { document.documentElement.classList.add('ds-dark'); return true; })()`); await h.sleep(300);
  await h.shot(h.shots + '/parents-loading-2-dark.png');
  await h.eval(`(() => { document.documentElement.classList.remove('ds-dark'); return true; })()`);
  // settled
  await h.waitFor("!document.querySelector('.ds-dep-pbar')", 300000, 500); await h.sleep(600);
  h.log('SETTLED chip:', await h.eval(`document.querySelector('#dsDepParentsChip')?.textContent`));
  h.log('SETTLED rows:', await dump(h, '[data-fold="parents"]', 1400));
  await h.shot(h.shots + '/parents-loading-3-settled.png');
}
