// L7 — Schema View at enterprise scale: the active-flow layer.
//
// THE BUG THESE GUARD AGAINST. Two places ran the active-flow list as ONE page
// of `SELECT … FROM FlowDefinitionView WHERE IsActive = true LIMIT 500`, no
// ORDER BY:
//
//   svFetchFlows()  — the graph's own flow layer. Past 500 active flows every
//                     node's flow badge silently under-counts.
//   svLoadDiff()    — the compare-org leg. This one is worse than a truncation:
//                     it DIFFED two independently truncated arrays, so an object
//                     whose flows fell past the cut-off in one org and inside it
//                     in the other was reported as a flow-count difference
//                     BETWEEN THE ORGS THAT DOES NOT EXIST. A wrong diff is
//                     worse than a missing one, because the user acts on it.
//
// The fix is (a) SF_QUERY_ALL with no embedded LIMIT and a deterministic ORDER
// BY, (b) a SELECT COUNT() cross-check so an incomplete read is DETECTABLE
// rather than assumed-away, and (c) total suppression of the flow-count
// comparison whenever either side is not confirmed complete.
//
// studio-schema.js is a LABS file excluded from the store build, so nothing
// shipped is affected today — but the diff bug is a correctness bug, and it
// must be dead before Schema View ever graduates.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunctions } from './extract.mjs';

const SRC_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'studio-schema.js');
const SRC = readFileSync(SRC_PATH, 'utf8');

// svFlowLayerResult calls svReconcileFlows, so they must share one scope.
// svDiffGraphs keeps its flow gate NESTED (test/labs-n5b.test.mjs materialises
// svDiffGraphs on its own with extractFunction, which cannot resolve sibling
// top-level helpers), so the suppression predicate is exercised through the
// result svDiffGraphs emits — see the block near the bottom of this file.
const {
  svFlowListQuery, svFlowCountQuery, svReconcileFlows, svFlowLayerResult,
  svIsSortRejection, svDiffGraphs, svObjectCapPlan, svFlowMetaActions, svRunPool,
} = extractFunctions('studio-schema.js', [
  'svFlowListQuery', 'svFlowCountQuery', 'svReconcileFlows', 'svFlowLayerResult',
  'svIsSortRejection', 'svDiffGraphs', 'svObjectCapPlan', 'svFlowMetaActions', 'svRunPool',
]);

// ══════════════════════════════════════════════════════════════
describe('svFlowListQuery — the query SF_QUERY_ALL is allowed to page', () => {
  const q = svFlowListQuery(true);

  it('carries NO embedded LIMIT — an embedded LIMIT makes SF_QUERY_ALL a no-op', () => {
    // This is the whole point. With `LIMIT 500` the server stops at 500 and
    // never emits nextRecordsUrl, so the paging loop exits after one page
    // believing it read the entire org. Paging + LIMIT is not "safer", it is
    // the original single-page bug wearing a different message type.
    expect(q).not.toMatch(/\bLIMIT\b/i);
    expect(q).not.toMatch(/\b500\b/);
  });

  it('orders deterministically, so two independent reads page the same way', () => {
    // FlowDefinitionView has no guaranteed default order. An unordered
    // multi-page read can revisit or skip rows across page boundaries, and the
    // diff compares two independently paged arrays.
    expect(q).toMatch(/ORDER BY DurableId ASC$/);
  });

  it('still asks the right question (active flows on FlowDefinitionView)', () => {
    expect(q).toMatch(/FROM FlowDefinitionView/);
    expect(q).toMatch(/WHERE IsActive = true/);
  });

  it('selects everything both the graph badges and the deep scan need', () => {
    for (const f of ['DurableId', 'ApiName', 'Label', 'ProcessType', 'TriggerType',
      'TriggerObjectOrEvent.QualifiedApiName', 'ActiveVersionId']) {
      expect(q).toContain(f);
    }
  });

  it('the unordered fallback drops ONLY the ORDER BY — never the LIMIT-free shape', () => {
    // The fallback exists so an org that refuses to sort FlowDefinitionView
    // degrades to "unordered, and we said so" instead of "flow layer broken".
    // It must not quietly become a capped query on the way.
    const u = svFlowListQuery(false);
    expect(u).not.toMatch(/ORDER BY/i);
    expect(u).not.toMatch(/\bLIMIT\b/i);
    expect(u).toBe(q.replace(' ORDER BY DurableId ASC', ''));
  });

  it('defaults to ORDERED — an omitted argument must not silently pick the fallback', () => {
    expect(svFlowListQuery()).toBe(q);
  });
});

describe('svIsSortRejection — only a refused sort earns the unordered retry', () => {
  it('recognises the errors an unsortable field produces', () => {
    for (const e of [
      'MALFORMED_QUERY: field DurableId is not sortable',
      'HTTP 400: ORDER BY is not supported on this entity',
      'INVALID_FIELD: No such column',
    ]) expect(svIsSortRejection(e)).toBe(true);
  });

  it('does NOT retry a session, permission or network failure', () => {
    // Retrying those would double the traffic on a call that is going to fail
    // again, and would hide the real reason behind an ordering story.
    for (const e of ['INVALID_SESSION_ID', 'SESSION_EXPIRED', 'Failed to fetch',
      'HTTP 403: insufficient access', '', null, undefined]) {
      expect(svIsSortRejection(e)).toBe(false);
    }
  });
});

describe('svFlowCountQuery — the reconciliation probe', () => {
  const c = svFlowCountQuery();

  it('is an aggregate COUNT() over the SAME population as the list', () => {
    expect(c).toMatch(/^SELECT COUNT\(\)/);
    expect(c).toMatch(/FROM FlowDefinitionView/);
    expect(c).toMatch(/WHERE IsActive = true/);
  });

  it('carries no LIMIT of its own — a capped count could not detect a cap', () => {
    expect(c).not.toMatch(/\bLIMIT\b/i);
  });
});

// A source-level guard. The two call sites are async DOM/chrome functions that
// cannot be materialised standalone, so assert on the file text instead: the
// regression this whole task exists to kill is someone re-typing a
// FlowDefinitionView query inline with a LIMIT, or downgrading QUERY_ALL back
// to a single-page QUERY.
describe('studio-schema.js source — no FlowDefinitionView read may regress', () => {
  // Comment lines are prose (this fix is documented in them at length); only
  // executable lines are held to the rules.
  const codeLines = SRC.split('\n').filter(l => !l.trim().startsWith('//'));

  it('builds every FlowDefinitionView query through the two shared builders', () => {
    // Exactly two executable lines may name the object: the SELECT inside
    // svFlowListQuery and the SELECT inside svFlowCountQuery. A third means
    // someone re-typed a query inline, which is how the diff got two
    // independently-truncated sides in the first place.
    const queryLines = codeLines.filter(l => /FROM FlowDefinitionView/.test(l)).map(l => l.trim());
    expect(queryLines).toHaveLength(2);
    expect(queryLines.some(l => /SELECT COUNT\(\)/.test(l))).toBe(true);
  });

  it('has no `LIMIT 500` left in any executable line', () => {
    expect(codeLines.filter(l => /LIMIT\s+500/i.test(l))).toEqual([]);
  });

  it('has no SOQL LIMIT at all on a FlowDefinitionView query', () => {
    expect(codeLines.filter(l => /FlowDefinitionView/.test(l) && /\bLIMIT\b/i.test(l))).toEqual([]);
  });

  it('reads the flow LIST with SF_QUERY_ALL, never single-page SF_QUERY', () => {
    // Every svFlowListQuery() call must be carried by SF_QUERY_ALL. A
    // downgrade to SF_QUERY reinstates the single-page bug without touching
    // the query text at all, so the query assertions above would not catch it.
    const notADefinition = l => !/^\s*function /.test(l);
    const listSites = codeLines.filter(l => /svFlowListQuery\(/.test(l) && notADefinition(l));
    expect(listSites.length).toBeGreaterThanOrEqual(2);   // primary + unordered retry
    expect(listSites.every(l => /SF_QUERY_ALL/.test(l))).toBe(true);
    const countSites = codeLines.filter(l => /svFlowCountQuery\(\)/.test(l) && notADefinition(l));
    expect(countSites).toHaveLength(1);
    expect(countSites[0]).toMatch(/'SF_QUERY'/);
  });

  it('both diff sides read flows through the ONE shared reader', () => {
    // The original bug was two hand-written queries drifting apart. Two call
    // sites of svReadFlowLayer — svFetchFlows and svLoadDiff's compare leg —
    // and no other flow read anywhere.
    const readers = codeLines.filter(l => /await svReadFlowLayer\(/.test(l));
    expect(readers).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════════════════════
describe('svReconcileFlows — COUNT() reconciliation', () => {
  it('confirms a complete read when the paged count matches the org count', () => {
    const r = svReconcileFlows(812, 812);
    expect(r.complete).toBe(true);
    expect(r.known).toBe(true);
    expect(r.shortBy).toBe(0);
    expect(r.reason).toBe('');
  });

  it('detects the truncation the old LIMIT 500 caused, and says how many are missing', () => {
    const r = svReconcileFlows(500, 1340);
    expect(r.complete).toBe(false);
    expect(r.shortBy).toBe(840);
    expect(r.reason).toMatch(/1340/);
    expect(r.reason).toMatch(/only 500 were read/);
  });

  it('an UNANSWERED count leaves the layer unconfirmed — unknown is not complete', () => {
    // "We could not check" and "we checked and it was fine" must never render
    // as the same thing; that is the assumed-away pattern the probe exists to
    // remove.
    for (const bad of [null, undefined, NaN, 'lots', -1]) {
      const r = svReconcileFlows(120, bad);
      expect(r.known).toBe(false);
      expect(r.complete).toBe(false);
      expect(r.reported).toBeNull();
      expect(r.reason).toMatch(/could not be confirmed complete/);
    }
  });

  it('more records than the count is drift, not a hole — a flow was activated mid-read', () => {
    const r = svReconcileFlows(813, 812);
    expect(r.complete).toBe(true);
    expect(r.drift).toBe(1);
    expect(r.shortBy).toBe(0);
  });

  it('an empty org reconciles cleanly at zero', () => {
    const r = svReconcileFlows(0, 0);
    expect(r.complete).toBe(true);
    expect(r.reason).toBe('');
  });

  it('degrades on junk `fetched` instead of throwing', () => {
    expect(svReconcileFlows(undefined, 0).complete).toBe(true);
    expect(svReconcileFlows('x', 4).shortBy).toBe(4);
  });
});

describe('svFlowLayerResult — one response pair → records + verdict', () => {
  const list = n => ({ records: Array.from({ length: n }, (_, i) => ({ DurableId: `3${i}` })) });
  const count = n => ({ totalSize: n, done: true, records: [] });

  it('a complete read is ok AND complete', () => {
    const r = svFlowLayerResult(list(7), count(7));
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(true);
    expect(r.records).toHaveLength(7);
  });

  it('a failed LIST kills the layer — no records, not complete', () => {
    const r = svFlowLayerResult({ error: 'INVALID_TYPE' }, count(7));
    expect(r.ok).toBe(false);
    expect(r.complete).toBe(false);
    expect(r.records).toEqual([]);
    expect(r.error).toBe('INVALID_TYPE');
  });

  it('a missing records array is a failure, not an automation-free org', () => {
    const r = svFlowLayerResult({}, count(0));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no records array/);
  });

  it('a failed COUNT keeps the records but refuses to call the layer complete', () => {
    const r = svFlowLayerResult(list(300), { error: 'aggregate query not supported' });
    expect(r.ok).toBe(true);
    expect(r.records).toHaveLength(300);
    expect(r.complete).toBe(false);
    expect(r.countError).toMatch(/aggregate/);
  });

  it('a short read is ok but NOT complete', () => {
    const r = svFlowLayerResult(list(500), count(1200));
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.reason).toMatch(/700/);
  });
});

// ══════════════════════════════════════════════════════════════
describe('the suppression predicate, as svDiffGraphs actually applies it', () => {
  // The gate is nested inside svDiffGraphs (see the note at the top of this
  // file), so it is asserted through what the diff EMITS. That is the stronger
  // claim anyway: not "the predicate returned false" but "no comparison
  // reached the user".
  const one = (o = {}) => ({
    objects: [{ id: 'Account', described: true, flowCount: 4 }], edges: [],
    flowsLoaded: true, flowsIncomplete: false, flowActionsScanned: true, ...o,
  });
  const verdict = (a, b) => {
    const d = svDiffGraphs(a, b);
    return { comparable: d.flowsComparable, reason: d.flowsNotComparedWhy };
  };

  it('two confirmed-complete sides may be compared', () => {
    const v = verdict(one(), one());
    expect(v.comparable).toBe(true);
    expect(v.reason).toBe('');
  });

  it('an INCOMPLETE side suppresses the comparison and names which org', () => {
    const v = verdict(one(), one({ flowsIncomplete: true, flowsIncompleteWhy: 'only 500 of 1340 were read' }));
    expect(v.comparable).toBe(false);
    expect(v.reason).toMatch(/Flow counts were NOT compared/);
    expect(v.reason).toMatch(/INCOMPLETE for the compare org/);
    expect(v.reason).toMatch(/only 500 of 1340 were read/);
    expect(v.reason).toMatch(/differences that do not exist/);
  });

  it('names THIS org when this side is the short one', () => {
    const v = verdict(one({ flowsIncomplete: true }), one());
    expect(v.comparable).toBe(false);
    expect(v.reason).toMatch(/INCOMPLETE for this org/);
  });

  it('names both when both are short, and carries both reasons', () => {
    const v = verdict(
      one({ flowsIncomplete: true, flowsIncompleteWhy: 'here: 500 of 1340' }),
      one({ flowsIncomplete: true, flowsIncompleteWhy: 'there: 500 of 900' }));
    expect(v.reason).toMatch(/INCOMPLETE for both orgs/);
    expect(v.reason).toMatch(/here: 500 of 1340/);
    expect(v.reason).toMatch(/there: 500 of 900/);
  });

  it('a NOT-LOADED side still reports the older, more specific reason', () => {
    const v = verdict(one(), one({ flowsLoaded: false }));
    expect(v.comparable).toBe(false);
    expect(v.reason).toMatch(/not loaded for the compare org/);
  });

  it('not-loaded beats incomplete — "we never asked" is the truer explanation', () => {
    const v = verdict(one(), one({ flowsLoaded: false, flowsIncomplete: true }));
    expect(v.reason).toMatch(/not loaded/);
    expect(v.reason).not.toMatch(/INCOMPLETE/);
  });

  it('a caller that never reconciled keeps the pre-L7 contract (absence is not an assertion)', () => {
    // flowsIncomplete is a POSITIVE assertion of a known problem. Its absence
    // means "nothing known", which is what an older caller means — that is what
    // keeps test/labs-n5b.test.mjs true. The real caller (svLoadDiff) always
    // passes it explicitly for BOTH sides.
    const a = { objects: [{ id: 'Account', described: true, flowCount: 1 }], edges: [], flowsLoaded: true, flowActionsScanned: true };
    expect(svDiffGraphs(a, a).flowsComparable).toBe(true);
  });

  it('degrades on junk input by refusing to compare', () => {
    expect(svDiffGraphs(null, undefined).flowsComparable).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
describe('svDiffGraphs — an incomplete side emits NO flow-count comparison at all', () => {
  const side = (objects, extra = {}) => ({
    objects, edges: [], flowsLoaded: true, flowsIncomplete: false,
    flowActionsScanned: true, ...extra,
  });
  const obj = (id, flowCount = 0) => ({ id, described: true, flowCount });

  it('THE BUG: two truncated lists no longer report a difference that does not exist', () => {
    // Account really has 40 active flows in both orgs. Org A's read stopped at
    // 500 records and caught 12 of them; org B's caught 31. The old code
    // compared 12 against 31 and told the user the orgs had diverged.
    const a = side([obj('Account', 12)], { flowsIncomplete: true, flowsIncompleteWhy: 'only 500 of 1340 were read' });
    const b = side([obj('Account', 31)], { flowsIncomplete: true, flowsIncompleteWhy: 'only 500 of 980 were read' });
    const d = svDiffGraphs(a, b);

    expect(d.nodes[0].flowStatus).toBe('unknown');
    expect(d.counts.flowsDiffer).toBe(0);
    expect(d.flowsComparable).toBe(false);
    expect(d.uncomparable.join(' ')).toMatch(/Flow counts were NOT compared/);
    expect(d.uncomparable.join(' ')).toMatch(/INCOMPLETE for both orgs/);
  });

  it('suppression is total — not one node keeps a flow verdict', () => {
    const objs = ['Account', 'Contact', 'Case', 'Opportunity'].map((n, i) => obj(n, i));
    const d = svDiffGraphs(
      side(objs),
      side(objs.map(o => ({ ...o })), { flowsIncomplete: true }));
    expect(d.nodes).toHaveLength(4);
    expect(d.nodes.every(n => n.flowStatus === 'unknown')).toBe(true);
    expect(d.counts.flowsDiffer).toBe(0);
    expect(d.counts.flowsUnknown).toBe(4);
  });

  it('a genuinely EQUAL count is suppressed too — a match we cannot stand behind is still a claim', () => {
    // Reporting "same" off two truncated lists is exactly as unearned as
    // reporting "differs"; both are assertions about data we did not read.
    const d = svDiffGraphs(
      side([obj('Account', 7)]),
      side([obj('Account', 7)], { flowsIncomplete: true }));
    expect(d.nodes[0].flowStatus).toBe('unknown');
    expect(d.flowsComparable).toBe(false);
  });

  it('the suppression reason travels on the result, not just in the list', () => {
    const d = svDiffGraphs(side([obj('A', 1)]), side([obj('A', 2)], { flowsIncomplete: true }));
    expect(d.flowsNotComparedWhy).toMatch(/INCOMPLETE/);
  });

  it('two CONFIRMED-complete sides still compare exactly as before', () => {
    const same = svDiffGraphs(side([obj('Account', 3)]), side([obj('Account', 3)]));
    expect(same.nodes[0].flowStatus).toBe('same');
    expect(same.flowsComparable).toBe(true);

    const diff = svDiffGraphs(side([obj('Account', 3)]), side([obj('Account', 5)]));
    expect(diff.nodes[0].flowStatus).toBe('differs');
    expect(diff.counts.flowsDiffer).toBe(1);
    expect(diff.uncomparable.join(' ')).not.toMatch(/Flow counts were NOT compared/);
  });

  it('object and relationship verdicts are untouched by flow suppression', () => {
    // Suppressing flows must not take the rest of the overlay down with it —
    // the objects and edges were read completely and are still comparable.
    const edge = { from: 'Contact', to: 'Account', edgeType: 'lookup', label: 'Contacts' };
    const d = svDiffGraphs(
      { objects: [obj('Account'), obj('Contact')], edges: [edge], flowsLoaded: true,
        flowsIncomplete: true, flowActionsScanned: true },
      { objects: [obj('Account'), obj('Contact')], edges: [], flowsLoaded: true,
        flowsIncomplete: false, flowActionsScanned: true });
    expect(d.counts.nodesBoth).toBe(2);
    expect(d.edges[0].status).toBe('only-a');
    expect(d.counts.edgesOnlyA).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════
describe('svObjectCapPlan — the other silent truncation in this file', () => {
  // The auto-picked object list took `.slice(0, 60)` with no note at all, so a
  // 300-object org got a graph of 60 that looked complete and lost every lookup
  // pointing at the other 240.
  const names = n => Array.from({ length: n }, (_, i) => `Obj${String(i).padStart(3, '0')}__c`);

  it('leaves a small org completely alone — nothing capped, nothing to say', () => {
    const p = svObjectCapPlan(names(12), 60);
    expect(p.capped).toBe(false);
    expect(p.dropped).toBe(0);
    expect(p.kept).toHaveLength(12);
  });

  it('an exactly-at-the-cap org is NOT capped (an off-by-one here is a false alarm)', () => {
    const p = svObjectCapPlan(names(60), 60);
    expect(p.capped).toBe(false);
    expect(p.kept).toHaveLength(60);
  });

  it('reports the real total and exactly how many were left out', () => {
    const p = svObjectCapPlan(names(300), 60);
    expect(p.capped).toBe(true);
    expect(p.total).toBe(300);
    expect(p.kept).toHaveLength(60);
    expect(p.dropped).toBe(240);
    expect(p.kept[0]).toBe('Obj000__c');
  });

  it('drops junk entries instead of graphing them', () => {
    const p = svObjectCapPlan(['A__c', '', null, undefined, 'B__c'], 60);
    expect(p.kept).toEqual(['A__c', 'B__c']);
    expect(p.total).toBe(2);
  });

  it('degrades on junk input', () => {
    expect(svObjectCapPlan(null, 60).kept).toEqual([]);
    expect(svObjectCapPlan(['A'], 0).capped).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
describe('svFlowMetaActions — the deep-scan parse, unchanged by batching', () => {
  const set = (...o) => new Set(o.map(s => s.toLowerCase()));
  const flow = { Label: 'Order Router', ApiName: 'Order_Router',
    TriggerObjectOrEvent: { QualifiedApiName: 'Order' } };

  it('reads recordCreates and recordUpdates pointing at other graphed objects', () => {
    const acts = svFlowMetaActions(flow, {
      recordCreates: [{ object: 'Task' }, { object: 'Contact' }],
      recordUpdates: { object: 'Account' },
    }, set('Order', 'Task', 'Contact', 'Account'));
    expect(acts.map(a => `${a.toObj}:${a.action}`)).toEqual(
      ['Task:creates', 'Contact:creates', 'Account:updates']);
    expect(acts[0].fromObj).toBe('Order');
    expect(acts[0].flowName).toBe('Order Router');
  });

  it('ignores actions on objects that are not on the graph, and self-references', () => {
    const acts = svFlowMetaActions(flow, {
      recordCreates: [{ object: 'Order' }, { object: 'NotGraphed__c' }],
    }, set('Order', 'Task'));
    expect(acts).toEqual([]);
  });

  it('resolves a subflow target from the FULL flow list, not just the scanned subset', () => {
    // The old inline code looked the target up in `triggered` (the capped scan
    // set), so a subflow call to a flow that existed but was not opened lost
    // its edge for no reason. The target's trigger object is known from the
    // list query either way.
    const byName = new Map([['Case_Closer', {
      ApiName: 'Case_Closer', TriggerObjectOrEvent: { QualifiedApiName: 'Case' } }]]);
    const acts = svFlowMetaActions(flow, { subflows: { flowName: 'Case_Closer' } },
      set('Order', 'Case'), byName);
    expect(acts).toEqual([{ fromObj: 'Order', toObj: 'Case', flowName: 'Order Router', action: 'calls subflow' }]);
  });

  it('a flow with no trigger object contributes nothing', () => {
    expect(svFlowMetaActions({ Label: 'X' }, { recordCreates: [{ object: 'Task' }] }, set('Task'))).toEqual([]);
  });

  it('degrades on junk instead of throwing', () => {
    expect(svFlowMetaActions(null, null, null)).toEqual([]);
    expect(svFlowMetaActions(flow, 'not an object', set('Order'))).toEqual([]);
    expect(svFlowMetaActions(flow, { recordCreates: [null, {}] }, set('Order'))).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════
describe('svRunPool — the describe barrier is gone', () => {
  it('keeps INPUT order regardless of completion order', async () => {
    const r = await svRunPool([30, 5, 20, 1], async (ms) => {
      await new Promise(res => setTimeout(res, ms));
      return ms;
    }, { concurrency: 4 });
    expect(r.results).toEqual([30, 5, 20, 1]);
    expect(r.complete).toBe(true);
    expect(r.done).toBe(4);
  });

  it('does not drain to zero between groups — the slow item stalls nobody', async () => {
    // The old batch-of-6 Promise.all waited for the slowest item in each group
    // of 6 before starting the next. With 2 workers and one 40 ms item, a
    // barrier would leave the second worker idle; a rolling pool does not.
    let peak = 0, live = 0;
    await svRunPool([40, 1, 1, 1, 1, 1], async (ms) => {
      live++; peak = Math.max(peak, live);
      await new Promise(res => setTimeout(res, ms));
      live--;
    }, { concurrency: 2 });
    expect(peak).toBe(2);
  });

  it('a thrown worker still counts the item as settled', async () => {
    const r = await svRunPool([1, 2, 3], async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    }, { concurrency: 3 });
    expect(r.results).toEqual([1, undefined, 3]);
    expect(r.complete).toBe(true);
  });

  it('shouldStop reports stopped:true rather than pretending completion', async () => {
    let seen = 0;
    const r = await svRunPool([1, 2, 3, 4, 5, 6], async () => { seen++; return 'x'; },
      { concurrency: 1, shouldStop: () => seen >= 2 });
    expect(r.stopped).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.done).toBeLessThan(6);
  });

  it('an empty list is complete with zero work', async () => {
    const r = await svRunPool([], async () => 'x', { concurrency: 6 });
    expect(r).toMatchObject({ done: 0, total: 0, complete: true, stopped: false });
  });

  it('progress is monotonic and counted in items', async () => {
    const seen = [];
    await svRunPool([1, 2, 3, 4], async () => 'x',
      { concurrency: 2, onProgress: (d, t) => seen.push([d, t]) });
    expect(seen).toHaveLength(4);
    expect(seen.map(s => s[0])).toEqual([1, 2, 3, 4]);
    expect(seen.every(s => s[1] === 4)).toBe(true);
  });
});
