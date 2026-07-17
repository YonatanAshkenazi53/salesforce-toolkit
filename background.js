// sftkOrgKey — org-identity key. This is a BYTE-FOR-BYTE copy of the
// canonical implementation in sftk-org-identity.js (which popup + studio
// load as a classic script). It is inlined here rather than imported because
// the manifest CSP enforces require-trusted-types-for 'script' in this
// service worker too, importScripts is a Trusted-Types sink, and the
// trustedTypes FACTORY is not exposed in worker scope on all Chrome builds —
// so importScripts is effectively unusable under this CSP.
// A parity unit test (test/pure-functions.test.mjs) fails the build if this
// copy and the canonical one ever diverge.
function sftkOrgKey(orgUrl) {
  if (!orgUrl) return '';
  let host;
  try { host = new URL(orgUrl).hostname; }
  catch { host = String(orgUrl).replace(/^https?:\/\//, '').replace(/\/.*$/, ''); }
  return host
    .replace(/\.my\.salesforce-setup\.com$/, '')
    .replace(/\.salesforce-setup\.com$/, '')
    .replace(/\.my\.salesforce\.com$/, '')
    .replace(/\.lightning\.force\.com$/, '')
    .replace(/\.my\.site\.com$/, '')
    .replace(/\.salesforce\.com$/, '')
    .replace(/\.force\.com$/, '')
    .toLowerCase();
}

const API_VERSION = 'v62.0';

// ── Per-org read-only gate ───────────────────────────────────────────────────
// Orgs marked read-only in Connected Orgs (sftk_orgs[url].readOnly) reject every
// write at the single fetch chokepoint (any non-GET method). Matching uses
// sftkOrgKey so all domain forms of the org are covered.
async function assertOrgWritable(orgUrl) {
  const { sftk_orgs } = await chrome.storage.local.get('sftk_orgs');
  if (!sftk_orgs) return;
  const key = sftkOrgKey(orgUrl);
  for (const [url, o] of Object.entries(sftk_orgs)) {
    if (o?.readOnly && sftkOrgKey(url) === key) {
      throw new Error(`Org is marked read-only (${o.label || url}) — writes are blocked. Unlock it in Data Studio → Connected Orgs.`);
    }
  }
}

// ── Run progress channel ─────────────────────────────────────────────────────
// Data Studio connects a long-lived Port before launching a transfer /
// sequence / reconcile. The engine posts progress events through it (which
// also keeps this MV3 service worker alive during long runs — every message
// resets the idle timer) and listens for {cmd:'cancel'}: the engine checks
// the flag between nodes and between 200-record batches, finishing with a
// partial summary marked cancelled instead of dying mid-write.
let _runPort      = null;
let _runCancelled = false;
let _runHeartbeat = null;

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'sftk-run-progress') return;
  _runPort = port;
  port.onMessage.addListener(msg => {
    if (msg?.cmd === 'cancel') _runCancelled = true;
  });
  port.onDisconnect.addListener(() => { if (_runPort === port) _runPort = null; });
});

function postRunProgress(evt) {
  try { _runPort?.postMessage(evt); } catch (_) { /* page closed mid-run */ }
}

// Called at the start of every engine entry point: clears the cancel flag and
// starts a heartbeat so silent stretches (large queryAll pages) can't idle the
// worker out. _endRun stops it.
function _beginRun(kind) {
  _runCancelled = false;
  clearInterval(_runHeartbeat);
  _runHeartbeat = setInterval(() => postRunProgress({ phase: 'hb' }), 20000);
  chrome.storage.local.set({ sftk_active_run: { kind, startedAt: new Date().toISOString() } }).catch(() => {});
  postRunProgress({ phase: 'start', kind });
}
function _endRun() {
  clearInterval(_runHeartbeat);
  _runHeartbeat = null;
  chrome.storage.local.remove('sftk_active_run').catch(() => {});
  postRunProgress({ phase: 'end' });
}

// ── Extension icon click → open / focus the full-page app ─────
// Because manifest.json has no default_popup, clicking the toolbar
// icon fires this listener instead of opening a small popup.
chrome.action.onClicked.addListener(async () => {
  const appUrl = chrome.runtime.getURL('popup.html');

  // If a toolkit page is already open, focus it instead of opening a second.
  // Uses TOOLKIT_PING (the page answers with its own tab id) rather than
  // tabs.query({url}) — URL filtering needs the dropped "tabs" permission;
  // focusing by id doesn't.
  const existing = await new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    try {
      chrome.runtime.sendMessage({ type: 'TOOLKIT_PING' }, resp => {
        void chrome.runtime.lastError;
        done(resp && resp.tabId != null ? resp : null);
      });
    } catch (_) { done(null); }
    setTimeout(() => done(null), 400);
  });
  if (existing) {
    await chrome.tabs.update(existing.tabId, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }

  // Open a new tab with the full-page toolkit
  chrome.tabs.create({ url: appUrl });
});


// Execute a profile transfer between two orgs.
// Returns a summary object for the history log.
// sharedIdMap (optional): when running a SEQUENCE of profiles, the caller
// passes ONE idMap object reused across every profile so a later profile's
// lookup field that points at a record created by an earlier profile is
// remapped to the new target Id (priority-1 path in the payload builder).
// Omitted for a standalone run → a fresh per-run map, identical to before.
async function executeProfileTransfer(profile, srcOrgUrl, srcSid, tgtOrgUrl, tgtSid, sharedIdMap = null) {
  const startedAt    = new Date().toISOString();
  const idMap        = sharedIdMap || {};  // srcId → tgtId (all objects — used for reference field remapping)
  const summary      = {};
  const errors       = [];
  // Separate channel so diagnostic lines aren't truncated by the
  // `errors.slice(0, N)` cap at the bottom — 20 identical "Required fields
  // are missing" rows would otherwise eat the entire window and the diag
  // lines (the things you actually need to read) would never reach the UI.
  // Prepended to `errors` right before returning.
  const diagnostics  = [];

  // Track source IDs fetched per tree node so each child node's WHERE clause
  // only references its direct parent's records.
  // Bug otherwise: in a 3-level tree (e.g. Account → Contact → Task), when Task
  // is processed, Object.values(idMap) would contain both Account AND Contact
  // target IDs, making the WHERE clause wildly over-broad.
  const nodeSourceIds = new Map();
  // Full source records + insert-time-linked ids retained for child-first
  // nodes — needed AFTER their parent inserts to wire child.parentField to the
  // parent's new target id (the connect step).
  const nodeRecs         = new Map();  // node → source records
  const nodePreLinked    = new Map();  // node → Map(srcId → parent target id set at insert)
  const nodeDeferredRefs = new Map();  // node → [{srcId, tgtField, srcVal, isParentLink}]

  // Owner mapping ('match' mode on the profile): resolve each source owner's
  // NAME to a target User at write time; unmatched owners get the profile's
  // fallback user (or the org default when none is set). Resolution results
  // are cached across nodes. Default mode: owners are never copied.
  const ownerMode     = profile?.ownerMapping?.mode === 'match';
  const ownerFallback = ownerMode ? (profile.ownerMapping.fallbackUserId || null) : null;
  const ownerByName   = new Map();   // source Owner.Name → target User Id
  const ownerMisses   = new Set();   // names known to have no target match

  // Depth-first flattening. Default: every parent is processed before its
  // children. A child node marked insertOrder:'childFirst' (and its own
  // subtree) is hoisted BEFORE its parent instead: its records are created
  // first (without the parent-link field), the parent inserts next — the
  // parent's lookups to those records remap via idMap automatically — then the
  // children are UPDATEd to point at their parent (connect step below).
  // NOTE: this is a flatten-ORDER change only; node.children arrays are never
  // physically reordered (studio.js pathKey navigation is index-based).
  function flattenTree(node, parentNode = null, parentField = null) {
    const self = { node, parentNode, parentField };
    const before = [], after = [];
    for (const c of (node.children || [])) {
      (c.insertOrder === 'childFirst' ? before : after).push(...flattenTree(c, node, c.field));
    }
    return [...before, self, ...after];
  }

  // Guard against a malformed / legacy profile with no tree — flattenTree
  // would otherwise throw on `node.children` of undefined.
  const ordered = profile && profile.tree ? flattenTree(profile.tree) : [];
  const entryByNode = new Map(ordered.map(e => [e.node, e]));

  // SOURCE-org record ids defining a node's scope, used to filter its
  // children's fetches. For an already-processed node that's its fetched ids;
  // for a not-yet-processed node (a child-first child needs its parent's scope
  // BEFORE the parent's own turn) run a lightweight Id-only prefetch, walking
  // up the chain recursively. Cached so each node prefetches at most once.
  const prefetchIds = new Map();
  async function getScopeIds(entry) {
    if (!entry) return [];
    const { node, parentNode, parentField } = entry;
    if (nodeSourceIds.has(node)) return nodeSourceIds.get(node);
    if (prefetchIds.has(node))   return prefetchIds.get(node);
    const objType = node.objectType || node.childSObject;
    const ridList = Array.isArray(node.recordIds) && node.recordIds.length
      ? node.recordIds.filter(Boolean) : null;
    const baseWhere = ridList
      ? `Id IN (${ridList.map(id => `'${id}'`).join(',')})`
      : (node.where || '');
    let ids = [];
    try {
      if (parentField && parentNode) {
        const parentScope = await getScopeIds(entryByNode.get(parentNode));
        // If the parent was already inserted, narrow to parents that made it
        // into the target; otherwise (parent also pending) use its full scope.
        const scope = nodeSourceIds.has(parentNode)
          ? parentScope.filter(id => idMap[id])
          : parentScope;
        for (let ci = 0; ci < scope.length; ci += 200) {
          const lit = scope.slice(ci, ci + 200).map(id => `'${id}'`).join(',');
          const w = baseWhere ? `(${baseWhere}) AND ${parentField} IN (${lit})` : `${parentField} IN (${lit})`;
          const r = await sfQueryAll(srcOrgUrl, srcSid, `SELECT Id FROM ${objType} WHERE ${w}`, false);
          ids = ids.concat((r.records || []).map(x => x.Id));
        }
        ids = [...new Set(ids)];
      } else {
        const r = await sfQueryAll(srcOrgUrl, srcSid,
          `SELECT Id FROM ${objType}${baseWhere ? ' WHERE ' + baseWhere : ''}`, false);
        ids = (r.records || []).map(x => x.Id);
      }
    } catch (e) {
      errors.push(`${objType}: parent scope prefetch failed — ${e.message}`);
      ids = [];
    }
    prefetchIds.set(node, ids);
    return ids;
  }

  for (const { node, parentNode, parentField } of ordered) {
    const objType = node.objectType || node.childSObject;
    // Cancel between nodes — never mid-write.
    if (_runCancelled) {
      errors.push('Run cancelled — remaining objects skipped.');
      break;
    }
    postRunProgress({ phase: 'node', obj: objType });
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

      // Owner matching needs the source owner's display name — only when the
      // object actually has owners (children like OpportunityLineItem don't).
      const wantOwners = ownerMode && (descRes.fields || []).some(f => f.name === 'OwnerId');
      if (wantOwners) fields.push('Owner.Name');

      // The object's name field — fetched purely for human-readable History
      // links. Compound names (Contact.Name) aren't createable so
      // buildCopyFields drops them, which left links showing raw ids. The
      // payload builder skips non-createable fields, so this never sends.
      const nameFld = (descRes.fields || []).find(f => f.nameField)?.name || null;
      if (nameFld && !fields.includes(nameFld)) fields.push(nameFld);

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

      if (parentField && parentNode) {
        // Which parent SOURCE ids scope this child's fetch?
        //  - Parent already processed (default order): only the parents that
        //    actually made it into the target. IMPORTANT: keep SOURCE ids and
        //    use idMap only as a success FILTER — the query below runs against
        //    the SOURCE org. (The old `.map(id => idMap[id])` put TARGET-org
        //    ids into a source-org WHERE clause, which can never match, so
        //    every child node silently fetched 0 records.)
        //  - Parent not yet processed (this node is child-first): the parent's
        //    full source scope via the Id-only prefetch above. Without this,
        //    the node would fall into the unfiltered root branch and copy the
        //    ENTIRE child table.
        const parentScopeIds = nodeSourceIds.has(parentNode)
          ? nodeSourceIds.get(parentNode).filter(id => idMap[id])
          : await getScopeIds(entryByNode.get(parentNode));

        // Zero parents in scope (all inserts failed, 0 source records, or the
        // prefetch errored) — skip this child, don't fetch without a filter.
        if (parentScopeIds.length === 0) {
          nodeSourceIds.set(node, []);
          summary[objType] = { created: 0, failed: 0, skipped: true };
          continue;
        }

        // Chunk parent IDs to keep each SOQL IN clause within safe limits.
        // Salesforce can reject very long IN lists; 200 IDs per chunk is safe.
        const CHUNK = 200;
        for (let ci = 0; ci < parentScopeIds.length; ci += CHUNK) {
          const sliceLiteral = parentScopeIds.slice(ci, ci + CHUNK)
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
      postRunProgress({ phase: 'fetched', obj: objType, count: recs.length });

      // Resolve this node's owner names against the TARGET org's users
      // (User owners only — queue-owned records won't match and fall back).
      if (wantOwners && recs.length) {
        const names = [...new Set(recs
          .map(r => r.Owner ? r.Owner.Name : null)
          .filter(n => n && !ownerByName.has(n) && !ownerMisses.has(n)))];
        for (let ci = 0; ci < names.length; ci += 100) {
          const lit = names.slice(ci, ci + 100)
            .map(n => `'${String(n).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(',');
          const q = await sfQueryAll(tgtOrgUrl, tgtSid,
            `SELECT Id, Name FROM User WHERE IsActive = true AND Name IN (${lit})`, false);
          for (const u of (q.records || [])) if (!ownerByName.has(u.Name)) ownerByName.set(u.Name, u.Id);
        }
        names.forEach(n => { if (!ownerByName.has(n)) ownerMisses.add(n); });
      }

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

      // Child-first bookkeeping.
      // preLinked: records whose parent link WAS resolvable at insert (parent
      // created earlier in this run/sequence via the shared idMap) → maps to
      // the target id used, so the connect step can detect a stale link if the
      // parent gets re-created later and only then re-patch.
      // deferredRefs: every reference field that could NOT resolve at insert
      // (the parent link, plus any other lookup pointing at not-yet-created
      // records). The connect step retries them once the parent exists —
      // giving child-first exact field parity with the default order.
      const preLinked    = new Map();
      const deferredRefs = [];
      // Owner-mapping outcome counters for this node's summary line.
      let ownerFellBack = 0, ownerDefaulted = 0;

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
            // Child-first: this node's own parent-link field is deliberately
            // deferred — the parent doesn't exist yet; the connect step patches
            // it after the parent inserts. Exception: the parent WAS created
            // earlier (same run or an earlier sequence step → idMap hit) — set
            // it now and record the id used so a stale link can be detected.
            // Never let a lookup-resolution bridge fill the deferred link (it
            // would wire the record to a pre-existing parent, then the connect
            // step would re-point it — a transient wrong link).
            const isCf           = node.insertOrder === 'childFirst';
            const isDeferredLink = isCf && f.name === parentField;
            // Priority 1: idMap — record was transferred earlier in this same session
            if (idMap[v]) {
              p[tgtField] = idMap[v];
              if (isDeferredLink) preLinked.set(r.Id, idMap[v]);
              continue;
            }
            if (isDeferredLink) {
              // NOTE: tgtField (the MAPPED name) is what the connect step must
              // patch — the insert path writes mapped names, so must the patch.
              deferredRefs.push({ srcId: r.Id, tgtField, srcVal: v, isParentLink: true });
              continue;
            }
            // Priority 2: lookup resolution bridge (skip / match by field)
            const lkpRes = node.lookupResolutions?.[f.name];
            if (lkpRes?.strategy === 'match' && lkpBridges[f.name]?.has(v)) {
              p[tgtField] = lkpBridges[f.name].get(v);
              continue;
            }
            // Unresolvable right now. On a child-first node, remember it — the
            // connect step retries once the parent (and anything else created
            // in between) exists, so lookups OTHER than the tree link that
            // point at the parent aren't silently lost.
            if (isCf) deferredRefs.push({ srcId: r.Id, tgtField, srcVal: v, isParentLink: false });
            // skip / no config / legacy passthrough → field omitted — safe default
            continue;
          }
          p[tgtField] = v;
        }
        // Owner mapping: matched name → that user; unmatched → fallback user;
        // no fallback → omit (target org default), counted for the summary.
        if (wantOwners) {
          const oname = r.Owner ? r.Owner.Name : null;
          if (oname) {
            const matched = ownerByName.get(oname);
            const oid = matched || ownerFallback;
            if (oid && (!tgtCreatable.size || tgtCreatable.has('OwnerId'))) p.OwnerId = oid;
            if (!matched) { if (ownerFallback) ownerFellBack++; else ownerDefaulted++; }
          }
        }
        return p;
      });

      // Child-first nodes are needed again AFTER their parent inserts (the
      // connect step patches the deferred fields) — retain records + state.
      if (node.insertOrder === 'childFirst') {
        nodeRecs.set(node, recs);
        nodePreLinked.set(node, preLinked);
        nodeDeferredRefs.set(node, deferredRefs);
      }

      // ── Batch create (200 records/batch, allOrNone:false) ────────────────
      let ok = 0, fail = 0;
      // Track which SOURCE record IDs succeeded — surfaced in the per-node
      // summary so the Pick-Records modal can badge already-deployed
      // records and avoid the "did this go through?" guesswork.
      const transferredSourceIds = [];
      // Target-side record refs for History links — id + a human label
      // (record Name when fetched, else the id). Capped to keep storage sane.
      const targetRecords = [];
      // Mirror for failures — drives the "↻ Retry failed (N)" button on
      // History rows. Each entry carries the source ID + first error msg
      // so the UI can show what went wrong per row.
      const failedSourceIds = [];        // [{ id, error }]
      // M3c — MATCH MEMORY feed: [srcId, tgtId] pairs for every successful
      // create/upsert on the ROOT node only (v1). Studio-side callers merge
      // these into profile.matchMemory so future scans match these records by
      // identity (rename-proof). Capped at 2000 like the other id lists.
      const isRootNode = node === profile.tree;
      const idPairs = [];
      let reqMissingDiagPushed = false; // emit the payload-keys diag only once per node
      // Upsert mode (v1): applies to the ROOT object only, keyed by an
      // external-Id field. When on, existing target records (matched on that
      // field) are UPDATED instead of duplicated; new ones are inserted.
      const useUpsert   = !!(profile.upsert?.field) && node === profile.tree;
      const upsertField = useUpsert ? profile.upsert.field : null;
      for (let i = 0; i < payloads.length; i += 200) {
        // Cancel between batches — records already written stay written
        // (allOrNone:false per batch); the summary reports the partial count.
        if (_runCancelled) {
          errors.push(`${objType}: cancelled after ${ok} of ${payloads.length} record(s).`);
          break;
        }
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
            if (isRootNode && idPairs.length < 2000) idPairs.push([recs[i + j].Id, result.id]);
            if (targetRecords.length < 200) {
              targetRecords.push({ id: result.id, label: (nameFld && recs[i + j][nameFld]) || recs[i + j].Name || result.id });
            }
          }
          else {
            fail++;
            const msg = (result.errors || []).map(e => e.message).join('; ');
            errors.push(`${objType}: ${msg}`);
            // label → History links the failed record back to its SOURCE org
            // (nothing exists in the target for a failed insert).
            failedSourceIds.push({ id: recs[i + j].Id, error: msg, label: (nameFld && recs[i + j][nameFld]) || recs[i + j].Name || recs[i + j].Id });
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
        postRunProgress({ phase: 'batch', obj: objType,
          done: Math.min(i + 200, payloads.length), total: payloads.length,
          created: ok, failed: fail });
      }
      summary[objType] = { created: ok, failed: fail };
      // Owner-mapping outcome — surfaced as ⚠ notes, never failures.
      if (ownerFellBack)  errors.push(`⚠ ${objType}: ${ownerFellBack} record(s) had owners with no name match in the target — assigned the fallback user.`);
      if (ownerDefaulted) errors.push(`⚠ ${objType}: ${ownerDefaulted} record(s) had owners with no name match and no fallback user is set — the target org assigned its default owner.`);
      // Source IDs that successfully inserted in target — cap at 2000 to keep
      // chrome.storage payloads sane on huge transfers. The picker reads this
      // to badge already-deployed records.
      if (transferredSourceIds.length) {
        summary[objType].transferredSourceIds = transferredSourceIds.slice(0, 2000);
      }
      // M3c — root-node srcId→tgtId pairs for the studio's match memory.
      // Callers merge these then strip them before persisting to History.
      if (idPairs.length) {
        summary[objType].idPairs = idPairs;
      }
      // Target record refs → History renders them as clickable links.
      if (targetRecords.length) {
        summary[objType].targetRecords = targetRecords;
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

      // ── Connect child-first children ─────────────────────────────────────
      // Children marked insertOrder:'childFirst' were inserted BEFORE this
      // node with every then-unresolvable reference field deferred (the parent
      // link plus any other lookup pointing at not-yet-created records). Now
      // that this node's records exist in the target, patch every deferred
      // field that resolves — exact field parity with default parent-first.
      for (const child of (node.children || []).filter(c => c.insertOrder === 'childFirst')) {
        const childObj  = child.objectType || child.childSObject;
        const childRecs = nodeRecs.get(child) || [];
        const linkedMap = nodePreLinked.get(child) || new Map();
        const deferred  = nodeDeferredRefs.get(child) || [];
        if (!childRecs.length || !child.field) continue;

        // Honor the child's field mapping for the parent-link field — the
        // insert path writes the MAPPED name, so the patch must too. A null
        // mapping means the user excluded the link entirely: nothing to wire.
        const linkMapping  = child.fieldMappings ? child.fieldMappings[child.field] : undefined;
        if (linkMapping === null) continue;
        const linkTgtField = linkMapping || child.field;

        const deferredByRec = new Map();
        for (const d of deferred) {
          if (!deferredByRec.has(d.srcId)) deferredByRec.set(d.srcId, []);
          deferredByRec.get(d.srcId).push(d);
        }

        const updates = [], updateHasLink = [];
        let connected = 0, connectFailed = 0, orphaned = 0;
        for (const cr of childRecs) {
          const childTgt = idMap[cr.Id];
          if (!childTgt) continue;   // child insert failed — already counted as failed
          const patch = {};
          let patchHasLink = false;
          for (const d of (deferredByRec.get(cr.Id) || [])) {
            const resolved = idMap[d.srcVal];
            if (!resolved) { if (d.isParentLink) orphaned++; continue; }
            patch[d.tgtField] = resolved;   // tgtField is already the mapped name
            if (d.isParentLink) patchHasLink = true;
          }
          // Linked at insert (idMap hit) — re-point only if the parent was
          // re-created later in this run and its target id moved (stale link).
          if (linkedMap.has(cr.Id)) {
            const nowVal = cr[child.field] ? idMap[cr[child.field]] : null;
            if (nowVal && nowVal !== linkedMap.get(cr.Id)) {
              patch[linkTgtField] = nowVal;
              patchHasLink = true;
            } else {
              connected++;   // still correctly linked from insert time
            }
          }
          if (Object.keys(patch).length) {
            updates.push({ attributes: { type: childObj }, Id: childTgt, ...patch });
            updateHasLink.push(patchHasLink);
          }
        }

        // Patch in 200-chunks with PER-CHUNK error containment: one bad chunk
        // (HTTP 500, session drop) must not mark records patched by earlier
        // chunks as failed — and must never erase this parent's own summary.
        for (let ci = 0; ci < updates.length; ci += 200) {
          const slice = updates.slice(ci, ci + 200);
          try {
            const res = await sfCollectionsUpdate(tgtOrgUrl, tgtSid, slice);
            (Array.isArray(res) ? res : []).forEach((rr, j) => {
              const hasLink = updateHasLink[ci + j];
              if (rr.success) { if (hasLink) connected++; }
              else {
                if (hasLink) connectFailed++;
                errors.push(`${childObj}: linking to ${objType} failed — ${(rr.errors || []).map(x => x.message).join('; ')}`);
              }
            });
          } catch (linkErr) {
            for (let j = 0; j < slice.length; j++) if (updateHasLink[ci + j]) connectFailed++;
            errors.push(`${childObj}: linking to ${objType} failed — ${linkErr.message}`);
          }
        }

        if (summary[childObj]) {
          summary[childObj].connected = connected;
          if (connectFailed) summary[childObj].connectFailed   = connectFailed;
          if (orphaned)      summary[childObj].connectOrphaned = orphaned;
        }
        if (orphaned) {
          errors.push(`${childObj}: ${orphaned} record(s) were created but their ${objType} parent wasn't — left unlinked in the target.`);
        }
      }
    } catch (e) {
      nodeSourceIds.set(node, []);  // prevent children from using a broken parent
      errors.push(`${objType}: ${e.message}`);
      summary[objType] = { created: 0, failed: 0, error: e.message };
      // Child-first children of THIS node may already be sitting in the target
      // unlinked — the connect step can't run without the parent. Say so.
      const cfKids = (node.children || [])
        .filter(c => c.insertOrder === 'childFirst' && (nodeRecs.get(c) || []).length)
        .map(c => c.objectType || c.childSObject);
      if (cfKids.length) {
        errors.push(`${objType}: failed before its child-first children could be linked — ${cfKids.join(', ')} records were created but remain unconnected.`);
      }
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
    ...(_runCancelled ? { cancelled: true } : {}),
    summary, errors: finalErrors.slice(0, 50)
  };
}

// Run an ordered list of saved profiles as one pipeline against a single
// org pair, threading ONE idMap through every step so cross-profile lookups
// remap (e.g. CPQ: a "Price Rules" profile, then a "Lookup Queries" profile
// whose SBQQ__PriceRule2__c points at the rules just created). Steps run
// strictly in order; a thrown step is captured and the sequence continues so
// one bad profile doesn't abort the rest (each step's status reflects its own
// outcome).
async function executeProfileSequence(profiles, srcOrgUrl, srcSid, tgtOrgUrl, tgtSid) {
  const startedAt    = new Date().toISOString();
  const sharedIdMap  = {};   // threaded across every profile in the sequence
  const steps        = [];
  for (let i = 0; i < profiles.length; i++) {
    const prof = profiles[i];
    if (_runCancelled) {
      steps.push({ index: i, profileId: prof?.id, profileName: prof?.name || `Step ${i + 1}`,
        status: 'failed', summary: {}, errors: ['Skipped — run cancelled.'] });
      continue;
    }
    postRunProgress({ phase: 'step', index: i, total: profiles.length, name: prof?.name || `Step ${i + 1}` });
    if (!prof || !prof.tree) {
      steps.push({ index: i, profileId: prof?.id, profileName: prof?.name || `Step ${i + 1}`,
        status: 'failed', summary: {}, errors: ['Profile not found or has no object tree — skipped.'] });
      continue;
    }
    try {
      const res = await executeProfileTransfer(prof, srcOrgUrl, srcSid, tgtOrgUrl, tgtSid, sharedIdMap);
      steps.push({ index: i, ...res });
    } catch (e) {
      steps.push({ index: i, profileId: prof.id, profileName: prof.name,
        status: 'failed', summary: {}, errors: [e.message || String(e)] });
    }
  }
  // Sequence status: success only if every step succeeded; partial if anything
  // got created anywhere; otherwise failed.
  const anyCreated = steps.some(s => Object.values(s.summary || {}).some(x => x.created > 0));
  const status = steps.every(s => s.status === 'success') ? 'success'
    : anyCreated ? 'partial' : 'failed';
  return {
    sequence: true, startedAt, completedAt: new Date().toISOString(),
    sourceOrg: srcOrgUrl, targetOrg: tgtOrgUrl,
    ...(_runCancelled ? { cancelled: true } : {}),
    status, steps, idMapSize: Object.keys(sharedIdMap).length
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
  // NOTE: no `f.accessible` check — REST describe field objects have NO such
  // property (it's a UI-API concept), so it's undefined for every field and
  // filtering on it rejects ALL fields. That collapsed the field list to
  // ['Id'], fetched value-less records, sent 0-field payloads, and failed
  // every insert with "Required fields are missing: [LastName]". Describe
  // already only returns FLS-visible fields, so no access check is needed.
  return ['Id', ...describe.fields
    .filter(f => !SKIP.has(f.name) &&
      (f.createable || f.type === 'reference'))
    .map(f => f.name)];
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Belt-and-braces sender check (audit S9): only this extension's own pages
  // may drive the dispatcher. Safe by construction today (no
  // externally_connectable, no content-script relays) — this makes the trust
  // assumption explicit so a future manifest change can't silently expose
  // sfQuery/sfDelete/sfMetadataDeploy to less-trusted senders.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  // Page-to-page messages (Studio ↔ Toolkit): stay SILENT so the page's
  // sendResponse wins the response race — answering here (even with an
  // "unknown type" error) would beat the real recipient to the channel.
  if (message?.type === 'TOOLKIT_PING' || message?.type === 'TOOLKIT_NAVIGATE') return;
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

// ── Typed message contracts (plan A2) ───────────────────────────────────────
// Every message type dispatchMessage handles, with the fields its handler
// actually dereferences. Validated at the top of dispatchMessage so a missing
// orgUrl/sid/query/etc. fails fast with a clear error instead of surfacing as
// a confusing failure deep inside a fetch. Optional fields (tooling,
// activeTabUrl, rootWhere, childRels, limit) are deliberately NOT listed.
// NOTE: handleMessage's SESSION_EXPIRED retry re-dispatches
// { ...message, orgUrl, sid } — it only ADDS/refreshes fields on an
// already-validated message, so it always re-passes validation.
//
/** @typedef {{ type: 'GET_SF_SESSION', activeTabUrl?: string } |
 *            { type: 'GET_ALL_SF_SESSIONS' }} SessionMessage */
/** @typedef {{ type: 'SF_QUERY'|'SF_QUERY_ALL', orgUrl: string, sid: string, query: string, tooling?: boolean } |
 *            { type: 'SF_REST_QUERY', orgUrl: string, sid: string, query: string }} QueryMessage */
/** @typedef {{ type: 'SF_TOOLING_DELETE'|'SF_REST_DELETE'|'SF_TOOLING_GET', orgUrl: string, sid: string, sobject: string, id: string } |
 *            { type: 'SF_GET_METADATA', orgUrl: string, sid: string, id: string }} RecordMessage */
/** @typedef {{ type: 'SF_REST_GET'|'SF_REST_GET_TEXT', orgUrl: string, sid: string, path: string } |
 *            { type: 'SF_PATCH'|'SF_REST_POST', orgUrl: string, sid: string, path: string, body: Object }} RestPathMessage */
/** @typedef {{ type: 'SF_CREATE_FLOW', orgUrl: string, sid: string, fullName: string, metadata: Object } |
 *            { type: 'SF_METADATA_DEPLOY', orgUrl: string, sid: string, zipBase64: string }} MetadataMessage */
/** @typedef {{ type: 'SF_COLLECTIONS_CREATE'|'SF_COLLECTIONS_UPDATE', orgUrl: string, sid: string, records: Object[] } |
 *            { type: 'SF_COLLECTIONS_DELETE'|'SF_HARD_DELETE', orgUrl: string, sid: string, ids: string[] }} CollectionsMessage */
/** @typedef {{ type: 'SF_EXECUTE_PROFILE_TRANSFER', profile: Object, srcOrgUrl: string, srcSid: string, tgtOrgUrl: string, tgtSid: string } |
 *            { type: 'SF_EXECUTE_SEQUENCE', profiles: Object[], srcOrgUrl: string, srcSid: string, tgtOrgUrl: string, tgtSid: string }} TransferMessage */
/** @typedef {{ type: 'SF_RELATIONSHIP_QUERY', orgUrl: string, sid: string, rootObject: string, rootWhere?: string, childRels?: Object[], limit?: number }} RelationshipQueryMessage */
/** @typedef {SessionMessage|QueryMessage|RecordMessage|RestPathMessage|MetadataMessage|CollectionsMessage|TransferMessage|RelationshipQueryMessage} ToolkitMessage */

const MESSAGE_CONTRACTS = {
  GET_SF_SESSION:              { required: [] },
  GET_ALL_SF_SESSIONS:         { required: [] },
  SF_QUERY:                    { required: ['orgUrl', 'sid', 'query'] },
  SF_QUERY_ALL:                { required: ['orgUrl', 'sid', 'query'] },
  SF_REST_QUERY:               { required: ['orgUrl', 'sid', 'query'] },
  SF_TOOLING_DELETE:           { required: ['orgUrl', 'sid', 'sobject', 'id'] },
  SF_REST_DELETE:              { required: ['orgUrl', 'sid', 'sobject', 'id'] },
  SF_TOOLING_GET:              { required: ['orgUrl', 'sid', 'sobject', 'id'] },
  SF_GET_METADATA:             { required: ['orgUrl', 'sid', 'id'] },
  SF_CREATE_FLOW:              { required: ['orgUrl', 'sid', 'fullName', 'metadata'] },
  SF_PATCH:                    { required: ['orgUrl', 'sid', 'path', 'body'] },
  SF_REST_POST:                { required: ['orgUrl', 'sid', 'path', 'body'] },
  SF_REST_GET:                 { required: ['orgUrl', 'sid', 'path'] },
  SF_REST_GET_TEXT:            { required: ['orgUrl', 'sid', 'path'] },
  SF_METADATA_DEPLOY:          { required: ['orgUrl', 'sid', 'zipBase64'] },
  SF_COLLECTIONS_CREATE:       { required: ['orgUrl', 'sid', 'records'] },
  SF_COLLECTIONS_UPDATE:       { required: ['orgUrl', 'sid', 'records'] },
  SF_COLLECTIONS_DELETE:       { required: ['orgUrl', 'sid', 'ids'] },
  SF_HARD_DELETE:              { required: ['orgUrl', 'sid', 'ids'] },
  SF_EXECUTE_PROFILE_TRANSFER: { required: ['profile', 'srcOrgUrl', 'srcSid', 'tgtOrgUrl', 'tgtSid'] },
  SF_EXECUTE_SEQUENCE:         { required: ['profiles', 'srcOrgUrl', 'srcSid', 'tgtOrgUrl', 'tgtSid'] },
  SF_RELATIONSHIP_QUERY:       { required: ['orgUrl', 'sid', 'rootObject'] }
};

/** @param {ToolkitMessage} message */
async function dispatchMessage(message) {
  const { type, orgUrl, sid } = message;

  // Contract validation: fail fast on missing/empty required fields BEFORE any
  // network call. Unknown types fall through to the switch's default (keeps
  // the existing "Unknown message type" error). Empty arrays/objects are NOT
  // treated as missing — handlers like sfCollectionsDelete accept [] today.
  const contract = MESSAGE_CONTRACTS[type];
  if (contract) {
    const missing = contract.required.filter(f =>
      message[f] === undefined || message[f] === null || message[f] === '');
    if (missing.length) {
      throw new Error(`${type}: missing required field(s) ${missing.join(', ')} — this is an extension bug, please report it`);
    }
  }

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
    case 'SF_EXECUTE_PROFILE_TRANSFER': {
      _beginRun('transfer');
      try {
        return await executeProfileTransfer(
          message.profile,
          message.srcOrgUrl, message.srcSid,
          message.tgtOrgUrl, message.tgtSid
        );
      } finally { _endRun(); }
    }
    case 'SF_EXECUTE_SEQUENCE': {
      _beginRun('sequence');
      try {
        return await executeProfileSequence(
          message.profiles,
          message.srcOrgUrl, message.srcSid,
          message.tgtOrgUrl, message.tgtSid
        );
      } finally { _endRun(); }
    }
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

  // Read-only orgs reject every write here — the one chokepoint all REST
  // create/update/delete calls flow through (GETs pass untouched).
  if (method !== 'GET') await assertOrgWritable(orgUrl);

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

  // 1. Kick off the deployment (direct sfFetch — gate reads here explicitly)
  await assertOrgWritable(orgUrl);
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
  await assertOrgWritable(orgUrl);   // direct sfFetch below bypasses the proxy gate
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
    // Hostname-suffix match, NOT substring — a substring test passes
    // https://evil.com/?x=.my.salesforce.com (audit S9).
    return SF_URL_PATTERNS.some(p => host === p.slice(1) || host.endsWith(p));
  } catch (_) { return false; }
}

function isOrgInstanceUrl(url) {
  try {
    const host = new URL(url).hostname;
    if (SF_EXCLUDED_HOSTS.includes(host)) return false;
    // Suffix match — host.includes() passes foo.my.salesforce.com.evil.com.
    return SF_ORG_PATTERNS.some(p => host === p.slice(1) || host.endsWith(p));
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

