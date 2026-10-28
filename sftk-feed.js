'use strict';
// 🧾 Activity — one feed of everything the Toolkit and Data Studio did, and
// when (user 2026-10-27: "history feed of everything you did and when … accessed
// from the topbar of both tools … and grouped"). Reads the one shared history
// (sftk-history.js: deployments, rollbacks, Data Studio changes, every Toolkit
// tool's changes) and shows it grouped by day, and inside a day by the tool or
// deployment that did it. Nothing here writes to Salesforce; the actions (undo,
// roll back, report) stay where they live — each line links there.
//
// Loaded by both pages. The pure parts take plain data; the dialog uses the
// page's own showModal/closeModal and its button classes.

const SFTK_FEED_STUDIO_KINDS = { reconcile: 'Data Deployment', rollback: 'Rollback', transfer: 'Data Deployment' };

// PURE. What an entry is, in words: the app, the tool or deployment, a title.
function sftkFeedWhat(e) {
  if (!e) return { app: '', group: '', title: '', icon: '' };
  if (e.kind === 'tool') {
    const tab = (typeof sftkHistoryToolTab === 'function') ? sftkHistoryToolTab(e) : '';
    const app = tab ? 'Toolkit' : 'Data Studio';
    return { app, group: String(e.tool || 'change'), title: String(e.profileName || e.tool || 'change'), icon: '🛠', tab };
  }
  const isRb = e.kind === 'rollback';
  return { app: 'Data Studio', group: `${isRb ? 'Rollback' : 'Data Deployment'} — ${String(e.profileName || 'deployment').replace(/^↩ Rollback of /, '')}`,
    title: String(e.profileName || 'deployment'), icon: isRb ? '↩' : '🚀', tab: '' };
}

// PURE. The counts of an entry in one short line.
function sftkFeedCounts(e) {
  if (!e) return '';
  if (e.kind === 'tool') {
    const what = Array.isArray(e.what) ? e.what : [];
    if (!what.length) return 'nothing written';
    const ok = what.filter(w => w.ok).length;
    return ok === what.length ? `${what.length} step${what.length === 1 ? '' : 's'} verified` : `${ok} of ${what.length} steps verified`;
  }
  let ins = 0, upd = 0, del = 0, fail = 0;
  for (const s of Object.values(e.summary || {})) {
    if (!s || typeof s !== 'object') continue;
    ins += (s.created || 0) + (s.inserted || 0);
    upd += (s.updated || 0) + (s.updatedSource || 0) + (s.relinked || 0) + (s.overwritten || 0) + (s.pulled || 0);
    del += s.deleted || 0;
    fail += (s.failed || 0) + (s.insertedFailed || 0) + (s.updatedFailed || 0) + (s.deletedFailed || 0) + (s.pulledFailed || 0) + (s.updatedSourceFailed || 0) + (s.connectFailed || 0) + (s.relinkFailed || 0) + (s.overwriteFailed || 0) + (s.deleteFailed || 0);
  }
  const parts = [];
  const isRb = e.kind === 'rollback';
  if (ins) parts.push(`${ins.toLocaleString()} ${isRb ? 'restored' : 'inserted'}`);
  if (upd) parts.push(`${upd.toLocaleString()} ${isRb ? 'restored' : 'updated'}`);
  if (del) parts.push(`${del.toLocaleString()} deleted`);
  if (fail) parts.push(`${fail.toLocaleString()} failed`);
  return parts.join(' · ') || 'nothing written';
}

// PURE. "Today" / "Yesterday" / "Mon 27 Oct 2026" for a day, from the viewer's clock.
function sftkFeedDayLabel(dayKey, nowMs) {
  const d = new Date(dayKey + 'T12:00:00');
  const now = new Date(nowMs);
  const key = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  if (dayKey === key(now)) return 'Today';
  const y = new Date(nowMs - 86400000);
  if (dayKey === key(y)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

// PURE. Grouped: days newest first → inside a day, the tools/deployments in the order they were last
// used → inside, the entries newest first. { days: [{ key, label, groups: [{ name, app, icon, entries }] }], n }
function sftkFeedGroups(entries, nowMs, filter) {
  const f = filter || {};
  const q = String(f.q || '').trim().toLowerCase();
  const list = (Array.isArray(entries) ? entries : []).filter(e => e && e.startedAt)
    .filter(e => !f.app || sftkFeedWhat(e).app === f.app)
    .filter(e => !q || `${sftkFeedWhat(e).group} ${sftkFeedWhat(e).title} ${e.targetOrg || ''} ${e.sourceOrg || ''} ${e.status || ''}`.toLowerCase().includes(q))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const days = [];
  for (const e of list) {
    const t = new Date(e.startedAt);
    const dayKey = Number.isFinite(t.getTime()) ? `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}` : 'unknown';
    let day = days[days.length - 1];
    if (!day || day.key !== dayKey) { day = { key: dayKey, label: dayKey === 'unknown' ? 'Unknown day' : sftkFeedDayLabel(dayKey, nowMs), groups: [] }; days.push(day); }
    const w = sftkFeedWhat(e);
    let g = day.groups.find(x => x.name === w.group && x.app === w.app);
    if (!g) { g = { name: w.group, app: w.app, icon: w.icon, tab: w.tab, entries: [] }; day.groups.push(g); }
    g.entries.push(e);
  }
  return { days, n: list.length };
}

// PURE. HH:MM of an entry, from the viewer's clock.
function sftkFeedTime(iso) {
  const t = new Date(iso || '');
  return Number.isFinite(t.getTime()) ? t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
}

// ── the dialog (both pages) ──
(function () {
  if (typeof document === 'undefined') return;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const orgName = u => String(u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.(lightning\.force|my\.salesforce)\.com$/, '') || '';
  const studio = () => !!document.querySelector('.ds-topbar');
  const cls = {
    get hdr() { return studio() ? 'ds-modal-header' : 'modal-header'; },
    get btn() { return studio() ? 'ds-btn ds-btn-sm' : 'btn btn-sm btn-secondary'; },
    get btnX() { return studio() ? 'ds-btn ds-btn-xs' : 'btn btn-sm btn-secondary'; },
    get input() { return studio() ? 'ds-input ds-input-sm' : 'input'; },
  };
  const filter = { q: '', app: '' };

  // where an entry's actions live: the tool's own history (popup), the History page (studio)
  const whereHtml = g => {
    if (g.app === 'Toolkit' && g.tab) {
      return studio()
        ? `<a class="sftk-feed-where" href="popup.html?tab=${encodeURIComponent(g.tab)}&history=1" target="_blank" rel="noopener" title="Opens the Toolkit on that tool's history — undo and reports live there">open in the Toolkit ↗</a>`
        : `<button class="sftk-feed-where sftk-feed-link" data-feed-tool="${esc(g.tab)}" title="That tool's own history — undo and reports live there">open the tool's history</button>`;
    }
    return studio()
      ? `<button class="sftk-feed-where sftk-feed-link" data-feed-studio="history" title="The full cards of these runs — per-object counts, the failed records by name, filters">details</button>`
      : `<a class="sftk-feed-where" href="studio.html#/activity" target="_blank" rel="noopener" title="Opens Data Studio's Activity — roll back, retry, continue and the reports live there">open in Data Studio ↗</a>`;
  };
  // the actions of one entry: in Data Studio the History card's own groups (fix · undo · open · report);
  // in the Toolkit a tool entry's ↩ Undo and ⬇ Report, and for a deployment the way to Data Studio
  const actsHtml = e => {
    if (studio()) return typeof window.sftkHistActionsFor === 'function' ? window.sftkHistActionsFor(e) : '';
    if (e.kind === 'tool') {
      const st = typeof sftkToolUndoState === 'function' ? sftkToolUndoState(e) : { show: false };
      return `<div class="sftk-feed-acts">${st.show ? `<button class="btn btn-sm ${st.disabled ? 'btn-secondary' : 'btn-danger'}" ${st.disabled ? 'disabled' : ''} data-feed-undo="${esc(e.id)}" title="${esc(st.title || '')}">${esc(st.label)}</button>` : ''}<button class="btn btn-sm btn-secondary" data-feed-report="${esc(e.id)}" title="Download this entry as a JSON audit report — what was written, where, when, and what the org showed.">⬇ Report</button></div>`;
    }
    return `<div class="sftk-feed-acts"><a class="btn btn-sm btn-secondary" href="studio.html#/activity" target="_blank" rel="noopener" title="A deployment is rolled back, retried, continued and reported from Data Studio — its Activity has the same line with those buttons">↩ roll back · ↻ retry · ⬇ report — in Data Studio ↗</a></div>`;
  };
  const badge = s => s === 'success' ? '✅' : s === 'partial' ? '⚠' : s === 'running' ? '⏳' : '❌';
  const line = e => {
    const w = sftkFeedWhat(e);
    const orgs = e.kind === 'tool' ? orgName(e.targetOrg) : `${orgName(e.sourceOrg)} → ${orgName(e.targetOrg)}`;
    return `<div class="sftk-feed-line" data-feed-id="${esc(e.id)}">
      <span class="sftk-feed-time" title="${esc(e.startedAt || '')}">${esc(sftkFeedTime(e.startedAt))}</span>
      <span class="sftk-feed-status" title="${esc(e.status || '')}">${badge(e.status)}</span>
      <span class="sftk-feed-title">${esc(w.title)}${e.undoOf ? ' <span class="sftk-feed-chip">↩ undo</span>' : ''}</span>
      <span class="sftk-feed-counts">${esc(sftkFeedCounts(e))}</span>
      <span class="sftk-feed-orgs">${esc(orgs)}</span>
      ${actsHtml(e)}
    </div>`;
  };
  const groupHtml = g => `<details class="sftk-feed-group" open><summary><span class="sftk-feed-icon">${g.icon}</span><span class="sftk-feed-app">${esc(g.app)}</span><b>${esc(g.name)}</b><span class="sftk-feed-n">${g.entries.length}</span><span class="sftk-feed-sp"></span>${whereHtml(g)}</summary>${g.entries.map(line).join('')}</details>`;
  const dayHtml = d => `<section class="sftk-feed-day"><h4>${esc(d.label)} <span class="sftk-feed-n">${d.groups.reduce((n, g) => n + g.entries.length, 0)}</span></h4>${d.groups.map(groupHtml).join('')}</section>`;

  async function paint() {
    const host = document.getElementById('sftkFeedList');
    if (!host) return;
    const all = (typeof sftkHistoryAll === 'function') ? await sftkHistoryAll() : [];
    const g = sftkFeedGroups(all, Date.now(), filter);
    host.innerHTML = g.n ? g.days.map(dayHtml).join('')
      : `<div class="sftk-feed-empty">${all.length ? 'Nothing matches.' : 'Nothing yet — every change the Toolkit or Data Studio makes is listed here, with the time it was made.'}</div>`;
    const n = document.getElementById('sftkFeedCount'); if (n) n.textContent = `${g.n.toLocaleString()} of ${all.length.toLocaleString()}`;
    host.querySelectorAll('[data-feed-tool]').forEach(b => b.addEventListener('click', () => { if (typeof window.sftkToolHistoryOpen === 'function') window.sftkToolHistoryOpen(b.dataset.feedTool); }));
    host.querySelectorAll('[data-feed-studio]').forEach(b => b.addEventListener('click', () => { if (typeof closeModal === 'function') closeModal(); if (typeof navigateToView === 'function') navigateToView('history'); else location.hash = '#/history'; }));
    // the Toolkit: ↩ Undo asks in the page's one dialog, so the feed steps aside and comes back after
    host.querySelectorAll('[data-feed-undo]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      if (typeof closeModal === 'function') closeModal();
      if (typeof sftkHistoryUndo === 'function') await sftkHistoryUndo(b.dataset.feedUndo, {});
      open();
    }));
    host.querySelectorAll('[data-feed-report]').forEach(b => b.addEventListener('click', () => {
      const e = all.find(x => x.id === b.dataset.feedReport); if (!e) return;
      download(`${typeof sftkHistoryReportName === 'function' ? sftkHistoryReportName(e) : 'sftk-activity'}.json`, JSON.stringify(typeof sftkHistoryReport === 'function' ? sftkHistoryReport(e) : e, null, 2));
    }));
    // Data Studio: the card's own buttons. ⬇ Report opens the export dialog in place of the feed;
    // ↩ Undo of a tool entry asks first, so the feed steps aside and comes back; everything else
    // navigates, so the feed closes behind it.
    host.querySelectorAll('[data-hist-export]').forEach(b => b.addEventListener('click', () => { window.sftkHistExportOne?.(b.dataset.histExport); }));
    host.querySelectorAll('[data-dsaction]').forEach(b => b.addEventListener('click', async ev => {
      const a = b.dataset.dsaction;
      if (a === 'undoTool') {
        ev.stopPropagation(); b.disabled = true;
        if (typeof closeModal === 'function') closeModal();
        if (typeof window.undoTool === 'function') await window.undoTool(b.dataset.arg);
        open();
        return;
      }
      if (a !== 'closeModal') setTimeout(() => { if (typeof closeModal === 'function') closeModal(); }, 0);
    }));
  }

  function download(name, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ⬇ Export all: Data Studio's audit export (JSON or CSV, every retained run); the Toolkit writes
  // one JSON file with every entry as it is stored
  async function exportAll() {
    if (studio() && typeof window.sftkHistExportAll === 'function') { window.sftkHistExportAll(); return; }
    const all = (typeof sftkHistoryAll === 'function') ? await sftkHistoryAll() : [];
    const nowIso = new Date().toISOString();
    download(`sftk-activity-${nowIso.slice(0, 10)}-${nowIso.slice(11, 19).replace(/:/g, '')}.json`, JSON.stringify({ exportedAt: nowIso, count: all.length, entries: all }, null, 2));
  }

  function open() {
    if (typeof showModal !== 'function') return;
    showModal(`<div class="${cls.hdr}">🧾 Activity — everything the Toolkit and Data Studio did${studio() ? '<button class="ds-btn ds-btn-xs ds-dc-modal-close" data-dsaction="closeModal" title="Close">✕</button>' : ''}</div>
      <div class="sftk-feed">
        <div class="sftk-feed-tools">
          <input type="search" class="${cls.input}" id="sftkFeedQ" placeholder="🔍 find — a tool, a deployment, an org…" aria-label="Find in the activity">
          <span class="sftk-feed-apps">${['', 'Data Studio', 'Toolkit'].map(a => `<button class="${cls.btnX} sftk-feed-app-btn${filter.app === a ? ' sftk-feed-app-on' : ''}" data-feed-app="${esc(a)}">${a || 'Everything'}</button>`).join('')}</span>
          <span class="sftk-feed-sp"></span><span class="sftk-feed-count" id="sftkFeedCount"></span>
          <button class="${cls.btnX}" id="sftkFeedExport" title="${studio() ? 'Download every retained run as a JSON or CSV audit file — for change-management records' : 'Download every entry as one JSON file'}">⬇ Export all</button>
        </div>
        <div class="sftk-feed-list" id="sftkFeedList"><div class="sftk-feed-empty">Reading…</div></div>
        <div class="sftk-feed-foot"><span>Grouped by day, then by the tool or deployment. Each line carries what you can do with it: ${studio() ? 'fix what did not finish, undo it, open the deployment, download its report' : 'undo a tool\'s change and download its report; a deployment is handled in Data Studio'}.</span>${studio() ? '' : `<button class="${cls.btn}" id="sftkFeedClose">Close</button>`}</div>
      </div>`);
    // room for a title, its counts and its orgs on one line, on both pages
    const box = document.getElementById(studio() ? 'dsModalBox' : 'modalBox'); if (box) { box.style.width = 'min(960px, 94vw)'; box.style.maxWidth = '94vw'; }
    document.getElementById('sftkFeedClose')?.addEventListener('click', () => closeModal());
    document.getElementById('sftkFeedExport')?.addEventListener('click', exportAll);
    const q = document.getElementById('sftkFeedQ');
    let timer = null;
    q?.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { filter.q = q.value; paint(); }, 200); });
    document.querySelectorAll('[data-feed-app]').forEach(b => b.addEventListener('click', () => {
      filter.app = b.dataset.feedApp;
      document.querySelectorAll('[data-feed-app]').forEach(x => x.classList.toggle('sftk-feed-app-on', x.dataset.feedApp === filter.app));
      paint();
    }));
    paint();
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('sftkFeedBtn')?.addEventListener('click', open);
    // studio.html#/activity (the Toolkit's link): the feed opens over the page
    if (studio() && /^#\/activity\b/.test(location.hash || '')) setTimeout(open, 700);
  });
  try { chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.sftk_history && document.getElementById('sftkFeedList')) paint(); }); } catch (_) { /* outside the extension */ }
  if (typeof window !== 'undefined') window.sftkFeedOpen = open;
})();
