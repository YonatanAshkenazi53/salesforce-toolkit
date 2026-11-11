// ✂ Remove known before the click (user 2026-11-11, a matching rule whose only item is the field: the refusal showed
// only after the click). The list is pre-checked with the same pure transform the fix runs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const require = createRequire(import.meta.url);
await import('../sftk-mdapi.js');

describe('the pre-check', () => {
  it('runs with the list, once per scan, through sftkMdEditField with no replacement', () => {
    expect(FC).toContain('    _autoAsk();\n    _preflight();\n');
    expect(FC).toContain('if (scan.pre) { Object.keys(scan.pre).forEach(_paintPre); _refreshFixEvery(); return; }');
    expect(FC).toContain('const ed = sftkMdEditField(type, rd.rec.innerXml, obj, field, null);');
    expect(FC).toContain('if (_lastScan !== scan) return;');
  });
  it('a refused row has no live ✂ button — the walks and the counts skip it — and says why', () => {
    expect(FC).toContain('ways.remove && _preWhy(id) ? `<button class="btn btn-secondary btn-sm fc-pre-no" disabled');
    expect(FC).toContain('n.textContent = `✂ Remove is not possible here: ${why}.`;');
  });
  it('the transform refuses a matching rule whose only item is the field, and not one with two', () => {
    const one = '<fullName>MR</fullName><matchingRuleItems><fieldName>X__c</fieldName><matchingMethod>Exact</matchingMethod></matchingRuleItems><ruleStatus>Inactive</ruleStatus>';
    const two = one.replace('<ruleStatus>', '<matchingRuleItems><fieldName>Name</fieldName><matchingMethod>Exact</matchingMethod></matchingRuleItems><ruleStatus>');
    expect(globalThis.sftkMdEditField('MatchingRule', one, 'Account', 'X__c', null).refused).toMatch(/only matching item/);
    const ok = globalThis.sftkMdEditField('MatchingRule', two, 'Account', 'X__c', null);
    expect(ok.refused).toBeFalsy();
    expect(ok.changed).toBe(true);
  });
});
