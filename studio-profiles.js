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
    <div class="ds-view-header">
      <div class="ds-view-title-wrap">
        <h2 class="ds-view-title">📦 Data Deployment</h2>
        <div class="ds-view-subtitle">Define a profile (objects + orgs), then click ▶ Run</div>
      </div>
      <button class="ds-btn ds-btn-primary" id="dsNewProfile">+ New Profile</button>
    </div>

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

    <div class="ds-seq-section">
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
    </div>
  `);

  eid('dsNewProfile')?.addEventListener('click', () => openProfileBuilder(null));
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

// ════════════════════════════════════════════════════════════════
// SEQUENCES — ordered chains of saved profiles (shared idMap pipeline)
// ════════════════════════════════════════════════════════════════
function sequenceCard(s) {
  const liveSet = _liveOrgSet();
  const hasOrgs = !!(s.sourceOrg && s.targetOrg);
  const orgRow  = hasOrgs
    ? `<div class="ds-profile-card-orgs">
         <span class="ds-profile-card-org">${liveSet.has(_orgKey(s.sourceOrg)) ? '🟢' : '⚪'} ${esc(orgLabel(s.sourceOrg))}</span>
         <span class="ds-profile-card-org-arrow">→</span>
         <span class="ds-profile-card-org">${liveSet.has(_orgKey(s.targetOrg)) ? '🟢' : '⚪'} ${esc(orgLabel(s.targetOrg))}</span>
       </div>`
    : `<div class="ds-profile-card-orgs ds-profile-card-orgs-missing">⚠ Orgs not set — click ✏ Edit</div>`;

  // Resolve each step to a profile name; flag steps whose profile was deleted.
  const stepsHtml = (s.steps || []).map((pid, i) => {
    const prof = _profiles.find(p => p.id === pid);
    const label = prof ? esc(prof.name) : '⚠ deleted profile';
    return `<div class="ds-seq-step ${prof ? '' : 'ds-seq-step-missing'}">
      <span class="ds-seq-step-num">${i + 1}</span>
      <span class="ds-seq-step-name">${label}</span>
    </div>`;
  }).join('<span class="ds-seq-step-arrow">↓</span>');

  const missingStep = (s.steps || []).some(pid => !_profiles.find(p => p.id === pid));
  const runnable    = hasOrgs && (s.steps || []).length > 0 && !missingStep;

  return `<div class="ds-seq-card">
    <div class="ds-seq-card-head">
      <div class="ds-seq-card-title">🔗 ${esc(s.name || 'Untitled sequence')}</div>
      <div class="ds-seq-card-actions">
        <button class="ds-btn ds-btn-xs ds-btn-primary" data-seq-run="${esc(s.id)}" ${runnable ? '' : 'disabled title="Set orgs and add at least one existing profile"'}>▶ Run</button>
        <button class="ds-btn ds-btn-xs" data-seq-edit="${esc(s.id)}">✏ Edit</button>
        <button class="ds-btn ds-btn-xs" data-seq-del="${esc(s.id)}">🗑</button>
      </div>
    </div>
    ${orgRow}
    <div class="ds-seq-steps">${stepsHtml || '<span class="ds-seq-empty-inline">No steps yet</span>'}</div>
  </div>`;
}

// Build/edit a sequence in a modal: name, source/target org, ordered profile
// steps with ↑/↓/✕ reordering and an "+ Add step" row.
function openSequenceBuilder(seq) {
  const editing = !!seq;
  const draft = seq
    ? JSON.parse(JSON.stringify(seq))
    : { id: genId('seq'), name: '',
        // New sequences start with the working pair (still editable here).
        sourceOrg: _workingPair.src || '', targetOrg: _workingPair.tgt || '',
        steps: [], createdAt: new Date().toISOString() };
  if (!Array.isArray(draft.steps)) draft.steps = [];

  const knownOrgs = allMapOrgs();
  for (const url of [draft.sourceOrg, draft.targetOrg]) {
    if (url && !knownOrgs.some(o => o.url === url)) knownOrgs.push({ url, label: orgLabel(url) });
  }

  function orgSelect(role, selectedUrl) {
    const liveSet = _liveOrgSet();
    return `<select class="ds-select ds-select-sm" data-seq-org="${role}">
      <option value="">— pick an org —</option>
      ${knownOrgs.map(o => `<option value="${esc(o.url)}" ${o.url === selectedUrl ? 'selected' : ''}>${esc(orgOptionLabel(o.url, o.label, liveSet))}</option>`).join('')}
    </select>`;
  }

  function profileSelect(selectedId) {
    return `${_profiles.map(p => `<option value="${esc(p.id)}" ${p.id === selectedId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}`;
  }

  function stepRowsHtml() {
    if (!draft.steps.length)
      return `<div class="ds-seq-builder-empty">No steps. Click “+ Add step” to chain a profile.</div>`;
    return draft.steps.map((pid, i) => `
      <div class="ds-seq-builder-row" data-seq-row="${i}">
        <span class="ds-seq-step-num">${i + 1}</span>
        <select class="ds-select ds-select-sm ds-seq-builder-prof" data-seq-step="${i}">
          <option value="">— pick a profile —</option>
          ${profileSelect(pid)}
        </select>
        <button class="ds-btn ds-btn-xs" data-seq-up="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
        <button class="ds-btn ds-btn-xs" data-seq-down="${i}" ${i === draft.steps.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
        <button class="ds-btn ds-btn-xs" data-seq-rm="${i}" title="Remove step">✕</button>
      </div>`).join('');
  }

  function render() {
    showModal(`
      <div class="ds-modal-header">${editing ? '✏ Edit Sequence' : '🔗 New Sequence'}</div>
      <div class="ds-modal-body ds-seq-builder">
        <label class="ds-field-label">Name</label>
        <input type="text" class="ds-input" id="seqName" value="${esc(draft.name || '')}" placeholder="e.g. CPQ Price Rules pipeline">

        <div class="ds-seq-builder-orgs">
          <div><label class="ds-field-label">Source org</label>${orgSelect('source', draft.sourceOrg)}</div>
          <div class="ds-seq-builder-arrow">→</div>
          <div><label class="ds-field-label">Target org</label>${orgSelect('target', draft.targetOrg)}</div>
        </div>

        <label class="ds-field-label">Steps (run top to bottom)</label>
        <div class="ds-seq-builder-rows" id="seqRows">${stepRowsHtml()}</div>
        <button class="ds-btn ds-btn-xs" id="seqAddStep" ${_profiles.length ? '' : 'disabled'}>+ Add step</button>

        <div class="ds-seq-builder-note">↪ All steps run against the orgs picked above (the chained profiles' own org settings are ignored for this run). One shared record-Id map flows through every step, so cross-profile lookups remap automatically.</div>
      </div>
      <div class="ds-modal-footer">
        <button class="ds-btn" id="seqCancel">Cancel</button>
        <button class="ds-btn ds-btn-primary" id="seqSave">${editing ? 'Save' : 'Create'}</button>
      </div>
    `);

    // ── sync helpers (read current DOM into draft before re-render) ──
    const syncScalars = () => {
      draft.name      = eid('seqName')?.value.trim() || '';
      draft.sourceOrg = document.querySelector('[data-seq-org="source"]')?.value || '';
      draft.targetOrg = document.querySelector('[data-seq-org="target"]')?.value || '';
    };
    const syncSteps = () => {
      document.querySelectorAll('[data-seq-step]').forEach(sel => {
        draft.steps[+sel.dataset.seqStep] = sel.value || '';
      });
    };

    eid('seqCancel')?.addEventListener('click', closeModal);
    eid('seqAddStep')?.addEventListener('click', () => {
      syncScalars(); syncSteps(); draft.steps.push(''); render();
    });
    document.querySelectorAll('[data-seq-up]').forEach(b => b.addEventListener('click', () => {
      const i = +b.dataset.seqUp; syncScalars(); syncSteps();
      [draft.steps[i - 1], draft.steps[i]] = [draft.steps[i], draft.steps[i - 1]]; render();
    }));
    document.querySelectorAll('[data-seq-down]').forEach(b => b.addEventListener('click', () => {
      const i = +b.dataset.seqDown; syncScalars(); syncSteps();
      [draft.steps[i + 1], draft.steps[i]] = [draft.steps[i], draft.steps[i + 1]]; render();
    }));
    document.querySelectorAll('[data-seq-rm]').forEach(b => b.addEventListener('click', () => {
      const i = +b.dataset.seqRm; syncScalars(); syncSteps(); draft.steps.splice(i, 1); render();
    }));

    eid('seqSave')?.addEventListener('click', async () => {
      syncScalars(); syncSteps();
      draft.steps = draft.steps.filter(Boolean);   // drop blank rows
      if (!draft.name)            return showToast('Give the sequence a name', 'warning', 3000);
      if (!draft.steps.length)    return showToast('Add at least one profile step', 'warning', 3000);
      if (!draft.sourceOrg || !draft.targetOrg)
        return showToast('Pick both a source and a target org', 'warning', 3000);
      if (_orgKey(draft.sourceOrg) === _orgKey(draft.targetOrg))
        return showToast('Source and target must be different orgs', 'warning', 3500);
      draft.updatedAt = new Date().toISOString();
      const idx = _sequences.findIndex(x => x.id === draft.id);
      if (idx !== -1) _sequences[idx] = draft; else _sequences.push(draft);
      await storageSaveSequences();
      closeModal();
      renderProfiles();
      showToast(`Sequence “${draft.name}” saved`, 'success', 3000);
    });
  }

  render();
}

function deleteSequence(seqId) {
  const seq = _sequences.find(s => s.id === seqId);
  if (!seq) return;
  showModal(`
    <div class="ds-modal-header">Delete Sequence</div>
    <div class="ds-modal-body">Delete sequence <strong>${esc(seq.name)}</strong>? The chained profiles themselves are <em>not</em> deleted — only this ordering.</div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      <button class="ds-btn ds-btn-danger" id="dsConfirmSeqDelete">Delete</button>
    </div>`);
  eid('dsConfirmSeqDelete')?.addEventListener('click', async () => {
    closeModal();
    _sequences = _sequences.filter(s => s.id !== seqId);
    await storageSaveSequences();
    renderProfiles();
    showToast('Sequence deleted', 'info', 2500);
  });
}

async function runSequence(seqId) {
  const seq = _sequences.find(s => s.id === seqId);
  if (!seq) return;

  // Resolve the ordered profile objects; bail if any step's profile is gone.
  const profiles = (seq.steps || []).map(pid => _profiles.find(p => p.id === pid));
  if (!profiles.length || profiles.some(p => !p)) {
    return showToast('This sequence references a profile that no longer exists — edit it first.', 'error', 5000);
  }

  // Refresh open-tab sessions so we use the freshest SIDs, then resolve the pair.
  const freshRes = await sendBg({ type: 'GET_ALL_SF_SESSIONS' });
  if (freshRes?.sessions?.length) {
    _allSessions = freshRes.sessions;
    _allSessions.forEach(s => upsertOrg(s.orgUrl, s.label));
  }
  const allSess = _buildAllSessions();
  const srcSess = _resolveSession(seq.sourceOrg, allSess);
  const tgtSess = _resolveSession(seq.targetOrg, allSess);
  if (!srcSess?.sid || !tgtSess?.sid) {
    const offline = [
      !srcSess?.sid ? orgLabel(seq.sourceOrg) : null,
      !tgtSess?.sid ? orgLabel(seq.targetOrg) : null
    ].filter(Boolean).join(' and ');
    return showToast(`Open ${offline} in a Chrome tab — a live session is required to run the sequence.`, 'error', 6000);
  }

  // Progress modal — the whole sequence runs in one background call and returns
  // once, so we show a spinner, then render the full per-step breakdown.
  showModal(`
    <div class="ds-modal-header">🔗 Running “${esc(seq.name)}”</div>
    <div class="ds-modal-body" id="seqRunBody">
      <div class="ds-seq-run-meta">${esc(orgLabel(seq.sourceOrg))} → ${esc(orgLabel(seq.targetOrg))} · ${profiles.length} step(s)</div>
      <div id="dsSeqRunLog" class="ds-progress-log ds-seq-run-log"></div>
    </div>
    <div class="ds-modal-footer">
      <button class="ds-btn ds-btn-danger" id="seqRunCancel" title="Stop after the current batch — records already written stay written.">✋ Cancel</button>
      <button class="ds-btn" id="seqRunClose" disabled>Running…</button>
    </div>
  `);

  // Live progress: step + per-batch lines stream into the modal log.
  const seqPort = _openRunPort(_runProgressHandler(eid('dsSeqRunLog')));
  eid('seqRunCancel')?.addEventListener('click', () => {
    try { seqPort?.postMessage({ cmd: 'cancel' }); } catch (_) {}
    const cb = eid('seqRunCancel');
    if (cb) { cb.disabled = true; cb.textContent = '⏳ cancelling…'; }
  });

  const result = await sendBg({
    type:      'SF_EXECUTE_SEQUENCE',
    profiles,
    srcOrgUrl: srcSess.orgUrl, srcSid: srcSess.sid,
    tgtOrgUrl: tgtSess.orgUrl, tgtSid: tgtSess.sid
  });

  try { seqPort?.disconnect(); } catch (_) {}
  eid('seqRunCancel')?.remove();
  const body = eid('seqRunBody');
  const closeBtn = eid('seqRunClose');
  if (closeBtn) { closeBtn.disabled = false; closeBtn.textContent = 'Close'; closeBtn.addEventListener('click', closeModal); }

  if (result?.error) {
    if (body) body.innerHTML = `<div class="ds-prog-err">❌ ${esc(result.error)}</div>`;
    showToast('Sequence failed: ' + result.error, 'error', 6000);
    return;
  }

  // Per-step breakdown + grand total.
  let grandTotal = 0;
  const stepHtml = (result.steps || []).map(step => {
    const created = Object.values(step.summary || {}).reduce((n, s) => n + (s.created || 0), 0);
    const failed  = Object.values(step.summary || {}).reduce((n, s) => n + (s.failed  || 0), 0);
    grandTotal += created;
    const icon = step.status === 'success' ? '✅' : (created > 0 ? '⚠' : '❌');
    const objLines = Object.entries(step.summary || {}).map(([obj, s]) =>
      `<div class="ds-seq-run-obj">${esc(obj)}: ${s.created || 0} created${s.failed ? `, ${s.failed} failed` : ''}${s.connected ? `, ${s.connected} linked` : ''}${s.connectFailed ? `, ${s.connectFailed} link failed` : ''}${s.error ? ` — ${esc(s.error)}` : ''}</div>`
    ).join('');
    const errLines = (step.errors || []).slice(0, 6).map(e => `<div class="ds-prog-err">${esc(e)}</div>`).join('');
    return `<div class="ds-seq-run-step">
      <div class="ds-seq-run-step-head">${icon} <strong>${step.index + 1}. ${esc(step.profileName || 'Step')}</strong>
        <span class="ds-seq-run-step-count">${created} created${failed ? `, ${failed} failed` : ''}</span></div>
      ${objLines}${errLines}
    </div>`;
  }).join('');

  if (body) {
    body.innerHTML = `
      <div class="ds-seq-run-meta">${esc(orgLabel(seq.sourceOrg))} → ${esc(orgLabel(seq.targetOrg))} · Status: <strong>${esc(result.status)}</strong> · ${grandTotal} record(s) total</div>
      ${result.cancelled ? `<div class="ds-prog-row ds-prog-warn">✋ Sequence cancelled — completed steps stay written; skipped steps are marked below.</div>` : ''}
      ${stepHtml}`;
  }

  // History: one entry per step (reuses History view + per-step retry), tagged
  // with the sequence so they read as a group.
  recordActivity('transfer');
  const nowIso = new Date().toISOString();
  for (const step of (result.steps || [])) {
    _history.push({
      id: genId('run'), profileId: step.profileId, profileName: step.profileName,
      sequenceId: seq.id, sequenceName: seq.name,
      srcOrgUrl: srcSess.orgUrl, tgtOrgUrl: tgtSess.orgUrl,
      sourceOrg: srcSess.orgUrl, targetOrg: tgtSess.orgUrl,
      startedAt: nowIso, status: step.status, summary: step.summary, errors: step.errors
    });
  }
  await storageSaveHistory();

  showToast(
    result.status === 'success'
      ? `✅ Sequence “${seq.name}” — ${grandTotal} records across ${result.steps.length} step(s)`
      : `⚠️ Sequence finished with warnings — ${grandTotal} records`,
    result.status === 'success' ? 'success' : 'warning', 6000);
}

function profileCard(p) {
  const nodeCount   = countTreeNodes(p.tree);
  const isScheduled = p.schedule?.enabled;
  const lastRun     = _history.filter(h => h.profileId === p.id).sort((a,b) => b.startedAt.localeCompare(a.startedAt))[0];

  const hasOrgs = !!(p.sourceOrg && p.targetOrg);
  const orgRow  = hasOrgs
    ? `<div class="ds-profile-card-orgs">
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
      <div class="ds-profile-card-actions">
        <button class="ds-btn ds-btn-sm ds-btn-primary" data-dsaction="runProfile" data-arg="${p.id}"
          ${hasOrgs ? '' : 'disabled title="Set source and target orgs in Edit first"'}>▶ Run</button>
        <button class="ds-btn ds-btn-sm" data-dsaction="openTreeDiff" data-arg="${p.id}"
          ${hasOrgs ? '' : 'disabled title="Set source and target orgs first"'}
          title="Compare the whole record tree across environments, node by node, with suggested operations">🌳 Tree diff</button>
        <button class="ds-btn ds-btn-sm" data-dsaction="openFanOut" data-arg="${p.id}"
          ${hasOrgs ? '' : 'disabled title="Set source and target orgs first"'}
          title="Run this deployment against SEVERAL target orgs in one go — one History entry per org (M1)">🌐 Multi-org…</button>
        <button class="ds-btn ds-btn-sm" data-dsaction="refreshState" data-arg="${p.id}"
          ${hasOrgs ? '' : 'disabled title="Set source and target orgs first"'}
          title="Query both orgs to refresh what's missing / changed / in sync.">🔄 Refresh state</button>
        <button class="ds-btn ds-btn-sm" data-dsaction="openReconcile" data-arg="${p.id}"
          ${hasOrgs ? '' : 'disabled title="Set source and target orgs first"'}
          title="Open the Reconcile view — review what's missing / drifted / extra across both orgs and push or delete in one screen.">⚖ Reconcile</button>
        <button class="ds-btn ds-btn-sm" data-dsaction="editProfile" data-arg="${p.id}">✏ Edit</button>
        <button class="ds-btn ds-btn-sm" data-dsaction="cloneProfile" data-arg="${p.id}">⧉ Clone</button>
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

window.runProfile = function(profileId) {
  _transferProfile = _profiles.find(p => p.id === profileId) || null;
  _transferOrgOverride = { src: null, tgt: null };   // fresh launch → profile's own orgs
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

// Reconcile "💾 Save as deployment" — promote the ephemeral Org-Compare
// profile into a real saved deployment. Keeps its id so the run history it
// already produced stays linked (and retryable).
window.saveEphemeralProfile = async function() {
  const p = _reconcileProfile;
  if (!p || !p.ephemeral) return;
  delete p.ephemeral;
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
  showModal(`
    <div class="ds-modal-header">Delete Profile</div>
    <div class="ds-modal-body">This will permanently delete this profile and its schedule (if any). Transfer history is kept.</div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      <button class="ds-btn ds-btn-danger" id="dsConfirmDelete">Delete</button>
    </div>`);
  eid('dsConfirmDelete')?.addEventListener('click', async () => {
    closeModal();
    _profiles = _profiles.filter(p => p.id !== profileId);
    await storageSaveProfiles();
    renderProfiles();
  });
};

