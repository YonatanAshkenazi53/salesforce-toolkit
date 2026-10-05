'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// ↩ ROLL BACK — a page, like Deploy (campaign 4 phase 7)
// ═══════════════════════════════════════════════════════════════════════════
// User 2026-10-02: "The rollback screen is not great. we should make it open
// a reconcile screen, like the deployment screen, with all the features
// there." and, on the History card: "there's no info on the operation, who
// got deleted, etc".
//
// Two modes on one view ('rollback'):
//   PLAN   — opened from a run's ↩ button. The planner (sftkUndoBuildPlan,
//            studio-undo.js) reads the restore point and the org(s); the page
//            shows what the run did per object, names every record under
//            tabs (To delete · To restore · Kept · Left alone · Not
//            restorable), lets the user untick, asks ONCE (shared dialog),
//            runs with the live run view, then shows the result.
//   REPORT — opened from a rollback's History card: the same tabs, read-only,
//            every record the rollback deleted / restored / failed, by name.
//            When the entry has no names for what it deleted (an older
//            rollback, counts-only mode, more than History keeps), the list
//            is read from the org's Recycle Bin (_rbBinRead).
// Everything the run did is TICKED by default — a rollback's purpose is all of
// it; unticking is the exception (said in the intro).

let _rb = null;   // { report, loaded|entry, ctx, building, failed, prepLines, sel, objKey, tab, filter, window, executing, result }
const SFTK_RB_WINDOW = 300;

window.openRollback = async function(runId, opts) {
  const report = !!(opts && opts.report);
  if (report) {
    const entry = (typeof _sftkUndoAllEntries === 'function' ? _sftkUndoAllEntries() : _history).find(h => h && h.id === runId);
    if (!entry) { showToast('That rollback is no longer in History.', 'error', 4000); return; }
    _rb = { report: true, entry, objKey: '', tab: 'deleted', filter: '', window: SFTK_RB_WINDOW };
  } else {
    const loaded = await sftkUndoLoadRun(runId);
    if (loaded.error) { showToast(loaded.error, 'error', 6000); return; }
    _rb = { report: false, runId, loaded, ctx: null, building: false, failed: false, prepLines: [], sel: {}, objKey: '', tab: 'del', filter: '', window: SFTK_RB_WINDOW, executing: false, result: null };
  }
  // A transient sub-view like reconcile / deploy: not hash-routed (DS_HASH_VIEWS
  // would reject it), rendered directly; History stays the active nav item.
  document.querySelectorAll('.ds-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'history'));
  _currentView = 'rollback';
  renderRollback();
};

function renderRollback() {
  if (!_rb) { navigateToView('history'); return; }
  if (_rb.report) return _rbRenderReport();
  if (!_rb.ctx) return _rbRenderPreparing();
  _rbRenderPlan();
}

// ── helpers ─────────────────────────────────────────────────────────────────
const _rbRecUrl = (org, id) => `${esc(String(org || '').replace(/\/$/, ''))}/lightning/r/${esc(id)}/view`;
const _rbBinUrl = org => `${esc(String(org || '').replace(/\/$/, ''))}/lightning/o/DeleteEvent/home`;
function _rbLogRow(el, icon, msg, cls) {
  if (!el) return;
  const row = document.createElement('div');
  row.className = `ds-prog-row ${cls || ''}`;
  row.textContent = `${icon} ${msg}`;
  el.appendChild(row);
  el.scrollTop = el.scrollHeight;
}
function _rbWhen(iso) { return iso ? new Date(iso).toLocaleString() : '?'; }
function _rbHeader(title, subtitle, extra) {
  return dsViewHeader({
    icon: 'scroll',
    back: `<button class="ds-back-link" id="dsRbBack" title="Back to History">‹ Back to History</button>`,
    title,
    help: 'A rollback puts the org back the way the restore point saw it: records the run created are deleted (to the Recycle Bin), records it overwrote get their values back. Records other people created or edited after the run are left alone. Records the run deleted cannot be re-created here — the Recycle Bin can, within 15 days.',
    subtitle,
    actions: extra || '',
  });
}
function _rbWireBack() { eid('dsRbBack')?.addEventListener('click', () => navigateToView('history')); }

// ── PLAN mode: preparing ───────────────────────────────────────────────────
function _rbRenderPreparing() {
  const me = _rb; const { run, ev } = me.loaded;
  setMain(`${_rbHeader(`↩ Roll back — ${esc(run.profileName || ev.profileName || 'run')}`, `run ${esc(_rbWhen(run.completedAt || run.startedAt))} · restore point ${esc(_rbWhen(ev.capturedAt))}`)}
    <div class="ds-dep-page">
      <div class="ds-rec-card ${me.failed ? 'ds-rec-card-bad' : ''}">
        <div class="ds-rec-card-hd"><span class="ds-rec-card-ico">${me.failed ? '❌' : '🔎'}</span><span class="ds-rec-card-title">${me.failed ? 'The rollback could not be prepared' : 'Reading the restore point and the org…'}</span></div>
        <div class="ds-rec-card-line">${me.failed ? 'Nothing was written. The lines below say why; fix it and press ↩ Roll back on the History card again.' : 'Nothing is written on this page until you confirm. First the org is read again and compared with the restore point, so every record this rollback would touch can be named.'}</div>
        <div id="dsRbPrepLog" class="ds-rec-progress"></div>
      </div>
    </div>`);
  _rbWireBack();
  const el = eid('dsRbPrepLog');
  for (const [i, m, c] of me.prepLines) _rbLogRow(el, i, m, c);
  if (me.building || me.failed) return;
  me.building = true;
  const io = {
    log: (icon, msg, cls) => { me.prepLines.push([icon, msg, cls]); _rbLogRow(eid('dsRbPrepLog'), icon, msg, cls); },
    alive: () => _rb === me && _currentView === 'rollback',
  };
  sftkUndoBuildPlan(me.loaded, io).then(ctx => {
    if (_rb !== me) return;
    me.building = false;
    if (!ctx) { me.failed = true; if (_currentView === 'rollback') renderRollback(); return; }
    me.ctx = ctx;
    // Defaults: everything the run did is ticked; "delete anyway" is not.
    for (const it of ctx.plan) {
      if (it.refused) continue;
      me.sel[it.key] = { del: new Set(it.scoped.created), res: new Set(it.scoped.changed.map(c => c.id)), force: new Set() };
    }
    const first = ctx.plan.find(it => !it.refused && (it.scoped.created.length || it.scoped.changed.length)) || ctx.plan.find(it => !it.refused) || ctx.plan[0];
    me.objKey = first ? first.key : '';
    me.tab = first && !first.scoped?.created?.length && first.scoped?.changed?.length ? 'res' : 'del';
    if (_currentView === 'rollback') renderRollback();
  });
}

// ── PLAN mode: the page ────────────────────────────────────────────────────
function _rbBuckets(it) {
  // Every bucket as rows { id, name, row, note }, from the planner's data.
  const nowRow = id => it.nowById && it.nowById.get(id);
  const wasRow = id => it.before && it.before.byId && it.before.byId[id];
  const name = (id) => sftkUndoRowLabel(nowRow(id)) || sftkUndoRowLabel(wasRow(id)) || id;
  return {
    del:   (it.scoped.created || []).map(id => ({ id, name: name(id), note: 'created by the run → deleted (Recycle Bin)' })),
    res:   (it.scoped.changed || []).map(c => ({ id: c.id, name: name(c.id), fields: c.fields || [], before: c.before, now: nowRow(c.id), note: `overwritten by the run → ${(c.fields || []).length} field(s) restored` })),
    kept:  (it.keptIds || []).map(id => ({ id, name: name(id), note: it.cascadeUnknown && it.cascadeUnknown.length
              ? `kept — could not check what hangs under it (${it.cascadeUnknown.join(', ')})`
              : `kept — other records were added under it after the run (${(it.cascadeNotes || []).join(', ')})`, forceable: !!(it.cascadeUnknown && it.cascadeUnknown.length) }))
           .concat((it.personIds || []).map(id => ({ id, name: name(id), note: 'person-account contact — goes with its Account, not deleted on its own' }))),
    later: (it.scoped.createdLaterIds || []).map(id => ({ id, name: name(id), note: 'created after the run → left alone' }))
           .concat((it.scoped.changedLaterIds || []).map(id => ({ id, name: name(id), note: 'edited after the run → left alone' }))),
    gone:  ((it.diff && it.diff.deleted) || []).map(id => ({ id, name: name(id), note: 'deleted since the restore point → not restored here (Recycle Bin, within 15 days)', gone: true })),
  };
}
const _RB_TABS = [
  { k: 'del',   label: '🗑 To delete',      noun: 'to delete — created by the run' },
  { k: 'res',   label: '↩ To restore',      noun: 'to restore — overwritten by the run' },
  { k: 'kept',  label: '🛡 Kept',           noun: 'kept — not deleted, with the reason' },
  { k: 'later', label: '🕒 Left alone',     noun: 'left alone — created or edited after the run' },
  { k: 'gone',  label: '⚫ Not restorable', noun: 'deleted since the restore point — the Recycle Bin can restore them, this page cannot' },
];

function _rbPicks() {
  const picks = {};
  for (const [k, s] of Object.entries(_rb.sel || {})) picks[k] = { del: s.del, res: s.res, force: s.force };
  return picks;
}
function _rbTotals() {
  let del = 0, res = 0, force = 0;
  for (const s of Object.values(_rb.sel || {})) { del += s.del.size; res += s.res.size; force += s.force.size; }
  return { del, res, force, any: del + res + force > 0 };
}

function _rbRenderPlan() {
  const me = _rb; const ctx = me.ctx; const { run, ev, legs, plan } = ctx;
  const orgs = legs.map(l => orgLabel(l.orgUrl));
  const items = plan;
  const cur = items.find(it => it.key === me.objKey) || items[0];
  const totals = _rbTotals();
  const n = v => Number(v || 0).toLocaleString();
  const cell = (it, k, val, cls) => `<td class="ds-dep-num ${val ? (cls || '') : 'ds-dep-muted'}" data-rb-obj="${esc(it.key)}" data-rb-tab="${k}" title="Show these records">${n(val)}</td>`;
  const tableRows = items.map(it => it.refused
    ? `<tr><td><button class="ds-dep-objlink" data-rb-obj="${esc(it.key)}" data-rb-tab="del">${esc(it.key)}</button></td><td colspan="6" class="ds-dep-muted">❌ refused: ${esc(it.refused)} — not touched</td></tr>`
    : `<tr>
        <td><button class="ds-dep-objlink" data-rb-obj="${esc(it.key)}" data-rb-tab="del">${esc(it.key)}</button></td>
        ${cell(it, 'del', it.scoped.created.length, 'ds-dep-n-ext')}${cell(it, 'res', it.scoped.changed.length, 'ds-dep-n-chg')}${cell(it, 'kept', (it.keptIds || []).length + (it.personIds || []).length)}${cell(it, 'later', (it.scoped.createdLater || 0) + (it.scoped.changedLater || 0))}${cell(it, 'gone', it.p.goneCount)}<td class="ds-dep-num ds-dep-muted">${n(it.p.unchanged)}</td>
      </tr>`).join('');
  const legBlocks = legs.map(leg => `<details class="ds-rec-card ds-rb-leg"><summary class="ds-rec-card-title">⚙ Automation in ${esc(orgLabel(leg.orgUrl))} that can refuse the rollback or fire again ${prodBadge(leg.orgUrl)}</summary>${_sftkUndoAutoHtml(leg)}${_sftkUndoEndHtml(leg)}</details>`).join('');
  const verdict = _sftkUndoVerdictHtml(ctx);
  const goLabel = totals.any ? `↩ Roll back — delete ${n(totals.del + totals.force)} · restore ${n(totals.res)}` : '↩ Roll back';
  setMain(`${_rbHeader(`↩ Roll back — ${esc(run.profileName || ev.profileName || 'run')}`,
      `${esc(orgs.join(' + '))} · run ${esc(_rbWhen(run.completedAt || run.startedAt))} · restore point ${esc(_rbWhen(ev.capturedAt))}${ctx.prod ? ' · <span class="ds-org-badge-prod">production</span>' : ''}`)}
    <div class="ds-dep-page">
      <div class="ds-rec-card ds-rb-intro"><div class="ds-rec-card-line"><b>Everything the run did is ticked.</b> Untick a record to keep it as it is now. Records other people created or edited after the run are already left alone (🕒). Records the run deleted cannot be re-created here (⚫) — the Recycle Bin can, within 15 days. Anything anyone created or edited between the restore point (${esc(_rbWhen(ev.capturedAt))}) and the end of the run cannot be told apart from the run's own writes and is included. Nothing is written until you confirm below.${ctx.prod ? ` 🛑 <b>${esc(ctx.typedWord)}</b> is production, or guarded as production, so the word to type is its name.` : ''}</div></div>
      <div class="ds-rec-card"><div class="ds-rec-card-hd"><span class="ds-rec-card-ico">📋</span><span class="ds-rec-card-title">What this rollback does</span><span class="ds-dep-orgs-hint">every number opens its records</span></div>
        <table class="ds-dep-plan"><thead><tr><th>object</th><th>🗑 to delete</th><th>↩ to restore</th><th>🛡 kept</th><th>🕒 left alone</th><th>⚫ deleted since</th><th>untouched</th></tr></thead><tbody>${tableRows}</tbody></table>
        ${items.filter(it => !it.refused && it.cascadeUnchecked && it.cascadeUnchecked.length).map(it => `<div class="ds-dep-note">ℹ ${esc(it.key)}: ${it.cascadeUnchecked.length} child object(s) could not be checked because Salesforce refuses to query them this way (${esc(it.cascadeUnchecked.join(', '))}) — they did not stop the deletion.</div>`).join('')}
        ${(() => {
          // Kept records stand in the way of their parents: Salesforce refuses to
          // delete an Account or Contact that still has Cases, an Opportunity with
          // line items, and so on (live 2026-10-02: 4 kept Cases → 3 Accounts and
          // 1 Contact "could not be completed because it is associated with the
          // following cases"). Said before the run, not after.
          const kept = items.filter(it => !it.refused && ((it.keptIds || []).length || (it.personIds || []).length));
          const dels = items.filter(it => !it.refused && it.scoped.created.length);
          if (!kept.length || !dels.length) return '';
          return `<div class="ds-dep-note">⚠ Kept records can block the deletion of the records they hang under — Salesforce refuses to delete a parent that still has, for example, Cases. ${esc(kept.map(it => `${(it.keptIds || []).length + (it.personIds || []).length} ${it.objType}`).join(', '))} kept here; if a parent delete is refused, open 🛡 Kept, tick "delete anyway" where offered, or untick the parent.</div>`;
        })()}
        ${items.filter(it => !it.refused && it.notCovered && it.notCovered.length).map(it => `<div class="ds-dep-note">⚠ ${esc(it.key)}: ${it.notCovered.length} writable field(s) were never captured and are NOT restored: ${esc(it.notCovered.join(', '))}.</div>`).join('')}
      </div>
      ${legBlocks}
      <details class="ds-rec-card ds-rb-leg" ${me.prepLines.some(l => /ds-prog-(warn|err)/.test(l[2] || '')) ? 'open' : ''}><summary class="ds-rec-card-title">🔎 How this plan was built — ${me.prepLines.length} line(s) from the re-read</summary><div class="ds-rec-progress" id="dsRbPrepLog"></div></details>
      ${verdict}
      ${cur && !cur.refused ? `<div class="ds-rec-card ds-rb-records">
        <div class="ds-dep-objbar"><span class="ds-dep-objlbl">object</span>${items.filter(it => !it.refused).map(it => `<button class="ds-dep-objbtn ${it.key === cur.key ? 'ds-dep-objbtn-on' : ''}" data-rb-obj="${esc(it.key)}" data-rb-tab="${me.tab}">${esc(it.key)}</button>`).join('')}</div>
        <div id="dsRbList"></div>
      </div>` : ''}
      <div class="ds-rec-card ds-rb-foot">
        <div class="ds-rb-foot-row">
          <span id="dsRbSummary">${totals.any ? `Delete <b>${n(totals.del + totals.force)}</b> · restore <b>${n(totals.res)}</b> in ${esc(orgs.join(' + '))}` : 'Nothing selected — tick records above.'}</span>
          <span class="ds-dep-sp"></span>
          <button class="ds-btn ds-btn-lg ds-btn-danger" id="dsRbGo" ${totals.any && !me.executing ? '' : 'disabled'}>${esc(goLabel)}</button>
        </div>
        ${_sftkUndoLimitsHtml()}
        <div id="dsRbLog" class="ds-rec-progress"></div>
        <div id="dsRbResult"></div>
      </div>
    </div>`);
  _rbWireBack();
  { const pl = eid('dsRbPrepLog'); for (const [i, m, c] of me.prepLines) _rbLogRow(pl, i, m, c); }
  document.querySelectorAll('[data-rb-obj]').forEach(el => el.addEventListener('click', () => {
    me.objKey = el.dataset.rbObj; me.tab = el.dataset.rbTab || me.tab; me.filter = ''; me.window = SFTK_RB_WINDOW;
    renderRollback();
    eid('dsRbList')?.scrollIntoView({ block: 'nearest' });
  }));
  eid('dsRbGo')?.addEventListener('click', _rbGo);
  if (cur && !cur.refused) _rbPaintList(cur);
}

function _rbPaintList(it) {
  const me = _rb; const host = eid('dsRbList'); if (!host) return;
  const buckets = _rbBuckets(it);
  const tabs = _RB_TABS.map(t => ({ ...t, n: buckets[t.k].length }));
  if (!tabs.some(t => t.k === me.tab)) me.tab = 'del';
  const tab = tabs.find(t => t.k === me.tab);
  const sel = me.sel[it.key] || { del: new Set(), res: new Set(), force: new Set() };
  const q = (me.filter || '').trim().toLowerCase();
  const all = buckets[me.tab];
  const rows = q ? all.filter(r => `${r.name} ${r.id}`.toLowerCase().includes(q)) : all;
  const shown = rows.slice(0, me.window);
  const org = it.leg.orgUrl;
  const selectable = me.tab === 'del' || me.tab === 'res';
  const on = r => me.tab === 'del' ? sel.del.has(r.id) : me.tab === 'res' ? sel.res.has(r.id) : me.tab === 'kept' ? sel.force.has(r.id) : false;
  const rowHtml = r => {
    const ctl = selectable
      ? `<input type="checkbox" class="ds-dep-cb" data-rb-pick="${me.tab}|${esc(r.id)}" ${on(r) ? 'checked' : ''} ${me.executing ? 'disabled' : ''} aria-label="${me.tab === 'del' ? 'delete' : 'restore'} ${esc(r.name)}">`
      : (me.tab === 'kept' && r.forceable ? `<input type="checkbox" class="ds-dep-cb" data-rb-pick="force|${esc(r.id)}" ${on(r) ? 'checked' : ''} ${me.executing ? 'disabled' : ''} title="Delete anyway — I checked what hangs under it" aria-label="delete anyway ${esc(r.name)}">` : '<span></span>');
    const mid = `<span class="ds-rec-pnote ${me.tab === 'kept' || me.tab === 'later' ? 'ds-rec-pnote-unknown' : ''}">${esc(r.note)}</span>${me.tab === 'kept' && r.forceable ? ' <span class="ds-rec-pnote">tick = delete anyway</span>' : ''}`;
    const tail = me.tab === 'res'
      ? `<button class="ds-dep-link" data-rb-compare="${esc(r.id)}" title="The record before the run (the restore point) and now, field by field">▸ before ↔ now</button> <span class="ds-dep-open"><a href="${_rbRecUrl(org, r.id)}" target="_blank" rel="noopener">open ↗</a></span>`
      : r.gone
        ? `<span class="ds-dep-open"><a href="${_rbBinUrl(org)}" target="_blank" rel="noopener" title="The Recycle Bin of ${esc(orgLabel(org))}">Recycle Bin ↗</a></span>`
        : `<span class="ds-dep-open"><a href="${_rbRecUrl(org, r.id)}" target="_blank" rel="noopener">open ↗</a></span>`;
    return `<div class="ds-dep-row ds-dep-row-amb">${ctl}<span class="ds-dep-key" title="${esc(r.id)}">${esc(r.name)}</span><span class="ds-dep-mid">${mid}</span><span class="ds-dep-tail">${tail}</span></div>`;
  };
  const nAll = rows.length.toLocaleString();
  const bulk = selectable && rows.length && !me.executing
    ? `<button class="ds-btn ds-btn-xs" data-rb-bulk="all">✓ All ${nAll}</button><button class="ds-btn ds-btn-xs" data-rb-bulk="none">✗ None</button>` : '';
  host.innerHTML = `
    <div class="ds-dep-tabs" role="tablist">${tabs.map(t => `<button role="tab" data-rb-tabsel="${t.k}" aria-selected="${t.k === me.tab}">${t.label} <b>${t.n.toLocaleString()}</b></button>`).join('')}</div>
    <div class="ds-dep-tools">
      <input type="search" id="dsRbFilter" class="ds-dep-filter" placeholder="🔍 filter by name or Id…" value="${esc(me.filter)}" aria-label="Filter records">
      <span>${rows.length.toLocaleString()} ${esc(it.objType)} ${esc(tab.noun)}</span>
      <span class="ds-dep-sp"></span>${bulk}
    </div>
    <div class="ds-dep-list">${shown.length ? shown.map(rowHtml).join('') : `<div class="ds-dep-empty">${q ? 'No record matches that filter.' : `Nothing ${esc(tab.noun)}.`}</div>`}</div>
    ${rows.length > shown.length ? `<div class="ds-dep-note ds-dep-more">Showing ${shown.length.toLocaleString()} of ${rows.length.toLocaleString()}
      <button class="ds-btn ds-btn-xs" data-rb-more="step">Show ${Math.min(SFTK_RB_WINDOW, rows.length - shown.length).toLocaleString()} more</button>
      <button class="ds-btn ds-btn-xs" data-rb-more="all">Show all ${rows.length.toLocaleString()}</button></div>` : ''}`;
  const repaint = () => { _rbPaintList(it); _rbRefreshFoot(); };
  host.querySelectorAll('[data-rb-tabsel]').forEach(b => b.addEventListener('click', () => { me.tab = b.dataset.rbTabsel; me.filter = ''; me.window = SFTK_RB_WINDOW; repaint(); }));
  const f = eid('dsRbFilter');
  f?.addEventListener('input', () => { me.filter = f.value; me.window = SFTK_RB_WINDOW; const pos = f.selectionStart; repaint(); const g = eid('dsRbFilter'); if (g) { g.focus(); try { g.setSelectionRange(pos, pos); } catch (_) {} } });
  host.querySelectorAll('[data-rb-pick]').forEach(cb => cb.addEventListener('change', () => {
    const [kind, id] = String(cb.dataset.rbPick).split('|');
    const set = kind === 'del' ? sel.del : kind === 'res' ? sel.res : sel.force;
    if (cb.checked) set.add(id); else set.delete(id);
    me.sel[it.key] = sel;
    _rbRefreshFoot();
  }));
  host.querySelectorAll('[data-rb-bulk]').forEach(b => b.addEventListener('click', () => {
    const set = me.tab === 'del' ? sel.del : sel.res;
    if (b.dataset.rbBulk === 'all') rows.forEach(r => set.add(r.id)); else rows.forEach(r => set.delete(r.id));
    me.sel[it.key] = sel; repaint();
  }));
  host.querySelectorAll('[data-rb-more]').forEach(b => b.addEventListener('click', () => {
    const list = host.querySelector('.ds-dep-list'); const top = list ? list.scrollTop : 0;
    me.window = b.dataset.rbMore === 'all' ? rows.length : me.window + SFTK_RB_WINDOW;
    _rbPaintList(it);
    const again = host.querySelector('.ds-dep-list'); if (again) again.scrollTop = top;
  }));
  host.querySelectorAll('[data-rb-compare]').forEach(b => b.addEventListener('click', () => {
    const r = buckets.res.find(x => x.id === b.dataset.rbCompare); if (!r) return;
    const fields = r.fields.filter(x => x !== 'Id' && x !== 'attributes' && x !== 'IsPersonAccount');
    const body = (typeof renderDriftCompareTable === 'function')
      ? renderDriftCompareTable(r.before || {}, r.now || {}, fields, fields, {}, null, { selectable: false })
      : `<pre>${esc(JSON.stringify({ before: r.before, now: r.now }, null, 2))}</pre>`;
    showModal(`<div class="ds-modal-header">▸ ${esc(it.objType)} · ${esc(r.name)} <span class="ds-dc-modal-sub">restore point (before the run) vs now — the rollback writes the left side back</span>
        <button class="ds-btn ds-btn-xs ds-dc-modal-close" data-dsaction="closeModal" title="Close">✕</button></div>
      <div class="ds-modal-body ds-dc-modal-body">${body}</div>`);
  }));
}

function _rbRefreshFoot() {
  const t = _rbTotals(); const n = v => Number(v || 0).toLocaleString();
  const orgs = (_rb.ctx.legs || []).map(l => orgLabel(l.orgUrl)).join(' + ');
  const s = eid('dsRbSummary'); if (s) s.innerHTML = t.any ? `Delete <b>${n(t.del + t.force)}</b> · restore <b>${n(t.res)}</b> in ${esc(orgs)}` : 'Nothing selected — tick records above.';
  const go = eid('dsRbGo'); if (go) { go.disabled = !t.any || _rb.executing; go.textContent = t.any ? `↩ Roll back — delete ${n(t.del + t.force)} · restore ${n(t.res)}` : '↩ Roll back'; }
}

// ── the one confirmation, then the run ──────────────────────────────────────
async function _rbGo() {
  const me = _rb; const ctx = me.ctx; if (!ctx || me.executing) return;
  const picks = _rbPicks(); const t = _rbTotals(); if (!t.any) return;
  const n = v => Number(v || 0).toLocaleString();
  const lines = ctx.plan.filter(it => !it.refused).map(it => {
    const s = me.sel[it.key] || { del: new Set(), res: new Set(), force: new Set() };
    const bits = [];
    if (s.del.size + s.force.size) bits.push(`delete ${n(s.del.size + s.force.size)}${s.force.size ? ` (${n(s.force.size)} "delete anyway")` : ''}`);
    if (s.res.size) bits.push(`restore ${n(s.res.size)}`);
    return bits.length ? { label: `${it.key} — ${bits.join(' · ')}`, sub: orgLabel(it.leg.orgUrl) } : null;
  }).filter(Boolean);
  const orgs = ctx.legs.map(l => orgLabel(l.orgUrl)).join(' + ');
  // confirmed-by: sftkConfirmDestructive below — the ONE confirmation; typed
  // ROLLBACK, or the org's name for production / unknown org types.
  const sure = await sftkConfirmDestructive({
    title: `↩ Roll back ${ctx.run.profileName || ctx.ev.profileName || 'this run'} in ${orgs}`, icon: '↩',
    items: lines,
    reversibility: 'recycle',
    undoHint: 'Deleted records go to the Recycle Bin (15 days). Restored values overwrite today’s values — the restore point keeps nothing newer, so write down anything you want to keep first.',
    confirmLabel: '↩ Roll back',
    typedWord: ctx.prod ? '' : 'ROLLBACK',
    production: ctx.prod ? { label: ctx.typedWord } : null,
  });
  if (!sure) return;
  me.executing = true;
  _rbRefreshFoot();
  document.querySelectorAll('#dsRbList input, [data-rb-bulk]').forEach(el => { el.disabled = true; });
  const logEl = eid('dsRbLog');
  if (logEl) logEl.innerHTML = '<div class="ds-prog-hdr">Rollback progress</div>';
  window._sftkRunActive = true; window._sftkRunLogNode = logEl;
  const io = { log: (i, m, c) => _rbLogRow(eid('dsRbLog') || logEl, i, m, c), alive: () => true, progress: sftkRunProgressHandler(logEl) };
  const res = await sftkUndoExecute(ctx, picks, io);
  window._sftkRunActive = false;
  me.executing = false; me.result = res;
  const out = eid('dsRbResult');
  if (out && res && res.results) {
    const chips = Object.entries(res.results).map(([k, r]) => `<span class="ds-summary-chip"><strong>${esc(k)}</strong> · ${r.deleted ? `<span class="ds-rec-tag ds-rec-tag-del">${n(r.deleted)} deleted</span>` : ''} ${r.restored ? `<span class="ds-rec-tag ds-rec-tag-upd">${n(r.restored)} restored</span>` : ''} ${(r.deleteFailed || r.restoreFailed) ? `<span class="ds-rec-tag ds-rec-tag-fail">${n((r.deleteFailed || 0) + (r.restoreFailed || 0))} failed</span>` : ''} ${r.remaining === 0 ? '<span class="ds-rec-tag ds-rec-tag-ins">✓ verified</span>' : r.remaining == null ? '<span class="ds-rec-tag ds-rec-tag-fail">unverified</span>' : `<span class="ds-rec-tag ds-rec-tag-fail">${n(r.remaining)} still differ</span>`}</span>`).join(' ');
    out.innerHTML = `<div class="ds-rec-card ${res.status === 'success' ? '' : 'ds-rec-card-warn'}" style="margin-top:10px">
      <div class="ds-rec-card-hd"><span class="ds-rec-card-ico">${res.status === 'success' ? '✅' : '⚠'}</span><span class="ds-rec-card-title">Rollback ${esc(res.status)}${res.status === 'success' ? ' — verified by re-reading the org' : ''}</span></div>
      <div class="ds-rec-card-line">${chips}</div>
      <div class="ds-rec-card-line">${res.entry ? `<button class="ds-btn ds-btn-sm ds-btn-primary" id="dsRbOpenReport">📋 Which records — the full report</button> ` : ''}<button class="ds-btn ds-btn-sm" id="dsRbToHistory">History</button></div>
    </div>`;
    eid('dsRbOpenReport')?.addEventListener('click', () => window.openRollback(res.entry.id, { report: true }));
    eid('dsRbToHistory')?.addEventListener('click', () => navigateToView('history'));
  }
  const go = eid('dsRbGo'); if (go) { go.disabled = true; go.textContent = res && res.status === 'success' ? '✅ Rolled back' : `⚠ ${(res && res.status) || 'failed'}`; }
}

// ── REPORT mode ─────────────────────────────────────────────────────────────
const _RB_REPORT_TABS = [
  { k: 'deleted',  label: '🗑 Deleted',  field: 'deletedRecords',  count: 'deleted', noun: 'deleted — in the Recycle Bin of the org for 15 days' },
  { k: 'restored', label: '↩ Restored', field: 'restoredRecords', count: 'updated', noun: 'restored to their values from the restore point' },
  { k: 'failed',   label: '❌ Failed',   field: 'failedRecords',   noun: 'refused by Salesforce — nothing changed for these' },
];
const SFTK_RB_BIN_CAP = 50000;
// The org a per-object result was written in (a two-leg rollback names it per object).
function _rbReportOrg(e, s) { return (s && s.orgUrl) || e.targetOrg || e.tgtOrgUrl || ''; }
// Names are missing for the deleted records of this object: an older rollback,
// counts-only mode, or more records than a History entry keeps.
function _rbNamesMissing(s) { return Number(s && s.deleted || 0) > ((s && s.deletedRecords) || []).length; }

// A rollback deletes to the Recycle Bin, so the org itself still knows which
// records it deleted — for 15 days. When the History entry has no names (user
// 2026-10-05, on a rollback from before names were kept: "when you click see
// which records, you dont see the list of records"), the page reads them
// there: the object's deleted records inside the rollback's own time window.
// A read, never a write; said on the page while it runs, with what it costs.
async function _rbBinRead(objKey) {
  const me = _rb; if (!me || !me.report) return;
  const e = me.entry, s = (e.summary || {})[objKey] || {};
  const org = _rbReportOrg(e, s);
  const objType = String(objKey).split(' @ ')[0];
  me.bin = me.bin || {};
  const st = me.bin[objKey] = { state: 'loading', rows: [], calls: 0 };
  const paint = () => { if (_rb === me && _currentView === 'rollback') renderRollback(); };
  const fail = (state, error) => { st.state = state; st.error = error || ''; paint(); };
  try {
    const sess = await getOrgSession(org);
    if (_rb !== me) return;
    if (!sess) return fail('nosession');
    // The label: the object's own name field, when it has one (Case has CaseNumber, a Task has Subject).
    let nameField = '';
    try {
      const d = await describe(objType, sess.orgUrl, sess.sid); st.calls++;
      const fields = (d && d.fields) || [];
      nameField = (fields.find(f => f.nameField === true) || fields.find(f => f.name === 'Name') || {}).name || '';
    } catch (_) { /* no label field: the list shows Ids */ }
    const q = sftkUndoBinQuery(objType, e.startedAt, e.completedAt, nameField);
    if (!q) return fail('error', 'this History entry has no start and end time to search by');
    st.from = q.from; st.to = q.to; st.tolMin = q.tolMin;
    let path = `services/data/v62.0/queryAll/?q=${encodeURIComponent(q.soql)}`;
    while (path) {
      const res = await sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid, path, _suppressError: true });
      st.calls++;
      if (_rb !== me) return;
      if (!res || res.error || !Array.isArray(res.records)) return fail('error', (res && res.error) || 'Salesforce returned no records list');
      for (const r of res.records) st.rows.push({ id: r.Id, name: (nameField && r[nameField] != null && String(r[nameField]).trim()) || r.Id });
      if (st.rows.length >= SFTK_RB_BIN_CAP) { st.capped = true; break; }
      path = res.nextRecordsUrl ? String(res.nextRecordsUrl).replace(/^\/+/, '') : '';
    }
    st.state = 'done';
    paint();
  } catch (err) { fail('error', (err && err.message) || String(err)); }
}

function _rbRenderReport() {
  const me = _rb; const e = me.entry; const n = v => Number(v || 0).toLocaleString();
  const summary = e.summary || {};
  const keys = Object.keys(summary);
  if (!keys.includes(me.objKey)) me.objKey = keys[0] || '';
  const s = summary[me.objKey] || {};
  const org = _rbReportOrg(e, s);
  const chips = keys.map(k => { const r = summary[k]; return `<span class="ds-summary-chip"><strong>${esc(k)}</strong> · ${r.deleted ? `<span class="ds-rec-tag ds-rec-tag-del">${n(r.deleted)} deleted</span>` : ''} ${r.updated ? `<span class="ds-rec-tag ds-rec-tag-upd">${n(r.updated)} restored</span>` : ''} ${(r.deletedFailed || r.updatedFailed) ? `<span class="ds-rec-tag ds-rec-tag-fail">${n((r.deletedFailed || 0) + (r.updatedFailed || 0))} failed</span>` : ''} ${r.leftAlone ? `<span class="ds-rec-tag">${n(r.leftAlone)} left alone</span>` : ''}</span>`; }).join(' ');
  // Where the Deleted list comes from: the entry's own names, or — when it has
  // none (or fewer than it deleted) — the org's Recycle Bin, read now.
  const missing = _rbNamesMissing(s);
  const bin = (me.bin || {})[me.objKey] || null;
  const days = sftkUndoBinAge(e.completedAt || e.startedAt, Date.now());
  const tooOld = days !== null && days > 15;
  if (missing && !bin && !tooOld && me.objKey) { _rbBinRead(me.objKey); }
  const binNow = (me.bin || {})[me.objKey] || null;
  const fromBin = missing && binNow && binNow.state === 'done';
  const stored = { deleted: s.deletedRecords || [], restored: s.restoredRecords || [], failed: s.failedRecords || [] };
  const listOf = k => (k === 'deleted' && fromBin) ? binNow.rows : stored[k];
  const tabs = _RB_REPORT_TABS.map(t => ({ ...t, n: t.count ? Math.max(Number(s[t.count] || 0), listOf(t.k).length) : listOf(t.k).length }));
  if (!tabs.some(t => t.k === me.tab)) me.tab = 'deleted';
  const tab = tabs.find(t => t.k === me.tab);
  const q = (me.filter || '').trim().toLowerCase();
  const all = listOf(me.tab).map(r => ({ id: r.id, name: r.name || r.label || r.id, fields: r.fields, error: r.error, op: r.op }));
  const rows = q ? all.filter(r => `${r.name} ${r.id} ${r.error || ''}`.toLowerCase().includes(q)) : all;
  const shown = rows.slice(0, me.window);
  const rowHtml = r => {
    const mid = me.tab === 'restored' ? `<span class="ds-rec-pnote">${esc((r.fields || []).slice(0, 4).join(', '))}${(r.fields || []).length > 4 ? ` +${r.fields.length - 4}` : ''}</span>`
      : me.tab === 'failed' ? `<span class="ds-rec-pnote ds-rec-pnote-missing">${esc(r.op || '')}: ${esc(r.error || '')}</span>` : '';
    const tail = me.tab === 'deleted'
      ? `<span class="ds-dep-open"><a href="${_rbBinUrl(org)}" target="_blank" rel="noopener" title="The Recycle Bin of ${esc(orgLabel(org))} — the record can be restored there within 15 days">Recycle Bin ↗</a></span>`
      : `<span class="ds-dep-open"><a href="${_rbRecUrl(org, r.id)}" target="_blank" rel="noopener">open ↗</a></span>`;
    return `<div class="ds-dep-row"><span class="ds-dep-mono">${esc(r.id)}</span><span class="ds-dep-key" title="${esc(r.id)}">${esc(r.name)}</span><span class="ds-dep-mid">${mid}</span><span class="ds-dep-tail">${tail}</span></div>`;
  };
  // What the page says about a list it could not take from the entry.
  const why = (typeof _settings !== 'undefined' && _settings && _settings.countsOnly)
    ? 'Counts-only mode keeps no record names in History.'
    : (s.deletedRecords || []).length ? `History keeps the first ${n((s.deletedRecords || []).length)} names per object.` : 'This rollback ran before History kept the records by name.';
  const again = '<button class="ds-btn ds-btn-xs" id="dsRbBinRead">🔎 Read again</button>';
  let note = '';
  if (me.tab === 'deleted' && missing) {
    if (tooOld) note = `<div class="ds-dep-note">${esc(why)} It ran ${n(days)} days ago and the Recycle Bin keeps a record for 15 days, so the ${n(s.deleted)} deleted records can no longer be named.</div>`;
    else if (!binNow || binNow.state === 'loading') note = `<div class="ds-dep-note">🔎 ${esc(why)} Reading the ${n(s.deleted)} deleted ${esc(me.objKey)} records from the Recycle Bin of ${esc(orgLabel(org))} instead (≈${n(sftkUndoReadQuote(s.deleted).calls + 1)} API calls, nothing is changed)…</div>`;
    else if (binNow.state === 'nosession') note = `<div class="ds-dep-note">⚠ ${esc(why)} The records it deleted can still be read from the Recycle Bin of ${esc(orgLabel(org))} — open that org in a Chrome tab, then ${again}</div>`;
    else if (binNow.state === 'error') note = `<div class="ds-dep-note">❌ ${esc(why)} Reading the Recycle Bin of ${esc(orgLabel(org))} failed: ${esc(binNow.error || 'unknown error')}. Nothing is listed. ${again}</div>`;
    else {
      const v = sftkUndoBinVerdict(binNow.rows.length, s.deleted, !!binNow.capped);
      note = `<div class="ds-dep-note">${v.kind === 'match' ? '✅' : '⚠'} ${esc(why)} This list was read from the Recycle Bin of ${esc(orgLabel(org))} just now (${n(binNow.calls)} API calls): ${esc(me.objKey)} records deleted between ${esc(_rbWhen(binNow.from))} and ${esc(_rbWhen(binNow.to))} — the rollback’s own time, ${n(binNow.tolMin)} minutes either side. ${esc(v.text)} ${again}</div>`;
    }
  } else if (me.tab === 'restored' && Number(s.updated || 0) > stored.restored.length) {
    note = `<div class="ds-dep-note">${esc(stored.restored.length ? `History keeps the first ${n(stored.restored.length)} names per object.` : why)} ${n(Number(s.updated) - stored.restored.length)} restored record(s) are counted but not named — a restored record leaves no trace in the org to read them from.</div>`;
  }
  const waiting = me.tab === 'deleted' && missing && !tooOld && (!binNow || binNow.state === 'loading');
  setMain(`${_rbHeader(`${esc(e.profileName || '↩ Rollback')} — what it did`, `${esc(orgLabel(org))} · ${esc(_rbWhen(e.completedAt || e.startedAt))} · ${esc(e.status || '')}`)}
    <div class="ds-dep-page">
      <div class="ds-rec-card"><div class="ds-rec-card-hd"><span class="ds-rec-card-ico">📋</span><span class="ds-rec-card-title">Per object</span></div><div class="ds-rec-card-line">${chips || 'nothing recorded'}</div>
        ${s.recordsCapped ? `<div class="ds-dep-note">⚠ Only the first ${n(s.recordsCapped)} deleted and restored records are kept by name for this object — the counts above are the truth.</div>` : ''}
      </div>
      ${!keys.length ? '' : `<div class="ds-rec-card ds-rb-records">
        <div class="ds-dep-objbar"><span class="ds-dep-objlbl">object</span>${keys.map(k => `<button class="ds-dep-objbtn ${k === me.objKey ? 'ds-dep-objbtn-on' : ''}" data-rb-robj="${esc(k)}">${esc(k)}</button>`).join('')}</div>
        <div class="ds-dep-tabs" role="tablist">${tabs.map(t => `<button role="tab" data-rb-rtab="${t.k}" aria-selected="${t.k === me.tab}">${t.label} <b>${t.n.toLocaleString()}</b></button>`).join('')}</div>
        ${note}
        <div class="ds-dep-tools">
          <input type="search" id="dsRbFilter" class="ds-dep-filter" placeholder="🔍 filter by name or Id…" value="${esc(me.filter)}" aria-label="Filter records">
          <span>${rows.length.toLocaleString()} ${esc(me.objKey)} ${esc(tab.noun)}${all.length < tab.n ? ` — ${n(all.length)} of ${n(tab.n)} named` : ''}</span>
        </div>
        <div class="ds-dep-list">${shown.length ? shown.map(rowHtml).join('') : `<div class="ds-dep-empty">${waiting ? 'Reading the Recycle Bin…' : q ? 'No record matches that filter.' : (tab.n ? 'No names to list — see the note above.' : `Nothing ${esc(tab.noun)}.`)}</div>`}</div>
        ${rows.length > shown.length ? `<div class="ds-dep-note ds-dep-more">Showing ${shown.length.toLocaleString()} of ${rows.length.toLocaleString()}
          <button class="ds-btn ds-btn-xs" data-rb-more="step">Show ${Math.min(SFTK_RB_WINDOW, rows.length - shown.length).toLocaleString()} more</button>
          <button class="ds-btn ds-btn-xs" data-rb-more="all">Show all ${rows.length.toLocaleString()}</button></div>` : ''}
      </div>`}
    </div>`);
  _rbWireBack();
  document.querySelectorAll('[data-rb-robj]').forEach(b => b.addEventListener('click', () => { me.objKey = b.dataset.rbRobj; me.filter = ''; me.window = SFTK_RB_WINDOW; renderRollback(); }));
  document.querySelectorAll('[data-rb-rtab]').forEach(b => b.addEventListener('click', () => { me.tab = b.dataset.rbRtab; me.filter = ''; me.window = SFTK_RB_WINDOW; renderRollback(); }));
  eid('dsRbBinRead')?.addEventListener('click', () => { if (me.bin) delete me.bin[me.objKey]; renderRollback(); });
  const f = eid('dsRbFilter');
  f?.addEventListener('input', () => { me.filter = f.value; me.window = SFTK_RB_WINDOW; const pos = f.selectionStart; renderRollback(); const g = eid('dsRbFilter'); if (g) { g.focus(); try { g.setSelectionRange(pos, pos); } catch (_) {} } });
  document.querySelectorAll('[data-rb-more]').forEach(b => b.addEventListener('click', () => { me.window = b.dataset.rbMore === 'all' ? rows.length : me.window + SFTK_RB_WINDOW; renderRollback(); }));
}
window.renderRollback = renderRollback;
