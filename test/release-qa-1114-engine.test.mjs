// Release QA 2026-11-14 — the Data Studio engine (background.js):
//  1. the duplicate-rule bypass ends with the run (never reaches later writes)
//  2. a write call that throws keeps what earlier batches wrote; its own
//     records are UNCONFIRMED, never "created 0" and never retried blind
//  3. the 📎 files pass never pairs a record refused for a non-duplicate
//     reason (or never sent) with a same-Name target record
//  4. a finished Bulk job whose success file cannot be read says UNCONFIRMED
//  5. a failed read of the target's existing files copies nothing for them
//  6. one run at a time: a second run is refused, a bystander page cannot
//     take the run's port over
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const BG = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const sliceFn = (name) => {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(BG);
  if (!m) throw new Error('not found ' + name);
  return BG.slice(m.index, BG.indexOf('\n}', m.index) + 2);
};

// ── 1 + 6 · run lifecycle ────────────────────────────────────────────────
describe('run lifecycle: the duplicate-rule bypass is run-scoped, one run at a time', () => {
  const busy = /const SFTK_RUN_BUSY = ('[^']+');/.exec(BG);
  const make = () => new Function(`
    let _runActive = false, _runCancelled = false, _runStopWhy = '', _runStopLineLast = '', _runHeartbeat = null, _runPort = null;
    const SFTK_RUN_BUSY = ${busy[1]};
    const chrome = { storage: { local: { set: () => Promise.resolve(), remove: () => Promise.resolve() } } };
    function postRunProgress() {}
    ${sliceFn('_beginRun')}
    ${sliceFn('_endRun')}
    ${sliceFn('_runDupHeaders')}
    return { _beginRun, _endRun, _runDupHeaders };
  `)();
  afterEach(() => { delete globalThis.__sftkRunDupBypass; delete globalThis.__sftkRunDupBypassObjs; });

  it('after a Bypass deployment ends, a plain Collections write to any org sends no duplicate-rule header', () => {
    const R = make();
    expect(R._beginRun('transfer')).toBe(true);
    // what executeProfileTransfer sets for duplicateRules: 'bypass'
    globalThis.__sftkRunDupBypass = true; globalThis.__sftkRunDupBypassObjs = null;
    expect(R._runDupHeaders('Contact')).toEqual({ 'Sforce-Duplicate-Rule-Header': 'allowSave=true' });
    R._endRun();
    expect(R._runDupHeaders('Contact')).toEqual({});
    expect(globalThis.__sftkRunDupBypass).toBe(false);
    expect(globalThis.__sftkRunDupBypassObjs).toBe(null);
  });

  it('a new run never inherits a bypass left on the worker', () => {
    const R = make();
    globalThis.__sftkRunDupBypass = true;
    expect(R._beginRun('wipe')).toBe(true);
    expect(R._runDupHeaders('Account')).toEqual({});
    R._endRun();
  });

  it('a second run while one is active is refused and changes nothing; after the end a run starts again', () => {
    const R = make();
    expect(R._beginRun('transfer')).toBe(true);
    globalThis.__sftkRunDupBypass = false;
    expect(R._beginRun('transfer')).toBe(false);
    R._endRun();
    expect(R._beginRun('sequence')).toBe(true);
    R._endRun();
  });

  it('every engine entry point refuses with the busy line, and a bystander port is ignored', () => {
    expect(BG).toContain("if (!_beginRun('transfer')) return { error: SFTK_RUN_BUSY");
    expect(BG).toContain("if (!_beginRun('sequence')) return { error: SFTK_RUN_BUSY");
    expect(BG).toContain("if (!_beginRun('wipe')) return { error: SFTK_RUN_BUSY");
    expect(BG).toMatch(/port\.name !== 'sftk-run-progress'\) return;[\s\S]{0,400}if \(_runActive && _runPort\) return;\s*_runPort = port;/);
    // only the two run-lifecycle functions and the engine entry assign the flag
    const assigns = BG.match(/globalThis\.__sftkRunDupBypass = /g) || [];
    expect(assigns.length).toBe(3);
  });
});

// ── 2 + 3 · the engine write loop and the files pass ─────────────────────
const eng = extractFunctions('background.js', [
  'executeProfileTransfer', 'sftkUnconfirmedRows', 'sftkIsUnconfirmed', 'sftkFailureMeansInTarget', 'sftkFileKeyPairs',
  '_runDupBypassFor', 'sftkRunStopLine', '_runStopReason', '_runNoteStop', 'sftkVanillaPayloadRules', 'sftkEffectiveLookupResolutions', 'sftkLookupDefaultStrategy', 'buildCopyFields', 'sftkFieldsFromError', 'sftkOrgKey',
  'sftkTruncValue', 'sftkBuildOwnerIndex', 'sftkMatchKey', 'sftkPathValue',
  'sftkPiiHashHex', 'sftkPiiMaskable', 'sftkPiiFormat', 'sftkPiiMaskValue',
  'sftkPiiRulesForObject', 'sftkPiiMaskRows', 'sftkPiiMaskAnchorMap', 'sftkRtaImageCount',
]);
const SRC = 'https://src.my.salesforce.com', TGT = 'https://tgt.my.salesforce.com';
const f = (name, label, type, extra) => Object.assign({
  name, label, type, createable: true, updateable: true, nillable: true,
  defaultValue: null, referenceTo: [], custom: false, length: 255,
}, extra || {});
const ACCOUNT_DESC = { name: 'Account', fields: [
  f('Id', 'Account ID', 'id', { createable: false, updateable: false }),
  f('Name', 'Account Name', 'string', { nillable: false, nameField: true }),
] };
const SRC_ACCOUNTS = [{ Id: 'A1', Name: 'Acme' }, { Id: 'A2', Name: 'John Smith' }, { Id: 'A3', Name: 'Carol' }];
let TGT_ACCOUNTS = [];
let creates, filesIdMap;
const KEYS = ['API_VERSION', '_runCancelled', 'postRunProgress', 'sfQuery', 'sfQueryAll', 'sfRestGet',
  'sfCollectionsCreate', 'sfCollectionsUpdate', 'sfCollectionsUpsert', 'sfBulkIngest', 'sfBulkQuery', 'sftkTransferFilesForNode'];
beforeEach(() => {
  creates = []; filesIdMap = null; TGT_ACCOUNTS = [];
  globalThis.API_VERSION = 'v62.0';
  globalThis._runCancelled = false;
  globalThis.postRunProgress = () => {};
  const answer = (orgUrl, q) => {
    let out = orgUrl === TGT ? TGT_ACCOUNTS : (/FROM Account/.test(q) ? SRC_ACCOUNTS : []);
    const idIn = /Id IN \(([^)]*)\)/.exec(q);
    if (idIn) { const ids = new Set([...idIn[1].matchAll(/'([^']+)'/g)].map(m => m[1])); out = out.filter(r => ids.has(r.Id)); }
    if (/SELECT COUNT\(\)/.test(q)) return { totalSize: out.length, records: [] };
    return { records: out, totalSize: out.length, serverTotal: out.length };
  };
  globalThis.sfQuery = async (o, s, q) => answer(o, q);
  globalThis.sfQueryAll = async (o, s, q) => answer(o, q);
  globalThis.sfRestGet = async (o, s, path) => (/Account\/describe/.test(path) ? ACCOUNT_DESC : { error: 'unexpected ' + path });
  globalThis.sfCollectionsUpdate = async (o, s, recs) => recs.map(() => ({ success: true }));
  globalThis.sfCollectionsUpsert = async () => { throw new Error('upsert not expected'); };
  globalThis.sfBulkIngest = async () => { throw new Error('bulk not expected'); };
  globalThis.sfBulkQuery = async () => { throw new Error('bulk query not expected'); };
  globalThis.sftkTransferFilesForNode = async (objType, so, ss, to, ts, idMap) => { filesIdMap = { ...idMap }; return { copied: 0 }; };
});
afterEach(() => { for (const k of KEYS) delete globalThis[k]; });
const PROFILE = (extra) => ({ id: 'p1', name: 'QA', batchSize: 1,
  tree: { objectType: 'Account', recordIds: ['A1', 'A2', 'A3'], children: [] }, ...(extra || {}) });

describe('a write call that throws mid-object', () => {
  it('keeps the earlier batch, marks its own records UNCONFIRMED (not retryable) and stops sending', async () => {
    globalThis.sfCollectionsCreate = async (o, s, chunk) => {
      creates.push(chunk.map(r => r.Name));
      if (chunk[0].Name === 'John Smith') throw new Error('HTTP 503 Service Unavailable');
      return chunk.map((r, k) => ({ success: true, id: 'T' + creates.length + k }));
    };
    const res = await eng.executeProfileTransfer(PROFILE(), SRC, 'S', TGT, 'T');
    const s = res.summary.Account;
    expect(s.error).toBeUndefined();          // the summary is not replaced
    expect(s.created).toBe(1);                // A1 was written and is still counted
    expect(s.unconfirmed).toBe(1);
    expect(s.unconfirmedSourceIds.map(x => x.id)).toEqual(['A2']);
    expect((s.failedSourceIds || []).map(x => x.id)).not.toContain('A2');   // never offered to ↻ Retry failed
    expect(creates).toEqual([['Acme'], ['John Smith']]);                    // A3 not sent after the throw
    expect(res.status).toBe('partial');
    expect(res.errors.join('\n')).toMatch(/1 record\(s\) NOT CONFIRMED written — a write call failed \(HTTP 503/);
    expect(res.errors.join('\n')).toMatch(/1 later record\(s\) were not sent/);
  });

  it('with Threads 2, the sibling chunk that landed in the same wave still reaches the summary', async () => {
    globalThis.sfCollectionsCreate = async (o, s, chunk) => {
      creates.push(chunk.map(r => r.Name));
      if (chunk[0].Name === 'John Smith') throw new Error('The operation was aborted due to timeout');
      return chunk.map(() => ({ success: true, id: 'T-' + chunk[0].Name }));
    };
    const res = await eng.executeProfileTransfer(PROFILE({ threads: 2 }), SRC, 'S', TGT, 'T');
    const s = res.summary.Account;
    expect(s.created).toBe(1);
    expect(s.unconfirmed).toBe(1);
    expect((s.targetRecords || []).map(r => r.id)).toEqual(['T-Acme']);
  });

  it('a response shorter than its chunk leaves the unanswered records unconfirmed, never silently lost', async () => {
    globalThis.sfCollectionsCreate = async (o, s, chunk) => (chunk[0].Name === 'Carol' ? [] : chunk.map(() => ({ success: true, id: 'T' })));
    const res = await eng.executeProfileTransfer(PROFILE(), SRC, 'S', TGT, 'T');
    expect(res.summary.Account.created).toBe(2);
    expect(res.summary.Account.unconfirmed).toBe(1);
    expect(res.status).toBe('partial');
  });
});

describe('📎 files pass pairs only records nothing disproves', () => {
  it('a validation-rule refusal is never paired with a same-Name target record; a duplicate refusal is', async () => {
    TGT_ACCOUNTS = [{ Id: 'T-JS', Name: 'John Smith' }, { Id: 'T-CA', Name: 'Carol' }];
    globalThis.sfCollectionsCreate = async (o, s, chunk) => chunk.map(r =>
      r.Name === 'John Smith' ? { success: false, errors: [{ statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Phone is required' }] }
        : r.Name === 'Carol' ? { success: false, errors: [{ statusCode: 'DUPLICATE_VALUE', message: 'duplicate value found' }] }
          : { success: true, id: 'T-AC' });
    const p = PROFILE(); p.tree.includeFiles = true;
    const res = await eng.executeProfileTransfer(p, SRC, 'S', TGT, 'T');
    expect(filesIdMap).toEqual({ A1: 'T-AC', A3: 'T-CA' });
    expect(filesIdMap.A2).toBeUndefined();
    expect(res.errors.join('\n')).toMatch(/1 record\(s\) not written by this run were left out of the files pass/);
  });

  it('records never sent (the run was cancelled) are not paired either', async () => {
    TGT_ACCOUNTS = [{ Id: 'T-JS', Name: 'John Smith' }, { Id: 'T-CA', Name: 'Carol' }];
    globalThis.sfCollectionsCreate = async (o, s, chunk) => { globalThis._runCancelled = true; return chunk.map(() => ({ success: true, id: 'T-AC' })); };
    const p = PROFILE(); p.tree.includeFiles = true;
    await eng.executeProfileTransfer(p, SRC, 'S', TGT, 'T');
    expect(filesIdMap).toEqual({ A1: 'T-AC' });
  });

  it('sftkFailureMeansInTarget reads codes and Bulk error text', () => {
    const { sftkFailureMeansInTarget } = extractFunctions('background.js', ['sftkFailureMeansInTarget']);
    expect(sftkFailureMeansInTarget({ errors: [{ statusCode: 'DUPLICATES_DETECTED' }] })).toBe(true);
    expect(sftkFailureMeansInTarget({ errors: [{ statusCode: 'BULK_ROW_ERROR', message: 'DUPLICATE_VALUE:duplicate value found: Ext__c' }] })).toBe(true);
    expect(sftkFailureMeansInTarget({ errors: [{ statusCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing' }] })).toBe(false);
    expect(sftkFailureMeansInTarget(null)).toBe(false);
  });
});

// ── 4 · Bulk results after JobComplete ───────────────────────────────────
describe('a finished Bulk job whose result files cannot be read', () => {
  const B = extractFunctions('background.js', ['sftkBulkCompletedResults', 'sftkCorrelateBulkResults', 'sftkBulkKeyNorm', 'sftkIsUnconfirmed']);
  const rows = [{ Name: 'A' }, { Name: 'B' }];
  it('success file unread → every unplaced row is UNCONFIRMED, never failed', () => {
    const out = B.sftkBulkCompletedResults(rows, ['Name'], null, []);
    expect(out.every(r => r.success === false && B.sftkIsUnconfirmed(r))).toBe(true);
    expect(out[0].errors[0].message).toMatch(/cannot say whether this record was written/);
  });
  it('success file unread but a row is in the failure file → that row is a real failure', () => {
    const out = B.sftkBulkCompletedResults(rows, ['Name'], null, [{ Name: 'B', sf__Error: 'REQUIRED_FIELD_MISSING' }]);
    expect(B.sftkIsUnconfirmed(out[0])).toBe(true);
    expect(B.sftkIsUnconfirmed(out[1])).toBe(false);
    expect(out[1].errors[0].message).toBe('REQUIRED_FIELD_MISSING');
  });
  it('failure file unread → rows in the success file are written, the rest failed with an unknown reason', () => {
    const out = B.sftkBulkCompletedResults(rows, ['Name'], [{ Name: 'A', sf__Id: '001A' }], null);
    expect(out[0]).toMatchObject({ success: true, id: '001A' });
    expect(out[1].success).toBe(false);
    expect(B.sftkIsUnconfirmed(out[1])).toBe(false);
  });
  it('sfBulkIngest reads each result file twice at most and hands null on failure', () => {
    const fn = sliceFn('sfBulkIngest');
    expect(fn).toMatch(/for \(let attempt = 0; attempt < 2; attempt\+\+\)/);
    expect(fn).toContain('return sftkBulkCompletedResults(rows, columns, okRows, badRows);');
    expect(fn).not.toMatch(/okRes\.ok \? sftkParseCsv/);
  });
});

// ── 5 · files pass: the target's existing files ──────────────────────────
describe('📎 a failed read of the target files copies nothing for those records', () => {
  const F = extractFunctions('background.js', ['sftkTransferFilesForNode', 'sftkFilePlan', 'sftkB64FromBuffer']);
  let posts;
  const setup = (tgtFail) => {
    posts = [];
    globalThis.API_VERSION = 'v62.0';
    globalThis.sfErrorMsg = (st) => 'HTTP ' + st;
    globalThis.sftkFetchBinary = async () => new Uint8Array([1, 2, 3]).buffer;
    globalThis.sfFetchWithProxy = async (o, s, url, opts) => { posts.push(url); return { ok: true, status: 201, body: '{"id":"068N"}' }; };
    globalThis.sfQueryAll = async (o, s, q) => {
      if (o === SRC && /FROM ContentDocumentLink/.test(q)) return { records: [{ ContentDocumentId: '069S', LinkedEntityId: 'S1' }] };
      if (o === SRC && /FROM ContentVersion/.test(q)) return { records: [{ Id: '068S', ContentDocumentId: '069S', Title: 'passport.pdf', Checksum: 'abc', ContentSize: 10, VersionData: '/v' }] };
      if (o === TGT && /FROM ContentDocumentLink/.test(q)) {
        if (tgtFail === 'throw') throw new Error('SESSION_EXPIRED');
        if (tgtFail === 'short') return { records: [], incomplete: { expected: 1, got: 0 } };
        return { records: [{ ContentDocumentId: '069T', LinkedEntityId: 'T1' }] };
      }
      if (o === TGT && /FROM ContentVersion/.test(q)) {
        if (tgtFail === 'sums') throw new Error('HTTP 500');
        return { records: [{ ContentDocumentId: '069T', Checksum: 'abc' }] };
      }
      return { records: [] };
    };
  };
  afterEach(() => { for (const k of ['API_VERSION', 'sfErrorMsg', 'sftkFetchBinary', 'sfFetchWithProxy', 'sfQueryAll']) delete globalThis[k]; });

  for (const mode of ['throw', 'short', 'sums']) {
    it(`target read ${mode} → no ContentVersion POST, and the run says why`, async () => {
      setup(mode);
      const errors = [], diags = [];
      const stats = await F.sftkTransferFilesForNode('Account', SRC, 'S', TGT, 'T', { S1: 'T1' }, false, errors, diags);
      expect(posts).toEqual([]);
      expect(stats.copied).toBe(0);
      expect(stats.skippedUnread).toBe(1);
      expect(errors.join('\n')).toMatch(/files NOT copied for 1 record\(s\) — the target's existing files on them could not be read/);
    });
  }

  it('a readable target that already has the file copies nothing and says nothing failed', async () => {
    setup(null);
    const errors = [];
    const stats = await F.sftkTransferFilesForNode('Account', SRC, 'S', TGT, 'T', { S1: 'T1' }, false, errors, []);
    expect(posts).toEqual([]);
    expect(stats.skippedExisting).toBe(1);
    expect(errors).toEqual([]);
  });
});
