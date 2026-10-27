// ✏ Typed values (user 2026-10-27: "make all the fields editable in every operation.
// change or insert. along with lookups. so users can edit them and align data" /
// "one or many"): the storage helpers behave; the engine and the overwrite write
// them; the Deploy page offers them on Insert and Changed rows and for a selection;
// the export strips them like the lookup picks.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const V = extractFunctions('sftk-valueedit.js', ['sftkValOvBucket', 'sftkValOvGet', 'sftkValOvSet', 'sftkValOvClear', 'sftkValOvCount', 'sftkValOvApply', 'sftkValEditFields', 'sftkValOvText'], { 'sftk-org-identity.js': ['sftkOrgKey'] });
const TGT = 'https://seven.develop.my.salesforce.com';

describe('the storage: per target org, per source record, per source field', () => {
  it('set / get / clear round-trip; null is a value (write empty); a cleared node carries no key', () => {
    const node = {};
    V.sftkValOvSet(node, TGT, 'S1', 'Phone', '555');
    V.sftkValOvSet(node, TGT, 'S1', 'Fax', null);
    expect(V.sftkValOvGet(node, TGT, 'S1')).toEqual({ Phone: '555', Fax: null });
    expect(V.sftkValOvGet(node, TGT, 'S2')).toEqual({});
    expect(V.sftkValOvCount(node, TGT)).toEqual({ records: 1, values: 2 });
    V.sftkValOvClear(node, TGT, 'S1', 'Phone');
    expect(V.sftkValOvGet(node, TGT, 'S1')).toEqual({ Fax: null });
    V.sftkValOvSet(node, TGT, 'S1', 'Fax', undefined);   // undefined clears
    expect(node.valueOverrides).toBeUndefined();
  });
  it('one bucket per org identity, whatever spelling the url had', () => {
    const node = { valueOverrides: { 'https://seven.develop.my.salesforce.com/': { S1: { Phone: '1' } } } };
    V.sftkValOvSet(node, 'https://seven.develop.lightning.force.com', 'S2', 'Phone', '2');
    expect(Object.keys(node.valueOverrides).length).toBe(1);
    expect(V.sftkValOvGet(node, TGT, 'S2')).toEqual({ Phone: '2' });
    V.sftkValOvClear(node, TGT, 'S1');   // the whole record
    expect(V.sftkValOvGet(node, TGT, 'S1')).toEqual({});
  });
});

describe('the write: mapped names, the target\'s field set, the PII policy wins', () => {
  it('writes under the mapped name, skips an excluded or untakeable field, counts a masked one', () => {
    const p = { Name: 'A', Phone: 'src' };
    const r = V.sftkValOvApply(p, { Phone: '555', Old__c: 'x', Gone__c: 'y', Email: 'e@x' }, { Old__c: null, Phone: 'Phone2__c' }, new Set(['Name', 'Phone2__c', 'Email']), sf => sf === 'Email');
    expect(p).toEqual({ Name: 'A', Phone: 'src', Phone2__c: '555' });
    expect(r).toEqual({ used: 1, masked: 1, skipped: ['Old__c', 'Gone__c'] });
  });
  it('null is written (clears the field); no allowed set means every field passes', () => {
    const p = {};
    expect(V.sftkValOvApply(p, { Fax: null }, {}, null, null).used).toBe(1);
    expect(p).toEqual({ Fax: null });
  });
});

describe('the fields a person may type', () => {
  const desc = [
    { name: 'Id', createable: false, updateable: false, type: 'id' },
    { name: 'Name', label: 'Account Name', createable: true, updateable: true, type: 'string', nameField: true },
    { name: 'Phone', label: 'Phone', createable: true, updateable: true, type: 'phone' },
    { name: 'OwnerId', createable: true, updateable: true, type: 'reference' },
    { name: 'ParentId', label: 'Parent', createable: true, updateable: true, type: 'reference', referenceTo: ['Account'], relationshipName: 'Parent' },
    { name: 'Formula__c', createable: false, updateable: false, calculated: true, type: 'string' },
    { name: 'BillingAddress', createable: false, updateable: false, type: 'address' },
    { name: 'Industry', label: 'Industry', createable: true, updateable: true, type: 'picklist', picklistValues: [{ value: 'Tech', label: 'Tech', active: true }, { value: 'Old', active: false }] },
    { name: 'Locked__c', label: 'Locked', createable: true, updateable: false, type: 'string' },
    { name: 'Excluded__c', label: 'Excluded', createable: true, updateable: true, type: 'string' },
  ];
  it('insert: createable, never system/owner/formula/compound, never an excluded field; the name first; lookups listed', () => {
    const f = V.sftkValEditFields(desc, { Excluded__c: null }, 'ins');
    expect(f.map(x => x.name)).toEqual(['Name', 'Industry', 'Locked', 'ParentId', 'Phone'].map(n => n === 'Locked' ? 'Locked__c' : n));
    expect(f.find(x => x.name === 'ParentId')).toMatchObject({ reference: true, refTo: ['Account'], relationshipName: 'Parent' });
    expect(f.find(x => x.name === 'Industry').picklist).toEqual([{ value: 'Tech', label: 'Tech' }]);   // label + API name, active only
  });
  it('update: updateable only', () => {
    expect(V.sftkValEditFields(desc, {}, 'chg').map(x => x.name)).not.toContain('Locked__c');
  });
  it('a value in words', () => {
    expect(V.sftkValOvText(null)).toBe('(empty)');
    expect(V.sftkValOvText(true)).toBe('true');
    expect(V.sftkValOvText('x'.repeat(70))).toMatch(/…$/);
  });
});

describe('the engine and the overwrite write them', () => {
  const BG = read('background.js'), RC = read('studio-reconcile.js');
  it('insert payloads: read per target org, applied after the engine\'s own values and before the identity stamp, PII wins, counted', () => {
    expect(BG).toContain('const valOverrides = (() => {');
    expect(BG).toContain('const all = node.valueOverrides;');
    const i = BG.indexOf('const valOv = valOverrides && valOverrides[r.Id]');
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(BG.indexOf('// 🪪 IDENTITY STAMP'));
    expect(i).toBeGreaterThan(BG.indexOf('if (wantOwners) {', BG.indexOf('const payloads = recs.map(')));
    expect(BG).toContain("if (piiRules && piiRules[String(sf).toLowerCase()]) { valOverridesMasked++; continue; }");
    expect(BG).toContain('if (tgtCreatable.size && !tgtCreatable.has(tf)) { skippedForTarget.add(tf); continue; }\n            if (piiRules');
    expect(BG).toContain('value(s) typed on the Deploy page were written in place of the source\'s.');
    expect(BG).toContain('typed value(s) were NOT written — the PII policy covers those fields and wins.');
  });
  it('overwrite: the bucket, the target\'s updateable set, the PII rule, the counts in the warnings', () => {
    expect(RC).toContain("const valOv = (typeof sftkValOvBucket === 'function') ? sftkValOvBucket(node, profile.targetOrg) : null;");
    expect(RC).toContain('const tgtUpdOk = tgtUpdMap ? new Set([...tgtUpdMap].filter(([, u]) => u === true).map(([k]) => k)) : null;');
    expect(RC).toContain('const vr = sftkValOvApply(p, valForRec, fm, tgtUpdOk, sf => piiActive && !!piiRules[String(sf).toLowerCase()]);');
    expect(RC).toContain("if (!srcFields.length && !refPairs.length && !wantOwners && !(valOv && Object.keys(valOv).length)) {");
    expect(RC).toContain('value(s) typed on the Deploy page written in place of the source\'s`');
  });
  it('every rebuilt tree node carries them, like the lookup picks', () => {
    expect((RC.match(/valueOverrides: a\.node\.valueOverrides \|\| \{\}/g) || []).length).toBe(2);
    expect((RC.match(/lookupOverrides: (?:_att\.overrides|a\.node\.lookupOverrides \|\| \{\})/g) || []).length).toBe(2);
  });
});

describe('the Deploy page', () => {
  const DV = read('studio-deploy.js'), VE = read('studio-valueedit.js'), HTML = read('studio.html'), CSS = read('studio.css');
  it('a ✏ values button on every Insert and Changed row, lit with a count when the record carries typed values', () => {
    expect(DV).toContain('const valN = id => Object.keys(sftkValOvGet(node, p.targetOrg, id)).length;');
    expect(DV).toContain('tail = `${valBtn(r.sourceId, null)} ${lkpBtn(r.sourceId, null)}`;');
    // the Changed row has ONE record link (it opens the editor too) carrying the typed count — no second link (user 2026-10-27)
    expect(DV).toContain('>▸ record<span class="ds-lkp-count">${valN(r.sourceId) ? ` ✏ ${valN(r.sourceId)}` : \'\'}</span></button> ${lkpBtn(r.sourceId, r.targetId)}`;');
    expect(DV).not.toContain('${valBtn(r.sourceId, r.targetId)}');
    expect(DV).toContain('>✏ values<span class="ds-lkp-count">${valN(id) ? ` ${valN(id)}` : \'\'}</span></button>');
  });
  it('one or many: the row opens one record; the toolbar button opens every ticked record of the tab', () => {
    expect(DV).toContain("sftkOpenValueEditor(prof, cur.obj, node, [srcId], b.dataset.depValsTgt || null, row ? key(row) : srcId, tabDef.k === 'chg' ? 'chg' : 'ins', repaint);");
    expect(DV).toContain("const set = tabDef.k === 'chg' ? (isRoot ? _recSel.overwrite : sel.overwrite) : (isRoot ? _recSel.push : sel.push);");
    expect(DV).toContain("sftkOpenValueEditor(prof, cur.obj, node, ids, null, null, tabDef.k === 'chg' ? 'chg' : 'ins', repaint);");
    expect((DV.match(/data-dep-vals-many="1"/g) || []).length).toBe(2);   // Insert and Changed toolbars
  });
  it('the dialog: every writable field, source and target values, a box, ∅ for empty, lookups picked from the target, typed values checked before they are stored', () => {
    expect(VE).toContain('async function sftkOpenValueEditor(p, obj, node, srcIds, tgtId, label, mode, onSaved, opts)');
    // 2026-10-27 "also here": the record compare opens it — on the whole record, or on one row's field
    const RC2 = read('studio-reconcile.js'), SC = read('studio-scan.js');
    expect(RC2).toContain('async function sftkOpenDriftCompare(prof, obj, srcId, tgtId, srcFields, tgtFields, keyLabel, fallbackFields, editable)');
    expect(RC2).toContain("const openEditor = focus => sftkOpenValueEditor(prof, obj, prof.tree, [srcId], tgtId, keyLabel || srcId, 'chg', null, { focus });");
    expect(RC2).toContain("body.querySelectorAll('[data-dc-edit]').forEach(b => b.addEventListener('click', () => openEditor(b.dataset.dcEdit)));");
    expect(SC).toContain('${editable ? ` <button class="ds-dc-edit" data-dc-edit="${esc(p.srcField)}"');
    expect(DV).toContain("row?.fields || [], tabDef.k === 'chg');");
    expect(VE).toContain('const focus = opts && opts.focus;');
    expect(VE).toContain('const fields = sftkValEditFields(desc.fields, fm, mode);');
    expect(VE).toContain("SELECT Id, Name FROM ${refObj}${like} ORDER BY Name LIMIT 8");
    expect(VE).toContain('for (const id of ids) sftkLkpOvSet(node, p.targetOrg, id, field, h.dataset.veHit);');
    expect(VE).toContain('const r = sftkMergeCoerce(inp.dataset.veType, text);');
    expect(VE).toContain("if (tr.classList.contains('ds-ve-null-on')) { picks.push([field, null]); return; }");
    expect(VE).toContain('for (const id of ids) for (const [field, v] of picks) { if (v === undefined) sftkValOvClear(node, p.targetOrg, id, field); else { sftkValOvSet(node, p.targetOrg, id, field, v); n++; } }');
    expect(VE).toContain("if (!p.ephemeral && typeof storageSaveProfiles === 'function') await storageSaveProfiles();");
    expect(VE).toContain('is not changed, so after the run a record with a typed value differs from its source and is listed under 🟡 Changed until the orgs agree.');
  });
  it('the files are loaded before the Deploy page; the styles exist; the export strips them', () => {
    expect(HTML.indexOf('sftk-valueedit.js')).toBeLessThan(HTML.indexOf('studio-valueedit.js'));
    expect(HTML.indexOf('studio-valueedit.js')).toBeLessThan(HTML.indexOf('studio-deploy.js'));
    for (const c of ['.ds-ve-tools {', '.ds-ve-row-on > th {', '.ds-ve-edit {', '.ds-ve-foot {']) expect(CSS).toContain(c);
    expect(read('studio-builder.js')).toContain('delete node.valueOverrides;');
  });
});
