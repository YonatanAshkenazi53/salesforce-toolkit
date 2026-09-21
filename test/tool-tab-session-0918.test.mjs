import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// 2026-09-18 — user's chrome://extensions error: "Uncaught TypeError: Cannot
// read properties of null (reading 'replace')" at lightning-pages.js init.
// A sidebar click reached a tool tab before any Salesforce session existed, so
// the tool was initialised with orgUrl = null. loadFlows() already guarded
// this; the six tool tabs did not.
const POPUP = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const LP = readFileSync(new URL('../lightning-pages.js', import.meta.url), 'utf8');

const TABS = ['initLightningPagesTab', 'initDebuggerTab', 'initFieldCleanerTab',
  'initUserCopyTab', 'initLicenseManagerTab', 'initFlowAccessTab'];

describe('tool tabs never initialise without a session', () => {
  it('one shared guard shows the connect state instead', () => {
    const i = POPUP.indexOf('function toolTabHasSession() {');
    expect(i).toBeGreaterThan(0);
    const fn = POPUP.slice(i, i + 200);
    expect(fn).toContain('if (orgUrl && sid) return true;');
    expect(fn).toContain('initSession();');
    expect(fn).toContain('return false;');
  });

  it.each(TABS)('%s checks the session before anything else', (name) => {
    const i = POPUP.indexOf(`function ${name}() {`);
    expect(i).toBeGreaterThan(0);
    const firstLine = POPUP.slice(i).split('\n')[1].trim();
    expect(firstLine).toBe('if (!toolTabHasSession()) return;');
  });

  it('Lightning Pages cannot throw on a missing org even if it is reached', () => {
    expect(LP).toContain("String(orgUrl || '').replace(/[^a-z0-9]/gi, '_')");
    expect(LP).not.toContain('${orgUrl.replace(/[^a-z0-9]/gi');
  });
});
