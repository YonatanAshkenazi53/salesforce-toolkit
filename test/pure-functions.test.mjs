// First real unit tests — the pure functions whose bugs have actually bitten
// this codebase (org identity matching, copy-field selection).
import { describe, it, expect } from 'vitest';
import { extractFunction } from './extract.mjs';

describe('_orgKey (studio.js) — org identity across Salesforce domain forms', () => {
  const _orgKey = extractFunction('studio.js', '_orgKey');

  it('collapses my.salesforce.com and lightning.force.com to the same key', () => {
    expect(_orgKey('https://acme-dev.develop.my.salesforce.com'))
      .toBe(_orgKey('https://acme-dev.develop.lightning.force.com'));
  });

  it('collapses the setup domain too', () => {
    expect(_orgKey('https://acme-dev.develop.my.salesforce-setup.com'))
      .toBe(_orgKey('https://acme-dev.develop.my.salesforce.com'));
  });

  it('ignores trailing slashes and paths', () => {
    expect(_orgKey('https://acme.my.salesforce.com/'))
      .toBe(_orgKey('https://acme.my.salesforce.com/lightning/page'));
  });

  it('is case-insensitive', () => {
    expect(_orgKey('https://ACME.my.salesforce.com'))
      .toBe(_orgKey('https://acme.my.salesforce.com'));
  });

  it('keeps DIFFERENT orgs different (the ashkenazy6/7 prefix-collision case)', () => {
    expect(_orgKey('https://ashkenazy6-dev-ed.develop.my.salesforce.com'))
      .not.toBe(_orgKey('https://ashkenazy7-dev-ed.develop.my.salesforce.com'));
  });

  it('returns empty string for empty input', () => {
    expect(_orgKey('')).toBe('');
    expect(_orgKey(null)).toBe('');
  });
});

describe('buildCopyFields (background.js) — which fields a transfer reads', () => {
  const buildCopyFields = extractFunction('background.js', 'buildCopyFields');

  const describeRes = {
    fields: [
      { name: 'Id',            createable: false, type: 'id' },
      { name: 'Name',          createable: true,  type: 'string' },
      { name: 'OwnerId',       createable: true,  type: 'reference' },   // SKIP-listed
      { name: 'CreatedDate',   createable: false, type: 'datetime' },    // SKIP-listed
      { name: 'AccountId',     createable: true,  type: 'reference' },
      { name: 'Formula__c',    createable: false, type: 'string' },      // read-only, not a ref
      { name: 'RefReadOnly__c', createable: false, type: 'reference' }   // refs kept even when not createable
    ]
  };

  it('always leads with Id', () => {
    expect(buildCopyFields(describeRes)[0]).toBe('Id');
  });

  it('keeps createable fields and reference fields, skips system + read-only', () => {
    const fields = buildCopyFields(describeRes);
    expect(fields).toContain('Name');
    expect(fields).toContain('AccountId');
    expect(fields).toContain('RefReadOnly__c');   // reference → kept for remapping
    expect(fields).not.toContain('OwnerId');      // deliberate skip
    expect(fields).not.toContain('CreatedDate');  // system skip
    expect(fields).not.toContain('Formula__c');   // read-only non-reference
  });

  it('degrades to [Id] on a malformed describe (no .accessible regression!)', () => {
    expect(buildCopyFields(null)).toEqual(['Id']);
    expect(buildCopyFields({})).toEqual(['Id']);
  });
});
