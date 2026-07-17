'use strict';
// ════════════════════════════════════════════════════════════════
// RECONCILE (Phase 3A) — one screen to review + fix sync state
// ════════════════════════════════════════════════════════════════
// Three columns from profile.lastScan:
//   missing in target → push (insert)
//   drift             → push source values (overwrite) or skip
//   only in target    → delete from target
// Root object only in v1. Bulk actions execute in one Run with a
// confirmation modal before any destructive delete.

window.openReconcile = function(profileId) {
  _reconcileProfile = _profiles.find(p => p.id === profileId) || null;
  document.querySelectorAll('.ds-nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-view="profiles"]')?.classList.add('active');
  _currentView = 'reconcile';
  renderReconcile();
};

// Module-scope selection sets so re-renders (after an action) preserve picks
// where it makes sense. Reset when the profile changes.
// Reconcile selection state. Buckets:
//   push      — sourceIds, insert into target ("in source only")
//   overwrite — sourceIds, update TARGET with source values ("drift" →)
//   updSrc    — sourceIds, update SOURCE with target values ("drift" ←, 3B v2)
//   pull      — targetIds, insert into source ("in target only", Phase 3B)
//   del       — targetIds, delete from target ("in target only")
// Mutually exclusive pairs (picking one auto-clears the other):
//   overwrite/updSrc per drift row, pull/del per target-only row.
let _recSel = { push: new Set(), overwrite: new Set(), updSrc: new Set(), del: new Set(), pull: new Set() };
let _recLastProfileId = null;
// Child-aware reconcile (v2: children + grandchildren; Insert, Relink,
// Overwrite drift, Delete extras). Selections and UI state are keyed by tree
// pathKey ('0', '1', '0.1' for grandchildren, …).
let _recChildSel      = {};   // pathKey → { push:Set(sourceIds), relink:Set(targetIds), overwrite:Set(sourceIds), del:Set(targetIds) }
let _recOrderOverride = {};   // pathKey → 'childFirst' (run-scoped; absent = node's own order)
let _recChildOpen     = {};   // pathKey → bool (accordion expanded)
// Delete mode for the reconcile "In target only" column.
//   'recycle' — DELETE → Recycle Bin (recoverable 15 days)
//   'hard'    — DELETE then SOAP emptyRecycleBin (permanent)
let _recDeleteMode = 'recycle';

async function renderReconcile() {
  const p = _reconcileProfile;
  if (!p) { renderProfiles(); return; }

  // Reset selection when switching to a different profile.
  if (_recLastProfileId !== p.id) {
    _recSel = { push: new Set(), overwrite: new Set(), updSrc: new Set(), del: new Set(), pull: new Set() };
    _recChildSel = {}; _recOrderOverride = {}; _recChildOpen = {};
    _recLastProfileId = p.id;
  }

  const objType = p.tree?.objectType || p.tree?.childSObject || '?';
  const scan    = p.lastScan;
  // objectType check is SAFETY-critical, not cosmetic: if the profile's root
  // object changed after the last scan, the old scan's buckets carry record
  // Ids of a DIFFERENT object — and Delete passes those raw Ids to
  // SF_COLLECTIONS_DELETE, which deletes by Id regardless of type.
  const scanFresh = !!(
    scan && scan.status === 'success' &&
    (!scan.objectType || scan.objectType === objType) &&
    (!scan.sourceOrg || scan.sourceOrg === p.sourceOrg) &&
    (!scan.targetOrg || scan.targetOrg === p.targetOrg)
  );

  // Header with back link + refresh.
  const headerHtml = `
    <div class="ds-view-header">
      <div class="ds-view-title-wrap">
        <button class="ds-back-link" id="dsRecBackBtn" title="Back to Data Deployment">‹ Back to deployments</button>
        <h2 class="ds-view-title">⚖ Reconcile — <span style="color:var(--brand)">${esc(objType)}</span></h2>
        <div class="ds-view-subtitle">${esc(orgLabel(p.sourceOrg || ''))} → ${esc(orgLabel(p.targetOrg || ''))} ${prodBadge(p.targetOrg)}${scanFresh ? ` · scanned ${esc(timeAgo(scan.runAt))}` : ''}${scanFresh && scan.memoryMatched ? ` · <span class="ds-mm-chip" style="font-size:11px;padding:1px 7px;border-radius:9px;background:#eef2ff;color:#4338ca;white-space:nowrap" title="${scan.memoryMatched} record pair(s) matched by remembered identity (match memory) instead of key — they survive renames on either side.">🧠 ${scan.memoryMatched} matched from memory</span>` : ''}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        ${p.ephemeral ? `<button class="ds-btn ds-btn-sm ds-btn-primary" data-dsaction="saveEphemeralProfile"
          title="Keep this as a saved deployment — re-run it, retry failures, and track sync from the Data Deployment page. Right now it disappears when you leave this view.">💾 Save as deployment</button>` : ''}
        <button class="ds-btn ds-btn-sm" id="dsRecRefreshBtn">🔄 Refresh state</button>
      </div>
    </div>`;

  if (!p.sourceOrg || !p.targetOrg) {
    setMain(`${headerHtml}
      <div class="ds-empty-page">
        <div class="ds-empty-icon">⚖</div>
        <div class="ds-empty-title">Set source and target orgs first</div>
        <div class="ds-empty-sub">Reconcile needs both orgs configured. Open the profile in <strong>✏ Edit</strong> to set them.</div>
      </div>`);
    eid('dsRecBackBtn')?.addEventListener('click', renderProfiles);
    return;
  }

  if (!scanFresh) {
    setMain(`${headerHtml}
      <div class="ds-empty-page">
        <div class="ds-empty-icon">🔄</div>
        <div class="ds-empty-title">${scan ? 'State is stale (orgs changed since last scan)' : 'No state captured yet'}</div>
        <div class="ds-empty-sub">Click <strong>🔄 Refresh state</strong> to compare the two orgs, then reconcile.</div>
        <div class="ds-empty-actions"><button class="ds-btn ds-btn-primary" id="dsRecRefreshBtn2">🔄 Refresh state</button></div>
      </div>`);
    eid('dsRecBackBtn')?.addEventListener('click', renderProfiles);
    const doRefresh = async () => { await window.refreshProfileState(p.id); const _fp = _profiles.find(x => x.id === p.id); if (_fp) _reconcileProfile = _fp; renderReconcile(); };
    eid('dsRecRefreshBtn')?.addEventListener('click', doRefresh);
    eid('dsRecRefreshBtn2')?.addEventListener('click', doRefresh);
    return;
  }

  const missing = scan.missingInTarget || [];   // {matchKey, sourceId}
  const drift   = scan.changed || [];           // {matchKey, sourceId, targetId}
  const extras  = scan.onlyInTarget || [];      // {matchKey, targetId}
  const inSync  = scan.identical || [];

  // M3a — composite match keys carry a U+0001 separator; render it as ' · '
  // (display only — the raw key stays the matching identity).
  const keyLbl = k => esc(typeof sftkMatchKeyLabel === 'function' ? sftkMatchKeyLabel(k) : String(k ?? ''));

  // Default-select all missing + all drift for push (the common intent:
  // bring target up to match source). Extras default UNCHECKED — deletion
  // is destructive, opt-in only. Only seed defaults on first load.
  if (!_recSel.push.size && !_recSel.overwrite.size && !_recSel.updSrc.size && !_recSel.del.size && !_recSel.pull.size) {
    missing.forEach(r => r.sourceId && _recSel.push.add(r.sourceId));
    drift.forEach(r => r.sourceId && _recSel.overwrite.add(r.sourceId));
    // updSrc + Pull + Delete left empty — writing into SOURCE (or deleting)
    // is opt-in only; the default direction matches "bring target up to source".
  }

  // dml = the plain Salesforce operation this column performs (Insert/Update/
  // Delete). subtitle = the diff state that put records here. Leading with the
  // DML verb so it's obvious what ▶ Run reconcile will actually do.
  function colHtml(dml, subtitle, badgeClass, icon, items, kind) {
    const rows = items.length ? items.map(r => {
      const id = kind === 'del' ? r.targetId : r.sourceId;
      const sel = _recSel[kind].has(id);
      return `<label class="ds-rec-col-row">
        <input type="checkbox" data-rec-kind="${kind}" data-rec-id="${esc(id)}" ${sel ? 'checked' : ''}>
        <span class="ds-rec-col-key">${keyLbl(r.matchKey)}</span>
        ${kind === 'overwrite' ? `<span class="ds-rec-drift-link" data-rec-drift="${esc(r.sourceId)}|${esc(r.targetId)}" title="See which fields differ">▸ fields</span>` : ''}
      </label>
      ${kind === 'overwrite' ? `<div class="ds-rec-drift-expand" data-drift-expand="${esc(r.sourceId)}" style="display:none"></div>` : ''}`;
    }).join('') : `<div class="ds-rec-col-empty">none</div>`;
    return `
      <div class="ds-rec-col">
        <div class="ds-rec-col-hdr ${badgeClass}">
          ${icon} <strong>${dml} ${items.length}</strong>
          <span class="ds-rec-col-sub">${subtitle}</span>
        </div>
        <div class="ds-rec-col-actions">
          <button class="ds-btn ds-btn-xs" data-rec-all="${kind}">✓ All</button>
          <button class="ds-btn ds-btn-xs" data-rec-none="${kind}">✗ None</button>
        </div>
        <div class="ds-rec-col-list">${rows}</div>
      </div>`;
  }

  // Drift column gets a per-row DIRECTION picker (Phase 3B v2): → Update
  // target with source values, or ← Update source with target values
  // (mutually exclusive; click the active one to skip the row). The "▸
  // fields" expander stays so the user can see the differing values before
  // picking a winner.
  function driftColHtml(items) {
    const empty = !items.length;
    const rows = empty ? `<div class="ds-rec-col-empty">none</div>` : items.map(r => {
      const sid = r.sourceId;
      const isPush = _recSel.overwrite.has(sid);
      const isPull = _recSel.updSrc.has(sid);
      // Inline "why is this drifted" — the scan already recorded which
      // fields differed (capped at 10); show the first few right on the row
      // so diagnosing drift doesn't require expanding each record.
      const why = (r.fields || []).length
        ? `<span class="ds-rec-drift-why" title="Differs on: ${esc(r.fields.join(', '))}">${esc(r.fields.slice(0, 3).join(', '))}${r.fields.length > 3 ? ` +${r.fields.length - 3}` : ''}</span>`
        : '';
      return `<div class="ds-rec-col-row ds-rec-row-drift">
        <span class="ds-rec-extra-actions">
          <button class="ds-rec-extra-btn ${isPush ? 'ds-rec-extra-on-push' : ''}"
                  data-rec-driftdir="overwrite" data-rec-id="${esc(sid)}"
                  title="Update the TARGET record with the source's values">→</button>
          <button class="ds-rec-extra-btn ${isPull ? 'ds-rec-extra-on-pull' : ''}"
                  data-rec-driftdir="updSrc" data-rec-id="${esc(sid)}"
                  title="Update the SOURCE record with the target's values">←</button>
        </span>
        <span class="ds-rec-col-key">${keyLbl(r.matchKey)}</span>
        ${why}
        <span class="ds-rec-drift-link" data-rec-drift="${esc(r.sourceId)}|${esc(r.targetId)}" title="See which fields differ">▸ fields</span>
      </div>
      <div class="ds-rec-drift-expand" data-drift-expand="${esc(r.sourceId)}" style="display:none"></div>`;
    }).join('');
    const pushCount = items.filter(r => _recSel.overwrite.has(r.sourceId)).length;
    const pullCount = items.filter(r => _recSel.updSrc.has(r.sourceId)).length;
    return `
      <div class="ds-rec-col">
        <div class="ds-rec-col-hdr ds-diff-drift">
          🟡 <strong>Changed ${items.length}</strong>
          <span class="ds-rec-col-sub">values differ — pick a winner per row</span>
        </div>
        <div class="ds-rec-col-actions ds-rec-col-actions-extra">
          <button class="ds-btn ds-btn-xs" data-rec-driftdir-all="overwrite" title="Source wins everywhere — update all target records">→ all</button>
          <button class="ds-btn ds-btn-xs" data-rec-driftdir-all="updSrc" title="Target wins everywhere — update all source records">← all</button>
          <button class="ds-btn ds-btn-xs" data-rec-driftdir-clear="1">✗ None</button>
        </div>
        ${empty ? '' : `<div class="ds-rec-extra-subcounts ds-rec-drift-subcounts">
          <span class="ds-rec-drift-sub-push">→ ${pushCount} to target</span>
          <span class="ds-rec-extra-sub-pull">← ${pullCount} to source</span>
          <span class="ds-rec-extra-sub-skip">${items.length - pushCount - pullCount} skipped</span>
        </div>`}
        <div class="ds-rec-col-list">${rows}</div>
      </div>`;
  }

  // "In target only" column gets per-row action picker: Skip / ← Pull /
  // 🗑 Delete (mutually exclusive). Phase 3B — bidirectional reconcile.
  // The whole column header doesn't say "Delete" anymore because rows can
  // go either way, so we split the count by what's currently selected.
  function extrasColHtml(items) {
    const empty = !items.length;
    const rows = empty ? `<div class="ds-rec-col-empty">none</div>` : items.map(r => {
      const tgtId = r.targetId;
      const isPull = _recSel.pull.has(tgtId);
      const isDel  = _recSel.del.has(tgtId);
      return `<div class="ds-rec-col-row ds-rec-row-extra">
        <span class="ds-rec-extra-actions">
          <button class="ds-rec-extra-btn ${isPull ? 'ds-rec-extra-on-pull' : ''}"
                  data-rec-extra="pull" data-rec-id="${esc(tgtId)}"
                  title="Pull this record into the source org">← Pull</button>
          <button class="ds-rec-extra-btn ${isDel ? 'ds-rec-extra-on-del' : ''}"
                  data-rec-extra="del" data-rec-id="${esc(tgtId)}"
                  title="Delete this record from the target org">🗑 Delete</button>
        </span>
        <span class="ds-rec-col-key">${keyLbl(r.matchKey)}</span>
      </div>`;
    }).join('');
    const pullCount = items.filter(r => _recSel.pull.has(r.targetId)).length;
    const delCount  = items.filter(r => _recSel.del.has(r.targetId)).length;
    return `
      <div class="ds-rec-col">
        <div class="ds-rec-col-hdr ds-diff-extra">
          🔵 <strong>In target only ${items.length}</strong>
          <span class="ds-rec-col-sub">pick an action per row</span>
        </div>
        <div class="ds-rec-col-actions ds-rec-col-actions-extra">
          <button class="ds-btn ds-btn-xs" data-rec-extra-all="pull" title="Pull all">← Pull all</button>
          <button class="ds-btn ds-btn-xs" data-rec-extra-all="del"  title="Delete all">🗑 Delete all</button>
          <button class="ds-btn ds-btn-xs" data-rec-extra-clear="1">✗ None</button>
        </div>
        ${empty ? '' : `<div class="ds-rec-extra-subcounts">
          <span class="ds-rec-extra-sub-pull">← ${pullCount} to pull</span>
          <span class="ds-rec-extra-sub-del">🗑 ${delCount} to delete</span>
          <span class="ds-rec-extra-sub-skip">${items.length - pullCount - delCount} skipped</span>
        </div>`}
        <div class="ds-rec-col-list">${rows}</div>
      </div>`;
  }

  // ── Child-aware reconcile (v1) — direct children of the root ──────────
  // Each child renders as a collapsible section: Scan → buckets. Actionable
  // in v1: Insert (delegates to the transfer engine, which handles ordering
  // — child-first hoisting — scoping and the reconnect step) and ⇄ Relink
  // (re-point an existing child at the parent the source says it belongs
  // to). Drift / target-only counts show for awareness.
  const rootChildren = p.tree?.children || [];
  function childSel(pathKey) {
    if (!_recChildSel[pathKey]) _recChildSel[pathKey] = { push: new Set(), relink: new Set(), overwrite: new Set(), del: new Set() };
    const s = _recChildSel[pathKey];
    // R4 — backfill the v2 sets on state created before this session's render.
    if (!s.overwrite) s.overwrite = new Set();
    if (!s.del)       s.del       = new Set();
    return s;
  }
  // Parent status from the ROOT scan — annotates child Insert rows.
  const rootMissingBySrc = new Set(missing.map(r => r.sourceId));
  const rootExistsSrc    = new Set([...drift.map(r => r.sourceId), ...inSync.map(r => r.sourceId)]);

  function childBucketsHtml(node, pathKey, cs, sel, pMissingSet, pExistsSet, depth) {
    pMissingSet = pMissingSet || rootMissingBySrc;
    pExistsSet  = pExistsSet  || rootExistsSrc;
    depth       = depth || 1;
    const missingRows = (cs.missingInTarget || []).map(r => {
      const pMissing = r.parentSrcId && pMissingSet.has(r.parentSrcId);
      const pExists  = r.parentSrcId && pExistsSet.has(r.parentSrcId);
      // R5 — grandchildren only support push-with-existing-parent: a row
      // whose parent is ALSO missing can't tree-ride at this depth.
      const deepBlock = depth > 1 && pMissing;
      const pNote = !r.parentSrcId
        ? `<span class="ds-rec-pnote ds-rec-pnote-none" title="No parent in the source either — inserts unlinked.">no parent</span>`
        : pMissing
          ? (deepBlock
            ? `<span class="ds-rec-pnote ds-rec-pnote-unknown" title="Its parent is missing in the target too, and tree-ride inserts aren't supported at this depth (v2) — insert the parent level first, rescan this section, then insert this row.">parent ${esc(r.parentKey || '?')} ✗ missing — insert parent level first</span>`
            : `<span class="ds-rec-pnote ds-rec-pnote-missing" title="Its parent is missing in the target too — selecting this row also inserts the parent (added automatically at run time).">parent ${esc(r.parentKey || '?')} ✗ missing</span>`)
          : pExists
            ? `<span class="ds-rec-pnote ds-rec-pnote-ok" title="Its parent already exists in the target — this record attaches to it at insert, matched by the parent's key.">parent ${esc(r.parentKey || '?')} ✓ exists</span>`
            : `<span class="ds-rec-pnote ds-rec-pnote-unknown" title="Its parent isn't tracked by the ${depth > 1 ? 'parent child scan' : 'root scan'} (outside its scope or a key collision) — can't be safely inserted.">parent untracked</span>`;
      const disabled = !!(r.parentSrcId && !pMissing && !pExists) || deepBlock;
      return `<label class="ds-rec-col-row ${disabled ? 'ds-rec-row-disabled' : ''}">
        <input type="checkbox" data-recc-push="${pathKey}" data-rec-id="${esc(r.sourceId)}" ${!disabled && sel.push.has(r.sourceId) ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
        <span class="ds-rec-col-key">${keyLbl(r.matchKey)}</span>
        ${pNote}
      </label>`;
    }).join('') || `<div class="ds-rec-col-empty">none</div>`;

    // R2 — master-detail links can be re-parented only when the field is
    // reparentable (updateable on the describe). Otherwise disable Relink
    // and say why.
    const relinkBlocked = !!(cs.linkMasterDetail && cs.linkUpdateable === false);
    const relinkBlockTitle = `${esc(node.field || 'The link')} is a master-detail relationship that isn't reparentable — Salesforce blocks changing it after insert, so Relink can't run. Enable 'Allow reparenting' on the field, or recreate the record under the right parent.`;
    const linkRows = (cs.linkMismatch || []).map(r => {
      const on = !relinkBlocked && sel.relink.has(r.targetId);
      return `<div class="ds-rec-col-row ds-rec-row-link">
        <button class="ds-rec-extra-btn ${on ? 'ds-rec-extra-on-push' : ''}" data-recc-relink="${pathKey}" data-rec-id="${esc(r.targetId)}" ${relinkBlocked ? 'disabled' : ''}
          title="${relinkBlocked ? relinkBlockTitle : `Update this target record so ${esc(node.field || 'its parent link')} points at the parent the source says it belongs to. This is a real update — the child's triggers/flows fire.`}">⇄ Relink</button>
        <span class="ds-rec-col-key">${keyLbl(r.matchKey)}</span>
        <span class="ds-rec-link-detail" title="currently → should be">${esc(r.parentKeyTgt || '∅')} → ${esc(r.parentKeySrc || '∅')}</span>
      </div>`;
    }).join('') || `<div class="ds-rec-col-empty">none</div>`;

    // R4 — child drift rows get the same → overwrite picker the root has
    // (source values win; no ← for children in v2).
    const driftRows = (cs.changed || []).map(r => {
      const on = sel.overwrite.has(r.sourceId);
      const why = (r.fields || []).length
        ? `<span class="ds-rec-drift-why" title="Differs on: ${esc(r.fields.join(', '))}">${esc(r.fields.slice(0, 3).join(', '))}${r.fields.length > 3 ? ` +${r.fields.length - 3}` : ''}</span>`
        : '';
      return `<div class="ds-rec-col-row ds-rec-row-drift">
        <button class="ds-rec-extra-btn ${on ? 'ds-rec-extra-on-push' : ''}" data-recc-ovw="${pathKey}" data-rec-id="${esc(r.sourceId)}"
          title="Update the TARGET record with the source's values (fields from this node's field mapping)">→</button>
        <span class="ds-rec-col-key">${keyLbl(r.matchKey)}</span>
        ${why}
      </div>`;
    }).join('') || `<div class="ds-rec-col-empty">none</div>`;

    // R4 — child target-only rows get a 🗑 delete picker. R3 — rows whose
    // link field is NULL in the target are tagged "possible orphan" and are
    // excluded from 🗑 All by default (individually selectable).
    const orphanN = (cs.onlyInTarget || []).filter(r => r.orphan).length;
    const extraRows = (cs.onlyInTarget || []).map(r => {
      const on = sel.del.has(r.targetId);
      return `<div class="ds-rec-col-row ds-rec-row-extra">
        <button class="ds-rec-extra-btn ${on ? 'ds-rec-extra-on-del' : ''}" data-recc-del="${pathKey}" data-rec-id="${esc(r.targetId)}"
          title="Delete this record from the target org (honors the Delete mode below)">🗑</button>
        <span class="ds-rec-col-key">${keyLbl(r.matchKey)}</span>
        ${r.orphan ? `<span class="ds-rec-pnote ds-rec-pnote-unknown" title="Its ${esc(node.field || 'link')} field is empty in the target — a prior partial run may have created it, then failed to reconnect it. ⇄ Relink can re-attach it to the right parent instead of deleting. Excluded from '🗑 All' — select it individually if you're sure.">⚠ orphan</span>` : ''}
      </div>`;
    }).join('') || `<div class="ds-rec-col-empty">none</div>`;

    // R1 — rows sharing duplicate match keys were excluded from every bucket.
    const collisionNote = cs.keyCollisions
      ? `<div class="ds-rec-child-info" style="border-left:3px solid #f59e0b;padding-left:8px" title="Duplicate keys: ${esc((cs.keyCollisions.keys || []).slice(0, 10).map(k => typeof sftkMatchKeyLabel === 'function' ? sftkMatchKeyLabel(k) : k).join(', '))}">⚠ ${cs.keyCollisions.rows} row(s) share duplicate match keys — excluded from all actions; pick a better match field in the profile (e.g. an external Id).</div>`
      : '';
    // M3a — rows whose match key was blank (every component empty) are
    // unmatchable and were excluded from every bucket. Counted, not hidden.
    const blankNote = cs.blankKeys
      ? `<div class="ds-rec-child-info ds-match-blank-note" style="border-left:3px solid #f59e0b;padding-left:8px">⚠ ${cs.blankKeys.rows} row(s) have a blank match key — excluded from all actions (${cs.blankKeys.src} source, ${cs.blankKeys.tgt} target). Pick a better-populated match field, or use 🧪 Test this key in Pick Records.</div>`
      : '';

    return `
    <div class="ds-rec-child-body">
      ${collisionNote}${blankNote}
      <div class="ds-rec-cols ds-rec-cols-child">
        <div class="ds-rec-col">
          <div class="ds-rec-col-hdr ds-diff-missing">🔴 <strong>Insert ${cs.missingInTarget.length}</strong>
            <span class="ds-rec-col-sub">in source only</span></div>
          <div class="ds-rec-col-actions">
            <button class="ds-btn ds-btn-xs" data-recc-all="${pathKey}">✓ All</button>
            <button class="ds-btn ds-btn-xs" data-recc-none="${pathKey}">✗ None</button>
          </div>
          <div class="ds-rec-col-list">${missingRows}</div>
        </div>
        <div class="ds-rec-col">
          <div class="ds-rec-col-hdr ds-rec-chip-link">🔗 <strong>Link differs ${(cs.linkMismatch || []).length}</strong>
            <span class="ds-rec-col-sub">${relinkBlocked ? 'master-detail — not reparentable' : cs.linkTrackable ? 'same record, different parent' : 'link not trackable for this relationship'}</span></div>
          <div class="ds-rec-col-actions">
            <button class="ds-btn ds-btn-xs" data-recc-relink-all="${pathKey}" ${relinkBlocked ? `disabled title="${relinkBlockTitle}"` : ''}>⇄ All</button>
            <button class="ds-btn ds-btn-xs" data-recc-relink-none="${pathKey}">✗ None</button>
          </div>
          <div class="ds-rec-col-list">${linkRows}</div>
        </div>
      </div>
      <div class="ds-rec-cols ds-rec-cols-child">
        <div class="ds-rec-col">
          <div class="ds-rec-col-hdr ds-diff-drift">🟡 <strong>Changed ${cs.changed.length}</strong>
            <span class="ds-rec-col-sub">values differ — → updates target</span></div>
          <div class="ds-rec-col-actions">
            <button class="ds-btn ds-btn-xs" data-recc-ovw-all="${pathKey}" title="Source wins everywhere — update all drifted target records">→ All</button>
            <button class="ds-btn ds-btn-xs" data-recc-ovw-none="${pathKey}">✗ None</button>
          </div>
          <div class="ds-rec-col-list">${driftRows}</div>
        </div>
        <div class="ds-rec-col">
          <div class="ds-rec-col-hdr ds-diff-extra">🔵 <strong>In target only ${cs.onlyInTarget.length}</strong>
            <span class="ds-rec-col-sub">${orphanN ? `${orphanN} possible orphan(s) — ⇄ Relink can re-attach them` : 'pick rows to delete'}</span></div>
          <div class="ds-rec-col-actions">
            <button class="ds-btn ds-btn-xs" data-recc-del-all="${pathKey}" title="Select all for delete${orphanN ? ` — ⚠ orphan rows are excluded (select them individually)` : ''}">🗑 All</button>
            <button class="ds-btn ds-btn-xs" data-recc-del-none="${pathKey}">✗ None</button>
          </div>
          <div class="ds-rec-col-list">${extraRows}</div>
        </div>
      </div>
    </div>`;
  }

  function childSectionHtml(node, pathKey, depth = 1) {
    pathKey        = String(pathKey);
    const childObj = node.objectType || node.childSObject || '?';
    const cs       = scan.children?.[pathKey];
    const fresh    = !!(cs && cs.status === 'success' && cs.rootRunAt === scan.runAt && cs.objectType === childObj);
    const open     = !!_recChildOpen[pathKey];
    const orderCf  = (_recOrderOverride[pathKey] ?? node.insertOrder) === 'childFirst';
    const sel      = childSel(pathKey);

    // R5 — grandchild scans are scoped by their PARENT child scan's ids,
    // which must exist (and be fresh) first.
    const parentKey   = depth > 1 ? pathKey.split('.').slice(0, -1).join('.') : null;
    const parentNode  = parentKey !== null ? getNodeByPath(p.tree, parentKey) : null;
    const parentObj   = depth > 1 ? (parentNode?.objectType || parentNode?.childSObject || '?') : objType;
    const parentCs    = parentKey !== null ? scan.children?.[parentKey] : null;
    const parentFresh = depth === 1 || !!(parentCs && parentCs.status === 'success' && parentCs.rootRunAt === scan.runAt);
    // Parent-status sets for the Insert column notes: root buckets for direct
    // children (v1, unchanged), the parent child scan's buckets for grandchildren.
    const pMissingSet = depth === 1 ? rootMissingBySrc
      : new Set((parentCs?.missingInTarget || []).map(r => r.sourceId));
    const pExistsSet  = depth === 1 ? rootExistsSrc
      : new Set([...(parentCs?.changed || []).map(r => r.sourceId), ...(parentCs?.identical || []).map(r => r.sourceId)]);

    // R2 — master-detail link: children require their parent at insert, so
    // child-first ordering is impossible. R5 — grandchildren only attach to
    // existing parents, so ordering doesn't apply at depth 2 either.
    const isMD = !!(fresh && cs.linkMasterDetail);
    const orderDisabled = depth > 1 || isMD;
    const orderTitle = depth > 1
      ? `Grandchild records always attach to EXISTING parents in v2 — child-first / tree-ride ordering isn't supported at this depth.`
      : isMD
        ? `${esc(node.field || 'The link')} is a master-detail relationship — Salesforce requires the parent at insert, so these records can never be created before their parents.`
        : (orderCf
          ? 'Child-first for THIS run: these records are created before their parents, then reconnected once the parents exist. Click for default order.'
          : 'Default order for THIS run: parents are created first, then these records with the link set at insert. Click to create these records BEFORE their parents instead (for parents whose lookups need them to exist).');
    const showCf = orderCf && !orderDisabled;
    const scanBlocked = depth > 1 && !parentFresh;

    const badges = fresh ? `
      <span class="ds-diff-chip ds-diff-missing">${cs.missingInTarget.length} missing</span>
      <span class="ds-diff-chip ds-diff-drift" title="Values differ — pick → per row inside">${cs.changed.length} changed</span>
      <span class="ds-diff-chip ds-diff-extra" title="In target only — pick 🗑 per row inside">${cs.onlyInTarget.length} target-only</span>
      ${cs.linkTrackable ? `<span class="ds-diff-chip ds-rec-chip-link" title="Same record on both sides, pointing at a DIFFERENT parent in the target">${(cs.linkMismatch || []).length} link differs</span>` : ''}
      ${cs.keyCollisions ? `<span class="ds-diff-chip ds-diff-drift" title="${cs.keyCollisions.rows} row(s) share duplicate match keys and were excluded from all buckets — pick a better match field in the profile">⚠ ${cs.keyCollisions.rows} dup keys</span>` : ''}
      ${isMD ? `<span class="ds-diff-chip" title="${esc(node.field || 'The link')} is a master-detail relationship — parent required at insert${cs.linkUpdateable === false ? '; not reparentable, so Relink is disabled' : ''}">MD</span>` : ''}
      <span class="ds-diff-chip ds-diff-sync">${cs.identical.length} in sync</span>`
      : (cs ? `<span class="ds-rec-child-stale">scan stale — ${depth > 1 ? 'the parent' : 'root'} was re-scanned</span>` : '');

    return `
    <div class="ds-rec-child"${depth > 1 ? ' style="margin-left:26px"' : ''}>
      <div class="ds-rec-child-head">
        <button class="ds-tree-toggle" data-recc-toggle="${pathKey}">${open ? '▼' : '▶'}</button>
        <span class="ds-rec-child-title">${'↳'.repeat(depth)} <strong>${esc(childObj)}</strong> <span class="ds-rec-child-via">via ${esc(node.field || '?')}${depth > 1 ? ` · child of ${esc(parentObj)}` : ''}</span></span>
        ${badges}
        ${depth > 1 && (node.children || []).length ? `<span class="ds-rec-child-via" title="Reconcile scans two levels deep (children + grandchildren) in v2 — this object's own children aren't scanned here">· deeper levels not scanned (v2)</span>` : ''}
        <span class="ds-rec-child-actions">
          <button class="ds-btn ds-btn-xs ${showCf ? 'ds-btn-config--active' : ''}" ${orderDisabled ? 'disabled' : ''} data-recc-order="${pathKey}"
            title="${orderTitle}">
            ${showCf ? '⤴ before parent' : '⤵ after parent'}
          </button>
          <button class="ds-btn ds-btn-xs" data-recc-scan="${pathKey}" ${scanBlocked ? 'disabled' : ''}
            title="${scanBlocked ? `Scan the parent (${esc(parentObj)}) first — this scan is scoped to its results.` : ''}">${fresh ? '🔎 Rescan' : '🔎 Scan'}</button>
        </span>
      </div>
      ${open && fresh ? childBucketsHtml(node, pathKey, cs, sel, pMissingSet, pExistsSet, depth) : ''}
      ${open && !fresh ? `<div class="ds-rec-child-empty">${scanBlocked ? `Scan the parent (${esc(parentObj)}) section first — this scan is scoped to its results.` : `No fresh scan for this object yet — click 🔎 Scan. The scan is scoped to the ${esc(parentObj)} records above.`}</div>` : ''}
    </div>`;
  }

  setMain(`${headerHtml}
    <div class="ds-op-banner ds-op-banner-write">
      <span class="ds-op-banner-icon">⚖</span>
      <div class="ds-op-banner-body">
        <div class="ds-op-banner-title">Reconcile is bidirectional</div>
        <div class="ds-op-banner-desc">→ actions write to <strong>${esc(orgLabel(p.targetOrg))}</strong> (target); ← actions write to <strong>${esc(orgLabel(p.sourceOrg))}</strong> (source). On drifted records, pick a winner per row: <strong>→</strong> source values overwrite target, <strong>←</strong> target values overwrite source. Delete permanently removes records from target. Review your selections before running.</div>
      </div>
    </div>

    <div class="ds-rec-cols">
      ${colHtml('Insert', 'in source only', 'ds-diff-missing', '🔴', missing, 'push')}
      ${driftColHtml(drift)}
      ${extrasColHtml(extras)}
    </div>

    ${!p.ephemeral && (missing.length || extras.length) ? `
    <div class="ds-mm-review-row" style="display:flex;align-items:center;gap:10px;margin:8px 0 2px">
      <button class="ds-btn ds-btn-sm" id="dsMatchReviewBtn"
        title="Manually pair 'in source only' rows with 'in target only' rows that are actually the same record (renamed, typo'd, …). Pairs are remembered per target org and match by identity on every future scan.">🔗 Match review (${missing.length} + ${extras.length} unmatched)</button>
      <span style="font-size:11.5px;color:var(--subtext)">same record on both sides under different keys? Pair them once — matching then survives renames.</span>
    </div>` : ''}
    <div class="ds-rec-insync-note">🟢 ${inSync.length} record(s) already in sync — no action needed.</div>
    ${scan.blankKeys ? `<div class="ds-rec-child-info ds-match-blank-note" style="border-left:3px solid #f59e0b;padding-left:8px;margin:6px 0">⚠ ${scan.blankKeys.rows} row(s) have a blank match key — excluded from matching (${scan.blankKeys.src} source, ${scan.blankKeys.tgt} target). Pick a better-populated match field in 🎯 Pick Records (🧪 Test this key grades candidates).</div>` : ''}
    ${(scan.warnings || []).length ? `<div class="ds-rec-child-info ds-mm-warn-note" style="border-left:3px solid #f59e0b;padding-left:8px;margin:6px 0">⚠ ${esc(scan.warnings.join(' · '))}</div>` : ''}

    ${rootChildren.length ? `
    <div class="ds-rec-children">
      <div class="ds-rec-children-hdr">🔗 Related objects
        <span class="ds-rec-children-sub">insert child records and reconnect them to their parents — scans are scoped to the ${esc(objType)} records above · two levels deep (children + grandchildren) in v2</span>
      </div>
      ${rootChildren.map((c, i) => {
        let html = childSectionHtml(c, String(i), 1);
        // R5 — grandchildren: one level deeper, rendered indented under their
        // parent section. A render error in the new depth-2 path degrades to
        // a warning line instead of killing the whole view.
        (c.children || []).forEach((g, j) => {
          try { html += childSectionHtml(g, `${i}.${j}`, 2); }
          catch (e) { html += `<div class="ds-rec-child-empty">⚠ couldn't render the ${esc(g?.objectType || g?.childSObject || 'grandchild')} section: ${esc(e?.message || String(e))}</div>`; }
        });
        return html;
      }).join('')}
    </div>` : ''}

    <div class="ds-rec-action-bar">
      <div class="ds-rec-action-summary" id="dsRecSummary"></div>
      <label class="ds-rec-delmode" title="Recycle Bin: deleted records recoverable for 15 days. Hard delete: permanently purged, not recoverable.">
        <span>Delete mode:</span>
        <select id="dsRecDeleteMode" class="ds-select ds-select-sm">
          <option value="recycle" ${_recDeleteMode === 'recycle' ? 'selected' : ''}>🗑 Recycle Bin (recoverable)</option>
          <option value="hard" ${_recDeleteMode === 'hard' ? 'selected' : ''}>🔥 Hard delete (permanent)</option>
        </select>
      </label>
      <div class="ds-rec-action-btns">
        <button class="ds-btn" id="dsRecCancelBtn">Cancel</button>
        <button class="ds-btn ds-btn-primary ds-btn-lg" id="dsRecRunBtn">▶ Run reconcile</button>
      </div>
    </div>

    <div id="dsRecProgress"></div>
  `);

  function updateSummary() {
    const el = eid('dsRecSummary');
    if (!el) return;
    const parts = [];
    if (_recSel.push.size)      parts.push(`<span class="ds-diff-chip ds-diff-missing">Insert ${_recSel.push.size}</span>`);
    if (_recSel.overwrite.size) parts.push(`<span class="ds-diff-chip ds-diff-drift">→ Update target ${_recSel.overwrite.size}</span>`);
    if (_recSel.updSrc.size)    parts.push(`<span class="ds-diff-chip ds-diff-pull">← Update source ${_recSel.updSrc.size}</span>`);
    if (_recSel.pull.size)      parts.push(`<span class="ds-diff-chip ds-diff-pull">← Pull ${_recSel.pull.size}</span>`);
    if (_recSel.del.size)       parts.push(`<span class="ds-diff-chip ds-diff-extra">Delete ${_recSel.del.size}</span>`);
    // Child-object actions (insert / relink), per relationship.
    for (const [k, sel] of Object.entries(_recChildSel)) {
      const node = getNodeByPath(p.tree, k);
      const obj  = node?.objectType || node?.childSObject || '?';
      if (sel.push.size)        parts.push(`<span class="ds-diff-chip ds-diff-missing">Insert ${sel.push.size} ${esc(obj)}</span>`);
      if (sel.relink.size)      parts.push(`<span class="ds-diff-chip ds-rec-chip-link">⇄ Relink ${sel.relink.size} ${esc(obj)}</span>`);
      if (sel.overwrite?.size)  parts.push(`<span class="ds-diff-chip ds-diff-drift">→ Update ${sel.overwrite.size} ${esc(obj)}</span>`);
      if (sel.del?.size)        parts.push(`<span class="ds-diff-chip ds-diff-extra">Delete ${sel.del.size} ${esc(obj)}</span>`);
    }
    el.innerHTML = parts.length ? `Actions: ${parts.join(' ')}` : '<span style="color:var(--subtext)">Nothing selected</span>';
    const runBtn = eid('dsRecRunBtn');
    if (runBtn) runBtn.disabled = !parts.length;
    // Refresh the extras column subcounts as the user toggles per-row picks.
    const sub = document.querySelector('.ds-rec-extra-subcounts:not(.ds-rec-drift-subcounts)');
    if (sub) {
      const totalExtras = extras.length;
      const pullN = _recSel.pull.size;
      const delN  = _recSel.del.size;
      sub.innerHTML = `
        <span class="ds-rec-extra-sub-pull">← ${pullN} to pull</span>
        <span class="ds-rec-extra-sub-del">🗑 ${delN} to delete</span>
        <span class="ds-rec-extra-sub-skip">${totalExtras - pullN - delN} skipped</span>`;
    }
    // Drift column subcounts likewise.
    const dsub = document.querySelector('.ds-rec-drift-subcounts');
    if (dsub) {
      const pushN = _recSel.overwrite.size;
      const usN   = _recSel.updSrc.size;
      dsub.innerHTML = `
        <span class="ds-rec-drift-sub-push">→ ${pushN} to target</span>
        <span class="ds-rec-extra-sub-pull">← ${usN} to source</span>
        <span class="ds-rec-extra-sub-skip">${drift.length - pushN - usN} skipped</span>`;
    }
  }
  updateSummary();

  // Wire checkboxes for the source-driven columns (push, overwrite)
  document.querySelectorAll('[data-rec-kind]').forEach(cb => {
    cb.addEventListener('change', () => {
      const kind = cb.dataset.recKind, id = cb.dataset.recId;
      if (cb.checked) _recSel[kind].add(id); else _recSel[kind].delete(id);
      updateSummary();
    });
  });
  // All / None per column (push + overwrite only — extras has its own handlers)
  document.querySelectorAll('[data-rec-all]').forEach(btn => btn.addEventListener('click', () => {
    const kind = btn.dataset.recAll;
    document.querySelectorAll(`[data-rec-kind="${kind}"]`).forEach(cb => { cb.checked = true; _recSel[kind].add(cb.dataset.recId); });
    updateSummary();
  }));
  document.querySelectorAll('[data-rec-none]').forEach(btn => btn.addEventListener('click', () => {
    const kind = btn.dataset.recNone;
    document.querySelectorAll(`[data-rec-kind="${kind}"]`).forEach(cb => { cb.checked = false; _recSel[kind].delete(cb.dataset.recId); });
    updateSummary();
  }));

  // Phase 3B — extras column per-row Pull/Delete buttons (mutually exclusive).
  // Click an already-selected action to deselect it (= Skip).
  function paintExtraRow(rowEl, tgtId) {
    const pullBtn = rowEl.querySelector('[data-rec-extra="pull"]');
    const delBtn  = rowEl.querySelector('[data-rec-extra="del"]');
    if (pullBtn) pullBtn.classList.toggle('ds-rec-extra-on-pull', _recSel.pull.has(tgtId));
    if (delBtn)  delBtn.classList.toggle('ds-rec-extra-on-del',   _recSel.del.has(tgtId));
  }
  document.querySelectorAll('[data-rec-extra]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      const action = btn.dataset.recExtra;            // 'pull' or 'del'
      const tgtId  = btn.dataset.recId;
      const other  = action === 'pull' ? 'del' : 'pull';
      if (_recSel[action].has(tgtId)) {
        _recSel[action].delete(tgtId);                // toggle off → Skip
      } else {
        _recSel[action].add(tgtId);
        _recSel[other].delete(tgtId);                 // mutually exclusive
      }
      paintExtraRow(btn.closest('.ds-rec-row-extra'), tgtId);
      updateSummary();
    });
  });
  // Bulk: Pull all / Delete all / None for the extras column.
  document.querySelectorAll('[data-rec-extra-all]').forEach(btn => btn.addEventListener('click', () => {
    const action = btn.dataset.recExtraAll;           // 'pull' or 'del'
    const other  = action === 'pull' ? 'del' : 'pull';
    extras.forEach(r => {
      _recSel[action].add(r.targetId);
      _recSel[other].delete(r.targetId);
    });
    document.querySelectorAll('.ds-rec-row-extra').forEach(row => {
      const id = row.querySelector('[data-rec-id]')?.dataset.recId;
      if (id) paintExtraRow(row, id);
    });
    updateSummary();
  }));
  document.querySelector('[data-rec-extra-clear]')?.addEventListener('click', () => {
    extras.forEach(r => { _recSel.pull.delete(r.targetId); _recSel.del.delete(r.targetId); });
    document.querySelectorAll('.ds-rec-row-extra').forEach(row => {
      const id = row.querySelector('[data-rec-id]')?.dataset.recId;
      if (id) paintExtraRow(row, id);
    });
    updateSummary();
  });

  // Phase 3B v2 — drift column per-row direction buttons (→ target wins /
  // ← source wins, mutually exclusive; click the active one to skip).
  function paintDriftRow(rowEl, sid) {
    const pushBtn = rowEl.querySelector('[data-rec-driftdir="overwrite"]');
    const pullBtn = rowEl.querySelector('[data-rec-driftdir="updSrc"]');
    if (pushBtn) pushBtn.classList.toggle('ds-rec-extra-on-push', _recSel.overwrite.has(sid));
    if (pullBtn) pullBtn.classList.toggle('ds-rec-extra-on-pull', _recSel.updSrc.has(sid));
  }
  document.querySelectorAll('[data-rec-driftdir]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      const action = btn.dataset.recDriftdir;          // 'overwrite' | 'updSrc'
      const sid    = btn.dataset.recId;
      const other  = action === 'overwrite' ? 'updSrc' : 'overwrite';
      if (_recSel[action].has(sid)) {
        _recSel[action].delete(sid);                   // toggle off → Skip
      } else {
        _recSel[action].add(sid);
        _recSel[other].delete(sid);                    // mutually exclusive
      }
      paintDriftRow(btn.closest('.ds-rec-row-drift'), sid);
      updateSummary();
    });
  });
  document.querySelectorAll('[data-rec-driftdir-all]').forEach(btn => btn.addEventListener('click', () => {
    const action = btn.dataset.recDriftdirAll;
    const other  = action === 'overwrite' ? 'updSrc' : 'overwrite';
    drift.forEach(r => {
      _recSel[action].add(r.sourceId);
      _recSel[other].delete(r.sourceId);
    });
    document.querySelectorAll('.ds-rec-row-drift').forEach(row => {
      const id = row.querySelector('[data-rec-id]')?.dataset.recId;
      if (id) paintDriftRow(row, id);
    });
    updateSummary();
  }));
  document.querySelector('[data-rec-driftdir-clear]')?.addEventListener('click', () => {
    drift.forEach(r => { _recSel.overwrite.delete(r.sourceId); _recSel.updSrc.delete(r.sourceId); });
    document.querySelectorAll('.ds-rec-row-drift').forEach(row => {
      const id = row.querySelector('[data-rec-id]')?.dataset.recId;
      if (id) paintDriftRow(row, id);
    });
    updateSummary();
  });
  // Drift "fields" expander — reuse fetchDriftRowDetail + renderDriftCompareTable
  document.querySelectorAll('[data-rec-drift]').forEach(link => {
    link.addEventListener('click', async (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const [srcId, tgtId] = (link.dataset.recDrift || '').split('|');
      const expand = document.querySelector(`.ds-rec-drift-expand[data-drift-expand="${srcId}"]`);
      if (!expand) return;
      if (expand.dataset.loaded === '1') {
        expand.style.display = expand.style.display === 'none' ? 'block' : 'none';
        return;
      }
      expand.style.display = 'block';
      expand.innerHTML = `<div class="ds-drift-compare-loading">Loading…</div>`;
      const srcFields = scan.compareFields || [];
      const tgtFields = scan.compareFieldsTgt || scan.compareFields || [];
      const res = await fetchDriftRowDetail(p, objType, srcId, tgtId, srcFields, tgtFields);
      if (res.error) {
        // Fall back to the scan-time answer when the live fetch can't run.
        const row = drift.find(r => r.sourceId === srcId);
        const fieldsNote = (row?.fields || []).length
          ? `<div class="ds-drift-compare-fallback">At the last scan these field(s) differed:
               <strong>${esc(row.fields.join(', '))}</strong></div>`
          : '';
        expand.innerHTML = `${fieldsNote}<div class="ds-drift-compare-err">⚠ ${esc(res.error)}</div>`;
      } else {
        expand.innerHTML = renderDriftCompareTable(res.srcRec, res.tgtRec, srcFields, tgtFields, res.lookupMap || {});
      }
      expand.dataset.loaded = '1';
    });
  });

  // ── Child section wiring ────────────────────────────────────────────
  document.querySelectorAll('[data-recc-toggle]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.reccToggle;
    _recChildOpen[k] = !_recChildOpen[k];
    renderReconcile();
  }));
  document.querySelectorAll('[data-recc-scan]').forEach(b => b.addEventListener('click', async () => {
    const k = b.dataset.reccScan;
    b.disabled = true; b.textContent = '⏳ scanning…';
    const res = await scanReconcileChild(p, k);
    if (res?.error) showToast(`Child scan: ${res.error}`, 'error', 6000);
    else _recChildOpen[k] = true;
    renderReconcile();
  }));
  document.querySelectorAll('[data-recc-order]').forEach(b => b.addEventListener('click', () => {
    const k    = b.dataset.reccOrder;
    const node = getNodeByPath(p.tree, k);
    const cur  = (_recOrderOverride[k] ?? node?.insertOrder) === 'childFirst';
    _recOrderOverride[k] = cur ? 'parentFirst' : 'childFirst';   // run-scoped, never saved
    renderReconcile();
  }));
  document.querySelectorAll('[data-recc-push]').forEach(cb => cb.addEventListener('change', () => {
    const sel = childSel(cb.dataset.reccPush);
    if (cb.checked) sel.push.add(cb.dataset.recId); else sel.push.delete(cb.dataset.recId);
    updateSummary();
  }));
  document.querySelectorAll('[data-recc-all]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.reccAll, sel = childSel(k);
    document.querySelectorAll(`[data-recc-push="${k}"]:not(:disabled)`).forEach(cb => { cb.checked = true; sel.push.add(cb.dataset.recId); });
    updateSummary();
  }));
  document.querySelectorAll('[data-recc-none]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.reccNone, sel = childSel(k);
    document.querySelectorAll(`[data-recc-push="${k}"]`).forEach(cb => { cb.checked = false; });
    sel.push.clear();
    updateSummary();
  }));
  document.querySelectorAll('[data-recc-relink]').forEach(b => b.addEventListener('click', e => {
    e.preventDefault();
    const sel = childSel(b.dataset.reccRelink), id = b.dataset.recId;
    if (sel.relink.has(id)) sel.relink.delete(id); else sel.relink.add(id);
    b.classList.toggle('ds-rec-extra-on-push', sel.relink.has(id));
    updateSummary();
  }));
  document.querySelectorAll('[data-recc-relink-all]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.reccRelinkAll, sel = childSel(k);
    (scan.children?.[k]?.linkMismatch || []).forEach(r => sel.relink.add(r.targetId));
    document.querySelectorAll(`[data-recc-relink="${k}"]`).forEach(x => x.classList.add('ds-rec-extra-on-push'));
    updateSummary();
  }));
  document.querySelectorAll('[data-recc-relink-none]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.reccRelinkNone;
    childSel(k).relink.clear();
    document.querySelectorAll(`[data-recc-relink="${k}"]`).forEach(x => x.classList.remove('ds-rec-extra-on-push'));
    updateSummary();
  }));
  // R4 — child drift → overwrite toggles (per-row + All/None).
  document.querySelectorAll('[data-recc-ovw]').forEach(b => b.addEventListener('click', e => {
    e.preventDefault();
    const sel = childSel(b.dataset.reccOvw), id = b.dataset.recId;
    if (sel.overwrite.has(id)) sel.overwrite.delete(id); else sel.overwrite.add(id);
    b.classList.toggle('ds-rec-extra-on-push', sel.overwrite.has(id));
    updateSummary();
  }));
  document.querySelectorAll('[data-recc-ovw-all]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.reccOvwAll, sel = childSel(k);
    (scan.children?.[k]?.changed || []).forEach(r => { if (r.sourceId) sel.overwrite.add(r.sourceId); });
    document.querySelectorAll(`[data-recc-ovw="${k}"]`).forEach(x => x.classList.add('ds-rec-extra-on-push'));
    updateSummary();
  }));
  document.querySelectorAll('[data-recc-ovw-none]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.reccOvwNone;
    childSel(k).overwrite.clear();
    document.querySelectorAll(`[data-recc-ovw="${k}"]`).forEach(x => x.classList.remove('ds-rec-extra-on-push'));
    updateSummary();
  }));
  // R4 — child target-only 🗑 delete toggles. R3 — "🗑 All" skips rows tagged
  // as possible orphans; they stay individually selectable.
  document.querySelectorAll('[data-recc-del]').forEach(b => b.addEventListener('click', e => {
    e.preventDefault();
    const sel = childSel(b.dataset.reccDel), id = b.dataset.recId;
    if (sel.del.has(id)) sel.del.delete(id); else sel.del.add(id);
    b.classList.toggle('ds-rec-extra-on-del', sel.del.has(id));
    updateSummary();
  }));
  document.querySelectorAll('[data-recc-del-all]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.reccDelAll, sel = childSel(k);
    (scan.children?.[k]?.onlyInTarget || []).forEach(r => { if (r.targetId && !r.orphan) sel.del.add(r.targetId); });
    document.querySelectorAll(`[data-recc-del="${k}"]`).forEach(x => {
      x.classList.toggle('ds-rec-extra-on-del', sel.del.has(x.dataset.recId));
    });
    updateSummary();
  }));
  document.querySelectorAll('[data-recc-del-none]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.reccDelNone;
    childSel(k).del.clear();
    document.querySelectorAll(`[data-recc-del="${k}"]`).forEach(x => x.classList.remove('ds-rec-extra-on-del'));
    updateSummary();
  }));

  eid('dsRecBackBtn')?.addEventListener('click', renderProfiles);
  eid('dsRecCancelBtn')?.addEventListener('click', renderProfiles);
  eid('dsRecRefreshBtn')?.addEventListener('click', async () => {
    await window.refreshProfileState(p.id);
    { const _fp = _profiles.find(x => x.id === p.id); if (_fp) _reconcileProfile = _fp; }
    _recSel = { push: new Set(), overwrite: new Set(), updSrc: new Set(), del: new Set(), pull: new Set() };
    _recChildSel = {};   // child buckets changed too — selections are stale
    renderReconcile();
  });
  eid('dsRecDeleteMode')?.addEventListener('change', e => { _recDeleteMode = e.target.value; });
  eid('dsRecRunBtn')?.addEventListener('click', () => runReconcile(p, objType, { missing, drift, extras }));
  eid('dsMatchReviewBtn')?.addEventListener('click', () => openMatchReview(p));
}

// ════════════════════════════════════════════════════════════════
// M3c — MATCH REVIEW: human pairing of unmatched rows → match memory
// ════════════════════════════════════════════════════════════════
// Left list: "in source only" rows. For the selected row, the right list
// shows the top-5 "in target only" candidates ranked by sftkPairSimilarity
// on the (already-normalized) match keys. The % is a RANKING HINT ONLY —
// nothing is ever paired automatically; [Pair ⇒] is the human decision.
// Pairing records srcId→tgtId via window.sftkLearnPairs (persistent match
// memory, per target org), removes both rows from the scan buckets in
// place, and re-renders the modal. Not offered on ephemeral profiles
// (ring/compare clones) — memory belongs to the saved deployment.
function openMatchReview(p) {
  const scan = p?.lastScan;
  if (!scan) return;
  const tgtKey = _orgKey(p.targetOrg || '');
  const lbl = k => esc(typeof sftkMatchKeyLabel === 'function' ? sftkMatchKeyLabel(k) : String(k ?? ''));
  let paired = 0;         // pairs made this modal session
  let selSrcId = null;    // selected "in source only" row
  let clearArmed = false; // two-click confirm for the clear-memory button

  function finish() {
    closeModal();
    if (paired > 0) {
      showToast(`${paired} pair(s) remembered — 🔄 Refresh state to see their drift status`, 'success', 6000);
      renderReconcile();
    }
  }

  function render() {
    const missing = scan.missingInTarget || [];
    const extras  = scan.onlyInTarget || [];
    const memN    = Object.keys((p.matchMemory || {})[tgtKey] || {}).length;
    clearArmed = false;
    if (!selSrcId || !missing.some(r => r.sourceId === selSrcId)) {
      selSrcId = missing.length ? missing[0].sourceId : null;
    }
    const selRow = missing.find(r => r.sourceId === selSrcId) || null;

    const listHtml = missing.length ? missing.map(r => `
      <div class="ds-mm-src" data-mm-src="${esc(r.sourceId)}"
        style="padding:5px 8px;cursor:pointer;border-bottom:1px solid rgba(128,128,128,.15);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap${r.sourceId === selSrcId ? ';background:#eef2ff;font-weight:600' : ''}"
        title="${lbl(r.matchKey)}">${lbl(r.matchKey)}</div>`).join('')
      : `<div class="ds-rec-col-empty" style="padding:10px">no unmatched source records 🎉</div>`;

    let candHtml;
    if (!selRow) {
      candHtml = `<div class="ds-rec-col-empty" style="padding:10px">select a source row on the left</div>`;
    } else if (!extras.length) {
      candHtml = `<div class="ds-rec-col-empty" style="padding:10px">no unmatched target records to pair with</div>`;
    } else {
      let ranked;
      try {
        ranked = extras
          .map(r => ({ r, sim: sftkPairSimilarity(String(selRow.matchKey ?? ''), String(r.matchKey ?? '')) }))
          .sort((a, b) => b.sim - a.sim)
          .slice(0, 5);
      } catch (_) {
        ranked = extras.slice(0, 5).map(r => ({ r, sim: 0 }));   // degrade: unranked
      }
      candHtml = ranked.map(c => `
        <div class="ds-mm-cand" style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-bottom:1px solid rgba(128,128,128,.15);font-size:12px">
          <span style="min-width:38px;text-align:right;color:var(--subtext);font-variant-numeric:tabular-nums" title="Key similarity — a ranking hint only, never an automatic match">${Math.round(c.sim * 100)}%</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${lbl(c.r.matchKey)}">${lbl(c.r.matchKey)}${c.r.orphan ? ' <span class="ds-chip">possible orphan</span>' : ''}</span>
          <button class="ds-btn ds-btn-xs ds-btn-primary" data-mm-pair="${esc(c.r.targetId)}"
            title="These two are the SAME record — remember the pair. Future scans match them by identity, even after renames.">Pair ⇒</button>
        </div>`).join('');
    }

    showModal(`
      <div class="ds-modal-header">🔗 Match review — ${esc(scan.objectType || '')}</div>
      <div class="ds-modal-body">
        <p style="font-size:12px;color:var(--subtext);margin:0 0 10px">Pick a source record, then pair it with the target record it actually is (renamed, retyped, …). Pairs are remembered 🧠 per target org and matched by identity on every future scan. The % is a similarity <em>hint</em> — pairing is always your call.</p>
        <div class="ds-mm-grid" style="display:flex;gap:12px;max-height:340px">
          <div style="flex:1;min-width:0;overflow:auto;border:1px solid rgba(128,128,128,.35);border-radius:6px">
            <div style="padding:5px 8px;font-weight:600;font-size:11px;position:sticky;top:0;background:inherit;border-bottom:1px solid rgba(128,128,128,.25)">🔴 In source only (${missing.length})</div>
            ${listHtml}
          </div>
          <div style="flex:1.25;min-width:0;overflow:auto;border:1px solid rgba(128,128,128,.35);border-radius:6px">
            <div style="padding:5px 8px;font-weight:600;font-size:11px;position:sticky;top:0;background:inherit;border-bottom:1px solid rgba(128,128,128,.25)">🔵 Closest "in target only" candidates${selRow ? ` for <em>${lbl(selRow.matchKey)}</em>` : ''}</div>
            ${candHtml}
          </div>
        </div>
      </div>
      <div class="ds-modal-footer" style="display:flex;gap:8px;align-items:center">
        <button class="ds-btn ds-btn-sm" id="dsMmClearMem" ${memN ? '' : 'disabled'}
          title="Forget every remembered pair for this target org — those records fall back to key matching on the next scan.">🧠 Clear memory for this org (${memN} remembered)</button>
        <span style="flex:1"></span>
        ${paired ? `<span class="ds-chip">🧠 ${paired} paired</span>` : ''}
        <button class="ds-btn ds-btn-primary" id="dsMmClose">Done</button>
      </div>`);

    document.querySelectorAll('[data-mm-src]').forEach(el =>
      el.addEventListener('click', () => { selSrcId = el.dataset.mmSrc; render(); }));

    document.querySelectorAll('[data-mm-pair]').forEach(btn =>
      btn.addEventListener('click', async () => {
        const tgtId  = btn.dataset.mmPair;
        const srcRow = (scan.missingInTarget || []).find(r => r.sourceId === selSrcId);
        const tgtRow = (scan.onlyInTarget || []).find(r => r.targetId === tgtId);
        if (!srcRow || !tgtRow) return;
        try {
          await window.sftkLearnPairs?.(p.id, p.targetOrg, [[srcRow.sourceId, tgtRow.targetId]]);
          // Remove BOTH rows from the scan buckets in place — the pair is no
          // longer "missing"/"extra". Its identical-vs-drift status needs a
          // rescan (the closing toast says so).
          const mi = (scan.missingInTarget || []).indexOf(srcRow);
          if (mi !== -1) scan.missingInTarget.splice(mi, 1);
          const ei = (scan.onlyInTarget || []).indexOf(tgtRow);
          if (ei !== -1) scan.onlyInTarget.splice(ei, 1);
          // Drop them from pending reconcile selections — running an Insert
          // (or Delete/Pull) against a just-paired record would duplicate it.
          _recSel.push.delete(srcRow.sourceId);
          _recSel.del.delete(tgtRow.targetId);
          _recSel.pull.delete(tgtRow.targetId);
          paired++;
          if (!p.ephemeral) await storageSaveProfiles();   // persist the bucket edit
        } catch (e) {
          showToast(`Couldn't record the pair: ${e?.message || e}`, 'error', 5000);
        }
        render();
      }));

    eid('dsMmClearMem')?.addEventListener('click', async () => {
      const b = eid('dsMmClearMem');
      if (!clearArmed) {
        clearArmed = true;
        if (b) {
          b.textContent = `⚠ Really forget ${memN} remembered pair(s)? Click again`;
          b.classList.add('ds-btn-danger');
        }
        return;
      }
      try {
        if (p.matchMemory) delete p.matchMemory[tgtKey];
        const real = _profiles.find(x => x.id === p.id);
        if (real && real !== p && real.matchMemory) delete real.matchMemory[tgtKey];
        await storageSaveProfiles();
        showToast('Match memory cleared for this org — the next scan matches by key only', 'success', 4500);
      } catch (e) {
        showToast(`Couldn't clear match memory: ${e?.message || e}`, 'error', 5000);
      }
      render();
    });

    eid('dsMmClose')?.addEventListener('click', finish);
  }
  render();
}

// Execute the selected reconcile actions. Deletes require a confirmation
// modal (destructive). Push reuses the transfer engine (root-only profile
// clone). Overwrite uses SF_COLLECTIONS_UPDATE.
async function runReconcile(profile, objType, buckets) {
  const pushIds   = [..._recSel.push];
  const ovwIds    = [..._recSel.overwrite];
  const updSrcIds = [..._recSel.updSrc];
  const delIds    = [..._recSel.del];
  const pullIds   = [..._recSel.pull];

  // ── Child-aware selections (v1: Insert + Relink) ──────────────────────
  // Each selected child insert is partitioned by where its parent lives:
  //   group A — parent is missing in target too → the child rides a TREE
  //             transfer with its parent (auto-including parents the user
  //             didn't tick); the engine orders + reconnects.
  //   group B — parent already exists in target → child-rooted transfer
  //             with a match bridge on the link field (attached at insert).
  const rootScan         = profile.lastScan || {};
  const rootMissingSrc   = new Set((rootScan.missingInTarget || []).map(r => r.sourceId));
  const rootExistsSrcSet = new Set([...(rootScan.changed || []).map(r => r.sourceId),
                                    ...(rootScan.identical || []).map(r => r.sourceId)]);
  const childActs = Object.entries(_recChildSel)
    .map(([k, sel]) => ({ pathKey: k, node: getNodeByPath(profile.tree, k), sel,
                          cs: rootScan.children?.[k] }))
    .filter(a => a.node && a.cs && (a.sel.push.size || a.sel.relink.size || a.sel.overwrite?.size || a.sel.del?.size));
  for (const a of childActs) {
    a.groupA = []; a.groupB = []; a.autoParents = new Set(); a.skippedDeep = 0;
    // R5 — depth + parent context. Direct children ('0') use the ROOT scan's
    // buckets (v1, unchanged). Grandchildren ('0.1') use their PARENT child
    // scan's buckets, and only support push-with-existing-parent + relink —
    // tree-ride (group A) stays root+child. Any failure resolving the parent
    // context degrades to v1 root-based behavior.
    a.depth = String(a.pathKey).split('.').length;
    let pMissingSet = rootMissingSrc, pExistsSet = rootExistsSrcSet;
    a.parentObj = objType; a.parentScan = rootScan;
    if (a.depth > 1) {
      try {
        const pk    = String(a.pathKey).split('.').slice(0, -1).join('.');
        const pNode = getNodeByPath(profile.tree, pk);
        a.parentObj  = pNode?.objectType || pNode?.childSObject || objType;
        a.parentScan = rootScan.children?.[pk] || rootScan;
        pMissingSet  = new Set((a.parentScan.missingInTarget || []).map(r => r.sourceId));
        pExistsSet   = new Set([...(a.parentScan.changed || []).map(r => r.sourceId),
                                ...(a.parentScan.identical || []).map(r => r.sourceId)]);
      } catch (_) { a.parentObj = objType; a.parentScan = rootScan; }
    }
    for (const id of a.sel.push) {
      const row = (a.cs.missingInTarget || []).find(r => r.sourceId === id);
      if (!row) continue;
      if (row.parentSrcId && pMissingSet.has(row.parentSrcId)) {
        if (a.depth > 1) { a.skippedDeep++; continue; }   // R5 — no tree-ride at this depth
        a.groupA.push(id);
        if (!_recSel.push.has(row.parentSrcId)) a.autoParents.add(row.parentSrcId);
      } else if (!row.parentSrcId || pExistsSet.has(row.parentSrcId)) {
        a.groupB.push(id);   // parent exists in target (or record has no parent)
      }
      // parent untracked → row was disabled in the UI; unreachable here
    }
    // R4 — drift overwrites + target-only deletes, validated against the
    // child scan's buckets so stray ids can never reach the writers.
    a.ovwIds = [...(a.sel.overwrite || [])].filter(id => (a.cs.changed || []).some(r => r.sourceId === id));
    a.delIds = [...(a.sel.del || [])].filter(id => (a.cs.onlyInTarget || []).some(r => r.targetId === id));
  }
  const childDelTotal = childActs.reduce((s, a) => s + a.delIds.length, 0);
  const anyChildAct = childActs.some(a => a.groupA.length || a.groupB.length || a.sel.relink.size || a.ovwIds.length || a.delIds.length);

  if (!pushIds.length && !ovwIds.length && !updSrcIds.length && !delIds.length && !pullIds.length && !anyChildAct) return;

  // ── Confirmation step ────────────────────────────────────────────────
  // If anything destructive (delete) or anything that writes to the SOURCE
  // org (pull insert / ← update) is selected, surface a single combined
  // confirm modal so the user sees the full impact before any writes happen.
  const isHard = _recDeleteMode === 'hard';

  // ── Production-org guard ──────────────────────────────────────────────
  // Hard delete is flatly disabled against production; regular deletes into
  // production require typing the org name (after the standard confirm).
  const tgtOrgType = await ensureOrgType(profile.targetOrg);
  if (tgtOrgType === 'production' && isHard && (delIds.length || childDelTotal)) {
    showToast('🔥 Hard delete is disabled against PRODUCTION orgs — switch Delete mode to Recycle Bin.', 'error', 7000);
    return;
  }

  // Numbered execution plan — mirrors the exact order the phases run in, so
  // what the user reads in the confirm modal is literally what happens.
  const planLines = [];
  if (anyChildAct) {
    let n = 1;
    const totalAutoParents = childActs.reduce((s, a) => s + a.autoParents.size, 0);
    const rootInsertTotal  = pushIds.length + totalAutoParents;
    // R2 — for master-detail links a run-scoped child-first override is
    // silently impossible (parent required at insert); the executor below
    // forces parent-first, so the plan must say the same.
    const actCf = (a) => a.depth === 1 && !a.cs?.linkMasterDetail &&
      (_recOrderOverride[a.pathKey] ?? a.node.insertOrder) === 'childFirst';
    for (const a of childActs) {
      if (a.delIds.length) planLines.push(`${n++}. Delete ${a.delIds.length} ${a.node.objectType || a.node.childSObject} from target (${isHard ? 'PERMANENT' : 'Recycle Bin'})`);
    }
    if (delIds.length) planLines.push(`${n++}. Delete ${delIds.length} ${objType} from target (${isHard ? 'PERMANENT' : 'Recycle Bin'})`);
    if (pullIds.length) planLines.push(`${n++}. Pull ${pullIds.length} ${objType} into source`);
    for (const a of childActs) {
      const obj = a.node.objectType || a.node.childSObject;
      if (a.groupA.length && actCf(a)) planLines.push(`${n++}. Insert ${a.groupA.length} ${obj} (child-first — created before their parents, without ${a.node.field})`);
    }
    if (rootInsertTotal) planLines.push(`${n++}. Insert ${rootInsertTotal} ${objType}${totalAutoParents ? ` (${totalAutoParents} parent(s) auto-included for selected children)` : ''}`);
    for (const a of childActs) {
      const obj  = a.node.objectType || a.node.childSObject;
      const pObj = a.parentObj || objType;
      const cf   = actCf(a);
      if (a.groupA.length && cf)  planLines.push(`${n++}. Reconnect ${a.groupA.length} ${obj} → ${objType} (link patched after the parents exist)`);
      if (a.groupA.length && !cf) planLines.push(`${n++}. Insert ${a.groupA.length} ${obj} under the new ${objType} (linked at insert)`);
      if (a.groupB.length)        planLines.push(`${n++}. Insert ${a.groupB.length} ${obj} under existing ${pObj} (matched by ${((a.parentScan || rootScan).matching?.fields || [(a.parentScan || rootScan).matchField || 'Name']).join(' + ')})`);
      if (a.sel.relink.size)      planLines.push(`${n++}. Relink ${a.sel.relink.size} ${obj} to the right ${pObj}`);
      if (a.ovwIds.length)        planLines.push(`${n++}. Update ${a.ovwIds.length} drifted ${obj} in target`);
    }
    if (ovwIds.length)    planLines.push(`${n++}. Update ${ovwIds.length} drifted ${objType} in target`);
    if (updSrcIds.length) planLines.push(`${n++}. Update ${updSrcIds.length} ${objType} in source`);
  }

  if (delIds.length || pullIds.length || updSrcIds.length || anyChildAct) {
    const ok = await new Promise(resolve => {
      const delBlock = delIds.length ? (isHard
        ? `<div style="margin-top:10px;padding:10px 12px;background:#fef2f2;border-left:3px solid #dc2626;border-radius:4px;font-size:12px;color:#991b1b">
             🔥 <strong>Hard-delete ${delIds.length} ${esc(objType)} record(s)</strong> from
             <strong>${esc(orgLabel(profile.targetOrg))}</strong> — purged from the Recycle Bin and
             <strong>cannot be recovered</strong>.</div>`
        : `<div style="margin-top:10px;padding:10px 12px;background:#fffbeb;border-left:3px solid #f59e0b;border-radius:4px;font-size:12px;color:#92400e">
             🗑 <strong>Delete ${delIds.length} ${esc(objType)} record(s)</strong> from
             <strong>${esc(orgLabel(profile.targetOrg))}</strong> — recoverable from the Recycle Bin for 15 days.</div>`) : '';
      // R4 — child deletes get their own warning block (they run FIRST).
      const childDelBlock = childDelTotal ? (isHard
        ? `<div style="margin-top:10px;padding:10px 12px;background:#fef2f2;border-left:3px solid #dc2626;border-radius:4px;font-size:12px;color:#991b1b">
             🔥 <strong>Hard-delete ${childDelTotal} child record(s)</strong> from
             <strong>${esc(orgLabel(profile.targetOrg))}</strong> — purged from the Recycle Bin and
             <strong>cannot be recovered</strong>.</div>`
        : `<div style="margin-top:10px;padding:10px 12px;background:#fffbeb;border-left:3px solid #f59e0b;border-radius:4px;font-size:12px;color:#92400e">
             🗑 <strong>Delete ${childDelTotal} child record(s)</strong> from
             <strong>${esc(orgLabel(profile.targetOrg))}</strong> — recoverable from the Recycle Bin for 15 days.</div>`) : '';
      const pullBlock = pullIds.length
        ? `<div style="margin-top:10px;padding:10px 12px;background:#eff6ff;border-left:3px solid #2563eb;border-radius:4px;font-size:12px;color:#1e3a8a">
             ← <strong>Pull ${pullIds.length} ${esc(objType)} record(s)</strong> into
             <strong>${esc(orgLabel(profile.sourceOrg))}</strong> (source). New rows will be inserted there.</div>`
        : '';
      const updSrcBlock = updSrcIds.length
        ? `<div style="margin-top:10px;padding:10px 12px;background:#eff6ff;border-left:3px solid #2563eb;border-radius:4px;font-size:12px;color:#1e3a8a">
             ← <strong>Update ${updSrcIds.length} ${esc(objType)} record(s)</strong> in
             <strong>${esc(orgLabel(profile.sourceOrg))}</strong> (source) with the target's values — the target wins those rows.</div>`
        : '';
      const title = (delIds.length || childDelTotal)
        ? (isHard ? '🔥 Confirm HARD delete' : '⚠ Confirm reconcile actions')
        : (anyChildAct && !pullIds.length && !updSrcIds.length)
          ? '⚖ Confirm the execution plan'
          : '← Confirm writes into source';
      const planBlock = planLines.length
        ? `<div class="ds-rec-plan">
             <div class="ds-rec-plan-hdr">Execution plan — steps run in this exact order:</div>
             ${planLines.map(l => `<div class="ds-rec-plan-line">${esc(l)}</div>`).join('')}
           </div>`
        : '';
      showModal(`
        <div class="ds-modal-header">${title}</div>
        <div class="ds-modal-body">
          Review the changes before continuing:
          ${planBlock}
          ${pullBlock}
          ${updSrcBlock}
          ${childDelBlock}
          ${delBlock}
        </div>
        <div class="ds-modal-footer">
          <button class="ds-btn" id="dsRecDelCancel">Cancel</button>
          <button class="ds-btn ${(delIds.length || childDelTotal) ? 'ds-btn-danger' : 'ds-btn-primary'}" id="dsRecDelOk">Proceed</button>
        </div>`);
      eid('dsRecDelCancel')?.addEventListener('click', () => { closeModal(); resolve(false); });
      eid('dsRecDelOk')?.addEventListener('click', () => { closeModal(); resolve(true); });
    });
    if (!ok) return;
  }

  // Deletes into a PRODUCTION org additionally require typing the org name.
  // Child deletes (R4) go through the SAME typed confirmation as root deletes.
  if ((delIds.length || childDelTotal) && tgtOrgType === 'production') {
    const what = [
      delIds.length ? `${delIds.length} ${objType}` : null,
      childDelTotal ? `${childDelTotal} child` : null
    ].filter(Boolean).join(' + ');
    const okProd = await confirmTypedProd(orgLabel(profile.targetOrg), `delete ${what} record(s)`);
    if (!okProd) return;
  }

  const prog = eid('dsRecProgress');
  const log = (icon, msg, cls = '') => {
    if (!prog) return;
    const row = document.createElement('div');
    row.className = `ds-prog-row ${cls}`;
    row.textContent = `${icon} ${msg}`;
    prog.appendChild(row);
  };
  if (prog) prog.innerHTML = '<div class="ds-prog-hdr">Reconcile progress</div>';
  const runBtn = eid('dsRecRunBtn'); if (runBtn) runBtn.disabled = true;

  const allSess = _buildAllSessions();
  const srcSess = _resolveSession(profile.sourceOrg, allSess);
  const tgtSess = _resolveSession(profile.targetOrg, allSess);
  if (!srcSess?.sid || !tgtSess?.sid) {
    log('❌', 'Source or target org session not active — open both in Chrome tabs.', 'ds-prog-err');
    if (runBtn) runBtn.disabled = false;
    return;
  }

  // Stream the engine's per-batch progress into the reconcile log (also
  // keeps the worker alive across the multi-phase pipeline).
  const recPort = _openRunPort(_runProgressHandler(prog));

  // Per-action counters — captured into a History entry at the end so the
  // History view can show what was actually inserted/updated/deleted, not
  // just "errors". Hard-delete tracks the bin-purge count separately.
  const startedAt = new Date().toISOString();
  const counts = { inserted: 0, updated: 0, deleted: 0, purged: 0, pulled: 0, updatedSource: 0,
                   insertedFailed: 0, updatedFailed: 0, deletedFailed: 0, pulledFailed: 0, updatedSourceFailed: 0 };
  // Per-child-object counters — merged into the History summary alongside
  // the root object's counts.
  const childCounts = {};
  const bumpChild = (obj, key, by) => {
    if (!childCounts[obj]) childCounts[obj] = { created: 0, failed: 0, connected: 0, connectFailed: 0, relinked: 0, relinkFailed: 0,
                                                overwritten: 0, overwriteFailed: 0, deleted: 0, deleteFailed: 0 };
    childCounts[obj][key] += by;
  };
  // Written-record refs ({id, label}) for History links, per object.
  const rootTargets = [];
  // Failure refs: failed INSERTS link to the SOURCE record (nothing exists in
  // target); failed UPDATES link to the TARGET record (PATCH refused).
  const rootFailedInserts = [];
  const rootFailedUpdates = [];
  const allErrors = [];

  // R5 — grandchild rows whose parent is missing in the target were skipped
  // at partition time (tree-ride isn't supported at that depth). Say so.
  for (const a of childActs) {
    if (!a.skippedDeep) continue;
    const m = `⚠ ${a.node.objectType || a.node.childSObject}: ${a.skippedDeep} selected row(s) skipped — their parent isn't in the target yet and tree-ride inserts aren't supported at this depth; insert the parent level first, rescan, then re-run`;
    allErrors.push(m); log('⚠', m, 'ds-prog-warn');
  }

  // ── 0. Child deletes (R4) — run BEFORE the root delete so children go
  // first (FK-safe), through the SAME delete modes and prod guards as the
  // root (typed prod confirm + hard-delete block already covered both above).
  for (const a of childActs) {
    if (!a.delIds.length) continue;
    const obj = a.node.objectType || a.node.childSObject;
    try {
      if (isHard) {
        log('🔥', `Hard-deleting ${a.delIds.length} ${obj} from target…`);
        const res = await sendBg({ type: 'SF_HARD_DELETE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, ids: a.delIds });
        const okN   = (res.deleteResults || []).filter(r => r.success).length;
        const failN = (res.deleteResults || []).length - okN;
        bumpChild(obj, 'deleted', okN); bumpChild(obj, 'deleteFailed', failN);
        counts.purged += (res.purgedOk || 0);
        log(failN ? '⚠' : '✅', `${obj}: deleted ${okN}${failN ? `, ${failN} failed` : ''} → purged ${res.purgedOk || 0} from Recycle Bin`, failN ? 'ds-prog-err' : '');
        (res.purgeErrors || []).slice(0, 3).forEach(e => { allErrors.push(`purge ${obj}: ${e}`); log('  ⚠', `purge: ${e}`, 'ds-prog-warn'); });
        (res.deleteResults || []).filter(r => !r.success).slice(0, 5).forEach(r => {
          const m = (r.errors || []).map(x => x.message).join('; ');
          if (m) allErrors.push(`delete ${obj} ${r.id || ''}: ${m}`);
        });
      } else {
        log('🗑', `Deleting ${a.delIds.length} ${obj} from target (→ Recycle Bin)…`);
        const res = await sendBg({ type: 'SF_COLLECTIONS_DELETE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, ids: a.delIds });
        const okN   = (res || []).filter(r => r.success).length;
        const failN = (res || []).length - okN;
        bumpChild(obj, 'deleted', okN); bumpChild(obj, 'deleteFailed', failN);
        log(failN ? '⚠' : '✅', `${obj}: deleted ${okN}${failN ? `, ${failN} failed` : ''}`, failN ? 'ds-prog-err' : '');
        (res || []).filter(r => !r.success).slice(0, 5).forEach(r => {
          const m = (r.errors || []).map(x => x.message).join('; ');
          if (m) allErrors.push(`delete ${obj} ${r.id || ''}: ${m}`);
        });
      }
    } catch (e) { allErrors.push(`Delete ${obj} failed: ${e?.message || e}`); log('❌', `Delete ${obj} failed: ${e?.message || e}`, 'ds-prog-err'); }
  }

  // ── 1. Delete extras (regular → Recycle Bin, or hard → purge) ────────
  if (delIds.length) {
    if (isHard) {
      log('🔥', `Hard-deleting ${delIds.length} record(s) from target…`);
      try {
        const res = await sendBg({ type: 'SF_HARD_DELETE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, ids: delIds });
        const delOk   = (res.deleteResults || []).filter(r => r.success).length;
        const delFail = (res.deleteResults || []).length - delOk;
        counts.deleted += delOk; counts.deletedFailed += delFail; counts.purged += (res.purgedOk || 0);
        log(delFail ? '⚠' : '✅', `Deleted ${delOk}${delFail ? `, ${delFail} failed` : ''} → purged ${res.purgedOk || 0} from Recycle Bin`, delFail ? 'ds-prog-err' : '');
        (res.purgeErrors || []).slice(0, 3).forEach(e => { allErrors.push(`purge: ${e}`); log('  ⚠', `purge: ${e}`, 'ds-prog-warn'); });
        (res.deleteResults || []).filter(r => !r.success).slice(0, 5).forEach(r => {
          const m = (r.errors || []).map(x => x.message).join('; ');
          if (m) allErrors.push(`delete ${r.id || ''}: ${m}`);
        });
      } catch (e) { allErrors.push(`Hard delete failed: ${e?.message || e}`); log('❌', `Hard delete failed: ${e?.message || e}`, 'ds-prog-err'); }
    } else {
      log('🗑', `Deleting ${delIds.length} record(s) from target (→ Recycle Bin)…`);
      try {
        const res = await sendBg({ type: 'SF_COLLECTIONS_DELETE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, ids: delIds });
        const ok = (res || []).filter(r => r.success).length;
        const fail = (res || []).length - ok;
        counts.deleted += ok; counts.deletedFailed += fail;
        log(fail ? '⚠' : '✅', `Deleted ${ok}${fail ? `, ${fail} failed` : ''}`, fail ? 'ds-prog-err' : '');
        (res || []).filter(r => !r.success).slice(0, 5).forEach(r => {
          const m = (r.errors || []).map(x => x.message).join('; ');
          if (m) allErrors.push(`delete ${r.id || ''}: ${m}`);
        });
      } catch (e) { allErrors.push(`Delete failed: ${e?.message || e}`); log('❌', `Delete failed: ${e?.message || e}`, 'ds-prog-err'); }
    }
  }

  // ── 2. Pull target-only rows into source (Phase 3B) ──────────────────
  // Same transfer engine, but src/tgt swapped. Field mappings are inverted
  // so { srcFld → tgtFld } applied during push becomes { tgtFld → srcFld }
  // during pull. Only the root object — children stay in their own org.
  if (pullIds.length) {
    log('←', `Pulling ${pullIds.length} record(s) from target into source…`);
    try {
      const pullProfile = JSON.parse(JSON.stringify(profile));
      const fm = pullProfile.tree?.fieldMappings || {};
      const inverseFm = {};
      // Keep null EXCLUSIONS when inverting — `if (t)` alone dropped them,
      // and an absent mapping means identity passthrough in the executor,
      // so deliberately-excluded fields were copied into the source on Pull.
      for (const [s, t] of Object.entries(fm)) {
        if (t === null) inverseFm[s] = null;
        else if (t) inverseFm[t] = s;
      }
      pullProfile.tree.fieldMappings = inverseFm;
      pullProfile.tree.recordIds = pullIds;
      pullProfile.tree.children  = [];
      // Swap the profile's orgs so anything downstream that inspects them
      // (logging, lookup-bridge resolution, error messages) sees the
      // reverse direction consistently.
      pullProfile.sourceOrg = profile.targetOrg;
      pullProfile.targetOrg = profile.sourceOrg;
      const res = await sendBg({
        type: 'SF_EXECUTE_PROFILE_TRANSFER',
        profile: pullProfile,
        srcOrgUrl: tgtSess.orgUrl, srcSid: tgtSess.sid,   // read from TARGET
        tgtOrgUrl: srcSess.orgUrl, tgtSid: srcSess.sid    // write to SOURCE
      });
      const s = res.summary?.[objType] || {};
      counts.pulled       += (s.created || 0);
      counts.pulledFailed += (s.failed  || 0);
      log(s.failed ? '⚠' : '✅', `Pulled ${s.created || 0}${s.failed ? `, ${s.failed} failed` : ''} into source`, s.failed ? 'ds-prog-err' : '');
      (res.errors || []).forEach(e => allErrors.push(`pull: ${e}`));
      (res.errors || []).slice(0, 5).forEach(e => log('  ❌', e, 'ds-prog-err'));
    } catch (e) { allErrors.push(`Pull failed: ${e?.message || e}`); log('❌', `Pull failed: ${e?.message || e}`, 'ds-prog-err'); }
  }

  // ── 3. Push missing (insert) — delegate to the transfer engine ────────
  // With child selections this is a real TREE run: the pruned profile keeps
  // the root plus each child node with group-A rows (parents being inserted
  // this run), per-node recordIds, and the run-scoped insert order. The
  // engine does the rest — child-first hoisting, scoping, and the reconnect
  // step — exactly like a normal deployment.
  const treePushIds = [...new Set([...pushIds, ...childActs.flatMap(a => [...a.autoParents])])];
  const groupATotal = childActs.reduce((s, a) => s + a.groupA.length, 0);
  if (treePushIds.length || groupATotal) {
    const autoN = treePushIds.length - pushIds.length;
    log('⬆', `Pushing ${treePushIds.length} ${objType}${autoN > 0 ? ` (${autoN} parent(s) auto-included)` : ''}${groupATotal ? ` + ${groupATotal} child record(s)` : ''} to target…`);
    try {
      const pushProfile = JSON.parse(JSON.stringify(profile));
      delete pushProfile.lastScan;
      pushProfile.tree.recordIds = treePushIds;
      pushProfile.tree.children  = (profile.tree.children || []).map((c, i) => {
        const a = childActs.find(x => x.pathKey === String(i));
        if (!a || !a.groupA.length) return null;      // no group-A rows → drop node
        const cc = JSON.parse(JSON.stringify(c));
        cc.recordIds = a.groupA;
        cc.children  = [];                            // tree-ride stays one level deep (grandchildren go via group B)
        const ord = _recOrderOverride[a.pathKey] ?? c.insertOrder;
        if (ord === 'childFirst') {
          // R2 — master-detail links require the parent at insert: child-first
          // is impossible, so force the default order and say why.
          if (a.cs?.linkMasterDetail) {
            allErrors.push(`⚠ ${cc.objectType || cc.childSObject}: child-first ignored — ${cc.field || 'the link'} is a master-detail relationship (parent required at insert); running parent-first instead`);
            delete cc.insertOrder;
          } else {
            cc.insertOrder = 'childFirst';
          }
        } else delete cc.insertOrder;
        return cc;
      }).filter(Boolean);
      const res = await sendBg({
        type: 'SF_EXECUTE_PROFILE_TRANSFER',
        profile: pushProfile,
        srcOrgUrl: srcSess.orgUrl, srcSid: srcSess.sid,
        tgtOrgUrl: tgtSess.orgUrl, tgtSid: tgtSess.sid
      });
      const s = res.summary?.[objType] || {};
      // M3c — remember the srcId→tgtId pairs this push just created (root
      // object). sftkLearnPairs no-ops for ephemeral profile ids; the guard
      // mirrors runTransfer's (reconcile always runs the profile's own pair,
      // but ephemeral ring clones override sourceOrg — belt and braces).
      try {
        if (s.idPairs?.length && !profile.ephemeral
            && _orgKey(srcSess.orgUrl) === _orgKey(profile.sourceOrg || '')) {
          await window.sftkLearnPairs?.(profile.id, tgtSess.orgUrl, s.idPairs);
        }
        delete s.idPairs;
      } catch (_) { /* memory is an optimization — never fail the run */ }
      counts.inserted += (s.created || 0); counts.insertedFailed += (s.failed || 0);
      rootTargets.push(...(s.targetRecords || []));
      rootFailedInserts.push(...(s.failedSourceIds || []));
      log(s.failed ? '⚠' : '✅', `Inserted ${s.created || 0} ${objType}${s.failed ? `, ${s.failed} failed` : ''}`, s.failed ? 'ds-prog-err' : '');
      for (const a of childActs) {
        if (!a.groupA.length) continue;
        const obj  = a.node.objectType || a.node.childSObject;
        if (obj === objType) continue;   // self-relationship: counts already in root line
        const cSum = res.summary?.[obj] || {};
        bumpChild(obj, 'created', cSum.created || 0);
        bumpChild(obj, 'failed',  cSum.failed  || 0);
        bumpChild(obj, 'connected', cSum.connected || 0);
        bumpChild(obj, 'connectFailed', cSum.connectFailed || 0);
        if (cSum.targetRecords?.length) {
          childCounts[obj].targetRecords = (childCounts[obj].targetRecords || []).concat(cSum.targetRecords);
        }
        if (cSum.failedSourceIds?.length) {
          childCounts[obj].failedSourceIds = (childCounts[obj].failedSourceIds || []).concat(cSum.failedSourceIds);
        }
        log('  ' + (cSum.failed ? '⚠' : '✅'),
          `${obj}: ${cSum.created || 0} created${cSum.connected ? `, ${cSum.connected} linked to parent` : ''}${cSum.connectOrphaned ? `, ${cSum.connectOrphaned} unlinked (parent failed)` : ''}${cSum.failed ? `, ${cSum.failed} failed` : ''}`,
          cSum.failed ? 'ds-prog-err' : '');
      }
      (res.errors || []).forEach(e => allErrors.push(`insert: ${e}`));
      (res.errors || []).slice(0, 5).forEach(e => log('  ❌', e, 'ds-prog-err'));
    } catch (e) { allErrors.push(`Push failed: ${e?.message || e}`); log('❌', `Push failed: ${e?.message || e}`, 'ds-prog-err'); }
  }

  // ── 3b. Group-B child inserts — parent already exists in target ───────
  // Child-rooted transfer with the link field seeded as a match bridge, so
  // each record attaches to its pre-existing parent at insert time.
  for (const a of childActs) {
    if (!a.groupB.length) continue;
    const obj = a.node.objectType || a.node.childSObject;
    // R5 — the match bridge points at the node's ACTUAL parent: the root for
    // direct children (v1, identical values), the parent CHILD node + its
    // scan's match field for grandchildren.
    const pObj   = a.parentObj || objType;
    // M3a — the bridge's match field comes from the parent SCAN's stored
    // matching config (scan.matching, first source component) so it can't
    // diverge from the keys the scan matched on. The transfer engine resolves
    // a 'match' bridge by ONE exact-value field, so composite/normalized
    // configs degrade to first-component exact matching — warn instead of
    // silently pretending full fidelity.
    const pScanM = (a.parentScan || rootScan).matching || null;
    const pMatch = pScanM?.fields?.[0] || (a.parentScan || rootScan).matchField || 'Name';
    if (pScanM && ((pScanM.fields || []).length > 1 || Object.values(pScanM.normalize || {}).some(Boolean))) {
      const mW = `⚠ ${obj}: parent matching uses ${(pScanM.fields || []).length > 1 ? 'a composite key' : 'normalization'} — the insert bridge attaches by ${pMatch} with exact values (engine limit), so parents that differ only ${(pScanM.fields || []).length > 1 ? 'in later key components' : 'by case/spacing'} may not attach`;
      allErrors.push(mW); log('⚠', mW, 'ds-prog-warn');
    }
    log('⬆', `Inserting ${a.groupB.length} ${obj} under existing ${pObj} (matched by ${pMatch})…`);
    try {
      const bProfile = JSON.parse(JSON.stringify(profile));
      delete bProfile.lastScan;
      bProfile.tree = {
        objectType: obj,
        where: '',
        recordIds: a.groupB,
        children: [],
        fieldMappings: a.node.fieldMappings || {},
        lookupResolutions: {
          ...(a.node.lookupResolutions || {}),
          [a.node.field]: { strategy: 'match', matchObject: pObj, matchField: pMatch }
        }
      };
      const res = await sendBg({
        type: 'SF_EXECUTE_PROFILE_TRANSFER',
        profile: bProfile,
        srcOrgUrl: srcSess.orgUrl, srcSid: srcSess.sid,
        tgtOrgUrl: tgtSess.orgUrl, tgtSid: tgtSess.sid
      });
      const s2 = res.summary?.[obj] || {};
      bumpChild(obj, 'created', s2.created || 0);
      bumpChild(obj, 'failed',  s2.failed  || 0);
      if (s2.targetRecords?.length) {
        childCounts[obj].targetRecords = (childCounts[obj].targetRecords || []).concat(s2.targetRecords);
      }
      if (s2.failedSourceIds?.length) {
        childCounts[obj].failedSourceIds = (childCounts[obj].failedSourceIds || []).concat(s2.failedSourceIds);
      }
      log(s2.failed ? '⚠' : '✅', `${obj}: ${s2.created || 0} created under existing parents${s2.failed ? `, ${s2.failed} failed` : ''}`, s2.failed ? 'ds-prog-err' : '');
      (res.errors || []).forEach(e => allErrors.push(`insert ${obj}: ${e}`));
      (res.errors || []).slice(0, 5).forEach(e => log('  ❌', e, 'ds-prog-err'));
    } catch (e) { allErrors.push(`Insert ${obj} failed: ${e?.message || e}`); log('❌', `Insert ${obj} failed: ${e?.message || e}`, 'ds-prog-err'); }
  }

  // ── 3c. Relink — re-point existing children at the right parent ───────
  // Fresh target-parent resolution by key (so parents inserted seconds ago
  // count), then chunked PATCHes of the child's link field. Rows whose
  // parent still isn't in the target are SKIPPED — never nulled.
  for (const a of childActs) {
    if (!a.sel.relink.size) continue;
    const obj       = a.node.objectType || a.node.childSObject;
    const linkField = a.node.field;
    // R2 — master-detail links that aren't reparentable can't be PATCHed:
    // Salesforce rejects the update. Skip defensively with a warning (the UI
    // disables these toggles, but stale in-session selections could linger).
    if (a.cs?.linkMasterDetail && a.cs?.linkUpdateable === false) {
      const m = `⚠ relink ${obj}: skipped — ${linkField} is a master-detail relationship that isn't reparentable (Salesforce blocks changing it after insert)`;
      allErrors.push(m); log('⚠', m, 'ds-prog-warn');
      continue;
    }
    const fmLink    = a.node.fieldMappings ? a.node.fieldMappings[linkField] : undefined;
    if (fmLink === null) {
      allErrors.push(`relink ${obj}: the link field ${linkField} is excluded by the field mapping — nothing to patch`);
      continue;
    }
    const tgtLinkField = fmLink || linkField;
    const rows = (a.cs.linkMismatch || []).filter(r => a.sel.relink.has(r.targetId));
    if (!rows.length) continue;
    // R5 — resolve parents against the node's ACTUAL parent object/scan: the
    // root for direct children (identical to v1), the parent child node for
    // grandchildren.
    const relParentObj  = a.parentObj || objType;
    const relParentScan = a.parentScan || rootScan;
    log('⇄', `Relinking ${rows.length} ${obj} in target…`);
    try {
      // M3a — parent resolution honors the parent scan's STORED matching
      // config (scan.matching), so relink resolves parents with EXACTLY the
      // keys the scan matched on. Composite/normalized configs: query
      // candidates by the FIRST target component IN (raw first-component
      // values), then client-filter by FULL sftkMatchKey equality — SOQL
      // text '=' is case-insensitive, JS is not, so normalization has to be
      // applied in the client-side comparison, never trusted to the query.
      // Legacy scans without .matching resolve through the same builder with
      // the single stored matchField (byte-identical to the old behavior
      // when no normalization is configured).
      const pm = relParentScan.matching || null;
      const pmSrcFields = (pm?.fields || []).length ? pm.fields : [relParentScan.matchField || 'Name'];
      const pmTgtFields = (pm?.tgtFields || []).length ? pm.tgtFields
        : [relParentScan.matchFieldTgt || relParentScan.matchField || 'Name'];
      const pmNorm   = pm?.normalize || {};
      const tgtMatch = pmTgtFields[0];

      // Full source-side parent key per child row. linkMismatch rows carry
      // only the FIRST component (parentKeySrc), so for composite configs
      // every component is re-read via the link's dot-path. Any failure
      // degrades to first-component matching with a warning.
      const srcKeyByChild = new Map();   // child sourceId → full parent key
      let fullKeys = false;
      try {
        const cd = await describe(obj, srcSess.orgUrl, srcSess.sid);
        const lf = (cd?.fields || []).find(f => f.name === linkField);
        if (lf?.relationshipName) {
          const rel  = lf.relationshipName;
          const cIds = rows.map(r => r.sourceId).filter(Boolean);
          for (let ci = 0; ci < cIds.length; ci += 200) {
            const idLit = cIds.slice(ci, ci + 200).map(id => soqlStrLit(id)).join(',');
            const q0 = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: srcSess.orgUrl, sid: srcSess.sid, tooling: false,
              query: `SELECT Id, ${pmSrcFields.map(f => `${rel}.${f}`).join(', ')} FROM ${obj} WHERE Id IN (${idLit})` });
            if (q0?.error) throw new Error(q0.error);
            for (const rec of (q0.records || [])) {
              srcKeyByChild.set(rec.Id, rec[rel]
                ? sftkMatchKey(rec[rel], { fields: pmSrcFields, normalize: pmNorm }) : '');
            }
          }
          fullKeys = true;
        }
      } catch (e0) {
        window.SFToolkitDebug?.log('scan', 'warn',
          `relink ${obj}: couldn't rebuild full parent keys from the source — falling back to first-component matching`,
          e0?.message || String(e0));
      }
      if (!fullKeys && pmSrcFields.length > 1) {
        const mW = `⚠ relink ${obj}: parent matching is a composite key but only its first component (${pmSrcFields[0]}) could be read — matching by that component alone`;
        allErrors.push(mW); log('⚠', mW, 'ds-prog-warn');
      }

      // Candidate fetch by FIRST component; candidates indexed by the SAME
      // key form the source side uses (full when available, else component 1).
      const keys = [...new Set(rows.map(r => r.parentKeySrc).filter(Boolean))];
      const parentByKey = new Map();     // normalized key → target parent Id
      for (let ci = 0; ci < keys.length; ci += 100) {
        const lit = keys.slice(ci, ci + 100).map(v => soqlStrLit(v)).join(',');
        const q = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, tooling: false,
          query: `SELECT Id, ${pmTgtFields.join(', ')} FROM ${relParentObj} WHERE ${tgtMatch} IN (${lit})` });
        if (q?.error) throw new Error(q.error);
        for (const rec of (q.records || [])) {
          const kk = fullKeys
            ? sftkMatchKey(rec, { fields: pmTgtFields, normalize: pmNorm })
            : sftkMatchKey(rec, { fields: [tgtMatch], normalize: pmNorm });
          if (kk && !parentByKey.has(kk)) parentByKey.set(kk, rec.Id);
        }
      }
      const updates = [];
      let skippedNoParent = 0;
      for (const r of rows) {
        const wantKey = fullKeys
          ? (srcKeyByChild.get(r.sourceId) || '')
          : (r.parentKeySrc ? sftkNormalizeValue(r.parentKeySrc, pmNorm) : '');
        const pid = wantKey ? parentByKey.get(wantKey) : null;
        if (!pid) { skippedNoParent++; continue; }
        updates.push({ attributes: { type: obj }, Id: r.targetId, [tgtLinkField]: pid });
      }
      let ok = 0, fail = 0;
      for (let ci = 0; ci < updates.length; ci += 200) {
        try {
          const res = await sendBg({ type: 'SF_COLLECTIONS_UPDATE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
            records: updates.slice(ci, ci + 200) });
          (Array.isArray(res) ? res : []).forEach(rr => {
            if (rr.success) ok++;
            else { fail++; allErrors.push(`relink ${obj}: ${(rr.errors || []).map(x => x.message).join('; ')}`); }
          });
        } catch (e2) {
          fail += Math.min(200, updates.length - ci);
          allErrors.push(`relink ${obj}: ${e2?.message || e2}`);
        }
      }
      bumpChild(obj, 'relinked', ok);
      bumpChild(obj, 'relinkFailed', fail);
      if (skippedNoParent) allErrors.push(`relink ${obj}: ${skippedNoParent} skipped — their parent isn't in the target yet (insert it first)`);
      log(fail ? '⚠' : '✅', `Relinked ${ok} ${obj}${fail ? `, ${fail} failed` : ''}${skippedNoParent ? `, ${skippedNoParent} skipped (no parent in target)` : ''}`, fail ? 'ds-prog-err' : '');
    } catch (e) { allErrors.push(`Relink ${obj} failed: ${e?.message || e}`); log('❌', `Relink ${obj} failed: ${e?.message || e}`, 'ds-prog-err'); }
  }

  // ── 3d. Child overwrites (R4) — update drifted child records in target,
  // scoped to the CHILD node's fieldMappings. Reuses reconcileOverwrite with
  // a child-rooted profile clone (it reads profile.tree as its node), driven
  // by the child scan's drift bucket. Failures degrade to a warning; the
  // rest of the run continues.
  for (const a of childActs) {
    if (!a.ovwIds.length) continue;
    const obj = a.node.objectType || a.node.childSObject;
    log('✏', `Updating ${a.ovwIds.length} drifted ${obj} in target…`);
    try {
      const cProfile = JSON.parse(JSON.stringify(profile));
      delete cProfile.lastScan;
      cProfile.tree = {
        objectType: obj,
        where: '',
        children: [],
        fieldMappings: a.node.fieldMappings || {},
        lookupResolutions: a.node.lookupResolutions || {}
      };
      const result = await reconcileOverwrite(cProfile, obj, a.ovwIds, a.cs.changed || [], srcSess, tgtSess);
      bumpChild(obj, 'overwritten',     result.ok     || 0);
      bumpChild(obj, 'overwriteFailed', result.failed || 0);
      log(result.failed ? '⚠' : '✅', `${obj}: updated ${result.ok || 0}${result.failed ? `, ${result.failed} failed` : ''}`, result.failed ? 'ds-prog-err' : '');
      (result.errors || []).forEach(e2 => allErrors.push(`update ${obj}: ${e2}`));
      (result.errors || []).slice(0, 5).forEach(e2 => log('  ❌', e2, 'ds-prog-err'));
    } catch (e) { allErrors.push(`⚠ Update ${obj} failed: ${e?.message || e}`); log('❌', `Update ${obj} failed: ${e?.message || e}`, 'ds-prog-err'); }
  }

  // ── 4. Overwrite drift (update target with source values) ────────────
  if (ovwIds.length) {
    log('✏', `Updating ${ovwIds.length} drifted record(s) in target…`);
    try {
      const result = await reconcileOverwrite(profile, objType, ovwIds, buckets.drift, srcSess, tgtSess);
      counts.updated += (result.ok || 0); counts.updatedFailed += (result.failed || 0);
      rootTargets.push(...(result.updatedRecords || []));
      rootFailedUpdates.push(...(result.failedRecords || []));
      log(result.failed ? '⚠' : '✅', `Updated ${result.ok}${result.failed ? `, ${result.failed} failed` : ''}`, result.failed ? 'ds-prog-err' : '');
      (result.errors || []).forEach(e => allErrors.push(`update: ${e}`));
      (result.errors || []).slice(0, 5).forEach(e => log('  ❌', e, 'ds-prog-err'));
    } catch (e) { allErrors.push(`Overwrite failed: ${e?.message || e}`); log('❌', `Overwrite failed: ${e?.message || e}`, 'ds-prog-err'); }
  }

  // ── 4b. Reverse drift (update SOURCE with target values, 3B v2) ───────
  // Same engine as step 4 with everything mirrored: profile clone gets
  // inverted fieldMappings + swapped orgs, the drift bucket swaps
  // sourceId/targetId per row, and the sessions swap roles — so
  // reconcileOverwrite "reads from source, patches target" becomes
  // "reads from target, patches source" without touching its internals.
  if (updSrcIds.length) {
    log('←', `Updating ${updSrcIds.length} drifted record(s) in source with target values…`);
    try {
      const invProfile = JSON.parse(JSON.stringify(profile));
      const fm = invProfile.tree?.fieldMappings || {};
      const invFm = {};
      for (const [s, t] of Object.entries(fm)) {
        if (t === null) invFm[s] = null;       // keep exclusions on inversion
        else if (t) invFm[t] = s;
      }
      invProfile.tree.fieldMappings = invFm;
      invProfile.sourceOrg = profile.targetOrg;
      invProfile.targetOrg = profile.sourceOrg;
      const sel = new Set(updSrcIds);
      const swappedBucket = (buckets.drift || [])
        .filter(r => sel.has(r.sourceId))
        .map(r => ({ matchKey: r.matchKey, sourceId: r.targetId, targetId: r.sourceId }));
      const readIds = swappedBucket.map(r => r.sourceId);   // = original targetIds
      const result = await reconcileOverwrite(invProfile, objType, readIds, swappedBucket, tgtSess, srcSess);
      counts.updatedSource += (result.ok || 0); counts.updatedSourceFailed += (result.failed || 0);
      log(result.failed ? '⚠' : '✅', `Updated ${result.ok} in source${result.failed ? `, ${result.failed} failed` : ''}`, result.failed ? 'ds-prog-err' : '');
      (result.errors || []).forEach(e => allErrors.push(`update-source: ${e}`));
      (result.errors || []).slice(0, 5).forEach(e => log('  ❌', e, 'ds-prog-err'));
    } catch (e) { allErrors.push(`Source update failed: ${e?.message || e}`); log('❌', `Source update failed: ${e?.message || e}`, 'ds-prog-err'); }
  }

  // ── 5. Save to History so the run is visible later ───────────────────
  const childOk   = Object.values(childCounts).reduce((s, c) => s + c.created + c.relinked + (c.overwritten || 0) + (c.deleted || 0), 0);
  const childFail = Object.values(childCounts).reduce((s, c) => s + c.failed + c.connectFailed + c.relinkFailed + (c.overwriteFailed || 0) + (c.deleteFailed || 0), 0);
  const totalOk   = counts.inserted + counts.updated + counts.deleted + counts.pulled + counts.updatedSource + childOk;
  const totalFail = counts.insertedFailed + counts.updatedFailed + counts.deletedFailed + counts.pulledFailed + counts.updatedSourceFailed + childFail;
  const status   = totalFail === 0 ? 'success' : (totalOk > 0 ? 'partial' : 'failed');
  _history.push({
    id:           genId('run'),
    kind:         'reconcile',
    profileId:    profile.id,
    profileName:  profile.name,
    sourceOrg:    profile.sourceOrg,
    targetOrg:    profile.targetOrg,
    srcOrgUrl:    profile.sourceOrg,
    tgtOrgUrl:    profile.targetOrg,
    startedAt,
    completedAt:  new Date().toISOString(),
    status,
    summary: {
      [objType]: {
        inserted: counts.inserted, insertedFailed: counts.insertedFailed,
        updated:  counts.updated,  updatedFailed:  counts.updatedFailed,
        deleted:  counts.deleted,  deletedFailed:  counts.deletedFailed,
        pulled:   counts.pulled,   pulledFailed:   counts.pulledFailed,
        updatedSource: counts.updatedSource, updatedSourceFailed: counts.updatedSourceFailed,
        purged:   counts.purged,
        deleteMode: _recDeleteMode,
        ...(rootTargets.length ? { targetRecords: rootTargets.slice(0, 200) } : {}),
        ...(rootFailedInserts.length ? { failedSourceIds: rootFailedInserts.slice(0, 200) } : {}),
        ...(rootFailedUpdates.length ? { failedRecords: rootFailedUpdates.slice(0, 200) } : {})
      },
      // Child objects — inserted/linked/relinked counts per relationship.
      ...Object.fromEntries(Object.entries(childCounts)
        .filter(([obj]) => obj !== objType)
        .map(([obj, c]) => [obj, {
          inserted: c.created, insertedFailed: c.failed,
          connected: c.connected, connectFailed: c.connectFailed,
          relinked: c.relinked, relinkFailed: c.relinkFailed,
          // R4 — child drift overwrites + target-only deletes.
          overwritten: c.overwritten || 0, overwrittenFailed: c.overwriteFailed || 0,
          deleted: c.deleted || 0, deletedFailed: c.deleteFailed || 0,
          ...(c.targetRecords?.length ? { targetRecords: c.targetRecords.slice(0, 200) } : {}),
          ...(c.failedSourceIds?.length ? { failedSourceIds: c.failedSourceIds.slice(0, 200) } : {})
        }]))
    },
    errors: allErrors.slice(0, 50)
  });
  await storageSaveHistory();

  log('✅', `Reconcile complete — refreshing state…`);
  // Remember which child sections had scans BEFORE the root refresh wipes
  // lastScan.children — they get re-scanned right after so the accordion
  // reflects the new reality (and just-created orphans are visible).
  // Parents before grandchildren — a grandchild rescan requires its parent
  // child scan to exist and be stamped with the NEW root runAt (R5).
  const scannedChildKeys = Object.keys(profile.lastScan?.children || {})
    .sort((x, y) => x.split('.').length - y.split('.').length);
  // Refresh diff + snapshots so the columns reflect the new reality.
  await window.refreshProfileState(profile.id);
  // Keep the ephemeral Org Compare profile (not in _profiles) — refreshProfileDiff
  // already updated its lastScan in place. Only re-point at a saved profile.
  { const _fp = _profiles.find(x => x.id === profile.id); if (_fp) _reconcileProfile = _fp; }
  for (const k of scannedChildKeys) {
    log('🔎', `Re-scanning child section ${k}…`);
    const res2 = await scanReconcileChild(_reconcileProfile, k);
    if (res2?.error) log('⚠', `Child rescan: ${res2.error}`, 'ds-prog-warn');
  }
  _recSel = { push: new Set(), overwrite: new Set(), updSrc: new Set(), del: new Set(), pull: new Set() };
  _recChildSel = {};
  const toastParts = [];
  if (counts.inserted)      toastParts.push(`${counts.inserted} inserted`);
  if (childOk) {
    const cIns = Object.values(childCounts).reduce((s, c) => s + c.created, 0);
    const cRel = Object.values(childCounts).reduce((s, c) => s + c.relinked, 0);
    const cOvw = Object.values(childCounts).reduce((s, c) => s + (c.overwritten || 0), 0);
    const cDel = Object.values(childCounts).reduce((s, c) => s + (c.deleted || 0), 0);
    if (cIns) toastParts.push(`${cIns} child record(s) inserted`);
    if (cRel) toastParts.push(`⇄ ${cRel} relinked`);
    if (cOvw) toastParts.push(`${cOvw} child record(s) updated`);
    if (cDel) toastParts.push(`${cDel} child record(s) deleted`);
  }
  if (counts.updated)       toastParts.push(`${counts.updated} updated`);
  if (counts.updatedSource) toastParts.push(`← ${counts.updatedSource} updated in source`);
  if (counts.pulled)        toastParts.push(`${counts.pulled} pulled`);
  if (counts.deleted)       toastParts.push(`${counts.deleted} deleted`);
  const toastMsg = `Reconcile: ${toastParts.join(' · ') || 'no actions'}` +
    (totalFail ? ` · ${totalFail} failed` : '');
  showToast(toastMsg, totalFail ? 'warning' : 'success', 4500);
  try { recPort?.disconnect(); } catch (_) {}
  renderReconcile();
}

// Overwrite drifted target records with source values. Fetches the source
// records' mapped fields, builds PATCH payloads keyed by the TARGET Id, and
// sends via SF_COLLECTIONS_UPDATE. Honors fieldMappings (src→tgt rename) and
// skips system/non-writable fields. Returns { ok, failed, errors }.
async function reconcileOverwrite(profile, objType, sourceIds, driftBucket, srcSess, tgtSess) {
  // Map sourceId → targetId from the drift bucket.
  const srcToTgt = new Map();
  for (const r of driftBucket) { if (r.sourceId && r.targetId) srcToTgt.set(r.sourceId, r.targetId); }

  const node = profile.tree;
  const fm   = node.fieldMappings || {};
  // Source fields to read = the mapped source field names (those that map to
  // a non-null target). Drop system fields.
  // OwnerId excluded from the mapping-driven fields — owners are handled by
  // the profile's ownerMapping setting below, not by field mapping.
  const SYS = new Set(['Id','CreatedDate','CreatedById','LastModifiedDate','LastModifiedById','SystemModstamp','IsDeleted','OwnerId']);
  let srcFields = Object.keys(fm).filter(k => fm[k] !== null && fm[k] !== '' && !SYS.has(k));

  // Owner mapping ('match'): resolve source Owner.Name → target user;
  // unmatched → the profile's fallback user; updates without a fallback
  // leave the target's current owner untouched.
  const ownerMode     = profile?.ownerMapping?.mode === 'match';
  const ownerFallback = ownerMode ? (profile.ownerMapping.fallbackUserId || null) : null;
  let   wantOwners    = false;

  // Validate the mapping against the SOURCE describe. Filters + resolution:
  //  - STALE fields: fieldMappings keys persist in the profile, so a field
  //    later deleted from the org 400s the whole source read
  //    ("No such column 'X' on entity 'Y'") and kills the entire overwrite
  //    phase. Drop them and say so, instead of failing everything.
  //  - LOOKUP fields (type 'reference'): raw ids are org-local, so they are
  //    RESOLVED, not copied — the source parent's key (Name / configured
  //    match field) is read via dot-path and matched against the target's
  //    parents, exactly like the child-section Relink. The old behavior of
  //    skipping lookups entirely left records permanently "drifted": the
  //    scan compares lookups by related-record name, so an overwrite that
  //    never touched them could never bring records in sync. Polymorphic /
  //    relationship-less lookups are still skipped; RecordTypeId keeps its
  //    own DeveloperName remap below.
  const warnings = [];
  let refPairs = [];   // [{sf, tf, relName, matchField, parentObj, unresolved}]
  let srcNameFld = null;   // the object's name field — fetched for link labels only
  try {
    const [d, dt] = await Promise.all([
      sendBg({ type: 'SF_REST_GET', orgUrl: srcSess.orgUrl, sid: srcSess.sid,
        path: `services/data/v62.0/sobjects/${objType}/describe` }),
      sendBg({ type: 'SF_REST_GET', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
        path: `services/data/v62.0/sobjects/${objType}/describe` })
    ]);
    if (d && !d.error && Array.isArray(d.fields) && d.fields.length) {
      const srcNames = new Set(d.fields.map(f => f.name));
      wantOwners = ownerMode && srcNames.has('OwnerId');
      srcNameFld = d.fields.find(f => f.nameField)?.name || null;
      const stale    = srcFields.filter(k => !srcNames.has(k));
      if (stale.length) {
        warnings.push(`⚠ skipped ${stale.length} mapped field(s) that no longer exist on ${objType} in the source org: ${stale.join(', ')} — open ✏ Edit → Fields & mapping to clean them up`);
      }
      // Mapped lookups → resolve-by-key pairs (mirrors buildLookupCompareMap).
      const lkpCfg = (node.lookupResolutions || {});
      for (const f of d.fields) {
        if (f.type !== 'reference' || f.name === 'RecordTypeId') continue;
        if (!srcFields.includes(f.name)) continue;
        const cfg  = lkpCfg[f.name];
        const poly = f.polymorphicForeignKey || (f.referenceTo || []).length > 1;
        if (!f.relationshipName || (poly && !cfg?.matchObject)) continue;
        refPairs.push({
          sf: f.name,
          tf: fm[f.name] || f.name,
          relName:    f.relationshipName,
          matchField: cfg?.matchField || 'Name',
          parentObj:  cfg?.matchObject || (f.referenceTo || [])[0],
          unresolved: 0
        });
      }
      const refs = new Set(d.fields.filter(f => f.type === 'reference' && f.name !== 'RecordTypeId').map(f => f.name));
      srcFields = srcFields.filter(k => srcNames.has(k) && !refs.has(k));
    }
    // TARGET-side validation — the PATCH writes the MAPPED names into the
    // target org; a mapped name that's missing there (e.g. test__c, or
    // MailingCountryCode when State/Country picklists are only enabled in
    // the source) or read-only fails EVERY row with "No such column".
    if (dt && !dt.error && Array.isArray(dt.fields) && dt.fields.length) {
      const tgtUpd = new Map(dt.fields.map(f => [f.name, f.updateable !== false]));
      const badTgt = [];
      srcFields = srcFields.filter(sf => {
        const tf = (sf === 'RecordTypeId') ? 'RecordTypeId' : (fm[sf] || sf);
        if (!tgtUpd.has(tf)) { badTgt.push(`${sf} → ${tf} (missing in target)`);   return false; }
        if (!tgtUpd.get(tf)) { badTgt.push(`${sf} → ${tf} (read-only in target)`); return false; }
        return true;
      });
      refPairs = refPairs.filter(rp => {
        if (!tgtUpd.has(rp.tf)) { badTgt.push(`${rp.sf} → ${rp.tf} (missing in target)`);   return false; }
        if (!tgtUpd.get(rp.tf)) { badTgt.push(`${rp.sf} → ${rp.tf} (read-only in target)`); return false; }
        return true;
      });
      if (badTgt.length) {
        warnings.push(`⚠ skipped ${badTgt.length} mapped field(s) the target org can't accept: ${badTgt.join(', ')} — open ✏ Edit → Fields & mapping to fix`);
      }
      if (wantOwners && tgtUpd.size && !tgtUpd.get('OwnerId')) {
        warnings.push('⚠ owners: OwnerId is not updateable in the target — owner matching skipped');
        wantOwners = false;
      }
    }
  } catch (_) { /* best effort — proceed with the unfiltered list */ }

  if (!srcFields.length && !refPairs.length && !wantOwners) {
    return { ok: 0, failed: sourceIds.length, errors: [...warnings, 'No mapped fields to overwrite — configure Field Mapping on the root node.'] };
  }

  // Fetch source records in chunks — plain fields plus each lookup's parent
  // KEY via dot-path (Account.Name style) for target-side resolution.
  const idList = sourceIds.filter(id => srcToTgt.has(id));
  const selFields = [...new Set([
    'Id', ...srcFields,
    ...refPairs.map(rp => `${rp.relName}.${rp.matchField}`),
    ...(wantOwners ? ['Owner.Name'] : []),
    ...(srcNameFld ? [srcNameFld] : [])   // labels for History links only
  ])];
  const srcRecs = [];
  for (let i = 0; i < idList.length; i += 200) {
    const chunk = idList.slice(i, i + 200);
    const soql = `SELECT ${selFields.join(',')} FROM ${objType} WHERE Id IN (${chunk.map(id => `'${id}'`).join(',')})`;
    const res  = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: srcSess.orgUrl, sid: srcSess.sid, query: soql });
    if (res?.error) return { ok: 0, failed: idList.length, errors: [...warnings, `Source read failed: ${res.error}`] };
    srcRecs.push(...(res.records || []));
  }

  // Resolve each lookup's target parents by key (fresh query, so parents
  // inserted earlier in this same reconcile run count). First match wins.
  // M3a NOTE (deliberate skip): refPairs matching keeps its OWN per-lookup
  // matchField concept (node.lookupResolutions[field].matchField, default
  // 'Name') and is NOT wired to node.matching — these are per-LOOKUP parent
  // resolutions, a different axis from the node's own record identity, and
  // rewiring them here would not be a small contained change. Revisit in M3c.
  for (const rp of refPairs) {
    rp.byKey = new Map();
    const keys = [...new Set(srcRecs
      .map(r => r[rp.relName] ? r[rp.relName][rp.matchField] : null)
      .filter(v => v != null && v !== ''))];
    for (let i = 0; i < keys.length; i += 100) {
      const lit = keys.slice(i, i + 100)
        .map(v => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(',');
      const q = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
        query: `SELECT Id, ${rp.matchField} FROM ${rp.parentObj} WHERE ${rp.matchField} IN (${lit})` });
      if (q?.error) {
        warnings.push(`⚠ ${rp.sf}: couldn't look up ${rp.parentObj} by ${rp.matchField} in the target (${q.error}) — this lookup left unchanged`);
        rp.failed = true;
        break;
      }
      for (const rec of (q.records || [])) {
        const k = String(rec[rp.matchField] ?? '');
        if (k && !rp.byKey.has(k)) rp.byKey.set(k, rec.Id);
      }
    }
  }

  // Resolve source owner names against the target's active users.
  const ownerByName = new Map();
  let ownerFellBack = 0, ownerKept = 0;
  if (wantOwners) {
    const names = [...new Set(srcRecs.map(r => r.Owner ? r.Owner.Name : null).filter(Boolean))];
    for (let i = 0; i < names.length; i += 100) {
      const lit = names.slice(i, i + 100)
        .map(n => `'${String(n).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(',');
      const q = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
        query: `SELECT Id, Name FROM User WHERE IsActive = true AND Name IN (${lit})` });
      if (q?.error) {
        warnings.push(`⚠ owners: couldn't load target users (${q.error}) — owner matching skipped`);
        wantOwners = false;
        break;
      }
      for (const u of (q.records || [])) if (!ownerByName.has(u.Name)) ownerByName.set(u.Name, u.Id);
    }
  }

  // Match RecordTypes by DeveloperName when RecordTypeId is being written.
  // The raw source RecordTypeId is invalid in the target org, so we resolve
  // srcRtId → tgtRtId by API name; unmatched RTs are skipped (the target
  // record keeps its existing RT) rather than pushing a garbage Id.
  const ovwErrors = [];
  let rtRemap = null;   // { srcRtId: tgtRtId|null }
  if (srcFields.includes('RecordTypeId')) {
    const srcRtIds = [...new Set(srcRecs.map(r => r.RecordTypeId).filter(Boolean))];
    if (srcRtIds.length) {
      const [srcRtRes, tgtRtRes] = await Promise.all([
        sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: srcSess.orgUrl, sid: srcSess.sid,
                 query: `SELECT Id, DeveloperName FROM RecordType WHERE Id IN (${srcRtIds.map(id => `'${id}'`).join(',')})` }),
        sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
                 query: `SELECT Id, DeveloperName FROM RecordType WHERE SObjectType = '${objType}'` })
      ]);
      const tgtByName = {};
      for (const r of (tgtRtRes.records || [])) tgtByName[r.DeveloperName] = r.Id;
      rtRemap = {};
      const unmatched = [];
      for (const r of (srcRtRes.records || [])) {
        rtRemap[r.Id] = tgtByName[r.DeveloperName] || null;
        if (!rtRemap[r.Id]) unmatched.push(r.DeveloperName);
      }
      if (unmatched.length) ovwErrors.push(`record type(s) ${unmatched.join(', ')} not in target — left unchanged on those records`);
    }
  }

  // Build PATCH payloads keyed by target Id. rowMeta stays aligned with
  // payloads so per-record results can be turned into History record links.
  const payloads = [];
  const rowMeta  = [];   // [{ id, label }]
  for (const sr of srcRecs) {
    const tgtId = srcToTgt.get(sr.Id);
    if (!tgtId) continue;
    const p = { attributes: { type: objType }, Id: tgtId };
    for (const sf of srcFields) {
      const tf = fm[sf];
      let v    = sr[sf];
      if (v == null) continue;
      // Remap RecordTypeId by DeveloperName; drop it if there's no target
      // match so we don't PATCH an invalid Id (which would fail the row).
      if (sf === 'RecordTypeId' && rtRemap) {
        const mapped = rtRemap[v];
        if (!mapped) continue;
        v = mapped;
      }
      p[tf] = v;
    }
    // Lookups: write the resolved TARGET parent id. Unresolvable parents
    // are left unchanged (never nulled) and counted for the summary.
    for (const rp of refPairs) {
      if (rp.failed) continue;
      const key = sr[rp.relName] ? sr[rp.relName][rp.matchField] : null;
      if (key == null || key === '') continue;      // no parent in source — leave as-is
      const pid = rp.byKey.get(String(key));
      if (!pid) { rp.unresolved++; continue; }
      p[rp.tf] = pid;
    }
    // Owners: matched name → that user; unmatched → fallback; no fallback →
    // the target's current owner stays untouched.
    if (wantOwners) {
      const oname = sr.Owner ? sr.Owner.Name : null;
      if (oname) {
        const matched = ownerByName.get(oname);
        if (matched)           p.OwnerId = matched;
        else if (ownerFallback) { p.OwnerId = ownerFallback; ownerFellBack++; }
        else                    ownerKept++;
      }
    }
    payloads.push(p);
    rowMeta.push({ id: tgtId, label: (srcNameFld && sr[srcNameFld]) || sr.Name || tgtId });
  }

  if (ownerFellBack) warnings.push(`⚠ owners: ${ownerFellBack} record(s) reassigned to the fallback user (owner had no name match in the target)`);
  if (ownerKept)     warnings.push(`⚠ owners: ${ownerKept} record(s) kept their current target owner (no name match and no fallback user set)`);

  for (const rp of refPairs) {
    if (rp.unresolved) {
      warnings.push(`⚠ ${rp.sf}: ${rp.unresolved} record(s) point at a ${rp.parentObj} with no match in the target (by ${rp.matchField}) — left unchanged; insert the parent first or pick a better match field`);
    }
  }

  const res = await sendBg({ type: 'SF_COLLECTIONS_UPDATE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, records: payloads });
  const arr = Array.isArray(res) ? res : [];
  const ok = arr.filter(r => r.success).length;
  const errors = [...warnings, ...ovwErrors];
  // Per-record outcomes with labels — History renders both as links:
  // updated → the target record; failed update → also the target record
  // (it exists — the PATCH was refused), with the error on hover.
  const updatedRecords = [];
  const failedRecords  = [];
  arr.forEach((r, i) => {
    if (!rowMeta[i]) return;
    if (r.success) { if (updatedRecords.length < 200) updatedRecords.push(rowMeta[i]); }
    else if (failedRecords.length < 200) {
      failedRecords.push({ ...rowMeta[i], error: (r.errors || []).map(e => e.message).join('; ') });
    }
  });
  // Dedupe identical per-record failures — 20 rows all failing with the same
  // "No such column 'X'" should read as ONE line with a count, not a wall.
  const failCounts = new Map();
  for (const r of arr) {
    if (r.success) continue;
    const m = `${objType}: ${(r.errors || []).map(e => e.message).join('; ')}`;
    failCounts.set(m, (failCounts.get(m) || 0) + 1);
  }
  for (const [m, c] of failCounts) errors.push(c > 1 ? `${m}  (×${c})` : m);
  return { ok, failed: arr.length - ok, errors, updatedRecords, failedRecords };
}

