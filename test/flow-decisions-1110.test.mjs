// A flow's decisions and yes/no formulas lose the field's conditions where the rest still works (user 2026-11-10:
// "יכול להיות בפלואו אחד עשרות פורמולות ועשרות decisions" — one decision that tested the field kept the whole flow
// "by hand" and greyed out "Keep the flow running").
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const M = extractFunctions('sftk-mdapi.js', ['sftkFormulaDropField', '_sftkMdSwapToken']);
const S = extractFunctions('sftk-flowsurgery.js', ['sftkFlowRefPreview', 'sftkFlowRefScan', 'sftkFlowRefWhere', 'sftkFlowReachable']);
// the real remover, lifted out of the tool's closure
const at = FC.indexOf('  function removeFieldRefs(metadata, objApi, fieldApi, opts) {');
const stop = FC.indexOf('    return changes;', at);
const removeFieldRefs = new Function('sftkFormulaDropField', `${FC.slice(at, FC.indexOf('}', stop) + 1)}; return removeFieldRefs;`)(M.sftkFormulaDropField);

const cond = (left, right) => ({ leftValueReference: left, operator: 'EqualTo', rightValue: right ? { elementReference: right } : { stringValue: 'x' } });
const flow = () => ({
  decisions: [
    { name: 'D1', label: 'Mixed', rules: [{ name: 'R1', label: 'Two', conditionLogic: 'and', conditions: [cond('$Record.F__c'), cond('$Record.Name')] }] },
    { name: 'D2', label: 'Alone', rules: [{ name: 'R2', label: 'Only', conditionLogic: 'and', conditions: [cond('$Record.F__c')] }] },
    { name: 'D3', label: 'Numbered', rules: [{ name: 'R3', label: 'Logic', conditionLogic: '1 AND (2 OR 3)', conditions: [cond('$Record.F__c'), cond('$Record.Name'), cond('$Record.Phone')] }] },
    { name: 'D4', label: 'Twice', rules: [{ name: 'R4', label: 'Or', conditionLogic: 'or', conditions: [cond('$Record.F__c'), cond('$Record.Name', '$Record.F__c'), cond('$Record.Phone')] }] },
    { name: 'D5', label: 'Untouched', rules: [{ name: 'R5', label: 'Other', conditionLogic: 'and', conditions: [cond('$Record.Name')] }] },
  ],
  formulas: [
    { name: 'F1', dataType: 'Boolean', expression: 'AND(ISBLANK({!$Record.F__c}), {!$Record.Name} = "a")' },
    { name: 'F2', dataType: 'Boolean', expression: 'ISBLANK({!$Record.F__c})' },
    { name: 'F3', dataType: 'String', expression: '{!$Record.F__c} & " x"' },
    { name: 'F4', dataType: 'Boolean', expression: '{!$Record.Other_F__c} = 1 && {!$Record.Name} = "b"' },
  ],
});

describe('removeFieldRefs on decisions', () => {
  it('an outcome with other conditions loses only the conditions of the field — also when it tests it twice', () => {
    const m = flow(); removeFieldRefs(m, 'Account', 'F__c');
    expect(m.decisions[0].rules[0].conditions.map(c => c.leftValueReference)).toEqual(['$Record.Name']);
    expect(m.decisions[3].rules[0].conditions.map(c => c.leftValueReference)).toEqual(['$Record.Phone']);
  });
  it('an outcome that rests on the field alone, and a numbered logic, are left as they are', () => {
    const m = flow(); removeFieldRefs(m, 'Account', 'F__c');
    expect(m.decisions[1].rules[0].conditions).toHaveLength(1);
    expect(m.decisions[2].rules[0].conditions).toHaveLength(3);
  });
  it('a decision that does not test the field is not touched', () => {
    const m = flow(); const before = JSON.stringify(m.decisions[4]); removeFieldRefs(m, 'Account', 'F__c');
    expect(JSON.stringify(m.decisions[4])).toBe(before);
  });
});

describe('removeFieldRefs on formulas', () => {
  it('a yes/no formula loses the part that uses the field when the rest still tests something', () => {
    const m = flow(); removeFieldRefs(m, 'Account', 'F__c');
    expect(m.formulas[0].expression).toBe('{!$Record.Name} = "a"');
  });
  it('a formula that is all the field, a text formula and another field with a longer name are left alone', () => {
    const m = flow(); removeFieldRefs(m, 'Account', 'F__c');
    expect(m.formulas[1].expression).toBe('ISBLANK({!$Record.F__c})');
    expect(m.formulas[2].expression).toBe('{!$Record.F__c} & " x"');
    expect(m.formulas[3].expression).toBe('{!$Record.Other_F__c} = 1 && {!$Record.Name} = "b"');
  });
  it('the count is the conditions taken out: 1 + 2 from decisions, 1 from the formula', () => {
    expect(removeFieldRefs(flow(), 'Account', 'F__c')).toBe(4);
  });
});

describe('the preview of the fix', () => {
  const isRef = v => /(^|[^A-Za-z0-9_])F__c(?![A-Za-z0-9_])/.test(v);
  const before = flow(), after = flow(); removeFieldRefs(after, 'Account', 'F__c');
  const pv = S.sftkFlowRefPreview(before, after, isRef);
  it('names each condition that comes out, and shows a rewritten formula as old → new', () => {
    const txt = pv.removed.map(r => `${r.kind} ${r.label} ${r.where}: ${r.what}`);
    expect(txt.some(t => t.startsWith('Decision Mixed outcome “Two” → condition 1: $Record.F__c EqualTo “x”'))).toBe(true);
    expect(txt.some(t => t.includes('Formula F1') && t.includes('→  {!$Record.Name} = "a"'))).toBe(true);
    expect(pv.removed).toHaveLength(4);
  });
  it('what stays by hand is still listed: the lone outcome, the numbered logic, the two formulas', () => {
    const names = [...new Set(pv.remaining.map(r => r.name))].sort();
    expect(names).toEqual(['D2', 'D3', 'F2', 'F3']);
    expect(pv.emptied).toHaveLength(0);
  });
});

// The third way (user 2026-11-10: "1."): an outcome that rests on the field alone goes as a whole — opt-in only.
const flow3 = () => ({
  start: { connector: { targetReference: 'Which' } },
  decisions: [{ name: 'Which', label: 'Which One', defaultConnectorLabel: 'Anything else',
    rules: [
      { name: 'By_Email', label: 'By email', conditionLogic: 'and', conditions: [cond('acct.F__c')], connector: { targetReference: 'Mark_Email' } },
      { name: 'By_Name', label: 'By name', conditionLogic: 'and', conditions: [cond('acct.Name')], connector: { targetReference: 'Mark_Name' } },
    ] }],
  assignments: [{ name: 'Mark_Email', assignmentItems: [{ assignToReference: 'note' }] }, { name: 'Mark_Name', assignmentItems: [{ assignToReference: 'note' }] }],
});
const lone = () => ({
  start: { connector: { targetReference: 'Gate' } },
  decisions: [{ name: 'Gate', label: 'Gate', defaultConnector: { targetReference: 'After' }, rules: [{ name: 'Only', label: 'Only', conditionLogic: 'and', conditions: [cond('acct.F__c')], connector: { targetReference: 'Side' } }] }],
  assignments: [{ name: 'After', assignmentItems: [{ assignToReference: 'x' }] }, { name: 'Side', assignmentItems: [{ assignToReference: 'x' }] }],
});

describe('the whole outcome, when the user chooses it', () => {
  it('is never taken out by the plain fix', () => {
    const m = flow3(); expect(removeFieldRefs(m, 'Account', 'F__c')).toBe(0);
    expect(m.decisions[0].rules).toHaveLength(2);
  });
  it('with the option: the outcome goes, the other stays, and what it led to is no longer reached', () => {
    const before = flow3(), m = flow3(), out = [];
    expect(removeFieldRefs(m, 'Account', 'F__c', { dropOutcomes: true, out })).toBe(1);
    expect(m.decisions[0].rules.map(r => r.name)).toEqual(['By_Name']);
    expect(out).toEqual([{ decision: 'Which', decisionLabel: 'Which One', outcome: 'By_Email', outcomeLabel: 'By email', led: 'Mark_Email', defaultLabel: 'Anything else' }]);
    const was = S.sftkFlowReachable(before), now = S.sftkFlowReachable(m);
    expect([...was].filter(n => !now.has(n))).toEqual(['Mark_Email']);
  });
  it('a decision left with no outcome goes too, and Start is wired to where its default led', () => {
    const m = lone(), out = [];
    removeFieldRefs(m, 'Account', 'F__c', { dropOutcomes: true, out });
    expect(m.decisions).toHaveLength(0);
    expect(m.start.connector.targetReference).toBe('After');
    expect(out[0].decisionGone).toBe(true);
    expect([...S.sftkFlowReachable(m)]).toEqual(['After']);
  });
  it('a flow that is only that decision is left with nothing after Start — the dialog must not offer the way', () => {
    const m = lone(); delete m.decisions[0].defaultConnector;
    removeFieldRefs(m, 'Account', 'F__c', { dropOutcomes: true, out: [] });
    expect(m.start.connector).toBeUndefined();
    expect(S.sftkFlowReachable(m).size).toBe(0);
    expect(FC).toContain('empty: was.size > 0 && now.size === 0');
    expect(FC).toContain('that decision is all this flow does');
  });
  it('the run takes outcomes out only when the confirm chose it', () => {
    expect(FC).toContain("removeFieldRefs(metadata, _selObj.api, _selField.api, _flowDropOutcomes ? { dropOutcomes: true } : null);");
    expect(FC).toContain("_flowDropOutcomes = dropOutcomes && activeMode === 'replace';");
    expect(FC).toMatch(/finally \{\s*_flowDropOutcomes = false;/);
  });
});
