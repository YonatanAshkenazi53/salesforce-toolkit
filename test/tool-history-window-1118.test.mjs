// owner 2026-11-18, on the Activity window of a tool (a screenshot of its bottom: Show all 100 · Back up · Restore a
// backup · Clear activity · Close): "these buttons should be on the top of the page. scrolling down is anoying. also
// we need some better ui" · "and allow deletion of individuals".
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const TH = read('sftk-toolhistory.js'), H = read('sftk-history.js');

describe('the window', () => {
  it('everything that acts is above the list: close, filter, back up, restore, clear', () => {
    const w = TH.slice(TH.indexOf('showModal(`<div class="sftk-th-top">'), TH.indexOf("const box = document.getElementById('modalBox'); if (box) box.style.width"));
    const list = w.indexOf('id="sftkThModalList"');
    expect(list).toBeGreaterThan(-1);
    for (const id of ['sftkThClose', 'sftkThFind', 'sftkThBackup', 'sftkThRestore', 'sftkThClear']) {
      expect(w.indexOf(`id="${id}"`), id).toBeGreaterThan(-1);
      expect(w.indexOf(`id="${id}"`), id).toBeLessThan(list);
    }
    expect(TH).not.toContain('modal-actions sftk-th-actions');
  });
  it('the filter narrows the list as it is typed, and says how many of how many', () => {
    expect(TH).toContain('const list = inModal ? every.filter(e => matches(e, _find)) : every;');
    expect(TH).toContain("find.addEventListener('input', () => { _find = find.value; _askDel = ''; render(document.getElementById('sftkThModalList'), t, () => open(t)); });");
    expect(TH).toContain('const all = _showAll.has(tab) || (inModal && !!_find.trim());');
  });
});

describe('one entry deleted', () => {
  it('asks on the card itself, says when the Undo goes with it, and removes only that entry', () => {
    expect(TH).toContain("${canUndo ? 'Its Undo goes with it. ' : ''}Delete this entry?");
    expect(TH).toContain("const gone = typeof sftkHistoryRemove === 'function' ? await sftkHistoryRemove(id) : false;");
    expect(TH).toContain("host.querySelector('[data-th-del-no]')?.addEventListener('click', () => { _askDel = ''; render(host, tab, after, subject); });");
  });
  it('only the record goes — the function touches the list and nothing else', () => {
    const f = H.slice(H.indexOf('async function sftkHistoryRemove(id) {'), H.indexOf("// ── A backup file of one tool's History, WITH its undo"));
    expect(f).toContain('const keep = list.filter(h => !(h && h.id === key));');
    // QA 1.1 #5: nothing in the list — true only when its archived copy was deleted
    expect(f).toContain('if (keep.length === list.length) return archived;');
    expect(f).not.toMatch(/SF_|bg\(|send\(/);
  });
});

describe('the card', () => {
  it('Undo is drawn only when it can be pressed; why it cannot is said once', () => {
    expect(TH).toContain('const canUndo = st.show && !st.disabled;');
    expect(TH).toContain('${canUndo ? `<button class="btn btn-sm btn-primary sftk-th-undo" data-th-undo="${esc(e.id)}"');
    expect(TH).not.toContain('↩ no undo — ${esc(e.toolUndo.none)}');
  });
});
