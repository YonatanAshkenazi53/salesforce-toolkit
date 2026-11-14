// FIELD CLEANER MATRIX — REGRESSIONS of the 2026-11-14 fixes (dbdc5e0), found by an independent review.
// Each case is the reviewer's scenario: the good behaviour from before the fix works again, and the defect the fix
// was for stays fixed (its own matrix test stays green). Other groups append their sections below.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

// ═══ sftk-mdapi.js ═════════════════════════════════════════════════════════════════════════════════════════
const M = new Function(`${read('sftk-mdapi.js')}\nreturn { sftkMdEditField, sftkMdMentionsField, sftkRtMentions, sftkRtRemoveField, sftkRtReplaceField };`)();
const col = (f, t) => `<columns><checkedByDefault>false</checkedByDefault><field>${f}</field><table>${t}</table></columns>`;
const rtype = (base, cols) => `<baseObject>${base}</baseObject><sections>${cols.join('')}<masterLabel>S</masterLabel></sections>`;
const vr = f => `<active>true</active><errorConditionFormula>${f}</errorConditionFormula><errorMessage>e</errorMessage>`;

describe('ReportType — a lookup column is counted and edited only when its path ends on the object being cleaned', () => {
  it('Account.Region__c on a Contact table is Account’s field: not counted, the plain column is removed, nothing refused', () => {
    const x = rtype('Contact', [col('Region__c', 'Contact'), col('Account.Region__c', 'Contact')]);
    expect(M.sftkRtMentions(x, 'Contact', 'Region__c')).toBe(1);
    const r = M.sftkRtRemoveField(x, 'Contact', 'Region__c');
    expect(r).toMatchObject({ removed: 1, viaLookup: [], changed: true });
    expect(r.xml).toBe(rtype('Contact', [col('Account.Region__c', 'Contact')]));
  });
  it('a type whose only column is Owner.Region__c (User’s field) is not a mention of Contact.Region__c', () => {
    expect(M.sftkRtMentions(rtype('Contact', [col('Owner.Region__c', 'Contact')]), 'Contact', 'Region__c')).toBe(0);
  });
  it('Owner.Region__c next to the plain column on Account: 1 mention, the plain column goes, Owner’s stays', () => {
    const x = rtype('Account', [col('Owner.Region__c', 'Account'), col('Region__c', 'Account')]);
    expect(M.sftkRtMentions(x, 'Account', 'Region__c')).toBe(1);
    const r = M.sftkRtRemoveField(x, 'Account', 'Region__c');
    expect(r).toMatchObject({ removed: 1, viaLookup: [], changed: true });
    expect(r.xml).toBe(rtype('Account', [col('Owner.Region__c', 'Account')]));
  });
  it('Parent.Region__c on Account IS this field: counted, removed by ✂, renamed in place by ⇄', () => {
    const x = rtype('Account', [col('Region__c', 'Account'), col('Parent.Region__c', 'Account')]);
    expect(M.sftkRtMentions(x, 'Account', 'Region__c')).toBe(2);
    const rm = M.sftkRtRemoveField(x, 'Account', 'Region__c');
    expect(rm).toMatchObject({ removed: 2, viaLookup: [] });
    expect(M.sftkRtMentions(rm.xml, 'Account', 'Region__c')).toBe(0);
    const rp = M.sftkRtReplaceField(x, 'Account', 'Region__c', 'Area__c');
    expect(rp).toMatchObject({ swapped: 2, viaLookup: [], changed: true });
    expect(rp.xml).toBe(rtype('Account', [col('Area__c', 'Account'), col('Parent.Area__c', 'Account')]));
  });
  it('a custom lookup (Lookup__r.Region__c) cannot be told: counted, never edited, named in viaLookup', () => {
    const x = rtype('Account', [col('Region__c', 'Account'), col('Thing__r.Region__c', 'Account')]);
    expect(M.sftkRtMentions(x, 'Account', 'Region__c')).toBe(2);
    const r = M.sftkRtRemoveField(x, 'Account', 'Region__c');
    expect(r.viaLookup).toEqual(['Account.Thing__r.Region__c in “S” (reached through a lookup)']);
    expect(r.xml).toContain('<field>Thing__r.Region__c</field>');
  });
});

describe('formulas — another object’s same-named field through a standard relationship is left alone, not refused', () => {
  const F = 'AND(ISPICKVAL(Region__c,"EU"), Account.Region__c = "X", Amount__c &gt; 1)';
  it('Contact validation rule: ✂ takes the one condition out, Account.Region__c stays', () => {
    const r = M.sftkMdEditField('ValidationRule', vr(F), 'Contact', 'Region__c', null);
    expect(r.refused).toBeNull();
    expect(r.how[0]).toMatch(/^1 condition/);
    expect(r.xml).toContain('Account.Region__c');
    expect(r.xml).not.toMatch(/ISPICKVAL\(Region__c/);
  });
  it('Contact validation rule: ⇄ renames the one plain reference, Account.Region__c stays', () => {
    const r = M.sftkMdEditField('ValidationRule', vr(F), 'Contact', 'Region__c', 'Area__c');
    expect(r.refused).toBeNull();
    expect(r.how).toEqual(['formula: 1 reference now Area__c']);
    expect(r.xml).toBe(vr(F.replace('ISPICKVAL(Region__c', 'ISPICKVAL(Area__c')));
  });
  it('Contact WebLink: ⇄ renames {!Contact.Region__c}, {!Account.Region__c} stays', () => {
    const r = M.sftkMdEditField('WebLink', '<url>{!Contact.Region__c}&amp;a={!Account.Region__c}</url>', 'Contact', 'Region__c', 'Area__c');
    expect(r.refused).toBeNull();
    expect(r.xml).toBe('<url>{!Contact.Area__c}&amp;a={!Account.Region__c}</url>');
  });
  it('Parent.Region__c on Account is this field: ⇄ renames it too (the matrix case stays fixed)', () => {
    // the rule names its object in <fullName> (as every read record does): Parent is read from there, never assumed
    // to be objApi (2026-11-14 review 4 — the review-4 section below has the rule without one)
    const r = M.sftkMdEditField('ValidationRule', '<fullName>Account.V</fullName>' + vr('ISBLANK(Region__c) &amp;&amp; Parent.Region__c = "x"'), 'Account', 'Region__c', 'Area__c');
    expect(r.refused).toBeNull();
    expect(r.xml).toBe('<fullName>Account.V</fullName>' + vr('ISBLANK(Area__c) &amp;&amp; Parent.Area__c = "x"'));
  });
  it('a custom lookup path (Thing__r.Region__c) is still refused whole, with the true reason', () => {
    const x = vr('ISBLANK(Region__c) &amp;&amp; Thing__r.Region__c = "x"');
    const r = M.sftkMdEditField('ValidationRule', x, 'Account', 'Region__c', 'Area__c');
    expect(r.refused).toMatch(/custom lookup/);
    expect(r.xml).toBe(x);
  });
});

describe('QuickAction — a predefined value copying the parent’s same-named field is not this field', () => {
  // the action names its object in <fullName> (as every read record does): its layout holds that object's fields —
  // with no object known the layout is left alone (2026-11-14 review 4)
  const layout = '<quickActionLayout><quickActionLayoutColumns><quickActionLayoutItems><field>Region__c</field></quickActionLayoutItems></quickActionLayoutColumns></quickActionLayout>';
  it('⇄ Contact.Region__c: the layout field and the predefined value’s target move, the formula Account.Region__c stays', () => {
    const x = `<fullName>Contact.QA</fullName><fieldOverrides><field>Region__c</field><formula>Account.Region__c</formula></fieldOverrides>${layout}`;
    const r = M.sftkMdEditField('QuickAction', x, 'Contact', 'Region__c', 'Area__c');
    expect(r.refused).toBeNull();
    expect(r.how).toEqual(['1 layout field now Area__c, 1 predefined value now Area__c']);
    expect(r.xml).toContain('<formula>Account.Region__c</formula>');
  });
  it('✂ Contact.Region__c with another field’s value computed from Account.Region__c: the layout field is removed', () => {
    const x = `<fullName>Contact.QA</fullName><fieldOverrides><field>Description</field><formula>Account.Region__c</formula></fieldOverrides>${layout}`;
    const r = M.sftkMdEditField('QuickAction', x, 'Contact', 'Region__c', null);
    expect(r.refused).toBeNull();
    expect(r.how).toEqual(['1 layout field removed']);
  });
});

describe('RestrictionRule — a bare name in the record filter is the target entity’s field', () => {
  it('⇄ User.Region__c renames $User.Region__c only, never Account’s Region__c', () => {
    const x = '<active>true</active><targetEntity>Account</targetEntity><recordFilter>Region__c = $User.Region__c</recordFilter><userCriteria>$User.IsActive = true</userCriteria>';
    const r = M.sftkMdEditField('RestrictionRule', x, 'User', 'Region__c', 'New__c');
    expect(r.refused).toBeNull();
    expect(r.xml).toContain('<recordFilter>Region__c = $User.New__c</recordFilter>');
    expect(r.how).toEqual(['record filter: 1 reference now New__c']);
  });
  it('⇄ Account.Region__c on the same rule renames the bare one only', () => {
    const x = '<active>true</active><targetEntity>Account</targetEntity><recordFilter>Region__c = $User.Region__c</recordFilter>';
    const r = M.sftkMdEditField('RestrictionRule', x, 'Account', 'Region__c', 'New__c');
    expect(r.xml).toContain('<recordFilter>New__c = $User.Region__c</recordFilter>');
  });
});

describe('formulas — $ObjectType.Obj.Fields.Field__c names this field', () => {
  it('⇄ renames it with the plain reference, so the deployed rule no longer names the field', () => {
    const x = '<active>true</active><errorConditionFormula>Region__c = &apos;x&apos; || $ObjectType.Account.Fields.Region__c.Label = &apos;y&apos;</errorConditionFormula><errorMessage>e</errorMessage>';
    const r = M.sftkMdEditField('ValidationRule', x, 'Account', 'Region__c', 'New__c');
    expect(r.refused).toBeNull();
    expect(r.xml).not.toMatch(/Region__c/);
    expect(r.how).toEqual(['formula: 2 references now New__c']);
  });
  it('$ObjectType of ANOTHER object is left alone', () => {
    const x = vr('Region__c = 1 || $ObjectType.Contact.Fields.Region__c.Label = &apos;y&apos;');
    const r = M.sftkMdEditField('ValidationRule', x, 'Account', 'Region__c', 'New__c');
    expect(r.xml).toContain('$ObjectType.Contact.Fields.Region__c');
    expect(r.how).toEqual(['formula: 1 reference now New__c']);
  });
});

describe('WorkflowRule — a time trigger as the only mention names the trigger as the reason', () => {
  it('✂ refuses with the time-trigger reason (⇄ is the way)', () => {
    const x = '<fullName>R1</fullName><active>true</active><criteriaItems><field>Account.Name</field><operation>notEqual</operation></criteriaItems><triggerType>onCreateOnly</triggerType><workflowTimeTriggers><offsetFromField>Account.Region__c</offsetFromField><timeLength>1</timeLength><workflowTimeTriggerUnit>Days</workflowTimeTriggerUnit></workflowTimeTriggers>';
    const r = M.sftkMdEditField('WorkflowRule', x, 'Account', 'Region__c', null);
    expect(r.refused).toMatch(/time trigger counts from this field — ⇄ Replace/);
    expect(r.xml).toBe(x);
  });
});

// ═══ field-cleaner.js ══════════════════════════════════════════════════════════════════════════════════════
// the tool's closure functions, sliced out the way fc-matrix-surfaces / fc-matrix-flows do
const FCJ = read('field-cleaner.js');
const fcNested = name => {
  const at = FCJ.indexOf(`\n  function ${name}(`);
  if (at < 0) throw new Error(`not found in field-cleaner.js: ${name}`);
  return FCJ.slice(at + 1, FCJ.indexOf('\n  }\n', at + 1) + 4);
};
const FR = new Function(`${read('sftk-fieldreplace.js')}\nreturn { sftkFlowResourceObjects };`)();
const FX = new Function('sftkFlowResourceObjects', `${['removeFieldFromFlexiPage', 'flexiPageReferencesField', 'removeFieldRefs', '_flowLeftWhy'].map(fcNested).join('\n')}
return { removeFieldFromFlexiPage, flexiPageReferencesField, removeFieldRefs, _flowLeftWhy };`)(FR.sftkFlowResourceObjects);
const fxRich = criteria => ({ componentInstance: { componentName: 'flexipage:richText', identifier: 'rt1', visibilityRule: { criteria } } });
const fxPage = (...items) => ({ flexiPageRegions: [{ name: 'main', itemInstances: items }] });
const fxField = { fieldInstance: { fieldItem: 'Record.Region__c' } };
const fxCrit = (left, right = 'EMEA') => ({ leftValue: left, operator: 'EQUAL', rightValue: right });
const fxClone = o => JSON.parse(JSON.stringify(o));
const critsOf = md => md.flexiPageRegions[0].itemInstances.find(i => i.componentInstance).componentInstance.visibilityRule.criteria;

describe('FlexiPage ✂ — a criterion through a self-lookup or $User names this field when its path ends on the object cleaned', () => {
  it('{!Record.Parent.Region__c} on Account IS Account.Region__c: both mentions go, and a re-run finds none left', () => {
    const md = fxPage(fxField, fxRich([fxCrit('{!Record.Parent.Region__c}'), fxCrit('{!Record.Industry}', 'Banking')]));
    expect(FX.removeFieldFromFlexiPage(md, 'Account', 'Region__c')).toBe(2);
    expect(critsOf(md)).toEqual([fxCrit('{!Record.Industry}', 'Banking')]);
    expect(FX.removeFieldFromFlexiPage(fxClone(md), 'Account', 'Region__c')).toBe(0);
    expect(FX.flexiPageReferencesField(md, 'Account', 'Region__c')).toBe(false);
  });
  it('{!Record.Owner.Region__c} on Account.Region__c is User’s field: left alone and tallied as another object’s', () => {
    const md = fxPage(fxRich([fxCrit('{!Record.Owner.Region__c}'), fxCrit('{!Record.Industry}')]));
    const out = {};
    expect(FX.removeFieldFromFlexiPage(md, 'Account', 'Region__c', out)).toBe(0);
    expect(out).toEqual({ other: 1, unknown: 0 });
    expect(critsOf(md)).toHaveLength(2);
  });
  it('{!$User.Region__c} is removed when User.Region__c is cleaned — the edit that worked before works again', () => {
    const md = fxPage(fxRich([fxCrit('{!$User.Region__c}'), fxCrit('{!$User.IsActive}', 'true')]));
    expect(FX.removeFieldFromFlexiPage(md, 'User', 'Region__c')).toBe(1);
    expect(critsOf(md)).toEqual([fxCrit('{!$User.IsActive}', 'true')]);
  });
  it('{!$User.Region__c} on Account.Region__c is another object’s field: left, counted as other', () => {
    const md = fxPage(fxField, fxRich([fxCrit('{!$User.Region__c}'), fxCrit('{!Record.Industry}')]));
    const out = {};
    expect(FX.removeFieldFromFlexiPage(md, 'Account', 'Region__c', out)).toBe(1);   // only the field component
    expect(out.other).toBe(1);
    expect(critsOf(md)).toHaveLength(2);
  });
  it('a custom lookup ({!Record.Thing__r.Region__c}) cannot be told: never edited, tallied unknown, the fix names it', () => {
    const md = fxPage(fxField, fxRich([fxCrit('{!Record.Thing__r.Region__c}'), fxCrit('{!Record.Industry}')]));
    const out = {};
    expect(FX.removeFieldFromFlexiPage(md, 'Account', 'Region__c', out)).toBe(1);
    expect(out.unknown).toBe(1);
    expect(critsOf(md)).toHaveLength(2);
    expect(FCJ).toContain('through a custom lookup left alone — whose field it is cannot be told from the page');
  });
});

describe('Flow ✂ — a chain through a relationship, or a flow resource with the field’s name, is not this field', () => {
  const asg = (...items) => ({ name: 'a', assignmentItems: items });
  const item = (to, ref) => ({ assignToReference: to, operator: 'Assign', value: ref ? { elementReference: ref } : { stringValue: 'x' } });
  it('$Record.Owner.Region__c on a Contact flow is User’s: left; $Record.Account.Region__c is Account’s: removed', () => {
    const m = { start: { object: 'Contact' }, assignments: [asg(item('v', '$Record.Owner.Region__c'), item('w', '$Record.Account.Region__c'))] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(1);
    expect(m.assignments[0].assignmentItems.map(i => i.value.elementReference)).toEqual(['$Record.Owner.Region__c']);
    expect(FX.removeFieldRefs.lastLeft.other).toEqual(['$Record.Owner.Region__c']);
  });
  it('$Record.Parent.Region__c on an Account flow is Account’s own field: removed', () => {
    const m = { start: { object: 'Account' }, assignments: [asg(item('v', '$Record.Parent.Region__c'))] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(1);
  });
  it('a custom lookup chain ($Record.Thing__r.Region__c) is never edited and is named as untellable', () => {
    const m = { start: { object: 'Account' }, assignments: [asg(item('v', '$Record.Thing__r.Region__c'))] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(0);
    expect(m.assignments[0].assignmentItems).toHaveLength(1);
    expect(FX._flowLeftWhy(FX.removeFieldRefs.lastLeft)).toMatch(/\$Record\.Thing__r\.Region__c reaches the field through a custom lookup/);
  });
  it('a flow variable named Region__c is not the field: an assignment to it stays', () => {
    const m = { variables: [{ name: 'Region__c', dataType: 'String' }], assignments: [asg(item('Region__c'))] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(0);
    expect(m.assignments[0].assignmentItems).toHaveLength(1);
  });
  it('a bare name under a key that holds a field is still the field (a Get Records queried field)', () => {
    const m = { recordLookups: [{ name: 'g', object: 'Account', queriedFields: ['Id', 'Region__c'] }] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(1);
    expect(m.recordLookups[0].queriedFields).toEqual(['Id']);
  });
});

describe('Flow ✂ — nothing taken out because the field is an element’s only filter: the refusal names that place', () => {
  it('the trigger’s only entry condition is named, not a decision / formula / variable default', () => {
    const m = { start: { object: 'Account', triggerType: 'RecordAfterSave', filters: [{ field: 'Region__c', operator: 'EqualTo', value: { stringValue: 'x' } }] } };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(0);
    expect(m.start.filters).toHaveLength(1);
    const why = FX._flowLeftWhy(FX.removeFieldRefs.lastLeft);
    expect(why).toMatch(/only condition of the trigger's entry condition \(Start\)/);
    expect(why).not.toMatch(/decision condition/);
    expect(FCJ).toContain('${_flowLeftWhy(removeFieldRefs.lastLeft)}');
  });
  it('a Get Records with numbered logic is named by its label', () => {
    const flt = (f, v) => ({ field: f, operator: 'EqualTo', value: { stringValue: v } });
    const m = { recordLookups: [{ name: 'g', label: 'Get Accts', object: 'Account', filterLogic: '1 AND (2 OR 3)', filters: [flt('Region__c', 'x'), flt('Name', 'y'), flt('Type', 'z')] }] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(0);
    expect(FX._flowLeftWhy(FX.removeFieldRefs.lastLeft)).toMatch(/the filter of "Get Accts", whose numbered filter logic/);
  });
});

// ═══ sftk-emailtpl.js ══════════════════════════════════════════════════════════════════════════════════════
const TP = new Function(`${read('sftk-emailtpl.js')}\nreturn { sftkTplRemove, sftkTplReplace, sftkTplNamesField };`)();
const vfm = (head, body) => `<messaging:emailTemplate subject="x" ${head}>\n<messaging:htmlEmailBody >\n${body}\n</messaging:htmlEmailBody>\n</messaging:emailTemplate>`;

describe('EmailTemplate — a classic {!Receiving_User.X__c} is the User’s field', () => {
  const rec = { Body: 'Region: {!Receiving_User.Region__c}' };
  it('the scan ties it to User; ✂ takes it out, ⇄ renames it', () => {
    expect(TP.sftkTplNamesField(rec, 'User', 'Region__c')).toBe(true);
    expect(TP.sftkTplRemove(rec, 'Region__c', 'User')).toEqual({ rec: { Body: 'Region: ' }, n: 1, fields: ['Body'] });
    expect(TP.sftkTplReplace(rec, 'Region__c', 'Area__c', 'User')).toEqual({ rec: { Body: 'Region: {!Receiving_User.Area__c}' }, n: 1, fields: ['Body'] });
  });
  it('not a Contact’s or an Account’s field: left alone', () => {
    expect(TP.sftkTplRemove(rec, 'Region__c', 'Contact').n).toBe(0);
    expect(TP.sftkTplReplace(rec, 'Region__c', 'Area__c', 'Account').n).toBe(0);
  });
});

describe('EmailTemplate — Visualforce: a chain is resolved to its object; another object’s same-named field stays', () => {
  const m = vfm('recipientType="Contact" relatedToType="Contact"', '<apex:outputField value="{!relatedTo.Account.Region__c}"/> <apex:outputField value="{!relatedTo.Region__c}"/>\nTier {!relatedTo.Region__c} / {!relatedTo.Account.Region__c}');
  const rec = { Markup: m };
  it('cleaning Account.Region__c: only relatedTo.Account.Region__c goes or is renamed', () => {
    expect(TP.sftkTplNamesField(rec, 'Account', 'Region__c')).toBe(true);
    const r = TP.sftkTplRemove(rec, 'Region__c', 'Account');
    expect(r.n).toBe(2);
    expect(r.rec.Markup).toBe(m.replace('<apex:outputField value="{!relatedTo.Account.Region__c}"/>', '').replace(' / {!relatedTo.Account.Region__c}', ' / '));
    const p = TP.sftkTplReplace(rec, 'Region__c', 'New__c', 'Account');
    expect(p.n).toBe(2);
    expect(p.rec.Markup).toBe(m.split('relatedTo.Account.Region__c').join('relatedTo.Account.New__c'));
  });
  it('cleaning Contact.Region__c: only relatedTo.Region__c goes or is renamed', () => {
    const r = TP.sftkTplRemove(rec, 'Region__c', 'Contact');
    expect(r.n).toBe(2);
    expect(r.rec.Markup).toContain('{!relatedTo.Account.Region__c}');
    expect(r.rec.Markup).not.toMatch(/relatedTo\.Region__c/);
    const p = TP.sftkTplReplace(rec, 'Region__c', 'New__c', 'Contact');
    expect(p.rec.Markup).toBe(m.split('relatedTo.Region__c').join('relatedTo.New__c'));
  });
  it('Owner → User, $ObjectType.Obj.Fields.X → Obj, recipient → recipientType', () => {
    const o = { Markup: vfm('recipientType="Contact" relatedToType="Account"', '{!relatedTo.Owner.Region__c} {!$ObjectType.Account.Fields.Region__c.Label} {!recipient.Region__c}') };
    expect(TP.sftkTplRemove(o, 'Region__c', 'User').rec.Markup).toContain('\n {!$ObjectType.Account.Fields.Region__c.Label} {!recipient.Region__c}\n');
    expect(TP.sftkTplRemove(o, 'Region__c', 'Account').rec.Markup).toContain('\n{!relatedTo.Owner.Region__c}  {!recipient.Region__c}\n');
    expect(TP.sftkTplReplace(o, 'Region__c', 'X__c', 'Contact').rec.Markup).toContain('{!recipient.X__c}');
  });
  it('a custom relationship or an <apex:repeat> variable cannot be told: refused with the reason, nothing written', () => {
    const c = { Markup: vfm('relatedToType="Account"', 'Tier {!relatedTo.Region__c} {!relatedTo.Parent_Org__r.Region__c}') };
    const r = TP.sftkTplRemove(c, 'Region__c', 'Account');
    expect(r).toMatchObject({ n: 0, rec: {} });
    expect(r.refused).toMatch(/through “\{!relatedTo\.Parent_Org__r\.Region__c\}” — which object's field that is cannot be told/);
    expect(TP.sftkTplReplace(c, 'Region__c', 'X__c', 'Account').refused).toMatch(/cannot be told from the markup/);
    const v = { Markup: vfm('relatedToType="Account"', '<apex:repeat value="{!relatedTo.Contacts}" var="c"><apex:outputField value="{!c.Region__c}"/></apex:repeat>') };
    expect(TP.sftkTplRemove(v, 'Region__c', 'Account').refused).toMatch(/cannot be told/);
  });
});

describe('EmailTemplate — Visualforce: a single-quoted binding is a bound component too', () => {
  it('<apex:outputField value=\'{!relatedTo.X}\'/> goes whole, never value=\'\'', () => {
    const m = vfm('relatedToType="Account"', "<apex:outputField value='{!relatedTo.Region__c}'/>");
    const r = TP.sftkTplRemove({ Markup: m }, 'Region__c', 'Account');
    expect(r).toEqual({ rec: { Markup: m.replace("<apex:outputField value='{!relatedTo.Region__c}'/>", '') }, n: 1, fields: ['Markup'] });
    expect(r.rec.Markup).not.toContain("value=''");
  });
  it('a single-quoted <apex:repeat value=…> binding is refused, like the double-quoted one', () => {
    const m = vfm('relatedToType="Account"', "<apex:repeat value='{!relatedTo.Region__c}' var='v'>{!v}</apex:repeat>");
    const r = TP.sftkTplRemove({ Markup: m }, 'Region__c', 'Account');
    expect(r.n).toBe(0);
    expect(r.refused).toMatch(/binds a component's attribute to Region__c/);
  });
  it('another object’s field bound in an attribute is not this field: no refusal', () => {
    const m = vfm('relatedToType="Contact"', '<apex:repeat value="{!relatedTo.Account.Region__c}" var="v">{!v}</apex:repeat> {!relatedTo.Region__c}');
    const r = TP.sftkTplRemove({ Markup: m }, 'Region__c', 'Contact');
    expect(r.refused).toBeUndefined();
    expect(r.n).toBe(1);
    expect(r.rec.Markup).toContain('value="{!relatedTo.Account.Region__c}"');
  });
});

describe('EmailTemplate — Visualforce: every standard relationship hop is followed to its object (review 2, 2026-11-14)', () => {
  it('relatedTo.PartnerAccount.X on an Opportunity is Account’s: ✂ and ⇄ take both Account mentions', () => {
    const m = vfm('relatedToType="Opportunity"', 'A {!relatedTo.Account.Region__c} P {!relatedTo.PartnerAccount.Region__c}');
    const r = TP.sftkTplRemove({ Markup: m }, 'Region__c', 'Account');
    expect(r).toEqual({ rec: { Markup: vfm('relatedToType="Opportunity"', 'A  P ') }, n: 2, fields: ['Markup'] });
    const p = TP.sftkTplReplace({ Markup: m }, 'Region__c', 'Area__c', 'Account');
    expect(p.n).toBe(2);
    expect(p.rec.Markup).not.toMatch(/Region__c/);
  });
  it('relatedTo.ConvertedAccount.X on a Lead is Account’s: removed, not "no merge field"', () => {
    const r = TP.sftkTplRemove({ Markup: vfm('relatedToType="Lead"', '{!relatedTo.ConvertedAccount.Region__c}') }, 'Region__c', 'Account');
    expect(r.n).toBe(1);
  });
  it('relatedTo.CompanySigned.X on a Contract is User’s, next to Owner’s', () => {
    const r = TP.sftkTplRemove({ Markup: vfm('relatedToType="Contract"', '{!relatedTo.Owner.Region__c} {!relatedTo.CompanySigned.Region__c}') }, 'Region__c', 'User');
    expect(r.n).toBe(2);
    expect(r.rec.Markup).not.toMatch(/Region__c/);
  });
  // review 3 reversed this: a standard hop not in the map is a lookup named for its object (as before review 2), so the
  // Mystery mention is another object's and stays; only …__r / What / Who are refused
  it('a standard hop not in the map is taken as its own object: left alone, the own mention still taken out', () => {
    const r = TP.sftkTplRemove({ Markup: vfm('relatedToType="Opportunity"', '{!relatedTo.Account.Region__c} {!relatedTo.Mystery.Region__c}') }, 'Region__c', 'Account');
    expect(r.refused).toBeUndefined();
    expect(r.n).toBe(1);
    expect(r.rec.Markup).toContain('{!relatedTo.Mystery.Region__c}');
    expect(r.rec.Markup).not.toContain('relatedTo.Account.Region__c');
  });
});

describe('EmailTemplate — Visualforce: a standard lookup named for its object is followed, never refused (review 3, 2026-11-14)', () => {
  it('Entitlement.Region__c through relatedTo.Entitlement on a Case: ⇄ renames it, ✂ takes it out', () => {
    const m = vfm('relatedToType="Case"', '{!relatedTo.Entitlement.Region__c}');
    const p = TP.sftkTplReplace({ Markup: m }, 'Region__c', 'Area__c', 'Entitlement');
    expect(p.refused).toBeUndefined();
    expect(p).toEqual({ rec: { Markup: vfm('relatedToType="Case"', '{!relatedTo.Entitlement.Area__c}') }, n: 1, fields: ['Markup'] });
    const r = TP.sftkTplRemove({ Markup: m }, 'Region__c', 'Entitlement');
    expect(r).toEqual({ rec: { Markup: vfm('relatedToType="Case"', '') }, n: 1, fields: ['Markup'] });
  });
  it('Case.Region__c next to relatedTo.Entitlement.Region__c: the Case mention goes or is renamed, Entitlement’s is left alone', () => {
    const m = vfm('relatedToType="Case"', '{!relatedTo.Region__c} {!relatedTo.Entitlement.Region__c}');
    const p = TP.sftkTplReplace({ Markup: m }, 'Region__c', 'Area__c', 'Case');
    expect(p.refused).toBeUndefined();
    expect(p.rec.Markup).toBe(vfm('relatedToType="Case"', '{!relatedTo.Area__c} {!relatedTo.Entitlement.Region__c}'));
    const r = TP.sftkTplRemove({ Markup: m }, 'Region__c', 'Case');
    expect(r).toEqual({ rec: { Markup: vfm('relatedToType="Case"', ' {!relatedTo.Entitlement.Region__c}') }, n: 1, fields: ['Markup'] });
  });
  it('Individual.Region__c through relatedTo.Individual on a Contact is Individual’s; cleaning Contact’s leaves it alone', () => {
    const m = vfm('relatedToType="Contact"', '{!relatedTo.Region__c} {!relatedTo.Individual.Region__c}');
    const i = TP.sftkTplRemove({ Markup: m }, 'Region__c', 'Individual');
    expect(i).toEqual({ rec: { Markup: vfm('relatedToType="Contact"', '{!relatedTo.Region__c} ') }, n: 1, fields: ['Markup'] });
    const c = TP.sftkTplReplace({ Markup: m }, 'Region__c', 'Area__c', 'Contact');
    expect(c.refused).toBeUndefined();
    expect(c.rec.Markup).toBe(vfm('relatedToType="Contact"', '{!relatedTo.Area__c} {!relatedTo.Individual.Region__c}'));
  });
  it('PricebookEntry.Product2 on an OpportunityLineItem ends on Product2', () => {
    const m = vfm('relatedToType="OpportunityLineItem"', '{!relatedTo.PricebookEntry.Product2.Region__c}');
    expect(TP.sftkTplReplace({ Markup: m }, 'Region__c', 'Area__c', 'Product2').rec.Markup).toContain('{!relatedTo.PricebookEntry.Product2.Area__c}');
    expect(TP.sftkTplRemove({ Markup: m }, 'Region__c', 'OpportunityLineItem').n).toBe(0);
  });
  it('a custom …__r or a polymorphic What hop is still refused with the reason', () => {
    expect(TP.sftkTplRemove({ Markup: vfm('relatedToType="Case"', '{!relatedTo.Thing__r.Region__c}') }, 'Region__c', 'Case').refused).toMatch(/cannot be told/);
    expect(TP.sftkTplRemove({ Markup: vfm('relatedToType="Task"', '{!relatedTo.What.Region__c}') }, 'Region__c', 'Account').refused).toMatch(/cannot be told/);
  });
});

describe('EmailTemplate — Visualforce: $User / $Organization / $Setup name their object (review 2, 2026-11-14)', () => {
  const u = { Markup: vfm('relatedToType="Account"', 'Tier {!relatedTo.Region__c} / me {!$User.Region__c} {!$Organization.Region__c}') };
  it('cleaning User.Region__c: {!$User.Region__c} goes, the Account’s and the Organization’s stay', () => {
    const r = TP.sftkTplRemove(u, 'Region__c', 'User');
    expect(r.refused).toBeUndefined();
    expect(r.n).toBe(1);
    expect(r.rec.Markup).toContain('Tier {!relatedTo.Region__c} / me  {!$Organization.Region__c}');
  });
  it('cleaning Account.Region__c: relatedTo’s goes or is renamed, $User’s and $Organization’s are left alone — not refused', () => {
    const r = TP.sftkTplRemove(u, 'Region__c', 'Account');
    expect(r.refused).toBeUndefined();
    expect(r.rec.Markup).toContain('Tier  / me {!$User.Region__c} {!$Organization.Region__c}');
    const p = TP.sftkTplReplace(u, 'Region__c', 'Area__c', 'Account');
    expect(p.refused).toBeUndefined();
    expect(p.rec.Markup).toContain('Tier {!relatedTo.Area__c} / me {!$User.Region__c} {!$Organization.Region__c}');
  });
  it('$Setup.Obj.X is Obj’s field', () => {
    const r = TP.sftkTplRemove({ Markup: vfm('relatedToType="Account"', '{!$Setup.MySet__c.Region__c} {!relatedTo.Region__c}') }, 'Region__c', 'MySet__c');
    expect(r.n).toBe(1);
    expect(r.rec.Markup).toContain(' {!relatedTo.Region__c}');
  });
});

describe('EmailTemplate — Visualforce: a hop after a global is followed from the global’s object (review 3, 2026-11-14)', () => {
  const h = 'recipientType="Contact" relatedToType="Account"';
  it('{!$User.Manager.Region__c} is User’s own field: ⇄ renames it and ✂ takes it out, like {!recipient.Manager.Region__c}', () => {
    const m = vfm(h, '{!$User.Manager.Region__c}');
    expect(TP.sftkTplReplace({ Markup: m }, 'Region__c', 'Area__c', 'User')).toEqual({ rec: { Markup: vfm(h, '{!$User.Manager.Area__c}') }, n: 1, fields: ['Markup'] });
    expect(TP.sftkTplRemove({ Markup: m }, 'Region__c', 'User').n).toBe(1);
    const viaRecipient = vfm('recipientType="User" relatedToType="Account"', '{!recipient.Manager.Region__c}');
    expect(TP.sftkTplReplace({ Markup: viaRecipient }, 'Region__c', 'Area__c', 'User').n).toBe(1);
  });
  it('{!$User.Contact.Region__c} / {!$User.Account.Region__c} are Contact’s / Account’s, not User’s', () => {
    const m = vfm(h, '{!$User.Contact.Region__c} {!$User.Account.Region__c}');
    expect(TP.sftkTplReplace({ Markup: m }, 'Region__c', 'Area__c', 'Contact').rec.Markup).toBe(vfm(h, '{!$User.Contact.Area__c} {!$User.Account.Region__c}'));
    expect(TP.sftkTplReplace({ Markup: m }, 'Region__c', 'Area__c', 'Account').rec.Markup).toBe(vfm(h, '{!$User.Contact.Region__c} {!$User.Account.Area__c}'));
    expect(TP.sftkTplReplace({ Markup: m }, 'Region__c', 'Area__c', 'User')).toEqual({ rec: {}, n: 0, fields: [] });
  });
  it('a hop after a global that the map does not know is refused with the reason, never taken as foreign', () => {
    const p = TP.sftkTplReplace({ Markup: vfm(h, '{!$User.Mystery__r.Region__c}') }, 'Region__c', 'Area__c', 'User');
    expect(p).toMatchObject({ n: 0, rec: {} });
    expect(p.refused).toMatch(/through “\{!\$User\.Mystery__r\.Region__c\}?” — which object's field that is cannot be told/);
  });
  it('{!$Setup.MySet__c.Owner.Region__c} is followed from MySet__c: User’s field', () => {
    const m = vfm(h, '{!$Setup.MySet__c.Owner.Region__c}');
    expect(TP.sftkTplReplace({ Markup: m }, 'Region__c', 'Area__c', 'User').n).toBe(1);
    expect(TP.sftkTplReplace({ Markup: m }, 'Region__c', 'Area__c', 'MySet__c').n).toBe(0);
  });
});

describe('ReportType ⇄ — a lookup path ending on the object is renamed, never lost, when the new field is already a column (review 2, 2026-11-14)', () => {
  it('Region__c + Area__c + Parent.Region__c on Account: the plain old column goes, Parent.Region__c becomes Parent.Area__c', () => {
    const x = rtype('Account', [col('Region__c', 'Account'), col('Area__c', 'Account'), col('Parent.Region__c', 'Account')]);
    const r = M.sftkRtReplaceField(x, 'Account', 'Region__c', 'Area__c');
    expect(r).toMatchObject({ swapped: 1, dropped: 1, newAlreadyThere: true, viaLookup: [], changed: true });
    expect(r.xml).toBe(rtype('Account', [col('Area__c', 'Account'), col('Parent.Area__c', 'Account')]));
    expect(M.sftkRtMentions(r.xml, 'Account', 'Region__c')).toBe(0);
  });
  it('Parent.Area__c already there: Parent.Region__c is dropped and counted in `dropped`, and the success text says so', () => {
    const x = rtype('Account', [col('Region__c', 'Account'), col('Parent.Region__c', 'Account'), col('Parent.Area__c', 'Account')]);
    const r = M.sftkRtReplaceField(x, 'Account', 'Region__c', 'Area__c');
    expect(r).toMatchObject({ swapped: 1, dropped: 1, newAlreadyThere: false, changed: true });
    expect(r.xml).toBe(rtype('Account', [col('Area__c', 'Account'), col('Parent.Area__c', 'Account')]));
    const fc = read('field-cleaner.js');
    const body = fc.slice(fc.indexOf('async function fixReportType('), fc.indexOf('async function fixReportType(') + 8000);
    expect(body).toMatch(/if \(swap && res\.dropped\) bits\.push\(/);
    expect(body).toContain('the column it would have become was already on the type');
  });
});

describe('ReportType ⇄ — the success text of a plain rename states no removal (review 3, 2026-11-14)', () => {
  // the message lines of fixReportType, run as they are in field-cleaner.js
  const fcSrc = read('field-cleaner.js');
  const at = fcSrc.indexOf('const bits = [];', fcSrc.indexOf('async function fixReportType('));
  const msg = new Function('swap', 'res', 'swapTo',
    fcSrc.slice(at, fcSrc.indexOf('return `✅ Report type updated', at)) + 'return bits.join(" · ");');
  it('Region__c → Area__c with nothing dropped: "1 column now names Area__c", never "undefined columns removed"', () => {
    const r = M.sftkRtReplaceField(rtype('Account', [col('Region__c', 'Account')]), 'Account', 'Region__c', 'Area__c');
    expect(r).toMatchObject({ swapped: 1, dropped: 0, changed: true });
    const t = msg(true, r, 'Area__c');
    expect(t).toBe('1 column now names Area__c');
    expect(t).not.toMatch(/undefined|removed/);
  });
  it('✂ still says how many columns were removed', () => {
    const r = M.sftkRtRemoveField(rtype('Account', [col('Region__c', 'Account'), col('Name', 'Account')]), 'Account', 'Region__c');
    expect(msg(false, r, '')).toBe('1 column removed');
  });
  it('⇄ with a drop still says both counts', () => {
    const x = rtype('Account', [col('Region__c', 'Account'), col('Parent.Region__c', 'Account'), col('Parent.Area__c', 'Account')]);
    const t = msg(true, M.sftkRtReplaceField(x, 'Account', 'Region__c', 'Area__c'), 'Area__c');
    expect(t).toMatch(/^1 column now names Area__c · an old column was removed instead/);
    expect(t).not.toMatch(/undefined/);
  });
});

// review 3 (2026-11-14): an unmapped standard hop is its own object again (not a refusal of the whole template), and
// Parent follows the object it is on (CaseComment / EmailMessage → Case; Attachment / Note → cannot be told)
describe('email template — review 3', () => {
  const vf = (type, body) => ({ Markup: `<messaging:emailTemplate relatedToType="${type}"><messaging:htmlEmailBody>${body}</messaging:htmlEmailBody></messaging:emailTemplate>` });
  it('GiftTransaction: relatedTo.GiftCommitment.Amt__c is GiftCommitment\'s, left; the own mention renamed', () => {
    const r = TP.sftkTplReplace(vf('GiftTransaction', '{!relatedTo.Amt__c} {!relatedTo.GiftCommitment.Amt__c}'), 'Amt__c', 'New__c', 'GiftTransaction');
    expect(r.refused).toBeUndefined();
    expect(r.rec.Markup).toContain('{!relatedTo.New__c} {!relatedTo.GiftCommitment.Amt__c}');
  });
  it('objApi GiftCommitment: the hop mention is renamed', () => {
    const r = TP.sftkTplReplace(vf('GiftTransaction', '{!relatedTo.Amt__c} {!relatedTo.GiftCommitment.Amt__c}'), 'Amt__c', 'New__c', 'GiftCommitment');
    expect(r.rec.Markup).toContain('{!relatedTo.Amt__c} {!relatedTo.GiftCommitment.New__c}');
  });
  it('a custom …__r hop still refuses', () => {
    const r = TP.sftkTplReplace(vf('Account', '{!relatedTo.Thing__r.Amt__c}'), 'Amt__c', 'New__c', 'Account');
    expect(r.refused).toMatch(/cannot be told/);
  });
  it('CaseComment.Parent is Case', () => {
    const r = TP.sftkTplReplace(vf('CaseComment', '{!relatedTo.Parent.Amt__c}'), 'Amt__c', 'New__c', 'Case');
    expect(r.rec.Markup).toContain('{!relatedTo.Parent.New__c}');
    const s = TP.sftkTplReplace(vf('CaseComment', '{!relatedTo.Parent.Amt__c}'), 'Amt__c', 'New__c', 'CaseComment');
    expect(s.n).toBe(0);
  });
  it('Account.Parent is Account; Attachment.Parent cannot be told', () => {
    expect(TP.sftkTplReplace(vf('Account', '{!relatedTo.Parent.Amt__c}'), 'Amt__c', 'New__c', 'Account').rec.Markup).toContain('Parent.New__c');
    expect(TP.sftkTplReplace(vf('Attachment', '{!relatedTo.Parent.Amt__c}'), 'Amt__c', 'New__c', 'Account').refused).toMatch(/cannot be told/);
  });
});

// review 4 (2026-11-14), sftk-mdapi.js: Parent / MasterRecord follow the component's own object (its <fullName>),
// never objApi; an unknown host answers "cannot tell"; the error display field is the rule's own object's; an unmapped
// standard hop is its own object (not a false "custom lookup"); a CMDT value pairs with the object of its own prefix.
describe('review 4 (2026-11-14)', () => {
  const R4 = new Function(`${read('sftk-mdapi.js')}\nreturn { sftkMdEditField, sftkFormulaDropField, sftkMdValuesHolding };`)();
  const rule = (obj, f, extra = '') => `<fullName>${obj}.V</fullName><active>true</active><errorConditionFormula>${f}</errorConditionFormula>${extra}<errorMessage>x</errorMessage>`;
  it('Case rule: ⇄ Account.Region__c renames Account.Region__c only — Parent.Region__c is Case’s', () => {
    const r = R4.sftkMdEditField('ValidationRule', rule('Case', 'Account.Region__c = Parent.Region__c'), 'Account', 'Region__c', 'Area__c');
    expect(r.refused).toBeNull();
    expect(r.xml).toBe(rule('Case', 'Account.Area__c = Parent.Region__c'));
    expect(r.how).toEqual(['formula: 1 reference now Area__c']);
  });
  it('Case rule: ✂ Account.Region__c takes out only the Account condition, the Parent one stays', () => {
    const r = R4.sftkMdEditField('ValidationRule', rule('Case', 'AND(Account.Region__c = &quot;EU&quot;, Parent.Region__c = &quot;US&quot;, IsClosed)'), 'Account', 'Region__c', null);
    expect(r.refused).toBeNull();
    expect(r.xml).toContain('AND(Parent.Region__c = &quot;US&quot;, IsClosed)');
    expect(r.how[0]).toMatch(/^1 condition/);
  });
  it('Account formula field: ⇄ User.Region__c renames Owner.Region__c only — Parent.Region__c is Account’s', () => {
    const r = R4.sftkMdEditField('CustomField', '<fullName>Account.F__c</fullName><formula>Owner.Region__c &amp; Parent.Region__c</formula><type>Text</type>', 'User', 'Region__c', 'Area__c');
    expect(r.refused).toBeNull();
    expect(r.xml).toContain('<formula>Owner.Area__c &amp; Parent.Region__c</formula>');
  });
  it('Case WebLink: {!Case.Parent.Region__c} is Case’s, left on ⇄ Account.Region__c', () => {
    const r = R4.sftkMdEditField('WebLink', '<fullName>Case.L</fullName><url>/apex/P?a={!Account.Region__c}&amp;p={!Case.Parent.Region__c}</url>', 'Account', 'Region__c', 'Area__c');
    expect(r.xml).toContain('a={!Account.Area__c}&amp;p={!Case.Parent.Region__c}');
  });
  it('Account rule: Parent.Region__c is still this field (renamed with the plain one)', () => {
    const r = R4.sftkMdEditField('ValidationRule', rule('Account', 'Region__c = Parent.Region__c'), 'Account', 'Region__c', 'Area__c');
    expect(r.xml).toBe(rule('Account', 'Area__c = Parent.Area__c'));
  });
  it('no <fullName> (host not known): a Parent hop is refused with that reason, never taken as objApi', () => {
    const x = '<active>true</active><errorConditionFormula>Region__c = Parent.Region__c</errorConditionFormula><errorMessage>x</errorMessage>';
    const r = R4.sftkMdEditField('ValidationRule', x, 'Account', 'Region__c', 'Area__c');
    expect(r.xml).toBe(x);
    expect(r.refused).toMatch(/Parent \/ MasterRecord, and the object the formula runs on is not known/);
    expect(r.refused).not.toMatch(/custom lookup/);
  });
  it('sftkFormulaDropField without a host does not take a Parent condition for this field; with the host it does', () => {
    expect(R4.sftkFormulaDropField('Parent.Region__c = "x" && IsClosed', 'Account', 'Region__c')).toEqual({ mode: 'none' });
    expect(R4.sftkFormulaDropField('Parent.Region__c = "x" && IsClosed', 'Account', 'Region__c', null, 'Account')).toMatchObject({ mode: 'operand', text: 'IsClosed', n: 1 });
    expect(R4.sftkFormulaDropField('Parent.Region__c = "x" && IsClosed', 'Account', 'Region__c', null, 'Case')).toEqual({ mode: 'none' });
  });
  it('CaseComment rule: Parent is Case', () => {
    const r = R4.sftkMdEditField('ValidationRule', rule('CaseComment', 'Parent.Region__c = "x"'), 'Case', 'Region__c', 'Area__c');
    expect(r.xml).toBe(rule('CaseComment', 'Parent.Area__c = "x"'));
  });
  it('Account rule on $User.Region__c: ⇄ / ✂ User.Region__c leave <errorDisplayField>Region__c</errorDisplayField> (Account’s)', () => {
    const x = '<fullName>Account.Check2</fullName><active>true</active><errorConditionFormula>$User.Region__c = &apos;EU&apos;</errorConditionFormula><errorDisplayField>Region__c</errorDisplayField><errorMessage>x</errorMessage>';
    const p = R4.sftkMdEditField('ValidationRule', x, 'User', 'Region__c', 'Area__c');
    expect(p.xml).toContain('<errorDisplayField>Region__c</errorDisplayField>');
    expect(p.xml).toContain('$User.Area__c');
    expect(p.how).toEqual(['formula: 1 reference now Area__c']);
    const c = R4.sftkMdEditField('ValidationRule', x, 'User', 'Region__c', null);
    expect(c.xml).toContain('<errorDisplayField>Region__c</errorDisplayField>');
    expect(c.how.join(' ')).not.toMatch(/error location/);
  });
  it('the rule’s own object: <errorDisplayField> still moves with ⇄ (case-insensitive object match)', () => {
    const x = '<fullName>account.Check3</fullName><active>true</active><errorConditionFormula>ISBLANK(Region__c)</errorConditionFormula><errorDisplayField>Region__c</errorDisplayField><errorMessage>x</errorMessage>';
    const r = R4.sftkMdEditField('ValidationRule', x, 'Account', 'Region__c', 'Area__c');
    expect(r.xml).toContain('<errorDisplayField>Area__c</errorDisplayField>');
  });
  it('Case rule: Asset.Region__c is Asset’s — ⇄ Account.Region__c renames Account’s, nothing refused', () => {
    const r = R4.sftkMdEditField('ValidationRule', rule('Case', 'Account.Region__c &lt;&gt; Asset.Region__c'), 'Account', 'Region__c', 'Area__c');
    expect(r.refused).toBeNull();
    expect(r.xml).toBe(rule('Case', 'Account.Area__c &lt;&gt; Asset.Region__c'));
  });
  it('a What / Who hop is refused with its true reason, not as a custom lookup', () => {
    const r = R4.sftkMdEditField('ValidationRule', rule('Task', 'What.Region__c = "x"'), 'Account', 'Region__c', 'Area__c');
    expect(r.refused).toMatch(/What \/ Who/);
    expect(r.refused).not.toMatch(/custom lookup/);
  });
  const v = (f, x) => `<values><field>${f}</field><value xsi:type="xsd:string">${x}</value></values>`;
  it('CMDT Source_/Target_ mapping: ⇄ Account.Region__c renames Target_Field__c only (Source is Lead’s)', () => {
    const x = '<fullName>Map.M</fullName><label>Map</label>' + v('Source_Object__c', 'Lead') + v('Source_Field__c', 'Region__c') + v('Target_Object__c', 'Account') + v('Target_Field__c', 'Region__c');
    const r = R4.sftkMdEditField('CustomMetadataRecord', x, 'Account', 'Region__c', 'Area__c');
    expect(r.refused).toBeNull();
    expect(r.xml).toContain(v('Source_Field__c', 'Region__c'));
    expect(r.xml).toContain(v('Target_Field__c', 'Area__c'));
    expect(r.how).toEqual(['1 value now Area__c']);
    expect(R4.sftkMdValuesHolding(x, 'Lead', 'Region__c')).toEqual(['Source_Field__c']);
  });
  it('CMDT naming two objects with no pairing: refused with that reason, nothing edited', () => {
    const x = '<fullName>Map.N</fullName><label>N</label>' + v('From__c', 'Lead') + v('To__c', 'Account') + v('Field__c', 'Region__c');
    const r = R4.sftkMdEditField('CustomMetadataRecord', x, 'Account', 'Region__c', 'Area__c');
    expect(r.xml).toBe(x);
    expect(r.refused).toMatch(/names Account and another object, and which of them Field__c belongs to cannot be told/);
  });
});

// review 4 (2026-11-14), sftk-emailtpl.js: a Visualforce template's Subject holds Visualforce merge syntax too
// ({!relatedTo.X__c}) — it is read with the Visualforce rules, the types from the Markup, never the classic one that
// took relatedTo for another object and left the Subject behind.
describe('review 4 (2026-11-14)', () => {
  const tpl = (type, subj) => ({ TemplateType: 'visualforce', Subject: subj,
    Markup: `<messaging:emailTemplate subject="${subj}" recipientType="Contact" relatedToType="${type}"><messaging:plainTextEmailBody>Hi {!relatedTo.Region__c}</messaging:plainTextEmailBody></messaging:emailTemplate>` });
  it('EmailTemplate VF ⇄: Subject and Markup both renamed when relatedToType is the object', () => {
    const r = TP.sftkTplReplace(tpl('Account', 'Case for {!relatedTo.Region__c}'), 'Region__c', 'Area__c', 'Account');
    expect(r.refused).toBeUndefined();
    expect(r.rec.Subject).toBe('Case for {!relatedTo.Area__c}');
    expect(r.rec.Markup).toContain('subject="Case for {!relatedTo.Area__c}"');
    expect(r.n).toBe(3);
    expect(r.fields).toEqual(['Subject', 'Markup']);
  });
  it('EmailTemplate VF ✂: the Subject merge field goes with the Markup ones', () => {
    const r = TP.sftkTplRemove(tpl('Account', 'Case for {!relatedTo.Region__c}'), 'Region__c', 'Account');
    expect(r.refused).toBeUndefined();
    expect(r.rec.Subject).toBe('Case for ');
    expect(r.n).toBe(3);
  });
  it('EmailTemplate VF: another object’s template leaves the Subject alone; $User / recipient resolved from the Markup', () => {
    expect(TP.sftkTplReplace(tpl('Account', 'Case for {!relatedTo.Region__c}'), 'Region__c', 'Area__c', 'Case').n).toBe(0);
    const r = TP.sftkTplReplace(tpl('Account', '{!recipient.Region__c} {!$User.Region__c}'), 'Region__c', 'Area__c', 'Contact');
    expect(r.rec.Subject).toBe('{!recipient.Area__c} {!$User.Region__c}');
  });
  it('EmailTemplate VF: no Markup to read the type from — the Subject mention is refused, never guessed', () => {
    const r = TP.sftkTplReplace({ TemplateType: 'visualforce', Subject: '{!relatedTo.Region__c}' }, 'Region__c', 'Area__c', 'Account');
    expect(r.n).toBe(0);
    expect(r.refused).toMatch(/cannot be told/);
  });
  it('a classic template’s Subject keeps the classic rule', () => {
    const r = TP.sftkTplReplace({ TemplateType: 'text', Subject: '{!Account.Region__c} {!Contact.Region__c}' }, 'Region__c', 'Area__c', 'Account');
    expect(r.rec.Subject).toBe('{!Account.Area__c} {!Contact.Region__c}');
  });
});

// review 4 (2026-11-14), field-cleaner.js: when ✂ takes nothing out of a flow the refusal names EVERY kind of thing left
// (a decision outcome, a formula), not only another object's mentions; a Record Update / Create on a record variable
// (inputReference) is judged by the variable's object, and left whole and named when that cannot be told.
describe('review 4 (2026-11-14)', () => {
  const cond = (l, v) => ({ leftValueReference: l, operator: 'EqualTo', rightValue: { stringValue: v } });
  it('flow ✂: a decision outcome resting on the field alone is named in the refusal, beside the foreign mention', () => {
    const m = { start: { object: 'Account' },
      decisions: [{ name: 'D', label: 'Region check', rules: [{ name: 'EU', label: 'Is EU', conditionLogic: 'and', conditions: [cond('$Record.Region__c', 'EU')] }] }],
      assignments: [{ name: 'a', assignmentItems: [{ assignToReference: 'v', operator: 'Assign', value: { elementReference: '$Record.Owner.Region__c' } }] }] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(0);
    const why = FX._flowLeftWhy(FX.removeFieldRefs.lastLeft);
    expect(why).toMatch(/only condition of the outcome "Is EU" of the decision "Region check"/);
    expect(why).toMatch(/\$Record\.Owner\.Region__c is another object's same-named field/);
    expect(m.decisions[0].rules[0].conditions).toHaveLength(1);
  });
  it('flow ✂: an outcome with numbered logic is named', () => {
    const m = { start: { object: 'Account' }, decisions: [{ name: 'D', rules: [{ name: 'R', conditionLogic: '1 AND (2 OR 3)',
      conditions: [cond('$Record.Region__c', 'EU'), cond('$Record.Name', 'x'), cond('$Record.Type', 'y')] }] }] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(0);
    expect(FX._flowLeftWhy(FX.removeFieldRefs.lastLeft)).toMatch(/outcome "R" of the decision "D", whose numbered condition logic/);
  });
  it('flow ✂: a formula that is not rewritten is named; one that is rewritten is not', () => {
    const m = { start: { object: 'Account' }, formulas: [{ name: 'Label_F', dataType: 'String', expression: '{!$Record.Region__c} & "x"' }] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(0);
    const why = FX._flowLeftWhy(FX.removeFieldRefs.lastLeft);
    expect(why).toMatch(/the formula "Label_F" names the field/);
    expect(why).not.toMatch(/a variable default, a text template/);
  });
  it('flow ✂: a Record Update on a Contact variable keeps Contact’s Region__c', () => {
    const m = { variables: [{ name: 'con', dataType: 'SObject', objectType: 'Contact' }],
      recordUpdates: [{ name: 'U', inputReference: 'con', inputAssignments: [{ field: 'Region__c' }, { field: 'Name' }] }] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(0);
    expect(m.recordUpdates[0].inputAssignments).toHaveLength(2);
    expect(FX.removeFieldRefs(m, 'Contact', 'Region__c')).toBe(1);
    expect(m.recordUpdates[0].inputAssignments).toEqual([{ field: 'Name' }]);
  });
  it('flow ✂: a Record Create on $Record follows the trigger object; on an unresolvable variable it is left and named', () => {
    const own = { start: { object: 'Account' }, recordCreates: [{ name: 'C', inputReference: '$Record', inputAssignments: [{ field: 'Region__c' }, { field: 'Name' }] }] };
    expect(FX.removeFieldRefs(own, 'Account', 'Region__c')).toBe(1);
    const m = { recordUpdates: [{ name: 'U', label: 'Update thing', inputReference: 'mystery', inputAssignments: [{ field: 'Region__c' }, { field: 'Name' }] }] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(0);
    expect(m.recordUpdates[0].inputAssignments).toHaveLength(2);
    expect(FX._flowLeftWhy(FX.removeFieldRefs.lastLeft)).toMatch(/"Update thing" works on a record variable whose object cannot be told/);
  });
});

// review 4 (2026-11-14), sftk-mdapi.js round 2: a report type's lookup column follows a standard hop to the object it is
// named for and Parent to the object it is on; a QuickAction's layout / predefined values are its target object's fields;
// a field update's target and an approval process's page fields / approver are the host object's fields.
describe('review 4 (2026-11-14)', () => {
  const R5 = new Function(`${read('sftk-mdapi.js')}\nreturn { sftkMdEditField, sftkRtMentions, sftkRtRemoveField, sftkRtReplaceField };`)();
  it('ReportType on Case: Asset.Region__c / Entitlement.Region__c are those objects’ — the plain column is fixed, nothing in viaLookup', () => {
    const x = rtype('Case', [col('Region__c', 'Case'), col('Asset.Region__c', 'Case'), col('Entitlement.Region__c', 'Case')]);
    expect(R5.sftkRtMentions(x, 'Case', 'Region__c')).toBe(1);
    const rm = R5.sftkRtRemoveField(x, 'Case', 'Region__c');
    expect(rm).toMatchObject({ removed: 1, viaLookup: [], changed: true });
    expect(rm.xml).toBe(rtype('Case', [col('Asset.Region__c', 'Case'), col('Entitlement.Region__c', 'Case')]));
    expect(R5.sftkRtMentions(rm.xml, 'Case', 'Region__c')).toBe(0);
    const rp = R5.sftkRtReplaceField(x, 'Case', 'Region__c', 'Area__c');
    expect(rp).toMatchObject({ swapped: 1, viaLookup: [], changed: true });
    expect(rp.xml).toBe(rtype('Case', [col('Area__c', 'Case'), col('Asset.Region__c', 'Case'), col('Entitlement.Region__c', 'Case')]));
    // cleaning Asset.Region__c: the Asset column of the Case table is its field
    expect(R5.sftkRtMentions(x, 'Case', 'Region__c')).toBe(1);
  });
  it('ReportType: a custom lookup / What hop is still unknown', () => {
    const x = rtype('Task', [col('Region__c', 'Task'), col('What.Region__c', 'Task'), col('Thing__r.Region__c', 'Task')]);
    expect(R5.sftkRtRemoveField(x, 'Task', 'Region__c').viaLookup).toHaveLength(2);
  });
  it('ReportType on EmailMessage: Parent.Region__c is Case’s — left on ✂ / ⇄ of EmailMessage.Region__c, not counted', () => {
    const x = rtype('EmailMessage', [col('Region__c', 'EmailMessage'), col('Parent.Region__c', 'EmailMessage')]);
    expect(R5.sftkRtMentions(x, 'EmailMessage', 'Region__c')).toBe(1);
    const rm = R5.sftkRtRemoveField(x, 'EmailMessage', 'Region__c');
    expect(rm).toMatchObject({ removed: 1, viaLookup: [] });
    expect(rm.xml).toBe(rtype('EmailMessage', [col('Parent.Region__c', 'EmailMessage')]));
    const rp = R5.sftkRtReplaceField(x, 'EmailMessage', 'Region__c', 'Area__c');
    expect(rp.xml).toBe(rtype('EmailMessage', [col('Area__c', 'EmailMessage'), col('Parent.Region__c', 'EmailMessage')]));
  });
  it('ReportType on Attachment: Parent.Region__c cannot be told — never edited, named in viaLookup', () => {
    const x = rtype('Attachment', [col('Region__c', 'Attachment'), col('Parent.Region__c', 'Attachment')]);
    const rm = R5.sftkRtRemoveField(x, 'Attachment', 'Region__c');
    expect(rm.viaLookup).toEqual(['Attachment.Parent.Region__c in “S” (reached through a lookup)']);
    expect(rm.xml).toContain('<field>Parent.Region__c</field>');
  });
  const newContact = '<fullName>Account.NewContact</fullName><fieldOverrides><field>Region__c</field><literalValue>EU</literalValue></fieldOverrides><label>New Contact</label><quickActionLayout><quickActionLayoutColumns><quickActionLayoutItems><field>LastName</field></quickActionLayoutItems><quickActionLayoutItems><field>Region__c</field></quickActionLayoutItems></quickActionLayoutColumns></quickActionLayout><targetObject>Contact</targetObject><targetParentField>Account</targetParentField><type>Create</type>';
  it('QuickAction Account.NewContact (Create Contact): ✂ / ⇄ Account.Region__c leave Contact’s Region__c, refused with the true reason', () => {
    for (const nf of [null, 'Area__c']) {
      const r = R5.sftkMdEditField('QuickAction', newContact, 'Account', 'Region__c', nf);
      expect(r.xml).toBe(newContact);
      expect(r.refused).toMatch(/works on a Contact record: its layout and predefined values hold Contact’s fields/);
    }
  });
  it('QuickAction Account.NewContact: ⇄ Contact.Region__c renames the layout field and the predefined value', () => {
    const r = R5.sftkMdEditField('QuickAction', newContact, 'Contact', 'Region__c', 'Area__c');
    expect(r.refused).toBeNull();
    expect(r.how).toEqual(['1 layout field now Area__c, 1 predefined value now Area__c']);
    expect(r.xml).not.toMatch(/Region__c/);
  });
  it('QuickAction Account.NewContact: a predefined formula Account.Region__c is still Account’s and swapped', () => {
    const x = '<fullName>Account.NewContact</fullName><fieldOverrides><field>Description</field><formula>Account.Region__c</formula></fieldOverrides><quickActionLayout><quickActionLayoutColumns><quickActionLayoutItems><field>Region__c</field></quickActionLayoutItems></quickActionLayoutColumns></quickActionLayout><targetObject>Contact</targetObject><type>Create</type>';
    const r = R5.sftkMdEditField('QuickAction', x, 'Account', 'Region__c', 'Area__c');
    expect(r.how).toEqual(['1 formula reference now Area__c']);
    expect(r.xml).toContain('<quickActionLayoutItems><field>Region__c</field></quickActionLayoutItems>');
  });
  it('QuickAction with no object known (no <fullName>, no <targetObject>): left alone and said so', () => {
    const x = '<quickActionLayout><quickActionLayoutColumns><quickActionLayoutItems><field>Region__c</field></quickActionLayoutItems></quickActionLayoutColumns></quickActionLayout>';
    const r = R5.sftkMdEditField('QuickAction', x, 'Contact', 'Region__c', 'Area__c');
    expect(r.xml).toBe(x);
    expect(r.refused).toMatch(/object the action works on is not known here/);
  });
  it('WorkflowFieldUpdate Account.Upd: ⇄ User.Region__c renames Owner.Region__c only — the target is Account’s', () => {
    const x = '<fullName>Account.Upd</fullName><field>Region__c</field><formula>Owner.Region__c</formula><operation>Formula</operation>';
    const r = R5.sftkMdEditField('WorkflowFieldUpdate', x, 'User', 'Region__c', 'Area__c');
    expect(r.refused).toBeNull();
    expect(r.xml).toBe(x.replace('Owner.Region__c', 'Owner.Area__c'));
    expect(r.how).toEqual(['formula: 1 reference now Area__c']);
    // only the target, on another object: refused, nothing written
    const t = '<fullName>Account.Upd2</fullName><field>Region__c</field><literalValue>EU</literalValue><operation>Literal</operation>';
    const q = R5.sftkMdEditField('WorkflowFieldUpdate', t, 'User', 'Region__c', 'Area__c');
    expect(q.xml).toBe(t);
    expect(q.refused).toMatch(/neither its target nor its formula names the field/);
  });
  it('WorkflowFieldUpdate cross-object (Contact update, <targetObject>AccountId</targetObject>): the target is Account’s', () => {
    const x = '<fullName>Contact.Up</fullName><field>Region__c</field><literalValue>EU</literalValue><operation>Literal</operation><targetObject>AccountId</targetObject>';
    const a = R5.sftkMdEditField('WorkflowFieldUpdate', x, 'Account', 'Region__c', 'Area__c');
    expect(a.how).toEqual(['target field now Area__c']);
    const c = R5.sftkMdEditField('WorkflowFieldUpdate', x, 'Contact', 'Region__c', 'Area__c');
    expect(c.xml).toBe(x);
    expect(c.refused).toMatch(/the target is account’s same-named field/);
    // a custom lookup does not tell its object: refused with that reason, nothing written
    const y = x.replace('AccountId', 'Partner__c');
    const u = R5.sftkMdEditField('WorkflowFieldUpdate', y, 'Account', 'Region__c', 'Area__c');
    expect(u.xml).toBe(y);
    expect(u.refused).toMatch(/object cannot be told here/);
  });
  it('ApprovalProcess Account.AP: ⇄ User.Region__c renames $User.Region__c only — the page field and the approver are Account’s', () => {
    const x = '<fullName>Account.AP</fullName><approvalPageFields><field>Name</field><field>Region__c</field></approvalPageFields><approvalStep><assignedApprover><approver><name>Region__c</name><type>relatedUserField</type></approver></assignedApprover><name>S1</name></approvalStep><entryCriteria><formula>$User.Region__c = &quot;EU&quot;</formula></entryCriteria>';
    const r = R5.sftkMdEditField('ApprovalProcess', x, 'User', 'Region__c', 'Area__c');
    expect(r.refused).toBeNull();
    expect(r.xml).toBe(x.replace('$User.Region__c', '$User.Area__c'));
    expect(r.how).toEqual(['criteria and page fields: 1 reference now Area__c']);
    // ✂ User.Region__c: the Account approver is not this field, so it is no reason to refuse
    const c = R5.sftkMdEditField('ApprovalProcess', x, 'User', 'Region__c', null);
    expect(c.refused).not.toMatch(/approver/);
  });
});

// review 4 (2026-11-14), field-cleaner.js round 2: flow / FlexiPage ✂ follow a standard lookup missing from the map
// (Asset, Entitlement…) to the object it is named for, and give each untellable mention its true reason; a flow
// formula is cut, and named in the refusal, only for mentions of THIS object's field.
describe('review 4 (2026-11-14)', () => {
  const cond = (l, v) => ({ leftValueReference: l, operator: 'EqualTo', rightValue: { stringValue: v } });
  it('flow ✂ Entitlement.Region__c: $Record.Entitlement.Region__c in a Case flow is that field — the condition goes', () => {
    const m = { start: { object: 'Case' }, decisions: [{ name: 'D', rules: [{ name: 'R', conditionLogic: 'and',
      conditions: [cond('$Record.Entitlement.Region__c', 'EU'), cond('$Record.Status', 'New')] }] }] };
    expect(FX.removeFieldRefs(m, 'Entitlement', 'Region__c')).toBe(1);
    expect(m.decisions[0].rules[0].conditions.map(c => c.leftValueReference)).toEqual(['$Record.Status']);
    expect(FX.removeFieldRefs.lastLeft.unknown).toEqual([]);
  });
  it('flow ✂ Asset.Region__c: an assignment from $Record.Asset.Region__c goes; on ✂ Case.Region__c it is another object’s', () => {
    const mk = () => ({ start: { object: 'Case' }, assignments: [{ name: 'a', assignmentItems: [{ assignToReference: 'v', operator: 'Assign', value: { elementReference: '$Record.Asset.Region__c' } }] }] });
    const m = mk();
    expect(FX.removeFieldRefs(m, 'Asset', 'Region__c')).toBe(1);
    expect(m.assignments[0].assignmentItems).toHaveLength(0);
    const k = mk();
    expect(FX.removeFieldRefs(k, 'Case', 'Region__c')).toBe(0);
    expect(k.assignments[0].assignmentItems).toHaveLength(1);
    expect(FX._flowLeftWhy(FX.removeFieldRefs.lastLeft)).toMatch(/\$Record\.Asset\.Region__c is another object's same-named field/);
    expect(FX._flowLeftWhy(FX.removeFieldRefs.lastLeft)).not.toMatch(/custom lookup/);
  });
  it('flow ✂: a What hop and an unresolved resource are untellable with their own reason, never "a custom lookup"', () => {
    const item = ref => ({ assignToReference: 'v', operator: 'Assign', value: { elementReference: ref } });
    const m = { start: { object: 'Task' }, assignments: [{ name: 'a', assignmentItems: [item('$Record.What.Region__c'), item('mystery.Account.Region__c')] }] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(0);
    expect(m.assignments[0].assignmentItems).toHaveLength(2);
    const why = FX._flowLeftWhy(FX.removeFieldRefs.lastLeft);
    expect(why).toMatch(/\$Record\.What\.Region__c reaches the field through a What \/ Who/);
    expect(why).toMatch(/mystery\.Account\.Region__c reaches the field from a resource whose object the flow does not tell/);
    expect(why).not.toMatch(/custom lookup/);
  });
  it('flow ✂ Account.Region__c: a Boolean formula keeps {!con.Region__c} (a Contact variable) — nothing of Contact’s is cut', () => {
    const m = { start: { object: 'Account' }, variables: [{ name: 'con', dataType: 'SObject', objectType: 'Contact' }],
      formulas: [{ name: 'F', dataType: 'Boolean', expression: 'AND({!con.Region__c} = "EU", {!$Record.Name} = "x")' }],
      recordUpdates: [{ name: 'U', object: 'Account', inputAssignments: [{ field: 'Region__c' }, { field: 'Name' }] }] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(1);   // the Account update only
    expect(m.formulas[0].expression).toBe('AND({!con.Region__c} = "EU", {!$Record.Name} = "x")');
    // the same formula naming $Record.Region__c too: only Account's condition goes
    const b = { start: { object: 'Account' }, variables: [{ name: 'con', dataType: 'SObject', objectType: 'Contact' }],
      formulas: [{ name: 'F', dataType: 'Boolean', expression: 'AND({!con.Region__c} = "EU", {!$Record.Region__c} = "x")' }] };
    expect(FX.removeFieldRefs(b, 'Account', 'Region__c')).toBe(1);
    expect(b.formulas[0].expression).toMatch(/\{!con\.Region__c\}/);
    expect(b.formulas[0].expression).not.toMatch(/\$Record\.Region__c/);
  });
  it('flow ✂: a formula holding only another object’s field is not named as one that names the field', () => {
    const m = { start: { object: 'Account' }, variables: [{ name: 'con', dataType: 'SObject', objectType: 'Contact' }],
      formulas: [{ name: 'T', dataType: 'String', expression: '{!con.Region__c}' }],
      decisions: [{ name: 'D', rules: [{ name: 'R', conditionLogic: 'and', conditions: [cond('$Record.Region__c', 'EU')] }] }] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(0);
    const why = FX._flowLeftWhy(FX.removeFieldRefs.lastLeft);
    expect(why).not.toMatch(/the formula "T"/);
    expect(why).toMatch(/con\.Region__c is another object's same-named field/);
    expect(why).toMatch(/only condition of the outcome "R"/);
  });
  it('FlexiPage ✂ Asset.Region__c: {!Record.Asset.Region__c} is that field — the criterion goes, nothing tallied unknown', () => {
    const md = fxPage(fxRich([fxCrit('{!Record.Asset.Region__c}'), fxCrit('{!Record.Status}')]));
    const out = {};
    expect(FX.removeFieldFromFlexiPage(md, 'Asset', 'Region__c', out)).toBe(1);
    expect(out.unknown).toBe(0);
    expect(critsOf(md).map(c => c.leftValue)).toEqual(['{!Record.Status}']);
    const k = fxPage(fxRich([fxCrit('{!Record.Asset.Region__c}'), fxCrit('{!Record.Status}')])), o2 = {};
    expect(FX.removeFieldFromFlexiPage(k, 'Case', 'Region__c', o2)).toBe(0);
    expect(o2).toMatchObject({ other: 1, unknown: 0 });
  });
  it('FlexiPage ✂: untellable mentions are counted by their kind, and the fix text has a true reason for each', () => {
    const md = fxPage(fxRich([fxCrit('{!Record.Thing__r.Region__c}'), fxCrit('{!Record.What.Region__c}'), fxCrit('{!Record.Status}')]));
    const out = {};
    expect(FX.removeFieldFromFlexiPage(md, 'Account', 'Region__c', out)).toBe(0);
    expect(out).toMatchObject({ unknown: 2, unknownKinds: { custom: 1, poly: 1 } });
    expect(FCJ).toContain('through a What / Who or a Parent that can be any object left alone');
    expect(FCJ).not.toContain("reach the field through a custom lookup — which object's field that is cannot be told from the page");
  });
});

// review 4 (2026-11-14), field-cleaner.js round 3: a flow formula's {!merge field} is read whole — a resource whose
// name starts with 's' keeps its first letter, and spaces inside the braces are allowed.
describe('review 4 (2026-11-14)', () => {
  it('flow ✂ Account.Region__c: {!selectedCon.Region__c} (a Contact variable) is kept; nothing of Contact’s is cut', () => {
    const m = { start: { object: 'Account' }, variables: [{ name: 'selectedCon', dataType: 'SObject', objectType: 'Contact' }],
      formulas: [{ name: 'F', dataType: 'Boolean', expression: 'AND({!selectedCon.Region__c} = "EU", {!$Record.Name} = "x")' }] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(0);
    expect(m.formulas[0].expression).toBe('AND({!selectedCon.Region__c} = "EU", {!$Record.Name} = "x")');
    const why = FX._flowLeftWhy(FX.removeFieldRefs.lastLeft);
    expect(why).toMatch(/selectedCon\.Region__c is another object's same-named field/);
    expect(why).not.toMatch(/(^|[^s])electedCon/);
  });
  it('flow ✂ Account.Region__c: {!sAcc.Region__c} (an Account variable) is this field — the condition goes', () => {
    const m = { start: { object: 'Account' }, variables: [{ name: 'sAcc', dataType: 'SObject', objectType: 'Account' },
      { name: 'Acc', dataType: 'SObject', objectType: 'Contact' }],
      formulas: [{ name: 'F', dataType: 'Boolean', expression: 'AND({!sAcc.Region__c} = "EU", {!$Record.IsActive__c})' }] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(1);
    expect(m.formulas[0].expression).not.toMatch(/Region__c/);
    expect(m.formulas[0].expression).toMatch(/\{!\$Record\.IsActive__c\}/);
  });
  it('flow ✂ Account.Region__c: {!selectedAcc.Parent.Region__c} (Account → Parent Account) is this field — it goes', () => {
    const m = { start: { object: 'Account' }, variables: [{ name: 'selectedAcc', dataType: 'SObject', objectType: 'Account' }],
      formulas: [{ name: 'F', dataType: 'Boolean', expression: 'AND({!selectedAcc.Parent.Region__c} = "EU", {!$Record.IsActive__c})' }] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(1);
    expect(m.formulas[0].expression).not.toMatch(/Region__c/);
  });
  it('flow ✂ Account.Region__c: {! $Record.Region__c } with spaces is read — the condition goes', () => {
    const m = { start: { object: 'Account' },
      formulas: [{ name: 'F', dataType: 'Boolean', expression: '{! $Record.Region__c } = "EU" && {!$Record.IsActive__c}' }] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(1);
    expect(m.formulas[0].expression).not.toMatch(/Region__c/);
    expect(m.formulas[0].expression).toMatch(/\{!\$Record\.IsActive__c\}/);
  });
});

// review 4 (2026-11-14), sftk-mdapi.js round 3: a field update's <targetObject>ParentId</targetObject> follows the
// Parent map — Case on EmailMessage / CaseComment, cannot be told on Attachment / Note…, the own object elsewhere.
describe('review 4 (2026-11-14)', () => {
  const R6 = new Function(`${read('sftk-mdapi.js')}\nreturn { sftkMdEditField };`)();
  const x = '<fullName>EmailMessage.SetCaseRegion</fullName><field>Region__c</field><literalValue>EU</literalValue><operation>Literal</operation><targetObject>ParentId</targetObject>';
  it('EmailMessage update on ParentId: ⇄ Case.Region__c renames the target (it is Case’s field)', () => {
    const r = R6.sftkMdEditField('WorkflowFieldUpdate', x, 'Case', 'Region__c', 'Area__c');
    expect(r.refused).toBeNull();
    expect(r.xml).toBe(x.replace('<field>Region__c</field>', '<field>Area__c</field>'));
    expect(r.how).toEqual(['target field now Area__c']);
  });
  it('EmailMessage update on ParentId: ✂ Case.Region__c refuses because the update WRITES the field — not a false “other object” reason', () => {
    const r = R6.sftkMdEditField('WorkflowFieldUpdate', x, 'Case', 'Region__c', null);
    expect(r.xml).toBe(x);
    expect(r.refused).toMatch(/WRITES to this field/);
  });
  it('EmailMessage update on ParentId: ⇄ EmailMessage.Region__c leaves Case’s target alone and says so', () => {
    const r = R6.sftkMdEditField('WorkflowFieldUpdate', x, 'EmailMessage', 'Region__c', 'Area__c');
    expect(r.xml).toBe(x);
    expect(r.refused).toMatch(/the target is case’s same-named field/);
  });
  it('CaseComment update on ParentId is Case’s too; an Account update on ParentId stays Account’s', () => {
    const c = x.replace('EmailMessage.SetCaseRegion', 'CaseComment.SetCaseRegion');
    expect(R6.sftkMdEditField('WorkflowFieldUpdate', c, 'Case', 'Region__c', 'Area__c').how).toEqual(['target field now Area__c']);
    const a = x.replace('EmailMessage.SetCaseRegion', 'Account.SetParentRegion');
    expect(R6.sftkMdEditField('WorkflowFieldUpdate', a, 'Account', 'Region__c', 'Area__c').how).toEqual(['target field now Area__c']);
  });
});
