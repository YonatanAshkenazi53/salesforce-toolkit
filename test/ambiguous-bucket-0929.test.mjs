// Campaign 3 phase 5 — ambiguous keys as a bucket.
//
// Before: two source records with the same key → one paired arbitrarily
// ("changed"), the other in no bucket, plus a warning. Now each key is
// decided on its own (sftkScanKeyClasses): held once → matched as before;
// copies with no counterpart → ordinary inserts / in-target-only rows; held
// more than once where both orgs have it → ⚠ Ambiguous, with the candidate
// target records, never guessed and never deployed until the user chooses
// (📌 pair = match memory, ➕ insert as new = memory value SFTK_MEM_NEW).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(root, f), 'utf8');
const classes = extractFunction('sftk-matching.js', 'sftkScanKeyClasses');
const accuracy = extractFunction('sftk-matching.js', 'sftkScanAccuracy');
const M = o => new Map(Object.entries(o));

describe('sftkScanKeyClasses — one decision per key', () => {
  it('held once (or once on one side) → pair; copies with no counterpart → insertAll / extraAll; both sides and duplicated → ambiguous', () => {
    const c = classes(M({ a: 1, b: 1, twinsNew: 2, amb1: 2, amb2: 1 }), M({ a: 1, c: 1, twinsOld: 3, amb1: 1, amb2: 2 }));
    expect(Object.fromEntries(c)).toEqual({ a: 'pair', b: 'pair', c: 'pair', twinsNew: 'insertAll', twinsOld: 'extraAll', amb1: 'ambiguous', amb2: 'ambiguous' });
  });
  it('the CX fixture: two "SFTK CX Duplicate Name" accounts in the source, one in the target → ambiguous', () => {
    expect(classes(M({ 'sftk cx duplicate name': 2 }), M({ 'sftk cx duplicate name': 1 })).get('sftk cx duplicate name')).toBe('ambiguous');
  });
});

describe('sftkScanAccuracy reads the ⚠ Ambiguous bucket', () => {
  it('ambiguous copies and their candidate targets are the uncertain part, and extend the total', () => {
    // 1 matched pair (2 rows) + 2 ambiguous source copies sharing 1 candidate target (3 rows) → 2 of 5 certain
    const acc = accuracy({ identical: [1], changed: [], missingInTarget: [], onlyInTarget: [],
      ambiguous: [{ sourceId: 'S1', candidates: ['T9'] }, { sourceId: 'S2', candidates: ['T9'] }],
      dupKeys: { rows: 3 } });
    expect(acc.pct).toBe(40);
    expect(acc.dup).toBe(3);
    expect(acc.total).toBe(5);
  });
  it('a scan with an EMPTY ambiguous bucket is fully certain even if dupKeys lists twins that went in as ordinary inserts', () => {
    expect(accuracy({ identical: [1], changed: [], missingInTarget: [2, 3], onlyInTarget: [], ambiguous: [], dupKeys: { rows: 2 } }).pct).toBe(100);
  });
});

describe('the scan, the Deploy page and the ring are wired to the bucket', () => {
  const SC = read('studio-scan.js'), DV = read('studio-deploy.js'), RG = read('studio-ring.js'), MT = read('sftk-matching.js');
  it('the scan groups by key, classifies, and lists ambiguous copies with their candidates — no more "last copy wins"', () => {
    expect(SC).toContain("const _keyClass = sftkScanKeyClasses(new Map([..._sGrp].map(([k, a]) => [k, a.length])), new Map([..._tGrp].map(([k, a]) => [k, a.length])));");
    expect(SC).toContain("const row = { ..._srcRow(k, sr), candidates: tgts.map(t => t.Id) };");
    expect(SC).toContain('ambiguous:     ambiguous.slice(0, BUCKET_CAP),');
    expect(SC).not.toContain('if (scope && _dupKeys.has(k)) continue;');
    expect(SC).toContain("for (const [k, sr] of _twinsNew) missingInTarget.push({ ..._srcRow(k, sr), dupKey: true });");
  });
  it('"insert as new" is a match-memory value: out of key matching, straight into Insert', () => {
    expect(MT).toContain("const SFTK_MEM_NEW = '__insert_as_new__';");
    expect(SC).toContain('if (tgtId === SFTK_MEM_NEW) { if (!memPairedSrc.has(sr.Id)) { memPairedSrc.add(sr.Id); forcedNew.push(sr); } continue; }');
    expect(SC).toContain("for (const sr of forcedNew) missingInTarget.push({ ..._srcRow(sftkMatchKey(sr, srcMatching) || '(insert as new)', sr), forcedNew: true });");
  });
  it('Deploy: a ⚠ Ambiguous tab after Synced, a plan column, pair / insert-as-new buttons that remember and rescan', () => {
    expect(DV).toContain("{ k: 'amb',  bucket: 'ambiguous',       label: '⚠ Needs a decision',");   // renamed 2026-10-03 — the bucket key stays 'ambiguous'
    expect(DV.indexOf("label: '⚠ Needs a decision'")).toBeGreaterThan(DV.indexOf("label: '🟢 Synced'"));
    expect(DV).toContain("${cell(r, 'same')}${cell(r, 'amb')}");
    expect(DV).toContain('data-dep-amb-sel="${esc(r.sourceId)}"');   // 2026-10-03: one select per record instead of a row of pin links
    expect(DV).toContain("const learn = recs.filter(r => ambPick(r)).map(r => [r.sourceId, ambPick(r) === '__new__' ? SFTK_MEM_NEW : ambPick(r)]);");   // pairs and \"new\" in one remembered batch
    expect(DV).toContain('if (learn.length) await window.sftkLearnPairs?.(p.id, p.targetOrg, learn);');
    expect(DV).toContain('await _depRescan(p);');
  });
  it('the ring cell counts ambiguous rows as not in sync and shows ⚠N', () => {
    expect(RG).toContain('const drift = (s.missing || 0) + (s.changed || 0) + (s.extra || 0) + (s.ambiguous || 0);');
    expect(RG).toContain('<b class="ds-ring-a">⚠${s.ambiguous}</b>');
    expect((RG.match(/ambiguous: \([\w.]+\.ambiguous \|\| \[\]\)\.length,/g) || []).length).toBeGreaterThanOrEqual(2);   // the native lastScan summary + the 🔎 scan deposit (⚖ no longer scans)
  });
});
