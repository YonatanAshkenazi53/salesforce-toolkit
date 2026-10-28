// Live, read-only: 🧾 Activity from both top bars (user 2026-10-27), with the
// actions on every line (user 2026-10-28: "where is all the undo operations?" /
// "also we have an export feature"). The throwaway profile has no history, so
// entries of every kind are put into the shared history first (local storage
// only — nothing touches Salesforce); the dialog is opened in Data Studio and in
// the Toolkit and screenshotted, light and dark. Logs into the target only —
// the source trial expired on 2026-10-28.
export default async function (h) {
  await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const seeded = await h.eval(`(async () => {
    const d = (hh, m) => new Date(Date.now() - hh * 3600000 - m * 60000).toISOString();
    const S = 'https://trailheads5.my.salesforce.com', T = 'https://orgfarm-e2c4511b2b-dev-ed.develop.my.salesforce.com';
    const pid = (_profiles.find(p => p.name === 'SFTK CX — Accounts tree') || {}).id || 'x';
    _history.push(
      { id: 'feed_r1', kind: 'reconcile', profileName: 'SFTK CX — Accounts tree', profileId: pid, startedAt: d(2, 0), completedAt: d(1, 58), status: 'partial', sourceOrg: S, targetOrg: T,
        summary: { Account: { inserted: 5, insertedFailed: 2, failedSourceIds: ['001A', '001B'] }, Contact: { inserted: 12 } }, errors: ['Account: SFTK CX fixture: Retail accounts need a Website in this org.'], snapshot: { ok: true } },
      { id: 'feed_r2', kind: 'rollback', profileName: '↩ Rollback of SFTK CX — Accounts tree', profileId: pid, startedAt: d(1, 30), completedAt: d(1, 29), status: 'success', sourceOrg: S, targetOrg: T, rollbackOf: 'feed_r1',
        summary: { Account: { deleted: 5 }, Contact: { deleted: 12 } }, errors: [] },
      { id: 'feed_t1', kind: 'tool', tool: 'Field Cleaner', profileName: '📦 Values — Account.Old__c → New__c (12 records)', startedAt: d(26, 0), completedAt: d(26, 0), status: 'success', sourceOrg: T, targetOrg: T, what: [{ describe: 'values', ok: true, accepted: true, verified: true, text: '12 records updated' }], errors: [], toolUndo: null },
      { id: 'feed_t2', kind: 'tool', tool: 'Flow switches', profileName: '⏻ Flow — Lead Router (off)', startedAt: d(25, 30), completedAt: d(25, 30), status: 'success', sourceOrg: T, targetOrg: T, what: [{ describe: 'switch', ok: true, accepted: true, verified: true, text: 'Lead Router off' }], errors: [], toolUndo: null },
      { id: 'feed_t3', kind: 'tool', tool: 'Merge', profileName: '🔀 Account "SFTK CX Duplicate Name": one copy merged into 001…', startedAt: d(0, 30), completedAt: d(0, 29), status: 'success', sourceOrg: T, targetOrg: T, what: [{ describe: 'merge', ok: true, accepted: true, verified: true, text: 'merged' }], errors: [], toolUndo: { none: 'a merge cannot be undone' } },
    );
    await storageSaveHistory();
    return _history.length;
  })()`);
  h.log('seeded entries:', seeded);
  h.log('sidebar has History?', await h.eval(`!!document.querySelector('.ds-nav-btn[data-view="history"]')`));
  await h.click('#sftkFeedBtn'); await h.sleep(1500);
  h.log('STUDIO FEED:', (await h.modalText(2500)));
  h.log('action buttons:', await h.eval(`[...document.querySelectorAll('#sftkFeedList [data-dsaction], #sftkFeedList [data-hist-export]')].map(b => b.textContent.trim()).join(' | ')`));
  await h.shot(h.shots + '/feed-1-studio.png');
  await h.eval(`(() => { document.documentElement.classList.add('ds-dark'); return true; })()`); await h.sleep(400);
  await h.shot(h.shots + '/feed-2-studio-dark.png');
  // ⬇ Export all opens the audit export dialog in place of the feed
  await h.click('#sftkFeedExport'); await h.sleep(900);
  h.log('EXPORT DIALOG:', (await h.modalText(500)));
  await h.shot(h.shots + '/feed-3-export-dark.png');
  await h.closeModal();
  await h.eval(`(() => { document.documentElement.classList.remove('ds-dark'); return true; })()`);
  // the Toolkit
  await h.popup('flows'); await h.sleep(1500);
  await h.click('#sftkFeedBtn'); await h.sleep(1500);
  h.log('POPUP FEED:', (await h.eval(`(document.querySelector('#modalBox')?.innerText || '').slice(0, 1600).replace(/\\n+/g, ' | ')`)));
  h.log('popup action buttons:', await h.eval(`[...document.querySelectorAll('#sftkFeedList .sftk-feed-acts > *')].map(b => b.textContent.trim()).join(' | ')`));
  await h.shot(h.shots + '/feed-4-popup.png');
}
