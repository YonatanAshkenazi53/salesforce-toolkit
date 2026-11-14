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
    const r = M.sftkMdEditField('ValidationRule', vr('ISBLANK(Region__c) &amp;&amp; Parent.Region__c = "x"'), 'Account', 'Region__c', 'Area__c');
    expect(r.refused).toBeNull();
    expect(r.xml).toBe(vr('ISBLANK(Area__c) &amp;&amp; Parent.Area__c = "x"'));
  });
  it('a custom lookup path (Thing__r.Region__c) is still refused whole, with the true reason', () => {
    const x = vr('ISBLANK(Region__c) &amp;&amp; Thing__r.Region__c = "x"');
    const r = M.sftkMdEditField('ValidationRule', x, 'Account', 'Region__c', 'Area__c');
    expect(r.refused).toMatch(/custom lookup/);
    expect(r.xml).toBe(x);
  });
});

describe('QuickAction — a predefined value copying the parent’s same-named field is not this field', () => {
  const layout = '<quickActionLayout><quickActionLayoutColumns><quickActionLayoutItems><field>Region__c</field></quickActionLayoutItems></quickActionLayoutColumns></quickActionLayout>';
  it('⇄ Contact.Region__c: the layout field and the predefined value’s target move, the formula Account.Region__c stays', () => {
    const x = `<fieldOverrides><field>Region__c</field><formula>Account.Region__c</formula></fieldOverrides>${layout}`;
    const r = M.sftkMdEditField('QuickAction', x, 'Contact', 'Region__c', 'Area__c');
    expect(r.refused).toBeNull();
    expect(r.how).toEqual(['1 layout field now Area__c, 1 predefined value now Area__c']);
    expect(r.xml).toContain('<formula>Account.Region__c</formula>');
  });
  it('✂ Contact.Region__c with another field’s value computed from Account.Region__c: the layout field is removed', () => {
    const x = `<fieldOverrides><field>Description</field><formula>Account.Region__c</formula></fieldOverrides>${layout}`;
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
