// 2026-09-19 — executes studio-deploy.js for real against a fake scan, in a stubbed page,
// for the root object and a child object and every tab — to catch the runtime
// slips (ReferenceError / TypeError in a template) that text tests cannot.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
const src = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

function grab(file, name) {            // top-level `function name(` … up to the next column-0 `}`
  const s = src(file); const i = s.indexOf(`function ${name}(`);
  if (i < 0) throw new Error('not found: ' + name);
  const j = s.indexOf('\n}\n', i); return s.slice(i, j + 3);
}

describe('Deploy view — the page actually runs', () => {
  it('paints the plan and every tab of the root and a child object, with the right rules', async () => {
    const els = new Map();
    const mkEl = id => ({ id, innerHTML: '', textContent: '', disabled: false, value: '', dataset: {}, _l: {},
      addEventListener(t, f) { this._l[t] = f; }, querySelector() { return null; }, querySelectorAll() { return []; },
      scrollIntoView() {}, focus() {}, setSelectionRange() {} });
    let mainHtml = '';
    const ctx = {
      console, Set, Map, Object, Number, String, Array, JSON, Math, Promise,
      _settings: {}, storageSaveSettings: async () => {},
      _currentView: 'deploy', _profiles: [], _recDeleteMode: 'recycle',
      _recSel: { push: new Set(), overwrite: new Set(), updSrc: new Set(), del: new Set(), pull: new Set() },
      _recChildSel: {}, _reconcileProfile: null,
      window: { runProfile() {}, openReconcile() {}, sftkOrgLocked: () => false, refreshProfileState: async () => {} },
      document: { querySelectorAll: () => [], querySelector: () => null },
      eid: id => { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); },
      setMain: h => { mainHtml = h; },
      esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
      dsViewHeader: o => `<header>${o.title}${o.subtitle}${o.actions}</header>`,
      orgLabel: u => String(u).replace(/^https?:\/\//, '').split('.')[0],
      prodBadge: () => '', timeAgo: () => '1m ago', showToast() {}, showModal() {}, renderProfiles() {},
      renderReconcile() {}, runReconcile() {}, scanReconcileChild: async () => ({}),
      sftkRecResetSelectionFor() {}, sftkRecScanFresh: () => true,
      sftkOpenDriftCompare() {}, renderLkpOverridePanel() {},
  _parentSyncVerdicts: { 'k|Campaign': { missing: 0, changed: 0, at: '2026-09-21T10:00:00Z' } }, sftkParentSyncKey: (s, t, o) => 'k|' + o,
  sftkParentGapSetGate: (p, scan, ps, has) => { ctx.__gate = { ps, has }; }, sftkParentVerifyOne: async () => true, sftkOpenParentsFirst: async () => true,
  sftkRecWireDupFix() {}, sftkRecSetEngine: async () => 'auto',
  sftkOrgKey: u => String(u), sftkOpenIdentityModal() {},
  sftkIdStatusFor: async () => ({ srcOnline: true, tgtOnline: true, objects: [
    { pathKey: '', obj: 'Account', depth: 0, src: 'no', tgt: 'yes', customizable: true }, { pathKey: '0', obj: 'Contact', depth: 1, src: 'no', tgt: 'no', customizable: true }] }),

  sftkParentOrderFor: async () => ({ offline: false, objects: [
    { pathKey: '', obj: 'Account', depth: 0, parentObj: null, parents: [{ field: 'Primary_Campaign__c', refObj: 'Campaign', empty: false, required: false, srcCount: 12 }, { field: 'Region__c', refObj: 'Region__c', empty: true, required: true, srcCount: 40 }, { field: 'IndividualId', refObj: 'Individual', empty: true, required: false, srcCount: 0 }, { field: 'Big__c', refObj: 'Big__c', empty: false, required: false, srcCount: 90000 }] },
    { pathKey: '0', obj: 'Contact', depth: 1, parentObj: 'Account', parents: [{ field: 'Campaign__c', refObj: 'Campaign', empty: false, required: false }] }] }),
      sftkLkpOvGet: () => ({}), sftkMatchKeyLabel: k => String(k),
      getNodeByPath: (root, k) => k.split('.').reduce((n, i) => n.children[Number(i)], root),
    };
    vm.createContext(ctx);
    for (const [f, n] of [['studio-scan.js', 'sftkBucketCapShipped'], ['studio-scan.js', 'sftkScanBucketInfo'], ['studio-scan.js', 'sftkBucketCountLabel'],
      ['studio-reconcile.js', 'sftkRecChildRowState'], ['studio-reconcile.js', 'sftkPaContactsLine'],
      ['studio-reconcile.js', 'sftkParentStepState'], ['studio-reconcile.js', 'sftkRecDupsHtml'], ['sftk-identity.js', 'sftkIdCreatable']]) vm.runInContext(grab(f, n), ctx);
    vm.runInContext(src('studio-deploy.js').replace(/^'use strict';/, ''), ctx, { filename: 'studio-deploy.js' });

    const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
    const profile = {
      id: 'p1', name: 'Account + Contacts', sourceOrg: 'https://trailheads2.my.salesforce.com', targetOrg: 'https://trailheads4.my.salesforce.com',
      tree: { objectType: 'Account', children: [{ childSObject: 'Contact', field: 'AccountId', children: [] }] },
      lastScan: {
        status: 'success', runAt: 'T1', fetched: { src: 5058, tgt: 10 }, compareFields: ['Name'], nearMisses: 1,
        warnings: ['example warning'], bucketCapNote: 'This Account scan is TRUNCATED',
        bucketCaps: { cap: 5000, missingInTarget: { shown: 5000, total: 5048, capped: true, cap: 5000 } },
        missingInTarget: rows(400, i => ({ matchKey: 'Acct ' + i, sourceId: 'S' + i, nearMiss: i === 3 ? { reason: 'case' } : null })),
        changed: [{ matchKey: 'Noa Levi', sourceId: 'SC1', targetId: 'TC1', fields: ['Phone', 'PersonEmail', 'Description', 'Fax'] }],
        onlyInTarget: [{ matchKey: 'Stray', targetId: 'TX1' }],
        identical: rows(10, i => ({ matchKey: 'Same ' + i, sourceId: 'SS' + i, targetId: 'TS' + i })),
        personContacts: null,
        children: { '0': { status: 'success', rootRunAt: 'T1', objectType: 'Contact', fetched: { src: 30, tgt: 12 }, compareFields: ['LastName'],
          linkMasterDetail: false, linkUpdateable: true,
          missingInTarget: [{ matchKey: 'Kid A', sourceId: 'K1', parentSrcId: 'S1', parentKeySrc: 'Acct 1' }, { matchKey: 'Kid B', sourceId: 'K2', parentSrcId: 'SS1', parentKeySrc: 'Same 1' },
                            { matchKey: 'Kid C', sourceId: 'K3', parentSrcId: 'ZZ', parentKeySrc: '?' }, { matchKey: 'Kid D', sourceId: 'K4', parentSrcId: null }],
          changed: [{ matchKey: 'Kid E', sourceId: 'K5', targetId: 'TK5', fields: ['Title'] }],
          onlyInTarget: [{ matchKey: 'Kid F', targetId: 'TK6', orphan: true }, { matchKey: 'Kid G', targetId: 'TK7' }],
          linkMismatch: [{ matchKey: 'Kid H', sourceId: 'K8', targetId: 'TK8', parentKeySrc: 'Acct 2', parentKeyTgt: 'Acct 9' }],
          identical: [{ matchKey: 'Kid I', sourceId: 'K9', targetId: 'TK9', personAccount: true }],
          personContacts: { src: 10, tgt: 10, synced: 1, waiting: 0, follows: 0, targetOnly: 0 } } },
      },
    };
    ctx._reconcileProfile = profile;

    let checks = 0; const failures = [];
    const need = (cond, msg) => { checks++; if (!cond) failures.push(msg); };
    for (const [path, tabs] of [['', ['ins', 'chg', 'ext', 'same']], ['0', ['ins', 'chg', 'ext', 'link', 'same']]]) {
      for (const t of tabs) {
        vm.runInContext(`_depObjPath = ${JSON.stringify(path)}; _depTab = ${JSON.stringify(t)}; _depFilter = '';`, ctx);
        await vm.runInContext('renderDeploy()', ctx);
        const list = els.get('dsDepList').innerHTML;
        need(mainHtml.includes('What the two orgs hold'), `${path}/${t}: plan card painted`);
        need(list.includes('ds-dep-tools'), `${path}/${t}: list toolbar painted`);
        need(!/undefined|\[object Object\]|NaN/.test(list), `${path}/${t}: no undefined/NaN/[object Object] in the list → ${(list.match(/.{30}(undefined|\[object Object\]|NaN).{30}/) || [''])[0]}`);
        need(!/undefined|\[object Object\]|NaN/.test(mainHtml), `${path}/${t}: no undefined/NaN/[object Object] in the page → ${(mainHtml.match(/.{40}(undefined|\[object Object\]|NaN).{40}/) || [''])[0]}`);
      }
    }
    // specifics
    vm.runInContext(`_depObjPath = ''; _depTab = 'ins';`, ctx); await vm.runInContext('renderDeploy()', ctx);
    need(mainHtml.includes('5,000 of 5,048'), 'root Insert shows the measured total of a capped bucket');
    need(els.get('dsDepList').innerHTML.includes('This list is truncated'), 'capped bucket says so');
    need((els.get('dsDepList').innerHTML.match(/class="ds-dep-row"/g) || []).length === 300, 'the list is a 300-row window');
    need(els.get('dsRecRunBtn').disabled === true, 'nothing selected → Deploy disabled');
    vm.runInContext(`_depObjPath = '0'; _depTab = 'ins';`, ctx); await vm.runInContext('renderDeploy()', ctx);
    const kid = els.get('dsDepList').innerHTML;
    need(/data-dep-push="K3"[^>]*disabled/.test(kid), 'a child whose parent is untracked cannot be ticked');
    need(!/data-dep-push="K1"[^>]*disabled/.test(kid) && kid.includes('comes along'), 'a child whose parent is missing can be ticked and says the parent comes along');
    need(kid.includes('Person Account contacts (10 in trailheads2'), 'the child list carries the Person Account line');
    vm.runInContext(`_recSel.push.add('S1'); _depChildSel('0').relink.add('TK8');`, ctx); await vm.runInContext('renderDeploy()', ctx);
    need(els.get('dsRecRunBtn').disabled === false && /Deploy 2 selected/.test(els.get('dsRecRunBtn').textContent), 'a selection arms Deploy with the right count');
    // ⛓ Start with parents first — always there, every object, one step per outside object
    await new Promise(r => setTimeout(r, 0));
    const order = els.get('dsDepOrder').innerHTML;
    need(order.includes('Start with parents first'), 'the parents-first card is painted even though nothing forces it');
    need((order.match(/class="ds-ordstep-num">/g) || []).length === 5, 'four outside objects + this deployment = five steps');
    need(order.includes('not needed — the source has none'), 'a parent object the SOURCE has none of is not a gap (live 2026-09-21: Individual, 0 in both orgs)');
    need(order.includes('90,000 records') && order.includes('Check now'), 'a big parent object is not scanned on load — it asks');
    need(order.includes('not aligned'), 'the card title carries the one-glance verdict');
    need(order.includes('Account.Primary_Campaign__c') && order.includes('Contact.Campaign__c'), 'Campaign names BOTH the root field and the child field that need it');
    need(order.includes('✓ in sync'), 'a parent with a clean verdict reads in sync');
    need(order.includes('has none at all') && order.includes('Stop'), 'a required parent the target has none of is a stop');
    need(order.includes('Account → Contact'), 'the last step is this deployment, in parent-before-child order');
    need(ctx.__gate && ctx.__gate.ps.length === 4 && ctx.__gate.has === true, 'the run gate is fed with the ROOT parents, only when the root has inserts');
    // 🌳 the visual tree, with identity per org and outside parents per object
    await new Promise(r => setTimeout(r, 0));
    const tree = els.get('dsDepTree').innerHTML;
    need(tree.includes('This deployment') && (tree.match(/class="ds-tree-node/g) || []).length === 2, 'the tree draws one node per object');
    need(tree.includes('via AccountId') && tree.includes('recognised by'), 'a child says how it hangs under its parent, and every node how its records are recognised');
    need(tree.includes('🪪 target ✓') && tree.includes('🪪 target ✗'), 'each node shows whether each org holds the identity field');
    need(tree.includes('points at') && tree.includes('Campaign'), 'a node names the outside objects it points at');
    need(tree.includes('no identity field'), 'the tree says which objects cannot be recognised exactly yet');
    // duplicate names: who they are + the fixes
    ctx._reconcileProfile.lastScan.dupKeys = { rows: 4, keys: ['Acme', 'Beta'], examples: [{ key: 'Acme', src: ['001A', '001B'], tgt: ['001C', '001D'] }] };
    await vm.runInContext('renderDeploy()', ctx);
    need(mainHtml.includes('copy 1') && mainHtml.includes('/lightning/r/001A/view'), 'the duplicate names are listed with links to each copy');
    need(mainHtml.includes('How to fix it, safest first') && mainHtml.includes('data-rec-dupfix="stamp"') && mainHtml.includes('Do this last'), 'the fixes are listed in a safe order');
    need(mainHtml.includes('id="dsDepApiMode"') && mainHtml.includes('id="dsDepBatch"') && mainHtml.includes('id="dsDepThreads"'), 'Engine, batch size and threads are on the page');
    vm.runInContext(`_depObjPath = ''; _depTab = 'same';`, ctx); await vm.runInContext('renderDeploy()', ctx);
    need(els.get('dsDepList').innerHTML.includes('▸ compare'), 'a Synced row can be compared across the two orgs');
    expect(failures).toEqual([]);
        expect(checks).toBeGreaterThan(40);
  });
});
