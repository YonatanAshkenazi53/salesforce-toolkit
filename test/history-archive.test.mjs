// 📦 History archive (user 2026-08-11: "auto download, and auto display it
// from PC storage. we can hit limits there very fast") — two tiers: the
// newest 100 runs stay hot in chrome.storage (~10MB quota shared with
// everything else the toolkit persists); overflow runs move to IndexedDB
// (on-PC, GB-scale, no permission) instead of being DELETED, and the History
// view reads them back on demand. The IndexedDB calls themselves can't run
// under node — the split logic is behavioral, the wiring is source-guarded.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunctions } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcOf = f => readFileSync(join(root, f), 'utf8');
const codeOnly = s => s.replace(/^\s*\/\/.*$/gm, '');

describe('sftkHistorySplit — hot tier keeps the NEWEST, overflow is the oldest', () => {
  const { sftkHistorySplit } = extractFunctions('sftk-archive.js', ['sftkHistorySplit']);
  const runs = n => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, startedAt: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}` }));

  it('under the cap nothing overflows', () => {
    const { keep, overflow } = sftkHistorySplit(runs(100), 100);
    expect(keep).toHaveLength(100);
    expect(overflow).toHaveLength(0);
  });

  it('over the cap the OLDEST (front of the append-ordered list) overflow', () => {
    const list = runs(103);
    const { keep, overflow } = sftkHistorySplit(list, 100);
    expect(keep).toHaveLength(100);
    expect(overflow.map(r => r.id)).toEqual(['r0', 'r1', 'r2']);
    expect(keep[0].id).toBe('r3');
    expect(keep[99].id).toBe('r102');
  });

  it('degrades safely: junk input, bad caps', () => {
    expect(sftkHistorySplit(null, 100)).toEqual({ keep: [], overflow: [] });
    expect(sftkHistorySplit(runs(5), 0).keep).toHaveLength(5);      // 0 → default 100
    expect(sftkHistorySplit(runs(5), -3).keep).toHaveLength(5);
  });
});

describe('storageSaveHistory — two tiers, quota spill, counts-only on BOTH', () => {
  const src = codeOnly(srcOf('studio-core.js'));

  it('overflow routes through sftkHistorySplit into sftkArchPut, stripped first', () => {
    expect(src).toMatch(/sftkHistorySplit\(_history,\s*100\)/);
    expect(src).toMatch(/_historyStripCountsOnly\(split\.overflow\)/);
    expect(src).toMatch(/sftkArchPut\(split\.overflow\)/);
  });

  it('a quota failure spills the older half and retries ONCE — never a silent loss', () => {
    expect(src).toMatch(/const spill = _history\.slice\(0, Math\.ceil\(_history\.length \/ 2\)\)/);
    expect(src).toMatch(/moved to the on-PC archive/);
    expect(src).toMatch(/History could not be saved/);
  });

  it('retention DELETES from the archive too — it must never become a hidden copy', () => {
    expect(src).toMatch(/sftkArchDeleteOlderThan\(new Date\(cutoff\)\.toISOString\(\)\)/);
  });
});

describe('archive plumbing — schema, view, and clear paths', () => {
  const arch = codeOnly(srcOf('sftk-archive.js'));
  const hist = codeOnly(srcOf('studio-history.js'));
  const html = srcOf('studio.html');

  it('IndexedDB store keys by run id with a startedAt index; delete-older is exclusive', () => {
    expect(arch).toMatch(/createObjectStore\('runs', \{ keyPath: 'id' \}\)/);
    expect(arch).toMatch(/createIndex\('startedAt', 'startedAt'\)/);
    expect(arch).toMatch(/IDBKeyRange\.upperBound\(cutoffIso, true\)/);
  });

  it('sftk-archive.js loads in studio.html BEFORE studio-core.js (save path calls it)', () => {
    const a = html.indexOf('<script src="sftk-archive.js">');
    const c = html.indexOf('<script src="studio-core.js">');
    expect(a).toBeGreaterThan(-1);
    expect(c).toBeGreaterThan(-1);
    expect(a).toBeLessThan(c);
  });

  it('the History view auto-displays the archive: bar + load-older + full export', () => {
    expect(hist).toMatch(/dsArchBar/);
    expect(hist).toMatch(/sftkArchCount/);
    expect(hist).toMatch(/sftkArchList\(oldest, 50\)/);
    // Full export walks the WHOLE archive in one cursor pass — no pagination
    // seams that could drop same-second entries between pages.
    expect(hist).toMatch(/sftkArchList\(null, 1e9\)/);
    // Archived cards are labeled — a run from the archive must not
    // impersonate a hot one.
    expect(hist).toMatch(/📦 archived/);
  });

  it('both clear paths clear the archive (🗑 Clear All and 🧹 Clear cached)', () => {
    const clears = hist.match(/sftkArchClear\(\)/g) || [];
    expect(clears.length).toBeGreaterThanOrEqual(2);
  });
});
