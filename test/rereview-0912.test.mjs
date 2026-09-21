// RE-REVIEW 2026-09-12 — the two audit areas whose reviewers were cut off
// (Studio core/scan/transfer; reconcile/rollback/history) were re-reviewed
// after the fourteen HANDOVER findings were fixed. Sixteen more real defects
// came back; each is pinned here. "A" = core/scan/transfer reviewer,
// "B" = reconcile/rollback/history reviewer.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const BG = read('background.js');
const SC = read('studio-scan.js');
const TR = read('studio-transfer.js');
const UN = read('studio-undo.js');
const SU = read('sftk-undo.js');
const RG = read('studio-ring.js');
const RC = read('studio-reconcile.js');
const SD = read('studio-seed.js');

const noComments = s => s.replace(/^[ \t]*\/\/.*$/gm, '');
const slice = (src, header, indent = '') => {
  const i = src.indexOf(header);
  if (i === -1) throw new Error(`not found: ${header}`);
  const end = src.indexOf(`\n${indent}}`, i);
  return src.slice(i, end + indent.length + 2);
};
const before = (src, a, b) => { expect(src.indexOf(a)).toBeGreaterThan(-1); expect(src.indexOf(b)).toBeGreaterThan(-1); expect(src.indexOf(a)).toBeLessThan(src.indexOf(b)); };

// ════════════════════════════════════════════════════════════════════════
describe('A1 · the per-field push honours the PII policy', () => {
  const fn = SC.slice(SC.indexOf('async function sftkPushFieldsToTarget'), SC.indexOf('function sftkWireDriftCompare'));

  it('derives this object’s rules from the deployment policy, like Reconcile does', () => {
    expect(fn).toMatch(/for \(const \[k, rule\] of Object\.entries\(profile\?\.piiPolicy \|\| \{\}\)\)/);
    expect(fn).toContain("piiRules[k.slice(dot + 1).toLowerCase()] = rule;");
  });

  it('a policy without a salt is a hard stop BEFORE any write', () => {
    before(fn, "PII policy has no salt", "type: 'SF_PATCH'");
  });

  it('masks a covered plain field with the shared masker and says so', () => {
    expect(fn).toMatch(/const m = await sftkPiiMaskValue\(v, byName\[p\.srcField\] \|\| \{\}, profile\.piiSalt, rule\)/);
    expect(fn).toContain('body[p.tgtField] = m.value;');
    expect(fn).toContain('(masked — ${m.action})');
  });

  it('refuses a lookup whose match field is PII — the raw key would reach the target org', () => {
    before(fn, 'if (piiCovered(parentObj, info.matchField))', "SELECT Id FROM ${parentObj} WHERE ${info.matchField}");
    expect(fn).toContain('is under this deployment\'s PII policy');
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('A2 · an INCOMPLETE scan read never degrades into a lookup-less scan', () => {
  const fn = SC.slice(SC.indexOf('const runScanPair = async (plan, suppress) =>'), SC.indexOf('srcCompare = comparePlan.map'));

  it('the refusal is flagged and returned on ITS side', () => {
    expect(fn).toContain('const err = { incomplete: true, error: `the ${side} read came back INCOMPLETE');
    expect(fn).toContain("return side === 'source' ? [err, b] : [a, err];");
  });

  it('the dot-path fallback is skipped for a flagged refusal', () => {
    expect(fn).toMatch(/&& canFallback && !srcRes\?\.incomplete && !tgtRes\?\.incomplete\) \{/);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('A3 · Run Transfer upserting on SFTK_ID__c stamps the identity', () => {
  it('buildTransferProfile names the stamp field when the upsert key is the identity field', () => {
    const fn = slice(TR, 'function buildTransferProfile()');
    expect(fn).toMatch(/String\(_transferUpsertField\)\.toLowerCase\(\) === sftkIdFieldName\(\)\.toLowerCase\(\)/);
    expect(fn).toContain('clone.tree.stampField = sftkIdFieldName();');
  });
  it('…which is what the engine keys the stamp on', () => {
    expect(BG).toMatch(/if \(node\.stampField && \(!tgtCreatable\.size \|\| tgtCreatable\.has\(node\.stampField\)\)\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('A4 · the Stamp identity hint fits the build it ships in', () => {
  it('points at the Seeder only when the Seeder is loaded, else at Setup', () => {
    const fn = slice(RC, 'function sftkIdHowToCreate()');
    expect(fn).toContain("typeof window.renderSeed === 'function'");
    expect(fn).toContain('Text(18) field marked External ID');
    expect(RC).toContain('${sftkIdHowToCreate()} first.');
    expect(RC).toContain('${esc(sftkIdHowToCreate())}');
    expect(RC).not.toContain("create it from the Org Seeder's Match key picker first");
  });
  it('the Seeder really is held back from the store build', () => {
    expect(read('scripts/pack_store.py')).toMatch(/HELD_BACK_JS = \{'studio-seed\.js'\}/);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('A5 / B4 · a fan-out counts as ONE run for the evidence cap', () => {
  const { sftkUndoPrune } = extractFunctions('sftk-undo.js', ['sftkUndoPrune']);

  it('legs sharing a groupId are kept or dropped together, ranked by the newest leg', () => {
    const store = {
      old1: { capturedAt: '2026-08-01T00:00:00Z' },
      old2: { capturedAt: '2026-08-02T00:00:00Z' },
      fo_a: { capturedAt: '2026-08-03T00:00:00Z', groupId: 'fo1' },
      fo_b: { capturedAt: '2026-08-03T00:00:01Z', groupId: 'fo1' },
      fo_c: { capturedAt: '2026-08-03T00:00:02Z', groupId: 'fo1' },
      solo: { capturedAt: '2026-08-04T00:00:00Z' },
    };
    const { kept, dropped } = sftkUndoPrune(store, 2);
    expect(Object.keys(kept).sort()).toEqual(['fo_a', 'fo_b', 'fo_c', 'solo']);
    expect(dropped.sort()).toEqual(['old1', 'old2']);
  });

  it('a 12-leg fan-out with cap 10 keeps every leg', () => {
    const store = {};
    for (let i = 0; i < 12; i++) store[`leg${i}`] = { capturedAt: `2026-08-03T00:00:${String(i).padStart(2, '0')}Z`, groupId: 'fo' };
    expect(sftkUndoPrune(store, 10).dropped).toEqual([]);
  });

  it('points without a groupId still behave as before', () => {
    const store = {};
    for (let i = 1; i <= 5; i++) store[`run${i}`] = { capturedAt: `2026-08-0${i}T00:00:00Z` };
    const { kept, dropped } = sftkUndoPrune(store, 3);
    expect(Object.keys(kept).sort()).toEqual(['run3', 'run4', 'run5']);
    expect(dropped.sort()).toEqual(['run1', 'run2']);
  });

});

// ════════════════════════════════════════════════════════════════════════
describe('A6 · the parent-scope refusal names the child skip, not a phantom parent write', () => {
  it('the shared refusal takes a consequence sentence', () => {
    const { sftkIncompleteErr } = extractFunctions('background.js', ['sftkIncompleteErr']);
    expect(sftkIncompleteErr('Account', 'parent scope', { expected: 5, got: 2 }, 'The child was SKIPPED.').message)
      .toContain('The child was SKIPPED.');
    expect(sftkIncompleteErr('Account', 'child records', { expected: 5, got: 2 }).message)
      .toContain('Nothing was written for this object');
  });
  it('both parent-scope reads pass it', () => {
    const fn = slice(BG, 'async function getScopeIds(entry)', '  ');
    expect((fn.match(/The child object that depends on this scope was SKIPPED/g) || []).length).toBe(2);
    expect(fn).not.toMatch(/'parent scope', r\.incomplete\);/);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('A7 · ✋ Cancel exists before the restore point is read', () => {
  const fn = TR.slice(TR.indexOf('async function runTransfer()'), TR.indexOf('function sftkFanoutTargetAdvice'));

  it('the button is created and armed BEFORE the capture, and the capture polls it', () => {
    before(fn, "cbtn.id = 'dsTrCancelBtn';", 'sftkUndoCaptureForRun(');
    before(fn, "addEventListener('click', () => { captureCancelled = true; })", 'sftkUndoCaptureForRun(');
    expect(fn).toContain('shouldCancel: () => captureCancelled,');
  });

  it('a cancel during the capture ends the run with nothing written and nothing recorded', () => {
    before(fn, 'if (captureCancelled) {', "type:             'SF_EXECUTE_PROFILE_TRANSFER'");
    expect(fn).toContain('nothing was written to the target and nothing was recorded');
  });

  it('the capture stops between objects and stores nothing when cancelled', () => {
    const cap = slice(UN, 'async function sftkUndoCaptureForRun(opts, log)');
    expect(cap).toMatch(/if \(opts && typeof opts\.shouldCancel === 'function' && opts\.shouldCancel\(\)\) \{\s*out\.skipped\[o\.objType\]/);
    before(cap, "'cancelled while the restore point was being read'", 'sftkUndoStorePut(');
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('B2 · deploying the identity field is gated like every other seeder write', () => {
  it('every listed org is typed for, production or unknown, BEFORE the zip is built', () => {
    const fn = slice(SD, 'async function sftkSeedIdDeploy(obj)');
    before(fn, "const t = await ensureOrgType(orgUrl);", "sftkIdPackageFiles([obj], '62.0')");
    expect(fn).toMatch(/if \(t !== 'sandbox' && t !== 'dev'\) \{\s*const okProd = await confirmTypedProd\(orgLabel\(orgUrl\)/);
    expect(fn).toContain('cancelled — nothing was deployed to any org');
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('B3 · a Custom Setting replace never empties the target on a bad read', () => {
  const fn = slice(SD, 'async function sftkSeedCfgSyncSetting(srcSess, tgtSess, obj, line)');
  const del = fn.indexOf("type: 'SF_COLLECTIONS_DELETE'");

  it('every refusal sits BEFORE the delete', () => {
    for (const s of ['source read INCOMPLETE', "the target's Organization Id could not be read",
      'could be re-owned in the target - nothing removed', "the target's rows could not be listed",
      "the target's row list came back INCOMPLETE"]) {
      expect(fn.indexOf(s)).toBeGreaterThan(-1);
      expect(fn.indexOf(s)).toBeLessThan(del);
    }
  });

  it('the CMDT read refuses a partial page too', () => {
    const mdt = slice(SD, 'async function sftkSeedCfgDeployMdt(srcSess, tgtSess, types, line)');
    expect(mdt).toContain('read INCOMPLETE');
    expect(mdt).toContain('not deployed from a partial read');
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('B5 · retention marks the cards whose restore point it removed', () => {
  it('one marking helper, used by both prune and retention', () => {
    expect(UN).toContain('async function _sftkUndoMarkExpired(ids)');
    const ret = slice(UN, 'async function sftkUndoStoreDeleteOlderThan(cutoffIso)');
    expect(ret).toContain('if (old.length) await _sftkUndoMarkExpired(old);');
    const prune = slice(UN, 'async function _sftkUndoPruneStore()');
    expect(prune).toContain('await _sftkUndoMarkExpired(dropped);');
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('B6 · 🪪 Stamp identity treats an org of unknown type as production', () => {
  it('only a confirmed sandbox or dev org gets the plain confirm', () => {
    const fn = slice(RC, 'async function reconcileStampPairs(p, scan)');
    expect(fn).toMatch(/const tgtType = await ensureOrgType\(p\.targetOrg\);\s*if \(tgtType !== 'sandbox' && tgtType !== 'dev'\)/);
    expect(noComments(fn)).not.toMatch(/=== 'production'\) \{/);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('B8 · the limits text matches what the time filter does', () => {
  it('says a run-created record is deleted even if edited since', () => {
    const { sftkUndoLimits } = extractFunctions('sftk-undo.js', ['sftkUndoLimits']);
    const t = sftkUndoLimits().join(' ');
    expect(t).toMatch(/A record the run itself created is deleted even if someone edited it afterwards/);
    expect(t).toMatch(/records the run changed that someone EDITED after it finished/);
    // …and the code really filters created rows on CreatedDate only
    const fn = slice(SU, 'function sftkUndoScopeByTime(diff, afterRows, runEndedAt)');
    expect(fn).toMatch(/byId\[id\]\.CreatedDate/);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('B9 · a failed prune cannot un-record a stored restore point', () => {
  it('put and prune sit in separate try blocks', () => {
    const cap = slice(UN, 'async function sftkUndoCaptureForRun(opts, log)');
    expect(cap).toMatch(/try \{\s*await sftkUndoStorePut\(\{[^]*?\}\);\s*\} catch \(e\) \{/);
    expect(cap).toMatch(/try \{ await _sftkUndoPruneStore\(\); \}\s*catch \(e\) \{ say\('ℹ️'/);
    expect(cap).toContain("this run's restore point is stored");
  });
});

// ════════════════════════════════════════════════════════════════════════
// C1 · reproduced on the npc org (2026-09-12): every subflow call into a
// managed package read as "Not found — no flow with this API name in this
// org", in the tree, the chain panel and the dead-subflow report, although
// the 🔒 section lists exactly those flows.
describe('C1 · a managed-package subflow target exists — it is not "Not found"', () => {
  const { depDeadSubflows } = extractFunctions('dependency-map.js', ['depDeadSubflows']);
  const DEP = read('dependency-map.js');

  it('the pure report puts it in its own bucket, never in missing or dead', () => {
    const map = { 'PgmApps__EvalApplicantPgmEligibility': [{ apiName: 'Create_Applications', masterLabel: 'Create Applications', status: 'Active' }] };
    const flows = { Create_Applications: [{ MasterLabel: 'Create Applications', Status: 'Active', VersionNumber: 1 }] };
    const managed = { 'PgmApps__EvalApplicantPgmEligibility': { apiName: 'PgmApps__EvalApplicantPgmEligibility', label: 'Evaluate Eligibility', active: { versionNumber: 3 } } };
    const r = depDeadSubflows(map, flows, managed);
    expect(r.missing).toEqual([]);
    expect(r.dead).toEqual([]);
    expect(r.managedTargets.map(x => x.apiName)).toEqual(['PgmApps__EvalApplicantPgmEligibility']);
    expect(r.managedTargets[0].active).toBe(true);
    expect(r.counts.managed).toBe(1);
    // without the managed map the old verdict still applies — the callers pass it
    expect(depDeadSubflows(map, flows).missing.map(x => x.apiName)).toEqual(['PgmApps__EvalApplicantPgmEligibility']);
    expect((DEP.match(/depDeadSubflows\(dependencyMap, flowsByApiName, depManagedMap\(\)\)/g) || []).length).toBe(3);   // +1 on 2026-09-18: treeStaleForManaged() asks the same question before a repaint
  });

  it('the tree paints a 🔒 node with the package namespace and active state', () => {
    expect(DEP).toContain("const mrow = versions.length ? null : depManagedRow(childApiName);");
    expect(DEP).toContain("missingNode.className = mrow ? 'dep-node dep-managed-node' : 'dep-node dep-missing';");
    expect(DEP).toContain('managed package flow — exists here; its contents and what it calls are hidden by Salesforce');
  });

  it('the chain panel says managed, not "Not found in this org"', () => {
    const fn = DEP.slice(DEP.indexOf('function annotateChain(node)'), DEP.indexOf('function chainFor('));
    expect(fn).toContain('node.exists = !!rep || !!mrow;');
    expect(fn).toMatch(/node\.selfActive = rep\s*\?[^]*?: !!\(mrow && mrow\.active\)/);
    expect(DEP).toContain('🔒 managed · ${node.selfActive ? \'Active\' : \'Inactive\'} · contents hidden');
  });

  it('the export names them as a section and a CSV row kind', () => {
    expect(DEP).toContain('### 1.4 Subflow references into managed packages');
    expect(DEP).toContain("add('Managed subflow target'");
  });
});

// ════════════════════════════════════════════════════════════════════════
// C2 · (user 2026-09-13, from a live screenshot) a flow edited in Flow Builder
// while the popup tab stayed open kept reading "calls no subflows"; and the
// rows did not say which version / API / dates they showed.
describe('C2 · ↻ Rescan and per-row version facts in the Dependencies tab', () => {
  const DEP = read('dependency-map.js');
  const PU  = read('popup.js');

  it('the tools row has a Rescan button wired to the popup entry point', () => {
    expect(DEP).toContain('id="depRescanBtn"');
    expect(DEP).toContain("toolsRow.querySelector('#depRescanBtn').addEventListener('click'");
    expect(DEP).toContain('window.sftkRescanDependencies()');
  });

  it('rescan drops the cache, re-reads the list, and scans even a large org (the click is the consent)', () => {
    const fn = PU.slice(PU.indexOf('window.sftkRescanDependencies = async function'), PU.indexOf('// P1 — the dependency scan costs'));
    expect(fn.indexOf('DependencyMap.clearCache()')).toBeLessThan(fn.indexOf('await loadFlows()'));
    expect(fn).toContain("if (metadataScanState === 'skipped')");
    expect(fn).toContain('await runDependencyScan(orgUrl, sid)');
  });

  it('every tree row carries version, API, status and dates', () => {
    const node = DEP.slice(DEP.indexOf('node.innerHTML = `\n        <span class="dep-node-toggle">'), DEP.indexOf("node.addEventListener('contextmenu'"));
    expect(node).toContain('v${escHtml(String(flow.VersionNumber))}');
    expect(node).toContain('API ${flow.ApiVersion}');
    expect(node).toContain('depDatesHtml(flow.CreatedDate, flow.LastModifiedDate)');
    // …and the popup's flow list actually fetches those fields
    expect(PU).toMatch(/const FLOW_FIELDS = '[^']*ApiVersion,CreatedDate'/);
    expect(PU).toMatch(/SELECT \$\{FLOW_FIELDS\},LastModifiedDate FROM Flow/);
  });

  it('managed rows show their last-modified date, read from FlowVersionView', () => {
    expect(DEP).toContain("VersionNumber, Status, ProcessType, LastModifiedDate,");
    expect(DEP).toContain('LastModifiedDate: v.LastModifiedDate || null,');
    expect(read('sftk-apiver.js')).toContain("lastModified: r.LastModifiedDate == null ? null : String(r.LastModifiedDate)");
    expect(DEP).toContain('modified ${escHtml(depShortDate(gov.lastModified))}');
  });

  it('the stored cache schema was bumped so every org is read fresh once', () => {
    // 4 (2026-09-14): a cache written by the blind general-endpoint reader has
    // no edges and no trigger types — it must be dropped, not reused.
    expect(DEP).toMatch(/const DEP_CACHE_SCHEMA\s*=\s*4;/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// C3 · (user 2026-09-14, from Setup's own Flow Definitions list) Salesforce
// stores record-triggered flows as "Autolaunched Flow"; only the Trigger
// column says "Record — Run After Save". The trigger is read for EVERY flow
// on load, so the label is right with or without a metadata scan.
describe('C3 · the trigger column decides the flow type, scan or no scan', () => {
  const { depResolveFlowType } = extractFunctions('dependency-map.js', ['depResolveFlowType']);
  const DEP = read('dependency-map.js');
  const PU  = read('popup.js');

  it('any Record… trigger is record-triggered; Scheduled and PlatformEvent map too', () => {
    for (const t of ['RecordAfterSave', 'RecordBeforeSave', 'RecordBeforeDelete', 'RecordAfterSaveSomethingNew']) {
      expect(depResolveFlowType('AutoLaunchedFlow', t)).toBe('RecordTriggeredFlow');
    }
    expect(depResolveFlowType('AutoLaunchedFlow', 'Scheduled')).toBe('ScheduledFlow');
    expect(depResolveFlowType('AutoLaunchedFlow', 'PlatformEvent')).toBe('PlatformEventFlow');
  });

  it('other process types keep their own name — a Prompt Flow stays a Prompt Flow', () => {
    expect(depResolveFlowType('PromptFlow', 'Capability')).toBe('PromptFlow');
    expect(depResolveFlowType('Flow', 'RecordAfterSave')).toBe('Flow');
    expect(depResolveFlowType('AutoLaunchedFlow', null)).toBe('AutoLaunchedFlow');
  });

  it('the definition read carries the trigger and every row is refined from it', () => {
    expect(DEP).toContain('SELECT DurableId, ApiName, Label, NamespacePrefix, ManageableState, TriggerType, TriggerObjectOrEventLabel FROM FlowDefinitionView');
    expect(DEP).toContain('ProcessType: depResolveFlowType(v.ProcessType, trigByDef[v.FlowDefinitionViewId])');
    expect(DEP).toContain('_defTriggerByApiName = trigByApi;');
    expect(DEP).toContain('getDefinitionTriggerMap,');
    // the popup refines its own list as soon as the definitions land, and repaints
    expect(PU).toMatch(/loadManagedFlows\(loadOrgUrl, loadSid\)\s*\.then\(\(\) => \{\s*patchFlowTypesFromDefinitions\(loadOrgUrl\);/);   // 2026-09-18: the chain also repaints a tree that painted before the managed list landed
    const fn = PU.slice(PU.indexOf('function patchFlowTypesFromDefinitions(loadOrgUrl)'), PU.indexOf('function patchFlowTypesFromMetadata()'));
    expect(fn).toContain('resolveFlowType(f.ProcessType, t)');
    expect(fn).toContain('renderDependenciesTab()');
    expect(PU).toMatch(/if \(\/\^Record\/i\.test\(String\(triggerType \|\| ''\)\)\) return 'RecordTriggeredFlow';/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// C4 · (user 2026-09-14) "does it show duplicate lightning pages?" — three
// pages shared the label "Account Record Page"; the row showed only the label.
describe('C4 · Lightning Pages tells same-label pages apart', () => {
  const LP = read('lightning-pages.js');
  it('counts label collisions per group and shows the API name when they collide, 🔒 for package pages', () => {
    expect(LP).toContain("for (const p of pages) labelCount[p.MasterLabel || ''] = (labelCount[p.MasterLabel || ''] || 0) + 1;");
    expect(LP).toContain("const collides = labelCount[p.MasterLabel || ''] > 1;");
    expect(LP).toContain("const managed = (p.ManageableState || '').toLowerCase() === 'installed';");
    expect(LP).toMatch(/\$\{managed \? '🔒 ' : ''\}\$\{esc\(p\.DeveloperName \|\| ''\)\}/);
    expect(LP).toContain('${devTag}');
  });
});
