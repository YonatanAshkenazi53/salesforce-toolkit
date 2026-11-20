// QA 1.1 findings 7 and 43: a run reads the ticked rules and flows again just before it switches them — a rule
// edited since an earlier run is not written back from a cached definition, and a rule or flow switched off (or
// re-versioned) since the page read its list is not switched ON (or back to the old version) when the run ends.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunction, extractFunctions } from './extract.mjs';

const DEP = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
const { sftkDepRulesStillOn: rulesOn, sftkDepRuleReadsOff: readsOff, sftkDepFlowsStillOn: flowsOn } =
  extractFunctions('studio-deploy.js', ['sftkDepRulesStillOn', 'sftkDepRuleReadsOff', 'sftkDepFlowsStillOn']);
const hydrate = extractFunction('sftk-vrpause.js', 'sftkVrPauseHydrate');
const sess = { orgUrl: 'https://t.my.salesforce.com', sid: 'x' };

describe('finding 7 — every run reads the definition it writes back', () => {
  it('a rule that carries a definition from an earlier run is handed on without it, and the cached rule is not touched', () => {
    const cached = { id: '03d000000000001AAA', name: 'R', object: 'Account', metadata: { active: true, errorMessage: 'old' } };
    const { go, gone } = rulesOn([cached], [{ id: '03d000000000001AAA', name: 'R', object: 'Account' }]);
    expect(gone).toEqual([]);
    expect(go).toEqual([{ id: '03d000000000001AAA', name: 'R', object: 'Account' }]);
    expect(go[0]).not.toBe(cached);
    expect(cached.metadata.errorMessage).toBe('old');
  });
  it('a packaged rule loses its cached xml the same way', () => {
    const { go } = rulesOn([{ id: 'a', name: 'ns__R', object: 'O__c', pkg: 'ns', fullName: 'O__c.ns__R', xml: '<active>true</active>' }], [{ id: 'a' }]);
    expect(go[0].xml).toBeUndefined();
    expect(go[0].fullName).toBe('O__c.ns__R');
  });
  it('two runs in one page session: the second run reads the rule again and gets the edit made in between', async () => {
    const list = [{ id: '03d000000000001AAA', name: 'R', object: 'Account' }];   // the page's cached list
    let inOrg = { active: true, errorMessage: 'old' };
    let reads = 0;
    const send = async m => { if (m.type === 'SF_TOOLING_GET') { reads++; return { Metadata: { ...inOrg } }; } return {}; };
    const run1 = await hydrate(sess, rulesOn(list, list).go, send);
    expect(run1[0].metadata.errorMessage).toBe('old');
    inOrg = { active: true, errorMessage: 'fixed in Setup' };
    const run2 = await hydrate(sess, rulesOn(list, list).go, send);
    expect(reads).toBe(2);
    expect(run2[0].metadata.errorMessage).toBe('fixed in Setup');
    expect(list[0].metadata).toBeUndefined();
  });
  it('the run switches the freshly read copies, never the cached list', () => {
    const fn = DEP.slice(DEP.indexOf('async function _depReconcile('), DEP.indexOf('\n}\n', DEP.indexOf('async function _depReconcile(')));
    expect(fn).toContain('const still = sftkDepRulesStillOn(vp.rules, fresh.rules);');
    expect(fn).toContain('const read = await sftkVrPauseHydrate(sess, still.go);');
    expect(fn).toContain('pausedR = await sftkVrPauseOff(sess, rules);');
    expect(fn).not.toContain('sftkVrPauseHydrate(sess, vp.rules)');
    expect(fn).not.toContain('sftkVrPauseOff(sess, vp.rules)');
  });
});

describe('finding 43 — what was switched off since the page opened stays off', () => {
  it('a rule that is no longer in the fresh list of active rules is dropped (15- and 18-character ids are the same rule)', () => {
    const a = { id: '03d000000000001AAA', name: 'A', object: 'Account' }, b = { id: '03d000000000002AAA', name: 'B', object: 'Account' };
    const { go, gone } = rulesOn([a, b], [{ id: '03d000000000002' }]);
    expect(go.map(r => r.name)).toEqual(['B']);
    expect(gone).toEqual([a]);
  });
  it('nothing fresh, nothing switched', () => {
    expect(rulesOn([{ id: 'a', name: 'A', object: 'O' }], []).go).toEqual([]);
    expect(rulesOn([{ id: 'a', name: 'A', object: 'O' }], null).gone).toHaveLength(1);
    expect(rulesOn(null, null)).toEqual({ go: [], gone: [] });
  });
  it('a definition that reads active:false means the rule went off between the list and the read', () => {
    expect(readsOff({ metadata: { active: false } })).toBe(true);
    expect(readsOff({ metadata: { active: true } })).toBe(false);
    expect(readsOff({ xml: '<fullName>O.ns__R</fullName><active>false</active>' })).toBe(true);
    expect(readsOff({ xml: '<fullName>O.ns__R</fullName><active>true</active>' })).toBe(false);
    expect(readsOff({})).toBe(false);
  });
  it('a flow deactivated since is dropped; a flow re-versioned since goes back on at the version active now', () => {
    const picked = [
      { apiName: 'Gone', label: 'Gone flow', object: 'Account', version: 2, defId: '300A' },
      { apiName: 'Moved', label: 'Moved flow', object: 'Account', version: 3, defId: '300B' },
      { apiName: 'Same', label: 'Same flow', object: 'Contact', version: 1, defId: '300C' },
    ];
    const fresh = [{ apiName: 'Moved', version: 4, defId: '300B' }, { apiName: 'Same', version: 1, defId: '300C' }, { apiName: 'Other', version: 9, defId: '300D' }];
    const r = flowsOn(picked, fresh);
    expect(r.gone).toEqual([picked[0]]);
    expect(r.go.map(f => [f.apiName, f.version])).toEqual([['Moved', 4], ['Same', 1]]);
    expect(r.moved).toEqual([{ label: 'Moved flow', from: 3, to: 4 }]);
    expect(picked[1].version).toBe(3);   // copies: the caller decides what the page shows
    expect(r.go[1].label).toBe('Same flow');
  });
  it('a flow whose active version cannot be told is not switched', () => {
    expect(flowsOn([{ apiName: 'F', version: 2 }], [{ apiName: 'F', version: 0 }]).go).toEqual([]);
    expect(flowsOn([{ apiName: 'F', version: 2 }], undefined).gone).toHaveLength(1);
  });
  it('both hooks read the org again before the switch, say what they left alone, and stop the run when the read fails', () => {
    const i = DEP.indexOf('async function _depReconcile('), j = DEP.indexOf('async function _depRun(');
    const rec = DEP.slice(i, DEP.indexOf('\n}\n', i)), run = DEP.slice(j, DEP.indexOf('\n}\n', j));
    expect(rec.indexOf('await sftkVrPauseList(sess,')).toBeGreaterThan(-1);
    expect(rec.indexOf('await sftkVrPauseList(sess,')).toBeLessThan(rec.indexOf('pausedR = await sftkVrPauseOff('));
    expect(rec).toContain('rules = read.filter(r => !sftkDepRuleReadsOff(r));');
    expect(rec).toContain('They are left as they are; the run does not switch them back on.');
    expect(rec).toContain('No validation rule was switched off and nothing was written.');
    expect(run.indexOf('await sftkFlowPauseList(sess,')).toBeGreaterThan(-1);
    expect(run.indexOf('await sftkFlowPauseList(sess,')).toBeLessThan(run.indexOf('paused = await sftkFlowPauseOff('));
    expect(run).toContain('paused = await sftkFlowPauseOff(sess, still.go);');
    expect(run).not.toContain('sftkFlowPauseOff(sess, fp.flows)');
    expect(run).toContain('No flow was switched off and nothing was written.');
    expect(run).toContain('Each goes back on at the version that is active now.');
  });
});
