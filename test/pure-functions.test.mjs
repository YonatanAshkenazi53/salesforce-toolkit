// First real unit tests — the pure functions whose bugs have actually bitten
// this codebase (org identity matching, copy-field selection).
import { describe, it, expect } from 'vitest';
import { extractFunction, extractFunctions } from './extract.mjs';

describe('sftkOrgKey (sftk-org-identity.js) — org identity across Salesforce domain forms', () => {
  const _orgKey = extractFunction('sftk-org-identity.js', 'sftkOrgKey');

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

describe('sftkBuildStoredZip (sftk-zip.js) — the shared Metadata-deploy zip builder', () => {
  const { sftkCrc32, sftkBuildStoredZip } =
    extractFunctions('sftk-zip.js', ['sftkCrc32', 'sftkBuildStoredZip']);

  const abcBytes = new TextEncoder().encode('abc');

  it('computes the canonical CRC-32 of "abc" (0x352441C2)', () => {
    expect(sftkCrc32(abcBytes)).toBe(0x352441C2);
  });

  it('produces a structurally valid stored zip', () => {
    const b64 = sftkBuildStoredZip([{ name: 'a.txt', data: abcBytes }]);
    const zip = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const dv  = new DataView(zip.buffer);

    // Local file header at offset 0: PK\x03\x04, CRC at +14, sizes at +18/+22
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    expect(dv.getUint32(14, true)).toBe(0x352441C2);
    expect(dv.getUint32(18, true)).toBe(3);          // compressed = raw (stored)
    expect(dv.getUint32(22, true)).toBe(3);
    expect(dv.getUint16(26, true)).toBe(5);          // 'a.txt'.length

    // Filename + payload right after the 30-byte header
    const text = new TextDecoder().decode(zip.subarray(30, 38));
    expect(text).toBe('a.txtabc');

    // End-of-central-directory record in the last 22 bytes, 1 entry
    const eocdOff = zip.length - 22;
    expect(dv.getUint32(eocdOff, true)).toBe(0x06054b50);
    expect(dv.getUint16(eocdOff + 10, true)).toBe(1);
  });

  it('accepts strings for data and handles multiple files', () => {
    const b64 = sftkBuildStoredZip([
      { name: 'package.xml', data: '<Package/>' },
      { name: 'flows/X.flow', data: '<Flow/>' }
    ]);
    const zip = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const dv  = new DataView(zip.buffer);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    expect(dv.getUint16(zip.length - 22 + 10, true)).toBe(2);  // 2 entries
  });
});
