'use strict';
// ════════════════════════════════════════════════════════════════
// SYNC RING (M2) — is everything in sync, across ALL my orgs?
// ════════════════════════════════════════════════════════════════
// The user's scenario: ~5 orgs whose data must stay synced from one source
// of truth. This view is the morning dashboard: a deployment × target-org
// matrix where every cell answers "how far out of sync is THIS org for THIS
// dataset" — with per-cell repair (ephemeral Reconcile, the org-compare
// pattern) and per-row fan-out (M1).
//
// Ring config lives in _ring (studio-core: { orgs:[urls], sourceUrl }),
// persisted as ds_ring. Per-target scan summaries live on the profile as
// profile.ringScans[orgKey] = { runAt, missing, changed, extra, status } —
// COUNTS ONLY (full buckets would bloat chrome.storage on 5 orgs × N
// deployments; the per-cell ⚖ re-scans fresh for full fidelity anyway).

function renderRing() {
  const orgs = allMapOrgs();
  const ls   = _liveOrgSet();
  const ring = _ring || { orgs: [], sourceUrl: '' };
  // Keep the config panel open across the re-render each change triggers —
  // otherwise it snaps shut after every org you tick (user bug report).
  const prevCfg = document.querySelector('.ds-ring-cfg');
  const cfgOpen = prevCfg ? prevCfg.open : ring.orgs.length < 2;

  const orgRows = orgs.map(o => {
    const inRing  = ring.orgs.some(u => _orgKey(u) === _orgKey(o.url));
    const isSrc   = _orgKey(o.url) === _orgKey(ring.sourceUrl || '');
    return `
      <label class="ds-ring-org${inRing ? ' ds-ring-org-in' : ''}">
        <input type="checkbox" class="ds-ring-cb" value="${esc(o.url)}" ${inRing ? 'checked' : ''}>
        <span class="ds-ring-org-name">${esc(orgOptionLabel(o.url, o.label, ls))}</span>
        ${prodBadge(o.url)}
        <span style="flex:1"></span>
        <label class="ds-ring-src-pick" title="Data flows FROM the source of truth to every other ring org">
          <input type="radio" name="dsRingSrc" value="${esc(o.url)}" ${isSrc ? 'checked' : ''} ${inRing ? '' : 'disabled'}>
          source of truth
        </label>
      </label>`;
  }).join('');

  setMain(`
    <div class="ds-view-header">
      <div class="ds-view-title-wrap">
        <h2 class="ds-view-title">🔄 Sync Ring</h2>
        <div class="ds-view-subtitle">One source of truth → every ring org. Scan to see drift; fan out to fix it.</div>
      </div>
    </div>

    <details class="ds-ring-cfg" ${cfgOpen ? 'open' : ''}>
      <summary class="ds-ring-cfg-sum"><strong>⚙ Ring configuration</strong>
        <span class="ds-oc-sub">${ring.orgs.length} org(s) in the ring${ring.sourceUrl ? ` · source: ${esc(orgLabel(ring.sourceUrl))}` : ''}</span>
      </summary>
      <div class="ds-ring-orgs">${orgRows || '<div class="ds-seq-empty">No orgs known — open them in Chrome tabs first.</div>'}</div>
      <!-- M4 — opt-in scheduled drift check (read-only count probe) -->
      <div style="padding:4px 14px 12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px">
        ⏰ Scheduled drift check:
        <select id="dsRingSched" class="ds-select ds-select-sm" title="Chrome checks in the background even with Data Studio closed — the extension icon shows a red badge when drift appears.">
          ${[[0, 'off'], [60, 'every hour'], [360, 'every 6 hours'], [1440, 'daily']].map(([m, l]) =>
            `<option value="${m}" ${(Number(_ring?.scheduleMins) || 0) === m ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <button class="ds-btn ds-btn-xs" id="dsRingProbeNow">▶ Check now</button>
        <span style="font-size:11px;color:var(--subtext)">Count probe, read-only: catches added/removed records, NOT value changes — run a 🔎 scan for those. Orgs must be signed in in this Chrome profile.</span>
      </div>
    </details>

    <div id="dsRingSchedPanel"></div>
    <div id="dsRingBody"></div>`);

  // Opening the ring view acknowledges the drift badge.
  try { chrome.action?.setBadgeText?.({ text: '' }); } catch (_) {}

  // M4 — schedule select + on-demand probe + last-result panel.
  eid('dsRingSched')?.addEventListener('change', async e => {
    const mins = Number(e.target.value) || 0;
    if (_ring) _ring.scheduleMins = mins;   // worker persists it on ds_ring too
    const res = await sendBg({ type: 'SF_SET_RING_SCHEDULE', minutes: mins });
    if (res?.error) showToast(`Couldn't set the schedule: ${res.error}`, 'error', 5000);
    else showToast(mins ? `Scheduled — Chrome will check every ${mins >= 1440 ? 'day' : mins >= 60 ? `${mins / 60}h` : `${mins}m`} in the background` : 'Scheduled drift check turned off', 'info', 4000);
  });
  eid('dsRingProbeNow')?.addEventListener('click', async () => {
    const btn = eid('dsRingProbeNow');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ checking…'; }
    const res = await sendBg({ type: 'SF_RUN_RING_PROBE' });
    if (btn) { btn.disabled = false; btn.textContent = '▶ Check now'; }
    if (res?.error) showToast(`Probe failed: ${res.error}`, 'error', 5000);
    _ringRenderSchedPanel();
  });
  _ringRenderSchedPanel();

  // Config wiring — checkbox membership + source radio, persisted immediately.
  document.querySelectorAll('.ds-ring-cb').forEach(cb =>
    cb.addEventListener('change', async () => {
      const url = cb.value;
      if (!_ring) _ring = { orgs: [], sourceUrl: '' };
      if (cb.checked) { if (!_ring.orgs.some(u => _orgKey(u) === _orgKey(url))) _ring.orgs.push(url); }
      else {
        _ring.orgs = _ring.orgs.filter(u => _orgKey(u) !== _orgKey(url));
        if (_orgKey(_ring.sourceUrl || '') === _orgKey(url)) _ring.sourceUrl = _ring.orgs[0] || '';
      }
      await chrome.storage.local.set({ ds_ring: _ring });
      if (_ring.sourceUrl) { _workingPair.src = _ring.sourceUrl; storageSaveWorkingPair(); }
      if (typeof syncRingFollowers === 'function') syncRingFollowers();
      renderWorkingPair();
      renderRing();
    }));
  document.querySelectorAll('input[name="dsRingSrc"]').forEach(r =>
    r.addEventListener('change', async () => {
      if (!_ring) return;
      _ring.sourceUrl = r.value;
      _workingPair.src = r.value;
      await chrome.storage.local.set({ ds_ring: _ring });
      storageSaveWorkingPair();
      if (typeof syncRingFollowers === 'function') syncRingFollowers();
      renderWorkingPair();
      renderRing();
    }));

  _ringRenderMatrix();
}

// ── The deployment × target-org matrix ──────────────────────────
function _ringTargets() {
  const ring = _ring || { orgs: [], sourceUrl: '' };
  return ring.orgs.filter(u => _orgKey(u) !== _orgKey(ring.sourceUrl || ''));
}

function _ringRenderMatrix() {
  const body = eid('dsRingBody');
  if (!body) return;
  const ring = _ring || { orgs: [], sourceUrl: '' };
  const targets = _ringTargets();

  if (!ring.sourceUrl || !targets.length) {
    body.innerHTML = `<div class="ds-empty-page">
      <div class="ds-empty-icon">${window.sftkCatSvg ? window.sftkCatSvg('sleep', 64) : '🔄'}</div>
      <div class="ds-empty-title">Configure the ring first</div>
      <div class="ds-empty-sub">Pick at least two orgs above and mark one ⦿ source of truth.</div>
    </div>`;
    return;
  }

  const profiles = _profiles.filter(p => p.tree && !p.ephemeral);
  if (!profiles.length) {
    body.innerHTML = `<div class="ds-seq-empty">No deployments yet — create one in 📦 Data Deployment; it becomes a row here.</div>`;
    return;
  }

  const ls = _liveOrgSet();
  const now = Date.now();
  const cell = (p, tUrl) => {
    const k = _orgKey(tUrl);
    // Native lastScan is only valid for the ring cell when the profile's own
    // pair IS the ring flow (same source AND same target) — a lastScan from a
    // different source org describes a different flow entirely.
    const native = _orgKey(p.targetOrg || '') === k
      && _orgKey(p.sourceOrg || '') === _orgKey(ring.sourceUrl || '')
      && p.lastScan?.runAt;
    const s = native
      ? { runAt: p.lastScan.runAt,
          missing: (p.lastScan.missingInTarget || []).length,
          changed: (p.lastScan.changed || []).length,
          extra: (p.lastScan.onlyInTarget || []).length,
          status: p.lastScan.status }
      : (p.ringScans || {})[`${_orgKey(ring.sourceUrl || '')}|${k}`];
    const live = [...ls].some(u => _orgKey(u) === k);
    const badge = live ? '' : `<span class="ds-ring-offline" title="Org not open in a Chrome tab — open it to scan or push">⚫</span>`;
    if (!s) return `<div class="ds-ring-cell ds-ring-cell-unknown" data-ring-cell="${esc(p.id)}|${esc(tUrl)}">
      ${badge}<span class="ds-ring-unknown">not scanned</span>
      <button class="ds-btn ds-btn-xs" data-ring-scan1="${esc(p.id)}|${esc(tUrl)}" ${live ? '' : 'disabled'}>🔎</button>
    </div>`;
    const drift = (s.missing || 0) + (s.changed || 0) + (s.extra || 0);
    const age = s.runAt ? timeAgo(s.runAt) : '';
    const stale = s.runAt && (now - new Date(s.runAt).getTime() > 86400000);
    return `<div class="ds-ring-cell ${drift === 0 ? 'ds-ring-ok' : 'ds-ring-drift'}" data-ring-cell="${esc(p.id)}|${esc(tUrl)}">
      ${badge}
      ${drift === 0
        ? `<span class="ds-ring-clean">✓ in sync</span>`
        : `<span class="ds-ring-counts" title="${s.missing} missing · ${s.changed} changed · ${s.extra} only in target">
             ${s.missing ? `<b class="ds-ring-m">${s.missing}</b>` : ''}${s.changed ? `<b class="ds-ring-c">${s.changed}</b>` : ''}${s.extra ? `<b class="ds-ring-e">${s.extra}</b>` : ''}
           </span>`}
      <span class="ds-ring-age${stale ? ' ds-ring-stale' : ''}" title="${stale ? 'Scan is over a day old' : ''}">${esc(age)}</span>
      <span class="ds-ring-cell-acts">
        <button class="ds-btn ds-btn-xs" data-ring-scan1="${esc(p.id)}|${esc(tUrl)}" ${live ? '' : 'disabled'} title="Re-scan this org">🔎</button>
        <button class="ds-btn ds-btn-xs" data-ring-rec="${esc(p.id)}|${esc(tUrl)}" ${live ? '' : 'disabled'} title="Open Reconcile against this org (fresh scan)">⚖</button>
      </span>
    </div>`;
  };

  body.innerHTML = `
    <div class="ds-ring-matrix" style="--ring-cols:${targets.length}">
      <div class="ds-ring-head">
        <div class="ds-ring-rowhdr">Deployment <span class="ds-oc-sub">from ${esc(orgLabel(ring.sourceUrl))}</span></div>
        ${targets.map(t => `<div class="ds-ring-colhdr" title="${esc(t)}">${esc(orgLabel(t))} ${prodBadge(t)}</div>`).join('')}
      </div>
      ${profiles.map(p => `
        <div class="ds-ring-row">
          <div class="ds-ring-rowhdr">
            <span class="ds-ring-pname">${esc(p.name)}</span>
            <span class="ds-ring-pobj">${esc(p.tree.objectType || '')}</span>
            <span class="ds-ring-row-acts">
              <button class="ds-btn ds-btn-xs ds-btn-primary" data-ring-plan="${esc(p.id)}" title="Scan every open target fresh, then propose the operations for ALL of them on one page — push missing, overwrite changed — and run the ones you tick">▶ Sync plan…</button>
              <button class="ds-btn ds-btn-xs" data-ring-scanall="${esc(p.id)}" title="Refresh the drift counts for every open ring target (no changes)">🔎 Scan</button>
              <button class="ds-btn ds-btn-xs" data-ring-push="${esc(p.id)}" title="Fan-out: push this deployment's records from ${esc(orgLabel(ring.sourceUrl))} to targets you pick (full record set)">🌐 Push…</button>
            </span>
          </div>
          ${targets.map(t => cell(p, t)).join('')}
        </div>`).join('')}
    </div>
    <div class="ds-pk-note" style="margin-top:8px">Counts refresh when you scan — cells show missing · changed · only-in-target.
    ⚖ opens a full Reconcile against that org. Every row flows FROM the ring's source of truth — a deployment's own source pair applies only outside the ring.</div>`;

  body.querySelectorAll('[data-ring-scan1]').forEach(b =>
    b.addEventListener('click', () => { const [pid, t] = b.dataset.ringScan1.split('|'); _ringScanOne(pid, t, b); }));
  body.querySelectorAll('[data-ring-scanall]').forEach(b =>
    b.addEventListener('click', () => _ringScanAll(b.dataset.ringScanall, b)));
  body.querySelectorAll('[data-ring-rec]').forEach(b =>
    b.addEventListener('click', () => { const [pid, t] = b.dataset.ringRec.split('|'); _ringOpenReconcile(pid, t); }));
  // Ring pushes flow from the ring's source of truth — same rule as ring
  // scans — with the ring targets pre-checked in the fan-out modal.
  body.querySelectorAll('[data-ring-plan]').forEach(b =>
    b.addEventListener('click', () => _ringOpenPlan(b.dataset.ringPlan)));
  body.querySelectorAll('[data-ring-push]').forEach(b =>
    b.addEventListener('click', () =>
      window.openFanOut?.(b.dataset.ringPush, { src: _ring?.sourceUrl, preselect: _ringTargets() })));
}

// ── Scans ────────────────────────────────────────────────────────
// Ring scans reuse runDiffScan on a shallow clone with the target swapped —
// full matching-config fidelity (M3a: the clone carries the same tree, so
// scan.matching resolves identically). Only summary counts are persisted.
function _ringScanKey(tgtUrl) {
  return `${_orgKey(_ring?.sourceUrl || '')}|${_orgKey(tgtUrl)}`;
}

async function _ringScanOne(profileId, tgtUrl, btn) {
  const p = _profiles.find(x => x.id === profileId);
  if (!p) return;
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  try {
    // THE RING'S PREMISE: data flows FROM the source of truth. The clone
    // overrides the deployment's own sourceOrg — a deployment created months
    // ago against a different pair still scans golden-org → target here
    // (user bug: a profile born on org A errored "open org A in a tab" even
    // though the ring source was org B and the header said "FROM B").
    const res = await runDiffScan({ ...p, sourceOrg: _ring.sourceUrl, targetOrg: tgtUrl, ephemeral: true });
    if (res?.error) throw new Error(res.error);
    p.ringScans = p.ringScans || {};
    p.ringScans[_ringScanKey(tgtUrl)] = {
      runAt: res.runAt || new Date().toISOString(),
      missing: (res.missingInTarget || []).length,
      changed: (res.changed || []).length,
      extra: (res.onlyInTarget || []).length,
      status: res.status || 'success',
    };
    // M3c: ring scans run on clones — persist this scan's confirmed 1:1
    // pairs into the REAL profile's match memory. ONLY when the ring flow's
    // source equals the profile's own source (memory pairs are src-specific).
    if (typeof window.sftkLearnPairs === 'function' && res.learnedPairs?.length
        && _orgKey(p.sourceOrg || '') === _orgKey(_ring.sourceUrl || '')) {
      window.sftkLearnPairs(p.id, tgtUrl, res.learnedPairs);
    }
    await storageSaveProfiles();
  } catch (e) {
    const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(e.message) : { message: e.message };
    showToast(`Scan failed for ${orgLabel(tgtUrl)}: ${fe.message}`, 'error', 6000);
  }
  _ringRenderMatrix();
}

async function _ringScanAll(profileId, btn) {
  const targets = _ringTargets();
  const ls = _liveOrgSet();
  if (btn) { btn.disabled = true; }
  let done = 0;
  for (const t of targets) {
    if (![...ls].some(u => _orgKey(u) === _orgKey(t))) continue;   // closed org
    if (btn) btn.textContent = `⏳ ${++done}/${targets.length}`;
    await _ringScanOne(profileId, t, null);
  }
  _ringRenderMatrix();
}

// Per-cell repair: ephemeral clone of the REAL profile (same tree, mappings,
// matching config) against the chosen target — the org-compare pattern.
async function _ringOpenReconcile(profileId, tgtUrl) {
  const p = _profiles.find(x => x.id === profileId);
  if (!p) return;
  const ephemeral = {
    ...p,
    id: `ring_${Date.now()}_${p.id}`,
    name: `${p.name} · ${orgLabel(_ring.sourceUrl)} → ${orgLabel(tgtUrl)}`,
    sourceOrg: _ring.sourceUrl,   // ring flow, not the profile's birth pair
    targetOrg: tgtUrl,
    lastScan: null,
    ringScans: undefined,
    ephemeral: true,
  };
  showToast(`Scanning ${orgLabel(tgtUrl)}…`, 'info', 2500);
  const res = await runDiffScan(ephemeral);
  if (res?.error) {
    const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(res.error) : { message: res.error };
    showToast(`Scan failed: ${fe.message}`, 'error', 6000);
    return;
  }
  ephemeral.lastScan = res;
  // Refresh the summary cell from this fresh scan too.
  p.ringScans = p.ringScans || {};
  p.ringScans[_ringScanKey(tgtUrl)] = {
    runAt: res.runAt || new Date().toISOString(),
    missing: (res.missingInTarget || []).length,
    changed: (res.changed || []).length,
    extra: (res.onlyInTarget || []).length,
    status: res.status || 'success',
  };
  if (typeof window.sftkLearnPairs === 'function' && res.learnedPairs?.length
      && _orgKey(p.sourceOrg || '') === _orgKey(_ring.sourceUrl || '')) {
    window.sftkLearnPairs(p.id, tgtUrl, res.learnedPairs);
  }
  storageSaveProfiles().catch(() => {});
  _reconcileProfile = ephemeral;
  _currentView = 'reconcile';
  document.querySelectorAll('.ds-nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-view="ring"]')?.classList.add('active');
  renderReconcile();
}

// ════════════════════════════════════════════════════════════════
// SYNC PLAN — all secondary orgs, one page (user request)
// ════════════════════════════════════════════════════════════════
// Fresh-scans every open target, then ONE modal proposes the operations per
// org — "push N missing" / "overwrite M changed" checkboxes — and a single
// Run executes everything ticked, org by org. Extras (only-in-target) stay
// in the full per-org Reconcile (deletes deserve that UI's guards).
// M4 — render the last scheduled-probe result (from ds_sched_drift). Honest
// about scope: a count probe is not a scan, and skipped pairs are listed with
// their reasons rather than blending into "in sync".
async function _ringRenderSchedPanel() {
  const el = eid('dsRingSchedPanel');
  if (!el) return;
  let data = null;
  try { data = (await chrome.storage.local.get('ds_sched_drift')).ds_sched_drift || null; } catch (_) {}
  if (!data) { el.innerHTML = ''; return; }
  const s = data.summary || { checked: 0, drifted: 0, skipped: 0 };
  const drifted = (data.rows || []).filter(r => !r.skip && r.drifted);
  const skipped = (data.rows || []).filter(r => r.skip);
  el.innerHTML = `
    <div class="ds-pk-note" style="margin:0 0 8px;${s.drifted ? 'border-left:3px solid #C23934;padding-left:10px' : ''}">
      ⏰ Last drift check: <strong>${esc(timeAgo(data.ts))}</strong> —
      ${s.drifted ? `<strong style="color:#C23934">🔴 ${s.drifted} pair(s) drifted</strong>` : s.checked ? '✓ no count drift' : 'nothing probed'}
      · ${s.checked} checked${s.skipped ? ` · ⏭ ${s.skipped} skipped` : ''}
      <span style="font-size:11px;color:var(--subtext)"> (count probe — value changes need a 🔎 scan)</span>
      ${drifted.slice(0, 8).map(r => `<div style="font-size:12px;margin-top:3px">🔴 <strong>${esc(r.profileName || r.obj)}</strong> → ${esc(orgLabel(r.tgt))}: source ${r.srcCount} vs target ${r.tgtCount} record(s)</div>`).join('')}
      ${drifted.length > 8 ? `<div style="font-size:11px">…and ${drifted.length - 8} more</div>` : ''}
      ${skipped.slice(0, 4).map(r => `<div style="font-size:11px;color:var(--subtext);margin-top:2px">⏭ ${esc(r.profileName || r.obj || 'ring')}${r.tgt ? ` → ${esc(orgLabel(r.tgt))}` : ''}: ${esc(r.reason || r.skip)}</div>`).join('')}
      ${skipped.length > 4 ? `<div style="font-size:11px;color:var(--subtext)">…and ${skipped.length - 4} more skipped</div>` : ''}
    </div>`;
}

async function _ringOpenPlan(profileId) {
  const p = _profiles.find(x => x.id === profileId);
  if (!p || !_ring?.sourceUrl) return;
  const targets = _ringTargets();
  const ls = _liveOrgSet();
  const open = targets.filter(u => [...ls].some(x => _orgKey(x) === _orgKey(u)));
  const closed = targets.filter(u => ![...ls].some(x => _orgKey(x) === _orgKey(u)));
  if (!open.length) { showToast('No ring target is open in a tab', 'warning', 5000); return; }

  showModal(`
    <div class="ds-modal-header">▶ Sync plan — ${esc(p.name)}</div>
    <div class="ds-modal-body">
      <div class="ds-pk-hint" style="margin-bottom:8px">Source of truth: <strong>${esc(orgLabel(_ring.sourceUrl))}</strong> 👑 — below is what each target needs to match it. Tick what to apply, then <strong>▶ Run</strong>. Nothing runs until you click Run.</div>
      <div id="dsPlanRows">${window.sftkCatSm ? sftkCatSm('Scanning…') : 'Scanning…'}</div>
      ${closed.length ? `<div class="ds-pk-note">⏭ Not open (skipped): ${closed.map(u => esc(orgLabel(u))).join(', ')}</div>` : ''}
    </div>
    <div class="ds-modal-footer">
      <span id="dsPlanTotal" style="margin-right:auto;font-size:12px;color:var(--subtext)"></span>
      <button class="ds-btn" data-dsaction="closeModal">Close</button>
      <button class="ds-btn ds-btn-primary" id="dsPlanRun" disabled>▶ Run selected</button>
    </div>`);

  // Fresh scans — full buckets kept in memory for the run step.
  const plans = [];
  for (const tgt of open) {
    try {
      const res = await runDiffScan({ ...p, sourceOrg: _ring.sourceUrl, targetOrg: tgt, ephemeral: true });
      if (res?.error) plans.push({ tgt, error: res.error });
      else {
        plans.push({ tgt, res });
        p.ringScans = p.ringScans || {};
        p.ringScans[_ringScanKey(tgt)] = {
          runAt: res.runAt || new Date().toISOString(),
          missing: (res.missingInTarget || []).length,
          changed: (res.changed || []).length,
          extra: (res.onlyInTarget || []).length,
          status: res.status || 'success',
        };
      }
    } catch (e) { plans.push({ tgt, error: e.message }); }
    const el = eid('dsPlanRows');
    if (el) el.innerHTML = (window.sftkCatSm ? sftkCatSm(`Scanning… ${plans.length} / ${open.length}`) : `${plans.length}/${open.length}`);
  }
  storageSaveProfiles().catch(() => {});

  const rowsEl = eid('dsPlanRows');
  if (!rowsEl) return;   // modal closed mid-scan
  // Per-record selection (user 2026-07-17: "has to show the records and let
  // the user select them"). Each op lists its records behind a fold; the op
  // checkbox is the master toggle. Beyond REC_CAP rendered rows, the overflow
  // follows the master checkbox (noted inline — nothing is silently dropped).
  const REC_CAP = 500;
  const recName = r => (typeof sftkMatchKeyLabel === 'function' ? sftkMatchKeyLabel(r.matchKey || '') : (r.matchKey || '')) || r.sourceId || r.targetId || '?';
  rowsEl.innerHTML = plans.map((pl, i) => {
    if (pl.error) {
      const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(pl.error) : { message: pl.error };
      return `<div class="ds-plan-org ds-plan-err"><strong>${esc(orgLabel(pl.tgt))}</strong> — ❌ ${esc(fe.message)}</div>`;
    }
    const missing = pl.res.missingInTarget || [];
    const changedR = pl.res.changed || [];
    const extras = pl.res.onlyInTarget || [];
    pl.pushOverflow = missing.slice(REC_CAP).map(r => r.sourceId).filter(Boolean);
    pl.ovwOverflow  = changedR.slice(REC_CAP).map(r => r.sourceId).filter(Boolean);
    const m = missing.length, c = changedR.length, x = extras.length;
    const clean = !m && !c && !x;
    // Changed rows carry the differing fields — show them so "overwrite"
    // stops being abstract ("Rose Gonzalez — Phone, Email").
    const diffFields = r => (r.fields || []).map(f => (f && f.field) || f).filter(Boolean);
    const recList = (rows, kind, checked, withFields) => `
      <details class="ds-plan-recs"><summary>show ${rows.length} record${rows.length !== 1 ? 's' : ''}…</summary>
        <div class="ds-plan-reclist">
          ${rows.slice(0, REC_CAP).map(r => `<label class="ds-plan-rrow">
            <input type="checkbox" class="ds-plan-r ds-plan-r-${kind}" data-idx="${i}" value="${esc(r.sourceId || '')}" ${checked ? 'checked' : ''}>
            <span>${esc(recName(r))}</span>
            ${withFields && diffFields(r).length ? `<span class="ds-plan-rfields" title="Fields whose values differ from the source">${esc(diffFields(r).slice(0, 4).join(', '))}${diffFields(r).length > 4 ? '…' : ''}</span>` : ''}</label>`).join('')}
          ${rows.length > REC_CAP ? `<div class="ds-pk-note">…and ${rows.length - REC_CAP} more — they follow the checkbox above; open ⚖ Reconcile for the full list.</div>` : ''}
        </div>
      </details>`;
    // The scan's buckets are capped (studio-scan.js slices at 5,000). This plan
    // WRITES from them, so a cap here means "Add N of N" is a floor presented as
    // a total — and the push checkbox is on by default. Disclose it on the same
    // panel that already discloses the REC_CAP display slice below; hiding the
    // larger truncation while flagging the smaller one reads as scrupulous and
    // is the more misleading of the two.
    const capKinds = [m ? 'push' : null, c ? 'overwrite' : null, x ? 'del' : null].filter(Boolean);
    const capNote = (typeof window.sftkCappedWriteNote === 'function' && capKinds.length)
      ? window.sftkCappedWriteNote(pl.res, capKinds, p.tree.objectType)
      : { lines: [] };
    return `
      <div class="ds-plan-org" data-plan-idx="${i}">
        ${capNote.lines.length ? `<div class="ds-pk-note ds-plan-capwarn">⚠ ${capNote.lines.map(esc).join('<br>')}</div>` : ''}
        <div class="ds-plan-org-hdr"><strong>${esc(orgLabel(pl.tgt))}</strong> ${prodBadge(pl.tgt)}
          ${clean ? '<span class="ds-ring-clean">✓ in sync — nothing to do</span>'
                  : `<span class="ds-plan-sum" data-plan-sum="${i}"></span>`}</div>
        ${m ? `<div class="ds-plan-opblock"><label class="ds-plan-op"><input type="checkbox" class="ds-plan-push" data-idx="${i}" checked>
            ⬆ Add <strong class="ds-plan-cnt" data-cnt="push-${i}">${m}</strong> of ${m} record${m !== 1 ? 's' : ''} <span class="ds-plan-op-why">— in the source, missing here</span></label>
            ${recList(missing, 'push', true, false)}</div>` : ''}
        ${c ? `<div class="ds-plan-opblock"><label class="ds-plan-op"><input type="checkbox" class="ds-plan-ovw" data-idx="${i}">
            ✏ Overwrite <strong class="ds-plan-cnt" data-cnt="ovw-${i}">0</strong> of ${c} record${c !== 1 ? 's' : ''} <span class="ds-plan-op-why">— values differ; the source's values win</span></label>
            ${recList(changedR, 'ovw', false, true)}</div>` : ''}
        ${x ? `<div class="ds-plan-opblock"><div class="ds-plan-op ds-plan-extras">🔵 ${x} record${x !== 1 ? 's' : ''} exist only here, not in the source <span class="ds-plan-op-why">— deletes are never run from this plan; review them in
            <a href="#" class="ds-plan-rec" data-idx="${i}">⚖ Reconcile</a></span></div>
            <details class="ds-plan-recs"><summary>show ${x} record${x !== 1 ? 's' : ''}…</summary>
              <div class="ds-plan-reclist">${extras.slice(0, 100).map(r => `<div class="ds-plan-rrow ds-plan-rro">${esc(recName(r))}</div>`).join('')}
              ${x > 100 ? `<div class="ds-pk-note">…and ${x - 100} more in ⚖ Reconcile.</div>` : ''}</div>
            </details></div>` : ''}
      </div>`;
  }).join('');

  // Master op checkbox ↔ record rows ↔ live count in the op label.
  const recount = (kind, i) => {
    const master = rowsEl.querySelector(`.ds-plan-${kind}[data-idx="${i}"]`);
    const rows = [...rowsEl.querySelectorAll(`.ds-plan-r-${kind}[data-idx="${i}"]`)];
    const overflow = kind === 'push' ? (plans[i].pushOverflow || []) : (plans[i].ovwOverflow || []);
    const n = rows.filter(r => r.checked).length + (master?.checked ? overflow.length : 0);
    const cntEl = rowsEl.querySelector(`[data-cnt="${kind}-${i}"]`);
    if (cntEl) cntEl.textContent = String(n);
    if (master && rows.length) {
      const some = rows.some(r => r.checked), all = rows.every(r => r.checked);
      master.checked = some; master.indeterminate = some && !all;
    }
    return n;
  };
  // Live "what will actually happen" summaries — per org card + footer total.
  const updPlanUI = () => {
    let tAdd = 0, tOvw = 0, orgsTouched = 0;
    plans.forEach((pl, i) => {
      if (pl.error) return;
      const a = recount('push', i), o = recount('ovw', i);
      const sum = rowsEl.querySelector(`[data-plan-sum="${i}"]`);
      if (sum) sum.textContent = (a || o)
        ? `→ will get ${a ? `${a} new` : ''}${a && o ? ' + ' : ''}${o ? `${o} overwritten` : ''}`
        : '→ nothing selected';
      if (a || o) orgsTouched++;
      tAdd += a; tOvw += o;
    });
    const tot = eid('dsPlanTotal');
    if (tot) tot.textContent = (tAdd || tOvw)
      ? `Run will: add ${tAdd} · overwrite ${tOvw} — across ${orgsTouched} org${orgsTouched !== 1 ? 's' : ''}`
      : 'Nothing selected yet — tick an operation or records above';
  };
  rowsEl.querySelectorAll('.ds-plan-push, .ds-plan-ovw').forEach(cb =>
    cb.addEventListener('change', () => {
      const kind = cb.classList.contains('ds-plan-push') ? 'push' : 'ovw';
      rowsEl.querySelectorAll(`.ds-plan-r-${kind}[data-idx="${cb.dataset.idx}"]`).forEach(r => { r.checked = cb.checked; });
      updPlanUI();
    }));
  rowsEl.querySelectorAll('.ds-plan-r').forEach(cb =>
    cb.addEventListener('change', updPlanUI));
  updPlanUI();

  rowsEl.querySelectorAll('.ds-plan-rec').forEach(a =>
    a.addEventListener('click', e => {
      e.preventDefault();
      const pl = plans[+a.dataset.idx];
      closeModal();
      _ringOpenReconcile(profileId, pl.tgt);
    }));

  const runBtn = eid('dsPlanRun');
  if (runBtn) runBtn.disabled = false;
  runBtn?.addEventListener('click', async () => {
    runBtn.disabled = true;
    // The record checkboxes ARE the selection; overflow rows beyond REC_CAP
    // follow their master op checkbox (never silently dropped).
    const jobs = plans.map((pl, i) => {
      const pick = kind => [...rowsEl.querySelectorAll(`.ds-plan-r-${kind}[data-idx="${i}"]:checked`)]
        .map(cb => cb.value).filter(Boolean);
      const masterOn = kind => !!rowsEl.querySelector(`.ds-plan-${kind}[data-idx="${i}"]`)?.checked;
      return {
        pl, i,
        pushIds: pick('push').concat(masterOn('push') ? (pl.pushOverflow || []) : []),
        ovwIds:  pick('ovw').concat(masterOn('ovw') ? (pl.ovwOverflow || []) : []),
      };
    }).filter(j => !j.pl.error && (j.pushIds.length || j.ovwIds.length));
    if (!jobs.length) { showToast('Nothing selected', 'info'); runBtn.disabled = false; return; }

    // One typed confirm per production target, up front.
    for (const j of jobs) {
      if (cachedOrgType(j.pl.tgt) === 'production') {
        const ok = await confirmTypedProd(orgLabel(j.pl.tgt), 'sync-plan writes into PRODUCTION');
        if (!ok) { runBtn.disabled = false; return; }
      }
    }

    const srcSess = await getOrgSession(_ring.sourceUrl);
    if (!srcSess) { showToast('Source org tab closed — reopen it', 'error', 6000); runBtn.disabled = false; return; }

    for (const j of jobs) {
      const row = rowsEl.querySelector(`.ds-plan-org[data-plan-idx="${j.i}"] .ds-plan-org-hdr`);
      const note = document.createElement('span');
      note.className = 'ds-plan-status';
      note.textContent = ' ⏳ running…';
      row?.appendChild(note);
      try {
        const tgtSess = await getOrgSession(j.pl.tgt);
        if (!tgtSess) throw new Error('org tab closed');
        let pushed = 0, pushFailed = 0, ovwOk = 0, ovwFailed = 0;

        if (j.pushIds.length) {
          const ids = j.pushIds;
          const clone = { ...p, sourceOrg: _ring.sourceUrl, targetOrg: j.pl.tgt, ephemeral: true,
            tree: { ...((typeof treeForTarget === 'function') ? treeForTarget(p.tree, j.pl.tgt) : p.tree), recordIds: ids } };
          const result = await sendBg({ type: 'SF_EXECUTE_PROFILE_TRANSFER', profile: clone,
            srcOrgUrl: srcSess.orgUrl, srcSid: srcSess.sid, tgtOrgUrl: tgtSess.orgUrl, tgtSid: tgtSess.sid });
          if (result?.error) throw new Error(result.error);
          for (const s of Object.values(result.summary || {})) { pushed += s.created || 0; pushFailed += s.failed || 0; }
          _history.push({ id: genId('run'), profileId: p.id,
            srcOrgUrl: srcSess.orgUrl, tgtOrgUrl: tgtSess.orgUrl,
            sourceOrg: srcSess.orgUrl, targetOrg: tgtSess.orgUrl,
            startedAt: new Date().toISOString(), ...result,
            profileName: `${p.name} (sync plan)` });
        }
        if (j.ovwIds.length) {
          const scanClone = { ...p, sourceOrg: _ring.sourceUrl, targetOrg: j.pl.tgt, ephemeral: true, lastScan: j.pl.res };
          const ids = j.ovwIds;
          const out = await reconcileOverwrite(scanClone, p.tree.objectType, ids, j.pl.res.changed, srcSess, tgtSess);
          ovwOk = out?.ok || 0; ovwFailed = out?.failed || 0;
          _history.push({ id: genId('run'), kind: 'reconcile', profileId: p.id,
            srcOrgUrl: srcSess.orgUrl, tgtOrgUrl: tgtSess.orgUrl,
            sourceOrg: srcSess.orgUrl, targetOrg: tgtSess.orgUrl,
            startedAt: new Date().toISOString(),
            status: ovwFailed ? (ovwOk ? 'partial' : 'failed') : 'success',
            summary: { [p.tree.objectType]: { created: 0, failed: ovwFailed, updated: ovwOk } },
            errors: (out?.errors || []).slice(0, 20),
            profileName: `${p.name} (sync plan · overwrite)` });
        }
        note.textContent = ` ✅ ${j.pushIds.length ? `${pushed} pushed${pushFailed ? ` (${pushFailed} failed)` : ''}` : ''}${j.pushIds.length && j.ovwIds.length ? ' · ' : ''}${j.ovwIds.length ? `${ovwOk} overwritten${ovwFailed ? ` (${ovwFailed} failed)` : ''}` : ''}`;
        await _ringScanOne(p.id, j.pl.tgt, null);   // refresh the matrix cell
      } catch (e) {
        const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(e.message) : { message: e.message };
        note.textContent = ` ❌ ${fe.message}`;
      }
    }
    await storageSaveHistory();
    runBtn.textContent = '✓ Done';
  });
}

