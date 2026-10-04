// 📊 REPORTS & REPORT TYPES in the Field Cleaner (user, asked three times
// 2026-08-22 → 2026-08-31) — plus the managed-flow visibility fix from the
// same session (user 2026-09-01: "I dont see the flow from the first
// screenshot on the second screenshot feature").
//
// Everything rides the MODERN Analytics REST API per the user's rule
// ("always use the latest salesforce tech… soap api is very old"): report
// reads/writes via /analytics/reports, report types via
// /analytics/reportTypes, flow versions via FlowVersionView. No SOAP.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const FC  = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const DEP = readFileSync(new URL('../dependency-map.js', import.meta.url), 'utf8');

const F = extractFunctions('sftk-reportclean.js', [
  'sftkRptTokenMatch', 'sftkRptFieldHits', 'sftkRptStripField', 'sftkRtHits',
]);

describe('recognising the field in a report token', () => {
  it('matches every spelling Salesforce uses', () => {
    // dot (standard report types), dollar (custom report types), and the
    // aggregate prefix — all refer to the same field.
    expect(F.sftkRptTokenMatch('Account.My_Field__c', 'Account', 'My_Field__c')).toBe('definite');
    expect(F.sftkRptTokenMatch('Account$My_Field__c', 'Account', 'My_Field__c')).toBe('definite');
    expect(F.sftkRptTokenMatch('s!Account.My_Field__c', 'Account', 'My_Field__c')).toBe('definite');
  });

  it('a same-named field on ANOTHER object never matches', () => {
    expect(F.sftkRptTokenMatch('Lead.My_Field__c', 'Account', 'My_Field__c')).toBe(null);
  });

  it('a bare field name is only a MAYBE — never acted on', () => {
    // Acting on it could strip another object's same-named field.
    expect(F.sftkRptTokenMatch('My_Field__c', 'Account', 'My_Field__c')).toBe('possible');
  });

  it('is case-insensitive, like Salesforce API names', () => {
    expect(F.sftkRptTokenMatch('ACCOUNT.MY_FIELD__C', 'Account', 'My_Field__c')).toBe('definite');
  });
});

const META = {
  reportFormat: 'MATRIX',
  detailColumns: ['Account.My_Field__c', 'Account.Name'],
  reportFilters: [{ column: 'Account.My_Field__c', operator: 'equals', value: 'x' },
    { column: 'Account.Name' }],
  groupingsDown: [{ name: 'Account.My_Field__c' }],
  groupingsAcross: [{ name: 'Account.Industry' }],
  aggregates: ['s!Account.My_Field__c', 'RowCount'],
};

describe('finding the field in a report', () => {
  const h = F.sftkRptFieldHits(META, 'Account', 'My_Field__c');

  it('names the editable places separately', () => {
    expect(h.columns).toEqual(['Account.My_Field__c']);
    expect(h.filters).toEqual(['Account.My_Field__c']);
    expect(h.groupings).toEqual(['Account.My_Field__c']);
  });

  it('aggregates land in ELSEWHERE — their order feeds charts, never auto-edited', () => {
    expect(h.elsewhere).toBe(true);
  });

  it('a clean report reports nothing', () => {
    expect(F.sftkRptFieldHits({ detailColumns: ['Account.Name'] }, 'Account', 'My_Field__c').any).toBe(false);
  });
});

describe('the surgical strip', () => {
  it('removes what is safe and never mutates the input', () => {
    const before = JSON.stringify(META);
    const r = F.sftkRptStripField(META, 'Account', 'My_Field__c');
    expect(r.removed.columns).toBe(1);
    expect(r.removed.filters).toBe(1);
    expect(r.meta.detailColumns).toEqual(['Account.Name']);
    expect(JSON.stringify(META)).toBe(before);
  });

  it('refuses to strip a MATRIX report’s only row grouping — with the fix', () => {
    const r = F.sftkRptStripField(META, 'Account', 'My_Field__c');
    expect(r.removed.groupings).toBe(0);
    expect(r.meta.groupingsDown).toHaveLength(1);
    expect(r.manual.some(m => m.includes('only row grouping'))).toBe(true);
  });

  it('refuses to leave a report with ZERO columns', () => {
    const r = F.sftkRptStripField({ reportFormat: 'TABULAR',
      detailColumns: ['Account.My_Field__c'] }, 'Account', 'My_Field__c');
    expect(r.changed).toBe(false);
    expect(r.manual.some(m => m.includes('ONLY column'))).toBe(true);
  });

  it('a SUMMARY report may lose a column grouping but keeps its last row grouping', () => {
    const r = F.sftkRptStripField({ reportFormat: 'SUMMARY',
      detailColumns: ['Account.Name', 'Account.My_Field__c'],
      groupingsDown: [{ name: 'Account.My_Field__c' }] }, 'Account', 'My_Field__c');
    expect(r.removed.columns).toBe(1);
    expect(r.removed.groupings).toBe(0);
    expect(r.manual.some(m => m.includes('only row grouping'))).toBe(true);
  });

  it('names formula/bucket references as manual instead of touching them', () => {
    const r = F.sftkRptStripField(META, 'Account', 'My_Field__c');
    expect(r.manual.some(m => m.includes('formula, bucket, cross filter or chart'))).toBe(true);
  });
});

describe('report types', () => {
  it('finds matching column keys anywhere the describe nests them', () => {
    const d = { reportTypeMetadata: { categories: [
      { label: 'Accounts', columns: { 'Account.My_Field__c': {}, 'Account.Name': {} } },
      { label: 'Other', columns: { 'My_Field__c': {} } },
    ] } };
    const h = F.sftkRtHits(d, 'Account', 'My_Field__c');
    expect(h.definite).toEqual(['Account.My_Field__c']);
    expect(h.possible).toEqual(['My_Field__c']);
  });
});

describe('the Field Cleaner wiring keeps the laws', () => {
  it('Reports and Report Types are TYPES in the everyday scan — no org-wide sweep', () => {
    // User 2026-09-01: "it should be one of the metadata items that we scan
    // everytime … scanning all the reports in the org is not a good
    // solution". The dependency index lists them — when it does: live
    // 2026-10-04 it returned none, so an OPT-IN sweep was added (user: "both").
    // The everyday scan still never reads the reports (test/report-sweep-1004).
    expect(FC).toMatch(/Report:\s+\{ icon: '\u{1F4CA}', label: 'Reports',\s+fixable: true/u);
    expect(FC).toMatch(/ReportType:\s+\{ icon: '\u{1F4D1}', label: 'Report Types',\s+fixable: false, sev: 'blocker'/u);
    expect(FC).not.toContain('FROM Report\'');
    expect(FC).not.toContain('fcScanReports');
  });

  it('rides the modern Analytics REST API — no SOAP anywhere', () => {
    expect(FC).toContain('analytics/reports/${reportId}/describe');
    expect(FC).not.toContain('/services/Soap/m');
  });

  it('saves the restore point BEFORE the report is written', () => {
    const fix = FC.slice(FC.indexOf('async function fixReport'));
    expect(fix.indexOf("_snapshotFix('Report'")).toBeGreaterThan(-1);
    expect(fix.indexOf("_snapshotFix('Report'")).toBeLessThan(fix.indexOf("type: 'SF_PATCH'"));
  });

  it('verifies after writing and never assumes clean', () => {
    expect(FC).toContain('verified: no references remain');
    expect(FC).toContain('some references remain');
  });

  it('a failed or refused fix carries a link to the report', () => {
    expect(FC).toMatch(/err\.setupUrl = `\$\{_orgUrl\.replace\(\/\\\/\$\/, ''\)\}\/lightning\/r\/Report\/\$\{reportId\}\/view`/);
  });

  it('fixOne routes Report hits to the fix and restore reverses it', () => {
    expect(FC).toMatch(/if \(type === 'Report'\)\s+label = await fixReport\(componentId, componentName\)/);
    expect(FC).toMatch(/snap\.type === 'Report'/);
  });

  it('report types say plainly there is no modern write API', () => {
    expect(FC).toContain('no modern API for editing report-type columns');
    expect(FC).toContain("ReportType:     '/lightning/setup/CustomReportTypes/home'");
  });

  it('the note explains where reports come from and what is still unscanned', () => {
    expect(FC).toContain('the same one behind');
    // templates and approvals ride the index too — the note says the index is not guaranteed to list them
    expect(FC).toMatch(/EmailTemplate:\s+\{ icon: '✉️', label: 'Email Templates',\s+fixable: false, sev: 'blocker'/);
    expect(FC).toMatch(/ApprovalProcess:\{ icon: '✅', label: 'Approval Processes', fixable: false, sev: 'blocker'/);
    expect(FC).toContain('only when that index reports');
    expect(FC).toContain('Not scanned at all');
  });
});

describe('managed flows are visible and protected', () => {
  it('flow versions come from FlowVersionView — the view that includes managed flows', () => {
    expect(DEP).toContain('FROM FlowVersionView');
    expect(DEP).toContain('FlowDefinitionView.NamespacePrefix');
  });

  it('FlowVersionView is read WITH the filter Salesforce requires (live 2026-09-03: unfiltered = MALFORMED_QUERY)', () => {
    // Without it the read failed silently and fell back to Tooling, which has
    // no managed flows at all — the user saw none.
    expect(DEP).toMatch(/FROM FlowVersionView WHERE FlowDefinitionViewId IN \(\$\{inList\}\)/);
    expect(DEP).toContain("SELECT DurableId, ApiName, Label, NamespacePrefix, ManageableState, TriggerType, TriggerObjectOrEventLabel FROM FlowDefinitionView");
    // a managed version's DurableId is 'ns__Name-N', never a record Id → no link
    expect(DEP).toMatch(/Id: isId\(v\.DurableId\) \? v\.DurableId : null/);
  });

  it('a fallback to the older API is DISCLOSED, not silent', () => {
    expect(DEP).toContain('managed-package flows may be missing');
  });

  it('the MAIN Dependencies list shows managed flows in a 🔒 section and says their contents are hidden (user 2026-09-03: "where are the managed flows?")', () => {
    expect(DEP).toContain('async function loadManagedFlows(orgUrl, sid)');
    expect(DEP).toContain("id = 'depManagedSection'");
    expect(DEP).toContain('contents hidden by Salesforce; dependencies unknown, not empty');
    // read even while loading — absence is never mistaken for "none"
    expect(DEP).toContain('🔒 Managed package flows — reading…');
    // the org switch must not carry them over
    expect(DEP).toMatch(/function reset\(\) \{[\s\S]{0,300}_managedFlows = null;/);
    // and the "what uses" search says it could not read them
    expect(DEP).toContain('No flow that could be read mentions');
    expect(DEP).toContain('their contents are hidden by Salesforce, so they were not searched');
    const POP = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
    expect(POP).toContain('DependencyMap.loadManagedFlows(loadOrgUrl, loadSid)');
  });

  it('a managed flow’s version can never be offered for change', () => {
    const SRC = readFileSync(new URL('../sftk-apiver.js', import.meta.url), 'utf8');
    expect(SRC).toContain("installed from a managed package — its API version ships with the package");   // 2026-09-21: one reason text, shared by the checkbox and the plan
    expect(DEP).toContain('🔒 managed');
  });
});

describe('unscanned is UNKNOWN, never "standalone" or "calls no subflows" (user 2026-09-03: "copy of test has a subflow and it wont show here")', () => {
  const G = extractFunctions('dependency-map.js', ['depFlowScanState', 'depCallsOfVersion']);

  it('reports per flow how many of its versions the scan actually read', () => {
    const vs = [{ Id: 'a' }, { Id: 'b' }, { Id: 'c' }];
    expect(G.depFlowScanState(vs, new Set(['a', 'b', 'c']))).toEqual({ total: 3, scanned: 3, unscanned: 0, state: 'scanned' });
    expect(G.depFlowScanState(vs, new Set(['a']))).toEqual({ total: 3, scanned: 1, unscanned: 2, state: 'partial' });
    expect(G.depFlowScanState(vs, new Set())).toEqual({ total: 3, scanned: 0, unscanned: 3, state: 'unscanned' });
    expect(G.depFlowScanState([], new Set()).state).toBe('unscanned');
  });

  it('reads one version\u2019s own calls back out of the called-keyed map', () => {
    const map = { Sub_A: [{ id: 'v1' }, { id: 'v9' }], Sub_B: [{ id: 'v1' }], Sub_C: [{ id: 'v2' }] };
    expect(G.depCallsOfVersion(map, 'v1')).toEqual(['Sub_A', 'Sub_B']);
    expect(G.depCallsOfVersion(map, 'v7')).toEqual([]);
  });

  it('the list, the Standalone header and the chain panel all say "unknown" for an unscanned flow', () => {
    expect(DEP).toContain('⏳ not scanned — calls unknown');
    expect(DEP).toContain('of them not scanned: their calls are unknown, not none');
    expect(DEP).toMatch(/const downEmptyText = sc\.state === 'scanned'/);
    expect(DEP).toContain('this flow\\\'s metadata has not been read');
    expect(DEP).toContain('No SCANNED flow calls this one');
    // and the evidence: per version, read or not, and what it called
    expect(DEP).toContain('This flow\'s versions — what the scan actually read');
    expect(DEP).toContain('NOT scanned — calls unknown');
    expect(DEP).not.toContain("'<div class=\"dep-blast-item\">Calls no subflows.</div>'");
  });
});
