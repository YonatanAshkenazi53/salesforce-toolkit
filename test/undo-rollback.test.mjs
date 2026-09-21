// ROLLBACK FOR DATA DEPLOYMENTS (user 2026-08-26: "Can we also add
// rollback feature for data deployment? ... might help us with production
// issues" · "Should also look for validation rules, flow validations, dupe
// records").
//
// The interesting tests here are not "does it restore" but "does it refuse
// to claim it restored". A rollback that half-works while reporting success
// is worse than no rollback: it sends someone back to production believing
// the blast radius was reversed.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const SRC = readFileSync(new URL('../sftk-undo.js', import.meta.url), 'utf8');

const F = extractFunctions('sftk-undo.js', [
  'sftkUndoMaxRows', 'sftkUndoMaxRuns', 'sftkUndoFields', 'sftkUndoSnapshotSoql',
  'sftkUndoCapture', 'sftkUndoDiff', 'sftkUndoRestorePayload', 'sftkUndoPlan',
  'sftkUndoLimits', 'sftkUndoAutomationQueries', 'sftkUndoFlowBlocks',
  'sftkUndoAutomationSummary', 'sftkUndoPrune',
  'sftkUndoTreeObjects', 'sftkUndoMergeObjects', 'sftkUndoFieldsForMode', 'sftkUndoRowCap',
  'sftkUndoReadQuote', 'sftkUndoEntryFor', 'sftkUndoCardState', 'sftkUndoScopeByTime', 'sftkUndoRunWrote',
  'sftkUndoResultSummary', 'sftkUndoRunStatus', 'sftkUndoVerifyLine',
  'sftkUndoFieldsNotCovered', 'sftkUndoCascadeChildren', 'sftkUndoSoqlDateTime', 'sftkUndoVerifyCounts',
]);

describe('what gets captured', () => {
  it('captures what the run could overwrite, and nothing it could not', () => {
    const fields = F.sftkUndoFields({ fields: [
      { name: 'Name', updateable: true },
      { name: 'Total__c', updateable: true, calculated: true },
      { name: 'Id', updateable: false },
      { name: 'OwnerId', updateable: true },
      { name: 'CreatedById', updateable: true },
      { name: 'Shipping', updateable: true, type: 'address' },
      { name: 'Body', updateable: true, type: 'base64' },
      { name: 'Secret__c', updateable: true, type: 'encryptedstring' },
      { name: 'Amount__c', updateable: true },
    ] });
    // A formula cannot be written back, an address is a compound of fields
    // already captured, a base64 body reads back as a URL, a classic
    // encrypted field reads back MASKED, and audit fields are Salesforce's.
    expect(fields).toEqual(['Name', 'Amount__c']);
  });

  it('always reads Id — it is the identity the whole diff turns on', () => {
    expect(F.sftkUndoSnapshotSoql('Account', ['Name'])).toBe('SELECT Id, Name FROM Account');
    expect(F.sftkUndoSnapshotSoql('Account', ['Id', 'Name'])).toBe('SELECT Id, Name FROM Account');
  });

  it('REFUSES an oversized image rather than keeping half of one', () => {
    // Half an image would produce a rollback that restores half an object
    // and reports success.
    const rows = Array.from({ length: 11 }, (_, i) => ({ Id: `00${i}` }));
    const cap = F.sftkUndoCapture(rows, 10);
    expect(cap.truncated).toBe(true);
    expect(cap.rows).toEqual([]);
    expect(cap.count).toBe(11);
  });

  it('indexes by Id and drops rows with no identity', () => {
    const cap = F.sftkUndoCapture([{ Id: 'a', Name: 'A' }, { Name: 'no id' }, null], 100);
    expect(cap.count).toBe(1);
    expect(cap.byId.a.Name).toBe('A');
    expect(cap.truncated).toBe(false);
  });
});

describe('the diff — what the run actually did', () => {
  const before = F.sftkUndoCapture([
    { Id: 'r1', Name: 'Old', Amount__c: 5 },
    { Id: 'r2', Name: 'Same', Amount__c: 1 },
    { Id: 'r3', Name: 'Doomed', Amount__c: 9 },
  ], 100);
  const after = [
    { Id: 'r1', Name: 'New', Amount__c: 5 },
    { Id: 'r2', Name: 'Same', Amount__c: 1 },
    { Id: 'r4', Name: 'Fresh', Amount__c: 0 },
  ];
  const d = F.sftkUndoDiff(before, after);

  it('separates created, changed, deleted and untouched', () => {
    expect(d.created).toEqual(['r4']);
    expect(d.changed.map(c => c.id)).toEqual(['r1']);
    expect(d.deleted).toEqual(['r3']);
    expect(d.unchanged).toBe(1);
  });

  it('names exactly which fields moved, not the whole record', () => {
    expect(d.changed[0].fields).toEqual(['Name']);
    expect(d.changed[0].before.Name).toBe('Old');
  });

  it('treats null and empty as the same value, and does not invent changes', () => {
    const b = F.sftkUndoCapture([{ Id: 'x', A: null, B: '' }], 10);
    expect(F.sftkUndoDiff(b, [{ Id: 'x', A: '', B: null }]).changed).toEqual([]);
  });

  it('a field absent from the after-read is NOT reported as changed', () => {
    // Reading fewer columns than were captured must not look like the run
    // blanked them.
    const b = F.sftkUndoCapture([{ Id: 'x', A: '1', B: '2' }], 10);
    expect(F.sftkUndoDiff(b, [{ Id: 'x', A: '1' }]).changed).toEqual([]);
  });

  it('an empty before-image makes everything look created — never changed', () => {
    const d2 = F.sftkUndoDiff({ byId: {} }, [{ Id: 'z' }]);
    expect(d2.created).toEqual(['z']);
    expect(d2.changed).toEqual([]);
  });
});

describe('the restore payload', () => {
  it('writes back ONLY the fields that moved', () => {
    // Rewriting an untouched field bumps its audit trail and can trip an
    // update-triggered automation for nothing.
    const p = F.sftkUndoRestorePayload('Account',
      [{ id: 'r1', before: { Id: 'r1', Name: 'Old', Amount__c: 5 }, fields: ['Name'] }]);
    expect(p).toEqual([{ attributes: { type: 'Account' }, Id: 'r1', Name: 'Old' }]);
  });

  it('restores a value that was originally blank as null, not as skipped', () => {
    const p = F.sftkUndoRestorePayload('Account',
      [{ id: 'r1', before: { Id: 'r1' }, fields: ['Note__c'] }]);
    expect(p[0].Note__c).toBe(null);
  });

  it('leaves a Person Account’s derived Name out — its parts restore it', () => {
    const p = F.sftkUndoRestorePayload('Account',
      [{ id: 'pa', before: { Id: 'pa', IsPersonAccount: true, Name: 'Ann Smith', FirstName: 'Ann' }, fields: ['Name', 'FirstName'] },
       { id: 'ba', before: { Id: 'ba', IsPersonAccount: false, Name: 'Acme' }, fields: ['Name'] }]);
    expect(p[0]).toEqual({ attributes: { type: 'Account' }, Id: 'pa', FirstName: 'Ann' });
    expect(p[1].Name).toBe('Acme');
  });

  it('skips a record with nothing to write and one with no id', () => {
    expect(F.sftkUndoRestorePayload('Account', [
      { id: 'r1', before: {}, fields: [] },
      { before: {}, fields: ['X'] },
    ])).toEqual([]);
  });
});

describe('the plan, stated before it runs', () => {
  it('counts each outcome separately', () => {
    const plan = F.sftkUndoPlan({ created: ['a', 'b'], changed: [{ id: 'c' }], deleted: ['d'], unchanged: 7 });
    expect(plan).toMatchObject({ toDelete: 2, toRestore: 1, goneCount: 1, unchanged: 7 });
  });

  it('flags that deleted records need the Recycle Bin, not a rewrite', () => {
    // Re-inserting mints a new Id and leaves every lookup broken.
    expect(F.sftkUndoPlan({ deleted: ['d'] }).goneNeedsRecycleBin).toBe(true);
    expect(F.sftkUndoPlan({ deleted: [] }).goneNeedsRecycleBin).toBe(false);
  });

  it('survives a junk diff without inventing work', () => {
    expect(F.sftkUndoPlan(undefined)).toMatchObject({ toDelete: 0, toRestore: 0, goneCount: 0 });
  });
});

describe('what rollback cannot undo — stated, not buried', () => {
  const limits = F.sftkUndoLimits().join(' ');

  it('says automation that already ran is not undone', () => {
    expect(limits).toMatch(/Automation that already ran is NOT undone/);
    expect(limits).toMatch(/stay sent/);
  });

  it('says hard-deleted records are gone permanently', () => {
    expect(limits).toMatch(/HARD-DELETED are gone permanently/);
  });

  it('says the rollback is itself a write that can be rejected', () => {
    expect(limits).toMatch(/rollback is itself a write/);
    expect(limits).toMatch(/duplicate rules/i);
  });

  it('does not claim to cover metadata', () => {
    expect(limits).toMatch(/not data and is not covered here/);
  });

  it('does not claim to cover files, owners, or automation-created records', () => {
    expect(limits).toMatch(/Files \(ContentVersion\).*NOT covered/);
    expect(limits).toMatch(/Owner changes are not restored/);
    expect(limits).toMatch(/AUTOMATION created/);
  });
});

describe('which objects a run can write — deepest first, mode per object', () => {
  const tree = { objectType: 'Account', children: [
    { childSObject: 'Contact', children: [{ childSObject: 'Case', upsert: { field: 'Ext__c' } }] },
    { childSObject: 'Opportunity' },
  ] };

  it('orders children before parents so a rollback can delete them first', () => {
    // A restrict-delete lookup refuses the parent while children point at it.
    expect(F.sftkUndoTreeObjects(tree, 'insert').map(o => o.objType)).toEqual(['Case', 'Contact', 'Opportunity', 'Account']);
  });

  it('an insert run only needs Ids; a node with its own upsert needs values', () => {
    const objs = F.sftkUndoTreeObjects(tree, 'insert');
    expect(objs.find(o => o.objType === 'Account').mode).toBe('insert');
    expect(objs.find(o => o.objType === 'Case').mode).toBe('upsert');
    expect(F.sftkUndoTreeObjects(tree, 'upsert').find(o => o.objType === 'Account').mode).toBe('upsert');
    expect(F.sftkUndoTreeObjects(tree, 'reconcile').every(o => o.mode === 'reconcile')).toBe(true);
  });

  it('the same object at two depths keeps the deeper one', () => {
    const t = { objectType: 'Account', children: [{ childSObject: 'Account' }] };
    expect(F.sftkUndoTreeObjects(t, 'insert')).toEqual([{ objType: 'Account', depth: 1, mode: 'insert' }]);
  });

  it('merging a sequence keeps the deepest depth and the strongest mode', () => {
    const m = F.sftkUndoMergeObjects([
      [{ objType: 'A', depth: 0, mode: 'insert' }],
      [{ objType: 'A', depth: 2, mode: 'upsert' }, { objType: 'B', depth: 1, mode: 'insert' }],
    ]);
    expect(m).toEqual([{ objType: 'A', depth: 2, mode: 'upsert' }, { objType: 'B', depth: 1, mode: 'insert' }]);
  });

  it('Id-only images get a higher row cap; every read is quoted first', () => {
    expect(F.sftkUndoFieldsForMode(['Name'], 'insert')).toEqual([]);
    expect(F.sftkUndoFieldsForMode(['Name'], 'upsert')).toEqual(['Name']);
    expect(F.sftkUndoRowCap('insert')).toBe(250000);
    expect(F.sftkUndoRowCap('reconcile')).toBe(50000);
    expect(F.sftkUndoReadQuote(4001)).toEqual({ rows: 4001, calls: 4 });
    expect(F.sftkUndoReadQuote(0)).toEqual({ rows: 0, calls: 1 });
  });
});

describe('the stub on the History entry and the card it drives', () => {
  it('ready / partial / none follow what was ACTUALLY captured', () => {
    const legs = [{ orgUrl: 'o', objects: { Account: {}, Contact: {} }, skipped: {} }];
    expect(F.sftkUndoEntryFor('e1', legs, 'run', 't').status).toBe('ready');
    legs[0].skipped.Case = '120,000 rows — above the limit';
    const p = F.sftkUndoEntryFor('e1', legs, 'run', 't');
    expect(p.status).toBe('partial');
    expect(p.objects).toEqual(['Account', 'Contact']);
    expect(F.sftkUndoEntryFor('e1', [{ orgUrl: 'o', objects: {}, skipped: { Account: 'off' } }], 'run', 't').status).toBe('none');
  });

  it('an object captured in two orgs is listed once', () => {
    const legs = [{ orgUrl: 'a', objects: { Account: {} }, skipped: {} }, { orgUrl: 'b', objects: { Account: {} }, skipped: {} }];
    expect(F.sftkUndoEntryFor('e', legs, 'run', 't').objects).toEqual(['Account']);
  });

  it('a run without a stub shows nothing; a run WITHOUT a restore point says so and why', () => {
    expect(F.sftkUndoCardState({})).toEqual({ show: false });
    const none = F.sftkUndoCardState({ undo: { status: 'none', skipped: { Account: 'restore points are switched off' } } });
    expect(none.show).toBe(true);
    expect(none.disabled).toBe(true);
    expect(none.title).toContain('switched off');
  });

  it('partial coverage is in the LABEL, not hidden in a tooltip', () => {
    const st = F.sftkUndoCardState({ undo: { status: 'partial', objects: ['Contact'], skipped: { Account: 'too big' } } });
    expect(st.disabled).toBe(false);
    expect(st.label).toContain('Contact only');
    expect(st.title).toContain('NOT covered');
  });

  it('rolled back, expired, retry and sequence states', () => {
    expect(F.sftkUndoCardState({ undo: { status: 'ready', rolledBackAt: '2026-09-01' } }).disabled).toBe(true);
    expect(F.sftkUndoCardState({ undo: { status: 'expired' } }).label).toContain('expired');
    const again = F.sftkUndoCardState({ undo: { status: 'ready', objects: ['A'], lastRollbackStatus: 'partial' } });
    expect(again.disabled).toBe(false);
    expect(again.label).toContain('again');
    expect(F.sftkUndoCardState({ undo: { status: 'ready', objects: ['A'], scope: 'sequence' } }).label).toContain('sequence');
  });
});

describe('leaving other people’s LATER work alone', () => {
  const diff = { created: ['n1', 'n2'], changed: [{ id: 'c1', fields: ['Name'] }, { id: 'c2', fields: ['Name'] }] };
  const rows = [
    { Id: 'n1', CreatedDate: '2026-09-01T10:00:00.000+0000' },
    { Id: 'n2', CreatedDate: '2026-09-01T12:00:00.000+0000' },
    { Id: 'c1', LastModifiedDate: '2026-09-01T10:00:00.000+0000' },
    { Id: 'c2', LastModifiedDate: '2026-09-02T09:00:00.000+0000' },
  ];

  it('a record created or edited AFTER the run ended is not touched', () => {
    const s = F.sftkUndoScopeByTime(diff, rows, '2026-09-01T10:30:00.000Z');
    expect(s.created).toEqual(['n1']);
    expect(s.createdLater).toBe(1);
    expect(s.changed.map(c => c.id)).toEqual(['c1']);
    expect(s.changedLater).toBe(1);
    expect(s.filtered).toBe(true);
  });

  it('without a run end time nothing is filtered — and it says so', () => {
    const s = F.sftkUndoScopeByTime(diff, rows, null);
    expect(s.created).toEqual(['n1', 'n2']);
    expect(s.filtered).toBe(false);
  });

  it('a minute of clock skew does not exclude the run’s own last records', () => {
    expect(F.sftkUndoScopeByTime(diff, rows, '2026-09-01T11:59:30.000Z').created).toEqual(['n1', 'n2']);
  });
});

describe('the rollback’s own result — verified, or said to be unverified', () => {
  it('maps to the History card’s shape and keeps what still differs', () => {
    const s = F.sftkUndoResultSummary({ Account: { deleted: 2, deleteFailed: 1, restored: 3, restoreFailed: 0, remaining: 1 } });
    expect(s.Account).toMatchObject({ deleted: 2, deletedFailed: 1, updated: 3, updatedFailed: 0, remaining: 1 });
    expect(F.sftkUndoResultSummary({ A: { deleted: 1 } }).A.remaining).toBe(null);
    // A two-leg rollback keeps the org per entry so History links go to the RIGHT org.
    expect(F.sftkUndoResultSummary({ 'A @ src': { deleted: 0, orgUrl: 'https://src' } })['A @ src'].orgUrl).toBe('https://src');
  });

  it('success needs zero refusals, zero remaining AND a verification read', () => {
    expect(F.sftkUndoRunStatus({ A: { deleted: 1, restored: 0, remaining: 0 } })).toBe('success');
    expect(F.sftkUndoRunStatus({ A: { deleted: 1, remaining: null } })).toBe('partial');
    expect(F.sftkUndoRunStatus({ A: { deleted: 1, remaining: 2 } })).toBe('partial');
    expect(F.sftkUndoRunStatus({ A: { deleted: 0, deleteFailed: 3, remaining: 3 } })).toBe('failed');
  });

  it('the verify line never says clean without a read, and never wider than what was acted on', () => {
    expect(F.sftkUndoVerifyLine('Account', null)).toMatch(/UNVERIFIED/);
    expect(F.sftkUndoVerifyLine('Account', 0, 0)).toMatch(/verified — nothing from the run remains/);
    expect(F.sftkUndoVerifyLine('Account', 0, 3)).toMatch(/3 record\(s\) were deliberately left alone/);
    expect(F.sftkUndoVerifyLine('Account', 4, 0)).toMatch(/4 record\(s\) still differ/);
    // what the RUN deleted is still gone — said, never folded into "verified"
    expect(F.sftkUndoVerifyLine('Account', 0, 0, 50, false)).toMatch(/50 record\(s\) from the restore point are still gone .* Recycle Bin/);
    expect(F.sftkUndoVerifyLine('Account', 0, 0, 5, true)).toMatch(/hard-deleted by the run, permanently/);
    expect(F.sftkUndoVerifyLine('Account', 0, 2, 5, false)).toMatch(/2 record\(s\) were deliberately left alone.*5 record\(s\) from the restore point are still gone/);
  });

  it('the summary carries still-gone and unconfirmed counts to the card', () => {
    const s = F.sftkUndoResultSummary({ A: { deleted: 1, stillGone: 3, goneHard: true, unconfirmed: 2 } }).A;
    expect(s).toMatchObject({ stillGone: 3, goneHard: true, unconfirmed: 2 });
  });

  it('verification judges the acted-on records by IDENTITY — a rejected restore cannot hide behind its fresh timestamp', () => {
    const d2 = { created: ['n1', 'x9'], changed: [{ id: 'c1' }, { id: 'c2' }] };
    const v = F.sftkUndoVerifyCounts(d2, new Set(['n1', 'c1']));
    expect(v).toEqual({ remaining: 2, leftAlone: 2 });
    expect(F.sftkUndoVerifyCounts({ created: [], changed: [] }, ['n1'])).toEqual({ remaining: 0, leftAlone: 0 });
  });
});

describe('what a delete drags along, and what the image cannot hold', () => {
  it('lists cascading child relationships and skips system shadows', () => {
    const desc = { childRelationships: [
      { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
      { childSObject: 'Opportunity', field: 'AccountId', cascadeDelete: true },
      { childSObject: 'AccountHistory', field: 'AccountId', cascadeDelete: true },
      { childSObject: 'AccountShare', field: 'AccountId', cascadeDelete: true },
      { childSObject: 'EntitySubscription', field: 'ParentId', cascadeDelete: true },
      { childSObject: 'Case', field: 'AccountId', cascadeDelete: false },
      { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
    ] };
    expect(F.sftkUndoCascadeChildren(desc)).toEqual([
      { childSObject: 'Contact', field: 'AccountId' },
      { childSObject: 'Opportunity', field: 'AccountId' },
    ]);
    expect(F.sftkUndoCascadeChildren(null)).toEqual([]);
  });

  it('names the writable fields the image cannot hold', () => {
    const nc = F.sftkUndoFieldsNotCovered({ fields: [
      { name: 'Body', updateable: true, type: 'base64' },
      { name: 'Tax__c', updateable: true, type: 'encryptedstring' },
      { name: 'Name', updateable: true, type: 'string' },
      { name: 'Old__c', updateable: false, type: 'base64' },
    ] });
    expect(nc).toEqual([{ name: 'Body', type: 'base64' }, { name: 'Tax__c', type: 'encryptedstring' }]);
  });

  it('writes a SOQL datetime literal Salesforce accepts', () => {
    expect(F.sftkUndoSoqlDateTime('2026-09-01T10:30:00.123Z')).toBe('2026-09-01T10:30:00Z');
    expect(F.sftkUndoSoqlDateTime('junk')).toBe(null);
  });

  it('a data run without a stub says so; a compare entry stays quiet', () => {
    const st = F.sftkUndoCardState({ summary: { Account: { created: 3 } } });
    expect(st.show).toBe(true);
    expect(st.disabled).toBe(true);
    expect(st.label).toContain('no restore point');
    expect(F.sftkUndoCardState({ kind: 'compare', summary: { Account: {} } })).toEqual({ show: false });
  });

  it('the limits name the during-run blind spot, cascades and permanent deletes', () => {
    const limits = F.sftkUndoLimits().join(' ');
    expect(limits).toMatch(/BETWEEN the restore point and the end of the run/);
    expect(limits).toMatch(/deletes what hangs under it/);
    expect(limits).toMatch(/no Recycle Bin .* deleted PERMANENTLY/);
  });
});

describe('automation detection — validation, flows, duplicates', () => {
  const objs = ['Account', 'Contact'];

  it('looks for all four families the user named, plus triggers', () => {
    const keys = F.sftkUndoAutomationQueries(objs).map(q => q.key);
    expect(keys).toContain('validation');
    expect(keys).toContain('duplicate');
    expect(keys).toContain('flows');
    expect(keys).toContain('triggers');
    expect(keys).toContain('workflow');
  });

  it('scopes every object-filterable query to the objects in play', () => {
    for (const q of F.sftkUndoAutomationQueries(objs)) {
      if (q.key === 'flows') continue;   // the view has no api-name column
      expect(q.soql, q.key).toContain("'Account'");
      expect(q.soql, q.key).toContain("'Contact'");
    }
  });

  it('asks for duplicate rules — the quietest reason a restore half-completes', () => {
    const dup = F.sftkUndoAutomationQueries(objs).find(q => q.key === 'duplicate');
    expect(dup.soql).toMatch(/FROM DuplicateRule/);
    expect(dup.kind).toBe('blocking');
  });

  it('asks for nothing when there are no objects', () => {
    expect(F.sftkUndoAutomationQueries([])).toEqual([]);
  });

  it('knows which flows can REJECT a write and which merely ran', () => {
    expect(F.sftkUndoFlowBlocks('RecordBeforeSave')).toBe(true);
    expect(F.sftkUndoFlowBlocks('RecordBeforeDelete')).toBe(true);
    expect(F.sftkUndoFlowBlocks('RecordAfterSave')).toBe(false);
    expect(F.sftkUndoFlowBlocks(null)).toBe(false);
  });

  const results = {
    validation: { rows: [{ ValidationName: 'V1', Active: true }, { ValidationName: 'Off', Active: false }] },
    duplicate: { rows: [{ DeveloperName: 'D1', IsActive: true }, { DeveloperName: 'Off', IsActive: false }] },
    triggers: { error: 'no access to ApexTrigger' },
    flows: { rows: [
      { ApiName: 'Guard', TriggerType: 'RecordBeforeSave', TriggerObjectOrEventLabel: 'Account' },
      { ApiName: 'Notify', TriggerType: 'RecordAfterSave', TriggerObjectOrEventLabel: 'Account' },
      { ApiName: 'Elsewhere', TriggerType: 'RecordAfterSave', TriggerObjectOrEventLabel: 'Opportunity' },
      { ApiName: 'Scheduled', TriggerType: 'Scheduled', TriggerObjectOrEventLabel: 'Account' },
    ] },
    workflow: { rows: [{ Name: 'W1' }] },
  };
  const sum = F.sftkUndoAutomationSummary(results, objs);

  it('splits BLOCKING from already-fired side effects', () => {
    const blocking = sum.blocking.map(b => b.label).join(' | ');
    expect(blocking).toMatch(/Validation rules/);
    expect(blocking).toMatch(/Duplicate rules/);
    expect(blocking).toMatch(/Before-save flows/);
    const side = sum.sideEffects.map(b => b.label).join(' | ');
    expect(side).toMatch(/After-save flows/);
    expect(side).toMatch(/Workflow rules/);
  });

  it('counts only ACTIVE rules', () => {
    expect(sum.blocking.find(b => b.key === 'validation').count).toBe(1);
    expect(sum.blocking.find(b => b.key === 'duplicate').count).toBe(1);
  });

  it('drops flows for other objects and non-record triggers', () => {
    const after = sum.sideEffects.find(b => b.key === 'flows-after');
    expect(after.rows.map(r => r.ApiName)).toEqual(['Notify']);
  });

  it('matches record-triggered flows by the object LABEL the view exposes', () => {
    // FlowDefinitionView names the object by label: 'Invoice' for Invoice__c.
    const r = { flows: { rows: [{ ApiName: 'Guard', TriggerType: 'RecordBeforeSave', TriggerObjectOrEventLabel: 'Invoice' }] } };
    expect(F.sftkUndoAutomationSummary(r, ['Invoice__c']).blocking.length).toBe(0);
    const withLabel = F.sftkUndoAutomationSummary(r, ['Invoice__c'], { Invoice__c: 'Invoice' });
    expect(withLabel.blocking.some(b => b.key === 'flows-before')).toBe(true);
    // an object whose label is unknown is reported UNKNOWN, never silently unmatched
    const noLabel = F.sftkUndoAutomationSummary(r, ['Invoice__c', 'Other__c'], { Invoice__c: 'Invoice' });
    expect(noLabel.unknown.some(u => u.key === 'flows-label' && u.label.includes('Other__c'))).toBe(true);
  });

  it('a category it could not read is UNKNOWN, never counted as zero', () => {
    // "no triggers" and "could not check for triggers" are different facts,
    // and only one of them is reassuring.
    expect(sum.unknown.map(u => u.key)).toContain('triggers');
    expect(sum.unknown.find(u => u.key === 'triggers').why).toContain('no access');
    expect(sum.blocking.some(b => b.key === 'triggers')).toBe(false);
  });

  it('a trigger appears on BOTH sides — we cannot tell its contexts apart', () => {
    const s2 = F.sftkUndoAutomationSummary(
      { triggers: { rows: [{ Name: 'T', TableEnumOrId: 'Account', Status: 'Active' }] } }, objs);
    expect(s2.blocking.some(b => b.key === 'triggers')).toBe(true);
    expect(s2.sideEffects.some(b => b.key === 'triggers')).toBe(true);
  });
});

describe('keeping the evidence bounded', () => {
  it('keeps the newest runs and names what it dropped', () => {
    const store = {};
    for (let i = 1; i <= 5; i++) store[`run${i}`] = { capturedAt: `2026-08-0${i}T00:00:00Z` };
    const { kept, dropped } = F.sftkUndoPrune(store, 3);
    expect(Object.keys(kept).sort()).toEqual(['run3', 'run4', 'run5']);
    expect(dropped.sort()).toEqual(['run1', 'run2']);
  });

  it('ignores entries with no capture time rather than ranking them first', () => {
    const { kept } = F.sftkUndoPrune({ a: { capturedAt: '2026-01-01' }, b: {} }, 5);
    expect(Object.keys(kept)).toEqual(['a']);
  });
});

describe('the library states the trap it exists to avoid', () => {
  it('explains why it cannot be built on the run’s own report', () => {
    expect(SRC).toContain('idPairs is root-only, capped at 2000');
  });

  it('says restoring records is not undoing consequences', () => {
    expect(SRC).toContain('Restoring records is not undoing consequences');
  });
});


// 2026-09-15 (user: "it suggested rollback when nothing was written")
describe('a run Salesforce confirmed wrote nothing has nothing to roll back', () => {
  const ready = { status: 'ready', objects: ['Account'] };
  it('every record failed → the button is there, disabled, and says so', () => {
    const st = F.sftkUndoCardState({ kind: 'reconcile', undo: ready, summary: { Account: { created: 0, failed: 10 } } });
    expect(st.show).toBe(true);
    expect(st.disabled).toBe(true);
    expect(st.label).toContain('Nothing to roll back');
    expect(st.title).toContain('restore point is kept');
  });
  it('anything written, errored, unanswered or uncounted keeps the rollback offer', () => {
    expect(F.sftkUndoCardState({ undo: ready, summary: { Account: { created: 1, failed: 9 } } }).disabled).toBe(false);
    expect(F.sftkUndoCardState({ undo: ready, summary: { Account: { created: 0, failed: 0, error: 'boom' } } }).disabled).toBe(false);
    expect(F.sftkUndoCardState({ undo: ready, summary: { Account: { created: 0, failed: 3, notProcessed: 2 } } }).disabled).toBe(false);
    expect(F.sftkUndoCardState({ undo: ready, summary: { Account: {} } }).disabled).toBe(false);
    expect(F.sftkUndoCardState({ undo: ready }).disabled).toBe(false);
  });
  it('sftkUndoRunWrote answers true / false / null, and a skipped object does not count', () => {
    expect(F.sftkUndoRunWrote({ summary: { A: { inserted: 0, insertedFailed: 4 }, B: { created: 0, failed: 0, skipped: true } } })).toBe(false);
    expect(F.sftkUndoRunWrote({ summary: { A: { deleted: 2 } } })).toBe(true);
    expect(F.sftkUndoRunWrote({ summary: { A: { updatedSource: 1, updatedSourceFailed: 0 } } })).toBe(true);
    expect(F.sftkUndoRunWrote({})).toBe(null);
    expect(F.sftkUndoRunWrote({ summary: { A: { created: 0, failed: 0, notProcessed: 1 } } })).toBe(null);
  });
});
