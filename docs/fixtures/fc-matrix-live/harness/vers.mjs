import { FCX, tq, rest } from './lib.mjs';
FCX.setSel('Account', 'SFTK_MX_Region__c', null);
for (const n of ['SFTK_MX_RT_Flow', 'SFTK_MX_Screen_Flow']) {
  const def = tq(`SELECT Id FROM FlowDefinition WHERE DeveloperName = '${n}'`)[0];
  for (const v of tq(`SELECT Id, VersionNumber, Status FROM Flow WHERE DefinitionId = '${def.Id}' ORDER BY VersionNumber`)) {
    const md = rest('GET', `services/data/v62.0/tooling/sobjects/Flow/${v.Id}`).body.Metadata;
    const s = JSON.stringify(md); const acct = (s.match(/(\$Record|Get_Account)\.SFTK_MX_Region__c|"SFTK_MX_Region__c"/g) || []).length;
    let del = '';
    if (v.Status === 'Obsolete' && process.argv[2] === 'delete') { const r = rest('DELETE', `services/data/v62.0/tooling/sobjects/Flow/${v.Id}`); del = r.ok ? ' → deleted' : ` → delete refused ${JSON.stringify(r.error)}`; }
    console.log(n, `v${v.VersionNumber}`, v.Status, 'flowReferencesField:', FCX.flowReferencesField(md), del);
  }
}
