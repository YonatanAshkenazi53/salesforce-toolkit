// Field Cleaner — the field delete itself, pinned from a live run
// (2026-09-22, trailheads2 + trailheads4).
//
// What happened: with every dependency gone (index empty, flow definition
// gone, permission set gone) the 🗑 Delete Field step failed with
// INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY. The same Tooling DELETE
// failed by CLI too — on a brand-new text field on Account, on Contact, on a
// brand-new custom object, and in the second org. A Metadata API deploy with
// destructiveChanges.xml deleted the same field at once. Pins:
//   1. the Metadata API is tried after ANY Tooling refusal, and the
//      destructive package names exactly the one field;
//   2. when both refuse, the Metadata API's words are shown and the Tooling
//      text is kept on the element's title;
//   3. the INSUFFICIENT_ACCESS explanation quotes Salesforce.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'field-cleaner.js'), 'utf8');
const between = (a, b) => { const i = SRC.indexOf(a); expect(i, a).toBeGreaterThan(0); return SRC.slice(i, SRC.indexOf(b, i)); };

describe('field delete — Metadata API after a Tooling refusal', () => {
  const md = between('async function _deleteFieldViaMetadata(', 'async function doDelete(');
  const dd = between('async function doDelete(', "if (res.error) {");
  it('builds a destructive package that names the one field as a CustomField member', () => {
    expect(md).toMatch(/name: 'destructiveChanges\.xml'/);
    expect(md).toMatch(/<members>\$\{_lxEsc\(fullName\)\}<\/members>/);
    expect(md).toMatch(/<name>CustomField<\/name>/);
    expect(md).toMatch(/name: 'package\.xml'/);
    expect(md).toMatch(/type: 'SF_METADATA_DEPLOY'/);
    expect(md).toMatch(/_suppressError: true/);
  });
  it('is tried for ANY Tooling error, with the object.field full name, and the Tooling error kept', () => {
    expect(dd).toMatch(/if \(res\?\.error\) \{/);
    expect(dd).toMatch(/_deleteFieldViaMetadata\(`\$\{_selObj\?\.api\}\.\$\{_selField\?\.api\}`\)/);
    expect(dd).toMatch(/res = \{ error: md\.error, toolingError: res\.error \}/);
    expect(dd).toMatch(/via = 'metadata'/);
    expect(dd).toMatch(/_delLogEntry\.via = via/);
  });
  it('shows the Metadata API words when both refuse, with the Tooling text on the title', () => {
    const err = between("if (res.error) {\n      if (btn) { btn.disabled = false; btn.textContent = '🗑 Delete Field'; }", '} else {');
    expect(err).toMatch(/_explainDeleteError\(res\.error\)/);
    expect(err).toMatch(/errEl\.title = `Tooling API said: /);
  });
  it('the "Field deleted" card is written AFTER the reset that empties the results area', () => {
    // live 2026-09-22: resetFieldAndBelow() ran after the card and erased it — a blank page
    const ok = between("const _graceEnd = new Date(", '// ── XML Inspector');
    expect(ok.indexOf('resetFieldAndBelow();')).toBeGreaterThan(0);
    expect(ok.indexOf('resetFieldAndBelow();')).toBeLessThan(ok.indexOf("eid('fcResults').innerHTML = `"));
    expect(ok).toMatch(/class="fc-success"/);
    expect(ok).toMatch(/Field deleted\$\{via === 'metadata' \? ' \(through the Metadata API — the Tooling API refused\)' : ''\}/);
    expect(ok).toMatch(/\$\{esc\(objApi\)\}\.\$\{esc\(fldApi\)\} is deleted/);
    expect(ok).toMatch(/const fi = eid\('fcFieldInput'\); if \(fi\) fi\.value = '';/);
  });
  it('the post-delete re-read treats a row renamed X_del as deleted (Salesforce keeps it for 15 days)', () => {
    // live 2026-09-27: the delete had worked; the re-read by Id still found the row and called it refused
    const dd = between('async function doDelete(', "if (res.error) {");
    expect(dd).toContain("const wantName = String(_selField?.api || '').replace(/__c$/, '');");
    expect(dd).toContain("const stillThere = !!(chk && !chk.error) && devName === wantName;");
  });
  it('the INSUFFICIENT_ACCESS explanation quotes Salesforce', () => {
    const ex = between('function _explainDeleteError(raw)', 'async function _deleteFieldViaMetadata(');
    expect(ex).toMatch(/\(Salesforce said: ' \+ s\.replace\(\/\\s\+\/g, ' '\)\.slice\(0, 400\) \+ '\)'/);
  });
});
