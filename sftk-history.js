// ── History with undo for every write (campaign 3, phase 3) ──────────────
// Deploy has a verified rollback; Field Cleaner has restore points. Every
// OTHER change the toolkit makes (a picklist value deactivated, a flow's API
// version changed, a flow switched off, a permission copied, a licence
// toggled, a page assigned…) used to leave no History entry and no way
// back, though each is cheaply reversible. This module is the one way a
// tool's write reaches History, and the one way History undoes it.
//
// A tool's action is one JOURNAL:
//   const j = sftkHistoryBegin({ tool: 'Flow switches', title: '⏻ 3 flows OFF', orgUrl });
//   … every sftkWriteVerified({ …, journal: j }) appends its verdict to j.what …
//   await sftkHistoryEnd(j, { undo: { steps: [...] } | { none: 'why not' } });
// The entry lands in the same `sftk_history` list as deployments (kind:
// 'tool'), from either page. WHERE it is shown: a Toolkit tool's entries in
// that tool (sftk-toolhistory.js), everything else in Data Studio › History —
// see sftkHistoryToolTab below. test/history-discipline
// fails the build on a write that names no journal and on an End that
// states no undo.
//
// Undo is DATA, not code — the entry is stored, so a step is a message for
// the background plus a re-read that judges it:
//   { describe: 'Re-activate SFTK_FS_Test_Acc1 v3',
//     msg:      { type: 'SF_PATCH', path: '…/FlowDefinition/300…', body: { Metadata: { activeVersionNumber: 3 } } },
//     verify:   { query: "SELECT ActiveVersionId FROM FlowDefinitionView WHERE ApiName = 'SFTK_FS_Test_Acc1'",
//                 tooling: false, pick: 'records.0', field: 'ActiveVersionId', notNull: true },
//               — or, for state SOQL cannot read (an object's org-default page lives in its
//               describe): { path: 'services/data/v62.0/sobjects/Account/describe/', pick: …, … }.
//               `retries` (≤ 10, 2.5 s apart) re-reads until the state shows: a Metadata
//               deploy can take a few seconds to be reflected. Each extra read is logged.
//     orgUrl?:  '…' (defaults to the entry's target org) }
// The org's session is looked up when the undo runs (the user must be
// logged in to that org in a Salesforce tab); each step goes through
// sftkWriteVerified again, so "undone" is only ever said after a re-read.
// The undo is itself a History entry; an undo has no undo (redo it from
// the tool).
//
// Loaded by popup.html and studio.html after sftk-write.js. Page-agnostic:
// in Data Studio it uses the in-memory `_history` + storageSaveHistory
// (two-tier archive, counts-only mode); in the popup it reads and writes
// chrome.storage.local directly, with the same 100-entry hot cap.

const SFTK_HISTORY_CAP = 100;

function _sftkHistId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

// Key an org URL the way sftkOrgWriteGate does: host only, lightning → my.salesforce.
function _sftkHistOrgKey(u) {
  return String(u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.lightning\.force\.com$/, '.my.salesforce.com');
}

function sftkHistoryBegin(opts) {
  const o = opts || {};
  return {
    id: _sftkHistId('tool'),
    kind: 'tool',
    tool: String(o.tool || 'tool'),
    profileName: String(o.title || o.tool || 'change'),
    startedAt: new Date().toISOString(),
    completedAt: null,
    sourceOrg: String(o.sourceOrg || o.orgUrl || ''),
    targetOrg: String(o.orgUrl || ''),
    status: 'running',
    what: [],            // one line per write: { describe, ok, accepted, verified, text }
    summary: {},         // kept empty on purpose — the History page reads `what`
    errors: [],
    toolUndo: null,      // set by sftkHistoryEnd
  };
}

// Called by sftkWriteVerified when the spec names a journal.
function sftkHistoryNote(j, result, describe) {
  if (!j || !Array.isArray(j.what) || !result) return;
  j.what.push({
    describe: String(describe || 'the change'),
    ok: !!result.ok, accepted: !!result.accepted, verified: !!result.verified,
    text: String(result.text || ''),
  });
  if (!result.accepted && result.text) j.errors.push(String(result.text));
}

// Normalise what a tool says about undoing this entry.
//   { steps: [...], note? }  → undoable (steps must be non-empty)
//   { none: 'reason' }       → not undoable, and the entry says why
function _sftkHistNormalizeUndo(undo) {
  if (undo && Array.isArray(undo.steps) && undo.steps.length) {
    const steps = undo.steps.filter(s => s && typeof s === 'object' && s.msg && typeof s.msg.type === 'string')
      .map(s => ({ describe: String(s.describe || s.msg.type), msg: s.msg, verify: s.verify || null, orgUrl: s.orgUrl || '' }));
    if (steps.length) return { steps, note: undo.note ? String(undo.note) : '' };
    return { none: 'the undo steps were empty — a bug in the tool, please report it' };
  }
  if (undo && typeof undo.none === 'string' && undo.none.trim()) return { none: undo.none.trim() };
  if (undo && Array.isArray(undo.steps)) return { none: 'nothing was written, so there is nothing to undo' };
  return { none: 'this tool did not say whether the change can be undone — a bug, please report it' };
}

function _sftkHistStatus(j) {
  const w = j.what || [];
  if (!w.length) return 'failed';
  const ok = w.filter(x => x.ok).length;
  const accepted = w.filter(x => x.accepted).length;
  if (ok === w.length) return 'success';
  if (accepted === 0) return 'failed';
  return 'partial';
}

// Ends the journal and persists it. opts.undo is REQUIRED (see the normaliser;
// a missing undo is recorded as such, loudly). opts.status overrides the
// verdict derived from the writes; opts.errors adds lines. Steps for an
// action that wrote NOTHING successfully are dropped — there is nothing to
// undo, and the entry says so. opts.nothingToDo: the sentence for an action
// that looked and found nothing to write (a sync already in sync) — a
// success with that one line, never a "failed" (live 2026-09-28).
async function sftkHistoryEnd(j, opts) {
  if (!j || j.kind !== 'tool') return null;
  const o = opts || {};
  j.completedAt = new Date().toISOString();
  if (o.nothingToDo && !(j.what || []).length) {
    j.what.push({ describe: 'nothing to write', ok: true, accepted: true, verified: true, text: String(o.nothingToDo) });
    j.nothingToDo = true;
  }
  j.status = o.status || _sftkHistStatus(j);
  if (Array.isArray(o.errors)) j.errors.push(...o.errors.map(String));
  if (o.undoOf) j.undoOf = String(o.undoOf);
  let undo = _sftkHistNormalizeUndo(o.undo);
  if (j.nothingToDo) undo = { none: 'nothing was written' };
  else if (!('none' in undo) && !(j.what || []).some(x => x.accepted)) undo = { none: 'nothing was accepted by Salesforce, so there is nothing to undo' };
  if (o.undo === undefined) { try { console.warn('[SFTK] sftkHistoryEnd without an undo statement:', j.tool, j.profileName); } catch (_) {} }
  j.toolUndo = undo;
  await sftkHistoryAppend(j);
  return j;
}

function _sftkHistStudio() {
  return typeof _history !== 'undefined' && Array.isArray(_history) && typeof storageSaveHistory === 'function';
}

async function sftkHistoryAppend(entry) {
  if (!entry || !entry.id) return;
  if (_sftkHistStudio()) {
    const i = _history.findIndex(h => h && h.id === entry.id);
    if (i >= 0) _history[i] = entry; else _history.push(entry);
    await storageSaveHistory();
    return;
  }
  // Popup: read → append → cap → write. The overflow goes to the on-PC
  // archive when that module is loaded (popup.html loads sftk-archive.js).
  let list = [];
  try { list = (await chrome.storage.local.get('sftk_history')).sftk_history || []; } catch (_) { list = []; }
  const at = list.findIndex(h => h && h.id === entry.id);
  if (at >= 0) list[at] = entry; else list.push(entry);   // a re-append keeps its place
  const split = (typeof sftkHistorySplit === 'function') ? sftkHistorySplit(list, SFTK_HISTORY_CAP) : { keep: list.slice(-SFTK_HISTORY_CAP), overflow: [] };
  if (split.overflow.length && typeof sftkArchPut === 'function') { try { await sftkArchPut(split.overflow); } catch (_) {} }
  await chrome.storage.local.set({ sftk_history: split.keep });
}

async function sftkHistoryAll() {
  if (_sftkHistStudio()) return _history;
  try { return (await chrome.storage.local.get('sftk_history')).sftk_history || []; } catch (_) { return []; }
}

// What the History card offers for a tool entry.
function sftkToolUndoState(entry) {
  const u = entry && entry.kind === 'tool' ? entry.toolUndo : null;
  if (!entry || entry.kind !== 'tool') return { show: false };
  if (!u) return { show: true, disabled: true, label: '↩ no undo', title: 'This entry has no undo statement (the action was cut short before it ended).' };
  if (u.done) {
    return { show: true, disabled: true, label: u.done.ok ? '↩ Undone' : '↩ Undo attempted',
      title: u.done.ok ? `Undone and verified on ${u.done.at}. The undo has its own entry in History.` : `An undo was run on ${u.done.at} but not every step was confirmed — see the undo's own entry in History.` };
  }
  if (u.none) return { show: true, disabled: true, label: '↩ no undo', title: `Cannot be undone from here — ${u.none}` };
  const n = (u.steps || []).length;
  return { show: true, disabled: false, label: `↩ Undo (${n} step${n === 1 ? '' : 's'})`,
    title: `Writes the previous state back${u.note ? ` — ${u.note}` : ''}. Each step is re-read to confirm it; the undo is recorded in History.` };
}

// ── The verify spec, evaluated against a query's answer (pure) ──────────
//   pick:    dotted path into the answer (default 'records'); numbers index arrays
//   where:   { field, equals } — pick the array element whose field matches;
//            or a LIST of them, all of which must match (text compared without case)
//   then one of: absent (nothing there) · count (array length) ·
//                field + equals / notNull / notFalse (a value on the picked object)
//   text:    { ok, bad } — the sentences for both outcomes (optional)
function _sftkHistPick(obj, path) {
  let v = obj;
  for (const part of String(path || '').split('.').filter(Boolean)) {
    if (v == null) return undefined;
    v = v[part];
  }
  return v;
}
function sftkUndoVerifyEval(spec, answer) {
  const s = spec || {};
  const t = s.text || {};
  if (!answer || answer.error) return { ok: false, text: `could not re-read the org${answer && answer.error ? ` (${answer.error})` : ''} — treat this as unverified` };
  let v = _sftkHistPick(answer, s.pick || 'records');
  const conds = Array.isArray(s.where) ? s.where.filter(w => w && w.field) : (s.where && s.where.field ? [s.where] : []);
  if (conds.length) {
    const same = (a, b) => (typeof a === 'string' && typeof b === 'string' && conds.length > 1) ? a.toLowerCase() === b.toLowerCase() : a === b;
    v = (Array.isArray(v) ? v : []).find(x => x && conds.every(w => same(x[w.field], w.equals)));
  }
  let ok;
  if (s.absent) ok = v === undefined || v === null || (Array.isArray(v) && v.length === 0);
  else if (typeof s.count === 'number') ok = Array.isArray(v) && v.length === s.count;
  else if (s.field) {
    const fv = v == null ? undefined : v[s.field];
    ok = s.notNull ? (fv !== null && fv !== undefined) : s.notFalse ? fv !== false : ('equals' in s ? fv === s.equals : fv !== undefined);
  } else ok = v !== undefined && v !== null;
  return { ok, text: ok ? (t.ok || '') : (t.bad || 'accepted by Salesforce, but the org still shows the old state') };
}

// The live session for an org, from the background (both pages).
async function sftkHistorySessionFor(orgUrl, send) {
  const want = _sftkHistOrgKey(orgUrl);
  let sessions = [];
  try { sessions = ((await send({ type: 'GET_ALL_SF_SESSIONS' })) || {}).sessions || []; } catch (_) { sessions = []; }
  return sessions.find(s => s && s.sid && _sftkHistOrgKey(s.orgUrl) === want) || null;
}

function _sftkHistSend(msg) {
  return new Promise(r => {
    try { chrome.runtime.sendMessage(msg, res => r(res || { error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'No response' })); }
    catch (e) { r({ error: (e && e.message) || String(e) }); }
  });
}

// Undo one tool entry: confirm (the shared dialog, word UNDO, the typed org
// name when the target is treated as production), then run the steps
// through the write discipline, record the undo as its own entry, mark the
// original. opts: { send?, onLog?, confirm? (false = skip the dialog, for
// callers that asked already) }. Returns { ok, text, entry, undoEntry }.
async function sftkHistoryUndo(entryId, opts) {
  const o = opts || {};
  const send = typeof o.send === 'function' ? o.send : _sftkHistSend;
  const log = typeof o.onLog === 'function' ? o.onLog : () => {};
  const all = await sftkHistoryAll();
  const entry = all.find(h => h && h.id === entryId && h.kind === 'tool');
  if (!entry) return { ok: false, text: 'This entry is no longer in History.' };
  const st = sftkToolUndoState(entry);
  if (st.disabled) return { ok: false, text: st.title || 'This entry cannot be undone.' };
  const steps = entry.toolUndo.steps;
  const orgUrl = entry.targetOrg;
  const sess = await sftkHistorySessionFor(orgUrl, send);
  if (!sess) return { ok: false, text: `Log in to ${_sftkHistOrgKey(orgUrl).replace(/\.my\.salesforce\.com$/, '') || 'the org'} in a Salesforce tab first — the undo writes there.` };
  if (o.confirm !== false) {
    if (typeof sftkConfirmDestructive !== 'function') return { ok: false, text: 'The confirmation dialog is not loaded on this page.' };
    const gate = (typeof sftkOrgWriteGate === 'function') ? await sftkOrgWriteGate(orgUrl) : { production: true, label: sess.label || '' };
    const sure = await sftkConfirmDestructive({
      title: `↩ Undo — ${entry.profileName}`,
      icon: '↩',
      items: steps.map(s => ({ label: s.describe })),   // objects: the dialog reads .sub on a string (String.prototype.sub!)
      revOverride: {
        html: `Writes the previous state back in <strong>${(sess.label || _sftkHistOrgKey(orgUrl)).replace(/</g, '&lt;')}</strong>, step by step; each step is re-read to confirm it and the whole undo is recorded in History. An undo has no undo — to redo the change, use the tool again.${entry.toolUndo.note ? `<br>${String(entry.toolUndo.note).replace(/</g, '&lt;')}` : ''}`,
        needsCheckbox: true,
        ack: 'I understand this writes the earlier state back over whatever is there now',
      },
      confirmLabel: '↩ Undo',
      typedWord: 'UNDO',
      production: gate.production ? { label: gate.label } : null,
    });
    if (!sure) return { ok: false, text: 'Undo cancelled — nothing was written.', cancelled: true };
  }
  const j = sftkHistoryBegin({ tool: entry.tool, title: `↩ Undo — ${entry.profileName}`, orgUrl });
  for (const step of steps) {
    const stepOrg = step.orgUrl && _sftkHistOrgKey(step.orgUrl) !== _sftkHistOrgKey(orgUrl) ? await sftkHistorySessionFor(step.orgUrl, send) : sess;
    if (!stepOrg) { sftkHistoryNote(j, { ok: false, accepted: false, verified: false, text: `${step.describe}: not logged in to ${step.orgUrl}` }, step.describe); log(`❌ ${step.describe}: not logged in to ${step.orgUrl}`); continue; }
    const r = await sftkWriteVerified({
      describe: step.describe,
      write: () => send({ ...step.msg, orgUrl: stepOrg.orgUrl, sid: stepOrg.sid, _suppressError: true, _silentError: true }),
      verify: step.verify && (step.verify.query || step.verify.path) ? async () => {
        const vs = step.verify;
        const read = () => (vs.path
          ? send({ type: 'SF_REST_GET', orgUrl: stepOrg.orgUrl, sid: stepOrg.sid, path: `${vs.path}${String(vs.path).includes('?') ? '&' : '?'}_=${Date.now()}`, _suppressError: true, _silentError: true })
          : send({ type: 'SF_QUERY', tooling: !!vs.tooling, orgUrl: stepOrg.orgUrl, sid: stepOrg.sid, query: vs.query, _suppressError: true, _silentError: true }));
        const tries = Math.max(1, Math.min(10, Number(vs.retries) || 1));
        let verdict = null;
        for (let n = 1; n <= tries; n++) {
          verdict = sftkUndoVerifyEval(vs, await read());
          if (verdict.ok || n === tries) break;
          log(`… ${step.describe}: not shown by the org yet — re-reading (${n + 1} of ${tries})`);
          await new Promise(r => setTimeout(r, 2500));
        }
        return verdict;
      } : undefined,
      noVerify: step.verify && (step.verify.query || step.verify.path) ? undefined : 'this step has no re-read',
      journal: j,
    });
    log(`${r.ok ? '✅' : r.accepted ? '⚠' : '❌'} ${r.text}`);
  }
  // confirmed-by: the ↩ Undo sftkConfirmDestructive above (or the caller, with confirm: false)
  const undoEntry = await sftkHistoryEnd(j, { undo: { none: 'this entry is itself an undo — redo the change from the tool' }, undoOf: entry.id });
  const okAll = j.what.length > 0 && j.what.every(x => x.ok);
  entry.toolUndo.done = { at: j.completedAt, ok: okAll, entryId: j.id };
  await sftkHistoryAppend(entry);
  const okN = j.what.filter(x => x.ok).length;
  return { ok: okAll, text: okAll ? `Undone — ${okN} step${okN === 1 ? '' : 's'} verified by re-reading the org` : `Undo ran: ${okN} of ${j.what.length} step${j.what.length === 1 ? '' : 's'} verified — see the undo's entry in History`, entry, undoEntry };
}

// ── Whose history an entry belongs to (user 2026-10-05: "seeing field cleaner
// history on the data deployment history is confusing, it should show under
// the field cleaner") ─────────────────────────────────────────────────────
// A change made by a TOOLKIT tool is listed in that tool (sftk-toolhistory.js);
// Data Studio › History keeps deployments, rollbacks and Data Studio's own
// changes. The entry itself is unchanged — one list, one undo.
// Tool name (as passed to sftkHistoryBegin) → the Toolkit tab that shows it.
const SFTK_TOOLKIT_TOOLS = {
  'Field Cleaner': 'fields', 'Lightning Pages': 'pages', 'Apex Debugger': 'debugger', 'License Manager': 'licenses',
  'Copy Permissions': 'copy-perms', 'Flow switches': 'dependencies', 'API versions': 'dependencies',
  'Flow delete': 'flows', 'Flow Access': 'flow-access',
};
const SFTK_TOOLKIT_TAB_LABELS = {
  flows: 'Flows', dependencies: 'Dependencies', debugger: 'Debugger', pages: 'Lightning Pages', fields: 'Field Cleaner',
  'copy-perms': 'Copy Permissions', licenses: 'Licenses', 'flow-access': 'Flow Access',
};
// The Toolkit tab an entry is shown in, or '' (a deployment, a rollback, a Data Studio change). PURE.
function sftkHistoryToolTab(entry) {
  if (!entry || entry.kind !== 'tool') return '';
  return Object.prototype.hasOwnProperty.call(SFTK_TOOLKIT_TOOLS, entry.tool) ? SFTK_TOOLKIT_TOOLS[entry.tool] : '';
}
function sftkHistoryTabLabel(tab) {
  return Object.prototype.hasOwnProperty.call(SFTK_TOOLKIT_TAB_LABELS, String(tab)) ? SFTK_TOOLKIT_TAB_LABELS[String(tab)] : '';
}
// One tool's entries, newest first. PURE.
function sftkHistoryForTab(all, tab) {
  return (Array.isArray(all) ? all : []).filter(e => sftkHistoryToolTab(e) === String(tab))
    .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
}
// Data Studio's side of the split: its own entries, and how many live in which Toolkit tab. PURE.
function sftkHistoryStudioSplit(all) {
  const mine = [], kit = {};
  for (const e of (Array.isArray(all) ? all : [])) {
    const tab = sftkHistoryToolTab(e);
    if (tab) kit[tab] = (kit[tab] || 0) + 1; else if (e) mine.push(e);
  }
  return { mine, kit, kitTotal: Object.values(kit).reduce((n, v) => n + v, 0) };
}
// "5m ago" for a card. PURE.
function sftkHistoryAgo(iso, nowMs) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Number(nowMs) - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
// The ⬇ Report of one tool change: what was written, where, when, and what the org showed. PURE.
function sftkHistoryReport(entry) {
  const e = entry || {};
  const st = sftkToolUndoState(e);
  return {
    product: 'Admin Toolkit for Salesforce', kind: 'tool-change', tool: e.tool || '', title: e.profileName || '',
    org: e.targetOrg || '', startedAt: e.startedAt || null, completedAt: e.completedAt || null, status: e.status || '',
    writes: (Array.isArray(e.what) ? e.what : []).map(w => ({ what: w.text || w.describe || '', verified: !!w.ok, accepted: !!w.accepted })),
    errors: Array.isArray(e.errors) ? e.errors : [],
    undo: e.toolUndo ? (e.toolUndo.done ? { state: e.toolUndo.done.ok ? 'undone and verified' : 'undo attempted', at: e.toolUndo.done.at }
      : e.toolUndo.none ? { state: 'no undo', why: e.toolUndo.none } : { state: 'available', steps: (e.toolUndo.steps || []).map(s => s.describe) }) : { state: st.label || 'none' },
    ...(e.undoOf ? { undoOf: e.undoOf } : {}),
  };
}
function sftkHistoryReportName(entry) {
  const e = entry || {};
  const slug = String(e.tool || 'change').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'change';
  const d = new Date(e.startedAt || Date.now());
  const iso = Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  return `sftk-change-${slug}-${iso.slice(0, 10)}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkHistoryBegin      = sftkHistoryBegin;
  globalThis.SFTK_TOOLKIT_TOOLS     = SFTK_TOOLKIT_TOOLS;
  globalThis.sftkHistoryToolTab     = sftkHistoryToolTab;
  globalThis.sftkHistoryTabLabel    = sftkHistoryTabLabel;
  globalThis.sftkHistoryForTab      = sftkHistoryForTab;
  globalThis.sftkHistoryStudioSplit = sftkHistoryStudioSplit;
  globalThis.sftkHistoryAgo         = sftkHistoryAgo;
  globalThis.sftkHistoryReport      = sftkHistoryReport;
  globalThis.sftkHistoryReportName  = sftkHistoryReportName;
  globalThis.sftkHistoryNote       = sftkHistoryNote;
  globalThis.sftkHistoryEnd        = sftkHistoryEnd;
  globalThis.sftkHistoryAppend     = sftkHistoryAppend;
  globalThis.sftkHistoryAll        = sftkHistoryAll;
  globalThis.sftkToolUndoState     = sftkToolUndoState;
  globalThis.sftkUndoVerifyEval    = sftkUndoVerifyEval;
  globalThis.sftkHistorySessionFor = sftkHistorySessionFor;
  globalThis.sftkHistoryUndo       = sftkHistoryUndo;
}
