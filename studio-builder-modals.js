'use strict';
// ════════════════════════════════════════════════════════════════
// FIELD MAPPING MODAL  — map source field names → target field names
// ════════════════════════════════════════════════════════════════
async function openFieldMappingModal(pathStr) {
  const node = getNodeByPath(_editingProfile.tree, pathStr);
  if (!node) return;
  const objType = node.objectType || node.childSObject || '';

  if (!node.fieldMappings) node.fieldMappings = {};
  const mappings = node.fieldMappings; // live reference — { srcApiName: tgtApiName }
  // Per-target exceptions — sparse overlay { orgKey: { srcField: tgtName|null } }.
  // Edited live like mappings; persisted on Apply (dropped when empty).
  const overrides = node.fieldMappingOverrides || {};
  // Id can never transfer (Salesforce assigns it on insert) — purge any
  // legacy mapping entry so it can't pollute SOQL/compareFields, and the
  // row filter below keeps it out of the UI even when the profile carries
  // a stale cached field list (node._meta.availableFields) from before
  // the Id exclusion existed.
  delete mappings.Id;

  // Diagnostic — log what the modal is loading so we can tell the difference
  // between "save didn't persist" and "load didn't restore". The previous bug
  // (strip identity → invisible save) is fixed; if a future report comes in
  // claiming the mapping was lost, this line plus the Apply-time round-trip
  // log together pinpoint exactly which step failed.
  const existingCount = Object.keys(mappings).length;
  window.SFToolkitDebug?.log('transfer', 'info',
    `Field mapping modal OPEN: node "${objType}" already has ${existingCount} saved entries ` +
    `(srcOrg=${node.fieldMappingOrgs?.src || '—'}, tgtOrg=${node.fieldMappingOrgs?.tgt || '—'})`);

  // ── Org list (all orgs detected from open browser tabs) ──────────────────
  function allOrgs() {
    const orgs = [];
    const seen = new Set();
    for (const s of _allSessions) {
      if (!seen.has(s.orgUrl)) {
        seen.add(s.orgUrl);
        orgs.push({ url: s.orgUrl, sid: s.sid, label: s.label || s.orgUrl });
      }
    }
    return orgs;
  }

  // ── Per-org describe (reuses global cache) ────────────────────────────────
  async function loadFields(orgUrl, orgSid) {
    const desc = await describe(objType, orgUrl, orgSid);
    if (!desc) return null;
    // Id is never createable and never copyable — Salesforce assigns it on
    // insert. Don't list it in the Field Mapping modal at all; if it's in
    // fieldMappings it pollutes compareFields and breaks SOQL SELECT clauses
    // ("duplicate field selected: Id"). Name kept in ALWAYS so it still
    // appears on objects where the primary name field isn't strictly
    // createable (e.g. Case → CaseNumber would otherwise hide).
    const ALWAYS = new Set(['Name']);
    return (desc.fields || [])
      .filter(f => f.name !== 'Id' && (f.createable || ALWAYS.has(f.name)))
      .map(f => ({ name: f.name, label: f.label || f.name, type: f.type }))
      .sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name));
  }

  // ── State — restore saved org pair if present ─────────────────────────────
  // Priority for default org URLs:
  //   1. Node-level field-mapping-specific override (legacy)
  //   2. Profile-level sourceOrg/targetOrg (the new source of truth)
  //   3. Current popup org (last-ditch fallback for source)
  let srcFields = node._meta?.availableFields || [];
  let tgtFields = [];
  let srcUrl    = node.fieldMappingOrgs?.src || _editingProfile?.sourceOrg || _orgUrl || '';
  let tgtUrl    = node.fieldMappingOrgs?.tgt || _editingProfile?.targetOrg || '';
  let srcLoaded = node._meta?.fieldsLoaded || false;
  let tgtLoaded = false;
  let srcLoadFailed = false;
  let tgtLoadFailed = false;

  // ── Auto-map: match by API name first, then by normalised label ───────────
  function normalise(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  function runAutoMap() {
    if (!srcFields.length || !tgtFields.length) return;
    const byApi   = new Map(tgtFields.map(f => [f.name.toLowerCase(), f.name]));
    const byLabel = new Map(tgtFields.map(f => [normalise(f.label), f.name]));
    srcFields.forEach(sf => {
      const exactTgt = byApi.get(sf.name.toLowerCase());
      if (exactTgt) { mappings[sf.name] = exactTgt; return; }
      const labelTgt = byLabel.get(normalise(sf.label));
      if (labelTgt) { mappings[sf.name] = labelTgt; }
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function datalistHtml() {
    if (!tgtLoaded || !tgtFields.length) return '';
    return `<datalist id="dsFmTgtList">${tgtFields.map(f =>
      `<option value="${esc(f.name)}">${esc(f.label)} (${esc(f.name)})</option>`
    ).join('')}</datalist>`;
  }

  function mappingCount() {
    return Object.entries(mappings).filter(([k, v]) => v !== null && v && v.trim() && v.trim() !== k).length;
  }

  function skipCount() {
    return Object.values(mappings).filter(v => v === null).length;
  }

  function countLabel() {
    const diff  = mappingCount();
    const skips = skipCount();
    const parts = [];
    if (diff)  parts.push(`${diff} field${diff !== 1 ? 's' : ''} remapped`);
    if (skips) parts.push(`${skips} excluded`);
    if (!parts.length) return tgtLoaded ? 'All fields map identically' : 'No mappings set';
    return parts.join(' · ');
  }

  function rowClass(sf) {
    const v = mappings[sf.name];
    if (v === null) return ' ds-fm-row-skip';
    if (!v || !v.trim()) return '';
    if (v.trim() === sf.name) return ' ds-fm-row-same';
    return ' ds-fm-row-diff';
  }

  // Human-readable type labels
  const TYPE_LABEL = {
    string: 'Text', textarea: 'Text area', boolean: 'Checkbox',
    double: 'Number', integer: 'Integer', currency: 'Currency',
    percent: 'Percent', date: 'Date', datetime: 'Date/Time',
    time: 'Time', email: 'Email', phone: 'Phone', url: 'URL',
    picklist: 'Picklist', multipicklist: 'Multi-select', reference: 'Lookup',
    id: 'ID', base64: 'Base64', encryptedstring: 'Encrypted',
    address: 'Address', location: 'Location', combobox: 'Combobox',
  };
  function typeLbl(t) { return TYPE_LABEL[t] || t || ''; }

  function renderRows(filter = '') {
    const lc       = filter.toLowerCase();
    const tgtByApi = new Map(tgtFields.map(f => [f.name, f]));
    const pool = srcFields.filter(f => {
      // Id is never transferable — hide it even when a stale cached field
      // list (saved before the loadFields Id-exclusion) still contains it.
      if (f.name === 'Id') return false;
      // Keep explicitly excluded fields visible so users can restore them
      if (node.fields && !node.fields.includes(f.name) && !(f.name in mappings)) return false;
      if (filter && !f.label.toLowerCase().includes(lc) && !f.name.toLowerCase().includes(lc)) return false;
      return true;
    });
    if (!pool.length) return '<div class="ds-picker-empty">No fields to map.</div>';
    return pool.map(f => {
      const isSkip = mappings[f.name] === null;
      const val    = isSkip ? '' : (mappings[f.name] || '');
      const isDiff = !isSkip && val && val !== f.name;
      const isRef  = f.type === 'reference';
      const srcType = typeLbl(f.type);
      const tgtF    = !isSkip && tgtLoaded ? tgtByApi.get(val || f.name) : null;
      const tgtType = tgtF ? typeLbl(tgtF.type) : null;
      const mismatch = tgtType && tgtType !== srcType;

      const srcTypeBadge = `<span class="ds-fm-type-badge ds-fm-type-${esc(f.type)}" title="Source type: ${esc(f.type)}">${esc(srcType)}</span>`;
      const tgtTypeBadge = tgtType
        ? `<span class="ds-fm-type-badge ${mismatch ? 'ds-fm-type-mismatch' : 'ds-fm-type-ok'}"
             title="${mismatch ? `⚠ Type mismatch: source is ${esc(srcType)}, target is ${esc(tgtType)}` : `Target type: ${esc(tgtType)}`}"
           >${esc(tgtType)}${mismatch ? ' ⚠' : ''}</span>`
        : (!isSkip && tgtLoaded
          ? `<span class="ds-fm-type-badge ds-fm-type-mismatch"
               title="No field named ${esc(val || f.name)} exists on ${esc(objType)} in the TARGET org — this field will be skipped at run time (e.g. State/Country picklist fields when the feature is off in the target).">⚠ not in target</span>`
          : '');

      return `<div class="ds-fm-row${rowClass(f)}">
        <div class="ds-fm-src-cell">
          <span class="ds-fm-src-name" title="${esc(f.name)}">${esc(f.label)}</span>
          <span class="ds-fm-src-meta">
            <span class="ds-fm-src-api">${esc(f.name)}</span>
            ${srcTypeBadge}${isRef ? '<span class="ds-fm-ref-badge">🔗</span>' : ''}
          </span>
        </div>
        <span class="ds-fm-arrow">${isSkip ? '—' : '→'}</span>
        <div class="ds-fm-tgt-wrap">
          <input class="ds-input ds-input-sm ds-fm-tgt-input${isDiff ? ' ds-fm-tgt-diff' : ''}" type="text"
                 list="dsFmTgtList"
                 data-src="${esc(f.name)}"
                 placeholder="${isSkip ? '— not transferred —' : esc(f.name)}"
                 value="${esc(val)}"
                 autocomplete="off"
                 ${isSkip ? 'disabled' : ''}
                 title="${isSkip ? 'Field excluded from transfer' : 'Leave blank or enter same name to copy unchanged'}">
          ${!isSkip ? tgtTypeBadge : ''}
          ${isDiff ? `<button class="ds-fm-reset-btn" data-reset="${esc(f.name)}" title="Reset to source name">↺</button>` : ''}
        </div>
        ${(typeof profileTargets === 'function' && profileTargets(_editingProfile).length > 1)
          ? `<button class="ds-fm-ov-btn" data-ov="${esc(f.name)}" title="Per-target exceptions — map this field to a DIFFERENT name (or skip it) in specific target orgs">⚙</button>` : ''}
        <button class="ds-fm-skip-btn" data-skip="${esc(f.name)}"
                title="${isSkip ? 'Re-include this field' : 'Exclude field from transfer'}">${isSkip ? '↩' : '✕'}</button>
      </div>`;
    }).join('');
  }

  // ── Org selector options ──────────────────────────────────────────────────
  function orgOptions(selectedUrl, placeholder, targetsOnly) {
    let orgs = allOrgs();
    // The "validate against" selector only offers the deployment's own
    // targets — previewing against an org you don't deploy to is noise.
    if (targetsOnly && typeof profileTargets === 'function') {
      const keys = new Set(profileTargets(_editingProfile).map(u => _orgKey(u)));
      const filtered = orgs.filter(o => keys.has(_orgKey(o.url)));
      if (filtered.length) orgs = filtered;
    }
    if (!orgs.length) return `<span class="ds-fm-no-orgs">No connected orgs</span>`;
    return `<select class="ds-input ds-input-sm ds-fm-org-sel">
      <option value="">${esc(placeholder)}</option>
      ${orgs.map(o => `<option value="${esc(o.url)}" ${o.url === selectedUrl ? 'selected' : ''}>${esc(orgOptionLabel(o.url, o.label))}</option>`).join('')}
    </select>`;
  }

  // ── Multi-target cross-check (user 2026-07-20: "mapping looks broken
  // because we can have multi targets") — ONE mapping applies to EVERY
  // target, so load each CONNECTED target's field list and badge any mapped
  // name that doesn't exist somewhere. The "validate against" org is only
  // the previewed schema; these badges cover the rest (closed targets are
  // 🧪 Check all targets' job).
  let xtSets = null, xtLoading = false;
  async function loadCrossTargets() {
    if (xtSets || xtLoading) { xtAnnotate(); return; }
    const tgts = (typeof profileTargets === 'function') ? profileTargets(_editingProfile) : [];
    if (tgts.length < 2) return;
    xtLoading = true;
    const sets = [];
    const status = [];   // honest per-target check outcome — shown in the note
    for (const url of tgts) {
      const org = allOrgs().find(o => _orgKey(o.url) === _orgKey(url));
      if (!org) { status.push({ label: orgLabel(url), ok: 'closed' }); continue; }
      const fields = await loadFields(org.url, org.sid);
      if (fields) {
        sets.push({ label: orgLabel(url), key: _orgKey(url), names: new Set(fields.map(f => f.name)) });
        status.push({ label: orgLabel(url), ok: 'ok' });
      } else status.push({ label: orgLabel(url), ok: 'failed' });
    }
    xtSets = sets.length >= 2 ? sets : null;
    xtLoading = false;
    // Say EXACTLY which targets were verified — a closed target silently
    // skipping the check is how "multi-target" quietly becomes one target
    // (user report 2026-07-22).
    const note = eid('dsFmXtStatus');
    if (note) {
      const unchecked = status.filter(s => s.ok !== 'ok');
      note.innerHTML = `One mapping, <strong>all ${tgts.length} targets</strong> — cross-checked: `
        + status.map(s => s.ok === 'ok'
          ? `<strong>✓ ${esc(s.label)}</strong>`
          : `<strong style="color:#b91c1c">✗ ${esc(s.label)}</strong> (${s.ok === 'closed' ? 'not open in a tab — NOT checked' : 'schema load failed'})`).join(' · ')
        + (unchecked.length
          ? `<br>⚠ Open the unchecked org(s) in Chrome tabs and reopen this modal to validate against them. Until then, only the checked schemas are verified.`
          : ` — every mapped name below is verified against every target (⚠ badges mark the gaps; ⚙ sets per-target exceptions).`);
    }
    xtAnnotate();
  }
  // Effective target-side name for one source field in one org: per-target
  // override (may be null = excluded there) → base mapping → same name.
  function effFor(src, orgKey) {
    const ov = overrides[orgKey];
    if (ov && Object.prototype.hasOwnProperty.call(ov, src)) return ov[src];
    if (mappings[src] === null) return null;
    return (mappings[src] && mappings[src].trim()) || src;
  }
  function ovCount(src) {
    return Object.keys(overrides).filter(k =>
      overrides[k] && Object.prototype.hasOwnProperty.call(overrides[k], src)).length;
  }
  function xtAnnotate() {
    document.querySelectorAll('#dsFmList .ds-fm-tgt-input').forEach(inp => {
      const src = inp.dataset.src;
      if (!src) return;
      const wrap = inp.closest('.ds-fm-tgt-wrap');
      if (!wrap) return;
      wrap.querySelector('.ds-fm-xt-badge')?.remove();
      wrap.querySelector('.ds-fm-ov-chip')?.remove();
      const n = ovCount(src);
      if (n) {
        const c = document.createElement('span');
        c.className = 'ds-fm-type-badge ds-fm-ov-chip';
        c.title = `${n} per-target exception(s) set for this field — click ⚙ to edit.`;
        c.textContent = `🎯 ${n}`;
        wrap.appendChild(c);
      }
      if (!xtSets || mappings[src] === null) return;
      const missing = xtSets.filter(s => {
        const eff = effFor(src, s.key);
        return eff !== null && !s.names.has(eff);
      }).map(s => s.label);
      if (missing.length) {
        const b = document.createElement('span');
        b.className = 'ds-fm-type-badge ds-fm-type-mismatch ds-fm-xt-badge';
        b.title = `⚠ the mapped name does not exist on ${objType} in: ${missing.join(', ')} — runs into those orgs will skip this field. Set a per-target exception with ⚙ if the field has a DIFFERENT name there.`;
        b.textContent = `⚠ missing in ${missing.length} target${missing.length !== 1 ? 's' : ''}`;
        wrap.appendChild(b);
      }
    });
  }
  // ⚙ per-target exception editor — one inline panel at a time.
  function openOvPanel(src, rowEl) {
    document.querySelector('.ds-fm-ov-panel')?.remove();
    const tgts = (typeof profileTargets === 'function') ? profileTargets(_editingProfile) : [];
    if (!tgts.length) { showToast('No targets declared for this deployment', 'warning'); return; }
    const base = (mappings[src] && mappings[src].trim()) || src;
    const panel = document.createElement('div');
    panel.className = 'ds-fm-ov-panel';
    panel.innerHTML = `
      <div class="ds-fm-ov-hdr">🎯 Per-target exceptions for <strong>${esc(src)}</strong>
        <span class="ds-fm-ov-hint">blank = use the base mapping (${esc(base)})</span></div>
      ${tgts.map(u => {
        const k = _orgKey(u);
        const has = overrides[k] && Object.prototype.hasOwnProperty.call(overrides[k], src);
        const v = has ? overrides[k][src] : undefined;
        return `<div class="ds-fm-ov-row" data-ov-org="${esc(k)}">
          <span class="ds-fm-ov-org">${esc(orgLabel(u))}</span>
          <input class="ds-input ds-input-sm ds-fm-ov-input" type="text"
                 value="${esc(has && v !== null ? v : '')}" placeholder="${esc(base)}"
                 ${has && v === null ? 'disabled' : ''} autocomplete="off">
          <label class="ds-fm-ov-skip"><input type="checkbox" class="ds-fm-ov-skipcb" ${has && v === null ? 'checked' : ''}> skip here</label>
        </div>`;
      }).join('')}
      <div class="ds-fm-ov-actions">
        <button class="ds-btn ds-btn-xs ds-btn-primary ds-fm-ov-done">✓ Done</button>
        <button class="ds-btn ds-btn-xs ds-fm-ov-cancel">Cancel</button>
      </div>`;
    rowEl.after(panel);
    panel.querySelectorAll('.ds-fm-ov-skipcb').forEach(cb =>
      cb.addEventListener('change', () => {
        const inp = cb.closest('.ds-fm-ov-row').querySelector('.ds-fm-ov-input');
        inp.disabled = cb.checked;
      }));
    panel.querySelector('.ds-fm-ov-cancel').addEventListener('click', () => panel.remove());
    panel.querySelector('.ds-fm-ov-done').addEventListener('click', () => {
      panel.querySelectorAll('.ds-fm-ov-row').forEach(row => {
        const k = row.dataset.ovOrg;
        const skip = row.querySelector('.ds-fm-ov-skipcb').checked;
        const val = row.querySelector('.ds-fm-ov-input').value.trim();
        if (skip) { (overrides[k] = overrides[k] || {})[src] = null; }
        else if (val && val !== base) { (overrides[k] = overrides[k] || {})[src] = val; }
        else if (overrides[k]) { delete overrides[k][src]; if (!Object.keys(overrides[k]).length) delete overrides[k]; }
      });
      panel.remove();
      xtAnnotate();
      updateCount();
    });
  }

  // srcLoadFailed / tgtLoadFailed distinguish "still loading" from "couldn't
  // load" — the source side used to show a permanent "Loading…" with no hint
  // when the profile's source org simply wasn't open in a Chrome tab.
  function srcStatusHtml() {
    if (!srcUrl) return '';
    if (srcLoadFailed) return `<span class="ds-fm-warn-sm">⚠ ${esc(orgLabel(srcUrl))} not open — open it in a Chrome tab, then reopen this modal</span>`;
    if (!srcLoaded) return `<span class="ds-fm-loading-sm">Loading…</span>`;
    return `<span class="ds-fm-ok">✓ ${srcFields.length} fields</span>`;
  }
  function tgtStatusHtml() {
    if (!tgtUrl) return '';
    if (tgtLoadFailed) return `<span class="ds-fm-warn-sm">⚠ ${esc(orgLabel(tgtUrl))} not open — open it in a Chrome tab, then reopen this modal</span>`;
    if (!tgtLoaded) return `<span class="ds-fm-loading-sm">Loading…</span>`;
    return `<span class="ds-fm-ok">✓ ${tgtFields.length} fields</span>`;
  }

  // ── Full modal HTML ───────────────────────────────────────────────────────
  function renderModal(filter = '') {
    const canAutoMap = srcLoaded && tgtLoaded;
    return `
      <div class="ds-modal-header">🔀 Field Mapping — <strong>${esc(objType)}</strong></div>
      <div class="ds-modal-body ds-fm-body">
        <div class="ds-fm-orgs-row">
          <div class="ds-fm-org-col">
            <span class="ds-fm-org-pill ds-fm-org-pill-src">Source</span>
            ${orgOptions(srcUrl, '— select source org —')}
            <span class="ds-fm-org-status" id="dsFmSrcStatus">${srcStatusHtml()}</span>
          </div>
          <span class="ds-fm-orgs-arrow">→</span>
          <div class="ds-fm-org-col">
            <span class="ds-fm-org-pill ds-fm-org-pill-tgt">Validate against</span>
            ${orgOptions(tgtUrl, '— pick a target schema —', true)}
            <span class="ds-fm-org-status" id="dsFmTgtStatus">${tgtStatusHtml()}</span>
          </div>
        </div>
        ${(() => {
          const tgts = (typeof profileTargets === 'function') ? profileTargets(_editingProfile) : [];
          return tgts.length > 1 ? `<div class="ds-fm-multi-note" id="dsFmXtStatus">One mapping, <strong>all ${tgts.length} targets</strong>. Loading every target's schema for the cross-check…</div>` : '';
        })()}
        <div class="ds-fm-toolbar">
          <input id="dsFmSearch" class="ds-input ds-input-sm" placeholder="Search fields…" value="${esc(filter)}" autocomplete="off">
          <button class="ds-btn ds-btn-xs ds-btn-brand" id="dsFmAutoMap"
                  ${canAutoMap ? '' : 'disabled'}
                  title="Auto-match fields by API name, then by label">
            🔀 Auto Map
          </button>
          <button class="ds-btn ds-btn-xs ds-btn-danger" id="dsFmClear" title="Clear all mappings">✕ Clear</button>
        </div>
        ${(() => {
          // Stale keys: mapped source fields that no longer exist in the org
          // (deleted since the mapping was saved). Runs skip them with
          // warnings; offer a one-click cleanup here at the source.
          if (!srcLoaded) return '';
          const live  = new Set(srcFields.map(f => f.name));
          const stale = Object.keys(mappings).filter(k => !live.has(k));
          if (!stale.length) return '';
          return `<div class="ds-fm-stale-banner">
            ⚠ ${stale.length} mapped field(s) no longer exist on ${esc(objType)} in the source org:
            <strong>${esc(stale.slice(0, 6).join(', '))}${stale.length > 6 ? ', …' : ''}</strong>
            <button class="ds-btn ds-btn-xs" id="dsFmStaleClean">🧹 Remove stale</button>
          </div>`;
        })()}
        <div class="ds-fm-legend">
          <span class="ds-fm-leg ds-fm-leg-diff">■</span> Remapped &nbsp;
          <span class="ds-fm-leg ds-fm-leg-same">■</span> Auto-matched (same name) &nbsp;
          <span class="ds-fm-leg ds-fm-leg-none">■</span> Unchanged
        </div>
        <div class="ds-fm-cols-hdr">
          <span>Source field &amp; type</span>
          <span></span>
          <span>Target field name${tgtLoaded ? ' &amp; type' : ''}</span>
        </div>
        ${datalistHtml()}
        <div class="ds-fm-list" id="dsFmList">${renderRows(filter)}</div>
      </div>
      <div class="ds-modal-footer">
        <span class="ds-fm-count" id="dsFmCount">${countLabel()}</span>
        <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
        <button class="ds-btn ds-btn-primary" id="dsFmSave">✓ Apply</button>
      </div>`;
  }

  // ── Org load handler ──────────────────────────────────────────────────────
  async function handleOrgChange(isSource, url) {
    if (!url) return;
    const org = allOrgs().find(o => o.url === url);
    if (!org) return;
    if (isSource) {
      srcUrl = url; srcLoaded = false; srcLoadFailed = false;
      const statusEl = eid('dsFmSrcStatus');
      if (statusEl) statusEl.innerHTML = '<span class="ds-fm-loading-sm">Loading…</span>';
      const fields = await loadFields(org.url, org.sid);
      if (fields) {
        srcFields = fields; srcLoaded = true;
        node._meta.availableFields = fields; node._meta.fieldsLoaded = true;
      } else {
        srcLoadFailed = true;   // failed describe — show the warning, not eternal "Loading…"
      }
      const el = eid('dsFmSrcStatus'); if (el) el.innerHTML = srcStatusHtml();
    } else {
      tgtUrl = url; tgtLoaded = false; tgtLoadFailed = false;
      const statusEl = eid('dsFmTgtStatus');
      if (statusEl) statusEl.innerHTML = '<span class="ds-fm-loading-sm">Loading…</span>';
      const fields = await loadFields(org.url, org.sid);
      if (fields) { tgtFields = fields; tgtLoaded = true; }
      else tgtLoadFailed = true;
      const el = eid('dsFmTgtStatus'); if (el) el.innerHTML = tgtStatusHtml();
    }
    const autoBtn = eid('dsFmAutoMap');
    if (autoBtn) autoBtn.disabled = !(srcLoaded && tgtLoaded);
    // Refresh datalist
    const existing = document.getElementById('dsFmTgtList');
    if (existing) existing.remove();
    if (tgtLoaded) {
      const dl = document.createElement('div');
      dl.innerHTML = datalistHtml();
      if (dl.firstElementChild) eid('dsModalBox')?.appendChild(dl.firstElementChild);
    }
    const filter = eid('dsFmSearch')?.value || '';
    const list = eid('dsFmList');
    if (list) list.innerHTML = renderRows(filter);
    wireInputs();
    xtAnnotate();
  }

  // ── Wire ─────────────────────────────────────────────────────────────────
  function rerender(filter = '') {
    const box = eid('dsModalBox');
    if (box) { box.innerHTML = renderModal(filter); wireModal(filter); }
  }

  function wireModal(filter = '') {
    const [srcSel, tgtSel] = Array.from(eid('dsModalBox')?.querySelectorAll('.ds-fm-org-sel') || []);
    srcSel?.addEventListener('change', e => handleOrgChange(true,  e.target.value));
    tgtSel?.addEventListener('change', e => handleOrgChange(false, e.target.value));

    eid('dsFmSearch')?.addEventListener('input', e => {
      const val = e.target.value;
      const list = eid('dsFmList');
      if (list) list.innerHTML = renderRows(val);
      wireInputs();
      xtAnnotate();
      const inp = eid('dsFmSearch');
      if (inp) { inp.focus(); inp.setSelectionRange(val.length, val.length); }
    });

    // Multi-target badges track every mapping edit (bubbling from row inputs).
    eid('dsFmList')?.addEventListener('input', () => setTimeout(xtAnnotate, 60));
    // ⚙ per-target exception editor (delegated — rows re-render often).
    eid('dsFmList')?.addEventListener('click', e => {
      const b = e.target.closest('.ds-fm-ov-btn');
      if (b) openOvPanel(b.dataset.ov, b.closest('.ds-fm-row'));
    });

    eid('dsFmAutoMap')?.addEventListener('click', () => {
      const before = Object.keys(mappings).length;
      runAutoMap();
      const filter = eid('dsFmSearch')?.value || '';
      const list = eid('dsFmList');
      if (list) list.innerHTML = renderRows(filter);
      wireInputs();
      xtAnnotate();
      updateCount();
      const added = Object.keys(mappings).length - before;
      showToast(`Auto-mapped ${Object.keys(mappings).filter(k => mappings[k] !== null).length} field(s) — click Apply to save`, 'info', 3500);
    });

    eid('dsFmClear')?.addEventListener('click', () => {
      Object.keys(mappings).forEach(k => delete mappings[k]);
      rerender(filter);
    });

    // One-click cleanup for STALE mapping keys — source fields that no
    // longer exist (deleted since the mapping was saved). Runs tolerate
    // them with warnings; this removes the noise at the source.
    eid('dsFmStaleClean')?.addEventListener('click', () => {
      const live = new Set(srcFields.map(f => f.name));
      const stale = Object.keys(mappings).filter(k => !live.has(k));
      stale.forEach(k => delete mappings[k]);
      showToast(`Removed ${stale.length} stale mapping(s): ${stale.slice(0, 5).join(', ')}${stale.length > 5 ? ', …' : ''} — click Apply to save`, 'info', 4500);
      rerender(eid('dsFmSearch')?.value || '');
    });

    wireInputs();
    loadCrossTargets();   // async; annotates when all connected targets are in

    eid('dsFmSave')?.addEventListener('click', async () => {
      Object.keys(mappings).forEach(k => {
        if (mappings[k] === null) return; // keep explicit exclusions
        const v = (mappings[k] || '').trim();
        // Only strip TRULY empty values. Keep identity mappings (v === k) so
        // that re-opening the modal shows the user their config — otherwise it
        // looks like nothing saved (the previous strip-on-identity behaviour
        // caused exactly the "i saved it but it didn't remember" report).
        if (!v) delete mappings[k];
        else    mappings[k] = v;  // normalize whitespace
      });
      node.fieldMappings    = mappings;
      // Per-target exceptions — persist only when non-empty.
      if (Object.keys(overrides).length) node.fieldMappingOverrides = overrides;
      else delete node.fieldMappingOverrides;
      // Persist the org pair so the next modal open pre-loads both fields lists
      node.fieldMappingOrgs = { src: srcUrl, tgt: tgtUrl };

      const totalMappings = Object.keys(mappings).length;
      window.SFToolkitDebug?.log('transfer', 'info',
        `Field mapping Apply: ${totalMappings} entries on node "${objType}" (profile id=${_editingProfile?.id})`);

      closeModal();
      refreshTree();
      // Auto-persist so users don't have to remember to click the builder's
      // "Save" button afterwards. The Apply button now actually applies.
      try {
        await commitEditingProfile();

        // Verify the round-trip by reading back from chrome.storage.local.
        // If this disagrees with what we just put on the node, we'll know
        // the persistence path is the culprit (vs. the load-on-reopen path).
        let savedCount = -1;
        try {
          const d = await chrome.storage.local.get('sftk_profiles');
          const saved = (d.sftk_profiles || []).find(p => p.id === _editingProfile?.id);
          const savedNode = saved && findNodeMatching(saved.tree, node);
          savedCount = savedNode ? Object.keys(savedNode.fieldMappings || {}).length : -1;
        } catch (_) {}
        window.SFToolkitDebug?.log('transfer', 'info',
          `Field mapping persisted: chrome.storage round-trip shows ${savedCount} entries (expected ${totalMappings})`);

        const remapped = Object.entries(mappings).filter(([k, v]) => v !== null && v && v.trim() && v.trim() !== k).length;
        const excluded = Object.values(mappings).filter(v => v === null).length;
        const identity = totalMappings - remapped - excluded;
        const bits = [];
        if (remapped) bits.push(`${remapped} remapped`);
        if (identity) bits.push(`${identity} identity`);
        if (excluded) bits.push(`${excluded} excluded`);
        showToast(`✓ Field mapping saved${bits.length ? ' (' + bits.join(', ') + ')' : ''}`, 'success', 3500);
      } catch (e) {
        window.SFToolkitDebug?.log('transfer', 'error',
          `Field mapping persist FAILED: ${e?.message || e}`);
        showToast('Field mapping applied but failed to persist: ' + (e?.message || e), 'error', 6000);
      }
    });
  }

  // Walk `tree` looking for a node that points at the same object as `target`.
  // Used by the Apply-handler verification to confirm the storage round-trip
  // actually preserved fieldMappings on the right node. Matches by objectType +
  // child path (best-effort — handles single root + same-type nested cases).
  function findNodeMatching(tree, target) {
    if (!tree || !target) return null;
    const targetType = target.objectType || target.childSObject;
    function walk(n) {
      if (!n) return null;
      if ((n.objectType || n.childSObject) === targetType) return n;
      for (const c of (n.children || [])) {
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    }
    return walk(tree);
  }

  function updateCount() {
    const el = eid('dsFmCount');
    if (el) el.textContent = countLabel();
  }

  function wireInputs() {
    const list = eid('dsFmList');
    if (!list) return;
    list.querySelectorAll('.ds-fm-tgt-input').forEach(inp => {
      inp.addEventListener('input', () => {
        const src = inp.dataset.src;
        const val = inp.value.trim();
        if (val) mappings[src] = val; else delete mappings[src];
        inp.classList.toggle('ds-fm-tgt-diff', !!(val && val !== src));
        const wrap  = inp.closest('.ds-fm-tgt-wrap');
        const reset = wrap?.querySelector('.ds-fm-reset-btn');
        if (val && val !== src) {
          if (!reset) {
            const btn = document.createElement('button');
            btn.className = 'ds-fm-reset-btn';
            btn.dataset.reset = src;
            btn.title = 'Reset to source name';
            btn.textContent = '↺';
            btn.addEventListener('click', () => {
              delete mappings[src];
              inp.value = '';
              inp.classList.remove('ds-fm-tgt-diff');
              btn.remove();
              updateCount();
            });
            wrap?.appendChild(btn);
          }
        } else {
          reset?.remove();
        }
        updateCount();
      });
    });
    list.querySelectorAll('.ds-fm-reset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const src = btn.dataset.reset;
        delete mappings[src];
        const inp = list.querySelector(`.ds-fm-tgt-input[data-src="${CSS.escape(src)}"]`);
        if (inp) { inp.value = ''; inp.classList.remove('ds-fm-tgt-diff'); }
        btn.remove();
        updateCount();
      });
    });

    // Skip / re-include toggle
    list.querySelectorAll('.ds-fm-skip-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const src = btn.dataset.skip;
        if (mappings[src] === null) {
          delete mappings[src]; // re-include
        } else {
          mappings[src] = null; // exclude
        }
        const filter = eid('dsFmSearch')?.value || '';
        const listEl = eid('dsFmList');
        if (listEl) listEl.innerHTML = renderRows(filter);
        wireInputs();
        updateCount();
      });
    });
  }

  // ── Initial load ──────────────────────────────────────────────────────────
  showModal(`<div class="ds-modal-header">🔀 Field Mapping — ${esc(objType)}</div>
    <div class="ds-modal-body" style="text-align:center;padding:40px;color:var(--subtext)">
      ${window.sftkCatSm ? sftkCatSm('Loading fields…') : 'Loading…'}
    </div>`);

  // Load source org fields
  if (!srcLoaded) {
    const srcOrg = allOrgs().find(o => o.url === srcUrl) ||
                   (srcUrl === _orgUrl && _sid ? { url: _orgUrl, sid: _sid } : null);
    if (srcOrg) {
      const fields = await loadFields(srcOrg.url, srcOrg.sid);
      if (fields) {
        srcFields = fields; srcLoaded = true;
        node._meta.availableFields = fields; node._meta.fieldsLoaded = true;
      } else {
        srcLoadFailed = true;   // describe failed — surface it, don't hang
      }
    } else {
      srcLoadFailed = true;     // source org not open in any Chrome tab
    }
  }

  // Auto-load target org fields if a target was previously saved
  if (tgtUrl && !tgtLoaded) {
    const tgtOrg = allOrgs().find(o => o.url === tgtUrl);
    if (tgtOrg) {
      const fields = await loadFields(tgtOrg.url, tgtOrg.sid);
      if (fields) { tgtFields = fields; tgtLoaded = true; }
      else tgtLoadFailed = true;   // keep the org visible + explain, don't silently clear
    } else {
      tgtLoadFailed = true;        // org not open in any Chrome tab
    }
  }

  showModal(renderModal());
  wireModal();
}

// ════════════════════════════════════════════════════════════════
// RECORD PICKER MODAL
// ════════════════════════════════════════════════════════════════
async function openRecordPickerModal(pathStr) {
  const node = getNodeByPath(_editingProfile.tree, pathStr);
  if (!node) return;
  const objType = node.objectType || node.childSObject || '';

  // Record picking queries source — uses the profile's sourceOrg, falling
  // back to the initial page session for legacy profiles without orgs set.
  const sess = _builderSession();
  if (!sess.orgUrl || !sess.sid) {
    showModal(`<div class="ds-modal-header">🎯 Pick Records — ${esc(objType)}</div>
      <div class="ds-modal-body" style="padding:24px;color:var(--warning)">
        Set a <strong>Source Org</strong> on this profile first — record picking needs to query the source.
      </div>
      <div class="ds-modal-footer"><button class="ds-btn" data-dsaction="closeModal">Close</button></div>`);
    return;
  }

  // ── Step 1: load describe to get candidate display fields ──────
  showModal(`<div class="ds-modal-header">🎯 Pick Records — ${esc(objType)}</div>
    <div class="ds-modal-body" style="text-align:center;padding:40px;color:var(--subtext)">Loading…</div>`);

  const desc = await describe(objType).catch(() => null);

  // Candidate "display" fields: string/text fields that are readable
  // Prefer Name, then common key fields, then any string field
  const candidateFields = (desc?.fields || [])
    .filter(f => STRING_TYPES.has(f.type) && !f.deprecatedAndHidden && f.name !== 'Id')
    .map(f => ({ name: f.name, label: f.label || f.name }))
    .sort((a, b) => {
      // Preferred fields float to top
      const PREF = ['Name','CaseNumber','Subject','OrderNumber','ContractNumber','Title','AssetName','ProductCode','EventSubtype'];
      const ai = PREF.indexOf(a.name), bi = PREF.indexOf(b.name);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return  1;
      return (a.label).localeCompare(b.label);
    });

  // ── Step 2: pick initial display field ────────────────────────
  // Priority: persisted node.matchField (cross-org identity, lives forever) >
  // transient session pick (_meta._recDisplayField) > best-guess (first
  // candidate, usually Name).
  const defaultField = candidateFields[0]?.name || null;
  let displayField   = node.matchField || node._meta._recDisplayField || defaultField;

  // ── Step 2b: load TARGET describe so the "Match on target" dropdown can
  // be populated. Best effort — if the target session is unavailable, we
  // fall back to a free-text input so the user can still declare the
  // target-side field name manually.
  const allSess  = _buildAllSessions();
  const tgtSess  = _editingProfile?.targetOrg ? _resolveSession(_editingProfile.targetOrg, allSess) : null;
  let tgtCandidates = null;   // null = unavailable (target session missing)
  if (tgtSess?.sid) {
    try {
      const tgtDesc = await describe(objType, tgtSess.orgUrl, tgtSess.sid);
      if (tgtDesc?.fields?.length) {
        tgtCandidates = (tgtDesc.fields || [])
          .filter(f => STRING_TYPES.has(f.type) && !f.deprecatedAndHidden && f.name !== 'Id')
          .map(f => ({ name: f.name, label: f.label || f.name }))
          .sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name));
      }
    } catch (_) { /* target describe failed — leave tgtCandidates null */ }
  }

  // Target match field — priority: persisted > field mapping for current
  // displayField > same name as source (auto-corrected at runtime).
  function deriveTgtMatchDefault(srcField) {
    if (node.matchFieldTgt)                                                                return node.matchFieldTgt;
    if (node.fieldMappings?.[srcField] && node.fieldMappings[srcField] !== null)           return node.fieldMappings[srcField];
    return srcField;
  }
  let tgtMatchField = deriveTgtMatchDefault(displayField);

  // ── M3a — per-node Matching config state ──────────────────────────────
  // node.matching { strategy, fields[≤4], normalize } is the new cross-org
  // identity config; sftkMatchingFromNode supplies the legacy single-field
  // fallback. node.matchField is kept in sync (first component) for
  // back-compat with anything that still reads it.
  const initialMatching = sftkMatchingFromNode(node);
  let matchStrategy  = initialMatching.strategy;
  let matchFields    = [...initialMatching.fields];
  let matchNormalize = {
    caseFold: false, trim: false, collapseWs: false, emailLower: false, phoneDigits: false,
    ...(initialMatching.normalize || {})
  };
  if (node.matching?.fields?.[0]) displayField = node.matching.fields[0];
  // External-ID candidates from the source describe. The user's orgs may
  // have NONE — the strategy stays visible (greyed) with a Setup hint.
  const extIdCandidates = (desc?.fields || [])
    .filter(f => (f.externalId === true || f.unique === true) && f.name !== 'Id' && f.type !== 'id')
    .map(f => ({ name: f.name, label: f.label || f.name, ext: f.externalId === true }));
  // M3b — analyzer state: cached results survive search-driven re-renders.
  let matchTestHtml    = '';
  let matchSuggestOpen = false;
  const gradeCache     = new Map();   // suggestion sig → rendered mini-grade
  const suggestions    = _matchSuggestionsFromDescribe(desc);

  const NORM_OPTS = [
    ['caseFold',    'Ignore case'],
    ['trim',        'Trim spaces'],
    ['collapseWs',  'Collapse whitespace'],
    ['emailLower',  'Lowercase emails'],
    ['phoneDigits', 'Digits-only phones']
  ];

  // Write the current Matching UI state onto the node. Legacy consumers keep
  // working: node.matchField mirrors the first key component.
  function persistMatching() {
    const fields = matchFields.filter(Boolean).slice(0, 4);
    if (!fields.length) fields.push(displayField || 'Name');
    node.matching = { strategy: matchStrategy, fields, normalize: { ...matchNormalize } };
    node.matchField = fields[0];
    node._meta._recDisplayField = fields[0];
    // Composite/external-ID target-side names derive from the Field Mapping;
    // an explicit single-field target pick only applies to 'field' strategy.
    if (matchStrategy !== 'field') node.matchFieldTgt = null;
  }

  // ── Step 3: query helper — fetches records using current displayField ─
  let records = [];
  let queryError = null;
  let selected   = new Set(node.recordIds || []);

  // Source IDs partitioned by their live state in target. Drawn from
  // `profile.lastScan` (set by runDiffScan), which queries both orgs
  // and is the source of truth for "what's actually there". Falls back
  // to the older history-derived `deployedIds` (cumulative successful
  // run history) for profiles that haven't been scanned yet.
  // A scan is "fresh" only when the profile's CURRENT object + org pair
  // matches what the scan was run against — protects against showing
  // stale state after the user changes orgs in the builder.
  const liveScan = _editingProfile?.lastScan;
  const scanFresh = !!(
    liveScan &&
    liveScan.status     === 'success' &&
    liveScan.objectType === objType &&
    (!liveScan.sourceOrg || liveScan.sourceOrg === _editingProfile?.sourceOrg) &&
    (!liveScan.targetOrg || liveScan.targetOrg === _editingProfile?.targetOrg)
  );
  const idsMissingInTarget = new Set();  // source-only — need to deploy
  const idsInSync          = new Set();  // present in both, no drift
  const idsDrift           = new Set();  // present in both, fields differ
  // Drift→target-Id map so the click-to-expand can fetch from BOTH orgs.
  // Source Id alone (idsDrift) isn't enough — we need the matching target Id
  // to query the target record's compareField values.
  const driftTargetId      = new Map();  // sourceId → { targetId, matchKey }
  if (scanFresh) {
    for (const r of (liveScan.missingInTarget || [])) if (r.sourceId) idsMissingInTarget.add(r.sourceId);
    for (const r of (liveScan.identical       || [])) if (r.sourceId) idsInSync.add(r.sourceId);
    for (const r of (liveScan.changed         || [])) {
      if (r.sourceId) {
        idsDrift.add(r.sourceId);
        if (r.targetId) driftTargetId.set(r.sourceId, { targetId: r.targetId, matchKey: r.matchKey, fields: r.fields || [] });
      }
    }
  }
  // Legacy history-derived "deployed" set — only used when no live scan
  // exists yet. Once the user clicks 🔍 Refresh diff, this is superseded.
  const deployedIds = new Set();
  if (!scanFresh && _editingProfile?.id) {
    for (const h of _history) {
      if (h.profileId !== _editingProfile.id) continue;
      if (h.tgtOrgUrl && _editingProfile.targetOrg && h.tgtOrgUrl !== _editingProfile.targetOrg) continue;
      const s = h.summary?.[objType];
      if (s && Array.isArray(s.transferredSourceIds)) {
        for (const id of s.transferredSourceIds) deployedIds.add(id);
      }
    }
  }
  let hideDeployed   = false;   // user-toggleable filter — hides in-sync rows
  let showOnlyTodo   = false;   // user-toggleable filter — shows ONLY missing+drift rows (Phase 2.5)

  async function fetchRecords() {
    const fld  = displayField && displayField !== 'Id' ? displayField : null;
    const soql = `SELECT Id${fld ? `,${fld}` : ''} FROM ${objType}${node.where ? ' WHERE ' + node.where : ''} ORDER BY ${fld || 'Id'} LIMIT 200`;
    const res  = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid, query: soql });
    queryError = res.error || null;
    records    = res.error ? [] : (res.records || []);
  }

  await fetchRecords();

  // ── Render helpers ────────────────────────────────────────────
  function noteHtml() {
    return selected.size > 0
      ? `<strong>${selected.size}</strong> record${selected.size !== 1 ? 's' : ''} selected — only these will be transferred`
      : 'No records selected — WHERE filter (or all records) will be used';
  }

  function fieldOptions() {
    return candidateFields.map(f =>
      `<option value="${esc(f.name)}" ${displayField === f.name ? 'selected' : ''}>${esc(f.label)} (${esc(f.name)})</option>`
    ).join('');
  }

  // ── M3a — Matching section (strategy + fields + normalization) ────────
  function matchCfgHtml() {
    const stratRadio = (val, lbl, disabled, title) => `
      <label class="ds-match-strat" style="display:inline-flex;align-items:center;gap:4px;font-size:12px;${disabled ? 'opacity:.55;cursor:not-allowed' : 'cursor:pointer'}" title="${esc(title || '')}">
        <input type="radio" name="dsMatchStrat" value="${val}" ${matchStrategy === val ? 'checked' : ''} ${disabled ? 'disabled' : ''}> ${lbl}
      </label>`;
    let body = '';
    if (matchStrategy === 'field') {
      body = `
        <div class="ds-rec-display-row">
          <div class="ds-rec-mf-col">
            <span class="ds-rec-display-lbl">Match on source:</span>
            ${candidateFields.length
              ? `<select id="dsRecDisplayField" class="ds-select ds-select-sm">
                  <option value="Id">Id (always unique)</option>
                  ${fieldOptions()}
                 </select>`
              : `<span class="ds-subtext">No string fields found — showing Id only</span>`}
          </div>
          <span class="ds-rec-mf-arrow">↔</span>
          <div class="ds-rec-mf-col">
            <span class="ds-rec-display-lbl">Match on target:</span>
            ${tgtCandidates && tgtCandidates.length
              ? `<select id="dsRecTgtMatchField" class="ds-select ds-select-sm" title="The field on the TARGET org whose value identifies the same logical record as the source-side field. Leave matching source if names are the same on both orgs.">
                  <option value="Id" ${tgtMatchField === 'Id' ? 'selected' : ''}>Id (always unique)</option>
                  ${tgtCandidates.map(f => `<option value="${esc(f.name)}" ${tgtMatchField === f.name ? 'selected' : ''}>${esc(f.label)} (${esc(f.name)})</option>`).join('')}
                 </select>`
              : `<input id="dsRecTgtMatchField" class="ds-input ds-input-sm" value="${esc(tgtMatchField)}" placeholder="${esc(displayField)}" title="Target session unavailable — type the target-side field API name manually. Open the target org in a Chrome tab to get a dropdown.">`}
          </div>
        </div>`;
    } else if (matchStrategy === 'composite') {
      const slots = Math.min(4, matchFields.length + 1);
      const sels = [];
      for (let i = 0; i < slots; i++) {
        const val = matchFields[i] || '';
        sels.push(`<select class="ds-select ds-select-sm" data-match-comp="${i}" title="Key component ${i + 1}${i === 0 ? ' — also drives the record list below' : ''}">
          <option value="">${val ? '— remove —' : '+ add field'}</option>
          ${candidateFields.map(f => `<option value="${esc(f.name)}" ${val === f.name ? 'selected' : ''}>${esc(f.label)} (${esc(f.name)})</option>`).join('')}
        </select>`);
      }
      body = `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        ${sels.join('<span style="color:var(--subtext)">+</span>')}
        <span class="ds-subtext" style="font-size:11px">ordered, up to 4 — target-side names follow the Field Mapping</span>
      </div>`;
    } else {
      body = extIdCandidates.length
        ? `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <select id="dsMatchExtId" class="ds-select ds-select-sm">
              ${extIdCandidates.map(f => `<option value="${esc(f.name)}" ${matchFields[0] === f.name ? 'selected' : ''}>${esc(f.label)} (${esc(f.name)})${f.ext ? ' — external ID' : ' — unique'}</option>`).join('')}
            </select>
            <span class="ds-subtext" style="font-size:11px">target-side name follows the Field Mapping</span>
          </div>`
        : `<select class="ds-select ds-select-sm" disabled title="External ID fields are created in Setup → Object Manager → Fields & Relationships — tick 'External ID' on a text field and deploy it to every org; it then becomes the ideal cross-org match key.">
            <option>No external ID fields in this org — add one in Setup to enable</option>
          </select>`;
    }
    return `
      <div class="ds-match-cfg" style="border:1px solid var(--border,#e2e8f0);border-radius:6px;padding:8px 10px;margin-bottom:10px">
        <div class="ds-match-strat-row" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span class="ds-rec-display-lbl" title="How records are recognized as 'the same' across orgs. Normalization is part of the key — the diff scan and every writer build keys identically from this config.">Matching:</span>
          ${stratRadio('field', 'Single field', false, 'One field identifies the record (the classic matchField)')}
          ${stratRadio('composite', 'Composite', false, 'Combine up to 4 fields into one key — for objects where no single field is unique (e.g. Name + Email)')}
          ${stratRadio('externalId', 'External ID', !extIdCandidates.length, extIdCandidates.length
            ? 'Match on a dedicated external-ID (or unique) field — the most reliable cross-org identity'
            : 'No external ID fields in this org — add one in Setup to enable')}
          <span style="flex:1"></span>
          <button class="ds-btn ds-btn-xs" id="dsMatchTestBtn" title="Grade this key against BOTH live orgs: populated% + unique% per org and a cross-org match preview">🧪 Test this key</button>
          <button class="ds-btn ds-btn-xs" id="dsMatchSuggestBtn" title="Ranked match-key suggestions from this object's schema (external IDs → unique fields → name → composites)">💡 Suggestions</button>
        </div>
        <div class="ds-match-fields-row" style="margin-top:6px">${body}</div>
        <div class="ds-match-norm-row" style="display:flex;gap:12px;flex-wrap:wrap;margin-top:6px;font-size:12px;align-items:center">
          <span class="ds-subtext" title="Applied to every key component on BOTH sides before comparing — normalization is part of the key itself.">Normalize:</span>
          ${NORM_OPTS.map(([k, lbl]) => `<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" data-match-norm="${esc(k)}" ${matchNormalize[k] ? 'checked' : ''}> ${lbl}</label>`).join('')}
        </div>
        ${(() => {
          // Per-target key resolution (user 2026-07-26: "what will happen if
          // the target field is different on two orgs?") — show EXACTLY which
          // field names the key resolves to in EVERY target. Same key logic
          // everywhere; only the names differ, via ⚙ per-target exceptions in
          // Field Mapping. 🧪 grades each target's DATA separately.
          const tgts = (typeof profileTargets === 'function') ? profileTargets(_editingProfile) : [];
          if (tgts.length < 2) return '';
          const m2 = sftkMatchingFromNode(node);
          return `<div style="margin-top:7px;padding:6px 9px;border:1px dashed var(--border,#d8dde6);border-radius:6px;font-size:11.5px">
            <strong style="font-size:11px">Key per target</strong>
            <span style="color:var(--subtext)" title="Matching runs per target with THAT org's field names. If a name doesn't exist in some target, records there can't be matched on it — set a ⚙ per-target exception in Field Mapping for renamed fields, and use 🧪 to grade each target's data.">ⓘ</span><br>
            ${tgts.map(u => {
              const k = _orgKey(u);
              const hasOv = !!(node.fieldMappingOverrides && node.fieldMappingOverrides[k]);
              const nodeT = (hasOv && typeof sftkResolveMappings === 'function')
                ? { ...node, fieldMappings: sftkResolveMappings(node.fieldMappings, node.fieldMappingOverrides, k) }
                : node;
              const names = sftkMatchingTgtFields(nodeT, m2).join(' + ');
              return `<span style="display:inline-block;margin:2px 12px 0 0;white-space:nowrap">${esc(orgLabel(u))}: <strong>${esc(names)}</strong>${hasOv ? ` <span title="This org has ⚙ per-target field-mapping exceptions — its names differ from the base mapping.">🎯</span>` : ''}</span>`;
            }).join('')}
          </div>`;
        })()}
        <div id="dsMatchTestResults">${matchTestHtml}</div>
        <div id="dsMatchSuggestBox" style="display:${matchSuggestOpen ? 'block' : 'none'};margin-top:6px">${matchSuggestOpen ? suggestListHtml() : ''}</div>
      </div>`;
  }

  // M3b — ranked suggestion rows; mini-grades are computed lazily per row
  // (never auto-run N analyses — API cost).
  function suggestListHtml() {
    if (!suggestions.length) return `<div class="ds-subtext" style="font-size:12px">No obvious key candidates found on this object's schema.</div>`;
    return `<div class="ds-match-suggest-list" style="display:flex;flex-direction:column;gap:4px">
      ${suggestions.map(s => `
        <div class="ds-match-suggest-row" style="display:flex;align-items:center;gap:8px;font-size:12px;flex-wrap:wrap">
          <button class="ds-btn ds-btn-xs" data-match-adopt="${esc(s.sig)}" title="Use this as the matching config">Use</button>
          <button class="ds-btn ds-btn-xs" data-match-grade="${esc(s.sig)}" title="Run the key-quality analysis for this candidate (queries both orgs)">Grade</button>
          <strong>${esc(s.label)}</strong>
          <span class="ds-subtext">${esc(s.why)}${Object.keys(s.normalize || {}).some(k => s.normalize[k]) ? ' · normalized' : ''}</span>
          <div data-match-grade-out="${esc(s.sig)}" style="flex-basis:100%">${gradeCache.get(s.sig) || ''}</div>
        </div>`).join('')}
    </div>`;
  }

  function renderModal(filter = '') {
    const lc   = filter.toLowerCase();
    let list = records;
    if (filter) {
      list = list.filter(r => {
        const val = (r[displayField] || r.Id || '').toLowerCase();
        return val.includes(lc) || r.Id.toLowerCase().includes(lc);
      });
    }
    // "Hide in-sync" filter — when a live diff exists, hide records that
    // match between source and target. Falls back to legacy history-derived
    // "deployed" filter for unscanned profiles.
    const hideSet = scanFresh ? idsInSync : deployedIds;
    if (hideDeployed && hideSet.size) {
      list = list.filter(r => !hideSet.has(r.Id));
    }
    // "Show only needs-deploy" filter — inverse of Hide in-sync. Shows ONLY
    // records badged missing-in-target or drift. Only meaningful with a fresh
    // live diff; without one, falls back to "anything not previously deployed".
    if (showOnlyTodo) {
      if (scanFresh) {
        list = list.filter(r => idsMissingInTarget.has(r.Id) || idsDrift.has(r.Id));
      } else {
        list = list.filter(r => !deployedIds.has(r.Id));
      }
    }

    return `
      <div class="ds-modal-header">🎯 Pick Records — <strong>${esc(objType)}</strong></div>
      <div class="ds-modal-body ds-picker-body">

        <!-- M3a — Matching section: strategy (single/composite/external ID) +
             normalization toggles + M3b key-quality analyzer. Drives what's
             displayed AND how records match across orgs (Salesforce IDs
             differ between orgs, so a non-Id key is the cross-org identity). -->
        ${matchCfgHtml()}

        ${queryError ? `<div class="ds-error-banner" style="margin-bottom:8px">${esc(queryError)}</div>` : ''}

        <!-- Search + bulk actions -->
        <div class="ds-picker-toolbar">
          <input id="dsRecSearch" class="ds-input ds-input-sm" placeholder="Search…" value="${esc(filter)}" autocomplete="off">
          <button class="ds-btn ds-btn-xs" id="dsRecAll">All</button>
          <button class="ds-btn ds-btn-xs" id="dsRecNone">None</button>
          ${(scanFresh ? idsInSync.size : deployedIds.size) ? `
            <label class="ds-pick-toggle" title="${scanFresh ? 'Hide records that already match between source and target according to the latest diff scan' : 'Hide records that were already successfully transferred to this target'}">
              <input type="checkbox" id="dsRecHideDeployed" ${hideDeployed ? 'checked' : ''}>
              <span>${scanFresh ? 'Hide in-sync' : 'Hide already deployed'}</span>
              <span class="ds-pick-deployed-count">${scanFresh ? idsInSync.size : deployedIds.size}</span>
            </label>` : ''}
          ${scanFresh && (idsMissingInTarget.size || idsDrift.size) ? `
            <label class="ds-pick-toggle" title="Show only records that need to be deployed — missing in target OR present-but-drifted. Hides everything that's already in sync.">
              <input type="checkbox" id="dsRecShowOnlyTodo" ${showOnlyTodo ? 'checked' : ''}>
              <span>Only needs-deploy</span>
              <span class="ds-pick-deployed-count ds-pick-todo-count">${idsMissingInTarget.size + idsDrift.size}</span>
            </label>` : ''}
        </div>

        <div class="ds-picker-note" id="dsRecNote">${noteHtml()}</div>
        ${scanFresh ? `
          <div class="ds-pick-diff-legend">
            Live diff (${esc(timeAgo(liveScan.runAt))}):
            <span class="ds-pick-leg ds-diff-missing">🔴 Missing in target</span>
            <span class="ds-pick-leg ds-diff-drift">🟡 Changed</span>
            <span class="ds-pick-leg ds-diff-sync">🟢 In sync</span>
          </div>` : ''}

        <div class="ds-picker-list" id="dsRecList">
          ${!records.length
            ? `<div class="ds-picker-empty">${queryError ? 'Query failed.' : 'No records found.'}</div>`
            : list.map(r => {
                const label = (displayField && r[displayField]) ? r[displayField] : r.Id;
                const sub   = displayField && r[displayField] ? r.Id : '';
                // Live-scan state takes priority over history when available
                let rowCls = '', badgeHtml = '';
                const isDrift = scanFresh && idsDrift.has(r.Id);
                if (scanFresh) {
                  if (idsMissingInTarget.has(r.Id)) {
                    rowCls = ' ds-pick-row-missing';
                    badgeHtml = '<span class="ds-pick-state-badge ds-diff-missing" title="Not present in the target org — will be inserted if you transfer this record">🔴 missing in target</span>';
                  } else if (isDrift) {
                    rowCls = ' ds-pick-row-drift';
                    // Drift badge is clickable — opens inline compare table below.
                    // Tooltip names the differing fields from the scan so "why
                    // is this drift?" is answerable without the live fetch.
                    const dFields = driftTargetId.get(r.Id)?.fields || [];
                    const dTip = dFields.length
                      ? `Differs at last scan: ${dFields.join(', ')} — click for field-by-field comparison`
                      : 'Click to see field-by-field comparison';
                    badgeHtml = `<span class="ds-pick-state-badge ds-diff-drift ds-pick-drift-clickable" data-drift-id="${esc(r.Id)}" title="${esc(dTip)}">🟡 changed ▸</span>`;
                  } else if (idsInSync.has(r.Id)) {
                    rowCls = ' ds-pick-row-deployed';
                    badgeHtml = '<span class="ds-pick-state-badge ds-diff-sync" title="Present in target and all compare fields match — no action needed">🟢 in sync</span>';
                  }
                } else if (deployedIds.has(r.Id)) {
                  rowCls = ' ds-pick-row-deployed';
                  badgeHtml = '<span class="ds-pick-deployed-badge" title="This record was successfully transferred to the target org in a previous run">✓ deployed</span>';
                }
                return `<div class="ds-pick-row-container">
                  <label class="ds-pick-row${rowCls}">
                    <input type="checkbox" value="${esc(r.Id)}" ${selected.has(r.Id) ? 'checked' : ''}>
                    <span class="ds-pick-label">${esc(label)}</span>
                    ${badgeHtml}
                    ${sub ? `<span class="ds-pick-api ds-pick-id">${esc(sub)}</span>` : ''}
                  </label>
                  ${isDrift ? `<div class="ds-pick-row-expand" data-expand-for="${esc(r.Id)}" style="display:none"></div>` : ''}
                </div>`;
              }).join('')}
        </div>
        ${records.length >= 200 ? `<div class="ds-picker-limit">Showing first 200 — use WHERE filter to narrow results.</div>` : ''}
      </div>
      <div class="ds-modal-footer">
        <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
        <button class="ds-btn ds-btn-primary" id="dsRecSave">✓ Apply</button>
      </div>`;
  }

  function wireModal(filter = '') {
    const note = () => { const el = eid('dsRecNote'); if (el) el.innerHTML = noteHtml(); };

    // Source-side match field change → persist as node.matchField, re-query, re-render.
    // Also auto-update tgtMatchField if the user hasn't explicitly set one yet,
    // since the most common case is "same name on both sides".
    // Re-render the whole modal after a matching-config change. Config edits
    // invalidate cached analyzer output; the record list re-queries when the
    // FIRST key component (the display field) changed.
    async function matchCfgChanged(requery) {
      persistMatching();
      matchTestHtml = '';
      gradeCache.clear();
      const box = eid('dsModalBox');
      const filterVal = eid('dsRecSearch')?.value || '';
      const first = node.matching.fields[0];
      if (requery && first && first !== displayField) {
        displayField = first;
        if (!node.matchFieldTgt) tgtMatchField = deriveTgtMatchDefault(displayField);
        if (box) box.innerHTML = `<div class="ds-modal-body" style="text-align:center;padding:40px;color:var(--subtext)">Loading…</div>`;
        await fetchRecords();
      }
      if (box) { box.innerHTML = renderModal(filterVal); wireModal(filterVal); }
    }

    eid('dsRecDisplayField')?.addEventListener('change', async e => {
      displayField = e.target.value;
      matchFields  = [displayField];
      persistMatching();   // keeps node.matchField (legacy) + node.matching in sync
      matchTestHtml = ''; gradeCache.clear();
      // If the user hasn't explicitly picked a target match field, follow the source choice
      if (!node.matchFieldTgt || node.matchFieldTgt === '') {
        tgtMatchField = deriveTgtMatchDefault(displayField);
      }
      const box = eid('dsModalBox');
      if (box) box.innerHTML = `<div class="ds-modal-body" style="text-align:center;padding:40px;color:var(--subtext)">Loading…</div>`;
      await fetchRecords();
      if (box) { box.innerHTML = renderModal(''); wireModal(''); }
    });

    // Target-side match field change → persist as node.matchFieldTgt.
    // Both dropdown (with session) and free-text input (without) share this handler.
    const tgtMfEl = eid('dsRecTgtMatchField');
    tgtMfEl?.addEventListener('change', e => {
      const v = (e.target.value || '').trim();
      tgtMatchField        = v || displayField;       // empty → mirror source
      node.matchFieldTgt   = v || null;               // null = "use source-side name on target too"
      matchTestHtml = ''; gradeCache.clear();
    });

    // ── M3a — matching strategy / composite fields / normalization ───────
    document.querySelectorAll('input[name="dsMatchStrat"]').forEach(rb => rb.addEventListener('change', () => {
      matchStrategy = rb.value;
      if (matchStrategy === 'externalId') {
        if (!extIdCandidates.some(f => f.name === matchFields[0])) {
          matchFields = extIdCandidates.length ? [extIdCandidates[0].name] : matchFields.slice(0, 1);
        } else {
          matchFields = [matchFields[0]];
        }
      } else if (matchStrategy === 'field') {
        matchFields = [matchFields[0] || displayField || 'Name'];
      }
      matchCfgChanged(true);
    }));

    document.querySelectorAll('[data-match-comp]').forEach(sel => sel.addEventListener('change', () => {
      const vals = [...document.querySelectorAll('[data-match-comp]')]
        .sort((a, b) => Number(a.dataset.matchComp) - Number(b.dataset.matchComp))
        .map(s => s.value).filter(Boolean);
      matchFields = [...new Set(vals)].slice(0, 4);
      if (!matchFields.length) matchFields = [displayField || 'Name'];
      matchCfgChanged(true);
    }));

    eid('dsMatchExtId')?.addEventListener('change', e => {
      matchFields = [e.target.value];
      matchCfgChanged(true);
    });

    document.querySelectorAll('[data-match-norm]').forEach(cb => cb.addEventListener('change', () => {
      matchNormalize[cb.dataset.matchNorm] = cb.checked;
      persistMatching();
      // Analyzer output is stale the moment the key definition changes.
      matchTestHtml = ''; gradeCache.clear();
      const out = eid('dsMatchTestResults');
      if (out) out.innerHTML = '';
      document.querySelectorAll('[data-match-grade-out]').forEach(el => { el.innerHTML = ''; });
    }));

    // ── M3b — key-quality analyzer ("Test this key") ─────────────────────
    eid('dsMatchTestBtn')?.addEventListener('click', async () => {
      const btn = eid('dsMatchTestBtn');
      const out = eid('dsMatchTestResults');
      if (!out) return;
      persistMatching();
      if (btn) { btn.disabled = true; btn.textContent = '⏳ testing…'; }
      // Multi-target (user 2026-07-26: "I need to be able to compare with
      // both orgs"): grade the key against EVERY effective target, not just
      // the schema reference. Per-target field-mapping overrides apply to
      // the key's target-side names too.
      const tgts = (typeof profileTargets === 'function' ? profileTargets(_editingProfile) : [])
        .filter(Boolean);
      const list = tgts.length ? tgts : (_editingProfile.targetOrg ? [_editingProfile.targetOrg] : []);
      out.innerHTML = `<div class="ds-subtext" style="font-size:12px;margin-top:6px">Analyzing key quality — source + ${list.length} target${list.length !== 1 ? 's' : ''}…</div>`;
      try {
        const m = sftkMatchingFromNode(node);
        const blocks = [];
        for (const tgtUrl of list) {
          const nodeT = (typeof sftkResolveMappings === 'function')
            ? { ...node, fieldMappings: sftkResolveMappings(node.fieldMappings, node.fieldMappingOverrides, _orgKey(tgtUrl)) }
            : node;
          const tgtF  = sftkMatchingTgtFields(nodeT, m);
          const clone = { ..._editingProfile, targetOrg: tgtUrl };
          const res   = await sftkAnalyzeMatchKey(objType, clone, m.fields, tgtF, m.normalize, m.strategy);
          blocks.push(
            (list.length > 1 ? `<div style="font-weight:700;font-size:12px;margin-top:8px">→ ${esc(orgLabel(tgtUrl))}</div>` : '')
            + _matchAnalysisHtml(res, clone, false));
        }
        matchTestHtml = blocks.join('')
          + (list.length > 1 ? `<div class="ds-subtext" style="font-size:11px;margin-top:4px">Graded against all ${list.length} targets — a key can be strong in one org and weak in another (different data, different duplicates).</div>` : '');
      } catch (e) {
        const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(e?.message || String(e)) : { message: String(e?.message || e) };
        matchTestHtml = `<div class="ds-drift-compare-err" style="margin-top:6px">⚠ Key test failed: ${esc(fe.message)}</div>`;
      }
      out.innerHTML = matchTestHtml;
      if (btn) { btn.disabled = false; btn.textContent = '🧪 Test this key'; }
    });

    // ── M3b — ranked suggestions (adopt on click, grade lazily) ──────────
    function wireSuggestRows() {
      document.querySelectorAll('[data-match-adopt]').forEach(b => b.addEventListener('click', () => {
        const s = suggestions.find(x => x.sig === b.dataset.matchAdopt);
        if (!s) return;
        matchStrategy  = s.strategy;
        matchFields    = [...s.fields];
        matchNormalize = { caseFold: false, trim: false, collapseWs: false, emailLower: false, phoneDigits: false, ...(s.normalize || {}) };
        showToast(`Matching set to ${s.fields.join(' + ')} — click ✓ Apply to save`, 'info', 3500);
        matchCfgChanged(true);
      }));
      document.querySelectorAll('[data-match-grade]').forEach(b => b.addEventListener('click', async () => {
        const s = suggestions.find(x => x.sig === b.dataset.matchGrade);
        if (!s) return;
        const outEl = [...document.querySelectorAll('[data-match-grade-out]')].find(x => x.dataset.matchGradeOut === s.sig);
        if (!outEl) return;
        b.disabled = true; b.textContent = '⏳';
        outEl.innerHTML = `<div class="ds-subtext" style="font-size:11px">Grading…</div>`;
        try {
          const fm   = node.fieldMappings || {};
          const tgtF = s.fields.map(f => (fm[f] !== null && fm[f] !== undefined && fm[f] !== '') ? fm[f] : f);
          const res  = await sftkAnalyzeMatchKey(objType, _editingProfile, s.fields, tgtF, s.normalize || {}, s.strategy);
          gradeCache.set(s.sig, _matchAnalysisHtml(res, _editingProfile, true));
        } catch (e) {
          gradeCache.set(s.sig, `<div class="ds-drift-compare-err">⚠ ${esc(e?.message || String(e))}</div>`);
        }
        outEl.innerHTML = gradeCache.get(s.sig);
        b.disabled = false; b.textContent = 'Grade';
      }));
    }
    wireSuggestRows();

    eid('dsMatchSuggestBtn')?.addEventListener('click', () => {
      matchSuggestOpen = !matchSuggestOpen;
      const boxEl = eid('dsMatchSuggestBox');
      if (boxEl) {
        boxEl.style.display = matchSuggestOpen ? 'block' : 'none';
        boxEl.innerHTML = matchSuggestOpen ? suggestListHtml() : '';
        if (matchSuggestOpen) wireSuggestRows();
      }
    });

    eid('dsRecSearch')?.addEventListener('input', e => {
      const val = e.target.value;
      const box = eid('dsModalBox');
      if (box) {
        box.innerHTML = renderModal(val);
        wireModal(val);
        const inp = eid('dsRecSearch');
        if (inp) { inp.focus(); inp.setSelectionRange(val.length, val.length); }
      }
    });

    eid('dsRecAll')?.addEventListener('click', () => {
      selected = new Set(records.map(r => r.Id));
      const box = eid('dsModalBox');
      if (box) { box.innerHTML = renderModal(filter); wireModal(filter); }
    });

    eid('dsRecNone')?.addEventListener('click', () => {
      selected = new Set();
      const box = eid('dsModalBox');
      if (box) { box.innerHTML = renderModal(filter); wireModal(filter); }
    });

    // Hide already-deployed records filter — re-renders the list with deployed
    // rows removed so the user only sees "still to transfer".
    eid('dsRecHideDeployed')?.addEventListener('change', e => {
      hideDeployed = e.target.checked;
      // Mutually exclusive with "Only needs-deploy" — they conflict
      if (hideDeployed && showOnlyTodo) showOnlyTodo = false;
      const box = eid('dsModalBox');
      if (box) { box.innerHTML = renderModal(filter); wireModal(filter); }
    });
    // Show only records that need to be deployed (missing or drift). Inverse
    // of Hide in-sync — picks them by inclusion instead of exclusion. Useful
    // for "select what to transfer" in one click.
    eid('dsRecShowOnlyTodo')?.addEventListener('change', e => {
      showOnlyTodo = e.target.checked;
      if (showOnlyTodo && hideDeployed) hideDeployed = false;
      const box = eid('dsModalBox');
      if (box) { box.innerHTML = renderModal(filter); wireModal(filter); }
    });

    eid('dsRecList')?.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(cb.value); else selected.delete(cb.value);
        note();
      });
    });

    // Drift-badge click → fetch the specific record from both orgs and show
    // a field-by-field compare table inline below the row. Click again to
    // collapse. Stops the click from propagating up to the <label> so the
    // checkbox doesn't toggle just because the user wanted to see what's
    // drifting.
    eid('dsRecList')?.querySelectorAll('.ds-pick-drift-clickable').forEach(badge => {
      badge.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const recId = badge.dataset.driftId;
        if (!recId) return;
        const driftInfo = driftTargetId.get(recId);
        if (!driftInfo?.targetId) {
          showToast('No target Id recorded for this drift entry — run 🔄 Refresh state to repopulate', 'error', 4500);
          return;
        }
        const expand = document.querySelector(`.ds-pick-row-expand[data-expand-for="${recId}"]`);
        if (!expand) return;
        // Toggle if already loaded
        if (expand.dataset.loaded === '1') {
          expand.style.display = expand.style.display === 'none' ? 'block' : 'none';
          return;
        }
        expand.style.display = 'block';
        expand.innerHTML = `<div class="ds-drift-compare-loading">Loading field values…</div>`;
        const srcFields = (liveScan?.compareFields    || []);
        const tgtFields = (liveScan?.compareFieldsTgt || liveScan?.compareFields || []);
        const result = await fetchDriftRowDetail(
          _editingProfile, objType, recId, driftInfo.targetId, srcFields, tgtFields);
        if (result.error) {
          // Live fetch unavailable — fall back to the scan-time answer so
          // "why is this drift?" still gets answered.
          const fieldsNote = (driftInfo.fields || []).length
            ? `<div class="ds-drift-compare-fallback">At the last scan these field(s) differed:
                 <strong>${esc(driftInfo.fields.join(', '))}</strong></div>`
            : '';
          expand.innerHTML = `${fieldsNote}<div class="ds-drift-compare-err">⚠ ${esc(result.error)}</div>`;
          return;
        }
        expand.innerHTML = renderDriftCompareTable(
          result.srcRec, result.tgtRec, srcFields, tgtFields, result.lookupMap || {}, result.types || null);
        expand.dataset.loaded = '1';
      });
    });

    eid('dsRecSave')?.addEventListener('click', async () => {
      node.recordIds = selected.size > 0 ? [...selected] : null;
      closeModal();
      refreshTree();
      // M3a — matching edits were applied to the node live; persist them so
      // Apply actually saves (same pattern as the Field Mapping modal).
      try { await commitEditingProfile(); }
      catch (e) {
        showToast('Applied, but saving the profile failed: ' + (e?.message || e), 'error', 6000);
      }
    });
  }

  showModal(renderModal());
  wireModal();
}

// ════════════════════════════════════════════════════════════════
// TRANSFER RECORD FILTER MODAL
// Opens from the Transfer screen's plan rows. Saves run-time overrides
// to _transferNodeFilters[pathKey] without touching the saved profile.
// ════════════════════════════════════════════════════════════════
async function openTransferRecordFilterModal(pathKey, objType) {
  if (!_transferSrc?.orgUrl || !_transferSrc?.sid) {
    showModal(`
      <div class="ds-modal-header">🎯 Filter Records — ${esc(objType)}</div>
      <div class="ds-modal-body" style="padding:24px;color:var(--warning)">
        Select a Source Org first.
      </div>
      <div class="ds-modal-footer"><button class="ds-btn" data-dsaction="closeModal">Close</button></div>`);
    return;
  }

  // Profile-saved defaults for this node (read-only reference)
  const profileNode    = _transferProfile ? getNodeByPath(_transferProfile.tree, pathKey) : null;
  const profileWhere   = profileNode?.where     || null;
  const profileRecIds  = profileNode?.recordIds || null;

  // Current run-time override (undefined = not set, use profile defaults)
  const hasOverride  = pathKey in _transferNodeFilters;
  const curOverride  = _transferNodeFilters[pathKey] || {};

  let whereClause = hasOverride ? (curOverride.where || '') : (profileWhere || '');
  let selected    = new Set(hasOverride ? (curOverride.recordIds || []) : (profileRecIds || []));

  // Load describe to get candidate display fields from source org
  showModal(`
    <div class="ds-modal-header">🎯 Filter Records — ${esc(objType)}</div>
    <div class="ds-modal-body" style="text-align:center;padding:40px;color:var(--subtext)">
      Loading fields from ${esc(orgLabel(_transferSrc.orgUrl))}…
    </div>`);

  const desc = await sendBg({
    type: 'SF_REST_GET',
    orgUrl: _transferSrc.orgUrl, sid: _transferSrc.sid,
    path: `services/data/v62.0/sobjects/${objType}/describe`
  });

  const candidateFields = (desc.error ? [] : (desc.fields || []))
    .filter(f => STRING_TYPES.has(f.type) && !f.deprecatedAndHidden && f.name !== 'Id')
    .map(f => ({ name: f.name, label: f.label || f.name }))
    .sort((a, b) => {
      const PREF = ['Name','CaseNumber','Subject','OrderNumber','ContractNumber','Title','AssetName'];
      const ai = PREF.indexOf(a.name), bi = PREF.indexOf(b.name);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1; if (bi !== -1) return 1;
      return a.label.localeCompare(b.label);
    });

  let displayField  = candidateFields[0]?.name || null;
  let records       = [];
  let queryError    = null;
  let recordsLoaded = false;

  async function fetchRecords() {
    const fld  = displayField && displayField !== 'Id' ? displayField : null;
    const w    = whereClause.trim();
    const soql = `SELECT Id${fld ? `,${fld}` : ''} FROM ${objType}${w ? ' WHERE ' + w : ''} ORDER BY ${fld || 'Id'} LIMIT 200`;
    const res  = await sendBg({ type: 'SF_QUERY', tooling: false,
      orgUrl: _transferSrc.orgUrl, sid: _transferSrc.sid, query: soql });
    queryError    = res.error || null;
    records       = res.error ? [] : (res.records || []);
    recordsLoaded = true;
  }

  await fetchRecords();

  function noteHtml() {
    if (selected.size > 0)
      return `<strong>${selected.size}</strong> record${selected.size !== 1 ? 's' : ''} selected — only these will be transferred`;
    if (whereClause.trim())
      return `WHERE filter active — all matching records will be transferred`;
    return `No filter — all records will be transferred`;
  }

  function fieldOptions() {
    return candidateFields.map(f =>
      `<option value="${esc(f.name)}" ${displayField === f.name ? 'selected' : ''}>${esc(f.label)} (${esc(f.name)})</option>`
    ).join('');
  }

  function renderModal(filter = '') {
    const lc   = filter.toLowerCase();
    const list = filter
      ? records.filter(r => {
          const v = (r[displayField] || r.Id || '').toLowerCase();
          return v.includes(lc) || r.Id.toLowerCase().includes(lc);
        })
      : records;

    const profileHint = profileRecIds?.length
      ? `Profile default: ${profileRecIds.length} saved IDs`
      : profileWhere
        ? `Profile default: WHERE ${esc(profileWhere)}`
        : `Profile default: no filter`;

    return `
      <div class="ds-modal-header">🎯 Filter Records — <strong>${esc(objType)}</strong></div>
      <div class="ds-modal-body ds-picker-body">

        ${hasOverride ? `<div style="font-size:11px;background:#EEF2FF;border:1px solid #C7D2FE;border-radius:4px;padding:6px 10px;margin-bottom:10px">
          ⚙️ <strong>Run-time override active</strong> — saved profile is unchanged.
          <button class="ds-btn ds-btn-xs" id="dsTrFltReset" style="margin-left:8px">↺ Reset to profile default</button>
        </div>` : `<div style="font-size:11px;color:var(--subtext);margin-bottom:10px">
          ${profileHint} · Changes here apply to this run only.
        </div>`}

        <!-- WHERE clause -->
        <div style="margin-bottom:10px">
          <label class="ds-lbl" style="font-size:12px;margin-bottom:4px">
            WHERE clause <span style="font-weight:400;color:var(--subtext)">(optional SOQL filter)</span>
          </label>
          <div style="display:flex;gap:8px;align-items:center">
            <input id="dsTrFltWhere" class="ds-input" style="flex:1"
              placeholder="e.g. IsActive = true AND CreatedDate = LAST_N_DAYS:30"
              value="${esc(whereClause)}" autocomplete="off">
            <button class="ds-btn ds-btn-sm" id="dsTrFltReload">🔄 Load Records</button>
          </div>
        </div>

        <!-- Display field selector -->
        <div class="ds-rec-display-row">
          <span class="ds-rec-display-lbl">Show field:</span>
          ${candidateFields.length
            ? `<select id="dsTrFltDisplayField" class="ds-select ds-select-sm">
                <option value="Id">Id (always unique)</option>
                ${fieldOptions()}
               </select>`
            : `<span class="ds-subtext">No label fields — showing Id only</span>`}
        </div>

        ${queryError ? `<div class="ds-error-banner" style="margin:8px 0">${esc(queryError)}</div>` : ''}

        <!-- Search + bulk actions -->
        <div class="ds-picker-toolbar" style="margin-top:8px">
          <input id="dsTrFltSearch" class="ds-input ds-input-sm" placeholder="Search…"
                 value="${esc(filter)}" autocomplete="off">
          <button class="ds-btn ds-btn-xs" id="dsTrFltAll">All</button>
          <button class="ds-btn ds-btn-xs" id="dsTrFltNone">None</button>
        </div>

        <div class="ds-picker-note" id="dsTrFltNote">${noteHtml()}</div>

        <div class="ds-picker-list" id="dsTrFltList">
          ${!recordsLoaded
            ? `<div class="ds-picker-empty">Loading…</div>`
            : !records.length
              ? `<div class="ds-picker-empty">${queryError ? 'Query failed — check WHERE clause.' : 'No records found.'}</div>`
              : list.map(r => {
                  const lbl = (displayField && r[displayField]) ? r[displayField] : r.Id;
                  const sub = displayField && r[displayField] ? r.Id : '';
                  return `<label class="ds-pick-row">
                    <input type="checkbox" value="${esc(r.Id)}" ${selected.has(r.Id) ? 'checked' : ''}>
                    <span class="ds-pick-label">${esc(lbl)}</span>
                    ${sub ? `<span class="ds-pick-api ds-pick-id">${esc(sub)}</span>` : ''}
                  </label>`;
                }).join('')}
        </div>
        ${records.length >= 200 ? `<div class="ds-picker-limit">Showing first 200 — use WHERE clause to narrow.</div>` : ''}
      </div>
      <div class="ds-modal-footer">
        <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
        <button class="ds-btn ds-btn-primary" id="dsTrFltSave">✓ Apply</button>
      </div>`;
  }

  function wireModal(filter = '') {
    const note = () => { const el = eid('dsTrFltNote'); if (el) el.innerHTML = noteHtml(); };

    // WHERE input — track value without re-querying (press Load to reload)
    eid('dsTrFltWhere')?.addEventListener('input', e => { whereClause = e.target.value; note(); });

    // Load Records — re-query with updated WHERE
    eid('dsTrFltReload')?.addEventListener('click', async () => {
      whereClause = eid('dsTrFltWhere')?.value || '';
      const box = eid('dsModalBox');
      if (box) box.innerHTML = `<div class="ds-modal-body" style="text-align:center;padding:40px;color:var(--subtext)">Loading…</div>`;
      await fetchRecords();
      if (box) { box.innerHTML = renderModal(''); wireModal(''); }
    });

    // Display field → re-query
    eid('dsTrFltDisplayField')?.addEventListener('change', async e => {
      displayField = e.target.value;
      whereClause  = eid('dsTrFltWhere')?.value || whereClause;
      const box = eid('dsModalBox');
      if (box) box.innerHTML = `<div class="ds-modal-body" style="text-align:center;padding:40px;color:var(--subtext)">Loading…</div>`;
      await fetchRecords();
      if (box) { box.innerHTML = renderModal(''); wireModal(''); }
    });

    // Search with focus restore
    eid('dsTrFltSearch')?.addEventListener('input', e => {
      const val = e.target.value;
      const box = eid('dsModalBox');
      if (box) {
        box.innerHTML = renderModal(val);
        wireModal(val);
        const inp = eid('dsTrFltSearch');
        if (inp) { inp.focus(); inp.setSelectionRange(val.length, val.length); }
      }
    });

    // All / None
    eid('dsTrFltAll')?.addEventListener('click', () => {
      selected = new Set(records.map(r => r.Id));
      const box = eid('dsModalBox');
      if (box) { box.innerHTML = renderModal(filter); wireModal(filter); }
    });
    eid('dsTrFltNone')?.addEventListener('click', () => {
      selected = new Set();
      const box = eid('dsModalBox');
      if (box) { box.innerHTML = renderModal(filter); wireModal(filter); }
    });

    // Checkboxes
    eid('dsTrFltList')?.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(cb.value); else selected.delete(cb.value);
        note();
      });
    });

    // Reset to profile default — remove the override
    eid('dsTrFltReset')?.addEventListener('click', () => {
      delete _transferNodeFilters[pathKey];
      closeModal();
      updateTransferPreview();
      _trLastTotal = null;   // scope changed → recount
      _maybeAutoCount();
    });

    // Apply — save override and refresh plan
    eid('dsTrFltSave')?.addEventListener('click', () => {
      const w    = whereClause.trim() || null;
      const rIds = selected.size > 0 ? [...selected] : null;
      _transferNodeFilters[pathKey] = { where: w, recordIds: rIds };
      closeModal();
      updateTransferPreview();
      _trLastTotal = null;   // scope changed → recount
      _maybeAutoCount();
    });
  }

  showModal(renderModal());
  wireModal();
}


// ════════════════════════════════════════════════════════════════
// M3b — KEY-QUALITY ANALYZER (used by the Matching section above)
// ════════════════════════════════════════════════════════════════
// Grades a matching config against BOTH live orgs: populated% + unique% per
// org and a cross-org match preview. Single-field configs use one GROUP BY
// aggregate per org (the picklist P1 pattern, ~2,000-group cap); composite
// configs sample up to 2,000 records per org and build keys client-side with
// sftkMatchKey — the SAME key builder the scan and writers use.

// Ranked suggestions from a describe: external-ID fields → unique fields →
// the name field → 2-3 discovered composites (name + email / phone / city,
// only when those fields exist on the object).
function _matchSuggestionsFromDescribe(desc) {
  const fields = (desc && desc.fields) || [];
  const out = [];
  const seen = new Set();
  const push = (label, strategy, flds, normalize, why) => {
    const sig = strategy + ':' + flds.join(',');
    if (!flds.length || seen.has(sig)) return;
    seen.add(sig);
    out.push({ label, strategy, fields: flds, normalize: normalize || {}, why, sig });
  };
  fields.filter(f => f.externalId === true && f.name !== 'Id').forEach(f =>
    push(`${f.label || f.name} (${f.name})`, 'externalId', [f.name], {}, 'external ID — built for cross-org identity'));
  fields.filter(f => f.unique === true && f.externalId !== true && f.name !== 'Id' && f.type !== 'id').forEach(f =>
    push(`${f.label || f.name} (${f.name})`, 'field', [f.name], {}, 'unique field'));
  const nameFld = fields.find(f => f.nameField === true)?.name || null;
  if (nameFld) {
    push(nameFld, 'field', [nameFld], {}, 'name field');
    const strOk    = f => f && !f.deprecatedAndHidden;
    const emailFld = fields.find(f => f.type === 'email' && strOk(f))?.name || null;
    const phoneFld = fields.find(f => f.type === 'phone' && strOk(f))?.name || null;
    const cityFld  = fields.find(f => f.type === 'string' && /city/i.test(f.name) && strOk(f))?.name || null;
    const baseNorm = { caseFold: true, trim: true, collapseWs: true };
    if (emailFld) push(`${nameFld} + ${emailFld}`, 'composite', [nameFld, emailFld], { ...baseNorm, emailLower: true }, 'composite: name + email');
    if (phoneFld) push(`${nameFld} + ${phoneFld}`, 'composite', [nameFld, phoneFld], { ...baseNorm, phoneDigits: true }, 'composite: name + phone');
    if (cityFld)  push(`${nameFld} + ${cityFld}`,  'composite', [nameFld, cityFld],  { ...baseNorm }, 'composite: name + city');
  }
  return out.slice(0, 8);
}

// Per-org key counts for a field list. Returns { keyCounts, total, blank,
// sampled } or { error }. Never throws for API errors — degrades to error.
async function _matchOrgKeyCounts(objType, sess, fields, normalize, strategy) {
  const flds = (fields || []).filter(Boolean).slice(0, 4);
  if (!flds.length) return { error: 'no key fields configured' };
  try {
    if (flds.length === 1) {
      // GROUP BY aggregate — one call, exact counts (cap ~2,000 groups).
      const f = flds[0];
      const agg = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false,
        _suppressError: true,
        query: `SELECT ${f} pv, COUNT(Id) cnt FROM ${objType} GROUP BY ${f}` });
      if (agg && !agg.error) {
        const rows = (agg.records || []).map(r => ({ value: r.pv ?? r[f], count: r.cnt ?? r.expr0 ?? 0 }));
        const counts = sftkKeyCountsFromGroups(rows, normalize || {});
        counts.sampled = (agg.records || []).length >= 2000;
        return counts;
      }
      // GROUP BY unsupported for this field type (long text etc.) → sample.
    }
    const q = await sendBg({ type: 'SF_QUERY', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false,
      _suppressError: true,
      query: `SELECT ${['Id', ...flds].join(',')} FROM ${objType} LIMIT 2000` });
    if (q?.error) return { error: q.error };
    const counts = sftkKeyCountsFromRecords(q.records || [], { strategy, fields: flds, normalize: normalize || {} });
    counts.sampled = (q.records || []).length >= 2000;
    return counts;
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

// Full analysis: both orgs (graceful "org not open" per side) + cross-org
// preview when both sides produced counts.
async function sftkAnalyzeMatchKey(objType, profile, srcFields, tgtFields, normalize, strategy) {
  const out = { src: null, tgt: null, srcErr: null, tgtErr: null, cross: null };
  const friendly = m => (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(m).message : String(m);
  try {
    const srcSess = profile?.sourceOrg ? await getOrgSession(profile.sourceOrg) : null;
    const tgtSess = profile?.targetOrg ? await getOrgSession(profile.targetOrg) : null;
    if (!srcSess?.sid) out.srcErr = profile?.sourceOrg
      ? `org not open — open ${orgLabel(profile.sourceOrg)} in a Chrome tab` : 'no source org set on this profile';
    if (!tgtSess?.sid) out.tgtErr = profile?.targetOrg
      ? `org not open — open ${orgLabel(profile.targetOrg)} in a Chrome tab` : 'no target org set on this profile';
    if (srcSess?.sid) {
      const c = await _matchOrgKeyCounts(objType, srcSess, srcFields, normalize, strategy);
      if (c?.error) out.srcErr = friendly(c.error); else out.src = c;
    }
    if (tgtSess?.sid) {
      const c = await _matchOrgKeyCounts(objType, tgtSess, tgtFields, normalize, strategy);
      if (c?.error) out.tgtErr = friendly(c.error); else out.tgt = c;
    }
    if (out.src && out.tgt) out.cross = sftkCrossOrgPreview(out.src, out.tgt);
  } catch (e) {
    const msg = friendly(e?.message || String(e));
    if (!out.src && !out.srcErr) out.srcErr = msg;
    else if (!out.tgt && !out.tgtErr) out.tgtErr = msg;
  }
  return out;
}

// One org's stats line — ds-pk-style bar + numbers.
function _matchStatsHtml(label, counts, err) {
  if (err) return `<div class="ds-match-stat-row" style="font-size:12px;color:var(--warning,#b45309);margin-top:4px">⚠ ${esc(label)}: ${esc(err)}</div>`;
  if (!counts) return '';
  const st  = sftkKeyStats(counts);
  const col = p => p >= 98 ? '#16a34a' : p >= 90 ? '#f59e0b' : '#dc2626';
  const bar = pct => `<span class="ds-pk-bar" style="width:64px;display:inline-block"><span class="ds-pk-fill" style="width:${Math.max(2, pct)}%;background:${col(pct)}"></span></span>`;
  return `<div class="ds-match-stat-row" style="display:flex;align-items:center;gap:8px;font-size:12px;margin-top:4px;flex-wrap:wrap">
    <span style="min-width:150px"><strong>${esc(label)}</strong>${counts.sampled ? ` <span class="ds-subtext" title="More than 2,000 rows/groups — computed on the first 2,000">(sampled)</span>` : ''}</span>
    ${bar(st.populatedPct)} ${st.populatedPct}% populated
    ${bar(st.uniquePct)} ${st.uniquePct}% unique
    <span class="ds-subtext">${st.total.toLocaleString()} record(s)${st.blank ? ` · ${st.blank.toLocaleString()} blank key` : ''}${st.dupRecords ? ` · ${st.dupRecords.toLocaleString()} share dup keys` : ''}</span>
  </div>`;
}

// Cross-org verdict chip + "N of M match uniquely · X ambiguous · Y unmatched".
function _matchVerdictHtml(res) {
  if (!res?.cross) return '';
  const c = res.cross;
  const pct = c.sourceTotal ? Math.round((c.matchedUnique / c.sourceTotal) * 100) : 0;
  const cls = pct >= 98 ? 'ds-diff-sync' : pct >= 85 ? 'ds-diff-drift' : 'ds-diff-missing';
  const verdict = pct >= 98 ? 'Excellent key' : pct >= 85 ? 'Usable — review the gaps' : 'Weak key — expect mismatches';
  return `<div style="display:flex;align-items:center;gap:8px;font-size:12px;margin-top:6px;flex-wrap:wrap">
    <span class="ds-diff-chip ${cls}">${esc(verdict)}</span>
    <span>matches <strong>${c.matchedUnique.toLocaleString()}</strong> of <strong>${c.sourceTotal.toLocaleString()}</strong> source records uniquely
      · <strong>${c.ambiguous.toLocaleString()}</strong> ambiguous (dup keys either side)
      · <strong>${c.unmatched.toLocaleString()}</strong> unmatched</span>
  </div>`;
}

// Full analysis panel (mini variant for suggestion-row grades).
function _matchAnalysisHtml(res, profile, mini) {
  const srcLbl = `Source · ${orgLabel(profile?.sourceOrg || '') || 'source org'}`;
  const tgtLbl = `Target · ${orgLabel(profile?.targetOrg || '') || 'target org'}`;
  const bothMissing = !res.src && !res.tgt;
  return `<div class="ds-match-test-out" style="margin-top:${mini ? '2px' : '8px'};padding:${mini ? '4px 8px' : '8px 10px'};background:rgba(148,163,184,.12);border-radius:6px">
    ${_matchStatsHtml(srcLbl, res.src, res.srcErr)}
    ${_matchStatsHtml(tgtLbl, res.tgt, res.tgtErr)}
    ${_matchVerdictHtml(res)}
    ${!res.cross && !bothMissing ? `<div class="ds-subtext" style="font-size:11px;margin-top:4px">Cross-org preview needs BOTH orgs reachable.</div>` : ''}
  </div>`;
}
