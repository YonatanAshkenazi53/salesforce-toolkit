// 🎭 PII on the Deploy page (user 2026-11-07, "its kinda hard": "suggest the policy for ALL inserted records with a
// good example per field, show which record the example comes from, display the treated values inside ▸ record, and
// offer the suggestion in mass or for one record from its editor"). Live 2026-11-08 on the Leads fixture, npc → npc2
// (scripts/dev/live/pii-deploy.mjs): the example, ▸ record's "written as" and the CLI read of the run all say
// Omer → Lior Martin, lior.martin@falcon.invalid; the audit line is clean; the run rolled back.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const DV = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
const BL = readFileSync(new URL('../studio-builder.js', import.meta.url), 'utf8');
const VE = readFileSync(new URL('../studio-valueedit.js', import.meta.url), 'utf8');
// studio-core's esc is an arrow const (not extractable): the same escaping, for the one pure function under test
globalThis.esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const H = extractFunctions('studio-builder.js', ['bldPiiPreviewHtml']);

describe('the suggestions: the records the deployment inserts, each example named by its record', () => {
  it('the window takes the records (≤200 per object) and reads THOSE, not the newest rows', () => {
    expect(BL).toContain('async function bldOpenPiiSuggestModal(opts) {');
    expect(BL).toContain("const only = byObj ? (byObj[obj] || []).filter(x => /^[A-Za-z0-9]{15,18}$/.test(String(x))).slice(0, 200) : null;");
    expect(BL).toContain('FROM ${obj} WHERE Id IN (${only.map(x => soqlStrLit(x)).join(\',\')})');
  });
  it('an example says which record it comes from', () => {
    const html = H.bldPiiPreviewHtml([{ from: 'Omer', to: 'Lior', rec: 'Omer SFTK CX Lead One' }]);
    expect(html).toContain('Omer</span> → <b class="ds-pii-prev-to" title="Lior">Lior</b> <span class="ds-pii-prev-rec" title="The record this example comes from">in Omer SFTK CX Lead One</span>');
    expect(H.bldPiiPreviewHtml([{ from: 'a', to: 'b' }])).not.toContain('ds-pii-prev-rec');
  });
  it('the Deploy page: 🎭 for all to insert; the rules land on the deployment, which is saved', () => {
    expect(DV).toContain('id="dsDepPiiAll"');
    expect(DV).toContain('for (const [k, ids] of Object.entries(sftkDeployEveryInsert(scan))) { const o = _depObjName(p, k); byObj[o] = [...new Set([...(byObj[o] || []), ...ids])]; }');
    expect(DV).toContain('try { await bldOpenPiiSuggestModal({ recordsByObj, scope }); }');
    expect(DV).toContain("if (p.ephemeral) return showToast('Save this deployment first — the PII policy is part of it.', 'info', 5000);");
  });
});

describe('▸ record: what lands, treated; and the suggestion for this one record', () => {
  it('a covered field says "written as" its treated value, from the same persona the run uses (the name field is read)', () => {
    expect(VE).toContain('const nameCol = ((desc.fields || []).find(f => f.nameField) || {}).name;');
    expect(VE).toContain('const pairs = await bldPiiPreviewPairs(p, obj, f.name, dsc, rule, [srcRec], 1).catch(() => []);');
    expect(VE).toContain('🎭 written as <b>${esc(to)}</b>');
  });
  it('🎭 Suggest PII for this record opens the suggestions on that record alone', () => {
    expect(VE).toContain('id="dsVePiiSug"');
    expect(VE).toContain("window._depPiiSuggest(p, { [obj]: [ids[0]] }, `this record — ${label || ids[0]}`)");
  });
});
