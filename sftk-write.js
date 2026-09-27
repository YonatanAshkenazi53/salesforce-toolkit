// ── One write discipline ─────────────────────────────────────────────────
// Every change this extension makes to Salesforce goes through here:
//   1. write   — the request (a Tooling PATCH, a REST DELETE, a Metadata
//                deploy, a collections update…), as a function that returns
//                the background's answer ({ error } or a thrown Error on refusal);
//   2. verify  — a function that READS THE ORG AGAIN and answers
//                { ok: true|false, text?, detail? } from what it saw;
//   3. report  — the one sentence for the user, built from (2), never from (1).
//
// Why (live campaigns, September 2026): five tools reported "done" from the
// request's answer alone — a flow "switched off" (not re-read), a picklist
// value "deleted" (Salesforce had kept it inactive), a field "deprecated"
// after a partial failure, an API version "unchanged" after an in-place
// rewrite, a permission "copied" from a POST result. Each was fixed by hand
// here; this helper makes the fix the only path. test/write-discipline
// fails the build on a write that bypasses it.
//
// Loaded by popup.html and studio.html. Page-agnostic on purpose: it never
// calls the background itself, the caller hands it the two functions.
//
// Result shape:
//   { ok, accepted, verified, text, detail, raw }
//     accepted  Salesforce took the request (no error / no throw)
//     verified  the org was re-read and answered
//     ok        accepted AND verified AND the org shows the intended state
//   ok is never true without verified — a caller that shows ✅ on ok alone
//   can only be right.
async function _sftkWriteVerifiedCore(spec) {
  const describe = String((spec && spec.describe) || 'the change');
  const out = { ok: false, accepted: false, verified: false, text: '', detail: null, raw: null };
  if (!spec || typeof spec.write !== 'function') {
    out.text = `${describe}: nothing was written — no write function was given`;
    return out;
  }
  let r;
  try {
    r = await spec.write();
  } catch (e) {
    out.raw = e;
    out.text = `${describe}: refused — ${(e && e.message) || String(e)}`;
    return out;
  }
  if (r && typeof r === 'object' && r.error) {
    out.raw = r;
    out.text = `${describe}: refused — ${String(r.error)}`;
    return out;
  }
  if (r && typeof r === 'object' && r.success === false) {
    out.raw = r;
    out.text = `${describe}: refused — ${String(r.errorMessage || r.message || 'the request was not accepted')}`;
    return out;
  }
  out.accepted = true;
  out.raw = r;
  if (typeof spec.verify !== 'function') {
    // Allowed only with a stated reason (e.g. Salesforce offers no read for
    // this object). The sentence says what the user must know.
    const why = spec.noVerify ? ` (${String(spec.noVerify)})` : '';
    out.text = `${describe}: accepted by Salesforce — not re-read${why}`;
    return out;
  }
  let v;
  try {
    v = await spec.verify(r);
  } catch (e) {
    out.text = `${describe}: accepted by Salesforce, but the org could not be re-read to confirm it (${(e && e.message) || String(e)}) — treat this as unverified`;
    return out;
  }
  if (!v || typeof v.ok !== 'boolean') {
    out.text = `${describe}: accepted by Salesforce, but the check gave no answer — treat this as unverified`;
    return out;
  }
  out.verified = true;
  out.ok = v.ok;
  out.detail = v.detail === undefined ? null : v.detail;
  out.text = v.text
    ? String(v.text)
    : (v.ok
        ? `${describe} — verified by re-reading the org`
        : `${describe}: accepted by Salesforce, but the org still shows the old state`);
  return out;
}

// Phase 3 — every write reaches History: `journal` (from sftkHistoryBegin)
// receives this write's verdict, so the entry says what was written and
// what the org showed afterwards. test/history-discipline fails the build
// on a write that names no journal (or marks `// history-by:`).
async function sftkWriteVerified(spec) {
  const out = await _sftkWriteVerifiedCore(spec);
  if (spec && spec.journal && typeof sftkHistoryNote === 'function') sftkHistoryNote(spec.journal, out, spec.describe);
  return out;
}

// Many writes in one go (one org, several records): the same discipline per
// item, one summary. items: [{ describe, write, verify, noVerify }].
// Returns { results, ok, accepted, verified, failed, text }.
// opts.verifyAll(results) — ONE re-read for the whole batch (one query for
// fifty flows instead of fifty): it returns an array aligned with items of
// { ok, text?, detail? } (or null for "could not check"); items then carry
// no verify of their own.
async function sftkWriteVerifiedAll(items, opts) {
  const list = Array.isArray(items) ? items : [];
  const results = [];
  const batched = opts && typeof opts.verifyAll === 'function';
  for (const it of list) {
    results.push(await sftkWriteVerified(batched ? { describe: it.describe, write: it.write, noVerify: 'checked below for the whole batch' } : (it.journal || !(opts && opts.journal) ? it : { ...it, journal: opts.journal })));
    if (opts && opts.stopOnRefusal && !results[results.length - 1].accepted) break;
  }
  if (batched) {
    let verdicts = null;
    try { verdicts = await opts.verifyAll(results); } catch (e) { verdicts = { error: (e && e.message) || String(e) }; }
    results.forEach((r, i) => {
      if (!r.accepted) return;
      const d = String(list[i].describe || 'the change');
      const v = Array.isArray(verdicts) ? verdicts[i] : null;
      if (!v || typeof v.ok !== 'boolean') {
        r.text = `${d}: accepted by Salesforce, but the org could not be re-read to confirm it${verdicts && verdicts.error ? ` (${verdicts.error})` : ''} — treat this as unverified`;
        return;
      }
      r.verified = true; r.ok = v.ok; r.detail = v.detail === undefined ? null : v.detail;
      r.text = v.text ? String(v.text) : (v.ok ? `${d} — verified by re-reading the org` : `${d}: accepted by Salesforce, but the org still shows the old state`);
    });
  }
  // The journal hears each item once, after the batch verdict.
  if (batched && typeof sftkHistoryNote === 'function') results.forEach((r, i) => {
    const j = list[i].journal || (opts && opts.journal);
    if (j) sftkHistoryNote(j, r, list[i].describe);
  });
  const ok = results.filter(r => r.ok).length;
  const accepted = results.filter(r => r.accepted).length;
  const verified = results.filter(r => r.verified).length;
  const failed = results.filter(r => !r.accepted).length;
  const unverified = accepted - verified;
  const parts = [`${ok} verified`];
  if (unverified) parts.push(`${unverified} accepted but not confirmed`);
  if (accepted - ok - unverified > 0) parts.push(`${accepted - ok - unverified} accepted but the org shows otherwise`);
  if (failed) parts.push(`${failed} refused`);
  return { results, ok, accepted, verified, failed, text: `${parts.join(' · ')} of ${list.length}` };
}

if (typeof window !== 'undefined') {
  window.sftkWriteVerified = sftkWriteVerified;
  window.sftkWriteVerifiedAll = sftkWriteVerifiedAll;
}
