import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';
import { readFileSync } from 'node:fs';

// User 2026-10-24: "in the parents tab, show by what field the parents are matched, and give the user
// an option to select a field".
const { sftkDeployParentMatchFields, sftkDeploySetParentMatchField } =
  extractFunctions('studio-deploy.js', ['sftkDeployParentMatchFields', 'sftkDeploySetParentMatchField']);

const tree = () => ({ objectType: 'Account', children: [
  { childSObject: 'Contact', field: 'AccountId', lookupResolutions: { IndividualId: { strategy: 'match', matchObject: 'Individual', matchField: 'Name' } }, children: [] },
  { childSObject: 'Opportunity', field: 'AccountId', children: [] },
] });
const step = { refObj: 'Campaign', neededBy: [{ obj: 'Opportunity', field: 'CampaignId' }, { obj: 'Contact', field: 'Camp__c' }] };

describe('the field a parent is matched by', () => {
  it('Name when no lookup says otherwise; one value when every lookup agrees', () => {
    expect(sftkDeployParentMatchFields(tree(), step)).toEqual(['Name']);
    const t = tree(); t.children[1].lookupResolutions = { CampaignId: { strategy: 'match', matchObject: 'Campaign', matchField: 'Ext__c' } };
    expect(sftkDeployParentMatchFields(t, step)).toEqual(['Ext__c', 'Name']);   // the two lookups disagree: both shown
  });
  it('the choice lands on every lookup that points at the parent, and counts what changed', () => {
    const t = tree();
    expect(sftkDeploySetParentMatchField(t, step, 'Ext__c')).toBe(2);
    expect(t.children[1].lookupResolutions.CampaignId).toEqual({ strategy: 'match', matchObject: 'Campaign', matchField: 'Ext__c' });
    expect(t.children[0].lookupResolutions.Camp__c).toEqual({ strategy: 'match', matchObject: 'Campaign', matchField: 'Ext__c' });
    expect(t.children[0].lookupResolutions.IndividualId.matchField).toBe('Name');   // another parent's lookup untouched
    expect(sftkDeploySetParentMatchField(t, step, 'Ext__c')).toBe(0);
    expect(sftkDeployParentMatchFields(t, step)).toEqual(['Ext__c']);
  });
});

describe('the row and the dialog', () => {
  const DV = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
  it('every parent row says its field and offers ✏; the dialog lists identifying fields, saves, and reads both orgs again', () => {
    expect(DV).toContain(' · matched by <b>${esc(matchedBy(s))}</b> <button class="ds-btn ds-btn-xs ds-dep-pmatch-btn" data-dep-pmatch-edit="${esc(s.refObj)}"');
    expect(DV).toContain("h.querySelectorAll('[data-dep-pmatch-edit]').forEach(b => b.addEventListener('click', () => _depParentMatchEdit(p, scan, steps.find(s => s.refObj === b.dataset.depPmatchEdit))));");
    expect(DV).toContain("(f.externalId || f.unique || f.nameField || ['string', 'email', 'phone', 'url'].includes(f.type)) && !f.calculated && f.type !== 'textarea'");
    expect(DV).toContain('const n = sftkDeploySetParentMatchField(p.tree, step, field);');
    expect(DV).toContain('await storageSaveProfiles(); }');
    expect(DV).toContain('await _depRescan(p);\n  });\n}\n\n// ⚠ Needs a decision'.replace(/\n/g, DV.includes('\r\n') ? '\r\n' : '\n'));
  });
});
