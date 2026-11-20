// QA 1.1 finding 16 — two components whose id is a NAME are two rows: only a Salesforce Id is compared on 15 characters.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const { fcDepKey: key } = extractFunctions('field-cleaner.js', ['fcDepKey']);

describe('the key a listed component is known by', () => {
  it('the 15- and the 18-character form of one Id are one component', () => {
    expect(key('ListView', '00B5g00000AbCdE')).toBe(key('ListView', '00B5g00000AbCdEFGH'));
    expect(key('ListView', '00B5g00000AbCdE')).not.toBe(key('ListView', '00B5g00000AbCdF'));
    expect(key('ListView', '00B5g00000AbCdE')).not.toBe(key('Layout', '00B5g00000AbCdE'));
  });
  it('names that share their first 15 characters stay apart', () => {
    const pairs = [
      ['ApprovalProcess', 'Opportunity.Discount_Approval', 'Opportunity.Discount_Escalation'],
      ['CompactLayout', 'My_Custom_Obj__c.Phone_Layout', 'My_Custom_Obj__c.Desk_Layout'],
      ['SharingCriteriaRule', 'My_Custom_Obj__c.Share_East', 'My_Custom_Obj__c.Share_West'],
      ['SearchLayout', 'sl_Account_lookupDialogsAdditionalFields', 'sl_Account_lookupFilterFields'],
      ['DependentPicklist', 'dp_Opportunity_Sub_Stage__c', 'dp_Opportunity_Sub_Reason__c'],
      ['CustomMetadataRecord', 'Integration_Setting.RecA', 'Integration_Setting.RecB'],
    ];
    for (const [type, a, b] of pairs) {
      expect(a.substring(0, 15)).toBe(b.substring(0, 15));   // the old key made them one
      expect(key(type, a)).not.toBe(key(type, b));
    }
  });
  it('the same name twice is still one row; an empty id is a key of its own', () => {
    expect(key('QuickAction', 'Account.New_Deal')).toBe(key('QuickAction', 'Account.New_Deal'));
    expect(key('QuickAction', null)).toBe('QuickAction|');
  });
});

describe('the scan uses it', () => {
  const scan = FC.slice(FC.indexOf('  async function scanSupplemental('), FC.indexOf('  function _flexiNamesBeyondText('));
  it('for what the index already lists and for every row a leg adds', () => {
    expect(scan).toContain('const seen = new Set((existingDeps || []).map(d => fcDepKey(d.MetadataComponentType, d.MetadataComponentId)));');
    expect(scan).toContain('const key = fcDepKey(type, id);');
    expect(scan).not.toMatch(/const key = `\$\{type\}\|\$\{String\(id/);
  });
  it('behaviour: an add() built the way the scan builds it lists both approval processes', () => {
    const seen = new Set(), hits = [];
    const add = (type, id) => { const k = key(type, id); if (seen.has(k)) return; seen.add(k); hits.push(id); };
    add('ApprovalProcess', 'Opportunity.Discount_Approval');
    add('ApprovalProcess', 'Opportunity.Discount_Escalation');
    add('ApprovalProcess', 'Opportunity.Discount_Approval');
    expect(hits).toEqual(['Opportunity.Discount_Approval', 'Opportunity.Discount_Escalation']);
  });
});
