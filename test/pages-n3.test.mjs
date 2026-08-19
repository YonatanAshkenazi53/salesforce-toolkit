// N3 — Lightning Pages: assignment → users resolution.
//
// Unit tests for the PURE precedence core in lightning-pages.js. Everything
// under test is a top-level, column-0 function with no free variables, which
// is what test/extract.mjs can materialize out of a classic <script> file.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

const {
  lpAssignmentRank, lpScopeLabel, lpMatchesUser, lpResolveWinner,
  lpSoqlLit, lpSoqlLike
} = extractFunctions('lightning-pages.js', [
  'lpAssignmentRank', 'lpScopeLabel', 'lpMatchesUser', 'lpResolveWinner',
  'lpSoqlLit', 'lpSoqlLike'
]);

// Shorthand builders — a page assignment as the Tooling API returns it.
const orgDefault = (extra = {}) => ({ formFactor: 'Large', _pageLabel: 'Org Default Page', ...extra });
const appDefault = (app, extra = {}) => ({ app, formFactor: 'Large', _pageLabel: `${app} Page`, ...extra });
const appProfile = (app, profile, extra = {}) => ({ app, profile, formFactor: 'Large', _pageLabel: `${app}/${profile} Page`, ...extra });
const full = (app, profile, recordType, extra = {}) => ({ app, profile, recordType, formFactor: 'Large', _pageLabel: `${app}/${profile}/${recordType} Page`, ...extra });

describe('lpAssignmentRank', () => {
  it('scores the documented precedence chain in strictly descending order', () => {
    const rtAppProfile = lpAssignmentRank(full('Sales', 'Sales User', 'Business'));
    const appPlusProf  = lpAssignmentRank(appProfile('Sales', 'Sales User'));
    const appOnly      = lpAssignmentRank(appDefault('Sales'));
    const org          = lpAssignmentRank(orgDefault());

    expect(rtAppProfile).toBeGreaterThan(appPlusProf);
    expect(appPlusProf).toBeGreaterThan(appOnly);
    expect(appOnly).toBeGreaterThan(org);
    expect([rtAppProfile, appPlusProf, appOnly, org]).toEqual([7, 6, 4, 0]);
  });

  it('slots the in-between combinations deterministically', () => {
    expect(lpAssignmentRank({ app: 'Sales', recordType: 'Business' })).toBe(5);
    expect(lpAssignmentRank({ profile: 'Sales User', recordType: 'Business' })).toBe(3);
    expect(lpAssignmentRank({ profile: 'Sales User' })).toBe(2);
    expect(lpAssignmentRank({ recordType: 'Business' })).toBe(1);
  });

  it('treats empty strings and whitespace as "not named"', () => {
    expect(lpAssignmentRank({ app: '', profile: '   ', recordType: null })).toBe(0);
  });

  it('ranks a non-object below every real assignment', () => {
    expect(lpAssignmentRank(null)).toBe(-1);
    expect(lpAssignmentRank(undefined)).toBe(-1);
    expect(lpAssignmentRank('Sales')).toBe(-1);
    expect(lpAssignmentRank(null)).toBeLessThan(lpAssignmentRank(orgDefault()));
  });
});

describe('lpScopeLabel', () => {
  it('names each tier the way Lightning App Builder does', () => {
    expect(lpScopeLabel(orgDefault())).toBe('Org default');
    expect(lpScopeLabel(appDefault('Sales'))).toBe('App default');
    expect(lpScopeLabel(appProfile('Sales', 'Sales User'))).toBe('App + Profile');
    expect(lpScopeLabel(full('Sales', 'Sales User', 'Business'))).toBe('App + Record Type + Profile');
    expect(lpScopeLabel({ profile: 'Sales User' })).toBe('Profile');
    expect(lpScopeLabel({ recordType: 'Business' })).toBe('Record Type');
    expect(lpScopeLabel({ app: 'Sales', recordType: 'Business' })).toBe('App + Record Type');
  });
});

describe('lpMatchesUser', () => {
  const ctx = { profile: 'Sales User', app: 'Sales', recordType: 'Business', formFactor: 'Large' };

  it('applies an unconstrained assignment to everyone', () => {
    expect(lpMatchesUser(orgDefault(), ctx)).toBe(true);
    expect(lpMatchesUser({}, { profile: 'Anyone' })).toBe(true);
  });

  it('rejects an assignment whose named dimension differs', () => {
    expect(lpMatchesUser(appProfile('Sales', 'Marketing User'), ctx)).toBe(false);
    expect(lpMatchesUser(appProfile('Service', 'Sales User'), ctx)).toBe(false);
    expect(lpMatchesUser(full('Sales', 'Sales User', 'Person'), ctx)).toBe(false);
  });

  it('is case- and whitespace-insensitive on names', () => {
    expect(lpMatchesUser({ profile: '  sales USER ' }, ctx)).toBe(true);
    expect(lpMatchesUser({ app: 'SALES' }, ctx)).toBe(true);
  });

  it('does not apply an app-scoped assignment outside that app', () => {
    expect(lpMatchesUser(appDefault('Sales'), { profile: 'Sales User', app: null })).toBe(false);
  });

  it('compares form factor only when both sides state one', () => {
    expect(lpMatchesUser({ formFactor: 'Small' }, { profile: 'X', formFactor: 'Large' })).toBe(false);
    expect(lpMatchesUser({ formFactor: 'Small' }, { profile: 'X' })).toBe(true);
    expect(lpMatchesUser({}, { profile: 'X', formFactor: 'Small' })).toBe(true);
  });

  it('rejects garbage inputs rather than matching them', () => {
    expect(lpMatchesUser(null, ctx)).toBe(false);
    expect(lpMatchesUser(orgDefault(), null)).toBe(false);
  });
});

describe('lpResolveWinner — precedence', () => {
  const ctx = { profile: 'Sales User', app: 'Sales', recordType: 'Business', formFactor: 'Large' };

  it('record type + app + profile beats app + profile', () => {
    const r = lpResolveWinner([
      appProfile('Sales', 'Sales User'),
      full('Sales', 'Sales User', 'Business')
    ], ctx);
    expect(r.winner._pageLabel).toBe('Sales/Sales User/Business Page');
    expect(r.scope).toBe('App + Record Type + Profile');
    expect(r.rank).toBe(7);
  });

  it('app + profile beats app default', () => {
    const r = lpResolveWinner([appDefault('Sales'), appProfile('Sales', 'Sales User')], ctx);
    expect(r.winner._pageLabel).toBe('Sales/Sales User Page');
    expect(r.scope).toBe('App + Profile');
  });

  it('app default beats org default', () => {
    const r = lpResolveWinner([orgDefault(), appDefault('Sales')], ctx);
    expect(r.winner._pageLabel).toBe('Sales Page');
    expect(r.scope).toBe('App default');
  });

  it('resolves the whole four-level chain in one pass', () => {
    const r = lpResolveWinner([
      orgDefault(),
      appDefault('Sales'),
      appProfile('Sales', 'Sales User'),
      full('Sales', 'Sales User', 'Business')
    ], ctx);
    expect(r.scope).toBe('App + Record Type + Profile');
    expect(r.matched.map(m => m.rank)).toEqual([7, 6, 4, 0]);
    expect(r.beaten.map(m => m.scope)).toEqual(['App + Profile', 'App default', 'Org default']);
  });

  it('is order-independent — shuffling the input does not change the winner', () => {
    const all = [
      orgDefault(),
      appDefault('Sales'),
      appProfile('Sales', 'Sales User'),
      full('Sales', 'Sales User', 'Business')
    ];
    const forward  = lpResolveWinner(all, ctx);
    const backward = lpResolveWinner([...all].reverse(), ctx);
    expect(backward.winner._pageLabel).toBe(forward.winner._pageLabel);
    expect(backward.matched.map(m => m.rank)).toEqual(forward.matched.map(m => m.rank));
  });

  it('falls back to the org default outside the app', () => {
    const outside = { profile: 'Sales User', app: null, recordType: 'Business', formFactor: 'Large' };
    const r = lpResolveWinner([
      orgDefault(),
      appDefault('Sales'),
      appProfile('Sales', 'Sales User'),
      full('Sales', 'Sales User', 'Business')
    ], outside);
    expect(r.scope).toBe('Org default');
    expect(r.beaten).toHaveLength(0);
  });

  it('prefers a profile-only assignment over the org default', () => {
    const r = lpResolveWinner([orgDefault(), { profile: 'Sales User', _pageLabel: 'Profile Page' }],
      { profile: 'Sales User' });
    expect(r.winner._pageLabel).toBe('Profile Page');
    expect(r.rank).toBe(2);
  });

  it('reports no winner when nothing matches, without throwing', () => {
    const r = lpResolveWinner([appProfile('Service', 'Marketing User')], ctx);
    expect(r.winner).toBeNull();
    expect(r.rank).toBe(-1);
    expect(r.scope).toBe('None');
    expect(r.reason).toMatch(/standard page/i);
  });

  it('handles empty and non-array input', () => {
    expect(lpResolveWinner([], ctx).winner).toBeNull();
    expect(lpResolveWinner(null, ctx).winner).toBeNull();
    expect(lpResolveWinner(undefined, undefined).winner).toBeNull();
  });
});

describe('lpResolveWinner — tie-breaks are deterministic', () => {
  const ctx = { profile: 'Sales User', app: 'Sales', recordType: 'Business', formFactor: 'Large' };

  it('gives the same answer regardless of input order', () => {
    const a = appProfile('Sales', 'Sales User', { _pageLabel: 'Zebra Page' });
    const b = appProfile('Sales', 'Sales User', { _pageLabel: 'Alpha Page' });
    expect(lpResolveWinner([a, b], ctx).winner._pageLabel).toBe('Alpha Page');
    expect(lpResolveWinner([b, a], ctx).winner._pageLabel).toBe('Alpha Page');
  });

  it('lets an explicit Default flag win a same-specificity tie', () => {
    const a = appProfile('Sales', 'Sales User', { _pageLabel: 'Alpha Page' });
    const b = appProfile('Sales', 'Sales User', { _pageLabel: 'Zebra Page', default: true });
    expect(lpResolveWinner([a, b], ctx).winner._pageLabel).toBe('Zebra Page');
    expect(lpResolveWinner([b, a], ctx).winner._pageLabel).toBe('Zebra Page');
  });

  it('says out loud that a tie was broken by us, not by Salesforce', () => {
    const a = appProfile('Sales', 'Sales User', { _pageLabel: 'Alpha Page' });
    const b = appProfile('Sales', 'Sales User', { _pageLabel: 'Zebra Page' });
    const r = lpResolveWinner([a, b], ctx);
    expect(r.reason).toMatch(/tie/i);
    expect(r.reason).toMatch(/does not document/i);
  });

  it('falls back to original order when labels are identical', () => {
    const a = { app: 'Sales', profile: 'Sales User', _pageLabel: 'Same', tag: 'first' };
    const b = { app: 'Sales', profile: 'Sales User', _pageLabel: 'Same', tag: 'second' };
    expect(lpResolveWinner([a, b], ctx).winner.tag).toBe('first');
    expect(lpResolveWinner([b, a], ctx).winner.tag).toBe('second');
  });

  it('names the losing rule in the reason when specificity actually decided it', () => {
    const r = lpResolveWinner([appDefault('Sales'), appProfile('Sales', 'Sales User')], ctx);
    expect(r.reason).toContain('App + Profile');
    expect(r.reason).toContain('App default');
    expect(r.reason).toMatch(/more specific/i);
  });
});

describe('lpSoqlLit / lpSoqlLike', () => {
  it('quotes and escapes a plain value', () => {
    expect(lpSoqlLit('00e000000000001')).toBe("'00e000000000001'");
    expect(lpSoqlLit("O'Brien")).toBe("'O\\'Brien'");
  });

  it('escapes the backslash before the quote so it is not double-escaped', () => {
    expect(lpSoqlLit('a\\b')).toBe("'a\\\\b'");
    expect(lpSoqlLit("a\\'b")).toBe("'a\\\\\\'b'");
  });

  it('coerces null and undefined to an empty literal', () => {
    expect(lpSoqlLit(null)).toBe("''");
    expect(lpSoqlLit(undefined)).toBe("''");
  });

  it('wraps LIKE terms and neutralises the wildcards', () => {
    expect(lpSoqlLike('smith')).toBe("'%smith%'");
    expect(lpSoqlLike('50%')).toBe("'%50\\%%'");
    expect(lpSoqlLike('a_b')).toBe("'%a\\_b%'");
    expect(lpSoqlLike("O'B")).toBe("'%O\\'B%'");
  });
});

// ── Lightning Pages list: dots settle, no-activation types fold (2026-08-19:
// "some lightning pages won't resolve and stay orange" / "not sure we need
// to show utility bar items") ────────────────────────────────────────────
import { readFileSync as _rfs } from 'node:fs';
describe('page-list dots resolve or say n/a — never pulse forever', () => {
  const LP = _rfs(new URL('../lightning-pages.js', import.meta.url), 'utf8');
  const CSSHARED = _rfs(new URL('../styles.css', import.meta.url), 'utf8');

  it('utility bars are filtered out at load — none of the page tooling applies to them', () => {
    expect(LP).toContain(".filter(p => p.Type !== 'UtilityBar')");
    expect(LP).toContain("LP_TYPES_NO_ACTIVATION = new Set(['FlowPage', 'LoginPage'])");
  });

  it('no-activation types get the neutral dot + collapsed fold', () => {
    expect(LP).toMatch(/isNA && !ps\s+\? 'lp-dot-na'/);
    expect(LP).toContain('<details class="lp-group">');
    expect(LP).toContain('activation lives in each app — collapsed');
    // the n/a dot is calm — no pulse animation
    expect(CSSHARED).toMatch(/\.lp-dot-na\s+\{ background: var\(--subtext\); opacity: \.55; \}/);
  });

  it('pass 3 derives status from ASSIGNMENTS — Metadata.publishStatus is a phantom field', () => {
    // Verified live 2026-08-19: FlexiPage metadata has no publishStatus; a
    // page's only activation truth is pageAssignments (org default / app /
    // profile alike). Any read of the phantom would silently be undefined.
    // The LIST and MAP paths never read the phantom (the detail view keeps
    // its own multi-fallback probes — publishStatus can surface there via a
    // different endpoint after activation writes).
    expect(LP).not.toContain('meta?.Metadata?.publishStatus');
    expect(LP).not.toContain('|| meta.Metadata?.publishStatus');
    expect(LP).toContain('const statusTargets = allPages.filter(p =>');
    expect(LP).toMatch(/!p\.PublishStatus && !LP_TYPES_NO_ACTIVATION\.has\(p\.Type\) && !_odStatusDone\.has\(p\.Id\)/);
    expect(LP).toMatch(/sobject: 'FlexiPage', id: pg\.Id/);
    expect(LP).toMatch(/asg = Array\.isArray\(r\.Metadata\.pageAssignments\) \? r\.Metadata\.pageAssignments\.length : 0/);
    expect(LP).toContain("syncPageStatus(pg.Id, asg ? 'Active' : 'Unassigned')");
    expect(LP).toContain('p1.complete && p2.complete && p3.complete');
    // …and the strip's quoted cost includes those retrieves
    expect(LP).toMatch(/extraCalls:\s+Math\.ceil\(pendingIds\.length \/ LP_ENTITY_CHUNK\) \+ statusReads/);
  });

  it('Unassigned renders as a calm n/a state with an honest title, everywhere', () => {
    expect((LP.match(/ps === 'unassigned'\s+\? 'lp-dot-na'/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(LP).toContain('Not activated — no org default, app, or profile assignment points at this page.');
    // the map view derives from assignments too
    expect(LP).toMatch(/d\.page\.PublishStatus \|\| \(\(d\.assignments \|\| \[\]\)\.length \? 'active' : 'unassigned'\)/);
  });
});
