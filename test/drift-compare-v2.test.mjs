// FIELD-VALUE COMPARE v2 + PER-FIELD PUSH (user 2026-08-27: "when
// updating i want to be able to select lookups as well" + "the field value
// compare screen UI can be improved. it looks very old. and not
// intuitive"). Pins: differences-first layout, lookups selectable and
// pushed BY KEY never by raw Id, ambiguity failing closed everywhere the
// key is resolved, and both callers riding the same wiring.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const SCAN = read('studio-scan.js');
const REC  = read('studio-reconcile.js');

describe('the compare screen, v2', () => {
  const fn = SCAN.slice(SCAN.indexOf('function renderDriftCompareTable'),
    SCAN.indexOf('async function sftkPushFieldsToTarget'));

  it('shows differences FIRST and folds matching fields away', () => {
    // The user opened this to see what differs — rows that agree are noise
    // until asked for.
    expect(fn).toMatch(/const differing = pairs\.filter\(p => p\.differs\)/);
    expect(fn).toMatch(/const agreeing\s*= pairs\.filter\(p => !p\.differs\)/);
    expect(fn).toContain('<details class="ds-dc-fold">');
    expect(fn).toMatch(/Show the \$\{agreeing\.length\} matching field/);
  });

  it('lookups are selectable — the exact thing that was missing', () => {
    expect(fn).toContain('data-dcp-lkp');
    // a lookup row is pushable unless it is one we cannot safely resolve
    expect(fn).toMatch(/!\(lookupMap\[p\.srcField\] && lookupMap\[p\.srcField\]\.skip\)/);
  });

  it('a row that CANNOT be pushed says WHY, instead of silently lacking a box', () => {
    expect(fn).toContain('Cannot be pushed: the target org rewrites this label');
    expect(fn).toContain('Cannot be pushed: this lookup cannot be safely resolved');
  });

  it('selection is opt-in per caller — the renderer stays reusable', () => {
    expect(SCAN).toContain('types = null, opts = null)');
    expect(fn).toMatch(/const selectable = !!\(opts && opts\.selectable\)/);
  });

  it('keeps every honesty tag the old screen earned', () => {
    for (const t of ['normalized by target', 'type differs', 'not compared']) {
      expect(fn).toContain(t);
    }
  });
});

describe('the per-field push', () => {
  const fn = SCAN.slice(SCAN.indexOf('async function sftkPushFieldsToTarget'),
    SCAN.indexOf('function sftkWireDriftCompare'));

  it('pushes a lookup by the related record’s KEY, never the raw Id', () => {
    expect(fn).toMatch(/SELECT Id FROM \$\{parentObj\} WHERE \$\{info\.matchField\} = '\$\{lit\}' LIMIT 2/);
  });

  it('zero or several matches is that field’s ERROR — never a guess, never a silent null', () => {
    expect(fn).toContain('no ${parentObj} with');
    expect(fn).toContain('matches MORE THAN ONE');
    expect(fn).toContain('Deduplicate the target or match on an External ID');
  });

  it('an EMPTY source lookup clears the target — and says so', () => {
    // Pushing the source state includes pushing its emptiness; hiding that
    // would leave the orgs "in sync" while they differ.
    expect(fn).toContain('cleared — source is empty');
  });

  it('a production target gets the typed-name confirmation', () => {
    expect(fn).toMatch(/await ensureOrgType\(profile\.targetOrg\) === 'production'/);
    expect(fn).toMatch(/confirmTypedProd\(/);
  });

  it('a failed write reports NOTHING as applied', () => {
    expect(fn).toMatch(/out\.errors\.push\(`target write failed: \$\{w\.raw\?\.error \|\| w\.text\}`\); out\.applied = \[\]/);
  });

  it('both callers repaint from a FRESH read after a push', () => {
    // Stale values on screen would keep claiming a drift that is fixed.
    expect(REC).toMatch(/sftkWireDriftCompare\(body, prof, obj, srcId, tgtId/);   // 2026-09-16: the compare opens in a wide modal (sftkOpenDriftCompare)
    expect(read('studio-builder-modals.js')).toMatch(/sftkWireDriftCompare\(expand, _editingProfile, objType, recId/);
    expect(SCAN).toContain("if (typeof refetch === 'function') await refetch()");
  });
});

describe('overwrite now carries lookups by default', () => {
  it('a lookup rides unless explicitly excluded — not only when hand-mapped', () => {
    expect(REC).toMatch(/if \(fm\[f\.name\] === null\) continue;/);
    expect(REC).toContain('const lkpAuto = []');
    expect(REC).toContain('lookup(s) included and resolved by matching');
  });

  it('engine-owned and audit references never ride', () => {
    expect(REC).toMatch(/LKP_NEVER = new Set\(\['OwnerId', 'CreatedById', 'LastModifiedById'\]\)/);
  });

  it('ambiguous parent keys fail CLOSED, same rule as the engine bridge', () => {
    expect(REC).toMatch(/rp\.dupKeys = rp\.dupKeys \|\| new Set\(\)/);
    expect(REC).toMatch(/for \(const k of rp\.dupKeys\) rp\.byKey\.delete\(k\)/);
    expect(REC).toContain('linking to either would be a guess, so those lookups were left unchanged');
  });
});
