// Undo live-fix4.mjs (run FIRST, then live-clean2, then live-clean). Tolerates parts the user removed through the tool.
import { tooling, soql, destructive } from './lib.mjs';
const refs = [
  ['ApexClass', 'SFTK_Live_Class'], ['ApexTrigger', 'SFTK_Live_Trigger'], ['ApexPage', 'SFTK_Live_VF'], ['ApexComponent', 'SFTK_Live_VFC'],
  ['ValidationRule', 'Account.SFTK_Live_VR'], ['ValidationRule', 'Account.SFTK_Live_VR_Off'], ['ValidationRule', 'Contact.SFTK_Live_XVR'],
  ['CustomField', 'Account.SFTK_Live_Formula__c'], ['CustomField', 'Contact.SFTK_Live_XFormula__c'], ['CustomField', 'Contact.SFTK_Live_Lk__c'],
  ['FieldSet', 'Account.SFTK_Live_FS'], ['WebLink', 'Account.SFTK_Live_Btn'], ['RestrictionRule', 'SFTK_Live_Scope'],
  ['AuraDefinitionBundle', 'sftkLiveAura'], ['EmailTemplate', 'unfiled$public/SFTK_Live_EmailSFX'], ['EmailTemplate', 'unfiled$public/SFTK_Live_EmailVF'],
  ['Report', 'unfiled$public/SFTK_Live_Report_Public'], ['ReportType', 'SFTK_Live_RT'],
  ['AssignmentRule', 'Lead.SFTK_Live_AR'], ['EscalationRule', 'Case.SFTK_Live_ER'],
];
let r = await destructive('l4_refs', refs);
if (r.status !== 'Succeeded') for (const item of refs) await destructive('l4_' + item[1].replace(/[^A-Za-z0-9]/g, '_'), [item]);
await destructive('l4_mr2', [['MatchingRule', 'Account.SFTK_Live_MR2']]);
r = await destructive('l4_fields', [['CustomField', 'Account.SFTK_Live_Blk2__c'], ['CustomField', 'Case.SFTK_Live_Blk__c'], ['CustomField', 'Account.SFTK_Live_Check__c']]);
if (r.status !== 'Succeeded') { await destructive('l4_f1', [['CustomField', 'Account.SFTK_Live_Blk2__c']]); await destructive('l4_f2', [['CustomField', 'Case.SFTK_Live_Blk__c']]); }
console.log('left — fields:', (await tooling("SELECT TableEnumOrId, DeveloperName FROM CustomField WHERE DeveloperName LIKE 'SFTK_Live%'")).map(x => x.TableEnumOrId + '.' + x.DeveloperName).join(', ') || 'none',
  '| apex:', (await tooling("SELECT Id FROM ApexClass WHERE Name LIKE 'SFTK_Live%'")).length + (await tooling("SELECT Id FROM ApexTrigger WHERE Name LIKE 'SFTK_Live%'")).length,
  '| reports:', (await soql("SELECT Id FROM Report WHERE Name LIKE 'SFTK Live%'")).length, '| matching:', (await soql("SELECT DeveloperName FROM MatchingRule WHERE DeveloperName LIKE 'SFTK_Live%'")).map(x => x.DeveloperName).join(','));
