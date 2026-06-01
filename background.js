const API_VERSION = 'v62.0';

// ── Extension icon click → open / focus the full-page app ─────
// Because manifest.json has no default_popup, clicking the toolbar
// icon fires this listener instead of opening a small popup.
chrome.action.onClicked.addListener(async () => {
  const appUrl = chrome.runtime.getURL('popup.html');

  // If a toolkit tab is already open, bring it to focus instead of opening a second
  const existing = await chrome.tabs.query({ url: appUrl });
  if (existing.length > 0) {
    const tab = existing[0];
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return;
  }

  // Open a new tab with the full-page toolkit
  chrome.tabs.create({ url: appUrl });
});


// Execute a profile transfer between two orgs.
// Returns a summary object for the history log.
async function executeProfileTransfer(profile, srcOrgUrl, srcSid, tgtOrgUrl, tgtSid) {
  const startedAt    = new Date().toISOString();
  const idMap        = {};  // srcId → tgtId (all objects — used for reference field remapping)
  const summary      = {};
  const errors       = [];
  // Separate channel so diagnostic lines aren't truncated by the
  // `errors.slice(0, N)` cap at the bottom — 20 identical "Required fields
  // are missing" rows would otherwise eat the entire window and the diag
  // lines (the things you actually need to read) would never reach the UI.
  // Prepended to `errors` right before returning.
  const diagnostics  = [];

  // Track source IDs fetched per tree node so each child node's WHERE clause
  // only references its direct parent's target IDs.
  // Bug otherwise: in a 3-level tree (e.g. Account → Contact → Task), when Task
  // is processed, Object.values(idMap) would contain both Account AND Contact
  // target IDs, making the WHERE clause wildly over-broad.
  const nodeSourceIds = new Map();

  // Depth-first flattening — every parent is always processed before its children.
  function flattenTree(node, parentNode = null, parentField = null) {
    return [{ node, parentNode, parentField },
      ...(node.children || []).flatMap(c => flattenTree(c, node, c.field))];
  }

  // Guard against a malformed / legacy profile with no tree — flattenTree
  // would otherwise throw on `node.children` of undefined.
  const ordered = profile && profile.tree ? flattenTree(profile.tree) : [];

  for (const { node, parentNode, parentField } of ordered) {
    const objType = node.objectType || node.childSObject;
    try {
      // Build field list from describe
      const descRes = await sfRestGet(srcOrgUrl, srcSid,
        `services/data/${API_VERSION}/sobjects/${objType}/describe`);

      // Hard-fail if the source describe is malformed/empty. Pre-fix this
      // silently returned ['Id'] from buildCopyFields, the SOQL fetched only
      // Id, payload had 0 fields, and every record failed target validation
      // with "Required fields are missing: [LastName]" — looking exactly like
      // a mapping bug when it's actually an upstream describe problem.
      // Diagnose immediately so the operator knows where to look.
      if (!descRes || descRes.error || !Array.isArray(descRes.fields) || descRes.fields.length === 0) {
        const reason = descRes?.error
          || (descRes && !descRes.fields ? 'describe response had no `fields` array' : '')
          || (Array.isArray(descRes?.fields) && descRes.fields.length === 0 ? 'describe returned an empty fields array — usually means the object name is wrong (case-sensitive) or the running user has no FLS' : '')
          || 'unknown describe failure';
        throw new Error(`Source describe for "${objType}" failed: ${reason}. Check that the object exists in the source org and the user has FLS on its fields.`);
      }

      const fields = buildCopyFields(descRes);

      // Target describe — a field that's createable in the SOURCE may not exist
      // (or may be read-only) in the TARGET. Sending such a field fails every
      // INSERT. Build the set of fields the target will actually accept so the
      // payload builder can skip the rest. (This is exactly the gap that lets a
      // dry run pass while the real transfer fails.)
      const tgtDescRes  = await sfRestGet(tgtOrgUrl, tgtSid,
        `services/data/${API_VERSION}/sobjects/${objType}/describe`);
      const tgtCreatable = new Set(
        (tgtDescRes && !tgtDescRes.error ? (tgtDescRes.fields || []) : [])
          .filter(f => f.createable)
          .map(f => f.name)
      );

      // Build SOQL — for child nodes, filter by the PARENT NODE'S target IDs only.
      // Using Object.values(idMap) would mix IDs from sibling object types in
      // deeper trees; instead look up only the records fetched for parentNode.
      //
      // node.recordIds takes priority over node.where: when the user picks a
      // specific record set in the profile builder (the 🎯 "20 selected"
      // chip), we honour their exact selection rather than running the
      // generic WHERE. Pre-2026-05-16 this was ignored — the executor only
      // looked at node.where, so picking specific records did nothing at
      // run time. That bug accounted for "wrong record set transferred"
      // reports including the LastName-missing one.
      const ridList = Array.isArray(node.recordIds) && node.recordIds.length
        ? node.recordIds.filter(Boolean)
        : null;
      const baseWhere = ridList
        ? `Id IN (${ridList.map(id => `'${id}'`).join(',')})`
        : (node.where || '');
      let recs = [];

      if (parentField && parentNode && nodeSourceIds.has(parentNode)) {
        const parentTgtIds = nodeSourceIds.get(parentNode)
          .map(id => idMap[id]).filter(Boolean);

        // If parent node produced zero target IDs (all inserts failed or 0 source
        // records), skip this child entirely — don't fetch without a parent filter.
        if (parentTgtIds.length === 0) {
          nodeSourceIds.set(node, []);
          summary[objType] = { created: 0, failed: 0, skipped: true };
          continue;
        }

        // Chunk parent IDs to keep each SOQL IN clause within safe limits.
        // Salesforce can reject very long IN lists; 200 IDs per chunk is safe.
        const CHUNK = 200;
        for (let ci = 0; ci < parentTgtIds.length; ci += CHUNK) {
          const sliceLiteral = parentTgtIds.slice(ci, ci + CHUNK)
            .map(id => `'${id}'`).join(',');
          const chunkWhere = baseWhere
            ? `(${baseWhere}) AND ${parentField} IN (${sliceLiteral})`
            : `${parentField} IN (${sliceLiteral})`;
          // ORDER BY Id ensures deterministic pagination across large result sets
          const chunkSoql = `SELECT ${fields.join(',')} FROM ${objType} WHERE ${chunkWhere} ORDER BY Id`;
          const chunkRes  = await sfQueryAll(srcOrgUrl, srcSid, chunkSoql, false);
          recs = recs.concat(chunkRes.records || []);
        }

        // Deduplicate in case the same record matches multiple parent chunks
        const seen = new Set();
        recs = recs.filter(r => { if (seen.has(r.Id)) return false; seen.add(r.Id); return true; });
      } else {
        // Root node — no parent filter.
        // ORDER BY Id ensures deterministic pagination across large result sets.
        const soql = `SELECT ${fields.join(',')} FROM ${objType}${baseWhere ? ' WHERE ' + baseWhere : ''} ORDER BY Id`;
        const qRes  = await sfQueryAll(srcOrgUrl, srcSid, soql, false);
        recs = qRes.records || [];
      }

      // Store this node's source IDs so its children can build correct WHERE clauses
      nodeSourceIds.set(node, recs.map(r => r.Id));

      // ── Resolve RecordTypes ──────────────────────────────────────────────
      // Match source → target RecordType by DeveloperName (API name) — the only
      // stable cross-org key (the 18-char Id differs per org). A matched RT is
      // applied to the insert; an UNMATCHED source RT is surfaced as a warning
      // so the user knows those records fell back to the target's default RT
      // (rather than it happening silently).
      const rtIds = [...new Set(recs.map(r => r.RecordTypeId).filter(Boolean))];
      const rtMap = {};
      if (rtIds.length) {
        const srcRt = await sfQuery(srcOrgUrl, srcSid,
          `SELECT Id, DeveloperName FROM RecordType WHERE Id IN (${rtIds.map(id=>`'${id}'`).join(',')})`, false);
        const tgtRt = await sfQuery(tgtOrgUrl, tgtSid,
          `SELECT Id, DeveloperName FROM RecordType WHERE SObjectType = '${objType}'`, false);
        const tgtMap = {};
        for (const r of (tgtRt.records || [])) tgtMap[r.DeveloperName] = r.Id;
        const unmatchedRt = [];
        for (const r of (srcRt.records || [])) {
          const tgtRtId = tgtMap[r.DeveloperName] || null;
          rtMap[r.Id] = tgtRtId;
          if (!tgtRtId) unmatchedRt.push(r.DeveloperName);
        }
        if (unmatchedRt.length) {
          errors.push(`${objType}: record type(s) ${unmatchedRt.join(', ')} have no match in the target org — those records use the target's default record type.`);
        }
      }

      // ── Lookup Resolution bridges ─────────────────────────────────────────
      // For each reference field configured with strategy 'match', build a
      // srcId → tgtId bridge by querying both orgs on a shared anchor field.
      // Priority order in payload builder: idMap > lkpBridges > strategy fallback.
      const lkpBridges = {};  // { fieldName: Map(srcId → tgtId) }

      if (node.lookupResolutions && recs.length > 0) {
        for (const [fieldName, res] of Object.entries(node.lookupResolutions)) {
          if (res.strategy !== 'match') continue;
          if (!res.matchField || !res.matchObject) continue;

          // 1. Collect unique source record IDs for this lookup field
          const srcIds = [...new Set(
            recs.map(r => r[fieldName]).filter(v => v && typeof v === 'string')
          )];
          if (!srcIds.length) continue;

          // 2. Query SOURCE for anchor values: srcId → anchorValue
          const CHUNK = 200;
          const srcAnchorMap = new Map();
          for (let ci = 0; ci < srcIds.length; ci += CHUNK) {
            const idList = srcIds.slice(ci, ci + CHUNK).map(id => `'${id}'`).join(',');
            const srcQ = await sfQueryAll(srcOrgUrl, srcSid,
              `SELECT Id, ${res.matchField} FROM ${res.matchObject} WHERE Id IN (${idList})`, false);
            for (const r of (srcQ.records || [])) {
              if (r[res.matchField] != null) srcAnchorMap.set(r.Id, r[res.matchField]);
            }
          }
          if (!srcAnchorMap.size) continue;

          // 3. Query TARGET for matching records: anchorValue → tgtId
          //    Only keep the FIRST match if duplicates exist (deterministic)
          const anchorValues = [...new Set(srcAnchorMap.values())];
          const VAL_CHUNK = 100;
          const tgtAnchorMap = new Map();
          for (let ci = 0; ci < anchorValues.length; ci += VAL_CHUNK) {
            const valList = anchorValues.slice(ci, ci + VAL_CHUNK)
              .map(v => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
              .join(',');
            const tgtQ = await sfQueryAll(tgtOrgUrl, tgtSid,
              `SELECT Id, ${res.matchField} FROM ${res.matchObject} WHERE ${res.matchField} IN (${valList})`, false);
            for (const r of (tgtQ.records || [])) {
              // First match wins (avoids non-deterministic overwrite)
              if (r[res.matchField] != null && !tgtAnchorMap.has(r[res.matchField])) {
                tgtAnchorMap.set(r[res.matchField], r.Id);
              }
            }
          }

          // 4. Build bridge: srcId → tgtId (via shared anchor value)
          const bridge = new Map();
          for (const [srcId, anchorVal] of srcAnchorMap) {
            const tgtId = tgtAnchorMap.get(anchorVal);
            if (tgtId) bridge.set(srcId, tgtId);
          }
          lkpBridges[fieldName] = bridge;

          // Log partial resolution warnings
          const matched = bridge.size;
          const total   = srcIds.length;
          if (matched < total) {
            errors.push(
              `${objType}.${fieldName}: ${matched}/${total} lookups resolved via ` +
              `${res.matchObject}.${res.matchField} — ${total - matched} record(s) will have null ${fieldName}`
            );
          }
        }
      }

      // Fields the source has but the target can't accept — collected once for
      // reporting (so a partial/empty copy isn't a mystery).
      const skippedForTarget = new Set();

      // ── Build payloads with field mapping ────────────────────────────────
      const payloads = recs.map(r => {
        const p = {};
        for (const f of (descRes.fields || [])) {
          if (!f.createable) continue;
          if (['Id','CreatedDate','LastModifiedDate','SystemModstamp',
               'CreatedById','LastModifiedById','IsDeleted','OwnerId'].includes(f.name)) continue;
          const v = r[f.name];
          if (v == null) continue;
          if (f.name === 'RecordTypeId') { if (rtMap[v]) p.RecordTypeId = rtMap[v]; continue; }
          // Apply field name mapping: source field → target field name
          // null = field explicitly excluded by user → skip it entirely
          if (node.fieldMappings && f.name in node.fieldMappings && node.fieldMappings[f.name] === null) continue;
          const tgtField = node.fieldMappings?.[f.name] ?? f.name;
          // Skip fields the target org won't accept (missing field, read-only
          // there). Without this, one such field fails every INSERT — the exact
          // "dry run passes, real transfer fails" case. If the target describe
          // failed to load, tgtCreatable is empty → keep all fields (best effort).
          if (tgtCreatable.size && !tgtCreatable.has(tgtField)) { skippedForTarget.add(tgtField); continue; }
          if (f.type === 'reference') {
            // Priority 1: idMap — record was transferred earlier in this same session
            if (idMap[v]) { p[tgtField] = idMap[v]; continue; }
            // Priority 2: lookup resolution bridge (skip / match by field)
            const lkpRes = node.lookupResolutions?.[f.name];
            if (lkpRes?.strategy === 'match' && lkpBridges[f.name]?.has(v)) {
              p[tgtField] = lkpBridges[f.name].get(v);
            }
            // skip / no config / legacy passthrough → field omitted — safe default
            continue;
          }
          p[tgtField] = v;
        }
        return p;
      });

      // ── Batch create (200 records/batch, allOrNone:false) ────────────────
      let ok = 0, fail = 0;
      // Track which SOURCE record IDs succeeded — surfaced in the per-node
      // summary so the Pick-Records modal can badge already-deployed
      // records and avoid the "did this go through?" guesswork.
      const transferredSourceIds = [];
      // Mirror for failures — drives the "↻ Retry failed (N)" button on
      // History rows. Each entry carries the source ID + first error msg
      // so the UI can show what went wrong per row.
      const failedSourceIds = [];        // [{ id, error }]
      let reqMissingDiagPushed = false; // emit the payload-keys diag only once per node
      // Upsert mode (v1): applies to the ROOT object only, keyed by an
      // external-Id field. When on, existing target records (matched on that
      // field) are UPDATED instead of duplicated; new ones are inserted.
      const useUpsert   = !!(profile.upsert?.field) && node === profile.tree;
      const upsertField = useUpsert ? profile.upsert.field : null;
      for (let i = 0; i < payloads.length; i += 200) {
        const chunk = payloads.slice(i, i + 200).map((p, k) => {
          const rec = { attributes: { type: objType }, ...p };
          // The external-Id value must be present for Salesforce to match on
          // upsert — inject it from the source record if the mapping dropped it.
          if (useUpsert && upsertField) {
            const v = recs[i + k]?.[upsertField];
            if (v != null) rec[upsertField] = v;
          }
          return rec;
        });
        const res     = useUpsert
          ? await sfCollectionsUpsert(tgtOrgUrl, tgtSid, objType, upsertField, chunk)
          : await sfCollectionsCreate(tgtOrgUrl, tgtSid, chunk);
        const results = Array.isArray(res) ? res : [];
        results.forEach((result, j) => {
          if (result.success) {
            idMap[recs[i + j].Id] = result.id; ok++;
            transferredSourceIds.push(recs[i + j].Id);
          }
          else {
            fail++;
            const msg = (result.errors || []).map(e => e.message).join('; ');
            errors.push(`${objType}: ${msg}`);
            failedSourceIds.push({ id: recs[i + j].Id, error: msg });
            // When a record fails with "Required fields are missing" the user
            // almost always thinks "but my mapping IS correct" — log once which
            // fields actually went out, so the mismatch is obvious.
            const isReqMissing = (result.errors || []).some(e =>
              e.statusCode === 'REQUIRED_FIELD_MISSING' || /required fields are missing/i.test(e.message || '')
            );
            if (isReqMissing && !reqMissingDiagPushed) {
              const samplePayload = payloads[i + j] || {};
              const sentKeys      = Object.keys(samplePayload).sort();
              const sampleRec     = recs[i + j] || {};
              const missingNames  = [];
              for (const e of (result.errors || [])) {
                const m = /missing:\s*\[([^\]]+)\]/i.exec(e.message || '');
                if (m) missingNames.push(...m[1].split(',').map(s => s.trim()));
              }

              diagnostics.push(
                `${objType} diag: payload sent ${sentKeys.length} field(s) → ` +
                `[${sentKeys.slice(0, 25).join(', ')}${sentKeys.length > 25 ? '…' : ''}]` +
                (skippedForTarget.size
                  ? ` — skipped (not writable in target): [${[...skippedForTarget].slice(0, 10).join(', ')}]`
                  : '')
              );

              for (const missing of missingNames) {
                let srcFieldForMissing = null;
                if (node.fieldMappings) {
                  for (const [s, t] of Object.entries(node.fieldMappings)) {
                    if (t === missing) { srcFieldForMissing = s; break; }
                  }
                }
                if (!srcFieldForMissing) srcFieldForMissing = missing;

                const srcVal       = sampleRec[srcFieldForMissing];
                const inTgtCreate  = tgtCreatable.has(missing);
                const explicitNull = node.fieldMappings && node.fieldMappings[srcFieldForMissing] === null;
                const inSentKeys   = sentKeys.includes(missing);

                let reason;
                if (inSentKeys) {
                  reason = `payload INCLUDED ${missing}=${JSON.stringify(srcVal)} — target rejected anyway (validation rule? person-account override? required-criteria-based field?)`;
                } else if (explicitNull) {
                  reason = `field mapping for source.${srcFieldForMissing} is "Set null" — change it to identity passthrough`;
                } else if (!inTgtCreate) {
                  reason = `target says ${missing} is not createable for this user. Check FLS + Profile/PermSet on target org.`;
                } else if (srcVal == null || srcVal === '') {
                  reason = `source.${srcFieldForMissing} is ${JSON.stringify(srcVal)} for at least one record — the executor drops null values before send. Source records lack this field's value.`;
                } else {
                  reason = `source.${srcFieldForMissing}=${JSON.stringify(srcVal)} — but field wasn't sent. Likely a SKIP-set or non-createable filter in buildCopyFields.`;
                }
                diagnostics.push(`${objType} diag · ${missing}: ${reason}`);
              }
              reqMissingDiagPushed = true;
            }
          }
        });
      }
      summary[objType] = { created: ok, failed: fail };
      // Source IDs that successfully inserted in target — cap at 2000 to keep
      // chrome.storage payloads sane on huge transfers. The picker reads this
      // to badge already-deployed records.
      if (transferredSourceIds.length) {
        summary[objType].transferredSourceIds = transferredSourceIds.slice(0, 2000);
      }
      // Failed source IDs — drives the "↻ Retry failed" button on History
      // rows. Cap at 2000 entries; each is { id, error } so the UI can show
      // both the record reference and what went wrong.
      if (failedSourceIds.length) {
        summary[objType].failedSourceIds = failedSourceIds.slice(0, 2000);
      }
      if (skippedForTarget.size) {
        // Non-fatal: surfaced in the result so the UI can show what was skipped,
        // without marking the whole transfer as failed/partial.
        summary[objType].skippedFields = [...skippedForTarget];
      }
    } catch (e) {
      nodeSourceIds.set(node, []);  // prevent children from using a broken parent
      errors.push(`${objType}: ${e.message}`);
      summary[objType] = { created: 0, failed: 0, error: e.message };
    }
  }

  // Dedupe identical per-record errors — 20 contacts that all fail with
  // "Required fields are missing: [LastName]" should show ONE row + a count,
  // not 20 identical lines that eat the visible error window.
  const dedupedErrors = [];
  const seen = new Map();   // msg → count
  for (const e of errors) {
    const prev = seen.get(e) || 0;
    seen.set(e, prev + 1);
    if (prev === 0) dedupedErrors.push(e);
  }
  // Annotate the high-count messages so the user knows it wasn't a one-off.
  for (let i = 0; i < dedupedErrors.length; i++) {
    const c = seen.get(dedupedErrors[i]) || 1;
    if (c > 1) dedupedErrors[i] = `${dedupedErrors[i]}  (×${c})`;
  }

  // Diagnostics first — they're the actionable bit. With slice(0, 50) below,
  // any dedupedErrors that exceed the cap get trimmed, but diagnostics
  // remain visible regardless.
  const finalErrors = [...diagnostics, ...dedupedErrors];

  return {
    profileId: profile.id, profileName: profile.name,
    startedAt, completedAt: new Date().toISOString(),
    sourceOrg: srcOrgUrl, targetOrg: tgtOrgUrl,
    status: errors.length === 0 ? 'success' : (Object.values(summary).some(s=>s.created>0) ? 'partial' : 'failed'),
    summary, errors: finalErrors.slice(0, 50)
  };
}

function buildCopyFields(describe) {
  if (!describe?.fields) return ['Id'];
  // These fields are either read-only, system-managed, or we deliberately don't
  // copy them (OwnerId: owner in source org won't exist in target — Salesforce
  // defaults to the running user, which is the correct behaviour).
  const SKIP = new Set([
    'Id','CreatedDate','LastModifiedDate','SystemModstamp',
    'CreatedById','LastModifiedById','IsDeleted','OwnerId',
    'LastActivityDate','LastViewedDate','LastReferencedDate',
    'MasterRecordId','IsArchived'
  ]);
  return ['Id', ...describe.fields
    .filter(f => f.accessible && !SKIP.has(f.name) &&
      (f.createable || f.type === 'reference'))
    .map(f => f.name)];
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch(err => {
    const resp = { error: err.message || String(err) };
    if (err.sfBody) resp.sfBody = err.sfBody;  // include raw SF 401 body for diagnostics
    sendResponse(resp);
  });
  return true;
});

async function handleMessage(message) {
  try {
    return await dispatchMessage(message);
  } catch (e) {
    // ── Last-chance cookie re-check ──────────────────────────────────────────
    // sfFetchWithProxy already reads the freshest cookie before its first
    // request.  This second read catches the rare race where Lightning rotated
    // the cookie DURING the network round-trip (typically 1-2 s).
    // If that gives a genuinely different sid, retry the whole message once.
    // No tab reload — ever.  The chrome.cookies.onChanged listener handles
    // passive reconnect when the user's SF tab refreshes on its own.
    if (e.message === 'SESSION_EXPIRED' && message.type !== 'GET_SF_SESSION') {
      let fresh;
      try { fresh = await getSfSession(message.orgUrl || null); } catch (_) {}

      if (fresh?.sid && fresh?.orgUrl && fresh.sid !== (message.sid || '')) {
        return dispatchMessage({ ...message, orgUrl: fresh.orgUrl, sid: fresh.sid });
      }
    }
    throw e;
  }
}

async function dispatchMessage(message) {
  const { type, orgUrl, sid } = message;

  switch (type) {
    case 'GET_SF_SESSION':
      return getSfSession(message.activeTabUrl || null);
    case 'SF_QUERY':
      return sfQuery(orgUrl, sid, message.query, message.tooling !== false);
    case 'SF_QUERY_ALL':
      return sfQueryAll(orgUrl, sid, message.query, message.tooling !== false);
    case 'SF_TOOLING_DELETE':
      return sfDelete(orgUrl, sid, `services/data/${API_VERSION}/tooling/sobjects/${message.sobject}/${message.id}`);
    case 'SF_REST_DELETE':
      return sfDelete(orgUrl, sid, `services/data/${API_VERSION}/sobjects/${message.sobject}/${message.id}`);
    case 'SF_GET_METADATA':
      return sfGetMetadata(orgUrl, sid, message.id);
    case 'SF_TOOLING_GET':
      return sfToolingGet(orgUrl, sid, message.sobject, message.id);
    case 'SF_CREATE_FLOW':
      return sfCreateFlow(orgUrl, sid, message.fullName, message.metadata);
    case 'SF_PATCH':
      return sfPatch(orgUrl, sid, message.path, message.body);
    case 'SF_REST_POST':
      return sfPost(orgUrl, sid, message.path, message.body);
    case 'SF_REST_QUERY':
      return sfQuery(orgUrl, sid, message.query, false);
    case 'SF_METADATA_DEPLOY':
      return sfMetadataDeploy(orgUrl, sid, message.zipBase64);
    case 'SF_REST_GET':
      return sfRestGet(orgUrl, sid, message.path);
    case 'SF_REST_GET_TEXT':
      return sfRestGetText(orgUrl, sid, message.path);
    case 'GET_ALL_SF_SESSIONS':
      return getAllSfSessions();
    case 'SF_COLLECTIONS_CREATE':
      return sfCollectionsCreate(orgUrl, sid, message.records);
    case 'SF_COLLECTIONS_DELETE':
      return sfCollectionsDelete(orgUrl, sid, message.ids);
    case 'SF_HARD_DELETE':
      return sfHardDelete(orgUrl, sid, message.ids);
    case 'SF_COLLECTIONS_UPDATE':
      return sfCollectionsUpdate(orgUrl, sid, message.records);
    case 'SF_EXECUTE_PROFILE_TRANSFER':
      return executeProfileTransfer(
        message.profile,
        message.srcOrgUrl, message.srcSid,
        message.tgtOrgUrl, message.tgtSid
      );
    case 'SF_RELATIONSHIP_QUERY':
      return sfRelationshipQuery(orgUrl, sid, message.rootObject, message.rootWhere,
        message.childRels, message.limit);
    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}


async function sfFetch(url, options, retries = 1) {
  // 30-second timeout per individual HTTP request — prevents any single fetch
  // from hanging indefinitely (e.g. slow Metadata Deploy status polls).
  const withTimeout = (opts) => ({ ...opts, signal: AbortSignal.timeout(30000) });
  let res;
  try {
    res = await fetch(url, withTimeout(options));
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new Error(`Request timed out after 30 s — URL: ${url}`);
    }
    throw e;
  }
  if (res.status >= 500 && retries > 0) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      res = await fetch(url, withTimeout(options));
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        throw new Error(`Retry timed out after 30 s — URL: ${url}`);
      }
      throw e;
    }
  }
  return res;
}

function authHeaders(sid) {
  return {
    'Authorization': `Bearer ${sid}`,
    'Content-Type': 'application/json'
  };
}

// ── Browser-session proxy ───────────────────────────────────────────────────
// When the Bearer-token API call returns 401 (stale or Lightning-only token),
// sfFetchWithProxy falls back to sfProxyFetch which routes the request through
// the user's active Salesforce tab via chrome.scripting.executeScript.
// The injected function runs in the SF page context so the browser attaches
// the real session cookies automatically — no sid needed.
//
// sfProxyFetch — routes any HTTP call through the user's live SF browser tab.
// Supports GET, POST, PATCH, DELETE and an optional pre-serialised body string.
// Returns { status, ok, body } (body is raw text) or null if no tab is usable.
async function sfProxyFetch(orgUrl, targetUrl, method = 'GET', bodyStr = null) {
  const SF_GLOBS = [
    'https://*.salesforce.com/*',
    'https://*.lightning.force.com/*',
    'https://*.salesforce-setup.com/*',
    'https://*.force.com/*'
  ];
  const allTabs = (await chrome.tabs.query({ url: SF_GLOBS }))
    .filter(t => t.url && isSalesforceUrl(t.url));  // exclude trailhead, login, developer.sf.com, etc.
  if (!allTabs.length) return null;

  // Prefer tabs from the same org (matching subdomain slug).
  // Tab ranking (higher = tried first):
  //   1. Same org slug AND same origin as the target URL  (same-origin → no CORS)
  //   2. Same org slug AND my.salesforce.com              (API domain → no CORS for Tooling)
  //   3. Same org slug AND other SF domain                (cross-origin, may hit CORS)
  //   4. Different org, non-setup                         (last resort)
  //   5. Setup-domain tabs                                (highest CORS risk)
  //
  // Why this matters: Tooling API lives at my.salesforce.com.  When injected into a
  // lightning.force.com tab, the fetch is cross-origin.  Salesforce may not return
  // Access-Control-Allow-Origin for extension-injected scripts, causing the browser
  // to block the response even though the session cookies ARE valid.  Injecting into
  // a my.salesforce.com tab makes the fetch same-origin, bypassing CORS entirely.
  const orgSlug    = new URL(orgUrl).hostname.split('.')[0];
  const targetHost = (() => { try { return new URL(targetUrl).hostname; } catch(_) { return ''; } })();

  allTabs.sort((a, b) => {
    const aMatch  = a.url?.includes(orgSlug) ? 1 : 0;
    const bMatch  = b.url?.includes(orgSlug) ? 1 : 0;
    if (bMatch !== aMatch) return bMatch - aMatch;
    // Same-origin tabs rank highest — no CORS overhead at all
    const aHost = (() => { try { return a.url ? new URL(a.url).hostname : ''; } catch(_) { return ''; } })();
    const bHost = (() => { try { return b.url ? new URL(b.url).hostname : ''; } catch(_) { return ''; } })();
    const aSameOrigin = (targetHost && aHost === targetHost) ? 1 : 0;
    const bSameOrigin = (targetHost && bHost === targetHost) ? 1 : 0;
    if (aSameOrigin !== bSameOrigin) return bSameOrigin - aSameOrigin;
    // my.salesforce.com tabs next — API domain, handles Tooling API without CORS
    const aApi = aHost.includes('.my.salesforce.com') ? 1 : 0;
    const bApi = bHost.includes('.my.salesforce.com') ? 1 : 0;
    if (aApi !== bApi) return bApi - aApi;
    // Setup-domain tabs last (highest CORS risk, different cookie domain)
    const aSetup = aHost.includes('.salesforce-setup.com') ? 1 : 0;
    const bSetup = bHost.includes('.salesforce-setup.com') ? 1 : 0;
    if (aSetup !== bSetup) return aSetup - bSetup;
    return (b.lastAccessed || 0) - (a.lastAccessed || 0);
  });

  for (const tab of allTabs.slice(0, 3)) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async (url, method, bodyStr) => {
          try {
            const opts = {
              method,
              credentials: 'include',
              headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
            };
            if (bodyStr !== null) opts.body = bodyStr;
            const r = await fetch(url, opts);
            return { status: r.status, ok: r.ok, body: await r.text() };
          } catch (e) {
            return { error: e.message };
          }
        },
        args: [targetUrl, method, bodyStr]
      });
      const result = results?.[0]?.result;
      if (result && !result.error) return result;
    } catch (_) {
      // Tab not injectable (e.g. chrome:// page) — try next
    }
  }
  return null;
}

// ── Unified fetch-with-proxy ────────────────────────────────────────────────
// Inspector-style auth: always read the freshest sid cookie before every call.
// chrome.cookies.getAll() is a local browser call (~1 ms) so reading it before
// each request adds negligible latency but guarantees we never send a stale
// Bearer token — the same reason SF Inspector / SF Lightning Inspector never
// lose connection.
//
// Tier summary:
//   1. Bearer with freshest cookie sid (handles Lightning token rotation)
//   2. Proxy via live SF tab with credentials:include (handles edge cases where
//      the cookie read returned a different-but-also-stale value)
//   → SESSION_EXPIRED only if the browser session is truly gone
//
// Returns { ok, status, body } where body is raw response text.
// Throws Error('SESSION_EXPIRED') if all tiers fail.
async function sfFetchWithProxy(orgUrl, sid, url, fetchOptions = {}) {
  const method  = fetchOptions.method || 'GET';
  const bodyStr = fetchOptions.body   ?? null;

  // ── Tier 1: always-fresh Bearer ──────────────────────────────────────────
  // Read the current sid cookie right now (not the value cached at startup).
  // If Lightning rotated it since the last call, we pick up the new value here
  // without ever needing a retry round-trip.
  //
  // IMPORTANT: only use the refreshed SID if getSfSession returned a session
  // for the SAME org we're querying.  When the user has switched to an org
  // that doesn't have an open browser tab, getSfSession falls back to whatever
  // SF tab happens to be open (could be a completely different org).  Using
  // that wrong SID would cause a 401 and then a proxy failure.  Instead we
  // keep the caller-supplied SID — which was captured directly from the org's
  // cookie when the session dropdown was built and is still valid.
  // Normalise an org URL to a canonical API origin for comparison.
  // Treats lightning.force.com ↔ my.salesforce.com and
  // salesforce-setup.com ↔ salesforce.com as the same org.
  const normApiOrigin = u => {
    try {
      const h = new URL(u).hostname
        .replace('.lightning.force.com', '.my.salesforce.com')
        .replace('.salesforce-setup.com', '.salesforce.com');
      return `https://${h}`;
    } catch(_) { return (u||'').toLowerCase(); }
  };
  let activeSid = sid;
  try {
    const fresh = await getSfSession(orgUrl);
    if (fresh?.sid && normApiOrigin(fresh.orgUrl) === normApiOrigin(orgUrl)) {
      activeSid = fresh.sid;
    }
  } catch (_) { /* keep caller-supplied sid */ }

  const res = await sfFetch(url, { ...fetchOptions, headers: authHeaders(activeSid) });
  if (res.status !== 401) {
    return { ok: res.ok, status: res.status, body: await res.text() };
  }

  // ── Tier 2: proxy via live SF tab ────────────────────────────────────────
  // The Bearer was rejected (session expired server-side or mid-rotation race).
  // Route the exact same call through the user's open Salesforce browser tab
  // using credentials:include so the browser attaches the tab's current session
  // cookies directly — no sid needed.
  const proxy = await sfProxyFetch(orgUrl, url, method, bodyStr);
  if (proxy && !proxy.error && proxy.status !== 401) return proxy;

  // ── Tier 3: all paths failed ─────────────────────────────────────────────
  // Browser session is fully expired (both Bearer AND tab cookies are invalid).
  // Surface SESSION_EXPIRED; the cookies.onChanged listener will auto-reconnect
  // the popup as soon as the user navigates in their Salesforce tab.
  const err = new Error('SESSION_EXPIRED');
  if (proxy?.body) err.sfBody = proxy.body.substring(0, 500);
  throw err;
}

// Synchronous error-message builder for already-read response bodies.
// Mirrors the async sfErrorText() but works on the text string directly.
function sfErrorMsg(status, body, url) {
  if (!body) return `HTTP ${status} (empty response) — URL: ${url}`;
  try {
    const parsed = JSON.parse(body);
    const msg = Array.isArray(parsed) ? parsed[0]?.message : parsed?.message;
    if (msg) return `HTTP ${status}: ${msg}`;
  } catch (_) {}
  return `HTTP ${status}: ${body.slice(0, 300)}`;
}

// Normalise any hard-coded API version in a path string so all requests
// consistently use the single API_VERSION constant defined at the top.
function normalizePath(path) {
  return path.replace(/services\/data\/v[\d.]+\//gi, `services/data/${API_VERSION}/`);
}

async function sfQuery(orgUrl, sid, query, tooling = true) {
  const base = tooling ? `services/data/${API_VERSION}/tooling` : `services/data/${API_VERSION}`;
  const url = `${orgUrl}/${base}/query?q=${encodeURIComponent(query)}`;
  const { ok, status, body } = await sfFetchWithProxy(orgUrl, sid, url);
  if (!ok) throw new Error(sfErrorMsg(status, body, url));
  return JSON.parse(body);
}

async function sfQueryAll(orgUrl, sid, query, tooling = true) {
  const base = tooling ? `services/data/${API_VERSION}/tooling` : `services/data/${API_VERSION}`;
  let url = `${orgUrl}/${base}/query?q=${encodeURIComponent(query)}`;
  let records = [];

  while (url) {
    // sfFetchWithProxy handles Bearer → proxy fallback transparently
    const { ok, status, body } = await sfFetchWithProxy(orgUrl, sid, url);
    if (!ok) throw new Error(sfErrorMsg(status, body, url));
    const data = JSON.parse(body);
    records = records.concat(data.records || []);
    url = data.nextRecordsUrl ? `${orgUrl}${data.nextRecordsUrl}` : null;
  }

  return { records, totalSize: records.length, done: true };
}

async function sfErrorText(res, url) {
  let body = '';
  try { body = await res.text(); } catch (_) {}
  if (!body) return `HTTP ${res.status} (empty response) — URL: ${url}`;
  try {
    const parsed = JSON.parse(body);
    const msg = Array.isArray(parsed) ? parsed[0]?.message : parsed?.message;
    if (msg) return `HTTP ${res.status}: ${msg}`;
  } catch (_) {}
  return `HTTP ${res.status}: ${body.slice(0, 300)}`;
}

async function sfDelete(orgUrl, sid, path) {
  const url = `${orgUrl}/${path}`;
  const { ok, body } = await sfFetchWithProxy(orgUrl, sid, url, { method: 'DELETE' });
  if (ok) return { success: true };  // 200 or 204
  let parsed;
  try { parsed = JSON.parse(body); } catch (_) { parsed = body; }
  if (Array.isArray(parsed) && parsed[0]?.errorCode === 'CANNOT_DELETE_MANAGED_COMPONENT') {
    throw new Error('CANNOT_DELETE_MANAGED_COMPONENT');
  }
  throw new Error(typeof parsed === 'string' ? parsed : JSON.stringify(parsed));
}

async function sfGetMetadata(orgUrl, sid, id) {
  const url = `${orgUrl}/services/data/${API_VERSION}/tooling/sobjects/Flow/${id}`;
  const { ok, status, body } = await sfFetchWithProxy(orgUrl, sid, url);
  if (!ok) throw new Error(sfErrorMsg(status, body, url));
  return JSON.parse(body);
}

async function sfRestGet(orgUrl, sid, path) {
  const url = `${orgUrl}/${normalizePath(path)}`;
  const { ok, status, body } = await sfFetchWithProxy(orgUrl, sid, url);
  if (!ok) throw new Error(sfErrorMsg(status, body, url));
  return JSON.parse(body);
}

// Like sfRestGet but returns raw text — used for ApexLog body (plain text, not JSON).
async function sfRestGetText(orgUrl, sid, path) {
  const url = `${orgUrl}/${normalizePath(path)}`;
  const { ok, status, body } = await sfFetchWithProxy(orgUrl, sid, url);
  if (!ok) throw new Error(sfErrorMsg(status, body, url));
  return { text: body };
}

async function sfToolingGet(orgUrl, sid, sobject, id) {
  const url = `${orgUrl}/services/data/${API_VERSION}/tooling/sobjects/${sobject}/${id}`;
  const { ok, status, body } = await sfFetchWithProxy(orgUrl, sid, url);
  if (!ok) throw new Error(sfErrorMsg(status, body, url));
  return JSON.parse(body);
}

async function sfCreateFlow(orgUrl, sid, fullName, metadata) {
  const url = `${orgUrl}/services/data/${API_VERSION}/tooling/sobjects/Flow`;
  const bodyStr = JSON.stringify({ FullName: fullName, Metadata: metadata });
  const { ok, status, body } = await sfFetchWithProxy(orgUrl, sid, url, {
    method: 'POST',
    body: bodyStr
  });
  if (ok) {
    const data = JSON.parse(body);
    return { success: true, id: data.id };
  }
  throw new Error(sfErrorMsg(status, body, url));
}

async function sfPost(orgUrl, sid, path, payload) {
  const url = `${orgUrl}/${normalizePath(path)}`;
  const bodyStr = JSON.stringify(payload);
  const { ok, status, body } = await sfFetchWithProxy(orgUrl, sid, url, {
    method: 'POST',
    body: bodyStr
  });
  if (ok) {
    let data = {};
    try { data = body ? JSON.parse(body) : {}; } catch (_) {}
    return { success: true, ...data };
  }
  throw new Error(sfErrorMsg(status, body, url));
}

async function sfPatch(orgUrl, sid, path, payload) {
  const url = `${orgUrl}/${normalizePath(path)}`;
  const bodyStr = JSON.stringify(payload);
  const { ok, status, body } = await sfFetchWithProxy(orgUrl, sid, url, {
    method: 'PATCH',
    body: bodyStr
  });
  if (ok) return { success: true };
  throw new Error(sfErrorMsg(status, body, url));
}

// ── Metadata Deploy (REST-based, v38+) ─────────────────────────
// The REST deployRequest endpoint requires multipart/form-data —
// NOT a JSON body with a "zipFile" field (that is the SOAP API format).
async function sfMetadataDeploy(orgUrl, sid, zipBase64) {
  // Decode base64 → raw bytes
  const binaryStr = atob(zipBase64);
  const zipBytes  = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) zipBytes[i] = binaryStr.charCodeAt(i);

  const boundary = '----SFToolkitBoundary' + Math.random().toString(36).slice(2);
  const enc      = new TextEncoder();

  const optionsJson = JSON.stringify({
    deployOptions: {
      allowMissingFiles: false,
      checkOnly:         false,
      ignoreWarnings:    true,
      rollbackOnError:   true,
      singlePackage:     true,
      testLevel:         'NoTestRun'
    }
  });

  // Build multipart/form-data body manually
  const p1Hdr  = enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="json"\r\nContent-Type: application/json\r\n\r\n`);
  const p1Body = enc.encode(optionsJson);
  const p2Hdr  = enc.encode(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="deploy.zip"\r\nContent-Type: application/zip\r\n\r\n`);
  const close  = enc.encode(`\r\n--${boundary}--\r\n`);

  const multipart = new Uint8Array(p1Hdr.length + p1Body.length + p2Hdr.length + zipBytes.length + close.length);
  let pos = 0;
  for (const chunk of [p1Hdr, p1Body, p2Hdr, zipBytes, close]) { multipart.set(chunk, pos); pos += chunk.length; }

  // 1. Kick off the deployment
  const deployUrl = `${orgUrl}/services/data/${API_VERSION}/metadata/deployRequest`;
  const deployRes = await sfFetch(deployUrl, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${sid}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body:    multipart
  });
  if (deployRes.status === 401) throw new Error('SESSION_EXPIRED');
  if (!deployRes.ok) throw new Error(await sfErrorText(deployRes, deployUrl));

  const { id: jobId } = await deployRes.json();

  // 2. Poll until done (max ~100 s)
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const statusUrl = `${orgUrl}/services/data/${API_VERSION}/metadata/deployRequest/${jobId}?includeDetails=true`;
    const statusRes = await sfFetch(statusUrl, { headers: authHeaders(sid) });
    if (statusRes.status === 401) throw new Error('SESSION_EXPIRED');
    if (!statusRes.ok) throw new Error(await sfErrorText(statusRes, statusUrl));

    const payload      = await statusRes.json();
    const deployResult = payload.deployResult || payload;

    if (deployResult.done) {
      if (deployResult.success) return { success: true };
      const failures = deployResult.details?.componentFailures || [];
      const msg = failures.map(f => f.problem).filter(Boolean).join('; ')
                  || deployResult.errorMessage
                  || 'Deployment failed';
      throw new Error(msg);
    }
  }
  throw new Error('Deployment timed out after 100 seconds');
}

// ---------------------------------------------------------------
// Relationship Query — executes one SOQL SELECT with up to 5 child
// subqueries (1-level deep, Salesforce limit) and returns structured counts.
//
// childRels: [{ relationshipName, where? }]  e.g. [{relationshipName:'Contacts'}]
// limit:     max parent records to fetch (default 200, cap 2000)
//
// Returns:
//   { parentCount, childCounts: { [relationshipName]: number }, error? }
//
// The query counts only — it SELECTs COUNT() per relationship so we never
// pull large payloads. For actual data transfer use SF_EXECUTE_PROFILE_TRANSFER.
async function sfRelationshipQuery(orgUrl, sid, rootObject, rootWhere, childRels, limit) {
  if (!rootObject) return { error: 'rootObject required' };
  const rels = (childRels || []).slice(0, 5); // Salesforce allows max 5 relationship subqueries per query
  const maxRows = Math.min(limit || 200, 2000);

  // Build COUNT() query for root
  const rootWhereFrag = rootWhere ? ` WHERE ${rootWhere}` : '';
  const countQuery = `SELECT COUNT() FROM ${rootObject}${rootWhereFrag}`;
  const countRes = await sfQuery(orgUrl, sid, countQuery, false);
  if (countRes.error) return { error: countRes.error };
  const parentCount = countRes.totalSize ?? 0;

  if (!rels.length) return { parentCount, childCounts: {} };

  // Build a single relationship query to count children per parent
  // Salesforce doesn't support COUNT() in subqueries directly, so we
  // SELECT Id + subquery Id fields, then tally in JS.
  const subSelects = rels.map(r => {
    const w = r.where ? ` WHERE ${r.where}` : '';
    return `(SELECT Id FROM ${r.relationshipName}${w} LIMIT 1000)`;
  }).join(', ');

  const relQuery =
    `SELECT Id, ${subSelects} FROM ${rootObject}${rootWhereFrag} LIMIT ${maxRows}`;

  const relRes = await sfQueryAll(orgUrl, sid, relQuery, false);
  if (relRes.error) {
    // Relationship query failed (some orgs/objects don't support subqueries here)
    // Fall back: return just the root count with null child counts
    const nullCounts = Object.fromEntries(rels.map(r => [r.relationshipName, null]));
    return { parentCount, childCounts: nullCounts, fallback: true };
  }

  const records = relRes.records || [];
  const childCounts = {};
  for (const rel of rels) {
    const rn = rel.relationshipName;
    // Each record's subquery result is at record[rn] — a records array or null
    let total = 0;
    for (const rec of records) {
      const sub = rec[rn];
      total += sub?.records?.length ?? 0;
    }
    // If we hit the LIMIT 1000 on any parent, mark as approximate
    const hitLimit = records.some(rec => (rec[rel.relationshipName]?.records?.length ?? 0) >= 1000);
    childCounts[rn] = hitLimit ? `${total}+` : total;
  }

  return { parentCount, childCounts };
}


// ---------------------------------------------------------------
// SObject Collections API — bulk UPSERT up to 200 records, matched on an
// external-Id field. PATCH /composite/sobjects/{SObject}/{extIdField}.
// Salesforce updates existing matches and inserts the rest. Each record must
// carry the external-Id field value. Returns UpsertResult[] { id, success,
// created, errors[] }.
async function sfCollectionsUpsert(orgUrl, sid, objectType, extIdField, records) {
  const url = `${orgUrl}/services/data/${API_VERSION}/composite/sobjects/${objectType}/${extIdField}`;
  const bodyStr = JSON.stringify({ allOrNone: false, records });
  const { ok, status, body } = await sfFetchWithProxy(orgUrl, sid, url, {
    method: 'PATCH',
    body: bodyStr
  });
  if (!ok) throw new Error(sfErrorMsg(status, body, url));
  return JSON.parse(body);  // array of UpsertResult objects
}

// ---------------------------------------------------------------
// SObject Collections API — bulk create up to 200 records of the same type.
// Each record must have an "attributes: { type }" already set by the caller.
// Returns an array of { id, success, errors[] } in the same order as input.
async function sfCollectionsCreate(orgUrl, sid, records) {
  const url = `${orgUrl}/services/data/${API_VERSION}/composite/sobjects`;
  const bodyStr = JSON.stringify({ allOrNone: false, records });
  const { ok, status, body } = await sfFetchWithProxy(orgUrl, sid, url, {
    method: 'POST',
    body: bodyStr
  });
  if (!ok) throw new Error(sfErrorMsg(status, body, url));
  return JSON.parse(body);  // array of SaveResult objects
}

// ---------------------------------------------------------------
// SObject Collections API — bulk DELETE up to 200 records by Id.
// Used by the Reconcile view to remove "extras" (records present in target
// but not in source). allOrNone:false so partial failures don't roll back
// the whole batch. Returns array of { id, success, errors[] } per record.
// ---------------------------------------------------------------
async function sfCollectionsDelete(orgUrl, sid, ids) {
  const idList = (ids || []).filter(Boolean);
  if (!idList.length) return [];
  const results = [];
  // The DELETE composite endpoint takes ids as a query param, max 200/call.
  for (let i = 0; i < idList.length; i += 200) {
    const chunk = idList.slice(i, i + 200);
    const url = `${orgUrl}/services/data/${API_VERSION}/composite/sobjects?ids=${encodeURIComponent(chunk.join(','))}&allOrNone=false`;
    const { ok, status, body } = await sfFetchWithProxy(orgUrl, sid, url, { method: 'DELETE' });
    if (!ok) throw new Error(sfErrorMsg(status, body, url));
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) results.push(...parsed);
  }
  return results;
}

// ---------------------------------------------------------------
// Hard delete = regular delete (→ Recycle Bin) followed by SOAP
// emptyRecycleBin to purge permanently. The REST composite API has no
// direct hard-delete param, so we chain the two. emptyRecycleBin only
// acts on records already in the bin, hence the ordering.
// Returns { deleteResults[], purgedOk, purgeErrors[] }.
// ---------------------------------------------------------------
async function sfHardDelete(orgUrl, sid, ids) {
  const delResults = await sfCollectionsDelete(orgUrl, sid, ids);
  // Only purge the ones that actually made it to the bin.
  const deletedOk = (delResults || []).filter(r => r.success).map(r => r.id);
  const purge = await sfEmptyRecycleBin(orgUrl, sid, deletedOk);
  return { deleteResults: delResults, purgedOk: purge.ok, purgeErrors: purge.errors };
}

// SOAP emptyRecycleBin — permanently purges up to 200 IDs/call from the
// org's Recycle Bin. Uses the partner SOAP endpoint with the session id in
// the header (same sid that authorizes REST works here). Needs the running
// user to have delete access; "Bulk API Hard Delete" perm is NOT required
// for emptyRecycleBin (that's only for the Bulk API hardDelete operation).
async function sfEmptyRecycleBin(orgUrl, sid, ids) {
  const idList = (ids || []).filter(Boolean);
  if (!idList.length) return { ok: 0, errors: [] };
  const ver     = API_VERSION.replace(/^v/, '');
  const soapUrl = `${orgUrl}/services/Soap/u/${ver}`;
  let ok = 0; const errors = [];
  for (let i = 0; i < idList.length; i += 200) {
    const chunk  = idList.slice(i, i + 200);
    const idsXml = chunk.map(id => `<urn:ids>${id}</urn:ids>`).join('');
    const envelope =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com">` +
      `<soapenv:Header><urn:SessionHeader><urn:sessionId>${sid}</urn:sessionId></urn:SessionHeader></soapenv:Header>` +
      `<soapenv:Body><urn:emptyRecycleBin>${idsXml}</urn:emptyRecycleBin></soapenv:Body></soapenv:Envelope>`;
    let text = '';
    try {
      const res = await sfFetch(soapUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': 'emptyRecycleBin' },
        body:    envelope
      });
      text = await res.text();
    } catch (e) {
      errors.push(`emptyRecycleBin request failed: ${e?.message || e}`);
      continue;
    }
    // SOAP fault → whole chunk failed
    const fault = text.match(/<faultstring>([^<]+)<\/faultstring>/)?.[1];
    if (fault) { errors.push(fault); continue; }
    // Each <result> has <success>true|false</success>; count successes,
    // collect any error messages.
    ok += (text.match(/<success>true<\/success>/g) || []).length;
    const errMatches = text.match(/<errors>[\s\S]*?<\/errors>/g) || [];
    for (const em of errMatches) {
      const msg = em.match(/<message>([^<]+)<\/message>/)?.[1];
      if (msg) errors.push(msg);
    }
  }
  return { ok, errors };
}

// ---------------------------------------------------------------
// SObject Collections API — bulk UPDATE up to 200 records.
// Each record must carry its target Id + attributes:{type}. Used by the
// Reconcile view to push source values onto drifted target records.
// allOrNone:false. Returns array of SaveResult { id, success, errors[] }.
// ---------------------------------------------------------------
async function sfCollectionsUpdate(orgUrl, sid, records) {
  const recs = (records || []).filter(r => r && r.Id);
  if (!recs.length) return [];
  const results = [];
  for (let i = 0; i < recs.length; i += 200) {
    const chunk = recs.slice(i, i + 200);
    const url = `${orgUrl}/services/data/${API_VERSION}/composite/sobjects`;
    const bodyStr = JSON.stringify({ allOrNone: false, records: chunk });
    const { ok, status, body } = await sfFetchWithProxy(orgUrl, sid, url, {
      method: 'PATCH',
      body: bodyStr
    });
    if (!ok) throw new Error(sfErrorMsg(status, body, url));
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) results.push(...parsed);
  }
  return results;
}

// ---------------------------------------------------------------
// Multi-org session enumeration
// Returns sessions for every unique Salesforce org the user has open.
// Used by the Record Copy feature to populate the "target org" selector.
// ---------------------------------------------------------------
async function getAllSfSessions() {
  const SF_URL_GLOBS = [
    'https://*.salesforce.com/*',
    'https://*.lightning.force.com/*',
    'https://*.salesforce-setup.com/*',
    'https://*.force.com/*'
  ];
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: SF_URL_GLOBS }); } catch (_) {}

  const orgTabs = tabs.filter(t => t.url && isOrgInstanceUrl(t.url));

  // Fetch sessions in parallel — one per tab
  const results = await Promise.allSettled(
    orgTabs.map(tab => getSfSession(tab.url).then(s => ({ ...s, tabTitle: tab.title || '' })))
  );

  const sessions = [];
  const seenOrgs = new Set();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const { orgUrl, sid, tabTitle } = r.value || {};
    if (!orgUrl || !sid || seenOrgs.has(orgUrl)) continue;
    seenOrgs.add(orgUrl);

    // Build a human-readable org label from the hostname
    let label;
    try {
      const host = new URL(orgUrl).hostname;
      // e.g. "myorg.develop.my.salesforce.com" → "myorg (develop)"
      const stripped = host.replace('.my.salesforce.com', '');
      const parts    = stripped.split('.');
      label = parts.length > 1
        ? `${parts.slice(0, -1).join('.')} (${parts[parts.length - 1]})`
        : parts[0];
    } catch (_) { label = orgUrl; }

    sessions.push({ orgUrl, sid, label, tabTitle });
  }

  return { sessions };
}

// ---------------------------------------------------------------
// Session detection using chrome.cookies (reads HttpOnly cookies)
// ---------------------------------------------------------------
const SF_URL_PATTERNS = [
  '.salesforce.com',
  '.lightning.force.com',
  '.my.salesforce.com',
  '.salesforce-setup.com',
  '.force.com'
];

// Non-org Salesforce domains — these match *.salesforce.com but are
// NOT org instances and have no Tooling API
const SF_EXCLUDED_HOSTS = [
  'trailhead.salesforce.com',
  'login.salesforce.com',
  'test.salesforce.com',
  'developer.salesforce.com',
  'help.salesforce.com',
  'appexchange.salesforce.com',
  'status.salesforce.com',
  'trust.salesforce.com',
  'partners.salesforce.com',
  'www.salesforce.com',
  'trailblazer.salesforce.com'
];

// Patterns that are strong indicators of an actual org instance URL
const SF_ORG_PATTERNS = [
  '.my.salesforce.com',
  '.lightning.force.com',
  '.salesforce-setup.com',
  '.my.salesforce-setup.com'
];

function isSalesforceUrl(url) {
  try {
    const host = new URL(url).hostname;
    if (SF_EXCLUDED_HOSTS.includes(host)) return false;
    return SF_URL_PATTERNS.some(p => url.includes(p));
  } catch (_) { return false; }
}

function isOrgInstanceUrl(url) {
  try {
    const host = new URL(url).hostname;
    if (SF_EXCLUDED_HOSTS.includes(host)) return false;
    return SF_ORG_PATTERNS.some(p => host.includes(p));
  } catch (_) { return false; }
}

// Derive the Salesforce REST API origin from any SF host string.
// lightning.force.com → my.salesforce.com (where the Tooling API lives)
// salesforce-setup.com → salesforce.com
function sfApiOrigin(hostname) {
  return `https://${hostname}`
    .replace('.salesforce-setup.com', '.salesforce.com')
    .replace('.lightning.force.com', '.my.salesforce.com');
}

/**
 * Detect the active Salesforce session.
 *
 * @param {string|null} activeTabUrl  URL of the tab the user is currently
 *   viewing (sent by popup.js via chrome.tabs.query({active,currentWindow})).
 *   When provided we prioritise the org that matches this URL so users with
 *   multiple orgs open get data for the org they are actually looking at,
 *   exactly the same way the Lightning Inspector behaves.
 */
async function getSfSession(activeTabUrl = null) {
  // ── Step 1: find open Salesforce org tabs ───────────────────────────────
  // We avoid the broad "tabs" permission by querying only tabs that match our
  // declared host_permissions. Chrome populates tab.url for those tabs.
  const SF_URL_GLOBS = [
    'https://*.salesforce.com/*',
    'https://*.lightning.force.com/*',
    'https://*.salesforce-setup.com/*',
    'https://*.force.com/*'
  ];

  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: SF_URL_GLOBS }); } catch (_) {}

  // Priority order for choosing which SF tab to use:
  // 1. The tab whose URL matches the activeTabUrl hint (user's current view)
  // 2. Any org-instance URL (my.salesforce.com, sandbox, etc.)
  // 3. Any recognisable Salesforce URL
  let sfTab = null;

  if (activeTabUrl) {
    try {
      const activeHostname = new URL(activeTabUrl).hostname;
      // Exact hostname match first — same org, same subdomain
      sfTab = tabs.find(t => t.url && new URL(t.url).hostname === activeHostname);
      // Slug match — handles my.salesforce.com ↔ lightning.force.com sibling URLs.
      // e.g. "ashkenazy7-dev-ed.develop.my.salesforce.com" → slug "ashkenazy7-dev-ed"
      // matches "ashkenazy7-dev-ed.develop.lightning.force.com" tab perfectly.
      // This must come BEFORE the broad base-domain fallback below, which for
      // ".develop.my.salesforce.com" orgs computes base = "my.salesforce.com"
      // and incorrectly matches every sandbox in the browser.
      if (!sfTab) {
        const orgSlug = activeHostname.split('.')[0];
        if (orgSlug) sfTab = tabs.find(t => t.url?.includes(orgSlug));
      }
      // Last-resort: same base domain (only fires when slug didn't find a tab)
      if (!sfTab) {
        const activeBase = activeHostname.split('.').slice(-3).join('.');
        sfTab = tabs.find(t => {
          if (!t.url) return false;
          try { return new URL(t.url).hostname.endsWith(activeBase); } catch (_) { return false; }
        });
      }
    } catch (_) { /* invalid URL — fall through */ }
  }

  // Fallback when no hint or hint didn't match any tab
  if (!sfTab) sfTab = tabs.find(t => t.url && isOrgInstanceUrl(t.url));
  if (!sfTab) sfTab = tabs.find(t => t.url && isSalesforceUrl(t.url));

  // ── Step 2: build cookie URL candidates ─────────────────────────────────
  let apiOrigin = null;
  let cookieCandidates = [];

  if (sfTab) {
    const tabUrl  = new URL(sfTab.url);
    const hostname = tabUrl.hostname;
    apiOrigin = sfApiOrigin(hostname);

    // API origin FIRST so we always read the salesforce.com sid cookie, not the
    // salesforce-setup.com sid (Salesforce issues different cookie values for each
    // base domain; the setup-domain sid is invalid for the REST/Tooling API).
    // Shorter suffixes cover cases where sid is scoped to a parent domain
    // (e.g. .develop.my.salesforce.com).
    const parts = hostname.split('.');
    cookieCandidates = [...new Set([
      apiOrigin,                                                            // API origin first
      `https://${hostname}`,                                                // tab hostname second
      parts.length > 2 ? `https://${parts.slice(1).join('.')}` : null,
      parts.length > 3 ? `https://${parts.slice(2).join('.')}` : null,
      // For lightning.force.com tabs also try the my.salesforce.com sibling
      hostname.includes('.lightning.force.com')
        ? `https://${hostname.replace('.lightning.force.com', '.my.salesforce.com')}`
        : null
    ].filter(Boolean))];
  }

  // ── Step 3: try direct URL-based cookie lookup ───────────────────────────
  // IMPORTANT: use getAll() not get() here.
  // chrome.cookies.get() returns the earliest-created matching cookie when
  // paths tie — this means a stale shared-domain cookie (e.g. ashkenazy6's
  // sid scoped to .develop.my.salesforce.com) beats the fresher org-specific
  // cookie even when querying for a completely different org's URL.
  // getAll() lets us sort by domain length so the most-specific (longest)
  // domain cookie wins — that's always the correct org's session.
  let sid = null;
  for (const url of cookieCandidates) {
    try {
      const cookies = await chrome.cookies.getAll({ url, name: 'sid' });
      if (cookies.length > 0) {
        // Longest domain = most specific = correct org (not a shared parent)
        cookies.sort((a, b) => b.domain.length - a.domain.length);
        sid = cookies[0].value;
        break;
      }
    } catch (_) {}
  }

  // ── Step 4: full cookie scan fallback ───────────────────────────────────
  // Works even when the tab URL wasn't visible (tab.url undefined) or the
  // direct URL lookup missed due to cookie domain scoping. Reads all 'sid'
  // cookies accessible via host_permissions (no extra permission needed).
  if (!sid) {
    try {
      const allSidCookies = await chrome.cookies.getAll({ name: 'sid' });
      // Prefer cookies from known org-instance domains, fall back to any SF domain
      const sfCookie =
        allSidCookies.find(c => SF_ORG_PATTERNS.some(p => c.domain.includes(p.replace(/^\./, '')))) ||
        allSidCookies.find(c => SF_URL_PATTERNS.some(p => c.domain.includes(p.replace(/^\./, ''))));

      if (sfCookie?.value) {
        sid = sfCookie.value;
        // If we don't yet have an API origin, derive one from the cookie's domain
        if (!apiOrigin) {
          apiOrigin = sfApiOrigin(sfCookie.domain.replace(/^\./, ''));
        }
      }
    } catch (_) {}
  }

  if (!sid || !apiOrigin) return { sid: null, orgUrl: null };
  return { sid, orgUrl: apiOrigin };
}

// ── Passive session recovery via cookie change ────────────────────────────────
// When the user manually refreshes their Salesforce tab (or Salesforce rotates
// the session cookie on its own), we pick up the new `sid` here and notify the
// popup so it can reconnect silently — no tab reload ever triggered by us.
chrome.cookies.onChanged.addListener((changeInfo) => {
  if (changeInfo.removed) return;                        // only care about new/updated cookies
  if (changeInfo.cookie.name !== 'sid') return;          // only the session cookie
  const domain = changeInfo.cookie.domain.replace(/^\./, '');
  if (!isSalesforceUrl(`https://${domain}/`)) return;   // only SF domains
  // Broadcast to all extension pages (popup, studio, etc.)
  chrome.runtime.sendMessage({ type: 'SF_SESSION_REFRESHED', domain }).catch(() => {});
});
