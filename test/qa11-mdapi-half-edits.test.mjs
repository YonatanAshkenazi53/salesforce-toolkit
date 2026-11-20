// QA 1.1 findings 25, 26, 27 and 28: an edit that would leave the field named somewhere it does not rewrite is refused
// as "cannot tell" (unsure) or rewrites that place too — it is never deployed half done and reported done.
// The relationship resolver (sftk-relmap.js) is on globalThis through test/setup-relmap.mjs, as on the page.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../sftk-mdapi.js', import.meta.url), 'utf8');
const M = new Function(`${src}\nreturn { sftkMdEditField, _sftkMdSwapToken, sftkMdCodeReplace, sftkMdCodeHits };`)();

const F = 'Region__c', N = 'New__c';
const rp = (t, x, o = 'Account', f = F, n = N) => M.sftkMdEditField(t, x, o, f, n);
const rm = (t, x, o = 'Account', f = F) => M.sftkMdEditField(t, x, o, f, null);
// field-cleaner.js's "does it still name the field?" probe (_editStillNames): a refusal that is not unsure reads as no
const stillNames = (t, x, o = 'Account', f = F) => { const r = M.sftkMdEditField(t, x, o, f, '__SFTK_PROBE__'); return !r.refused || !!r.unsure; };
const unsure = (r, x, why) => { expect(r.refused).toMatch(why); expect(r.unsure).toBe(true); expect(r.changed).toBe(false); expect(r.xml).toBe(x); expect(r.how).toEqual([]); };
const edited = r => { expect(r.refused).toBeNull(); expect(r.changed).toBe(true); expect(r.unsure).toBeFalsy(); };

describe('finding 25 — a formula with a path that cannot be told is refused whole in every formula kind', () => {
  const entry = f => `<fullName>Escalate</fullName><active>true</active><ruleEntry><formula>${f}</formula></ruleEntry>`;
  for (const type of ['EscalationRule', 'AssignmentRule', 'AutoResponseRule']) {
    it(`${type}: Parent.Field beside a bare Field — refused as unsure, nothing renamed`, () => {
      const x = entry('Parent.Region__c = "x" &amp;&amp; Region__c = "y"');
      unsure(rp(type, x, 'Case'), x, /through Parent \/ MasterRecord.*cannot be told/);
      unsure(rm(type, x, 'Case'), x, /through Parent \/ MasterRecord/);
    });
    it(`${type}: the half edit made by hand still reads as naming the field`, () => {
      expect(stillNames(type, entry('Parent.Region__c = "x" &amp;&amp; New__c = "y"'), 'Case')).toBe(true);
    });
    it(`${type}: a formula with only bare references is renamed as before`, () => {
      const r = rp(type, entry('Region__c = "y"'), 'Case');
      edited(r);
      expect(r.xml).toBe(entry('New__c = "y"'));
      expect(r.how).toEqual(['rule entries: 1 reference now New__c']);
      expect(stillNames(type, r.xml, 'Case')).toBe(false);
    });
  }
  it('a rule with one clean entry and one entry that cannot be told: the whole rule is refused, the clean entry untouched', () => {
    const x = '<fullName>R</fullName><ruleEntry><formula>Region__c = "a"</formula></ruleEntry><ruleEntry><formula>Parent.Region__c = "b"</formula></ruleEntry>';
    unsure(rp('AssignmentRule', x, 'Case'), x, /cannot be told/);
  });
  it('WorkflowRule: a custom lookup path beside a bare reference — refused as unsure', () => {
    const x = '<fullName>Account.R</fullName><active>true</active><formula>Lookup__r.Region__c = "x" &amp;&amp; Region__c = "y"</formula>';
    unsure(rp('WorkflowRule', x), x, /through a custom lookup/);
    unsure(rm('WorkflowRule', x), x, /through a custom lookup/);
    expect(stillNames('WorkflowRule', '<fullName>Account.R</fullName><formula>Lookup__r.Region__c = "x" &amp;&amp; New__c = "y"</formula>')).toBe(true);
  });
  it('WorkflowRule: a plain formula is still renamed', () => {
    const r = rp('WorkflowRule', '<fullName>Account.R</fullName><formula>Region__c = "y"</formula>');
    edited(r);
    expect(r.xml).toContain('<formula>New__c = "y"</formula>');
  });
  it('ApprovalProcess: entry criteria formula with a custom lookup path beside a bare reference — refused as unsure', () => {
    const x = '<fullName>Account.P</fullName><entryCriteria><formula>Lookup__r.Region__c = "x" &amp;&amp; Region__c = "y"</formula></entryCriteria>';
    unsure(rp('ApprovalProcess', x), x, /through a custom lookup/);
    expect(stillNames('ApprovalProcess', '<fullName>Account.P</fullName><entryCriteria><formula>Lookup__r.Region__c = "x" &amp;&amp; New__c = "y"</formula></entryCriteria>')).toBe(true);
  });
  it('ApprovalProcess: a plain entry formula is still renamed', () => {
    const r = rp('ApprovalProcess', '<fullName>Account.P</fullName><entryCriteria><formula>Region__c = "y"</formula></entryCriteria>');
    edited(r);
    expect(r.xml).toContain('<formula>New__c = "y"</formula>');
  });
  it('WorkflowFieldUpdate: a formula with a path that cannot be told — refused as unsure, even when it writes the field', () => {
    const x = '<fullName>Account.U</fullName><field>Other__c</field><formula>Lookup__r.Region__c &amp; Region__c</formula>';
    unsure(rp('WorkflowFieldUpdate', x), x, /through a custom lookup/);
    const w = '<fullName>Account.U</fullName><field>Region__c</field><formula>Lookup__r.Region__c</formula>';
    unsure(rm('WorkflowFieldUpdate', w), w, /through a custom lookup/);
  });
  it('WorkflowFieldUpdate: a plain formula is still renamed', () => {
    const r = rp('WorkflowFieldUpdate', '<fullName>Account.U</fullName><field>Other__c</field><formula>Region__c &amp; "x"</formula>');
    edited(r);
    expect(r.xml).toContain('<formula>New__c &amp; "x"</formula>');
  });
});

describe('finding 26 — a lookup filter condition is read on both sides, in both spellings', () => {
  const fi = (field, value, valueField) => `<filterItems><field>${field}</field><operation>equals</operation>${value != null ? `<value>${value}</value>` : ''}${valueField ? `<valueField>${valueField}</valueField>` : ''}</filterItems>`;
  const lookup = itemsXml => `<fullName>Contact.Acc__c</fullName><type>Lookup</type>${itemsXml == null ? '' : `<lookupFilter><active>true</active>${itemsXml}<isOptional>false</isOptional></lookupFilter>`}`;
  const TWO = lookup(fi('$Source.Region__c', null, 'Account.Region__c') + fi('Account.Region__c', 'x'));
  it('⇄ of the target object’s field renames it in <valueField> too', () => {
    const r = rp('LookupFilter', TWO);
    edited(r);
    expect(r.xml).toBe(lookup(fi('$Source.Region__c', null, 'Account.New__c') + fi('Account.New__c', 'x')));
    expect(r.how).toEqual(['filter: 2 conditions now New__c']);
    expect(stillNames('LookupFilter', r.xml)).toBe(false);
  });
  it('a filter that names the field only in <valueField> reads as naming it', () => {
    expect(stillNames('LookupFilter', lookup(fi('$Source.Region__c', null, 'Account.Region__c') + fi('Account.New__c', 'x')))).toBe(true);
  });
  it('✂ takes out both conditions; with none left the whole filter goes', () => {
    const r = rm('LookupFilter', TWO);
    edited(r);
    expect(r.xml).toBe(lookup(null));
    const three = lookup(fi('$Source.Region__c', null, 'Account.Region__c') + fi('Account.Region__c', 'x') + fi('Account.Type', 'y'));
    const r3 = rm('LookupFilter', three);
    expect(r3.xml).toBe(lookup(fi('Account.Type', 'y')));
    expect(r3.how).toEqual(['filter: 2 conditions removed, 1 condition kept']);
  });
  it('the lookup’s own field written <field>$Source.Field</field> is found and renamed, the prefix kept', () => {
    const r = rp('LookupFilter', TWO, 'Contact');
    edited(r);
    expect(r.xml).toBe(lookup(fi('$Source.New__c', null, 'Account.Region__c') + fi('Account.Region__c', 'x')));
    expect(r.how).toEqual(['filter: 1 condition now New__c']);
    expect(stillNames('LookupFilter', r.xml, 'Contact')).toBe(false);
  });
  it('a condition that holds the field on both sides counts once', () => {
    const self = `<fullName>Account.Parent_Acc__c</fullName><lookupFilter>${fi('Account.Region__c', null, '$Source.Region__c')}</lookupFilter>`;
    const r = rp('LookupFilter', self);
    expect(r.xml).toBe(`<fullName>Account.Parent_Acc__c</fullName><lookupFilter>${fi('Account.New__c', null, '$Source.New__c')}</lookupFilter>`);
    expect(r.how).toEqual(['filter: 1 condition now New__c']);
  });
  it('another object’s same-named field on either side is left alone', () => {
    const x = lookup(fi('$Source.Region__c', null, 'Account.Type') + fi('Account.Name', null, '$Source.Region__c'));
    const r = rp('LookupFilter', x);   // Account.Region__c picked: $Source is Contact here
    expect(r.refused).toMatch(/no filter condition names the field/);
    expect(r.xml).toBe(x);
  });
});

describe('finding 27 — a custom lookup read through its relationship (Old__r.X) is never left behind as done', () => {
  const P = 'Partner__c', NP = 'New_Partner__c';
  const vr = (host, f) => `<fullName>${host}.V</fullName><active>true</active><errorConditionFormula>${f}</errorConditionFormula><errorMessage>m</errorMessage>`;
  it('the token swap counts the traversal as a path it does not rewrite', () => {
    const s = M._sftkMdSwapToken('Partner__r.Name = "x" && ISBLANK(Partner__c)', 'Account', P, NP, 'Account');
    expect(s).toEqual({ text: 'Partner__r.Name = "x" && ISBLANK(New_Partner__c)', n: 1, rel: 1, kind: 'ownrel' });
    expect(M._sftkMdSwapToken('Parent.Partner__r.Name', 'Account', P, null, 'Account')).toEqual({ text: 'Parent.Partner__r.Name', n: 0, rel: 1, kind: 'ownrel' });
  });
  it('a validation rule holding Partner__r.Name and Partner__c: ⇄ and ✂ are refused as unsure, the reason names the path', () => {
    const x = vr('Account', 'Partner__r.Name = "x" &amp;&amp; ISBLANK(Partner__c)');
    unsure(rp('ValidationRule', x, 'Account', P, NP), x, /reads other fields through this lookup \(Partner__r\.Field\).*edit it in Setup/);
    unsure(rm('ValidationRule', x, 'Account', P), x, /through this lookup \(Partner__r\.Field\)/);
  });
  it('the half edit (only the bare name moved) still reads as naming the field', () => {
    expect(stillNames('ValidationRule', vr('Account', 'Partner__r.Name = "x" &amp;&amp; ISBLANK(New_Partner__c)'), 'Account', P)).toBe(true);
    expect(stillNames('ValidationRule', vr('Account', 'ISBLANK(New_Partner__c)'), 'Account', P)).toBe(false);
  });
  it('a formula field, a workflow rule and a rule entry refuse the same way', () => {
    const cf = '<fullName>Account.Calc__c</fullName><formula>Partner__r.Name &amp; Partner__c</formula>';
    unsure(rp('CustomField', cf, 'Account', P, NP), cf, /through this lookup/);
    const wf = '<fullName>Account.R</fullName><formula>Partner__r.Name = "x" &amp;&amp; ISBLANK(Partner__c)</formula>';
    unsure(rp('WorkflowRule', wf, 'Account', P, NP), wf, /through this lookup/);
    const re = '<fullName>R</fullName><ruleEntry><formula>Partner__r.Name = "x" &amp;&amp; ISBLANK(Partner__c)</formula></ruleEntry>';
    unsure(rp('AssignmentRule', re, 'Case', P, NP), re, /through this lookup/);
  });
  it('another object’s own lookup of the same name is not this field: the rule is edited', () => {
    // a Contact rule: Partner__r is Contact.Partner__c; Account.Partner__c is reached through the standard Account hop
    const r = rp('ValidationRule', vr('Contact', 'Partner__r.Name = "x" &amp;&amp; ISBLANK(Account.Partner__c)'), 'Account', P, NP);
    edited(r);
    expect(r.xml).toBe(vr('Contact', 'Partner__r.Name = "x" &amp;&amp; ISBLANK(Account.New_Partner__c)'));
  });
  it('a longer name that only ends the same, and a field that is not custom, change nothing', () => {
    expect(M._sftkMdSwapToken('My_Partner__r.Name = Partner__c', 'Account', P, NP, 'Account')).toEqual({ text: 'My_Partner__r.Name = New_Partner__c', n: 1, rel: 0 });
    expect(M._sftkMdSwapToken('Owner.Name = Industry', 'Account', 'Industry', 'Type', 'Account')).toEqual({ text: 'Owner.Name = Type', n: 1, rel: 0 });
  });
  it('code: the replace reports the traversals it left, and the lines that hold them still count as naming the field', () => {
    const cls = 'public class X {\n  List<Account> a = [SELECT Partner__c, Partner__r.Name FROM Account];\n  String s = \'My_Partner__r\';\n}';
    const r = M.sftkMdCodeReplace([{ path: 'classes/X.cls', source: cls }], P, NP);
    expect(r.n).toBe(1);
    expect(r.rel).toBe(1);
    expect(r.sources[0].source).toContain('SELECT New_Partner__c, Partner__r.Name FROM Account');
    expect(M.sftkMdCodeHits(r.sources[0].source, P).map(h => h.line)).toEqual([2]);
    const clean = M.sftkMdCodeReplace([{ path: 'classes/X.cls', source: 'Account a; a.Partner__c = null;' }], P, NP);
    expect(clean.rel).toBe(0);
    expect(M.sftkMdCodeHits(clean.sources[0].source, P)).toEqual([]);
  });
});

describe('finding 28 — a prompt template’s merge fields are read along their path', () => {
  const tpl = text => '<fullName>T</fullName>'
    + '<inputs><definition>SOBJECT://Account</definition><referenceName>Input:Account</referenceName></inputs>'
    + '<inputs><definition>SOBJECT://Contact</definition><referenceName>Input:Con</referenceName></inputs>'
    + '<inputs><definition>primitive://String</definition><referenceName>Input:Note</referenceName></inputs>'
    + `<content>${text}</content>`;
  it('the direct form and the path form of the same field are both rewritten', () => {
    const r = rp('GenAiPromptTemplate', tpl('A {!$Input:Account.Region__c} B {!$Input:Con.Account.Region__c} C'));
    edited(r);
    expect(r.xml).toBe(tpl('A {!$Input:Account.New__c} B {!$Input:Con.Account.New__c} C'));
    expect(r.how).toEqual(['prompt: 2 merge fields now New__c']);
    expect(stillNames('GenAiPromptTemplate', r.xml)).toBe(false);
  });
  it('a template left with only the path form reads as naming the field', () => {
    expect(stillNames('GenAiPromptTemplate', tpl('{!$Input:Account.New__c} {!$Input:Con.Account.Region__c}'))).toBe(true);
  });
  it('a path through a custom lookup cannot be told: refused as unsure, the direct form not rewritten either', () => {
    const x = tpl('{!$Input:Account.Region__c} {!$Input:Con.Boss__r.Region__c}');
    unsure(rp('GenAiPromptTemplate', x), x, /cannot be told from the template.*Prompt Builder/);
    expect(stillNames('GenAiPromptTemplate', tpl('{!$Input:Account.New__c} {!$Input:Con.Boss__r.Region__c}'))).toBe(true);
  });
  it('a root that is neither an input nor a global of one object cannot be told either', () => {
    const x = tpl('{!$Input:Account.Region__c} {!$Flow:Get.Region__c}');
    unsure(rp('GenAiPromptTemplate', x), x, /cannot be told from the template/);
    const y = tpl('{!$Input:Account.Region__c} {!$Input:Gone.Account.Region__c}');   // a path from an input that is not declared
    unsure(rp('GenAiPromptTemplate', y), y, /cannot be told from the template/);
  });
  it('an input that is no record, and a direct merge field of an input that is not declared, are left alone', () => {
    const r = rp('GenAiPromptTemplate', tpl('{!$Input:Account.Region__c} {!$Input:Note.Region__c} {!$Input:Gone.Region__c}'));
    edited(r);
    expect(r.xml).toBe(tpl('{!$Input:Account.New__c} {!$Input:Note.Region__c} {!$Input:Gone.Region__c}'));
  });
  it('another input’s own field of the same name is left alone', () => {
    const r = rp('GenAiPromptTemplate', tpl('{!$Input:Account.Region__c} {!$Input:Con.Region__c} {!$User.Region__c}'));
    edited(r);
    expect(r.xml).toBe(tpl('{!$Input:Account.New__c} {!$Input:Con.Region__c} {!$User.Region__c}'));
    expect(r.how).toEqual(['prompt: 1 merge field now New__c']);
    const only = tpl('{!$Input:Con.Region__c}');
    const o = rp('GenAiPromptTemplate', only);
    expect(o.refused).toMatch(/no merge field of the prompt reads the field from an input of this object/);
    expect(o.unsure).toBeFalsy();
    expect(o.xml).toBe(only);
  });
  it('✂ is still refused: a prompt cannot lose a merge field', () => {
    expect(rm('GenAiPromptTemplate', tpl('{!$Input:Account.Region__c}')).refused).toMatch(/cannot lose a merge field/);
  });
});
