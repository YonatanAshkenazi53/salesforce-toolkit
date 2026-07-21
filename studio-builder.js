'use strict';
// ════════════════════════════════════════════════════════════════
// PROFILE BUILDER — Object Tree Editor
// ════════════════════════════════════════════════════════════════
function openProfileBuilder(existingProfile) {
  window._bldSrcOverride = false;   // fresh builder → source follows the ring again
  _editingProfile = existingProfile
    ? JSON.parse(JSON.stringify(existingProfile))
    : {
        id: genId('prof'),
        name: 'New Profile',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // New profiles start with the working pair (still editable below).
        sourceOrg: _workingPair.src || '',
        targetOrg: _workingPair.tgt || '',
        // Diff configuration — drives the "is record X already in target?"
        // signal in the Pick Records modal + the "drift" summary on cards.
        // matchField is the field used as cross-org record identity (since
        // Salesforce Ids differ between orgs). compareFields, if any, drive
        // the "changed" bucket — records present in both orgs but with
        // different values on these fields.
        scanConfig: { matchField: 'Name', compareFields: [] },
        // Populated by `runDiffScan` — kept on the profile so the badges
        // survive page reloads. Shape: see runDiffScan return value.
        lastScan:   null,
        tree: null
      };

  // Backfill defaults for older profiles that pre-date the org-on-profile move.
  // We try to pick something sensible: if the profile already has a schedule,
  // reuse its orgs; otherwise leave blank so the builder shows "— Select org —".
  if (_editingProfile.sourceOrg === undefined) {
    _editingProfile.sourceOrg = _editingProfile.schedule?.sourceOrg || '';
  }
  if (_editingProfile.targetOrg === undefined) {
    _editingProfile.targetOrg = _editingProfile.schedule?.targetOrg || '';
  }
  // Backfill scanConfig for legacy profiles
  if (!_editingProfile.scanConfig) {
    _editingProfile.scanConfig = { matchField: 'Name', compareFields: [] };
  }

  // Attach _meta to each node
  attachMeta(_editingProfile.tree);

  renderBuilder();
}

function attachMeta(node) {
  if (!node) return;
  node._meta = node._meta || {
    count: null, expanded: true, loading: false,
    relsLoaded: false, availableRels: [],
    fieldsLoaded: false, availableFields: []
  };
  (node.children || []).forEach(attachMeta);
}

function renderBuilder() {
  const p = _editingProfile;
  setMain(`
    <div class="ds-view-header">
      <h2 class="ds-view-title">📦 Profile Builder</h2>
      <div class="ds-builder-hdr-btns">
        ${p.tree ? `<button class="ds-btn" id="dsPreviewAllBtn" title="Count records for every node in parallel">👁 Preview All</button>
        <button class="ds-btn" id="dsBldCheckTargets" title="Describe every ring target and verify the tree's objects + every mapped field exist there — the multi-org answer to 'which org will this break in?'">🧪 Check all targets</button>` : ''}
        <button class="ds-btn" id="dsBuilderCancel">Cancel</button>
        <button class="ds-btn" id="dsBuilderSave">💾 Save</button>
        ${p.tree ? `<button class="ds-btn ds-btn-primary" id="dsBuilderSaveRun"
          title="Save the profile and immediately jump to the Run screen">💾 Save &amp; Run ▶</button>` : ''}
      </div>
    </div>

    <div class="ds-builder-wrap">
      <div class="ds-builder-name-row">
        <label class="ds-lbl">Profile Name</label>
        <input id="dsProfileName" class="ds-input ds-input-lg" value="${esc(p.name)}" placeholder="e.g. Account + Contacts">
      </div>

      ${(() => {
        // Multi-org reframe (user 2026-07-20: "the source and target thing
        // doesn't work any more"): with a Sync Ring, the SOURCE is the ring's
        // source of truth — locked, with an explicit escape hatch for the
        // rare intentional off-ring deployment. The TARGET becomes a
        // REFERENCE target: it drives field mapping, previews and the default
        // scan — the actual orgs written to are picked at run time (▶ Run,
        // 🌐 Multi-org, Sync Ring, 🌳 Tree diff).
        const ls = _liveOrgSet();
        const ringSrc = (typeof _ring === 'object' && _ring?.sourceUrl && (_ring.orgs || []).length >= 2) ? _ring.sourceUrl : '';
        const srcLocked = !!ringSrc && !window._bldSrcOverride &&
          (!p.sourceOrg || _orgKey(p.sourceOrg) === _orgKey(ringSrc));
        if (srcLocked) p.sourceOrg = ringSrc;
        // Default reference target: the first ring target.
        if (ringSrc && !p.targetOrg) {
          p.targetOrg = (_ring.orgs || []).find(u => _orgKey(u) !== _orgKey(ringSrc)) || '';
        }
        const orgOpts = sel => allMapOrgs().map(o =>
          `<option value="${esc(o.url)}" ${sel === o.url ? 'selected' : ''}>${esc(orgOptionLabel(o.url, o.label, ls))}</option>`).join('');
        return `
      <div class="ds-builder-orgs-row">
        <div class="ds-builder-org-col">
          <label class="ds-lbl">Source <span class="ds-builder-org-hint">(where records come FROM)</span></label>
          ${srcLocked
            ? `<div class="ds-pk-sot-line" style="padding:9px 2px" title="Locked to your Sync Ring's source of truth — every multi-org surface flows FROM it. Change it in 🔄 Sync Ring or the topbar chip.">
                 👑 <strong>${esc(orgLabel(ringSrc))}</strong> — your source of truth
                 <a href="#" id="dsBldSrcUnlock" style="font-size:11px;margin-left:8px">use a different source…</a>
               </div>`
            : `<select id="dsProfileSrcOrg" class="ds-input">
                <option value="">— Select source org —</option>${orgOpts(p.sourceOrg)}
              </select>
              ${ringSrc && p.sourceOrg && _orgKey(p.sourceOrg) !== _orgKey(ringSrc)
                ? `<div style="font-size:11px;color:#92400e;margin-top:3px">⚠ not your 👑 source of truth (${esc(orgLabel(ringSrc))}) — this deployment will show as off-ring</div>` : ''}`}
        </div>
        ${srcLocked ? '' : `<button class="ds-builder-orgs-arrow ds-builder-orgs-swap" id="dsProfileSwapOrgs"
          title="Swap source and target orgs — also inverts field mappings and clears picked records (they belong to the old source org)">⇄</button>`}
        <div class="ds-builder-org-col">
          <label class="ds-lbl">Schema reference <span class="ds-builder-org-hint">(field mapping &amp; previews are built against THIS org's schema — actual targets are picked at run time; 🧪 Check all targets validates the whole ring)</span></label>
          <select id="dsProfileTgtOrg" class="ds-input">
            <option value="">— Select schema reference org —</option>${orgOpts(p.targetOrg)}
          </select>
        </div>
      </div>`;
      })()}

      <div class="ds-builder-owner-row">
        <label class="ds-lbl">Record owners
          <span class="ds-builder-org-hint">(users differ between orgs — pick how owners transfer)</span>
        </label>
        <div class="ds-builder-owner-ctls">
          <select id="dsProfileOwnerMode" class="ds-input">
            <option value="skip"  ${p.ownerMapping?.mode !== 'match' ? 'selected' : ''}>Don't copy owners — the target assigns its default (the running user)</option>
            <option value="match" ${p.ownerMapping?.mode === 'match' ? 'selected' : ''}>Match owner by name in the target; unmatched → a fallback user</option>
          </select>
          <select id="dsProfileOwnerFallback" class="ds-input" style="${p.ownerMapping?.mode === 'match' ? '' : 'display:none'}">
            <option value="">${p.ownerMapping?.fallbackUserId ? esc(p.ownerMapping.fallbackUserName || 'saved fallback user') : '— fallback user (loads from target org) —'}</option>
          </select>
        </div>
        <div id="dsProfileOwnerHint" class="ds-builder-owner-hint"></div>
      </div>

      <!-- Diff config is now DERIVED, not configured here.
           Match field defaults to Name and auto-falls-back to the object's
           describe-flagged nameField (e.g. ReturnOrderNumber, CaseNumber)
           when Name doesn't exist. Compare fields are taken from the root
           node's Field Mapping — the user already declared which fields
           matter when they mapped them, no need to ask again. -->

      <div class="ds-section-title">Object Tree</div>

      ${!p.tree ? `
        <div class="ds-builder-root-picker">
          <label class="ds-lbl">Root Object Type</label>
          <div class="ds-builder-root-row">
            <!-- Prepopulated from the SOURCE org (user 2026-07-20: "select
                 objects from a prepopulated list") — the text input is only
                 the fallback when the source org isn't open in a tab. -->
            <select id="dsRootObjSel" class="ds-input" style="display:none"></select>
            <input id="dsRootObj" class="ds-input" placeholder="Loading objects from the source org…">
            <button class="ds-btn ds-btn-primary" id="dsSetRoot">Set Root</button>
          </div>
        </div>` : `
        <div id="dsTreeArea" class="ds-tree-area">
          ${renderTreeNode(p.tree, [], true)}
        </div>
        <div id="dsPreviewBanner" class="ds-preview-banner" style="display:none"></div>
        <div id="dsSOQLPane" class="ds-soql-pane"></div>`}
    </div>
  `);

  eid('dsBuilderCancel')?.addEventListener('click', () => renderProfiles());
  eid('dsBuilderSave')?.addEventListener('click', () => saveProfile());
  eid('dsSetRoot')?.addEventListener('click', () => setRootObject());
  eid('dsPreviewAllBtn')?.addEventListener('click', () => previewAll());
  eid('dsBldCheckTargets')?.addEventListener('click', () => _bldCheckAllTargets());

  // Save & Run — commit the profile, then jump straight to the Run page.
  // Saves two clicks for the most common path (you just configured it; you
  // want to run it).
  eid('dsBuilderSaveRun')?.addEventListener('click', async () => {
    const profileId = _editingProfile?.id;
    // Block if orgs aren't set — the Run page would refuse anyway
    if (!_editingProfile?.sourceOrg || !_editingProfile?.targetOrg) {
      showToast('Set source and target orgs before running.', 'error', 4000);
      return;
    }
    await commitEditingProfile();
    window.runProfile?.(profileId);
  });

  // Profile-level org selectors. These are the source of truth for which orgs
  // a transfer (or schedule) runs between — the old Transfer page used to ask
  // separately at run time, which both duplicated state and gave the user
  // accidental "wrong org" exposure.
  eid('dsProfileSrcOrg')?.addEventListener('change', e => {
    _editingProfile.sourceOrg = e.target.value || '';
    _bldLoadRootObjects();   // the root-object list comes from the source org
  });
  eid('dsProfileTgtOrg')?.addEventListener('change', e => { _editingProfile.targetOrg = e.target.value || ''; });
  // Escape hatch from the 👑-locked source — reveals the plain org select
  // (the off-ring warning under it keeps the divergence visible).
  eid('dsBldSrcUnlock')?.addEventListener('click', e => {
    e.preventDefault();
    window._bldSrcOverride = true;
    renderBuilder();
  });
  _bldLoadRootObjects();

  // ── Owner handling ──────────────────────────────────────────────
  // 'skip' (default): owners never copy — target assigns its default.
  // 'match': resolve the source owner's NAME to a target user at write
  // time; unmatched owners get the fallback user picked here. The user
  // list loads live from the TARGET org (must be open in a tab).
  async function loadOwnerFallbackUsers() {
    const sel  = eid('dsProfileOwnerFallback');
    const hint = eid('dsProfileOwnerHint');
    if (!sel) return;
    if (!_editingProfile.targetOrg) {
      if (hint) hint.textContent = 'Pick a target org first — the fallback user comes from there.';
      return;
    }
    const sess = _resolveSession(_editingProfile.targetOrg, _buildAllSessions());
    if (!sess?.sid) {
      if (hint) hint.textContent = `Open ${orgLabel(_editingProfile.targetOrg)} in a Chrome tab to load its users.`;
      return;
    }
    if (hint) hint.textContent = 'Loading users…';
    const q = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid,
      query: `SELECT Id, Name, Username FROM User WHERE IsActive = true AND UserType = 'Standard' ORDER BY Name LIMIT 500` });
    if (q?.error || !Array.isArray(q?.records)) {
      if (hint) hint.textContent = `Couldn't load users: ${q?.error || 'no response'}`;
      return;
    }
    const cur = _editingProfile.ownerMapping?.fallbackUserId || '';
    sel.innerHTML = `<option value="">— fallback user (used when the owner has no name match) —</option>` +
      q.records.map(u =>
        `<option value="${esc(u.Id)}" data-name="${esc(u.Name)}" ${u.Id === cur ? 'selected' : ''}>${esc(u.Name)} (${esc(u.Username)})</option>`
      ).join('');
    if (hint) hint.textContent = cur && !q.records.some(u => u.Id === cur)
      ? '⚠ The saved fallback user was not found (deactivated?) — pick another.'
      : `${q.records.length} active user(s) in ${orgLabel(_editingProfile.targetOrg)}.`;
  }
  eid('dsProfileOwnerMode')?.addEventListener('change', e => {
    const mode = e.target.value;
    const sel  = eid('dsProfileOwnerFallback');
    if (mode === 'match') {
      _editingProfile.ownerMapping = { mode: 'match',
        fallbackUserId:   _editingProfile.ownerMapping?.fallbackUserId   || null,
        fallbackUserName: _editingProfile.ownerMapping?.fallbackUserName || null };
      if (sel) sel.style.display = '';
      loadOwnerFallbackUsers();
    } else {
      delete _editingProfile.ownerMapping;
      if (sel) sel.style.display = 'none';
      const hint = eid('dsProfileOwnerHint');
      if (hint) hint.textContent = '';
    }
  });
  eid('dsProfileOwnerFallback')?.addEventListener('change', e => {
    if (!_editingProfile.ownerMapping) _editingProfile.ownerMapping = { mode: 'match' };
    const opt = e.target.selectedOptions?.[0];
    _editingProfile.ownerMapping.fallbackUserId   = e.target.value || null;
    _editingProfile.ownerMapping.fallbackUserName = opt?.dataset?.name || null;
  });
  if (_editingProfile.ownerMapping?.mode === 'match') loadOwnerFallbackUsers();

  // ⇄ Swap orgs — a REAL swap, not just two dropdown flips. Direction-
  // sensitive config has to follow the orgs or it silently points the
  // wrong way afterwards:
  //   • fieldMappings ({srcField → tgtField}) get INVERTED per node
  //   • matchField / matchFieldTgt swap per node
  //   • picked recordIds are CLEARED — they're record Ids from the old
  //     source org and match nothing in the new one (the "Records 20 but
  //     count 0" confusion)
  //   • lastScan is dropped (its buckets/ids are direction-specific)
  eid('dsProfileSwapOrgs')?.addEventListener('click', () => {
    const doSwap = () => {
      const prof = _editingProfile;
      [prof.sourceOrg, prof.targetOrg] = [prof.targetOrg || '', prof.sourceOrg || ''];
      let clearedPicks = 0;
      const droppedMappings = [];
      (function walk(node) {
        if (!node) return;
        const fm = node.fieldMappings || {};
        const inv = {};
        for (const [s, t] of Object.entries(fm)) {
          if (t === null) { inv[s] = null; continue; }   // exclusions keep their meaning
          if (!t) continue;
          // Collision: two source fields map to the SAME target — the inverse
          // is ambiguous, and silently overwriting used to shuffle names
          // between neighboring fields across swaps (MailingState ending up
          // mapped to MailingStreet…). Identity wins; the other rename is
          // dropped LOUDLY so the user knows to re-map it.
          if (Object.prototype.hasOwnProperty.call(inv, t)) {
            if (t === s) { droppedMappings.push(`${inv[t]} → ${t}`); inv[t] = s; }
            else droppedMappings.push(`${s} → ${t}`);
            continue;
          }
          inv[t] = s;                              // rename flips direction
        }
        node.fieldMappings = inv;
        const mf = node.matchField, mft = node.matchFieldTgt;
        node.matchField    = mft || mf || null;
        node.matchFieldTgt = mf  || mft || null;
        if (node.recordIds?.length) { clearedPicks += node.recordIds.length; node.recordIds = null; }
        if (node._meta) node._meta.count = null;   // stale — was counted in the old source
        (node.children || []).forEach(walk);
      })(prof.tree);
      delete prof.lastScan;
      // Reflect in the UI: dropdowns + tree badges.
      const s = eid('dsProfileSrcOrg'), t = eid('dsProfileTgtOrg');
      if (s) s.value = prof.sourceOrg || '';
      if (t) t.value = prof.targetOrg || '';
      refreshTree();
      showToast(`Orgs swapped ⇄ — field mappings inverted${clearedPicks ? `, ${clearedPicks} picked record(s) cleared (they belonged to the old source org)` : ''}${droppedMappings.length ? `. ⚠ ${droppedMappings.length} ambiguous mapping(s) dropped (${droppedMappings.slice(0, 3).join(', ')}${droppedMappings.length > 3 ? ', …' : ''}) — two fields mapped to the same target; re-map them in Fields & mapping` : ''}.`, droppedMappings.length ? 'warning' : 'info', droppedMappings.length ? 8000 : 5500);
    };
    // Picked records are destroyed by a swap — confirm when any exist.
    let pickCount = 0;
    (function count(node) { if (!node) return; pickCount += node.recordIds?.length || 0; (node.children || []).forEach(count); })(_editingProfile.tree);
    if (pickCount > 0) {
      showModal(`
        <div class="ds-modal-header">⇄ Swap source and target?</div>
        <div class="ds-modal-body">
          Field mappings will be inverted to match the new direction.<br><br>
          ⚠ <strong>${pickCount} picked record(s)</strong> will be cleared — record Ids belong
          to the old source org and won't exist in the new one. You can re-pick after swapping.
        </div>
        <div class="ds-modal-footer">
          <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
          <button class="ds-btn ds-btn-primary" id="dsSwapOrgsOk">⇄ Swap</button>
        </div>`);
      eid('dsSwapOrgsOk')?.addEventListener('click', () => { closeModal(); doSwap(); });
    } else {
      doSwap();
    }
  });

  // Diff config is no longer exposed as inputs — see deriveScanConfig() below.
  // The user configures field interest exactly once, via the Field Mapping
  // modal on the root node. Match field is auto-derived (defaults to Name
  // with describe-based fallback).

  if (p.tree) {
    wireTreeEvents();
    refreshSOQLPreview();
    if (p.tree._meta.relsLoaded) { /* already loaded */ }
    else loadNodeRels(p.tree, []);
  }
}

// Populate the root-object PICKLIST from the source org's object list.
// Cached per org key; falls back to the free-text input when the source
// org has no live session.
let _bldObjCache = {};
async function _bldLoadRootObjects() {
  const sel = eid('dsRootObjSel');
  const inp = eid('dsRootObj');
  if (!sel || !inp) return;   // tree already set — no root picker on screen
  const srcUrl = _editingProfile?.sourceOrg;
  const fallback = msg => { inp.placeholder = msg; };
  if (!srcUrl) { fallback('Pick a source org first — or type the API name (Account, Case__c…)'); return; }
  const key = _orgKey(srcUrl);
  let list = _bldObjCache[key];
  if (!list) {
    const sess = await getOrgSession(srcUrl);
    if (!sess) { fallback(`${orgLabel(srcUrl)} isn't open in a tab — type the API name (Account, Case__c…)`); return; }
    const res = await sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
      path: 'services/data/v62.0/sobjects' });
    if (res?.error || !Array.isArray(res?.sobjects)) { fallback('Object list unavailable — type the API name (Account, Case__c…)'); return; }
    list = res.sobjects
      .filter(o => o.queryable && o.createable && o.name)
      .map(o => ({ name: o.name, label: o.label || o.name }))
      .sort((a, b) => a.label.localeCompare(b.label));
    _bldObjCache[key] = list;
  }
  if (!eid('dsRootObjSel')) return;   // view changed while loading
  sel.innerHTML = `<option value="">— Pick the root object —</option>` +
    list.map(o => `<option value="${esc(o.name)}">${esc(o.label)} (${esc(o.name)})</option>`).join('');
  sel.style.display = '';
  inp.style.display = 'none';
}

function setRootObject() {
  const selVal = (eid('dsRootObjSel')?.value || '').trim();
  const objType = selVal || (eid('dsRootObj')?.value || '').trim();
  if (!objType) return;
  _editingProfile.tree = {
    objectType: objType,
    where: '',
    children: [],
    _meta: { count: null, expanded: true, loading: false, relsLoaded: false, availableRels: [] }
  };
  renderBuilder();
}

// Feature 4 — Field dependency warning helpers
// System lookup objects that are always "safe" (present in every org)
const SYSTEM_LOOKUP_OBJS = new Set([
  'User','Group','RecordType','Profile','Organization',
  'BusinessHours','UserRole','Territory2','Territory2Type',
]);

// Compare the tree against ONE org's describes (the multi-org schema check).
// describes: { objName: describeJson | null } — null = object missing there.
// Returns gaps: [{ object, missing:'object' } | { object, field, link? }].
// A null mapping means "excluded on purpose" and is never a gap; an
// unmapped/empty mapping assumes the same name on the target. Pure.
function bldSchemaGaps(tree, describes) {
  const gaps = [];
  const walk = node => {
    if (!node) return;
    const obj = node.objectType || node.childSObject;
    if (!obj) return;
    const d = describes[obj];
    if (!d) { gaps.push({ object: obj, missing: 'object' }); return; }
    const have = new Set((d.fields || []).map(f => f.name));
    for (const [srcF, tgtF] of Object.entries(node.fieldMappings || {})) {
      if (tgtF === null) continue;
      const name = (tgtF === undefined || tgtF === '') ? srcF : tgtF;
      if (!have.has(name)) gaps.push({ object: obj, field: name });
    }
    if (node.field && !have.has(node.field)) gaps.push({ object: obj, field: node.field, link: true });
    (node.children || []).forEach(walk);
  };
  walk(tree);
  return gaps;
}

// 🧪 Check the tree against EVERY ring target (fallback: the schema
// reference org) — which org would this deployment break in, before any run.
async function _bldCheckAllTargets() {
  const p = _editingProfile;
  if (!p?.tree) return;
  const ringSrc = (typeof _ring === 'object' && _ring?.sourceUrl && (_ring.orgs || []).length >= 2) ? _ring.sourceUrl : '';
  const targets = ringSrc
    ? (_ring.orgs || []).filter(u => _orgKey(u) !== _orgKey(ringSrc))
    : (p.targetOrg ? [p.targetOrg] : []);
  if (!targets.length) { showToast('No targets known — configure the Sync Ring or a schema reference org', 'warning', 5000); return; }
  const objs = [...collectTreeObjects(p.tree)];
  showModal(`
    <div class="ds-modal-header">🧪 Schema check — ${esc(p.name)}</div>
    <div class="ds-modal-body">
      <p style="font-size:12px;margin:0 0 8px">Verifying the tree's ${objs.length} object(s) and every mapped field against each target's schema…</p>
      <div id="dsBldChkRows">${window.sftkCatSm ? sftkCatSm('Describing targets…') : '…'}</div>
    </div>
    <div class="ds-modal-footer"><button class="ds-btn" data-dsaction="closeModal">Close</button></div>`);
  const rows = [];
  for (const url of targets) {
    const label = orgLabel(url);
    const sess = await getOrgSession(url);
    if (!sess) { rows.push(`<div class="ds-plan-org"><strong>${esc(label)}</strong> — ⏭ not open in a tab, skipped</div>`); continue; }
    const describes = {};
    for (const obj of objs) {
      try {
        const d = await describe(obj, sess.orgUrl, sess.sid);
        describes[obj] = (d && !d.error && Array.isArray(d.fields)) ? d : null;
      } catch (_) { describes[obj] = null; }
    }
    const gaps = bldSchemaGaps(p.tree, describes);
    rows.push(`<div class="ds-plan-org"><strong>${esc(label)}</strong> ${prodBadge(url)}
      ${gaps.length
        ? `<div style="margin-top:4px">${gaps.map(g => g.missing === 'object'
            ? `<div class="ds-plan-rrow">⚠ object <strong>${esc(g.object)}</strong> does not exist here — the whole node would fail</div>`
            : `<div class="ds-plan-rrow">⚠ ${esc(g.object)}.<strong>${esc(g.field)}</strong> missing${g.link ? ' (the parent link field!)' : ''} — records would ${g.link ? 'fail' : 'drop this field'}</div>`).join('')}
          </div>`
        : `<span class="ds-ring-clean">✓ compatible — every object &amp; mapped field exists</span>`}
    </div>`);
    const el = eid('dsBldChkRows');
    if (el) el.innerHTML = rows.join('');
  }
  const el = eid('dsBldChkRows');
  if (el) el.innerHTML = rows.join('') || '<div class="ds-pk-note">Nothing checked.</div>';
}

// Collect all objectType/childSObject values in a tree
function collectTreeObjects(node, set = new Set()) {
  if (!node) return set;
  const name = node.objectType || node.childSObject;
  if (name) set.add(name);
  (node.children || []).forEach(c => collectTreeObjects(c, set));
  return set;
}

// Compute lookup-dependency warnings for a node
// Returns array of { fieldName, fieldLabel, referenceTo[] }
function fieldDependencyWarnings(node) {
  if (!node.fields?.length || !node._meta?.availableFields?.length) return [];
  if (!_editingProfile?.tree) return [];
  const treeObjs   = collectTreeObjects(_editingProfile.tree);
  const warnings   = [];
  for (const fieldName of node.fields) {
    const meta = node._meta.availableFields.find(f => f.name === fieldName);
    if (!meta || meta.type !== 'reference') continue;
    // Skip system fields
    if (meta.referenceTo.every(r => SYSTEM_LOOKUP_OBJS.has(r))) continue;
    // Warn if none of the referenced objects are in the tree
    const covered = meta.referenceTo.some(r => treeObjs.has(r));
    if (!covered) warnings.push({ fieldName, fieldLabel: meta.label, referenceTo: meta.referenceTo });
  }
  return warnings;
}

// ════════════════════════════════════════════════════════════════
// LOOKUP RESOLUTION — returns reference fields that need explicit
// cross-org mapping (not system fields, not covered by the tree).
// ════════════════════════════════════════════════════════════════
function getResolvableReferenceFields(node) {
  if (!node._meta?.availableFields?.length) return [];

  // Objects already in the tree → auto-remapped via idMap in background.js
  const treeObjs = _editingProfile?.tree ? collectTreeObjects(_editingProfile.tree) : new Set();

  // When node.fields is set, only show selected reference fields;
  // otherwise all createable reference fields need potential resolution.
  const hasExplicitFields = Array.isArray(node.fields) && node.fields.length > 0;
  const selectedSet = hasExplicitFields ? new Set(node.fields) : null;

  return node._meta.availableFields.filter(f => {
    if (f.type !== 'reference') return false;
    if (!f.referenceTo?.length) return false;
    if (selectedSet && !selectedSet.has(f.name)) return false;
    // Skip fields whose ONLY references are system objects (auto-skipped in BG)
    if (f.referenceTo.every(r => SYSTEM_LOOKUP_OBJS.has(r))) return false;
    // Skip fields where ANY reference is already in the tree (auto-remapped)
    if (f.referenceTo.some(r => treeObjs.has(r))) return false;
    return true;
  });
}

// Returns the org/sid the Profile Builder should describe + query against.
// Prefers the profile's own sourceOrg (user explicitly set it on this
// profile, so its schema is what they're modelling). Falls back to the
// initially-detected page session — covers the case where a brand-new
// profile hasn't had a sourceOrg picked yet, or the user is operating
// outside the builder context.
function _builderSession() {
  if (_editingProfile?.sourceOrg) {
    try {
      const sess = _resolveSession(_editingProfile.sourceOrg, _buildAllSessions());
      if (sess?.sid) return { orgUrl: sess.orgUrl, sid: sess.sid };
    } catch (_) { /* _buildAllSessions/_resolveSession may not be loaded yet */ }
  }
  return { orgUrl: _orgUrl, sid: _sid };
}

// Asynchronously load anchor fields for a referenced object, then re-render.
async function loadRefObjectFields(objType) {
  if (!objType) return;
  // Already loading or loaded
  if (_refFieldCache[objType] && _refFieldCache[objType] !== 'error') return;
  const sess = _builderSession();
  if (!sess.orgUrl || !sess.sid) { _refFieldCache[objType] = null; return; }

  _refFieldCache[objType] = 'loading';

  try {
    const desc = await sendBg({
      type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
      path: `services/data/v62.0/sobjects/${objType}/describe`
    });
    if (desc.error) { _refFieldCache[objType] = null; return; }

    // Keep only filterable, meaningful fields that make good anchor values
    const ANCHOR_TYPES = new Set([
      'string', 'email', 'phone', 'url', 'double', 'integer',
      'picklist', 'id', 'textarea', 'reference'
    ]);
    const SKIP_FIELDS = new Set([
      'Id', 'IsDeleted', 'CreatedDate', 'LastModifiedDate',
      'SystemModstamp', 'CreatedById', 'LastModifiedById'
    ]);
    _refFieldCache[objType] = (desc.fields || [])
      .filter(f => f.filterable && ANCHOR_TYPES.has(f.type) && !SKIP_FIELDS.has(f.name))
      .map(f => ({ name: f.name, label: f.label || f.name, type: f.type }))
      .sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name));
  } catch (_) {
    _refFieldCache[objType] = null;
  }

  refreshTree();  // Re-render with the loaded field list
}

// Render the match-field select (or text input fallback) for a reference field
function renderMatchFieldSelect(refObj, currentMatchField, fieldName, pathKey) {
  const cached = _refFieldCache[refObj];
  const dataAttrs = `data-lkp-match="${esc(pathKey)}" data-lkp-field="${esc(fieldName)}" data-lkp-ref-obj="${esc(refObj)}"`;

  if (!cached || cached === 'loading') {
    // Show a single-option select while loading — renders fast, replaced on next refreshTree()
    return `<select class="ds-select-sm ds-lkp-match-select" ${dataAttrs} disabled>
      <option value="${esc(currentMatchField || 'Name')}">${cached === 'loading' ? '⟳ Loading…' : esc(currentMatchField || 'Name')}</option>
    </select>`;
  }
  if (!Array.isArray(cached) || !cached.length) {
    // Describe failed — fall back to plain text input
    return `<input type="text" class="ds-input ds-input-sm ds-lkp-match-select" ${dataAttrs}
      value="${esc(currentMatchField || 'Name')}" placeholder="API field name, e.g. Name">`;
  }
  const options = cached.map(cf =>
    `<option value="${esc(cf.name)}" ${(currentMatchField || 'Name') === cf.name ? 'selected' : ''}>${esc(cf.label)} <span style="opacity:.55">(${esc(cf.name)})</span></option>`
  ).join('');
  return `<select class="ds-select-sm ds-lkp-match-select" ${dataAttrs}>${options}</select>`;
}

// Render the full Lookup Resolution section for a tree node
function renderLookupSection(node, pathKey) {
  const resolvable = getResolvableReferenceFields(node);
  if (!resolvable.length) return '';

  const rows = resolvable.map(f => {
    const res = (node.lookupResolutions || {})[f.name] || { strategy: 'skip' };
    const strategy = res.strategy || 'skip';
    const matchField = res.matchField || 'Name';
    // Primary non-system referenced object
    const refObj = f.referenceTo.find(r => !SYSTEM_LOOKUP_OBJS.has(r)) || f.referenceTo[0] || '?';

    const matchSelHtml = strategy === 'match'
      ? `<span class="ds-lkp-by">by</span>${renderMatchFieldSelect(refObj, matchField, f.name, pathKey)}`
      : '';

    // Treat any legacy 'passthrough' saved in a profile as 'skip'
    const effectiveStrategy = strategy === 'passthrough' ? 'skip' : strategy;

    const hintHtml =
      effectiveStrategy === 'skip'
        ? `<span class="ds-lkp-hint">field will be null in target — safe default</span>`
      : effectiveStrategy === 'match'
        ? `<span class="ds-lkp-hint">tip: pick an External ID field for reliable cross-org matching</span>`
      : '';

    return `<div class="ds-lkp-row">
      <span class="ds-lkp-field-pill" title="${esc(f.name)}">${esc(f.label || f.name)}</span>
      <span class="ds-lkp-arrow">→</span>
      <span class="ds-lkp-ref-pill">${esc(refObj)}</span>
      <select class="ds-select-sm ds-lkp-strategy-sel"
          data-lkp-path="${esc(pathKey)}"
          data-lkp-field="${esc(f.name)}"
          data-lkp-ref-obj="${esc(refObj)}">
        <option value="skip"  ${effectiveStrategy === 'skip'  ? 'selected' : ''}>🚫 Set null</option>
        <option value="match" ${effectiveStrategy === 'match' ? 'selected' : ''}>🔍 Match by field</option>
      </select>
      ${effectiveStrategy === 'match' ? matchSelHtml : ''}${hintHtml}
    </div>`;
  });

  return `<div class="ds-lkp-section">
    <div class="ds-lkp-hdr">
      <span class="ds-lkp-hdr-icon">🔗</span>
      <span class="ds-lkp-hdr-label">Lookup Resolution</span>
      <span class="ds-lkp-hdr-hint">How to resolve foreign-key IDs when they differ between orgs</span>
    </div>
    <div class="ds-lkp-rows">${rows.join('')}</div>
  </div>`;
}

// ── Render one tree node (recursive) ─────────────────────────
const OBJ_ICONS = {
  Account:'🏢', Contact:'👤', Lead:'🎯', Opportunity:'💼',
  Case:'🎫', Task:'✅', Event:'📆', Campaign:'📣',
  Product2:'📦', Order:'🛒', Quote:'📝', Contract:'📋',
  User:'👤', Asset:'⚙️'
};

function renderTreeNode(node, path, isRoot, depth = 0) {
  const objName   = node.objectType || node.childSObject || '?';
  const pathKey   = path.join('.');
  const meta      = node._meta || {};
  const icon      = OBJ_ICONS[objName] || '🔷';
  const depthClass = isRoot ? 'ds-tree-node--root'
    : depth === 1 ? 'ds-tree-node--child-1'
    : depth === 2 ? 'ds-tree-node--child-2'
    : 'ds-tree-node--child-3';

  const countBadge   = meta.count !== null
    ? `<span class="ds-tree-count">${meta.count} records</span>` : '';
  const loadingBadge = meta.loading
    ? `<span class="ds-tree-loading"><span class="ds-spinner-xs"></span></span>` : '';

  const relBadge = !isRoot
    ? `<span class="ds-tree-rel-badge">${esc(node.relationshipName || '')}</span>
       <span class="ds-tree-via">via ${esc(node.field || '')}</span>`
    : '';

  const childrenHtml = (meta.expanded && (node.children || []).length > 0)
    ? `<div class="ds-tree-children">
        ${(node.children || []).map((c, i) =>
          renderTreeNode(c, [...path, i], false, depth + 1)
        ).join('')}
       </div>` : '';

  const addChildSection = meta.expanded ? `
    <div class="ds-tree-add-child" data-path="${esc(pathKey)}">
      ${meta.loading ? '<span class="ds-tree-rels-loading">Loading relationships…</span>' :
        !meta.relsLoaded ? '' :
        meta.availableRels.length === 0 ? '<span class="ds-tree-no-rels">No child relationships found</span>' :
        (() => {
          const candidates = meta.availableRels.filter(r =>
            !(node.children || []).some(c => c.relationshipName === r.relationshipName));
          return `<details class="ds-tree-rels-details">
            <summary class="ds-tree-rels-summary">+ Add child relationship <span class="ds-tree-rels-count">${candidates.length} available</span></summary>
            <div class="ds-tree-rels-list">
              ${candidates.map(r => `
                  <div class="ds-tree-rel-row"
                       data-add-child="${esc(pathKey)}"
                       data-rel-name="${esc(r.relationshipName)}"
                       data-rel-obj="${esc(r.childSObject)}"
                       data-rel-field="${esc(r.field)}"
                       title="Click to add ${esc(r.childSObject)} as a child">
                    <button class="ds-btn ds-btn-xs ds-btn-primary ds-tree-rel-add-btn"
                            tabindex="-1" aria-label="Add ${esc(r.childSObject)}">+</button>
                    <span class="ds-rel-obj-name">${esc(r.childSObject)}</span>
                    <span class="ds-rel-rel-name">${esc(r.relationshipName)}</span>
                    <span class="ds-rel-field-name">via ${esc(r.field)}</span>
                  </div>`).join('')}
            </div>
          </details>`;
        })()}
    </div>` : '';

  return `
    <div class="ds-tree-node ${depthClass}">
      <div class="ds-tree-node-card">
        <div class="ds-tree-node-header" data-path="${esc(pathKey)}">
          <button class="ds-tree-toggle" data-path="${esc(pathKey)}">${meta.expanded ? '▼' : '▶'}</button>
          <span class="ds-tree-node-icon">${icon}</span>
          <span class="ds-tree-obj-name">${esc(objName)}</span>
          ${relBadge}
          ${countBadge}${loadingBadge}
          <div class="ds-tree-node-actions">
            <button class="ds-btn ds-btn-xs" data-preview="${esc(pathKey)}" title="Count records">👁 Preview</button>
            ${!isRoot ? `<button class="ds-btn ds-btn-xs ds-btn-danger" data-remove="${esc(pathKey)}" title="Remove">✕</button>` : ''}
          </div>
        </div>
        <div class="ds-tree-where-row" data-path="${esc(pathKey)}" ${meta.expanded ? '' : 'style="display:none"'}>
          <span class="ds-tree-where-lbl">WHERE</span>
          <input class="ds-input ds-tree-where-input" data-where="${esc(pathKey)}"
                 value="${esc(node.where || '')}" placeholder="optional SOQL filter…">
        </div>
        ${meta.expanded ? (() => {
          const depWarnings = fieldDependencyWarnings(node);
          const warnHtml = depWarnings.length
            ? `<div class="ds-tree-dep-warning">
                <span class="ds-tree-dep-icon">⚠️</span>
                <span>Lookup field${depWarnings.length > 1 ? 's' : ''}
                  <strong>${esc(depWarnings.map(w => w.fieldLabel).join(', '))}</strong>
                  reference${depWarnings.length === 1 ? 's' : ''}
                  <strong>${esc(depWarnings.flatMap(w => w.referenceTo).join(', '))}</strong>
                  which is not in this profile — IDs may not resolve in target org.
                </span>
               </div>`
            : '';
          const cfOn = node.insertOrder === 'childFirst';
          const cfTitle = cfOn
            ? `Child-first is ON: these records are created BEFORE the parent (without ${node.field || 'the parent link'}), the parent is created next — its lookups to these records connect automatically — then these records are updated to point at their parent. Requires ${node.field || 'the link field'} to be optional and updateable in the target (not master-detail). Click to switch back to the default order.`
            : `Default order: the parent is created first, then these records with ${node.field || 'the parent link'} set at insert. Click to create these records BEFORE the parent instead — for parents whose own lookups require these records to already exist (e.g. CPQ lookup tables).`;
          return `
        <div class="ds-tree-config-row">
          <button class="ds-btn ds-btn-xs ds-btn-config" data-records-btn="${esc(pathKey)}" title="Pick specific records to copy">
            🎯 Records${node.recordIds?.length ? ` <span class="ds-config-badge">${node.recordIds.length}</span>` : ''}
          </button>
          <button class="ds-btn ds-btn-xs ds-btn-config" data-map-btn="${esc(pathKey)}" title="Choose which fields to copy and how to map names between source and target">
            🔀 Fields &amp; mapping${Object.keys(node.fieldMappings || {}).length ? ` <span class="ds-config-badge ds-badge-map">${Object.keys(node.fieldMappings).length}</span>` : ''}
          </button>
          ${!isRoot ? `<button class="ds-btn ds-btn-xs ds-btn-config ${cfOn ? 'ds-btn-config--active' : ''}" data-order-btn="${esc(pathKey)}" title="${esc(cfTitle)}">
            ${cfOn ? '⤴ Created before parent' : '⤵ Created after parent'}
          </button>` : ''}
        </div>${warnHtml}${renderLookupSection(node, pathKey)}`;
        })() : ''}
        ${childrenHtml}
        ${addChildSection}
      </div>
    </div>`;
}

// ── SOQL Preview ──────────────────────────────────────────────
function buildNestedSOQL(node, depth = 0) {
  if (!node) return '';
  const objName = node.objectType || node.childSObject || '?';

  // Effective WHERE: recordIds override takes priority
  const effectiveWhere = node.recordIds?.length
    ? `Id IN (${node.recordIds.slice(0,5).map(id => `'${id}'`).join(', ')}${node.recordIds.length > 5 ? `, …+${node.recordIds.length - 5}` : ''})`
    : (node.where || '').trim();

  // Build direct-child subqueries (Salesforce supports 1 level of relationship query)
  const directChildren = (node.children || []).filter(c => c.childSObject || c.objectType);
  const subqueries = directChildren.map(c => {
    const childWhere = c.recordIds?.length
      ? `Id IN (${c.recordIds.slice(0,3).map(id => `'${id}'`).join(', ')}${c.recordIds.length > 3 ? ',…' : ''})`
      : (c.where || '').trim();
    const childRel   = c.relationshipName || (c.childSObject || '') + 's';
    const childFlds  = c.fields?.length ? esc(c.fields.join(', ')) : 'Id';
    return `<span class="ds-soql-sub">(</span><span class="ds-soql-kw">SELECT</span> <span class="ds-soql-fld">${childFlds}</span> <span class="ds-soql-kw">FROM</span> <span class="ds-soql-obj">${esc(childRel)}</span>${childWhere ? ` <span class="ds-soql-kw">WHERE</span> <span class="ds-soql-val">${esc(childWhere)}</span>` : ''}<span class="ds-soql-sub">)</span>`;
  }).join(',\n    ');

  // Root SELECT fields
  const rootFields = node.fields?.length ? esc(node.fields.join(', ')) : 'Id';
  const selectFields = subqueries ? `${rootFields},\n    ${subqueries}` : rootFields;

  const rootSOQL = `<span class="ds-soql-kw">SELECT</span> <span class="ds-soql-fld">${selectFields}</span>\n<span class="ds-soql-kw">FROM</span> <span class="ds-soql-obj">${esc(objName)}</span>${effectiveWhere ? `\n<span class="ds-soql-kw">WHERE</span> <span class="ds-soql-val">${esc(effectiveWhere)}</span>` : ''}`;

  // Deeper levels shown as separate annotated queries
  const deeperBlocks = (node.children || []).flatMap(c =>
    (c.children || []).length > 0
      ? [`<div class="ds-soql-sep">— separate query for ${esc(c.childSObject || c.objectType || '?')} children —</div>` + buildNestedSOQL(c, depth + 1)]
      : []
  ).join('\n');

  return `<pre class="ds-soql-code">${rootSOQL}</pre>${deeperBlocks ? `<div class="ds-soql-deeper">${deeperBlocks}</div>` : ''}`;
}

function refreshSOQLPreview() {
  const pane = eid('dsSOQLPane');
  if (!pane || !_editingProfile?.tree) return;
  pane.innerHTML = `
    <div class="ds-soql-pane-header">
      <span class="ds-soql-pane-title">📋 SOQL Preview</span>
      <span class="ds-soql-pane-note">Shows how records will be fetched</span>
    </div>
    <div class="ds-soql-pane-body">
      ${buildNestedSOQL(_editingProfile.tree)}
    </div>`;
}

// ── Wire all tree events ──────────────────────────────────────
function wireTreeEvents() {
  const area = eid('dsTreeArea');
  if (!area) return;

  // Toggle expand/collapse
  area.querySelectorAll('.ds-tree-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const node = getNodeByPath(_editingProfile.tree, btn.dataset.path);
      if (node) { node._meta.expanded = !node._meta.expanded; refreshTree(); }
    });
  });

  // WHERE input change (live, debounced)
  area.querySelectorAll('.ds-tree-where-input').forEach(input => {
    input.addEventListener('change', () => {
      const node = getNodeByPath(_editingProfile.tree, input.dataset.where);
      if (node) { node.where = input.value.trim() || null; }
    });
  });

  // Preview count
  area.querySelectorAll('[data-preview]').forEach(btn => {
    btn.addEventListener('click', () => previewNode(btn.dataset.preview));
  });

  // Remove child
  area.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => removeNode(btn.dataset.remove));
  });

  // Add child relationship
  area.querySelectorAll('[data-add-child]').forEach(btn => {
    btn.addEventListener('click', () => addChild(
      btn.dataset.addChild,
      btn.dataset.relName,
      btn.dataset.relObj,
      btn.dataset.relField
    ));
  });

  // Field picker removed — was redundant with the Field Mapping modal
  // (which already lets users include/exclude fields via the ✕ button).
  // Also `node.fields` was never read by the executor — the field set is
  // determined entirely by the source describe at runtime — so this picker
  // had no behavioural effect; it was UI noise. Legacy `node.fields` data
  // still loads from storage but isn't surfaced.

  // Record picker
  area.querySelectorAll('[data-records-btn]').forEach(btn => {
    btn.addEventListener('click', () => openRecordPickerModal(btn.dataset.recordsBtn));
  });

  // Field mapping
  area.querySelectorAll('[data-map-btn]').forEach(btn => {
    btn.addEventListener('click', () => openFieldMappingModal(btn.dataset.mapBtn));
  });

  // Insert-order toggle (child nodes only): default parent-first ⤵ vs
  // child-first ⤴ (records created before the parent, linked afterwards).
  area.querySelectorAll('[data-order-btn]').forEach(btn => {
    btn.addEventListener('click', () => {
      const node = getNodeByPath(_editingProfile.tree, btn.dataset.orderBtn);
      if (!node) return;
      if (node.insertOrder === 'childFirst') delete node.insertOrder;
      else node.insertOrder = 'childFirst';
      refreshTree();
    });
  });

  // ── Lookup Resolution ─────────────────────────────────────────
  // Strategy dropdown (skip / match)
  area.querySelectorAll('.ds-lkp-strategy-sel').forEach(sel => {
    sel.addEventListener('change', () => {
      const node = getNodeByPath(_editingProfile.tree, sel.dataset.lkpPath);
      if (!node) return;
      if (!node.lookupResolutions) node.lookupResolutions = {};
      const fn  = sel.dataset.lkpField;
      const ref = sel.dataset.lkpRefObj;
      const existing = node.lookupResolutions[fn] || {};
      node.lookupResolutions[fn] = {
        ...existing,
        strategy:    sel.value,
        matchObject: ref,
        matchField:  existing.matchField || 'Name'
      };
      // Start loading anchor fields when the user switches to 'match'
      if (sel.value === 'match') loadRefObjectFields(ref);
      refreshTree();
    });
  });

  // Match-field select (or text input fallback) — update without full re-render
  area.querySelectorAll('.ds-lkp-match-select').forEach(el => {
    el.addEventListener('change', () => {
      const node = getNodeByPath(_editingProfile.tree, el.dataset.lkpMatch);
      if (!node) return;
      if (!node.lookupResolutions) node.lookupResolutions = {};
      const fn  = el.dataset.lkpField;
      const ref = el.dataset.lkpRefObj;
      if (!node.lookupResolutions[fn]) {
        node.lookupResolutions[fn] = { strategy: 'match', matchObject: ref };
      }
      node.lookupResolutions[fn].matchField = el.value;
      // Don't refreshTree() — just store; avoids losing focus mid-selection
    });
    // Same for text inputs (fallback)
    el.addEventListener('blur', () => {
      const node = getNodeByPath(_editingProfile.tree, el.dataset.lkpMatch);
      if (!node || el.tagName !== 'INPUT') return;
      if (!node.lookupResolutions) node.lookupResolutions = {};
      const fn  = el.dataset.lkpField;
      const ref = el.dataset.lkpRefObj;
      if (!node.lookupResolutions[fn]) {
        node.lookupResolutions[fn] = { strategy: 'match', matchObject: ref };
      }
      node.lookupResolutions[fn].matchField = el.value.trim() || 'Name';
    });
  });

  // Kick off describe loads for any referenced objects not yet cached
  const neededRefObjs = new Set();
  area.querySelectorAll('[data-lkp-ref-obj]').forEach(el => {
    const obj = el.dataset.lkpRefObj;
    if (obj && !_refFieldCache[obj]) neededRefObjs.add(obj);
  });
  neededRefObjs.forEach(obj => loadRefObjectFields(obj));
}

// ── Path navigation in tree ───────────────────────────────────
// path = '' → root; '0' → first child; '0.1' → first child's second child
function getNodeByPath(root, pathStr) {
  if (!root) return null;
  if (!pathStr || pathStr === '') return root;
  const parts = pathStr.split('.').map(Number);
  let node = root;
  for (const i of parts) {
    if (!node.children || !node.children[i]) return null;
    node = node.children[i];
  }
  return node;
}

function getParentByPath(root, pathStr) {
  if (!pathStr) return null;            // the root itself has no parent
  const parts = pathStr.split('.');
  // A one-segment path ("0") is a FIRST-LEVEL child — its parent is the
  // root. The old `parts.length <= 1 → null` made removeNode silently
  // no-op for every direct child (the ✕ button "did nothing"); only
  // grandchildren could be removed.
  if (parts.length === 1) return root;
  return getNodeByPath(root, parts.slice(0, -1).join('.'));
}

function getChildIndex(pathStr) {
  return parseInt(pathStr.split('.').pop(), 10);
}

// ── Tree operations ───────────────────────────────────────────
function removeNode(pathStr) {
  const parent = getParentByPath(_editingProfile.tree, pathStr);
  const idx    = getChildIndex(pathStr);
  if (parent && Array.isArray(parent.children)) {
    parent.children.splice(idx, 1);
    refreshTree();
  }
}

function addChild(parentPath, relName, childSObject, field) {
  const parent = getNodeByPath(_editingProfile.tree, parentPath);
  if (!parent) return;
  const newChild = {
    relationshipName: relName,
    childSObject, field,
    where: null,
    children: [],
    _meta: { count: null, expanded: true, loading: false, relsLoaded: false, availableRels: [] }
  };
  if (!parent.children) parent.children = [];
  parent.children.push(newChild);
  refreshTree();
  // Load rels for the new child node
  const newPath = parentPath === '' ? `${parent.children.length - 1}` : `${parentPath}.${parent.children.length - 1}`;
  loadNodeRels(newChild, newPath.split('.').map(Number));
}

function refreshTree() {
  const area = eid('dsTreeArea');
  if (area && _editingProfile?.tree) {
    area.innerHTML = renderTreeNode(_editingProfile.tree, [], true);
    wireTreeEvents();
  }
  refreshSOQLPreview();
}

// ── Load child relationships for a node ───────────────────────
async function loadNodeRels(node, _path) {
  const objType = node.objectType || node.childSObject;
  if (!objType || node._meta?.relsLoaded) return;
  if (node._meta) node._meta.loading = true;
  refreshTree();

  const desc = await describe(objType);
  if (!desc) {
    if (node._meta) { node._meta.loading = false; node._meta.relsLoaded = true; }
    refreshTree();
    return;
  }

  const SKIP = new Set([
    'ActivityHistories','OpenActivities','NoteAndAttachments','Attachments',
    'FeedSubscriptionsForEntity','RecordAssociatedGroups','ContentDocumentLinks',
    'ContentVersions','Histories','Shares','ProcessInstances','ProcessSteps',
    'Tags','UserRecordAccess','FlowRecordRelations','EmailMessageRelations',
    'ListEmailIndividualRecipients','TopicAssignments','Votes','EntitySubscriptions'
  ]);

  const rels = (desc.childRelationships || [])
    .filter(r => r.relationshipName && !r.deprecatedAndHidden && !SKIP.has(r.relationshipName))
    .map(r => ({ relationshipName: r.relationshipName, childSObject: r.childSObject, field: r.field }))
    .sort((a, b) => a.childSObject.localeCompare(b.childSObject));

  // Also cache available fields for the field picker (createable + Id/Name)
  const ALWAYS_INCLUDE = new Set(['Id', 'Name']);
  const fields = (desc.fields || [])
    .filter(f => f.createable || ALWAYS_INCLUDE.has(f.name))
    .map(f => ({
      name:       f.name,
      label:      f.label || f.name,
      type:       f.type,
      required:   !f.nillable && f.createable && f.defaultValue === null,
      custom:     f.name.endsWith('__c'),
      referenceTo: f.referenceTo || []
    }))
    .sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name));

  if (node._meta) {
    node._meta.availableRels    = rels;
    node._meta.relsLoaded       = true;
    node._meta.loading          = false;
    node._meta.availableFields  = fields;
    node._meta.fieldsLoaded     = true;
  }
  refreshTree();
}

// ── Preview count ─────────────────────────────────────────────
async function previewNode(pathStr) {
  const node = getNodeByPath(_editingProfile.tree, pathStr);
  if (!node) return;
  const sess = _builderSession();
  if (!sess.orgUrl || !sess.sid) {
    showToast('Set a source org on this profile to preview record counts.', 'warning', 4000);
    return;
  }

  const objType = node.objectType || node.childSObject;
  node._meta.loading = true;
  refreshTree();

  const effectiveWhere = node.recordIds?.length
    ? `Id IN (${node.recordIds.map(id => `'${id}'`).join(',')})`
    : (node.where || '');
  const res = await sendBg({
    type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid,
    query: `SELECT COUNT() FROM ${objType}${effectiveWhere ? ' WHERE ' + effectiveWhere : ''}`
  });

  node._meta.loading = false;
  node._meta.count   = res.error ? null : (res.totalSize ?? 0);
  refreshTree();
}

// ── Preview All — counts every node in the tree simultaneously ─
// Uses SF_RELATIONSHIP_QUERY for the root + its direct children (1 round trip),
// then fires individual COUNT() queries for any deeper grandchild nodes.
async function previewAll() {
  const tree = _editingProfile?.tree;
  if (!tree) return;
  const sess = _builderSession();
  if (!sess.orgUrl || !sess.sid) {
    showToast('Set a source org on this profile to preview record counts.', 'warning', 4000);
    return;
  }

  const btn = eid('dsPreviewAllBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Counting…'; }

  try {
    // ── 1. Root + direct children via relationship query ────────
    const rootObj    = tree.objectType || tree.childSObject || '';
    const directRels = (tree.children || [])
      .map(c => ({ relationshipName: c.relationshipName, where: c.where || null }))
      .filter(r => r.relationshipName);

    if (directRels.length > 0) {
      // One call covers root count AND all direct-child counts
      const relRes = await sendBg({
        type:         'SF_RELATIONSHIP_QUERY',
        orgUrl:       sess.orgUrl,
        sid:          sess.sid,
        rootObject:   rootObj,
        rootWhere:    tree.where || null,
        childRels:    directRels,
        limit:        500
      });

      if (!relRes.error) {
        // Patch root count
        if (tree._meta) tree._meta.count = relRes.parentCount;

        // Patch each direct child's count from childCounts map
        for (const child of (tree.children || [])) {
          if (!child.relationshipName || !child._meta) continue;
          const c = relRes.childCounts?.[child.relationshipName];
          child._meta.count = c !== undefined ? c : null;
        }
      }
    } else {
      // No children — just count the root
      const rootRes = await sendBg({
        type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid,
        query: `SELECT COUNT() FROM ${rootObj}${tree.where ? ' WHERE ' + tree.where : ''}`
      });
      if (tree._meta) tree._meta.count = rootRes.error ? null : (rootRes.totalSize ?? 0);
    }

    // ── 2. Grandchildren and deeper — individual COUNT() in parallel ─
    const deepQueries = [];
    for (const child of (tree.children || [])) {
      for (const grand of (child.children || [])) {
        const objType = grand.objectType || grand.childSObject;
        if (!objType || !grand._meta) continue;
        deepQueries.push(
          sendBg({
            type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid,
            query: `SELECT COUNT() FROM ${objType}${grand.where ? ' WHERE ' + grand.where : ''}`
          }).then(res => {
            grand._meta.count = res.error ? null : (res.totalSize ?? 0);
          })
        );
      }
    }
    if (deepQueries.length) await Promise.all(deepQueries);

  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '👁 Preview All'; }
    refreshTree();
  }
}

// ════════════════════════════════════════════════════════════════
// FIELD PICKER MODAL — REMOVED 2026-05-16
// ════════════════════════════════════════════════════════════════
// The dedicated "Select Fields" picker was redundant with the Field Mapping
// modal (which already lets users include/exclude fields via the ✕ button)
// and — more critically — `node.fields` was never consulted by the executor
// in background.js. So the picker had no functional effect; it was UI noise.
//
// All field inclusion/exclusion now flows through the Field Mapping modal.
// Legacy `node.fields` data in saved profiles is loaded but no longer
// surfaced or honored at runtime.

