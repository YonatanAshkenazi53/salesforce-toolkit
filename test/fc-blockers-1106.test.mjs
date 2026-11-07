// Field Cleaner's blocker table, live-tested (2026-11-06, npc: one fixture per
// reference type, each put to a destructive delete of the field — the user:
// "תעשה מבחן של כולם בorg ותראה מה קורה בכל אחד מהסוגים", then "תבדוק הכל").
// What the test found and this file pins:
//   • a Lightning page BLOCKS the delete (the table said silent);
//   • an email template does NOT (the table said blocker);
//   • blockers the dependency index never returns — workflow rules (active or
//     not), alerts, outbound messages, approval processes (active or not),
//     criteria sharing rules, duplicate rules (active or not), LWC schema
//     imports, custom metadata records, lead field mappings, Lead/Case rules —
//     now have a scan leg each, and a pure XML search behind the SOAP ones;
//   • a Process Builder process is listed as a Flow and blocks, but is never
//     rewritten by the flow fix.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const M = extractFunctions('sftk-mdapi.js', ['sftkMdChildren', 'sftkMdMentionsField', 'sftkMdLeadMappingsFor', 'sftkMdValuesHolding', 'sftkMdFindElement', 'sftkMdChildText', 'sftkMdUnescape']);

// the severity a type has in TYPE_CFG, read from the source
const sevOf = type => {
  const m = new RegExp(`^\\s*${type}:\\s*\\{[^\\n]*?sev: '(blocker|silent)'`, 'm').exec(FC);
  return m ? m[1] : null;
};

describe('the blocker table matches what Salesforce did live', () => {
  it('a Lightning page blocks; an email template does not', () => {
    expect(sevOf('FlexiPage')).toBe('blocker');
    expect(sevOf('EmailTemplate')).toBe('silent');
  });
  it('every blocker outside the dependency index has an entry that gates the delete', () => {
    for (const t of ['WorkflowRule', 'WorkflowFieldUpdate', 'WorkflowAlert', 'WorkflowOutboundMessage', 'MatchingRule', 'DuplicateRule', 'ApprovalProcess', 'SharingCriteriaRule', 'LightningComponentBundle', 'CustomMetadataRecord', 'LeadConvertSettings', 'AssignmentRule', 'AutoResponseRule', 'EscalationRule', 'ApexComponent', 'ApexPage', 'RestrictionRule', 'ProcessBuilder']) {
      expect(sevOf(t), t).toBe('blocker');
    }
  });
  it('the mentions stay mentions, and a Path is one (it stays active on a deleted field)', () => {
    for (const t of ['Layout', 'ListView', 'CompactLayout', 'QuickAction', 'Report', 'ReportType', 'PathAssistant']) expect(sevOf(t), t).toBe('silent');
  });
  it('the Lightning page leg runs in every scope, and the delete-refusal texts name the kind Salesforce named', () => {
    expect(FC).toContain('flexiPages: true,');
    expect(FC).toContain("s.match(/referenced elsewhere in salesforce\\.com\\.?\\s*:\\s*([^(]+?)\\s*(?:\\(|$)/i)");
    expect(FC).toContain('used by the following ([a-z ]+?rules)');
    expect(FC).toContain('used in at least one (Restriction Rule)');
  });
});

describe('a Process Builder process is shown, counted, never edited', () => {
  it('its versions are told apart by ProcessType and the card gets the Setup note instead of buttons', () => {
    expect(FC).toContain('SELECT Id, DefinitionId, VersionNumber, Status, ProcessType FROM Flow WHERE Id IN');
    expect(FC).toContain("pb: v.ProcessType === 'Workflow'");
    expect(FC).toContain('c.pb = c.versions.some(v => v.pb);');
    expect(FC).toContain('if (card && card.pb) return `<button class="btn btn-danger btn-sm fc-fix-btn fc-del-btn" ${attrs} data-swap="0" data-way="delete"');   // 2026-11-07: the card deletes the process as a whole
    expect(FC).toContain("<span class=\"${c.pb ? 'fc-del-pair' : 'fc-fix-pair'}\" data-id=\"${esc(id)}\" data-type=\"Flow\"");   // 2026-11-07: a Process Builder card carries 🗑 Delete process in a del-pair
    expect(FC).toContain('${c.pb ? `<div class="fc-pb-line">${_pbNoteHtml()}</div>` : \'\'}');
  });
  it('the bulk walk skips it, the delete gate counts it as a blocker by hand', () => {
    expect(FC).toContain('? _flowCards.filter(c => !c.pb).map(c => ({ id: c.primaryId, name: c.name }))');
    expect(FC).toContain('.reduce((n, [,arr]) => n + arr.length, 0) - flowExtra - pbCards;');
    expect(FC).toContain("if (pbCards) _manualBlockers.push({ type: 'ProcessBuilder'");
  });
});

describe('the XML search behind the readMetadata legs', () => {
  const sharing = `<fullName>Account</fullName>
    <sharingCriteriaRules><fullName>By_Region</fullName><accessLevel>Edit</accessLevel><label>By Region</label>
      <criteriaItems><field>Region__c</field><operation>equals</operation><value>EU</value></criteriaItems></sharingCriteriaRules>
    <sharingCriteriaRules><fullName>Other</fullName><label>Other</label>
      <criteriaItems><field>Industry</field><operation>equals</operation><value>x</value></criteriaItems></sharingCriteriaRules>
    <sharingOwnerRules><fullName>Owners</fullName><label>Owners</label></sharingOwnerRules>`;
  it('children of a container, each with its fullName', () => {
    expect(M.sftkMdChildren(sharing, 'sharingCriteriaRules').map(r => r.fullName)).toEqual(['By_Region', 'Other']);
    expect(M.sftkMdChildren(sharing, 'sharingOwnerRules').map(r => r.fullName)).toEqual(['Owners']);
    expect(M.sftkMdChildren(sharing, 'sharingGuestRules')).toEqual([]);
    expect(M.sftkMdChildren('<values><field>A</field></values><values><field>B</field></values>', 'values').map(v => v.fullName)).toEqual(['1', '2']);
  });
  it('a rule that names the field — bare, qualified, or inside a formula — and one that does not', () => {
    const rules = M.sftkMdChildren(sharing, 'sharingCriteriaRules');
    expect(M.sftkMdMentionsField(rules[0].innerXml, 'Account', 'Region__c')).toBe(true);
    expect(M.sftkMdMentionsField(rules[1].innerXml, 'Account', 'Region__c')).toBe(false);
    expect(M.sftkMdMentionsField('<criteriaItems><field>Account.Region__c</field></criteriaItems>', 'Account', 'region__c')).toBe(true);
    expect(M.sftkMdMentionsField('<formula>ISPICKVAL(Region__c, "EU") &amp;&amp; NOT(ISBLANK(Name))</formula>', 'Account', 'Region__c')).toBe(true);
    expect(M.sftkMdMentionsField('<recordFilter>Region__c = \'EU\'</recordFilter>', 'Account', 'Region__c')).toBe(true);
    // a longer name that merely contains the field's name is not the field
    expect(M.sftkMdMentionsField('<formula>Region__cx = 1</formula><field>Sub_Region__c</field>', 'Account', 'Region__c')).toBe(false);
    expect(M.sftkMdMentionsField('<fields>Id</fields><fields>Region__c</fields>', 'Account', 'Region__c')).toBe(true);   // an outbound message
    expect(M.sftkMdMentionsField('', 'Account', 'Region__c')).toBe(false);
    expect(M.sftkMdMentionsField('<field>Region__c</field>', 'Account', '')).toBe(false);
  });
  it('the lead mappings that carry the field, from either side', () => {
    const lcs = `<allowOwnerChange>true</allowOwnerChange>
      <objectMapping><inputObject>Lead</inputObject><mappingFields><inputField>Region__c</inputField><outputField>Area__c</outputField></mappingFields><mappingFields><inputField>Other__c</inputField><outputField>Other__c</outputField></mappingFields><outputObject>Account</outputObject></objectMapping>
      <objectMapping><inputObject>Lead</inputObject><mappingFields><inputField>Region__c</inputField><outputField>Region__c</outputField></mappingFields><outputObject>Contact</outputObject></objectMapping>`;
    expect(M.sftkMdLeadMappingsFor(lcs, 'Lead', 'Region__c')).toEqual([
      { inputObject: 'Lead', outputObject: 'Account', inputField: 'Region__c', outputField: 'Area__c' },
      { inputObject: 'Lead', outputObject: 'Contact', inputField: 'Region__c', outputField: 'Region__c' },
    ]);
    expect(M.sftkMdLeadMappingsFor(lcs, 'Account', 'Area__c')).toEqual([{ inputObject: 'Lead', outputObject: 'Account', inputField: 'Region__c', outputField: 'Area__c' }]);
    expect(M.sftkMdLeadMappingsFor(lcs, 'Account', 'Region__c')).toEqual([]);   // Account.Region__c is not mapped; Contact.Region__c is
    expect(M.sftkMdLeadMappingsFor(lcs, 'Contact', 'Region__c')).toHaveLength(1);
    expect(M.sftkMdLeadMappingsFor('<allowOwnerChange>true</allowOwnerChange>', 'Lead', 'Region__c')).toEqual([]);
  });
  it('a custom metadata record\'s values that hold the field, by the record\'s field name', () => {
    const rec = `<label>Ref</label><protected>false</protected>
      <values><field>Entity__c</field><value xsi:type="xsd:string">Account</value></values>
      <values><field>Field__c</field><value xsi:type="xsd:string">Account.Region__c</value></values>
      <values><field>Note__c</field><value xsi:type="xsd:string">region__c</value></values>
      <values><field>Other__c</field><value xsi:type="xsd:string">Account.Region__c_Old</value></values>
      <values><field>Empty__c</field><value xsi:nil="true"/></values>`;
    expect(M.sftkMdValuesHolding(rec, 'Account', 'Region__c')).toEqual(['Field__c', 'Note__c']);
    expect(M.sftkMdValuesHolding(rec, 'Contact', 'Region__c')).toEqual(['Note__c']);
    expect(M.sftkMdValuesHolding(rec, 'Account', 'Area__c')).toEqual([]);
  });
});

describe('the demo scan of 2026-11-06 (live, npc) — two mention legs that missed their fixture', () => {
  it('compact layouts come from Tooling + readMetadata, not from describe/compactLayouts (which lists only the assigned ones)', () => {
    expect(FC).toContain("SELECT DeveloperName FROM CompactLayout WHERE SobjectType = '${obj}'");
    expect(FC).toContain("await mdRead('CompactLayout', names.map(n => `${obj}.${n}`)");
    expect(FC).not.toContain('sobjects/${obj}/describe/compactLayouts');
  });
  it('an object-scoped custom quick action ("Account.My_Action") is read; its describe takes the bare name', () => {
    expect(FC).toContain("const bare = n => String(n || '').replace(new RegExp(`^${obj}");
    expect(FC).toContain("if (bare(qa.name).includes('.')) return false;");
    expect(FC).toContain('quickActions/${encodeURIComponent(bare(qa.name))}/describe');
  });
  it('the bulk flow buttons count only the flows they would touch — a Process Builder card is left out', () => {
    expect(FC).toContain("const nFix = type === 'Flow' ? _flowCards.filter(c => !c.pb).length : nItems;");
    expect(FC).toContain('${cfg.fixable && nFix > 1');
    expect(FC).toContain('data-n="${nFix}"');
  });
});

describe('the full demo scan of 2026-11-07 (every reference type on one field, npc)', () => {
  it('a matching rule on a CUSTOM field is found by the field\'s Id — MatchingRuleItem.Field carries the Id, not the name', () => {
    expect(FC).toContain("if (f === fieldLc || f.endsWith('.' + fieldLc) || (fid15 && f.startsWith(fid15))) {");
    expect(FC).toContain("const fid15   = String(fieldId || '').substring(0, 15).toLowerCase();");
  });
  it('inactive validation rules get a leg of their own (a mention: the index returns only active rules)', () => {
    expect(FC).toContain("AND Active = false`, true))?.records || [];");
    expect(FC).toContain("'ValidationRuleInactive', r => `${r.ValidationName} (inactive)`, 'inactive validation rules');");
    expect(sevOf('ValidationRuleInactive')).toBe('silent');
    expect(FC).toContain('paths: mentions, validationRulesOff: mentions,');
  });
  it('the four index types that showed with raw names have a label, an icon and a Setup link', () => {
    for (const t of ['CustomField', 'WebLink', 'LookupFilter', 'FieldSet']) {
      expect(sevOf(t), t).toBe('blocker');
      expect(FC, t).toMatch(new RegExp('^\\s*' + t + ':\\s*`/lightning/setup/ObjectManager/', 'm'));
    }
    expect(FC).toContain("label: 'Formula & Roll-up Fields'");
    expect(FC).toContain("label: 'Lookup Filters'");
  });
  it('a lookup filter is named by its lookup field, not "nf_<Object>_<id>"', () => {
    expect(FC).toContain("d.MetadataComponentType === 'LookupFilter' && /^nf_");
    expect(FC).toContain('d.MetadataComponentName = `${by.get(idOf(d))} — its lookup filter`;');
  });
});
