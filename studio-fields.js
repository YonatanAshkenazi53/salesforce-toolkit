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
//
// N5b hardening (Labs graduation):
//   • the org DEFAULTS to the Sync Ring's 👑 source of truth and FOLLOWS it
//     when the ring moves — it is no longer seeded once and left to rot;
//   • every result surface is stamped with the org it came from + a
//     timestamp, and a table is DROPPED rather than repainted under a
//     different org's name;
//   • every probe that can fail now says so inline (FLS, per-field COUNT(),
//     MAX(LastModifiedDate), dependency scan) instead of rendering as clean;
//   • load / measure / dependency-scan all run against the org that was
//     current WHEN THE TABLE WAS LOADED, not whatever the picker says at
//     click time;
//   • ✚ cross-org fill-rate compare (see faCompareFillRates).

let _faOrg       = '';     // org URL the picker is pointed at
let _faPinned    = false;  // true = user deliberately chose a non-source org
let _faLoadedOrg = '';     // org the table in memory was ACTUALLY loaded from
let _faLoadedObj = '';     // object the table in memory is for
let _faLoadedAt  = null;   // ISO stamp of that load
let _faObj       = '';     // selected object API name (the input's value)
let _faFields    = [];     // [{api,label,type,filled,total,pct,lastIso,fls,deps}]
let _faScanning  = false;
let _faCancel    = false;
let _faObjList   = null;   // cached describeGlobal names
let _faObjListOrg = '';    // which org that cache belongs to
let _faNotes     = [];     // [{ what, why, hint, raw }] inline "could NOT check"
let _faCross     = null;   // cross-org fill-rate compare result
let _faCrossRunning = false;

// Caps for the cross-org compare — small on purpose, and stated in the UI.
const FA_CROSS_MAX_FIELDS = 20;
const FA_CROSS_MAX_ORGS   = 5;   // the loaded org + up to 4 ring targets
const FA_CROSS_CHUNK      = 5;   // aggregates per SOQL statement

// ── Ring-aware org resolution ─────────────────────────────────
// _ring.sourceUrl is the 👑 source of truth; _workingPair.src only mirrors it.
// Read it LIVE — the pre-N5b code seeded _faOrg once from _workingPair.src and
// then never noticed the source moving.
function faRingSource() {
  if (typeof _ring === 'object' && _ring?.sourceUrl) return _ring.sourceUrl;
  return (typeof _workingPair === 'object' && _workingPair?.src) || '';
}

function faRingTargets() {
  if (typeof _ring !== 'object' || !_ring?.sourceUrl || (_ring.orgs || []).length < 2) return [];
  return (_ring.orgs || []).filter(u => _orgKey(u) !== _orgKey(_ring.sourceUrl));
}

// ── Honesty notes ─────────────────────────────────────────────
function faNote(what, why, raw) {
  const fe = (raw && typeof sftkFriendlyError === 'function') ? sftkFriendlyError(raw) : null;
  _faNotes.push({
    what,
    why:  why || fe?.message || 'no reason reported by the API',
    hint: fe?.hint || '',
    raw:  raw ? String(raw) : '',
  });
  faRenderNotes();
}

function faRenderNotes() {
  const el = eid('faNotes');
  if (!el) return;
  if (!_faNotes.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  el.innerHTML = `
    <div style="border:1px solid #F0C36D;background:#FFF8E6;border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#5C4405">
      <div style="font-weight:700;margin-bottom:6px">⚠ ${_faNotes.length} thing${_faNotes.length === 1 ? '' : 's'} this audit could NOT check</div>
      ${_faNotes.map(n => `<div style="margin:4px 0;line-height:1.5">
        <strong>${esc(n.what)}</strong> — ${esc(n.why)}
        ${n.hint ? `<div style="opacity:.8;margin-left:10px">💡 ${esc(n.hint)}</div>` : ''}
        ${n.raw && n.raw !== n.why ? `<div style="opacity:.6;font-family:monospace;font-size:10.5px;margin-left:10px;word-break:break-all">${esc(n.raw.slice(0, 260))}</div>` : ''}
      </div>`).join('')}
      <div style="margin-top:6px;opacity:.85">A blank or "n/a" cell below means <em>unknown</em>, never <em>unused</em>. Do not delete on the strength of a value this box says was not measured.</div>
    </div>`;
}

// ── Result attribution stamp ──────────────────────────────────
function faRenderStamp() {
  const el = eid('faStamp');
  if (!el) return;
  if (!_faFields.length || !_faLoadedOrg) { el.style.display = 'none'; el.innerHTML = ''; return; }
  const ls = (typeof _liveOrgSet === 'function') ? _liveOrgSet() : null;
  el.style.display = '';
  el.innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px;background:var(--panel,#F6F7F9);border:1px solid var(--border,#D8DDE6);border-radius:8px;padding:7px 11px;margin-bottom:10px">
      <span>🏢 <strong>${esc(orgOptionLabel(_faLoadedOrg, null, ls))}</strong></span>
      <span>· object <code>${esc(_faLoadedObj)}</code></span>
      <span style="opacity:.7">· loaded ${esc(timeAgo(_faLoadedAt))}</span>
    </div>`;
}

// Is the table currently in memory still the one this async job started on?
// Every long-running action re-checks this between awaits: the picker can move
// while 40 aggregate queries are in flight, and results from org A must never
// land on a table that now belongs to org B.
function faTableIs(org, obj) {
  return !!org && _orgKey(_faLoadedOrg) === _orgKey(org) && _faLoadedObj === obj;
}

// Throw the table away — it belongs to an org/object that is no longer current.
function faDropTable() {
  _faFields = []; _faLoadedOrg = ''; _faLoadedObj = ''; _faLoadedAt = null;
  _faCross = null; _faNotes = [];
}

function renderFieldAudit() {
  const orgs    = allMapOrgs();
  const ls      = (typeof _liveOrgSet === 'function') ? _liveOrgSet() : null;
  const ringSrc = faRingSource();

  // FOLLOW-THE-RING (unless pinned). Same semantics as profileFollowsRing():
  // an org that was only ever a default tracks the ring; an org the user
  // actively picked is left alone.
  let ringMovedFrom = '';
  if (!_faOrg) {
    _faOrg = ringSrc || orgs[0]?.url || '';
    _faPinned = false;
  } else if (!_faPinned && ringSrc && _orgKey(ringSrc) !== _orgKey(_faOrg)) {
    ringMovedFrom = _faOrg;
    _faOrg = ringSrc;
  }

  // ATTRIBUTION GUARD — never repaint one org's fields under another org's
  // name. If the picker has moved away from the org the table came from, the
  // table is dropped and the user is told why.
  let droppedFrom = '', droppedObj = '';
  if (_faFields.length && (_orgKey(_faLoadedOrg) !== _orgKey(_faOrg))) {
    droppedFrom = _faLoadedOrg; droppedObj = _faLoadedObj;
    faDropTable();
  }

  const orgOptions = orgs.map(o =>
    `<option value="${esc(o.url)}" ${_orgKey(o.url) === _orgKey(_faOrg) ? 'selected' : ''}>${esc(orgOptionLabel(o.url, o.label, ls))}</option>`).join('');
  const targets = faRingTargets();

  setMain(`
    <div class="ds-view-header">
      <div class="ds-view-title-wrap">
        <h2 class="ds-view-title">🧹 Field Audit</h2>
        <div class="ds-view-subtitle">Rank every custom field on an object by how safely it could be deleted</div>
      </div>
    </div>
    <div class="ds-fa-controls">
      <select id="faOrg" class="ds-select" style="max-width:280px">${orgOptions || '<option value="">No orgs known</option>'}</select>
      <input id="faObj" class="ds-input" list="faObjList" placeholder="Object API name (e.g. Contact)"
             value="${esc(_faObj)}" style="max-width:240px">
      <datalist id="faObjList"></datalist>
      <button class="ds-btn ds-btn-primary" id="faLoad">Load fields</button>
      <button class="ds-btn" id="faScan" style="display:${_faFields.length ? '' : 'none'}">📊 Measure usage</button>
      <button class="ds-btn" id="faCrossBtn" style="display:${(_faFields.length && targets.length) ? '' : 'none'}"
              title="Run the same fill-rate measurement against the other orgs open in Chrome, so a field that looks unused here can be seen as heavily used elsewhere BEFORE anyone deletes it.">🌐 Compare across open orgs</button>
      <button class="ds-btn ds-btn-danger" id="faCancelBtn" style="display:none">✋ Cancel</button>
      <span id="faProgress" class="ds-fa-progress"></span>
    </div>
    ${ringMovedFrom ? `<div style="font-size:12px;border:1px solid #C5DBF0;background:#E8F4FD;color:#014486;border-radius:8px;padding:8px 11px;margin-bottom:10px">
      The source moved to <strong>${esc(orgLabel(ringSrc))}</strong>
      (was <strong>${esc(orgLabel(ringMovedFrom))}</strong>) — Field Audit followed it.
      Pick a different org above to pin this view instead.</div>` : ''}
    ${droppedFrom ? `<div style="font-size:12px;border:1px solid #F0C36D;background:#FFF8E6;color:#5C4405;border-radius:8px;padding:8px 11px;margin-bottom:10px">
      🗑 The loaded field table was cleared. It held <code>${esc(droppedObj)}</code> from
      <strong>${esc(orgLabel(droppedFrom))}</strong>, and this view is now pointed at
      <strong>${esc(orgLabel(_faOrg))}</strong> — results are never re-shown under a different org.
      Press <em>Load fields</em> to audit the current org.</div>` : ''}
    <div id="faStamp" style="display:none"></div>
    <div id="faNotes" style="display:none"></div>
    <div id="faBody">
      ${_faFields.length ? '' : `
        <div class="ds-empty-page">
          <div class="ds-empty-icon">${window.sftkCatSvg ? window.sftkCatSvg('sleep', 72) : ''}</div>
          <div class="ds-empty-title">Pick an org and an object</div>
          <div class="ds-empty-sub">The audit lists every custom field with fill-rate, visibility, and last-write age —
          deletion candidates float to the top. Deep-dive a single field with the popup's 🔧 Field Cleaner.</div>
        </div>`}
    </div>
    <div id="faCrossBody"></div>`);

  faRenderStamp();
  faRenderNotes();
  if (_faFields.length) _faRenderTable();
  faRenderCross();

  eid('faOrg')?.addEventListener('change', e => {
    const v = e.target.value;
    if (_orgKey(v) === _orgKey(_faOrg)) return;
    // Switching org CANCELS any running sweep and CLEARS the table — the rows
    // on screen describe the previous org and are not transferable.
    if (_faScanning) _faCancel = true;
    _faOrg    = v;
    _faPinned = !!(faRingSource() && _orgKey(v) !== _orgKey(faRingSource()));
    _faObjList = null; _faObjListOrg = '';
    renderFieldAudit();   // the attribution guard above prints the "cleared" note
  });
  eid('faObj')?.addEventListener('focus', _faFillObjList);
  eid('faLoad')?.addEventListener('click', _faLoadFields);
  eid('faScan')?.addEventListener('click', _faMeasureUsage);
  eid('faCrossBtn')?.addEventListener('click', _faCompareAcrossRing);
  eid('faCancelBtn')?.addEventListener('click', () => { _faCancel = true; });
}

// Resolve a session for an EXPLICIT org — callers pass the org that was
// current when their work started, never "whatever the picker says now".
async function _faSession(orgUrl) {
  const url = orgUrl || _faOrg;
  const sess = await getOrgSession(url);
  if (!sess) {
    showToast(`${orgLabel(url)} is not open in a Chrome tab — open it and retry`, 'error');
    return null;
  }
  return sess;
}

async function _faFillObjList() {
  if (!_faOrg) return;
  if (_faObjList && _orgKey(_faObjListOrg) === _orgKey(_faOrg)) return;
  const sess = await getOrgSession(_faOrg);
  if (!sess) {
    faNote('Object name suggestions unavailable',
      `${orgLabel(_faOrg)} is not open in a Chrome tab, so its object list could not be read. You can still type an API name by hand.`);
    return;
  }
  const res = await sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
    path: 'services/data/v62.0/sobjects' });
  if (res.error) {
    faNote('Object name suggestions unavailable',
      'the sObject list could not be read, so the object dropdown is empty — type the API name by hand', res.error);
    return;
  }
  _faObjList = (res.sobjects || []).filter(o => o.queryable && (o.custom || /^(Account|Contact|Lead|Opportunity|Case|Campaign|Product2|Asset|Contract|Order|Task|Event|User)$/.test(o.name)));
  _faObjListOrg = _faOrg;
  const dl = eid('faObjList');
  if (dl) dl.innerHTML = _faObjList.map(o => `<option value="${esc(o.name)}">${esc(o.label)}</option>`).join('');
}

async function _faLoadFields() {
  const objInput = eid('faObj');
  _faObj = (objInput?.value || '').trim();
  // Freeze the org for the whole load — the picker can change under us.
  const org = _faOrg;
  const obj = _faObj;
  if (!org || !obj) { showToast('Pick an org and type an object API name', 'warning'); return; }
  const sess = await _faSession(org);
  if (!sess) return;
  const btn = eid('faLoad');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Loading…'; }

  _faNotes = []; _faCross = null;
  faRenderNotes(); faRenderCross();

  const desc = await sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
    path: `services/data/v62.0/sobjects/${obj}/describe` });
  if (btn) { btn.disabled = false; btn.textContent = 'Load fields'; }
  if (desc.error || !Array.isArray(desc.fields)) {
    const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(desc.error || 'no fields in the describe response') : { message: String(desc.error) };
    showToast(`Describe failed: ${fe.message}`, 'error');
    faNote(`${obj} could not be described in ${orgLabel(org)}`,
      'no fields were loaded — this is an API failure, not an object without fields', desc.error || 'no fields array');
    return;
  }
  // The picker may have moved while the describe was in flight — never commit
  // one org's fields into a view that is now pointed somewhere else.
  if (_orgKey(_faOrg) !== _orgKey(org)) {
    showToast(`Discarded the ${orgLabel(org)} load — the org was switched while it was running`, 'warning');
    return;
  }
  _faFields = desc.fields.filter(f => f.custom).map(f => ({
    api: f.name, label: f.label, type: f.type,
    formula: !!f.calculated,
    filled: null, total: null, pct: null, lastIso: null, fls: null, deps: null,
    pctErr: null, lastErr: null, depsErr: null,
  }));
  _faLoadedOrg = org;
  _faLoadedObj = obj;
  _faLoadedAt  = new Date().toISOString();
  if (!_faFields.length) {
    showToast(`${obj} has no custom fields`, 'info');
    faRenderStamp();
    return;
  }

  // FLS reach for ALL fields in one grouped query — cheap and immediate.
  const fls = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false,
    query: `SELECT Field, COUNT(Id) c FROM FieldPermissions WHERE SobjectType = ${soqlStrLit(obj)} GROUP BY Field` });
  if (!faTableIs(org, obj)) return;   // org switched mid-query
  if (fls.error) {
    // Was: silently skipped, leaving every "Visible to" cell at "—" with no
    // hint that the number is missing rather than zero.
    faNote('Field-level security was NOT read',
      'the FieldPermissions query failed, so the "Visible to" column is blank for every field — ' +
      'a blank there does NOT mean nobody can see the field', fls.error);
  } else {
    const byField = new Map((fls.records || []).map(r => [String(r.Field).replace(`${obj}.`, ''), r.c]));
    for (const f of _faFields) f.fls = byField.get(f.api) ?? 0;
  }
  eid('faScan')?.style.removeProperty('display');
  if (faRingTargets().length) eid('faCrossBtn')?.style.removeProperty('display');
  faRenderStamp();
  _faRenderTable();
}

// Batched, cancellable COUNT() sweep — 2 aggregate queries per field is the
// honest cost of fill-rates; sequential keeps the org happy, Cancel stops
// between fields, results render incrementally.
async function _faMeasureUsage() {
  if (_faScanning) return;
  // Use the org/object the TABLE was loaded from, not the current picker
  // value — otherwise a mid-audit org switch measures org B and paints the
  // numbers onto org A's rows.
  const org = _faLoadedOrg, obj = _faLoadedObj;
  if (!org || !obj) { showToast('Load an object first', 'warning'); return; }
  const sess = await _faSession(org);
  if (!sess) return;
  _faScanning = true; _faCancel = false;
  eid('faScan')?.style.setProperty('display', 'none');
  eid('faCancelBtn')?.style.removeProperty('display');
  const prog = eid('faProgress');

  const todo = _faFields.filter(f => f.pct === null && !f.formula);
  let aggFailed = 0, lastFailed = 0, firstAggErr = '', firstLastErr = '';
  let abandoned = false;
  for (let i = 0; i < todo.length; i++) {
    if (_faCancel) break;
    // The table this sweep is filling in may have been dropped (org switched)
    // between two awaits — stop rather than paint org A's numbers onto org B.
    if (!faTableIs(org, obj)) { abandoned = true; break; }
    const f = todo[i];
    if (prog) prog.textContent = `Measuring ${i + 1} of ${todo.length} in ${orgLabel(org)} — ${f.api}`;
    const agg = await sendBg({ type: 'SF_QUERY', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false,
      query: `SELECT COUNT(Id) tot, COUNT(${f.api}) filled FROM ${obj}` });
    if (agg.error) {
      // -1 = unmeasurable. KEEP THE REASON — "n/a" with no explanation was one
      // of the audited silent failures.
      f.pct = -1;
      f.pctErr = String(agg.error);
      aggFailed++;
      if (!firstAggErr) firstAggErr = String(agg.error);
      continue;
    }
    const rec = (agg.records || [])[0] || {};
    f.total  = Number(rec.tot) || 0;
    f.filled = Number(rec.filled) || 0;
    f.pct    = f.total > 0 ? (f.filled / f.total * 100) : 0;
    if (f.filled > 0) {
      const mx = await sendBg({ type: 'SF_QUERY', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false,
        query: `SELECT MAX(LastModifiedDate) m FROM ${obj} WHERE ${f.api} != null` });
      // Was: mx.error never checked, so a failed query produced lastIso = null
      // and the table drew "—" (or worse, "never") as if it were a fact.
      if (mx.error) {
        f.lastErr = String(mx.error);
        lastFailed++;
        if (!firstLastErr) firstLastErr = String(mx.error);
      } else {
        f.lastIso = (mx.records || [])[0]?.m || null;
      }
    }
    if (i % 5 === 4 || i === todo.length - 1) _faRenderTable();   // incremental paint
  }
  _faScanning = false;
  eid('faCancelBtn')?.style.setProperty('display', 'none');
  eid('faScan')?.style.removeProperty('display');
  if (abandoned) {
    if (prog) prog.textContent = `Stopped — the view left ${orgLabel(org)} / ${obj} mid-measurement`;
    return;
  }
  if (prog) prog.textContent = _faCancel ? 'Cancelled — measured values kept' : `Done — ${orgLabel(org)}`;

  if (aggFailed) {
    faNote(`${aggFailed} field${aggFailed === 1 ? '' : 's'} could not be measured`,
      'the COUNT() aggregate was rejected for them (encrypted, formula-like or aggregate-unsupported types do this) — ' +
      'their "Populated" cell shows n/a, which means UNKNOWN, not empty', firstAggErr);
  }
  if (lastFailed) {
    faNote(`${lastFailed} last-write date${lastFailed === 1 ? '' : 's'} could not be read`,
      'the MAX(LastModifiedDate) query failed for them — the "Last write" cell shows "?" and the ' +
      'delete-candidacy score for those rows carries no staleness component', firstLastErr);
  }
  if (_faCancel) {
    const left = _faFields.filter(f => f.pct === null && !f.formula).length;
    if (left) {
      faNote('Measurement was cancelled',
        `${left} field${left === 1 ? '' : 's'} still have no fill-rate at all — they are sorted as unmeasured, not as unused`);
    }
  }
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
  const measured = _faFields.filter(f => f.pct !== null && f.pct >= 0).length;
  const unmeasurable = _faFields.filter(f => f.pct === -1).length;
  const ls = (typeof _liveOrgSet === 'function') ? _liveOrgSet() : null;
  const pctCell = f => {
    if (f.formula)   return '<span class="ds-fa-na">formula</span>';
    if (f.pct === null) return '<span class="ds-fa-na" title="Not measured yet — click 📊 Measure usage">—</span>';
    if (f.pct < 0)      return `<span class="ds-fa-na" style="text-decoration:underline dotted" title="${esc('UNKNOWN, not empty. The COUNT() query failed: ' + (f.pctErr || 'no reason reported'))}">n/a ⚠</span>`;
    const cls = f.pct < 1 ? 'ds-fa-empty' : f.pct < 25 ? 'ds-fa-low' : '';
    return `<span class="${cls}">${f.pct < 1 && f.filled > 0 ? '<1' : Math.round(f.pct)}% <small>(${(f.filled ?? 0).toLocaleString()})</small></span>`;
  };
  const ageCell = f => {
    if (f.lastErr) return `<span class="ds-fa-na" style="text-decoration:underline dotted" title="${esc('The MAX(LastModifiedDate) query failed: ' + f.lastErr)}">? ⚠</span>`;
    if (!f.lastIso) return f.filled === 0 && f.pct !== null && f.pct >= 0 ? '<span class="ds-fa-empty">never</span>' : '—';
    const months = (Date.now() - Date.parse(f.lastIso)) / 2.63e9;
    return months < 12 ? `${Math.max(1, Math.round(months))}mo` : `${(months / 12).toFixed(1)}y`;
  };
  const flsCell = f => {
    if (f.fls === null) return '<span class="ds-fa-na" style="text-decoration:underline dotted" title="Field-level security was not read for this audit — see the warning box above. Blank means UNKNOWN.">? ⚠</span>';
    return f.fls === 0 ? '<span class="ds-fa-empty">nobody</span>' : `${f.fls} profile(s)`;
  };
  body.innerHTML = `
    <div class="ds-fa-summary">
      <strong>${_faFields.length}</strong> custom fields on <code>${esc(_faLoadedObj || _faObj)}</code>
      in <strong>${esc(orgOptionLabel(_faLoadedOrg, null, ls))}</strong>
      · ${measured ? `${measured} measured` : 'click 📊 Measure usage for fill-rates'}
      ${unmeasurable ? `· <span style="color:#8A6100">${unmeasurable} unmeasurable</span>` : ''}
      · sorted by delete-candidacy — <span class="ds-fa-empty">green</span> = strong candidate
      · <span style="opacity:.75">loaded ${esc(timeAgo(_faLoadedAt))}</span>
    </div>
    <div class="tablewrap ds-fa-tablewrap"><table class="ds-fa-table">
      <tr><th>Field</th><th>Type</th><th>Populated</th><th>Last write</th><th>Visible to</th><th>Dependencies</th></tr>
      ${rows.map(f => `
        <tr class="${_faScore(f) >= 120 ? 'ds-fa-candidate' : ''}">
          <td><div class="ds-fa-lbl">${esc(f.label)}</div><code class="ds-fa-api">${esc(f.api)}</code></td>
          <td>${esc(f.type)}</td>
          <td>${pctCell(f)}</td>
          <td>${ageCell(f)}</td>
          <td>${flsCell(f)}</td>
          <td>${f.deps === null
            ? `<button class="ds-btn ds-btn-xs ds-fa-depbtn" data-fa-field="${esc(f.api)}">scan</button>`
            : f.deps < 0 ? `<span class="ds-fa-na" style="text-decoration:underline dotted" title="${esc('Dependency scan FAILED — this is not "no references". Reason: ' + (f.depsErr || 'unknown'))}">error ⚠</span>`
            : f.deps === 0 ? '<span class="ds-fa-empty">none found</span>'
            : `<strong>${f.deps}</strong> ref(s)`}</td>
        </tr>`).join('')}
    </table></div>
    <div class="ds-fa-foot">🔧 To deprecate or delete a candidate: open the popup → Field Cleaner → pick ${esc(_faLoadedObj || _faObj)} + the field.
    Dependency scans use the same Tooling index as the Field Cleaner (Reports/Email Templates not covered).
    ${faRingTargets().length ? 'Before deleting anything, run 🌐 Compare across ring — a field that is empty here may be full in another org.' : ''}</div>`;

  body.querySelectorAll('.ds-fa-depbtn').forEach(btn => {
    btn.addEventListener('click', () => _faScanDeps(btn.dataset.faField, btn));
  });
}

// Lazy per-field dependency count (MetadataComponentDependency needs the
// CustomField's Tooling id — 2 queries per click, on demand only).
async function _faScanDeps(fieldApi, btn) {
  const org = _faLoadedOrg, obj = _faLoadedObj;
  if (!org || !obj) return;
  const sess = await _faSession(org);
  if (!sess || !faTableIs(org, obj)) return;
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  const f = _faFields.find(x => x.api === fieldApi);
  try {
    const dev = fieldApi.replace(/__c$/i, '');
    // TableEnumOrId is the API name for STANDARD objects but the raw 01I id
    // for CUSTOM objects — resolve via EntityDefinition when needed.
    let tableKey = obj;
    if (/__c$/i.test(obj)) {
      const ent = await sendBg({ type: 'SF_QUERY', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true,
        query: `SELECT DurableId FROM EntityDefinition WHERE QualifiedApiName = ${soqlStrLit(obj)}` });
      if (ent.error) throw new Error(`EntityDefinition lookup failed: ${ent.error}`);
      tableKey = (ent.records || [])[0]?.DurableId || obj;
    }
    const idRes = await sendBg({ type: 'SF_QUERY', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true,
      query: `SELECT Id FROM CustomField WHERE DeveloperName = ${soqlStrLit(dev)} AND TableEnumOrId = ${soqlStrLit(tableKey)}` });
    if (idRes.error) throw new Error(`CustomField lookup failed: ${idRes.error}`);
    const fid = (idRes.records || [])[0]?.Id;
    if (!fid) throw new Error(`no CustomField record found for ${obj}.${fieldApi} (Tooling API)`);
    const dep = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true,
      query: `SELECT MetadataComponentId FROM MetadataComponentDependency WHERE RefMetadataComponentId = ${soqlStrLit(fid)}` });
    if (dep.error) throw new Error(dep.error);
    if (f) { f.deps = (dep.records || []).length; f.depsErr = null; }
  } catch (e) {
    // Was: `catch (_)` — the reason was thrown away and the cell just said
    // "error", which readers took as "scanned, nothing found".
    const raw = e?.message || String(e);
    const fe  = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(raw) : { message: raw };
    if (f) { f.deps = -1; f.depsErr = fe.message || raw; }
    faNote(`Dependency scan failed for ${fieldApi}`,
      'its Dependencies cell says "error" — that means the scan could not run, NOT that the field is unreferenced', raw);
  }
  if (faTableIs(org, obj)) _faRenderTable();
}

// ════════════════════════════════════════════════════════════════
// CROSS-ORG FILL-RATE COMPARE (N5b capability jump)
// ════════════════════════════════════════════════════════════════
// A field that is 0% here can be 80% in the org next door. Deleting on the
// strength of one org's number is how data loss happens. This runs the same
// fill-rate measurement against the ring's targets and puts the percentages
// side by side. Heavily capped — and the caps are printed in the UI.

// PURE — perOrg is
//   [{ orgUrl, label, ok, error, fields: { API_NAME: { pct, filled, total, error } | null } }]
// A field key absent from an org's map means the field does not exist there;
// a null/error cell means it exists but could not be measured. Both come back
// as `known:false` with a reason — never as 0%.
function faCompareFillRates(perOrg) {
  const orgs = Array.isArray(perOrg) ? perOrg : [];
  const apis = [], seenApi = new Set();
  for (const o of orgs) {
    for (const k of Object.keys((o && o.fields) || {})) {
      if (!seenApi.has(k)) { seenApi.add(k); apis.push(k); }
    }
  }
  const rows = apis.map(api => {
    const cells = orgs.map(o => {
      const has  = !!(o && o.fields && Object.prototype.hasOwnProperty.call(o.fields, api));
      const cell = has ? o.fields[api] : null;
      const num  = !!(cell && typeof cell.pct === 'number' && cell.pct >= 0);
      const known = !!(o && o.ok) && has && num;
      let reason = '';
      if (!known) {
        if (!o || !o.ok)  reason = (o && o.error) || 'this org was not measured';
        else if (!has)    reason = 'the field does not exist in this org';
        else              reason = (cell && cell.error) || 'the fill-rate could not be measured here';
      }
      return {
        orgUrl: (o && o.orgUrl) || '',
        label:  (o && o.label) || '',
        known,
        pct:    known ? cell.pct : null,
        filled: known ? (typeof cell.filled === 'number' ? cell.filled : null) : null,
        total:  known ? (typeof cell.total  === 'number' ? cell.total  : null) : null,
        reason,
      };
    });
    const knownCells = cells.filter(c => c.known);
    const pcts = knownCells.map(c => c.pct);
    const min  = pcts.length ? Math.min(...pcts) : null;
    const max  = pcts.length ? Math.max(...pcts) : null;
    const missingIn = cells.filter(c => !c.known && c.reason === 'the field does not exist in this org').map(c => c.label);
    let verdict = 'unknown';
    if (knownCells.length >= 2) {
      if (max < 1)                     verdict = 'unused-everywhere';
      else if (min < 1 && max >= 10)   verdict = 'used-elsewhere';
      else                             verdict = 'used';
    } else if (knownCells.length === 1) {
      verdict = 'single-org';
    }
    return {
      api, cells, comparableOrgs: knownCells.length,
      min, max,
      spread: (min === null || max === null) ? null : (max - min),
      missingIn, verdict,
    };
  });
  // Most decision-changing first: "empty here, busy there" beats everything.
  const rank = { 'used-elsewhere': 0, 'unused-everywhere': 1, 'used': 2, 'single-org': 3, 'unknown': 4 };
  rows.sort((a, b) =>
    ((rank[a.verdict] ?? 9) - (rank[b.verdict] ?? 9)) ||
    ((b.spread === null ? -1 : b.spread) - (a.spread === null ? -1 : a.spread)) ||
    String(a.api).localeCompare(String(b.api)));
  return rows;
}

// Run one chunked aggregate sweep for `fields` on `obj` in one org.
// Returns { ok, total, fields: { api: { pct, filled, total, error } }, error }.
async function _faOrgFillRates(sess, obj, fields, onProgress) {
  const out = { ok: true, total: null, fields: {}, error: '' };
  const chunks = [];
  for (let i = 0; i < fields.length; i += FA_CROSS_CHUNK) chunks.push(fields.slice(i, i + FA_CROSS_CHUNK));

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    if (onProgress) onProgress(ci + 1, chunks.length);
    const sel = chunk.map((f, i) => `COUNT(${f}) c${i}`).join(', ');
    const res = await sendBg({ type: 'SF_QUERY', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false,
      query: `SELECT COUNT(Id) tot, ${sel} FROM ${obj}` });
    if (!res.error) {
      const rec = (res.records || [])[0] || {};
      const tot = Number(rec.tot) || 0;
      out.total = tot;
      chunk.forEach((f, i) => {
        const filled = Number(rec[`c${i}`]) || 0;
        out.fields[f] = { pct: tot > 0 ? (filled / tot * 100) : 0, filled, total: tot, error: '' };
      });
      continue;
    }
    // One bad field poisons a whole chunked aggregate — retry the chunk field
    // by field so a single unsupported type doesn't blank out four good ones.
    for (const f of chunk) {
      const one = await sendBg({ type: 'SF_QUERY', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false,
        query: `SELECT COUNT(Id) tot, COUNT(${f}) filled FROM ${obj}` });
      if (one.error) {
        const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(one.error) : { message: String(one.error) };
        out.fields[f] = { pct: -1, filled: null, total: null, error: fe.message || String(one.error) };
        continue;
      }
      const rec = (one.records || [])[0] || {};
      const tot = Number(rec.tot) || 0;
      const filled = Number(rec.filled) || 0;
      out.total = tot;
      out.fields[f] = { pct: tot > 0 ? (filled / tot * 100) : 0, filled, total: tot, error: '' };
    }
  }
  return out;
}

async function _faCompareAcrossRing() {
  if (_faCrossRunning) return;
  const org = _faLoadedOrg, obj = _faLoadedObj;
  if (!org || !obj || !_faFields.length) { showToast('Load an object first', 'warning'); return; }
  const targets = faRingTargets().filter(u => _orgKey(u) !== _orgKey(org));
  if (!targets.length) { showToast('No other orgs are open to compare against', 'warning'); return; }

  _faCrossRunning = true;
  _faCancel = false;
  const btn = eid('faCrossBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Comparing…'; }
  eid('faCancelBtn')?.style.removeProperty('display');
  const prog = eid('faProgress');
  const finish = () => {
    _faCrossRunning = false;
    const b = eid('faCrossBtn');
    if (b) { b.disabled = false; b.textContent = '🌐 Compare across ring'; }
    eid('faCancelBtn')?.style.setProperty('display', 'none');
  };

  // Cap the FIELDS: the strongest delete candidates, which are the ones anyone
  // is actually about to remove. Formula fields are skipped (not COUNT-able).
  const candidates = _faFields.filter(f => !f.formula)
    .sort((a, b) => _faScore(b) - _faScore(a));
  const fieldApis  = candidates.slice(0, FA_CROSS_MAX_FIELDS).map(f => f.api);
  const orgUrls    = [org, ...targets].slice(0, FA_CROSS_MAX_ORGS);
  const notes      = [
    `Capped at the top ${fieldApis.length} delete-candidate field${fieldApis.length === 1 ? '' : 's'} of ${candidates.length} non-formula custom fields on ${obj}.`,
    `Capped at ${orgUrls.length} org${orgUrls.length === 1 ? '' : 's'} (the loaded org + up to ${FA_CROSS_MAX_ORGS - 1} other open orgs)${targets.length > FA_CROSS_MAX_ORGS - 1 ? ` — ${targets.length - (FA_CROSS_MAX_ORGS - 1)} open org(s) were NOT checked` : ''}.`,
    'Formula fields are excluded — COUNT() aggregates do not apply to them.',
  ];

  const perOrg = [];
  let abandoned = false;
  for (const u of orgUrls) {
    if (_faCancel) { notes.push('Cancelled — the orgs below this point were not measured.'); break; }
    if (!faTableIs(org, obj)) { abandoned = true; break; }
    const label = orgLabel(u);
    if (prog) prog.textContent = `Comparing — ${label}…`;
    const sess = await getOrgSession(u);
    if (!sess) {
      perOrg.push({ orgUrl: u, label, ok: false, error: 'not open in a Chrome tab, so nothing could be measured here', fields: {} });
      continue;
    }
    // Which of the capped fields actually EXIST in this org?
    const desc = await sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
      path: `services/data/v62.0/sobjects/${obj}/describe` });
    if (desc.error || !Array.isArray(desc.fields)) {
      const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(desc.error || 'no fields returned') : { message: String(desc.error) };
      perOrg.push({ orgUrl: u, label, ok: false, error: `${obj} could not be described here — ${fe.message}`, fields: {} });
      continue;
    }
    const present = new Set(desc.fields.map(f => f.name));
    const here    = fieldApis.filter(a => present.has(a));
    const res     = await _faOrgFillRates(sess, obj, here,
      (i, n) => { if (prog) prog.textContent = `Comparing — ${label} (${i}/${n})…`; });
    perOrg.push({ orgUrl: u, label, ok: true, error: '', fields: res.fields, recordCount: res.total });
  }

  finish();
  if (abandoned || !faTableIs(org, obj)) {
    if (prog) prog.textContent = `Cross-org compare discarded — the view left ${orgLabel(org)} / ${obj} while it ran`;
    return;
  }
  _faCross = {
    obj, at: new Date().toISOString(), notes,
    baseOrg: org,
    orgs: perOrg.map(o => ({ orgUrl: o.orgUrl, label: o.label, ok: o.ok, error: o.error, recordCount: o.recordCount ?? null })),
    rows: faCompareFillRates(perOrg),
  };
  if (prog) prog.textContent = 'Cross-org compare done';
  faRenderCross();
}

function faRenderCross() {
  const el = eid('faCrossBody');
  if (!el) return;
  if (!_faCross) { el.innerHTML = ''; return; }
  const ls   = (typeof _liveOrgSet === 'function') ? _liveOrgSet() : null;
  const orgs = _faCross.orgs;
  const rows = _faCross.rows;
  const VERDICT = {
    'used-elsewhere':    { icon: '🛑', text: 'empty here, USED elsewhere — do not delete', color: '#B91C1C' },
    'unused-everywhere': { icon: '✅', text: 'empty in every org compared',                 color: '#2E844A' },
    'used':              { icon: '•',  text: 'in use',                                      color: 'inherit' },
    'single-org':        { icon: '?',  text: 'only one org could be measured — no comparison', color: '#8A6100' },
    'unknown':           { icon: '?',  text: 'not measurable in any org compared',          color: '#8A6100' },
  };
  const cell = c => {
    if (!c.known) return `<span class="ds-fa-na" style="text-decoration:underline dotted" title="${esc('UNKNOWN — ' + c.reason)}">—</span>`;
    const cls = c.pct < 1 ? 'ds-fa-empty' : c.pct < 25 ? 'ds-fa-low' : '';
    return `<span class="${cls}" title="${esc(`${c.filled ?? 0} of ${c.total ?? 0} records`)}">${c.pct < 1 && (c.filled || 0) > 0 ? '<1' : Math.round(c.pct)}%</span>`;
  };
  const risky = rows.filter(r => r.verdict === 'used-elsewhere').length;

  el.innerHTML = `
    <div style="margin-top:18px;border:1px solid var(--border,#D8DDE6);border-radius:10px;padding:12px 14px">
      <div style="font-weight:700;font-size:13px;margin-bottom:4px">🌐 Cross-org fill rate — <code>${esc(_faCross.obj)}</code>${_faCross.baseOrg ? ` · started from ${esc(orgLabel(_faCross.baseOrg))}` : ''}</div>
      <div style="font-size:12px;opacity:.85;margin-bottom:8px">
        Run ${esc(timeAgo(_faCross.at))} across ${orgs.length} org${orgs.length === 1 ? '' : 's'}.
        ${risky ? `<strong style="color:#B91C1C">${risky} field${risky === 1 ? '' : 's'} look deletable here but are in active use in another org.</strong>`
                : 'No field in this sample is empty here and busy elsewhere.'}
      </div>
      <div class="tablewrap ds-fa-tablewrap"><table class="ds-fa-table">
        <tr>
          <th>Field</th>
          ${orgs.map(o => `<th title="${esc(o.ok ? (o.recordCount != null ? `${o.recordCount.toLocaleString()} records` : 'measured') : o.error)}">
            ${esc(orgOptionLabel(o.orgUrl, o.label, ls))}${o.ok ? '' : ' ⚠'}</th>`).join('')}
          <th>Verdict</th>
        </tr>
        ${rows.map(r => {
          const v = VERDICT[r.verdict] || VERDICT.unknown;
          return `<tr>
            <td><code class="ds-fa-api">${esc(r.api)}</code>
              ${r.missingIn.length ? `<div style="font-size:10.5px;opacity:.75">absent in ${esc(r.missingIn.join(', '))}</div>` : ''}</td>
            ${r.cells.map(c => `<td>${cell(c)}</td>`).join('')}
            <td style="color:${v.color}">${esc(v.icon)} ${esc(v.text)}
              ${r.comparableOrgs < orgs.length ? `<div style="font-size:10.5px;opacity:.75">based on ${r.comparableOrgs} of ${orgs.length} orgs</div>` : ''}</td>
          </tr>`;
        }).join('')}
      </table></div>
      <div class="ds-fa-foot">
        <strong>What this run did NOT cover:</strong>
        <ul style="margin:4px 0 0 18px;padding:0;line-height:1.55">
          ${_faCross.notes.map(n => `<li>${esc(n)}</li>`).join('')}
          ${orgs.filter(o => !o.ok).map(o => `<li>${esc(o.label)}: ${esc(o.error)}</li>`).join('')}
          <li>A dash (—) is UNKNOWN, never 0%. Hover it for the reason.</li>
        </ul>
      </div>
    </div>`;
}
