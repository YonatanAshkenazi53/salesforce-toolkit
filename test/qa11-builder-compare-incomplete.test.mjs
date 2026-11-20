// QA 1.1 finding 54 — Org Compare counted a partial read (SF_QUERY_ALL's `incomplete`, no error) as real drift.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const SRC = readFileSync(new URL('../studio-compare.js', import.meta.url), 'utf8');
const slice = name => {
  const start = SRC.search(new RegExp(`(?:async )?function ${name}\\(`));
  if (start < 0) throw new Error('not found: ' + name);
  return SRC.slice(start, SRC.indexOf('\n}\n', start) + 3);
};
const build = sendBg => new Function('sendBg', '_orgCompareState',
  slice('sftkOcMatchPct') + slice('sftkOcIncompleteMsg') + slice('sftkOcCountByKey') + slice('_ocCompareOneObject') +
  ' return { one: _ocCompareOneObject, msg: sftkOcIncompleteMsg };'
)(sendBg, { matchStrategy: 'auto', customMatchField: '' });

const S = { orgUrl: 'https://src.example', sid: 'x' }, T = { orgUrl: 'https://tgt.example', sid: 'y' };
const DESC = { queryable: true, fields: [{ name: 'Id' }, { name: 'Name', nameField: true }] };
const rows = n => Array.from({ length: n }, (_, i) => ({ Id: 'r' + i, Name: 'Contact ' + i }));
const mock = (src, tgt) => async msg => msg.type === 'SF_REST_GET' ? DESC : (msg.orgUrl === S.orgUrl ? src : tgt);

describe('a read that came back short is not compared', () => {
  it('the source short of what Salesforce announced: an error that names the side and both counts — no drift numbers', async () => {
    const { one } = build(mock({ records: rows(3), incomplete: { expected: 5, got: 3 } }, { records: rows(5) }));
    const r = await one('Contact', S, T);
    expect(r).toEqual({ error: 'source: the read came back incomplete (Salesforce says 5 record(s), 3 arrived) — not compared. Run the compare again.' });
    expect(r.extras).toBeUndefined(); expect(r.missing).toBeUndefined(); expect(r.matchPct).toBeUndefined();
  });
  it('the target short: the same, named as the target', async () => {
    const { one } = build(mock({ records: rows(5) }, { records: rows(2), incomplete: { expected: 5, got: 2 } }));
    const r = await one('Contact', S, T);
    expect(r.error).toBe('target: the read came back incomplete (Salesforce says 5 record(s), 2 arrived) — not compared. Run the compare again.');
    expect(r.missing).toBeUndefined();
  });
  it('two complete reads are compared as before', async () => {
    const { one } = build(mock({ records: rows(5) }, { records: rows(5) }));
    const r = await one('Contact', S, T);
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ srcCount: 5, tgtCount: 5, matched: 5, missing: 0, extras: 0, matchPct: 100 });
  });
  it('a real error still wins over the note about the other side', async () => {
    const { one } = build(mock({ error: 'INVALID_SESSION_ID' }, { records: rows(2), incomplete: { expected: 5, got: 2 } }));
    expect((await one('Contact', S, T)).error).toBe('source: INVALID_SESSION_ID');
  });
  it('a complete read has nothing to say', () => {
    const { msg } = build(async () => ({}));
    expect(msg('source', { records: [] })).toBe('');
    expect(msg('source', null)).toBe('');
  });
});
