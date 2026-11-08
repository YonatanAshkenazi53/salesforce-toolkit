// Field Cleaner's scope (2026-11-05, a colleague's first day with the tool:
// "show the dependencies that are required for deleting the field, and also
// the other mentions that don't, and allow to scan both of the options").
// The rule worth testing: a blocker the index returned is never hidden from
// the DECISION (the delete gate), only from the list; a scope that read less
// says what it left out.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const F = extractFunctions('field-cleaner.js', ['fcScopeNorm', 'fcScopeKeeps', 'fcScopeLegs', 'fcScopeLabel', 'fcScopeHelp', 'fcEstimateScanCalls']);
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

describe('the scope', () => {
  it('three values, anything else is "both"', () => {
    expect(F.fcScopeNorm('blockers')).toBe('blockers');
    expect(F.fcScopeNorm('mentions')).toBe('mentions');
    for (const x of ['both', '', null, undefined, 'all', 42]) expect(F.fcScopeNorm(x)).toBe('both');
  });
  it('what each scope keeps in the list: by the type\'s severity', () => {
    expect(F.fcScopeKeeps('both', 'blocker')).toBe(true);
    expect(F.fcScopeKeeps('both', 'silent')).toBe(true);
    expect(F.fcScopeKeeps('blockers', 'blocker')).toBe(true);
    expect(F.fcScopeKeeps('blockers', 'silent')).toBe(false);
    expect(F.fcScopeKeeps('mentions', 'blocker')).toBe(false);
    expect(F.fcScopeKeeps('mentions', 'silent')).toBe(true);
    expect(F.fcScopeKeeps('mentions', undefined)).toBe(true);   // an unknown type is listed under mentions, counted by the gate as a blocker (TYPE_CFG_DEFAULT)
  });
  it('which legs run (live-tested 2026-11-06): a Lightning page BLOCKS, so its leg runs in every scope; the cheap scan skips every read that can only find a mention; the mentions scan skips every blocker read', () => {
    const B = { matchingRules: true, workflowFieldUpdates: true, workflow: true, approvals: true, sharingRules: true, duplicateRules: true, lwc: true, customMetadata: true };
    const M = { reportTypes: true, listViews: true, compactLayouts: true, quickActions: true, paths: true, validationRulesOff: true };   // +validationRulesOff 2026-11-07: an inactive rule is a mention the index never returns
    const off = o => Object.fromEntries(Object.keys(o).map(k => [k, false]));
    expect(F.fcScopeLegs('both')).toEqual({ flexiPages: true, ...B, leadMapping: false, objectRules: false, ...M });
    expect(F.fcScopeLegs('blockers')).toEqual({ flexiPages: true, ...B, leadMapping: false, objectRules: false, ...off(M) });
    expect(F.fcScopeLegs('mentions')).toEqual({ flexiPages: true, ...off(B), leadMapping: false, objectRules: false, ...M });
    // the lead mapping is read for Lead and its targets; assignment/auto-response/escalation rules for Lead and Case
    expect(F.fcScopeLegs('both', 'Lead')).toMatchObject({ leadMapping: true, objectRules: true });
    expect(F.fcScopeLegs('both', 'Account')).toMatchObject({ leadMapping: true, objectRules: false });
    expect(F.fcScopeLegs('both', 'Case')).toMatchObject({ leadMapping: false, objectRules: true });
    expect(F.fcScopeLegs('both', 'My_Obj__c')).toMatchObject({ leadMapping: false, objectRules: false });
    expect(F.fcScopeLegs('mentions', 'Lead')).toMatchObject({ leadMapping: false, objectRules: false });
  });
  it('the cost follows the scope: 19 fixed calls for everything, 13 for the blockers, 9 for the mentions; the fan-outs stay a "more if" until known', () => {
    const FAN = ['Lightning page in the org', 'list view on this object', 'create/update quick action on this object', '10 custom report types in the org', 'workflow rule, alert or outbound message on this object', '10 approval processes on this object', '10 duplicate rules on this object', '10 custom metadata records in the org (read up to 300)'];
    expect(F.fcEstimateScanCalls(null)).toEqual({ now: 19, known: false, moreIf: FAN });
    expect(F.fcEstimateScanCalls(null, 'blockers')).toEqual({ now: 13, known: false, moreIf: FAN.filter(w => !/list view|quick action|report types/.test(w)) });
    expect(F.fcEstimateScanCalls(null, 'mentions')).toEqual({ now: 9, known: false, moreIf: FAN.slice(0, 4) });
    expect(F.fcEstimateScanCalls({ flexiPages: 40, listViews: 6, quickActions: 3, reportTypes: 2 }, 'mentions')).toEqual({ now: 60, known: true, moreIf: [] });
    expect(F.fcEstimateScanCalls({ flexiPages: 40, listViews: 6, quickActions: 3, reportTypes: 2, workflowRules: 2, approvals: 1, duplicateRules: 1, customMetadata: 0 }, 'blockers')).toEqual({ now: 57, known: true, moreIf: [] });   // 13 + 40 pages + 2 + 1 + 1
    // the lead mapping and the Lead/Case rules are read only for those objects: +1 and +3 fixed calls
    expect(F.fcEstimateScanCalls(null, 'blockers', 'Account').now).toBe(14);
    expect(F.fcEstimateScanCalls(null, 'blockers', 'Lead').now).toBe(17);
  });
  it('the words: a label per scope and a help line that says what is NOT read', () => {
    expect(F.fcScopeLabel('both')).toBe('🔍 Everything');
    expect(F.fcScopeLabel('blockers')).toBe('🔒 What blocks the delete');
    expect(F.fcScopeLabel('mentions')).toBe('👀 Other mentions');
    expect(F.fcScopeHelp('blockers')).toContain('are not read');
    expect(F.fcScopeHelp('blockers')).toContain('never block the delete');
    expect(F.fcScopeHelp('mentions')).toContain('still counted for the Delete button');
    expect(F.fcScopeHelp('both')).toContain('Listed apart below');
  });
});

describe('wiring', () => {
  it('the switch sits above the scan button, is shown with it, and is kept in sftk_fc_scope', () => {
    expect(FC).toContain('<div class="mode-toggle fc-scope" id="fcScope" role="radiogroup" aria-label="What to scan">');
    expect(FC.indexOf('id="fcScopeWrap"')).toBeLessThan(FC.indexOf('<button id="fcScanBtn"'));
    expect(FC).toContain("scanBtn.onclick       = runScan;\n    }\n    _paintScope();");
    expect(FC).toContain("await chrome.storage.local.set({ sftk_fc_scope: _scope });");
    expect(FC).toContain("chrome.storage?.local?.get('sftk_fc_scope')");
  });
  it('the scan runs the legs of its scope and remembers which scope it read', () => {
    expect(FC).toContain('const scope = _scope, L = fcScopeLegs(scope, _selObj.api);');
    expect(FC).toContain('if (L.flexiPages) flexiHits = await scanFlexiPages(deps);');
    expect(FC).toContain('if (L.reportTypes) rtHits = await scanReportTypes([...deps, ...flexiHits]);');
    expect(FC).toContain('supHits = await scanSupplemental([...deps, ...flexiHits, ...rtHits], fieldId, L);');
    expect(FC).toContain('_lastScan = { deps: [...deps, ...flexiHits, ...rtHits, ...supHits], fieldId, scope };');
    for (const leg of ['listViews', 'compactLayouts', 'quickActions', 'matchingRules', 'workflowFieldUpdates', 'workflow', 'approvals', 'sharingRules', 'duplicateRules', 'lwc', 'customMetadata', 'leadMapping', 'objectRules', 'paths']) expect(FC).toContain(`if (L.${leg}) try {`);
  });
  it('the list is filtered by the scope; the gate counts every blocker the index returned, hidden or not', () => {
    expect(FC).toContain('const deps = (allDeps || []).filter(d => fcScopeKeeps(_scope, sevOf(d.MetadataComponentType || \'Unknown\')));');
    expect(FC).toContain("for (const d of (allDeps || [])) { const t = d.MetadataComponentType || 'Unknown'; (gateGroups[t] = gateGroups[t] || []).push(d); }");
    expect(FC).toContain("hidden: !fcScopeKeeps(_scope, 'blocker')");
    // the 👀 scope hides every blocker: one sentence with the way out, no chips (user 2026-11-08: "what is the point of all this info")
    expect(FC).toContain("const scopeHides = !fcScopeKeeps(_scope, 'blocker');");
    expect(FC).toContain('const blockerBlock = blockerTotal > 0 && !scopeHides ? `');
    expect(FC).toContain('the delete — this view shows only the 👀 mentions.');
    expect(FC).toContain('class="btn btn-secondary btn-sm fc-scope-jump" data-scope="both">🔍 Everything</button> shows and fixes them — scan again after switching.');
    expect(FC).toContain(`<button class="btn btn-danger" id="fcDelFreeBtn" \${hiddenBlockers.length ? 'disabled' : ''}>`);
    // a fixable blocker the scope hides (a flow under 👀) gates the delete too
    expect(FC).toContain('const delDisabled = autoCount > 0 || blockerTotal > 0 || hiddenFixable > 0;');
    expect(FC).toContain('const hiddenBlock = scopeHides && hiddenTotal > 0 ? `');
  });
  it('two sections, blockers first; a scan that read less says what it left out', () => {
    expect(FC.indexOf('id="fcSectionBlockers"')).toBeLessThan(FC.indexOf('id="fcSectionMentions"'));
    expect(FC).toContain('🔒 Must be cleared before Salesforce deletes the field');
    expect(FC).toContain('👀 Other mentions — the delete goes through, these break afterwards');
    expect(FC).toContain('<strong>The other mentions were not read</strong>');
    expect(FC).toContain('<strong>The blockers outside the dependency index were not read</strong>');
    expect(CSS).toContain('.fc-section-blockers .fc-section-hdr { border-bottom-color: var(--danger, #c0392b); }');
  });
  it('switching the scope after a scan: shown again when the scan read it, else the button asks for a scan', () => {
    expect(FC).toContain("const covered = (_lastScan.scope || 'both') === 'both' || _lastScan.scope === _scope;");
    expect(FC).toContain('if (covered) renderResults(_lastScan.deps, _lastScan.fieldId);');
    expect(FC).toContain('not read by the last scan`');
  });
});
