'use strict';
// ════════════════════════════════════════════════════════════════
// ALL OPEN ORGS (formerly the Sync Ring) — how far apart are my orgs?
// ════════════════════════════════════════════════════════════════
// Campaign 4 phase 2 (user 2026-10-01): there is no crowned "source of truth"
// any more. This page is a deployment × open-org matrix: pick ONE source here,
// and every other org open in Chrome becomes a column. Every cell answers "how
// far out of sync is THIS org for THIS dataset" — with per-cell repair (⚖ opens
// Reconcile for that pair) and per-row scan (🔎).
//
// The orgs are simply the ones open in Chrome (sftkOpenOrgs); the source is the
// preferred source (currentSourceOrg), changed only through dsSetPreferredSource,
// which re-points nothing and rescans nothing. Per-target scan summaries live
// on the profile as profile.ringScans[srcKey|tgtKey] = { runAt, missing,
// changed, extra, status } — COUNTS ONLY (full buckets would bloat
// chrome.storage; the per-cell ⚖ re-scans fresh for full fidelity anyway).
// The storage names (ringScans, view 'ring') are kept for compatibility.

// The source this page measures from: the preferred source, but only when it
// is one of the orgs open in Chrome right now (nothing else can be scanned).
function _ringActiveSource() {
  const src = (typeof currentSourceOrg === 'function') ? currentSourceOrg() : '';
  if (!src) return '';
  const open = (typeof sftkOpenOrgs === 'function') ? sftkOpenOrgs() : [];
  return open.some(o => _orgKey(o.url) === _orgKey(src)) ? src : '';
}

function renderRing() {
  const open = (typeof sftkOpenOrgs === 'function') ? sftkOpenOrgs() : [];
  const src  = _ringActiveSource();
  const srcOpts = open.map(o =>
    `<option value="${esc(o.url)}" ${src && _orgKey(o.url) === _orgKey(src) ? 'selected' : ''}>${esc(o.label)}</option>`).join('');

  setMain(`
    ${dsViewHeader({
      icon: 'repeat',
      title: 'All open orgs',
      subtitle: 'Every deployment against every org open in Chrome — from one source you pick here.',
      help: 'Pick a source org, and every other org open in Chrome is measured against it. Matrix cells are root-object counts from each pair’s last 🔎 scan (missing · changed · only-in-target) — a reading, not live state. Fix one org with ⚖ from its cell (it opens that pair on the Deploy page). Changing the source here only changes which org the columns are measured from; it moves nothing and rescans nothing.',
      count: `${open.length} org${open.length !== 1 ? 's' : ''} open`,
    })}

    ${open.length < 2 ? `
    <div class="ds-empty-page">
      <div class="ds-empty-icon">${window.sftkCatSvg ? window.sftkCatSvg('sleep', 64) : '🔄'}</div>
      <div class="ds-empty-title">Open at least two orgs in Chrome</div>
      <div class="ds-empty-sub">Every org with a Salesforce tab open shows up here as a column. Open another one and come back.</div>
    </div>` : `
    <div class="ds-ring-srcrow" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 10px;font-size:12.5px">
      <label class="ds-lbl" for="dsRingSrc" style="margin:0">Source</label>
      <select id="dsRingSrc" class="ds-select" aria-label="Source org — the other open orgs are measured against it">
        ${src ? '' : '<option value="" selected disabled>— pick the source —</option>'}${srcOpts}
      </select>
    </div>
    <div id="dsRingBody"></div>`}`);

  eid('dsRingSrc')?.addEventListener('change', async e => {
    const url = e.target.value;
    if (url) await dsSetPreferredSource(url);   // repaints the view
  });

  if (open.length >= 2) _ringRenderMatrix();
}

// ── The deployment × open-org matrix ────────────────────────────
function _ringTargets() {
  const src = _ringActiveSource();
  const open = (typeof sftkOpenOrgs === 'function') ? sftkOpenOrgs() : [];
  return open.map(o => o.url).filter(u => !src || _orgKey(u) !== _orgKey(src));
}

function _ringRenderMatrix() {
  const body = eid('dsRingBody');
  if (!body) return;
  const ring = { sourceUrl: _ringActiveSource() };
  const targets = _ringTargets();

  if (!ring.sourceUrl || !targets.length) {
    body.innerHTML = `<div class="ds-empty-page">
      <div class="ds-empty-icon">${window.sftkCatSvg ? window.sftkCatSvg('sleep', 64) : '🔄'}</div>
      <div class="ds-empty-title">Pick the source</div>
      <div class="ds-empty-sub">Choose the source org above — every other open org becomes a column measured against it.</div>
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
          extra: (p.lastScan.onlyInTarget || []).length, ambiguous: (p.lastScan.ambiguous || []).length,
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
    const drift = (s.missing || 0) + (s.changed || 0) + (s.extra || 0) + (s.ambiguous || 0);
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
        : `<span class="ds-ring-counts" title="${s.missing} missing · ${s.changed} changed · ${s.extra} only in target${s.ambiguous ? ` · ⚠ ${s.ambiguous} ambiguous — resolve in 🚀 Deploy → ⚠ Ambiguous` : ''}${fMiss ? ` · 📎 ${fMiss} missing files` : ''}">
             ${s.missing ? `<b class="ds-ring-m">${s.missing}</b>` : ''}${s.changed ? `<b class="ds-ring-c">${s.changed}</b>` : ''}${s.extra ? `<b class="ds-ring-e">${s.extra}</b>` : ''}${s.ambiguous ? `<b class="ds-ring-a">⚠${s.ambiguous}</b>` : ''}${fMiss ? `<b class="ds-ring-c">📎</b>` : ''}
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
              <button class="ds-btn ds-btn-xs" data-ring-scanall="${esc(p.id)}" title="Refresh the drift counts for every other open org (no changes)">🔎 Scan</button>
            </span>
          </div>
          ${targets.map(t => cell(p, t)).join('')}
        </div>`).join('')}
    </div>
    <div class="ds-pk-note" style="margin-top:8px">Counts refresh when you scan — cells show missing · changed · only-in-target.
    ⚖ opens Reconcile for that one target — fixes happen one target at a time. Every row flows FROM the source you picked above.</div>`;

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
  const ringSrc = _ringActiveSource();
  try {
    // Data flows FROM the source picked on this page. The scan-only clone
    // overrides the deployment's own sourceOrg — a deployment created months
    // ago against a different pair still scans picked-source → target here
    // (user bug: a profile born on org A errored "open org A in a tab" even
    // though the header said "FROM B").
    const res = await runDiffScan({ ...p, sourceOrg: ringSrc, targetOrg: tgtUrl, ephemeral: true });
    if (res?.error) throw new Error(res.error);
    p.ringScans = p.ringScans || {};
    p.ringScans[_ringScanKey(tgtUrl, ringSrc)] = {
      runAt: res.runAt || new Date().toISOString(),
      missing: (res.missingInTarget || []).length,
      changed: (res.changed || []).length,
      extra: (res.onlyInTarget || []).length, ambiguous: (res.ambiguous || []).length,
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
    // Name the org whose read failed — "source query failed" is the SOURCE
    // (the source), not the target this tile belongs to (user 2026-09-30: the
    // toast said "Scan failed for trailheads5" about a query on trailheads4).
    const msg = String(e?.message || e);
    const onSrc = /^source query failed/i.test(msg);
    const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(msg.replace(/^(source|target) query failed:\s*/i, '')) : { message: msg };
    const who = onSrc ? `reading ${orgLabel(ringSrc)} (the source)` : `reading ${orgLabel(tgtUrl)}`;
    showToast(`${p.name ? `${p.name}: ` : ''}scan failed ${who} — ${fe.message}${fe.hint ? ` ${fe.hint}` : ''}`, 'error', 8000);
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

// Per-cell repair: set the picked pair on the SAVED deployment (it is only the
// last-used pair), then open Reconcile on it. No ring_* clone any more (user
// 2026-10-01): the scan, the repair and the history all belong to the real
// deployment.
async function _ringOpenReconcile(profileId, tgtUrl) {
  const p = _profiles.find(x => x.id === profileId);
  if (!p) return;
  const src = _ringActiveSource();
  if (!src) return;
  p.sourceOrg = src;
  p.targetOrg = tgtUrl;
  delete p.sourcePinned; delete p.targetOrgs; delete p._srcCrownMoved;   // old ring fields, retired
  try { await storageSaveProfiles(); } catch (_) {}
  window.openReconcile(p.id);
}
