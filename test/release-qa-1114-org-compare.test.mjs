import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Release QA 2026-11-14: Org Compare collapsed records that share a Name (and
// dropped blank Names), so a target with fewer records read 100% clean; and a
// describe that returned {error} silently fell back to an Id compare across orgs.
const SRC = readFileSync(new URL('../studio-compare.js', import.meta.url), 'utf8');
const slice = name => {
  const re = new RegExp(`(?:async )?function ${name}\\(`);
  const start = SRC.search(re);
  if (start < 0) throw new Error('not found: ' + name);
  return SRC.slice(start, SRC.indexOf('\n}\n', start) + 3);
};
const build = sendBg => new Function('sendBg', '_orgCompareState',
  slice('sftkOcMatchPct') + slice('sftkOcIncompleteMsg') + slice('sftkOcCountByKey') + slice('_ocCompareOneObject') +
  ' return { count: sftkOcCountByKey, one: _ocCompareOneObject };'
)(sendBg, { matchStrategy: 'auto', customMatchField: '' });

const SESS_S = { orgUrl: 'https://src.example', sid: 'x' };
const SESS_T = { orgUrl: 'https://tgt.example', sid: 'y' };
const mock = ({ describe, src, tgt }) => async msg => {
  if (msg.type === 'SF_REST_GET') return describe;
  return { records: msg.orgUrl === SESS_S.orgUrl ? src : tgt };
};
const DESC = { queryable: true, fields: [{ name: 'Id' }, { name: 'Name', nameField: true }] };

describe('Org Compare counts records, not distinct keys', () => {
  it('three source John Smiths and a blank Name against one target John Smith is drift, not 100%', async () => {
    const src = [{ Id: 'a', Name: 'John Smith' }, { Id: 'b', Name: 'John Smith' },
      { Id: 'c', Name: 'John Smith' }, { Id: 'd', Name: null }];
    const tgt = [{ Id: 'z', Name: 'John Smith' }];
    const { one } = build(mock({ describe: DESC, src, tgt }));
    const r = await one('Contact', SESS_S, SESS_T);
    expect(r.srcCount).toBe(4);
    expect(r.tgtCount).toBe(1);
    expect(r.matched).toBe(1);
    // 2026-11-15: this pinned the blank Name as a 3rd "missing" record (25%).
    // A blank key cannot be matched, so nothing is known about it: it is
    // reported on its own (srcBlank + the note) and stays out of missing and
    // of the percentage. The two surplus John Smiths are still drift.
    expect(r.missing).toBe(2);
    expect(r.srcBlank).toBe(1);
    expect(r.extras).toBe(0);
    expect(r.matchPct).toBe(33);
    expect(r.matchField).toBe('Name');
    expect(r.note).toMatch(/shared by more than one record/);
    expect(r.note).toMatch(/blank Name/);
  });

  it('identical orgs with unique names stay 100% with no note', () => {
    const { count } = build(async () => ({}));
    const recs = [{ Name: 'A' }, { Name: 'B' }];
    const r = count(recs, recs.slice(), 'Name');
    expect(r).toMatchObject({ srcCount: 2, tgtCount: 2, matched: 2, missing: 0, extras: 0, matchPct: 100, note: '' });
  });

  it('surplus duplicates in the target are only-in-target; a blank target key is counted on its own', () => {
    const { count } = build(async () => ({}));
    const r = count([{ Name: 'A' }], [{ Name: 'A' }, { Name: 'A' }, { Name: '' }, { Name: 'B' }, { Name: 'B' }], 'Name');
    expect(r.matched).toBe(1);
    expect(r.missing).toBe(0);
    // 2026-11-15: was 4 — the blank-key record was asserted as only-in-target.
    expect(r.extras).toBe(3);
    expect(r.dupKeys).toBe(2);
    expect(r.tgtBlank).toBe(1);
  });

  it('the CSV detail column carries the note', () => {
    expect(SRC).toContain("(r.skipped ? (r.reason || 'Skipped.') : (r.note || ''))");
  });
});

describe('Org Compare: a failed describe is an error row, not an Id compare', () => {
  it('describe returning {error} gives an error', async () => {
    const { one } = build(mock({ describe: { error: 'Session expired or invalid' }, src: [{ Id: 'a' }], tgt: [{ Id: 'b' }] }));
    const r = await one('Contact', SESS_S, SESS_T);
    expect(r.error).toMatch(/describe: Session expired or invalid/);
    expect(r.matchPct).toBeUndefined();
  });
  it('describe throwing gives an error', async () => {
    const { one } = build(async msg => {
      if (msg.type === 'SF_REST_GET') throw new Error('network down');
      return { records: [] };
    });
    const r = await one('Contact', SESS_S, SESS_T);
    expect(r.error).toMatch(/network down/);
  });
  it('a non-queryable describe is still a skip', async () => {
    const { one } = build(mock({ describe: { queryable: false, fields: [] }, src: [], tgt: [] }));
    expect(await one('FooShare', SESS_S, SESS_T)).toMatchObject({ skipped: true });
  });
});
