// E2 — exportable audit reports from run history (studio-history.js).
// The pure helpers turn a history entry into files a change-management
// process can consume a quarter later: RFC-4180 CSV with spreadsheet
// formula-injection guarding, per-record outcome rows with T11b field/value
// context, and honest notes whenever record-level detail is unavailable
// (counts-only mode, the 200-per-object storage cap) instead of silence.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

// All helpers in ONE scope — histRunToCsvRows → histFieldContext /
// histRunTotals / histRecordDetailNote, histCsvSerialize → histCsvEscape.
const {
  histCsvEscape, histCsvSerialize, histFieldContext, histRunTotals,
  histRecordDetailNote, histRunToCsvRows, histHistoryCsvRows,
  histExportPayload, histExportFilename,
} = extractFunctions('studio-history.js', [
  'histCsvEscape', 'histCsvSerialize', 'histFieldContext', 'histRunTotals',
  'histRecordDetailNote', 'histRunToCsvRows', 'histHistoryCsvRows',
  'histExportPayload', 'histExportFilename',
]);

// ── Fixtures ────────────────────────────────────────────────────

// A transfer run with full record detail, including a T11b failed insert
// carrying the field/value context the engine attached to the error.
const FULL_RUN = {
  id: 'run_1', profileId: 'p1', profileName: 'Accounts to UAT', status: 'partial',
  srcOrgUrl: 'https://src.my.salesforce.com', tgtOrgUrl: 'https://tgt.my.salesforce.com',
  sourceOrg: 'https://src.my.salesforce.com', targetOrg: 'https://tgt.my.salesforce.com',
  startedAt: '2026-07-29T14:03:22.000Z', completedAt: '2026-07-29T14:04:01.000Z',
  summary: {
    Account: {
      created: 2, failed: 2, viaBulk: true,
      targetRecords: [
        { id: '001T00000A', label: 'Acme Corp' },
        { id: '001T00000B', label: 'Beta, Inc.' },          // comma → CSV escaping
      ],
      failedRecords: [
        { id: '001T00000C', label: 'Gamma LLC', error: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: nope' },
      ],
      failedSourceIds: [
        { id: '001S00000D', label: 'Delta Co', error: 'Account: INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: BillingState',
          fields: [{ field: 'BillingState', sent: 'TX' }, { field: 'Phone', absent: true }] },
      ],
    },
  },
  errors: ['Account: INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: BillingState'],
};

// The same run after counts-only mode stripped record detail at write time
// (storageSaveHistory deletes targetRecords/failedRecords/failedSourceIds).
const COUNTS_ONLY_RUN = {
  id: 'run_2', profileName: 'Accounts to UAT', status: 'partial',
  srcOrgUrl: 'https://src.my.salesforce.com', tgtOrgUrl: 'https://tgt.my.salesforce.com',
  startedAt: '2026-07-28T09:00:00.000Z', completedAt: '2026-07-28T09:00:40.000Z',
  summary: { Account: { created: 12, failed: 3 } },
  errors: ['Account: REQUIRED_FIELD_MISSING: [Industry]  (×3)'],
};

const RECONCILE_RUN = {
  id: 'run_3', kind: 'reconcile', profileName: 'Products sync', status: 'success',
  sourceOrg: 'https://src.my.salesforce.com', targetOrg: 'https://tgt.my.salesforce.com',
  startedAt: '2026-07-27T08:00:00.000Z', completedAt: '2026-07-27T08:01:00.000Z',
  summary: {
    Product2: {
      inserted: 4, insertedFailed: 1, updated: 2, updatedFailed: 0, deleted: 1,
      pulled: 3, updatedSource: 1, connectFailed: 2, relinked: 1,
      targetRecords: [{ id: '01tT0000X', label: 'Widget' }],
    },
  },
  errors: [],
};

// ── histCsvEscape ───────────────────────────────────────────────

describe('histCsvEscape — RFC-4180 + formula-injection guard', () => {
  it('passes plain values through untouched', () => {
    expect(histCsvEscape('Acme Corp')).toBe('Acme Corp');
    expect(histCsvEscape(42)).toBe('42');
  });

  it('renders null/undefined as an empty cell', () => {
    expect(histCsvEscape(null)).toBe('');
    expect(histCsvEscape(undefined)).toBe('');
  });

  it('quotes cells containing commas', () => {
    expect(histCsvEscape('Beta, Inc.')).toBe('"Beta, Inc."');
  });

  it('doubles embedded quotes and wraps the cell', () => {
    expect(histCsvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes cells containing newlines (LF and CRLF)', () => {
    expect(histCsvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(histCsvEscape('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it("prefixes ' to leading = + - @ so spreadsheets read text, not formulas", () => {
    expect(histCsvEscape('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(histCsvEscape('+1234')).toBe("'+1234");
    expect(histCsvEscape('-5')).toBe("'-5");
    expect(histCsvEscape('@cmd')).toBe("'@cmd");
    expect(histCsvEscape('\tX')).toBe("'\tX");
  });

  it('guards AND quotes when a formula-leading cell also needs RFC-4180 escaping', () => {
    // Quoting alone does not stop Excel — the apostrophe must survive inside the quotes.
    expect(histCsvEscape('=HYPERLINK("http://evil"),x')).toBe('"\'=HYPERLINK(""http://evil""),x"');
  });

  it('does not touch = + - @ that are not in the leading position', () => {
    expect(histCsvEscape('a=b')).toBe('a=b');
  });
});

// ── histCsvSerialize ────────────────────────────────────────────

describe('histCsvSerialize', () => {
  it('emits header + rows CRLF-separated with a trailing CRLF, escaping every cell', () => {
    const csv = histCsvSerialize(['a', 'b'], [['1', 'x,y'], ['=2', 'plain']]);
    expect(csv).toBe('a,b\r\n1,"x,y"\r\n\'=2,plain\r\n');
  });

  it('a header-only CSV is still well-formed', () => {
    expect(histCsvSerialize(['only'], [])).toBe('only\r\n');
  });
});

// ── histFieldContext (T11b) ─────────────────────────────────────

describe('histFieldContext — T11b field/value context', () => {
  it('renders sent values and absent fields, joined with ;', () => {
    expect(histFieldContext([
      { field: 'BillingState', sent: 'TX' },
      { field: 'Phone', absent: true },
      { field: 'Fax', sent: null },
    ])).toBe('BillingState=TX; Phone (not sent); Fax (not sent)');
  });

  it('returns empty string for missing/empty/garbage input', () => {
    expect(histFieldContext(null)).toBe('');
    expect(histFieldContext([])).toBe('');
    expect(histFieldContext([{}, null])).toBe('');
  });
});

// ── histRunTotals ───────────────────────────────────────────────

describe('histRunTotals — both summary shapes', () => {
  it('sums the transfer shape (created/failed) and flags bulk', () => {
    const t = histRunTotals(FULL_RUN);
    expect(t.created).toBe(2);
    expect(t.failed).toBe(2);
    expect(t.viaBulk).toBe(true);
  });

  it('sums the reconcile shape including per-DML failures and relinks', () => {
    const t = histRunTotals(RECONCILE_RUN);
    expect(t.created).toBe(4);                 // inserted
    expect(t.updated).toBe(2 + 1 + 1);         // updated + updatedSource + relinked
    expect(t.deleted).toBe(1);
    expect(t.pulled).toBe(3);
    expect(t.failed).toBe(1 + 2);              // insertedFailed + connectFailed
    expect(t.viaBulk).toBe(false);
  });

  it('tolerates empty/missing summaries', () => {
    expect(histRunTotals({}).created).toBe(0);
    expect(histRunTotals(null).failed).toBe(0);
  });
});

// ── histRecordDetailNote ────────────────────────────────────────

describe('histRecordDetailNote — why record rows are missing', () => {
  it('null when record arrays exist', () => {
    expect(histRecordDetailNote(FULL_RUN, false)).toBeNull();
  });

  it('null when there was no activity to detail', () => {
    expect(histRecordDetailNote({ summary: { Account: { created: 0, failed: 0 } } }, true)).toBeNull();
  });

  it('names counts-only mode as the reason when it is on', () => {
    const note = histRecordDetailNote(COUNTS_ONLY_RUN, true);
    expect(note).toMatch(/counts-only mode/i);
    expect(note).toMatch(/write time/i);
  });

  it('still explains missing detail honestly when counts-only is currently off', () => {
    const note = histRecordDetailNote(COUNTS_ONLY_RUN, false);
    expect(note).toMatch(/no per-record detail was stored/i);
  });
});

// ── histRunToCsvRows ────────────────────────────────────────────

describe('histRunToCsvRows — one row per record outcome', () => {
  const opts = { countsOnly: false, sourceLabel: 'Dev', targetLabel: 'UAT' };
  const { header, rows } = histRunToCsvRows(FULL_RUN, opts);
  const col = name => header.indexOf(name);
  const byOutcome = o => rows.filter(r => r[col('outcome')] === o);

  it('carries run metadata on every row (id, orgs, labels, timestamps, flags)', () => {
    for (const r of rows) {
      expect(r[col('run_id')]).toBe('run_1');
      expect(r[col('source_org_url')]).toBe('https://src.my.salesforce.com');
      expect(r[col('source_org_label')]).toBe('Dev');
      expect(r[col('target_org_label')]).toBe('UAT');
      expect(r[col('started_at')]).toBe('2026-07-29T14:03:22.000Z');
      expect(r[col('dry_run')]).toBe('false');
      expect(r[col('kind')]).toBe('transfer');
      expect(r.length).toBe(header.length);
    }
  });

  it('emits written / failed-update / failed-insert rows from the stored record arrays', () => {
    expect(byOutcome('written').map(r => r[col('record_id')])).toEqual(['001T00000A', '001T00000B']);
    expect(byOutcome('failed-update')[0][col('error')]).toMatch(/FIELD_CUSTOM_VALIDATION_EXCEPTION/);
    expect(byOutcome('failed-insert')[0][col('record_id')]).toBe('001S00000D');
  });

  it('failed-insert rows carry the T11b field/value context', () => {
    const fi = byOutcome('failed-insert')[0];
    expect(fi[col('field_context')]).toBe('BillingState=TX; Phone (not sent)');
    expect(fi[col('error')]).toMatch(/RESTRICTED_PICKLIST/);
  });

  it('flags via_bulk on rows for a bulk-written object', () => {
    expect(byOutcome('written')[0][col('via_bulk')]).toBe('true');
  });

  it('counts-only entries get an explicit summary-only row per object — never a silently empty file', () => {
    const res = histRunToCsvRows(COUNTS_ONLY_RUN, { countsOnly: true });
    const so = res.rows.filter(r => r[res.header.indexOf('outcome')] === 'summary-only');
    expect(so.length).toBe(1);
    const note = so[0][res.header.indexOf('note')];
    expect(note).toMatch(/12 created/);
    expect(note).toMatch(/3 failed/);
    expect(note).toMatch(/counts-only mode/);
    // and the notes array says it too, for the export modal
    expect(res.notes.join(' ')).toMatch(/counts-only mode/);
  });

  it('uses the non-counts-only wording when detail is missing but the mode is off', () => {
    const res = histRunToCsvRows(COUNTS_ONLY_RUN, { countsOnly: false });
    const so = res.rows.find(r => r[res.header.indexOf('outcome')] === 'summary-only');
    expect(so[res.header.indexOf('note')]).toMatch(/no per-record detail stored/);
  });

  it('states the 200-per-object storage cap when counts exceed stored detail', () => {
    const capped = {
      id: 'run_c', profileName: 'Big', status: 'partial',
      startedAt: '2026-07-01T00:00:00.000Z',
      summary: { Contact: {
        created: 500, failed: 300,
        targetRecords: Array.from({ length: 200 }, (_, i) => ({ id: `003T${i}`, label: `C${i}` })),
        failedSourceIds: Array.from({ length: 200 }, (_, i) => ({ id: `003S${i}`, error: 'x' })),
      } },
    };
    const res = histRunToCsvRows(capped, {});
    const noteRows = res.rows.filter(r => r[res.header.indexOf('outcome')] === 'note');
    const text = noteRows.map(r => r[res.header.indexOf('note')]).join(' | ');
    expect(text).toMatch(/200 of 500 written/);
    expect(text).toMatch(/200 of 300 failed/);
    expect(res.notes.join(' ')).toMatch(/at most 200 per object/);
  });

  it('a run with no per-object results still produces one honest row', () => {
    const res = histRunToCsvRows({ id: 'run_e', summary: {} }, {});
    expect(res.rows.length).toBe(1);
    expect(res.rows[0][res.header.indexOf('note')]).toMatch(/no per-object results/);
  });
});

// ── histHistoryCsvRows ──────────────────────────────────────────

describe('histHistoryCsvRows — one summary row per run', () => {
  const entries = [FULL_RUN, COUNTS_ONLY_RUN, RECONCILE_RUN];
  const { header, rows } = histHistoryCsvRows(entries, { countsOnly: false });
  const col = name => header.indexOf(name);

  it('emits exactly one row per run with mapped totals', () => {
    expect(rows.length).toBe(3);
    expect(rows[0][col('created')]).toBe(2);
    expect(rows[2][col('created')]).toBe(4);           // reconcile inserted → created
    expect(rows[2][col('kind')]).toBe('reconcile');
    expect(rows[0][col('via_bulk')]).toBe('true');
  });

  it('the record_detail column says when a run has no record-level rows and why', () => {
    expect(rows[1][col('record_detail')]).toMatch(/no per-record detail was stored/i);
    expect(rows[0][col('record_detail')]).toMatch(/stored/);
  });

  it('caps the errors cell at 5 and SAYS how many were omitted', () => {
    const noisy = { id: 'r', summary: {}, errors: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'] };
    const res = histHistoryCsvRows([noisy], {});
    const cell = res.rows[0][res.header.indexOf('errors')];
    expect(cell).toMatch(/e5/);
    expect(cell).not.toMatch(/e6/);
    expect(cell).toMatch(/and 2 more/);
    expect(res.rows[0][res.header.indexOf('error_count')]).toBe(7);
  });
});

// ── histExportPayload ───────────────────────────────────────────

describe('histExportPayload — JSON export with honest retention note', () => {
  const labels = {
    'https://src.my.salesforce.com': 'Dev',
    'https://tgt.my.salesforce.com': 'UAT',
  };

  it('states the retained count and the N-day purge in the note', () => {
    const p = histExportPayload([FULL_RUN, RECONCILE_RUN], { historyDays: 30, countsOnly: false },
      { labels, nowIso: '2026-07-29T15:00:00.000Z' });
    expect(p.runCount).toBe(2);
    expect(p.note).toMatch(/2 run\(s\) currently retained/);
    expect(p.note).toMatch(/older than 30 day\(s\) are purged/);
    expect(p.note).toMatch(/NOT in this file/);
    expect(p.retention).toEqual({ historyDays: 30, countsOnly: false, maxRuns: 100 });
    expect(p.exportedAt).toBe('2026-07-29T15:00:00.000Z');
  });

  it('keep-forever setting still discloses the 100-run cap', () => {
    const p = histExportPayload([FULL_RUN], { historyDays: 0, countsOnly: false }, {});
    expect(p.note).toMatch(/keep forever/);
    expect(p.note).toMatch(/at most the last 100 runs/);
  });

  it('counts-only mode is disclosed in the note and per-run recordDetailNote', () => {
    const p = histExportPayload([COUNTS_ONLY_RUN], { historyDays: 30, countsOnly: true }, {});
    expect(p.note).toMatch(/Counts-only mode is ON/);
    expect(p.runs[0].recordDetailNote).toMatch(/counts-only mode/);
  });

  it('runs carry org labels, explicit dry-run/bulk flags, and totals', () => {
    const p = histExportPayload([FULL_RUN], { historyDays: 30 }, { labels });
    const r = p.runs[0];
    expect(r.sourceOrgLabel).toBe('Dev');
    expect(r.targetOrgLabel).toBe('UAT');
    expect(r.dryRun).toBe(false);            // explicit, not undefined
    expect(r.viaBulk).toBe(true);
    expect(r.totals).toEqual({ created: 2, updated: 0, deleted: 0, pulled: 0, failed: 2, notConfirmedWritten: 0 });
    expect(r.summary.Account.failedSourceIds[0].fields[0]).toEqual({ field: 'BillingState', sent: 'TX' });
    expect(r.recordDetailNote).toBeUndefined();   // detail IS present here
  });

  it('falls back to the org URL when no label is known', () => {
    const p = histExportPayload([FULL_RUN], {}, {});
    expect(p.runs[0].sourceOrgLabel).toBe('https://src.my.salesforce.com');
  });
});

// ── histExportFilename ──────────────────────────────────────────

describe('histExportFilename', () => {
  it('builds sftk-run-<object>-<date>-<time> from the first summary object and startedAt (UTC)', () => {
    expect(histExportFilename(FULL_RUN)).toBe('sftk-run-Account-2026-07-29-140322');
  });

  it('slugs unsafe characters in the object name', () => {
    expect(histExportFilename({ summary: { 'My Obj/2': {} }, startedAt: '2026-01-02T03:04:05.000Z' }))
      .toBe('sftk-run-My_Obj_2-2026-01-02-030405');
  });

  it('falls back to "run" when the entry has no summary', () => {
    expect(histExportFilename({ startedAt: '2026-01-02T03:04:05.000Z' }))
      .toBe('sftk-run-run-2026-01-02-030405');
  });
});
