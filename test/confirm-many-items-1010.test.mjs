import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const SRC = readFileSync(new URL('../sftk-confirm.js', import.meta.url), 'utf8');

// Video recording 2026-10-10: the rollback of a 29-record run never showed its
// confirmation — "ReferenceError: Cannot access 'C' before initialization" from
// sftkConfirmDestructive. The items list (with its filter box for more than 8
// items) used the class map C before the line that declared it.
describe('the shared confirmation can list more than 8 items', () => {
  it('declares its class map before the items list uses it', () => {
    const fn = SRC.slice(SRC.indexOf('function sftkConfirmDestructive('), SRC.indexOf('\nfunction ', SRC.indexOf('function sftkConfirmDestructive(') + 10));
    const decl = fn.indexOf('const C = ds');
    const use = fn.indexOf('${C.input} sftk-cf-filter');
    expect(decl).toBeGreaterThan(-1);
    expect(use).toBeGreaterThan(-1);
    expect(decl).toBeLessThan(use);
  });
  it('the same holds for sftkDialog', () => {
    const fn = SRC.slice(SRC.indexOf('function sftkDialog('));
    expect(fn.indexOf('const C = ds')).toBeLessThan(fn.indexOf('${C.input} sftk-cf-filter'));
  });
});
