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
const { _runDupHeaders } = extractFunctions('background.js', ['_runDupHeaders']);

describe('bulk select covers the whole list', () => {
  it('iterates the filtered rows, not the painted window, and says how many', () => {
    const h = DV.slice(DV.indexOf("host.querySelectorAll('[data-dep-bulk]')"), DV.indexOf("host.querySelectorAll('[data-dep-fields]')"));
    expect(h).toContain('for (const r of rows) {');
    expect(h).not.toContain('for (const r of shown) {');
    expect(DV).toContain('>✓ All ${nAll}</button>');
    expect(DV).toContain('the count is the truth');
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
