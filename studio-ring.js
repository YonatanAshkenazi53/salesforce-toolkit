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
    </details>

    <div id="dsRingBody"></div>`);

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
              <button class="ds-btn ds-btn-xs" data-ring-scanall="${esc(p.id)}" title="Scan every open ring target">🔎 all</button>
              <button class="ds-btn ds-btn-xs" data-ring-push="${esc(p.id)}" title="Push from ${esc(orgLabel(ring.sourceUrl))} to the ring targets (M1 fan-out)">🌐 push</button>
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
