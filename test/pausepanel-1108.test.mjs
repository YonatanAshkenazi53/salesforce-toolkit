// ⏸ THE PAUSE PANEL (user 2026-11-08: "בדאטה דיפלוי, צריך להציג למשתמש את מה
// שמכבים כשעושים דיפלוי עם אפשרות לבחור לפי האובייקטים שאנחנו מעבירים אליהם" —
// "גם פלואים, גם דופליקישן רולס, וגם ולידציות"). What a run switches off in
// the target, per object, with a tick on every item; the unticked stay as they
// are and are named in the confirmation. Duplicate rules are never switched —
// the bypass header is sent per object.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const P = extractFunctions('sftk-pausepanel.js', [
  'sftkPauseKey', 'sftkDupeRuleSelect', 'sftkPauseRows', 'sftkPauseKeep', 'sftkPauseDupeObjects',
  'sftkPauseItemName', 'sftkPauseSummary',
]);

const FLOWS = [
  { apiName: 'Acc1', label: 'FS Test Acc1', object: 'Account', version: 1 },
  { apiName: 'Acc2', label: 'FS Test Acc2', object: 'Account', version: 3 },
  { apiName: 'Con1', label: 'FS Test Con1', object: 'Contact', version: 1 },
];
const RULES = [
  { id: '03d1', name: 'Retail_Needs_Website', object: 'Account' },
  { id: '03d2', name: 'Lab_Lead_Needs_Phone', object: 'Contact' },
];
const DUPES = P.sftkDupeRuleSelect([
  { Id: '0Bm1', DeveloperName: 'Standard_Account_Duplicate_Rule', MasterLabel: 'Standard Account Duplicate Rule', SobjectType: 'Account' },
  { Id: '0Bm2', DeveloperName: 'Standard_Contact_Duplicate_Rule', MasterLabel: 'Standard Contact Duplicate Rule', SobjectType: 'Contact' },
  { Id: '0Bm3', DeveloperName: 'Standard_Lead_Duplicate_Rule', MasterLabel: 'Standard Lead Duplicate Rule', SobjectType: 'Lead' },
  { Id: null, SobjectType: 'Case' },
]);
const OBJECTS = ['Account', 'Contact', 'Opportunity'];

describe('the rows — one per deployment object, every kind the options would touch', () => {
  it('lists the items of each kind under their object; an option that is off leaves its kind out', () => {
    const rows = P.sftkPauseRows(OBJECTS, { flows: FLOWS, rules: RULES, dupes: null }, new Set(), null);
    expect(rows.map(r => r.object)).toEqual(OBJECTS);
    const acc = rows.find(r => r.object === 'Account');
    expect(acc.flows.map(x => x.label)).toEqual(['FS Test Acc1', 'FS Test Acc2']);
    expect(acc.rules.map(x => x.name)).toEqual(['Retail_Needs_Website']);
    expect(acc.dupes).toBe(null);
    expect(acc.total).toBe(3);
    const opp = rows.find(r => r.object === 'Opportunity');
    expect(opp.flows).toEqual([]);
    expect(opp.total).toBe(0);
  });

  it('every item carries its key and whether it is still ticked', () => {
    const skip = new Set(['flow:Acc2', 'rule:03d2', 'dupe:Account']);
    const rows = P.sftkPauseRows(OBJECTS, { flows: FLOWS, rules: RULES, dupes: DUPES }, skip, null);
    const acc = rows.find(r => r.object === 'Account');
    expect(acc.flows.find(x => x.apiName === 'Acc2').on).toBe(false);
    expect(acc.flows.find(x => x.apiName === 'Acc1').on).toBe(true);
    expect(acc.dupes[0].key).toBe('dupe:Account');
    expect(acc.dupes[0].on).toBe(false);
    const con = rows.find(r => r.object === 'Contact');
    expect(con.rules[0].on).toBe(false);
    expect(con.dupes[0].on).toBe(true);
  });

  it('an object nothing is written to is marked, never dropped', () => {
    const rows = P.sftkPauseRows(OBJECTS, { flows: FLOWS, rules: null, dupes: null }, new Set(), new Set(['Account']));
    expect(rows.find(r => r.object === 'Account').written).toBe(true);
    expect(rows.find(r => r.object === 'Contact').written).toBe(false);
    expect(rows).toHaveLength(3);
  });

  it('a duplicate rule row with no Id or object is left out; the rest sort by object then label', () => {
    expect(DUPES.map(d => d.object)).toEqual(['Account', 'Contact', 'Lead']);
    expect(DUPES[0].label).toBe('Standard Account Duplicate Rule');
  });
});

describe('what the run acts on — the written objects, minus the unticked', () => {
  it('keeps the ticked items on written objects; names the unticked as kept', () => {
    const { act, kept } = P.sftkPauseKeep('flow', FLOWS, new Set(['flow:Acc2']), new Set(['Account', 'Contact']));
    expect(act.map(f => f.apiName)).toEqual(['Acc1', 'Con1']);
    expect(kept.map(f => f.apiName)).toEqual(['Acc2']);
  });

  it('an item on an object the run does not write is neither acted on nor "kept" — the caller says so itself', () => {
    const { act, kept } = P.sftkPauseKeep('rule', RULES, new Set(), new Set(['Account']));
    expect(act.map(r => r.name)).toEqual(['Retail_Needs_Website']);
    expect(kept).toEqual([]);
  });

  it('the duplicate-rule bypass is per object: the written objects whose rule is still ticked', () => {
    expect(P.sftkPauseDupeObjects(DUPES, new Set(), new Set(['Account', 'Contact']))).toEqual(['Account', 'Contact']);
    expect(P.sftkPauseDupeObjects(DUPES, new Set(['dupe:Contact']), new Set(['Account', 'Contact']))).toEqual(['Account']);
    expect(P.sftkPauseDupeObjects(DUPES, new Set(['dupe:Account', 'dupe:Contact']), new Set(['Account', 'Contact']))).toEqual([]);
    // Lead has a rule but is not written → not bypassed
    expect(P.sftkPauseDupeObjects(DUPES, new Set(), new Set(['Account']))).toEqual(['Account']);
  });
});

describe('the words', () => {
  it('names an item for a sentence', () => {
    expect(P.sftkPauseItemName('flow', FLOWS[1])).toBe('FS Test Acc2 v3');
    expect(P.sftkPauseItemName('rule', RULES[0])).toBe('Retail_Needs_Website');
    expect(P.sftkPauseItemName('dupe', DUPES[0])).toBe('Standard Account Duplicate Rule');
  });

  it('the summary says, per object, what goes off — and "nothing" where nothing does', () => {
    const rows = P.sftkPauseRows(OBJECTS, { flows: FLOWS, rules: RULES, dupes: DUPES }, new Set(['flow:Acc2', 'dupe:Contact']), new Set(['Account', 'Contact']));
    const s = P.sftkPauseSummary(rows);
    expect(s).toContain('Account: 1 flow, 1 validation rule, duplicate rules bypassed');
    expect(s).toContain('Contact: 1 flow, 1 validation rule');
    expect(s).not.toContain('Contact: 1 flow, 1 validation rule, duplicate');
    expect(s).toContain('nothing active to switch on Opportunity');
    expect(s).not.toContain('Opportunity:');
    const s2 = P.sftkPauseSummary(P.sftkPauseRows(['Account'], { flows: FLOWS, rules: null, dupes: null }, new Set(['flow:Acc1', 'flow:Acc2']), new Set()));
    expect(s2).toBe('Account: nothing — every item unticked (nothing selected to write — stays on)');
  });
});

describe('the wiring', () => {
  const DEP = read('studio-deploy.js'), REC = read('studio-reconcile.js'), BG = read('background.js');
  it('the Deploy page draws one panel for the three kinds and narrows every run by its ticks', () => {
    expect(DEP).toContain('<div id="dsDepPausePanel" class="ds-dep-foot"></div>');
    // three tabs, one per kind whose option is on; every pane in the DOM, hidden when not chosen (2026-11-08)
    expect(DEP).toContain("const active = kinds.filter(k => k.on);");
    expect(DEP).toContain('class="ds-dep-pause-tab" data-tab="${t.kind}" aria-selected="${t.kind === _depPauseTab}"');
    expect(DEP).toContain('<div class="ds-dep-pause-pane" data-pane="${t.kind}"${t.kind === _depPauseTab ? \'\' : \' hidden\'}>');
    expect(DEP).toContain('No rule is switched off or changed. Untick an object to respect its rules as they are.');
    expect(DEP).toContain('switched back on when the run ends — also when it fails or is cancelled.');
    expect(DEP).not.toContain('kindLine(');
    expect(DEP).not.toContain('dsDepFlowPauseList');
    expect(DEP).not.toContain('dsDepRulePauseList');
    expect(DEP).toContain("sftkPauseKeep('flow', fpAll.flows, _depPauseSkip, writtenF)");
    expect(DEP).toContain("sftkPauseKeep('rule', vpAll.rules, _depPauseSkip, written)");
    expect(DEP).toContain('_depDupePauseWire(p);');
    expect(DEP).toContain('sftkDupeRuleList(sess, objects)');
    expect(DEP).toMatch(/data-want="on"[^]*?data-want="off"/);
  });
  it('the confirmation names what is left on by choice, and the duplicate-rule bypass per object', () => {
    expect(REC).toContain('Left ON by your choice in the ⏸ panel');
    expect(REC).toContain('Respected by your choice in the ⏸ panel');
    expect(REC).toContain('${dupeBlock}');
    expect(REC).toContain('pushProfile.dupBypassObjects = _dp.objects');
    expect(REC).toContain("|| _fp || _vp || _dp)");
  });
  it('the engine sends the duplicate-rule header only for the objects chosen', () => {
    expect(BG).toContain('__sftkRunDupBypassObjs');
    expect(BG).toContain('_runDupHeaders(objectType)');
    expect(BG).toContain('_runDupHeaders(records && records[0] && records[0].attributes && records[0].attributes.type)');
    expect(BG).toContain('const dupBypass = _runDupBypassFor(objType);');
  });
  it('the module loads before the Deploy page', () => {
    const html = read('studio.html');
    expect(html.indexOf('src="sftk-pausepanel.js"')).toBeGreaterThan(0);
    expect(html.indexOf('src="sftk-pausepanel.js"')).toBeLessThan(html.indexOf('src="studio-deploy.js"'));
  });
});
