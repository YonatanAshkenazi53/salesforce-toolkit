// QA 1.1 findings 52 and 57: a failed re-read after a flow switch-off keeps its undo; a delete nobody re-read says so.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunction } from './extract.mjs';

const POPUP = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const WRITE = readFileSync(new URL('../sftk-write.js', import.meta.url), 'utf8');
const slice = (src, name) => {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(src);
  if (!m) throw new Error(`${name} not found`);
  return src.slice(m.index, src.indexOf('\n}', m.index) + 2);
};

// deactivateFlow and deleteOneFlow as they are in popup.js, run against the real write discipline (sftk-write.js)
// and a scripted background. `answer(msg, n)` gives the background's reply to the n-th message of that kind.
function rig(answer) {
  const sent = [], notes = [], progress = [];
  const counts = {};
  const kind = m => (m.type === 'SF_QUERY' ? (/Status = 'Active'/.test(m.query) ? (/VersionNumber =/.test(m.query) ? 'readActiveVersion' : 'readActive') : 'readVersion')
    : m.type === 'SF_PATCH' ? (m.body.Metadata.activeVersionNumber === 0 ? 'switchOff' : 'switchOn') : 'delete');
  const sendBg = async m => { const k = kind(m); counts[k] = (counts[k] || 0) + 1; sent.push(k); return answer(k, counts[k], m); };
  const fns = new Function('sendBg', 'wait', 'updateProgressBar', 'sftkHistoryNote', 'orgUrl', 'sid',
    `${slice(WRITE, '_sftkWriteVerifiedCore')}\n${slice(WRITE, 'sftkWriteVerified')}\n${slice(POPUP, 'deactivateFlow')}\n${slice(POPUP, 'deleteOneFlow')}\nreturn { deactivateFlow, deleteOneFlow };`,
  )(sendBg, async () => {}, (d, t, s) => progress.push(s), (journal, out) => notes.push(out.text), 'https://x.my.salesforce.com', 'SID');
  const track = { deleted: new Set(), deactivated: new Map(), reactivated: new Set() };
  return { ...fns, sent, notes, track, counts };
}
const flow = { Id: '301A', DefinitionId: '300A', MasterLabel: 'Acct Sync', VersionNumber: 3, Status: 'Active' };
const DOWN = { error: 'Failed to fetch' };

describe('finding 52 — the switch-off is accepted, its re-read never answers', () => {
  it('the flow is tracked as switched off, so the undo can switch it back on', async () => {
    const r = rig(k => (k === 'switchOff' ? {} : DOWN));
    await r.deactivateFlow(flow, {}, r.track);
    expect(r.track.deactivated.get('301A')).toBe(flow);
    expect(r.counts.readActive).toBe(3);   // the read is tried three times before giving up
  });

  it('Activity says the org could not be re-read — not that it still shows an active version', async () => {
    const r = rig(k => (k === 'switchOff' ? {} : DOWN));
    await r.deactivateFlow(flow, {}, r.track);
    expect(r.notes[0]).toMatch(/could not be re-read/);
    expect(r.notes[0]).not.toMatch(/still shows/);
  });

  it('one failed read then an answer is an ordinary verified switch-off', async () => {
    const r = rig((k, n) => (k === 'switchOff' ? {} : n === 1 ? DOWN : { records: [] }));
    await r.deactivateFlow(flow, {}, r.track);
    expect(r.notes[0]).toMatch(/verified by re-reading the org/);
    expect(r.track.deactivated.has('301A')).toBe(true);
  });

  it('the run goes on to the delete; a refusal there switches the flow back on and says so', async () => {
    const r = rig(k => (k === 'switchOff' || k === 'switchOn' ? {} : k === 'readActive' ? DOWN
      : k === 'delete' ? { error: 'cannot delete this flow version because it is active' } : { records: [{ Id: '301A' }] }));
    await expect(r.deleteOneFlow(flow, 0, 1, {}, r.track)).rejects.toThrow(/because it is active It was switched OFF for the attempt and is switched back ON\./);
    expect(r.sent).toContain('switchOn');
    expect(r.track.reactivated.has('301A')).toBe(true);
    expect(r.track.deleted.has('301A')).toBe(false);
  });

  it('when the switch-back fails too, the flow is still on record as off — the undo step exists', async () => {
    const r = rig(k => (k === 'switchOff' ? {} : k === 'delete' ? { error: 'refused' } : DOWN));
    await expect(r.deleteOneFlow(flow, 0, 1, {}, r.track)).rejects.toThrow(/could NOT be switched back on/);
    const stillOff = [...r.track.deactivated.values()].filter(f => !r.track.deleted.has(f.Id) && !r.track.reactivated.has(f.Id));
    expect(stillOff).toEqual([flow]);
  });

  it('a re-read that ANSWERS "still active" stays a failure, and the accepted switch-off is on record', async () => {
    const r = rig(k => (k === 'switchOff' ? {} : { records: [{ Id: '301A' }] }));
    await expect(r.deactivateFlow(flow, {}, r.track)).rejects.toThrow(/still shows an active version/);
    expect(r.track.deactivated.has('301A')).toBe(true);
  });

  it('a refused switch-off is not tracked', async () => {
    const r = rig(() => ({ error: 'insufficient access' }));
    await expect(r.deactivateFlow(flow, {}, r.track)).rejects.toThrow(/insufficient access/);
    expect(r.track.deactivated.size).toBe(0);
  });
});

describe('finding 57 — the delete is accepted, its re-read never answers', () => {
  const draft = { ...flow, Id: '301B', VersionNumber: 2, Status: 'Draft' };

  it('the version counts as deleted and is named as not re-read', async () => {
    const r = rig(k => (k === 'delete' ? {} : DOWN));
    await r.deleteOneFlow(draft, 0, 1, {}, r.track);
    expect(r.track.deleted.has('301B')).toBe(true);
    expect(r.track.unverified).toEqual(['Acct Sync v2']);
  });

  it('Activity says the org could not be re-read — not that it still shows the old state', async () => {
    const r = rig(k => (k === 'delete' ? {} : DOWN));
    await r.deleteOneFlow(draft, 0, 1, {}, r.track);
    expect(r.notes[0]).toMatch(/could not be re-read/);
    expect(r.notes[0]).not.toMatch(/still shows/);
  });

  it('a verified delete names nothing as not re-read', async () => {
    const r = rig(k => (k === 'delete' ? {} : { records: [] }));
    await r.deleteOneFlow(draft, 0, 1, {}, r.track);
    expect(r.track.unverified).toBeUndefined();
    expect(r.notes[0]).toMatch(/verified by re-reading the org/);
  });

  it('a re-read that answers "still there" is a failure', async () => {
    const r = rig(k => (k === 'delete' ? {} : { records: [{ Id: '301B' }] }));
    await expect(r.deleteOneFlow(draft, 0, 1, {}, r.track)).rejects.toThrow(/still shows this flow version/);
    expect(r.track.deleted.size).toBe(0);
  });
});

describe('finding 57 — the result says which deletes were not re-read', () => {
  const line = extractFunction('popup.js', 'sftkFlowDeleteUnverifiedLine');

  it('nothing to say when every delete was re-read', () => {
    expect(line([])).toBe('');
    expect(line(undefined)).toBe('');
  });
  it('names the version and what to do', () => {
    expect(line(['Acct Sync v2'])).toBe('Salesforce accepted the delete of Acct Sync v2, but the org could not be re-read to confirm it. Refresh the list, or check Flow Builder, to see it is gone.');
  });
  it('names several, and counts the rest past eight', () => {
    expect(line(['A v1', 'B v2'])).toMatch(/of A v1, B v2, but the org could not be re-read to confirm them\./);
    expect(line(Array.from({ length: 11 }, (_, i) => `F v${i + 1}`))).toMatch(/F v8 and 3 more, but/);
  });

  it('performDeletion hands the list to the result; the toast and the failure dialog both print it, escaped', () => {
    const run = POPUP.slice(POPUP.indexOf('async function performDeletion('), POPUP.indexOf('function showProgressPanel('));
    expect(run).toContain('showResultToast(successes.length, errors, track.unverified || []);');
    const toast = POPUP.slice(POPUP.indexOf('function showResultToast('), POPUP.indexOf('function updateActionBar('));
    expect(toast).toContain('const notReread = sftkFlowDeleteUnverifiedLine(unverified);');
    expect(toast.match(/\$\{notReread \? `<(?:p|span)[^`]*\$\{escHtml\(notReread\)\}/g)).toHaveLength(2);
  });
});
