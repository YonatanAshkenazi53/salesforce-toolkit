import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const HTML = readFileSync(new URL('../legal.html', import.meta.url), 'utf8');
const EULA = readFileSync(new URL('../EULA.md', import.meta.url), 'utf8');

// QA 2026-10-07 (user screenshot: "colors are wierd. unreadable"): in dark mode the legal
// page drew near-white text on a white card — the dark @media block came BEFORE the light
// .doc / .tabs a.on / code rules of equal specificity, so the light ones won.
describe('legal page: dark mode rules come after the light ones', () => {
  it('the dark block is the last rule of the stylesheet', () => {
    const dark = HTML.indexOf('@media (prefers-color-scheme: dark)');
    expect(dark).toBeGreaterThan(0);
    for (const sel of ['.doc { background: #fff', '.tabs a.on { background: #fff', 'code { font-family']) expect(HTML.indexOf(sel)).toBeLessThan(dark);
    expect(HTML.indexOf('</style>')).toBeGreaterThan(dark);
    expect(HTML).toContain('.doc { background: #1f2024; }');
  });
  it('the EULA names the tools that ship, not the cut ones', () => {
    for (const gone of ['Org Seeder', 'sync ring', 'picklist tools', 'Reconcile,', 'readiness']) expect(EULA).not.toContain(gone);
    expect(EULA.replace(/s+/g, ' ')).toContain('data deployments and rollbacks, All open orgs, Org Compare, Org health');
  });
});
