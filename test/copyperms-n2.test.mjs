// N2 — Copy Permissions user picker.
//
// The picker LISTS users and the filter box only narrows that list, so the
// matcher is the one piece of logic that decides whether a person is findable.
// It is pure on purpose; these tests pin its contract.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

const { cpUserMatches, cpFilterUsers } =
  extractFunctions('user-copy.js', ['cpUserMatches', 'cpFilterUsers']);

// A realistic row shaped exactly like the picker's SOQL projection.
const ADA = {
  Id: '005000000000001',
  Name: 'Ada Lovelace',
  Username: 'ada@analytical.example.com',
  Email: 'ada.lovelace@example.org',
  Alias: 'alove',
  IsActive: true,
  Profile: { Name: 'System Administrator' },
};

const GRACE = {
  Id: '005000000000002',
  Name: 'Grace Hopper',
  Username: 'grace@navy.example.com',
  Email: 'ghopper@example.org',
  Alias: 'ghopp',
  IsActive: true,
  Profile: { Name: 'Standard User' },
};

const USERS = [ADA, GRACE];

describe('cpUserMatches — matches across every field the picker shows', () => {
  it('matches on Name', () => {
    expect(cpUserMatches(ADA, 'Lovelace')).toBe(true);
  });

  it('matches on Username', () => {
    expect(cpUserMatches(ADA, 'analytical')).toBe(true);
  });

  it('matches on Email', () => {
    // Deliberately a fragment that appears ONLY in Email, not the Username.
    expect(cpUserMatches(ADA, 'ada.lovelace')).toBe(true);
  });

  it('matches on Alias', () => {
    expect(cpUserMatches(ADA, 'alove')).toBe(true);
  });

  it('matches on Profile name', () => {
    expect(cpUserMatches(ADA, 'System Administrator')).toBe(true);
  });

  it('is case-insensitive in both directions', () => {
    expect(cpUserMatches(ADA, 'LOVELACE')).toBe(true);
    expect(cpUserMatches(ADA, 'lovelace')).toBe(true);
    expect(cpUserMatches({ ...ADA, Name: 'ADA LOVELACE' }, 'Lovelace')).toBe(true);
  });

  it('matches substrings, not just prefixes', () => {
    expect(cpUserMatches(ADA, 'ovela')).toBe(true);
  });

  it('returns false when nothing matches', () => {
    expect(cpUserMatches(ADA, 'Hopper')).toBe(false);
    expect(cpUserMatches(ADA, 'Standard User')).toBe(false);
  });

  it('treats an empty / whitespace-only query as "show everyone"', () => {
    expect(cpUserMatches(ADA, '')).toBe(true);
    expect(cpUserMatches(ADA, '   ')).toBe(true);
    expect(cpUserMatches(ADA, null)).toBe(true);
    expect(cpUserMatches(ADA, undefined)).toBe(true);
  });

  it('trims the query before matching (a trailing space must not hide a row)', () => {
    expect(cpUserMatches(ADA, '  Lovelace  ')).toBe(true);
  });

  it('survives missing fields instead of throwing', () => {
    // Integration/system users routinely have no Alias, and Profile is null
    // for some UserTypes — the picker must not blow up on them.
    const sparse = { Id: '005x', Name: 'No Frills' };
    expect(cpUserMatches(sparse, 'frills')).toBe(true);
    expect(cpUserMatches(sparse, 'admin')).toBe(false);
    expect(cpUserMatches({ Name: 'X', Profile: null }, 'x')).toBe(true);
    expect(cpUserMatches({ Name: 'X', Alias: null, Email: null }, 'x')).toBe(true);
  });

  it('returns false for a null user with a real query, true with an empty one', () => {
    expect(cpUserMatches(null, 'ada')).toBe(false);
    // Empty query short-circuits before the user is even inspected.
    expect(cpUserMatches(null, '')).toBe(true);
  });

  it('does NOT match on Id (the picker never shows it)', () => {
    expect(cpUserMatches(ADA, '005000000000001')).toBe(false);
  });
});

describe('cpFilterUsers — list filtering', () => {
  it('returns everyone for an empty query', () => {
    expect(cpFilterUsers(USERS, '')).toHaveLength(2);
    expect(cpFilterUsers(USERS, '   ')).toHaveLength(2);
    expect(cpFilterUsers(USERS, null)).toHaveLength(2);
  });

  it('returns a COPY, never the input array', () => {
    const out = cpFilterUsers(USERS, '');
    expect(out).not.toBe(USERS);
    out.pop();
    expect(USERS).toHaveLength(2);
  });

  it('narrows to the matching rows', () => {
    expect(cpFilterUsers(USERS, 'hopper').map(u => u.Id)).toEqual([GRACE.Id]);
    expect(cpFilterUsers(USERS, 'alove').map(u => u.Id)).toEqual([ADA.Id]);
  });

  it('matches across fields for different rows in one pass', () => {
    // "example.org" is in both Emails → both rows come back.
    expect(cpFilterUsers(USERS, 'example.org')).toHaveLength(2);
  });

  it('filters by profile name', () => {
    expect(cpFilterUsers(USERS, 'standard').map(u => u.Id)).toEqual([GRACE.Id]);
  });

  it('preserves the source order (the SOQL is ORDER BY Name)', () => {
    expect(cpFilterUsers(USERS, 'example').map(u => u.Name))
      .toEqual(['Ada Lovelace', 'Grace Hopper']);
  });

  it('returns [] for no matches', () => {
    expect(cpFilterUsers(USERS, 'zzzz')).toEqual([]);
  });

  it('returns [] for a non-array pool instead of throwing', () => {
    // renderList() calls this while the list is still loading.
    expect(cpFilterUsers(null, 'ada')).toEqual([]);
    expect(cpFilterUsers(undefined, '')).toEqual([]);
    expect(cpFilterUsers('nope', '')).toEqual([]);
  });

  it('agrees with cpUserMatches row by row', () => {
    for (const q of ['', 'ada', 'HOPPER', 'example', 'nope', 'standard user']) {
      expect(cpFilterUsers(USERS, q)).toEqual(USERS.filter(u => cpUserMatches(u, q)));
    }
  });
});
