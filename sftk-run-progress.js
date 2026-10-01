// ═══════════════════════════════════════════════════════════════════════════
// LIVE RUN VIEW — one progress renderer for every page that runs the engine
// (Deploy / runReconcile, Transfer, rollback). Campaign 4 phase 1, user
// 2026-10-01: "i would like to see real time processing … like in inspector".
//
// Before this file the Deploy page wired the raw text handler from
// studio-scan.js, which ignored phase:'bulk' (the Bulk API 2.0 job poll) and
// phase:'errs' (the real-time error feed) — a 5,000-record write sat on
// "fetched — writing…" for minutes. Only the Transfer page rendered them.
//
// Shape: a PURE reducer (`sftkRunProgressReduce`) + a PURE text formatter
// (`sftkRunProgressCardText`) that the unit tests drive without a DOM, and a
// thin DOM painter (`sftkRunProgressHandler`) that both pages call. The engine
// events (background.js postRunProgress) are unchanged:
//   start · step · node · fetched · batch · bulk · bulkQuery · errs · hb · end
// Card ids keep the old `dsRunLive_<step>_<obj>` scheme — the Deploy page
// keeps the finished log's innerHTML as "Last run on this page".
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const SFTK_RUN_NOTE_MARKS = ['ℹ', '🔗', '📎', '⚠'];

function sftkRunProgressNewState(now) {
  return { t0: now || Date.now(), stepIdx: 0, cards: new Map(), order: [], ended: false };
}

function _sftkRunCardKey(state, obj) {
  return `${state.stepIdx}_${String(obj || 'x').replace(/[^\w]/g, '_')}`;
}

function _sftkRunCard(state, obj, now) {
  const key = _sftkRunCardKey(state, obj);
  let c = state.cards.get(key);
  if (!c) {
    c = { key, obj: String(obj || '?'), step: state.stepIdx, mode: 'read', total: null, done: 0, created: 0, failed: 0,
      state: '', startedAt: now, writeStartedAt: null, lastAt: now, batchSize: null, finished: false };
    state.cards.set(key, c);
    state.order.push(key);
  }
  c.lastAt = now;
  return c;
}

// PURE. Folds one engine event into the state. Returns what the painter must
// do: { card } for a card change, { step: {index,total,name} } for a new step,
// { errs: [{text, note}] , more } for the error feed, or null for nothing.
function sftkRunProgressReduce(state, evt, now) {
  now = now || Date.now();
  if (!evt || !evt.phase) return null;
  switch (evt.phase) {
    case 'start': state.t0 = now; return null;
    case 'hb':    return null;
    case 'end':
      state.ended = true;
      for (const c of state.cards.values()) c.finished = true;
      return { ended: true };
    case 'step':
      state.stepIdx = (evt.index || 0) + 1;
      return { step: { index: evt.index || 0, total: evt.total || 0, name: evt.name || '' } };
    case 'node': {
      const c = _sftkRunCard(state, evt.obj, now);
      c.mode = 'read'; c.state = 'reading';
      return { card: c };
    }
    case 'fetched': {
      const c = _sftkRunCard(state, evt.obj, now);
      c.mode = 'write'; c.state = 'writing'; c.total = Number(evt.count) || 0; c.done = 0;
      c.writeStartedAt = now;
      if (c.total === 0) c.finished = true;
      return { card: c };
    }
    case 'batch': {
      const c = _sftkRunCard(state, evt.obj, now);
      c.mode = 'write'; c.state = 'writing';
      if (!c.writeStartedAt) c.writeStartedAt = now;
      const done = Number(evt.done) || 0;
      if (c.batchSize == null && done > 0) c.batchSize = done;   // the first batch sizes the rest
      c.done = done; c.total = Number(evt.total) || c.total || 0;
      c.created = Number(evt.created) || 0; c.failed = Number(evt.failed) || 0;
      if (c.total && c.done >= c.total) c.finished = true;
      return { card: c };
    }
    case 'bulk':
    case 'bulkQuery': {
      const c = _sftkRunCard(state, evt.obj || evt.objType, now);
      c.mode = evt.phase === 'bulk' ? 'bulk' : 'bulkRead';
      if (!c.writeStartedAt) c.writeStartedAt = now;
      c.state = evt.state || 'InProgress';
      c.done = Number(evt.processed) || 0;
      if (evt.total !== null && evt.total !== undefined) c.total = Number(evt.total) || 0;
      c.failed = Number(evt.failed) || 0;
      c.created = Math.max(0, c.done - c.failed);
      if (c.state === 'JobComplete' || c.state === 'Aborted' || c.state === 'Failed') c.finished = true;
      return { card: c };
    }
    case 'errs': {
      const lines = Array.isArray(evt.lines) ? evt.lines : [];
      return {
        errs: lines.map(l => { const t = String(l); return { text: t, note: SFTK_RUN_NOTE_MARKS.some(m => t.includes(m)) }; }),
        more: Number(evt.more) || 0,
      };
    }
    default: return null;
  }
}

function sftkRunFmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

function sftkRunFmtN(n) { return Number.isFinite(Number(n)) ? Number(n).toLocaleString() : '?'; }

// PURE. What a card says right now. `now` moves the clocks between events.
function sftkRunProgressCardText(c, now) {
  now = now || Date.now();
  const since = c.writeStartedAt || c.startedAt;
  const elapsedMs = Math.max(0, (c.finished ? c.lastAt : now) - since);
  const out = { icon: '⏳', title: c.obj, stateText: '', timeText: '', numsText: '', pct: 0, failPct: 0, alive: true };
  if (c.mode === 'read') {
    out.stateText = 'reading records…';
    out.timeText = sftkRunFmtDur(now - c.startedAt);
    return out;
  }
  const total = c.total || 0, done = c.done || 0;
  const pct = total ? Math.min(100, Math.round(done / total * 100)) : 0;
  out.pct = pct;
  out.failPct = total ? Math.min(pct, Math.round((c.failed || 0) / total * 100)) : 0;
  const rate = elapsedMs > 0 && done > 0 ? done / (elapsedMs / 1000) : 0;
  const left = rate > 0 && total > done ? (total - done) / rate : null;
  const rateText = rate >= 10 ? `${Math.round(rate)}/s` : rate > 0 ? `${rate.toFixed(1)}/s` : '';
  const verb = c.mode === 'bulkRead' ? 'read' : 'written';
  if (c.mode === 'bulk' || c.mode === 'bulkRead') {
    const job = c.mode === 'bulk' ? 'Bulk write job' : 'Bulk read job';
    if (c.state === 'JobComplete') { out.icon = c.failed ? '⚠' : '✅'; out.stateText = `${job} complete`; }
    else if (c.state === 'Aborted')  { out.icon = '✋'; out.stateText = `${job} aborted`; }
    else if (c.state === 'Failed')   { out.icon = '❌'; out.stateText = `${job} failed`; }
    else {
      const ago = Math.round((now - c.lastAt) / 1000);
      out.stateText = `${job}: ${c.state || 'InProgress'} · Salesforce last answered ${ago <= 1 ? 'just now' : `${ago}s ago`}`;
    }
  } else if (c.finished) {
    out.icon = c.failed ? '⚠' : '✅';
    out.stateText = c.failed ? `written, ${sftkRunFmtN(c.failed)} failed` : 'written';
  } else if (done === 0) {
    out.stateText = total ? 'fetched — writing…' : 'nothing to write';
    if (!total) { out.icon = '✅'; out.alive = false; }
  } else {
    const bs = c.batchSize || 0;
    const batchText = bs && total ? ` · batch ${Math.ceil(done / bs)} of ${Math.ceil(total / bs)}` : '';
    out.stateText = `writing${batchText}`;
  }
  out.timeText = [sftkRunFmtDur(elapsedMs), rateText, !c.finished && left != null ? `~${sftkRunFmtDur(left * 1000)} left` : '']
    .filter(Boolean).join(' · ');
  const tail = c.mode === 'bulkRead' ? '' : ` · ${sftkRunFmtN(c.created)} created${c.failed ? ` · ${sftkRunFmtN(c.failed)} failed` : ''}`;
  out.numsText = total ? `${sftkRunFmtN(done)} / ${sftkRunFmtN(total)} ${verb}${done ? tail : ''}` : (done ? `${sftkRunFmtN(done)} ${verb}` : '');
  if (c.finished) out.alive = false;
  return out;
}

// The DOM painter both pages use. Returns the event handler for _openRunPort.
function sftkRunProgressHandler(logEl) {
  const state = sftkRunProgressNewState();
  let ticker = null;
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  function paint(c, now) {
    if (!logEl || !logEl.isConnected) return;
    const id = `dsRunLive_${c.key}`;
    let row = logEl.querySelector(`#${id}`);
    if (!row) {
      row = document.createElement('div');
      row.id = id;
      row.className = 'ds-prog-row ds-prog-card';
      row.innerHTML = `<div class="ds-prog-card-hd"><span class="ds-prog-card-icon"></span><b class="ds-prog-card-obj"></b><span class="ds-prog-card-state"></span><span class="ds-prog-card-time"></span></div>
        <div class="ds-prog-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="ds-prog-bar-fill"></div><div class="ds-prog-bar-fail"></div></div>
        <div class="ds-prog-card-nums"></div>`;
      logEl.appendChild(row);
    }
    const t = sftkRunProgressCardText(c, now);
    row.querySelector('.ds-prog-card-icon').textContent = t.icon;
    row.querySelector('.ds-prog-card-obj').textContent = t.title;
    row.querySelector('.ds-prog-card-state').textContent = t.stateText;
    row.querySelector('.ds-prog-card-time').textContent = t.timeText;
    row.querySelector('.ds-prog-card-nums').textContent = t.numsText;
    const bar = row.querySelector('.ds-prog-bar');
    bar.style.display = (c.mode === 'read') ? 'none' : '';
    bar.setAttribute('aria-valuenow', String(t.pct));
    row.querySelector('.ds-prog-bar-fill').style.width = `${t.pct}%`;
    row.querySelector('.ds-prog-bar-fail').style.width = `${t.failPct}%`;
    row.classList.toggle('ds-prog-card-done', !!c.finished);
    row.classList.toggle('ds-prog-card-failed', !!c.failed);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function tick() {
    if (!logEl || !logEl.isConnected || state.ended) { stop(); return; }
    const now = Date.now();
    let alive = false;
    for (const c of state.cards.values()) { if (!c.finished) { alive = true; paint(c, now); } }
    if (!alive) stop();
  }
  function start() { if (!ticker) ticker = setInterval(tick, 1000); }
  function stop() { if (ticker) { clearInterval(ticker); ticker = null; } }

  return (evt) => {
    if (!evt || !logEl || !logEl.isConnected) return;
    const now = Date.now();
    const r = sftkRunProgressReduce(state, evt, now);
    if (!r) return;
    if (r.ended) { for (const c of state.cards.values()) paint(c, now); stop(); return; }
    if (r.step) {
      const row = document.createElement('div');
      row.className = 'ds-prog-row ds-prog-step';
      row.textContent = `▶ Step ${r.step.index + 1}/${r.step.total}: ${r.step.name}`;
      logEl.appendChild(row);
      logEl.scrollTop = logEl.scrollHeight;
      return;
    }
    if (r.errs) {
      // Real-time error feed (user 2026-08-18) — appended, never updated in
      // place, so nothing scrolls out of history. Notes stay grey.
      for (const e of r.errs) {
        const row = document.createElement('div');
        row.className = `ds-prog-row ${e.note ? 'ds-prog-note' : 'ds-prog-err'}`;
        row.textContent = `${e.note ? 'ℹ' : '❌'} ${e.text.replace(/^\s*[ℹ⚠]\s*/, '')}`;
        logEl.appendChild(row);
      }
      if (r.more) {
        const row = document.createElement('div');
        row.className = 'ds-prog-row ds-prog-err';
        row.textContent = `…and ${r.more} more error(s) in this batch — the full list lands in History.`;
        logEl.appendChild(row);
      }
      logEl.scrollTop = logEl.scrollHeight;
      return;
    }
    if (r.card) { paint(r.card, now); if (!r.card.finished) start(); }
  };
}
// Keep the old name alive for any caller that still uses it (both pages are
// migrated; the alias costs nothing and prevents a silent "no progress").
function _runProgressHandler(logEl) { return sftkRunProgressHandler(logEl); }
