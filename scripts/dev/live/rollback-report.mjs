// Live: History › a rollback's "📋 Which records" when the entry kept NO names
// (a rollback from before 2026-10-02, counts-only mode, or more than History
// keeps): the page must read the deleted records from the org's Recycle Bin.
//
// The entry below is SYNTHETIC and lives only in this page's memory (it is
// removed again at the end, never saved): the shape of the user's own entry
// from 2026-10-02 on trailheads5 — "↩ Rollback of Account + Contacts",
// Account 812 deleted, Contact 1250 deleted. The Recycle Bin of trailheads5
// still holds what that rollback deleted (CLI, 2026-10-05: 812 Accounts
// stamped 14:04:50–57 UTC, 380 Contacts stamped 14:04:41–45 UTC).
//   ORG=npc2     another org (then the times below match nothing: "0 found")
//   START / END  ISO times of the synthetic rollback
//   NO_LOGIN=1   no session for the org: the page must say "open that org"
const NL = String.fromCharCode(10);
const text = async (h, sel, n = 3000) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).split(NL).map(x => x.trim()).filter(Boolean).join(' | ').slice(0, n);
export default async function (h) {
  const alias = process.env.ORG || 'npc';
  if (process.env.NO_LOGIN !== '1') await h.login(alias);
  await h.studio('');
  await h.watchErrors();
  await h.sleep(2500);
  const org = process.env.ORG_URL || (alias === 'npc2' ? 'https://trailheads4.my.salesforce.com' : 'https://trailheads5.my.salesforce.com');
  const entry = {
    id: 'run_live_synthetic_old_rollback', kind: 'rollback', profileName: '↩ Rollback of Account + Contacts',
    startedAt: process.env.START || '2026-10-02T14:04:30.000Z', completedAt: process.env.END || '2026-10-02T14:05:05.000Z',
    status: 'success', targetOrg: org, tgtOrgUrl: org, errors: [],
    summary: {
      Account: { deleted: 812, deletedFailed: 0, updated: 0, updatedFailed: 0, remaining: 0, leftAlone: 0 },
      Contact: { deleted: 1250, deletedFailed: 0, updated: 0, updatedFailed: 0, remaining: 0, leftAlone: 0 },
    },
  };
  await h.eval(`(() => { _history.push(${JSON.stringify(entry)}); return true; })()`);
  await h.eval(`window.openRollback(${JSON.stringify(entry.id)}, { report: true })`);
  await h.sleep(400);
  h.log('WHILE READING:', await text(h, '.ds-rb-records', 700));
  const settled = "!/Reading the/.test(document.querySelector('.ds-rb-records')?.innerText || '')";
  await h.waitFor(settled, 120000, 500);
  h.log('ACCOUNT note:', await text(h, '.ds-rb-records .ds-dep-note', 900));
  h.log('ACCOUNT tabs:', await text(h, '.ds-dep-tabs', 200));
  h.log('ACCOUNT first rows:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.ds-dep-list .ds-dep-row')].slice(0, 3).map(r => r.innerText.split(String.fromCharCode(10)).join(' · '))`)));
  h.log('ACCOUNT rows shown / tools:', await h.eval(`document.querySelectorAll('.ds-dep-list .ds-dep-row').length`), '/', await text(h, '.ds-dep-tools', 200));
  await h.shot(h.shots + '/rb-report-account.png');
  // filter
  await h.eval(`(() => { const f = document.querySelector('#dsRbFilter'); f.value = '05985'; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.sleep(400);
  h.log('FILTER 05985:', await text(h, '.ds-dep-tools', 200), '·', await h.eval(`document.querySelectorAll('.ds-dep-list .ds-dep-row').length`), 'row(s)');
  // the other object
  await h.eval(`document.querySelector('[data-rb-robj="Contact"]').click()`);
  await h.sleep(400);
  await h.waitFor(settled, 120000, 500);
  h.log('CONTACT note:', await text(h, '.ds-rb-records .ds-dep-note', 900));
  h.log('CONTACT tabs:', await text(h, '.ds-dep-tabs', 200));
  h.log('CONTACT first rows:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.ds-dep-list .ds-dep-row')].slice(0, 3).map(r => r.innerText.split(String.fromCharCode(10)).join(' · '))`)));
  await h.shot(h.shots + '/rb-report-contact.png');
  // the restored tab of an entry that restored nothing
  await h.eval(`document.querySelector('[data-rb-rtab="restored"]').click()`);
  await h.sleep(300);
  h.log('RESTORED tab:', await text(h, '.ds-rb-records', 400));
  await h.eval(`(() => { const i = _history.findIndex(x => x && x.id === ${JSON.stringify(entry.id)}); if (i >= 0) _history.splice(i, 1); return true; })()`);
}
