// Live: ⏸ Pause a deployment and ▶ Continue it, trailheads5 → trailheads4 on the
// Accounts tree with batch size 1 (one Collections call per record, so the pause
// lands between records):
//   run the 7 root Inserts → press ⏸ Pause as soon as the first record is written →
//   the run stops after the batch in flight (CLI counts what landed) → History shows
//   "⏸ paused" and ▶ Continue → Continue opens the Deploy page with the records not
//   reached ticked again (the written ones left alone) → ▶ Deploy → all 7 in the
//   target (CLI) → ↩ Roll back both runs → target as before (CLI).
//   STEP=closed   instead of the button, DISCONNECT the progress port (what a closed
//                 tab does) — the engine must stop and the entry must say "page closed"
import { execFileSync } from 'node:child_process';
const NL = String.fromCharCode(10);
const lines = (s, n = 2500) => String(s || '').slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const cli = (alias, args) => JSON.parse(execFileSync('sf', [...args, '-o', alias, '--json'], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
const tgtCx = () => (cli('npc2', ['data', 'query', '-q', `"SELECT Name FROM Account WHERE Name LIKE 'SFTK CX%' OR Name LIKE 'Person SFTK CX%' ORDER BY Name"`]).result.records || []).map(r => r.Name);
const NAME = 'SFTK CX — Accounts tree';

async function openScanned(h) {
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  const dir = await h.eval("(() => { const p = _reconcileProfile; return p ? { src: p.sourceOrg || '', tgt: p.targetOrg || '' } : null; })()");
  if (!dir || !dir.src.includes('trailheads5') || !dir.tgt.includes('trailheads4')) throw new Error(`wrong direction ${JSON.stringify(dir)}`);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000); await h.sleep(1500);
}
async function confirmRun(h) {
  for (let i = 0; i < 4; i++) {
    const m = await h.modalText(1500); if (!m) break;
    await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } const b = document.querySelector('#sftkConfirmGo') || [...document.querySelectorAll('#dsModalBox button')].find(b => /proceed|deploy|confirm|ok/i.test(b.textContent) && !b.disabled); if (b) b.click(); return !!b; })()`);
    await h.sleep(1500);
  }
}
async function waitRunEnd(h, histBefore) {
  for (let i = 0; i < 600; i++) { if (await h.eval(`_history.length > ${histBefore}`)) break; await h.sleep(500); }
  await h.sleep(2500);
  return JSON.parse(await h.eval("JSON.stringify((() => { const e = _history[_history.length - 1]; return { status: e.status, stopped: e.stopped || null, selected: Object.fromEntries(Object.entries(e.selected || {}).map(([k, v]) => [k, v.length])), inserted: e.summary?.Account?.inserted, failed: e.summary?.Account?.insertedFailed, errors: (e.errors || []).filter(x => /paused|closed|cancel/i.test(x)) }; })())"));
}

export default async function (h) {
  const step = process.env.STEP || 'pause';
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const before = tgtCx();
  h.log(`CLI target CX accounts before (${before.length})`);
  await openScanned(h);
  // batch size 1 and one thread: the pause lands between records
  await h.eval("(async () => { await sftkRecSetEngine(_reconcileProfile, 'batchSize', '1'); await sftkRecSetEngine(_reconcileProfile, 'threads', '1'); return true; })()");
  await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="ins"]')?.click()`); await h.sleep(600);
  await h.eval(`document.querySelector('[data-dep-bulk="all"]')?.click()`); await h.sleep(500);
  h.log('SUMMARY:', lines(await h.text('#dsDepSummary'), 200));
  const histBefore = await h.eval('_history.length');
  await h.click('#dsRecRunBtn'); await h.sleep(2000);
  await confirmRun(h);
  await h.waitFor("!!document.querySelector('#dsRunPauseBtn')", 60000, 300);
  h.log('PAUSE BAR:', lines(await h.text('#dsRunPauseBar'), 300));
  // the first record: wait for the live view to show one written, then pause / close
  await h.waitFor("/1 \\/ 7|1 created|created 1|written 1/.test(document.querySelector('#dsRecProgress')?.innerText || '')", 120000, 200).catch(() => {});
  if (step === 'closed') {
    // the user closes the tab (here: the page is navigated away — the same unload):
    // the page's beforeunload guard must ASK, the harness answers "leave" as the user
    // would, the port drops, the engine stops after the batch in flight
    const dlgBefore = h.dialogs.length;
    // Chrome shows a beforeunload prompt only after a real user gesture on the page
    // (el.click() from a script is not one): one real mouse click on the note text
    const rc = JSON.parse(await h.eval("JSON.stringify(document.querySelector('.ds-run-pausenote').getBoundingClientRect())"));
    const x = Math.round(rc.x + rc.width / 2), y = Math.round(rc.y + rc.height / 2);
    await h.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await h.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await h.sleep(300);
    await h.cdp('Page.navigate', { url: 'about:blank' });
    await h.sleep(2500);
    const asked = h.dialogs.length > dlgBefore;
    h.log(`leaving the page: the browser ${asked ? 'ASKED (beforeunload guard) ✓' : 'did NOT ask ❌'}`);
    if (!asked) throw new Error('no beforeunload prompt while a run was on');
    const c1 = tgtCx().length; await h.sleep(8000); const c2 = tgtCx().length;
    h.log(`CLI target after the close: ${c1} (+${c1 - before.length}) · 8 s later: ${c2} → ${c2 === c1 ? 'the engine stopped ✓' : 'STILL WRITING ❌'}`);
    if (c2 !== c1) throw new Error('the engine kept writing after the page closed');
    if (c1 - before.length >= 7) throw new Error('every record landed — the stop came too late to prove anything');
    // the next Data Studio page says it once
    await h.studio('');
    await h.waitFor("/A deployment stopped when its page was closed/.test(document.body.innerText)", 15000, 300);
    h.log('TOAST:', lines(await h.eval("document.body.innerText.split(String.fromCharCode(10)).find(l => /A deployment stopped when its page was closed/.test(l)) || ''"), 600));
    const left = await h.eval("new Promise(r => chrome.storage.local.get(['sftk_run_interrupted', 'sftk_active_run'], d => r(Object.keys(d))))");
    h.log(`markers left in storage after the toast: ${JSON.stringify(left)}`);
    if (left.length) throw new Error('the interrupted-run markers were not consumed');
    // Scan is the natural continue: the Insert list holds what was not written
    await openScanned(h);
    await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="ins"]')?.click()`); await h.sleep(600);
    h.log('SUMMARY after re-scan:', lines(await h.text('#dsDepSummary'), 200));
    // no History entry exists for a page that died: the written records go by CLI (fixture cleanup)
    const now = (cli('npc2', ['data', 'query', '-q', `"SELECT Id, Name FROM Account WHERE Name LIKE 'SFTK CX%' OR Name LIKE 'Person SFTK CX%'"`]).result.records || []);
    const extra = now.filter(r => !before.includes(r.Name));
    for (const r of extra) cli('npc2', ['data', 'delete', 'record', '-s', 'Account', '-i', r.Id]);
    const back = tgtCx();
    h.log(`CLI cleanup: deleted ${extra.length} written record(s) → target ${back.length} (${back.length === before.length ? 'as before ✓' : 'DIFFERENT ❌'})`);
    if (back.length !== before.length) throw new Error('cleanup did not put the target back');
    h.log('✓ closed page: the browser asked before leaving, the engine stopped after the batch in flight (CLI), the next page said so once, the re-scan lists the rest');
    return;
  } else {
    await h.click('#dsRunPauseBtn');
    h.log(`pressed ⏸ Pause · button now: "${await h.eval("document.querySelector('#dsRunPauseBtn')?.textContent.trim()")}"`);
  }
  const e1 = await waitRunEnd(h, histBefore);
  const mid = tgtCx();
  h.log(`after the pause: entry ${JSON.stringify(e1)} · CLI target now ${mid.length} (+${mid.length - before.length})`);
  if (e1.stopped !== 'pause') throw new Error('the entry does not say it was paused');
  if (!(e1.inserted >= 1 && e1.inserted < 7)) throw new Error(`expected a partial write, got inserted=${e1.inserted}`);
  if (mid.length - before.length !== e1.inserted) throw new Error('the CLI count disagrees with the entry');
  h.log('RUN LOG tail:', lines(await h.eval("(document.querySelector('#dsRecProgress')?.innerText || '').split(String.fromCharCode(10)).slice(-4).join(' | ')"), 400));
  // ── History: the chip and ▶ Continue ──
  await h.eval(`document.querySelector('[data-view="history"]')?.click()`); await h.sleep(1200);
  const card = await h.eval("(document.querySelector('.ds-history-card')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 300)");
  h.log('CARD:', card);
  if (!/⏸ paused/.test(card)) throw new Error('no paused chip on the card');
  await h.eval("document.querySelector('[data-dsaction=\"continueRun\"]').click()");
  await h.waitFor("_currentView === 'deploy' && !!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000); await h.sleep(2000);
  const note = await h.eval("[...document.querySelectorAll('.ds-rec-card-line')].map(e => e.innerText).find(t => /Continue/.test(t)) || ''");
  h.log('CONTINUE NOTE:', lines(note, 400));
  h.log('SUMMARY (continue):', lines(await h.text('#dsDepSummary'), 200));
  const ticked = await h.eval("document.querySelectorAll('#dsDepList input[type=checkbox]:checked').length");
  h.log(`ticked on the Deploy page: ${ticked} (= 7 − ${e1.inserted} not reached, plus any that failed)`);
  if (ticked !== 7 - e1.inserted) throw new Error('Continue did not tick exactly the records not reached');
  const hist2 = await h.eval('_history.length');
  await h.click('#dsRecRunBtn'); await h.sleep(2000); await confirmRun(h);
  const e2 = await waitRunEnd(h, hist2);
  const end = tgtCx();
  h.log(`after Continue: entry ${JSON.stringify(e2)} · CLI target now ${end.length} (+${end.length - before.length} in all)`);
  if (e2.stopped) throw new Error('the continued run stopped early');
  // ── roll back both runs, newest first (the ↩ Roll back page + the one shared confirmation) ──
  for (let k = 0; k < 2; k++) {
    await h.eval(`document.querySelector('[data-view="history"]')?.click()`);
    await h.waitFor("!!document.querySelector('[data-dsaction=\"rollbackRun\"]:not([disabled])')", 20000, 500); await h.sleep(500);
    await h.eval(`document.querySelector('[data-dsaction="rollbackRun"]:not([disabled])').click()`);
    await h.waitFor("!!document.querySelector('#dsRbGo') || !!document.querySelector('.ds-rec-card-bad')", 300000, 1000); await h.sleep(1000);
    h.log(`ROLLBACK ${k + 1} summary:`, lines(await h.text('#dsRbSummary'), 200));
    if (!(await h.eval(`!!document.querySelector('#dsRbGo') && !document.querySelector('#dsRbGo').disabled`))) throw new Error('rollback Go not enabled');
    await h.eval(`document.querySelector('#dsRbGo').click()`);
    await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 20000, 300); await h.sleep(300);
    await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
    await h.sleep(300);
    await h.eval(`document.querySelector('#sftkConfirmGo')?.click()`);
    const rbBefore = await h.eval(`_history.filter(x => x.kind === 'rollback').length`);
    for (let i = 0; i < 900; i++) { if (await h.eval(`_history.filter(x => x.kind === 'rollback').length > ${rbBefore}`)) break; await h.sleep(1000); }
    await h.sleep(2000);
    h.log(`ROLLBACK ${k + 1} result:`, lines(await h.text('#dsRbResult'), 300));
  }
  const back = tgtCx();
  h.log(`CLI target after the rollbacks (${back.length}): ${back.length === before.length ? 'as before ✓' : 'DIFFERENT ❌ ' + back.join('; ')}`);
  if (back.length !== before.length) throw new Error('the rollbacks did not put the target back');
  h.log('✓ pause → continue: paused after a partial write (CLI agrees), History said so and offered Continue, Continue ticked exactly the rest, the rest landed, both runs rolled back');
}
