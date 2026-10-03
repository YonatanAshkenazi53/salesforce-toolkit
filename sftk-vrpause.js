// ── Pause validation rules during a deployment (campaign 4 phase 4) ────────
// User 2026-10-01: "maybe we should add a switch for validation rules" /
// "ofc we have to turn on validation rules … after deployment is done, in any
// case". Salesforce has a header that bypasses duplicate rules; validation
// rules have none. The only way is the sftk-flowpause.js way: an OPTION on the
// Deploy page, off by default:
//   1. list the ACTIVE validation rules on the objects the deployment writes,
//      in the TARGET org (rules from installed packages cannot be changed —
//      named, left alone), with each rule's own Metadata (one read per rule);
//   2. after the run's one confirmation, switch them OFF (Tooling PATCH of the
//      rule's Metadata with active:false), each re-read before it counts, and
//      remember them on this PC (`sftk_vr_run_paused`) BEFORE the run writes;
//   3. when the run ends — finished, failed or stopped — switch each back ON,
//      re-read, and forget it.
// If a rule cannot be confirmed off, the run does not start and the ones
// already off go back on. If the page closes mid-run, the memory stays and
// the Deploy page says which rules are still off, with the button.
//
// While the rules are off they are off for EVERY user of that org, not only
// for the Toolkit — the confirmation says so. Records written meanwhile are
// not validated later.
//
// Verified live 2026-10-03 (trailheads4): PATCH tooling/sobjects/ValidationRule
// /<Id> { Metadata: { …its own metadata, active: false } } → Active false on
// re-read; the same with active: true brings it back.
//
// Every write goes through sftkWriteVerified with a History journal; the
// confirmation is the run's own dialog (studio-reconcile.js runReconcile).

const SFTK_VRPAUSE_KEY = 'sftk_vr_run_paused';

function _sftkVpLit(v) { return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`; }

// PURE. Which listed rules the Toolkit may switch: unmanaged ones; rules of an
// installed package are named and left alone.
// rows: Tooling ValidationRule rows { Id, ValidationName, NamespacePrefix,
// ManageableState, EntityDefinition: { QualifiedApiName } }.
// → { own: [{ id, name, object }], managed: [label] }
function sftkVrPauseSelect(rows) {
  const own = [], managed = [];
  for (const r of (rows || [])) {
    if (!r || !r.Id || !r.ValidationName) continue;
    const object = (r.EntityDefinition && r.EntityDefinition.QualifiedApiName) || '';
    if (!object) continue;
    if (r.NamespacePrefix || r.ManageableState === 'installed') { managed.push(`${r.ValidationName} (${object})`); continue; }
    own.push({ id: r.Id, name: r.ValidationName, object });
  }
  own.sort((a, b) => a.object.localeCompare(b.object) || a.name.localeCompare(b.name));
  return { own, managed };
}

// The active validation rules on `objects` in the org of `sess`, each with its
// Metadata (needed to switch it). → { rules: [{ id, name, object, metadata }],
// managed: [label], calls } or throws.
async function sftkVrPauseList(sess, objects, send) {
  const bg = typeof send === 'function' ? send : sendBg;
  const objs = [...new Set((objects || []).filter(Boolean))];
  if (!objs.length) return { rules: [], managed: [], calls: 0 };
  let calls = 1;
  const q = await bg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true, _silentError: true,
    query: `SELECT Id, ValidationName, NamespacePrefix, ManageableState, EntityDefinition.QualifiedApiName FROM ValidationRule WHERE Active = true AND EntityDefinition.QualifiedApiName IN (${objs.map(_sftkVpLit).join(',')})` });
  if (!q || q.error) throw new Error(`the org's validation rules could not be listed (${(q && q.error) || 'no answer'})`);
  const { own, managed } = sftkVrPauseSelect(q.records || []);
  const rules = [];
  for (const r of own) {
    calls++;
    const rec = await bg({ type: 'SF_TOOLING_GET', orgUrl: sess.orgUrl, sid: sess.sid, sobject: 'ValidationRule', id: r.id, _suppressError: true });
    if (!rec || rec.error || !rec.Metadata) throw new Error(`the definition of ${r.name} (${r.object}) could not be read (${(rec && rec.error) || 'no Metadata'}) — nothing would bring it back`);
    rules.push({ ...r, metadata: rec.Metadata });
  }
  return { rules, managed, calls };
}

async function _sftkVpMemory(mutate, orgKey) {
  let all = {};
  try { all = (await chrome.storage.local.get(SFTK_VRPAUSE_KEY))[SFTK_VRPAUSE_KEY] || {}; } catch (_) { all = {}; }
  if (typeof mutate === 'function') {
    all[orgKey] = mutate({ ...(all[orgKey] || {}) });
    if (!Object.keys(all[orgKey]).length) delete all[orgKey];
    try { await chrome.storage.local.set({ [SFTK_VRPAUSE_KEY]: all }); } catch (_) { /* the History entry still names them */ }
  }
  return all[orgKey] || {};
}

// What this PC remembers as paused by a run, still to be switched back on:
// { [ruleId]: { name, object, at } }.
async function sftkVrPausedLeftovers(orgUrl) {
  return _sftkVpMemory(null, sftkOrgKey(orgUrl));
}

function _sftkVpBody(rule, active) {
  const md = (typeof sftkMetaForPatch === 'function') ? sftkMetaForPatch(rule.metadata || {}) : { ...(rule.metadata || {}) };
  return { Metadata: { ...md, active: !!active } };
}

// One switch pass: active = wantOn for each rule, then ONE re-read of all of
// them. → { done: [rule], failed: [text] }.
async function _sftkVpSwitch(sess, rules, wantOn, journal, send) {
  const bg = typeof send === 'function' ? send : sendBg;
  // confirmed-by: runReconcile's confirmation (the ⏸ step is listed in it) or the Deploy page's ▶ Switch back on dialog
  const batch = await sftkWriteVerifiedAll(rules.map(r => ({
    describe: `${r.name} (${r.object})`,
    write: () => bg({ type: 'SF_PATCH', orgUrl: sess.orgUrl, sid: sess.sid, _silentError: true,
      path: `services/data/v62.0/tooling/sobjects/ValidationRule/${r.id}`,
      body: _sftkVpBody(r, wantOn) }),
  })), {
    journal,
    verifyAll: async results => {
      const ids = rules.filter((r, k) => results[k] && results[k].accepted).map(r => r.id);
      if (!ids.length) return [];
      const q = await bg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true, _silentError: true,
        query: `SELECT Id, Active FROM ValidationRule WHERE Id IN (${ids.map(_sftkVpLit).join(',')})` });
      if (!q || q.error) throw new Error((q && q.error) || 'no answer');
      const on = new Map((q.records || []).map(x => [String(x.Id).slice(0, 15), !!x.Active]));
      return rules.map(r => {
        const isOn = on.get(String(r.id).slice(0, 15));
        return { ok: isOn === wantOn, text: isOn === wantOn
          ? `${r.name} (${r.object}): switched ${wantOn ? 'back ON' : 'OFF'} — verified by re-reading the org`
          : `${r.name} (${r.object}): accepted, but the org still reads it ${isOn === undefined ? 'unknown' : isOn ? 'ON' : 'OFF'}` };
      });
    },
  });
  return { done: rules.filter((r, k) => batch.results[k] && batch.results[k].ok), failed: batch.results.filter(r => !r.ok).map(r => r.text) };
}

// ⏸ Switch the rules off for a run. All must be confirmed off, or the ones that
// went off are switched back on at once and ok is false (the run must not start).
async function sftkVrPauseOff(sess, rules, send) {
  const orgKey = sftkOrgKey(sess.orgUrl);
  const journal = sftkHistoryBegin({ tool: 'Deploy', title: `⏸ ${rules.length} validation rule(s) paused for a deployment — ${orgLabel(sess.orgUrl)}`, orgUrl: sess.orgUrl });
  let r = { done: [], failed: [] };
  try {
    r = await _sftkVpSwitch(sess, rules, false, journal, send);
    // remembered BEFORE the run writes — a closed tab must not lose them
    if (r.done.length) await _sftkVpMemory(m => { for (const x of r.done) m[x.id] = { name: x.name, object: x.object, at: new Date().toISOString() }; return m; }, orgKey);
  } finally {
    await sftkHistoryEnd(journal, {
      undo: r.done.length ? { steps: r.done.map(x => ({
        describe: `${x.name} (${x.object}): switch back ON`,
        // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
        msg: { type: 'SF_PATCH', path: `services/data/v62.0/tooling/sobjects/ValidationRule/${x.id}`, body: _sftkVpBody(x, true) },
        verify: { query: `SELECT Active FROM ValidationRule WHERE Id = ${_sftkVpLit(x.id)}`, tooling: true, pick: 'records.0', field: 'Active', equals: true,
          text: { ok: `${x.name}: back ON — verified by re-reading the org`, bad: `${x.name}: accepted, but the org still reads it OFF` } },
      })), note: 'the run switches them back on by itself when it ends — use this only if that did not happen' } : { none: 'no validation rule was confirmed switched off' },
    });
  }
  if (r.failed.length) {
    const back = r.done.length ? await sftkVrPauseOn(sess, r.done, send) : { done: [], failed: [] };
    return { ok: false, off: [], failed: r.failed, restored: back.done, restoreFailed: back.failed };
  }
  return { ok: true, off: r.done, failed: [] };
}

// ▶ Switch paused rules back on (the end of a run, or a leftover from a closed
// tab). A rule without its metadata (a leftover read from memory) is read first.
async function sftkVrPauseOn(sess, rules, send) {
  const bg = typeof send === 'function' ? send : sendBg;
  const orgKey = sftkOrgKey(sess.orgUrl);
  const lost = [];
  for (const r of rules) {
    if (r.metadata) continue;
    const rec = await bg({ type: 'SF_TOOLING_GET', orgUrl: sess.orgUrl, sid: sess.sid, sobject: 'ValidationRule', id: r.id, _suppressError: true });
    if (rec && !rec.error && rec.Metadata) r.metadata = rec.Metadata;
    else lost.push(`${r.name || r.id}: not found in the org any more — nothing to switch on`);
  }
  const ready = rules.filter(r => r.metadata);
  const journal = sftkHistoryBegin({ tool: 'Deploy', title: `▶ ${ready.length} validation rule(s) switched back on — ${orgLabel(sess.orgUrl)}`, orgUrl: sess.orgUrl });
  let r = { done: [], failed: [] };
  try {
    r = ready.length ? await _sftkVpSwitch(sess, ready, true, journal, send) : r;
    if (r.done.length || lost.length) await _sftkVpMemory(m => { for (const x of r.done) delete m[x.id]; for (const x of rules) if (!x.metadata) delete m[x.id]; return m; }, orgKey);
  } finally {
    await sftkHistoryEnd(journal, { undo: { none: 'switching them off again is what the deployment option does — run it again, or deactivate the rule in Setup' }, errors: lost });
  }
  return { done: r.done, failed: [...r.failed, ...lost] };
}

if (typeof window !== 'undefined') {
  window.sftkVrPauseList = sftkVrPauseList;
  window.sftkVrPauseOff = sftkVrPauseOff;
  window.sftkVrPauseOn = sftkVrPauseOn;
  window.sftkVrPausedLeftovers = sftkVrPausedLeftovers;
}
