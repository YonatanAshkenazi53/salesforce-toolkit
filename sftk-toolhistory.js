'use strict';
// ── A Toolkit tool's own history (popup.html) ─────────────────────────────
// User 2026-10-05, looking at Data Studio › History full of Field Cleaner
// entries: "i think seeing field cleaner history on the data deployment
// history is confusing, it should show under the field cleaner".
//
// A change made by a Toolkit tool is still ONE entry in the shared history
// list (sftk-history.js: what was written, what the org showed, the undo).
// What changed is where it is shown: in the tool that made it —
//   • the tool's own window (sftkToolHistoryOpen), opened from Activity — the
//     tool's changes with ↩ Undo and ⬇ Report, ⬇ Back up, ⬆ Restore, 🗑 Clear;
//   • for a tool that has room for it, a list inside the tool
//     (sftkToolHistoryInline — Field Cleaner mounts it under its results).
// Owner 2026-11-16: "why do we need both history and activity" · "i dont want
// all the history displayed here, only the history of the last run … if i go
// and delete another field, it should display only the new field … and all
// of them under the activity or history, i prefer to remain with the
// activity" — so the top bar has ONE button, Activity; the "History (N)"
// button is never shown, and the list inside a tool is about the thing in
// front of the user (inline's `subject`), not about everything ever done.
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

  const labelOf = tab => String(tab) === '*' ? 'the Toolkit' : sftkHistoryTabLabel(tab);
  async function entriesFor(tab, subject) {
    const all = (typeof sftkHistoryAll === 'function') ? await sftkHistoryAll() : [];
    const list = sftkHistoryForTab(all, tab);
    return subject === undefined ? list : sftkHistoryForSubject(list, subject);
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
        ${st.show ? `<button class="btn btn-sm ${st.disabled ? 'btn-secondary' : 'btn-danger'} sftk-th-undo" ${st.disabled ? 'disabled' : ''} data-th-undo="${esc(e.id)}" title="${esc(st.title || '')}">${esc(st.label)}</button>${st.disabled && st.title ? `<span class="sftk-th-why">${esc(st.title)}</span>` : ''}` : ''}
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
  async function render(host, tab, after, subject) {
    if (!host) return 0;
    const list = await entriesFor(tab, subject);
    host.setAttribute('data-sftk-th', tab);
    if (!list.length) { host.innerHTML = ''; return 0; }
    const all = _showAll.has(tab);
    const shown = all ? list : list.slice(0, SHOWN);
    host.innerHTML = `${shown.map(cardHtml).join('')}
      ${list.length > shown.length ? `<button class="btn btn-sm btn-secondary" data-th-more="1">Show all ${list.length}</button>` : ''}`;
    host.querySelector('[data-th-more]')?.addEventListener('click', () => { _showAll.add(tab); render(host, tab, after, subject); });
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
      if (typeof after === 'function') after(r); else render(host, tab, after, subject);
    }));
    return list.length;
  }

  // ── ⬇ Back up / ⬆ Restore (owner 2026-11-16: "and a way for users to backup their activity … along with undo") ──
  const TIP_BACKUP = 'Downloads a file with every change listed here and what each Undo needs. Keep it private: it holds the earlier state of what was changed';
  const TIP_RESTORE = 'Reads a backup file of this tool and adds the changes that are not listed here — each with its Undo';
  const TIP_CLEAR = 'Removes these entries from this browser. Nothing in Salesforce is changed; their Undo goes with them unless you back them up first';
  const _note = new Map();               // tab → the sentence the last back up / restore / clear ended with
  const say = (tab, text, bad) => { _note.set(tab, { text, bad: !!bad }); refreshAll(); };
  const noteHtml = tab => { const n = _note.get(tab); return n ? `<div class="sftk-th-note${n.bad ? ' sftk-th-note-bad' : ''}" role="status">${esc(n.text)}</div>` : ''; };
  async function backup(tab) {
    const all = (typeof sftkHistoryAll === 'function') ? await sftkHistoryAll() : [];
    const file = sftkHistoryBackupOf(all, tab, new Date().toISOString());
    if (!file.count) return 0;
    const blob = new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `toolkit-history-${String(tab) === '*' ? 'all' : String(tab)}-${file.exportedAt.slice(0, 10)}.json`;   // '*' is not a file name on Windows
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    say(tab, `⬇ Backed up ${file.count.toLocaleString('en-US')} change${file.count === 1 ? '' : 's'} with their Undo — ${a.download}, in your Downloads folder.`);
    return file.count;
  }
  function restore(tab) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json'; inp.style.display = 'none';
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0]; inp.remove();
      if (!f) return;
      let text = '';
      try { text = await f.text(); } catch (e) { say(tab, `⚠ ${f.name} could not be read — ${String((e && e.message) || e)}`, true); return; }
      const r = sftkHistoryBackupRead(text, tab);
      if (!r.ok) { say(tab, `⚠ ${f.name}: ${r.why}`, true); return; }
      const res = await sftkHistoryRestoreBackup(r.entries, new Date().toISOString());
      const n = res.added;
      say(tab, (n ? `⬆ Restored ${n.toLocaleString('en-US')} change${n === 1 ? '' : 's'} from ${f.name}, each with its Undo` : `Nothing to restore from ${f.name}`)
        + (res.skipped ? ` · ${res.skipped.toLocaleString('en-US')} already listed here` : '')
        + (r.dropped ? ` · ${r.dropped.toLocaleString('en-US')} left out (not a change of this tool)` : '')
        + (res.archived ? ` · the ${res.archived.toLocaleString('en-US')} oldest went to the archive: the list keeps ${SFTK_HISTORY_CAP}` : '') + '.');
    });
    document.body.appendChild(inp); inp.click();
  }

  // ── 🗑 Clear history (owner 2026-11-16: "we should add a button that clears the history") ──
  // One tool's own entries, after one confirmation that says what goes with them: the ↩ Undo of every change listed.
  async function clear(tab, after) {
    const list = await entriesFor(tab);
    if (!list.length) return;
    const undoable = list.filter(e => !e.undoOf && typeof sftkToolUndoState === 'function' && !sftkToolUndoState(e).disabled).length;
    const label = labelOf(tab), n = list.length, s = n === 1 ? '' : 's';
    const sure = typeof sftkConfirmDestructive !== 'function' ? true : await sftkConfirmDestructive({
      title: `Clear history — ${n.toLocaleString('en-US')} change${s} made with ${label}`,
      icon: '🗑',
      items: [{ label: `${n.toLocaleString('en-US')} history entr${n === 1 ? 'y' : 'ies'} of ${label}`, sub: 'in every org' }],
      revOverride: {
        html: 'Removes the <strong>record</strong> of these changes from this browser. Nothing in Salesforce is changed.'
          + (undoable ? ' To keep their Undo in a file, cancel and use ⬇ Back up first.' : '') + (undoable ? ` <strong>${undoable.toLocaleString('en-US')} of them can still be undone</strong> — after this, ${undoable === 1 ? 'it' : 'they'} cannot: the earlier state is kept in the entry.` : ' None of them can be undone any more.')
          + (String(tab) === '*' ? ' Deployments and their restore points stay — they are cleared in Data Studio › History.' : ' The history of the other tools and of deployments stays.'),
        needsCheckbox: undoable > 0,
        ack: 'I understand the Undo of these changes goes with them',
      },
      confirmLabel: '🗑 Clear history',
    });
    if (!sure) { if (typeof after === 'function') after(false); return; }
    const gone = await sftkHistoryClearTab(tab);
    _showAll.delete(tab); _said.clear();
    say(tab, `🗑 History cleared — ${gone.toLocaleString('en-US')} entr${gone === 1 ? 'y' : 'ies'} removed from this browser. Nothing in Salesforce was changed.`);
    if (typeof after === 'function') after(true);
  }

  // ── inside a tool ──
  // `host` gets a folded section; nothing when there is nothing to list.
  //   opts.subject: () => what the tool is working on now ("Account.Field__c"). With it the list is ONLY the changes
  //   made about that — and, with nothing picked, about what was changed last (owner 2026-11-16: "only the history of
  //   the last run should be displayed here"). Everything else is in Activity; the section says so and opens it.
  const _inlineOpts = new WeakMap();
  async function inline(host, tab, opts) {
    if (!host) return;
    if (opts) _inlineOpts.set(host, opts);
    const o = _inlineOpts.get(host) || {};
    // marked even while empty: the first change of this session must find it (refreshAll)
    host.setAttribute('data-sftk-th-inline', tab);
    const all = await entriesFor(tab);
    let subject, list = all;
    if (typeof o.subject === 'function') {
      subject = String(o.subject() || '') || String((all.find(e => e && e.subject) || {}).subject || '');
      list = sftkHistoryForSubject(all, subject);
    }
    // nothing listed: nothing drawn
    if (!list.length) { host.innerHTML = ''; return; }
    const open = !!host.querySelector('details')?.open;
    const rest = all.length - list.length;
    host.innerHTML = `<details class="sftk-th-inline" ${open ? 'open' : ''}>
        <summary>🧾 ${subject !== undefined
          ? `Changes made here for <code>${esc(subject)}</code> — ${list.length.toLocaleString('en-US')}`
          : `History — ${list.length.toLocaleString('en-US')} change${list.length === 1 ? '' : 's'} made with ${esc(sftkHistoryTabLabel(tab))}`}</summary>
        ${subject !== undefined ? `<div class="sftk-th-bar"><span class="sftk-th-note">Only this field's changes are listed here${rest ? ` — ${rest.toLocaleString('en-US')} more, made for other fields, are in Activity` : ''}.</span><button type="button" class="btn btn-sm btn-secondary" data-th-activity="1" title="Everything the Toolkit and Data Studio did — undo, back up, restore, clear">🧾 Open Activity</button></div>` : ''}
        <div class="sftk-th-list"></div>
      </details>`;
    host.querySelector('[data-th-activity]')?.addEventListener('click', () => document.getElementById('sftkFeedBtn')?.click());
    await render(host.querySelector('.sftk-th-list'), tab, () => inline(host, tab), subject);
  }

  // ── the top bar ── one button for what was done: Activity (owner 2026-11-16). The tool's own "History (N)" button
  // is kept hidden; its markup stays for the top bar's width rules.
  function button() { const b = document.getElementById('sftkThBtn'); if (b) b.style.display = 'none'; }
  async function open(tab) {
    const t = tab || _tab; if (!t || typeof showModal !== 'function') return;
    if (t !== '*' && !sftkHistoryTabLabel(t)) return;
    showModal(`<div class="modal-header">🧾 ${t === '*' ? 'Toolkit changes — back up, restore, clear' : `History — ${esc(sftkHistoryTabLabel(t))}`}</div>
      <div class="sftk-th-intro">${t === '*' ? 'Every change made with a Toolkit tool, newest first. Deployments are in Data Studio › History.' : 'Every change this tool made, newest first. A change made by another tool is in that tool; deployments are in Data Studio › History.'}</div>
      <div id="sftkThModalNote">${noteHtml(t)}</div><div class="sftk-th-list sftk-th-modal" id="sftkThModalList"></div>
      <div class="modal-actions sftk-th-actions"><span class="sftk-th-acts"><button class="btn btn-secondary" id="sftkThBackup" style="display:none" title="${TIP_BACKUP}">⬇ Back up</button><button class="btn btn-secondary" id="sftkThRestore" title="${TIP_RESTORE}">⬆ Restore a backup</button><button class="btn btn-secondary sftk-th-clear" id="sftkThClear" style="display:none" title="${TIP_CLEAR}">🗑 Clear history</button></span><button class="btn btn-secondary" id="sftkThClose">Close</button></div>`);
    const box = document.getElementById('modalBox'); if (box) box.style.width = 'min(860px, 94vw)';
    document.getElementById('sftkThClose')?.addEventListener('click', () => closeModal());
    const n = await render(document.getElementById('sftkThModalList'), t, () => open(t));
    const cb = document.getElementById('sftkThClear');
    // the confirmation uses the page's one dialog: this list steps aside, and comes back when it was not cleared
    const bb = document.getElementById('sftkThBackup'); if (bb && n) { bb.style.display = ''; bb.addEventListener('click', () => backup(t)); }
    document.getElementById('sftkThRestore')?.addEventListener('click', () => restore(t));
    if (cb && n) { cb.style.display = ''; cb.addEventListener('click', () => { closeModal(); clear(t, done => { if (!done) open(t); }); }); }
    if (!n) { const l = document.getElementById('sftkThModalList'); if (l) l.innerHTML = `<div class="sftk-th-sub">${t === '*' ? 'No Toolkit change is listed.' : 'This tool has made no change yet.'}</div>`; }
  }

  // The popup tells this module which tool is open (navigateToTab / showHomePage).
  function setTab(tab) { _tab = sftkHistoryTabLabel(tab) ? String(tab) : ''; button(); }

  function refreshAll() {
    button();
    document.querySelectorAll('[data-sftk-th-inline]').forEach(h => inline(h, h.getAttribute('data-sftk-th-inline')));
    const m = document.getElementById('sftkThModalList'); if (m && m.getAttribute('data-sftk-th')) open(m.getAttribute('data-sftk-th'));
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
    window.sftkToolHistoryManage = () => open('*');   // Activity's "Back up · Restore · Clear"
  }
})();
