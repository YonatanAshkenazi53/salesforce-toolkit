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

// The day and the time a FILE is named with: the user's own clock, not UTC (QA 2026-11-11: an export made after
// midnight local was named with yesterday's date). PURE given the Date.
function sftkLocalDay(d) {
  const t = (d && typeof d.getFullYear === 'function') ? d : new Date();
  const p = n => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}
function sftkLocalStamp(d) {
  const t = (d && typeof d.getFullYear === 'function') ? d : new Date();
  const p = n => String(n).padStart(2, '0');
  return `${sftkLocalDay(t)}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`;
}
// What a tool's change is about. A tool registers ONE function that names its current subject (Field Cleaner: the
// picked field), so every entry it begins carries it without each call site saying so; an explicit opts.subject wins.
const _sftkHistSubjects = {};
function sftkHistorySubjectFor(tool, fn) { if (tool && typeof fn === 'function') _sftkHistSubjects[String(tool)] = fn; }
// …and which ROW of the tool's list the change was made from (Field Cleaner: the component's id), so the row's own
// ↩ Undo takes back exactly that change (owner 2026-11-16: "After deletion, we will show an undo button near the
// deleted/removed metadata items"). Same registry idea: one function per tool, '' when no row is being worked on.
const _sftkHistRows = {};
function sftkHistoryRowFor(tool, fn) { if (tool && typeof fn === 'function') _sftkHistRows[String(tool)] = fn; }
function _sftkHistRow(o) {
  if (o.row) return String(o.row);
  const fn = _sftkHistRows[String(o.tool || '')];
  try { return fn ? String(fn() || '') : ''; } catch (_) { return ''; }
}
function _sftkHistSubject(o) {
  if (o.subject) return String(o.subject);
  const fn = _sftkHistSubjects[String(o.tool || '')];
  try { return fn ? String(fn() || '') : ''; } catch (_) { return ''; }
}
function sftkHistoryBegin(opts) {
  const o = opts || {};
  return {
    id: _sftkHistId('tool'),
    kind: 'tool',
    tool: String(o.tool || 'tool'),
    profileName: String(o.title || o.tool || 'change'),
    row: _sftkHistRow(o),               // the row of the tool's list it was made from — that row's ↩ Undo reads it (2026-11-16)
    subject: _sftkHistSubject(o),       // what the change is about (Field Cleaner: "Account.Field__c") — "undo all for this field" reads it (2026-11-15)
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
      // retry (2026-11-15): a step's second message for a named refusal (see sftkHistoryUndo) is kept with the step
      .map(s => ({ describe: String(s.describe || s.msg.type), msg: s.msg, verify: s.verify || null, orgUrl: s.orgUrl || '',
        ...(s.retry && s.retry.when && s.retry.msg && typeof s.retry.msg.type === 'string' ? { retry: s.retry } : {}) }));
    if (steps.length) return { steps, note: undo.note ? String(undo.note) : '' };
    return { none: 'the undo steps were empty — a bug in the tool, please report it' };
  }
  if (undo && typeof undo.none === 'string' && undo.none.trim()) return { none: undo.none.trim() };
  if (undo && Array.isArray(undo.steps)) return { none: 'nothing was written, so there is nothing to undo' };
  return { none: 'this tool did not say whether the change can be undone — a bug, please report it' };
}

function _sftkHistStatus(j) {
  // an `info` line says something (what an undo could not restore); it is not a write
  const w = (j.what || []).filter(x => !x.info);
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

// The list kept at hand: the newest entries, up to the cap (Data Studio's own array, or the stored list in the popup).
async function _sftkHistHot() {
  if (_sftkHistStudio()) return _history;
  try { return (await chrome.storage.local.get('sftk_history')).sftk_history || []; } catch (_) { return []; }
}
// QA 1.1 #5: the cap is shared by deployments, every tool and every undo, so two long Field Cleaner runs moved the
// first run's oldest changes to the on-PC archive, where no Toolkit surface read them: they could not be seen,
// undone, backed up or cleared. A Toolkit tool's archived entries are part of its Activity like any other.
// → the hot list with the archived Toolkit entries it does not hold put in front (they are older). The hot copy of
// an id wins. Never a push into the list handed in: Data Studio's `_history` must stay the hot tier only. PURE.
function sftkHistoryWithArchived(hot, archived) {
  const base = Array.isArray(hot) ? hot : [];
  const have = new Set(base.map(e => e && e.id));
  const add = [];
  for (const e of (Array.isArray(archived) ? archived : [])) {
    if (!e || !e.id || have.has(e.id) || !sftkHistoryToolTab(e)) continue;
    have.add(e.id); add.push(e);
  }
  if (!add.length) return base;
  add.sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));
  return [...add, ...base];
}
// Every archived entry (sftk-archive.js), or [] on a page without the archive or when it cannot be read.
async function _sftkHistArchived() {
  if (typeof sftkArchList !== 'function') return [];
  try { return (await sftkArchList(null, 1e9)) || []; } catch (_) { return []; }
}
// Delete the archived entries `test` picks. → how many were deleted (0 when the archive could not be written).
async function sftkHistoryArchDrop(test) {
  if (typeof test !== 'function' || typeof _sftkArchTx !== 'function') return 0;
  const ids = (await _sftkHistArchived()).filter(e => e && e.id && test(e)).map(e => e.id);
  if (!ids.length) return 0;
  try { await _sftkArchTx('readwrite', st => { for (const id of ids) st.delete(id); }); } catch (_) { return 0; }
  return ids.length;
}
// Write a changed entry back WHERE IT IS: in the hot list when it is there, in the archive otherwise — so an
// archived change that was undone keeps its place and does not come back as the newest entry of the list.
async function _sftkHistSaveInPlace(entry) {
  const hot = await _sftkHistHot();
  if (typeof sftkArchPut !== 'function' || hot.some(h => h && h.id === entry.id)) { await sftkHistoryAppend(entry); return; }
  try { await sftkArchPut([entry]); } catch (_) { await sftkHistoryAppend(entry); }
}

async function sftkHistoryAll() {
  return sftkHistoryWithArchived(await _sftkHistHot(), await _sftkHistArchived());
}

// What the History card offers for a tool entry.
function sftkToolUndoState(entry) {
  const u = entry && entry.kind === 'tool' ? entry.toolUndo : null;
  if (!entry || entry.kind !== 'tool') return { show: false };
  if (!u) return { show: true, disabled: true, label: '↩ no undo', title: 'This entry has no undo statement (the action was cut short before it ended).' };
  if (u.done) {
    return { show: true, disabled: true, label: u.done.ok ? '↩ Undone' : '↩ Undo attempted',
      title: u.done.ok ? `Undone and verified on ${u.done.at}. The undo has its own entry in Activity.` : `An undo was run on ${u.done.at} but not every step was confirmed — see the undo's own entry in Activity.` };
  }
  if (u.none) return { show: true, disabled: true, label: '↩ no undo', title: `Cannot be undone from here — ${u.none}` };
  const n = (u.steps || []).length;
  return { show: true, disabled: false, label: `↩ Undo (${n} step${n === 1 ? '' : 's'})`,
    title: `Writes the previous state back${u.note ? ` — ${u.note}` : ''}. Each step is re-read to confirm it; the undo is recorded in Activity.` };
}

// ── The verify spec, evaluated against a query's answer (pure) ──────────
//   pick:    dotted path into the answer (default 'records'); numbers index arrays
//   where:   { field, equals } — pick the array element whose field matches;
//            or a LIST of them, all of which must match (text compared without case);
//            `loose: true` compares text with line endings and trailing blanks ignored
//            (a source file Salesforce stores — it may hand back LF for CRLF)
//   then one of: absent (nothing there) · count (array length) ·
//                field + equals / notNull / notFalse (a value on the picked object)
//   pattern: a regular expression (source + flags) matched against the answer's
//            TEXT — for a read that answers text, not JSON (SOAP readMetadata
//            through `msg`, 2026-11-04: a report type has no SOQL and no REST path)
//   strip:   with pattern — a regular expression (source) whose matches are cut out of the text first
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
  if (s.pattern) {
    let ok = false;
    // strip (2026-11-15): a part of the text the pattern must NOT be satisfied by, cut out first — a layout's
    // <relatedLists> name ANOTHER object's columns, so a same-named column there is no evidence of the restore.
    try {
      let txt = String(answer.text == null ? '' : answer.text);
      if (s.strip) txt = txt.replace(new RegExp(String(s.strip), 'gi'), '');
      ok = new RegExp(String(s.pattern), String(s.flags || '')).test(txt);
    } catch (_) { ok = false; }
    return { ok, text: ok ? (t.ok || '') : (t.bad || 'accepted by Salesforce, but the org still shows the old state') };
  }
  let v = _sftkHistPick(answer, s.pick || 'records');
  const conds = Array.isArray(s.where) ? s.where.filter(w => w && w.field) : (s.where && s.where.field ? [s.where] : []);
  if (conds.length) {
    const loose = s => String(s).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
    const same = (a, b, w) => (w && w.loose && typeof a === 'string' && typeof b === 'string') ? loose(a) === loose(b)
      : (typeof a === 'string' && typeof b === 'string' && conds.length > 1) ? a.toLowerCase() === b.toLowerCase() : a === b;
    v = (Array.isArray(v) ? v : []).find(x => x && conds.every(w => same(x[w.field], w.equals, w)));
  }
  let ok;
  if (s.absent) ok = v === undefined || v === null || (Array.isArray(v) && v.length === 0);
  else if (typeof s.count === 'number') ok = Array.isArray(v) && v.length === s.count;
  else if (s.field) {
    const fv = v == null ? undefined : v[s.field];
    const loose = x => String(x == null ? '' : x).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
    ok = s.notNull ? (fv !== null && fv !== undefined) : s.notFalse ? fv !== false : ('equals' in s ? (s.loose ? loose(fv) === loose(s.equals) : fv === s.equals) : fv !== undefined);
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
  if (typeof sftkBgNote === 'function') sftkBgNote(msg);   // an item's own progress listens (sftkItemTrack)
  return new Promise(r => {
    try { chrome.runtime.sendMessage(msg, res => r(res || { error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'No response' })); }
    catch (e) { r({ error: (e && e.message) || String(e) }); }
  });
}

// 2026-11-15 (live re-check): a tool whose page is open kept showing what the undo had just taken back — Flow
// Access still listed the removed grants until a reload. Nothing told the tools an undo had run (History redraws
// itself from storage; a tool's own lists come from the org). The smallest hook: one DOM event once the undo's
// steps have run, whatever their outcome — a partly-run undo changed the org too. Not sent for an undo that was
// cancelled or never started. → the detail that was sent, or null where there is no page to tell.
function sftkHistoryUndoAnnounce(entry, result, doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d || typeof d.dispatchEvent !== 'function' || !entry) return null;
  const detail = { tool: String(entry.tool || ''), tab: sftkHistoryToolTab(entry), orgUrl: String(entry.targetOrg || ''), ok: !!(result && result.ok), entryId: entry.id };
  try {
    const ev = typeof CustomEvent === 'function' ? new CustomEvent('sftk:history-undone', { detail }) : Object.assign(new Event('sftk:history-undone'), { detail });
    d.dispatchEvent(ev);
  } catch (_) { return null; }   // a listener that throws must not turn a finished undo into a failed one
  return detail;
}

// Undo one tool entry: confirm (the shared dialog, the acknowledgement, the typed org
// name when the target is treated as production), then run the steps
// through the write discipline, record the undo as its own entry, mark the
// original. opts: { send?, onLog?, confirm? (false = skip the dialog, for
// callers that asked already) }. Returns { ok, text, entry, undoEntry }.
async function sftkHistoryUndo(entryId, opts) {
  const o = opts || {};
  const send = typeof o.send === 'function' ? o.send : _sftkHistSend;
  const log = typeof o.onLog === 'function' ? o.onLog : () => {};
  const all = await sftkHistoryAll();
  // Activity keeps its newest ${SFTK_HISTORY_CAP} entries at hand and moves older ones to the archive. Every undo is an entry of its
  // own, so a long ↩ Undo all pushed its own oldest targets out while it ran — seen live 2026-11-17 (owner's
  // screenshot: 37 of 39 undone, the two oldest "no longer in Activity"). The caller that already holds the entry
  // hands it in (o.entry); it is used when the list no longer has it.
  const entry = all.find(h => h && h.id === entryId && h.kind === 'tool')
    || ((o.entry && o.entry.id === entryId && o.entry.kind === 'tool') ? o.entry : null);
  if (!entry) return { ok: false, text: 'This entry is no longer in Activity.' };
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
        html: `Writes the previous state back in <strong>${(sess.label || _sftkHistOrgKey(orgUrl)).replace(/</g, '&lt;')}</strong>. An undo has no undo.` +
          '<div class="sftk-cf-plan"><ol class="sftk-cf-rows">' +
          '<li><b>Steps</b><span>One at a time; each step is re-read to confirm it</span></li>' +
          '<li><b>Recorded</b><span>The whole undo is recorded in Activity</span></li>' +
          '<li><b>Redo</b><span>To redo the change, use the tool again</span></li></ol>' +
          (entry.toolUndo.note ? `<details class="sftk-cf-more"><summary>Note from the tool</summary>${String(entry.toolUndo.note).replace(/</g, '&lt;')}</details>` : '') + '</div>',
        needsCheckbox: true,
        ack: 'I understand this writes the earlier state back over whatever is there now',
      },
      confirmLabel: '↩ Undo',
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
      // step.retry (2026-11-15): { when, flags?, msg, say? } — a second message sent when the first is refused with
      // an error that matches `when`. A layout undo needs it: Salesforce often refuses a layout deploy on its action
      // lists, where the fix's own fallback and Restore points deploy again without them — the undo sent one deploy
      // and was refused where both of those went through. Both attempts are verified by the step's one re-read below.
      write: async () => {
        const sendStep = m => send({ ...m, orgUrl: stepOrg.orgUrl, sid: stepOrg.sid, _suppressError: true, _silentError: true });
        const first = await sendStep(step.msg);
        const rt = step.retry;
        const err = first && (first.error || first.success === false) ? String(first.error || first.errorMessage || first.message || '') : '';
        if (!err || !rt || !rt.msg || !rt.when) return first;
        let hit = false;
        try { hit = new RegExp(String(rt.when), String(rt.flags || 'i')).test(err); } catch (_) { hit = false; }
        if (!hit) return first;
        log(`… ${step.describe}: ${rt.say || 'refused as sent — trying the step\'s second way'}`);
        const second = await sendStep(rt.msg);
        // accepted or refused, the second answer stands; with no answer at all the first refusal is what is said
        return second && (second.error || second.success === false) ? second : (second || first);
      },
      verify: step.verify && (step.verify.query || step.verify.path || step.verify.msg) ? async () => {
        const vs = step.verify;
        const read = () => (vs.msg
          ? send({ ...vs.msg, orgUrl: stepOrg.orgUrl, sid: stepOrg.sid, _suppressError: true, _silentError: true })
          : vs.path
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
      noVerify: step.verify && (step.verify.query || step.verify.path || step.verify.msg) ? undefined : 'this step has no re-read',
      journal: j,
    });
    log(`${r.ok ? '✅' : r.accepted ? '⚠' : '❌'} ${r.text}`);
  }
  // QA 2026-10-06: a tool's undo can leave something as it is (API versions: a
  // Draft rewritten in place has no previous copy). The dialog said so; the
  // result and the undo's own entry must say so too, or "Undone — 4 steps
  // verified" reads as the whole change taken back.
  const note = entry.toolUndo && entry.toolUndo.note ? String(entry.toolUndo.note) : '';
  if (note) j.what.push({ describe: 'not restored', info: true, ok: false, accepted: false, verified: false, text: `Not restored — ${note}` });
  // confirmed-by: the ↩ Undo sftkConfirmDestructive above (or the caller, with confirm: false)
  const undoEntry = await sftkHistoryEnd(j, { undo: { none: 'this entry is itself an undo — redo the change from the tool' }, undoOf: entry.id });
  const stepsRun = j.what.filter(x => !x.info);
  const okAll = stepsRun.length > 0 && stepsRun.every(x => x.ok);
  // QA 1.1 #37: the mark that closes an entry's Undo is set only when Salesforce accepted at least one step. An
  // attempt in which every step was refused (connection lost, session expired, API limit, a lock) changed nothing in
  // the org, and the earlier state is still in the entry: it stays undoable. The attempt has its own entry either way.
  const written = sftkHistoryUndoWrote(j.what);
  if (written) {
    entry.toolUndo.done = { at: j.completedAt, ok: okAll, entryId: j.id };
    await _sftkHistSaveInPlace(entry);
  }
  const okN = stepsRun.filter(x => x.ok).length;
  const tail = note ? ` · not restored: ${note}` : '';
  sftkHistoryUndoAnnounce(entry, { ok: okAll });   // the open tool re-reads the org (2026-11-15)
  const text = okAll ? `Undone — ${okN} step${okN === 1 ? '' : 's'} verified by re-reading the org`
    : !written ? `Nothing was undone: Salesforce accepted none of the ${stepsRun.length} step${stepsRun.length === 1 ? '' : 's'}, so the org is as it was. The reason is in the undo's entry in Activity. This change can still be undone — try again`
    : `Undo ran: ${okN} of ${stepsRun.length} step${stepsRun.length === 1 ? '' : 's'} verified — see the undo's entry in Activity`;
  return { ok: okAll, written, text: text + tail, entry, undoEntry };
}
// Did an undo change the org? True when Salesforce accepted at least one of its steps (the "not restored" note
// line is not a step). PURE.
function sftkHistoryUndoWrote(what) {
  return (Array.isArray(what) ? what : []).some(x => x && !x.info && x.accepted);
}
// Why an undo that wrote nothing should stop a whole Undo all: the refusals say the org cannot be reached or the
// session is no longer valid, so every entry after it would be refused the same way. → the first such line, or ''.
// A refusal about the component itself (a validation error, a lock) answers '' — the next entry is another component. PURE.
function sftkHistoryUndoUnreachable(what) {
  const re = /INVALID_SESSION_ID|session (?:has )?expired|expired session|failed to fetch|networkerror|network error|ERR_INTERNET|ERR_NETWORK|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|no response|could not establish connection|message port closed|REQUEST_LIMIT_EXCEEDED|\b401\b/i;
  const steps = (Array.isArray(what) ? what : []).filter(x => x && !x.info);
  if (!steps.length || steps.some(x => x.accepted)) return '';
  const hit = steps.find(x => re.test(String(x.text || '')));
  return hit ? String(hit.text || '') : '';
}

// ── Undo all the changes a tool made about one subject (owner 2026-11-15: "we need an undo all. without going over
// all the components one by one … undo all for field cleaner per a field") ─────────────────────────────────────
// The entries that can still be undone, NEWEST FIRST — a component changed twice gets its later change taken back
// before its earlier one. An entry belongs to the subject by its own `subject`; one written before entries carried
// a subject belongs when its title names the subject as a whole word. PURE.
//   o: { tool, orgUrl, subject }
function sftkHistoryUndoableFor(all, o) {
  const q = o || {}, subj = String(q.subject || '');
  if (!subj) return [];
  const org = _sftkHistOrgKey(q.orgUrl);
  const word = new RegExp('(^|[^A-Za-z0-9_.])' + subj.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^A-Za-z0-9_])');
  return (Array.isArray(all) ? all : []).filter(e => e && e.kind === 'tool' && e.tool === q.tool
      && _sftkHistOrgKey(e.targetOrg) === org
      && (e.subject ? e.subject === subj : word.test(String(e.profileName || '')))
      && !e.undoOf && !sftkToolUndoState(e).disabled)
    .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
}
// The changes one row made that can still be undone, newest first. PURE.   o: { tool, orgUrl, subject, row }
function sftkHistoryUndoableForRow(all, o) {
  const row = String((o && o.row) || '');
  if (!row) return [];
  return sftkHistoryUndoableFor(all, o).filter(e => String(e.row || '') === row);
}
// Run them one after the other, with no dialog of their own — the caller asked once for the whole list.
//   opts: { send?, onStart(i, n, entry), onLog(line), onEnd(i, n, entry, result), undo? (for tests) }
//   → { total, ran, ok, failed: [{ entry, text }], stopped: '' | why the rest was not tried }
// A step that fails does not stop the rest (each entry is its own component); no session for the org does — every
// entry after it would fail the same way — and so does an entry whose every step was refused because the org could
// not be reached (sftkHistoryUndoUnreachable).
async function sftkHistoryUndoMany(entries, opts) {
  const o = opts || {}, list = Array.isArray(entries) ? entries : [];
  const undo = typeof o.undo === 'function' ? o.undo : sftkHistoryUndo;
  const out = { total: list.length, ran: 0, ok: 0, failed: [], stopped: '' };
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (typeof o.onStart === 'function') o.onStart(i, list.length, e);
    let r;
    try { r = await undo(e.id, { confirm: false, send: o.send, onLog: o.onLog, entry: e }); }
    catch (err) { r = { ok: false, text: String((err && err.message) || err) }; }
    if (typeof o.onEnd === 'function') o.onEnd(i, list.length, e, r);
    if (r && !r.ok && !r.entry && /^Log in to /.test(String(r.text || ''))) { out.stopped = r.text; break; }
    out.ran++;
    if (r && r.ok) out.ok++; else out.failed.push({ entry: e, text: String((r && r.text) || 'no answer') });
    // QA 1.1 #37: the session is still listed but the org cannot be reached (connection lost, session expired, API
    // limit) — this entry wrote nothing and the ones after it would be refused the same way. Stop; all stay undoable.
    const cut = (r && !r.ok && r.undoEntry) ? sftkHistoryUndoUnreachable(r.undoEntry.what) : '';
    if (cut) {
      out.stopped = `Salesforce could not be reached (${cut}). Nothing was written for the last change tried, and every change not undone can still be undone. Check the connection and the org login, then undo the rest`;
      break;
    }
  }
  return out;
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
  'Copy Permissions': 'copy-perms', 'Flow switches': 'flows', 'API versions': 'flows',   // one Flows page (2026-10-17)
  'Flow delete': 'flows', 'Flow interviews': 'flows', 'Flow Access': 'flow-access',
};
const SFTK_TOOLKIT_TAB_LABELS = {
  flows: 'Flows', debugger: 'Debugger', pages: 'Lightning Pages', fields: 'Field Cleaner',
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
// Is the entry one of this tab's? '*' = any Toolkit tool (Activity works on all of them at once, 2026-11-16). PURE.
function sftkHistoryInTab(e, tab) {
  const t = sftkHistoryToolTab(e);
  return String(tab) === '*' ? !!t : (!!t && t === String(tab));
}
// The entries about one subject (Field Cleaner: "Account.Field__c"): by the entry's own `subject`; one written before
// entries carried a subject belongs when its title names the subject as a whole word. PURE.
function sftkHistoryForSubject(list, subject) {
  const subj = String(subject || '');
  if (!subj) return [];
  const word = new RegExp('(^|[^A-Za-z0-9_.])' + subj.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^A-Za-z0-9_])');
  return (Array.isArray(list) ? list : []).filter(e => e && (e.subject ? e.subject === subj : word.test(String(e.profileName || ''))));
}
// One tool's entries, newest first. PURE.
function sftkHistoryForTab(all, tab) {
  return (Array.isArray(all) ? all : []).filter(e => sftkHistoryInTab(e, tab))
    .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
}
// Clear one tool's History (owner 2026-11-16: "we should add a button that clears the history"). What stays: every
// entry of another tool, every deployment. PURE.
function sftkHistoryWithoutTab(all, tab) {
  return (Array.isArray(all) ? all : []).filter(e => !sftkHistoryInTab(e, tab));
}
// → how many entries were removed. Nothing in an org is touched: only the record of the changes, and with it their ↩ Undo.
// The tool's entries in the on-PC archive go too (QA 1.1 #5): cleared means gone from this browser, not kept where
// Data Studio's full export would still write them out.
async function sftkHistoryClearTab(tab) {
  if (String(tab) !== '*' && !sftkHistoryTabLabel(tab)) return 0;
  const archived = await sftkHistoryArchDrop(e => sftkHistoryInTab(e, tab));
  if (_sftkHistStudio()) {
    const keep = sftkHistoryWithoutTab(_history, tab), n = _history.length - keep.length;
    if (n) { _history.splice(0, _history.length, ...keep); await storageSaveHistory(); }
    return n + archived;
  }
  let list = [];
  try { list = (await chrome.storage.local.get('sftk_history')).sftk_history || []; } catch (_) { list = []; }
  const keep = sftkHistoryWithoutTab(list, tab);
  if (keep.length !== list.length) await chrome.storage.local.set({ sftk_history: keep });
  return list.length - keep.length + archived;
}
// One entry removed (owner 2026-11-18, in the Activity window: "and allow deletion of individuals"). Only the record
// goes, and with it that change's ↩ Undo — nothing in an org is touched. → true when an entry was removed.
async function sftkHistoryRemove(id) {
  const key = String(id || '');
  if (!key) return false;
  // an entry that aged into the on-PC archive is listed too (QA 1.1 #5) — its copy there goes with it
  const archived = (await sftkHistoryArchDrop(e => e.id === key)) > 0;
  if (_sftkHistStudio()) {
    const i = _history.findIndex(h => h && h.id === key);
    if (i < 0) return archived;
    _history.splice(i, 1); await storageSaveHistory();
    return true;
  }
  let list = [];
  try { list = (await chrome.storage.local.get('sftk_history')).sftk_history || []; } catch (_) { list = []; }
  const keep = list.filter(h => !(h && h.id === key));
  if (keep.length === list.length) return archived;
  await chrome.storage.local.set({ sftk_history: keep });
  return true;
}
// ── A Toolkit entry removed on another page is removed here too (QA 1.1 #61) ─────────────────────────────────────
// Data Studio keeps the list in memory (`_history`) and writes the whole of it on its next save. Its own storage
// listener only adds and upgrades entries, so an entry deleted or cleared in the Toolkit stayed in that memory —
// still drawn in Activity with a live Undo — and the next deployment or rollback wrote it back for every page.
// → the ids of the Toolkit tools' entries the stored list held before a change and no longer holds. Only a Toolkit
// tool's entry: those are removed on the Toolkit's pages (🗑, Clear, the move to the on-PC archive), never by a
// write of this page that another page's stale list could appear to undo. PURE.
function sftkHistoryGoneIds(oldValue, newValue) {
  const now = new Set((Array.isArray(newValue) ? newValue : []).map(e => e && e.id));
  return (Array.isArray(oldValue) ? oldValue : []).filter(e => e && e.id && sftkHistoryToolTab(e) && !now.has(e.id)).map(e => e.id);
}
// Drop them from a list IN PLACE (Data Studio's own array). → how many were dropped.
function sftkHistoryDropGone(local, oldValue, newValue) {
  if (!Array.isArray(local)) return 0;
  const gone = new Set(sftkHistoryGoneIds(oldValue, newValue));
  if (!gone.size) return 0;
  let n = 0;
  for (let i = local.length - 1; i >= 0; i--) {
    const h = local[i];
    if (h && gone.has(h.id) && sftkHistoryToolTab(h)) { local.splice(i, 1); n++; }
  }
  return n;
}
function _sftkHistOnStorage(changes, area) {
  if (area !== 'local' || !changes || !changes.sftk_history || !_sftkHistStudio()) return;
  const n = sftkHistoryDropGone(_history, changes.sftk_history.oldValue, changes.sftk_history.newValue);
  if (n && typeof renderHistory === 'function' && (typeof _currentView === 'undefined' || _currentView === 'history')) renderHistory();
}
try {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged && typeof chrome.storage.onChanged.addListener === 'function') {
    chrome.storage.onChanged.addListener(_sftkHistOnStorage);
  }
} catch (_) { /* no storage events outside an extension page */ }
// ── A backup file of one tool's History, WITH its undo (owner 2026-11-16: "and a way for users to backup their
// activity … along with undo") ──────────────────────────────────────────────────────────────────────────────────
// The file is the entries as they are stored — the earlier state each ↩ Undo writes back is inside the entry — so a
// restored entry can be undone exactly like one that never left. PURE.
const SFTK_HISTORY_BACKUP_FORMAT = 'sftk-history-backup';
function sftkHistoryBackupOf(all, tab, nowIso) {
  const entries = sftkHistoryForTab(all, tab);
  return { format: SFTK_HISTORY_BACKUP_FORMAT, version: 1, tab: String(tab), tool: String(tab) === '*' ? 'Toolkit' : sftkHistoryTabLabel(tab), exportedAt: String(nowIso || ''), count: entries.length, entries };
}
// The text of a file → { ok, entries, dropped, why }. Only this tool's own entries are taken: an entry of another
// tool, a deployment, or anything that is not a history entry is counted in `dropped` and left out. PURE.
function sftkHistoryBackupRead(text, tab) {
  let j;
  try { j = JSON.parse(String(text || '')); } catch (_) { return { ok: false, entries: [], dropped: 0, why: 'This file is not an Activity backup (it is not JSON).' }; }
  if (!j || j.format !== SFTK_HISTORY_BACKUP_FORMAT || !Array.isArray(j.entries)) return { ok: false, entries: [], dropped: 0, why: 'This file is not an Activity backup made by the Toolkit.' };
  if (Number(j.version) > 1) return { ok: false, entries: [], dropped: 0, why: 'This backup was made by a newer version of the Toolkit. Update the Toolkit, then restore it.' };
  // a backup of everything can be read by one tool (it takes its own); one tool's backup by Activity; never tool A's by tool B
  if (String(tab) !== '*' && String(j.tab) !== '*' && String(j.tab) !== String(tab)) return { ok: false, entries: [], dropped: 0, why: `This is a backup of ${sftkHistoryTabLabel(j.tab) || 'another tool'} — restore it from Activity.` };
  const good = j.entries.filter(e => e && typeof e === 'object' && typeof e.id === 'string' && e.id && typeof e.startedAt === 'string'
    && typeof e.targetOrg === 'string' && sftkHistoryInTab(e, tab));
  if (!good.length) return { ok: false, entries: [], dropped: j.entries.length, why: String(tab) === '*' ? 'This backup holds no change made with a Toolkit tool.' : 'This backup holds no change of this tool.' };
  return { ok: true, entries: good, dropped: j.entries.length - good.length, why: '' };
}
// What is already in History stays as it is (it may have been undone since the backup); the rest is added, marked
// with the date it came back from a file. → { list (oldest first), added, skipped }. PURE.
// `known`: ids kept somewhere else than the list (the on-PC archive) — an entry already there is skipped like one
// in the list (QA 1.1 #38: a second restore of the same file added the archived ones again and counted them again).
function sftkHistoryMergeBackup(list, entries, nowIso, known) {
  const base = Array.isArray(list) ? list : [], inc = Array.isArray(entries) ? entries : [];
  const have = new Set(base.map(e => e && e.id));
  if (known && typeof known.forEach === 'function') known.forEach(id => have.add(id));
  const add = [];
  for (const e of inc) { if (!e || have.has(e.id)) continue; have.add(e.id); add.push({ ...e, restoredFromBackup: String(nowIso || '') || true }); }
  const out = [...base, ...add].sort((a, b) => String((a && a.startedAt) || '').localeCompare(String((b && b.startedAt) || '')));
  return { list: add.length ? out : base, added: add.length, skipped: inc.length - add.length, addedIds: add.map(e => e.id) };
}
// The newest `room` of the entries a backup would add — what fits a list that cannot hand its overflow on. PURE.
function sftkHistoryBackupNewest(entries, ids, room) {
  const want = new Set(Array.isArray(ids) ? ids : []);
  return (Array.isArray(entries) ? entries : []).filter(e => e && want.has(e.id))
    .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || ''))).slice(0, Math.max(0, Number(room) || 0));
}
// → { added, skipped, archived, notKept }
//   added    = entries that came back and can be listed and undone here (in the list or in the on-PC archive)
//   archived = the oldest entries of the merged list, moved to the on-PC archive because the list keeps ${SFTK_HISTORY_CAP};
//              counted only once the archive has taken them
//   notKept  = entries of the file that were NOT restored: the list had no room and the archive could not be written.
//              Nothing that was already listed is dropped to make room for them.
// QA 1.1 #38: the archive write was best-effort and its failure was swallowed, so the overflow — restored entries,
// and entries that were already here — was dropped while the count said it went to the archive.
async function sftkHistoryRestoreBackup(entries, nowIso) {
  const studio = _sftkHistStudio();
  let list = [];
  if (studio) list = _history;
  else { try { list = (await chrome.storage.local.get('sftk_history')).sftk_history || []; } catch (_) { list = []; } }
  const known = new Set((await _sftkHistArchived()).map(e => e && e.id));
  let m = sftkHistoryMergeBackup(list, entries, nowIso, known);
  if (!m.added) return { added: 0, skipped: m.skipped, archived: 0, notKept: 0 };
  const cut = l => (typeof sftkHistorySplit === 'function') ? sftkHistorySplit(l, SFTK_HISTORY_CAP) : { keep: l.slice(-SFTK_HISTORY_CAP), overflow: l.slice(0, Math.max(0, l.length - SFTK_HISTORY_CAP)) };
  let split = cut(m.list), archived = 0, notKept = 0;
  const skipped = m.skipped;
  if (split.overflow.length) {
    let put = false;
    if (typeof sftkArchPut === 'function') {
      if (studio && typeof _historyStripCountsOnly === 'function') _historyStripCountsOnly(split.overflow);   // as storageSaveHistory does
      try { await sftkArchPut(split.overflow); put = true; } catch (_) { put = false; }
    }
    if (put) archived = split.overflow.length;
    else {
      // nowhere to move the overflow to: add only what fits beside what is already listed
      const fit = sftkHistoryBackupNewest(entries, m.addedIds, SFTK_HISTORY_CAP - list.length);
      const m2 = sftkHistoryMergeBackup(list, fit, nowIso, known);
      notKept = m.added - m2.added;
      m = m2; split = { keep: m2.list, overflow: [] };
      if (!m.added) return { added: 0, skipped, archived: 0, notKept };
    }
  }
  if (studio) { _history.splice(0, _history.length, ...split.keep); await storageSaveHistory(); }
  else await chrome.storage.local.set({ sftk_history: split.keep });
  return { added: m.added, skipped, archived, notKept };
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
// Data Studio › History › Clear All removes what that page lists: deployments, rollbacks and Data Studio's own
// changes. A Toolkit tool's changes are not listed there and stay, each with its ↩ Undo (QA 1.1 #6: Clear All
// emptied the whole shared list and the archive, so every tool lost its Activity and its Undo without a word).
// → what is left of the list. PURE.
function sftkHistoryStudioClearKeep(all) {
  return (Array.isArray(all) ? all : []).filter(e => !!sftkHistoryToolTab(e));
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
  globalThis.sftkHistoryStudioClearKeep = sftkHistoryStudioClearKeep;
  globalThis.sftkHistoryWithArchived = sftkHistoryWithArchived;
  globalThis.sftkHistoryArchDrop    = sftkHistoryArchDrop;
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
  globalThis.sftkHistoryUndoAnnounce = sftkHistoryUndoAnnounce;
}
