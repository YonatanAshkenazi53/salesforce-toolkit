// QA 1.1 finding 29: a fresh sweep item is not "already in the scan list" because its name starts another's.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

const S = extractFunctions('sftk-sweep.js', ['sftkSweepCompare']);
const byType = spec => Object.fromEntries(Object.entries(spec).map(([t, comps]) => [t, { items: comps.map(component => ({ component })) }]));
const flags = bt => Object.fromEntries(Object.values(bt).flatMap(t => t.items.map(it => [it.component, it.inScan])));

describe('sftkSweepCompare — a plain API name matches only itself', () => {
  it('AccountService is fresh when the scan lists AccountServiceTest; Check_Status when it lists Check_Status_Closed', () => {
    const bt = byType({ ApexClass: ['AccountService'], ValidationRule: ['Account.Check_Status'] });
    const cmp = S.sftkSweepCompare(bt, [{ type: 'ApexClass', name: 'AccountServiceTest' }, { type: 'ValidationRule', name: 'Check_Status_Closed' }]);
    expect(cmp).toEqual({ known: 0, fresh: 2 });
    expect(flags(bt)).toEqual({ AccountService: false, 'Account.Check_Status': false });
  });
  it('the other way round too: the scan lists the short name, the sweep finds the long one', () => {
    const bt = byType({ ApexClass: ['AccountServiceTest'], ValidationRule: ['Account.Check_Status_Closed'] });
    const cmp = S.sftkSweepCompare(bt, [{ type: 'ApexClass', name: 'AccountService' }, { type: 'ValidationRule', name: 'Check_Status' }, { type: 'ValidationRule', name: 'Account.Check_Status' }]);
    expect(cmp).toEqual({ known: 0, fresh: 2 });
  });
  it('the same component is still known: equal names, case, the object prefix, a folder, the kind aliases', () => {
    const bt = byType({ ApexClass: ['AccountService'], ValidationRule: ['Account.Check_Status'], LwcMarkup: ['statusCard'], EmailTemplate: ['unfiled$public/Status_Mail'], LookupFilter: ['Account.Parent__c'] });
    const cmp = S.sftkSweepCompare(bt, [{ type: 'ApexClass', name: 'accountservice' }, { type: 'ValidationRuleInactive', name: 'Check_Status' },
      { type: 'LightningComponentBundle', name: 'statusCard' }, { type: 'EmailTemplate', name: 'Status_Mail' }, { type: 'LookupFilter', name: 'Account.Parent__c' }]);
    expect(cmp).toEqual({ known: 5, fresh: 0 });
  });
  it('a scan name with a suffix or a label keeps the allowance, at a word end only', () => {
    const bt = byType({ CustomMetadataRecord: ['SFTK_Live_Cmt.Ref'], WebLink: ['Account.SFTK_Live_Btn'], ValidationRule: ['Account.SFTK_Live_VR'], Flow: ['Renewal_Reminder'] });
    const cmp = S.sftkSweepCompare(bt, [{ type: 'CustomMetadataRecord', name: 'SFTK_Live_Cmt.Ref (Field__c)' }, { type: 'WebLink', name: 'SFTK_Live_Btn (url)' },
      { type: 'ValidationRule', name: 'SFTK Live VR' }, { type: 'ProcessBuilder', name: 'Renewal Reminder - v3' }]);
    expect(cmp).toEqual({ known: 4, fresh: 0 });
    // a label does not swallow a longer word: "Account Service (x)" is not AccountServiceTest's
    const bt2 = byType({ ApexClass: ['AccountServiceTest', 'Account_Servicing'] });
    expect(S.sftkSweepCompare(bt2, [{ type: 'ApexClass', name: 'AccountService (x)' }, { type: 'ApexClass', name: 'Account Service' }])).toEqual({ known: 0, fresh: 2 });
  });
  it('another kind with the same name is no match', () => {
    const bt = byType({ ApexTrigger: ['AccountService'] });
    expect(S.sftkSweepCompare(bt, [{ type: 'ApexClass', name: 'AccountService' }])).toEqual({ known: 0, fresh: 1 });
  });
});
