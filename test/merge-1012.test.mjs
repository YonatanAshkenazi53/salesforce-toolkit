// 🔀 Merge the copies of one name into one of them — Deploy › ⚠ Needs a decision
// (user 2026-10-11: "maybe we can provide merging mechanism? so the user ends up
// with a unique data and without dupes" … "It's only merge into this one. User
// needs to be able to select the merged values"; 2026-10-12: "i think we need to
// ship it as 1.0").
//
//   the survivor   the user picks the record that stays;
//   the values     for every writable field that differs the user picks the
//                  value the survivor keeps (its own by default) — only a value
//                  that is not the survivor's is written, before the merge;
//   the way        Account / Contact / Lead / Case: Salesforce's own merge
//                  (Database.merge through executeAnonymous — a WRITE at the
//                  org gate although the verb is GET); every other object: the
//                  child relationships moved one by one, re-counted, and only
//                  then the copy deleted; a refusal stops before that delete;
//   the truth      every step through sftkWriteVerified; the dialog, the
//                  confirmation and the History entry all say a merge cannot be
//                  undone by the Toolkit.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const M = extractFunctions('sftk-merge.js', ['sftkMergeNative', 'sftkMergeIdOk', 'sftkMergeRounds', 'sftkMergeApex', 'sftkMergeFieldOk',
  'sftkMergeDiff', 'sftkMergeChosen', 'sftkMergeChildPlan', 'sftkMergeValueText', 'sftkMergeApexRefusal', '_sftkMergeNorm', 'sftkMergeCoerce', 'sftkMergeTypable']);

const A = '001000000000001AAA', B = '001000000000002AAA', C = '001000000000003AAA', D = '001000000000004AAA';

describe('which objects Salesforce merges itself', () => {
  it('Account, Contact, Lead, Case — nothing else', () => {
    for (const o of ['Account', 'Contact', 'Lead', 'Case']) expect(M.sftkMergeNative(o)).toBe(true);
    for (const o of ['Opportunity', 'SFTK_CX_Project__c', 'account', '', null]) expect(M.sftkMergeNative(o)).toBe(false);
  });
});

describe('the Apex for one round', () => {
  it('a stub survivor and one or two copies, Database.merge with allOrNone', () => {
    const apex = M.sftkMergeApex('Account', A, [B, C]);
    expect(apex).toContain(`Account m = new Account(Id = '${A}');`);
    expect(apex).toContain(`new Account(Id = '${B}'), new Account(Id = '${C}')`);
    expect(apex).toContain('Database.merge(m, d, true);');
  });
  it('refuses anything that is not an id or an object name — nothing else ever reaches Apex source', () => {
    expect(() => M.sftkMergeApex('Account', A, ["x'); delete [SELECT Id FROM Account]; //"])).toThrow(/not a Salesforce id/);
    expect(() => M.sftkMergeApex('Account; delete', A, [B])).toThrow(/not an object name/);
    expect(() => M.sftkMergeApex('Account', A, [B, C, D])).toThrow(/one or two copies/);
    expect(() => M.sftkMergeApex('Account', A, [])).toThrow(/one or two copies/);
  });
  it('ids: 15 or 18 alphanumerics', () => {
    expect(M.sftkMergeIdOk('001000000000001')).toBe(true);
    expect(M.sftkMergeIdOk(A)).toBe(true);
    expect(M.sftkMergeIdOk('001-00000000001')).toBe(false);
    expect(M.sftkMergeIdOk('')).toBe(false);
  });
  it('more than two copies go in rounds of two', () => {
    expect(M.sftkMergeRounds([B, C, D])).toEqual([[B, C], [D]]);
    expect(M.sftkMergeRounds([B])).toEqual([[B]]);
    expect(M.sftkMergeRounds([])).toEqual([]);
  });
});

describe('the fields that differ, and what the survivor is written with', () => {
  const fields = [
    { name: 'Id', updateable: false },
    { name: 'Name', label: 'Account Name', type: 'string', updateable: true },
    { name: 'BillingCity', label: 'Billing City', type: 'string', updateable: true, compoundFieldName: 'BillingAddress' },
    { name: 'BillingAddress', label: 'Billing Address', type: 'address', updateable: false },
    { name: 'Industry', label: 'Industry', type: 'picklist', updateable: true },
    { name: 'AnnualRevenue', label: 'Annual Revenue', type: 'currency', updateable: true },
    { name: 'Phone', label: 'Phone', type: 'phone', updateable: true },
    { name: 'Total__c', label: 'Total', type: 'double', updateable: false, calculated: true },
    { name: 'Active__c', label: 'Active', type: 'boolean', updateable: true },
  ];
  const recs = [
    { Id: A, Name: 'SFTK CX Duplicate Name', BillingCity: 'Haifa', Industry: 'Energy', AnnualRevenue: 1, Phone: null, Active__c: true },
    { Id: B, Name: 'SFTK CX Duplicate Name', BillingCity: 'Eilat', Industry: 'Energy', AnnualRevenue: 2, Phone: '03-1234567', Active__c: true },
  ];
  it('only writable data fields: no Id, no whole address, no formulas — an address PART is compared (Billing City is what differs)', () => {
    expect(M.sftkMergeFieldOk(fields[0])).toBe(false);
    expect(M.sftkMergeFieldOk(fields[1])).toBe(true);
    expect(M.sftkMergeFieldOk(fields[2])).toBe(true);    // a compound part is writable one by one
    expect(M.sftkMergeFieldOk(fields[3])).toBe(false);
    expect(M.sftkMergeFieldOk(fields[7])).toBe(false);
    expect(M.sftkMergeFieldOk({ name: 'X__c', updateable: true, autoNumber: true })).toBe(false);
  });
  it('lists what differs with every copy\'s value, counts what is the same', () => {
    const d = M.sftkMergeDiff(fields, recs);
    expect(d.differ.map(f => f.name)).toEqual(['BillingCity', 'AnnualRevenue', 'Phone']);
    expect(d.differ[0].values).toEqual(['Haifa', 'Eilat']);
    expect(d.differ[1]).toEqual({ name: 'AnnualRevenue', label: 'Annual Revenue', type: 'currency', values: [1, 2] });
    expect(d.differ[2].values).toEqual([null, '03-1234567']);
    expect(d.same).toBe(3);   // Name, Industry, Active__c
    expect(d.sameList.map(f => `${f.name}=${f.value}`)).toEqual(['Name=SFTK CX Duplicate Name', 'Industry=Energy', 'Active__c=true']);
  });
  it('the survivor keeps its own values unless another copy\'s was picked; a pick equal to its own writes nothing', () => {
    const d = M.sftkMergeDiff(fields, recs);
    expect(M.sftkMergeChosen(d, {}, 0)).toEqual({ body: {}, changes: [], errors: [] });
    const c = M.sftkMergeChosen(d, { AnnualRevenue: 1, Phone: 0 }, 0);
    expect(c.body).toEqual({ AnnualRevenue: 2 });
    expect(c.changes).toEqual([{ name: 'AnnualRevenue', label: 'Annual Revenue', from: 1, to: 2 }]);
    // the second copy stays, with the first copy's (empty) phone: an empty value is a real choice
    const e = M.sftkMergeChosen(d, { Phone: 0 }, 1);
    expect(e.body).toEqual({ Phone: null });
  });
  it('a typed value: coerced to the field type, refused with a sentence when it does not fit, written when it differs from the survivor\'s', () => {
    const d = M.sftkMergeDiff(fields, recs);
    const c = M.sftkMergeChosen(d, { AnnualRevenue: { custom: '2,500' }, Phone: { custom: '' } }, 0);
    expect(c.errors).toEqual([]);
    expect(c.body).toEqual({ AnnualRevenue: 2500 });   // Phone typed empty = the survivor's own null: nothing to write
    expect(c.changes[0]).toMatchObject({ name: 'AnnualRevenue', from: 1, to: 2500, typed: true });
    const bad = M.sftkMergeChosen(d, { AnnualRevenue: { custom: 'lots' } }, 0);
    expect(bad.body).toEqual({});
    expect(bad.errors).toEqual([{ name: 'AnnualRevenue', label: 'Annual Revenue', error: 'a number' }]);
    expect(M.sftkMergeCoerce('boolean', 'yes')).toEqual({ ok: true, value: true });
    expect(M.sftkMergeCoerce('boolean', 'maybe').ok).toBe(false);
    expect(M.sftkMergeCoerce('date', '2026-10-14')).toEqual({ ok: true, value: '2026-10-14' });
    expect(M.sftkMergeCoerce('date', '14/10/2026').ok).toBe(false);
    expect(M.sftkMergeCoerce('reference', 'not-an-id').ok).toBe(false);
    expect(M.sftkMergeCoerce('string', '  Netanya ')).toEqual({ ok: true, value: 'Netanya' });
    expect(M.sftkMergeCoerce('int', '7.9')).toEqual({ ok: true, value: 7 });
    expect(M.sftkMergeTypable('string')).toBe(true);
    expect(M.sftkMergeTypable('address')).toBe(false);
  });
  it('values in words', () => {
    expect(M.sftkMergeValueText(null)).toBe('(empty)');
    expect(M.sftkMergeValueText('')).toBe('(empty)');
    expect(M.sftkMergeValueText(false)).toBe('false');
    expect(M.sftkMergeValueText('x'.repeat(100))).toMatch(/…$/);
  });
});

describe('the generic way: which child relationships move', () => {
  it('data relationships move; history, shares, feed, file links and approval rows go with the copy', () => {
    const plan = M.sftkMergeChildPlan([
      { childSObject: 'SFTK_CX_Task__c', field: 'Project__c', relationshipName: 'Tasks__r', cascadeDelete: true },
      { childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts' },
      { childSObject: 'SFTK_CX_Project__History', field: 'ParentId' },
      { childSObject: 'SFTK_CX_Project__Share', field: 'ParentId' },
      { childSObject: 'SFTK_CX_Project__Feed', field: 'ParentId' },
      { childSObject: 'ContentDocumentLink', field: 'LinkedEntityId' },
      { childSObject: 'ProcessInstance', field: 'TargetObjectId' },
      { childSObject: 'Task', field: 'WhatId', relationshipName: 'Tasks' },
      { childSObject: 'NoField', relationshipName: 'x' },
    ]);
    expect(plan.map(r => r.child)).toEqual(['SFTK_CX_Task__c', 'Contact', 'Task']);
    expect(plan[0].cascade).toBe(true);
  });
});

describe('a refusal from executeAnonymous, in the user\'s words', () => {
  it('names the Author Apex permission and the way out in Salesforce', () => {
    expect(M.sftkMergeApexRefusal('INSUFFICIENT_ACCESS: You do not have permission')).toMatch(/"Author Apex" permission.*View Duplicates/);
    expect(M.sftkMergeApexRefusal('System.DmlException: Merge failed')).toBe('System.DmlException: Merge failed');
  });
});

// ── the runner, with a fake org: the order of the writes and the re-reads ──
function runner() {
  const ctx = { console, globalThis: null };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('sftk-write.js'), ctx);
  vm.runInContext(read('sftk-merge.js'), ctx);
  // the journal hears every write the way sftk-history.js does (not loaded here: it talks to storage)
  ctx.sftkHistoryNote = (j, r, d) => { j.what.push({ describe: d, ok: !!r.ok, accepted: !!r.accepted, verified: !!r.verified, text: r.text }); };
  return ctx;
}
const journal = () => ({ kind: 'tool', what: [], errors: [] });

describe('sftkMergeRun — native: the values first, then Salesforce\'s own merge, each verified', () => {
  it('writes the chosen values, runs the Apex, and reports from the re-read', async () => {
    const ctx = runner();
    const calls = [];
    const org = { [A]: { Id: A, Industry: 'Energy' }, [B]: { Id: B } };
    const send = async msg => {
      calls.push(msg.type);
      if (msg.type === 'SF_PATCH') { Object.assign(org[A], msg.body); return { ok: true }; }
      if (msg.type === 'SF_APEX_RUN') { expect(msg.apex).toContain(`new Account(Id = '${B}')`); delete org[B]; return { compiled: true, success: true }; }
      if (msg.type === 'SF_QUERY_ALL') {
        const ids = [...msg.query.matchAll(/'(\w+)'/g)].map(x => x[1]);
        return { records: ids.filter(id => org[id]).map(id => ({ ...org[id] })) };
      }
      throw new Error('unexpected ' + msg.type);
    };
    const j = journal();
    const r = await ctx.sftkMergeRun({ send, orgUrl: 'https://x.my.salesforce.com', sid: 's', obj: 'Account', label: 'Account', name: 'Dup', survivorId: A, dupIds: [B], body: { Industry: 'Media' }, native: true, journal: j });
    expect(r.ok).toBe(true);
    expect(calls.slice(0, 3)).toEqual(['SF_PATCH', 'SF_QUERY_ALL', 'SF_APEX_RUN']);   // the value before the merge
    expect(org[A].Industry).toBe('Media');
    expect(r.deleted).toEqual([B]);
    expect(r.text).toMatch(/merged into 001000000000001AAA with 1 chosen value — verified by re-reading the org/);
    expect(j.what.length).toBe(2);
    expect(j.what.every(w => w.ok && w.verified)).toBe(true);
  });
  it('a refused Apex run is reported from the answer; the copy is kept; nothing is said to be merged', async () => {
    const ctx = runner();
    const send = async msg => {
      if (msg.type === 'SF_APEX_RUN') return { compiled: true, success: false, exceptionMessage: 'System.DmlException: Merge failed. First exception on row 0; first error: INSUFFICIENT_ACCESS' };
      if (msg.type === 'SF_QUERY_ALL') return { records: [{ Id: A }, { Id: B }] };
      throw new Error('unexpected ' + msg.type);
    };
    const r = await ctx.sftkMergeRun({ send, orgUrl: 'u', sid: 's', obj: 'Account', label: 'Account', name: 'Dup', survivorId: A, dupIds: [B], body: {}, native: true, journal: journal() });
    expect(r.ok).toBe(false);
    expect(r.kept).toEqual([B]);
    expect(r.deleted).toEqual([]);
    expect(r.text).toMatch(/0 of 1 copies merged/);
    expect(r.lines[0]).toMatch(/refused.*Author Apex/);
  });
  it('a merge that compiled but left the copy in place is not called done', async () => {
    const ctx = runner();
    const send = async msg => {
      if (msg.type === 'SF_APEX_RUN') return { compiled: true, success: true };
      if (msg.type === 'SF_QUERY_ALL') return { records: msg.query.includes(`'${B}'`) ? [{ Id: B }] : [{ Id: A }] };
      throw new Error('unexpected ' + msg.type);
    };
    const r = await ctx.sftkMergeRun({ send, orgUrl: 'u', sid: 's', obj: 'Account', label: 'Account', name: 'Dup', survivorId: A, dupIds: [B], body: {}, native: true, journal: journal() });
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatch(/still there — the merge did not happen/);
  });
  it('a value the org does not show after the write stops the merge before any copy is touched', async () => {
    const ctx = runner();
    const calls = [];
    const send = async msg => {
      calls.push(msg.type);
      if (msg.type === 'SF_PATCH') return { ok: true };
      if (msg.type === 'SF_QUERY_ALL') return { records: [{ Id: A, Industry: 'Energy' }] };
      throw new Error('unexpected ' + msg.type);
    };
    const r = await ctx.sftkMergeRun({ send, orgUrl: 'u', sid: 's', obj: 'Account', label: 'Account', name: 'Dup', survivorId: A, dupIds: [B], body: { Industry: 'Media' }, native: true, journal: journal() });
    expect(r.ok).toBe(false);
    expect(calls).not.toContain('SF_APEX_RUN');
    expect(r.text).toMatch(/stopped before the merge/);
    expect(r.kept).toEqual([B]);
  });
});

describe('sftkMergeRun — generic: every relationship moved and re-counted before a copy is deleted', () => {
  const mk = () => {
    const ctx = runner();
    const kids = { k1: B, k2: B, k3: A };   // child id → parent
    const org = { [A]: true, [B]: true };
    const calls = [];
    const send = async msg => {
      calls.push(msg.type === 'SF_QUERY_ALL' ? `Q:${msg.query.replace(/\s+/g, ' ')}` : msg.type);
      if (msg.type === 'SF_QUERY_ALL') {
        const m = /FROM (\w+) WHERE (\w+) = '(\w+)'/.exec(msg.query);
        if (m && m[1] === 'Child__c') return { records: Object.entries(kids).filter(([, p]) => p === m[3]).map(([id]) => ({ Id: id })) };
        const ids = [...msg.query.matchAll(/'(\w+)'/g)].map(x => x[1]);
        return { records: ids.filter(id => org[id]).map(id => ({ Id: id })) };
      }
      if (msg.type === 'SF_COLLECTIONS_UPDATE') { msg.records.forEach(r => { kids[r.Id] = r.Parent__c; }); return msg.records.map(r => ({ id: r.Id, success: true })); }
      if (msg.type === 'SF_REST_DELETE') { delete org[msg.id]; return { ok: true }; }
      throw new Error('unexpected ' + msg.type);
    };
    return { ctx, kids, org, calls, send };
  };
  it('moves the children, re-counts, deletes the copy, verifies it is gone', async () => {
    const { ctx, kids, org, calls, send } = mk();
    const r = await ctx.sftkMergeRun({ send, orgUrl: 'u', sid: 's', obj: 'Parent__c', label: 'Parent', name: 'Dup', survivorId: A, dupIds: [B], body: {}, native: false,
      rels: [{ child: 'Child__c', field: 'Parent__c' }], journal: journal() });
    expect(r.ok).toBe(true);
    expect(kids).toEqual({ k1: A, k2: A, k3: A });
    expect(org[B]).toBeUndefined();
    const upd = calls.indexOf('SF_COLLECTIONS_UPDATE'), del = calls.indexOf('SF_REST_DELETE');
    expect(upd).toBeGreaterThan(-1); expect(del).toBeGreaterThan(upd);
    expect(calls.slice(upd + 1, del).some(c => c.startsWith('Q:SELECT Id FROM Child__c WHERE Parent__c'))).toBe(true);   // re-counted before the delete
    expect(r.lines[0]).toMatch(/2 Child__c records moved from .* — verified by re-reading the org/);
  });
  it('a relationship that refuses keeps the copy: no delete, and the receipt names it', async () => {
    const { ctx, org, calls, send } = mk();
    const refusing = async msg => msg.type === 'SF_COLLECTIONS_UPDATE' ? [{ id: msg.records[0].Id, success: false, errors: [{ message: 'FIELD_INTEGRITY_EXCEPTION: cannot reparent' }] }] : send(msg);
    const r = await ctx.sftkMergeRun({ send: refusing, orgUrl: 'u', sid: 's', obj: 'Parent__c', label: 'Parent', name: 'Dup', survivorId: A, dupIds: [B], body: {}, native: false,
      rels: [{ child: 'Child__c', field: 'Parent__c' }], journal: journal() });
    expect(r.ok).toBe(false);
    expect(org[B]).toBe(true);
    expect(calls).not.toContain('SF_REST_DELETE');
    expect(r.lines.some(l => /was NOT deleted: .*cannot reparent/.test(l))).toBe(true);
  });
});

describe('wiring', () => {
  const DV = read('studio-deploy.js'), BG = read('background.js'), HTML = read('studio.html');
  it('the group offers the merge on the side that holds more than one copy, root only', () => {
    const groups = DV.slice(DV.indexOf('function _depAmbGroupsHtml('), DV.indexOf('// The deployment a parents-first step was opened FROM'));
    expect(groups).toMatch(/cands\.length > 1 \? `.*data-dep-amb-merge="tgt"/);
    expect(groups).toMatch(/nSrc > 1 \? `.*data-dep-amb-merge="src"/);
    expect(DV).toMatch(/host\.querySelectorAll\('\[data-dep-amb-merge\]'\)/);
  });
  it('the flow: live read, the picker, the shared confirmation that says it cannot be undone, the journal, the memory, the re-read', () => {
    const flow = DV.slice(DV.indexOf('async function _depMergeCopies('), DV.indexOf('async function _depRescan('));
    expect(flow).toMatch(/sftkMergeRead\(\{ send: sendBg/);
    expect(flow).toMatch(/name="dsMergeKeep"/);
    expect(flow).toMatch(/data-merge-custom=/);                 // a value typed per field (2026-10-14)
    expect(flow).toMatch(/ds-merge-samefold/);                  // the identical fields under a fold
    expect(flow).toMatch(/sftkMergeChosen\(diff, picks, keep\)\.errors/);   // a typed value that does not fit is refused inside the dialog
    expect(flow).toMatch(/The Toolkit cannot undo a merge\./);
    expect(flow).toMatch(/sftkConfirmDestructive\(\{[\s\S]*reversibility: 'permanent'[\s\S]*Cannot be undone/);
    expect(flow).toMatch(/production: gate\.production/);
    expect(flow).toMatch(/sftkHistoryBegin\(\{ tool: 'Merge'/);
    expect(flow).toMatch(/undo: \{ none: 'a merge cannot be undone/);
    expect(flow).toMatch(/sftkForgetPairs/);
    expect(flow).toMatch(/await _depRescan\(p\)/);
    expect(flow).not.toMatch(/sendBg\s*\(/);   // the page hands the transport over; it never calls the background itself
  });
  it('the background runs Apex through executeAnonymous and treats it as a write at the read-only gate', () => {
    expect(BG).toMatch(/case 'SF_APEX_RUN':\s*return sfApexRun\(orgUrl, sid, message\.apex\)/);
    expect(BG).toMatch(/tooling\/executeAnonymous\/\?anonymousBody=\$\{encodeURIComponent\(code\)\}/);
    expect(BG).toMatch(/if \(m === 'GET' && \/\\\/tooling\\\/executeAnonymous\\b\/i\.test\(String\(url \|\| ''\)\)\) return true;/);
    // the gate itself, run: a GET to executeAnonymous is a write, a GET elsewhere is not
    const fn = new Function(BG.slice(BG.indexOf('function sftkIsWriteRequest('), BG.indexOf('\n}', BG.indexOf('function sftkIsWriteRequest(')) + 2) + '\nreturn sftkIsWriteRequest;')();
    expect(fn('GET', 'https://x/services/data/v62.0/tooling/executeAnonymous/?anonymousBody=x')).toBe(true);
    expect(fn('GET', 'https://x/services/data/v62.0/sobjects/Account/describe')).toBe(false);
    expect(fn('PATCH', 'https://x/services/data/v62.0/sobjects/Account/001')).toBe(true);
  });
  it('the engine is loaded by Data Studio before the Deploy page, and is not cut from the public build', () => {
    expect(HTML.indexOf('src="sftk-merge.js"')).toBeGreaterThan(HTML.indexOf('src="sftk-write.js"'));
    expect(HTML.indexOf('src="sftk-merge.js"')).toBeLessThan(HTML.indexOf('src="studio-deploy.js"'));
    expect(read('scripts/pack_store.py')).not.toMatch(/sftk-merge\.js/);
    expect(read('test/write-discipline.test.mjs')).toMatch(/SF_APEX_RUN/);
  });
});
