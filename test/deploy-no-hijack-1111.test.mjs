// QA 2026-11-11 (allorgs-compare and engine-duplicate-rules on the packed 1.1.0 build): a deployment was opened, the
// user moved to another page (Org Compare, History) while the Deploy page was still reading or finishing a run, and
// when that ended renderReconcile() drew the Deploy page over the page they were on. A repaint for a page nobody is on
// draws nothing; a door names its view first.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const R = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const REC = R('studio-reconcile.js');

describe('a repaint never pulls the user back to the Deploy page', () => {
  it('renderReconcile returns before anything else when another page is open', () => {
    const body = REC.slice(REC.indexOf('async function renderReconcile() {'));
    const guard = body.indexOf("if (_reconcileProfile && _currentView !== 'deploy' && _currentView !== 'reconcile') return;");
    const seam = body.indexOf("{ _currentView = 'deploy'; return renderDeploy(); }");
    expect(guard).toBeGreaterThan(0);
    expect(seam).toBeGreaterThan(guard);
  });
  it('every door sets the view before it calls', () => {
    const VIEW = "_currentView = (typeof sftkDeployViewOn === 'function' && sftkDeployViewOn()) ? 'deploy' : 'reconcile';";
    expect(REC).toContain(VIEW + '\n  renderReconcile();');                       // window.openReconcile
    expect(R('studio-builder.js')).toContain('_reconcileProfile = eph;\n      ' + VIEW);
    expect(R('studio-compare.js')).toContain("_currentView = 'reconcile';");
    expect(R('studio-seed.js')).toContain("_currentView = 'reconcile';");
    expect(R('studio-deploy.js')).toContain("window.sftkOpenDeployView = function () {\n  if (!_reconcileProfile) return;\n  _currentView = 'deploy';");
  });
});

// QA 2026-11-11 (retry-and-rollback, npc → npc2): ↻ Retry failed opened the Deploy page on the scan from before the
// run, ticked the failed record, and the queued fresh read then reset every selection — the banner still said
// "1 of 1 failed record(s) are ticked" and ▶ Deploy had nothing to write.
describe('↻ Retry ticks on the scan the user acts on', () => {
  const DEP = R('studio-deploy.js');
  it('a render that has a fresh read queued leaves the retry request for the next one', () => {
    expect(DEP).toContain('      rescanQueued = true;\n      setTimeout(() => _depRescan(p), 0);');
    expect(DEP).toContain('if (_depRetry && !rescanQueued && (_depRetry.profileId === p.id');
  });
  it('the Deploy page itself never repaints over another page', () => {
    const i = DEP.indexOf('async function renderDeploy() {');
    expect(DEP.slice(i, i + 400)).toContain("if (_reconcileProfile && _currentView !== 'deploy' && _currentView !== 'reconcile') return;");
  });
});
