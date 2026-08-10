// ============================================================
// Standalone Apex Log Viewer (new-tab fullscreen)
//
// Loads from chrome.storage.local under a one-shot key passed in the
// URL (?key=...). Renders the same chunked log viewer + Notepad++-style
// search / filter / goto experience the popup uses, but with the whole
// browser viewport.
//
// The popup's apex-debugger.js stashes:
//   { raw, report, fileName, meta: {Id, Operation, StartTime, LogLength,
//     DurationMilliseconds, Status, LogUser } }
// We read it, render, then delete the key so storage doesn't grow.
// ============================================================
(() => {
  'use strict';

  const LOG_CHUNK  = 700;
  const FILTER_CAP = 4000;
  const SEARCH_CAP = 5000;

  let _state    = null;     // { lines, shown, filter }
  let _payload  = null;     // raw stash from storage
  let _search   = null;     // { matches, idx, opts }

  // ── HTML escape ─────────────────────────────────────────
  // '=' → &#61; (renders identically): the page-wide Trusted Types sanitizer
  // strips inline-handler-shaped patterns (" onclick=…"), which can match
  // inside raw LOG TEXT and silently delete it — every strip pattern needs a
  // literal '='. Same fix as apex-debugger.js sftkEscLogLine.
  const _esc = s => String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/=/g,'&#61;');

  // ── Per-line CSS class (matches apex-debugger.js _logLineClass) ──
  function _logLineClass(line) {
    const i = line.indexOf('|');
    if (i === -1) return 'adbg-ll-dim';
    const rest = line.slice(i + 1);
    const j    = rest.indexOf('|');
    const ev   = j === -1 ? rest : rest.slice(0, j);
    if (/EXCEPTION|FATAL_ERROR|_FAULT|_ERROR\b/.test(ev))                              return 'adbg-ll-err';
    if (/^FLOW_|^PROCESS_|^WF_/.test(ev))                                              return 'adbg-ll-flow';
    if (/^SOQL_|^SOSL_|^DML_/.test(ev))                                                return 'adbg-ll-data';
    if (/^CODE_UNIT_|^METHOD_|^CONSTRUCTOR_|^SYSTEM_METHOD/.test(ev))                  return 'adbg-ll-code';
    if (ev === 'USER_DEBUG')                                                           return 'adbg-ll-debug';
    if (/LIMIT_USAGE|CUMULATIVE_|HEAP_|STATEMENT_EXECUTE|VARIABLE_|SYSTEM_/.test(ev))  return 'adbg-ll-dim';
    return '';
  }

  // DML op pill — same treatment as the inline panel (apex-debugger.js
  // _logDmlOp); this page advertises "the same controls", so a log must not
  // lose its pills the moment the user pops it out.
  function _logDmlOp(line) {
    const i = line.indexOf('|');
    if (i === -1) return null;
    const rest = line.slice(i + 1);
    const j = rest.indexOf('|');
    if (j === -1 || rest.slice(0, j) !== 'DML_BEGIN') return null;
    const m = rest.slice(j).match(/\|Op:([A-Za-z]+)/);
    return m ? m[1].toUpperCase() : null;
  }

  function _oneLogLine(ln, i) {
    const cls = _logLineClass(ln);
    const op  = _logDmlOp(ln);
    return `<div class="adbg-log-line${cls ? ' ' + cls : ''}" data-ln="${i}">` +
           `<span class="adbg-ln-num">${i + 1}</span>` +
           `<span class="adbg-ln-txt">${op ? `<span class="adbg-op adbg-op-${op.toLowerCase()}" title="DML operation">${op}</span>` : ''}${_esc(ln) || '&nbsp;'}</span></div>`;
  }

  function _logLinesHtml(lines, from, to) {
    let html = '';
    const end = Math.min(to, lines.length);
    for (let i = from; i < end; i++) html += _oneLogLine(lines[i], i);
    return html;
  }

  function _logMoreBar(shown, total) {
    return `<div class="adbg-log-more" id="alvLogMore">` +
           `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} lines — scroll to load more` +
           `</div>`;
  }

  // ── Initial render ──────────────────────────────────────
  function _renderInitial(raw) {
    const view = document.getElementById('alvLogView');
    if (!raw) { view.innerHTML = '<div class="adbg-detail-none">Log body is empty.</div>'; _state = null; return; }
    const lines = raw.split('\n');
    const shown = Math.min(LOG_CHUNK, lines.length);
    _state = { lines, shown, filter: '' };
    let html = _logLinesHtml(lines, 0, shown);
    if (lines.length > shown) html += _logMoreBar(shown, lines.length);
    view.innerHTML = html;
  }

  function _appendChunk() {
    const st = _state, view = document.getElementById('alvLogView');
    if (!st || !view || st.filter) return;
    if (st.shown >= st.lines.length) return;
    const next   = Math.min(st.shown + LOG_CHUNK, st.lines.length);
    const moreEl = document.getElementById('alvLogMore');
    const html   = _logLinesHtml(st.lines, st.shown, next);
    if (moreEl) moreEl.insertAdjacentHTML('beforebegin', html);
    else        view.insertAdjacentHTML('beforeend', html);
    st.shown = next;
    if (moreEl) {
      if (st.shown >= st.lines.length) moreEl.remove();
      else moreEl.textContent =
        `Showing ${st.shown.toLocaleString()} of ${st.lines.length.toLocaleString()} lines — scroll to load more`;
    }
  }

  // ── Filter (substring) ──────────────────────────────────
  function _filter(q) {
    const st = _state, view = document.getElementById('alvLogView');
    if (!st || !view) return;
    st.filter = q;
    view.scrollTop = 0;
    if (!q) {
      st.shown = Math.min(LOG_CHUNK, st.lines.length);
      let html = _logLinesHtml(st.lines, 0, st.shown);
      if (st.lines.length > st.shown) html += _logMoreBar(st.shown, st.lines.length);
      view.innerHTML = html;
      return;
    }
    const ql = q.toLowerCase();
    let html = '', matches = 0;
    for (let i = 0; i < st.lines.length && matches < FILTER_CAP; i++) {
      if (st.lines[i].toLowerCase().includes(ql)) {
        html += _oneLogLine(st.lines[i], i);
        matches++;
      }
    }
    if (!html) {
      view.innerHTML = '<div class="adbg-log-empty-filter">No lines match the filter.</div>';
      return;
    }
    if (matches >= FILTER_CAP) {
      html += `<div class="adbg-log-more">First ${FILTER_CAP.toLocaleString()} matches shown — narrow your filter.</div>`;
    }
    view.innerHTML = html;
  }

  // ── Goto line ───────────────────────────────────────────
  function _goto(lineNum) {
    const st = _state, view = document.getElementById('alvLogView');
    if (!st || !view) return;
    const idx = Math.max(0, Math.min(st.lines.length - 1, (parseInt(lineNum, 10) || 1) - 1));
    if (st.filter) {
      document.getElementById('alvLogFilter').value = '';
      _filter('');
    }
    let guard = 0;
    while (st.shown <= idx && st.shown < st.lines.length && guard++ < 10000) _appendChunk();
    const el = view.querySelector(`.adbg-log-line[data-ln="${idx}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('adbg-log-line-hl');
      setTimeout(() => el.classList.remove('adbg-log-line-hl'), 1800);
    }
  }

  // ── Find-in-log (Notepad++ style) ───────────────────────
  function _runSearch(opts) {
    const st = _state, view = document.getElementById('alvLogView');
    const cntE = document.getElementById('alvLogSearchCount');
    if (!st || !view) return;

    // Clear old highlights
    view.querySelectorAll('.adbg-log-search-hit').forEach(el => {
      const t = document.createTextNode(el.textContent);
      el.parentNode?.replaceChild(t, el);
    });
    view.querySelectorAll('.adbg-log-line-search-cur').forEach(el =>
      el.classList.remove('adbg-log-line-search-cur'));

    if (!opts.query) {
      _search = null;
      if (cntE) cntE.textContent = '—';
      return;
    }
    let re;
    try {
      let pat = opts.query;
      if (!opts.regex)    pat = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (opts.wholeWord) pat = `\\b(?:${pat})\\b`;
      re = new RegExp(pat, opts.caseSensitive ? 'g' : 'gi');
    } catch (err) {
      if (cntE) { cntE.textContent = 'regex err'; cntE.title = err.message; }
      return;
    }
    const matches = [];
    for (let i = 0; i < st.lines.length && matches.length < SEARCH_CAP; i++) {
      const line = st.lines[i];
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        matches.push({ ln: i, start: m.index, end: m.index + m[0].length });
        if (m[0].length === 0) re.lastIndex++;
        if (matches.length >= SEARCH_CAP) break;
      }
    }
    _search = { matches, idx: 0, opts };
    if (cntE) cntE.textContent = matches.length ? `1 / ${matches.length}` : '0 matches';
    _paintHighlights();
    if (matches.length) _stepMatch(0);
  }

  function _paintHighlights() {
    const view = document.getElementById('alvLogView');
    const st = _search;
    if (!view || !st || !st.matches.length) return;
    const byLine = new Map();
    for (const m of st.matches) {
      if (!byLine.has(m.ln)) byLine.set(m.ln, []);
      byLine.get(m.ln).push(m);
    }
    for (const [ln, ms] of byLine) {
      const lineEl = view.querySelector(`.adbg-log-line[data-ln="${ln}"] .adbg-ln-txt`);
      if (!lineEl) continue;
      // Offsets were computed against the RAW line — DOM text carries the
      // DML pill prefix, which would shift offsets and lose the pill on
      // rebuild (same fix as the inline panel, QA sweep 2026-08-10).
      const pill = lineEl.querySelector('.adbg-op');
      const text = (_state && _state.lines[ln] != null) ? _state.lines[ln] : lineEl.textContent;
      const frag = document.createDocumentFragment();
      let cursor = 0;
      const sorted = [...ms].sort((a, b) => a.start - b.start);
      for (const m of sorted) {
        if (m.start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, m.start)));
        const span = document.createElement('span');
        span.className = 'adbg-log-search-hit';
        span.textContent = text.slice(m.start, m.end);
        frag.appendChild(span);
        cursor = m.end;
      }
      if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
      lineEl.innerHTML = '';
      if (pill) lineEl.appendChild(pill);
      lineEl.appendChild(frag);
    }
  }

  function _stepMatch(delta) {
    const view = document.getElementById('alvLogView');
    const st = _search;
    const cntE = document.getElementById('alvLogSearchCount');
    if (!view || !st || !st.matches.length) return;
    st.idx = ((st.idx + delta) % st.matches.length + st.matches.length) % st.matches.length;
    const m = st.matches[st.idx];
    let guard = 0;
    while (_state && _state.shown <= m.ln && _state.shown < _state.lines.length && guard++ < 10000) _appendChunk();
    _paintHighlights();
    view.querySelectorAll('.adbg-log-line-search-cur').forEach(el =>
      el.classList.remove('adbg-log-line-search-cur'));
    const lineEl = view.querySelector(`.adbg-log-line[data-ln="${m.ln}"]`);
    if (lineEl) {
      lineEl.classList.add('adbg-log-line-search-cur');
      lineEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    if (cntE) cntE.textContent = `${st.idx + 1} / ${st.matches.length}`;
  }

  // ── Header / actions ────────────────────────────────────
  function _renderHeader(p) {
    const meta = p.meta || {};
    const titleEl = document.getElementById('alvTitle');
    const metaEl  = document.getElementById('alvMeta');
    const op = meta.Operation || meta.Request || meta.Application || 'Apex Log';
    titleEl.textContent = op;
    document.title = `${op} — Apex Log`;

    const parts = [];
    if (meta.StartTime)            parts.push(new Date(meta.StartTime).toLocaleString());
    if (meta.LogLength != null)    parts.push((meta.LogLength / 1024).toFixed(1) + ' KB');
    if (meta.DurationMilliseconds != null) {
      parts.push(meta.DurationMilliseconds >= 1000
        ? (meta.DurationMilliseconds / 1000).toFixed(2) + 's'
        : meta.DurationMilliseconds + 'ms');
    }
    if (meta.Status && meta.Status !== 'Success') parts.push(meta.Status);
    if (meta.LogUser?.Name)        parts.push('User: ' + meta.LogUser.Name);
    metaEl.innerHTML = parts.map(s => `<span>${_esc(s)}</span>`).join('');
  }

  function _bindActions(p) {
    document.getElementById('alvCopyReportBtn')?.addEventListener('click', async e => {
      // Capture the button BEFORE awaiting — e.currentTarget is nulled once
      // event dispatch completes, so reading it after the await threw and the
      // catch turned every SUCCESSFUL copy into a "Copy failed" alert.
      const btn = e.currentTarget;
      try {
        await navigator.clipboard.writeText(p.report || '');
        const orig = btn.textContent;
        btn.dataset.adbgIcon = 'check';
        btn.textContent = 'Copied';
        setTimeout(() => {
          btn.dataset.adbgIcon = 'copy';
          btn.textContent = orig;
        }, 1400);
      } catch {
        alert('Copy failed. Use Download Report instead.');
      }
    });
    document.getElementById('alvDlReportBtn')?.addEventListener('click', () => {
      const fname = (p.fileName || 'apex-log') + '.report.md';
      _download(fname, p.report || '', 'text/markdown');
    });
    document.getElementById('alvDlRawBtn')?.addEventListener('click', () => {
      const fname = (p.fileName || 'apex-log') + '.log';
      _download(fname, p.raw || '', 'text/plain');
    });
  }

  function _download(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  // ── Wire search/filter/goto controls ────────────────────
  function _bindControls() {
    const view = document.getElementById('alvLogView');
    view.addEventListener('scroll', () => {
      if (view.scrollTop + view.clientHeight >= view.scrollHeight - 240) _appendChunk();
    });

    let ft = null;
    const fi = document.getElementById('alvLogFilter');
    fi.addEventListener('input', () => {
      clearTimeout(ft);
      ft = setTimeout(() => _filter(fi.value.trim()), 160);
    });

    const gt = document.getElementById('alvLogGoto');
    gt.addEventListener('keydown', e => { if (e.key === 'Enter') _goto(gt.value); });
    gt.addEventListener('change', () => _goto(gt.value));

    const sInp   = document.getElementById('alvLogSearch');
    const sCase  = document.getElementById('alvLogCase');
    const sRegex = document.getElementById('alvLogRegex');
    const sWord  = document.getElementById('alvLogWord');
    const sPrev  = document.getElementById('alvLogSearchPrev');
    const sNext  = document.getElementById('alvLogSearchNext');
    let st = null;
    const run = () => {
      clearTimeout(st);
      st = setTimeout(() => _runSearch({
        query: sInp.value,
        caseSensitive: !!sCase.checked,
        regex:         !!sRegex.checked,
        wholeWord:     !!sWord.checked,
      }), 140);
    };
    sInp.addEventListener('input', run);
    [sCase, sRegex, sWord].forEach(el => el.addEventListener('change', run));
    sInp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); _stepMatch(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { sInp.value = ''; _runSearch({ query: '' }); }
    });
    sPrev.addEventListener('click', () => _stepMatch(-1));
    sNext.addEventListener('click', () => _stepMatch(1));

    // Ctrl+F focuses search
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        sInp.focus(); sInp.select();
      }
    });

    // Font-size controls (shares the same localStorage key as the popup
    // debugger so the user's preferred size is consistent across both).
    document.getElementById('alvFontDown') ?.addEventListener('click', () => _bumpFont(-1));
    document.getElementById('alvFontUp')   ?.addEventListener('click', () => _bumpFont(+1));
    document.getElementById('alvFontReset')?.addEventListener('click', () => _bumpFont(0));
  }

  // ── Log font-size (mirrors apex-debugger.js) ────────────
  const FONT_MIN = 9, FONT_MAX = 26, FONT_DEFAULT = 12, FONT_KEY = 'adbg_log_font_px';
  function _getFont() {
    const v = parseInt(localStorage.getItem(FONT_KEY), 10);
    return (v >= FONT_MIN && v <= FONT_MAX) ? v : FONT_DEFAULT;
  }
  function _applyFont(px) {
    const size = px != null ? px : _getFont();
    const view = document.getElementById('alvLogView');
    if (view) { view.style.fontSize = size + 'px'; view.style.lineHeight = (size + 6) + 'px'; }
  }
  function _bumpFont(delta) {
    const next = delta === 0
      ? FONT_DEFAULT
      : Math.max(FONT_MIN, Math.min(FONT_MAX, _getFont() + delta));
    localStorage.setItem(FONT_KEY, String(next));
    _applyFont(next);
  }

  // ── Boot ────────────────────────────────────────────────
  async function boot() {
    // Honor the Toolkit's persisted theme (shared styles.css palette) —
    // including OLED: one toolkit-wide preference, and this page must not be
    // the lone gray-dark surface in an otherwise pure-black toolkit.
    try {
      const d = await chrome.storage.local.get(['sftk_dark', 'sftk_oled']);
      if (d?.sftk_dark) {
        document.body.classList.add('sftk-dark');
        if (d?.sftk_oled) document.body.classList.add('sftk-oled');
      }
    } catch (_) {}
    const params = new URLSearchParams(location.search);
    const key = params.get('key');
    if (!key) {
      document.getElementById('alvLogView').innerHTML =
        '<div class="adbg-detail-none">No log key in URL. Open this viewer from the Apex Debugger.</div>';
      return;
    }
    const storeKey = 'apex_log_viewer_' + key;
    let payload = null;
    try {
      const r = await chrome.storage.local.get(storeKey);
      payload = r[storeKey];
    } catch (err) {
      document.getElementById('alvLogView').innerHTML =
        `<div class="adbg-detail-none">Failed to load log: ${_esc(err.message)}</div>`;
      return;
    }
    if (!payload) {
      document.getElementById('alvLogView').innerHTML =
        '<div class="adbg-detail-none">Log not found — the entry expired or was already consumed. Reopen from the Apex Debugger.</div>';
      return;
    }
    _payload = payload;
    _renderHeader(payload);
    _bindActions(payload);
    _bindControls();
    _renderInitial(payload.raw || '');
    _applyFont();   // restore the user's preferred log text size

    // One-shot: delete the storage key so we don't leak data across sessions.
    try { await chrome.storage.local.remove(storeKey); } catch {}

    // Autofocus search
    setTimeout(() => document.getElementById('alvLogSearch')?.focus(), 50);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
