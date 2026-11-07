// shared helpers for the blocker tests (2026-11-06)
import { execFile } from 'node:child_process'; import { promisify } from 'node:util'; import { writeFileSync, mkdirSync } from 'node:fs';
const run = promisify(execFile);
export const ORG = 'npc', NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';
async function raw(args) { try { return (await run('sf', args, { shell: true, encoding: 'utf8', maxBuffer: 64 << 20 })).stdout; } catch (e) { return (e.stdout || '') + (e.stderr || ''); } }
export async function sf(args) { const out = await raw([...args, '--json']); return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)); }
export const q = s => `"${s}"`;
export const tooling = async s => ((await sf(['data', 'query', '--use-tooling-api', '-o', ORG, '-q', q(s)])).result || {}).records || [];
export const soql = async s => ((await sf(['data', 'query', '-o', ORG, '-q', q(s)])).result || {}).records || [];
export const pkg = items => `<?xml version="1.0" encoding="UTF-8"?>\n<Package ${NS}>${items.map(([t, m]) => `<types><members>${m}</members><name>${t}</name></types>`).join('')}<version>62.0</version></Package>\n`;
export const rep = (tag, r) => { const x = r.result || {}; console.log(tag, x.status || JSON.stringify(r).slice(0, 600), (x.numberComponentsDeployed ?? '') + '/' + (x.numberComponentsTotal ?? ''), ((x.details || {}).componentFailures || []).map(f => f.componentType + ' ' + f.fullName + ': ' + f.problem).join(' | ')); return x; };
export const destructive = async (tag, items) => { const d = 'del/_' + tag; mkdirSync(d, { recursive: true }); writeFileSync(d + '/package.xml', pkg([])); writeFileSync(d + '/destructiveChangesPost.xml', pkg(items)); return rep(tag + ':', await sf(['project', 'deploy', 'start', '--metadata-dir', d, '-o', ORG, '--wait', '10'])); };
export const deploySrc = async (tag, dir) => { writeFileSync(dir + '/sfdx-project.json', JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], namespace: '', sourceApiVersion: '62.0' })); process.chdir(dir); const r = rep(tag + ':', await sf(['project', 'deploy', 'start', '--source-dir', 'force-app', '-o', ORG, '--ignore-conflicts', '--wait', '15'])); process.chdir('..'); return r; };
export const fld = (D, obj, n, extra) => { mkdirSync(`${D}/objects/${obj}/fields`, { recursive: true }); writeFileSync(`${D}/objects/${obj}/fields/${n}.field-meta.xml`, `<?xml version="1.0" encoding="UTF-8"?>\n<CustomField ${NS}><fullName>${n}</fullName><externalId>false</externalId><label>${n.slice(0, -3).split('_').join(' ')}</label><required>false</required><trackHistory>false</trackHistory>${extra || '<length>50</length><type>Text</type><unique>false</unique>'}</CustomField>\n`); };
// index + destructive delete for every SFTK_Blk field named in keys (obj resolved from the field's TableEnumOrId)
export async function tryDeletes(keys, prefix) {
  const ids = {}; for (const r of await tooling("SELECT Id, DeveloperName, TableEnumOrId FROM CustomField WHERE DeveloperName LIKE 'SFTK_Blk_%' AND (NOT DeveloperName LIKE '%_del')")) ids[r.DeveloperName + '__c'] = { id: r.Id, obj: r.TableEnumOrId };
  const objNames = {}; for (const r of await tooling("SELECT Id, DeveloperName FROM CustomObject WHERE DeveloperName LIKE 'SFTK_Blk%'")) objNames[r.Id] = r.DeveloperName + '__c';
  const out = {};
  for (const k of keys) {
    const f = `SFTK_Blk_${k}__c`, e = ids[f]; if (!e) { console.log(k, 'field missing, skipped'); out[k] = 'missing'; continue; }
    const obj = objNames[e.obj] || e.obj;
    const idx = [...new Set((await tooling(`SELECT MetadataComponentType, MetadataComponentName FROM MetadataComponentDependency WHERE RefMetadataComponentId = '${e.id}'`)).map(r => r.MetadataComponentType + ':' + r.MetadataComponentName))];
    console.log(`\n${k}: index=${idx.join(', ') || '-'}`);
    const r = await destructive(prefix + k, [['CustomField', obj + '.' + f]]);
    out[k] = { index: idx, status: r.status, problems: ((r.details || {}).componentFailures || []).map(x => x.problem) };
  }
  return out;
}
export async function fieldsLeft() { return (await tooling("SELECT DeveloperName, TableEnumOrId FROM CustomField WHERE DeveloperName LIKE 'SFTK_Blk_%' AND (NOT DeveloperName LIKE '%_del')")).map(r => r.TableEnumOrId + '.' + r.DeveloperName + '__c'); }
