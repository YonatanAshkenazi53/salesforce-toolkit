// O1 — smart owner matching: the transfer engine's target-user index plus the
// parity contract behind it. background.js carries inline copies of the shared
// match-key engine (sftk-matching.js) because the worker CSP makes
// importScripts unusable — the batteries here fail the build if the copies
// ever drift from the canonical implementations.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

// sftkBuildOwnerIndex → sftkMatchKey → sftkNormalizeValue: one shared scope.
const { sftkBuildOwnerIndex } = extractFunctions('background.js',
  ['sftkNormalizeValue', 'sftkMatchKey', 'sftkPathValue', 'sftkBuildOwnerIndex']);

const SEP = String.fromCharCode(1);   // the composite-key component separator

describe('sftkBuildOwnerIndex (background.js) — target-user index for owner matching', () => {
  it('indexes each user by its match key over the picked fields', () => {
    const idx = sftkBuildOwnerIndex([
      { Id: '005A', Email: 'a@x.com', Name: 'Ann' },
      { Id: '005B', Email: 'b@x.com', Name: 'Bob' },
    ], { fields: ['Email'], normalize: {} });
    expect(idx.byKey['a@x.com']).toBe('005A');
    expect(idx.byKey['b@x.com']).toBe('005B');
    expect(idx.dups).toEqual([]);
  });

  it('builds composite keys with the U+0001 separator', () => {
    const idx = sftkBuildOwnerIndex(
      [{ Id: '005A', Email: 'a@x.com', Name: 'Ann' }],
      { fields: ['Email', 'Name'], normalize: {} });
    expect(idx.byKey[`a@x.com${SEP}Ann`]).toBe('005A');
  });

  it('EXCLUDES duplicated keys from byKey and reports them in dups', () => {
    const idx = sftkBuildOwnerIndex([
      { Id: '005A', Name: 'Pat Lee' },
      { Id: '005B', Name: 'Pat Lee' },   // same key — ambiguous
      { Id: '005C', Name: 'Pat Lee' },   // a third hit must not re-list it
      { Id: '005D', Name: 'Uniq' },
    ], { fields: ['Name'], normalize: {} });
    expect(idx.byKey['Pat Lee']).toBeUndefined();   // a dup match must fall back, never guess
    expect(idx.dups).toEqual(['Pat Lee']);
    expect(idx.byKey['Uniq']).toBe('005D');         // unrelated keys unaffected
  });

  it('never indexes blank keys (all components empty) — unmatchable, not dups', () => {
    const idx = sftkBuildOwnerIndex([
      { Id: '005A', Email: null, Name: '' },
      { Id: '005B', Email: null, Name: '' },   // two blanks are NOT a dup pair
      { Id: '005C', Email: 'c@x.com', Name: 'Cy' },
    ], { fields: ['Email', 'Name'], normalize: {} });
    expect(Object.keys(idx.byKey)).toEqual([`c@x.com${SEP}Cy`]);
    expect(idx.dups).toEqual([]);
  });

  it('normalization is part of the key: emailLower merges case-variant emails into a dup', () => {
    const users = [
      { Id: '005A', Email: 'Pat@X.com' },
      { Id: '005B', Email: 'pat@x.com' },
    ];
    const strict = sftkBuildOwnerIndex(users, { fields: ['Email'], normalize: {} });
    expect(strict.byKey['Pat@X.com']).toBe('005A');   // distinct without the toggle
    expect(strict.byKey['pat@x.com']).toBe('005B');
    expect(strict.dups).toEqual([]);
    const loose = sftkBuildOwnerIndex(users, { fields: ['Email'], normalize: { emailLower: true } });
    expect(loose.byKey['pat@x.com']).toBeUndefined(); // merged → ambiguous
    expect(loose.dups).toEqual(['pat@x.com']);
  });

  it('trim + caseFold variants fold to one key', () => {
    const idx = sftkBuildOwnerIndex(
      [{ Id: '005A', Name: '  Ann LEE ' }],
      { fields: ['Name'], normalize: { trim: true, caseFold: true } });
    expect(idx.byKey['ann lee']).toBe('005A');
  });

  it('degrades to an empty index on no users / no fields', () => {
    const noUsers = sftkBuildOwnerIndex(null, { fields: ['Name'] });
    expect(Object.keys(noUsers.byKey)).toEqual([]);
    expect(noUsers.dups).toEqual([]);
    const noFields = sftkBuildOwnerIndex([{ Id: '005A', Name: 'Ann' }], { fields: [] });
    expect(Object.keys(noFields.byKey)).toEqual([]);   // every key is '' → unmatchable
  });
});

describe('PARITY: background.js inline match-key copies vs canonical sftk-matching.js', () => {
  // Same contract as the sftkOrgKey parity test: background.js cannot
  // importScripts the shared lib (Trusted-Types CSP in worker scope), so it
  // carries inline copies. Keys MUST be built identically on both sides —
  // normalization is part of the key — so the batteries sweep the toggle and
  // value space rather than a couple of happy paths.
  const lib = extractFunctions('sftk-matching.js', ['sftkNormalizeValue', 'sftkMatchKey', 'sftkPathValue']);
  const bg  = extractFunctions('background.js',   ['sftkNormalizeValue', 'sftkMatchKey', 'sftkPathValue']);

  const VALUES = [
    null, undefined, '', '   ', '  Padded  ', 'a  b\t c',
    'John.Doe@Example.COM', ' spaced@example.com ', 'not an email @ x',
    '(415) 555-1234 x89', '+1 415 555 0100', '555-1234', '12345',
    'MiXeD Case Text', 0, 12345, false, true,
  ];
  const NORMALIZES = [
    undefined, {}, { trim: true }, { caseFold: true }, { collapseWs: true },
    { emailLower: true }, { phoneDigits: true },
    { trim: true, collapseWs: true, emailLower: true, phoneDigits: true, caseFold: true },
  ];

  it('sftkNormalizeValue agrees across the value × toggle battery', () => {
    for (const v of VALUES) {
      for (const n of NORMALIZES) {
        expect(bg.sftkNormalizeValue(v, n)).toBe(lib.sftkNormalizeValue(v, n));
      }
    }
  });

  const RECORDS = [
    null, {}, { Email: 'A@B.com', Name: 'x' }, { Email: '', Name: '' },
    { Email: null, Name: undefined }, { Name: '  Jo  ' },
    { Email: 'Pat@X.com', Name: 'Pat', Phone: '(415) 555-1234' },
  ];
  const MATCHINGS = [
    undefined, { fields: [] }, { fields: ['Email'] },
    { fields: ['Email', 'Name'], normalize: { emailLower: true } },
    { fields: ['Name', 'Phone'], normalize: { trim: true, caseFold: true, phoneDigits: true } },
    { fields: [null, 'Name'] },   // falsy entries must be filtered identically
  ];

  it('sftkMatchKey agrees across the record × matching battery', () => {
    for (const r of RECORDS) {
      for (const m of MATCHINGS) {
        expect(bg.sftkMatchKey(r, m)).toBe(lib.sftkMatchKey(r, m));
      }
    }
  });
});
