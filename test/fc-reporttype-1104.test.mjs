// FIELD CLEANER FIXES CUSTOM REPORT TYPES (user 2026-11-04: "what can we do
// with report types?" → "add it to the backlog" → built the same evening).
//
// A report type has no Tooling read and no REST retrieve: it is read with
// SOAP readMetadata (sftk-mdapi.js parses the answer) and written back with
// the REST deploy the layouts use. The edit is on the XML TEXT — nothing is
// parsed and re-serialised, so nothing can be silently reinterpreted.
// Live facts the code rests on (npc, 2026-11-04): the dependency index does
// NOT list a field's report types (layout + flows only), and a column may
// appear ONCE per report type ("Column X on table Account appears more than
// once" refused the deploy).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions, extractFunction } from './extract.mjs';

const F = extractFunctions('sftk-mdapi.js', [
  'sftkMdUnescape', 'sftkMdEscape', 'sftkMdFindElement', 'sftkMdChildText',
  'sftkMdExtractRecords', 'sftkMdRecordFileXml',
  'sftkRtEdit', 'sftkRtMentions', 'sftkRtRemoveField', 'sftkRtReplaceField', 'sftkRtZipFiles',
]);

// The fixture report type as readMetadata hands it back (one record, the
// nil answer for a name that does not exist beside it). Base object Account;
// the test field is the only column of its own section; a joined Contacts
// section carries a same-named field under ANOTHER table.
const INNER = `
      <fullName>SFTK_FC_Test_RT</fullName>
      <baseObject>Account</baseObject>
      <category>accounts</category>
      <deployed>true</deployed>
      <join><outerJoin>true</outerJoin><relationship>Contacts</relationship></join>
      <label>SFTK FC Test Accounts</label>
      <sections>
        <columns><checkedByDefault>true</checkedByDefault><field>Name</field><table>Account</table></columns>
        <columns><checkedByDefault>false</checkedByDefault><field>Industry</field><table>Account</table></columns>
        <masterLabel>Accounts</masterLabel>
      </sections>
      <sections>
        <columns><checkedByDefault>false</checkedByDefault><field>SFTK_FC_Test_Status__c</field><table>Account</table></columns>
        <masterLabel>Only the test field</masterLabel>
      </sections>
      <sections>
        <columns><checkedByDefault>false</checkedByDefault><field>Name</field><table>Account.Contacts</table></columns>
        <columns><checkedByDefault>false</checkedByDefault><field>SFTK_FC_Test_Status__c</field><table>Account.Contacts</table></columns>
        <masterLabel>Contacts</masterLabel>
      </sections>`;
const SOAP = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body><readMetadataResponse><result><records xsi:type="ReportType">${INNER}</records><records xsi:type="ReportType"><fullName xsi:nil="true"/></records></result></readMetadataResponse></soapenv:Body></soapenv:Envelope>`;

const OBJ = 'Account', FIELD = 'SFTK_FC_Test_Status__c', NEW = 'SFTK_FC_Test_Status2__c';
const cols = xml => [...xml.matchAll(/<columns>[\s\S]*?<\/columns>/g)].map(m => {
  const f = m[0].match(/<field>([^<]*)<\/field>/)[1], t = m[0].match(/<table>([^<]*)<\/table>/)[1];
  return `${t}.${f}`;
});

describe('reading the type back out of the SOAP answer', () => {
  it('one record with its developer name; the nil answer is an absence, not a record', () => {
    const r = F.sftkMdExtractRecords(SOAP);
    expect(r.records).toHaveLength(1);
    expect(r.records[0].fullName).toBe('SFTK_FC_Test_RT');
    expect(r.nameless).toBe(1);
    expect(F.sftkMdChildText(r.records[0].innerXml, 'label')).toBe('SFTK FC Test Accounts');
  });
  it('counts the column of THIS object only — the joined table’s same-named field is not it', () => {
    expect(F.sftkRtMentions(INNER, OBJ, FIELD)).toBe(1);
    expect(F.sftkRtMentions(INNER, 'account', 'sftk_fc_test_status__c')).toBe(1);   // case does not matter
    expect(F.sftkRtMentions(INNER, OBJ, NEW)).toBe(0);
    expect(F.sftkRtMentions(INNER, 'Contact', FIELD)).toBe(0);
  });
});

describe('✂ Remove', () => {
  const r = F.sftkRtRemoveField(INNER, OBJ, FIELD);
  it('drops the column and says so', () => {
    expect(r.changed).toBe(true);
    expect(r.removed).toBe(1);
    expect(F.sftkRtMentions(r.xml, OBJ, FIELD)).toBe(0);
  });
  it('a section left with no columns goes with its last column, and is named', () => {
    expect(r.emptied).toEqual(['Only the test field']);
    expect(r.xml).not.toContain('Only the test field');
    expect(r.xml).toContain('<masterLabel>Accounts</masterLabel>');
    expect(r.xml).toContain('<masterLabel>Contacts</masterLabel>');
  });
  it('the joined table’s same-named column is left alone and named', () => {
    expect(cols(r.xml)).toEqual(['Account.Name', 'Account.Industry', 'Account.Contacts.Name', `Account.Contacts.${FIELD}`]);
    expect(r.skipped).toEqual([`Account.Contacts.${FIELD} in “Contacts”`]);
  });
  it('everything else is re-emitted byte for byte', () => {
    const head = INNER.slice(0, INNER.indexOf('<sections>'));
    expect(r.xml.startsWith(head)).toBe(true);
    expect(r.xml).toContain('<join><outerJoin>true</outerJoin><relationship>Contacts</relationship></join>');
  });
  it('no column of the field → nothing changed, nothing dropped', () => {
    const n = F.sftkRtRemoveField(INNER, OBJ, 'Nope__c');
    expect(n.changed).toBe(false);
    expect(n.removed).toBe(0);
    expect(n.emptied).toEqual([]);
    expect(n.xml).toBe(INNER);
  });
  it('a section keeps living when other columns stay', () => {
    const n = F.sftkRtRemoveField(INNER, OBJ, 'Industry');
    expect(n.removed).toBe(1);
    expect(n.emptied).toEqual([]);
    expect(cols(n.xml)).toContain('Account.Name');
    expect(cols(n.xml)).not.toContain('Account.Industry');
  });
});

describe('⇄ Replace', () => {
  it('renames the column in place — same section, same slot, same checkedByDefault', () => {
    const r = F.sftkRtReplaceField(INNER, OBJ, FIELD, NEW);
    expect(r.changed).toBe(true);
    expect(r.swapped).toBe(1);
    expect(r.dropped).toBe(0);
    expect(r.newAlreadyThere).toBe(false);
    expect(r.emptied).toEqual([]);
    expect(F.sftkRtMentions(r.xml, OBJ, FIELD)).toBe(0);
    expect(F.sftkRtMentions(r.xml, OBJ, NEW)).toBe(1);
    expect(r.xml).toContain(`<columns><checkedByDefault>false</checkedByDefault><field>${NEW}</field><table>Account</table></columns>\n        <masterLabel>Only the test field</masterLabel>`);
    expect(r.skipped).toEqual([`Account.Contacts.${FIELD} in “Contacts”`]);   // the joined column is not renamed
  });
  it('when the new field is already a column, the old column is removed instead — a column may appear once', () => {
    const r = F.sftkRtReplaceField(INNER, OBJ, FIELD, 'Industry');
    expect(r.newAlreadyThere).toBe(true);
    expect(r.swapped).toBe(0);
    expect(r.dropped).toBe(1);
    expect(r.emptied).toEqual(['Only the test field']);
    expect(F.sftkRtMentions(r.xml, OBJ, 'Industry')).toBe(1);   // still once
    expect(F.sftkRtMentions(r.xml, OBJ, FIELD)).toBe(0);
  });
  it('the new name is XML-escaped on the way in', () => {
    const r = F.sftkRtReplaceField(INNER, OBJ, FIELD, 'A&B__c');
    expect(r.xml).toContain('<field>A&amp;B__c</field>');
  });
});

describe('the deploy package', () => {
  it('the record becomes a ReportType file without its fullName; the zip holds package.xml and reportTypes/<name>.reportType', () => {
    const file = F.sftkMdRecordFileXml('ReportType', F.sftkRtRemoveField(INNER, OBJ, FIELD).xml);
    expect(file.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<ReportType xmlns="http://soap.sforce.com/2006/04/metadata">')).toBe(true);
    expect(file).not.toContain('<fullName>');
    expect(file.endsWith('</ReportType>')).toBe(true);
    const files = F.sftkRtZipFiles('SFTK_FC_Test_RT', file);
    expect(files.map(f => f.name)).toEqual(['package.xml', 'reportTypes/SFTK_FC_Test_RT.reportType']);
    expect(files[0].text).toContain('<members>SFTK_FC_Test_RT</members>');
    expect(files[0].text).toContain('<name>ReportType</name>');
    expect(files[1].text).toBe(file);
  });
});

describe('the wiring', () => {
  const BG = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
  const POPUP = readFileSync(new URL('../popup.html', import.meta.url), 'utf8');
  const FEAT = readFileSync(new URL('../docs/FEATURES.md', import.meta.url), 'utf8');
  it('the background answers SOAP listMetadata / readMetadata as reads (sfFetch, no write gate), with the fault as the error', () => {
    expect(BG).toContain("SF_MD_LIST:                  { required: ['orgUrl', 'sid', 'mdType'] },");
    expect(BG).toContain("SF_MD_READ:                  { required: ['orgUrl', 'sid', 'mdType', 'fullNames'] },");
    expect(BG).toContain("case 'SF_MD_LIST':");
    expect(BG).toContain("case 'SF_MD_READ':");
    expect(BG).toContain('/services/Soap/m/${ver}');
    expect(BG).toContain("if (fault) return { error: fault[1].trim() };");
    expect(BG).toContain(".slice(0, 10);   // Salesforce's ceiling per call");
    // a read, not a write: the handler never goes through the write gate
    const fn = BG.slice(BG.indexOf('async function sfMetadataSoap'), BG.indexOf('async function sfMetadataList'));
    expect(fn).not.toContain('assertOrgWritable');
    expect(fn).not.toContain('sfFetchWithProxy');
  });
  it('the popup loads the pure helpers before Field Cleaner', () => {
    expect(POPUP.indexOf('<script src="sftk-mdapi.js"></script>')).toBeGreaterThan(0);
    expect(POPUP.indexOf('<script src="sftk-mdapi.js"></script>')).toBeLessThan(POPUP.indexOf('<script src="field-cleaner.js"></script>'));
  });
  it('report types are fixable, read by the scan, dispatched, confirmed with a restore point, restorable, and undone by a redeploy', () => {
    expect(FC).toMatch(/ReportType:\s*\{ icon: '📑', label: 'Report Types',\s*fixable: true, sev: 'silent'/);
    expect(FC).not.toContain('no modern API');
    expect(FC).toContain('rtHits = await scanReportTypes([...deps, ...flexiHits]);');
    expect(FC).toContain('_lastScan = { deps: [...deps, ...flexiHits, ...rtHits, ...supHits], fieldId };');
    expect(FC).toContain("mdType: 'ReportType'");
    expect(FC).toContain("if (type === 'ReportType') label = (await fixReportType(componentId, componentName)) || label;");
    expect(FC).toContain("['Report', 'ReportType', 'Layout', 'FlexiPage'].includes(type)");
    expect(FC).toContain("await _snapshotFix('ReportType', componentId, componentName, fullName, { innerXml: before });");
    expect(FC).toContain("} else if (snap.type === 'ReportType') {");
    expect(FC).toContain("msg: { type: 'SF_METADATA_DEPLOY', zipBase64: zipBefore },");
    // a managed package's type and an index-only row are refused with the Setup link, never guessed at
    expect(FC).toContain('belongs to the managed package ${row._managed}');
    expect(FC).toContain('/lightning/setup/CustomReportTypes/home`;');
  });
  it('the features doc says it', () => {
    expect(FEAT).toContain('**📑 Report types**: every custom report type in the org is read');
    expect(FEAT).not.toContain('report types are listed only when');
  });
});

describe('the undo re-reads the type through SOAP (a third kind of re-read for the undo runner)', () => {
  const HIST = readFileSync(new URL('../sftk-history.js', import.meta.url), 'utf8');
  const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
  const evalFn = extractFunction('sftk-history.js', 'sftkUndoVerifyEval');
  it('a pattern spec is matched against the answer TEXT; an error answer is unverified', () => {
    const spec = { pattern: '<field>Status__c</field>\\s*<table>Account</table>', flags: 'i', text: { ok: 'back', bad: 'not there' } };
    expect(evalFn(spec, { text: '<columns><field>Status__c</field>\n   <table>Account</table></columns>' })).toEqual({ ok: true, text: 'back' });
    expect(evalFn(spec, { text: '<columns><field>status__C</field><table>ACCOUNT</table></columns>' }).ok).toBe(true);
    expect(evalFn(spec, { text: '<columns><field>Other__c</field><table>Account</table></columns>' })).toEqual({ ok: false, text: 'not there' });
    expect(evalFn(spec, { error: 'INVALID_SESSION_ID' }).ok).toBe(false);
    expect(evalFn({ pattern: '(' }, { text: 'x' }).ok).toBe(false);   // a broken pattern is a no, never a throw
  });
  it('the runner sends a verify `msg` with the step org’s session, and counts it as a re-read', () => {
    expect(HIST).toContain('step.verify && (step.verify.query || step.verify.path || step.verify.msg) ? async () => {');
    expect(HIST).toContain('send({ ...vs.msg, orgUrl: stepOrg.orgUrl, sid: stepOrg.sid, _suppressError: true, _silentError: true })');
    expect(HIST).toContain("noVerify: step.verify && (step.verify.query || step.verify.path || step.verify.msg) ? undefined : 'this step has no re-read',");
  });
  it('the report-type undo step carries that re-read, with the field and object escaped for the pattern', () => {
    expect(FC).toContain("verify: { msg: { type: 'SF_MD_READ', mdType: 'ReportType', fullNames: [fullName] },");
    expect(FC).toContain("flags: 'i', retries: 3,");
    expect(FC).toContain('<field>${_rxEsc(field)}</field>');
    expect(FC).toContain('<table>${_rxEsc(obj)}</table>`');
    expect(FC).not.toContain("msg: { type: 'SF_METADATA_DEPLOY', zipBase64: zipBefore },\n            verify: null,");
  });
});
