// 2026-09-22 — live run 5 (12 objects, trailheads2 → trailheads4):
//  • every inserted Opportunity lost its Pricebook: an UNCONFIGURED lookup at an
//    object outside the deployment was dropped on insert (← update matched it
//    by Name, and the parents card promised name matching)
//  • a child Case and its parent Case, inserted by two STEPS of one Deploy run,
//    were never linked: each step's late-link pass knew only its own ids
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const eng = extractFunctions('background.js', [
  'executeProfileTransfer', 'buildCopyFields', 'sftkFieldsFromError', 'sftkOrgKey',
  'sftkTruncValue', 'sftkBuildOwnerIndex', 'sftkMatchKey', 'sftkPathValue',
  'sftkPiiHashHex', 'sftkPiiMaskable', 'sftkPiiFormat', 'sftkPiiMaskValue',
  'sftkPiiRulesForObject', 'sftkPiiMaskRows', 'sftkPiiMaskAnchorMap', 'sftkRtaImageCount',
  'sftkEffectiveLookupResolutions', 'sftkLookupDefaultStrategy', '_runLedger', '_runLedgerClose', '_runLedgerStore',
]);
const BG = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const BL = readFileSync(new URL('../studio-builder.js', import.meta.url), 'utf8');
const SRC = 'https://src.my.salesforce.com', TGT = 'https://tgt.my.salesforce.com';
const f = (name, type, x) => ({ name, label: name, type, createable: true, updateable: true, nillable: true, referenceTo: [], custom: false, length: 255, ...x });

describe('unconfigured lookups match by Name — the rule ← update always had', () => {
  const fields = [f('Id', 'id'), f('Name', 'string', { nameField: true }),
    f('Pricebook2Id', 'reference', { referenceTo: ['Pricebook2'], relationshipName: 'Pricebook2' }),
    f('AccountId', 'reference', { referenceTo: ['Account'], relationshipName: 'Account' }),
    f('ContractId', 'reference', { referenceTo: ['Contract'], relationshipName: 'Contract' }),
    f('OwnerId', 'reference', { referenceTo: ['User', 'Group'], relationshipName: 'Owner' }),
    f('WhatId', 'reference', { referenceTo: ['Account', 'Opportunity'], relationshipName: 'What', polymorphicForeignKey: true }),
    f('LastAmountChangedHistoryId', 'reference', { referenceTo: ['OpportunityHistory'], relationshipName: 'LastAmountChangedHistory', createable: false })];
  it('defaults to match-by-Name only where it can: outside the tree, one non-system object, that has a Name', () => {
    const eff = eng.sftkEffectiveLookupResolutions({ AccountId: { strategy: 'skip' } }, fields, new Set(['Opportunity']));
    expect(eff.Pricebook2Id).toMatchObject({ strategy: 'match', matchField: 'Name', matchObject: 'Pricebook2', defaulted: true });
    expect(eff.AccountId).toEqual({ strategy: 'skip' });          // the user's choice stands
    expect(eff.ContractId).toBeUndefined();                       // Contract has no Name to match by
    expect(eff.OwnerId).toBeUndefined();                          // system
    expect(eff.WhatId).toBeUndefined();                           // polymorphic
    expect(eff.LastAmountChangedHistoryId).toBeUndefined();       // not createable — never written on insert (live run 2026-09-22)
    expect(eng.sftkEffectiveLookupResolutions(null, fields, new Set(['Opportunity', 'Pricebook2'])).Pricebook2Id).toBeUndefined();   // in-tree: late links
  });
  it('the builder shows the same default, and the worker and page lists agree', () => {
    expect(BL).toContain("{ strategy: (typeof sftkLookupDefaultStrategy === 'function' ? sftkLookupDefaultStrategy(refObj) : 'skip'), matchField: 'Name', defaulted: true }");
    expect(BL).toContain('default — matched by Name in the target; choose 🚫 Set null if this field must not be touched');
    const M = readFileSync(new URL('../sftk-matching.js', import.meta.url), 'utf8');
    const list = s => ((s.match(/'Case', 'Order', 'Contract'[^\]]*\]/) || [''])[0]).replace(/\s+/g, ' ');
    expect(list(M)).toBe(list(BG));
    expect(eng.sftkLookupDefaultStrategy('Pricebook2')).toBe('match');
    expect(eng.sftkLookupDefaultStrategy('Case')).toBe('skip');
  });
});

describe('a bridge that cannot be read is a note, never a dead object', () => {
  const DESC = { name: 'Opportunity', fields: [f('Id', 'id', { createable: false, updateable: false }), f('Name', 'string', { nameField: true }),
    f('Pricebook2Id', 'reference', { referenceTo: ['Pricebook2'], relationshipName: 'Pricebook2' }),
    f('Weird__c', 'reference', { referenceTo: ['Weird__c'], relationshipName: 'Weird__r' })] };
  const SRC_OPPS = [{ Id: 'O1', Name: 'Deal', Pricebook2Id: 'PB1', Weird__c: 'W1' }];
  afterEach(() => { for (const k of ['API_VERSION', '_runCancelled', 'postRunProgress', 'sfQuery', 'sfQueryAll', 'sfRestGet', 'sfCollectionsCreate', 'sfCollectionsUpdate', 'sfCollectionsUpsert', 'sfBulkIngest', 'sfBulkQuery']) delete globalThis[k]; });
  it('the source anchor query throws for one defaulted lookup: that lookup is dropped with a note, the record still inserts, the other lookup still matches', async () => {
    globalThis.API_VERSION = 'v62.0'; globalThis._runCancelled = false; globalThis.postRunProgress = () => {};
    const calls = [];
    globalThis.sfQueryAll = async (o, s, q) => {
      calls.push(q);
      if (/FROM Weird__c/.test(q)) throw new Error("HTTP 400: No such column 'Name' on entity 'Weird__c'");
      if (/FROM Pricebook2 WHERE Id IN/.test(q)) return { records: [{ Id: 'PB1', Name: 'Standard Price Book' }] };
      if (/FROM Pricebook2 WHERE Name IN/.test(q)) return { records: [{ Id: 'TPB', Name: 'Standard Price Book' }] };
      if (/FROM Opportunity/.test(q)) return { records: SRC_OPPS, totalSize: 1 };
      return { records: [] };
    };
    globalThis.sfQuery = globalThis.sfQueryAll;
    globalThis.sfRestGet = async (o, s, p) => (/Opportunity\/describe/.test(p) ? DESC : { error: 'unexpected ' + p });
    globalThis.sfCollectionsCreate = async (o, s, chunk) => { calls.push(['create', chunk]); return chunk.map(() => ({ success: true, id: 'NO1' })); };
    globalThis.sfCollectionsUpdate = async () => []; globalThis.sfCollectionsUpsert = async () => { throw new Error('no'); }; globalThis.sfBulkIngest = async () => { throw new Error('no'); }; globalThis.sfBulkQuery = async () => { throw new Error('no'); };
    const r = await eng.executeProfileTransfer({ id: 'p', name: 'p', tree: { objectType: 'Opportunity', recordIds: ['O1'], children: [] } }, SRC, 'S', TGT, 'T');
    const created = calls.find(c => Array.isArray(c) && c[0] === 'create')[1][0];
    expect(created.Pricebook2Id).toBe('TPB');                 // the good default still matched by Name
    expect('Weird__c' in created).toBe(false);                 // the broken one was left out
    expect(r.summary.Opportunity.created).toBe(1);
    expect(r.errors.some(e => /ℹ Opportunity.Weird__c: could not read Weird__c.Name in the source: HTTP 400/.test(e))).toBe(true);
    expect(r.errors.some(e => /^Opportunity: HTTP 400/.test(e))).toBe(false);
  });
});

describe('the run ledger links across the steps of one Deploy run', () => {
  const CASE_DESC = { name: 'Case', fields: [f('Id', 'id', { createable: false, updateable: false }), f('Subject', 'string'),
    f('ParentId', 'reference', { referenceTo: ['Case'], relationshipName: 'Parent' })] };
  const SRC_CASES = [{ Id: 'C1', Subject: 'parent', ParentId: null }, { Id: 'C2', Subject: 'child', ParentId: 'C1' }];
  let calls;
  function world() {
    calls = [];
    globalThis.API_VERSION = 'v62.0'; globalThis._runCancelled = false; globalThis.postRunProgress = () => {};
    const answer = (o, q) => { let out = o === SRC ? SRC_CASES : []; const m = /Id IN \(([^)]*)\)/.exec(q); if (m) { const ids = new Set([...m[1].matchAll(/'([^']+)'/g)].map(x => x[1])); out = out.filter(r => ids.has(r.Id)); } return /COUNT\(\)/.test(q) ? { totalSize: out.length, records: [] } : { records: out, totalSize: out.length }; };
    globalThis.sfQuery = async (o, s, q) => answer(o, q); globalThis.sfQueryAll = async (o, s, q) => answer(o, q);
    globalThis.sfRestGet = async (o, s, p) => (/Case\/describe/.test(p) ? CASE_DESC : { error: 'unexpected ' + p });
    let seq = 0;
    globalThis.sfCollectionsCreate = async (o, s, chunk) => { calls.push(['create', chunk.map(r => ({ ...r }))]); return chunk.map(() => ({ success: true, id: 'N' + (++seq) })); };
    globalThis.sfCollectionsUpdate = async (o, s, recs) => { calls.push(['update', recs.map(r => ({ ...r }))]); return recs.map(() => ({ success: true })); };
    globalThis.sfCollectionsUpsert = async () => { throw new Error('no'); }; globalThis.sfBulkIngest = async () => { throw new Error('no'); }; globalThis.sfBulkQuery = async () => { throw new Error('no'); };
  }
  afterEach(() => { for (const k of ['API_VERSION', '_runCancelled', 'postRunProgress', 'sfQuery', 'sfQueryAll', 'sfRestGet', 'sfCollectionsCreate', 'sfCollectionsUpdate', 'sfCollectionsUpsert', 'sfBulkIngest', 'sfBulkQuery']) delete globalThis[k]; });
  it('step 1 inserts the child (parent unknown), step 2 inserts the parent — step 2 links the child; the close has nothing left', async () => {
    world();
    const ledger = eng._runLedger('run-x');
    const step1 = { id: 's1', name: 's1', tree: { objectType: 'Case', recordIds: ['C2'], children: [] } };
    const r1 = await eng.executeProfileTransfer(step1, SRC, 'S', TGT, 'T', ledger.idMap, ledger);
    expect(calls.filter(c => c[0] === 'update').length).toBe(0);
    expect(ledger.lateRefs.length).toBe(1);                         // waits in the ledger, not reported yet
    expect(r1.errors.some(e => /left empty/.test(e))).toBe(false);
    const step2 = { id: 's2', name: 's2', tree: { objectType: 'Case', recordIds: ['C1'], children: [] } };
    const r2 = await eng.executeProfileTransfer(step2, SRC, 'S', TGT, 'T', ledger.idMap, ledger);
    const upd = calls.filter(c => c[0] === 'update').flatMap(c => c[1]);
    expect(upd).toEqual([{ attributes: { type: 'Case' }, Id: 'N1', ParentId: 'N2' }]);
    expect(r2.errors.some(e => /ℹ Case: 🔗 1 record\(s\) connected after insert \(ParentId ×1\)/.test(e))).toBe(true);
    expect(eng._runLedgerClose('run-x')).toEqual({ unresolved: [], idMapSize: 2 });
  });
  it('what no step creates is reported once, at the close', async () => {
    world();
    const ledger = eng._runLedger('run-y');
    await eng.executeProfileTransfer({ id: 's1', name: 's1', tree: { objectType: 'Case', recordIds: ['C2'], children: [] } }, SRC, 'S', TGT, 'T', ledger.idMap, ledger);
    expect(eng._runLedgerClose('run-y')).toEqual({ unresolved: [{ objType: 'Case', field: 'ParentId', refObj: 'Case', n: 1 }], idMapSize: 1 });
    expect(eng._runLedgerClose('run-y')).toEqual({ unresolved: [], idMapSize: 0 });   // closed twice = nothing
  });
  it('the page sends one run id for every step that writes into the target, never for the ← pull, and closes it before History', () => {
    expect(RC).toContain('profile: pushProfile, runId,');
    expect(RC).toContain('profile: bProfile, runId,');
    expect(RC).not.toContain('profile: pullProfile, runId');
    const i = RC.indexOf("await sendBg({ type: 'SF_RUN_LEDGER_CLOSE', runId });");
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(RC.indexOf('// ── 5. Save to History so the run is visible later'));
    expect(BG).toContain("const ledger = message.runId ? _runLedger(String(message.runId)) : null;");
    expect(BG).toContain("case 'SF_RUN_LEDGER_CLOSE':");
  });
});
