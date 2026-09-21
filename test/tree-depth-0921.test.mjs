import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// 2026-09-21 — the user's fixture on trailheads2 (record-triggered flow →
// L1 → L2 → L3 → L4): the tree stopped at depth 3 with "Manual review
// recommended" and never drew L4.
const DEP = readFileSync(new URL('../dependency-map.js', import.meta.url), 'utf8');

describe('the Dependencies tree draws as deep as the org goes', () => {
  it('no cap of 3 — one generous bound, named once', () => {
    expect(DEP).not.toContain('if (depth >= 3) {');
    expect(DEP).not.toContain('deeper than 3 levels');
    expect(DEP).toContain('const DEP_TREE_MAX_DEPTH = 25;');
    expect(DEP).toContain('if (depth >= DEP_TREE_MAX_DEPTH) {');
  });
  it('a loop is said, not drawn as an expand arrow with nothing under it', () => {
    const i = DEP.indexOf('if (hasChildren && visited.has(flow.ApiName)) {');
    expect(i).toBeGreaterThan(0);
    expect(DEP.slice(i, i + 700)).toContain('a loop; not expanded again');
    // the loop branch comes BEFORE the recursion, and recursion still copies the visited set per branch
    expect(i).toBeLessThan(DEP.indexOf('renderFlowNode(childFlow, depth + 1, new Set(visited))'));
  });
  it('hitting the bound points at the tool that follows a chain without drawing it', () => {
    expect(DEP).toContain('the rest is not drawn here. Right-click the flow above');
  });
});
