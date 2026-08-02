// The SOQL Preview pane tells the truth about how the run reads data.
//
// USER REPORT (2026-08-02): the pane rendered ONE nested relationship query
// whose WHERE clauses were walls of raw record Ids — sitting directly under
// the Lookup-resolution match-field pickers, it read exactly like "records
// are matched across orgs by Id". The engine (executeProfileTransfer) never
// runs that query: it sends ONE query per tree node against the SOURCE org —
// the root filtered by picks/WHERE, each child by its parent-link field IN
// (parent ids, chunked 200 per query) — and Ids never cross orgs: lookups
// resolve via the configured match fields, upsert via the External ID field.
// These tests pin the preview to the engine's real shape and to saying so.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunctions } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILDER = readFileSync(join(root, 'studio-builder.js'), 'utf8');

// buildRunSOQL's only free variable is esc — extraction resolves it off
// globalThis at call time, so a faithful stub is enough.
const { buildRunSOQL } = extractFunctions('studio-builder.js', ['buildRunSOQL']);

beforeAll(() => {
  globalThis.esc = s => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
});
afterAll(() => { delete globalThis.esc; });

const IDS = Array.from({ length: 34 }, (_, i) => `001aj00002VPbB${String(i).padStart(3, '0')}`);

describe('buildRunSOQL — mirrors the engine, never implies Id matching', () => {
  it('picked records render as a count, not a wall of raw source-org Ids', () => {
    const html = buildRunSOQL({ objectType: 'Account', recordIds: IDS }, null, null);
    expect(html).toContain('the 34 record(s) you picked');
    expect(html).not.toContain('001aj00002VPbB000');
  });

  it('children are SEPARATE queries scoped by the parent-link field — no nested relationship subquery', () => {
    const tree = { objectType: 'Account', recordIds: IDS, children: [
      { childSObject: 'Case', field: 'AccountId', recordIds: ['500x'] },
      { childSObject: 'Contact', field: 'AccountId' },
    ] };
    const html = buildRunSOQL(tree, null, null);
    expect(html).not.toContain('(SELECT');                        // the old nested form
    expect(html).not.toMatch(/>Cases</);                          // relationship-name query
    expect(html.match(/ds-soql-code/g)).toHaveLength(3);          // Account, Case, Contact
    expect(html).toContain('the Account Ids fetched above — 200 per query');
    expect(html).toContain('scoped to the Account records above');
  });

  it('a child with no parent-link field runs unscoped — mirrored, not invented', () => {
    const tree = { objectType: 'Account', children: [{ childSObject: 'Note' }] };
    const html = buildRunSOQL(tree, null, null);
    expect(html).not.toContain('fetched above');
    expect(html.match(/fetched from the source org/g)).toHaveLength(2);
  });

  it('picked records beat the free-form WHERE (engine rule); a lone WHERE passes through escaped', () => {
    const both = buildRunSOQL({ objectType: 'Account', where: "Industry = 'Tech'", recordIds: ['001x'] }, null, null);
    expect(both).toContain('the 1 record(s) you picked');
    expect(both).not.toContain('Industry');
    const onlyWhere = buildRunSOQL({ objectType: 'Account', where: "Industry = 'Tech'" }, null, null);
    expect(onlyWhere).toContain('Industry = &#39;Tech&#39;');
  });

  it('SELECT tells the truth — the engine copies all copyable fields, with the mapping count', () => {
    const html = buildRunSOQL({ objectType: 'Account', fieldMappings: { A: 1, B: 1 } }, null, null);
    expect(html).toContain('all copyable fields · 2 mapped');
  });
});

describe('the pane copy', () => {
  it('says the queries read the SOURCE org and that Ids never cross orgs', () => {
    expect(BUILDER).toContain('How records are read from the source org');
    expect(BUILDER).toContain('never used to match or write across orgs');
    expect(BUILDER).toContain('Lookup resolution');
  });

  it('the old nested-subquery builder is gone', () => {
    expect(BUILDER).not.toContain('function buildNestedSOQL');
  });
});
