// QA 1.1 regression run, finding 10: a validation rule whose switch-off got no clear answer (a timeout, a dropped
// connection, a 5xx) may be off — it is remembered, given an undo step, re-read, and switched back on.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const VP = extractFunctions('sftk-vrpause.js',
  ['_sftkVpLit', '_sftkVpReadPkg', 'sftkVrPausePkgInner', 'sftkVrPausePkgFiles', '_sftkVpWriteMsg', '_sftkVpMemory', '_sftkVpBody', 'sftkVrPauseMaybeOff', '_sftkVpSwitch', 'sftkVrPauseOff', 'sftkVrPauseOn'],
  { 'sftk-write.js': ['sftkWriteVerified', '_sftkWriteVerifiedCore', 'sftkWriteVerifiedAll'] });
const SRC = readFileSync(new URL('../sftk-vrpause.js', import.meta.url), 'utf8');

const ORG = 'https://t.my.salesforce.com', KEY = 't.my.salesforce.com';
const sess = { orgUrl: ORG, sid: 'S' };
const TIMEOUT = 'Request timed out after 30 s — URL: https://t.my.salesforce.com/services/data/v62.0/tooling/sobjects/ValidationRule/03dA';

describe('finding 10 — which refusals leave a rule possibly off (pure)', () => {
  const M = VP.sftkVrPauseMaybeOff;
  const own = { id: '03dA', name: 'A', object: 'Account' }, pkg = { id: '03dP', name: 'ns__P', object: 'Account', pkg: 'ns' };
  const refused = t => ({ ok: false, accepted: false, text: `A (Account): refused — ${t}` });
  it('a timeout, on the org’s own rule and on a packaged one → may be off', () => {
    expect(M([own], [refused(TIMEOUT)])).toEqual([own]);
    expect(M([pkg], [refused(TIMEOUT)])).toEqual([pkg]);
    expect(M([own], [refused('Retry timed out after 30 s — URL: https://t')])).toEqual([own]);
  });
  it('a dropped connection, a 5xx, no response from the background → may be off', () => {
    for (const t of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'net::ERR_CONNECTION_RESET', 'HTTP 503: Service Unavailable',
      'HTTP 500 (empty response) — URL: https://t', 'No response', 'The message port closed before a response was received.'])
      expect(M([own], [refused(t)]), t).toEqual([own]);
  });
  it('a definite refusal → nothing was switched, not remembered', () => {
    for (const t of ['HTTP 400: FIELD_INTEGRITY_EXCEPTION', 'HTTP 401: Session expired or invalid', 'HTTP 404: NOT_FOUND', 'the deploy was not accepted',
      'HTTP 400: the connection field is required'])
      expect(M([own, pkg], [refused(t), refused(t)]), t).toEqual([]);
  });
  it('nothing came back for the rule at all, or it is confirmed off → not "maybe"', () => {
    expect(M([own], [])).toEqual([]);
    expect(M([own], [{ ok: true, accepted: true, verified: true, detail: { isOn: false } }])).toEqual([]);
  });
});

describe('finding 10 — sftkVrPauseOff when a switch-off times out', () => {
  let store, org, history, queries, patches, applyLate;
  beforeEach(() => {
    store = {}; history = []; queries = []; patches = []; applyLate = true;
    org = new Map([['03dA', true], ['03dC', true]]);
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
  // the switch-off of 03dA gets no answer in time; Salesforce applies it anyway (applyLate) or not.
  // backOn: 'ok' the switch-back works · 'timeout' it gets no answer either
  const mk = backOn => async m => {
    const q = String(m.query || '');
    if (m.type === 'SF_PATCH') {
      const id = m.path.split('/').pop(), want = m.body.Metadata.active;
      patches.push(`${id}:${want}`);
      if (id === '03dA' && want === false) { if (applyLate) org.set(id, false); return { error: TIMEOUT }; }
      if (want === true && backOn === 'timeout') return { error: TIMEOUT };
      org.set(id, want); return {};
    }
    if (/SELECT Id, Active FROM ValidationRule WHERE Id IN/.test(q)) { queries.push(q); return { records: [...org].map(([Id, Active]) => ({ Id, Active })) }; }
    return { error: 'unexpected ' + m.type };
  };
  const rules = () => [{ id: '03dA', name: 'A_Rule', object: 'Account', metadata: { active: true } }, { id: '03dC', name: 'C_Rule', object: 'Contact', metadata: { active: true } }];

  it('the timed-out rule went off in the org: it is re-read, given an undo step, switched back ON and forgotten', async () => {
    const off = await VP.sftkVrPauseOff(sess, rules(), mk('ok'));
    expect(off.ok).toBe(false);                                        // the run does not start
    expect(queries[0]).toContain("'03dA'");                            // the first re-read asks about the timed-out rule too
    expect(off.failed.join('|')).toContain('timed out');
    expect(off.failed.join('|')).toContain('it may still have gone through, so it is treated as possibly OFF (the org reads it OFF now)');
    expect(history[0].undo.steps.map(s => s.describe)).toEqual(['C_Rule (Contact): switch back ON', 'A_Rule (Account): switch back ON']);
    expect(history[0].undo.note).toContain('Not confirmed off, but possibly off: A_Rule');
    expect(patches).toContain('03dA:true');                            // switched back on
    expect(off.restored.map(r => r.id).sort()).toEqual(['03dA', '03dC']);
    expect([org.get('03dA'), org.get('03dC')]).toEqual([true, true]);
    expect(store.sftk_vr_run_paused[KEY]).toBeUndefined();
  });
  it('the only rule times out: still remembered before anything else, then switched back', async () => {
    const off = await VP.sftkVrPauseOff(sess, rules().slice(0, 1), mk('ok'));
    expect(off.ok).toBe(false);
    expect(queries.length).toBe(2);                                    // one re-read after the switch-off, one after the switch-back
    expect(history[0].undo.steps.map(s => s.describe)).toEqual(['A_Rule (Account): switch back ON']);
    expect(org.get('03dA')).toBe(true);
    expect(store.sftk_vr_run_paused[KEY]).toBeUndefined();
  });
  it('the switch-back gets no answer either: the rule stays REMEMBERED for the Deploy page’s still-OFF card', async () => {
    const off = await VP.sftkVrPauseOff(sess, rules().slice(0, 1), mk('timeout'));
    expect(off.ok).toBe(false);
    expect(off.restored).toEqual([]);
    expect(off.restoreFailed.join('|')).toContain('timed out');
    expect(org.get('03dA')).toBe(false);                               // off for every user…
    expect(store.sftk_vr_run_paused[KEY]['03dA']).toMatchObject({ name: 'A_Rule', object: 'Account' });   // …and the page knows
  });
  it('Salesforce never applied it: the line says the org reads it ON, and the harmless switch-back leaves nothing remembered', async () => {
    applyLate = false;
    const off = await VP.sftkVrPauseOff(sess, rules().slice(0, 1), mk('ok'));
    expect(off.failed.join('|')).toContain('(the org reads it ON now)');
    expect(patches).toEqual(['03dA:false', '03dA:true']);
    expect(org.get('03dA')).toBe(true);
    expect(store.sftk_vr_run_paused[KEY]).toBeUndefined();
  });
  it('a definite refusal next to a confirmed switch-off: the refused rule gets no "possibly OFF" line and no undo step', async () => {
    const refuse = async m => (m.type === 'SF_PATCH' && m.path.endsWith('03dA') && m.body.Metadata.active === false ? { error: 'HTTP 400: FIELD_INTEGRITY_EXCEPTION' } : mk('ok')(m));
    const off = await VP.sftkVrPauseOff(sess, rules(), refuse);
    expect(off.ok).toBe(false);
    expect(off.failed.join('|')).not.toContain('possibly OFF');
    expect(queries[0]).not.toContain("'03dA'");
    expect(history[0].undo.steps.map(s => s.describe)).toEqual(['C_Rule (Contact): switch back ON']);
  });
  it('the re-read fails too: the line says so, the rule still gets its undo step and switch-back, and stays remembered', async () => {
    const noRead = async m => (m.type === 'SF_PATCH' ? mk('ok')(m) : { error: 'Failed to fetch' });
    const off = await VP.sftkVrPauseOff(sess, rules().slice(0, 1), noRead);
    expect(off.ok).toBe(false);
    expect(off.failed.join('|')).toContain('possibly OFF (the org could not be re-read for it)');
    expect(history[0].undo.steps.map(s => s.describe)).toEqual(['A_Rule (Account): switch back ON']);
    expect(patches).toEqual(['03dA:false', '03dA:true']);
    expect(off.restored).toEqual([]);                                  // the switch-back could not be confirmed either
    expect(store.sftk_vr_run_paused[KEY]['03dA']).toMatchObject({ name: 'A_Rule' });
  });
  it('a switch-back pass never calls a rule "possibly off"', async () => {
    org.set('03dA', false);
    const on = await VP.sftkVrPauseOn(sess, rules().slice(0, 1), mk('timeout'));
    expect(on.done).toEqual([]);
    expect(on.failed.join('|')).not.toContain('possibly OFF');
  });
});

describe('finding 10 — wiring', () => {
  it('the re-read covers the rules that may be off, and the result carries them as maybe', () => {
    expect(SRC).toContain('const unsure = wantOn ? [] : sftkVrPauseMaybeOff(rules, results);');
    expect(SRC).toContain('results[k] && (results[k].accepted || unsure.includes(r))');
    expect(SRC).toContain('const maybe = wantOn ? [] : sftkVrPauseMaybeOff(rules, batch.results);');
    expect(SRC).toContain('touched = [...r.done, ...(r.maybe || [])];');
  });
});
