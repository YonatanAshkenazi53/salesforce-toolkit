'use strict';
// ════════════════════════════════════════════════════════════════
// API BUDGET (E3/E3b) — shared /limits reader, loaded by BOTH apps
// ════════════════════════════════════════════════════════════════
// Hoisted verbatim from studio-transfer.js (the marked HOIST UNIT) so the
// popup's operations — dependency scan, Field Cleaner, Lightning Pages —
// can show "· org has R of M daily calls remaining" too. Callers are
// already wired tolerantly: they render their estimate alone when this
// helper is absent, so load order only decides when the meter appears.
//
// sendBg is resolved AT CALL TIME: studio-core.js defines it for Data
// Studio, popup.js for the popup; both load in the same global scope as
// this file. Never reference it at eval time — this file loads first.

// Pure — is a cached budget entry still fresh? One place owns the 5-minute
// TTL: the /limits read itself costs one API call, so the meter is
// deliberately NOT re-read on every render. A negative age (clock moved
// backwards) counts as stale so we re-read rather than trust a bad stamp.
function sftkBudgetCacheFresh(entry, now) {
  const TTL_MS = 5 * 60 * 1000;
  if (!entry || !Number.isFinite(entry.fetchedAt)) return false;
  const age = now - entry.fetchedAt;
  return age >= 0 && age < TTL_MS;
}

// Pure — pull DailyApiRequests out of a /services/data/vXX.0/limits payload.
// Returns { max, remaining } or null when the payload has no usable numbers
// (limits API unavailable, permission gap, error body).
function sftkExtractDailyApi(limits) {
  const d = limits && limits.DailyApiRequests;
  const max = d ? Number(d.Max) : NaN;
  const remaining = d ? Number(d.Remaining) : NaN;
  if (!Number.isFinite(max) || !Number.isFinite(remaining)) return null;
  return { max, remaining };
}

// Per-org cache for the /limits read: orgUrl → { fetchedAt, budget }.
// The meter read itself costs one API call — that's WHY entries live for
// 5 minutes (sftkBudgetCacheFresh) instead of refetching per render.
const _sftkApiBudgetCache = Object.create(null);

// Shared budget reader. Returns { max, remaining } or null. Null is
// HARMLESS by contract: an operation is never blocked because the meter
// was unreadable — callers render "API budget unavailable" instead.
window.sftkApiBudget = async function (orgUrl, sid) {
  if (!orgUrl || !sid) return null;
  const hit = _sftkApiBudgetCache[orgUrl];
  if (sftkBudgetCacheFresh(hit, Date.now())) return hit.budget;
  try {
    const res = await sendBg({ type: 'SF_REST_GET', orgUrl, sid,
      path: 'services/data/v62.0/limits' });
    const budget = (res && !res.error) ? sftkExtractDailyApi(res) : null;
    // Cache successful reads only — a transient failure may succeed on the
    // next render; caching null would blank the meter for 5 minutes.
    if (budget) _sftkApiBudgetCache[orgUrl] = { fetchedAt: Date.now(), budget };
    return budget;
  } catch (_) { return null; }
};

// A finished run just consumed calls — drop these orgs' cached meters so the
// next budget line re-reads instead of showing pre-run numbers.
window.sftkApiBudgetInvalidate = function (...orgUrls) {
  for (const u of orgUrls) { if (u) delete _sftkApiBudgetCache[u]; }
};
