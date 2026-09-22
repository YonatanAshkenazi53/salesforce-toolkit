// 2026-09-22 — History card: "2 updated", nothing failed, status PARTIAL, and
// a 🔗 disclosure line painted red. runReconcile counted every ⚠/🔗 warning as
// a hard error (only ℹ was exempt) while History's card called them notes.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions, extractFunction } from './extract.mjs';

const H = readFileSync(new URL('../studio-history.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../studio.css', import.meta.url), 'utf8');
const { sftkRunLineIsError: isErr } = extractFunctions('studio-reconcile.js', ['sftkRunLineIsError'], { 'sftk-friendly-error.js': ['sftkFriendlyError', 'sftkDecodeEntities'] });
const hints = extractFunction('studio-history.js', 'sftkSkipHints');

describe('a run that wrote every record is not "partial" because of a note', () => {
  it('⚠ skipped fields, 🔗 lookups by name, 📎 files and ℹ engine notes are notes', () => {
    expect(isErr("update: 🔗 2 lookup(s) included and resolved by matching: ParentId (by Name) — exclude one in Fields & mapping (✕) if it must not be touched.")).toBe(false);
    expect(isErr("update: ⚠ skipped 1 mapped field(s) the target org can't accept: SFTK_FC_Test_Status__c → SFTK_FC_Test_Status__c (missing in target) — open ✏ Edit → Fields & mapping to fix")).toBe(false);
    expect(isErr('push: ℹ Account: 📎 3 already-in-target record(s) skipped for files')).toBe(false);
  });
  it('work not done is still an error', () => {
    expect(isErr('Source update failed: HTTP 431')).toBe(true);
    expect(isErr('update: Account: REQUIRED_FIELD_MISSING: Name (×2)')).toBe(true);
    expect(isErr('')).toBe(true);
  });
  it('the card paints notes amber, not red, and the fold says lines not errors', () => {
    expect(H).toContain('<div class="ds-history-note-row" title="${esc(n.raw)}">');
    expect(H).toContain("<details class=\"ds-history-errors${fails.length ? '' : ' ds-history-errors--notes'}\">");
    expect(H).toContain('raw lines (for support / copy-paste)');
    expect(CSS).toContain('.ds-history-note-row {');
    expect(CSS).toContain('.ds-history-errors--notes summary {');
  });
  it('the skipped-field hint follows the reason', () => {
    const missing = [{ fields: [{ field: 'SFTK_FC_Test_Status__c', reason: 'missing in target' }] }];
    expect(hints(missing)).toHaveLength(1);
    expect(hints(missing)[0]).toContain('create the field there, or exclude it (✕)');
    expect(hints(missing)[0]).not.toContain('🧹');
    const stale = [{ fields: [{ field: 'Old__c', reason: 'no longer exists in the source org' }] }];
    expect(hints(stale)[0]).toContain('🧹');
    const both = [...missing, ...stale, { fields: [{ field: 'X', reason: 'read-only in target' }] }];
    expect(hints(both)).toHaveLength(3);
    expect(hints([])).toEqual([]);
  });
});
