// Record-type visibility for the running user in both orgs (a deployed record type is not on the admin's profile), then the
// source demo Account gets type A.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { NS, sf, rep, soql } from './lib.mjs';
const X = '<?xml version="1.0" encoding="UTF-8"?>\n';
const vis = ['A', 'B'].map(k => `<recordTypeVisibilities><recordType>Account.SFTK_Live_RT_${k}</recordType><visible>true</visible></recordTypeVisibilities>`).join('\n    ');
// npc: the demo permission set, redeployed with the visibilities
{
  const p = 'live6/force-app/main/default/permissionsets/SFTK_Live_Access.permissionset-meta.xml';
  let s = readFileSync(p, 'utf8');
  if (!s.includes('recordTypeVisibilities')) s = s.replace('    <hasActivationRequired>', `    ${vis}\n    <hasActivationRequired>`);
  writeFileSync(p, s);
  process.chdir('live6');
  rep('npc permset:', await sf(['project', 'deploy', 'start', '--source-dir', 'force-app/main/default/permissionsets', '-o', 'npc', '--ignore-conflicts', '--wait', '10']));
  process.chdir('..');
}
// npc2: a permission set of its own, assigned
{
  const D = 'rt_npc2/force-app/main/default/permissionsets';
  mkdirSync(D, { recursive: true });
  writeFileSync(`${D}/SFTK_Live_RT_Access.permissionset-meta.xml`, `${X}<PermissionSet ${NS}>\n    <description>SFTK live demo: the two demo record types visible. Safe to delete.</description>\n    ${vis}\n    <hasActivationRequired>false</hasActivationRequired>\n    <label>SFTK Live RT Access</label>\n</PermissionSet>\n`);
  process.chdir('rt_npc2');
  rep('npc2 permset:', await sf(['project', 'deploy', 'start', '--source-dir', 'force-app', '-o', 'npc2', '--ignore-conflicts', '--wait', '10']));
  process.chdir('..');
  const a = await sf(['org', 'assign', 'permset', '-o', 'npc2', '--name', 'SFTK_Live_RT_Access']);
  console.log('npc2 assigned:', JSON.stringify((a.result || a).failures || a.result || a).slice(0, 200));
}
const rt = (await soql("SELECT Id FROM RecordType WHERE SobjectType = 'Account' AND DeveloperName = 'SFTK_Live_RT_A'"))[0];
const u = await sf(['data', 'update', 'record', '-o', 'npc', '-s', 'Account', '-i', '001dL00002cf5T6QAI', '-v', `RecordTypeId=${rt.Id}`]);
console.log('Americas → RT_A in npc:', u.status === 0 ? 'updated' : JSON.stringify(u).slice(0, 300));
console.log('check:', JSON.stringify(await soql("SELECT RecordType.DeveloperName FROM Account WHERE Id = '001dL00002cf5T6QAI'")));
