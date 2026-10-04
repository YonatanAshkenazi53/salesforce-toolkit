// Field Cleaner — the opt-in report sweep.
// Live 2026-10-04: Salesforce's dependency index returned NO reports for two
// public reports that used a field (0 Report rows even with an explicit type
// filter), while the note under the results said reports "are covered by the
// scan". The note was made honest, and the user chose BOTH: keep the note and
// add a scan that reads every report on request. The 2026-09-01 rule stands —
// the everyday scan never reads all reports; the sweep runs only when asked,
// after its cost is stated.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const R = extractFunctions('sftk-reportclean.js', ['sftkRptScanClass', 'sftkRptFieldHits', 'sftkRptTokenMatch']);
const between = (a, b) => { const i = FC.indexOf(a); expect(i, a).toBeGreaterThan(0); const j = FC.indexOf(b, i + a.length); expect(j, b).toBeGreaterThan(i); return FC.slice(i, j); };

describe('one report\'s verdict', () => {
  it('a column, a filter, a grouping or a formula that names Object.Field = it uses the field', () => {
    const hits = meta => R.sftkRptFieldHits(meta, 'Account', 'Status__c');
    expect(R.sftkRptScanClass(hits({ detailColumns: ['ACCOUNT.NAME', 'Account.Status__c'] }))).toBe('definite');
    expect(R.sftkRptScanClass(hits({ reportFilters: [{ column: 'Account.Status__c' }] }))).toBe('definite');
    expect(R.sftkRptScanClass(hits({ groupingsDown: [{ name: 'Account$Status__c' }] }))).toBe('definite');
    expect(R.sftkRptScanClass(hits({ detailColumns: ['ACCOUNT.NAME'], customSummaryFormula: { x: { formula: 'Account.Status__c:SUM' } } }))).toBe('definite');
  });
  it('a bare field name without its object is only "possible" — shown, never acted on', () => {
    expect(R.sftkRptScanClass(R.sftkRptFieldHits({ detailColumns: ['Status__c'] }, 'Account', 'Status__c'))).toBe('possible');
  });
  it('the same field name on another object, or no mention, is nothing', () => {
    expect(R.sftkRptScanClass(R.sftkRptFieldHits({ detailColumns: ['Contact.Status__c', 'ACCOUNT.NAME'] }, 'Account', 'Status__c'))).toBeNull();
    expect(R.sftkRptScanClass(null)).toBeNull();
  });
});

describe('the sweep is asked for, never automatic', () => {
  const scan = between('async function runScan() {', '  // ── Supplemental Lightning Page (FlexiPage) scan');
  it('the everyday scan does not read the reports', () => {
    expect(scan).not.toContain('_rptRun(');
    expect(scan).not.toContain('_rptCount(');
    expect(scan).not.toContain('analytics/reports');
  });
  it('step 1 lists the reports (that IS the cost), step 2 needs a second press', () => {
    expect(FC).toContain("query: 'SELECT Id, Name, FolderName FROM Report ORDER BY Name' });");
    expect(FC).toContain('Reading each definition costs one API call: <strong>${N(n)} API call${n === 1 ? \'\' : \'s\'}</strong>');
    expect(FC).toContain("eid('fcRptGo')?.addEventListener('click', _rptRun);");
    expect(FC).toContain("eid('fcRptCancel')?.addEventListener('click', () => { _rptScan = null; renderReportScan(); });");
  });
  it('a new scan, or another field, forgets the sweep', () => {
    expect(FC).toContain('_rptScan = null;\n      _lastScan = { deps: [...deps, ...flexiHits, ...supHits], fieldId };');
    expect(FC).toContain('_rptScan = null; _lastScan = null;');
  });
});

describe('the sweep says exactly what it covered', () => {
  const run = between('async function _rptRun() {', '  // ── 📦 Copy the stored values');
  const view = between('function renderReportScan() {', '  // Step 1: the list');
  it('it shows a live count and can be stopped', () => {
    expect(view).toContain('Reading reports… ${N(s.done)} of ${N(s.list.length)}');
    expect(view).toContain("eid('fcRptStop')?.addEventListener('click', () => { s.stop = true; renderReportScan(); });");
    expect(run).toContain('while (!s.stop && _rptScan === s) {');
  });
  it('stopped or failed reads are named as NOT checked — never counted as clean', () => {
    expect(view).toContain('were NOT checked');
    expect(view).toContain('could not be read (${esc(s.whyFailed || \'no reason given\')}) — those were NOT checked.');
    expect(run).toContain("s.status = s.done === s.list.length ? 'done' : 'stopped';");
  });
  it('it says what it cannot see: other people\'s private reports', () => {
    expect(view).toContain('Reports that only other people can open (their private folders) are not read.');
    expect(view).toContain('Reports only other people can open were not read.');
  });
  it('a report that uses the field joins the list as an ordinary Report row, with the same fix', () => {
    expect(run).toContain("MetadataComponentId: r.Id, MetadataComponentName: r.Name || r.Id, MetadataComponentType: 'Report',");
    expect(run).toContain('await renderResults(_lastScan.deps, _lastScan.fieldId);');
    // rows fixed earlier in the session do not come back as open work
    expect(run).toContain("_lastScan.deps = [..._lastScan.deps.filter(d => !fixed.has(String(d.MetadataComponentId))), ...rows];");
  });
  it('the note under the results still says the index may list none, and points at the sweep', () => {
    expect(FC).toContain('a report that uses this field can be missing here');
    expect(FC).toContain('Scan the reports below (it reads every report itself)');
  });
});
