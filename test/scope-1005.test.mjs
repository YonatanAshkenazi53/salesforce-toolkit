// The first public release, tool by tool (the owner's choice, 2026-10-05).
//   Data Studio — a marked screenshot: Connected Orgs, Data Deployment, All open
//   orgs, History, Org Compare, Org health. Not marked: Deploy Readiness.
//   Toolkit — "all besides licenses".
// Both tools stay in the repository and the developer build. The packer leaves
// their files out; the pages degrade by themselves; sftk-build.js lets one page
// know what the OTHER page does not have, so nothing links to a blank tab.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const PACK = read('scripts/pack_store.py');
const BUILD = read('sftk-build.js');

describe('sftk-build.js — the developer build ships everything', () => {
  const load = cut => new Function('window', `${BUILD.replace('window.SFTK_CUT = [];', `window.SFTK_CUT = ${JSON.stringify(cut)};`)}\nreturn sftkShips;`)({});
  it('the source says nothing is cut, on exactly one line the packer can rewrite', () => {
    expect(BUILD.split('window.SFTK_CUT = [];').length - 1).toBe(1);
  });
  it('sftkShips answers from the list', () => {
    expect(load([])('licenses')).toBe(true);
    const s = load(['licenses', 'readiness']);
    expect(s('licenses')).toBe(false);
    expect(s('readiness')).toBe(false);
    expect(s('fields')).toBe(true);
  });
  it('both pages load it right after the licence gate, before any tool', () => {
    for (const page of ['popup.html', 'studio.html']) {
      const h = read(page);
      const at = f => h.indexOf(`<script src="${f}"></script>`);
      expect(at('sftk-build.js')).toBeGreaterThan(at('sftk-terms.js'));
      expect(at('sftk-build.js')).toBeLessThan(at(page === 'popup.html' ? 'popup.js' : 'studio-core.js'));
    }
  });
});

describe('the packer — what the public build leaves out', () => {
  it('Deploy Readiness and Licenses join the Picklist Manager and Sequences', () => {
    expect(PACK).toContain("CUT_JS = {'studio-picklists.js', 'studio-sequences.js', 'studio-readiness.js', 'license-manager.js'}");
    expect(PACK).toContain("CUT_IDS = ['picklists', 'sequences', 'readiness', 'licenses']");
  });
  it('their nav buttons, the Licenses tab and their script tags go; a changed layout fails the pack instead of shipping a dead button', () => {
    expect(PACK).toContain('data-view="readiness">');
    expect(PACK).toContain("fail('Deploy Readiness nav button not found in studio.html — nav layout changed?')");
    expect(PACK).toContain('data-tab="licenses">');
    expect(PACK).toContain("fail('Licenses nav button not found in popup.html — nav layout changed?')");
    expect(PACK).toContain("fail('Licenses tab container not found in popup.html — layout changed?')");
  });
  it('the staged sftk-build.js names the cut tools, and the pack fails if it still says "nothing"', () => {
    expect(PACK).toContain("sb = sb.replace('window.SFTK_CUT = [];', 'window.SFTK_CUT = ' + repr(CUT_IDS).replace(\"'\", '\"') + ';')");
    expect(PACK).toContain("fail('packed sftk-build.js still says nothing is cut')");
  });
  it('the post-checks look for leftovers in both pages', () => {
    expect(PACK).toContain("for needle in ['license-manager.js', 'data-tab=\"licenses\"', 'tab-licenses']:");
    expect(PACK).toContain("'studio-readiness.js', 'data-view=\"readiness\"',");
  });
});

describe('the pages degrade by themselves', () => {
  const CORE = read('studio-core.js'), OH = read('studio-orghealth.js'), POP = read('popup.js');
  it('Data Studio: no home card, no palette row and no route for a view whose file is absent', () => {
    expect(CORE).toContain("${_viewAvailable('readiness') ? `<div class=\"ds-welcome-card\" data-gotoview=\"readiness\">");
    expect(CORE).toContain('const navItems = CMD_VIEWS.filter(v => _viewAvailable(v.view))');
    expect(CORE).toContain("const need = { readiness: 'renderReadiness',");
  });
  it('Data Studio does not offer a Toolkit tab the build does not carry', () => {
    expect(CORE).toContain("const toolkitItems = CMD_TOOLKIT.filter(t => typeof sftkShips !== 'function' || sftkShips(t.tab))");
    expect(OH).toContain("return (typeof sftkShips !== 'function' || sftkShips('licenses')) ? { label: 'Open Licenses', popupTab: 'licenses' } : undefined;");
    expect(OH).not.toContain("fix: { label: 'Open Licenses', popupTab: 'licenses' } };");
  });
  it('Toolkit: no home card, palette row or deep link for a tool that is not there', () => {
    expect(POP).toContain("].filter(f => typeof sftkShips !== 'function' || sftkShips(f.id));");
    expect(POP).toContain("if (typeof LicenseManager === 'undefined') return;   // not in this build");
  });
  it('the guide keeps the cut tools under "Not in the public build yet"', () => {
    const F = read('docs/FEATURES.md');
    const cut = F.slice(F.indexOf('## Not in the public build yet'));
    for (const h of ['### Picklist Manager', '### Sequences', '### Licenses', '### Deploy Readiness']) expect(cut).toContain(h);
    const shipped = F.slice(0, F.indexOf('## Not in the public build yet'));
    expect(shipped).not.toContain('### Licenses');
    expect(shipped).not.toContain('### Deploy Readiness');
  });
});
