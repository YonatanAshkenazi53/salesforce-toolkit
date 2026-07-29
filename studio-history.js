'use strict';
// ════════════════════════════════════════════════════════════════
// HISTORY — run log, filters, retention controls, audit exports (E2)
// ════════════════════════════════════════════════════════════════

// ── E2: audit-export pure helpers ────────────────────────────────
// Pure functions (no free variables beyond each other) at column 0 so
// test/ent-audit-export.test.mjs can materialize them via extract.mjs.
// They turn a history entry (see the _history.push sites in
// studio-transfer.js / studio-reconcile.js) into audit files a change-
// management process can consume a quarter later.

// RFC-4180 CSV escaping + spreadsheet formula-injection guard. A leading
// = + - @ (or tab/CR) would be EXECUTED as a formula by Excel/Sheets on
// open, so those cells get an apostrophe prefix — quoting alone does not
// stop Excel. The prefix alters the cell; the export UI says so (HONESTY).
function histCsvEscape(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// header: string[], rows: array of cell arrays → one CRLF-terminated CSV text.
function histCsvSerialize(header, rows) {
  return [header].concat(rows || []).map(r => r.map(histCsvEscape).join(',')).join('\r\n') + '\r\n';
}

// T11b field/value context → one human-readable cell:
// "BillingState=TX; Phone (not sent)". Absent/null means the payload
// carried no value for that field at all.
function histFieldContext(fields) {
  if (!Array.isArray(fields) || !fields.length) return '';
  return fields.filter(f => f && f.field).map(f =>
    (f.absent || f.sent == null) ? `${f.field} (not sent)` : `${f.field}=${String(f.sent)}`
  ).join('; ');
}

// Totals across BOTH summary shapes: transfer (created/failed) and
// reconcile (inserted/updated/deleted/pulled + per-DML *Failed).
function histRunTotals(entry) {
  const t = { created: 0, updated: 0, deleted: 0, pulled: 0, failed: 0, notProcessed: 0, viaBulk: false };
  for (const s of Object.values((entry && entry.summary) || {})) {
    if (!s || typeof s !== 'object') continue;
    t.created += (s.created || 0) + (s.inserted || 0);
    t.updated += (s.updated || 0) + (s.updatedSource || 0) + (s.relinked || 0) + (s.overwritten || 0);
    t.deleted += s.deleted || 0;
    t.pulled  += s.pulled || 0;
    t.failed  += (s.failed || 0) + (s.insertedFailed || 0) + (s.updatedFailed || 0) +
                 (s.deletedFailed || 0) + (s.pulledFailed || 0) + (s.updatedSourceFailed || 0) +
                 (s.connectFailed || 0) + (s.relinkFailed || 0) + (s.overwriteFailed || 0) + (s.deleteFailed || 0);
    t.notProcessed += s.notProcessed || 0;
    if (s.viaBulk) t.viaBulk = true;
  }
  return t;
}

// Why an entry has no record-level rows — or null when it has them (or had
// no activity to detail). countsOnly is the CURRENT setting: when it is on,
// storageSaveHistory stripped ids/labels at write time, and the export must
// SAY that instead of emitting an empty section (HONESTY).
function histRecordDetailNote(entry, countsOnly) {
  const sums = Object.values((entry && entry.summary) || {}).filter(s => s && typeof s === 'object');
  const hasArrays = sums.some(s =>
    (s.targetRecords && s.targetRecords.length) ||
    (s.failedRecords && s.failedRecords.length) ||
    (s.failedSourceIds && s.failedSourceIds.length));
  if (hasArrays) return null;
  const t = histRunTotals(entry);
  if (!(t.created + t.updated + t.deleted + t.pulled + t.failed + t.notProcessed)) return null;
  return countsOnly
    ? 'Record-level rows are unavailable for this run: counts-only mode strips per-record ids and labels from history at write time. Counts and errors below are complete.'
    : 'Record-level rows are unavailable for this run: no per-record detail was stored (it may have been saved while counts-only mode was on). Counts and errors below are complete.';
}

// One run → per-record CSV rows. opts: { countsOnly, sourceLabel, targetLabel }.
// Returns { header, rows, notes }. One row per record outcome where record
// detail exists (written / failed-update / failed-insert with T11b context);
// objects whose detail is missing get an explicit summary-only row, and
// storage caps get explicit note rows — never a silently empty section.
function histRunToCsvRows(entry, opts) {
  const e = entry || {};
  const o = opts || {};
  const header = ['run_id', 'kind', 'deployment', 'status', 'dry_run', 'scheduled', 'started_at', 'completed_at',
    'source_org_url', 'source_org_label', 'target_org_url', 'target_org_label',
    'object', 'outcome', 'record_id', 'record_label', 'error', 'field_context', 'via_bulk', 'note'];
  const srcUrl = e.srcOrgUrl || e.sourceOrg || '';
  const tgtUrl = e.tgtOrgUrl || e.targetOrg || '';
  const base = [
    e.id || '', e.kind || 'transfer', e.profileName || '', e.status || '',
    e.dryRun === true ? 'true' : 'false', e.scheduledRun ? 'true' : 'false',
    e.startedAt || '', e.completedAt || '',
    srcUrl, o.sourceLabel || srcUrl, tgtUrl, o.targetLabel || tgtUrl,
  ];
  const mk = (obj, outcome, id, label, err, fieldCtx, viaBulk, note) =>
    base.concat([obj, outcome, id || '', label || '', err || '', fieldCtx || '', viaBulk ? 'true' : 'false', note || '']);
  const rows = [];
  const notes = [];
  for (const [obj, s] of Object.entries(e.summary || {})) {
    if (!s || typeof s !== 'object') continue;
    const bulk = !!s.viaBulk;
    const t = histRunTotals({ summary: { [obj]: s } });
    let recRows = 0;
    for (const tr of (s.targetRecords || [])) {
      rows.push(mk(obj, 'written', tr && tr.id, tr && tr.label, '', '', bulk, ''));
      recRows++;
    }
    for (const fr of (s.failedRecords || [])) {
      rows.push(mk(obj, 'failed-update', fr && fr.id, fr && fr.label, fr && fr.error,
        histFieldContext(fr && fr.fields), bulk, ''));
      recRows++;
    }
    for (const fi of (s.failedSourceIds || [])) {
      const isObj = fi && typeof fi === 'object';
      rows.push(mk(obj, 'failed-insert', isObj ? fi.id : fi, isObj ? fi.label : '', isObj ? fi.error : '',
        histFieldContext(isObj ? fi.fields : null), bulk, ''));
      recRows++;
    }
    const activity = t.created + t.updated + t.deleted + t.pulled + t.failed + t.notProcessed;
    if (!recRows && activity > 0) {
      const bits = [];
      if (t.created) bits.push(`${t.created} created`);
      if (t.updated) bits.push(`${t.updated} updated`);
      if (t.deleted) bits.push(`${t.deleted} deleted`);
      if (t.pulled) bits.push(`${t.pulled} pulled`);
      if (t.failed) bits.push(`${t.failed} failed`);
      if (t.notProcessed) bits.push(`${t.notProcessed} not confirmed written`);
      const why = o.countsOnly
        ? 'record ids were stripped at write time (counts-only mode) — counts only'
        : 'no per-record detail stored for this object — counts only';
      rows.push(mk(obj, 'summary-only', '', '', '', '', bulk, `${bits.join(', ')} — ${why}`));
      notes.push(`${obj}: ${why}.`);
    }
    const writtenStored = (s.targetRecords || []).length;
    if (writtenStored && t.created > writtenStored) {
      const msg = `${obj}: detail stored for ${writtenStored} of ${t.created} written records — history keeps at most 200 per object`;
      rows.push(mk(obj, 'note', '', '', '', '', bulk, msg));
      notes.push(msg + '.');
    }
    const failedStored = (s.failedRecords || []).length + (s.failedSourceIds || []).length;
    if (failedStored && t.failed > failedStored) {
      const msg = `${obj}: detail stored for ${failedStored} of ${t.failed} failed records — history keeps at most 200 per object`;
      rows.push(mk(obj, 'note', '', '', '', '', bulk, msg));
      notes.push(msg + '.');
    }
  }
  if (!rows.length) rows.push(mk('', 'summary-only', '', '', '', '', false, 'this run recorded no per-object results'));
  const detailNote = histRecordDetailNote(e, !!o.countsOnly);
  if (detailNote) notes.unshift(detailNote);
  return { header, rows, notes };
}

// Full history → summary-level CSV, one row per run. opts: { countsOnly }.
function histHistoryCsvRows(entries, opts) {
  const o = opts || {};
  const header = ['run_id', 'kind', 'deployment', 'status', 'dry_run', 'scheduled', 'started_at', 'completed_at',
    'source_org_url', 'target_org_url', 'objects', 'created', 'updated', 'deleted', 'pulled',
    'failed', 'not_confirmed', 'via_bulk', 'record_detail', 'error_count', 'errors'];
  const rows = (entries || []).map(e => {
    const t = histRunTotals(e);
    const errs = (e.errors || []).map(x => String(x));
    const shown = errs.slice(0, 5);
    const errCell = shown.join(' | ') + (errs.length > shown.length
      ? ` | …and ${errs.length - shown.length} more — the JSON export carries the full list` : '');
    const note = histRecordDetailNote(e, !!o.countsOnly);
    const hasArrays = Object.values(e.summary || {}).some(s => s && typeof s === 'object' &&
      ((s.targetRecords || []).length || (s.failedRecords || []).length || (s.failedSourceIds || []).length));
    return [
      e.id || '', e.kind || 'transfer', e.profileName || '', e.status || '',
      e.dryRun === true ? 'true' : 'false', e.scheduledRun ? 'true' : 'false',
      e.startedAt || '', e.completedAt || '',
      e.srcOrgUrl || e.sourceOrg || '', e.tgtOrgUrl || e.targetOrg || '',
      Object.keys(e.summary || {}).join('; '),
      t.created, t.updated, t.deleted, t.pulled, t.failed, t.notProcessed,
      t.viaBulk ? 'true' : 'false',
      note || (hasArrays ? 'stored — the per-run report has one row per record' : ''),
      errs.length, errCell,
    ];
  });
  return { header, rows };
}

// JSON export payload (per-run when entries has one element, full history
// otherwise). settings: { historyDays, countsOnly }. opts: { labels: {url →
// label}, nowIso }. The retention note states what is and is NOT in the file
// — an audit export that silently omits purged runs violates HONESTY.
function histExportPayload(entries, settings, opts) {
  const s = settings || {};
  const o = opts || {};
  const labels = o.labels || {};
  const days = s.historyDays || 0;
  const runs = (entries || []).map(e => {
    const t = histRunTotals(e);
    const note = histRecordDetailNote(e, !!s.countsOnly);
    const srcUrl = (e && (e.srcOrgUrl || e.sourceOrg)) || '';
    const tgtUrl = (e && (e.tgtOrgUrl || e.targetOrg)) || '';
    return {
      ...e,
      kind: (e && e.kind) || 'transfer',
      dryRun: !!(e && e.dryRun === true),
      scheduledRun: !!(e && e.scheduledRun),
      viaBulk: t.viaBulk,
      sourceOrgLabel: labels[srcUrl] || srcUrl,
      targetOrgLabel: labels[tgtUrl] || tgtUrl,
      totals: { created: t.created, updated: t.updated, deleted: t.deleted, pulled: t.pulled, failed: t.failed, notConfirmedWritten: t.notProcessed },
      ...(note ? { recordDetailNote: note } : {}),
    };
  });
  const retentionNote = (days > 0
    ? `This file contains the ${runs.length} run(s) currently retained. Runs older than ${days} day(s) are purged automatically per the retention setting, and history keeps at most the last 100 runs — anything already purged is NOT in this file.`
    : `This file contains the ${runs.length} run(s) currently retained. Retention is set to "keep forever", but history still keeps at most the last 100 runs — older runs beyond that cap are NOT in this file.`)
    + (s.countsOnly ? ' Counts-only mode is ON: per-record ids and labels are stripped from history at write time, so runs carry counts and errors but no record-level detail.' : '');
  return {
    format: 'sftk-history-export',
    version: 1,
    tool: 'Admin Toolkit for Salesforce — Data Studio',
    exportedAt: o.nowIso || new Date().toISOString(),
    retention: { historyDays: days, countsOnly: !!s.countsOnly, maxRuns: 100 },
    note: retentionNote,
    runCount: runs.length,
    runs,
  };
}

// sftk-run-<object>-<YYYY-MM-DD>-<HHMMSS> (UTC, from startedAt; falls back
// to now for undated entries). Extension is appended by the caller.
function histExportFilename(entry) {
  const e = entry || {};
  const firstObj = Object.keys(e.summary || {})[0] || 'run';
  const slug = String(firstObj).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'run';
  const d = new Date(e.startedAt || Date.now());
  const iso = Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  return `sftk-run-${slug}-${iso.slice(0, 10)}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

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
      <div style="display:flex;gap:8px;align-items:center">
        <select id="dsRetentionDays" class="ds-select ds-select-sm" title="Runs older than this are purged automatically when the Studio opens">
          ${[[7, 'Keep 7 days'], [30, 'Keep 30 days'], [90, 'Keep 90 days'], [0, 'Keep forever']].map(([v, lbl]) =>
            `<option value="${v}" ${_settings.historyDays === v ? 'selected' : ''}>${lbl}</option>`).join('')}
        </select>
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer" title="Store only counts and errors — per-record ids and labels are stripped from history (record links in History cards stop working)">
          <input type="checkbox" id="dsCountsOnly" ${_settings.countsOnly ? 'checked' : ''}> counts only
        </label>
        <button class="ds-btn ds-btn-sm" id="dsHistExportAll" title="Download every retained run as a JSON or CSV audit file — for change-management records">⬇ Export</button>
        <button class="ds-btn ds-btn-sm" id="dsClearCached" title="Delete history, activity log, scan results, and cached Apex log bodies — org labels and settings stay">🧹 Clear cached org data</button>
        <button class="ds-btn ds-btn-danger ds-btn-sm" id="dsClearHistory">🗑 Clear All</button>
      </div>
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
            <button class="ds-btn ds-btn-xs" data-hist-export="${esc(run.id)}"
              title="Download this run as a JSON or CSV audit report — who deployed what, where, when, and what failed.">⬇ Report</button>
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
                if (s.notProcessed) parts.push(`<span class="ds-rec-tag ds-rec-tag-fail" title="The Bulk job was aborted when the run was cancelled — these records were not confirmed written.">${s.notProcessed} not confirmed</span>`);
                if (s.viaBulk)  parts.push('<span class="ds-rec-tag" title="Written with one Bulk API 2.0 job instead of 200-record REST batches.">⚡ via Bulk API</span>');
                if (!parts.length) parts.push('<span class="ds-rec-tag">no changes</span>');
                return `<span class="ds-summary-chip"><strong>${esc(obj)}</strong> · ${parts.join(' ')}</span>`;
              }
              // B3 — bulk provenance (⚡) and the records an aborted Bulk job
              // left unconfirmed (⏸) belong on the chip: they are neither
              // created nor failed, and hiding them makes a cancelled run look
              // like a clean small run.
              const chipTitle = [
                `${s.created || 0} created`,
                s.failed ? `${s.failed} failed` : '',
                s.notProcessed ? `${s.notProcessed} not confirmed written — the Bulk job was aborted when the run was cancelled` : '',
                s.connected ? `${s.connected} linked to parent` : '',
                s.viaBulk ? 'written with one Bulk API 2.0 job' : '',
              ].filter(Boolean).join(' · ');
              return `<span class="ds-summary-chip" title="${esc(chipTitle)}">${esc(obj)}: ${s.created || 0}↑${s.failed ? ' '+s.failed+'✗' : ''}${s.notProcessed ? ' '+s.notProcessed+'⏸' : ''}${s.connected ? ' '+s.connected+'🔗' : ''}${s.viaBulk ? ' <span style="opacity:.75">⚡ via Bulk API</span>' : ''}</span>`;
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
          ${(run.errors || []).length ? (() => {
            // Friendly rendering (U1): every raw error string goes through
            // sftkFriendlyError → plain-language message + hint; skipped-field
            // notes collapse into one per-field list instead of arrow walls.
            const parsed = run.errors.map(e => sftkFriendlyError(e));
            const notes  = parsed.filter(p => p.kind === 'note');
            const fails  = parsed.filter(p => p.kind === 'error');
            const skips  = notes.filter(n => n.type === 'skipped-fields');
            const otherNotes = notes.filter(n => n.type !== 'skipped-fields');

            // ── T11b: the DATA behind each failure ────────────────────────
            // The engine attaches `fields:[{field, sent|absent}]` to every
            // failed record whose error named a field, so a group can show
            // WHAT was pushed, not just that something was rejected.
            // Index them by the engine's own raw error line ("Account: <msg>")
            // — the exact string the deduper grouped on, minus its "(×N)"
            // suffix — so a record's values land under its own error and
            // nowhere else.
            const srcLinkBase = String(run.srcOrgUrl || run.sourceOrg || '').replace(/\/+$/, '');
            const rawKey = t => String(t == null ? '' : t)
              .replace(/^[⚠❌✖✕]\s*/, '').replace(/\s*\(×\d+\)\s*$/, '').trim();
            const valuesByRaw = new Map();
            for (const [obj, s] of Object.entries(run.summary || {})) {
              for (const fr of (s.failedSourceIds || [])) {
                if (!fr || typeof fr !== 'object') continue;
                if (!Array.isArray(fr.fields) || !fr.fields.length) continue;
                const k = rawKey(`${obj}: ${fr.error || ''}`);
                if (!valuesByRaw.has(k)) valuesByRaw.set(k, []);
                valuesByRaw.get(k).push(fr);
              }
            }

            // Identical failures collapse into one row with a count.
            // `raws` keeps every raw line the group swallowed so the values
            // above can be looked up — grouping behaviour itself is unchanged.
            const failGroups = new Map();
            for (const f of fails) {
              const g = failGroups.get(f.message);
              if (g) { g.count += f.count; g.raws.push(rawKey(f.raw)); }
              else failGroups.set(f.message, { ...f, raws: [rawKey(f.raw)] });
            }

            // Renders "Acme Corp — tried to write BillingState = "TX"" rows
            // under one grouped error. Capped; the cap is always stated.
            const VALUE_ROWS = 5;
            const valueBlock = (g) => {
              const recs = [];
              const seen = new Set();
              for (const k of (g.raws || [])) {
                for (const fr of (valuesByRaw.get(k) || [])) {
                  if (fr.id && seen.has(fr.id)) continue;
                  if (fr.id) seen.add(fr.id);
                  recs.push(fr);
                }
              }
              if (!recs.length) return '';
              const shown = recs.slice(0, VALUE_ROWS);
              const rows = shown.map(fr => {
                const bits = (fr.fields || []).filter(Boolean).map(fd => (fd.absent || fd.sent == null)
                  ? `<code>${esc(fd.field)}</code> <span style="opacity:.75">was not sent at all (no value in the payload)</span>`
                  : `tried to write <code>${esc(fd.field)}</code> = <code>${esc(String(fd.sent))}</code>`
                ).join(' · ');
                const label = esc(fr.label || fr.id || 'record');
                const link  = (srcLinkBase && fr.id)
                  ? `<a href="${esc(srcLinkBase)}/${esc(fr.id)}" target="_blank" rel="noopener">${label}</a>`
                  : label;
                return `<div style="padding:2px 0 2px 14px;font-size:11.5px;line-height:1.5">${link} — ${bits}</div>`;
              }).join('');
              const more = recs.length > shown.length
                ? `<div style="padding:2px 0 2px 14px;font-size:11.5px;opacity:.75">…and ${recs.length - shown.length} more record(s) with the same error.</div>`
                : '';
              // Honest about the OTHER cap: the engine only captures values for
              // the first 200 failures of an object (storage quota), so a group
              // of 5 000 will legitimately have fewer value rows than ×N.
              const partial = g.count > recs.length
                ? `<div style="padding:2px 0 2px 14px;font-size:11.5px;opacity:.75">Values were captured for ${recs.length} of the ${g.count} record(s) that hit this error.</div>`
                : '';
              return `<div style="margin:4px 0 2px">${rows}${more}${partial}</div>`;
            };

            const summary = [];
            if (fails.length) summary.push(`${fails.length} error${fails.length !== 1 ? 's' : ''}`);
            if (notes.length) summary.push(`${notes.length} note${notes.length !== 1 ? 's' : ''}`);

            const skipBlock = skips.length ? `
              <div class="ds-err-skipblock">
                <div class="ds-err-skiphead">⚠ Fields not copied (mapping issues) — records themselves were still written:</div>
                ${skips.flatMap(n => n.fields || []).map(f => `
                  <div class="ds-err-fieldrow"><code>${esc(f.field)}</code><span class="ds-err-fieldreason">${esc(f.reason)}</span></div>`).join('')}
                <div class="ds-err-hint">💡 Open ✏ Edit → Fields &amp; mapping to clean these up (🧹 removes stale entries).</div>
              </div>` : '';

            const failBlock = [...failGroups.values()].map(f => `
              <div class="ds-history-err-row" title="${esc(f.raw)}">❌ ${esc(f.object ? f.object + ': ' : '')}${esc(f.message)}${f.count > 1 ? ` <span class="ds-err-count">×${f.count}</span>` : ''}${f.phase ? ` <span class="ds-err-phase">while ${esc(f.phase)}</span>` : ''}
                ${valueBlock(f)}
                ${f.hint ? `<div class="ds-err-hint">💡 ${esc(f.hint)}</div>` : ''}
              </div>`).join('');

            const noteBlock = otherNotes.map(n => `
              <div class="ds-history-err-row" title="${esc(n.raw)}">⚠ ${esc(n.message)}
                ${n.hint ? `<div class="ds-err-hint">💡 ${esc(n.hint)}</div>` : ''}
              </div>`).join('');

            return `
            <details class="ds-history-errors">
              <summary>${summary.join(' · ')}</summary>
              ${failBlock}
              ${skipBlock}
              ${noteBlock}
              <details class="ds-err-raw"><summary>raw error text (for support / copy-paste)</summary>
                ${run.errors.map(e => `<div class="ds-err-rawline">${esc(e)}</div>`).join('')}
              </details>
            </details>`;
          })() : ''}
        </div>`;
      }).join('')}
    </div>
  `);

  // Retention controls (Security S5)
  eid('dsRetentionDays')?.addEventListener('change', async e => {
    _settings.historyDays = parseInt(e.target.value, 10) || 0;
    await storageSaveSettings();
    showToast(_settings.historyDays
      ? `History older than ${_settings.historyDays} days will be purged on load`
      : 'History is kept forever', 'info');
  });
  eid('dsCountsOnly')?.addEventListener('change', async e => {
    _settings.countsOnly = e.target.checked;
    await storageSaveSettings();
    if (_settings.countsOnly) {
      await storageSaveHistory();   // strips existing entries immediately
      showToast('Counts-only mode on — record ids stripped from history', 'warning');
      renderHistory();
    } else {
      showToast('Counts-only mode off — future runs keep record links', 'info');
    }
  });
  eid('dsClearCached')?.addEventListener('click', () => {
    showModal(`
      <div class="ds-modal-header">🧹 Clear cached org data</div>
      <div class="ds-modal-body">
        Deletes everything cached <em>about your orgs' data</em>:
        <ul style="margin:8px 0 8px 18px;font-size:12.5px">
          <li>all run history (${_history.length} entries)</li>
          <li>all deployment scan results (record ids + match keys)</li>
          <li>remembered match pairs (🧠 match memory — record-id pairs learned from transfers and Match Review)</li>
          <li>activity log and cached Apex log bodies</li>
          <li>the flow dependency cache, Field Cleaner undo snapshots and field-dependency scans, and the last scheduled drift result</li>
        </ul>
        Deployment configurations, org labels, read-only locks, and settings are kept.
      </div>
      <div class="ds-modal-footer">
        <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
        <button class="ds-btn ds-btn-danger" id="dsConfirmClearCached">Clear cached data</button>
      </div>`);
    eid('dsConfirmClearCached')?.addEventListener('click', async () => {
      closeModal();
      _history = [];
      _activityLog = {};
      let scans = 0;
      for (const p of _profiles) if (p.lastScan) { delete p.lastScan; scans++; }
      // M3c — match memory holds record-id pairs about org data → S5 scope.
      let mems = 0;
      for (const p of _profiles) if (p.matchMemory) { delete p.matchMemory; mems++; }
      const all = await chrome.storage.local.get(null);
      // Every key holding data ABOUT THE ORGS, not configuration. Prefix-matched
      // so per-org/per-field variants are caught too. QA 2026-07-29: the button
      // promised "everything cached about your orgs' data" while leaving the
      // v1.1.0 dependency cache, Field Cleaner's undo snapshots (full flow /
      // layout / FlexiPage metadata) and the drift result behind.
      const ORG_DATA_PREFIXES = [
        'apex_log_viewer_',   // raw Apex log bodies
        'sftk_dep_cache',     // flow dependency map per org
        'fc_fix_snapshots',   // Field Cleaner undo: full metadata of edited components
        'fc_dep|',            // per-org/per-field dependency scans
        'ds_sched_drift',     // last scheduled drift-check result
        'ds_scans', 'ds_scan_results',
        'sftk_debug_entries', 'sftk_debug_meta',   // captured API calls (already sid-redacted)
      ];
      const cachedKeys = Object.keys(all).filter(k => ORG_DATA_PREFIXES.some(p => k.startsWith(p)));
      if (cachedKeys.length) await chrome.storage.local.remove(cachedKeys);
      // The in-memory dependency map would otherwise keep serving the data we
      // just deleted from disk until the popup is reopened.
      try { window.DependencyMap?.clearCache?.(); } catch (_) {}
      await Promise.all([
        storageSaveHistory(),
        storageSaveProfiles(),
        chrome.storage.local.set({ ds_activity_log: {} }),
      ]);
      showToast(`Cleared: history, ${scans} scan result${scans !== 1 ? 's' : ''}, match memory on ${mems} deployment${mems !== 1 ? 's' : ''}, activity log, ${cachedKeys.length} cached org-data entr${cachedKeys.length !== 1 ? 'ies' : 'y'}`, 'success');
      renderHistory();
    });
  });

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

  // E2 — audit exports: per-run ⬇ Report + full-history ⬇ Export.
  eid('dsHistExportAll')?.addEventListener('click', _histShowExportAllModal);
  document.querySelectorAll('[data-hist-export]').forEach(b =>
    b.addEventListener('click', () => {
      const run = _history.find(r => r.id === b.dataset.histExport);
      if (run) _histShowRunExportModal(run);
    }));
}

// ── E2: audit-export UI (impure — modal, blob download) ─────────

// Client-side blob download, same pattern as studio-compare's CSV export.
// No server round-trip — the file never leaves the machine.
function _histDownload(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// {url → label} for every org URL appearing in the given runs.
function _histLabelsMap(runs) {
  const labels = {};
  for (const r of runs) {
    for (const u of [r.srcOrgUrl, r.sourceOrg, r.tgtOrgUrl, r.targetOrg]) {
      if (u && !labels[u]) labels[u] = orgLabel(u);
    }
  }
  return labels;
}

// The apostrophe-prefix disclosure — shown in BOTH export modals because the
// guard alters cell contents, and silent alteration of an audit file is
// exactly what the honesty rule forbids.
const _HIST_CSV_GUARD_NOTE =
  'CSV cells starting with = + − @ are prefixed with an apostrophe (\') so spreadsheets treat them as text instead of executing them as formulas.';

function _histShowRunExportModal(run) {
  const srcUrl = run.srcOrgUrl || run.sourceOrg || '';
  const tgtUrl = run.tgtOrgUrl || run.targetOrg || '';
  const srcLabel = orgLabel(srcUrl);
  const tgtLabel = orgLabel(tgtUrl);
  const { header, rows, notes } = histRunToCsvRows(run, {
    countsOnly: !!_settings.countsOnly, sourceLabel: srcLabel, targetLabel: tgtLabel,
  });
  const oi = header.indexOf('outcome');
  const recordRows = rows.filter(r => r[oi] === 'written' || r[oi] === 'failed-update' || r[oi] === 'failed-insert').length;
  const fnameBase = histExportFilename(run);
  showModal(`
    <div class="ds-modal-header">⬇ Run report</div>
    <div class="ds-modal-body" style="font-size:12.5px">
      <div><strong>${esc(run.profileName || 'Unknown profile')}</strong> · ${esc(run.status || '')} · ${esc(run.startedAt || 'undated')}</div>
      <div style="opacity:.85;margin-top:2px">${esc(srcLabel)} → ${esc(tgtLabel)}</div>
      <div style="margin-top:8px">
        <strong>JSON</strong> — the full audit record: timestamps, org URLs + labels, per-object counts, error details with field/value context, dry-run and Bulk-API flags.<br>
        <strong>CSV</strong> — ${recordRows
          ? `${recordRows} record-level row(s) (one per record outcome), plus explicit note rows for anything not stored.`
          : 'no record-level rows are available for this run — the CSV states why per object instead of being silently empty.'}
      </div>
      ${notes.length ? `<div style="margin-top:8px;opacity:.85">${notes.map(n => `<div>⚠ ${esc(n)}</div>`).join('')}</div>` : ''}
      <div style="margin-top:8px;opacity:.7">${esc(_HIST_CSV_GUARD_NOTE)}</div>
      <div style="margin-top:4px;opacity:.7">Files: <code>${esc(fnameBase)}.json</code> / <code>.csv</code></div>
    </div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      <button class="ds-btn" id="dsRunExportCsv">⬇ CSV</button>
      <button class="ds-btn ds-btn-primary" id="dsRunExportJson">⬇ JSON</button>
    </div>`);
  eid('dsRunExportJson')?.addEventListener('click', () => {
    const payload = histExportPayload([run], _settings, { labels: _histLabelsMap([run]) });
    _histDownload(`${fnameBase}.json`, JSON.stringify(payload, null, 2), 'application/json');
    closeModal();
    showToast('Run report exported (JSON)', 'success', 3000);
  });
  eid('dsRunExportCsv')?.addEventListener('click', () => {
    _histDownload(`${fnameBase}.csv`, histCsvSerialize(header, rows), 'text/csv;charset=utf-8');
    closeModal();
    showToast(`Run report exported (CSV, ${rows.length} row(s))`, 'success', 3000);
  });
}

function _histShowExportAllModal() {
  const sorted = [..._history].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  const days = _settings.historyDays || 0;
  const nowIso = new Date().toISOString();
  const stamp = `${nowIso.slice(0, 10)}-${nowIso.slice(11, 19).replace(/:/g, '')}`;
  // HONESTY: state exactly what the file will and will not contain — the
  // current retention setting decides what was already purged.
  const retentionLine = days > 0
    ? `Exporting the ${sorted.length} run(s) currently retained. Runs older than ${days} day(s) were already purged per your ${days}-day retention setting and are NOT in this export.`
    : `Exporting the ${sorted.length} run(s) currently retained. Retention is set to "keep forever", so nothing has been purged by age.`;
  showModal(`
    <div class="ds-modal-header">⬇ Export run history</div>
    <div class="ds-modal-body" style="font-size:12.5px">
      <div>${esc(retentionLine)}</div>
      <div style="margin-top:4px;opacity:.85">History always keeps at most the last 100 runs — anything beyond that cap is gone and cannot be exported.</div>
      ${_settings.countsOnly ? `<div style="margin-top:4px;opacity:.85">⚠ Counts-only mode is ON: entries carry counts and errors but no per-record ids or labels.</div>` : ''}
      <div style="margin-top:8px">
        <strong>JSON</strong> — every retained run in full detail (an array, one element per run).<br>
        <strong>CSV</strong> — one summary row per run: status, orgs, per-run totals, error count.
      </div>
      <div style="margin-top:8px;opacity:.7">${esc(_HIST_CSV_GUARD_NOTE)}</div>
    </div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      <button class="ds-btn" id="dsHistExportAllCsv">⬇ CSV</button>
      <button class="ds-btn ds-btn-primary" id="dsHistExportAllJson">⬇ JSON</button>
    </div>`);
  eid('dsHistExportAllJson')?.addEventListener('click', () => {
    const payload = histExportPayload(sorted, _settings, { labels: _histLabelsMap(sorted), nowIso });
    _histDownload(`sftk-history-${stamp}.json`, JSON.stringify(payload, null, 2), 'application/json');
    closeModal();
    showToast(`History exported (JSON, ${sorted.length} run(s))`, 'success', 3000);
  });
  eid('dsHistExportAllCsv')?.addEventListener('click', () => {
    const { header, rows } = histHistoryCsvRows(sorted, { countsOnly: !!_settings.countsOnly });
    _histDownload(`sftk-history-${stamp}.csv`, histCsvSerialize(header, rows), 'text/csv;charset=utf-8');
    closeModal();
    showToast(`History exported (CSV, ${rows.length} run(s))`, 'success', 3000);
  });
}

