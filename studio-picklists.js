'use strict';
// ════════════════════════════════════════════════════════════════
// PICKLIST & RECORD TYPE MANAGER — Phase P1 (single org)
// ════════════════════════════════════════════════════════════════
// The gap this closes: Salesforce lets you deactivate/delete a picklist value
// while thousands of records still hold it — orphan text that list views,
// reports and flow decisions silently stop matching. This view shows every
// value WITH its live usage count and record-type assignments, and never
// touches metadata without first offering a DATA FIX (remap / clear) — with
// an automation-impact panel (triggers, record-triggered flows, validation
// rules) so a mass update is never a surprise.
//
// V1 scope: custom picklist/multipicklist fields with a LOCAL value set.
// Global value sets and standard picklists render read-only (Phase P4).
// Multi-org matrix + bulk apply is Phase P2; RT editing is Phase P3.

// ── Pure helpers (top-level for unit tests) ─────────────────────

// Rebuild a multipicklist string after remapping/removing one token.
// 'A;B;C' remap B→X = 'A;X;C' · clear B = 'A;C' · dedupes ('A;X' + X stays single).
function pkMultiRemap(current, oldVal, newVal) {
  const tokens = String(current || '').split(';').map(t => t.trim()).filter(Boolean);
  const out = [];
  for (const t of tokens) {
    const mapped = t === oldVal ? newVal : t;
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out.join(';');
}

// Read a Tooling CustomValue's API name across the JSON shapes Salesforce
// returns (fullName in some API versions, valueName in others).
function pkValueName(v) {
  return v?.fullName ?? v?.valueName ?? v?.label ?? '';
}

// ── View state ──────────────────────────────────────────────────
let _pkOrgUrl   = '';
let _pkObj      = '';
let _pkField    = '';
let _pkObjCache = {};     // orgKey → [{name, label}]
let _pkInv      = null;   // loaded inventory (null = nothing loaded)

function renderPicklists() {
  const orgs = allMapOrgs();
  if (!_pkOrgUrl) _pkOrgUrl = _workingPair.src || _orgUrl || (orgs[0] && orgs[0].url) || '';
  const orgOptions = orgs.map(o =>
    `<option value="${esc(o.url)}" ${_orgKey(o.url) === _orgKey(_pkOrgUrl) ? 'selected' : ''}>${esc(orgOptionLabel(o.url, o.label))}</option>`).join('');

  setMain(`
    <div class="ds-view-header">
      <div class="ds-view-title-wrap">
        <h2 class="ds-view-title">🎚 Picklists</h2>
        <div class="ds-view-subtitle">Value usage, safe deactivation, data fixes — per org</div>
      </div>
    </div>
    <div class="ds-pk-config">
      <select id="dsPkOrg" class="ds-select">${orgOptions || '<option value="">No orgs known</option>'}</select>
      <select id="dsPkObj" class="ds-select" ${_pkObj ? '' : 'disabled'}>
        <option value="">${_pkObj ? esc(_pkObj) : 'Object…'}</option>
      </select>
      <select id="dsPkField" class="ds-select" disabled><option value="">Field…</option></select>
      <button class="ds-btn ds-btn-primary" id="dsPkLoad" disabled>Load values</button>
    </div>
    <div id="dsPkBody">
      <div class="ds-empty-page">
        <div class="ds-empty-icon">${window.sftkCatSvg ? window.sftkCatSvg('sleep', 64) : '🎚'}</div>
        <div class="ds-empty-title">Pick an org, object and picklist field</div>
        <div class="ds-empty-sub">You'll get every value with its live record count, record-type
        assignments, and safe deactivate / delete / remap operations.</div>
      </div>
    </div>`);

  eid('dsPkOrg')?.addEventListener('change', async e => {
    _pkOrgUrl = e.target.value; _pkObj = ''; _pkField = ''; _pkInv = null;
    await _pkLoadObjects();
  });
  eid('dsPkObj')?.addEventListener('change', async e => {
    _pkObj = e.target.value; _pkField = ''; _pkInv = null;
    await _pkLoadFields();
  });
  eid('dsPkField')?.addEventListener('change', e => {
    _pkField = e.target.value;
    const btn = eid('dsPkLoad');
    if (btn) btn.disabled = !_pkField;
  });
  eid('dsPkLoad')?.addEventListener('click', () => loadPicklistInventory());

  if (_pkOrgUrl) _pkLoadObjects();
}

// ── Pickers ─────────────────────────────────────────────────────
async function _pkLoadObjects() {
  const sel = eid('dsPkObj');
  if (!sel || !_pkOrgUrl) return;
  sel.disabled = true;
  sel.innerHTML = '<option value="">Loading objects…</option>';
  const key = _orgKey(_pkOrgUrl);
  if (!_pkObjCache[key]) {
    const sess = await getOrgSession(_pkOrgUrl);
    if (!sess) { sel.innerHTML = '<option value="">Org not open in a tab — open it and retry</option>'; return; }
    const res = await sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
      path: 'services/data/v62.0/sobjects' });
    if (res.error) { sel.innerHTML = `<option value="">${esc(res.error).slice(0, 60)}</option>`; return; }
    _pkObjCache[key] = (res.sobjects || [])
      .filter(o => o.queryable && o.updateable && !o.customSetting && !/^(.*__(Tag|Share|History|Feed|ChangeEvent))$/.test(o.name))
      .map(o => ({ name: o.name, label: o.label }));
  }
  sel.innerHTML = '<option value="">Object…</option>' + _pkObjCache[key]
    .map(o => `<option value="${esc(o.name)}" ${o.name === _pkObj ? 'selected' : ''}>${esc(o.label)} (${esc(o.name)})</option>`).join('');
  sel.disabled = false;
  if (_pkObj) _pkLoadFields();
}

async function _pkLoadFields() {
  const sel = eid('dsPkField');
  if (!sel || !_pkObj) return;
  sel.disabled = true;
  sel.innerHTML = '<option value="">Loading fields…</option>';
  const sess = await getOrgSession(_pkOrgUrl);
  if (!sess) { sel.innerHTML = '<option value="">Org not open</option>'; return; }
  const desc = await describe(_pkObj, sess.orgUrl, sess.sid);
  const picks = (desc?.fields || []).filter(f => f.type === 'picklist' || f.type === 'multipicklist');
  if (!picks.length) { sel.innerHTML = '<option value="">No picklist fields on this object</option>'; return; }
  sel.innerHTML = '<option value="">Field…</option>' + picks
    .map(f => `<option value="${esc(f.name)}" ${f.name === _pkField ? 'selected' : ''}>${esc(f.label)} (${esc(f.name)})${f.type === 'multipicklist' ? ' — multi' : ''}</option>`).join('');
  sel.disabled = false;
  const btn = eid('dsPkLoad');
  if (btn) btn.disabled = !_pkField;
}

// ── Inventory load ──────────────────────────────────────────────
async function loadPicklistInventory() {
  const body = eid('dsPkBody');
  if (!body || !_pkOrgUrl || !_pkObj || !_pkField) return;
  body.innerHTML = `<div class="ds-init-loading">${window.sftkCat ? sftkCat('Reading values, usage & record types…') : 'Loading…'}</div>`;

  const sess = await getOrgSession(_pkOrgUrl);
  if (!sess) { body.innerHTML = `<div class="ds-seq-empty">Org isn't open in a Chrome tab — open it, then reload.</div>`; return; }

  try {
    const desc = await describe(_pkObj, sess.orgUrl, sess.sid);
    const fieldMeta = (desc?.fields || []).find(f => f.name === _pkField);
    if (!fieldMeta) throw new Error(`${_pkField} not found on ${_pkObj}`);
    const isMulti = fieldMeta.type === 'multipicklist';

    // V1: custom fields only (standard picklists need StandardValueSet — P4).
    if (!/__c$/i.test(_pkField)) {
      body.innerHTML = `<div class="ds-pk-banner">🔒 <strong>${esc(_pkField)}</strong> is a standard picklist —
        managed via StandardValueSet metadata, coming in the next phase (P4). Custom fields (__c) are fully supported today.</div>`;
      return;
    }

    // Tooling: resolve the CustomField id, then fetch full Metadata (the only
    // way to see INACTIVE values — describe returns active ones only).
    const devName = _pkField.replace(/__c$/i, '');
    const idRes = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true,
      query: `SELECT Id, TableEnumOrId FROM CustomField WHERE DeveloperName = ${soqlStrLit(devName)}` });
    if (idRes.error) throw new Error(idRes.error);
    let rows = idRes.records || [];
    if (rows.length > 1) {
      // Same field name on several objects — resolve our object's durable id.
      const ent = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true,
        query: `SELECT DurableId FROM EntityDefinition WHERE QualifiedApiName = ${soqlStrLit(_pkObj)}` });
      const durable = (ent.records || [])[0]?.DurableId;
      rows = rows.filter(r => r.TableEnumOrId === _pkObj || (durable && r.TableEnumOrId === durable));
    }
    const fieldId = rows[0]?.Id;
    if (!fieldId) throw new Error('Could not locate this field in the Tooling API (Customize Application permission needed).');

    const cf = await sendBg({ type: 'SF_TOOLING_GET', orgUrl: sess.orgUrl, sid: sess.sid,
      sobject: 'CustomField', id: fieldId });
    if (cf.error || !cf.Metadata) throw new Error(cf.error || 'Field metadata unavailable');

    if (cf.Metadata.valueSet?.valueSetName) {
      body.innerHTML = `<div class="ds-pk-banner">🌐 <strong>${esc(_pkField)}</strong> uses the global value set
        <strong>${esc(cf.Metadata.valueSet.valueSetName)}</strong> — editing it changes every field that shares it.
        Global value sets arrive in phase P4; this view stays read-only for it.</div>`;
      return;
    }
    const rawValues = cf.Metadata.valueSet?.valueSetDefinition?.value || [];
    if (!rawValues.length) throw new Error('No values found in this field\'s value set.');

    // Usage counts. Single picklist: one GROUP BY. Multipicklist: GROUP BY is
    // not allowed → one INCLUDES count per value (capped).
    const usage = new Map();   // valueName → count
    let usageNote = '', nullCount = 0, totalCount = 0;
    if (!isMulti) {
      const agg = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false,
        query: `SELECT ${_pkField} pv, COUNT(Id) cnt FROM ${_pkObj} GROUP BY ${_pkField}` });
      if (agg.error) { usageNote = `Usage counts unavailable: ${agg.error}`; }
      else for (const r of (agg.records || [])) {
        const v = r.pv ?? r[_pkField];
        const c = r.cnt ?? r.expr0 ?? 0;
        totalCount += c;
        if (v == null) nullCount = c; else usage.set(String(v), c);
      }
      if ((agg.records || []).length >= 2000) usageNote = 'Object has >2000 distinct values — counts may be partial.';
    } else {
      const CAP = 30;
      const toCount = rawValues.slice(0, CAP);
      for (const v of toCount) {
        const name = pkValueName(v);
        const r = await sendBg({ type: 'SF_REST_QUERY', orgUrl: sess.orgUrl, sid: sess.sid,
          query: `SELECT COUNT() FROM ${_pkObj} WHERE ${_pkField} INCLUDES (${soqlStrLit(name)})` });
        usage.set(name, r.error ? -1 : (r.totalSize ?? 0));
      }
      if (rawValues.length > CAP) usageNote = `Counted the first ${CAP} of ${rawValues.length} values (multi-select counts are one query each).`;
    }

    // Record types + this field's per-RT assignments (cap the metadata fetches).
    let rts = [], rtNote = '';
    const rtRes = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false,
      query: `SELECT Id, Name, DeveloperName, IsActive FROM RecordType WHERE SObjectType = ${soqlStrLit(_pkObj)}` });
    const rtRows = (rtRes.records || []).filter(r => r.IsActive);
    const RT_CAP = 8;
    for (const rt of rtRows.slice(0, RT_CAP)) {
      const meta = await sendBg({ type: 'SF_TOOLING_GET', orgUrl: sess.orgUrl, sid: sess.sid,
        sobject: 'RecordType', id: rt.Id });
      const plEntry = (meta?.Metadata?.picklistValues || []).find(p =>
        p.picklist === _pkField || p.picklist === devName);
      rts.push({ id: rt.Id, name: rt.Name, values: new Set((plEntry?.values || []).map(v => pkValueName(v))) });
    }
    if (rtRows.length > RT_CAP) rtNote = `Showing ${RT_CAP} of ${rtRows.length} record types.`;

    _pkInv = {
      orgUrl: sess.orgUrl, sid: sess.sid, obj: _pkObj, field: _pkField, fieldId, isMulti,
      metadata: cf.Metadata, rawValues, usage, usageNote, nullCount, totalCount, rts, rtNote,
    };
    _pkRenderInventory();
  } catch (e) {
    const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(e.message) : { message: e.message };
    body.innerHTML = `<div class="ds-seq-empty" title="${esc(e.message)}">❌ ${esc(fe.message)}${fe.hint ? `<div class="ds-pk-hint">💡 ${esc(fe.hint)}</div>` : ''}</div>`;
  }
}

// ── Inventory render ────────────────────────────────────────────
function _pkRenderInventory() {
  const body = eid('dsPkBody');
  const inv = _pkInv;
  if (!body || !inv) return;

  const maxCount = Math.max(1, ...inv.usage.values());
  const rowsHtml = inv.rawValues.map((v, i) => {
    const name   = pkValueName(v);
    const active = v.isActive !== false;
    const count  = inv.usage.has(name) ? inv.usage.get(name) : null;
    const rtChips = inv.rts.filter(rt => rt.values.has(name))
      .map(rt => `<span class="ds-pk-rt" title="Assigned to record type ${esc(rt.name)}">${esc(rt.name)}</span>`).join('');
    return `
      <div class="ds-pk-row${active ? '' : ' ds-pk-row-inactive'}">
        <div class="ds-pk-val">
          <span class="ds-pk-name">${esc(v.label || name)}</span>
          ${v.label && v.label !== name ? `<code class="ds-pk-api">${esc(name)}</code>` : ''}
          ${v.default ? '<span class="ds-pk-default">default</span>' : ''}
          ${active ? '' : '<span class="ds-pk-inactive-badge">inactive</span>'}
        </div>
        <div class="ds-pk-usage" title="${count == null ? 'not counted' : count === -1 ? 'count failed' : count.toLocaleString() + ' record(s) hold this value'}">
          ${count == null ? '<span class="ds-pk-uncounted">—</span>'
            : count === -1 ? '<span class="ds-pk-uncounted">?</span>'
            : `<span class="ds-pk-bar"><span class="ds-pk-fill" style="width:${Math.max(2, Math.round(count / maxCount * 100))}%"></span></span>
               <span class="ds-pk-count">${count.toLocaleString()}</span>`}
        </div>
        <div class="ds-pk-rts">${rtChips || '<span class="ds-pk-uncounted">—</span>'}</div>
        <div class="ds-pk-actions">
          ${(count > 0) ? `<button class="ds-btn ds-btn-sm" data-pk-fix="${i}" title="Move the ${count.toLocaleString()} record(s) holding this value to another value (or clear them)">🔧 Fix data…</button>` : ''}
          <button class="ds-btn ds-btn-sm" data-pk-toggle="${i}">${active ? '⏸ Deactivate' : '▶ Activate'}</button>
          <button class="ds-btn ds-btn-sm ds-btn-danger" data-pk-del="${i}" title="Remove the value from the value set entirely">🗑</button>
        </div>
      </div>`;
  }).join('');

  const activeN   = inv.rawValues.filter(v => v.isActive !== false).length;
  const inactiveN = inv.rawValues.length - activeN;

  body.innerHTML = `
    <div class="ds-pk-summary">
      <strong>${inv.rawValues.length}</strong> value${inv.rawValues.length !== 1 ? 's' : ''}
      (${activeN} active${inactiveN ? `, ${inactiveN} inactive` : ''})
      ${inv.isMulti ? ' · multi-select' : ''}
      ${!inv.isMulti && inv.totalCount ? ` · ${inv.totalCount.toLocaleString()} records total` : ''}
      ${inv.nullCount ? ` · ${inv.nullCount.toLocaleString()} blank` : ''}
      ${prodBadge(inv.orgUrl)}
    </div>
    ${inv.usageNote ? `<div class="ds-pk-note">⚠ ${esc(inv.usageNote)}</div>` : ''}
    ${inv.rtNote ? `<div class="ds-pk-note">${esc(inv.rtNote)}</div>` : ''}
    <div class="ds-pk-table">
      <div class="ds-pk-head">
        <div class="ds-pk-val">Value</div><div class="ds-pk-usage">Records</div>
        <div class="ds-pk-rts">Record types</div><div class="ds-pk-actions"></div>
      </div>
      ${rowsHtml}
    </div>`;

  body.querySelectorAll('[data-pk-fix]').forEach(b =>
    b.addEventListener('click', () => _pkOpenWizard(parseInt(b.dataset.pkFix, 10), 'fix')));
  body.querySelectorAll('[data-pk-toggle]').forEach(b =>
    b.addEventListener('click', () => _pkOpenWizard(parseInt(b.dataset.pkToggle, 10), 'toggle')));
  body.querySelectorAll('[data-pk-del]').forEach(b =>
    b.addEventListener('click', () => _pkOpenWizard(parseInt(b.dataset.pkDel, 10), 'delete')));
}

// ── Automation-impact panel data ────────────────────────────────
async function _pkImpact(inv) {
  const lit = soqlStrLit(inv.obj);
  const [trg, vr, wf, fdv] = await Promise.all([
    sendBg({ type: 'SF_QUERY_ALL', orgUrl: inv.orgUrl, sid: inv.sid, tooling: true,
      query: `SELECT Name FROM ApexTrigger WHERE TableEnumOrId = ${lit} AND Status = 'Active'`, _silentError: true }),
    sendBg({ type: 'SF_QUERY_ALL', orgUrl: inv.orgUrl, sid: inv.sid, tooling: true,
      query: `SELECT ValidationName FROM ValidationRule WHERE Active = true AND EntityDefinition.QualifiedApiName = ${lit}`, _silentError: true }),
    sendBg({ type: 'SF_QUERY_ALL', orgUrl: inv.orgUrl, sid: inv.sid, tooling: true,
      query: `SELECT Name FROM WorkflowRule WHERE TableEnumOrId = ${lit}`, _silentError: true }),
    sendBg({ type: 'SF_QUERY_ALL', orgUrl: inv.orgUrl, sid: inv.sid, tooling: false,
      query: `SELECT Label FROM FlowDefinitionView WHERE IsActive = true AND TriggerObjectOrEventApiName = ${lit}`, _silentError: true }),
  ]);
  const names = (res, k) => (res && !res.error && res.records) ? res.records.map(r => r[k]).filter(Boolean) : null;
  return {
    triggers: names(trg, 'Name'),
    validationRules: names(vr, 'ValidationName'),
    workflowRules: names(wf, 'Name'),
    flows: names(fdv, 'Label'),   // null = couldn't enumerate (old API) — say so
  };
}

function _pkImpactHtml(impact, recordCount) {
  const row = (icon, label, list) => list === null
    ? `<div class="ds-pk-imp-row">${icon} ${label}: <em>couldn't check</em></div>`
    : `<div class="ds-pk-imp-row${list.length ? ' ds-pk-imp-hit' : ''}">${icon} ${label}: <strong>${list.length}</strong>${list.length ? ` — ${esc(list.slice(0, 4).join(', '))}${list.length > 4 ? '…' : ''}` : ''}</div>`;
  return `
    <div class="ds-pk-impact">
      <div class="ds-pk-imp-title">⚡ Updating ${recordCount.toLocaleString()} record(s) will run the object's automation:</div>
      ${row('⚡', 'Active triggers', impact.triggers)}
      ${row('🌊', 'Record-triggered flows', impact.flows)}
      ${row('✅', 'Validation rules', impact.validationRules)}
      ${row('⚙️', 'Workflow rules', impact.workflowRules)}
      <div class="ds-pk-imp-hint">💡 Validation rules can reject rows (they'll show as row errors);
      triggers and flows WILL fire — schedule big fixes for quiet hours.</div>
    </div>`;
}

// ── The wizard (fix / toggle / delete share one dialog) ─────────
async function _pkOpenWizard(idx, mode) {
  const inv = _pkInv;
  if (!inv) return;
  const v = inv.rawValues[idx];
  const name = pkValueName(v);
  const active = v.isActive !== false;
  const count = inv.usage.get(name) || 0;

  // Activate is metadata-only, no ceremony.
  if (mode === 'toggle' && !active) return _pkApplyMetadata(idx, { activate: true });

  const others = inv.rawValues.filter((o, i) => i !== idx && o.isActive !== false)
    .map(o => pkValueName(o));
  const needsFix = count > 0;
  const fixRequired = mode === 'delete' && needsFix;

  const impact = needsFix ? await _pkImpact(inv) : null;

  const title = mode === 'delete' ? `Delete value “${name}”`
              : mode === 'fix'    ? `Fix data for “${name}”`
              :                     `Deactivate “${name}”`;
  showModal(`
    <div class="ds-modal-header">${mode === 'delete' ? '🗑' : mode === 'fix' ? '🔧' : '⏸'} ${esc(title)}</div>
    <div class="ds-modal-body">
      ${needsFix ? `
        <p><strong>${count.toLocaleString()}</strong> record${count !== 1 ? 's' : ''} currently hold${count === 1 ? 's' : ''} this value.
        ${mode === 'delete' ? 'Deleting without a fix leaves ORPHAN text — filters and reports silently stop matching it.'
          : mode === 'toggle' ? 'Deactivating keeps the stored value but users can no longer select it.' : ''}</p>
        <div class="ds-pk-fixchoice">
          <label><input type="radio" name="dsPkFixMode" value="remap" checked>
            Move them to:
            <select id="dsPkRemapTarget" class="ds-select ds-select-sm">
              ${others.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
            </select>
          </label>
          <label><input type="radio" name="dsPkFixMode" value="clear"> Clear the value (${inv.isMulti ? 'remove it from each record’s selection' : 'set the field blank'})</label>
          ${fixRequired ? '' : `<label><input type="radio" name="dsPkFixMode" value="skip"> Skip the data fix${mode === 'toggle' ? ' — records keep the value' : ''}</label>`}
        </div>
        ${_pkImpactHtml(impact, count)}
      ` : `<p>No records hold this value — this is a metadata-only change.</p>`}
      ${mode === 'delete' ? `<div class="ds-pk-delwarn">⛔ Deleting removes the value from the value set permanently
        (records already fixed above are unaffected). Prefer <strong>Deactivate</strong> unless you're sure.</div>` : ''}
    </div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      <button class="ds-btn ${mode === 'delete' ? 'ds-btn-danger' : 'ds-btn-primary'}" id="dsPkGo">
        ${mode === 'delete' ? '🗑 Delete value' : mode === 'fix' ? '🔧 Run data fix' : '⏸ Deactivate'}
      </button>
    </div>`);

  eid('dsPkGo')?.addEventListener('click', async () => {
    const fixMode = needsFix
      ? (document.querySelector('input[name="dsPkFixMode"]:checked')?.value || 'skip')
      : 'skip';
    const target = fixMode === 'remap' ? eid('dsPkRemapTarget')?.value : null;
    closeModal();

    // Production guard — one typed confirm covers data fix + metadata change.
    if (cachedOrgType(inv.orgUrl) === 'production') {
      const okProd = await confirmTypedProd(orgLabel(inv.orgUrl),
        `${mode} picklist value "${name}" on ${inv.obj}.${inv.field}`);
      if (!okProd) return;
    }

    if (fixMode !== 'skip' && count > 0) {
      const fixOk = await _pkRunDataFix(name, fixMode, target);
      if (!fixOk) return;   // fix failed/partial — leave metadata untouched
    }
    if (mode === 'toggle') await _pkApplyMetadata(idx, { deactivate: true });
    if (mode === 'delete') await _pkApplyMetadata(idx, { remove: true });
    if (mode === 'fix') loadPicklistInventory();
  });
}

// ── Data fix runner ─────────────────────────────────────────────
async function _pkRunDataFix(value, fixMode, target) {
  const inv = _pkInv;
  const body = eid('dsPkBody');
  const prog = document.createElement('div');
  prog.className = 'ds-pk-progress';
  prog.innerHTML = window.sftkCatSm ? sftkCatSm('Fetching records…') : 'Fetching records…';
  body?.prepend(prog);

  const startedAt = new Date().toISOString();
  let updated = 0, failed = 0;
  const errors = [];
  try {
    const lit = soqlStrLit(value);
    const q = inv.isMulti
      ? `SELECT Id, ${inv.field} FROM ${inv.obj} WHERE ${inv.field} INCLUDES (${lit})`
      : `SELECT Id FROM ${inv.obj} WHERE ${inv.field} = ${lit}`;
    const res = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: inv.orgUrl, sid: inv.sid, tooling: false, query: q });
    if (res.error) throw new Error(res.error);
    const recs = res.records || [];

    for (let i = 0; i < recs.length; i += 200) {
      const chunk = recs.slice(i, i + 200).map(r => ({
        attributes: { type: inv.obj }, Id: r.Id,
        [inv.field]: inv.isMulti
          ? (pkMultiRemap(r[inv.field], value, fixMode === 'remap' ? target : null) || null)
          : (fixMode === 'remap' ? target : null),
      }));
      const out = await sendBg({ type: 'SF_COLLECTIONS_UPDATE', orgUrl: inv.orgUrl, sid: inv.sid, records: chunk });
      if (out?.error) throw new Error(out.error);
      (Array.isArray(out) ? out : []).forEach(r => {
        if (r.success) updated++;
        else { failed++; if (errors.length < 20) errors.push((r.errors || []).map(e => e.message).join('; ')); }
      });
      prog.innerHTML = window.sftkCatSm
        ? sftkCatSm(`Fixing… ${Math.min(i + 200, recs.length)} / ${recs.length} (${failed} failed)`)
        : `Fixing… ${Math.min(i + 200, recs.length)} / ${recs.length}`;
    }

    // Dedupe identical row errors (validation rules produce N copies).
    const seen = new Map();
    for (const e of errors) seen.set(e, (seen.get(e) || 0) + 1);
    const dedup = [...seen.entries()].map(([m, c]) => c > 1 ? `${m}  (×${c})` : m);

    _history.push({
      id: genId('run'), kind: 'picklist-fix',
      profileName: `Picklist fix: ${inv.obj}.${inv.field} “${value}” → ${fixMode === 'remap' ? `“${target}”` : 'cleared'}`,
      startedAt, completedAt: new Date().toISOString(),
      status: failed === 0 ? 'success' : (updated > 0 ? 'partial' : 'failed'),
      sourceOrg: inv.orgUrl, targetOrg: inv.orgUrl,
      summary: { [inv.obj]: { created: 0, failed, updated } },
      errors: dedup,
    });
    await storageSaveHistory();

    showToast(failed === 0
      ? `✅ ${updated.toLocaleString()} record(s) moved off “${value}”`
      : `⚠ ${updated} fixed, ${failed} failed — see History for the errors`, failed ? 'warning' : 'success', 6000);
    return failed === 0;
  } catch (e) {
    showToast(`❌ Data fix failed: ${e.message}`, 'error', 7000);
    return false;
  } finally {
    prog.remove();
  }
}

// ── Metadata apply (activate / deactivate / remove a value) ─────
async function _pkApplyMetadata(idx, op) {
  const inv = _pkInv;
  try {
    const md = JSON.parse(JSON.stringify(inv.metadata));
    const list = md.valueSet.valueSetDefinition.value;
    if (op.remove) list.splice(idx, 1);
    else {
      list[idx].isActive = !!op.activate;
      if (op.deactivate && list[idx].default) list[idx].default = false;   // inactive default is invalid
    }
    const res = await sendBg({ type: 'SF_PATCH', orgUrl: inv.orgUrl, sid: inv.sid,
      path: `services/data/v62.0/tooling/sobjects/CustomField/${inv.fieldId}`,
      body: { Metadata: md } });
    if (res?.error) throw new Error(res.error);
    showToast(op.remove ? '🗑 Value deleted from the value set'
      : op.activate ? '▶ Value activated' : '⏸ Value deactivated', 'success');
    loadPicklistInventory();
  } catch (e) {
    const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(e.message) : { message: e.message };
    showToast(`❌ Metadata update failed: ${fe.message}`, 'error', 8000);
  }
}
