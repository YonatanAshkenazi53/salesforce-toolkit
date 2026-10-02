// Field Mapping said "trailheads4 not open — open it in a Chrome tab" while
// both orgs were open (user 2026-10-02: "both are open"). The object simply
// did not exist in those orgs (a deployment built elsewhere). The dialog now
// tells a closed org from an object it could not read.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const BM = readFileSync(new URL('../studio-builder-modals.js', import.meta.url), 'utf8');

describe('Field Mapping: a closed org and an unreadable object are two different messages', () => {
  it('keeps WHY per side', () => {
    expect(BM).toContain("let srcFailWhy = '', tgtFailWhy = '';");
    expect((BM.match(/FailWhy = \w+\.sid \? 'describe' : 'closed'/g) || []).length).toBe(4);
    expect((BM.match(/FailWhy = 'closed';/g) || []).length).toBe(2);
  });
  it('says the object could not be read when the org IS open, and "not open" only when it is not', () => {
    expect(BM).toContain("could not be read in ${esc(orgLabel(url))} — the object may not exist in that org, or you cannot access it there");
    expect(BM).toContain("not open — open it in a Chrome tab, then reopen this modal");
    expect(BM).toContain('${failText(srcUrl, srcFailWhy)}');
    expect(BM).toContain('${failText(tgtUrl, tgtFailWhy)}');
  });
});
