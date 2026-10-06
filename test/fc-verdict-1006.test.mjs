import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const SRC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');

// QA 2026-10-06: the data verdict read "Empty on 99.9% of 8 of 10,266 records".
// The percentage is of all records; the count is how many hold a value.
describe('Field Cleaner data verdict says the two facts apart', () => {
  it('scope is the whole record count, holders a separate clause', () => {
    expect(SRC).toContain("const scope = `${v.total.toLocaleString()} ${v.sampled ? 'sampled' : 'records'}`;");
    expect(SRC).toContain("const holders = v.filled === 0 ? 'none holds a value'");
    expect(SRC).toContain('? `Empty on <strong>${pctStr(emptyPct)}%</strong> of ${scope} (${holders})`');
    expect(SRC).toContain(': `Populated on <strong>${pctStr(pctFilled)}%</strong> of ${scope} (${holders})`');
    expect(SRC).not.toContain('of ${v.total.toLocaleString()} sampled` : `${v.filled.toLocaleString()} of');
  });
});
