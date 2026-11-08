// ✎ The XML editor in Field Cleaner's 🔍 (user 2026-11-07: "we should maybe give the user an ability to edit
// the XML and repush it to sf the way they want. Like a vscode"). Live 2026-11-08 on SFTK_Live_VR
// (scripts/dev/live/fc-xml-editor.mjs): malformed → Deploy off; a formula Salesforce refuses → its words
// under the box, nothing changed (CLI); a real edit → deployed and verified (CLI); History undo → back (CLI).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const M = extractFunctions('sftk-mdapi.js', ['sftkMdWellFormed', 'sftkMdPretty']);

describe('well-formed or nothing is sent (a pure check: the pages enforce Trusted Types, DOMParser refuses a plain string)', () => {
  it('accepts what readMetadata returns, pretty-printed', () => {
    const vr = readFileSync(new URL('./fixtures/md-edit/ValidationRule.Account.SFTK_Live_VR.xml', import.meta.url), 'utf8');
    expect(M.sftkMdWellFormed(M.sftkMdPretty(vr))).toBeNull();
    const cmt = readFileSync(new URL('./fixtures/md-edit/CustomMetadata.SFTK_Live_Cmt.Ref.xml', import.meta.url), 'utf8');
    expect(M.sftkMdWellFormed(cmt)).toBeNull();                       // xsi:type attributes
    expect(M.sftkMdWellFormed('<a><![CDATA[x < y && z]]></a><!-- c --><b/>')).toBeNull();
  });
  it('names the first problem with its line', () => {
    expect(M.sftkMdWellFormed('<a>1</a>\n<b>2</c>')).toBe('line 2: <b> (line 2) is closed by </c>');
    expect(M.sftkMdWellFormed('<a>x && y</a>')).toMatch(/^line 1: an “&” that is not an entity/);
    expect(M.sftkMdWellFormed('<a>x < y</a>')).toMatch(/^line 1: a “<” that does not open a tag/);
    expect(M.sftkMdWellFormed('<a>\n<b>')).toBe('line 2: <b> is never closed');
    expect(M.sftkMdWellFormed('</a>')).toBe('line 1: </a> closes nothing');
  });
  it('a leaf’s text is kept exactly (the editor deploys what it shows)', () => {
    expect(M.sftkMdPretty('<a> x </a>')).toBe('<a> x </a>');
  });
});

describe('the wiring', () => {
  it('✎ Edit XML in the 🔍 header of every declarative kind (a duplicate rule too, since 2026-11-08), a textarea, Deploy off until the text changed and is well-formed', () => {
    expect(FC).toContain('<span class="fc-xml-hdr-actions"><button class="btn btn-secondary btn-sm fc-xml-edit-btn"');
    expect(FC).toContain('function _xmlWellFormed(text) { return sftkMdWellFormed(text); }');
    expect(FC).toContain('go.disabled = ta.value === orig || !!bad;');
    expect(FC).toContain("ta.addEventListener('input', () => { out.innerHTML = ''; sync(); });");
  });
  it('the name cannot change; the diff is confirmed; a restore point; the deploy; the verify finds every added line; History undo', () => {
    expect(FC).toContain('if (gotName !== wantName) {');
    expect(FC).toContain("extraHtml: `<div class=\"fc-xml-diff-hd\">The XML — <span class=\"xd-del\">− as it is</span> · <span class=\"xd-add\">+ as you wrote it</span></div>");
    expect(FC).toContain("how: ['XML edited by hand'], files,");
    expect(FC).toContain('if (added.every(l => now.has(l))) return { ok: true, text: null };');
    expect(FC).toContain("title: `✎ XML edited — ${spec.what} \"${componentName}\"`");
  });
  it('a refusal is shown in Salesforce’s own words under the box', () => {
    expect(FC).toContain('❌ Salesforce refused the deploy — nothing was changed. Its words: <span class="fc-xml-ed-raw">${esc(String((wr.raw && wr.raw.error) || \'refused\'))}</span>');
  });
});
