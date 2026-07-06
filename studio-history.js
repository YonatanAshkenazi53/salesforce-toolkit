'use strict';
// ════════════════════════════════════════════════════════════════
// SCHEDULE
// ════════════════════════════════════════════════════════════════
// History filters — module state so they survive re-renders within a session.
let _histFilter = { status: '', profileId: '' };

function renderHistory() {
  if (!_history.length) {
    setMain(`
      <div class="ds-view-header"><h2 class="ds-view-title">📜 History</h2></div>
      <div class="ds-empty-page">
        <div class="ds-empty-icon">${window.sftkCatSvg('sleep', 72)}</div>
        <div class="ds-empty-title">No transfers yet</div>
        <div class="ds-empty-sub">Run a transfer and the results will appear here.</div>
      </div>`);
    return;
  }

  const sorted = [..._history].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));

  // Apply filters (status chip + profile dropdown).
  const filtered = sorted.filter(run =>
    (!_histFilter.status || run.status === _histFilter.status) &&
    (!_histFilter.profileId || run.profileId === _histFilter.profileId)
  );

  // Distinct profiles present in history — for the filter dropdown. Uses the
  // run's own stored name so deleted profiles remain filterable.
  const profSeen = new Map();
  for (const run of sorted) {
    if (run.profileId && !profSeen.has(run.profileId)) profSeen.set(run.profileId, run.profileName || 'Unnamed');
  }

  setMain(`
    <div class="ds-view-header">
      <h2 class="ds-view-title">📜 History</h2>
      <button class="ds-btn ds-btn-danger ds-btn-sm" id="dsClearHistory">🗑 Clear All</button>
    </div>
    <div class="ds-hist-filters">
      <div class="ds-hist-status-chips">
        ${[['', 'All'], ['success', '✅ success'], ['partial', '⚠ partial'], ['failed', '❌ failed']].map(([v, lbl]) =>
          `<button class="ds-btn ds-btn-xs ${_histFilter.status === v ? 'ds-btn-primary' : ''}" data-hist-status="${v}">${lbl}</button>`
        ).join('')}
      </div>
      <select id="dsHistProfile" class="ds-select ds-select-sm" style="max-width:260px">
        <option value="">All deployments</option>
        ${[...profSeen].map(([id, name]) =>
          `<option value="${esc(id)}" ${_histFilter.profileId === id ? 'selected' : ''}>${esc(name)}</option>`).join('')}
      </select>
      <span class="ds-hist-filter-count">${filtered.length} of ${sorted.length} run${sorted.length !== 1 ? 's' : ''}</span>
    </div>
    ${!filtered.length ? `<div class="ds-seq-empty">No runs match the current filters.</div>` : ''}
    <div class="ds-history-list">
      ${filtered.map(run => {
        // Aggregate failed source IDs across all objects in this run.
        // The retry button only appears when we actually have IDs to retry.
        const failedByObj = {};
        let totalFailed = 0;
        for (const [obj, s] of Object.entries(run.summary || {})) {
          const failedIds = (s.failedSourceIds || []).map(f => typeof f === 'string' ? f : f.id).filter(Boolean);
          if (failedIds.length) {
            failedByObj[obj] = failedIds;
            totalFailed += failedIds.length;
          }
        }
        const profExists = !!(run.profileId && _profiles.some(p => p.id === run.profileId));
        const retryable  = totalFailed > 0 && profExists;
        const isRecRun   = run.kind === 'reconcile';
        return `
        <div class="ds-history-card">
          <div class="ds-history-card-header">
            <span class="ds-run-status-badge ds-run-status-${run.status}">
              ${run.status === 'success' ? '✅' : run.status === 'partial' ? '⚠' : '❌'} ${run.status}
            </span>
            <span class="ds-history-profile-name">${esc(run.profileName || 'Unknown profile')}</span>
            ${run.scheduledRun ? '<span class="ds-chip">📅 scheduled</span>' : ''}
            <span class="ds-history-time">${timeAgo(run.startedAt)}</span>
            ${retryable ? `<button class="ds-btn ds-btn-xs ds-btn-primary" data-dsaction="retryFailed" data-arg="${esc(run.id)}"
              title="Re-run this profile transferring ONLY the ${totalFailed} record(s) that failed before. Skips records that already succeeded so you don't double-create.">↻ Retry failed (${totalFailed})</button>` : ''}
            ${profExists && !isRecRun ? `<button class="ds-btn ds-btn-xs" data-dsaction="runAgain" data-arg="${esc(run.id)}"
              title="Open Run Transfer for this deployment against the same org pair this run used.">↻ Run again</button>` : ''}
            ${profExists && isRecRun ? `<button class="ds-btn ds-btn-xs" data-dsaction="openReconcile" data-arg="${esc(run.profileId)}"
              title="Open the Reconcile view for this deployment.">⚖ Reconcile</button>` : ''}
            ${profExists ? `<button class="ds-btn ds-btn-xs" data-dsaction="editProfile" data-arg="${esc(run.profileId)}"
              title="Open this deployment in the builder.">✏ Profile</button>` : ''}
          </div>
          <div class="ds-history-orgs">
            ${esc(orgLabel(run.sourceOrg || ''))} → ${esc(orgLabel(run.targetOrg || ''))}
            ${run.kind === 'reconcile' ? '<span class="ds-chip" style="margin-left:6px">⚖ reconcile</span>' : ''}
          </div>
          <div class="ds-history-summary">
            ${Object.entries(run.summary || {}).map(([obj, s]) => {
              // Reconcile runs carry explicit per-DML counts (inserted/updated/
              // deleted). Transfer runs carry the legacy created/failed pair.
              // Show whichever set is populated so success detail is visible.
              const isRec = run.kind === 'reconcile' ||
                            s.inserted != null || s.updated != null || s.deleted != null || s.pulled != null;
              if (isRec) {
                const parts = [];
                if (s.inserted)      parts.push(`<span class="ds-rec-tag ds-rec-tag-ins">${s.inserted} inserted</span>`);
                if (s.connected)     parts.push(`<span class="ds-rec-tag ds-rec-tag-ins">🔗 ${s.connected} linked</span>`);
                if (s.relinked)      parts.push(`<span class="ds-rec-tag ds-rec-tag-upd">⇄ ${s.relinked} relinked</span>`);
                if (s.updated)       parts.push(`<span class="ds-rec-tag ds-rec-tag-upd">${s.updated} updated</span>`);
                if (s.updatedSource) parts.push(`<span class="ds-rec-tag ds-rec-tag-pull">← ${s.updatedSource} updated in source</span>`);
                if (s.pulled)        parts.push(`<span class="ds-rec-tag ds-rec-tag-pull">← ${s.pulled} pulled</span>`);
                if (s.deleted)       parts.push(`<span class="ds-rec-tag ds-rec-tag-del">${s.deleted} deleted${s.deleteMode === 'hard' ? ' (hard)' : ''}</span>`);
                const failTot = (s.insertedFailed || 0) + (s.updatedFailed || 0) + (s.deletedFailed || 0) + (s.pulledFailed || 0) + (s.updatedSourceFailed || 0) + (s.connectFailed || 0) + (s.relinkFailed || 0);
                if (failTot)    parts.push(`<span class="ds-rec-tag ds-rec-tag-fail">${failTot} failed</span>`);
                if (!parts.length) parts.push('<span class="ds-rec-tag">no changes</span>');
                return `<span class="ds-summary-chip"><strong>${esc(obj)}</strong> · ${parts.join(' ')}</span>`;
              }
              return `<span class="ds-summary-chip">${esc(obj)}: ${s.created || 0}↑${s.failed ? ' '+s.failed+'✗' : ''}${s.connected ? ' '+s.connected+'🔗' : ''}</span>`;
            }).join('')}
          </div>
          ${(() => {
            // Record links. Written records open in the TARGET org. Failed
            // records split by kind: failed UPDATES also open in the target
            // (the record exists — the PATCH was refused); failed INSERTS
            // open in the SOURCE org (nothing was created in the target).
            // Error messages show on hover.
            const tgtBase = String(run.tgtOrgUrl || run.targetOrg || '').replace(/\/+$/, '');
            const srcBase = String(run.srcOrgUrl || run.sourceOrg || '').replace(/\/+$/, '');
            const out = [];
            for (const [obj, s] of Object.entries(run.summary || {})) {
              if (tgtBase && s.targetRecords?.length) {
                out.push(`
              <details class="ds-history-links">
                <summary>🔗 ${esc(obj)}: ${s.targetRecords.length} record(s) written — open in ${esc(orgLabel(tgtBase))}</summary>
                <div class="ds-history-links-list">
                  ${s.targetRecords.map(tr =>
                    `<a href="${esc(tgtBase)}/${esc(tr.id)}" target="_blank" rel="noopener">${esc(tr.label || tr.id)}</a>`
                  ).join('')}
                </div>
              </details>`);
              }
              if (tgtBase && s.failedRecords?.length) {
                out.push(`
              <details class="ds-history-links ds-history-links-failed">
                <summary>✗ ${esc(obj)}: ${s.failedRecords.length} failed update(s) — open in ${esc(orgLabel(tgtBase))}</summary>
                <div class="ds-history-links-list">
                  ${s.failedRecords.map(fr =>
                    `<a href="${esc(tgtBase)}/${esc(fr.id)}" target="_blank" rel="noopener" title="${esc(fr.error || '')}">${esc(fr.label || fr.id)}</a>`
                  ).join('')}
                </div>
              </details>`);
              }
              const failedIns = (s.failedSourceIds || []).filter(f => f && typeof f === 'object' && f.id);
              if (srcBase && failedIns.length) {
                out.push(`
              <details class="ds-history-links ds-history-links-failed">
                <summary>✗ ${esc(obj)}: ${failedIns.length} failed insert(s) — open the SOURCE record in ${esc(orgLabel(srcBase))}</summary>
                <div class="ds-history-links-list">
                  ${failedIns.map(fr =>
                    `<a href="${esc(srcBase)}/${esc(fr.id)}" target="_blank" rel="noopener" title="${esc(fr.error || '')}">${esc(fr.label || fr.id)}</a>`
                  ).join('')}
                </div>
              </details>`);
              }
            }
            return out.join('');
          })()}
          ${(run.errors || []).length ? `
            <details class="ds-history-errors">
              <summary>${(() => {
                // ⚠-prefixed lines are informational notes (skipped fields,
                // fallback owners…), not failures — count them separately so
                // "4 errors" doesn't overstate 2 notes + 2 real failures.
                const warns = run.errors.filter(e => String(e).includes('⚠')).length;
                const reals = run.errors.length - warns;
                const parts = [];
                if (reals) parts.push(`${reals} error${reals !== 1 ? 's' : ''}`);
                if (warns) parts.push(`${warns} note${warns !== 1 ? 's' : ''}`);
                return parts.join(' · ');
              })()}</summary>
              ${run.errors.map(e => `<div class="ds-history-err-row">${String(e).includes('⚠') ? '⚠' : '❌'} ${esc(e)}</div>`).join('')}
            </details>` : ''}
        </div>`;
      }).join('')}
    </div>
  `);

  eid('dsClearHistory')?.addEventListener('click', () => {
    showModal(`
      <div class="ds-modal-header">Clear History</div>
      <div class="ds-modal-body">Delete all transfer history records?</div>
      <div class="ds-modal-footer">
        <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
        <button class="ds-btn ds-btn-danger" id="dsConfirmClearHistory">Clear All</button>
      </div>`);
    eid('dsConfirmClearHistory')?.addEventListener('click', async () => {
      closeModal();
      _history = [];
      await storageSaveHistory();
      renderHistory();
    });
  });

  // Filter wiring — status chips + profile dropdown re-render the list.
  document.querySelectorAll('[data-hist-status]').forEach(b =>
    b.addEventListener('click', () => { _histFilter.status = b.dataset.histStatus; renderHistory(); }));
  eid('dsHistProfile')?.addEventListener('change', e => {
    _histFilter.profileId = e.target.value; renderHistory();
  });
}

