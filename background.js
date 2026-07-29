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

// sftkNormalizeValue + sftkMatchKey — the shared match-key engine. These are
// BYTE-FOR-BYTE copies of the canonical implementations in sftk-matching.js,
// inlined for the same reason as sftkOrgKey above (importScripts is a
// Trusted-Types sink under this worker's CSP). Smart owner matching (O1)
// builds owner keys through them, and keys MUST be built identically to every
// other consumer — normalization is part of the key. A parity unit test
// (test/owner-o1.test.mjs) fails the build if these copies and the canonical
// ones ever diverge.
function sftkNormalizeValue(v, normalize) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  const n = normalize || {};
  if (n.trim)       s = s.trim();
  if (n.collapseWs) s = s.replace(/\s+/g, ' ');
  // emailLower: lowercase only email-shaped values (contains @, no spaces) —
  // leaves non-email text alone so the toggle is safe on mixed fields.
  if (n.emailLower && s.indexOf('@') !== -1 && !/\s/.test(s.trim())) {
    s = s.toLowerCase();
  }
  // phoneDigits: reduce phone-shaped values ("(415) 555-1234 x89") to their
  // digits. Only applies when the text looks like a phone number (digits +
  // separators, 7+ digits) — never mangles ordinary text.
  if (n.phoneDigits) {
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 7 && /^[\d\s()+\-./x#*]*$/i.test(s)) s = digits;
  }
  if (n.caseFold)   s = s.toLowerCase();
  return s;
}

function sftkMatchKey(record, matching) {
  const m = matching || {};
  const fields = Array.isArray(m.fields) ? m.fields.filter(Boolean) : [];
  if (!record || !fields.length) return '';
  const norm = m.normalize || {};
  const parts = fields.map(f => sftkNormalizeValue(record[f], norm));
  if (!parts.some(p => p !== '')) return '';
  return parts.join(String.fromCharCode(1));
}

// O1 — target-side owner index for smart owner matching. Every active User
// keyed by its sftkMatchKey over matching.fields. A key hit by MORE THAN ONE
// user is ambiguous: it goes to `dups` and is EXCLUDED from byKey — a dup
// match must fall back, never guess an owner. Blank keys (every component
// empty) are unmatchable and never indexed. byKey is null-prototype so a
// user named "constructor" can't collide with Object.prototype.
function sftkBuildOwnerIndex(users, matching) {
  const byKey = Object.create(null);
  const dup = new Set();
  for (const u of (users || [])) {
    const key = sftkMatchKey(u, matching);
    if (key === '') continue;
    if (dup.has(key)) continue;
    if (key in byKey) { delete byKey[key]; dup.add(key); continue; }
    byKey[key] = u.Id;   // a falsy record already returned key '' above
  }
  return { byKey, dups: [...dup] };
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
  // Phase B — the ONE volume threshold that switches this run onto Bulk API
  // 2.0, for READS (sfBulkQuery, B2) and WRITES (sfBulkIngest) alike.
  // profile.bulkThreshold overrides it per deployment; 2000 is the default.
  // Declared once here on purpose: a second hard-coded constant further down
  // is exactly how reads and writes drift apart.
  const BULK_MIN = Number(profile?.bulkThreshold) > 0 ? Number(profile.bulkThreshold) : 2000;

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
  // O1 — smart owner matching: when the profile carries a matching config,
  // owners resolve by sftkMatchKey over the picked fields (e.g. Email + Name)
  // instead of the legacy Name-only lookup above. Sanitized like
  // sftkMatchingFromNode (max 4 fields); names must be identifier-shaped —
  // they are interpolated into SOQL and read as Owner.<field>, so anything
  // else is dropped. No usable fields → null → the legacy path, unchanged.
  const _omRaw = ownerMode ? profile.ownerMapping.matching : null;
  const _omFields = _omRaw && Array.isArray(_omRaw.fields)
    ? _omRaw.fields.filter(f => typeof f === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(f)).slice(0, 4)
    : [];
  const ownerMatching = _omFields.length
    ? { fields: _omFields, normalize: { ...(_omRaw.normalize || {}) } }
    : null;
  let ownerIndex   = null;   // { byKey, dups } — built ONCE per run, first node that needs it
  let ownerDupKeys = null;   // Set of ambiguous keys (O(1) checks in the payload loop)

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
      // O1: field-based matching additionally reads every key component off
      // the Owner relationship. Owner.Name stays regardless — log lines and
      // History labels read it. (Both read paths deliver the same shape:
      // sftkBulkRowsToRecords nests dotted CSV columns back into r.Owner.)
      const wantOwners = ownerMode && (descRes.fields || []).some(f => f.name === 'OwnerId');
      if (wantOwners) {
        fields.push('Owner.Name');
        for (const f of (ownerMatching ? ownerMatching.fields : [])) {
          if (!fields.includes('Owner.' + f)) fields.push('Owner.' + f);
        }
      }

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
      // T11b — Salesforce names the offending field by its LABEL in most save
      // errors ("…: Billing State/Province"). This map resolves BOTH the label
      // and the API name back to the API name (= the payload key), so a failed
      // record can be shown with the value we actually pushed. API names are
      // written first and labels never overwrite one — a label that collides
      // with another field's API name must not hijack it.
      const tgtFieldByAnyName = {};
      const tgtDescFields = (tgtDescRes && !tgtDescRes.error ? (tgtDescRes.fields || []) : []);
      for (const f of tgtDescFields) if (f && f.name) tgtFieldByAnyName[f.name] = f.name;
      for (const f of tgtDescFields) {
        if (f && f.label && !Object.prototype.hasOwnProperty.call(tgtFieldByAnyName, f.label)) {
          tgtFieldByAnyName[f.label] = f.name;
        }
      }
      // If the target describe failed we can still parse API-name-shaped tokens
      // out of the error, but labels won't resolve — say so once, per node,
      // rather than quietly showing fewer values than we could.
      const tgtDescribeUsable = tgtDescFields.length > 0;

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

        // ── B2: big reads go through ONE Bulk API 2.0 query job ─────────────
        // Above BULK_MIN the REST reader pages 2 000 records at a time — 20+
        // round trips for a 40 k object, each one a full JSON payload. One
        // bulk query job replaces the whole loop. Below the threshold REST is
        // faster (no job create/poll latency), so it stays the default.
        // Child nodes are deliberately NOT bulk-read: their fetch is already
        // chunked by 200 parent ids, so each query is small.
        // COUNT() decides — one tiny aggregate call, not a guess. If it fails
        // (aggregate not allowed on the object, odd WHERE) we simply stay on
        // the REST path.
        let srcCount = null;
        try {
          const cRes = await sfQuery(srcOrgUrl, srcSid,
            `SELECT COUNT() FROM ${objType}${baseWhere ? ' WHERE ' + baseWhere : ''}`, false);
          if (Number.isFinite(cRes?.totalSize)) srcCount = cRes.totalSize;
        } catch (_) { /* count is a routing hint only — never fatal */ }

        let bulkRead = null;
        if (srcCount != null && srcCount >= BULK_MIN) {
          try {
            // Bulk query hands back CSV (all strings, '' for blanks, dotted
            // parent columns) — the source describe types drive the reshape
            // back into REST-shaped records.
            const srcTypes = {};
            for (const f of (descRes.fields || [])) if (f && f.name) srcTypes[f.name] = f.type;
            bulkRead = await sfBulkQuery(srcOrgUrl, srcSid, soql, {
              fieldTypes: srcTypes,
              onProgress: p => postRunProgress({ phase: 'bulkQuery', obj: objType, objType,
                state: p.state, processed: p.processed, total: p.total }),
            });
            if (bulkRead.truncated && bulkRead.truncated.reason === 'cancelled') {
              // Cancelled mid-read: do NOT silently re-read via REST (that
              // would ignore the cancel) and do NOT write an arbitrary slice.
              errors.push(`${objType}: cancelled while reading — ${bulkRead.truncated.got} record(s) had been read, nothing was written for this object.`);
              bulkRead = { records: [] };
            } else if (bulkRead.truncated) {
              diagnostics.push(
                `${objType}: the Bulk API read returned ${bulkRead.truncated.got} of ` +
                `${bulkRead.truncated.expected == null ? 'an unknown number of' : bulkRead.truncated.expected} ` +
                `record(s) (${bulkRead.truncated.reason}) — discarded it and re-read through the REST pager so no record is missed.`);
              bulkRead = null;
            } else {
              diagnostics.push(`${objType}: ${srcCount} record(s) ≥ ${BULK_MIN} — read with one Bulk API 2.0 query job instead of ${Math.ceil(srcCount / 2000)} REST page(s).`);
            }
          } catch (e) {
            diagnostics.push(`${objType}: Bulk API read failed (${e.message}) — falling back to the REST pager; no record set was taken from the failed job.`);
            bulkRead = null;
          }
        }

        if (bulkRead) {
          recs = bulkRead.records;
        } else {
          const qRes = await sfQueryAll(srcOrgUrl, srcSid, soql, false);
          recs = qRes.records || [];
        }
      }

      // Store this node's source IDs so its children can build correct WHERE clauses
      nodeSourceIds.set(node, recs.map(r => r.Id));
      postRunProgress({ phase: 'fetched', obj: objType, count: recs.length });

      // Resolve this node's owner names against the TARGET org's users
      // (User owners only — queue-owned records won't match and fall back).
      // O1 field-based matching instead indexes ALL active target users once
      // per run — key values can't be pushed into a WHERE clause the way
      // names are (normalization happens client-side), so the index is the
      // whole table. LIMIT 4000 keeps a giant org from unbounded paging;
      // exactly 4000 rows means the cap may have bitten, so say so honestly.
      if (wantOwners && recs.length) {
        if (ownerMatching) {
          if (!ownerIndex) {
            const cols = [...new Set(['Id', 'Name', ...ownerMatching.fields])];
            const q = await sfQueryAll(tgtOrgUrl, tgtSid,
              `SELECT ${cols.join(', ')} FROM User WHERE IsActive = true LIMIT 4000`, false);
            const users = q.records || [];
            ownerIndex   = sftkBuildOwnerIndex(users, ownerMatching);
            ownerDupKeys = new Set(ownerIndex.dups);
            if (users.length === 4000) {
              diagnostics.push(`owner matching: the target org returned exactly 4000 active users — the owner index may be capped and some owners could fall back as unmatched.`);
            }
          }
        } else {
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
      // O1 adds: ownerKeyMatched (index hit), ownerKeyDup (ambiguous key —
      // excluded from the index, fell back rather than guessed).
      let ownerFellBack = 0, ownerDefaulted = 0, ownerKeyMatched = 0, ownerKeyDup = 0;

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
        // O1 field-based path: rebuild this record's key from Owner.<field>
        // values through the SAME sftkMatchKey the index used (normalization
        // is part of the key). Blank key (queue-owned, no owner data) and
        // dup key (ambiguous in the target) both fall back — never guess.
        if (wantOwners) {
          if (ownerMatching) {
            const shim = {};
            for (const f of ownerMatching.fields) shim[f] = r.Owner ? r.Owner[f] : null;
            const key = sftkMatchKey(shim, ownerMatching);
            const matched = key && ownerIndex ? ownerIndex.byKey[key] : undefined;
            const oid = matched || ownerFallback;
            if (oid && (!tgtCreatable.size || tgtCreatable.has('OwnerId'))) p.OwnerId = oid;
            if (matched) ownerKeyMatched++;
            else if (key && ownerDupKeys && ownerDupKeys.has(key)) ownerKeyDup++;
            else if (ownerFallback) ownerFellBack++; else ownerDefaulted++;
          } else {
            const oname = r.Owner ? r.Owner.Name : null;
            if (oname) {
              const matched = ownerByName.get(oname);
              const oid = matched || ownerFallback;
              if (oid && (!tgtCreatable.size || tgtCreatable.has('OwnerId'))) p.OwnerId = oid;
              if (!matched) { if (ownerFallback) ownerFellBack++; else ownerDefaulted++; }
            }
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
      let ok = 0, fail = 0, usedBulk = false;
      // B3 — records a cancelled Bulk job never even attempted. They are NOT
      // failures (nothing was rejected; the job was aborted before reaching
      // them) so they are counted and reported separately. They still land in
      // failedSourceIds so "↻ Retry failed" can finish the job.
      let notProcessed = 0;
      // T11b — how many failed records we captured payload values for. Each
      // captured record adds ~5 short strings to chrome.storage, so the
      // capture stops well before the 2000-entry failedSourceIds cap; when it
      // does, the run says so instead of the values just thinning out.
      let valuesCaptured = 0;
      const VALUE_CAPTURE_MAX = 200;
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
      // Phase B — Bulk API 2.0 above the threshold. One async job instead of
      // N synchronous 200-record calls: far fewer round trips and no API-call
      // limit pressure at volume. Below it, Collections stays faster and
      // gives instant per-record errors. Results are ALIGNED to the input
      // records either way, so everything downstream is unchanged.
      // BULK_MIN is the run-level threshold declared at the top of this
      // function — the same number gates the Bulk READ (B2) above.
      const useBulk  = payloads.length >= BULK_MIN;
      const STEP     = useBulk ? payloads.length : 200;
      if (useBulk) {
        diagnostics.push(`${objType}: ${payloads.length} record(s) ≥ ${BULK_MIN} — using Bulk API 2.0 (one async job).`);
        usedBulk = true;
      }
      for (let i = 0; i < payloads.length; i += STEP) {
        // Cancel between batches — records already written stay written
        // (allOrNone:false per batch); the summary reports the partial count.
        if (_runCancelled) {
          errors.push(`${objType}: cancelled after ${ok} of ${payloads.length} record(s).`);
          break;
        }
        const chunk = payloads.slice(i, i + STEP).map((p, k) => {
          const rec = { attributes: { type: objType }, ...p };
          // The external-Id value must be present for Salesforce to match on
          // upsert — inject it from the source record if the mapping dropped it.
          if (useUpsert && upsertField) {
            const v = recs[i + k]?.[upsertField];
            if (v != null) rec[upsertField] = v;
          }
          return rec;
        });
        let res;
        if (useBulk) {
          // Bulk speaks CSV — strip the Collections-only `attributes` wrapper.
          const flat = chunk.map(({ attributes, ...rest }) => rest);
          res = await sfBulkIngest(tgtOrgUrl, tgtSid, {
            objectType: objType,
            operation: useUpsert ? 'upsert' : 'insert',
            externalIdFieldName: upsertField || undefined,
            records: flat,
            // `obj` mirrors `objType` so the SHARED progress handler
            // (_runProgressHandler) keys this event to the object's existing
            // live row instead of opening a blank one; studio-transfer.js
            // intercepts phase:'bulk' and renders the job state in full.
            onProgress: p => postRunProgress({ phase: 'bulk', objType, obj: objType,
              state: p.state, processed: p.processed, failed: p.failed, total: p.total }),
          });
        } else {
          res = useUpsert
            ? await sfCollectionsUpsert(tgtOrgUrl, tgtSid, objType, upsertField, chunk)
            : await sfCollectionsCreate(tgtOrgUrl, tgtSid, chunk);
        }
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
            const msg = (result.errors || []).map(e => e.message).join('; ');
            // B3 — a cancelled Bulk job marks every record it never reached.
            // Those are "not attempted", not "rejected": counting them as
            // failures would report 38 000 failures for a run the user simply
            // stopped. One summary line covers them all (below), so they don't
            // flood the per-record error list either.
            const notRun = (result.errors || []).some(e => e.statusCode === 'BULK_CANCELLED');
            if (notRun) notProcessed++; else fail++;
            if (!notRun) errors.push(`${objType}: ${msg}`);
            // T11b — the message alone ("…please select a state from the list
            // of valid states.: Billing State/Province") never says WHAT was
            // pushed. Attach the offending field(s) with the exact value this
            // record sent, so History can show
            // "tried to write BillingState = "TX"".
            // Two sources, best first:
            //  1. errors[].fields — the API gives the API names outright
            //     (Collections returns it; Bulk result CSVs don't).
            //  2. sftkFieldsFromError — parses the message text and resolves
            //     labels through the target describe.
            let fieldNotes = null;
            if (!notRun && valuesCaptured < VALUE_CAPTURE_MAX) {
              const named = [];
              for (const e of (result.errors || [])) {
                for (const fn of (Array.isArray(e.fields) ? e.fields : [])) {
                  if (fn && !named.includes(fn)) named.push(fn);
                }
              }
              for (const fn of sftkFieldsFromError(msg, tgtFieldByAnyName, 5)) {
                if (fn && !named.includes(fn)) named.push(fn);
              }
              const sentPayload = payloads[i + j] || {};
              const notes = named.slice(0, 5).map(fn =>
                Object.prototype.hasOwnProperty.call(sentPayload, fn)
                  ? { field: fn, sent: sftkTruncValue(sentPayload[fn], 120) }
                  : { field: fn, absent: true });
              if (notes.length) { fieldNotes = notes; valuesCaptured++; }
            }
            // label → History links the failed record back to its SOURCE org
            // (nothing exists in the target for a failed insert).
            failedSourceIds.push({
              id: recs[i + j].Id,
              // The bulk layer already writes an accurate per-record message
              // for the cancelled case (including the "we can't tell" one) —
              // never paper over it with a generic string.
              error: msg,
              label: (nameFld && recs[i + j][nameFld]) || recs[i + j].Name || recs[i + j].Id,
              ...(fieldNotes ? { fields: fieldNotes } : {}),
              ...(notRun ? { notProcessed: true } : {}),
            });
            if (notRun) return;   // no diagnostics for a record nothing was tried on
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
          done: Math.min(i + STEP, payloads.length), total: payloads.length,
          created: ok, failed: fail });
      }
      summary[objType] = { created: ok, failed: fail,
        ...(usedBulk ? { viaBulk: true } : {}),
        ...(notProcessed ? { notProcessed } : {}) };
      // B3 — one line for everything the aborted Bulk job did not confirm.
      // "not confirmed written" rather than "never attempted": when the job's
      // result files are unreadable after an abort we genuinely cannot tell,
      // and each record's own line in ↻ Retry failed says which case it is.
      if (notProcessed) {
        errors.push(`${objType}: ${notProcessed} record(s) were not confirmed written — the Bulk job was aborted when you cancelled. Each one is listed under "↻ Retry failed" with its exact status.`);
      }
      // T11b honesty: say when the payload-value capture stopped, and when
      // labels could not be resolved because the target describe was missing.
      if (valuesCaptured >= VALUE_CAPTURE_MAX && fail > valuesCaptured) {
        diagnostics.push(`${objType}: captured the pushed field values for the first ${valuesCaptured} of ${fail} failed record(s) — capture stops at ${VALUE_CAPTURE_MAX} records to keep History inside the browser storage quota, so the rest carry the error message only.`);
      }
      if (fail > 0 && !tgtDescribeUsable) {
        diagnostics.push(`${objType}: the target describe could not be read, so field LABELS in the error text (e.g. "Billing State/Province") could not be resolved to API names — pushed values are shown only for fields the error names by API name.`);
      }
      // Owner-mapping outcome — surfaced as ⚠ notes, never failures.
      // O1 field-based matching gets ONE line with the full accounting; the
      // legacy Name-only notes below are untouched (shipped deployments read
      // them).
      if (ownerMatching) {
        if (ownerKeyMatched || ownerKeyDup || ownerFellBack || ownerDefaulted) {
          errors.push(`⚠ ${objType}: owners: ${ownerKeyMatched} matched by ${ownerMatching.fields.join('+')}, ${ownerKeyDup} dup-key → fallback, ${ownerFellBack + ownerDefaulted} unmatched → fallback${ownerFallback ? '' : ' (no fallback user set — the target org assigned its default owner)'}.`);
        }
      } else {
        if (ownerFellBack)  errors.push(`⚠ ${objType}: ${ownerFellBack} record(s) had owners with no name match in the target — assigned the fallback user.`);
        if (ownerDefaulted) errors.push(`⚠ ${objType}: ${ownerDefaulted} record(s) had owners with no name match and no fallback user is set — the target org assigned its default owner.`);
      }
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
/** @typedef {{ type: 'SF_COMPOSITE_BATCH', orgUrl: string, sid: string, subrequests: {method?: string, url: string}[], chunkSize?: number, concurrency?: number }} CompositeBatchMessage */
/** @typedef {SessionMessage|QueryMessage|RecordMessage|RestPathMessage|MetadataMessage|CollectionsMessage|TransferMessage|RelationshipQueryMessage|CompositeBatchMessage} ToolkitMessage */

const MESSAGE_CONTRACTS = {
  GET_SF_SESSION:              { required: [] },
  GET_ALL_SF_SESSIONS:         { required: [] },
  SF_QUERY:                    { required: ['orgUrl', 'sid', 'query'] },
  SF_SET_RING_SCHEDULE:        { required: ['minutes'] },
  SF_RUN_RING_PROBE:           { required: [] },
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
  SF_RELATIONSHIP_QUERY:       { required: ['orgUrl', 'sid', 'rootObject'] },
  // subrequests may legitimately be [] (nothing to read) — the validator above
  // treats an empty array as PRESENT, and the handler answers [] without
  // issuing a single HTTP call. chunkSize/concurrency are optional and, per the
  // convention at the top of this block, deliberately not listed.
  SF_COMPOSITE_BATCH:          { required: ['orgUrl', 'sid', 'subrequests'] }
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
      // Missing session fields almost always mean "no Salesforce tab is open",
      // not a code defect — a feature fired before any session existed. Say
      // that, instead of scaring the user with "extension bug" (2026-07-27
      // screenshot: raw contract error rendered in the popup's error banner).
      if (missing.every(f => f === 'orgUrl' || f === 'sid')) {
        throw new Error('Not connected to a Salesforce org — open a Salesforce org tab, then try again.');
      }
      throw new Error(`${type}: missing required field(s) ${missing.join(', ')} — this is an extension bug, please report it`);
    }
  }

  switch (type) {
    case 'GET_SF_SESSION':
      return getSfSession(message.activeTabUrl || null);
    case 'SF_SET_RING_SCHEDULE':
      return setRingSchedule(message.minutes);
    case 'SF_RUN_RING_PROBE':
      return runRingProbe();
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
    // Reads only, one round-trip per 25. Returns a per-item array aligned 1:1
    // with message.subrequests — a page keeps its own progress UI accurate by
    // sending one message per batch and driving them with its existing pool,
    // or hands over the whole list and passes concurrency to get several
    // batches in flight in a single message.
    case 'SF_COMPOSITE_BATCH':
      return sfCompositeBatch(orgUrl, sid, message.subrequests, {
        chunkSize: message.chunkSize,
        concurrency: message.concurrency
      });
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
            // Response headers, lower-cased. Bulk API 2.0 query paging lives in
            // Sforce-Locator, which is a HEADER, not part of the body. Note the
            // honest limitation: on a CROSS-origin proxy fetch the browser only
            // exposes CORS-safelisted headers, so Sforce-Locator can legitimately
            // be missing here — sfBulkQuery detects the short read and says so
            // rather than silently returning page 1 as if it were everything.
            const hdrs = {};
            try { r.headers.forEach((v, k) => { hdrs[String(k).toLowerCase()] = v; }); } catch (_) {}
            return { status: r.status, ok: r.ok, body: await r.text(), headers: hdrs };
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

// ── Write detection for the read-only-org guard ─────────────────────────────
// PURE. Answers one question for the fetch chokepoint: does this request MUTATE
// anything in the org?
//
// It used to be spelled `method !== 'GET'` inline, which is correct for every
// REST call the toolkit made — until /composite/batch. That endpoint is a POST
// whose effect is entirely decided by its subrequests: a batch of 25 GETs reads
// 25 records and writes nothing, and blocking it on a read-only org would break
// READS there, not writes.
//
// The exemption is proved, not trusted: this function parses the body that is
// about to be sent and only clears a composite/batch whose every subrequest is
// a GET. No caller-supplied "this is safe" flag exists, so no caller can lie.
// Anything unparseable, empty, or unrecognised is treated as a WRITE — the
// guard fails closed. Every non-GET caller that predates composite/batch
// (sfPost, sfPatch, sfDelete, collections, bulk PUT, metadata deploy) still
// returns true here, so their behaviour is byte-for-byte unchanged.
function sftkIsWriteRequest(method, url, bodyStr) {
  const m = String(method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD') return false;
  if (m !== 'POST') return true;
  if (!/\/composite\/batch(?:[?#]|$)/i.test(String(url || ''))) return true;
  let parsed;
  try { parsed = JSON.parse(String(bodyStr == null ? '' : bodyStr)); }
  catch (_) { return true; }          // can't read it → can't clear it
  const reqs = (parsed && Array.isArray(parsed.batchRequests)) ? parsed.batchRequests : null;
  if (!reqs || !reqs.length) return true;
  return !reqs.every(r => {
    const rm = String(r && r.method ? r.method : '').toUpperCase();
    return rm === 'GET' || rm === 'HEAD';
  });
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
  // create/update/delete calls flow through (GETs pass untouched). See
  // sftkIsWriteRequest: it is `method !== 'GET'` for every caller that existed
  // before /composite/batch, and additionally lets an all-GET composite batch
  // (a read that happens to be shaped as a POST) through after INSPECTING it.
  if (sftkIsWriteRequest(method, url, bodyStr)) await assertOrgWritable(orgUrl);

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

  // Caller headers win over the JSON defaults — Bulk API 2.0 uploads a CSV
  // batch body (Content-Type: text/csv) through this same chokepoint, so the
  // read-only-org guard above still covers it.
  const res = await sfFetch(url, {
    ...fetchOptions,
    headers: { ...authHeaders(activeSid), ...(fetchOptions.headers || {}) },
  });
  if (res.status !== 401) {
    // headers (lower-cased) travel with every response — Bulk API 2.0 query
    // paging is driven by the Sforce-Locator RESPONSE HEADER. Additive: every
    // existing caller destructures { ok, status, body } and ignores this.
    const headers = {};
    try { res.headers.forEach((v, k) => { headers[String(k).toLowerCase()] = v; }); } catch (_) {}
    return { ok: res.ok, status: res.status, body: await res.text(), headers };
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
  let serverTotal = null;

  while (url) {
    // sfFetchWithProxy handles Bearer → proxy fallback transparently
    const { ok, status, body } = await sfFetchWithProxy(orgUrl, sid, url);
    if (!ok) throw new Error(sfErrorMsg(status, body, url));
    const data = JSON.parse(body);
    // The FIRST page carries the server's own count of every matching record.
    // Keep it: callers that need a true total (cap reconciliation) would
    // otherwise have to spend a second round-trip on SELECT COUNT() to
    // re-learn a number this response already delivered for free.
    if (serverTotal === null && typeof data.totalSize === 'number') serverTotal = data.totalSize;
    records = records.concat(data.records || []);
    url = data.nextRecordsUrl ? `${orgUrl}${data.nextRecordsUrl}` : null;
  }

  // totalSize stays records.length — every existing caller reads it as
  // "rows I got". serverTotal is the separate, authoritative figure.
  return { records, totalSize: records.length, serverTotal, done: true };
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

// ═══════════════════════════════════════════════════════════════════════
// COMPOSITE BATCH — up to 25 reads in ONE HTTP round-trip
// ═══════════════════════════════════════════════════════════════════════
// The remaining cost in a large org is not truncation or fan-out, it is
// arithmetic: every per-item read (one Tooling GET per flow VERSION, one per
// Lightning page, one describe per object) is its own round-trip, so 1600
// versions is 1600 round-trips no matter how well the pool is tuned.
// /composite/batch takes up to 25 subrequests in one POST with identical
// per-subrequest semantics — the same 1600 reads become 64 round-trips.
//
// Everything below is additive. No existing caller changes, so an org that was
// never near a limit issues exactly the same requests it did before.
//
// The pure parts (chunking, url normalisation, body build, per-item
// normalisation) are top-level at column 0 so test/extract.mjs can materialise
// them — the reassembly is the part that, if it were ever wrong, would attach
// one flow's metadata to a different flow, so it is unit-tested directly rather
// than only through the network path.

// PURE. Normalise one subrequest url to the form /composite/batch actually
// speaks: a RELATIVE path that STARTS AT THE VERSION SEGMENT, e.g.
// "v62.0/tooling/sobjects/Flow/301xx000000ABCdAAO". Salesforce does NOT accept
// "/services/data/v62.0/..." inside batchRequests — that prefix is implied by
// the endpoint — and a subrequest that carries it comes back 400/404 rather
// than the record.
//
// Callers may hand in whatever they already have and it lands in the right
// shape: a fully-qualified org URL, "/services/data/v58.0/...",
// "services/data/v58.0/...", "v58.0/...", or a bare "tooling/sobjects/Flow/301"
// with no version at all. The version is rewritten to `apiVersion` — the same
// normalisation normalizePath() applies to every other path in this file — so a
// caller pinning an old version can't silently split one scan across two API
// versions. Query strings are preserved untouched.
//
// No hard-coded version lives here on purpose: every call site passes
// API_VERSION, and a second copy of "v62.0" in this file is exactly the kind of
// thing that goes stale six months after the constant at the top changes. With
// no apiVersion the url's own version is left alone (and an unversioned url is
// returned unversioned, which the server rejects loudly rather than quietly
// answering from some default version).
function sftkBatchSubUrl(url, apiVersion) {
  const ver = String(apiVersion == null ? '' : apiVersion).replace(/^\/+|\/+$/g, '').trim();
  let s = String(url == null ? '' : url).trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) {
    const slash = s.indexOf('/', s.indexOf('://') + 3);
    s = slash === -1 ? '' : s.slice(slash);
  }
  s = s.replace(/^\/+/, '').replace(/^services\/data\//i, '');
  // Nothing left to address (an origin with no path, or a bare "/services/data/"):
  // return empty rather than the version alone. "v62.0/" is a plausible-looking
  // url that addresses no record, and it would go out as a real subrequest.
  if (!s) return '';
  if (/^v\d+(?:\.\d+)?(?=[/?]|$)/i.test(s)) return ver ? s.replace(/^v\d+(?:\.\d+)?/i, ver) : s;
  return ver ? `${ver}/${s}` : s;
}

// PURE. Split subrequests into chunks of at most `size`. 25 is both the default
// and the hard ceiling — a server limit, not a tuning knob: Salesforce rejects
// a 26th subrequest, so a caller asking for 50 gets 25 rather than a 400. Junk
// sizes fall back to 25 rather than degenerating into one call per item or one
// call for everything. Input ORDER is the contract: chunk k covers input
// positions [k*size, k*size+len).
//   0 items  → []            (caller makes zero HTTP calls)
//   25 items → 1 chunk
//   26 items → 25 + 1
//   100      → 4 × 25
function sftkBatchChunks(subrequests, size) {
  const MAX = 25;
  const list = Array.isArray(subrequests) ? subrequests : [];
  let n = Math.floor(Number(size));
  if (!Number.isFinite(n) || n < 1) n = MAX;
  if (n > MAX) n = MAX;
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

// PURE. One chunk → the exact POST body Salesforce expects. Methods are
// upper-cased and default to GET; urls go through sftkBatchSubUrl. The returned
// batchRequests array is what the normaliser is handed back, so the `url` on
// every result item is the url that was really sent, not the one the caller
// happened to type.
function sftkBatchBody(chunk, apiVersion) {
  const list = Array.isArray(chunk) ? chunk : [];
  return {
    batchRequests: list.map(r => ({
      method: String((r && r.method) || 'GET').toUpperCase(),
      url: sftkBatchSubUrl(r && r.url, apiVersion)
    }))
  };
}

// PURE. Render one failed subrequest's error text from its parsed `result`
// payload. Mirrors sfErrorMsg (which works on raw text) — composite/batch has
// already parsed the sub-body for us, so the SF error shape arrives as an array
// of { message, errorCode } or a lone object.
function sftkBatchItemError(status, result, url) {
  const n = Number(status);
  const st = Number.isFinite(n) ? n : 0;
  let msg = '';
  if (Array.isArray(result)) {
    const first = result[0];
    if (first && typeof first === 'object') msg = first.message || first.errorCode || '';
    else if (typeof first === 'string') msg = first;
  } else if (result && typeof result === 'object') {
    msg = result.message || result.errorCode || '';
  } else if (typeof result === 'string') {
    msg = result;
  }
  if (msg) return `HTTP ${st}: ${String(msg).slice(0, 300)}`;
  if (!st) return `composite/batch returned no status for ${url || 'this subrequest'}`;
  return `HTTP ${st} — ${url || 'subrequest'}`;
}

// PURE. Every subrequest in a chunk marked failed with the SAME reason, used
// when the batch CALL failed rather than an individual item: non-2xx on the
// batch endpoint, an unreadable response, or a results array that cannot be
// matched to the requests. batchError:true is how a caller tells "this one item
// failed" from "the whole call failed" — the distinction matters because the
// second is retryable as a unit and the first is not.
function sftkBatchFailAll(sent, offset, message) {
  const reqs = Array.isArray(sent) ? sent : [];
  const n = Number(offset);
  const base = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  const msg = String(message || 'composite/batch call failed');
  return reqs.map((req, i) => ({
    index: base + i,
    method: String((req && req.method) || 'GET'),
    url: String((req && req.url) || ''),
    ok: false,
    status: 0,
    body: undefined,
    error: msg,
    batchError: true
  }));
}

// PURE. The lowercased authority ("host[:port]") of an absolute http(s) url,
// or '' for anything relative or unparseable. A regex rather than new URL():
// this runs once per subrequest on caller-supplied strings and must classify
// junk as "not absolute", never throw on it.
function sftkBatchUrlHost(url) {
  const m = /^https?:\/\/([^/?#]+)/i.exec(String(url == null ? '' : url).trim());
  return m ? m[1].toLowerCase() : '';
}

// PURE. The Salesforce record id a subrequest url addresses, or '' when the
// url does not address a single record. Only the canonical record-GET shape
// counts — a 15- or 18-char alphanumeric segment directly after
// /sobjects/<Type>/ — so query urls, describes, and layout paths yield ''
// (no identity claim) rather than a lookalike.
function sftkBatchRecordId(url) {
  const m = /(?:^|\/)sobjects\/[^/?#]+\/([a-zA-Z0-9]{18}|[a-zA-Z0-9]{15})(?=[/?#]|$)/i.exec(String(url == null ? '' : url));
  return m ? m[1] : '';
}

// PURE. The reassembly. Turns one { hasErrors, results:[{statusCode, result}] }
// response into per-item results aligned 1:1 with the subrequests that were
// sent, offset into the caller's original array.
//
// ALIGNMENT IS POSITIONAL, AND VERIFIED WHEREVER THE PAYLOAD CARRIES IDENTITY
// EVIDENCE. composite/batch guarantees results[i] answers batchRequests[i] and
// carries NO echo of the url naming which subrequest a result belongs to. So if
// the server ever returns a different NUMBER of results than we sent, there is
// no way to work out which slot went missing: a dropped subrequest 3 shifts
// every later answer one place left and the response still looks perfectly
// well-formed. Attaching flow B's metadata to flow A is the worst failure this
// primitive could have, so a length mismatch fails the WHOLE CHUNK loudly
// instead of aligning the ones that "probably" line up. Other chunks are
// untouched — this is a per-call verdict, not a per-run one.
//
// A SAME-length response can still be reordered or duplicated, and one class of
// subrequest lets us PROVE that: a record GET names its id in the url, and the
// record it returns names its own Id in the body. When both sides carry an id
// they must agree on the first 15 chars (the case-safe prefix shared by the
// 15- and 18-char forms of one id); a disagreement is misalignment proven, and
// the whole chunk fails exactly like a length mismatch. Results with no Id to
// check — query subrequests, 204s, error slots — stay exempt: absence of
// evidence is not mismatch.
//
// `hasErrors` is advisory only and deliberately ignored for per-item verdicts:
// the per-subrequest statusCode is the authority, and trusting a summary flag
// over the actual statuses is how a mixed batch gets reported as all-failed.
function sftkBatchNormalize(sent, parsed, offset) {
  const reqs = Array.isArray(sent) ? sent : [];
  const n = Number(offset);
  const base = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  const p = (parsed && typeof parsed === 'object') ? parsed : null;
  const results = (p && Array.isArray(p.results)) ? p.results : null;

  if (!results) {
    return sftkBatchFailAll(reqs, base, 'composite/batch response had no results array — nothing in this batch can be matched to a request');
  }
  if (results.length !== reqs.length) {
    return sftkBatchFailAll(reqs, base, `composite/batch returned ${results.length} result(s) for ${reqs.length} subrequest(s) — results cannot be matched to requests, so none of this batch is trusted`);
  }

  const items = reqs.map((req, i) => {
    const r = (results[i] && typeof results[i] === 'object') ? results[i] : {};
    const sn = Number(r.statusCode);
    const status = Number.isFinite(sn) ? sn : 0;
    const ok = status >= 200 && status < 300;
    const url = String((req && req.url) || '');
    const item = {
      index: base + i,
      method: String((req && req.method) || 'GET'),
      url,
      ok,
      status,
      body: Object.prototype.hasOwnProperty.call(r, 'result') ? r.result : undefined,
      error: undefined,
      batchError: false
    };
    if (!ok) item.error = sftkBatchItemError(status, item.body, url);
    return item;
  });

  // Identity check: a same-length response can still be reordered or
  // duplicated. Where a subrequest url addresses a record AND its 2xx result
  // body carries an Id, the two must agree on the case-safe 15-char prefix —
  // one proven disagreement means the positional alignment is broken for the
  // whole chunk, and none of it is trusted.
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.ok) continue;                                  // error slots: exempt
    const want = sftkBatchRecordId(it.url);
    if (!want) continue;                                   // no id in the url: exempt
    const b = it.body;
    const got = (b && typeof b === 'object' && !Array.isArray(b) && typeof b.Id === 'string') ? b.Id : '';
    if (!/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(got)) continue;  // no Id evidence (204s, queries): exempt
    if (got.slice(0, 15) !== want.slice(0, 15)) {
      return sftkBatchFailAll(reqs, base, `composite/batch results are misaligned: the result answering ${it.url} carries Id ${got}, a different record — results cannot be matched to requests, so none of this batch is trusted`);
    }
  }
  return items;
}

// ---------------------------------------------------------------
// sfCompositeBatch — N reads, ceil(N/25) round-trips.
//
//   subrequests : [{ method?: 'GET', url: string }]  — url relative, see
//                 sftkBatchSubUrl for the accepted forms
//   opts        : { chunkSize?   <= 25, default 25
//                   concurrency? batches IN FLIGHT, default 1 (sequential)
//                   onProgress?  (settledItems, totalItems) => void
//                   shouldStop?  () => boolean, polled before each batch }
//
// Returns an array with EXACTLY subrequests.length entries, in INPUT ORDER:
//   { index, method, url, ok, status, body, error, batchError }
// ok is true only for a 2xx subrequest; body is the parsed `result` payload;
// error is a string whenever ok is false; batchError distinguishes "the whole
// call failed" from "this item failed".
//
// Every slot is filled UNLESS shouldStop cut the run short, in which case the
// batches that were never dispatched stay `undefined` — an unread item reads as
// absent, never as a failed or empty one. Callers that pass no shouldStop are
// guaranteed a fully-populated array.
//
// One failing subrequest never fails the batch — that is the whole point of the
// per-item shape. What DOES propagate is a throw from sfFetchWithProxy, above
// all SESSION_EXPIRED: handleMessage retries the entire message with a
// refreshed sid, exactly as it does for every other read, and swallowing it
// here would turn a recoverable cookie rotation into 25 permanently-dead items.
// Under concurrency > 1 the first throw also ABORTS the run: sibling runners
// stop pulling new chunks and go quiet (no further onProgress) — the caller has
// abandoned this run, so feeding it progress from a rejected promise would be
// a lie. In-flight requests are left to settle (a fetch cannot be recalled)
// but dispatch no further work. At concurrency 1 there are no siblings and the
// throw behaves exactly as it always has.
//
// CROSS-ORG SUBREQUESTS ARE REFUSED, NOT RE-POINTED. sftkBatchSubUrl strips
// the origin off an absolute subrequest url, which for a same-org url is mere
// normalisation — but in a multi-org toolkit an absolute url whose host is NOT
// the batch org's host would silently become a read against the wrong org.
// Those items get a per-item failure ({ok:false, batchError:false}, error
// naming both hosts) WITHOUT being dispatched; the remaining items still chunk
// and align into their own slots around the refused ones. Same-host absolute
// urls stay allowed.
//
// chunkSize exists because 25 is the limit on COUNT, not on SIZE. Flow
// Metadata bodies are large; a consumer pulling full flow metadata should pass
// a smaller chunkSize (10 is a reasonable start) rather than discover the
// response ceiling as a 500. Reads of small records (describes, page
// assignments) can use the full 25.
//
// concurrency defaults to 1 so the plain primitive behaves like every other
// read helper in this file: one request at a time, in order. Callers that want
// several batches in flight ask for it explicitly.
async function sfCompositeBatch(orgUrl, sid, subrequests, opts) {
  if (!Array.isArray(subrequests)) {
    throw new Error('sfCompositeBatch: subrequests must be an array of { method, url }');
  }
  if (!subrequests.length) return [];          // zero items → zero round-trips
  const o = opts || {};
  const onProgress = typeof o.onProgress === 'function' ? o.onProgress : null;
  const shouldStop = typeof o.shouldStop === 'function' ? o.shouldStop : null;
  const url = `${orgUrl}/services/data/${API_VERSION}/composite/batch`;

  // Cross-org guard: refuse (do not dispatch) any absolute subrequest url whose
  // host provably differs from the batch org's host. dispatchIdx maps a
  // position in the dispatched list back to the caller's array, fixed here
  // before any request goes out, so refused slots never shift their neighbours.
  const orgHost = sftkBatchUrlHost(orgUrl);
  const out = new Array(subrequests.length);
  const dispatchIdx = [];
  const dispatchSubs = [];
  for (let i = 0; i < subrequests.length; i++) {
    const r = subrequests[i];
    const rawUrl = String((r && r.url) || '');
    const subHost = sftkBatchUrlHost(rawUrl);
    if (subHost && orgHost && subHost !== orgHost) {
      out[i] = {
        index: i,
        method: String((r && r.method) || 'GET'),
        url: rawUrl,
        ok: false,
        status: 0,
        body: undefined,
        error: `cross-org subrequest refused: url addresses host ${subHost} but this batch targets ${orgHost} — not dispatched`,
        batchError: false
      };
    } else {
      dispatchIdx.push(i);
      dispatchSubs.push(r);
    }
  }
  const refused = subrequests.length - dispatchSubs.length;
  const chunks = sftkBatchChunks(dispatchSubs, o.chunkSize);

  // Chunk k always lands at dispatchIdx[starts[k] ..] in the output, computed
  // BEFORE any request goes out. With concurrency > 1 batches settle out of
  // order; their destination does not move, so completion order can never
  // reorder results.
  const starts = [];
  let acc = 0;
  for (const c of chunks) { starts.push(acc); acc += c.length; }

  const limit = Math.max(1, Math.min(Math.floor(Number(o.concurrency)) || 1, chunks.length));
  let next = 0;
  let settled = refused;   // refused slots already hold their verdict
  let aborted = false;     // set on the first runner throw; siblings observe it
  if (refused && onProgress) onProgress(settled, subrequests.length);

  async function runner() {
    for (;;) {
      if (aborted) return;
      if (shouldStop && shouldStop()) return;
      const k = next++;
      if (k >= chunks.length) return;
      const offset = starts[k];
      const payload = sftkBatchBody(chunks[k], API_VERSION);
      const sent = payload.batchRequests;
      let res;
      try {
        res = await sfFetchWithProxy(orgUrl, sid, url, {
          method: 'POST',
          body: JSON.stringify(payload)
        });
      } catch (e) {
        aborted = true;    // stop siblings BEFORE the rethrow rejects the run
        throw e;
      }
      let items;
      if (!res.ok) {
        items = sftkBatchFailAll(sent, offset, sfErrorMsg(res.status, res.body, url));
      } else {
        let parsed;
        let parseOk = false;
        let parseErr = '';
        try { parsed = JSON.parse(res.body); parseOk = true; }
        catch (e) { parseErr = e.message || String(e); }
        items = parseOk
          ? sftkBatchNormalize(sent, parsed, offset)
          : sftkBatchFailAll(sent, offset, `composite/batch returned an unreadable response — ${parseErr}`);
      }
      for (let i = 0; i < items.length; i++) {
        const at = dispatchIdx[offset + i];
        out[at] = { ...items[i], index: at };
      }
      settled += items.length;
      if (onProgress && !aborted) onProgress(settled, subrequests.length);
    }
  }

  const runners = [];
  for (let r = 0; r < limit; r++) runners.push(runner());
  await Promise.all(runners);
  return out;
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
// ═══════════════════════════════════════════════════════════════════════
// BULK API 2.0 — Phase B (large-volume writes)
// ═══════════════════════════════════════════════════════════════════════
// Lives in the worker only: everything here is I/O plus the CSV codec the
// ingest endpoints speak. The pure helpers are top-level column-0 so
// test/extract.mjs can unit-test them straight out of this file (no
// importScripts — that is a Trusted Types sink in MV3 workers).

// One CSV field. Salesforce reads RFC4180: quote when the value contains a
// comma, quote or newline, and double any embedded quotes. null/undefined →
// #N/A, the Bulk API's "set this field to null" token (a bare empty string
// means "leave unchanged" on update).
function sftkCsvField(v) {
  if (v === null || v === undefined) return '#N/A';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Records → CSV document. `columns` fixes the header order; omit it and the
// union of every record's keys is used (first-seen order, stable).
function sftkRecordsToCsv(records, columns) {
  const rows = Array.isArray(records) ? records : [];
  let cols = columns;
  if (!cols) {
    cols = [];
    const seen = new Set();
    for (const r of rows) {
      for (const k of Object.keys(r || {})) {
        if (!seen.has(k)) { seen.add(k); cols.push(k); }
      }
    }
  }
  const head = cols.map(sftkCsvField).join(',');
  // A key the record simply doesn't have → EMPTY (leave alone), never #N/A.
  // #N/A is the Bulk "set this to null" token: emitting it for an absent key
  // would blank real target values on an upsert.
  const body = rows.map(r => cols.map(c =>
    (r && Object.prototype.hasOwnProperty.call(r, c)) ? sftkCsvField(r[c]) : ''
  ).join(',')).join('\n');
  return rows.length ? `${head}\n${body}\n` : `${head}\n`;
}

// CSV → array of row objects. Handles quoted fields containing commas,
// newlines and doubled quotes — Salesforce's result CSVs contain all three
// (error messages love commas). Returns [] for an empty/header-only doc.
function sftkParseCsv(text) {
  const src = String(text || '');
  if (!src.trim()) return [];
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows.shift();
  return rows
    .filter(r => r.length && !(r.length === 1 && r[0] === ''))
    .map(r => { const o = {}; header.forEach((h, i) => { o[h] = r[i] ?? ''; }); return o; });
}

// Align Bulk result rows back to the records we uploaded. Salesforce returns
// TWO CSVs (successfulResults / failedResults) — each preserves upload order
// within itself, but neither carries the original row index, so a naive
// concat scrambles which result belongs to which record. Both result CSVs DO
// echo the original columns, so correlate on the full column tuple and hand
// duplicates out in order. Any row we can't place (shouldn't happen) is
// reported as a failure rather than silently dropped. Pure — unit-testable.
// missingMsg/missingCode override the "no result row" text: a CANCELLED job
// leaves most rows unprocessed, and those must not read as rejections.
function sftkCorrelateBulkResults(uploadRows, columns, successRows, failedRows, missingMsg, missingCode) {
  const key = r => (columns || []).map(c => String(r && r[c] !== undefined && r[c] !== null ? r[c] : '')).join('');
  const buckets = new Map();
  const push = (r, success) => {
    const k = key(r);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(success
      ? { id: r['sf__Id'] || null, success: true, errors: [] }
      : { id: r['sf__Id'] || null, success: false,
          errors: [{ message: r['sf__Error'] || 'Bulk API row failed', statusCode: 'BULK_ROW_ERROR' }] });
  };
  for (const r of (successRows || [])) push(r, true);
  for (const r of (failedRows || [])) push(r, false);
  return (uploadRows || []).map(row => {
    const list = buckets.get(key(row));
    const hit = list && list.length ? list.shift() : null;
    return hit || { id: null, success: false,
      errors: [{ message: missingMsg || 'Bulk API returned no result row for this record',
                 statusCode: missingCode || 'BULK_NO_RESULT' }] };
  });
}

// ── T11b: which FIELDS does a Salesforce save error actually name? ──────────
// PURE (unit-tested in test/engine-b2-t11b.test.mjs). Real messages name the
// offending field in several different shapes:
//   "…Please select a state from the list of valid states.: Billing State/Province"
//        → trailing colon segment, comma-separated LABELS
//   "Required fields are missing: [LastName, AccountId]"   → bracketed API names
//   "No such column 'Foo__c' on entity 'Account'"          → quoted API name
//   "bad value for restricted picklist field: Hot: Rating" → trailing label
//   "Email: invalid email address: a@b"                    → leading field prefix
// describeFieldsMap maps BOTH the API name AND the label of every TARGET field
// to that field's API name (= the payload key), so labels resolve.
// Positions that are unambiguously a field name (brackets, "No such column")
// also accept an API-name-SHAPED token that the map doesn't know, so parsing
// still works when the describe is unavailable. The leading/trailing prose
// positions require a describe hit — otherwise ordinary English words in an
// error message would be reported as fields.
function sftkFieldsFromError(errorMsg, describeFieldsMap, maxFields) {
  const cap = Number(maxFields) > 0 ? Number(maxFields) : 5;
  const s = String(errorMsg == null ? '' : errorMsg);
  if (!s.trim()) return [];
  const map = describeFieldsMap || {};
  const isMap = typeof Map !== 'undefined' && map instanceof Map;
  const entries = () => (isMap ? [...map.entries()] : Object.entries(map));
  const direct = k => (isMap ? map.get(k) : (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : undefined));
  let lower = null;
  const resolve = (token, allowShape) => {
    let t = String(token == null ? '' : token).trim();
    t = t.replace(/^[[("'`]+/, '').replace(/[\])"'`.]+$/, '').trim();
    if (!t) return null;
    const hit = direct(t);
    if (hit) return hit;
    if (!lower) {
      lower = {};
      for (const [k, v] of entries()) {
        const lk = String(k).toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(lower, lk)) lower[lk] = v;
      }
    }
    const ci = lower[t.toLowerCase()];
    if (ci) return ci;
    // Unknown token: only trust it where the position guarantees a field name.
    return (allowShape && /^[A-Za-z][A-Za-z0-9_]*(?:__(?:c|r|pc|kav|mdt|e|x|b))?$/.test(t)) ? t : null;
  };
  const out = [];
  const add = (token, allowShape) => {
    const f = resolve(token, allowShape);
    if (f && out.indexOf(f) === -1) out.push(f);
  };

  // 1. Bracketed lists — "Required fields are missing: [A, B]" and the
  //    ": [Field]" suffix Salesforce appends to many statusCode messages.
  let m;
  const bracket = /\[([^\]]+)\]/g;
  while ((m = bracket.exec(s)) !== null) {
    for (const tok of m[1].split(',')) add(tok, true);
  }
  // 2. Quoted column names.
  const noCol = /No such column '([^']+)'/gi;
  while ((m = noCol.exec(s)) !== null) add(m[1], true);
  // 3. Leading "Field: message" prefix (must be a real field).
  m = s.match(/^\s*([A-Za-z0-9_./]+)\s*:\s+/);
  if (m) add(m[1], false);
  // 4. Trailing colon segment — where Salesforce parks the field LABEL(S).
  if (s.indexOf(':') !== -1) {
    const parts = s.split(':');
    const tail = parts[parts.length - 1];
    if (tail && tail.length <= 200) for (const tok of tail.split(',')) add(tok, false);
  }
  return out.slice(0, cap);
}

// One payload value rendered for display. Collapses whitespace so a multi-line
// text area can't blow up a History row, and truncates with an explicit
// "…(+N chars)" so a cut value never looks like the whole value. PURE.
function sftkTruncValue(v, maxLen) {
  const cap = Number(maxLen) > 0 ? Number(maxLen) : 120;
  if (v === undefined) return null;
  if (v === null) return 'null';
  let s;
  if (typeof v === 'string') s = v;
  else { try { s = JSON.stringify(v); } catch (_) { s = String(v); } }
  if (s === undefined) s = String(v);
  s = String(s).replace(/\s+/g, ' ').trim();
  if (s === '') return '(empty string)';
  return s.length > cap ? `${s.slice(0, cap)}…(+${s.length - cap} chars)` : s;
}

// Bulk QUERY results are CSV: every value is a STRING, a blank is '' (not
// null), and parent fields arrive as DOTTED columns ("Owner.Name"). The
// engine's payload builder relies on `v == null` to skip empties and reads
// r.Owner.Name for owner matching, so reshape bulk rows into exactly what the
// REST reader produces before they go anywhere near it. fieldTypes (API name →
// describe type) drives the only two coercions that matter; an unknown field
// stays a string, which Salesforce coerces on write — never silently wrong.
// PURE.
function sftkBulkRowsToRecords(rows, fieldTypes) {
  const types = fieldTypes || {};
  const NUMERIC = { int: 1, double: 1, currency: 1, percent: 1, long: 1 };
  return (Array.isArray(rows) ? rows : []).map(row => {
    const rec = {};
    for (const key of Object.keys(row || {})) {
      const raw = row[key];
      let v = (raw === '' || raw === undefined || raw === null) ? null : raw;
      const t = Object.prototype.hasOwnProperty.call(types, key) ? types[key] : null;
      if (v !== null && t === 'boolean') v = /^true$/i.test(String(v));
      else if (v !== null && Object.prototype.hasOwnProperty.call(NUMERIC, String(t))) {
        const n = Number(v);
        if (Number.isFinite(n)) v = n;
      }
      if (key.indexOf('.') === -1) { rec[key] = v; continue; }
      const parts = key.split('.');
      let node = rec;
      for (let p = 0; p < parts.length - 1; p++) {
        if (!node[parts[p]] || typeof node[parts[p]] !== 'object') node[parts[p]] = {};
        node = node[parts[p]];
      }
      node[parts[parts.length - 1]] = v;
    }
    return rec;
  });
}

// ── B2: Bulk API 2.0 QUERY — one async job instead of N REST pages ──────────
// create POST /jobs/query {operation, query} → poll GET /jobs/query/{id} →
// GET /jobs/query/{id}/results, following the Sforce-Locator response header
// until it stops coming back. Results are CSV, parsed with the SAME
// sftkParseCsv the ingest path uses, then reshaped by sftkBulkRowsToRecords so
// callers get REST-shaped records (typed values, nested parent objects).
//
// Returns { records, totalSize, done, truncated? }. `truncated` is set — and
// `done` is false — whenever fewer records came back than the job says it
// processed: a locator we could not read (cross-origin proxy fetch hides
// non-safelisted headers), a cancel, or a page cap. Callers MUST look at it;
// the engine discards a truncated read and re-reads through REST rather than
// transferring a silently short record set.
//
// opts: { onProgress({state, processed, total}), includeDeleted, fieldTypes,
//         maxPages }
async function sfBulkQuery(orgUrl, sid, soql, opts = {}) {
  const { onProgress, includeDeleted = false, fieldTypes = null } = opts;
  const maxPages = Number(opts.maxPages) > 0 ? Number(opts.maxPages) : 5000;
  const base   = `${orgUrl}/services/data/${API_VERSION}/jobs/query`;
  const report = p => { if (typeof onProgress === 'function') { try { onProgress(p); } catch (_) {} } };

  // A Bulk query is a READ, but starting one is an HTTP POST — which the
  // per-org read-only gate blocks by design. Rather than punch a hole in that
  // gate, say plainly why this org can't use the bulk reader; the caller falls
  // back to the REST pager and reads every record anyway.
  let created;
  try {
    created = await sfFetchWithProxy(orgUrl, sid, base, {
      method: 'POST',
      body: JSON.stringify({
        operation: includeDeleted ? 'queryAll' : 'query',
        query: soql, contentType: 'CSV', lineEnding: 'LF',
      }),
    });
  } catch (e) {
    if (/read-only/i.test(e && e.message ? e.message : '')) {
      throw new Error('this org is marked read-only, and creating a Bulk query job is an HTTP POST that the read-only gate blocks');
    }
    throw e;
  }
  if (!created.ok) throw new Error(sfErrorMsg(created.status, created.body, base));
  const job    = JSON.parse(created.body);
  const jobUrl = `${base}/${job.id}`;

  let cancelled = false;
  try {
    // 1. poll — same 1s → 5s backoff as the ingest path.
    let state = job.state || 'UploadComplete', delay = 1000, info = null;
    for (let i = 0; i < 600 && state !== 'JobComplete'; i++) {
      if (_runCancelled) { cancelled = true; break; }
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay + 500, 5000);
      const poll = await sfFetchWithProxy(orgUrl, sid, jobUrl, { method: 'GET' });
      if (!poll.ok) throw new Error(sfErrorMsg(poll.status, poll.body, jobUrl));
      info  = JSON.parse(poll.body);
      state = info.state;
      report({ state, processed: info.numberRecordsProcessed || 0, total: null });
      if (state === 'Failed' || state === 'Aborted') {
        throw new Error(`Bulk query job ${state}${info.errorMessage ? `: ${info.errorMessage}` : ''}`);
      }
    }
    if (!cancelled && state !== 'JobComplete') {
      throw new Error('Bulk query job did not finish in time — check Setup → Bulk Data Load Jobs');
    }

    const expected = info && Number.isFinite(info.numberRecordsProcessed)
      ? info.numberRecordsProcessed : null;

    // 2. download every page, following Sforce-Locator.
    let rows = [], locator = '', pages = 0, sawHeaders = false;
    if (!cancelled) {
      do {
        if (_runCancelled) { cancelled = true; break; }
        const url = `${jobUrl}/results${locator ? `?locator=${encodeURIComponent(locator)}` : ''}`;
        const res = await sfFetchWithProxy(orgUrl, sid, url, { method: 'GET' });
        if (!res.ok) throw new Error(sfErrorMsg(res.status, res.body, url));
        rows = rows.concat(sftkParseCsv(res.body));
        pages++;
        const hdrs = res.headers || null;
        if (hdrs) sawHeaders = true;
        const loc = hdrs ? (hdrs['sforce-locator'] || '') : '';
        locator = (loc && loc !== 'null') ? loc : '';
        report({ state: 'Downloading', processed: rows.length, total: expected });
      } while (locator && pages < maxPages);
    }

    const records = sftkBulkRowsToRecords(rows, fieldTypes);
    const out = { records, totalSize: records.length, done: true };
    if (cancelled) {
      out.done = false;
      out.truncated = { reason: 'cancelled', got: records.length, expected };
    } else if (expected != null && records.length < expected) {
      out.done = false;
      out.truncated = {
        reason: !sawHeaders ? 'locator header not readable'
              : (locator ? 'page cap reached' : 'short read'),
        got: records.length, expected,
      };
    }
    return out;
  } catch (e) {
    // Never leave a query job running on the org.
    try { await sfFetchWithProxy(orgUrl, sid, jobUrl, { method: 'PATCH', body: JSON.stringify({ state: 'Aborted' }) }); } catch (_) {}
    throw e;
  } finally {
    if (cancelled) {
      try { await sfFetchWithProxy(orgUrl, sid, jobUrl, { method: 'PATCH', body: JSON.stringify({ state: 'Aborted' }) }); } catch (_) {}
    }
  }
}

// Run ONE Bulk API 2.0 ingest job end to end: create → upload CSV → close →
// poll → collect per-record results. Returns SaveResult-shaped objects
// ALIGNED to the input records, so callers treat bulk and Collections
// results identically.
// onProgress({state, processed, failed}) fires on every poll.
async function sfBulkIngest(orgUrl, sid, opts) {
  const { objectType, operation, externalIdFieldName, records, onProgress } = opts || {};
  const rows = Array.isArray(records) ? records : [];
  if (!rows.length) return [];
  const base = `${orgUrl}/services/data/${API_VERSION}/jobs/ingest`;

  // 1. create
  const createBody = { object: objectType, operation: operation || 'insert',
    contentType: 'CSV', lineEnding: 'LF' };
  if (externalIdFieldName) createBody.externalIdFieldName = externalIdFieldName;
  const created = await sfFetchWithProxy(orgUrl, sid, base, { method: 'POST', body: JSON.stringify(createBody) });
  if (!created.ok) throw new Error(sfErrorMsg(created.status, created.body, base));
  const job = JSON.parse(created.body);
  const jobUrl = `${base}/${job.id}`;

  // Fix the column set once — the same order is used to build the upload CSV
  // and to correlate the result rows back to their records.
  const columns = [];
  { const seen = new Set();
    for (const r of rows) for (const k of Object.keys(r || {})) if (!seen.has(k)) { seen.add(k); columns.push(k); } }

  try {
    // 2. upload the CSV batch
    const put = await sfFetchWithProxy(orgUrl, sid, `${jobUrl}/batches`, {
      method: 'PUT', body: sftkRecordsToCsv(rows, columns), headers: { 'Content-Type': 'text/csv' },
    });
    if (!put.ok) throw new Error(sfErrorMsg(put.status, put.body, `${jobUrl}/batches`));

    // 3. close → Salesforce starts processing
    const close = await sfFetchWithProxy(orgUrl, sid, jobUrl, {
      method: 'PATCH', body: JSON.stringify({ state: 'UploadComplete' }),
    });
    if (!close.ok) throw new Error(sfErrorMsg(close.status, close.body, jobUrl));

    // 4. poll — backs off 1s → 5s; jobs are async and can take minutes
    let state = 'InProgress', delay = 1000, info = null, cancelled = false;
    for (let i = 0; i < 600 && state !== 'JobComplete'; i++) {
      // B3 — Cancel during a bulk job. The engine's between-batch check can't
      // help here: a bulk job IS one batch and can run for minutes. Abort the
      // job on the org, then salvage whatever it managed to write.
      if (_runCancelled) { cancelled = true; break; }
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay + 500, 5000);
      const poll = await sfFetchWithProxy(orgUrl, sid, jobUrl, { method: 'GET' });
      if (!poll.ok) throw new Error(sfErrorMsg(poll.status, poll.body, jobUrl));
      info = JSON.parse(poll.body);
      state = info.state;
      if (typeof onProgress === 'function') {
        try {
          onProgress({ state, processed: info.numberRecordsProcessed || 0,
            failed: info.numberRecordsFailed || 0, total: rows.length });
        } catch (_) {}
      }
      if (state === 'Failed' || state === 'Aborted') {
        throw new Error(`Bulk job ${state}${info.errorMessage ? `: ${info.errorMessage}` : ''}`);
      }
    }
    if (cancelled) {
      // Abort on the org first so it stops writing, THEN collect the partial
      // results. Records the job never reached come back flagged
      // BULK_CANCELLED, which the engine counts as "not processed" rather
      // than as failures — and lists under ↻ Retry failed so they can be
      // finished later. Records already written stay written.
      try { await sfFetchWithProxy(orgUrl, sid, jobUrl, { method: 'PATCH', body: JSON.stringify({ state: 'Aborted' }) }); } catch (_) {}
      let okC = null, badC = null;
      try { okC  = await sfFetchWithProxy(orgUrl, sid, `${jobUrl}/successfulResults/`, { method: 'GET' }); } catch (_) {}
      try { badC = await sfFetchWithProxy(orgUrl, sid, `${jobUrl}/failedResults/`,     { method: 'GET' }); } catch (_) {}
      if (typeof onProgress === 'function') {
        try { onProgress({ state: 'Aborted', processed: info?.numberRecordsProcessed || 0,
          failed: info?.numberRecordsFailed || 0, total: rows.length }); } catch (_) {}
      }
      // If neither result file could be read we do NOT know whether a given
      // record was written before the abort — say exactly that instead of
      // claiming it was untouched.
      const resultsReadable = !!(okC && okC.ok) || !!(badC && badC.ok);
      return sftkCorrelateBulkResults(rows, columns,
        okC && okC.ok  ? sftkParseCsv(okC.body)  : [],
        badC && badC.ok ? sftkParseCsv(badC.body) : [],
        resultsReadable
          ? 'Not processed — the run was cancelled and the Bulk job was aborted before this record.'
          : 'Unknown — the run was cancelled and the Bulk job was aborted, but its result files could not be read, so we cannot say whether this record was written. Check the target org before retrying it.',
        'BULK_CANCELLED');
    }
    if (state !== 'JobComplete') throw new Error('Bulk job did not finish in time — check Setup → Bulk Data Load Jobs');

    // 5. results — successful rows carry sf__Id, failures carry sf__Error.
    // Row ORDER matches the uploaded CSV, which is how each result maps back
    // to its source record.
    const okRes = await sfFetchWithProxy(orgUrl, sid, `${jobUrl}/successfulResults/`, { method: 'GET' });
    const badRes = await sfFetchWithProxy(orgUrl, sid, `${jobUrl}/failedResults/`, { method: 'GET' });
    return sftkCorrelateBulkResults(rows, columns,
      okRes.ok ? sftkParseCsv(okRes.body) : [],
      badRes.ok ? sftkParseCsv(badRes.body) : []);
  } catch (e) {
    // Never leave a job open on the org — an abandoned Open/UploadComplete job
    // holds resources and shows up in Setup as a stuck load.
    try { await sfFetchWithProxy(orgUrl, sid, jobUrl, { method: 'PATCH', body: JSON.stringify({ state: 'Aborted' }) }); } catch (_) {}
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// M4 — SCHEDULED RING DRIFT PROBE (chrome.alarms, opt-in)
// ═══════════════════════════════════════════════════════════════════════
// READ-ONLY by design. On each alarm the worker compares record COUNTS for
// every deployment root object between the ring's source of truth and every
// ring target that has a LIVE MATCHING session. A count probe catches
// added/removed records, NOT value changes — the UI says so. Scheduled
// WRITES are deliberately not a feature: unattended writes + expiring
// sessions is how orgs get corrupted.

// Summarize probe rows — pure (unit-tested from this file).
function sftkProbeSummary(rows) {
  const out = { checked: 0, drifted: 0, skipped: 0 };
  for (const r of (rows || [])) {
    if (r.skip) out.skipped++;
    else { out.checked++; if (r.drifted) out.drifted++; }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// TRACE HOTKEY (chrome.commands "toggle-trace", user 2026-07-26: "map keys
// to auto activating a trace from anywhere in the org, for example ctrl+d")
// ═══════════════════════════════════════════════════════════════════════
// Press once on any Salesforce tab → start a 60-minute debug trace for the
// CURRENT USER of that org (badge shows REC). Press again → stop it, from
// anywhere. Reuses the popup's SFTK_FlowsApex DebugLevel (the "best
// all-rounder") so no duplicate levels pile up in the org. Chrome reserves
// Ctrl+D (bookmark), so the DEFAULT is Ctrl+Shift+L — rebindable to
// anything, including Ctrl+D, at chrome://extensions/shortcuts.

const HOTKEY_TRACE_ALARM = 'sftkHotkeyTraceEnd';
const HOTKEY_LEVELS = { Workflow: 'FINER', ApexCode: 'FINEST', Database: 'INFO',
  System: 'DEBUG', Callout: 'INFO', Validation: 'INFO', Visualforce: 'INFO',
  ApexProfiling: 'INFO', Wave: 'NONE', Nba: 'NONE' };

async function sftkHotkeyBadge() {
  // Badge reflects reality: REC while a hotkey trace runs, else empty.
  try {
    const st = (await chrome.storage.local.get('sftk_hotkey_trace')).sftk_hotkey_trace;
    const live = st && st.flagId && Date.parse(st.expiresAt) > Date.now();
    chrome.action.setBadgeBackgroundColor({ color: '#C23934' });
    chrome.action.setBadgeText({ text: live ? 'REC' : '' });
    chrome.action.setTitle({ title: live
      ? `Tracing ${st.userName || 'you'} in ${new URL(st.orgUrl).hostname} until ${new Date(st.expiresAt).toLocaleTimeString()} — press the shortcut again to stop`
      : 'Salesforce Toolkit' });
  } catch (_) {}
}

async function sftkHotkeyToggleTrace() {
  const fail = async (title) => {
    try {
      chrome.action.setBadgeBackgroundColor({ color: '#C23934' });
      chrome.action.setBadgeText({ text: 'ERR' });
      chrome.action.setTitle({ title: `Trace hotkey: ${title}` });
    } catch (_) {}
    setTimeout(sftkHotkeyBadge, 6000);   // restore the truthful badge
  };
  try {
    const T = `services/data/${API_VERSION}/tooling`;
    // Toggle OFF first — works from ANY tab, not just the traced org's.
    const st = (await chrome.storage.local.get('sftk_hotkey_trace')).sftk_hotkey_trace;
    if (st && st.flagId && Date.parse(st.expiresAt) > Date.now()) {
      const sess = await sftkCookieSessFor(st.orgUrl);
      if (!sess) { await fail(`can't stop — not signed in to ${new URL(st.orgUrl).hostname}. Log in there and press again.`); return; }
      const del = await sfFetchWithProxy(st.orgUrl, sess.sid,
        `${st.orgUrl}/${T}/sobjects/TraceFlag/${st.flagId}`, { method: 'DELETE' });
      if (!del.ok && del.status !== 404) { await fail(`couldn't stop the trace (${sfErrorMsg(del.status, del.body, 'TraceFlag delete')}) — the flag is STILL ACTIVE`); return; }
      await chrome.storage.local.remove('sftk_hotkey_trace');
      try { await chrome.alarms.clear(HOTKEY_TRACE_ALARM); } catch (_) {}
      await sftkHotkeyBadge();
      return;
    }
    // Toggle ON — the org is whatever Salesforce tab is active right now.
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabUrl = tabs?.[0]?.url || '';
    if (!tabUrl || !isSalesforceUrl(tabUrl)) { await fail('the active tab is not a Salesforce org'); return; }
    const orgUrl = sfApiOrigin(new URL(tabUrl).hostname);
    const sess = await sftkCookieSessFor(orgUrl);
    if (!sess) { await fail(`no session for ${new URL(orgUrl).hostname}`); return; }

    // Who am I in this org? (userinfo first, Chatter me as fallback)
    let userId = null, userName = '';
    const u1 = await sfFetchWithProxy(orgUrl, sess.sid, `${orgUrl}/services/oauth2/userinfo`, { method: 'GET' });
    if (u1.ok) { try { const j = JSON.parse(u1.body); userId = j.user_id; userName = j.name || ''; } catch (_) {} }
    if (!userId) {
      const u2 = await sfFetchWithProxy(orgUrl, sess.sid, `${orgUrl}/services/data/${API_VERSION}/chatter/users/me`, { method: 'GET' });
      if (u2.ok) { try { const j = JSON.parse(u2.body); userId = j.id; userName = j.name || ''; } catch (_) {} }
    }
    if (!userId) { await fail('could not resolve the current user in this org'); return; }

    // DebugLevel — reuse the popup's SFTK_FlowsApex, create only if absent.
    const lq = await sfFetchWithProxy(orgUrl, sess.sid,
      `${orgUrl}/${T}/query?q=${encodeURIComponent("SELECT Id FROM DebugLevel WHERE DeveloperName='SFTK_FlowsApex' LIMIT 1")}`, { method: 'GET' });
    let lvlId = lq.ok ? (JSON.parse(lq.body).records?.[0]?.Id || null) : null;
    if (!lvlId) {
      const lc = await sfFetchWithProxy(orgUrl, sess.sid, `${orgUrl}/${T}/sobjects/DebugLevel`, {
        method: 'POST',
        body: JSON.stringify({ DeveloperName: 'SFTK_FlowsApex', MasterLabel: 'SFTK Flows + Apex', ...HOTKEY_LEVELS }),
      });
      if (!lc.ok) throw new Error(sfErrorMsg(lc.status, lc.body, 'DebugLevel create'));
      lvlId = JSON.parse(lc.body).id;
    }

    // TraceFlag — extend the user's existing USER_DEBUG flag or create one.
    const now = new Date(), exp = new Date(now.getTime() + 60 * 60 * 1000);
    const tfBody = { DebugLevelId: lvlId, StartDate: now.toISOString(), ExpirationDate: exp.toISOString() };
    const tq = await sfFetchWithProxy(orgUrl, sess.sid,
      `${orgUrl}/${T}/query?q=${encodeURIComponent(`SELECT Id FROM TraceFlag WHERE TracedEntityId='${userId}' AND LogType='USER_DEBUG' LIMIT 1`)}`, { method: 'GET' });
    const existingId = tq.ok ? (JSON.parse(tq.body).records?.[0]?.Id || null) : null;
    let flagId;
    if (existingId) {
      const p = await sfFetchWithProxy(orgUrl, sess.sid, `${orgUrl}/${T}/sobjects/TraceFlag/${existingId}`,
        { method: 'PATCH', body: JSON.stringify(tfBody) });
      if (!p.ok) throw new Error(sfErrorMsg(p.status, p.body, 'TraceFlag extend'));
      flagId = existingId;
    } else {
      const c = await sfFetchWithProxy(orgUrl, sess.sid, `${orgUrl}/${T}/sobjects/TraceFlag`,
        { method: 'POST', body: JSON.stringify({ TracedEntityId: userId, LogType: 'USER_DEBUG', ...tfBody }) });
      if (!c.ok) throw new Error(sfErrorMsg(c.status, c.body, 'TraceFlag create'));
      flagId = JSON.parse(c.body).id;
    }

    await chrome.storage.local.set({ sftk_hotkey_trace:
      { orgUrl, flagId, userId, userName, expiresAt: exp.toISOString() } });
    chrome.alarms.create(HOTKEY_TRACE_ALARM, { when: exp.getTime() });
    await sftkHotkeyBadge();
  } catch (e) {
    await fail(e.message || String(e));
  }
}

chrome.commands?.onCommand?.addListener(cmd => {
  if (cmd === 'toggle-trace') sftkHotkeyToggleTrace();
});
chrome.alarms?.onAlarm?.addListener(a => {
  if (a.name !== HOTKEY_TRACE_ALARM) return;
  chrome.storage.local.remove('sftk_hotkey_trace').catch(() => {});
  sftkHotkeyBadge();
});

// Direct cookie lookup for a SPECIFIC org — works with zero Salesforce tabs
// open (getSfSession needs a tab to build its cookie candidates). Longest
// cookie domain wins — the parent-domain-stale-sid lesson applies here too.
// Shared by the scheduled ring probe and the trace hotkey.
async function sftkCookieSessFor(url) {
  try {
    const h = new URL(url).hostname
      .replace('.lightning.force.com', '.my.salesforce.com')
      .replace('.salesforce-setup.com', '.salesforce.com');
    const cookies = await chrome.cookies.getAll({ name: 'sid', url: `https://${h}` });
    const best = (cookies || []).filter(c => c.value)
      .sort((a, b) => (b.domain || '').length - (a.domain || '').length)[0];
    if (best) return { orgUrl: `https://${h}`, sid: best.value };
  } catch (_) {}
  return null;
}

const RING_ALARM = 'sftkRingProbe';

async function setRingSchedule(minutes) {
  const mins = Number(minutes) || 0;
  try { await chrome.alarms.clear(RING_ALARM); } catch (_) {}
  if (mins > 0) chrome.alarms.create(RING_ALARM, { periodInMinutes: mins, delayInMinutes: 1 });
  // Persist on the ring so a browser restart re-asserts the schedule.
  try {
    const d = await chrome.storage.local.get('ds_ring');
    if (d.ds_ring) { d.ds_ring.scheduleMins = mins; await chrome.storage.local.set({ ds_ring: d.ds_ring }); }
  } catch (_) {}
  return { success: true, minutes: mins };
}

chrome.runtime.onStartup?.addListener(() => {
  chrome.storage.local.get('ds_ring').then(d => {
    const mins = Number(d.ds_ring?.scheduleMins) || 0;
    if (mins > 0) chrome.alarms.create(RING_ALARM, { periodInMinutes: mins });
  }).catch(() => {});
});

chrome.alarms?.onAlarm?.addListener(a => {
  if (a.name === RING_ALARM) runRingProbe().catch(() => {});
});

async function runRingProbe() {
  const d = await chrome.storage.local.get(['ds_ring', 'sftk_profiles']);
  const ring = d.ds_ring;
  if (!ring?.sourceUrl || (ring.orgs || []).length < 2) {
    return { ts: new Date().toISOString(), summary: { checked: 0, drifted: 0, skipped: 0 } };
  }
  const norm = u => {
    try {
      const h = new URL(u).hostname
        .replace('.lightning.force.com', '.my.salesforce.com')
        .replace('.salesforce-setup.com', '.salesforce.com');
      return `https://${h}`;
    } catch (_) { return (u || '').toLowerCase(); }
  };
  // Per-org session with a WRONG-ORG GUARD: getSfSession falls back to any
  // open SF tab when the requested org has none — a probe must NEVER count
  // records in a different org and call it this one.
  async function sessFor(url) {
    const direct = await sftkCookieSessFor(url);
    if (direct) return direct;
    try {
      const s = await getSfSession(url);
      if (s?.sid && norm(s.orgUrl) === norm(url)) return s;
    } catch (_) {}
    return null;
  }
  const count = async (sess, obj, where) => {
    const r = await sfQuery(sess.orgUrl, sess.sid, `SELECT COUNT() FROM ${obj}${where ? ` WHERE ${where}` : ''}`, false);
    if (r?.error) throw new Error(r.error);
    return r.totalSize ?? 0;
  };

  const ts = new Date().toISOString();
  const rows = [];
  const targets = (ring.orgs || []).filter(u => norm(u) !== norm(ring.sourceUrl));
  const profiles = (d.sftk_profiles || []).filter(p => p?.tree?.objectType).slice(0, 10);
  const srcSess = await sessFor(ring.sourceUrl);
  if (!srcSess) {
    rows.push({ skip: 'source', reason: 'source of truth is not signed in in this Chrome profile — nothing probed' });
  } else {
    for (const p of profiles) {
      const obj = p.tree.objectType;
      if (Array.isArray(p.tree.recordIds) && p.tree.recordIds.length) {
        rows.push({ profileId: p.id, profileName: p.name, obj, skip: 'picked',
          reason: 'uses hand-picked records — a count probe would be meaningless; run a full scan' });
        continue;
      }
      let srcCount;
      try { srcCount = await count(srcSess, obj, p.tree.where); }
      catch (e) {
        rows.push({ profileId: p.id, profileName: p.name, obj, skip: 'src-query', reason: `source count failed: ${e.message}` });
        continue;
      }
      for (const tgt of targets) {
        const tgtSess = await sessFor(tgt);
        if (!tgtSess) {
          rows.push({ profileId: p.id, profileName: p.name, obj, tgt, skip: 'session',
            reason: 'not signed in — not probed' });
          continue;
        }
        try {
          const tgtCount = await count(tgtSess, obj, p.tree.where);
          rows.push({ profileId: p.id, profileName: p.name, obj, tgt, srcCount, tgtCount,
            drifted: srcCount !== tgtCount });
        } catch (e) {
          rows.push({ profileId: p.id, profileName: p.name, obj, tgt, skip: 'tgt-query', reason: e.message });
        }
      }
    }
  }
  const summary = sftkProbeSummary(rows);
  try { await chrome.storage.local.set({ ds_sched_drift: { ts, rows, summary } }); } catch (_) {}
  // Badge = number of drifted pairs; cleared when the ring view is opened.
  try {
    chrome.action.setBadgeBackgroundColor({ color: '#C23934' });
    chrome.action.setBadgeText({ text: summary.drifted ? String(summary.drifted) : '' });
  } catch (_) {}
  return { ts, summary };
}

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
      // e.g. "acme-dev.develop.my.salesforce.com" → slug "acme-dev"
      // matches "acme-dev.develop.lightning.force.com" tab perfectly.
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
  // paths tie — this means a stale shared-domain cookie (e.g. another org's
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

