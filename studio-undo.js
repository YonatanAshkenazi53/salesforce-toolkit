'use strict';
// ════════════════════════════════════════════════════════════════
// ↩ ROLLBACK — restore points before data deployments, ↩ Roll back in History
// ════════════════════════════════════════════════════════════════
// (user 2026-08-26: "Can we also add rollback feature for data deployment?
// … I think it might help us with production issues")
//
// The pure logic — what to capture, how to diff, what a rollback can never
// undo — lives in sftk-undo.js. This file is the wiring around it:
//   · BEFORE a run writes (Run Transfer, fan-out, sequence, sync-plan push,
//     Reconcile), read the before-image of every object the run can write
//     and keep it in IndexedDB (a full image is far too big for
//     chrome.storage's shared 10 MB); a small stub rides on the History entry.
//   · AFTER the run, take the end-of-run boundary from Salesforce's own
//     timestamps (MAX(LastModifiedDate) of the written objects), PER ORG, so
//     "after the run" is never at the mercy of this PC's clock or of another
//     org's activity.
//   · FROM the History card, ↩ Roll back: re-read → diff → check what hangs
//     under the records to delete → show the exact plan and the automation
//     that can reject it → typed confirmation → delete what the run created
//     (soft delete — never a hard delete) → restore what it overwrote →
//     re-read to VERIFY exactly the records it acted on → its own History
//     entry. Nothing here claims more than the verification read confirmed,
//     and a run that could not get a restore point says so in its log — it
//     is never blocked.

// ── IndexedDB: database sftk_undo, store `evidence` (keyPath id) ─────────
function _sftkUndoOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('sftk_undo', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      const st = db.objectStoreNames.contains('evidence')
        ? req.transaction.objectStore('evidence')
        : db.createObjectStore('evidence', { keyPath: 'id' });
      if (!st.indexNames.contains('capturedAt')) st.createIndex('capturedAt', 'capturedAt');
      // v2 — a fan-out's legs share a groupId and count as ONE run for the cap.
      if (!st.indexNames.contains('groupId')) st.createIndex('groupId', 'groupId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// One request inside one transaction; resolves the request's result (so a
// missing record resolves to undefined, never to the request object).
function _sftkUndoReq(mode, fn) {
  return _sftkUndoOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('evidence', mode);
    const req = fn(tx.objectStore('evidence'));
    let result;
    if (req && typeof req.addEventListener === 'function') req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
    tx.onabort    = () => { db.close(); reject(tx.error); };
  }));
}

async function sftkUndoStorePut(ev) { await _sftkUndoReq('readwrite', st => st.put(ev)); }

async function sftkUndoStoreGet(id) {
  if (!id) return null;
  const v = await _sftkUndoReq('readonly', st => st.get(id));
  return v || null;
}

// { id: { capturedAt, groupId? } } for every stored restore point — keys
// only; the images themselves are never loaded just to count or prune them.
function sftkUndoStoreMeta() {
  return _sftkUndoOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('evidence', 'readonly');
    const store = tx.objectStore('evidence');
    const out = {};
    const cur = store.index('capturedAt').openKeyCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) { out[c.primaryKey] = { capturedAt: c.key }; c.continue(); return; }
      // Second key-only pass: which fan-out group each point belongs to
      // (points without a groupId are simply absent from this index).
      const g = store.index('groupId').openKeyCursor();
      g.onsuccess = () => {
        const gc = g.result;
        if (!gc) { db.close(); resolve(out); return; }
        if (out[gc.primaryKey]) out[gc.primaryKey].groupId = gc.key;
        gc.continue();
      };
      g.onerror = () => { db.close(); reject(g.error); };
    };
    cur.onerror = () => { db.close(); reject(cur.error); };
  }));
}

async function sftkUndoStoreDelete(id) { if (id) await _sftkUndoReq('readwrite', st => st.delete(id)); }

async function sftkUndoStoreClear() { try { await _sftkUndoReq('readwrite', st => st.clear()); } catch (_) {} }

// Retention: the user's "delete after N days" covers restore points too —
// they hold record data about the orgs and must never outlive the run log.
async function sftkUndoStoreDeleteOlderThan(cutoffIso) {
  if (!cutoffIso) return 0;
  const meta = await sftkUndoStoreMeta();
  const old = Object.entries(meta).filter(([, m]) => String(m.capturedAt) < cutoffIso).map(([id]) => id);
  for (const id of old) await sftkUndoStoreDelete(id);
  // The cards must say so — a card offering ↩ Roll back for evidence that
  // retention removed would fail only on the click (re-review 2026-09-12).
  if (old.length) await _sftkUndoMarkExpired(old);
  return old.length;
}

// Mark every History card whose restore point is gone as EXPIRED — the
// button never just vanishes, and never lies about being usable.
async function _sftkUndoMarkExpired(ids) {
  const changed = [];
  for (const h of _sftkUndoAllEntries()) {
    if (h && h.undo && ids.includes(h.undo.evidenceId) && !h.undo.rolledBackAt && h.undo.status !== 'expired') {
      h.undo.status = 'expired'; changed.push(h);
    }
  }
  if (changed.length) await _sftkUndoPersist(changed);
}

// Every History entry we can see — the hot tier AND the archived runs the
// user has loaded onto the page. An archived card is a card like any other.
function _sftkUndoAllEntries() {
  return [...(_history || []), ...((typeof _archShown !== 'undefined' && _archShown) || [])];
}

// Persist mutated entries: hot-tier ones ride storageSaveHistory, archived
// ones are written back to the archive (keyed by id, so put overwrites).
async function _sftkUndoPersist(entries) {
  const arch = (entries || []).filter(h => h && h._archived);
  if (arch.length && typeof sftkArchPut === 'function') { try { await sftkArchPut(arch); } catch (_) {} }
  await storageSaveHistory();
}

// Keep the newest N restore points. A run whose evidence was dropped gets
// its card marked EXPIRED — the button never just vanishes.
async function _sftkUndoPruneStore() {
  const meta = await sftkUndoStoreMeta();
  const { dropped } = sftkUndoPrune(meta, sftkUndoMaxRuns());
  if (!dropped.length) return;
  for (const id of dropped) await sftkUndoStoreDelete(id);
  await _sftkUndoMarkExpired(dropped);
}

// ── CAPTURE — the before-image, read before the first write ──────────────
// opts: { evidenceId, scope: 'run' | 'sequence', profileName, groupId?,
//         shouldCancel?: () => boolean,
//         legs: [{ orgUrl, sid, objects: [{ objType, depth, mode }] }] }
// groupId ties a fan-out's legs together for the evidence cap; shouldCancel
// is polled between objects so a ✋ during a long capture stops it.
// log(icon, msg, cls) is the caller's progress writer — No Silent Waits:
// every read is quoted before it starts and reported when it ends.
// Returns the History stub (sftkUndoEntryFor). Never throws: a failed
// capture is a run WITHOUT a restore point, said plainly — not a blocked run.
async function sftkUndoCaptureForRun(opts, log) {
  const say = typeof log === 'function' ? log : () => {};
  const capturedAt = new Date().toISOString();
  const evidenceId = (opts && opts.evidenceId) || genId('undo');
  const scope = (opts && opts.scope) || 'run';
  if (_settings?.undoCapture === false) {
    say('📸', 'Restore point skipped — switched off (📸 checkbox next to ▶ Deploy). This run will NOT be rollback-able.', 'ds-prog-warn');
    return sftkUndoEntryFor(evidenceId, [{ orgUrl: null, objects: {}, skipped: { 'all objects': 'restore points are switched off' } }], scope, capturedAt);
  }
  const legsOut = [];
  for (const leg of ((opts && opts.legs) || [])) {
    const out = { orgUrl: leg.orgUrl, objects: {}, skipped: {} };
    legsOut.push(out);
    if (!leg.sid) {
      for (const o of (leg.objects || [])) out.skipped[o.objType] = `no live session for ${orgLabel(leg.orgUrl)}`;
      continue;
    }
    for (const o of (leg.objects || [])) {
      if (opts && typeof opts.shouldCancel === 'function' && opts.shouldCancel()) {
        out.skipped[o.objType] = 'cancelled before this object\'s restore point was read';
        continue;
      }
      try {
        const desc = await describe(o.objType, leg.orgUrl, leg.sid);
        if (!desc || !Array.isArray(desc.fields)) {
          out.skipped[o.objType] = 'the object could not be described';
          say('⚠', `📸 ${o.objType}: restore point skipped — the object could not be described. This run will NOT be rollback-able for ${o.objType}.`, 'ds-prog-warn');
          continue;
        }
        let fields = sftkUndoFieldsForMode(sftkUndoFields(desc), o.mode);
        // Writable fields the image cannot hold (a base64 body reads back as
        // a URL, a classic encrypted field reads back masked) — named, so a
        // "nothing to roll back" can never quietly mean "nothing we could see".
        const notCovered = fields.length ? sftkUndoFieldsNotCovered(desc) : [];
        // Person Accounts derive Name from its parts and refuse a write to it;
        // the flag rides along (never diffed as a change, never written back)
        // so the restore payload can leave Name out for those rows.
        if (fields.length && desc.fields.some(f => f && f.name === 'IsPersonAccount')) fields = [...fields, 'IsPersonAccount'];
        const cap = sftkUndoRowCap(o.mode);
        const cnt = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: leg.orgUrl, sid: leg.sid,
          query: `SELECT COUNT() FROM ${o.objType}` });
        if (cnt?.error || typeof cnt?.totalSize !== 'number') {
          out.skipped[o.objType] = `count failed — ${cnt?.error || 'no total returned'}`;
          say('⚠', `📸 ${o.objType}: restore point skipped — could not count the object (${cnt?.error || 'no total returned'}). This run will NOT be rollback-able for ${o.objType}.`, 'ds-prog-warn');
          continue;
        }
        const n = cnt.totalSize;
        if (n > cap) {
          out.skipped[o.objType] = `${n.toLocaleString()} rows in ${orgLabel(leg.orgUrl)} — above the ${cap.toLocaleString()}-row restore-point limit`;
          say('⚠', `📸 ${o.objType}: ${n.toLocaleString()} rows in ${orgLabel(leg.orgUrl)} — above the ${cap.toLocaleString()}-row restore-point limit. This run will NOT be rollback-able for ${o.objType}.`, 'ds-prog-warn');
          continue;
        }
        const q = sftkUndoReadQuote(n);
        say('📸', `Restore point: reading ${n.toLocaleString()} ${o.objType} in ${orgLabel(leg.orgUrl)} (${fields.length ? `${fields.length} fields` : 'Ids only — an insert run cannot overwrite'}, ≈${q.calls} API call(s))…`);
        const res = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: leg.orgUrl, sid: leg.sid,
          query: sftkUndoSnapshotSoql(o.objType, fields) });
        if (res?.error) {
          out.skipped[o.objType] = `read failed — ${res.error}`;
          say('⚠', `📸 ${o.objType}: restore point failed — ${res.error}. This run will NOT be rollback-able for ${o.objType}.`, 'ds-prog-warn');
          continue;
        }
        if (res?.incomplete) {
          out.skipped[o.objType] = `read incomplete — the org reported ${res.incomplete.expected} rows, ${res.incomplete.got} arrived`;
          say('⚠', `📸 ${o.objType}: restore point refused — the org reported ${res.incomplete.expected} rows but ${res.incomplete.got} arrived. A partial image cannot support an honest rollback; this run will NOT be rollback-able for ${o.objType}.`, 'ds-prog-warn');
          continue;
        }
        const capd = sftkUndoCapture(res.records || [], cap);
        if (capd.truncated) {
          out.skipped[o.objType] = `${capd.count.toLocaleString()} rows — above the ${cap.toLocaleString()}-row restore-point limit`;
          say('⚠', `📸 ${o.objType}: ${capd.count.toLocaleString()} rows — above the ${cap.toLocaleString()}-row limit. This run will NOT be rollback-able for ${o.objType}.`, 'ds-prog-warn');
          continue;
        }
        out.objects[o.objType] = {
          depth: o.depth || 0, mode: o.mode, fields, count: capd.count, rows: capd.rows,
          label: desc.label || o.objType,
          // false = this object has NO Recycle Bin: a delete is permanent.
          undeletable: desc.undeletable !== false,
          notCovered,
        };
        say('✅', `📸 ${o.objType}: restore point saved — ${capd.count.toLocaleString()} record(s)${fields.length ? ` × ${fields.length} field(s)` : ''}`);
        if (notCovered.length) say('ℹ️', `📸 ${o.objType}: ${notCovered.length} writable field(s) cannot be captured and will NOT be restored by a rollback — ${notCovered.map(f => `${f.name} (${f.type})`).join(', ')}`, 'ds-prog-warn');
      } catch (e) {
        out.skipped[o.objType] = `restore point failed — ${e?.message || e}`;
        say('⚠', `📸 ${o.objType}: restore point failed — ${e?.message || e}. This run will NOT be rollback-able for ${o.objType}.`, 'ds-prog-warn');
      }
    }
  }
  if (opts && typeof opts.shouldCancel === 'function' && opts.shouldCancel()) {
    // Nothing is stored for a cancelled capture — the run will not start.
    return sftkUndoEntryFor(evidenceId, [{ orgUrl: null, objects: {}, skipped: { 'all objects': 'cancelled while the restore point was being read' } }], scope, capturedAt);
  }
  const stub = sftkUndoEntryFor(evidenceId, legsOut, scope, capturedAt);
  if (stub.status === 'none') return stub;
  try {
    await sftkUndoStorePut({ id: evidenceId, capturedAt, scope, profileName: (opts && opts.profileName) || '',
      ...((opts && opts.groupId) ? { groupId: String(opts.groupId) } : {}), legs: legsOut });
  } catch (e) {
    say('⚠', `📸 The restore point could not be stored on this PC (${e?.message || e}) — this run will NOT be rollback-able.`, 'ds-prog-warn');
    return sftkUndoEntryFor(evidenceId, [{ orgUrl: null, objects: {}, skipped: { 'all objects': `the restore point could not be stored on this PC — ${e?.message || e}` } }], scope, capturedAt);
  }
  // Pruning is bookkeeping: a failure here must not un-record a restore
  // point that WAS stored (re-review 2026-09-12).
  try { await _sftkUndoPruneStore(); }
  catch (e) { say('ℹ️', `📸 Older restore points could not be pruned (${e?.message || e}) — this run's restore point is stored.`); }
  return stub;
}

// ── END-OF-RUN BOUNDARY — Salesforce's clock, not this PC's ─────────────
// "Created or edited AFTER the run" is decided against this timestamp. The
// PC clock can be minutes off (a VM, broken time sync), which would either
// leave the run's own last records in place or delete someone else's — so
// the boundary is the newest LastModifiedDate Salesforce itself holds on the
// written objects at the moment the run returns. ONE ORG per call: a run
// that wrote into two orgs (Reconcile pull / ← update) takes one per org and
// stores them under undo.runEndByOrg, because the target's last write says
// nothing about when the source was last written. Falls back to the PC clock
// only when the read fails, and SAYS which one it used.
// Returns { runEndedAt, runEndedSource: 'server' | 'pc' }.
async function sftkUndoRunEnd(orgUrl, sid, objTypes) {
  const pc = new Date().toISOString();
  let best = null;
  if (orgUrl && sid) {
    for (const obj of (objTypes || [])) {
      try {
        const r = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl, sid,
          query: `SELECT MAX(LastModifiedDate) mx FROM ${obj}` });
        const mx = r && !r.error && r.records && r.records[0] && r.records[0].mx;
        const t = mx ? Date.parse(String(mx).replace(/([+-]\d\d)(\d\d)$/, '$1:$2')) : NaN;
        if (Number.isFinite(t) && (best === null || t > best)) best = t;
      } catch (_) { /* fall through to the PC clock */ }
    }
  }
  if (best !== null) return { runEndedAt: new Date(best).toISOString(), runEndedSource: 'server' };
  return { runEndedAt: pc, runEndedSource: 'pc' };
}

// ── The plan, rendered before anything is written ────────────────────────
// ── ROLLBACK — planner and executor (campaign 4 phase 7) ───────────────────
// User 2026-10-02: "The rollback screen is not great. we should make it open
// a reconcile screen, like the deployment screen, with all the features
// there." / "there's no info on the operation, who got deleted, etc".
//
// What used to be one 400-line modal flow (plan + typed word + writes) is now
// two DOM-free functions the ↩ Roll back PAGE (studio-rollback.js) drives:
//   sftkUndoLoadRun(runId)             → { run, ev, siblings, evidenceId } | { error }
//   sftkUndoBuildPlan(loaded, io)      → ctx (legs, plan items WITH the records) | null
//   sftkUndoExecute(ctx, picks, io)    → { status, results, errors, entry }
// `io` = { log(icon, text, cls), alive(), progress(evt) }: the page paints the
// log, decides whether the flow is still wanted, and feeds the live run view.
// The laws are unchanged: Recycle Bin only (SF_COLLECTIONS_DELETE), a refused
// or partial re-read refuses that object, later work by others is left alone,
// every count is Salesforce's per-record answer, verify by re-read.

// The small HTML pieces the page reuses (the automation that can reject or
// re-fire, the end-of-run boundary, the limits, the verdict) — kept here next
// to the planner they describe.
function _sftkUndoAutoHtml(leg) {
  const a = leg.automation || { blocking: [], sideEffects: [], unknown: [] };
  const names = rows => rows.slice(0, 5).map(r => r.ValidationName || r.MasterLabel || r.DeveloperName || r.Label || r.ApiName || r.Name || '?').join(', ');
  const li = (icon, e) => `<div style="margin-top:3px">${icon} ${esc(e.label)} (${e.count}): ${esc(names(e.rows || []))}${(e.rows || []).length > 5 ? ', …' : ''}</div>`;
  // A clean ✅ is only ever printed when EVERY category was checked — an
  // errored category is UNKNOWN, and "none found" over unknown is a lie.
  const clean = a.blocking.length
    ? `<div><strong>⛔ Can REJECT the rollback</strong> — a refusal is listed per record, never assumed done:${a.blocking.map(e => li('⛔', e)).join('')}</div>`
    : a.unknown.length
      ? `<div>❔ Nothing blocking was found in the categories that COULD be checked — ${a.unknown.length} categor${a.unknown.length === 1 ? 'y' : 'ies'} could not be checked, so this is not a clean bill.</div>`
      : '<div>✅ No active validation rule, duplicate rule or before-save automation found on these objects (every category was checked).</div>';
  return `<div class="ds-rb-auto">
      ${clean}
      ${a.sideEffects.length
        ? `<div style="margin-top:6px"><strong>⚠ Will fire AGAIN on the rollback</strong> — these already fired during the run and their effects are not undone:${a.sideEffects.map(e => li('⚠', e)).join('')}</div>` : ''}
      ${a.unknown.length
        ? `<div style="margin-top:6px"><strong>❔ Could not check:</strong> ${esc(a.unknown.map(u => `${u.label} (${u.why})`).join(' · '))}</div>` : ''}
    </div>`;
}
// The end-of-run boundary is PER ORG — a leg without one of its own gets no
// time filter at all (everything that differs is included, and every parent
// with any later child is kept), and says so.
function _sftkUndoEndHtml(leg) {
  const e = leg.end || {};
  if (!e.at) return '<div class="ds-rb-warnline">⚠ No end-of-run time is recorded for this org — nothing is filtered as "after the run" here: everything that differs from the restore point is included, and every parent with any later child is kept.</div>';
  return `<div class="ds-subtext" style="font-size:11px;margin-top:6px">Run ended ${esc(new Date(e.at).toLocaleString())} in this org ${e.source === 'server'
    ? '(Salesforce’s own timestamps, one-minute tolerance)'
    : '(⚠ this PC’s clock at the moment the run finished — Salesforce’s time could not be read; one-minute tolerance)'}.</div>`;
}
function _sftkUndoLimitsHtml() {
  return `<details class="ds-rb-limits" style="font-size:12px">
      <summary><strong>What a rollback cannot undo</strong></summary>
      <ul style="margin:6px 0 0 18px">${sftkUndoLimits().map(l => `<li style="margin-top:3px">${esc(l)}</li>`).join('')}</ul>
    </details>`;
}
// The one-line verdict when there is nothing to pick from.
function _sftkUndoVerdictHtml(ctx) {
  const refused = ctx.plan.filter(it => it.refused);
  if (ctx.anyWork || ctx.forceable) return '';
  if (refused.length) {
    return `<div class="ds-rec-card ds-rec-card-bad"><div class="ds-rec-card-line">❌ <strong>Nothing could be rolled back</strong> — ${refused.length} object(s) could not be read (${esc(refused.map(r => r.objType).join(', '))}); nothing was compared, nothing is written.</div></div>`;
  }
  return '<div class="ds-rec-card"><div class="ds-rec-card-line"><strong>Nothing to roll back</strong> — every object that was read matches the restore point (nothing created since it that the run could have made, nothing overwritten). Nothing is written.</div></div>';
}

// The guard is a TOKEN, not a boolean: an abandoned flow that wakes up later
// must never release a newer flow's guard. It is held only while writes are
// in flight.
let _sftkUndoBusy = null;
let _sftkUndoSeq = 0;

async function sftkUndoLoadRun(runId) {
  const run = _sftkUndoAllEntries().find(h => h && h.id === runId);
  if (!run || !run.undo) return { error: 'This run has no restore point.' };
  const evidenceId = run.undo.evidenceId || run.id;
  let ev = null;
  try { ev = await sftkUndoStoreGet(evidenceId); } catch (_) { ev = null; }
  if (!ev) {
    run.undo.status = 'expired';
    await _sftkUndoPersist([run]);
    if (typeof renderHistory === 'function' && typeof _currentView !== 'undefined' && _currentView === 'history') renderHistory();
    return { error: 'The restore point for this run is no longer on this PC — only the newest 10 runs keep one, and 🧹 Clear cached org data removes them.' };
  }
  // Every History entry sharing this evidence (a sequence's steps) is rolled
  // back together — the image was taken once, before the whole chain.
  const siblings = _sftkUndoAllEntries().filter(h => h && h.undo && (h.undo.evidenceId || h.id) === evidenceId);
  return { run, ev, siblings, evidenceId };
}

// Steps 1-2: sessions, locks, org type, automation, the re-read and the diff.
// Returns the plan context, or null when the flow was abandoned or refused
// before anything could be compared (the reason was logged).
async function sftkUndoBuildPlan(loaded, io) {
  const { run, ev } = loaded;
  const log = (icon, msg, cls = '') => { try { io.log(icon, msg, cls); } catch (_) {} };
  const alive = () => { try { return io.alive ? !!io.alive() : true; } catch (_) { return false; } };
  // Per-leg end-of-run boundary: the org's own, else (single-leg evidence)
  // the run's, else NONE — a leg never borrows another org's boundary.
  const byOrg = (run.undo && run.undo.runEndByOrg) || {};
  const evLegs = (ev.legs || []).filter(l => l && l.orgUrl && Object.keys(l.objects || {}).length);
  const endFor = (evOrgUrl) => {
    const own = byOrg[evOrgUrl];
    if (own && own.runEndedAt) return { at: own.runEndedAt, source: own.runEndedSource || 'pc' };
    if (evLegs.length === 1 && (run.undo.runEndedAt || run.completedAt)) {
      return { at: run.undo.runEndedAt || run.completedAt, source: run.undo.runEndedSource || (run.undo.runEndedAt ? 'pc' : 'history') };
    }
    return { at: null, source: null };
  };

  const plan = [];
  const legs = [];
  let anyWork = false, prod = false;
  const prodUnknown = [];
  const withDates = fields => [...(fields || []), 'CreatedDate', 'LastModifiedDate'];
  try {
    // 1. A live session for every org the image covers.
    for (const leg of evLegs) {
      const sess = await getOrgSession(leg.orgUrl);
      if (!alive()) return null;
      if (!sess) { log('❌', `Open ${orgLabel(leg.orgUrl)} in a Chrome tab — a live session is required to roll back.`, 'ds-prog-err'); return null; }
      legs.push({ orgUrl: sess.orgUrl, sid: sess.sid, objects: leg.objects, automation: null, evOrgUrl: leg.orgUrl, end: endFor(leg.orgUrl) });
    }
    if (!legs.length) { log('❌', 'The restore point holds no objects.', 'ds-prog-err'); return null; }
    // 🔒 A locked org is refused HERE, before the re-read — not at the first
    // delete, half-way through (user 2026-09-22, testing the guards). The
    // background chokepoint still blocks the write if this check is bypassed.
    const lockedLeg = legs.find(l => typeof window.sftkOrgLocked === 'function' && window.sftkOrgLocked(l.evOrgUrl || l.orgUrl));
    if (lockedLeg) { log('🔒', `Writes to ${orgLabel(lockedLeg.evOrgUrl || lockedLeg.orgUrl)} are locked (Connected Orgs → Unlock writes) — a rollback writes there, so nothing was read or written.`, 'ds-prog-err'); return null; }
    // Production — or an org whose type could not be confirmed — gets the
    // production-grade confirmation. Ambiguity fails closed.
    for (const leg of legs) {
      const t = await ensureOrgType(leg.orgUrl);
      if (t === 'production') prod = true;
      else if (t !== 'sandbox' && t !== 'dev') { prod = true; prodUnknown.push(leg.orgUrl); }
    }
    if (!alive()) return null;

    // 2. Automation that can reject or re-fire, then the re-read and the diff.
    for (const leg of legs) {
      const objs = Object.keys(leg.objects);
      const legEnd = leg.end.at;
      const sinceIso = legEnd ? sftkUndoSoqlDateTime(new Date(Date.parse(legEnd) + 60000).toISOString()) : null;
      // Object LABELS — FlowDefinitionView names its object by label, not API
      // name, so a custom or multi-word object would otherwise never match.
      // A describe that fails is SAID, because the cascade check below needs it.
      const labels = {}; const descs = {};
      for (const o of objs) {
        const d = await describe(o, leg.orgUrl, leg.sid);
        descs[o] = d || null;
        if (d && d.label) labels[o] = d.label;
        else if (leg.objects[o].label) labels[o] = leg.objects[o].label;
        if (!d) log('⚠', `${o}: could not be described in ${orgLabel(leg.orgUrl)} — what hangs under its records is unknown; any records to delete will be KEPT.`, 'ds-prog-warn');
      }
      log('🔎', `Checking the automation on ${objs.join(', ')} in ${orgLabel(leg.orgUrl)} (validation rules, duplicate rules, triggers, flows, workflow rules)…`);
      const results = {};
      for (const q of sftkUndoAutomationQueries(objs)) {
        const r = await sendBg({ type: 'SF_QUERY_ALL', tooling: !!q.tooling, orgUrl: leg.orgUrl, sid: leg.sid, query: q.soql });
        results[q.key] = r?.error ? { error: r.error } : { rows: r?.records || [] };
      }
      if (!alive()) return null;
      leg.automation = sftkUndoAutomationSummary(results, objs, labels);
      if (leg.automation.unknown.length) log('❔', `Could not check: ${leg.automation.unknown.map(u => u.label).join(', ')} — treated as unknown, not as none.`, 'ds-prog-warn');
      if (!legEnd) log('⚠', `${orgLabel(leg.orgUrl)}: no end-of-run time is recorded for this org — nothing is filtered as "after the run" here, and any parent with later children is kept.`, 'ds-prog-warn');
      const ordered = objs.map(o => ({ objType: o, ...leg.objects[o] })).sort((a, b) => (b.depth || 0) - (a.depth || 0));
      for (const o of ordered) {
        const cnt = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: leg.orgUrl, sid: leg.sid, query: `SELECT COUNT() FROM ${o.objType}` });
        const n = typeof cnt?.totalSize === 'number' ? cnt.totalSize : null;
        if (n === null) {
          // Same rule as the capture side: an object we cannot even count is
          // not read blind and quoted as "≈1 call".
          log('❌', `${o.objType}: could not be counted (${cnt?.error || 'no total returned'}). Rollback for ${o.objType} is refused.`, 'ds-prog-err');
          plan.push({ leg, ...o, refused: `count failed — ${cnt?.error || 'no total returned'}` });
          continue;
        }
        const q = sftkUndoReadQuote(n);
        log('🔍', `Reading ${n.toLocaleString()} ${o.objType} in ${orgLabel(leg.orgUrl)} now (≈${q.calls} API call(s)) to compare with the restore point…`);
        const res = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: leg.orgUrl, sid: leg.sid,
          query: sftkUndoSnapshotSoql(o.objType, withDates(o.fields)) });
        if (!alive()) return null;
        if (res?.error) {
          log('❌', `${o.objType}: could not be read — ${res.error}. Rollback for ${o.objType} is refused.`, 'ds-prog-err');
          plan.push({ leg, ...o, refused: `read failed — ${res.error}` });
          continue;
        }
        if (res?.incomplete) {
          log('❌', `${o.objType}: read incomplete (${res.incomplete.got} of ${res.incomplete.expected} rows) — rollback for ${o.objType} is refused rather than acted on a partial picture.`, 'ds-prog-err');
          plan.push({ leg, ...o, refused: `read incomplete — ${res.incomplete.got} of ${res.incomplete.expected} rows arrived` });
          continue;
        }
        const nowRows = res.records || [];
        const before = sftkUndoCapture(o.rows, Number.MAX_SAFE_INTEGER);
        const diff = sftkUndoDiff(before, nowRows);
        const scoped = sftkUndoScopeByTime(diff, nowRows, legEnd);
        // Person Account contacts are Salesforce's own: they cannot be deleted
        // on their own and go with their Account (live rollback 2026-09-22:
        // "Contact · 2 failed" that were nothing of the kind).
        let personSkipped = 0; let personIds = [];
        if (o.objType === 'Contact' && scoped.created.length) {
          const pa = new Set(nowRows.filter(r => r && r.IsPersonAccount === true).map(r => r.Id));
          if (pa.size) { const keep = scoped.created.filter(id => !pa.has(id)); personIds = scoped.created.filter(id => pa.has(id)); personSkipped = personIds.length; scoped.created = keep; }
          if (personSkipped) log('👤', `Contact: ${personSkipped.toLocaleString()} person-account contact(s) go with their Account — not deleted on their own.`);
        }
        const p = sftkUndoPlan(diff);
        // The page names records: the current rows by id (created / kept /
        // left alone) and the before-image by id (restore / deleted since).
        const nowById = new Map(); for (const r of nowRows) if (r && r.Id) nowById.set(r.Id, r);
        const item = { leg, ...o, before, diff, scoped, p, runEndedAt: legEnd, nowCount: nowRows.length, nowById, personIds,
          kept: 0, keptForChildren: 0, cascadeNotes: [], cascadeUnknown: [], cascadeUnchecked: [], keptIds: [], personSkipped };
        // What hangs under the records we would delete? Deleting a parent
        // cascade-deletes its children — including ones someone added AFTER
        // the run, which the plan promises to leave alone. Those parents are
        // KEPT. Unknown fails closed: a child object we cannot read, or a
        // parent we could not even describe, keeps every created parent.
        const desc = descs[o.objType];
        const cascadeKnown = !!(desc && Array.isArray(desc.childRelationships));
        const rels = cascadeKnown ? sftkUndoCascadeChildren(desc) : [];
        if (scoped.created.length && !cascadeKnown) {
          item.cascadeUnknown.push(`${o.objType} could not be described`);
          item.kept = scoped.created.length;
          item.keptIds = scoped.created.slice();
          scoped.created = [];
          log('⚠', `${o.objType}: ${item.kept.toLocaleString()} created record(s) KEPT — the object could not be described, so what hangs under them is unknown.`, 'ds-prog-warn');
        } else if (scoped.created.length && rels.length) {
          log('🔎', `Checking what hangs under the ${scoped.created.length.toLocaleString()} ${o.objType} to delete — ${rels.length} child object(s), ≈${rels.length} API call(s)…`);
          const createdSet = new Set(scoped.created);
          const kept = new Set();
          for (const rel of rels) {
            const where = `${rel.field} != null${sinceIso ? ` AND CreatedDate > ${sinceIso}` : ''}`;
            const r = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: leg.orgUrl, sid: leg.sid,
              query: `SELECT Id, ${rel.field} FROM ${rel.childSObject} WHERE ${where}` });
            if (r?.error || r?.incomplete) {
              // A child object Salesforce itself refuses to query this way
              // (ActionableListMember: "Implementation restriction: … filter
              // using ActionableListId", live rollback 2026-09-22) cannot hide
              // a person's work under a record this run created — it is said,
              // and it does not keep the parents. Anything else stays unknown.
              const msg = String(r?.error || 'incomplete read');
              // "can not be filtered" (Salesforce's spelling) and an HTTP 400 that
              // echoes our own `… AND CreatedDate >` query are the same thing:
              // the object refuses THIS filter, not a read failure — unchecked,
              // not unknown (live 2026-10-02: CaseHistory2).
              if (/Implementation restriction|not supported|INVALID_TYPE|is not supported|cannot be filtered|can not be filtered|entity type .* does not support query|HTTP 400: \w+ WHERE \w+ != null AND CreatedDate >/i.test(msg)) item.cascadeUnchecked.push(rel.childSObject);
              else item.cascadeUnknown.push(`${rel.childSObject}: ${msg.slice(0, 90)}`);
              continue;
            }
            let hit = 0;
            for (const row of (r.records || [])) { const pid = row && row[rel.field]; if (pid && createdSet.has(pid)) { kept.add(pid); hit++; } }
            if (hit) item.cascadeNotes.push(`${hit.toLocaleString()} ${rel.childSObject}`);
          }
          if (!alive()) return null;
          item.keptForChildren = kept.size;
          if (item.cascadeUnknown.length) { for (const id of createdSet) kept.add(id); }
          if (kept.size) {
            item.kept = kept.size;
            item.keptIds = [...kept];
            scoped.created = scoped.created.filter(id => !kept.has(id));
            log('⚠', `${o.objType}: ${kept.size.toLocaleString()} created record(s) KEPT — ${item.cascadeUnknown.length
              ? `could not check what hangs under them (${item.cascadeUnknown.join(', ')})`
              : `other records were added under them after the run (${item.cascadeNotes.join(', ')}) and would be deleted with them`}.`, 'ds-prog-warn');
          }
        }
        if (scoped.created.length || scoped.changed.length) anyWork = true;
        plan.push(item);
        log('📋', `${o.objType}: ${scoped.created.length.toLocaleString()} not in the restore point → delete · ${scoped.changed.length.toLocaleString()} overwritten → restore`
          + `${scoped.createdLater ? ` · ${scoped.createdLater.toLocaleString()} created after the run → left alone` : ''}`
          + `${scoped.changedLater ? ` · ${scoped.changedLater.toLocaleString()} edited after the run → left alone` : ''}`
          + `${p.goneCount ? ` · ${p.goneCount.toLocaleString()} deleted since → not restored here` : ''} · ${p.unchanged.toLocaleString()} untouched`);
      }
    }
  } catch (e) {
    log('❌', `The rollback stopped before writing anything: ${e?.message || e}`, 'ds-prog-err');
    return null;
  }
  // Keys: the same root object appears in both the target and the source leg
  // of a Reconcile pull / ← update — one result object per leg AND object.
  const multiLeg = legs.length > 1;
  for (const it of plan) it.key = multiLeg ? `${it.objType} @ ${orgLabel(it.leg.orgUrl)}` : it.objType;
  const prodLeg = legs.find(l => cachedOrgType(l.orgUrl) === 'production') || legs.find(l => prodUnknown.includes(l.orgUrl)) || legs[0];
  const typedWord = prod ? orgLabel(prodLeg.orgUrl) : 'ROLLBACK';
  // Parents kept only because a child object could not be READ are the
  // user's call: the page offers "delete anyway — I checked" per record.
  const forceable = plan.some(it => !it.refused && it.keptIds && it.keptIds.length && it.cascadeUnknown && it.cascadeUnknown.length);
  return { ...loaded, legs, plan, anyWork, forceable, prod, prodUnknown, prodLeg, typedWord, evLegs };
}

// Step 4 — deletes first (children before parents), then restores, then the
// verification read of exactly the records acted on. `picks` narrows the plan:
// { [item.key]: { del: Set<id>, res: Set<id>, force: Set<id> } }; null = all.
// Every count comes from Salesforce's own per-record answer; a slice that got
// no per-record answer is UNCONFIRMED, never assumed either way.
async function sftkUndoExecute(ctx, picks, io) {
  const { run, ev, legs, plan, siblings } = ctx;
  const log = (icon, msg, cls = '') => { try { io.log(icon, msg, cls); } catch (_) {} };
  const progress = evt => { try { if (io.progress) io.progress(evt); } catch (_) {} };
  if (_sftkUndoBusy) { showToast('A rollback is already in progress — let it finish first.', 'warning', 4000); return { status: 'busy' }; }
  const token = ++_sftkUndoSeq;
  _sftkUndoBusy = token;
  const withDates = fields => [...(fields || []), 'CreatedDate', 'LastModifiedDate'];
  const label = (item, id) => sftkUndoRowLabel(item.nowById && item.nowById.get(id)) || sftkUndoRowLabel(item.before && item.before.byId && item.before.byId[id]) || id;

  // What this execution acts on, per item — the plan is never mutated.
  const work = plan.map(item => {
    if (item.refused) return { item, created: [], changed: [], forced: 0 };
    const pick = picks && picks[item.key];
    let created = pick ? item.scoped.created.filter(id => pick.del && pick.del.has(id)) : item.scoped.created.slice();
    const forcedIds = pick && pick.force ? (item.keptIds || []).filter(id => pick.force.has(id)) : [];
    if (forcedIds.length) created = created.concat(forcedIds);
    const changed = pick ? item.scoped.changed.filter(c => pick.res && pick.res.has(c.id)) : item.scoped.changed.slice();
    return { item, created, changed, forced: forcedIds.length };
  });
  if (!work.some(w => w.created.length || w.changed.length)) { _sftkUndoBusy = null; showToast('Nothing selected to roll back.', 'warning', 3500); return { status: 'nothing' }; }

  // The rollback's own History entry — written on success AND on a failure
  // half-way, so what happened is never lost.
  const record = (results, errors, status, startedAt) => {
    const now = new Date().toISOString();
    const entry = {
      id: genId('run'), kind: 'rollback',
      profileId: run.profileId, profileName: `↩ Rollback of ${run.profileName || ev.profileName || 'run'}`,
      rolledBackRunId: run.id, sequenceId: run.sequenceId,
      srcOrgUrl: run.srcOrgUrl || run.sourceOrg, sourceOrg: run.sourceOrg || run.srcOrgUrl,
      tgtOrgUrl: run.tgtOrgUrl || run.targetOrg || legs[0].orgUrl, targetOrg: run.targetOrg || run.tgtOrgUrl || legs[0].orgUrl,
      startedAt, completedAt: now, status,
      summary: sftkUndoResultSummary(results), errors,
    };
    _history.push(entry);
    for (const h of siblings) {
      if (status === 'success') { h.undo.rolledBackAt = now; h.undo.rolledBackStatus = status; }
      else { h.undo.lastRollbackStatus = status; h.undo.lastRollbackAt = now; }
    }
    return entry;
  };

  window._sftkModalLock = true;
  const startedAt = new Date().toISOString();
  const results = {}; const errors = [];
  const errMsg = x => ((x && x.errors) || []).map(e => e.message || e.statusCode || String(e)).join('; ') || 'refused';
  const SLICE = 200;   // the Collections API hard cap — one call per slice, contained per slice
  let entry = null;
  try {
    for (const w of work) {
      const { item } = w;
      const key = item.key;
      // `r` is ALWAYS the stored object: a detached copy would absorb the
      // counters and let a refused second leg report 'success'.
      const r = results[key] || (results[key] = { deleted: 0, deleteFailed: 0, restored: 0, restoreFailed: 0,
        unconfirmed: 0, remaining: null, leftAlone: 0, stillGone: 0, goneHard: false, failedRecords: [], deletedRecords: [], restoredRecords: [], orgUrl: item.leg.orgUrl });
      if (item.refused) { errors.push(`${key}: refused — ${item.refused}`); continue; }
      const { leg } = item;
      const permanent = item.undeletable === false;
      if (w.created.length) {
        log('🗑', `Deleting ${w.created.length.toLocaleString()} ${item.objType} created by the run${w.forced ? ` (${w.forced} of them "delete anyway")` : ''}${permanent ? ' — PERMANENTLY, this object has no Recycle Bin' : ' — to the Recycle Bin'}, ${Math.ceil(w.created.length / SLICE)} call(s) of ${SLICE}…`);
        progress({ phase: 'fetched', obj: `🗑 ${item.objType}`, count: w.created.length });
        for (let i = 0; i < w.created.length; i += SLICE) {
          const slice = w.created.slice(i, i + SLICE);
          try {
            // verified-by: the VERIFY re-read further down this same item
            // loop (SF_QUERY_ALL + sftkUndoDiff/sftkUndoVerifyCounts) re-reads
            // this object and reports r.remaining.
            const res = await sendBg({ type: 'SF_COLLECTIONS_DELETE', orgUrl: leg.orgUrl, sid: leg.sid, ids: slice });
            if (res?.error) throw new Error(res.error);
            if (!Array.isArray(res)) throw new Error('no per-record answer');
            for (const x of res) {
              if (x.success) { r.deleted++; if (r.deletedRecords.length < 5000) r.deletedRecords.push({ id: x.id, name: label(item, x.id) }); continue; }
              r.deleteFailed++;
              if (r.failedRecords.length < 200) r.failedRecords.push({ id: x.id, label: label(item, x.id), error: errMsg(x), op: 'delete' });
              errors.push(`${key}: delete ${x.id || ''} — ${errMsg(x)}`);
            }
          } catch (e) {
            // A thrown slice may or may not have been applied server-side:
            // UNCONFIRMED, counted as not done, named per record.
            r.deleteFailed += slice.length; r.unconfirmed += slice.length;
            const msg = `no per-record answer — outcome unconfirmed (${e?.message || e})`;
            for (const id of slice) if (r.failedRecords.length < 200) r.failedRecords.push({ id, label: label(item, id), error: msg, op: 'delete' });
            errors.push(`${key}: delete of ${slice.length} record(s) unconfirmed — ${e?.message || e}`);
            log('❌', `${item.objType}: a delete of ${slice.length} record(s) got no per-record answer (${e?.message || e}) — outcome unconfirmed; the verification read below tells.`, 'ds-prog-err');
          }
          progress({ phase: 'batch', obj: `🗑 ${item.objType}`, done: Math.min(i + SLICE, w.created.length), total: w.created.length, created: r.deleted, failed: r.deleteFailed, okWord: 'deleted' });
        }
        log(r.deleteFailed ? '⚠' : '✅', `${item.objType}: ${r.deleted.toLocaleString()} deleted${r.deleteFailed ? `, ${r.deleteFailed.toLocaleString()} not confirmed` : ''}`, r.deleteFailed ? 'ds-prog-warn' : '');
      }
      if (w.changed.length) {
        const payload = sftkUndoRestorePayload(item.objType, w.changed);
        log('↩', `Restoring ${payload.length.toLocaleString()} ${item.objType} to their values from the restore point, ${Math.ceil(payload.length / SLICE)} call(s) of ${SLICE}…`);
        progress({ phase: 'fetched', obj: `↩ ${item.objType}`, count: payload.length });
        const fieldsOf = new Map(w.changed.map(c => [c.id, c.fields || []]));
        for (let i = 0; i < payload.length; i += SLICE) {
          const slice = payload.slice(i, i + SLICE);
          try {
            // verified-by: the same VERIFY re-read further down this item loop.
            const res = await sendBg({ type: 'SF_COLLECTIONS_UPDATE', orgUrl: leg.orgUrl, sid: leg.sid, records: slice });
            if (res?.error) throw new Error(res.error);
            if (!Array.isArray(res)) throw new Error('no per-record answer');
            for (const x of res) {
              if (x.success) { r.restored++; if (r.restoredRecords.length < 5000) r.restoredRecords.push({ id: x.id, name: label(item, x.id), fields: fieldsOf.get(x.id) || [] }); continue; }
              r.restoreFailed++;
              if (r.failedRecords.length < 200) r.failedRecords.push({ id: x.id, label: label(item, x.id), error: errMsg(x), op: 'restore' });
              errors.push(`${key}: restore ${x.id || ''} — ${errMsg(x)}`);
            }
          } catch (e) {
            r.restoreFailed += slice.length; r.unconfirmed += slice.length;
            const msg = `no per-record answer — outcome unconfirmed (${e?.message || e})`;
            for (const rec of slice) if (r.failedRecords.length < 200) r.failedRecords.push({ id: rec.Id, label: label(item, rec.Id), error: msg, op: 'restore' });
            errors.push(`${key}: restore of ${slice.length} record(s) unconfirmed — ${e?.message || e}`);
            log('❌', `${item.objType}: a restore of ${slice.length} record(s) got no per-record answer (${e?.message || e}) — outcome unconfirmed; the verification read below tells.`, 'ds-prog-err');
          }
          progress({ phase: 'batch', obj: `↩ ${item.objType}`, done: Math.min(i + SLICE, payload.length), total: payload.length, created: r.restored, failed: r.restoreFailed, okWord: 'restored' });
        }
        log(r.restoreFailed ? '⚠' : '✅', `${item.objType}: ${r.restored.toLocaleString()} restored${r.restoreFailed ? `, ${r.restoreFailed.toLocaleString()} not confirmed` : ''}`, r.restoreFailed ? 'ds-prog-warn' : '');
      }
      // VERIFY — re-read and compare again, judged on exactly the records
      // the rollback acted on (a restored record now carries a fresh
      // LastModifiedDate, so the "edited after the run" filter must NOT
      // apply to it). Quoted first, like every other read.
      const vq = sftkUndoReadQuote(item.nowCount);
      log('🔍', `Verifying ${item.objType}: re-reading ≈${item.nowCount.toLocaleString()} rows in ${orgLabel(leg.orgUrl)} (≈${vq.calls} API call(s))…`);
      try {
        const res = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: leg.orgUrl, sid: leg.sid,
          query: sftkUndoSnapshotSoql(item.objType, withDates(item.fields)) });
        if (res && !res.error && !res.incomplete) {
          const d2 = sftkUndoDiff(item.before, res.records || []);
          const acted = new Set([...w.created, ...w.changed.map(c => c.id)]);
          const v = sftkUndoVerifyCounts(d2, acted);
          r.remaining = v.remaining; r.leftAlone = v.leftAlone;
          // Records the RUN deleted are still gone — a rollback restores
          // values, it cannot re-create identity. Said, never folded into "verified".
          r.stillGone = (d2.deleted || []).length;
          r.goneHard = !!(run.summary && run.summary[item.objType] && run.summary[item.objType].deleteMode === 'hard');
        }
      } catch (_) { /* remaining stays null → UNVERIFIED */ }
      log(r.remaining === 0 ? '✅' : '⚠', sftkUndoVerifyLine(item.objType, r.remaining, r.leftAlone, r.stillGone, r.goneHard), r.remaining === 0 ? '' : 'ds-prog-warn');
    }
    const status = sftkUndoRunStatus(results);
    entry = record(results, errors, status, startedAt);
    recordActivity?.('transfer');
    await _sftkUndoPersist(siblings);
    const gone = Object.values(results).reduce((n, r) => n + (r.stillGone || 0), 0);
    const tail = gone ? ` ${gone.toLocaleString()} record(s) the run deleted are still gone — ${Object.values(results).some(r => r.goneHard) ? 'hard-deleted, permanently' : 'in the Recycle Bin; restore them there within 15 days'}.` : '';
    log(status === 'success' ? '🏁' : '⚠', status === 'success'
      ? `Rollback complete — everything it acted on is verified; recorded in History.${tail}`
      : `Rollback finished with status "${status}" — see the lines above. It is recorded in History; ↩ Roll back stays available to try again once the refusal is sorted.${tail}`, status === 'success' ? '' : 'ds-prog-warn');
    showToast(status === 'success' ? (gone ? '✅ Rollback complete and verified — see the note about deleted records' : '✅ Rollback complete and verified') : `⚠ Rollback ${status} — see the page`, status === 'success' ? 'success' : 'warning', 6000);
    progress({ phase: 'end' });
    return { status, results, errors, entry, startedAt };
  } catch (e) {
    // A failure half-way is still a fact worth a History entry.
    errors.push(`stopped: ${e?.message || e}`);
    log('❌', `The rollback stopped: ${e?.message || e} — what was written before this is recorded in History; check the org before trying again.`, 'ds-prog-err');
    try { entry = record(results, errors, 'failed', startedAt); await _sftkUndoPersist(siblings); } catch (_) { /* nothing more to do */ }
    progress({ phase: 'end' });
    return { status: 'failed', results, errors, entry, startedAt };
  } finally {
    window._sftkModalLock = false;
    if (_sftkUndoBusy === token) _sftkUndoBusy = null;
    if (typeof _currentView !== 'undefined' && _currentView === 'history' && typeof renderHistory === 'function') renderHistory();
  }
}

// The History card's ↩ button — the page in studio-rollback.js takes it from here.
window.rollbackRun = function(runId) {
  if (typeof window.openRollback === 'function') return window.openRollback(runId);
  showToast('The rollback page is not loaded.', 'error', 4000);
};
