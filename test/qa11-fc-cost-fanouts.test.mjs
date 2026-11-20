// QA 1.1 finding 24: the scan's cost line left out the legs that open one call per item (child objects, inactive validation rules, Paths, prompt templates, compact layouts).
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';
const F = extractFunctions('field-cleaner.js', ['fcEstimateScanCalls', 'fcScanBudgetLine', 'fcScopeLegs', 'fcScopeNorm']);
const CH = '10 child objects of this object', VR = 'inactive validation rule on this object', PA = 'Path on this object',
  PT = '10 prompt templates in the org', CL = '10 compact layouts on this object';

describe('the cost line names every leg that opens more calls', () => {
  it('a full scan names all five before anything is known', () => {
    const e = F.fcEstimateScanCalls(null, 'both', 'Account');
    for (const w of [CH, VR, PA, PT, CL]) expect(e.moreIf).toContain(w);
    const line = F.fcScanBudgetLine(e, null).text;
    for (const w of [CH, VR, PA, PT, CL]) expect(line).toContain(w);
    expect(line).toMatch(/plus 1 for each .* the scan opens$/);
  });
  it('each is named only in the scope whose scan runs it', () => {
    const b = F.fcEstimateScanCalls(null, 'blockers', 'Account').moreIf, m = F.fcEstimateScanCalls(null, 'mentions', 'Account').moreIf;
    expect(b).toContain(PT);
    for (const w of [CH, VR, PA, CL]) expect(b).not.toContain(w);
    for (const w of [CH, VR, PA, CL]) expect(m).toContain(w);
    expect(m).not.toContain(PT);
  });
  it('a known count is added to the calls and leaves the list: 120 child objects are 12 reads, 40 inactive rules are 40', () => {
    const base = F.fcEstimateScanCalls(null, 'mentions', 'Account');
    const e = F.fcEstimateScanCalls({ childObjects: 12, validationRulesOff: 40, paths: 3, compactLayoutBatches: 1 }, 'mentions', 'Account');
    expect(e.now).toBe(base.now + 12 + 40 + 3 + 1);
    for (const w of [CH, VR, PA, CL]) expect(e.moreIf).not.toContain(w);
  });
  it('the warning counts them: a budget the fixed calls fit in is exceeded once the fan-outs are known', () => {
    const budget = { label: 'this org', budget: { max: 15000, remaining: 40 } };
    expect(F.fcScanBudgetLine(F.fcEstimateScanCalls(null, 'mentions', 'Account'), budget).warn).toBe(false);
    expect(F.fcScanBudgetLine(F.fcEstimateScanCalls({ childObjects: 12, validationRulesOff: 40 }, 'mentions', 'Account'), budget).warn).toBe(true);
  });
});
