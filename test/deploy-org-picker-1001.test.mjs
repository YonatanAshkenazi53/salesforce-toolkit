// Campaign 4 phase 2, step 1 — "Between which orgs": the Deploy page offers
// the orgs open in Chrome, the user picks From and To, the saved pair is only
// "last used" (user 2026-10-01: "profile should run and compare just between
// all open orgs in the browser, u select the source and the targets already
// auto calculate by that").
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunction } from './extract.mjs';
const DV = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
const CO = readFileSync(new URL('../studio-core.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../studio.css', import.meta.url), 'utf8');

const picker = extractFunction('studio-deploy.js', 'sftkDeployOrgPicker');
const key = u => String(u || '').replace(/^https?:\/\//, '').replace(/\.my\.salesforce\.com.*$/, '').toLowerCase();
const label = u => u ? key(u) : '';
const T5 = 'https://trailheads5.my.salesforce.com', T4 = 'https://trailheads4.my.salesforce.com', T2 = 'https://trailheads2.my.salesforce.com';
const open2 = [{ url: T5, key: 'trailheads5', label: 'trailheads5' }, { url: T4, key: 'trailheads4', label: 'trailheads4' }];

describe('the picker model (pure)', () => {
  it('last used pair, both open → both preselected, the target list excludes the source', () => {
    const m = picker({ sourceOrg: T5, targetOrg: T4 }, open2, label, key);
    expect(m.src).toBe('trailheads5');
    expect(m.tgt).toBe('trailheads4');
    expect(m.targets.map(o => o.key)).toEqual(['trailheads4']);
    expect(m.notes).toEqual([]);
  });
  it('a target that is not open is NOT silently replaced — nothing is pre-selected, the note says what to do', () => {
    const m = picker({ sourceOrg: T5, targetOrg: T2 }, open2, label, key);
    expect(m.src).toBe('trailheads5');
    expect(m.tgt).toBe('');
    expect(m.targets.map(o => o.key)).toEqual(['trailheads4']);   // offered, never ticked
    expect(m.notes[0]).toMatch(/^Last used: trailheads5 → trailheads2\. trailheads2 is not open/);
  });
  it('the source not open → no source, every open org is offered as a source', () => {
    const m = picker({ sourceOrg: T2, targetOrg: T4 }, open2, label, key);
    expect(m.src).toBe('');
    expect(m.sources.length).toBe(2);
    expect(m.notes[0]).toMatch(/trailheads2 is not open/);
  });
  it('a new deployment with no orgs yet: nothing selected, no "last used" note', () => {
    const m = picker({}, open2, label, key);
    expect(m.src).toBe(''); expect(m.tgt).toBe('');
    expect(m.notes).toEqual([]);
  });
  it('one org open → says to open the other; none → says to open two', () => {
    expect(picker({}, [open2[0]], label, key).notes[0]).toBe('Only trailheads5 is open in Chrome. Open the other org in a tab to deploy between them.');
    expect(picker({}, [], label, key).notes[0]).toMatch(/^No Salesforce org is open in Chrome/);
  });
  it('source and target the same org (stale data) → the target is dropped, never offered against itself', () => {
    const m = picker({ sourceOrg: T5, targetOrg: T5 }, open2, label, key);
    expect(m.src).toBe('trailheads5');
    expect(m.tgt).toBe('');
    expect(m.targets.map(o => o.key)).toEqual(['trailheads4']);
  });
});

describe('wiring', () => {
  it('studio-core lists the open orgs once, deduped by org key, with sid only', () => {
    const fn = CO.slice(CO.indexOf('function sftkOpenOrgs('), CO.indexOf('\n}\n', CO.indexOf('function sftkOpenOrgs(')));
    expect(fn).toContain('_buildAllSessions()');
    expect(fn).toContain('if (!s || !s.sid || !s.orgUrl) continue;');
    expect(fn).toContain('seen.set(key, { url: s.orgUrl, key, label: orgLabel(s.orgUrl) })');
  });
  it('the picker sits on top of BOTH Deploy page branches (nothing read yet, and fresh) and is wired on both', () => {
    expect((DV.match(/<div class="ds-dep-page">\$\{_depOrgPickerHtml\(p\)\}/g) || []).length).toBe(2);
    expect((DV.match(/_depWireOrgPicker\(p\);/g) || []).length).toBe(2);
  });
  it('the markup never pre-selects a missing side and disables the target until a source is picked', () => {
    expect(DV).toContain('<option value="" ${m.src ? \'\' : \'selected\'} disabled>— pick the source —</option>');
    expect(DV).toContain('aria-label="Target org" ${m.src ? \'\' : \'disabled\'}');
    expect(DV).toContain('only orgs open in Chrome are offered · picking writes nothing');
  });
  it('picking saves the pair as last-used, refuses the same org twice, and starts selections over', () => {
    const fn = DV.slice(DV.indexOf('async function _depSetPair('), DV.indexOf('\n}\n', DV.indexOf('async function _depSetPair(')));
    expect(fn).toContain("if (src && tgt && src.key === tgt.key) { showToast('Source and target must be two different orgs.'");
    expect(fn).toContain('if (src) p.sourceOrg = src.url;');
    expect(fn).toContain('if (tgt) p.targetOrg = tgt.url;');
    expect(fn).toContain("if (!p.ephemeral && typeof storageSaveProfiles === 'function')");
    expect(fn).toContain("_depForProfile = '';");
    expect(fn).toContain('renderDeploy();');
  });
  it('styles exist', () => {
    expect(CSS).toContain('.ds-dep-orgs-row {');
  });
});
