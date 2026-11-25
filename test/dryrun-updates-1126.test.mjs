// 2026-11-26, the owner on a dry run of an Account + Contact tree with inserts AND updates ticked:
//   "i want to see what will fail for both objects and under which operation"
// A dry run checked inserts only. The updates of changed records now go through their own rolled-back transaction,
// and the result names the operation on every row and on every refusal.
// The same day, live: the first build's guard sat in the WRONG function (a text anchor that occurs twice), so the
// dry run really wrote 103 Account updates into the target. The placement is pinned below.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { extractFunction } from './extract.mjs';
const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const table = extractFunction('studio-reconcile.js', 'sftkProbeTable');
const body = extractFunction('studio-reconcile.js', 'sftkProbeUpdateBody');
const parse = extractFunction('studio-reconcile.js', 'sftkProbeUpdateParse');
const P = [{ attributes: { type: 'Account' }, Id: '001A', Phone: '1' }, { attributes: { type: 'Account' }, Id: '001B', Phone: '2' }];
const poison = { referenceId: 'poison', httpStatusCode: 400, body: [{ errorCode: 'REQUIRED_FIELD_MISSING' }] };

describe('a dry run of updates never writes', () => {
  it('the check returns INSIDE reconcileOverwrite, before its write', () => {
    const fn = RC.slice(RC.indexOf('async function reconcileOverwrite('));
    const guard = fn.indexOf('if (opts && opts.probe) return _recProbeUpdates(');
    const write = fn.indexOf("type: 'SF_COLLECTIONS_UPDATE'");
    expect(guard).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(guard);
    expect(RC.split('if (opts && opts.probe) return _recProbeUpdates(').length).toBe(2);   // once, and only there
    expect(RC.slice(0, RC.indexOf('async function reconcileOverwrite('))).not.toContain('opts.probe) return _recProbeUpdates(');
  });
  it('the request is all-or-none and ends with the record that always fails', () => {
    const b = body('Account', P, 'v62.0', false);
    expect(b.allOrNone).toBe(true);
    expect(b.compositeRequest.map(r => r.referenceId)).toEqual(['u0', 'poison']);
    expect(b.compositeRequest[0]).toMatchObject({ method: 'PATCH', url: '/services/data/v62.0/composite/sobjects' });
    expect(b.compositeRequest[0].body.records.map(r => r.Id)).toEqual(['001A', '001B']);
    expect(b.compositeRequest[0].httpHeaders).toBeUndefined();
    expect(body('Account', P, 'v62.0', true).compositeRequest[0].httpHeaders).toEqual({ 'Sforce-Duplicate-Rule-Header': 'allowSave=true' });
    expect(b.compositeRequest[1].body.Name).toBeUndefined();   // an Account with no Name: refused, so everything rolls back
  });
  it('an answer in which the last record did NOT fail is never read as a result', () => {
    const r = parse(P, { compositeResponse: [{ referenceId: 'u0', httpStatusCode: 200, body: [{ success: true, id: '001A' }, { success: true, id: '001B' }] }, { referenceId: 'poison', httpStatusCode: 201, body: { id: '001X' } }] });
    expect(r.rolledBack).toBe(false); expect(r.rows).toEqual([]); expect(r.error).toBe('the transaction was not rolled back');
    expect(parse(P, {}).error).toBe('Salesforce did not answer the dry run of the updates');
  });
  it('the target is re-read before and after, and a changed record is an error', () => {
    const fn = RC.slice(RC.indexOf('async function _recProbeUpdates('), RC.indexOf('async function reconcileOverwrite('));
    expect(fn).toContain('SELECT Id, SystemModstamp FROM');
    expect(fn).toContain('the dry run CHANGED ');
    expect(fn).not.toContain('SF_COLLECTIONS_UPDATE');
  });
});

describe('what Salesforce answered', () => {
  it('a refused record keeps its reason; the others would be written', () => {
    const r = parse(P, { compositeResponse: [{ referenceId: 'u0', httpStatusCode: 400, body: [
      { success: false, errors: [{ statusCode: 'ALL_OR_NONE_OPERATION_ROLLED_BACK', message: 'rolled back' }] },
      { success: false, errors: [{ statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'The answer is not 42!' }] }] }, poison] });
    expect(r.rows).toEqual([{ id: '001A', state: 'ok' }, { id: '001B', state: 'refused', error: 'The answer is not 42!', code: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' }]);
  });
  it('nothing refused: Salesforce halts the update request and only the last record fails (seen live 2026-11-26)', () => {
    const r = parse(P, { compositeResponse: [{ referenceId: 'u0', httpStatusCode: 400, body: [{ errorCode: 'PROCESSING_HALTED', message: 'rolled back' }] }, poison] });
    expect(r.error).toBe(''); expect(r.rows.map(x => x.state)).toEqual(['ok', 'ok']);
  });
  it('a request Salesforce refuses whole is an error, not "would be written"', () => {
    const r = parse(P, { compositeResponse: [{ referenceId: 'u0', httpStatusCode: 400, body: [{ errorCode: 'INVALID_FIELD', message: "No such column 'X'" }] }, poison] });
    expect(r.rows).toEqual([]); expect(r.error).toBe("No such column 'X'");
  });
});

describe('the table says the operation', () => {
  const t = table(
    { Account: { probed: 4, wouldWrite: 3, refused: 1 }, Contact: { probed: 2, wouldWrite: 0, refused: 2 } }, { Account: 4, Contact: 2 },
    { Account: { probed: 1, wouldWrite: 0, refused: 1, unchecked: 0, sampledOf: 0 }, Contact: { probed: 200, wouldWrite: 200, refused: 0, unchecked: 0, sampledOf: 350 }, Case: { probed: 0, unchecked: 5 } });
  it('a row per object and operation, the insert first', () => {
    expect(t.rows.map(r => `${r.obj} ${r.op} ${r.inRun}/${r.would}/${r.refused}/${r.notChecked}`)).toEqual([
      'Account Insert 4/3/1/0', 'Account Update 1/0/1/0', 'Contact Insert 2/0/2/0', 'Contact Update 200/200/0/0', 'Case Update 5/0/0/5']);
    expect(t.total).toEqual({ inRun: 212, would: 203, refused: 4, notChecked: 5 });
    for (const r of t.rows) expect(r.would + r.refused + r.notChecked).toBe(r.inRun);
  });
  it('the rest of a sample of updates is said as left out', () => {
    expect(t.leftOut).toEqual([{ obj: 'Contact', n: 150, op: 'Update' }]);
  });
  it('the run sends the updates, counts them in the headline and keeps them in History', () => {
    expect(RC).toContain("const r = await reconcileOverwrite(j.prof, j.obj, j.ids, j.rows, srcSess, tgtSess, _dupFields, { probe: true });");
    expect(RC).toContain('probe: { byObj: probeAgg, updates: probeUpd, ...probeTotals, skipped: probeSkipped }');
    expect(RC).toContain("await _recLogRefused(log, { [j.obj]: { failedSourceIds: r.failedRecords } }, true, tgtSess, 'Update');");
    expect(RC).toContain('<span class="ds-refuse-op">');
    expect(RC).not.toContain('update(s) of changed records');   // no longer "not checked"
  });
});
