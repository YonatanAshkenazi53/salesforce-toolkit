// executeProfileTransfer END-TO-END — the child-first + picked-records path.
//
// USER REPORT (2026-08-04): "transferring child records before and selecting
// child records doesn't work". The builder side reproduces clean (the toggle
// flips state and repaints), so this drives the ENGINE with the exact
// configuration the user described: a parent with picked records and a child
// node carrying BOTH insertOrder:'childFirst' AND its own picked recordIds —
// against a fully canned two-org world, asserting every step the feature
// promises: children fetched scoped to the parent picks, inserted BEFORE the
// parent WITHOUT the parent link, parent inserted, then the connect step
// wiring each child to its parent's NEW target id.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractFunctions } from './extract.mjs';

const eng = extractFunctions('background.js', [
  'executeProfileTransfer', 'buildCopyFields', 'sftkFieldsFromError', 'sftkOrgKey',
  'sftkTruncValue', 'sftkBuildOwnerIndex', 'sftkMatchKey',
  'sftkPiiHashHex', 'sftkPiiMaskable', 'sftkPiiFormat', 'sftkPiiMaskValue',
  'sftkPiiRulesForObject', 'sftkPiiMaskRows', 'sftkPiiMaskAnchorMap',
  'sftkRtaImageCount',   // W7 rich-text image disclosure — engine calls it per node
]);

const SRC = 'https://src.my.salesforce.com', TGT = 'https://tgt.my.salesforce.com';

const f = (name, label, type, extra) => Object.assign({
  name, label, type, createable: true, updateable: true, nillable: true,
  defaultValue: null, referenceTo: [], custom: false, length: 255,
}, extra || {});

const ACCOUNT_DESC = { name: 'Account', fields: [
  f('Id', 'Account ID', 'id', { createable: false, updateable: false }),
  f('Name', 'Account Name', 'string', { nillable: false, nameField: true }),
  f('Industry', 'Industry', 'string'),
] };
const CONTACT_DESC = { name: 'Contact', fields: [
  f('Id', 'Contact ID', 'id', { createable: false, updateable: false }),
  f('FirstName', 'First Name', 'string'),
  f('LastName', 'Last Name', 'string', { nillable: false }),
  f('Email', 'Email', 'email', { length: 80 }),
  f('AccountId', 'Account ID', 'reference', { referenceTo: ['Account'] }),
] };

const SRC_ACCOUNTS = [
  { Id: 'A1', Name: 'Acme',  Industry: 'Tech' },
  { Id: 'A2', Name: 'Bravo', Industry: 'Retail' },
];
const SRC_CONTACTS = [
  { Id: 'C1', FirstName: 'Ann', LastName: 'Lee',  Email: 'ann@x.com', AccountId: 'A1' },
  { Id: 'C2', FirstName: 'Bob', LastName: 'Kim',  Email: 'bob@x.com', AccountId: 'A2' },
];

// One canned world per test: records queries answered by object + WHERE
// shape, all calls logged for order/payload assertions.
let calls;
function installWorld() {
  calls = [];
  globalThis.API_VERSION = 'v62.0';
  globalThis._runCancelled = false;
  globalThis.postRunProgress = () => {};

  const answer = (q) => {
    const obj = /FROM\s+(\w+)/.exec(q)?.[1];
    const rows = obj === 'Account' ? SRC_ACCOUNTS : obj === 'Contact' ? SRC_CONTACTS : [];
    // Honor Id IN (…) and <link> IN (…) filters the engine builds.
    let out = rows;
    const idIn = /Id IN \(([^)]*)\)/.exec(q);
    if (idIn) {
      const ids = new Set([...idIn[1].matchAll(/'([^']+)'/g)].map(m => m[1]));
      out = out.filter(r => ids.has(r.Id));
    }
    const lnkIn = /AccountId IN \(([^)]*)\)/.exec(q);
    if (lnkIn) {
      const ids = new Set([...lnkIn[1].matchAll(/'([^']+)'/g)].map(m => m[1]));
      out = out.filter(r => ids.has(r.AccountId));
    }
    if (/SELECT COUNT\(\)/.test(q)) return { totalSize: out.length, records: [] };
    return { records: out, totalSize: out.length, serverTotal: out.length };
  };

  globalThis.sfQuery    = async (orgUrl, sid, q) => { calls.push(['query', orgUrl, q]); return answer(q); };
  globalThis.sfQueryAll = async (orgUrl, sid, q) => { calls.push(['queryAll', orgUrl, q]); return answer(q); };
  globalThis.sfRestGet  = async (orgUrl, sid, path) => {
    calls.push(['restGet', orgUrl, path]);
    if (/sobjects\/Account\/describe/.test(path)) return ACCOUNT_DESC;
    if (/sobjects\/Contact\/describe/.test(path)) return CONTACT_DESC;
    return { error: 'unexpected path ' + path };
  };
  let seq = 0;
  globalThis.sfCollectionsCreate = async (orgUrl, sid, chunk) => {
    calls.push(['create', chunk.map(r => ({ ...r }))]);
    return chunk.map(r => ({ success: true, id: 'N' + (r.attributes?.type || '?')[0] + (++seq) }));
  };
  globalThis.sfCollectionsUpdate = async (orgUrl, sid, records) => {
    calls.push(['update', records.map(r => ({ ...r }))]);
    return records.map(() => ({ success: true }));
  };
  globalThis.sfCollectionsUpsert = async () => { throw new Error('upsert not expected'); };
  globalThis.sfBulkIngest = async () => { throw new Error('bulk not expected'); };
  globalThis.sfBulkQuery  = async () => { throw new Error('bulk query not expected'); };
}
function removeWorld() {
  for (const k of ['API_VERSION', '_runCancelled', 'postRunProgress', 'sfQuery', 'sfQueryAll',
    'sfRestGet', 'sfCollectionsCreate', 'sfCollectionsUpdate', 'sfCollectionsUpsert',
    'sfBulkIngest', 'sfBulkQuery']) delete globalThis[k];
}
beforeEach(installWorld);
afterEach(removeWorld);

const PROFILE = () => ({
  id: 'p1', name: 'Child-first repro',
  tree: {
    objectType: 'Account',
    recordIds: ['A1', 'A2'],
    children: [{
      relationshipName: 'Contacts', childSObject: 'Contact', field: 'AccountId',
      insertOrder: 'childFirst',
      recordIds: ['C1', 'C2'],
      children: [],
    }],
  },
});

describe('child-first + picked child records, end to end', () => {
  it('runs the full promised sequence: scoped child fetch → child insert first (no link) → parent insert → connect', async () => {
    const result = await eng.executeProfileTransfer(PROFILE(), SRC, 'SID_S', TGT, 'SID_T');

    // 1. The child fetch honors BOTH the picked child ids AND parent scoping.
    const contactFetch = calls.find(([k, , q]) => k === 'queryAll' && /FROM Contact/.test(q) && !/COUNT\(\)/.test(q));
    expect(contactFetch, 'a Contact record fetch happened').toBeTruthy();
    expect(contactFetch[2]).toMatch(/Id IN \('C1','C2'\)/);
    expect(contactFetch[2]).toMatch(/AccountId IN \(/);

    // 2. Children were CREATED before the parent.
    const createOrder = calls.filter(([k]) => k === 'create')
      .map(([, chunk]) => chunk[0]?.attributes?.type);
    expect(createOrder).toEqual(['Contact', 'Account']);

    // 3. The child insert payloads carry the data but NOT the parent link.
    const contactChunk = calls.find(([k, chunk]) => k === 'create' && chunk[0]?.attributes?.type === 'Contact')[1];
    expect(contactChunk).toHaveLength(2);
    for (const rec of contactChunk) {
      expect(rec.LastName, 'child data present').toBeTruthy();
      expect(rec.AccountId, 'parent link deferred at insert').toBeUndefined();
    }

    // 4. The connect step wired each child to its parent's NEW target id.
    const upd = calls.find(([k]) => k === 'update');
    expect(upd, 'connect step ran').toBeTruthy();
    const patched = upd[1];
    expect(patched).toHaveLength(2);
    const accountChunk = calls.find(([k, chunk]) => k === 'create' && chunk[0]?.attributes?.type === 'Account')[1];
    expect(accountChunk).toHaveLength(2);
    for (const p of patched) {
      expect(p.Id).toMatch(/^NC/);
      expect(p.AccountId).toMatch(/^NA/);
    }

    // 5. The summary tells the same story.
    expect(result.summary.Contact.created).toBe(2);
    expect(result.summary.Contact.connected).toBe(2);
    expect(result.summary.Account.created).toBe(2);
    expect(result.status).toBe('success');
  });

  it('a picked child whose parent is OUT of the run scope is named in a diagnostic, never silently dropped', async () => {
    // The user-report shape: picks made in the 🎯 modal (which lists the
    // whole table) can reference children of parents the run does not
    // include — the scoped fetch drops them, and pre-fix the run just said
    // "created 1" with no why.
    const p = PROFILE();
    p.tree.recordIds = ['A1'];                 // parent scope excludes A2
    const result = await eng.executeProfileTransfer(p, SRC, 'SID_S', TGT, 'SID_T');
    expect(result.summary.Contact.created).toBe(1);          // C1 only
    const diag = (result.errors || []).find(e => /hand-picked record\(s\) are NOT in this run/.test(e));
    expect(diag, 'diagnostic names the drop').toBeTruthy();
    expect(diag).toContain('C2');
    expect(diag).toContain('1 of 2');
  });

  it('W1 CHILD-LEVEL UPSERT: a child node with node.upsert routes through sfCollectionsUpsert', async () => {
    let upsertCalls = [];
    globalThis.sfCollectionsUpsert = async (orgUrl, sid, objType, field, chunk) => {
      upsertCalls.push([objType, field, chunk.map(r => ({ ...r }))]);
      let i = 0;
      return chunk.map(() => ({ success: true, id: 'NU' + (++i), created: false }));
    };
    const p = PROFILE();
    delete p.tree.children[0].insertOrder;
    p.tree.children[0].upsert = { field: 'Email' };
    const result = await eng.executeProfileTransfer(p, SRC, 'SID_S', TGT, 'SID_T');

    // Accounts still INSERT; Contacts went through upsert on Email.
    const createOrder = calls.filter(([k]) => k === 'create').map(([, c]) => c[0]?.attributes?.type);
    expect(createOrder).toEqual(['Account']);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0][0]).toBe('Contact');
    expect(upsertCalls[0][1]).toBe('Email');
    // the external-Id value rides in every record
    for (const rec of upsertCalls[0][2]) expect(rec.Email).toMatch(/@x\.com$/);
    expect(result.summary.Contact.viaUpsert).toBe('Email');
    expect(result.summary.Contact.created).toBe(2);
    expect(result.status).toBe('success');
  });

  it('default order (no childFirst): parent first, child scoped to parents that made it, link present at insert', async () => {
    const p = PROFILE();
    delete p.tree.children[0].insertOrder;
    const result = await eng.executeProfileTransfer(p, SRC, 'SID_S', TGT, 'SID_T');

    const createOrder = calls.filter(([k]) => k === 'create')
      .map(([, chunk]) => chunk[0]?.attributes?.type);
    expect(createOrder).toEqual(['Account', 'Contact']);

    const contactChunk = calls.find(([k, chunk]) => k === 'create' && chunk[0]?.attributes?.type === 'Contact')[1];
    for (const rec of contactChunk) {
      expect(rec.AccountId, 'parent link REMAPPED and present at insert').toMatch(/^NA/);
    }
    expect(result.summary.Contact.created).toBe(2);
    expect(result.status).toBe('success');
  });
});

describe('W2 — per-record lookup overrides (engine)', () => {
  it("a hand-picked target id wins over idMap and bridges, and the run discloses it", async () => {
    const p = PROFILE();
    delete p.tree.children[0].insertOrder;   // default order: link written at insert
    p.tree.children[0].lookupOverrides = {
      [TGT]: { C2: { AccountId: 'HANDPICKED1' } },
    };
    const result = await eng.executeProfileTransfer(p, SRC, 'SID_S', TGT, 'SID_T');
    const contactChunk = calls.find(([k, c]) => k === 'create' && c[0]?.attributes?.type === 'Contact')[1];
    const c1 = contactChunk.find(r => r.LastName === 'Lee');
    const c2 = contactChunk.find(r => r.LastName === 'Kim');
    expect(c1.AccountId).toMatch(/^NA/);            // automatic resolution
    expect(c2.AccountId).toBe('HANDPICKED1');       // the user's pick wins
    expect((result.errors || []).some(e => /1 lookup value\(s\) set from per-record hand-picks/.test(e))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// ⛔ PRE-FLIGHT ABORT (user 2026-08-10, after 401 × "Required field
// missing"): a lookup bridge that resolves NOTHING onto a field the
// TARGET requires must stop the run BEFORE any write — one clear error
// naming the fix, zero per-row failures, zero records pushed.
// ══════════════════════════════════════════════════════════════════
describe('⛔ pre-flight abort — dead bridge under a required field', () => {
  it('0/N resolution onto a target-REQUIRED lookup fails the run before any write', async () => {
    const STEP_DESC = { name: 'Step__c', fields: [
      f('Id', 'ID', 'id', { createable: false, updateable: false }),
      f('Name', 'Name', 'string', { nameField: true }),
      f('Blueprint__c', 'Blueprint', 'reference', { referenceTo: ['Blueprint__c'], nillable: false }),
    ] };
    const BP_DESC = { name: 'Blueprint__c', fields: [
      f('Id', 'ID', 'id', { createable: false, updateable: false }),
      f('Name', 'Name', 'string', { nameField: true }),
    ] };
    const SRC_STEPS = [
      { Id: 'S1', Name: 'Step 1', Blueprint__c: 'BP1' },
      { Id: 'S2', Name: 'Step 2', Blueprint__c: 'BP1' },
    ];
    globalThis.sfRestGet = async (orgUrl, sid, path) => {
      if (/sobjects\/Step__c\/describe/.test(path)) return STEP_DESC;
      if (/sobjects\/Blueprint__c\/describe/.test(path)) return BP_DESC;
      return { error: 'unexpected ' + path };
    };
    globalThis.sfQueryAll = async (orgUrl, sid, q) => {
      calls.push(['queryAll', orgUrl, q]);
      if (/FROM Step__c/.test(q)) {
        if (/SELECT COUNT\(\)/.test(q)) return { totalSize: SRC_STEPS.length, records: [] };
        return { records: SRC_STEPS, totalSize: SRC_STEPS.length, serverTotal: SRC_STEPS.length };
      }
      if (/FROM Blueprint__c/.test(q)) {
        // Source resolves anchors fine; the TARGET (queried by anchor VALUE)
        // has no Blueprint records at all — the user's exact situation.
        if (orgUrl === SRC) return { records: [{ Id: 'BP1', Name: 'Master plan' }], totalSize: 1 };
        return { records: [], totalSize: 0 };
      }
      return { records: [], totalSize: 0 };
    };
    globalThis.sfQuery = globalThis.sfQueryAll;

    const profile = { id: 'px', name: 'doomed run', tree: {
      objectType: 'Step__c', recordIds: ['S1', 'S2'],
      lookupResolutions: { Blueprint__c: { strategy: 'match', matchObject: 'Blueprint__c', matchField: 'Name' } },
      children: [],
    } };

    let result = null, threw = null;
    try { result = await eng.executeProfileTransfer(profile, SRC, 'SID_S', TGT, 'SID_T'); }
    catch (e) { threw = e; }
    const msg = threw ? String(threw.message || threw) : JSON.stringify(result);
    expect(msg).toContain('PRE-FLIGHT STOP');
    expect(msg).toContain('deploy Blueprint__c records to the target first');
    expect(calls.filter(c => c[0] === 'create').length, 'nothing may be written').toBe(0);
    expect(calls.filter(c => c[0] === 'update').length, 'nothing may be updated').toBe(0);
  });
});

// W7 pattern audit — classic-encryption fields read back MASKED for most
// users; copying them writes literal 'XXXX-1234' garbage into the target.
describe('buildCopyFields — encrypted fields are never copied', () => {
  it('drops encryptedstring, keeps normal data fields', () => {
    const desc = { name: 'X__c', fields: [
      f('Id', 'ID', 'id', { createable: false }),
      f('Name', 'Name', 'string', { nameField: true }),
      f('SSN__c', 'SSN', 'encryptedstring'),
      f('Notes__c', 'Notes', 'string'),
    ] };
    const out = eng.buildCopyFields(desc);
    expect(out).toContain('Name');
    expect(out).toContain('Notes__c');
    expect(out).not.toContain('SSN__c');
  });
});

// ── Engine controls (user 2026-08-11: "async data deployment option" +
// "control the batch sizes like inspector does") — apiMode pins the write
// path, batchSize dials the Collections chunk. Proven against the same
// canned world: the bulk stubs THROW unless a test replaces them, so a pin
// that leaks to the wrong path fails loudly.
describe('engine controls — apiMode + batchSize', () => {
  it('batchSize=1 splits every Collections write into per-record calls', async () => {
    const p = PROFILE();
    p.batchSize = 1;
    const result = await eng.executeProfileTransfer(p, SRC, 'SID_S', TGT, 'SID_T');
    expect(result.summary.Account.created).toBe(2);
    expect(result.summary.Contact.created).toBe(2);
    const creates = calls.filter(([k]) => k === 'create');
    // 2 Accounts + 2 Contacts, one record per call.
    expect(creates).toHaveLength(4);
    expect(creates.every(([, chunk]) => chunk.length === 1)).toBe(true);
    expect(result.errors.join('\n')).toMatch(/batch size 1 \(engine settings\)/);
  });

  it("apiMode 'sync' pins Collections even above the bulk threshold", async () => {
    const p = PROFILE();
    p.bulkThreshold = 1;      // everything would normally go Bulk…
    p.apiMode = 'sync';       // …but the pin keeps it synchronous
    // The world's sfBulkIngest/sfBulkQuery stubs THROW — reaching them at
    // all would fail this test, which is exactly the point.
    const result = await eng.executeProfileTransfer(p, SRC, 'SID_S', TGT, 'SID_T');
    expect(result.summary.Account.created).toBe(2);
    expect(result.errors.join('\n')).toMatch(/kept on synchronous Collections by engine settings/);
  });

  it("apiMode 'bulk' forces the async job even for tiny sets", async () => {
    const p = PROFILE();
    p.apiMode = 'bulk';
    // Recording bulk stubs: read returns REST-shaped records, write returns
    // Collections-aligned results (the engine consumes both identically).
    const bulkCalls = [];
    globalThis.sfBulkQuery = async (orgUrl, sid, soql) => {
      bulkCalls.push(['bulkQuery', soql]);
      const obj = /FROM\s+(\w+)/.exec(soql)?.[1];
      return { records: obj === 'Account' ? SRC_ACCOUNTS : SRC_CONTACTS };
    };
    let seq = 100;
    globalThis.sfBulkIngest = async (orgUrl, sid, opts) => {
      bulkCalls.push(['bulkIngest', opts.objectType, opts.records.length]);
      return opts.records.map(() => ({ success: true, id: 'B' + (++seq) }));
    };
    const result = await eng.executeProfileTransfer(p, SRC, 'SID_S', TGT, 'SID_T');
    expect(result.summary.Account.created).toBe(2);
    expect(result.summary.Contact.created).toBe(2);
    expect(bulkCalls.some(c => c[0] === 'bulkIngest' && c[1] === 'Account')).toBe(true);
    expect(bulkCalls.some(c => c[0] === 'bulkIngest' && c[1] === 'Contact')).toBe(true);
    // No synchronous Collections inserts happened at all.
    expect(calls.filter(([k]) => k === 'create')).toHaveLength(0);
    expect(result.errors.join('\n')).toMatch(/forced by engine settings/);
  });
});

// ── W7 matrix expansion: failure accounting + cancel ──────────────────
// The two run outcomes no scenario covered: a per-record write failure
// (must land in summary.failed + failedSourceIds and turn the run partial,
// never silently shrink `created`) and a mid-run cancel (records already
// written STAY written, the run says where it stopped).
describe('engine matrix — failure accounting and cancel', () => {
  it('one failed record → partial status, counted, and retryable by id', async () => {
    let call = 0;
    globalThis.sfCollectionsCreate = async (orgUrl, sid, chunk) => {
      calls.push(['create', chunk.map(r => ({ ...r }))]);
      return chunk.map(r => {
        // Fail exactly one Contact (the second record of the child chunk).
        if (r.attributes?.type === 'Contact' && ++call === 2) {
          return { success: false, errors: [{ message: 'REQUIRED_FIELD_MISSING: [LastName]' }] };
        }
        return { success: true, id: 'NX' + (call + Math.random().toString(36).slice(2, 6)) };
      });
    };
    const result = await eng.executeProfileTransfer(PROFILE(), SRC, 'SID_S', TGT, 'SID_T');
    expect(result.status).toBe('partial');
    expect(result.summary.Contact.created).toBe(1);
    expect(result.summary.Contact.failed).toBe(1);
    const failedIds = (result.summary.Contact.failedSourceIds || [])
      .map(f => (typeof f === 'string' ? f : f.id));
    expect(failedIds).toContain('C2');
    expect(result.errors.join('\n')).toMatch(/REQUIRED_FIELD_MISSING/);
  });

  it('cancel between batches: written records stay, the run says where it stopped', async () => {
    const p = PROFILE();
    p.batchSize = 1;   // per-record calls so the cancel lands BETWEEN records
    globalThis.sfCollectionsCreate = async (orgUrl, sid, chunk) => {
      calls.push(['create', chunk.map(r => ({ ...r }))]);
      // Flip the cancel flag after the FIRST successful write.
      globalThis._runCancelled = true;
      let seq2 = 0;
      return chunk.map(() => ({ success: true, id: 'NC_cancel' + (++seq2) }));
    };
    const result = await eng.executeProfileTransfer(p, SRC, 'SID_S', TGT, 'SID_T');
    expect(result.cancelled).toBe(true);
    // Child-first: Contacts write first; exactly one landed before the flag.
    expect(result.summary.Contact.created).toBe(1);
    expect(result.errors.join('\n')).toMatch(/cancelled after 1 of 2/);
  });
});

// ── 431 guard (load test 2026-08-17): a Reconcile "✓ All" run rides EVERY
// selected id in node.recordIds — 1,850 picked children built a ~39KB
// `Id IN (…)` GET query string and Salesforce answered HTTP 431 with zero
// rows written. Picked-id reads must chunk like every other IN list.
describe('big picked record sets never build an oversized IN clause', () => {
  const maxIdsInAnyIn = () => Math.max(0, ...calls
    .filter(c => c[0] === 'query' || c[0] === 'queryAll')
    .map(c => Math.max(0, ...[...String(c[2]).matchAll(/IN \(([^)]*)\)/g)]
      .map(m => (m[1].match(/'/g) || []).length / 2))));

  it('child node with 400 picked ids: fetch chunks at 200, parent scope applies in memory, all 400 insert', async () => {
    const accounts = [1, 2, 3].map(i => ({ Id: `A${i}`, Name: `Acct ${i}`, Industry: 'Tech' }));
    const contacts = Array.from({ length: 400 }, (_, i) => ({
      Id: `C${i}`, FirstName: `F${i}`, LastName: `L${i}`, Email: `u${i}@x.com`,
      AccountId: `A${(i % 3) + 1}` }));
    SRC_ACCOUNTS.length = 0; SRC_ACCOUNTS.push(...accounts);
    SRC_CONTACTS.length = 0; SRC_CONTACTS.push(...contacts);
    const profile = {
      id: 'p431', name: '431 guard',
      tree: {
        objectType: 'Account', recordIds: accounts.map(a => a.Id),
        children: [{ relationshipName: 'Contacts', childSObject: 'Contact', field: 'AccountId',
          recordIds: contacts.map(c => c.Id), children: [] }],
      },
    };
    const res = await eng.executeProfileTransfer(profile, SRC, 'sid1', TGT, 'sid2');
    expect(maxIdsInAnyIn()).toBeLessThanOrEqual(200);
    const createdContacts = calls.filter(c => c[0] === 'create')
      .flatMap(c => c[1]).filter(r => r.attributes?.type === 'Contact').length;
    expect(createdContacts).toBe(400);
    expect(res.summary.Contact.created).toBe(400);
  });

  it('root node with 250 picked ids: chunked reads, all 250 insert', async () => {
    const accounts = Array.from({ length: 250 }, (_, i) => ({ Id: `A${i}`, Name: `Acct ${i}`, Industry: 'Tech' }));
    SRC_ACCOUNTS.length = 0; SRC_ACCOUNTS.push(...accounts);
    SRC_CONTACTS.length = 0;
    const profile = { id: 'p431r', name: '431 root guard',
      tree: { objectType: 'Account', recordIds: accounts.map(a => a.Id), children: [] } };
    const res = await eng.executeProfileTransfer(profile, SRC, 'sid1', TGT, 'sid2');
    expect(maxIdsInAnyIn()).toBeLessThanOrEqual(200);
    expect(res.summary.Account.created).toBe(250);
  });
});

// ── the ℹ marker contract (2026-08-17, user: "the errors are weird"):
// diagnostics merge into result.errors for transport, but every renderer
// and status computation can tell a note from a failure by the marker.
describe('engine notes are marked, never dressed as failures', () => {
  it('the merge prefixes diagnostics with ℹ', async () => {
    const { readFileSync } = await import('node:fs');
    const BG = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
    expect(BG).toContain('const finalErrors = [...diagnostics.map(d => `ℹ ${d}`), ...dedupedErrors];');
  });

  it('sftkFriendlyError classifies ℹ lines as notes, with or without a phase prefix', () => {
    const { sftkFriendlyError } = extractFunctions('sftk-friendly-error.js', ['sftkFriendlyError']);
    expect(sftkFriendlyError('ℹ Load_Parent__c: Bulk API 2.0 forced by engine settings — one async job for 50 record(s).').kind).toBe('note');
    expect(sftkFriendlyError('push: ℹ Load_Parent__c: Bulk API read forced by engine settings (50 record(s), one query job).').kind).toBe('note');
    expect(sftkFriendlyError('push: Load_Child__c: HTTP 431: Request Header Fields Too Large').kind).toBe('error');
  });

  it('a Reconcile run cannot report success over a hard error', async () => {
    const { readFileSync } = await import('node:fs');
    const REC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
    // A child pass that dies wholesale contributes zero per-record fails —
    // the ℹ filter is what keeps the card honest.
    expect(REC).toMatch(/const hardErrs = allErrors\.filter\(e => !\/\(\^\|: \)ℹ \/\.test\(String\(e\)\)\)\.length;/);
    expect(REC).toMatch(/const status\s+= \(totalFail === 0 && hardErrs === 0\) \? 'success'/);
  });
});
