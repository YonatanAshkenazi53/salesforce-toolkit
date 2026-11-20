// QA 1.1 finding 51: a flow whose label changed between versions keeps every version on the Versions list.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const { sftkFlowListRows: rowsOf, sftkFlowListWholeBlocks: whole } = extractFunctions('popup.js', ['sftkFlowListRows', 'sftkFlowListWholeBlocks']);
const { sftkFlowTreeOrder: order, sftkFlowTreeBlocks: blocksOf } = extractFunctions('sftk-flowbulk.js', ['sftkFlowTreeOrder', 'sftkFlowTreeBlocks']);
const SRC = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');

const v = (Id, MasterLabel, ApiName, VersionNumber, DefinitionId) => ({ Id, MasterLabel, ApiName, VersionNumber, DefinitionId, Status: 'Obsolete' });
// groupFlows(): versions keyed by MasterLabel
const group = flows => { const g = {}; for (const f of flows) (g[f.MasterLabel] = g[f.MasterLabel] || []).push(f); return g; };
const drawnIds = (rows, calls) => whole(blocksOf(order(rows, calls || {})), rows).flatMap(b => b.rows.flatMap(e => e.row.versions.map(x => x.Id))).sort();

describe('a flow renamed in a later version', () => {
  const flows = [
    v('301', 'Acct sync (old name)', 'Acct_Sync', 1, '300A'),
    v('302', 'Acct sync (old name)', 'Acct_Sync', 2, '300A'),
    v('303', 'Account Sync', 'Acct_Sync', 3, '300A'),
    v('311', 'Other', 'Other', 1, '300B'),
  ];
  const rows = rowsOf(group(flows));

  it('is one row with all its versions, named as its newest version is named', () => {
    expect(rows.map(r => [r.apiName, r.label, r.versions.map(x => x.VersionNumber)])).toEqual([
      ['Acct_Sync', 'Account Sync', [1, 2, 3]],
      ['Other', 'Other', [1]],
    ]);
    expect(rows[0].labels.sort()).toEqual(['Account Sync', 'Acct sync (old name)']);
  });

  it('every version of it reaches the drawn list, alone and inside a tree', () => {
    expect(drawnIds(rows)).toEqual(['301', '302', '303', '311']);
    expect(drawnIds(rows, { Other: ['Acct_Sync'] })).toEqual(['301', '302', '303', '311']);
  });

  it('no API name appears on two rows', () => {
    expect(new Set(rows.map(r => r.apiName)).size).toBe(rows.length);
  });
});

describe('two different flows that share an API name', () => {
  // a packaged and an own flow of one name, and two labels with no definition that fall back to one name
  const flows = [
    v('401', 'Onboard (ours)', 'Onboard', 1, '300OWN'),
    v('402', 'Onboard (package)', 'Onboard', 1, '300PKG'),
    v('501', 'A-B', 'A_B', 1, null),
    v('502', 'A B', 'A_B', 1, null),
  ];
  const rows = rowsOf(group(flows));

  it('stay separate rows', () => {
    expect(rows.map(r => r.label)).toEqual(['A B', 'A-B', 'Onboard (ours)', 'Onboard (package)']);
  });

  it('the tree order alone drops the second of each — the list puts it back as a row of its own', () => {
    const fromTree = blocksOf(order(rows, {}));
    expect(fromTree.length).toBe(2);
    const all = whole(fromTree, rows);
    expect(all.length).toBe(4);
    expect(all.every(b => b.rows.length === 1 && b.rows[0].depth === 0)).toBe(true);
    expect(drawnIds(rows)).toEqual(['401', '402', '501', '502']);
  });
});

describe('an ordinary org', () => {
  it('one row per flow, in label order, versions as loaded', () => {
    const rows = rowsOf(group([v('2', 'Beta', 'Beta', 1, 'B'), v('3', 'Beta', 'Beta', 2, 'B'), v('1', 'Alpha', 'Alpha', 1, 'A')]));
    expect(rows.map(r => [r.label, r.labels, r.versions.map(x => x.Id)])).toEqual([['Alpha', ['Alpha'], ['1']], ['Beta', ['Beta'], ['2', '3']]]);
  });
  it('whole() adds nothing when the tree drew every row', () => {
    const rows = rowsOf(group([v('1', 'Alpha', 'Alpha', 1, 'A'), v('2', 'Beta', 'Beta', 1, 'B')]));
    const b = blocksOf(order(rows, { Alpha: ['Beta'] }));
    expect(whole(b, rows)).toEqual(b);
  });
});

describe('renderFlowList', () => {
  const fn = SRC.slice(SRC.indexOf('function renderFlowList('), SRC.indexOf('function buildTreeBox('));
  it('builds its rows with sftkFlowListRows and draws every one of them', () => {
    expect(fn).toContain('const rows = sftkFlowListRows(flowGroups);');
    expect(fn).toContain('const blocks = sftkFlowListWholeBlocks(');
  });
  it('the search matches any label the flow carries', () => {
    expect(fn).toContain('row.labels.some(label => sftkFlowFilterHit(search, sftkFlowFilterKey(label, row.apiName)))');
  });
});
