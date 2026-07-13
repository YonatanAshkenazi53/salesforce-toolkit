'use strict';
// ════════════════════════════════════════════════════════════════
// MOUNTED TOOLS (Phase X — app-shell convergence)
// ════════════════════════════════════════════════════════════════
// The heavyweight popup modules (Apex Debugger, Flow Access, Copy
// Permissions, Field Cleaner) are self-contained IIFEs exposing
// init(container, orgUrl, sid) + updateSession. They were built for the
// ~600px popup but are container-based, and studio.html already loads
// styles.css (their CSS) alongside studio.css — so they mount cleanly in the
// full-width Data Studio shell with no fork. This file is the host: it picks
// an org, gives the tool a container, and calls init once.
//
// Pattern (reused per tool): a shared org picker at the top (the tool is
// single-org), then the module renders into #dsToolMount. Switching org calls
// updateSession + re-init so the tool refetches against the new org.

let _toolOrgUrl = '';   // currently-mounted org (URL)

// Generic mount host. `spec` = { key, title, subtitle, module, initFn, banner }.
async function _mountTool(spec) {
  const orgs = allMapOrgs();
  if (!_toolOrgUrl) _toolOrgUrl = _workingPair.src || _orgUrl || (orgs[0] && orgs[0].url) || '';
  const orgOptions = orgs.map(o =>
    `<option value="${esc(o.url)}" ${_orgKey(o.url) === _orgKey(_toolOrgUrl) ? 'selected' : ''}>${esc(orgOptionLabel(o.url, o.label))}</option>`).join('');

  setMain(`
    <div class="ds-view-header">
      <div class="ds-view-title-wrap">
        <h2 class="ds-view-title">${spec.title}</h2>
        <div class="ds-view-subtitle">${esc(spec.subtitle)}</div>
      </div>
      <div class="ds-tool-orgpick">
        <span class="ds-lbl">Org</span>
        <select id="dsToolOrg" class="ds-select ds-select-sm">${orgOptions || '<option value="">No orgs known</option>'}</select>
        ${prodBadge(_toolOrgUrl)}
      </div>
    </div>
    ${spec.banner || ''}
    <div id="dsToolMount" class="ds-tool-mount"></div>`);

  eid('dsToolOrg')?.addEventListener('change', e => {
    _toolOrgUrl = e.target.value;
    _mountTool(spec);   // re-mount against the new org
  });

  const mount = eid('dsToolMount');
  if (!mount) return;

  if (!_toolOrgUrl) {
    mount.innerHTML = `<div class="ds-seq-empty">No org selected. Open a Salesforce org in Chrome, then pick it above.</div>`;
    return;
  }
  mount.innerHTML = `<div class="ds-init-loading">${window.sftkCat ? sftkCat('Connecting to the org…') : 'Loading…'}</div>`;

  const sess = await getOrgSession(_toolOrgUrl);
  if (!sess) {
    mount.innerHTML = `<div class="ds-seq-empty">${esc(orgLabel(_toolOrgUrl))} isn't open in a Chrome tab — open it, then re-pick it above.</div>`;
    return;
  }
  // spec.module is the module OBJECT itself (a top-level `const` IIFE — those
  // are NOT window properties in a classic script, so pass the reference, not
  // a name to look up on window).
  const mod = spec.module;
  if (!mod || typeof mod.init !== 'function') {
    mount.innerHTML = `<div class="ds-seq-empty">The ${esc(spec.title)} module isn't loaded.</div>`;
    return;
  }
  try {
    mount.innerHTML = '';
    mod.init(mount, sess.orgUrl, sess.sid);
  } catch (e) {
    const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(e.message) : { message: e.message };
    mount.innerHTML = `<div class="ds-seq-empty" title="${esc(e.message)}">❌ ${esc(fe.message)}</div>`;
  }
}

// X3: Apex Debugger — the pilot migration. Full-width is a real upgrade for
// the log viewer + ANALYSIS panel that the 600px popup cramped.
function renderDebuggerTool() {
  return _mountTool({
    key: 'debugger',
    title: '🐛 Apex Debugger',
    subtitle: 'Trace flows, triggers & governor limits — now with room to read the log',
    module: (typeof ApexDebugger !== 'undefined') ? ApexDebugger : null,
    banner: `<div class="ds-op-banner ds-op-banner-read" style="margin-bottom:14px">
      <span class="ds-op-banner-icon">📖</span>
      <div class="ds-op-banner-body">
        <div class="ds-op-banner-title">Reads ApexLog + manages TraceFlags for the selected org</div>
        <div class="ds-op-banner-desc">Creating a trace and deleting logs are the only writes; everything else is read-only.</div>
      </div>
    </div>`,
  });
}

// The remaining popup tools mount through the identical host — enabling them
// is a nav entry + a one-line render function each (X1/X2/X4). Kept here,
// commented, as the proven recipe; wire them in as each is validated.
// function renderFlowAccessTool()  { return _mountTool({ key:'flow-access', title:'🌊 Flow Access', subtitle:'…', module:'FlowPermissions' }); }
// function renderCopyPermsTool()   { return _mountTool({ key:'copy-perms',  title:'👥 Copy Permissions', subtitle:'…', module:'UserCopy' }); }
