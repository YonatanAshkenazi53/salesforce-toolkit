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
  it('which legs run: the cheap scan skips every read that can only find a mention; the mentions scan skips the two blocker reads', () => {
    expect(F.fcScopeLegs('both')).toEqual({ flexiPages: true, reportTypes: true, listViews: true, compactLayouts: true, quickActions: true, matchingRules: true, workflowFieldUpdates: true });
    expect(F.fcScopeLegs('blockers')).toEqual({ flexiPages: false, reportTypes: false, listViews: false, compactLayouts: false, quickActions: false, matchingRules: true, workflowFieldUpdates: true });
    expect(F.fcScopeLegs('mentions')).toEqual({ flexiPages: true, reportTypes: true, listViews: true, compactLayouts: true, quickActions: true, matchingRules: false, workflowFieldUpdates: false });
  });
  it('the cost follows the scope: 9 fixed calls for everything, 4 for the blockers (no fan-out), 7 for the mentions', () => {
    expect(F.fcEstimateScanCalls(null)).toEqual({ now: 9, known: false, moreIf: ['Lightning page in the org', 'list view on this object', 'create/update quick action on this object', '10 custom report types in the org'] });
    expect(F.fcEstimateScanCalls(null, 'blockers')).toEqual({ now: 4, known: true, moreIf: [] });
    expect(F.fcEstimateScanCalls(null, 'mentions').now).toBe(7);
    expect(F.fcEstimateScanCalls({ flexiPages: 40, listViews: 6, quickActions: 3, reportTypes: 2 }, 'mentions')).toEqual({ now: 58, known: true, moreIf: [] });
    expect(F.fcEstimateScanCalls({ flexiPages: 40, listViews: 6, quickActions: 3, reportTypes: 2 }, 'blockers').now).toBe(4);   // the counts are of legs that do not run
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
    expect(FC).toContain('const scope = _scope, L = fcScopeLegs(scope);');
    expect(FC).toContain('if (L.flexiPages) flexiHits = await scanFlexiPages(deps);');
    expect(FC).toContain('if (L.reportTypes) rtHits = await scanReportTypes([...deps, ...flexiHits]);');
    expect(FC).toContain('supHits = await scanSupplemental([...deps, ...flexiHits, ...rtHits], fieldId, L);');
    expect(FC).toContain('_lastScan = { deps: [...deps, ...flexiHits, ...rtHits, ...supHits], fieldId, scope };');
    for (const leg of ['listViews', 'compactLayouts', 'quickActions', 'matchingRules', 'workflowFieldUpdates']) expect(FC).toContain(`if (L.${leg}) try {`);
  });
  it('the list is filtered by the scope; the gate counts every blocker the index returned, hidden or not', () => {
    expect(FC).toContain('const deps = (allDeps || []).filter(d => fcScopeKeeps(_scope, sevOf(d.MetadataComponentType || \'Unknown\')));');
    expect(FC).toContain("for (const d of (allDeps || [])) { const t = d.MetadataComponentType || 'Unknown'; (gateGroups[t] = gateGroups[t] || []).push(d); }");
    expect(FC).toContain("hidden: !fcScopeKeeps(_scope, 'blocker')");
    expect(FC).toContain('hidden by the 👀 scope — switch to 🔍 Everything to see them');
    expect(FC).toContain(`<button class="btn btn-danger" id="fcDelFreeBtn" \${hiddenBlockers.length ? 'disabled' : ''}>`);
    // a fixable blocker the scope hides (a flow under 👀) gates the delete too
    expect(FC).toContain('const delDisabled = autoCount > 0 || blockerTotal > 0 || hiddenFixable > 0;');
    expect(FC).toContain('hidden by the 👀 scope (flows and the like, fixable here)');
  });
  it('two sections, blockers first; a scan that read less says what it left out', () => {
    expect(FC.indexOf('id="fcSectionBlockers"')).toBeLessThan(FC.indexOf('id="fcSectionMentions"'));
    expect(FC).toContain('🔒 Must be cleared before Salesforce deletes the field');
    expect(FC).toContain('👀 Other mentions — the delete goes through, these break afterwards');
    expect(FC).toContain('<strong>The other mentions were not read</strong>');
    expect(FC).toContain('<strong>Matching rules and workflow field updates were not read</strong>');
    expect(CSS).toContain('.fc-section-blockers .fc-section-hdr { border-bottom-color: var(--danger, #c0392b); }');
  });
  it('switching the scope after a scan: shown again when the scan read it, else the button asks for a scan', () => {
    expect(FC).toContain("const covered = (_lastScan.scope || 'both') === 'both' || _lastScan.scope === _scope;");
    expect(FC).toContain('if (covered) renderResults(_lastScan.deps, _lastScan.fieldId);');
    expect(FC).toContain('not read by the last scan`');
  });
});
