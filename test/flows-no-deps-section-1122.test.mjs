// 2026-11-22, the owner on the Flows page:
//   "this tab isn't needed." / "dependecies" / "what you did is just inserted the old tab into the backup delete tab.
//    i want to use only the backup delete restore tab because we can see hierarchies there."
//   "also we dont see package flows"
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { extractFunction } from './extract.mjs';
const rd = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const HTML = rd('popup.html'), PJ = rd('popup.js'), CSS = rd('styles.css');

describe('the Dependencies section is gone from the Flows page', () => {
  it('the page has no fold, no map host, and says nothing of dependency tools', () => {
    for (const x of ['flowDepsFold', 'flow-deps-fold', 'id="depTreeContainer"', 'id="depNoDataBanner"', 'and the dependency tools']) expect(HTML).not.toContain(x);
  });
  it('whatever still asks for the map draws nothing, and breaks nothing', () => {
    expect(PJ).toContain('if (!container || !noBanner) return;');
    expect(PJ).toContain("if (tabName === 'dependencies') { navigateToTab('flows'); return; }");
  });
  it('no sentence and no link sends the user to it', () => {
    for (const f of ['popup.js', 'apex-debugger.js', 'field-cleaner.js']) {
      const s = rd(f);
      expect(s).not.toContain('Dependencies section');
      expect(s).not.toMatch(/xlink(Html)?\('dependencies'/);
    }
  });
  it('the scan stays: the list reads it for its markers, trees and kinds', () => {
    expect(PJ).toContain('🔗 subflow markers, flow trees and flow types cover only those');
    expect(PJ).toContain("btn.addEventListener('click', () => runDependencyScan(loadOrgUrl, loadSid));");
  });
});

describe('managed package flows are on the Flows list', () => {
  let shown;
  beforeAll(() => { globalThis.resolveFlowType = (p, t) => (p === 'AutoLaunchedFlow' && /^Record/.test(String(t || ''))) ? 'RecordTriggeredFlow' : p; shown = extractFunction('popup.js', 'sftkManagedFlowsShown'); });
  const rows = [
    { apiName: 'pkg__Send_Note', label: 'Send Note', processType: 'AutoLaunchedFlow', active: { versionNumber: 3, apiVersion: '68.0', status: 'Active' }, latest: { versionNumber: 3, apiVersion: '68.0', status: 'Active' } },
    { apiName: 'cms__Review', label: 'CMS: Review', processType: 'Flow', active: null, latest: { versionNumber: 1, apiVersion: '67.0', status: 'Draft' } },
  ];
  it('every one of them, by label, with its namespace, kind, status and version', () => {
    expect(shown(rows, '', 'all', {})).toEqual([
      { apiName: 'cms__Review', label: 'CMS: Review', ns: 'cms', kind: 'Flow', active: false, status: 'Draft', version: 1, apiVersion: '67.0' },
      { apiName: 'pkg__Send_Note', label: 'Send Note', ns: 'pkg', kind: 'AutoLaunchedFlow', active: true, status: 'Active', version: 3, apiVersion: '68.0' },
    ]);
  });
  it('the search and the kind tab narrow them as they narrow the list', () => {
    expect(shown(rows, 'send', 'all', {}).map(r => r.apiName)).toEqual(['pkg__Send_Note']);
    expect(shown(rows, 'CMS__', 'all', {}).map(r => r.apiName)).toEqual(['cms__Review']);
    expect(shown(rows, '', 'Flow', {}).map(r => r.apiName)).toEqual(['cms__Review']);
    expect(shown(rows, '', 'RecordTriggeredFlow', { pkg__Send_Note: 'RecordAfterSave' }).map(r => r.apiName)).toEqual(['pkg__Send_Note']);
    expect(shown(rows, '', 'ScheduledFlow', {})).toEqual([]);
  });
  it('not read yet is no row, not an error', () => { expect(shown(null, '', 'all', {})).toEqual([]); });
  it('the list draws them at its end, read-only, and again when their read lands', () => {
    expect(PJ).toContain('list.appendChild(buildManagedFlowsBox(shown, (mg || []).length));');
    expect(PJ).toContain("if (loadOrgUrl === orgUrl) renderFlowList();   // the 🔒 managed package flows, at the end of the list");
    const box = PJ.slice(PJ.indexOf('function buildManagedFlowsBox('), PJ.indexOf('// One card for a flow tree'));
    expect(box).not.toContain('checkbox');
    expect(box).toContain('so they cannot be deleted, backed up or changed here');
    expect(CSS).toContain('.flow-managed-row {');
  });
});

describe('what the Dependencies view had, on the list', () => {
  it('the what-uses search narrows the list; the report and the rescan sit beside it', () => {
    for (const id of ['flowUsesInput', 'flowUsesGo', 'flowUsesClear', 'flowExportBtn', 'flowRescanBtn', 'flowUsesNote']) expect(HTML).toContain('id="' + id + '"');
    expect(PJ).toContain('const usesHit = row => !_flowUses || row.versions.some(v => _flowUses.counts[v.Id]);');
    expect(PJ).toContain("DependencyMap.exportReport(orgUrl, document.getElementById('flowExportStatus'));");
    expect(PJ).toContain('await window.sftkRescanDependencies();');
  });
  it('the line under the search says what was found and how much of the org was read', () => {
    const note = extractFunction('popup.js', 'sftkFlowUsesNote');
    expect(note('SLA__c', 2, { full: true, have: 43, total: 43 }, '')).toEqual({ text: "2 flows mention “SLA__c” — a literal match in the flow's metadata, capitals ignored.", warn: '' });
    expect(note('Gold', 1, { full: true }, '').text).toContain('1 flow mentions “Gold”');
    expect(note('X', 0, { full: true }, '').text).toBe('No flow that could be read mentions “X”.');
    const part = note('X', 0, { full: false, have: 0, total: 43 }, 'managed-package flows are listed but hidden');
    expect(part.text).toBe('No match for “X” in the flow versions that were read.');
    expect(part.warn).toBe('This search read the text of 0 of 43 flow versions; the others were not searched. ↻ Rescan reads them all. 🔒 Managed-package flows are listed but hidden.');
  });
  it('each flow opens its blast radius and its chain; each version says who made and changed it', () => {
    expect(PJ).toContain('() => DependencyMap.showBlastRadius(gov)');
    expect(PJ).toContain('() => DependencyMap.showChainPanel(gov, orgUrl)');
    const dates = extractFunction('popup.js', 'sftkFlowVersionDates');
    expect(dates({ CreatedDate: '2026-10-07T09:00:00.000+0000', CreatedBy: { Name: 'Dana' }, LastModifiedDate: '2026-11-02T10:00:00.000+0000', LastModifiedBy: { Name: 'Avi' } })).toBe('created 2026-10-07 by Dana · modified 2026-11-02 by Avi');
    expect(dates({ LastModifiedDate: '2026-11-02T10:00:00.000+0000' })).toBe('modified 2026-11-02');
    expect(dates({})).toBe('');
  });
});

describe('the fallback owner: "You" and the same person by name are told apart', () => {
  const BL = rd('studio-builder.js');
  it('"You" says who it is today; the person\'s own row says it stays that user', () => {
    const you = extractFunction('studio-builder.js', 'bldOwnerYouLabel'), isMe = extractFunction('studio-builder.js', 'bldOwnerIsMe');
    expect(you({ id: '005xx0000012345AAA', name: 'Dana Levi' })).toBe('You — the user who runs the deployment (today: Dana Levi)');
    expect(you(null)).toBe('You — the user who runs the deployment');
    expect(isMe('005xx0000012345', { id: '005xx0000012345AAA' })).toBe(true);
    expect(isMe('005xx0000099999AAA', { id: '005xx0000012345AAA' })).toBe(false);
    expect(isMe('005xx0000012345AAA', null)).toBe(false);
    expect(BL).toContain("bldOwnerIsMe(u.Id, me) ? ' — you today; stays this user whoever runs it' : ''");
  });
});

describe('debug logs: the loading cat is the full one', () => {
  it('the list pane uses sftkCat, not the compact cat', () => {
    const D = rd('apex-debugger.js');
    expect(D).toContain("<div class=\"adbg-list-ph\">${sftkCat('Loading logs…')}</div>");
    expect(D).not.toMatch(/adbg-list-ph">'? ?\+? ?\$?\{?sftkCatSm/);
  });
});

describe('a managed package flow is marked on every view of the Flows page', () => {
  const DM = rd('dependency-map.js');
  it('⏻ Switches: the row carries the flag and draws it', () => {
    const matrix = extractFunction('sftk-flowbulk.js', 'sftkFlowBulkMatrix');
    const rows = matrix([{ key: 'a' }], { a: [{ apiName: 'pkg__F', label: 'F', kind: 'Screen', managed: true }, { apiName: 'Mine', label: 'Mine', kind: 'Screen', managed: false }] }, {});
    expect(rows.find(r => r.apiName === 'pkg__F').managed).toBe(true);
    expect('managed' in rows.find(r => r.apiName === 'Mine')).toBe(false);
    expect(DM).toContain('class="dep-fb-subtag dep-fb-pkgtag"');
    expect(DM).toContain('🔒 managed package</span>');
  });
  it('⚙ API versions: the chip it always had', () => { expect(DM).toMatch(/dep-pill dep-pill-hint" title="Managed package flow/); });
  it('🗂 Flows: their own section at the end of the list', () => { expect(PJ).toContain('🔒 Managed package flows <b>'); });
});
