// 🧪 DRY RUN, live (1.1, 2026-11-04): the Accounts tree of the CX fixture, every
// Insert + Changed row ticked, then "🧪 Dry run" instead of ▶ Deploy. The target
// org keeps a validation rule on Account (Retail needs a Website) and one on
// Contact (a Lab lead needs a Phone), so Salesforce must refuse some rows and
// cascade their children — and the CLI must read the SAME counts after as
// before. Screenshots of the live log and the History card, light and dark.
//   SCAN_WAIT / RUN_WAIT as in run-accounts-tree.mjs
import { execSync } from 'node:child_process';
const SHOTS = process.env.LOCALAPPDATA + '/Temp/sftk-headless-shots/';
const dump = async (h, sel, n = 1200) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).replace(/\n+/g, ' | ');
const count = soql => {
  try {
    const t = execSync(`sf data query -o npc2 --json -q "${soql}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(t.slice(t.indexOf('{'))).result.totalSize;
  } catch (e) { return `? (${e.message.split('\n')[0]})`; }
};
const cliTree = () => ({
  accounts: count("SELECT COUNT() FROM Account WHERE Name LIKE 'SFTK CX%'"),
  contacts: count("SELECT COUNT() FROM Contact WHERE Account.Name LIKE 'SFTK CX%'"),
  opps: count("SELECT COUNT() FROM Opportunity WHERE Account.Name LIKE 'SFTK CX%'"),
  lineItems: count("SELECT COUNT() FROM OpportunityLineItem WHERE Opportunity.Account.Name LIKE 'SFTK CX%'"),
  recentAccounts: count("SELECT COUNT() FROM Account WHERE CreatedDate = TODAY"),
});
const theme = async (h, dark) => { await h.eval(`(() => { if (typeof applyDarkMode === 'function') applyDarkMode(${dark}); else document.documentElement.classList.toggle('ds-dark', ${dark}); return true; })()`); await h.sleep(400); };

export default async function (h) {
  await h.login('npc');
  await h.login('npc2');
  await h.studio('');
  await h.importProfiles(process.env.FIXTURE || 'docs/fixtures/complex-deployment/profiles.json');   // FIXTURE + PROFILE: any deployment, e.g. the packaged-object one
  const NAME = process.env.PROFILE || 'SFTK CX — Accounts tree';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (!id) throw new Error('fixture profile missing');
  h.log('deployment:', NAME);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`);
  await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", Number(process.env.SCAN_WAIT || 120000), 1000);
  await h.sleep(2500);
  const scanFailed = [];
  for (let i = 0; i < 20; i++) {
    const which = await h.eval(`(() => { const skip = new Set(${JSON.stringify(scanFailed)}); const b = [...document.querySelectorAll('[data-dep-scan]')].find(b => !/Rescan/.test(b.textContent) && !skip.has(b.dataset.depScan)); return b ? b.dataset.depScan : null; })()`);
    if (which === null) break;
    await h.eval(`(() => { const b = document.querySelector('[data-dep-scan="${which}"]'); b.click(); })()`);
    await h.waitFor(`(() => { const b = document.querySelector('[data-dep-scan="${which}"]'); return !b || !b.disabled; })()`, Number(process.env.SCAN_WAIT || 90000), 1000);
    await h.sleep(800);
    const ok = await h.eval(`(() => { const b = document.querySelector('[data-dep-scan="${which}"]'); return !b || /Rescan/.test(b.textContent || ''); })()`);   // a read row has no button since 2026-11-13
    if (!ok) scanFailed.push(which);
  }
  h.log('PLAN:', await dump(h, '.ds-dep-plan', 1600));
  const objs = await h.eval(`[...document.querySelectorAll('.ds-dep-objtab, [data-dep-obj]')].map(b => b.dataset.depObj).filter((v, i, a) => v !== undefined && a.indexOf(v) === i)`);
  for (const o of objs) {
    for (const tab of ['ins', 'chg']) {
      await h.eval(`(() => { const b = document.querySelector('[data-dep-obj="${o}"][data-dep-tab="${tab}"]'); if (b) b.click(); })()`);
      await h.sleep(400);
      await h.eval(`(() => { const b = document.querySelector('[data-dep-bulk="all"]'); if (b && !b.disabled) b.click(); return true; })()`);
      await h.sleep(300);
    }
  }
  const summaryBefore = await dump(h, '#dsDepSummary', 500);
  h.log('SUMMARY:', summaryBefore);
  h.log('buttons:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.ds-dep-ab-top button')].map(b => ({ id: b.id, text: b.textContent.trim(), disabled: b.disabled }))`)));
  await h.shot(SHOTS + 'dryrun-0-selected.png');
  const before = cliTree();
  h.log('CLI BEFORE:', JSON.stringify(before));

  const histBefore = await h.eval('_history.length');
  await h.click('#dsRecProbeBtn');
  await h.sleep(1500);
  const m = await h.modalText(1600);
  h.log('MODAL:', m);
  await h.shot(SHOTS + 'dryrun-1-dialog.png');
  await theme(h, true); await h.shot(SHOTS + 'dryrun-1-dialog-dark.png'); await theme(h, false);
  if (await h.eval(`!!document.querySelector('#sftkConfirmProd')`)) throw new Error('typed gate shown — org is dev, unexpected');
  h.log('clicked:', await h.eval(`(() => { const b = document.querySelector('#sftkConfirmGo'); if (b && !b.disabled) { b.click(); return b.textContent.trim(); } return null; })()`));
  let lastLog = '', midShot = false;
  for (let i = 0; i < Number(process.env.RUN_WAIT || 240); i++) {
    const t = await h.eval(`document.querySelector('#dsRecProgress')?.innerText || ''`);
    if (t) lastLog = t;
    if (!midShot && /Salesforce is checking|built — waiting/.test(t)) { midShot = true; await h.shot(SHOTS + 'dryrun-2-checking.png'); }
    if (await h.eval(`_history.length > ${histBefore}`)) break;
    await h.sleep(700);
  }
  await h.sleep(1500);
  h.log('RUN LOG:', lastLog.split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ').slice(0, 6000));
  // the run log, then (after the toast has gone) the action bar with its hint
  await h.eval(`(() => { const el = document.querySelector('#dsRecProgress'); if (el) el.scrollIntoView({ block: 'start' }); return true; })()`);
  await h.sleep(500);
  await h.shot(SHOTS + 'dryrun-3-log.png');
  await theme(h, true); await h.shot(SHOTS + 'dryrun-3-log-dark.png'); await theme(h, false);
  await h.sleep(7500);
  await h.eval(`(() => { const el = document.querySelector('.ds-dep-actionbar'); if (el) el.scrollIntoView({ block: 'center' }); return true; })()`);
  await h.sleep(500);
  h.log('WHY LINES:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.ds-prog-err, .ds-prog-note')].map(e => e.innerText.trim()).filter(t => /refused|failed|❌|✗/.test(t))`)));
  await h.eval(`(() => { const e = [...document.querySelectorAll('.ds-prog-err')].pop(); if (e) e.scrollIntoView({ block: 'center' }); return true; })()`); await h.sleep(400); await h.shot(SHOTS + 'dryrun-why.png');
  h.log('ACTION BAR:', await dump(h, '.ds-dep-actionbar', 700));
  await h.shot(SHOTS + 'dryrun-3-bar.png');
  await theme(h, true); await h.shot(SHOTS + 'dryrun-3-bar-dark.png'); await theme(h, false);
  h.log('toasts:', (await h.eval(`[...document.querySelectorAll('.ds-toast')].map(t => t.innerText).join(' || ')`)).slice(0, 400));
  h.log('SUMMARY after (selections must stay):', await dump(h, '#dsDepSummary', 500));
  const entry = await h.eval(`JSON.stringify(_history[_history.length - 1], (k, v) => k === 'errors' ? v.slice(0, 60) : v)`);
  h.log('HISTORY ENTRY:', entry.slice(0, 5000));
  const after = cliTree();
  h.log('CLI AFTER:', JSON.stringify(after));
  h.log('UNCHANGED:', JSON.stringify(before) === JSON.stringify(after));

  await h.eval(`navigateToView('history')`);
  await h.waitFor("!!document.querySelector('.ds-history-card, .ds-history-item')", 20000, 500);
  await h.sleep(1000);
  h.log('HISTORY CARD:', await dump(h, '.ds-history-card', 2500));
  await h.eval(`document.querySelectorAll('.ds-history-card details').forEach(d => d.open = true)`);
  await h.sleep(300);
  await h.shot(SHOTS + 'dryrun-4-history.png');
  await theme(h, true); await h.shot(SHOTS + 'dryrun-4-history-dark.png'); await theme(h, false);
}
