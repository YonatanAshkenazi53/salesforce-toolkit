// N5b — Labs graduation: Schema View org-diff + Field Audit cross-org compare.
//
// These cover the PURE decision logic behind the two new capabilities. The
// point of both is that "I could not check this" must never come back looking
// like "there is nothing there" — so most of these tests are about the
// unknown/absent distinction, not the happy path.
import { describe, it, expect } from 'vitest';
import { extractFunction } from './extract.mjs';

describe('svRelEdges (studio-schema.js) — relationship edges, one builder for both diff sides', () => {
  const svRelEdges = extractFunction('studio-schema.js', 'svRelEdges');

  const desc = {
    Account: {
      childRelationships: [
        { childSObject: 'Contact',  relationshipName: 'Contacts',  cascadeDelete: false },
        { childSObject: 'Invoice__c', relationshipName: 'Invoices', cascadeDelete: true },
        { childSObject: 'NotGraphed__c', relationshipName: 'Ignored', cascadeDelete: false },
      ],
    },
    Contact:    { childRelationships: [] },
    Invoice__c: { childRelationships: [] },
  };

  it('builds child→parent edges and types them by cascadeDelete', () => {
    const edges = svRelEdges(['Account', 'Contact', 'Invoice__c'], desc);
    expect(edges).toContainEqual({ from: 'Contact', to: 'Account', label: 'Contacts', edgeType: 'lookup' });
    expect(edges).toContainEqual({ from: 'Invoice__c', to: 'Account', label: 'Invoices', edgeType: 'master-detail' });
  });

  it('drops relationships whose child is not in the graph', () => {
    const edges = svRelEdges(['Account', 'Contact', 'Invoice__c'], desc);
    expect(edges.some(e => e.from === 'NotGraphed__c')).toBe(false);
  });

  it('collapses duplicate child→parent pairs to one edge', () => {
    const dupes = { Account: { childRelationships: [
      { childSObject: 'Contact', relationshipName: 'Contacts',    cascadeDelete: false },
      { childSObject: 'Contact', relationshipName: 'SecondaryFor', cascadeDelete: false },
    ] }, Contact: {} };
    expect(svRelEdges(['Account', 'Contact'], dupes)).toHaveLength(1);
  });

  it('an object with NO describe entry contributes no edges (and does not throw)', () => {
    expect(svRelEdges(['Account', 'Missing__c'], { Account: {} })).toEqual([]);
    expect(svRelEdges(null, null)).toEqual([]);
  });
});

describe('svFlowActionEdges (studio-schema.js)', () => {
  const svFlowActionEdges = extractFunction('studio-schema.js', 'svFlowActionEdges');

  it('keeps only actions whose both ends are graphed, and dedupes by flow', () => {
    const acts = [
      { fromObj: 'Account', toObj: 'Contact',  flowName: 'F1', action: 'creates' },
      { fromObj: 'Account', toObj: 'Contact',  flowName: 'F1', action: 'updates' },  // same flow+pair
      { fromObj: 'Account', toObj: 'Contact',  flowName: 'F2', action: 'updates' },  // different flow
      { fromObj: 'Account', toObj: 'Offgraph__c', flowName: 'F3', action: 'creates' },
    ];
    const edges = svFlowActionEdges(acts, ['Account', 'Contact']);
    expect(edges.map(e => e.label)).toEqual(['F1', 'F2']);
    expect(edges[0].edgeType).toBe('flow-action');
  });

  it('degrades to [] on junk input', () => {
    expect(svFlowActionEdges(null, null)).toEqual([]);
  });
});

describe('svDiffGraphs (studio-schema.js) — org-diff overlay', () => {
  const svDiffGraphs = extractFunction('studio-schema.js', 'svDiffGraphs');

  const side = (objects, edges, extra = {}) =>
    ({ objects, edges, flowsLoaded: true, flowActionsScanned: true, ...extra });
  const obj = (id, flowCount = 0, described = true) => ({ id, described, flowCount });

  it('classifies objects as both / only here / only there', () => {
    const a = side([obj('Account'), obj('Here__c')], []);
    const b = side([obj('Account'), obj('There__c')], []);
    const d = svDiffGraphs(a, b);
    const by = Object.fromEntries(d.nodes.map(n => [n.id, n.status]));
    expect(by.Account).toBe('both');
    expect(by.Here__c).toBe('only-a');
    expect(by.There__c).toBe('only-b');
    expect(d.counts).toMatchObject({ nodesBoth: 1, nodesOnlyA: 1, nodesOnlyB: 1 });
  });

  it('matches object ids case-insensitively (Salesforce API names are not case-stable across sources)', () => {
    const d = svDiffGraphs(side([obj('MyObj__c')], []), side([obj('myobj__c')], []));
    expect(d.counts.nodesBoth).toBe(1);
    expect(d.counts.nodesOnlyA).toBe(0);
  });

  it('an edge missing on the other side is "only here" ONLY when both endpoints were described there', () => {
    const edge = { from: 'Contact', to: 'Account', edgeType: 'lookup', label: 'Contacts' };
    const ok = svDiffGraphs(
      side([obj('Account'), obj('Contact')], [edge]),
      side([obj('Account'), obj('Contact')], []));
    expect(ok.edges[0].status).toBe('only-a');

    // Same input, except Contact's describe FAILED in the compare org.
    const blind = svDiffGraphs(
      side([obj('Account'), obj('Contact')], [edge]),
      side([obj('Account'), obj('Contact', 0, false)], []));
    expect(blind.edges[0].status).toBe('unknown');
    expect(blind.edges[0].reason).toMatch(/could not be described/);
  });

  it('an edge to an object that genuinely does not exist there stays "only here"', () => {
    const edge = { from: 'Here__c', to: 'Account', edgeType: 'lookup', label: 'R' };
    const d = svDiffGraphs(
      side([obj('Account'), obj('Here__c')], [edge]),
      side([obj('Account')], []));
    expect(d.edges[0].status).toBe('only-a');
  });

  it('a lookup that became a master-detail is reported as present in BOTH, changed — not as add+remove', () => {
    const d = svDiffGraphs(
      side([obj('Account'), obj('Contact')], [{ from: 'Contact', to: 'Account', edgeType: 'lookup', label: 'R' }]),
      side([obj('Account'), obj('Contact')], [{ from: 'Contact', to: 'Account', edgeType: 'master-detail', label: 'R2' }]));
    expect(d.edges).toHaveLength(1);
    expect(d.edges[0].status).toBe('both');
    expect(d.edges[0].typeDiff).toBe(true);
    expect(d.edges[0].labelDiff).toBe(true);
    expect(d.counts.edgesChanged).toBe(1);
  });

  it('flow counts: same / differs / unknown when either side did not load flows', () => {
    const same = svDiffGraphs(side([obj('Account', 3)], []), side([obj('Account', 3)], []));
    expect(same.nodes[0].flowStatus).toBe('same');

    const diff = svDiffGraphs(side([obj('Account', 3)], []), side([obj('Account', 5)], []));
    expect(diff.nodes[0].flowStatus).toBe('differs');
    expect(diff.counts.flowsDiffer).toBe(1);

    const blind = svDiffGraphs(
      side([obj('Account', 3)], []),
      side([obj('Account', 0)], [], { flowsLoaded: false }));
    expect(blind.nodes[0].flowStatus).toBe('unknown');
    expect(blind.counts.flowsDiffer).toBe(0);
    expect(blind.uncomparable.join(' ')).toMatch(/Flow counts were NOT compared/);
  });

  it('flow-action edges are "unknown" whenever the deep scan did not run on both sides', () => {
    const fa = { from: 'Account', to: 'Contact', edgeType: 'flow-action', label: 'My Flow' };
    const d = svDiffGraphs(
      side([obj('Account'), obj('Contact')], [fa]),
      side([obj('Account'), obj('Contact')], [], { flowActionsScanned: false }));
    expect(d.edges[0].status).toBe('unknown');
    expect(d.counts.edgesOnlyA).toBe(0);
    expect(d.uncomparable.join(' ')).toMatch(/flow-action edges were NOT compared/i);
  });

  it('an object described in neither org is counted as not-comparable and named', () => {
    const d = svDiffGraphs(
      side([obj('Weird__c', 0, false)], []),
      side([obj('Weird__c', 0, false)], []));
    expect(d.counts.nodesBoth).toBe(1);
    expect(d.counts.nodesUncomparable).toBe(1);
    expect(d.nodes[0].comparable).toBe(false);
    expect(d.uncomparable.join(' ')).toMatch(/Weird__c/);
  });

  it('degrades on junk input instead of throwing', () => {
    const d = svDiffGraphs(null, undefined);
    expect(d.nodes).toEqual([]);
    expect(d.edges).toEqual([]);
    expect(d.counts.nodesBoth).toBe(0);
  });
});

describe('faCompareFillRates (studio-fields.js) — cross-org fill-rate compare', () => {
  const faCompareFillRates = extractFunction('studio-fields.js', 'faCompareFillRates');

  const cell = (pct, filled = 10, total = 100) => ({ pct, filled, total, error: '' });

  it('flags the dangerous case: empty here, heavily used in another org', () => {
    const rows = faCompareFillRates([
      { orgUrl: 'a', label: 'Dev',  ok: true, fields: { Legacy__c: cell(0, 0, 500) } },
      { orgUrl: 'b', label: 'Prod', ok: true, fields: { Legacy__c: cell(87, 870, 1000) } },
    ]);
    expect(rows[0].api).toBe('Legacy__c');
    expect(rows[0].verdict).toBe('used-elsewhere');
    expect(rows[0].min).toBe(0);
    expect(rows[0].max).toBe(87);
    expect(rows[0].spread).toBe(87);
    expect(rows[0].comparableOrgs).toBe(2);
  });

  it('sorts "empty here / used there" above everything else', () => {
    const rows = faCompareFillRates([
      { orgUrl: 'a', label: 'Dev',  ok: true, fields: { Busy__c: cell(60), Dead__c: cell(0, 0, 10), Risky__c: cell(0, 0, 10) } },
      { orgUrl: 'b', label: 'Prod', ok: true, fields: { Busy__c: cell(65), Dead__c: cell(0, 0, 10), Risky__c: cell(90) } },
    ]);
    expect(rows.map(r => r.api)).toEqual(['Risky__c', 'Dead__c', 'Busy__c']);
    expect(rows[1].verdict).toBe('unused-everywhere');
    expect(rows[2].verdict).toBe('used');
  });

  it('a field ABSENT in one org is unknown there — never 0%', () => {
    const rows = faCompareFillRates([
      { orgUrl: 'a', label: 'Dev',  ok: true, fields: { Only_Here__c: cell(40) } },
      { orgUrl: 'b', label: 'Prod', ok: true, fields: {} },
    ]);
    const there = rows[0].cells[1];
    expect(there.known).toBe(false);
    expect(there.pct).toBeNull();
    expect(there.reason).toBe('the field does not exist in this org');
    expect(rows[0].missingIn).toEqual(['Prod']);
    expect(rows[0].comparableOrgs).toBe(1);
    expect(rows[0].verdict).toBe('single-org');
  });

  it('an org that could not be measured makes ALL of its cells unknown, carrying the org error', () => {
    const rows = faCompareFillRates([
      { orgUrl: 'a', label: 'Dev',  ok: true, fields: { F__c: cell(0, 0, 10) } },
      { orgUrl: 'b', label: 'Prod', ok: false, error: 'not open in a Chrome tab', fields: {} },
    ]);
    expect(rows[0].cells[1].known).toBe(false);
    expect(rows[0].cells[1].reason).toBe('not open in a Chrome tab');
    // Only one org was comparable, so it must NOT claim "empty everywhere".
    expect(rows[0].verdict).toBe('single-org');
  });

  it('a field the org rejected for COUNT() (pct -1) is unknown, not 0%', () => {
    const rows = faCompareFillRates([
      { orgUrl: 'a', label: 'Dev',  ok: true, fields: { Enc__c: { pct: -1, filled: null, total: null, error: 'aggregate not supported' } } },
      { orgUrl: 'b', label: 'Prod', ok: true, fields: { Enc__c: cell(50) } },
    ]);
    expect(rows[0].cells[0].known).toBe(false);
    expect(rows[0].cells[0].reason).toBe('aggregate not supported');
    expect(rows[0].comparableOrgs).toBe(1);
  });

  it('nothing measurable anywhere = "unknown", not "unused everywhere"', () => {
    const rows = faCompareFillRates([
      { orgUrl: 'a', label: 'Dev',  ok: false, error: 'offline', fields: { F__c: null } },
      { orgUrl: 'b', label: 'Prod', ok: false, error: 'offline', fields: { F__c: null } },
    ]);
    expect(rows[0].verdict).toBe('unknown');
    expect(rows[0].min).toBeNull();
    expect(rows[0].spread).toBeNull();
  });

  it('degrades to [] on junk input', () => {
    expect(faCompareFillRates(null)).toEqual([]);
    expect(faCompareFillRates([])).toEqual([]);
  });
});
