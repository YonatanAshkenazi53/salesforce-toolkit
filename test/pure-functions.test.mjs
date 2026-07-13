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

  it('PARITY: background.js inline copy behaves identically to the canonical lib', () => {
    // background.js cannot importScripts the shared lib (Trusted-Types CSP +
    // trustedTypes factory absent in worker scope on some Chrome builds), so
    // it carries an inline copy. This test fails the build if they diverge.
    const bgCopy = extractFunction('background.js', 'sftkOrgKey');
    const URLS = [
      'https://acme-dev.develop.my.salesforce.com',
      'https://acme-dev.develop.lightning.force.com',
      'https://acme-dev.develop.my.salesforce-setup.com',
      'https://ACME.my.salesforce.com/lightning/page',
      'https://foo.my.site.com', 'https://x.force.com',
      'not a url', '', null, 'https://evil.com/?x=.my.salesforce.com',
    ];
    for (const u of URLS) expect(bgCopy(u)).toBe(_orgKey(u));
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

describe('sftkFriendlyError (sftk-friendly-error.js) — raw run errors → plain language', () => {
  const { sftkFriendlyError } =
    extractFunctions('sftk-friendly-error.js', ['sftkDecodeEntities', 'sftkFriendlyError']);

  it('translates the invalid-email failure and spots HTML-escaped addresses', () => {
    const f = sftkFriendlyError('update: contact: Email: invalid email address: b.levy@expressl&amp;t.net');
    expect(f.kind).toBe('error');
    expect(f.object).toBe('contact');
    expect(f.phase).toBe('updating target records');
    expect(f.message).toContain("isn't a valid address");
    expect(f.hint).toContain('b.levy@expressl&t.net');   // decoded intended value
  });

  it('parses target-reject skipped fields into per-field rows', () => {
    const f = sftkFriendlyError("⚠ update: ⚠ skipped 6 mapped field(s) the target org can't accept: MailingCountryCode → MailingCountryCode (missing in target), Name → Name (read-only in target), test__c → test__c (missing in target) — open ✏ Edit → Fields & mapping to fix");
    expect(f.kind).toBe('note');
    expect(f.type).toBe('skipped-fields');
    expect(f.fields).toHaveLength(3);
    expect(f.fields[0]).toEqual({ field: 'MailingCountryCode', reason: 'missing in target' });
    expect(f.fields[1].reason).toBe('read-only in target');
  });

  it('parses stale-source skipped fields', () => {
    const f = sftkFriendlyError('⚠ update: ⚠ skipped 1 mapped field(s) that no longer exist on contact in the source org: Last_Customer_Verification__c — open ✏ Edit → Fields & mapping to clean them up');
    expect(f.type).toBe('skipped-fields');
    expect(f.fields).toEqual([{ field: 'Last_Customer_Verification__c', reason: 'no longer exists in the source org' }]);
  });

  it('handles No such column and preserves ×N counts', () => {
    const f = sftkFriendlyError("contact: No such column 'test__c' on sobject of type Contact  (×17)");
    expect(f.type).toBe('missing-field');
    expect(f.count).toBe(17);
    expect(f.message).toContain('test__c');
  });

  it('passes unknown errors through untranslated with raw preserved', () => {
    const f = sftkFriendlyError('something completely novel went wrong');
    expect(f.type).toBe('generic');
    expect(f.message).toBe('something completely novel went wrong');
    expect(f.raw).toBe('something completely novel went wrong');
  });
});

describe('pkMultiRemap (studio-picklists.js) — multipicklist token surgery', () => {
  const pkMultiRemap = extractFunction('studio-picklists.js', 'pkMultiRemap');

  it('remaps one token in place', () => {
    expect(pkMultiRemap('A;B;C', 'B', 'X')).toBe('A;X;C');
  });
  it('clears a token when newVal is null', () => {
    expect(pkMultiRemap('A;B;C', 'B', null)).toBe('A;C');
  });
  it('dedupes when the target already exists in the selection', () => {
    expect(pkMultiRemap('A;X', 'A', 'X')).toBe('X');
  });
  it('handles whitespace and empty segments', () => {
    expect(pkMultiRemap(' A ; B ;; C ', 'B', 'X')).toBe('A;X;C');
  });
  it('clearing the only token yields empty string', () => {
    expect(pkMultiRemap('B', 'B', null)).toBe('');
  });
  it('leaves untouched selections alone', () => {
    expect(pkMultiRemap('A;C', 'B', 'X')).toBe('A;C');
  });
});

describe('picklist P2/P3 pure helpers (studio-picklists.js)', () => {
  const pkValueUnion   = extractFunction('studio-picklists.js', 'pkValueUnion');
  // pkBuildMatrix calls pkValueName → materialize both in one scope.
  const { pkBuildMatrix } = extractFunctions('studio-picklists.js', ['pkValueName', 'pkBuildMatrix']);
  const pkValueMentions = extractFunction('studio-picklists.js', 'pkValueMentions');
  const pkDedupeErrors = extractFunction('studio-picklists.js', 'pkDedupeErrors');
  const pkRtMatrixDiff = extractFunction('studio-picklists.js', 'pkRtMatrixDiff');

  it('pkValueUnion preserves first-seen order across orgs', () => {
    expect(pkValueUnion([
      { values: ['Hot', 'Warm'] },
      { values: ['Warm', 'Cold'] },
      { values: ['Hot', 'Frozen'] },
    ])).toEqual(['Hot', 'Warm', 'Cold', 'Frozen']);
  });

  it('pkBuildMatrix marks exists/active/count and missing-org cells', () => {
    const inv = { rawValues: [{ fullName: 'Hot', isActive: true }, { fullName: 'Cold', isActive: false }],
                  usage: new Map([['Hot', 5]]) };
    const m = pkBuildMatrix([
      { orgKey: 'a', inv },
      { orgKey: 'b', inv: null },   // org not open → missing
    ], ['Hot', 'Cold', 'Ghost']);
    const hot = m.rows[0].cells;
    expect(hot[0]).toMatchObject({ orgKey: 'a', exists: true, active: true, count: 5 });
    expect(hot[1]).toMatchObject({ orgKey: 'b', missing: true });
    expect(m.rows[1].cells[0]).toMatchObject({ exists: true, active: false });   // Cold inactive
    expect(m.rows[2].cells[0]).toMatchObject({ exists: false });                 // Ghost absent
  });

  it('pkValueMentions counts literal occurrences and escapes regex chars', () => {
    expect(pkValueMentions('status=Hot; when Hot then Hot', 'Hot')).toBe(3);
    expect(pkValueMentions('a.b matched a.b', 'a.b')).toBe(2);   // '.' literal, not wildcard
    expect(pkValueMentions('axb', 'a.b')).toBe(0);
  });

  it('pkDedupeErrors collapses repeats with ×N', () => {
    const out = pkDedupeErrors(['bad', 'bad', 'bad', 'other']);
    expect(out).toContain('bad  (×3)');
    expect(out).toContain('other');
    expect(out).toHaveLength(2);
  });

  it('pkRtMatrixDiff computes adds/removes only for changed record types', () => {
    const rts = [
      { id: 'rtA', values: new Set(['Hot']) },
      { id: 'rtB', values: new Set(['Cold']) },
    ];
    const edited = new Map([
      ['rtA|Hot', true],   // unchanged (had it)
      ['rtA|Cold', true],  // add
      ['rtB|Cold', false], // remove
    ]);
    const diff = pkRtMatrixDiff(rts, edited);
    expect(diff).toContainEqual({ rtId: 'rtA', adds: ['Cold'], removes: [] });
    expect(diff).toContainEqual({ rtId: 'rtB', adds: [], removes: ['Cold'] });
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
