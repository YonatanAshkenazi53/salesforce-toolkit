// 2026-09-22 — record picker: "Only needs-deploy" filtered the first 400 rows
// and showed nothing (the changed record was past row 400); a rollback after
// the scan left the badges stale with no way to refresh from the picker.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const B = readFileSync(new URL('../studio-builder-modals.js', import.meta.url), 'utf8');
const D = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
const R = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const { sftkScanStaleRun: stale } = extractFunctions('studio-reconcile.js', ['sftkScanStaleRun'], { 'sftk-org-identity.js': ['sftkOrgKey'] });

describe('a run or rollback after the scan makes it stale', () => {
  const p = { sourceOrg: 'https://a.my.salesforce.com', targetOrg: 'https://b.my.salesforce.com' };
  it('finds the newest entry after the scan that touched either org — rollbacks included', () => {
    const h = [
      { id: 'r1', completedAt: '2026-09-22T10:00:00Z', sourceOrg: p.sourceOrg, targetOrg: p.targetOrg },
      { id: 'rb', kind: 'rollback', completedAt: '2026-09-22T12:00:00Z', srcOrgUrl: p.sourceOrg, tgtOrgUrl: p.targetOrg },
      { id: 'x', completedAt: '2026-09-22T13:00:00Z', sourceOrg: 'https://c.my.salesforce.com', targetOrg: 'https://d.my.salesforce.com' },
    ];
    expect(stale(h, p, '2026-09-22T11:00:00Z')?.id).toBe('rb');
    expect(stale(h, p, '2026-09-22T12:30:00Z')).toBe(null);
    expect(stale(h, null, '2026-09-22T11:00:00Z')).toBe(null);
    expect(stale(h, p, null)).toBe(null);
  });
  it('the classic page, the Deploy page and the picker all use it', () => {
    expect(R).toContain('staleRun = sftkScanStaleRun(_history, p, scan.runAt);');
    expect(D).toContain('staleRun = sftkScanStaleRun(_history, p, scan.runAt);');
    expect(D).toContain('setTimeout(() => _depRescan(p), 0);');
    expect(B).toContain('sftkScanStaleRun(_history, _editingProfile, rootScan?.runAt)');
  });
  it('the picker offers the refresh only for a saved deployment, and reopens on the new scan', () => {
    expect(B).toContain("const canRescan = !!(staleRun && _profiles.some(x => x.id === _editingProfile?.id));");
    expect(B).toContain('await window.refreshProfileState(_editingProfile.id);');
    expect(B).toContain('_editingProfile.lastScan = JSON.parse(JSON.stringify(saved.lastScan));');
  });
});

describe('Only needs-deploy loads the needed records by Id', () => {
  it('fetches by Id, under the same WHERE and parent scope, in chunks of 200, capped and said', () => {
    const fn = B.slice(B.indexOf('async function fetchTodoRecords() {'), B.indexOf('const staleRun  = scanFresh'));
    expect(fn).toContain("const want = [...new Set([...idsMissingInTarget, ...idsDrift, ...idsFileMiss])];");
    expect(fn).toContain('for (let i = 0; i < Math.min(missing.length, CAP); i += 200) {');
    expect(fn).toContain("WHERE Id IN (${ids.map(id => `'${id}'`).join(',')})${w ? ` AND ${w}` : ''}");
    expect(fn).toContain('loaded by Id');
    expect(fn).toContain('narrow with a WHERE filter for the rest');
  });
  it('the toggle loads once, before the filter is applied', () => {
    expect(B).toContain('if (showOnlyTodo && !todoLoaded) { e.target.disabled = true; await fetchTodoRecords(); }');
    expect(B).toContain("${showOnlyTodo && todoNote ? `<div class=\"ds-picker-note\">${esc(todoNote)}</div>` : ''}");
  });
});
