// ── Merge the copies of one record into one of them ───────────────────────────
// Data Deployment › ⚠ Needs a decision lists a name that exists more than once in
// an org, because the name alone cannot say which record is which. The user
// asked for the way out (2026-10-11: "maybe we can provide merging mechanism? so
// the user ends up with a unique data and without dupes" … "It's only merge into
// this one. User needs to be able to select the merged values"):
//
//   • the user chooses the copy that STAYS (the survivor);
//   • for every updateable field whose value differs between the copies, the
//     user chooses which copy's value the survivor keeps (the survivor's own
//     value is the default) — sftkMergeDiff / sftkMergeChosen;
//   • everything under the other copies moves to the survivor, and they are
//     deleted — sftkMergeRun.
//
// How the copies are merged depends on the object:
//   native   Account, Contact, Lead, Case — Salesforce merges these itself
//            (contacts, cases, activities, files, feed, shares… all move). There
//            is no REST call for it; the Apex `Database.merge` runs through the
//            Tooling API's executeAnonymous (SF_APEX_RUN in background.js, gated
//            like every other write). Up to two copies per call, so more copies
//            go in rounds.
//   generic  every other object — the Toolkit moves what hangs under a copy to
//            the survivor one child relationship at a time (SObject Collections
//            update, verified by a re-count), and deletes the copy only when
//            every relationship moved. A relationship that refuses stops the
//            merge before that copy is deleted; the receipt names it.
//
// Both ways go through sftkWriteVerified: a step is only ever reported from a
// re-read of the org. A merge cannot be undone by the Toolkit: the copies are
// in the Recycle Bin, but restoring them does not take back what moved to the
// survivor. The dialog says so before, the History entry after.
//
// Page-agnostic: the runner is handed `send` (the page's sendBg) and a session.
// Everything else here is pure and unit-tested (test/merge-1012.test.mjs).

// Salesforce merges this object itself (Apex merge: leads, contacts, cases, accounts).
function sftkMergeNative(objType) {
  return ['Account', 'Contact', 'Lead', 'Case'].includes(String(objType || ''));
}

// A Salesforce id, and nothing else — the only thing that goes into Apex source.
function sftkMergeIdOk(id) {
  return /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(String(id || ''));
}

// The copies in rounds of two: one Database.merge call takes at most two.
function sftkMergeRounds(dupIds) {
  const ids = (dupIds || []).filter(Boolean);
  const out = [];
  for (let i = 0; i < ids.length; i += 2) out.push(ids.slice(i, i + 2));
  return out;
}

// The Apex for one round: the survivor (a stub with its id — its field values
// were written before, through REST) and one or two copies. allOrNone = true:
// a refusal throws, and executeAnonymous reports the exception message.
function sftkMergeApex(objType, survivorId, dupIds) {
  const obj = String(objType || '');
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(obj)) throw new Error(`"${obj}" is not an object name`);
  const dups = (dupIds || []).filter(Boolean);
  if (!dups.length || dups.length > 2) throw new Error('one merge round takes one or two copies');
  for (const id of [survivorId, ...dups]) if (!sftkMergeIdOk(id)) throw new Error(`"${id}" is not a Salesforce id`);
  return `${obj} m = new ${obj}(Id = '${survivorId}');\n`
    + `List<${obj}> d = new List<${obj}>{ ${dups.map(d => `new ${obj}(Id = '${d}')`).join(', ')} };\n`
    + `Database.merge(m, d, true);`;
}

// Which describe fields the dialog compares and the survivor can take: writable
// data fields only — no Id, no compound field as a whole (its parts — BillingCity,
// FirstName — are writable one by one and are compared), no formulas, no auto-numbers.
function sftkMergeFieldOk(f) {
  if (!f || !f.name || !f.updateable) return false;
  if (f.name === 'Id') return false;
  if (f.type === 'address' || f.type === 'location') return false;
  if (f.calculated || f.autoNumber) return false;
  return true;
}

function _sftkMergeNorm(v) {
  if (v == null) return '';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch (_) { return String(v); } }
  return String(v);
}

// The fields that differ between the copies, with every copy's value in the
// order the records were given, and how many fields are the same everywhere.
//   fields: describe.fields; recs: the copies as read (Id + the fields)
//   → { differ: [{ name, label, type, values: [...] }], same }
function sftkMergeDiff(fields, recs) {
  const rs = Array.isArray(recs) ? recs : [];
  const differ = [];
  let same = 0;
  for (const f of (fields || [])) {
    if (!sftkMergeFieldOk(f)) continue;
    const values = rs.map(r => (r && r[f.name] !== undefined) ? r[f.name] : null);
    if (values.every(v => _sftkMergeNorm(v) === _sftkMergeNorm(values[0]))) { same++; continue; }
    differ.push({ name: f.name, label: f.label || f.name, type: f.type || '', values });
  }
  return { differ, same };
}

// What the survivor is written with: for every differing field the value of the
// copy the user picked, when it is not the survivor's own.
//   picks: { fieldName: copyIndex }   survivorIdx: the survivor's position
//   → { body: { field: value }, changes: [{ name, label, from, to }] }
function sftkMergeChosen(diff, picks, survivorIdx) {
  const body = {}, changes = [];
  const s = Number.isInteger(survivorIdx) ? survivorIdx : 0;
  for (const f of ((diff && diff.differ) || [])) {
    const i = picks && Number.isInteger(picks[f.name]) ? picks[f.name] : s;
    if (i === s || i < 0 || i >= f.values.length) continue;
    if (_sftkMergeNorm(f.values[i]) === _sftkMergeNorm(f.values[s])) continue;
    body[f.name] = f.values[i];
    changes.push({ name: f.name, label: f.label, from: f.values[s], to: f.values[i] });
  }
  return { body, changes };
}

// The generic way: the child relationships whose rows move to the survivor.
// System rows (history, shares, feed, change events, approval instances, file
// links…) cannot be re-pointed; they go with the copy, and the dialog says so.
function sftkMergeChildPlan(childRelationships) {
  const system = /(?:History|Share|Feed|ChangeEvent|FeedComment)$|^(?:EntitySubscription|ProcessInstance|FlowRecordRelation|ContentDocumentLink|TopicAssignment|DuplicateRecordItem|RecordAction|RecordActionHistory|UserRecordAccess|AttachedContentDocument|CombinedAttachment|ContentVersion|EmailMessage|OutgoingEmail|OutgoingEmailRelation|ActivityHistory|OpenActivity|NoteAndAttachment|ProcessInstanceHistory|FlowOrchestrationWorkItem)$/;
  const out = [];
  for (const r of (childRelationships || [])) {
    if (!r || !r.childSObject || !r.field) continue;
    if (system.test(r.childSObject)) continue;
    out.push({ child: r.childSObject, field: r.field, relationshipName: r.relationshipName || '', cascade: !!r.cascadeDelete });
  }
  return out;
}

// One sentence for a value in the dialog and the receipt.
function sftkMergeValueText(v) {
  if (v == null || v === '') return '(empty)';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return _sftkMergeNorm(v);
  const s = String(v);
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
}

// A refusal from executeAnonymous, in the user's words: the permission it needs.
function sftkMergeApexRefusal(text) {
  const t = String(text || '');
  if (/Author Apex|INSUFFICIENT_ACCESS|not authorized|permission|FORBIDDEN|403/i.test(t)) {
    return `${t} — running Apex needs the "Author Apex" permission. Without it, merge the copies in Salesforce itself (the record's View Duplicates → Merge).`;
  }
  return t;
}

// The copies, read live before the dialog: Id, the two dates, every field the
// survivor could take. ctx: { send, orgUrl, sid, obj, fields (describe.fields), ids }
//   → { records: [...] in the order of ids (a copy that is gone is left out) } | { error }
async function sftkMergeRead(ctx) {
  const c = ctx || {};
  const ids = [...new Set((c.ids || []).filter(sftkMergeIdOk))];
  if (typeof c.send !== 'function' || !c.obj || ids.length < 2) return { error: 'nothing to read' };
  const cols = ['Id', 'CreatedDate', 'LastModifiedDate', ...(c.fields || []).filter(sftkMergeFieldOk).map(f => f.name)].filter((x, i, a) => a.indexOf(x) === i);
  const q = await c.send({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: c.orgUrl, sid: c.sid, query: `SELECT ${cols.join(', ')} FROM ${c.obj} WHERE Id IN (${ids.map(id => `'${id}'`).join(',')})` });
  if (!q || q.error) return { error: (q && q.error) || 'no answer' };
  return { records: ids.map(id => (q.records || []).find(r => r && r.Id === id)).filter(Boolean) };
}

// The merge, written and verified step by step.
//   ctx: { send, orgUrl, sid, obj, label, name, survivorId, dupIds, body, native, rels, journal }
//   → { ok, text, lines: [...], deleted: [...], kept: [...] }
async function sftkMergeRun(ctx) {
  const c = ctx || {};
  const send = c.send;
  const obj = String(c.obj || '');
  const label = String(c.label || obj);
  const name = String(c.name || '');
  const survivorId = String(c.survivorId || '');
  const dupIds = (c.dupIds || []).filter(id => id && id !== survivorId);
  const body = (c.body && typeof c.body === 'object') ? c.body : {};
  const lines = [], deleted = [], kept = [];
  const soql = async q => { const r = await send({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: c.orgUrl, sid: c.sid, query: q }); if (r && r.error) throw new Error(String(r.error)); return (r && r.records) || []; };
  const idList = ids => ids.map(id => `'${id}'`).join(',');
  if (typeof send !== 'function' || !obj || !sftkMergeIdOk(survivorId) || !dupIds.length) {
    return { ok: false, text: 'merge: nothing was written — the copies or the record that stays were not given', lines, deleted, kept };
  }

  // 1. the survivor's values, first — a value the user chose must be on the
  //    record before the copies that carried it are gone
  const fields = Object.keys(body);
  if (fields.length) {
    // confirmed-by: sftkConfirmDestructive in _depMergeCopies (studio-deploy.js) — the picker, then the shared confirmation with "cannot be undone", before sftkMergeRun is called
    const r = await sftkWriteVerified({
      describe: `${label} "${name}": ${fields.length} value${fields.length === 1 ? '' : 's'} written to the record that stays (${survivorId})`,
      journal: c.journal,
      write: () => send({ type: 'SF_PATCH', orgUrl: c.orgUrl, sid: c.sid, path: `services/data/v62.0/sobjects/${obj}/${survivorId}`, body }),
      verify: async () => {
        const recs = await soql(`SELECT Id, ${fields.join(', ')} FROM ${obj} WHERE Id = '${survivorId}'`);
        const rec = recs[0];
        if (!rec) return { ok: false, text: `the record that stays (${survivorId}) could not be read back` };
        const off = fields.filter(f => _sftkMergeNorm(rec[f]) !== _sftkMergeNorm(body[f]));
        return off.length ? { ok: false, text: `${off.join(', ')}: the org still shows the old value` } : { ok: true };
      },
    });
    lines.push(r.text);
    if (!r.ok) return { ok: false, text: `${label} "${name}": stopped before the merge — ${r.text}`, lines, deleted, kept: dupIds.slice() };
  }

  // 2. the copies
  if (c.native) {
    for (const round of sftkMergeRounds(dupIds)) {
      const apex = sftkMergeApex(obj, survivorId, round);
      // confirmed-by: sftkConfirmDestructive in _depMergeCopies (studio-deploy.js) — the picker, then the shared confirmation with "cannot be undone", before sftkMergeRun is called
      const r = await sftkWriteVerified({
        describe: `${label} "${name}": ${round.length === 1 ? 'copy' : `${round.length} copies`} ${round.join(', ')} merged into ${survivorId} (Salesforce merge)`,
        journal: c.journal,
        write: async () => {
          const res = await send({ type: 'SF_APEX_RUN', orgUrl: c.orgUrl, sid: c.sid, apex });
          if (res && res.error) return { error: sftkMergeApexRefusal(res.error) };
          if (!res || res.compiled === false) return { error: `the merge code did not compile: ${(res && res.compileProblem) || 'no answer'}` };
          if (res.success === false) return { error: sftkMergeApexRefusal(res.exceptionMessage || 'the merge was refused') };
          return res;
        },
        verify: async () => {
          const left = await soql(`SELECT Id FROM ${obj} WHERE Id IN (${idList(round)})`);
          const alive = await soql(`SELECT Id FROM ${obj} WHERE Id = '${survivorId}'`);
          if (!alive.length) return { ok: false, text: `the record that stays (${survivorId}) is gone — do not repeat this; look at the org` };
          if (left.length) return { ok: false, text: `${left.map(x => x.Id).join(', ')} still there — the merge did not happen` };
          return { ok: true, text: `${label} "${name}": ${round.length === 1 ? 'copy' : `${round.length} copies`} ${round.join(', ')} merged into ${survivorId} — verified: the copies are gone and the record that stays is there` };
        },
      });
      lines.push(r.text);
      if (!r.ok) { kept.push(...round); return { ok: false, text: `${label} "${name}": ${deleted.length} of ${dupIds.length} copies merged — ${r.text}`, lines, deleted, kept }; }
      deleted.push(...round);
    }
  } else {
    const rels = Array.isArray(c.rels) ? c.rels : [];
    for (const dup of dupIds) {
      let blocked = '';
      for (const rel of rels) {
        let rows;
        try { rows = await soql(`SELECT Id FROM ${rel.child} WHERE ${rel.field} = '${dup}'`); }
        catch (e) { lines.push(`${rel.child}.${rel.field}: could not be read (${(e && e.message) || e}) — skipped, nothing moved from it`); continue; }
        if (!rows.length) continue;
        // confirmed-by: sftkConfirmDestructive in _depMergeCopies (studio-deploy.js) — the picker, then the shared confirmation with "cannot be undone", before sftkMergeRun is called
        const r = await sftkWriteVerified({
          describe: `${rows.length} ${rel.child} record${rows.length === 1 ? '' : 's'} moved from ${dup} to ${survivorId} (${rel.field})`,
          journal: c.journal,
          write: async () => {
            for (let i = 0; i < rows.length; i += 200) {
              const chunk = rows.slice(i, i + 200).map(x => ({ attributes: { type: rel.child }, Id: x.Id, [rel.field]: survivorId }));
              const res = await send({ type: 'SF_COLLECTIONS_UPDATE', orgUrl: c.orgUrl, sid: c.sid, records: chunk });
              if (res && res.error) return res;
              const bad = (Array.isArray(res) ? res : []).filter(x => x && x.success === false);
              if (bad.length) return { error: (bad[0].errors && bad[0].errors[0] && bad[0].errors[0].message) || 'a record was not accepted' };
            }
            return { ok: true };
          },
          verify: async () => {
            const left = await soql(`SELECT Id FROM ${rel.child} WHERE ${rel.field} = '${dup}'`);
            return left.length ? { ok: false, text: `${left.length} ${rel.child} record(s) still point at ${dup}` } : { ok: true };
          },
        });
        lines.push(r.text);
        if (!r.ok) { blocked = r.text; break; }
      }
      if (blocked) { kept.push(dup); lines.push(`${label} ${dup} was NOT deleted: ${blocked}`); continue; }
      // confirmed-by: sftkConfirmDestructive in _depMergeCopies (studio-deploy.js) — the picker, then the shared confirmation with "cannot be undone", before sftkMergeRun is called
      const d = await sftkWriteVerified({
        describe: `${label} "${name}": copy ${dup} deleted (Recycle Bin)`,
        journal: c.journal,
        write: () => send({ type: 'SF_REST_DELETE', orgUrl: c.orgUrl, sid: c.sid, sobject: obj, id: dup }),
        verify: async () => {
          const left = await soql(`SELECT Id FROM ${obj} WHERE Id = '${dup}'`);
          return left.length ? { ok: false, text: `${dup} is still there` } : { ok: true };
        },
      });
      lines.push(d.text);
      if (d.ok) deleted.push(dup); else kept.push(dup);
    }
  }
  const ok = deleted.length === dupIds.length;
  const text = ok
    ? `${label} "${name}": ${deleted.length === 1 ? 'the copy' : `${deleted.length} copies`} merged into ${survivorId}${fields.length ? ` with ${fields.length} chosen value${fields.length === 1 ? '' : 's'}` : ''} — verified by re-reading the org`
    : `${label} "${name}": ${deleted.length} of ${dupIds.length} copies merged; ${kept.length} left as ${kept.length === 1 ? 'it was' : 'they were'} (${kept.join(', ')}) — see the lines`;
  return { ok, text, lines, deleted, kept };
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkMergeNative = sftkMergeNative;
  globalThis.sftkMergeIdOk = sftkMergeIdOk;
  globalThis.sftkMergeRounds = sftkMergeRounds;
  globalThis.sftkMergeApex = sftkMergeApex;
  globalThis.sftkMergeFieldOk = sftkMergeFieldOk;
  globalThis.sftkMergeDiff = sftkMergeDiff;
  globalThis.sftkMergeChosen = sftkMergeChosen;
  globalThis.sftkMergeChildPlan = sftkMergeChildPlan;
  globalThis.sftkMergeValueText = sftkMergeValueText;
  globalThis.sftkMergeApexRefusal = sftkMergeApexRefusal;
  globalThis.sftkMergeRead = sftkMergeRead;
  globalThis.sftkMergeRun = sftkMergeRun;
}
