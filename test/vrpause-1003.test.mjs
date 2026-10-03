// ⏸ Pause validation rules during a deployment (campaign 4 phase 4).
// User 2026-10-01: "maybe we should add a switch for validation rules" /
// "ofc we have to turn on validation rules … after deployment is done, in any
// case". The flow-pause contract, for ValidationRule: an option, off by
// default; off after the run's ONE confirmation, back on when it ends.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction, extractFunctions } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(root, f), 'utf8');
const select = extractFunction('sftk-vrpause.js', 'sftkVrPauseSelect');
const VP = extractFunctions('sftk-vrpause.js',
  ['_sftkVpLit', 'sftkVrPauseSelect', 'sftkVrPauseList', '_sftkVpMemory', 'sftkVrPausedLeftovers', '_sftkVpBody', '_sftkVpSwitch', 'sftkVrPauseOff', 'sftkVrPauseOn'],
  { 'sftk-write.js': ['sftkWriteVerified', '_sftkWriteVerifiedCore', 'sftkWriteVerifiedAll'] });

const ORG = 'https://t.my.salesforce.com';
const ROWS = [
  { Id: '03dA', ValidationName: 'Retail_Needs_Website', NamespacePrefix: null, ManageableState: 'unmanaged', EntityDefinition: { QualifiedApiName: 'Account' } },
  { Id: '03dC', ValidationName: 'Lab_Lead_Needs_Phone', NamespacePrefix: null, ManageableState: 'unmanaged', EntityDefinition: { QualifiedApiName: 'Contact' } },
  { Id: '03dP', ValidationName: 'Pkg_Rule', NamespacePrefix: 'pkg', ManageableState: 'installed', EntityDefinition: { QualifiedApiName: 'Account' } },
];
const MD = { '03dA': { active: true, errorConditionFormula: 'ISBLANK(Website)', errorMessage: 'needs a website', description: null },
             '03dC': { active: true, errorConditionFormula: 'ISBLANK(Phone)', errorMessage: 'needs a phone', description: 'd' } };

describe('which rules are paused', () => {
  it('unmanaged active rules on the deployment\'s objects; installed-package rules named, left alone', () => {
    const r = select(ROWS);
    expect(r.own).toEqual([{ id: '03dA', name: 'Retail_Needs_Website', object: 'Account' }, { id: '03dC', name: 'Lab_Lead_Needs_Phone', object: 'Contact' }]);
    expect(r.managed).toEqual(['Pkg_Rule (Account)']);
  });
});

describe('list → off → on, through the write discipline', () => {
  let store, org, calls, failOff;
  beforeEach(() => {
    store = {}; calls = []; failOff = null;
    org = new Map([['03dA', true], ['03dC', true]]);   // rule id → active?
    globalThis.SFTK_VRPAUSE_KEY = 'sftk_vr_run_paused';
    globalThis.sftkOrgKey = u => String(u).replace(/^https?:\/\//, '');
    globalThis.orgLabel = () => 't';
    globalThis.sftkMetaForPatch = md => Object.fromEntries(Object.entries(md).filter(([, v]) => v !== null));
    globalThis.sftkHistoryBegin = () => ({ kind: 'tool', what: [], errors: [] });
    globalThis.sftkHistoryEnd = async () => {};
    globalThis.sftkHistoryNote = () => {};
    globalThis.chrome = { storage: { local: { get: async k => ({ [k]: store[k] }), set: async v => { Object.assign(store, JSON.parse(JSON.stringify(v))); } } } };
  });
  afterEach(() => { for (const k of ['SFTK_VRPAUSE_KEY', 'sftkOrgKey', 'orgLabel', 'sftkMetaForPatch', 'sftkHistoryBegin', 'sftkHistoryEnd', 'sftkHistoryNote', 'chrome']) delete globalThis[k]; });
  const send = async m => {
    calls.push(m);
    const q = String(m.query || '');
    if (/FROM ValidationRule WHERE Active = true AND EntityDefinition/.test(q)) return { records: ROWS };
    if (m.type === 'SF_TOOLING_GET') return MD[m.id] ? { Id: m.id, Metadata: MD[m.id] } : { error: 'NOT_FOUND' };
    if (m.type === 'SF_PATCH') {
      const id = m.path.split('/').pop();
      const want = m.body.Metadata.active;
      if (want === false && failOff === id) return {};            // accepted, but the org keeps it on
      org.set(id, want); return {};
    }
    if (/SELECT Id, Active FROM ValidationRule WHERE Id IN/.test(q)) return { records: [...org].map(([Id, Active]) => ({ Id, Active })) };
    return { error: 'unexpected ' + m.type + ' ' + q };
  };
  const sess = { orgUrl: ORG, sid: 'S' };

  it('lists the rules with their own Metadata (one read per rule, the count said)', async () => {
    const l = await VP.sftkVrPauseList(sess, ['Account', 'Contact'], send);
    expect(l.rules.map(r => [r.id, r.name, r.object, r.metadata.errorMessage])).toEqual([['03dA', 'Retail_Needs_Website', 'Account', 'needs a website'], ['03dC', 'Lab_Lead_Needs_Phone', 'Contact', 'needs a phone']]);
    expect(l.managed).toEqual(['Pkg_Rule (Account)']);
    expect(l.calls).toBe(3);
  });
  it('off: the rule\'s OWN metadata with active:false, nulls stripped; remembered BEFORE the run writes; on: back, forgotten', async () => {
    const { rules } = await VP.sftkVrPauseList(sess, ['Account', 'Contact'], send);
    const off = await VP.sftkVrPauseOff(sess, rules, send);
    expect(off.ok).toBe(true);
    expect([...org.values()]).toEqual([false, false]);
    const firstPatch = calls.find(c => c.type === 'SF_PATCH');
    expect(firstPatch.path).toBe('services/data/v62.0/tooling/sobjects/ValidationRule/03dA');
    expect(firstPatch.body).toEqual({ Metadata: { active: false, errorConditionFormula: 'ISBLANK(Website)', errorMessage: 'needs a website' } });   // description:null stripped
    expect(Object.keys(store.sftk_vr_run_paused['t.my.salesforce.com'])).toEqual(['03dA', '03dC']);
    expect(store.sftk_vr_run_paused['t.my.salesforce.com']['03dA']).toMatchObject({ name: 'Retail_Needs_Website', object: 'Account' });
    const on = await VP.sftkVrPauseOn(sess, off.off, send);
    expect(on.failed).toEqual([]);
    expect([...org.values()]).toEqual([true, true]);
    expect(calls.filter(c => c.type === 'SF_PATCH').slice(-2).map(c => c.body.Metadata.active)).toEqual([true, true]);
    expect(store.sftk_vr_run_paused['t.my.salesforce.com']).toBeUndefined();
  });
  it('a rule that will not go off: the run must not start, and the ones already off go straight back on', async () => {
    failOff = '03dC';
    const { rules } = await VP.sftkVrPauseList(sess, ['Account', 'Contact'], send);
    const off = await VP.sftkVrPauseOff(sess, rules, send);
    expect(off.ok).toBe(false);
    expect(off.failed[0]).toMatch(/Lab_Lead_Needs_Phone \(Contact\): accepted, but the org still reads it ON/);
    expect(off.restored.map(r => r.id)).toEqual(['03dA']);
    expect([...org.values()]).toEqual([true, true]);
    expect(store.sftk_vr_run_paused['t.my.salesforce.com']).toBeUndefined();
  });
  it('a leftover from a closed tab (id and name only) is read again before it is switched on; a rule that is gone is said and forgotten', async () => {
    store.sftk_vr_run_paused = { 't.my.salesforce.com': { '03dA': { name: 'Retail_Needs_Website', object: 'Account' }, '03dZ': { name: 'Gone_Rule', object: 'Account' } } };
    org.set('03dA', false);
    const on = await VP.sftkVrPauseOn(sess, [{ id: '03dA', name: 'Retail_Needs_Website', object: 'Account' }, { id: '03dZ', name: 'Gone_Rule', object: 'Account' }], send);
    expect(org.get('03dA')).toBe(true);
    expect(on.done.map(r => r.id)).toEqual(['03dA']);
    expect(on.failed).toEqual(['Gone_Rule: not found in the org any more — nothing to switch on']);
    expect(store.sftk_vr_run_paused['t.my.salesforce.com']).toBeUndefined();
  });
});

describe('wired into the Deploy page and the run', () => {
  const DV = read('studio-deploy.js'), RC = read('studio-reconcile.js');
  it('an option, OFF by default, next to the flow option', () => {
    expect(DV).toContain("let _depRulePause = { on: false, key: '', list: null, error: '' };");
    expect(DV).toContain('<input type="checkbox" id="dsDepRulePause" ${_depRulePause.on ? \'checked\' : \'\'}> ⏸ pause validation rules</label>');
    expect(DV).toContain('if (!vp || !vp.rules.length) return runReconcile(p, objType, buckets, opts);');
    expect(DV).toContain('While they are off they are off for EVERY user of that org');
  });
  it('the rules are in the run\'s ONE confirmation, which says they are off for every user', () => {
    expect(RC).toContain('const _vp = opts && opts.rulePause && (opts.rulePause.rules || []).length ? opts.rulePause : null;');
    expect(RC).toContain('switch OFF ${_vp.rules.length} validation rule(s) in');
    expect(RC).toContain('While they are off they are off for <strong>every user</strong> of that org');
    expect(RC).toContain('${ruleBlock}');
    expect(RC).toContain("if ((_fp || _vp) && opts && typeof opts.beforeWrites === 'function') {");
    expect(RC).toContain("if ((_fp || _vp) && opts && typeof opts.afterWrites === 'function') {");
  });
  it('rules go off AFTER the flows and come back on BEFORE them; a rule that will not go off puts the flows back too; a finally is the safety net', () => {
    const i = DV.indexOf('async function _depReconcile(');
    const fn = DV.slice(i, DV.indexOf('\n}\n', i));
    expect(fn.indexOf('const ok = await opts.beforeWrites(sess, log); if (!ok) return false;')).toBeLessThan(fn.indexOf('pausedR = await sftkVrPauseOff(sess, vp.rules);'));
    expect(fn).toContain("if (opts && typeof opts.afterWrites === 'function') { try { await opts.afterWrites(log); } catch (_) { /* its own finally tries again */ } }");
    expect(fn.indexOf('const r = await resumeR();')).toBeLessThan(fn.indexOf("if (opts && typeof opts.afterWrites === 'function') await opts.afterWrites(log);"));
    expect(fn).toMatch(/\} finally \{\s+\/\/ the safety net: a run that failed or stopped before its last write\s+if \(pausedR && pausedR\.ok && pausedR\.off\.length\) \{\s+const r = await resumeR\(\);/);
  });
  it('leftovers get a banner with the one button; the module loads before the Deploy page; the memory key is in PRIVACY.md', () => {
    expect(DV).toContain('<div id="dsDepRuleLeft"></div>');
    expect(DV).toContain('id="dsDepRuleLeftOn">▶ Switch them back on</button>');
    const html = read('studio.html');
    expect(html.indexOf('src="sftk-vrpause.js"')).toBeGreaterThan(0);
    expect(html.indexOf('src="sftk-vrpause.js"')).toBeLessThan(html.indexOf('src="studio-deploy.js"'));
    expect(read('PRIVACY.md')).toContain('`sftk_vr_run_paused`');
  });
});

describe('only the objects in use (user 2026-10-03: "only for the used objects")', () => {
  const written = extractFunction('studio-deploy.js', 'sftkDeployWrittenObjects');
  const objects = [{ obj: 'Account', pathKey: '', depth: 0 }, { obj: 'Contact', pathKey: '0', depth: 1 }, { obj: 'Opportunity', pathKey: '1', depth: 1 }, { obj: 'OpportunityLineItem', pathKey: '1.0', depth: 2 }];
  const S = (...ids) => new Set(ids);
  it('root inserts only → the root object only', () => {
    expect([...written(objects, { push: S('a'), overwrite: S() }, {})]).toEqual(['Account']);
  });
  it('a selected grandchild brings its ancestors (it rides with its missing parents), not its siblings', () => {
    expect([...written(objects, { push: S() }, { '1.0': { push: S('li') }, '0': { push: S() } })].sort()).toEqual(['Account', 'Opportunity', 'OpportunityLineItem']);
  });
  it('nothing selected → nothing is paused', () => {
    expect([...written(objects, { push: S() }, { '0': { push: S(), del: S() } })]).toEqual([]);
  });
  it('the run narrows rules AND flows to those objects, and the confirmation names the rules that stay on', () => {
    const DV = read('studio-deploy.js'), RC = read('studio-reconcile.js');
    expect(DV).toContain('rules: vpAll.rules.filter(r => written.has(r.object))');
    expect(DV).toContain('flows: fpAll.flows.filter(f => writtenF.has(f.object))');
    expect(RC).toContain('Rules on objects this run does not write stay ON:');
    expect(DV).toContain('the run switches off ONLY the ones on objects it writes');
  });
});
