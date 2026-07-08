'use strict';
// ════════════════════════════════════════════════════════════════
// FIELD AUDIT (F7) — object-wide deprecation dashboard
// ════════════════════════════════════════════════════════════════
// "Contact has 400 custom fields; which 60 can go?" Ranks EVERY custom field
// of an object by delete-candidacy: fill-rate (batched COUNT() sweep,
// cancellable), FLS reach (one grouped FieldPermissions query), last write,
// and on-demand dependency counts (MetadataComponentDependency per field).
// Deep work on a single field (deprecate / fix / delete) stays in the popup
// Field Cleaner — this view finds the candidates.
//
// First tool built in the Data Studio shell (Phase X pilot).

let _faOrg      = '';      // selected org URL
let _faObj      = '';      // selected object API name
let _faFields   = [];      // [{api,label,type,filled,total,pct,lastIso,fls,deps}]
let _faScanning = false;
let _faCancel   = false;
let _faObjList  = null;    // cached describeGlobal names per org

function renderFieldAudit() {
  const orgs = allMapOrgs();
  if (!_faOrg) _faOrg = _workingPair.src || _workingPair.tgt || orgs[0]?.url || '';
  const orgOptions = orgs.map(o =>
    `<option value="${esc(o.url)}" ${o.url === _faOrg ? 'selected' : ''}>${esc(orgOptionLabel(o.url, o.label))}</option>`).join('');

  setMain(`
    <div class="ds-view-header">
      <div class="ds-view-title-wrap">
        <h2 class="ds-view-title">🧹 Field Audit</h2>
        <div class="ds-view-subtitle">Rank every custom field on an object by how safely it could be deleted</div>
      </div>
    </div>
    <div class="ds-fa-controls">
      <select id="faOrg" class="ds-select" style="max-width:260px">${orgOptions || '<option value="">No orgs known</option>'}</select>
      <input id="faObj" class="ds-input" list="faObjList" placeholder="Object API name (e.g. Contact)"
             value="${esc(_faObj)}" style="max-width:240px">
      <datalist id="faObjList"></datalist>
      <button class="ds-btn ds-btn-primary" id="faLoad">Load fields</button>
      <button class="ds-btn" id="faScan" style="display:none">📊 Measure usage</button>
      <button class="ds-btn ds-btn-danger" id="faCancelBtn" style="display:none">✋ Cancel</button>
      <span id="faProgress" class="ds-fa-progress"></span>
    </div>
    <div id="faBody">
      ${_faFields.length ? '' : `
        <div class="ds-empty-page">
          <div class="ds-empty-icon">${window.sftkCatSvg ? window.sftkCatSvg('sleep', 72) : ''}</div>
          <div class="ds-empty-title">Pick an org and an object</div>
          <div class="ds-empty-sub">The audit lists every custom field with fill-rate, visibility, and last-write age —
          deletion candidates float to the top. Deep-dive a single field with the popup's 🔧 Field Cleaner.</div>
        </div>`}
    </div>`);

  if (_faFields.length) _faRenderTable();

  eid('faOrg')?.addEventListener('change', e => { _faOrg = e.target.value; _faObjList = null; });
  eid('faObj')?.addEventListener('focus', _faFillObjList);
  eid('faLoad')?.addEventListener('click', _faLoadFields);
  eid('faScan')?.addEventListener('click', _faMeasureUsage);
  eid('faCancelBtn')?.addEventListener('click', () => { _faCancel = true; });
}

async function _faSession() {
  const sess = await getOrgSession(_faOrg);
  if (!sess) {
    showToast('Org is not open in a Chrome tab — open it and retry', 'error');
    return null;
  }
  return sess;
}

async function _faFillObjList() {
  if (_faObjList || !_faOrg) return;
  const sess = await getOrgSession(_faOrg);
  if (!sess) return;
  const res = await sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
    path: 'services/data/v62.0/sobjects' });
  if (res.error) return;
  _faObjList = (res.sobjects || []).filter(o => o.queryable && (o.custom || /^(Account|Contact|Lead|Opportunity|Case|Campaign|Product2|Asset|Contract|Order|Task|Event|User)$/.test(o.name)));
  const dl = eid('faObjList');
  if (dl) dl.innerHTML = _faObjList.map(o => `<option value="${esc(o.name)}">${esc(o.label)}</option>`).join('');
}

async function _faLoadFields() {
  const objInput = eid('faObj');
  _faObj = (objInput?.value || '').trim();
  if (!_faOrg || !_faObj) { showToast('Pick an org and type an object API name', 'warning'); return; }
  const sess = await _faSession();
  if (!sess) return;
  const btn = eid('faLoad');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Loading…'; }

  const desc = await sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
    path: `services/data/v62.0/sobjects/${_faObj}/describe` });
  if (btn) { btn.disabled = false; btn.textContent = 'Load fields'; }
  if (desc.error || !Array.isArray(desc.fields)) {
    showToast(`Describe failed: ${desc.error || 'no fields'}`, 'error');
    return;
  }
  _faFields = desc.fields.filter(f => f.custom).map(f => ({
    api: f.name, label: f.label, type: f.type,
    formula: !!f.calculated,
    filled: null, total: null, pct: null, lastIso: null, fls: null, deps: null,
  }));
  if (!_faFields.length) { showToast(`${_faObj} has no custom fields`, 'info'); return; }

  // FLS reach for ALL fields in one grouped query — cheap and immediate.
  const fls = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false,
    query: `SELECT Field, COUNT(Id) c FROM FieldPermissions WHERE SobjectType = '${_faObj}' GROUP BY Field` });
  if (!fls.error) {
    const byField = new Map((fls.records || []).map(r => [String(r.Field).replace(`${_faObj}.`, ''), r.c]));
    for (const f of _faFields) f.fls = byField.get(f.api) ?? 0;
  }
  eid('faScan')?.style.removeProperty('display');
  _faRenderTable();
}

// Batched, cancellable COUNT() sweep — 2 aggregate queries per field is the
// honest cost of fill-rates; sequential keeps the org happy, Cancel stops
// between fields, results render incrementally.
async function _faMeasureUsage() {
  if (_faScanning) return;
  const sess = await _faSession();
  if (!sess) return;
  _faScanning = true; _faCancel = false;
  eid('faScan')?.style.setProperty('display', 'none');
  eid('faCancelBtn')?.style.removeProperty('display');
  const prog = eid('faProgress');

  const todo = _faFields.filter(f => f.pct === null && !f.formula);
  for (let i = 0; i < todo.length; i++) {
    if (_faCancel) break;
    const f = todo[i];
    if (prog) prog.textContent = `Measuring ${i + 1} of ${todo.length} — ${f.api}`;
    const agg = await sendBg({ type: 'SF_QUERY', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false,
      query: `SELECT COUNT(Id) tot, COUNT(${f.api}) filled FROM ${_faObj}` });
    if (agg.error) { f.pct = -1; continue; }   // -1 = unmeasurable (encrypted/agg-unsupported)
    const rec = (agg.records || [])[0] || {};
    f.total  = Number(rec.tot) || 0;
    f.filled = Number(rec.filled) || 0;
    f.pct    = f.total > 0 ? (f.filled / f.total * 100) : 0;
    if (f.filled > 0) {
      const mx = await sendBg({ type: 'SF_QUERY', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false,
        query: `SELECT MAX(LastModifiedDate) m FROM ${_faObj} WHERE ${f.api} != null` });
      f.lastIso = (mx.records || [])[0]?.m || null;
    }
    if (i % 5 === 4 || i === todo.length - 1) _faRenderTable();   // incremental paint
  }
  _faScanning = false;
  if (prog) prog.textContent = _faCancel ? 'Cancelled — measured values kept' : 'Done';
  eid('faCancelBtn')?.style.setProperty('display', 'none');
  eid('faScan')?.style.removeProperty('display');
  _faRenderTable();
}

// Candidacy score: emptier + invisible + stale = higher. Unmeasured sorts low.
function _faScore(f) {
  if (f.formula) return -1;
  let s = 0;
  if (f.pct !== null && f.pct >= 0) {
    s += (100 - f.pct);                                  // emptiness 0–100
    if (f.lastIso) {
      const years = (Date.now() - Date.parse(f.lastIso)) / 3.156e10;
      s += Math.min(30, years * 10);                      // staleness up to +30
    } else if (f.filled === 0) s += 30;                   // never written
  }
  if (f.fls === 0) s += 20;                               // nobody can see it
  return s;
}

function _faRenderTable() {
  const body = eid('faBody');
  if (!body) return;
  const rows = [..._faFields].sort((a, b) => _faScore(b) - _faScore(a));
  const measured = _faFields.filter(f => f.pct !== null).length;
  const pctCell = f => {
    if (f.formula)   return '<span class="ds-fa-na">formula</span>';
    if (f.pct === null) return '<span class="ds-fa-na">—</span>';
    if (f.pct < 0)      return '<span class="ds-fa-na">n/a</span>';
    const cls = f.pct < 1 ? 'ds-fa-empty' : f.pct < 25 ? 'ds-fa-low' : '';
    return `<span class="${cls}">${f.pct < 1 && f.filled > 0 ? '<1' : Math.round(f.pct)}% <small>(${(f.filled ?? 0).toLocaleString()})</small></span>`;
  };
  const ageCell = f => {
    if (!f.lastIso) return f.filled === 0 && f.pct !== null ? '<span class="ds-fa-empty">never</span>' : '—';
    const months = (Date.now() - Date.parse(f.lastIso)) / 2.63e9;
    return months < 12 ? `${Math.max(1, Math.round(months))}mo` : `${(months / 12).toFixed(1)}y`;
  };
  body.innerHTML = `
    <div class="ds-fa-summary">
      <strong>${_faFields.length}</strong> custom fields on <code>${esc(_faObj)}</code>
      · ${measured ? `${measured} measured` : 'click 📊 Measure usage for fill-rates'}
      · sorted by delete-candidacy — <span class="ds-fa-empty">green</span> = strong candidate
    </div>
    <div class="tablewrap ds-fa-tablewrap"><table class="ds-fa-table">
      <tr><th>Field</th><th>Type</th><th>Populated</th><th>Last write</th><th>Visible to</th><th>Dependencies</th></tr>
      ${rows.map(f => `
        <tr class="${_faScore(f) >= 120 ? 'ds-fa-candidate' : ''}">
          <td><div class="ds-fa-lbl">${esc(f.label)}</div><code class="ds-fa-api">${esc(f.api)}</code></td>
          <td>${esc(f.type)}</td>
          <td>${pctCell(f)}</td>
          <td>${ageCell(f)}</td>
          <td>${f.fls === null ? '—' : f.fls === 0 ? '<span class="ds-fa-empty">nobody</span>' : `${f.fls} profile(s)`}</td>
          <td>${f.deps === null
            ? `<button class="ds-btn ds-btn-xs ds-fa-depbtn" data-fa-field="${esc(f.api)}">scan</button>`
            : f.deps < 0 ? '<span class="ds-fa-na">error</span>'
            : f.deps === 0 ? '<span class="ds-fa-empty">none found</span>'
            : `<strong>${f.deps}</strong> ref(s)`}</td>
        </tr>`).join('')}
    </table></div>
    <div class="ds-fa-foot">🔧 To deprecate or delete a candidate: open the popup → Field Cleaner → pick ${esc(_faObj)} + the field.
    Dependency scans use the same Tooling index as the Field Cleaner (Reports/Email Templates not covered).</div>`;

  body.querySelectorAll('.ds-fa-depbtn').forEach(btn => {
    btn.addEventListener('click', () => _faScanDeps(btn.dataset.faField, btn));
  });
}

// Lazy per-field dependency count (MetadataComponentDependency needs the
// CustomField's Tooling id — 2 queries per click, on demand only).
async function _faScanDeps(fieldApi, btn) {
  const sess = await _faSession();
  if (!sess) return;
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  const f = _faFields.find(x => x.api === fieldApi);
  try {
    const dev = fieldApi.replace(/__c$/i, '');
    // TableEnumOrId is the API name for STANDARD objects but the raw 01I id
    // for CUSTOM objects — resolve via EntityDefinition when needed.
    let tableKey = _faObj;
    if (/__c$/i.test(_faObj)) {
      const ent = await sendBg({ type: 'SF_QUERY', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true,
        query: `SELECT DurableId FROM EntityDefinition WHERE QualifiedApiName = '${_faObj.replace(/'/g, "\\'")}'` });
      tableKey = (ent.records || [])[0]?.DurableId || _faObj;
    }
    const idRes = await sendBg({ type: 'SF_QUERY', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true,
      query: `SELECT Id FROM CustomField WHERE DeveloperName = '${dev.replace(/'/g, "\\'")}' AND TableEnumOrId = '${tableKey}'` });
    const fid = (idRes.records || [])[0]?.Id;
    if (!fid) throw new Error('field id not found');
    const dep = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true,
      query: `SELECT MetadataComponentId FROM MetadataComponentDependency WHERE RefMetadataComponentId = '${fid}'` });
    if (dep.error) throw new Error(dep.error);
    if (f) f.deps = (dep.records || []).length;
  } catch (_) {
    if (f) f.deps = -1;
  }
  _faRenderTable();
}
