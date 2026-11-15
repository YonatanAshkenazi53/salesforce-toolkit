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
    // 2026-11-15: one page run can be several engine calls (the Deploy page sends the new-parent inserts, then one
    // call per group under existing parents), and each call ends with 'end'. A later call's 'start' reopens the
    // view — the ticker gave up for good after the first 'end', so the next call's cards never moved.
    case 'start': state.t0 = now; state.ended = false; return null;
    case 'hb':    return null;
    // 2026-11-15 (live check, network dropped mid dry run: two cards stayed on "reading records… 0:00", and a
    // half-written card read "written"). A card the run ends on while it is still open is closed AS STOPPED
    // (endedOpen) — never left reading, never shown as done.
    case 'end':
      state.ended = true;
      for (const c of state.cards.values()) {
        if (!c.finished) { c.endedOpen = true; c.lastAt = now; }
        c.finished = true;
      }
      return { ended: true };
    // The engine's own word that an object's read or write threw (background.js, the node's catch).
    case 'nodeError': {
      const c = _sftkRunCard(state, evt.obj, now);
      c.afterDone = !!c.finished && c.mode !== 'read';
      c.error = String(evt.message || 'failed');
      c.finished = true;
      return { card: c };
    }
    case 'step':
      state.stepIdx = (evt.index || 0) + 1;
      return { step: { index: evt.index || 0, total: evt.total || 0, name: evt.name || '' } };
    case 'node': {
      const c = _sftkRunCard(state, evt.obj, now);
      c.mode = 'read'; c.state = 'reading';
      // the same object in a later engine call of this run: the card is open again
      c.finished = false; c.endedOpen = false; c.error = ''; c.afterDone = false;
      c.unconfirmed = 0; c.writeRefused = false;
      return { card: c };
    }
    case 'fetched': {
      const c = _sftkRunCard(state, evt.obj, now);
      c.mode = 'write'; c.state = 'writing'; c.total = Number(evt.count) || 0; c.done = 0;
      c.unconfirmed = 0; c.writeRefused = false;
      c.writeStartedAt = now;
      c.finished = false; c.endedOpen = false; c.error = ''; c.afterDone = false;
      // 🧪 a dry run: the records are built now and sent later, in one transaction
      if (evt.probe) { c.probe = true; c.sampledOf = Number(evt.sampledOf) || 0; }
      if (c.total === 0) c.finished = true;
      return { card: c };
    }
    case 'batch': {
      const c = _sftkRunCard(state, evt.obj, now);
      c.mode = 'write'; c.state = 'writing';
      if (evt.probe) c.probe = true;
      if (!c.writeStartedAt) c.writeStartedAt = now;
      const done = Number(evt.done) || 0;
      if (c.batchSize == null && done > 0) c.batchSize = done;   // the first batch sizes the rest
      c.done = done; c.total = Number(evt.total) || c.total || 0;
      c.created = Number(evt.created) || 0; c.failed = Number(evt.failed) || 0;
      // 2026-11-15 (close-out review): records sent in a write call that threw (background.js) — not written, or
      // not confirmed written; never part of "written"
      c.unconfirmed = Number(evt.unconfirmed) || 0; c.writeRefused = !!evt.refused;
      // what the accepted records became: a rollback deletes and restores, it creates nothing
      if (evt.okWord) c.okWord = String(evt.okWord);
      // a dry run's card closes on its verdict (probeDone), not when the records are built
      if (c.total && c.done >= c.total && !c.probe) c.finished = true;
      return { card: c };
    }
    // 🧪 one transaction per round: every object in it is "being checked"
    case 'probe': {
      const cards = [];
      for (const sub of (Array.isArray(evt.subs) ? evt.subs : [])) {
        const c = _sftkRunCard(state, sub.obj, now);
        c.probe = true; c.mode = 'write'; c.state = 'probing'; c.round = Number(evt.round) || 1; c.finished = false;
        if (!c.writeStartedAt) c.writeStartedAt = now;
        cards.push(c);
      }
      return cards.length ? { cards } : null;
    }
    // 🧪 2026-11-15: the page's word, once a stopped dry run is over, that n selected records of this object were
    // never built — the headline counts them, so the object has a card that says so (it may have had none).
    case 'probeUnbuilt': {
      const c = _sftkRunCard(state, evt.obj, now);
      c.probe = true; c.mode = 'write';
      c.unbuilt = Number(evt.n) || 0;
      if (!c.verdict && !c.finished) c.endedOpen = true;
      c.finished = true;
      return { card: c };
    }
    // 🧪 the verdict for one object
    case 'probeDone': {
      const c = _sftkRunCard(state, evt.obj, now);
      const n = k => Number(evt[k]) || 0;
      c.probe = true; c.mode = 'write';
      // the same object can be checked by two steps of one run (under new
      // parents, then under existing ones): the card adds them up
      const prev = c.verdict || { probed: 0, wouldWrite: 0, refused: 0, cascade: 0, unreached: 0, sampledOf: 0 };
      c.verdict = { probed: prev.probed + n('probed'), wouldWrite: prev.wouldWrite + n('wouldWrite'), refused: prev.refused + n('refused'),
        cascade: prev.cascade + n('cascade') + n('earlier'), unreached: prev.unreached + n('unreached'), sampledOf: prev.sampledOf + n('sampledOf') };
      c.done = c.verdict.probed; if (!c.total) c.total = c.verdict.probed;
      c.failed = c.verdict.refused; c.created = c.verdict.wouldWrite;
      c.finished = true;
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

// 2026-11-15: 'en-US' on purpose, here and at every number site in both apps. The UI text is English only, so a
// German or Romanian browser must not print "1.250 records" inside an English sentence. Dates keep the browser's
// own locale. test/number-format-en-1115.test.mjs fails the gate on a new arg-less number toLocaleString().
function sftkRunFmtN(n) { return Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-US') : '?'; }

// PURE. What a card says right now. `now` moves the clocks between events.
function sftkRunProgressCardText(c, now) {
  now = now || Date.now();
  const since = c.writeStartedAt || c.startedAt;
  const elapsedMs = Math.max(0, (c.finished ? c.lastAt : now) - since);
  const out = { icon: '⏳', title: c.obj, stateText: '', timeText: '', numsText: '', pct: 0, failPct: 0, alive: true };
  // the browser's raw network token ("Failed to fetch") in words — sftk-friendly-error.js, when it is loaded
  const words = m => (typeof sftkNetworkWords === 'function' ? sftkNetworkWords(m) : String(m));
  if (c.mode === 'read') {
    out.timeText = sftkRunFmtDur((c.finished ? c.lastAt : now) - c.startedAt);
    // 2026-11-15: a card is never left "reading" once its run is over. The read threw: say why. The run ended
    // with nothing fetched (stopped, or the object was skipped because none of its parents was written): say
    // only what is certain — no record of it was read.
    if (c.error) { out.icon = '❌'; out.stateText = `stopped: ${words(c.error)}`; out.alive = false; return out; }
    if (c.finished) { out.icon = '➖'; out.stateText = 'the run ended — no records were read'; out.alive = false; return out; }
    out.stateText = 'reading records…';
    return out;
  }
  const total = c.total || 0, done = c.done || 0;
  const pct = total ? Math.min(100, Math.round(done / total * 100)) : 0;
  out.pct = pct;
  // 🧪 a dry run's card: built → checking (round n) → the verdict
  if (c.probe) {
    out.timeText = sftkRunFmtDur(elapsedMs);
    const v = c.verdict;
    const ub = Number(c.unbuilt) || 0;   // selected, never built: the stop came first (2026-11-15)
    if (v) {
      const bad = v.refused + v.cascade + v.unreached + ub;
      out.icon = bad ? '⚠' : '✅'; out.pct = 100;
      out.failPct = v.probed ? Math.min(100, Math.round(bad / v.probed * 100)) : 0;
      // 2026-11-15: records Salesforce never got to are named, with their count — "5 checked · 5 not reached"
      // said both at once. The count that leads is "in the dry run" then, not "checked".
      out.stateText = v.refused ? `dry run: ${sftkRunFmtN(v.refused)} would be refused${v.unreached ? `, ${sftkRunFmtN(v.unreached)} not reached` : ''}`
        : v.unreached ? `dry run stopped — ${sftkRunFmtN(v.unreached)} not reached`
        : ub ? `dry run stopped — ${sftkRunFmtN(ub)} never checked`
        : bad ? 'dry run: not every record was checked' : 'dry run: every record would be written';
      out.numsText = `${sftkRunFmtN(v.probed)} ${v.unreached ? 'in the dry run' : 'checked'} · ${sftkRunFmtN(v.wouldWrite)} would be written${v.refused ? ` · ${sftkRunFmtN(v.refused)} refused` : ''}${v.cascade ? ` · ${sftkRunFmtN(v.cascade)} not checked (parent refused)` : ''}${v.unreached ? ` · ${sftkRunFmtN(v.unreached)} not reached` : ''}${v.sampledOf ? ` · a sample of ${sftkRunFmtN(v.sampledOf)}` : ''}${ub ? ` · ${sftkRunFmtN(ub)} more selected, never checked` : ''}`;
      out.alive = false;
      return out;
    }
    out.icon = '🧪';
    if (ub) {   // no verdict at all: none of the object's selected records was checked
      out.icon = c.error ? '❌' : '⚠'; out.alive = false; out.pct = 0;
      out.stateText = c.error ? `dry run stopped: ${words(c.error)}` : 'dry run stopped — not checked';
      out.numsText = `${sftkRunFmtN(Math.max(ub, total))} selected record(s) never checked`;
      return out;
    }
    if (!total) { out.icon = '✅'; out.stateText = 'nothing to check'; out.alive = false; return out; }
    // the run is over and this object never got its verdict (2026-11-15)
    if (c.error || c.endedOpen) {
      out.icon = c.error ? '❌' : '⚠'; out.alive = false;
      out.stateText = c.error ? `dry run stopped: ${words(c.error)}` : 'dry run stopped — not checked';
      out.numsText = `${sftkRunFmtN(total)} record(s) not reached${c.sampledOf ? ` · a sample of ${sftkRunFmtN(c.sampledOf)}` : ''}`;
      return out;
    }
    if (c.state === 'probing') {
      out.stateText = `dry run · round ${c.round || 1}: Salesforce is checking…`;
      out.numsText = `${sftkRunFmtN(total)} record(s) in the transaction${c.sampledOf ? ` · a sample of ${sftkRunFmtN(c.sampledOf)}` : ''}`;
      return out;
    }
    out.stateText = done >= total ? 'built — waiting for the transaction' : 'building the records (dry run)…';
    out.numsText = `${sftkRunFmtN(done)} / ${sftkRunFmtN(total)} built${c.sampledOf ? ` · a sample of ${sftkRunFmtN(c.sampledOf)}` : ''}`;
    return out;
  }
  // 2026-11-15 (close-out review): unc = records whose write call threw. They are not "written": the bar is not
  // solid green for them and no branch below says "written" / ✅ over them.
  const unc = c.unconfirmed > 0 ? Number(c.unconfirmed) : 0;
  const uncText = !unc ? '' : c.writeRefused ? `${sftkRunFmtN(unc)} not written (the write call was refused)` : `${sftkRunFmtN(unc)} not confirmed written`;
  out.failPct = total ? Math.min(pct, Math.round(((c.failed || 0) + unc) / total * 100)) : 0;
  // No rate before two seconds have passed — the first batch landing at 0:00
  // read "207100/s" in the harness.
  const rate = elapsedMs >= 2000 && done > 0 ? done / (elapsedMs / 1000) : 0;
  const left = rate > 0 && total > done ? (total - done) / rate : null;
  const rateText = rate >= 10 ? `${Math.round(rate)}/s` : rate > 0 ? `${rate.toFixed(1)}/s` : '';
  const verb = c.mode === 'bulkRead' ? 'read' : 'written';
  if (c.mode === 'bulk' || c.mode === 'bulkRead') {
    const job = c.mode === 'bulk' ? 'Bulk write job' : 'Bulk read job';
    if (c.state === 'JobComplete') { out.icon = c.failed ? '⚠' : '✅'; out.stateText = `${job} complete`; }
    else if (c.state === 'Aborted')  { out.icon = '✋'; out.stateText = `${job} aborted`; }
    else if (c.state === 'Failed')   { out.icon = '❌'; out.stateText = `${job} failed`; }
    else if (c.error)                { out.icon = '❌'; out.stateText = `${job} stopped: ${words(c.error)}`; }
    // the run ended while the job was not finished: its last known state, not "last answered 40s ago" forever
    else if (c.endedOpen)            { out.icon = '⚠'; out.stateText = `${job}: ${c.state || 'InProgress'} when the run ended — not confirmed complete`; }
    else {
      const ago = Math.round((now - c.lastAt) / 1000);
      out.stateText = `${job}: ${c.state || 'InProgress'} · Salesforce last answered ${ago <= 1 ? 'just now' : `${ago}s ago`}`;
    }
  } else if (c.error) {
    // 2026-11-15: the object's call threw. Written-then-failed (a later step of the object) is not "stopped".
    out.icon = '❌';
    out.stateText = c.afterDone ? `written — a later step failed: ${words(c.error)}` : `stopped: ${words(c.error)}`;
  } else if (c.endedOpen && total) {
    // the run ended with this object part-way: never "written"
    out.icon = '⚠';
    out.stateText = done ? 'stopped before every record was written' : 'stopped — nothing was written';
  } else if (c.finished && unc) {
    out.icon = '⚠';
    out.stateText = `${uncText}${c.failed ? `, ${sftkRunFmtN(c.failed)} failed` : ''}`;
  } else if (c.finished) {
    out.icon = c.failed ? '⚠' : '✅';
    // an object with no records to write is not "written" (2026-11-15)
    out.stateText = c.failed ? `written, ${sftkRunFmtN(c.failed)} failed` : (total || done) ? 'written' : 'nothing to write';
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
  const tail = c.mode === 'bulkRead' ? '' : ` · ${sftkRunFmtN(c.created)} ${c.okWord || 'created'}${c.failed ? ` · ${sftkRunFmtN(c.failed)} failed` : ''}${unc ? ` · ${uncText}` : ''}`;
  // "150 / 150 written" over a call that threw is untrue: those records were SENT
  const verbN = unc ? 'sent' : verb;
  out.numsText = total ? `${sftkRunFmtN(done)} / ${sftkRunFmtN(total)} ${verbN}${done ? tail : ''}` : (done ? `${sftkRunFmtN(done)} ${verbN}` : '');
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
    row.classList.toggle('ds-prog-card-failed', !!c.failed || !!c.error || c.unconfirmed > 0);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function tick() {
    if (!logEl || state.ended) { stop(); return; }
    if (!logEl.isConnected) { pendingRepaint = true; return; }   // detached for a repaint — wait, don't give up
    const now = Date.now();
    let alive = false;
    for (const c of state.cards.values()) { if (!c.finished || pendingRepaint) paint(c, now); if (!c.finished) alive = true; }
    pendingRepaint = false;
    if (!alive) stop();
  }
  function start() { if (!ticker) ticker = setInterval(tick, 1000); }
  function stop() { if (ticker) { clearInterval(ticker); ticker = null; } }

  // A page repaint can detach the node for a moment (the Deploy page puts the
  // same node back). Events keep folding into the state meanwhile; the ticker
  // repaints every live card once the node is connected again.
  let pendingRepaint = false;
  const handler = (evt) => {
    if (!evt || !logEl) return;
    const now = Date.now();
    const r = sftkRunProgressReduce(state, evt, now);
    if (!logEl.isConnected) { pendingRepaint = true; start(); return; }
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
    if (r.cards) { for (const c of r.cards) paint(c, now); start(); return; }
    if (r.card) { paint(r.card, now); if (!r.card.finished) start(); }
  };
  // the log node knows its current view, so the page that owns the run can close it (sftkRunProgressClose)
  if (logEl) { try { logEl._sftkRunView = handler; } catch (_) { /* a frozen node */ } }
  return handler;
}
// 2026-11-15: the page's own "this run is over". The engine sends 'end' when a call returns, but a page run can
// end without it (the worker died, the port dropped, the page's own call threw) — and then cards stayed on
// "reading records…" for good. Every page that ends a run calls this; it is the same 'end' the engine sends.
function sftkRunProgressClose(logEl) {
  const h = logEl && logEl._sftkRunView;
  if (typeof h === 'function') h({ phase: 'end' });
}
// ── What a run's result needs said, shared by every page that shows one ────
// 2026-11-15. (1) A write call that THROWS no longer replaces the object's
// summary with { error } (release QA 2026-11-14): the records are counted as
// `unconfirmed`, with the call's own message in `writeError`. The pages read
// only error / failed, so an expired target session showed a green
// "0 created" row and no "reopen the org tab" hint. One reading for all pages.
function sftkRunUnconfirmedInfo(s) {
  const n = (s && s.unconfirmed > 0) ? Number(s.unconfirmed) : 0;
  const why = String((s && (s.error || s.writeError)) || '');
  return {
    n,
    // writeRefused = Salesforce refused the call before saving anything.
    note: !n ? '' : (s.writeRefused
      ? `, ${n.toLocaleString('en-US')} not written (the write call was refused)`
      : `, ${n.toLocaleString('en-US')} not confirmed written`),
    expired: /SESSION_EXPIRED|session.*expired|INVALID_SESSION/i.test(why),
  };
}
// (2) A run the engine REFUSED because another Data Studio run is on wrote
// nothing. The pages took it down their "failed midway" branch: a failed
// History entry carrying a restore point, and "roll back if anything was
// written" — a roll-back whose time window lies inside the OTHER tab's run.
// Returns true when the result is such a refusal, after saying the engine's
// line, warning (not "failed") and dropping the restore point just captured.
// io: { log(icon, msg, cls), toast(msg, kind, ms), dropRestorePoint() }.
async function sftkRunRefusedBusy(result, io) {
  if (!(result && result.busy === true)) return false;
  const line = String(result.error || 'Another Data Studio run is already in progress.');
  try { io && io.log && io.log('⏳', line, 'ds-prog-warn'); } catch (_) { /* the line is also in the toast */ }
  try { io && io.toast && io.toast('Not started — another Data Studio run is in progress. Nothing was written.', 'warning', 7000); } catch (_) { /* no toast host */ }
  try { if (io && io.dropRestorePoint) await io.dropRestorePoint(); } catch (_) { /* pruned with the oldest restore points later */ }
  return true;
}

// Keep the old name alive for any caller that still uses it (both pages are
// migrated; the alias costs nothing and prevents a silent "no progress").
function _runProgressHandler(logEl) { return sftkRunProgressHandler(logEl); }
