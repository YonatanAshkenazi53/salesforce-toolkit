// Live Field Cleaner matrix harness: loads the PRODUCT's transforms (nothing re-implemented) and talks to npc.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const REPO = 'C:/Users/yonas/OneDrive/Desktop/Saleforce Toolkit';
export const SCR = join(tmpdir(), 'sftk-fc-matrix-live');
await import('file:///' + REPO + '/test/setup-relmap.mjs');
const { extractFunctions } = await import('file:///' + REPO + '/test/extract.mjs');
const read = f => readFileSync(join(REPO, f), 'utf8');

// ── product code ───────────────────────────────────────────────────────────────
const MD_NAMES = ['sftkMdFindElement', 'sftkMdChildText', 'sftkMdEscape', 'sftkMdUnescape', 'sftkMdEnvelope', 'sftkMdReadBody', 'sftkMdExtractRecords',
  'sftkMdRecordFileXml', 'sftkMdPackageFiles', 'sftkMdDeleteSpec', 'sftkMdEditField', 'sftkMdEditWays', 'sftkRtRemoveField', 'sftkRtReplaceField',
  'sftkRtZipFiles', 'sftkFormulaDropField', '_sftkMdSwapToken', 'sftkMdCodeSame', 'sftkMdDestructiveFiles', 'sftkMdIsOwnObj'];
export const M = new Function(`${read('sftk-mdapi.js')}\nreturn { ${MD_NAMES.join(', ')} };`)();
Object.assign(globalThis, M);
export const R = new Function(`${read('sftk-fieldreplace.js')}\nreturn { sftkLayoutReplaceField, sftkFlexiReplaceField, sftkRptReplaceField, sftkFlowReplaceField, sftkFlowResourceObjects };`)();
Object.assign(globalThis, R);
export const TPL = new Function(`${read('sftk-emailtpl.js')}\nreturn { sftkTplRemove, sftkTplReplace, sftkTplHits, sftkTplKind, sftkTplTextFields };`)();
export const RC = extractFunctions('sftk-reportclean.js', ['sftkRptTokenMatch', 'sftkRptFieldHits', 'sftkRptStripField', 'sftkRptScanClass']);
const S = extractFunctions('sftk-flowsurgery.js', ['sftkFlowSurgeryPlan', 'sftkFlowRefScan', 'sftkFlowRefWhere', 'sftkFlowRefPreview', 'sftkFlowReachable']);
Object.assign(globalThis, S);

const FC = read('field-cleaner.js');
const nested = name => {
  const at = FC.indexOf(`\n  function ${name}(`);
  if (at < 0) throw new Error(`not found in field-cleaner.js: ${name}`);
  return FC.slice(at + 1, FC.indexOf('\n  }\n', at + 1) + 4);
};
const constBlock = (header, closer) => {
  const at = FC.indexOf(header);
  if (at < 0) throw new Error(`not found: ${header}`);
  return FC.slice(at, FC.indexOf(closer, at) + closer.length);
};
const rmAt = FC.indexOf('  function removeFieldRefs(metadata, objApi, fieldApi, opts) {');
const rmStop = FC.indexOf('    return changes;', rmAt);
const RM_SRC = FC.slice(rmAt, FC.indexOf('}', rmStop) + 1);

export const FCX = new Function('deps', `
  const { sftkFlowRefScan, sftkFormulaDropField, sftkMdDeleteSpec, sftkMdEditWays, sftkFlowResourceObjects } = deps;
  let _selObj = { api: 'Account' }, _selField = { api: 'SFTK_MX_Region__c' }, _replField = null;
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const _replOn = () => !!_replField;
  ${constBlock('  const _LX_SKIP = new Set(', ');')}
  ${constBlock('  const _LAYOUT_TOP_ORDER = ', '\n  ];')}
  ${constBlock('  const _LAYOUT_COMPLEX_FIELDS = ', '];')}
  ${constBlock('  const _XI_IS_DELETABLE = {', '\n  };')}
  ${['_lxEsc', '_lxValueToLines', 'buildFlowXml', 'buildFlowPackageXml', 'buildLayoutXml', 'buildLayoutPackageXml', '_xiIsRef', '_fieldStringTester',
     'flowReferencesField', '_collectDeletableNodes', '_removeSelectedFlowBlocks', '_flowLeftWhy', 'removeFieldFromLayout', 'removeFieldFromFlexiPage',
     'flexiPageReferencesField', 'replaceFieldInFlexiPage', 'sanitizeLayoutMetadata'].map(nested).join('\n')}
  ${RM_SRC}
  return { buildFlowXml, buildFlowPackageXml, buildLayoutXml, buildLayoutPackageXml, removeFieldRefs, flowReferencesField, removeFieldFromLayout,
    removeFieldFromFlexiPage, replaceFieldInFlexiPage, sanitizeLayoutMetadata,
    setSel(o, f, r) { _selObj = { api: o }; _selField = { api: f }; _replField = r ? { api: r } : null; } };
`)({ sftkFlowRefScan: S.sftkFlowRefScan, sftkFormulaDropField: M.sftkFormulaDropField, sftkMdDeleteSpec: M.sftkMdDeleteSpec, sftkMdEditWays: M.sftkMdEditWays, sftkFlowResourceObjects: R.sftkFlowResourceObjects });

// ── org access: everything through the sf CLI (no token handled here) ─────────
let rn = 0;
export function rest(method, path, body) {
  const args = ['api', 'request', 'rest', '"/' + path.replace(/^\//, '') + '"', '--method', method, '-o', 'npc'];
  if (body != null) { const f = join(SCR, 'tmp', `body-${++rn}.json`); mkdirSync(join(SCR, 'tmp'), { recursive: true }); writeFileSync(f, JSON.stringify(body)); args.push('--body', '@' + f); }
  const r = spawnSync('sf', args, { encoding: 'utf8', shell: true, maxBuffer: 64 << 20 });
  const t = (r.stdout || '').trim();
  let j; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  const err = Array.isArray(j) && j[0] && j[0].errorCode ? j : (r.status ? (j || r.stderr) : null);
  return { ok: !err, body: j, error: err };
}
export const tq = q => rest('GET', `services/data/v62.0/tooling/query?q=${encodeURIComponent(q)}`).body.records;
export const dq = q => rest('GET', `services/data/v62.0/query?q=${encodeURIComponent(q)}`).body.records;
export function pkgXml(members, tag = 'Package') {
  const byType = new Map();
  for (const [t, m] of members) { if (!byType.has(t)) byType.set(t, []); byType.get(t).push(m); }
  let x = `<?xml version="1.0" encoding="UTF-8"?>\n<${tag} xmlns="http://soap.sforce.com/2006/04/metadata">\n`;
  for (const [t, ms] of byType) x += `  <types>\n${ms.map(m => `    <members>${m}</members>\n`).join('')}    <name>${t}</name>\n  </types>\n`;
  return x + (tag === 'Package' ? '  <version>62.0</version>\n' : '') + `</${tag}>\n`;
}
// "readMetadata" through a CLI retrieve (mdapi format): the record is cut out of its file and given the qualified
// <fullName> readMetadata returns. A child type is found inside its parent's file by its short name.
export function retrieve(members, label) {
  const dir = join(SCR, 'ret', label);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const byType = new Map();
  for (const [t, m] of members) { if (!byType.has(t)) byType.set(t, []); byType.get(t).push(m); }
  writeFileSync(join(dir, 'package.xml'), pkgXml(members));
  const r = spawnSync('sf', ['project', 'retrieve', 'start', '-o', 'npc', '--manifest', `"${join(dir, 'package.xml')}"`, '--target-metadata-dir', `"${join(dir, 'out')}"`, '--unzip', '--json'], { encoding: 'utf8', shell: true, maxBuffer: 64 << 20 });
  const j = JSON.parse(r.stdout);
  if (j.status !== 0) throw new Error('retrieve failed: ' + r.stdout.slice(0, 500));
  return join(dir, 'out', 'unpackaged', 'unpackaged');
}
const PARENT = { ValidationRule: ['objects', 'object', 'validationRules'], CustomField: ['objects', 'object', 'fields'], ListView: ['objects', 'object', 'listViews'],
  CompactLayout: ['objects', 'object', 'compactLayouts'], FieldSet: ['objects', 'object', 'fieldSets'], WebLink: ['objects', 'object', 'webLinks'],
  WorkflowRule: ['workflows', 'workflow', 'rules'], WorkflowFieldUpdate: ['workflows', 'workflow', 'fieldUpdates'] };
const TOP = { ApprovalProcess: ['approvalProcesses', 'approvalProcess'], QuickAction: ['quickActions', 'quickAction'], ReportType: ['reportTypes', 'reportType'] };
export function innerOf(dir, type, fullName) {
  if (PARENT[type]) {
    const [folder, suffix, tag] = PARENT[type];
    const dot = fullName.indexOf('.'), obj = fullName.slice(0, dot), short = fullName.slice(dot + 1);
    const text = readFileSync(join(dir, folder, `${obj}.${suffix}`), 'utf8');
    let at = 0;
    for (;;) {
      const el = M.sftkMdFindElement(text, tag, at);
      if (!el) throw new Error(`${type} ${fullName} not in the retrieve`);
      at = el.end;
      const body = text.slice(el.bodyStart, el.bodyEnd);
      if (M.sftkMdChildText(body, 'fullName') !== short) continue;
      const fn = M.sftkMdFindElement(body, 'fullName', 0);
      return `<fullName>${fullName}</fullName>` + body.slice(0, fn.start) + body.slice(fn.end);
    }
  }
  const [folder, suffix] = TOP[type];
  const text = readFileSync(join(dir, folder, `${fullName}.${suffix}`), 'utf8');
  const root = M.sftkMdFindElement(text, type, 0);
  return `<fullName>${fullName}</fullName>` + text.slice(root.bodyStart, root.bodyEnd);
}
// deploy a set of { name, text } files as an mdapi folder through the CLI
let dn = 0;
export function deployFiles(files, label) {
  const dir = join(SCR, 'dep', `${String(++dn).padStart(3, '0')}-${label.replace(/[^A-Za-z0-9_.-]/g, '_')}`);
  rmSync(dir, { recursive: true, force: true });
  for (const f of files) { mkdirSync(join(dir, f.name, '..'), { recursive: true }); writeFileSync(join(dir, f.name), f.text); }
  let out;
  try { out = execSync(`sf project deploy start -o npc --metadata-dir "${dir}" --test-level NoTestRun --wait 20 --json`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { out = e.stdout; }
  const r = JSON.parse(out).result || JSON.parse(out);
  const fails = [].concat(r?.details?.componentFailures || []).map(f => `${f.componentType} ${f.fullName}: ${f.problem}`);
  return { ok: r?.status === 'Succeeded', status: r?.status, fails, dir, raw: r?.status ? undefined : JSON.parse(out).message };
}
