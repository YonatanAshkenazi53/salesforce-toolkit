// QA 1.1 regression run (docs/qa/qa-1.1-regression-result.json), the Field Cleaner lane: finding 9 (a deploy that
// was submitted but not followed to its end was shown as refused, with no undo), finding 17 (a hand edit that took
// the field out left the row saying nothing was changed) and the field-cleaner.js part of C1 (two CSV files wrote
// org text raw).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const F = extractFunctions('field-cleaner.js', ['fcCsvCell', 'fcCsvSafeTargets', 'fcHandEditGoneLabel', 'fcDoneParts']);
const count = s => FC.split(s).length - 1;
// an inner function of the FieldCleaner module (two-space indent, closes with a brace at two spaces), run with its
// free names handed in — the way test/regress-1115-close-r3.test.mjs runs fixReportType
const FCN = FC.split('\r\n').join('\n');
const nested = name => {
  const at = FCN.indexOf(`\n  function ${name}(`) >= 0 ? FCN.indexOf(`\n  function ${name}(`) : FCN.indexOf(`\n  async function ${name}(`);
  if (at < 0) throw new Error(`not found in field-cleaner.js: ${name}`);
  return FCN.slice(at + 1, FCN.indexOf('\n  }\n', at + 1) + 4);
};
const runNested = (name, deps) => new Function('D', `const { ${Object.keys(deps).join(', ')} } = D;\n${nested(name)}\nreturn ${name};`)(deps);
// sftkWriteVerified as sftk-write.js decides it: an answer with an error is not accepted, whatever else it carries
const writeVerified = async o => { const raw = await o.write(); if (!raw || raw.error) return { accepted: false, ok: false, raw }; const v = await o.verify(); return { accepted: true, ok: !!v.ok, raw }; };
const SUBMITTED = { error: 'Deployment 0Af000000000001 was submitted but its result could not be read. It MAY STILL FINISH in Salesforce.', submitted: true, jobId: '0Af000000000001' };
const REFUSED = { error: 'INVALID_CROSS_REFERENCE_KEY: no such field' };

describe('finding 9 — a submitted deploy is not a refusal', () => {
  it('every write that passes submitted through has a reader of it', () => {
    // eight deploy writes pass the flag on; two (the delete and the code edit) read wr.raw.submitted themselves
    expect(count("...(r && r.submitted ? { submitted: true, jobId: r.jobId || null } : {})")).toBe(8);
    // (the test is written out at each place: tests load fixReportType by name, with no helper of the file in scope)
    expect(count('if (wr.raw && wr.raw.submitted) throw new Error(')).toBe(2);
    expect(count('if (!wr.accepted && wr.raw && wr.raw.submitted) ')).toBe(6);
    expect(count('undo: wr && (wr.accepted || (wr.raw && wr.raw.submitted))')).toBe(6);   // the two restores are themselves the undo
  });
  it('the two expressions, on the three answers: submitted keeps the undo and is not a refusal', () => {
    // the decision as the six places write it, run on the three answers sftkWriteVerified can hand back
    const keeps = wr => !!(wr && (wr.accepted || (wr.raw && wr.raw.submitted)));
    const still = wr => !!(!wr.accepted && wr.raw && wr.raw.submitted);
    const submitted = { accepted: false, ok: false, raw: { error: 'Deployment 0Af was submitted but its result could not be read', submitted: true, jobId: '0Af' } };
    const refused = { accepted: false, ok: false, raw: { error: 'INVALID_CROSS_REFERENCE_KEY' } };
    const accepted = { accepted: true, ok: true, raw: { success: true } };
    expect([keeps(submitted), keeps(refused), keeps(accepted), keeps(undefined)]).toEqual([true, false, true, false]);
    expect([still(submitted), still(refused), still(accepted)]).toEqual([true, false, false]);
  });
  it('the XML editor says it is still running, before the refusal line, and keeps the undo', () => {
    const a = FC.indexOf("if (!wr.accepted && wr.raw && wr.raw.submitted) { say('fc-xml-ed-err', `⚠ The deploy was sent and Salesforce is still running it — it is not refused.");
    const b = FC.indexOf("say('fc-xml-ed-err', `❌ Salesforce refused the deploy — nothing was changed.");
    expect(a).toBeGreaterThan(-1); expect(b).toBeGreaterThan(a);
    expect(FC.slice(a, b)).toContain("${esc(String((wr.raw && wr.raw.error) || ''))}");
    expect(FC.slice(a, b)).toContain("return 'submitted'; }");
    expect(FC.slice(b, b + 400)).toContain('undo: wr && (wr.accepted || (wr.raw && wr.raw.submitted))');
  });
  it('the ✂ / ⇄ edit, the search layout and the report type say so before their refusal sentence', () => {
    for (const [still, refusal] of [
      ['if (!wr.accepted && wr.raw && wr.raw.submitted) throw new Error(`The edited ${spec.what} "${componentName}" was sent and Salesforce is still running the deploy.', 'throw new Error(`Salesforce refused the edited ${spec.what}'],
      ['if (!wr.accepted && wr.raw && wr.raw.submitted) throw fail(`The update of the “${componentName}” search layout was sent and Salesforce is still running it.', "throw fail(`Salesforce won't accept the search layout update"],
      ['if (!wr.accepted && wr.raw && wr.raw.submitted) throw fail(`The update of the report type "${componentName}" was sent and Salesforce is still running it.', "throw fail(`Salesforce won't accept the report type update"],
    ]) {
      const a = FC.indexOf(still), b = FC.indexOf(refusal);
      expect(a).toBeGreaterThan(-1); expect(b).toBeGreaterThan(a);
      expect(FC.slice(a, b)).toContain('The restore point is kept and Undo is in Activity.');
      expect(FC.slice(b, b + 600)).toContain('undo: wr && (wr.accepted || (wr.raw && wr.raw.submitted))');
    }
  });
  // The real functions, run on the three answers the background can give.
  const xmlEditor = answer => {
    const S = { undo: null, snaps: 0, out: { innerHTML: '' } };
    const fn = runNested('_xmlEditorDeploy', {
      _xmlWellFormed: () => null, _RULE_CONTAINERS: {}, sftkMdChildText: () => 'Account-Main',
      sftkMdEditFiles: (t, f, x) => [{ name: f, data: x }], sftkMdPretty: x => x,
      sftkMdLineDiff: () => [{ op: '-', line: '<a>1</a>' }, { op: '+', line: '<a>2</a>' }],
      sftkOrgWriteGate: async () => ({ production: false }), sftkConfirmDestructive: async () => true,
      _xmlDiffHtml: () => '', _mdReadMsg: () => ({}), _rxEsc: s => s, _zipOf: () => 'zip',
      _snapshotFix: async () => { S.snaps++; }, sftkHistoryBegin: () => ({}), sftkHistoryEnd: async (j, end) => { S.undo = end.undo; },
      sftkWriteVerified: writeVerified, bg: async () => answer, _mdReadOne: async () => ({ rec: { innerXml: '<a>2</a>' } }),
      esc: s => String(s).split('<').join('&lt;'), _orgUrl: 'https://x.my.salesforce.com/', _sid: 's',
    });
    const ctx = { type: 'Layout', componentId: '00h1', componentName: 'Main', fullName: 'Account-Main', spec: { what: 'page layout', mdType: 'Layout' }, xml: '<a>1</a>' };
    return fn(ctx, '<a>2</a>', S.out).then(r => ({ r, S }));
  };
  it('the XML editor, run: a submitted deploy is not called refused and its History entry keeps the undo step', async () => {
    const { r, S } = await xmlEditor(SUBMITTED);
    expect(r).toBe('submitted');
    expect(S.snaps).toBe(1);
    expect(S.out.innerHTML).toContain('Salesforce is still running it');
    expect(S.out.innerHTML).toContain('MAY STILL FINISH');
    expect(S.out.innerHTML).not.toContain('Salesforce refused the deploy');
    expect(S.out.innerHTML).not.toContain('nothing was changed');
    expect(S.undo.none).toBeUndefined();
    expect(S.undo.steps).toHaveLength(1);
    expect(S.undo.steps[0].msg).toEqual({ type: 'SF_METADATA_DEPLOY', zipBase64: 'zip' });
  });
  it('the XML editor, run: a real refusal still says refused with nothing to undo; an accepted one is deployed', async () => {
    const no = await xmlEditor(REFUSED);
    expect(no.r).toBe('refused');
    expect(no.S.out.innerHTML).toContain('Salesforce refused the deploy — nothing was changed');
    expect(no.S.undo).toEqual({ none: 'nothing was accepted by Salesforce, so there is nothing to undo' });
    const yes = await xmlEditor({ success: true });
    expect(yes.r).toBe('deployed');
    expect(yes.S.undo.steps).toHaveLength(1);
  });
  const reportType = answer => {
    const S = { undo: null };
    const before = '<fullName>Acc_X</fullName><baseObject>Account</baseObject><sections><columns><field>Region__c</field><table>Account</table></columns><masterLabel>A</masterLabel></sections>';
    const fn = runNested('fixReportType', {
      _lastScan: { deps: [{ MetadataComponentType: 'ReportType', MetadataComponentId: 'Acc_X', _fullName: 'Acc_X', _managed: '' }] },
      _orgUrl: 'https://x.my.salesforce.com/', _sid: 's', _selObj: { api: 'Account' }, _selField: { api: 'Region__c' }, _replField: { api: 'Area__c' },
      _swapOn: () => false, readReportType: async () => before, sftkMdFamObj: o => o,
      sftkRtRemoveField: () => ({ changed: 1, xml: '<fullName>Acc_X</fullName>', viaLookup: [], skipped: [] }), sftkRtReplaceField: () => ({}), sftkRtMentions: () => 0,
      _snapshotFix: async () => {}, buildReportTypeZip: (n, x) => x, sftkMdRecordFileXml: (t, x) => x,
      sftkHistoryBegin: () => ({}), sftkHistoryEnd: async (j, end) => { S.undo = end.undo; },
      bg: async () => answer, sftkWriteVerified: writeVerified, _rxEsc: s => s, _feText: s => s,
    });
    return { run: fn('Acc_X', 'Accounts X'), S };
  };
  it('the report type fix, run: submitted says it is still running and keeps the undo; refused keeps its sentence and has none', async () => {
    const sub = reportType(SUBMITTED);
    await expect(sub.run).rejects.toThrow(/was sent and Salesforce is still running it\. .*The restore point is kept and Undo is in Activity\./);
    expect(sub.S.undo.none).toBeUndefined();
    expect(sub.S.undo.steps).toHaveLength(1);
    const ref = reportType(REFUSED);
    await expect(ref.run).rejects.toThrow(/Salesforce won't accept the report type update/);
    expect(ref.S.undo.steps).toBeUndefined();
    expect(typeof ref.S.undo.none).toBe('string');
  });
  it('a restore that is still running is not reported with the bare error', () => {
    expect(count("if (!wr.accepted && wr.raw && wr.raw.submitted) throw new Error('The restore was sent and Salesforce is still running it — it is not refused.")).toBe(2);
  });
});

describe('finding 17 — a hand edit that takes the field out is a change on the row', () => {
  it('the label reads as a change: its own verb, verified, and not the settled sentence', () => {
    const l = F.fcHandEditGoneLabel('page layout');
    expect(l).toContain('nothing in this page layout uses the field any more');
    expect(F.fcDoneParts(l)).toEqual({ verb: 'Edited', detail: 'your edit is in the org and nothing in this page layout uses the field any more', verified: true });
    // _fixedRowChanged's own test, as it stands in the source
    expect(FC).toContain("function _fixedRowChanged(label) { return !/^✅ (Nothing uses the field here|No version of this flow references)/.test(String(label || '')); }");
    expect(/^✅ (Nothing uses the field here|No version of this flow references)/.test(l)).toBe(false);
    expect(F.fcHandEditGoneLabel('')).toContain('this component uses');
  });
  it('after a deploy, a row the fresh read settled is marked again as edited; Cancel (no note) changes nothing', () => {
    const a = FC.indexOf('const back = async note => {'), b = FC.indexOf('panel.innerHTML', a);
    const body = FC.slice(a, b);
    expect(body.indexOf('await toggleXmlInspector(type, componentId, componentName, fieldId);')).toBeGreaterThan(-1);
    expect(body.indexOf('if (!note) return;')).toBeGreaterThan(body.indexOf('await toggleXmlInspector('));
    expect(body).toContain("if (row && row.classList.contains('fc-item-fixed') && !_fixedRowChanged(row.querySelector('.fc-item-ok')?.dataset.label)) { markFixed(componentId, fcHandEditGoneLabel(spec.what)); return; }");
  });
});

describe('finding 17 — the editor\'s way back, run', () => {
  // _jsonKindEditorOpen with a stand-in page: the fresh 🔍 read is `S.reread`, the row is `S.row`
  const open = async S => {
    const hdr = { addEventListener() {}, insertAdjacentHTML: (pos, html) => { S.notes.push(html); } };
    const panel = { style: {}, innerHTML: '', querySelector: () => hdr };
    const row = { classList: { contains: c => c === 'fc-item-fixed' && S.fixed }, querySelector: () => ({ dataset: { label: S.label } }) };
    const changedSrc = FC.match(/function _fixedRowChanged\(label\) \{[^\n]*\}/)[0];
    const fn = runNested('_jsonKindEditorOpen', {
      sftkMdJsonKindEditSpec: () => ({ what: 'page layout', mdType: 'Layout' }), _mdReadOne: async () => ({ rec: { innerXml: '<a/>' } }),
      esc: s => String(s), _xmlEditorOpen: (p, ctx) => { S.back = ctx.back; }, toggleXmlInspector: async () => { if (S.reread) S.reread(); },
      eid: () => row, _fixedRowChanged: new Function(`${changedSrc}\nreturn _fixedRowChanged;`)(),
      markFixed: (id, label) => { S.marked.push([id, label]); }, fcHandEditGoneLabel: F.fcHandEditGoneLabel,
    });
    await fn('Layout', '00h1', 'Main', '00N1', 'Account-Main', panel, null);
    return S;
  };
  const SETTLED = '✅ Nothing uses the field here — Salesforce lists it because its description or another text mentions the field’s name. Nothing to remove.';
  it('the edit took every use out: the row the fresh read settled is marked as edited, with the label that gives it Undo', async () => {
    const S = await open({ notes: [], marked: [], fixed: false, label: '' });
    S.reread = () => { S.fixed = true; S.label = SETTLED; };
    await S.back('✅ Deployed — …');
    expect(S.marked).toEqual([['00h1', F.fcHandEditGoneLabel('page layout')]]);
    expect(S.notes).toEqual([]);
  });
  it('a mention remains (the row stays open): the note goes into the panel and the row is not marked', async () => {
    const S = await open({ notes: [], marked: [], fixed: false, label: '' });
    await S.back('✅ Deployed — …');
    expect(S.marked).toEqual([]);
    expect(S.notes).toHaveLength(1);
    expect(S.notes[0]).toContain('✅ Deployed');
  });
  it('Cancel (no note) marks nothing, even when the fresh read settles the row; a row already marked as a change is left', async () => {
    const S = await open({ notes: [], marked: [], fixed: false, label: '' });
    S.reread = () => { S.fixed = true; S.label = SETTLED; };
    await S.back('');
    expect(S.marked).toEqual([]);
    expect(S.notes).toEqual([]);
    const T = await open({ notes: [], marked: [], fixed: true, label: '✅ Removed — the field is out of the page layout — verified by re-reading the org' });
    await T.back('✅ Deployed — …');
    expect(T.marked).toEqual([]);
  });
});

describe('C1 — the value backup and the copy receipt never hold a formula cell', () => {
  it('fcCsvCell: a text that starts with = + - @ tab or CR gets an apostrophe, then the usual quoting', () => {
    expect(F.fcCsvCell('=HYPERLINK("http://x.example","open")')).toBe('"\'=HYPERLINK(""http://x.example"",""open"")"');
    expect(F.fcCsvCell('+972 52 1234567')).toBe("'+972 52 1234567");
    expect(F.fcCsvCell('-5')).toBe("'-5");
    expect(F.fcCsvCell('@name')).toBe("'@name");
    expect(F.fcCsvCell('\t=1+1')).toBe("'\t=1+1");
    expect(F.fcCsvCell('\r=1+1')).toBe('"\'\r=1+1"');
  });
  it('fcCsvCell: everything else is as before — a number stays a number, a CR is quoted', () => {
    expect(F.fcCsvCell(-5)).toBe('-5');
    expect(F.fcCsvCell(null)).toBe('');
    expect(F.fcCsvCell(undefined)).toBe('');
    expect(F.fcCsvCell(true)).toBe('true');
    expect(F.fcCsvCell('Acme, Inc.')).toBe('"Acme, Inc."');
    expect(F.fcCsvCell('a = b')).toBe('a = b');
    expect(F.fcCsvCell('line\rtwo')).toBe('"line\rtwo"');
  });
  it('fcCsvSafeTargets: both org values guarded, in new rows — what is written to the org is untouched', () => {
    const targets = [{ Id: '001', value: '=1+1', was: '@old' }, { Id: '002', value: -3, was: null }, { Id: '003', value: 'plain', was: '+1' }];
    const safe = F.fcCsvSafeTargets(targets);
    expect(safe).toEqual([{ Id: '001', value: "'=1+1", was: "'@old" }, { Id: '002', value: -3, was: null }, { Id: '003', value: 'plain', was: "'+1" }]);
    expect(targets[0]).toEqual({ Id: '001', value: '=1+1', was: '@old' });
    expect(safe[0]).not.toBe(targets[0]);
    expect(F.fcCsvSafeTargets(null)).toEqual([]);
  });
  it('both files are built through the guard, and the old raw cell writer is gone', () => {
    expect(FC).toContain("const body = rows.map(r => cols.map(c => fcCsvCell(r[c])).join(',')).join('\\r\\n');");
    expect(FC).toContain('new Blob([sftkCopyValuesCsv(to, fcCsvSafeTargets(targets))]');
    expect(FC).not.toContain('const esc2 = v =>');
    expect(FC).not.toContain('sftkCopyValuesCsv(to, targets)');
  });
  it('both places say the apostrophe is added', () => {
    expect(count("is written with an apostrophe (') in front, so a spreadsheet shows it as text and does not run it as a formula.")).toBe(2);
  });
});
