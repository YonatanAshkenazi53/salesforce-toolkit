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

  it('reads IsPersonAccount when the object has it — read-only, but the payload must know (2026-09-15)', () => {
    const d = { fields: [...describeRes.fields, { name: 'IsPersonAccount', createable: false, type: 'boolean' }] };
    expect(buildCopyFields(d)).toContain('IsPersonAccount');
    expect(buildCopyFields(describeRes)).not.toContain('IsPersonAccount');
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

describe('smart matching (sftk-matching.js) — the ONE shared key builder', () => {
  const { sftkNormalizeValue, sftkMatchKey, sftkMatchingFromNode } =
    extractFunctions('sftk-matching.js', ['sftkNormalizeValue', 'sftkMatchKey', 'sftkMatchingFromNode']);
  const sftkCrossOrgPreview = (() => {
    try { return extractFunction('sftk-matching.js', 'sftkCrossOrgPreview'); } catch { return null; }
  })();

  it('normalizes per toggles (case, whitespace, email, phone)', () => {
    expect(sftkNormalizeValue('  Word of Mouth ', { caseFold: true, trim: true, collapseWs: true }))
      .toBe(sftkNormalizeValue('word  OF   mouth', { caseFold: true, trim: true, collapseWs: true }));
    expect(sftkNormalizeValue('B.Levy@ACME.com', { emailLower: true }))
      .toBe(sftkNormalizeValue('b.levy@acme.com', { emailLower: true }));
    expect(sftkNormalizeValue('(03) 555-1234', { phoneDigits: true }))
      .toBe(sftkNormalizeValue('035551234', { phoneDigits: true }));
    expect(sftkNormalizeValue(null, {})).toBe('');
  });

  it('composite keys join components; all-blank → "" (unmatchable)', () => {
    const m = { strategy: 'composite', fields: ['FirstName', 'LastName'], normalize: { caseFold: true } };
    const k1 = sftkMatchKey({ FirstName: 'ANA', LastName: 'Levy' }, m);
    const k2 = sftkMatchKey({ FirstName: 'ana', LastName: 'LEVY' }, m);
    expect(k1).toBe(k2);
    expect(k1).toContain(String.fromCharCode(1));
    expect(sftkMatchKey({ FirstName: null, LastName: '' }, m)).toBe('');
    // Separator prevents cross-field bleed: ("ab","c") ≠ ("a","bc")
    const m2 = { strategy: 'composite', fields: ['A', 'B'], normalize: {} };
    expect(sftkMatchKey({ A: 'ab', B: 'c' }, m2)).not.toBe(sftkMatchKey({ A: 'a', B: 'bc' }, m2));
  });

  it('BACK-COMPAT: legacy node without .matching produces byte-identical keys to the old raw-value path', () => {
    const node = { matchField: 'Name' };
    const cfg = sftkMatchingFromNode(node);
    const rec = { Name: '  Acme & Söhne GmbH ' };   // weird value stays EXACTLY as stored
    expect(sftkMatchKey(rec, cfg)).toBe(String(rec.Name));
  });

  it('cross-org preview: unique 1:1, dup-either-side → ambiguous, no-target/blank → unmatched', () => {
    const p = sftkCrossOrgPreview(
      { keyCounts: new Map([['a', 1], ['b', 2], ['c', 1], ['d', 1]]), total: 5, blank: 1 },
      { keyCounts: new Map([['a', 1], ['b', 1], ['c', 2]]), total: 4, blank: 0 },
    );
    expect(p.matchedUnique).toBe(1);   // 'a' — 1:1
    expect(p.ambiguous).toBe(3);       // 'b' (2 src rows, dup) + 'c' (tgt dup, 1 src row)
    expect(p.unmatched).toBe(2);       // 'd' (no target) + 1 blank source key
    expect(p.sourceTotal).toBe(5);
  });
});

describe('P5 picklist sync diffs (studio-picklists.js)', () => {
  const { pkValueName, pkValueSetSyncDiff, pkRtSyncDiff } =
    extractFunctions('studio-picklists.js', ['pkValueName', 'pkValueSetSyncDiff', 'pkRtSyncDiff']);

  it('computes adds / label alignments / activations / deactivations / extras / default', () => {
    const src = [
      { fullName: 'Hot',  label: 'Hot',      default: true },
      { fullName: 'Warm', label: 'Warm-ish' },
      { fullName: 'Cold', label: 'Cold', isActive: false },
      { fullName: 'New',  label: 'Brand New' },
    ];
    const tgt = [
      { fullName: 'Hot',  label: 'Hot' },
      { fullName: 'Warm', label: 'Warm', default: true },
      { fullName: 'Cold', label: 'Cold' },              // active here, inactive in src
      { fullName: 'Extra', label: 'Extra' },            // not in source
    ];
    const d = pkValueSetSyncDiff(src, tgt);
    expect(d.adds).toEqual([{ name: 'New', label: 'Brand New', active: true }]);
    expect(d.labelChanges).toEqual([{ name: 'Warm', from: 'Warm', to: 'Warm-ish' }]);
    expect(d.activate).toEqual([]);
    expect(d.deactivate).toEqual(['Cold']);
    expect(d.extras).toEqual(['Extra']);
    expect(d.defaultChange).toEqual({ from: 'Warm', to: 'Hot' });
  });

  it('identical sets → empty diff, null defaultChange', () => {
    const vs = [{ fullName: 'A', label: 'A', default: true }, { fullName: 'B', label: 'B' }];
    const d = pkValueSetSyncDiff(vs, JSON.parse(JSON.stringify(vs)));
    expect(d.adds).toEqual([]);
    expect(d.labelChanges).toEqual([]);
    expect(d.deactivate).toEqual([]);
    expect(d.extras).toEqual([]);
    expect(d.defaultChange).toBeNull();
  });

  it('RT sync matches by DeveloperName and diffs assignments; unmatched RTs untouched', () => {
    const srcRts = [
      { id: 'S1', devName: 'Partner',  values: new Set(['Hot', 'Warm']) },
      { id: 'S2', devName: 'Internal', values: new Set(['Hot']) },
    ];
    const tgtRts = [
      { id: 'T1', devName: 'Partner',  values: new Set(['Hot', 'Extra']) },
      { id: 'T3', devName: 'OnlyHere', values: new Set(['Hot']) },   // no source twin
    ];
    const out = pkRtSyncDiff(srcRts, tgtRts);
    expect(out).toEqual([{ rtId: 'T1', devName: 'Partner', adds: ['Warm'], removes: ['Extra'] }]);
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

describe('match memory (M3c) — sftk-matching.js pure helpers', () => {
  const { sftkMemoryMerge, sftkPairSimilarity } =
    extractFunctions('sftk-matching.js', ['sftkMemoryMerge', 'sftkPairSimilarity']);

  it('sftkMemoryMerge merges, refreshes recency, evicts oldest past the cap', () => {
    const m1 = sftkMemoryMerge({}, [['s1', 't1'], ['s2', 't2']]);
    expect(m1).toEqual({ s1: 't1', s2: 't2' });
    // Re-learning s1 refreshes its recency, so with cap 2 the OLDEST (s2) is evicted.
    const m2 = sftkMemoryMerge(m1, [['s1', 't1b'], ['s3', 't3']], 2);
    expect(m2).toEqual({ s1: 't1b', s3: 't3' });
    // Junk pairs are ignored; the input map is never mutated.
    const base = { a: 'b' };
    const m3 = sftkMemoryMerge(base, [['', 'x'], ['y', ''], 'nope', ['z', 'w']]);
    expect(m3).toEqual({ a: 'b', z: 'w' });
    expect(base).toEqual({ a: 'b' });
  });

  it('sftkPairSimilarity: exact=1, per-component prefix credit, sane ranking', () => {
    const SEP = String.fromCharCode(1);
    expect(sftkPairSimilarity('acme', 'acme')).toBe(1);
    // component 1 equal (1), component 2 'levy' vs 'levi' → prefix 3 of 4 (0.75)
    expect(sftkPairSimilarity(`acme${SEP}levy`, `acme${SEP}levi`)).toBeCloseTo((1 + 0.75) / 2);
    // The closer candidate must rank higher (review modal sorts by this).
    const target = `globex${SEP}davis`;
    expect(sftkPairSimilarity(target, `globex${SEP}davies`))
      .toBeGreaterThan(sftkPairSimilarity(target, `initech${SEP}moore`));
  });
});

// ── ★ best key score (user 2026-08-10: "key suggestion should be a stronger
// feature") — the ranking behind auto-graded 💡 Suggestions. Worst-org-wins:
// a key that's perfect in the source but half-blank in the target is a bad
// key, full stop.
describe('sftkMatchKeyScore — worst-org populated×unique', () => {
  const { sftkMatchKeyScore } = extractFunctions('sftk-matching.js', ['sftkMatchKeyScore', 'sftkKeyStats']);
  const counts = pairs => ({
    keyCounts: new Map(pairs),
    total: pairs.reduce((n, [, c]) => n + c, 0),
    blank: 0,
  });

  it('perfect both sides → 100', () => {
    const c = counts([['a', 1], ['b', 1]]);
    expect(sftkMatchKeyScore({ src: c, tgt: counts([['a', 1], ['b', 1]]) })).toBe(100);
  });

  it('one weak org drags the score down to ITS product', () => {
    const good = counts([['a', 1], ['b', 1], ['c', 1], ['d', 1]]);
    // tgt: 4 records, 2 share a key → populated 100%, unique 50% → 50
    const dupTgt = counts([['a', 2], ['b', 1], ['c', 1]]);
    expect(sftkMatchKeyScore({ src: good, tgt: dupTgt })).toBe(50);
  });

  it('blanks hurt via populated%', () => {
    // 2 of 4 blank → populated 50%; both populated keys unique → unique 100% → 50
    const halfBlank = { keyCounts: new Map([['a', 1], ['b', 1]]), total: 4, blank: 2 };
    expect(sftkMatchKeyScore({ src: halfBlank, tgt: null })).toBe(50);
  });

  it('nothing graded → null, not zero', () => {
    expect(sftkMatchKeyScore({ src: null, tgt: null })).toBe(null);
    expect(sftkMatchKeyScore(null)).toBe(null);
  });

  // Multi-target (user 2026-08-11: "the highest matching keys per source
  // AND TARGETS and their data") — extra targets join the worst-org pool.
  it('an extra target with duplicate keys drags the score down', () => {
    const clean = counts([['a', 1], ['b', 1], ['c', 1], ['d', 1]]);
    const dupey = counts([['a', 2], ['b', 1], ['c', 1]]);   // 50
    expect(sftkMatchKeyScore({ src: clean, tgt: clean }, [dupey])).toBe(50);
    // …and unreachable extras (nulls filtered by the caller) change nothing.
    expect(sftkMatchKeyScore({ src: clean, tgt: clean }, [])).toBe(100);
    expect(sftkMatchKeyScore({ src: clean, tgt: clean })).toBe(100);
  });
});

describe('scan accuracy (🎯 — user request 2026-07-17)', () => {
  const sftkScanAccuracy = extractFunction('sftk-matching.js', 'sftkScanAccuracy');

  it('clean scan → 100% high; fields fall back to legacy matchField', () => {
    const acc = sftkScanAccuracy({ identical: [1], changed: [1], missingInTarget: [1], onlyInTarget: [] });
    expect(acc).toMatchObject({ pct: 100, grade: 'high', fields: ['Name'] });
    expect(acc.total).toBe(5);   // 2 matched pairs = 4 rows + 1 missing
  });

  it('blank keys and duplicated keys lower confidence (root dupKeys stay in buckets)', () => {
    // 1 matched pair (2 rows) + 1 missing + 1 blank → 3 of 4 rows certain = 75%
    const acc = sftkScanAccuracy({
      identical: [1], changed: [], missingInTarget: [2], onlyInTarget: [],
      blankKeys: { rows: 1, src: 1, tgt: 0 },
      matching: { strategy: 'composite', fields: ['FirstName', 'LastName'] },
    });
    expect(acc.pct).toBe(75);
    expect(acc.grade).toBe('low');
    expect(acc.fields).toEqual(['FirstName', 'LastName']);
    // Root dup rows are inside the buckets already — uncertain, not re-added.
    expect(sftkScanAccuracy({
      identical: [1, 2], changed: [], missingInTarget: [], onlyInTarget: [],
      dupKeys: { rows: 2 },
    }).pct).toBe(50);
    // Child collision rows were EXCLUDED from buckets — they extend the total.
    expect(sftkScanAccuracy({
      identical: [1], changed: [], missingInTarget: [], onlyInTarget: [],
      keyCollisions: { rows: 2, keys: ['k'] },
    }).pct).toBe(50);   // 2 certain of 4
  });

  it('ungradeable scans → null (error, or nothing on either side)', () => {
    expect(sftkScanAccuracy({ error: 'boom' })).toBeNull();
    expect(sftkScanAccuracy({ identical: [], changed: [], missingInTarget: [], onlyInTarget: [] })).toBeNull();
    expect(sftkScanAccuracy(null)).toBeNull();
  });
});

describe('scheduled ring probe summary (M4, background.js)', () => {
  const sftkProbeSummary = extractFunction('background.js', 'sftkProbeSummary');

  it('counts checked/drifted/skipped without conflating them', () => {
    expect(sftkProbeSummary([
      { drifted: true }, { drifted: false }, { skip: 'session', reason: 'x' },
      { drifted: true }, { skip: 'picked' },
    ])).toEqual({ checked: 3, drifted: 2, skipped: 2 });
    expect(sftkProbeSummary([])).toEqual({ checked: 0, drifted: 0, skipped: 0 });
    expect(sftkProbeSummary(null)).toEqual({ checked: 0, drifted: 0, skipped: 0 });
  });
});

describe('exact per-org field types (drift compare table)', () => {
  const sftkFieldTypeLabel = extractFunction('studio-scan.js', 'sftkFieldTypeLabel');

  it('names the precision that actually bites', () => {
    expect(sftkFieldTypeLabel({ type: 'double', precision: 18, scale: 2 })).toBe('Number(18,2)');
    expect(sftkFieldTypeLabel({ type: 'double', precision: 18, scale: 0 })).toBe('Number(18,0)');
    expect(sftkFieldTypeLabel({ type: 'currency', precision: 16, scale: 2 })).toBe('Currency(16,2)');
    expect(sftkFieldTypeLabel({ type: 'string', length: 255 })).toBe('Text(255)');
    expect(sftkFieldTypeLabel({ type: 'string', length: 80 })).toBe('Text(80)');
    expect(sftkFieldTypeLabel({ type: 'reference', referenceTo: ['Account'] })).toBe('Lookup(Account)');
    expect(sftkFieldTypeLabel({ type: 'picklist' })).toBe('Picklist');
    expect(sftkFieldTypeLabel(null)).toBe('');
  });
});

describe('Bulk API 2.0 codec + correlation (Phase B, background.js)', () => {
  const { sftkCsvField, sftkRecordsToCsv, sftkParseCsv } =
    extractFunctions('background.js', ['sftkCsvField', 'sftkRecordsToCsv', 'sftkParseCsv']);
  const sftkCorrelateBulkResults = extractFunction('background.js', 'sftkCorrelateBulkResults');

  it('CSV escaping: quotes, commas, newlines; null → #N/A (the Bulk null token)', () => {
    expect(sftkCsvField('plain')).toBe('plain');
    expect(sftkCsvField('a,b')).toBe('"a,b"');
    expect(sftkCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(sftkCsvField('line1\nline2')).toBe('"line1\nline2"');
    expect(sftkCsvField(null)).toBe('#N/A');
    expect(sftkCsvField(undefined)).toBe('#N/A');
    expect(sftkCsvField(0)).toBe('0');
  });

  it('records → CSV uses the union of keys and fills gaps', () => {
    const csv = sftkRecordsToCsv([{ Name: 'Acme, Inc', Phone: '555' }, { Name: 'B' }]);
    expect(csv).toBe('Name,Phone\n"Acme, Inc",555\nB,\n');
    expect(sftkRecordsToCsv([], ['Name'])).toBe('Name\n');
  });

  it('parses result CSVs with embedded commas, quotes and newlines', () => {
    const rows = sftkParseCsv('sf__Id,sf__Error,Name\n,"Required fields are missing: [X], fix it","A ""quoted"" name"\n001,,"multi\nline"\n');
    expect(rows.length).toBe(2);
    expect(rows[0]['sf__Error']).toBe('Required fields are missing: [X], fix it');
    expect(rows[0]['Name']).toBe('A "quoted" name');
    expect(rows[1]['sf__Id']).toBe('001');
    expect(rows[1]['Name']).toBe('multi\nline');
    expect(sftkParseCsv('')).toEqual([]);
    expect(sftkParseCsv('a,b\n')).toEqual([]);   // header only
  });

  it('correlates split success/failure CSVs back to upload order (child linking depends on it)', () => {
    const upload = [{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }];
    const res = sftkCorrelateBulkResults(upload, ['Name'],
      [{ sf__Id: '003', Name: 'C' }, { sf__Id: '001', Name: 'A' }],   // out of order vs upload
      [{ sf__Error: 'boom', Name: 'B' }]);
    expect(res.map(r => r.id)).toEqual(['001', null, '003']);
    expect(res.map(r => r.success)).toEqual([true, false, true]);
    expect(res[1].errors[0].message).toBe('boom');
  });

  it('duplicate rows are handed out in order; a missing result never silently succeeds', () => {
    const dup = [{ Name: 'X' }, { Name: 'X' }];
    const res = sftkCorrelateBulkResults(dup, ['Name'],
      [{ sf__Id: '001', Name: 'X' }], [{ sf__Error: 'dup rule', Name: 'X' }]);
    expect(res[0]).toMatchObject({ id: '001', success: true });
    expect(res[1].success).toBe(false);
    const orphan = sftkCorrelateBulkResults([{ Name: 'Z' }], ['Name'], [], []);
    expect(orphan[0].success).toBe(false);
    expect(orphan[0].errors[0].statusCode).toBe('BULK_NO_RESULT');
  });
});

describe('flow XML backup (N1 — sftk-flow-xml.js + zip round-trip)', () => {
  // sftkFlowToXml now routes apiVersion through sftkFlowApiVersionStr, so
  // the extraction has to materialise it too (shared-scope extraction
  // resolves a function's frees, it does not invent them).
  const { sftkFlowToXml, sftkFlowPackageXml, sftkFlowApiVersionStr, sftkFlowSetApiVersion } =
    extractFunctions('sftk-flow-xml.js', ['sftkFlowToXml', 'sftkFlowPackageXml', 'sftkXmlNode',
      'sftkXmlEscape', 'sftkFlowApiVersionStr', 'sftkFlowSetApiVersion']);

  // Salesforce accepts "62.0" and REJECTS "62" for a flow's apiVersion, and
  // the Tooling API hands it back as a NUMBER — so a plain serialize emits
  // the rejected form and the deploy fails with a message that never
  // mentions the version (user 2026-08-22, flow API-version changer).
  it('renders apiVersion in the one shape Salesforce accepts', () => {
    expect(sftkFlowApiVersionStr(62)).toBe('62.0');
    expect(sftkFlowApiVersionStr('62')).toBe('62.0');
    expect(sftkFlowApiVersionStr('v62.0')).toBe('62.0');
    expect(sftkFlowApiVersionStr(62.5)).toBe('62.5');
    expect(sftkFlowToXml({ apiVersion: 58 })).toContain('<apiVersion>58.0</apiVersion>');
  });

  it('an unreadable apiVersion is dropped, never guessed at', () => {
    expect(sftkFlowApiVersionStr('junk')).toBe(null);
    expect(sftkFlowApiVersionStr(null)).toBe(null);
    // Emitting <apiVersion></apiVersion> would be rejected; omitting it
    // lets Salesforce keep the flow's existing version.
    expect(sftkFlowToXml({ apiVersion: 'junk', label: 'X' })).not.toContain('apiVersion');
  });

  it('setting the version COPIES — a failed deploy leaves nothing half-edited', () => {
    const before = { apiVersion: 58, label: 'X', elements: [1] };
    const r = sftkFlowSetApiVersion(before, '62.0');
    expect(r.meta.apiVersion).toBe('62.0');
    expect(r.from).toBe('58.0');
    expect(r.to).toBe('62.0');
    expect(before.apiVersion).toBe(58);
    expect(r.meta.elements).toBe(before.elements);
  });

  it('refuses a target Salesforce would not accept, with the reason', () => {
    expect(sftkFlowSetApiVersion({ apiVersion: 58 }, 'latest').error).toContain('latest');
    expect(sftkFlowSetApiVersion(null, '62.0').error).toContain('no flow metadata');
  });

  it('serializes a Flow: alphabetical elements, arrays repeated, nulls omitted, text escaped', () => {
    const xml = sftkFlowToXml({
      status: 'Active',
      label: 'Send & Notify <Owner>',
      apiVersion: 62,
      description: null,
      decisions: [
        { name: 'D1', rules: [{ name: 'R1', conditionLogic: 'and' }] },
        { name: 'D2' },
      ],
      start: { locationX: 50, connector: { targetReference: 'D1' } },
    });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata">\n')).toBe(true);
    expect(xml).toContain('<label>Send &amp; Notify &lt;Owner&gt;</label>');
    expect(xml).not.toContain('<description>');                    // null omitted
    expect((xml.match(/<decisions>/g) || []).length).toBe(2);      // array → repeated
    expect(xml).toContain('<targetReference>D1</targetReference>');
    // alphabetical: apiVersion before decisions before label before start
    const order = ['<apiVersion>', '<decisions>', '<label>', '<start>'].map(s => xml.indexOf(s));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(xml.trim().endsWith('</Flow>')).toBe(true);
  });

  it('package.xml lists sorted unique members with the Flow type', () => {
    const pkg = sftkFlowPackageXml(['Zeta', 'Alpha', 'Zeta']);
    expect(pkg.indexOf('<members>Alpha</members>')).toBeLessThan(pkg.indexOf('<members>Zeta</members>'));
    expect((pkg.match(/<members>Zeta<\/members>/g) || []).length).toBe(1);
    expect(pkg).toContain('<name>Flow</name>');
  });

  it('stored-zip write → read round-trips the backup artifact', () => {
    const { sftkBuildStoredZip } = extractFunctions('sftk-zip.js', ['sftkCrc32', 'sftkBuildStoredZip']);
    const sftkReadStoredZip = extractFunction('sftk-zip.js', 'sftkReadStoredZip');
    const b64 = sftkBuildStoredZip([
      { name: 'package.xml', data: '<Package/>' },
      { name: 'flows/My_Flow.flow', data: '<Flow>x</Flow>' },
      { name: 'backup.json', data: '{"flows":[]}' },
    ]);
    const entries = sftkReadStoredZip(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
    expect(Object.keys(entries).sort()).toEqual(['backup.json', 'flows/My_Flow.flow', 'package.xml']);
    expect(new TextDecoder().decode(entries['backup.json'])).toBe('{"flows":[]}');
    expect(new TextDecoder().decode(entries['flows/My_Flow.flow'])).toBe('<Flow>x</Flow>');
  });
});

describe('per-target field-mapping overrides (sftkResolveMappings)', () => {
  const sftkResolveMappings = extractFunction('studio-core.js', 'sftkResolveMappings');
  const base = { Rating: 'Rating__c', Name: 'Name', Phone: null };

  it('override wins; null excludes; absent falls through to base; base never mutated', () => {
    const overrides = { orgA: { Rating: 'Acct_Rating__c', Name: null } };
    expect(sftkResolveMappings(base, overrides, 'orgA'))
      .toEqual({ Rating: 'Acct_Rating__c', Name: null, Phone: null });
    expect(sftkResolveMappings(base, overrides, 'orgB')).toEqual(base);
    expect(sftkResolveMappings(base, null, 'orgA')).toEqual(base);
    expect(base.Rating).toBe('Rating__c');   // input untouched
  });

  it('resolution is idempotent (chokepoints may run twice)', () => {
    const overrides = { orgA: { Rating: 'Acct_Rating__c' } };
    const once = sftkResolveMappings(base, overrides, 'orgA');
    expect(sftkResolveMappings(once, overrides, 'orgA')).toEqual(once);
  });
});

describe('multi-org schema check (builder 🧪 Check all targets)', () => {
  const bldSchemaGaps = extractFunction('studio-builder.js', 'bldSchemaGaps');
  const tree = {
    objectType: 'Account',
    fieldMappings: { Name: 'Name', Rating: 'Rating__c', Skip__c: null },
    children: [{ childSObject: 'Contact', field: 'AccountId', fieldMappings: { LastName: '' } }],
  };

  it('flags missing objects, missing mapped fields, and missing link fields', () => {
    const gaps = bldSchemaGaps(tree, {
      Account: { fields: [{ name: 'Name' }] },     // Rating__c missing; Skip__c excluded → ignored
      Contact: null,                                // whole object missing
    });
    expect(gaps).toContainEqual({ object: 'Account', field: 'Rating__c' });
    expect(gaps).toContainEqual({ object: 'Contact', missing: 'object' });
    expect(gaps.find(g => g.field === 'Skip__c')).toBeUndefined();
  });

  it('empty mapping assumes same name; link fields are flagged as links; clean org → no gaps', () => {
    const gaps = bldSchemaGaps(tree, {
      Account: { fields: [{ name: 'Name' }, { name: 'Rating__c' }] },
      Contact: { fields: [{ name: 'LastName' }] },  // AccountId link missing
    });
    expect(gaps).toEqual([{ object: 'Contact', field: 'AccountId', link: true }]);
    const clean = bldSchemaGaps(tree, {
      Account: { fields: [{ name: 'Name' }, { name: 'Rating__c' }] },
      Contact: { fields: [{ name: 'LastName' }, { name: 'AccountId' }] },
    });
    expect(clean).toEqual([]);
  });
});

describe('flow reference extraction (N4 blast radius)', () => {
  const sftkFlowRefs = extractFunction('dependency-map.js', 'sftkFlowRefs');

  it('extracts objects+ops, fields, subflows, apex, $Record/$Label refs', () => {
    const refs = sftkFlowRefs({
      start: { object: 'Account', filters: [{ field: 'SLA__c', operator: 'EqualTo', value: { stringValue: 'Gold' } }], triggerType: 'RecordAfterSave' },
      recordLookups: [{ object: 'Contact', filters: [{ field: 'Email' }], queriedFields: ['LastName'], outputAssignments: [] }],
      recordUpdates: [{ object: 'Account', filters: [], inputAssignments: [{ field: 'Rating' }] }],
      variables: [{ name: 'acc', objectType: 'Opportunity' }],
      subflows: [{ flowName: 'Child_Flow' }],
      actionCalls: [{ actionType: 'apex', actionName: 'MyInvocable' }, { actionType: 'emailSimple', actionName: 'sendEmail' }],
      formulas: [{ expression: '{!$Record.Custom__c} & $Label.My_Label' }],
    });
    expect(refs.objects).toContainEqual({ name: 'Account', ops: ['trigger', 'update'] });
    expect(refs.objects).toContainEqual({ name: 'Contact', ops: ['read'] });
    expect(refs.objects).toContainEqual({ name: 'Opportunity', ops: ['variable'] });
    expect(refs.fields).toEqual(expect.arrayContaining(
      ['Account.SLA__c', 'Contact.Email', 'Contact.LastName', 'Account.Rating', 'Account.Custom__c']));
    expect(refs.subflows).toEqual(['Child_Flow']);
    expect(refs.apex).toEqual(['MyInvocable']);   // non-apex action excluded
    expect(refs.labels).toEqual(['My_Label']);
  });

  it('degrades to empty ref sets on junk input', () => {
    expect(sftkFlowRefs(null)).toEqual({ objects: [], fields: [], subflows: [], apex: [], labels: [] });
    expect(sftkFlowRefs({}).objects).toEqual([]);
  });
});

describe('record types in the Picklist Manager matrix (2026-07-18)', () => {
  const { pkRtCellInfo, pkRtDrift } =
    extractFunctions('studio-picklists.js', ['pkRtCellInfo', 'pkRtDrift']);

  it('pkRtCellInfo counts and names the record types that include a value', () => {
    const rts = [
      { name: 'Sales',   devName: 'Sales',   values: new Set(['Gold', 'Silver']) },
      { name: 'Support', devName: 'Support', values: new Set(['Silver']) },
    ];
    expect(pkRtCellInfo(rts, 'Gold')).toEqual({ inCount: 1, total: 2, names: ['Sales'] });
    expect(pkRtCellInfo(rts, 'Bronze')).toEqual({ inCount: 0, total: 2, names: [] });
    expect(pkRtCellInfo(null, 'Gold')).toEqual({ inCount: 0, total: 0, names: [] });
  });

  it('pkRtDrift: same-devName RTs disagreeing across orgs = drift; RT missing in an org ≠ drift', () => {
    const orgA = [{ devName: 'Sales', values: new Set(['Gold']) }];
    const orgB = [{ devName: 'Sales', values: new Set([]) }];        // Sales disagrees on Gold
    const orgC = [{ devName: 'OnlyHere', values: new Set(['Gold']) }]; // RT exists in one org only
    expect(pkRtDrift([orgA, orgB], 'Gold')).toBe(true);
    expect(pkRtDrift([orgA, orgA], 'Gold')).toBe(false);
    expect(pkRtDrift([orgA, orgC], 'Gold')).toBe(false);   // no shared devName → comparable in 0 orgs
    expect(pkRtDrift([], 'Gold')).toBe(false);
  });
});

describe('standard picklist helpers (studio-picklists.js) — SVS name resolution + describe fallback', () => {
  const { sftkSvsCandidates, sftkDescribeValues } = extractFunctions('studio-picklists.js',
    ['sftkSvsCandidates', 'sftkDescribeValues']);

  it('Account.Type resolves to AccountType FIRST (the bug: plain "Type" matched nothing)', () => {
    expect(sftkSvsCandidates('Account', 'Type')).toEqual(['AccountType', 'Type']);
  });

  it('Opportunity.StageName goes through the special map to OpportunityStage', () => {
    const c = sftkSvsCandidates('Opportunity', 'StageName');
    expect(c[0]).toBe('OpportunityStage');
    expect(c).toContain('StageName');
  });

  it('shared bare-name sets (Industry, Salutation, LeadSource) keep the bare field as a candidate', () => {
    expect(sftkSvsCandidates('Lead', 'Industry')).toContain('Industry');
    expect(sftkSvsCandidates('Contact', 'Salutation')).toContain('Salutation');
    expect(sftkSvsCandidates('Contact', 'LeadSource')).toContain('LeadSource');
  });

  it('special-map candidates come first and the list never holds duplicates', () => {
    const c = sftkSvsCandidates('AccountContactRole', 'Role');
    expect(c[0]).toBe('AccountContactRole');
    expect(new Set(c).size).toBe(c.length);   // obj+field === special here — deduped
  });

  it('sftkDescribeValues maps describe picklistValues to pkValueName shape, active only', () => {
    const out = sftkDescribeValues({ picklistValues: [
      { value: 'Prospect', label: 'Prospect', active: true, defaultValue: false },
      { value: 'Old', label: 'Old Label', active: false, defaultValue: false },
      { value: 'Hot', label: 'Hot!', active: true, defaultValue: true },
    ] });
    expect(out.map(v => v.fullName)).toEqual(['Prospect', 'Hot']);
    expect(out[1].label).toBe('Hot!');
    expect(out[1].default).toBe(true);
    expect(out.every(v => v.isActive === true)).toBe(true);
  });

  it('sftkDescribeValues survives a missing field / empty picklist', () => {
    expect(sftkDescribeValues(null)).toEqual([]);
    expect(sftkDescribeValues({})).toEqual([]);
  });
});

describe('profileTargets (studio-core.js) — an org is never a target of itself', () => {
  // Pinned targetOrgs used to be returned VERBATIM, so a profile whose source
  // was later changed to one of its own targets (or imported/hand-edited that
  // way) would deploy the org onto itself: every record matches itself and the
  // "sync" writes the source over the source. The builder now locks the source
  // out of the picker; this pins the engine-side chokepoint that every run,
  // scan and fan-out resolves through. (user 2026-07-30)
  // _orgKey delegates to the shared identity lib, so both must live in one scope.
  const { profileTargets } = extractFunctions('studio-core.js', ['_orgKey', 'profileTargets'],
    { 'sftk-org-identity.js': ['sftkOrgKey'] });
  const A = 'https://acme.my.salesforce.com';
  const B = 'https://acme-dev.develop.my.salesforce.com';
  const C = 'https://acme--qa.sandbox.my.salesforce.com';

  it('drops the source from a PINNED target list', () => {
    expect(profileTargets({ sourceOrg: A, targetOrgs: [A, B, C] })).toEqual([B, C]);
  });

  it('matches the source across Salesforce domain forms, not by string equality', () => {
    const lightning = 'https://acme.lightning.force.com';
    expect(profileTargets({ sourceOrg: lightning, targetOrgs: [A, B] })).toEqual([B]);
  });

  it('a pinned list of ONLY the source resolves to no targets, not to itself', () => {
    expect(profileTargets({ sourceOrg: A, targetOrgs: [A] })).toEqual([]);
  });

  it('drops a legacy single targetOrg that equals the source', () => {
    expect(profileTargets({ sourceOrg: A, targetOrg: A })).toEqual([]);
    expect(profileTargets({ sourceOrg: A, targetOrg: B })).toEqual([B]);
  });

  it('leaves a legitimate pinned set untouched', () => {
    expect(profileTargets({ sourceOrg: A, targetOrgs: [B, C] })).toEqual([B, C]);
  });

  it('survives junk input', () => {
    expect(profileTargets(null)).toEqual([]);
    expect(profileTargets({})).toEqual([]);
    expect(profileTargets({ sourceOrg: A, targetOrgs: [] })).toEqual([]);
  });
});

// Disclosure lines are NOTES, not errors (user 2026-08-10: a fully
// successful run showed "2 errors" that were its own 🔗 hand-pick
// disclosures — nothing was wrong).
describe('sftkFriendlyError — disclosures never wear the red ✗', () => {
  const { sftkFriendlyError: fe } =
    extractFunctions('sftk-friendly-error.js', ['sftkDecodeEntities', 'sftkFriendlyError']);
  it('🔗 / 📎 / hand-pick lines classify as notes', () => {
    expect(fe('🔗 2 lookup value(s) written from hand-picked targets (your Reconcile 🔗 picks — they beat name-matching)').kind).toBe('note');
    expect(fe('update: Step_Order__c: 1 lookup value(s) set from per-record hand-picks (Reconcile → lookup overrides).').kind).toBe('note');
    expect(fe('Step_Order__c: 📎 files — 3 copied, 3 link(s) created, 1 already present (checksum match), 0 failed.').kind).toBe('note');
  });
  it('real failures still classify as errors', () => {
    expect(fe('Step_Order__c: Required fields are missing: [Procedure_Definition__c]').kind).toBe('error');
  });
});
