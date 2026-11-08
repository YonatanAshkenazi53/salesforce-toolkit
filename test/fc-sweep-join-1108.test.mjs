// The full metadata text scan (2026-11-08, the owner's hand test): its name and its cost said up front; the hits the
// everyday scan already lists are not listed again; a fresh hit of a fixable kind JOINS the list with the ways of
// its kind; the result exports as CSV; a long retrieve says how long it has run.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const S = extractFunctions('sftk-sweep.js', ['sftkSweepCsv', 'sftkSweepJoinKind', 'sftkSweepIdQuery']);
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');

describe('sftkSweepCsv', () => {
  it('one row per line, quoted where needed, CRLF, the flags', () => {
    const result = { byType: {
      ApexClass: { label: 'Apex Classes', sev: 'blocker', items: [{ component: 'SFTK_Live_Class', path: 'classes/SFTK_Live_Class.cls', inScan: true, lines: [{ line: 2, text: 'return a.SFTK_Live_Blk__c, "x";' }] }] },
      Profile: { label: 'Profiles', sev: 'silent', items: [{ component: 'Admin', section: 'fieldPermissions', path: 'profiles/Admin.profile', joined: false, lines: [{ line: 10, text: '<field>Account.SFTK_Live_Blk__c</field>' }, { line: 11, text: 'b' }] }] },
    } };
    const csv = S.sftkSweepCsv(result, 'Account', 'SFTK_Live_Blk__c');
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('field,kind,severity,component,section,path,line,text,in the scan list,joined the list');
    expect(lines[1]).toBe('Account.SFTK_Live_Blk__c,Apex Classes (ApexClass),must fix before the delete,SFTK_Live_Class,,classes/SFTK_Live_Class.cls,2,"return a.SFTK_Live_Blk__c, ""x"";",yes,no');
    expect(lines[2]).toBe('Account.SFTK_Live_Blk__c,Profiles (Profile),breaks after the delete,Admin,fieldPermissions,profiles/Admin.profile,10,<field>Account.SFTK_Live_Blk__c</field>,no,no');
    expect(lines.length).toBe(5);   // header + 3 + the trailing empty
  });
});

describe('sftkSweepJoinKind / sftkSweepIdQuery', () => {
  it('fixable kinds join under their list name; flows, pages, layouts, reports, profiles stay in the box', () => {
    expect(S.sftkSweepJoinKind('ApexClass')).toBe('ApexClass');
    expect(S.sftkSweepJoinKind('ValidationRuleInactive')).toBe('ValidationRule');
    expect(S.sftkSweepJoinKind('CustomMetadataText')).toBe('CustomMetadataRecord');
    expect(S.sftkSweepJoinKind('LwcMarkup')).toBe('LightningComponentBundle');
    for (const t of ['Flow', 'FlexiPage', 'Layout', 'Report', 'Profile', 'PermissionSet', 'Translations', 'AuraDefinitionBundle', 'PathAssistant']) expect(S.sftkSweepJoinKind(t)).toBeNull();
  });
  it('a code kind is found by name; the rest need no id', () => {
    expect(S.sftkSweepIdQuery('ApexClass', 'SFTK_Live_Class')).toBe("SELECT Id FROM ApexClass WHERE Name = 'SFTK_Live_Class'");
    expect(S.sftkSweepIdQuery('ApexPage', "O'Brien")).toBe("SELECT Id FROM ApexPage WHERE Name = 'O\\'Brien'");
    expect(S.sftkSweepIdQuery('LightningComponentBundle', 'lwc/sftkLive')).toBe("SELECT Id FROM LightningComponentBundle WHERE DeveloperName = 'sftkLive'");
    expect(S.sftkSweepIdQuery('ValidationRule', 'Account.X')).toBeNull();
  });
});

describe('wiring (pins)', () => {
  it('the name and the cost up front', () => {
    expect(FC).toContain('<b>Full metadata text scan</b>');
    expect(FC).toContain('<strong>Expensive and slow:</strong> one API call per metadata type to list it, then several Metadata API retrieves — hundreds of calls and many minutes on a large org.');
    expect(FC).toContain('id="fcSweepPlan">🧭 Count the cost…</button>');
    expect(FC).toContain("'Look further than the index', 'every report, and a full metadata text scan — on request'");
    expect(FC).toContain('a large org: expect many minutes, and the bar to stand still while a big retrieve runs');
    expect(FC).not.toContain('Whole-org text sweep');
  });
  it('the box lists only what the list above does not carry; fresh fixable hits join the list; the CSV', () => {
    expect(FC).toContain('const shown = t => t.items.filter(it => !it.inScan && !it.joined);');
    expect(FC).not.toContain('in the list above</span>');
    expect(FC).toContain('async function _sweepJoin(s)');
    expect(FC).toContain("_supplemental: true, _sweep: true, _fullName: it.component, _sweepLines: it.lines");
    expect(FC).toContain('s.joined = await _sweepJoin(s);');
    expect(FC).toContain('if (s.joined) await renderResults(_lastScan.deps, _lastScan.fieldId); else renderOrgSweep();');
    expect(FC).toContain('joined the list above</strong> with the ✂ ⇄ ✎ 🗑 of their kind');
    expect(FC).toContain('id="fcSweepCsv"');
    expect(FC).toContain('-metadata-text-scan-${r.hits.length}.csv');
  });
});
