'use strict';
// ── A Toolkit tool's own history (popup.html) ─────────────────────────────
// User 2026-10-05, looking at Data Studio › History full of Field Cleaner
// entries: "i think seeing field cleaner history on the data deployment
// history is confusing, it should show under the field cleaner".
//
// A change made by a Toolkit tool is still ONE entry in the shared history
// list (sftk-history.js: what was written, what the org showed, the undo).
// What changed is where it is shown: in the tool that made it —
//   • a "History (N)" button in the top bar while that tool is open, which
//     lists the tool's changes with ↩ Undo and ⬇ Report;
//   • for a tool that has room for it, the same list inside the tool
//     (sftkToolHistoryInline — Field Cleaner mounts it under its results).
// Data Studio › History lists deployments, rollbacks and Data Studio's own
// changes, and says how many Toolkit changes live in which tool.
//
// Nothing here writes to Salesforce by itself: ↩ Undo goes through
// sftkHistoryUndo (one confirmation with a typed word, every step re-read).
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const orgName = u => String(u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.(lightning\.force|my\.salesforce)\.com$/, '') || '—';
  const SHOWN = 15;                      // cards drawn at first; "Show all" draws the rest
  let _tab = '';                         // the tool that is open
  const _showAll = new Set();            // tabs whose full list was asked for
  const _said = new Map();               // entry id → the sentence its undo ended with

  async function entriesFor(tab) {
    const all = (typeof sftkHistoryAll === 'function') ? await sftkHistoryAll() : [];
    return sftkHistoryForTab(all, tab);
  }

  function cardHtml(e) {
    const st = sftkToolUndoState(e);
    const what = Array.isArray(e.what) ? e.what : [];
    const icon = w => w.info ? 'ℹ' : (w.ok ? '✅' : w.accepted ? '⚠' : '❌');
    const badge = e.status === 'success' ? '✅' : e.status === 'partial' ? '⚠' : '❌';
    const said = _said.get(e.id);
    // "⇄ Flow — SFTK FC Test Flow 2 (Account.A__c → B__c)": the kind, the subject, the detail as a chip
    // (user 2026-10-24: "can we also do the presented data here more organized?")
    const title = String(e.profileName || e.tool || 'change');
    const tm = /^(.*?) — (.*?)(?: \((.*)\))?$/.exec(title);
    const kind = tm ? tm[1] : '', subject = tm ? tm[2] : title, detail = tm && tm[3] ? tm[3] : '';
    const okN = what.filter(w => w.ok).length;
    const line = w => `<div>${icon(w)} ${esc(w.text || w.describe)}</div>`;
    return `<div class="sftk-th-card" data-th-id="${esc(e.id)}">
      <div class="sftk-th-head">
        <span class="sftk-th-status sftk-th-${esc(e.status || 'failed')}">${badge} ${esc(e.status || '')}</span>
        ${kind ? `<span class="sftk-th-kind">${esc(kind)}</span>` : ''}
        <span class="sftk-th-title">${esc(subject)}${detail ? ` <span class="sftk-th-detail" title="${esc(detail)}">${esc(detail)}</span>` : ''}</span>
        ${e.undoOf ? '<span class="sftk-th-chip" title="This entry is the undo of an earlier change.">↩ undo</span>' : ''}
        <span class="sftk-th-when" title="${esc(e.startedAt || '')}">${esc(sftkHistoryAgo(e.startedAt, Date.now()))} · ${esc(orgName(e.targetOrg))}</span>
        ${st.show ? `<button class="btn btn-sm ${st.disabled ? 'btn-secondary' : 'btn-danger'} sftk-th-undo" ${st.disabled ? 'disabled' : ''} data-th-undo="${esc(e.id)}" title="${esc(st.title || '')}">${esc(st.label)}</button>` : ''}
        <button class="btn btn-sm btn-secondary" data-th-report="${esc(e.id)}" title="Download this entry as a JSON file: what was written, where, when, and what the org showed.">⬇ Report</button>
      </div>
      <div class="sftk-th-what">
        ${!what.length ? '<div>— nothing was written</div>'
          : what.length <= 2 ? what.map(line).join('')
          : `<details class="sftk-th-more"><summary>${okN === what.length ? `all ${what.length} steps verified by re-reading the org` : `${okN} of ${what.length} steps verified`} — show them</summary>${what.map(line).join('')}</details>`}
        ${said ? `<div class="sftk-th-said">${esc(said)}</div>` : ''}
      </div>
      ${e.toolUndo && (e.toolUndo.none || e.toolUndo.done) ? `<div class="sftk-th-foot">${e.toolUndo.none ? `↩ no undo — ${esc(e.toolUndo.none)}` : ''}${e.toolUndo.done ? `↩ ${e.toolUndo.done.ok ? 'undone and verified' : 'undo attempted — not every step confirmed'} on ${esc(e.toolUndo.done.at)}` : ''}</div>` : ''}
    </div>`;
  }

  // The list of one tool, into `host`. after(): what to do once an undo ended
  // (the modal re-opens itself; an inline list just redraws).
  async function render(host, tab, after) {
    if (!host) return 0;
    const list = await entriesFor(tab);
    host.setAttribute('data-sftk-th', tab);
    if (!list.length) { host.innerHTML = ''; return 0; }
    const all = _showAll.has(tab);
    const shown = all ? list : list.slice(0, SHOWN);
    host.innerHTML = `${shown.map(cardHtml).join('')}
      ${list.length > shown.length ? `<button class="btn btn-sm btn-secondary" data-th-more="1">Show all ${list.length}</button>` : ''}`;
    host.querySelector('[data-th-more]')?.addEventListener('click', () => { _showAll.add(tab); render(host, tab, after); });
    host.querySelectorAll('[data-th-report]').forEach(b => b.addEventListener('click', () => {
      const e = list.find(x => x.id === b.dataset.thReport); if (!e) return;
      const blob = new Blob([JSON.stringify(sftkHistoryReport(e), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = sftkHistoryReportName(e) + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }));
    host.querySelectorAll('[data-th-undo]').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.thUndo;
      b.disabled = true;
      // the confirmation uses the page's one dialog: a list shown IN that dialog steps aside first
      if (host.closest('#modalBox') && typeof closeModal === 'function') closeModal();
      const r = await sftkHistoryUndo(id, {});
      if (!r.cancelled) _said.set(id, r.text);
      if (typeof after === 'function') after(r); else render(host, tab, after);
    }));
    return list.length;
  }

  // ── inside a tool ──
  // `host` gets a collapsed section with the tool's changes; nothing when there are none.
  async function inline(host, tab) {
    if (!host) return;
    // marked even while empty: the first change of this session must find it (refreshAll)
    host.setAttribute('data-sftk-th-inline', tab);
    const list = await entriesFor(tab);
    if (!list.length) { host.innerHTML = ''; return; }
    const open = !!host.querySelector('details')?.open;
    host.innerHTML = `<details class="sftk-th-inline" ${open ? 'open' : ''}>
        <summary>🧾 History — ${list.length} change${list.length === 1 ? '' : 's'} made with ${esc(sftkHistoryTabLabel(tab))}</summary>
        <div class="sftk-th-list"></div>
      </details>`;
    await render(host.querySelector('.sftk-th-list'), tab, () => inline(host, tab));
  }

  // ── the top-bar button of the tool that is open ──
  async function button() {
    const b = document.getElementById('sftkThBtn');
    if (!b) return;
    const n = _tab ? (await entriesFor(_tab)).length : 0;
    b.style.display = n ? '' : 'none';
    if (n) {
      const lbl = document.getElementById('sftkThBtnLabel');
      if (lbl) lbl.textContent = `History (${n})`; else b.textContent = `History (${n})`;
      b.title = `The ${n} change${n === 1 ? '' : 's'} made with ${sftkHistoryTabLabel(_tab)} — what was written, what the org showed, and ↩ Undo`;
    }
  }
  async function open(tab) {
    const t = tab || _tab; if (!t || typeof showModal !== 'function') return;
    showModal(`<div class="modal-header">🧾 History — ${esc(sftkHistoryTabLabel(t))}</div>
      <div class="sftk-th-intro">Every change this tool made, newest first. A change made by another tool is in that tool; deployments are in Data Studio › History.</div>
      <div class="sftk-th-list sftk-th-modal" id="sftkThModalList"></div>
      <div class="modal-actions"><button class="btn btn-secondary" id="sftkThClose">Close</button></div>`);
    const box = document.getElementById('modalBox'); if (box) box.style.width = 'min(860px, 94vw)';
    document.getElementById('sftkThClose')?.addEventListener('click', () => closeModal());
    const n = await render(document.getElementById('sftkThModalList'), t, () => open(t));
    if (!n) { const l = document.getElementById('sftkThModalList'); if (l) l.innerHTML = '<div class="sftk-th-sub">This tool has made no change yet.</div>'; }
  }

  // The popup tells this module which tool is open (navigateToTab / showHomePage).
  function setTab(tab) { _tab = sftkHistoryTabLabel(tab) ? String(tab) : ''; button(); }

  function refreshAll() {
    button();
    document.querySelectorAll('[data-sftk-th-inline]').forEach(h => inline(h, h.getAttribute('data-sftk-th-inline')));
    const m = document.getElementById('sftkThModalList'); if (m && m.getAttribute('data-sftk-th')) render(m, m.getAttribute('data-sftk-th'), () => open(m.getAttribute('data-sftk-th')));
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
      document.getElementById('sftkThBtn')?.addEventListener('click', () => open());
      // Data Studio › History links here: popup.html?tab=fields&history=1
      try {
        const q = new URLSearchParams(location.search);
        if (q.get('history') === '1' && sftkHistoryTabLabel(q.get('tab'))) {
          const want = q.get('tab'); let tries = 0;
          const t = setInterval(() => {
            if (document.querySelector(`.tab-btn.active[data-tab="${want}"]`) && !document.getElementById('sftkConfirmGo')) { clearInterval(t); _tab = want; button(); open(want); }
            else if (++tries > 40) clearInterval(t);
          }, 250);
        }
      } catch (_) { /* no query string outside the extension page */ }
    });
    try {
      chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.sftk_history) refreshAll(); });
    } catch (_) { /* no storage events outside the extension page */ }
  }

  if (typeof window !== 'undefined') {
    window.sftkToolHistorySetTab = setTab;
    window.sftkToolHistoryInline = inline;
    window.sftkToolHistoryOpen = open;
  }
})();
