// Scale-UX honesty: the pure decisions behind two large-org fixes.
//
//  · apex-debugger.js  — the trace-flag user dropdown used to run LIMIT 10 and
//    render the 10 rows as if they were every match. It now fetches 11 and the
//    11th row's ONLY job is to trigger a "more exist" footer. These tests pin
//    the N+1 decision (never claim completeness, never invent a total) and the
//    footer wording, plus the SOQL itself — the bug WAS the literal LIMIT 10,
//    so a regression there has to fail a test.
//
//  · studio-picklists.js — the bulk wizard's per-org automation scan painted
//    once at the end (frozen "Computing…") and had no staleness guard, so a
//    re-opened modal could be overwritten by the run it superseded. These tests
//    pin the progressive header (which must never imply un-scanned orgs are
//    clean) and the token guard.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(root, f), 'utf8');

const sftkOverflowRows    = extractFunction('apex-debugger.js', 'sftkOverflowRows');
const sftkMoreMatchesNote = extractFunction('apex-debugger.js', 'sftkMoreMatchesNote');
const pkScanProgressText  = extractFunction('studio-picklists.js', 'pkScanProgressText');
const pkScanSuperseded    = extractFunction('studio-picklists.js', 'pkScanSuperseded');

const users = n => Array.from({ length: n }, (_, i) => ({ Id: `005${i}`, Name: `User ${i}` }));

// ════════════════════════════════════════════════════════════════
describe('sftkOverflowRows — "the N+1th row means more exist"', () => {
  it('fewer rows than the cap: everything shown, nothing claimed missing', () => {
    const r = sftkOverflowRows(users(3), 10);
    expect(r.rows).toHaveLength(3);
    expect(r.more).toBe(false);
  });

  it('EXACTLY the cap is NOT overflow — the org fits, so no footer', () => {
    // The whole point of asking for cap+1: a full page of `cap` rows is the
    // ambiguous case under the old LIMIT 10, and it is the common one.
    const r = sftkOverflowRows(users(10), 10);
    expect(r.rows).toHaveLength(10);
    expect(r.more).toBe(false);
  });

  it('cap+1 rows back: render the first cap, flag that more exist', () => {
    const r = sftkOverflowRows(users(11), 10);
    expect(r.rows).toHaveLength(10);
    expect(r.rows[9].Name).toBe('User 9');
    expect(r.more).toBe(true);
  });

  it('the (cap+1)th record is NEVER handed to the renderer', () => {
    const r = sftkOverflowRows(users(11), 10);
    expect(r.rows.some(u => u.Name === 'User 10')).toBe(false);
  });

  it('reports overflow as a boolean only — it cannot be read as a count', () => {
    // Honesty rule: one extra row proves "more", it does not measure how many.
    // Whether the org has 11 users or 40,000, the signal is identical.
    expect(sftkOverflowRows(users(11), 10)).toEqual(sftkOverflowRows(users(11), 10));
    expect(sftkOverflowRows(users(11), 10).more).toBe(true);
    expect(typeof sftkOverflowRows(users(11), 10).more).toBe('boolean');
  });

  it('survives a missing/error payload without inventing rows', () => {
    for (const bad of [undefined, null, 'nope', {}, 0]) {
      const r = sftkOverflowRows(bad, 10);
      expect(r.rows).toEqual([]);
      expect(r.more).toBe(false);
    }
  });

  it('a garbage cap degrades to showing nothing, never to hiding overflow', () => {
    const r = sftkOverflowRows(users(5), undefined);
    expect(r.rows).toEqual([]);
    expect(r.more).toBe(true);   // 5 rows exist and none are shown — say so
  });

  it('a numeric-string cap works (10 vs "10" must not change the verdict)', () => {
    expect(sftkOverflowRows(users(11), '10')).toEqual(sftkOverflowRows(users(11), 10));
  });
});

// ════════════════════════════════════════════════════════════════
describe('sftkMoreMatchesNote — footer only when something was cut', () => {
  it('no overflow → empty string, so no footer node is rendered at all', () => {
    expect(sftkMoreMatchesNote(false, true)).toBe('');
    expect(sftkMoreMatchesNote(false, false)).toBe('');
  });

  it('typed-search overflow tells the user how to reach the missing row', () => {
    const t = sftkMoreMatchesNote(true, false);
    expect(t).toMatch(/more matches/i);
    expect(t).toMatch(/keep typing/i);
  });

  it('suggestion-list overflow says the list is a sample, not the org', () => {
    const t = sftkMoreMatchesNote(true, true);
    expect(t).toMatch(/more active users exist/i);
    expect(t).toMatch(/narrow/i);
  });

  it('never states a total — no digits in either footer', () => {
    expect(sftkMoreMatchesNote(true, true)).not.toMatch(/\d/);
    expect(sftkMoreMatchesNote(true, false)).not.toMatch(/\d/);
  });
});

// ════════════════════════════════════════════════════════════════
describe('_searchUsers SOQL — the fix is the LIMIT, so pin the LIMIT', () => {
  const src = read('apex-debugger.js');
  const body = src.slice(src.indexOf('async function _searchUsers('),
                         src.indexOf('// ── Trace management'));

  it('the region under test was actually found', () => {
    expect(body.length).toBeGreaterThan(200);
    expect(body).toContain('adbgUserDrop');
  });

  it('renders 10 rows but asks the server for 11', () => {
    expect(src).toMatch(/const USER_DROP_SHOWN = 10;/);
    expect(body).toContain('const lim = USER_DROP_SHOWN + 1;');
  });

  it('BOTH branches use the N+1 limit — suggestion list and typed search', () => {
    const lims = body.match(/LIMIT \$\{lim\}/g) || [];
    expect(lims).toHaveLength(2);
    expect(body).toContain('ORDER BY LastLoginDate DESC NULLS LAST LIMIT ${lim}');
    expect(body).toContain('ORDER BY Name LIMIT ${lim}');
  });

  it('no hard-coded LIMIT 10 survives in either branch', () => {
    expect(body).not.toMatch(/LIMIT 10\b/);
  });

  it('the footer is not a selectable option (click wiring binds .adbg-uopt)', () => {
    // The footer row must carry adbg-drop-msg, NOT adbg-uopt, or clicking
    // "more matches…" would select a user with an undefined Id.
    const footer = body.slice(body.indexOf('moreNote ?'));
    expect(footer).toContain('adbg-drop-msg');
    expect(footer.slice(0, footer.indexOf('</div>'))).not.toContain('adbg-uopt');
    expect(body).toContain("d.querySelectorAll('.adbg-uopt')");
  });
});

// ════════════════════════════════════════════════════════════════
describe('pkScanProgressText — progress that cannot overstate itself', () => {
  it('start of a 5-org run: 0 of 5, explicitly unfinished', () => {
    const t = pkScanProgressText(0, 5, 0, 'this value');
    expect(t).toContain('scanned 0 of 5 org(s)');
    expect(t).toContain('…');
    expect(t).toContain('this value');
  });

  it('mid-run says how many are DONE, not how many exist', () => {
    expect(pkScanProgressText(2, 5, 0, 'this value')).toContain('scanned 2 of 5 org(s)');
  });

  it('the trailing ellipsis is dropped only when every org is done', () => {
    expect(pkScanProgressText(4, 5, 0, 'this value').endsWith('…')).toBe(true);
    expect(pkScanProgressText(5, 5, 0, 'this value').endsWith('…')).toBe(false);
    expect(pkScanProgressText(5, 5, 0, 'this value')).toContain('scanned 5 of 5 org(s)');
  });

  it('failed orgs are reported at the end — never silently dropped', () => {
    const t = pkScanProgressText(5, 5, 2, 'this value');
    expect(t).toMatch(/2 org\(s\) could NOT be checked/);
    expect(t).toContain('⚠');
  });

  it('a clean full run carries no warning', () => {
    expect(pkScanProgressText(5, 5, 0, 'this value')).not.toContain('⚠');
    expect(pkScanProgressText(5, 5, 0, 'this value')).not.toMatch(/could NOT/);
  });

  it('multi-value bulk names WHICH value the scan covered', () => {
    // Only values[0] is scanned; the header must not imply all of them were.
    expect(pkScanProgressText(3, 3, 0, 'the first value')).toContain('the first value');
  });

  it('zero orgs says so instead of rendering a hollow 0 of 0 header', () => {
    expect(pkScanProgressText(0, 0, 0, 'this value')).toMatch(/nothing to scan/i);
  });

  it('garbage counters degrade to safe text, never to NaN on screen', () => {
    for (const t of [pkScanProgressText(undefined, 5, null, 'this value'),
                     pkScanProgressText('2', '5', '1', 'this value'),
                     pkScanProgressText(-3, 5, -1, 'this value')]) {
      expect(t).not.toMatch(/NaN|undefined|null/);
    }
    expect(pkScanProgressText('2', '5', '1', 'this value')).toContain('scanned 2 of 5 org(s)');
  });
});

// ════════════════════════════════════════════════════════════════
describe('pkScanSuperseded — a stale run must never paint', () => {
  it('the live run is allowed to paint', () => {
    expect(pkScanSuperseded(7, 7)).toBe(false);
  });

  it('a run superseded by a re-opened modal abandons', () => {
    expect(pkScanSuperseded(7, 8)).toBe(true);
  });

  it('and so does a run from BEFORE the current one, whatever the order', () => {
    expect(pkScanSuperseded(8, 7)).toBe(true);
  });

  it('fails closed on a non-numeric token — when in doubt, do not paint', () => {
    for (const [a, b] of [[undefined, 1], [1, undefined], ['1', 1], [NaN, NaN], [null, null]]) {
      expect(pkScanSuperseded(a, b)).toBe(true);
    }
  });

  it('models the real race: run A, re-open (B), A finishes last and is dropped', () => {
    let live = 0;
    const tokenA = ++live;          // wizard opened
    const tokenB = ++live;          // wizard re-opened while A was mid-scan
    expect(pkScanSuperseded(tokenB, live)).toBe(false);  // B paints
    expect(pkScanSuperseded(tokenA, live)).toBe(true);   // A, landing later, does not
  });
});

// ════════════════════════════════════════════════════════════════
describe('bulk wizard scan — wired progressively and guarded', () => {
  const src = read('studio-picklists.js');
  const body = src.slice(src.indexOf('async function _pkOpenBulkWizard('),
                         src.indexOf('async function _pkApplyBulk('));

  it('the region under test was actually found', () => {
    expect(body).toContain('dsPkBulkImpact');
  });

  it('no longer buffers every org and paints once at the end', () => {
    expect(body).not.toContain('parts.push');
    expect(body).not.toContain('Computing automation impact per org');
  });

  it('captures a token and checks it before every paint', () => {
    expect(body).toContain('++_pkBulkScanToken');
    expect(body).toContain('pkScanSuperseded(scanToken, _pkBulkScanToken)');
    expect(src).toMatch(/let _pkBulkScanToken = 0;/);
  });

  it('appends one row per org and refreshes the progress header each time', () => {
    expect(body).toContain('rows.appendChild(row)');
    expect(body).toContain('pkScanProgressText(done, orgs.length, failed, scanSubject)');
  });

  it('a thrown org still gets a line saying it is UNKNOWN, not clean', () => {
    expect(body).toContain('catch (e)');
    expect(body).toContain('treat this org as UNKNOWN, not clean');
  });

  it('surfaces the literal scan\'s own coverage gaps (its 40-flow cap)', () => {
    // _pkValueLiteralScan already reports what it could not reach in notes[];
    // the per-org line has to print them or a capped scan reads as complete.
    expect(body).toContain('lit.notes');
  });
});
