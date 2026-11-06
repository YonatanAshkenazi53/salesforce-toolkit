// Field Cleaner's "how much data is stored in this field" line, audited after the
// user doubted it on a field deleted in the work org (2026-11-07: "אני לא בטוח שהוא
// קלט נכון כמה רשומות משתמשות בשדה"). Three ways the number could be wrong, pinned shut.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');

describe('the stored-values count', () => {
  it('a count that comes back for an earlier pick is dropped (pick A, then B: never A\'s numbers under B)', () => {
    expect(FC).toContain('const run = ++_dataRun, stale = () => run !== _dataRun;');
    expect(FC).toContain('if (stale()) return;\n\n    if (agg.error) {');
    expect(FC).toContain('if (run !== undefined && run !== _dataRun) return;   // a later pick replaced this one');
    expect(FC).toContain("return _sampleDataUsage(obj, fld, run);");
  });
  it('a formula, roll-up or auto-number is told by describe (calculated / autoNumber), not by a word in the type', () => {
    expect(FC).toContain('if (d.calculated || d.autoNumber || /formula|roll-?up|summary|auto');
    expect(FC).toContain("number|calculated/i.test(_selField.type || '')) {");
  });
  it('a checkbox is counted by how many records have it ticked, and said so', () => {
    expect(FC).toContain("const isBool = (d.type || _selField.type) === 'boolean';");
    expect(FC).toContain('query: `SELECT COUNT(Id) filled FROM ${obj} WHERE ${fld} = true` });');
    expect(FC).toContain("query: `SELECT MAX(LastModifiedDate) m FROM ${obj} WHERE ${fld} ${isBool ? '= true' : '!= null'}` });");
    expect(FC).toContain("? (v.filled === 0 ? 'none is ticked' : `${v.filled.toLocaleString()} ${v.filled === 1 ? 'is' : 'are'} ticked`)");
    expect(FC).toContain("${v.bool ? 'Unticked' : 'Empty'} on <strong>${pctStr(emptyPct)}%</strong>");
    expect(FC).toContain("${v.bool ? 'Ticked' : 'Populated'} on <strong>${pctStr(pctFilled)}%</strong>");
  });
  it('the plain count is one aggregate query — COUNT(Id) and COUNT(field) — never a sample unless Salesforce refuses or times out', () => {
    expect(FC).toContain('query: `SELECT COUNT(Id) tot, COUNT(${fld}) filled FROM ${obj}` });');
    expect(FC).toContain('if (/aggregate|group by|not supported|COUNT|encrypted/i.test(agg.error)) {');
    expect(FC).toContain('if (/timeout|time limit|too many/i.test(agg.error)) {');
  });
});
