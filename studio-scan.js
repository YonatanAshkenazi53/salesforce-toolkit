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
async function runDiffScan(profile, node = null, scope = null) {
  if (!profile)                  return { error: 'no profile' };
  if (!profile.sourceOrg)        return { error: 'profile has no source org set' };
  if (!profile.targetOrg)        return { error: 'profile has no target org set' };
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
    const entry = { srcField: s, tgtField: t, srcSel: s, tgtSel: t,
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

  // R1 — match-key collision detection (child scans only). When two source
  // (or two target) records share the same match-key value, matching is
  // ambiguous: an overwrite/relink/delete could hit the WRONG record. Those
  // rows are excluded from every actionable bucket (they simply don't enter
  // the key indexes below) and counted so the UI can say why. A key that
  // collides on EITHER side is excluded from BOTH sides — half-matched pairs
  // would be just as misleading. Root scans are untouched (v1 behavior).
  let _dupKeys = new Set();
  let _keyCollisions = null;
  if (scope) {
    try {
      // M3a — collision detection runs on the SAME keys the indexes use
      // (sftkMatchKey; normalization included), so "two different raw values
      // that normalize to the same key" counts as a collision too.
      const countKeys = (recs, cfg) => {
        const m = new Map();
        for (const r of recs) {
          const k = sftkMatchKey(r, cfg);
          if (k !== '') m.set(k, (m.get(k) || 0) + 1);
        }
        return m;
      };
      const sCnt = countKeys(srcRes.records || [], srcMatching);
      const tCnt = countKeys(tgtRes.records || [], tgtMatching);
      for (const [k, n] of sCnt) if (n > 1) _dupKeys.add(k);
      for (const [k, n] of tCnt) if (n > 1) _dupKeys.add(k);
      if (_dupKeys.size) {
        let rows = 0;
        for (const [k, n] of sCnt) if (_dupKeys.has(k)) rows += n;
        for (const [k, n] of tCnt) if (_dupKeys.has(k)) rows += n;
        _keyCollisions = { rows, keys: [..._dupKeys].slice(0, 50) };
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
  let _orphanRecs = [];
  if (scope && tgtParentField) {
    try {
      const nullClause = `${tgtParentField} = null`;
      const w = where ? `(${where}) AND ${nullClause}` : nullClause;
      const q = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, tooling: false,
        _suppressError: true,
        query: `SELECT ${fieldList(comparePlan, 'tgt')} FROM ${objType} WHERE ${w} LIMIT 2000` });
      if (q && !q.error) _orphanRecs = (q.records || []).slice(0, 2000);
    } catch (_) { _orphanRecs = []; }
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
  // R3 — append the NULL-link target rows as tagged "possible orphan"
  // extras. They never joined the key match-up above, so every other bucket
  // is exactly what v1 produced.
  let orphanCount = 0;
  if (_orphanRecs.length) {
    try {
      const seenTgt = new Set((tgtRes.records || []).map(r => r.Id));
      for (const tr of _orphanRecs) {
        if (!tr?.Id || seenTgt.has(tr.Id)) continue;
        seenTgt.add(tr.Id);
        const k = sftkMatchKey(tr, tgtMatching);
        onlyInTarget.push({ matchKey: k || '(no key)', targetId: tr.Id, orphan: true });
        orphanCount++;
      }
    } catch (_) { /* degrade — orphans just don't show */ }
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
    // M3c — how many pairs matched from persistent memory (Id-based), this
    // scan's learnable 1:1 pairs, and any degraded-path warnings. All three
    // are absent when memory is empty/unused (legacy shape unchanged).
    ...(memoryMatched ? { memoryMatched } : {}),
    ...(learnedPairs.length ? { learnedPairs } : {}),
    ...(memWarnings.length ? { warnings: memWarnings.slice(0, 10) } : {}),
    compareFields: srcCompare,
    compareFieldsTgt: tgtCompare,
    sourceCount:   srcByKey.size + memoryMatched,
    targetCount:   tgtByKey.size + memoryMatched,
    // Caps to keep chrome.storage payload reasonable on big orgs. The
    // picker only needs source IDs to badge rows, and "extras in target"
    // is just informational for now.
    missingInTarget: missingInTarget.slice(0, 5000),
    onlyInTarget:    onlyInTarget.slice(0, 5000),
    changed:         changed.slice(0, 5000),
    identical:       identical.slice(0, 5000),
    truncated: (
      missingInTarget.length > 5000 ||
      onlyInTarget.length    > 5000 ||
      changed.length         > 5000 ||
      identical.length       > 5000
    ),
    // Set when the dot-path (lookup-by-name) compare 400'd and the scan fell
    // back to the plain plan — lookups are excluded from drift in this result.
    ...(lookupCompareDegraded ? { lookupCompareDegraded: true } : {}),
    // Child-scan extras (absent on root scans).
    ...(scope ? {
      scoped:        true,
      parentField:   scope.parentField,
      linkTrackable,
      linkMismatch:  linkMismatch.slice(0, 2000),
      // R2 — master-detail flags for the parent link field (source describe).
      linkMasterDetail,
      linkUpdateable,
      // R3 — how many NULL-link "possible orphan" rows were appended above.
      ...(orphanCount ? { orphanCount } : {}),
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

  // Keep the in-memory transfer profile aligned, mirroring commitEditingProfile.
  if (_transferProfile && _transferProfile.id === profile.id) _transferProfile = profile;

  showToast(
    `Diff refreshed — ${res.missingInTarget.length} missing, ${res.changed.length} drift, ${res.identical.length} in sync`,
    'success', 4000);
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
    const poly = f.polymorphicForeignKey || (f.referenceTo || []).length > 1;
    // No relationship to traverse, or polymorphic without an explicit match
    // field (parent name field varies per type) → can't safely resolve a name.
    if (!f.relationshipName || (poly && !cfg?.matchField)) { map[f.name] = { skip: true }; continue; }
    map[f.name] = { relName: f.relationshipName, matchField: cfg?.matchField || 'Name' };
  }
  return map;
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
    return { srcRec: s.records?.[0] || null, tgtRec: t.records?.[0] || null, lookupMap };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

// Side-by-side compareField table — highlights rows whose values differ.
// srcFields[i] pairs with tgtFields[i] (pair-aligned, same as snapshot
// captureOrgSnapshot writes them).
function renderDriftCompareTable(srcRec, tgtRec, srcFields, tgtFields, lookupMap = {}) {
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
    const differs = sStr !== tStr;
    // Near-invisible differences get named — "Word of mouth" vs "Word of
    // Mouth" looks identical at a glance but is real drift.
    const subtle = differs && sStr.toLowerCase() === tStr.toLowerCase() ? 'case only'
                 : differs && sStr.trim() === tStr.trim() ? 'whitespace only'
                 : null;
    pairs.push({ srcField: sf, tgtField: tf, srcVal: sStr, tgtVal: tStr, differs, subtle });
  }
  const diffCount = pairs.filter(p => p.differs).length;
  if (!pairs.length) {
    return `<div class="ds-drift-compare-empty">No compareFields configured for this profile — can't show field-by-field diff. Add fields to the Field Mapping on the root node to enable.</div>`;
  }
  return `
    <div class="ds-drift-compare">
      <div class="ds-drift-compare-hdr">${diffCount} of ${pairs.length} field${pairs.length !== 1 ? 's' : ''} differ${diffCount === 1 ? 's' : ''}</div>
      <div class="ds-drift-compare-table">
        <div class="ds-drift-compare-row ds-drift-compare-row-hdr">
          <span class="ds-drift-compare-field">Field</span>
          <span class="ds-drift-compare-val">Source</span>
          <span class="ds-drift-compare-val">Target</span>
        </div>
        ${pairs.map(p => `
          <div class="ds-drift-compare-row${p.differs ? ' ds-drift-compare-row-diff' : ''}${p.note && !p.differs ? ' ds-drift-compare-row-lkp' : ''}">
            <span class="ds-drift-compare-field" title="${p.srcField !== p.tgtField ? esc(p.srcField + ' → ' + p.tgtField) : esc(p.srcField)}">
              ${esc(p.srcField)}${p.srcField !== p.tgtField ? `<span class="ds-drift-compare-rename"> → ${esc(p.tgtField)}</span>` : ''}
              ${p.note ? `<span class="ds-drift-compare-lkptag">${esc(p.note)}</span>` : ''}
              ${p.subtle ? `<span class="ds-drift-compare-lkptag" title="The values differ only subtly — easy to miss by eye">≈ ${esc(p.subtle)}</span>` : ''}
            </span>
            <span class="ds-drift-compare-val">${esc(p.srcVal)}</span>
            <span class="ds-drift-compare-val">${esc(p.tgtVal)}</span>
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

