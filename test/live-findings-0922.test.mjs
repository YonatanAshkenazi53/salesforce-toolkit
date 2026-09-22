// 2026-09-22 — first HEADLESS LIVE run of the extension (scripts/dev/headless-studio.mjs,
// trailheads2 via the CLI's frontdoor link, trailheads4 closed):
//  • Field Mapping said "No connected orgs" above 46 fields of the connected source
//  • the Deploy page looked ready with the target closed; only a toast after a click said otherwise
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunction } from './extract.mjs';

const BM = readFileSync(new URL('../studio-builder-modals.js', import.meta.url), 'utf8');
const DV = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
const offline = extractFunction('studio-deploy.js', 'sftkDeployOffline');

describe('live-run findings, round 1', () => {
  it('Field Mapping lists the current tab’s org too', () => {
    const fn = BM.slice(BM.indexOf('function allOrgs() {'), BM.indexOf('// ── Per-org describe'));
    expect(fn).toContain("const sessions = (typeof _buildAllSessions === 'function') ? _buildAllSessions() : _allSessions;");
    expect(fn).toContain('for (const s of sessions) {');
  });
  it('sftkDeployOffline names the orgs without a live session, fail-closed on a resolver error', () => {
    const p = { sourceOrg: 'https://a.my.salesforce.com', targetOrg: 'https://b.my.salesforce.com' };
    const have = new Set(['https://a.my.salesforce.com']);
    expect(offline(p, [], u => have.has(u) ? { sid: 'x' } : null)).toEqual(['https://b.my.salesforce.com']);
    expect(offline(p, [], () => ({ sid: 'x' }))).toEqual([]);
    expect(offline(p, [], () => { throw new Error('boom'); })).toEqual([p.sourceOrg, p.targetOrg]);
    expect(offline(p, [], u => ({ sid: '' }))).toEqual([p.sourceOrg, p.targetOrg]);
    expect(offline(null, [], () => null)).toEqual([]);
  });
  it('the page says so up front and disables both reads', () => {
    expect(DV).toContain('not open in a Chrome tab — this page reads both orgs live');
    expect(DV).toContain(`id="dsDepScan" \${offline.length ? 'disabled title="Open the org(s) named above first"' : ''}`);
    expect(DV).toContain(`id="dsDepRefresh" \${offline.length ? 'disabled title="Open the org(s) named on the page first"' : ''}`);
    // painted on BOTH branches: no scan yet, and a scan on file
    expect(DV.split('${offlineHtml}').length).toBe(3);
  });
});
