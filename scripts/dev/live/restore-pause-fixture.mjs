// Puts the npc2 pause fixture back ON after a harness run that was cut mid-way
// (2026-11-08: a live script re-logged in while a deployment was still running,
// so its switch-back never happened). Flows: FlowDefinition.Metadata
// activeVersionNumber = the latest version; validation rules: Metadata.active
// = true. Everything goes through the CLI (`sf api request rest`, RELATIVE
// path — a leading slash answers NOT_FOUND), so no token is ever handled here.
// Read → write → re-read.
//   node scripts/dev/live/restore-pause-fixture.mjs [npc2]
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const alias = process.argv[2] || 'npc2';
const sh = cmd => { const t = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); return t.slice(t.indexOf(t.trimStart()[0] === '[' ? '[' : '{')); };
const q = (soql, tooling = true) => JSON.parse(sh(`sf data query -o ${alias} --json ${tooling ? '-t ' : ''}-q "${soql}"`)).result.records || [];
const rest = (path, method, bodyFile) => sh(`sf api request rest "${path}" -o ${alias}${method ? ` -X ${method}` : ''}${bodyFile ? ` -b "@${bodyFile}"` : ''}`);
const dir = mkdtempSync(join(tmpdir(), 'sftk-restore-'));

for (const name of ['SFTK_FS_Test_Acc1', 'SFTK_FS_Test_Acc2', 'SFTK_FS_Test_Con1']) {
  const [v] = q(`SELECT ApiName, IsActive FROM FlowDefinitionView WHERE ApiName = '${name}'`, false);
  if (!v) { console.log(name, '— not in the org'); continue; }
  if (v.IsActive) { console.log(name, 'already ON'); continue; }
  const [d] = q(`SELECT Id FROM FlowDefinition WHERE DeveloperName = '${name}'`);
  const vers = q(`SELECT VersionNumber FROM Flow WHERE DefinitionId = '${d.Id}' ORDER BY VersionNumber DESC LIMIT 1`);
  const n = Number(vers[0]?.VersionNumber) || 1;
  const f = join(dir, `${name}.json`); writeFileSync(f, JSON.stringify({ Metadata: { activeVersionNumber: n } }));
  rest(`services/data/v62.0/tooling/sobjects/FlowDefinition/${d.Id}`, 'PATCH', f);
  const [after] = q(`SELECT IsActive FROM FlowDefinitionView WHERE ApiName = '${name}'`, false);
  console.log(name, `→ v${n} ON: ${after?.IsActive}`);
}
for (const r of q(`SELECT Id, ValidationName, Active FROM ValidationRule WHERE ValidationName LIKE 'SFTK_CX_%'`)) {
  if (r.Active) { console.log(r.ValidationName, 'already ON'); continue; }
  const rec = JSON.parse(rest(`services/data/v62.0/tooling/sobjects/ValidationRule/${r.Id}`));
  const md = rec.Metadata; md.active = true;
  for (const k of Object.keys(md)) if (md[k] === null) delete md[k];
  const f = join(dir, `${r.ValidationName}.json`); writeFileSync(f, JSON.stringify({ Metadata: md }));
  rest(`services/data/v62.0/tooling/sobjects/ValidationRule/${r.Id}`, 'PATCH', f);
  const [after] = q(`SELECT Active FROM ValidationRule WHERE Id = '${r.Id}'`);
  console.log(r.ValidationName, `→ ON: ${after?.Active}`);
}
