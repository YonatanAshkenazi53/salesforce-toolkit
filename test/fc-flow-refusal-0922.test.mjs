// Field Cleaner — the flow fix dialog and its refusal, pinned from a live run
// (2026-09-22, fixture flow SFTK_FC_Test_Flow on trailheads2).
//
// What happened: the dialog's own preview said two elements would be "left
// empty by the fix", yet it OFFERED and PRESELECTED "Keep the flow running".
// Salesforce then refused the new version ("Required field assignmentItems is
// empty") — nothing was deleted (correct), but the refusal was worded by the
// data-deployment translator ("Map them from a source field…"), which makes no
// sense for a flow. Two pins:
//   1. with emptied elements, replace is still offered (the user may fix by
//      hand) but NOT preselected, and the option says why;
//   2. the refusal quotes Salesforce and points at the delete option / Flow
//      Builder — never the data-mapping hint.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// _flowChoiceHtml is nested (not top-level) — the pins read the template text.
const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'field-cleaner.js'), 'utf8');
const choice = (() => {
  const i = SRC.indexOf('function _flowChoiceHtml(');
  return SRC.slice(i, SRC.indexOf('name="fcActiveMode" value="delete"', i));
})();

describe('flow fix dialog — the active-version choice', () => {
  it('preselects replace only when nothing is left empty (the template checks pv.emptied)', () => {
    expect(choice).toMatch(/value="replace" \$\{canReplace \? \(pv\.emptied\.length \? '' : 'checked'\) : 'disabled'\}/);
  });
  it('with emptied elements: replace stays available but says why it is likely refused', () => {
    expect(choice).toMatch(/Likely refused: \$\{pv\.emptied\.length\} element\(s\) would be left empty/);
    expect(choice).toMatch(/otherwise choose delete/);
    expect(choice).toMatch(/Left empty by the fix/);
  });
  it('the preselected mode in the handler follows the same rule', () => {
    const i = SRC.indexOf("const replaceLikelyRefused = canReplace && !!pv && (pv.emptied || []).length > 0;");
    expect(i).toBeGreaterThan(0);
    expect(SRC.slice(i, i + 400)).toMatch(/let activeMode = hasChoice \? \(canReplace && !replaceLikelyRefused \? 'replace' : ''\) : 'replace';/);
  });
});
describe('flow fix — the deploy refusal', () => {
  it('quotes Salesforce and points at delete / Flow Builder, not at the data-mapping translator', () => {
    const i = SRC.indexOf('Salesforce refused the fixed "${flowName}"');
    expect(i).toBeGreaterThan(0);
    const win = SRC.slice(i - 20, i + 700);
    expect(win).toMatch(/String\(deployRes\.error\)/);
    expect(win).not.toMatch(/_feText\(deployRes\.error\)/);
    expect(win).toMatch(/Nothing was deleted/);
    expect(win).toMatch(/Delete the active version too/);
    expect(win).toMatch(/Flow Builder/);
    expect(SRC).not.toMatch(/Couldn't deploy the fixed/);
  });
});
