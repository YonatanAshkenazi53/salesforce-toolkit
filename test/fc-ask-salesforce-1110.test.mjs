// 🩺 Ask Salesforce (user 2026-11-10: "If we can ask Salesforce directly why we didn't do it?"). A CHECK-ONLY delete of
// the field: Salesforce validates it, deletes nothing and names what refuses it. Live on npc the same day: the demo
// field's scan listed no blocker, and Salesforce refused over an Aura bundle its own index no longer returned.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const F = extractFunctions('field-cleaner.js', ['fcAskVerdict']);
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const BG = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const REF = 'This custom field is referenced elsewhere in salesforce.com. : ';

describe('fcAskVerdict', () => {
  it('a refusal lists each name once, without the sentence Salesforce repeats', () => {
    const v = F.fcAskVerdict({ success: false, checkOnly: true, failures: [{ problem: REF + 'Field Updates.' }, { problem: REF + 'Workflow Rules.' }, { problem: REF + 'Field Updates.' }] }, 3);
    expect(v.kind).toBe('blocked');
    expect(v.lines).toEqual(['Field Updates', 'Workflow Rules']);
    expect(v.head).toContain('referenced by');
    expect(v.foot).toContain('names only some');
    // live 2026-11-10: Salesforce packs several names into ONE problem
    expect(F.fcAskVerdict({ success: false, failures: [{ problem: REF + 'Field Updates. ' + REF + 'Workflow Rules.' }] }, 1).lines).toEqual(['Field Updates', 'Workflow Rules']);
  });
  it('a refusal the scan has no blocker for says so and points at the full text scan', () => {
    const v = F.fcAskVerdict({ success: false, failures: [{ problem: REF + 'Aura Component Bundle "c:x" - COMPONENT - x.' }] }, 0);
    expect(v.lines).toEqual(['Aura Component Bundle "c:x" - COMPONENT - x']);
    expect(v.foot).toContain('The scan does not list this');
    expect(v.foot).toContain('Full metadata text scan');
  });
  it('another kind of refusal is given in Salesforce\'s own words', () => {
    const v = F.fcAskVerdict({ success: false, failures: [{ problem: 'Cannot delete a field in a managed package' }] }, 0);
    expect(v.head).toContain('in its own words');
    expect(v.lines).toEqual(['Cannot delete a field in a managed package']);
    expect(F.fcAskVerdict({ success: false, failures: [], errorMessage: 'UNKNOWN' }, 0).lines).toEqual(['UNKNOWN']);
  });
  it('an acceptance says what the answer does not cover, and names a disagreement with the list', () => {
    expect(F.fcAskVerdict({ success: true, failures: [] }, 0).foot).toContain('only what blocks');
    const v = F.fcAskVerdict({ success: true, failures: [] }, 2);
    expect(v.kind).toBe('ok');
    expect(v.foot).toContain('still marks 2 items as blocking');
  });
  it('no answer is an error, never an acceptance', () => {
    expect(F.fcAskVerdict(null, 0).kind).toBe('error');
    expect(F.fcAskVerdict({ error: 'Session expired' }, 0).lines).toEqual(['Session expired']);
  });
});

describe('the check-only deploy writes nothing', () => {
  it('has a message of its own; only that message sets checkOnly, and its answer is returned, not thrown', () => {
    expect(BG).toContain("case 'SF_METADATA_VALIDATE':");
    expect(BG).toContain('return sfMetadataDeploy(orgUrl, sid, message.zipBase64, message.testLevel, true);');
    expect(BG).toContain('return sfMetadataDeploy(orgUrl, sid, message.zipBase64, message.testLevel);');
    expect(BG).toContain('checkOnly:         checkOnly === true,');
    expect(BG).toContain('if (checkOnly !== true) await assertOrgWritable(orgUrl);');
    expect(BG).toContain('return { success: !!deployResult.success, checkOnly: true,');
  });
  it('Field Cleaner asks with the same zip the delete uses, and a packaged field has no button', () => {
    expect(FC).toContain("if (checkOnly === true) return bg({ type: 'SF_METADATA_VALIDATE',");
    expect(FC).toContain("try { r = await _deleteFieldViaMetadata(`${obj}.${field}`, true); }");
    expect(FC).toContain("${pkgNs ? '' : _askHtml().split('\\n')[0]}");
    expect(FC).not.toContain('This field can be safely deleted');
  });
});

// "We need to run it every scan" (user 2026-11-10)
describe('the check rides every scan', () => {
  const A = extractFunctions('field-cleaner.js', ['fcAskAuraBundles']);
  it('reads the Aura bundles a refusal names (the only kind Salesforce names one by one)', () => {
    expect(A.fcAskAuraBundles(['Aura Component Bundle "c:sftkLiveAura" - COMPONENT - sftkLiveAura', 'Aura Component Bundle "c:sftkLiveAura" - CONTROLLER - sftkLiveAura', 'Field Updates', 'Aura Component Bundle "ns:Other" - HELPER - Other']))
      .toEqual([{ ns: 'c', name: 'sftkLiveAura' }, { ns: 'ns', name: 'Other' }]);
    expect(A.fcAskAuraBundles(['Workflow Rules'])).toEqual([]);
  });
  it('runs once per scan, not for a mentions-only scope; a named bundle joins the list; a refusal locks the delete', () => {
    expect(FC).toContain("if (_lastScan.ask) { _paintAsk(_lastScan.ask); return; }");
    expect(FC).toContain("if (fcScopeNorm(_lastScan.scope) === 'mentions') return;");
    expect(FC).toContain("scan.deps.push({ MetadataComponentType: 'AuraDefinitionBundle', MetadataComponentId: b.Id, MetadataComponentName: b.DeveloperName, _tag:");
    expect(FC).toContain("for (const id of ['fcDelBtn', 'fcDelFreeBtn']) { const d = eid(id); if (d) d.disabled = true; }");
    expect(FC).toContain("let now = 2 + (fcScopeNorm(scope) === 'mentions' ? 0 : 2) + [L.flexiPages,");
  });
});

describe('Aura components are read by the scan itself, not through the index', () => {
  it('one Tooling query over every Aura source; a whole-word mention lists the bundle; a packaged one is skipped', () => {
    expect(FC).toContain("const res = await sfQ('SELECT Id, DefType, Source, AuraDefinitionBundleId, AuraDefinitionBundle.DeveloperName, AuraDefinitionBundle.NamespacePrefix FROM AuraDefinition', true);");
    expect(FC).toContain("add('AuraDefinitionBundle', bid, r.AuraDefinitionBundle?.DeveloperName || bid);");
    expect(FC).toContain("if (r.AuraDefinitionBundle?.NamespacePrefix) continue;");
    expect(FC).toMatch(/AuraDefinitionBundle: \{ icon: '⚡', label: 'Aura Components', fixable: false, sev: 'blocker'/);
  });
});
