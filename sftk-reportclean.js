'use strict';
// ═════════════════════════════════════════════════════════════════════════
// sftk-reportclean.js — find and remove a field's references in Reports,
// and find them in Report Types.
// ═════════════════════════════════════════════════════════════════════════
// User (asked three times, 2026-08-22 → 2026-08-31): "What about reports
// and report types in the field cleaner?" Field Cleaner used to disclose
// them as "Not scanned (no affordable API)". Two things changed since:
// the No-Silent-Waits law made per-report scanning acceptable (quoted,
// live, cancellable), and — per the user's rule "always use the latest
// salesforce tech" — everything here rides the modern Analytics REST API:
//   read a report:        GET  /analytics/reports/{id}/describe
//   save a report:        PATCH /analytics/reports/{id}
//   read report types:    GET  /analytics/reportTypes(+/{type}/describe)
// No SOAP anywhere. The one thing no modern API exposes — EDITING a custom
// report type's columns — is handled honestly: the hit is shown with a
// Setup deep link and the exact columns to remove by hand.
//
// Everything here is pure — JSON in, JSON out — so real org payloads can
// be pinned as fixtures.

// Does one report token refer to Object.Field? Report metadata spells the
// same field several ways: "Account.My_Field__c" (standard-type reports),
// "Account$My_Field__c" (custom-report-type reports), "s!Account.Field"
// (aggregates, prefix before '!'). A BARE token equal to the field name
// alone is only a MAYBE — a same-named field on another object would
// false-positive — so it is reported separately, never acted on.
// Returns 'definite' | 'possible' | null.
function sftkRptTokenMatch(token, objectApi, fieldApi) {
  const t = String(token == null ? '' : token);
  const body = t.includes('!') ? t.slice(t.lastIndexOf('!') + 1) : t;
  const parts = body.split(/[.$]/);
  const last = (parts[parts.length - 1] || '').toLowerCase();
  if (last !== String(fieldApi || '').toLowerCase()) return null;
  if (parts.length >= 2) {
    const owner = (parts[parts.length - 2] || '').toLowerCase();
    return owner === String(objectApi || '').toLowerCase() ? 'definite' : null;
  }
  return 'possible';
}

// Where a report touches the field. `meta` is the describe's
// reportMetadata. The four EDITABLE places are listed by name; everything
// else (custom summary formulas, buckets, cross filters, charts) is a
// remainder-search — those are never auto-edited, only named.
// Returns { columns, filters, groupings, possible, elsewhere, any }
function sftkRptFieldHits(meta, objectApi, fieldApi) {
  const m = meta || {};
  const hit = t => sftkRptTokenMatch(t, objectApi, fieldApi);
  const out = { columns: [], filters: [], groupings: [], possible: [], elsewhere: false, any: false };
  for (const c of (m.detailColumns || [])) {
    const h = hit(c);
    if (h === 'definite') out.columns.push(c);
    else if (h === 'possible') out.possible.push(c);
  }
  for (const f of (m.reportFilters || [])) {
    const h = hit(f && f.column);
    if (h === 'definite') out.filters.push(f.column);
    else if (h === 'possible') out.possible.push(f.column);
  }
  for (const g of [...(m.groupingsDown || []), ...(m.groupingsAcross || [])]) {
    const h = hit(g && g.name);
    if (h === 'definite') out.groupings.push(g.name);
    else if (h === 'possible') out.possible.push(g.name);
  }
  // The remainder: strip what we already classified, then search the rest
  // of the metadata verbatim. Aggregates land here on purpose — their
  // order is load-bearing for charts, so they are manual by design.
  const rest = { ...m };
  delete rest.detailColumns; delete rest.reportFilters;
  delete rest.groupingsDown; delete rest.groupingsAcross;
  const qual = `${objectApi}.${fieldApi}`.toLowerCase();
  const qual2 = `${objectApi}$${fieldApi}`.toLowerCase();
  const blob = JSON.stringify(rest).toLowerCase();
  out.elsewhere = blob.includes(qual) || blob.includes(qual2);
  out.any = !!(out.columns.length || out.filters.length || out.groupings.length
    || out.possible.length || out.elsewhere);
  return out;
}

// The surgical copy: remove the field from the editable places, refuse the
// removals that would BREAK the report, and name everything left manual.
// format: 'TABULAR' | 'SUMMARY' | 'MATRIX' (reportMetadata.reportFormat).
// Returns { meta, removed: {columns,filters,groupings}, manual: [reasons],
//           changed }
function sftkRptStripField(meta, objectApi, fieldApi) {
  const m = JSON.parse(JSON.stringify(meta || {}));
  const hits = sftkRptFieldHits(m, objectApi, fieldApi);
  const removed = { columns: 0, filters: 0, groupings: 0 };
  const manual = [];
  const isHit = t => sftkRptTokenMatch(t, objectApi, fieldApi) === 'definite';
  const format = String(m.reportFormat || '').toUpperCase();

  const cols = m.detailColumns || [];
  const keptCols = cols.filter(c => !isHit(c));
  if (keptCols.length !== cols.length) {
    if (keptCols.length === 0) {
      manual.push('it is the report’s ONLY column — removing it would leave an empty report; add another column first');
    } else {
      removed.columns = cols.length - keptCols.length;
      m.detailColumns = keptCols;
    }
  }

  const fils = m.reportFilters || [];
  const keptFils = fils.filter(f => !isHit(f && f.column));
  removed.filters = fils.length - keptFils.length;
  if (removed.filters) m.reportFilters = keptFils;

  for (const key of ['groupingsDown', 'groupingsAcross']) {
    const gs = m[key] || [];
    const kept = gs.filter(g => !isHit(g && g.name));
    if (kept.length === gs.length) continue;
    // A summary report needs a row grouping; a matrix needs BOTH axes.
    // Stripping the last one produces a report Salesforce rejects — that
    // removal is refused with the fix, the rest still proceed.
    const needsOne = (format === 'MATRIX') || (format === 'SUMMARY' && key === 'groupingsDown');
    if (needsOne && kept.length === 0) {
      manual.push(`it is the report’s only ${key === 'groupingsDown' ? 'row' : 'column'} grouping — regroup the report first`);
      continue;
    }
    removed.groupings += gs.length - kept.length;
    m[key] = kept;
  }

  if (hits.elsewhere) {
    manual.push('it is referenced in a formula, bucket, cross filter or chart — those are never auto-edited; open the report to fix them');
  }
  for (const p of [...new Set(hits.possible)]) {
    manual.push(`“${p}” matches the field name but not the object — left alone (could belong to another object); verify by hand`);
  }

  return { meta: m, removed, manual,
    changed: !!(removed.columns || removed.filters || removed.groupings) };
}

// Report-type describes key their columns in `columns` OBJECTS (maps of
// token → column info) nested under categories/sections. A generic walk
// finds every matching key, wherever this release nests it.
// Returns unique matching column tokens: { definite: [], possible: [] }
function sftkRtHits(describeJson, objectApi, fieldApi) {
  const definite = new Set(); const possible = new Set();
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'columns' && v && typeof v === 'object' && !Array.isArray(v)) {
        for (const token of Object.keys(v)) {
          const h = sftkRptTokenMatch(token, objectApi, fieldApi);
          if (h === 'definite') definite.add(token);
          else if (h === 'possible') possible.add(token);
        }
      }
      walk(v);
    }
  };
  walk(describeJson);
  return { definite: [...definite], possible: [...possible] };
}

// One report's verdict for the opt-in sweep, from sftkRptFieldHits:
//   'definite' the report names Object.Field (a column, filter, grouping, or
//              a formula / bucket / chart) — it uses the field
//   'possible' only a bare field name without its object — may be another
//              object's field; shown for a look by hand, never acted on
//   null       the report does not mention it
function sftkRptScanClass(hits) {
  const h = hits || {};
  if ((h.columns || []).length || (h.filters || []).length || (h.groupings || []).length || h.elsewhere) return 'definite';
  if ((h.possible || []).length) return 'possible';
  return null;
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkRptScanClass  = sftkRptScanClass;
  globalThis.sftkRptTokenMatch = sftkRptTokenMatch;
  globalThis.sftkRptFieldHits  = sftkRptFieldHits;
  globalThis.sftkRptStripField = sftkRptStripField;
  globalThis.sftkRtHits        = sftkRtHits;
}
