// 2026-11-15 — CLOSE-OUT REVIEW, round 3: three findings, each reproduced by a second reader before it was fixed.
// Every case RUNS the real function (sliced out of the source the way the other regress-1115 files do).
//   A. Task / Event family: the report-type FIX, its verify and its undo follow the rule the report-type SCAN has;
//      the email-template 🔍 hint and the template scan follow the rule ✂ / ⇄ have
//   B. the ← pull leg writes into the SOURCE org with no duplicate-rule bypass
//   C. ▶ Continue re-ticks the inserts under existing parents of a run that was stopped mid-leg
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const FC = read('field-cleaner.js');
// an inner function of the FieldCleaner module (two-space indent, closes with "\n  }")
const nested = name => {
  const at = FC.indexOf(`\n  function ${name}(`) >= 0 ? FC.indexOf(`\n  function ${name}(`) : FC.indexOf(`\n  async function ${name}(`);
  if (at < 0) throw new Error(`not found in field-cleaner.js: ${name}`);
  return FC.slice(at + 1, FC.indexOf('\n  }\n', at + 1) + 4);
};
const MD = new Function(`${read('sftk-relmap.js')}\n${read('sftk-mdapi.js')}\nreturn { sftkRtMentions, sftkRtRemoveField, sftkRtReplaceField, sftkMdFamObj, sftkMdIsOwnObj };`)();
const TPL = new Function('sftkMdIsOwnObj', `${read('sftk-relmap.js')}\n${read('sftk-emailtpl.js')}\nreturn { sftkTplRemove, sftkTplReplace, sftkTplNamesField, sftkTplHits, sftkTplTextFields, sftkTplKind };`)(MD.sftkMdIsOwnObj);

// ── A ────────────────────────────────────────────────────────────────────────────────────────────────────────
const rtype = (table, extra = '') => `<fullName>Activities_X</fullName><baseObject>Activity</baseObject><sections><columns><field>Region__c</field><table>${table}</table></columns><columns><field>Subject</field><table>${table}</table></columns>${extra}<masterLabel>Activities</masterLabel></sections>`;

// fixReportType itself, with the org played by `state.xml`: the deploy stores the XML, the re-read returns it
const makeFix = (picked, before, { swap = false } = {}) => {
  const state = { xml: before, deployed: 0, undo: null, snaps: 0 };
  const fix = new Function('S', 'sftkRtMentions', 'sftkRtRemoveField', 'sftkRtReplaceField', 'sftkMdFamObj', `
    const _selObj = { api: '${picked}' }, _selField = { api: 'Region__c' }, _replField = { api: 'Area__c' };
    const _orgUrl = 'https://x.my.salesforce.com/', _sid = 's';
    const _lastScan = { deps: [{ MetadataComponentType: 'ReportType', MetadataComponentId: 'Activities_X', _fullName: 'Activities_X', _managed: '' }] };
    const _swapOn = () => ${swap};
    const readReportType = async () => S.xml;
    const _snapshotFix = async () => { S.snaps++; };
    const buildReportTypeZip = (fullName, xml) => xml;
    const sftkMdRecordFileXml = (type, inner) => inner;
    const sftkHistoryBegin = () => ({});
    const sftkHistoryEnd = async (j, end) => { S.undo = end.undo; };
    const bg = async m => { S.xml = m.zipBase64; S.deployed++; return { success: true }; };
    const sftkWriteVerified = async o => { const raw = await o.write(); if (raw.error) return { accepted: false, ok: false, raw }; const v = await o.verify(); return { accepted: true, ok: v.ok, raw }; };
    const _rxEsc = s => String(s).replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    const _feText = s => s;
    ${nested('fixReportType')}
    return fixReportType;`)(state, MD.sftkRtMentions, MD.sftkRtRemoveField, MD.sftkRtReplaceField, MD.sftkMdFamObj);
  return { fix, state };
};

describe('A. Task / Event custom field: the report-type row the scan lists can be fixed, and the fix is verified', () => {
  it.each([['Task', 'Activity'], ['Task', 'Event'], ['Event', 'Activity'], ['Event', 'Task'], ['Task', 'Task'], ['Activity', 'Activity']])(
    '%s.Region__c picked, a column on <table>%s</table>: the scan count, ✂ and the verify agree', async (picked, table) => {
      const before = rtype(table);
      // the scan's own call (scanReportTypes): the row is listed
      expect(MD.sftkRtMentions(before, MD.sftkMdFamObj(picked, 'Region__c'), 'Region__c')).toBe(1);
      const { fix, state } = makeFix(picked, before);
      const out = await fix('Activities_X', 'Activities');
      expect(out).toContain('1 column removed');
      expect(out).toContain('verified by re-reading the org');
      expect(state.snaps).toBe(1);
      expect(state.deployed).toBe(1);
      expect(state.xml).not.toContain('Region__c');
      expect(state.xml).toContain('<field>Subject</field>');
      // the undo's own check finds the column in the XML it puts back
      const v = state.undo.steps[0].verify;
      expect(new RegExp(v.pattern, v.flags).test(before)).toBe(true);
      expect(new RegExp(v.pattern, v.flags).test(state.xml)).toBe(false);
    });
  it('⇄ with Task picked renames the Activity-table column and the verify sees the new one', async () => {
    const { fix, state } = makeFix('Task', rtype('Activity'), { swap: true });
    const out = await fix('Activities_X', 'Activities');
    expect(out).toContain('1 column now names Area__c');
    expect(state.xml).toContain('<field>Area__c</field>');
    expect(state.xml).not.toContain('Region__c');
  });
  it('the verify is not vacuous: a deploy that leaves the Activity-table column there is reported, not passed', async () => {
    const before = rtype('Activity');
    const { fix, state } = makeFix('Task', before);
    // the org "accepts" the deploy and keeps the type as it was
    Object.defineProperty(state, 'xml', { get: () => before, set: () => {} });
    await expect(fix('Activities_X', 'Activities')).rejects.toThrow(/still lists the column on re-read/);
  });
  it('another object’s same-named column is still refused, with nothing written', async () => {
    const { fix, state } = makeFix('Task', rtype('Opportunity'));
    await expect(fix('Activities_X', 'Activities')).rejects.toThrow(/under another table \(Opportunity\.Region__c/);
    expect(state.deployed).toBe(0);
    expect(state.snaps).toBe(0);
  });
  it('a standard field is not the family’s: Task.Subject picked leaves an Event-table Subject alone', () => {
    const x = rtype('Event');
    expect(MD.sftkRtRemoveField(x, MD.sftkMdFamObj('Task', 'Subject'), 'Subject').changed).toBe(false);
  });
  it('a non-Activity pick is as before: the undo pattern names its own table only', async () => {
    const before = rtype('Account');
    const { fix, state } = makeFix('Account', before);
    await fix('Activities_X', 'Activities');
    const v = state.undo.steps[0].verify;
    expect(new RegExp(v.pattern, v.flags).test(before)).toBe(true);
    expect(new RegExp(v.pattern, v.flags).test(rtype('Contact'))).toBe(false);
  });
});

describe('A. Task / Event custom field: the template 🔍 hint and the template scan read it as ✂ / ⇄ do', () => {
  const rec = () => ({ Id: '00X000000000001', Name: 'T', DeveloperName: 'T', Subject: 'Hi', Body: 'Region: {!Event.Region__c}', HtmlValue: '', Markup: '', TemplateType: 'text', RelatedEntityType: '' });
  const inspect = async (picked, r) => {
    const panel = { innerHTML: '', style: {}, querySelector: () => null, scrollIntoView() {} };
    const run = new Function('T', 'sftkMdFamObj', 'panel', 'rec', `
      const { sftkTplRemove, sftkTplReplace, sftkTplHits, sftkTplTextFields, sftkTplKind } = T;
      const _selObj = { api: '${picked}' }, _selField = { api: 'Region__c' }, _replField = { api: 'Area__c' };
      const _replOn = () => true;
      const _tplRead = async () => rec;
      const esc = s => String(s);
      const _xiHighlightApex = s => ({ html: s });
      const _addXmlNavigation = () => {};
      const _tplEditorOpen = () => {};
      ${nested('_tplInspect')}
      return _tplInspect('00X000000000001', 'T', panel, null, '');`);
    await run(TPL, MD.sftkMdFamObj, panel, r);
    return panel.innerHTML;
  };
  it('Task picked, {!Event.Region__c}: the hint counts what ✂ takes out and what ⇄ renames', async () => {
    const r = rec();
    // what the fix (fixEmailTemplate, on the family object) does
    expect(TPL.sftkTplRemove(r, 'Region__c', MD.sftkMdFamObj('Task', 'Region__c')).n).toBe(1);
    const html = await inspect('Task', r);
    expect(html).toContain('here 1 in Body');
    expect(html).not.toContain('none here');
    expect(html).toContain('here 1 place would name');
  });
  it('another object’s merge field is still "none here"', async () => {
    const r = { ...rec(), Body: 'Region: {!Account.Region__c}' };
    expect(await inspect('Task', r)).toContain('none here');
  });
  // the template scan's own two lines, run as written
  const scanFilter = (picked, all) => {
    const a = FC.indexOf('      const tplFam = sftkMdFamObj(obj, _selField.api);');
    const b = FC.indexOf('\n', FC.indexOf('      const found = all.filter(', a));
    expect(a).toBeGreaterThan(0);
    return new Function('sftkMdFamObj', 'sftkTplNamesField', 'all', `
      const obj = '${picked}', _selField = { api: 'Region__c' }, indexedIds = new Set(), id15 = x => String(x || '').substring(0, 15);
      ${FC.slice(a, b)}
      return found.map(t => t.Name);`)(MD.sftkMdFamObj, TPL.sftkTplNamesField, all);
  };
  it('the scan lists the sibling’s template for a Task pick, keeps the bare-name Task template, and leaves Account’s out', () => {
    const all = [
      { ...rec(), Name: 'event-qualified' },
      { ...rec(), Name: 'activity-qualified', Body: '{!Activity.Region__c}' },
      { ...rec(), Name: 'bare-on-task', Body: 'Region__c', RelatedEntityType: 'Task' },
      { ...rec(), Name: 'account', Body: '{!Account.Region__c}' },
    ];
    expect(scanFilter('Task', all)).toEqual(['event-qualified', 'activity-qualified', 'bare-on-task']);
    // every listed one that is qualified is one ✂ takes out — the scan and the fix agree
    for (const t of all.slice(0, 2)) expect(TPL.sftkTplRemove(t, 'Region__c', MD.sftkMdFamObj('Task', 'Region__c')).n).toBe(1);
    expect(scanFilter('Account', all)).toEqual(['account']);
  });
});

// ── B ────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B. the ← pull leg inserts into the source org with its duplicate rules respected', () => {
  const R = extractFunctions('studio-reconcile.js', ['sftkRecPullProfile']);
  const BGSRC = read('background.js');
  const E = extractFunctions('background.js', ['_runDupHeaders']);
  // the engine's own two lines at the top of executeProfileTransfer, run as written
  const engineStart = profile => {
    const a = BGSRC.indexOf('  globalThis.__sftkRunDupBypass = ', BGSRC.indexOf('async function executeProfileTransfer('));
    const b = BGSRC.indexOf('\n', BGSRC.indexOf('  globalThis.__sftkRunDupBypassObjs = ', a));
    new Function('profile', BGSRC.slice(a, b))(profile);
  };
  const profile = () => ({
    id: 'p1', name: 'Accounts', duplicateRules: 'bypass', dupBypassObjects: ['Contact'],
    sourceOrg: 'https://src.my.salesforce.com', targetOrg: 'https://tgt.my.salesforce.com',
    tree: { objectType: 'Account', fieldMappings: { Ext__c: 'External__c', Secret__c: null }, children: [{ objectType: 'Contact' }] },
  });
  it('the reported case: Duplicate rules = Bypass, a target-only Account pulled → no allowSave header on any object', () => {
    const p = R.sftkRecPullProfile(profile(), ['001A', '001B']);
    engineStart(p);
    expect(E._runDupHeaders('Account')).toEqual({});
    expect(E._runDupHeaders('Contact')).toEqual({});
    expect(E._runDupHeaders()).toEqual({});
  });
  it('the push profile of the same deployment still carries the confirmed bypass (the test would see a dead engine otherwise)', () => {
    engineStart(profile());
    expect(E._runDupHeaders('Contact')).toEqual({ 'Sforce-Duplicate-Rule-Header': 'allowSave=true' });
    expect(E._runDupHeaders('Account')).toEqual({});   // un-ticked in the pause panel
    engineStart({ ...profile(), dupBypassObjects: undefined });
    expect(E._runDupHeaders('Account')).toEqual({ 'Sforce-Duplicate-Rule-Header': 'allowSave=true' });
  });
  it('the rest of the pull profile is what it was: inverted mappings with exclusions kept, root only, orgs swapped, the original untouched', () => {
    const src = profile();
    const p = R.sftkRecPullProfile(src, ['001A']);
    expect(p.tree.fieldMappings).toEqual({ External__c: 'Ext__c', Secret__c: null });
    expect(p.tree.recordIds).toEqual(['001A']);
    expect(p.tree.children).toEqual([]);
    expect(p.sourceOrg).toBe('https://tgt.my.salesforce.com');
    expect(p.targetOrg).toBe('https://src.my.salesforce.com');
    expect(src.duplicateRules).toBe('bypass');
    expect(src.tree.children.length).toBe(1);
  });
  it('the run builds its pull profile with that function', () => {
    expect(read('studio-reconcile.js')).toContain('const pullProfile = sftkRecPullProfile(profile, pullIds);');
  });
});

// ── C ────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('C. ▶ Continue re-ticks the inserts under existing parents of a run stopped mid-leg', () => {
  const R = extractFunctions('studio-reconcile.js', ['sftkRecRunSelected', 'sftkRecMergeSelected']);
  const SCAN = read('studio-scan.js');
  // History's real continueRun, with the page's lists and the Deploy page's re-tick entry point stubbed
  const continueRun = (run, calls, toasts) => {
    const a = SCAN.indexOf('window.continueRun = function(runId) {');
    const src = SCAN.slice(a, SCAN.indexOf('\n};', a) + 3);
    const window = { sftkDeployRetry: (...args) => calls.push(args) };
    new Function('window', '_history', '_profiles', 'showToast', src)(window, [run], [{ id: 'p1' }], (t) => toasts.push(t));
    window.continueRun(run.id);
  };
  it('the reported case: only Contacts under Accounts already in the target, paused after the first batch', () => {
    const groupB = ['003A', '003B', '003C'];
    const selected = R.sftkRecMergeSelected(R.sftkRecRunSelected([], [{ pathKey: 'Contact.AccountId', groupA: [], groupB }]), {});
    expect(selected).toEqual({ '': [], 'Contact.AccountId': groupB });
    const calls = [], toasts = [];
    continueRun({ id: 'r1', profileId: 'p1', stopped: 'pause', selected, tgtOrgUrl: 'https://tgt.my.salesforce.com' }, calls, toasts);
    expect(toasts).toEqual([]);
    expect(calls).toEqual([['p1', { 'Contact.AccountId': groupB }, 'https://tgt.my.salesforce.com', 'continue']]);
  });
  it('the old shape of that run ({ "": [] }) is what answered "kept no record of what was ticked"', () => {
    const calls = [], toasts = [];
    continueRun({ id: 'r1', profileId: 'p1', stopped: 'pause', selected: { '': [] } }, calls, toasts);
    expect(calls).toEqual([]);
    expect(toasts[0]).toMatch(/kept no record of what was ticked/);
  });
  it('a mixed run keeps every ticked id per path once: root, new-parent children and existing-parent children', () => {
    const sel = R.sftkRecRunSelected(['001A'], [
      { pathKey: 'Contact.AccountId', groupA: ['003A'], groupB: ['003B', '003A'] },
      { pathKey: 'Case.AccountId', groupA: [], groupB: [] },
      { pathKey: 'Task.WhatId', groupA: ['00TA'], groupB: [] },
    ]);
    expect(sel).toEqual({ '': ['001A'], 'Contact.AccountId': ['003A', '003B'], 'Task.WhatId': ['00TA'] });
    // a never-started leg merged on top adds nothing twice
    expect(R.sftkRecMergeSelected(sel, { 'Contact.AccountId': ['003B'] })['Contact.AccountId']).toEqual(['003A', '003B']);
  });
  it('the selection is a copy: the run’s own lists are not shared with History', () => {
    const ids = ['001A'], a = { pathKey: 'k', groupA: ['x'], groupB: ['y'] };
    const sel = R.sftkRecRunSelected(ids, [a]);
    sel[''].push('z'); sel.k.push('z');
    expect(ids).toEqual(['001A']);
    expect(a.groupB).toEqual(['y']);
  });
  it('the History entry is built with that function', () => {
    expect(read('studio-reconcile.js')).toContain('selected:     sftkRecRunSelected(treePushIds, childActs),');
  });
});
