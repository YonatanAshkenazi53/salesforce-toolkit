// L6 — diff-bucket caps: the four reconcile buckets ship capped at 5,000 rows
// each (linkMismatch at 2,000), and until now every display site printed
// `bucket.length` off the SLICED array. In an enterprise org that means a
// header reading "Insert 5,000" when 47,213 records are missing — a number
// that reads as a total but is a floor, and that then seeds the default
// selection for a write.
//
// The fix has three parts, all tested here:
//
//   1. MEASURE. runDiffScan pages both sides in full (SF_QUERY_ALL follows
//      every nextRecordsUrl), so the true bucket sizes are already in memory
//      one line before the slice. sftkBucketCap records them; no extra query
//      is issued, and a `SELECT COUNT()` would only be a second, weaker
//      source of truth for a number the scan already holds.
//   2. SAY IT. sftkBucketCountLabel / sftkBucketCapTitle / sftkBucketCapNote
//      are the only wording allowed, so no display site can re-word a floor
//      into a total. On a complete scan they collapse to the plain number the
//      UI always showed and emit no banner and no tooltip.
//   3. NEVER WRITE BLIND. sftkCappedWriteNote maps each selected ACTION back
//      to the bucket its ids were picked from, so a run based on a truncated
//      list has to say so before it writes. sftkParentScopeCap covers the
//      indirect case: a child scan scoped to a parent scan that was itself
//      capped never even queried the rows it is silent about.
//
// Backwards compatibility is a real requirement here: profiles persist
// lastScan in chrome.storage, so scans written before L6 arrive with sliced
// arrays and no measured totals. For those, `length >= cap` is the only
// honest signal — the same detection user-copy.js uses — and `total` stays
// null rather than being invented.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunctions } from './extract.mjs';

const root  = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcOf = f => readFileSync(join(root, f), 'utf8');
// Source-level guards read CODE only — the comments in these files quote the
// old buggy expressions on purpose, and a guard that read them would fail on
// the very explanation of the fix.
const codeOnly = s => s.replace(/^\s*\/\/.*$/gm, '');

// One scope: sftkScanBucketInfo calls sftkBucketCapShipped, and the note /
// guard builders call both plus sftkBucketCountLabel.
const F = extractFunctions('studio-scan.js', [
  'sftkBucketCap',
  'sftkBucketCapShipped',
  'sftkScanBucketInfo',
  'sftkBucketCountLabel',
  'sftkBucketCapTitle',
  'sftkBucketCapNote',
  'sftkCappedWriteNote',
  'sftkParentScopeCap',
  'sftkParentScopeNote'
]);
const {
  sftkBucketCap, sftkBucketCapShipped, sftkScanBucketInfo, sftkBucketCountLabel,
  sftkBucketCapTitle, sftkBucketCapNote, sftkCappedWriteNote,
  sftkParentScopeCap, sftkParentScopeNote
} = F;

// A bucket of n rows, shaped like the real ones.
const rows = (n, kind = 'src') => Array.from({ length: n }, (_, i) => (
  kind === 'tgt' ? { matchKey: `k${i}`, targetId: `t${i}` }
                 : { matchKey: `k${i}`, sourceId: `s${i}` }));

// What runDiffScan builds: full arrays measured, then sliced for storage.
function scanOf(counts, opts = {}) {
  const cap  = opts.cap ?? 5000;
  const lcap = opts.linkCap ?? 2000;
  const full = {
    missingInTarget: rows(counts.missingInTarget ?? 0),
    changed:         rows(counts.changed ?? 0),
    identical:       rows(counts.identical ?? 0),
    onlyInTarget:    rows(counts.onlyInTarget ?? 0, 'tgt'),
    linkMismatch:    rows(counts.linkMismatch ?? 0, 'tgt')
  };
  const caps = {
    cap, linkCap: lcap,
    missingInTarget: sftkBucketCap(full.missingInTarget, cap),
    changed:         sftkBucketCap(full.changed, cap),
    identical:       sftkBucketCap(full.identical, cap),
    onlyInTarget:    sftkBucketCap(full.onlyInTarget, cap),
    linkMismatch:    sftkBucketCap(full.linkMismatch, lcap)
  };
  if (opts.orphanCapped) caps.onlyInTarget.totalIsFloor = true;
  const anyCapped = [caps.missingInTarget, caps.changed, caps.identical, caps.onlyInTarget]
    .some(c => c.shown >= c.cap) || caps.linkMismatch.shown >= caps.linkMismatch.cap;
  const scan = {
    objectType: opts.objectType || 'Account',
    missingInTarget: full.missingInTarget.slice(0, cap),
    changed:         full.changed.slice(0, cap),
    identical:       full.identical.slice(0, cap),
    onlyInTarget:    full.onlyInTarget.slice(0, cap),
    linkMismatch:    full.linkMismatch.slice(0, lcap)
  };
  if (anyCapped && opts.legacy !== true) scan.bucketCaps = caps;
  return scan;
}

// ════════════════════════════════════════════════════════════════════════
describe('cap detection, per bucket', () => {
  it('measures the exact total when the whole array is in hand', () => {
    expect(sftkBucketCap(rows(4999), 5000)).toEqual({ shown: 4999, total: 4999, capped: false, cap: 5000 });
    // Exactly at the cap: everything fits, so nothing was cut. This is the
    // one case where the measured path and the length>=cap fallback disagree,
    // and the measured one is right.
    expect(sftkBucketCap(rows(5000), 5000)).toEqual({ shown: 5000, total: 5000, capped: false, cap: 5000 });
    expect(sftkBucketCap(rows(5001), 5000)).toEqual({ shown: 5000, total: 5001, capped: true, cap: 5000 });
  });

  it('defaults to 5,000 and treats junk input as an empty bucket', () => {
    expect(sftkBucketCap(rows(3)).cap).toBe(5000);
    expect(sftkBucketCap(null, 5000)).toEqual({ shown: 0, total: 0, capped: false, cap: 5000 });
    expect(sftkBucketCap(undefined, 0).cap).toBe(5000);      // 0 / negative → default
    expect(sftkBucketCap(rows(2), -7).cap).toBe(5000);
  });

  it('falls back to the user-copy.js rule (length >= LIMIT) when no total was measured', () => {
    expect(sftkBucketCapShipped(4999, 5000).capped).toBe(false);
    expect(sftkBucketCapShipped(5000, 5000).capped).toBe(true);
    expect(sftkBucketCapShipped(5001, 5000).capped).toBe(true);
    // and it never invents the total it does not have
    expect(sftkBucketCapShipped(5000, 5000).total).toBe(null);
    expect(sftkBucketCapShipped(5000, 5000).measured).toBe(false);
  });

  it('detects each bucket independently — one capped bucket does not tar the others', () => {
    const scan = scanOf({ missingInTarget: 47213, changed: 12, identical: 8, onlyInTarget: 0 });
    expect(sftkScanBucketInfo(scan, 'missingInTarget')).toMatchObject({ shown: 5000, total: 47213, capped: true });
    expect(sftkScanBucketInfo(scan, 'changed')).toMatchObject({ shown: 12, total: 12, capped: false });
    expect(sftkScanBucketInfo(scan, 'identical')).toMatchObject({ shown: 8, total: 8, capped: false });
    expect(sftkScanBucketInfo(scan, 'onlyInTarget')).toMatchObject({ shown: 0, total: 0, capped: false });
  });

  it('caps all four buckets independently when all four overflow', () => {
    const scan = scanOf({ missingInTarget: 5001, changed: 9000, identical: 60000, onlyInTarget: 5100 });
    for (const [b, total] of [['missingInTarget', 5001], ['changed', 9000], ['identical', 60000], ['onlyInTarget', 5100]]) {
      const i = sftkScanBucketInfo(scan, b);
      expect(i).toMatchObject({ shown: 5000, total, capped: true });
    }
  });

  it('uses the 2,000 cap for linkMismatch, not 5,000', () => {
    const scan = scanOf({ linkMismatch: 3400 });
    expect(sftkScanBucketInfo(scan, 'linkMismatch')).toMatchObject({ shown: 2000, total: 3400, capped: true });
    // legacy (no bucketCaps): the default cap for this bucket is still 2,000
    expect(sftkScanBucketInfo({ linkMismatch: rows(2000, 'tgt') }, 'linkMismatch'))
      .toMatchObject({ shown: 2000, total: null, capped: true });
    expect(sftkScanBucketInfo({ linkMismatch: rows(1999, 'tgt') }, 'linkMismatch').capped).toBe(false);
  });

  it('reads a scan stored BEFORE L6 (sliced arrays, no measured totals) honestly', () => {
    const legacy = { missingInTarget: rows(5000), changed: rows(3), identical: [], onlyInTarget: [] };
    const i = sftkScanBucketInfo(legacy, 'missingInTarget');
    expect(i).toMatchObject({ shown: 5000, total: null, capped: true, measured: false });
    expect(sftkScanBucketInfo(legacy, 'changed')).toMatchObject({ shown: 3, capped: false });
  });

  it('prefers the measured record over the shipped length when both exist', () => {
    // The shipped array is 5,000 long; the measured record says 47,213 exist.
    const scan = scanOf({ missingInTarget: 47213 });
    expect(scan.missingInTarget.length).toBe(5000);
    expect(sftkScanBucketInfo(scan, 'missingInTarget').total).toBe(47213);
    expect(sftkScanBucketInfo(scan, 'missingInTarget').measured).toBe(true);
  });

  it('does not false-positive on a bucket that lands on exactly the cap', () => {
    // 5,000 records exist and 5,000 shipped: complete. The measured record is
    // attached precisely so the >= fallback never has to guess here.
    const scan = scanOf({ missingInTarget: 5000 });
    expect(scan.bucketCaps).toBeTruthy();
    expect(sftkScanBucketInfo(scan, 'missingInTarget')).toMatchObject({ shown: 5000, total: 5000, capped: false });
    expect(sftkBucketCountLabel(5000, 5000, false, false)).toBe('5,000');
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('the honest label builders', () => {
  it('prints the plain grouped number when nothing was cut', () => {
    expect(sftkBucketCountLabel(12, 12, false, false)).toBe('12');
    expect(sftkBucketCountLabel(47213, 47213, false, false)).toBe('47,213');
    expect(sftkBucketCountLabel(0, 0, false, false)).toBe('0');
  });

  it('prints "shown of measured" when the bucket was cut and the total is known', () => {
    expect(sftkBucketCountLabel(5000, 47213, true, false)).toBe('5,000 of 47,213');
  });

  it('never invents a total — an unmeasured cap reads as a floor', () => {
    expect(sftkBucketCountLabel(5000, null, true, false)).toBe('5,000+');
    expect(sftkBucketCountLabel(5000, undefined, true, false)).toBe('5,000+');
    // and a "total" that is not actually greater than what shipped is not a total
    expect(sftkBucketCountLabel(5000, 5000, true, false)).toBe('5,000+');
  });

  it('marks a total that is ITSELF a floor (orphan probe capped) with a +', () => {
    // onlyInTarget carries a one-page orphan tail: 4,100 classified, more exist.
    expect(sftkBucketCountLabel(4100, 4100, false, true)).toBe('4,100+');
    expect(sftkBucketCountLabel(5000, 9000, true, true)).toBe('5,000 of 9,000+');
  });

  it('emits NO tooltip for a complete bucket, and a numeric one for a cut bucket', () => {
    expect(sftkBucketCapTitle(12, 12, false, false, 'in source only')).toBe('');
    const t = sftkBucketCapTitle(5000, 47213, true, false, 'in source only');
    expect(t).toContain('5,000');
    expect(t).toContain('47,213');
    expect(t).toContain('42,213');            // the difference, measured not guessed
    expect(t).toMatch(/floor, not a total/i);
    // unmeasured: states the cut without a fabricated remainder
    const u = sftkBucketCapTitle(5000, null, true, false, 'in source only');
    expect(u).toContain('5,000');
    expect(u).not.toMatch(/\bof \d/);
  });

  it('builds a banner naming every capped bucket, and nothing at all otherwise', () => {
    expect(sftkBucketCapNote(scanOf({ missingInTarget: 10, changed: 2 }), 'Account')).toBe('');
    const note = sftkBucketCapNote(scanOf({ missingInTarget: 47213, onlyInTarget: 6001, changed: 4 }), 'Account');
    expect(note).toContain('Account');
    expect(note).toContain('in source only 5,000 of 47,213');
    expect(note).toContain('in target only 5,000 of 6,001');
    expect(note).not.toContain('changed 5,000');     // that bucket was complete
    expect(note).toMatch(/floor/i);
  });

  it('the banner works on a legacy stored scan too — as a floor, with no invented total', () => {
    const legacy = { missingInTarget: rows(5000), changed: [], identical: [], onlyInTarget: [] };
    const note = sftkBucketCapNote(legacy, 'Contact');
    expect(note).toContain('in source only 5,000+');
    expect(note).not.toMatch(/of \d/);
  });

  it('skips buckets the scan does not carry rather than reporting them as 0', () => {
    const note = sftkBucketCapNote({ missingInTarget: rows(5000) }, 'Lead');
    expect(note).toContain('in source only');
    expect(note).not.toContain('in target only');
    expect(note).not.toContain('in sync');
  });
});

// ════════════════════════════════════════════════════════════════════════
// The task asked for "COUNT() reconciliation". The reconciliation is real;
// the COUNT() query is not, and deliberately so — see the note at the top of
// the bucket-cap block in studio-scan.js. Both sides of the diff are already
// paged in full, so the scan HOLDS the true totals; asking the org for
// SELECT COUNT() would spend a round-trip to re-learn a number it measured,
// from a different point in time. These tests pin the property a COUNT()
// would have given us: shown + not-shown === measured total, everywhere.
describe('measured-total reconciliation (what COUNT() would have bought)', () => {
  it('shown + hidden always reconciles to the measured total', () => {
    for (const total of [0, 1, 4999, 5000, 5001, 47213, 250000]) {
      const c = sftkBucketCap(rows(total), 5000);
      expect(c.shown + (c.total - c.shown)).toBe(total);
      expect(c.shown).toBe(Math.min(total, 5000));
      expect(c.capped).toBe(total > 5000);
    }
  });

  it('the label and the tooltip agree with the arithmetic', () => {
    const c = sftkBucketCap(rows(47213), 5000);
    expect(sftkBucketCountLabel(c.shown, c.total, c.capped, false)).toBe('5,000 of 47,213');
    expect(sftkBucketCapTitle(c.shown, c.total, c.capped, false, 'x')).toContain('42,213');
  });

  it('studio-scan.js does NOT add a query to learn a total it already measured', () => {
    const src = codeOnly(srcOf('studio-scan.js'));
    expect(src).not.toMatch(/SELECT\s+COUNT\(/i);
    // The measurement happens against the FULL arrays, before the slice.
    expect(src).toMatch(/sftkBucketCap\(missingInTarget,\s*BUCKET_CAP\)/);
    expect(src).toMatch(/sftkBucketCap\(onlyInTarget,\s*BUCKET_CAP\)/);
    expect(src).toMatch(/sftkBucketCap\(changed,\s*BUCKET_CAP\)/);
    expect(src).toMatch(/sftkBucketCap\(identical,\s*BUCKET_CAP\)/);
    expect(src).toMatch(/sftkBucketCap\(linkMismatch,\s*LINK_CAP\)/);
  });

  it('attaches bucketCaps only when a bucket actually reached its cap (small orgs unchanged)', () => {
    expect(scanOf({ missingInTarget: 10, changed: 2, identical: 3, onlyInTarget: 1 }).bucketCaps).toBeUndefined();
    expect(scanOf({ missingInTarget: 5000 }).bucketCaps).toBeTruthy();
    expect(scanOf({ linkMismatch: 2000 }).bucketCaps).toBeTruthy();
    // the guard in the source uses >= (not >) for exactly that reason
    const src = codeOnly(srcOf('studio-scan.js'));
    expect(src).toMatch(/_anyCapped\s*=\s*\[[^\]]*\]\.some\(c\s*=>\s*c\.shown\s*>=\s*c\.cap\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('a capped set feeding a WRITE', () => {
  const capped   = scanOf({ missingInTarget: 47213, changed: 9000, identical: 3, onlyInTarget: 6001, linkMismatch: 2500 });
  const complete = scanOf({ missingInTarget: 12, changed: 4, identical: 3, onlyInTarget: 2, linkMismatch: 1 });

  it('says nothing when the scan behind the selection was complete', () => {
    const n = sftkCappedWriteNote(complete, ['push', 'overwrite', 'del', 'pull', 'updSrc', 'relink'], 'Account');
    expect(n.lines).toEqual([]);
    expect(n.text).toBe('');            // falsy → the caller adds no dialog
  });

  it('warns for Insert, because push ids come from missingInTarget', () => {
    const n = sftkCappedWriteNote(capped, ['push'], 'Account');
    expect(n.lines).toHaveLength(1);
    expect(n.lines[0]).toContain('Insert');
    expect(n.lines[0]).toContain('5,000 of 47,213');
    expect(n.lines[0]).toMatch(/TRUNCATED/);
    expect(n.text).toMatch(/listed rows ONLY/i);
  });

  it('maps every action kind back to the bucket its ids were picked from', () => {
    const b = k => sftkCappedWriteNote(capped, [k], 'Account').lines[0] || '';
    expect(b('push')).toContain('in source only');
    expect(b('overwrite')).toContain('changed');
    expect(b('updSrc')).toContain('changed');
    expect(b('del')).toContain('in target only');
    expect(b('pull')).toContain('in target only');
    expect(b('relink')).toContain('link differs');
    // relink reads the 2,000 cap, not the 5,000 one
    expect(b('relink')).toContain('2,000 of 2,500');
  });

  it('warns once per selected ACTION, and only for the actions that are selected', () => {
    // Both drift directions selected → two lines, one per action, same bucket.
    const both = sftkCappedWriteNote(capped, ['overwrite', 'updSrc'], 'Account');
    expect(both.lines).toHaveLength(2);
    expect(both.lines[0]).toContain('→ Update target');
    expect(both.lines[1]).toContain('← Update source');
    // A repeated kind is still one line.
    expect(sftkCappedWriteNote(capped, ['push', 'push'], 'Account').lines).toHaveLength(1);
    // Deleting does not drag in a warning about the Insert bucket.
    const del = sftkCappedWriteNote(capped, ['del'], 'Account');
    expect(del.lines).toHaveLength(1);
    expect(del.lines[0]).not.toContain('Insert');
  });

  it('warns on a partially capped scan only for the capped buckets', () => {
    const mixed = scanOf({ missingInTarget: 47213, changed: 4, onlyInTarget: 2 });
    const n = sftkCappedWriteNote(mixed, ['push', 'overwrite', 'del'], 'Account');
    expect(n.lines).toHaveLength(1);
    expect(n.lines[0]).toContain('Insert');
  });

  it('warns for a legacy stored scan too, without inventing the remainder', () => {
    const legacy = { missingInTarget: rows(5000), changed: [], identical: [], onlyInTarget: [] };
    const n = sftkCappedWriteNote(legacy, ['push'], 'Account');
    expect(n.lines).toHaveLength(1);
    expect(n.lines[0]).toContain('5,000+');
    expect(n.lines[0]).not.toMatch(/of \d/);
  });

  it('ignores unknown/absent kinds and never throws on a junk scan', () => {
    expect(sftkCappedWriteNote(capped, ['nonsense'], 'Account').lines).toEqual([]);
    expect(sftkCappedWriteNote(capped, null, 'Account').lines).toEqual([]);
    expect(sftkCappedWriteNote(null, ['push'], 'Account').lines).toEqual([]);
    expect(sftkCappedWriteNote(undefined, undefined, undefined).text).toBe('');
  });

  it('the reconcile run opens its confirm dialog when — and only when — there is something to disclose', () => {
    const rec = codeOnly(srcOf('studio-reconcile.js'));
    // An Insert-only run used to write with no dialog at all; the guard is the
    // extra condition on that gate.
    expect(rec).toMatch(/if \(delIds\.length \|\| pullIds\.length \|\| updSrcIds\.length \|\| anyChildAct \|\| capWarnLines\.length\)/);
    // The warning is BUILT from the selections, per object, root and children.
    expect(rec).toMatch(/sftkCappedWriteNote\(rootScan, rootKinds, objType\)/);
    expect(rec).toMatch(/sftkCappedWriteNote\(a\.cs, kinds, obj\)/);
    // and it is rendered inside the modal body, not just computed.
    expect(rec).toMatch(/\$\{capWarnBlock\}/);
  });

  it('a truncated parent SCOPE is escalated into the same write dialog', () => {
    const rec = codeOnly(srcOf('studio-reconcile.js'));
    expect(rec).toMatch(/a\.cs\.parentScopeNote/);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('child scans scoped to a truncated parent scan', () => {
  it('returns null when the parent scan listed everything', () => {
    expect(sftkParentScopeCap(scanOf({ missingInTarget: 10, changed: 2, identical: 4, onlyInTarget: 1 }))).toBe(null);
    expect(sftkParentScopeCap(null)).toBe(null);
    expect(sftkParentScopeCap({})).toBe(null);
  });

  it('names the capped buckets that fed the parent-id lists', () => {
    const info = sftkParentScopeCap(scanOf({ missingInTarget: 47213, changed: 3, identical: 5001, onlyInTarget: 2 }));
    expect(info.buckets).toEqual(['missingInTarget', 'identical']);
    // 42,213 parents missed from missingInTarget + 1 from identical
    expect(info.parentsMissed).toBe(42214);
  });

  it('a capped bucket in ONLY the target-side feed still counts', () => {
    const info = sftkParentScopeCap(scanOf({ onlyInTarget: 5500 }));
    expect(info.buckets).toEqual(['onlyInTarget']);
    expect(info.parentsMissed).toBe(500);
  });

  it('refuses to quote a number when any capped bucket has no measured total', () => {
    const legacy = { missingInTarget: rows(5000), changed: [], identical: [], onlyInTarget: [] };
    const info = sftkParentScopeCap(legacy);
    expect(info.buckets).toEqual(['missingInTarget']);
    expect(info.parentsMissed).toBe(null);
  });

  it('wording says the child counts are a floor, and names both objects', () => {
    const info = sftkParentScopeCap(scanOf({ missingInTarget: 47213 }));
    const note = sftkParentScopeNote(info, 'Account', 'Contact');
    expect(note).toContain('Account');
    expect(note).toContain('Contact');
    expect(note).toContain('42,213');
    expect(note).toMatch(/floor, not a total/i);
    // no measured number → no fabricated one
    const vague = sftkParentScopeNote({ buckets: ['identical'], parentsMissed: null }, 'Account', 'Contact');
    expect(vague).toMatch(/some Account record/);
    expect(vague).not.toMatch(/\d{3}/);
  });

  it('renders nothing for a complete parent scan', () => {
    expect(sftkParentScopeNote(null, 'Account', 'Contact')).toBe('');
    expect(sftkParentScopeNote({ buckets: [] }, 'Account', 'Contact')).toBe('');
  });

  it('the child scan attaches the flag AND the wording to its result', () => {
    const src = codeOnly(srcOf('studio-scan.js'));
    expect(src).toMatch(/sftkParentScopeCap\(scanBasis\)/);
    expect(src).toMatch(/res\.parentScopeCapped\s*=\s*_pScope/);
    expect(src).toMatch(/res\.parentScopeNote\s*=\s*sftkParentScopeNote/);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('every display site reads the label, not the shipped length', () => {
  const rec = codeOnly(srcOf('studio-reconcile.js'));

  it('root columns: Insert / Changed / In target only / in sync', () => {
    expect(rec).not.toMatch(/<strong>\$\{dml\} \$\{items\.length\}<\/strong>/);
    expect(rec).not.toMatch(/<strong>Changed \$\{items\.length\}<\/strong>/);
    expect(rec).not.toMatch(/<strong>In target only \$\{items\.length\}<\/strong>/);
    expect(rec).toMatch(/<strong>\$\{dml\} \$\{capLbl\(/);
    expect(rec).toMatch(/<strong>Changed \$\{capLbl\('changed', info\)\}<\/strong>/);
    expect(rec).toMatch(/<strong>In target only \$\{capLbl\('onlyInTarget', info\)\}<\/strong>/);
    expect(rec).toMatch(/\$\{capLbl\('identical'\)\} record\(s\) already in sync/);
  });

  it('child columns and the collapsed-section chips', () => {
    expect(rec).not.toMatch(/Insert \$\{cs\.missingInTarget\.length\}/);
    expect(rec).not.toMatch(/Changed \$\{cs\.changed\.length\}/);
    expect(rec).not.toMatch(/In target only \$\{cs\.onlyInTarget\.length\}/);
    expect(rec).not.toMatch(/\$\{cs\.missingInTarget\.length\} missing/);
    expect(rec).not.toMatch(/\$\{cs\.changed\.length\} changed/);
    expect(rec).not.toMatch(/\$\{cs\.onlyInTarget\.length\} target-only/);
    expect(rec).not.toMatch(/\$\{cs\.identical\.length\} in sync/);
    expect(rec).not.toMatch(/Link differs \$\{\(cs\.linkMismatch \|\| \[\]\)\.length\}/);
    expect(rec).toMatch(/Insert \$\{csLbl\(cs, 'missingInTarget'\)\}/);
    expect(rec).toMatch(/Changed \$\{csLbl\(cs, 'changed'\)\}/);
    expect(rec).toMatch(/In target only \$\{csLbl\(cs, 'onlyInTarget'\)\}/);
    expect(rec).toMatch(/Link differs \$\{csLbl\(cs, 'linkMismatch'\)\}/);
    expect(rec).toMatch(/\$\{csLbl\(cs, 'identical'\)\} in sync/);
  });

  it('the page banner and the per-child banner are rendered, not merely computed', () => {
    expect(rec).toMatch(/\$\{_recCapNote \?/);
    expect(rec).toMatch(/\$\{scopeNote\}\$\{capNote\}/);
  });

  it('the refresh toast reports capped counts honestly too', () => {
    const scan = codeOnly(srcOf('studio-scan.js'));
    expect(scan).not.toMatch(/Diff refreshed — \$\{res\.missingInTarget\.length\}/);
    expect(scan).toMatch(/Diff refreshed — \$\{_lbl\('missingInTarget'\)\} missing/);
  });

  it('Match review discloses that its two lists are a slice', () => {
    expect(rec).toMatch(/mmCapNote/);
    expect(rec).toMatch(/has NOT been ruled out as a match/);
  });
});

// ── Ring Sync Plan discloses the scan cap on its WRITE path ──────────
// The plan builds a real multi-org write from scan buckets that studio-scan
// slices at 5,000, with the push checkbox on by default. It already disclosed
// its own 500-row DISPLAY slice, which made the undisclosed larger truncation
// read as deliberate. Guarded here because it is a write path: a silent
// regression means "Add 5,000 of 5,000" while 42,000 records go unwritten.
describe('studio-ring.js — Sync Plan cap disclosure (write path)', () => {
  const src = srcOf('studio-ring.js');

  it('calls sftkCappedWriteNote with the kinds the plan can actually write', () => {
    expect(src).toMatch(/sftkCappedWriteNote\(pl\.res,\s*capKinds,\s*p\.tree\.objectType\)/);
    expect(src).toMatch(/capKinds\s*=\s*\[[^\]]*'push'[^\]]*'overwrite'[^\]]*'del'/s);
  });

  it('renders the warning ABOVE the op checkboxes, not buried after them', () => {
    const warnAt = src.indexOf('ds-plan-capwarn');
    const pushAt = src.indexOf('ds-plan-push');
    expect(warnAt).toBeGreaterThan(-1);
    expect(warnAt).toBeLessThan(pushAt);
  });

  it('degrades safely when the helper is absent (studio-scan not loaded)', () => {
    expect(src).toMatch(/typeof window\.sftkCappedWriteNote === 'function'/);
    expect(src).toMatch(/:\s*\{\s*lines:\s*\[\]\s*\}/);
  });
});

// ── Ring cell: freshest scan wins ────────────────────────────────────
// The cell used to give the profile's native lastScan ABSOLUTE priority
// whenever the profile's own pair equals the ring flow — so on exactly the
// flagship row, the 🔎 button scanned successfully, wrote ringScans… and the
// cell kept rendering the stale lastScan forever (user 2026-08-10: cell stuck
// at "21 · 55m ago" with two successful queries in the debug log).
describe('studio-ring.js — sftkRingCellPick freshest-wins', () => {
  const { sftkRingCellPick } = extractFunctions('studio-ring.js', ['sftkRingCellPick']);
  const at = (iso, missing) => ({ runAt: iso, missing, changed: 0, extra: 0, status: 'success' });

  it('newer ring scan beats older native lastScan (the reported bug)', () => {
    const nat = at('2026-08-10T20:19:00Z', 21);      // 55m-old "21"
    const rs  = at('2026-08-10T21:14:19Z', 0);       // fresh 🔎 result
    expect(sftkRingCellPick(nat, rs)).toBe(rs);
  });

  it('newer native lastScan beats an older ring scan', () => {
    const nat = at('2026-08-10T21:30:00Z', 0);
    const rs  = at('2026-08-10T21:14:19Z', 21);
    expect(sftkRingCellPick(nat, rs)).toBe(nat);
  });

  it('single-source and empty cases degrade to whatever exists', () => {
    const only = at('2026-08-10T21:14:19Z', 3);
    expect(sftkRingCellPick(only, null)).toBe(only);
    expect(sftkRingCellPick(null, only)).toBe(only);
    expect(sftkRingCellPick(null, null)).toBe(null);
    expect(sftkRingCellPick(undefined, undefined)).toBe(null);
  });

  it('the cell render actually routes through the picker, and a native-pair ring scan deposits lastScan', () => {
    const src = codeOnly(srcOf('studio-ring.js'));
    expect(src).toMatch(/sftkRingCellPick\(nat,\s*\(p\.ringScans \|\| \{\}\)/);
    // Both ring scan paths (🔎 and ⚖) write p.lastScan when the ring flow is
    // the profile's own pair — that's what keeps Reconcile and the ring in
    // the same moment.
    const deposits = src.match(/p\.lastScan = res;/g) || [];
    expect(deposits.length).toBeGreaterThanOrEqual(2);
  });
});

// ── sfQueryAll keeps the server's own total ──────────────────────────
describe('background.js sfQueryAll — serverTotal preserved', () => {
  const src = srcOf('background.js');

  it('captures totalSize from the FIRST page only and exposes it separately', () => {
    expect(src).toMatch(/serverTotal === null && typeof data\.totalSize === 'number'/);
    expect(src).toMatch(/return \{ records, totalSize: records\.length, serverTotal, done: true \}/);
  });

  it('leaves totalSize as the row count so existing callers are unchanged', () => {
    expect(src).toMatch(/totalSize: records\.length/);
  });
});
