// Per-field before/after in the History JSON export (user 2026-11-07: "ומה עם מה שהבחור מרדיט אמר? משהו עם לפני
// ואחרי" — promised on r/salesforce 2026-11-03 to Muted_Jellyfish_6784). The overwrite reads the target's values
// of the written fields just before the write; each updated record keeps { field: { before, after } } for the
// fields that changed; the export lists them flat; counts-only mode keeps none.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const H = extractFunctions('studio-history.js', ['sftkFieldChanges', 'histFieldChanges', 'histExportPayload', 'histRunTotals', 'histRecordDetailNote']);

describe('one record', () => {
  it('only the fields that changed; null and "" are the same nothing', () => {
    expect(H.sftkFieldChanges({ Id: '1', Phone: '1', Website: null, Name: 'A' }, { Id: '1', Phone: '2', Website: '', Name: 'A', attributes: {} }))
      .toEqual({ Phone: { before: '1', after: '2' } });
  });
  it('a field the PII policy covers keeps no before (the target\'s raw data), only the masked value written', () => {
    const c = H.sftkFieldChanges({ Email: 'dana@acme.com' }, { Email: 'x9f@masked.invalid' }, new Set(['Email']));
    expect(c.Email.before).toBeNull();
    expect(c.Email.after).toBe('x9f@masked.invalid');
    expect(c.Email.beforeHidden).toMatch(/PII policy/);
  });
  it('a before that could not be read is said, never guessed', () => {
    expect(H.sftkFieldChanges(undefined, { Id: '1', Phone: '2' })).toEqual({ Phone: { before: null, beforeUnread: true, after: '2' } });
  });
});

describe('the export', () => {
  const run = { id: 'r1', kind: 'transfer', summary: { Account: { updated: 1, targetRecords: [
    { id: '001A', label: 'Acme', changes: { Phone: { before: '555-1', after: '555-2' }, Description: { before: null, after: 'new' } } },
    { id: '001B', label: 'Beta' },
  ] }, Contact: { updated: 1, targetRecords: [{ id: '003C', label: 'Dana', changes: { Email: { before: null, beforeHidden: 'the PII policy covers this field — its value before the run is not kept', after: 'm@x' } } }] } } };
  it('every changed field of every updated record, flat, with object, record and field', () => {
    expect(H.histFieldChanges(run)).toEqual([
      { object: 'Account', id: '001A', label: 'Acme', field: 'Phone', before: '555-1', after: '555-2' },
      { object: 'Account', id: '001A', label: 'Acme', field: 'Description', before: null, after: 'new' },
      { object: 'Contact', id: '003C', label: 'Dana', field: 'Email', before: null, after: 'm@x', beforeHidden: 'the PII policy covers this field — its value before the run is not kept' },
    ]);
  });
  it('histExportPayload carries fieldChanges per run and says what it holds; counts-only: none', () => {
    const p = H.histExportPayload([run], { historyDays: 30 }, { nowIso: '2026-11-08T00:00:00Z' });
    expect(p.runs[0].fieldChanges).toHaveLength(3);
    expect(p.note).toMatch(/fieldChanges lists, per run, every field an update changed/);
    const q = H.histExportPayload([run], { historyDays: 30, countsOnly: true }, { nowIso: '2026-11-08T00:00:00Z' });
    expect(q.runs[0].fieldChanges).toEqual([]);
    expect(q.note).toMatch(/fieldChanges is empty: counts-only mode keeps no values/);
  });
});

describe('the write keeps them', () => {
  it('the target is read just before the overwrite (first 200, not in counts-only mode) and each updated record keeps its changes', () => {
    expect(RC).toContain("const keepValues = !(typeof _settings !== 'undefined' && _settings && _settings.countsOnly);");
    expect(RC).toContain('const ids = payloads.map(x => x.Id).filter(Boolean).slice(0, 200);');
    expect(RC).toContain('updatedRecords.push(keepValues ? { ...rowMeta[i], changes: sftkFieldChanges(beforeById.get(payloads[i].Id), payloads[i], piiTgtFields) } : rowMeta[i]);');
    expect(RC).toContain('piiTgtFields.add(tf);');
  });
});
