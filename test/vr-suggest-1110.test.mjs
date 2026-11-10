// ✂ on a validation rule is a suggestion (user 2026-11-10: "why can't we just remove the field reference instead of
// deactivation?" — "we need to let the user to edit it and suggest what to remove. if its the only field ref we can
// suggest to turn it off").
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const M = extractFunctions('sftk-mdapi.js', ['sftkFormulaDropField', '_sftkMdSwapToken']);
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const d = f => M.sftkFormulaDropField(f, 'Account', 'F__c');

describe('sftkFormulaDropField', () => {
  it('takes a condition out of && and || and keeps the rest as written', () => {
    expect(d('ISBLANK(F__c) && FALSE')).toEqual({ mode: 'operand', text: 'FALSE', n: 1 });
    expect(d('a__c || b__c && F__c > 1')).toEqual({ mode: 'operand', text: 'a__c || b__c', n: 1 });
    expect(d('(F__c = 1 || G__c = 2) && H__c').text).toBe('(G__c = 2) && H__c');
  });
  it('takes an argument out of AND( ) and OR( ), nested, and unwraps a call left with one argument', () => {
    expect(d('AND(ISBLANK(F__c), ISPICKVAL(Stage,"Won"))').text).toBe('ISPICKVAL(Stage,"Won")');
    expect(d('AND(F__c = "a", OR(X__c, Y__c))').text).toBe('OR(X__c, Y__c)');
    expect(d('OR(A__c, AND(B__c, F__c = "x)"), LEN(F__c) > 3) && C__c')).toEqual({ mode: 'operand', text: 'OR(A__c, B__c) && C__c', n: 2 });
    expect(d('AND(F__c = 1, A__c || B__c) && C__c').text).toBe('(A__c || B__c) && C__c');
  });
  it('nothing left: the field is in every condition, or the formula is one condition', () => {
    expect(d('ISBLANK(F__c)').mode).toBe('whole');
    expect(d('NOT(ISBLANK(Account.F__c))').mode).toBe('whole');
    expect(d('IF(F__c = 1, TRUE, G__c)').mode).toBe('whole');
    expect(d('AND(F__c = 1, LEN(F__c) > 2)').mode).toBe('whole');
  });
  it('another field with a longer name, a comment and a quoted string are not the field', () => {
    expect(d('Other_F__c = 1 && XF__c').mode).toBe('none');
    expect(d('AND(\n  /* F__c ) */ A__c,\n  CONTAINS(F__c, ",")\n)').text).toBe('/* F__c ) */ A__c');
    expect(d('Name = "F__c" && ISBLANK(F__c)').text).toBe('Name = "F__c"');
  });
});

describe('the confirm of a suggestion', () => {
  it('opens the edit box, says it is a suggestion, and names a switch-off as a switch-off', () => {
    expect(FC).toContain("open: sug,");
    expect(FC).toContain('Read the formula that is left');
    expect(FC).toContain("confirmLabel: ed.off ? '⏻ Switch the rule off'");
    expect(FC).toContain('const vrOff0 = !!ed.off;');
  });
});
