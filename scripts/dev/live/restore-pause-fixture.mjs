// Puts the npc2 pause fixture back ON after a harness run that was cut mid-way
// (2026-11-08: a live script re-logged in while a deployment was still running,
// so its switch-back never happened). Flows: FlowDefinition.Metadata
// activeVersionNumber = the latest version; validation rules: Metadata.active
// = true. Tooling REST with the CLI's own token. Read → write → re-read.
//   node scripts/dev/live/restore-pause-fixture.mjs [npc2]
import { execSync } from 'node:child_process';
const alias = process.argv[2] || 'npc2';
const org = JSON.parse(execSync(`sf org display -o ${alias} --json`, { encoding: 'utf8' })).result;
const base = `${org.instanceUrl}/services/data/v62.0`;
const H = { Authorization: `Bearer ${org.accessToken}`, 'Content-Type': 'application/json' };
const q = async (soql, tooling = true) => (await (await fetch(`${base}${tooling ? '/tooling' : ''}/query?q=${encodeURIComponent(soql)}`, { headers: H })).json()).records || [];
const patch = async (sobject, id, body) => { const r = await fetch(`${base}/tooling/sobjects/${sobject}/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`${sobject} ${id}: HTTP ${r.status} ${await r.text()}`); };

for (const name of ['SFTK_FS_Test_Acc1', 'SFTK_FS_Test_Acc2', 'SFTK_FS_Test_Con1']) {
  const [v] = await q(`SELECT ApiName, IsActive FROM FlowDefinitionView WHERE ApiName = '${name}'`, false);
  if (!v) { console.log(name, '— not in the org'); continue; }
  if (v.IsActive) { console.log(name, 'already ON'); continue; }
  const [d] = await q(`SELECT Id FROM FlowDefinition WHERE DeveloperName = '${name}'`);
  const vers = await q(`SELECT VersionNumber FROM Flow WHERE DefinitionId = '${d.Id}' ORDER BY VersionNumber DESC LIMIT 1`);
  const n = Number(vers[0]?.VersionNumber) || 1;
  await patch('FlowDefinition', d.Id, { Metadata: { activeVersionNumber: n } });
  const [after] = await q(`SELECT IsActive FROM FlowDefinitionView WHERE ApiName = '${name}'`, false);
  console.log(name, `→ v${n} ON: ${after?.IsActive}`);
}
for (const r of await q(`SELECT Id, ValidationName, Active FROM ValidationRule WHERE ValidationName LIKE 'SFTK_CX_%'`)) {
  if (r.Active) { console.log(r.ValidationName, 'already ON'); continue; }
  const rec = await (await fetch(`${base}/tooling/sobjects/ValidationRule/${r.Id}`, { headers: H })).json();
  const md = rec.Metadata; md.active = true;
  for (const k of Object.keys(md)) if (md[k] === null) delete md[k];
  await patch('ValidationRule', r.Id, { Metadata: md });
  const [after] = await q(`SELECT Active FROM ValidationRule WHERE Id = '${r.Id}'`);
  console.log(r.ValidationName, `→ ON: ${after?.Active}`);
}
