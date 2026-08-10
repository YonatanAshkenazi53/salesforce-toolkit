// ⧉ Junction detection (user 2026-08-10: "we might need to catch junction
// early?"). A junction breaks three assumptions — both parents required,
// child-first impossible, Name-identity wrong (pair identity instead) —
// so it must be recognized the moment its describe is in hand.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

const bld = extractFunctions('studio-builder.js', ['sftkJunctionInfo']);
const j = bld.sftkJunctionInfo;

const f = (name, over) => Object.assign({
  name, type: 'reference', createable: true, nillable: true,
  relationshipOrder: null, referenceTo: ['X'],
}, over || {});

describe('sftkJunctionInfo — catch the junction at describe time', () => {
  it('two master-details = the classic junction', () => {
    const info = j([
      f('Step_Order__c', { relationshipOrder: 0, nillable: false }),
      f('Resource__c',   { relationshipOrder: 1, nillable: false }),
      { name: 'Name', type: 'string', nameField: true, autoNumber: true },
    ]);
    expect(info.isJunction).toBe(true);
    expect(info.masterDetails).toBe(2);
    expect(info.parents).toEqual(['Step_Order__c', 'Resource__c']);
    expect(info.nameIsAuto).toBe(true);
  });

  it('one master-detail + one REQUIRED lookup also joins two parents', () => {
    const info = j([
      f('Order__c',   { relationshipOrder: 0, nillable: false }),
      f('Product__c', { nillable: false }),
    ]);
    expect(info.isJunction).toBe(true);
  });

  it('a plain child (one MD, optional lookups) is NOT a junction', () => {
    const info = j([
      f('Parent__c', { relationshipOrder: 0, nillable: false }),
      f('Note_Ref__c'),   // optional lookup
    ]);
    expect(info.isJunction).toBe(false);
  });

  it('two OPTIONAL lookups (the user\'s Step_Order__c shape) are not a junction', () => {
    const info = j([
      f('Procedure_Definition__c'),
      f('Step_Order_Name__c'),
      { name: 'Name', type: 'string', nameField: true },
    ]);
    expect(info.isJunction).toBe(false);
    expect(info.nameIsAuto).toBe(false);
  });

  it('engine-owned refs never count as parents', () => {
    const info = j([
      f('Parent__c', { relationshipOrder: 0, nillable: false }),
      f('OwnerId', { nillable: false }),
      f('CreatedById', { nillable: false }),
    ]);
    expect(info.isJunction).toBe(false);
    expect(info.parents).toEqual(['Parent__c']);
  });

  it('tolerates garbage', () => {
    expect(j(null).isJunction).toBe(false);
    expect(j([]).parents).toEqual([]);
  });
});
