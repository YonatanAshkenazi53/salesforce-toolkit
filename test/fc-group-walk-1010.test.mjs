import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');

// Walkthrough recording 2026-10-10: "Replace in all 5 flows" was confirmed twice and
// cancelled at the third flow; three flows were still open, but the group buttons
// ("Remove from all N flows …") were gone — the click handler REMOVED the box
// before the walk, for good. Now the box is disabled for the walk and drawn again
// afterwards for what is still open (or removed only when fewer than two remain).
describe('the "… all N" buttons survive a walk that stops early', () => {
  it('disables the group buttons for the walk instead of removing the box', () => {
    expect(FC).not.toMatch(/all\.closest\('\.fc-fix-allbox'\)\?\.remove\(\);\s*fixAll\(/);
    expect(FC).toContain("box?.querySelectorAll('button').forEach(b => { b.disabled = true; });");
    expect(FC).toContain('_walkRunning = true;');
  });
  it('draws the box again after the walk for what is still open, and removes it only under two', () => {
    const after = FC.slice(FC.indexOf("fixAll(t, _curFieldId, swap, all.dataset.way || '').finally(() => {"));
    expect(after).toContain("const open = group ? group.querySelectorAll('.fc-fix-pair').length : 0;");
    expect(after).toContain('if (open < 2) box.remove();');
    expect(after).toContain('else { box.dataset.n = String(open); box.innerHTML = _fixAllHtml(t, open, box.dataset.label); }');
  });
  it('a fix inside the walk keeps the redrawn buttons disabled until the walk ends', () => {
    expect(FC).toContain("if (_walkRunning) box.querySelectorAll('button').forEach(b => { b.disabled = true; });");
  });
});
