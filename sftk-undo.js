'use strict';
// ═════════════════════════════════════════════════════════════════════════
// sftk-undo.js — rollback for data deployments.
// ═════════════════════════════════════════════════════════════════════════
// User request 2026-08-26: "Can we also add rollback feature for data
// deployment? ... I think it might help us with production issues."
//
// HOW IT WORKS, AND WHY THIS WAY
// Before a run writes anything, the caller takes a BEFORE-IMAGE of each
// object in each target: every record's Id plus the fields the run is
// allowed to touch. Rolling back is then a comparison against that image:
//
//   · a record whose Id is NOT in the image was CREATED by the run   → delete it
//   · a record whose Id IS in the image may have been OVERWRITTEN    → restore it
//   · a record in the image that is now GONE was deleted by the run  → see below
//
// The engine already knows how many rows it created versus updated, but it
// throws away WHICH — idPairs is root-only, capped at 2000, and the Studio
// deletes it after feeding match-memory. So rollback cannot be built on the
// run's own report; it needs its own evidence, taken before the fact.
//
// WHAT ROLLBACK IS NOT
// Restoring records is not undoing consequences. Triggers, flows and
// workflow rules that fired during the run already sent their emails,
// created their child records and recalculated their roll-ups. Deleting a
// record does not unsend anything. Everything here is built so the UI can
// say that plainly instead of implying a clean reversal — which is why
// sftkUndoLimits() exists and is rendered, not buried.
//
// Classic script, top-level column-0 pure functions (test/extract.mjs).

// One run's captured evidence, capped. A before-image of a large object is
// genuinely big, and silently keeping half of one would produce a rollback
// that silently restores half an object — far worse than refusing.
function sftkUndoMaxRows() { return 50000; }
function sftkUndoMaxRuns() { return 10; }

// Which fields are worth capturing: what the run could actually overwrite.
// Capturing more would bloat the snapshot; capturing less would restore an
// incomplete record and call it restored.
function sftkUndoFields(describe) {
  return ((describe && describe.fields) || [])
    .filter(f => f && f.updateable && !f.calculated
      // Compound fields are written through their parts; a base64 body comes
      // back as a URL; an encrypted (classic) field reads back MASKED - writing
      // any of those back would restore garbage and call it restored.
      && !/^(address|base64|location|encryptedstring)$/.test(String(f.type || ''))
      && !/^(OwnerId|CreatedById|LastModifiedById|IsDeleted)$/.test(f.name))
    .map(f => f.name);
}

// The SOQL for a before-image. Id is always first — it IS the identity the
// whole comparison turns on.
function sftkUndoSnapshotSoql(objType, fields) {
  const cols = ['Id', ...(fields || [])];
  return `SELECT ${[...new Set(cols)].join(', ')} FROM ${objType}`;
}

// Turn the rows read before a run into the stored image.
// Returns { rows, byId, count, truncated } — truncated is a REFUSAL, not a
// silent cap: a partial image cannot support an honest rollback.
function sftkUndoCapture(rows, maxRows) {
  const cap = Number(maxRows) > 0 ? Number(maxRows) : 50000;
  const list = (rows || []).filter(r => r && r.Id);
  if (list.length > cap) {
    return { rows: [], byId: {}, count: list.length, truncated: true };
  }
  const byId = {};
  for (const r of list) byId[r.Id] = r;
  return { rows: list, byId, count: list.length, truncated: false };
}

// The heart of it: compare the world now against the image taken before.
// before: { byId } from sftkUndoCapture · after: rows read now
// Returns { created: [id], changed: [{id, before, fields:[names]}],
//           deleted: [id], unchanged }
function sftkUndoDiff(before, afterRows) {
  const byId = (before && before.byId) || {};
  const seen = new Set();
  const out = { created: [], changed: [], deleted: [], unchanged: 0 };
  for (const now of (afterRows || [])) {
    if (!now || !now.Id) continue;
    seen.add(now.Id);
    const was = byId[now.Id];
    if (!was) { out.created.push(now.Id); continue; }
    const fields = [];
    for (const k of Object.keys(was)) {
      if (k === 'Id' || k === 'attributes') continue;
      const a = was[k] == null ? '' : String(was[k]);
      const b = now[k] === undefined ? a : (now[k] == null ? '' : String(now[k]));
      if (a !== b) fields.push(k);
    }
    if (fields.length) out.changed.push({ id: now.Id, before: was, fields });
    else out.unchanged++;
  }
  for (const id of Object.keys(byId)) if (!seen.has(id)) out.deleted.push(id);
  return out;
}

// The payload that puts the old values back. Only the fields that actually
// differ are written: rewriting an untouched field would bump its audit
// trail and could trip an update-triggered automation for no reason.
function sftkUndoRestorePayload(objType, changed) {
  const out = [];
  for (const c of (changed || [])) {
    if (!c || !c.id) continue;
    const rec = { attributes: { type: objType }, Id: c.id };
    // A Person Account's Name is derived from its parts and refuses a write —
    // the parts (FirstName, LastName, …) restore it. The flag itself is a
    // read-only marker captured alongside the fields, never written back.
    const personAccount = !!(c.before && c.before.IsPersonAccount === true);
    for (const f of (c.fields || [])) {
      if (f === 'Id' || f === 'attributes' || f === 'IsPersonAccount') continue;
      if (personAccount && f === 'Name') continue;
      rec[f] = c.before ? (c.before[f] === undefined ? null : c.before[f]) : null;
    }
    if (Object.keys(rec).length > 2) out.push(rec);
  }
  return out;
}

// What a rollback of THIS diff would do, in words, before it does it.
function sftkUndoPlan(diff) {
  const d = diff || {};
  return {
    toDelete: (d.created || []).length,
    toRestore: (d.changed || []).length,
    goneCount: (d.deleted || []).length,
    unchanged: d.unchanged || 0,
    // A record the run DELETED cannot be put back by writing values: a
    // re-insert would mint a new Id and every lookup pointing at the old
    // one would still be broken. The Recycle Bin is the only route that
    // preserves identity, and only for a soft delete inside 15 days.
    goneNeedsRecycleBin: (d.deleted || []).length > 0,
  };
}

// The things a rollback cannot undo. Rendered, never buried — a "rolled
// back successfully" that leaves the user believing the blast radius was
// reversed is exactly the lie this project forbids.
function sftkUndoLimits() {
  return [
    'Automation that already ran is NOT undone. Emails sent by a trigger, flow or workflow rule stay sent; records those created stay created; roll-ups they recalculated are recalculated again by the rollback itself.',
    'Records the run HARD-DELETED are gone permanently. No snapshot can bring them back.',
    'Records the run soft-deleted can only keep their original Ids if they are restored from the Recycle Bin, within 15 days. Re-inserting them instead mints new Ids and leaves every lookup that pointed at them broken.',
    'Files (ContentVersion) copied by the run are NOT covered — the rollback only touches the record objects in the deployment tree. Remove copied files in the target by hand.',
    'Owner changes are not restored: OwnerId is not captured, because re-assigning owners re-fires assignment rules and sharing recalculation.',
    'Records the run’s AUTOMATION created (a flow that adds a task per new account, for example) are not in the deployment tree and are not deleted.',
    'Records other people CREATED after the run finished are left alone, and so are records the run changed that someone EDITED after it finished. A record the run itself created is deleted even if someone edited it afterwards — their edits go with it. Anything anyone created or edited BETWEEN the restore point and the end of the run cannot be told apart from the run’s own writes and is included.',
    'Deleting a record deletes what hangs under it (its master-detail children and cascading lookups). Children added after the run protect their parent — that parent is kept — but children created DURING the run, by the run’s automation or by anyone else, go with it.',
    'Objects that have no Recycle Bin (Salesforce reports them as not undeletable) are deleted PERMANENTLY by a rollback; the plan marks them in red before you confirm.',
    'Metadata the run deployed (Flows, Custom Metadata, Custom Settings, Labels) is not data and is not covered here — a Flow deploy created a new version, which has to be rolled back by re-activating the previous one.',
    'The rollback is itself a write. It fires the target’s automation again, and it can be REJECTED by validation rules, duplicate rules or a before-save flow — anything it could not restore is listed rather than assumed done.',
  ];
}

// Everything that reacts to a write on these objects. Queries are returned
// rather than run, so the caller can quote the cost first and so a failure
// in one category leaves THAT category UNKNOWN instead of reporting "none".
//
// The split that matters is not "what kind of automation is it" but "what
// will it do to me":
//   · BLOCKING  — can reject the write, so it can make a rollback FAIL
//                 half-way and leave the target in a third state that is
//                 neither before nor after. Validation rules, duplicate
//                 rules, before-save flows, before triggers.
//   · SIDE-EFFECT — already ran during the original run and cannot be
//                 unrun. After-save flows, after triggers, workflow rules.
// (user 2026-08-26: "Should also look for validation rules, flow
// validations, dupe records".)
// Returns [{ key, label, kind, tooling, soql }]
function sftkUndoAutomationQueries(objectApiNames) {
  const objs = [...new Set((objectApiNames || []).filter(Boolean))];
  if (!objs.length) return [];
  const lit = objs.map(o => `'${String(o).replace(/'/g, "\\'")}'`).join(',');
  return [
    { key: 'validation', label: 'Validation rules', kind: 'blocking', tooling: true,
      soql: `SELECT ValidationName, EntityDefinition.QualifiedApiName, Active FROM ValidationRule WHERE EntityDefinition.QualifiedApiName IN (${lit})` },
    // Duplicate rules reject a write outright with DUPLICATES_DETECTED.
    // They are the quietest reason a restore half-completes.
    { key: 'duplicate', label: 'Duplicate rules', kind: 'blocking', tooling: false,
      soql: `SELECT DeveloperName, MasterLabel, SobjectType, IsActive FROM DuplicateRule WHERE SobjectType IN (${lit})` },
    { key: 'triggers', label: 'Apex triggers', kind: 'both', tooling: true,
      soql: `SELECT Name, TableEnumOrId, Status FROM ApexTrigger WHERE TableEnumOrId IN (${lit})` },
    // FlowDefinitionView exposes the trigger OBJECT and TYPE, so before-save
    // flows (which can raise a custom error and reject the write) can be
    // told apart from after-save ones (which cannot).
    { key: 'flows', label: 'Record-triggered flows', kind: 'both', tooling: false,
      soql: 'SELECT ApiName, Label, ProcessType, TriggerType, TriggerObjectOrEventLabel'
        + ' FROM FlowDefinitionView WHERE IsActive = true' },
    { key: 'workflow', label: 'Workflow rules', kind: 'side-effect', tooling: true,
      soql: `SELECT Name, TableEnumOrId FROM WorkflowRule WHERE TableEnumOrId IN (${lit})` },
  ];
}

// Is this flow one that can REJECT a write? Before-save and before-delete
// flows can raise a custom error; after-save ones cannot.
function sftkUndoFlowBlocks(triggerType) {
  return /RecordBeforeSave|RecordBeforeDelete/i.test(String(triggerType || ''));
}

// Fold the automation answers into something renderable, split by what it
// does to you. A category that ERRORED is UNKNOWN — never folded in as
// zero, because "no duplicate rules" and "could not check for duplicate
// rules" are different facts and only one of them is reassuring.
// results: { key: { rows: [...] } | { error: '...' }
// labels:  { objType: 'Object Label' } — FlowDefinitionView names its object by
//          LABEL, not API name, so a custom or multi-word object would never
//          match without it. An object with no label is reported UNKNOWN.
function sftkUndoAutomationSummary(results, objectApiNames, labels) {
  const names = (objectApiNames || []).filter(Boolean);
  const objs = new Set(names.map(o => String(o).toLowerCase()));
  for (const o of names) if (labels && labels[o]) objs.add(String(labels[o]).toLowerCase());
  const out = { blocking: [], sideEffects: [], unknown: [], blockingCount: 0, sideEffectCount: 0 };
  for (const q of sftkUndoAutomationQueries(objectApiNames)) {
    const r = (results || {})[q.key];
    if (!r || r.error) {
      out.unknown.push({ key: q.key, label: q.label, why: (r && r.error) || 'not checked' });
      continue;
    }
    let rows = r.rows || [];
    if (q.key === 'triggers') rows = rows.filter(t => t && t.Status === 'Active');
    if (q.key === 'validation') rows = rows.filter(v => v && v.Active !== false);
    if (q.key === 'duplicate') rows = rows.filter(d => d && d.IsActive !== false);
    if (q.key === 'flows') {
      // The view exposes a LABEL, not an api name, so the object match is
      // narrowed here — and only kept on a real match, never a fuzzy guess.
      rows = rows.filter(f => f && /^Record/i.test(String(f.TriggerType || ''))
        && objs.has(String(f.TriggerObjectOrEventLabel || '').toLowerCase()));
      const blocks = rows.filter(f => sftkUndoFlowBlocks(f.TriggerType));
      const after = rows.filter(f => !sftkUndoFlowBlocks(f.TriggerType));
      if (blocks.length) {
        out.blocking.push({ key: 'flows-before', label: 'Before-save flows (can reject the write)',
          count: blocks.length, rows: blocks.slice(0, 25) });
        out.blockingCount += blocks.length;
      }
      if (after.length) {
        out.sideEffects.push({ key: 'flows-after', label: 'After-save flows (already ran)',
          count: after.length, rows: after.slice(0, 25) });
        out.sideEffectCount += after.length;
      }
      if (labels) {
        const missing = names.filter(o => !labels[o]);
        if (missing.length) out.unknown.push({ key: 'flows-label', label: `Record-triggered flows on ${missing.join(', ')}`,
          why: 'object label unknown — flows are listed by label, so they could not be matched' });
      }
      continue;
    }
    if (!rows.length) continue;
    const entry = { key: q.key, label: q.label, count: rows.length, rows: rows.slice(0, 25) };
    // A trigger can be either; it is listed on both sides because we cannot
    // tell from its name which contexts it implements, and guessing wrong
    // in the reassuring direction is the one that hurts.
    if (q.kind === 'blocking' || q.kind === 'both') { out.blocking.push(entry); out.blockingCount += rows.length; }
    if (q.kind === 'side-effect' || q.kind === 'both') { out.sideEffects.push(entry); out.sideEffectCount += rows.length; }
  }
  return out;
}

// Keep the newest N runs' evidence. Oldest goes first; what was dropped is
// returned so the UI can say a run is no longer rollback-able rather than
// letting the button quietly vanish.
function sftkUndoPrune(store, maxRuns) {
  const cap = Number(maxRuns) > 0 ? Number(maxRuns) : 10;
  const entries = Object.entries(store || {}).filter(([, v]) => v && v.capturedAt);
  // A fan-out (one restore point per target) counts as ONE run: its points
  // share a groupId and are kept or dropped together, ranked by the newest
  // capture in the group. A point without a groupId is its own group.
  const groups = {};
  for (const [k, v] of entries) {
    const g = (v.groupId !== undefined && v.groupId !== null && v.groupId !== '') ? `g:${v.groupId}` : `i:${k}`;
    const grp = groups[g] || (groups[g] = { newest: '', ids: [] });
    grp.ids.push(k);
    if (String(v.capturedAt) > grp.newest) grp.newest = String(v.capturedAt);
  }
  const ordered = Object.values(groups).sort((a, b) => b.newest.localeCompare(a.newest));
  const kept = {}; const dropped = [];
  ordered.forEach((grp, i) => { for (const k of grp.ids) { if (i < cap) kept[k] = store[k]; else dropped.push(k); } });
  return { kept, dropped };
}

// ── Wiring helpers (pure) — used by studio-undo.js ──────────────────────

// Which objects a run can write, DEEPEST FIRST — a rollback deletes created
// children before the parents they point at (a restrict-delete lookup would
// otherwise refuse the parent). `mode` per object says what the run could do
// there: 'insert' can only CREATE, so an Id-only image is enough; anything
// that can overwrite ('upsert', 'reconcile') needs the field values too.
// tree: the profile tree · rootMode: 'insert' | 'upsert' | 'reconcile'
function sftkUndoTreeObjects(tree, rootMode) {
  const rank = { insert: 0, upsert: 1, reconcile: 2 };
  const out = new Map();
  const walk = (node, depth) => {
    if (!node) return;
    const name = node.objectType || node.childSObject;
    if (name) {
      const nodeUpsert = !!(node.upsert && node.upsert.field);
      const mode = rootMode === 'reconcile' ? 'reconcile'
        : (nodeUpsert || (depth === 0 && rootMode === 'upsert')) ? 'upsert' : 'insert';
      const prev = out.get(name);
      out.set(name, {
        objType: name,
        depth: Math.max(depth, prev ? prev.depth : 0),
        mode: prev && rank[prev.mode] > rank[mode] ? prev.mode : mode,
      });
    }
    for (const c of (node.children || [])) walk(c, depth + 1);
  };
  walk(tree, 0);
  return [...out.values()].sort((a, b) => b.depth - a.depth || a.objType.localeCompare(b.objType));
}

// Merge the object lists of several trees (a sequence's steps) into one,
// keeping the deepest depth and the strongest mode per object.
function sftkUndoMergeObjects(lists) {
  const rank = { insert: 0, upsert: 1, reconcile: 2 };
  const out = new Map();
  for (const list of (lists || [])) {
    for (const o of (list || [])) {
      if (!o || !o.objType) continue;
      const prev = out.get(o.objType);
      if (!prev) { out.set(o.objType, { objType: o.objType, depth: o.depth || 0, mode: o.mode || 'insert' }); continue; }
      prev.depth = Math.max(prev.depth, o.depth || 0);
      if ((rank[o.mode] || 0) > (rank[prev.mode] || 0)) prev.mode = o.mode;
    }
  }
  return [...out.values()].sort((a, b) => b.depth - a.depth || a.objType.localeCompare(b.objType));
}

// Which fields to capture, given what the run can do to the object. An
// insert-only run cannot overwrite anything, so Ids alone are the image.
function sftkUndoFieldsForMode(fields, mode) {
  return mode === 'insert' ? [] : (fields || []);
}

// Row cap per mode — an Id-only row is ~40 bytes, a full row can be kilobytes.
function sftkUndoRowCap(mode) {
  return mode === 'insert' ? 250000 : sftkUndoMaxRows();
}

// What reading an image costs, stated BEFORE it is read: one COUNT() plus one
// page per 2,000 rows (Salesforce's default page; wide rows page smaller, so ≈).
function sftkUndoReadQuote(count) {
  const n = Number(count) > 0 ? Number(count) : 0;
  return { rows: n, calls: 1 + Math.ceil(n / 2000) };
}

// The small stub that rides on the History entry. The evidence itself is far
// too big for chrome.storage and lives in IndexedDB under evidenceId.
// legs: [{ orgUrl, objects: { objType: {…} }, skipped: { objType: why } }]
function sftkUndoEntryFor(evidenceId, legs, scope, capturedAt) {
  const objects = []; const skipped = {};
  for (const leg of (legs || [])) {
    for (const o of Object.keys((leg && leg.objects) || {})) if (!objects.includes(o)) objects.push(o);
    for (const [o, why] of Object.entries((leg && leg.skipped) || {})) skipped[o] = why;
  }
  const status = objects.length ? (Object.keys(skipped).length ? 'partial' : 'ready') : 'none';
  return { evidenceId: evidenceId || null, scope: scope || 'run', status, objects, skipped, capturedAt: capturedAt || null };
}

// What the History card shows for a run — ONE place, so the button can never
// silently vanish: a run without a restore point SAYS so, and why.
// PURE. Did this run write anything, by its own summary? true / false / null
// (cannot tell: no summary, an object that errored out mid-way, a write
// Salesforce never answered, or an entry without counts). Only a definite
// false may hide the rollback — unknown is not "nothing".
function sftkUndoRunWrote(run) {
  const sum = run && run.summary;
  const entries = sum && typeof sum === 'object' ? Object.entries(sum) : [];
  if (!entries.length) return null;
  const WROTE = ['created', 'inserted', 'updated', 'deleted', 'pulled', 'updatedSource',
    'overwritten', 'connected', 'relinked', 'upsertCreated', 'upsertUpdated'];
  const FAILED = ['failed', 'insertedFailed', 'updatedFailed', 'deletedFailed', 'pulledFailed',
    'updatedSourceFailed', 'connectFailed', 'relinkFailed'];
  let any = false;
  for (const [, s] of entries) {
    if (!s || typeof s !== 'object') return null;
    if (s.skipped) continue;
    if (s.error || s.notProcessed || s.unconfirmed) return null;
    if (!WROTE.some(k => k in s) && !FAILED.some(k => k in s)) return null;
    if (WROTE.some(k => Number(s[k]) > 0)) any = true;
  }
  return any;
}

function sftkUndoCardState(run) {
  const u = run && run.undo;
  if (!u) {
    // A run that wrote data but carries no stub (made before restore points
    // existed, or by a path that takes none) still SAYS so — the contract
    // is that the button never silently vanishes on a data run.
    const writes = !!(run && run.summary && Object.keys(run.summary).length
      && (run.kind === undefined || run.kind === 'reconcile'));
    return writes
      ? { show: true, disabled: true, label: '📸 no restore point',
          title: 'This run took no restore point — it was made before restore points existed, or by a path that does not take one (Org Seeder).' }
      : { show: false };
  }
  const seq = u.scope === 'sequence';
  const what = seq ? 'sequence' : 'run';
  if (u.rolledBackAt) {
    return { show: true, disabled: true, label: '↩ Rolled back',
      title: `Rolled back and verified on ${u.rolledBackAt}${seq ? ' — the whole sequence' : ''}. The rollback has its own entry in History.` };
  }
  if (u.status === 'expired') {
    return { show: true, disabled: true, label: '📸 restore point expired',
      title: 'Only the newest 10 runs keep a restore point on this PC; this one was dropped, or cached org data was cleared.' };
  }
  const why = Object.entries(u.skipped || {}).map(([o, w]) => `${o}: ${w}`).join(' · ');
  if (u.status === 'none') {
    return { show: true, disabled: true, label: '📸 no restore point',
      title: why ? `No restore point was taken before this ${what} — ${why}` : `No restore point was taken before this ${what}.` };
  }
  // A run Salesforce confirmed wrote NOTHING (every record failed, no write
  // left unanswered) has nothing to undo — say so instead of offering a
  // rollback (user 2026-09-15: "it suggested rollback when nothing was
  // written"). Any error, unconfirmed write or missing count keeps the button.
  if (sftkUndoRunWrote(run) === false) {
    return { show: true, disabled: true, label: '↩ Nothing to roll back',
      title: `Salesforce confirmed that this ${what} wrote nothing — every record failed — so there is nothing to undo. The restore point is kept.` };
  }
  const objs = (u.objects || []).join(', ');
  const again = u.lastRollbackStatus ? ` again (last attempt: ${u.lastRollbackStatus})` : '';
  const base = `Compares ${objs} in the target against the restore point taken before this ${what}, then deletes what the ${what} created and restores what it overwrote. You review the exact counts, and the automation that could reject them, before anything is written.`;
  if (u.status === 'partial') {
    return { show: true, disabled: false, label: `↩ Roll back${again} (${objs} only)`, title: `${base} NOT covered — ${why}` };
  }
  return { show: true, disabled: false, label: `↩ Roll back${seq ? ' sequence' : ''}${again}`, title: base };
}

// Leave other people's LATER work alone. A record created or edited after the
// run ended is not the run's doing; deleting or reverting it would undo
// someone else's work in the name of a rollback. runEndedAt is this PC's
// clock at the moment the run finished — a minute of tolerance covers skew.
// Returns { created:[id], createdLater, changed:[…], changedLater, filtered }
function sftkUndoScopeByTime(diff, afterRows, runEndedAt) {
  const end = runEndedAt ? Date.parse(runEndedAt) : NaN;
  const byId = {};
  for (const r of (afterRows || [])) if (r && r.Id) byId[r.Id] = r;
  const out = { created: [], createdLater: 0, changed: [], changedLater: 0, filtered: Number.isFinite(end) };
  for (const id of ((diff && diff.created) || [])) {
    const t = Date.parse((byId[id] && byId[id].CreatedDate) || '');
    if (out.filtered && Number.isFinite(t) && t > end + 60000) out.createdLater++; else out.created.push(id);
  }
  for (const c of ((diff && diff.changed) || [])) {
    const t = Date.parse((byId[c.id] && byId[c.id].LastModifiedDate) || '');
    if (out.filtered && Number.isFinite(t) && t > end + 60000) out.changedLater++; else out.changed.push(c);
  }
  return out;
}

// Per-object rollback results → the History summary shape the card already
// renders (deleted / updated / *Failed), plus what still differs after the
// verification re-read. `remaining` null = the verification read failed.
function sftkUndoResultSummary(results) {
  const out = {};
  for (const [obj, r] of Object.entries(results || {})) {
    out[obj] = {
      deleted: r.deleted || 0, deletedFailed: r.deleteFailed || 0,
      updated: r.restored || 0, updatedFailed: r.restoreFailed || 0,
      remaining: r.remaining === undefined ? null : r.remaining,
      leftAlone: r.leftAlone || 0,
      // Records the RUN deleted that are still gone — a rollback cannot
      // re-create identity; said on the card, never folded into "verified".
      stillGone: r.stillGone || 0, goneHard: !!r.goneHard,
      unconfirmed: r.unconfirmed || 0,
      // The org this entry was written in — a two-leg rollback (target + source)
      // must link its failed records into the RIGHT org.
      ...(r.orgUrl ? { orgUrl: r.orgUrl } : {}),
      ...(r.failedRecords && r.failedRecords.length ? { failedRecords: r.failedRecords.slice(0, 200) } : {}),
    };
  }
  return out;
}

// Status of a rollback run — 'success' only when nothing was refused AND the
// verification read of every object found nothing left. An unverified object
// can never be part of a success.
function sftkUndoRunStatus(results) {
  let ok = 0, failed = 0, left = 0, unverified = 0;
  for (const r of Object.values(results || {})) {
    ok += (r.deleted || 0) + (r.restored || 0);
    failed += (r.deleteFailed || 0) + (r.restoreFailed || 0);
    if (r.remaining == null) unverified++; else left += r.remaining;
  }
  if (failed === 0 && left === 0 && unverified === 0) return 'success';
  return ok > 0 ? 'partial' : 'failed';
}

// The one line a user reads after the rollback of one object. `leftAlone`
// is what the rollback deliberately did not touch (created or edited after
// the run, parents of later records) — those may still hold the run's values,
// so "verified" is scoped to what was acted on, never wider.
// `stillGone` is what the RUN deleted and this rollback could not bring back.
function sftkUndoVerifyLine(objType, remaining, leftAlone, stillGone, goneHard) {
  if (remaining == null) return `${objType}: could not re-read the object to verify — treat this rollback as UNVERIFIED.`;
  if (remaining === 0 && (leftAlone > 0 || stillGone > 0)) {
    let line = `${objType}: verified — nothing the rollback acted on remains.`;
    if (leftAlone > 0) line += ` ${leftAlone} record(s) were deliberately left alone (created or edited after the run, or parents of later records) and may still hold the run’s values.`;
    if (stillGone > 0) line += ` ${stillGone} record(s) from the restore point are still gone — ${goneHard ? 'hard-deleted by the run, permanently' : 'deleted by the run; restore them from the Recycle Bin within 15 days'}.`;
    return line;
  }
  if (remaining === 0) return `${objType}: verified — nothing from the run remains.`;
  return `${objType}: ⚠ ${remaining} record(s) still differ from the restore point — see the errors above; run the rollback again after fixing them.`;
}

// Writable fields the image cannot hold: a base64 body reads back as a URL,
// a classic encrypted field reads back masked. They are NAMED so a rollback
// can say "not restored" instead of implying it covered them.
function sftkUndoFieldsNotCovered(describe) {
  return ((describe && describe.fields) || [])
    .filter(f => f && f.updateable && !f.calculated && /^(base64|encryptedstring)$/.test(String(f.type || '')))
    .map(f => ({ name: f.name, type: f.type }));
}

// Child relationships that a delete of this object CASCADES into — the ones
// a rollback has to look under before deleting a parent. System shadows
// (feeds, history, shares, subscriptions…) are skipped: they exist only for
// their parent and hold no one's independent work.
function sftkUndoCascadeChildren(describe) {
  const skip = /(Feed|History|Share|Tag|ChangeEvent)$|^(EntitySubscription|TopicAssignment|ContentDocumentLink|FlowRecordRelation|RecordAction|CollaborationGroupRecord|Vote|ProcessInstance|ProcessInstanceHistory|DuplicateRecordItem|UserRecordAccess|EmailStatus|AttachedContentDocument|CombinedAttachment|OpenActivity|ActivityHistory|NoteAndAttachment|LookedUpFromActivity|OutgoingEmail|ProcessException|RecentlyViewed)$/;
  const out = []; const seen = new Set();
  for (const r of ((describe && describe.childRelationships) || [])) {
    if (!r || !r.cascadeDelete || !r.childSObject || !r.field) continue;
    if (skip.test(r.childSObject)) continue;
    const k = `${r.childSObject}.${r.field}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ childSObject: r.childSObject, field: r.field });
  }
  return out;
}

// A SOQL datetime literal from an ISO timestamp: YYYY-MM-DDThh:mm:ssZ.
function sftkUndoSoqlDateTime(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// After the rollback: what still differs among the records it ACTED ON
// (remaining) versus what it deliberately did not touch (leftAlone). A
// restored record carries a fresh LastModifiedDate, so the "edited after the
// run" filter would hide every restore the org rejected — the acted set is
// judged on identity alone.
function sftkUndoVerifyCounts(diff, actedIds) {
  const acted = actedIds instanceof Set ? actedIds : new Set(actedIds || []);
  let remaining = 0, leftAlone = 0;
  for (const id of ((diff && diff.created) || [])) { if (acted.has(id)) remaining++; else leftAlone++; }
  for (const c of ((diff && diff.changed) || [])) { if (c && acted.has(c.id)) remaining++; else leftAlone++; }
  return { remaining, leftAlone };
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkUndoMaxRows           = sftkUndoMaxRows;
  globalThis.sftkUndoMaxRuns           = sftkUndoMaxRuns;
  globalThis.sftkUndoFields            = sftkUndoFields;
  globalThis.sftkUndoSnapshotSoql      = sftkUndoSnapshotSoql;
  globalThis.sftkUndoCapture           = sftkUndoCapture;
  globalThis.sftkUndoDiff              = sftkUndoDiff;
  globalThis.sftkUndoRestorePayload    = sftkUndoRestorePayload;
  globalThis.sftkUndoPlan              = sftkUndoPlan;
  globalThis.sftkUndoLimits            = sftkUndoLimits;
  globalThis.sftkUndoAutomationQueries = sftkUndoAutomationQueries;
  globalThis.sftkUndoFlowBlocks        = sftkUndoFlowBlocks;
  globalThis.sftkUndoAutomationSummary = sftkUndoAutomationSummary;
  globalThis.sftkUndoPrune             = sftkUndoPrune;
  globalThis.sftkUndoTreeObjects       = sftkUndoTreeObjects;
  globalThis.sftkUndoMergeObjects      = sftkUndoMergeObjects;
  globalThis.sftkUndoFieldsForMode     = sftkUndoFieldsForMode;
  globalThis.sftkUndoRowCap            = sftkUndoRowCap;
  globalThis.sftkUndoReadQuote         = sftkUndoReadQuote;
  globalThis.sftkUndoEntryFor          = sftkUndoEntryFor;
  globalThis.sftkUndoCardState         = sftkUndoCardState;
  globalThis.sftkUndoScopeByTime       = sftkUndoScopeByTime;
  globalThis.sftkUndoResultSummary     = sftkUndoResultSummary;
  globalThis.sftkUndoRunStatus         = sftkUndoRunStatus;
  globalThis.sftkUndoVerifyLine        = sftkUndoVerifyLine;
  globalThis.sftkUndoFieldsNotCovered  = sftkUndoFieldsNotCovered;
  globalThis.sftkUndoCascadeChildren   = sftkUndoCascadeChildren;
  globalThis.sftkUndoSoqlDateTime      = sftkUndoSoqlDateTime;
  globalThis.sftkUndoVerifyCounts      = sftkUndoVerifyCounts;
}
