// Field Cleaner object picker — completeness contract.
//
// The shipped bug: the picker loaded ONE page of EntityDefinition (LIMIT 2000,
// no pagination) and then filtered client-side, so in a large managed-package
// org the objects past the cap were not merely hidden — they were never
// fetched, and no amount of typing could reach them. The user's report was
// "I couldn't locate mainly package objects."
//
// These tests pin the three things that make that impossible to reintroduce:
// ranking that surfaces namespaced package objects, a merge that lets a
// server-side lookup repair a capped list, and a summary that never lets
// absence read as non-existence.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction, extractFunctions } from './extract.mjs';

const {
  fcSoqlLit, fcSoqlLike, fcLocalApiName, fcScoreEntry, fcCompareEntries,
  fcRankEntries, fcMergeEntries, fcLooksCapped, fcShouldServerSearch,
  fcObjectSearchSoql,
} = extractFunctions('field-cleaner.js', [
  'fcSoqlLit', 'fcSoqlLike', 'fcLocalApiName', 'fcScoreEntry', 'fcCompareEntries',
  'fcRankEntries', 'fcMergeEntries', 'fcLooksCapped', 'fcShouldServerSearch',
  'fcObjectSearchSoql',
]);
const fcPickerSummary = extractFunction('field-cleaner.js', 'fcPickerSummary');

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'field-cleaner.js'), 'utf8');

// ── Fixtures ────────────────────────────────────────────────
const obj = (api, label) => ({ api, label: label || api, durableId: api });

const FIN_SERV = obj('FinServ__FinancialAccount__c', 'Financial Account');
const NPSP_GAU = obj('npsp__General_Accounting_Unit__c', 'General Accounting Unit');

// A synthetic org bigger than one Tooling page. Names are zero-padded so the
// alphabetical truncation the old code suffered is reproducible exactly.
function bigOrg(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const id = String(i).padStart(5, '0');
    out.push(obj(`Alpha_${id}__c`, `Alpha ${id}`));
  }
  return out;
}

describe('fcSoqlLit / fcSoqlLike — literal escaping', () => {
  it('quotes and escapes a plain value', () => {
    expect(fcSoqlLit('Account')).toBe("'Account'");
  });

  it('escapes single quotes', () => {
    expect(fcSoqlLit("O'Brien")).toBe("'O\\'Brien'");
  });

  it('escapes the backslash FIRST, so an escape char is never re-escaped', () => {
    // Backslash-last ordering would turn \' into \\' and break the literal.
    expect(fcSoqlLit("a\\'b")).toBe("'a\\\\\\'b'");
  });

  it('nulls and undefined become an empty literal, not the word "null"', () => {
    expect(fcSoqlLit(null)).toBe("''");
    expect(fcSoqlLit(undefined)).toBe("''");
  });

  it('wraps a LIKE term in %…%', () => {
    expect(fcSoqlLike('Financial')).toBe("'%Financial%'");
  });

  it('neutralises the LIKE wildcards % and _', () => {
    // Without this, typing "npsp__" matches literally every object in the org.
    expect(fcSoqlLike('npsp__')).toBe("'%npsp\\_\\_%'");
    expect(fcSoqlLike('50%')).toBe("'%50\\%%'");
  });

  it('escapes a namespaced package term correctly end to end', () => {
    expect(fcSoqlLike('General_Accounting')).toBe("'%General\\_Accounting%'");
  });

  it('escapes backslash before the wildcards too', () => {
    expect(fcSoqlLike('a\\_b')).toBe("'%a\\\\\\_b%'");
  });
});

describe('fcLocalApiName — managed-package namespace stripping', () => {
  it('strips a namespace prefix', () => {
    expect(fcLocalApiName('FinServ__FinancialAccount__c')).toBe('FinancialAccount__c');
    expect(fcLocalApiName('npsp__General_Accounting_Unit__c'))
      .toBe('General_Accounting_Unit__c');
  });

  it('leaves a plain custom object alone — __c is a suffix, not a namespace', () => {
    expect(fcLocalApiName('Account__c')).toBe('Account__c');
    expect(fcLocalApiName('My_Object__c')).toBe('My_Object__c');
  });

  it('leaves standard objects alone', () => {
    expect(fcLocalApiName('Account')).toBe('Account');
    expect(fcLocalApiName('Case')).toBe('Case');
  });

  it('handles a namespace that itself contains an underscore', () => {
    expect(fcLocalApiName('sf_devops__Pipeline__c')).toBe('Pipeline__c');
  });

  it('survives null/undefined instead of throwing', () => {
    expect(fcLocalApiName(null)).toBe('');
    expect(fcLocalApiName(undefined)).toBe('');
  });
});

describe('fcScoreEntry — match tiers', () => {
  it('scores an exact api or label match 0', () => {
    expect(fcScoreEntry(obj('Account'), 'Account')).toBe(0);
    expect(fcScoreEntry(obj('Account'), 'account')).toBe(0);
    expect(fcScoreEntry(FIN_SERV, 'Financial Account')).toBe(0);
  });

  it('scores a prefix match 1', () => {
    expect(fcScoreEntry(obj('AccountContactRole'), 'Account')).toBe(1);
    expect(fcScoreEntry(FIN_SERV, 'FinServ')).toBe(1);
  });

  it('scores a post-namespace prefix 2 — admins type the name, not the prefix', () => {
    expect(fcScoreEntry(FIN_SERV, 'FinancialAccount')).toBe(2);
    expect(fcScoreEntry(NPSP_GAU, 'General_Accounting')).toBe(2);
  });

  it('scores a mid-string match 3', () => {
    expect(fcScoreEntry(obj('Legacy_FinancialAccount_Map__c'), 'FinancialAccount')).toBe(3);
  });

  it('returns null when nothing matches', () => {
    expect(fcScoreEntry(obj('Account'), 'zzz')).toBeNull();
  });

  it('treats an empty term as "everything matches"', () => {
    expect(fcScoreEntry(obj('Account'), '')).toBe(0);
    expect(fcScoreEntry(obj('Account'), '   ')).toBe(0);
    expect(fcScoreEntry(obj('Account'), null)).toBe(0);
  });

  it('trims the term — a trailing space must not hide an exact match', () => {
    expect(fcScoreEntry(obj('Account'), '  Account  ')).toBe(0);
  });

  it('returns null for a row with no api and no label', () => {
    expect(fcScoreEntry({}, 'account')).toBeNull();
    expect(fcScoreEntry(null, 'account')).toBeNull();
  });

  it('tolerates a row with no label (EntityDefinition.Label can be null)', () => {
    expect(fcScoreEntry({ api: 'Weird__c' }, 'weird')).toBe(1);
  });
});

describe('fcRankEntries — the ranked list the dropdown slices', () => {
  it('returns every match, in tier order', () => {
    const pool = [
      obj('Legacy_FinancialAccount_Map__c', 'Legacy Map'),
      FIN_SERV,
      obj('FinancialAccountLog__c', 'Financial Account Log'),
    ];
    expect(fcRankEntries(pool, 'FinancialAccount').map(o => o.api)).toEqual([
      'FinancialAccountLog__c',        // tier 1 — plain prefix
      'FinServ__FinancialAccount__c',  // tier 2 — prefix after the namespace
      'Legacy_FinancialAccount_Map__c' // tier 3 — contains
    ]);
  });

  it('sorts an unfiltered pool by label, not by fetch order', () => {
    const pool = [obj('Z__c', 'Zebra'), obj('A__c', 'Apple'), obj('M__c', 'Mango')];
    expect(fcRankEntries(pool, '').map(o => o.label)).toEqual(['Apple', 'Mango', 'Zebra']);
  });

  it('never mutates or returns the input array', () => {
    const pool = [obj('B__c', 'B'), obj('A__c', 'A')];
    const out = fcRankEntries(pool, '');
    expect(out).not.toBe(pool);
    expect(pool.map(o => o.api)).toEqual(['B__c', 'A__c']);
  });

  it('returns [] for a non-array pool instead of throwing', () => {
    expect(fcRankEntries(null, 'a')).toEqual([]);
    expect(fcRankEntries(undefined, '')).toEqual([]);
  });

  it('keeps a package object inside the rendered .slice(0, 60) among 2400 rows', () => {
    // The regression this pins: a namespaced object must not be pushed past the
    // render cut-off by hundreds of alphabetically-earlier contains-matches.
    const pool = bigOrg(2400);
    for (let i = 0; i < 100; i++) {
      pool.push(obj(`Legacy_FinancialAccount_Map_${i}__c`, `Legacy Map ${i}`));
    }
    pool.push(FIN_SERV);

    const ranked = fcRankEntries(pool, 'FinancialAccount');
    expect(ranked.length).toBe(101);
    expect(ranked[0].api).toBe('FinServ__FinancialAccount__c');
    expect(ranked.slice(0, 60).map(o => o.api)).toContain('FinServ__FinancialAccount__c');
  });

  it('handles a >2000-object pool without dropping matches', () => {
    const pool = bigOrg(2400);
    // Alpha_02300__c … Alpha_02399__c — all 100 live past the old 2000 cap.
    expect(fcRankEntries(pool, 'Alpha_023')).toHaveLength(100);
    expect(fcRankEntries(pool, 'Alpha_02307')).toHaveLength(1);
    expect(fcRankEntries(pool, '')).toHaveLength(2400);
  });
});

describe('fcMergeEntries — repairing a capped list with server hits', () => {
  it('appends rows the pool does not have and reports how many', () => {
    const { list, added } = fcMergeEntries([obj('Account')], [NPSP_GAU, FIN_SERV]);
    expect(added).toBe(2);
    expect(list.map(o => o.api)).toEqual([
      'Account', 'npsp__General_Accounting_Unit__c', 'FinServ__FinancialAccount__c',
    ]);
  });

  it('does not duplicate a row the pool already has', () => {
    const { list, added } = fcMergeEntries([FIN_SERV], [FIN_SERV]);
    expect(added).toBe(0);
    expect(list).toHaveLength(1);
  });

  it('dedupes case-insensitively — Salesforce api names are case-insensitive', () => {
    const { added } = fcMergeEntries(
      [obj('FinServ__FinancialAccount__c')],
      [obj('finserv__financialaccount__c')]);
    expect(added).toBe(0);
  });

  it('dedupes within the incoming batch too', () => {
    const { list, added } = fcMergeEntries([], [FIN_SERV, FIN_SERV, NPSP_GAU]);
    expect(added).toBe(2);
    expect(list).toHaveLength(2);
  });

  it('never mutates the pool', () => {
    const pool = [obj('Account')];
    const { list } = fcMergeEntries(pool, [FIN_SERV]);
    expect(pool).toHaveLength(1);
    expect(list).not.toBe(pool);
  });

  it('skips rows with no api name', () => {
    const { list, added } = fcMergeEntries([], [{ label: 'nameless' }, FIN_SERV]);
    expect(added).toBe(1);
    expect(list).toHaveLength(1);
  });

  it('tolerates non-array inputs', () => {
    expect(fcMergeEntries(null, null)).toEqual({ list: [], added: 0 });
    expect(fcMergeEntries(undefined, [FIN_SERV]).added).toBe(1);
  });

  it('scales to a 2400-row pool without dropping the new row', () => {
    const pool = bigOrg(2400);
    const { list, added } = fcMergeEntries(pool, [FIN_SERV, ...pool.slice(0, 500)]);
    expect(added).toBe(1);
    expect(list).toHaveLength(2401);
    expect(fcRankEntries(list, 'FinancialAccount')[0].api)
      .toBe('FinServ__FinancialAccount__c');
  });
});

describe('fcLooksCapped — a result that cannot be proven complete', () => {
  it('flags a result that reached the requested limit', () => {
    expect(fcLooksCapped(12000, 12000)).toBe(true);
    expect(fcLooksCapped(11999, 12000)).toBe(false);
  });

  it('flags a result sitting exactly on the 2000-row Tooling page boundary', () => {
    expect(fcLooksCapped(2000, 12000)).toBe(true);
    expect(fcLooksCapped(4000, 12000)).toBe(true);
    expect(fcLooksCapped(1999, 12000)).toBe(false);
    expect(fcLooksCapped(2001, 12000)).toBe(false);
  });

  it('does not flag an empty or absent result', () => {
    expect(fcLooksCapped(0, 2000)).toBe(false);
    expect(fcLooksCapped(null, 2000)).toBe(false);
    expect(fcLooksCapped(undefined, 2000)).toBe(false);
  });

  it('still flags the page boundary when no limit is supplied', () => {
    expect(fcLooksCapped(2000)).toBe(true);
    expect(fcLooksCapped(300)).toBe(false);
  });
});

describe('fcShouldServerSearch — when to ask the org itself', () => {
  it('stays local for terms under 2 characters', () => {
    expect(fcShouldServerSearch('', 0, [])).toBe(false);
    expect(fcShouldServerSearch('F', 0, [])).toBe(false);
    expect(fcShouldServerSearch('  F  ', 0, [])).toBe(false);
  });

  it('fires when 2+ characters yield nothing locally', () => {
    expect(fcShouldServerSearch('Fi', 0, [])).toBe(true);
    expect(fcShouldServerSearch('FinancialAccount', 0, new Set())).toBe(true);
  });

  it('fires when the local list yields only a few matches', () => {
    // "Few" matters: 3 local hits can still be hiding the one that never loaded.
    expect(fcShouldServerSearch('Fin', 4, [])).toBe(true);
    expect(fcShouldServerSearch('Fin', 5, [])).toBe(false);
    expect(fcShouldServerSearch('Fin', 500, [])).toBe(false);
  });

  it('does not re-ask for a term already completely searched', () => {
    expect(fcShouldServerSearch('Fin', 0, new Set(['fin']))).toBe(false);
    expect(fcShouldServerSearch('FIN', 0, new Set(['fin']))).toBe(false);
  });

  it('does not ask again for a term that CONTAINS a completed term', () => {
    // Every string containing "Fina" also contains "Fin", so a complete %Fin%
    // search already put every %Fina% object in the local pool.
    expect(fcShouldServerSearch('Financial', 0, new Set(['fin']))).toBe(false);
  });

  it('still asks for a term that only OVERLAPS a completed term', () => {
    expect(fcShouldServerSearch('Fi', 0, new Set(['fin']))).toBe(true);
    expect(fcShouldServerSearch('Accounting', 0, new Set(['fin']))).toBe(true);
  });

  it('accepts an array as well as a Set, and tolerates none at all', () => {
    expect(fcShouldServerSearch('Financial', 0, ['fin'])).toBe(false);
    expect(fcShouldServerSearch('Financial', 0, null)).toBe(true);
    expect(fcShouldServerSearch('Financial', 0, undefined)).toBe(true);
  });
});

describe('fcPickerSummary — absence must never read as non-existence', () => {
  it('says nothing when the whole matched list is on screen', () => {
    expect(fcPickerSummary({ shown: 12, matched: 12, total: 400, noun: 'object' })).toBe('');
  });

  it('declares the hidden matches when the render is truncated', () => {
    const s = fcPickerSummary({ shown: 60, matched: 412, total: 5000, noun: 'object' });
    expect(s).toContain('showing 60 of 412 matches');
    expect(s).toContain('keep typing to narrow');
  });

  it('declares a capped fetch with the actual number', () => {
    const s = fcPickerSummary({
      shown: 60, matched: 60, total: 2000, capped: true, noun: 'object',
      capHint: 'Type 2+ characters.',
    });
    expect(s).toContain('2000 objects loaded');
    expect(s).toContain('stopped at exactly 2000');
    expect(s).toContain('incomplete');
    expect(s).toContain('Type 2+ characters.');
  });

  it('declares BOTH a truncated render and a capped fetch at once', () => {
    const s = fcPickerSummary({
      shown: 60, matched: 300, total: 2000, capped: true, noun: 'object',
    });
    expect(s).toContain('showing 60 of 300 matches');
    expect(s).toContain('stopped at exactly 2000');
  });

  it('never claims completeness while a fetch is still running', () => {
    const s = fcPickerSummary({ shown: 5, matched: 5, total: 2000, searching: true, noun: 'object' });
    expect(s).toContain('searching the org…');
  });

  it('pluralises the noun honestly', () => {
    expect(fcPickerSummary({ shown: 1, matched: 1, total: 1, capped: true, noun: 'field' }))
      .toContain('1 field loaded');
    expect(fcPickerSummary({ shown: 2, matched: 2, total: 2, capped: true, noun: 'field' }))
      .toContain('2 fields loaded');
  });

  it('survives a missing/garbage state object', () => {
    expect(fcPickerSummary()).toBe('');
    expect(fcPickerSummary({})).toBe('');
    expect(fcPickerSummary({ shown: null, matched: undefined, total: NaN })).toBe('');
  });
});

describe('fcObjectSearchSoql — the server-side fallback query', () => {
  it('filters on BOTH QualifiedApiName and Label', () => {
    const q = fcObjectSearchSoql('Financial', 200);
    expect(q).toContain("QualifiedApiName LIKE '%Financial%'");
    expect(q).toContain("Label LIKE '%Financial%'");
    expect(q).toContain('FROM EntityDefinition');
  });

  it('keeps the deprecated/hidden filter but NOT the custom-setting filter', () => {
    const q = fcObjectSearchSoql('Fin', 200);
    expect(q).toContain('IsDeprecatedAndHidden = false');
    expect(q).not.toContain('IsCustomSetting');
  });

  it('escapes the term through fcSoqlLike — no injection, no wildcard blowout', () => {
    expect(fcObjectSearchSoql("O'Brien", 200)).toContain("'%O\\'Brien%'");
    expect(fcObjectSearchSoql('npsp__', 200)).toContain("'%npsp\\_\\_%'");
    expect(fcObjectSearchSoql("x' OR Label LIKE '%", 200))
      .toContain("'%x\\' OR Label LIKE \\'\\%%'");
  });

  it('clamps the limit to one Tooling page and defaults sanely', () => {
    expect(fcObjectSearchSoql('Fin', 999999)).toContain('LIMIT 2000');
    expect(fcObjectSearchSoql('Fin', 0)).toContain('LIMIT 200');
    expect(fcObjectSearchSoql('Fin')).toContain('LIMIT 200');
    expect(fcObjectSearchSoql('Fin', -5)).toContain('LIMIT 1');
  });
});

// ── The reported failure, end to end ────────────────────────
describe('the reported bug: a package object past the cap', () => {
  // 5,000-entity org, of which the picker's first page holds only the first
  // 2,000 alphabetically. FinServ__FinancialAccount__c sorts past that.
  const FULL_ORG = [...bigOrg(5000), FIN_SERV, NPSP_GAU];
  const LOADED   = FULL_ORG.slice().sort(fcCompareEntries).slice(0, 2000);

  it('is genuinely unreachable from the loaded page — this was the bug', () => {
    expect(LOADED).toHaveLength(2000);
    expect(fcRankEntries(LOADED, 'FinancialAccount')).toEqual([]);
    expect(fcLooksCapped(LOADED.length, 12000)).toBe(true);
  });

  it('the dropdown says the list is incomplete instead of "No objects found"', () => {
    const s = fcPickerSummary({
      shown: 0, matched: 0, total: LOADED.length, capped: true, noun: 'object',
      capHint: 'Type 2+ characters — anything missing is searched directly in the org.',
    });
    expect(s).toContain('2000 objects loaded');
    expect(s).toContain('incomplete');
  });

  it('the typed term triggers a server search', () => {
    const local = fcRankEntries(LOADED, 'FinancialAccount');
    expect(fcShouldServerSearch('FinancialAccount', local.length, new Set())).toBe(true);
  });

  it('merging the server hit makes it selectable and top-ranked', () => {
    const serverHits = FULL_ORG.filter(o =>
      o.api.toLowerCase().includes('financialaccount') ||
      o.label.toLowerCase().includes('financialaccount'));
    const { list, added } = fcMergeEntries(LOADED, serverHits);
    expect(added).toBe(1);

    const ranked = fcRankEntries(list, 'FinancialAccount');
    expect(ranked[0].api).toBe('FinServ__FinancialAccount__c');
    expect(ranked[0].durableId).toBe('FinServ__FinancialAccount__c'); // selection still works
  });

  it('the cap message still quotes what Salesforce returned, not the grown pool', () => {
    // After a merge the pool is 2001 rows, but Salesforce stopped at 2000 —
    // quoting the pool size would turn an honest number into a false one.
    const { list } = fcMergeEntries(LOADED, [FIN_SERV]);
    expect(list).toHaveLength(2001);
    const s = fcPickerSummary({
      shown: 1, matched: 1, total: LOADED.length, capped: true, noun: 'object',
    });
    expect(s).toContain('stopped at exactly 2000');
    expect(s).not.toContain('2001');
  });

  it('a second, narrower keystroke does not re-hit the server', () => {
    const done = new Set(['financialaccount']);
    expect(fcShouldServerSearch('FinancialAccount_', 0, done)).toBe(false);
  });

  it('works the same for an npsp object with underscores in its name', () => {
    expect(fcRankEntries(LOADED, 'General_Accounting')).toEqual([]);
    const { list } = fcMergeEntries(LOADED, [NPSP_GAU]);
    expect(fcRankEntries(list, 'General_Accounting')[0].api)
      .toBe('npsp__General_Accounting_Unit__c');
    // …and the term reaches SOQL with its underscores neutralised.
    expect(fcObjectSearchSoql('General_Accounting', 200))
      .toContain("'%General\\_Accounting%'");
  });
});

// ── Source guards — the shipped queries themselves ──────────
// These read field-cleaner.js directly because the query builders live inside
// the module IIFE. They exist so the exact regression the user hit (a
// single-page list query) fails the suite rather than the org.
describe('field-cleaner.js query shape', () => {
  it('never loads EntityDefinition with the old single-page LIMIT 2000 literal', () => {
    expect(SRC).not.toContain('ORDER BY Label LIMIT 2000');
  });

  it('no longer excludes custom settings — they have custom fields too', () => {
    // The name may survive in a comment explaining the decision; what must be
    // gone is the WHERE clause that hid them.
    expect(SRC).not.toMatch(/IsCustomSetting\s*=/);
  });

  it('paginates the object list with SF_QUERY_ALL', () => {
    expect(SRC).toMatch(/SF_QUERY_ALL[\s\S]{0,120}objectListSoql\(FC_OBJ_LIMIT\)/);
  });

  it('paginates the FieldDefinition list instead of capping it at 1000', () => {
    // (An older exact-string pin here embedded a hard-coded newline and
    // began matching a DIFFERENT, legitimate per-object query when the
    // file's line endings normalised — the LIMIT-1000 pin below is the
    // real guard.)
    expect(SRC).toMatch(/SF_QUERY_ALL[\s\S]{0,200}FROM FieldDefinition/);
    expect(SRC).not.toMatch(/FieldDefinition[\s\S]{0,200}LIMIT 1000/);
  });

  it('quotes the fetched row count in the cap note, not the merged pool size', () => {
    expect(SRC).toContain('total: _objListCount');
    expect(SRC).not.toContain('total: _allObjects.length');
  });

  it('keeps the __c filter — namespaced package fields still end in __c', () => {
    expect(SRC).toContain("endsWith('__c')");
  });

  it('escapes the EntityDefinitionId filter instead of interpolating raw', () => {
    expect(SRC).toContain('WHERE EntityDefinitionId = ${fcSoqlLit(api)}');
  });
});

// ══════════════════════════════════════════════════════════════════
// Dropdown keyboard honesty (Fable recheck, behaviour audit)
// ══════════════════════════════════════════════════════════════════
describe('dropdown keyboard state survives what the UI does around it', () => {
  it('Enter acts only while the dropdown is VISIBLE — a hidden list must not re-pick', () => {
    // pick() hides the dropdown but keeps its items, so Enter after a mouse
    // pick or Escape used to silently replace the chosen object/field with
    // the top-ranked row.
    expect(SRC).toMatch(/if \(e\.key === 'Enter'\) \{[\s\S]*?if \(!open\) return;/);
  });

  it('both pickers restore the keyboard-active row across an async repaint', () => {
    // The org-search response lands mid-arrow-navigation; innerHTML wipes
    // the active row and aria-activedescendant went stale.
    expect(SRC).toMatch(/function fcRestoreActiveRow\(drop, input, api\)/);
    expect(SRC.match(/fcRestoreActiveRow\(drop, eid\('fcObjInput'\), prevActive\)/g)?.length).toBe(1);
    expect(SRC.match(/fcRestoreActiveRow\(drop, eid\('fcFieldInput'\), prevActive\)/g)?.length).toBe(1);
    // a vanished row CLEARS the descendant reference, never leaves it dangling
    expect(SRC).toMatch(/input\?\.removeAttribute\('aria-activedescendant'\)/);
  });
});

// ══════════════════════════════════════════════════════════════════
// W6 (user 2026-08-05: "ask before any delete operation") — ✂ Remove
// deploys metadata and (for flows) permanently deletes old versions;
// it must confirm first.
// ══════════════════════════════════════════════════════════════════
describe('metadata-mutating fixes confirm before acting', () => {
  it('fixOne gates on sftkConfirmDestructive with the flow-version-deletion truth', () => {
    const i = SRC.indexOf('async function _fixOneRun(');   // 2026-10-05: fixOne is the wrapper that carries the per-item choice
    const fn = SRC.slice(i, SRC.indexOf('\n  }', i));
    expect(fn).toContain('await sftkConfirmDestructive({');
    expect(fn).toContain('permanently deletes flow versions');   // 2026-09-21: the active version may go too, so not only "old" ones
    expect(fn).toMatch(/needsCheckbox: type === 'Flow'/);
    expect(fn).toMatch(/if \(!sure\) return;/);
    // the confirm happens BEFORE the button flips to ⏳
    expect(fn.indexOf('sftkConfirmDestructive')).toBeLessThan(fn.indexOf("_rowBusy(componentId, '⏳ working…')"));
    expect(fn.indexOf("_rowBusy(componentId, '⏳ working…')")).toBeGreaterThan(0);
  });

  it('the field delete itself still runs through the shared destructive confirm', () => {
    expect(SRC).toMatch(/async function confirmDelete\(fieldId\) \{[\s\S]{0,400}?sftkConfirmDestructive\(/);
  });
});

// ── W7 disclosure — the MCD 2,000-row cap reaches the scan RESULTS ───
// fcLooksCapped existed for the object list; the dependency scan itself
// never disclosed that MetadataComponentDependency (beta) stops silently at
// 2,000 rows — "N dependencies" read as a total when it was a floor.
describe('dependency scan discloses the MCD cap', () => {
  it('the MCD result is cap-checked and the banner renders in the results header', () => {
    expect(SRC).toMatch(/_mcdCapped = fcLooksCapped\(deps\.length\)/);
    expect(SRC).toMatch(/This list may be truncated\.<\/strong>/);
    expect(SRC).toMatch(/FLOOR, not a total/);
    // The banner sits with the results header, not buried below the groups.
    expect(SRC.indexOf('This list may be truncated')).toBeLessThan(SRC.indexOf('fc-badge-auto">${autoCount}') + 2000);
  });
});
