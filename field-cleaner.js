// ============================================================
// Field Cleaner — scan field dependencies & safely clean them
// ============================================================
const FieldCleaner = (() => {
  'use strict';

  let _orgUrl    = null;
  let _sid       = null;
  let _container = null;

  // Selection state
  let _selObj    = null;   // { api, label, durableId }
  let _selField  = null;   // { durableId, api, label, type }
  let _allObjects = [];
  let _allFields  = [];
  let _objectsLoaded = false;
  let _groups    = {};     // type → [dep records] — kept for fixAll

  // Tooling API sobject names that the XML Inspector can fetch.
  // Types with `Body` at the root (Apex) are handled separately from Metadata types.
  const _INSPECT_SOBJECT = {
    Flow: 'Flow', Layout: 'Layout', FlexiPage: 'FlexiPage',
    ValidationRule: 'ValidationRule',
    ApexClass: 'ApexClass', ApexTrigger: 'ApexTrigger',
  };

  // ── Public API ─────────────────────────────────────────────
  function init(container, orgUrl, sid) {
    _orgUrl    = orgUrl;
    _sid       = sid;
    _container = container;
    renderShell();
  }

  function updateSession(orgUrl, sid) {
    _orgUrl = orgUrl;
    _sid    = sid;
  }

  // ── Background calls ───────────────────────────────────────
  function bgRaw(msg) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(msg, resp => {
        resolve(resp || { error: chrome.runtime.lastError?.message || 'No response' });
      });
    });
  }

  async function bg(msg) {
    const _t   = window.SFToolkitDebug?.enabled ? Date.now() : null;
    const resp = await bgRaw(msg);
    if (window.SFToolkitDebug?.enabled) {
      const dur = _t !== null ? Date.now() - _t : null;
      const tag = msg.query?.substring(0, 80) || msg.path || msg.sobject || '';
      // Honour _suppressError: planned recovery attempts (e.g. the Layout
      // strip-and-retry loop, two-attempt Metadata deploy) are logged as
      // 'retry' — not 'error' or 'warn' — so the debug export reads as a
      // clean sequence of expected steps, not a noise of false warnings.
      const level = resp?.error === 'SESSION_EXPIRED' ? 'session'
                  : resp?.error ? (msg._suppressError ? 'retry' : 'error')
                  : 'api';
      window.SFToolkitDebug.log('fields', level,
        `${msg.type}${tag ? '  ' + tag : ''}`, resp?.error || null, dur);
    }
    if (resp?.error !== 'SESSION_EXPIRED') return resp;
    const fresh = await bgRaw({ type: 'GET_SF_SESSION', activeTabUrl: _orgUrl });
    if (fresh?.sid && fresh?.orgUrl) {
      _orgUrl = fresh.orgUrl; _sid = fresh.sid;
      const retry = msg.sid !== undefined
        ? { ...msg, orgUrl: fresh.orgUrl, sid: fresh.sid } : msg;
      return bgRaw(retry);
    }
    return resp;
  }

  // ── Tiny helpers ───────────────────────────────────────────
  function eid(id)  { return document.getElementById(id); }
  function esc(str) {
    return String(str || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Shell ──────────────────────────────────────────────────
  function renderShell() {
    _container.innerHTML = `
      <div class="fc-wrap">

        <!-- Step 1 -->
        <div class="fc-step">
          <div class="fc-step-label">1 — Choose an object</div>
          <div class="fc-picker-wrap" id="fcObjWrap">
            <input id="fcObjInput" class="fc-input" placeholder="Type to search objects…" autocomplete="off">
            <div id="fcObjDrop" class="fc-dropdown" style="display:none"></div>
          </div>
        </div>

        <!-- Step 2 (hidden until object selected) -->
        <div class="fc-step" id="fcFieldStep" style="display:none">
          <div class="fc-step-label">2 — Choose a custom field</div>
          <div class="fc-picker-wrap" id="fcFieldWrap">
            <input id="fcFieldInput" class="fc-input" placeholder="Type to search fields…" autocomplete="off">
            <div id="fcFieldDrop" class="fc-dropdown" style="display:none"></div>
          </div>
        </div>

        <!-- Selected pill -->
        <div id="fcPill" class="fc-pill-row" style="display:none"></div>

        <!-- Scan button -->
        <button id="fcScanBtn" class="btn btn-primary fc-scan-btn" style="display:none">
          🔍 Scan Dependencies
        </button>

        <!-- Results area -->
        <div id="fcResults"></div>

      </div>`;

    setupObjectPicker();

    // Close dropdowns on outside click
    document.addEventListener('click', e => {
      if (!e.target.closest('#fcObjWrap'))   closeDropdown('fcObjDrop');
      if (!e.target.closest('#fcFieldWrap')) closeDropdown('fcFieldDrop');
    }, true);
  }

  function closeDropdown(id) {
    const el = eid(id);
    if (el) el.style.display = 'none';
  }

  // ── Object picker ──────────────────────────────────────────
  function setupObjectPicker() {
    const input = eid('fcObjInput');
    const drop  = eid('fcObjDrop');
    if (!input || !drop) return;

    input.addEventListener('focus', async () => {
      if (!_objectsLoaded) {
        _objectsLoaded = true;
        drop.innerHTML = '<div class="fc-dd-loading">Loading objects…</div>';
        drop.style.display = '';
        const res = await bg({
          type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true,
          query: 'SELECT QualifiedApiName, Label, DurableId FROM EntityDefinition ' +
                 'WHERE IsCustomSetting = false AND IsDeprecatedAndHidden = false ' +
                 'ORDER BY Label LIMIT 2000'
        });
        if (res.error) {
          const eMsg = res.error === 'SESSION_EXPIRED' ? 'Session expired — log back in and retry' : `Error: ${esc(res.error)}`;
          drop.innerHTML = `<div class="fc-dd-empty">${eMsg}</div>`;
          drop.style.display = '';
          return;
        }
        _allObjects = (res.records || []).map(r => ({
          api: r.QualifiedApiName,
          label: r.Label,
          durableId: r.DurableId || r.QualifiedApiName
        }));
        renderObjDrop(input.value);
      } else {
        renderObjDrop(input.value);
        drop.style.display = '';
      }
    });

    input.addEventListener('input', () => {
      if (_objectsLoaded) renderObjDrop(input.value);
      if (_selObj) resetFieldAndBelow();
    });
  }

  function renderObjDrop(filter) {
    const drop = eid('fcObjDrop');
    if (!drop) return;
    const fl = (filter || '').toLowerCase();
    let matches;
    if (!fl) {
      matches = _allObjects;
    } else {
      // Score so exact/prefix hits float to the top before contains-matches.
      // Without this, "Contact" is buried past position 60 by all the
      // "Account Contact Role …" objects that come first alphabetically.
      const scored = _allObjects
        .map(o => {
          const al = o.api.toLowerCase();
          const ll = o.label.toLowerCase();
          if (al === fl || ll === fl)                     return { o, s: 0 };
          if (al.startsWith(fl) || ll.startsWith(fl))    return { o, s: 1 };
          if (al.includes(fl)   || ll.includes(fl))      return { o, s: 2 };
          return null;
        })
        .filter(Boolean);
      scored.sort((a, b) => a.s - b.s);
      matches = scored.map(x => x.o);
    }

    if (!matches.length) {
      drop.innerHTML = '<div class="fc-dd-empty">No objects found</div>';
    } else {
      drop.innerHTML = matches.slice(0, 60).map(o =>
        `<div class="fc-dd-item"
              data-api="${esc(o.api)}"
              data-label="${esc(o.label)}"
              data-durable="${esc(o.durableId)}">
           <span class="fc-dd-main">${esc(o.label)}</span>
           <span class="fc-dd-sub">${esc(o.api)}</span>
         </div>`
      ).join('');
      drop.querySelectorAll('.fc-dd-item').forEach(item => {
        item.addEventListener('mousedown', e => {
          e.preventDefault();
          eid('fcObjInput').value = `${item.dataset.label} (${item.dataset.api})`;
          drop.style.display = 'none';
          selectObject(item.dataset.api, item.dataset.label, item.dataset.durable);
        });
      });
    }
    drop.style.display = '';
  }

  async function selectObject(api, label, durableId) {
    _selObj = { api, label, durableId: durableId || api };
    resetFieldAndBelow();

    const step  = eid('fcFieldStep');
    const input = eid('fcFieldInput');
    const drop  = eid('fcFieldDrop');
    if (!step || !input || !drop) return;

    step.style.display = '';
    input.value = '';
    drop.innerHTML = '<div class="fc-dd-loading">Loading fields…</div>';
    drop.style.display = '';

    const res = await bg({
      type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true,
      query: `SELECT Id, QualifiedApiName, Label, DataType FROM FieldDefinition ` +
             `WHERE EntityDefinitionId = '${api}' ORDER BY Label LIMIT 1000`
    });

    if (res.error) {
      const eMsg = res.error === 'SESSION_EXPIRED' ? 'Session expired — log back in and retry' : `Error loading fields: ${esc(res.error)}`;
      drop.innerHTML = `<div class="fc-dd-empty">${eMsg}</div>`;
      return;
    }

    _allFields = (res.records || [])
      .filter(r => r.QualifiedApiName && r.QualifiedApiName.endsWith('__c'))
      .map(r => ({
        durableId: r.Id,
        api:       r.QualifiedApiName,
        label:     r.Label,
        type:      r.DataType
      }));

    renderFieldDrop(input.value);

    // Re-wire each time (new object resets all listeners via new input ref)
    const newInput = eid('fcFieldInput');
    if (newInput) {
      newInput.addEventListener('input', () => renderFieldDrop(newInput.value));
      newInput.addEventListener('focus', () => {
        renderFieldDrop(newInput.value);
        const d = eid('fcFieldDrop');
        if (d) d.style.display = '';
      });
    }
  }

  function resetFieldAndBelow() {
    _selField = null;
    _groups   = {};
    const pill    = eid('fcPill');
    const scanBtn = eid('fcScanBtn');
    const results = eid('fcResults');
    if (pill)    pill.style.display    = 'none';
    if (scanBtn) scanBtn.style.display = 'none';
    if (results) results.innerHTML     = '';
  }

  // ── Field picker ───────────────────────────────────────────
  function renderFieldDrop(filter) {
    const drop = eid('fcFieldDrop');
    if (!drop) return;
    const fl = (filter || '').toLowerCase();
    const matches = fl
      ? _allFields.filter(f =>
          f.api.toLowerCase().includes(fl) || f.label.toLowerCase().includes(fl))
      : _allFields;

    if (!matches.length) {
      drop.innerHTML = '<div class="fc-dd-empty">No custom fields found</div>';
    } else {
      drop.innerHTML = matches.slice(0, 80).map(f =>
        `<div class="fc-dd-item"
              data-durable="${esc(f.durableId)}"
              data-api="${esc(f.api)}"
              data-label="${esc(f.label)}"
              data-type="${esc(f.type)}">
           <span class="fc-dd-main">${esc(f.label)}</span>
           <span class="fc-dd-sub">${esc(f.api)}</span>
           <span class="fc-dd-type">${esc(f.type)}</span>
         </div>`
      ).join('');
      drop.querySelectorAll('.fc-dd-item').forEach(item => {
        item.addEventListener('mousedown', e => {
          e.preventDefault();
          eid('fcFieldInput').value = `${item.dataset.label} (${item.dataset.api})`;
          drop.style.display = 'none';
          selectField({
            durableId: item.dataset.durable,
            api:       item.dataset.api,
            label:     item.dataset.label,
            type:      item.dataset.type
          });
        });
      });
    }
    drop.style.display = '';
  }

  function selectField(field) {
    _selField = field;

    const pill = eid('fcPill');
    if (pill) {
      pill.innerHTML = `
        <div class="fc-pill">
          <span class="fc-pill-obj">${esc(_selObj.api)}</span>
          <span class="fc-pill-dot">.</span>
          <span class="fc-pill-field">${esc(field.api)}</span>
          <span class="fc-pill-type">${esc(field.type)}</span>
        </div>`;
      pill.style.display = '';
    }

    const scanBtn = eid('fcScanBtn');
    if (scanBtn) {
      scanBtn.style.display = '';
      scanBtn.disabled      = false;
      scanBtn.textContent   = '🔍 Scan Dependencies';
      scanBtn.onclick       = runScan;
    }

    eid('fcResults').innerHTML = '';
  }

  // ── Scan ───────────────────────────────────────────────────
  async function runScan() {
    if (!_selObj || !_selField) return;

    const btn = eid('fcScanBtn');
    if (btn) { btn.disabled = true; btn.textContent = '🔍 Scanning…'; }

    eid('fcResults').innerHTML = sftkCat('Scanning dependencies…');

    try {
      // ── 1. Resolve CustomField tooling ID ─────────────────
      const fieldId = await resolveCustomFieldId();
      if (!fieldId) {
        showScanError(
          'Could not locate this field in the Tooling API. ' +
          'Verify the field API name and that you have Customize Application permission.'
        );
        return;
      }

      // ── 2. Query dependencies ─────────────────────────────
      const depRes = await bg({
        type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true,
        query: 'SELECT MetadataComponentId, MetadataComponentName, MetadataComponentType, ' +
               'RefMetadataComponentId, RefMetadataComponentName ' +
               `FROM MetadataComponentDependency WHERE RefMetadataComponentId = '${fieldId}'`
      });

      if (depRes.error) {
        showScanError(
          `Could not scan dependencies: ${depRes.error}. ` +
          'This requires API access and Customize Application permission.'
        );
        return;
      }

      const deps = depRes.records || [];

      // ── 3. Supplemental Lightning Page scan ───────────────
      // MetadataComponentDependency does NOT reliably return Lightning Page
      // (FlexipageFieldInstance) references — Salesforce's own "Where is this
      // used?" catches them via internal indexing the Tooling API doesn't
      // expose. Scan FlexiPages directly so fields placed on Lightning Pages
      // (incl. Dynamic Forms field sections) are never missed.
      const msgEl = eid('fcResults')?.querySelector('.lp-robot-msg');
      if (msgEl) msgEl.textContent = 'Scanning Lightning Pages…';
      let flexiHits = [];
      try {
        flexiHits = await scanFlexiPages(deps);
      } catch (e) {
        // Non-fatal — fall back to whatever MetadataComponentDependency found
        if (window.SFToolkitDebug?.enabled) {
          window.SFToolkitDebug.log('fields', 'error',
            'Supplemental FlexiPage scan failed', e.message);
        }
      }

      renderResults([...deps, ...flexiHits], fieldId);
    } catch (e) {
      showScanError(`Unexpected error: ${e.message}`);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔍 Re-scan'; }
    }
  }

  // ── Supplemental Lightning Page (FlexiPage) scan ───────────
  // Returns synthetic dependency records for any FlexiPage whose metadata
  // references the selected field — covering the FlexipageFieldInstance and
  // Dynamic-Forms cases that MetadataComponentDependency silently omits.
  async function scanFlexiPages(existingDeps) {
    const listRes = await bg({
      type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true,
      query: 'SELECT Id, DeveloperName, MasterLabel FROM FlexiPage'
    });
    if (listRes.error || !Array.isArray(listRes.records) || !listRes.records.length) {
      return [];
    }

    // FlexiPages MetadataComponentDependency already reported — skip re-fetching
    // and avoid duplicate rows (compare on the 15-char id prefix).
    const alreadyFound = new Set(
      (existingDeps || [])
        .filter(d => d.MetadataComponentType === 'FlexiPage')
        .map(d => String(d.MetadataComponentId || '').substring(0, 15))
    );

    const pages   = listRes.records;
    const hits    = [];
    const BATCH   = 5;
    const msgEl   = () => eid('fcResults')?.querySelector('.lp-robot-msg');

    for (let i = 0; i < pages.length; i += BATCH) {
      const slice   = pages.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        slice.map(p => bg({
          type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid,
          sobject: 'FlexiPage', id: p.Id
        }))
      );
      results.forEach((r, j) => {
        if (r.status !== 'fulfilled' || r.value?.error || !r.value?.Metadata) return;
        const page = slice[j];
        if (alreadyFound.has(String(page.Id || '').substring(0, 15))) return;
        if (flexiPageReferencesField(r.value.Metadata, _selObj.api, _selField.api)) {
          hits.push({
            MetadataComponentId:      page.Id,
            MetadataComponentName:    page.MasterLabel || page.DeveloperName,
            MetadataComponentType:    'FlexiPage',
            RefMetadataComponentId:   null,
            RefMetadataComponentName: _selField.api,
            _supplemental:            true
          });
        }
      });
      const el = msgEl();
      if (el) el.textContent =
        `Scanning Lightning Pages… ${Math.min(i + BATCH, pages.length)}/${pages.length}`;
    }
    return hits;
  }

  // Recursively walk a FlexiPage Metadata object looking for a reference to
  // the given field. Covers every known binding pattern:
  //   • Dynamic Forms field instances        — fieldItem: "Record.My_Field__c"
  //   • classic field components             — componentInstanceProperties
  //                                             { name:'fieldApiName', value:'…' }
  //   • component visibility rule criteria    — leftValue / rightValue(.value)
  //   • component filters / list-view filters — field ref buried inside a
  //                                             property value or JSON blob
  function flexiPageReferencesField(metadata, objApi, fieldApi) {
    const fl  = String(fieldApi || '').toLowerCase();
    const obj = String(objApi  || '').toLowerCase();
    if (!fl) return false;

    // Exact-ish merge-field match (precise — safe for any field, std or custom)
    function isRef(str) {
      if (str == null) return false;
      const s = String(str).toLowerCase()
        .replace(/^\{!/, '').replace(/\}$/, '').trim();
      return (
        s === fl ||
        s === `${obj}.${fl}` ||
        s === `record.${fl}` ||
        s === `objectrecord.${fl}` ||
        s === `$record.${fl}` ||
        s.endsWith(`.${fl}`)
      );
    }

    // Deep token match — catches a field ref buried *inside* a larger string
    // (filter JSON blobs, criteria expressions, merge text…). Only enabled for
    // custom fields, whose __c / __r-style API names are distinctive enough to
    // never false-match; standard short names rely on the precise checks above.
    const deepScan = fl.includes('__');
    const flEsc    = fl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tokenRe  = new RegExp(`(^|[^a-z0-9_])${flEsc}([^a-z0-9_]|$)`, 'i');

    let found = false;
    (function walk(node) {
      if (found || node == null) return;
      if (typeof node === 'string') {
        if (deepScan && tokenRe.test(node)) found = true;
        return;
      }
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node !== 'object') return;

      // ── Precise structured checks (any field) ──
      // Dynamic Forms field instance
      if (isRef(node.fieldItem)) { found = true; return; }
      // classic field component property
      if (['fieldApiName', 'field', 'fieldName'].includes(node.name) && isRef(node.value)) {
        found = true; return;
      }
      // visibility rule / filter criteria
      if (('leftValue' in node || 'rightValue' in node) &&
          (isRef(node.leftValue) ||
           isRef(node.rightValue) ||
           isRef(node.rightValue?.value))) {
        found = true; return;
      }

      // ── Deep fallback — walk every value incl. nested strings ──
      for (const k in node) walk(node[k]);
    })(metadata);

    return found;
  }

  // Derive DeveloperName from QualifiedApiName (strips __c / __r suffix)
  function deriveDevName(qualifiedApiName) {
    return (qualifiedApiName || '').replace(/__c$/i, '').replace(/__r$/i, '');
  }

  // Look up the 15-char CustomField.Id needed for MetadataComponentDependency
  async function resolveCustomFieldId() {
    const devName = deriveDevName(_selField.api);

    // Attempt 1: use EntityDefinition.DurableId as TableEnumOrId (works for both standard + custom)
    const res1 = await bg({
      type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true,
      query: `SELECT Id FROM CustomField WHERE DeveloperName = '${devName}' ` +
             `AND TableEnumOrId = '${_selObj.durableId}'`
    });
    if (!res1.error && res1.records?.length) return res1.records[0].Id;

    // Attempt 2: try with QualifiedApiName (fallback for standard objects)
    if (_selObj.durableId !== _selObj.api) {
      const res2 = await bg({
        type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true,
        query: `SELECT Id FROM CustomField WHERE DeveloperName = '${devName}' ` +
               `AND TableEnumOrId = '${_selObj.api}'`
      });
      if (!res2.error && res2.records?.length) return res2.records[0].Id;
    }

    // Attempt 3: try stripping namespace from devName (e.g. ns__My_Field → My_Field)
    if (devName.includes('__')) {
      const shortName = devName.split('__').pop();
      const res3 = await bg({
        type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true,
        query: `SELECT Id FROM CustomField WHERE DeveloperName = '${shortName}' ` +
               `AND TableEnumOrId = '${_selObj.durableId}'`
      });
      if (!res3.error && res3.records?.length) return res3.records[0].Id;
    }

    return null;
  }

  function showScanError(msg) {
    eid('fcResults').innerHTML =
      `<div class="fc-error-msg"><span>❌</span> ${esc(msg)}</div>`;
  }

  // ── Render results ─────────────────────────────────────────
  const TYPE_CFG = {
    Flow:           { icon: '🌊', label: 'Flows',            fixable: true,
                      note: 'A new version is saved with the field reference removed AND activated automatically — the old version becomes Obsolete.',
                      doneLabel: '✅ Activated' },
    FlexiPage:      { icon: '📄', label: 'Lightning Pages',  fixable: true,
                      note: 'Field references in visibility rules and field components will be removed automatically.',
                      doneLabel: '✅ Page updated' },
    Layout:         { icon: '📋', label: 'Page Layouts',     fixable: true,
                      note: 'The field will be removed from all layout sections automatically.',
                      doneLabel: '✅ Layout updated' },
    ListView:       { icon: '📊', label: 'List Views',       fixable: false,
                      note: 'Open the object\'s list view and remove the column or filter.' },
    ValidationRule: { icon: '✅', label: 'Validation Rules', fixable: false,
                      note: 'Edit the validation rule formula in Object Manager.' },
    ApexClass:      { icon: '☕', label: 'Apex Classes',     fixable: false,
                      note: 'Update the Apex code to remove the field reference.' },
    ApexTrigger:    { icon: '⚡', label: 'Apex Triggers',    fixable: false,
                      note: 'Update the Apex trigger to remove the field reference.' },
    WorkflowRule:   { icon: '🔁', label: 'Workflow Rules',   fixable: false,
                      note: 'Edit or deactivate the workflow rule in Setup.' },
  };
  const TYPE_CFG_DEFAULT = { icon: '🔧', label: 'Other', fixable: false,
    note: 'Review this dependency in Setup before deleting the field.' };

  function renderResults(deps, fieldId) {
    const results = eid('fcResults');
    if (!results) return;

    if (!deps.length) {
      results.innerHTML = `
        <div class="fc-clean">
          <div class="fc-clean-icon">✅</div>
          <div class="fc-clean-title">No dependencies found</div>
          <div class="fc-clean-sub">This field can be safely deleted.</div>
          <button class="btn btn-danger" id="fcDelFreeBtn">🗑 Delete Field</button>
        </div>`;
      eid('fcDelFreeBtn').onclick = () => confirmDelete(fieldId);
      return;
    }

    // Group
    _groups = {};
    for (const d of deps) {
      const t = d.MetadataComponentType || 'Unknown';
      if (!_groups[t]) _groups[t] = [];
      _groups[t].push(d);
    }

    const autoCount   = Object.entries(_groups)
      .filter(([t]) => (TYPE_CFG[t] || TYPE_CFG_DEFAULT).fixable)
      .reduce((n, [,arr]) => n + arr.length, 0);
    const manualCount = deps.length - autoCount;

    let html = `
      <div class="fc-results-hdr">
        <strong>${deps.length}</strong> dependenc${deps.length === 1 ? 'y' : 'ies'} on
        <code>${esc(_selObj.api)}.${esc(_selField.api)}</code>
        <span class="fc-badge-row">
          ${autoCount   > 0 ? `<span class="fc-badge-auto">${autoCount} auto-fixable</span>`  : ''}
          ${manualCount > 0 ? `<span class="fc-badge-manual">${manualCount} manual</span>` : ''}
        </span>
      </div>`;

    for (const [type, items] of Object.entries(_groups)) {
      const cfg = TYPE_CFG[type] || { ...TYPE_CFG_DEFAULT, label: type };
      html += `
        <div class="fc-group" id="fcGroup_${esc(type)}">
          <div class="fc-group-hdr">
            <span class="fc-group-icon">${cfg.icon}</span>
            <span class="fc-group-label">${esc(cfg.label)}</span>
            <span class="fc-group-count">${items.length}</span>
          </div>
          <div class="fc-group-note">${esc(cfg.note)}</div>
          <div class="fc-group-items">
            ${items.map(d => renderItem(d, cfg.fixable, type)).join('')}
          </div>
          ${cfg.fixable && items.length > 1
            ? `<button class="btn btn-secondary btn-sm fc-fix-all"
                        data-type="${esc(type)}"
                        style="margin:2px 0 8px 0">
                 ✂ Remove from all ${items.length} ${esc(cfg.label)}
               </button>`
            : ''}
        </div>`;
    }

    html += `
      <div class="fc-delete-zone" id="fcDeleteZone">
        <div class="fc-delete-note" id="fcDeleteNote">
          ${autoCount > 0
            ? '⚠ Fix all auto-fixable dependencies above first, then delete.'
            : '⚠ Remove all manual dependencies in Setup before deleting.'}
        </div>
        <button class="btn btn-danger" id="fcDelBtn" ${autoCount > 0 ? 'disabled' : ''}>
          🗑 Delete Field
        </button>
      </div>`;

    results.innerHTML = html;

    // Wire buttons
    results.querySelectorAll('.fc-fix-btn').forEach(btn => {
      btn.addEventListener('click', () =>
        fixOne(btn.dataset.type, btn.dataset.id, btn.dataset.name, fieldId));
    });
    results.querySelectorAll('.fc-setup-btn').forEach(btn => {
      btn.addEventListener('click', () => openSetup(btn.dataset.type));
    });
    results.querySelectorAll('.fc-fix-all').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.type;
        fixAll(t, _groups[t] || [], fieldId);
        btn.remove();
      });
    });

    // Wire XML inspect buttons
    results.querySelectorAll('.fc-inspect-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const dep  = [].concat(...Object.values(_groups))
                       .find(d => d.MetadataComponentId === btn.dataset.id);
        const name = dep?.MetadataComponentName || btn.dataset.id;
        toggleXmlInspector(btn.dataset.type, btn.dataset.id, name, fieldId);
      });
    });

    const delBtn = eid('fcDelBtn');
    if (delBtn) delBtn.onclick = () => confirmDelete(fieldId);
  }

  function renderItem(dep, fixable, type) {
    const id      = dep.MetadataComponentId;
    const name    = esc(dep.MetadataComponentName || id);
    const canInsp = _INSPECT_SOBJECT.hasOwnProperty(type);
    const inspBtn = canInsp
      ? `<button class="btn btn-sm fc-inspect-btn" title="View XML metadata"
                 data-id="${esc(id)}" data-type="${esc(type)}">🔍</button>`
      : '';
    const xmlPanel = canInsp
      ? `<div class="fc-xml-panel" id="fcXml_${esc(id)}" style="display:none"></div>`
      : '';

    if (fixable) {
      return `
        <div class="fc-item" id="fcItem_${esc(id)}">
          <span class="fc-item-name">${name}</span>
          <span class="fc-item-btns">
            ${inspBtn}
            <button class="btn btn-secondary btn-sm fc-fix-btn"
                    data-id="${esc(id)}" data-name="${name}" data-type="${esc(type)}">
              ✂ Remove
            </button>
          </span>
        </div>${xmlPanel}`;
    }
    return `
      <div class="fc-item" id="fcItem_${esc(id)}">
        <span class="fc-item-name">${name}</span>
        <span class="fc-item-btns">
          ${inspBtn}
          <button class="btn btn-sm fc-setup-btn" data-type="${esc(type)}">↗ Setup</button>
        </span>
      </div>${xmlPanel}`;
  }

  // ── Fix individual flow ────────────────────────────────────
  async function fixOne(type, componentId, componentName, fieldId) {
    const btn = document.querySelector(`.fc-fix-btn[data-id="${componentId}"]`);
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

    const cfg = TYPE_CFG[type] || TYPE_CFG_DEFAULT;
    try {
      if (type === 'Flow')      await fixFlow(componentId, componentName);
      if (type === 'Layout')    await fixLayout(componentId, componentName);
      if (type === 'FlexiPage') await fixFlexiPage(componentId, componentName);
      markFixed(componentId, cfg.doneLabel || '✅ Done');
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '✂ Remove'; }
      // Label the open-link button based on which builder we're sending them to.
      const linkLabel = type === 'Flow' ? '↗ Open in Flow Builder' : '↗ Open in Setup';
      appendInlineError(componentId, e.message, e.setupUrl, linkLabel);
    }
  }

  async function fixAll(type, items, fieldId) {
    for (const item of items) {
      await fixOne(type, item.MetadataComponentId,
                   item.MetadataComponentName || item.MetadataComponentId, fieldId);
    }
  }

  function markFixed(componentId, label = '✅ Done') {
    const item = eid(`fcItem_${componentId}`);
    if (!item) return;
    const name = item.querySelector('.fc-item-name')?.textContent || '';
    item.classList.add('fc-item-fixed');
    item.innerHTML = `
      <span class="fc-item-name">${esc(name)}</span>
      <span class="fc-item-ok">${esc(label)}</span>`;
    // Close any open XML inspector for this item
    const xmlPanel = eid(`fcXml_${componentId}`);
    if (xmlPanel) xmlPanel.style.display = 'none';
    checkEnableDelete();
  }

  function appendInlineError(componentId, msg, setupUrl, linkLabel) {
    const item = eid(`fcItem_${componentId}`);
    if (!item) return;
    const err = document.createElement('div');
    err.className = 'fc-item-err';
    // Plain text part (no HTML — safe).
    err.textContent = `❌ ${msg}`;
    // If we have a deep link, render it as a real button next to the text.
    if (setupUrl) {
      const btn = document.createElement('a');
      btn.className   = 'fc-item-setup-link';
      btn.href        = setupUrl;
      btn.target      = '_blank';
      btn.rel         = 'noopener';
      btn.textContent = linkLabel || '↗ Open in Setup';
      btn.style.cssText =
        'display:inline-block;margin-left:8px;padding:2px 9px;border-radius:5px;' +
        'background:#0176d3;color:#fff;font-weight:600;font-size:11px;text-decoration:none;';
      err.appendChild(btn);
    }
    item.appendChild(err);
  }

  function checkEnableDelete() {
    const remaining = document.querySelectorAll('.fc-fix-btn:not([disabled])');
    const delBtn    = eid('fcDelBtn');
    if (delBtn && remaining.length === 0) {
      delBtn.disabled = false;
      const note = eid('fcDeleteNote');
      if (note) note.textContent = 'All auto-fixable dependencies resolved. Safe to delete.';
    }
  }

  // ── Flow fix logic ─────────────────────────────────────────
  async function fixFlow(flowId, flowName) {
    // Read full flow metadata
    const flowRes = await bg({
      type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid,
      sobject: 'Flow', id: flowId
    });
    if (flowRes.error) throw new Error(`Could not read "${flowName}": ${flowRes.error}`);

    const fullName = flowRes.FullName;
    const metadata = flowRes.Metadata;
    if (!fullName || !metadata) throw new Error(`"${flowName}" returned no metadata.`);

    // Remove field references
    const changes = removeFieldRefs(metadata, _selObj.api, _selField.api);
    if (changes === 0) {
      const err = new Error(
        `Couldn't auto-remove the field from "${flowName}" — the reference is ` +
        `in a path the auto-fix can't safely change (decision condition, ` +
        `formula expression, or variable default). Click "Open in Flow Builder" ` +
        `to fix it by hand.`
      );
      if (_orgUrl) {
        err.setupUrl = `${_orgUrl.replace(/\/$/, '')}/builder_platform_interaction/flowBuilder.app?flowId=${flowId}`;
      }
      throw err;
    }

    // Save as a new Draft version (Tooling API creates this as Inactive).
    const saveRes = await bg({
      type: 'SF_CREATE_FLOW', orgUrl: _orgUrl, sid: _sid,
      fullName: fullName.replace(/-\d+$/, ''),   // strip version suffix → e.g. My_Flow-3 → My_Flow
      metadata
    });
    if (saveRes.error) throw new Error(`Could not save new version of "${flowName}": ${saveRes.error}`);

    // Fetch the new version's DefinitionId + VersionNumber so we can activate it.
    const verRes = await bg({
      type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true,
      query: `SELECT DefinitionId, VersionNumber FROM Flow WHERE Id = '${saveRes.id}'`
    });
    if (verRes.error || !verRes.records?.length) {
      const e = new Error(
        `Created a new version of "${flowName}" but couldn't read it back to ` +
        `activate. Open in Flow Builder to activate it manually.`
      );
      if (_orgUrl) e.setupUrl = `${_orgUrl.replace(/\/$/, '')}/builder_platform_interaction/flowBuilder.app?flowId=${saveRes.id}`;
      throw e;
    }
    const definitionId  = verRes.records[0].DefinitionId;
    const versionNumber = verRes.records[0].VersionNumber;

    // PATCH FlowDefinition.activeVersionNumber → makes the new version Active
    // and the old one Obsolete. This is the standard Tooling API activation path.
    const actRes = await bg({
      type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid,
      path: `services/data/v62.0/tooling/sobjects/FlowDefinition/${definitionId}`,
      body: { Metadata: { activeVersionNumber: versionNumber } }
    });
    if (actRes.error) {
      const e = new Error(
        `New version of "${flowName}" was saved but couldn't be auto-activated ` +
        `(${actRes.error}). Open in Flow Builder to activate it manually.`
      );
      if (_orgUrl) e.setupUrl = `${_orgUrl.replace(/\/$/, '')}/builder_platform_interaction/flowBuilder.app?flowId=${saveRes.id}`;
      throw e;
    }
  }

  // Remove all direct references to objApi.fieldApi from flow metadata JSON.
  // Returns the number of references removed. Decisions and formula text are
  // intentionally skipped — changing branching logic or formulas automatically
  // is too risky; the user has to remove those by hand in Flow Builder.
  function removeFieldRefs(metadata, objApi, fieldApi) {
    let changes = 0;
    const fl       = fieldApi.toLowerCase();
    const full     = `${objApi}.${fieldApi}`.toLowerCase();
    const rec      = `$record.${fieldApi}`.toLowerCase();
    const recPrior = `$record__prior.${fieldApi}`.toLowerCase();

    function refMatches(ref) {
      if (ref == null) return false;
      const r = String(ref).toLowerCase();
      return r === fl || r === full || r === rec || r === recPrior || r.endsWith('.' + fl);
    }

    function strip(arr, testFn) {
      if (!Array.isArray(arr)) return arr;
      const before = arr.length;
      const after  = arr.filter(item => !testFn(item));
      changes += before - after.length;
      return after;
    }

    // ── start — record-triggered flow entry criteria + assignments ──────
    // Very common for fields used in "trigger when …" conditions.
    if (metadata.start && typeof metadata.start === 'object') {
      metadata.start.filters = strip(metadata.start.filters, f => refMatches(f.field));
      // Some flows have `start.schedule.filters` or `start.scheduledPaths[].filters`
      if (Array.isArray(metadata.start.scheduledPaths)) {
        for (const sp of metadata.start.scheduledPaths) {
          sp.filters = strip(sp.filters, f => refMatches(f.field));
        }
      }
    }

    // ── recordLookups — filter conditions, output assignments, queried fields
    for (const el of (metadata.recordLookups || [])) {
      el.filters           = strip(el.filters,           f => refMatches(f.field));
      el.outputAssignments = strip(el.outputAssignments, a => refMatches(a.field));
      el.queriedFields     = strip(el.queriedFields,     f => refMatches(f));
    }

    // ── recordCreates — field assignments
    for (const el of (metadata.recordCreates || [])) {
      el.inputAssignments = strip(el.inputAssignments, a => refMatches(a.field));
    }

    // ── recordUpdates — filter conditions + field assignments
    for (const el of (metadata.recordUpdates || [])) {
      el.filters          = strip(el.filters,          f => refMatches(f.field));
      el.inputAssignments = strip(el.inputAssignments, a => refMatches(a.field));
    }

    // ── recordDeletes — filter conditions
    for (const el of (metadata.recordDeletes || [])) {
      el.filters = strip(el.filters, f => refMatches(f.field));
    }

    // ── screens — recursively remove inputs that directly bind to this field
    function stripScreenFields(fields) {
      if (!Array.isArray(fields)) return fields;
      return fields.filter(f => {
        if (refMatches(f.objectFieldReference)) { changes++; return false; }
        if (Array.isArray(f.fields)) f.fields = stripScreenFields(f.fields);
        return true;
      });
    }
    for (const el of (metadata.screens || [])) {
      el.fields = stripScreenFields(el.fields || []);
    }

    // ── assignments — items reading from or writing to the field
    for (const el of (metadata.assignments || [])) {
      el.assignmentItems = strip(el.assignmentItems, item =>
        refMatches(item.assignToReference) ||
        refMatches(item.value?.elementReference)
      );
    }

    // ── actionCalls — input parameters that reference the field
    for (const el of (metadata.actionCalls || [])) {
      el.inputParameters = strip(el.inputParameters, p =>
        refMatches(p.value?.elementReference)
      );
    }

    // ── subflows — input assignments that pass the field
    for (const el of (metadata.subflows || [])) {
      el.inputAssignments = strip(el.inputAssignments, a =>
        refMatches(a.value?.elementReference)
      );
    }

    // ── loops — iterating directly over the field
    for (const el of (metadata.loops || [])) {
      if (refMatches(el.collectionReference)) {
        delete el.collectionReference; changes++;
      }
    }

    // Decisions, formulas, and free-text expression fields are intentionally
    // NOT modified — branching logic changes and formula edits require human
    // review. If the dep is only in those, the user must fix manually.

    return changes;
  }

  // ── Layout fix logic ───────────────────────────────────────
  // Tooling API Layout round-trip quirks. A GET on Layout.Metadata returns
  // several compound sub-fields in shapes the PATCH parser rejects with:
  //   "Cannot deserialize instance of complexvalue from VALUE_STRING value '…'"
  //
  // Originally we pre-stripped platformActionList / quickActionList entirely.
  // That worked for the deserialize error, but on layouts with activity-aware
  // quick actions (e.g. most Contact layouts: "New Task", "Log a Call"),
  // Salesforce then regenerated default platform actions — and the defaults
  // hit "Mass quick actions don't support Activity. Use a valid entity."
  //
  // Better: let the surgical retry handle them. If only one sub-property is
  // round-trip-broken (typically `actionListContext: "Record"`), we strip JUST
  // that property — preserving the rest of platformActionList so Salesforce
  // does NOT regenerate defaults. Bare-string sentinels are still stripped
  // as a fast path (the GET sometimes returns whole complex fields as bare
  // strings meaning "at default", which is uncatchable as a sub-property).
  const _LAYOUT_COMPLEX_FIELDS = [
    'summaryLayout', 'feedLayout', 'customConsoleComponents', 'relatedContent',
    'platformActionList', 'quickActionList', 'miniLayout', 'headers'
  ];

  function sanitizeLayoutMetadata(metadata) {
    const clean = { ...metadata };
    for (const k of _LAYOUT_COMPLEX_FIELDS) {
      // A bare string where an object is expected → the field is at default;
      // drop it so PATCH doesn't choke on "complexvalue from VALUE_STRING".
      if (typeof clean[k] === 'string') delete clean[k];
    }
    return clean;
  }

  // Delete the first property matching BOTH key name and value (recursively).
  // Far more precise than matching on value alone — avoids removing an
  // unrelated, legitimate field that happens to share the value.
  function stripKeyValue(node, key, val, depth) {
    if (!node || typeof node !== 'object' || (depth || 0) > 25) return false;
    if (Array.isArray(node)) {
      for (const item of node) if (stripKeyValue(item, key, val, (depth || 0) + 1)) return true;
      return false;
    }
    if (node[key] === val) { delete node[key]; return true; }
    for (const k of Object.keys(node)) {
      if (stripKeyValue(node[k], key, val, (depth || 0) + 1)) return true;
    }
    return false;
  }

  // Value-only fallback when we can't pin down the key from the column.
  function stripFirstStringValue(node, val, depth) {
    if (!node || typeof node !== 'object' || (depth || 0) > 25) return false;
    if (Array.isArray(node)) {
      for (const item of node) if (stripFirstStringValue(item, val, (depth || 0) + 1)) return true;
      return false;
    }
    for (const k of Object.keys(node)) {
      if (node[k] === val) { delete node[k]; return true; }
    }
    for (const k of Object.keys(node)) {
      if (stripFirstStringValue(node[k], val, (depth || 0) + 1)) return true;
    }
    return false;
  }

  // Given the exact JSON string we sent and the parser's reported column,
  // find the property KEY whose bare-string value the parser choked on —
  // by reading "key":"badValue" nearest that column. This lets us strip
  // precisely the offending field instead of guessing by value.
  function keyAtColumn(jsonStr, col, badValue) {
    const start  = Math.max(0, col - 160);
    const window = jsonStr.slice(start, col + 60);
    const esc    = String(badValue).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re     = new RegExp('"([A-Za-z0-9_]+)"\\s*:\\s*"' + esc + '"', 'g');
    let m, best = null, bestDist = Infinity;
    while ((m = re.exec(window))) {
      const dist = Math.abs((start + m.index) - col);
      if (dist < bestDist) { bestDist = dist; best = m[1]; }
    }
    return best;
  }

  // PATCH a Layout's Metadata, recovering from the Tooling API's recurring
  // "Cannot deserialize complexvalue from VALUE_STRING value 'X' … column:N"
  // round-trip errors. The error names both the offending value AND its column,
  // so we surgically strip exactly that property (a bare string means the field
  // is at its default — omitting it preserves that default) and retry. Loops
  // until the PATCH succeeds, hits an unrelated error, or can't strip further.
  async function patchLayoutMetadata(componentId, metadata) {
    const body = metadata;
    for (let attempt = 0; attempt < 14; attempt++) {
      const res = await bg({
        type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid,
        path: `services/data/v62.0/tooling/sobjects/Layout/${componentId}`,
        body: { Metadata: body },
        _suppressError: true   // 400s here are part of the strip-and-retry loop
      });
      if (!res.error) return res;                       // success

      // Parse out the bad value and (when present) the column.
      const vm = /VALUE_STRING value ['"]?([^'",\s]+)/i.exec(res.error);
      if (!vm) return res;                              // unrelated error — bail
      const badValue = vm[1];
      const cm = /column:\s*(\d+)/i.exec(res.error);

      let removed = false;
      if (cm) {
        // Surgical: find the exact key at the reported column and strip it.
        const sent = JSON.stringify({ Metadata: body });
        const key  = keyAtColumn(sent, parseInt(cm[1], 10), badValue);
        if (key) removed = stripKeyValue(body, key, badValue);
      }
      // Fallback: strip by value alone if the column lookup didn't pin a key.
      if (!removed) removed = stripFirstStringValue(body, badValue);
      if (!removed) return res;                         // nothing left to strip
      // else: stripped the offending field — loop and retry
    }
    return { error: 'Layout metadata could not be made PATCH-compatible after several attempts.' };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Metadata API zip-deploy fallback for Layouts
  //
  // The Tooling API `Metadata` PATCH for Layouts is genuinely fragile —
  // some layouts (notably those with activity-related quick actions) get
  // rejected by Salesforce's own validator. The Metadata API zip-deploy
  // path is what mature SF tooling (sfdx, ant, etc.) uses, and avoids the
  // Tooling API's compound-field PATCH quirks.
  //
  // We build a minimal package containing:
  //   package.xml          — declares the Layout
  //   layouts/{FullName}.layout — the layout XML, built from the modified JSON
  // and deploy via SF_METADATA_DEPLOY (the same handler lightning-pages.js uses
  // for FlexiPage modifications).
  // ─────────────────────────────────────────────────────────────────────

  // XML escape — same escapes as XSD attribute/text content.
  function _lxEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Tooling-API descriptors injected on every nested object that aren't valid
  // XSD elements — drop them recursively before XML serialization.
  const _LX_SKIP = new Set(['attributes', 'fullName']);

  // Recursive JSON → XML serializer. Layout XSD is alphabetical at every
  // nesting level, so a sorted-keys walk produces a valid document.
  // Arrays become repeated sibling elements. null/undefined/'' are skipped.
  function _lxValueToLines(key, value, indent) {
    if (_LX_SKIP.has(key)) return [];
    if (value === null || value === undefined) return [];
    if (Array.isArray(value)) {
      // Empty arrays → drop entirely (XSD rejects empty wrappers whose
      // required children fail to appear).
      if (value.length === 0) return [];
      return value.flatMap(item => _lxValueToLines(key, item, indent));
    }
    if (typeof value === 'object') {
      const keys = Object.keys(value).filter(k => !_LX_SKIP.has(k)).sort();
      const children = keys.flatMap(k => _lxValueToLines(k, value[k], indent + '    '));
      if (children.length === 0) return [];
      return [`${indent}<${key}>`, ...children, `${indent}</${key}>`];
    }
    const str = String(value);
    if (str === '') return [];
    return [`${indent}<${key}>${_lxEsc(str)}</${key}>`];
  }

  // Layout XSD top-level field order (alphabetical, per Salesforce convention).
  // Anything not in this list is silently dropped — protects us from any
  // Tooling-API-only fields that aren't valid in the Metadata XSD.
  const _LAYOUT_TOP_ORDER = [
    'customConsoleComponents', 'emailDefault', 'excludeButtons', 'feedLayout',
    'headers', 'layoutSections', 'miniLayout', 'multilineLayoutFields',
    'platformActionList', 'quickActionList', 'relatedContent', 'relatedLists',
    'relatedObjects', 'runAssignmentRulesDefault', 'showEmailCheckbox',
    'showHighlightsPanel', 'showInteractionLogPanel', 'showKnowledgeComponent',
    'showRunAssignmentRulesCheckbox', 'showSolutionSection',
    'showSubmitAndAttachButton', 'summaryLayout'
  ];

  // opts.skip: optional Set of top-level keys to omit from the XML — used by
  // the retry deploy that drops platformActionList/quickActionList when the
  // server rejects their (Salesforce-returned-but-no-longer-valid) values.
  function buildLayoutXml(metadata, opts) {
    const skip = (opts && opts.skip) || null;
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Layout xmlns="http://soap.sforce.com/2006/04/metadata">'
    ];
    for (const key of _LAYOUT_TOP_ORDER) {
      if (skip && skip.has(key)) continue;
      // Skip a top-level value that came back as a bare-string sentinel
      // (e.g. summaryLayout: "Default" meaning "at default"). Omitting it
      // preserves the default — sending the bare string fails XSD validation.
      const v = metadata[key];
      if (typeof v === 'string' && /^[A-Z][A-Za-z]+$/.test(v)) continue;
      lines.push(..._lxValueToLines(key, v, '    '));
    }
    lines.push('</Layout>');
    return lines.join('\n');
  }

  function buildLayoutPackageXml(fullName) {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <types>',
      `        <members>${_lxEsc(fullName)}</members>`,
      '        <name>Layout</name>',
      '    </types>',
      '    <version>62.0</version>',
      '</Package>'
    ].join('\n');
  }

  // CRC-32 (lazy lookup table) — used by the stored-zip builder.
  function _lxCrc32(bytes) {
    if (!_lxCrc32._t) {
      _lxCrc32._t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        _lxCrc32._t[i] = c;
      }
    }
    let c = 0xFFFFFFFF;
    for (const b of bytes) c = _lxCrc32._t[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // Build an uncompressed (stored) ZIP and return it as a base64 string.
  // files: [{ name, data: Uint8Array }]. Identical algorithm to the one in
  // lightning-pages.js — kept local so this module is self-contained.
  function _lxBuildStoredZip(files) {
    const localBlocks = [], centralRecs = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const enc = new TextEncoder();

    for (const file of files) {
      const name = enc.encode(file.name);
      const data = file.data instanceof Uint8Array ? file.data : enc.encode(String(file.data));
      const crc  = _lxCrc32(data);
      const local = new Uint8Array(30 + name.length + data.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      local.set(name, 30);
      local.set(data, 30 + name.length);

      const central = new Uint8Array(46 + name.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 0x0314, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      central.set(name, 46);

      localBlocks.push(local);
      centralRecs.push(central);
      offset += local.length;
    }

    const centralSize = centralRecs.reduce((s, r) => s + r.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    const zip = new Uint8Array(offset + centralSize + eocd.length);
    let pos = 0;
    for (const b of localBlocks) { zip.set(b, pos); pos += b.length; }
    for (const r of centralRecs) { zip.set(r, pos); pos += r.length; }
    zip.set(eocd, pos);

    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < zip.length; i += CHUNK) {
      binary += String.fromCharCode(...zip.subarray(i, Math.min(i + CHUNK, zip.length)));
    }
    return btoa(binary);
  }

  function buildLayoutZip(fullName, metadata, opts) {
    const enc = new TextEncoder();
    return _lxBuildStoredZip([
      { name: 'package.xml',                       data: enc.encode(buildLayoutPackageXml(fullName)) },
      { name: `layouts/${fullName}.layout`,        data: enc.encode(buildLayoutXml(metadata, opts)) }
    ]);
  }

  // Deploy a modified Layout via Metadata API — used as a fallback when the
  // Tooling API PATCH fails (e.g. layouts with activity-aware quick actions).
  //
  // Two-attempt strategy:
  //   1. Deploy the full layout XML.
  //   2. If Salesforce rejects with "ActionListContext invalid" (or similar
  //      semantic refusal of platform / quick action config), retry with those
  //      sub-trees omitted. They're frequently rejected because the GET still
  //      returns enum values that newer API versions no longer accept.
  async function deployLayoutViaMetadataApi(fullName, metadata) {
    const first = await bg({
      type: 'SF_METADATA_DEPLOY', orgUrl: _orgUrl, sid: _sid,
      zipBase64: buildLayoutZip(fullName, metadata),
      _suppressError: true
    });
    if (first && first.success) return first;

    // Retry without action lists if the first deploy was rejected on them.
    const rejectedActions = first && first.error &&
      /ActionListContext|platformActionList|quickActionList|action list|quick action/i.test(first.error);
    if (rejectedActions) {
      const second = await bg({
        type: 'SF_METADATA_DEPLOY', orgUrl: _orgUrl, sid: _sid,
        zipBase64: buildLayoutZip(fullName, metadata, {
          skip: new Set(['platformActionList', 'quickActionList'])
        }),
        _suppressError: true
      });
      if (second && second.success) return second;
      // Surface the more informative original error if the retry also failed.
      return second && second.error ? second : first;
    }
    return first;
  }

  async function fixLayout(componentId, componentName) {
    const res = await bg({
      type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid,
      sobject: 'Layout', id: componentId
    });
    if (res.error) throw new Error(`Could not read "${componentName}": ${res.error}`);

    const metadata = res.Metadata;
    if (!metadata) throw new Error(`"${componentName}" returned no metadata.`);

    const changes = removeFieldFromLayout(metadata, _selField.api);
    if (changes === 0) {
      throw new Error(
        `Field not found in "${componentName}" layout sections. ` +
        'It may be in a related list or inline edit only — remove manually.'
      );
    }

    // Path 1: Tooling API PATCH with progressive retry for VALUE_STRING errors.
    // Succeeds for most layouts and is fast (~1 round-trip).
    const patchRes = await patchLayoutMetadata(componentId, sanitizeLayoutMetadata(metadata));
    if (!patchRes.error) return;

    // Path 2: Tooling API rejected this layout (typical for layouts with
    // activity-related quick actions). Fall back to Metadata API zip-deploy,
    // which is the route mature SF tooling uses and isn't subject to the
    // Tooling API's `Metadata` compound PATCH quirks.
    const fullName = res.FullName || res.fullName;
    if (fullName) {
      const deployRes = await deployLayoutViaMetadataApi(fullName, metadata);
      if (deployRes && deployRes.success) return;
      // Fall through to surface a clear error if the Metadata API also failed.
      var deployErr = deployRes && deployRes.error;
    }

    // Both paths failed — surface a clean message *with* a one-click deep link
    // to the layout in Setup, so the manual fix is 30 seconds, not a hunt.
    const toolingReason = String(patchRes.error).replace(/^HTTP\s*\d+:\s*/i, '').trim();
    const deployReason  = typeof deployErr === 'string'
                        ? String(deployErr).replace(/^HTTP\s*\d+:\s*/i, '').trim()
                        : '';
    const err = new Error(
      `Salesforce won't accept the layout update for "${componentName}" (${toolingReason}` +
      (deployReason ? `; deploy: ${deployReason}` : '') +
      `). Click "Open in Setup" to remove the field by hand — takes ~30 seconds.`
    );
    // Setup deep link: /lightning/setup/ObjectManager/{Entity}/PageLayouts/{Id}/view
    const entity = _selObj && _selObj.api ? encodeURIComponent(_selObj.api) : '';
    if (entity && _orgUrl) {
      err.setupUrl = `${_orgUrl.replace(/\/$/, '')}/lightning/setup/ObjectManager/${entity}/PageLayouts/${componentId}/view`;
    }
    throw err;
  }

  // Remove the field from every layoutItem in every section/column.
  // Replaced with emptySpace so the column structure stays valid.
  function removeFieldFromLayout(metadata, fieldApiName) {
    let changes = 0;
    const fl = fieldApiName.toLowerCase();

    for (const section of (metadata.layoutSections || [])) {
      for (const col of (section.layoutColumns || [])) {
        if (!Array.isArray(col.layoutItems)) continue;
        col.layoutItems = col.layoutItems.map(item => {
          if (item.field && item.field.toLowerCase() === fl) {
            changes++;
            return { emptySpace: true }; // preserve column structure
          }
          return item;
        });
      }
    }
    return changes;
  }

  // ── FlexiPage fix logic ────────────────────────────────────
  async function fixFlexiPage(componentId, componentName) {
    const res = await bg({
      type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid,
      sobject: 'FlexiPage', id: componentId
    });
    if (res.error) throw new Error(`Could not read "${componentName}": ${res.error}`);

    const metadata = res.Metadata;
    if (!metadata) throw new Error(`"${componentName}" returned no metadata.`);

    const changes = removeFieldFromFlexiPage(metadata, _selObj.api, _selField.api);
    if (changes === 0) {
      throw new Error(
        `No direct field references found in "${componentName}". ` +
        'The dependency may be inside a custom component — remove manually in App Builder.'
      );
    }

    const patchRes = await bg({
      type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid,
      path: `services/data/v62.0/tooling/sobjects/FlexiPage/${componentId}`,
      body: { Metadata: metadata }
    });
    if (patchRes.error) throw new Error(`Could not save "${componentName}": ${patchRes.error}`);
  }

  // Remove field references from a FlexiPage metadata object.
  // Handles two patterns:
  //   1. componentVisibilityRule criteria that test the field value
  //      → remove those criteria (if all criteria removed, delete the whole rule)
  //   2. componentInstance directly bound to the field (e.g. field-level components)
  //      → remove the entire component instance
  function removeFieldFromFlexiPage(metadata, objApi, fieldApiName) {
    let changes = 0;
    const fl  = fieldApiName.toLowerCase();
    const obj = objApi.toLowerCase();

    // Patterns that indicate a reference to the field
    function refMatches(str) {
      if (str == null) return false;
      const s = String(str).toLowerCase()
        .replace(/^\{!/, '').replace(/\}$/, ''); // strip {! ... } merge syntax
      return (
        s === fl ||
        s === `${obj}.${fl}` ||
        s === `objectrecord.${fl}` ||
        s === `$record.${fl}` ||
        s.endsWith(`.${fl}`)
      );
    }

    function cleanVisibilityRule(rule) {
      if (!rule?.criteria?.length) return rule;
      const before = rule.criteria.length;
      rule.criteria = rule.criteria.filter(c =>
        !refMatches(c.leftValue) && !refMatches(c.rightValue?.value)
      );
      changes += before - rule.criteria.length;

      if (rule.criteria.length === 0) return null; // delete rule → always visible

      // We removed criteria → the saved booleanFilter's indices are now stale.
      // Drop it entirely so Salesforce falls back to its default (AND of the
      // remaining criteria). Rebuilding it as an AND chain would silently
      // change OR / mixed logic, so dropping is the safe, predictable choice.
      if (rule.criteria.length !== before && rule.booleanFilter) {
        delete rule.booleanFilter;
      }
      return rule;
    }

    // Recursively clean a container. Two FlexiPage schemas exist in the wild:
    //   • OLD:           region.componentInstances[]    (each = a component)
    //   • NEW (Dynamic Forms): region.itemInstances[]   (each = { componentInstance: … } OR
    //                                                   { fieldInstance: … })
    // Both are handled below so the auto-fix works regardless of when the page
    // was created.
    function cleanContainer(container) {
      if (!container || typeof container !== 'object') return;

      // ── OLD schema: componentInstances (direct array of components) ──
      if (Array.isArray(container.componentInstances)) {
        container.componentInstances = container.componentInstances.filter(ci => {
          if (isFieldComponentInstance(ci)) { changes++; return false; }
          cleanInstanceVisibility(ci);
          cleanContainer(ci); // recurse into nested instances / field sections
          return true;
        });
      }

      // ── NEW schema: itemInstances[] — each wraps a single componentInstance
      //    or fieldInstance (singular). Removing a field means dropping the
      //    whole itemInstances entry (not just emptying the inner field).
      if (Array.isArray(container.itemInstances)) {
        container.itemInstances = container.itemInstances.filter(item => {
          // Dynamic-Forms field item — drop if its fieldItem references the field.
          if (item.fieldInstance && refMatches(item.fieldInstance.fieldItem)) {
            changes++; return false;
          }
          // Component item (classic field bound via componentInstanceProperties).
          if (item.componentInstance) {
            if (isFieldComponentInstance(item.componentInstance)) { changes++; return false; }
            cleanInstanceVisibility(item.componentInstance);
            cleanContainer(item.componentInstance); // nested itemInstances
          }
          // Clean visibility rule on a surviving fieldInstance (filter conditions
          // that referenced the field).
          if (item.fieldInstance) {
            cleanInstanceVisibility(item.fieldInstance);
          }
          return true;
        });
      }

      // ── Legacy plural form sometimes seen: fieldInstances[] direct array ──
      if (Array.isArray(container.fieldInstances)) {
        container.fieldInstances = container.fieldInstances.filter(fi => {
          if (refMatches(fi.fieldItem)) { changes++; return false; }
          cleanInstanceVisibility(fi);
          return true;
        });
      }

      // ── nested regions ──────────────────────────────────────────
      if (Array.isArray(container.flexiPageRegions)) {
        container.flexiPageRegions.forEach(cleanContainer);
      }
    }

    // Helper: a component instance directly bound to the field via its
    // componentInstanceProperties[].fieldApiName / field / fieldName.
    function isFieldComponentInstance(ci) {
      const props = ci && ci.componentInstanceProperties;
      if (!Array.isArray(props)) return false;
      return props.some(p =>
        ['fieldApiName', 'field', 'fieldName'].includes(p.name) && refMatches(p.value)
      );
    }
    // Helper: scrub field references out of an instance's visibility rule.
    function cleanInstanceVisibility(inst) {
      if (!inst || !inst.componentVisibilityRule) return;
      const cleaned = cleanVisibilityRule(inst.componentVisibilityRule);
      if (cleaned === null) delete inst.componentVisibilityRule;
      else inst.componentVisibilityRule = cleaned;
    }

    for (const region of (metadata.flexiPageRegions || [])) {
      cleanContainer(region);
    }

    return changes;
  }

  // ── Setup links ────────────────────────────────────────────
  function openSetup(type) {
    if (!_orgUrl) return;
    const obj = encodeURIComponent(_selObj?.api || '');
    const paths = {
      FlexiPage:      '/lightning/setup/FlexiPageList/home',
      Layout:         `/lightning/setup/ObjectManager/${obj}/PageLayouts/view`,
      ListView:       `/lightning/o/${obj}/list`,
      ValidationRule: `/lightning/setup/ObjectManager/${obj}/ValidationRules/view`,
      ApexClass:      '/lightning/setup/ApexClasses/home',
      ApexTrigger:    '/lightning/setup/ApexTriggers/home',
      WorkflowRule:   '/lightning/setup/WorkflowRules/home',
    };
    const url = _orgUrl.replace(/\/$/, '') + (paths[type] || '/lightning/setup/SetupOneHome/home');
    chrome.tabs.create({ url });
  }

  // ── Delete field ───────────────────────────────────────────
  function confirmDelete(fieldId) {
    if (!fieldId || !_selObj || !_selField) return;
    if (typeof showModal === 'function') {
      showModal(`
        <div class="modal-header modal-danger">
          <span class="modal-icon">⚠️</span>
          <h2>Delete Field</h2>
        </div>
        <div class="modal-body">
          <p>Permanently delete
             <strong>${esc(_selObj.api)}.${esc(_selField.api)}</strong>?</p>
          <p style="margin-top:8px;color:var(--danger);font-size:12px">
            This cannot be undone. All data stored in this field will be lost.
          </p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="fcCancelBtn">Cancel</button>
          <button class="btn btn-danger"    id="fcConfirmBtn">🗑 Delete</button>
        </div>`);
      eid('fcCancelBtn').onclick  = () => { if (typeof closeModal === 'function') closeModal(); };
      eid('fcConfirmBtn').onclick = () => {
        if (typeof closeModal === 'function') closeModal();
        doDelete(fieldId);
      };
    } else {
      if (confirm(`Delete ${_selObj.api}.${_selField.api}? This cannot be undone.`)) {
        doDelete(fieldId);
      }
    }
  }

  async function doDelete(fieldId) {
    const btn = eid('fcDelBtn') || eid('fcDelFreeBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Deleting…'; }

    const res = await bg({
      type: 'SF_TOOLING_DELETE', orgUrl: _orgUrl, sid: _sid,
      sobject: 'CustomField', id: fieldId
    });

    if (res.error) {
      if (btn) { btn.disabled = false; btn.textContent = '🗑 Delete Field'; }
      const errEl = document.createElement('div');
      errEl.className   = 'fc-error-msg';
      errEl.textContent = `❌ Delete failed: ${res.error}`;
      eid('fcResults').appendChild(errEl);
    } else {
      eid('fcResults').innerHTML = `
        <div class="fc-success">
          <div class="fc-success-icon">✅</div>
          <div class="fc-success-title">Field deleted</div>
          <div class="fc-success-sub">
            ${esc(_selObj.api)}.${esc(_selField.api)} has been permanently deleted.
          </div>
        </div>`;
      resetFieldAndBelow();
      if (eid('fcPill'))    eid('fcPill').style.display    = 'none';
      if (eid('fcScanBtn')) eid('fcScanBtn').style.display = 'none';
    }
  }

  // ── XML Inspector ──────────────────────────────────────────

  // Type-specific hint shown between the panel header and the code block.
  const _XI_HINT = {
    Layout:
      'Remove the highlighted <code>&lt;layoutItems&gt;</code> blocks — ' +
      'they bind this field to the layout section.',
    FlexiPage:
      'Remove the highlighted <code>&lt;componentInstances&gt;</code> / ' +
      '<code>&lt;fieldInstances&gt;</code> blocks — they render or filter on this field.',
    Flow:
      'Remove highlighted elements (<code>filters</code>, <code>outputAssignments</code>, ' +
      '<code>inputAssignments</code>, <code>queriedFields</code>) that reference this field.',
    ValidationRule:
      'Rewrite the formula in Object Manager to remove the field reference — ' +
      'the logic must be updated manually.',
    ApexClass:
      'Each highlighted line references this field. Update the code to remove or replace it.',
    ApexTrigger:
      'Each highlighted line references this field. Update the trigger to remove or replace it.',
  };

  // Type-specific deletion-block matcher called as isDeletable(tag, obj, isRef).
  // Returns true → wrap the current XML block in the red "remove this" highlight.
  const _XI_IS_DELETABLE = {
    Layout: (tag, obj, isRef) =>
      tag === 'layoutItems' &&
      typeof obj === 'object' && obj !== null &&
      isRef(obj.field),

    FlexiPage: (tag, obj, isRef) => {
      if (typeof obj !== 'object' || obj === null) return false;
      // Classic field component — XSD uses 'componentInstance' singular inside
      // a region; legacy serialization sometimes uses plural 'componentInstances'.
      if ((tag === 'componentInstance' || tag === 'componentInstances') &&
          (obj.componentInstanceProperties || []).some(p =>
            ['fieldApiName', 'field', 'fieldName'].includes(p.name) && isRef(p.value)
          )) return true;
      // Dynamic Forms field instance — XSD uses 'fieldInstance' singular inside
      // itemInstances[]; legacy direct-array form uses plural 'fieldInstances'.
      if ((tag === 'fieldInstance' || tag === 'fieldInstances') && isRef(obj.fieldItem)) return true;
      return false;
    },

    Flow: (tag, obj, isRef) => {
      if (typeof obj !== 'object' || obj === null) {
        // scalar — covers individual queriedFields API-name strings
        return tag === 'queriedFields' && isRef(obj);
      }
      if (tag === 'filters')            return !!isRef(obj.field);
      if (tag === 'outputAssignments')  return !!isRef(obj.field);
      if (tag === 'inputAssignments')   return !!isRef(obj.field);
      if (tag === 'assignmentItems')
        return !!(isRef(obj.assignToReference) ||
                  isRef(obj.value?.elementReference));
      return false;
    },
  };

  // Toggle the XML inspector panel open/closed for a dependency item.
  async function toggleXmlInspector(type, componentId, componentName, fieldId) {
    const panel    = eid(`fcXml_${componentId}`);
    const inspBtn  = document.querySelector(`.fc-inspect-btn[data-id="${componentId}"]`);
    if (!panel) return;

    // Close if already open
    if (panel.style.display !== 'none') {
      panel.style.display = 'none';
      if (inspBtn) inspBtn.classList.remove('fc-inspect-btn--open');
      return;
    }

    // Open — mark button & show loading state
    if (inspBtn) { inspBtn.classList.add('fc-inspect-btn--open'); inspBtn.disabled = true; }
    panel.style.display = 'block';
    panel.innerHTML = `<div class="fc-xml-loading">${
      window.sftkCatSm ? window.sftkCatSm('Loading metadata…') : '⏳ Loading…'
    }</div>`;

    try {
      const sobject = _INSPECT_SOBJECT[type];
      const res     = await bg({
        type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid,
        sobject, id: componentId
      });
      if (res.error) throw new Error(res.error);

      const cfg     = TYPE_CFG[type] || TYPE_CFG_DEFAULT;
      const fixable = cfg.fixable;
      let bodyHtml, refCount, delCount = 0;

      const isDeletableFn = _XI_IS_DELETABLE[type] || null;

      if (type === 'ApexClass' || type === 'ApexTrigger') {
        // Show Apex source with field refs highlighted line-by-line
        ({ html: bodyHtml, count: refCount } = _xiHighlightApex(res.Body || ''));
        bodyHtml = `<pre class="fc-xml-pre fc-xml-pre--code"><code>${bodyHtml}</code></pre>`;
      } else {
        // Render Metadata JSON as pretty XML with deletion block markers
        const meta = res.Metadata;
        if (!meta) throw new Error('No Metadata returned by the API.');
        ({ html: bodyHtml, count: refCount, delCount } = _xiRenderTree(meta, type, 0, isDeletableFn));
        bodyHtml = `<pre class="fc-xml-pre"><code>${bodyHtml}</code></pre>`;
      }

      const badgeCls = refCount ? 'fc-xml-badge--hit' : 'fc-xml-badge--miss';
      let badgeTxt = refCount
        ? `${refCount} field ref${refCount !== 1 ? 's' : ''}`
        : 'no refs found';
      if (delCount > 0) badgeTxt += ` · ${delCount} block${delCount !== 1 ? 's' : ''} to remove`;

      const hintHtml = _XI_HINT[type]
        ? `<div class="fc-xml-hint">${_XI_HINT[type]}</div>`
        : '';

      panel.innerHTML = `
        <div class="fc-xml-hdr">
          <span class="fc-xml-hdr-name">${esc(componentName)}</span>
          <span class="fc-xml-badge ${badgeCls}">${badgeTxt}</span>
          <span class="fc-xml-hdr-actions">
            ${fixable && refCount
              ? `<button class="btn btn-secondary btn-sm fc-fix-btn fc-xml-fix"
                         data-id="${esc(componentId)}" data-name="${esc(componentName)}"
                         data-type="${esc(type)}">✂ Remove</button>`
              : ''}
            <button class="fc-xml-close" data-panelid="${esc(componentId)}">✕</button>
          </span>
        </div>
        ${hintHtml}
        ${bodyHtml}`;

      // Wire close button
      panel.querySelector('.fc-xml-close')?.addEventListener('click', () => {
        panel.style.display = 'none';
        if (inspBtn) inspBtn.classList.remove('fc-inspect-btn--open');
      });

      // Wire "Remove" button inside panel (closes panel then runs the normal fix)
      panel.querySelector('.fc-xml-fix')?.addEventListener('click', () => {
        panel.style.display = 'none';
        if (inspBtn) inspBtn.classList.remove('fc-inspect-btn--open');
        fixOne(type, componentId, componentName, fieldId);
      });

      // Add prev/next navigation for field references
      if (refCount > 0) _addXmlNavigation(panel);

      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
      panel.innerHTML = `<div class="fc-xml-err">❌ ${esc(e.message)}</div>`;
    } finally {
      if (inspBtn) inspBtn.disabled = false;
    }
  }

  // Render a JSON metadata object as syntax-highlighted XML HTML.
  // Returns { html, count, delCount } where:
  //   count    = number of field-ref occurrences highlighted
  //   delCount = number of XML blocks marked for deletion
  // isDeletable(tag, obj, isRef) → boolean — type-specific deletion matcher
  function _xiRenderTree(obj, tag, depth, isDeletable) {
    if (depth > 28 || obj === null || obj === undefined) {
      return { html: '', count: 0, delCount: 0 };
    }

    const pad   = '  '.repeat(depth);
    const fl    = (_selField?.api || '').toLowerCase();
    const objLc = (_selObj?.api  || '').toLowerCase();

    function isRef(val) {
      if (!val || !fl) return false;
      const v = String(val).toLowerCase()
                  .replace(/^\{!/, '').replace(/\}$/, '').trim();
      return (
        v === fl ||
        v === `${objLc}.${fl}` ||
        v === `$record.${fl}`  ||
        v === `$record__prior.${fl}` ||
        v.endsWith('.' + fl)
      );
    }

    const oT = `<span class="xi-tag">&lt;${esc(tag)}&gt;</span>`;
    const cT = `<span class="xi-tag">&lt;/${esc(tag)}&gt;</span>`;

    // ── Scalar leaf ───────────────────────────────────────────────
    if (typeof obj !== 'object') {
      const hit = isRef(obj);
      const valHtml = hit
        ? `<span class="xi-ref">${esc(String(obj))}</span>`
        : `<span class="xi-val">${esc(String(obj))}</span>`;
      const line = `${pad}${oT}${valHtml}${cT}\n`;
      // Scalar nodes (e.g. individual queriedFields strings) can also be deletable
      if (hit && isDeletable && isDeletable(tag, obj, isRef)) {
        return {
          html:     `<span class="xi-del-block">${line}</span>`,
          count:    1,
          delCount: 1,
        };
      }
      return { html: line, count: hit ? 1 : 0, delCount: 0 };
    }

    // ── Array — repeat the parent tag for each element ────────────
    if (Array.isArray(obj)) {
      let html = '', count = 0, delCount = 0;
      for (const item of obj) {
        const r = _xiRenderTree(item, tag, depth, isDeletable);
        html += r.html; count += r.count; delCount += r.delCount;
      }
      return { html, count, delCount };
    }

    // ── Object — recurse into child keys ──────────────────────────
    let innerHtml = '', innerCount = 0, innerDel = 0;
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) {
        for (const item of v) {
          const r = _xiRenderTree(item, k, depth + 1, isDeletable);
          innerHtml += r.html; innerCount += r.count; innerDel += r.delCount;
        }
      } else {
        const r = _xiRenderTree(v, k, depth + 1, isDeletable);
        innerHtml += r.html; innerCount += r.count; innerDel += r.delCount;
      }
    }

    const blockHtml = `${pad}${oT}\n${innerHtml}${pad}${cT}\n`;
    const delThis   = isDeletable && isDeletable(tag, obj, isRef);
    if (delThis) {
      return {
        html:     `<span class="xi-del-block">${blockHtml}</span>`,
        count:    innerCount,
        delCount: innerDel + 1,
      };
    }
    return { html: blockHtml, count: innerCount, delCount: innerDel };
  }

  // Highlight field API name occurrences inside Apex source code.
  // Each matching LINE is wrapped in xi-line-hit for a full-line background.
  // Returns { html: string, count: number, delCount: 0 }.
  function _xiHighlightApex(body) {
    if (!body || !_selField?.api) return { html: esc(body), count: 0, delCount: 0 };
    const fieldPat = _selField.api.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(${fieldPat})`, 'gi');
    let count = 0;
    const html = esc(body).split('\n').map(line => {
      if (!re.test(line)) { re.lastIndex = 0; return line; }
      re.lastIndex = 0;
      const highlighted = line.replace(re, m => {
        count++;
        return `<span class="xi-ref">${m}</span>`;
      });
      return `<span class="xi-line-hit">${highlighted}</span>`;
    }).join('\n');
    return { html, count, delCount: 0 };
  }

  // ── XML reference navigator ─────────────────────────────────
  // Inserts a prev/next bar above the <pre> and auto-jumps to ref #1.
  function _addXmlNavigation(panel) {
    const pre  = panel.querySelector('.fc-xml-pre');
    if (!pre) return;
    const refs = Array.from(pre.querySelectorAll('.xi-ref'));
    if (!refs.length) return;

    let cur = -1;

    const nav = document.createElement('div');
    nav.className = 'fc-xml-nav';
    nav.innerHTML =
      `<span class="fc-xml-nav-label">🔍 References</span>` +
      `<button class="fc-xml-nav-btn fc-xml-nav-prev" title="Previous reference">◀ Prev</button>` +
      `<span class="fc-xml-nav-count">— / ${refs.length}</span>` +
      `<button class="fc-xml-nav-btn fc-xml-nav-next" title="Next reference">Next ▶</button>`;
    pre.insertAdjacentElement('beforebegin', nav);

    const countEl = nav.querySelector('.fc-xml-nav-count');

    function goTo(i) {
      if (cur >= 0 && refs[cur]) refs[cur].classList.remove('xi-ref--active');
      cur = ((i % refs.length) + refs.length) % refs.length;
      refs[cur].classList.add('xi-ref--active');
      refs[cur].scrollIntoView({ behavior: 'smooth', block: 'center' });
      countEl.textContent = `${cur + 1} / ${refs.length}`;
    }

    nav.querySelector('.fc-xml-nav-prev')
       .addEventListener('click', () => goTo(cur <= 0 ? refs.length - 1 : cur - 1));
    nav.querySelector('.fc-xml-nav-next')
       .addEventListener('click', () => goTo(cur < 0 ? 0 : cur + 1));

    // Auto-jump to first reference on open
    goTo(0);
  }

  return { init, updateSession };
})();
