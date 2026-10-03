'use strict';
// Sequences — ordered chains of saved deployments. Moved out of
// studio-profiles.js on 2026-10-03 so the PUBLIC build can leave the feature
// out (user: "lets cut squences, picklist manager"): scripts/pack_store.py does
// not ship this file, and the Data Deployment page shows the Sequences section
// only when sequenceCard exists. The dev build keeps it; saved sequences and
// their History entries are untouched.

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
        // Same default as a new deployment and the topbar chip — one helper,
        // so a new sequence never opens sourceless while the topbar shows one.
        sourceOrg: (typeof currentSourceOrg === 'function' ? currentSourceOrg() : (_workingPair.src || '')),
        targetOrg: _workingPair.tgt || '',
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

// The confirmation before a sequence writes. Resolves true only when the
// acknowledgement box is ticked and ▶ Run sequence is pressed (and, for a
// production target, its name was typed). Cancel / close → false.
function _seqConfirmRun(seq, profiles, tgtSess) {
  // The one confirmation (sftk-confirm.js, campaign 3 phase 2): the steps as
  // items, the stakes, the acknowledgement box, and — when the target is a
  // production org or guarded as one — the org's name typed in a second step.
  const tgtLabel = orgLabel(seq.targetOrg);
  return (async () => {
    const gate = await sftkOrgWriteGate(seq.targetOrg, _orgs);
    return sftkConfirmDestructive({
      title: `▶ Run “${seq.name}” — ${profiles.length} step(s) into ${tgtLabel}`,
      items: profiles.map(p => ({ label: p.name, sub: `${p.tree?.objectType || '?'}${(p.tree?.children || []).length ? ` +${(p.tree.children || []).length} child object(s)` : ''} · ${p.upsert?.field ? `upsert on ${p.upsert.field}` : 'insert'}` })),
      revOverride: { html: `⚠ A sequence takes <strong>no per-record selection</strong>: every record each deployment matches is written into <strong>${esc(tgtLabel)}</strong>, step after step. Records a step already wrote stay written if a later step fails. ↩ Roll back in History removes what this run inserted.`, needsCheckbox: true },
      icon: '▶',
      confirmLabel: '▶ Run sequence',
      production: gate.production ? { label: gate.label || tgtLabel } : null,
    });
  })();
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
  if (Array.isArray(freshRes?.sessions)) _allSessionsOk = true;
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
  // ▶ Run used to write at once (live 2026-09-23): no summary, no
  // acknowledgement, no typed word for a production target — while a
  // sequence takes NO per-record selection (every record each deployment
  // matches goes). One confirmation names the steps and the stakes; a
  // production target asks for its name, like every other write.
  const sure = await _seqConfirmRun(seq, profiles, tgtSess);
  if (!sure) return;

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
  const seqPort = _openRunPort(sftkRunProgressHandler(eid('dsSeqRunLog')));
  // ✋ a cancel clicked while the restore point is being read must stop the
  // sequence BEFORE the engine starts — the port cancel alone would be reset
  // by the engine's own start.
  let seqCancelled = false;
  eid('seqRunCancel')?.addEventListener('click', () => {
    seqCancelled = true;
    try { seqPort?.postMessage({ cmd: 'cancel' }); } catch (_) {}
    const cb = eid('seqRunCancel');
    if (cb) { cb.disabled = true; cb.textContent = '⏳ cancelling…'; }
  });

  // ↩ RESTORE POINT for the WHOLE sequence (studio-undo.js) — one image of
  // every object any step can write, shared by every step's History entry:
  // rolling back any step rolls back the sequence, and the card says so.
  const seqRunId = genId('seq');
  const seqUndoLog = (icon, msg, cls = '') => {
    const el = eid('dsSeqRunLog'); if (!el) return;
    const row = document.createElement('div');
    row.className = `ds-prog-row ${cls}`;
    row.textContent = `${icon} ${msg}`;
    el.appendChild(row);
  };
  const seqUndoStub = await sftkUndoCaptureForRun({
    evidenceId: seqRunId, scope: 'sequence', profileName: seq.name,
    legs: [{ orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
      objects: sftkUndoMergeObjects(profiles.map(p => sftkUndoTreeObjects(p.tree, p.upsert?.field ? 'upsert' : 'insert'))) }],
  }, seqUndoLog);
  if (seqCancelled) {
    try { seqPort?.disconnect(); } catch (_) {}
    seqUndoLog('✋', 'Cancelled before any write — nothing was written.', 'ds-prog-warn');
    eid('seqRunCancel')?.remove();
    const cb0 = eid('seqRunClose');
    if (cb0) { cb0.disabled = false; cb0.textContent = 'Close'; cb0.addEventListener('click', closeModal); }
    return;
  }

  const result = await sendBg({
    // verified-by: the engine's post-run re-read — summary[obj].verified = { checked, found } (background.js, campaign 3 phase 1)
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
    // ↩ steps may have written before the failure — keep the restore point reachable.
    if (seqUndoStub.status !== 'none') {
      const seqEnd = await sftkUndoRunEnd(tgtSess.orgUrl, tgtSess.sid, seqUndoStub.objects);
      _history.push({
        id: genId('run'), sequenceId: seq.id, sequenceName: seq.name, profileName: `${seq.name} (sequence)`,
        srcOrgUrl: srcSess.orgUrl, tgtOrgUrl: tgtSess.orgUrl, sourceOrg: srcSess.orgUrl, targetOrg: tgtSess.orgUrl,
        startedAt: new Date().toISOString(), status: 'failed', summary: {}, errors: [String(result.error)],
        undo: { ...seqUndoStub, ...seqEnd },
      });
      await storageSaveHistory();
    }
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
  // ↩ end-of-run boundary from Salesforce's own clock (studio-undo.js).
  const seqEnd = await sftkUndoRunEnd(tgtSess.orgUrl, tgtSess.sid, seqUndoStub.objects);
  for (const step of (result.steps || [])) {
    _history.push({
      id: genId('run'), profileId: step.profileId, profileName: step.profileName,
      sequenceId: seq.id, sequenceName: seq.name,
      srcOrgUrl: srcSess.orgUrl, tgtOrgUrl: tgtSess.orgUrl,
      sourceOrg: srcSess.orgUrl, targetOrg: tgtSess.orgUrl,
      startedAt: nowIso, status: step.status, summary: step.summary, errors: step.errors,
      undo: { ...seqUndoStub, ...seqEnd }
    });
  }
  await storageSaveHistory();

  showToast(
    result.status === 'success'
      ? `✅ Sequence “${seq.name}” — ${grandTotal} records across ${result.steps.length} step(s)`
      : `⚠️ Sequence finished with warnings — ${grandTotal} records`,
    result.status === 'success' ? 'success' : 'warning', 6000);
}
