export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio('');
  await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const id = await h.eval(`_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id`);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.click('#dsDepScan');
  await h.waitFor("!!document.querySelector('.ds-dep-plan')", 120000, 1000); await h.sleep(1500);
  // Opportunity first (parent of OCR), then OCR directly through the function, catching its outcome
  for (const pk of ['1', '1.1']) {
    const r = await h.eval(`(async () => { try { const r = await scanReconcileChild(_reconcileProfile, ${JSON.stringify(pk)}); return JSON.stringify({ ok: !r?.error, error: r?.error, keys: r ? Object.keys(r).slice(0, 12) : null, miss: r?.missingInTarget?.length, chg: r?.changed?.length, ident: r?.identical?.length, warnings: r?.warnings }); } catch (e) { return 'THROWN: ' + (e && (e.stack || e.message || e)); } })()`);
    h.log(`scanReconcileChild(${pk}):`, String(r).slice(0, 1200));
  }
  h.log('exceptions seen:', h.exceptions.length);
}
