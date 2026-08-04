// PII MASKING v1 — the ENGINE side of the policy. Batteries for the three
// engine-only helpers in background.js (policy → per-object rules, per-record
// masked rows with the per-run hash cache, bridge-anchor masking), plus
// source assertions pinning that executeProfileTransfer routes EVERY write
// path (REST insert, upsert injection, Bulk CSV) through the masked payloads,
// hard-errors on a missing salt BEFORE any write, and never quotes a covered
// raw value in diagnostics or History labels (T11b).
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunctions } from './extract.mjs';

const NAMES = ['sftkPiiHashHex', 'sftkPiiMaskable', 'sftkPiiFormat', 'sftkPiiMaskValue',
               'sftkPiiRulesForObject', 'sftkPiiMaskRows', 'sftkPiiMaskAnchorMap'];
const eng = extractFunctions('background.js', NAMES);

const SALT = 'a3f1c9d200aa11bb22cc33dd44ee55ff';

// A Contact-shaped source describe (only the properties the helpers read).
const FIELDS = [
  { name: 'Id',        type: 'id',        createable: false },
  { name: 'Email',     type: 'email',     length: 80,  createable: true },
  { name: 'FirstName', type: 'string',    length: 40,  createable: true },
  { name: 'Name',      type: 'string',    length: 121, createable: false, nameField: true },
  { name: 'Birthdate', type: 'date',      createable: true },
  { name: 'AccountId', type: 'reference', createable: true },
  { name: 'OwnerId',   type: 'reference', createable: true },
];

describe('sftkPiiRulesForObject — policy keys → one object\'s rules', () => {
  it('maps a covered field under its DESCRIBE-cased name, with rule + desc', () => {
    const out = eng.sftkPiiRulesForObject({ 'Contact.Email': { strategy: 'hash' } }, 'Contact', FIELDS);
    expect(Object.keys(out)).toEqual(['Email']);
    expect(out.Email.rule).toEqual({ strategy: 'hash' });
    expect(out.Email.desc).toBe(FIELDS[1]);
  });

  it('matches object AND field case-insensitively (API names are)', () => {
    const out = eng.sftkPiiRulesForObject({ 'contact.EMAIL': { strategy: 'hash' } }, 'Contact', FIELDS);
    expect(Object.keys(out)).toEqual(['Email']);
  });

  it('ignores keys for other objects', () => {
    expect(eng.sftkPiiRulesForObject({ 'Lead.Email': { strategy: 'hash' } }, 'Contact', FIELDS)).toBeNull();
  });

  it('excludes engine-resolved fields — their branches never write the source value', () => {
    const policy = {
      'Contact.Id':           { strategy: 'hash' },
      'Contact.OwnerId':      { strategy: 'hash' },
      'Contact.RecordTypeId': { strategy: 'hash' },
      'Contact.CreatedById':  { strategy: 'null' },
    };
    expect(eng.sftkPiiRulesForObject(policy, 'Contact', FIELDS)).toBeNull();
  });

  it('skips fields absent from the describe (never fetched, nothing to mask)', () => {
    expect(eng.sftkPiiRulesForObject({ 'Contact.Ghost__c': { strategy: 'hash' } }, 'Contact', FIELDS)).toBeNull();
  });

  it('ignores dotless keys and falsy rules; null/empty input → null', () => {
    expect(eng.sftkPiiRulesForObject({ Email: { strategy: 'hash' }, 'Contact.Email': null }, 'Contact', FIELDS)).toBeNull();
    expect(eng.sftkPiiRulesForObject(null, 'Contact', FIELDS)).toBeNull();
    expect(eng.sftkPiiRulesForObject({}, 'Contact', FIELDS)).toBeNull();
  });
});

describe('sftkPiiMaskRows — every covered value of every fetched record', () => {
  const RULES = {
    Email:     { rule: { strategy: 'hash' },  desc: { type: 'email',  length: 80 } },
    Birthdate: { rule: { strategy: 'hash' },  desc: { type: 'date' } },
    FirstName: { rule: { strategy: 'fixed', value: 'REDACTED' }, desc: { type: 'string', length: 40 } },
  };

  it('hashes a maskable value exactly like the shared library would', async () => {
    const { rows, counts } = await eng.sftkPiiMaskRows(
      [{ Email: 'jane@real.com' }], 'Contact', { Email: RULES.Email }, SALT, new Map());
    const hex = createHash('sha256').update(`${SALT}|jane@real.com`).digest('hex');
    expect(rows[0].Email).toEqual({
      value: eng.sftkPiiFormat(hex, RULES.Email.desc), action: 'hashed' });
    expect(counts).toEqual({ hashed: 1, nulled: 0, fixed: 0 });
  });

  it('nulls (and COUNTS) hash on a non-maskable type — 0/false are values, not empties', async () => {
    const rules = {
      Birthdate: RULES.Birthdate,
      Score__c:  { rule: { strategy: 'hash' }, desc: { type: 'double' } },
      Flag__c:   { rule: { strategy: 'hash' }, desc: { type: 'boolean' } },
    };
    const { rows, counts } = await eng.sftkPiiMaskRows(
      [{ Birthdate: '1990-04-01', Score__c: 0, Flag__c: false }], 'Contact', rules, SALT, new Map());
    expect(rows[0].Birthdate).toEqual({ value: null, action: 'nulled' });
    expect(rows[0].Score__c).toEqual({ value: null, action: 'nulled' });
    expect(rows[0].Flag__c).toEqual({ value: null, action: 'nulled' });
    expect(counts).toEqual({ hashed: 0, nulled: 3, fixed: 0 });
  });

  it('keeps null / undefined / empty-string sources untouched and UNCOUNTED', async () => {
    const { rows, counts } = await eng.sftkPiiMaskRows(
      [{ Email: null }, { Email: '' }, {}], 'Contact', { Email: RULES.Email }, SALT, new Map());
    expect(rows[0].Email.action).toBe('kept');
    expect(rows[0].Email.value).toBeNull();
    expect(rows[1].Email).toEqual({ value: '', action: 'kept' });
    expect(rows[2].Email.action).toBe('kept');
    expect(counts).toEqual({ hashed: 0, nulled: 0, fixed: 0 });
  });

  it('applies fixed rules and tallies all three counters across records', async () => {
    const recs = [
      { Email: 'jane@real.com', Birthdate: '1990-04-01', FirstName: 'Jane' },
      { Email: 'john@real.com', Birthdate: null,          FirstName: 'John' },
    ];
    const { rows, counts } = await eng.sftkPiiMaskRows(recs, 'Contact', RULES, SALT, new Map());
    expect(rows[0].FirstName).toEqual({ value: 'REDACTED', action: 'fixed' });
    expect(rows[1].Birthdate.action).toBe('kept');
    expect(counts).toEqual({ hashed: 2, nulled: 1, fixed: 2 });
  });

  it('is deterministic — the exact contract behind re-seed idempotence', async () => {
    const recs = [{ Email: 'jane@real.com', FirstName: 'Jane' }];
    const a = await eng.sftkPiiMaskRows(recs, 'Contact', RULES, SALT, new Map());
    const b = await eng.sftkPiiMaskRows(recs, 'Contact', RULES, SALT, undefined);
    expect(a).toEqual(b);
  });

  it('consults the per-run cache (keyed salt|Object.Field|value) before hashing', async () => {
    const cache = new Map([
      [`${SALT}|Contact.Email|jane@real.com`, { value: 'SENTINEL', action: 'hashed' }],
    ]);
    const { rows, counts } = await eng.sftkPiiMaskRows(
      [{ Email: 'jane@real.com' }, { Email: 'jane@real.com' }],
      'Contact', { Email: RULES.Email }, SALT, cache);
    // Both rows served from the cache — and each application still counts.
    expect(rows[0].Email.value).toBe('SENTINEL');
    expect(rows[1].Email.value).toBe('SENTINEL');
    expect(counts.hashed).toBe(2);
    expect(cache.size).toBe(1);
  });

  it('caches one entry per distinct (field, value); kept values are never cached', async () => {
    const cache = new Map();
    await eng.sftkPiiMaskRows(
      [{ Email: 'a@x.com' }, { Email: 'a@x.com' }, { Email: 'b@x.com' }, { Email: '' }],
      'Contact', { Email: RULES.Email }, SALT, cache);
    expect(cache.size).toBe(2);
    expect([...cache.keys()].sort()).toEqual([
      `${SALT}|Contact.Email|a@x.com`, `${SALT}|Contact.Email|b@x.com`]);
  });
});

describe('sftkPiiMaskAnchorMap — lookup bridges against a masked target', () => {
  const emailDesc = { type: 'email', length: 80 };

  it('hash on a maskable anchor → masked map, joins preserved', async () => {
    const { map, degraded } = await eng.sftkPiiMaskAnchorMap(
      new Map([['001A', 'jane@real.com'], ['001B', '']]),
      { strategy: 'hash' }, emailDesc, SALT);
    expect(degraded).toBeNull();
    const hex = createHash('sha256').update(`${SALT}|jane@real.com`).digest('hex');
    expect(map.get('001A')).toBe(eng.sftkPiiFormat(hex, emailDesc));
    expect(map.get('001B')).toBe('');   // kept — empty anchors pass through
  });

  it('null / fixed rules degrade — every anchor would collapse to one value', async () => {
    for (const strategy of ['null', 'fixed']) {
      const res = await eng.sftkPiiMaskAnchorMap(
        new Map([['001A', 'x']]), { strategy }, emailDesc, SALT);
      expect(res.map).toBeNull();
      expect(res.degraded).toContain(strategy);
    }
  });

  it('hash on a non-maskable anchor type degrades — masked targets hold null', async () => {
    const res = await eng.sftkPiiMaskAnchorMap(
      new Map([['001A', '1990-04-01']]), { strategy: 'hash' }, { type: 'date' }, SALT);
    expect(res.map).toBeNull();
    expect(res.degraded).toContain('date');
  });
});

describe('SOURCE: executeProfileTransfer wires every write path through the mask', () => {
  const root  = join(dirname(fileURLToPath(import.meta.url)), '..');
  const bgSrc = readFileSync(join(root, 'background.js'), 'utf8');
  const m = /^async function executeProfileTransfer\(/m.exec(bgSrc);
  if (!m) throw new Error('executeProfileTransfer not found in background.js');
  const end = bgSrc.indexOf('\n}', m.index);
  const engine = bgSrc.slice(m.index, end + 2);

  it('a non-empty policy without a salt HARD-ERRORS before the node loop runs', () => {
    const guard = engine.indexOf("throw new Error('PII policy has no salt — open the deployment in the builder once')");
    const loop  = engine.indexOf('for (const { node, parentNode, parentField } of ordered)');
    expect(guard).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(loop);
  });

  it('the payload builder masks by SOURCE name BEFORE the reference branch (rename lands the masked value)', () => {
    const maskAt = engine.indexOf('piiRows.rows[recIdx][f.name]');
    const refAt  = engine.indexOf("if (f.type === 'reference') {");
    expect(maskAt).toBeGreaterThan(-1);
    expect(refAt).toBeGreaterThan(-1);
    expect(maskAt).toBeLessThan(refAt);
    expect(engine).toContain('p[tgtField] = mv.value');
  });

  it('REST, upsert and Bulk all consume the SAME masked payloads array', () => {
    expect(engine).toContain('const payloads = recs.map((r, recIdx) =>');
    expect(engine).toContain('const chunk = payloads.slice(i, i + STEP)');
    expect(engine).toContain('const flat = chunk.map');   // Bulk CSV rows come from chunk
    expect(engine).toContain('records: flat');            // ...and are what sfBulkIngest uploads
    expect(engine).toContain('sfCollectionsCreate(tgtOrgUrl, tgtSid, chunk)');
    expect(engine).toContain('sfCollectionsUpsert(tgtOrgUrl, tgtSid, objType, upsertField, chunk)');
  });

  it('the upsert external-Id injection uses the masked value, never the raw fetch', () => {
    expect(engine).toContain('piiRows.rows[i + k][upsertField]');
  });

  it('the per-object summary discloses the masking counts', () => {
    expect(engine).toContain('masked: piiRows.counts');
  });

  it('T11b failed-record values come from the PUSHED payload, not the raw fetch', () => {
    expect(engine).toContain('const sentPayload = payloads[i + j] || {};');
    expect(engine).toContain('sent: sftkTruncValue(sentPayload[fn], 120)');
  });

  it('required-field diagnostics substitute the masked value for covered fields', () => {
    expect(engine).toContain('diagMasked ? diagMv.value : sampleRec[srcFieldForMissing]');
    expect(engine).toContain('JSON.stringify(samplePayload[missing])');
  });

  it('History labels route through recLabel — a covered name never lands raw in storage', () => {
    expect(engine).toContain('label: recLabel(i + j, result.id)');
    expect(engine).toContain('label: recLabel(i + j, recs[i + j].Id)');
    expect(engine).not.toMatch(/label:\s*\(nameFld && recs\[i \+ j\]\[nameFld\]\)/);
  });

  it('lookup-match bridges mask covered anchors (or skip) instead of querying raw', () => {
    expect(engine).toContain('sftkPiiMaskAnchorMap(srcAnchorMap, piiPolicy[anchorKey], aFieldDesc, piiSalt)');
    expect(engine).toContain('sftkPiiRulesForObject(piiPolicy, objType, descRes.fields)');
    expect(engine).toContain('sftkPiiMaskRows(recs, objType, piiRules, piiSalt, piiCache)');
  });

  it('the child-first connect step writes only idMap TARGET ids — never source values', () => {
    expect(engine).toContain('const resolved = idMap[d.srcVal];');
    expect(engine).toContain('patch[d.tgtField] = resolved');
  });

  it('the banned word never appears anywhere in background.js (honesty rule)', () => {
    expect(bgSrc.toLowerCase()).not.toContain('anonymi');
  });
});
