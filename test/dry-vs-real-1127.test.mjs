// 2026-11-26/27, the owner, twice: "how can we make sure dry run works the same as full deployment".
// A one-off live proof existed (scripts/dev/live/dryrun-parity.mjs); this is the same comparison in the product:
// ▶ Deploy on the very selection a finished dry run checked is compared with it, per object and operation.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunction } from './extract.mjs';
const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const cmp = extractFunction('studio-reconcile.js', 'sftkDryVsReal');
const dry = (byObj, updates, summary) => ({ probe: { byObj, updates: updates || {} }, summary: summary || {} });

describe('the run against the dry run of the same selection', () => {
  it('the packaged tree as it ran live on 2026-11-26: every row agrees', () => {
    const d = dry({ Parent: { probed: 4, wouldWrite: 3, refused: 1 }, Child: { probed: 2, wouldWrite: 0, refused: 2 } },
      { Parent: { probed: 1, wouldWrite: 0, refused: 1 }, Child: { probed: 4, wouldWrite: 4, refused: 0 } },
      { Parent: { failedSourceIds: [{ id: 'P4', error: 'dup' }] }, Child: { failedSourceIds: [{ id: 'C1', error: 'vr' }, { id: 'C2', error: 'flow' }] } });
    const r = { summary: { Parent: { inserted: 3, insertedFailed: 1, updated: 0, updatedFailed: 1, failedSourceIds: [{ id: 'P4', error: 'dup' }] },
      Child: { inserted: 0, insertedFailed: 2, overwritten: 4, overwrittenFailed: 0, failedSourceIds: ['C2', 'C1'] } } };
    const out = cmp(d, r);
    expect(out.same).toBe(true);
    expect(out.rows.map(x => [x.obj, x.op, x.dryW, x.dryR, x.realW, x.realR, x.same])).toEqual([
      ['Parent', 'Insert', 3, 1, 3, 1, true], ['Parent', 'Update', 0, 1, 0, 1, true], ['Child', 'Insert', 0, 2, 0, 2, true], ['Child', 'Update', 4, 0, 4, 0, true]]);
    expect(out.lines[0]).toEqual({ ok: true, text: 'Parent · Insert: as the dry run said — 3 written, 1 refused' });
  });
  it('the real run refused more (a duplicate inside the run): the row differs and names the records and the reason', () => {
    const out = cmp(dry({ Account: { probed: 5, wouldWrite: 5, refused: 0 } }), { summary: { Account: { inserted: 3, insertedFailed: 2, failedSourceIds: [{ id: 'A4', label: 'Acme', error: 'Use one of these records? [DUPLICATES_DETECTED]' }, { id: 'A5', label: 'Acme 2', error: 'dup' }] } } });
    expect(out.same).toBe(false);
    expect(out.lines[0].ok).toBe(false);
    expect(out.lines[0].text).toBe('Account · Insert: the dry run said 5 would be written and 0 refused; this run wrote 3 and refused 2. Refused now and not in the dry run: Acme (Use one of these records? [DUPLICATES_DETECTED]) · Acme 2 (dup).');
  });
  it('the children of a refused parent agree whether the real run counts them as refused or not', () => {
    const d = dry({ Account: { probed: 1, wouldWrite: 0, refused: 1 }, Contact: { probed: 3, wouldWrite: 0, refused: 0, cascade: 3 } }, {}, { Account: { failedSourceIds: [{ id: 'A1' }] } });
    expect(cmp(d, { summary: { Account: { inserted: 0, insertedFailed: 1, failedSourceIds: ['A1'] }, Contact: { inserted: 0, insertedFailed: 0 } } }).same).toBe(true);
    expect(cmp(d, { summary: { Account: { inserted: 0, insertedFailed: 1, failedSourceIds: ['A1'] }, Contact: { inserted: 0, insertedFailed: 3, failedSourceIds: ['C1', 'C2', 'C3'] } } }).same).toBe(true);
    expect(cmp(d, { summary: { Account: { inserted: 0, insertedFailed: 1, failedSourceIds: ['A1'] }, Contact: { inserted: 2, insertedFailed: 0 } } }).same).toBe(false);
  });
  it('a dry run that did not check every record is never read as agreeing', () => {
    const out = cmp(dry({ Account: { probed: 5000, wouldWrite: 5000, refused: 0, sampledOf: 5010 } }), { summary: { Account: { inserted: 5000, insertedFailed: 0 } } });
    expect(out.rows[0]).toMatchObject({ partial: true, same: false });
    expect(out.lines[0].text).toContain('The dry run did not check every selected record');
    expect(cmp(dry({}, { Contact: { probed: 10, wouldWrite: 10, refused: 0, unchecked: 5 } }), { summary: { Contact: { overwritten: 10 } } }).same).toBe(false);
  });
  it('nothing to compare is not "the same"', () => { expect(cmp(dry({}), { summary: {} })).toEqual({ rows: [], lines: [], same: false }); });
});

describe('the wiring', () => {
  it('only the finished dry run of this very selection is compared, and never a stopped run', () => {
    expect(RC).toContain("&& window._sftkProbeLast.key === sftkProbeSelKey(profile.id, _recSel, _recChildSel)) ? window._sftkProbeLast.id : null;");
    expect(RC).toContain("window._sftkProbeLast && window._sftkProbeLast.id && !window._sftkProbeLast.incomplete");
    expect(RC).toContain("window._sftkProbeLast = { id: runId, key: sftkProbeSelKey(profile.id, _recSel, _recChildSel), status: runStatus,");
    expect(RC).toContain("if (de && re && re.id === runId && !stoppedWhy) {");
  });
  it('the result is kept on the run in History and said in the log; it cannot fail the run', () => {
    expect(RC).toContain("re.dryCompare = { dryRunId: _dryBefore, dryRunAt: de.completedAt, same: dryCmp.same, rows: dryCmp.rows };");
    expect(RC).toContain("for (const l of dryCmp.lines) log(l.ok ? '✓' : '✗', l.text, l.ok ? '' : 'ds-prog-warn');");
    expect(RC).toContain("} catch (_) { dryCmp = null; /* a comparison never fails a run */ }");
  });
});
