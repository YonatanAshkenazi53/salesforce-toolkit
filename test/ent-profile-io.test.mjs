// E1 — deployment-profile export/import (team shareability).
//
// Profiles are CONFIG (orgs, tree, mappings, owner rules) plus RUNTIME state
// (scan results, learned record pairs) that is machine-scoped. The export
// payload must carry ONLY config; import must validate honestly (a newer
// schema is refused by name, never half-imported), regenerate the id, keep
// targetOrgs semantics (null = follow-the-ring), and mint fresh provenance.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

const { bldProfileRuntimeFields, bldProfileStrip, bldProfileExportPayload, bldProfileImportParse } =
  extractFunctions('studio-builder.js',
    ['bldProfileRuntimeFields', 'bldProfileStrip', 'bldProfileExportPayload', 'bldProfileImportParse']);

// A realistic kitchen-sink profile: every config field the builder writes
// (incl. per-target fieldMappingOverrides and ownerMapping.matching) AND every
// runtime field the scan/ring/transfer paths accumulate.
function realisticProfile() {
  return {
    id: 'prof_1712000000_abcd',
    name: 'Account + Contacts (CPQ)',
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-07-20T09:30:00.000Z',
    sourceOrg: 'https://golden.my.salesforce.com',
    targetOrg: 'https://uat.my.salesforce.com',
    targetOrgs: null,                                      // follow-the-ring
    scanConfig: { matchField: 'Name', compareFields: ['Industry'] },
    ownerMapping: {
      mode: 'match',
      fallbackUserId: '005000000000001AAA',
      fallbackUserName: 'Integration User',
      matching: { fields: ['Email', 'Name'], normalize: { emailLower: true, caseFold: false, trim: true } }
    },
    // ── runtime state (must be stripped) ──
    lastScan: {
      status: 'success', runAt: '2026-07-19T08:00:00.000Z', objectType: 'Account',
      sourceOrg: 'https://golden.my.salesforce.com', targetOrg: 'https://uat.my.salesforce.com',
      missingInTarget: [{ Id: '001xx0000000009AAA', Name: 'Acme' }], changed: [], identical: [], onlyInTarget: []
    },
    matchMemory: { 'uat.my.salesforce.com': { '001xx0000000009AAA': '001yy0000000003BBB' } },
    ringScans: { 'golden.my.salesforce.com|uat.my.salesforce.com': { runAt: '2026-07-18T00:00:00Z', missing: 3, changed: 1, extra: 0, status: 'success' } },
    schedule: { enabled: true, sourceOrg: 'https://golden.my.salesforce.com', targetOrg: 'https://uat.my.salesforce.com' },
    importedFrom: { fileName: 'older-import.json', exportedBy: '0.9.0', exportedAt: '2026-01-01T00:00:00Z', importedAt: '2026-01-02T00:00:00Z' },
    // ── the tree (config; per-node _meta is runtime) ──
    tree: {
      objectType: 'Account',
      where: "Industry = 'Energy'",
      recordIds: ['001xx0000000001AAA', '001xx0000000002AAA'],
      fieldMappings: { Name: '', Industry: 'Sector__c', Legacy__c: null },
      fieldMappingOverrides: { 'uat.my.salesforce.com': { Industry: 'Industry_UAT__c' } },
      fieldMappingOrgs: { src: 'https://golden.my.salesforce.com', tgt: 'https://uat.my.salesforce.com' },
      matchField: 'Name',
      matchFieldTgt: 'Name',
      matching: { strategy: 'composite', fields: ['Name'], normalize: { trim: true } },
      lookupResolutions: { Primary_Distributor__c: { strategy: 'match', matchObject: 'Account', matchField: 'External_Key__c' } },
      _meta: { count: 42, expanded: true, loading: false, relsLoaded: true, availableRels: [{ relationshipName: 'Contacts' }], fieldsLoaded: true, availableFields: [{ name: 'Name' }] },
      children: [
        {
          childSObject: 'Contact', relationshipName: 'Contacts', field: 'AccountId',
          where: '', insertOrder: 'childFirst',
          fieldMappings: { LastName: '', Email: '' },
          _meta: { count: 7, expanded: false, loading: false, relsLoaded: false, availableRels: [] },
          children: [
            { childSObject: 'CampaignMember', relationshipName: 'CampaignMembers', field: 'ContactId', where: null, children: [], _meta: { count: null, expanded: true } }
          ]
        }
      ]
    }
  };
}

// Every object key in a JSON-serializable value, recursively.
function allKeys(v, out = new Set()) {
  if (Array.isArray(v)) { v.forEach(x => allKeys(x, out)); return out; }
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) { out.add(k); allKeys(val, out); }
  }
  return out;
}

describe('bldProfileExportPayload — envelope + strip list', () => {
  it('wraps the profile in the sftk-profile schema-1 envelope with writer version + timestamp', () => {
    const payload = bldProfileExportPayload(realisticProfile(), '2.4.1');
    expect(payload.format).toBe('sftk-profile');
    expect(payload.schema).toBe(1);
    expect(payload.exportedBy).toBe('2.4.1');
    expect(new Date(payload.exportedAt).toISOString()).toBe(payload.exportedAt);   // real ISO instant
    expect(payload.profile).toBeTruthy();
  });

  it('never claims a version it does not have — missing version exports as "unknown"', () => {
    expect(bldProfileExportPayload(realisticProfile(), undefined).exportedBy).toBe('unknown');
  });

  it('deep-clones: mutating the payload cannot touch the live profile', () => {
    const p = realisticProfile();
    const payload = bldProfileExportPayload(p, '1.0.0');
    payload.profile.name = 'HACKED';
    payload.profile.tree.children[0].fieldMappings.LastName = 'Nope__c';
    expect(p.name).toBe('Account + Contacts (CPQ)');
    expect(p.tree.children[0].fieldMappings.LastName).toBe('');
  });

  it('strips EVERY runtime field (lastScan, matchMemory, ringScans, schedule, ephemeral, importedFrom)', () => {
    const p = { ...realisticProfile(), ephemeral: true };
    const out = bldProfileExportPayload(p, '1.0.0').profile;
    for (const f of bldProfileRuntimeFields()) {
      expect(out[f], `runtime field "${f}" must not export`).toBeUndefined();
    }
    // and the strip list is exactly the documented six — a new runtime field
    // must be added HERE consciously, not leak silently
    expect(bldProfileRuntimeFields().sort()).toEqual(
      ['ephemeral', 'importedFrom', 'lastScan', 'matchMemory', 'ringScans', 'schedule']);
  });

  it('strips per-node _meta at every tree depth', () => {
    const out = bldProfileExportPayload(realisticProfile(), '1.0.0').profile;
    const metas = [];
    (function walk(n) { if (!n) return; if ('_meta' in n) metas.push(n); (n.children || []).forEach(walk); })(out.tree);
    expect(metas).toEqual([]);
  });

  it('keeps ALL config: orgs, tree filters, recordIds, mappings, overrides, owner matching', () => {
    const out = bldProfileExportPayload(realisticProfile(), '1.0.0').profile;
    expect(out.sourceOrg).toBe('https://golden.my.salesforce.com');
    expect(out.targetOrg).toBe('https://uat.my.salesforce.com');
    expect('targetOrgs' in out).toBe(true);
    expect(out.targetOrgs).toBeNull();                                    // follow-the-ring survives
    expect(out.scanConfig).toEqual({ matchField: 'Name', compareFields: ['Industry'] });
    expect(out.ownerMapping.matching).toEqual({ fields: ['Email', 'Name'], normalize: { emailLower: true, caseFold: false, trim: true } });
    expect(out.tree.where).toBe("Industry = 'Energy'");
    expect(out.tree.recordIds).toEqual(['001xx0000000001AAA', '001xx0000000002AAA']);
    expect(out.tree.fieldMappings).toEqual({ Name: '', Industry: 'Sector__c', Legacy__c: null });   // null exclusion kept
    expect(out.tree.fieldMappingOverrides).toEqual({ 'uat.my.salesforce.com': { Industry: 'Industry_UAT__c' } });
    expect(out.tree.lookupResolutions.Primary_Distributor__c.matchField).toBe('External_Key__c');
    expect(out.tree.children[0].insertOrder).toBe('childFirst');
    expect(out.tree.children[0].children[0].childSObject).toBe('CampaignMember');
  });

  it('contains NOTHING secret — no sid/session/token/credential-shaped keys anywhere', () => {
    const payload = bldProfileExportPayload(realisticProfile(), '1.0.0');
    const keys = [...allKeys(payload)];
    const secretish = keys.filter(k => /(^|[^a-z])(sid|session|token|password|secret|credential|cookie|authorization|bearer|apikey|api_key)([^a-z]|$)/i.test(k));
    expect(secretish).toEqual([]);
    // and no Salesforce session-id VALUE shape ("00D…!…") in the serialized file
    expect(JSON.stringify(payload)).not.toMatch(/00D\w{12,15}![A-Za-z0-9._]{20,}/);
  });
});

describe('bldProfileStrip — edge cases', () => {
  it('returns null for non-objects instead of throwing', () => {
    expect(bldProfileStrip(null)).toBeNull();
    expect(bldProfileStrip(undefined)).toBeNull();
    expect(bldProfileStrip('x')).toBeNull();
  });

  it('handles a tree-less profile (builder allows saving before Set Root)', () => {
    const out = bldProfileStrip({ id: 'p1', name: 'No tree yet', tree: null, lastScan: { status: 'success' } });
    expect(out.tree).toBeNull();
    expect(out.lastScan).toBeUndefined();
  });
});

describe('bldProfileImportParse — round trip', () => {
  function roundTrip(profile = realisticProfile(), existing = [], fname = 'sftk-profile-x.json') {
    const text = JSON.stringify(bldProfileExportPayload(profile, '2.4.1'));
    return bldProfileImportParse(text, existing, fname);
  }

  it('export → import yields an equivalent working profile', () => {
    const res = roundTrip();
    expect(res.error).toBeUndefined();
    const p = res.profile;
    expect(p.name).toBe('Account + Contacts (CPQ)');
    expect(p.sourceOrg).toBe('https://golden.my.salesforce.com');
    expect(p.tree.objectType).toBe('Account');
    expect(p.tree.children[0].relationshipName).toBe('Contacts');
    // the enterprise-config crown jewels survive intact
    expect(p.tree.fieldMappingOverrides).toEqual({ 'uat.my.salesforce.com': { Industry: 'Industry_UAT__c' } });
    expect(p.ownerMapping.matching).toEqual({ fields: ['Email', 'Name'], normalize: { emailLower: true, caseFold: false, trim: true } });
  });

  it('targetOrgs: null (follow-the-ring) survives the round trip as null, not [] or absent', () => {
    const res = roundTrip();
    expect('targetOrgs' in res.profile).toBe(true);
    expect(res.profile.targetOrgs).toBeNull();
  });

  it('targetOrgs: pinned array survives as the same array', () => {
    const p = realisticProfile();
    p.targetOrgs = ['https://uat.my.salesforce.com', 'https://qa.my.salesforce.com'];
    const res = roundTrip(p);
    expect(res.profile.targetOrgs).toEqual(['https://uat.my.salesforce.com', 'https://qa.my.salesforce.com']);
  });

  it('regenerates the id — never reuses the file id, never collides with existing ids', () => {
    const original = realisticProfile();
    const res = roundTrip(original, [original.id, 'prof_2', 'prof_3']);
    expect(res.profile.id).toBeTruthy();
    expect(res.profile.id).not.toBe(original.id);
    expect(['prof_2', 'prof_3']).not.toContain(res.profile.id);
  });

  it('mints fresh provenance (importedFrom) with the file name and import instant', () => {
    const res = roundTrip(realisticProfile(), [], 'from-jane.json');
    const prov = res.profile.importedFrom;
    expect(prov.fileName).toBe('from-jane.json');
    expect(prov.exportedBy).toBe('2.4.1');
    expect(new Date(prov.importedAt).toISOString()).toBe(prov.importedAt);
    // the exporter's OWN old importedFrom must not chain through
    expect(prov.importedAt).not.toBe('2026-01-02T00:00:00Z');
  });

  it('no runtime state sneaks in via round trip (export already stripped → nothing to report)', () => {
    const res = roundTrip();
    expect(res.stripped).toEqual([]);
    for (const f of ['lastScan', 'matchMemory', 'ringScans', 'schedule', 'ephemeral']) {
      expect(res.profile[f]).toBeUndefined();
    }
  });

  it('a hand-edited file smuggling runtime state gets it stripped AND reported', () => {
    const payload = bldProfileExportPayload(realisticProfile(), '2.4.1');
    payload.profile.lastScan = { status: 'success', missingInTarget: [] };   // forged "already scanned"
    payload.profile.matchMemory = { k: { a: 'b' } };
    payload.profile.tree._meta = { count: 999 };
    const res = bldProfileImportParse(JSON.stringify(payload), [], 'edited.json');
    expect(res.error).toBeUndefined();
    expect(res.profile.lastScan).toBeUndefined();
    expect(res.profile.matchMemory).toBeUndefined();
    expect(res.profile.tree._meta).toBeUndefined();
    expect(res.stripped.sort()).toEqual(['lastScan', 'matchMemory']);
  });
});

describe('bldProfileImportParse — honest rejections', () => {
  const goodText = () => JSON.stringify(bldProfileExportPayload(realisticProfile(), '2.4.1'));

  it('truncated JSON → specific parse error, no profile', () => {
    const res = bldProfileImportParse(goodText().slice(0, 60), []);
    expect(res.profile).toBeUndefined();
    expect(res.error).toMatch(/JSON/i);
    expect(res.error).toMatch(/truncated/i);
  });

  it('valid JSON but not an object (array / null / string) → rejected', () => {
    for (const text of ['[]', 'null', '"hello"', '42']) {
      const res = bldProfileImportParse(text, []);
      expect(res.profile, `input ${text}`).toBeUndefined();
      expect(res.error).toMatch(/sftk-profile/);
    }
  });

  it('wrong format tag → rejection naming BOTH the found and expected format', () => {
    const res = bldProfileImportParse(JSON.stringify({ format: 'sftk-flow-backup', schema: 1, profile: { name: 'x' } }), []);
    expect(res.error).toContain('sftk-flow-backup');
    expect(res.error).toContain('sftk-profile');
  });

  it('missing format tag → rejected (not treated as schema 1 by luck)', () => {
    const res = bldProfileImportParse(JSON.stringify({ schema: 1, profile: { name: 'x' } }), []);
    expect(res.error).toBeTruthy();
    expect(res.profile).toBeUndefined();
  });

  it('NEWER schema → honest refusal naming the file schema AND the supported schema; nothing imported', () => {
    const res = bldProfileImportParse(JSON.stringify({
      format: 'sftk-profile', schema: 2, exportedBy: '9.9.9', profile: { name: 'Future profile', tree: null }
    }), []);
    expect(res.profile).toBeUndefined();               // never a half-import
    expect(res.error).toContain('schema 2');           // the file's version…
    expect(res.error).toContain('schema 1');           // …and ours, both named
    expect(res.error).toContain('9.9.9');              // writer version surfaced when known
    expect(res.error).toMatch(/nothing was imported/i);
  });

  it('missing / non-integer / sub-1 schema → rejected as corrupted', () => {
    for (const schema of [undefined, '1', 1.5, 0, -3]) {
      const res = bldProfileImportParse(JSON.stringify({ format: 'sftk-profile', schema, profile: { name: 'x' } }), []);
      expect(res.profile, `schema ${schema}`).toBeUndefined();
      expect(res.error).toMatch(/schema/i);
    }
  });

  it('envelope without a profile object → rejected as truncated', () => {
    for (const profile of [undefined, null, [], 'x']) {
      const res = bldProfileImportParse(JSON.stringify({ format: 'sftk-profile', schema: 1, profile }), []);
      expect(res.profile, `profile ${JSON.stringify(profile)}`).toBeUndefined();
      expect(res.error).toMatch(/no profile object|truncated/i);
    }
  });

  it('profile without a usable name → rejected', () => {
    for (const name of [undefined, '', '   ', 7]) {
      const res = bldProfileImportParse(JSON.stringify({ format: 'sftk-profile', schema: 1, profile: { name, tree: null } }), []);
      expect(res.profile, `name ${JSON.stringify(name)}`).toBeUndefined();
      expect(res.error).toMatch(/name/i);
    }
  });

  it('malformed tree (array / scalar) → rejected; null / absent tree accepted (builder allows tree-less profiles)', () => {
    for (const tree of [[], 'Account', 5]) {
      const res = bldProfileImportParse(JSON.stringify({ format: 'sftk-profile', schema: 1, profile: { name: 'x', tree } }), []);
      expect(res.profile, `tree ${JSON.stringify(tree)}`).toBeUndefined();
      expect(res.error).toMatch(/tree/i);
    }
    const ok = bldProfileImportParse(JSON.stringify({ format: 'sftk-profile', schema: 1, profile: { name: 'x', tree: null } }), []);
    expect(ok.error).toBeUndefined();
    expect(ok.profile.tree).toBeNull();
    const okAbsent = bldProfileImportParse(JSON.stringify({ format: 'sftk-profile', schema: 1, profile: { name: 'x' } }), []);
    expect(okAbsent.error).toBeUndefined();
  });
});
