// Pre-ship QA 2026-10-31: with the source org's session dead, the Deploy page's scan toast read
// "Diff scan: source query failed: SESSION_EXPIRED". It now says, in words, which org to sign
// in to again; other known codes go through the friendly text; an unknown one stays as it is.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const S = readFileSync(new URL('../studio-scan.js', import.meta.url), 'utf8');
const block = S.slice(S.indexOf('  if (res?.error) {\n    // an expired session is said in words'), S.indexOf("    showToast(msg, 'error', 9000);"));

describe('the scan toast on an expired session', () => {
  it('names the org whose query failed and says what to do', () => {
    expect(block).toContain("if (/SESSION_EXPIRED|INVALID_SESSION_ID/i.test(raw)) {");
    expect(block).toContain("const org = /^source/i.test(raw) ? profile.sourceOrg : /^target/i.test(raw) ? profile.targetOrg : '';");
    expect(block).toContain("msg = `Your session in ${org ? orgLabel(org) : 'one of the orgs'} has expired — open it in its Chrome tab and sign in again, then 🔄 Refresh state.`;");
  });
  it('other known codes get the friendly sentence; a generic one keeps the raw text', () => {
    expect(block).toContain("if (fe && fe.type && fe.type !== 'generic' && fe.message) msg = `Diff scan: ${fe.message}${fe.hint ? ` — ${fe.hint}` : ''}`;");
    expect(block).toContain('let msg = `Diff scan: ${raw}`;');
  });
});
