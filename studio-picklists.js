'use strict';
// ════════════════════════════════════════════════════════════════
// PICKLIST & RECORD TYPE MANAGER — Phase P1 (single org)
// ════════════════════════════════════════════════════════════════
// The gap this closes: Salesforce lets you deactivate/delete a picklist value
// while thousands of records still hold it — orphan text that list views,
// reports and flow decisions silently stop matching. This view shows every
// value WITH its live usage count and record-type assignments, and never
// touches metadata without first offering a DATA FIX (remap / clear) — with
// an automation-impact panel (triggers, record-triggered flows, validation
// rules) so a mass update is never a surprise.
//
// V1 scope: custom picklist/multipicklist fields with a LOCAL value set.
// Global value sets and standard picklists render read-only (Phase P4).
// Multi-org matrix + bulk apply is Phase P2; RT editing is Phase P3.

// ── Pure helpers (top-level for unit tests) ─────────────────────

// Rebuild a multipicklist string after remapping/removing one token.
// 'A;B;C' remap B→X = 'A;X;C' · clear B = 'A;C' · dedupes ('A;X' + X stays single).
function pkMultiRemap(current, oldVal, newVal) {
  const tokens = String(current || '').split(';').map(t => t.trim()).filter(Boolean);
  const out = [];
  for (const t of tokens) {
    const mapped = t === oldVal ? newVal : t;
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out.join(';');
}

// Read a Tooling CustomValue's API name across the JSON shapes Salesforce
// returns (fullName in some API versions, valueName in others).
function pkValueName(v) {
  return v?.fullName ?? v?.valueName ?? v?.label ?? '';
}

// Ordered union of value names across per-org value lists (P2 matrix rows).
// perOrg: [{ orgKey, values:[name] }]. Preserves first-seen order; each org
// contributes new names in its own order. Pure — unit-testable.
function pkValueUnion(perOrg) {
  const seen = new Set(), out = [];
  for (const org of (perOrg || [])) {
    for (const name of (org.values || [])) {
      if (name && !seen.has(name)) { seen.add(name); out.push(name); }
    }
  }
  return out;
}

// Build a value×org matrix (P2). orgResults: [{ orgKey, label, inv|null, skip }].
// Returns { values:[name], rows:[{ name, cells:[{orgKey, exists, active, count, missing}] }] }.
// Pure — unit-testable (no DOM, no I/O).
function pkBuildMatrix(orgResults, unionValues) {
  const rows = (unionValues || []).map(name => {
    const cells = (orgResults || []).map(o => {
      if (!o.inv) return { orgKey: o.orgKey, missing: true };
      const v = o.inv.rawValues.find(rv => pkValueName(rv) === name);
      if (!v) return { orgKey: o.orgKey, exists: false };
      const count = o.inv.usage.has(name) ? o.inv.usage.get(name) : null;
      return { orgKey: o.orgKey, exists: true, active: v.isActive !== false, count };
    });
    return { name, cells };
  });
  return { values: unionValues || [], rows };
}

// Which of one org's record types include a value. rts: [{ name, devName,
// values:Set }] (from _pkLoadRecordTypes). Pure — unit-testable.
function pkRtCellInfo(rts, valueName) {
  const list = rts || [];
  const inRts = list.filter(rt => rt.values && rt.values.has(valueName));
  return { inCount: inRts.length, total: list.length, names: inRts.map(rt => rt.name || rt.devName) };
}

// Does a value's record-type ASSIGNMENT differ across orgs? Record types are
// matched cross-org by DeveloperName (the P5 sync rule); only devNames present
// in ≥2 orgs are comparable — an RT existing in just one org is an RT-set
// difference, not an assignment drift (the Sync plan's RT alignment covers
// that). perOrgRts: array of rts arrays, one per loaded org. Pure.
function pkRtDrift(perOrgRts, valueName) {
  const byDev = new Map();   // devName → Set('y'|'n') across the orgs that have this RT
  for (const rts of (perOrgRts || [])) {
    for (const rt of (rts || [])) {
      if (!rt.devName) continue;
      const has = rt.values && rt.values.has(valueName) ? 'y' : 'n';
      const s = byDev.get(rt.devName) || new Set();
      s.add(has);
      byDev.set(rt.devName, s);
    }
  }
  for (const s of byDev.values()) if (s.size > 1) return true;
  return false;
}

// Count literal occurrences of a picklist value name inside a blob of
// automation metadata text (P2 value-literal scan). Pure — unit-testable.
function pkValueMentions(text, valueName) {
  if (!text || !valueName) return 0;
  const escaped = String(valueName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(text).match(new RegExp(escaped, 'g'));
  return m ? m.length : 0;
}

// Progressive header for a per-org automation scan (bulk wizard, T8b/N7).
// Honest by construction: while the pass is running it reports how many orgs
// are DONE out of how many will be scanned — it never implies the orgs that
// have no line yet are clean — and once it finishes it still names the orgs
// that FAILED, so an unreadable org can't read as a zero-impact one.
// Pure — unit-testable.
function pkScanProgressText(done, total, failed, subject) {
  const num = v => Number.isFinite(+v) ? Math.max(0, Math.floor(+v)) : 0;
  const d = num(done), t = num(total), f = num(failed);
  if (t === 0) return '⚡ No orgs selected — nothing to scan.';
  const head = `⚡ Automation that will run / references ${subject || 'this value'}`;
  if (d < t) return `${head} — scanned ${d} of ${t} org(s)…`;
  return `${head} — scanned ${t} of ${t} org(s)` +
    (f ? ` · ⚠ ${f} org(s) could NOT be checked — see below` : '');
}

// Superseded-run guard — same shape as the `token !== _pkSyncScanToken` check
// in _pkSyncAutomationPass. An async pass captures the token it started with
// and must abandon the instant it stops matching the live counter, so a modal
// re-opened mid-scan can never have its newer results painted over by the
// older run. A non-numeric token counts as superseded (fail closed).
// Pure — unit-testable.
function pkScanSuperseded(token, live) {
  return !Number.isFinite(token) || !Number.isFinite(live) || token !== live;
}

// Dedupe identical row-error strings (validation rules emit N copies).
// Pure — unit-testable. Returns strings with a "(×N)" suffix when repeated.
function pkDedupeErrors(errors) {
  const seen = new Map();
  for (const e of (errors || [])) seen.set(e, (seen.get(e) || 0) + 1);
  return [...seen.entries()].map(([m, c]) => c > 1 ? `${m}  (×${c})` : m);
}

// Compute per-record-type add/remove diffs for the RT×value matrix (P3).
// rts: [{ id, values:Set<name> }]. edited: Map(`${rtId}|${val}` → boolChecked).
// Returns [{ rtId, adds:[val], removes:[val] }] for RTs that actually changed.
// Pure — unit-testable.
function pkRtMatrixDiff(rts, edited) {
  const out = [];
  for (const rt of (rts || [])) {
    const adds = [], removes = [];
    for (const [key, checked] of edited.entries()) {
      const sep = key.indexOf('|');
      if (key.slice(0, sep) !== rt.id) continue;
      const val = key.slice(sep + 1);
      const had = rt.values.has(val);
      if (checked && !had) adds.push(val);
      if (!checked && had) removes.push(val);
    }
    if (adds.length || removes.length) out.push({ rtId: rt.id, adds, removes });
  }
  return out;
}

// Diff a TARGET org's value set against the SOURCE org's (P5 sync-from-source).
// srcRaw/tgtRaw: raw Tooling value arrays. Pure — unit-testable.
// Returns { adds, labelChanges, activate, deactivate, extras, defaultChange }.
function pkValueSetSyncDiff(srcRaw, tgtRaw) {
  const tgtBy = new Map((tgtRaw || []).map(v => [pkValueName(v), v]));
  const srcBy = new Map((srcRaw || []).map(v => [pkValueName(v), v]));
  const adds = [], labelChanges = [], activate = [], deactivate = [];
  for (const sv of (srcRaw || [])) {
    const name = pkValueName(sv);
    if (!name) continue;
    const tv = tgtBy.get(name);
    const sActive = sv.isActive !== false;
    if (!tv) { adds.push({ name, label: sv.label || name, active: sActive }); continue; }
    const tActive = tv.isActive !== false;
    if (sActive && !tActive) activate.push(name);
    if (!sActive && tActive) deactivate.push(name);
    const sLabel = sv.label || name, tLabel = tv.label || name;
    if (sLabel !== tLabel) labelChanges.push({ name, from: tLabel, to: sLabel });
  }
  const extras = (tgtRaw || [])
    .filter(tv => tv.isActive !== false && !srcBy.has(pkValueName(tv)))
    .map(tv => pkValueName(tv));
  const srcDefault = pkValueName((srcRaw || []).find(v => v.default)) || null;
  const tgtDefault = pkValueName((tgtRaw || []).find(v => v.default)) || null;
  const defaultChange = srcDefault !== tgtDefault ? { from: tgtDefault, to: srcDefault } : null;
  return { adds, labelChanges, activate, deactivate, extras, defaultChange };
}

// Per-record-type assignment diffs for THIS field, source → target (P5).
// RTs matched across orgs by DeveloperName. Pure — unit-testable.
// srcRts/tgtRts: [{ id, devName, values:Set }]. Returns [{ rtId, devName, adds, removes }].
function pkRtSyncDiff(srcRts, tgtRts) {
  const out = [];
  const srcBy = new Map((srcRts || []).map(r => [r.devName, r]));
  for (const trt of (tgtRts || [])) {
    const srt = srcBy.get(trt.devName);
    if (!srt) continue;   // RT doesn't exist in the source — leave it alone
    const adds    = [...srt.values].filter(v => !trt.values.has(v));
    const removes = [...trt.values].filter(v => !srt.values.has(v));
    if (adds.length || removes.length) out.push({ rtId: trt.id, devName: trt.devName, adds, removes });
  }
  return out;
}

// Deep link to an automation component so an impact hit becomes ACTIONABLE (T8).
// kind:'flow' → Flow Builder for that flow VERSION id (the 301… Flow record we
// already fetch, NOT the FlowDefinition); kind:'vr' → the rule's Object Manager
// page. Returns '' when the org or id is unknown so callers render plain text
// instead of a dead link. Pure — unit-testable.
function pkAutomationUrl(orgUrl, obj, kind, id) {
  const base = String(orgUrl || '').replace(/\/+$/, '');
  if (!base || !id) return '';
  if (kind === 'flow') return `${base}/builder_platform_interaction/flowBuilder.app?flowId=${encodeURIComponent(id)}`;
  if (kind === 'vr') return `${base}/lightning/setup/ObjectManager/${encodeURIComponent(obj || '')}/ValidationRules/${encodeURIComponent(id)}/view`;
  return `${base}/${encodeURIComponent(id)}`;
}

// ── E4 — API-call cost estimates (pure, unit-tested in test/ent-quota-pk.test.mjs) ──
// The moat is NO SERVER, so every read spends the org's own daily API budget.
// These estimators count what the code above ACTUALLY issues — nothing is
// hidden, nothing is invented, and costs that depend on mid-scan discoveries
// (record-type count, flow count) are said as "more if X", never faked.

// What ONE whole-object sweep (_pkSweepObject) issues per org:
//   · 1 describe (fetched once, then REUSED by all 25 per-field reads),
//   · 1 RecordType list query (the RT bundle is loaded ONCE per org),
//   · 2 Tooling reads per CUSTOM picklist field (CustomField id query +
//     Metadata read) — standard fields cost nothing beyond the cached
//     describe, and skipUsage/skipRts mean NO usage queries and NO per-field
//     RT fetches during a sweep.
// Unknown until the scan runs (hence known:false): the RT bundle's metadata
// reads (one per active record type, capped at 8), fields that exist only in
// non-probe orgs, ambiguous field names (+1 EntityDefinition query each).
// opts: { orgs, customFields }. Returns { total, perOrg, known, moreIf }.
function pkSweepCallEstimate(opts) {
  const num = v => Number.isFinite(+v) ? Math.max(0, Math.floor(+v)) : 0;
  const orgs = num(opts && opts.orgs), customFields = num(opts && opts.customFields);
  if (!orgs) return { total: 0, perOrg: 0, known: true, moreIf: '' };
  const perOrg = 2 + 2 * customFields;
  return { total: orgs * perOrg, perOrg, known: false,
    moreIf: 'the object has record types (up to 8 more reads per org)' };
}

// What ONE "Load matrix" click (_pkLoadMatrix) issues per org:
//   custom field:   1 describe + 2 Tooling reads (CustomField id + Metadata)
//                   + usage + 2 RecordType list queries (the full inventory
//                   fetch lists them once and the matrix lists them again);
//   standard field: 1 describe + usage + 1 RecordType list query.
//   usage: single picklist = 1 GROUP BY query; multi-select = one COUNT query
//   per value, capped at 30 (value count comes from the probe org's describe,
//   so other orgs may differ — hence known:false).
// Unknown until it runs: RT metadata reads (one per active record type,
// capped at 8 per org — the matrix reuses the inventory's RT reads for
// custom fields since the dedupe fix, so nothing is listed twice).
// opts: { orgs, isCustom, isMulti, values }. Returns { total, perOrg, known, moreIf }.
function pkMatrixCallEstimate(opts) {
  const num = v => Number.isFinite(+v) ? Math.max(0, Math.floor(+v)) : 0;
  const orgs = num(opts && opts.orgs);
  if (!orgs) return { total: 0, perOrg: 0, known: true, moreIf: '' };
  const usage = opts && opts.isMulti ? Math.min(Math.max(num(opts.values), 1), 30) : 1;
  const isCustom = !!(opts && opts.isCustom);
  const perOrg = isCustom ? (3 + usage + 2) : (1 + usage + 1);
  return { total: orgs * perOrg, perOrg, known: false,
    moreIf: 'the object has record types (up to 8 more reads per org)' };
}

// Per-org cost of the bulk wizard's automation scan, computed AFTER the org
// finished so the number is real, not guessed: 4 impact queries (_pkImpact)
// + 1 validation-rule scan + 1 flow listing (with the active version Ids) +
// one Tooling composite/batch call per 25 flows read (campaign 3 phase 6 —
// no cap, no per-flow query). Still "≈" in the UI because >2000-row query
// results paginate into extra calls.
function pkBulkScanCalls(scan) {
  const flows = (scan && Number.isFinite(+scan.flowsScanned)) ? Math.max(0, Math.floor(+scan.flowsScanned)) : 0;
  return 6 + Math.ceil(flows / 25);
}

// The one-line cost display. est: { total, perOrg, known, moreIf, scope } —
// scope is optional display text like "across 3 org(s)". budgets: null/absent
// when the shared budget helper (studio-transfer.js) is unavailable — the
// line is then JUST the local estimate; otherwise [{ label, budget, calls }]
// where budget is { max, remaining } | null (null = the meter could not be
// read, which is SAID, never hidden) and calls is the estimate against THAT
// org — each org has its OWN pool, so pools are labeled and never summed.
// Returns { text, warn }; warn flips when any org's estimated calls EXCEED
// its remaining daily budget (equal is not over) — it informs, never blocks.
// Copy mirrors sftkApiBudgetLine (studio-transfer.js) so cost lines read the
// same app-wide, but this is self-contained: no cross-file dependency.
function pkApiCostLine(est, budgets) {
  const fmt = v => Number(v).toLocaleString();
  const total = (est && Number.isFinite(est.total)) ? Math.max(0, Math.floor(est.total)) : null;
  if (total === null) return { text: '', warn: false };
  const rough = est.known === false;
  let head = `≈${fmt(total)}${rough && !est.moreIf ? '+' : ''} API call${total === 1 ? '' : 's'}`;
  if (est.scope) head += ` ${est.scope}`;
  if (rough && est.moreIf) head += `, more if ${est.moreIf}`;
  const parts = [head];
  let warn = false;
  const over = [];
  for (const b of (budgets || [])) {
    const label = (b && b.label) ? String(b.label) : 'org';
    if (b && b.budget && Number.isFinite(b.budget.remaining) && Number.isFinite(b.budget.max)) {
      parts.push(`${label} has ${fmt(b.budget.remaining)} of ${fmt(b.budget.max)} daily API calls remaining`);
      if (Number.isFinite(b.calls) && b.calls > b.budget.remaining) { warn = true; over.push(label); }
    } else {
      parts.push(`${label}: API budget unavailable`);
    }
  }
  let text = parts.join(' · ');
  if (warn) text = `⚠ ${text} — may exhaust the org's remaining daily API budget${over.length > 1 ? 's' : ''} (${over.join(', ')})`;
  return { text, warn };
}

// ONE verdict for ONE field across orgs — the heart of the T9 whole-object sweep.
// perOrgInv[i]: { orgKey, label, kind:'local'|'global'|'standard'|'missing'|'error',
//                 values:[{ name, label, active, isDefault }], valueSetName, error }
// perOrgRts[i]: that org's record types FOR THIS FIELD ([{ devName, values:Set }]),
//               or null/[] when they couldn't be read — INDEX-ALIGNED with perOrgInv.
// Returns { status, label, drifting, diffCount, differing, defaultDiffers, rtDrift,
//           rtDriftValues, missingIn, erroredIn, comparable, rtComparable,
//           valueCount, shared, detail }.
// status: 'sync' | 'values' | 'rts' | 'missing' | 'notcomparable' | 'error' | 'insufficient'.
// Pure — unit-tested in test/picklists-t9.test.mjs (calls pkRtDrift only).
function pkFieldVerdict(perOrgInv, perOrgRts, fieldName) {
  const raw = perOrgInv || [], rtsAll = perOrgRts || [];
  const orgs = [], local = [], shared = [], rtLists = [], missingIn = [], erroredIn = [];
  for (let i = 0; i < raw.length; i++) {
    const o = raw[i];
    if (!o) continue;
    orgs.push(o);
    if (o.kind === 'missing') missingIn.push(o.orgKey);
    else if (o.kind === 'error') erroredIn.push(o.orgKey);
    else if (o.kind === 'global' || o.kind === 'standard') shared.push(o);
    else if (o.kind === 'local') {
      local.push(o);
      const rl = rtsAll[i];
      if (rl && rl.length) rtLists.push(rl);
    }
  }
  const out = {
    status: 'sync', label: '', drifting: false, diffCount: 0, differing: [], defaultDiffers: false,
    rtDrift: false, rtDriftValues: [], missingIn, erroredIn, comparable: local.length,
    rtComparable: rtLists.length, valueCount: 0, shared: null, detail: '',
  };

  // Global / standard value sets are ORG-WIDE objects reused by many fields —
  // the per-field sync plan cannot write them. Name the set and stop, so the
  // sweep can group every field that inherits it and offer ONE action.
  if (shared.length) {
    const kinds = [...new Set(shared.map(o => o.kind))];
    const names = [...new Set(shared.map(o => o.valueSetName || fieldName).filter(Boolean))];
    const kind = kinds.length === 1 ? kinds[0] : 'mixed';
    const mixed = kinds.length > 1 || names.length > 1 || shared.length !== orgs.length;
    let detail = kind === 'global'
      ? 'Backed by the global value set ' + names.join(' / ') + ' — shared by every field that inherits it, so it is synced ONCE, not per field.'
      : kind === 'standard'
        ? fieldName + ' is a standard picklist (StandardValueSet ' + names.join(' / ') + ') — Salesforce owns its values; the per-field sync plan cannot write them.'
        : 'Backed by a shared value set in some orgs and a local one in others — not comparable field by field.';
    if (mixed) detail += ' ⚠ NOT identical across the loaded orgs (different set name, or local/missing in some orgs) — check each org individually.';
    if (erroredIn.length) detail += ' Could NOT be read in: ' + erroredIn.join(', ') + '.';
    out.status = 'notcomparable';
    out.label = 'not comparable — ' + (kind === 'mixed' ? 'shared value set' : kind + ' value set') + (names.length === 1 ? ' (' + names[0] + ')' : '');
    out.shared = { kind, names, mixed, key: kind + ':' + names.join('|'), orgKeys: shared.map(o => o.orgKey) };
    out.detail = detail;
    return out;
  }

  if (!local.length) {
    out.status = erroredIn.length ? 'error' : 'missing';
    out.label = erroredIn.length ? 'could not read' : 'field missing in all ' + orgs.length + ' org(s)';
    out.detail = erroredIn.length
      ? fieldName + ' could not be read in any loaded org (' + erroredIn.join(', ') + ') — NO verdict was computed.'
      : fieldName + ' does not exist in any loaded org.';
    return out;
  }

  const seen = new Set(), union = [];
  for (const o of local) {
    for (const v of (o.values || [])) {
      if (v && v.name && !seen.has(v.name)) { seen.add(v.name); union.push(v.name); }
    }
  }
  const differing = [];
  for (const name of union) {
    let present = 0, on = 0, off = 0;
    const labels = new Set();
    for (const o of local) {
      const v = (o.values || []).find(x => x && x.name === name);
      if (!v) continue;
      present++;
      if (v.active === false) off++; else on++;
      labels.add((v.label === undefined || v.label === null || v.label === '') ? name : v.label);
    }
    if (present !== local.length || (on && off) || labels.size > 1) differing.push(name);
  }
  const defaults = new Set(local.map(o => {
    const d = (o.values || []).find(v => v && v.isDefault);
    return d ? d.name : '';
  }));
  const rtDriftValues = [];
  if (rtLists.length >= 2) for (const name of union) if (pkRtDrift(rtLists, name)) rtDriftValues.push(name);

  out.valueCount = union.length;
  out.differing = differing;
  out.diffCount = differing.length;
  out.defaultDiffers = defaults.size > 1;
  out.rtDriftValues = rtDriftValues;
  out.rtDrift = rtDriftValues.length > 0;

  const bits = [];
  if (missingIn.length) bits.push('field missing in ' + missingIn.length + ' org(s)');
  if (out.diffCount) bits.push('values differ (' + out.diffCount + ')');
  else if (out.defaultDiffers) bits.push('default value differs');
  if (out.rtDrift) bits.push('RT assignment differs');

  if (missingIn.length) out.status = 'missing';
  else if (out.diffCount || out.defaultDiffers) out.status = 'values';
  else if (out.rtDrift) out.status = 'rts';
  else if (local.length < 2) out.status = 'insufficient';
  else out.status = 'sync';
  out.drifting = out.status === 'missing' || out.status === 'values' || out.status === 'rts';
  out.label = out.status === 'sync' ? '✓ in sync'
    : out.status === 'insufficient' ? 'only ' + local.length + ' org readable — nothing to compare'
    : bits.join(' · ');

  const parts = [];
  if (missingIn.length) parts.push('Missing in: ' + missingIn.join(', ') + '.');
  if (erroredIn.length) parts.push('Could NOT be read in: ' + erroredIn.join(', ') + ' — those orgs are excluded from this verdict.');
  if (out.diffCount) parts.push('Values that differ: ' + differing.slice(0, 8).join(', ') + (out.diffCount > 8 ? '… (+' + (out.diffCount - 8) + ' more)' : '') + '.');
  if (out.defaultDiffers) parts.push('The default value is not the same in every org.');
  if (out.rtDrift) parts.push('Record-type assignment differs for: ' + rtDriftValues.slice(0, 6).join(', ') + (rtDriftValues.length > 6 ? '…' : '') + '.');
  if (rtLists.length < 2) parts.push('Record types were readable in ' + rtLists.length + ' org(s) only — RT drift was NOT checked.');
  if (out.status === 'sync') parts.push('All ' + local.length + ' orgs expose the same ' + union.length + ' value(s) with matching labels, active states' + (rtLists.length >= 2 ? ' and record-type assignments' : '') + '.');
  out.detail = parts.join(' ');
  return out;
}

// ── View state ──────────────────────────────────────────────────
let _pkOrgUrl   = '';
let _pkObj      = '';
let _pkField    = '';
let _pkObjCache = {};     // orgKey → [{name, label}]
let _pkInv      = null;   // loaded inventory (null = nothing loaded)
let _pkMode     = 'compare';  // 'single' | 'compare' — compare is the DEFAULT
                              // (user 2026-07-18: multi-org matrix is the main
                              // flow; ring orgs pre-seed its checkboxes)
let _pkCmpOrgs  = [];     // selected org URLs for compare mode (P2)
let _pkCmpObj   = '';
let _pkCmpField = '';
let _pkMatrix   = null;   // last built matrix { obj, field, results, union, matrix } (P2)
let _pkStd      = null;   // loaded standard value set editor state (P4a)
let _pkGvs      = null;   // loaded global value set editor state (P4b)
let _pkPendingRtCheck = null;   // { name, pre } — surface SF's RT auto-drop after deactivate (P3)
let _pkHighlightValue = '';     // value row to scroll to + flash after a deep link (sftkOpenPicklistFix)
let _pkSweep    = null;   // T9 whole-object sweep state { obj, orgs, rows, ... }
let _pkSweepRunning = false;
let _pkSyncScanToken = 0;              // invalidates an in-flight sync-plan automation pass (T8c)
let _pkBulkScanToken = 0;              // same, for the bulk wizard's per-org automation scan
let _pkCmpPicks = null;                // { obj, fields:[{name,isCustom,isMulti,values}] } — probe describe's picklist fields (E4 cost lines)
const _pkCostTokens = Object.create(null);   // elId → token: last-render-wins for the async budget meters (E4)
const _pkSyncScanCache = new Map();    // `${orgKey}|${obj}.${field}|${value}` → literal-scan result

function renderPicklists() {
  const orgs = allMapOrgs();
  if (!_pkOrgUrl) _pkOrgUrl = _workingPair.src || _orgUrl || (orgs[0] && orgs[0].url) || '';

  setMain(`
    ${dsViewHeader({
      icon: 'sliders',
      title: 'Picklist Manager',
      subtitle: 'Values, record types, usage &amp; data fixes — per org or across orgs',
      actions: `<div class="ds-pk-mode-toggle" role="group" aria-label="Picklist Manager mode">
        <button class="ds-btn ds-btn-sm ${_pkMode === 'single' ? 'ds-btn-primary' : ''}" data-pk-mode="single" aria-pressed="${_pkMode === 'single'}">Single org</button>
        <button class="ds-btn ds-btn-sm ${_pkMode === 'compare' ? 'ds-btn-primary' : ''}" data-pk-mode="compare" aria-pressed="${_pkMode === 'compare'}">Compare across orgs</button>
      </div>`,
    })}
    <div id="dsPkConfig"></div>
    <div id="dsPkBody">
      <div class="ds-empty-page">
        <div class="ds-empty-icon">${window.sftkCatSvg ? window.sftkCatSvg('sleep', 64) : '🎚'}</div>
        <div class="ds-empty-title">${_pkMode === 'compare' ? 'Pick orgs, an object and a picklist field' : 'Pick an org, object and picklist field'}</div>
        <div class="ds-empty-sub">${_pkMode === 'compare'
          ? 'You\'ll get a value×org matrix (exists / active / usage / record-type assignments per org) and a bulk wizard that applies the same deactivate/delete + data fix to every selected org.'
          : 'You\'ll get every value with its live record count, record-type assignments, and safe deactivate / delete / remap operations.'}</div>
      </div>
    </div>`);

  document.querySelectorAll('[data-pk-mode]').forEach(b =>
    b.addEventListener('click', () => { _pkMode = b.dataset.pkMode; renderPicklists(); }));

  if (_pkMode === 'compare') _pkRenderCompareConfig();
  else _pkRenderSingleConfig();
}

// Single-org config bar (P1 behaviour, extracted so the mode toggle can swap it).
function _pkRenderSingleConfig() {
  const orgs = allMapOrgs();
  const orgOptions = orgs.map(o =>
    `<option value="${esc(o.url)}" ${_orgKey(o.url) === _orgKey(_pkOrgUrl) ? 'selected' : ''}>${esc(orgOptionLabel(o.url, o.label))}</option>`).join('');
  const cfg = eid('dsPkConfig');
  if (!cfg) return;
  cfg.innerHTML = `
    <div class="ds-pk-config">
      <select id="dsPkOrg" class="ds-select">${orgOptions || '<option value="">No orgs known</option>'}</select>
      <select id="dsPkObj" class="ds-select" ${_pkObj ? '' : 'disabled'}>
        <option value="">${_pkObj ? esc(_pkObj) : 'Object…'}</option>
      </select>
      <select id="dsPkField" class="ds-select" disabled><option value="">Field…</option></select>
      <button class="ds-btn ds-btn-primary" id="dsPkLoad" disabled>Load values</button>
    </div>`;

  eid('dsPkOrg')?.addEventListener('change', async e => {
    _pkOrgUrl = e.target.value; _pkObj = ''; _pkField = ''; _pkInv = null;
    await _pkLoadObjects();
  });
  eid('dsPkObj')?.addEventListener('change', async e => {
    _pkObj = e.target.value; _pkField = ''; _pkInv = null;
    await _pkLoadFields();
  });
  eid('dsPkField')?.addEventListener('change', e => {
    _pkField = e.target.value;
    const btn = eid('dsPkLoad');
    if (btn) btn.disabled = !_pkField;
  });
  eid('dsPkLoad')?.addEventListener('click', () => loadPicklistInventory());

  if (_pkOrgUrl) _pkLoadObjects();
}

// Compare-mode config: org checkboxes + object/field (probed from the first
// selected org that's open) + "Load matrix" (P2).
function _pkRenderCompareConfig() {
  const orgs = allMapOrgs();
  // First visit: pre-select the Sync Ring (source of truth + targets) — the
  // multi-org matrix is exactly the ring's job (user directive 2026-07-17).
  if (!_pkCmpOrgs.length && typeof _ring === 'object' && (_ring?.orgs || []).length >= 2) {
    const known = new Set(orgs.map(o => _orgKey(o.url)));
    _pkCmpOrgs = _ring.orgs.filter(u => known.has(_orgKey(u)));
  }
  // The source of truth is a GIVEN, not a choice (user 2026-07-18: "i have
  // to select it in order to compare it?") — it never appears in the
  // checkbox list. It renders as a fixed line above, is silently kept in
  // _pkCmpOrgs so the matrix always loads it, and the checkboxes only pick
  // which orgs to compare AGAINST it.
  const _sotUrl = (typeof _ring === 'object' && _ring?.sourceUrl && (_ring.orgs || []).length >= 2)
    ? (orgs.find(o => _orgKey(o.url) === _orgKey(_ring.sourceUrl))?.url || '') : '';
  if (_sotUrl && !_pkCmpOrgs.some(u => _orgKey(u) === _orgKey(_sotUrl))) _pkCmpOrgs.push(_sotUrl);
  const sotOrg = _sotUrl ? orgs.find(o => _orgKey(o.url) === _orgKey(_sotUrl)) : null;
  // With no ring source this line used to render as NOTHING, so the screen
  // silently dropped the concept while the topbar still showed a Source chip
  // (user 2026-07-30: "same in the picklist manager"). Say the state out loud
  // and offer the one click that fixes it — an absent explanation reads as a
  // bug, and the matrix genuinely behaves differently without a golden org.
  const sotLine = sotOrg
    ? `<div class="ds-pk-sot-line" title="Always part of the comparison — every org below is compared against it. Change it in the topbar SOURCE menu.">
        Source of truth: <strong>${esc(orgOptionLabel(sotOrg.url, sotOrg.label))}</strong>
        ${(!_liveOrgSet().has(_orgKey(sotOrg.url))) ? '<span class="ds-pk-sot-warn">— open it in a Chrome tab, the matrix reads from it</span>' : ''}
      </div>`
    : `<div class="ds-pk-sot-line ds-pk-sot-unset">
        No source of truth set — the orgs you tick are compared side by side, with none treated as golden, and
        <strong>🔄 Sync from source</strong> has nothing to sync from.
        <button class="ds-btn ds-btn-xs" id="dsPkGoRing" style="margin-left:6px">Set one in Sync Ring</button>
      </div>`;
  const chks = orgs.filter(o => !(_sotUrl && _orgKey(o.url) === _orgKey(_sotUrl))).map(o =>
    `<label class="ds-pk-orgchk"><input type="checkbox" data-pk-cmporg="${esc(o.url)}" ${_pkCmpOrgs.includes(o.url) ? 'checked' : ''}> ${esc(orgOptionLabel(o.url, o.label))}</label>`).join('');
  const cfg = eid('dsPkConfig');
  if (!cfg) return;
  cfg.innerHTML = `
    <div class="ds-pk-cmp-config">
      <div class="ds-pk-cmp-orgs">
        ${sotLine}
        <div class="ds-pk-cmp-lbl">${sotOrg ? 'Compare against' : 'Orgs to compare'}</div>
        <div class="ds-pk-orgchk-list">${chks || 'No orgs known'}</div>
      </div>
      <div class="ds-pk-config">
        <select id="dsPkCmpObj" class="ds-select" ${_pkCmpObj ? '' : 'disabled'}>
          <option value="">${_pkCmpObj ? esc(_pkCmpObj) : 'Object…'}</option>
        </select>
        <select id="dsPkCmpField" class="ds-select" disabled><option value="">Field…</option></select>
        <button class="ds-btn ds-btn-primary" id="dsPkCmpLoad" disabled>Load matrix</button>
        <button class="ds-btn" id="dsPkSweep" ${_pkCmpObj ? '' : 'disabled'}
          title="Skip the field picker: compare EVERY picklist / multi-picklist field on this object across the selected orgs and give each one a verdict (in sync / values differ / RT assignment differs / missing / not comparable).">${dsIcon('wand')}Sweep whole object…</button>
      </div>
      <div id="dsPkMatrixCost" class="ds-pk-note ds-pk-note-tight"></div>
      <div id="dsPkSweepCost" class="ds-pk-note ds-pk-note-tight"></div>
    </div>`;

  eid('dsPkGoRing')?.addEventListener('click', () => {
    if (typeof navigateToView === 'function') navigateToView('ring');
  });

  cfg.querySelectorAll('[data-pk-cmporg]').forEach(c => c.addEventListener('change', () => {
    const url = c.dataset.pkCmporg;
    if (c.checked) { if (!_pkCmpOrgs.includes(url)) _pkCmpOrgs.push(url); }
    else _pkCmpOrgs = _pkCmpOrgs.filter(u => u !== url);
    _pkCmpCostRefresh();   // org count changed — re-estimate immediately
    _pkCmpLoadObjects();
  }));
  eid('dsPkCmpObj')?.addEventListener('change', async e => {
    _pkCmpObj = e.target.value; _pkCmpField = '';
    const sw = eid('dsPkSweep'); if (sw) sw.disabled = !_pkCmpObj;
    _pkCmpCostRefresh();   // stale-object picks are guarded out — clears the lines while fields load
    await _pkCmpLoadFields();
  });
  eid('dsPkCmpField')?.addEventListener('change', e => { _pkCmpField = e.target.value; const b = eid('dsPkCmpLoad'); if (b) b.disabled = !_pkCmpField; _pkCmpCostRefresh(); });
  eid('dsPkCmpLoad')?.addEventListener('click', () => _pkLoadMatrix());
  eid('dsPkSweep')?.addEventListener('click', () => _pkSweepObject());

  if (_pkCmpOrgs.length) _pkCmpLoadObjects();
}

// First selected compare org that is open in a tab (its describe seeds the
// object/field pickers; the chosen field name is applied to every org).
async function _pkCmpProbeSession() {
  for (const url of _pkCmpOrgs) {
    const s = await getOrgSession(url);
    if (s) return s;
  }
  return null;
}

async function _pkCmpLoadObjects() {
  const sel = eid('dsPkCmpObj');
  if (!sel) return;
  if (!_pkCmpOrgs.length) { sel.disabled = true; sel.innerHTML = '<option value="">Select orgs first…</option>'; return; }
  sel.disabled = true; sel.innerHTML = '<option value="">Loading objects…</option>';
  const sess = await _pkCmpProbeSession();
  if (!sess) { sel.innerHTML = '<option value="">No selected org is open in a tab</option>'; return; }
  const key = _orgKey(sess.orgUrl);
  if (!_pkObjCache[key]) {
    const res = await sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
      path: 'services/data/v62.0/sobjects' });
    if (res.error) { sel.innerHTML = `<option value="">${esc(res.error).slice(0, 60)}</option>`; return; }
    _pkObjCache[key] = (res.sobjects || [])
      .filter(o => o.queryable && o.updateable && !o.customSetting && !/^(.*__(Tag|Share|History|Feed|ChangeEvent))$/.test(o.name))
      .map(o => ({ name: o.name, label: o.label }));
  }
  sel.innerHTML = '<option value="">Object…</option>' + _pkObjCache[key]
    .map(o => `<option value="${esc(o.name)}" ${o.name === _pkCmpObj ? 'selected' : ''}>${esc(o.label)} (${esc(o.name)})</option>`).join('');
  sel.disabled = false;
  if (_pkCmpObj) _pkCmpLoadFields();
}

async function _pkCmpLoadFields() {
  const sel = eid('dsPkCmpField');
  if (!sel || !_pkCmpObj) return;
  sel.disabled = true; sel.innerHTML = '<option value="">Loading fields…</option>';
  const sess = await _pkCmpProbeSession();
  if (!sess) { sel.innerHTML = '<option value="">No selected org open</option>'; _pkCmpPicks = null; _pkCmpCostRefresh(); return; }
  const desc = await describe(_pkCmpObj, sess.orgUrl, sess.sid);
  const picks = (desc?.fields || []).filter(f => f.type === 'picklist' || f.type === 'multipicklist');
  // E4 — what the cost estimators need per field, from the probe describe:
  // custom vs standard, multi-select, and the ACTIVE value count (usage cost).
  _pkCmpPicks = { obj: _pkCmpObj, fields: picks.map(f => ({ name: f.name,
    isCustom: /__c$/i.test(f.name), isMulti: f.type === 'multipicklist',
    values: (f.picklistValues || []).length })) };
  if (!picks.length) { sel.innerHTML = '<option value="">No picklist fields on this object</option>'; _pkCmpCostRefresh(); return; }
  sel.innerHTML = '<option value="">Field…</option>' + picks
    .map(f => `<option value="${esc(f.name)}" ${f.name === _pkCmpField ? 'selected' : ''}>${esc(f.label)} (${esc(f.name)})${f.type === 'multipicklist' ? ' — multi' : ''}</option>`).join('');
  sel.disabled = false;
  const b = eid('dsPkCmpLoad'); if (b) b.disabled = !_pkCmpField;
  _pkCmpCostRefresh();
}

// ── E4 — cost + budget lines under the compare config ──────────
// Renders elId's line in two beats: the LOCAL estimate paints synchronously
// (it needs no helper and is never blocked), then — only if the shared budget
// reader window.sftkApiBudget (studio-transfer.js) exists — each org's own
// daily-quota meter is fetched and appended, labeled per org because every
// org has its OWN pool (pools are never summed). A helper that is missing
// leaves the plain estimate; one that returns null is SAID as "API budget
// unavailable". The token guard makes stale fetches lose to newer renders.
function _pkCostLine(elId, prefix, suffix, est, orgUrls) {
  const tok = (_pkCostTokens[elId] = (_pkCostTokens[elId] || 0) + 1);
  const el = eid(elId);
  if (!el) return;
  if (!est || !(est.total > 0)) { el.textContent = ''; return; }
  const paint = budgets => {
    const t = eid(elId);
    if (!t) return;
    const line = pkApiCostLine(est, budgets);
    t.textContent = `${prefix}${line.text}${suffix}`;
    t.style.color = line.warn ? 'var(--warning)' : '';
  };
  paint(null);
  if (typeof window.sftkApiBudget !== 'function') return;   // helper absent → estimate alone
  (async () => {
    const budgets = await Promise.all((orgUrls || []).map(async url => {
      const sess = await getOrgSession(url);
      const budget = sess ? await window.sftkApiBudget(sess.orgUrl, sess.sid) : null;
      return { label: orgLabel(url), budget, calls: est.perOrg };
    }));
    if (_pkCostTokens[elId] !== tok) return;   // a newer render won
    paint(budgets);
  })().catch(() => {});
}

// Recompute both lines from current selections. Estimates come from the probe
// org's describe (_pkCmpPicks) — other orgs can differ, which is exactly why
// every number is "≈" with the unknowns named, never silently precise.
function _pkCmpCostRefresh() {
  if (!eid('dsPkSweepCost') && !eid('dsPkMatrixCost')) return;
  const live = _liveOrgSet();
  const open = _pkCmpOrgs.filter(u => live.has(_orgKey(u)));
  const closedN = _pkCmpOrgs.length - open.length;
  const suffix = closedN ? ` · ${closedN} selected org(s) not open — skipped, no calls go there` : '';
  const picks = (_pkCmpPicks && _pkCmpPicks.obj === _pkCmpObj) ? _pkCmpPicks.fields : null;

  // Matrix line — needs a chosen field (P2 "Load matrix").
  let mxEst = null;
  const fm = picks ? picks.find(f => f.name === _pkCmpField) : null;
  if (fm && open.length) {
    mxEst = pkMatrixCallEstimate({ orgs: open.length, isCustom: fm.isCustom, isMulti: fm.isMulti, values: fm.values });
    mxEst.scope = `across ${open.length} org${open.length !== 1 ? 's' : ''}`;
  }
  _pkCostLine('dsPkMatrixCost', 'Load matrix: ', suffix, mxEst, open);

  // Sweep line — needs an object; the field list (capped like the sweep caps
  // it) comes from the probe describe.
  let swEst = null;
  if (_pkCmpObj && picks && picks.length && open.length) {
    const swept = picks.slice(0, 25);   // FIELD_CAP in _pkSweepObject
    swEst = pkSweepCallEstimate({ orgs: open.length, customFields: swept.filter(f => f.isCustom).length });
    swEst.scope = `across ${open.length} org${open.length !== 1 ? 's' : ''}`;
  }
  _pkCostLine('dsPkSweepCost', '🧹 Sweep: ', suffix, swEst, open);
}

// ── Pickers ─────────────────────────────────────────────────────
async function _pkLoadObjects() {
  const sel = eid('dsPkObj');
  if (!sel || !_pkOrgUrl) return;
  sel.disabled = true;
  sel.innerHTML = '<option value="">Loading objects…</option>';
  const key = _orgKey(_pkOrgUrl);
  if (!_pkObjCache[key]) {
    const sess = await getOrgSession(_pkOrgUrl);
    if (!sess) { sel.innerHTML = '<option value="">Org not open in a tab — open it and retry</option>'; return; }
    const res = await sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
      path: 'services/data/v62.0/sobjects' });
    if (res.error) { sel.innerHTML = `<option value="">${esc(res.error).slice(0, 60)}</option>`; return; }
    _pkObjCache[key] = (res.sobjects || [])
      .filter(o => o.queryable && o.updateable && !o.customSetting && !/^(.*__(Tag|Share|History|Feed|ChangeEvent))$/.test(o.name))
      .map(o => ({ name: o.name, label: o.label }));
  }
  sel.innerHTML = '<option value="">Object…</option>' + _pkObjCache[key]
    .map(o => `<option value="${esc(o.name)}" ${o.name === _pkObj ? 'selected' : ''}>${esc(o.label)} (${esc(o.name)})</option>`).join('');
  sel.disabled = false;
  if (_pkObj) _pkLoadFields();
}

async function _pkLoadFields() {
  const sel = eid('dsPkField');
  if (!sel || !_pkObj) return;
  sel.disabled = true;
  sel.innerHTML = '<option value="">Loading fields…</option>';
  const sess = await getOrgSession(_pkOrgUrl);
  if (!sess) { sel.innerHTML = '<option value="">Org not open</option>'; return; }
  const desc = await describe(_pkObj, sess.orgUrl, sess.sid);
  const picks = (desc?.fields || []).filter(f => f.type === 'picklist' || f.type === 'multipicklist');
  if (!picks.length) { sel.innerHTML = '<option value="">No picklist fields on this object</option>'; return; }
  sel.innerHTML = '<option value="">Field…</option>' + picks
    .map(f => `<option value="${esc(f.name)}" ${f.name === _pkField ? 'selected' : ''}>${esc(f.label)} (${esc(f.name)})${f.type === 'multipicklist' ? ' — multi' : ''}</option>`).join('');
  sel.disabled = false;
  const btn = eid('dsPkLoad');
  if (btn) btn.disabled = !_pkField;
}

// ── Inventory load ──────────────────────────────────────────────
// Load usage counts for a value set on a field (shared by single + matrix + P4).
// Single picklist: one GROUP BY. Multipicklist: one INCLUDES count per value (capped).
async function _pkLoadUsage(sess, obj, field, isMulti, rawValues) {
  const usage = new Map();
  let usageNote = '', nullCount = 0, totalCount = 0;
  if (!isMulti) {
    const agg = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false,
      query: `SELECT ${field} pv, COUNT(Id) cnt FROM ${obj} GROUP BY ${field}` });
    if (agg.error) { usageNote = `Usage counts unavailable: ${agg.error}`; }
    else for (const r of (agg.records || [])) {
      const v = r.pv ?? r[field];
      const c = r.cnt ?? r.expr0 ?? 0;
      totalCount += c;
      if (v == null) nullCount = c; else usage.set(String(v), c);
    }
    if ((agg.records || []).length >= 2000) usageNote = 'Object has >2000 distinct values — counts may be partial.';
    // A value no record holds is absent from the GROUP BY answer — that is a
    // counted ZERO, not "not counted" (live 2026-09-23: "New" read "—", the
    // same mark as a failed count, while 0 records held it).
    if (!agg.error && (agg.records || []).length < 2000) {
      for (const v of (rawValues || [])) { const name = pkValueName(v); if (!usage.has(name)) usage.set(name, 0); }
    }
  } else {
    const CAP = 30;
    for (const v of rawValues.slice(0, CAP)) {
      const name = pkValueName(v);
      const r = await sendBg({ type: 'SF_REST_QUERY', orgUrl: sess.orgUrl, sid: sess.sid,
        query: `SELECT COUNT() FROM ${obj} WHERE ${field} INCLUDES (${soqlStrLit(name)})` });
      usage.set(name, r.error ? -1 : (r.totalSize ?? 0));
    }
    if (rawValues.length > CAP) usageNote = `Counted the first ${CAP} of ${rawValues.length} values (multi-select counts are one query each).`;
  }
  return { usage, usageNote, nullCount, totalCount };
}

// Load record types + this field's per-RT value assignments (cap the fetches).
async function _pkLoadRecordTypes(sess, obj, field, devName) {
  let rts = [], rtNote = '';
  const rtRes = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false,
    query: `SELECT Id, Name, DeveloperName, IsActive FROM RecordType WHERE SObjectType = ${soqlStrLit(obj)}` });
  const rtRows = (rtRes.records || []).filter(r => r.IsActive);
  const RT_CAP = 8;
  for (const rt of rtRows.slice(0, RT_CAP)) {
    const meta = await sendBg({ type: 'SF_TOOLING_GET', orgUrl: sess.orgUrl, sid: sess.sid,
      sobject: 'RecordType', id: rt.Id });
    const plEntry = (meta?.Metadata?.picklistValues || []).find(p =>
      p.picklist === field || p.picklist === devName);
    rts.push({ id: rt.Id, name: rt.Name, devName: rt.DeveloperName, values: new Set((plEntry?.values || []).map(v => pkValueName(v))) });
  }
  if (rtRows.length > RT_CAP) rtNote = `Showing ${RT_CAP} of ${rtRows.length} record types.`;
  return { rts, rtNote };
}

// Fetch a field's full picklist inventory for one org session. Returns:
//   { kind:'local',  inv }                            — editable custom local value set
//   { kind:'standard', field, obj, isMulti }          — standard picklist (P4a)
//   { kind:'global', field, obj, isMulti, fieldId, metadata, name } — global value set (P4b)
// Throws on hard errors. No DOM — reused by single load AND the multi-org matrix.
// opts (T9): { skipUsage, skipRts } — the whole-object sweep reads 25 fields ×
// N orgs, so it opts out of the per-field usage GROUP BY and the per-field
// RecordType fetches (it loads RT metadata ONCE per org instead). The skipped
// work is reported in the UI, never silently dropped.
async function _pkFetchInventory(sess, obj, field, opts) {
  const o = opts || {};
  const desc = await describe(obj, sess.orgUrl, sess.sid);
  const fieldMeta = (desc?.fields || []).find(f => f.name === field);
  // The describe lists only fields the running user can see (live 2026-09-23:
  // a field deployed by the Metadata API, no FLS yet, read "not found").
  if (!fieldMeta) throw new Error(`${field} not found on ${obj} — or hidden from your user by field-level security (the org's describe does not list it)`);
  const isMulti = fieldMeta.type === 'multipicklist';

  // Standard picklists have no Tooling CustomField — route to the StandardValueSet path.
  if (!/__c$/i.test(field)) return { kind: 'standard', field, obj, isMulti };

  // Tooling: resolve the CustomField id, then fetch full Metadata (the only
  // way to see INACTIVE values — describe returns active ones only).
  const devName = field.replace(/__c$/i, '');
  const idRes = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true,
    query: `SELECT Id, TableEnumOrId FROM CustomField WHERE DeveloperName = ${soqlStrLit(devName)}` });
  if (idRes.error) throw new Error(idRes.error);
  let rows = idRes.records || [];
  if (rows.length > 1) {
    const ent = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true,
      query: `SELECT DurableId FROM EntityDefinition WHERE QualifiedApiName = ${soqlStrLit(obj)}` });
    const durable = (ent.records || [])[0]?.DurableId;
    rows = rows.filter(r => r.TableEnumOrId === obj || (durable && r.TableEnumOrId === durable));
  }
  const fieldId = rows[0]?.Id;
  if (!fieldId) throw new Error('Could not locate this field in the Tooling API (Customize Application permission needed).');

  const cf = await sendBg({ type: 'SF_TOOLING_GET', orgUrl: sess.orgUrl, sid: sess.sid,
    sobject: 'CustomField', id: fieldId });
  if (cf.error || !cf.Metadata) throw new Error(cf.error || 'Field metadata unavailable');

  if (cf.Metadata.valueSet?.valueSetName) {
    return { kind: 'global', field, obj, isMulti, fieldId, metadata: cf.Metadata, name: cf.Metadata.valueSet.valueSetName };
  }
  const rawValues = cf.Metadata.valueSet?.valueSetDefinition?.value || [];
  if (!rawValues.length) throw new Error('No values found in this field\'s value set.');

  const { usage, usageNote, nullCount, totalCount } = o.skipUsage
    ? { usage: new Map(), usageNote: 'Record counts were NOT loaded for this read.', nullCount: 0, totalCount: 0 }
    : await _pkLoadUsage(sess, obj, field, isMulti, rawValues);
  const { rts, rtNote } = o.skipRts
    ? { rts: [], rtNote: 'Record types were NOT loaded for this read.' }
    : await _pkLoadRecordTypes(sess, obj, field, devName);

  const inv = {
    orgUrl: sess.orgUrl, sid: sess.sid, obj, field, devName, fieldId, isMulti,
    metadata: cf.Metadata, rawValues, usage, usageNote, nullCount, totalCount, rts, rtNote,
  };
  return { kind: 'local', inv };
}

async function loadPicklistInventory() {
  const body = eid('dsPkBody');
  if (!body || !_pkOrgUrl || !_pkObj || !_pkField) return;
  body.innerHTML = `<div class="ds-init-loading">${window.sftkCat ? sftkCat('Reading values, usage & record types…') : 'Loading…'}</div>`;

  const sess = await getOrgSession(_pkOrgUrl);
  if (!sess) { body.innerHTML = `<div class="ds-seq-empty">Org isn't open in a Chrome tab — open it, then reload.</div>`; return; }

  try {
    const r = await _pkFetchInventory(sess, _pkObj, _pkField);
    if (r.kind === 'standard') return _pkLoadStandard(sess, r.field, r.obj, r.isMulti);
    if (r.kind === 'global')   return _pkLoadGlobal(sess, r);
    _pkInv = r.inv;
    _pkRenderInventory();
  } catch (e) {
    const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(e.message) : { message: e.message };
    body.innerHTML = `<div class="ds-seq-empty" title="${esc(e.message)}">❌ ${esc(fe.message)}${fe.hint ? `<div class="ds-pk-hint">💡 ${esc(fe.hint)}</div>` : ''}</div>`;
  }
}

// ── Inventory render ────────────────────────────────────────────
function _pkRenderInventory() {
  const body = eid('dsPkBody');
  const inv = _pkInv;
  if (!body || !inv) return;

  const maxCount = Math.max(1, ...inv.usage.values());
  const rowsHtml = inv.rawValues.map((v, i) => {
    const name   = pkValueName(v);
    const active = v.isActive !== false;
    const count  = inv.usage.has(name) ? inv.usage.get(name) : null;
    const rtChips = inv.rts.filter(rt => rt.values.has(name))
      .map(rt => `<span class="ds-pk-rt" title="Assigned to record type ${esc(rt.name)}">${esc(rt.name)}</span>`).join('');
    return `
      <div class="ds-pk-row${active ? '' : ' ds-pk-row-inactive'}" data-pk-val="${esc(name)}">
        <div class="ds-pk-val">
          <span class="ds-pk-name">${esc(v.label || name)}</span>
          ${v.label && v.label !== name ? `<code class="ds-pk-api">${esc(name)}</code>` : ''}
          ${v.default ? '<span class="ds-pk-default">default</span>' : ''}
          ${active ? '' : '<span class="ds-pk-inactive-badge">inactive</span>'}
        </div>
        <div class="ds-pk-usage" title="${count == null ? 'not counted' : count === -1 ? 'count failed' : count.toLocaleString() + ' record(s) hold this value'}">
          ${count == null ? '<span class="ds-pk-uncounted">—</span>'
            : count === -1 ? '<span class="ds-pk-uncounted">?</span>'
            : `<span class="ds-pk-bar"><span class="ds-pk-fill" style="width:${Math.max(2, Math.round(count / maxCount * 100))}%"></span></span>
               <span class="ds-pk-count">${count.toLocaleString()}</span>`}
        </div>
        <div class="ds-pk-rts">${rtChips || '<span class="ds-pk-uncounted">—</span>'}</div>
        <div class="ds-pk-actions">
          ${(count > 0) ? `<button class="ds-btn ds-btn-sm" data-pk-fix="${i}" title="Move the ${count.toLocaleString()} record(s) holding this value to another value (or clear them)">🔧 Fix data…</button>` : ''}
          <button class="ds-btn ds-btn-sm" data-pk-toggle="${i}">${active ? '⏸ Deactivate' : '▶ Activate'}</button>
          <button class="ds-btn ds-btn-sm ds-btn-danger" data-pk-del="${i}" title="Remove the value from the value set entirely">🗑</button>
        </div>
      </div>`;
  }).join('');

  const activeN   = inv.rawValues.filter(v => v.isActive !== false).length;
  const inactiveN = inv.rawValues.length - activeN;

  body.innerHTML = `
    <div class="ds-pk-summary">
      <strong>${inv.rawValues.length}</strong> value${inv.rawValues.length !== 1 ? 's' : ''}
      (${activeN} active${inactiveN ? `, ${inactiveN} inactive` : ''})
      ${inv.isMulti ? ' · multi-select' : ''}
      ${!inv.isMulti && inv.totalCount ? ` · ${inv.totalCount.toLocaleString()} records total` : ''}
      ${inv.nullCount ? ` · ${inv.nullCount.toLocaleString()} blank` : ''}
      ${prodBadge(inv.orgUrl)}
    </div>
    ${inv.usageNote ? `<div class="ds-pk-note">⚠ ${esc(inv.usageNote)}</div>` : ''}
    ${inv.rtNote ? `<div class="ds-pk-note">${esc(inv.rtNote)}</div>` : ''}
    <div class="ds-pk-table">
      <div class="ds-pk-head">
        <div class="ds-pk-val">Value</div><div class="ds-pk-usage">Records</div>
        <div class="ds-pk-rts">Record types</div><div class="ds-pk-actions"></div>
      </div>
      ${rowsHtml}
    </div>
    ${_pkRtMatrixHtml(inv)}`;

  body.querySelectorAll('[data-pk-fix]').forEach(b =>
    b.addEventListener('click', () => _pkOpenWizard(parseInt(b.dataset.pkFix, 10), 'fix')));
  body.querySelectorAll('[data-pk-toggle]').forEach(b =>
    b.addEventListener('click', () => _pkOpenWizard(parseInt(b.dataset.pkToggle, 10), 'toggle')));
  body.querySelectorAll('[data-pk-del]').forEach(b =>
    b.addEventListener('click', () => _pkOpenWizard(parseInt(b.dataset.pkDel, 10), 'delete')));
  _pkWireRtMatrix(inv, body);

  _pkApplyHighlight();   // deep link from another view (window.sftkOpenPicklistFix)

  // Surface Salesforce's automatic RT drop after a just-applied deactivate (P3).
  if (_pkPendingRtCheck) {
    const { name, pre } = _pkPendingRtCheck;
    _pkPendingRtCheck = null;
    const post = inv.rts.filter(rt => rt.values.has(name)).length;
    if (pre > post) showToast(`ℹ Salesforce removed “${name}” from ${pre - post} record type(s) on deactivation`, 'info', 6000);
  }
}

// ── Record-type assignment matrix (editable — P3) ───────────────
// A value×RT grid of checkboxes; ticking adds / unticking removes the value
// from that record type via a RecordType Tooling Metadata PATCH.
function _pkRtMatrixHtml(inv) {
  if (!inv.rts || !inv.rts.length) return '';
  const activeVals = inv.rawValues.filter(v => v.isActive !== false).map(v => pkValueName(v));
  if (!activeVals.length) return '';
  const head = `<div class="ds-pk-rtm-row ds-pk-rtm-head">
      <div class="ds-pk-rtm-val">Value</div>
      ${inv.rts.map(rt => `<div class="ds-pk-rtm-col" title="${esc(rt.name)}">${esc(rt.name)}</div>`).join('')}
    </div>`;
  const rows = activeVals.map(name => `
    <div class="ds-pk-rtm-row">
      <div class="ds-pk-rtm-val">${esc(name)}</div>
      ${inv.rts.map(rt => `<div class="ds-pk-rtm-col">
        <input type="checkbox" class="ds-pk-rtm-chk" data-rt="${esc(rt.id)}" data-val="${esc(name)}" ${rt.values.has(name) ? 'checked' : ''}>
      </div>`).join('')}
    </div>`).join('');
  return `
    <div class="ds-pk-rtmatrix">
      <div class="ds-pk-rtm-title">🧩 Record-type assignments <span class="ds-pk-note-inline">tick to add · untick to remove · then Apply</span></div>
      <div class="ds-pk-rtm-grid" style="--pk-rt-cols:${inv.rts.length}">${head}${rows}</div>
      <div class="ds-pk-rtm-actions">
        <button class="ds-btn ds-btn-sm ds-btn-primary" id="dsPkRtApply" disabled>Apply record-type changes</button>
        <span class="ds-pk-rtm-dirty" id="dsPkRtDirty"></span>
      </div>
    </div>`;
}

function _pkReadRtMatrix(scope) {
  const edited = new Map();
  scope.querySelectorAll('.ds-pk-rtm-chk').forEach(c =>
    edited.set(`${c.dataset.rt}|${c.dataset.val}`, c.checked));
  return edited;
}

function _pkWireRtMatrix(inv, body) {
  const applyBtn = eid('dsPkRtApply');
  const dirtyEl = eid('dsPkRtDirty');
  if (!applyBtn) return;
  const refresh = () => {
    const diffs = pkRtMatrixDiff(inv.rts, _pkReadRtMatrix(body));
    const n = diffs.reduce((s, d) => s + d.adds.length + d.removes.length, 0);
    applyBtn.disabled = n === 0;
    if (dirtyEl) dirtyEl.textContent = n ? `${n} pending change(s) across ${diffs.length} record type(s)` : '';
  };
  body.querySelectorAll('.ds-pk-rtm-chk').forEach(c => c.addEventListener('change', refresh));
  // The one confirmation (sftk-confirm.js, campaign 3 phase 2): names each
  // changed record type and its adds/removes; a production target asks for
  // its name, replacing the old confirmTypedProd() call.
  applyBtn.addEventListener('click', async () => {
    const diffs = pkRtMatrixDiff(inv.rts, _pkReadRtMatrix(body));
    if (!diffs.length) return;
    const rtNameById = new Map((inv.rts || []).map(rt => [rt.id, rt.name]));
    const items = diffs.map(d => ({
      label: rtNameById.get(d.rtId) || d.rtId,
      sub: [d.adds.length ? `+${d.adds.join(', ')}` : '', d.removes.length ? `-${d.removes.join(', ')}` : ''].filter(Boolean).join(' · '),
    }));
    const gate = await sftkOrgWriteGate(inv.orgUrl, _orgs);
    const ok = await sftkConfirmDestructive({
      title: `Apply record-type picklist assignments — ${inv.obj}.${inv.field}`,
      icon: '🧩',
      items,
      revOverride: { html: '🔁 <strong>Reversible</strong> — record-type assignments can be changed again the same way.', needsCheckbox: false },
      confirmLabel: 'Apply record-type changes',
      production: gate.production ? { label: gate.label } : null,
    });
    if (!ok) return;
    _pkApplyRt(inv, diffs);
  });
}

// Apply RT assignment diffs — one RecordType Metadata PATCH per changed RT.
async function _pkApplyRt(inv, diffs) {
  let ok = 0, fail = 0;
  const errs = [];
  // History (sftk-history.js): one journal for this button press, even
  // though it can touch several record types — each successful PATCH's
  // previous assignment becomes one undo step.
  const journal = sftkHistoryBegin({ tool: 'Picklist Manager',
    title: `🧩 ${inv.obj}.${inv.field} record-type assignments (${diffs.length} type${diffs.length === 1 ? '' : 's'})`, orgUrl: inv.orgUrl });
  const applied = [];
  try {
    for (const d of diffs) {
      try { const r = await _pkApplyRtCore(inv, d.rtId, d.adds, d.removes, journal); ok++; applied.push(r); }
      catch (e) { fail++; if (errs.length < 5) errs.push(e.message); }
    }
  } finally {
    const steps = applied.map(r => ({
      describe: `${inv.obj}.${inv.field}: write record type ${r.rtName || r.rtId}'s previous assignments back`,
      // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
      msg: { type: 'SF_PATCH', path: `services/data/v62.0/tooling/sobjects/RecordType/${r.rtId}`, body: { Metadata: r.before } },
      verify: { query: `SELECT Id, Metadata FROM RecordType WHERE Id = '${r.rtId}'`, tooling: true,
        pick: 'records.0.Metadata.picklistValues', where: { field: 'picklist', equals: inv.field },
        field: 'values', notNull: true,
        text: { ok: `Record type ${r.rtName || r.rtId}: previous ${inv.field} assignments written back — verified by re-reading the record type`,
                bad: `Record type ${r.rtName || r.rtId}: the previous assignments were accepted, but the record type could not be re-read to confirm ${inv.field} is still assigned` } },
    }));
    await sftkHistoryEnd(journal, { undo: steps.length ? { steps } : { none: 'nothing was applied' } });
  }
  showToast(fail === 0
    ? `✅ Updated ${ok} record type(s)`
    : `⚠ ${ok} updated, ${fail} failed${errs.length ? ' — ' + errs[0] : ''}`, fail ? 'warning' : 'success', 6000);
  loadPicklistInventory();
}

// Add/remove a field's values on one record type via its Tooling Metadata.
async function _pkApplyRtCore(inv, rtId, adds, removes, journal) {
  const meta = await sendBg({ type: 'SF_TOOLING_GET', orgUrl: inv.orgUrl, sid: inv.sid, sobject: 'RecordType', id: rtId });
  if (meta?.error || !meta?.Metadata) throw new Error(meta?.error || 'RecordType metadata unavailable');
  // History (sftk-history.js): the undo writes this snapshot back.
  const before = JSON.parse(JSON.stringify(meta.Metadata));
  const md = JSON.parse(JSON.stringify(meta.Metadata));
  md.picklistValues = md.picklistValues || [];
  let entry = md.picklistValues.find(p => p.picklist === inv.field || p.picklist === inv.devName);
  if (!entry) { entry = { picklist: inv.field, values: [] }; md.picklistValues.push(entry); }
  entry.values = entry.values || [];
  const remSet = new Set(removes);
  entry.values = entry.values.filter(v => !remSet.has(pkValueName(v)));
  const present = new Set(entry.values.map(v => pkValueName(v)));
  for (const a of adds) if (!present.has(a)) entry.values.push({ valueName: a });
  const wantNames = new Set(entry.values.map(v => pkValueName(v)));
  // The one write discipline (sftk-write.js): the PATCH's 204 used to BE the
  // report — a RecordType Metadata write that Salesforce silently dropped
  // (or partially applied) would still have shown "Updated". One re-read of
  // the same RecordType's Metadata closes that gap.
  // confirmed-by: _pkWireRtMatrix's Apply button, and _pkOpenSyncPlan's Run
  // (via _pkRunSyncPlan) — both confirm via sftkConfirmDestructive first.
  const w = await sftkWriteVerified({
    describe: `${inv.obj}.${inv.field} on record type ${rtId}`,
    write: () => sendBg({ type: 'SF_PATCH', orgUrl: inv.orgUrl, sid: inv.sid,
      path: `services/data/v62.0/tooling/sobjects/RecordType/${rtId}`, body: { Metadata: sftkMetaForPatch(md) } }),
    journal: journal || null,   // history-by: the caller's entry (RT matrix: _pkApplyRt; sync plan: _pkRunSyncPlan)
    verify: async () => {
      const m2 = await sendBg({ type: 'SF_TOOLING_GET', orgUrl: inv.orgUrl, sid: inv.sid, sobject: 'RecordType', id: rtId });
      if (m2?.error || !m2?.Metadata) return { ok: false, text: `${inv.obj}.${inv.field} on record type ${rtId}: accepted by Salesforce, but the org could not be re-read to confirm it (${m2?.error || 'no metadata'})` };
      const e2 = (m2.Metadata.picklistValues || []).find(p => p.picklist === inv.field || p.picklist === inv.devName);
      const nowNames = new Set((e2?.values || []).map(v => pkValueName(v)));
      const match = nowNames.size === wantNames.size && [...wantNames].every(n => nowNames.has(n));
      return match ? { ok: true } : { ok: false, text: `${inv.obj}.${inv.field} on record type ${rtId}: accepted by Salesforce, but the org still shows different values assigned` };
    },
  });
  if (!w.ok) throw new Error(w.raw?.error || w.text || 'RecordType update refused');
  return { ok: true, rtId, before };
}

// ── Automation-impact panel data ────────────────────────────────
async function _pkImpact(inv) {
  const lit = soqlStrLit(inv.obj);
  const [trg, vr, wf, fdv] = await Promise.all([
    sendBg({ type: 'SF_QUERY_ALL', orgUrl: inv.orgUrl, sid: inv.sid, tooling: true,
      query: `SELECT Name FROM ApexTrigger WHERE TableEnumOrId = ${lit} AND Status = 'Active'`, _silentError: true }),
    sendBg({ type: 'SF_QUERY_ALL', orgUrl: inv.orgUrl, sid: inv.sid, tooling: true,
      query: `SELECT ValidationName FROM ValidationRule WHERE Active = true AND EntityDefinition.QualifiedApiName = ${lit}`, _silentError: true }),
    sendBg({ type: 'SF_QUERY_ALL', orgUrl: inv.orgUrl, sid: inv.sid, tooling: true,
      query: `SELECT Name FROM WorkflowRule WHERE TableEnumOrId = ${lit}`, _silentError: true }),
    sendBg({ type: 'SF_QUERY_ALL', orgUrl: inv.orgUrl, sid: inv.sid, tooling: false,
      query: `SELECT Label FROM FlowDefinitionView WHERE IsActive = true AND TriggerObjectOrEventApiName = ${lit}`, _silentError: true }),
  ]);
  const names = (res, k) => (res && !res.error && res.records) ? res.records.map(r => r[k]).filter(Boolean) : null;
  return {
    triggers: names(trg, 'Name'),
    validationRules: names(vr, 'ValidationName'),
    workflowRules: names(wf, 'Name'),
    flows: names(fdv, 'Label'),   // null = couldn't enumerate (old API) — say so
  };
}

function _pkImpactHtml(impact, recordCount, literal) {
  const row = (icon, label, list) => list === null
    ? `<div class="ds-pk-imp-row">${icon} ${label}: <em>couldn't check</em></div>`
    : `<div class="ds-pk-imp-row${list.length ? ' ds-pk-imp-hit' : ''}">${icon} ${label}: <strong>${list.length}</strong>${list.length ? ` — ${esc(list.slice(0, 4).join(', '))}${list.length > 4 ? '…' : ''}` : ''}</div>`;
  const litRow = literal
    ? `<div class="ds-pk-imp-row${literal.mentions ? ' ds-pk-imp-hit' : ''}">🔎 Automations mentioning this value <em>by name</em>: <strong>${literal.mentions}</strong></div>
       ${_pkAutomationHitsHtml(literal)}`
    : '';
  return `
    <div class="ds-pk-impact">
      <div class="ds-pk-imp-title">⚡ Updating ${recordCount.toLocaleString()} record(s) will run the object's automation:</div>
      ${row('⚡', 'Active triggers', impact.triggers)}
      ${row('🌊', 'Record-triggered flows', impact.flows)}
      ${row('✅', 'Validation rules', impact.validationRules)}
      ${row('⚙️', 'Workflow rules', impact.workflowRules)}
      ${litRow}
      <div class="ds-pk-imp-hint">💡 Validation rules can reject rows (they'll show as row errors);
      triggers and flows WILL fire — schedule big fixes for quiet hours. Automations that name the
      value literally may need editing too (they won't auto-update).</div>
    </div>`;
}

// Supplemental "N automations mention this value by name" scan (P2, widened +
// made actionable in T8, made COMPLETE in campaign 3 phase 6). Greps the
// serialized Metadata of:
//   · every ACTIVE validation rule on the object, and
//   · every ACTIVE flow (autolaunched — record-triggered and scheduled flows
//     are autolaunched — and screen flows), record-triggered on THIS object
//     listed first. No cap: before 2026-09-29 only the first 40 were read, one
//     query each, and the record-triggered listing filtered on a column
//     FlowDefinitionView does not have (TriggerObjectOrEventApiName — "could
//     NOT be enumerated" on every org). Now ONE listing, ONE query for the
//     active version Ids, and the Metadata read 25 flows per Tooling
//     composite/batch call.
// Every hit carries the component's Id so the UI can deep-link it (Flow Builder
// / Setup). Nothing degrades silently: whatever could NOT be read comes back in
// `notes` for the UI to print. onProgress(text) is optional.
// Returns { mentions, hits:[label], items:[{kind,id,label,sub,url}], notes:[], scan:{…} }.
async function _pkValueLiteralScan(ctx, valueName, onProgress) {
  const lit = soqlStrLit(ctx.obj);
  const BATCH = 25;
  const say = t => { try { if (typeof onProgress === 'function') onProgress(t); } catch (_) {} };
  const hits = [], items = [], notes = [];
  let mentions = 0;

  // 1) Active validation rules on the object (Id → Object Manager deep link).
  const vr = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: ctx.orgUrl, sid: ctx.sid, tooling: true,
    query: `SELECT Id, ValidationName, Metadata FROM ValidationRule WHERE Active = true AND EntityDefinition.QualifiedApiName = ${lit}`, _silentError: true });
  const vrOk = !!(vr && !vr.error);
  if (!vrOk) notes.push(`validation rules could NOT be scanned${vr?.error ? ` (${vr.error})` : ''}`);
  else for (const r of (vr.records || [])) {
    if (pkValueMentions(JSON.stringify(r.Metadata || {}), valueName) > 0) {
      mentions++;
      hits.push('VR: ' + r.ValidationName);
      items.push({ kind: 'vr', id: r.Id, label: r.ValidationName, sub: `validation rule on ${ctx.obj}`,
        url: pkAutomationUrl(ctx.orgUrl, ctx.obj, 'vr', r.Id) });
    }
  }

  // 2) Every active flow, ONE listing, with its active version Id.
  //    TriggerObjectOrEventId carries the object's API name for a standard
  //    object ("Account") and its entity Id for a custom one — both accepted.
  //    Managed-package (installed) flows: Salesforce does not expose their
  //    Metadata (their ActiveVersionId is not even a record Id, e.g.
  //    "PgmApps__CreaApplnAndActnPln-1" — live 2026-09-29, 100 of 163 in an
  //    NPC org) and they cannot be edited in the org; they are counted and
  //    said, never requested.
  const objIds = new Set([ctx.obj]);
  if (/__(c|mdt|e|x|b)$/i.test(ctx.obj)) {
    const ent = await sendBg({ type: 'SF_QUERY', orgUrl: ctx.orgUrl, sid: ctx.sid, tooling: true,
      query: `SELECT DurableId FROM EntityDefinition WHERE QualifiedApiName = ${lit}`, _silentError: true });
    for (const r of ((ent && ent.records) || [])) if (r.DurableId) objIds.add(r.DurableId);
  }
  const defs = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: ctx.orgUrl, sid: ctx.sid, tooling: false,
    query: `SELECT ApiName, Label, ProcessType, TriggerType, TriggerObjectOrEventId, ActiveVersionId, ManageableState FROM FlowDefinitionView WHERE IsActive = true AND ProcessType IN ('AutoLaunchedFlow','Flow')`, _silentError: true });
  const queue = [];
  let installedN = 0;
  if (!defs || defs.error) notes.push(`active flows could NOT be listed${defs?.error ? ` (${defs.error})` : ''} — no flow was checked`);
  else {
    const all = (defs.records || []).filter(f => f && f.ApiName);
    installedN = all.filter(f => f.ManageableState === 'installed').length;
    const own = all.filter(f => f.ManageableState !== 'installed');
    const onObj = f => /^Record/.test(String(f.TriggerType || '')) && objIds.has(String(f.TriggerObjectOrEventId || ''));
    const why = f => onObj(f) ? `record-triggered on ${ctx.obj}` : /^Record/.test(String(f.TriggerType || '')) ? 'record-triggered flow'
      : f.TriggerType === 'Scheduled' ? 'scheduled flow' : f.ProcessType === 'Flow' ? 'screen flow' : 'autolaunched flow';
    for (const f of [...own.filter(onObj), ...own.filter(f => !onObj(f))]) queue.push({ apiName: f.ApiName, label: f.Label, why: why(f), verId: f.ActiveVersionId || null });
  }
  const triggeredN = queue.filter(q => q.why === `record-triggered on ${ctx.obj}`).length;

  // 3) The Metadata of each active version, 25 per Tooling composite/batch call.
  let flowsRead = 0, flowErrors = queue.filter(f => !f.verId).length;
  const readable = queue.filter(f => f.verId);
  for (let k = 0; k < readable.length; k += BATCH) {
    const chunk = readable.slice(k, k + BATCH);
    say(`reading flow metadata ${Math.min(k + chunk.length, readable.length)} / ${readable.length}…`);
    const res = await sendBg({ type: 'SF_COMPOSITE_BATCH', orgUrl: ctx.orgUrl, sid: ctx.sid, concurrency: 1, _suppressError: true,
      subrequests: chunk.map(f => ({ method: 'GET', url: `tooling/sobjects/Flow/${f.verId}` })) });
    if (!Array.isArray(res)) { flowErrors += chunk.length; continue; }
    chunk.forEach((f, n) => {
      const it = res[n];
      const meta = it && it.ok && it.body && typeof it.body === 'object' ? it.body.Metadata : null;
      if (!meta) { flowErrors++; return; }
      flowsRead++;
      if (pkValueMentions(JSON.stringify(meta), valueName) > 0) {
        mentions++;
        hits.push('Flow: ' + (f.label || f.apiName));
        items.push({ kind: 'flow', id: f.verId, label: f.label || f.apiName, sub: f.why,
          url: pkAutomationUrl(ctx.orgUrl, ctx.obj, 'flow', f.verId) });
      }
    });
  }
  if (flowErrors) notes.push(`scanned ${flowsRead} of ${queue.length} of this org's active flows — ${flowErrors} returned no readable metadata and were NOT checked`);
  if (installedN) notes.push(`${installedN} active flow(s) come from installed packages — Salesforce does not expose their metadata, so they were NOT checked (they cannot be edited in this org either)`);

  return { mentions, hits, items, notes,
    scan: { vrOk, vrCount: vrOk ? (vr.records || []).length : 0,
      flowsScanned: flowsRead, flowsFound: queue.length, installed: installedN, triggeredN, cap: null } };
}

// Render literal-scan hits as ACTIONABLE rows — each one deep-links into Flow
// Builder / Setup so "12 automations mention this value" stops being a dead end
// (T8a). Always prints what was scanned and what was skipped.
function _pkAutomationHitsHtml(literal) {
  if (!literal) return '';
  const rows = (literal.items || []).map(it => {
    const icon = it.kind === 'flow' ? '🌊' : '✅';
    const link = it.url
      ? `<a href="${esc(it.url)}" target="_blank" rel="noopener" title="Open in ${it.kind === 'flow' ? 'Flow Builder' : 'Setup'}">↗ open</a>`
      : `<span style="color:var(--warning)">no id returned — open it manually in Setup</span>`;
    return `<div class="ds-pk-imp-row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <span>${icon}</span><strong>${esc(it.label)}</strong>
      <span style="font-size:11px;color:var(--subtext)">${esc(it.sub || '')}</span>
      <span style="flex:1"></span>${link}</div>`;
  }).join('');
  const notes = (literal.notes || []).length
    ? `<div class="ds-pk-imp-row" style="color:var(--warning)">⚠ ${esc(literal.notes.join(' · '))}</div>` : '';
  const s = literal.scan;
  const scanned = s
    ? `<div class="ds-pk-imp-row" style="font-size:11px;color:var(--subtext)">Scanned ${s.flowsScanned} active flow(s) (${s.triggeredN} record-triggered on this object, plus autolaunched + screen flows org-wide) and ${s.vrOk ? `${s.vrCount} active validation rule(s)` : 'NO validation rules — that query failed'}. Apex triggers and managed code are NOT text-scanned.</div>`
    : '';
  return `${rows}${notes}${scanned}`;
}

// The "no records hold this value" case still needs the automation panel (T8):
// zero data does NOT mean zero references — a flow or validation rule that
// compares against the literal keeps compiling and silently stops matching.
function _pkLiteralOnlyHtml(literal, valueName) {
  if (!literal) return '';
  return `
    <div class="ds-pk-impact">
      <div class="ds-pk-imp-title">🔎 No records hold “${esc(valueName)}” — but automation can still name it:</div>
      <div class="ds-pk-imp-row${literal.mentions ? ' ds-pk-imp-hit' : ''}">Automations mentioning it <em>by name</em>: <strong>${literal.mentions}</strong></div>
      ${_pkAutomationHitsHtml(literal)}
      <div class="ds-pk-imp-hint">💡 These won't break — they'll just stop matching, silently. Open each one and update it before or right after this change.</div>
    </div>`;
}

// One-line impact summary for the bulk per-org panel (P2).
function _pkImpactSummaryLine(imp) {
  const n = x => x === null ? '?' : x.length;
  return `${n(imp.triggers)} trigger(s), ${n(imp.flows)} flow(s), ${n(imp.validationRules)} VR(s)`;
}

// ── The wizard (fix / toggle / delete share one dialog) ─────────
async function _pkOpenWizard(idx, mode) {
  const inv = _pkInv;
  if (!inv) return;
  const v = inv.rawValues[idx];
  const name = pkValueName(v);
  const active = v.isActive !== false;
  const count = inv.usage.get(name) || 0;

  // Activate is metadata-only, no ceremony.
  if (mode === 'toggle' && !active) return _pkApplyMetadata(idx, { activate: true });

  const others = inv.rawValues.filter((o, i) => i !== idx && o.isActive !== false)
    .map(o => pkValueName(o));
  const needsFix = count > 0;
  const fixRequired = mode === 'delete' && needsFix;

  const title = mode === 'delete' ? `Delete value “${name}”`
              : mode === 'fix'    ? `Fix data for “${name}”`
              :                     `Deactivate “${name}”`;

  // T8: the literal scan runs for EVERY deactivate/delete, not only when
  // records hold the value — a flow or validation rule comparing against the
  // literal keeps compiling and silently stops matching. Zero records is
  // exactly the case where the old "no records → metadata-only" copy lied.
  const wantScan = needsFix || mode === 'toggle' || mode === 'delete';
  if (wantScan) {
    showModal(`<div class="ds-modal-header">${esc(title)}</div>
      <div class="ds-modal-body"><div class="ds-init-loading">${window.sftkCat ? sftkCat('Checking records, flows and validation rules…') : 'Checking automation…'}</div></div>`);
  }
  const impact = needsFix ? await _pkImpact(inv) : null;
  const literal = wantScan ? await _pkValueLiteralScan(inv, name) : null;

  // The one confirmation (sftk-confirm.js, campaign 3 phase 2): the wizard's
  // own form (fix choice + impact panel) rides along as extraHtml; the
  // production typed-name step replaces the old confirmTypedProd() call.
  const bodyHtml = `
    ${needsFix ? `
      <p><strong>${count.toLocaleString()}</strong> record${count !== 1 ? 's' : ''} currently hold${count === 1 ? 's' : ''} this value.
      ${mode === 'delete' ? 'Deleting without a fix leaves ORPHAN text — filters and reports silently stop matching it.'
        : mode === 'toggle' ? 'Deactivating keeps the stored value but users can no longer select it.' : ''}</p>
      <div class="ds-pk-fixchoice">
        <label><input type="radio" name="dsPkFixMode" value="remap" checked>
          Move them to:
          <select id="dsPkRemapTarget" class="ds-select ds-select-sm">
            ${others.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
          </select>
        </label>
        <label><input type="radio" name="dsPkFixMode" value="clear"> Clear the value (${inv.isMulti ? 'remove it from each record’s selection' : 'set the field blank'})</label>
        ${fixRequired ? '' : `<label><input type="radio" name="dsPkFixMode" value="skip"> Skip the data fix${mode === 'toggle' ? ' — records keep the value' : ''}</label>`}
      </div>
      ${_pkImpactHtml(impact, count, literal)}
    ` : `<p>No records hold this value — no data fix is needed.</p>${_pkLiteralOnlyHtml(literal, name)}`}`;

  let fixMode = 'skip', target = null;
  const readFix = () => {
    fixMode = needsFix ? (document.querySelector('input[name="dsPkFixMode"]:checked')?.value || 'skip') : 'skip';
    target = fixMode === 'remap' ? eid('dsPkRemapTarget')?.value : null;
  };

  const gate = await sftkOrgWriteGate(inv.orgUrl, _orgs);
  const ok = await sftkConfirmDestructive({
    title,
    icon: mode === 'delete' ? '🗑' : mode === 'fix' ? '🔧' : '⏸',
    items: [{ label: name, sub: needsFix ? `${count.toLocaleString()} record(s) currently hold this value` : 'no records hold this value' }],
    revOverride: mode === 'delete'
      ? { html: "⛔ Salesforce's API cannot delete a picklist value: this removes it from the value set and Salesforce keeps it as <strong>inactive</strong> — the tool re-reads the field afterwards and says which. Deleting it for good is a click in Setup (Object Manager → Fields &amp; Relationships → the field → Values → Del). Records already fixed above are unaffected. Prefer <strong>Deactivate</strong> unless you need it out of the list.", needsCheckbox: true }
      : mode === 'toggle'
      ? { html: '🔁 <strong>Reversible</strong> — deactivating keeps the stored value; it can be reactivated anytime from this page.', needsCheckbox: false }
      : { html: '⚠ <strong>Not reversible by this tool</strong> — records are updated directly; there is no automatic rollback for a data fix.', needsCheckbox: true },
    confirmLabel: mode === 'delete' ? '🗑 Delete value' : mode === 'fix' ? '🔧 Run data fix' : '⏸ Deactivate',
    extraHtml: bodyHtml,
    production: gate.production ? { label: gate.label } : null,
    onRender: () => {
      readFix();
      document.querySelectorAll('input[name="dsPkFixMode"]').forEach(r => r.addEventListener('change', readFix));
      eid('dsPkRemapTarget')?.addEventListener('change', readFix);
    },
  });
  if (!ok) return;

  if (fixMode !== 'skip' && count > 0) {
    // confirmed-by: _pkOpenWizard (sftkConfirmDestructive above)
    const fixOk = await _pkRunDataFix(name, fixMode, target);
    if (!fixOk) return;   // fix failed/partial — leave metadata untouched
  }
  if (mode === 'toggle') await _pkApplyMetadata(idx, { deactivate: true });
  if (mode === 'delete') await _pkApplyMetadata(idx, { remove: true });
  if (mode === 'fix') loadPicklistInventory();
}

// ── Data fix runner ─────────────────────────────────────────────
// Core: fetch + remap/clear records in 200-batches. No DOM / history / toast —
// reused by the single-org runner AND the multi-org bulk apply (P2).
// Returns { updated, failed, errors }.
async function _pkDataFixCore(ctx, value, fixMode, target, onProgress, journal) {
  let updated = 0, failed = 0;
  const errors = [];
  const lit = soqlStrLit(value);
  const q = ctx.isMulti
    ? `SELECT Id, ${ctx.field} FROM ${ctx.obj} WHERE ${ctx.field} INCLUDES (${lit})`
    : `SELECT Id FROM ${ctx.obj} WHERE ${ctx.field} = ${lit}`;
  const res = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: ctx.orgUrl, sid: ctx.sid, tooling: false, query: q });
  if (res.error) throw new Error(res.error);
  const recs = res.records || [];
  // History (sftk-history.js): the before-value per record, captured BEFORE
  // any write, so a CONFIRMED change (never an attempted one) can be written
  // back. Capped at 5,000 — beyond that the entry says why there is no undo
  // list instead of carrying a huge one.
  const beforeMap = new Map(recs.map(r => [r.Id, ctx.isMulti ? (r[ctx.field] || null) : value]));
  const undoRecords = [];
  const UNDO_CAP = 5000;
  for (let i = 0; i < recs.length; i += 200) {
    const chunk = recs.slice(i, i + 200).map(r => ({
      attributes: { type: ctx.obj }, Id: r.Id,
      [ctx.field]: ctx.isMulti
        ? (pkMultiRemap(r[ctx.field], value, fixMode === 'remap' ? target : null) || null)
        : (fixMode === 'remap' ? target : null),
    }));
    // The one write discipline (sftk-write.js): Collections' per-record
    // success flag used to BE "moved off the value" — one re-read of exactly
    // the Ids it accepted closes the same gap a PATCH accepted-but-unchanged
    // taught elsewhere in this app.
    // confirmed-by: every caller of this core (_pkOpenWizard, _pkValueSetWizard,
    // _pkApplyBulk, _pkOpenSyncPlan's Run) confirms via sftkConfirmDestructive first.
    const w = await sftkWriteVerified({
      describe: `${ctx.obj}.${ctx.field} data fix`,
      write: () => sendBg({ type: 'SF_COLLECTIONS_UPDATE', orgUrl: ctx.orgUrl, sid: ctx.sid, records: chunk }),
      journal: journal || null,   // history-by: the caller's entry (single: _pkRunDataFix; bulk: _pkApplyBulk; sync: _pkRunSyncPlan)
      verify: async (writeRes) => {
        const okIds = (Array.isArray(writeRes) ? writeRes : []).filter(r => r.success).map(r => r.id);
        if (!okIds.length) return { ok: true, detail: [] };
        const vq = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: ctx.orgUrl, sid: ctx.sid, tooling: false,
          query: `SELECT Id, ${ctx.field} FROM ${ctx.obj} WHERE Id IN (${okIds.map(id => soqlStrLit(id)).join(',')})` });
        if (vq?.error) return { ok: false, text: `${ctx.obj}.${ctx.field} data fix: accepted by Salesforce, but the org could not be re-read to confirm it (${vq.error})` };
        const byId = new Map((vq.records || []).map(r => [r.Id, r]));
        const stillHas = okIds.filter(id => {
          const now = byId.get(id);
          if (!now) return true;
          const v = now[ctx.field];
          return ctx.isMulti ? String(v || '').split(';').includes(value) : String(v || '') === value;
        });
        return stillHas.length
          ? { ok: false, detail: stillHas, text: `${ctx.obj}.${ctx.field} data fix: accepted by Salesforce, but ${stillHas.length} record(s) still show “${value}”` }
          : { ok: true, detail: [] };
      },
    });
    if (!w.accepted) throw new Error(w.raw?.error || w.text);
    const stillHasSet = new Set(w.detail || []);
    (Array.isArray(w.raw) ? w.raw : []).forEach(r => {
      if (r.success && !stillHasSet.has(r.id)) {
        updated++;
        if (undoRecords.length < UNDO_CAP) undoRecords.push({ Id: r.id, [ctx.field]: beforeMap.get(r.id) ?? null });
      } else {
        failed++;
        if (errors.length < 20) errors.push(r.success
          ? 'accepted by Salesforce, but the org still shows the old value'
          : (r.errors || []).map(e => e.message).join('; '));
      }
    });
    onProgress?.(Math.min(i + 200, recs.length), recs.length, failed);
  }
  // History (sftk-history.js): undo restores the captured before-values, in
  // 200-record steps, each verified by re-reading exactly those Ids.
  let undo;
  if (updated > UNDO_CAP) {
    undo = { none: `more than 5,000 records were changed — too many to keep an undo copy on this PC (${updated.toLocaleString()} changed)` };
  } else if (!undoRecords.length) {
    undo = { none: 'no records were changed' };
  } else {
    const steps = [];
    for (let i = 0; i < undoRecords.length; i += 200) {
      const chunk = undoRecords.slice(i, i + 200);
      steps.push({
        describe: `${ctx.obj}.${ctx.field}: restore ${chunk.length} record(s) to “${value}”${undoRecords.length > 200 ? ` (${Math.floor(i / 200) + 1}/${Math.ceil(undoRecords.length / 200)})` : ''}`,
        // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
        msg: { type: 'SF_COLLECTIONS_UPDATE', records: chunk.map(r => ({ attributes: { type: ctx.obj }, Id: r.Id, [ctx.field]: r[ctx.field] })) },
        verify: { query: `SELECT Id FROM ${ctx.obj} WHERE Id IN (${chunk.map(r => soqlStrLit(r.Id)).join(',')}) AND ${ctx.isMulti ? `${ctx.field} INCLUDES (${lit})` : `${ctx.field} = ${lit}`}`,
          tooling: false, count: chunk.length,
          text: { ok: `${ctx.obj}.${ctx.field}: ${chunk.length} record(s) restored to “${value}” — verified by re-reading the org`,
                  bad: `${ctx.obj}.${ctx.field}: the restore was accepted, but the org doesn't show all ${chunk.length} record(s) back on “${value}”` } },
      });
    }
    undo = { steps };
  }
  return { updated, failed, errors, undo };
}

// Single-org data fix — wraps the core with progress DOM, a history entry and a
// toast (P1 behaviour). ctx defaults to _pkInv; P4 editors pass their own ctx.
async function _pkRunDataFix(value, fixMode, target, ctx = _pkInv) {
  const body = eid('dsPkBody');
  const prog = document.createElement('div');
  prog.className = 'ds-pk-progress';
  prog.innerHTML = window.sftkCatSm ? sftkCatSm('Fetching records…') : 'Fetching records…';
  body?.prepend(prog);
  const startedAt = new Date().toISOString();
  // History (sftk-history.js): one journal for this fix action; the legacy
  // `_history.push({ kind: 'picklist-fix' … })` summary below stays as is —
  // it's the pre-existing per-run log, this journal is the new undoable entry.
  const journal = sftkHistoryBegin({ tool: 'Picklist Manager',
    title: `🔧 ${ctx.obj}.${ctx.field} “${value}” → ${fixMode === 'remap' ? `“${target}”` : 'cleared'}`, orgUrl: ctx.orgUrl });
  let undo = { none: 'nothing was changed' };
  try {
    const r = await _pkDataFixCore(ctx, value, fixMode, target,
      (done, total, f) => { prog.innerHTML = window.sftkCatSm
        ? sftkCatSm(`Fixing… ${done} / ${total} (${f} failed)`)
        : `Fixing… ${done} / ${total}`; }, journal);
    const { updated, failed, errors } = r;
    undo = r.undo || undo;
    _history.push({
      id: genId('run'), kind: 'picklist-fix',
      profileName: `Picklist fix: ${ctx.obj}.${ctx.field} “${value}” → ${fixMode === 'remap' ? `“${target}”` : 'cleared'}`,
      startedAt, completedAt: new Date().toISOString(),
      status: failed === 0 ? 'success' : (updated > 0 ? 'partial' : 'failed'),
      sourceOrg: ctx.orgUrl, targetOrg: ctx.orgUrl,
      summary: { [ctx.obj]: { created: 0, failed, updated } },
      errors: pkDedupeErrors(errors),
    });
    await storageSaveHistory();
    showToast(failed === 0
      ? `✅ ${updated.toLocaleString()} record(s) moved off “${value}”`
      : `⚠ ${updated} fixed, ${failed} failed — see History for the errors`, failed ? 'warning' : 'success', 6000);
    return failed === 0;
  } catch (e) {
    showToast(`❌ Data fix failed: ${e.message}`, 'error', 7000);
    return false;
  } finally {
    await sftkHistoryEnd(journal, { undo });
    prog.remove();
  }
}

// ── Metadata apply (activate / deactivate / remove a value) ─────
// Core: mutate a CLONE of the field's value set + PATCH. No toast / reload —
// reused by single-org apply AND bulk apply (P2). Throws on failure.
async function _pkApplyMetadataCore(inv, idx, op, journal) {
  const md = JSON.parse(JSON.stringify(inv.metadata));
  const list = md.valueSet.valueSetDefinition.value;
  if (op.remove) list.splice(idx, 1);
  else {
    list[idx].isActive = !!op.activate;
    if (op.deactivate && list[idx].default) list[idx].default = false;   // inactive default is invalid
  }
  // The one write discipline (sftk-write.js): the PATCH, then the field
  // re-read. Activate / deactivate is verified by the value's isActive after
  // the re-read; a remove is judged just below (Salesforce keeps the value
  // inactive rather than deleting it — the re-read tells which).
  const name = pkValueName(inv.rawValues[idx]);
  const readBack = () => sendBg({ type: 'SF_TOOLING_GET', orgUrl: inv.orgUrl, sid: inv.sid,
    sobject: 'CustomField', id: inv.fieldId, _suppressError: true });
  // confirmed-by: _pkOpenWizard / _pkApplyBulk confirm via sftkConfirmDestructive before calling this core.
  const w = await sftkWriteVerified({
    describe: `${inv.obj}.${inv.field} value “${name}”`,
    write: () => sendBg({ type: 'SF_PATCH', orgUrl: inv.orgUrl, sid: inv.sid,
      path: `services/data/v62.0/tooling/sobjects/CustomField/${inv.fieldId}`,
      body: { Metadata: sftkMetaForPatch(md) } }),
    journal: journal || null,   // history-by: the caller's entry (single: _pkApplyMetadata; bulk: the picklist-fix entry)
    verify: op.remove ? undefined : async () => {
      const back = await readBack();
      const list2 = back?.Metadata?.valueSet?.valueSetDefinition?.value;
      if (back?.error || !Array.isArray(list2)) throw new Error(back?.error || 'the field could not be re-read');
      const v = list2.find(x => pkValueName(x) === name);
      const isOn = !!v && v.isActive !== false;
      const wantOn = !!op.activate;
      return { ok: !!v && isOn === wantOn, text: !v ? `“${name}” is no longer in the value set` : (isOn === wantOn ? `“${name}” ${wantOn ? 'activated' : 'deactivated'} — verified by re-reading the field` : `“${name}”: accepted by Salesforce, but the field still reads it ${isOn ? 'active' : 'inactive'}`) };
    },
    noVerify: op.remove ? 'judged by the re-read below' : undefined,
  });
  if (!w.accepted) throw new Error(w.raw?.error || w.text);
  if (!op.remove) return { ok: w.ok, verified: w.verified, text: w.text };
  // A value left out of the PATCHed value set is not deleted by Salesforce —
  // it is kept as INACTIVE (live 2026-09-23, verified by CLI: "Reviewed"
  // still in the value set, isActive false, after "🗑 Value deleted"). The
  // API cannot delete a picklist value; only Setup can. Re-read and say which.
  const back = await readBack();
  const list2 = back?.Metadata?.valueSet?.valueSetDefinition?.value;
  if (back?.error || !Array.isArray(list2)) return { ok: true, verified: false, name };
  const kept = list2.find(v => pkValueName(v) === name);
  return { ok: true, verified: true, name, removed: !kept, keptInactive: !!kept && kept.isActive === false };
}

async function _pkApplyMetadata(idx, op) {
  const inv = _pkInv;
  try {
    // Capture RT assignments holding this value so we can report SF's auto-drop (P3).
    if (op.deactivate) {
      const nm = pkValueName(inv.rawValues[idx]);
      _pkPendingRtCheck = { name: nm, pre: inv.rts.filter(rt => rt.values.has(nm)).length };
    }
    // History (sftk-history.js): the undo writes the PREVIOUS value set back
    // (a value removed by the API is only ever kept inactive — writing the
    // old set re-activates it), judged by re-reading the field.
    const name = pkValueName(inv.rawValues[idx]);
    const before = sftkMetaForPatch(JSON.parse(JSON.stringify(inv.metadata)));
    const wasActive = inv.rawValues[idx].isActive !== false;
    const nameField = ('fullName' in inv.rawValues[idx]) ? 'fullName' : ('valueName' in inv.rawValues[idx]) ? 'valueName' : 'label';
    const verb = op.remove ? 'deleted' : op.activate ? 'activated' : 'deactivated';
    const journal = sftkHistoryBegin({ tool: 'Picklist Manager', title: `${op.remove ? '🗑' : op.activate ? '▶' : '⏸'} ${inv.obj}.${inv.field} “${name}” ${verb}`, orgUrl: inv.orgUrl });
    let r;
    try { r = await _pkApplyMetadataCore(inv, idx, op, journal); }
    finally { await sftkHistoryEnd(journal, {
      undo: { steps: [{
        describe: `${inv.obj}.${inv.field}: write the previous value set back (“${name}” ${wasActive ? 'active' : 'inactive'} again)`,
        // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
        msg: { type: 'SF_PATCH', path: `services/data/v62.0/tooling/sobjects/CustomField/${inv.fieldId}`, body: { Metadata: before } },
        verify: { query: `SELECT Id, Metadata FROM CustomField WHERE Id = '${inv.fieldId}'`, tooling: true,
          pick: 'records.0.Metadata.valueSet.valueSetDefinition.value', where: { field: nameField, equals: name },
          field: 'isActive', ...(wasActive ? { notFalse: true } : { equals: false }),
          text: { ok: `${inv.obj}.${inv.field} “${name}” is ${wasActive ? 'active' : 'inactive'} again — verified by re-reading the field`,
                  bad: `${inv.obj}.${inv.field}: the previous value set was accepted, but the field still does not read “${name}” as ${wasActive ? 'active' : 'inactive'}` } },
      }] },
    }); }
    if (op.remove && r && r.verified === false) {
      showToast(`⚠ The value set was saved without “${r.name}”, but the field could not be re-read to confirm what Salesforce kept — check it in Setup`, 'warning', 9000);
    } else if (op.remove && r && !r.removed) {
      showToast(`⚠ Salesforce kept “${r.name}” as INACTIVE — its API cannot delete a picklist value. To delete it for good: Setup → Object Manager → ${inv.obj} → Fields & Relationships → ${inv.field} → Values → Del.`, 'warning', 12000);
    } else {
      showToast(op.remove ? '🗑 Value deleted from the value set (verified by re-reading the field)'
        : (r && r.verified === false) ? `⚠ ${op.activate ? '▶' : '⏸'} ${r.text || 'accepted by Salesforce — not confirmed'}`
        : (r && r.ok === false) ? `⚠ ${r.text}`
        : op.activate ? '▶ Value activated (verified by re-reading the field)' : '⏸ Value deactivated (verified by re-reading the field)', (r && (r.ok === false || r.verified === false)) ? 'warning' : 'success');
    }
    loadPicklistInventory();
  } catch (e) {
    _pkPendingRtCheck = null;
    const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(e.message) : { message: e.message };
    showToast(`❌ Metadata update failed: ${fe.message}`, 'error', 8000);
  }
}

// ════════════════════════════════════════════════════════════════
// P2 — MULTI-ORG MATRIX + BULK APPLY
// ════════════════════════════════════════════════════════════════

// Load one field's value inventory across every selected org (in parallel,
// skipping orgs with no live session), then build + render the value×org matrix.
async function _pkLoadMatrix() {
  const body = eid('dsPkBody');
  if (!body || !_pkCmpObj || !_pkCmpField || !_pkCmpOrgs.length) return;
  body.innerHTML = `<div class="ds-init-loading">${window.sftkCat ? sftkCat('Loading values across orgs…') : 'Loading…'}</div>`;

  const results = await Promise.all(_pkCmpOrgs.map(async url => {
    const orgKey = _orgKey(url);
    const label = orgLabel(url);
    const sess = await getOrgSession(url);
    if (!sess) return { orgUrl: url, orgKey, label, skip: 'not open in a tab' };
    try {
      const r = await _pkFetchInventory(sess, _pkCmpObj, _pkCmpField);
      if (r.kind === 'global') return { orgUrl: url, orgKey, label, skip: 'global value set' };
      // Record types per org (user 2026-07-18: the matrix showed no RT info).
      // A failed RT load degrades to a note — never kills the value matrix.
      // Custom fields: _pkFetchInventory already paid for this org's RT reads
      // (r.inv.rts) — reuse them instead of re-fetching. Backlog item from the
      // E3b estimator work, which counted the duplicate honestly until now.
      let rts = [], rtNote = '';
      if (r.kind === 'local' && r.inv && Array.isArray(r.inv.rts)) {
        rts = r.inv.rts; rtNote = r.inv.rtNote || '';
      } else {
        try {
          const rt = await _pkLoadRecordTypes(sess, _pkCmpObj, _pkCmpField, _pkCmpField.replace(/__c$/i, ''));
          rts = rt.rts; rtNote = rt.rtNote;
        } catch (e2) { rtNote = `record types unavailable: ${e2.message}`; }
      }
      // Standard picklists join the matrix READ-ONLY (user 2026-07-25: present
      // them, don't send people off to compare in Setup): values come from the
      // describe (active only) under stdInv — deliberately NOT .inv, so the
      // bulk wizard and sync plan (both keyed on .inv) can never write them.
      if (r.kind === 'standard') {
        const desc = await describe(_pkCmpObj, sess.orgUrl, sess.sid);
        const fieldMeta = (desc?.fields || []).find(f => f.name === _pkCmpField);
        const rawValues = sftkDescribeValues(fieldMeta);
        if (!rawValues.length) return { orgUrl: url, orgKey, label, skip: 'standard picklist — describe returned no values' };
        const { usage } = await _pkLoadUsage(sess, _pkCmpObj, _pkCmpField, r.isMulti, rawValues);
        return { orgUrl: url, orgKey, label, stdInv: { rawValues, usage }, rts, rtNote,
          metaRO: 'Standard picklist — values shown from the describe (active only). Compare freely; editing the value set happens in Setup, so bulk apply / sync can’t target this column.' };
      }
      return { orgUrl: url, orgKey, label, inv: r.inv, rts, rtNote };
    } catch (e) {
      const msg = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(e.message).message : e.message;
      return { orgUrl: url, orgKey, label, skip: msg };
    }
  }));

  const perOrg = results.filter(r => r.inv || r.stdInv).map(r => ({ orgKey: r.orgKey, values: (r.inv || r.stdInv).rawValues.map(v => pkValueName(v)) }));
  const union = pkValueUnion(perOrg);
  // Display copy: standard columns get their stdInv as .inv so the pure
  // matrix builder renders their cells; _pkMatrix.results stays clean.
  const displayCols = results.map(r => (!r.inv && r.stdInv) ? { ...r, inv: r.stdInv } : r);
  _pkMatrix = { obj: _pkCmpObj, field: _pkCmpField, results, union, matrix: pkBuildMatrix(displayCols, union) };
  _pkRenderMatrix();
}

function _pkRenderMatrix() {
  const body = eid('dsPkBody');
  const M = _pkMatrix;
  if (!body || !M) return;
  const cols = M.results;

  // A real table header row: sticky, on the sunk surface, TITLE CASE (these
  // are org names — proper nouns — and uppercasing mangled "QA Sandbox").
  const head = `<div class="ds-pk-mx-row ds-pk-mx-head">
      <div class="ds-pk-mx-sel"><input type="checkbox" id="dsPkMxAll" aria-label="Select all values" title="Select all values"></div>
      <div class="ds-pk-mx-val">Value</div>
      ${cols.map(c => `<div class="ds-pk-mx-col">
        <label class="ds-pk-mx-orgsel"><input type="checkbox" class="ds-pk-mx-orgchk" data-org="${esc(c.orgUrl)}" ${c.inv ? 'checked' : 'disabled'}${c.metaRO ? ` title="${esc(c.metaRO)}"` : ''}> ${esc(c.label)}</label>
        ${(typeof _ring === 'object' && _ring?.sourceUrl && (_ring.orgs || []).length >= 2 && _orgKey(c.orgUrl) === _orgKey(_ring.sourceUrl))
          ? `<span class="ds-pk-mx-sot" title="Your Sync Ring's source of truth — 🔄 Sync from source pre-selects this org as the source.">${dsIcon('crown')}source of truth</span>` : ''}
        ${c.skip ? `<span class="ds-pk-mx-skip" title="${esc(c.skip)}">skipped: ${esc(c.skip)}</span>`
          : c.metaRO ? `<span class="ds-pk-mx-skip" title="${esc(c.metaRO)}">standard — read-only</span>${prodBadge(c.orgUrl)}`
          : prodBadge(c.orgUrl)}
      </div>`).join('')}
    </div>`;

  const rows = M.matrix.rows.map(row => {
    // Record-type assignment per cell + cross-org drift for this value
    // (user 2026-07-18: "i dont see any mention to record types").
    const rtDrift = pkRtDrift(cols.filter(c => c.rts?.length).map(c => c.rts), row.name);
    const cells = row.cells.map((cell, ci) => {
      // EVERY state carries a shape, not only a colour: red/green alone fails
      // for ~1 in 12 men. · not loaded, — missing, ✓ active, ▮▮ inactive,
      // ⚠ record-type drift. The .ds-sr span is the same distinction spoken
      // aloud — title= is not exposed as a name by every AT.
      if (cell.missing) return `<div class="ds-pk-mx-cell ds-pk-mx-na" title="org skipped / not loaded"><span class="ds-pk-mx-state" aria-hidden="true">·</span><span class="ds-sr">not loaded</span></div>`;
      if (!cell.exists) return `<div class="ds-pk-mx-cell ds-pk-mx-absent" title="value not present in this org"><span class="ds-pk-mx-state" aria-hidden="true">—</span><span class="ds-sr">missing</span></div>`;
      const cnt = cell.count == null ? '' : cell.count === -1 ? '?' : cell.count.toLocaleString();
      const rti = cols[ci]?.rts?.length ? pkRtCellInfo(cols[ci].rts, row.name) : null;
      const rtBadge = rti ? `<span class="ds-pk-mx-rt ${rtDrift ? 'ds-pk-mx-rt-drift' : ''}"
        title="${rti.inCount ? `In record type(s): ${esc(rti.names.join(', '))}` : 'Not included in any active record type here'}${rtDrift ? ' · ⚠ this value’s record-type assignment DIFFERS across orgs (same-name record types disagree) — align via 🔄 Sync from source' : ''}">${rtDrift ? dsIcon('warn') : ''}${rti.inCount}/${rti.total} RT</span>` : '';
      return `<div class="ds-pk-mx-cell ${cell.active ? 'ds-pk-mx-active' : 'ds-pk-mx-inactive'}"
        title="${cell.active ? 'active' : 'inactive'}${cell.count != null && cell.count >= 0 ? ` · ${cell.count} record(s)` : ''}">
        <span class="ds-pk-mx-state">${dsIcon(cell.active ? 'check' : 'pause')}<span class="ds-sr">${cell.active ? 'active' : 'inactive'}</span></span><span class="ds-pk-mx-cnt">${cnt}</span>${rtBadge}</div>`;
    }).join('');
    return `<div class="ds-pk-mx-row">
      <div class="ds-pk-mx-sel"><input type="checkbox" class="ds-pk-mx-valchk" data-val="${esc(row.name)}" aria-label="Select value ${esc(row.name)}"></div>
      <div class="ds-pk-mx-val">${esc(row.name)}</div>${cells}</div>`;
  }).join('');

  const skipped = cols.filter(c => c.skip);
  const loaded = cols.filter(c => c.inv || c.stdInv);
  const stdCols = cols.filter(c => c.stdInv);
  body.innerHTML = `
    <div class="ds-pk-summary">Matrix · <strong>${esc(M.obj)}.${esc(M.field)}</strong> · ${M.union.length} value(s) across ${loaded.length}/${cols.length} loaded org(s)</div>
    ${stdCols.length ? `<div class="ds-pk-note">🔒 Standard picklist — values compare across orgs below (active values via describe), but the value sets themselves are edited in Setup, so bulk apply / 🔄 sync can't write these columns. Record counts and 🔧 data fixes work as usual.</div>` : ''}
    <div class="ds-pk-legend" role="note" aria-label="How to read a cell">
      <span class="ds-pk-legend-item"><span class="ds-pk-legend-key ds-pk-legend-key-good">${dsIcon('check')}</span> exists &amp; active in that org</span>
      <span class="ds-pk-legend-item"><span class="ds-pk-legend-key">${dsIcon('pause')}</span> exists but inactive</span>
      <span class="ds-pk-legend-item"><span class="ds-pk-legend-key">—</span> missing from that org</span>
      <span class="ds-pk-legend-item"><span class="ds-pk-legend-key">N</span> records in that org holding the value</span>
      <span class="ds-pk-legend-item"><span class="ds-pk-legend-key">a/b RT</span> in a of that org's b active record types (hover for names)</span>
      <span class="ds-pk-legend-item"><span class="ds-pk-legend-key ds-pk-legend-key-bad">${dsIcon('warn')}</span> same-name record types disagree across orgs — align via 🔄 Sync from source</span>
    </div>
    ${cols.some(c => c.rtNote) ? `<div class="ds-pk-note">⚠ Record types: ${esc(cols.filter(c => c.rtNote).map(c => `${c.label} — ${c.rtNote}`).join(' · '))}</div>` : ''}
    ${skipped.length ? `<div class="ds-pk-note">⚠ Skipped ${skipped.length} org(s): ${esc(skipped.map(c => `${c.label} (${c.skip})`).join(', '))}</div>` : ''}
    <div class="ds-pk-matrix" style="--pk-cols:${cols.length}">${head}${rows || '<div class="ds-pk-note">No values loaded.</div>'}</div>
    <div class="ds-pk-bulkbar">
      <span class="ds-pk-bulk-lbl">With selected value(s) in the checked org(s):</span>
      <button class="ds-btn ds-btn-sm" id="dsPkBulkDeact">${dsIcon('pause')}Deactivate…</button>
      <button class="ds-btn ds-btn-sm ds-btn-danger" id="dsPkBulkDel">${dsIcon('trash')}Delete…</button>
      <span class="ds-pk-bulk-spacer"></span>
      <button class="ds-btn ds-btn-sm ds-btn-primary" id="dsPkSyncBtn"
        title="Make the other orgs' value sets match a source org: add missing values, align labels/active states/default, and align record-type assignments — you pick the operations per org">${dsIcon('repeat')}Sync from source…</button>
    </div>
    <div id="dsPkBulkResult"></div>`;

  eid('dsPkMxAll')?.addEventListener('change', e =>
    body.querySelectorAll('.ds-pk-mx-valchk').forEach(c => { c.checked = e.target.checked; }));
  eid('dsPkBulkDeact')?.addEventListener('click', () => _pkOpenBulkWizard('toggle'));
  eid('dsPkBulkDel')?.addEventListener('click', () => _pkOpenBulkWizard('delete'));
  eid('dsPkSyncBtn')?.addEventListener('click', () => _pkOpenSyncPlan());
}

function _pkMxSelectedValues() {
  return [...document.querySelectorAll('.ds-pk-mx-valchk:checked')].map(c => c.dataset.val);
}
function _pkMxSelectedOrgs() {
  const urls = new Set([...document.querySelectorAll('.ds-pk-mx-orgchk:checked')].map(c => c.dataset.org));
  return (_pkMatrix?.results || []).filter(r => r.inv && urls.has(r.orgUrl));
}

// Bulk wizard — one dialog applies the same deactivate/delete + data fix to every
// checked org, with a per-org automation-impact panel shown BEFORE applying.
async function _pkOpenBulkWizard(mode) {
  const values = _pkMxSelectedValues();
  const orgs = _pkMxSelectedOrgs();
  if (!values.length) return showToast('Tick at least one value (row checkbox).', 'warning');
  if (!orgs.length) return showToast('Tick at least one org column.', 'warning');
  const single = values.length === 1;

  // The one confirmation (sftk-confirm.js, campaign 3 phase 2): the wizard's
  // own form (fix choice + per-org automation-impact panel) rides along as
  // extraHtml. Go — now the dialog's own #sftkConfirmGo — stays disabled with
  // the same "checking automation" wording until every org has answered; the
  // gate is enforced here (the dialog's own sync only handles the checkbox/word,
  // which this dialog doesn't use, precisely so the scan gate can't be raced).
  const bodyHtml = `
    <p>Values: <strong>${esc(values.join(', '))}</strong></p>
    <p>Orgs: ${esc(orgs.map(o => o.label).join(', '))}</p>
    <div class="ds-pk-fixchoice">
      <label><input type="radio" name="dsPkBulkFix" value="clear" checked> Clear the value on affected records first (recommended)</label>
      ${single ? `<label><input type="radio" name="dsPkBulkFix" value="remap"> Move records to:
        <select id="dsPkBulkRemap" class="ds-select ds-select-sm"></select></label>` : ''}
      <label><input type="radio" name="dsPkBulkFix" value="skip"> Skip data fix${mode === 'delete' ? ' — leaves orphan text' : ''}</label>
    </div>
    ${!single ? '<div class="ds-pk-note-inline">Remap is available when a single value is selected; multi-value bulk offers clear or skip.</div>' : ''}
    <div id="dsPkBulkImpact" class="ds-pk-note">
      <div class="ds-pk-imp-title" id="dsPkBulkImpactHead">⏳ Checking automation impact per org…</div>
      <div id="dsPkBulkImpactRows"></div>
    </div>`;

  let fixMode = 'clear', remap = null;
  const readFix = () => {
    fixMode = document.querySelector('input[name="dsPkBulkFix"]:checked')?.value || 'skip';
    remap = fixMode === 'remap' ? eid('dsPkBulkRemap')?.value : null;
  };

  const gates = await Promise.all(orgs.map(o => sftkOrgWriteGate(o.orgUrl, _orgs)));
  const prodOrgs = orgs.map((o, i) => ({ o, gate: gates[i] })).filter(x => x.gate.production);

  const okPromise = sftkConfirmDestructive({
    title: `${mode === 'delete' ? '🗑' : '⏸'} Bulk ${mode === 'delete' ? 'delete' : 'deactivate'} — ${values.length} value(s) × ${orgs.length} org(s)`,
    icon: mode === 'delete' ? '🗑' : '⏸',
    revOverride: mode === 'delete'
      ? { html: '⛔ <strong>Permanent</strong> — Salesforce cannot undo this. There is no Recycle Bin for this type.', needsCheckbox: false }
      : { html: '🔁 <strong>Reversible</strong> — deactivating keeps the stored value in each org; it can be reactivated anytime.', needsCheckbox: false },
    confirmLabel: mode === 'delete' ? '🗑 Apply to all orgs' : '⏸ Apply to all orgs',
    extraHtml: bodyHtml,
    production: prodOrgs.length ? { label: prodOrgs.map(x => x.gate.label || x.o.label).join(', ') } : null,
    onRender: () => {
      readFix();
      document.querySelectorAll('input[name="dsPkBulkFix"]').forEach(r => r.addEventListener('change', readFix));
      eid('dsPkBulkRemap')?.addEventListener('change', readFix);

      if (single) {
        const alt = new Set();
        for (const o of orgs) for (const v of o.inv.rawValues) {
          const n = pkValueName(v);
          if (n !== values[0] && v.isActive !== false) alt.add(n);
        }
        const sel = eid('dsPkBulkRemap');
        if (sel) { sel.innerHTML = [...alt].map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join(''); readFix(); }
      }

      const go = eid('sftkConfirmGo');
      if (go) { go.disabled = true; go.title = 'Enabled once the automation check has run in every org'; go.textContent = '⏳ checking automation…'; }

      // Per-org impact + value-literal automation scan (before apply — required).
      //
      // Deliberately NOT awaited — the modal has to paint instantly. But this pass
      // is expensive per org (_pkValueLiteralScan alone is a ValidationRule Tooling
      // query plus one Flow query per active flow), and it runs the orgs
      // SEQUENTIALLY, so with several orgs it lasts a long time. Two consequences
      // are handled here:
      //   · it used to build parts[] and paint ONCE at the end, so the panel sat on
      //     a frozen "Computing…" the whole time. Each org's line is now appended
      //     AS IT COMPLETES, with a running "scanned x of n org(s)…" header, so what
      //     is on screen is always exactly what has actually been measured.
      //   · re-opening the wizard used to leave the previous run alive and racing;
      //     it could land after the new one and paint stale orgs over fresh results.
      //     The pass now captures a token (same guard as _pkSyncScanToken) and
      //     abandons quietly the moment a newer run supersedes it.
      const scanToken   = ++_pkBulkScanToken;
      const scanSubject = single ? 'this value' : 'the first value';
      const scanHead    = () => eid('dsPkBulkImpactHead');
      const scanRows    = () => eid('dsPkBulkImpactRows');
      { const h0 = scanHead(); if (h0) h0.textContent = pkScanProgressText(0, orgs.length, 0, scanSubject); }
      (async () => {
        let done = 0, failed = 0;
        for (const o of orgs) {
          let inner, bad = false;
          try {
            const imp = await _pkImpact(o.inv);
            const lit = await _pkValueLiteralScan(o.inv, values[0]);
            // lit.notes carries whatever the scan could NOT cover (its own 40-flow
            // cap, an enumeration that failed). Dropping it — as this line used to
            // — turned a partial scan into a confident "N mentions" verdict. Same
            // treatment as _pkSyncAutomationPass gives it.
            inner = `<strong>${esc(o.label)}</strong>: ${_pkImpactSummaryLine(imp)}
              · ${lit.mentions} automation(s) mention “${esc(values[0])}” by name${lit.hits.length ? ` (${esc(lit.hits.slice(0, 3).join(', '))})` : ''}`
              // E4 — what this org's scan just cost, counted from what actually ran
              // (4 impact queries + VR scan + 2 flow enumerations + 1 read per
              // scanned flow). "≈" because paginated query results add calls.
              + ` <span style="color:var(--subtext)">· ≈${pkBulkScanCalls(lit.scan)} API calls</span>`
              + ((lit.notes || []).length ? `<span style="color:var(--warning)"> · ⚠ ${esc(lit.notes.join(' · '))}</span>` : '');
          } catch (e) {
            // A thrown org must never vanish from the panel: an org with no line
            // would read as "nothing to worry about here".
            bad = true;
            failed++;
            inner = `<strong>${esc(o.label)}</strong>: ⚠ automation could NOT be checked (${esc(e?.message || String(e))}) — treat this org as UNKNOWN, not clean`;
          }
          done++;
          // Superseded by a newer wizard run, or the modal is gone — stop, and
          // above all do NOT paint into whatever is on screen now.
          if (pkScanSuperseded(scanToken, _pkBulkScanToken)) return;
          const rows = scanRows();
          if (!rows) return;
          const row = document.createElement('div');
          row.className = 'ds-pk-imp-org';
          if (bad) row.style.color = 'var(--warning)';
          row.innerHTML = inner;
          rows.appendChild(row);
          const h = scanHead();
          if (h) h.textContent = pkScanProgressText(done, orgs.length, failed, scanSubject);
        }
        // The check is over (every org answered or failed): Apply opens now —
        // it used to be clickable from the start, while "scanned 0 of 2 org(s)…"
        // was still on screen (live 2026-09-23). Same rule as the sync plan's Run.
        if (pkScanSuperseded(scanToken, _pkBulkScanToken)) return;
        const go2 = eid('sftkConfirmGo');
        if (go2) { go2.disabled = false; go2.textContent = mode === 'delete' ? '🗑 Apply to all orgs' : '⏸ Apply to all orgs'; go2.removeAttribute('title'); }
      })();
    },
  });

  const ok = await okPromise;
  if (!ok) return;
  await _pkApplyBulk(values, orgs, mode, fixMode, remap);
}

// Apply the bulk operation sequentially per org (so progress stays legible),
// writing ONE history entry per org and a per-org result log at the end.
async function _pkApplyBulk(values, orgs, mode, fixMode, remap) {
  const resBox = eid('dsPkBulkResult');
  if (resBox) resBox.innerHTML = `<div class="ds-pk-reslog"><div class="ds-pk-res-title">Applying…</div></div>`;
  const log = resBox?.querySelector('.ds-pk-reslog');
  const append = html => { if (log) { const d = document.createElement('div'); d.className = 'ds-pk-res-row'; d.innerHTML = html; log.appendChild(d); } };

  // confirmed-by: _pkOpenBulkWizard (sftkConfirmDestructive, one production
  // step naming every production org ticked, before this ever runs).
  for (const o of orgs) {
    if (o._cancelled) continue;
    const sess = await getOrgSession(o.orgUrl);
    if (!sess) { append(`⏭ <strong>${esc(o.label)}</strong>: not open — skipped`); continue; }
    const inv = o.inv;
    inv.orgUrl = sess.orgUrl; inv.sid = sess.sid;   // refresh the SID for a long run
    const startedAt = new Date().toISOString();
    let updated = 0, failed = 0, metaOk = 0, metaFail = 0, metaKept = 0, skippedVals = 0;
    const errors = [];
    // History (sftk-history.js): one journal per org — this button press can
    // touch several orgs, and each org's undo only makes sense against that
    // org. The legacy `_history.push({ kind: 'picklist-fix' … })` below stays.
    const journal = sftkHistoryBegin({ tool: 'Picklist Manager',
      title: `${mode === 'delete' ? '🗑' : '⏸'} ${_pkMatrix.obj}.${_pkMatrix.field} bulk ${mode} [${values.join(', ')}] — ${o.label}`, orgUrl: o.orgUrl });
    const metaUndoSteps = [];
    const dataUndoSteps = [];
    let dataUndoNone = '';

    for (const val of values) {
      // rawValues === metadata value list (same array ref) — findIndex tracks splices.
      const idx = inv.rawValues.findIndex(v => pkValueName(v) === val);
      if (idx < 0) { skippedVals++; append(`· <strong>${esc(o.label)}</strong>: “${esc(val)}” not present — skipped`); continue; }
      const count = inv.usage.get(val) || 0;
      // History: capture this value's state before either write touches it.
      const name = pkValueName(inv.rawValues[idx]);
      const beforeMeta = sftkMetaForPatch(JSON.parse(JSON.stringify(inv.metadata)));
      const wasActive = inv.rawValues[idx].isActive !== false;
      const nameField = ('fullName' in inv.rawValues[idx]) ? 'fullName' : ('valueName' in inv.rawValues[idx]) ? 'valueName' : 'label';

      if (fixMode !== 'skip' && count > 0) {
        const hasRemap = fixMode === 'remap' && inv.rawValues.some(v => pkValueName(v) === remap && v.isActive !== false);
        const effMode = hasRemap ? 'remap' : 'clear';
        const target = hasRemap ? remap : null;
        try {
          const r = await _pkDataFixCore(inv, val, effMode, target, null, journal);
          updated += r.updated; failed += r.failed; errors.push(...r.errors);
          if (r.undo && Array.isArray(r.undo.steps)) dataUndoSteps.push(...r.undo.steps);
          else if (r.undo && r.undo.none) dataUndoNone = dataUndoNone ? `${dataUndoNone}; ${r.undo.none}` : r.undo.none;
          if (fixMode === 'remap' && !hasRemap) append(`⚠ <strong>${esc(o.label)}</strong>: remap target “${esc(remap)}” absent here — cleared “${esc(val)}” instead`);
        } catch (e) {
          errors.push(e.message);
          append(`❌ <strong>${esc(o.label)}</strong>: data fix “${esc(val)}” failed — ${esc(e.message)}`);
          continue;   // leave metadata untouched for this value
        }
      }

      try {
        const r = await _pkApplyMetadataCore(inv, idx, mode === 'delete' ? { remove: true } : { deactivate: true }, journal);
        metaOk++;
        const keptByOrg = mode === 'delete' && r && r.verified && !r.removed;
        if (keptByOrg) metaKept++;
        // Keep the local value list in sync so later findIndex lookups stay valid.
        if (mode === 'delete' && !keptByOrg) inv.metadata.valueSet.valueSetDefinition.value.splice(idx, 1);
        else inv.metadata.valueSet.valueSetDefinition.value[idx].isActive = false;
        // History: the undo writes this value's PREVIOUS value set back —
        // same pattern as the single-value _pkApplyMetadata.
        metaUndoSteps.push({
          describe: `${inv.obj}.${inv.field}: write the previous value set back (“${name}” ${wasActive ? 'active' : 'inactive'} again)`,
          // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
          msg: { type: 'SF_PATCH', path: `services/data/v62.0/tooling/sobjects/CustomField/${inv.fieldId}`, body: { Metadata: beforeMeta } },
          verify: { query: `SELECT Id, Metadata FROM CustomField WHERE Id = '${inv.fieldId}'`, tooling: true,
            pick: 'records.0.Metadata.valueSet.valueSetDefinition.value', where: { field: nameField, equals: name },
            field: 'isActive', ...(wasActive ? { notFalse: true } : { equals: false }),
            text: { ok: `${inv.obj}.${inv.field} “${name}” is ${wasActive ? 'active' : 'inactive'} again — verified by re-reading the field`,
                    bad: `${inv.obj}.${inv.field}: the previous value set was accepted, but the field still does not read “${name}” as ${wasActive ? 'active' : 'inactive'}` } },
        });
      } catch (e) {
        metaFail++; errors.push(e.message);
        append(`❌ <strong>${esc(o.label)}</strong>: metadata “${esc(val)}” failed — ${esc(e.message)}`);
      }
    }

    _history.push({
      id: genId('run'), kind: 'picklist-fix',
      profileName: `Picklist bulk ${mode}: ${_pkMatrix.obj}.${_pkMatrix.field} [${values.join(', ')}] (${fixMode})`,
      startedAt, completedAt: new Date().toISOString(),
      status: (failed === 0 && metaFail === 0) ? 'success' : ((updated > 0 || metaOk > 0) ? 'partial' : 'failed'),
      sourceOrg: o.orgUrl, targetOrg: o.orgUrl,
      summary: { [_pkMatrix.obj]: { created: 0, failed, updated } },
      errors: pkDedupeErrors(errors),
    });

    await sftkHistoryEnd(journal, {
      undo: (metaUndoSteps.length || dataUndoSteps.length)
        ? { steps: [...metaUndoSteps, ...dataUndoSteps], note: dataUndoNone || undefined }
        : { none: dataUndoNone || 'nothing was applied in this org' },
    });

    append(`${(failed === 0 && metaFail === 0) ? '✅' : '⚠'} <strong>${esc(o.label)}</strong>: ${updated} record(s) fixed, ${metaOk} value(s) ${mode === 'delete' ? (metaKept ? `removed from the list — ${metaKept} kept INACTIVE by Salesforce (its API cannot delete a picklist value; Setup can)` : 'deleted') : 'deactivated'}${failed ? `, ${failed} record failure(s)` : ''}${metaFail ? `, ${metaFail} metadata failure(s)` : ''}${skippedVals ? `, ${skippedVals} absent/skipped` : ''}`);
  }

  await storageSaveHistory();
  append(`<em>Done — one history entry written per org. Reload the matrix to see updated state.</em>`);
  showToast('Bulk apply finished — see the per-org log', 'info', 5000);
}

// ════════════════════════════════════════════════════════════════
// P4 — STANDARD + GLOBAL VALUE SETS
// ════════════════════════════════════════════════════════════════

// Generic value-set list renderer (P4) — a value table + fix/toggle/delete
// actions driven by a caller-supplied applyFn. ctx: { orgUrl, sid, obj, field,
// isMulti, rawValues, usage }. Reuses the P1 data-fix + impact flow.
function _pkRenderValueSet(ctx, opts) {
  const body = eid('dsPkBody');
  if (!body) return;
  const counts = [...ctx.usage.values()].filter(n => typeof n === 'number' && n >= 0);
  const maxCount = Math.max(1, ...counts);
  const rows = ctx.rawValues.map((v, i) => {
    const name = pkValueName(v);
    const active = v.isActive !== false;
    const count = ctx.usage.has(name) ? ctx.usage.get(name) : null;
    return `<div class="ds-pk-row${active ? '' : ' ds-pk-row-inactive'}" data-pk-val="${esc(name)}">
      <div class="ds-pk-val"><span class="ds-pk-name">${esc(v.label || name)}</span>${v.label && v.label !== name ? `<code class="ds-pk-api">${esc(name)}</code>` : ''}${v.default ? '<span class="ds-pk-default">default</span>' : ''}${active ? '' : '<span class="ds-pk-inactive-badge">inactive</span>'}</div>
      <div class="ds-pk-usage">${count == null ? '<span class="ds-pk-uncounted">—</span>' : count === -1 ? '<span class="ds-pk-uncounted">?</span>' : `<span class="ds-pk-bar"><span class="ds-pk-fill" style="width:${Math.max(2, Math.round(count / maxCount * 100))}%"></span></span><span class="ds-pk-count">${count.toLocaleString()}</span>`}</div>
      <div class="ds-pk-actions">
        ${(count > 0) ? `<button class="ds-btn ds-btn-sm" data-vs-fix="${i}">🔧 Fix data…</button>` : ''}
        ${opts.readOnlyMeta ? '' : `<button class="ds-btn ds-btn-sm" data-vs-toggle="${i}">${active ? '⏸ Deactivate' : '▶ Activate'}</button>`}
        ${opts.allowDelete && !opts.readOnlyMeta ? `<button class="ds-btn ds-btn-sm ds-btn-danger" data-vs-del="${i}">🗑</button>` : ''}
      </div></div>`;
  }).join('');
  body.innerHTML = `${opts.banner || ''}
    <div class="ds-pk-summary">${esc(opts.title)} · ${ctx.rawValues.length} value(s) ${prodBadge(ctx.orgUrl)}</div>
    <div class="ds-pk-table">
      <div class="ds-pk-head"><div class="ds-pk-val">Value</div><div class="ds-pk-usage">Records</div><div class="ds-pk-actions"></div></div>
      ${rows}
    </div>`;
  body.querySelectorAll('[data-vs-fix]').forEach(b => b.addEventListener('click', () => _pkValueSetWizard(ctx, +b.dataset.vsFix, 'fix', opts.applyFn, opts.reloadFn)));
  body.querySelectorAll('[data-vs-toggle]').forEach(b => b.addEventListener('click', () => _pkValueSetWizard(ctx, +b.dataset.vsToggle, 'toggle', opts.applyFn, opts.reloadFn)));
  body.querySelectorAll('[data-vs-del]').forEach(b => b.addEventListener('click', () => _pkValueSetWizard(ctx, +b.dataset.vsDel, 'delete', opts.applyFn, opts.reloadFn)));
  _pkApplyHighlight();
}

// Scroll to + flash one value's row after a deep link (window.sftkOpenPicklistFix).
// Consumes _pkHighlightValue so a later re-render doesn't re-flash. Says so out
// loud when the value isn't in the value set — silence would look like success.
function _pkApplyHighlight() {
  const want = _pkHighlightValue;
  if (!want) return;
  _pkHighlightValue = '';
  const row = [...document.querySelectorAll('[data-pk-val]')].find(r => r.dataset.pkVal === want);
  if (!row) {
    showToast(`“${want}” isn't in this field's value set here — it may already be deleted, or its API name differs`, 'warning', 8000);
    return;
  }
  try { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) { row.scrollIntoView(); }
  row.style.outline = '2px solid var(--warning)';
  row.style.outlineOffset = '2px';
  row.style.borderRadius = '6px';
  row.style.background = 'var(--c-warn-bg)';
  setTimeout(() => {
    row.style.outline = ''; row.style.outlineOffset = ''; row.style.background = ''; row.style.borderRadius = '';
  }, 6000);
}

// Generic deactivate/activate/delete wizard for standard + global value sets (P4).
// Mirrors _pkOpenWizard's data-fix + impact + prod-confirm flow but writes via applyFn.
async function _pkValueSetWizard(ctx, idx, mode, applyFn, reloadFn) {
  const v = ctx.rawValues[idx];
  const name = pkValueName(v);
  const active = v.isActive !== false;
  const count = ctx.usage.get(name) || 0;

  if (mode === 'toggle' && !active) {
    // History (sftk-history.js): one journal for this button press; the
    // core (std/global) returns the undo that writes the value back off.
    const journal = sftkHistoryBegin({ tool: 'Picklist Manager', title: `▶ ${ctx.obj}.${ctx.field} “${name}” activated`, orgUrl: ctx.orgUrl });
    let undo = { none: 'nothing was changed' };
    try {
      const r = await applyFn(idx, { activate: true }, journal);
      undo = (r && r.undo) || undo;
      showToast('▶ Value activated', 'success'); reloadFn();
    }
    catch (e) { showToast(`❌ ${e.message}`, 'error', 7000); }
    finally { await sftkHistoryEnd(journal, { undo }); }
    return;
  }

  const others = ctx.rawValues.filter((o, i) => i !== idx && o.isActive !== false).map(o => pkValueName(o));
  const needsFix = count > 0;
  const fixRequired = mode === 'delete' && needsFix;
  const title = mode === 'delete' ? `Delete value “${name}”` : mode === 'fix' ? `Fix data for “${name}”` : `Deactivate “${name}”`;
  const wantScan = needsFix || mode === 'toggle' || mode === 'delete';   // T8: scan even at 0 records
  if (wantScan) {
    showModal(`<div class="ds-modal-header">${esc(title)}</div>
      <div class="ds-modal-body"><div class="ds-init-loading">${window.sftkCat ? sftkCat('Checking records, flows and validation rules…') : 'Checking automation…'}</div></div>`);
  }
  const impact = needsFix ? await _pkImpact(ctx) : null;
  const literal = wantScan ? await _pkValueLiteralScan(ctx, name) : null;

  // The one confirmation (sftk-confirm.js, campaign 3 phase 2) — mirrors
  // _pkOpenWizard's conversion: same form as extraHtml, production typed-name
  // step replaces the old confirmTypedProd() call.
  const bodyHtml = `
    ${needsFix ? `
      <p><strong>${count.toLocaleString()}</strong> record(s) currently hold this value.</p>
      <div class="ds-pk-fixchoice">
        <label><input type="radio" name="dsVsFix" value="remap" ${others.length ? 'checked' : 'disabled'}> Move them to:
          <select id="dsVsRemap" class="ds-select ds-select-sm">${others.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select></label>
        <label><input type="radio" name="dsVsFix" value="clear" ${others.length ? '' : 'checked'}> Clear the value (${ctx.isMulti ? 'remove it from each record’s selection' : 'set the field blank'})</label>
        ${fixRequired ? '' : `<label><input type="radio" name="dsVsFix" value="skip"> Skip the data fix</label>`}
      </div>
      ${_pkImpactHtml(impact, count, literal)}
    ` : `<p>No records hold this value — no data fix is needed.</p>${_pkLiteralOnlyHtml(literal, name)}`}`;

  let fixMode = 'skip', target = null;
  const readFix = () => {
    fixMode = needsFix ? (document.querySelector('input[name="dsVsFix"]:checked')?.value || 'skip') : 'skip';
    target = fixMode === 'remap' ? eid('dsVsRemap')?.value : null;
  };

  const gate = await sftkOrgWriteGate(ctx.orgUrl, _orgs);
  const ok = await sftkConfirmDestructive({
    title,
    icon: mode === 'delete' ? '🗑' : mode === 'fix' ? '🔧' : '⏸',
    items: [{ label: name, sub: needsFix ? `${count.toLocaleString()} record(s) currently hold this value` : 'no records hold this value' }],
    revOverride: mode === 'delete'
      ? { html: "⛔ Salesforce's API may keep a removed value as <strong>inactive</strong> rather than delete it (it does for custom picklists) — check the value set in Setup afterwards; deleting for good is a Setup click. Prefer <strong>Deactivate</strong> unless you need it out of the list.", needsCheckbox: true }
      : mode === 'toggle'
      ? { html: '🔁 <strong>Reversible</strong> — deactivating keeps the stored value; it can be reactivated anytime from this page.', needsCheckbox: false }
      : { html: '⚠ <strong>Not reversible by this tool</strong> — records are updated directly; there is no automatic rollback for a data fix.', needsCheckbox: true },
    confirmLabel: mode === 'delete' ? '🗑 Delete value' : mode === 'fix' ? '🔧 Run data fix' : '⏸ Deactivate',
    extraHtml: bodyHtml,
    production: gate.production ? { label: gate.label } : null,
    onRender: () => {
      readFix();
      document.querySelectorAll('input[name="dsVsFix"]').forEach(r => r.addEventListener('change', readFix));
      eid('dsVsRemap')?.addEventListener('change', readFix);
    },
  });
  if (!ok) return;

  if (fixMode !== 'skip' && count > 0) {
    // confirmed-by: _pkValueSetWizard (sftkConfirmDestructive above)
    const fixOk = await _pkRunDataFix(name, fixMode, target, ctx);
    if (!fixOk) return;   // fix failed/partial — leave metadata untouched
  }
  if (mode === 'fix') { reloadFn(); return; }
  // History (sftk-history.js): a separate journal from the data fix above
  // (same split _pkOpenWizard uses: _pkRunDataFix journals its own entry).
  const journal = sftkHistoryBegin({ tool: 'Picklist Manager',
    title: `${mode === 'delete' ? '🗑' : '⏸'} ${ctx.obj}.${ctx.field} “${name}” ${mode === 'delete' ? 'deleted' : 'deactivated'}`, orgUrl: ctx.orgUrl });
  let undo = { none: 'nothing was changed' };
  try {
    const r = await applyFn(idx, mode === 'delete' ? { remove: true } : { deactivate: true }, journal);
    undo = (r && r.undo) || undo;
    showToast(mode === 'delete' ? '🗑 Value deleted' : '⏸ Value deactivated', 'success');
  } catch (e) {
    const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(e.message) : { message: e.message };
    showToast(`❌ Metadata update failed: ${fe.message}`, 'error', 8000);
  } finally {
    await sftkHistoryEnd(journal, { undo });
  }
  reloadFn();
}

// ── P4a: Standard picklists (StandardValueSet) ──────────────────

// The StandardValueSet DeveloperName rarely equals the field's API name:
// Account.Type lives in "AccountType", Opportunity.StageName in
// "OpportunityStage", Contact.Salutation in plain "Salutation". Candidate
// names to try, most specific first. Pure — unit-tested.
function sftkSvsCandidates(obj, field) {
  const SPECIAL = {
    'Opportunity.StageName':                ['OpportunityStage'],
    'Account.AccountSource':                ['AccountSource', 'LeadSource'],
    'Lead.Rating':                          ['LeadRating', 'AccountRating'],
    'OpportunityTeamMember.TeamMemberRole': ['SalesTeamRole'],
    'AccountContactRole.Role':              ['AccountContactRole'],
    'CaseContactRole.Role':                 ['CaseContactRole'],
    'ContractContactRole.Role':             ['ContractContactRole'],
    'OpportunityPartner.Role':              ['PartnerRole'],
    'AccountPartner.Role':                  ['PartnerRole'],
  };
  const out = [];
  const push = n => { if (n && !out.includes(n)) out.push(n); };
  (SPECIAL[`${obj}.${field}`] || []).forEach(push);
  push(`${obj}${field}`);   // AccountType, CaseStatus, TaskPriority…
  push(field);              // Industry, Salutation, LeadSource…
  return out;
}

// Describe-based read-only fallback: build a rawValues list (pkValueName
// shape) from a describe field's ACTIVE picklist values. Pure — unit-tested.
function sftkDescribeValues(fieldMeta) {
  return ((fieldMeta && fieldMeta.picklistValues) || [])
    .filter(v => v.active !== false)
    .map(v => ({ fullName: v.value, label: v.label || v.value, isActive: true, default: v.defaultValue === true }));
}

async function _pkLoadStandard(sess, field, obj, isMulti) {
  const body = eid('dsPkBody');
  if (!body) return;
  body.innerHTML = `<div class="ds-init-loading">${window.sftkCat ? sftkCat('Loading standard value set…') : 'Loading…'}</div>`;
  try {
    const candidates = sftkSvsCandidates(obj, field);
    const q = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true,
      query: `SELECT Id, MasterLabel, DeveloperName FROM StandardValueSet WHERE DeveloperName IN (${candidates.map(soqlStrLit).join(', ')})`, _silentError: true });
    const recs = (q && !q.error) ? (q.records || []) : [];
    const rec = candidates.map(c => recs.find(r => r.DeveloperName === c)).find(Boolean);
    if (!rec) return _pkStandardDegrade(sess, field, obj, isMulti, `no StandardValueSet matched ${candidates.join(' / ')} via the Tooling API`);
    const meta = await sendBg({ type: 'SF_TOOLING_GET', orgUrl: sess.orgUrl, sid: sess.sid, sobject: 'StandardValueSet', id: rec.Id });
    if (meta?.error || !meta?.Metadata) return _pkStandardDegrade(sess, field, obj, isMulti, meta?.error || 'the value-set metadata is unavailable');
    const values = meta.Metadata.standardValue || [];
    if (!values.length) return _pkStandardDegrade(sess, field, obj, isMulti, 'no standard values returned');
    const { usage } = await _pkLoadUsage(sess, obj, field, isMulti, values);
    _pkStd = { orgUrl: sess.orgUrl, sid: sess.sid, obj, field, isMulti, svsId: rec.Id, svsName: rec.DeveloperName, metadata: meta.Metadata, rawValues: values, usage };
    _pkRenderStandard();
  } catch (e) {
    _pkStandardDegrade(sess, field, obj, isMulti, e.message);
  }
}

// Metadata path failed (SVS unresolved, or no Customize Application perm) —
// fall back to the describe instead of a dead-end lock banner: active values,
// live usage counts and 🔧 data fixes all still work; only add/deactivate
// needs Setup. (user 2026-07-25: "we need to present them here and not send
// the user to compare them manually")
async function _pkStandardDegrade(sess, field, obj, isMulti, reason) {
  const body = eid('dsPkBody');
  if (!body) return;
  const base = String(sess.orgUrl || '').replace(/\/$/, '');
  const setupUrl = `${base}/lightning/setup/ObjectManager/${encodeURIComponent(obj)}/FieldsAndRelationships/view`;
  try {
    const desc = await describe(obj, sess.orgUrl, sess.sid);
    const fieldMeta = (desc?.fields || []).find(f => f.name === field);
    const rawValues = sftkDescribeValues(fieldMeta);
    if (!rawValues.length) throw new Error('the describe returned no active values either');
    const { usage } = await _pkLoadUsage(sess, obj, field, isMulti, rawValues);
    _pkRenderValueSet({ orgUrl: sess.orgUrl, sid: sess.sid, obj, field, isMulti, rawValues, usage }, {
      title: `Standard picklist ${field} — values via describe`,
      banner: `<div class="ds-pk-banner">🔒 <strong>${esc(field)}</strong> is a standard picklist and its value-set metadata isn't writable from here (${esc(reason)}), so activate/deactivate lives in <a href="${esc(setupUrl)}" target="_blank" rel="noopener">↗ Setup</a>. Everything below is live: active values, record counts and 🔧 data fixes. Inactive values can't be listed without the metadata.</div>`,
      readOnlyMeta: true,
      allowDelete: false,
      applyFn: () => { throw new Error('Standard value-set metadata is read-only here — use Setup.'); },
      reloadFn: () => loadPicklistInventory(),
    });
  } catch (e) {
    body.innerHTML = `<div class="ds-pk-banner">🔒 <strong>${esc(field)}</strong> is a standard picklist and can't be edited here
      (${esc(reason)}; ${esc(e.message)}). <a href="${esc(setupUrl)}" target="_blank" rel="noopener">↗ Manage in Setup</a></div>`;
  }
}

function _pkRenderStandard() {
  const std = _pkStd;
  const base = String(std.orgUrl || '').replace(/\/$/, '');
  const url = `${base}/lightning/setup/Picklists/home`;
  _pkRenderValueSet(std, {
    title: `Standard picklist ${std.field}`,
    banner: `<div class="ds-pk-banner">🔧 Editing the <strong>${esc(std.svsName)}</strong> standard value set — this affects the value on every object that uses it. <a href="${esc(url)}" target="_blank" rel="noopener">↗ Setup</a></div>`,
    allowDelete: false,   // standard values can't be hard-deleted safely — deactivate only
    applyFn: (idx, op, journal) => _pkStdApplyCore(std, idx, op, journal),
    reloadFn: () => loadPicklistInventory(),
  });
}

// StandardValueSet metadata uses `standardValue[].isActive`. Toggle + PATCH back.
async function _pkStdApplyCore(std, idx, op, journal) {
  // History (sftk-history.js): the undo writes this snapshot back.
  const before = sftkMetaForPatch(JSON.parse(JSON.stringify(std.metadata)));
  const wasActive = std.metadata.standardValue[idx].isActive !== false;
  const nameField = ('fullName' in std.metadata.standardValue[idx]) ? 'fullName' : ('valueName' in std.metadata.standardValue[idx]) ? 'valueName' : 'label';
  const md = JSON.parse(JSON.stringify(std.metadata));
  const list = md.standardValue || [];
  list[idx].isActive = !op.deactivate;   // activate → true, deactivate → false
  if (op.deactivate && list[idx].default) list[idx].default = false;
  const name = pkValueName(list[idx]);
  const wantActive = !op.deactivate;
  // The one write discipline (sftk-write.js): one re-read of this
  // StandardValueSet closes the same gap a PATCH accepted-but-unchanged
  // taught elsewhere — the toggle used to be "done" the moment Salesforce
  // returned 204.
  // confirmed-by: _pkValueSetWizard confirms via sftkConfirmDestructive before calling this core.
  const w = await sftkWriteVerified({
    describe: `${std.field} value "${name}"`,
    write: () => sendBg({ type: 'SF_PATCH', orgUrl: std.orgUrl, sid: std.sid,
      path: `services/data/v62.0/tooling/sobjects/StandardValueSet/${std.svsId}`, body: { Metadata: sftkMetaForPatch(md) } }),
    journal: journal || null,   // history-by: _pkValueSetWizard's journal (the button press)
    verify: async () => {
      const back = await sendBg({ type: 'SF_TOOLING_GET', orgUrl: std.orgUrl, sid: std.sid, sobject: 'StandardValueSet', id: std.svsId, _suppressError: true });
      const list2 = back?.Metadata?.standardValue;
      if (back?.error || !Array.isArray(list2)) throw new Error(back?.error || 'the value set could not be re-read');
      const now = list2.find(v => pkValueName(v) === name);
      const nowActive = now ? now.isActive !== false : null;
      return { ok: nowActive === wantActive,
        text: nowActive === wantActive ? undefined
          : `${std.field} value "${name}": accepted by Salesforce, but the org still shows it ${nowActive ? 'active' : 'inactive'}` };
    },
  });
  if (!w.ok) throw new Error(w.raw?.error || w.text);
  return { ok: true, undo: { steps: [{
    describe: `${std.field}: write the previous standard value back (“${name}” ${wasActive ? 'active' : 'inactive'} again)`,
    // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
    msg: { type: 'SF_PATCH', path: `services/data/v62.0/tooling/sobjects/StandardValueSet/${std.svsId}`, body: { Metadata: before } },
    verify: { query: `SELECT Id, Metadata FROM StandardValueSet WHERE Id = '${std.svsId}'`, tooling: true,
      pick: 'records.0.Metadata.standardValue', where: { field: nameField, equals: name },
      field: 'isActive', ...(wasActive ? { notFalse: true } : { equals: false }),
      text: { ok: `${std.field} “${name}” is ${wasActive ? 'active' : 'inactive'} again — verified by re-reading the value set`,
              bad: `${std.field}: the previous value was accepted, but the value set still does not read “${name}” as ${wasActive ? 'active' : 'inactive'}` } },
  }] } };
}

// ── P4b: Global value sets (GlobalValueSet) ─────────────────────
async function _pkLoadGlobal(sess, r) {
  const body = eid('dsPkBody');
  if (!body) return;
  body.innerHTML = `<div class="ds-init-loading">${window.sftkCat ? sftkCat('Loading global value set…') : 'Loading…'}</div>`;
  try {
    const q = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true,
      query: `SELECT Id, MasterLabel, DeveloperName FROM GlobalValueSet WHERE DeveloperName = ${soqlStrLit(r.name)}`, _silentError: true });
    const rec = (q && !q.error) ? (q.records || [])[0] : null;
    if (!rec) return _pkGlobalDegrade(sess, r, 'Could not resolve the global value set via the Tooling API.');
    const meta = await sendBg({ type: 'SF_TOOLING_GET', orgUrl: sess.orgUrl, sid: sess.sid, sobject: 'GlobalValueSet', id: rec.Id });
    if (meta?.error || !meta?.Metadata) return _pkGlobalDegrade(sess, r, meta?.error || 'Global value set metadata is unavailable.');
    const values = meta.Metadata.customValue || [];
    if (!values.length) return _pkGlobalDegrade(sess, r, 'No values returned for this global value set.');
    const { usage } = await _pkLoadUsage(sess, r.obj, r.field, r.isMulti, values);
    // Which fields share this GVS? (warn before any edit) — degrade to null if unavailable.
    const dep = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true,
      query: `SELECT MetadataComponentName FROM MetadataComponentDependency WHERE RefMetadataComponentType = 'GlobalValueSet' AND RefMetadataComponentName = ${soqlStrLit(r.name)}`, _silentError: true });
    const usedBy = (dep && !dep.error) ? [...new Set((dep.records || []).map(x => x.MetadataComponentName).filter(Boolean))] : null;
    _pkGvs = { orgUrl: sess.orgUrl, sid: sess.sid, obj: r.obj, field: r.field, isMulti: r.isMulti, gvsId: rec.Id, gvsName: rec.DeveloperName, metadata: meta.Metadata, rawValues: values, usage, usedBy };
    _pkRenderGlobal();
  } catch (e) {
    _pkGlobalDegrade(sess, r, e.message);
  }
}

function _pkGlobalDegrade(sess, r, reason) {
  const body = eid('dsPkBody');
  if (!body) return;
  const base = String(sess.orgUrl || '').replace(/\/$/, '');
  const url = `${base}/lightning/setup/Picklists/home`;
  body.innerHTML = `<div class="ds-pk-banner">🌐 <strong>${esc(r.field)}</strong> uses the global value set
    <strong>${esc(r.name)}</strong>, which can't be edited here (${esc(reason)}).
    <a href="${esc(url)}" target="_blank" rel="noopener">↗ Manage in Setup</a></div>`;
}

function _pkRenderGlobal() {
  const gvs = _pkGvs;
  const usedBy = gvs.usedBy;
  const banner = `<div class="ds-pk-banner">🌐 Editing the global value set <strong>${esc(gvs.gvsName)}</strong> —
    changes affect ${usedBy === null ? '<em>every field that uses it</em>' : `<strong>${usedBy.length}</strong> field(s)${usedBy.length ? `: ${esc(usedBy.slice(0, 8).join(', '))}${usedBy.length > 8 ? '…' : ''}` : ''}`}.
    The data fix below only touches <strong>${esc(gvs.obj)}.${esc(gvs.field)}</strong> — other fields keep the value on their records.</div>`;
  _pkRenderValueSet(gvs, {
    title: `Global value set ${gvs.gvsName}`,
    banner,
    allowDelete: true,
    applyFn: (idx, op, journal) => _pkGvsApplyCore(gvs, idx, op, journal),
    reloadFn: () => loadPicklistInventory(),
  });
}

// GlobalValueSet metadata uses `customValue[]`. Activate/deactivate/remove + PATCH.
async function _pkGvsApplyCore(gvs, idx, op, journal) {
  // History (sftk-history.js): the undo writes this snapshot back — a
  // remove is only ever kept INACTIVE by Salesforce (see below), so writing
  // the previous set back re-activates it, same as _pkApplyMetadata.
  const before = sftkMetaForPatch(JSON.parse(JSON.stringify(gvs.metadata)));
  const beforeEntry = (gvs.metadata.customValue || [])[idx];
  const wasActive = beforeEntry ? beforeEntry.isActive !== false : true;
  const nameField = beforeEntry && ('fullName' in beforeEntry) ? 'fullName' : beforeEntry && ('valueName' in beforeEntry) ? 'valueName' : 'label';
  const md = JSON.parse(JSON.stringify(gvs.metadata));
  const list = md.customValue || [];
  const name = pkValueName((gvs.metadata.customValue || [])[idx]);
  if (op.remove) list.splice(idx, 1);
  else {
    list[idx].isActive = !!op.activate;
    if (op.deactivate && list[idx].default) list[idx].default = false;
  }
  // The one write discipline (sftk-write.js): one re-read of this
  // GlobalValueSet closes the same gap a PATCH accepted-but-unchanged taught
  // elsewhere — a remove that Salesforce keeps as inactive (same API limit
  // as a CustomField's value set) is reported as what the org actually shows.
  // confirmed-by: _pkValueSetWizard confirms via sftkConfirmDestructive before calling this core.
  const w = await sftkWriteVerified({
    describe: `${gvs.gvsName} value "${name}"`,
    write: () => sendBg({ type: 'SF_PATCH', orgUrl: gvs.orgUrl, sid: gvs.sid,
      path: `services/data/v62.0/tooling/sobjects/GlobalValueSet/${gvs.gvsId}`, body: { Metadata: sftkMetaForPatch(md) } }),
    journal: journal || null,   // history-by: _pkValueSetWizard's journal (the button press)
    verify: async () => {
      const back = await sendBg({ type: 'SF_TOOLING_GET', orgUrl: gvs.orgUrl, sid: gvs.sid, sobject: 'GlobalValueSet', id: gvs.gvsId, _suppressError: true });
      const list2 = back?.Metadata?.customValue;
      if (back?.error || !Array.isArray(list2)) throw new Error(back?.error || 'the value set could not be re-read');
      const now = list2.find(v => pkValueName(v) === name);
      // A remove has no pass/fail here — Salesforce's API keeps a removed
      // value as inactive rather than deleting it (same limit as a
      // CustomField's value set), and that is expected, not a failure.
      if (op.remove) return { ok: true };
      const nowActive = now ? now.isActive !== false : null;
      const wantActive = !!op.activate;
      return { ok: nowActive === wantActive,
        text: nowActive === wantActive ? undefined
          : `${gvs.gvsName} value "${name}": accepted by Salesforce, but the org still shows it ${nowActive ? 'active' : 'inactive'}` };
    },
  });
  if (!w.ok) throw new Error(w.raw?.error || w.text);
  return { ok: true, undo: { steps: [{
    describe: `${gvs.gvsName}: write the previous value set back (“${name}” ${wasActive ? 'active' : 'inactive'} again)`,
    // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
    msg: { type: 'SF_PATCH', path: `services/data/v62.0/tooling/sobjects/GlobalValueSet/${gvs.gvsId}`, body: { Metadata: before } },
    verify: { query: `SELECT Id, Metadata FROM GlobalValueSet WHERE Id = '${gvs.gvsId}'`, tooling: true,
      pick: 'records.0.Metadata.customValue', where: { field: nameField, equals: name },
      field: 'isActive', ...(wasActive ? { notFalse: true } : { equals: false }),
      text: { ok: `${gvs.gvsName} “${name}” is ${wasActive ? 'active' : 'inactive'} again — verified by re-reading the value set`,
              bad: `${gvs.gvsName}: the previous value set was accepted, but it still does not read “${name}” as ${wasActive ? 'active' : 'inactive'}` } },
  }] } };
}

// ════════════════════════════════════════════════════════════════
// P5 — SYNC FROM SOURCE: make target value sets match a source org
// ════════════════════════════════════════════════════════════════
// One full-Metadata PATCH per target field applies every ticked value
// operation; record-type assignments align per shared DeveloperName.
// Deactivations that would strand data show usage counts and start unticked.
async function _pkApplySyncCore(tgt, sel, journal) {
  // History (sftk-history.js): the undo writes this snapshot back, verified
  // by the value count returning to what it was (a sync can touch several
  // values at once — a per-value re-check like _pkApplyMetadata's isn't
  // generic here, so the count is the honest, generic check available).
  const before = sftkMetaForPatch(JSON.parse(JSON.stringify(tgt.inv.metadata)));
  const beforeCount = (tgt.inv.metadata.valueSet?.valueSetDefinition?.value || []).length;
  const md = JSON.parse(JSON.stringify(tgt.inv.metadata));
  const list = md.valueSet.valueSetDefinition.value;
  const by = new Map(list.map(v => [pkValueName(v), v]));
  for (const a of sel.adds)      if (!by.has(a.name)) list.push({ fullName: a.name, label: a.label, default: false, isActive: a.active });
  for (const lc of sel.labels)   { const v = by.get(lc.name); if (v) v.label = lc.to; }
  for (const n of sel.activate)  { const v = by.get(n); if (v) v.isActive = true; }
  for (const n of sel.deactivate){ const v = by.get(n); if (v) { v.isActive = false; if (v.default) v.default = false; } }
  for (const n of sel.extrasOff) { const v = by.get(n); if (v) { v.isActive = false; if (v.default) v.default = false; } }
  if (sel.alignDefault && sel.alignDefault.to) {
    for (const v of list) v.default = false;
    const dv = by.get(sel.alignDefault.to) || list.find(v => pkValueName(v) === sel.alignDefault.to);
    if (dv && dv.isActive !== false) dv.default = true;
  }
  // The one write discipline (sftk-write.js): this PATCH bundles several
  // value operations into one call — one re-read of the field's Metadata,
  // spot-checking each operation, catches a partial apply the 204 alone
  // would have hidden (the same shape of lie a flow switch once told).
  // confirmed-by: _pkOpenSyncPlan's Run button confirms via sftkConfirmDestructive first.
  const w = await sftkWriteVerified({
    describe: `${tgt.inv.obj}.${tgt.inv.field} sync`,
    write: () => sendBg({ type: 'SF_PATCH', orgUrl: tgt.inv.orgUrl, sid: tgt.inv.sid,
      path: `services/data/v62.0/tooling/sobjects/CustomField/${tgt.inv.fieldId}`,
      body: { Metadata: sftkMetaForPatch(md) } }),
    journal: journal || null,   // history-by: the caller's entry (_pkRunSyncPlan's per-target journal)
    verify: async () => {
      const back = await sendBg({ type: 'SF_TOOLING_GET', orgUrl: tgt.inv.orgUrl, sid: tgt.inv.sid, sobject: 'CustomField', id: tgt.inv.fieldId, _suppressError: true });
      const list2 = back?.Metadata?.valueSet?.valueSetDefinition?.value;
      if (back?.error || !Array.isArray(list2)) throw new Error(back?.error || 'the field could not be re-read');
      const by2 = new Map(list2.map(v => [pkValueName(v), v]));
      const mismatches = [];
      for (const a of sel.adds)       if (!by2.has(a.name)) mismatches.push(`${a.name} not added`);
      for (const lc of sel.labels)    { const v = by2.get(lc.name); if (v && v.label !== lc.to) mismatches.push(`${lc.name} label not updated`); }
      for (const n of sel.activate)   { const v = by2.get(n); if (!v || v.isActive === false) mismatches.push(`${n} not active`); }
      for (const n of sel.deactivate) { const v = by2.get(n); if (v && v.isActive !== false) mismatches.push(`${n} not deactivated`); }
      for (const n of sel.extrasOff)  { const v = by2.get(n); if (v && v.isActive !== false) mismatches.push(`${n} not deactivated`); }
      if (sel.alignDefault && sel.alignDefault.to) {
        const dv = by2.get(sel.alignDefault.to);
        if (dv && dv.isActive !== false && dv.default !== true) mismatches.push(`${sel.alignDefault.to} not set as default`);
      }
      return mismatches.length
        ? { ok: false, text: `${tgt.inv.obj}.${tgt.inv.field} sync: accepted by Salesforce, but the org still doesn't match on ${mismatches.slice(0, 5).join(', ')}${mismatches.length > 5 ? '…' : ''}` }
        : { ok: true };
    },
  });
  if (!w.ok) throw new Error(w.raw?.error || w.text);
  return { ok: true, undo: { steps: [{
    describe: `${tgt.inv.obj}.${tgt.inv.field}: write the pre-sync value set back`,
    // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
    msg: { type: 'SF_PATCH', path: `services/data/v62.0/tooling/sobjects/CustomField/${tgt.inv.fieldId}`, body: { Metadata: before } },
    verify: { query: `SELECT Id, Metadata FROM CustomField WHERE Id = '${tgt.inv.fieldId}'`, tooling: true,
      pick: 'records.0.Metadata.valueSet.valueSetDefinition.value', count: beforeCount,
      text: { ok: `${tgt.inv.obj}.${tgt.inv.field}: pre-sync value set written back (${beforeCount} value(s)) — verified by re-reading the field`,
              bad: `${tgt.inv.obj}.${tgt.inv.field}: the pre-sync value set was accepted, but the field doesn't show ${beforeCount} value(s) again — check it in Setup` } },
  }] } };
}

// T8c — the sync plan used to align values across orgs with NO automation check
// at all. This pass runs _pkValueLiteralScan IN EACH TARGET for every value the
// plan would deactivate there, links the hits, and leaves any row with hits
// UNTICKED with a visible reason (mirroring the usage guard). Rows start
// disabled so nothing can be ticked before it has been checked; the Run button
// stays disabled until the pass finishes. `token` lets a re-render (source
// change) abandon an in-flight pass.
async function _pkSyncAutomationPass(plans, guards, obj, field, token) {
  const CAP = 20;   // hard cap on scans per plan — each one is several queries
  // The Go button is now the shared confirm dialog's own footer button
  // (sftk-confirm.js, campaign 3 phase 2) — kept disabled by the caller until
  // this pass finishes, same "Run waits for the check" gating as before.
  const runBtn = () => eid('sftkConfirmGo');
  const noteEl = () => eid('dsPkSyncAutoNote');
  const finishBtn = () => { const b = runBtn(); if (b) { b.disabled = false; b.textContent = '🔄 Sync selected'; } };

  if (!guards.length) {
    const n = noteEl();
    if (n) n.innerHTML = '✓ This plan would not switch any value off in any target — no automation check needed.';
    finishBtn();
    return;
  }

  let done = 0, hitRows = 0, overCap = 0, failed = 0, abortMsg = '';
  try {
    for (let i = 0; i < guards.length; i++) {
      if (token !== _pkSyncScanToken) return;   // plan re-rendered — abandon quietly
      const g = guards[i];
      const c = document.querySelector(`.ds-sync-one[data-g="${i}"]`);
      const s = document.querySelector(`.ds-sync-auto[data-g="${i}"]`);
      if (!c) continue;
      const tgt = plans[g.pi]?.tgt;
      const defaultTick = () => { c.checked = (g.op === 'deactivate') && !g.usage; };

      if (!tgt || !tgt.inv) { c.disabled = false; if (s) s.innerHTML = '<span style="color:var(--warning)">⚠ target inventory unavailable — automation NOT checked, left unticked</span>'; continue; }
      if (done >= CAP) {
        overCap++;
        c.disabled = false;
        if (s) s.innerHTML = `<span style="color:var(--warning)">⚠ automation NOT checked — this plan hit the ${CAP}-scan cap. Tick it only if you have checked the flows yourself.</span>`;
        continue;
      }

      const key = `${tgt.orgKey}|${obj}.${field}|${g.val}`;
      let lit = _pkSyncScanCache.get(key);
      if (!lit) {
        try { lit = await _pkValueLiteralScan(tgt.inv, g.val); _pkSyncScanCache.set(key, lit); }
        catch (e) { lit = { error: e.message }; }   // failures are NOT cached — a re-render retries
      }
      if (token !== _pkSyncScanToken) return;
      done++;
      c.disabled = false;

      if (lit.error) {
        failed++;
        c.checked = false;
        if (s) s.innerHTML = `<span style="color:var(--warning)">⚠ automation check FAILED here (${esc(lit.error)}) — left unticked</span>`;
      } else if (lit.mentions) {
        hitRows++;
        c.checked = false;
        const links = (lit.items || []).slice(0, 6).map(it =>
          it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">${it.kind === 'flow' ? '🌊' : '✅'} ${esc(it.label)}</a>`
                 : `${it.kind === 'flow' ? '🌊' : '✅'} ${esc(it.label)}`).join(' · ');
        if (s) s.innerHTML = `<span style="color:var(--danger)">⛔ UNTICKED — ${lit.mentions} automation(s) in ${esc(tgt.label)} name “${esc(g.val)}”: </span>${links}${(lit.items || []).length > 6 ? ' …' : ''}${(lit.notes || []).length ? `<span style="color:var(--warning)"> · ⚠ ${esc(lit.notes.join(' · '))}</span>` : ''}`;
      } else {
        defaultTick();
        // A capped or partial scan cannot vouch for "no flow" — say what was
        // scanned (live 2026-09-23: "✓ no flow … names this value" sat next
        // to "the other 107 were NOT checked").
        const partial = (lit.notes || []).length > 0;
        if (s) s.innerHTML = `<span style="color:var(--success)">✓ ${partial ? 'nothing that was scanned in' : 'no flow or validation rule in'} ${esc(tgt.label)} names this value</span>`
          + (g.usage ? `<span style="color:var(--warning)"> · still unticked: ${g.usage.toLocaleString()} record(s) hold it</span>` : '')
          + ((lit.notes || []).length ? `<span style="color:var(--warning)"> · ⚠ ${esc(lit.notes.join(' · '))}</span>` : '');
      }
    }
  } catch (e) {
    abortMsg = e.message;
  } finally {
    if (token === _pkSyncScanToken) {
      // Never leave a row permanently un-tickable, whatever went wrong above.
      document.querySelectorAll('.ds-sync-one[disabled]').forEach(c => { c.disabled = false; });
      finishBtn();
      const n = noteEl();
      const unchecked = guards.length - done;
      if (n) n.innerHTML = `🔎 Automation check: <strong>${done}</strong> of ${guards.length} switch-off row(s) scanned`
        + (overCap ? ` · <span style="color:var(--warning)">${overCap} NOT checked (${CAP}-scan cap)</span>` : '')
        + (failed ? ` · <span style="color:var(--warning)">${failed} scan(s) failed</span>` : '')
        + (abortMsg ? ` · <span style="color:var(--warning)">the pass STOPPED EARLY (${esc(abortMsg)})</span>` : '')
        + ` · <strong>${hitRows}</strong> row(s) reference the value in a flow or validation rule and start unticked.`
        + (unchecked > 0 ? ` <strong>${unchecked} row(s) were never checked</strong> — they stay unticked; verify them yourself before ticking.` : '');
    }
  }
}

async function _pkOpenSyncPlan() {
  const M = _pkMatrix;
  if (!M) return;
  const loaded = M.results.filter(r => r.inv);
  if (loaded.length < 2) {
    if (M.results.some(r => r.stdInv)) {
      showToast('This is a standard picklist — its value set is edited in Setup, so the sync plan can\'t write it. Use the matrix above to see exactly what differs per org.', 'warning', 8000);
    } else {
      showToast('Load at least two orgs in the matrix first', 'warning', 5000);
    }
    return;
  }
  _pkSyncScanCache.clear();   // value sets may have moved since the last plan

  // Source: the ring's source of truth, LOCKED when it's among the loaded
  // orgs (user 2026-07-18: "source should be auto selected… without the
  // option to unmark"). Only when no ring exists — or its source isn't in
  // the matrix — does a manual picker appear (with an explicit warning,
  // never a silent fallback to whichever org loaded first).
  const ringSrcKey = _orgKey((typeof _ring === 'object' && _ring?.sourceUrl && (_ring.orgs || []).length >= 2) ? _ring.sourceUrl : '');
  const ringLoadedIdx = ringSrcKey ? loaded.findIndex(r => r.orgKey === ringSrcKey) : -1;
  let srcIdx = Math.max(0, ringLoadedIdx);
  const srcLocked = ringLoadedIdx >= 0;

  const render = () => {
    const src = loaded[srcIdx];
    const targets = loaded.filter((_, i) => i !== srcIdx);
    const plans = targets.map(tgt => ({
      tgt,
      diff: pkValueSetSyncDiff(src.inv.rawValues, tgt.inv.rawValues),
    }));

    const usageOf = (tgt, name) => {
      const c = tgt.inv.usage?.has?.(name) ? tgt.inv.usage.get(name) : null;
      return (c == null || c < 0) ? null : c;
    };

    // T8c: every operation that would TURN A VALUE OFF in a target is a
    // "guard row" — it gets its own automation scan IN THAT TARGET before it
    // may be ticked. Flat + indexed so the async pass can address each row by
    // a plain numeric selector (value names can contain quotes).
    const guards = [];
    plans.forEach((pl, pi) => {
      for (const n of pl.diff.deactivate) guards.push({ pi, op: 'deactivate', val: n, usage: usageOf(pl.tgt, n) });
      for (const n of pl.diff.extras)     guards.push({ pi, op: 'extrasOff',  val: n, usage: usageOf(pl.tgt, n) });
    });
    const gi = (pi, op, val) => guards.findIndex(g => g.pi === pi && g.op === op && g.val === val);

    // Data fix INSIDE the plan (user 2026-07-25: "what about the datafix and
    // picklist change when the values are drifted?"): a value that records
    // still hold may only be switched off together with a chosen fix — move
    // the records to a value that will be ACTIVE after this sync (the
    // source's active set), or clear the field. Runs BEFORE the metadata
    // change, per target, via the same _pkDataFixCore the wizards use.
    const remapTargets = src.inv.rawValues
      .filter(v => v.isActive !== false)
      .map(v => pkValueName(v));
    const fixCtl = (k, n, u) => !u ? '' : `
      <div class="ds-sync-fix" style="font-size:12px;margin:-2px 0 6px 22px">
        ↳ first, its ${u.toLocaleString()} record(s):
        <select class="ds-sync-fixsel ds-select ds-select-sm" data-g="${k}">
          <option value="">— keep holding “${esc(n)}” (pick a fix to enable the tick) —</option>
          ${remapTargets.filter(v => v !== n).map(v => `<option value="${esc(v)}">move to “${esc(v)}”</option>`).join('')}
          <option value="__clear__">clear the field</option>
        </select>
      </div>`;

    // The one confirmation (sftk-confirm.js, campaign 3 phase 2): the plan's
    // own form (source picker, per-target checkboxes, per-value data-fix
    // selects) rides along as extraHtml; Go — the dialog's own #sftkConfirmGo —
    // stays disabled with the same "checking automation" wording until every
    // guarded row has been scanned (same "Run waits for the check" gating as
    // before; the dialog's own sync only handles the checkbox/word, which this
    // dialog doesn't use, so the scan gate can't be raced by it).
    const bodyHtml = `
      <div class="ds-plan-op" style="margin-bottom:10px">
        Source of truth:
        ${srcLocked
          ? `<strong>${esc(loaded[srcIdx].label)}</strong> <span class="ds-pk-mx-sot" title="Locked to your Sync Ring's source of truth — every sync flows FROM it. Change it in the topbar SOURCE menu.">👑 source of truth</span>`
          : `<select id="dsPkSyncSrc" class="ds-select ds-select-sm">
              ${loaded.map((r, i) => `<option value="${i}" ${i === srcIdx ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
            </select>${ringSrcKey ? ` <span style="font-size:11px;color:var(--warning)">⚠ your 👑 source of truth isn't loaded in this matrix — reload the matrix with it, or pick a source explicitly</span>` : ''}`}
        <span class="ds-pk-hint">every other loaded org becomes a target</span>
      </div>
      ${plans.map((pl, pi) => {
        const d = pl.diff;
        const nothing = !d.adds.length && !d.labelChanges.length && !d.activate.length
          && !d.deactivate.length && !d.extras.length && !d.defaultChange;
        return `
        <div class="ds-plan-org" data-sync-idx="${pi}">
          <div class="ds-plan-org-hdr"><strong>${esc(pl.tgt.label)}</strong> ${prodBadge(pl.tgt.orgUrl)}
            ${nothing ? '<span class="ds-ring-clean">✓ matches the source — nothing to do</span>' : ''}</div>
          ${d.adds.length ? `<label class="ds-plan-op"><input type="checkbox" class="ds-sync-op" data-p="${pi}" data-op="adds" checked>
            ➕ Add <strong>${d.adds.length}</strong> value${d.adds.length !== 1 ? 's' : ''}: ${esc(d.adds.slice(0, 6).map(a => a.name).join(', '))}${d.adds.length > 6 ? '…' : ''}</label>` : ''}
          ${d.labelChanges.length ? `<label class="ds-plan-op"><input type="checkbox" class="ds-sync-op" data-p="${pi}" data-op="labels" checked>
            ✏ Align <strong>${d.labelChanges.length}</strong> label${d.labelChanges.length !== 1 ? 's' : ''} (${esc(d.labelChanges.slice(0, 3).map(l => `${l.from}→${l.to}`).join(', '))}${d.labelChanges.length > 3 ? '…' : ''})</label>` : ''}
          ${d.activate.length ? `<label class="ds-plan-op"><input type="checkbox" class="ds-sync-op" data-p="${pi}" data-op="activate" checked>
            ▶ Activate <strong>${d.activate.length}</strong>: ${esc(d.activate.slice(0, 6).join(', '))}</label>` : ''}
          ${d.deactivate.map(n => {
            const u = usageOf(pl.tgt, n);
            const k = gi(pi, 'deactivate', n);
            // The automation note sits OUTSIDE the <label> on purpose — a link
            // inside a label would toggle the checkbox when clicked.
            return `<div><label class="ds-plan-op"><input type="checkbox" class="ds-sync-one" data-p="${pi}" data-op="deactivate" data-g="${k}" data-val="${esc(n)}" disabled>
              ⏸ Deactivate <strong>${esc(n)}</strong> (inactive in source)${u ? ` — <span class="ds-ring-m">${u.toLocaleString()} record(s) still hold it</span>` : ''}</label>
              <div class="ds-sync-auto" data-g="${k}" style="font-size:11px;color:var(--subtext);margin:-2px 0 6px 22px">⏳ checking this org's automation for “${esc(n)}”…</div>${fixCtl(k, n, u)}</div>`;
          }).join('')}
          ${d.extras.map(n => {
            const u = usageOf(pl.tgt, n);
            const k = gi(pi, 'extrasOff', n);
            return `<div><label class="ds-plan-op"><input type="checkbox" class="ds-sync-one" data-p="${pi}" data-op="extrasOff" data-g="${k}" data-val="${esc(n)}" disabled>
              🔵 Deactivate extra <strong>${esc(n)}</strong> (not in source${u ? ` — <span class="ds-ring-m">${u.toLocaleString()} record(s)</span>` : ''}) — never deleted automatically</label>
              <div class="ds-sync-auto" data-g="${k}" style="font-size:11px;color:var(--subtext);margin:-2px 0 6px 22px">⏳ checking this org's automation for “${esc(n)}”…</div>${fixCtl(k, n, u)}</div>`;
          }).join('')}
          ${d.defaultChange ? `<label class="ds-plan-op"><input type="checkbox" class="ds-sync-op" data-p="${pi}" data-op="alignDefault" checked>
            ⭐ Default: ${esc(d.defaultChange.from || '—')} → <strong>${esc(d.defaultChange.to || '—')}</strong></label>` : ''}
          <label class="ds-plan-op"><input type="checkbox" class="ds-sync-op" data-p="${pi}" data-op="rts" checked>
            🎛 Align record-type assignments to the source (matched by developer name — computed on run)</label>
        </div>`;
      }).join('')}
      <div class="ds-pk-note" id="dsPkSyncAutoNote" style="margin-top:8px">⏳ Checking each target org's flows and validation rules for the values this plan would switch off…</div>
      <div class="ds-pk-hint">Adds copy the source's label and active state. Value ORDER isn't synced. Standard picklists and global value sets can't be written by this sync — compare them in the matrix.</div>`;

    (async () => {
      const gates = await Promise.all(plans.map(pl => sftkOrgWriteGate(pl.tgt.orgUrl, _orgs)));
      const prodPlans = plans.filter((pl, i) => gates[i].production);

      const ok = await sftkConfirmDestructive({
        title: `🔄 Sync ${esc(M.obj)}.${esc(M.field)} from source`,
        icon: '🔄',
        revOverride: { html: '🔁 <strong>Reversible</strong> — values, labels and record-type assignments in each ticked target are overwritten to match the source; deactivating a value keeps it recoverable by reactivating. Nothing here is deleted.', needsCheckbox: false },
        confirmLabel: '🔄 Sync selected',
        extraHtml: bodyHtml,
        production: prodPlans.length ? { label: prodPlans.map((pl, i) => gates[plans.indexOf(pl)].label || pl.tgt.label).join(', ') } : null,
        onRender: () => {
          const go = eid('sftkConfirmGo');
          if (go) { go.disabled = true; go.title = 'Enabled once the automation check has run in every org'; go.textContent = '⏳ checking automation…'; }

          // T8c — no deactivation may start ticked until THAT target's automation
          // has been checked. Runs after the modal is up so the plan renders instantly.
          _pkSyncAutomationPass(plans, guards, M.obj, M.field, ++_pkSyncScanToken);

          // Data-fix gating: a switch-off with records behind it can only be
          // ticked once a fix is chosen; clearing the fix unticks it again.
          const box = eid('dsModalBox');
          box?.addEventListener('change', e => {
            const cb = e.target.closest?.('.ds-sync-one');
            if (cb && cb.checked) {
              const g = guards[+cb.dataset.g];
              if (g && g.usage > 0) {
                const fix = box.querySelector(`.ds-sync-fixsel[data-g="${cb.dataset.g}"]`)?.value || '';
                if (!fix) {
                  cb.checked = false;
                  showToast(`${g.usage.toLocaleString()} record(s) still hold “${g.val}” — pick a data fix on that row first`, 'warning', 5000);
                }
              }
            }
            const sel = e.target.closest?.('.ds-sync-fixsel');
            if (sel && !sel.value) {
              const row = box.querySelector(`.ds-sync-one[data-g="${sel.dataset.g}"]`);
              if (row) row.checked = false;
            }
          });

          eid('dsPkSyncSrc')?.addEventListener('change', e => { srcIdx = +e.target.value; render(); });
        },
      });
      if (!ok) return;

      // Snapshot every tick + data-fix choice from the (now hidden, but not
      // yet cleared — closeModal only hides the overlay) dialog body, the
      // same values the old Go handler read, before the progress view below
      // replaces this content.
      const selPerPlan = plans.map((pl, pi) => {
        const on = op => !!document.querySelector(`.ds-sync-op[data-p="${pi}"][data-op="${op}"]:checked`);
        const ones = op => [...document.querySelectorAll(`.ds-sync-one[data-p="${pi}"][data-op="${op}"]:checked`)].map(c => c.dataset.val);
        const fixRows = [...document.querySelectorAll(`.ds-sync-one[data-p="${pi}"]:checked`)]
          .map(cb => ({ val: cb.dataset.val,
            fix: document.querySelector(`.ds-sync-fixsel[data-g="${cb.dataset.g}"]`)?.value || '' }))
          .filter(x => x.fix);
        return {
          sel: {
            adds: on('adds') ? pl.diff.adds : [],
            labels: on('labels') ? pl.diff.labelChanges : [],
            activate: on('activate') ? pl.diff.activate : [],
            deactivate: ones('deactivate'),
            extrasOff: ones('extrasOff'),
            alignDefault: on('alignDefault') ? pl.diff.defaultChange : null,
          },
          wantRts: on('rts'),
          fixRows,
        };
      });

      await _pkRunSyncPlan(M, src, plans, selPerPlan);
    })();
  };
  render();
}

// Runs the confirmed sync plan — a fresh progress view (mirrors runSequence's
// pattern in studio-profiles.js: confirm first, then a separate modal shows
// live per-target status while the writes happen).
async function _pkRunSyncPlan(M, src, plans, selPerPlan) {
  showModal(`
    <div class="ds-modal-header">🔄 Syncing ${esc(M.obj)}.${esc(M.field)} from ${esc(src.label)}</div>
    <div class="ds-modal-body">
      ${plans.map((pl, pi) => `<div class="ds-plan-org" data-sync-idx="${pi}">
        <div class="ds-plan-org-hdr"><strong>${esc(pl.tgt.label)}</strong> ${prodBadge(pl.tgt.orgUrl)}</div>
      </div>`).join('')}
    </div>
    <div class="ds-modal-footer">
      <button class="ds-btn ds-btn-primary" id="dsPkSyncClose" disabled>Running…</button>
    </div>`);

  const srcSess = await getOrgSession(src.orgUrl);
  for (let pi = 0; pi < plans.length; pi++) {
    const pl = plans[pi];
    const { sel, wantRts, fixRows } = selPerPlan[pi];
    const hdr = document.querySelector(`.ds-plan-org[data-sync-idx="${pi}"] .ds-plan-org-hdr`);
    const note = document.createElement('span');
    note.className = 'ds-plan-status';
    const anyValueOp = sel.adds.length || sel.labels.length || sel.activate.length
      || sel.deactivate.length || sel.extrasOff.length || sel.alignDefault;
    if (!anyValueOp && !wantRts) { note.textContent = ' — nothing ticked'; hdr?.appendChild(note); continue; }
    note.textContent = ' ⏳ syncing…';
    hdr?.appendChild(note);
    // History (sftk-history.js): one journal per target org — each target's
    // undo (data restores + the pre-sync value set + RT assignments) only
    // makes sense written back to that same org.
    const journal = sftkHistoryBegin({ tool: 'Picklist Manager',
      title: `🔄 ${M.obj}.${M.field} synced from ${src.label} — ${pl.tgt.label}`, orgUrl: pl.tgt.orgUrl || pl.tgt.inv?.orgUrl });
    const dataUndoSteps = [];
    const syncUndoSteps = [];
    const rtUndoSteps = [];
    let dataUndoNone = '';
    let syncErr = null;
    try {
      // Data fixes FIRST — records must stop holding a value before the
      // plan switches it off. Same core the wizards use, in THIS target.
      let fixedRecs = 0, fixFailed = 0;
      for (const f of fixRows) {
        note.textContent = ` ⏳ moving records off “${f.val}”…`;
        const ctx = { orgUrl: pl.tgt.inv.orgUrl, sid: pl.tgt.inv.sid,
          obj: M.obj, field: M.field, isMulti: !!pl.tgt.inv.isMulti };
        try {
          const out = await _pkDataFixCore(ctx, f.val,
            f.fix === '__clear__' ? 'clear' : 'remap',
            f.fix === '__clear__' ? null : f.fix, null, journal);
          fixedRecs += out.updated; fixFailed += out.failed;
          if (out.undo && Array.isArray(out.undo.steps)) dataUndoSteps.push(...out.undo.steps);
          else if (out.undo && out.undo.none) dataUndoNone = dataUndoNone ? `${dataUndoNone}; ${out.undo.none}` : out.undo.none;
        } catch (e) {
          fixFailed++;
          showToast(`${pl.tgt.label}: data fix for “${f.val}” failed — ${e.message}. The value will still be deactivated; its records keep the old value.`, 'error', 7000);
        }
      }
      note.textContent = ' ⏳ syncing…';
      if (anyValueOp) {
        const syncR = await _pkApplySyncCore(pl.tgt, sel, journal);
        if (syncR && syncR.undo && Array.isArray(syncR.undo.steps)) syncUndoSteps.push(...syncR.undo.steps);
      }
      let rtDone = 0, rtFail = 0;
      if (wantRts && srcSess) {
        const tgtSess = await getOrgSession(pl.tgt.orgUrl);
        const [srcRts, tgtRts] = await Promise.all([
          _pkLoadRecordTypes(srcSess, M.obj, M.field, M.field.replace(/__c$/i, '')),
          tgtSess ? _pkLoadRecordTypes(tgtSess, M.obj, M.field, M.field.replace(/__c$/i, '')) : Promise.resolve({ rts: [] }),
        ]);
        const rtPlans = pkRtSyncDiff(srcRts.rts, tgtRts.rts);
        for (const rp of rtPlans) {
          try {
            const rr = await _pkApplyRtCore({ orgUrl: pl.tgt.inv.orgUrl, sid: pl.tgt.inv.sid,
              field: M.field, devName: M.field.replace(/__c$/i, '') }, rp.rtId, rp.adds, rp.removes, journal);
            rtDone++;
            rtUndoSteps.push({
              describe: `${M.field}: write record type ${rr.rtId}'s previous assignments back`,
              // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
              msg: { type: 'SF_PATCH', path: `services/data/v62.0/tooling/sobjects/RecordType/${rr.rtId}`, body: { Metadata: rr.before } },
              verify: { query: `SELECT Id, Metadata FROM RecordType WHERE Id = '${rr.rtId}'`, tooling: true,
                pick: 'records.0.Metadata.picklistValues', where: { field: 'picklist', equals: M.field },
                field: 'values', notNull: true,
                text: { ok: `Record type ${rr.rtId}: previous ${M.field} assignments written back — verified by re-reading the record type`,
                        bad: `Record type ${rr.rtId}: the previous assignments were accepted, but the record type could not be re-read to confirm ${M.field} is still assigned` } },
            });
          } catch (_) { rtFail++; }
        }
      }
      note.textContent = ` ✅ synced${fixedRecs || fixFailed ? ` · 🔧 ${fixedRecs} record(s) moved${fixFailed ? ` (${fixFailed} failed)` : ''}` : ''}${wantRts ? ` · ${rtDone} record type${rtDone !== 1 ? 's' : ''} aligned${rtFail ? ` (${rtFail} failed)` : ''}` : ''}`;
    } catch (e) {
      syncErr = e;
      const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(e.message) : { message: e.message };
      note.textContent = ` ❌ ${fe.message}`;
    } finally {
      const steps = [...syncUndoSteps, ...rtUndoSteps, ...dataUndoSteps];
      await sftkHistoryEnd(journal, {
        nothingToDo: (!syncErr && !journal.what.length) ? 'already in sync — nothing needed writing in this target' : undefined,
        undo: steps.length ? { steps, note: dataUndoNone || undefined } : { none: dataUndoNone || 'nothing was applied to this target' } });
    }
  }
  const closeBtn = eid('dsPkSyncClose');
  if (closeBtn) { closeBtn.disabled = false; closeBtn.textContent = '✓ Done — reload the matrix to verify'; closeBtn.addEventListener('click', closeModal); }
  _history.push({ id: genId('run'), kind: 'picklist-sync',
    profileName: `Picklist sync: ${M.obj}.${M.field} from ${src.label}`,
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    status: 'success', sourceOrg: src.orgUrl, targetOrg: '',
    summary: {}, errors: [] });
  storageSaveHistory().catch(() => {});
}

// ════════════════════════════════════════════════════════════════
// T9 — WHOLE-OBJECT SWEEP: every picklist field × every selected org
// ════════════════════════════════════════════════════════════════
// The matrix answers "is THIS field in sync?". The sweep answers "is this
// OBJECT in sync?" — one verdict per picklist/multipicklist field, record
// types folded in, with a 🔄 Sync action per drifting field that reuses the
// existing single-field P5 plan (so every guard it carries — usage counts,
// the T8 automation check, the production typed-confirm — still applies).
//
// Cost control, stated in the UI rather than hidden: the field count is
// capped, record counts are NOT loaded during the sweep (the per-field Sync
// re-reads them), and each org's RecordType metadata is fetched ONCE and
// reused for every field (RecordType metadata carries all fields' assignments).

// Fetch every active record type's FULL picklist assignment map for one org,
// once. Returns { rts:[{ id, name, devName, byField:Map(picklist → Set(value)) }], note }.
async function _pkLoadRtBundle(sess, obj) {
  const RT_CAP = 8;
  const rtRes = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false,
    query: `SELECT Id, Name, DeveloperName, IsActive FROM RecordType WHERE SObjectType = ${soqlStrLit(obj)}`, _silentError: true });
  if (!rtRes || rtRes.error) return { rts: [], note: `record types unavailable (${rtRes?.error || 'query failed'}) — RT drift NOT checked here` };
  const rows = (rtRes.records || []).filter(r => r.IsActive);
  const rts = [];
  for (const rt of rows.slice(0, RT_CAP)) {
    const meta = await sendBg({ type: 'SF_TOOLING_GET', orgUrl: sess.orgUrl, sid: sess.sid, sobject: 'RecordType', id: rt.Id });
    const byField = new Map();
    for (const p of (meta?.Metadata?.picklistValues || [])) {
      if (!p || !p.picklist) continue;
      byField.set(p.picklist, new Set((p.values || []).map(v => pkValueName(v))));
    }
    rts.push({ id: rt.Id, name: rt.Name, devName: rt.DeveloperName, byField });
  }
  return { rts, note: rows.length > RT_CAP ? `read ${RT_CAP} of ${rows.length} active record types — the rest were NOT checked` : '' };
}

// Slice one field's assignments out of an RT bundle, shaped exactly like
// _pkLoadRecordTypes' output so pkRtDrift / pkRtCellInfo work unchanged.
function _pkRtsForField(bundle, field) {
  const dev = String(field || '').replace(/__c$/i, '');
  return ((bundle && bundle.rts) || []).map(rt => ({
    id: rt.id, name: rt.name, devName: rt.devName,
    values: rt.byField.get(field) || rt.byField.get(dev) || new Set(),
  }));
}

// ── The sweep's reads, with no DOM (shared with Org health's "drifting picklists" card) ──
// Sessions + the object's describe for every org URL. An org that isn't open,
// or can't describe the object, is REPORTED (skip = the reason), never dropped.
async function _pkSweepOpenOrgs(urls, obj) {
  const orgs = [];
  for (const url of (urls || [])) {
    const sess = await getOrgSession(url);
    orgs.push({ orgUrl: url, orgKey: _orgKey(url), label: orgLabel(url), sess: sess || null,
      skip: sess ? '' : 'not open in a Chrome tab' });
  }
  for (const o of orgs) {
    if (!o.sess) continue;
    o.desc = await describe(obj, o.sess.orgUrl, o.sess.sid);
    if (!o.desc) { o.skip = `${obj} could not be described here (object missing, or no access)`; o.sess = null; }
  }
  return orgs;
}

// The ring's source of truth, when a ring of 2+ orgs is loaded and that org is
// among the usable ones; else the first usable org. → { srcOrg, ringKey }.
function _pkSweepPickSource(usable) {
  const ringKey = _orgKey((typeof _ring === 'object' && _ring?.sourceUrl && (_ring.orgs || []).length >= 2) ? _ring.sourceUrl : '');
  const srcOrg = (ringKey && usable.find(o => o.orgKey === ringKey)) || usable[0];
  return { srcOrg, ringKey };
}

// Field list = UNION of the picklist / multi-picklist fields across the usable
// orgs (a field that exists only in a target is drift too), source org first.
function _pkSweepFieldUnion(usable, srcOrg) {
  const seenF = new Set(), allFields = [];
  for (const o of [srcOrg, ...usable.filter(x => x !== srcOrg)]) {
    for (const f of (o.desc.fields || [])) {
      if ((f.type === 'picklist' || f.type === 'multipicklist') && !seenF.has(f.name)) {
        seenF.add(f.name);
        allFields.push({ name: f.name, label: f.label, isMulti: f.type === 'multipicklist' });
      }
    }
  }
  return allFields;
}

// ONE field in ONE usable org → { inv, rts } shaped for pkFieldVerdict
// (inv = perOrgInv[i], rts = perOrgRts[i]). A read that throws is kind:'error'.
async function _pkSweepReadField(o, obj, fieldName, rtBundle) {
  if (!(o.desc.fields || []).some(x => x.name === fieldName)) {
    return { inv: { orgKey: o.orgKey, label: o.label, kind: 'missing' }, rts: null };
  }
  try {
    const r = await _pkFetchInventory(o.sess, obj, fieldName, { skipUsage: true, skipRts: true });
    if (r.kind === 'standard') return { inv: { orgKey: o.orgKey, label: o.label, kind: 'standard', valueSetName: fieldName }, rts: null };
    if (r.kind === 'global')   return { inv: { orgKey: o.orgKey, label: o.label, kind: 'global',   valueSetName: r.name  }, rts: null };
    return {
      inv: { orgKey: o.orgKey, label: o.label, kind: 'local',
        values: r.inv.rawValues.map(v => ({ name: pkValueName(v), label: v.label || pkValueName(v),
          active: v.isActive !== false, isDefault: !!v.default })) },
      rts: _pkRtsForField(rtBundle, fieldName),
    };
  } catch (e) {
    return { inv: { orgKey: o.orgKey, label: o.label, kind: 'error', error: e.message }, rts: null };
  }
}

async function _pkSweepObject() {
  const body = eid('dsPkBody');
  if (!body || !_pkCmpObj) return;
  if (!_pkCmpOrgs.length) { showToast('Tick at least two orgs first', 'warning', 5000); return; }
  if (_pkSweepRunning) { showToast('A sweep is already running — let it finish', 'warning', 5000); return; }
  _pkSweepRunning = true;
  const obj = _pkCmpObj;
  const FIELD_CAP = 25;
  body.innerHTML = `<div class="ds-init-loading">${window.sftkCat ? sftkCat('Opening every org and listing this object’s picklist fields…') : 'Loading…'}</div>`;

  try {
    // 1) Sessions — an org that isn't open is REPORTED, never silently dropped.
    //    2) Describe the object in each live org. (_pkSweepOpenOrgs does both.)
    const orgs = await _pkSweepOpenOrgs(_pkCmpOrgs, obj);
    const usable = orgs.filter(o => o.sess && o.desc);
    const skipped = orgs.filter(o => o.skip);
    if (usable.length < 2) {
      body.innerHTML = `<div class="ds-seq-empty">Need at least TWO readable orgs to sweep — ${usable.length} available.
        ${skipped.length ? `<div class="ds-pk-note" style="margin-top:8px">Skipped: ${esc(skipped.map(o => `${o.label} (${o.skip})`).join(' · '))}</div>` : ''}</div>`;
      return;
    }

    // 3) Field list = UNION across orgs (a field that exists only in a target
    //    is drift too), ordered from the source of truth when it's readable.
    const { srcOrg, ringKey } = _pkSweepPickSource(usable);
    const allFields = _pkSweepFieldUnion(usable, srcOrg);
    if (!allFields.length) {
      body.innerHTML = `<div class="ds-seq-empty">${esc(obj)} has no picklist or multi-picklist fields in the readable orgs.</div>`;
      return;
    }
    const fields = allFields.slice(0, FIELD_CAP);
    const capped = allFields.length - fields.length;

    // 4) RecordType metadata — ONCE per org, reused for every field.
    const rtBundles = {};
    await Promise.all(usable.map(async o => {
      try { rtBundles[o.orgKey] = await _pkLoadRtBundle(o.sess, obj); }
      catch (e) { rtBundles[o.orgKey] = { rts: [], note: `record types unavailable (${e.message}) — RT drift NOT checked here` }; }
    }));
    const rtNotes = usable.filter(o => rtBundles[o.orgKey]?.note).map(o => `${o.label} — ${rtBundles[o.orgKey].note}`);

    _pkSweep = { obj, orgs, usable, srcOrg, fields, rtBundles, rows: [], sharedGroups: new Map() };

    // 5) Shell — rows stream in as each field resolves.
    body.innerHTML = `
      <div class="ds-pk-summary">🧹 Whole-object sweep · <strong>${esc(obj)}</strong> ·
        ${fields.length} picklist field${fields.length !== 1 ? 's' : ''} × ${usable.length} org${usable.length !== 1 ? 's' : ''}
        <span id="dsPkSwProgress" style="color:var(--subtext)">— starting…</span></div>
      <div class="ds-pk-note">Field list &amp; sync direction come from <strong>${esc(srcOrg.label)}</strong>${ringKey && srcOrg.orgKey === ringKey ? ' 👑 source of truth' : ' — no ring source of truth is loaded, so this is simply the first readable org'}.
        Record counts are <strong>NOT</strong> loaded in a sweep (that would be one aggregate query per field per org); each field's 🔄 Sync re-reads them, plus record types and the automation check, before anything is written.</div>
      ${capped > 0 ? `<div class="ds-pk-note">⚠ Capped at ${FIELD_CAP} fields — <strong>${capped}</strong> further picklist field(s) on ${esc(obj)} were NOT swept: ${esc(allFields.slice(FIELD_CAP).map(f => f.name).join(', '))}</div>` : ''}
      ${skipped.length ? `<div class="ds-pk-note">⚠ Skipped ${skipped.length} org(s): ${esc(skipped.map(o => `${o.label} (${o.skip})`).join(' · '))} — they are NOT part of any verdict below.</div>` : ''}
      ${rtNotes.length ? `<div class="ds-pk-note">⚠ Record types: ${esc(rtNotes.join(' · '))}</div>` : ''}
      <div class="ds-pk-table" style="max-width:1180px">
        <div class="ds-pk-head" style="display:grid;grid-template-columns:minmax(170px,1.2fr) minmax(160px,1fr) 2.2fr minmax(150px,auto);gap:10px">
          <div>Field</div><div>Verdict</div><div>What differs</div><div>Action</div>
        </div>
        <div id="dsPkSwRows"></div>
      </div>
      <div id="dsPkSwShared"></div>
      <div class="ds-pk-bulkbar" style="margin-top:10px">
        <span class="ds-pk-bulk-lbl">Drifting fields:</span>
        <span id="dsPkSwCount">counting…</span>
        <span style="flex:1"></span>
        <button class="ds-btn ds-btn-sm ds-btn-primary" id="dsPkSwSyncAll" disabled
          title="Opens the existing single-field sync plan for each drifting field, one after another. Nothing is written until you press Sync inside each plan.">🔄 Sync all drifting fields…</button>
      </div>
      <div id="dsPkSwLog"></div>`;

    eid('dsPkSwSyncAll')?.addEventListener('click', () => _pkSweepSyncAll());
    const rowsBox = eid('dsPkSwRows');
    const prog = eid('dsPkSwProgress');

    // 6) Fields SEQUENTIALLY (so rows stream), orgs in PARALLEL per field.
    for (let i = 0; i < fields.length; i++) {
      // The user navigated away (or opened a single-org editor) — stop burning
      // API calls into a DOM that no longer exists, and say the sweep is partial.
      if (!eid('dsPkSwRows')) {
        showToast(`Sweep stopped after ${i} of ${fields.length} field(s) — the view changed`, 'info', 5000);
        return;
      }
      const f = fields[i];
      if (rowsBox) rowsBox.insertAdjacentHTML('beforeend', _pkSweepRowShellHtml(i, f));
      if (prog) prog.textContent = `— reading ${f.name} (${i + 1}/${fields.length})…`;

      const perOrg = [], perRts = [];
      await Promise.all(usable.map(async (o, oi) => {
        const r = await _pkSweepReadField(o, obj, f.name, rtBundles[o.orgKey]);
        perOrg[oi] = r.inv; perRts[oi] = r.rts;
      }));

      const verdict = pkFieldVerdict(perOrg, perRts, f.name);
      _pkSweep.rows[i] = { field: f.name, label: f.label, isMulti: f.isMulti, verdict, perOrg };
      _pkSweepFillRow(i, verdict);
      _pkSweepUpdateShared(i, verdict, f);
      _pkSweepUpdateFooter();
    }

    if (prog) prog.textContent = `— done (${fields.length} field(s) read)`;
    _pkSweepUpdateFooter();
  } catch (e) {
    const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(e.message) : { message: e.message };
    body.innerHTML = `<div class="ds-seq-empty" title="${esc(e.message)}">❌ Sweep failed: ${esc(fe.message)}</div>`;
  } finally {
    _pkSweepRunning = false;
  }
}

function _pkSweepRowShellHtml(i, f) {
  return `<div class="ds-pk-row" data-pk-swi="${i}" style="display:grid;grid-template-columns:minmax(170px,1.2fr) minmax(160px,1fr) 2.2fr minmax(150px,auto);gap:10px;align-items:start">
    <div><span class="ds-pk-name">${esc(f.label || f.name)}</span>
      <div><code class="ds-pk-api" style="margin-left:0">${esc(f.name)}</code>${f.isMulti ? ' <span style="font-size:10px;color:var(--subtext)">multi</span>' : ''}</div></div>
    <div data-pk-swverdict="${i}" style="font-size:12px">⏳ reading…</div>
    <div data-pk-swdetail="${i}" style="font-size:11px;color:var(--subtext)"></div>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
      <span data-pk-swstatus="${i}" style="font-size:11px;color:var(--subtext)"></span>
      <span data-pk-swact="${i}"></span></div>
  </div>`;
}

// Colour + icon for one verdict — inline styles so no CSS file is touched.
function _pkSweepVerdictHtml(v) {
  const style = {
    sync:          'color:var(--success)',
    values:        'color:var(--danger);font-weight:600',
    missing:       'color:var(--danger);font-weight:600',
    rts:           'color:var(--warning);font-weight:600',
    notcomparable: 'color:var(--subtext)',
    error:         'color:var(--danger)',
    insufficient:  'color:var(--subtext)',
  }[v.status] || 'color:var(--subtext)';
  const icon = { sync: '✓', values: '⚠', missing: '⛔', rts: '⚠', notcomparable: '🔒', error: '❌', insufficient: 'ℹ' }[v.status] || '·';
  return `<span style="${style}">${icon} ${esc(v.label)}</span>`;
}

function _pkSweepFillRow(i, v) {
  const vEl = document.querySelector(`[data-pk-swverdict="${i}"]`);
  const dEl = document.querySelector(`[data-pk-swdetail="${i}"]`);
  const aEl = document.querySelector(`[data-pk-swact="${i}"]`);
  if (vEl) vEl.innerHTML = _pkSweepVerdictHtml(v);
  if (dEl) dEl.textContent = v.detail || '';
  if (!aEl) return;
  if (v.drifting) {
    aEl.innerHTML = `<button class="ds-btn ds-btn-sm ds-btn-primary" data-pk-swsync="${i}"
      title="Opens the existing single-field sync plan for this field — it re-reads values, record counts and record types, and runs the automation check first.">🔄 Sync</button>`;
    aEl.querySelector('[data-pk-swsync]')?.addEventListener('click', () => _pkSweepSyncField(i));
  } else if (v.status === 'notcomparable') {
    aEl.innerHTML = `<button class="ds-btn ds-btn-sm" data-pk-swopen="${i}" title="Open this value set in the single-org editor — shared value sets are edited once, not per field.">↗ Open value set</button>`;
    aEl.querySelector('[data-pk-swopen]')?.addEventListener('click', () => _pkSweepOpenField(i));
  } else {
    aEl.innerHTML = `<span style="font-size:11px;color:var(--subtext)">—</span>`;
  }
}

// Global / standard value sets are SHARED across fields: group them by set and
// list every field that inherits it, so the same set is acted on ONCE (T9).
function _pkSweepUpdateShared(i, v, f) {
  const S = _pkSweep;
  if (!S || !v.shared) return;
  const key = v.shared.key;
  const g = S.sharedGroups.get(key) || { kind: v.shared.kind, names: v.shared.names, mixed: v.shared.mixed, fields: [], firstRow: i };
  g.fields.push(f.name);
  g.mixed = g.mixed || v.shared.mixed;
  S.sharedGroups.set(key, g);

  // A repeat of an already-listed set: point at the group instead of repeating.
  if (g.fields.length > 1) {
    const dEl = document.querySelector(`[data-pk-swdetail="${i}"]`);
    if (dEl) dEl.textContent = `Inherits the ${g.kind} value set ${g.names.join(' / ')} — already listed under “Shared value sets” below (${g.fields.length} field(s) inherit it). Editing it once changes every one of them.`;
    const aEl = document.querySelector(`[data-pk-swact="${i}"]`);
    if (aEl) aEl.innerHTML = `<span style="font-size:11px;color:var(--subtext)">↓ shared</span>`;
  }

  const box = eid('dsPkSwShared');
  if (!box) return;
  const groups = [...S.sharedGroups.values()];
  box.innerHTML = `
    <div class="ds-pk-summary" style="margin-top:12px">🌐 Shared value sets — acted on ONCE, not per field (${groups.length})</div>
    <div class="ds-pk-note">Global and standard value sets are org-wide objects, so the per-field sync plan cannot write them. They are listed here with every field that inherits them. Cross-org sync of shared value sets is NOT implemented — open the set in one org and edit it there.</div>
    <div class="ds-pk-table" style="max-width:1180px">
      ${groups.map(gg => `
        <div class="ds-pk-row" style="display:grid;grid-template-columns:minmax(220px,1fr) 2fr auto;gap:10px;align-items:center">
          <div><span class="ds-pk-name">${esc(gg.names.join(' / ') || '(unnamed)')}</span>
            <div style="font-size:10.5px;color:var(--subtext)">${esc(gg.kind)} value set</div></div>
          <div style="font-size:11px;color:var(--subtext)">Inherited by ${gg.fields.length} field(s): ${esc(gg.fields.join(', '))}${gg.mixed ? ' · ⚠ NOT the same in every loaded org — check each org individually' : ''}</div>
          <div><button class="ds-btn ds-btn-sm" data-pk-swshared="${gg.firstRow}">↗ Open in ${esc(S.srcOrg.label)}</button></div>
        </div>`).join('')}
    </div>`;
  box.querySelectorAll('[data-pk-swshared]').forEach(b =>
    b.addEventListener('click', () => _pkSweepOpenField(parseInt(b.dataset.pkSwshared, 10))));
}

function _pkSweepUpdateFooter() {
  const S = _pkSweep;
  if (!S) return;
  const done = S.rows.filter(Boolean);
  const drifting = done.filter(r => r.verdict.drifting);
  const cnt = eid('dsPkSwCount');
  if (cnt) {
    const inSync = done.filter(r => r.verdict.status === 'sync').length;
    const nc = done.filter(r => r.verdict.status === 'notcomparable').length;
    const bad = done.filter(r => r.verdict.status === 'error').length;
    cnt.innerHTML = `<strong>${drifting.length}</strong> drifting · ${inSync} in sync · ${nc} not comparable${bad ? ` · ${bad} unreadable` : ''} (of ${done.length} read)`;
  }
  const btn = eid('dsPkSwSyncAll');
  if (btn) {
    btn.disabled = drifting.length === 0;
    btn.textContent = drifting.length ? `🔄 Sync all ${drifting.length} drifting field(s)…` : '🔄 Sync all drifting fields…';
  }
}

// Open ONE swept field in the single-org editor (used for shared value sets,
// which have no cross-org plan). Reuses the public deep-link contract.
function _pkSweepOpenField(i) {
  const S = _pkSweep;
  const row = S && S.rows[i];
  if (!row) return;
  window.sftkOpenPicklistFix({ orgUrl: S.srcOrg.orgUrl, object: S.obj, field: row.field });
}

// Build a REAL single-field matrix for one swept field (with usage counts and
// record types — the sweep deliberately skipped both) and hand it to the
// existing P5 plan, so every guard in that plan still applies.
async function _pkSweepSyncField(i) {
  const S = _pkSweep;
  const row = S && S.rows[i];
  if (!row) return false;
  const st = document.querySelector(`[data-pk-swstatus="${i}"]`);
  const set = h => { if (st) st.innerHTML = h; };
  set('⏳ re-reading values, record counts &amp; record types…');

  const results = await Promise.all(S.usable.map(async o => {
    const sess = await getOrgSession(o.orgUrl);
    if (!sess) return { orgUrl: o.orgUrl, orgKey: o.orgKey, label: o.label, skip: 'not open in a tab' };
    try {
      const r = await _pkFetchInventory(sess, S.obj, row.field);
      if (r.kind !== 'local') return { orgUrl: o.orgUrl, orgKey: o.orgKey, label: o.label, skip: r.kind === 'standard' ? 'standard picklist' : 'global value set' };
      let rts = [], rtNote = '';
      try {
        const rt = await _pkLoadRecordTypes(sess, S.obj, row.field, row.field.replace(/__c$/i, ''));
        rts = rt.rts; rtNote = rt.rtNote;
      } catch (e2) { rtNote = `record types unavailable: ${e2.message}`; }
      return { orgUrl: o.orgUrl, orgKey: o.orgKey, label: o.label, inv: r.inv, rts, rtNote };
    } catch (e) {
      return { orgUrl: o.orgUrl, orgKey: o.orgKey, label: o.label, skip: e.message };
    }
  }));

  const loaded = results.filter(r => r.inv);
  if (loaded.length < 2) {
    set(`<span style="color:var(--warning)">⚠ only ${loaded.length} org readable for this field — no plan (${esc(results.filter(r => r.skip).map(r => `${r.label}: ${r.skip}`).join(' · '))})</span>`);
    return false;
  }
  const perOrg = loaded.map(r => ({ orgKey: r.orgKey, values: r.inv.rawValues.map(v => pkValueName(v)) }));
  const union = pkValueUnion(perOrg);
  // _pkMatrix is the sync plan's input contract — the sweep borrows it per field.
  _pkMatrix = { obj: S.obj, field: row.field, results, union, matrix: pkBuildMatrix(results, union) };
  set('📋 reviewing plan…');
  await _pkOpenSyncPlan();
  return true;
}

// Wait until the shared modal is dismissed (Cancel / Esc / done), so the
// "sync all" queue can present one plan at a time. Capped so a forgotten
// modal can't leave a timer running forever.
function _pkWaitModalClosed(maxMs) {
  const limit = maxMs || 15 * 60 * 1000;
  const started = Date.now();
  return new Promise(resolve => {
    const t = setInterval(() => {
      const ov = eid('dsModal');
      if (!ov || ov.style.display === 'none' || Date.now() - started > limit) { clearInterval(t); resolve(); }
    }, 300);
  });
}

// Sequential review of every drifting field. Deliberately NOT a silent
// bulk-apply: each field gets its own plan (with its own usage + automation
// guards) and the user presses Sync inside it. The log below records
// queued → reviewing → closed, per field.
async function _pkSweepSyncAll() {
  const S = _pkSweep;
  if (!S) return;
  const idxs = S.rows.map((r, i) => (r && r.verdict && r.verdict.drifting) ? i : -1).filter(i => i >= 0);
  if (!idxs.length) { showToast('Nothing is drifting — nothing to sync', 'info', 4000); return; }

  showModal(`
    <div class="ds-modal-header">🔄 Sync ${idxs.length} drifting field(s) on ${esc(S.obj)}</div>
    <div class="ds-modal-body">
      <p>You review <strong>one plan per field, in sequence</strong>. Nothing is written until you press
      <em>Sync selected</em> inside a plan; closing a plan (Cancel / Esc) skips that field and moves to the next.</p>
      <p style="font-size:12px">Each plan re-reads that field's values, <strong>record counts</strong> and record types from every org
      (the sweep skipped counts to stay fast) and runs the automation check before any deactivation can be ticked.</p>
      <div class="ds-pk-hint">Queue: ${esc(idxs.map(i => S.rows[i].field).join(' → '))}</div>
    </div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      <button class="ds-btn ds-btn-primary" id="dsPkSwAllGo">▶ Start — ${idxs.length} plan(s)</button>
    </div>`);

  eid('dsPkSwAllGo')?.addEventListener('click', async () => {
    closeModal();
    const log = eid('dsPkSwLog');
    if (log) log.innerHTML = `<div class="ds-pk-reslog"><div class="ds-pk-res-title">Sequential sync — one plan per field</div></div>`;
    const box = log?.querySelector('.ds-pk-reslog');
    const append = html => { if (box) { const d = document.createElement('div'); d.className = 'ds-pk-res-row'; d.innerHTML = html; box.appendChild(d); } };

    for (let k = 0; k < idxs.length; k++) {
      const i = idxs[k];
      const name = S.rows[i].field;
      append(`▶ <strong>${esc(name)}</strong> (${k + 1}/${idxs.length}) — opening its plan…`);
      let ok = false;
      try { ok = await _pkSweepSyncField(i); }
      catch (e) { append(`❌ <strong>${esc(name)}</strong>: ${esc(e.message)}`); continue; }
      if (!ok) { append(`⏭ <strong>${esc(name)}</strong>: skipped — no plan could be built (see that row's status)`); continue; }
      await _pkWaitModalClosed();
      const st = document.querySelector(`[data-pk-swstatus="${i}"]`);
      if (st) st.innerHTML = '<span style="color:var(--subtext)">plan closed</span>';
      append(`✓ <strong>${esc(name)}</strong>: plan closed`);
    }
    append(`<em>Queue finished. The verdicts above are from BEFORE these syncs — re-run the sweep to verify.</em>`);
    showToast('Sequential sync finished — re-run the sweep to verify', 'info', 6000);
  });
}

// ════════════════════════════════════════════════════════════════
// PUBLIC ENTRY POINT — consumed by other Studio views
// ════════════════════════════════════════════════════════════════
// Contract (do NOT rename): switch the Picklist Manager into SINGLE-org mode
// for one org/object/field, load the inventory, and — when `value` is given —
// scroll to + flash that value's row. Robust when the view isn't rendered yet
// and when the org isn't open in a tab (both are reported, never silent).
// Returns a Promise<boolean>: true once the inventory load ran.
window.sftkOpenPicklistFix = function ({ orgUrl, object, field, value } = {}) {
  return (async () => {
    if (!object || !field) {
      showToast('Picklist fix needs both an object and a field', 'warning', 6000);
      return false;
    }
    if (!eid('dsMain')) { showToast('Studio isn’t ready yet — try again in a moment', 'warning', 5000); return false; }

    const orgs = (typeof allMapOrgs === 'function') ? allMapOrgs() : [];
    const match = orgUrl ? orgs.find(o => _orgKey(o.url) === _orgKey(orgUrl)) : null;
    const url = (match && match.url) || orgUrl || '';
    if (!url) { showToast('Picklist fix needs an org URL', 'warning', 6000); return false; }
    if (orgUrl && !match) showToast(`⚠ ${orgLabel(orgUrl)} isn't in the org map — opening it anyway`, 'warning', 6000);

    _pkMode = 'single';
    _pkOrgUrl = url;
    _pkObj = object;
    _pkField = field;
    _pkInv = null; _pkStd = null; _pkGvs = null;
    _pkHighlightValue = value || '';

    // The Picklist view may not be the current one (deep link from elsewhere) —
    // switch to it the same way the other cross-view entry points do.
    try {
      if (_currentView !== 'picklists') {
        document.querySelectorAll('.ds-nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('[data-view="picklists"]')?.classList.add('active');
        _currentView = 'picklists';
      }
    } catch (_) { /* _currentView unreachable — the direct render below still works */ }
    renderPicklists();   // rebuilds #dsPkConfig (single-org bar) + #dsPkBody

    const sess = await getOrgSession(url);
    if (!sess) {
      const msg = `${orgLabel(url)} isn't open in a Chrome tab — open it, then press “Load values”.`;
      const body = eid('dsPkBody');
      if (body) body.innerHTML = `<div class="ds-seq-empty">🔌 ${esc(msg)}</div>`;
      showToast(msg, 'warning', 8000);
      return false;
    }
    await loadPicklistInventory();
    return true;
  })();
};
