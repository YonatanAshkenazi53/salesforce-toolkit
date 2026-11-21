// owner 2026-11-13: "we need a feature to apply pii for all selected records" (before it: "how do we apply pii for
// all of the records of each object"). One action on the Deploy page for every selected record of every object, and
// the three places the PII review of 2026-11-13 found a covered value could stay or travel as it is.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const DEP = read('studio-deploy.js'), BLD = read('studio-builder.js'), REC = read('studio-reconcile.js'), BG = read('background.js');
const { sftkDeployPiiScope: scope, sftkDeployPiiCovered: covered } = extractFunctions('studio-deploy.js', ['sftkDeployPiiScope', 'sftkDeployPiiCovered']);
const { bldPiiIdChunks: chunks, bldPiiReadWords: words } = extractFunctions('studio-builder.js', ['bldPiiIdChunks', 'bldPiiReadWords']);
const { sftkRecPiiEmptyWrites: emptyWrites, sftkRecSrcUpdatePiiGuard: guard } = extractFunctions('studio-reconcile.js', ['sftkRecPiiEmptyWrites', 'sftkRecSrcUpdatePiiGuard']);
const { sftkScanPiiBlind: blind, sftkScanPiiBlindLine: blindLine, sftkScanPiiBlindKeysMatter: keysMatter } = extractFunctions('studio-scan.js', ['sftkScanPiiBlind', 'sftkScanPiiBlindLine', 'sftkScanPiiBlindKeysMatter']);
const S = (...a) => new Set(a);

describe('the records a treatment is chosen from', () => {
  it('every selected insert and source-wins update, of the root and of every child', () => {
    const r = scope({ push: S('a1', 'a2'), overwrite: S('a3'), updSrc: S('a4'), del: S('t1'), pull: S('t2') },
      { 0: { push: S('c1'), overwrite: S('c2'), relink: S('c3'), del: S('c4') }, '0.0': { push: S('k1') } }, 'Account', { 0: 'Contact', '0.0': 'Case' });
    expect(r.byObj).toEqual({ Account: ['a1', 'a2', 'a3'], Contact: ['c1', 'c2'], Case: ['k1'] });
    expect(r.total).toBe(6); expect(r.objects).toBe(3);
  });
  it('two paths of one object are one list; an id is counted once; nothing selected is nothing', () => {
    const r = scope({ push: S('x') }, { 0: { push: S('c1', 'c2') }, 1: { push: S('c2', 'c3') } }, 'Account', { 0: 'Contact', 1: 'Contact' });
    expect(r.byObj.Contact).toEqual(['c1', 'c2', 'c3']); expect(r.total).toBe(4);
    expect(scope(null, null, 'Account', {})).toEqual({ byObj: {}, total: 0, objects: 0 });
    expect(scope({ updSrc: S('a'), del: S('b'), pull: S('c') }, { 0: { relink: S('d'), del: S('e') } }, 'Account', { 0: 'Contact' }).total).toBe(0);
  });
  it('the chip counts the rules of the selected objects only', () => {
    const pol = { 'Lead.Email': { strategy: 'hash' }, 'lead.Phone': { strategy: 'null' }, 'Contact.Email': { strategy: 'hash' }, 'Lead.Old': null };
    expect(covered(pol, ['Lead'])).toBe(2); expect(covered(pol, ['Lead', 'Contact'])).toBe(3); expect(covered(pol, ['Case'])).toBe(0); expect(covered(null, ['Lead'])).toBe(0);
  });
});

describe('the Deploy page', () => {
  it('one button in the action bar; it follows the selection and stays off for an unsaved deployment or a running one', () => {
    expect(DEP).toContain('<button class="ds-btn ds-btn-lg" id="dsDepPiiSel" disabled');
    expect(DEP).toContain("piiBtn.disabled = !sc.total || !!window._sftkRunActive || !!p.ephemeral;");
    expect(DEP).toContain("_depPiiSuggest(p, sc.byObj, `the ${sc.total.toLocaleString('en-US')} record${sc.total === 1 ? '' : 's'} you selected`, { selected: true });");
  });
  it('the window reads every selected record, 200 ids a call, and says when it read fewer than asked', () => {
    expect(chunks(Array.from({ length: 450 }, (_, i) => i), 200).map(c => c.length)).toEqual([200, 200, 50]);
    expect(chunks([], 200)).toEqual([]);
    expect(words(40, 40)).toBe('40 records read'); expect(words(1, 1)).toBe('1 record read');
    expect(words(2000, 5300)).toBe('2,000 of 5,300 records read');
    expect(BLD).toContain('const only = wanted ? wanted.slice(0, BLD_PII_READ_MAX) : null;');
    expect(BLD).toContain('for (const part of (only ? bldPiiIdChunks(only, 200) : [null])) {');
  });
  it('the window says a treatment belongs to the field, and that the rules were saved', () => {
    expect(BLD).toContain('A treatment belongs to the field: it covers every record this deployment writes');
    expect(BLD).toContain("o.saved ? 'Saved on this deployment.' : 'Save the deployment to keep the rules.'");
  });
});

describe('a covered value never stays or travels as it is', () => {
  it('an update writes an explicit empty for a covered field the source holds empty', () => {
    const rules = { email: { strategy: 'hash' } };
    expect(emptyWrites(true, rules, 'Email')).toBe(true);
    expect(emptyWrites(true, rules, 'Phone')).toBe(false);
    expect(emptyWrites(false, rules, 'Email')).toBe(false);
    expect(emptyWrites(true, { recordtypeid: {} }, 'RecordTypeId')).toBe(false);
    expect(REC).toContain("if (!sftkRecPersonOnlyField(objType, sr, sf) && sftkRecPiiEmptyWrites(piiActive, piiRules, sf)) { piiTgtFields.add(tf); p[tf] = null;");
  });
  it('the ← step leaves every covered field out and drops the policy from its copy', () => {
    const fm = { Email: 'Work_Email__c', Notes__c: null, Phone: '' };
    const inv = { Work_Email__c: 'Email' };
    const out = guard(inv, fm, { 'Lead.email': { strategy: 'hash' }, 'Lead.Phone': { strategy: 'null' }, 'Lead.Notes__c': { strategy: 'null' }, 'Contact.Email': { strategy: 'hash' }, 'Lead.Gone': null }, 'Lead');
    expect(out.sort()).toEqual(['Phone', 'Work_Email__c']);
    expect(inv).toEqual({ Work_Email__c: null, Phone: null });
    expect(guard({}, {}, null, 'Lead')).toEqual([]);
    const at = REC.indexOf('const kept = sftkRecSrcUpdatePiiGuard(invFm, fm, profile.piiPolicy, objType);');
    expect(at).toBeGreaterThan(0);
    expect(REC.slice(at, at + 200)).toContain('delete invProfile.piiPolicy;');
  });
  it('the audit after the write reads back up to 2,000 records an object and says of how many', () => {
    expect(BG).toContain('const ids = written.slice(0, 2000);');
    expect(BG).not.toContain('.filter(Boolean).slice(0, 200);\n          const textTypes');
    expect(BG.split('record(s)${ofAll} read back').length).toBe(3);
  });
});

describe('a scan under a policy that disguises what it matches by (live 2026-11-21)', () => {
  const pol = { 'Lead.Email': { strategy: 'pattern', pattern: 'email-person' }, 'Lead.LastName': { strategy: 'pattern', pattern: 'last-name' }, 'Contact.Phone': { strategy: 'hash' }, 'Lead.Old': null };
  it('names the disguised key fields and the disguised fields the filter names', () => {
    expect(blind(pol, 'Lead', ['Email'], "LastName LIKE 'SFTK PII%'")).toEqual({ keys: ['Email'], filter: ['LastName'] });
    expect(blind(pol, 'lead', ['Company'], "Company = 'Email LastName'")).toEqual({ keys: [], filter: [] });   // a quoted value is not a field
    expect(blind(pol, 'Lead', ['Name'], 'Account.LastName != null AND My_LastName__c = 1')).toEqual({ keys: [], filter: [] });
    expect(blind(pol, 'Case', ['Email'], 'Email != null')).toEqual({ keys: [], filter: [] });
    expect(blind(null, 'Lead', ['Email'], '')).toEqual({ keys: [], filter: [] });
  });
  it('says what happens and what to do; says nothing when nothing is hidden', () => {
    const line = blindLine('Lead', { keys: ['Email'], filter: ['LastName'] });
    expect(line).toContain('Email — the field Lead records are matched by');
    expect(line).toContain('LastName — named in the record filter');
    expect(line).toContain('listed under Insert again');
    expect(line).toContain('the filter may not find them');   // QA 2026-11-21: what may be, not a fact
    expect(line).toContain('Identity…');
    const keyOnly = blindLine('Lead', { keys: ['Email'], filter: [] });
    expect(keyOnly).toContain('Some records are left over in both orgs.'); expect(keyOnly).toContain('creates duplicates');
    expect(blindLine('Lead', { keys: [], filter: [] })).toBe('');
    expect(blindLine('Lead', { keys: [], filter: ['LastName'] })).not.toContain('Identity…');
  });
  it('a disguised match key is spoken of only when records are left over on both sides (a run is remembered — live 2026-11-21: 6 of 6 recognised)', () => {
    const b = { keys: ['Email'], filter: [] };
    expect(keysMatter(b, 3, 2)).toBe(true); expect(keysMatter(b, 0, 2)).toBe(false); expect(keysMatter(b, 3, 0)).toBe(false);
    expect(keysMatter({ keys: [], filter: ['LastName'] }, 3, 2)).toBe(false);
    const SC = read('studio-scan.js');
    expect(SC).toContain('_piiBlind = sftkScanPiiBlind(profile.piiPolicy, objType, srcKeyFields, where);');
    expect(SC.indexOf('sftkScanPiiBlindKeysMatter(_piiBlind, missingInTarget.length, onlyInTarget.length)')).toBeLessThan(SC.indexOf('...(memWarnings.length ? { warnings: memWarnings.slice(0, 10) } : {}),'));
  });
});

describe('QA regression run, 2026-11-21', () => {
  const { sftkRecPersonOnlyField: personOnly } = extractFunctions('studio-reconcile.js', ['sftkRecPersonOnlyField']);
  it('a person field of a BUSINESS account is never written empty', () => {
    const biz = { IsPersonAccount: false }, person = { IsPersonAccount: true };
    for (const f of ['FirstName', 'LastName', 'Salutation', 'PersonEmail', 'PersonMobilePhone', 'Hobby__pc']) { expect(personOnly('Account', biz, f), f).toBe(true); expect(personOnly('Account', person, f), f).toBe(false); }
    expect(personOnly('Account', biz, 'Phone')).toBe(false); expect(personOnly('Account', biz, 'Name')).toBe(false);
    expect(personOnly('Contact', biz, 'FirstName')).toBe(false);          // only Account has the two kinds
    expect(personOnly('Account', {}, 'FirstName')).toBe(false);           // an org without Person Accounts has no flag
  });
  it('the filter line waits for records under Insert; the policy cannot be opened under a live run', () => {
    const SC = read('studio-scan.js');
    expect(SC).toContain('_piiBlind.filter.length && missingInTarget.length) ? (memWarnings.push(sftkScanPiiBlindLine(objType, { keys: [], filter: _piiBlind.filter }))');
    expect(SC).not.toContain('const line = sftkScanPiiBlindLine(objType, { keys: [], filter: _piiBlind.filter });');
    expect(DEP).toContain("if (window._sftkRunActive) return showToast('A run is in progress — change what is disguised when it has finished.'");
  });
});
