// ============================================================
// Conflict Scanner — detects automation conflicts across
// Flows, Apex Triggers, and Workflow Rules
// ============================================================
const ConflictScanner = (() => {
  let _orgUrl = null;
  let _sid    = null;
  let _container = null;

  // ── Public API ───────────────────────────────────────────
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

  // ── Shell UI ─────────────────────────────────────────────
  function renderShell() {
    _container.innerHTML = `
      <div class="cs-wrap">
        <div class="cs-intro">
          <p class="cs-intro-text">
            Scans all active automations in your org — Flows, Apex Triggers, and Workflow
            Rules — and surfaces conflicts, ordering issues, and anti-patterns by object.
          </p>
          <button class="btn btn-primary" id="csScanBtn">🔍 Scan Org</button>
        </div>
        <div id="csScanProgress" class="scan-progress" style="display:none">
          <div class="lp-rcat">
            <div class="lp-rcat-ears"><div class="lp-rcat-ear"></div><div class="lp-rcat-ear"></div></div>
            <div class="lp-rcat-head"><div class="lp-rcat-eye"></div><div class="lp-rcat-eye"></div></div>
            <div class="lp-rcat-body"></div>
            <div class="lp-rcat-arms"><div class="lp-rcat-arm lp-rcat-arm-left"></div><div class="lp-rcat-arm lp-rcat-arm-right"></div></div>
            <div class="lp-rcat-legs"><div class="lp-rcat-leg"></div><div class="lp-rcat-leg"></div></div>
          </div>
          <span id="csScanProgressText">Scanning…</span>
        </div>
        <div id="csSummaryBar" style="display:none"></div>
        <div id="csResults"></div>
      </div>
    `;
    document.getElementById('csScanBtn').addEventListener('click', runScan);
  }

  // ── Main scan ────────────────────────────────────────────
  async function runScan() {
    const btn = document.getElementById('csScanBtn');
    btn.disabled = true;
    document.getElementById('csResults').innerHTML  = '';
    const summaryBar = document.getElementById('csSummaryBar');
    if (summaryBar) { summaryBar.innerHTML = ''; summaryBar.style.display = 'none'; }

    // Start with whatever the DependencyMap already cached
    const localTTMap = Object.assign({}, DependencyMap.getTriggerTypeMap());
    const localTOMap = Object.assign({}, DependencyMap.getTriggerObjectMap());

    // ── Step 1: Active flows ───────────────────────────────
    setProgress(true, 'Loading active flows…');
    const flowRes = await bg({
      type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true,
      query: `SELECT Id,MasterLabel,Definition.DeveloperName,VersionNumber,ProcessType ` +
             `FROM Flow WHERE Status='Active' ORDER BY MasterLabel`
    });
    if (flowRes.error) {
      const userMsg = flowRes.error === 'SESSION_EXPIRED'
        ? 'Session expired — log back into Salesforce and try again'
        : `Could not load flows: ${flowRes.error}`;
      renderError(userMsg); btn.disabled = false; return;
    }

    const flows = (flowRes.records || []).map(f => ({
      ...f,
      ApiName: f.Definition?.DeveloperName || ''
    }));

    // ── Step 2: Fetch missing trigger metadata for AutoLaunched flows ──
    const needsMeta = flows.filter(f =>
      f.ProcessType === 'AutoLaunchedFlow' && !localTTMap[f.Id]
    );

    if (needsMeta.length > 0) {
      const BATCH = 10;
      for (let i = 0; i < needsMeta.length; i += BATCH) {
        setProgress(true, `Fetching flow metadata… ${Math.min(i + BATCH, needsMeta.length)} / ${needsMeta.length}`);
        const batch = needsMeta.slice(i, i + BATCH);
        await Promise.all(batch.map(async flow => {
          try {
            const r = await bg({ type: 'SF_GET_METADATA', orgUrl: _orgUrl, sid: _sid, id: flow.Id });
            if (r?.Metadata?.start) {
              const tt = r.Metadata.start.triggerType || null;
              const to = r.Metadata.start.object      || null;
              if (tt) localTTMap[flow.Id] = tt;
              if (to) localTOMap[flow.Id] = to;
            }
          } catch (_) {}
        }));
      }
    }

    // ── Step 3: Apex Triggers ──────────────────────────────
    setProgress(true, 'Loading Apex triggers…');
    const apexRes = await bg({
      type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true,
      query: `SELECT Id,Name,TableEnumOrId,` +
             `UsageBeforeInsert,UsageAfterInsert,UsageBeforeUpdate,` +
             `UsageAfterUpdate,UsageBeforeDelete,UsageAfterDelete ` +
             `FROM ApexTrigger WHERE Status='Active' AND IsValid=true`
    });
    const apexTriggers = apexRes.error ? [] : (apexRes.records || []);

    // ── Step 4: Workflow Rules ─────────────────────────────
    setProgress(true, 'Loading workflow rules…');
    const wfRes = await bg({
      type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true,
      query: `SELECT Id,Name,TableEnumOrId,Active FROM WorkflowRule WHERE Active=true`
    });
    const wfRules = wfRes.error ? [] : (wfRes.records || []);

    setProgress(false);

    // ── Step 5: Detect & render ───────────────────────────
    const issues = detectConflicts(flows, localTTMap, localTOMap, apexTriggers, wfRules);
    renderResults(issues, flows, apexTriggers, wfRules);
    btn.disabled = false;
  }

  // ── Conflict detection ────────────────────────────────────
  function detectConflicts(flows, ttMap, toMap, apexTriggers, wfRules) {
    const issues = [];

    // ── Index: flows by trigger object ──────────────────────
    const allFlowsByObj  = {};   // obj -> [flow]  (all record-triggered)
    const beforeByObj    = {};   // obj -> [flow]  (Before-Save only)
    const afterByObj     = {};   // obj -> [flow]  (After-Save only)

    for (const f of flows) {
      const tt  = ttMap[f.Id];
      const obj = toMap[f.Id];
      if (!obj) continue;

      if (!allFlowsByObj[obj]) allFlowsByObj[obj] = [];
      allFlowsByObj[obj].push(f);

      if (tt === 'RecordBeforeSave') {
        if (!beforeByObj[obj]) beforeByObj[obj] = [];
        beforeByObj[obj].push(f);
      } else if (tt === 'RecordAfterSave') {
        if (!afterByObj[obj]) afterByObj[obj] = [];
        afterByObj[obj].push(f);
      }
    }

    // ── Index: Apex by object ───────────────────────────────
    const apexByObj = {};
    for (const t of apexTriggers) {
      const obj = t.TableEnumOrId;
      if (!apexByObj[obj]) apexByObj[obj] = [];
      apexByObj[obj].push(t);
    }

    // ── Index: Workflow Rules by object ─────────────────────
    const wfByObj = {};
    for (const w of wfRules) {
      const obj = w.TableEnumOrId;
      if (!wfByObj[obj]) wfByObj[obj] = [];
      wfByObj[obj].push(w);
    }

    // ── Check 1: Multiple Before-Save Flows (CRITICAL) ──────
    for (const [obj, fls] of Object.entries(beforeByObj)) {
      if (fls.length < 2) continue;
      issues.push({
        severity: 'critical',
        object: obj,
        title: `${fls.length} Before-Save Flows on ${obj}`,
        detail: 'Before-Save Flows run in an undefined order. These flows may silently overwrite each other\'s field changes, causing data inconsistencies.',
        rec: 'Consolidate into a single Before-Save Flow per object to ensure predictable execution.',
        items: fls.map(f => mkItem(f.MasterLabel, 'flow', `v${f.VersionNumber} · Before Save`))
      });
    }

    // ── Check 2: Multiple After-Save Flows (WARNING) ────────
    for (const [obj, fls] of Object.entries(afterByObj)) {
      if (fls.length < 2) continue;
      issues.push({
        severity: 'warning',
        object: obj,
        title: `${fls.length} After-Save Flows on ${obj}`,
        detail: 'Multiple After-Save Flows can produce cascading DML and governor limit issues if they both update related records.',
        rec: 'Review whether logic can be combined, or add criteria to ensure only one runs per scenario.',
        items: fls.map(f => mkItem(f.MasterLabel, 'flow', `v${f.VersionNumber} · After Save`))
      });
    }

    // ── Check 3: Multiple Apex Triggers on same object (WARNING) ──
    for (const [obj, triggers] of Object.entries(apexByObj)) {
      if (triggers.length < 2) continue;
      issues.push({
        severity: 'warning',
        object: obj,
        title: `${triggers.length} Apex Triggers on ${obj}`,
        detail: 'Multiple Apex Triggers on one object is an anti-pattern. Execution order between triggers is not guaranteed.',
        rec: 'Consolidate into a single trigger using the "Trigger Handler" design pattern.',
        items: triggers.map(t => mkItem(t.Name, 'apex', apexEvents(t)))
      });
    }

    // ── Check 4: Apex Trigger + Flow on same object (WARNING) ──
    for (const obj of Object.keys(apexByObj)) {
      const fls = allFlowsByObj[obj];
      if (!fls || fls.length === 0) continue;
      issues.push({
        severity: 'warning',
        object: obj,
        title: `Apex Trigger + Flow active on ${obj}`,
        detail: 'Apex Triggers execute before Flows in the same transaction. Fields set by Apex may be overwritten by Flows, or vice versa.',
        rec: 'Document which automation owns each field and ensure only one sets it per transaction.',
        items: [
          ...apexByObj[obj].map(t => mkItem(t.Name, 'apex', apexEvents(t))),
          ...fls.map(f => mkItem(f.MasterLabel, 'flow', `v${f.VersionNumber} · ${fmtTrigger(ttMap[f.Id])}`))
        ]
      });
    }

    // ── Check 5: Workflow Rule + Flow on same object (WARNING) ──
    for (const obj of Object.keys(wfByObj)) {
      const fls = allFlowsByObj[obj];
      if (!fls || fls.length === 0) continue;
      issues.push({
        severity: 'warning',
        object: obj,
        title: `Workflow Rule + Flow both active on ${obj}`,
        detail: 'Workflow Rules fire synchronously on save before Flows. Both may attempt to update the same fields, causing double writes or conflicts.',
        rec: 'Migrate Workflow Rules to Record-Triggered Flows. Workflow Rules are deprecated.',
        items: [
          ...wfByObj[obj].map(w => mkItem(w.Name, 'workflow', 'Workflow Rule (deprecated)')),
          ...fls.map(f => mkItem(f.MasterLabel, 'flow', `v${f.VersionNumber}`))
        ]
      });
    }

    // ── Check 6: Active Process Builders (INFO) ─────────────
    const procBuilders = flows.filter(f => f.ProcessType === 'Workflow');
    if (procBuilders.length > 0) {
      issues.push({
        severity: 'info',
        title: `${procBuilders.length} active Process Builder${procBuilders.length > 1 ? 's' : ''} detected`,
        detail: 'Process Builder is deprecated as of Spring \'23. Active Process Builders may conflict with Record-Triggered Flows on the same object and will eventually be retired.',
        rec: 'Migrate all Process Builders to Record-Triggered Flows using the Migration Tool or manually.',
        items: procBuilders.map(f => mkItem(f.MasterLabel, 'process-builder', `v${f.VersionNumber}`))
      });
    }

    // ── Check 7: Active Workflow Rules with no Flow equivalent (INFO) ──
    const wfOnlyObjs = Object.keys(wfByObj).filter(obj => !allFlowsByObj[obj]);
    if (wfOnlyObjs.length > 0) {
      const wfItems = wfOnlyObjs.flatMap(obj => wfByObj[obj].map(w => mkItem(w.Name, 'workflow', obj)));
      issues.push({
        severity: 'info',
        title: `${wfItems.length} active Workflow Rule${wfItems.length > 1 ? 's' : ''} (deprecated)`,
        detail: 'Workflow Rules are deprecated and will be retired. No conflicting Flow was found on the same object, but migration is still recommended.',
        rec: 'Migrate to Record-Triggered Flows before Salesforce retires Workflow Rules.',
        items: wfItems
      });
    }

    // Sort: critical → warning → info
    const order = { critical: 0, warning: 1, info: 2 };
    issues.sort((a, b) => order[a.severity] - order[b.severity]);
    return issues;
  }

  // ── Render results ────────────────────────────────────────
  function renderResults(issues, flows, apexTriggers, wfRules) {
    const el     = document.getElementById('csResults');
    const barEl  = document.getElementById('csSummaryBar');
    if (!el) return;

    const critical = issues.filter(i => i.severity === 'critical').length;
    const warnings = issues.filter(i => i.severity === 'warning').length;
    const infos    = issues.filter(i => i.severity === 'info').length;

    const ICONS = { flow: '⚡', apex: '🧑‍💻', workflow: '🔁', 'process-builder': '🔧' };
    const SEV   = { critical: '🔴', warning: '🟡', info: '🔵' };

    // ── Summary bar (pinned, outside scroll area) ────────────
    if (barEl) {
      barEl.innerHTML = `
        <div class="cs-summary-bar">
          ${critical > 0 ? `<span class="cs-pill cs-pill-critical">🔴 ${critical} Critical</span>` : ''}
          ${warnings > 0 ? `<span class="cs-pill cs-pill-warning">🟡 ${warnings} Warning${warnings !== 1 ? 's' : ''}</span>` : ''}
          ${infos    > 0 ? `<span class="cs-pill cs-pill-info">🔵 ${infos} Info</span>` : ''}
          <span class="cs-scan-meta">
            ${flows.length} flows · ${apexTriggers.length} Apex · ${wfRules.length} WF rules
          </span>
        </div>`;
      barEl.style.display = '';
    }

    // ── Issue cards (scrollable area) ────────────────────────
    if (issues.length === 0) {
      el.innerHTML = `
        <div class="cs-clean">
          <div class="cs-clean-icon">✅</div>
          <div class="cs-clean-msg">No conflicts detected</div>
          <div class="cs-clean-sub">All scanned automations appear conflict-free.</div>
        </div>`;
    } else {
      let html = '';
      for (const issue of issues) {
        html += `
          <div class="cs-issue cs-issue-${issue.severity}">
            <div class="cs-issue-title">
              <span class="cs-sev-icon">${SEV[issue.severity]}</span>
              <strong>${esc(issue.title)}</strong>
            </div>
            <div class="cs-issue-detail">${esc(issue.detail)}</div>
            <div class="cs-issue-rec">💡 ${esc(issue.rec)}</div>
            <div class="cs-issue-items">
              ${issue.items.map(it => `
                <div class="cs-item">
                  <span class="cs-item-icon">${ICONS[it.type] || '⚡'}</span>
                  <span class="cs-item-label">${esc(it.label)}</span>
                  <span class="cs-item-sub">${esc(it.sub)}</span>
                </div>`).join('')}
            </div>
          </div>`;
      }
      el.innerHTML = html;
    }
  }

  function renderError(msg) {
    const el = document.getElementById('csResults');
    if (el) el.innerHTML = `<div class="error-banner">${esc(msg)}</div>`;
    const barEl = document.getElementById('csSummaryBar');
    if (barEl) { barEl.innerHTML = ''; barEl.style.display = 'none'; }
    setProgress(false);
  }

  // ── Helpers ──────────────────────────────────────────────
  function mkItem(label, type, sub) { return { label, type, sub }; }

  function apexEvents(t) {
    const ev = [];
    if (t.UsageBeforeInsert) ev.push('before insert');
    if (t.UsageAfterInsert)  ev.push('after insert');
    if (t.UsageBeforeUpdate) ev.push('before update');
    if (t.UsageAfterUpdate)  ev.push('after update');
    if (t.UsageBeforeDelete) ev.push('before delete');
    if (t.UsageAfterDelete)  ev.push('after delete');
    return ev.join(', ') || 'Apex Trigger';
  }

  function fmtTrigger(tt) {
    switch (tt) {
      case 'RecordBeforeSave': return 'Before Save';
      case 'RecordAfterSave':  return 'After Save';
      case 'Scheduled':        return 'Scheduled';
      default:                 return tt || 'Flow';
    }
  }

  function setProgress(show, text) {
    const el = document.getElementById('csScanProgress');
    if (!el) return;
    el.style.display = show ? '' : 'none';
    if (text) {
      const t = document.getElementById('csScanProgressText');
      if (t) t.textContent = text;
    }
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

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
    // ── Debug logging ────────────────────────────────────────
    if (window.SFToolkitDebug?.enabled) {
      const dur = _t !== null ? Date.now() - _t : null;
      const tag = msg.query?.substring(0, 80) || msg.path || msg.sobject || '';
      window.SFToolkitDebug.log('conflicts',
        resp?.error === 'SESSION_EXPIRED' ? 'session' : resp?.error ? 'error' : 'api',
        `${msg.type}${tag ? '  ' + tag : ''}`, resp?.error || null, dur);
    }
    if (resp?.error !== 'SESSION_EXPIRED') return resp;
    const fresh = await bgRaw({ type: 'GET_SF_SESSION', activeTabUrl: _orgUrl });
    if (fresh?.sid && fresh?.orgUrl) {
      _orgUrl = fresh.orgUrl;
      _sid    = fresh.sid;
      const retry = msg.sid !== undefined
        ? { ...msg, orgUrl: fresh.orgUrl, sid: fresh.sid }
        : msg;
      return bgRaw(retry);
    }
    return resp;
  }

  return { init, updateSession };
})();
