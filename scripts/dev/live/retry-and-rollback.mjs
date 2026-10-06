// Live: History → ↻ Retry failed on the newest run of a deployment (the Deploy
// page must open with the failed records ticked), then ↩ Roll back that run
// (typed word, plan, execution), reporting what each said.
//   PROFILE = deployment name (default: the Accounts tree)
//   ROLLBACK=0 to skip the rollback
//   HISTORY=1 afterwards: the History page end to end — the cards, the status and
//             deployment filters, a run's own export (JSON + CSV, real downloads read
//             back), Export all, counts-only mode (ids stripped, checked in storage),
//             the retention select; everything is set back as it was
// The deployment only ever writes trailheads5 → trailheads4: the Deploy page's own
// direction is asserted before anything is ticked.
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
const dump = async (h, sel, n = 1500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).join(' | ');
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK CX — Accounts tree';
  // a fresh profile has no History: run the deployment once (root inserts only) — SKIP_RUN=1 skips it
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (process.env.SKIP_RUN === '1') { h.log('SKIP_RUN: no deployment run'); }
  else {
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  const dir = await h.eval(`(() => { const p = (typeof _reconcileProfile !== 'undefined' && _reconcileProfile) || null; return p ? { src: p.sourceOrg || '', tgt: p.targetOrg || '' } : null; })()`);
  h.log('direction:', JSON.stringify(dir));
  if (!dir || !dir.src.includes('trailheads5') || !dir.tgt.includes('trailheads4')) throw new Error(`the Deploy page is open ${dir ? `${dir.src} → ${dir.tgt}` : 'on nothing'}; this script only ever writes trailheads5 → trailheads4`);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);
  await h.sleep(1500);
  await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="ins"]')?.click()`); await h.sleep(500);
  await h.eval(`(() => { const b = document.querySelector('[data-dep-bulk="all"]'); if (b) b.click(); })()`); await h.sleep(500);
  h.log('SUMMARY:', await dump(h, '#dsDepSummary', 300));
  const histBefore = await h.eval('_history.length');
  if (await h.eval(`document.querySelector('#dsRecRunBtn')?.disabled`)) { h.log('nothing to run'); return; }
  await h.click('#dsRecRunBtn'); await h.sleep(2500);
  for (let i = 0; i < 3; i++) { const m = await h.modalText(300); if (!m) break; await h.eval(`(() => { const b = document.querySelector('#dsRecDelOk') || [...document.querySelectorAll('#dsModalBox button')].find(b => /proceed/i.test(b.textContent)); if (b) b.click(); })()`); await h.sleep(2000); }
  for (let i = 0; i < 600; i++) { if (await h.eval(`_history.length > ${histBefore}`)) break; await h.sleep(1000); }
  await h.sleep(6000);
  await h.waitFor("!document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);
  }

  // ── ↻ Retry failed ──
  await h.eval(`document.querySelector('[data-view="history"]')?.click()`);
  await h.waitFor("!!document.querySelector('.ds-history-card, .ds-history-item')", 20000, 500); await h.sleep(800);
  h.log('HISTORY newest:', (await dump(h, '.ds-history-card, .ds-history-item', 700)));
  const retryBtn = await h.eval(`!!document.querySelector('[data-dsaction="retryFailed"]')`);
  h.log('Retry failed offered:', retryBtn);
  if (retryBtn) {
    await h.eval(`document.querySelector('[data-dsaction="retryFailed"]').click()`);
    await h.waitFor("_currentView === 'deploy' && !!document.querySelector('.ds-dep-plan')", 300000, 1000); await h.sleep(2500);
    h.log('RETRY LINE:', (await h.eval(`[...document.querySelectorAll('.ds-rec-card-line')].map(e => e.innerText).find(t => /Retry/.test(t)) || '(no retry line)'`)).slice(0, 400));
    h.log('SUMMARY after retry:', await dump(h, '#dsDepSummary', 300));
    await h.shot(h.shots + '/retry.png');
  }

  // ── ↩ Roll back ──
  if (process.env.ROLLBACK === '0') return;
  await h.eval(`document.querySelector('[data-view="history"]')?.click()`);
  await h.waitFor("!!document.querySelector('[data-dsaction=\"rollbackRun\"]')", 20000, 500); await h.sleep(500);
  // the newest run that CAN be rolled back (a run that wrote nothing offers a disabled button)
  const rbDisabled = !(await h.eval(`!!document.querySelector('[data-dsaction="rollbackRun"]:not([disabled])')`));
  h.log('Roll back available:', !rbDisabled);
  if (rbDisabled) return;
  await h.eval(`document.querySelector('[data-dsaction="rollbackRun"]:not([disabled])').click()`);
  // ↩ Roll back is a PAGE (campaign 4 phase 7): the plan is ready when the Go
  // button exists, or the page says it could not be prepared / nothing to do.
  await h.waitFor("!!document.querySelector('#dsRbGo') || !!document.querySelector('.ds-rec-card-bad')", 300000, 1000);
  await h.sleep(1000);
  h.log('ROLLBACK PAGE:', await dump(h, '.ds-dep-plan', 3000));
  h.log('ROLLBACK PREP LOG:', await dump(h, '#dsRbPrepLog', 800));
  h.log('ROLLBACK RECORDS (current tab):', await dump(h, '#dsRbList', 2500));
  const forced = await h.eval(`(() => { let n = 0; document.querySelectorAll('[data-rb-pick^="force|"]').forEach(c => { if (!c.checked) { c.click(); n++; } }); return n; })()`);
  h.log('force boxes ticked:', forced);
  // UNTICK_ONE=1: keep ONE created record — proves unticking survives (CLI shows it after)
  if (process.env.UNTICK_ONE === '1') {
    const kept = await h.eval(`(() => { const cb = document.querySelector('[data-rb-pick^="del|"]:checked'); if (!cb) return ''; cb.click(); return cb.closest('.ds-dep-row')?.querySelector('.ds-dep-key')?.textContent || cb.dataset.rbPick; })()`);
    h.log('UNTICKED (kept on purpose):', JSON.stringify(kept));
  }
  h.log('summary:', await dump(h, '#dsRbSummary', 200));
  const goOn = await h.eval(`!!document.querySelector('#dsRbGo') && !document.querySelector('#dsRbGo').disabled`);
  h.log('Go enabled:', goOn);
  if (!goOn) return;
  await h.eval(`document.querySelector('#dsRbGo').click()`);
  // the ONE shared confirmation: acknowledgement checkbox, the typed word (ROLLBACK),
  // or the typed org name for production / guarded orgs
  await h.waitFor("!!document.querySelector('#sftkConfirmGo') || !!document.querySelector('#sftkConfirmProdGo')", 20000, 300);
  await h.sleep(300);
  await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
  // the page asks for ROLLBACK (non-production); production asks the org name in the second step below
  const word = (await h.eval(`!!document.querySelector('#sftkConfirmWord')`)) ? 'ROLLBACK' : '';
  h.log('typed word asked:', JSON.stringify(word));
  if (word) await h.eval(`(() => { const i = document.querySelector('#sftkConfirmWord'); i.value = ${JSON.stringify(word)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.sleep(300);
  h.log('Confirm enabled:', await h.eval(`!document.querySelector('#sftkConfirmGo')?.disabled`));
  await h.eval(`document.querySelector('#sftkConfirmGo')?.click()`);
  await h.sleep(500);
  if (await h.eval(`!!document.querySelector('#sftkConfirmProd')`)) {
    const prodName = await h.eval(`(document.querySelector('#sftkConfirmProd')?.placeholder || '')`);
    h.log('production step — org name asked:', JSON.stringify(prodName));
    await h.eval(`(() => { const i = document.querySelector('#sftkConfirmProd'); i.value = ${JSON.stringify(prodName)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await h.sleep(300);
    await h.eval(`document.querySelector('#sftkConfirmProdGo')?.click()`);
  }
  // the rollback writes its own History entry on success AND on failure — that is the end marker
  const rbBefore = await h.eval(`_history.filter(x => x.kind === 'rollback').length`);
  for (let i = 0; i < 1500; i++) { if (await h.eval(`_history.filter(x => x.kind === 'rollback').length > ${rbBefore}`)) break; await h.sleep(1000); }
  await h.sleep(2000);
  h.log('ROLLBACK LOG:', await dump(h, '#dsRbLog', 2500));
  h.log('ROLLBACK RESULT:', await dump(h, '#dsRbResult', 800));
  h.log('ROLLBACK ERRORS:', await h.eval(`JSON.stringify(((_history.filter(x => x.kind === 'rollback').slice(-1)[0] || {}).errors || []).slice(0, 12))`));
  h.log('ROLLBACK PREP LOG (full):', await dump(h, '#dsRbPrepLog', 4000));
  await h.shot(h.shots + '/rollback.png');
  // 📋 the report: every record by name
  if (await h.eval(`!!document.querySelector('#dsRbOpenReport')`)) {
    await h.eval(`document.querySelector('#dsRbOpenReport').click()`); await h.sleep(1500);
    h.log('REPORT:', await dump(h, '.ds-dep-page', 2500));
    await h.shot(h.shots + '/rollback-report.png');
  }
  await h.eval(`document.querySelector('[data-view="history"]')?.click()`); await h.sleep(1500);
  h.log('HISTORY after rollback:', await dump(h, '.ds-history-card, .ds-history-item', 900));
  if (process.env.HISTORY === '1') await historyPage(h);
}

// ── the History page itself ──
const ID_RE = String.raw`\b00[135][0-9A-Za-z]{15}\b`;
async function historyPage(h) {
  const NL = String.fromCharCode(10);
  const lines = (s, n = 2500) => String(s || '').slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
  const cardCount = () => h.eval("document.querySelectorAll('.ds-history-card').length");
  const storedIds = () => h.eval(`new Promise(r => chrome.storage.local.get('sftk_history', d => r((JSON.stringify(d.sftk_history || []).match(new RegExp(${JSON.stringify(ID_RE)}, 'g')) || []).length)))`);
  const setting = k => h.eval(`new Promise(r => chrome.storage.local.get('ds_settings', d => r((d.ds_settings || {})[${JSON.stringify(k)}])))`);
  await h.eval(`document.querySelector('[data-view="history"]')?.click()`); await h.sleep(1200);
  const total = await cardCount();
  h.log(`HISTORY PAGE: ${total} card(s) · entries ${await h.eval("JSON.stringify(_history.map(x => (x.kind || 'run') + ':' + x.status))")}`);
  h.log('HEADER:', lines(await h.eval("document.querySelector('#dsMain')?.innerText || ''"), 500));
  // status filters: each count must agree with the entries, "all" brings every card back
  const filters = await h.eval("[...document.querySelectorAll('[data-hist-status]')].map(b => b.dataset.histStatus)");
  const seen = {};
  for (const f of filters) { await h.eval(`document.querySelector('[data-hist-status="${f}"]').click()`); await h.sleep(500); seen[f] = await cardCount(); }
  const expect = JSON.parse(await h.eval("JSON.stringify(Object.fromEntries(['all','success','partial','failed'].map(k => [k, k === 'all' ? _history.length : _history.filter(x => x.status === k).length])))"));
  h.log('status filters → cards:', JSON.stringify(seen), '· the entries say:', JSON.stringify(expect));
  for (const [k, v] of Object.entries(expect)) if (k in seen && seen[k] !== v) throw new Error(`filter ${k} shows ${seen[k]} card(s), the entries say ${v}`);
  await h.eval(`document.querySelector('[data-hist-status="all"]')?.click()`); await h.sleep(400);
  // the deployment filter
  h.log('deployment filter options:', JSON.stringify(await h.eval("[...document.querySelectorAll('#dsHistProfile option')].map(o => o.value + ' :: ' + o.text)")));
  const pick = await h.eval("[...document.querySelectorAll('#dsHistProfile option')].map(o => o.value).find(v => v)");
  if (pick) {
    await h.eval(`(() => { const s = document.querySelector('#dsHistProfile'); s.value = ${JSON.stringify(pick)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await h.sleep(500);
    h.log(`filtered by ${pick}: ${await cardCount()} card(s)`);
    await h.eval("(() => { const s = document.querySelector('#dsHistProfile'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()"); await h.sleep(400);
  }
  // downloads land in a folder of ours
  const dlDir = resolve('dist/qa/downloads'); mkdirSync(dlDir, { recursive: true });
  await h.cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true }, null);
  const grab = (re) => { const had = new Set(readdirSync(dlDir)); return async () => { let f = null; for (let i = 0; i < 40 && !f; i++) { await h.sleep(500); f = readdirSync(dlDir).find(x => !had.has(x) && re.test(x)); } return f ? join(dlDir, f) : null; }; };
  const base = f => f.split(/[\\/]/).pop();
  // a run's own export: JSON, then CSV
  let wait = grab(/\.json$/);
  await h.eval("document.querySelector('[data-hist-export]').click()"); await h.sleep(800);
  h.log('RUN EXPORT DIALOG:', lines(await h.text('#dsModalBox'), 500));
  await h.click('#dsRunExportJson');
  let f = await wait(); if (!f) throw new Error('the run JSON export did not download');
  const runJson = JSON.parse(readFileSync(f, 'utf8'));
  h.log(`RUN JSON: ${base(f)} (${statSync(f).size} bytes) · keys: ${Object.keys(runJson).slice(0, 14).join(',')}`);
  await h.closeModal().catch(() => {}); await h.sleep(300);
  wait = grab(/\.csv$/);
  await h.eval("document.querySelector('[data-hist-export]').click()"); await h.sleep(800);
  await h.click('#dsRunExportCsv');
  f = await wait(); if (!f) throw new Error('the run CSV export did not download');
  const csv = readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean);
  h.log(`RUN CSV: ${base(f)} · ${csv.length - 1} row(s) · header: ${csv[0].slice(0, 200)}`);
  await h.closeModal().catch(() => {}); await h.sleep(300);
  // Export all: JSON and CSV
  wait = grab(/^sftk-history-.*\.json$/);
  await h.click('#dsHistExportAll'); await h.sleep(600);
  h.log('EXPORT ALL DIALOG:', lines(await h.text('#dsModalBox'), 500));
  await h.click('#dsHistExportAllJson');
  f = await wait(); if (!f) throw new Error('Export all JSON did not download');
  const all = JSON.parse(readFileSync(f, 'utf8'));
  const runs = Array.isArray(all) ? all : (all.runs || all.history || all.entries || []);
  const inHist = await h.eval('_history.length');
  h.log(`ALL JSON: ${base(f)} · ${runs.length} run(s) in the file, ${inHist} in History · top keys: ${Array.isArray(all) ? '(array)' : Object.keys(all).join(',')}`);
  if (runs.length !== inHist) throw new Error('Export all JSON does not carry every run');
  wait = grab(/^sftk-history-.*\.csv$/);
  await h.click('#dsHistExportAll'); await h.sleep(600); await h.click('#dsHistExportAllCsv');
  f = await wait(); if (!f) throw new Error('Export all CSV did not download');
  const allCsv = readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean);
  h.log(`ALL CSV: ${base(f)} · ${allCsv.length - 1} row(s) · header: ${allCsv[0].slice(0, 200)}`);
  // counts-only: record ids leave the stored history at once; then off again
  const idsBefore = await storedIds();
  await h.eval("(() => { const c = document.querySelector('#dsCountsOnly'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()"); await h.sleep(1500);
  const idsAfter = await storedIds();
  h.log(`counts-only: record ids in stored history ${idsBefore} → ${idsAfter} · toast: ${lines(await h.eval("document.querySelector('.ds-toast')?.innerText || ''"), 200)}`);
  if (idsAfter !== 0) throw new Error('counts-only left record ids in storage');
  h.log('card after the strip:', lines(await h.eval("document.querySelector('.ds-history-card')?.innerText || ''"), 400));
  await h.eval("(() => { const c = document.querySelector('#dsCountsOnly'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()"); await h.sleep(600);
  h.log(`counts-only stored after switching it off: ${await setting('countsOnly')}`);
  // retention
  const retBefore = await h.eval("document.querySelector('#dsRetentionDays').value");
  const other = await h.eval(`[...document.querySelectorAll('#dsRetentionDays option')].map(o => o.value).find(v => v !== ${JSON.stringify(retBefore)})`);
  await h.eval(`(() => { const s = document.querySelector('#dsRetentionDays'); s.value = ${JSON.stringify(other)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await h.sleep(500);
  const retStored = String(await setting('historyDays'));
  h.log(`retention options ${JSON.stringify(await h.eval("[...document.querySelectorAll('#dsRetentionDays option')].map(o => o.value + ':' + o.text)"))} · ${retBefore} → ${other} · stored ${retStored} · toast: ${lines(await h.eval("document.querySelector('.ds-toast')?.innerText || ''"), 200)}`);
  if (retStored !== String(parseInt(other, 10) || 0)) throw new Error('the retention setting did not store');
  await h.eval(`(() => { const s = document.querySelector('#dsRetentionDays'); s.value = ${JSON.stringify(retBefore)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await h.sleep(300);
  h.log('✓ History page: cards, filters agree with the entries, run export JSON+CSV, export all JSON+CSV, counts-only strips, retention stores; settings restored');
}
