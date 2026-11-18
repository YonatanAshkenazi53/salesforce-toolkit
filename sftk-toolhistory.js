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
//   (a list inside the tool's own page existed until 2026-11-16; the owner took it off: Activity has it).
// Owner 2026-11-16: "why do we need both history and activity" · "i dont want
// all the history displayed here, only the history of the last run … if i go
// and delete another field, it should display only the new field … and all
// of them under the activity or history, i prefer to remain with the
// activity" — so the top bar has ONE button, Activity; the "History (N)"
// button is gone, and the list inside a tool is about the thing in
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
  let _find = '';                        // what the window's filter box holds
  let _askDel = '';                      // the entry whose 🗑 was pressed and waits for its "yes"
  // does a card answer the filter? every word typed must be somewhere in its title, its org or its lines
  function matches(e, q) {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = [e.profileName, e.tool, e.status, orgName(e.targetOrg), ...(Array.isArray(e.what) ? e.what.map(w => w.text || w.describe) : [])].join(' ').toLowerCase();
    return words.every(w => hay.includes(w));
  }

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
    // THE CARD (owner 2026-11-18, on the window as it was: "we need some better ui" · "allow deletion of individuals").
    // One line says what and where; the lines under it say what the org showed. On the right: ↩ Undo only when it
    // can be undone (why it cannot is said once, under the card — not on a dead button and again below), ⬇ the
    // entry as a file, 🗑 this entry out of the list.
    const canUndo = st.show && !st.disabled;
    const why = e.undoOf ? '' : (e.toolUndo && e.toolUndo.done) ? `↩ ${e.toolUndo.done.ok ? 'Undone and verified' : 'An undo was run — not every step was confirmed'} on ${String(e.toolUndo.done.at || '').slice(0, 16).replace('T', ' ')}`
      : (e.toolUndo && e.toolUndo.none) ? `No undo — ${e.toolUndo.none}` : (st.show && st.disabled) ? String(st.title || '') : '';
    const asking = _askDel === e.id;
    return `<div class="sftk-th-card sftk-th-is-${esc(e.status || 'failed')}${e.undoOf ? ' sftk-th-is-undo' : ''}" data-th-id="${esc(e.id)}">
      <div class="sftk-th-head">
        <span class="sftk-th-ico" title="${esc(e.status || 'failed')}">${badge}</span>
        <span class="sftk-th-main">
          <span class="sftk-th-title">${e.undoOf ? '<span class="sftk-th-chip" title="This entry is the undo of an earlier change — it has no undo of its own; redo the change from the tool.">↩ undo of</span> ' : ''}${kind ? `<span class="sftk-th-kind">${esc(kind)}</span> ` : ''}${esc(subject)}</span>
          <span class="sftk-th-meta">${detail ? `<span class="sftk-th-detail" title="${esc(detail)}">${esc(detail)}</span> · ` : ''}<span title="${esc(e.startedAt || '')}">${esc(sftkHistoryAgo(e.startedAt, Date.now()))}</span> · ${esc(orgName(e.targetOrg))}</span>
        </span>
        <span class="sftk-th-btns">${asking
          ? `<span class="sftk-th-ask">${canUndo ? 'Its Undo goes with it. ' : ''}Delete this entry?</span><button class="btn btn-sm btn-danger" data-th-del-yes="${esc(e.id)}">Delete</button><button class="btn btn-sm btn-secondary" data-th-del-no="1">Keep</button>`
          : `${canUndo ? `<button class="btn btn-sm btn-primary sftk-th-undo" data-th-undo="${esc(e.id)}" title="${esc(st.title || '')}">${esc(st.label)}</button>` : ''}<button class="sftk-th-icon" data-th-report="${esc(e.id)}" title="Download this entry as a JSON file: what was written, where, when, and what the org showed." aria-label="Download this entry as a file">⬇</button><button class="sftk-th-icon sftk-th-del" data-th-del="${esc(e.id)}" title="Delete this entry from the list. Nothing in Salesforce is changed${canUndo ? '; its Undo goes with it' : ''}." aria-label="Delete this entry">🗑</button>`}</span>
      </div>
      <div class="sftk-th-what">
        ${!what.length ? '<div>— nothing was written</div>'
          : what.length <= 2 ? what.map(line).join('')
          : `<details class="sftk-th-more"><summary>${okN === what.length ? `all ${what.length} steps verified by re-reading the org` : `${okN} of ${what.length} steps verified`} — show them</summary>${what.map(line).join('')}</details>`}
        ${said ? `<div class="sftk-th-said">${esc(said)}</div>` : ''}
      </div>
      ${why ? `<div class="sftk-th-foot">${esc(why)}</div>` : ''}
    </div>`;
  }

  // The list of one tool, into `host`. after(): what to do once an undo ended
  // (the modal re-opens itself; an inline list just redraws).
  async function render(host, tab, after, subject) {
    if (!host) return 0;
    const every = await entriesFor(tab, subject);
    host.setAttribute('data-sftk-th', tab);
    const inModal = host.id === 'sftkThModalList';
    const list = inModal ? every.filter(e => matches(e, _find)) : every;
    const cnt = inModal ? document.getElementById('sftkThCount') : null;
    if (cnt) cnt.textContent = !every.length ? '' : list.length === every.length ? `${every.length.toLocaleString('en-US')} change${every.length === 1 ? '' : 's'}` : `${list.length.toLocaleString('en-US')} of ${every.length.toLocaleString('en-US')}`;
    if (!every.length) { host.innerHTML = ''; return 0; }
    if (!list.length) { host.innerHTML = '<div class="sftk-th-sub">Nothing here matches the filter.</div>'; return every.length; }
    const all = _showAll.has(tab) || (inModal && !!_find.trim());
    const shown = all ? list : list.slice(0, SHOWN);
    host.innerHTML = `${shown.map(cardHtml).join('')}
      ${list.length > shown.length ? `<button class="btn btn-sm btn-secondary" data-th-more="1">Show all ${list.length}</button>` : ''}`;
    host.querySelector('[data-th-more]')?.addEventListener('click', () => { _showAll.add(tab); render(host, tab, after, subject); });
    // 🗑 on a card: asked on the card itself, then only that entry leaves the list
    host.querySelectorAll('[data-th-del]').forEach(b => b.addEventListener('click', () => { _askDel = b.dataset.thDel; render(host, tab, after, subject); }));
    host.querySelector('[data-th-del-no]')?.addEventListener('click', () => { _askDel = ''; render(host, tab, after, subject); });
    host.querySelector('[data-th-del-yes]')?.addEventListener('click', async ev => {
      const id = ev.currentTarget.dataset.thDelYes; _askDel = '';
      ev.currentTarget.disabled = true;
      const gone = typeof sftkHistoryRemove === 'function' ? await sftkHistoryRemove(id) : false;
      _said.delete(id);
      if (!gone) say(tab, '⚠ That entry was not found in the list any more.', true);
      else render(host, tab, after, subject);      // the storage event redraws the window too; this is for a page without it
    });
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
    return every.length;
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
    a.href = url; a.download = `toolkit-history-${String(tab) === '*' ? 'all' : String(tab)}-${sftkLocalDay()}.json`;   // '*' is not a file name on Windows
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
      title: `Clear activity — ${n.toLocaleString('en-US')} change${s} made with ${label}`,
      icon: '🗑',
      items: [{ label: `${n.toLocaleString('en-US')} activity entr${n === 1 ? 'y' : 'ies'} of ${label}`, sub: 'in every org' }],
      revOverride: {
        html: 'Removes the <strong>record</strong> of these changes from this browser. Nothing in Salesforce is changed.'
          + (undoable ? ' To keep their Undo in a file, cancel and use ⬇ Back up first.' : '') + (undoable ? ` <strong>${undoable.toLocaleString('en-US')} of them can still be undone</strong> — after this, ${undoable === 1 ? 'it' : 'they'} cannot: the earlier state is kept in the entry.` : ' None of them can be undone any more.')
          + (String(tab) === '*' ? ' Deployments and their restore points stay — they are cleared in Data Studio › History.' : ' The history of the other tools and of deployments stays.'),
        needsCheckbox: undoable > 0,
        ack: 'I understand the Undo of these changes goes with them',
      },
      confirmLabel: '🗑 Clear activity',
    });
    if (!sure) { if (typeof after === 'function') after(false); return; }
    const gone = await sftkHistoryClearTab(tab);
    _showAll.delete(tab); _said.clear();
    say(tab, `🗑 Activity cleared — ${gone.toLocaleString('en-US')} entr${gone === 1 ? 'y' : 'ies'} removed from this browser. Nothing in Salesforce was changed.`);
    if (typeof after === 'function') after(true);
  }

  // ── the top bar ── one button for what was done: Activity (owner 2026-11-16); the tool's own "History (N)" button
  // is gone. This window is opened from Activity ("this tool only"), from a row's ↩ Undo, and by a link from Data Studio.
  async function open(tab) {
    const t = tab || _tab; if (!t || typeof showModal !== 'function') return;
    if (t !== '*' && !sftkHistoryTabLabel(t)) return;
    showModal(`<div class="sftk-th-top">
        <div class="sftk-th-top-t"><span class="sftk-th-top-name">🧾 ${t === '*' ? 'Toolkit changes' : `Activity — ${esc(sftkHistoryTabLabel(t))}`}</span><span class="sftk-th-count" id="sftkThCount"></span></div>
        <button type="button" class="sftk-cf-x" id="sftkThClose" aria-label="Close" title="Close">✕</button>
      </div>
      <div class="sftk-th-tools">
        <input type="search" class="sftk-th-find" id="sftkThFind" placeholder="Filter — a name, a kind, an org…" aria-label="Filter the list" autocomplete="off" spellcheck="false">
        <span class="sftk-th-acts"><button class="btn btn-sm btn-secondary" id="sftkThBackup" style="display:none" title="${TIP_BACKUP}">⬇ Back up</button><button class="btn btn-sm btn-secondary" id="sftkThRestore" title="${TIP_RESTORE}">⬆ Restore a backup</button><button class="btn btn-sm btn-secondary sftk-th-clear" id="sftkThClear" style="display:none" title="${TIP_CLEAR}">🗑 Clear all</button></span>
      </div>
      <div class="sftk-th-intro">${t === '*' ? 'Every change made with a Toolkit tool, newest first. Deployments are in Data Studio › History.' : 'Every change this tool made, newest first. A change made by another tool is in that tool; deployments are in Data Studio › History.'}</div>
      <div id="sftkThModalNote">${noteHtml(t)}</div><div class="sftk-th-list sftk-th-modal" id="sftkThModalList"></div>`);
    const box = document.getElementById('modalBox'); if (box) box.style.width = 'min(860px, 94vw)';
    document.getElementById('sftkThClose')?.addEventListener('click', () => closeModal());
    const find = document.getElementById('sftkThFind');
    if (find) {
      find.value = _find;
      find.addEventListener('input', () => { _find = find.value; _askDel = ''; render(document.getElementById('sftkThModalList'), t, () => open(t)); });
    }
    const n = await render(document.getElementById('sftkThModalList'), t, () => open(t));
    const cb = document.getElementById('sftkThClear');
    // the confirmation uses the page's one dialog: this list steps aside, and comes back when it was not cleared
    const bb = document.getElementById('sftkThBackup'); if (bb && n) { bb.style.display = ''; bb.addEventListener('click', () => backup(t)); }
    document.getElementById('sftkThRestore')?.addEventListener('click', () => restore(t));
    if (cb && n) { cb.style.display = ''; cb.addEventListener('click', () => { closeModal(); clear(t, done => { if (!done) open(t); }); }); }
    if (!n) { const l = document.getElementById('sftkThModalList'); if (l) l.innerHTML = `<div class="sftk-th-sub">${t === '*' ? 'No Toolkit change is listed.' : 'This tool has made no change yet.'}</div>`; }
  }

  // The popup tells this module which tool is open (navigateToTab / showHomePage).
  function setTab(tab) { _tab = sftkHistoryTabLabel(tab) ? String(tab) : ''; }

  function refreshAll() {
    const m = document.getElementById('sftkThModalList'); if (m && m.getAttribute('data-sftk-th')) open(m.getAttribute('data-sftk-th'));
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
      // Data Studio › History links here: popup.html?tab=fields&history=1
      try {
        const q = new URLSearchParams(location.search);
        if (q.get('history') === '1' && sftkHistoryTabLabel(q.get('tab'))) {
          const want = q.get('tab'); let tries = 0;
          const t = setInterval(() => {
            if (document.querySelector(`.tab-btn.active[data-tab="${want}"]`) && !document.getElementById('sftkConfirmGo')) { clearInterval(t); _tab = want; open(want); }
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
    window.sftkToolHistoryOpen = open;
    window.sftkToolHistoryManage = () => open('*');   // Activity's "Back up · Restore · Clear"
  }
})();
