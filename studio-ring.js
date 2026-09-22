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
    // The source of truth is PRESELECTED AND LOCKED in the ring (user
    // 2026-07-31 ruling), and — consolidation, user 2026-08-13: "change
    // source org only in the upper menu" — this panel no longer carries its
    // own ⦿ source radios. Membership (which orgs are IN the ring) lives
    // here; the crown moves ONLY via the topbar SOURCE menu (or its
    // explicit shortcuts: ↩ restore below, 👑 promote in the Builder — all
    // three call the same dsSetSourceOfTruth).
    return `
      <label class="ds-ring-org${inRing ? ' ds-ring-org-in' : ''}${isSrc ? ' ds-ring-org-locked' : ''}"
             ${isSrc ? 'title="This is the ring\'s source of truth, so it is always part of the ring. Pick a different source in the topbar SOURCE menu to move it."' : ''}>
        <input type="checkbox" class="ds-ring-cb" value="${esc(o.url)}" ${isSrc || inRing ? 'checked' : ''} ${isSrc ? 'disabled' : ''}>
        <span class="ds-ring-org-name">${esc(orgOptionLabel(o.url, o.label, ls))}</span>
        ${isSrc ? '<span class="ds-ring-src-lock">👑 source — always in the ring</span>' : ''}
        ${prodBadge(o.url)}
        <span style="flex:1"></span>
      </label>`;
  }).join('');

  setMain(`
    ${dsViewHeader({
      icon: 'repeat',
      title: 'Sync Ring',
      subtitle: 'One source of truth → every ring org. Scan to see drift; fan out to fix it.',
      help: 'One org is the 👑 source of truth; every other ring org is measured against it. Matrix cells are root-object counts from each pair’s last 🔎 scan (missing · changed · only-in-target) — a reading, not live state. Fix one org with ⚖ from its cell (it opens that pair on the Deploy page); preview a multi-org push with ▶ Sync Plan; deep-dive one deployment across all environments with 🌳 Tree diff.',
      // ring.orgs is the configured ring — the same array the configuration
      // panel below counts. Not "orgs known", not "orgs open".
      count: `${ring.orgs.length} org${ring.orgs.length !== 1 ? 's' : ''} in the ring`,
    })}

    <details class="ds-ring-cfg" ${cfgOpen ? 'open' : ''}>
      <summary class="ds-ring-cfg-sum"><strong>⚙ Ring configuration</strong>
        <span class="ds-oc-sub">${ring.orgs.length} org(s) in the ring${ring.sourceUrl ? ` · source: ${esc(orgLabel(ring.sourceUrl))}` : ''}</span>
      </summary>
      <div class="ds-ring-orgs">${orgRows || '<div class="ds-seq-empty">No orgs known — open them in Chrome tabs first.</div>'}</div>
      ${(() => {
        // With no crown, the topbar chip can still point at a working org
        // (_workingPair.src outlives ring teardown) — state the difference
        // and offer that org in one click. Historic note: this block predates
        // the consolidation, when the chip and the ring radios were two
        // different-looking controls for the same thing; the radios are gone
        // and the topbar is THE control now, but the one-click adopt stays
        // as a convenience (it routes through dsSetSourceOfTruth).
        const wp = (typeof _workingPair === 'object' && _workingPair?.src) || '';
        if (ring.sourceUrl) {
          const prev = ring.prevSourceUrl && _orgKey(ring.prevSourceUrl) !== _orgKey(ring.sourceUrl) ? ring.prevSourceUrl : '';
          return `<div class="ds-ring-sot-explain">👑 <strong>${esc(orgLabel(ring.sourceUrl))}</strong> is this ring's source of truth — every org below is compared against it, and the topbar SOURCE chip follows it.
            ${prev ? `<br><span style="font-size:11.5px;color:var(--subtext)">Previously <strong>${esc(orgLabel(prev))}</strong>${ring.prevSourceAt ? ` (until ${timeAgo(ring.prevSourceAt)})` : ''}.</span>
              <button class="ds-btn ds-btn-xs" id="dsRingRestoreCrown" title="Move the 👑 back to ${esc(orgLabel(prev))} — every ring surface re-points and every pair rescans, exactly like any crown change.">↩ restore ${esc(orgLabel(prev))} as the source of truth</button>` : ''}</div>`;
        }
        return `<div class="ds-ring-sot-explain ds-ring-sot-unset">
          No source of truth yet — pick one in the topbar <strong>SOURCE</strong> menu. It is what every other ring org gets compared against.
          ${wp ? `<br><span style="color:var(--subtext)">The topbar <strong>SOURCE</strong> chip currently points at <strong>${esc(orgLabel(wp))}</strong>; that's your working org for one-off comparisons, which is a separate setting.</span>
            <button class="ds-btn ds-btn-xs" id="dsRingAdoptWp" style="margin-left:6px">Use ${esc(orgLabel(wp))} as the source of truth</button>` : ''}
        </div>`;
      })()}
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

  // Adopt the topbar SOURCE as the ring's source of truth — the shared
  // setter joins it to the ring if it isn't a member yet.
  eid('dsRingAdoptWp')?.addEventListener('click', async () => {
    const url = (typeof _workingPair === 'object' && _workingPair?.src) || '';
    if (!url) return;
    await dsSetSourceOfTruth(url, `${orgLabel(url)} became the source of truth`);
  });

  // Config wiring — checkbox MEMBERSHIP only; the crown itself moves solely
  // through dsSetSourceOfTruth (topbar / ↩ restore / Builder 👑 promote).
  document.querySelectorAll('.ds-ring-cb').forEach(cb =>
    cb.addEventListener('change', async () => {
      const url = cb.value;
      if (!_ring) _ring = { orgs: [], sourceUrl: '' };
      if (cb.checked) { if (!_ring.orgs.some(u => _orgKey(u) === _orgKey(url))) _ring.orgs.push(url); }
      else {
        // The crown's own checkbox is disabled, so an untick can never be
        // the source — no silent-crown-fallback here (the old
        // `sourceUrl = orgs[0]` line was exactly the surprise move the
        // 2026-07-31 ruling banned; the setter is the only crown writer).
        _ring.orgs = _ring.orgs.filter(u => _orgKey(u) !== _orgKey(url));
      }
      await chrome.storage.local.set({ ds_ring: _ring });
      if (_ring.sourceUrl) { _workingPair.src = _ring.sourceUrl; storageSaveWorkingPair(); }
      if (typeof syncRingFollowers === 'function') syncRingFollowers();
      renderWorkingPair();
      renderRing();
    }));
  eid('dsRingRestoreCrown')?.addEventListener('click', async () => {
    const prev = _ring?.prevSourceUrl;
    if (!prev) return;
    await dsSetSourceOfTruth(prev, `${orgLabel(prev)} restored as the source of truth`);
  });

  _ringRenderMatrix();
}

// ── 👑 Re-baseline after a source-of-truth change ────────────────────
// "Every time you switch a source of truth it needs to rescan both orgs and
// update sync status and target orgs, etc." (user 2026-08-11). A crown move
// redefines EVERY pair in the ring — the old summaries describe flows that
// no longer exist (they stay parked under their old source-keyed entries),
// so every deployment × OPEN ring target rescans automatically and the
// deposits flow through the normal paths: ring tiles, parent-sync verdicts,
// match memory, lastScan — no surface waits for a click. Closed orgs are
// skipped honestly (they scan on next open, same as 🔎).
let _ringRebaselining = false;
let _ringRebaselineQueued = null;   // a crown change DURING a sweep queues, never drops
async function sftkRingRebaseline(reason) {
  // QA sweep 2026-08-16: a second crown change mid-sweep used to be
  // silently dropped — while the running sweep re-read the NEW crown per
  // scan, filing earlier pairs under a source key no reader consults (and
  // even scanning the new crown against itself). Queue the new request and
  // abort the stale sweep instead; the queued run rescans everything
  // against the final crown with a fresh target list.
  if (_ringRebaselining) { _ringRebaselineQueued = reason; return; }
  _ringRebaselining = true;
  try {
    const profiles = _profiles.filter(p => p.tree && !p.ephemeral);
    const targets  = _ringTargets();
    if (!profiles.length || !targets.length) return;
    const ls = _liveOrgSet();
    const lsKnown = (typeof _liveKnown === 'function') ? _liveKnown() : ls.size > 0;
    const open = targets.filter(t => !lsKnown || [...ls].some(u => _orgKey(u) === _orgKey(t)));
    const skipped = targets.length - open.length;
    if (!open.length) {
      showToast(`👑 ${reason} — no ring targets are open in Chrome tabs, so nothing could rescan. Open them and 🔎 Scan.`, 'warning', 6000);
      return;
    }
    // QA sweep 2026-08-11: an uncapped auto-sweep on a big ring is a silent
    // API storm — above a dozen pairs the user confirms the bill first.
    const pairCount = profiles.length * open.length;
    if (pairCount > 12 && !confirm(`👑 ${reason}.\n\nRe-baselining means ${pairCount} full scans (${profiles.length} deployment(s) × ${open.length} open target(s)) run now, back to back.\n\nRun them all? (Cancel = no rescan; cells re-scan individually via 🔎 as you need them.)`)) {
      showToast('Re-baseline skipped — ring cells keep their pre-move readings until scanned (🔎).', 'info', 6000);
      return;
    }
    showToast(`👑 ${reason} — rescanning ${profiles.length} deployment(s) × ${open.length} open target(s)…${skipped ? ` (${skipped} closed org(s) skipped)` : ''}`, 'info', 5000);
    const sweepSrc = _ring.sourceUrl;   // this sweep is FOR this crown
    let done = 0, interrupted = false;
    outer:
    for (const p of profiles) {
      for (const t of open) {
        if (_orgKey(_ring.sourceUrl || '') !== _orgKey(sweepSrc || '')) { interrupted = true; break outer; }
        if (_orgKey(t) === _orgKey(_ring.sourceUrl || '')) continue;   // never scan the crown against itself
        await _ringScanOne(p.id, t, null);
        done++;
      }
    }
    if (interrupted) {
      showToast(`👑 Source of truth changed again mid-sweep — restarting the re-baseline against the new crown.`, 'info', 5000);
    } else {
      showToast(`👑 Re-baseline complete — ${done} pair(s) rescanned against the new source of truth.${skipped ? ` ${skipped} closed org(s) still need a 🔎 when opened.` : ''}`, 'success', 5500);
    }
    if (_currentView === 'ring') _ringRenderMatrix();
  } catch (e) {
    showToast(`Re-baseline stopped: ${e?.message || e}`, 'error', 6000);
  } finally {
    _ringRebaselining = false;
    if (_ringRebaselineQueued) {
      const r = _ringRebaselineQueued;
      _ringRebaselineQueued = null;
      sftkRingRebaseline(r);
    }
  }
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
      <div class="ds-empty-sub">Tick at least two orgs above, and pick the source of truth in the topbar SOURCE menu.</div>
    </div>`;
    return;
  }

  const profiles = _profiles.filter(p => p.tree && !p.ephemeral);
  if (!profiles.length) {
    body.innerHTML = `<div class="ds-seq-empty">No deployments yet — create one in 📦 Data Deployment; it becomes a row here.</div>`;
    return;
  }

  const ls = _liveOrgSet();
  // Liveness is knowledge only after enumeration completed (_liveKnown) —
  // unknown must not paint every cell ⚫ with 🔎/⚖ disabled.
  const lsKnown = (typeof _liveKnown === 'function') ? _liveKnown() : ls.size > 0;
  const now = Date.now();
  const cell = (p, tUrl) => {
    const k = _orgKey(tUrl);
    // Native lastScan is only valid for the ring cell when the profile's own
    // pair IS the ring flow (same source AND same target) — a lastScan from a
    // different source org describes a different flow entirely.
    const native = _orgKey(p.targetOrg || '') === k
      && _orgKey(p.sourceOrg || '') === _orgKey(ring.sourceUrl || '')
      && p.lastScan?.runAt
      // A lastScan stamped with DIFFERENT orgs than the profile's current
      // pair describes an older configuration, not this cell — the stamps
      // exist precisely so consumers can detect a re-pointed profile.
      && (!p.lastScan.sourceOrg || _orgKey(p.lastScan.sourceOrg) === _orgKey(p.sourceOrg || ''))
      && (!p.lastScan.targetOrg || _orgKey(p.lastScan.targetOrg) === _orgKey(p.targetOrg || ''));
    const nat = native
      ? { runAt: p.lastScan.runAt,
          missing: (p.lastScan.missingInTarget || []).length,
          changed: (p.lastScan.changed || []).length,
          extra: (p.lastScan.onlyInTarget || []).length,
          fileMiss: (p.lastScan.fileDrift && !p.lastScan.fileDrift.error && p.lastScan.fileDrift.records) || 0,
          ...(p.lastScan.fileDrift?.error ? { fileErr: true } : {}),
          status: p.lastScan.status }
      : null;
    const s = sftkRingCellPick(nat, (p.ringScans || {})[`${_orgKey(ring.sourceUrl || '')}|${k}`]);
    const live = !lsKnown || [...ls].some(u => _orgKey(u) === k);
    const badge = live ? '' : `<span class="ds-ring-offline" title="Org not open in a Chrome tab — open it to scan or push">⚫</span>`;
    if (!s) return `<div class="ds-ring-cell ds-ring-cell-unknown" data-ring-cell="${esc(p.id)}|${esc(tUrl)}">
      ${badge}<span class="ds-ring-unknown">not scanned</span>
      <button class="ds-btn ds-btn-xs" data-ring-scan1="${esc(p.id)}|${esc(tUrl)}" ${live ? '' : 'disabled'}>🔎</button>
    </div>`;
    const drift = (s.missing || 0) + (s.changed || 0) + (s.extra || 0);
    const fMiss = s.fileMiss || 0;
    // A FAILED file check is UNKNOWN, not zero — never let it wear the
    // clean checkmark (the scan's own contract; QA sweep 2026-08-16).
    const fErr = !fMiss && !!s.fileErr;
    const age = s.runAt ? timeAgo(s.runAt) : '';
    const stale = s.runAt && (now - new Date(s.runAt).getTime() > 86400000);
    return `<div class="ds-ring-cell ${drift === 0 && !fMiss && !fErr ? 'ds-ring-ok' : 'ds-ring-drift'}" data-ring-cell="${esc(p.id)}|${esc(tUrl)}">
      ${badge}
      ${drift === 0
        ? (fMiss
          ? `<span class="ds-ring-counts" title="Fields in sync — 📎 ${fMiss} record(s) missing files. NOT fully synced until they move: ⚖ → 🟢 Synced tab → select & move."><b class="ds-ring-c">📎${fMiss}</b></span>`
          : fErr
          ? `<span class="ds-ring-counts" title="Fields in sync — but the 📎 file check FAILED, so file state is UNKNOWN, not zero. Rescan to verify."><b class="ds-ring-c">📎?</b></span>`
          : (p.tree?.children || []).length
          // Ring scans check the ROOT object only — a deployment with child
          // objects must never wear an unqualified checkmark here (user
          // 2026-08-18: "when childs are not deployed, it must not show as
          // synced"; load test: 50 parents clean, 1,850 children missing).
          ? `<span class="ds-ring-clean" title="ROOT object in sync. Ring scans do NOT check this deployment's ${(p.tree.children || []).length} child object(s) — open 🚀 Deploy and scan the child objects to verify them.">✓ root</span>`
          : `<span class="ds-ring-clean">✓ in sync</span>`)
        : `<span class="ds-ring-counts" title="${s.missing} missing · ${s.changed} changed · ${s.extra} only in target${fMiss ? ` · 📎 ${fMiss} missing files` : ''}">
             ${s.missing ? `<b class="ds-ring-m">${s.missing}</b>` : ''}${s.changed ? `<b class="ds-ring-c">${s.changed}</b>` : ''}${s.extra ? `<b class="ds-ring-e">${s.extra}</b>` : ''}${fMiss ? `<b class="ds-ring-c">📎</b>` : ''}
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
              <button class="ds-btn ds-btn-xs" data-ring-scanall="${esc(p.id)}" title="Refresh the drift counts for every open ring target (no changes)">🔎 Scan</button>
            </span>
          </div>
          ${targets.map(t => cell(p, t)).join('')}
        </div>`).join('')}
    </div>
    <div class="ds-pk-note" style="margin-top:8px">Counts refresh when you scan — cells show missing · changed · only-in-target.
    ⚖ opens Reconcile for that one target — fixes happen one target at a time. Every row flows FROM the ring's source of truth.</div>`;

  body.querySelectorAll('[data-ring-scan1]').forEach(b =>
    b.addEventListener('click', () => { const [pid, t] = b.dataset.ringScan1.split('|'); _ringScanOne(pid, t, b); }));
  body.querySelectorAll('[data-ring-scanall]').forEach(b =>
    b.addEventListener('click', () => _ringScanAll(b.dataset.ringScanall, b)));
  body.querySelectorAll('[data-ring-rec]').forEach(b =>
    b.addEventListener('click', () => { const [pid, t] = b.dataset.ringRec.split('|'); _ringOpenReconcile(pid, t); }));
}

// ── Scans ────────────────────────────────────────────────────────
// Ring scans reuse runDiffScan on a shallow clone with the target swapped —
// full matching-config fidelity (M3a: the clone carries the same tree, so
// scan.matching resolves identically). Only summary counts are persisted.
function _ringScanKey(tgtUrl, srcUrl) {
  // srcUrl lets in-flight scans key by the source they actually SCANNED —
  // the ring radios stay operable during a long scan-all, and re-reading
  // _ring.sourceUrl after the await would file old-source results under the
  // new source's key (QA sweep 2026-08-10).
  const src = srcUrl != null ? srcUrl : (_ring?.sourceUrl || '');
  return `${_orgKey(src)}|${_orgKey(tgtUrl)}`;
}

// Freshest-wins between a profile's native lastScan summary and its ring-scan
// summary for the same cell. Native used to have absolute priority, so on a
// row whose own pair IS the ring flow the 🔎 button scanned successfully,
// wrote ringScans… and the cell kept rendering the old lastScan forever
// (user 2026-08-10: "still in sync but not in sync" → "i clicked" → cell
// stuck at "21 · 55m ago" with two successful queries in the debug log).
function sftkRingCellPick(nat, rs) {
  if (!nat || !rs) return nat || rs || null;
  const tn = new Date(nat.runAt || 0).getTime();
  const tr = new Date(rs.runAt || 0).getTime();
  return tn >= tr ? nat : rs;
}

async function _ringScanOne(profileId, tgtUrl, btn) {
  const p = _profiles.find(x => x.id === profileId);
  if (!p) return;
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  // Capture the source ONCE — everything after the await must describe the
  // flow that was actually scanned, not whatever the radios say by then.
  const ringSrc = _ring.sourceUrl;
  try {
    // THE RING'S PREMISE: data flows FROM the source of truth. The clone
    // overrides the deployment's own sourceOrg — a deployment created months
    // ago against a different pair still scans golden-org → target here
    // (user bug: a profile born on org A errored "open org A in a tab" even
    // though the ring source was org B and the header said "FROM B").
    const res = await runDiffScan({ ...p, sourceOrg: ringSrc, targetOrg: tgtUrl, ephemeral: true });
    if (res?.error) throw new Error(res.error);
    p.ringScans = p.ringScans || {};
    p.ringScans[_ringScanKey(tgtUrl, ringSrc)] = {
      runAt: res.runAt || new Date().toISOString(),
      missing: (res.missingInTarget || []).length,
      changed: (res.changed || []).length,
      extra: (res.onlyInTarget || []).length,
      status: res.status || 'success',
      ...(res.fileDrift && !res.fileDrift.error && res.fileDrift.records ? { fileMiss: res.fileDrift.records } : {}),
      ...(res.fileDrift?.error ? { fileErr: true } : {}),
    };
    // M3c: ring scans run on clones — persist this scan's confirmed 1:1
    // pairs into the REAL profile's match memory. ONLY when the ring flow's
    // source equals the profile's own source (memory pairs are src-specific).
    if (typeof window.sftkLearnPairs === 'function' && res.learnedPairs?.length
        && _orgKey(p.sourceOrg || '') === _orgKey(ringSrc || '')) {
      window.sftkLearnPairs(p.id, tgtUrl, res.learnedPairs);
    }
    // Ring flow == the profile's own pair → this IS a native scan of that
    // profile. Deposit it as lastScan too, so Reconcile's "scanned Xm ago"
    // header and the ring cell describe the same moment (staleness law).
    // QA sweep 2026-08-10, two traps in the naive `p.lastScan = res`:
    //  · learnedPairs live in matchMemory, NEVER in lastScan (mirrors the
    //    native strip in refreshProfileDiff — ~200KB of duplicate ids
    //    against the chrome.storage quota otherwise);
    //  · the stamps must be the PROFILE's own URL strings — freshness
    //    consumers compare res.sourceOrg with ===, and the ring may hold a
    //    different string form of the same org, which would make every
    //    consumer reject this fresh scan as "stale (orgs changed)".
    if (_orgKey(p.sourceOrg || '') === _orgKey(ringSrc || '')
        && _orgKey(p.targetOrg || '') === _orgKey(tgtUrl)) {
      const dep = { ...res, sourceOrg: p.sourceOrg, targetOrg: p.targetOrg };
      delete dep.learnedPairs;
      p.lastScan = dep;
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
  // Unknown liveness (enumeration not completed) ≠ "all closed" — attempt
  // every target; _ringScanOne toasts per-org failures honestly.
  const lsKnown = (typeof _liveKnown === 'function') ? _liveKnown() : ls.size > 0;
  if (btn) { btn.disabled = true; }
  let done = 0;
  for (const t of targets) {
    if (lsKnown && ![...ls].some(u => _orgKey(u) === _orgKey(t))) continue;   // known-closed org
    // _ringScanOne re-renders the matrix, destroying the button we disabled
    // — re-find it each pass so progress stays visible and the freshly
    // rendered button stays disabled (no concurrent scan-all from a
    // double click; QA sweep 2026-08-10).
    btn = document.querySelector(`[data-ring-scanall="${profileId}"]`) || btn;
    if (btn) { btn.disabled = true; btn.textContent = `⏳ ${++done}/${targets.length}`; }
    else ++done;
    await _ringScanOne(profileId, t, null);
  }
  _ringRenderMatrix();
}

// Per-cell repair: ephemeral clone of the REAL profile (same tree, mappings,
// matching config) against the chosen target — the org-compare pattern.
async function _ringOpenReconcile(profileId, tgtUrl) {
  const p = _profiles.find(x => x.id === profileId);
  if (!p) return;
  const ringSrc = _ring.sourceUrl;   // capture once — see _ringScanKey note
  const ephemeral = {
    ...p,
    id: `ring_${Date.now()}_${p.id}`,
    // Origin stamp (mirrors _parentOf): runReconcile's post-run writeback
    // resolves the REAL profile through this — the clone's ring_* id isn't
    // in _profiles, so without it the ring cell stayed red after its own
    // ⚖ repair until a manual 🔎 (QA sweep 2026-08-10).
    _ringOf: { profileId: p.id },
    name: `${p.name} · ${orgLabel(ringSrc)} → ${orgLabel(tgtUrl)}`,
    sourceOrg: ringSrc,   // ring flow, not the profile's birth pair
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
  p.ringScans[_ringScanKey(tgtUrl, ringSrc)] = {
    runAt: res.runAt || new Date().toISOString(),
    missing: (res.missingInTarget || []).length,
    changed: (res.changed || []).length,
    extra: (res.onlyInTarget || []).length,
    status: res.status || 'success',
    ...(res.fileDrift && !res.fileDrift.error && res.fileDrift.records ? { fileMiss: res.fileDrift.records } : {}),
      ...(res.fileDrift?.error ? { fileErr: true } : {}),
  };
  if (typeof window.sftkLearnPairs === 'function' && res.learnedPairs?.length
      && _orgKey(p.sourceOrg || '') === _orgKey(ringSrc || '')) {
    window.sftkLearnPairs(p.id, tgtUrl, res.learnedPairs);
  }
  // Native pair → deposit into the real profile too (same rule — and same
  // strip + restamp — as _ringScanOne; the ephemeral clone keeps the full
  // res because its OWN orgs are the ring URLs, so its === checks pass).
  if (_orgKey(p.sourceOrg || '') === _orgKey(ringSrc || '')
      && _orgKey(p.targetOrg || '') === _orgKey(tgtUrl)) {
    const dep = { ...res, sourceOrg: p.sourceOrg, targetOrg: p.targetOrg };
    delete dep.learnedPairs;
    p.lastScan = dep;
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
