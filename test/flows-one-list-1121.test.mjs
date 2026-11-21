// owner 2026-11-20: "maybe versions and dependecies can be one page? we do need this options as well" / "the filters"
// — one Flows view: the kind tabs on the list, the dependency tools in a fold of the same page.
// owner 2026-11-21 (log viewer): "this buttons should be placed in the yellow triangle." / "and also say text size".
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const HTML = read('popup.html'), PJ = read('popup.js'), CSS = read('styles.css'), DBG = read('apex-debugger.js');
const { sftkFlowKindOfRow: kind, sftkFlowKindCounts: counts, sftkFlowKindTab: tab } =
  extractFunctions('popup.js', ['sftkFlowKindOfRow', 'sftkFlowKindCounts', 'sftkFlowKindTab']);

const row = (apiName, ...versions) => ({ apiName, versions });
const TRIG = { Acc_After: 'RecordAfterSave', Nightly: 'Scheduled', Evt: 'PlatformEvent' };

describe('the kind of a flow', () => {
  it('the definition’s trigger tells record-triggered, scheduled and platform event flows apart', () => {
    expect(kind(row('Acc_After', { ProcessType: 'AutoLaunchedFlow', Status: 'Active' }), TRIG)).toBe('RecordTriggeredFlow');
    expect(kind(row('Nightly', { ProcessType: 'AutoLaunchedFlow', Status: 'Active' }), TRIG)).toBe('ScheduledFlow');
    expect(kind(row('Evt', { ProcessType: 'AutoLaunchedFlow', Status: 'Active' }), TRIG)).toBe('PlatformEventFlow');
    expect(kind(row('Sub', { ProcessType: 'AutoLaunchedFlow', Status: 'Active' }), TRIG)).toBe('AutoLaunchedFlow');
    expect(kind(row('Wizard', { ProcessType: 'Flow', Status: 'Draft' }), TRIG)).toBe('Flow');
  });
  it('the active version speaks for the flow, else its newest; no version is no kind', () => {
    expect(kind(row('X', { ProcessType: 'Flow', Status: 'Obsolete' }, { ProcessType: 'AutoLaunchedFlow', Status: 'Active' }, { ProcessType: 'Flow', Status: 'Draft' }), {})).toBe('AutoLaunchedFlow');
    expect(kind(row('X', { ProcessType: 'Flow', Status: 'Obsolete' }, { ProcessType: 'Workflow', Status: 'Draft' }), {})).toBe('Workflow');
    expect(kind(row('X'), {})).toBe('');
  });
  it('a kind without a tab of its own is counted under Other', () => {
    expect(tab('Workflow')).toBe('other'); expect(tab('PlatformEventFlow')).toBe('other'); expect(tab('Flow')).toBe('Flow');
    expect(counts([
      row('Acc_After', { ProcessType: 'AutoLaunchedFlow', Status: 'Active' }), row('Nightly', { ProcessType: 'AutoLaunchedFlow', Status: 'Active' }),
      row('Sub', { ProcessType: 'AutoLaunchedFlow', Status: 'Active' }), row('Wizard', { ProcessType: 'Flow', Status: 'Active' }), row('PB', { ProcessType: 'Workflow', Status: 'Active' }),
    ], TRIG)).toEqual({ all: 5, RecordTriggeredFlow: 1, Flow: 1, AutoLaunchedFlow: 1, ScheduledFlow: 1, other: 1 });
  });
});

describe('one Flows view', () => {
  it('three views; the kind tabs sit on the list; the dependency map is a fold of it', () => {
    expect(HTML).toContain('data-view="versions" role="tab" aria-selected="true"');
    expect(HTML).toContain('>🗂 Flows</button>');
    expect(HTML).not.toContain('data-view="deps"');
    for (const k of ['all', 'RecordTriggeredFlow', 'Flow', 'AutoLaunchedFlow', 'ScheduledFlow', 'other']) expect(HTML).toContain(`data-ftype="${k}"`);
    const fold = HTML.indexOf('<details class="flow-deps-fold" id="flowDepsFold">'), list = HTML.indexOf('id="flowViewVersions"'), end = HTML.indexOf('<!-- /flowViewVersions -->');
    expect(fold).toBeGreaterThan(list); expect(fold).toBeLessThan(end);
    expect(HTML.indexOf('id="depTreeContainer"')).toBeGreaterThan(fold); expect(HTML.indexOf('id="depTreeContainer"')).toBeLessThan(end);
  });
  it('a tree is shown whole when one of its flows is of the kind picked; a kind gone from the org falls back to All', () => {
    expect(PJ).toContain("const kindHit = row => _flowTypeFilter === 'all' || sftkFlowKindTab(sftkFlowKindOfRow(row, trigMap)) === _flowTypeFilter;");
    expect(PJ).toContain("if (_flowTypeFilter !== 'all' && !kindCounts[_flowTypeFilter]) _flowTypeFilter = 'all';");
    expect(PJ).toContain("emptyState.textContent = 'No flow of this kind in the org.';");
  });
  it('every old link to the Dependencies view opens the fold; the map is re-drawn only while the fold is open', () => {
    expect(PJ).toContain("const wantDeps = view === 'deps';");
    expect(PJ).toContain("if (fold) { fold.open = true; renderDependenciesTab();");
    expect(PJ).toContain("return !!(d && d.open && _flowView === 'versions');");
    expect(PJ).not.toContain("getElementById('tab-dependencies').style.display !== 'none'");
    expect(PJ).toContain("document.getElementById('flowDepsFold')?.addEventListener('toggle', e => { if (e.target.open) renderDependenciesTab(); });");
  });
  it('one row of kind tabs: the map’s own are hidden in the fold and it follows the list', () => {
    expect(CSS).toContain('.flow-deps-body .dep-filter-buttons { display: none; }');
    expect(PJ).toContain("const btn = [...document.querySelectorAll('#depTreeContainer .dep-filter-btn')].find(b => b.dataset.type === want);");
  });
  it('each flow names its kind with an icon and a hover text', () => {
    expect(PJ).toContain("ico.className = 'flow-kind-ico';");
    expect(PJ).toContain("ico.title = kind ? humanProcessType(kind) : 'Kind not read';");
  });
});

describe('log viewer: text size', () => {
  it('sits at the end of the filter row, with its name, and is still wired by id', () => {
    const cats = DBG.indexOf('<div class="adbg-log-cats" id="adbgLogCats">'), font = DBG.indexOf('<span class="adbg-log-fontlbl">Text size</span>'), view = DBG.indexOf('<div class="adbg-log-view" id="adbgLogView">');
    expect(font).toBeGreaterThan(cats); expect(font).toBeLessThan(view);
    expect(DBG.slice(DBG.indexOf('id="adbgLogToggle"'), cats)).not.toContain('adbgLogFontDown');
    for (const id of ['adbgLogFontDown', 'adbgLogFontReset', 'adbgLogFontUp']) expect(DBG.split(`id="${id}"`).length).toBe(2);
    expect(CSS).toContain('.adbg-log-cats .adbg-log-fontctl { margin-left: auto;');
  });
});
