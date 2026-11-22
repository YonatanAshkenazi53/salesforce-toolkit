// QA 1.1 regression run, finding #24: four dev scripts still clicked the Dependencies view button that the one-list
// Flows page removed (2026-11-21). The map is a fold now (#flowDepsFold), drawn when the fold is opened.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const HTML = read('popup.html'), POPUP = read('popup.js'), CSS = read('styles.css');
const SCRIPTS = ['scripts/dev/video/sections.mjs', 'scripts/dev/live/screenshots.mjs', 'scripts/dev/live/flows-page-look.mjs', 'scripts/dev/live/flows-views.mjs'];
const OPEN_FOLD = "const d = document.getElementById('flowDepsFold'); if (d && !d.open) d.querySelector('summary').click();";

describe('the page the scripts drive', () => {
  it('has no Dependencies view button and no Dependencies section (owner 2026-11-22)', () => {
    expect(HTML).not.toContain('data-view="deps"');
    expect(HTML).not.toContain('flowDepsFold');
    expect(HTML).not.toContain('id="depTreeContainer"');
  });
  it('keeps one row of kind tabs, on the list', () => {
    expect(CSS).not.toContain('.flow-deps-body');
    expect(HTML).toContain('id="flowTypeFilter"');
    expect(HTML).toContain('class="flow-type-btn" data-ftype="RecordTriggeredFlow"');
    expect(HTML).toContain('data-ftype="all"');
    expect(POPUP).toContain("_flowTypeFilter = btn.dataset.ftype || 'all'; renderFlowList(); _flowDepsFollowKind();");
  });
});

describe('finding #24: the dev scripts open the fold', () => {
  it('no dev script clicks the removed Dependencies view button', () => {
    const all = [];
    for (const dir of ['scripts/dev', 'scripts/dev/video', 'scripts/dev/live'])
      for (const f of readdirSync(new URL(`../${dir}/`, import.meta.url))) if (f.endsWith('.mjs')) all.push(`${dir}/${f}`);
    for (const f of SCRIPTS) expect(all).toContain(f);
    const stale = all.filter(f => { const s = read(f); return s.includes('data-view="deps"') || s.includes('data-view=\\"deps\\"'); });
    expect(stale).toEqual([]);
  });
  it('a script that builds the view selector from a variable does not click it for the Dependencies view', () => {
    // review of #24: qa-theme-sweep.mjs and flows-one-page.mjs looped over ['deps', ...] and clicked
    // #flowViews [data-view="${v}"] with no ?. — a throw on null that the literal search above cannot see
    const all = [];
    for (const dir of ['scripts/dev', 'scripts/dev/video', 'scripts/dev/live'])
      for (const f of readdirSync(new URL(`../${dir}/`, import.meta.url))) if (f.endsWith('.mjs')) all.push(`${dir}/${f}`);
    const built = [];
    for (const f of all) read(f).split('\n').forEach((line, i) => { if (line.includes('#flowViews [data-view="${')) built.push({ at: `${f}:${i + 1}`, line }); });
    expect(built.map(b => b.at.split(':')[0]).sort()).toEqual(['scripts/dev/live/flows-one-page.mjs', 'scripts/dev/live/qa-theme-sweep.mjs']);
    for (const b of built) expect(b.line, b.at).toContain("v === 'deps' ? `setFlowView('deps')` : ");
    // and the page still maps that old name to the fold, opened and drawn
    expect(POPUP).toContain("const wantDeps = view === 'deps';");
    expect(POPUP).toContain('if (fold) { fold.open = true; renderDependenciesTab();');
  });
  it('the three live scripts click the summary of the fold, once, when it is closed', () => {
    for (const f of SCRIPTS.slice(1)) expect(read(f), f).toContain(OPEN_FOLD);
  });
  it('the video chapter clicks the summary on camera, before it waits for the map', () => {
    const s = read(SCRIPTS[0]);
    const at = s.indexOf("id: 'dependencies'"), end = s.indexOf("id: 'flow-switches'");
    const ch = s.slice(at, end);
    expect(at).toBeGreaterThan(-1); expect(end).toBeGreaterThan(at);
    const click = ch.indexOf("await rec.click('#flowDepsFold > summary', 700);");
    expect(click).toBeGreaterThan(-1);
    expect(ch.indexOf("document.querySelector('#depExportBtn')")).toBeGreaterThan(click);
  });
  it('the video chapter filters by kind with the tabs of the list, not the hidden buttons of the map', () => {
    const s = read(SCRIPTS[0]);
    const ch = s.slice(s.indexOf("id: 'dependencies'"), s.indexOf("id: 'flow-switches'"));
    expect(ch).not.toContain('.dep-filter-btn');
    expect(ch).toContain(`rec.click('#flowTypeFilter .flow-type-btn[data-ftype="RecordTriggeredFlow"]', 1500)`);
    expect(ch).toContain(`rec.click('#flowTypeFilter .flow-type-btn[data-ftype="all"]', 1000)`);
  });
});
