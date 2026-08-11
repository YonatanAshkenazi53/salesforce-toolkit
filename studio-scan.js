'use strict';
// ── Production-org guard (Phase 5) ────────────────────────────
// prod = a real production org: NOT a sandbox, NOT a Developer Edition, NOT
// a trial. Detected once per org via the Organization object and cached on
// _orgs[url] for a week. Everything reads the CACHE synchronously (badges);
// destructive paths await ensureOrgType before writing.
async function ensureOrgType(orgUrl) {
  if (!orgUrl) return 'unknown';
  const key = _orgKey(orgUrl);
  const hit = Object.entries(_orgs).find(([u, v]) =>
    _orgKey(u) === key && v.orgType && (Date.now() - (v.orgTypeAt || 0)) < 7 * 864e5);
  if (hit) return hit[1].orgType;
  const sess = _resolveSession(orgUrl, _buildAllSessions());
  if (!sess?.sid) return cachedOrgType(orgUrl);   // offline → best effort
  const q = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid,
    query: 'SELECT IsSandbox, OrganizationType, TrialExpirationDate FROM Organization' });
  const o = q?.records?.[0];
  if (!o) return cachedOrgType(orgUrl);
  const type = o.IsSandbox ? 'sandbox'
    : (o.OrganizationType === 'Developer Edition' || o.TrialExpirationDate) ? 'dev'
    : 'production';
  if (!_orgs[orgUrl]) _orgs[orgUrl] = {};
  _orgs[orgUrl].orgType   = type;
  _orgs[orgUrl].orgTypeAt = Date.now();
  await storageSaveOrgs();
  return type;
}
// Cache-only read (synchronous) — for badges in render paths.
function cachedOrgType(orgUrl) {
  if (!orgUrl) return 'unknown';
  const key = _orgKey(orgUrl);
  const hit = Object.entries(_orgs).find(([u, v]) => _orgKey(u) === key && v.orgType);
  return hit ? hit[1].orgType : 'unknown';
}
function prodBadge(orgUrl) {
  const t = cachedOrgType(orgUrl);
  if (t === 'production') return '<span class="ds-org-badge-prod" title="This is a PRODUCTION org — writes here affect real users. Destructive operations require typed confirmation; hard delete is disabled.">PROD</span>';
  if (t === 'sandbox')    return '<span class="ds-org-badge-sbx" title="Sandbox org">sandbox</span>';
  return '';
}

// 🎯 match-accuracy chip for a graded scan (acc = sftkScanAccuracy(scan)).
// compact=true → just "🎯 97%" (Tree Diff cells); full → fields + wording.
// Shared by the Reconcile header and Tree Diff (both load after this file).
function accuracyChip(acc, compact) {
  if (!acc) return '';
  const tone = acc.grade === 'high' ? 'background:#dcfce7;color:#166534'
             : acc.grade === 'ok'   ? 'background:#fef3c7;color:#92400e'
             :                        'background:#fee2e2;color:#991b1b';
  const why = [];
  if (acc.blank)  why.push(`${acc.blank} row(s) have a blank key (unmatchable)`);
  if (acc.dup)    why.push(`${acc.dup} row(s) share duplicated keys (ambiguous)`);
  if (acc.memory) why.push(`${acc.memory} pair(s) matched from 🧠 memory (Id-exact)`);
  const kind = acc.strategy === 'externalId' ? ' (external ID)'
             : acc.fields.length > 1 ? ' (composite key)' : '';
  const title = `Matched by ${acc.fields.join(' + ')}${kind} — ${acc.pct}% of the `
    + `${acc.total} row(s) scanned have a usable, unambiguous key.`
    + (why.length ? ` ${why.join('; ')}.` : '')
    + ` Improve it: deployment ✏ Edit → 🔎 Pick records → Matching (combine up to 4 fields, or use an external ID).`;
  return `<span class="ds-acc-chip" style="font-size:11px;padding:1px 7px;border-radius:9px;white-space:nowrap;${tone}" title="${esc(title)}">🎯 ${compact ? '' : esc(acc.fields.join(' + ')) + ' · '}${acc.pct}%${compact ? '' : ' key confidence'}</span>`;
}

// Typed confirmation for destructive writes into a production org: the user
// must type the org's label exactly before Proceed enables.
function confirmTypedProd(orgLabelStr, actionSummary) {
  return new Promise(resolve => {
    showModal(`
      <div class="ds-modal-header">🛑 Production org</div>
      <div class="ds-modal-body">
        <p>You're about to <strong>${esc(actionSummary)}</strong> in <strong>${esc(orgLabelStr)}</strong> — which looks like a <strong>PRODUCTION</strong> org.</p>
        <p style="margin-top:8px">Type the org name to confirm: <code>${esc(orgLabelStr)}</code></p>
        <input id="dsProdConfirmInput" class="ds-input" autocomplete="off" placeholder="${esc(orgLabelStr)}">
      </div>
      <div class="ds-modal-footer">
        <button class="ds-btn" id="dsProdCancel">Cancel</button>
        <button class="ds-btn ds-btn-danger" id="dsProdGo" disabled>Proceed</button>
      </div>`);
    const inp = eid('dsProdConfirmInput'), go = eid('dsProdGo');
    inp?.addEventListener('input', () => { if (go) go.disabled = inp.value.trim() !== orgLabelStr; });
    inp?.focus();
    eid('dsProdCancel')?.addEventListener('click', () => { closeModal(); resolve(false); });
    go?.addEventListener('click', () => { closeModal(); resolve(true); });
  });
}

// ── Run progress channel (Phase 3) ────────────────────────────
// Connects a Port to the service worker before a transfer/sequence/reconcile.
// The engine streams progress events through it (which also keeps the MV3
// worker alive during long runs) and honors {cmd:'cancel'} between batches.
function _openRunPort(onEvent) {
  try {
    const port = chrome.runtime.connect({ name: 'sftk-run-progress' });
    if (onEvent) port.onMessage.addListener(onEvent);
    return port;
  } catch (_) { return null; }
}

// Renders progress events into a log element: one LIVE line per object
// (updated in place per batch) + a step line per sequence step.
function _runProgressHandler(logEl) {
  let stepIdx = 0;
  return (evt) => {
    if (!evt || !logEl || !logEl.isConnected) return;
    if (evt.phase === 'hb' || evt.phase === 'start' || evt.phase === 'end') return;
    if (evt.phase === 'step') {
      stepIdx = evt.index + 1;
      const row = document.createElement('div');
      row.className = 'ds-prog-row ds-prog-step';
      row.textContent = `▶ Step ${evt.index + 1}/${evt.total}: ${evt.name}`;
      logEl.appendChild(row);
      logEl.scrollTop = logEl.scrollHeight;
      return;
    }
    const lineId = `dsRunLive_${stepIdx}_${String(evt.obj || 'x').replace(/[^\w]/g, '_')}`;
    let row = logEl.querySelector(`#${lineId}`);
    if (!row) {
      row = document.createElement('div');
      row.id = lineId;
      row.className = 'ds-prog-row ds-prog-live';
      logEl.appendChild(row);
    }
    if (evt.phase === 'node')    row.textContent = `⏳ ${evt.obj}: reading records…`;
    if (evt.phase === 'fetched') row.textContent = `⏳ ${evt.obj}: ${evt.count} record(s) fetched — writing…`;
    if (evt.phase === 'batch')   row.textContent = `⏳ ${evt.obj}: ${evt.done}/${evt.total} written · ${evt.created} created${evt.failed ? `, ${evt.failed} failed` : ''}`;
    logEl.scrollTop = logEl.scrollHeight;
  };
}

// ── Save profile ──────────────────────────────────────────────
// Write the in-memory _editingProfile to _profiles + chrome.storage, without
// navigating away from the builder. Used by Apply handlers (field mapping,
// lookup resolution) so partial edits stick to disk immediately — otherwise
// users hit "Apply" and assume it saved, then close the builder and lose it.
async function commitEditingProfile() {
  if (!_editingProfile) return;
  const nameEl = eid('dsProfileName');
  if (nameEl) _editingProfile.name = nameEl.value.trim() || _editingProfile.name || 'Unnamed';
  _editingProfile.updatedAt = new Date().toISOString();

  function stripMeta(node) {
    if (!node) return node;
    const { _meta, ...clean } = node;
    clean.children = (node.children || []).map(stripMeta);
    return clean;
  }
  const toSave = { ..._editingProfile, tree: stripMeta(_editingProfile.tree) };

  const idx = _profiles.findIndex(p => p.id === toSave.id);
  if (idx !== -1) _profiles[idx] = toSave;
  else _profiles.push(toSave);

  // Keep the active transfer profile reference in sync so the Run button
  // picks up the change without the user re-selecting the profile.
  if (_transferProfile && _transferProfile.id === toSave.id) {
    _transferProfile = _profiles[idx !== -1 ? idx : _profiles.length - 1];
  }

  await storageSaveProfiles();
}

async function saveProfile() {
  await commitEditingProfile();
  renderProfiles();
}

// ════════════════════════════════════════════════════════════════
// SCAN CONFIG DERIVATION
// ════════════════════════════════════════════════════════════════
// Profiles used to have explicit matchField + compareFields inputs in
// the Profile Builder. That was redundant — users already declare which
// fields matter when they configure the Field Mapping modal on the root
// node. This helper derives scanConfig at runtime so callers don't need
// to read profile.scanConfig directly.
//
//   matchField     ← profile.scanConfig.matchField (legacy backwards-compat)
//                    or 'Name' (with describe-based fallback at use time)
//   compareFields  ← keys of node.fieldMappings that map to a non-null target
//                    or profile.scanConfig.compareFields (legacy backwards-compat)
//                    or []  (presence-only diff)
//
// Backward compat: if a profile has the old scanConfig values set explicitly,
// they still take effect — we don't want to silently change behavior for
// existing profiles that had custom config.
// PURE — the field pairs a scan must COMPARE (and Overwrite must WRITE) to
// be honest about what a RUN does. Mirrors the engine's buildCopyFields
// semantics: fieldMappings is an EXCLUDE/RENAME overlay (null = excluded,
// ''/absent = copy under the same name) and the engine copies EVERY
// createable field — so comparing only the mapping's keys let drift in any
// unmapped field pass as "in sync" (user 2026-08-05: changed records "not
// captured by the engine"). Reference fields are left OUT here: lookups
// compare through the resolution plan (org-local Ids never match), and
// base64/address/location shapes can't be value-diffed honestly.
function sftkEngineCompareSet(describeFields, fieldMappings) {
  const SKIP = new Set(['Id', 'CreatedDate', 'LastModifiedDate', 'SystemModstamp',
    'CreatedById', 'LastModifiedById', 'IsDeleted', 'OwnerId',
    'LastActivityDate', 'LastViewedDate', 'LastReferencedDate',
    'MasterRecordId', 'IsArchived']);
  const fm = fieldMappings || {};
  const out = [];
  for (const f of (describeFields || [])) {
    if (!f || !f.name || SKIP.has(f.name)) continue;
    if (!f.createable) continue;
    if (f.type === 'reference' || f.type === 'base64' || f.type === 'address' || f.type === 'location') continue;
    if (fm[f.name] === null) continue;
    const tgt = (fm[f.name] && fm[f.name] !== '') ? fm[f.name] : f.name;
    out.push({ srcField: f.name, tgtField: tgt });
  }
  return out;
}

function deriveScanConfig(profile, node) {
  const legacyMatch   = profile?.scanConfig?.matchField;
  const legacyCompare = (profile?.scanConfig?.compareFields || []).filter(Boolean);

  const mappings = node?.fieldMappings || {};
  // Strip system identity fields from compareFields. Id, CreatedDate, etc.
  // aren't copyable — if they leak into fieldMappings (from legacy profiles
  // or aggressive Auto-Map), they break SOQL with "duplicate field selected"
  // and pollute drift comparison since Ids ALWAYS differ across orgs.
  const SYSTEM_NEVER_COMPARE = new Set([
    'Id', 'CreatedDate', 'CreatedById', 'LastModifiedDate', 'LastModifiedById',
    'SystemModstamp', 'LastActivityDate', 'LastViewedDate', 'LastReferencedDate',
    'IsDeleted', 'MasterRecordId', 'IsArchived',
    // OwnerId: the transfer engine NEVER copies owners (different user sets
    // per org — target defaults to the running user), so comparing owners by
    // name is permanent false drift: it kept whole result sets "drifted"
    // forever with nothing able to sync them.
    'OwnerId'
  ]);
  const fromMappings = Object.keys(mappings).filter(k =>
    mappings[k] !== null && mappings[k] !== '' && !SYSTEM_NEVER_COMPARE.has(k)
  );

  // Source-side matchField — picked via "Match on source" in Pick Records,
  // persisted as node.matchField. Falls back to legacy profile.scanConfig
  // (no Pick Records visit yet) then 'Name' (auto-corrected at use time).
  const matchField = node?.matchField || legacyMatch || 'Name';

  // Target-side matchField — picked via "Match on target" in Pick Records,
  // persisted as node.matchFieldTgt. Defaults to the field mapping for the
  // source matchField (so a Name→Full_Name__c mapping auto-pairs identity
  // without a second config step). If neither, mirrors the source field
  // name and lets runtime auto-correct via target's describe.
  const matchFieldTgt = node?.matchFieldTgt
    || (mappings[matchField] && mappings[matchField] !== null ? mappings[matchField] : matchField);

  return {
    matchField,
    matchFieldTgt,
    compareFields: fromMappings.length ? fromMappings : legacyCompare
  };
}

// ════════════════════════════════════════════════════════════════
// T7 — PHANTOM DRIFT (State & Country picklist normalization)
// ════════════════════════════════════════════════════════════════
// When an org has State and Country Picklists ENABLED, Salesforce OWNS the
// label field: on every write it rewrites `BillingState` from the value of
// `BillingStateCode`. So if the source says "TX" and the target renders that
// same code as "Texas", pushing "TX" is normalized straight back to "Texas" —
// the row shows as drift again on the very next scan, FOREVER, and an
// overwrite can never converge. (Worse, Salesforce often rejects the write
// outright: "There's a problem with this state, even though it may appear
// correct. Please select a state from the list of valid states.")
//
// The tell is the CODE. Same `${field}Code` on both sides = the two orgs agree
// on the actual value and only the rendered label differs → phantom. Different
// codes = a REAL value difference → reported as drift exactly as before.
//
// `tgtField` covers a field mapping that renames the field on the target side;
// it defaults to `field`, so the 3-argument call behaves identically.
//
// PURE — no free variables (materialized standalone by test/extract.mjs).
function sftkPhantomStateCountry(field, srcRec, tgtRec, tgtField) {
  if (!field || !srcRec || !tgtRec) return false;
  if (typeof srcRec !== 'object' || typeof tgtRec !== 'object') return false;
  const sName = String(field);
  const tName = String(tgtField || field);
  // BillingState, ShippingCountry, MailingState, OtherCountry, State, Country…
  if (!/^[A-Za-z]*(State|Country)$/.test(sName)) return false;
  const sCode = srcRec[sName + 'Code'];
  const tCode = tgtRec[tName + 'Code'];
  // The `${field}Code` sibling has to be present on BOTH sides (i.e. in the
  // compare set) for this to be knowable. When it isn't, we CANNOT tell a
  // label normalization from a real value change — so never guess: return
  // false and let the difference be reported as ordinary drift.
  if (sCode == null || sCode === '') return false;
  if (tCode == null || tCode === '') return false;
  return String(sCode) === String(tCode);
}

// ════════════════════════════════════════════════════════════════
// T6 — PICKLIST READINESS for a data deployment
// ════════════════════════════════════════════════════════════════
// Today a data run only discovers a missing picklist value when Salesforce
// rejects the record mid-run. This answers the question BEFORE the run: of the
// values these records actually carry, which ones don't exist in the TARGET
// org's picklist?
//
//   records            — the source records that would be pushed/overwritten
//   comparePlanOrFields— compare plan entries ({srcField,tgtField}) or plain
//                        field-name strings (same name on both sides)
//   tgtDescribeFieldsMap — target describe fields, as a plain object or a Map
//                        keyed by field API name ({ type, picklistValues, … })
//   opts               — cap overrides (all optional)
//
// Returns { gaps, … cap telemetry } where gaps is
//   [{ field, tgtField, missing:[values], affected:n, multi, restricted, … }]
// for fields WITH gaps only. Everything is capped and every cap is reported
// back so the UI can say what was NOT examined.
//
// Deliberately conservative — it never invents a gap it can't prove:
//   • target field absent from the describe        → skipped
//   • target field isn't a (multi)picklist         → skipped
//   • target picklist has no values in the describe (dependent picklist,
//     unreadable describe)                          → skipped
//   • matching is case-INSENSITIVE, because Salesforce accepts picklist
//     writes case-insensitively and normalizes them
//
// ── R3 orphan-cap wording (PURE) ────────────────────────────────────────
// The "possible orphan" probe reads ONE page of NULL-link target rows. That
// page is a cap, and a capped bucket presented as a total is a lie: an
// orphanCount of 2,000 in an org with 9,000 orphans reads as "there are
// 2,000". These two builders are the only place that wording lives, so every
// display site says the same true thing. `total` is the count Salesforce
// reported for the query (measured); pass null when it wasn't reported —
// neither builder ever invents one.
// PURE — no free variables (materialized standalone by test/extract.mjs).
function sftkOrphanLabel(shown, total, capped) {
  const group = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const s = Number(shown) || 0;
  if (!capped) return `${group(s)} possible orphan(s)`;
  const t = Number(total);
  return Number.isFinite(t) && t > s
    ? `${group(s)} of ${group(t)} possible orphan(s) shown`
    : `${group(s)} possible orphan(s) shown — more exist`;
}

// The banner above the buckets. '' when the list is complete: nothing to say.
// PURE — no free variables (materialized standalone by test/extract.mjs).
function sftkOrphanCapNote(shown, total, capped) {
  if (!capped) return '';
  const group = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const s = Number(shown) || 0;
  const t = Number(total);
  const head = Number.isFinite(t) && t > s
    ? `⚠ Possible orphans: showing the first ${group(s)} of ${group(t)} — ${group(t - s)} more are NOT listed here.`
    : `⚠ Possible orphans: showing the first ${group(s)} — this target has more that are NOT listed here.`;
  return `${head} Treat the count as a floor, not a total: clear the listed ones (⇄ Relink or 🗑) and re-scan to reach the rest.`;
}

// ── L6 — DIFF-BUCKET CAPS (PURE) ────────────────────────────────────────
// The four diff buckets SHIP capped at 5,000 rows each (linkMismatch at
// 2,000) so a scan of a huge object doesn't blow the chrome.storage payload.
// The ROWS are a cap; the COUNT never had to be. runDiffScan pages both
// sides in full — SF_QUERY_ALL follows every nextRecordsUrl and returns the
// complete record set — so the exact size of every bucket is already in
// memory, measured, one line before the slice. A `SELECT COUNT()` here would
// buy nothing and cost a round-trip: it would be a SECOND, weaker source of
// truth (a different point in time, a different query) for a number the scan
// already holds. What was missing was carrying it: every display site read
// `bucket.length` off the SLICED array, so 5,000 was printed as a total when
// it was a floor.
//
//   sftkBucketCap        — the MEASURING end: full array in hand, exact total.
//   sftkBucketCapShipped — the READING end for a scan that predates this
//                          change (profiles persist lastScan, so stored scans
//                          arrive with sliced arrays and no measured totals)
//                          or any consumer holding only the shipped slice.
//                          With no total, `length >= cap` is the only honest
//                          signal — the same detection user-copy.js uses for
//                          its capped user list — and `total` stays null
//                          rather than being invented.
//
// PURE — no free variables (materialized standalone by test/extract.mjs).
function sftkBucketCap(list, cap) {
  const c = Number(cap) > 0 ? Math.floor(Number(cap)) : 5000;
  const total = Array.isArray(list) ? list.length : 0;
  return { shown: total > c ? c : total, total, capped: total > c, cap: c };
}

// PURE — no free variables (materialized standalone by test/extract.mjs).
function sftkBucketCapShipped(shownLen, cap) {
  const c = Number(cap) > 0 ? Math.floor(Number(cap)) : 5000;
  const s = Number(shownLen) > 0 ? Math.floor(Number(shownLen)) : 0;
  // No measured total: "the slice is exactly as long as the cap allowed" is
  // the only evidence there is. `>=`, not `>`, so a server/array that lands
  // exactly on the cap is treated as possibly-more (user-copy.js rule).
  return { shown: s, total: null, capped: s >= c, cap: c, totalIsFloor: false, measured: false };
}

// THE resolver every display site calls. Prefers the totals the scan measured
// (scan.bucketCaps, written only when at least one bucket reached its cap —
// a small org's result stays byte-identical), and degrades to the shipped-
// length rule for scans stored before L6. Never invents a total.
// PURE — depends on sftkBucketCapShipped (extract them together).
function sftkScanBucketInfo(scan, bucket, cap) {
  const s = scan || {};
  const caps = (s.bucketCaps && typeof s.bucketCaps === 'object') ? s.bucketCaps : null;
  const dflt = bucket === 'linkMismatch'
    ? (caps && Number(caps.linkCap) > 0 ? Math.floor(Number(caps.linkCap)) : 2000)
    : (caps && Number(caps.cap)     > 0 ? Math.floor(Number(caps.cap))     : 5000);
  const c = Number(cap) > 0 ? Math.floor(Number(cap)) : dflt;
  const rec = caps ? caps[bucket] : null;
  if (rec && Number.isFinite(Number(rec.total))) {
    return {
      shown:        Number(rec.shown) || 0,
      total:        Number(rec.total),
      capped:       !!rec.capped,
      totalIsFloor: !!rec.totalIsFloor,
      cap:          Number(rec.cap) > 0 ? Math.floor(Number(rec.cap)) : c,
      measured:     true
    };
  }
  const arr = Array.isArray(s[bucket]) ? s[bucket] : [];
  return sftkBucketCapShipped(arr.length, c);
}

// The number as it may be SPOKEN. Never "5,000" when 5,000 is a floor.
//   complete            → "47,213"
//   capped, total known → "5,000 of 47,213"
//   capped, total not   → "5,000+"
//   totalIsFloor        → a trailing "+" on the total (the total itself is a
//                         lower bound — onlyInTarget when the one-page orphan
//                         probe was itself capped)
// PURE — no free variables (materialized standalone by test/extract.mjs).
function sftkBucketCountLabel(shown, total, capped, totalIsFloor) {
  const group = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const s = Number(shown) > 0 ? Math.floor(Number(shown)) : 0;
  const t = Number(total);
  // total == null means "not measured" — guard it BEFORE Number(), because
  // Number(null) is 0, which read as a KNOWN total of zero and printed "0"
  // over a visibly populated column (user screenshots 2026-08-09: "Insert 0"
  // above 401 rows, "Changed 0" above a drift row).
  const known = total != null && Number.isFinite(t) && t >= 0;
  if (!capped) return known ? `${group(t)}${totalIsFloor ? '+' : ''}` : group(s);
  if (known && t > s) return `${group(s)} of ${group(t)}${totalIsFloor ? '+' : ''}`;
  return `${group(s)}+`;
}

// Tooltip for a capped number. '' when there is nothing to disclose, so a
// small org renders no title attribute at all.
// PURE — no free variables (materialized standalone by test/extract.mjs).
function sftkBucketCapTitle(shown, total, capped, totalIsFloor, what) {
  if (!capped && !totalIsFloor) return '';
  const group = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const s = Number(shown) > 0 ? Math.floor(Number(shown)) : 0;
  const t = Number(total);
  const known = Number.isFinite(t) && t >= 0;
  const label = what ? String(what) : 'record(s)';
  if (!capped) {
    return `${group(known ? t : s)} ${label} were classified, and the possible-orphan probe was itself capped — more exist that this scan never saw.`;
  }
  const head = known && t > s
    ? `This scan carries the first ${group(s)} of ${group(t)}${totalIsFloor ? '+' : ''} ${label} — ${group(t - s)}${totalIsFloor ? '+' : ''} more exist and are NOT listed or selectable here.`
    : `This scan carries the first ${group(s)} ${label} — the object has more that are NOT listed or selectable here.`;
  return `${head} Treat the number as a floor, not a total: run what is listed, re-scan, repeat until it stops shrinking — or narrow the deployment's WHERE filter so the set fits.`;
}

// The banner above the buckets: one line naming EVERY capped bucket. '' when
// nothing was capped, so a small org gets no banner and no layout shift.
// PURE — depends on sftkScanBucketInfo, sftkBucketCapShipped, sftkBucketCountLabel.
function sftkBucketCapNote(scan, objType) {
  const s = scan || {};
  const order = ['missingInTarget', 'changed', 'onlyInTarget', 'identical', 'linkMismatch'];
  const human = {
    missingInTarget: 'in source only',
    changed:         'changed',
    onlyInTarget:    'in target only',
    identical:       'in sync',
    linkMismatch:    'link differs'
  };
  const hits = [];
  for (const n of order) {
    if (!Array.isArray(s[n])) continue;
    const i = sftkScanBucketInfo(s, n);
    if (!i.capped) continue;
    hits.push(`${human[n]} ${sftkBucketCountLabel(i.shown, i.total, i.capped, i.totalIsFloor)}`);
  }
  if (!hits.length) return '';
  const obj = objType ? String(objType) : 'this object';
  return `⚠ This ${obj} scan is TRUNCATED — ${hits.join(' · ')}. `
    + `Only the rows listed below exist in this result; the rest were never loaded, so they cannot be shown, selected, or acted on. `
    + `Treat every count here as a floor: run what is listed, 🔄 Refresh state, and repeat until the counts stop shrinking — or narrow the deployment's WHERE filter so the set fits in one scan.`;
}

// L6 — THE WRITE GUARD. `kinds` are the action kinds the user actually has
// selected; each maps to the bucket the selection was PICKED FROM. A capped
// bucket means the picker only ever offered a slice, so "Insert 5,000" is not
// "insert everything missing" — and the run must say so BEFORE it writes.
// Returns { lines: [], text: '' } when nothing selected is capped (falsy
// `text`, so a caller can gate on it) — a small org sees no extra dialog.
// PURE — depends on sftkScanBucketInfo, sftkBucketCapShipped, sftkBucketCountLabel.
function sftkCappedWriteNote(scan, kinds, objType) {
  const s = scan || {};
  const want = Array.isArray(kinds) ? kinds : [];
  const map = {
    push:      { bucket: 'missingInTarget', verb: 'Insert',            what: 'in source only' },
    overwrite: { bucket: 'changed',         verb: '→ Update target',   what: 'changed' },
    updSrc:    { bucket: 'changed',         verb: '← Update source',   what: 'changed' },
    del:       { bucket: 'onlyInTarget',    verb: 'Delete',            what: 'in target only' },
    pull:      { bucket: 'onlyInTarget',    verb: '← Pull',            what: 'in target only' },
    relink:    { bucket: 'linkMismatch',    verb: '⇄ Relink',          what: 'link differs' }
  };
  const obj = objType ? ` ${String(objType)}` : '';
  const seen = {};
  const lines = [];
  for (const k of want) {
    const m = map[k];
    if (!m || seen[k]) continue;
    seen[k] = true;
    const i = sftkScanBucketInfo(s, m.bucket);
    if (!i.capped) continue;
    lines.push(`${m.verb} was picked from a TRUNCATED list: ${sftkBucketCountLabel(i.shown, i.total, i.capped, i.totalIsFloor)}${obj} "${m.what}" record(s) — only the ${sftkBucketCountLabel(i.shown, null, false, false)} listed could be selected.`);
  }
  if (!lines.length) return { lines: [], text: '' };
  return {
    lines,
    text: `This run acts on the listed rows ONLY — it is not "everything". `
      + `Re-scan after it finishes and run again until the counts stop shrinking, or narrow the deployment's WHERE filter so the whole set fits in one scan.`
  };
}

// L6 — a CHILD scan is scoped to the parent ids the parent scan LISTED. If
// the parent scan was capped, the child scan never saw the children of the
// parents that fell off the end: its own buckets are then a floor too, and
// nothing in the child's numbers reveals that. Returns null when the parent
// scan was complete (child scans of a small org are unchanged).
// PURE — depends on sftkScanBucketInfo, sftkBucketCapShipped.
function sftkParentScopeCap(basis) {
  const b = basis || {};
  // The buckets scanReconcileChild reads to build srcParentIds / tgtParentIds.
  const feeds = ['missingInTarget', 'changed', 'identical', 'onlyInTarget'];
  const buckets = [];
  let parentsMissed = 0;
  let exact = true;
  for (const n of feeds) {
    const i = sftkScanBucketInfo(b, n);
    if (!i.capped) continue;
    buckets.push(n);
    const t = Number(i.total);
    if (Number.isFinite(t) && t > Number(i.shown)) parentsMissed += t - Number(i.shown);
    else exact = false;
  }
  if (!buckets.length) return null;
  return { buckets, parentsMissed: (exact && parentsMissed > 0) ? parentsMissed : null };
}

// PURE — no free variables (materialized standalone by test/extract.mjs).
function sftkParentScopeNote(info, parentObj, childObj) {
  if (!info || !Array.isArray(info.buckets) || !info.buckets.length) return '';
  const group = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const p = parentObj ? String(parentObj) : 'parent';
  const c = childObj ? String(childObj) : 'child';
  const n = Number(info.parentsMissed);
  const miss = Number.isFinite(n) && n > 0
    ? `${group(n)} ${p} record(s)`
    : `some ${p} record(s)`;
  return `⚠ This ${c} scan is scoped to the ${p} records the ${p} scan LISTED, and that scan was truncated (${info.buckets.join(', ')}) — ${miss} were never in scope, so their ${c} rows are in no bucket below. Every count here is a floor, not a total. Clear the ${p} truncation first (narrower WHERE filter, or reconcile + 🔄 Refresh state) before trusting these numbers or acting on them.`;
}

// PURE — no free variables (materialized standalone by test/extract.mjs).
function sftkPicklistGaps(records, comparePlanOrFields, tgtDescribeFieldsMap, opts) {
  const o = opts || {};
  const MAX_FIELDS   = o.maxFields   > 0 ? o.maxFields   : 30;    // compare fields examined
  const MAX_RECORDS  = o.maxRecords  > 0 ? o.maxRecords  : 5000;  // records scanned
  const MAX_DISTINCT = o.maxDistinct > 0 ? o.maxDistinct : 500;   // distinct values per field
  const MAX_REPORT   = o.maxReport   > 0 ? o.maxReport   : 25;    // missing values listed
  const recs = Array.isArray(records) ? records : [];
  const plan = Array.isArray(comparePlanOrFields) ? comparePlanOrFields : [];
  const descOf = (name) => {
    if (!name || !tgtDescribeFieldsMap) return null;
    if (typeof tgtDescribeFieldsMap.get === 'function') return tgtDescribeFieldsMap.get(name) || null;
    return tgtDescribeFieldsMap[name] || null;
  };

  // Which compare pairs land on a picklist in the TARGET org — the target's
  // list is the one that decides whether the write is accepted.
  const eligible = [];
  const seenField = new Set();
  for (const e of plan) {
    const srcField = (typeof e === 'string') ? e : (e && e.srcField);
    if (!srcField) continue;
    const tgtField = (typeof e === 'string') ? e : (e.tgtField || e.srcField);
    if (seenField.has(srcField + '' + tgtField)) continue;
    seenField.add(srcField + '' + tgtField);
    const d = descOf(tgtField);
    if (!d) continue;
    if (d.type !== 'picklist' && d.type !== 'multipicklist') continue;
    const active = (d.picklistValues || []).filter(v => v && v.active !== false);
    if (!active.length) continue;   // nothing to compare against — don't guess
    const allowed = new Set();
    for (const v of active) allowed.add(String(v.value == null ? '' : v.value).trim().toLowerCase());
    eligible.push({ srcField, tgtField, allowed,
      multi: d.type === 'multipicklist',
      restricted: d.restrictedPicklist === true });
  }
  const cand     = eligible.slice(0, MAX_FIELDS);
  const scanRecs = recs.length > MAX_RECORDS ? recs.slice(0, MAX_RECORDS) : recs;

  const gaps = [];
  for (const c of cand) {
    const missing  = new Map();   // lowercased value → first-seen original casing
    const affected = new Set();
    const seenVal  = new Set();
    let distinctCapped = false;
    for (let i = 0; i < scanRecs.length; i++) {
      const r = scanRecs[i];
      if (!r || typeof r !== 'object') continue;
      const raw = r[c.srcField];
      if (raw == null || raw === '') continue;
      // Multipicklist values arrive ';'-separated ("Hot;Warm") — each part is
      // its own picklist value and each must exist in the target.
      const parts = c.multi ? String(raw).split(';') : [String(raw)];
      let hit = false;
      for (const part of parts) {
        const v = part.trim();
        if (!v) continue;
        const key = v.toLowerCase();
        if (!seenVal.has(key)) {
          if (seenVal.size >= MAX_DISTINCT) { distinctCapped = true; continue; }
          seenVal.add(key);
        }
        if (!c.allowed.has(key)) { if (!missing.has(key)) missing.set(key, v); hit = true; }
      }
      if (hit) affected.add(r.Id || ('#' + i));
    }
    if (!missing.size) continue;
    const vals = [...missing.values()];
    gaps.push({
      field: c.srcField,
      tgtField: c.tgtField,
      missing: vals.slice(0, MAX_REPORT),
      missingTotal: vals.length,
      affected: affected.size,
      multi: c.multi,
      restricted: c.restricted,
      ...(vals.length > MAX_REPORT ? { valuesTruncated: true } : {}),
      ...(distinctCapped ? { distinctCapped: MAX_DISTINCT } : {})
    });
  }
  return {
    gaps,
    fieldsExamined:  cand.length,
    fieldsTotal:     eligible.length,
    fieldsCapped:    eligible.length > cand.length,
    recordsExamined: scanRecs.length,
    recordsTotal:    recs.length,
    recordsCapped:   recs.length > scanRecs.length,
    valueCap:        MAX_DISTINCT,
    reportCap:       MAX_REPORT
  };
}

// ════════════════════════════════════════════════════════════════
// LIVE DIFF SCAN — the source of truth for "what's in each org"
// ════════════════════════════════════════════════════════════════
// Queries source AND target for the profile's root object, indexes both
// sides by the configured matchField, and computes four buckets:
//
//   missingInTarget — in source but not in target (candidate for deploy)
//   onlyInTarget    — in target but not in source (extras, optional delete)
//   changed         — in both, but a compareField differs (drift)
//   identical       — in both, all compareFields match (in sync)
//
// The result is stored on profile.lastScan so the picker + cards can show
// live state without re-querying every time the user opens a modal.
// node/scope (optional — CHILD-AWARE RECONCILE):
//   node  — which tree node to scan (default: the root). Child nodes use
//           their own matchField/compareFields via deriveScanConfig.
//   scope — { parentField, srcParentIds[], tgtParentIds[] }: restricts both
//           sides to children of those parents (chunked IN clauses) and adds
//           link tracking — each matched row's parent KEY is read on both
//           sides (dot-path via the lookup machinery) producing a fifth
//           bucket, linkMismatch: child exists in both orgs but points at a
//           different (or no) parent in the target. Missing rows also carry
//           parentSrcId + parentKey for the dependency UI.
// Root behavior with node/scope omitted is unchanged.
// 📎 Pure file-drift comparator: for matched record pairs, count source
// files (latest-version checksums) ABSENT from the paired target record.
// Push-directional on purpose — extra target files are not drift when the
// flow is source-of-truth → target. Multiset compare: two copies of the
// same checksum in the source need two in the target.
function sftkFileDriftCompare(pairs, srcFilesByRec, tgtFilesByRec) {
  const rows = []; let missingFiles = 0;
  for (const p of (pairs || [])) {
    const src = (srcFilesByRec && srcFilesByRec[p.sourceId]) || [];
    if (!src.length) continue;
    const tgt = new Map();
    for (const c of ((tgtFilesByRec && tgtFilesByRec[p.targetId]) || [])) {
      tgt.set(c, (tgt.get(c) || 0) + 1);
    }
    let miss = 0;
    for (const c of src) {
      const n = tgt.get(c) || 0;
      if (n > 0) tgt.set(c, n - 1); else miss++;
    }
    if (miss > 0) { rows.push({ sourceId: p.sourceId, targetId: p.targetId, missing: miss }); missingFiles += miss; }
  }
  return { rows, records: rows.length, missingFiles };
}

async function runDiffScan(profile, node = null, scope = null) {
  if (!profile)                  return { error: 'no profile' };
  if (!profile.sourceOrg)        return { error: 'profile has no source org set' };
  if (!profile.targetOrg)        return { error: 'profile has no target org set' };
  // Per-target mapping overrides resolve HERE — one chokepoint for every
  // scan path (card refresh, ring, tree diff, sync plan). Shallow profile
  // shadow: lastScan stays the caller's object, only the tree is the merged
  // view. Resolution is idempotent, so callers that pre-merged are fine.
  if (typeof treeForTarget === 'function' && profile.tree && !node) {
    const merged = treeForTarget(profile.tree, profile.targetOrg);
    if (merged !== profile.tree) profile = { ...profile, tree: merged };
  }
  node = node || profile.tree;
  const objType = node?.objectType || node?.childSObject;
  if (!objType)                  return { error: 'profile has no root object' };

  const derived = deriveScanConfig(profile, node);
  // M3a — resolved matching config. ONE shared key builder (sftk-matching.js)
  // produces every key in this scan; the SAME resolved config is stored on
  // the result (scan.matching) so writers can never build keys differently.
  // Nodes with node.matching use it verbatim; legacy nodes reduce to the
  // single derived matchField pair (identical to pre-M3a behavior).
  const hasMatchingCfg = !!(node?.matching && Array.isArray(node.matching.fields)
    && node.matching.fields.filter(Boolean).length);
  const nodeMatching = hasMatchingCfg
    ? sftkMatchingFromNode(node)
    : { strategy: 'field', fields: [derived.matchField], normalize: {} };
  let srcKeyFields = sftkMatchingFields(nodeMatching);
  let tgtKeyFields = hasMatchingCfg
    ? sftkMatchingTgtFields(node, nodeMatching)
    : [derived.matchFieldTgt];
  let srcMatchField  = srcKeyFields[0];
  let tgtMatchField  = tgtKeyFields[0];
  let srcCompare     = derived.compareFields;
  let tgtCompare     = derived.compareFields.map(f => {
    // Per-side compareField names: a source field with a mapping uses the
    // mapped target name; unmapped fields assume same name on target.
    const fm = node?.fieldMappings || {};
    return (fm[f] && fm[f] !== null) ? fm[f] : f;
  });
  const where       = (node?.where || '').trim();

  // Target-side name of the parent link field (honors the node's mapping).
  // A null mapping = the user excluded the link → children can't be scoped
  // on the target side; child scanning is unsupported for that node.
  let tgtParentField = null;
  if (scope?.parentField) {
    const fmLink = node?.fieldMappings ? node.fieldMappings[scope.parentField] : undefined;
    if (fmLink === null) return { error: `the parent link field ${scope.parentField} is excluded by the field mapping — child records can't be matched to parents` };
    tgtParentField = fmLink || scope.parentField;
  }

  // Resolve sessions for both orgs. They must be reachable (open in Chrome
  // OR stored as credentialed orgs) — otherwise the scan can't query target.
  const allSess = _buildAllSessions();
  const srcSess = _resolveSession(profile.sourceOrg, allSess);
  const tgtSess = _resolveSession(profile.targetOrg, allSess);
  if (!srcSess?.sid) return { error: `source org session not active — open ${orgLabel(profile.sourceOrg)} in a tab` };
  if (!tgtSess?.sid) return { error: `target org session not active — open ${orgLabel(profile.targetOrg)} in a tab` };

  // Validate matchField + compareFields against EACH side's describe.
  // matchField corrects per side (Name might exist on source while the
  // target object uses ReturnOrderNumber). compareFields are validated as
  // PAIRS — (srcCompare[i], tgtCompare[i]) refer to the same logical field,
  // so a pair survives only when BOTH sides have the field. (The old code
  // filtered each side independently, which shifted the index pairing
  // whenever a field existed on only one side — comparing field A on
  // source to field B on target.)
  //
  // Pairs are ALSO dropped when either side's field is a lookup
  // (type 'reference'). Lookup fields hold org-local record Ids that can
  // NEVER match across orgs — after an insert-based transfer the target's
  // AccountId is a different Id (or null via Set-null resolution), so
  // counting them as drift flags every transferred record as "changed"
  // forever. Upsert/lookup-bridge runs resolve lookups at write time; the
  // drift scan compares real data fields only.
  async function describeFull(sess) {
    try { return await describe(objType, sess.orgUrl, sess.sid); } catch (_) { return null; }
  }
  const [srcDescFull, tgtDescFull] = await Promise.all([describeFull(srcSess), describeFull(tgtSess)]);
  const srcTypes = new Map((srcDescFull?.fields || []).map(f => [f.name, f.type]));
  const tgtTypes = new Map((tgtDescFull?.fields || []).map(f => [f.name, f.type]));
  const srcNameFld = (srcDescFull?.fields || []).find(f => f.nameField === true)?.name || null;
  const tgtNameFld = (tgtDescFull?.fields || []).find(f => f.nameField === true)?.name || null;

  // W4 — expand the compare set to the ENGINE's copy set (see
  // sftkEngineCompareSet). Without this, template profiles (all-'' mappings)
  // compared NOTHING and any drift in an unmapped field was invisible. A
  // legacy profile whose ONLY config is an explicit scanConfig.compareFields
  // keeps its deliberate choice. The pair-validation and reference handling
  // below apply to the expanded set unchanged.
  const hasLegacyOnlyCompare = !Object.keys(node?.fieldMappings || {}).length
    && (profile?.scanConfig?.compareFields || []).filter(Boolean).length > 0;
  let compareExpanded = false;
  if (!hasLegacyOnlyCompare && (srcDescFull?.fields || []).length) {
    const enginePairs = sftkEngineCompareSet(srcDescFull.fields, node?.fieldMappings);
    // Lookups are NOT in the engine set (its comment says "compare through
    // the resolution plan") — but this expansion REPLACED the compare lists,
    // so the reference branch below never received a field to resolve and
    // lookup-only drift was filed as "identical" (user record-pair report
    // 2026-08-09: same Name, different Step_Order_Name__c lookup, in no
    // bucket). Append every steerable reference; the plan builder still
    // decides per field — dot-path compare by related name when BOTH sides
    // resolve, honest skip (no raw-Id compare) when not.
    const fmRef = node?.fieldMappings || {};
    const refPairs = (srcDescFull.fields || []).filter(f =>
      f && f.type === 'reference' && f.createable && fmRef[f.name] !== null &&
      !['OwnerId', 'CreatedById', 'LastModifiedById', 'RecordTypeId'].includes(f.name)
    ).map(f => ({ srcField: f.name,
      tgtField: (fmRef[f.name] && fmRef[f.name] !== '') ? fmRef[f.name] : f.name }));
    // W7 pattern audit — RECORD TYPE drift was invisible: two matched
    // records with different Record Types compared as identical (the field
    // is engine-owned for WRITES, but the SCAN must still see it). Compared
    // by RecordType.DeveloperName via the same dot-path plan; same name on
    // both sides → equal, regardless of the org-local ids.
    if ((srcDescFull.fields || []).some(f => f && f.name === 'RecordTypeId') &&
        fmRef.RecordTypeId !== null) {
      refPairs.push({ srcField: 'RecordTypeId', tgtField: 'RecordTypeId' });
    }
    // OWNER drift is only DRIFT when this deployment MATCHES owners
    // (ownerMapping 'match') — under "don't copy owners" a different owner
    // is expected and not actionable, so it stays out of the compare.
    if (profile?.ownerMapping?.mode === 'match' &&
        (srcDescFull.fields || []).some(f => f && f.name === 'OwnerId')) {
      refPairs.push({ srcField: 'OwnerId', tgtField: 'OwnerId' });
    }
    const allPairs = [...enginePairs, ...refPairs];
    if (allPairs.length) {
      srcCompare = allPairs.map(p => p.srcField);
      tgtCompare = allPairs.map(p => p.tgtField);
      compareExpanded = true;
    }
  }
  if (!hasMatchingCfg) {
    // Legacy single-field path — silent nameField auto-correct (unchanged).
    if (srcTypes.size && !srcTypes.has(srcMatchField) && srcNameFld) { srcMatchField = srcNameFld; srcKeyFields = [srcMatchField]; }
    if (tgtTypes.size && !tgtTypes.has(tgtMatchField) && tgtNameFld) { tgtMatchField = tgtNameFld; tgtKeyFields = [tgtMatchField]; }
  } else {
    // Explicit matching config — a missing component would silently change
    // the key definition mid-scan, so fail loudly instead of auto-correcting.
    const missSrc = srcTypes.size ? srcKeyFields.filter(f => !srcTypes.has(f)) : [];
    const missTgt = tgtTypes.size ? tgtKeyFields.filter(f => !tgtTypes.has(f)) : [];
    if (missSrc.length || missTgt.length) {
      return { error: `matching field(s) ${[...new Set([...missSrc, ...missTgt])].join(', ')} don't exist on ${objType} in the ${missSrc.length ? 'source' : 'target'} org — fix the Matching setup in 🎯 Pick Records` };
    }
  }
  // Per-side key configs — same strategy + normalization, only the field
  // NAMES differ per side. Every key below comes from sftkMatchKey with one
  // of these two configs (THE invariant: scan and writers share this).
  const srcMatching = { strategy: nodeMatching.strategy, fields: srcKeyFields, normalize: nodeMatching.normalize || {} };
  const tgtMatching = { strategy: nodeMatching.strategy, fields: tgtKeyFields, normalize: nodeMatching.normalize || {} };

  // Per-lookup compare maps (from the node's resolution config, else Name).
  // Reference fields are compared by the RELATED record's match field, not the
  // cross-org Id. Polymorphic / no-name lookups are skipped (excluded from drift).
  const srcLkp = buildLookupCompareMap(srcDescFull, node?.lookupResolutions);
  const tgtLkp = buildLookupCompareMap(tgtDescFull, node?.lookupResolutions);

  // Link tracking for scoped (child) scans — resolve each side's parent KEY
  // via the same dot-path machinery. Both sides must resolve for the
  // linkMismatch bucket to be trackable (polymorphic links can't).
  let linkInfoSrc = scope?.parentField && srcLkp[scope.parentField] && !srcLkp[scope.parentField].skip
    ? srcLkp[scope.parentField] : null;
  let linkInfoTgt = tgtParentField && tgtLkp[tgtParentField] && !tgtLkp[tgtParentField].skip
    ? tgtLkp[tgtParentField] : null;
  // M3a — when the caller hands over the PARENT's resolved matching config
  // (scanReconcileChild does), track parent keys by its FIRST component so
  // linkMismatch/relink and the parent scan's own key indexes stay aligned.
  // Dot-paths resolve one field, so composite parents track by component 1;
  // normalization is applied at COMPARE time (raw values stay stored for
  // relink's server-side queries).
  const pMatchCfg = scope?.parentMatching || null;
  if (linkInfoSrc && pMatchCfg?.fields?.[0]) {
    linkInfoSrc = { ...linkInfoSrc, matchField: pMatchCfg.fields[0] };
  }
  if (linkInfoTgt && (pMatchCfg?.tgtFields?.[0] || pMatchCfg?.fields?.[0])) {
    linkInfoTgt = { ...linkInfoTgt, matchField: pMatchCfg.tgtFields?.[0] || pMatchCfg.fields[0] };
  }
  const pkNorm = v => pMatchCfg ? sftkNormalizeValue(v, pMatchCfg.normalize || {}) : String(v ?? '');
  const linkTrackable = !!(linkInfoSrc && linkInfoTgt);

  // R2 — master-detail guardrail (child scans): detect whether the parent
  // link field is master-detail on the SOURCE describe. relationshipOrder is
  // non-null ONLY for master-detail fields (0 or 1, per the REST describe);
  // cascadeDelete is a belt-and-braces secondary signal. MD links are
  // required at insert (child-first is impossible) and can be re-parented
  // only when the field is reparentable (describe exposes that as
  // updateable=true on the detail-side field). Any failure here degrades to
  // v1 behavior: treated as a plain lookup.
  let linkMasterDetail = false, linkUpdateable = true;
  if (scope?.parentField) {
    try {
      const lf = (srcDescFull?.fields || []).find(f => f.name === scope.parentField);
      if (lf) {
        linkMasterDetail = lf.relationshipOrder != null || lf.cascadeDelete === true;
        linkUpdateable   = lf.updateable !== false;
      }
    } catch (_) { linkMasterDetail = false; linkUpdateable = true; }
  }

  // Build two compare plans. `enhanced` resolves references via SOQL dot-paths
  // (Account.Name); `plain` drops references entirely (the legacy "ids never
  // match" behavior). Each plan entry knows how to SELECT and EXTRACT its value.
  const enhanced = [], plain = [];
  const haveTypes = srcTypes.size && tgtTypes.size;
  for (let i = 0; i < Math.min(srcCompare.length, tgtCompare.length); i++) {
    const s = srcCompare[i], t = tgtCompare[i];
    if (haveTypes && (!srcTypes.has(s) || !tgtTypes.has(t))) continue;  // missing on a side
    const isRef = haveTypes && (srcTypes.get(s) === 'reference' || tgtTypes.get(t) === 'reference');
    if (isRef) {
      const si = srcLkp[s], ti = tgtLkp[t];
      // Only compare-by-name when BOTH sides resolve; otherwise exclude the
      // lookup from drift (don't compare raw Ids → no false drift).
      if (si && !si.skip && ti && !ti.skip) {
        enhanced.push({ srcField: s, tgtField: t,
          srcSel: _lookupSelectExpr(s, si), tgtSel: _lookupSelectExpr(t, ti),
          srcExtract: r => _lookupResolvedVal(r, si), tgtExtract: r => _lookupResolvedVal(r, ti) });
      }
      continue;  // skip lookups never enter `plain`
    }
    // W7 pattern audit — multi-select picklists store 'A;B' with NO order
    // significance: 'A;B' vs 'B;A' is the same selection, and raw string
    // compare called it drift. Compare them normalized (sorted).
    const isMulti = haveTypes &&
      (srcTypes.get(s) === 'multipicklist' || tgtTypes.get(t) === 'multipicklist');
    const entry = isMulti
      ? { srcField: s, tgtField: t, srcSel: s, tgtSel: t,
          srcExtract: r => sftkMultiSelNorm(r[s]), tgtExtract: r => sftkMultiSelNorm(r[t]) }
      : { srcField: s, tgtField: t, srcSel: s, tgtSel: t,
          srcExtract: r => r[s], tgtExtract: r => r[t] };
    enhanced.push(entry); plain.push(entry);
  }

  const fieldList = (plan, side) => {
    const base = [
      // M3a — SELECT every key component (composite keys need them all).
      'Id', ...(side === 'src' ? srcKeyFields : tgtKeyFields),
      ...plan.map(p => side === 'src' ? p.srcSel : p.tgtSel)
    ];
    // Child scans also read the raw parent id + the parent's KEY (dot-path)
    // on each side — feeds linkMismatch + the dependency annotations.
    if (scope?.parentField) {
      if (side === 'src') {
        base.push(scope.parentField);
        if (linkInfoSrc) base.push(_lookupSelectExpr(scope.parentField, linkInfoSrc));
      } else {
        base.push(tgtParentField);
        if (linkInfoTgt) base.push(_lookupSelectExpr(tgtParentField, linkInfoTgt));
      }
    }
    return [...new Set(base)].filter(Boolean).join(',');
  };

  // One query for root scans; chunked parentField IN (...) queries for child
  // scans (200 parent ids per chunk — same limit the executor uses).
  // `suppress` marks the request as an expected-may-fail attempt (the
  // dot-path plan has a designed fallback) so a 400 logs as ↻, not ✖.
  async function queryAllScoped(side, plan, suppress) {
    const sess = side === 'src' ? srcSess : tgtSess;
    const fl   = fieldList(plan, side);
    const base = `SELECT ${fl} FROM ${objType}`;
    if (!scope) {
      return sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false,
        _suppressError: !!suppress,
        query: `${base}${where ? ' WHERE ' + where : ''}` });
    }
    const ids   = side === 'src' ? (scope.srcParentIds || []) : (scope.tgtParentIds || []);
    const pf    = side === 'src' ? scope.parentField : tgtParentField;
    if (!ids.length) return { records: [] };
    let recs = [];
    for (let ci = 0; ci < ids.length; ci += 200) {
      const inClause = `${pf} IN (${ids.slice(ci, ci + 200).map(id => `'${id}'`).join(',')})`;
      const w = where ? `(${where}) AND ${inClause}` : inClause;
      const r = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false,
        _suppressError: !!suppress,
        query: `${base} WHERE ${w}` });
      if (r?.error) return r;
      recs = recs.concat(r.records || []);
    }
    const seen = new Set();
    return { records: recs.filter(x => { if (seen.has(x.Id)) return false; seen.add(x.Id); return true; }) };
  }
  const runScanPair = (plan, suppress) => Promise.all([
    queryAllScoped('src', plan, suppress), queryAllScoped('tgt', plan, suppress)]);

  let comparePlan = enhanced;
  let lookupCompareDegraded = false;
  let srcRes, tgtRes;
  try {
    // The enhanced (dot-path) attempt only has a fallback when it actually
    // differs from the plain plan — suppress its error styling only then.
    const canFallback = enhanced.length !== plain.length;
    [srcRes, tgtRes] = await runScanPair(enhanced, canFallback);
    // A bad relationship/match field 400s the dot-path query → fall back to the
    // plain plan (references dropped) so the scan still produces a result.
    if ((srcRes?.error || tgtRes?.error) && canFallback) {
      // Record WHY at warn level with the FULL error — the truncated red row
      // used to hide which relationship Salesforce rejected.
      const reason = srcRes?.error || tgtRes?.error;
      window.SFToolkitDebug?.log('scan', 'warn',
        `Lookup-by-name compare not supported for ${objType} — falling back to plain compare (lookups excluded from drift)`,
        reason);
      lookupCompareDegraded = true;
      comparePlan = plain;
      [srcRes, tgtRes] = await runScanPair(plain, false);
    }
  } catch (e) {
    return { error: `scan failed: ${e?.message || e}` };
  }
  if (srcRes?.error) return { error: `source query failed: ${srcRes.error}` };
  if (tgtRes?.error) return { error: `target query failed: ${tgtRes.error}` };

  // Stored compareFields reflect the plan actually used (so the compare table
  // shows the same fields and re-resolves lookups by name on demand).
  srcCompare = comparePlan.map(p => p.srcField);
  tgtCompare = comparePlan.map(p => p.tgtField);

  // R1 — match-key collision detection. When two source (or two target)
  // records share the same match-key value, matching is ambiguous: an
  // overwrite/relink/delete could hit the WRONG record. CHILD scans exclude
  // those rows from every actionable bucket (they simply don't enter the key
  // indexes below — the `scope &&` guards) and report scan.keyCollisions. A
  // key that collides on EITHER side is excluded from BOTH sides — half-
  // matched pairs would be just as misleading. ROOT scans keep v1 matching
  // untouched (dup keys still pair arbitrarily) but the duplicates are now
  // COUNTED (scan.dupKeys) so the 🎯 accuracy grade can say how trustworthy
  // the matching was.
  let _dupKeys = new Set();
  let _keyCollisions = null;
  {
    try {
      // M3a — collision detection runs on the SAME keys the indexes use
      // (sftkMatchKey; normalization included), so "two different raw values
      // that normalize to the same key" counts as a collision too.
      // Collect IDS per key, not just counts — the UI must be able to show
      // WHICH records collide, linked, or the warning is unactionable
      // (user 2026-08-10: "where are the records").
      const collectKeys = (recs, cfg) => {
        const m = new Map();
        for (const r of recs) {
          const k = sftkMatchKey(r, cfg);
          if (k !== '') { if (!m.has(k)) m.set(k, []); m.get(k).push(r.Id); }
        }
        return m;
      };
      const sMap = collectKeys(srcRes.records || [], srcMatching);
      const tMap = collectKeys(tgtRes.records || [], tgtMatching);
      for (const [k, ids] of sMap) if (ids.length > 1) _dupKeys.add(k);
      for (const [k, ids] of tMap) if (ids.length > 1) _dupKeys.add(k);
      if (_dupKeys.size) {
        let rows = 0;
        for (const [k, ids] of sMap) if (_dupKeys.has(k)) rows += ids.length;
        for (const [k, ids] of tMap) if (_dupKeys.has(k)) rows += ids.length;
        _keyCollisions = { rows, keys: [..._dupKeys].slice(0, 50),
          // First few colliding keys WITH their record ids on each side —
          // capped to keep stored scans small.
          examples: [..._dupKeys].slice(0, 5).map(k => ({ key: k,
            src: (sMap.get(k) || []).slice(0, 5),
            tgt: (tMap.get(k) || []).slice(0, 5) })) };
      }
    } catch (_) { _dupKeys = new Set(); _keyCollisions = null; }
  }

  // R3 — orphan detection (child scans only). The scoped target query can
  // only see children whose link field points at a tracked parent — children
  // with a NULL link (e.g. created by a prior partial child-first run whose
  // reconnect step failed) are invisible to it. Query them separately and
  // surface them as tagged "possible orphan" extras: they stay OUT of the
  // key match-up (missing/changed/identical are untouched) and get excluded
  // from bulk delete by default in the UI. Best-effort: any error here just
  // means no orphan rows (v1 behavior).
  //
  // The probe is deliberately ONE page: "children with no parent link" is
  // unbounded in principle (every Contact with a blank AccountId qualifies),
  // so paging it could pull six figures of rows into a scan the user did not
  // ask to be slow. What changed is honesty about that page. It used to read
  // `SF_QUERY_ALL … LIMIT 2000`, which is self-cancelling — the embedded
  // LIMIT means one page and no nextRecordsUrl, so the pager never paged, and
  // it also made totalSize echo 2000. Asking SF_QUERY for the un-LIMITed
  // query returns the same single page PLUS the true totalSize, so the cap is
  // now reported with a measured number. Same one round-trip as before; a
  // target with fewer orphans than a page sees no change at all.
  const ORPHAN_ROW_CAP = 2000;
  let _orphanRecs = [];
  let _orphanTotal = null;     // measured org-side total; null = not reported
  let _orphanPageDone = true;  // false when Salesforce had more pages to give
  let _orphanErr = '';         // probe failure — reported, not swallowed
  if (scope && tgtParentField) {
    try {
      const nullClause = `${tgtParentField} = null`;
      const w = where ? `(${where}) AND ${nullClause}` : nullClause;
      const q = await sendBg({ type: 'SF_QUERY', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, tooling: false,
        _suppressError: true,
        query: `SELECT ${fieldList(comparePlan, 'tgt')} FROM ${objType} WHERE ${w}` });
      if (q && !q.error) {
        _orphanRecs     = (q.records || []).slice(0, ORPHAN_ROW_CAP);
        _orphanTotal    = Number.isFinite(q.totalSize) ? q.totalSize : null;
        _orphanPageDone = q.done !== false;
      } else {
        _orphanErr = String(q?.error || 'no response').slice(0, 200);
      }
    } catch (e) {
      _orphanRecs = []; _orphanTotal = null; _orphanPageDone = true;
      _orphanErr = String(e?.message || e).slice(0, 200);
    }
  }

  // ── M3c — MATCH-MEMORY PRE-PASS (root scans only) ───────────────────────
  // Records paired here are matched by REMEMBERED IDENTITY — persistent
  // srcId→tgtId pairs learned from successful transfers, prior confirmed
  // scans, and manual Match Review pairing (profile.matchMemory, keyed by
  // the TARGET org's identity key) — so a rename on either side can't break
  // the match. Matching is by Id ONLY (never by similarity). Both sides of a
  // memory pair are EXCLUDED from the key indexes below; everything else
  // flows through key matching exactly as before. Profiles without
  // matchMemory: empty mem → this whole block no-ops (byte-identical
  // legacy behavior). Any failure degrades to plain key matching with a
  // warning on the result.
  const isRootScan = !scope && node === profile.tree;
  let memoryMatched = 0;
  const memPairedSrc = new Set();
  const memPairedTgt = new Set();
  let memRows = [];                 // [{ sr, tr }] — classified with the buckets below
  const memWarnings = [];
  // AUTONUMBER match key (W7 pattern audit) — the values are org-generated
  // sequence numbers: 'A-0042' in two orgs are DIFFERENT records that happen
  // to share a counter position. Matching by them pairs records arbitrarily,
  // so every scan says so instead of letting the buckets look authoritative.
  try {
    const _autoKeys = (srcKeyFields || []).filter(k =>
      (srcDescFull?.fields || []).find(f => f && f.name === k)?.autoNumber === true);
    if (_autoKeys.length) {
      memWarnings.push(`match key ${_autoKeys.join(', ')} is an AUTONUMBER field — its values are org-generated sequence numbers, so cross-org matching by them pairs records arbitrarily. Match by a real data field or an External ID instead (🎯 Pick Records → Matching).`);
    }
  } catch (_) { /* advisory only */ }
  if (isRootScan) {
    try {
      const mem = (profile.matchMemory && typeof profile.matchMemory === 'object'
        ? profile.matchMemory[_orgKey(profile.targetOrg)] : null) || {};
      if (Object.keys(mem).length) {
        const tgtById = new Map((tgtRes.records || []).map(r => [r.Id, r]));
        for (const sr of (srcRes.records || [])) {
          const tgtId = mem[sr.Id];
          if (!tgtId) continue;
          const tr = tgtById.get(tgtId);
          // Target record gone (deleted) → the source row falls back to key
          // matching this scan. A tgt already claimed by an earlier src (bad
          // memory data) → first claim wins, the rest key-match.
          if (!tr || memPairedTgt.has(tr.Id) || memPairedSrc.has(sr.Id)) continue;
          memPairedSrc.add(sr.Id);
          memPairedTgt.add(tr.Id);
          memRows.push({ sr, tr });
          memoryMatched++;
        }
      }
    } catch (e) {
      memPairedSrc.clear(); memPairedTgt.clear(); memRows = []; memoryMatched = 0;
      memWarnings.push(`match memory skipped (fell back to key matching): ${e?.message || e}`);
      window.SFToolkitDebug?.log('scan', 'warn',
        'M3c memory pre-pass failed — falling back to key matching', e?.message || String(e));
    }
  }

  // Index each side by its own matchField — KEYS are the values themselves,
  // which match across orgs even when the field names that hold them differ
  // (Name="Andy Young" on source, Full_Name__c="Andy Young" on target both
  // key to "Andy Young"). Coerce to string so "123" (number) and "123"
  // (text) cross-org don't accidentally land in different buckets.
  // M3a — blank keys (ALL components empty) are unmatchable: excluded from
  // the indexes and COUNTED so the UI can say why rows are missing.
  let _blankSrc = 0, _blankTgt = 0;
  const srcByKey = new Map();
  for (const r of (srcRes.records || [])) {
    if (memPairedSrc.has(r.Id)) continue;     // M3c — matched from memory
    const k = sftkMatchKey(r, srcMatching);
    if (k === '') { _blankSrc++; continue; }
    if (scope && _dupKeys.has(k)) continue;   // R1 — ambiguous key, excluded
    srcByKey.set(k, r);
  }
  const tgtByKey = new Map();
  for (const r of (tgtRes.records || [])) {
    if (memPairedTgt.has(r.Id)) continue;     // M3c — matched from memory
    const k = sftkMatchKey(r, tgtMatching);
    if (k === '') { _blankTgt++; continue; }
    if (scope && _dupKeys.has(k)) continue;   // R1 — ambiguous key, excluded
    tgtByKey.set(k, r);
  }

  const missingInTarget = []; // present in source, absent in target → "deploy"
  const onlyInTarget    = []; // present in target, absent in source → "extras"
  const changed         = []; // present in both, compareFields differ → "drift"
  const identical       = []; // present in both, all compareFields match → "in sync"
  const linkMismatch    = []; // child scans: in both, but pointing at a different parent
  // T7 — how many field differences were dropped as PHANTOM drift (State /
  // Country label rewritten by the target org's picklists, same code on both
  // sides). Counted across BOTH compare loops, surfaced on the scan result.
  let phantomFields = 0;

  // M3c — classify the memory-matched pairs with the SAME compare logic the
  // key-matched rows use below (memory decides WHO matches; the compare plan
  // still decides identical vs changed). Root scans only, so no link
  // tracking here. A per-row extraction failure degrades that row to
  // "identical, no drift detail" rather than dropping it.
  for (const { sr, tr } of memRows) {
    let diffFields = [];
    try {
      for (const cp of comparePlan) {
        if (String(cp.srcExtract(sr) ?? '') !== String(cp.tgtExtract(tr) ?? '')) {
          // T7 — same State/Country CODE on both sides: the target's State &
          // Country Picklists rewrite the label on every write, so this
          // difference can NEVER converge. Not drift — don't flag it.
          if (sftkPhantomStateCountry(cp.srcField, sr, tr, cp.tgtField)) { phantomFields++; continue; }
          if (diffFields.length < 10) diffFields.push(cp.srcField);
          else break;
        }
      }
    } catch (e) {
      diffFields = [];
      memWarnings.push(`memory pair compare failed for ${sr.Id}: ${e?.message || e}`);
    }
    const mk = sftkMatchKey(sr, srcMatching) || sftkMatchKey(tr, tgtMatching) || '(from memory)';
    if (diffFields.length) changed.push({ matchKey: mk, sourceId: sr.Id, targetId: tr.Id, fields: diffFields, viaMemory: true });
    else                   identical.push({ matchKey: mk, sourceId: sr.Id, targetId: tr.Id, viaMemory: true });
  }

  // Pair-aligned compare driven by comparePlan: each entry extracts the value
  // to compare (raw field for data fields, related record's match field for
  // resolved lookups). diffFields records the SOURCE field name for the UI.
  for (const [k, sr] of srcByKey) {
    const tr = tgtByKey.get(k);
    if (!tr) {
      const row = { matchKey: k, sourceId: sr.Id };
      if (scope?.parentField) {
        // Dependency context for the child Insert column: which parent does
        // this record belong to, and by what key?
        row.parentSrcId = sr[scope.parentField] || null;
        if (linkInfoSrc) row.parentKey = String(_lookupResolvedVal(sr, linkInfoSrc) ?? '');
      }
      missingInTarget.push(row);
    } else {
      // Record WHICH fields differ (capped) — this is what lets the UI
      // answer "why is this drift?" without a live re-fetch, including
      // when one org isn't open in a tab.
      const diffFields = [];
      for (const p of comparePlan) {
        if (String(p.srcExtract(sr) ?? '') !== String(p.tgtExtract(tr) ?? '')) {
          // T7 — phantom State/Country normalization (see above): same code,
          // different label. A row whose ONLY differences are phantom lands
          // in `identical`, because an overwrite could never fix it anyway.
          if (sftkPhantomStateCountry(p.srcField, sr, tr, p.tgtField)) { phantomFields++; continue; }
          if (diffFields.length < 10) diffFields.push(p.srcField);
          else break;
        }
      }
      if (diffFields.length) changed.push({ matchKey: k, sourceId: sr.Id, targetId: tr.Id, fields: diffFields });
      else                   identical.push({ matchKey: k, sourceId: sr.Id, targetId: tr.Id });
      // Link check (child scans): same record on both sides — does it point
      // at the same parent? Compared by the parent's KEY, never by raw Id.
      if (linkTrackable) {
        const pkS = String(_lookupResolvedVal(sr, linkInfoSrc) ?? '');
        const pkT = String(_lookupResolvedVal(tr, linkInfoTgt) ?? '');
        // M3a — compare NORMALIZED (per the parent's matching config) so a
        // case-only parent-name difference isn't flagged as a wrong link.
        if (pkNorm(pkS) !== pkNorm(pkT)) {
          linkMismatch.push({ matchKey: k, sourceId: sr.Id, targetId: tr.Id,
            parentKeySrc: pkS, parentKeyTgt: pkT });
        }
      }
    }
  }
  for (const [k, tr] of tgtByKey) {
    if (!srcByKey.has(k)) onlyInTarget.push({ matchKey: k, targetId: tr.Id });
  }

  // NEAR-MISS pass (user bug 2026-08-04: one child's external-Id value
  // carried an invisible whitespace difference — the record showed as
  // "missing in target" AND its twin as an extra, with the two values
  // looking identical on screen). For every missing↔extra pair whose keys
  // differ ONLY by whitespace/case, name the difference on both rows so the
  // UI can say exactly why they didn't match and how to fix it. Detection
  // only — matching itself is untouched (the keys ARE different until the
  // user enables normalization or fixes the value).
  let nearMissCount = 0;
  try {
    const tgtByFold = new Map();
    for (const row of onlyInTarget) {
      if (row.orphan || !row.matchKey || row.matchKey === '(no key)') continue;
      const f = sftkNearMissFold(row.matchKey);
      if (!tgtByFold.has(f)) tgtByFold.set(f, row);
    }
    for (const row of missingInTarget) {
      const twin = tgtByFold.get(sftkNearMissFold(row.matchKey));
      if (!twin) continue;
      const reason = sftkNearMissReason(row.matchKey, twin.matchKey);
      if (!reason) continue;
      row.nearMiss  = { targetId: twin.targetId, reason };
      twin.nearMiss = { sourceId: row.sourceId, reason };
      nearMissCount++;
    }
  } catch (_) { nearMissCount = 0; /* detection is advisory — never fail a scan */ }
  // R3 — append the NULL-link target rows as tagged "possible orphan"
  // extras. They never joined the key match-up above, so every other bucket
  // is exactly what v1 produced.
  if (_orphanRecs.length) {
    try {
      const seenTgt = new Set((tgtRes.records || []).map(r => r.Id));
      for (const tr of _orphanRecs) {
        if (!tr?.Id || seenTgt.has(tr.Id)) continue;
        seenTgt.add(tr.Id);
        const k = sftkMatchKey(tr, tgtMatching);
        onlyInTarget.push({ matchKey: k || '(no key)', targetId: tr.Id, orphan: true });
      }
    } catch (_) { /* degrade — orphans just don't show */ }
  }
  // L6 — the per-bucket SHIP caps. The buckets above are COMPLETE (both sides
  // were paged in full by SF_QUERY_ALL); these caps only decide how much of
  // each one travels into chrome.storage.
  const BUCKET_CAP = 5000;
  const LINK_CAP   = 2000;
  // What actually SHIPS is onlyInTarget capped at 5000, and orphans are
  // appended last — so that slice eats orphan rows first. Count the survivors,
  // not the intent, or the UI would name rows it never received.
  const onlyInTargetOut = onlyInTarget.slice(0, BUCKET_CAP);
  const orphanShown = onlyInTargetOut.reduce((n, r) => n + (r && r.orphan ? 1 : 0), 0);
  const orphanCapped = _orphanTotal != null
    ? _orphanTotal > orphanShown
    : (!_orphanPageDone || _orphanRecs.length > orphanShown);
  // One string for every display site: the probe's own failure outranks the
  // cap (a failed probe means NO orphan row is listed, which is the bigger
  // thing to say), otherwise the cap wording, otherwise nothing.
  const orphanNote = _orphanErr
    ? `⚠ The possible-orphan check couldn't run (${_orphanErr}) — children whose ${tgtParentField} link is empty are NOT listed below.`
    : sftkOrphanCapNote(orphanShown, _orphanTotal, orphanCapped);

  // T6 — PICKLIST READINESS. Before anything is written, check the DISTINCT
  // (multi)picklist values carried by the records this run would push or
  // overwrite against the TARGET org's allowed values. Uses the target
  // describe fetched (and cached) above — no extra queries, no Tooling calls.
  // A failure here NEVER fails the scan; it's reported as "couldn't check".
  let picklistGaps = [], picklistGapsCap = null, picklistGapsError = null;
  try {
    const wantIds = new Set();
    for (const r of missingInTarget) if (r.sourceId) wantIds.add(r.sourceId);
    for (const r of changed)         if (r.sourceId) wantIds.add(r.sourceId);
    // Nothing would be written → nothing to check (and nothing to warn about).
    if (wantIds.size) {
      if (!tgtDescFull?.fields?.length) {
        picklistGapsError = `the ${objType} describe on the target org couldn't be read`;
      } else {
        const plRecs = [];
        for (const r of (srcRes.records || [])) if (r?.Id && wantIds.has(r.Id)) plRecs.push(r);
        const tgtFieldMap = {};
        for (const f of tgtDescFull.fields) tgtFieldMap[f.name] = f;
        const pg = sftkPicklistGaps(plRecs, comparePlan, tgtFieldMap);
        picklistGaps = pg.gaps || [];
        if (pg.fieldsCapped || pg.recordsCapped ||
            picklistGaps.some(g => g.valuesTruncated || g.distinctCapped)) {
          picklistGapsCap = {
            fieldsExamined: pg.fieldsExamined, fieldsTotal: pg.fieldsTotal,
            recordsExamined: pg.recordsExamined, recordsTotal: pg.recordsTotal,
            valueCap: pg.valueCap, reportCap: pg.reportCap
          };
        }
      }
    }
  } catch (e) {
    picklistGaps = []; picklistGapsCap = null;
    picklistGapsError = String(e?.message || e);
  }

  // M3c — AUTO-LEARN: this scan's confirmed 1:1 pairs (identical + changed
  // rows all carry sourceId + targetId; memory-matched pairs are included,
  // which refreshes their recency). NEVER persisted here — ring scans run on
  // clones, so CALLERS merge scan.learnedPairs into the real profile's
  // matchMemory (refreshProfileDiff / window.sftkLearnPairs). Root only, cap
  // 5000 to match the memory-map cap.
  let learnedPairs = [];
  if (isRootScan) {
    try {
      for (const r of identical) {
        if (r.sourceId && r.targetId) learnedPairs.push([r.sourceId, r.targetId]);
        if (learnedPairs.length >= 5000) break;
      }
      if (learnedPairs.length < 5000) {
        for (const r of changed) {
          if (r.sourceId && r.targetId) learnedPairs.push([r.sourceId, r.targetId]);
          if (learnedPairs.length >= 5000) break;
        }
      }
    } catch (_) { learnedPairs = []; }
  }

  // ── 📎 FILE COMPARISON (opt-in via the node's Files toggle) ───────────
  // "They should say the file records are missing and suggest to move them"
  // (user 2026-08-11): field-identical records can still differ in ATTACHED
  // FILES, and a green "in sync" that hides that is a lie of omission. With
  // 📎 ON, compare latest-version checksums for every matched pair
  // (identical + changed), capped at 1,000 pairs with the cap disclosed.
  // Query cost only when opted in: 2 chunked queries per side.
  let fileDrift = null;
  if (profile?.tree?.includeFiles === true && (identical.length + changed.length)) {
    try {
      const pairsAll = [...identical, ...changed]
        .filter(r => r.sourceId && r.targetId)
        .map(r => ({ sourceId: r.sourceId, targetId: r.targetId }));
      const FILE_PAIR_CAP = 1000;
      const fPairs = pairsAll.slice(0, FILE_PAIR_CAP);
      const filesByRec = async (sess, recIds) => {
        const out = {}; const docIds = new Set(); const docOwner = [];
        for (let i = 0; i < recIds.length; i += 200) {
          const lit = recIds.slice(i, i + 200).map(id => `'${id}'`).join(',');
          const q = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false,
            query: `SELECT ContentDocumentId, LinkedEntityId FROM ContentDocumentLink WHERE LinkedEntityId IN (${lit})` });
          if (q?.error) throw new Error(q.error);
          for (const l of (q.records || [])) { docIds.add(l.ContentDocumentId); docOwner.push([l.LinkedEntityId, l.ContentDocumentId]); }
        }
        const sumByDoc = {}; const ids = [...docIds];
        for (let i = 0; i < ids.length; i += 200) {
          const lit = ids.slice(i, i + 200).map(id => `'${id}'`).join(',');
          const q = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false,
            query: `SELECT ContentDocumentId, Checksum FROM ContentVersion WHERE IsLatest = true AND ContentDocumentId IN (${lit})` });
          if (q?.error) throw new Error(q.error);
          for (const v of (q.records || [])) sumByDoc[v.ContentDocumentId] = v.Checksum;
        }
        for (const [rec, doc] of docOwner) (out[rec] = out[rec] || []).push(sumByDoc[doc] || doc);
        return out;
      };
      const srcFiles = await filesByRec(srcSess, fPairs.map(fp => fp.sourceId));
      // No source files at all → nothing can be missing; skip the target read.
      const tgtFiles = Object.keys(srcFiles).length
        ? await filesByRec(tgtSess, fPairs.map(fp => fp.targetId)) : {};
      const cmp = sftkFileDriftCompare(fPairs, srcFiles, tgtFiles);
      fileDrift = { records: cmp.records, missingFiles: cmp.missingFiles,
        rows: cmp.rows.slice(0, 200),   // display slice — records/missingFiles are the truth
        pairsChecked: fPairs.length,
        ...(pairsAll.length > fPairs.length ? { capped: true, pairsTotal: pairsAll.length } : {}) };
    } catch (e) {
      // A failed file probe must not fail the scan — but it must SAY so,
      // never render as "no file drift".
      fileDrift = { error: e?.message || String(e) };
    }
  }

  // ── L6 — MEASURED BUCKET CAPS ─────────────────────────────────────────
  // Measured against the FULL arrays, one line before they are sliced, so
  // `total` is the number this scan actually counted — never estimated,
  // never a second query. onlyInTarget carries one extra caveat: its orphan
  // tail comes from the R3 one-page probe, so when THAT was capped even the
  // total is a lower bound (totalIsFloor), and the label says so with a "+".
  const _capMissing = sftkBucketCap(missingInTarget, BUCKET_CAP);
  const _capChanged = sftkBucketCap(changed,         BUCKET_CAP);
  const _capIdent   = sftkBucketCap(identical,       BUCKET_CAP);
  const _capOnly    = sftkBucketCap(onlyInTarget,    BUCKET_CAP);
  const _capLink    = sftkBucketCap(linkMismatch,    LINK_CAP);
  if (orphanCapped) _capOnly.totalIsFloor = true;
  // Attached ONLY when a bucket actually reached its cap. A small org's
  // result keeps the exact shape (and byte size) it had before L6, and the
  // `shown >= cap` fallback in sftkScanBucketInfo — which would otherwise
  // false-positive on a bucket that lands on exactly 5,000 — never runs,
  // because ">= cap" is also the condition for attaching this.
  const _anyCapped = [_capMissing, _capChanged, _capIdent, _capOnly].some(c => c.shown >= c.cap)
    || (!!scope && _capLink.shown >= _capLink.cap);
  const _bucketCaps = _anyCapped ? {
    cap:     BUCKET_CAP,
    linkCap: LINK_CAP,
    missingInTarget: _capMissing,
    changed:         _capChanged,
    identical:       _capIdent,
    onlyInTarget:    _capOnly,
    ...(scope ? { linkMismatch: _capLink } : {})
  } : null;
  // One ready-made string for every display site, same contract as
  // orphanNote: rendering it is not optional, and nobody re-words it.
  const _bucketCapNote = _bucketCaps
    ? sftkBucketCapNote({ ...{ missingInTarget, changed, identical, onlyInTarget, linkMismatch },
                          bucketCaps: _bucketCaps }, objType)
    : '';

  return {
    runAt:         new Date().toISOString(),
    status:        'success',
    objectType:    objType,
    // Stamp the org pair into the scan result so the picker can detect
    // when the user has changed orgs since the scan ran. If the profile's
    // current sourceOrg/targetOrg don't match these, the scan is stale.
    sourceOrg:     profile.sourceOrg,
    targetOrg:     profile.targetOrg,
    matchField:    srcMatchField,
    matchFieldTgt: tgtMatchField,
    // M3a — the EXACT resolved key config this scan used. Writers (relink,
    // group-B bridge) read THIS, never re-derive from the node, so scan and
    // writers can't diverge even if the profile is edited between scan+run.
    matching: {
      strategy:  srcMatching.strategy,
      fields:    [...srcMatching.fields],
      tgtFields: [...tgtMatching.fields],
      normalize: { ...(srcMatching.normalize || {}) }
    },
    // M3a — rows excluded because every key component was blank.
    ...((_blankSrc + _blankTgt) ? { blankKeys: { rows: _blankSrc + _blankTgt, src: _blankSrc, tgt: _blankTgt } } : {}),
    // W4 — what this scan actually compared: the engine copy set (expanded)
    // or a legacy explicit list. Consumers can say "compared N fields".
    ...(compareExpanded ? { compareExpanded: true } : {}),
    // Per-side fetch counts + the WHERE that scoped them — the record-A
    // triage (2026-08-09): a record in NO bucket almost always means a
    // filter excluded it BEFORE matching, and without these numbers that
    // failure mode is indistinguishable from a matching bug.
    fetched: { src: (srcRes.records || []).length, tgt: (tgtRes.records || []).length },
    ...(where ? { where } : {}),
    // Missing↔extra pairs whose keys differ only by whitespace/case — the
    // per-row detail rides on the rows themselves (row.nearMiss).
    ...(nearMissCount ? { nearMisses: nearMissCount } : {}),
    // M3c — how many pairs matched from persistent memory (Id-based), this
    // scan's learnable 1:1 pairs, and any degraded-path warnings. All three
    // are absent when memory is empty/unused (legacy shape unchanged).
    ...(memoryMatched ? { memoryMatched } : {}),
    ...(learnedPairs.length ? { learnedPairs } : {}),
    ...(memWarnings.length ? { warnings: memWarnings.slice(0, 10) } : {}),
    // 📎 file comparison result (only when the node's Files toggle is ON):
    // records whose source files are absent from the paired target record.
    ...(fileDrift ? { fileDrift } : {}),
    // Duplicate-key info for ROOT scans — info-only (the rows stayed matched,
    // arbitrarily); child scans exclude instead and report keyCollisions below.
    ...((!scope && _keyCollisions) ? { dupKeys: _keyCollisions } : {}),
    compareFields: srcCompare,
    compareFieldsTgt: tgtCompare,
    sourceCount:   srcByKey.size + memoryMatched,
    targetCount:   tgtByKey.size + memoryMatched,
    // Caps to keep chrome.storage payload reasonable on big orgs. The
    // picker only needs source IDs to badge rows, and "extras in target"
    // is just informational for now.
    missingInTarget: missingInTarget.slice(0, BUCKET_CAP),
    onlyInTarget:    onlyInTargetOut,
    changed:         changed.slice(0, BUCKET_CAP),
    identical:       identical.slice(0, BUCKET_CAP),
    // L6 — `truncated` (v1 key, unchanged meaning) said only THAT something
    // was cut, had no consumer anywhere in the extension, and carried no
    // number. bucketCaps is the per-bucket truth — { shown, total, capped }
    // measured off the full arrays — and bucketCapNote is the wording every
    // display site renders. Both are absent unless a bucket really hit its
    // cap, so a small org's stored scan is byte-for-byte what it was.
    truncated: (
      missingInTarget.length > BUCKET_CAP ||
      onlyInTarget.length    > BUCKET_CAP ||
      changed.length         > BUCKET_CAP ||
      identical.length       > BUCKET_CAP
    ),
    ...(_bucketCaps ? { bucketCaps: _bucketCaps } : {}),
    ...(_bucketCapNote ? { bucketCapNote: _bucketCapNote } : {}),
    // Set when the dot-path (lookup-by-name) compare 400'd and the scan fell
    // back to the plain plan — lookups are excluded from drift in this result.
    ...(lookupCompareDegraded ? { lookupCompareDegraded: true } : {}),
    // T7 — field differences dropped as phantom State/Country normalization
    // (same code on both sides). Rows whose ONLY differences were phantom are
    // in `identical`, not `changed`.
    ...(phantomFields ? { phantomFields } : {}),
    // T6 — (multi)picklist values these records carry that the TARGET org's
    // picklist doesn't have. Absent when there are none. picklistGapsCap says
    // what the check did NOT look at; picklistGapsError says it couldn't run.
    ...(picklistGaps.length ? { picklistGaps } : {}),
    ...(picklistGapsCap ? { picklistGapsCap } : {}),
    ...(picklistGapsError ? { picklistGapsError } : {}),
    // Child-scan extras (absent on root scans).
    ...(scope ? {
      scoped:        true,
      parentField:   scope.parentField,
      linkTrackable,
      linkMismatch:  linkMismatch.slice(0, LINK_CAP),
      // R2 — master-detail flags for the parent link field (source describe).
      linkMasterDetail,
      linkUpdateable,
      // R3 — how many NULL-link "possible orphan" rows this result CARRIES
      // (orphanCount, kept under its v1 name), whether that is all of them
      // (orphanCapped + the measured orphanTotal when Salesforce reported
      // one), and the ready-made wording every display site must use so none
      // of them can quietly present a floor as a total.
      ...(orphanShown ? { orphanCount: orphanShown } : {}),
      ...(orphanCapped ? { orphanCapped: true, orphanCap: ORPHAN_ROW_CAP } : {}),
      ...(_orphanTotal != null ? { orphanTotal: _orphanTotal } : {}),
      ...((orphanShown || orphanCapped) ? { orphanLabel: sftkOrphanLabel(orphanShown, _orphanTotal, orphanCapped) } : {}),
      ...(orphanNote ? { orphanNote } : {}),
      // R1 — rows excluded because their match key is duplicated on a side.
      ...(_keyCollisions ? { keyCollisions: _keyCollisions } : {})
    } : {})
  };
}

// Scan ONE child node of the profile's tree, scoped to the parents the root
// scan found (all of them — classification is independent of what the user
// later selects). Stores the result at profile.lastScan.children[pathKey],
// stamped with the root scan's runAt so staleness is detectable (root rescan
// → child scans need re-running).
async function scanReconcileChild(profile, pathKey) {
  // Per-target overrides — same shadow as runDiffScan (child nodes read
  // their fieldMappings for link scoping + compare planning).
  if (typeof treeForTarget === 'function' && profile?.tree) {
    const merged = treeForTarget(profile.tree, profile.targetOrg);
    if (merged !== profile.tree) profile = { ...profile, tree: merged };
  }
  const node = getNodeByPath(profile.tree, pathKey);
  if (!node)        return { error: 'child node not found in the profile tree' };
  if (!node.field)  return { error: 'child node has no parent link field' };
  const root = profile.lastScan;
  if (!root || root.status !== 'success') return { error: 'run the root scan first (🔄 Refresh state)' };

  // R5 — depth-aware scoping. Direct children ('0') scope by the ROOT scan's
  // ids (v1, unchanged). Grandchildren ('0.1') scope by their PARENT child
  // scan's ids — which therefore must exist and be fresh. Deeper nesting is
  // out of scope for v2.
  const segs = String(pathKey).split('.');
  if (segs.length > 2) {
    return { error: 'reconcile scans go two levels deep (children + grandchildren) in v2 — deeper nodes aren\'t supported yet' };
  }
  let scanBasis = root;   // whose buckets provide the parent ids
  if (segs.length === 2) {
    const parentKey = segs.slice(0, -1).join('.');
    const ps = root.children?.[parentKey];
    if (!ps || ps.status !== 'success' || ps.rootRunAt !== root.runAt) {
      const pNode = getNodeByPath(profile.tree, parentKey);
      const pObj  = pNode?.objectType || pNode?.childSObject || 'parent';
      return { error: `scan the parent first — this scan is scoped to the ${pObj} child scan's results (🔎 Scan on the ${pObj} section above)` };
    }
    scanBasis = ps;
  }

  const srcParentIds = [...new Set([
    ...(scanBasis.missingInTarget || []).map(r => r.sourceId),
    ...(scanBasis.changed         || []).map(r => r.sourceId),
    ...(scanBasis.identical       || []).map(r => r.sourceId)
  ].filter(Boolean))];
  const tgtParentIds = [...new Set([
    ...(scanBasis.changed      || []).map(r => r.targetId),
    ...(scanBasis.identical    || []).map(r => r.targetId),
    ...(scanBasis.onlyInTarget || []).map(r => r.targetId)
  ].filter(Boolean))];

  // M3a — hand the child scan the PARENT's key config so parent-link keys
  // (parentKey / linkMismatch) are built the same way the parent scan built
  // its own keys. Prefer the parent scan's STORED config (already validated
  // against both orgs' describes); fall back to resolving the parent node.
  let parentMatching = scanBasis.matching || null;
  if (!parentMatching) {
    try {
      const pNode = segs.length === 2
        ? getNodeByPath(profile.tree, segs.slice(0, -1).join('.'))
        : profile.tree;
      const pm = sftkMatchingFromNode(pNode);
      parentMatching = {
        strategy: pm.strategy, fields: pm.fields,
        tgtFields: sftkMatchingTgtFields(pNode, pm),
        normalize: pm.normalize
      };
    } catch (_) { parentMatching = null; }
  }

  const res = await runDiffScan(profile, node, {
    parentField: node.field, srcParentIds, tgtParentIds, parentMatching
  });
  if (res?.error) return res;
  res.rootRunAt = root.runAt;   // staleness stamp — must match the root scan
  // L6 — the id lists above come from the BASIS scan's buckets, which ship
  // capped. If the basis was truncated, the parents past its cap were never
  // in scope, so this child scan's own buckets are a floor and nothing in
  // its own numbers reveals that. Record it (and the ready-made wording) so
  // the section can't present a scoped-away count as a total. Absent when
  // the basis was complete — a small org's child scan is unchanged.
  try {
    const _pScope = sftkParentScopeCap(scanBasis);
    if (_pScope) {
      const _pNode = segs.length === 2
        ? getNodeByPath(profile.tree, segs.slice(0, -1).join('.'))
        : profile.tree;
      const _pObj = _pNode?.objectType || _pNode?.childSObject || 'parent';
      res.parentScopeCapped = _pScope;
      res.parentScopeNote    = sftkParentScopeNote(_pScope, _pObj,
        node.objectType || node.childSObject || 'child');
    }
  } catch (_) { /* degrade — the child scan itself is unaffected */ }
  if (!profile.lastScan.children) profile.lastScan.children = {};
  profile.lastScan.children[pathKey] = res;
  if (!profile.ephemeral) await storageSaveProfiles();
  return res;
}

// Run the diff scan for the given profileId, write the result back to the
// profile, persist, refresh whatever UI is open. Returns the result object
// so the caller can show a toast / error / counts inline.
async function refreshProfileDiff(profileId) {
  // Ephemeral profiles (from Org Compare → Reconcile) aren't in _profiles —
  // fall back to the in-memory _reconcileProfile so the refresh button inside
  // Reconcile still works on them. ephemeral profiles skip the storage save.
  let profile = _profiles.find(p => p.id === profileId);
  if (!profile && _reconcileProfile && _reconcileProfile.id === profileId) {
    profile = _reconcileProfile;
  }
  if (!profile) return null;
  const res = await runDiffScan(profile);
  if (res?.error) {
    showToast(`Diff scan: ${res.error}`, 'error', 6000);
    return res;
  }
  // M3c — AUTO-LEARN: merge this scan's confirmed 1:1 pairs into the real
  // profile's match memory (skipped for ephemeral profiles — e.g. ring
  // reconcile clones, whose sourceOrg may be overridden). The raw pair list
  // is then stripped from the stored scan: it lives in matchMemory, not in
  // lastScan (keeps chrome.storage payloads lean).
  try {
    if (!profile.ephemeral && Array.isArray(res.learnedPairs) && res.learnedPairs.length) {
      await window.sftkLearnPairs?.(profile.id, profile.targetOrg, res.learnedPairs);
    }
  } catch (e) {
    window.SFToolkitDebug?.log('scan', 'warn', 'match-memory auto-learn failed', e?.message || String(e));
  }
  delete res.learnedPairs;
  profile.lastScan  = res;
  profile.updatedAt = new Date().toISOString();
  if (!profile.ephemeral) await storageSaveProfiles();

  // Staleness law — this is the ONE chokepoint every native scan flows
  // through (reconcile refresh, POST-RUN auto-rescan, profile-card refresh).
  // Feed every sync surface from it: parent-sync verdicts (Builder chips,
  // advisor checklist) and the ring tile. User 2026-08-11: ran a transfer,
  // returned to the Builder, "the app didn't know we are synced" — the run's
  // own rescan HAD the fresh verdict and nothing consumed it. Ephemeral
  // scans deposit the verdict too (the pair they measured is real knowledge;
  // sftkParentSyncPut is newest-wins so double deposits are harmless);
  // the ring tile keeps its own non-ephemeral path.
  try {
    if (res.status === 'success' && res.objectType && typeof sftkParentSyncPut === 'function') {
      sftkParentSyncPut(profile.sourceOrg, profile.targetOrg, res.objectType, {
        missing: (res.missingInTarget || []).length,
        changed: (res.changed || []).length,
        extra:   (res.onlyInTarget || []).length,
        at: res.runAt,
      });
    }
    if (!profile.ephemeral && typeof sftkRingTileFromScan === 'function') sftkRingTileFromScan(profile);
  } catch (_) { /* advisory surfaces only */ }

  // Keep the in-memory transfer profile aligned, mirroring commitEditingProfile.
  if (_transferProfile && _transferProfile.id === profile.id) _transferProfile = profile;

  // L6 — the toast is a display site too. On a complete scan these labels are
  // the plain numbers it always showed; on a capped one they read
  // "5,000 of 47,213" instead of quietly reporting the floor as the answer.
  const _lbl = k => {
    const i = sftkScanBucketInfo(res, k);
    return sftkBucketCountLabel(i.shown, i.total, i.capped, i.totalIsFloor);
  };
  showToast(
    `Diff refreshed — ${_lbl('missingInTarget')} missing, ${_lbl('changed')} drift, ${_lbl('identical')} in sync${res.bucketCaps ? ' · list truncated, see the ⚠ note in Reconcile' : ''}`,
    'success', res.bucketCaps ? 7000 : 4000);
  // Re-render whichever view is open
  if (_currentView === 'profiles') renderProfiles();
  return res;
}
window.refreshProfileDiff = refreshProfileDiff;

// M3c — merge learned [srcId, tgtId] pairs into the REAL profile's persistent
// match memory and save. THE single write path for match memory: called by
// refreshProfileDiff (auto-learn), the ring scans in studio-ring.js (which run
// on clones), the transfer/fan-out learn hooks, and Match Review's manual
// [Pair ⇒]. Memory is keyed per TARGET org identity:
//   profile.matchMemory = { [orgKey(tgtUrl)]: { [srcId]: tgtId } }   (cap 5000)
// No-ops safely for unknown/ephemeral profile ids, empty pair lists, or an
// unresolvable org key. Never throws.
window.sftkLearnPairs = async function (profileId, tgtUrl, learnedPairs) {
  try {
    if (!Array.isArray(learnedPairs) || !learnedPairs.length) return;
    const p = _profiles.find(x => x.id === profileId);
    if (!p || p.ephemeral) return;
    const key = _orgKey(tgtUrl || '');
    if (!key) return;
    if (!p.matchMemory || typeof p.matchMemory !== 'object') p.matchMemory = {};
    p.matchMemory[key] = sftkMemoryMerge(p.matchMemory[key], learnedPairs, 5000);
    await storageSaveProfiles();
  } catch (e) {
    window.SFToolkitDebug?.log('scan', 'warn', 'match-memory merge failed', e?.message || String(e));
  }
};

// "Refresh state" — now just the diff scan (drives Pick Records badges +
// profile card chips + Reconcile columns). The snapshot capture that this
// used to bundle was removed along with the Org Map drift overlay (its only
// consumer). Kept as a thin alias so the profile-card button and the
// post-transfer auto-refresh keep working without changes.
window.refreshProfileState = async function(profileId) {
  return refreshProfileDiff(profileId);
};

// Open the Run Transfer page pre-filtered to ONLY the failed source IDs
// from a previous run. Walks the run's summary, builds per-node recordIds
// overrides via _transferNodeFilters, sets _transferProfile, then renders
// the transfer view. The user just clicks ▶ Run to retry.
window.retryFailedRun = function(runId) {
  const run = _history.find(h => h.id === runId);
  if (!run) return showToast('Run not found', 'error', 3000);
  const profile = _profiles.find(p => p.id === run.profileId);
  if (!profile) return showToast('Profile no longer exists — cannot retry', 'error', 4000);

  // Build a map of objectType → [failedIds]
  const failedByObj = {};
  for (const [obj, s] of Object.entries(run.summary || {})) {
    const ids = (s.failedSourceIds || []).map(f => typeof f === 'string' ? f : f.id).filter(Boolean);
    if (ids.length) failedByObj[obj] = ids;
  }
  if (!Object.keys(failedByObj).length) {
    return showToast('No failed records recorded for this run — nothing to retry', 'info', 4000);
  }

  // Walk the tree, find each node whose objectType has failures, and seed
  // a transferNodeFilter with the failed IDs for that exact tree path.
  const filters = {};
  function walk(node, path) {
    if (!node) return;
    const t = node.objectType || node.childSObject;
    const pathKey = path.join('.');
    if (t && failedByObj[t]) {
      filters[pathKey] = { recordIds: failedByObj[t] };
    }
    (node.children || []).forEach((c, i) => walk(c, [...path, i]));
  }
  walk(profile.tree, []);

  // Seed the transfer page state, then navigate.
  _transferProfile      = profile;
  _transferNodeFilters  = filters;
  document.querySelectorAll('.ds-nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-view="profiles"]')?.classList.add('active');
  _currentView = 'profiles';
  renderTransfer();
  showToast(`Retry queued — ${Object.values(failedByObj).reduce((n,a)=>n+a.length,0)} record(s) across ${Object.keys(failedByObj).length} object(s). Click ▶ Run to retry.`, 'info', 5000);
};

// ════════════════════════════════════════════════════════════════
// DRIFT FIELD COMPARE — used by the Pick Records picker + Reconcile view
// ════════════════════════════════════════════════════════════════
// Fetches one record from each org on demand and renders a side-by-side
// field compare. No snapshot cache — queries live.
// ── Lookup-aware drift comparison ────────────────────────────────────────────
// Raw lookup Ids ALWAYS differ across orgs, so comparing them as drift is
// meaningless. Instead resolve each reference field to a human-comparable value
// — the related record's match field (the per-lookup matchField the user set on
// the Field Mapping screen, else "Name"). Returns:
//   { [fieldName]: { relName, matchField } | { skip:true } }
// skip:true fields are EXCLUDED from drift entirely (polymorphic lookups, or a
// reference with no relationshipName) rather than compared by raw Id.
function buildLookupCompareMap(describe, lookupResolutions) {
  const map = {};
  for (const f of (describe?.fields || [])) {
    if (f.type !== 'reference') continue;
    const cfg  = (lookupResolutions || {})[f.name];
    // W7 pattern audit — RecordTypeId resolves by DeveloperName, the same
    // cross-org identity the engine's RT remap writes by. (Its Name is a
    // translatable label; DeveloperName is the API identity.)
    if (f.name === 'RecordTypeId') {
      map[f.name] = { relName: 'RecordType', matchField: cfg?.matchField || 'DeveloperName' };
      continue;
    }
    // OwnerId is polymorphic (User/Group) but BOTH targets carry Name, so
    // the generic poly-skip is too cautious here. Only consulted when the
    // compare plan opts owners in (ownerMapping 'match').
    if (f.name === 'OwnerId') {
      map[f.name] = { relName: 'Owner', matchField: cfg?.matchField || 'Name' };
      continue;
    }
    const poly = f.polymorphicForeignKey || (f.referenceTo || []).length > 1;
    // No relationship to traverse, or polymorphic without an explicit match
    // field (parent name field varies per type) → can't safely resolve a name.
    if (!f.relationshipName || (poly && !cfg?.matchField)) { map[f.name] = { skip: true }; continue; }
    map[f.name] = { relName: f.relationshipName, matchField: cfg?.matchField || 'Name' };
  }
  return map;
}

// Multi-select picklist values compare ORDER-INSENSITIVELY: Salesforce
// stores 'A;B' semicolon-joined in selection order, but the selection
// {A,B} === {B,A}. Sort the parts before comparing. PURE — unit-tested.
function sftkMultiSelNorm(v) {
  if (v == null || v === '') return v;
  return String(v).split(';').map(t => t.trim()).filter(Boolean).sort().join(';');
}

// SOQL dot-path for a reference field's resolved value, e.g. "Account.Name" or
// "SBQQ__PriceRule2__r.Name". Pulls the related record's match field inline so
// no extra per-record query is needed.
function _lookupSelectExpr(fieldName, info) {
  return `${info.relName}.${info.matchField}`;
}

// Read the resolved value out of a record returned by a dot-path SELECT — SOQL
// nests the parent ("Account.Name" → rec.Account.Name). Null parent → ''.
function _lookupResolvedVal(rec, info) {
  const parent = rec ? rec[info.relName] : null;
  return parent == null ? '' : (parent[info.matchField] ?? '');
}

async function fetchDriftRowDetail(profile, objectType, srcId, tgtId, srcFields, tgtFields) {
  const allSess = _buildAllSessions();
  // Use the profile's org pair directly — the legacy schedule object (the
  // Schedule feature was removed) could carry a DIFFERENT org pair and made
  // this compare silently query the wrong orgs on old profiles.
  const srcUrl  = profile.sourceOrg;
  const tgtUrl  = profile.targetOrg;
  const srcSess = _resolveSession(srcUrl, allSess);
  const tgtSess = _resolveSession(tgtUrl, allSess);
  if (!srcSess?.sid || !tgtSess?.sid) {
    // Name the org(s) that are actually missing — "open both orgs" sent
    // users hunting when only one tab was needed.
    const offline = [
      !srcSess?.sid ? orgLabel(srcUrl || '') : null,
      !tgtSess?.sid ? orgLabel(tgtUrl || '') : null
    ].filter(Boolean).join(' and ');
    return { error: `Open ${offline} in a Chrome tab to fetch live field values for the diff.` };
  }
  // Build a lookup-compare map so reference fields are diffed by the related
  // record's name (not the cross-org Id). Describe against the source org; on
  // any describe failure lookupMap is empty → behaves exactly as before.
  let lookupMap = {};
  try {
    const desc = await describe(objectType, srcSess.orgUrl, srcSess.sid);
    const node = _findTreeNode(profile.tree, objectType);
    lookupMap = buildLookupCompareMap(desc, node?.lookupResolutions);
  } catch (_) { lookupMap = {}; }

  // For ref fields we can resolve, SELECT the dot-path (Account.Name) instead of
  // the raw Id field; for skip refs, drop them from the SELECT entirely.
  function buildSelect(fields) {
    const out = ['Id'];
    for (const f of (fields || [])) {
      if (!f) continue;
      const info = lookupMap[f];
      if (info?.skip) continue;
      out.push(info ? _lookupSelectExpr(f, info) : f);
    }
    return [...new Set(out)].join(',') || 'Id';
  }
  const srcSelectEnh = buildSelect(srcFields);
  const tgtSelectEnh = buildSelect(tgtFields);
  // Plain fallback (current behavior) — used if the dot-path query errors, e.g.
  // a parent object lacks the assumed match field.
  const srcSelectPlain = [...new Set(['Id', ...srcFields])].filter(Boolean).join(',') || 'Id';
  const tgtSelectPlain = [...new Set(['Id', ...tgtFields])].filter(Boolean).join(',') || 'Id';

  async function runPair(srcSel, tgtSel, suppress) {
    return Promise.all([
      sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: srcSess.orgUrl, sid: srcSess.sid,
        _suppressError: !!suppress,
        query: `SELECT ${srcSel} FROM ${objectType} WHERE Id = '${srcId}'` }),
      sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
        _suppressError: !!suppress,
        query: `SELECT ${tgtSel} FROM ${objectType} WHERE Id = '${tgtId}'` })
    ]);
  }

  try {
    // Suppress error styling on the dot-path attempt only when a plain
    // fallback actually exists (i.e. the selects differ).
    const canFallback = srcSelectEnh !== srcSelectPlain || tgtSelectEnh !== tgtSelectPlain;
    let [s, t] = await runPair(srcSelectEnh, tgtSelectEnh, canFallback);
    // Dot-path query failed (bad relationship/match field) → retry plain so the
    // diff still renders, just with raw Ids for the un-resolvable lookups.
    if ((s?.error || t?.error) && canFallback) {
      window.SFToolkitDebug?.log('scan', 'warn',
        `Lookup-by-name fetch not supported for ${objectType} row detail — showing raw values`,
        s?.error || t?.error);
      [s, t] = await runPair(srcSelectPlain, tgtSelectPlain, false);
      lookupMap = {};
    }
    if (s?.error) return { error: `Source query failed: ${s.error}` };
    if (t?.error) return { error: `Target query failed: ${t.error}` };
    // Per-ORG field types (user 2026-07-22: "say which type of field it is
    // exactly… number 0.2 in one org and something else in the target").
    // Describes are cached per org, so this costs nothing after the first row.
    let types = null;
    try {
      const [sd, td] = await Promise.all([
        describe(objectType, srcSess.orgUrl, srcSess.sid),
        describe(objectType, tgtSess.orgUrl, tgtSess.sid),
      ]);
      const idx = d => {
        const m = {};
        for (const f of (d?.fields || [])) m[f.name] = f;
        return m;
      };
      types = { src: idx(sd), tgt: idx(td) };
    } catch (_) { types = null; }   // types are additive — never fail the diff
    return { srcRec: s.records?.[0] || null, tgtRec: t.records?.[0] || null, lookupMap, types };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

// Exact field type for ONE org, from its describe entry: the type plus the
// precision that actually bites — Number(18,2) vs Number(18,0), Text(255) vs
// Text(80), Picklist, Lookup(Account). Pure — unit-testable.
function sftkFieldTypeLabel(f) {
  if (!f || !f.type) return '';
  const t = f.type;
  const num = ['double', 'currency', 'percent'].includes(t);
  const NAMES = { string: 'Text', textarea: 'Long text', boolean: 'Checkbox', double: 'Number',
    int: 'Number', integer: 'Number', currency: 'Currency', percent: 'Percent', date: 'Date',
    datetime: 'Date/Time', time: 'Time', email: 'Email', phone: 'Phone', url: 'URL',
    picklist: 'Picklist', multipicklist: 'Multi-picklist', reference: 'Lookup', id: 'Id',
    encryptedstring: 'Encrypted text', base64: 'File', address: 'Address', location: 'Geolocation' };
  const base = NAMES[t] || t;
  if (num) {
    const prec = f.precision != null ? f.precision : '';
    const scale = f.scale != null ? f.scale : '';
    return (prec !== '' || scale !== '') ? `${base}(${prec},${scale})` : base;
  }
  if (t === 'int' || t === 'integer') return f.digits ? `${base}(${f.digits})` : base;
  if (['string', 'textarea', 'email', 'phone', 'url', 'encryptedstring'].includes(t)) {
    return f.length ? `${base}(${f.length})` : base;
  }
  if (t === 'reference') {
    const to = (f.referenceTo || []).join('/');
    return to ? `${base}(${to})` : base;
  }
  return base;
}

// Side-by-side compareField table — highlights rows whose values differ.
// srcFields[i] pairs with tgtFields[i] (pair-aligned, same as snapshot
// captureOrgSnapshot writes them). `types` = { src: {name:describeField},
// tgt: {…} } → each side shows its EXACT type, and a type difference is
// called out even when the values happen to match.
function renderDriftCompareTable(srcRec, tgtRec, srcFields, tgtFields, lookupMap = {}, types = null) {
  if (!srcRec || !tgtRec) {
    return `<div class="ds-drift-compare-err">⚠ Record not found on one or both orgs — may have been deleted since the last scan. Click 🔄 Refresh state to update.</div>`;
  }
  const pairs = [];
  const len = Math.min(srcFields.length, tgtFields.length);
  for (let i = 0; i < len; i++) {
    const sf = srcFields[i], tf = tgtFields[i];
    const info = lookupMap[sf];
    if (info?.skip) {
      // Reference we can't safely compare by name (polymorphic / no name field).
      // Show it, but never count a raw-Id difference as drift.
      pairs.push({ srcField: sf, tgtField: tf, srcVal: '—', tgtVal: '—',
        differs: false, note: 'lookup · not compared' });
      continue;
    }
    if (info) {
      // Compare the related record's match field, NOT the cross-org Id.
      const sv = _lookupResolvedVal(srcRec, info);
      const tv = _lookupResolvedVal(tgtRec, info);
      const sStr = (sv == null || sv === '') ? '∅' : String(sv);
      const tStr = (tv == null || tv === '') ? '∅' : String(tv);
      pairs.push({ srcField: sf, tgtField: tf, srcVal: sStr, tgtVal: tStr,
        differs: sStr !== tStr, note: `lookup · by ${info.matchField}` });
      continue;
    }
    const sv = srcRec[sf], tv = tgtRec[tf];
    const sStr = (sv == null || sv === '') ? '∅' : String(sv);
    const tStr = (tv == null || tv === '') ? '∅' : String(tv);
    const rawDiffers = sStr !== tStr;
    // T7 — PHANTOM: State/Country whose CODE is identical on both sides. The
    // target org's State & Country Picklists rewrite the label from the code
    // on every write, so this is not drift and an overwrite can never fix it.
    // (Needs the `${field}Code` sibling in the compare set — without it we
    // don't guess and the difference shows as ordinary drift.)
    const phantom = rawDiffers && sftkPhantomStateCountry(sf, srcRec, tgtRec, tf);
    const differs = rawDiffers && !phantom;
    // Near-invisible differences get named — "Word of mouth" vs "Word of
    // Mouth" looks identical at a glance but is real drift.
    const subtle = differs && sStr.toLowerCase() === tStr.toLowerCase() ? 'case only'
                 : differs && sStr.trim() === tStr.trim() ? 'whitespace only'
                 : null;
    pairs.push({ srcField: sf, tgtField: tf, srcVal: sStr, tgtVal: tStr, differs, subtle,
      phantom, phantomCode: phantom ? String(srcRec[sf + 'Code']) : null });
  }
  // Per-org exact types — attached to every pair, plus a type-mismatch flag
  // (a Number(18,2) source into a Number(18,0) target rounds silently).
  if (types) {
    for (const p of pairs) {
      p.srcType = sftkFieldTypeLabel(types.src?.[p.srcField]);
      p.tgtType = sftkFieldTypeLabel(types.tgt?.[p.tgtField]);
      p.typeDiffers = !!(p.srcType && p.tgtType && p.srcType !== p.tgtType);
    }
  }
  const diffCount    = pairs.filter(p => p.differs).length;
  const phantomCount = pairs.filter(p => p.phantom).length;
  if (!pairs.length) {
    return `<div class="ds-drift-compare-empty">No compareFields configured for this profile — can't show field-by-field diff. Add fields to the Field Mapping on the root node to enable.</div>`;
  }
  return `
    <div class="ds-drift-compare">
      <div class="ds-drift-compare-hdr">${diffCount} of ${pairs.length} field${pairs.length !== 1 ? 's' : ''} differ${diffCount === 1 ? 's' : ''}${phantomCount ? `<span style="margin-left:8px;font-weight:400;color:#4338ca" title="State/Country label(s) rewritten by the target org's State &amp; Country Picklists — same underlying code on both sides. Not counted as drift: an overwrite can never change them.">· ${phantomCount} normalized by the target org</span>` : ''}</div>
      <div class="ds-drift-compare-table">
        <div class="ds-drift-compare-row ds-drift-compare-row-hdr">
          <span class="ds-drift-compare-field">Field</span>
          <span class="ds-drift-compare-val">Source</span>
          <span class="ds-drift-compare-val">Target</span>
        </div>
        ${pairs.map(p => `
          <div class="ds-drift-compare-row${p.differs ? ' ds-drift-compare-row-diff' : ''}${(p.note || p.phantom) && !p.differs ? ' ds-drift-compare-row-lkp' : ''}">
            <span class="ds-drift-compare-field" title="${p.srcField !== p.tgtField ? esc(p.srcField + ' → ' + p.tgtField) : esc(p.srcField)}">
              ${esc(p.srcField)}${p.srcField !== p.tgtField ? `<span class="ds-drift-compare-rename"> → ${esc(p.tgtField)}</span>` : ''}
              ${p.note ? `<span class="ds-drift-compare-lkptag">${esc(p.note)}</span>` : ''}
              ${p.phantom ? `<span class="ds-drift-compare-lkptag" style="background:#eef2ff;color:#4338ca;border-color:#c7d2fe" title="Both orgs hold the same code (${esc(p.phantomCode || '')}) — the target org has State &amp; Country Picklists enabled, so it rewrites this label from the code on every write. Pushing the source label would be normalized straight back (or rejected outright), so this can never converge. Not counted as drift.">≡ normalized by the target org — same code, different label</span>` : ''}
              ${p.subtle ? `<span class="ds-drift-compare-lkptag" title="The values differ only subtly — easy to miss by eye">≈ ${esc(p.subtle)}</span>` : ''}
              ${p.typeDiffers ? `<span class="ds-drift-compare-lkptag ds-drift-typediff" title="This field is defined DIFFERENTLY in the two orgs (${esc(p.srcType)} vs ${esc(p.tgtType)}) — values can be truncated, rounded or rejected on write.">⚠ type differs</span>` : ''}
            </span>
            <span class="ds-drift-compare-val">${esc(p.srcVal)}${p.srcType ? `<span class="ds-drift-type">${esc(p.srcType)}</span>` : ''}</span>
            <span class="ds-drift-compare-val">${esc(p.tgtVal)}${p.tgtType ? `<span class="ds-drift-type${p.typeDiffers ? ' ds-drift-type-bad' : ''}">${esc(p.tgtType)}</span>` : ''}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// Manual "📸 Snapshot" for a single PROFILE — captures snapshots for every
// objectType in the profile's tree, on both sourceOrg and targetOrg. Uses
// profile.scanConfig for the root object, defaults to Name for children.
function _buildAllSessions() {
  const sessMap = new Map();
  if (_orgUrl) sessMap.set(_orgUrl, { orgUrl: _orgUrl, sid: _sid, label: orgLabel(_orgUrl) });
  for (const s of _allSessions) {
    if (!sessMap.has(s.orgUrl)) sessMap.set(s.orgUrl, { orgUrl: s.orgUrl, sid: s.sid, label: orgLabel(s.orgUrl) });
  }
  return [...sessMap.values()];
}

// Resolve a profile's org URL (a plain string) to a usable session object.
// Returns null if we have no session/credentials for that URL — caller is
// expected to show a "open this org in a tab or add credentials" warning.
function _resolveSession(orgUrl, allSess) {
  if (!orgUrl) return null;
  // Exact match first (fast path, also preserves the original URL when forms
  // already agree), then fall back to org-identity match so a profile URL
  // stored in a different domain form (lightning vs my.salesforce, trailing
  // slash, …) still resolves to its live open-tab session.
  const exact = allSess.find(s => s.orgUrl === orgUrl);
  if (exact) return exact;
  const key = _orgKey(orgUrl);
  return key ? (allSess.find(s => _orgKey(s.orgUrl) === key) || null) : null;
}

// ── L6 — bucket-cap contract, published explicitly ────────────────────────
// These are the ONLY sanctioned way to turn a diff bucket into a number a
// user reads, or to decide that a selection came from a truncated list. They
// are already globals (classic script), but the explicit attach is the
// contract: display sites in other files call window.sftk*, so a missing
// script shows up as a degraded label instead of a page-killing ReferenceError
// — and no site can quietly grow its own wording. Same convention as
// sftk-matching.js.
if (typeof window !== 'undefined') {
  window.sftkBucketCap         = sftkBucketCap;
  window.sftkBucketCapShipped  = sftkBucketCapShipped;
  window.sftkScanBucketInfo    = sftkScanBucketInfo;
  window.sftkBucketCountLabel  = sftkBucketCountLabel;
  window.sftkBucketCapTitle    = sftkBucketCapTitle;
  window.sftkBucketCapNote     = sftkBucketCapNote;
  window.sftkCappedWriteNote   = sftkCappedWriteNote;
  window.sftkParentScopeCap    = sftkParentScopeCap;
  window.sftkParentScopeNote   = sftkParentScopeNote;
}

