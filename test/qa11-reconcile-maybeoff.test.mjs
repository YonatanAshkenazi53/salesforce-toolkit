// QA 1.1 findings 62 and 63: a validation rule that MAY be off after a failed switch-off is remembered and switched back on.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractFunctions } from './extract.mjs';

const VP = extractFunctions('sftk-vrpause.js',
  ['_sftkVpLit', '_sftkVpReadPkg', 'sftkVrPausePkgInner', 'sftkVrPausePkgFiles', '_sftkVpWriteMsg', '_sftkVpMemory', '_sftkVpBody', 'sftkVrPauseMaybeOff', '_sftkVpSwitch', 'sftkVrPauseOff', 'sftkVrPauseOn'],
  { 'sftk-write.js': ['sftkWriteVerified', '_sftkWriteVerifiedCore', 'sftkWriteVerifiedAll'] });

const ORG = 'https://t.my.salesforce.com', KEY = 't.my.salesforce.com';
const sess = { orgUrl: ORG, sid: 'S' };
const FULL = 'Account.ns__Pkg_Rule';
const STILL = 'Deployment 0Af000 was submitted but its result could not be read (Salesforce had not finished it after 100 seconds). It MAY STILL FINISH — look at Setup → Deployment Status.';

describe('which rules may be off after a switch-off pass (pure)', () => {
  const M = VP.sftkVrPauseMaybeOff;
  const own = { id: '03dA', name: 'A', object: 'Account' }, pkg = { id: '03dP', name: 'ns__P', object: 'Account', pkg: 'ns' };
  it('accepted, and the re-read failed → may be off', () => {
    expect(M([own], [{ ok: false, accepted: true, verified: false, text: 'accepted by Salesforce, but the org could not be re-read' }])).toEqual([own]);
  });
  it('accepted, and the re-read did not contain the rule → may be off', () => {
    expect(M([own], [{ ok: false, accepted: true, verified: true, detail: { isOn: undefined } }])).toEqual([own]);
  });
  it('accepted, and the re-read shows it ON → it is not off', () => {
    expect(M([own], [{ ok: false, accepted: true, verified: true, detail: { isOn: true } }])).toEqual([]);
  });
  it('confirmed off → that is "done", not "maybe"', () => {
    expect(M([own], [{ ok: true, accepted: true, verified: true, detail: { isOn: false } }])).toEqual([]);
  });
  it('a packaged rule whose deploy was submitted but not followed to its end → may be off', () => {
    expect(M([pkg], [{ ok: false, accepted: false, text: `ns__P (Account): refused — ${STILL}` }])).toEqual([pkg]);
  });
  it('a plain refusal — nothing was submitted — is not remembered', () => {
    expect(M([pkg, own], [{ ok: false, accepted: false, text: 'ns__P (Account): refused — the deploy was not accepted' }, { ok: false, accepted: false, text: 'A (Account): refused — HTTP 400' }])).toEqual([]);
    expect(M([own], [{ ok: false, accepted: false, text: `A (Account): refused — ${STILL}` }])).toEqual([]);   // only a deploy is queued
  });
});

describe('sftkVrPauseOff', () => {
  let store, org, history, mode, deploys;
  beforeEach(() => {
    store = {}; history = []; mode = ''; deploys = [];
    org = new Map([['03dA', true], ['03dC', true], ['03dP', true]]);
    globalThis.sftkOrgKey = u => String(u).replace(/^https?:\/\//, '');
    globalThis.SFTK_VRPAUSE_KEY = 'sftk_vr_run_paused';
    globalThis.orgLabel = () => 't';
    globalThis.sftkMetaForPatch = md => ({ ...md });
    globalThis.sftkBuildStoredZip = files => files.map(f => new TextDecoder().decode(f.data)).join('|');
    globalThis.sftkHistoryBegin = () => ({});
    globalThis.sftkHistoryEnd = async (j, end) => { history.push(end); };
    globalThis.sftkHistoryNote = () => {};
    globalThis.chrome = { storage: { local: { get: async k => ({ [k]: store[k] }), set: async v => { Object.assign(store, JSON.parse(JSON.stringify(v))); } } } };
  });
  afterEach(() => { for (const k of ['SFTK_VRPAUSE_KEY', 'sftkOrgKey', 'orgLabel', 'sftkMetaForPatch', 'sftkBuildStoredZip', 'sftkHistoryBegin', 'sftkHistoryEnd', 'sftkHistoryNote', 'chrome']) delete globalThis[k]; });
  // mode 'noread': every re-read fails · 'noread-once': only the first · 'slow': the first deploy outlives the poll and lands later
  let reads = 0;
  const send = async m => {
    const q = String(m.query || '');
    if (m.type === 'SF_PATCH') { org.set(m.path.split('/').pop(), m.body.Metadata.active); return {}; }
    if (m.type === 'SF_METADATA_DEPLOY') {
      const want = /<active>true<\/active>/.test(m.zipBase64);
      deploys.push(want);
      if (mode === 'slow' && deploys.length === 1) return { error: STILL };   // queued: Salesforce switches it off later
      org.set('03dP', want); return { success: true };
    }
    if (/SELECT Id, Active FROM ValidationRule WHERE Id IN/.test(q)) {
      reads++;
      if (mode === 'noread' || (mode === 'noread-once' && reads === 1)) return { error: 'HTTP 503' };
      return { records: [...org].map(([Id, Active]) => ({ Id, Active })) };
    }
    return { error: 'unexpected ' + m.type };
  };
  const own = () => [{ id: '03dA', name: 'A_Rule', object: 'Account', metadata: { active: true } }, { id: '03dC', name: 'C_Rule', object: 'Contact', metadata: { active: true } }];
  const pkg = () => ({ id: '03dP', name: 'ns__Pkg_Rule', object: 'Account', pkg: 'ns', fullName: FULL, xml: `<fullName>${FULL}</fullName><active>true</active>` });

  it('62: every switch-off accepted, the org cannot be re-read at all → the run does not start, the rules stay REMEMBERED with undo steps', async () => {
    reads = 0; mode = 'noread';
    const off = await VP.sftkVrPauseOff(sess, own(), send);
    expect(off.ok).toBe(false);
    expect(off.off).toEqual([]);
    expect([...org.values()]).toEqual([true, true, true]);          // the switch-back was written…
    expect(off.restored).toEqual([]);                                // …but could not be confirmed either
    expect(Object.keys(store.sftk_vr_run_paused[KEY])).toEqual(['03dA', '03dC']);   // the Deploy page's "still OFF" card reads this
    expect(store.sftk_vr_run_paused[KEY]['03dA']).toMatchObject({ name: 'A_Rule', object: 'Account' });
    expect(history[0].undo.steps.map(s => s.describe)).toEqual(['A_Rule (Account): switch back ON', 'C_Rule (Contact): switch back ON']);
    expect(history[0].undo.note).toContain('Not confirmed off, but possibly off: A_Rule, C_Rule');
  });
  it('62: the re-read fails once, then the org answers → the rules are switched back ON and forgotten', async () => {
    reads = 0; mode = 'noread-once';
    const off = await VP.sftkVrPauseOff(sess, own(), send);
    expect(off.ok).toBe(false);
    expect(off.restored.map(r => r.id)).toEqual(['03dA', '03dC']);
    expect(off.restoreFailed).toEqual([]);
    expect([org.get('03dA'), org.get('03dC')]).toEqual([true, true]);
    expect(store.sftk_vr_run_paused[KEY]).toBeUndefined();
  });
  it('63: a packaged rule whose deploy outlives the poll → remembered, given an undo step, and switched back on behind the queued deploy', async () => {
    reads = 0; mode = 'slow';
    const off = await VP.sftkVrPauseOff(sess, [...own(), pkg()], send);
    expect(off.ok).toBe(false);
    expect(off.failed.join('|')).toContain('MAY STILL FINISH');
    expect(history[0].undo.steps.map(s => s.describe)).toContain('ns__Pkg_Rule (Account): switch back ON');
    expect(deploys).toEqual([false, true]);                          // off (queued), then back on
    expect(off.restored.map(r => r.id).sort()).toEqual(['03dA', '03dC', '03dP']);
    expect([...org.values()]).toEqual([true, true, true]);
    expect(store.sftk_vr_run_paused[KEY]).toBeUndefined();
  });
  it('63: …and when the switch-back cannot be followed either, the packaged rule stays remembered with its package and full name', async () => {
    reads = 0; mode = 'slow';
    const stuck = async m => (m.type === 'SF_METADATA_DEPLOY' ? { error: STILL } : send(m));
    const off = await VP.sftkVrPauseOff(sess, [pkg()], stuck);
    expect(off.ok).toBe(false);
    expect(off.restored).toEqual([]);
    expect(store.sftk_vr_run_paused[KEY]['03dP']).toMatchObject({ name: 'ns__Pkg_Rule', object: 'Account', pkg: 'ns', fullName: FULL });
  });
  it('a rule Salesforce plainly refused, with nothing else switched: nothing is remembered and History says so', async () => {
    reads = 0;
    const refuse = async m => (m.type === 'SF_PATCH' ? { error: 'HTTP 400 FIELD_INTEGRITY_EXCEPTION' } : send(m));
    const off = await VP.sftkVrPauseOff(sess, own().slice(0, 1), refuse);
    expect(off.ok).toBe(false);
    expect(store.sftk_vr_run_paused).toBeUndefined();
    expect(history[0].undo).toEqual({ none: 'no validation rule was switched off' });
  });
});
