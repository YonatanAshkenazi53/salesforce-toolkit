// Scale caps — the honesty contract for lists that do NOT fit in one query.
//
// Three real bugs from an enterprise-org test run, all the same shape: a
// query carried an embedded LIMIT, the LIMIT was handed to the PAGINATING
// wrapper (SF_QUERY_ALL), so the wrapper had nothing to page — the server
// returns one page and no nextRecordsUrl — and the UI then presented the
// capped slice as the whole truth.
//
//   license-manager.js  — user search capped at 100, list said "100 users"
//   studio-builder.js   — owner-fallback picker capped at 500, AND inferred a
//                         saved fallback user was MISSING from its absence in
//                         that truncated list (a false negative that silently
//                         changes owner mapping on the next deployment)
//   studio-scan.js      — R3 possible-orphan probe capped at 2000, count then
//                         displayed as definitive
//
// The caps themselves are mostly KEPT on purpose: these lists feed a <select>
// and DOM row lists, and an unbounded fetch in a 50k-user org is worse than a
// cap. What is tested here is that every cap is now (a) detected, (b) stated,
// (c) stated with numbers that were measured rather than guessed, and that
// (d) "not in the list" is never reported as "does not exist".
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcOf = f => readFileSync(join(root, f), 'utf8');
// Source-level guards below assert on CODE only — the comments in these files
// quote the old buggy queries on purpose, and a guard that reads them would
// fail on the very explanation of the fix.
const codeOnly = s => s.replace(/^\s*\/\/.*$/gm, '');

// ── license-manager.js (Finding 3) ──────────────────────────────────────
const lmListCapped       = extractFunction('license-manager.js', 'lmListCapped');
const lmResultCountLabel = extractFunction('license-manager.js', 'lmResultCountLabel');
const lmCapNoteText      = extractFunction('license-manager.js', 'lmCapNoteText');

// ── studio-builder.js (Finding 4) ───────────────────────────────────────
const bldOwnerFallbackList       = extractFunction('studio-builder.js', 'bldOwnerFallbackList');
const bldSavedFallbackPlan       = extractFunction('studio-builder.js', 'bldSavedFallbackPlan');
const bldSavedFallbackFromLookup = extractFunction('studio-builder.js', 'bldSavedFallbackFromLookup');
const bldOwnerFallbackHint       = extractFunction('studio-builder.js', 'bldOwnerFallbackHint');

// ── studio-scan.js (Finding 5) ──────────────────────────────────────────
const sftkOrphanLabel   = extractFunction('studio-scan.js', 'sftkOrphanLabel');
const sftkOrphanCapNote = extractFunction('studio-scan.js', 'sftkOrphanCapNote');

const user = (id, name, extra = {}) => ({ Id: id, Name: name, Username: `${name}@x.com`, ...extra });
const ID = n => `005000000000${String(n).padStart(4, '0')}AA`;   // 18 chars, like a real user id

// ════════════════════════════════════════════════════════════════════════
describe('license-manager — the user search cap is detected, not assumed', () => {
  it('calls the list capped exactly when the query returned everything it asked for', () => {
    expect(lmListCapped(99, 100)).toBe(false);
    expect(lmListCapped(100, 100)).toBe(true);
    // Defensive: a server that over-delivers is still a capped view.
    expect(lmListCapped(101, 100)).toBe(true);
  });

  it('never reports a cap for an org that was nowhere near it', () => {
    for (const n of [0, 1, 12, 98]) expect(lmListCapped(n, 100)).toBe(false);
  });

  it('treats junk sizes as "no cap" instead of inventing one', () => {
    for (const bad of [undefined, null, NaN, 'lots', {}]) {
      expect(lmListCapped(bad, 100)).toBe(false);
      expect(lmListCapped(100, bad)).toBe(false);
    }
    expect(lmListCapped(100, 0)).toBe(false);
  });
});

describe('license-manager — the count label stops claiming to be the total', () => {
  it('reads as a plain count when the list IS the whole result', () => {
    expect(lmResultCountLabel(7, false, 100)).toBe('7 users');
    expect(lmResultCountLabel(1, false, 100)).toBe('1 user');
    expect(lmResultCountLabel(0, false, 100)).toBe('0 users');
  });

  it('reads as a slice — "first 100" — the moment the cap bites', () => {
    expect(lmResultCountLabel(100, true, 100)).toBe('first 100 users');
    // The old label said "100 users", which in a 4,000-user org is a lie.
    expect(lmResultCountLabel(100, true, 100)).not.toBe('100 users');
  });
});

describe('license-manager — the cap banner states the cap and the escape hatch', () => {
  it('names the real cap number and refuses to imply completeness', () => {
    const t = lmCapNoteText(100, false);
    expect(t).toContain('first 100 users');
    expect(t).toContain('this list is not all of them');
  });

  it('points at the escape hatch that actually applies', () => {
    expect(lmCapNoteText(100, true)).toContain('Narrow the search');
    expect(lmCapNoteText(100, false)).toContain('Search by name or email');
  });

  it('never invents an org total it did not measure', () => {
    // One measured number only: the cap. No "of N", no "~N users".
    const t = lmCapNoteText(100, true);
    expect(t.match(/\d+/g)).toEqual(['100']);
  });
});

describe('license-manager — the search no longer fakes pagination', () => {
  const src = srcOf('license-manager.js');
  const searchQuery = codeOnly(src.slice(src.indexOf('async function doSearch'), src.indexOf('// ── Render user list')));

  it('sends the capped user query as ONE page, not through the pager', () => {
    expect(searchQuery).toMatch(/type:\s*'SF_QUERY'/);
    // SF_QUERY_ALL + an embedded LIMIT is the bug: the pager can never page.
    expect(searchQuery).not.toContain('SF_QUERY_ALL');
  });

  it('ties the SOQL LIMIT to the declared constant so they cannot drift apart', () => {
    expect(searchQuery).toContain('LIMIT ${LM_USER_LIMIT}');
    expect(src).toContain('const LM_USER_LIMIT = 100');
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('studio-builder — owner fallback list: shown vs. what exists', () => {
  const mk = n => Array.from({ length: n }, (_, i) => user(ID(i), `U${i}`));

  it('leaves a small org untouched — everything shown, nothing flagged', () => {
    const l = bldOwnerFallbackList(mk(120), 120, 500, true);
    expect(l.shown.length).toBe(120);
    expect(l.total).toBe(120);
    expect(l.capped).toBe(false);
    expect(l.pageComplete).toBe(true);
  });

  it('caps the OPTIONS at the limit but keeps the measured org total', () => {
    // One page of 2000 rows, Salesforce reported 8123 matching users.
    const l = bldOwnerFallbackList(mk(2000), 8123, 500, false);
    expect(l.shown.length).toBe(500);
    expect(l.fetched).toBe(2000);
    expect(l.total).toBe(8123);
    expect(l.capped).toBe(true);
    expect(l.pageComplete).toBe(false);   // 8123 > 2000 fetched
  });

  it('still detects a cap when the org total was not reported', () => {
    const l = bldOwnerFallbackList(mk(600), undefined, 500, true);
    expect(l.shown.length).toBe(500);
    expect(l.total).toBeNull();           // never guessed
    expect(l.capped).toBe(true);
  });

  it('rejects a totalSize smaller than the rows in hand instead of trusting it', () => {
    // A LIMIT-ed query makes totalSize echo the cap; that number is not a
    // total and must not be published as one.
    const l = bldOwnerFallbackList(mk(500), 500, 500, false);
    expect(l.total).toBe(500);
    expect(l.pageComplete).toBe(false);   // done:false wins — more pages exist
    expect(l.capped).toBe(true);
    expect(bldOwnerFallbackList(mk(600), 12, 500, true).total).toBeNull();
  });
});

describe('studio-builder — a saved fallback user is never declared missing from a capped list', () => {
  const shown = [user(ID(1), 'Ann'), user(ID(2), 'Bob')];
  const page  = [...shown, user(ID(9), 'Zoe')];   // Zoe exists, past the cap

  it('does nothing when no fallback user is saved', () => {
    expect(bldSavedFallbackPlan('', shown, page, true).action).toBe('none');
    expect(bldSavedFallbackPlan(null, shown, page, true).action).toBe('none');
  });

  it('is a no-op on the happy path — the saved user is already an option', () => {
    const p = bldSavedFallbackPlan(ID(1), shown, page, true);
    expect(p.action).toBe('listed');
    expect(p.user.Name).toBe('Ann');
  });

  it('THE BUG: a user past the display cap is restored, not reported missing', () => {
    const p = bldSavedFallbackPlan(ID(9), shown, page, false);
    expect(p.action).toBe('restore');
    expect(p.user.Name).toBe('Zoe');
  });

  it('asks for a direct lookup when the page itself was truncated', () => {
    // Absent from a truncated page proves nothing — go ask about the id.
    expect(bldSavedFallbackPlan(ID(42), shown, page, false).action).toBe('lookup');
  });

  it('only concludes absence when the page really is every matching row', () => {
    expect(bldSavedFallbackPlan(ID(42), shown, page, true).action).toBe('absent');
  });

  it('accepts 15- and 18-char ids and refuses to query garbage', () => {
    const id15 = '005000000000001';
    expect(bldSavedFallbackPlan(id15, [], [], false).action).toBe('lookup');
    expect(bldSavedFallbackPlan(ID(3), [], [], false).action).toBe('lookup');
    for (const bad of ['nope', '00500', '005-000-000', '005000000000001AAxx']) {
      expect(bldSavedFallbackPlan(bad, [], [], false).action).toBe('invalid');
    }
  });
});

describe('studio-builder — the direct id lookup is read honestly', () => {
  it('restores a real, usable user', () => {
    const r = bldSavedFallbackFromLookup({ records: [user(ID(9), 'Zoe', { IsActive: true, UserType: 'Standard' })] });
    expect(r.action).toBe('restore');
    expect(r.user.Name).toBe('Zoe');
  });

  it('separates "deactivated" from "deleted" instead of shrugging at both', () => {
    expect(bldSavedFallbackFromLookup({ records: [user(ID(9), 'Zoe', { IsActive: false })] }).action).toBe('inactive');
    expect(bldSavedFallbackFromLookup({ records: [] }).action).toBe('gone');
    expect(bldSavedFallbackFromLookup({ records: [user(ID(9), 'Zoe', { IsActive: true, UserType: 'CsnOnly' })] }).action)
      .toBe('othertype');
  });

  it('reports a FAILED lookup as unverified — never as "the user is gone"', () => {
    const r = bldSavedFallbackFromLookup({ error: 'SESSION_EXPIRED' });
    expect(r.action).toBe('unverified');
    expect(r.error).toBe('SESSION_EXPIRED');
    expect(bldSavedFallbackFromLookup(null).action).toBe('unverified');
  });
});

describe('studio-builder — the picker hint says exactly what it knows', () => {
  const small  = { shown: new Array(120), total: 120, capped: false };
  const capped = { shown: new Array(500), total: 8123, capped: true };
  const blind  = { shown: new Array(500), total: null, capped: true };

  it('stays a plain count for an org under the cap', () => {
    expect(bldOwnerFallbackHint(small, 'Prod', { action: 'none' }))
      .toBe('120 active standard user(s) in Prod.');
  });

  it('reports the cap with the MEASURED org total when there is one', () => {
    const h = bldOwnerFallbackHint(capped, 'Prod', { action: 'none' });
    expect(h).toContain('Showing the first 500 of 8,123 active standard users in Prod');
  });

  it('says "this org has more" — never a number — when no total was measured', () => {
    const h = bldOwnerFallbackHint(blind, 'Prod', { action: 'none' });
    expect(h).toContain('this org has more');
    expect(h.match(/\d+/g)).toEqual(['500']);   // the cap, and nothing invented
  });

  it('tells the truth about a saved user the cap hid — no false alarm', () => {
    const h = bldOwnerFallbackHint(capped, 'Prod', { action: 'restore', user: user(ID(9), 'Zoe') });
    expect(h).toContain('Zoe');
    expect(h).toContain('kept and pinned');
    expect(h).not.toMatch(/not found|no longer exists|deactivated\?/i);
  });

  it('warns only when absence was actually established', () => {
    expect(bldOwnerFallbackHint(small, 'Prod', { action: 'absent' })).toContain('⚠');
    expect(bldOwnerFallbackHint(small, 'Prod', { action: 'gone' })).toContain('no longer exists');
    expect(bldOwnerFallbackHint(small, 'Prod', { action: 'inactive', user: user(ID(9), 'Zoe') }))
      .toContain('INACTIVE');
  });

  it('admits when it could not check, and says the setting was left alone', () => {
    const h = bldOwnerFallbackHint(capped, 'Prod', { action: 'unverified', error: 'SESSION_EXPIRED' });
    expect(h).toContain('SESSION_EXPIRED');
    expect(h).toContain('left unchanged');
    expect(h).not.toMatch(/no longer exists|not among them/i);
  });
});

describe('studio-builder — the fallback query no longer fakes pagination', () => {
  const src = srcOf('studio-builder.js');
  const fn  = codeOnly(src.slice(src.indexOf('async function loadOwnerFallbackUsers'),
                                 src.indexOf('// Match-owners-by controls')));

  it('drops the embedded LIMIT so totalSize is the org total, not the cap', () => {
    expect(fn).not.toMatch(/LIMIT\s+\d/);
    expect(fn).not.toContain('SF_QUERY_ALL');
    expect(fn).toMatch(/type:\s*'SF_QUERY'/);
  });

  it('caps the rendered options explicitly rather than by accident', () => {
    expect(src).toContain('const OWNER_FALLBACK_OPTION_LIMIT = 500');
    expect(fn).toContain('OWNER_FALLBACK_OPTION_LIMIT');
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('studio-scan — the orphan bucket admits when it is a floor', () => {
  it('reads as a plain count when every orphan is listed', () => {
    expect(sftkOrphanLabel(7, 7, false)).toBe('7 possible orphan(s)');
    expect(sftkOrphanLabel(0, 0, false)).toBe('0 possible orphan(s)');
  });

  it('shows shown-of-total once the page cap bites', () => {
    expect(sftkOrphanLabel(2000, 9431, true)).toBe('2,000 of 9,431 possible orphan(s) shown');
  });

  it('falls back to "more exist" rather than a made-up total', () => {
    expect(sftkOrphanLabel(2000, null, true)).toBe('2,000 possible orphan(s) shown — more exist');
    expect(sftkOrphanLabel(2000, undefined, true)).toContain('more exist');
    // A total that is not bigger than what we show tells us nothing new.
    expect(sftkOrphanLabel(2000, 2000, true)).toContain('more exist');
  });
});

describe('studio-scan — the orphan cap banner', () => {
  it('says nothing at all when the list is complete', () => {
    expect(sftkOrphanCapNote(7, 7, false)).toBe('');
    expect(sftkOrphanCapNote(0, 0, false)).toBe('');
  });

  it('quotes the measured total and the measured remainder', () => {
    const n = sftkOrphanCapNote(2000, 9431, true);
    expect(n).toContain('showing the first 2,000 of 9,431');
    expect(n).toContain('7,431 more are NOT listed here');
    expect(n).toContain('floor, not a total');
  });

  it('invents no numbers when the total was never reported', () => {
    const n = sftkOrphanCapNote(2000, null, true);
    expect(n).toContain('this target has more');
    // The only figure in the sentence is the shown count "2,000" (which the
    // digit regex sees as 2 + 000). No total, no remainder, no estimate.
    expect(n.match(/\d+/g)).toEqual(['2', '000']);
  });
});

describe('studio-scan / studio-reconcile — the probe and its display site agree', () => {
  const scan = srcOf('studio-scan.js');
  const rec  = srcOf('studio-reconcile.js');
  const probe = codeOnly(scan.slice(scan.indexOf('// R3 — orphan detection'), scan.indexOf('// ── M3c')));

  it('reads ONE page without an embedded LIMIT, so totalSize is real', () => {
    expect(probe).not.toMatch(/LIMIT\s+2000/);
    expect(probe).not.toContain('SF_QUERY_ALL');
    expect(probe).toMatch(/type:\s*'SF_QUERY'/);
    expect(probe).toContain('q.totalSize');
  });

  it('publishes the cap alongside the count, so no consumer sees only the count', () => {
    expect(scan).toContain('orphanCapped: true');
    expect(scan).toContain('orphanTotal');
    expect(scan).toContain('orphanLabel');
    expect(scan).toContain('orphanNote');
  });

  it('renders both the honest label and the cap banner in Reconcile', () => {
    expect(rec).toContain('cs.orphanNote');
    expect(rec).toContain('cs.orphanLabel');
    // The old sub-label built the count from rows alone and could not know
    // about the cap.
    expect(rec).not.toContain('${orphanN} possible orphan(s) — ⇄ Relink');
  });
});
