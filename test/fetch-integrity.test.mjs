// THE COMPLETENESS INVARIANT (user 2026-08-28: "we have to make sure we
// are first getting all the chosen records from org a, and compare them to
// all the records in org b. if we are not recognizing some while connected
// to the admin we have an issue" — said after records went missing at work
// and a deployment "broke again" with a friend).
//
// Salesforce's first query page carries totalSize — the server's OWN count
// of matching rows. A pager that ends with a different number LOST rows.
// The invariant: that shortfall is never swallowed. The scan refuses to
// compare, the engine refuses to deploy, and the header proves
// completeness with "read N of N" instead of a bare N.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const BG   = read('background.js');
const SCAN = read('studio-scan.js');

describe('the pager proves itself', () => {
  const fn = BG.slice(BG.indexOf('async function sfQueryAll'),
    BG.indexOf('async function sfErrorText'));

  it('captures the server’s own total from the FIRST page', () => {
    expect(fn).toMatch(/if \(serverTotal === null && typeof data\.totalSize === 'number'\) serverTotal = data\.totalSize/);
  });

  it('attaches the shortfall whenever got ≠ expected — never swallows it', () => {
    expect(fn).toMatch(/serverTotal !== null && records\.length !== serverTotal/);
    expect(fn).toMatch(/\{ expected: serverTotal, got: records\.length \}/);
    expect(fn).toMatch(/\.\.\.\(incomplete \? \{ incomplete \} : \{\}\)/);
  });

  it('keeps totalSize as "rows I got" so no existing caller shifts meaning', () => {
    expect(fn).toContain('totalSize: records.length');
  });
});

describe('the engine refuses to deploy from a partial read', () => {
  it('fails the node, names the shortfall, and confirms nothing was written', () => {
    expect(BG).toContain('the source read came back INCOMPLETE');
    expect(BG).toMatch(/says \$\{qRes\.incomplete\.expected\} record\(s\) match, but only \$\{qRes\.incomplete\.got\} arrived/);
    expect(BG).toContain('Nothing was written for this object');
    expect(BG).toContain('deploying a partial read would silently skip the rest');
  });
});

describe('the scan refuses to compare partial reads', () => {
  it('gates BOTH sides right where the pair resolves', () => {
    expect(SCAN).toMatch(/for \(const \[side, r\] of \[\['source', a\], \['target', b\]\]\)/);
    expect(SCAN).toContain('The comparison was refused rather than built on a partial read');
  });

  it('a lost chunk poisons the whole scoped side — not just its 200 rows', () => {
    // Calling absent-but-existing records "missing in target" is how a
    // partial read turns into a wrong deployment — or a wrong delete.
    expect(SCAN).toMatch(/if \(r\?\.incomplete\) return \{ records: \[\], incomplete: r\.incomplete \}/);
  });

  it('the header can PROVE completeness: fetched carries the server totals', () => {
    expect(SCAN).toMatch(/srcTotal: srcRes\.serverTotal \?\? null/);
    expect(SCAN).toMatch(/tgtTotal: tgtRes\.serverTotal \?\? null/);
    const rec = read('studio-reconcile.js');
    expect(rec).toContain('of ${scan.fetched.srcTotal}');
    expect(rec).toContain('of ${scan.fetched.tgtTotal}');
  });
});
