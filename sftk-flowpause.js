// ── Pause record-triggered flows during a deployment (user 2026-09-29) ─────
// "can we also offer to switch record triggered flows if needed? and auto
// switch them on when you are done" — "this or just deploy regularly with
// flows active". An OPTION on the Deploy page, off by default:
//   1. list the ACTIVE record-triggered flows on the objects the deployment
//      writes, in the TARGET org (installed-package flows cannot be switched —
//      named, left alone);
//   2. after the run's one confirmation, switch them OFF (FlowDefinition
//      activeVersionNumber 0), each re-read before it counts, and remember
//      them on this PC (`sftk_flow_run_paused`) BEFORE the run writes;
//   3. when the run ends — finished, failed or stopped — switch each back ON
//      at the exact version that was active, re-read, and forget it.
// If a flow cannot be confirmed off, the run does not start and the ones
// already off go back on. If the page closes mid-run, the memory stays and
// the Deploy page / Org health say which flows are still off.
//
// Records written while a flow is off are never processed by it later — the
// confirmation says so.
//
// Every write goes through sftkWriteVerified with a History journal; the
// confirmation is the run's own dialog (studio-reconcile.js runReconcile).

const SFTK_FLOWPAUSE_KEY = 'sftk_flow_run_paused';
const SFTK_RT_TRIGGERS = ['RecordAfterSave', 'RecordBeforeSave', 'RecordBeforeDelete'];

function _sftkFpLit(v) { return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`; }

// PURE. Which listed flows run on the objects this deployment writes.
// defs: FlowDefinitionView rows; objIds: Set of accepted TriggerObjectOrEventId
// values (API names, plus entity Ids of custom objects) → object API name via
// idToObj (Map). Returns { own: [{ apiName, label, defId, verId, object }], managed: [label] }.
function sftkFlowPauseSelect(defs, idToObj) {
  const own = [], managed = [];
  for (const d of (defs || [])) {
    if (!d || !d.ApiName || !['RecordAfterSave', 'RecordBeforeSave', 'RecordBeforeDelete'].includes(String(d.TriggerType || ''))) continue;   // = SFTK_RT_TRIGGERS (pure: no file constant)
    const obj = idToObj.get(String(d.TriggerObjectOrEventId || ''));
    if (!obj) continue;
    if (d.ManageableState === 'installed') { managed.push(`${d.Label || d.ApiName} (${obj})`); continue; }
    own.push({ apiName: d.ApiName, label: d.Label || d.ApiName, defId: d.DurableId, verId: d.ActiveVersionId, object: obj });
  }
  own.sort((a, b) => a.object.localeCompare(b.object) || a.label.localeCompare(b.label));
  return { own, managed };
}

// The active record-triggered flows on `objects` in the org of `sess`.
// Returns { flows: [{ apiName, label, defId, version, object }], managed: [label], calls } or throws.
async function sftkFlowPauseList(sess, objects, send) {
  const bg = typeof send === 'function' ? send : sendBg;
  const objs = [...new Set((objects || []).filter(Boolean))];
  if (!objs.length) return { flows: [], managed: [], calls: 0 };
  let calls = 0;
  const idToObj = new Map(objs.map(o => [o, o]));
  const custom = objs.filter(o => /__(c|mdt|e|x|b)$/i.test(o));
  if (custom.length) {
    calls++;
    const ent = await bg({ type: 'SF_QUERY', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true, _silentError: true,
      query: `SELECT QualifiedApiName, DurableId FROM EntityDefinition WHERE QualifiedApiName IN (${custom.map(_sftkFpLit).join(',')})` });
    if (!ent || ent.error) throw new Error(`the custom objects could not be looked up (${(ent && ent.error) || 'no answer'})`);
    for (const r of (ent.records || [])) if (r.DurableId) idToObj.set(r.DurableId, r.QualifiedApiName);
  }
  calls++;
  const defs = await bg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false, _silentError: true,
    query: `SELECT DurableId, ApiName, Label, TriggerType, TriggerObjectOrEventId, ActiveVersionId, ManageableState FROM FlowDefinitionView WHERE IsActive = true AND TriggerType IN (${SFTK_RT_TRIGGERS.map(_sftkFpLit).join(',')})` });
  if (!defs || defs.error) throw new Error(`the org's record-triggered flows could not be listed (${(defs && defs.error) || 'no answer'})`);
  const { own, managed } = sftkFlowPauseSelect(defs.records || [], idToObj);
  if (!own.length) return { flows: [], managed, calls };
  calls++;
  const vers = await bg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true, _silentError: true,
    query: `SELECT Id, VersionNumber FROM Flow WHERE Id IN (${own.map(f => _sftkFpLit(f.verId)).join(',')})` });
  if (!vers || vers.error) throw new Error(`the active versions could not be read (${(vers && vers.error) || 'no answer'})`);
  const vOf = new Map((vers.records || []).map(v => [v.Id, Number(v.VersionNumber) || 0]));
  const flows = own.map(f => ({ apiName: f.apiName, label: f.label, defId: f.defId, object: f.object, version: vOf.get(f.verId) || 0 }));
  const noVer = flows.filter(f => !f.version);
  if (noVer.length) throw new Error(`the active version of ${noVer.map(f => f.label).join(', ')} could not be read — nothing would bring it back`);
  return { flows, managed, calls };
}

async function _sftkFpMemory(mutate, orgKey) {
  let all = {};
  try { all = (await chrome.storage.local.get(SFTK_FLOWPAUSE_KEY))[SFTK_FLOWPAUSE_KEY] || {}; } catch (_) { all = {}; }
  if (typeof mutate === 'function') {
    all[orgKey] = mutate({ ...(all[orgKey] || {}) });
    if (!Object.keys(all[orgKey]).length) delete all[orgKey];
    try { await chrome.storage.local.set({ [SFTK_FLOWPAUSE_KEY]: all }); } catch (_) { /* the History entry still names them */ }
  }
  return all[orgKey] || {};
}

// What this PC remembers as paused by a run, still to be switched back on.
async function sftkFlowPausedLeftovers(orgUrl) {
  return _sftkFpMemory(null, sftkOrgKey(orgUrl));
}

// One switch pass: activeVersionNumber = version (0 = off) for each flow, then
// ONE FlowDefinitionView re-read. Returns { done: [flow], failed: [text] }.
async function _sftkFpSwitch(sess, flows, wantOn, journal, send) {
  const bg = typeof send === 'function' ? send : sendBg;
  // confirmed-by: runReconcile's confirmation (the ⏸ step is listed in it) or the Deploy page's ▶ Switch back on dialog
  const batch = await sftkWriteVerifiedAll(flows.map(f => ({
    describe: `${f.label} (${f.object})`,
    write: () => bg({ type: 'SF_PATCH', orgUrl: sess.orgUrl, sid: sess.sid, _silentError: true,
      path: `services/data/v62.0/tooling/sobjects/FlowDefinition/${f.defId}`,
      body: { Metadata: { activeVersionNumber: wantOn ? f.version : 0 } } }),
  })), {
    journal,
    verifyAll: async results => {
      const names = flows.filter((f, k) => results[k] && results[k].accepted).map(f => f.apiName);
      if (!names.length) return [];
      const q = await bg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false, _silentError: true,
        query: `SELECT ApiName, ActiveVersionId FROM FlowDefinitionView WHERE ApiName IN (${names.map(_sftkFpLit).join(',')})` });
      if (!q || q.error) throw new Error((q && q.error) || 'no answer');
      const on = new Map((q.records || []).map(r => [r.ApiName, !!r.ActiveVersionId]));
      return flows.map(f => {
        const isOn = on.get(f.apiName);
        return { ok: isOn === wantOn, text: isOn === wantOn
          ? `${f.label} (${f.object}): switched ${wantOn ? `back ON at v${f.version}` : 'OFF'} — verified by re-reading the org`
          : `${f.label} (${f.object}): accepted, but the org still reads it ${isOn === undefined ? 'unknown' : isOn ? 'ON' : 'OFF'}` };
      });
    },
  });
  return { done: flows.filter((f, k) => batch.results[k] && batch.results[k].ok), failed: batch.results.filter(r => !r.ok).map(r => r.text) };
}

// ⏸ Switch the flows off for a run. All must be confirmed off, or the ones that
// went off are switched back on at once and ok is false (the run must not start).
async function sftkFlowPauseOff(sess, flows, send) {
  const orgKey = sftkOrgKey(sess.orgUrl);
  const journal = sftkHistoryBegin({ tool: 'Deploy', title: `⏸ ${flows.length} record-triggered flow(s) paused for a deployment — ${orgLabel(sess.orgUrl)}`, orgUrl: sess.orgUrl });
  let r = { done: [], failed: [] };
  try {
    r = await _sftkFpSwitch(sess, flows, false, journal, send);
    // remembered BEFORE the run writes — a closed tab must not lose them
    if (r.done.length) await _sftkFpMemory(m => { for (const f of r.done) m[f.apiName] = { version: f.version, defId: f.defId, label: f.label, object: f.object, at: new Date().toISOString() }; return m; }, orgKey);
  } finally {
    await sftkHistoryEnd(journal, {
      undo: r.done.length ? { steps: r.done.map(f => ({
        describe: `${f.label} (${f.object}): switch back ON at v${f.version}`,
        // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
        msg: { type: 'SF_PATCH', path: `services/data/v62.0/tooling/sobjects/FlowDefinition/${f.defId}`, body: { Metadata: { activeVersionNumber: f.version } } },
        verify: { query: `SELECT ActiveVersionId FROM FlowDefinitionView WHERE ApiName = ${_sftkFpLit(f.apiName)}`, tooling: false, pick: 'records.0', field: 'ActiveVersionId', notNull: true,
          text: { ok: `${f.label}: back ON at v${f.version} — verified by re-reading the org`, bad: `${f.label}: accepted, but the org still reads it OFF` } },
      })), note: 'the run switches them back on by itself when it ends — use this only if that did not happen' } : { none: 'no flow was confirmed switched off' },
    });
  }
  if (r.failed.length) {
    const back = r.done.length ? await sftkFlowPauseOn(sess, r.done, send) : { done: [], failed: [] };
    return { ok: false, off: [], failed: r.failed, restored: back.done, restoreFailed: back.failed };
  }
  return { ok: true, off: r.done, failed: [] };
}

// ▶ Switch paused flows back on (the end of a run, or a leftover from a closed
// tab). A flow without defId/version (older memory) is looked up by name.
async function sftkFlowPauseOn(sess, flows, send) {
  const bg = typeof send === 'function' ? send : sendBg;
  const orgKey = sftkOrgKey(sess.orgUrl);
  const need = flows.filter(f => !f.defId);
  if (need.length) {
    const q = await bg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true, _silentError: true,
      query: `SELECT Id, DeveloperName FROM FlowDefinition WHERE DeveloperName IN (${need.map(f => _sftkFpLit(f.apiName)).join(',')})` });
    const idOf = new Map(((q && q.records) || []).map(r => [r.DeveloperName, r.Id]));
    for (const f of need) f.defId = idOf.get(f.apiName) || '';
  }
  const ready = flows.filter(f => f.defId && f.version);
  const lost = flows.filter(f => !(f.defId && f.version)).map(f => `${f.label || f.apiName}: not found in the org any more — nothing to switch on`);
  const journal = sftkHistoryBegin({ tool: 'Deploy', title: `▶ ${ready.length} record-triggered flow(s) switched back on — ${orgLabel(sess.orgUrl)}`, orgUrl: sess.orgUrl });
  let r = { done: [], failed: [] };
  try {
    r = ready.length ? await _sftkFpSwitch(sess, ready, true, journal, send) : r;
    if (r.done.length || lost.length) await _sftkFpMemory(m => { for (const f of r.done) delete m[f.apiName]; for (const f of flows) if (!(f.defId && f.version)) delete m[f.apiName]; return m; }, orgKey);
  } finally {
    await sftkHistoryEnd(journal, { undo: { none: 'switching them off again is what the deployment option does — run it again, or use ⏻ Flow switches' }, errors: lost });
  }
  return { done: r.done, failed: [...r.failed, ...lost] };
}

if (typeof window !== 'undefined') {
  window.sftkFlowPauseList = sftkFlowPauseList;
  window.sftkFlowPauseOff = sftkFlowPauseOff;
  window.sftkFlowPauseOn = sftkFlowPauseOn;
  window.sftkFlowPausedLeftovers = sftkFlowPausedLeftovers;
}
