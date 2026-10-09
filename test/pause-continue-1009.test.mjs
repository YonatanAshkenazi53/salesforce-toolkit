import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const BG = read('background.js'), REC = read('studio-reconcile.js'), HIST = read('studio-history.js'), CORE = read('studio-core.js'), SCAN = read('studio-scan.js'), DEP = read('studio-deploy.js');
const lineFn = new Function(BG.slice(BG.indexOf('function sftkRunStopLine('), BG.indexOf('\n}\n', BG.indexOf('function sftkRunStopLine(')) + 3) + ' return sftkRunStopLine;')();
const contFn = new Function(DEP.slice(DEP.indexOf('function sftkDeployContinueLine('), DEP.indexOf('\n}\n', DEP.indexOf('function sftkDeployContinueLine(')) + 3) + ' return sftkDeployContinueLine;')();

// User 2026-10-09: "make sure users can pause a long deployment and continue from where they
// left. also if you close the window in the middle of deployment we must state it … should also
// ask if someone tried to use the X in the chrome tab in the middle of data deployment".
describe('a deployment can be paused and continued; a closed page stops it and says so', () => {
  it('the engine stops between batches on pause, cancel, or a page that went away, and names why', () => {
    expect(BG).toContain("if (msg?.cmd === 'pause') { _runCancelled = true; _runStopWhy = 'pause'; }");
    expect(BG).toContain("if (_runHeartbeat && !_runCancelled) { _runCancelled = true; _runStopWhy = 'closed'; }");
    expect(BG).toContain("...(_runCancelled ? { cancelled: true, stopped: _runStopReason() } : {}),");
    expect(BG).toContain("function _runNoteStop(line) { try { if (_runStopWhy === 'closed') _runStopLineLast = line; } catch (_) { /* harness */ } return line; }");
    expect(lineFn('pause', 'Account', 200, 1000)).toBe('Account: ⏸ paused after 200 of 1000 record(s) — nothing is half-written; the rest is still to deploy — ▶ Continue from History.');
    // live 2026-10-09: one written and one refused before the pause are BOTH sent
    expect(lineFn('pause', 'Account', 1, 7, 1)).toBe('Account: ⏸ paused after 2 of 7 record(s) (1 written, 1 failed) — nothing is half-written; the rest is still to deploy — ▶ Continue from History.');
    expect(BG).toContain("errors.push(_runNoteStop(sftkRunStopLine(_runStopReason(), objType, ok, payloads.length, fail)));");
    expect(lineFn('closed')).toBe('⏹ the page was closed — the run stopped before the next object; the rest is still to deploy — ▶ Continue from History.');
    expect(lineFn('cancel')).toBe('cancelled before the next object — remaining objects skipped.');
  });
  it('the Deploy run shows ⏸ Pause and the note about closing the tab, and keeps the selection and the reason in History', () => {
    expect(REC).toContain('id="dsRunPauseBtn"');
    expect(REC).toContain("recPort?.postMessage({ cmd: 'pause' });");
    expect(REC).toContain('Keep this tab open: closing it pauses the run after the batch in flight. Paused runs continue from History.');
    expect(REC).toContain("selected:     { '': treePushIds, ...Object.fromEntries(childActs.filter(a => a.groupA.length).map(a => [a.pathKey, [...a.groupA]])) },");
    expect(REC).toContain("...(stoppedWhy ? { stopped: stoppedWhy } : {}),");
    expect((REC.match(/if \(res && res\.stopped\) stoppedWhy = res\.stopped;/g) || []).length).toBe(4);
  });
  it('a run whose page closed leaves its stop line for the next Data Studio page, which says it once', () => {
    expect(BG).toContain("if (_runStopWhy === 'closed' && _runStopLineLast) {");
    expect(BG).toContain("chrome.storage.local.set({ sftk_run_interrupted: { at: new Date().toISOString(), line: _runStopLineLast } }).catch(() => {});");
    expect(CORE).toContain("if (d.sftk_run_interrupted && d.sftk_run_interrupted.line) {");
    expect(CORE).toContain("A deployment stopped when its page was closed");
    expect(CORE).toContain("chrome.storage.local.remove(['sftk_run_interrupted', 'sftk_active_run']).catch(() => {});");
  });
  it('the browser asks before the tab closes while a run is on', () => {
    expect(CORE).toContain("window.addEventListener('beforeunload', e => {\n  if (window._sftkRunActive) { e.preventDefault(); e.returnValue = ''; }\n});");
  });
  it('History shows the reason and offers ▶ Continue, which re-ticks what was ticked', () => {
    expect(HIST).toContain('⏸ paused</span>');
    expect(HIST).toContain('⏹ page closed</span>');
    expect(HIST).toContain('data-dsaction="continueRun"');
    expect(CORE).toContain("case 'continueRun':           window.continueRun?.(arg); break;");
    expect(SCAN).toContain("window.sftkDeployRetry(profile.id, byPath, run.tgtOrgUrl || run.targetOrg || undefined, 'continue')");
    expect(DEP).toContain("_depRetryNote = _depRetry.mode === 'continue' ? sftkDeployContinueLine(rp) : sftkDeployRetryLine(rp);");
    expect(contFn({ found: 6, total: 7, inChanged: 0, inTarget: 1, lost: 1 })).toBe('▶ Continue: 6 of the 7 record(s) you had ticked are ticked again under 🔴 Insert — the run did not reach them. 1 is in the target already (written before the stop) and is left alone. Check the ticks, then ▶ Deploy.');
    expect(contFn({ found: 3, total: 7, inChanged: 0, inTarget: 4, lost: 4 })).toBe('▶ Continue: 3 of the 7 record(s) you had ticked are ticked again under 🔴 Insert — the run did not reach them. 4 are in the target already (written before the stop) and are left alone. Check the ticks, then ▶ Deploy.');
  });
});
