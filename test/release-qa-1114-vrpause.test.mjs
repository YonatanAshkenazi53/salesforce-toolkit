// Release QA 2026-11-14: switching a paused validation rule back on must not FORGET it when the rule
// cannot be read. Only a definite 404 / NOT_FOUND is "gone"; a 401, 5xx, network failure or no answer
// leaves the rule remembered (still OFF), the way sftk-flowpause.js was fixed on 2026-11-11.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractFunctions } from './extract.mjs';

const VP = extractFunctions('sftk-vrpause.js',
  ['_sftkVpLit', '_sftkVpMemory', '_sftkVpBody', '_sftkVpSwitch', 'sftkVrPauseOn'],
  { 'sftk-write.js': ['sftkWriteVerified', '_sftkWriteVerifiedCore', 'sftkWriteVerifiedAll'] });

const ORG = 'https://t.my.salesforce.com', KEY = 't.my.salesforce.com';
const sess = { orgUrl: ORG, sid: 'S' };
const MD = { active: false, errorConditionFormula: 'ISBLANK(Email)', errorMessage: 'needs an email' };

describe('vrpause: a failed read keeps the leftover remembered', () => {
  let store, org, getAnswer, errors;
  beforeEach(() => {
    org = new Map([['03dAAA', false], ['03dBBB', false]]);
    store = { sftk_vr_run_paused: { [KEY]: { '03dAAA': { name: 'Must_Have_Email', object: 'Contact' }, '03dBBB': { name: 'Must_Have_Phone', object: 'Contact' } } } };
    errors = [];
    globalThis.SFTK_VRPAUSE_KEY = 'sftk_vr_run_paused';
    globalThis.sftkOrgKey = u => String(u).replace(/^https?:\/\//, '');
    globalThis.orgLabel = () => 't';
    globalThis.sftkMetaForPatch = md => Object.fromEntries(Object.entries(md).filter(([, v]) => v !== null));
    globalThis.sftkHistoryBegin = () => ({ kind: 'tool', what: [], errors: [] });
    globalThis.sftkHistoryEnd = async (j, o) => { errors.push(...((o && o.errors) || [])); };
    globalThis.sftkHistoryNote = () => {};
    globalThis.chrome = { storage: { local: { get: async k => ({ [k]: store[k] }), set: async v => { Object.assign(store, JSON.parse(JSON.stringify(v))); } } } };
  });
  afterEach(() => { for (const k of ['SFTK_VRPAUSE_KEY', 'sftkOrgKey', 'orgLabel', 'sftkMetaForPatch', 'sftkHistoryBegin', 'sftkHistoryEnd', 'sftkHistoryNote', 'chrome']) delete globalThis[k]; });
  const send = async m => {
    const q = String(m.query || '');
    if (m.type === 'SF_TOOLING_GET') return getAnswer(m.id);
    if (m.type === 'SF_PATCH') { org.set(m.path.split('/').pop(), m.body.Metadata.active); return {}; }
    if (/SELECT Id, Active FROM ValidationRule WHERE Id IN/.test(q)) return { records: [...org].map(([Id, Active]) => ({ Id, Active })) };
    return { error: 'unexpected ' + m.type };
  };
  const leftovers = () => [{ id: '03dAAA', name: 'Must_Have_Email', object: 'Contact' }, { id: '03dBBB', name: 'Must_Have_Phone', object: 'Contact' }];

  for (const [label, ans] of [['an expired session (401)', { error: 'HTTP 401: Session expired or invalid' }],
    ['a server error (503)', { error: 'HTTP 503: Service Unavailable' }],
    ['a network failure', { error: 'Failed to fetch' }],
    ['no answer', undefined],
    ['an answer without metadata', { Id: '03dAAA' }]]) {
    it(`${label}: reported as still OFF, never as gone, and kept in the memory`, async () => {
      getAnswer = () => ans;
      const on = await VP.sftkVrPauseOn(sess, leftovers(), send);
      expect(on.done).toEqual([]);
      expect(on.failed).toHaveLength(2);
      for (const f of on.failed) { expect(f).toMatch(/still OFF and still remembered/); expect(f).not.toMatch(/not found in the org any more/); }
      expect(Object.keys(store.sftk_vr_run_paused[KEY]).sort()).toEqual(['03dAAA', '03dBBB']);
      expect(errors).toEqual(on.failed);
    });
  }

  it('mixed: one read fails, one rule is truly gone (404) — only the gone one is forgotten; a readable one goes back on', async () => {
    store.sftk_vr_run_paused[KEY]['03dCCC'] = { name: 'Readable', object: 'Contact' };
    org.set('03dCCC', false);
    getAnswer = id => id === '03dAAA' ? { error: 'HTTP 401: Session expired or invalid' }
      : id === '03dBBB' ? { error: 'HTTP 404: The requested resource does not exist' } : { Id: id, Metadata: MD };
    const on = await VP.sftkVrPauseOn(sess, [...leftovers(), { id: '03dCCC', name: 'Readable', object: 'Contact' }], send);
    expect(on.done.map(r => r.id)).toEqual(['03dCCC']);
    expect(org.get('03dCCC')).toBe(true);
    expect(on.failed).toEqual(expect.arrayContaining([
      'Must_Have_Phone: not found in the org any more — nothing to switch on',
      expect.stringMatching(/^Must_Have_Email: still OFF and still remembered — it could not be read \(HTTP 401/)]));
    expect(Object.keys(store.sftk_vr_run_paused[KEY])).toEqual(['03dAAA']);
  });
});
