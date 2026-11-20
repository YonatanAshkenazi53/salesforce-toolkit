// QA 1.1 finding 45: a dry run names a packaged validation rule as the pause panel does, so a ticked one is recognised.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const { sftkRecRuleRows: rows, sftkProbePauseNote: note, sftkRefusalSource: source } = extractFunctions('studio-reconcile.js', ['sftkRecRuleRows', 'sftkProbePauseNote', 'sftkRefusalSource']);
const { sftkVrPauseSelect: select } = extractFunctions('sftk-vrpause.js', ['sftkVrPauseSelect']);

const TOOLING = [
  { Id: '03dP', ValidationName: 'Not_42', NamespacePrefix: 'dlrs', ManageableState: 'installed', ErrorMessage: 'The answer is not 42!', EntityDefinition: { QualifiedApiName: 'dlrs__LookupParent__c' } },
  { Id: '03dO', ValidationName: 'Own_Rule', NamespacePrefix: null, ManageableState: 'unmanaged', ErrorMessage: 'Own says no', EntityDefinition: { QualifiedApiName: 'dlrs__LookupParent__c' } },
];

describe('a packaged rule in a dry run', () => {
  it('the refusal side names it with its namespace; the org’s own rule keeps its plain name', () => {
    expect(rows(TOOLING)).toEqual([{ name: 'dlrs__Not_42', message: 'The answer is not 42!' }, { name: 'Own_Rule', message: 'Own says no' }]);
    expect(rows(null)).toEqual([]);
  });
  it('both sides give the same name for the same Tooling row', () => {
    expect(rows(TOOLING).map(r => r.name).sort()).toEqual(select(TOOLING).own.map(r => r.name).sort());
  });
  it('ticked in the ⏸ panel and refusing records → the card says a real run would NOT be refused by it', () => {
    const paused = { rules: select(TOOLING).own.map(r => ({ name: r.name, object: r.object })), flows: [], rulesOn: true };
    const src = source('FIELD_CUSTOM_VALIDATION_EXCEPTION', 'The answer is not 42!', rows(TOOLING));
    expect(src).toEqual({ what: 'a validation rule', by: 'dlrs__Not_42' });
    const n = note(src, 'dlrs__LookupParent__c', paused);
    expect(n).toContain('a real ▶ Deploy switches dlrs__Not_42 off first, so these records would NOT be refused by it');
    expect(n).not.toContain('refused the same way');
  });
  it('a rule that is not ticked is still said to refuse the real run — without blaming the package', () => {
    const n = note({ what: 'a validation rule', by: 'dlrs__Not_42' }, 'dlrs__LookupParent__c', { rules: [], flows: [], rulesOn: true });
    expect(n).toContain('is not among the rules it pauses (unticked in the ⏸ panel) — a real ▶ Deploy would be refused the same way.');
    expect(n).not.toContain('package');
  });
  it('the query reads the namespace, and the page uses the shared naming', () => {
    expect(RC).toContain('SELECT ValidationName, NamespacePrefix, ErrorMessage FROM ValidationRule WHERE Active = true');
    expect(RC).toContain('out = sftkRecRuleRows(q.records);');
  });
});
