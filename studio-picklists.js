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

// Ordered union of value names across per-org value lists (P2 matrix rows).
// perOrg: [{ orgKey, values:[name] }]. Preserves first-seen order; each org
// contributes new names in its own order. Pure — unit-testable.
function pkValueUnion(perOrg) {
  const seen = new Set(), out = [];
  for (const org of (perOrg || [])) {
    for (const name of (org.values || [])) {
      if (name && !seen.has(name)) { seen.add(name); out.push(name); }
    }
  }
  return out;
}

// Build a value×org matrix (P2). orgResults: [{ orgKey, label, inv|null, skip }].
// Returns { values:[name], rows:[{ name, cells:[{orgKey, exists, active, count, missing}] }] }.
// Pure — unit-testable (no DOM, no I/O).
function pkBuildMatrix(orgResults, unionValues) {
  const rows = (unionValues || []).map(name => {
    const cells = (orgResults || []).map(o => {
      if (!o.inv) return { orgKey: o.orgKey, missing: true };
      const v = o.inv.rawValues.find(rv => pkValueName(rv) === name);
      if (!v) return { orgKey: o.orgKey, exists: false };
      const count = o.inv.usage.has(name) ? o.inv.usage.get(name) : null;
      return { orgKey: o.orgKey, exists: true, active: v.isActive !== false, count };
    });
    return { name, cells };
  });
  return { values: unionValues || [], rows };
}

// Which of one org's record types include a value. rts: [{ name, devName,
// values:Set }] (from _pkLoadRecordTypes). Pure — unit-testable.
function pkRtCellInfo(rts, valueName) {
  const list = rts || [];
  const inRts = list.filter(rt => rt.values && rt.values.has(valueName));
  return { inCount: inRts.length, total: list.length, names: inRts.map(rt => rt.name || rt.devName) };
}

// Does a value's record-type ASSIGNMENT differ across orgs? Record types are
// matched cross-org by DeveloperName (the P5 sync rule); only devNames present
// in ≥2 orgs are comparable — an RT existing in just one org is an RT-set
// difference, not an assignment drift (the Sync plan's RT alignment covers
// that). perOrgRts: array of rts arrays, one per loaded org. Pure.
function pkRtDrift(perOrgRts, valueName) {
  const byDev = new Map();   // devName → Set('y'|'n') across the orgs that have this RT
  for (const rts of (perOrgRts || [])) {
    for (const rt of (rts || [])) {
      if (!rt.devName) continue;
      const has = rt.values && rt.values.has(valueName) ? 'y' : 'n';
      const s = byDev.get(rt.devName) || new Set();
      s.add(has);
      byDev.set(rt.devName, s);
    }
  }
  for (const s of byDev.values()) if (s.size > 1) return true;
  return false;
}

// Count literal occurrences of a picklist value name inside a blob of
// automation metadata text (P2 value-literal scan). Pure — unit-testable.
function pkValueMentions(text, valueName) {
  if (!text || !valueName) return 0;
  const escaped = String(valueName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(text).match(new RegExp(escaped, 'g'));
  return m ? m.length : 0;
}

// Dedupe identical row-error strings (validation rules emit N copies).
// Pure — unit-testable. Returns strings with a "(×N)" suffix when repeated.
function pkDedupeErrors(errors) {
  const seen = new Map();
  for (const e of (errors || [])) seen.set(e, (seen.get(e) || 0) + 1);
  return [...seen.entries()].map(([m, c]) => c > 1 ? `${m}  (×${c})` : m);
}

// Compute per-record-type add/remove diffs for the RT×value matrix (P3).
// rts: [{ id, values:Set<name> }]. edited: Map(`${rtId}|${val}` → boolChecked).
// Returns [{ rtId, adds:[val], removes:[val] }] for RTs that actually changed.
// Pure — unit-testable.
function pkRtMatrixDiff(rts, edited) {
  const out = [];
  for (const rt of (rts || [])) {
    const adds = [], removes = [];
    for (const [key, checked] of edited.entries()) {
      const sep = key.indexOf('|');
      if (key.slice(0, sep) !== rt.id) continue;
      const val = key.slice(sep + 1);
      const had = rt.values.has(val);
      if (checked && !had) adds.push(val);
      if (!checked && had) removes.push(val);
    }
    if (adds.length || removes.length) out.push({ rtId: rt.id, adds, removes });
  }
  return out;
}

// Diff a TARGET org's value set against the SOURCE org's (P5 sync-from-source).
// srcRaw/tgtRaw: raw Tooling value arrays. Pure — unit-testable.
// Returns { adds, labelChanges, activate, deactivate, extras, defaultChange }.
function pkValueSetSyncDiff(srcRaw, tgtRaw) {
  const tgtBy = new Map((tgtRaw || []).map(v => [pkValueName(v), v]));
  const srcBy = new Map((srcRaw || []).map(v => [pkValueName(v), v]));
  const adds = [], labelChanges = [], activate = [], deactivate = [];
  for (const sv of (srcRaw || [])) {
    const name = pkValueName(sv);
    if (!name) continue;
    const tv = tgtBy.get(name);
    const sActive = sv.isActive !== false;
    if (!tv) { adds.push({ name, label: sv.label || name, active: sActive }); continue; }
    const tActive = tv.isActive !== false;
    if (sActive && !tActive) activate.push(name);
    if (!sActive && tActive) deactivate.push(name);
    const sLabel = sv.label || name, tLabel = tv.label || name;
    if (sLabel !== tLabel) labelChanges.push({ name, from: tLabel, to: sLabel });
  }
  const extras = (tgtRaw || [])
    .filter(tv => tv.isActive !== false && !srcBy.has(pkValueName(tv)))
    .map(tv => pkValueName(tv));
  const srcDefault = pkValueName((srcRaw || []).find(v => v.default)) || null;
  const tgtDefault = pkValueName((tgtRaw || []).find(v => v.default)) || null;
  const defaultChange = srcDefault !== tgtDefault ? { from: tgtDefault, to: srcDefault } : null;
  return { adds, labelChanges, activate, deactivate, extras, defaultChange };
}

// Per-record-type assignment diffs for THIS field, source → target (P5).
// RTs matched across orgs by DeveloperName. Pure — unit-testable.
// srcRts/tgtRts: [{ id, devName, values:Set }]. Returns [{ rtId, devName, adds, removes }].
function pkRtSyncDiff(srcRts, tgtRts) {
  const out = [];
  const srcBy = new Map((srcRts || []).map(r => [r.devName, r]));
  for (const trt of (tgtRts || [])) {
    const srt = srcBy.get(trt.devName);
    if (!srt) continue;   // RT doesn't exist in the source — leave it alone
    const adds    = [...srt.values].filter(v => !trt.values.has(v));
    const removes = [...trt.values].filter(v => !srt.values.has(v));
    if (adds.length || removes.length) out.push({ rtId: trt.id, devName: trt.devName, adds, removes });
  }
  return out;
}

// ── View state ──────────────────────────────────────────────────
let _pkOrgUrl   = '';
let _pkObj      = '';
let _pkField    = '';
let _pkObjCache = {};     // orgKey → [{name, label}]
let _pkInv      = null;   // loaded inventory (null = nothing loaded)
let _pkMode     = 'compare';  // 'single' | 'compare' — compare is the DEFAULT
                              // (user 2026-07-18: multi-org matrix is the main
                              // flow; ring orgs pre-seed its checkboxes)
let _pkCmpOrgs  = [];     // selected org URLs for compare mode (P2)
let _pkCmpObj   = '';
let _pkCmpField = '';
let _pkMatrix   = null;   // last built matrix { obj, field, results, union, matrix } (P2)
let _pkStd      = null;   // loaded standard value set editor state (P4a)
let _pkGvs      = null;   // loaded global value set editor state (P4b)
let _pkPendingRtCheck = null;   // { name, pre } — surface SF's RT auto-drop after deactivate (P3)

function renderPicklists() {
  const orgs = allMapOrgs();
  if (!_pkOrgUrl) _pkOrgUrl = _workingPair.src || _orgUrl || (orgs[0] && orgs[0].url) || '';

  setMain(`
    <div class="ds-view-header">
      <div class="ds-view-title-wrap">
        <h2 class="ds-view-title">🎚 Picklist Manager</h2>
        <div class="ds-view-subtitle">Values, record types, usage &amp; data fixes — per org or across orgs</div>
      </div>
      <div class="ds-pk-mode-toggle">
        <button class="ds-btn ds-btn-sm ${_pkMode === 'single' ? 'ds-btn-primary' : ''}" data-pk-mode="single">Single org</button>
        <button class="ds-btn ds-btn-sm ${_pkMode === 'compare' ? 'ds-btn-primary' : ''}" data-pk-mode="compare">Compare across orgs</button>
      </div>
    </div>
    <div id="dsPkConfig"></div>
    <div id="dsPkBody">
      <div class="ds-empty-page">
        <div class="ds-empty-icon">${window.sftkCatSvg ? window.sftkCatSvg('sleep', 64) : '🎚'}</div>
        <div class="ds-empty-title">${_pkMode === 'compare' ? 'Pick orgs, an object and a picklist field' : 'Pick an org, object and picklist field'}</div>
        <div class="ds-empty-sub">${_pkMode === 'compare'
          ? 'You\'ll get a value×org matrix (exists / active / usage / record-type assignments per org) and a bulk wizard that applies the same deactivate/delete + data fix to every selected org.'
          : 'You\'ll get every value with its live record count, record-type assignments, and safe deactivate / delete / remap operations.'}</div>
      </div>
    </div>`);

  document.querySelectorAll('[data-pk-mode]').forEach(b =>
    b.addEventListener('click', () => { _pkMode = b.dataset.pkMode; renderPicklists(); }));

  if (_pkMode === 'compare') _pkRenderCompareConfig();
  else _pkRenderSingleConfig();
}

// Single-org config bar (P1 behaviour, extracted so the mode toggle can swap it).
function _pkRenderSingleConfig() {
  const orgs = allMapOrgs();
  const orgOptions = orgs.map(o =>
    `<option value="${esc(o.url)}" ${_orgKey(o.url) === _orgKey(_pkOrgUrl) ? 'selected' : ''}>${esc(orgOptionLabel(o.url, o.label))}</option>`).join('');
  const cfg = eid('dsPkConfig');
  if (!cfg) return;
  cfg.innerHTML = `
    <div class="ds-pk-config">
      <select id="dsPkOrg" class="ds-select">${orgOptions || '<option value="">No orgs known</option>'}</select>
      <select id="dsPkObj" class="ds-select" ${_pkObj ? '' : 'disabled'}>
        <option value="">${_pkObj ? esc(_pkObj) : 'Object…'}</option>
      </select>
      <select id="dsPkField" class="ds-select" disabled><option value="">Field…</option></select>
      <button class="ds-btn ds-btn-primary" id="dsPkLoad" disabled>Load values</button>
    </div>`;

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

// Compare-mode config: org checkboxes + object/field (probed from the first
// selected org that's open) + "Load matrix" (P2).
function _pkRenderCompareConfig() {
  const orgs = allMapOrgs();
  // First visit: pre-select the Sync Ring (source of truth + targets) — the
  // multi-org matrix is exactly the ring's job (user directive 2026-07-17).
  if (!_pkCmpOrgs.length && typeof _ring === 'object' && (_ring?.orgs || []).length >= 2) {
    const known = new Set(orgs.map(o => _orgKey(o.url)));
    _pkCmpOrgs = _ring.orgs.filter(u => known.has(_orgKey(u)));
  }
  const chks = orgs.map(o =>
    `<label class="ds-pk-orgchk"><input type="checkbox" data-pk-cmporg="${esc(o.url)}" ${_pkCmpOrgs.includes(o.url) ? 'checked' : ''}> ${esc(orgOptionLabel(o.url, o.label))}</label>`).join('');
  const cfg = eid('dsPkConfig');
  if (!cfg) return;
  cfg.innerHTML = `
    <div class="ds-pk-cmp-config">
      <div class="ds-pk-cmp-orgs">
        <div class="ds-pk-cmp-lbl">Orgs to compare</div>
        <div class="ds-pk-orgchk-list">${chks || 'No orgs known'}</div>
      </div>
      <div class="ds-pk-config">
        <select id="dsPkCmpObj" class="ds-select" ${_pkCmpObj ? '' : 'disabled'}>
          <option value="">${_pkCmpObj ? esc(_pkCmpObj) : 'Object…'}</option>
        </select>
        <select id="dsPkCmpField" class="ds-select" disabled><option value="">Field…</option></select>
        <button class="ds-btn ds-btn-primary" id="dsPkCmpLoad" disabled>Load matrix</button>
      </div>
    </div>`;

  cfg.querySelectorAll('[data-pk-cmporg]').forEach(c => c.addEventListener('change', () => {
    const url = c.dataset.pkCmporg;
    if (c.checked) { if (!_pkCmpOrgs.includes(url)) _pkCmpOrgs.push(url); }
    else _pkCmpOrgs = _pkCmpOrgs.filter(u => u !== url);
    _pkCmpLoadObjects();
  }));
  eid('dsPkCmpObj')?.addEventListener('change', async e => { _pkCmpObj = e.target.value; _pkCmpField = ''; await _pkCmpLoadFields(); });
  eid('dsPkCmpField')?.addEventListener('change', e => { _pkCmpField = e.target.value; const b = eid('dsPkCmpLoad'); if (b) b.disabled = !_pkCmpField; });
  eid('dsPkCmpLoad')?.addEventListener('click', () => _pkLoadMatrix());

  if (_pkCmpOrgs.length) _pkCmpLoadObjects();
}

// First selected compare org that is open in a tab (its describe seeds the
// object/field pickers; the chosen field name is applied to every org).
async function _pkCmpProbeSession() {
  for (const url of _pkCmpOrgs) {
    const s = await getOrgSession(url);
    if (s) return s;
  }
  return null;
}

async function _pkCmpLoadObjects() {
  const sel = eid('dsPkCmpObj');
  if (!sel) return;
  if (!_pkCmpOrgs.length) { sel.disabled = true; sel.innerHTML = '<option value="">Select orgs first…</option>'; return; }
  sel.disabled = true; sel.innerHTML = '<option value="">Loading objects…</option>';
  const sess = await _pkCmpProbeSession();
  if (!sess) { sel.innerHTML = '<option value="">No selected org is open in a tab</option>'; return; }
  const key = _orgKey(sess.orgUrl);
  if (!_pkObjCache[key]) {
    const res = await sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
      path: 'services/data/v62.0/sobjects' });
    if (res.error) { sel.innerHTML = `<option value="">${esc(res.error).slice(0, 60)}</option>`; return; }
    _pkObjCache[key] = (res.sobjects || [])
      .filter(o => o.queryable && o.updateable && !o.customSetting && !/^(.*__(Tag|Share|History|Feed|ChangeEvent))$/.test(o.name))
      .map(o => ({ name: o.name, label: o.label }));
  }
  sel.innerHTML = '<option value="">Object…</option>' + _pkObjCache[key]
    .map(o => `<option value="${esc(o.name)}" ${o.name === _pkCmpObj ? 'selected' : ''}>${esc(o.label)} (${esc(o.name)})</option>`).join('');
  sel.disabled = false;
  if (_pkCmpObj) _pkCmpLoadFields();
}

async function _pkCmpLoadFields() {
  const sel = eid('dsPkCmpField');
  if (!sel || !_pkCmpObj) return;
  sel.disabled = true; sel.innerHTML = '<option value="">Loading fields…</option>';
  const sess = await _pkCmpProbeSession();
  if (!sess) { sel.innerHTML = '<option value="">No selected org open</option>'; return; }
  const desc = await describe(_pkCmpObj, sess.orgUrl, sess.sid);
  const picks = (desc?.fields || []).filter(f => f.type === 'picklist' || f.type === 'multipicklist');
  if (!picks.length) { sel.innerHTML = '<option value="">No picklist fields on this object</option>'; return; }
  sel.innerHTML = '<option value="">Field…</option>' + picks
    .map(f => `<option value="${esc(f.name)}" ${f.name === _pkCmpField ? 'selected' : ''}>${esc(f.label)} (${esc(f.name)})${f.type === 'multipicklist' ? ' — multi' : ''}</option>`).join('');
  sel.disabled = false;
  const b = eid('dsPkCmpLoad'); if (b) b.disabled = !_pkCmpField;
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
// Load usage counts for a value set on a field (shared by single + matrix + P4).
// Single picklist: one GROUP BY. Multipicklist: one INCLUDES count per value (capped).
async function _pkLoadUsage(sess, obj, field, isMulti, rawValues) {
  const usage = new Map();
  let usageNote = '', nullCount = 0, totalCount = 0;
  if (!isMulti) {
    const agg = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false,
      query: `SELECT ${field} pv, COUNT(Id) cnt FROM ${obj} GROUP BY ${field}` });
    if (agg.error) { usageNote = `Usage counts unavailable: ${agg.error}`; }
    else for (const r of (agg.records || [])) {
      const v = r.pv ?? r[field];
      const c = r.cnt ?? r.expr0 ?? 0;
      totalCount += c;
      if (v == null) nullCount = c; else usage.set(String(v), c);
    }
    if ((agg.records || []).length >= 2000) usageNote = 'Object has >2000 distinct values — counts may be partial.';
  } else {
    const CAP = 30;
    for (const v of rawValues.slice(0, CAP)) {
      const name = pkValueName(v);
      const r = await sendBg({ type: 'SF_REST_QUERY', orgUrl: sess.orgUrl, sid: sess.sid,
        query: `SELECT COUNT() FROM ${obj} WHERE ${field} INCLUDES (${soqlStrLit(name)})` });
      usage.set(name, r.error ? -1 : (r.totalSize ?? 0));
    }
    if (rawValues.length > CAP) usageNote = `Counted the first ${CAP} of ${rawValues.length} values (multi-select counts are one query each).`;
  }
  return { usage, usageNote, nullCount, totalCount };
}

// Load record types + this field's per-RT value assignments (cap the fetches).
async function _pkLoadRecordTypes(sess, obj, field, devName) {
  let rts = [], rtNote = '';
  const rtRes = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false,
    query: `SELECT Id, Name, DeveloperName, IsActive FROM RecordType WHERE SObjectType = ${soqlStrLit(obj)}` });
  const rtRows = (rtRes.records || []).filter(r => r.IsActive);
  const RT_CAP = 8;
  for (const rt of rtRows.slice(0, RT_CAP)) {
    const meta = await sendBg({ type: 'SF_TOOLING_GET', orgUrl: sess.orgUrl, sid: sess.sid,
      sobject: 'RecordType', id: rt.Id });
    const plEntry = (meta?.Metadata?.picklistValues || []).find(p =>
      p.picklist === field || p.picklist === devName);
    rts.push({ id: rt.Id, name: rt.Name, devName: rt.DeveloperName, values: new Set((plEntry?.values || []).map(v => pkValueName(v))) });
  }
  if (rtRows.length > RT_CAP) rtNote = `Showing ${RT_CAP} of ${rtRows.length} record types.`;
  return { rts, rtNote };
}

// Fetch a field's full picklist inventory for one org session. Returns:
//   { kind:'local',  inv }                            — editable custom local value set
//   { kind:'standard', field, obj, isMulti }          — standard picklist (P4a)
//   { kind:'global', field, obj, isMulti, fieldId, metadata, name } — global value set (P4b)
// Throws on hard errors. No DOM — reused by single load AND the multi-org matrix.
async function _pkFetchInventory(sess, obj, field) {
  const desc = await describe(obj, sess.orgUrl, sess.sid);
  const fieldMeta = (desc?.fields || []).find(f => f.name === field);
  if (!fieldMeta) throw new Error(`${field} not found on ${obj}`);
  const isMulti = fieldMeta.type === 'multipicklist';

  // Standard picklists have no Tooling CustomField — route to the StandardValueSet path.
  if (!/__c$/i.test(field)) return { kind: 'standard', field, obj, isMulti };

  // Tooling: resolve the CustomField id, then fetch full Metadata (the only
  // way to see INACTIVE values — describe returns active ones only).
  const devName = field.replace(/__c$/i, '');
  const idRes = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true,
    query: `SELECT Id, TableEnumOrId FROM CustomField WHERE DeveloperName = ${soqlStrLit(devName)}` });
  if (idRes.error) throw new Error(idRes.error);
  let rows = idRes.records || [];
  if (rows.length > 1) {
    const ent = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true,
      query: `SELECT DurableId FROM EntityDefinition WHERE QualifiedApiName = ${soqlStrLit(obj)}` });
    const durable = (ent.records || [])[0]?.DurableId;
    rows = rows.filter(r => r.TableEnumOrId === obj || (durable && r.TableEnumOrId === durable));
  }
  const fieldId = rows[0]?.Id;
  if (!fieldId) throw new Error('Could not locate this field in the Tooling API (Customize Application permission needed).');

  const cf = await sendBg({ type: 'SF_TOOLING_GET', orgUrl: sess.orgUrl, sid: sess.sid,
    sobject: 'CustomField', id: fieldId });
  if (cf.error || !cf.Metadata) throw new Error(cf.error || 'Field metadata unavailable');

  if (cf.Metadata.valueSet?.valueSetName) {
    return { kind: 'global', field, obj, isMulti, fieldId, metadata: cf.Metadata, name: cf.Metadata.valueSet.valueSetName };
  }
  const rawValues = cf.Metadata.valueSet?.valueSetDefinition?.value || [];
  if (!rawValues.length) throw new Error('No values found in this field\'s value set.');

  const { usage, usageNote, nullCount, totalCount } = await _pkLoadUsage(sess, obj, field, isMulti, rawValues);
  const { rts, rtNote } = await _pkLoadRecordTypes(sess, obj, field, devName);

  const inv = {
    orgUrl: sess.orgUrl, sid: sess.sid, obj, field, devName, fieldId, isMulti,
    metadata: cf.Metadata, rawValues, usage, usageNote, nullCount, totalCount, rts, rtNote,
  };
  return { kind: 'local', inv };
}

async function loadPicklistInventory() {
  const body = eid('dsPkBody');
  if (!body || !_pkOrgUrl || !_pkObj || !_pkField) return;
  body.innerHTML = `<div class="ds-init-loading">${window.sftkCat ? sftkCat('Reading values, usage & record types…') : 'Loading…'}</div>`;

  const sess = await getOrgSession(_pkOrgUrl);
  if (!sess) { body.innerHTML = `<div class="ds-seq-empty">Org isn't open in a Chrome tab — open it, then reload.</div>`; return; }

  try {
    const r = await _pkFetchInventory(sess, _pkObj, _pkField);
    if (r.kind === 'standard') return _pkLoadStandard(sess, r.field, r.obj, r.isMulti);
    if (r.kind === 'global')   return _pkLoadGlobal(sess, r);
    _pkInv = r.inv;
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
    </div>
    ${_pkRtMatrixHtml(inv)}`;

  body.querySelectorAll('[data-pk-fix]').forEach(b =>
    b.addEventListener('click', () => _pkOpenWizard(parseInt(b.dataset.pkFix, 10), 'fix')));
  body.querySelectorAll('[data-pk-toggle]').forEach(b =>
    b.addEventListener('click', () => _pkOpenWizard(parseInt(b.dataset.pkToggle, 10), 'toggle')));
  body.querySelectorAll('[data-pk-del]').forEach(b =>
    b.addEventListener('click', () => _pkOpenWizard(parseInt(b.dataset.pkDel, 10), 'delete')));
  _pkWireRtMatrix(inv, body);

  // Surface Salesforce's automatic RT drop after a just-applied deactivate (P3).
  if (_pkPendingRtCheck) {
    const { name, pre } = _pkPendingRtCheck;
    _pkPendingRtCheck = null;
    const post = inv.rts.filter(rt => rt.values.has(name)).length;
    if (pre > post) showToast(`ℹ Salesforce removed “${name}” from ${pre - post} record type(s) on deactivation`, 'info', 6000);
  }
}

// ── Record-type assignment matrix (editable — P3) ───────────────
// A value×RT grid of checkboxes; ticking adds / unticking removes the value
// from that record type via a RecordType Tooling Metadata PATCH.
function _pkRtMatrixHtml(inv) {
  if (!inv.rts || !inv.rts.length) return '';
  const activeVals = inv.rawValues.filter(v => v.isActive !== false).map(v => pkValueName(v));
  if (!activeVals.length) return '';
  const head = `<div class="ds-pk-rtm-row ds-pk-rtm-head">
      <div class="ds-pk-rtm-val">Value</div>
      ${inv.rts.map(rt => `<div class="ds-pk-rtm-col" title="${esc(rt.name)}">${esc(rt.name)}</div>`).join('')}
    </div>`;
  const rows = activeVals.map(name => `
    <div class="ds-pk-rtm-row">
      <div class="ds-pk-rtm-val">${esc(name)}</div>
      ${inv.rts.map(rt => `<div class="ds-pk-rtm-col">
        <input type="checkbox" class="ds-pk-rtm-chk" data-rt="${esc(rt.id)}" data-val="${esc(name)}" ${rt.values.has(name) ? 'checked' : ''}>
      </div>`).join('')}
    </div>`).join('');
  return `
    <div class="ds-pk-rtmatrix">
      <div class="ds-pk-rtm-title">🧩 Record-type assignments <span class="ds-pk-note-inline">tick to add · untick to remove · then Apply</span></div>
      <div class="ds-pk-rtm-grid">${head}${rows}</div>
      <div class="ds-pk-rtm-actions">
        <button class="ds-btn ds-btn-sm ds-btn-primary" id="dsPkRtApply" disabled>Apply record-type changes</button>
        <span class="ds-pk-rtm-dirty" id="dsPkRtDirty"></span>
      </div>
    </div>`;
}

function _pkReadRtMatrix(scope) {
  const edited = new Map();
  scope.querySelectorAll('.ds-pk-rtm-chk').forEach(c =>
    edited.set(`${c.dataset.rt}|${c.dataset.val}`, c.checked));
  return edited;
}

function _pkWireRtMatrix(inv, body) {
  const applyBtn = eid('dsPkRtApply');
  const dirtyEl = eid('dsPkRtDirty');
  if (!applyBtn) return;
  const refresh = () => {
    const diffs = pkRtMatrixDiff(inv.rts, _pkReadRtMatrix(body));
    const n = diffs.reduce((s, d) => s + d.adds.length + d.removes.length, 0);
    applyBtn.disabled = n === 0;
    if (dirtyEl) dirtyEl.textContent = n ? `${n} pending change(s) across ${diffs.length} record type(s)` : '';
  };
  body.querySelectorAll('.ds-pk-rtm-chk').forEach(c => c.addEventListener('change', refresh));
  applyBtn.addEventListener('click', () => {
    const diffs = pkRtMatrixDiff(inv.rts, _pkReadRtMatrix(body));
    if (diffs.length) _pkApplyRt(inv, diffs);
  });
}

// Apply RT assignment diffs — one RecordType Metadata PATCH per changed RT.
async function _pkApplyRt(inv, diffs) {
  if (cachedOrgType(inv.orgUrl) === 'production') {
    const ok = await confirmTypedProd(orgLabel(inv.orgUrl),
      `edit record-type picklist assignments on ${inv.obj}.${inv.field}`);
    if (!ok) return;
  }
  let ok = 0, fail = 0;
  const errs = [];
  for (const d of diffs) {
    try { await _pkApplyRtCore(inv, d.rtId, d.adds, d.removes); ok++; }
    catch (e) { fail++; if (errs.length < 5) errs.push(e.message); }
  }
  showToast(fail === 0
    ? `✅ Updated ${ok} record type(s)`
    : `⚠ ${ok} updated, ${fail} failed${errs.length ? ' — ' + errs[0] : ''}`, fail ? 'warning' : 'success', 6000);
  loadPicklistInventory();
}

// Add/remove a field's values on one record type via its Tooling Metadata.
async function _pkApplyRtCore(inv, rtId, adds, removes) {
  const meta = await sendBg({ type: 'SF_TOOLING_GET', orgUrl: inv.orgUrl, sid: inv.sid, sobject: 'RecordType', id: rtId });
  if (meta?.error || !meta?.Metadata) throw new Error(meta?.error || 'RecordType metadata unavailable');
  const md = JSON.parse(JSON.stringify(meta.Metadata));
  md.picklistValues = md.picklistValues || [];
  let entry = md.picklistValues.find(p => p.picklist === inv.field || p.picklist === inv.devName);
  if (!entry) { entry = { picklist: inv.field, values: [] }; md.picklistValues.push(entry); }
  entry.values = entry.values || [];
  const remSet = new Set(removes);
  entry.values = entry.values.filter(v => !remSet.has(pkValueName(v)));
  const present = new Set(entry.values.map(v => pkValueName(v)));
  for (const a of adds) if (!present.has(a)) entry.values.push({ valueName: a });
  const res = await sendBg({ type: 'SF_PATCH', orgUrl: inv.orgUrl, sid: inv.sid,
    path: `services/data/v62.0/tooling/sobjects/RecordType/${rtId}`, body: { Metadata: md } });
  if (res?.error) throw new Error(res.error);
  return true;
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

function _pkImpactHtml(impact, recordCount, literal) {
  const row = (icon, label, list) => list === null
    ? `<div class="ds-pk-imp-row">${icon} ${label}: <em>couldn't check</em></div>`
    : `<div class="ds-pk-imp-row${list.length ? ' ds-pk-imp-hit' : ''}">${icon} ${label}: <strong>${list.length}</strong>${list.length ? ` — ${esc(list.slice(0, 4).join(', '))}${list.length > 4 ? '…' : ''}` : ''}</div>`;
  const litRow = literal
    ? `<div class="ds-pk-imp-row${literal.mentions ? ' ds-pk-imp-hit' : ''}">🔎 Automations mentioning this value <em>by name</em>: <strong>${literal.mentions}</strong>${literal.hits.length ? ` — ${esc(literal.hits.slice(0, 4).join(', '))}${literal.hits.length > 4 ? '…' : ''}` : ''}</div>`
    : '';
  return `
    <div class="ds-pk-impact">
      <div class="ds-pk-imp-title">⚡ Updating ${recordCount.toLocaleString()} record(s) will run the object's automation:</div>
      ${row('⚡', 'Active triggers', impact.triggers)}
      ${row('🌊', 'Record-triggered flows', impact.flows)}
      ${row('✅', 'Validation rules', impact.validationRules)}
      ${row('⚙️', 'Workflow rules', impact.workflowRules)}
      ${litRow}
      <div class="ds-pk-imp-hint">💡 Validation rules can reject rows (they'll show as row errors);
      triggers and flows WILL fire — schedule big fixes for quiet hours. Automations that name the
      value literally may need editing too (they won't auto-update).</div>
    </div>`;
}

// Supplemental "N automations mention this value by name" scan (P2). Greps the
// serialized Metadata of active validation rules + record-triggered flows on the
// object for the literal value string. Degrades silently (returns 0 hits) if a
// sub-query is unavailable. Returns { mentions, hits:[label] }.
async function _pkValueLiteralScan(ctx, valueName) {
  const lit = soqlStrLit(ctx.obj);
  let mentions = 0;
  const hits = [];
  const vr = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: ctx.orgUrl, sid: ctx.sid, tooling: true,
    query: `SELECT ValidationName, Metadata FROM ValidationRule WHERE Active = true AND EntityDefinition.QualifiedApiName = ${lit}`, _silentError: true });
  if (vr && !vr.error) for (const r of (vr.records || [])) {
    if (pkValueMentions(JSON.stringify(r.Metadata || {}), valueName) > 0) { mentions++; hits.push('VR: ' + r.ValidationName); }
  }
  const fdv = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: ctx.orgUrl, sid: ctx.sid, tooling: false,
    query: `SELECT ApiName, Label FROM FlowDefinitionView WHERE IsActive = true AND TriggerObjectOrEventApiName = ${lit}`, _silentError: true });
  const flowRows = (fdv && !fdv.error) ? (fdv.records || []).slice(0, 15) : [];
  for (const f of flowRows) {
    const fq = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: ctx.orgUrl, sid: ctx.sid, tooling: true,
      query: `SELECT Metadata FROM Flow WHERE Status = 'Active' AND Definition.DeveloperName = ${soqlStrLit(f.ApiName)}`, _silentError: true });
    if (fq && !fq.error) for (const fr of (fq.records || [])) {
      if (pkValueMentions(JSON.stringify(fr.Metadata || {}), valueName) > 0) { mentions++; hits.push('Flow: ' + (f.Label || f.ApiName)); break; }
    }
  }
  return { mentions, hits };
}

// One-line impact summary for the bulk per-org panel (P2).
function _pkImpactSummaryLine(imp) {
  const n = x => x === null ? '?' : x.length;
  return `${n(imp.triggers)} trigger(s), ${n(imp.flows)} flow(s), ${n(imp.validationRules)} VR(s)`;
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
  const literal = needsFix ? await _pkValueLiteralScan(inv, name) : null;

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
        ${_pkImpactHtml(impact, count, literal)}
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
// Core: fetch + remap/clear records in 200-batches. No DOM / history / toast —
// reused by the single-org runner AND the multi-org bulk apply (P2).
// Returns { updated, failed, errors }.
async function _pkDataFixCore(ctx, value, fixMode, target, onProgress) {
  let updated = 0, failed = 0;
  const errors = [];
  const lit = soqlStrLit(value);
  const q = ctx.isMulti
    ? `SELECT Id, ${ctx.field} FROM ${ctx.obj} WHERE ${ctx.field} INCLUDES (${lit})`
    : `SELECT Id FROM ${ctx.obj} WHERE ${ctx.field} = ${lit}`;
  const res = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: ctx.orgUrl, sid: ctx.sid, tooling: false, query: q });
  if (res.error) throw new Error(res.error);
  const recs = res.records || [];
  for (let i = 0; i < recs.length; i += 200) {
    const chunk = recs.slice(i, i + 200).map(r => ({
      attributes: { type: ctx.obj }, Id: r.Id,
      [ctx.field]: ctx.isMulti
        ? (pkMultiRemap(r[ctx.field], value, fixMode === 'remap' ? target : null) || null)
        : (fixMode === 'remap' ? target : null),
    }));
    const out = await sendBg({ type: 'SF_COLLECTIONS_UPDATE', orgUrl: ctx.orgUrl, sid: ctx.sid, records: chunk });
    if (out?.error) throw new Error(out.error);
    (Array.isArray(out) ? out : []).forEach(r => {
      if (r.success) updated++;
      else { failed++; if (errors.length < 20) errors.push((r.errors || []).map(e => e.message).join('; ')); }
    });
    onProgress?.(Math.min(i + 200, recs.length), recs.length, failed);
  }
  return { updated, failed, errors };
}

// Single-org data fix — wraps the core with progress DOM, a history entry and a
// toast (P1 behaviour). ctx defaults to _pkInv; P4 editors pass their own ctx.
async function _pkRunDataFix(value, fixMode, target, ctx = _pkInv) {
  const body = eid('dsPkBody');
  const prog = document.createElement('div');
  prog.className = 'ds-pk-progress';
  prog.innerHTML = window.sftkCatSm ? sftkCatSm('Fetching records…') : 'Fetching records…';
  body?.prepend(prog);
  const startedAt = new Date().toISOString();
  try {
    const { updated, failed, errors } = await _pkDataFixCore(ctx, value, fixMode, target,
      (done, total, f) => { prog.innerHTML = window.sftkCatSm
        ? sftkCatSm(`Fixing… ${done} / ${total} (${f} failed)`)
        : `Fixing… ${done} / ${total}`; });
    _history.push({
      id: genId('run'), kind: 'picklist-fix',
      profileName: `Picklist fix: ${ctx.obj}.${ctx.field} “${value}” → ${fixMode === 'remap' ? `“${target}”` : 'cleared'}`,
      startedAt, completedAt: new Date().toISOString(),
      status: failed === 0 ? 'success' : (updated > 0 ? 'partial' : 'failed'),
      sourceOrg: ctx.orgUrl, targetOrg: ctx.orgUrl,
      summary: { [ctx.obj]: { created: 0, failed, updated } },
      errors: pkDedupeErrors(errors),
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
// Core: mutate a CLONE of the field's value set + PATCH. No toast / reload —
// reused by single-org apply AND bulk apply (P2). Throws on failure.
async function _pkApplyMetadataCore(inv, idx, op) {
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
  return true;
}

async function _pkApplyMetadata(idx, op) {
  const inv = _pkInv;
  try {
    // Capture RT assignments holding this value so we can report SF's auto-drop (P3).
    if (op.deactivate) {
      const nm = pkValueName(inv.rawValues[idx]);
      _pkPendingRtCheck = { name: nm, pre: inv.rts.filter(rt => rt.values.has(nm)).length };
    }
    await _pkApplyMetadataCore(inv, idx, op);
    showToast(op.remove ? '🗑 Value deleted from the value set'
      : op.activate ? '▶ Value activated' : '⏸ Value deactivated', 'success');
    loadPicklistInventory();
  } catch (e) {
    _pkPendingRtCheck = null;
    const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(e.message) : { message: e.message };
    showToast(`❌ Metadata update failed: ${fe.message}`, 'error', 8000);
  }
}

// ════════════════════════════════════════════════════════════════
// P2 — MULTI-ORG MATRIX + BULK APPLY
// ════════════════════════════════════════════════════════════════

// Load one field's value inventory across every selected org (in parallel,
// skipping orgs with no live session), then build + render the value×org matrix.
async function _pkLoadMatrix() {
  const body = eid('dsPkBody');
  if (!body || !_pkCmpObj || !_pkCmpField || !_pkCmpOrgs.length) return;
  body.innerHTML = `<div class="ds-init-loading">${window.sftkCat ? sftkCat('Loading values across orgs…') : 'Loading…'}</div>`;

  const results = await Promise.all(_pkCmpOrgs.map(async url => {
    const orgKey = _orgKey(url);
    const label = orgLabel(url);
    const sess = await getOrgSession(url);
    if (!sess) return { orgUrl: url, orgKey, label, skip: 'not open in a tab' };
    try {
      const r = await _pkFetchInventory(sess, _pkCmpObj, _pkCmpField);
      if (r.kind !== 'local') return { orgUrl: url, orgKey, label, skip: r.kind === 'standard' ? 'standard picklist' : 'global value set' };
      // Record types per org (user 2026-07-18: the matrix showed no RT info).
      // A failed RT load degrades to a note — never kills the value matrix.
      let rts = [], rtNote = '';
      try {
        const rt = await _pkLoadRecordTypes(sess, _pkCmpObj, _pkCmpField, _pkCmpField.replace(/__c$/i, ''));
        rts = rt.rts; rtNote = rt.rtNote;
      } catch (e2) { rtNote = `record types unavailable: ${e2.message}`; }
      return { orgUrl: url, orgKey, label, inv: r.inv, rts, rtNote };
    } catch (e) {
      const msg = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(e.message).message : e.message;
      return { orgUrl: url, orgKey, label, skip: msg };
    }
  }));

  const perOrg = results.filter(r => r.inv).map(r => ({ orgKey: r.orgKey, values: r.inv.rawValues.map(v => pkValueName(v)) }));
  const union = pkValueUnion(perOrg);
  _pkMatrix = { obj: _pkCmpObj, field: _pkCmpField, results, union, matrix: pkBuildMatrix(results, union) };
  _pkRenderMatrix();
}

function _pkRenderMatrix() {
  const body = eid('dsPkBody');
  const M = _pkMatrix;
  if (!body || !M) return;
  const cols = M.results;

  const head = `<div class="ds-pk-mx-row ds-pk-mx-head">
      <div class="ds-pk-mx-sel"><input type="checkbox" id="dsPkMxAll" title="Select all values"></div>
      <div class="ds-pk-mx-val">Value</div>
      ${cols.map(c => `<div class="ds-pk-mx-col">
        <label class="ds-pk-mx-orgsel"><input type="checkbox" class="ds-pk-mx-orgchk" data-org="${esc(c.orgUrl)}" ${c.inv ? 'checked' : 'disabled'}> ${esc(c.label)}</label>
        ${(typeof _ring === 'object' && _ring?.sourceUrl && (_ring.orgs || []).length >= 2 && _orgKey(c.orgUrl) === _orgKey(_ring.sourceUrl))
          ? `<span class="ds-pk-mx-sot" title="Your Sync Ring's source of truth — 🔄 Sync from source pre-selects this org as the source.">👑 source of truth</span>` : ''}
        ${c.skip ? `<span class="ds-pk-mx-skip" title="${esc(c.skip)}">skipped: ${esc(c.skip)}</span>` : prodBadge(c.orgUrl)}
      </div>`).join('')}
    </div>`;

  const rows = M.matrix.rows.map(row => {
    // Record-type assignment per cell + cross-org drift for this value
    // (user 2026-07-18: "i dont see any mention to record types").
    const rtDrift = pkRtDrift(cols.filter(c => c.rts?.length).map(c => c.rts), row.name);
    const cells = row.cells.map((cell, ci) => {
      if (cell.missing) return `<div class="ds-pk-mx-cell ds-pk-mx-na" title="org skipped / not loaded">·</div>`;
      if (!cell.exists) return `<div class="ds-pk-mx-cell ds-pk-mx-absent" title="value not present in this org">—</div>`;
      const cnt = cell.count == null ? '' : cell.count === -1 ? '?' : cell.count.toLocaleString();
      const rti = cols[ci]?.rts?.length ? pkRtCellInfo(cols[ci].rts, row.name) : null;
      const rtBadge = rti ? `<span class="ds-pk-mx-rt ${rtDrift ? 'ds-pk-mx-rt-drift' : ''}"
        title="${rti.inCount ? `In record type(s): ${esc(rti.names.join(', '))}` : 'Not included in any active record type here'}${rtDrift ? ' · ⚠ this value’s record-type assignment DIFFERS across orgs (same-name record types disagree) — align via 🔄 Sync from source' : ''}">${rti.inCount}/${rti.total} RT</span>` : '';
      return `<div class="ds-pk-mx-cell ${cell.active ? 'ds-pk-mx-active' : 'ds-pk-mx-inactive'}"
        title="${cell.active ? 'active' : 'inactive'}${cell.count != null && cell.count >= 0 ? ` · ${cell.count} record(s)` : ''}">
        ${cell.active ? '✓' : '⏸'}${cnt ? `<span class="ds-pk-mx-cnt">${cnt}</span>` : ''}${rtBadge}</div>`;
    }).join('');
    return `<div class="ds-pk-mx-row">
      <div class="ds-pk-mx-sel"><input type="checkbox" class="ds-pk-mx-valchk" data-val="${esc(row.name)}"></div>
      <div class="ds-pk-mx-val">${esc(row.name)}</div>${cells}</div>`;
  }).join('');

  const skipped = cols.filter(c => c.skip);
  const loaded = cols.filter(c => c.inv);
  body.innerHTML = `
    <div class="ds-pk-summary">Matrix · <strong>${esc(M.obj)}.${esc(M.field)}</strong> · ${M.union.length} value(s) across ${loaded.length}/${cols.length} loaded org(s)</div>
    <div class="ds-pk-note" style="margin:4px 0 6px">How to read a cell: <strong>✓</strong> value exists &amp; is active in that org · <strong>⏸</strong> exists but inactive · <strong>—</strong> value missing from that org · the <strong>number</strong> = how many records in that org currently hold the value · <strong>a/b RT</strong> = included in a of that org's b active record types (hover for names; <span style="color:#991b1b">red</span> = same-name record types disagree across orgs — align via 🔄 Sync from source).</div>
    ${cols.some(c => c.rtNote) ? `<div class="ds-pk-note">⚠ Record types: ${esc(cols.filter(c => c.rtNote).map(c => `${c.label} — ${c.rtNote}`).join(' · '))}</div>` : ''}
    ${skipped.length ? `<div class="ds-pk-note">⚠ Skipped ${skipped.length} org(s): ${esc(skipped.map(c => `${c.label} (${c.skip})`).join(', '))}</div>` : ''}
    <div class="ds-pk-matrix">${head}${rows || '<div class="ds-pk-note">No values loaded.</div>'}</div>
    <div class="ds-pk-bulkbar">
      <span class="ds-pk-bulk-lbl">With selected value(s) in the checked org(s):</span>
      <button class="ds-btn ds-btn-sm" id="dsPkBulkDeact">⏸ Deactivate…</button>
      <button class="ds-btn ds-btn-sm ds-btn-danger" id="dsPkBulkDel">🗑 Delete…</button>
      <span style="flex:1"></span>
      <button class="ds-btn ds-btn-sm ds-btn-primary" id="dsPkSyncBtn"
        title="Make the other orgs' value sets match a source org: add missing values, align labels/active states/default, and align record-type assignments — you pick the operations per org">🔄 Sync from source…</button>
    </div>
    <div id="dsPkBulkResult"></div>`;

  eid('dsPkMxAll')?.addEventListener('change', e =>
    body.querySelectorAll('.ds-pk-mx-valchk').forEach(c => { c.checked = e.target.checked; }));
  eid('dsPkBulkDeact')?.addEventListener('click', () => _pkOpenBulkWizard('toggle'));
  eid('dsPkBulkDel')?.addEventListener('click', () => _pkOpenBulkWizard('delete'));
  eid('dsPkSyncBtn')?.addEventListener('click', () => _pkOpenSyncPlan());
}

function _pkMxSelectedValues() {
  return [...document.querySelectorAll('.ds-pk-mx-valchk:checked')].map(c => c.dataset.val);
}
function _pkMxSelectedOrgs() {
  const urls = new Set([...document.querySelectorAll('.ds-pk-mx-orgchk:checked')].map(c => c.dataset.org));
  return (_pkMatrix?.results || []).filter(r => r.inv && urls.has(r.orgUrl));
}

// Bulk wizard — one dialog applies the same deactivate/delete + data fix to every
// checked org, with a per-org automation-impact panel shown BEFORE applying.
async function _pkOpenBulkWizard(mode) {
  const values = _pkMxSelectedValues();
  const orgs = _pkMxSelectedOrgs();
  if (!values.length) return showToast('Tick at least one value (row checkbox).', 'warning');
  if (!orgs.length) return showToast('Tick at least one org column.', 'warning');
  const single = values.length === 1;

  showModal(`
    <div class="ds-modal-header">${mode === 'delete' ? '🗑' : '⏸'} Bulk ${mode === 'delete' ? 'delete' : 'deactivate'} — ${values.length} value(s) × ${orgs.length} org(s)</div>
    <div class="ds-modal-body">
      <p>Values: <strong>${esc(values.join(', '))}</strong></p>
      <p>Orgs: ${esc(orgs.map(o => o.label).join(', '))}</p>
      <div class="ds-pk-fixchoice">
        <label><input type="radio" name="dsPkBulkFix" value="clear" checked> Clear the value on affected records first (recommended)</label>
        ${single ? `<label><input type="radio" name="dsPkBulkFix" value="remap"> Move records to:
          <select id="dsPkBulkRemap" class="ds-select ds-select-sm"></select></label>` : ''}
        <label><input type="radio" name="dsPkBulkFix" value="skip"> Skip data fix${mode === 'delete' ? ' — leaves orphan text' : ''}</label>
      </div>
      ${!single ? '<div class="ds-pk-note-inline">Remap is available when a single value is selected; multi-value bulk offers clear or skip.</div>' : ''}
      <div id="dsPkBulkImpact" class="ds-pk-note">Computing automation impact per org…</div>
    </div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      <button class="ds-btn ${mode === 'delete' ? 'ds-btn-danger' : 'ds-btn-primary'}" id="dsPkBulkGo">${mode === 'delete' ? '🗑 Apply to all orgs' : '⏸ Apply to all orgs'}</button>
    </div>`);

  if (single) {
    const alt = new Set();
    for (const o of orgs) for (const v of o.inv.rawValues) {
      const n = pkValueName(v);
      if (n !== values[0] && v.isActive !== false) alt.add(n);
    }
    const sel = eid('dsPkBulkRemap');
    if (sel) sel.innerHTML = [...alt].map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
  }

  // Per-org impact + value-literal automation scan (before apply — required).
  (async () => {
    const parts = [];
    for (const o of orgs) {
      const imp = await _pkImpact(o.inv);
      const lit = await _pkValueLiteralScan(o.inv, values[0]);
      parts.push(`<div class="ds-pk-imp-org"><strong>${esc(o.label)}</strong>: ${_pkImpactSummaryLine(imp)}
        · ${lit.mentions} automation(s) mention “${esc(values[0])}” by name${lit.hits.length ? ` (${esc(lit.hits.slice(0, 3).join(', '))})` : ''}</div>`);
    }
    const box = eid('dsPkBulkImpact');
    if (box) box.innerHTML = `<div class="ds-pk-imp-title">⚡ Automation that will run / references ${single ? 'this value' : 'the first value'}:</div>${parts.join('')}`;
  })();

  eid('dsPkBulkGo')?.addEventListener('click', async () => {
    const fixMode = document.querySelector('input[name="dsPkBulkFix"]:checked')?.value || 'skip';
    const remap = fixMode === 'remap' ? eid('dsPkBulkRemap')?.value : null;
    closeModal();
    await _pkApplyBulk(values, orgs, mode, fixMode, remap);
  });
}

// Apply the bulk operation sequentially per org (so progress stays legible),
// writing ONE history entry per org and a per-org result log at the end.
async function _pkApplyBulk(values, orgs, mode, fixMode, remap) {
  const resBox = eid('dsPkBulkResult');
  if (resBox) resBox.innerHTML = `<div class="ds-pk-reslog"><div class="ds-pk-res-title">Applying…</div></div>`;
  const log = resBox?.querySelector('.ds-pk-reslog');
  const append = html => { if (log) { const d = document.createElement('div'); d.className = 'ds-pk-res-row'; d.innerHTML = html; log.appendChild(d); } };

  // Typed confirm once per production org (covers its whole batch).
  for (const o of orgs) {
    if (cachedOrgType(o.orgUrl) === 'production') {
      const ok = await confirmTypedProd(o.label, `bulk ${mode} ${values.length} picklist value(s) on ${_pkMatrix.obj}.${_pkMatrix.field}`);
      if (!ok) { append(`⏭ <strong>${esc(o.label)}</strong>: cancelled (production confirm declined)`); o._cancelled = true; }
    }
  }

  for (const o of orgs) {
    if (o._cancelled) continue;
    const sess = await getOrgSession(o.orgUrl);
    if (!sess) { append(`⏭ <strong>${esc(o.label)}</strong>: not open — skipped`); continue; }
    const inv = o.inv;
    inv.orgUrl = sess.orgUrl; inv.sid = sess.sid;   // refresh the SID for a long run
    const startedAt = new Date().toISOString();
    let updated = 0, failed = 0, metaOk = 0, metaFail = 0, skippedVals = 0;
    const errors = [];

    for (const val of values) {
      // rawValues === metadata value list (same array ref) — findIndex tracks splices.
      const idx = inv.rawValues.findIndex(v => pkValueName(v) === val);
      if (idx < 0) { skippedVals++; append(`· <strong>${esc(o.label)}</strong>: “${esc(val)}” not present — skipped`); continue; }
      const count = inv.usage.get(val) || 0;

      if (fixMode !== 'skip' && count > 0) {
        const hasRemap = fixMode === 'remap' && inv.rawValues.some(v => pkValueName(v) === remap && v.isActive !== false);
        const effMode = hasRemap ? 'remap' : 'clear';
        const target = hasRemap ? remap : null;
        try {
          const r = await _pkDataFixCore(inv, val, effMode, target, null);
          updated += r.updated; failed += r.failed; errors.push(...r.errors);
          if (fixMode === 'remap' && !hasRemap) append(`⚠ <strong>${esc(o.label)}</strong>: remap target “${esc(remap)}” absent here — cleared “${esc(val)}” instead`);
        } catch (e) {
          errors.push(e.message);
          append(`❌ <strong>${esc(o.label)}</strong>: data fix “${esc(val)}” failed — ${esc(e.message)}`);
          continue;   // leave metadata untouched for this value
        }
      }

      try {
        await _pkApplyMetadataCore(inv, idx, mode === 'delete' ? { remove: true } : { deactivate: true });
        metaOk++;
        // Keep the local value list in sync so later findIndex lookups stay valid.
        if (mode === 'delete') inv.metadata.valueSet.valueSetDefinition.value.splice(idx, 1);
        else inv.metadata.valueSet.valueSetDefinition.value[idx].isActive = false;
      } catch (e) {
        metaFail++; errors.push(e.message);
        append(`❌ <strong>${esc(o.label)}</strong>: metadata “${esc(val)}” failed — ${esc(e.message)}`);
      }
    }

    _history.push({
      id: genId('run'), kind: 'picklist-fix',
      profileName: `Picklist bulk ${mode}: ${_pkMatrix.obj}.${_pkMatrix.field} [${values.join(', ')}] (${fixMode})`,
      startedAt, completedAt: new Date().toISOString(),
      status: (failed === 0 && metaFail === 0) ? 'success' : ((updated > 0 || metaOk > 0) ? 'partial' : 'failed'),
      sourceOrg: o.orgUrl, targetOrg: o.orgUrl,
      summary: { [_pkMatrix.obj]: { created: 0, failed, updated } },
      errors: pkDedupeErrors(errors),
    });

    append(`${(failed === 0 && metaFail === 0) ? '✅' : '⚠'} <strong>${esc(o.label)}</strong>: ${updated} record(s) fixed, ${metaOk} value(s) ${mode === 'delete' ? 'deleted' : 'deactivated'}${failed ? `, ${failed} record failure(s)` : ''}${metaFail ? `, ${metaFail} metadata failure(s)` : ''}${skippedVals ? `, ${skippedVals} absent/skipped` : ''}`);
  }

  await storageSaveHistory();
  append(`<em>Done — one history entry written per org. Reload the matrix to see updated state.</em>`);
  showToast('Bulk apply finished — see the per-org log', 'info', 5000);
}

// ════════════════════════════════════════════════════════════════
// P4 — STANDARD + GLOBAL VALUE SETS
// ════════════════════════════════════════════════════════════════

// Generic value-set list renderer (P4) — a value table + fix/toggle/delete
// actions driven by a caller-supplied applyFn. ctx: { orgUrl, sid, obj, field,
// isMulti, rawValues, usage }. Reuses the P1 data-fix + impact flow.
function _pkRenderValueSet(ctx, opts) {
  const body = eid('dsPkBody');
  if (!body) return;
  const counts = [...ctx.usage.values()].filter(n => typeof n === 'number' && n >= 0);
  const maxCount = Math.max(1, ...counts);
  const rows = ctx.rawValues.map((v, i) => {
    const name = pkValueName(v);
    const active = v.isActive !== false;
    const count = ctx.usage.has(name) ? ctx.usage.get(name) : null;
    return `<div class="ds-pk-row${active ? '' : ' ds-pk-row-inactive'}">
      <div class="ds-pk-val"><span class="ds-pk-name">${esc(v.label || name)}</span>${v.label && v.label !== name ? `<code class="ds-pk-api">${esc(name)}</code>` : ''}${v.default ? '<span class="ds-pk-default">default</span>' : ''}${active ? '' : '<span class="ds-pk-inactive-badge">inactive</span>'}</div>
      <div class="ds-pk-usage">${count == null ? '<span class="ds-pk-uncounted">—</span>' : count === -1 ? '<span class="ds-pk-uncounted">?</span>' : `<span class="ds-pk-bar"><span class="ds-pk-fill" style="width:${Math.max(2, Math.round(count / maxCount * 100))}%"></span></span><span class="ds-pk-count">${count.toLocaleString()}</span>`}</div>
      <div class="ds-pk-actions">
        ${(count > 0) ? `<button class="ds-btn ds-btn-sm" data-vs-fix="${i}">🔧 Fix data…</button>` : ''}
        <button class="ds-btn ds-btn-sm" data-vs-toggle="${i}">${active ? '⏸ Deactivate' : '▶ Activate'}</button>
        ${opts.allowDelete ? `<button class="ds-btn ds-btn-sm ds-btn-danger" data-vs-del="${i}">🗑</button>` : ''}
      </div></div>`;
  }).join('');
  body.innerHTML = `${opts.banner || ''}
    <div class="ds-pk-summary">${esc(opts.title)} · ${ctx.rawValues.length} value(s) ${prodBadge(ctx.orgUrl)}</div>
    <div class="ds-pk-table">
      <div class="ds-pk-head"><div class="ds-pk-val">Value</div><div class="ds-pk-usage">Records</div><div class="ds-pk-actions"></div></div>
      ${rows}
    </div>`;
  body.querySelectorAll('[data-vs-fix]').forEach(b => b.addEventListener('click', () => _pkValueSetWizard(ctx, +b.dataset.vsFix, 'fix', opts.applyFn, opts.reloadFn)));
  body.querySelectorAll('[data-vs-toggle]').forEach(b => b.addEventListener('click', () => _pkValueSetWizard(ctx, +b.dataset.vsToggle, 'toggle', opts.applyFn, opts.reloadFn)));
  body.querySelectorAll('[data-vs-del]').forEach(b => b.addEventListener('click', () => _pkValueSetWizard(ctx, +b.dataset.vsDel, 'delete', opts.applyFn, opts.reloadFn)));
}

// Generic deactivate/activate/delete wizard for standard + global value sets (P4).
// Mirrors _pkOpenWizard's data-fix + impact + prod-confirm flow but writes via applyFn.
async function _pkValueSetWizard(ctx, idx, mode, applyFn, reloadFn) {
  const v = ctx.rawValues[idx];
  const name = pkValueName(v);
  const active = v.isActive !== false;
  const count = ctx.usage.get(name) || 0;

  if (mode === 'toggle' && !active) {
    try { await applyFn(idx, { activate: true }); showToast('▶ Value activated', 'success'); reloadFn(); }
    catch (e) { showToast(`❌ ${e.message}`, 'error', 7000); }
    return;
  }

  const others = ctx.rawValues.filter((o, i) => i !== idx && o.isActive !== false).map(o => pkValueName(o));
  const needsFix = count > 0;
  const fixRequired = mode === 'delete' && needsFix;
  const impact = needsFix ? await _pkImpact(ctx) : null;
  const literal = needsFix ? await _pkValueLiteralScan(ctx, name) : null;
  const title = mode === 'delete' ? `Delete value “${name}”` : mode === 'fix' ? `Fix data for “${name}”` : `Deactivate “${name}”`;

  showModal(`
    <div class="ds-modal-header">${mode === 'delete' ? '🗑' : mode === 'fix' ? '🔧' : '⏸'} ${esc(title)}</div>
    <div class="ds-modal-body">
      ${needsFix ? `
        <p><strong>${count.toLocaleString()}</strong> record(s) currently hold this value.</p>
        <div class="ds-pk-fixchoice">
          <label><input type="radio" name="dsVsFix" value="remap" ${others.length ? 'checked' : 'disabled'}> Move them to:
            <select id="dsVsRemap" class="ds-select ds-select-sm">${others.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select></label>
          <label><input type="radio" name="dsVsFix" value="clear" ${others.length ? '' : 'checked'}> Clear the value (${ctx.isMulti ? 'remove it from each record’s selection' : 'set the field blank'})</label>
          ${fixRequired ? '' : `<label><input type="radio" name="dsVsFix" value="skip"> Skip the data fix</label>`}
        </div>
        ${_pkImpactHtml(impact, count, literal)}
      ` : `<p>No records hold this value — this is a metadata-only change.</p>`}
      ${mode === 'delete' ? `<div class="ds-pk-delwarn">⛔ Deleting removes the value permanently. Prefer <strong>Deactivate</strong> unless you're sure.</div>` : ''}
    </div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      <button class="ds-btn ${mode === 'delete' ? 'ds-btn-danger' : 'ds-btn-primary'}" id="dsVsGo">${mode === 'delete' ? '🗑 Delete value' : mode === 'fix' ? '🔧 Run data fix' : '⏸ Deactivate'}</button>
    </div>`);

  eid('dsVsGo')?.addEventListener('click', async () => {
    const fixMode = needsFix ? (document.querySelector('input[name="dsVsFix"]:checked')?.value || 'skip') : 'skip';
    const target = fixMode === 'remap' ? eid('dsVsRemap')?.value : null;
    closeModal();
    if (cachedOrgType(ctx.orgUrl) === 'production') {
      const ok = await confirmTypedProd(orgLabel(ctx.orgUrl), `${mode} value "${name}" on ${ctx.obj}.${ctx.field}`);
      if (!ok) return;
    }
    if (fixMode !== 'skip' && count > 0) {
      const ok = await _pkRunDataFix(name, fixMode, target, ctx);
      if (!ok) return;   // fix failed/partial — leave metadata untouched
    }
    if (mode === 'fix') { reloadFn(); return; }
    try {
      await applyFn(idx, mode === 'delete' ? { remove: true } : { deactivate: true });
      showToast(mode === 'delete' ? '🗑 Value deleted' : '⏸ Value deactivated', 'success');
    } catch (e) {
      const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(e.message) : { message: e.message };
      showToast(`❌ Metadata update failed: ${fe.message}`, 'error', 8000);
    }
    reloadFn();
  });
}

// ── P4a: Standard picklists (StandardValueSet) ──────────────────
async function _pkLoadStandard(sess, field, obj, isMulti) {
  const body = eid('dsPkBody');
  if (!body) return;
  body.innerHTML = `<div class="ds-init-loading">${window.sftkCat ? sftkCat('Loading standard value set…') : 'Loading…'}</div>`;
  try {
    // Best-effort: the StandardValueSet DeveloperName usually equals the field name.
    const q = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true,
      query: `SELECT Id, MasterLabel, DeveloperName FROM StandardValueSet WHERE DeveloperName = ${soqlStrLit(field)}`, _silentError: true });
    const rec = (q && !q.error) ? (q.records || [])[0] : null;
    if (!rec) return _pkStandardDegrade(sess, field, obj, 'This standard value set could not be resolved via the Tooling API in a cookie session.');
    const meta = await sendBg({ type: 'SF_TOOLING_GET', orgUrl: sess.orgUrl, sid: sess.sid, sobject: 'StandardValueSet', id: rec.Id });
    if (meta?.error || !meta?.Metadata) return _pkStandardDegrade(sess, field, obj, meta?.error || 'Standard value set metadata is unavailable.');
    const values = meta.Metadata.standardValue || [];
    if (!values.length) return _pkStandardDegrade(sess, field, obj, 'No standard values returned.');
    const { usage } = await _pkLoadUsage(sess, obj, field, isMulti, values);
    _pkStd = { orgUrl: sess.orgUrl, sid: sess.sid, obj, field, isMulti, svsId: rec.Id, svsName: rec.DeveloperName, metadata: meta.Metadata, rawValues: values, usage };
    _pkRenderStandard();
  } catch (e) {
    _pkStandardDegrade(sess, field, obj, e.message);
  }
}

function _pkStandardDegrade(sess, field, obj, reason) {
  const body = eid('dsPkBody');
  if (!body) return;
  const base = String(sess.orgUrl || '').replace(/\/$/, '');
  const url = `${base}/lightning/setup/ObjectManager/${encodeURIComponent(obj)}/FieldsAndRelationships/view`;
  body.innerHTML = `<div class="ds-pk-banner">🔒 <strong>${esc(field)}</strong> is a standard picklist and can't be edited here
    (${esc(reason)}). <a href="${esc(url)}" target="_blank" rel="noopener">↗ Manage in Setup</a></div>`;
}

function _pkRenderStandard() {
  const std = _pkStd;
  const base = String(std.orgUrl || '').replace(/\/$/, '');
  const url = `${base}/lightning/setup/Picklists/home`;
  _pkRenderValueSet(std, {
    title: `Standard picklist ${std.field}`,
    banner: `<div class="ds-pk-banner">🔧 Editing the <strong>${esc(std.svsName)}</strong> standard value set — this affects the value on every object that uses it. <a href="${esc(url)}" target="_blank" rel="noopener">↗ Setup</a></div>`,
    allowDelete: false,   // standard values can't be hard-deleted safely — deactivate only
    applyFn: (idx, op) => _pkStdApplyCore(std, idx, op),
    reloadFn: () => loadPicklistInventory(),
  });
}

// StandardValueSet metadata uses `standardValue[].isActive`. Toggle + PATCH back.
async function _pkStdApplyCore(std, idx, op) {
  const md = JSON.parse(JSON.stringify(std.metadata));
  const list = md.standardValue || [];
  list[idx].isActive = !op.deactivate;   // activate → true, deactivate → false
  if (op.deactivate && list[idx].default) list[idx].default = false;
  const res = await sendBg({ type: 'SF_PATCH', orgUrl: std.orgUrl, sid: std.sid,
    path: `services/data/v62.0/tooling/sobjects/StandardValueSet/${std.svsId}`, body: { Metadata: md } });
  if (res?.error) throw new Error(res.error);
  return true;
}

// ── P4b: Global value sets (GlobalValueSet) ─────────────────────
async function _pkLoadGlobal(sess, r) {
  const body = eid('dsPkBody');
  if (!body) return;
  body.innerHTML = `<div class="ds-init-loading">${window.sftkCat ? sftkCat('Loading global value set…') : 'Loading…'}</div>`;
  try {
    const q = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true,
      query: `SELECT Id, MasterLabel, DeveloperName FROM GlobalValueSet WHERE DeveloperName = ${soqlStrLit(r.name)}`, _silentError: true });
    const rec = (q && !q.error) ? (q.records || [])[0] : null;
    if (!rec) return _pkGlobalDegrade(sess, r, 'Could not resolve the global value set via the Tooling API.');
    const meta = await sendBg({ type: 'SF_TOOLING_GET', orgUrl: sess.orgUrl, sid: sess.sid, sobject: 'GlobalValueSet', id: rec.Id });
    if (meta?.error || !meta?.Metadata) return _pkGlobalDegrade(sess, r, meta?.error || 'Global value set metadata is unavailable.');
    const values = meta.Metadata.customValue || [];
    if (!values.length) return _pkGlobalDegrade(sess, r, 'No values returned for this global value set.');
    const { usage } = await _pkLoadUsage(sess, r.obj, r.field, r.isMulti, values);
    // Which fields share this GVS? (warn before any edit) — degrade to null if unavailable.
    const dep = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true,
      query: `SELECT MetadataComponentName FROM MetadataComponentDependency WHERE RefMetadataComponentType = 'GlobalValueSet' AND RefMetadataComponentName = ${soqlStrLit(r.name)}`, _silentError: true });
    const usedBy = (dep && !dep.error) ? [...new Set((dep.records || []).map(x => x.MetadataComponentName).filter(Boolean))] : null;
    _pkGvs = { orgUrl: sess.orgUrl, sid: sess.sid, obj: r.obj, field: r.field, isMulti: r.isMulti, gvsId: rec.Id, gvsName: rec.DeveloperName, metadata: meta.Metadata, rawValues: values, usage, usedBy };
    _pkRenderGlobal();
  } catch (e) {
    _pkGlobalDegrade(sess, r, e.message);
  }
}

function _pkGlobalDegrade(sess, r, reason) {
  const body = eid('dsPkBody');
  if (!body) return;
  const base = String(sess.orgUrl || '').replace(/\/$/, '');
  const url = `${base}/lightning/setup/Picklists/home`;
  body.innerHTML = `<div class="ds-pk-banner">🌐 <strong>${esc(r.field)}</strong> uses the global value set
    <strong>${esc(r.name)}</strong>, which can't be edited here (${esc(reason)}).
    <a href="${esc(url)}" target="_blank" rel="noopener">↗ Manage in Setup</a></div>`;
}

function _pkRenderGlobal() {
  const gvs = _pkGvs;
  const usedBy = gvs.usedBy;
  const banner = `<div class="ds-pk-banner">🌐 Editing the global value set <strong>${esc(gvs.gvsName)}</strong> —
    changes affect ${usedBy === null ? '<em>every field that uses it</em>' : `<strong>${usedBy.length}</strong> field(s)${usedBy.length ? `: ${esc(usedBy.slice(0, 8).join(', '))}${usedBy.length > 8 ? '…' : ''}` : ''}`}.
    The data fix below only touches <strong>${esc(gvs.obj)}.${esc(gvs.field)}</strong> — other fields keep the value on their records.</div>`;
  _pkRenderValueSet(gvs, {
    title: `Global value set ${gvs.gvsName}`,
    banner,
    allowDelete: true,
    applyFn: (idx, op) => _pkGvsApplyCore(gvs, idx, op),
    reloadFn: () => loadPicklistInventory(),
  });
}

// GlobalValueSet metadata uses `customValue[]`. Activate/deactivate/remove + PATCH.
async function _pkGvsApplyCore(gvs, idx, op) {
  const md = JSON.parse(JSON.stringify(gvs.metadata));
  const list = md.customValue || [];
  if (op.remove) list.splice(idx, 1);
  else {
    list[idx].isActive = !!op.activate;
    if (op.deactivate && list[idx].default) list[idx].default = false;
  }
  const res = await sendBg({ type: 'SF_PATCH', orgUrl: gvs.orgUrl, sid: gvs.sid,
    path: `services/data/v62.0/tooling/sobjects/GlobalValueSet/${gvs.gvsId}`, body: { Metadata: md } });
  if (res?.error) throw new Error(res.error);
  return true;
}

// ════════════════════════════════════════════════════════════════
// P5 — SYNC FROM SOURCE: make target value sets match a source org
// ════════════════════════════════════════════════════════════════
// One full-Metadata PATCH per target field applies every ticked value
// operation; record-type assignments align per shared DeveloperName.
// Deactivations that would strand data show usage counts and start unticked.
async function _pkApplySyncCore(tgt, sel) {
  const md = JSON.parse(JSON.stringify(tgt.inv.metadata));
  const list = md.valueSet.valueSetDefinition.value;
  const by = new Map(list.map(v => [pkValueName(v), v]));
  for (const a of sel.adds)      if (!by.has(a.name)) list.push({ fullName: a.name, label: a.label, default: false, isActive: a.active });
  for (const lc of sel.labels)   { const v = by.get(lc.name); if (v) v.label = lc.to; }
  for (const n of sel.activate)  { const v = by.get(n); if (v) v.isActive = true; }
  for (const n of sel.deactivate){ const v = by.get(n); if (v) { v.isActive = false; if (v.default) v.default = false; } }
  for (const n of sel.extrasOff) { const v = by.get(n); if (v) { v.isActive = false; if (v.default) v.default = false; } }
  if (sel.alignDefault && sel.alignDefault.to) {
    for (const v of list) v.default = false;
    const dv = by.get(sel.alignDefault.to) || list.find(v => pkValueName(v) === sel.alignDefault.to);
    if (dv && dv.isActive !== false) dv.default = true;
  }
  const res = await sendBg({ type: 'SF_PATCH', orgUrl: tgt.inv.orgUrl, sid: tgt.inv.sid,
    path: `services/data/v62.0/tooling/sobjects/CustomField/${tgt.inv.fieldId}`,
    body: { Metadata: md } });
  if (res?.error) throw new Error(res.error);
  return true;
}

async function _pkOpenSyncPlan() {
  const M = _pkMatrix;
  if (!M) return;
  const loaded = M.results.filter(r => r.inv);
  if (loaded.length < 2) { showToast('Load at least two orgs in the matrix first', 'warning', 5000); return; }

  // Default source: the ring's source of truth when it's among the loaded orgs.
  const ringSrcKey = _orgKey((typeof _ring === 'object' && _ring?.sourceUrl) || '');
  let srcIdx = Math.max(0, loaded.findIndex(r => r.orgKey === ringSrcKey));

  const render = () => {
    const src = loaded[srcIdx];
    const targets = loaded.filter((_, i) => i !== srcIdx);
    const plans = targets.map(tgt => ({
      tgt,
      diff: pkValueSetSyncDiff(src.inv.rawValues, tgt.inv.rawValues),
    }));

    const usageOf = (tgt, name) => {
      const c = tgt.inv.usage?.has?.(name) ? tgt.inv.usage.get(name) : null;
      return (c == null || c < 0) ? null : c;
    };

    showModal(`
      <div class="ds-modal-header">🔄 Sync ${esc(M.obj)}.${esc(M.field)} from source</div>
      <div class="ds-modal-body">
        <div class="ds-plan-op" style="margin-bottom:10px">
          Source of truth:
          <select id="dsPkSyncSrc" class="ds-select ds-select-sm">
            ${loaded.map((r, i) => `<option value="${i}" ${i === srcIdx ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
          </select>
          <span class="ds-pk-hint">every other loaded org becomes a target</span>
        </div>
        ${plans.map((pl, pi) => {
          const d = pl.diff;
          const nothing = !d.adds.length && !d.labelChanges.length && !d.activate.length
            && !d.deactivate.length && !d.extras.length && !d.defaultChange;
          return `
          <div class="ds-plan-org" data-sync-idx="${pi}">
            <div class="ds-plan-org-hdr"><strong>${esc(pl.tgt.label)}</strong> ${prodBadge(pl.tgt.orgUrl)}
              ${nothing ? '<span class="ds-ring-clean">✓ matches the source — nothing to do</span>' : ''}</div>
            ${d.adds.length ? `<label class="ds-plan-op"><input type="checkbox" class="ds-sync-op" data-p="${pi}" data-op="adds" checked>
              ➕ Add <strong>${d.adds.length}</strong> value${d.adds.length !== 1 ? 's' : ''}: ${esc(d.adds.slice(0, 6).map(a => a.name).join(', '))}${d.adds.length > 6 ? '…' : ''}</label>` : ''}
            ${d.labelChanges.length ? `<label class="ds-plan-op"><input type="checkbox" class="ds-sync-op" data-p="${pi}" data-op="labels" checked>
              ✏ Align <strong>${d.labelChanges.length}</strong> label${d.labelChanges.length !== 1 ? 's' : ''} (${esc(d.labelChanges.slice(0, 3).map(l => `${l.from}→${l.to}`).join(', '))}${d.labelChanges.length > 3 ? '…' : ''})</label>` : ''}
            ${d.activate.length ? `<label class="ds-plan-op"><input type="checkbox" class="ds-sync-op" data-p="${pi}" data-op="activate" checked>
              ▶ Activate <strong>${d.activate.length}</strong>: ${esc(d.activate.slice(0, 6).join(', '))}</label>` : ''}
            ${d.deactivate.map(n => {
              const u = usageOf(pl.tgt, n);
              return `<label class="ds-plan-op"><input type="checkbox" class="ds-sync-one" data-p="${pi}" data-op="deactivate" data-val="${esc(n)}" ${u ? '' : 'checked'}>
                ⏸ Deactivate <strong>${esc(n)}</strong> (inactive in source)${u ? ` — <span class="ds-ring-m">${u.toLocaleString()} record(s) still hold it</span>` : ''}</label>`;
            }).join('')}
            ${d.extras.map(n => {
              const u = usageOf(pl.tgt, n);
              return `<label class="ds-plan-op"><input type="checkbox" class="ds-sync-one" data-p="${pi}" data-op="extrasOff" data-val="${esc(n)}">
                🔵 Deactivate extra <strong>${esc(n)}</strong> (not in source${u ? ` — <span class="ds-ring-m">${u.toLocaleString()} record(s)</span>` : ''}) — never deleted automatically</label>`;
            }).join('')}
            ${d.defaultChange ? `<label class="ds-plan-op"><input type="checkbox" class="ds-sync-op" data-p="${pi}" data-op="alignDefault" checked>
              ⭐ Default: ${esc(d.defaultChange.from || '—')} → <strong>${esc(d.defaultChange.to || '—')}</strong></label>` : ''}
            <label class="ds-plan-op"><input type="checkbox" class="ds-sync-op" data-p="${pi}" data-op="rts" checked>
              🎛 Align record-type assignments to the source (matched by developer name — computed on run)</label>
          </div>`;
        }).join('')}
        <div class="ds-pk-hint">Adds copy the source's label and active state. Value ORDER isn't synced. Standard picklists and global value sets aren't part of this v1.</div>
      </div>
      <div class="ds-modal-footer">
        <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
        <button class="ds-btn ds-btn-primary" id="dsPkSyncRun">🔄 Sync selected</button>
      </div>`);

    eid('dsPkSyncSrc')?.addEventListener('change', e => { srcIdx = +e.target.value; render(); });
    eid('dsPkSyncRun')?.addEventListener('click', async () => {
      const btn = eid('dsPkSyncRun');
      btn.disabled = true;

      // Prod confirms up front, one per production target with anything ticked.
      for (let pi = 0; pi < plans.length; pi++) {
        const anyTicked = !!document.querySelector(`.ds-sync-op[data-p="${pi}"]:checked, .ds-sync-one[data-p="${pi}"]:checked`);
        if (anyTicked && cachedOrgType(plans[pi].tgt.orgUrl) === 'production') {
          const ok = await confirmTypedProd(orgLabel(plans[pi].tgt.orgUrl), 'sync picklist values into PRODUCTION');
          if (!ok) { btn.disabled = false; return; }
        }
      }

      const srcSess = await getOrgSession(src.orgUrl);
      for (let pi = 0; pi < plans.length; pi++) {
        const pl = plans[pi];
        const hdr = document.querySelector(`.ds-plan-org[data-sync-idx="${pi}"] .ds-plan-org-hdr`);
        const note = document.createElement('span');
        note.className = 'ds-plan-status';
        const on = op => !!document.querySelector(`.ds-sync-op[data-p="${pi}"][data-op="${op}"]:checked`);
        const ones = op => [...document.querySelectorAll(`.ds-sync-one[data-p="${pi}"][data-op="${op}"]:checked`)].map(c => c.dataset.val);
        const sel = {
          adds: on('adds') ? pl.diff.adds : [],
          labels: on('labels') ? pl.diff.labelChanges : [],
          activate: on('activate') ? pl.diff.activate : [],
          deactivate: ones('deactivate'),
          extrasOff: ones('extrasOff'),
          alignDefault: on('alignDefault') ? pl.diff.defaultChange : null,
        };
        const anyValueOp = sel.adds.length || sel.labels.length || sel.activate.length
          || sel.deactivate.length || sel.extrasOff.length || sel.alignDefault;
        const wantRts = on('rts');
        if (!anyValueOp && !wantRts) continue;
        note.textContent = ' ⏳ syncing…';
        hdr?.appendChild(note);
        try {
          if (anyValueOp) await _pkApplySyncCore(pl.tgt, sel);
          let rtDone = 0, rtFail = 0;
          if (wantRts && srcSess) {
            const tgtSess = await getOrgSession(pl.tgt.orgUrl);
            const [srcRts, tgtRts] = await Promise.all([
              _pkLoadRecordTypes(srcSess, M.obj, M.field, M.field.replace(/__c$/i, '')),
              tgtSess ? _pkLoadRecordTypes(tgtSess, M.obj, M.field, M.field.replace(/__c$/i, '')) : Promise.resolve({ rts: [] }),
            ]);
            const rtPlans = pkRtSyncDiff(srcRts.rts, tgtRts.rts);
            for (const rp of rtPlans) {
              try {
                await _pkApplyRtCore({ orgUrl: pl.tgt.inv.orgUrl, sid: pl.tgt.inv.sid,
                  field: M.field, devName: M.field.replace(/__c$/i, '') }, rp.rtId, rp.adds, rp.removes);
                rtDone++;
              } catch (_) { rtFail++; }
            }
          }
          note.textContent = ` ✅ synced${wantRts ? ` · ${rtDone} record type${rtDone !== 1 ? 's' : ''} aligned${rtFail ? ` (${rtFail} failed)` : ''}` : ''}`;
        } catch (e) {
          const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(e.message) : { message: e.message };
          note.textContent = ` ❌ ${fe.message}`;
        }
      }
      btn.textContent = '✓ Done — reload the matrix to verify';
      _history.push({ id: genId('run'), kind: 'picklist-sync',
        profileName: `Picklist sync: ${M.obj}.${M.field} from ${src.label}`,
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        status: 'success', sourceOrg: src.orgUrl, targetOrg: '',
        summary: {}, errors: [] });
      storageSaveHistory().catch(() => {});
    });
  };
  render();
}
