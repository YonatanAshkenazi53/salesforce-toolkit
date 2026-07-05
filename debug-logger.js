// ============================================================
// Salesforce Toolkit — Advanced Debug Logger  v2
// Loaded FIRST in popup.html so every module can call
// window.SFToolkitDebug before popup.js finishes initialising.
//
// Features:
//   • Per-entry timing (duration in ms for API calls)
//   • Persistence across popup close/reopen via chrome.storage.session
//   • toJson() for structured machine-readable export
//   • startTimer() / logTimed() helpers
//   • Module + level tags for UI filtering
//   • onChange callback (_cb) to live-update the header badge
// ============================================================
(function () {
  'use strict';

  const MAX_ENTRIES  = 1000;
  const ENABLED_KEY  = 'sftk_debug_enabled';
  const PERSIST_KEY  = 'sftk_debug_entries';
  const PERSIST_META = 'sftk_debug_meta';   // { orgUrl, startedAt }

  // ── Helpers ────────────────────────────────────────────────
  function safeStr(v, limit) {
    if (v === undefined || v === null) return null;
    if (typeof v === 'string') return v.substring(0, limit);
    try   { return JSON.stringify(v).substring(0, limit); }
    catch (_) { return String(v).substring(0, limit); }
  }

  // ── Secret redaction ───────────────────────────────────────
  // Every log entry passes through _redact() so session IDs, passwords,
  // tokens, and auth headers can never reach storage or an export — no
  // matter what a calling module passes in.
  const _SECRET_RE = [
    // Salesforce session IDs:  00D<orgid>!<token>
    [/\b00D[A-Za-z0-9]{11,18}![A-Za-z0-9._=+/-]+/g, '00D…[redacted-sid]'],
    // OAuth / Bearer tokens
    [/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]'],
    // key:value / key=value where the key is sensitive — keep key, drop value
    [/(["']?(?:sid|session[_-]?id|password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|authorization|api[_-]?key)["']?\s*[:=]\s*["']?)([^"',}\s|&]+)/gi,
     '$1[redacted]'],
  ];
  function _redact(s) {
    if (s == null) return s;
    let out = String(s);
    for (let i = 0; i < _SECRET_RE.length; i++) {
      out = out.replace(_SECRET_RE[i][0], _SECRET_RE[i][1]);
    }
    return out;
  }

  function extVer() {
    try { return chrome.runtime.getManifest().version; } catch (_) { return '?'; }
  }

  // ── Core object ────────────────────────────────────────────
  const D = {
    // ── State ───────────────────────────────────────────────
    enabled:   localStorage.getItem(ENABLED_KEY) === '1',
    entries:   [],
    persisted: false,   // true while we are writing to storage
    _cb:       null,    // header-badge refresh callback

    // ── Primary API: log an entry ──────────────────────────
    /**
     * @param {string} module  e.g. 'flows' | 'pages' | 'users' | 'app'
     * @param {string} level   'api' | 'error' | 'warn' | 'session' | 'info'
     * @param {string} msg     Human-readable summary (≤300 chars)
     * @param {*}      [data]  Extra detail — stringified, ≤600 chars
     * @param {number} [dur]   Duration in ms (for API calls)
     */
    log(module, level, msg, data, dur) {
      const entry = {
        id:    ++_seq,
        t:     Date.now(),
        mod:   String(module || 'app').substring(0, 16),
        level: String(level  || 'info').substring(0, 9),
        // Redact secrets from both the message and the detail payload —
        // single chokepoint, so every module + every export stays clean.
        msg:   _redact(String(msg || '')).substring(0, 300),
        dur:   (typeof dur === 'number') ? dur : null,
        data:  _redact(safeStr(data, 600))
      };
      this.entries.push(entry);
      if (this.entries.length > MAX_ENTRIES) {
        this.entries.splice(0, this.entries.length - MAX_ENTRIES);
      }
      if (this.persisted) _saveEntries();
      if (this._cb) this._cb();
    },

    // ── Timer helpers ───────────────────────────────────────
    /**
     * Start a timer.  Returns an opaque start-time number.
     * Pass the return value to logTimed() as `startTime`.
     */
    startTimer() {
      return Date.now();
    },

    /**
     * Log an entry and automatically compute duration from a
     * previously-returned startTimer() value.
     */
    logTimed(module, level, msg, startTime, data) {
      const dur = (typeof startTime === 'number') ? Date.now() - startTime : null;
      this.log(module, level, msg, data, dur);
    },

    // ── Control ─────────────────────────────────────────────
    clear() {
      this.entries = [];
      if (this.persisted) _saveEntries();
      if (this._cb) this._cb();
    },

    toggle() {
      this.enabled = !this.enabled;
      localStorage.setItem(ENABLED_KEY, this.enabled ? '1' : '0');
      if (!this.enabled) { this.clear(); this.persisted = false; }
      if (this._cb) this._cb();
      return this.enabled;
    },

    // ── Persistence (chrome.storage.session) ────────────────
    /**
     * Enable persistence — entries survive popup close/reopen
     * during the same browser session.
     */
    enablePersist() {
      this.persisted = true;
      _saveEntries();
      if (this._cb) this._cb();
    },

    disablePersist() {
      this.persisted = false;
      try {
        chrome.storage.session.remove([PERSIST_KEY, PERSIST_META]);
      } catch (_) {}
      if (this._cb) this._cb();
    },

    /**
     * Load persisted entries from storage (call once on popup open).
     * Returns a Promise that resolves when loading is done.
     */
    loadPersisted() {
      return new Promise(resolve => {
        try {
          chrome.storage.session.get([PERSIST_KEY, PERSIST_META], result => {
            const raw = result[PERSIST_KEY];
            if (raw) {
              try {
                const loaded = JSON.parse(raw);
                if (Array.isArray(loaded) && loaded.length) {
                  this.entries = loaded;
                  this.persisted = true;
                  if (this._cb) this._cb();
                }
              } catch (_) {}
            }
            resolve();
          });
        } catch (_) { resolve(); }
      });
    },

    // ── Export ──────────────────────────────────────────────
    /**
     * Plain-text export — paste into email, Slack, or an AI chat.
     * @param {string} [orgUrl]
     */
    toText(orgUrl) {
      const lines = [
        '══════════════════════════════════════════════════════',
        ' Salesforce Toolkit — Debug Report',
        '══════════════════════════════════════════════════════',
        `Date:      ${new Date().toLocaleString()}`,
        `Org:       ${orgUrl || 'unknown'}`,
        `Version:   v${extVer()}`,
        `Entries:   ${this.entries.length}`,
        '──────────────────────────────────────────────────────',
        'Legend:  ✔ OK  ⚠ Session expired  ✖ Error  ! Warn',
        '──────────────────────────────────────────────────────',
        ''
      ];

      if (!this.entries.length) {
        lines.push('(no entries — enable debug mode and reproduce the issue)');
        return lines.join('\n');
      }

      const LEVEL_LABEL = {
        api:     '✔ OK     ',
        session: '⚠ SESSION',
        error:   '✖ ERROR  ',
        warn:    '! WARN   ',
        retry:   '↻ RETRY  ',
        info:    '  INFO   ',
      };

      const t0 = this.entries[0].t;
      for (const e of this.entries) {
        const t       = new Date(e.t).toTimeString().substring(0, 8);
        const elapsed = ('+' + ((e.t - t0) / 1000).toFixed(1) + 's').padEnd(8);
        const mod     = e.mod.padEnd(13);
        const lvl     = LEVEL_LABEL[e.level] ?? ('  ' + String(e.level || 'info').toUpperCase().padEnd(7));
        const dur     = e.dur === null ? ''
          : e.dur >= 1000 ? ` (${(e.dur / 1000).toFixed(1)}s)`
          : ` (${e.dur}ms)`;
        let line = `[${t}] ${elapsed}  ${mod}  ${lvl}  ${e.msg}${dur}`;
        if (e.data) line += `\n                               ↳ ${e.data}`;
        lines.push(line);
      }

      return lines.join('\n');
    },

    /**
     * Structured JSON export — machine-readable, great for AI analysis.
     * Each entry is enriched with human-readable computed fields.
     * @param {string} [orgUrl]
     */
    toJson(orgUrl) {
      const LEVEL_DESC = {
        api:     'Success',
        session: 'Session expired',
        error:   'Error',
        warn:    'Warning',
        retry:   'Retry',         // planned recovery step, not a failure
        info:    'Info',
      };

      const t0 = this.entries[0]?.t ?? 0;
      const enriched = this.entries.map(e => {
        const time    = new Date(e.t).toTimeString().substring(0, 8);
        const elapsed = t0 ? +((e.t - t0) / 1000).toFixed(1) : 0;
        const durFmt  = e.dur === null ? null
          : e.dur >= 1000 ? (e.dur / 1000).toFixed(1) + 's'
          : e.dur + 'ms';
        const result  = LEVEL_DESC[e.level] ?? e.level;
        return { id: e.id, time, elapsed: `+${elapsed}s`, mod: e.mod,
                 result, msg: e.msg, dur: durFmt, data: e.data ?? undefined };
      });

      return JSON.stringify({
        meta: {
          exportedAt: new Date().toISOString(),
          org:        orgUrl || null,
          version:    extVer(),
          entries:    this.entries.length,
        },
        entries: enriched
      }, null, 2);
    }
  };

  // ── Private ────────────────────────────────────────────────
  let _seq = 0;

  function _saveEntries() {
    try {
      const data = {};
      data[PERSIST_KEY] = JSON.stringify(D.entries.slice(-MAX_ENTRIES));
      chrome.storage.session.set(data);
    } catch (_) {}
  }

  window.SFToolkitDebug = D;

  // ── Always-on activity tracker ────────────────────────────────────────────────
  // Tracks every in-flight SF_ API call and fires a callback so the activity bar
  // in popup.html can update in real time — independent of debug mode.
  const _inFlight = new Map();
  let _actSeq    = 0;
  let _lastAct   = null;

  function _sftkDesc(msg) {
    const q = msg.query || '';
    const p = (msg.path  || '').split('?')[0];
    const fromM = q.match(/\bFROM\s+(\w+)/i);
    const obj   = fromM ? fromM[1] : null;
    if (msg.type === 'SF_QUERY' || msg.type === 'SF_QUERY_ALL') {
      return obj ? 'Querying ' + obj : 'Running query';
    }
    if (msg.type === 'SF_REST_GET') {
      // pull the meaningful segment (sobject name, action, etc.)
      const segs  = p.split('/').filter(Boolean);
      // "sobjects/Contact/describe" → "Contact describe"
      const soIdx = segs.indexOf('sobjects');
      if (soIdx >= 0 && segs[soIdx + 1]) {
        const sobj   = segs[soIdx + 1];
        const action = segs[soIdx + 2] || '';
        return 'Loading ' + sobj + (action ? ' ' + action : '');
      }
      const last = segs.pop() || 'data';
      return 'Loading ' + last;
    }
    if (msg.type === 'SF_REST_POST'  || msg.type === 'SF_TOOLING_POST')   return 'Creating';
    if (msg.type === 'SF_REST_PATCH' || msg.type === 'SF_TOOLING_PATCH')  return 'Saving';
    if (msg.type === 'SF_REST_DELETE')                                    return 'Deleting';
    if (msg.type === 'SF_DEPLOY')                                         return 'Deploying metadata';
    return msg.type.replace(/^SF_/, '').replace(/_/g, ' ').toLowerCase();
  }

  function _sftkStart(msg) {
    const id = ++_actSeq;
    _inFlight.set(id, {
      desc:           _sftkDesc(msg),
      t:              Date.now(),
      suppressOnError: !!msg._suppressError   // set true to hide red-dot on expected 400s
    });
    if (window._sftkActCb) window._sftkActCb();
    return id;
  }

  function _sftkEnd(id, errVal) {
    const act = _inFlight.get(id);
    if (act) {
      _lastAct = {
        desc:     act.desc,
        // Don't flash a red dot for calls that are known to 400 in some org types
        isError:  !!(errVal && !act.suppressOnError && errVal !== 'SESSION_EXPIRED'),
        dur:      Date.now() - act.t
      };
      _inFlight.delete(id);
    }
    if (window._sftkActCb) window._sftkActCb();
  }

  window.sftkActivity = {
    get inFlight() { return _inFlight.size; },
    get items()    { return [..._inFlight.values()]; },
    get last()     { return _lastAct; }
  };

  // Intercept chrome.runtime.sendMessage so every SF_* call is tracked
  // automatically — no module changes required.
  // When debug mode is enabled (D.enabled), every SF_* call is also
  // recorded into D.entries so the Debug Recorder panel shows live activity.
  (function patchSendMessage() {
    const _orig = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function(msg, cbOrOpts) {
      const isSf = msg && typeof msg === 'object'
                   && typeof msg.type === 'string'
                   && msg.type.startsWith('SF_');
      if (!isSf) return _orig.apply(chrome.runtime, arguments);

      const cb = typeof cbOrOpts === 'function' ? cbOrOpts : null;
      const id = _sftkStart(msg);
      const t0 = D.enabled ? Date.now() : null;

      // Write one debug entry per SF_* call when recording is active.
      function _dLog(resp, thrownErr) {
        if (!D.enabled || t0 === null) return;
        const dur    = Date.now() - t0;
        const errRaw = thrownErr
          ? (typeof thrownErr === 'string' ? thrownErr : (thrownErr.message || String(thrownErr)))
          : (resp && resp.error ? resp.error : null);
        const level  = errRaw
          ? (String(errRaw).toUpperCase().includes('SESSION') ? 'session'
             : (msg && msg._suppressError ? 'retry' : 'error'))
          : 'api';
        const desc   = _sftkDesc(msg);
        const mod    = msg.type.replace(/^SF_/, '').replace(/_/g, ' ').toLowerCase().substring(0, 16);
        D.log(mod, level, desc + (errRaw ? ' — ' + String(errRaw).substring(0, 120) : ''), null, dur);
      }

      if (cb) {
        return _orig(msg, function (resp) {
          _sftkEnd(id, resp && resp.error);
          _dLog(resp, null);
          cb(resp);
        });
      }
      // Promise-style (await bg(...))
      return _orig(msg).then(function (resp) {
        _sftkEnd(id, resp && resp.error);
        _dLog(resp, null);
        return resp;
      }).catch(function (err) {
        _sftkEnd(id, err && (err.message || 'error'));
        _dLog(null, err);
        throw err;
      });
    };
  })();

  // ── Global loading / error HTML helpers ─────────────────────────────────────
  // All modules use these for their "thinking" states. Each renders a small
  // themed kitty mascot (sftkCatSvg, below) above a text label.
  //
  //   sftkCat(msg)        → loading cat + label   (tab / section loading)
  //   sftkCat(msg, true)  → sad cat + label       (error state)
  //   sftkCatSm(msg)      → compact loading cat    (tight loading rows)
  // ---------------------------------------------------------------------------
  window.sftkCat = function (msg, isError) {
    let cls = 'lp-robot-loading';
    if (isError) cls += ' lp-robot-error';
    return '<div class="' + cls + '">' +
           window.sftkCatSvg(isError ? 'sad' : 'load', 56) +
           '<div class="lp-robot-msg">' + msg + '</div></div>';
  };

  window.sftkCatSm = function (msg) {
    return '<div class="lp-robot-loading lp-robot-sm">' +
           window.sftkCatSvg('load', 30) +
           '<div class="lp-robot-msg">' + msg + '</div></div>';
  };

  // ── Reusable kitty mascot ───────────────────────────────────────────────────
  // Inline SVG cat face themed entirely via the --cat-* CSS variables (defined
  // in styles.css / studio.css, with dark-mode variants), so it recolors with
  // the theme for free. Moods:
  //   'load'  blinking eyes (loading) — gets the .sftk-cat-load breathing anim
  //   'happy' closed ^^ eyes (success / all-clear)
  //   'sad'   half-lidded + downturned mouth (errors)
  //   'sleep' closed eyes + Zzz (empty states — "nothing here yet")
  // Used by sftkCat()/sftkCatSm() and directly in empty/success/error states.
  window.sftkCatSvg = function (mood, size) {
    mood = mood || 'load';
    const s = size || 56;
    const eyes =
      mood === 'happy' || mood === 'sleep'
        ? '<path d="M20 30 q4 4 8 0" fill="none" stroke="var(--cat-eye,#1565C0)" stroke-width="2.2" stroke-linecap="round"/>' +
          '<path d="M36 30 q4 4 8 0" fill="none" stroke="var(--cat-eye,#1565C0)" stroke-width="2.2" stroke-linecap="round"/>'
      : mood === 'sad'
        ? '<circle cx="24" cy="31" r="2.6" fill="var(--cat-eye,#1565C0)"/><circle cx="40" cy="31" r="2.6" fill="var(--cat-eye,#1565C0)"/>'
        : '<circle cx="24" cy="31" r="3.4" fill="var(--cat-eye,#1565C0)" class="sftk-cat-eye"/><circle cx="40" cy="31" r="3.4" fill="var(--cat-eye,#1565C0)" class="sftk-cat-eye"/>';
    const mouth =
      mood === 'sad'
        ? '<path d="M27 41 q5 -4 10 0" fill="none" stroke="var(--cat-nose,#EF9A9A)" stroke-width="1.8" stroke-linecap="round"/>'
        : '<path d="M32 37 v3 M27 40 q5 4 10 0" fill="none" stroke="var(--cat-nose,#EF9A9A)" stroke-width="1.6" stroke-linecap="round"/>';
    const zzz = mood === 'sleep'
      ? '<text x="48" y="18" font-size="11" fill="var(--cat-fur-dark,#78909C)" font-family="system-ui">z</text>' +
        '<text x="54" y="11" font-size="8" fill="var(--cat-fur-dark,#78909C)" font-family="system-ui">z</text>'
      : '';
    return '<svg class="sftk-cat sftk-cat-' + mood + '" width="' + s + '" height="' + s +
      '" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<g class="sftk-cat-body">' +
          // ears
          '<path d="M14 22 L12 6 L28 16 Z" fill="var(--cat-fur,#B0BEC5)"/>' +
          '<path d="M50 22 L52 6 L36 16 Z" fill="var(--cat-fur,#B0BEC5)"/>' +
          '<path d="M16 19 L15 10 L24 16 Z" fill="var(--cat-inner,#FFCDD2)"/>' +
          '<path d="M48 19 L49 10 L40 16 Z" fill="var(--cat-inner,#FFCDD2)"/>' +
          // head
          '<ellipse cx="32" cy="33" rx="22" ry="20" fill="var(--cat-fur,#B0BEC5)"/>' +
          '<ellipse cx="32" cy="38" rx="13" ry="11" fill="var(--cat-belly,#F8F4EE)"/>' +
          // stripes
          '<path d="M32 13 v8 M24 14 l2 7 M40 14 l-2 7" stroke="var(--cat-stripe,#90A4AE)" stroke-width="2" stroke-linecap="round" fill="none"/>' +
          eyes + mouth +
          // whiskers
          '<path d="M10 34 h10 M10 39 h10 M54 34 h-10 M54 39 h-10" stroke="var(--cat-stripe,#90A4AE)" stroke-width="1" stroke-linecap="round" opacity="0.7"/>' +
        '</g>' + zzz +
      '</svg>';
  };
})();
