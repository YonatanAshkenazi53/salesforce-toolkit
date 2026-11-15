// Live QA (2026-11-15): a 🧪 Dry run with the network DROPPED for ~10 s in the middle.
// WHY: the 1.1 QA could not run this (npc was over its daily API limit). A dry run that loses the network must
// end with a true failure — never a "passed" / "would be written" verdict for records Salesforce never answered
// about — and, as always, nothing may be written (the CLI reads the same counts after as before).
//   the Accounts tree of the CX fixture, every Insert + Changed row ticked, 🧪 Dry run, then
//   DROP_AFTER ms (default 3000) later: offline (page + the extension's service worker) for DROP_MS (default 10000)
import { execSync } from 'node:child_process';
const NL = String.fromCharCode(10);
const flat = (s, n = 3000) => String(s || '').split(NL).map(x => x.trim()).filter(Boolean).join(' | ').slice(0, n);
const count = soql => { try { const t = execSync(`sf data query -o npc2 --json -q "${soql}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); return JSON.parse(t.slice(t.indexOf('{'))).result.totalSize; } catch (e) { return `? (${e.message.split(NL)[0]})`; } };
const cliTree = () => ({
  accounts: count("SELECT COUNT() FROM Account WHERE Name LIKE 'SFTK CX%'"),
  contacts: count("SELECT COUNT() FROM Contact WHERE Account.Name LIKE 'SFTK CX%'"),
  opps: count("SELECT COUNT() FROM Opportunity WHERE Account.Name LIKE 'SFTK CX%'"),
  recentAccounts: count("SELECT COUNT() FROM Account WHERE CreatedDate = TODAY"),
});
const ONLINE = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
const OFFLINE = { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 };

// 2026-11-15: when a run ends the page repaints and the log moves from #dsRecProgress into the folded '📜 Last run on this page' block —
// innerText of a closed <details> is empty, so open it and read the log from wherever it is now
const runLog = h => h.eval(`(() => { const live = document.querySelector('#dsRecProgress'); if (live && live.innerText.trim()) return live.innerText; const d = document.querySelector('.ds-dep-lastlog'); if (!d) return ''; d.open = true; return (d.querySelector('.ds-rec-progress') || d).innerText || ''; })()`);
export default async function (h) {
  await h.login('npc'); await h.login('npc2');
  await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  // the extension's service worker has its own network stack: it is emulated too, or its fetches sail through
  const swSessions = new Set();
  const attachSW = async () => {
    const { targetInfos } = await h.cdp('Target.getTargets', {}, null);
    for (const t of targetInfos.filter(t => t.type === 'service_worker' && t.url.includes(h.extId) && !t.attached)) {
      const a = await h.cdp('Target.attachToTarget', { targetId: t.targetId, flatten: true }, null);
      swSessions.add(a.sessionId);
      await h.cdp('Network.enable', {}, a.sessionId).catch(() => {});
    }
    return [...swSessions];
  };
  const net = async (cond, label) => {
    const sw = await attachSW();
    await h.cdp('Network.enable', {});
    await h.cdp('Network.emulateNetworkConditions', cond);
    let ok = 0; for (const s of sw) { try { await h.cdp('Network.emulateNetworkConditions', cond, s); ok++; } catch (_) { /* a worker that went to sleep */ } }
    h.log(`NETWORK → ${label} (page + ${ok}/${sw.length} service worker session(s))`);
  };
  const id = await h.eval(`_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id`);
  if (!id) throw new Error('fixture profile missing');
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 180000, 1000);
  await h.sleep(2500);
  for (let i = 0; i < 20; i++) {
    const which = await h.eval(`(() => { window.__nd = window.__nd || new Set(); const b = [...document.querySelectorAll('[data-dep-scan]')].find(b => !/Rescan/.test(b.textContent) && !window.__nd.has(b.dataset.depScan)); if (!b) return null; window.__nd.add(b.dataset.depScan); b.click(); return b.dataset.depScan; })()`);
    if (which === null) break;
    await h.waitFor(`(() => { const b = document.querySelector('[data-dep-scan="${which}"]'); return !b || !b.disabled; })()`, 90000, 1000).catch(() => {});
    await h.sleep(800);
  }
  const objs = await h.eval(`[...document.querySelectorAll('.ds-dep-objtab, [data-dep-obj]')].map(b => b.dataset.depObj).filter((v, i, a) => v !== undefined && a.indexOf(v) === i)`);
  for (const o of objs) for (const tab of ['ins', 'chg']) {
    await h.eval(`(() => { const b = document.querySelector('[data-dep-obj="${o}"][data-dep-tab="${tab}"]'); if (b) b.click(); })()`); await h.sleep(400);
    await h.eval(`(() => { const b = document.querySelector('[data-dep-bulk="all"]'); if (b && !b.disabled) b.click(); return true; })()`); await h.sleep(300);
  }
  h.log('SUMMARY:', flat(await h.text('#dsDepSummary'), 400));
  const before = cliTree();
  h.log('CLI BEFORE:', JSON.stringify(before));
  const histBefore = await h.eval('_history.length');
  await h.click('#dsRecProbeBtn'); await h.sleep(1500);
  h.log('clicked:', await h.eval(`(() => { const b = document.querySelector('#sftkConfirmGo'); if (b && !b.disabled) { b.click(); return b.textContent.trim(); } return null; })()`));
  await h.sleep(Number(process.env.DROP_AFTER || 3000));
  h.log('run log when the network drops:', flat(await runLog(h), 500));
  await net(OFFLINE, 'OFFLINE');
  await h.sleep(Number(process.env.DROP_MS || 10000));
  h.log('run log while offline:', flat(await runLog(h), 900));
  await h.shot(h.shots + '/dryrun-netdrop-offline.png');
  await net(ONLINE, 'online');
  let ended = false;
  for (let i = 0; i < 300; i++) { if (await h.eval(`_history.length > ${histBefore}`)) { ended = true; break; } await h.sleep(1000); }
  await h.sleep(2000);
  const log = flat(await runLog(h), 7000);
  h.log('RUN LOG:', log);
  h.log('toasts:', flat(await h.eval(`[...document.querySelectorAll('.ds-toast')].map(t => t.innerText).join(' || ')`), 600));
  await h.eval(`(() => { const el = document.querySelector('.ds-dep-actionbar'); if (el) el.scrollIntoView({ block: 'center' }); return true; })()`); await h.sleep(400);
  h.log('ACTION BAR:', flat(await h.text('.ds-dep-actionbar'), 900));
  await h.eval(`(() => { const el = document.querySelector('.ds-dep-lastlog') || document.querySelector('#dsRecProgress'); if (el) el.scrollIntoView({ block: 'start' }); return true; })()`); await h.sleep(400);
  await h.shot(h.shots + '/dryrun-netdrop-after.png');
  const entry = ended ? JSON.parse(await h.eval(`JSON.stringify(_history[_history.length - 1], (k, v) => k === 'errors' ? v.slice(0, 12) : (k === 'selected' ? undefined : v))`)) : null;
  h.log('ended with a History entry:', ended, '| status:', entry && entry.status, '| probe totals:', entry && entry.probe ? JSON.stringify({ probed: entry.probe.probed, would: entry.probe.would, refused: entry.probe.refused, cascade: entry.probe.cascade, unreached: entry.probe.unreached, error: entry.probe.error }) : 'none');
  h.log('HISTORY ERRORS:', JSON.stringify((entry && entry.errors) || []).slice(0, 1500));
  const after = cliTree();
  h.log('CLI AFTER:', JSON.stringify(after), '| UNCHANGED:', JSON.stringify(before) === JSON.stringify(after));
  await h.eval(`navigateToView('history')`); await h.waitFor("!!document.querySelector('.ds-history-card, .ds-history-item')", 20000, 500).catch(() => {}); await h.sleep(1000);
  h.log('HISTORY CARD:', flat(await h.text('.ds-history-card'), 1500));
  await h.shot(h.shots + '/dryrun-netdrop-history.png');
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('the target changed during a dry run');
  if (!ended) throw new Error('the dry run never ended after the network came back (5 min)');
}
