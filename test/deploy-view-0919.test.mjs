import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunction, extractFunctions } from './extract.mjs';

// 2026-09-19 — user: "Can you implement it with the option for us to go back
// to the current view?" The Deploy view sits BESIDE Run Transfer + Reconcile,
// behind a switch. It is a presentation: same scan, same selection Sets, same
// run function. These tests pin that contract.
const DV = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const CO = readFileSync(new URL('../studio-core.js', import.meta.url), 'utf8');
const PR = readFileSync(new URL('../studio-profiles.js', import.meta.url), 'utf8');
const HT = readFileSync(new URL('../studio.html', import.meta.url), 'utf8');
const code = DV.replace(/\/\/[^\n]*/g, '');   // comments may NAME what the code must not do

// 1.5.0 (user 2026-09-21: "i want to use the new view on it … and only the new view").
describe('the Deploy view is the page: every door opens it', () => {
  it('on unless the no-button fallback key says classic', () => {
    expect(DV).toContain('return !(typeof _settings === \'object\' && _settings && _settings.deployViewClassic === true);');
    expect(DV).not.toContain('deployViewBeta');
  });
  it('ONE seam: anything that ends in renderReconcile() lands on the Deploy view', () => {
    const i = RC.indexOf('async function renderReconcile() {');
    expect(RC.slice(i, i + 700)).toContain("if (typeof renderDeploy === 'function' && typeof sftkDeployViewOn === 'function' && sftkDeployViewOn()) { _currentView = 'deploy'; return renderDeploy(); }");
    // Compare, Ring and the Seeder set 'reconcile' and call renderReconcile() — the seam covers them
    for (const file of ['studio-compare.js', 'studio-ring.js', 'studio-seed.js']) {
      const src = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
      const k = src.indexOf("_currentView = 'reconcile';");
      expect(k).toBeGreaterThan(0);
      expect(src.slice(k, k + 400)).toContain('renderReconcile();');
    }
  });
  it('a scan that lands while the page is open repaints it (post-run refresh, first scan of a new pair)', () => {
    const SC = readFileSync(new URL('../studio-scan.js', import.meta.url), 'utf8');
    expect(SC).toContain("else if ((_currentView === 'reconcile' || _currentView === 'deploy') && typeof renderReconcile === 'function'");
  });
  it('the card has ONE way in, and no switch', () => {
    expect(PR).not.toContain('dsDeployViewSwitch');
    expect(PR).toContain('>🚀 Deploy</button>');
    expect(PR).not.toContain('data-dsaction="openReconcile" data-arg="${p.id}"');
    expect(PR).not.toContain('>⚖ Reconcile</button>');
    expect(DV).not.toContain('data-dsaction="deployToClassic"');
    expect(DV).not.toContain('ds-dep-beta');
  });
  it('▶ (palette, builder) still routes through the wrapped runProfile', () => {
    expect(DV).toContain('window.sftkClassicRunProfile = classicRun;');
    expect(DV).toContain('if (sftkDeployViewOn() && typeof window.openReconcile === \'function\') return window.openReconcile(profileId, targetUrl);');
  });
  it('History never opens the old Run page: Run again and Retry failed both land here', () => {
    const SC = readFileSync(new URL('../studio-scan.js', import.meta.url), 'utf8');
    const retry = SC.slice(SC.indexOf('window.retryFailedRun = function(runId) {'), SC.indexOf('function sftkRetrySplit(filters) {'));
    expect(retry.indexOf('return window.sftkDeployRetry(profile.id, byPath,')).toBeGreaterThan(0);
    expect(retry.indexOf('return window.sftkDeployRetry(profile.id, byPath,')).toBeLessThan(retry.indexOf('renderTransfer();'));
    const again = PR.slice(PR.indexOf('window.runAgain = function(runId) {'));
    expect(again.indexOf('return window.openReconcile?.(prof.id, runTgt || undefined);')).toBeLessThan(again.indexOf('renderTransfer();'));
    expect(CO.slice(CO.indexOf('window.startTransferFrom = function(targetOrg) {')).indexOf('renderProfiles();')).toBeLessThan(CO.slice(CO.indexOf('window.startTransferFrom = function(targetOrg) {')).indexOf('renderTransfer();'));
  });
  it('what the classic header offered is on the page: save a one-off pair, pair records by hand', () => {
    expect(DV).toContain('data-dsaction="saveEphemeralProfile"');
    expect(DV).toContain("eid('dsDepMatchReview')?.addEventListener('click', () => openMatchReview(p));");
    // offered only when there is something on BOTH sides to pair (the empty-dialog bug of 2026-09-21)
    expect(DV).toContain("(scan.missingInTarget || []).length && (scan.onlyInTarget || []).length ? `<button class=\"ds-btn ds-btn-sm\" id=\"dsDepMatchReview\"");
  });
});

describe('↻ Retry failed ticks what it can prove, and reports the rest', () => {
  const picks = extractFunction('studio-deploy.js', 'sftkDeployRetryPicks');
  const line = extractFunction('studio-deploy.js', 'sftkDeployRetryLine');
  const scan = {
    missingInTarget: [{ sourceId: 'A1' }, { sourceId: 'A2' }], changed: [{ sourceId: 'A3' }], identical: [{ sourceId: 'A4' }],
    children: { '0': { missingInTarget: [{ sourceId: 'C1', p: 'A4' }, { sourceId: 'C2', p: 'ZZ' }], changed: [{ sourceId: 'C3' }] } }
  };
  const rowState = (r, depth, pMissing, pExists) => (pExists.has(r.p) || pMissing.has(r.p)) ? 'ok' : 'untracked';
  it('root: Insert rows are ticked, Changed rows are counted, the rest is reported', () => {
    const r = picks(scan, { '': ['A1', 'A3', 'A9'] }, rowState);
    expect(r.picks).toEqual({ '': ['A1'] });
    expect(r).toMatchObject({ found: 1, inChanged: 1, lost: 1, total: 3 });
  });
  it('child: only rows the page would let the user tick', () => {
    const r = picks(scan, { '0': ['C1', 'C2', 'C3'] }, rowState);
    expect(r.picks).toEqual({ '0': ['C1'] });          // C2's parent is unknown in the target → not ticked
    expect(r).toMatchObject({ found: 1, inChanged: 1, lost: 1 });
  });
  it('fails closed: an unscanned object, or no parent rule, ticks nothing', () => {
    expect(picks(scan, { '1': ['X1'] }, rowState)).toMatchObject({ picks: {}, lost: 1 });
    expect(picks(scan, { '0': ['C1'] }, null).picks).toEqual({});
    expect(picks(null, { '': ['A1'] }, rowState)).toMatchObject({ picks: {}, lost: 1 });
  });
  it('the line says all three numbers and never claims more', () => {
    const t = line({ found: 1, inChanged: 1, lost: 2, total: 4 });
    expect(t).toContain('1 of 4 failed record(s) are ticked');
    expect(t).toContain('1 are under 🟡 Changed');
    expect(t).toContain('2 are not in an Insert list');
    expect(line({ total: 0 })).toBe('');
  });
  it('a rescan empties the selection, so it drops the line too', () => {
    expect(DV).toContain("_recChildSel = {}; _depRetryNote = '';");
  });
});

// 2026-09-22 — the Deploy tree reused the builder's .ds-tree-node class; the
// appended rule (max-width 300px, flex item) squeezed the builder's object
// tree into a narrow column with its lookup hint spilling beside it.
describe('the Deploy tree has its own class prefix', () => {
  it('never reuses a builder tree class', () => {
    expect(DV).not.toMatch(/ds-tree[-"' ]/);
    expect(DV).toContain('class="ds-dtree-node');
  });
  it('the stylesheet keeps one .ds-tree-node rule, the builder one', () => {
    const CSS = readFileSync(new URL('../studio.css', import.meta.url), 'utf8');
    expect((CSS.match(/^\.ds-tree-node \{/gm) || []).length).toBe(1);
    expect(CSS).toContain('.ds-dtree-node {');
  });
});

// 2026-09-22 — "we see the tag of both source and target here, while there's
// only one of each": the chips name the org. And Bulk API 2.0 has no batch
// size or threads — say so instead of dimming two inputs.
describe('identity chips name the org; Bulk hides the Collections knobs', () => {
  it('the chips are labelled with orgLabel(), never "source"/"target"', () => {
    expect(DV).toContain("const srcOrgL = orgLabel(p.sourceOrg || '') || 'source', tgtOrgL = orgLabel(p.targetOrg || '') || 'target';");
    expect(DV).toContain('${idPill(id ? id.src : null, srcOrgL)} ${idPill(id ? id.tgt : null, tgtOrgL)}');
    expect(DV).not.toContain("idPill(id ? id.src : null, 'source')");
  });
  it('with Bulk selected the batch/threads inputs are not rendered, and the line says why', () => {
    expect(DV).toContain('Bulk API 2.0 splits the job itself — no batch size or threads');
    const bar = DV.slice(DV.indexOf('${p.apiMode === \'bulk\''), DV.indexOf('id="dsDepUndoCapture"'));
    expect(bar).toContain('? `<span class="ds-dep-sub"');
    expect(bar).toContain('id="dsDepBatch"');
    expect(bar).not.toContain("${p.apiMode === 'bulk' ? 'disabled' : ''}");
  });
});

// 2026-09-22 — live runs: 11 clicks to read the children, 11 more after every
// refresh, and the run log wiped by the post-run repaint.
describe('Deploy page: scan all, refresh re-reads children, the run log stays', () => {
  const order = extractFunction('studio-deploy.js', 'sftkDeployChildOrder');
  it('children are read parents-first, in tree order', () => {
    expect(order(['2', '1.1', '0', '1', '1.0', '2.0', ''])).toEqual(['0', '1', '2', '1.0', '1.1', '2.0']);
    expect(order(null)).toEqual([]);
  });
  it('one button reads every unread child; Refresh re-reads the ones read before', () => {
    expect(DV).toContain('id="dsDepScanAll"');
    expect(DV).toContain("eid('dsDepScanAll')?.addEventListener('click', () => _depScanAll(p, unscanned.map(r => r.pathKey)));");
    const rescan = DV.slice(DV.indexOf('async function _depRescan(p) {'), DV.indexOf('function sftkDeployChildOrder'));
    expect(rescan.indexOf('const kids = sftkDeployChildOrder(Object.keys((p.lastScan && p.lastScan.children) || {}));')).toBeLessThan(rescan.indexOf('await window.refreshProfileState?.(p.id);'));
    expect(rescan).toContain('const res = await scanReconcileChild(fp, kids[i]);');
  });
  it('the last run log is kept across the repaint and shown under the bar, per deployment', () => {
    expect(DV).toContain("_depLastRunLog = { pid: p.id, html: cur.innerHTML };");
    expect(DV).toContain('if (_depLastRunLog && _depLastRunLog.pid !== p.id) _depLastRunLog = null;');
    expect(DV).toContain('class="ds-rec-card ds-dep-lastlog"');
  });
});

// 2026-09-22 — the builder hid lookups that point into the deployment, so a
// user could not tell whether an Account hierarchy travels.
describe('the builder shows in-tree lookups as informational rows', () => {
  const BL = readFileSync(new URL('../studio-builder.js', import.meta.url), 'utf8');
  it('lists them next to the configurable ones, with no strategy to set', () => {
    expect(BL).toContain('function getInTreeReferenceFields(node) {');
    expect(BL).toContain("if (!resolvable.length && !inTree.length) return '';");
    expect(BL).toContain('class="ds-lkp-row ds-lkp-row-intree"');
    expect(BL).toContain('points at another record of this same object');
    expect(BL).toContain('connected after insert when this run creates it. Nothing to set.');
  });
});

describe('load order', () => {
  it('the script is loaded after the pages it builds on', () => {
    expect(HT.indexOf('studio-reconcile.js')).toBeLessThan(HT.indexOf('studio-deploy.js'));
    expect(HT.indexOf('studio-profiles.js')).toBeLessThan(HT.indexOf('studio-deploy.js'));
  });
});

describe('the new page owns no engine: same scan, same selection, same run', () => {
  it('runs through runReconcile with the classic bucket shape and the classic element ids', () => {
    expect(DV).toContain("runReconcile(p, objType,");
    expect(DV).toContain('missing: scan.missingInTarget || [], drift: scan.changed || [], extras: scan.onlyInTarget || []');
    expect(DV).toContain('id="dsRecRunBtn"');
    expect(DV).toContain('id="dsRecProgress"');
    expect(DV).toContain('id="dsDepOrder"');
  });
  it('never talks to the background itself', () => {
    expect(code).not.toMatch(/sendBg\s*\(/);
    expect(code).not.toMatch(/chrome\.runtime/);
    expect(code).not.toMatch(/SF_[A-Z_]+/);
  });
  it('writes into the classic Sets and nothing else', () => {
    for (const s of ['_recSel.push', '_recSel.overwrite', '_recSel.updSrc', '_recSel.del', '_recSel.pull', 'sel.push', 'sel.relink', 'sel.overwrite', 'sel.del']) expect(DV).toContain(s);
    expect(DV).toContain('_recDeleteMode = e.target.value;');
  });
  it('NOTHING is selected by default (user 2026-09-14) — no seeding anywhere', () => {
    expect(code).not.toMatch(/forEach\([^)]*=>\s*_recSel\.(push|overwrite)\.add/);
    expect(DV).toContain('Nothing is selected until you select it');
  });
  it('shares the safety checks instead of copying them', () => {
    expect(DV).toContain('sftkRecResetSelectionFor(p);');
    expect(DV).toContain('const fresh = sftkRecScanFresh(p);');
    expect(DV).toContain('sftkRecChildRowState(r, cur.depth, pMissing, pExists)');
    expect(RC).toContain('const scanFresh = sftkRecScanFresh(p);');
    expect(RC).toContain('const rowState = r => sftkRecChildRowState(r, depth, pMissingSet, pExistsSet);');
  });
  it('a child row helper reads a VIEW rooted at the real node, not a clone', () => {
    expect(DV).toContain('const prof = isRoot ? p : { ...p, tree: node, lastScan: s };');
  });
  it('orphans stay out of bulk delete, a locked source switches ← off, a blocked relink stays off', () => {
    expect(DV).toContain('if (on && r.orphan) continue;');
    expect(DV).toContain("${opts.srcLocked ? 'disabled' : ''}");
    expect(DV).toContain('const relinkBlocked = !isRoot && !!(s.linkMasterDetail && s.linkUpdateable === false);');
  });
  it('a rescan clears every selection, like the classic 🔄', () => {
    const fn = DV.slice(DV.indexOf('async function _depRescan(p)'), DV.indexOf('// ── one bucket of one object'));
    expect(fn).toContain('_recChildSel = {};');
    expect(fn).toContain('await window.refreshProfileState?.(p.id);');
  });
});

describe('shared safety checks (extracted, behaviour unchanged)', () => {
  const state = extractFunction('studio-reconcile.js', 'sftkRecChildRowState');
  it('child row state: none / missing / deepblock / exists / untracked', () => {
    const miss = new Set(['P1']), ex = new Set(['P2']);
    expect(state({ parentSrcId: null }, 1, miss, ex)).toBe('none');
    expect(state({ parentSrcId: 'P1' }, 1, miss, ex)).toBe('missing');
    expect(state({ parentSrcId: 'P1' }, 2, miss, ex)).toBe('deepblock');
    expect(state({ parentSrcId: 'P2' }, 2, miss, ex)).toBe('exists');
    expect(state({ parentSrcId: 'P9' }, 1, miss, ex)).toBe('untracked');
  });
  it('the scan-fresh rule still names the delete-by-id hazard it guards', () => {
    const i = RC.indexOf('function sftkRecScanFresh(p) {');
    expect(i).toBeGreaterThan(0);
    expect(RC.slice(i - 700, i)).toContain('SAFETY-critical');
    expect(RC.slice(i, i + 500)).toContain('sftkOrgKey(scan.targetOrg) === sftkOrgKey(p.targetOrg');
  });
});

describe('pure helpers', () => {
  const F = extractFunctions('studio-deploy.js', ['sftkDeployObjects', 'sftkDeployChildFresh', 'sftkDeployScanFor', 'sftkDeploySelection']);
  const tree = { objectType: 'Account', children: [{ childSObject: 'Contact', field: 'AccountId', children: [{ childSObject: 'Case', field: 'ContactId' }] }, { childSObject: 'Opportunity', field: 'AccountId' }] };

  it('lists every object with its tree path, root first', () => {
    expect(F.sftkDeployObjects(tree).map(o => `${o.pathKey}|${o.obj}|${o.depth}|${o.parentObj}`)).toEqual(
      ['|Account|0|null', '0|Contact|1|Account', '0.0|Case|2|Contact', '1|Opportunity|1|Account']);
    expect(F.sftkDeployObjects(null)).toEqual([]);
  });
  it('a child scan counts only when it succeeded, belongs to THIS root scan and is for this object', () => {
    const scan = { runAt: 'T1', children: { '0': { status: 'success', rootRunAt: 'T1', objectType: 'Contact' }, '1': { status: 'success', rootRunAt: 'T0', objectType: 'Opportunity' } } };
    expect(F.sftkDeployChildFresh(scan, '0', 'Contact')).toBe(true);
    expect(F.sftkDeployChildFresh(scan, '0', 'Lead')).toBe(false);        // another object on the same path
    expect(F.sftkDeployChildFresh(scan, '1', 'Opportunity')).toBe(false); // from an older root scan
    expect(F.sftkDeployChildFresh(scan, '7', 'Case')).toBe(false);
    expect(F.sftkDeployChildFresh(null, '0', 'Contact')).toBe(false);
  });
  it('an unscanned child is unknown, never zero', () => {
    const scan = { runAt: 'T1', children: {} };
    expect(F.sftkDeployScanFor(scan, { depth: 0, pathKey: '', obj: 'Account' })).toBe(scan);
    expect(F.sftkDeployScanFor(scan, { depth: 1, pathKey: '0', obj: 'Contact' })).toBe(null);
  });
  it('the selection summary counts root and child Sets, in words', () => {
    const recSel = { push: new Set(['a', 'b']), overwrite: new Set(['c']), updSrc: new Set(), del: new Set(), pull: new Set() };
    const kids = { '0': { push: new Set(['k1']), relink: new Set(['k2', 'k3']), overwrite: new Set(), del: new Set() } };
    const s = F.sftkDeploySelection(recSel, kids, 'Account', { '0': 'Contact' });
    expect(s.total).toBe(6);
    expect(s.parts).toEqual(['2 Account to insert', '1 Account to update (source wins)', '1 Contact to insert', '2 Contact to relink']);
    expect(F.sftkDeploySelection(null, null, 'Account', {})).toEqual({ parts: [], total: 0 });
  });
});

describe('the plan uses measured totals, not the length of a capped list', () => {
  it('reads sftkScanBucketInfo / sftkBucketCountLabel and says when a list is truncated', () => {
    expect(DV).toContain('sftkDeployPlanRows(p.tree, scan, sftkScanBucketInfo, sftkBucketCountLabel)');
    expect(DV).toContain('const n = i.total != null ? i.total : i.shown;');
    expect(DV).toContain('This list is truncated');
  });
  it('uses today\'s Reconcile names, colours and order', () => {
    const i = DV.indexOf('const SFTK_DEPLOY_TABS = [');
    const block = DV.slice(i, i + 900);
    const order = ['🔴 Insert', '🟡 Changed', '🔵 In target only', '⇄ Link differs', '🟢 Synced'].map(l => block.indexOf(l));
    expect(order.every(x => x > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it('says plainly what is not built yet', () => {
    expect(DV).toContain('dry run is the next step of this page and is not built yet');
  });
});

describe('first live look (2026-09-19): the page states each thing once', () => {
  it('the plan is the table — no duplicate chip row above it', () => {
    expect(DV).not.toContain("chip('ins'");
    expect(DV).toContain('class="ds-dep-total"');
  });
  it('the truncation warning is one line in the notes; the full wording stays on the tab', () => {
    expect(DV).toContain("Open that tab for what it means for ▶ Deploy.");
    expect(DV).toContain('This list is truncated');
  });
  it('the Deploy bar does not float over the list', () => {
    const css = readFileSync(new URL('../studio.css', import.meta.url), 'utf8');
    expect(css).toContain('.ds-dep-actionbar { position: static; box-shadow: none; }');
    expect(css).toContain('.ds-dep-page { max-width: none;');   // one width: the view header's
  });
});

describe('2026-09-21 — four asks from the live page', () => {
  const parentState = extractFunction('studio-reconcile.js', 'sftkParentStepState');
  const orderSteps = extractFunction('studio-deploy.js', 'sftkDeployOrderSteps');
  it('parents first: one state rule, shared with the classic advisor', () => {
    expect(parentState({ empty: true }, { missing: 0, changed: 0 })).toBe('empty');
    expect(parentState({ empty: false }, null)).toBe('unknown');
    expect(parentState({ empty: false }, { missing: 0, changed: 0 })).toBe('done');
    expect(parentState({ empty: false }, { missing: 2, changed: 0 })).toBe('behind');
    expect(RC).toContain("done: sftkParentStepState(g, vd) === 'done',");
  });
  it('parents first: the classic advisor now calls the shared probe, verify and journey', () => {
    const adv = RC.slice(RC.indexOf('async function sftkRecParentGapAdvisor('));
    expect(adv).toContain('const parents = await sftkParentGapsFor(objType, desc, tdesc, treeObjs, tgtSess);');
    expect(adv).toContain('await sftkParentVerifyOne(p, s.refObj);');
    expect(adv).toContain('await sftkOpenParentsFirst(p, refObj, objType)');
    // its own rule is unchanged: it still speaks only when the root has inserts
    expect(adv).toContain("if (!(missing || []).length) { _recParentGapState = { key, doomed: [], empties: [] }; return; }");
  });
  it('parents first: one step per OUTSIDE object, naming every object.field that needs it', () => {
    const steps = orderSteps([
      { obj: 'Account', parents: [{ field: 'Camp__c', refObj: 'Campaign', empty: false, required: false }] },
      { obj: 'Contact', parents: [{ field: 'Camp2__c', refObj: 'Campaign', empty: false, required: true }, { field: 'Reg__c', refObj: 'Region__c', empty: true, required: false }] }]);
    expect(steps.map(s => s.refObj)).toEqual(['Campaign', 'Region__c']);
    expect(steps[0].neededBy.map(n => n.obj + '.' + n.field)).toEqual(['Account.Camp__c', 'Contact.Camp2__c']);
    expect(steps[0].required).toBe(true);      // required by ANY needing field
    expect(steps[0].forObj).toBe('Account');   // the journey comes back to the first object that needs it
    expect(orderSteps([])).toEqual([]);
  });
  it('the Deploy view covers every object and is always painted; it no longer leans on the root-only advisor', () => {
    expect(DV).toContain('_depPaintOrder(p, scan);');
    expect(code).not.toContain('sftkRecParentGapAdvisor(');
    expect(RC).toContain('async function sftkParentOrderFor(p) {');
  });
  it('engine settings: one save, one rule set', () => {
    expect(RC).toContain('const _recEnginePersist = () => sftkRecEnginePersist(p);');
    expect(DV).toContain("sftkRecSetEngine(p, 'apiMode', e.target.value)");
    expect(DV).toContain("sftkRecSetEngine(p, 'batchSize', e.target.value)");
    expect(DV).toContain("sftkRecSetEngine(p, 'threads', e.target.value)");
  });
  it('duplicates: both pages draw the same block, and stamping is offered LAST', () => {
    expect(RC).toContain('_health.push(sftkRecDupsHtml(scan, p));');
    expect(DV).toContain('notes.push(sftkRecDupsHtml(scan, p));');
    const fn = RC.slice(RC.indexOf('function sftkRecDupsHtml(scan, p) {'), RC.indexOf('function sftkRecWireDupFix('));
    expect(fn.indexOf('Make the copies one record')).toBeLessThan(fn.indexOf('Then make it stick'));
    expect(fn).toContain('stamping while copies are still ambiguous would cement a coin flip');
  });
  it('a Synced row opens the live compare, and the compare unfolds when nothing differs', () => {
    expect(DV).toContain('▸ compare</button>');
    expect(RC).toContain("if (!body.querySelector('.ds-dc-diff')) body.querySelector('details.ds-dc-fold')?.setAttribute('open', '');");
  });
});

describe('2026-09-21 — the duplicate fixes never send the user into an empty dialog', () => {
  const dups = extractFunction('studio-reconcile.js', 'sftkRecDupsHtml');
  const run = (scan) => {
    globalThis.esc = s => String(s ?? ''); globalThis.orgLabel = u => String(u); globalThis.sftkMatchKeyLabel = k => String(k);
    return dups({ dupKeys: { rows: 2, keys: ['Acme'], examples: [{ key: 'Acme', src: ['1', '2'], tgt: ['3', '4'] }] }, ...scan }, { id: 'p', sourceOrg: 'S', targetOrg: 'T' });
  };
  it('nothing unmatched → no Match review button, and the row says why', () => {
    const html = run({ missingInTarget: [], onlyInTarget: [] });
    expect(html).not.toContain('data-rec-dupfix="review"');
    expect(html).toContain('Pairing by hand is not possible here');
    expect(html).toContain('data-rec-dupfix="stamp"');
  });
  it('unmatched rows on BOTH sides → the button, with both counts', () => {
    const html = run({ missingInTarget: [{}, {}], onlyInTarget: [{}] });
    expect(html).toContain('data-rec-dupfix="review"');
    expect(html).toContain('2 unmatched source record(s) with the 1 unmatched target record(s)');
  });
  it('unmatched on one side only is still nothing to pair', () => {
    expect(run({ missingInTarget: [{}], onlyInTarget: [] })).not.toContain('data-rec-dupfix="review"');
  });
});

describe('2026-09-21 — parents at first sight, checked on load when cheap, and a way back', () => {
  const state = extractFunction('studio-reconcile.js', 'sftkParentStepState');
  const verdict = extractFunction('studio-deploy.js', 'sftkDeployParentsVerdict');
  it('an object the source has none of is not a gap, whatever the target holds', () => {
    expect(state({ empty: true, srcCount: 0 }, null)).toBe('notneeded');
    expect(state({ empty: true, srcCount: 3 }, null)).toBe('empty');
    expect(state({ empty: true }, null)).toBe('empty');                  // classic caller: no count → unchanged
    expect(RC).toContain('(rootParents || []).filter(s => s.srcCount !== 0)');   // and it cannot doom the run gate
  });
  it('one glance: aligned / not aligned / checking / not checked', () => {
    expect(verdict([])).toEqual({ cls: 'ok', text: '✓ no outside parents' });
    expect(verdict([{ state: 'done' }, { state: 'notneeded' }]).text).toBe('✓ all 2 parent object(s) aligned');
    expect(verdict([{ state: 'done' }, { state: 'behind' }]).cls).toBe('bad');
    expect(verdict([{ state: 'done' }, { state: 'empty' }]).text).toContain('1 of 2 parent object(s) not aligned');
    expect(verdict([{ state: 'checking' }]).cls).toBe('wait');
    expect(verdict([{ state: 'large' }]).text).toContain('not checked yet');
  });
  it('alignment is checked on load only when the parent object is small enough', () => {
    expect(DV).toContain('const SFTK_DEPLOY_AUTOCHECK_MAX = 5000;');
    expect(DV).toContain("state = (s.srcCount != null && s.srcCount <= SFTK_DEPLOY_AUTOCHECK_MAX) ? 'checking' : 'large';");
    expect(RC).toContain('query: `SELECT COUNT() FROM ${g.refObj}`');
  });
  it('the verdict is in the page header, and a parents-first step leads back to where it came from', () => {
    expect(DV).toContain('id="dsDepParentsChip"');
    expect(DV).toContain('id="dsDepBackOrigin"');
    expect(DV).toContain("if (orig) window.openReconcile(orig.id);");
  });
});

// 2026-09-21 — user: "we should offer the field creation and do it ourselves for
// the selected trees … the user should be presented with the trees also in visual way".
describe('identity for a whole tree, and the tree itself', () => {
  const ID = readFileSync(new URL('../sftk-identity.js', import.meta.url), 'utf8');
  const creatable = extractFunction('sftk-identity.js', 'sftkIdCreatable');
  const nodes = extractFunction('studio-deploy.js', 'sftkDeployTreeNodes');
  const deployFn = RC.slice(RC.indexOf('async function sftkIdDeployTo(orgUrls, objects) {'), RC.indexOf('async function sftkOpenIdentityModal('));
  const modalFn = RC.slice(RC.indexOf('async function sftkOpenIdentityModal('));
  it('only objects where the field is missing AND custom fields are allowed', () => {
    const objs = [{ obj: 'Account', tgt: 'yes', src: 'no', customizable: true }, { obj: 'Contact', tgt: 'no', src: 'no', customizable: true },
      { obj: 'Note', tgt: 'no', src: 'no', customizable: false }, { obj: 'Case', tgt: 'unknown', src: 'no', customizable: null }, { obj: 'Contact', tgt: 'no', src: 'no', customizable: true }];
    expect(creatable(objs, 'tgt')).toEqual(['Contact']);                 // unknown is never created blind; Note cannot take one; no duplicates
    expect(creatable(objs, 'src')).toEqual(['Account', 'Contact', 'Case']);
    expect(creatable(null, 'tgt')).toEqual([]);
  });
  it('the deploy is gated like the Seeder: typed for production or unknown BEFORE anything is built', () => {
    expect(deployFn.indexOf("if (t !== 'sandbox' && t !== 'dev') {")).toBeGreaterThan(0);
    expect(deployFn.indexOf("if (t !== 'sandbox' && t !== 'dev') {")).toBeLessThan(deployFn.indexOf('window.sftkBuildStoredZip('));
    expect(deployFn).toContain('cancelled — nothing was deployed to any org');
    expect(deployFn).toContain("type: 'SF_METADATA_DEPLOY'");
    expect(deployFn).toContain('_describeCache = {};');
  });
  it('granting access for one tree never narrows what the permission set already covers', () => {
    expect(deployFn).toContain('SELECT Field FROM FieldPermissions WHERE Parent.Name =');
    expect(deployFn).toContain('sftkIdPermSetXml([...new Set([...covered, ...objs])])');
  });
  it('the target is ticked by default, the source is opt-in, and stamping warns when names are duplicated', () => {
    expect(modalFn).toContain("id=\"dsIdT\" ${canT.length ? 'checked' : 'disabled'}");
    expect(modalFn).toContain("id=\"dsIdS\" ${canS.length ? '' : 'disabled'}");
    expect(modalFn).toContain('stamping cements whichever pairing');
    expect(modalFn).toContain('reconcileStampPairs({ ...p, tree: { ...node, objectType: o.obj } }, scanOf(o));');
  });
  it('a stamp that finds no field opens the dialog that can create it', () => {
    expect(RC).toContain("if (!eid('dsIdBody')) sftkOpenIdentityModal(p, scan);");
    expect(RC).toContain('use 🪪 Identity on this page');
  });
  it('the tree is the nested shape of the deployment', () => {
    const t = nodes({ objectType: 'Account', children: [{ childSObject: 'Contact', field: 'AccountId', children: [{ childSObject: 'Case', field: 'ContactId' }] }] });
    expect(t.obj).toBe('Account');
    expect(t.children[0]).toMatchObject({ obj: 'Contact', pathKey: '0', depth: 1, field: 'AccountId' });
    expect(t.children[0].children[0]).toMatchObject({ obj: 'Case', pathKey: '0.0', depth: 2 });
    expect(nodes(null)).toBe(null);
  });
  it('the tree stays a presentation: the data comes from the shared functions', () => {
    expect(DV).toContain('data = await sftkIdStatusFor(p);');
    expect(DV).toContain("eid('dsDepIdBtn')?.addEventListener('click', () => sftkOpenIdentityModal(p, scan));");
    expect(ID).toContain('function sftkIdCreatable(objects, side) {');
  });
});
