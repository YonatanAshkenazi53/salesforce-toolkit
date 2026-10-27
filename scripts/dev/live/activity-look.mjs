// Live, read-only: 🧾 Activity from both top bars (user 2026-10-27). The
// throwaway profile has no history, so a few entries of every kind are put into
// the shared history first (local storage only — nothing touches Salesforce);
// then the dialog is opened in Data Studio and in the Toolkit and screenshotted.
export default async function (h) {
  await h.login('npc'); await h.studio(''); await h.watchErrors();
  const seeded = await h.eval(`(async () => {
    const d = (h, m) => new Date(Date.now() - h * 3600000 - m * 60000).toISOString();
    const S = 'https://trailheads5.my.salesforce.com', T = 'https://orgfarm-e2c4511b2b-dev-ed.develop.my.salesforce.com';
    _history.push(
      { id: 'feed_r1', kind: 'reconcile', profileName: 'SFTK CX — Accounts tree', profileId: 'x', startedAt: d(1, 20), completedAt: d(1, 19), status: 'success', sourceOrg: S, targetOrg: T, summary: { Account: { inserted: 3 } }, errors: [] },
      { id: 'feed_r2', kind: 'rollback', profileName: '↩ Rollback of SFTK CX — Accounts tree', profileId: 'x', startedAt: d(1, 5), completedAt: d(1, 4), status: 'success', sourceOrg: S, targetOrg: T, summary: { Account: { deleted: 3 } }, errors: [] },
      { id: 'feed_t1', kind: 'tool', tool: 'Field Cleaner', profileName: '📦 Values — Account.Old__c → New__c (12 records)', startedAt: d(26, 0), completedAt: d(26, 0), status: 'success', sourceOrg: S, targetOrg: S, what: [{ describe: 'values', ok: true, accepted: true, verified: true, text: '12 records updated' }], errors: [], toolUndo: null },
      { id: 'feed_t2', kind: 'tool', tool: 'Flow switches', profileName: '⏻ Flow — Lead Router (off)', startedAt: d(25, 30), completedAt: d(25, 30), status: 'success', sourceOrg: S, targetOrg: S, what: [{ describe: 'switch', ok: true, accepted: true, verified: true, text: 'Lead Router off' }], errors: [], toolUndo: null },
      { id: 'feed_t3', kind: 'tool', tool: 'Merge', profileName: '🔀 Account "SFTK CX Duplicate Name": one copy merged into 001…', startedAt: d(0, 30), completedAt: d(0, 29), status: 'success', sourceOrg: S, targetOrg: S, what: [{ describe: 'merge', ok: true, accepted: true, verified: true, text: 'merged' }], errors: [], toolUndo: { none: 'a merge cannot be undone' } },
    );
    await storageSaveHistory();
    return _history.length;
  })()`);
  h.log('seeded entries:', seeded);
  await h.click('#sftkFeedBtn'); await h.sleep(1500);
  h.log('STUDIO FEED:', (await h.modalText(1500)));
  await h.shot(h.shots + '/feed-1-studio.png');
  await h.eval(`(() => { document.documentElement.classList.add('ds-dark'); return true; })()`); await h.sleep(400);
  await h.shot(h.shots + '/feed-2-studio-dark.png');
  await h.closeModal();
  // the Toolkit
  await h.popup('flows'); await h.sleep(1500);
  await h.click('#sftkFeedBtn'); await h.sleep(1500);
  h.log('POPUP FEED:', (await h.eval(`(document.querySelector('#modalBox')?.innerText || '').slice(0, 1200).replace(/\\n+/g, ' | ')`)));
  await h.shot(h.shots + '/feed-3-popup.png');
}
