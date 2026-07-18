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

describe('tree diff helpers (studio-treediff.js)', () => {
  const tdSuggest = extractFunction('studio-treediff.js', 'tdSuggest');
  const tdTreeNodes = extractFunction('studio-treediff.js', 'tdTreeNodes');
  const tdCounts = extractFunction('studio-treediff.js', 'tdCounts');

  it('suggests operations in execution order, child-first annotated', () => {
    expect(tdSuggest({ missing: 12, changed: 3, extra: 1, link: 4 }, 1, 'childFirst'))
      .toEqual(['⬆ push 12 (child-first)', '✏ overwrite 3', '🔗 relink 4', '🔵 review 1 extra']);
    expect(tdSuggest({ missing: 0, changed: 0, extra: 0, link: 0 }, 0)).toEqual([]);
  });

  it('flattens the tree to depth 2 with pathKeys', () => {
    const tree = { objectType: 'Account', children: [
      { childSObject: 'Contact', children: [{ childSObject: 'Task', children: [] }] },
      { childSObject: 'Case', children: [] },
    ] };
    const nodes = tdTreeNodes(tree);
    expect(nodes.map(n => n.pathKey)).toEqual(['', '0', '0.0', '1']);
    expect(nodes.map(n => n.depth)).toEqual([0, 1, 2, 1]);
  });

  it('counts buckets, null for failed/absent scans', () => {
    expect(tdCounts({ missingInTarget: [1, 2], changed: [1], onlyInTarget: [], linkMismatch: [1], identical: [1, 2, 3] }))
      .toEqual({ missing: 2, changed: 1, extra: 0, link: 1, identical: 3 });
    expect(tdCounts(null)).toBeNull();
    expect(tdCounts({ error: 'x' })).toBeNull();
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
