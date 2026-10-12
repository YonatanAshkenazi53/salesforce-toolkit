import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const POP = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');

// User 2026-10-12: "remove org health from the toolkit" — the Toolkit's home carried a card
// that only opened Data Studio's Org health. One door now: Data Studio's navigation.
describe('the Toolkit home has no Org health card', () => {
  it('no card with id health, and no home section lists it', () => {
    expect(POP).not.toMatch(/id:\s*'health'/);
    expect(POP).not.toContain("'flow-access', 'health'");
    expect(POP).not.toContain("studio.html#/orghealth");
  });
});
