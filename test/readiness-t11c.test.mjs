// T11c — ORG-CONFIGURATION differences as first-class findings.
//
// The bug these tests exist for: a real load failed because the TARGET org
// had State and Country picklists ON while the SOURCE had them OFF.
// BillingState existed on both sides, so every per-object field check
// passed, and the load still died on "Please select a state from the list
// of valid states". drOrgSettingDiffs is the pure comparison that turns
// that setup difference into a finding.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

const { drOrgSettingDiffs, drOrgSettingsSeverity } =
  extractFunctions('studio-readiness.js', ['drOrgSettingDiffs', 'drOrgSettingsSeverity']);

const KEYS = ['stateCountry', 'personAccounts', 'multiCurrency', 'acm'];

// A flag object with every setting OFF — tests override just what they mean.
const off = (label, over) => Object.assign(
  { label, stateCountry: false, personAccounts: false, multiCurrency: false, acm: false },
  over || {}
);
const row = (rows, key) => rows.find(r => r.key === key);

describe('drOrgSettingDiffs (studio-readiness.js) — org setup comparison', () => {
  it('returns one row per setting, matching settings included', () => {
    const rows = drOrgSettingDiffs(off('Dev'), off('Prod'));
    expect(rows.map(r => r.key)).toEqual(KEYS);
    // A check you cannot see did not happen: equal settings still get a row.
    expect(rows.every(r => r.severity === 'ok')).toBe(true);
    expect(row(rows, 'stateCountry').consequence).toMatch(/Same in both orgs \(Off\)/);
  });

  it('every row carries the shape the renderer relies on', () => {
    const rows = drOrgSettingDiffs(off('Dev'), off('Prod', { multiCurrency: true }));
    for (const r of rows) {
      expect(typeof r.key).toBe('string');
      expect(typeof r.label).toBe('string');
      expect(['On', 'Off', 'Unknown']).toContain(r.src);
      expect(['On', 'Off', 'Unknown']).toContain(r.tgt);
      expect(typeof r.consequence).toBe('string');
      expect(r.consequence.length).toBeGreaterThan(0);
      expect(['critical', 'warning', 'unknown', 'ok']).toContain(r.severity);
    }
  });

  // ── THE REGRESSION CASE ───────────────────────────────────────
  it('state/country OFF in source, ON in target is CRITICAL and explains the rejection', () => {
    const rows = drOrgSettingDiffs(off('Dev Sandbox'), off('Production', { stateCountry: true }));
    const r = row(rows, 'stateCountry');
    expect(r.src).toBe('Off');
    expect(r.tgt).toBe('On');
    expect(r.severity).toBe('critical');
    // Names both orgs, the right way round.
    expect(r.consequence).toContain('ON in Production');
    expect(r.consequence).toContain('OFF in Dev Sandbox');
    // States the consequence, not just the fact.
    expect(r.consequence).toMatch(/REJECTED/);
    // Both halves of the real error are covered.
    expect(r.consequence).toMatch(/country\/territory must be set/i);
    expect(drOrgSettingsSeverity(rows)).toBe('critical');
  });

  it('state/country ON in source, OFF in target is a WARNING (values load; only the *Code fields break)', () => {
    const rows = drOrgSettingDiffs(off('Prod', { stateCountry: true }), off('Dev'));
    const r = row(rows, 'stateCountry');
    expect(r.src).toBe('On');
    expect(r.tgt).toBe('Off');
    expect(r.severity).toBe('warning');
    expect(r.consequence).toContain('BillingStateCode');
    // Does not duplicate the per-object missing-field finding — points at it.
    expect(r.consequence).toMatch(/Missing fields/i);
  });

  it('person accounts ON in source, OFF in target is CRITICAL (those rows cannot exist there)', () => {
    const rows = drOrgSettingDiffs(off('Prod', { personAccounts: true }), off('Dev'));
    const r = row(rows, 'personAccounts');
    expect(r.severity).toBe('critical');
    expect(r.consequence).toMatch(/REJECTED/);
    expect(r.consequence).toContain('Dev');
  });

  it('person accounts OFF in source, ON in target is a WARNING (business accounts still load)', () => {
    const rows = drOrgSettingDiffs(off('Dev'), off('Prod', { personAccounts: true }));
    expect(row(rows, 'personAccounts').severity).toBe('warning');
    expect(row(rows, 'personAccounts').consequence).toMatch(/RecordTypeId/);
  });

  it('multi-currency ON in source, OFF in target is CRITICAL (CurrencyIsoCode rejected + no conversion)', () => {
    const rows = drOrgSettingDiffs(off('Prod', { multiCurrency: true, acm: false }), off('Dev'));
    const r = row(rows, 'multiCurrency');
    expect(r.severity).toBe('critical');
    expect(r.consequence).toContain('CurrencyIsoCode');
    expect(r.consequence).toMatch(/NO conversion/);
  });

  it('multi-currency OFF in source, ON in target is a WARNING (inserts succeed, corporate currency wins)', () => {
    const rows = drOrgSettingDiffs(off('Dev'), off('Prod', { multiCurrency: true }));
    expect(row(rows, 'multiCurrency').severity).toBe('warning');
  });

  it('advanced currency management differences are reported in both directions', () => {
    const a = drOrgSettingDiffs(off('Dev', { multiCurrency: true, acm: true }),
                                off('Prod', { multiCurrency: true, acm: false }));
    expect(row(a, 'acm').severity).toBe('warning');
    expect(row(a, 'acm').consequence).toMatch(/dated/i);
    const b = drOrgSettingDiffs(off('Dev', { multiCurrency: true, acm: false }),
                                off('Prod', { multiCurrency: true, acm: true }));
    expect(row(b, 'acm').severity).toBe('warning');
    expect(row(b, 'acm').consequence).toMatch(/CloseDate/);
    // Direction actually matters — the two sentences are not the same text.
    expect(row(a, 'acm').consequence).not.toBe(row(b, 'acm').consequence);
  });

  it('reports several differences at once, each with its own severity', () => {
    const rows = drOrgSettingDiffs(
      off('Dev', { personAccounts: true }),
      off('Prod', { stateCountry: true, multiCurrency: true })
    );
    expect(row(rows, 'stateCountry').severity).toBe('critical');   // off → on
    expect(row(rows, 'personAccounts').severity).toBe('critical'); // on  → off
    expect(row(rows, 'multiCurrency').severity).toBe('warning');   // off → on
    expect(row(rows, 'acm').severity).toBe('ok');
  });

  // ── Honesty: unknown is never "ok" ────────────────────────────
  it('a null flag is INCONCLUSIVE, not clean, and names the org that could not be read', () => {
    const rows = drOrgSettingDiffs(off('Dev'), off('Prod', { stateCountry: null }));
    const r = row(rows, 'stateCountry');
    expect(r.severity).toBe('unknown');
    expect(r.tgt).toBe('Unknown');
    expect(r.consequence).toMatch(/INCONCLUSIVE/);
    expect(r.consequence).toContain('Prod');
    expect(r.consequence).not.toContain('Dev');
  });

  it('a missing flag key is treated as unknown, not as "off"', () => {
    // The probe failed before it set anything → nothing may read as a match.
    const rows = drOrgSettingDiffs({ label: 'Dev' }, { label: 'Prod' });
    expect(rows.every(r => r.severity === 'unknown')).toBe(true);
    expect(rows.every(r => r.src === 'Unknown' && r.tgt === 'Unknown')).toBe(true);
    expect(row(rows, 'acm').consequence).toContain('Dev or Prod');
  });

  it('non-boolean truthy junk is unknown too, never coerced to On', () => {
    const rows = drOrgSettingDiffs(off('Dev', { multiCurrency: 'yes' }), off('Prod'));
    expect(row(rows, 'multiCurrency').severity).toBe('unknown');
    expect(row(rows, 'multiCurrency').src).toBe('Unknown');
  });

  it('falls back to generic org names when the flags carry no label', () => {
    const rows = drOrgSettingDiffs(
      { stateCountry: false, personAccounts: false, multiCurrency: false, acm: false },
      { stateCountry: true,  personAccounts: false, multiCurrency: false, acm: false }
    );
    expect(row(rows, 'stateCountry').consequence).toContain('the target');
    expect(row(rows, 'stateCountry').consequence).toContain('the source');
  });

  it('survives null/undefined inputs instead of throwing mid-render', () => {
    expect(() => drOrgSettingDiffs(null, undefined)).not.toThrow();
    expect(drOrgSettingDiffs(null, undefined)).toHaveLength(KEYS.length);
    expect(drOrgSettingDiffs(null, undefined).every(r => r.severity === 'unknown')).toBe(true);
  });

  it('is pure — it does not mutate the flag objects it is given', () => {
    const s = off('Dev'), t = off('Prod', { stateCountry: true });
    const sBefore = JSON.stringify(s), tBefore = JSON.stringify(t);
    drOrgSettingDiffs(s, t);
    expect(JSON.stringify(s)).toBe(sBefore);
    expect(JSON.stringify(t)).toBe(tBefore);
  });
});

describe('drOrgSettingsSeverity (studio-readiness.js) — target summary roll-up', () => {
  it('critical beats everything', () => {
    expect(drOrgSettingsSeverity([
      { severity: 'ok' }, { severity: 'warning' }, { severity: 'critical' }, { severity: 'unknown' }
    ])).toBe('critical');
  });

  it('unknown rolls up as a warning — an inconclusive check must not read as clean', () => {
    expect(drOrgSettingsSeverity([{ severity: 'ok' }, { severity: 'unknown' }])).toBe('warning');
  });

  it('all-ok rolls up as ok', () => {
    expect(drOrgSettingsSeverity([{ severity: 'ok' }, { severity: 'ok' }])).toBe('ok');
  });

  it('tolerates empty / non-array / holey input', () => {
    expect(drOrgSettingsSeverity([])).toBe('ok');
    expect(drOrgSettingsSeverity(null)).toBe('ok');
    expect(drOrgSettingsSeverity('nope')).toBe('ok');
    expect(drOrgSettingsSeverity([null, undefined, { severity: 'critical' }])).toBe('critical');
  });

  it('matches what drOrgSettingDiffs actually produces for the regression case', () => {
    const rows = drOrgSettingDiffs(off('Dev'), off('Prod', { stateCountry: true }));
    expect(drOrgSettingsSeverity(rows)).toBe('critical');
  });
});
