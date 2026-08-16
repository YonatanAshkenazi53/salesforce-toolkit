'use strict';
// ════════════════════════════════════════════════════════════════
// TREE DIFF — the record tree, compared across environments
// ════════════════════════════════════════════════════════════════
// User request: "show more than just numbers — show differences between the
// record TREE in a couple of environments and suggest data operations."
// Rows = the deployment's object tree (root → children → grandchildren),
// columns = environments. Each cell shows that node's buckets in that env
// plus a SUGGESTED operation line; each env column can open a fully-loaded
// Reconcile (root + child scans pre-run) where every suggestion is executable
// with all the usual guards. Scans run on ephemeral clones — the real
// profile's own lastScan is never touched.

// Suggest operations for one node's scan buckets. Pure — unit-testable.
// counts: { missing, changed, extra, link } · depth 0 = root.
function tdSuggest(counts, depth, insertOrder) {
  const ops = [];
  if (counts.missing) ops.push(`⬆ push ${counts.missing}${depth > 0 && insertOrder === 'childFirst' ? ' (child-first)' : ''}`);
  if (counts.changed) ops.push(`✏ overwrite ${counts.changed}`);
  if (counts.link)    ops.push(`🔗 relink ${counts.link}`);
  if (counts.extra)   ops.push(`🔵 review ${counts.extra} extra${counts.extra !== 1 ? 's' : ''}`);
  return ops;
}

// Flatten a profile tree to depth 2 with pathKeys ('0', '0.1', …). Pure.
function tdTreeNodes(tree) {
  const out = [{ pathKey: '', node: tree, depth: 0 }];
  (tree.children || []).forEach((c, i) => {
    out.push({ pathKey: String(i), node: c, depth: 1 });
    (c.children || []).forEach((g, j) => {
      out.push({ pathKey: `${i}.${j}`, node: g, depth: 2 });
    });
  });
  return out;
}

// Bucket counts for a node's scan result (root scan or child scan). Pure.
function tdCounts(scan) {
  if (!scan || scan.error) return null;
  return {
    missing: (scan.missingInTarget || []).length,
    changed: (scan.changed || []).length,
    extra: (scan.onlyInTarget || []).length,
    link: (scan.linkMismatch || []).length,
    identical: (scan.identical || []).length,
  };
}

// ── View state ──────────────────────────────────────────────────
let _tdProfileId = null;
let _tdEnvs      = [];      // selected env urls
let _tdResults   = null;    // [{ url, label, clone|null, error|null }]

// The tree's source org — the RING'S source of truth when a ring is
// configured (same rule as ring scans/pushes: multi-org surfaces always flow
// FROM the source of truth, never from a deployment's birth pair), else the
// deployment's own source.
function _tdSrcUrl(p) {
  return (typeof _ring === 'object' && _ring?.sourceUrl && (_ring.orgs || []).length >= 2)
    ? _ring.sourceUrl : (p.sourceOrg || '');
}

window.openTreeDiff = function (profileId) {
  const p = _profiles.find(x => x.id === profileId);
  if (!p || !p.tree) { showToast('Deployment not found', 'error'); return; }
  _tdProfileId = profileId;
  _tdResults = null;
  const srcUrl = _tdSrcUrl(p);
  // Default envs: ring targets when a ring exists, else the profile's target.
  const ringTargets = (typeof _ring === 'object' && _ring?.orgs?.length)
    ? _ring.orgs.filter(u => _orgKey(u) !== _orgKey(srcUrl))
    : [];
  _tdEnvs = ringTargets.length ? ringTargets
    : profileTargets(p).filter(u => _orgKey(u) !== _orgKey(srcUrl));
  _currentView = 'treediff';
  document.querySelectorAll('.ds-nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-view="profiles"]')?.classList.add('active');
  renderTreeDiffPage();
};

function renderTreeDiffPage() {
  const p = _profiles.find(x => x.id === _tdProfileId);
  if (!p) { renderView('profiles'); return; }
  const srcUrl = _tdSrcUrl(p);
  const fromRing = !!(typeof _ring === 'object' && _ring?.sourceUrl &&
    (_ring.orgs || []).length >= 2 && _orgKey(_ring.sourceUrl) === _orgKey(srcUrl));
  const orgs = allMapOrgs().filter(o => _orgKey(o.url) !== _orgKey(srcUrl));
  const ls = _liveOrgSet();

  const envRows = orgs.map(o => `
    <label class="ds-fanout-org">
      <input type="checkbox" class="ds-td-env" value="${esc(o.url)}"
             ${_tdEnvs.some(u => _orgKey(u) === _orgKey(o.url)) ? 'checked' : ''}>
      <span>${esc(orgOptionLabel(o.url, o.label, ls))}</span>
      ${prodBadge(o.url)}
    </label>`).join('');

  setMain(`
    ${dsViewHeader({
      // 'nodes' — the subject is the record tree itself; this sub-page has no
      // sidebar row, so there is no nav glyph to mirror.
      icon: 'nodes',
      title: `Tree diff — ${esc(p.name)}`,
      help: 'The overview of the compare trio. Rows are this deployment’s record tree; columns are environments. Each cell shows that node’s scan buckets in that environment (missing / changed / extra / link) plus a suggested operation. Nothing runs from this screen — opening an environment launches ⚖ Reconcile pre-loaded with these scans, where every suggestion executes with the usual guards. Same scans as 🔄 Refresh state, so the numbers always agree.',
      subtitle: `The record tree from <strong>${esc(orgLabel(srcUrl))}</strong>${fromRing ? ` <span class="ds-td-sot" title="This is your Sync Ring's source of truth — every multi-org surface (ring scans, pushes, tree diff) reads FROM it. Change it in 🔄 Sync Ring or the topbar chip.">👑 source of truth</span>` : ''}, compared node-by-node across environments — with suggested operations`,
      actions: `<button class="ds-btn" data-dsaction="switchView" data-arg="profiles">‹ Back</button>`,
    })}
    <details class="ds-ring-cfg" ${_tdResults ? '' : 'open'}>
      <summary class="ds-ring-cfg-sum"><strong>Environments</strong>
        <span class="ds-oc-sub">${_tdEnvs.length} selected</span></summary>
      <div class="ds-ring-orgs">${envRows || '<div class="ds-seq-empty">No other orgs known.</div>'}</div>
      <div style="padding:0 14px 12px"><button class="ds-btn ds-btn-primary" id="dsTdScan">🔎 Scan environments</button></div>
    </details>
    <div id="dsTdBody">${_tdResults ? '' : `<div class="ds-pk-note">Pick environments and scan — the whole tree (root, children, grandchildren) is scanned per environment.</div>`}</div>`);

  document.querySelectorAll('.ds-td-env').forEach(cb =>
    cb.addEventListener('change', () => {
      _tdEnvs = [...document.querySelectorAll('.ds-td-env:checked')].map(c => c.value);
      const sub = document.querySelector('.ds-ring-cfg-sum .ds-oc-sub');
      if (sub) sub.textContent = `${_tdEnvs.length} selected`;
    }));
  eid('dsTdScan')?.addEventListener('click', () => _tdRunScans(p));
  if (_tdResults) _tdRenderMatrix(p);
}

async function _tdRunScans(p) {
  const body = eid('dsTdBody');
  if (!body || !_tdEnvs.length) { showToast('Pick at least one environment', 'warning'); return; }
  const srcUrl = _tdSrcUrl(p);
  // The tree is READ from the source of truth — without it open there is
  // nothing to compare. Fail loudly up front, not per-cell.
  const srcSess = await getOrgSession(srcUrl);
  if (!srcSess) {
    body.innerHTML = `<div class="ds-pk-note" style="border-left:3px solid #ef4444;padding-left:10px">
      ❌ <strong>${esc(orgLabel(srcUrl))}</strong> (the source of truth) is not open in a Chrome tab —
      the record tree is read from it. Open the org in a tab, then scan again.</div>`;
    showToast(`Open ${orgLabel(srcUrl)} in a tab first — it is the source of the tree`, 'error', 6000);
    return;
  }
  const nodes = tdTreeNodes(p.tree);
  const childKeys = nodes.filter(n => n.depth === 1).map(n => n.pathKey);
  const grandKeys = nodes.filter(n => n.depth === 2).map(n => n.pathKey);
  _tdResults = [];

  for (const url of _tdEnvs) {
    const label = orgLabel(url);
    body.innerHTML = `<div class="ds-init-loading">${window.sftkCat ? sftkCat(`Scanning ${esc(label)} — root + ${childKeys.length + grandKeys.length} child node(s)…`) : 'Scanning…'}</div>`;
    const sess = await getOrgSession(url);
    if (!sess) { _tdResults.push({ url, label, error: 'org not open in a Chrome tab — open it and re-scan' }); continue; }
    try {
      const clone = { ...p, sourceOrg: srcUrl, targetOrg: url, ephemeral: true, lastScan: null, ringScans: undefined };
      const root = await runDiffScan(clone);
      if (root?.error) throw new Error(root.error);
      clone.lastScan = root;
      // Children first (grandchildren scope by their parent's child scan).
      for (const k of childKeys) await scanReconcileChild(clone, k);
      for (const k of grandKeys) await scanReconcileChild(clone, k);
      _tdResults.push({ url, label, clone });
      // Staleness law — Tree Diff is the DEEPEST scan in the app and used to
      // deposit NOTHING (QA sweep 2026-08-11): the ring matrix and parent
      // verdicts stayed older than the truth the user just watched being
      // computed. Freshest-wins summaries land on the real profile, and the
      // per-object verdicts (root AND every child node) feed the Builder
      // chips / advisor checklists for this exact pair.
      try {
        if (!p.ephemeral && root.status === 'success' && typeof _ringScanKey === 'function'
            && typeof _ring !== 'undefined' && _ring?.sourceUrl
            && _orgKey(_ring.sourceUrl) === _orgKey(srcUrl)) {
          p.ringScans = p.ringScans || {};
          const rk = _ringScanKey(url, srcUrl);
          const prev = p.ringScans[rk];
          if (!(prev?.runAt && root.runAt && new Date(prev.runAt).getTime() > new Date(root.runAt).getTime())) {
            p.ringScans[rk] = { runAt: root.runAt, status: 'success',
              missing: (root.missingInTarget || []).length,
              changed: (root.changed || []).length,
              extra:   (root.onlyInTarget || []).length,
              ...(root.fileDrift && !root.fileDrift.error && root.fileDrift.records ? { fileMiss: root.fileDrift.records } : {}),
              ...(root.fileDrift?.error ? { fileErr: true } : {}) };
          }
        }
        if (typeof sftkParentSyncPut === 'function' && root.status === 'success' && root.objectType) {
          sftkParentSyncPut(srcUrl, url, root.objectType, {
            missing: (root.missingInTarget || []).length,
            changed: (root.changed || []).length,
            extra:   (root.onlyInTarget || []).length,
            at: root.runAt });
          for (const k of [...childKeys, ...grandKeys]) {
            const cs = clone.lastScan?.children?.[k];
            if (cs && cs.status === 'success' && cs.objectType) {
              sftkParentSyncPut(srcUrl, url, cs.objectType, {
                missing: (cs.missingInTarget || []).length,
                changed: (cs.changed || []).length,
                extra:   (cs.onlyInTarget || []).length,
                at: cs.runAt || root.runAt });
            }
          }
        }
      } catch (_) { /* advisory surfaces only */ }
    } catch (e) {
      const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(e.message) : { message: e.message };
      _tdResults.push({ url, label, error: fe.message });
    }
  }
  // One save for the whole sweep — the ring summaries deposited above.
  try { storageSaveProfiles(); } catch (_) {}
  _tdRenderMatrix(p);
}

function _tdNodeScan(result, pathKey) {
  if (!result.clone) return null;
  if (pathKey === '') return result.clone.lastScan;
  return result.clone.lastScan?.children?.[pathKey] || null;
}

function _tdRenderMatrix(p) {
  const body = eid('dsTdBody');
  if (!body || !_tdResults) return;
  const nodes = tdTreeNodes(p.tree);

  const head = `<div class="ds-td-row ds-td-head">
    <div class="ds-td-node">Tree node</div>
    ${_tdResults.map((r, i) => `<div class="ds-td-col">
      ${esc(r.label)} ${prodBadge(r.url)}
      ${r.clone ? `<button class="ds-btn ds-btn-xs" data-td-rec="${i}" title="Open a fully-loaded Reconcile against this environment — every suggested operation is executable there with the usual guards">⚖ operate</button>` : ''}
    </div>`).join('')}
  </div>`;

  const rows = nodes.map(({ pathKey, node, depth }) => {
    const obj = node.objectType || node.childSObject || '?';
    // 🎯 how this node's records are recognized across orgs (M3a config).
    const mf = sftkMatchingFromNode(node).fields.join(' + ');
    const cells = _tdResults.map(r => {
      // Errors say WHY inline — a bare icon with a hover-only tooltip is not
      // "easy to understand" (user directive 2026-07-17).
      if (r.error) return `<div class="ds-td-cell ds-td-err" title="${esc(r.error)}">❌ <span class="ds-td-errmsg">${esc(r.error)}</span></div>`;
      const scan = _tdNodeScan(r, pathKey);
      if (!scan) return `<div class="ds-td-cell ds-td-na" title="not scanned (parent scan failed?)">·</div>`;
      if (scan.error) return `<div class="ds-td-cell ds-td-err" title="${esc(scan.error)}">⚠ <span class="ds-td-errmsg">${esc(String(scan.error).slice(0, 120))}</span></div>`;
      const c = tdCounts(scan);
      // 🎯 compact accuracy — only shown when matching wasn't fully confident
      // (blank or duplicated keys); hover explains what dragged it down.
      const acc = (typeof sftkScanAccuracy === 'function') ? sftkScanAccuracy(scan) : null;
      const accChip = (acc && acc.pct < 100) ? ` ${accuracyChip(acc, true)}` : '';
      const drift = c.missing + c.changed + c.extra + c.link;
      if (!drift) return `<div class="ds-td-cell ds-td-ok" title="${c.identical} record(s), all in sync">✓ in sync${accChip}</div>`;
      const ops = tdSuggest(c, depth, node.insertOrder);
      return `<div class="ds-td-cell ds-td-drift">
        <span class="ds-td-counts" title="${c.missing} missing · ${c.changed} changed · ${c.extra} only in target${c.link ? ` · ${c.link} link mismatch` : ''}">
          ${c.missing ? `<b class="ds-ring-m">${c.missing}</b>` : ''}${c.changed ? `<b class="ds-ring-c">${c.changed}</b>` : ''}${c.extra ? `<b class="ds-ring-e">${c.extra}</b>` : ''}${c.link ? `<b class="ds-td-link">🔗${c.link}</b>` : ''}${accChip}
        </span>
        <span class="ds-td-suggest">${esc(ops.join(' · '))}</span>
      </div>`;
    }).join('');
    return `<div class="ds-td-row">
      <div class="ds-td-node ds-td-depth${depth}">
        ${depth > 0 ? '<span class="ds-td-twig">↳</span>' : ''}
        <strong>${esc(obj)}</strong>
        ${depth > 0 && node.field ? `<span class="ds-td-via">via ${esc(node.field)}</span>` : ''}
        ${node.insertOrder === 'childFirst' ? '<span class="ds-td-cf" title="Inserted before its parent, reconnected after">⤴ child-first</span>' : ''}
        <span class="ds-td-match" title="Records are recognized as 'the same' across orgs by ${esc(mf)}. Configure per node in the deployment's ✏ Edit → 🔎 Pick records → Matching — single field, composite (up to 4 fields), or external ID; the 🧪 analyzer there grades candidates against live orgs.">🎯 by ${esc(mf)}</span>
      </div>${cells}</div>`;
  }).join('');

  body.innerHTML = `
    <div class="ds-td-matrix" style="--td-cols:${_tdResults.length}">${head}${rows}</div>
    <div class="ds-pk-note" style="margin-top:8px">Suggestions per node: ⬆ push missing · ✏ overwrite changed · 🔗 relink mismatched links · 🔵 review extras (deletes).
    Click <strong>⚖ operate</strong> on an environment to open its Reconcile with every node's scan pre-loaded — all operations run there with the full guards (data fixes, prod confirms, orphan protection).</div>`;

  body.querySelectorAll('[data-td-rec]').forEach(b =>
    b.addEventListener('click', () => {
      const r = _tdResults[+b.dataset.tdRec];
      if (!r?.clone) return;
      _reconcileProfile = r.clone;
      _currentView = 'reconcile';
      document.querySelectorAll('.ds-nav-btn').forEach(x => x.classList.remove('active'));
      document.querySelector('[data-view="profiles"]')?.classList.add('active');
      renderReconcile();
    }));
}
