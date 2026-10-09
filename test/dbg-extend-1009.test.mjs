import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const SRC = readFileSync(new URL('../apex-debugger.js', import.meta.url), 'utf8');
const i = SRC.indexOf('function sftkDbgSameInstant(');
const end = SRC.indexOf('\n  }\n', i) + 4;
const same = new Function(SRC.slice(i, end) + ' return sftkDbgSameInstant;')();

// QA 2026-10-09 (live): Start Trace on a user who already had a trace EXTENDED it, the
// PATCH was accepted, and the re-read compared "2026-10-09T18:07:06.000+0000" with
// "2026-10-09T18:07:06.123Z" as strings — every extension was reported unverified.
describe('Debugger: an extended trace is verified by the instant, not the string', () => {
  it('same second, different spellings', () => {
    expect(same('2026-10-09T18:07:06.000+0000', new Date('2026-10-09T18:07:06.123Z'))).toBe(true);
    expect(same('2026-10-09T18:07:06.000+0000', '2026-10-09T18:07:06.900Z')).toBe(true);
    expect(same('2026-10-09T18:07:07.000+0000', new Date('2026-10-09T18:07:06.000Z'))).toBe(false);
    expect(same('', new Date())).toBe(false);
  });
  it('is what the extension verify uses', () => {
    expect(SRC).toContain('return { ok: sftkDbgSameInstant(chk.records[0].ExpirationDate, exp), text: null };');
    expect(SRC).not.toContain('chk.records[0].ExpirationDate === exp.toISOString()');
  });
});
