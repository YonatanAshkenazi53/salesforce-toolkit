// Release QA 2026-11-14 — studio-deploy.js, "Start with parents first".
//
// The card listed the outside parent objects in first-seen order and '← next'
// took the first unsettled one, so PricebookEntry (step 6) was offered before
// Product2 (step 7, missing in the target): the journey run that followed ended
// 'failed', every insert refused. Steps are now ordered by the parents' own
// lookups (sftkParentOrderFor returns parentDeps), and '← next' never points at
// a step whose own parents are still unsettled.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunction } from './extract.mjs';

const orderSteps = extractFunction('studio-deploy.js', 'sftkDeployOrderSteps');
const nextIdx = extractFunction('studio-deploy.js', 'sftkDeployNextStepIdx');
const DV = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const LIVE = readFileSync(new URL('../scripts/dev/live/parents-first.mjs', import.meta.url), 'utf8');

// the shape of the failing deployment: Opportunity → OpportunityLineItem
const OBJECTS = [
  { obj: 'Opportunity', parents: [{ field: 'AccountId', refObj: 'Account' }, { field: 'Pricebook2Id', refObj: 'Pricebook2' }] },
  { obj: 'OpportunityLineItem', parents: [{ field: 'PricebookEntryId', refObj: 'PricebookEntry', required: true }, { field: 'Product2Id', refObj: 'Product2' }] },
];
const DEPS = { PricebookEntry: ['Product2', 'Pricebook2'] };

describe('parents first: a parent object comes after the parent objects it needs', () => {
  it('PricebookEntry is ordered after Product2 and Pricebook2', () => {
    const steps = orderSteps(OBJECTS, DEPS);
    const names = steps.map(s => s.refObj);
    expect(names.indexOf('PricebookEntry')).toBeGreaterThan(names.indexOf('Product2'));
    expect(names.indexOf('PricebookEntry')).toBeGreaterThan(names.indexOf('Pricebook2'));
    expect(names).toEqual(['Account', 'Pricebook2', 'Product2', 'PricebookEntry']);
    expect(steps.find(s => s.refObj === 'PricebookEntry').dependsOn).toEqual(['Product2', 'Pricebook2']);
  });
  it('without dependency data the order is first-seen, as before', () => {
    expect(orderSteps(OBJECTS).map(s => s.refObj)).toEqual(['Account', 'Pricebook2', 'PricebookEntry', 'Product2']);
  });
  it('a dependency on an object that is not a step is ignored; a cycle keeps first-seen order', () => {
    expect(orderSteps(OBJECTS, { Account: ['Contract'] }).map(s => s.refObj)).toEqual(['Account', 'Pricebook2', 'PricebookEntry', 'Product2']);
    const cyc = orderSteps(OBJECTS, { Account: ['Product2'], Product2: ['Account'] }).map(s => s.refObj);
    expect(cyc).toHaveLength(4);
    expect(new Set(cyc).size).toBe(4);
  });
  it("'← next' skips a step whose own parents are not settled", () => {
    // even in first-seen order (no reorder), next never lands on PricebookEntry while Product2 is behind
    const steps = orderSteps(OBJECTS).map(s => ({ ...s, dependsOn: DEPS[s.refObj] || [],
      state: s.refObj === 'Account' || s.refObj === 'Pricebook2' ? 'done' : 'behind' }));
    const settled = s => s.state === 'done' || s.state === 'notneeded';
    expect(steps[nextIdx(steps, settled)].refObj).toBe('Product2');
    expect(nextIdx(steps.map(s => ({ ...s, state: 'done' })), settled)).toBe(-1);
    // a cycle among unsettled steps falls back to the first unsettled one rather than none
    const cyc = [{ refObj: 'A', dependsOn: ['B'], state: 'behind' }, { refObj: 'B', dependsOn: ['A'], state: 'behind' }];
    expect(nextIdx(cyc, settled)).toBe(0);
  });
  it('the card passes the dependency data and uses the guarded next step', () => {
    expect(DV).toContain('sftkDeployOrderSteps(objects, data.parentDeps)');
    expect(DV).toContain('const nextIdx = sftkDeployNextStepIdx(steps, settled);');
    expect(RC).toContain('return { offline: false, objects, parentDeps };');
  });
  it('the live parents-first script fails when the journey run ends failed in History', () => {
    expect(LIVE).toMatch(/if \(\/\^fail\/i\.test\(String\(runStatus\)\)\) throw new Error/);
  });
});
