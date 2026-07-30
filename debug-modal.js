// ============================================================
// Salesforce Toolkit — Debug Recorder UI  (shared module)
//
// Loaded by BOTH popup.html and studio.html.
// Depends only on window.SFToolkitDebug (from debug-logger.js).
// Creates its own modal overlay — no dependency on either page's
// modal infrastructure (modalOverlay / dsModal).
// ============================================================
(function () {
  'use strict';

  // ── Internal HTML-escape helper (no external dependency) ──
  function _esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
                          .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Resolve orgUrl from whatever global is available ──────
  function _resolveOrgUrl() {
    // popup.js uses a global `orgUrl`; studio.js exposes window._sftkOrgUrl
    // (its `_orgUrl` is a top-level `let`, invisible here — and the old
    // self-named helper shadowed it anyway, returning the function object).
    return (typeof orgUrl !== 'undefined' && orgUrl) ? orgUrl
         : (window._sftkOrgUrl || null);
  }

  // ============================================================
  // initDebugMode — wire the #dbgBtn button in any page
  // ============================================================
  window.initDebugMode = function () {
    const btn = document.getElementById('dbgBtn');
    const D   = window.SFToolkitDebug;
    if (!btn || !D) return;

    // Load persisted log (async, non-blocking)
    D.loadPersisted();

    // ── Badge refresh ────────────────────────────────────────
    function refreshBtn() {
      const on    = D.enabled;
      const count = D.entries.length;
      btn.classList.toggle('dbg-active', on);
      const hasErrors = D.entries.some(e => e.level === 'error');
      btn.title = on
        ? `Debug mode ON · ${count} entr${count === 1 ? 'y' : 'ies'} — click to view`
        : count > 0
          ? `Debug mode OFF · ${count} persisted entries — click to view`
          : 'Debug mode OFF — click to open';

      // The bug glyph is no longer part of the label: it is a masked
      // ::before painted from #dbgBtn's own rule in styles.css. It had to
      // leave the text because these assignments destroy any child node, so
      // an icon <span> could not survive them — the same reason the Apex
      // Debugger's rewritten buttons carry their glyph as an attribute.
      // Both apps share this button, so both pick the icon up.
      if (on && hasErrors && count > 0) {
        btn.textContent = `${count} ⚠`;
        btn.style.background  = 'rgba(234,0,30,.25)';
        btn.style.borderColor = 'rgba(234,0,30,.5)';
        btn.style.color       = '#FF8888';
      } else if (on && count > 0) {
        btn.textContent = `${count}`;
        btn.style.background = btn.style.borderColor = btn.style.color = '';
      } else {
        btn.textContent = 'Debug';
        btn.style.background = btn.style.borderColor = btn.style.color = '';
      }
    }

    D._cb = refreshBtn;
    refreshBtn();

    btn.addEventListener('click', window.openDebugModal);

    // ── Global error capture ─────────────────────────────────
    window.addEventListener('error', evt => {
      if (!D.enabled) return;
      D.log('app', 'error',
        `Uncaught: ${evt.message}`,
        `${evt.filename?.split('/').pop() || ''}:${evt.lineno}`);
    });
    window.addEventListener('unhandledrejection', evt => {
      if (!D.enabled) return;
      D.log('app', 'error',
        `Unhandled rejection: ${evt.reason?.message || String(evt.reason)}`);
    });

    // ── console.warn / console.error proxy ──────────────────
    const _warn  = console.warn.bind(console);
    const _error = console.error.bind(console);
    console.warn = (...args) => {
      _warn(...args);
      if (D.enabled) D.log('app', 'warn',
        args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ').substring(0, 250));
    };
    console.error = (...args) => {
      _error(...args);
      if (D.enabled) D.log('app', 'error',
        args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ').substring(0, 250));
    };
  };

  // ============================================================
  // openDebugModal — render the debug recorder panel
  // ============================================================
  window.openDebugModal = function () {
    const D = window.SFToolkitDebug;
    if (!D) return;

    // Guard: close any existing panel before reopening
    const existingOverlay = document.getElementById('_dbgModalOverlay');
    if (existingOverlay) { existingOverlay.remove(); }

    let filterMod   = 'all';
    let filterLevel = 'all';
    let filterText  = '';
    let autoScroll  = true;

    // ── Helpers ──────────────────────────────────────────────
    function entryClass(level) {
      switch (level) {
        case 'error':   return 'dbg-entry-error';
        case 'warn':    return 'dbg-entry-warn';
        case 'session': return 'dbg-entry-session';
        case 'api':     return 'dbg-entry-api';
        default:        return 'dbg-entry-info';
      }
    }

    function fmtDur(ms) {
      if (ms === null || ms === undefined) return '';
      const cls = ms >= 5000 ? 'dur-vslow' : ms >= 2000 ? 'dur-slow' : '';
      return `<span class="dbg-e-dur ${cls}">${ms >= 1000 ? (ms/1000).toFixed(1)+'s' : ms+'ms'}</span>`;
    }

    function filteredEntries() {
      return D.entries.filter(e => {
        if (filterMod   !== 'all' && e.mod   !== filterMod)  return false;
        if (filterLevel !== 'all' && e.level !== filterLevel) return false;
        if (filterText) {
          const hay = (e.msg + ' ' + (e.data || '') + ' ' + e.mod).toLowerCase();
          if (!hay.includes(filterText.toLowerCase())) return false;
        }
        return true;
      });
    }

    function getModules() {
      return [...new Set(D.entries.map(e => e.mod))].sort();
    }

    function renderFilterBar() {
      const mods    = getModules();
      const levels  = ['api','error','warn','session','info'];
      const total   = D.entries.length;
      const showing = filteredEntries().length;

      const modPills = ['all', ...mods].map(m =>
        `<button class="dbg-filter-pill${filterMod === m ? ' dbg-pill-active' : ''}"
                 data-modfilter="${_esc(m)}">${m === 'all' ? 'All Mods' : _esc(m)}</button>`
      ).join('');

      const lvlPills = ['all', ...levels].map(l =>
        `<button class="dbg-filter-pill dbg-pill-${l}${filterLevel === l ? ' dbg-pill-active' : ''}"
                 data-lvlfilter="${l}">${l === 'all' ? 'All' : l}</button>`
      ).join('');

      return `
        <div class="dbg-filter-bar" id="dbgFilterBar">
          <div class="dbg-filter-group">${modPills}</div>
          <div class="dbg-filter-group">${lvlPills}</div>
          <input class="dbg-search" id="dbgSearch" placeholder="🔍 Search…"
                 value="${_esc(filterText)}" autocomplete="off">
          <span class="dbg-filter-count">${showing === total ? total : `${showing} / ${total}`}</span>
        </div>`;
    }

    function renderEntries() {
      const entries = filteredEntries();
      if (!entries.length) {
        const reason = D.entries.length === 0
          ? 'No entries yet.<br><small>Click <strong>▶ Start</strong> to begin recording, then reproduce the issue.</small>'
          : 'No entries match the current filter.';
        return `<div class="dbg-no-entries">${reason}</div>`;
      }
      return entries.map(e => {
        const t   = new Date(e.t).toTimeString().substring(0, 8);
        const cls = entryClass(e.level);
        const dur = fmtDur(e.dur);
        const data = e.data
          ? `<span class="dbg-e-data">↳ ${_esc(e.data)}</span>` : '';
        return `<div class="dbg-entry ${cls}">
          <span class="dbg-e-time">${t}</span>
          <span class="dbg-e-mod">${_esc(e.mod)}</span>
          <span class="dbg-e-lvl">${_esc(e.level)}</span>
          <span class="dbg-e-msg">${_esc(e.msg)}${dur}</span>
          ${data}
        </div>`;
      }).join('');
    }

    function buildHtml() {
      const on = D.enabled;
      const n  = D.entries.length;
      return `
        <div class="dbg-panel">
          <div class="dbg-modal-hdr">
            <span class="dbg-modal-title">🐛 Debug Recorder</span>
            <button id="dbgCloseBtn" class="btn btn-sm btn-secondary">✕ Close</button>
          </div>
          <div class="dbg-modal-actions">
            <button id="dbgToggleBtn" class="btn btn-sm ${on ? 'btn-danger' : 'btn-success'}">
              ${on ? '⏹ Stop' : '▶ Start'}
            </button>
            <button id="dbgClearBtn" class="btn btn-sm btn-secondary" ${n ? '' : 'disabled'}>
              🗑 Clear
            </button>
            <label class="dbg-persist-label" title="Keep log across popup close/reopen">
              <input type="checkbox" id="dbgPersistCb" ${D.persisted ? 'checked' : ''}>
              Persist log
            </label>
          </div>
          <div class="dbg-status-bar ${on ? 'dbg-status-on' : 'dbg-status-off'}" id="dbgStatusBar">
            <span class="dbg-status-dot">${on ? '●' : '○'}</span>
            ${on
              ? 'Recording — use the extension, then <strong>Copy</strong> or share the log.'
              : 'Recording is stopped. Click <strong>▶ Start</strong> to capture API calls and errors.'}
            ${D.persisted ? '<span class="dbg-persist-badge">💾 persisted</span>' : ''}
          </div>
          <div id="dbgFilterOuter">${renderFilterBar()}</div>
          <div class="dbg-entries-wrap" id="dbgEntriesWrap">
            ${renderEntries()}
          </div>
          <div class="dbg-footer">
            <button id="dbgCopyTextBtn" class="btn btn-primary btn-sm" ${n ? '' : 'disabled'}>
              📋 Copy Text
            </button>
            <button id="dbgCopyJsonBtn" class="btn btn-secondary btn-sm" ${n ? '' : 'disabled'}>
              { } Copy JSON
            </button>
            <label class="dbg-autoscroll-label" title="Auto-scroll to newest entries">
              <input type="checkbox" id="dbgAutoScrollCb" ${autoScroll ? 'checked' : ''}> Live tail
            </label>
            <span class="dbg-entry-count" id="dbgEntryCount">${n} entr${n === 1 ? 'y' : 'ies'}</span>
          </div>
        </div>`;
    }

    // ── Create a self-contained overlay (works on any page) ──
    const overlay = document.createElement('div');
    overlay.id = '_dbgModalOverlay';
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;' +
      'display:flex;align-items:center;justify-content:center';

    const box = document.createElement('div');
    // Make the debug modal big enough to actually read multi-second runs
    // without scrolling 50 times. Width fits the typical 1080–1440 column on
    // a 24″+ monitor; height eats most of the viewport.
    box.style.cssText =
      'width:min(1200px,94vw);' +
      'height:min(860px,90vh);' +
      'display:flex;flex-direction:column;' +
      'overflow:hidden;border-radius:12px;background:var(--card,#fff);';
    box.innerHTML = buildHtml();

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Click outside → close
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    // ── Live-update helpers ───────────────────────────────────
    function refreshEntries() {
      const wrap = document.getElementById('dbgEntriesWrap');
      if (wrap) {
        wrap.innerHTML = renderEntries();
        if (autoScroll) wrap.scrollTop = wrap.scrollHeight;
      }
      refreshFilterBar();
      refreshFooter();
    }

    function refreshFilterBar() {
      const outer = document.getElementById('dbgFilterOuter');
      if (outer) { outer.innerHTML = renderFilterBar(); wireFilterBar(); }
    }

    function refreshFooter() {
      const n     = D.entries.length;
      const count = document.getElementById('dbgEntryCount');
      const clear = document.getElementById('dbgClearBtn');
      const copyT = document.getElementById('dbgCopyTextBtn');
      const copyJ = document.getElementById('dbgCopyJsonBtn');
      if (count) count.textContent = `${n} entr${n === 1 ? 'y' : 'ies'}`;
      if (clear) clear.disabled = n === 0;
      if (copyT) copyT.disabled = n === 0;
      if (copyJ) copyJ.disabled = n === 0;
    }

    function refreshStatus() {
      const bar = document.getElementById('dbgStatusBar');
      const tog = document.getElementById('dbgToggleBtn');
      const on  = D.enabled;
      if (bar) {
        bar.className = `dbg-status-bar ${on ? 'dbg-status-on' : 'dbg-status-off'}`;
        bar.innerHTML = `<span class="dbg-status-dot">${on ? '●' : '○'}</span>
          ${on
            ? 'Recording — use the extension, then <strong>Copy</strong> or share the log.'
            : 'Recording is stopped. Click <strong>▶ Start</strong> to capture API calls and errors.'}
          ${D.persisted ? '<span class="dbg-persist-badge">💾 persisted</span>' : ''}`;
      }
      if (tog) {
        tog.textContent = on ? '⏹ Stop' : '▶ Start';
        tog.className   = `btn btn-sm ${on ? 'btn-danger' : 'btn-success'}`;
      }
    }

    function updatePanel() { refreshStatus(); refreshEntries(); }

    function wireFilterBar() {
      document.querySelectorAll('[data-modfilter]').forEach(b => {
        b.addEventListener('click', () => { filterMod = b.dataset.modfilter; refreshEntries(); });
      });
      document.querySelectorAll('[data-lvlfilter]').forEach(b => {
        b.addEventListener('click', () => { filterLevel = b.dataset.lvlfilter; refreshEntries(); });
      });
      const search = document.getElementById('dbgSearch');
      if (search) search.addEventListener('input', () => { filterText = search.value; refreshEntries(); });
    }
    wireFilterBar();

    // ── Control buttons ───────────────────────────────────────
    document.getElementById('dbgToggleBtn').addEventListener('click', () => {
      D.toggle();
      if (D.enabled) {
        const ou = _resolveOrgUrl();
        let ver = '?';
        try { ver = chrome.runtime.getManifest().version; } catch (_) {}
        D.log('app', 'session', `Recording started · Org: ${ou || 'unknown'} · v${ver}`);
      }
      refreshStatus();
      refreshEntries();
    });

    document.getElementById('dbgClearBtn').addEventListener('click', () => {
      D.clear(); updatePanel();
    });

    document.getElementById('dbgPersistCb').addEventListener('change', e => {
      if (e.target.checked) D.enablePersist();
      else D.disablePersist();
      refreshStatus();
    });

    document.getElementById('dbgAutoScrollCb').addEventListener('change', e => {
      autoScroll = e.target.checked;
    });

    async function copyToClipboard(text, btn) {
      try { await navigator.clipboard.writeText(text); }
      catch (_) {
        const ta = Object.assign(document.createElement('textarea'), { value: text });
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      }
      const orig = btn.textContent;
      btn.textContent = '✅ Copied!';
      setTimeout(() => { btn.textContent = orig; }, 2200);
    }

    document.getElementById('dbgCopyTextBtn').addEventListener('click', () => {
      copyToClipboard(D.toText(_resolveOrgUrl()), document.getElementById('dbgCopyTextBtn'));
    });
    document.getElementById('dbgCopyJsonBtn').addEventListener('click', () => {
      copyToClipboard(D.toJson(_resolveOrgUrl()), document.getElementById('dbgCopyJsonBtn'));
    });

    // ── Close ─────────────────────────────────────────────────
    const prevCb = D._cb;
    D._cb = () => { if (prevCb) prevCb(); updatePanel(); };

    function close() {
      D._cb = prevCb;
      overlay.remove();
    }
    document.getElementById('dbgCloseBtn').addEventListener('click', close);
  };

})();
