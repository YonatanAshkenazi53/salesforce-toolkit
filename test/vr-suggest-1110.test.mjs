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
    expect(d('ISBLANK(F__c) && G__c = 1')).toEqual({ mode: 'operand', text: 'G__c = 1', n: 1 });
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
    expect(d('AND(F__c = 1, LEN(F__c) > 2)')).toEqual({ mode: 'whole', n: 2, why: 'all' });
  });
  it('only a constant left is nothing left: the rule would never fire, or block every save', () => {
    expect(d('ISBLANK(F__c) && FALSE')).toEqual({ mode: 'whole', n: 1, why: 'constant', left: 'FALSE' });
    expect(d('OR(F__c = "a", TRUE)').why).toBe('constant');
    expect(d('ISBLANK(F__c) || $User.Alias = "x"').mode).toBe('operand');
  });
  it('several fields, the field several times, and inside NOT( )', () => {
    expect(d('AND(ISBLANK(F__c), ISBLANK(Name), LEN(F__c) > 5, Amount__c > 0)')).toEqual({ mode: 'operand', text: 'AND(ISBLANK(Name), Amount__c > 0)', n: 2 });
    expect(d('NOT(OR(ISBLANK(F__c), ISBLANK(Name)))').text).toBe('NOT(ISBLANK(Name))');
    expect(d('Amount__c > F__c && Name <> ""').text).toBe('Name <> ""');
  });
  it('another field with a longer name, a comment and a quoted string are not the field', () => {
    expect(d('Other_F__c = 1 && XF__c').mode).toBe('none');
    expect(d('AND(\n  /* F__c ) */ A__c,\n  CONTAINS(F__c, ",")\n)').text).toBe('/* F__c ) */ A__c');
    expect(d('Name = "F__c" && ISBLANK(F__c)').text).toBe('Name = "F__c"');
  });
});

describe('the confirm of ✂ on a validation rule offers three ways', () => {
  it('remove the suggested conditions, switch the rule off, or edit by hand — chosen in the dialog', () => {
    for (const v of ["vrWay('remove'", "vrWay('off'", "vrWay('edit'"]) expect(FC).toContain(v);
    expect(FC).toContain("let vrMode = vrChoice ? (ed.suggested ? 'remove' : 'off') : '';");
    expect(FC).toContain("remove: '✂ Remove the conditions', off: '⏻ Switch the rule off', edit: '⬆ Deploy my edit'");
  });
  it('remove is not offered when the rule cannot work without the field, and says why', () => {
    const line = FC.split('\n').find(l => l.includes("vrWay('remove'")) || '';
    expect(line).toContain('Not possible: ');
    expect(line).toContain('!ed.suggested)');
  });
  it('what is deployed follows the way: the suggestion, the switch-off, or the hand edit only when ✎ was chosen', () => {
    expect(FC).toContain("const handXml = vrChoice ? (vrMode === 'edit' ? cfEdit.value() : null) : cfEdit.value();");
    expect(FC).toContain("const finalXml = handXml != null ? handXml : (vrChoice && vrMode === 'off' ? vrOffXml : ed.xml);");
    expect(FC).toContain("const vrOff = vrChoice && vrMode === 'off';");
    expect(FC).toContain("if (vrMode === 'edit' && cfEdit.value() == null) go.disabled = true;");
  });
  it('the edit box is folded for every other kind (editing is optional)', () => {
    expect(FC).not.toContain('open: sug,');
  });
});

describe('a hand edit is done only when it worked', () => {
  it('the re-read checks the lines the edit took out as well as the ones it put in', () => {
    expect(FC).toContain("const handRemoved = handXml != null ?");
    expect(FC).toContain('_lineCount(after, l) <= _lineCount(finalXml, l)');
  });
  it('deployed but still naming the field (a validation rule: and still active) is NOT marked done', () => {
    expect(FC).toContain('const stillOpen = !!handAdded && _editStillNames(type, after || finalXml, field)');
    expect(FC).toContain('if (stillOpen) throw new Error(');
    expect(FC).toContain('it still stops the delete');
  });
  it('the gate row is counted down once, and only when the item is done', () => {
    const i = FC.indexOf('if (stillOpen) throw new Error(');
    const part = FC.slice(i, FC.indexOf('return { label, detailHtml', i));
    expect(part.split('_afterDelete(type)').length - 1).toBe(1);
  });
  it('a new attempt clears the message of the last one', () => {
    expect(FC).toContain("querySelectorAll('.fc-item-err').forEach(e => e.remove());");
  });
});
