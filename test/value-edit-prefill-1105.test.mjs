// ▸ record shows the values that are WRITTEN (2026-11-05, a colleague's first
// day with the tool: "when I click a record I see an empty record; I want to
// see every value of the record that will be created, change any field, save
// each record as I like, and have it remembered if I close the screen by
// mistake"). One record: the box holds the source's value unless changed,
// saved as you type, flushed on close; a read failure is said, never shown as
// "empty". Many records: the box is one value for all — unchanged.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const VE = readFileSync(new URL('../studio-valueedit.js', import.meta.url), 'utf8');

describe('one record: the box holds the value that is written', () => {
  it('the typed value, else the source\'s, as text — and the source\'s text travels on the box for the way back', () => {
    expect(VE).toContain("const srcText = f => (!many && srcRec) ? asText(srcRec[f.name]) : '';");
    expect(VE).toContain('const boxText = isNull ? \'\' : cur !== undefined ? asText(cur) : srcText(f);');
    expect(VE).toContain('data-ve-src="${esc(srcText(f))}"${unread');
    expect(VE).toContain('value="${esc(boxText)}" placeholder=');
    expect(VE).toContain("typeof v === 'boolean' ? String(v) : typeof v === 'object' ? JSON.stringify(v) : String(v)");
  });
  it('"changed" means differs from the source (one record) · non-empty (many)', () => {
    expect(VE).toContain("const changedBox = inp => many ? inp.value.trim() !== '' : inp.value.trim() !== String(inp.dataset.veSrc || '');");
  });
  it('saved as you type: the source\'s text clears the change, an emptied value writes empty, a bad value is said and not stored', () => {
    expect(VE).toContain("else if (text === st) v = undefined;           // the source's value: no change kept");
    expect(VE).toContain("else if (text === '') v = null;                // a value the source has, cleared: written empty");
    expect(VE).toContain("if (!r.ok) { err.textContent = `needs ${r.error} — not saved`; return; }");
    expect(VE).toContain("if (v === undefined) sftkValOvClear(node, p.targetOrg, ids[0], field); else sftkValOvSet(node, p.targetOrg, ids[0], field, v);");
    expect(VE).toContain("inp.addEventListener('input', () => { const tr = inp.closest('tr'); tr.querySelector('.ds-ve-err').textContent = ''; mark(tr); queueSave(tr); });");
    expect(VE).toContain("inp.addEventListener('change', () => queueSave(inp.closest('tr'), true));");
  });
  it('a pending save is flushed when the dialog closes — the Close button and Escape', () => {
    expect(VE).toContain("const flush = () => { for (const tr of [...timers.keys()]) queueSave(tr, true); };");
    expect(VE).toContain(`(eid('dsModalBox') || host).querySelectorAll('[data-dsaction="closeModal"]').forEach(b => b.addEventListener('click', flush, true));`);
    expect(VE).toContain("if (e.key === 'Escape') flush();");
  });
  it('no Save button for one record; the footer says how many values are changed; ✕ and ∅ go through the same save', () => {
    expect(VE).toContain('<button class="ds-btn ds-btn-sm ds-btn-primary" data-dsaction="closeModal">Close</button><span class="ds-dep-muted" id="dsVeStatus">');
    expect(VE).toContain("${many ? '✕ Clear every typed value' : '✕ Back to the source on every field'}");
    expect(VE).toContain("inp.value = many ? '' : String(inp.dataset.veSrc || '');");
    expect(VE).toContain("if (!on && !many) inp.value = String(inp.dataset.veSrc || '');   // back from \"empty\": the source's value again");
    expect(VE).toContain('mark(tr); queueSave(tr, true);');
  });
  it('a record that could not be read from the source is said — never shown as empty', () => {
    expect(VE).toContain("if (!r || r.error) { readErr = (r && r.error) ? String(r.error) : 'no answer'; return null; }");
    expect(VE).toContain("readErr = (r.records && r.records[0]) ? '' : 'the record is not there (deleted, or not visible to you)';");
    expect(VE).toContain('id="dsVeReadErr"');
    expect(VE).toContain('The source column and the boxes are EMPTY because of that, not because the record is');
  });
});

describe('many records: unchanged', () => {
  it('the bulk dialog keeps its Save, its empty-box rule and its Cancel', () => {
    expect(VE).toContain('${many ? `<button class="ds-btn ds-btn-sm ds-btn-primary" id="dsVeSave">💾 Save values</button><button class="ds-btn ds-btn-sm" data-dsaction="closeModal">Cancel</button>`');
    expect(VE).toContain("${many ? '(empty box = each record keeps its own value)' : '(the source\\'s value unless you change it)'}");
    expect(VE).toContain('const saveRow = async tr => {\n    if (many) return;');
  });
});
