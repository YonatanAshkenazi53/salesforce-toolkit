// QA 1.1 findings 66, 67, 68, 70, 71, 74: the 1.1.0 What's New card says what the build does, shows no developer notes, and is dated after its newest entry.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const MD = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = MD.indexOf('## 1.1.0');
const end = MD.indexOf('\n## ', start + 1);
const CARD = MD.slice(start, end);

describe('1.1.0 What\'s New card', () => {
  it('finds the card', () => { expect(start).toBeGreaterThan(-1); expect(CARD.length).toBeGreaterThan(1000); });

  it('does not describe the removed Remove all / Replace all walk (66, 71)', () => {
    for (const gone of [/Remove all/, /Replace all/, /walk buttons/, /Continue goes on/, /Pause button/, /Everything at once/, /Act on everything/]) expect(CARD, String(gone)).not.toMatch(gone);
    expect(CARD).toContain('All at once');
  });

  it('shows no developer notes: org aliases, script paths, fixture metadata (67)', () => {
    for (const dev of [/\bnpc2?\b/, /scripts\/dev\//, /\.mjs\b/, /Live on /, /Live npc/, /SFTK_Pkg_/, /packaged-object demo/, /A colleague/]) expect(CARD, String(dev)).not.toMatch(dev);
  });

  it('keeps no statement a newer bullet of the same card reversed (68, 74)', () => {
    expect(CARD).not.toMatch(/A switch above Scan/);
    expect(CARD).not.toMatch(/Undo in History/);
    expect(CARD).not.toMatch(/Restore\s+points under the results/);
    expect(CARD).not.toMatch(/The pause panel is three tabs/);
    expect(CARD).not.toMatch(/The first 200\s+updated records per object are kept/);
    expect(CARD).not.toMatch(/search layouts are left to Setup/);
    expect(CARD).not.toMatch(/Duplicate rules keep 🗑 only/);
    // the newer bullets that reversed them are still there
    expect(CARD).toMatch(/search layout of a packaged object is fixed here/);
    expect(CARD).toMatch(/Duplicate rules\*\* get ✂ \/ ⇄ \/ ✎/);
  });

  it('is dated no earlier than its newest entry (70)', () => {
    const head = CARD.match(/^## 1\.1\.0 — (\d{4}-\d{2}-\d{2})/)[1];
    const dates = [...CARD.matchAll(/\((\d{4}-\d{2}-\d{2})\)/g)].map(m => m[1]).sort();
    expect(head >= dates[dates.length - 1]).toBe(true);
    const prev = MD.match(/^## 1\.0\.0 — (\d{4}-\d{2}-\d{2})/m)[1];
    expect(head > prev).toBe(true);
  });

  it('keeps every bullet on its own line (no two bullets glued together)', () => {
    expect(CARD).not.toMatch(/[.)]- \*\*/);
  });
});
