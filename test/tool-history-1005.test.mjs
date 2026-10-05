// Whose history is it? (user 2026-10-05, on Data Studio › History full of
// Field Cleaner entries: "i think seeing field cleaner history on the data
// deployment history is confusing, it should show under the field cleaner").
//
// One list of entries, as before (sftk-history.js). What changed is where an
// entry is SHOWN:
//   a Toolkit tool's change   in that tool — a History button in the top bar
//                             while the tool is open, and for Field Cleaner
//                             also a section under its results;
//   everything else           Data Studio › History (deployments, rollbacks,
//                             Data Studio's own changes), with one line that
//                             says how many Toolkit changes live in which tool.
// The undo is the same sftkHistoryUndo from either place.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const HIST = read('sftk-history.js');
const TH = read('sftk-toolhistory.js');
const SH = read('studio-history.js');
const pure = HIST.slice(HIST.indexOf('// What the History card offers for a tool entry.'), HIST.indexOf('// ── The verify spec, evaluated'))
  + HIST.slice(HIST.indexOf('const SFTK_TOOLKIT_TOOLS = {'), HIST.indexOf("if (typeof globalThis !== 'undefined') {"));
const F = new Function(`${pure}\nreturn { SFTK_TOOLKIT_TOOLS, SFTK_TOOLKIT_TAB_LABELS, sftkHistoryToolTab, sftkHistoryTabLabel, sftkHistoryForTab, sftkHistoryStudioSplit, sftkHistoryAgo, sftkHistoryReport, sftkHistoryReportName, sftkToolUndoState };`)();

const tool = (name, at, extra) => ({ id: `tool_${name}_${at}`, kind: 'tool', tool: name, profileName: `${name} change`, startedAt: at, status: 'success', what: [{ ok: true, text: 'x — verified by re-reading the org' }], toolUndo: { none: 'why' }, targetOrg: 'https://acme.my.salesforce.com', ...extra });
const run = at => ({ id: `run_${at}`, profileName: 'Accounts', startedAt: at, status: 'success', summary: {} });
const rb = at => ({ id: `rb_${at}`, kind: 'rollback', profileName: '↩ Rollback of Accounts', startedAt: at, status: 'success', summary: {} });

describe('which tool shows an entry', () => {
  it('every tool name a Toolkit file passes to sftkHistoryBegin is mapped to its tab', () => {
    const popupFiles = ['popup.js', 'field-cleaner.js', 'lightning-pages.js', 'apex-debugger.js', 'license-manager.js', 'user-copy.js', 'flow-permissions.js', 'dependency-map.js'];
    const names = new Set();
    for (const f of popupFiles) for (const m of read(f).matchAll(/sftkHistoryBegin\(\{ tool: '([^']+)'/g)) names.add(m[1]);
    expect(names.size).toBeGreaterThan(6);
    for (const n of names) expect(F.SFTK_TOOLKIT_TOOLS[n], `tool "${n}" has no Toolkit tab`).toBeTruthy();
  });
  it('no Data Studio tool is claimed by the Toolkit', () => {
    const studioFiles = ['studio-picklists.js', 'studio-seed.js', 'studio-reconcile.js', 'sftk-vrpause.js', 'sftk-flowpause.js', 'studio-scan.js'];
    for (const f of studioFiles) for (const m of read(f).matchAll(/sftkHistoryBegin\(\{ tool: '([^']+)'/g)) expect(F.SFTK_TOOLKIT_TOOLS[m[1]], `"${m[1]}" is a Data Studio tool`).toBeUndefined();
  });
  it('every mapped tab has a label', () => {
    for (const tab of new Set(Object.values(F.SFTK_TOOLKIT_TOOLS))) expect(F.sftkHistoryTabLabel(tab)).toBeTruthy();
    expect(F.sftkHistoryTabLabel('nope')).toBe('');
    expect(F.sftkHistoryTabLabel('constructor')).toBe('');
  });
  it('a deployment, a rollback and a Data Studio tool are nobody’s Toolkit entry', () => {
    expect(F.sftkHistoryToolTab(run('2026-10-05T10:00:00Z'))).toBe('');
    expect(F.sftkHistoryToolTab(rb('2026-10-05T10:00:00Z'))).toBe('');
    expect(F.sftkHistoryToolTab(tool('Deploy', '2026-10-05T10:00:00Z'))).toBe('');
    expect(F.sftkHistoryToolTab(tool('constructor', '2026-10-05T10:00:00Z'))).toBe('');
    expect(F.sftkHistoryToolTab(tool('Field Cleaner', '2026-10-05T10:00:00Z'))).toBe('fields');
    expect(F.sftkHistoryToolTab(tool('API versions', '2026-10-05T10:00:00Z'))).toBe('dependencies');
    expect(F.sftkHistoryToolTab(null)).toBe('');
  });
});

describe('the split', () => {
  const all = [run('2026-10-05T08:00:00Z'), tool('Field Cleaner', '2026-10-05T09:00:00Z'), tool('Field Cleaner', '2026-10-05T11:00:00Z'), tool('Flow switches', '2026-10-05T10:00:00Z'),
    tool('Deploy', '2026-10-05T10:30:00Z'), rb('2026-10-05T12:00:00Z'), tool('Lightning Pages', '2026-10-05T07:00:00Z')];
  it('a tool gets its own entries, newest first, and nobody else’s', () => {
    expect(F.sftkHistoryForTab(all, 'fields').map(e => e.startedAt)).toEqual(['2026-10-05T11:00:00Z', '2026-10-05T09:00:00Z']);
    expect(F.sftkHistoryForTab(all, 'dependencies').length).toBe(1);
    expect(F.sftkHistoryForTab(all, 'flows')).toEqual([]);
    expect(F.sftkHistoryForTab(null, 'fields')).toEqual([]);
  });
  it('Data Studio keeps deployments, rollbacks and its own tools, and counts the rest per tab', () => {
    const s = F.sftkHistoryStudioSplit(all);
    expect(s.mine.map(e => e.id)).toEqual(['run_2026-10-05T08:00:00Z', 'tool_Deploy_2026-10-05T10:30:00Z', 'rb_2026-10-05T12:00:00Z']);
    expect(s.kit).toEqual({ fields: 2, dependencies: 1, pages: 1 });
    expect(s.kitTotal).toBe(4);
  });
  it('nothing is lost: every entry is on exactly one side', () => {
    const s = F.sftkHistoryStudioSplit(all);
    expect(s.mine.length + s.kitTotal).toBe(all.length);
  });
});

describe('a card’s small facts', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  it('age in plain words', () => {
    expect(F.sftkHistoryAgo('2026-10-05T11:59:40Z', now)).toBe('just now');
    expect(F.sftkHistoryAgo('2026-10-05T11:15:00Z', now)).toBe('45m ago');
    expect(F.sftkHistoryAgo('2026-10-05T08:00:00Z', now)).toBe('4h ago');
    expect(F.sftkHistoryAgo('2026-10-02T12:00:00Z', now)).toBe('3d ago');
    expect(F.sftkHistoryAgo('', now)).toBe('');
  });
  it('the report says what was written, whether the org confirmed it, and the state of the undo', () => {
    const e = tool('Field Cleaner', '2026-10-05T09:00:00Z', { what: [{ ok: true, accepted: true, text: 'A — verified' }, { ok: false, accepted: true, text: 'B — accepted, not confirmed' }], toolUndo: { steps: [{ describe: 'put A back' }] } });
    const r = F.sftkHistoryReport(e);
    expect(r.tool).toBe('Field Cleaner');
    expect(r.org).toBe('https://acme.my.salesforce.com');
    expect(r.writes).toEqual([{ what: 'A — verified', verified: true, accepted: true }, { what: 'B — accepted, not confirmed', verified: false, accepted: true }]);
    expect(r.undo).toEqual({ state: 'available', steps: ['put A back'] });
    expect(F.sftkHistoryReport(tool('Field Cleaner', '2026-10-05T09:00:00Z')).undo).toEqual({ state: 'no undo', why: 'why' });
    expect(F.sftkHistoryReportName(e)).toBe('sftk-change-field-cleaner-2026-10-05-090000');
  });
});

describe('the Toolkit side (sftk-toolhistory.js)', () => {
  it('is loaded by the popup after the confirmation dialog, and the popup tells it which tool is open', () => {
    const html = read('popup.html');
    expect(html.indexOf('<script src="sftk-toolhistory.js"></script>')).toBeGreaterThan(html.indexOf('<script src="sftk-confirm.js"></script>'));
    expect(html.indexOf('<script src="sftk-toolhistory.js"></script>')).toBeGreaterThan(html.indexOf('<script src="sftk-history.js"></script>'));
    expect(html).toContain('<button id="sftkThBtn" class="dbg-btn" style="display:none"');
    const pop = read('popup.js');
    expect(pop).toContain("if (typeof sftkToolHistorySetTab === 'function') sftkToolHistorySetTab(tabName);");
    expect(pop).toContain("if (typeof sftkToolHistorySetTab === 'function') sftkToolHistorySetTab('');   // home is no tool");
  });
  it('the button shows only while the open tool has entries, with their number', () => {
    expect(TH).toContain("b.style.display = n ? '' : 'none';");
    expect(TH).toContain('const n = _tab ? (await entriesFor(_tab)).length : 0;');
    expect(TH).toContain('return sftkHistoryForTab(all, tab);');
  });
  it('↩ Undo is the shared undo — one confirmation, every step re-read — and the list never writes by itself', () => {
    expect(TH).toContain('const r = await sftkHistoryUndo(id, {});');
    for (const w of ['SF_PATCH', 'SF_COLLECTIONS', 'sftkWriteVerified(', 'SF_REST_POST', 'chrome.storage.local.set']) expect(TH).not.toContain(w);
    // the confirmation uses the page's one dialog: the list steps aside, then comes back with the outcome
    expect(TH).toContain("if (host.closest('#modalBox') && typeof closeModal === 'function') closeModal();");
    expect(TH).toContain('if (!r.cancelled) _said.set(id, r.text);');
  });
  it('a disabled Undo says why (the state comes from sftkToolUndoState)', () => {
    expect(TH).toContain('const st = sftkToolUndoState(e);');
    expect(TH).toContain('title="${esc(st.title || \'\')}"');
  });
  it('everything a record or an org supplied is escaped', () => {
    expect(TH).toContain('${esc(e.profileName || e.tool || \'change\')}');
    expect(TH).toContain('${esc(w.text || w.describe)}');
    expect(TH).toContain('${esc(e.toolUndo.none)}');
    expect(TH).toContain('${esc(said)}');
  });
  it('the list follows the history as it changes, in the button, in a tool and in the open dialog', () => {
    expect(TH).toContain("chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.sftk_history) refreshAll(); });");
    expect(TH).toContain("document.querySelectorAll('[data-sftk-th-inline]').forEach(h => inline(h, h.getAttribute('data-sftk-th-inline')));");
    // registered while still empty, so the first change of a session shows up
    expect(TH.indexOf("host.setAttribute('data-sftk-th-inline', tab);")).toBeLessThan(TH.indexOf("if (!list.length) { host.innerHTML = ''; return; }"));
  });
  it('Field Cleaner lists its own changes under its results; its restore points keep their own name', () => {
    const FC = read('field-cleaner.js');
    expect(FC).toContain('<div id="fcToolHist"></div>');
    expect(FC).toContain("if (typeof sftkToolHistoryInline === 'function') sftkToolHistoryInline(eid('fcToolHist'), 'fields');");
    expect(FC).toContain('↩ Restore points — ${mine.length} piece${mine.length === 1 ? \'\' : \'s\'} of metadata saved before a fix');
    expect(FC).not.toContain('🧾 Cleanup history —');
  });
  it('no Toolkit tool still sends the user to Data Studio for its undo', () => {
    for (const f of ['popup.js', 'field-cleaner.js', 'lightning-pages.js', 'apex-debugger.js', 'user-copy.js', 'flow-permissions.js', 'dependency-map.js']) {
      const NL = String.fromCharCode(10);
      const src = read(f).split(NL).filter(l => !/^\s*\/\//.test(l)).join(NL);
      expect(src, f).not.toContain('Data Studio › History');
    }
  });
  it('the public build ships the file (it is not on any cut list)', () => {
    const PACK = read('scripts/pack_store.py');
    expect(PACK).not.toContain('sftk-toolhistory.js');
  });
});

describe('Data Studio › History', () => {
  it('lists only its own entries, and counts only those', () => {
    expect(SH).toContain("const split = (typeof sftkHistoryStudioSplit === 'function') ? sftkHistoryStudioSplit(_history) : { mine: _history, kit: {}, kitTotal: 0 };");
    expect(SH).toContain('const sorted = [...split.mine, ...mineArch].sort(');
    expect(SH).toContain("const mineArch = _archShown.filter(r => typeof sftkHistoryToolTab !== 'function' || !sftkHistoryToolTab(r));");
  });
  it('says how many Toolkit changes live in which tool, with a button to each — and that the export still has them', () => {
    const note = SH.slice(SH.indexOf('function _histKitNote('), SH.indexOf('function _histWireKitNote('));
    expect(note).toContain("if (!total) return '';");
    expect(note).toContain('data-hist-kit="${esc(t)}"');
    expect(note).toContain('each is in the tool that made it, with its ↩ Undo');
    expect(note).toContain('⬇ Export still includes them.');
    // a tool this build does not carry gets no button
    expect(note).toContain("const ships = tab => typeof sftkShips !== 'function' || sftkShips(tab);");
    expect(SH).toContain("chrome.runtime.getURL(`popup.html?tab=${encodeURIComponent(b.dataset.histKit)}&history=1`)");
  });
  it('the note is there even when the page has no entry of its own', () => {
    const empty = SH.slice(SH.indexOf('if (!split.mine.length && !mineArch.length) {'), SH.indexOf('const sorted = [...split.mine'));
    expect(empty).toContain('${_histKitNote(split.kit, split.kitTotal)}');
    expect(empty).toContain('_histWireKitNote();');
  });
  it('the link opens the tool on its history, once the tool is open and no dialog is in the way', () => {
    expect(TH).toContain("if (q.get('history') === '1' && sftkHistoryTabLabel(q.get('tab'))) {");
    expect(TH).toContain("!document.getElementById('sftkConfirmGo')");
  });
});
