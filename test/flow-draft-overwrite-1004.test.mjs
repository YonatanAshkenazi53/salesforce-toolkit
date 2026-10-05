// Live 2026-10-04 (trailheads5, fixture flow: v3 Active + v4 Draft): the fix
// deployed the corrected version and Salesforce saved it OVER the draft v4
// (the draft record replaced by a new one with the same number) and activated
// it — no v5 appeared. The tool then said
// "The deploy was accepted but no new version appeared … Nothing was deleted"
// and stopped, with the org already changed. Proven by CLI the same day: with
// the newest version a Draft a deploy overwrites it; with the newest version
// Obsolete it creates the next number. The plan now knows, says so, backs the
// draft up, and never deletes the version that runs the flow.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const F = extractFunctions('sftk-flowsurgery.js', ['sftkFlowSurgeryPlan', 'sftkFlowSurgeryLines', 'sftkFlowInterviewWords']);
const V = (id, num, status) => ({ Id: id, VersionNumber: num, Status: status });

describe('the plan — a draft newer than the active version', () => {
  it('is what the deploy is saved over: expected number = the draft, and it is NOT deleted afterwards', () => {
    const p = F.sftkFlowSurgeryPlan([V('d', 4, 'Draft'), V('a', 3, 'Active'), V('b', 2, 'Obsolete')], ['d', 'a', 'b']);
    expect(p.mode).toBe('active');
    expect(p.overwrite).toMatchObject({ id: 'd', num: 4, refs: true });
    expect(p.expectNew).toBe(4);
    expect(p.toDelete.map(v => v.id)).toEqual(['b', 'a']);
    expect(p.inactiveRefs.map(v => v.id)).toEqual(['b']);
    expect(p.steps[0]).toMatchObject({ kind: 'redeploy', expectNew: 4, overwrites: 4 });
  });
  it('a CLEAN draft is overwritten too — it is named, not counted as "left alone"', () => {
    const p = F.sftkFlowSurgeryPlan([V('d', 4, 'Draft'), V('a', 3, 'Active')], ['a']);
    expect(p.overwrite).toMatchObject({ id: 'd', refs: false });
    expect(p.cleanInactive).toBe(0);
  });
  it('the newest version Obsolete (or Active) → a new number, nothing overwritten', () => {
    expect(F.sftkFlowSurgeryPlan([V('o', 4, 'Obsolete'), V('a', 3, 'Active')], ['a'])).toMatchObject({ overwrite: null, expectNew: 5 });
    expect(F.sftkFlowSurgeryPlan([V('a', 3, 'Active'), V('b', 2, 'Draft')], ['a', 'b'])).toMatchObject({ overwrite: null, expectNew: 4 });
  });
  it('switching the flow off deploys nothing, so the draft is simply one of the versions to delete', () => {
    const p = F.sftkFlowSurgeryPlan([V('d', 4, 'Draft'), V('a', 3, 'Active')], ['d', 'a'], { activeMode: 'delete' });
    expect(p.overwrite).toBeNull();
    expect(p.toDelete.map(v => v.id)).toEqual(['d', 'a']);
  });
  it('the dialog says the draft is REPLACED and to back it up', () => {
    const p = F.sftkFlowSurgeryPlan([V('d', 4, 'Draft'), V('a', 3, 'Active')], ['d', 'a']);
    const lines = F.sftkFlowSurgeryLines(p, 0, null).join(' ');
    expect(lines).toContain('v4 is a DRAFT newer than the active v3');
    expect(lines).toContain('REPLACED');
    expect(lines).toContain('Deploy the active v3 over the draft v4 without the field reference');
    expect(F.sftkFlowSurgeryLines(p, 0, null, { swapTo: 'New__c' }).join(' ')).toContain('pointing at New__c instead, and make sure v4 is ACTIVE');
  });
});

describe('field-cleaner.js — recognising and surviving the overwrite', () => {
  it('no higher number → the record that was not there before the deploy is the one that was written', () => {
    // live: the overwritten draft comes back with the SAME number and a NEW Id
    expect(FC).toContain('const had = new Set((Array.isArray(before) ? before : []).map(v => v.Id));');
    expect(FC).toContain('const fresh = had.size ? versions.filter(v => !had.has(v.Id)) : [];');
    expect(FC).toContain("const written = fresh.find(v => v.Status === 'Active') || fresh[0] || null;");
    expect(FC).toContain('newest = written; overwrote = true;');
    expect(FC).toContain('await _verifyFlowActivation(defId, maxNum, flowName, plan.active.id, journal, fp.versions);');
  });
  it('the overwritten draft is backed up and gets a restore point with the versions that go', () => {
    expect(FC).toContain('const gone = plan.overwrite ? [...plan.toDelete, plan.overwrite] : plan.toDelete;');
    expect(FC).toContain('const entries = gone.map(v => ({');
    expect(FC).toContain('for (const v of gone) {');
  });
  it('the version that now runs the flow is never among the deletions', () => {
    expect(FC).toContain('plan.toDelete.map(v => v.id).filter(id => id !== out.newId)');
  });
  it('the confirmation names the draft, and the result says it was saved over', () => {
    expect(FC).toContain("its content is REPLACED ${asks ? 'when the flow keeps running' : 'by the new version'} (Salesforce saves the new version over the newest draft)");
    expect(FC).toContain('saved over the draft v${r.newVersion}, as Salesforce does when the newest version is a draft');
  });
  it('the selective removal passes its before-list too', () => {
    expect(FC).toContain('await _verifyFlowActivation(before.defId, before.maxNum, flowName, flowId, journal, before.versions);');
  });
});
