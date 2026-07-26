'use strict';
// ════════════════════════════════════════════════════════════════
// WHAT'S NEW (T10) — the in-app changelog, rendered from CHANGELOG.md
// ════════════════════════════════════════════════════════════════
// Release notes are written WITH the code in a committed CHANGELOG.md at the
// repo root; this file renders that one file in both apps (Data Studio nav +
// Toolkit popup home). There is exactly one markdown parser — the popup does
// NOT fork it.
//
// Loaded by BOTH studio.html (after studio-core.js) and popup.html (before
// popup.js), so nothing here may assume Studio-only helpers exist: every
// cross-file call is typeof-guarded and the HTML escaper is local
// (sftkWnEsc), not studio-core's esc().
//
// CSP / Trusted Types: markdown is never assigned to innerHTML raw. The
// parser produces a plain data structure and sftkWhatsNewBodyHtml() rebuilds
// HTML with every text run passed through sftkWnEsc() first. Bold and `code`
// runs are escaped individually, inside their tags.
//
// Styling is inline style="…" only — this feature adds no CSS file. The
// colours are the shared theme variables (styles.css / studio.css define the
// same names and body.sftk-dark re-points them), so dark mode is automatic.
//
// FETCHING: chrome.runtime.getURL('CHANGELOG.md') is a chrome-extension://
// URL on the SAME origin as the page doing the fetch, and the manifest CSP
// allows connect-src 'self'. web_accessible_resources is only needed for
// resources loaded by *web pages* / content scripts, so no manifest change is
// required. (Verified against manifest.json 2026-07-25.)

// Storage key for the last version the user actually looked at.
const SFTK_WN_SEEN_KEY = 'ds_whatsnew_seen';

// Parsed changelog cache: { versions, error, source } — one fetch per page.
let _wnCache = null;

// ════════════════════════════════════════════════════════════════
// PURE — parser + HTML builder (unit-tested in test/whatsnew-t10.test.mjs)
// ════════════════════════════════════════════════════════════════

// HTML-escape one text run. Kept as a top-level FUNCTION (not a const) so the
// test harness can materialize it alongside its callers.
function sftkWnEsc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Inline markdown → escaped HTML. Supports exactly what CHANGELOG.md uses:
// `code` and **bold**. Everything else is literal text.
//
// Escaping strategy: walk the string, escape each plain segment AND each
// marked-up run separately, so no attacker-controlled substring can ever be
// emitted unescaped — even inside a code span.
function sftkInlineMdToHtml(raw) {
  const src = String(raw === null || raw === undefined ? '' : raw);
  const codeStyle = 'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;'
    + 'font-size:.9em;padding:1px 5px;border-radius:4px;'
    + 'background:var(--surface2,#F8F8F8);border:1px solid var(--border-light,#E5E4E2)';
  const re = /`([^`]+)`|\*\*([\s\S]+?)\*\*/g;
  let out = '';
  let last = 0;
  let m = re.exec(src);
  while (m !== null) {
    out += sftkWnEsc(src.slice(last, m.index));
    if (m[1] !== undefined) out += '<code style="' + codeStyle + '">' + sftkWnEsc(m[1]) + '</code>';
    else out += '<strong>' + sftkWnEsc(m[2]) + '</strong>';
    last = m.index + m[0].length;
    m = re.exec(src);
  }
  out += sftkWnEsc(src.slice(last));
  return out;
}

// Parse CHANGELOG.md into [{ version, date, sections: [{ title, items: [] }] }].
//
// Recognised lines:
//   ## 1.0.0 — 2026-07-25      version heading (— / – / - separator, or
//   ## [1.0.0] - 2026-07-25    keep-a-changelog brackets; date optional)
//   ### Added                  section heading inside the current version
//   - item / * item            a bullet in the current section
//   <indented continuation>    folded into the previous bullet
// Anything before the first `##` (the file title / preamble) is ignored, as
// are blank lines and stray prose. Bullets that appear before any `###` land
// in a section whose title is '' — the renderer just omits the heading.
function sftkParseChangelog(text) {
  const lines = String(text === null || text === undefined ? '' : text).split(/\r?\n/);
  const versions = [];
  let cur = null;
  let sec = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h2 = /^##\s+(?!#)(.*)$/.exec(line);
    if (h2) {
      const head = h2[1].trim();
      const parts = /^(.*?)\s+(?:—|–|-{1,2})\s+(.*)$/.exec(head);
      const rawVer = (parts ? parts[1] : head).trim();
      cur = {
        version: rawVer.replace(/^\[/, '').replace(/\]$/, '').trim(),
        date: parts ? parts[2].trim() : '',
        sections: [],
      };
      sec = null;
      versions.push(cur);
      continue;
    }
    const h3 = /^###\s+(.*)$/.exec(line);
    if (h3) {
      if (!cur) continue;
      sec = { title: h3[1].trim(), items: [] };
      cur.sections.push(sec);
      continue;
    }
    const bullet = /^[ \t]*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!cur) continue;
      if (!sec) {
        sec = { title: '', items: [] };
        cur.sections.push(sec);
      }
      sec.items.push(bullet[1].trim());
      continue;
    }
    // Wrapped continuation of the previous bullet: indented, non-empty, and
    // not a heading. CHANGELOG.md wraps long entries at ~90 columns.
    if (/^[ \t]+\S/.test(line) && sec && sec.items.length) {
      sec.items[sec.items.length - 1] += ' ' + line.trim();
    }
  }
  return versions;
}

// Tone for a section heading — icon + accent colour. Unknown headings get a
// neutral treatment rather than being dropped.
function sftkWnSectionTone(title) {
  const t = String(title || '').toLowerCase();
  if (t.indexOf('add') === 0 || t.indexOf('new') === 0) return { icon: '✨', color: 'var(--success,#2E844A)' };
  if (t.indexOf('fix') === 0) return { icon: '🔧', color: 'var(--brand,#0176D3)' };
  if (t.indexOf('chang') === 0 || t.indexOf('improv') === 0) return { icon: '🔁', color: 'var(--brand-dark,#014486)' };
  if (t.indexOf('known') === 0 || t.indexOf('caveat') === 0) return { icon: '⚠️', color: 'var(--warning,#DD7A01)' };
  if (t.indexOf('remov') === 0 || t.indexOf('deprecat') === 0) return { icon: '🗑', color: 'var(--danger,#EA001E)' };
  return { icon: '•', color: 'var(--subtext,#706E6B)' };
}

// How many of the newest versions the user has NOT seen. `seen` is the version
// string stored in chrome.storage.local. Rules:
//   • seen matches a version   → everything above it is new
//   • seen is empty/unknown    → treat only the newest as new (don't scream
//                                "12 new versions" at a first-time user)
// Returns 0 when the newest version IS the seen one.
function sftkWnNewCount(versions, seen) {
  const list = Array.isArray(versions) ? versions : [];
  if (!list.length) return 0;
  const want = String(seen === null || seen === undefined ? '' : seen).trim();
  if (!want) return 1;
  for (let i = 0; i < list.length; i++) {
    if (String(list[i].version || '').trim() === want) return i;
  }
  return 1;
}

// Should the nav entry be badged? Newest version differs from last-seen.
function sftkWhatsNewIsUnseen(latest, seen) {
  const a = String(latest === null || latest === undefined ? '' : latest).trim();
  const b = String(seen === null || seen === undefined ? '' : seen).trim();
  if (!a) return false;
  return a !== b;
}

// Build the whole changelog body as escaped HTML.
// opts = { seen, note } — `note` is an honest inline caveat rendered above the
// list (e.g. "only the newest N versions parsed"); omit for none.
function sftkWhatsNewBodyHtml(versions, opts) {
  const list = Array.isArray(versions) ? versions : [];
  const o = opts || {};
  if (!list.length) {
    return '<div style="padding:16px;border:1px solid var(--border,#DDDBDA);border-radius:8px;'
      + 'background:var(--card,#fff);color:var(--subtext,#706E6B)">'
      + 'CHANGELOG.md loaded but contained no <code>##&nbsp;version</code> sections, so there is '
      + 'nothing to show. That is a packaging problem, not an empty release history.</div>';
  }
  const newCount = sftkWnNewCount(list, o.seen);
  let html = '';
  if (o.note) {
    html += '<div style="margin-bottom:12px;padding:8px 12px;border-radius:6px;font-size:12px;'
      + 'background:var(--warning-bg,#FEF0E0);color:var(--text,#181818);'
      + 'border:1px solid var(--warning,#DD7A01)">⚠️ ' + sftkWnEsc(o.note) + '</div>';
  }
  for (let vi = 0; vi < list.length; vi++) {
    const v = list[vi] || {};
    const isNew = vi < newCount;
    html += '<section style="margin:0 0 18px;padding:14px 16px;border-radius:8px;'
      + 'background:var(--card,#fff);border:1px solid '
      + (isNew ? 'var(--brand,#0176D3)' : 'var(--border,#DDDBDA)') + '">';
    html += '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px">'
      + '<span style="font-size:17px;font-weight:700;color:var(--text,#181818)">'
      + sftkWnEsc(v.version || 'Unversioned') + '</span>';
    if (v.date) {
      html += '<span style="font-size:12px;color:var(--subtext,#706E6B)">' + sftkWnEsc(v.date) + '</span>';
    }
    if (isNew) {
      html += '<span style="font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;'
        + 'padding:2px 7px;border-radius:10px;color:#fff;background:var(--brand,#0176D3)">New for you</span>';
    }
    html += '</div>';

    const sections = Array.isArray(v.sections) ? v.sections : [];
    if (!sections.length) {
      html += '<div style="font-size:12px;color:var(--subtext,#706E6B)">No notes recorded for this version.</div>';
    }
    for (let si = 0; si < sections.length; si++) {
      const s = sections[si] || {};
      const tone = sftkWnSectionTone(s.title);
      html += '<div style="margin-top:' + (si ? '14px' : '0') + '">';
      if (s.title) {
        html += '<div style="font-size:12px;font-weight:700;letter-spacing:.3px;text-transform:uppercase;'
          + 'color:' + tone.color + ';margin-bottom:6px">'
          + tone.icon + ' ' + sftkWnEsc(s.title) + '</div>';
      }
      html += '<ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px">';
      const items = Array.isArray(s.items) ? s.items : [];
      for (let ii = 0; ii < items.length; ii++) {
        html += '<li style="display:flex;gap:8px;align-items:flex-start;line-height:1.55;'
          + 'color:var(--text,#181818)">'
          + '<span aria-hidden="true" style="color:' + tone.color + ';flex-shrink:0">•</span>'
          + '<span>' + sftkInlineMdToHtml(items[ii]) + '</span></li>';
      }
      html += '</ul></div>';
    }
    html += '</section>';
  }
  return html;
}

// ════════════════════════════════════════════════════════════════
// IMPURE — fetch, storage, rendering
// ════════════════════════════════════════════════════════════════

// Fetch + parse CHANGELOG.md once per page load.
// NEVER throws: on failure it resolves with { versions: [], error } so callers
// can say WHAT could not be read instead of rendering a blank page.
async function sftkLoadChangelog(force) {
  if (_wnCache && !force) return _wnCache;
  let url = 'CHANGELOG.md';
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
      url = chrome.runtime.getURL('CHANGELOG.md');
    }
  } catch (_) { /* keep the relative fallback */ }
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    _wnCache = { versions: sftkParseChangelog(text), error: '', source: url };
  } catch (e) {
    _wnCache = { versions: [], error: (e && e.message) || String(e), source: url };
  }
  return _wnCache;
}

async function sftkWhatsNewSeenVersion() {
  try {
    const d = await chrome.storage.local.get(SFTK_WN_SEEN_KEY);
    return String((d && d[SFTK_WN_SEEN_KEY]) || '');
  } catch (_) {
    return '';
  }
}

async function sftkWhatsNewMarkSeen(version) {
  if (!version) return;
  try {
    await chrome.storage.local.set({ [SFTK_WN_SEEN_KEY]: String(version) });
  } catch (_) { /* a failed write just means the badge shows again — harmless */ }
}

// The honest failure panel: says what could not be read, why, and what it
// means — never a blank page and never a silent success.
function sftkWhatsNewErrorHtml(error, source) {
  return '<div style="padding:16px;border-radius:8px;background:var(--card,#fff);'
    + 'border:1px solid var(--warning,#DD7A01)">'
    + '<div style="font-weight:700;margin-bottom:6px;color:var(--text,#181818)">'
    + 'Could not read the changelog</div>'
    + '<div style="font-size:12.5px;color:var(--text,#181818);line-height:1.6">'
    + 'The release notes live in <code>CHANGELOG.md</code> inside the extension. '
    + 'Fetching <code>' + sftkWnEsc(source || 'CHANGELOG.md') + '</code> failed with: '
    + '<strong>' + sftkWnEsc(error || 'unknown error') + '</strong>.<br>'
    + 'The most likely cause is a packaged build that did not include the file — '
    + 'the store packager currently packs only JS, HTML, CSS, PNG and the manifest. '
    + 'Nothing else in the toolkit is affected; this page just has nothing to show.'
    + '</div></div>';
}

// Shared renderer — the ONE place the changelog turns into DOM. Both the
// Studio view and the popup tab call this, so they can never drift.
// Returns the latest version string (or '') so the caller can mark it seen.
async function sftkWhatsNewRenderInto(el, opts) {
  if (!el) return '';
  const o = opts || {};
  el.innerHTML = '<div style="padding:20px;color:var(--subtext,#706E6B)">Loading release notes…</div>';
  const data = await sftkLoadChangelog(!!o.force);
  const seen = await sftkWhatsNewSeenVersion();
  const latest = data.versions.length ? String(data.versions[0].version || '') : '';
  el.innerHTML = data.error
    ? sftkWhatsNewErrorHtml(data.error, data.source)
    : sftkWhatsNewBodyHtml(data.versions, { seen });
  return latest;
}

// ── Data Studio view ─────────────────────────────────────────────
// Registered in studio-core.js: CMD_VIEWS + DS_HASH_VIEWS + renderView's
// switch + _viewAvailable (so a build without this file falls back to home).
async function renderWhatsNew() {
  if (typeof setMain !== 'function') return;
  setMain(`
    <div class="ds-view-header">
      <div class="ds-view-title-wrap">
        <h2 class="ds-view-title">🎉 What's New</h2>
        <div class="ds-view-subtitle">Everything that shipped, newest first — straight from the changelog</div>
      </div>
    </div>
    <div id="dsWhatsNewBody" style="max-width:860px"></div>`);
  const latest = await sftkWhatsNewRenderInto(document.getElementById('dsWhatsNewBody'), {});
  if (latest) {
    await sftkWhatsNewMarkSeen(latest);
    sftkWhatsNewRefreshBadge();
  }
}

// ── Nav badge (Studio sidebar) ───────────────────────────────────
// Fills #dsWhatsNewBadge when the newest version differs from the last-seen
// one; empties it once the page has been viewed.
async function sftkWhatsNewRefreshBadge() {
  const slot = document.getElementById('dsWhatsNewBadge');
  if (!slot) return;
  const data = await sftkLoadChangelog(false);
  if (data.error || !data.versions.length) { slot.innerHTML = ''; return; }
  const latest = String(data.versions[0].version || '');
  const seen = await sftkWhatsNewSeenVersion();
  if (!sftkWhatsNewIsUnseen(latest, seen)) { slot.innerHTML = ''; return; }
  slot.title = 'Version ' + latest + ' — not read yet';
  // Topbar placement (2026-07-26, user: "small portion, not as a feature"):
  // the badge is a tiny dot pinned to the 🎉 button's corner, not a chip.
  slot.innerHTML = '<span style="position:absolute;top:2px;right:2px;width:8px;height:8px;'
    + 'border-radius:50%;background:#C23934;border:1.5px solid rgba(255,255,255,.9)"></span>';
}

// ── Toolkit popup tab ────────────────────────────────────────────
// Opened from the popup home grid (HOME_FEATURES entry `whatsnew`).
async function initWhatsNewTab() {
  const el = document.getElementById('whatsNewContainer');
  if (!el) return;
  const latest = await sftkWhatsNewRenderInto(el, {});
  if (latest) await sftkWhatsNewMarkSeen(latest);
}

// Self-init: paint the topbar badge as soon as the shell exists, and wire
// the 🎉 topbar button (What's New is an announcement control, not a nav
// feature). No-op in the popup — the elements only live in studio.html.
function sftkWhatsNewBoot() {
  if (!document.getElementById('dsWhatsNewBadge')) return;
  sftkWhatsNewRefreshBadge();
  document.getElementById('dsWhatsNewTop')?.addEventListener('click', () => {
    document.querySelectorAll('.ds-nav-btn').forEach(b => b.classList.remove('active'));
    try { _currentView = 'whatsnew'; } catch (_) {}
    if (typeof renderView === 'function') renderView('whatsnew');
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', sftkWhatsNewBoot);
} else {
  sftkWhatsNewBoot();
}
