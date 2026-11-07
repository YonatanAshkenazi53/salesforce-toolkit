// Undo live-fix2.mjs (run BEFORE live-clean.mjs). Tolerates parts the user already removed through the tool.
import { writeFileSync } from 'node:fs';
import { ORG, sf, tooling, soql, destructive } from './lib.mjs';
for (const v of await tooling("SELECT Id, Status, DefinitionId FROM Flow WHERE Definition.DeveloperName = 'SFTK_Live_Flow'")) {
  if (v.Status === 'Active') { writeFileSync('deact.json', JSON.stringify({ Metadata: { activeVersionNumber: 0 } })); await sf(['api', 'request', 'rest', `/services/data/v62.0/tooling/sobjects/FlowDefinition/${v.DefinitionId}`, '--method', 'PATCH', '--body', '@deact.json', '-o', ORG]); }
  const d = await sf(['data', 'delete', 'record', '--use-tooling-api', '-s', 'Flow', '-i', v.Id, '-o', ORG]);
  console.log('flow version', v.Status, d.status === 0 ? 'deleted' : JSON.stringify(d).slice(0, 200));
}
for (const r of await soql("SELECT Id FROM Report WHERE Name = 'SFTK Live Report'")) { const d = await sf(['api', 'request', 'rest', `/services/data/v62.0/analytics/reports/${r.Id}`, '--method', 'DELETE', '-o', ORG]); console.log('report deleted', r.Id, JSON.stringify(d).slice(0, 120)); }
const items = [['ListView', 'Account.SFTK_Live_LV'], ['QuickAction', 'Account.SFTK_Live_QA'], ['CompactLayout', 'Account.SFTK_Live_CL']];
const r = await destructive('l2_all', items);
if (r.status !== 'Succeeded') for (const item of items) await destructive('l2_' + item[1].replace(/[^A-Za-z0-9]/g, '_'), [item]);
console.log('left: flows', (await tooling("SELECT Id FROM Flow WHERE Definition.DeveloperName = 'SFTK_Live_Flow'")).length, '| reports', (await soql("SELECT Id FROM Report WHERE Name = 'SFTK Live Report'")).length, '| list views', (await soql("SELECT Id FROM ListView WHERE DeveloperName = 'SFTK_Live_LV'")).length);
// the permission set that gave the admin FLS on the field
{ const u = await soql("SELECT Id FROM PermissionSetAssignment WHERE PermissionSet.Name = 'SFTK_Live_Access'"); for (const a of u) await sf(['data', 'delete', 'record', '-s', 'PermissionSetAssignment', '-i', a.Id, '-o', ORG]); await destructive('l2_ps', [['PermissionSet', 'SFTK_Live_Access']]); }
