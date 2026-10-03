// "Created before parent" (child-first) left the builder on 2026-10-03 (user:
// "take it out"): unverified on the Deploy page and rarely needed since a whole
// tree deploys in one run. The ENGINE still honours the setting (its own tests
// are engine-childfirst.test.mjs), so a deployment that already carries it must
// stay visible and resettable — and nothing in the builder may set it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const BU = readFileSync(new URL('../studio-builder.js', import.meta.url), 'utf8');

describe('the builder no longer offers child-first', () => {
  it('nothing assigns insertOrder = childFirst any more', () => {
    expect(BU).not.toMatch(/insertOrder\s*=\s*'childFirst'/);
    expect(BU).not.toContain('⤵ Created after parent');
  });
  it('the chip exists only for a node that already carries the setting, and says how to go back', () => {
    expect(BU).toContain('${!isRoot && cfOn ? `<button class="ds-btn ds-btn-xs ds-btn-config ds-btn-config--active" data-order-btn="${esc(pathKey)}"');
    expect(BU).toContain('⤴ Created before parent — click for the normal order');
    expect(BU).toContain('This option is no longer offered: click to return to the normal order (parent first).');
  });
  it('clicking it only ever removes the setting', () => {
    const i = BU.indexOf("area.querySelectorAll('[data-order-btn]')");
    const block = BU.slice(i, i + 400);
    expect(block).toContain('delete node.insertOrder;');
    expect(block).not.toContain("= 'childFirst'");
  });
  it('a collapsed node still shows that it carries it (state is never invisible)', () => {
    expect(BU).toContain("if (node.insertOrder === 'childFirst') bits.push('⤴ child-first');");
  });
});
