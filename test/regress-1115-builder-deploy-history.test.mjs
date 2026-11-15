// Regressions and half-applied fixes of release QA 1.1 (f0334a0), the
// Builder / Deploy page / History area — 2026-11-15. Every test here RUNS the
// real code (functions and handlers sliced out of their files into one scope
// with stubbed neighbours); none asserts on source text.
//  1. owner fallback user: cleared on EVERY path that moves the target — the
//     Deploy page's org picker and swap, openReconcile with another target,
//     the All-open-orgs cell, and the run-time target override — not only on
//     the Builder's two selects
//  2. ambiguous parent keys: the Deploy page no longer says "in sync" /
//     "Parents synced" for a verdict the Builder calls ambiguous; the row
//     names them; the scan's own deposit keeps the count
//  3. parents-first order: a step that only DEPENDS on a lookup cycle is not
//     placed above its own parent, and '← next' does not land on it
//  4. behaviour of wiring that was asserted on source text only: the
//     many-record Save handler with the input / ∅ / ✕ handlers that mark a
//     row, and storageSaveHistory / the storage listener keeping a done mark
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunction, extractFunctions } from './extract.mjs';

const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sliceFn = (file, name) => {
  const src = read(file);
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(src);
  if (!m) throw new Error(`not found ${name} in ${file}`);
  return src.slice(m.index, src.indexOf('\n}', m.index) + 2);
};
// a block of real source between two markers (end marker excluded)
const sliceBetween = (file, start, end) => {
  const src = read(file);
  const a = src.indexOf(start);
  if (a < 0) throw new Error(`not found in ${file}: ${start}`);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`not found in ${file}: ${end}`);
  return src.slice(a, b);
};
// code + stubs in ONE scope; `ret` is the object literal body to hand back
const scope = (code, stubs, ret) => new Function(...Object.keys(stubs), `${code}\nreturn { ${ret} };`)(...Object.values(stubs));

const ORG_KEY = [sliceFn('sftk-org-identity.js', 'sftkOrgKey'), sliceFn('studio-core.js', '_orgKey')].join('\n');
const FALLBACK = sliceFn('studio-builder.js', 'sftkOwnerFallbackForTarget');
const T1 = 'https://one.my.salesforce.com', T2 = 'https://two.my.salesforce.com', S = 'https://src.my.salesforce.com';
const profWithFallback = (over) => ({ id: 'p1', sourceOrg: S, targetOrg: T1, tree: { objectType: 'Account', children: [] },
  ownerMapping: { mode: 'match', fallbackUserId: '005000000000001AAA', fallbackUserName: 'Ada of T1' }, ...over });

// ═══ 1. owner fallback follows the target ═══════════════════════════════════
describe('Deploy page org picker (_depSetPair) clears a fallback user that belongs to the old target', () => {
  const world = (p) => {
    const toasts = [], saved = [];
    const open = [{ key: 's', url: S }, { key: 't1', url: T1 }, { key: 't2', url: T2 }];
    const w = scope(`${ORG_KEY}\n${FALLBACK}\nlet _depForProfile = 'x';\n${sliceFn('studio-deploy.js', '_depSetPair')}`, {
      sftkOpenOrgs: () => open,
      showToast: (m, k) => toasts.push([m, k]),
      dsSetPreferredSource: async () => {},
      // what is SAVED is what a later run reads: snapshot it at save time
      storageSaveProfiles: async () => { saved.push(JSON.parse(JSON.stringify(p))); },
      renderDeploy: () => {},
    }, '_depSetPair');
    return { ...w, toasts, saved };
  };

  it('a new target: the fallback is gone from the saved deployment, and the user is told', async () => {
    const p = profWithFallback();
    const w = world(p);
    await w._depSetPair(p, 's', 't2');
    expect(p.targetOrg).toBe(T2);
    expect(p.ownerMapping).toEqual({ mode: 'match', fallbackUserId: null, fallbackUserName: null });
    expect(w.saved).toHaveLength(1);
    expect(w.saved[0].ownerMapping.fallbackUserId).toBeNull();
    expect(w.toasts).toHaveLength(1);
    expect(w.toasts[0][0]).toMatch(/owner fallback user belonged to the old target/);
    expect(w.toasts[0][1]).toBe('warning');
  });
  it('the swap button (target ← source): cleared too', async () => {
    const p = profWithFallback();
    const w = world(p);
    await w._depSetPair(p, 't1', 's');
    expect(p.sourceOrg).toBe(T1);
    expect(p.targetOrg).toBe(S);
    expect(p.ownerMapping.fallbackUserId).toBeNull();
    expect(p.ownerMapping.fallbackUserName).toBeNull();
  });
  it('only the SOURCE changes: the target is the same org, the fallback stays, no toast', async () => {
    const p = profWithFallback({ sourceOrg: T2 });
    const w = world(p);
    await w._depSetPair(p, 's', 't1');
    expect(p.sourceOrg).toBe(S);
    expect(p.ownerMapping.fallbackUserId).toBe('005000000000001AAA');
    expect(w.toasts).toEqual([]);
  });
  it('the same org picked for both sides is refused before anything is touched', async () => {
    const p = profWithFallback();
    const w = world(p);
    await w._depSetPair(p, 't2', 't2');
    expect(p.targetOrg).toBe(T1);
    expect(p.ownerMapping.fallbackUserId).toBe('005000000000001AAA');
    expect(w.saved).toEqual([]);
  });
  it('a deployment with no owner matching is moved without a toast', async () => {
    const p = profWithFallback({ ownerMapping: undefined });
    const w = world(p);
    await w._depSetPair(p, 's', 't2');
    expect(p.targetOrg).toBe(T2);
    expect(w.toasts).toEqual([]);
  });
});

describe('the other committed target movers clear it too', () => {
  it('openReconcile with another target (History "run again", All-open-orgs)', () => {
    const p = profWithFallback();
    const toasts = [];
    let saves = 0;
    const win = {};
    const src = read('studio-reconcile.js');
    const at = src.indexOf('window.openReconcile = function(');
    const body = src.slice(at, src.indexOf('\n};', at) + 3);
    scope(`${ORG_KEY}\n${FALLBACK}\nlet _reconcileProfile = null, _currentView = '';\n${body}`, {
      window: win, _profiles: [p], showToast: (m) => toasts.push(m), storageSaveProfiles: () => { saves++; },
      renderReconcile: () => {}, sftkDeployViewOn: () => true,
      document: { querySelectorAll: () => [], querySelector: () => null },
    }, '');
    win.openReconcile('p1', T2);
    expect(p.targetOrg).toBe(T2);
    expect(p.ownerMapping.fallbackUserId).toBeNull();
    expect(saves).toBe(1);
    expect(toasts.join(' ')).toMatch(/owner fallback user belonged to the old target/);

    // opened on its own pair: nothing moves, nothing is cleared
    const q = profWithFallback({ id: 'p1' });
    const win2 = {};
    scope(`${ORG_KEY}\n${FALLBACK}\nlet _reconcileProfile = null, _currentView = '';\n${body}`, {
      window: win2, _profiles: [q], showToast: () => { throw new Error('no toast expected'); }, storageSaveProfiles: () => {},
      renderReconcile: () => {}, sftkDeployViewOn: () => false,
      document: { querySelectorAll: () => [], querySelector: () => null },
    }, '');
    win2.openReconcile('p1', T1);
    win2.openReconcile('p1');
    expect(q.ownerMapping.fallbackUserId).toBe('005000000000001AAA');
  });

  it('the All-open-orgs cell (_ringOpenReconcile) sets the pair and clears it before the save', async () => {
    const p = profWithFallback();
    const saved = [], toasts = [];
    const { _ringOpenReconcile } = scope(`${ORG_KEY}\n${FALLBACK}\n${sliceFn('studio-ring.js', '_ringOpenReconcile')}`, {
      _profiles: [p], _ringActiveSource: () => S, showToast: (m) => toasts.push(m),
      storageSaveProfiles: async () => { saved.push(JSON.parse(JSON.stringify(p))); },
      window: { openReconcile: () => {} },
    }, '_ringOpenReconcile');
    await _ringOpenReconcile('p1', T2);
    expect(saved[0].targetOrg).toBe(T2);
    expect(saved[0].ownerMapping.fallbackUserId).toBeNull();
    expect(toasts).toHaveLength(1);

    const same = profWithFallback();
    const again = scope(`${ORG_KEY}\n${FALLBACK}\n${sliceFn('studio-ring.js', '_ringOpenReconcile')}`, {
      _profiles: [same], _ringActiveSource: () => S, showToast: () => { throw new Error('no toast expected'); },
      storageSaveProfiles: async () => {}, window: { openReconcile: () => {} },
    }, '_ringOpenReconcile');
    await again._ringOpenReconcile('p1', T1);
    expect(same.ownerMapping.fallbackUserId).toBe('005000000000001AAA');
  });

  it('a run against another target (buildTransferProfile): the run\'s copy has no fallback, the saved deployment keeps its own', () => {
    const p = profWithFallback();
    const build = (override) => scope(`${ORG_KEY}\n${FALLBACK}\n${sliceFn('studio-transfer.js', 'buildTransferProfile')}`, {
      _transferProfile: p, _transferTgt: null, _transferNodeFilters: {}, _transferWriteMode: 'insert', _transferUpsertField: '',
      _transferOrgOverride: override,
    }, 'buildTransferProfile').buildTransferProfile();

    const moved = build({ src: null, tgt: T2 });
    expect(moved.targetOrg).toBe(T2);
    expect(moved.ownerMapping).toEqual({ mode: 'match', fallbackUserId: null, fallbackUserName: null });
    expect(p.ownerMapping.fallbackUserId).toBe('005000000000001AAA');   // the saved deployment still targets T1

    const own = build({ src: null, tgt: null });
    expect(own.targetOrg).toBe(T1);
    expect(own.ownerMapping.fallbackUserId).toBe('005000000000001AAA');
  });
});

// ═══ 2. ambiguous parents are not "in sync" on the Deploy page ══════════════
describe('a parent with ambiguous keys is behind, on every surface that reads the verdict', () => {
  const stepState = extractFunction('studio-reconcile.js', 'sftkParentStepState');
  const parentsVerdict = extractFunction('studio-deploy.js', 'sftkDeployParentsVerdict');
  const behindText = extractFunction('studio-deploy.js', 'sftkDeployBehindText');
  const inSync = extractFunction('studio-builder.js', 'sftkParentVerdictInSync');
  const G = { refObj: 'Account', srcCount: 10, empty: false };

  it('the Deploy page step and the Builder chip agree', () => {
    const vd = { missing: 0, changed: 0, extra: 0, ambiguous: 3 };
    expect(inSync(vd)).toBe(false);
    expect(stepState(G, vd)).toBe('behind');
    const verdict = parentsVerdict([{ refObj: 'Account', state: stepState(G, vd) }]);
    expect(verdict.cls).toBe('bad');
    expect(verdict.text).toMatch(/1 of 1 parent object\(s\) not aligned/);
  });
  it('a clean verdict is still done, and a verdict saved before ambiguous was recorded reads as 0', () => {
    expect(stepState(G, { missing: 0, changed: 0, ambiguous: 0 })).toBe('done');
    expect(stepState(G, { missing: 0, changed: 0 })).toBe('done');
    expect(parentsVerdict([{ state: 'done' }]).cls).toBe('ok');
  });
  it('the earlier answers are unchanged: not needed, empty, unknown, missing, changed', () => {
    expect(stepState({ srcCount: 0 }, { ambiguous: 3 })).toBe('notneeded');
    expect(stepState({ srcCount: 5, empty: true }, { ambiguous: 3 })).toBe('empty');
    expect(stepState(G, undefined)).toBe('unknown');
    expect(stepState(G, { missing: 1, changed: 0 })).toBe('behind');
    expect(stepState(G, { missing: 0, changed: 2 })).toBe('behind');
  });
  it('the behind row names the ambiguous records, with en-US numbers, and says nothing extra without them', () => {
    expect(behindText({ missing: 0, changed: 0, ambiguous: 3 }))
      .toBe('🔴 0 missing · 🟡 0 changed · ⚠ 3 ambiguous — lookups to them are refused until resolved');
    expect(behindText({ missing: 1234, changed: 2 })).toBe('🔴 1,234 missing · 🟡 2 changed');
    expect(behindText({ missing: 1 })).toBe('🔴 1 missing · 🟡 0 changed');   // never "undefined changed"
  });

  it('the scan\'s own deposit carries ambiguous, so a rescan cannot turn the parent back to "in sync"', () => {
    const scanVerdict = extractFunction('studio-scan.js', 'sftkScanSyncVerdict');
    const res = { status: 'success', objectType: 'Account', runAt: '2026-11-15T10:00:00Z',
      missingInTarget: [], changed: [], onlyInTarget: [{}], ambiguous: [{}, {}, {}] };
    expect(scanVerdict(res)).toEqual({ missing: 0, changed: 0, extra: 1, ambiguous: 3, at: '2026-11-15T10:00:00Z' });
    expect(scanVerdict({ runAt: 'x' })).toEqual({ missing: 0, changed: 0, extra: 0, ambiguous: 0, at: 'x' });

    // the real newest-wins map: an older Builder verdict with ambiguous, then the run's rescan
    const stored = [];
    const m = scope(`${sliceFn('sftk-org-identity.js', 'sftkOrgKey')}\nconst _parentSyncVerdicts = {};\n${sliceFn('studio-reconcile.js', 'sftkParentSyncKey')}\n${sliceFn('studio-reconcile.js', 'sftkParentSyncPut')}`,
      { chrome: { storage: { local: { set: (o) => stored.push(o) } } } }, 'sftkParentSyncKey, sftkParentSyncPut, _parentSyncVerdicts');
    m.sftkParentSyncPut(S, T1, 'Account', { missing: 0, changed: 0, extra: 0, ambiguous: 3, at: '2026-11-15T09:00:00Z' });
    m.sftkParentSyncPut(S, T1, 'Account', scanVerdict(res));
    const vd = m._parentSyncVerdicts[m.sftkParentSyncKey(S, T1, 'Account')];
    expect(vd.at).toBe('2026-11-15T10:00:00Z');   // the rescan did win …
    expect(vd.ambiguous).toBe(3);                  // … and still says ambiguous
    expect(inSync(vd)).toBe(false);
    expect(stepState(G, vd)).toBe('behind');
  });
});

// ═══ 3. a dependant of a lookup cycle ═══════════════════════════════════════
describe('parents first: a step that depends on a cycle comes after the cycle', () => {
  const orderSteps = extractFunction('studio-deploy.js', 'sftkDeployOrderSteps');
  const nextIdx = extractFunction('studio-deploy.js', 'sftkDeployNextStepIdx');
  const OBJECTS = [{ obj: 'OrderItem', parents: [
    { field: 'PricebookEntryId', refObj: 'PricebookEntry' }, { field: 'Product2Id', refObj: 'Product2' }, { field: 'Family__c', refObj: 'Family__c' }] }];
  const DEPS = { PricebookEntry: ['Product2'], Product2: ['Family__c'], Family__c: ['Product2'] };

  it('PricebookEntry → Product2 ⇄ Family__c: Product2 is placed before PricebookEntry', () => {
    const names = orderSteps(OBJECTS, DEPS).map(s => s.refObj);
    expect(names).toEqual(['Product2', 'PricebookEntry', 'Family__c']);
  });
  it("'← next' lands inside the cycle, not on its dependant — whatever order the steps are in", () => {
    const steps = orderSteps(OBJECTS, DEPS);
    expect(steps[nextIdx(steps, () => false)].refObj).toBe('Product2');
    // first-seen order (no reorder): PricebookEntry is step 1 and still is not offered
    const firstSeen = orderSteps(OBJECTS).map(s => ({ ...s, dependsOn: DEPS[s.refObj] }));
    expect(firstSeen[0].refObj).toBe('PricebookEntry');
    expect(firstSeen[nextIdx(firstSeen, () => false)].refObj).toBe('Product2');
    // the cycle settled: PricebookEntry is next; all settled: -1
    expect(firstSeen[nextIdx(firstSeen, s => s.refObj !== 'PricebookEntry')].refObj).toBe('PricebookEntry');
    expect(nextIdx(firstSeen, () => true)).toBe(-1);
  });
  it('a chain of dependants above a cycle is unwound from the cycle outwards', () => {
    const objs = [{ obj: 'X', parents: ['A', 'B', 'C', 'D'].map(r => ({ field: r + 'Id', refObj: r })) }];
    const names = orderSteps(objs, { A: ['B'], B: ['C'], C: ['D'], D: ['C'] }).map(s => s.refObj);
    expect(names).toEqual(['C', 'B', 'A', 'D']);
    expect(names.indexOf('B')).toBeGreaterThan(names.indexOf('C'));
    expect(names.indexOf('A')).toBeGreaterThan(names.indexOf('B'));
  });
  it('a pure cycle keeps first-seen order, every step exactly once; no cycle is unchanged', () => {
    const objs = [{ obj: 'X', parents: [{ field: 'a', refObj: 'Account' }, { field: 'c', refObj: 'Contact' }, { field: 'u', refObj: 'Unit__c' }] }];
    expect(orderSteps(objs, { Account: ['Contact'], Contact: ['Account'] }).map(s => s.refObj)).toEqual(['Unit__c', 'Account', 'Contact']);   // the ready step first, then the cycle in first-seen order
    expect(orderSteps(OBJECTS, { PricebookEntry: ['Product2'] }).map(s => s.refObj)).toEqual(['Product2', 'PricebookEntry', 'Family__c']);
    // two separate cycles and a dependant of the second: terminates, nothing dropped or doubled
    const big = [{ obj: 'X', parents: ['P', 'A', 'B', 'C', 'D'].map(r => ({ field: r, refObj: r })) }];
    const out = orderSteps(big, { P: ['C'], A: ['B'], B: ['A'], C: ['D'], D: ['C'] }).map(s => s.refObj);
    expect([...out].sort()).toEqual(['A', 'B', 'C', 'D', 'P']);
    expect(out.indexOf('P')).toBeGreaterThan(out.indexOf('C'));
  });
  it("'← next' on hand-built steps: no steps, a dependency that is not a step, a self-reference", () => {
    expect(nextIdx([], () => false)).toBe(-1);
    expect(nextIdx(null, () => false)).toBe(-1);
    // 'Ghost' is not a step and not unsettled: A is simply ready
    expect(nextIdx([{ refObj: 'A', dependsOn: ['Ghost'] }], () => false)).toBe(0);
    // a step listing itself is offered, never looped on
    expect(nextIdx([{ refObj: 'A', dependsOn: ['A'] }, { refObj: 'B' }], () => false)).toBe(1);
    expect(nextIdx([{ refObj: 'A', dependsOn: ['A'] }], () => false)).toBe(0);
  });
});

// ═══ 4a. ✏ Values, many records — the real handlers on a minimal DOM ════════
// No DOM library in this repo (and no new dependencies), so the handlers run on
// plain objects that carry only what they touch: dataset, value, classList,
// addEventListener, closest / querySelector. The handler CODE is the file's own.
describe('many-record Save: the dialog\'s own input / ∅ / ✕ handlers and Save handler', () => {
  const V = extractFunctions('sftk-valueedit.js', ['sftkValOvBucket', 'sftkValOvGet', 'sftkValOvSet', 'sftkValOvClear', 'sftkValOvManyAction'], { 'sftk-org-identity.js': ['sftkOrgKey'] });
  const sftkMergeCoerce = extractFunction('sftk-merge.js', 'sftkMergeCoerce');
  const VE = 'studio-valueedit.js';
  const marks = sliceBetween(VE, "  host.querySelectorAll('.ds-ve-in').forEach(inp => {", '  // ── lookups');
  const save = sliceBetween(VE, "  eid('dsVeSave')?.addEventListener('click', async () => {", "  eid('dsVeClearAll')?.addEventListener");

  const classes = () => { const s = new Set(); return { contains: c => s.has(c), add: c => s.add(c), remove: c => s.delete(c), toggle: (c, on) => { (on === undefined ? !s.has(c) : on) ? s.add(c) : s.delete(c); } }; };
  const node0 = () => ({ _l: {}, classList: classes(), style: {}, dataset: {},
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
    fire(t) { return Promise.all((this._l[t] || []).map(f => f())); } });
  const mkRow = (field, type, opt = {}) => {
    const tr = node0(), inp = node0(), nul = node0(), clr = node0(), err = { textContent: '' };
    Object.assign(inp, { value: '', disabled: false, placeholder: '', focus() {} });
    inp.dataset.veField = field; inp.dataset.veType = type;
    if (opt.mixed) inp.dataset.veMixed = '1';      // what the row template writes for a mixed field
    if (opt.hidden) tr.style.display = 'none';     // filtered out by "find a field"
    const map = { '.ds-ve-in': inp, '.ds-ve-null': nul, '.ds-ve-clear': clr, '.ds-ve-err': err };
    tr.querySelector = sel => map[sel] || null;
    for (const el of [inp, nul, clr]) el.closest = () => tr;
    return { tr, inp, nul, clr, err, field };
  };
  const TGT = 'https://seven.develop.my.salesforce.com';

  function dialog(rows, node, ids) {
    const btn = node0(), toasts = [];
    let closed = 0, saves = 0;
    const host = { querySelectorAll: sel => sel === '.ds-ve-in' ? rows.map(r => r.inp) : sel === '[data-ve-null]' ? rows.map(r => r.nul)
      : sel === '[data-ve-clear]' ? rows.map(r => r.clr) : sel === 'tr[data-ve-row]' ? rows.map(r => r.tr) : [] };
    scope(`${marks}\n${save}`, {
      host, many: true, ids, node, p: { targetOrg: TGT }, label: '', onSaved: null,
      mark: () => {}, queueSave: () => {}, hint: () => '',
      eid: id => id === 'dsVeSave' ? btn : null,
      saveNode: async () => { saves++; }, closeModal: () => { closed++; },
      showToast: (m, k) => toasts.push([m, k]),
      ovOf: id => V.sftkValOvGet(node, TGT, id),
      sftkValOvManyAction: V.sftkValOvManyAction, sftkValOvSet: V.sftkValOvSet, sftkValOvClear: V.sftkValOvClear, sftkMergeCoerce,
    }, '');
    const type = async (r, text) => { r.inp.value = text; await r.inp.fire('input'); };
    return { clickSave: () => btn.fire('click'), type, toasts, closed: () => closed, saves: () => saves };
  }
  const twoRecords = () => {
    const node = {};
    V.sftkValOvSet(node, TGT, 'A', 'Phone', '111');
    V.sftkValOvSet(node, TGT, 'B', 'Phone', '222');
    V.sftkValOvSet(node, TGT, 'A', 'Fax', '9');          // typed on one record only
    return node;
  };
  const rowsOf = () => [mkRow('Phone', 'phone', { mixed: true }), mkRow('Fax', 'phone', { mixed: true, hidden: true }), mkRow('Industry', 'string'), mkRow('NumberOfEmployees', 'int')];

  it('Save pressed with nothing touched changes nothing — the hidden row included', async () => {
    const node = twoRecords(), before = JSON.parse(JSON.stringify(node.valueOverrides));
    const d = dialog(rowsOf(), node, ['A', 'B']);
    await d.clickSave();
    expect(node.valueOverrides).toEqual(before);
    expect(d.closed()).toBe(1);
    expect(d.toasts[0][0]).toBe('Nothing changed — each record keeps its own typed values.');
  });
  it('a value typed for all is set on both; the untouched mixed rows keep each record\'s own value', async () => {
    const node = twoRecords(), rows = rowsOf();
    const d = dialog(rows, node, ['A', 'B']);
    await d.type(rows[2], 'Banking');
    expect(rows[2].inp.dataset.veDirty).toBe('1');
    expect(rows[0].inp.dataset.veDirty).toBeUndefined();
    await d.clickSave();
    expect(V.sftkValOvGet(node, TGT, 'A')).toEqual({ Phone: '111', Fax: '9', Industry: 'Banking' });
    expect(V.sftkValOvGet(node, TGT, 'B')).toEqual({ Phone: '222', Industry: 'Banking' });
    expect(d.toasts[0][0]).toMatch(/^✏ 1 value saved for 2 records/);
  });
  it('a mixed row typed into and erased again is back to "each keeps its own"', async () => {
    const node = twoRecords(), rows = rowsOf(), before = JSON.parse(JSON.stringify(node.valueOverrides));
    const d = dialog(rows, node, ['A', 'B']);
    await d.type(rows[0], '5');
    await d.type(rows[0], '');
    await d.clickSave();
    expect(node.valueOverrides).toEqual(before);
  });
  it('the ✕ of a mixed row clears that field on every record, and only that field', async () => {
    const node = twoRecords(), rows = rowsOf();
    const d = dialog(rows, node, ['A', 'B']);
    await rows[0].clr.fire('click');
    expect(rows[0].inp.dataset.veCleared).toBe('1');
    await d.clickSave();
    expect(V.sftkValOvGet(node, TGT, 'A')).toEqual({ Fax: '9' });
    expect(V.sftkValOvGet(node, TGT, 'B')).toEqual({});
    expect(d.toasts[0][0]).toMatch(/^✏ 1 typed value cleared — every other typed value of these records is kept\.$/);
  });
  it('∅ writes the field empty on every record; a typed value over a mixed row replaces both', async () => {
    const node = twoRecords(), rows = rowsOf();
    const d = dialog(rows, node, ['A', 'B']);
    await rows[2].nul.fire('click');
    expect(rows[2].tr.classList.contains('ds-ve-null-on')).toBe(true);
    await d.type(rows[0], '333');
    await d.clickSave();
    expect(V.sftkValOvGet(node, TGT, 'A')).toEqual({ Phone: '333', Fax: '9', Industry: null });
    expect(V.sftkValOvGet(node, TGT, 'B')).toEqual({ Phone: '333', Industry: null });
  });
  it('a value that does not fit its field stops the Save: nothing stored, the row says why, the dialog stays', async () => {
    const node = twoRecords(), rows = rowsOf(), before = JSON.parse(JSON.stringify(node.valueOverrides));
    const d = dialog(rows, node, ['A', 'B']);
    await d.type(rows[2], 'Banking');
    await d.type(rows[3], 'seven');
    await d.clickSave();
    expect(node.valueOverrides).toEqual(before);
    expect(rows[3].err.textContent).toMatch(/^needs /);
    expect(d.closed()).toBe(0);
    expect(d.saves()).toBe(0);
    expect(d.toasts[0][1]).toBe('error');
  });
});

// ═══ 4b. History: a done mark the popup wrote is never written over ═════════
describe('storageSaveHistory and the storage listener keep the popup\'s done mark', () => {
  const tool = (id, done) => ({ id, kind: 'tool', toolUndo: done ? { steps: [], done: { at: 'x', ok: true, entryId: 'u1' } } : { steps: [] } });
  const listener = sliceBetween('studio-core.js', 'try {\n  chrome.storage.onChanged.addListener(', '\nasync function storageSaveHistory(');
  const world = (initial, stored, opt = {}) => {
    const writes = [], listeners = [];
    let renders = 0;
    const chrome = { storage: {
      onChanged: { addListener: f => listeners.push(f) },
      local: {
        get: async () => { if (opt.getThrows) throw new Error('no storage'); return { sftk_history: stored }; },
        set: async (o) => { writes.push(JSON.parse(JSON.stringify(o))); },
      } } };
    const w = scope(`let _history = initial, _currentView = 'history';\nconst _settings = {};\n`
      + `${sliceFn('sftk-archive.js', 'sftkHistorySplit')}\n${sliceFn('studio-core.js', '_historyStripCountsOnly')}\n`
      + `${sliceFn('studio-core.js', '_historyAdoptToolUpdates')}\n${listener}\n${sliceFn('studio-core.js', 'storageSaveHistory')}`,
      { initial, chrome, showToast: () => {}, renderHistory: () => { renders++; } }, 'storageSaveHistory, history: () => _history');
    return { ...w, writes, listeners, renders: () => renders };
  };

  it('the stored copy has toolUndo.done, this page\'s copy does not: what is written keeps it', async () => {
    const w = world([tool('a', false), { id: 'r', kind: 'transfer' }], [tool('a', true)]);
    await w.storageSaveHistory();
    expect(w.writes).toHaveLength(1);
    const written = w.writes[0].sftk_history;
    expect(written.map(h => h.id)).toEqual(['a', 'r']);
    expect(written[0].toolUndo.done).toEqual({ at: 'x', ok: true, entryId: 'u1' });
  });
  it('an id only storage still holds (dropped here) does not come back on the save', async () => {
    const w = world([tool('a', false)], [tool('a', false), tool('gone', true)]);
    await w.storageSaveHistory();
    expect(w.writes[0].sftk_history.map(h => h.id)).toEqual(['a']);
  });
  it('this page\'s own done mark is never replaced by a stored copy without one; an unreadable storage still saves', async () => {
    const w = world([tool('a', true)], [tool('a', false)]);
    await w.storageSaveHistory();
    expect(w.writes[0].sftk_history[0].toolUndo.done).toBeTruthy();
    const w2 = world([tool('a', false)], null, { getThrows: true });
    await w2.storageSaveHistory();
    expect(w2.writes[0].sftk_history.map(h => h.id)).toEqual(['a']);
  });
  it('the storage listener adopts a done mark and a new tool entry, repaints once, and ignores other keys', async () => {
    const w = world([tool('a', false)], []);
    expect(w.listeners).toHaveLength(1);
    w.listeners[0]({ sftk_history: { newValue: [tool('a', true), tool('n', false)] } }, 'local');
    expect(w.history().map(h => h.id)).toEqual(['a', 'n']);
    expect(w.history()[0].toolUndo.done.entryId).toBe('u1');
    expect(w.renders()).toBe(1);
    w.listeners[0]({ sftk_history: { newValue: [tool('a', true), tool('n', false)] } }, 'local');   // nothing new
    w.listeners[0]({ sftk_history: { newValue: [tool('z', true)] } }, 'sync');
    w.listeners[0]({ ds_settings: { newValue: {} } }, 'local');
    expect(w.renders()).toBe(1);
    expect(w.history().map(h => h.id)).toEqual(['a', 'n']);
    // and the next save writes the adopted mark
    await w.storageSaveHistory();
    expect(w.writes[0].sftk_history[0].toolUndo.done.entryId).toBe('u1');
  });
});
