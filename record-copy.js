// ============================================================
// Record Copy — copy one or many records (+ related children)
//               from one Salesforce org to another
// ============================================================
// Flow:
//   ① Source: Object type + optional SOQL WHERE → checkbox list
//   ② Related: child relationship counts → checkbox to include each
//   ③ Target org selector
//   Copy:
//     1. Batch-create parent records (Collections API, 200/batch)
//     2. Build idMap: sourceId → targetId
//     3. For each included child type: fetch, remap reference fields, batch-create
//   ID remapping ensures children point to the newly-created parents.
//   RecordType is resolved by DeveloperName across orgs.
// ============================================================
'use strict';
const RecordCopy = (() => {

  // ── State ────────────────────────────────────────────────────
  let _orgUrl, _sid, _container, _activeTabUrl;
  let _allSessions  = [];
  let _targetOrgUrl = null;
  let _targetSid    = null;

  let _objType     = '';
  let _mainDescribe = null;
  let _sourceRecords = [];      // [{ id, name, data }]
  let _selectedIds  = new Set();

  // [{ childSObject, field, relationshipName, count, selected }]
  let _relatedTypes  = [];

  let _describeCache = {};      // objectType → describe response (+ "tgt:type" for target)
  let _rtMap         = {};      // sourceRtId → { devName, targetId | null }
  let _idMap         = {};      // sourceId → targetId (built during copy)
  let _copying       = false;

  // ── Field constants ──────────────────────────────────────────
  const SYSTEM_FIELDS = new Set([
    'Id','CreatedDate','LastModifiedDate','SystemModstamp',
    'CreatedById','LastModifiedById','IsDeleted',
    'LastActivityDate','LastViewedDate','LastReferencedDate',
    'MasterRecordId','IsArchived'
  ]);

  const COPYABLE_TYPES = new Set([
    'string','textarea','email','phone','url',
    'picklist','multipicklist',
    'boolean','double','integer','currency','percent','long',
    'date','datetime','time','encryptedstring'
  ]);

  // Relationship names that are internal/system and rarely useful to copy
  const SKIP_RELS = new Set([
    'ActivityHistories','OpenActivities','NoteAndAttachments','Attachments',
    'FeedSubscriptionsForEntity','RecordAssociatedGroups','ContentDocumentLinks',
    'ContentVersions','Histories','Shares','ProcessInstances','ProcessSteps',
    'Tags','UserRecordAccess','FlowRecordRelations','EmailMessageRelations',
    'ListEmailIndividualRecipients','TopicAssignments','Votes','EntitySubscriptions'
  ]);

  // ── Helpers ──────────────────────────────────────────────────
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function eid(id) { return document.getElementById(id); }

  function sendBgRaw(msg) {
    return new Promise(r =>
      chrome.runtime.sendMessage(msg, res =>
        r(res || { error: chrome.runtime.lastError?.message || 'No response' })
      )
    );
  }

  async function sendBg(msg) {
    const _t   = window.SFToolkitDebug?.enabled ? Date.now() : null;
    const resp = await sendBgRaw(msg);
    if (window.SFToolkitDebug?.enabled) {
      const dur = _t !== null ? Date.now() - _t : null;
      const tag = msg.query?.substring(0,80) || msg.path || '';
      window.SFToolkitDebug.log('record-copy',
        resp?.error === 'SESSION_EXPIRED' ? 'session' : resp?.error ? 'error' : 'api',
        `${msg.type}${tag ? '  '+tag : ''}`, resp?.error || null, dur);
    }
    if (resp?.error !== 'SESSION_EXPIRED') return resp;
    const fresh = await sendBgRaw({ type: 'GET_SF_SESSION', activeTabUrl: _orgUrl });
    if (fresh?.sid && fresh?.orgUrl) {
      _orgUrl = fresh.orgUrl; _sid = fresh.sid;
      return sendBgRaw(msg.sid !== undefined
        ? { ...msg, orgUrl: fresh.orgUrl, sid: fresh.sid } : msg);
    }
    return resp;
  }

  // ── Public API ───────────────────────────────────────────────
  function init(container, orgUrl, sid, activeTabUrl) {
    _container = container; _orgUrl = orgUrl; _sid = sid; _activeTabUrl = activeTabUrl;
    _allSessions = []; _targetOrgUrl = null; _targetSid = null;
    _sourceRecords = []; _selectedIds = new Set(); _relatedTypes = [];
    _describeCache = {}; _rtMap = {}; _idMap = {}; _copying = false;
    _mainDescribe = null; _objType = '';
    renderShell();
    loadAllSessions();
  }

  function updateSession(orgUrl, sid) { _orgUrl = orgUrl; _sid = sid; }

  // ── URL detection ─────────────────────────────────────────────
  function detectFromUrl(url) {
    if (!url) return null;
    const m = url.match(/\/lightning\/r\/([^/]+)\/([A-Za-z0-9]{15,18})\//);
    return m ? { objectType: decodeURIComponent(m[1]), recordId: m[2] } : null;
  }

  // ── Shell ─────────────────────────────────────────────────────
  function renderShell() {
    const det = detectFromUrl(_activeTabUrl);
    _container.innerHTML = `
      <div class="rc-wrap">

        <div class="rc-section">
          <div class="rc-section-title">① Source Records</div>
          <div class="rc-source-row">
            <div class="rc-field-group">
              <label class="rc-lbl">Object Type</label>
              <input id="rcObjInput" class="rc-input"
                     placeholder="Account, Contact, Case__c…"
                     value="${esc(det?.objectType || '')}" autocomplete="off">
            </div>
          </div>
          <div style="margin-top:6px">
            <label class="rc-lbl">
              WHERE clause
              <span class="rc-lbl-hint">— optional SOQL filter; leave blank to use the detected record</span>
            </label>
            <input id="rcWhereInput" class="rc-input"
                   placeholder="e.g.  AccountId = '001xxx'   or   Status = 'Active'"
                   value="${det ? `Id = '${esc(det.recordId)}'` : ''}"
                   autocomplete="off">
          </div>
          ${det ? `<div class="rc-hint-ok" style="margin-top:5px">✅ Auto-detected from current tab</div>` : ''}
          <button id="rcLoadBtn" class="btn btn-primary rc-action-btn" style="margin-top:8px">
            🔍 Load Records
          </button>
        </div>

        <div class="rc-section">
          <div class="rc-section-title">② Target Org</div>
          <div id="rcTargetWrap">
            <div class="rc-loading-row">${sftkCatSm('Finding open orgs…')}</div>
          </div>
        </div>

        <div id="rcResultArea"></div>
      </div>`;

    eid('rcLoadBtn').addEventListener('click', onLoadClick);
    eid('rcWhereInput').addEventListener('keydown', e => { if (e.key === 'Enter') onLoadClick(); });
  }

  // ── Target org selector ───────────────────────────────────────
  async function loadAllSessions() {
    const res = await sendBg({ type: 'GET_ALL_SF_SESSIONS' });
    _allSessions = (res.sessions || []).filter(s => s.orgUrl !== _orgUrl);
    renderTargetSelector();
  }

  function renderTargetSelector() {
    const wrap = eid('rcTargetWrap');
    if (!wrap) return;

    if (!_allSessions.length) {
      wrap.innerHTML = `
        <div class="rc-warn-inline">
          ⚠ No other orgs detected. Open the target org in Chrome first.
          <button class="btn btn-secondary btn-sm" id="rcRefreshOrgs" style="margin-left:6px">🔄 Refresh</button>
        </div>`;
      eid('rcRefreshOrgs')?.addEventListener('click', () => {
        wrap.innerHTML = '<div class="rc-loading-row">' + sftkCatSm('Searching…') + '</div>';
        loadAllSessions();
      });
      return;
    }

    wrap.innerHTML = `
      <select id="rcTargetSel" class="rc-select">
        <option value="">— Select target org —</option>
        ${_allSessions.map((s,i) => `<option value="${i}">${esc(s.label)}</option>`).join('')}
      </select>`;

    eid('rcTargetSel').addEventListener('change', e => {
      const i = parseInt(e.target.value, 10);
      if (!isNaN(i) && _allSessions[i]) {
        _targetOrgUrl = _allSessions[i].orgUrl;
        _targetSid    = _allSessions[i].sid;
      } else {
        _targetOrgUrl = null; _targetSid = null;
      }
      updateCopyBtn();
    });
  }

  // ── Describe (cached per org) ─────────────────────────────────
  async function getDescribe(objectType, useTarget = false) {
    const key = `${useTarget ? 'tgt:' : ''}${objectType}`;
    if (_describeCache[key]) return _describeCache[key];
    const res = await sendBg({
      type:   'SF_REST_GET',
      orgUrl: useTarget ? _targetOrgUrl : _orgUrl,
      sid:    useTarget ? _targetSid    : _sid,
      path:   `services/data/v62.0/sobjects/${objectType}/describe`
    });
    if (res.error) return null;
    _describeCache[key] = res;
    return res;
  }

  // Build the SOQL SELECT field list: all accessible fields the user might want
  // (primitives + references so we can remap them; system fields excluded).
  function buildSelectFields(describe) {
    if (!describe?.fields) return ['Id'];
    const fields = describe.fields
      .filter(f => {
        if (f.name === 'Id') return true;
        if (SYSTEM_FIELDS.has(f.name)) return false;
        // No `f.accessible` check — REST describe fields have no such
        // property (undefined for all), so checking it rejected every field.
        // Describe only returns FLS-visible fields anyway.
        return COPYABLE_TYPES.has(f.type) || f.type === 'reference';
      })
      .map(f => f.name);
    if (!fields.includes('Id')) fields.unshift('Id');
    return fields;
  }

  // ── Load records ──────────────────────────────────────────────
  async function onLoadClick() {
    const objType = (eid('rcObjInput')?.value || '').trim();
    if (!objType) return showArea('<div class="rc-error-msg">⚠ Enter an Object Type.</div>');
    if (!_targetOrgUrl) return showArea('<div class="rc-error-msg">⚠ Select a target org first.</div>');

    _objType = objType;
    const where = (eid('rcWhereInput')?.value || '').trim();
    _sourceRecords = []; _selectedIds = new Set(); _relatedTypes = [];
    _mainDescribe = null;

    showArea('<div class="rc-loading-row">' + sftkCatSm('Loading records…') + '</div>');

    _mainDescribe = await getDescribe(objType);
    if (!_mainDescribe) {
      return showArea(`<div class="rc-error-msg">❌ Could not describe "${esc(objType)}". Check the object API name.</div>`);
    }

    const fields = buildSelectFields(_mainDescribe);
    const soql   = `SELECT ${fields.join(',')} FROM ${objType}${where ? ` WHERE ${where}` : ''} LIMIT 200`;
    const res    = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: _orgUrl, sid: _sid, query: soql });
    if (res.error) {
      const eMsg = res.error === 'SESSION_EXPIRED' ? 'Session expired — log back into Salesforce and retry' : `Query failed: ${esc(res.error)}`;
      return showArea(`<div class="rc-error-msg">❌ ${eMsg}</div>`);
    }

    _sourceRecords = (res.records || []).map(r => ({
      id:   r.Id,
      name: r.Name || r.Subject || r.CaseNumber || r.Title || r.Id,
      data: r
    }));

    if (!_sourceRecords.length) {
      return showArea('<div class="rc-empty">No records matched the query.</div>');
    }

    _sourceRecords.forEach(r => _selectedIds.add(r.id));
    renderRecordList();
  }

  // ── Record list with checkboxes ───────────────────────────────
  function renderRecordList() {
    const area = eid('rcResultArea');
    if (!area) return;

    // Meaningful child relationships from the describe
    const childRels = (_mainDescribe?.childRelationships || [])
      .filter(r => r.relationshipName && !SKIP_RELS.has(r.relationshipName) && !r.deprecatedAndHidden)
      .slice(0, 20);

    const n = _sourceRecords.length;
    area.innerHTML = `
      <div class="rc-section">
        <div class="rc-section-hdr">
          <div class="rc-section-title">③ Select Records (${n})</div>
          <div class="rc-sel-btns">
            <button class="btn btn-secondary btn-sm" id="rcSelAll">All</button>
            <button class="btn btn-secondary btn-sm" id="rcSelNone">None</button>
          </div>
        </div>
        <div class="rc-record-list" id="rcRecordList">
          ${_sourceRecords.map(r => `
            <label class="rc-rec-row">
              <input type="checkbox" class="rc-rec-cb" value="${esc(r.id)}" checked>
              <span class="rc-rec-name">${esc(r.name)}</span>
              <span class="rc-rec-id">${esc(r.id.substring(0,15))}</span>
            </label>`).join('')}
        </div>
        <div class="rc-rec-count" id="rcRecCount">${n} record${n !== 1 ? 's' : ''} selected</div>
      </div>

      ${childRels.length ? `
      <div class="rc-section" id="rcRelSection">
        <div class="rc-section-title">④ Related Records</div>
        <div id="rcRelList">
          <div class="rc-loading-row">${sftkCatSm('Counting related records…')}</div>
        </div>
      </div>` : ''}

      <button id="rcCopyBtn" class="btn btn-primary rc-action-btn" disabled>
        📋 Copy to Target
      </button>`;

    // Checkbox events
    area.querySelectorAll('.rc-rec-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) _selectedIds.add(cb.value);
        else            _selectedIds.delete(cb.value);
        refreshRecCount();
        updateCopyBtn();
      });
    });

    eid('rcSelAll')?.addEventListener('click', () => {
      _sourceRecords.forEach(r => _selectedIds.add(r.id));
      area.querySelectorAll('.rc-rec-cb').forEach(cb => cb.checked = true);
      refreshRecCount(); updateCopyBtn();
    });

    eid('rcSelNone')?.addEventListener('click', () => {
      _selectedIds.clear();
      area.querySelectorAll('.rc-rec-cb').forEach(cb => cb.checked = false);
      refreshRecCount(); updateCopyBtn();
    });

    eid('rcCopyBtn')?.addEventListener('click', doCopy);
    updateCopyBtn();

    if (childRels.length) loadRelatedCounts(childRels);
  }

  function refreshRecCount() {
    const el = eid('rcRecCount');
    if (!el) return;
    const n = _selectedIds.size;
    el.textContent = `${n} record${n !== 1 ? 's' : ''} selected`;
  }

  function updateCopyBtn() {
    const btn = eid('rcCopyBtn');
    if (!btn) return;
    const n   = _selectedIds.size;
    const rel = _relatedTypes.filter(r => r.selected).reduce((s, r) => s + r.count, 0);
    const lbl = _allSessions.find(s => s.orgUrl === _targetOrgUrl)?.label || 'Target';
    btn.disabled = n === 0 || !_targetOrgUrl || _copying;
    btn.textContent = rel
      ? `📋 Copy ${n} record${n!==1?'s':''} + ${rel} related → ${lbl}`
      : `📋 Copy ${n} record${n!==1?'s':''} → ${lbl}`;
  }

  // ── Related record counts ─────────────────────────────────────
  async function loadRelatedCounts(childRels) {
    const listEl = eid('rcRelList');
    if (!listEl) return;

    const ids    = _sourceRecords.map(r => r.id);
    const idList = ids.map(id => `'${id}'`).join(',');

    const results = await Promise.allSettled(
      childRels.map(rel =>
        sendBg({
          type: 'SF_QUERY', tooling: false, orgUrl: _orgUrl, sid: _sid,
          query: `SELECT COUNT() FROM ${rel.childSObject} WHERE ${rel.field} IN (${idList})`
        })
      )
    );

    _relatedTypes = childRels
      .map((rel, i) => {
        const r     = results[i];
        const count = (r.status === 'fulfilled' && !r.value?.error)
          ? (r.value?.totalSize ?? 0) : 0;
        return { ...rel, count, selected: false };
      })
      .filter(r => r.count > 0)
      .sort((a, b) => b.count - a.count);  // most records first

    if (!_relatedTypes.length) {
      listEl.innerHTML = `<div class="rc-hint-tip">No child records found.</div>`;
      return;
    }

    listEl.innerHTML = `
      <div class="rc-related-note">
        Lookup fields pointing to the copied parent records will be automatically remapped to the new IDs in the target org.
      </div>
      ${_relatedTypes.map((r, i) => `
        <label class="rc-rel-row">
          <input type="checkbox" class="rc-rel-cb" data-idx="${i}">
          <span class="rc-rel-obj">${esc(r.childSObject)}</span>
          <span class="rc-rel-count">${r.count}</span>
          <span class="rc-rel-field">via ${esc(r.field)}</span>
        </label>`).join('')}`;

    listEl.querySelectorAll('.rc-rel-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const i = parseInt(cb.dataset.idx, 10);
        if (_relatedTypes[i]) _relatedTypes[i].selected = cb.checked;
        updateCopyBtn();
      });
    });
  }

  function showArea(html) {
    const a = eid('rcResultArea');
    if (a) a.innerHTML = html;
  }

  // ── Copy orchestration ────────────────────────────────────────
  async function doCopy() {
    if (_copying || _selectedIds.size === 0) return;
    _copying = true;
    _idMap   = {};

    const btn       = eid('rcCopyBtn');
    if (btn) btn.disabled = true;

    const selected    = _sourceRecords.filter(r => _selectedIds.has(r.id));
    const included    = _relatedTypes.filter(r => r.selected && r.count > 0);
    const targetLabel = _allSessions.find(s => s.orgUrl === _targetOrgUrl)?.label || 'target';

    const area = eid('rcResultArea');
    area.innerHTML = `
      <div class="rc-progress-wrap">
        <div class="rc-progress-title">Copying to ${esc(targetLabel)}…</div>
        <div id="rcProgLog" class="rc-progress-log"></div>
      </div>`;

    function log(icon, msg, cls = '') {
      const logEl = eid('rcProgLog');
      if (!logEl) return;
      const row = document.createElement('div');
      row.className = `rc-prog-row${cls ? ' ' + cls : ''}`;
      row.innerHTML = `<span class="rc-prog-icon">${icon}</span><span>${esc(msg)}</span>`;
      logEl.appendChild(row);
      logEl.scrollTop = logEl.scrollHeight;
    }

    try {
      // ── 1. Pre-resolve RecordTypes for parent records ──────────
      const rtIds = [...new Set(selected.map(r => r.data.RecordTypeId).filter(Boolean))];
      if (rtIds.length) await resolveRecordTypes(rtIds, _objType);

      // ── 2. Create parent records ───────────────────────────────
      const mainPayloads = selected.map(r => buildPayload(r.data, _mainDescribe));
      log('📤', `Creating ${mainPayloads.length} ${_objType} record${mainPayloads.length!==1?'s':''}…`);

      const mainResults = await batchCreate(_targetOrgUrl, _targetSid, _objType, mainPayloads);
      let okCount = 0, failCount = 0;
      mainResults.forEach((res, i) => {
        const src = selected[i];
        if (res.success) { _idMap[src.id] = res.id; okCount++; }
        else {
          failCount++;
          const msg = (res.errors || []).map(e => e.message).join('; ') || 'Unknown error';
          log('❌', `${src.name}: ${msg}`, 'rc-prog-err');
        }
      });
      log(failCount ? '⚠' : '✅',
        `${_objType}: ${okCount} created${failCount ? `, ${failCount} failed` : ''}`);

      // ── 3. Create related records ──────────────────────────────
      for (const rel of included) {
        const childDescribe = await getDescribe(rel.childSObject);
        if (!childDescribe) {
          log('⚠', `Could not describe ${rel.childSObject} — skipped`);
          continue;
        }

        // Fetch all child records belonging to selected parents
        const childFields = buildSelectFields(childDescribe);
        const idList      = selected.map(r => `'${r.id}'`).join(',');
        const childRes    = await sendBg({
          type: 'SF_QUERY_ALL', tooling: false, orgUrl: _orgUrl, sid: _sid,
          query: `SELECT ${childFields.join(',')} FROM ${rel.childSObject} WHERE ${rel.field} IN (${idList}) LIMIT 2000`
        });

        if (childRes.error) {
          log('❌', `Fetch ${rel.childSObject} failed: ${childRes.error}`, 'rc-prog-err');
          continue;
        }

        const children = childRes.records || [];
        if (!children.length) continue;

        // Resolve RecordTypes for this child object
        const childRtIds = [...new Set(children.map(r => r.RecordTypeId).filter(Boolean))];
        if (childRtIds.length) await resolveRecordTypes(childRtIds, rel.childSObject);

        const childPayloads = children.map(r => buildPayload(r, childDescribe));

        log('📤', `Creating ${childPayloads.length} ${rel.childSObject}…`);

        const childResults = await batchCreate(_targetOrgUrl, _targetSid, rel.childSObject, childPayloads);
        let cOk = 0, cFail = 0;
        childResults.forEach((res, i) => {
          const srcId = children[i]?.Id;
          if (res.success) { if (srcId) _idMap[srcId] = res.id; cOk++; }
          else {
            cFail++;
            const msg = (res.errors || []).map(e => e.message).join('; ');
            log('❌', `${rel.childSObject} ${srcId || '?'}: ${msg}`, 'rc-prog-err');
          }
        });
        log(cFail ? '⚠' : '✅',
          `${rel.childSObject}: ${cOk} created${cFail ? `, ${cFail} failed` : ''}`);
      }

      // ── 4. Done ───────────────────────────────────────────────
      const total   = Object.keys(_idMap).length;
      const firstId = Object.values(_idMap)[0];
      const openUrl = firstId ? `${_targetOrgUrl}/lightning/r/${_objType}/${firstId}/view` : null;

      const logEl = eid('rcProgLog');
      if (logEl) {
        const done = document.createElement('div');
        done.className = 'rc-done-row';
        done.innerHTML = `
          <div class="rc-done-title">
            ✅ Done — ${total} record${total!==1?'s':''} created in ${esc(targetLabel)}
          </div>
          <div class="rc-done-btns">
            ${openUrl ? `<button class="btn btn-secondary" id="rcOpenBtn">↗ Open in ${esc(targetLabel)}</button>` : ''}
            <button class="btn btn-secondary" id="rcAgainBtn">📋 Copy Again</button>
          </div>`;
        logEl.appendChild(done);
        logEl.scrollTop = logEl.scrollHeight;
        eid('rcOpenBtn')?.addEventListener('click', () => chrome.tabs.create({ url: openUrl }));
        eid('rcAgainBtn')?.addEventListener('click', () => init(_container, _orgUrl, _sid, _activeTabUrl));
      }
    } catch (e) {
      const logEl = eid('rcProgLog');
      if (logEl) {
        const err = document.createElement('div');
        err.className = 'rc-prog-row rc-prog-err';
        err.innerHTML = `<span class="rc-prog-icon">❌</span><span>${esc('Unexpected error: ' + e.message)}</span>`;
        logEl.appendChild(err);
      }
    } finally {
      _copying = false;
    }
  }

  // ── Batch create via Collections API (200/batch) ──────────────
  async function batchCreate(orgUrl, sid, objectType, payloads) {
    const BATCH = 200;
    const all   = [];
    for (let i = 0; i < payloads.length; i += BATCH) {
      const chunk = payloads.slice(i, i + BATCH).map(p => ({
        attributes: { type: objectType },
        ...p
      }));
      const res = await sendBg({ type: 'SF_COLLECTIONS_CREATE', orgUrl, sid, records: chunk });
      if (res.error) {
        chunk.forEach(() => all.push({ success: false, errors: [{ message: res.error }] }));
      } else {
        all.push(...(Array.isArray(res) ? res : []));
      }
    }
    return all;
  }

  // ── Build create payload for one record ───────────────────────
  // Reference fields are remapped via _idMap; unknown lookups are skipped.
  function buildPayload(data, describe) {
    const payload = {};
    if (!describe?.fields) return payload;

    for (const f of describe.fields) {
      if (SYSTEM_FIELDS.has(f.name)) continue;
      if (f.name === 'OwnerId') continue;  // default to API user in target
      if (!f.createable) continue;

      const value = data[f.name];
      if (value == null) continue;

      if (f.name === 'RecordTypeId') {
        const mapped = _rtMap[value];
        if (mapped?.targetId) payload.RecordTypeId = mapped.targetId;
        continue;
      }

      if (f.type === 'reference') {
        // Remap if we copied the parent; otherwise skip (ID doesn't transfer)
        const remapped = _idMap[value];
        if (remapped) payload[f.name] = remapped;
        continue;
      }

      if (COPYABLE_TYPES.has(f.type)) payload[f.name] = value;
    }

    return payload;
  }

  // ── RecordType resolution (batch, both orgs) ──────────────────
  async function resolveRecordTypes(rtIds, objectType) {
    const unresolved = rtIds.filter(id => !_rtMap[id]);
    if (!unresolved.length) return;

    const inClause = unresolved.map(id => `'${id}'`).join(',');

    const [srcRes, tgtRes] = await Promise.all([
      sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: _orgUrl, sid: _sid,
               query: `SELECT Id, DeveloperName FROM RecordType WHERE Id IN (${inClause})` }),
      // Pre-fetch all RTs for this object in the target org
      sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: _targetOrgUrl, sid: _targetSid,
               query: `SELECT Id, DeveloperName FROM RecordType WHERE SObjectType = '${objectType}'` })
    ]);

    const srcRts = {};
    for (const r of (srcRes.records || [])) srcRts[r.Id] = r.DeveloperName;

    const tgtRts = {};
    for (const r of (tgtRes.records || [])) tgtRts[r.DeveloperName] = r.Id;

    for (const [id, devName] of Object.entries(srcRts)) {
      _rtMap[id] = { devName, targetId: tgtRts[devName] || null };
    }
  }

  return { init, updateSession };
})();
