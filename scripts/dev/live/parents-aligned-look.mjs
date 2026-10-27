// Live, read-only: the "Parents synced ✓" card opens into the aligned parent
// records and the key they are aligned by (user 2026-10-27: "when parents are
// synced. please make a view of the aligned parents and by what key they are
// aligned"). The Accounts tree fixture looks up Individual outside itself.
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
  h.log('verify by hand:', await h.eval(`(async () => { const p = _reconcileProfile; const eph = { id: 'chk_x', name: 'x', sourceOrg: p.sourceOrg, targetOrg: p.targetOrg, ephemeral: true, scanConfig: { matchField: 'Name', compareFields: [] }, tree: { objectType: 'Individual', where: '', children: [] } }; const r = await runDiffScan(eph); return JSON.stringify({ error: r && r.error, status: r && r.status, same: (r.identical || []).length, chg: (r.changed || []).length, miss: (r.missingInTarget || []).length }); })()`));
  h.log('verdicts:', (await h.eval(`JSON.stringify(_parentSyncVerdicts)`)).slice(0, 600));
  h.log('last verify error:', await h.eval(`_parentVerifyLastError`));
  h.log('verifyOne by hand:', await h.eval(`sftkParentVerifyOne(_reconcileProfile, 'Individual', 'Name')`), '| error:', await h.eval(`_parentVerifyLastError`), '| verdict:', (await h.eval(`JSON.stringify(_parentSyncVerdicts[Object.keys(_parentSyncVerdicts).find(k => /Individual/.test(k))] || null)`)).slice(0, 300));
  // the parents card settles after its background check
  await h.waitFor("(!!document.querySelector('.ds-dep-parents-synced') || !!document.querySelector('[data-dep-gap]')) && !/checking alignment/.test(document.querySelector('#dsDepOrder')?.innerText || '')", 240000, 1000);
  await h.sleep(1500);
  h.log('CARD:', await dump(h, '#dsDepOrder', 900));
  h.log('last verify error after the card:', await h.eval(`_parentVerifyLastError`));
  await h.eval(`(() => { const d = document.querySelector('#dsDepOrder details'); if (d) d.open = true; d?.scrollIntoView({ block: 'start' }); return true; })()`); await h.sleep(400);
  const btn = await h.eval(`!!document.querySelector('[data-dep-pairs]')`);
  h.log('pairs button:', btn);
  if (btn) {
    await h.eval(`document.querySelector('[data-dep-pairs]').click()`); await h.sleep(1500);
    h.log('PAIRS:', await dump(h, '.ds-dep-pairs', 1200));
  }
  await h.shot(h.shots + '/parents-1-aligned.png');
  await h.eval(`(() => { document.documentElement.classList.add('ds-dark'); return true; })()`); await h.sleep(400);
  await h.shot(h.shots + '/parents-2-aligned-dark.png');
}
