// FLOW SURGERY (user 2026-09-13): "if a field is referenced in a flow in an
// inactive version, we need to suggest to remove the inactive version and ask
// the user if he wants to back it up first … if the field is used under an
// active flow version, we should offer to remove the current version, and
// create a new active version without the field ref and make sure its active
// … also delete flow interview dependencies."
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const FC = read('field-cleaner.js');
const F = extractFunctions('sftk-flowsurgery.js', ['sftkFlowSurgeryPlan', 'sftkFlowSurgeryLines', 'sftkFlowInterviewKinds', 'sftkFlowInterviewWords', 'sftkFlowRefScan', 'sftkFlowRefWhere', 'sftkFlowRefPreview']);

const V = (id, num, status) => ({ Id: id, VersionNumber: num, Status: status });
const slice = (src, header, indent = '  ') => {
  const i = src.indexOf(header); if (i === -1) throw new Error(`not found: ${header}`);
  const end = src.indexOf(`\n${indent}}`, i); return src.slice(i, end + indent.length + 2);
};

// ════════════════════════════════════════════════════════════════════════
describe('the plan — what happens to each version', () => {
  it('only inactive versions reference the field → delete exactly those, no new version', () => {
    const p = F.sftkFlowSurgeryPlan([V('a', 3, 'Active'), V('b', 2, 'Obsolete'), V('c', 1, 'Obsolete')], ['b']);
    expect(p.mode).toBe('inactive-only');
    expect(p.toDelete.map(v => v.num)).toEqual([2]);
    expect(p.cleanInactive).toBe(1);
    expect(p.expectNew).toBeNull();
    expect(p.steps.map(s => s.kind)).toEqual(['delete-versions']);
  });

  it('the active version references the field → redeploy, verify active, then delete the replaced one', () => {
    const p = F.sftkFlowSurgeryPlan([V('a', 3, 'Active'), V('b', 2, 'Obsolete')], ['a']);
    expect(p.mode).toBe('active');
    expect(p.expectNew).toBe(4);
    expect(p.steps.map(s => s.kind)).toEqual(['redeploy', 'verify-active', 'delete-versions']);
    expect(p.toDelete.map(v => v.id)).toEqual(['a']);
    expect(p.toDelete[0].why).toBe('replaced by the new version');
  });

  it('active AND inactive references → one new version, every referencing version deleted', () => {
    const p = F.sftkFlowSurgeryPlan([V('a', 5, 'Active'), V('b', 4, 'Obsolete'), V('c', 3, 'Draft'), V('d', 2, 'Obsolete')], ['a', 'b', 'c']);
    expect(p.mode).toBe('active');
    expect(p.toDelete.map(v => v.num).sort()).toEqual([3, 4, 5]);
    expect(p.cleanInactive).toBe(1);
  });

  it('a flow with no active version and a referencing draft → delete the draft only', () => {
    const p = F.sftkFlowSurgeryPlan([V('c', 2, 'Draft'), V('d', 1, 'Obsolete')], ['c']);
    expect(p.mode).toBe('inactive-only');
    expect(p.active).toBeNull();
    expect(p.toDelete.map(v => v.id)).toEqual(['c']);
  });

  it('nothing references the field → nothing to do', () => {
    const p = F.sftkFlowSurgeryPlan([V('a', 1, 'Active')], []);
    expect(p.mode).toBe('none');
    expect(p.toDelete).toEqual([]);
    expect(p.steps).toEqual([]);
  });

  it('survives junk input', () => {
    expect(F.sftkFlowSurgeryPlan(null, null).mode).toBe('none');
    expect(F.sftkFlowSurgeryPlan([{}], ['x']).toDelete).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('the sentences the dialog shows', () => {
  it('states the active path in order: new version verified active, THEN deletions', () => {
    const p = F.sftkFlowSurgeryPlan([V('a', 3, 'Active'), V('b', 2, 'Obsolete')], ['a', 'b']);
    const L = F.sftkFlowSurgeryLines(p, 0, null);
    expect(L[0]).toMatch(/Deploy a new version \(expected v4\).*make sure it is ACTIVE\. Nothing is deleted until the org confirms/);
    expect(L[1]).toMatch(/Then delete the replaced v3 and 1 inactive version\(s\).*v2 \(Obsolete\)/);
  });

  it('states the inactive-only path and that the active version is untouched', () => {
    const p = F.sftkFlowSurgeryPlan([V('a', 3, 'Active'), V('b', 2, 'Obsolete')], ['b']);
    const L = F.sftkFlowSurgeryLines(p, 0, null);
    expect(L[0]).toMatch(/Delete 1 inactive version\(s\).*No new version is needed — the active v3 does not use the field/);
  });

  it('names paused interviews as deleted FIRST, and a failed check as a failed check', () => {
    const p = F.sftkFlowSurgeryPlan([V('b', 2, 'Obsolete')], ['b']);
    expect(F.sftkFlowSurgeryLines(p, 3, null).join(' ')).toMatch(/3 flow interview\(s\) \(3 paused\).*deleted FIRST/);   // a bare count still means paused — the cautious wording
    expect(F.sftkFlowSurgeryLines(p, 0, 'no access').join(' ')).toMatch(/could NOT be checked \(no access\)/);
    expect(F.sftkFlowSurgeryLines(p, 0, null).join(' ')).not.toMatch(/interview/);
  });

  it('always offers the backup and says deletion is not restorable by Salesforce', () => {
    const p = F.sftkFlowSurgeryPlan([V('b', 2, 'Obsolete')], ['b']);
    expect(F.sftkFlowSurgeryLines(p, 0, null).at(-1)).toMatch(/cannot be restored by Salesforce.*backup/);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('field-cleaner.js executes the plan in the safe order', () => {
  const plan = slice(FC, 'async function fixFlowPlan(flowId, flowName)');
  const exec = slice(FC, 'async function fixFlowExecute(fp, opts)');
  const one  = slice(FC, 'async function fixOne(type, componentId, componentName, fieldId)');

  it('reads EVERY version before planning, and refuses a partial picture', () => {
    expect(plan).toContain('for (const v of versions)');
    expect(plan).toContain('refusing to plan deletions from a partial picture of the flow');
    expect(slice(FC, 'async function _flowVersionsOf(anyVersionId)')).toContain("came back INCOMPLETE");
  });

  it('the confirm shows the plan, offers the backup ticked by default, and names the interviews', () => {
    expect(one.indexOf('fixFlowPlan(')).toBeLessThan(one.indexOf('sftkConfirmDestructive({'));
    expect(one).toContain('id="fcFlowBackup" checked');
    expect(one).toContain('that will be deleted first');   // 2026-09-21: named by kind (paused / failed), not always "paused"
    expect(one).toContain('sftkFlowInterviewWords(sftkFlowInterviewKinds(flowPlan.interviews)).head');
    expect(one).toMatch(/needsCheckbox: type === 'Flow'/);
  });

  it('backup → new version → VERIFY active → interviews → versions, in that order', () => {
    const at = s => { const i = exec.indexOf(s); expect(i).toBeGreaterThan(-1); return i; };
    const backup = at('downloadFlowBackupZip(entries');
    const deploy = at('deployFlowViaMetadataApi(apiNameOf(plan.active.id), metadata)');
    // Phase 3 (History with undo): these three now also carry the caller's
    // journal, so a write's verdict lands in the button-press's History entry.
    const verify = at('await _verifyFlowActivation(defId, maxNum, flowName, plan.active.id, journal)');
    const ivs    = at('await _deleteFlowInterviews(fp.interviews, journal)');
    const vers   = at('await _deleteFlowVersionIds(plan.toDelete.map(v => v.id), skip, journal)');
    expect(backup).toBeLessThan(deploy);
    expect(deploy).toBeLessThan(verify);
    expect(verify).toBeLessThan(ivs);
    expect(ivs).toBeLessThan(vers);
  });

  it('a backup the user asked for that cannot be produced stops everything', () => {
    expect(exec).toContain('The backup download is not available on this page — nothing was changed');
  });

  it('every failure before the deletions says "Nothing was deleted"', () => {
    const nothing = (exec.match(/Nothing was deleted/g) || []).length;
    expect(nothing).toBeGreaterThanOrEqual(2);
    // Phase 3 (History with undo): _verifyFlowActivation now also takes the
    // caller's journal, so its write's verdict lands in the right entry.
    const verify = slice(FC, 'async function _verifyFlowActivation(defId, prevMax, flowName, flowIdForLink, journal)');
    expect((verify.match(/Nothing was deleted|nothing was deleted/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('activation is re-read, activated by the tool if needed, and re-read again', () => {
    const verify = slice(FC, 'async function _verifyFlowActivation(defId, prevMax, flowName, flowIdForLink, journal)');
    expect(verify).toMatch(/\(Number\(newest\.VersionNumber\) \|\| 0\) <= prevMax/);
    expect(verify).toContain("body: { Metadata: { activeVersionNumber: Number(newest.VersionNumber) } }");
    expect(verify).toMatch(/versions = await read\(\);\s*newest = versions\.find\(v => v\.Id === newId\)/);
    expect(verify).toContain("newest.Status !== 'Active'");
  });

  it('interviews are found by FlowVersionViewId and deleted through the REST delete', () => {
    expect(FC).toContain('FROM FlowInterview WHERE FlowVersionViewId IN (${lit})');
    expect(FC).toContain("type: 'SF_REST_DELETE', orgUrl: _orgUrl, sid: _sid, sobject: 'FlowInterview'");
    // a version whose interviews could not be deleted is skipped, not attempted
    expect(FC).toContain('for (const id of di.failedVersionIds) skip.add(id);');
  });

  it('the new version is re-read for a leftover mention (formula / decision text)', () => {
    expect(exec).toContain('out.stillMentions = !!(check?.Metadata && flowReferencesField(check.Metadata));');
    expect(one).toContain('the new version still mentions the field');
  });

  it('every row of the same flow is settled together, and rows say which version they are', () => {
    expect(FC).toContain('function _markFlowSiblings(exceptId, defId, label, links)');
    expect(one).toContain('_markFlowSiblings(componentId, r.defId, label, doneLinks);');
    expect(FC).toContain('if (_groups.Flow) await _loadFlowVersionInfo(_groups.Flow);');
    expect(FC).toContain('class="fc-ver-badge"');
  });

  it('the XML-inspector path verifies activation too, and its purge clears interviews first', () => {
    const sel = slice(FC, 'async function fixFlowSelective(flowId, flowName, selSet)');
    expect(sel.indexOf('const before = await _flowVersionsOf(flowId);')).toBeLessThan(sel.indexOf('deployFlowViaMetadataApi('));
    // Phase 3 (History with undo): both now carry fixFlowSelective's own journal.
    expect(sel.indexOf('_verifyFlowActivation(before.defId, before.maxNum, flowName, flowId, journal)')).toBeLessThan(sel.indexOf('purgeOldFlowVersions(flowId, flowName, journal)'));
    const purge = slice(FC, 'async function purgeOldFlowVersions(anyVersionId, flowName, journal)');
    expect(purge.indexOf('_flowInterviewsFor(stale.map(v => v.Id))')).toBeLessThan(purge.indexOf('_deleteFlowVersionIds(stale.map(v => v.Id), skip, journal)'));
    expect(purge).toContain("confirmLabel: '🗑 Delete interviews, then the versions'");
  });

  it('popup.html loads the plan library before Field Cleaner', () => {
    const html = read('popup.html');
    expect(html.indexOf('<script src="sftk-flowsurgery.js">')).toBeGreaterThan(-1);
    expect(html.indexOf('<script src="sftk-flowsurgery.js">')).toBeLessThan(html.indexOf('<script src="field-cleaner.js">'));
  });
});

// 2026-09-21 — the user's fixture is made of FAILED interviews (InterviewStatus
// = Error). They block a version delete like paused ones, but they are not "a
// user mid-flow".
describe('flow interviews are named by kind', () => {
  it('counts paused, failed and other from InterviewStatus; an unread status is treated as paused', () => {
    expect(F.sftkFlowInterviewKinds([{ InterviewStatus: 'Error' }, { InterviewStatus: 'Error' }, { InterviewStatus: 'Paused' }, { InterviewStatus: 'Started' }, {}]))
      .toEqual({ total: 5, paused: 2, failed: 2, other: 1 });
    expect(F.sftkFlowInterviewKinds(null)).toEqual({ total: 0, paused: 0, failed: 0, other: 0 });
  });
  it('the confirm line says how many of each and what deleting each kind costs', () => {
    const p = F.sftkFlowSurgeryPlan([{ Id: 'a', VersionNumber: 2, Status: 'Active' }, { Id: 'b', VersionNumber: 1, Status: 'Obsolete' }], ['b']);
    const line = F.sftkFlowSurgeryLines(p, { total: 5, paused: 1, failed: 4, other: 0 }, null).join(' ');
    expect(line).toContain('5 flow interview(s) (1 paused, 4 failed)');
    expect(line).toContain('a paused one is a user mid-flow whose progress is lost');
    expect(line).toContain('a failed one is only a saved error report');
    const onlyFailed = F.sftkFlowSurgeryLines(p, { total: 4, paused: 0, failed: 4, other: 0 }, null).join(' ');
    expect(onlyFailed).not.toContain('mid-flow');
    expect(F.sftkFlowSurgeryLines(p, { total: 0, paused: 0, failed: 0, other: 0 }, null).join(' ')).not.toMatch(/interview/);
  });
});

// 2026-09-21 — user: "visualize what he is about to delete" / "give the user
// ability to reconnect it himself in the flow builder" / "a way to select if
// the active version is also deleted or only the field ref is deleted from it".
describe('the active version can be replaced OR deleted — the plan knows both', () => {
  const vs = [{ Id: 'a4', VersionNumber: 4, Status: 'Draft' }, { Id: 'a3', VersionNumber: 3, Status: 'Active' }, { Id: 'a1', VersionNumber: 1, Status: 'Obsolete' }];
  it('replace is the default and is unchanged', () => {
    const p = F.sftkFlowSurgeryPlan(vs, ['a3', 'a1']);
    expect(p.mode).toBe('active');
    expect(p.expectNew).toBe(5);
    expect(p.steps.map(s => s.kind)).toEqual(['redeploy', 'verify-active', 'delete-versions']);
  });
  it('delete switches the flow off, verifies, then deletes the SAME versions', () => {
    const r = F.sftkFlowSurgeryPlan(vs, ['a3', 'a1']);
    const d = F.sftkFlowSurgeryPlan(vs, ['a3', 'a1'], { activeMode: 'delete' });
    expect(d.mode).toBe('active-delete');
    expect(d.expectNew).toBe(null);
    expect(d.steps.map(s => s.kind)).toEqual(['deactivate', 'verify-inactive', 'delete-versions']);
    expect(d.toDelete.map(v => v.id).sort()).toEqual(r.toDelete.map(v => v.id).sort());
    const lines = F.sftkFlowSurgeryLines(d, 0, null).join(' ');
    expect(lines).toContain('Switch the flow OFF');
    expect(lines).toContain('THE FLOW STOPS RUNNING');
    expect(lines).toContain('Nothing is deleted before that is confirmed');
  });
  it('asking to delete an active version that does NOT reference the field changes nothing', () => {
    const d = F.sftkFlowSurgeryPlan(vs, ['a1'], { activeMode: 'delete' });
    expect(d.mode).toBe('inactive-only');
    expect(d.toDelete.map(v => v.id)).toEqual(['a1']);
  });
});

describe('the preview of an automatic fix', () => {
  const isRef = v => /(^|[^a-z0-9_])status__c([^a-z0-9_]|$)/i.test(v);
  const before = {
    description: 'mentions Status__c in plain words',
    decisions: [{ name: 'Check_Status', label: 'Check Status', rules: [{ name: 'Is_New', label: 'Is New', conditions: [{ leftValueReference: 'acct.Status__c', operator: 'EqualTo' }] }] }],
    assignments: [{ name: 'Remember', label: 'Remember Status', assignmentItems: [{ assignToReference: 'remembered', operator: 'Assign', value: { elementReference: 'acct.Status__c' } }] }],
    recordCreates: [{ name: 'Create_A', label: 'Create A', inputAssignments: [{ field: 'Status__c', value: { stringValue: 'New' } }, { field: 'Name', value: { stringValue: 'x' } }] }],
    formulas: [{ name: 'StatusText', expression: 'TEXT({!acct.Status__c})' }],
  };
  const after = JSON.parse(JSON.stringify(before));
  after.assignments[0].assignmentItems = [];
  after.recordCreates[0].inputAssignments = [{ field: 'Name', value: { stringValue: 'x' } }];
  const pv = F.sftkFlowRefPreview(before, after, isRef);

  it('lists exactly what came out, in Flow Builder words', () => {
    expect(pv.removed.map(r => `${r.kind}|${r.name}|${r.where}|${r.what}`)).toEqual([
      'Assignment|Remember|assignment line 1|remembered Assign acct.Status__c',
      'Create Records|Create_A|field value 1|Status__c = New']);
  });
  it('lists what STILL mentions the field — the Decision and the formula the remover leaves alone', () => {
    expect(pv.remaining.map(r => `${r.kind}|${r.name}|${r.where}`)).toEqual([
      'Decision|Check_Status|outcome “Is New” → condition 1',
      'Formula|StatusText|its formula text']);
  });
  it('a field name typed into a description or label is NOT a reference', () => {
    expect(F.sftkFlowRefScan({ description: 'uses Status__c', label: 'Status__c flow', interviewLabel: 'Status__c' }, isRef)).toEqual([]);
    expect(F.sftkFlowRefScan({ textTemplates: [{ name: 't', text: 'Hi {!acct.Status__c}' }] }, isRef)).toHaveLength(1);   // a merge field in a template IS one
  });
  it('flags an element the fix leaves with nothing to do', () => {
    expect(pv.emptied.map(e => `${e.kind}|${e.name}|${e.part}`)).toEqual(['Assignment|Remember|assignmentItems']);
  });
  it('an untouched flow previews as nothing removed, and everything still there', () => {
    const same = F.sftkFlowRefPreview(before, before, isRef);
    expect(same.removed).toEqual([]);
    expect(same.remaining).toHaveLength(4);
  });
});

describe('field-cleaner.js: the preview comes from the REAL remover, and the choice gates the button', () => {
  const FC2 = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
  it('the preview is built by running removeFieldRefs on a clone', () => {
    const fn = FC2.slice(FC2.indexOf('async function fixFlowPlan(flowId, flowName)'), FC2.indexOf('async function fixFlowExecute('));
    expect(fn).toContain('const after = JSON.parse(JSON.stringify(before));');
    expect(fn).toContain('removeFieldRefs(after, _selObj.api, _selField.api);');
    expect(fn).toContain('preview = sftkFlowRefPreview(before, after, _fieldStringTester());');
    expect(fn).toContain("planDelete = sftkFlowSurgeryPlan(versions, referencing, { activeMode: 'delete' });");
  });
  it('the detector and the preview share one string test, and both skip labels/descriptions', () => {
    expect(FC2).toContain('return sftkFlowRefScan(metadata, test).length > 0;');
  });
  it('replace is offered only when something can come out; otherwise nothing is pre-chosen', () => {
    expect(FC2).toContain("const canReplace = hasChoice && !!pv && pv.removed.length > 0;");
    expect(FC2).toContain("let activeMode = hasChoice ? (canReplace && !replaceLikelyRefused ? 'replace' : '') : 'replace';");
    expect(FC2).toContain('go.disabled = !(ack && ack.checked && activeMode);');
    expect(FC2).toContain("if (hasChoice && !activeMode) return;");
  });
  it('deleting the active version switches the flow off and VERIFIES it before any delete', () => {
    const ex = FC2.slice(FC2.indexOf('async function fixFlowExecute('));
    const off = ex.indexOf('body: { Metadata: { activeVersionNumber: 0 } }');
    expect(off).toBeGreaterThan(0);
    // Phase 3 (History with undo): now carries fixFlowExecute's journal too.
    expect(off).toBeLessThan(ex.indexOf('_deleteFlowInterviews(fp.interviews, journal)'));
    expect(ex).toContain('is still active. Nothing was deleted.');
    expect(ex.indexOf('const stillActive =')).toBeLessThan(ex.indexOf('_deleteFlowVersionIds(plan.toDelete'));
  });
  it('the manual route names the locations and links to Flow Builder', () => {
    expect(FC2).toContain('Toolbox → Manager');
    expect(FC2).toContain('↗ Open v${act.num} in Flow Builder');
    expect(FC2).toContain('these KEEP the field locked');
  });
});
