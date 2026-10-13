// ── Flow surgery — removing a field reference version by version ────────────
// (user 2026-09-13: "if a field is referenced in a flow in an inactive
// version, we need to suggest to remove the inactive version and ask the user
// if he wants to back it up first … if the field is used under an active flow
// version, we should offer to remove the current version, and create a new
// active version without the field ref and make sure its active … also delete
// flow interview dependencies").
//
// Salesforce holds the field-dependency lock PER FLOW VERSION, so a field
// cannot be deleted while ANY version — active, obsolete or draft — still
// mentions it. The plan below is the whole answer for one flow:
//   · active version references the field  → deploy a new version without
//     the reference, VERIFY it is active (nothing is deleted before that),
//     then delete the replaced version
//   · inactive versions reference the field → delete exactly those versions;
//     clean versions are history and stay
//   · paused flow interviews on a version to be deleted must go first —
//     Salesforce refuses to delete a version while they exist
// PURE: no DOM, no network. field-cleaner.js executes the plan.

// versions: [{ Id, VersionNumber, Status }] — every version of ONE flow
// referencingIds: the Ids among them whose metadata mentions the field
// opts.activeMode — what to do when the ACTIVE version references the field:
//   'replace' (default) deploy a new version without the reference, verify it
//             is active, then delete the replaced one — the flow keeps running
//   'delete'  switch the flow OFF, verify nothing is active, then delete the
//             active version too — the flow STOPS running (user 2026-09-21)
function sftkFlowSurgeryPlan(versions, referencingIds, opts) {
  const activeMode = (opts && opts.activeMode === 'delete') ? 'delete' : 'replace';
  const vs = (Array.isArray(versions) ? versions : [])
    .filter(v => v && v.Id)
    .map(v => ({ id: String(v.Id), num: Number(v.VersionNumber) || 0, status: String(v.Status || '') }))
    .sort((a, b) => b.num - a.num);
  const ref = new Set((Array.isArray(referencingIds) ? referencingIds : []).map(String));
  const active = vs.find(v => v.status === 'Active') || null;
  const activeRefs = !!(active && ref.has(active.id));
  const maxNum = vs.length ? vs[0].num : 0;
  const dropActive = activeRefs && activeMode === 'delete';
  // Salesforce saves a deployed flow OVER its newest version when that
  // version is a DRAFT (never activated), instead of creating a new one —
  // live 2026-10-04: v3 Active + v4 Draft, the deploy REPLACED v4 (the draft
  // record is gone, a new record carries the same number) and activated it;
  // with the newest version Obsolete it created v5. So a newer draft is not
  // deleted afterwards: its number IS the new version, and its own content is
  // lost — the plan says so.
  const newest = vs[0] || null;
  const overwrite = (activeRefs && !dropActive && newest && /draft/i.test(newest.status))
    ? { ...newest, refs: ref.has(newest.id) } : null;
  const isOver = v => !!overwrite && v.id === overwrite.id;
  const inactiveRefs = vs.filter(v => v.status !== 'Active' && ref.has(v.id) && !isOver(v));
  const cleanInactive = vs.filter(v => v.status !== 'Active' && !ref.has(v.id) && !isOver(v)).length;
  const expectNew = overwrite ? overwrite.num : maxNum + 1;
  const toDelete = [
    ...inactiveRefs.map(v => ({ ...v, why: 'inactive version that still references the field' })),
    ...(activeRefs ? [{ ...active, why: dropActive ? 'the active version — the flow is switched off first' : 'replaced by the new version' }] : []),
  ];
  const steps = [];
  if (dropActive) {
    steps.push({ kind: 'deactivate', from: active.num });
    steps.push({ kind: 'verify-inactive' });
  } else if (activeRefs) {
    steps.push({ kind: 'redeploy', from: active.num, expectNew, ...(overwrite ? { overwrites: overwrite.num } : {}) });
    steps.push({ kind: 'verify-active', expectNew });
  }
  if (toDelete.length) steps.push({ kind: 'delete-versions', versions: toDelete.map(v => v.id) });
  return {
    mode: dropActive ? 'active-delete' : (activeRefs ? 'active' : (inactiveRefs.length ? 'inactive-only' : 'none')),
    active, activeRefs, inactiveRefs, toDelete, cleanInactive, overwrite,
    expectNew: (activeRefs && !dropActive) ? expectNew : null,
    steps,
  };
}

// The sentences the confirm dialog shows — one per consequence, in the order
// things will happen. interviews: number of paused interviews on the versions
// to be deleted; interviewCheckError: why that could not be counted (or null).
// ── what is inside a flow: where the field is mentioned ────────────────────
// Text that names a field but cannot hold a Salesforce dependency: labels and
// descriptions. An admin who WRITES the field name into a description must not
// see that reported as a reference the platform locks on.

// PURE. Every string in the metadata that isRef() accepts, with its path.
function sftkFlowRefScan(metadata, isRef) {
  const SFTK_FLOW_TEXT_KEYS = new Set(['description', 'label', 'interviewLabel', 'defaultConnectorLabel', 'fullName', 'processType', 'status']);
  const hits = [];
  if (typeof isRef !== 'function') return hits;
  (function walk(v, path) {
    if (v == null) return;
    if (typeof v === 'string') { if (isRef(v)) hits.push({ path, value: v }); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, [...path, i])); return; }
    if (typeof v === 'object') for (const k of Object.keys(v)) { if (!SFTK_FLOW_TEXT_KEYS.has(k)) walk(v[k], [...path, k]); }
  })(metadata, []);
  return hits;
}

// PURE. Which element a path belongs to, and where inside it, in the words a
// person uses in Flow Builder.
function sftkFlowRefWhere(root, path) {
  const SFTK_FLOW_EL_NAMES = { start: 'Start (entry conditions)', decisions: 'Decision', assignments: 'Assignment',
    recordCreates: 'Create Records', recordUpdates: 'Update Records', recordLookups: 'Get Records', recordDeletes: 'Delete Records',
    screens: 'Screen', formulas: 'Formula', actionCalls: 'Action', subflows: 'Subflow', loops: 'Loop', variables: 'Variable',
    constants: 'Constant', textTemplates: 'Text Template', waits: 'Pause', collectionProcessors: 'Collection Filter/Sort',
    choices: 'Choice', dynamicChoiceSets: 'Choice Set', recordRollbacks: 'Roll Back Records', transforms: 'Transform' };
  const top = path[0];
  let el, rest;
  if (root && Array.isArray(root[top]) && typeof path[1] === 'number') { el = root[top][path[1]] || {}; rest = path.slice(2); }
  else { el = (root && root[top] && typeof root[top] === 'object') ? root[top] : {}; rest = path.slice(1); }
  const n = i => (typeof i === 'number' ? i + 1 : '?');
  let where = '';
  const k = rest[0];
  if (k === 'rules') { const r = (el.rules || [])[rest[1]] || {}; where = `outcome “${r.label || r.name || n(rest[1])}” → condition ${n(rest[3])}`; }
  else if (k === 'conditions') where = `condition ${n(rest[1])}`;
  else if (k === 'filters') where = `filter condition ${n(rest[1])}`;
  else if (k === 'inputAssignments') where = `field value ${n(rest[1])}`;
  else if (k === 'outputAssignments') where = `output ${n(rest[1])}`;
  else if (k === 'assignmentItems') where = `assignment line ${n(rest[1])}`;
  else if (k === 'inputParameters') where = `input ${n(rest[1])}`;
  else if (k === 'queriedFields') where = 'queried field';
  else if (k === 'expression') where = 'its formula text';
  else if (k === 'text') where = 'its text';
  else if (k === 'fields') where = 'a screen component';
  else if (k === 'scheduledPaths') where = `scheduled path ${n(rest[1])}`;
  else if (k === 'collectionReference') where = 'the collection it loops over';
  else if (k === 'waitEvents') where = `pause event ${n(rest[1])}`;
  else where = rest.filter(x => typeof x === 'string').join(' → ') || 'itself';
  return { kind: SFTK_FLOW_EL_NAMES[top] || String(top), name: el.name || '', label: el.label || el.name || (top === 'start' ? 'Start' : ''), where, part: typeof k === 'string' ? k : '' };
}

// PURE. The preview of an automatic fix. `before` is the active version's
// metadata, `after` is what the REAL remover produced from a clone of it — so
// the preview cannot disagree with the run.
//   removed   what the fix takes out
//   remaining what still mentions the field afterwards (the remover leaves
//             Decisions and formulas alone on purpose) — these keep the lock
//   emptied   elements the fix leaves with nothing in a part that needs
//             something — Salesforce is likely to refuse the new version
function sftkFlowRefPreview(before, after, isRef) {
  const removedRaw = [], emptiedRaw = [];
  const J = x => JSON.stringify(x);
  (function cmp(b, a, path) {
    if (Array.isArray(b)) {
      const aa = Array.isArray(a) ? a : [];
      const named = b.length > 0 && b.every(x => x && typeof x === 'object' && typeof x.name === 'string' && x.name);
      if (named) {
        const byName = new Map(aa.map(x => [x && x.name, x]));
        b.forEach((item, i) => { const m = byName.get(item.name); if (!m) removedRaw.push({ path: [...path, i], item }); else cmp(item, m, [...path, i]); });
      } else {
        const pool = aa.map(J);
        b.forEach((item, i) => { const at = pool.indexOf(J(item)); if (at >= 0) pool.splice(at, 1); else removedRaw.push({ path: [...path, i], item }); });
      }
      if (b.length && !aa.length && path.length > 1) emptiedRaw.push(path);
      return;
    }
    if (b && typeof b === 'object') {
      for (const k of Object.keys(b)) {
        if (a == null || !(k in a)) { if (b[k] != null) removedRaw.push({ path: [...path, k], item: b[k] }); }
        else cmp(b[k], a[k], [...path, k]);
      }
    }
  })(before || {}, after || {}, []);
  const what = it => {
    if (it == null) return '';
    if (typeof it !== 'object') return String(it);
    if (it.assignToReference) return `${it.assignToReference} ${it.operator || '='} ${it.value ? (it.value.elementReference || it.value.stringValue || '') : ''}`.trim();
    if (it.field) return `${it.field}${it.value ? ` = ${it.value.elementReference || it.value.stringValue || ''}` : ''}`;
    if (it.objectFieldReference) return it.objectFieldReference;
    if (it.name) return it.label || it.name;
    return J(it).slice(0, 80);
  };
  const NEEDS_SOMETHING = new Set(['assignmentItems', 'inputAssignments', 'conditions']);
  return {
    removed: removedRaw.map(r => ({ ...sftkFlowRefWhere(before, r.path), what: what(r.item) })),
    remaining: sftkFlowRefScan(after, isRef).map(h => ({ ...sftkFlowRefWhere(after, h.path), value: h.value })),
    emptied: emptiedRaw.map(pth => sftkFlowRefWhere(before, [...pth, 0])).filter(e => NEEDS_SOMETHING.has(e.part)),
  };
}

// PURE. Paused vs failed vs other, from FlowInterview.InterviewStatus. A
// FAILED interview (Error) is a saved error report, not a user mid-flow — but
// it blocks the version delete exactly like a paused one.
function sftkFlowInterviewKinds(interviews) {
  const out = { total: 0, paused: 0, failed: 0, other: 0 };
  for (const i of (Array.isArray(interviews) ? interviews : [])) {
    if (!i) continue;
    out.total++;
    const st = String(i.InterviewStatus || '');
    if (/^error$/i.test(st)) out.failed++;
    else if (/paused|wait/i.test(st) || !st) out.paused++;   // no status read → treat as paused: the cautious wording
    else out.other++;
  }
  return out;
}
// "5 flow interview(s) (1 paused, 4 failed)" + what deleting each kind costs.
function sftkFlowInterviewWords(k) {
  const kinds = k && typeof k === 'object' ? k : { total: Number(k) || 0, paused: Number(k) || 0, failed: 0, other: 0 };
  const parts = [kinds.paused ? `${kinds.paused} paused` : null, kinds.failed ? `${kinds.failed} failed` : null, kinds.other ? `${kinds.other} other` : null].filter(Boolean);
  const cost = [kinds.paused ? 'a paused one is a user mid-flow whose progress is lost' : null,
    kinds.failed ? 'a failed one is only a saved error report — deleting it loses nothing but that report' : null].filter(Boolean).join('; ');
  return { head: `${kinds.total} flow interview(s)${parts.length ? ` (${parts.join(', ')})` : ''}`, cost };
}

// opts.swapTo: the field every reference is moved to (⇄ Replace with another
// field, sftk-fieldreplace.js) — the new version then KEEPS its logic and
// points at that field, instead of losing the reference.
function sftkFlowSurgeryLines(plan, interviews, interviewCheckError, opts) {
  const swapTo = opts && opts.swapTo ? String(opts.swapTo) : '';
  const p = plan || { mode: 'none', toDelete: [], inactiveRefs: [] };
  const out = [];
  const vlist = (arr) => arr.map(v => `v${v.num} (${v.status || '?'})`).join(', ');
  if (p.mode === 'none') {
    out.push('No version of this flow references the field any more — nothing to change.');
    return out;
  }
  if (p.mode === 'active-delete') {
    out.push(`Switch the flow OFF (deactivate the active v${p.active.num}) and re-read the org to make sure no version is active. Nothing is deleted before that is confirmed.`);
    out.push(`Then delete v${p.active.num}${p.inactiveRefs.length ? ` and ${p.inactiveRefs.length} inactive version(s) that still reference the field: ${vlist(p.inactiveRefs)}` : ''}.`);
    out.push('THE FLOW STOPS RUNNING. Whatever it automated no longer happens, and no other version becomes active by itself.');
  } else if (p.mode === 'active') {
    // v2 (2026-10-13, user: "a lot of text"): the draft case is said inside the deploy line, not as a line of its own
    if (p.overwrite) {
      out.push(swapTo
        ? `Deploy the active v${p.active.num} over the draft v${p.overwrite.num} with every reference to the field pointing at ${swapTo} instead, and make sure v${p.overwrite.num} is ACTIVE (v${p.overwrite.num} is a DRAFT newer than the active v${p.active.num}: Salesforce saves the deployed version over it, so its own content is REPLACED — the backup below keeps a copy). Nothing is deleted until the org confirms it is running.`
        : `Deploy the active v${p.active.num} over the draft v${p.overwrite.num} without the field reference, and make sure v${p.overwrite.num} is ACTIVE (v${p.overwrite.num} is a DRAFT newer than the active v${p.active.num}: Salesforce saves the deployed version over it, so its own content is REPLACED — the backup below keeps a copy). Nothing is deleted until the org confirms it is running.`);
    } else out.push(swapTo
      ? `Deploy a new version (expected v${p.expectNew}) of the active v${p.active.num} with every reference to the field pointing at ${swapTo} instead, and make sure it is ACTIVE. Nothing is deleted until the org confirms the new version is running.`
      : `Deploy a new version (expected v${p.expectNew}) of the active v${p.active.num} without the field reference, and make sure it is ACTIVE. Nothing is deleted until the org confirms the new version is running.`);
    out.push(`Then delete the replaced v${p.active.num}${p.inactiveRefs.length ? ` and ${p.inactiveRefs.length} inactive version(s) that still reference the field: ${vlist(p.inactiveRefs)}` : ''}${p.cleanInactive ? `; ${p.cleanInactive} other version(s) never mention the field and are left alone` : ''}.`);
  } else {
    out.push(`Delete ${p.inactiveRefs.length} inactive version(s) that still reference the field: ${vlist(p.inactiveRefs)}. No new version is needed — ${p.active ? `the active v${p.active.num} does not use the field` : 'the flow has no active version'}.`);
  }
  if (p.cleanInactive && p.mode !== 'active') out.push(`${p.cleanInactive} other inactive version(s) do not mention the field and are left alone.`);
  if (interviewCheckError) {
    out.push(`Paused flow interviews could NOT be checked (${interviewCheckError}) — if any exist on a version to be deleted, that deletion will be refused by Salesforce and reported here.`);
  } else if ((typeof interviews === 'object' && interviews ? interviews.total : interviews) > 0) {
    const w = sftkFlowInterviewWords(interviews);
    out.push(`${w.head} on those versions are deleted FIRST — Salesforce refuses to delete a version while they exist${w.cost ? `: ${w.cost}` : ''}.`);
  }
  out.push('Deleted flow versions cannot be restored by Salesforce — the backup below downloads them as a zip first; the Flows tool can restore from it.');
  return out;
}

// ── One card per FLOW (user 2026-10-05) ─────────────────────────────────────
// The dependency index lists a flow once per VERSION that mentions the field.
// Shown as rows, one flow looked like several separate things: "i dont know
// what was deleted, what was changed to a new active flow version … if i want
// to replace only one of them it will replace them all". A flow is ONE item:
// these say, before the fix, what happens to each of its versions, and after
// it, what happened.

// versions: [{ num, status }] — the versions of ONE flow that mention the field.
// opts.swapTo: the replacement field (replace mode) or ''.
// Returns { hasActive, lines: [{ vers, text }] }.
function sftkFlowCardLines(versions, opts) {
  const swapTo = opts && opts.swapTo ? String(opts.swapTo) : '';
  const vs = (Array.isArray(versions) ? versions : [])
    .map(v => ({ num: Number(v && v.num) || 0, status: String((v && v.status) || '') }))
    .sort((a, b) => b.num - a.num);
  const active = vs.find(v => v.status === 'Active') || null;
  const tag = arr => arr.map(v => `v${v.num}`).join(', ');
  const lines = [];
  if (!active) {
    if (vs.length) lines.push({ vers: `${tag(vs)} · not active`, text: 'deleted. No version that runs uses the field, so nothing is replaced and no new version is made.' });
    return { hasActive: false, lines };
  }
  // The decision is on the card (user 2026-10-05): one button per way.
  lines.push({ vers: `v${active.num} · Active`, text: 'the version that runs. '
    + (swapTo ? `⇄ Replace saves a new active version that uses ${swapTo}; the flow keeps running. ` : '')
    + '✂ Remove · flow keeps running saves a new active version without the field. 🗑 Delete versions · flow off switches the flow off instead.'
    + ` Either way v${active.num} itself is deleted afterwards.` });
  const top = vs.find(v => v.num > active.num && /draft/i.test(v.status)) || null;
  if (top) lines.push({ vers: `v${top.num} · Draft`, text: 'newer than the active version: when the flow keeps running, Salesforce saves the new version OVER this draft, so its content is replaced; with 🗑 it is deleted if it mentions the field. The dialog offers a backup.' });
  const rest = vs.filter(v => v !== active && v !== top);
  if (rest.length) lines.push({ vers: `${tag(rest)} · not active`, text: 'deleted. Salesforce keeps the field locked while any version mentions it.' });
  return { hasActive: true, lines };
}

// What a finished flow fix did, one fact per line.
//   r     fixFlowExecute's result: { mode, newVersion, newId, overwrote, swapped,
//         interviewsDeleted, stillMentions, undecided }
//   plan  the plan that ran: { toDelete: [{ id, num, status }], cleanInactive }
//   opts  { swapTo, field }
// Returns [{ icon, text, warn? }].
function sftkFlowDoneLines(r, plan, opts) {
  const o = opts || {}, res = r || {}, p = plan || {};
  const out = [];
  if (res.mode === 'active') {
    out.push({ icon: '▶', text: `v${res.newVersion} is the ACTIVE version now — ${res.swapped
      ? `${res.swapped} reference${res.swapped === 1 ? '' : 's'} in it point${res.swapped === 1 ? 's' : ''} at ${o.swapTo}`
      : 'saved without the field reference'}. Verified by re-reading the org.` });
    if (res.overwrote) out.push({ icon: '♻', text: `v${res.newVersion} was a draft before: Salesforce saved the new version over it, so the draft’s own content is gone.` });
  } else if (res.mode === 'active-delete') {
    out.push({ icon: '⏹', text: 'The flow is switched OFF: no version is active, so it no longer runs. Verified by re-reading the org.' });
  }
  const gone = (p.toDelete || []).filter(v => v && String(v.id) !== String(res.newId || ''));
  if (gone.length) out.push({ icon: '🗑', text: `Deleted: ${gone.map(v => `v${v.num}${v.status === 'Active' ? ' (was the active version)' : ''}`).join(', ')}.` });
  if (res.interviewsDeleted) out.push({ icon: '🗑', text: `${res.interviewsDeleted} flow interview${res.interviewsDeleted === 1 ? '' : 's'} on those versions deleted.` });
  if (p.cleanInactive) out.push({ icon: '·', text: `${p.cleanInactive} other version${p.cleanInactive === 1 ? '' : 's'} never mentioned the field and ${p.cleanInactive === 1 ? 'was' : 'were'} left alone.` });
  if (res.stillMentions) out.push({ icon: '⚠', warn: true, text: res.swapped
    ? `The new version still mentions ${o.field} in ${res.undecided || 'some'} place(s) whose object could not be worked out — if they are this field, change them in Flow Builder.`
    : 'The new version still mentions the field in text the automatic fix does not touch (a formula or decision) — finish it in Flow Builder.' });
  return out;
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkFlowCardLines = sftkFlowCardLines;
  globalThis.sftkFlowDoneLines = sftkFlowDoneLines;
  globalThis.sftkFlowSurgeryPlan = sftkFlowSurgeryPlan;
  globalThis.sftkFlowInterviewKinds = sftkFlowInterviewKinds;
  globalThis.sftkFlowRefScan = sftkFlowRefScan;
  globalThis.sftkFlowRefWhere = sftkFlowRefWhere;
  globalThis.sftkFlowRefPreview = sftkFlowRefPreview;
  globalThis.sftkFlowInterviewWords = sftkFlowInterviewWords;
  globalThis.sftkFlowSurgeryLines = sftkFlowSurgeryLines;
}
