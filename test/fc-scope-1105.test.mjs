// Field Cleaner's scope (2026-11-05, a colleague's first day with the tool:
// "show the dependencies that are required for deleting the field, and also
// the other mentions that don't, and allow to scan both of the options").
// The rule worth testing: a blocker the index returned is never hidden from
// the DECISION (the delete gate), only from the list; a scope that read less
// says what it left out.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const F = extractFunctions('field-cleaner.js', ['fcScopeNorm', 'fcScopeKeeps', 'fcScopeLegs', 'fcEstimateScanCalls']);
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

describe('the scope', () => {
  it('three values, anything else is "both"', () => {
    expect(F.fcScopeNorm('blockers')).toBe('blockers');
    expect(F.fcScopeNorm('mentions')).toBe('mentions');
    for (const x of ['both', '', null, undefined, 'all', 42]) expect(F.fcScopeNorm(x)).toBe('both');
  });
  it('what each scope keeps in the list: by the type\'s severity', () => {
    expect(F.fcScopeKeeps('both', 'blocker')).toBe(true);
    expect(F.fcScopeKeeps('both', 'silent')).toBe(true);
    expect(F.fcScopeKeeps('blockers', 'blocker')).toBe(true);
    expect(F.fcScopeKeeps('blockers', 'silent')).toBe(false);
    expect(F.fcScopeKeeps('mentions', 'blocker')).toBe(false);
    expect(F.fcScopeKeeps('mentions', 'silent')).toBe(true);
    expect(F.fcScopeKeeps('mentions', undefined)).toBe(true);   // an unknown type is listed under mentions, counted by the gate as a blocker (TYPE_CFG_DEFAULT)
  });
  it('which legs run (live-tested 2026-11-06): a Lightning page BLOCKS, so its leg runs in every scope; the cheap scan skips every read that can only find a mention; the mentions scan skips every blocker read', () => {
    const B = { matchingRules: true, workflowFieldUpdates: true, workflow: true, approvals: true, sharingRules: true, duplicateRules: true, lwc: true, aura: true, customMetadata: true };
    const M = { reportTypes: true, listViews: true, compactLayouts: true, quickActions: true, paths: true, validationRulesOff: true, emailTemplates: true, searchLayouts: true, customSettings: true };   // +validationRulesOff 2026-11-07: an inactive rule is a mention the index never returns
    const off = o => Object.fromEntries(Object.keys(o).map(k => [k, false]));
    expect(F.fcScopeLegs('both')).toEqual({ flexiPages: true, ...B, leadMapping: false, objectRules: false, entitlements: false, ...M });
    expect(F.fcScopeLegs('blockers')).toEqual({ flexiPages: true, ...B, leadMapping: false, objectRules: false, entitlements: false, ...off(M) });
    expect(F.fcScopeLegs('mentions')).toEqual({ flexiPages: true, ...off(B), leadMapping: false, objectRules: false, entitlements: false, ...M });
    // 2026-11-11: entitlement processes are read for Case and WorkOrder only
    expect(F.fcScopeLegs('both', 'Case')).toMatchObject({ entitlements: true });
    expect(F.fcScopeLegs('mentions', 'Case')).toMatchObject({ entitlements: false });
    // the lead mapping is read for Lead and its targets; assignment/auto-response/escalation rules for Lead and Case
    expect(F.fcScopeLegs('both', 'Lead')).toMatchObject({ leadMapping: true, objectRules: true });
    expect(F.fcScopeLegs('both', 'Account')).toMatchObject({ leadMapping: true, objectRules: false });
    expect(F.fcScopeLegs('both', 'Case')).toMatchObject({ leadMapping: false, objectRules: true });
    expect(F.fcScopeLegs('both', 'My_Obj__c')).toMatchObject({ leadMapping: false, objectRules: false });
    expect(F.fcScopeLegs('mentions', 'Lead')).toMatchObject({ leadMapping: false, objectRules: false });
  });
  it('the cost follows the scope: 24 fixed calls for everything, 16 for the blockers (both with the check-only delete: 2), 11 for the mentions; the fan-outs stay a "more if" until known', () => {
    const FAN = ['Lightning page in the org', 'list view on this object', 'create/update quick action on this object', '10 custom report types in the org', 'workflow rule, alert or outbound message on this object', '10 approval processes on this object', '10 duplicate rules on this object', '10 custom metadata records in the org (read up to 300)'];
    const CSF = 'custom setting in the org (the first 30)';   // 2026-11-11: custom-setting records are read for the field's name (👀)
    expect(F.fcEstimateScanCalls(null)).toEqual({ now: 25, known: false, moreIf: [...FAN, CSF] });   // +1 on 2026-11-10: every email template's text is read; +1: the object's search layouts
    expect(F.fcEstimateScanCalls(null, 'blockers')).toEqual({ now: 16, known: false, moreIf: FAN.filter(w => !/list view|quick action|report types/.test(w)) });
    expect(F.fcEstimateScanCalls(null, 'mentions')).toEqual({ now: 12, known: false, moreIf: [...FAN.slice(0, 4), CSF] });
    expect(F.fcEstimateScanCalls({ flexiPages: 40, listViews: 6, quickActions: 3, reportTypes: 2, customSettings: 0 }, 'mentions')).toEqual({ now: 63, known: true, moreIf: [] });
    expect(F.fcEstimateScanCalls({ flexiPages: 40, listViews: 6, quickActions: 3, reportTypes: 2, workflowRules: 2, approvals: 1, duplicateRules: 1, customMetadata: 0 }, 'blockers')).toEqual({ now: 60, known: true, moreIf: [] });   // 13 + 40 pages + 2 + 1 + 1
    // the lead mapping and the Lead/Case rules are read only for those objects: +1 and +3 fixed calls
    expect(F.fcEstimateScanCalls(null, 'blockers', 'Account').now).toBe(17);
    expect(F.fcEstimateScanCalls(null, 'blockers', 'Lead').now).toBe(20);
  });
});

describe('wiring (2026-11-08: one scan, one list — "i dont think we need 3 tabs here. one tab is enough, but should be filtered by must and optional metadata references")', () => {
  it('the scope switch is gone; every scan reads everything', () => {
    expect(FC).not.toContain('id="fcScopeWrap"');
    expect(FC).not.toContain('sftk_fc_scope');
    expect(FC).toContain("const _scope = 'both';");
    expect(FC).toContain('const scope = _scope, L = fcScopeLegs(scope, _selObj.api);');
    expect(FC).toContain('_lastScan = { deps: [...deps, ...flexiHits, ...rtHits, ...supHits], fieldId, scope, unread: scanUnread };');
    for (const leg of ['listViews', 'compactLayouts', 'quickActions', 'matchingRules', 'workflowFieldUpdates', 'workflow', 'approvals', 'sharingRules', 'duplicateRules', 'lwc', 'customMetadata', 'leadMapping', 'objectRules', 'paths']) expect(FC).toContain(`if (L.${leg}) try {`);
  });
  it('one list, the blockers first, each group tagged 🔒 must fix / 👀 might break; a filter row: All · Must fix · Might break', () => {
    expect(FC).toContain('const deps = (allDeps || []).slice();');
    expect(FC).not.toContain('id="fcSectionBlockers"');
    expect(FC).not.toContain('id="fcSectionMentions"');
    expect(FC).toContain('<div class="fc-section fc-section-all" id="fcSectionAll">');
    expect(FC).toContain('<button type="button" class="fc-filter-btn" data-filter="all" role="radio">All <b>${nB + nM}</b></button>');
    expect(FC).toContain('data-filter="must"'); expect(FC).toContain('data-filter="later"');
    expect(FC).toContain("${blockerGroups.map(([t, a]) => groupHtml(t, a, 'must')).join('')}${mentionGroups.map(([t, a]) => groupHtml(t, a, 'later')).join('')}");
    expect(FC).toContain('<div class="fc-group" id="fcGroup_${esc(type)}" data-sev="${sev}">');
    expect(FC).toContain("g.hidden = _fcFilter !== 'all' && g.dataset.sev !== _fcFilter;");
    expect(FC).toContain("if (fb) { if (!fb.disabled) { _fcFilter = fb.dataset.filter || 'all'; _paintFilter(); } return; }");
    // a 🔒 chip jumps to a group the 👀 filter hides — the filter opens first
    expect(FC).toContain("if (_fcFilter === 'later') { _fcFilter = 'all'; _paintFilter(); }");
    expect(CSS).toContain('.fc-filter-must.active {'); expect(CSS).toContain('.fc-group-sev-later {');
  });
  it('the gate hides nothing: no "hidden by the scope", no "not read" notes; the 👀 sentence says those WERE read', () => {
    expect(FC).not.toContain('hidden by the 👀 scope');
    expect(FC).not.toContain('fc-scope-jump');
    expect(FC).not.toContain('<strong>The other mentions were not read</strong>');
    expect(FC).toContain('const delDisabled = autoCount > 0 || blockerTotal > 0 || unread.length > 0;');
    expect(FC).toContain('read too — list views, quick actions and the like. Salesforce lets the delete through with');
    expect(FC).toContain('⚠ Fix the <span title="the flows, layouts, Lightning pages and reports the tool rewrites itself');
  });
  it('the ⚡ row says why ⇄ counts more than ✂ (2026-11-08: "i can replace more than i can remove?")', () => {
    expect(FC).toContain('const onlySwap = nRp >= 2 && _replOn() && nRm >= 2 && nRp > nRm ? nRp - nRm : 0;');
    expect(FC).toContain('only ⇄ — code, formulas, buttons, field updates</span>');
    expect(FC).toContain('can only be replaced, not removed: Apex, Visualforce, LWC and Aura, formula fields, buttons and links, restriction rules, field updates and inactive validation rules.');
  });
  it('the org sweep: a long retrieve says how long it has run (2026-11-08: "stuck at 2 prcnt")', () => {
    expect(FC).toContain('in this retrieve — Salesforce says nothing until it lands; a big one takes minutes');
  });
});
