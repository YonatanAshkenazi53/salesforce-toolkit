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
  'executeProfileTransfer', 'buildCopyFields', 'sftkFieldsFromError',
  'sftkTruncValue', 'sftkBuildOwnerIndex', 'sftkMatchKey',
  'sftkPiiHashHex', 'sftkPiiMaskable', 'sftkPiiFormat', 'sftkPiiMaskValue',
  'sftkPiiRulesForObject', 'sftkPiiMaskRows', 'sftkPiiMaskAnchorMap',
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
