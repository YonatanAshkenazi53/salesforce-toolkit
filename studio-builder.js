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
        // New profiles start from whatever the topbar SOURCE chip is showing
        // — same resolution, one helper — so a new deployment never opens
        // blank while the topbar plainly names a source. The target list
        // excludes it automatically (an org is never its own target).
        sourceOrg: (typeof currentSourceOrg === 'function' ? currentSourceOrg() : (_workingPair.src || '')),
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

// How many objects this profile actually deploys — the header's record count.
// Counts the SAME nodes renderTreeNode paints (root + every descendant), so
// the number in the header can never disagree with the tree under it.
function bldTreeNodeCount(node) {
  if (!node) return 0;
  return 1 + (node.children || []).reduce((n, c) => n + bldTreeNodeCount(c), 0);
}

function renderBuilder() {
  const p = _editingProfile;
  setMain(`
    ${dsViewHeader({
      icon: 'box',
      title: 'Profile Builder',
      // The builder's content column is capped at 900px, so a full-bleed
      // page header sat ~90px wider than every field under it.
      cls: 'ds-vh-narrow',
      // Truthful, and computed from the tree that is actually on screen:
      // countTreeNodes walks the same node graph the editor renders.
      subtitle: p.tree ? `${esc(p.tree.objectType || 'Untitled')} deployment` : 'New deployment',
      count: p.tree ? `${bldTreeNodeCount(p.tree)} object${bldTreeNodeCount(p.tree) !== 1 ? 's' : ''} in the tree` : '',
      // ONE primary in the region (Save &amp; Run). Save/Cancel are neutral,
      // and nothing here is destructive, so nothing here is red.
      actions: `${p.tree ? `<button class="ds-btn" id="dsPreviewAllBtn" title="Count records for every node in parallel">${dsIcon('eye')}Preview All</button>
        <button class="ds-btn" id="dsBldCheckTargets" title="Describe every ring target and verify the tree's objects + every mapped field exist there — the multi-org answer to 'which org will this break in?'">${dsIcon('flask')}Check all targets</button>
        <button class="ds-btn" id="dsBldSuggestPii" title="Scan every object in this tree for likely PII (field types, names/labels, org compliance classification) and add write-time mask rules — masked/pseudonymized, never written raw">${dsIcon('lock')}Suggest PII masks</button>` : ''}
        <button class="ds-btn" id="dsBuilderCancel">Cancel</button>
        <button class="ds-btn" id="dsBuilderSave">${dsIcon('save')}Save</button>
        ${p.tree ? `<button class="ds-btn ds-btn-primary" id="dsBuilderSaveRun"
          title="Save the profile and immediately jump to the Run screen">${dsIcon('play')}Save &amp; Run</button>` : ''}`,
    })}

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
        const srcLocked = !!ringSrc && !window._bldSrcOverride && !p.sourcePinned &&
          (!p.sourceOrg || _orgKey(p.sourceOrg) === _orgKey(ringSrc));
        if (srcLocked) p.sourceOrg = ringSrc;
        // TARGETS: follow the ring unless pinned (user decision 2026-07-20).
        // targetOrgs === null → follow-mode: the set is profileTargets(p),
        // resolved LIVE, so ring changes flow into this deployment forever.
        // An array → the user pinned specific orgs. p.targetOrg stays the
        // FIRST effective target — the invisible schema reference every
        // engine path (mapping describes, previews, scans) keeps using.
        const followMode = !!ringSrc && !Array.isArray(p.targetOrgs);
        if (!ringSrc && !Array.isArray(p.targetOrgs)) {
          p.targetOrgs = p.targetOrg ? [p.targetOrg] : [];   // no ring → pinning is the only mode
        }
        const effTargets = (Array.isArray(p.targetOrgs) ? p.targetOrgs : profileTargets(p))
          .filter(u => _orgKey(u) !== _orgKey(p.sourceOrg || ''));
        p.targetOrg = effTargets[0] || '';
        const orgOpts = sel => allMapOrgs().map(o =>
          `<option value="${esc(o.url)}" ${sel === o.url ? 'selected' : ''}>${esc(orgOptionLabel(o.url, o.label, ls))}</option>`).join('');
        return `
      <div class="ds-builder-orgs-row">
        <div class="ds-builder-org-col ds-bld-col-src">
          <div class="ds-lbl ds-bld-col-hd">${dsIcon('database')}Source <span class="ds-builder-org-hint">where records come FROM</span></div>
          ${srcLocked
            ? `<div class="ds-bld-src-locked" title="Locked to your Sync Ring's source of truth — every multi-org surface flows FROM it. Change it in 🔄 Sync Ring or the topbar chip.">
                 ${dsIcon('crown')}<strong>${esc(orgLabel(ringSrc))}</strong>
                 <span class="ds-bld-src-note">your source of truth</span>
                 <a href="#" id="dsBldSrcUnlock" class="ds-bld-src-note">use a different source…</a>
               </div>`
            : `<select id="dsProfileSrcOrg" class="ds-select" aria-label="Source org — where records come from">
                <option value="">— Select source org —</option>${orgOpts(p.sourceOrg)}
                ${p.sourceOrg && !allMapOrgs().some(o => _orgKey(o.url) === _orgKey(p.sourceOrg))
                  ? `<option value="${esc(p.sourceOrg)}" selected disabled>${esc(orgLabel(p.sourceOrg))} — no longer in your org list</option>`
                  : ''}
              </select>
              ${ringSrc && p.sourceOrg && _orgKey(p.sourceOrg) !== _orgKey(ringSrc)
                ? `<div class="ds-bld-src-warn">${dsIcon('warn')}pinned off-ring: compares in this deployment measure FROM <strong>${esc(orgLabel(p.sourceOrg))}</strong> — NOT from the ring's source of truth (${esc(orgLabel(ringSrc))})
                     <button class="ds-btn ds-btn-xs" id="dsBldPromoteSrc"
                       title="Move the 👑: make ${esc(orgLabel(p.sourceOrg))} the ring's source of truth. EVERY ring surface — matrix rows, sync plans, tree diffs, the topbar chip — will measure from it, and ring-following deployments will flow FROM it. The global setting never moves silently; this button IS the explicit move.">👑 make it the source of truth</button>
                   </div>` : ''}`}
          ${p._srcCrownMoved ? `
          <div style="margin-top:6px;padding:8px 10px;border:1px solid var(--c-warn-border,#6B4A15);border-left-width:3px;border-radius:6px;font-size:12px;line-height:1.55">
            ⚠ <strong>The source of truth moved.</strong>
            This deployment now flows FROM <strong>${esc(orgLabel(p._srcCrownMoved.to))}</strong> — it was <strong>${esc(orgLabel(p._srcCrownMoved.from))}</strong> until ${timeAgo(p._srcCrownMoved.at)}.
            Compares made before the move measured FROM the old source; Reconcile marks them stale, and the crown-change rescan re-baselines open orgs automatically.
            <div style="display:flex;gap:8px;margin-top:7px;flex-wrap:wrap">
              <button class="ds-btn ds-btn-xs ds-btn-primary" id="dsBldSrcMovedAck">✓ got it — follow the new source</button>
              <button class="ds-btn ds-btn-xs" id="dsBldSrcMovedRevert"
                title="Keep this deployment flowing FROM ${esc(orgLabel(p._srcCrownMoved.from))}. Pins it as an off-ring source — the crown stops moving it, and its compares keep measuring FROM ${esc(orgLabel(p._srcCrownMoved.from))}.">↩ keep using ${esc(orgLabel(p._srcCrownMoved.from))}</button>
            </div>
          </div>` : ''}
        </div>
        <!-- The direction statement. Two of the recent bug reports came from
             this row reading as two unrelated columns; the slot is now always
             filled — the ⇄ swap BUTTON when the source can be changed, a
             static → when the ring has locked it — so the arrow is always
             there to say which way records move. -->
        <div class="ds-builder-orgs-flow">
          ${srcLocked
            ? `${dsIcon('arrow-right')}<span class="ds-sr">records flow from the source to the targets</span>`
            : `<button class="ds-builder-orgs-swap" id="dsProfileSwapOrgs" aria-label="Swap source and target orgs"
                title="Swap source and target orgs — also inverts field mappings and clears picked records (they belong to the old source org)">${dsIcon('swap')}</button>`}
        </div>
        <div class="ds-builder-org-col ds-bld-col-tgt">
          <div class="ds-lbl ds-bld-col-hd">${dsIcon('box')}Targets <span class="ds-builder-org-hint">where records are written</span></div>
          <div class="ds-bld-tgt-hint">Run deploys to <strong>all</strong> of them · field mapping previews use the first target's schema · Check all targets validates the rest</div>
          ${ringSrc ? `
          <label class="ds-pk-orgchk" title="The deployment's targets are ALWAYS whatever the ring's targets are — add an org to the ring and this deployment covers it automatically.">
            <input type="radio" name="dsBldTgtMode" value="follow" ${followMode ? 'checked' : ''}>
            ${dsIcon('repeat')} Follow the Sync Ring — all its targets, always
          </label>
          <div class="ds-bld-tgt-now">now: ${esc(effTargets.map(u => orgLabel(u)).join(' · ')) || 'none'}</div>
          <label class="ds-pk-orgchk" title="Freeze this deployment to specific orgs — ring changes won't affect it.">
            <input type="radio" name="dsBldTgtMode" value="pin" ${followMode ? '' : 'checked'}>
            ${dsIcon('pin')} Pin specific orgs:
          </label>` : ''}
          <div class="ds-pk-orgchk-list" id="dsBldTgtList" ${followMode ? 'hidden' : ''}>
            ${allMapOrgs().map(o => {
              // The source is LOCKED here, not hidden (user 2026-07-30: "when we
              // select a source org here, we need to lock it from the target
              // list"). An org silently vanishing from the list reads as a bug;
              // a disabled row that says why is self-explanatory. Deploying an
              // org to itself would match every record against itself.
              const isSrc = _orgKey(o.url) === _orgKey(p.sourceOrg || '');
              return `<label class="ds-pk-orgchk${isSrc ? ' ds-pk-orgchk-locked' : ''}"
                ${isSrc ? 'title="This is the source org — records come FROM here, so it can\'t also be a target."' : ''}>
                <input type="checkbox" data-bld-tgt="${esc(o.url)}" ${isSrc ? 'disabled' : ''} ${!isSrc && effTargets.some(u => _orgKey(u) === _orgKey(o.url)) ? 'checked' : ''}>
                ${esc(orgOptionLabel(o.url, o.label, ls))}${isSrc ? `<span class="ds-pk-lock-pill">${dsIcon('lock')}source</span>` : ''}</label>`;
            }).join('')
            || '<div class="ds-seq-empty">No orgs known — open them in Chrome tabs.</div>'}
          </div>
        </div>
      </div>`;
      })()}

      <div class="ds-builder-owner-row">
        <label class="ds-lbl">Record owners
          <span class="ds-builder-org-hint">(users differ between orgs — pick how owners transfer)</span>
        </label>
        <div class="ds-builder-owner-ctls">
          <select id="dsProfileOwnerMode" class="ds-select" aria-label="How record owners transfer">
            <option value="skip"  ${p.ownerMapping?.mode !== 'match' ? 'selected' : ''}>Don't copy owners — the target assigns its default (the running user)</option>
            <option value="match" ${p.ownerMapping?.mode === 'match' ? 'selected' : ''}>Match owners in the target; unmatched → a fallback user</option>
          </select>
          <!-- display: is still an inline style on these two. The owner-mode
               change handler shows/hides them with el.style.display, so the
               attribute is the state channel, not decoration — switching to
               [hidden] here would leave them hidden when the handler cleared
               the inline value. -->
          <select id="dsProfileOwnerFallback" class="ds-select" aria-label="Fallback user for unmatched owners" style="${p.ownerMapping?.mode === 'match' ? '' : 'display:none'}">
            <option value="">${p.ownerMapping?.fallbackUserId ? esc(p.ownerMapping.fallbackUserName || 'saved fallback user') : '— fallback user (loads from target org) —'}</option>
          </select>
        </div>
        ${(() => {
          // "Match owners by" — visible only in 'match' mode. Renders from
          // bldOwnerMatchingDisplay so a legacy match-profile WITHOUT a
          // matching config shows the Name-only path the engine will really
          // run; nothing is written back until a control here is touched.
          const m = bldOwnerMatchingDisplay(p.ownerMapping);
          const fld = (name, label, title) => `<label class="ds-bld-chk"${title ? ` title="${title}"` : ''}><input type="checkbox" data-owner-match-field="${name}" ${m.fields.includes(name) ? 'checked' : ''}> ${label}</label>`;
          const tgl = (key, label, title) => `<label class="ds-bld-chk" title="${title}"><input type="checkbox" data-owner-match-norm="${key}" ${m.normalize[key] ? 'checked' : ''}> ${label}</label>`;
          return `
        <div id="dsOwnerMatchBlock" class="ds-bld-owner-match" style="${p.ownerMapping?.mode === 'match' ? '' : 'display:none'}">
          <div class="ds-bld-owner-row">
            <span>Match owners by</span>
            ${fld('Email', 'Email')}${fld('Name', 'Name')}${fld('Username', 'Username')}${fld('Alias', 'Alias')}${fld('FederationIdentifier', 'Federation ID', 'Not usable on queue-enabled objects (Case, Lead, …) — Salesforce can’t read Federation ID through their Owner field, so the source query would fail. Prefer Email there.')}
            <span class="ds-bld-owner-sep" aria-hidden="true">·</span>
            ${tgl('caseFold', 'case-insensitive', 'Compare keys lowercase — "ADA" matches "ada"')}${tgl('trim', 'trim spaces', 'Strip leading/trailing spaces before comparing')}${tgl('emailLower', 'lowercase emails', 'Lowercase email-shaped values only — safe on non-email fields')}
          </div>
          <div class="ds-bld-owner-note">Usernames are org-suffixed, so Email usually survives sandbox refreshes best. Two target users sharing the same key = no guess: those records go to the fallback user.</div>
        </div>`;
        })()}
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
            <!-- ONE combobox (user 2026-08-05: "the best experience is to
                 type in the box and get suggestions"). Typing filters the
                 source org's object list; the same box accepts a raw API
                 name when the org isn't open. The old flow HID this input
                 behind a 1000-option native <select> once the list loaded —
                 which is exactly "you can't really type in the box". -->
            <div class="ds-autocomplete-wrap" style="flex:1">
              <input id="dsRootObj" class="ds-input" autocomplete="off" role="combobox"
                     aria-label="Root object — type to search" aria-expanded="false" aria-controls="dsRootObjAC"
                     placeholder="Loading objects from the source org…">
              <div id="dsRootObjAC" class="ds-autocomplete-list" role="listbox" style="display:none"></div>
            </div>
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
  _bldWireRootCombo();
  eid('dsPreviewAllBtn')?.addEventListener('click', () => previewAll());
  eid('dsBldCheckTargets')?.addEventListener('click', () => _bldCheckAllTargets());
  eid('dsBldSuggestPii')?.addEventListener('click', () => bldOpenPiiSuggestModal());

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
  // The unsaved name lives only in the DOM until Save; every renderBuilder()
  // below would discard it. Bind it live so re-rendering is always safe.
  eid('dsProfileName')?.addEventListener('input', e => { _editingProfile.name = e.target.value; });

  // 👑 Explicit promotion (user 2026-08-11: "when we change the source here,
  // it should also change the source in general, no?") — the ring's source
  // of truth NEVER moves silently (user ruling 2026-07-31: surprise crown
  // moves are how orgs get overwritten from the wrong direction). Changing a
  // profile's source offers the promotion in one labeled click instead.
  eid('dsBldPromoteSrc')?.addEventListener('click', async () => {
    const src = _editingProfile?.sourceOrg;
    if (!src || typeof _ring !== 'object' || !_ring) return;
    if (!confirm(`👑 Make ${orgLabel(src)} the ring's source of truth?\n\nEvery ring surface — matrix rows, sync plans, tree diffs, the topbar SOURCE chip — will measure FROM it, and deployments that follow the ring will flow FROM it.\n\nThe current crown (${orgLabel(_ring.sourceUrl)}) becomes a regular ring org.`)) return;
    // Crown history — the ring config offers ↩ restore of the previous crown.
    if (_ring.sourceUrl && _orgKey(_ring.sourceUrl) !== _orgKey(src)) {
      _ring.prevSourceUrl = _ring.sourceUrl;
      _ring.prevSourceAt  = new Date().toISOString();
    }
    _ring.sourceUrl = src;
    if (!(_ring.orgs || []).some(u => _orgKey(u) === _orgKey(src))) (_ring.orgs = _ring.orgs || []).push(src);
    try { await chrome.storage.local.set({ ds_ring: _ring }); } catch (_) {}
    // QA sweep 2026-08-11: clear the pin on the SAVED copy too — the editing
    // clone only lands on Save, but the promote's other effects persist now;
    // a cancel would otherwise strand the saved profile pinned to nothing.
    delete _editingProfile.sourcePinned;   // this profile's source IS the crown now
    const savedP = _profiles.find(x => x.id === _editingProfile.id);
    if (savedP) { delete savedP.sourcePinned; }
    // The topbar chip follows the crown — every crown path must repaint it.
    _workingPair.src = src;
    try { storageSaveWorkingPair(); } catch (_) {}
    if (typeof renderWorkingPair === 'function') renderWorkingPair();
    const moved = (typeof syncRingFollowers === 'function') ? syncRingFollowers() : null;
    showToast(`👑 ${orgLabel(src)} is now the source of truth — every ring surface follows it${moved?.srcMoved ? ` · ${moved.srcMoved} deployment(s) re-pointed (their earlier compares are marked stale)` : ''}`, 'success', 5500);
    renderBuilder();   // the source column re-locks onto the new crown
    // A crown move redefines every pair — rescan them all automatically
    // (user 2026-08-11: "every time you switch a source of truth it needs
    // to rescan both orgs and update sync status").
    if (typeof sftkRingRebaseline === 'function') sftkRingRebaseline(`${orgLabel(src)} became the source of truth`);
  });

  eid('dsBldSrcMovedAck')?.addEventListener('click', async e => {
    e.preventDefault();
    delete _editingProfile._srcCrownMoved;
    try { await storageSaveProfiles(); } catch (_) {}
    renderBuilder();
  });

  eid('dsProfileSrcOrg')?.addEventListener('change', e => {
    _editingProfile.sourceOrg = e.target.value || '';
    // Dynamic-source contract (user 2026-08-11): a hand-picked source that
    // differs from the crown is a PIN — the crown stops moving it. Picking
    // the crown itself re-joins follow mode.
    const _crown = (typeof _ring === 'object' && _ring?.sourceUrl) ? _ring.sourceUrl : '';
    if (_crown && _editingProfile.sourceOrg && _orgKey(_editingProfile.sourceOrg) !== _orgKey(_crown)) {
      _editingProfile.sourcePinned = true;
    } else {
      delete _editingProfile.sourcePinned;
    }
    delete _editingProfile._srcCrownMoved;   // a deliberate pick supersedes the move notice
    // An org can't deploy to itself. Drop the new source from a PINNED target
    // set — the render-time filter only cleans the display, so without this
    // the stale entry survives in targetOrgs and the next checkbox tick
    // re-saves it. Follow-mode (null) resolves live and needs no fix.
    if (Array.isArray(_editingProfile.targetOrgs)) {
      const before = _editingProfile.targetOrgs.length;
      _editingProfile.targetOrgs = _editingProfile.targetOrgs
        .filter(u => _orgKey(u) !== _orgKey(_editingProfile.sourceOrg));
      if (_editingProfile.targetOrgs.length !== before) {
        showToast(`${orgLabel(_editingProfile.sourceOrg)} is the source now — removed it from the targets.`, 'info', 4500);
      }
      _editingProfile.targetOrg = _editingProfile.targetOrgs[0] || '';
    }
    renderBuilder();         // repaint the target list with the new source locked
    _bldLoadRootObjects();   // the root-object list comes from the source org
  });
  document.querySelectorAll('[data-bld-tgt]').forEach(cb =>
    cb.addEventListener('change', () => {
      // Filter the source out again here: the disabled checkbox can't be
      // ticked, but a stale checked one from a pre-fix profile would
      // otherwise be re-collected and persisted.
      const sel = [...document.querySelectorAll('[data-bld-tgt]:checked')].map(c => c.dataset.bldTgt)
        .filter(u => _orgKey(u) !== _orgKey(_editingProfile.sourceOrg || ''));
      _editingProfile.targetOrgs = sel;           // touching the list = pinning
      _editingProfile.targetOrg  = sel[0] || '';  // first target = schema reference (engine compat)
      const pin = document.querySelector('input[name="dsBldTgtMode"][value="pin"]');
      if (pin) pin.checked = true;
    }));
  // Follow ⇄ pin mode switch. Follow = targetOrgs null (resolved live from
  // the ring); pin starts from the current effective set.
  document.querySelectorAll('input[name="dsBldTgtMode"]').forEach(r =>
    r.addEventListener('change', () => {
      if (!r.checked) return;
      if (r.value === 'follow') {
        _editingProfile.targetOrgs = null;
        _editingProfile.targetOrg = profileTargets(_editingProfile)[0] || '';
      } else {
        _editingProfile.targetOrgs = profileTargets(_editingProfile).slice();
      }
      renderBuilder();
    }));
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
  // 'match': resolve the source owner to a target user at write time via
  // ownerMapping.matching (fields picked in the block below; ABSENT config
  // = the legacy Name-only engine path). Unmatched owners get the fallback
  // user picked here. The user list loads live from the TARGET org (must
  // be open in a tab).
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
    // ONE page (SF_QUERY), no embedded LIMIT. The old query said
    // "SF_QUERY_ALL … LIMIT 500", which is a contradiction: the LIMIT means
    // the server returns a single page with no nextRecordsUrl, so paging
    // never happened and the list was silently truncated at 500. Dropping the
    // LIMIT also makes totalSize the org's REAL count (with a LIMIT it just
    // echoes the cap), so the cap below is stated with a measured number.
    // Still one round-trip — an org under the cap sees exactly what it saw.
    const q = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid,
      query: `SELECT Id, Name, Username FROM User WHERE IsActive = true AND UserType = 'Standard' ORDER BY Name` });
    if (q?.error || !Array.isArray(q?.records)) {
      if (hint) hint.textContent = `Couldn't load users: ${q?.error || 'no response'}`;
      return;
    }
    const list = bldOwnerFallbackList(q.records, q.totalSize, OWNER_FALLBACK_OPTION_LIMIT, q.done);
    const cur  = _editingProfile.ownerMapping?.fallbackUserId || '';

    // Is the SAVED fallback user really gone, or just past the cap? Never
    // conclude "missing" from a truncated list — that false negative silently
    // changes owner mapping on the next deployment. Resolve the id directly
    // when (and ONLY when) the page can't answer it: no extra round-trip for
    // an org whose users all fit in one page.
    let saved = bldSavedFallbackPlan(cur, list.shown, q.records, list.pageComplete);
    if (saved.action === 'lookup') {
      // 'lookup' is only returned for an id that already passed the strict
      // 15/18-char alphanumeric test, so there is nothing quotable to inject.
      const one = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid,
        query: `SELECT Id, Name, Username, IsActive, UserType FROM User WHERE Id = '${cur}'` });
      saved = bldSavedFallbackFromLookup(one);
    }
    // 'restore' = a real, usable user the cap hid. Pin it at the top so the
    // select shows the truth instead of falling back to the placeholder.
    const pinned = saved.action === 'restore' && saved.user ? saved.user : null;
    const opt = u => `<option value="${esc(u.Id)}" data-name="${esc(u.Name)}"${u.Id === cur ? ' selected' : ''}>` +
      `${esc(u.Name)}${u.Username ? ` (${esc(u.Username)})` : ''}${pinned && u.Id === pinned.Id ? ' — not in the list below' : ''}</option>`;
    sel.innerHTML = `<option value="">— fallback user (used when the owner has no name match) —</option>` +
      (pinned ? opt(pinned) : '') +
      list.shown.map(opt).join('');
    if (hint) hint.textContent = bldOwnerFallbackHint(list, orgLabel(_editingProfile.targetOrg), saved);
  }
  // Match-owners-by controls. Selection is capped at 4 fields (matches the
  // sftk-matching key-builder cap); at the cap, unchecked boxes disable
  // with a title saying why.
  const _ownerMatchCapSync = () => {
    const boxes = [...document.querySelectorAll('[data-owner-match-field]')];
    const atCap = boxes.filter(b => b.checked).length >= 4;
    boxes.forEach(b => {
      b.disabled = atCap && !b.checked;
      const lbl = b.closest('label');
      if (lbl) lbl.title = b.disabled ? 'Up to 4 match fields — untick one to add this' : '';
    });
  };
  const _ownerMatchStore = () => {
    if (_editingProfile.ownerMapping?.mode !== 'match') return;
    _editingProfile.ownerMapping.matching = bldOwnerMatchingFromControls(
      [...document.querySelectorAll('[data-owner-match-field]')].filter(b => b.checked).map(b => b.dataset.ownerMatchField),
      Object.fromEntries([...document.querySelectorAll('[data-owner-match-norm]')].map(b => [b.dataset.ownerMatchNorm, b.checked])));
  };
  const _ownerMatchSyncDom = m => {
    document.querySelectorAll('[data-owner-match-field]').forEach(b => { b.checked = (m.fields || []).includes(b.dataset.ownerMatchField); });
    document.querySelectorAll('[data-owner-match-norm]').forEach(b => { b.checked = !!(m.normalize || {})[b.dataset.ownerMatchNorm]; });
    _ownerMatchCapSync();
  };
  document.querySelectorAll('[data-owner-match-field]').forEach(cb =>
    cb.addEventListener('change', () => {
      // Zero fields would send EVERY record to the fallback user — keep one.
      if (!cb.checked && !document.querySelector('[data-owner-match-field]:checked')) {
        cb.checked = true;
        showToast('Owner matching needs at least one field.', 'warning', 3000);
        return;
      }
      _ownerMatchStore();
      _ownerMatchCapSync();
    }));
  document.querySelectorAll('[data-owner-match-norm]').forEach(cb =>
    cb.addEventListener('change', () => _ownerMatchStore()));
  _ownerMatchCapSync();

  eid('dsProfileOwnerMode')?.addEventListener('change', e => {
    const mode = e.target.value;
    const sel  = eid('dsProfileOwnerFallback');
    const blk  = eid('dsOwnerMatchBlock');
    if (mode === 'match') {
      _editingProfile.ownerMapping = { mode: 'match',
        fallbackUserId:   _editingProfile.ownerMapping?.fallbackUserId   || null,
        fallbackUserName: _editingProfile.ownerMapping?.fallbackUserName || null,
        // Picking 'match' is a control touch, so seeding the default here is
        // safe: only UNTOUCHED legacy profiles must stay config-less (absent
        // matching = the Name-only engine path).
        matching: _editingProfile.ownerMapping?.matching
          || bldOwnerMatchingFromControls(['Email', 'Name'], { emailLower: true, trim: true }) };
      if (sel) sel.style.display = '';
      if (blk) { blk.style.display = ''; _ownerMatchSyncDom(_editingProfile.ownerMapping.matching); }
      loadOwnerFallbackUsers();
    } else {
      delete _editingProfile.ownerMapping;
      if (sel) sel.style.display = 'none';
      if (blk) blk.style.display = 'none';
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
      // A swap collapses the target set to the single swapped-in org — the
      // old multi-target set pointed at the OLD source's world.
      prof.targetOrgs = prof.targetOrg ? [prof.targetOrg] : [];
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

// ── Owner matching (O1) — pure helpers ────────────────────────────
// What the "Match owners by" block should SHOW for a profile's
// ownerMapping — read-only, never writes back. Three states:
//   • matching present → it, sanitized (known fields, canonical order, ≤4)
//   • mode 'match' with NO matching → the legacy Name-only engine path —
//     showing the modern default there would misreport what a run will do
//   • otherwise (skip / unset) → the default a fresh switch to 'match' seeds
function bldOwnerMatchingDisplay(ownerMapping) {
  const KNOWN = ['Email', 'Name', 'Username', 'Alias', 'FederationIdentifier'];
  const m = ownerMapping && ownerMapping.matching;
  if (m && Array.isArray(m.fields) && m.fields.filter(Boolean).length) {
    const set = new Set(m.fields.filter(Boolean));
    return { fields: KNOWN.filter(f => set.has(f)).slice(0, 4),
             normalize: { ...(m.normalize || {}) } };
  }
  if (ownerMapping && ownerMapping.mode === 'match') {
    return { fields: ['Name'], normalize: {} };
  }
  return { fields: ['Email', 'Name'], normalize: { emailLower: true, trim: true } };
}

// Build ownerMapping.matching from the block's control state. Field order is
// canonical, not click order (key components must line up on both sides);
// unknown names drop; selection is capped at 4 (the sftkMatchKey cap).
// Pure — the field list is inlined so test extraction stays self-contained.
function bldOwnerMatchingFromControls(checkedFields, toggles) {
  const KNOWN = ['Email', 'Name', 'Username', 'Alias', 'FederationIdentifier'];
  const set = new Set(Array.isArray(checkedFields) ? checkedFields : []);
  const t = toggles || {};
  return {
    fields: KNOWN.filter(f => set.has(f)).slice(0, 4),
    normalize: { emailLower: !!t.emailLower, caseFold: !!t.caseFold, trim: !!t.trim }
  };
}

// ── Owner-fallback picker: cap + saved-id resolution (pure) ─────────────
// Top-level (column 0) and free-variable-free so test/scale-caps.test.mjs can
// materialize them via test/extract.mjs.
//
// The fallback picker is a <select>. In a 50k-user org an unbounded fetch
// would build a 50k-option dropdown nobody can use, so the OPTION list stays
// capped — but the query no longer carries an embedded LIMIT, which means the
// response's totalSize is the org's REAL count of active standard users
// (a LIMIT makes totalSize echo the cap). So the cap is stated with a
// measured number instead of being silent.

// How many users the fallback <select> renders. A cap on the OPTIONS only —
// never on what the code believes exists.
const OWNER_FALLBACK_OPTION_LIMIT = 500;

// Split one page of user records into "what the dropdown shows" and "what
// this org actually has". `totalSize` is the count Salesforce reported for
// the whole query; pass null/undefined when it wasn't reported.
//   shown        — the options to render (≤ limit)
//   total        — measured org total, or null when unknown (never guessed)
//   capped       — true when rows exist that the dropdown does NOT show
//   pageComplete — true when `records` is every matching row, so an id that
//                  is absent from it really is absent (no lookup needed)
function bldOwnerFallbackList(records, totalSize, limit, pageDone) {
  const all = Array.isArray(records) ? records : [];
  const cap = Number.isFinite(limit) && limit > 0 ? limit : all.length;
  const shown = all.slice(0, cap);
  const t = Number(totalSize);
  // A totalSize below the rows in hand is not a total (that is what a LIMIT-ed
  // query reports) — treat it as "unknown" rather than publish it.
  const total = Number.isFinite(t) && t >= all.length ? t : null;
  // Completeness needs BOTH signals to agree: Salesforce saying it is done AND
  // the total (when known) fitting in what we hold. Either one saying "more"
  // wins, because claiming completeness wrongly is the expensive mistake.
  const pageComplete = pageDone !== false && (total == null || total <= all.length);
  const capped = (total != null && total > shown.length) || all.length > shown.length || !pageComplete;
  return { shown, total, capped, fetched: all.length, pageComplete };
}

// What can we honestly say about the SAVED fallback user id? Absence from a
// capped list proves nothing — that inference is the false negative this
// replaces. Returns the action the caller must take:
//   'none'    — nothing saved
//   'listed'  — already an option; render as-is (the common path)
//   'restore' — real user, just past the display cap; prepend it as selected
//   'absent'  — the page IS complete, so it genuinely is not an active
//               standard user here (deactivated / deleted / other type)
//   'lookup'  — the page is truncated; the id must be queried directly
//   'invalid' — not an 18/15-char Salesforce id; nothing to look up
function bldSavedFallbackPlan(savedId, shown, page, pageComplete) {
  const id = typeof savedId === 'string' ? savedId.trim() : '';
  if (!id) return { action: 'none', user: null };
  if (!/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(id)) return { action: 'invalid', user: null };
  const inShown = (Array.isArray(shown) ? shown : []).find(u => u && u.Id === id);
  if (inShown) return { action: 'listed', user: inShown };
  const inPage = (Array.isArray(page) ? page : []).find(u => u && u.Id === id);
  if (inPage) return { action: 'restore', user: inPage };
  if (pageComplete) return { action: 'absent', user: null };
  return { action: 'lookup', user: null };
}

// Interpret the targeted "SELECT … WHERE Id = '…'" response. A failed lookup
// is reported as unverified — never as "the user is gone".
function bldSavedFallbackFromLookup(res) {
  if (!res || res.error) return { action: 'unverified', user: null, error: res && res.error ? String(res.error) : 'no response' };
  const rec = Array.isArray(res.records) ? res.records[0] : null;
  if (!rec) return { action: 'gone', user: null };
  if (rec.IsActive === false) return { action: 'inactive', user: rec };
  if (rec.UserType != null && rec.UserType !== 'Standard') return { action: 'othertype', user: rec };
  return { action: 'restore', user: rec };
}

// The one-line hint under the picker. Never claims a total it did not
// measure, and never reports the saved user as missing on the strength of a
// capped list alone.
function bldOwnerFallbackHint(list, orgName, saved) {
  const group = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const shownN = list && Array.isArray(list.shown) ? list.shown.length : 0;
  const where = orgName ? ` in ${orgName}` : '';
  let base;
  if (!list || !list.capped) {
    base = `${group(shownN)} active standard user(s)${where}.`;
  } else if (list.total != null) {
    base = `Showing the first ${group(shownN)} of ${group(list.total)} active standard users${where}, by name.`;
  } else {
    base = `Showing the first ${group(shownN)} active standard users${where}, by name — this org has more.`;
  }
  const s = saved || { action: 'none' };
  const name = s.user && s.user.Name ? s.user.Name : 'the saved user';
  switch (s.action) {
    case 'restore':
      return `${base} Saved fallback user ${name} is outside that list — kept and pinned at the top.`;
    case 'absent':
      return `${base} ⚠ The saved fallback user is not among them (deactivated, deleted, or not a standard user) — pick another.`;
    case 'inactive':
      return `${base} ⚠ Saved fallback user ${name} is INACTIVE in this org — inactive users can't own records; pick another.`;
    case 'othertype':
      return `${base} ⚠ Saved fallback user ${name} is not a standard user in this org — pick another.`;
    case 'gone':
      return `${base} ⚠ The saved fallback user no longer exists in this org — pick another.`;
    case 'unverified':
      return `${base} ⚠ Couldn't check the saved fallback user (${s.error || 'lookup failed'}) — it is left unchanged; re-open this profile to retry.`;
    case 'invalid':
      return `${base} ⚠ The saved fallback user id is not a valid Salesforce id — pick another.`;
    default:
      return base;
  }
}

// Load the root-object list from the source org for the combobox.
// Cached per org key; the SAME input keeps accepting a raw API name when
// the source org has no live session (the list just stays empty).
let _bldObjCache = {};
let _bldRootObjList = [];
async function _bldLoadRootObjects() {
  const inp = eid('dsRootObj');
  if (!inp) return;   // tree already set — no root picker on screen
  _bldRootObjList = [];
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
  if (!eid('dsRootObj')) return;   // view changed while loading
  _bldRootObjList = list;
  inp.placeholder = `Type to search ${list.length} objects — Account, Case__c…`;
}

// PURE — rank the object list for the combobox. Prefix hits on the API name
// outrank prefix hits on the label, which outrank contains-hits; ties stay
// alphabetical by label. Empty term → the whole list (the renderer caps).
function bldRankObjects(list, term) {
  const t = String(term || '').trim().toLowerCase();
  if (!t) return (list || []).slice();
  const tier = o => {
    const n = String(o.name || '').toLowerCase();
    const l = String(o.label || '').toLowerCase();
    if (n.startsWith(t)) return 0;
    if (l.startsWith(t)) return 1;
    if (n.includes(t) || l.includes(t)) return 2;
    return 3;
  };
  return (list || []).map(o => [tier(o), o]).filter(p => p[0] < 3)
    .sort((a, b) => a[0] - b[0] || String(a[1].label).localeCompare(String(b[1].label)))
    .map(p => p[1]);
}

// The combobox behavior: type → ranked suggestions, arrow keys + Enter,
// mousedown pick (fires before the input's blur), Escape/blur close. Enter
// with the list CLOSED and a value typed = Set Root (one less click).
function _bldWireRootCombo() {
  const inp = eid('dsRootObj');
  const ac  = eid('dsRootObjAC');
  if (!inp || !ac) return;
  const AC_CAP = 50;
  const close = () => { ac.style.display = 'none'; inp.setAttribute('aria-expanded', 'false'); };
  const rows  = () => [...ac.querySelectorAll('.ds-autocomplete-item')];
  const paint = () => {
    if (!_bldRootObjList.length) { close(); return; }   // no list — plain typing mode
    const ranked = bldRankObjects(_bldRootObjList, inp.value);
    const shown  = ranked.slice(0, AC_CAP);
    ac.innerHTML = shown.map(o =>
      `<div class="ds-autocomplete-item" role="option" data-name="${esc(o.name)}">
         <span class="ds-autocomplete-item-api">${esc(o.name)}</span>
         <span class="ds-autocomplete-item-label">${esc(o.label)}</span>
       </div>`).join('')
      + (ranked.length > shown.length ? `<div class="ds-autocomplete-note">+${ranked.length - shown.length} more — keep typing</div>` : '')
      + (!ranked.length ? `<div class="ds-autocomplete-note">No object matches — Set Root still accepts a raw API name.</div>` : '');
    ac.style.display = '';
    inp.setAttribute('aria-expanded', 'true');
    rows().forEach(el => el.addEventListener('mousedown', e => {
      e.preventDefault();
      inp.value = el.dataset.name;
      close();
    }));
  };
  const move = dir => {
    const list = rows();
    if (!list.length) return;
    const cur = list.findIndex(el => el.classList.contains('active'));
    const next = cur < 0 ? (dir > 0 ? 0 : list.length - 1)
      : Math.min(list.length - 1, Math.max(0, cur + dir));
    list.forEach(el => el.classList.remove('active'));
    list[next].classList.add('active');
    try { list[next].scrollIntoView({ block: 'nearest' }); } catch (_) {}
  };
  inp.addEventListener('input', paint);
  inp.addEventListener('focus', paint);
  inp.addEventListener('blur', close);
  inp.addEventListener('keydown', e => {
    const open = ac.style.display !== 'none';
    if (e.key === 'Escape' && open) { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) paint();
      move(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (open) {
        const act = rows().find(el => el.classList.contains('active'));
        if (act) { inp.value = act.dataset.name; close(); return; }
        close();
      }
      if (inp.value.trim()) setRootObject();
    }
  });
}

function setRootObject() {
  const objType = (eid('dsRootObj')?.value || '').trim();
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
// Accepts an explicit profile (post-import check runs before any builder
// session exists); no argument = the builder's editing profile, as before.
async function _bldCheckAllTargets(profileArg) {
  const p = profileArg || _editingProfile;
  if (!p?.tree) return;
  const targets = profileTargets(p);
  if (!targets.length) { showToast('No targets known — configure the Sync Ring or pin targets in the builder', 'warning', 5000); return; }
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
      .map(f => ({ name: f.name, label: f.label || f.name, type: f.type, externalId: f.externalId === true }))
      // External-ID fields FIRST — they're the reliable cross-org anchors
      // (user 2026-08-10: "inside the field picker we should mark them and
      // suggest them"); alphabetical within each group.
      .sort((a, b) => (b.externalId - a.externalId) || (a.label || a.name).localeCompare(b.label || b.name));
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
    `<option value="${esc(cf.name)}" ${(currentMatchField || 'Name') === cf.name ? 'selected' : ''}>${cf.externalId ? '⚡ ' : ''}${esc(cf.label)} (${esc(cf.name)})${cf.externalId ? ' · External ID' : ''}</option>`
  ).join('');
  return `<select class="ds-select-sm ds-lkp-match-select" ${dataAttrs}>${options}</select>`;
}

// 🔍 Parent alignment check from the Builder (user 2026-08-10). Ephemeral
// scan of the parent object across the deployment's org pair; verdict in a
// modal so the Builder's unsaved in-memory edits are never blown away. The
// north star this serves: every org aligned to the source of truth —
// parents must align BEFORE children can.
async function bldCompareParent(refObj, btn) {
  const p = _editingProfile;
  if (!p?.sourceOrg || !p?.targetOrg) {
    showToast('Set this deployment’s source and target orgs first — the compare needs the pair', 'warning', 4500);
    return;
  }
  const prev = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ scanning…'; }
  try {
    const eph = {
      id: `gap_${Date.now()}`,
      name: `${refObj} — parents first`,
      sourceOrg: p.sourceOrg, targetOrg: p.targetOrg,
      ephemeral: true,
      scanConfig: { matchField: 'Name', compareFields: [] },
      tree: { objectType: refObj, where: '', children: [] },
      _parentOf: { profileId: p.id, objType: p.tree?.objectType || p.tree?.childSObject },
    };
    const res = await runDiffScan(eph);
    if (res?.error) { showToast(`Scan failed: ${res.error}`, 'error', 6000); return; }
    eph.lastScan = res;
    const nMiss = (res.missingInTarget || []).length;
    const nChg  = (res.changed || []).length;
    const nExt  = (res.onlyInTarget || []).length;
    const nSame = (res.identical || []).length;
    // Feed the session sync map so the row chip (and the reconcile panel)
    // SHOW this verdict from now on.
    try {
      sftkParentSyncPut(p.sourceOrg, p.targetOrg, refObj, {
        missing: nMiss, changed: nChg, extra: nExt, at: res.runAt || new Date().toISOString(),
      });
      sftkBldFillParentSync();
    } catch (_) { /* advisory map only */ }
    const aligned = !nMiss && !nChg;
    showModal(`
      <div class="ds-modal-hdr">🔍 ${esc(refObj)} — ${esc(orgLabel(p.sourceOrg))} → ${esc(orgLabel(p.targetOrg))}</div>
      <div style="padding:14px 16px; font-size:13px; line-height:1.7">
        ${aligned
          ? `<div style="font-weight:600; color:#067647">✓ Parents aligned — ${nSame} record(s) match${nExt ? `, ${nExt} extra in target (review if unexpected)` : ''}. Safe to deploy objects that point at ${esc(refObj)}.</div>`
          : `<div style="font-weight:600; color:#b45309">Not aligned yet:</div>
             <div>🔴 ${nMiss} missing in target · 🟡 ${nChg} changed · 🔵 ${nExt} only in target · 🟢 ${nSame} in sync</div>
             <div style="margin-top:6px">Fix these BEFORE deploying — lookups pointing at missing/drifted parents land empty or wrong.</div>`}
        <div style="margin-top:12px; display:flex; gap:8px; align-items:center">
          ${aligned ? '' : `<button class="ds-btn ds-btn-sm ds-btn-primary" id="bldParentCmpOpen">⚖ Open Reconcile to fix</button>`}
          <button class="ds-btn ds-btn-sm" id="bldParentCmpClose">Close</button>
          ${aligned ? '' : `<span style="font-size:11px; color:var(--subtext)">unsaved Builder edits stay in memory — 💾 Save first if you want them persisted</span>`}
        </div>
      </div>`);
    eid('bldParentCmpClose')?.addEventListener('click', closeModal);
    eid('bldParentCmpOpen')?.addEventListener('click', () => {
      closeModal();
      _reconcileProfile = eph;
      renderReconcile();
    });
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = prev; }
  }
}

// ⧉ JUNCTION DETECTION (user 2026-08-10: "we might need to catch junction
// early?" — yes, at describe time). A junction's three traps: BOTH parents
// must exist before insert (two required edges, not one), child-first is
// physically impossible (master-detail), and — the silent one — junction
// rows usually carry autonumber/meaningless Names, so Name-matching is
// wrong and every re-run duplicates; the true identity is the PARENT PAIR.
// PURE — unit-tested.
function sftkJunctionInfo(descFields) {
  const fields = Array.isArray(descFields) ? descFields : [];
  const md = fields.filter(f => f && f.type === 'reference' && f.relationshipOrder != null);
  const reqRefs = fields.filter(f => f && f.type === 'reference' && f.createable &&
    f.nillable === false && f.relationshipOrder == null &&
    !['OwnerId', 'RecordTypeId', 'CreatedById', 'LastModifiedById'].includes(f.name));
  const parents = [...md, ...reqRefs];
  const isJunction = md.length >= 2 || (md.length + reqRefs.length) >= 2 && md.length >= 1;
  const nameFld = fields.find(f => f && f.nameField);
  return {
    isJunction,
    parents: parents.map(f => f.name),
    masterDetails: md.length,
    nameIsAuto: !!(nameFld && nameFld.autoNumber === true),
  };
}

// Fill every lookup row's sync chip from the session verdict map (user
// 2026-08-10: "since the parents are synced we need to show it"). Verdicts
// come from any reconcile scan of that object on this org pair — including
// the parents-first flow the user just ran. No probe, no cost: it shows
// what the session already learned; blank until a scan has run.
async function sftkBldFillParentSync() {
  const p = _editingProfile;
  if (!p?.sourceOrg || !p?.targetOrg) return;
  try { await sftkParentSyncLoad(); } catch (_) {}   // persisted verdicts survive reloads
  document.querySelectorAll('[data-lkp-syncstate]').forEach(elm => {
    let vd = null;
    try { vd = _parentSyncVerdicts[sftkParentSyncKey(p.sourceOrg, p.targetOrg, elm.dataset.lkpSyncstate)]; } catch (_) { vd = null; }
    if (!vd) {
      // A blank chip read as "not synced" (user 2026-08-11: "parents are not
      // showing synced but they are synced") — but blank really means NO
      // SCAN OF THIS PAIR IS ON RECORD. Say that, and say the one-click way
      // to verify; 🔍 compare parents deposits the verdict for this exact
      // source→target pair.
      elm.className = 'ds-psync';
      elm.textContent = 'state unknown for this org pair — 🔍 compare parents verifies it';
      elm.title = 'No scan of this object against THIS source→target pair is on record. Synced against a different target does not count — each pair is verified separately. Click 🔍 compare parents (one scan) and this chip fills in.';
      return;
    }
    const inSync = !vd.missing && !vd.changed;
    elm.className = `ds-psync ${inSync ? 'ds-psync-ok' : 'ds-psync-bad'}`;
    elm.textContent = inSync
      ? `✓ in sync · ${timeAgo(vd.at)}`
      : `🔴 ${vd.missing} missing · 🟡 ${vd.changed} changed · ${timeAgo(vd.at)}`;
    elm.title = inSync
      ? `Last ${elm.dataset.lkpSyncstate} scan on this org pair found nothing missing and nothing changed — the name-bridges have parents to land on.`
      : `Last ${elm.dataset.lkpSyncstate} scan on this org pair still had work to do — compare & fix before deploying this object.`;
  });
}

// ⚡ External-ID suggestion (user 2026-08-10: "if we detect external id
// field with data we should offer it"). For every match-strategy lookup
// row: if the referenced object has an External ID field, probe the SOURCE
// org once for actual data in it (cached per org+object+field) and upgrade
// the passive tip line into an ACTIVE one-click offer. Already matching by
// an External ID → say so with a ✓. Empty External ID field → say that
// too, honestly, instead of suggesting an anchor that matches nothing.
const _extIdDataCache = {};
async function sftkBldSuggestExtIds() {
  const sess = _builderSession();
  if (!sess.orgUrl || !sess.sid) return;
  for (const slot of document.querySelectorAll('[data-lkp-extid-slot]')) {
    const [refObj, fieldName, pathKey] = (slot.dataset.lkpExtidSlot || '').split('|');
    const cached = _refFieldCache[refObj];
    if (!Array.isArray(cached)) continue;
    const extFields = cached.filter(cf => cf.externalId);
    if (!extFields.length) {
      // Telling the user to "pick an External ID field" when the object has
      // NONE was misleading (user 2026-08-10: "they dont show the suggested
      // state?") — say the true state and the way out.
      slot.innerHTML = `<span class="ds-lkp-hint" title="External IDs survive renames and duplicates, which makes them the most reliable cross-org anchor. Create one on ${esc(refObj)} in BOTH orgs (Setup → Object Manager → Fields — Text, ✓ External ID, ideally ✓ Unique), fill it in the source, and this row will offer it automatically.">no External ID field on ${esc(refObj)} yet — matching by Name (create one in both orgs for bulletproof matching)</span>`;
      continue;
    }
    const node = getNodeByPath(_editingProfile?.tree, pathKey);
    const current = node?.lookupResolutions?.[fieldName]?.matchField || 'Name';
    if (extFields.some(cf => cf.name === current)) {
      slot.innerHTML = `<span class="ds-psync ds-psync-ok" title="External IDs are stable across orgs — the most reliable anchor there is.">⚡ matching by External ID ✓</span>`;
      continue;
    }
    const ext = extFields[0];
    const ck = `${sftkOrgKey(sess.orgUrl)}|${refObj}|${ext.name}`;
    if (!(ck in _extIdDataCache)) {
      const probe = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid,
        _suppressError: true, query: `SELECT Id FROM ${refObj} WHERE ${ext.name} != null LIMIT 1` });
      _extIdDataCache[ck] = probe?.error ? null : (probe?.records || []).length > 0;
    }
    if (_extIdDataCache[ck] === true) {
      slot.innerHTML = `⚡ <strong>${esc(ext.label)}</strong> is an External ID with data — <button class="ds-btn ds-btn-xs ds-btn-primary" data-lkp-useext="${esc(refObj)}|${esc(fieldName)}|${esc(pathKey)}|${esc(ext.name)}" title="Match ${esc(refObj)} records by ${esc(ext.name)} instead of Name — External IDs survive renames and duplicates.">use it</button>`;
      slot.querySelector('[data-lkp-useext]')?.addEventListener('click', btn2 => {
        const [ro, fn, pk, ef] = btn2.currentTarget.dataset.lkpUseext.split('|');
        const n = getNodeByPath(_editingProfile?.tree, pk);
        if (!n) return;
        if (!n.lookupResolutions) n.lookupResolutions = {};
        n.lookupResolutions[fn] = { ...(n.lookupResolutions[fn] || {}), strategy: 'match', matchObject: ro, matchField: ef };
        refreshTree();
        showToast(`⚡ ${ro} now matches by ${ef}`, 'success', 3000);
      });
    } else if (_extIdDataCache[ck] === false) {
      slot.innerHTML = `<span class="ds-lkp-hint" title="An External ID anchor only helps when it holds values — matching on an empty field finds nothing.">⚡ ${esc(ext.label)} is an External ID but has NO data in the source — fill it, or keep matching by Name</span>`;
    }
  }
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
        ? `<span class="ds-lkp-hint" data-lkp-extid-slot="${esc(refObj)}|${esc(f.name)}|${esc(pathKey)}">tip: pick an External ID field for reliable cross-org matching</span>`
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
      <span class="ds-psync" data-lkp-syncstate="${esc(refObj)}"></span>
      <button class="ds-btn ds-btn-xs ds-lkp-parentcmp" data-lkp-parentcmp="${esc(refObj)}"
        title="Scan ${esc(refObj)} across this deployment's org pair RIGHT NOW and see whether the parents are aligned — missing or drifted parents there are exactly what makes lookups on ${esc(node.objectType || node.childSObject || 'this object')} land empty. Fix them first, then deploy this object.">🔍 compare parents</button>
    </div>`;
  });

  // ⧉ Junction badge — caught at describe time, where it's cheapest to warn.
  const jinfo = sftkJunctionInfo(node._meta?.availableFields);
  const junctionChip = jinfo.isJunction
    ? `<span class="ds-lkp-hdr-role ds-lkp-junction" title="This object joins ${jinfo.parents.slice(0, 2).join(' and ')} (many-to-many). Three things follow: BOTH parent objects must exist in the target before it deploys; child-first ordering is impossible (master-detail links are required at insert); and junction rows ${jinfo.nameIsAuto ? 'have an AUTONUMBER name, so' : 'often have meaningless names, so'} matching by Name across orgs is wrong — their true identity is the PARENT PAIR. Use Composite matching on the two parent lookups in 🎯 Pick Records → Matching, or re-runs will duplicate every row.">⧉ JUNCTION — both parents first · match by the pair, not the Name</span>`
    : '';
  return `<div class="ds-lkp-section">
    <div class="ds-lkp-hdr">
      <span class="ds-lkp-hdr-icon">🔗</span>
      <span class="ds-lkp-hdr-label">Lookup Resolution <span class="ds-lkp-hdr-role" title="Direction: these lookups point UP at parent records. The records they point at must already exist in the target org when this object deploys — deploy the parent objects first (or hand-pick targets in Reconcile 🔗). Child objects are the opposite direction: they point AT this object and are added below with + Add child relationship — the engine orders those automatically.">⬆ these are this object's PARENTS</span>${junctionChip}</span>
      <span class="ds-lkp-hdr-hint">Each row is a record this object points at — it must exist in the target BEFORE this object deploys, or the lookup lands empty</span>
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
            <summary class="ds-tree-rels-summary" title="Direction: CHILDREN point AT this object (the opposite of the Lookup Resolution parents above). A child added here deploys WITH this object — the engine inserts in the right order and wires the links automatically.">+ Add child relationship <span class="ds-tree-rels-role">⬇ objects that point AT this one — deploy together, auto-ordered</span> <span class="ds-tree-rels-count">${candidates.length} available</span></summary>
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
          <button class="ds-tree-toggle" data-path="${esc(pathKey)}" aria-expanded="${meta.expanded ? 'true' : 'false'}" aria-label="${meta.expanded ? 'Collapse' : 'Expand'} ${esc(objName)}">${meta.expanded ? '▼' : '▶'}</button>
          <span class="ds-tree-node-icon">${icon}</span>
          <span class="ds-tree-obj-name">${esc(objName)}</span>
          ${relBadge}
          ${countBadge}${loadingBadge}
          ${!meta.expanded && (node.recordIds?.length || node.insertOrder === 'childFirst') ? (() => {
            // Collapsing a node hides its whole config row (🎯 Records,
            // mapping, insert order) — state the user set must never become
            // invisible (user report 2026-08-04: "couldn't locate the child
            // records picker"). These chips survive the collapse and click
            // through to expand.
            const bits = [];
            if (node.recordIds?.length) bits.push(`🎯 ${node.recordIds.length}`);
            if (node.insertOrder === 'childFirst') bits.push('⤴ child-first');
            const what = [
              node.recordIds?.length ? `${node.recordIds.length} hand-picked record(s)` : '',
              node.insertOrder === 'childFirst' ? 'child-first insert order' : '',
            ].filter(Boolean).join(' and ');
            return `<button class="ds-tree-collapsed-chips" data-expand-chip="${esc(pathKey)}"
              title="Collapsed — this node still has ${esc(what)}. Click to expand and edit.">${bits.join(' · ')}</button>`;
          })() : ''}
          <div class="ds-tree-node-actions">
            <button class="ds-btn ds-btn-xs" data-preview="${esc(pathKey)}" title="Count records">👁 Preview</button>
            ${!isRoot ? `<button class="ds-btn ds-btn-xs ds-btn-danger" data-remove="${esc(pathKey)}" aria-label="Remove ${esc(objName)} from the tree" title="Remove">${dsIcon('x')}</button>` : ''}
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
          ${(() => {
            // "N masked" chip — rendered from the POLICY (profile.piiPolicy),
            // not from any modal state, so it survives modal cancel and
            // profile reload. Wording rule: masked/pseudonymized, never a
            // stronger claim (deterministic hashing is reversible by a
            // salt-holder with a guess list).
            const nMask = bldPiiCountForObject(_editingProfile?.piiPolicy, objName);
            return nMask ? `<span class="ds-config-badge ds-badge-masked" title="${nMask} ${esc(objName)} field(s) are masked at write time — pseudonymized hash or null, never the raw value. Configure via 🎭 in Fields &amp; mapping or Suggest PII masks.">${dsIcon('lock')}${nMask} masked</span>` : '';
          })()}
          ${!isRoot ? `<button class="ds-btn ds-btn-xs ds-btn-config ${cfOn ? 'ds-btn-config--active' : ''}" data-order-btn="${esc(pathKey)}" title="${esc(cfTitle)}">
            ${cfOn ? '⤴ Created before parent' : '⤵ Created after parent'}
          </button>` : ''}
          <button class="ds-btn ds-btn-xs ds-btn-config ${node.includeFiles ? 'ds-btn-config--active' : ''}" data-files-btn="${esc(pathKey)}"
            title="${node.includeFiles
    ? 'Files ON: after these records land, their attached Files (latest version each) are copied and linked to the new records. Idempotent — a re-run skips files the target record already holds (same checksum). Files over ~35MB are skipped with a note; with a PII policy active, files are skipped entirely (bodies can’t be masked). Click to turn off.'
    : 'Also copy each record’s attached Files (Salesforce Files / ContentVersion, latest version each) and link them to the new records in the target. Click to turn on.'}">
            📎 Files${node.includeFiles ? ' ✓' : ''}
          </button>
        </div>${warnHtml}${renderLookupSection(node, pathKey)}`;
        })() : ''}
        ${childrenHtml}
        ${addChildSection}
      </div>
    </div>`;
}

// ── SOQL Preview ──────────────────────────────────────────────
// Mirrors what the run engine (executeProfileTransfer) actually sends to the
// SOURCE org: ONE query per tree node — the root filtered by your picks /
// WHERE, each child filtered by its parent-link field against the parent
// records fetched above it (the engine chunks those Ids 200 per query).
//
// This pane used to render a single nested relationship query whose WHERE
// clauses were walls of raw record Ids — right under the Lookup-resolution
// match-field pickers, it read exactly like "records are matched across orgs
// by Id". They never are: those Ids identify the picked records in the
// SOURCE org only; cross-org lookups resolve via the match fields, and
// upsert matches on the External ID field. The pane now says so.
function buildRunSOQL(node, parentObj, parentField) {
  if (!node) return '';
  const objName = node.objectType || node.childSObject || '?';

  // SELECT — the engine copies every createable field from the source
  // describe (honouring your Fields & mapping choices), not a typed list.
  const mapped = Object.keys(node.fieldMappings || {}).length;
  const selectTok = `<span class="ds-soql-note">⟨all copyable fields${mapped ? ` · ${mapped} mapped` : ''}⟩</span>`;

  // WHERE — picked records beat the free-form filter (engine rule), and a
  // child is ALWAYS additionally scoped to its parent's records. No raw Id
  // walls: they carry no information a count doesn't, and they mislead.
  const parts = [];
  if (node.recordIds?.length) {
    parts.push(`<span class="ds-soql-fld">Id</span> <span class="ds-soql-kw">IN</span> <span class="ds-soql-note">⟨the ${node.recordIds.length} record(s) you picked⟩</span>`);
  } else if ((node.where || '').trim()) {
    parts.push(`<span class="ds-soql-val">${esc(node.where.trim())}</span>`);
  }
  if (parentField && parentObj) {
    parts.push(`<span class="ds-soql-fld">${esc(parentField)}</span> <span class="ds-soql-kw">IN</span> <span class="ds-soql-note">⟨the ${esc(parentObj)} Ids fetched above — 200 per query⟩</span>`);
  }
  const whereHtml = parts.length
    ? `\n<span class="ds-soql-kw">WHERE</span> ${parts.join(' <span class="ds-soql-kw">AND</span> ')}`
    : '';

  // A child with no parent-link field runs unscoped — mirror the engine
  // instead of inventing a scope it won't apply.
  const label = parentField && parentObj
    ? `${esc(objName)} — separate query, scoped to the ${esc(parentObj)} records above`
    : `${esc(objName)} — fetched from the source org`;

  const block = `<div class="ds-soql-sep">${label}</div><pre class="ds-soql-code"><span class="ds-soql-kw">SELECT</span> ${selectTok}\n<span class="ds-soql-kw">FROM</span> <span class="ds-soql-obj">${esc(objName)}</span>${whereHtml}</pre>`;

  const childBlocks = (node.children || [])
    .filter(c => c.childSObject || c.objectType)
    .map(c => buildRunSOQL(c, c.field ? objName : null, c.field || null))
    .join('');
  return block + childBlocks;
}

function refreshSOQLPreview() {
  const pane = eid('dsSOQLPane');
  if (!pane || !_editingProfile?.tree) return;
  pane.innerHTML = `
    <div class="ds-soql-pane-header">
      <span class="ds-soql-pane-title">📋 SOQL Preview</span>
      <span class="ds-soql-pane-note">How records are read from the source org</span>
    </div>
    <div class="ds-soql-pane-body">
      ${buildRunSOQL(_editingProfile.tree, null, null)}
    </div>
    <div class="ds-soql-foot">Picked records are fetched by their <strong>source-org Ids</strong> — Ids are never used to match or write across orgs. Cross-org lookups resolve via your <strong>Lookup resolution</strong> match fields; Upsert matches on your <strong>External ID</strong> field.</div>`;
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

  // Collapsed-state chips (🎯 N · ⤴) — click expands so the config row the
  // chip stands in for is one click away.
  area.querySelectorAll('[data-expand-chip]').forEach(btn => {
    btn.addEventListener('click', () => {
      const node = getNodeByPath(_editingProfile.tree, btn.dataset.expandChip);
      if (node) { node._meta.expanded = true; refreshTree(); }
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

  // Field mapping. The modal (studio-builder-modals.js) owns mapping state;
  // the PII mask treatment is PROFILE state (piiPolicy), layered onto the
  // modal's rows from here once the modal's async open settles — see
  // bldPiiDecorateMappingModal for how it survives the modal's re-renders.
  area.querySelectorAll('[data-map-btn]').forEach(btn => {
    btn.addEventListener('click', () =>
      openFieldMappingModal(btn.dataset.mapBtn)
        .then(() => bldPiiDecorateMappingModal(btn.dataset.mapBtn)));
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

  // 📎 Files toggle (W9) — per-node flag the engine's files pass reads.
  area.querySelectorAll('[data-files-btn]').forEach(btn => {
    btn.addEventListener('click', () => {
      const node = getNodeByPath(_editingProfile.tree, btn.dataset.filesBtn);
      if (!node) return;
      if (node.includeFiles) delete node.includeFiles;
      else node.includeFiles = true;
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

  // 🔍 compare parents (user 2026-08-10: "we dont offer it here… when
  // selecting the root") — the parents are VISIBLE right here the moment a
  // root is picked, so the alignment check lives here too. Scans the parent
  // object across the pair and reports in a MODAL (never navigates away —
  // the Builder holds unsaved in-memory edits); the modal's CTA opens the
  // full Reconcile for a conscious jump.
  area.querySelectorAll('[data-lkp-parentcmp]').forEach(btn => {
    btn.addEventListener('click', () => bldCompareParent(btn.dataset.lkpParentcmp, btn));
  });
  sftkBldFillParentSync();
  sftkBldSuggestExtIds();

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
  // The header's "N objects in the tree" chip is rendered once by
  // renderBuilder; every mutation (add child, remove node, set root) funnels
  // through here — repaint it here too, or bldTreeNodeCount's guarantee
  // ("the number in the header can never disagree with the tree under it")
  // is a lie between mutation and the next full re-render.
  const chip = document.querySelector('.ds-vh-count');
  if (chip && _editingProfile?.tree) {
    const n = bldTreeNodeCount(_editingProfile.tree);
    chip.textContent = `${n} object${n !== 1 ? 's' : ''} in the tree`;
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

// ════════════════════════════════════════════════════════════════
// E1 — DEPLOYMENT PROFILE EXPORT / IMPORT (team shareability)
// ════════════════════════════════════════════════════════════════
// Profiles are CONFIG (orgs, tree, mappings, owner rules — shareable) plus
// accumulated RUNTIME state (scan results, learned record pairs — machine-
// and session-scoped). Only config may travel: shipping runtime state would
// render another user's card chips and scan badges as if THEY had scanned.
// Pure helpers live at column 0 so test/ent-profile-io.test.mjs can
// materialize them via test/extract.mjs.

// The profile-level fields that never leave the machine. A function rather
// than a const so test extraction stays self-contained (extract.mjs only
// slices top-level functions).
function bldProfileRuntimeFields() {
  return [
    'lastScan',      // diff-scan buckets vs ONE target at ONE time on the exporter's machine — stale + record ids
    'matchMemory',   // learned {srcId→tgtId} pairs per target org — machine-learned state, not config
    'ringScans',     // per-target ring scan summaries — the exporter's scan status, not the importer's
    'schedule',      // legacy schedule — its alarms live in the exporter's browser only; the chip would lie here
    'ephemeral',     // internal flag for unsaved org-compare/ring clones — never meaningful in a file
    'importedFrom',  // provenance of a PREVIOUS import on the exporter's machine — each import mints its own
    'piiSalt'        // MACHINE-LOCAL pseudonymization salt (sftk-pii.js contract): export strips it, import
                     // mints a fresh one — masked values differ per machine BY DESIGN. piiPolicy itself is
                     // config and travels.
  ];
}

// Deep-clone a profile and drop everything runtime/machine-local: the fields
// above plus per-node `_meta` (session describe/UI cache the builder attaches
// at edit time). Org URLs, the tree, field mappings (incl. per-target
// fieldMappingOverrides), owner mapping, matching config and picked recordIds
// are CONFIG and stay — they mean the same thing on a teammate's machine
// pointed at the same orgs. Pure.
function bldProfileStrip(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const clean = JSON.parse(JSON.stringify(profile));
  for (const f of bldProfileRuntimeFields()) delete clean[f];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    delete node._meta;
    // W2 — per-record lookup overrides hold org-local TARGET record ids
    // keyed by org identity: meaningless (and misleading) on a teammate's
    // machine. Config they should rebuild against their own orgs.
    delete node.lookupOverrides;
    (Array.isArray(node.children) ? node.children : []).forEach(walk);
  })(clean.tree);
  return clean;
}

// The downloadable payload. `schema` is the FILE format version — bump it on
// any incompatible shape change so older Toolkits can refuse newer files by
// name instead of half-importing them. `exportedBy` records the extension
// version that wrote the file (chrome.runtime.getManifest().version) so a
// refusal can name both sides. Pure.
function bldProfileExportPayload(profile, version) {
  return {
    format: 'sftk-profile',
    schema: 1,
    exportedBy: String(version || 'unknown'),
    exportedAt: new Date().toISOString(),
    profile: bldProfileStrip(profile)
  };
}

// Parse + validate an imported profile file. Returns { profile, stripped }
// on success or { error } with a SPECIFIC reason — never a half-import.
//   • unknown NEWER schema → refusal naming the file's schema AND ours
//   • the file's id is NEVER reused: ids key history, match memory and
//     schedule lookups, and re-importing your own export next to the
//     original must not collide (existingIds guards the regeneration)
//   • runtime fields present in a hand-edited file are stripped again and
//     REPORTED in `stripped` so the UI can say so instead of silently eating
//   • targetOrgs semantics survive: null / absent = follow-the-ring
//     (profileFollowsRing checks !Array.isArray), an array = pinned set
//   • provenance (importedFrom) is minted fresh — shown on the card
// Pure (needs bldProfileRuntimeFields + bldProfileStrip in scope).
function bldProfileImportParse(text, existingIds, fileName) {
  let payload;
  try {
    payload = JSON.parse(String(text));
  } catch (e) {
    return { error: `not valid JSON (${e && e.message ? e.message : 'parse error'}) — the file may be truncated or not a profile export` };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: 'not a profile export — expected a JSON object with format "sftk-profile"' };
  }
  if (payload.format !== 'sftk-profile') {
    return { error: `not a Toolkit profile export — the file says format ${payload.format === undefined ? '(none)' : JSON.stringify(payload.format)}, expected "sftk-profile"` };
  }
  if (!Number.isInteger(payload.schema) || payload.schema < 1) {
    return { error: 'the file has no valid schema number — it may be corrupted or hand-edited' };
  }
  if (payload.schema > 1) {
    const by = typeof payload.exportedBy === 'string' && payload.exportedBy ? ` (Toolkit v${payload.exportedBy})` : '';
    return { error: `this file is profile schema ${payload.schema}, written by a newer Toolkit${by}; this Toolkit reads schema 1 — update the extension and retry. Nothing was imported` };
  }
  const raw = payload.profile;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'the file contains no profile object — it may be truncated' };
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    return { error: 'the exported profile has no name — the file may be truncated or hand-edited' };
  }
  if (raw.tree !== null && raw.tree !== undefined && (typeof raw.tree !== 'object' || Array.isArray(raw.tree))) {
    return { error: 'the exported profile’s object tree is malformed — the file may be truncated or hand-edited' };
  }
  const stripped = bldProfileRuntimeFields().filter(f => raw[f] !== undefined && raw[f] !== null);
  const profile = bldProfileStrip(raw);
  const taken = new Set(Array.isArray(existingIds) ? existingIds : []);
  let id;
  do { id = `prof_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; } while (taken.has(id));
  profile.id = id;
  const now = new Date().toISOString();
  profile.importedFrom = {
    fileName: (typeof fileName === 'string' && fileName.trim()) ? fileName.trim() : null,
    exportedBy: typeof payload.exportedBy === 'string' ? payload.exportedBy : null,
    exportedAt: typeof payload.exportedAt === 'string' ? payload.exportedAt : null,
    importedAt: now
  };
  if (!profile.createdAt) profile.createdAt = now;
  profile.updatedAt = now;
  return { profile, stripped };
}

// ── E1 UI: per-card ⬇ Export + ⬆ Import (called from the profiles list) ──
window.exportProfile = function (profileId) {
  const p = _profiles.find(x => x.id === profileId);
  if (!p) return;
  let version = '';
  try { version = chrome?.runtime?.getManifest?.()?.version || ''; } catch (_) { /* non-extension context */ }
  const payload = bldProfileExportPayload(p, version);
  const slug = String(p.name || 'profile').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'profile';
  const fname = `sftk-profile-${slug}-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fname;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  const nMaskRules = p.piiPolicy && typeof p.piiPolicy === 'object' ? Object.keys(p.piiPolicy).length : 0;
  showToast(`Exported “${p.name}” — config only (orgs, tree, mappings, owner rules). Scan state and learned matches are machine-local and stay here.${nMaskRules ? ` ${nMaskRules} PII mask rule(s) travelled; the pseudonymization salt did NOT — it never leaves this machine.` : ''}`, 'success', nMaskRules ? 7000 : 5500);
};

window.importProfileFromFile = function () {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,application/json';
  inp.style.display = 'none';
  inp.addEventListener('cancel', () => inp.remove());
  inp.addEventListener('change', async () => {
    const file = inp.files && inp.files[0];
    inp.remove();
    if (!file) return;
    let text;
    try { text = await file.text(); }
    catch (e) { showToast(`Couldn't read ${file.name}: ${e?.message || e}`, 'error', 6000); return; }
    const res = bldProfileImportParse(text, _profiles.map(p => p.id), file.name);
    if (res.error) { showToast(`Import failed: ${res.error}.`, 'error', 9000); return; }
    const prof = res.profile;
    // piiPolicy travels; the salt NEVER does (machine-local by the sftk-pii
    // contract — the parse strip list already dropped any smuggled one).
    // Mint this machine's salt BEFORE saving so the first masked run can't
    // race an absent salt.
    const nMaskRules = prof.piiPolicy && typeof prof.piiPolicy === 'object' ? Object.keys(prof.piiPolicy).length : 0;
    if (nMaskRules) bldPiiEnsureSalt(prof);
    _profiles.push(prof);
    await storageSaveProfiles();
    if (_currentView === 'profiles') renderProfiles();
    // The file was written against the EXPORTER's orgs and ring. Say plainly
    // that nothing has been validated against this machine's targets, and
    // offer the existing schema-gap check right here — an import is exactly
    // the "which org will this break in?" moment.
    const tgtDesc = Array.isArray(prof.targetOrgs)
      ? `${prof.targetOrgs.length} pinned target(s)`
      : 'targets follow YOUR Sync Ring';
    showModal(`
      <div class="ds-modal-header">⬆ Imported “${esc(prof.name)}”</div>
      <div class="ds-modal-body" style="font-size:12.5px">
        <div style="margin-bottom:8px">Source: <strong>${esc(prof.sourceOrg ? orgLabel(prof.sourceOrg) : '— not set —')}</strong> · ${esc(tgtDesc)}.</div>
        ${nMaskRules ? `<div style="color:var(--subtext);margin-bottom:8px">${dsIcon('lock')} ${nMaskRules} PII masking rule(s) travelled with the profile. The pseudonymization salt is machine-local and is never imported — a fresh one was generated here, so masked values on this machine will differ from the exporter's.</div>` : ''}
        ${res.stripped.length ? `<div style="color:var(--subtext);margin-bottom:8px">Machine-local state in the file was not imported (it belongs to the exporter's machine): ${esc(res.stripped.join(', '))}.</div>` : ''}
        <div style="color:var(--subtext)">This file was written against the exporter's orgs and Sync Ring — nothing has been validated against <em>your</em> targets yet.${prof.tree ? ' Run the schema check to see which of your orgs it would break in.' : ' It has no object tree yet — open ✏ Edit to build one.'}</div>
      </div>
      <div class="ds-modal-footer">
        <button class="ds-btn" data-dsaction="closeModal">Later</button>
        ${prof.tree ? `<button class="ds-btn ds-btn-primary" id="dsImpCheckTargets" title="Verify every object and mapped field in the imported tree exists in each of YOUR targets">🧪 Check all targets</button>` : ''}
      </div>`);
    eid('dsImpCheckTargets')?.addEventListener('click', () => _bldCheckAllTargets(prof));
  });
  document.body.appendChild(inp);
  inp.click();
};

// ════════════════════════════════════════════════════════════════
// PII MASKING v1 — builder UI for profile.piiPolicy
// ════════════════════════════════════════════════════════════════
// The policy ({ "<ObjectApi>.<FieldApi>": { strategy, value? } }, SOURCE API
// names) and salt live on the PROFILE; the engine (sftk-pii.js and its
// background.js copies) is the one masking implementation. This section only
// edits the policy and keeps three surfaces honest about it: the Fields &
// mapping modal (🎭 per-field treatment + 🔒 lock), the tree config row
// ("N masked" chip) and the Suggest-PII modal. WORDING CONTRACT everywhere:
// masked / pseudonymized — deterministic hashing is reversible by anyone
// holding the salt and a guess list, so no copy may claim more.
// Pure helpers sit at column 0 for test/pii-ui.test.mjs (test/extract.mjs).

// The rule covering one field, or null. Object/field parts compare
// case-INSENSITIVELY — the engine (sftkPiiRulesForObject) folds case, so a
// hand-edited or imported policy key cased differently would otherwise mask
// at write time while the UI shows the field as unmasked (review finding).
function bldPiiRuleFor(policy, objectApi, fieldApi) {
  if (!policy || typeof policy !== 'object' || !objectApi || !fieldApi) return null;
  const want = (objectApi + '.' + fieldApi).toLowerCase();
  for (const [k, r] of Object.entries(policy)) {
    if (r && typeof r === 'object' && k.toLowerCase() === want) return r;
  }
  return null;
}

// How many policy entries cover this object — the tree chip's number.
// Case-insensitive prefix; the dot boundary keeps "Contact." from swallowing
// ContactPointEmail keys, and empty/null rule entries don't count.
function bldPiiCountForObject(policy, objectApi) {
  if (!policy || typeof policy !== 'object' || !objectApi) return 0;
  const prefix = (objectApi + '.').toLowerCase();
  return Object.keys(policy).filter(k => policy[k] && k.toLowerCase().startsWith(prefix)).length;
}

// Toggle the hash rule for one field → 'added' | 'removed'. Creates
// profile.piiPolicy on first add and deletes it again when the last rule
// goes, so a profile that never masked exports without an empty stub.
// Removal matches case-insensitively (same folding as the engine) so a
// differently-cased imported key can't survive an untick AND get duplicated
// by the next tick. Salt lifecycle is the CALLER's job (bldPiiEnsureSalt on
// 'added') — kept out so this stays crypto-free and extractable.
function bldPiiToggleHashRule(profile, objectApi, fieldApi) {
  const key = objectApi + '.' + fieldApi;
  const policy = (profile.piiPolicy && typeof profile.piiPolicy === 'object') ? profile.piiPolicy : null;
  const existing = policy
    ? Object.keys(policy).filter(k => policy[k] && k.toLowerCase() === key.toLowerCase())
    : [];
  if (existing.length) {
    for (const k of existing) delete policy[k];
    if (!Object.keys(policy).length) delete profile.piiPolicy;
    return 'removed';
  }
  (profile.piiPolicy = policy || {})[key] = { strategy: 'hash' };
  return 'added';
}

// Bulk-apply hash rules for "<Object>.<Field>" keys (the Suggest modal's
// Apply). Existing rules are never overwritten — a hand-tuned 'fixed' or
// 'null' rule must survive a re-run of Suggest. Returns the number of NEW
// rules only, because the disclosure toast counts what this click changed.
function bldPiiApplyHashRules(profile, keys) {
  if (!profile || typeof profile !== 'object' || !Array.isArray(keys)) return 0;
  let added = 0;
  for (const key of keys) {
    if (typeof key !== 'string' || key.indexOf('.') < 1) continue;
    const policy = (profile.piiPolicy && typeof profile.piiPolicy === 'object')
      ? profile.piiPolicy : (profile.piiPolicy = {});
    if (policy[key]) continue;
    policy[key] = { strategy: 'hash' };
    added++;
  }
  return added;
}

// profile.piiSalt — MACHINE-LOCAL by contract (export strips it, import
// regenerates): 16 crypto.getRandomValues bytes as 32 hex chars, minted
// lazily when the first rule lands. An existing salt is NEVER rotated here:
// rotation changes every masked value and breaks re-seed idempotence.
function bldPiiEnsureSalt(profile) {
  if (!profile || typeof profile !== 'object') return null;
  if (typeof profile.piiSalt === 'string' && profile.piiSalt.length) return profile.piiSalt;
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  profile.piiSalt = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return profile.piiSalt;
}

// What the 🎭 control may honestly claim for one describe type.
// Maskable types (sftkPiiMaskable's set) hash to a same-shaped string; every
// other type under a hash rule is NULLED by the engine (counted, never raw) —
// so the control disables there and says that consequence out loud instead of
// implying a pretty masked value. An EXISTING rule stays clickable regardless
// of type: the user must always be able to remove it.
function bldPiiMaskTitle(fieldType, active) {
  const maskable = sftkPiiMaskable({ type: fieldType });
  if (active) {
    return { enabled: true, title: maskable
      ? 'Masked at write time: replaced by a deterministic pseudonymized value — the same source value always masks to the same output, so joins and match keys survive. Click to remove the mask rule.'
      : `Masked at write time: ${fieldType || 'this'} values can't be re-rendered from a hash, so this rule writes NULL (the run summary counts it as nulled). Click to remove the mask rule.` };
  }
  if (!maskable) {
    return { enabled: false, title: `Hash-masking can't produce a valid ${fieldType || 'value of this type'} — a mask rule here would write NULL at deploy time (counted, never the raw value). Use ✕ to exclude the field from the transfer instead.` };
  }
  return { enabled: true, title: 'Mask this field at write time — the value is replaced by a deterministic pseudonymized rendering (hash); the raw value is never written to the target. Click to add the rule.' };
}

// ── 🎭 in the Fields & mapping modal ──────────────────────────────
// The modal (studio-builder-modals.js) re-renders its row list from local
// state on every filter/org/skip/auto-map interaction, and replaces the whole
// modal box on Clear. The mask treatment is PROFILE state, not mapping state,
// so it is layered on from here with the two mechanisms that survive both:
// a delegated click listener and a childList observer on the persistent
// #dsModalBox element (showModal swaps its innerHTML, never the box itself).
let _bldPiiModalCtx = null;        // { node, objType } while a mapping modal is decorated
let _bldPiiModalObserver = null;   // lazy singleton — no-ops whenever #dsFmList is absent

function bldPiiDecorateMappingModal(pathStr) {
  const node = getNodeByPath(_editingProfile?.tree, pathStr);
  const objType = node ? (node.objectType || node.childSObject || '') : '';
  if (!node || !objType) return;
  _bldPiiModalCtx = { node, objType };
  const box = eid('dsModalBox');
  if (box && !_bldPiiModalObserver) {
    box.addEventListener('click', bldPiiMaskBtnClick);
    _bldPiiModalObserver = new MutationObserver(() => bldPiiDecorateRows());
    // childList only: bldPiiDecorateRows' own attribute/class syncs must not
    // re-trigger it; its node insertions do, and its second pass inserts
    // nothing, which terminates the loop.
    _bldPiiModalObserver.observe(box, { childList: true, subtree: true });
  }
  bldPiiDecorateRows();
}

function bldPiiDecorateRows() {
  const ctx = _bldPiiModalCtx;
  const list = eid('dsFmList');
  if (!ctx || !list) return;   // some other modal is up — nothing to decorate
  const typeByField = {};
  for (const f of (ctx.node._meta?.availableFields || [])) typeByField[f.name] = f.type;
  list.querySelectorAll('.ds-fm-row').forEach(row => {
    const skipBtn = row.querySelector('.ds-fm-skip-btn');
    const field = skipBtn ? skipBtn.dataset.skip : '';
    if (!field) return;
    const active = !!bldPiiRuleFor(_editingProfile?.piiPolicy, ctx.objType, field);
    const wrap = row.querySelector('.ds-fm-tgt-wrap');
    let btn = row.querySelector('.ds-fm-mask-btn');
    if (!btn && wrap) {
      btn = document.createElement('button');
      btn.className = 'ds-fm-mask-btn';
      btn.dataset.mask = field;
      btn.textContent = '🎭';
      wrap.appendChild(btn);   // CSS order:99 pins it visually last in the cell
    }
    if (!btn) return;
    const t = bldPiiMaskTitle(typeByField[field], active);
    btn.disabled = !t.enabled;
    btn.title = t.title;
    btn.classList.toggle('ds-fm-mask-on', active);
    row.classList.toggle('ds-fm-row-masked', active);
    // 🔒 on the source cell — the policy must be visible without hovering the
    // control (the lock indicator the mapping modal owes the user).
    const meta = row.querySelector('.ds-fm-src-meta');
    const lockEl = meta ? meta.querySelector('.ds-fm-mask-lock') : null;
    if (active && meta && !lockEl) {
      const lock = document.createElement('span');
      lock.className = 'ds-fm-mask-lock';
      lock.title = `${ctx.objType}.${field} is masked at write time (pseudonymized or nulled — never the raw value)`;
      lock.innerHTML = dsIcon('lock');
      meta.appendChild(lock);
    } else if (!active && lockEl) {
      lockEl.remove();
    }
  });
}

function bldPiiMaskBtnClick(e) {
  const btn = e.target && e.target.closest ? e.target.closest('.ds-fm-mask-btn') : null;
  if (!btn || btn.disabled) return;
  const ctx = _bldPiiModalCtx;
  if (!ctx || !_editingProfile) return;
  const field = btn.dataset.mask;
  const res = bldPiiToggleHashRule(_editingProfile, ctx.objType, field);
  if (res === 'added') {
    // First rule mints the machine-local salt — every masked write needs it.
    bldPiiEnsureSalt(_editingProfile);
    showToast(`${ctx.objType}.${field} will be masked (pseudonymized) at write time — deterministic hash, never the raw value.`, 'info', 4500);
  } else {
    showToast(`Mask rule removed — ${ctx.objType}.${field} will be written unmasked.`, 'warning', 4500);
  }
  bldPiiDecorateRows();
  refreshTree();   // repaint the "N masked" chips behind the modal
}

// ── Suggest PII masks — candidates across the whole tree ─────────
async function bldOpenPiiSuggestModal() {
  const p = _editingProfile;
  if (!p?.tree) return;
  const objs = [...collectTreeObjects(p.tree)];
  showModal(`<div class="ds-modal-header">🎭 Suggest PII masks</div>
    <div class="ds-modal-body" style="text-align:center;padding:40px;color:var(--subtext)">
      ${window.sftkCatSm ? sftkCatSm(`Scanning ${objs.length} object(s) for likely PII…`) : 'Scanning…'}
    </div>`);
  const sess = _builderSession();
  const sections = [];
  let anyCompliance = false;
  for (const obj of objs) {
    // Describe cache is shared with the mapping UI — objects the builder has
    // touched cost nothing here.
    const d = await describe(obj);
    if (!d || !Array.isArray(d.fields)) {
      sections.push({ obj, error: 'describe unavailable — no suggestions for this object' });
      continue;
    }
    // Compliance classification is optional — many orgs never filled it in.
    // A failed query degrades to name/type heuristics, said out loud below.
    const complianceByField = {};
    if (sess.orgUrl && sess.sid) {
      const q = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid,
        query: `SELECT QualifiedApiName, ComplianceGroup, SecurityClassification FROM FieldDefinition WHERE EntityDefinitionId = ${soqlStrLit(obj)}` });
      if (!q?.error && Array.isArray(q.records)) {
        for (const r of q.records) {
          if (r.QualifiedApiName && r.ComplianceGroup) complianceByField[r.QualifiedApiName] = r.ComplianceGroup;
        }
      }
    }
    if (Object.keys(complianceByField).length) anyCompliance = true;
    const typeByField = {};
    for (const f of d.fields) typeByField[f.name] = f.type;
    sections.push({ obj, sugg: sftkPiiSuggest(obj, d.fields, complianceByField), typeByField });
  }

  const secHtml = sections.map(sec => {
    if (sec.error) return `<div class="ds-pii-sug-obj"><div class="ds-pii-sug-obj-hd">${esc(sec.obj)}</div><div class="ds-pii-sug-empty">⚠ ${esc(sec.error)}</div></div>`;
    if (!sec.sugg.length) return `<div class="ds-pii-sug-obj"><div class="ds-pii-sug-obj-hd">${esc(sec.obj)}</div><div class="ds-pii-sug-empty">no likely-PII fields found</div></div>`;
    return `<div class="ds-pii-sug-obj">
      <div class="ds-pii-sug-obj-hd">${esc(sec.obj)} <span class="ds-pii-sug-count">${sec.sugg.length} candidate(s)</span></div>
      ${sec.sugg.map(s => {
        const covered = !!bldPiiRuleFor(p.piiPolicy, sec.obj, s.field);
        const ftype = sec.typeByField[s.field];
        const maskable = sftkPiiMaskable({ type: ftype });
        return `<label class="ds-pii-sug-row${covered ? ' ds-pii-sug-covered' : ''}">
          <input type="checkbox" data-pii-key="${esc(sec.obj + '.' + s.field)}" ${covered ? 'checked disabled' : (s.sure ? 'checked' : '')}>
          <span class="ds-pii-sug-field"><strong>${esc(sec.obj)}</strong>.${esc(s.field)}</span>
          <span class="ds-pii-sug-type">${esc(ftype || '?')}</span>
          <span class="ds-pii-sug-reason">${esc(s.reason)}</span>
          ${covered ? '<span class="ds-pii-sug-note">already masked</span>'
            : (!maskable ? `<span class="ds-pii-sug-note ds-pii-sug-null" title="A hash can't be rendered as ${esc(ftype || 'this type')} — the engine writes NULL and counts it as nulled, never the raw value.">hash → NULL</span>` : '')}
        </label>`;
      }).join('')}
    </div>`;
  }).join('');

  showModal(`
    <div class="ds-modal-header">🎭 Suggest PII masks — ${esc(p.name)}</div>
    <div class="ds-modal-body ds-pii-sug-body">
      <div class="ds-pii-sug-honesty">Masking here is <strong>deterministic pseudonymization</strong>, not deletion: the same source value always yields the same masked value (that is what keeps joins, match keys and re-seeds working) — which also means anyone holding this machine's salt and a guess list can reverse it. Masked emails land on <code>masked.invalid</code>, a reserved domain that can never receive mail.</div>
      ${anyCompliance ? '' : `<div class="ds-pii-sug-note-line">This org has no compliance classification on these objects (FieldDefinition.ComplianceGroup is empty or unreadable) — suggestions below come from field types, names and labels only.</div>`}
      ${secHtml || '<div class="ds-picker-empty">No objects in the tree.</div>'}
    </div>
    <div class="ds-modal-footer">
      <span class="ds-pii-sug-legend">pre-checked = strong signal (field type, name field, label, or compliance group)</span>
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      <button class="ds-btn ds-btn-primary" id="dsPiiSugApply">✓ Mask checked fields</button>
    </div>`);

  eid('dsPiiSugApply')?.addEventListener('click', () => {
    const keys = [...document.querySelectorAll('#dsModalBox [data-pii-key]')]
      .filter(cb => cb.checked && !cb.disabled).map(cb => cb.dataset.piiKey);
    const added = bldPiiApplyHashRules(_editingProfile, keys);
    if (added) bldPiiEnsureSalt(_editingProfile);   // first rule mints the machine-local salt
    closeModal();
    refreshTree();   // paint the "N masked" chips
    showToast(added
      ? `${added} field(s) will be masked (pseudonymized) at write time — never the raw value. Save the profile to keep the rules.`
      : 'No new mask rules — everything checked was already covered.', added ? 'success' : 'info', 5500);
  });
}

