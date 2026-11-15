import { tq, rest } from './lib.mjs';
for (const n of ['SFTK_MX_RT_Flow', 'SFTK_MX_Screen_Flow']) {
  const def = tq(`SELECT Id FROM FlowDefinition WHERE DeveloperName = '${n}'`)[0];
  const r = rest('PATCH', `services/data/v62.0/tooling/sobjects/FlowDefinition/${def.Id}`, { Metadata: { activeVersionNumber: 0 } });
  console.log(n, r.ok ? 'deactivated' : JSON.stringify(r.error).slice(0, 300));
}
