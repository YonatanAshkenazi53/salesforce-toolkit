// 2026-11-17 (owner, to "which extra metadata kinds to scan": "All of them please") — the 🧭 text scan reads the
// org's own TEXT static resources through the REST API; the retrieve leaves the kind out (images, fonts, zips).
// Live on npc2 the same day (docs/fixtures/gap-kinds-fixture/kinds-app): a check-only delete of the field named by a
// static resource, by a Change Data Capture channel member's enriched field and by a record type's picklist values
// SUCCEEDS — none of the three blocks, so each is a mention.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const S = extractFunctions('sftk-sweep.js', [
  'sftkSweepForms', 'sftkSweepHits', 'sftkSweepSections', '_sftkSweepSectionAt', 'sftkSweepKind', 'sftkSweepRun',
  'sftkSweepKindTable', 'sftkSweepTextResource', '_sftkSweepBinary', 'sftkSweepIsText',
]);
const FC = read('field-cleaner.js');

describe('which static resources are read', () => {
  const t = (ContentType, BodyLength = 100, NamespacePrefix = null) => S.sftkSweepTextResource({ ContentType, BodyLength, NamespacePrefix });
  it('scripts, styles, JSON, XML and plain text of the org itself', () => {
    for (const c of ['application/javascript', 'text/javascript', 'text/css', 'application/json', 'text/plain', 'application/xml', 'text/xml', 'image/svg+xml', 'application/x-javascript']) expect(t(c), c).toBe(true);
  });
  it('not images, fonts, zips, an empty one, one over 1 MB, or a package\'s', () => {
    for (const c of ['image/png', 'application/zip', 'application/octet-stream', 'font/woff2', 'application/pdf', '']) expect(t(c), c).toBe(false);
    expect(t('text/css', 0)).toBe(false);
    expect(t('text/css', 1000001)).toBe(false);
    expect(t('text/css', 1000000)).toBe(true);
    expect(t('text/css', 100, 'dlrs')).toBe(false);
    expect(S.sftkSweepTextResource(null)).toBe(false);
  });
});

describe('a static resource that names the field', () => {
  it('is listed under Static Resources as something that breaks later, never a blocker', () => {
    const F = S.sftkSweepForms('SFTK_Kind__c', 'Tag__c');
    const r = S.sftkSweepRun(new Map([['unpackaged/staticresources/SFTK_Kind_Js.resource', "const cols = ['SFTK_Kind__c.Tag__c', 'Name'];"]]), F);
    expect(Object.keys(r.byType)).toEqual(['StaticResource']);
    expect(r.byType.StaticResource.items[0].component).toBe('SFTK_Kind_Js');
    expect(r.byType.StaticResource.sev).toBe('mention');
    expect(S.sftkSweepKindTable().StaticResource.sev).toBe('mention');
  });
});

describe('a Change Data Capture channel member that sends the field', () => {
  it('has its own group, as something that breaks later', () => {
    const F = S.sftkSweepForms('SFTK_Kind__c', 'Tag__c');
    const xml = '<?xml version="1.0"?>\n<PlatformEventChannelMember><enrichedFields><name>Tag__c</name></enrichedFields><eventChannel>SFTK_Kind_Chn__chn</eventChannel><selectedEntity>SFTK_Kind__ChangeEvent</selectedEntity></PlatformEventChannelMember>';
    const r = S.sftkSweepRun(new Map([['unpackaged/platformEventChannelMembers/SFTK_Kind_Chn_chn_SFTK_Kind_ChangeEvent.platformEventChannelMember', xml]]), F);
    expect(S.sftkSweepKindTable().PlatformEventChannelMember.sev).toBe('mention');
    expect(Object.keys(r.byType)).toEqual(['PlatformEventChannelMember']);
  });
  it('the empty result of a scan still draws the text scan box', () => {
    const from = FC.indexOf('<div class="fc-clean-title">${esc(ev.title)}</div>');
    expect(from).toBeGreaterThan(0);
    const empty = FC.slice(from, FC.indexOf('    // Group\n    _groups = {};'));
    expect(empty).toContain('renderReportScan();');
    expect(empty).toContain('renderOrgSweep();');
  });
});

describe('the scan', () => {
  it('lists them while counting the cost, so the price shown includes one call each', () => {
    expect(FC).toContain("query: 'SELECT Id, Name, ContentType, BodyLength, NamespacePrefix FROM StaticResource WHERE NamespacePrefix = null'");
    expect(FC).toContain('const calls = s.groups.length * 2 + s.listCalls + ((s.res && s.res.length) || 0);');
  });
  it('reads each body as text and says how many were read and how many were left out', () => {
    expect(FC).toContain('path: `services/data/v62.0/sobjects/StaticResource/${r.Id}/Body`');
    expect(FC).toContain('s.files.set(`unpackaged/staticresources/${r.Name}.resource`, b.text)');
    expect(FC).toContain('left out: images, fonts, zips, or over 1 MB');
  });
});

// owner 2026-11-17 (a screenshot of rows with no name and their buttons on the left): the "✂ Remove is not possible
// here" note is a full-width child of the row — the row must wrap, or the note squeezes the name to nothing
describe('a row with a pre-check note', () => {
  it('wraps, so the name and the buttons keep their line and the note takes the next', () => {
    const CSS = read('styles.css');
    expect(CSS).toMatch(/\.fc-item:has\(> \.fc-xml-done\), \.fc-item:has\(> \.fc-item-pre\) \{ flex-wrap: wrap; \}/);
    expect(CSS).toMatch(/\.fc-item-pre \{ flex: 1 1 100%;/);
  });
});
