// Undo live-fix.mjs: every SFTK_Live fixture out of npc, the lead mapping emptied, the PB versions deleted through Tooling.
import { writeFileSync, mkdirSync } from 'node:fs';
import { NS, sf, tooling, soql, pkg, rep, destructive, fieldsLeft, ORG } from './lib.mjs';
const X = '<?xml version="1.0" encoding="UTF-8"?>\n';
for (const v of await tooling("SELECT Id, Status FROM Flow WHERE Definition.DeveloperName = 'SFTK_Live_PB'")) {
  const d = await sf(['data', 'delete', 'record', '--use-tooling-api', '-s', 'Flow', '-i', v.Id, '-o', ORG]);
  console.log('PB version', v.Status, d.status === 0 ? 'deleted' : JSON.stringify(d).slice(0, 200));
}
mkdirSync('del/_lcs3/LeadConvertSettings', { recursive: true });
writeFileSync('del/_lcs3/package.xml', pkg([['LeadConvertSettings', 'LeadConvertSettings']]));
writeFileSync('del/_lcs3/LeadConvertSettings/LeadConvertSettings.LeadConvertSetting', `${X}<LeadConvertSettings ${NS}><allowOwnerChange>true</allowOwnerChange><objectMapping><inputObject>Lead</inputObject><outputObject>Account</outputObject></objectMapping><opportunityCreationOptions>VisibleOptional</opportunityCreationOptions></LeadConvertSettings>\n`);
rep('lead mapping emptied:', await sf(['project', 'deploy', 'start', '--metadata-dir', 'del/_lcs3', '-o', ORG, '--wait', '10']));
const refs = [['WorkflowRule', 'Account.SFTK_Live_WR'], ['WorkflowFieldUpdate', 'Account.SFTK_Live_FU'], ['WorkflowAlert', 'Account.SFTK_Live_Alert'], ['WorkflowOutboundMessage', 'Account.SFTK_Live_OM'], ['EmailTemplate', 'unfiled$public/SFTK_Live_Email'], ['ApprovalProcess', 'Account.SFTK_Live_AP'], ['SharingCriteriaRule', 'Account.SFTK_Live_SR'], ['DuplicateRule', 'Account.SFTK_Live_DR'], ['LightningComponentBundle', 'sftkLiveBlk'], ['CustomMetadata', 'SFTK_Live_Cmt.Ref'], ['FlexiPage', 'SFTK_Live_Page'], ['Layout', 'Account-SFTK Live Layout']];
let r = await destructive('l_refs', refs);
if (r.status !== 'Succeeded') for (const item of refs) await destructive('l_' + item[1].replace(/[^A-Za-z0-9]/g, '_'), [item]);
await destructive('l_mr', [['MatchingRule', 'Account.SFTK_Live_MR']]);
await destructive('l_obj', [['CustomObject', 'SFTK_Live_Cmt__mdt']]);
r = await destructive('l_fields', [['CustomField', 'Account.SFTK_Live_Blk__c'], ['CustomField', 'Lead.SFTK_Live_Blk__c']]);
if (r.status !== 'Succeeded') { await destructive('l_f1', [['CustomField', 'Account.SFTK_Live_Blk__c']]); await destructive('l_f2', [['CustomField', 'Lead.SFTK_Live_Blk__c']]); }
console.log('\nlive fields left:', (await fieldsLeft()).filter(n => /SFTK_Live/.test(n) && !/_del\d*__c$/.test(n)).join(', ') || 'none');
console.log('live mdt:', (await tooling("SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName LIKE 'SFTK_Live%'")).length, '| flows:', (await tooling("SELECT Id FROM Flow WHERE Definition.DeveloperName LIKE 'SFTK_Live%'")).length, '| dupe rules:', JSON.stringify((await soql("SELECT DeveloperName FROM DuplicateRule WHERE SobjectType = 'Account'")).map(x => x.DeveloperName)), '| matching SFTK:', (await soql("SELECT Id FROM MatchingRule WHERE DeveloperName LIKE 'SFTK_Live%'")).length, '| pages:', (await tooling("SELECT Id FROM FlexiPage WHERE DeveloperName LIKE 'SFTK_Live%'")).length, '| LWC:', (await tooling("SELECT Id FROM LightningComponentBundle WHERE DeveloperName LIKE 'sftkLive%'")).length);
