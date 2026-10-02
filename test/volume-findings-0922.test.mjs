// 2026-09-22 — the huge-tree run: "✓ All listed" over "5,000 of 6,000" selected
// 300 (the painted window); the target's fuzzy name rule blocked 100 Accounts
// ("Use one of these records?") with no way to bypass it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const DV = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
const BG = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const { sftkFriendlyError } = extractFunctions('sftk-friendly-error.js', ['sftkFriendlyError', 'sftkDecodeEntities']);
const { _runDupHeaders, sftkBulkKeyNorm, sftkCorrelateBulkResults } = extractFunctions('background.js', ['_runDupHeaders', 'sftkBulkKeyNorm', 'sftkCorrelateBulkResults']);

describe('bulk select covers the whole list', () => {
  it('iterates the filtered rows, not the painted window, and says how many', () => {
    const h = DV.slice(DV.indexOf("host.querySelectorAll('[data-dep-bulk]')"), DV.indexOf("host.querySelectorAll('[data-dep-fields]')"));
    expect(h).toContain('for (const r of rows) {');
    expect(h).not.toContain('for (const r of shown) {');
    expect(DV).toContain('>✓ All ${nAll}</button>');
    // 2026-10-02: the window grows (Show more / Show all); ✓ All says it covers the rows not shown yet
    expect(DV).toContain('not shown yet (Show all lists them)');
  });
});

describe('Bulk results correlate by VALUE, the way Salesforce echoes them', () => {
  it('numbers, booleans, dates and blanks compare equal across spellings', () => {
    expect(sftkBulkKeyNorm('200000')).toBe(sftkBulkKeyNorm('200000.0'));
    expect(sftkBulkKeyNorm(200)).toBe(sftkBulkKeyNorm('200'));
    expect(sftkBulkKeyNorm('TRUE')).toBe(sftkBulkKeyNorm(true));
    expect(sftkBulkKeyNorm('2026-09-22T10:00:00.000+0000')).toBe(sftkBulkKeyNorm('2026-09-22T10:00:00.000Z'));
    expect(sftkBulkKeyNorm(null)).toBe(sftkBulkKeyNorm(''));
    expect(sftkBulkKeyNorm('City 6')).toBe('City 6');
    expect(sftkBulkKeyNorm('00200')).toBe(sftkBulkKeyNorm('200'));       // numeric spellings fold together (a text column is echoed verbatim on both sides anyway)
  });
  it('the huge-tree rows: a failedResults echo with "200000.0" finds its uploaded "200000" record and keeps the real error', () => {
    const cols = ['Name', 'BillingCity', 'AnnualRevenue', 'NumberOfEmployees'];
    const up = [{ Name: 'SFTK VOL Account 00200', BillingCity: 'City 6', AnnualRevenue: 200000, NumberOfEmployees: 200 },
                { Name: 'SFTK VOL Account 00201', BillingCity: 'City 7', AnnualRevenue: 201000, NumberOfEmployees: 201 }];
    const bad = [{ sf__Id: '', sf__Error: 'DUPLICATES_DETECTED:Use one of these records?:--', Name: 'SFTK VOL Account 00200', BillingCity: 'City 6', AnnualRevenue: '200000.0', NumberOfEmployees: '200' }];
    const ok  = [{ sf__Id: '001X', sf__Created: 'true', Name: 'SFTK VOL Account 00201', BillingCity: 'City 7', AnnualRevenue: '201000.0', NumberOfEmployees: '201' }];
    const r = sftkCorrelateBulkResults(up, cols, ok, bad);
    expect(r[0].success).toBe(false);
    expect(r[0].errors[0].message).toContain('DUPLICATES_DETECTED');
    expect(r[1]).toMatchObject({ id: '001X', success: true, created: true });
  });
  it('a bypass run never goes Bulk (no header there), and says so', () => {
    expect(BG).toContain("const useBulk  = !dupBypass && (API_MODE === 'bulk' || (API_MODE !== 'sync' && payloads.length >= BULK_MIN));");
    expect(BG).toContain('Bulk API 2.0 cannot bypass them');
  });
});

describe('duplicate rules: respect by default, bypass by choice', () => {
  it('the header is sent only while a bypass run is in progress, on create / update / upsert', () => {
    delete globalThis.__sftkRunDupBypass;
    expect(_runDupHeaders()).toEqual({});
    globalThis.__sftkRunDupBypass = true;
    expect(_runDupHeaders()).toEqual({ 'Sforce-Duplicate-Rule-Header': 'allowSave=true' });
    delete globalThis.__sftkRunDupBypass;
    expect((BG.match(/headers: _runDupHeaders\(\),/g) || []).length).toBe(3);
    expect(BG).toContain("globalThis.__sftkRunDupBypass = !!(profile && profile.duplicateRules === 'bypass');");
    expect(BG).toContain('Duplicate rules in the target were bypassed for this run');
  });
  it('saved on the deployment through the shared engine setter; shown next to ▶ Deploy', () => {
    expect(RC).toContain("else if (key === 'duplicateRules') { if (raw === 'bypass') p.duplicateRules = 'bypass'; else delete p.duplicateRules; out = p.duplicateRules || 'respect'; }");
    expect(DV).toContain('id="dsDepDupRules"');
    expect(DV).toContain("await sftkRecSetEngine(p, 'duplicateRules', e.target.value);");
  });
  it('the blocked-write error names the setting', () => {
    const e = sftkFriendlyError('insert: Account: Use one of these records? (×100)');
    expect(e.kind).toBe('error');
    expect(e.type).toBe('duplicate');
    expect(e.hint).toContain('Bypass for this deployment');
    expect(e.count).toBe(100);
  });
});
