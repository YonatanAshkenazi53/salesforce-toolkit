import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const HTML = readFileSync(new URL('../popup.html', import.meta.url), 'utf8');
const PJ = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const FI = readFileSync(new URL('../sftk-flowinterviews.js', import.meta.url), 'utf8');
const FS = readFileSync(new URL('../sftk-flowsurgery.js', import.meta.url), 'utf8');
const HIST = readFileSync(new URL('../sftk-history.js', import.meta.url), 'utf8');
const MAN = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

// User 2026-10-17: "merge the page of flows and dependencies into a one page with all the features … add an
// option to delete flows or flows with versions … along with failed interview and rollback".
describe('one Flows page', () => {
  it('the Dependencies tab is gone from the sidebar; its containers live inside the Flows tab', () => {
    expect(HTML).not.toContain('data-tab="dependencies"');
    const flows = HTML.indexOf('id="tab-flows"'), deps = HTML.indexOf('id="tab-dependencies"'), next = HTML.indexOf('id="tab-debugger"');
    expect(flows).toBeGreaterThan(0); expect(deps).toBeGreaterThan(flows); expect(next).toBeGreaterThan(deps);
    expect(HTML).toContain('<div id="tab-dependencies" class="flow-view" style="display:none">');   // not a tab-content: navigateToTab leaves it alone
    expect(HTML).toContain('id="depTreeContainer"');
    for (const v of ['versions', 'deps', 'switches', 'apiver']) expect(HTML).toContain(`class="flow-view-btn${v === 'versions' ? ' active' : ''}" data-view="${v}"`);
    expect(HTML).toContain('<script src="sftk-flowinterviews.js"></script>');
    expect(readFileSync(new URL('../styles.css', import.meta.url), 'utf8')).toContain('.flow-views { margin-bottom: 8px; flex-shrink: 0; }');
  });
  it('every deep link to the old tab lands on the Flows page, Dependencies view', () => {
    expect(PJ).toContain("if (tabName === 'dependencies') { navigateToTab('flows'); setFlowView('deps'); return; }");
    expect(PJ).not.toContain("id: 'dependencies',\n    i: 'share',");
    expect(PJ).toContain("ids: ['flows', 'debugger']");
    expect(PJ).toContain("else if (v === 'switches') DependencyMap.renderSwitchesPanel(host, orgUrl, sid);");
    expect(PJ).toContain("else DependencyMap.renderApiVersionsPanel(host, orgUrl, sid);");
    expect(HTML).toContain('<div id="flowToolHost" style="display:none"></div>');
    // the switches panel reloads itself in either host (the reload did nothing on the Switches view — 2026-10-18)
    expect(readFileSync(new URL('../dependency-map.js', import.meta.url), 'utf8')).toContain("const mount = out.closest('#depToolPanel, #flowToolHost');");
  });
  it('History shows the switches, API versions and interviews changes on the Flows tab', () => {
    expect(HIST).toContain("'Flow switches': 'flows', 'API versions': 'flows'");
    expect(HIST).toContain("'Flow interviews': 'flows'");
  });
});

describe('whole flows, interviews and the restore point', () => {
  it('sftkFlowWholeDefinitions: a flow is whole only when every version of it is selected', () => {
    const i = PJ.indexOf('function sftkFlowWholeDefinitions(');
    const fn = new Function(PJ.slice(i, PJ.indexOf('\n}\n', i) + 3) + ' return sftkFlowWholeDefinitions;')();
    const flows = [{ Id: 'a1', DefinitionId: 'A' }, { Id: 'a2', DefinitionId: 'A' }, { Id: 'b1', DefinitionId: 'B' }];
    expect([...fn(flows, new Set(['a1', 'a2']))]).toEqual(['A']);
    expect([...fn(flows, new Set(['a1', 'b1']))]).toEqual(['B']);
    expect(fn(flows, new Set()).size).toBe(0);
  });
  it('the row offers the whole flow, the summary and the confirmation say what that means', () => {
    expect(PJ).toContain("wholeBtn.textContent = currentMode === 'delete' ? '🗑 whole flow' : '✓ all versions';");
    expect(PJ).toContain("whole flow — with its last version the flow itself is removed");
    expect(PJ).toContain("(every version: the flow itself goes)");
  });
  it('interviews: pure helpers group by the 15-character id and word the chip', () => {
    const ctx = {}; vm.createContext(ctx);
    vm.runInContext(FS.replace(/^'use strict';/, ''), ctx);
    vm.runInContext(FI.replace(/^'use strict';/, ''), ctx);
    const by = ctx.sftkFlowInterviewsByVersion([
      { Id: 'i1', FlowVersionViewId: '301xx0000000AbC', InterviewStatus: 'Paused' },
      { Id: 'i2', FlowVersionViewId: '301xx0000000AbC', InterviewStatus: 'Error' },
      { Id: 'i3', FlowVersionViewId: '301xx0000000XyZ', InterviewStatus: 'Error' }]);
    const list = ctx.sftkFlowInterviewsFor(by, ['301xx0000000AbCAAA']);   // the 18-character id finds the 15-character rows
    expect(list.map(x => x.Id)).toEqual(['i1', 'i2']);
    expect(ctx.sftkFlowInterviewChip(ctx.sftkFlowInterviewKinds(list))).toBe('⏸ 1 paused · ✖ 1 failed');
    expect(ctx.sftkFlowInterviewLine({ InterviewStatus: 'Error', InterviewLabel: 'Nightly', CurrentElement: 'Update_Account', CreatedDate: '2026-10-16T10:00:00.000+0000' }))
      .toBe('failed run “Nightly” at Update_Account (2026-10-16)');
    expect(ctx.SFTK_FLOW_INTERVIEW_SOQL).toContain('FROM FlowInterview');
  });
  it('a version delete asks for both id forms, keeps the interviews, and deletes them before the versions', () => {
    expect(PJ).toContain("return s.length === 18 ? [s, s.substring(0, 15)] : [s]; }))].map(x => `'${x}'`).join(',');");
    expect(PJ).toContain('_pendingInterviews = interviews;');
    expect(PJ).toContain("const ir = await sftkFlowInterviewsDelete({ send: sendBg, orgUrl, sid, interviews: _pendingInterviews, journal });");
    const a = PJ.indexOf('Deleting ${_pendingInterviews.length} flow interview(s) first'), b = PJ.indexOf('for (const flow of deletable)');
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a);
  });
  it('rollback: a restore point per version first, a version without one is not deleted, undo re-deploys as Draft', () => {
    expect(PJ).toContain("const md = await sendBg({ type: 'SF_GET_METADATA', orgUrl, sid, id: flow.Id });");
    expect(PJ).toContain("const zipBase64 = window.sftkBuildFlowZip(api, { ...md.Metadata, status });");
    expect(PJ).toContain("NOT deleted — its restore point could not be kept");
    expect(PJ).toContain("const deletable = toDelete.filter(f => restore.has(f.DefinitionId));");
    expect(PJ).toContain("msg: { type: 'SF_METADATA_DEPLOY', zipBase64: rp.zipBase64 },");
    expect(PJ).toContain("WHERE Definition.DeveloperName = '${safeApi}' AND Status = '${rp.status}'`,");
    expect(PJ).toContain("tooling: true, where: { field: 'Status', equals: rp.status }, retries: 4,");   // a whole flow comes back as v1 — a number it held
    // one version per flow: the active one, else the newest (a deploy overwrites a Draft — live 2026-10-17)
    const i = PJ.indexOf('function sftkFlowRestoreTargets(');
    const pick = new Function(PJ.slice(i, PJ.indexOf('\n}\n', i) + 3) + ' return sftkFlowRestoreTargets;')();
    const got = pick([{ Id: 'a2', DefinitionId: 'A', VersionNumber: 2, Status: 'Obsolete' }, { Id: 'a9', DefinitionId: 'A', VersionNumber: 9, Status: 'Obsolete' },
      { Id: 'a5', DefinitionId: 'A', VersionNumber: 5, Status: 'Active' }, { Id: 'b1', DefinitionId: 'B', VersionNumber: 1, Status: 'Obsolete' }, { Id: 'b3', DefinitionId: 'B', VersionNumber: 3, Status: 'Draft' }]);
    expect(got.get('A').Id).toBe('a5'); expect(got.get('B').Id).toBe('b3');
    // an active version is switched off first, never tried blind (its refusal made a run "partial")
    expect(PJ).not.toContain('// Step 1: try direct delete (Tooling API sometimes allows it)');
    expect(PJ).toContain("const allSteps = [...restoreSteps, ...steps];");
    expect(PJ).not.toContain("{ none: 'deleted flow versions cannot be re-created' }");
    expect(MAN.permissions).toContain('unlimitedStorage');
  });
  it('the confirmation no longer calls the delete permanent', () => {
    expect(PJ).toContain("revOverride: { html: 'A restore point of every flow is kept in History before anything is deleted;");
    expect(PJ).not.toContain("Only flows you backed up (⬇) can come back");
  });
});
