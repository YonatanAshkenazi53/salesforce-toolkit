// Live, read-only: Data Studio › History with its cards' action groups (user
// 2026-10-27: "make sure the history page is understandable and intuitive to use
// with action groups"). Entries of every kind are seeded into the throwaway
// profile's history (local storage only), then the page is screenshotted,
// light and dark.
export default async function (h) {
  await h.login('npc'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const seeded = await h.eval(`(async () => {
    const d = (hh, m) => new Date(Date.now() - hh * 3600000 - m * 60000).toISOString();
    const S = 'https://trailheads5.my.salesforce.com', T = 'https://orgfarm-e2c4511b2b-dev-ed.develop.my.salesforce.com';
    const pid = (_profiles.find(p => p.name === 'SFTK CX — Accounts tree') || {}).id || 'x';
    _history.push(
      { id: 'look_r1', kind: 'reconcile', profileName: 'SFTK CX — Accounts tree', profileId: pid, startedAt: d(2, 0), completedAt: d(1, 58), status: 'partial', sourceOrg: S, targetOrg: T,
        summary: { Account: { inserted: 5, insertedFailed: 2, failedSourceIds: ['001A', '001B'] }, Contact: { inserted: 12 } }, errors: ['Account: SFTK CX fixture: Retail accounts need a Website in this org.'], snapshot: { ok: true } },
      { id: 'look_r2', kind: 'rollback', profileName: '↩ Rollback of SFTK CX — Accounts tree', profileId: pid, startedAt: d(1, 30), completedAt: d(1, 29), status: 'success', sourceOrg: S, targetOrg: T, rollbackOf: 'look_r1',
        summary: { Account: { deleted: 5 }, Contact: { deleted: 12 } }, errors: [] },
      { id: 'look_t1', kind: 'tool', tool: 'Merge', profileName: '🔀 Account "SFTK CX Duplicate Name": one copy merged into 001xx', startedAt: d(0, 40), completedAt: d(0, 39), status: 'success', sourceOrg: S, targetOrg: S,
        what: [{ describe: 'merge', ok: true, accepted: true, verified: true, text: 'Database.merge: 1 copy merged; verified by re-reading the org' }], errors: [], toolUndo: { none: 'a merge cannot be undone by the Toolkit — the copies are in the Recycle Bin' } },
    );
    await storageSaveHistory();
    return _history.length;
  })()`);
  h.log('seeded:', seeded);
  await h.eval(`navigateToView('history')`); await h.sleep(1500);
  h.log('PAGE:', (await h.text('#dsMain')).slice(0, 1500).replace(/\\n+/g, ' | '));
  await h.shot(h.shots + '/history-1.png');
  await h.eval(`(() => { document.documentElement.classList.add('ds-dark'); return true; })()`); await h.sleep(400);
  await h.shot(h.shots + '/history-2-dark.png');
}
