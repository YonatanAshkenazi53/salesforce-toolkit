// Campaign 3 phase 8 — Org health (studio-orghealth.js).
//
// One org, one card per finding, nothing read until Check, the cost shown
// first, every answer dated and kept per org, a failed check never "all good".
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(root, 'studio-orghealth.js'), 'utf8');
const lic = extractFunction('studio-orghealth.js', 'sftkOhLicenceVerdict');
const idle = extractFunction('studio-orghealth.js', 'sftkOhIdleVerdict');
const off = extractFunction('studio-orghealth.js', 'sftkOhFlowsOffVerdict');

describe('the three first cards judge from data', () => {
  it('licences: full → bad, ≥ 90 % → warn, else good; each named', () => {
    expect(lic([{ Name: 'Salesforce', TotalLicenses: 2, UsedLicenses: 2 }, { Name: 'Identity', TotalLicenses: 100, UsedLicenses: 3 }]))
      .toEqual({ tone: 'bad', headline: '1 licence type(s) at the cap — nobody new can be given them', lines: ['Salesforce: 2 of 2 used — full'] });
    expect(lic([{ Name: 'Platform', TotalLicenses: 10, UsedLicenses: 9 }]).tone).toBe('warn');
    expect(lic([{ Name: 'Platform', TotalLicenses: 10, UsedLicenses: 2 }])).toMatchObject({ tone: 'good', lines: [] });
  });
  it('idle users: never / last login named; a hit LIMIT says "+"', () => {
    const v = idle([{ Name: 'A', Username: 'a@x', LastLoginDate: null, Profile: { UserLicense: { Name: 'Salesforce' } } },
                    { Name: 'B', Username: 'b@x', LastLoginDate: '2026-05-01T10:00:00.000+0000' }], true);
    expect(v.tone).toBe('warn');
    expect(v.headline).toBe('2+ active user(s) have not logged in for 90 days — each holds a licence');
    expect(v.lines).toEqual(['A (a@x) — never logged in · Salesforce', 'B (b@x) — last login 2026-05-01']);
    expect(idle([], false).tone).toBe('good');
  });
  it('flows switched off: still off → warn with the version that comes back; gone from the org → said; back on → good', () => {
    expect(off({ F1: 3, F2: 1 }, new Map([['F1', false], ['F2', true]])))
      .toEqual({ tone: 'warn', headline: '1 flow(s) switched off with ⏻ Flow switches are still off', lines: ['F1 — off; ▶ Switch ON restores v3'] });
    expect(off({ F1: 3 }, new Map())).toMatchObject({ tone: 'warn', lines: ['F1 — not found in the org any more (deleted or renamed)'] });
    expect(off({ F1: 3 }, new Map([['F1', true]])).tone).toBe('good');
    expect(off({}, null).tone).toBe('good');
  });
});

describe('the page keeps the budget-first rules', () => {
  it('nothing reads until Check; the estimate is on every card and for Check all; results are dated and kept per org', () => {
    expect(SRC).toContain("'Not checked yet for this org — press Check.'".replace(/'/g, '')) ;
    expect(SRC).toContain('<span class="ds-rec-card-hint">${esc(sftkOhCallsText(n))}</span>');
    const txt = extractFunction('studio-orghealth.js', 'sftkOhCallsText');
    expect(txt(1)).toBe('≈1 API call');
    expect(txt(3)).toBe('≈3 API calls');
    expect(txt('2 + 1 per 100 fields')).toBe('≈2 + 1 per 100 fields API calls');
    expect(SRC).toContain('≈${total}${plus} API calls for all ${OH_CARDS.length} checks');
    expect(SRC).toContain("const OH_STORE_KEY = 'sftk_orghealth';");
    expect(SRC).toContain('Checked ${esc(timeAgo(res.at))}');
  });
  it('a failed check is shown as such — never as an all-clear', () => {
    expect(SRC).toContain("result = { error: (e && e.message) || String(e), at: new Date().toISOString() };");
    expect(SRC).toContain("${res.error ? ' — this is NOT an all-clear' : ''}");
  });
  it('the view is registered everywhere a view must be, and the popup has a tile that opens it', () => {
    const CORE = readFileSync(join(root, 'studio-core.js'), 'utf8'), HTML = readFileSync(join(root, 'studio.html'), 'utf8'), POP = readFileSync(join(root, 'popup.js'), 'utf8');
    expect(CORE).toContain("'whatsnew', 'orghealth',");
    expect(CORE).toContain("case 'orghealth': renderOrgHealth();");
    expect(HTML).toContain('data-view="orghealth"');
    expect(HTML.indexOf('src="studio-orghealth.js"')).toBeGreaterThan(HTML.indexOf('src="studio-transfer.js"'));
    expect(POP).not.toContain("studio.html#/orghealth");   // the Toolkit's tile is gone (user 2026-10-12): Org health has one door, Data Studio's navigation
    expect(readFileSync(join(root, 'studio-history.js'), 'utf8')).toContain("'sftk_orghealth',");
  });
});

describe('live 2026-09-29 fixes', () => {
  it('pages that share a label are told apart by their API name', () => {
    const pages = extractFunction('studio-orghealth.js', 'sftkOhPagesVerdict');
    const v = pages([{ label: 'Account Record Page', devName: 'Account_Record_Page1', type: 'RecordPage', object: 'Account', state: 'unassigned' },
                     { label: 'Account Record Page', devName: 'Account_Record_Page2', type: 'RecordPage', object: 'Account', state: 'unassigned' }], 0);
    expect(v.lines.slice(0, 2)).toEqual(['Account Record Page [Account_Record_Page1] (RecordPage · Account) — assigned to nobody',
                                          'Account Record Page [Account_Record_Page2] (RecordPage · Account) — assigned to nobody']);
  });
  it('Check all keeps the "+" when some cards cost depends on what the org holds', () => {
    expect(SRC).toContain("(${plusN} of them depend on what the org holds, so more than this)");
    expect(SRC).toContain(String.raw`line.text.replace(/^≈(\d[\d,]*)/, plus ? '≈$1+' : '≈$1')`);
  });
});
