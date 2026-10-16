'use strict';
// ════════════════════════════════════════════════════════════════
// PROFILES LIST
// ════════════════════════════════════════════════════════════════
// Feature 1: Quick-start templates
const PROFILE_TEMPLATES = [
  {
    id: 'tpl_account_contacts',
    icon: '🏢',
    label: 'Account + Contacts',
    desc: 'Copy accounts with all related contacts',
    tree: {
      objectType: 'Account', where: '', children: [
        { childSObject: 'Contact', relationshipName: 'Contacts', field: 'AccountId', where: '', children: [] }
      ]
    }
  },
  {
    id: 'tpl_opp_lineitems',
    icon: '💰',
    label: 'Opportunity + Line Items',
    desc: 'Copy opportunities with product line items',
    tree: {
      objectType: 'Opportunity', where: '', children: [
        { childSObject: 'OpportunityLineItem', relationshipName: 'OpportunityLineItems', field: 'OpportunityId', where: '', children: [] }
      ]
    }
  },
  {
    id: 'tpl_case_comments',
    icon: '🎫',
    label: 'Case + Comments',
    desc: 'Copy cases with all case comments',
    tree: {
      objectType: 'Case', where: '', children: [
        { childSObject: 'CaseComment', relationshipName: 'CaseComments', field: 'ParentId', where: '', children: [] }
      ]
    }
  },
  {
    id: 'tpl_contact',
    icon: '👤',
    label: 'Contacts only',
    desc: 'Copy contacts as a flat list (no parents)',
    tree: { objectType: 'Contact', where: '', children: [] }
  },
];

function renderProfiles() {
  const hasProfiles = _profiles.length > 0;
  setMain(`
    ${dsViewHeader({
      icon: 'box',
      title: 'Data Deployment',
      subtitle: 'Define a deployment (objects + orgs), then 🚀 Deploy it',
      // _profiles is the exact array rendered as cards below — the count and
      // the list can never disagree.
      count: `${_profiles.length} profile${_profiles.length !== 1 ? 's' : ''}`,
      actions: `        <button class="ds-btn" id="dsImportProfile" title="Import a deployment profile from a teammate's exported .json file — config only; you'll be prompted to validate it against your own targets">${dsIcon('upload')}Import</button>
        <button class="ds-btn ds-btn-primary" id="dsNewProfile">${dsIcon('plus')}New Profile</button>`,
    })}

    <div class="ds-template-bar">
      <span class="ds-template-bar-label">Quick start:</span>
      ${PROFILE_TEMPLATES.map(t => `
        <button class="ds-btn ds-btn-xs ds-template-btn" data-tpl="${esc(t.id)}" title="${esc(t.desc)}">
          ${t.icon} ${esc(t.label)}
        </button>`).join('')}
    </div>

    ${!hasProfiles ? `
      <div class="ds-empty-page">
        <div class="ds-empty-icon">📦</div>
        <div class="ds-empty-title">No deployments yet</div>
        <div class="ds-empty-sub">A deployment profile defines which records to copy, which orgs to copy between, and how deep to follow relationships. Create one using a template above, or start from scratch.</div>
      </div>` : `
      <div class="ds-profile-list">
        ${_profiles.map(p => profileCard(p)).join('')}
      </div>`}

    ${typeof sequenceCard === 'function' ? `<div class="ds-seq-section">
      <div class="ds-seq-section-head">
        <div class="ds-view-title-wrap">
          <h3 class="ds-seq-section-title">🔗 Sequences</h3>
          <div class="ds-view-subtitle">Chain profiles to run in order, sharing record-Id mapping — so a later profile's lookups to records created by an earlier one are remapped automatically (e.g. CPQ price rules → lookup queries).</div>
        </div>
        <button class="ds-btn" id="dsNewSequence" ${hasProfiles ? '' : 'disabled title="Create at least one profile first"'}>+ New Sequence</button>
      </div>
      ${_sequences.length
        ? `<div class="ds-seq-list">${_sequences.map(s => sequenceCard(s)).join('')}</div>`
        : `<div class="ds-seq-empty">No sequences yet. Build a few profiles, then chain them here to deploy related data in dependency order.</div>`}
    </div>` : ''}
  `);

  eid('dsNewProfile')?.addEventListener('click', () => openProfileBuilder(null));
  // E1: profile file import/export — implementations live in studio-builder.js.
  eid('dsImportProfile')?.addEventListener('click', () => window.importProfileFromFile?.());
  document.querySelectorAll('[data-prof-export]').forEach(b =>
    b.addEventListener('click', () => window.exportProfile?.(b.dataset.profExport)));
  eid('dsNewSequence')?.addEventListener('click', () => openSequenceBuilder(null));
  document.querySelectorAll('[data-seq-run]').forEach(b =>
    b.addEventListener('click', () => runSequence(b.dataset.seqRun)));
  document.querySelectorAll('[data-seq-edit]').forEach(b =>
    b.addEventListener('click', () => openSequenceBuilder(_sequences.find(s => s.id === b.dataset.seqEdit) || null)));
  document.querySelectorAll('[data-seq-del]').forEach(b =>
    b.addEventListener('click', () => deleteSequence(b.dataset.seqDel)));

  // Wire template buttons
  document.querySelectorAll('[data-tpl]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tpl = PROFILE_TEMPLATES.find(t => t.id === btn.dataset.tpl);
      if (!tpl) return;
      const newProfile = {
        id:        genId('prof'),
        name:      tpl.label,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tree:      JSON.parse(JSON.stringify(tpl.tree)),
      };
      openProfileBuilder(newProfile);
    });
  });
}

function profileCard(p) {
  const nodeCount   = countTreeNodes(p.tree);
  const isScheduled = p.schedule?.enabled;
  const lastRun     = _history.filter(h => h.profileId === p.id).sort((a,b) => b.startedAt.localeCompare(a.startedAt))[0];

  const hasOrgs = !!(p.sourceOrg && p.targetOrg);
  // Last-used pair, shown plainly (campaign 4 phase 2, user 2026-10-01): the
  // Deploy page lets you pick any open orgs, so no crown / ring chip here.
  const orgRow  = hasOrgs
    ? `<div class="ds-profile-card-orgs" title="last used pair — pick any open orgs on the Deploy page">
         <span class="ds-profile-card-org">${esc(orgLabel(p.sourceOrg))}</span>
         <span class="ds-profile-card-org-arrow">→</span>
         <span class="ds-profile-card-org">${esc(orgLabel(p.targetOrg))}</span>
       </div>`
    : `<div class="ds-profile-card-orgs ds-profile-card-orgs-missing">
         ⚠ Source and target orgs not set — click ✏ Edit to configure
       </div>`;

  // Live diff summary — the user's "what's actually in each org?" answer.
  // Pulls from profile.lastScan (set by `runDiffScan`). Shows counts of
  // missing/drift/in-sync along with how stale the scan is. If no scan
  // has been run yet, shows a CTA encouraging the user to run one.
  // Treats the scan as stale (and hides the chips) if the user changed
  // the source or target org since the scan ran — wouldn't be honest
  // to show "5 missing" counts that were calculated against different orgs.
  const diff   = p.lastScan;
  const diffFresh = !!(
    diff && diff.status === 'success' &&
    (!diff.objectType || diff.objectType === (p.tree?.objectType || p.tree?.childSObject)) &&
    (!diff.sourceOrg || diff.sourceOrg === p.sourceOrg) &&
    (!diff.targetOrg || diff.targetOrg === p.targetOrg)
  );
  const diffRow = !hasOrgs ? '' : diffFresh
    ? `<div class="ds-profile-card-diff">
         <span class="ds-diff-chip ds-diff-missing" title="Records present in source but not in target — candidates to deploy">${diff.missingInTarget?.length || 0} missing</span>
         <span class="ds-diff-chip ds-diff-drift"   title="Records present in both orgs but with different values on tracked compare fields">${diff.changed?.length || 0} changed</span>
         <span class="ds-diff-chip ds-diff-sync"    title="Records that match between source and target on the configured match field + compare fields">${diff.identical?.length || 0} in sync</span>
         <span class="ds-diff-chip ds-diff-extra"   title="Records present in target but not in source — orphan records in target">${diff.onlyInTarget?.length || 0} only in target</span>
         <span class="ds-diff-stale" title="${esc(diff.runAt)}">scanned ${timeAgo(diff.runAt)}</span>
       </div>`
    : `<div class="ds-profile-card-diff ds-profile-card-diff-empty">
         <span class="ds-diff-empty-hint">${diff ? 'State is stale (orgs changed) — click 🔄 Refresh state' : 'No state captured yet — click 🔄 Refresh state to compare orgs'}</span>
       </div>`;

  return `
    <div class="ds-profile-card">
      <div class="ds-profile-card-header">
        <div class="ds-profile-card-name">${esc(p.name)}</div>
        <div class="ds-profile-card-chips">
          ${isScheduled ? `<span class="ds-chip ds-chip-sched">📅 scheduled</span>` : ''}
          <span class="ds-chip">${nodeCount} object${nodeCount!==1?'s':''}</span>
        </div>
      </div>
      ${orgRow}
      ${diffRow}
      <div class="ds-profile-card-tree">${treePreviewText(p.tree, 0)}</div>
      ${lastRun ? `<div class="ds-profile-card-meta">Last run: ${timeAgo(lastRun.startedAt)} · <span class="ds-run-status-${lastRun.status}">${lastRun.status}</span></div>` : ''}
      ${p.importedFrom ? `<div class="ds-profile-card-meta" title="Imported from a teammate's export file${p.importedFrom.exportedBy ? ` (written by Toolkit v${esc(p.importedFrom.exportedBy)})` : ''}${p.importedFrom.exportedAt ? `, exported ${esc(String(p.importedFrom.exportedAt).slice(0, 10))}` : ''}. Scan state was not part of the file — run 🔄 Refresh state to compare against your orgs.">⬆ imported from ${esc(p.importedFrom.fileName || 'file')} on ${esc(String(p.importedFrom.importedAt || '').slice(0, 10))}</div>` : ''}
      <div class="ds-profile-card-actions">
        <button class="ds-btn ds-btn-sm ds-btn-primary" data-dsaction="runProfile" data-arg="${p.id}"
          ${hasOrgs ? '' : 'disabled title="Set source and target orgs in Edit first"'}
          ${hasOrgs ? 'title="Open this deployment: see what is already in the target, select what to insert, overwrite, re-link or remove, then run. Nothing writes until you select it."' : ''}>🚀 Deploy</button>
        <button class="ds-btn ds-btn-sm" data-dsaction="refreshState" data-arg="${p.id}"
          ${hasOrgs ? '' : 'disabled title="Set source and target orgs first"'}
          title="MEASURE this pair: query both orgs and sort records into missing / changed / in sync by your match key. Writes nothing — 🚀 Deploy reads this measurement.">🔄 Refresh state</button>
        <button class="ds-btn ds-btn-sm" data-dsaction="editProfile" data-arg="${p.id}">✏ Edit</button>
        <button class="ds-btn ds-btn-sm" data-dsaction="cloneProfile" data-arg="${p.id}">⧉ Clone</button>
        <button class="ds-btn ds-btn-sm" data-prof-export="${esc(p.id)}"
          title="Export this profile as a .json file for teammates — config only (orgs, tree, mappings, owner rules); scan state and learned matches stay on this machine">⬇ Export</button>
        <button class="ds-btn ds-btn-sm ds-btn-danger" data-dsaction="deleteProfile" data-arg="${p.id}">🗑</button>
      </div>
    </div>`;
}

function treePreviewText(node, depth) {
  if (!node) return '';
  const pad   = '&nbsp;'.repeat(depth * 4);
  const icon  = depth === 0 ? '📂' : '↳';
  const name  = node.objectType || node.childSObject || '?';
  const where = node.recordIds?.length
    ? `<span class="ds-tree-preview-where">🎯 ${node.recordIds.length} records</span>`
    : node.where ? `<span class="ds-tree-preview-where">WHERE ${esc(node.where)}</span>` : '';
  const fields = node.fields?.length
    ? `<span class="ds-tree-preview-where">🔲 ${node.fields.length} fields</span>` : '';
  const order = node.insertOrder === 'childFirst'
    ? `<span class="ds-tree-preview-where">⤴ child-first</span>` : '';
  const children = (node.children || []).map(c => treePreviewText(c, depth + 1)).join('');
  return `<div class="ds-tree-preview-row">${pad}${icon} <strong>${esc(name)}</strong> ${where}${fields}${order}</div>${children}`;
}

function countTreeNodes(node) {
  if (!node) return 0;
  return 1 + (node.children || []).reduce((n, c) => n + countTreeNodes(c), 0);
}

// Depth-first search for the first tree node matching an object API name
// (root uses objectType, children use childSObject). Used to find a node's
// per-lookup resolution config when comparing drift for that object.
function _findTreeNode(node, objType) {
  if (!node) return null;
  if ((node.objectType || node.childSObject) === objType) return node;
  for (const c of (node.children || [])) {
    const hit = _findTreeNode(c, objType);
    if (hit) return hit;
  }
  return null;
}

window.runProfile = function(profileId, targetUrl) {
  const p = _profiles.find(x => x.id === profileId) || null;
  // ONE target per run (user 2026-09-14: "you do it one by one"). A
  // deployment whose ring has several targets asks which one this run is
  // for — the same question ⚖ Transfer asks — and never fans out.
  const _tgts = p ? profileTargets(p) : [];
  if (p && _tgts.length > 1 && !targetUrl) {
    sftkDialog({
      title: `🚀 Deploy — pick the target`,
      sev: 'neutral',
      bodyHtml: `
        <div style="margin-bottom:8px">A run writes to <strong>one target</strong> at a time. ${esc(orgLabel(p.sourceOrg))} deploys to ${_tgts.length} targets — which one is this run for?</div>
        ${_tgts.map(u => `<button class="ds-btn" style="display:flex;width:100%;margin:4px 0;justify-content:space-between;align-items:center" data-run-target="${esc(u)}">
            <span>${esc(orgLabel(u))} ${prodBadge(u)}</span></button>`).join('')}
      `,
      actions: [{ label: `Cancel`, kind: 'secondary', attrs: 'data-dsaction="closeModal"' }],
    });
    document.querySelectorAll('[data-run-target]').forEach(b =>
      b.addEventListener('click', () => { closeModal(); window.runProfile(profileId, b.dataset.runTarget); }));
    return;
  }
  _transferProfile = p;
  // fresh launch → the profile's source; the picked target, or its first one
  _transferOrgOverride = { src: null, tgt: (p && targetUrl && _orgKey(targetUrl) !== _orgKey(p.targetOrg || '')) ? targetUrl : null };
  // Stay on the "Data Deployment" nav item — the Run view is conceptually a
  // sub-page of the deployment page, not a separate top-level destination.
  document.querySelectorAll('.ds-nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-view="profiles"]')?.classList.add('active');
  _currentView = 'profiles';
  renderTransfer();
};

window.editProfile = function(profileId) {
  openProfileBuilder(_profiles.find(p => p.id === profileId) || null);
};

// History "↻ Run again" — relaunch a past run's profile against the SAME org
// pair that run used (which may have been a run-time override of the
// profile's own pair). Run-time filters are NOT restored — the user is
// re-running the deployment, not replaying a retry subset.
window.runAgain = function(runId) {
  const run = _history.find(h => h.id === runId);
  if (!run?.profileId) return;
  const prof = _profiles.find(p => p.id === run.profileId);
  if (!prof) return showToast('That deployment no longer exists — cannot re-run.', 'error', 4000);
  if (typeof sftkDeployViewOn === 'function' && sftkDeployViewOn()) {
    const runSrc = run.sourceOrg || run.srcOrgUrl, runTgt = run.targetOrg || run.tgtOrgUrl;
    if (runSrc && _orgKey(runSrc) !== _orgKey(prof.sourceOrg || '')) showToast(`That run read from ${orgLabel(runSrc)}; this deployment reads from ${orgLabel(prof.sourceOrg)} now — opening it as it is today.`, 'info', 7000);
    return window.openReconcile?.(prof.id, runTgt || undefined);
  }
  _transferProfile     = prof;
  _transferNodeFilters = {};
  _transferOrgOverride = {
    src: run.sourceOrg && _orgKey(run.sourceOrg) !== _orgKey(prof.sourceOrg) ? run.sourceOrg : null,
    tgt: run.targetOrg && _orgKey(run.targetOrg) !== _orgKey(prof.targetOrg) ? run.targetOrg : null
  };
  document.querySelectorAll('.ds-nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-view="profiles"]')?.classList.add('active');
  _currentView = 'profiles';
  renderTransfer();
};

// Org row "🔍 Compare with…" — seed Org Compare's source with this org and
// navigate there; the user picks the other side. Clears stale results if the
// source actually changed so old rows can't be mistaken for the new pair.
window.compareOrgFrom = function(orgUrl) {
  if (_orgCompareState.srcOrgUrl !== orgUrl) {
    _orgCompareState.srcOrgUrl = orgUrl;
    _orgCompareState.results = null;
    _orgCompareState.availableObjects = null;
    _orgCompareState.selectedObjects = null;
  }
  document.querySelectorAll('.ds-nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-view="compare"]')?.classList.add('active');
  _currentView = 'compare';
  renderOrgCompare();
};

// Transfer "💾 Save as deployment" — promote the ephemeral Org-Compare
// profile into a real saved deployment. Keeps its id so the run history it
// already produced stays linked (and retryable).
window.saveEphemeralProfile = async function() {
  const p = _reconcileProfile;
  if (!p || !p.ephemeral) return;
  delete p.ephemeral;
  // a parents-first step keeps its unsaved origin OBJECT for the way back —
  // never persist that (a whole deployment with its scan inside another)
  if (p._parentOf) delete p._parentOf.profile;
  p.createdAt = p.updatedAt = new Date().toISOString();
  _profiles.push(p);
  await storageSaveProfiles();
  showToast(`Saved “${p.name}” — find it under Data Deployment`, 'success', 4000);
  renderReconcile();   // re-render header without the save button
};

window.cloneProfile = function(profileId) {
  const src = _profiles.find(p => p.id === profileId);
  if (!src) return;
  const clone = JSON.parse(JSON.stringify(src));
  clone.id   = genId('prof');
  clone.name = `Copy of ${clone.name}`;
  clone.createdAt = clone.updatedAt = new Date().toISOString();
  delete clone.schedule;
  // Drop the live-diff scan result — a clone hasn't been compared against
  // anything yet. If the source profile's lastScan came over, the new
  // profile would display stale counts as if it had been scanned.
  delete clone.lastScan;
  _profiles.push(clone);
  storageSaveProfiles().then(() => renderProfiles());
};

window.deleteProfile = function(profileId) {
  sftkDialog({
      title: `Delete Profile`,
      sev: 'red',
      bodyHtml: `
This will permanently delete this profile and its schedule (if any). Transfer history is kept.`,
      actions: [{ label: `Cancel`, kind: 'secondary', attrs: 'data-dsaction="closeModal"' }, { id: 'dsConfirmDelete', label: `Delete`, kind: 'danger' }],
    });
  eid('dsConfirmDelete')?.addEventListener('click', async () => {
    closeModal();
    _profiles = _profiles.filter(p => p.id !== profileId);
    await storageSaveProfiles();
    renderProfiles();
  });
};

