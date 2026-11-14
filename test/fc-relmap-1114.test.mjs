// sftk-relmap.js — the ONE relationship-hop resolver (2026-11-14). The "which object does this hop lead to" walk lived
// in five+ private copies (sftk-mdapi.js report types / formulas / field-update target, sftk-emailtpl.js, field-cleaner.js
// flows and Lightning pages) that drifted apart; six review rounds of findings were one copy lacking what another had.
// This file pins: the resolver itself (the UNION of what the copies knew), that every copy now asks it (no private map
// is left), that the page loads it first, and the places where a copy gained knowledge another copy already had.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
// the resolver loaded from its own file, alone — not the copy test/setup-relmap.mjs put on globalThis
const RM = new Function(`${read('sftk-relmap.js')}\nreturn { sftkRelHop, sftkRelLookupField, sftkRelWalk, sftkRelGlobal };`)();
const { sftkRelHop: hop, sftkRelLookupField: lookup, sftkRelWalk: walk, sftkRelGlobal: glob } = RM;

describe('sftkRelHop — one hop', () => {
  it('the standard relationships whose object is fixed (the union of every copy)', () => {
    const want = {
      Owner: 'user', CreatedBy: 'user', LastModifiedBy: 'user', Manager: 'user', DelegatedApprover: 'user', User: 'user',
      CompanySigned: 'user', ActivatedBy: 'user',
      Account: 'account', ConvertedAccount: 'account', PartnerAccount: 'account',
      Contact: 'contact', ConvertedContact: 'contact', ReportsTo: 'contact', CustomerSigned: 'contact',
      BillToContact: 'contact', ShipToContact: 'contact',
      Opportunity: 'opportunity', ConvertedOpportunity: 'opportunity', Lead: 'lead', Case: 'case', Campaign: 'campaign',
      Contract: 'contract', Order: 'order', Product2: 'product2', Pricebook2: 'pricebook2', RecordType: 'recordtype',
      Profile: 'profile', UserRole: 'userrole', Queue: 'group', Asset: 'asset', Quote: 'quote',
    };
    for (const [h, o] of Object.entries(want)) expect(hop('account', h), h).toEqual({ obj: o });
  });
  it('any other standard hop is a lookup named for its object (Entitlement, Individual, PricebookEntry…)', () => {
    for (const h of ['Entitlement', 'Individual', 'PricebookEntry', 'ServiceContract', 'WorkOrder', 'GiftCommitment', 'Territory2'])
      expect(hop('case', h)).toEqual({ obj: h.toLowerCase() });
  });
  it('a typed polymorphic hop names its type: Owner:User → User, Owner:Group → Group', () => {
    expect(hop('case', 'Owner:User')).toEqual({ obj: 'user' });
    expect(hop(null, 'Owner:Group')).toEqual({ obj: 'group' });
  });
  it('Parent / MasterRecord: the same object on most', () => {
    for (const o of ['account', 'case', 'campaign', 'contact']) {
      expect(hop(o, 'Parent')).toEqual({ obj: o });
      expect(hop(o, 'MasterRecord')).toEqual({ obj: o });
    }
  });
  it('Parent on CaseComment / EmailMessage is Case', () => {
    expect(hop('casecomment', 'Parent')).toEqual({ obj: 'case' });
    expect(hop('EmailMessage', 'parent')).toEqual({ obj: 'case' });
    expect(hop('emailmessage', 'MasterRecord')).toEqual({ obj: 'emailmessage' });   // only Parent is special
  });
  it('Parent on Attachment / Note / FeedItem / FeedComment / EntitySubscription / ContentDocumentLink cannot be told: poly', () => {
    for (const o of ['attachment', 'note', 'feeditem', 'feedcomment', 'entitysubscription', 'contentdocumentlink'])
      expect(hop(o, 'Parent')).toEqual({ obj: null, kind: 'poly' });
  });
  it('Parent / MasterRecord with no known object: host', () => {
    expect(hop(null, 'Parent')).toEqual({ obj: null, kind: 'host' });
    expect(hop('', 'MasterRecord')).toEqual({ obj: null, kind: 'host' });
  });
  it('a custom relationship cannot be told: custom; What / Who: poly', () => {
    expect(hop('account', 'Region_Owner__r')).toEqual({ obj: null, kind: 'custom' });
    expect(hop('task', 'What')).toEqual({ obj: null, kind: 'poly' });
    expect(hop('task', 'who')).toEqual({ obj: null, kind: 'poly' });
  });
});

describe('sftkRelWalk / sftkRelLookupField / sftkRelGlobal', () => {
  it('walks a path and stops at the first hop that cannot be told', () => {
    expect(walk('contact', ['Account', 'Owner', 'Manager'])).toEqual({ obj: 'user' });
    expect(walk('emailmessage', ['Parent', 'Account'])).toEqual({ obj: 'account' });
    expect(walk('account', ['Parent', 'Thing__r', 'Owner'])).toEqual({ obj: null, kind: 'custom' });
    expect(walk('account', [])).toEqual({ obj: 'account' });
  });
  it('a lookup ID field reaches what its hop reaches; a custom lookup field cannot be told', () => {
    expect(lookup('account', 'OwnerId')).toEqual({ obj: 'user' });
    expect(lookup('contact', 'ReportsToId')).toEqual({ obj: 'contact' });
    expect(lookup('lead', 'ConvertedAccountId')).toEqual({ obj: 'account' });
    expect(lookup('emailmessage', 'ParentId')).toEqual({ obj: 'case' });
    expect(lookup('account', 'ParentId')).toEqual({ obj: 'account' });
    expect(lookup(null, 'ParentId')).toEqual({ obj: null, kind: 'host' });
    expect(lookup('note', 'ParentId')).toEqual({ obj: null, kind: 'poly' });
    expect(lookup('task', 'WhatId')).toEqual({ obj: null, kind: 'poly' });
    expect(lookup('account', 'Region_Owner__c')).toEqual({ obj: null, kind: 'custom' });
  });
  it('the $ roots', () => {
    expect(glob(['$user'])).toEqual({ obj: 'user', from: 1 });
    expect(glob(['$Profile', 'x'])).toEqual({ obj: 'profile', from: 1 });
    expect(glob(['$userrole'])).toEqual({ obj: 'userrole', from: 1 });
    expect(glob(['$organization'])).toEqual({ obj: 'organization', from: 1 });
    expect(glob(['$setup', 'my_settings__c'])).toEqual({ obj: 'my_settings__c', from: 2 });
    expect(glob(['$setup'])).toEqual({ obj: null, global: '$setup' });
    expect(glob(['$objecttype', 'account', 'fields'])).toEqual({ obj: 'account', from: 3 });
    expect(glob(['$objecttype', 'account'])).toEqual({ obj: null, global: '$objecttype' });
    expect(glob(['$label'])).toEqual({ obj: null, global: '$label' });
    expect(glob(['record'])).toBeNull();
    expect(glob([])).toBeNull();
  });
  it('test/setup-relmap.mjs puts the same resolver on globalThis, as popup.html does for the page', () => {
    expect(typeof globalThis.sftkRelHop).toBe('function');
    expect(globalThis.sftkRelHop('emailmessage', 'Parent')).toEqual(hop('emailmessage', 'Parent'));
  });
});

describe('one resolver: no private copy is left', () => {
  const FILES = ['sftk-mdapi.js', 'sftk-emailtpl.js', 'field-cleaner.js'];
  it.each(FILES)('%s keeps no relationship map of its own', f => {
    const src = read(f);
    // a REL / PARENT / LKREL / PARENTOF / SAME map, or the map's tell-tale entries
    expect(src).not.toMatch(/\bconst\s+(?:REL|PARENT|PARENTOF|LKREL|SAME)\s*=/);
    expect(src).not.toMatch(/convertedaccount\s*:\s*'account'/);
    expect(src).not.toMatch(/casecomment\s*:\s*'case'/);
    expect(src).not.toMatch(/delegatedapprover\s*:\s*'user'/);
    expect(src).not.toMatch(/\$userrole\s*:\s*'userrole'/);
    expect(src).toMatch(/\bsftkRel(?:Hop|Walk|Global|LookupField)\(/);
  });
  it('popup.html loads sftk-relmap.js before every file that asks it; no other page loads those files', () => {
    const popup = read('popup.html');
    const at = f => popup.indexOf(`<script src="${f}"></script>`);
    expect(at('sftk-relmap.js')).toBeGreaterThan(0);
    for (const f of FILES) expect(at(f)).toBeGreaterThan(at('sftk-relmap.js'));
    for (const page of ['studio.html', 'apex-log-viewer.html'])
      for (const f of FILES) expect(read(page)).not.toContain(`src="${f}"`);
  });
  it('the packer ships every root .js not excluded — sftk-relmap.js is not excluded', () => {
    expect(read('scripts/pack_store.py')).not.toContain('sftk-relmap');
  });
});

// ── where a copy gained knowledge another copy had ─────────────────────────────────────────────────────────────
const M = extractFunctions('sftk-mdapi.js', ['_sftkMdSwapToken', 'sftkMdEditField', 'sftkFormulaDropField', '_sftkMdFieldIs', '_sftkMdRenameVal',
  '_sftkMdWalk', '_sftkMdHasLogic', 'sftkMdFindElement', 'sftkMdChildText', 'sftkMdUnescape', 'sftkMdEscape']);

describe('formulas (_sftkMdSwapToken): a hop after a global is followed, as the email templates did', () => {
  it('$User.Manager.Region__c is User’s field: swapped for User, left alone for Account', () => {
    const t = 'ISBLANK($User.Manager.Region__c)';
    expect(M._sftkMdSwapToken(t, 'User', 'Region__c', 'Territory__c', 'Account')).toMatchObject({ text: 'ISBLANK($User.Manager.Territory__c)', n: 1, rel: 0 });
    expect(M._sftkMdSwapToken(t, 'Account', 'Region__c', 'Territory__c', 'Account')).toMatchObject({ text: t, n: 0, rel: 0 });
  });
  it('$Setup.Obj.Owner.X is User’s; a custom hop after a global cannot be told', () => {
    expect(M._sftkMdSwapToken('$Setup.Cfg__c.Owner.Region__c', 'User', 'Region__c', 'T__c', 'Account').n).toBe(1);
    expect(M._sftkMdSwapToken('$User.Boss__r.Region__c', 'User', 'Region__c', 'T__c', 'Account')).toMatchObject({ n: 0, rel: 1, kind: 'custom' });
  });
  it('unchanged: the bare globals', () => {
    expect(M._sftkMdSwapToken('$User.Region__c', 'User', 'Region__c', 'T__c', 'Account').n).toBe(1);
    expect(M._sftkMdSwapToken('$Setup.Cfg__c.Region__c', 'Cfg__c', 'Region__c', 'T__c', 'Account').n).toBe(1);
    expect(M._sftkMdSwapToken('$ObjectType.Account.Fields.Region__c', 'Account', 'Region__c', 'T__c', 'Case').n).toBe(1);
    expect(M._sftkMdSwapToken('$Label.Region__c', 'Account', 'Region__c', 'T__c', 'Account').n).toBe(0);
  });
});

describe('WorkflowFieldUpdate: the <targetObject> lookup is read with the shared map', () => {
  const fu = (host, target) => `<fullName>${host}.SFTK_FU</fullName><field>Region__c</field><literalValue>EMEA</literalValue><name>SFTK FU</name><notifyAssignee>false</notifyAssignee><operation>Literal</operation><protected>false</protected><reevaluateOnChange>true</reevaluateOnChange><targetObject>${target}</targetObject>`;
  it('ReportsToId on Contact writes Contact’s field (it was taken for an object "reportsto")', () => {
    const r = M.sftkMdEditField('WorkflowFieldUpdate', fu('Contact', 'ReportsToId'), 'Contact', 'Region__c', 'Territory__c');
    expect(r.refused).toBeFalsy();
    expect(r.xml).toContain('<field>Territory__c</field>');
  });
  it('ConvertedAccountId writes Account’s field', () => {
    const r = M.sftkMdEditField('WorkflowFieldUpdate', fu('Lead', 'ConvertedAccountId'), 'Account', 'Region__c', 'Territory__c');
    expect(r.refused).toBeFalsy();
    expect(r.xml).toContain('<field>Territory__c</field>');
  });
  it('WhatId cannot be told — refused with that reason, never renamed (it was taken for an object "what")', () => {
    const r = M.sftkMdEditField('WorkflowFieldUpdate', fu('Task', 'WhatId'), 'Account', 'Region__c', 'Territory__c');
    expect(r.refused).toMatch(/cannot be told/);
    expect(r.refused).toMatch(/WhatId|whatid/i);
    expect(r.refused).toMatch(/any object/);
  });
  it('a custom lookup is refused as a custom lookup; ParentId on an EmailMessage update still writes Case', () => {
    const c = M.sftkMdEditField('WorkflowFieldUpdate', fu('Account', 'Region_Owner__c'), 'Account', 'Region__c', 'Territory__c');
    expect(c.refused).toMatch(/custom lookup/);
    const p = M.sftkMdEditField('WorkflowFieldUpdate', fu('EmailMessage', 'ParentId'), 'Case', 'Region__c', 'Territory__c');
    expect(p.refused).toBeFalsy();
    expect(p.xml).toContain('<field>Territory__c</field>');
  });
});

// field-cleaner.js keeps its functions inside one closure (two-space indent, closing at "\n  }\n")
const FC = read('field-cleaner.js');
const nested = name => {
  const m = new RegExp(`^  (?:async )?function ${name}\\(`, 'm').exec(FC);
  if (!m) throw new Error(`${name} not found in field-cleaner.js`);
  return FC.slice(m.index, FC.indexOf('\n  }\n', m.index) + 4);
};
const LP = new Function(`${nested('removeFieldFromFlexiPage')}\nreturn { removeFieldFromFlexiPage };`)();

describe('Lightning pages (removeFieldFromFlexiPage): the globals and hops the formulas knew', () => {
  // the page's object is its <sobjectType> (review 5, 2026-11-14: the remover reads it instead of assuming the one cleaned)
  const page = (criteria, sobjectType = 'Account') => ({ sobjectType, flexiPageRegions: [{ name: 'main', componentInstances: [
    { componentName: 'flexipage:richText', visibilityRule: { criteria: [{ leftValue: '{!Record.Name}', operator: 'NE', rightValue: 'x' }, ...criteria] } },
  ] }] });
  const run = (crit, obj = 'Account', pageObj = 'Account') => { const out = {}; const md = page(crit, pageObj); const n = LP.removeFieldFromFlexiPage(md, obj, 'Region__c', out); return { n, out, md }; };
  it('{!$Profile.Region__c} is Profile’s field — another object’s, no longer "cannot be told"', () => {
    const r = run([{ leftValue: '{!$Profile.Region__c}', operator: 'EQUAL', rightValue: 'x' }]);
    expect(r.n).toBe(0);
    expect(r.out).toMatchObject({ other: 1, unknown: 0 });
  });
  it('{!$Profile.Region__c} on Profile’s own clean is this field', () => {
    expect(run([{ leftValue: '{!$Profile.Region__c}', operator: 'EQUAL', rightValue: 'x' }], 'Profile').n).toBe(1);
  });
  it('{!Record.CompanySigned.Region__c} is User’s (it was taken for an object "companysigned")', () => {
    expect(run([{ leftValue: '{!Record.CompanySigned.Region__c}', operator: 'EQUAL', rightValue: 'x' }], 'User', 'Contract').n).toBe(1);
  });
  it('unchanged: Parent on Account is Account; a custom lookup is still untellable', () => {
    expect(run([{ leftValue: '{!Record.Parent.Region__c}', operator: 'EQUAL', rightValue: 'x' }]).n).toBe(1);
    const c = run([{ leftValue: '{!Record.Boss__r.Region__c}', operator: 'EQUAL', rightValue: 'x' }]);
    expect(c.n).toBe(0);
    expect(c.out.unknownKinds).toEqual({ custom: 1 });
  });
});

// the flow remover, lifted the way test/fc-matrix-flows-1114 does it, with the flow-resource resolver it uses
const rmAt = FC.indexOf('  function removeFieldRefs(metadata, objApi, fieldApi, opts) {');
const RM_SRC = FC.slice(rmAt, FC.indexOf('}', FC.indexOf('    return changes;', rmAt)) + 1);
const FR = new Function(`${read('sftk-fieldreplace.js')}\nreturn { sftkFlowResourceObjects };`)();
const FLOW = new Function('deps', `const { sftkFlowResourceObjects, sftkFormulaDropField } = deps;\n${RM_SRC}\nreturn { removeFieldRefs };`)(
  { sftkFlowResourceObjects: FR.sftkFlowResourceObjects, sftkFormulaDropField: M.sftkFormulaDropField });

describe('flows (removeFieldRefs): the $ globals name their object', () => {
  const flow = refs => ({ start: { object: 'Account', triggerType: 'RecordAfterSave' },
    decisions: [{ name: 'D', rules: [{ name: 'R', conditionLogic: 'and', conditions: [
      { leftValueReference: '$Record.Name', operator: 'EqualTo', rightValue: { stringValue: 'x' } },
      ...refs.map(r => ({ leftValueReference: r, operator: 'EqualTo', rightValue: { stringValue: 'x' } })),
    ] }] }] });
  const left = md => md.decisions[0].rules[0].conditions.map(c => c.leftValueReference);
  it('$User.Region__c in an Account flow is User’s field: left alone on ✂ of Account.Region__c (it was taken for Account’s)', () => {
    const md = flow(['$User.Region__c', '$Record.Region__c']);
    FLOW.removeFieldRefs(md, 'Account', 'Region__c');
    expect(left(md)).toEqual(['$Record.Name', '$User.Region__c']);
  });
  it('$User.Region__c goes on ✂ of User.Region__c', () => {
    const md = flow(['$User.Region__c', '$Record.Region__c']);
    FLOW.removeFieldRefs(md, 'User', 'Region__c');
    expect(left(md)).toEqual(['$Record.Name', '$Record.Region__c']);
  });
  it('a hop the flow copy lacked: $Record.BillToContact.Region__c is Contact’s (it was taken for an object "billtocontact")', () => {
    const md = flow(['$Record.BillToContact.Region__c']);
    md.start.object = 'Order';
    FLOW.removeFieldRefs(md, 'Contact', 'Region__c');
    expect(left(md)).toEqual(['$Record.Name']);
  });
});
