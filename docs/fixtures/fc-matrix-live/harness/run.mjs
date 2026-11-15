// node run.mjs swap|cut [only-regex]  — one round of the live matrix: every component, the product's own transform,
// the product's own write path (MDAPI deploy / Tooling PATCH / Analytics PATCH / REST PATCH), the outcome recorded.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { M, R, TPL, RC, FCX, SCR, rest, tq, dq, retrieve, innerOf, deployFiles } from './lib.mjs';

const MODE = process.argv[2];
const ONLY = process.argv[3] ? new RegExp(process.argv[3]) : null;
if (!['swap', 'cut'].includes(MODE)) throw new Error('mode: swap | cut');
const OBJ = 'Account', F = 'SFTK_MX_Region__c', NF = MODE === 'swap' ? 'SFTK_MX_Area__c' : null;
FCX.setSel(OBJ, F, NF);
const out = [];
const rec = (comp, o) => { const r = { comp, action: MODE === 'swap' ? '⇄' : '✂', ...o }; out.push(r); console.log(JSON.stringify(r)); };
const errText = e => typeof e === 'string' ? e : JSON.stringify(e).slice(0, 600);

// ── MDAPI kinds (sftkMdEditField → sftkMdPackageFiles → deploy) ─────────────────
const MD = [
  ['ValidationRule', 'Account.SFTK_MX_VR_One'], ['ValidationRule', 'Account.SFTK_MX_VR_Many'],
  ['CustomField', 'Account.SFTK_MX_Fx1__c'], ['CustomField', 'Account.SFTK_MX_Fx2__c'],
  ['WorkflowRule', 'Account.SFTK_MX_WF'], ['WorkflowRule', 'Account.SFTK_MX_WF_Formula'],
  ['WorkflowFieldUpdate', 'Account.SFTK_MX_FU_Target'], ['WorkflowFieldUpdate', 'Account.SFTK_MX_FU_Formula'],
  ['ListView', 'Account.SFTK_MX_View'], ['ListView', 'Account.SFTK_MX_View_One'],
  ['CompactLayout', 'Account.SFTK_MX_Compact'], ['FieldSet', 'Account.SFTK_MX_FS'], ['WebLink', 'Account.SFTK_MX_Link'],
  ['QuickAction', 'Account.SFTK_MX_Update'], ['ApprovalProcess', 'Account.SFTK_MX_Approval'],
  // Contact's same-named field only: Account's ✂ / ⇄ must leave them exactly as they are
  ['ValidationRule', 'Contact.SFTK_MX_VR_Contact'], ['ListView', 'Contact.SFTK_MX_Contact_View'], ['FieldSet', 'Contact.SFTK_MX_Contact_FS'],
  ['ReportType', 'SFTK_MX_RT'],
].filter(([t, n]) => !ONLY || ONLY.test(`${t}:${n}`));
const dir = MD.length ? retrieve(MD, `pre-${MODE}`) : null;
for (const [type, fullName] of MD) {
  const comp = `${type} ${fullName}`;
  try {
    const before = innerOf(dir, type, fullName);
    if (type === 'ReportType') {
      const res = NF ? M.sftkRtReplaceField(before, OBJ, F, NF) : M.sftkRtRemoveField(before, OBJ, F);
      if (res.viaLookup && res.viaLookup.length) { rec(comp, { tool: 'REFUSED', text: `viaLookup: ${res.viaLookup.join('; ')}` }); continue; }
      if (!res.changed) { rec(comp, { tool: 'REFUSED', text: `no column; skipped: ${(res.skipped || []).join('; ')}` }); continue; }
      const d = deployFiles(M.sftkRtZipFiles(fullName, M.sftkMdRecordFileXml('ReportType', res.xml)), `${MODE}-${fullName}`);
      rec(comp, { tool: 'APPLIED', how: `swapped ${res.swapped} dropped ${res.dropped} skipped ${(res.skipped || []).join('; ')}`, sf: d.ok ? 'ACCEPTED' : 'REFUSED', msg: d.fails.join(' | ') || d.raw });
      continue;
    }
    const ways = M.sftkMdEditWays(type);
    const ed = M.sftkMdEditField(type, before, OBJ, F, NF);
    const offered = NF ? ways.replace : ways.remove;
    if (ed.refused || !ed.changed) { rec(comp, { tool: 'REFUSED', offered, text: ed.refused || 'nothing changed', unsure: ed.unsure }); continue; }
    const files = M.sftkMdPackageFiles(type, fullName, ed.xml);
    const d = deployFiles(files, `${MODE}-${fullName}`);
    rec(comp, { tool: 'APPLIED', offered, how: ed.how.join('; '), off: ed.off, suggested: ed.suggested, sf: d.ok ? 'ACCEPTED' : 'REFUSED', msg: d.fails.join(' | ') || d.raw });
  } catch (e) { rec(comp, { tool: 'ERROR', text: String(e.stack || e).slice(0, 500) }); }
}

// ── Flows (Tooling Metadata → removeFieldRefs / sftkFlowReplaceField → buildFlowXml → deploy as the new active version) ─
async function chainOwner(root, rels) {
  let cur = root;
  for (const rel of rels) {
    const d = rest('GET', `services/data/v62.0/sobjects/${cur}/describe`).body;
    const f = (d.fields || []).find(x => String(x.relationshipName || '').toLowerCase() === String(rel).toLowerCase());
    if (!f || !f.referenceTo || f.referenceTo.length !== 1) return null;
    cur = f.referenceTo[0];
  }
  return cur;
}
for (const name of ['SFTK_MX_RT_Flow', 'SFTK_MX_Screen_Flow'].filter(n => !ONLY || ONLY.test(`Flow:${n}`))) {
  const comp = `Flow ${name}`;
  try {
    const def = tq(`SELECT Id, ActiveVersionId FROM FlowDefinition WHERE DeveloperName = '${name}'`)[0];
    const fl = rest('GET', `services/data/v62.0/tooling/sobjects/Flow/${def.ActiveVersionId}`).body;
    const md = JSON.parse(JSON.stringify(fl.Metadata));
    let how;
    if (NF) {
      const probe = R.sftkFlowReplaceField(JSON.parse(JSON.stringify(md)), OBJ, F, NF);
      const owners = new Map();
      for (const need of probe.needs) owners.set(`${need.rootObj}|${need.rels.join('.')}`, await chainOwner(need.rootObj, need.rels));
      const sw = R.sftkFlowReplaceField(md, OBJ, F, NF, { chainOwner: (r, rels) => { const v = owners.get(`${r}|${rels.join('.')}`); return v === undefined ? null : v; } });
      how = `changed ${sw.changed.length}: ${sw.changed.map(c => `${c.before}→${c.after}`).join(', ')}; skipped ${sw.skipped.length}: ${sw.skipped.map(s => `${s.why}`).join(', ')}`;
      if (!sw.changed.length) { rec(comp, { tool: 'REFUSED', text: how }); continue; }
    } else {
      const n = FCX.removeFieldRefs(md, OBJ, F);
      how = `removeFieldRefs changes: ${JSON.stringify(n).slice(0, 300)}`;
      if (!n || (Array.isArray(n) && !n.length)) { rec(comp, { tool: 'REFUSED', text: how }); continue; }
    }
    md.status = 'Active';
    const d = deployFiles([{ name: 'package.xml', text: FCX.buildFlowPackageXml(name) }, { name: `flows/${name}.flow`, text: FCX.buildFlowXml(md) }], `${MODE}-flow-${name}`);
    rec(comp, { tool: 'APPLIED', how, sf: d.ok ? 'ACCEPTED' : 'REFUSED', msg: d.fails.join(' | ') || d.raw });
  } catch (e) { rec(comp, { tool: 'ERROR', text: String(e.stack || e).slice(0, 500) }); }
}

// ── Layout (Tooling PATCH, MDAPI fallback) ─────────────────────────────────────
if (!ONLY || ONLY.test('Layout:')) {
  const comp = 'Layout Account-SFTK MX Layout';
  try {
    const id = tq("SELECT Id FROM Layout WHERE Name = 'SFTK MX Layout' AND TableEnumOrId = 'Account'")[0].Id;
    const res = rest('GET', `services/data/v62.0/tooling/sobjects/Layout/${id}`).body;
    const metadata = JSON.parse(JSON.stringify(res.Metadata));
    const lyOpts = { objApi: OBJ, fullName: res.FullName || res.fullName, isObject: a => ['account', 'contact', 'user', 'opportunity', 'case', 'lead'].includes(String(a).toLowerCase()) };
    if (NF) FCX.removeFieldFromLayout({}, F, lyOpts);
    if (lyOpts.refused) { rec(comp, { tool: 'REFUSED', text: lyOpts.refused }); }
    else {
      const sw = NF ? R.sftkLayoutReplaceField(metadata, F, NF, { readOnly: false }) : null;
      const changes = NF ? sw.swapped + sw.blanked : FCX.removeFieldFromLayout(metadata, F, lyOpts);
      if (!NF && lyOpts.refused) rec(comp, { tool: 'REFUSED', text: lyOpts.refused });
      else if (!changes) rec(comp, { tool: 'REFUSED', text: 'Field not found in layout sections' });
      else {
        const p = rest('PATCH', `services/data/v62.0/tooling/sobjects/Layout/${id}`, { Metadata: FCX.sanitizeLayoutMetadata(metadata) });
        let sf = p.ok ? 'ACCEPTED' : 'REFUSED', msg = p.ok ? '' : `PATCH: ${errText(p.error)}`;
        if (!p.ok && res.FullName) {
          const d = deployFiles([{ name: 'package.xml', text: FCX.buildLayoutPackageXml(res.FullName) }, { name: `layouts/${res.FullName}.layout`, text: FCX.buildLayoutXml(metadata) }], `${MODE}-layout`);
          sf = d.ok ? 'ACCEPTED (MDAPI fallback)' : 'REFUSED'; msg += ` | deploy: ${d.fails.join(' | ') || d.raw || 'ok'}`;
        }
        rec(comp, { tool: 'APPLIED', how: `changes ${changes}${sw ? ` (swapped ${sw.swapped}, blanked ${sw.blanked})` : ''}`, sf, msg });
      }
    }
  } catch (e) { rec(comp, { tool: 'ERROR', text: String(e.stack || e).slice(0, 500) }); }
}

// ── FlexiPage (Tooling PATCH) ──────────────────────────────────────────────────
if (!ONLY || ONLY.test('FlexiPage:')) {
  const comp = 'FlexiPage SFTK_MX_Account_Page';
  try {
    const id = tq("SELECT Id FROM FlexiPage WHERE DeveloperName = 'SFTK_MX_Account_Page'")[0].Id;
    const res = rest('GET', `services/data/v62.0/tooling/sobjects/FlexiPage/${id}`).body;
    const metadata = JSON.parse(JSON.stringify(res.Metadata));
    const left = {};
    let changes, how;
    if (NF) { const sw = FCX.replaceFieldInFlexiPage(metadata, OBJ, F, NF, left, ''); changes = sw.swapped + sw.dropped; how = `swapped ${sw.swapped} dropped ${sw.dropped} left ${sw.left}`; }
    else { changes = FCX.removeFieldFromFlexiPage(metadata, OBJ, F, left, ''); how = `removed ${changes}`; }
    if (!changes) rec(comp, { tool: 'REFUSED', text: `no direct references; left ${JSON.stringify(left)}` });
    else {
      const p = rest('PATCH', `services/data/v62.0/tooling/sobjects/FlexiPage/${id}`, { Metadata: metadata });
      rec(comp, { tool: 'APPLIED', how: `${how}; left ${JSON.stringify(left)}`, sf: p.ok ? 'ACCEPTED' : 'REFUSED', msg: p.ok ? '' : errText(p.error) });
    }
  } catch (e) { rec(comp, { tool: 'ERROR', text: String(e.stack || e).slice(0, 500) }); }
}

// ── Reports (Analytics REST) ───────────────────────────────────────────────────
for (const dn of ['SFTK_MX_Report', 'SFTK_MX_Contact_Report'].filter(n => !ONLY || ONLY.test(`Report:${n}`))) {
  const comp = `Report ${dn}`;
  try {
    const id = dq(`SELECT Id FROM Report WHERE DeveloperName = '${dn}'`)[0].Id;
    const d = rest('GET', `services/data/v62.0/analytics/reports/${id}/describe`).body;
    const res = NF ? R.sftkRptReplaceField(d.reportMetadata, OBJ, F, NF, RC.sftkRptTokenMatch, RC.sftkRptFieldHits) : RC.sftkRptStripField(d.reportMetadata, OBJ, F);
    if (!res.changed) { rec(comp, { tool: 'REFUSED', text: `nothing ${NF ? 'that can be moved automatically' : 'auto-removable'} — ${(res.manual || []).join('; ') || 'no editable reference found'}` }); continue; }
    const p = rest('PATCH', `services/data/v62.0/analytics/reports/${id}`, { reportMetadata: res.meta });
    rec(comp, { tool: 'APPLIED', how: NF ? `swapped ${res.swapped}` : `removed ${res.removed}`, manual: res.manual, sf: p.ok ? 'ACCEPTED' : 'REFUSED', msg: p.ok ? '' : errText(p.error) });
  } catch (e) { rec(comp, { tool: 'ERROR', text: String(e.stack || e).slice(0, 500) }); }
}

// ── Email templates (REST PATCH of the changed text fields) ────────────────────
for (const dn of ['SFTK_MX_VF', 'SFTK_MX_Text'].filter(n => !ONLY || ONLY.test(`EmailTemplate:${n}`))) {
  const comp = `EmailTemplate ${dn}`;
  try {
    const id = dq(`SELECT Id FROM EmailTemplate WHERE DeveloperName = '${dn}'`)[0].Id;
    const path = `services/data/v62.0/sobjects/EmailTemplate/${id}`;
    const r0 = rest('GET', `${path}?fields=Id,Name,DeveloperName,TemplateType,UiType,FolderName,Subject,Body,HtmlValue,Markup`).body;
    const r = NF ? TPL.sftkTplReplace(r0, F, NF, OBJ) : TPL.sftkTplRemove(r0, F, OBJ);
    if (r.refused) { rec(comp, { tool: 'REFUSED', text: r.refused }); continue; }
    if (!r.n) { rec(comp, { tool: 'REFUSED', text: 'no merge field that names the field' }); continue; }
    const next = { ...r0, ...r.rec };
    const changed = TPL.sftkTplTextFields().filter(k => !M.sftkMdCodeSame(next[k], r0[k]));
    const after = Object.fromEntries(changed.map(k => [k, next[k]]));
    const p = rest('PATCH', path, after);
    rec(comp, { tool: 'APPLIED', how: `${r.n} merge field(s) in ${r.fields.join(', ')}; PATCHed ${changed.join(', ')}`, sf: p.ok ? 'ACCEPTED' : 'REFUSED', msg: p.ok ? '' : errText(p.error) });
  } catch (e) { rec(comp, { tool: 'ERROR', text: String(e.stack || e).slice(0, 500) }); }
}

mkdirSync(join(SCR, 'results'), { recursive: true });
writeFileSync(join(SCR, 'results', `${MODE}${ONLY ? '-partial' : ''}.json`), JSON.stringify(out, null, 2));
