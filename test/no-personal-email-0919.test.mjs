import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

// 2026-09-19 — user: "I dont want to publish my email if not needed". The
// shipped legal documents carried a personal address on their Contact line.
// They now name a ROUTE (the store listing's developer contact), which the
// owner can change in the dashboard without shipping a new version.
const SHIPPED_TEXT = readdirSync(new URL('..', import.meta.url))
  .filter(f => /\.(js|html|json|md|css)$/.test(f) || f === 'LICENSE')
  .filter(f => !/^(HANDOVER|LEGAL_NOTES)\.md$/.test(f) && !/^package(-lock)?\.json$/.test(f));

describe('no personal email address ships with the extension', () => {
  it.each(SHIPPED_TEXT)('%s', (f) => {
    const s = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    expect(s).not.toMatch(/[A-Za-z0-9._%+-]+@(gmail|outlook|hotmail|yahoo|icloud|proton(mail)?)\.[a-z.]+/i);
  });
  it('the three legal documents still say how to reach the developer', () => {
    for (const f of ['EULA.md', 'PRIVACY.md', 'LICENSE']) {
      expect(readFileSync(new URL('../' + f, import.meta.url), 'utf8')).toContain("the developer contact on this extension's Chrome Web Store page");
    }
  });
});
