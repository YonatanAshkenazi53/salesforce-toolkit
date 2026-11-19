// sftk-progress.js — one progress widget for every load that can take a while
// (user 2026-11-08: "when we scan these on enterprises it may take time. i want
// to show the animation and progress + estimation every loading that might take
// time").
//
// The cat, a bar, the step, the time left and what was found so far — for three
// shapes of work:
//   steps  — a fixed order of legs, each with a weight (its usual number of
//            calls): one segment per leg, the current one pulsing; the time left
//            comes from the legs already done.
//   count  — N of M items: a filling bar; the time left comes from the rate so
//            far, once three items have settled.
//   open   — one long call with no inner progress: a sweeping bar; the time left
//            comes from how long this load took LAST TIME in this org (kept in
//            chrome.storage.local), else the seconds so far.
// A load may move between shapes: a widget that opens "open" and learns how many
// pages the versions need switches to "count" with .count(done, total).
//
// Pure helpers (sftkProgEta, sftkProgLine, sftkProgFmtSec) are top-level so the
// tests can read them; the DOM part lives on window.sftkProgress.

// seconds → "12 s" / "3 min" / "1 h 10 min"
function sftkProgFmtSec(s) {
  s = Math.max(0, Math.round(Number(s) || 0));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = Math.floor(s / 3600), m = Math.round((s - h * 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

// The seconds left, or null when nothing honest can be said yet.
//   st: { mode, startedAt, legs, idx, doneW, doneMs, legAt, done, total, lastMs }
function sftkProgEta(st, now) {
  now = now || Date.now();
  const elapsed = now - st.startedAt;
  if (st.mode === 'steps') {
    const legs = st.legs || [];
    const left = legs.slice(st.idx).reduce((n, l) => n + (l.weight || 1), 0);
    // the legs done so far say how long a unit of weight takes; nothing before three units are done
    if (!(st.doneW >= 3) || !(st.doneMs > 0)) return st.lastMs ? Math.max(1, (st.lastMs - elapsed) / 1000) : null;
    return Math.max(1, (st.doneMs / st.doneW) * left / 1000 - (now - st.legAt) / 1000);
  }
  if (st.mode === 'count') {
    const done = st.done || 0, total = st.total || 0;
    if (total <= 0) return null;
    if (done >= total) return 0;
    // the rate so far, once three items have settled and 1.5 s have passed
    const did = done - (st.base || 0);   // items THIS run settled — a warm cache starts the count above zero
    if (did >= 3 && elapsed >= 1500) return Math.max(1, (elapsed / did) * (total - done) / 1000);
    return st.lastMs ? Math.max(1, (st.lastMs - elapsed) / 1000) : null;
  }
  // open: last time's duration in this org, else nothing
  if (st.lastMs > 0) return Math.max(1, (st.lastMs - elapsed) / 1000);
  return null;
}

// The line under the bar.
function sftkProgLine(st, now) {
  now = now || Date.now();
  const parts = [];
  if (st.mode === 'steps') {
    const legs = st.legs || [], leg = legs[st.idx];
    parts.push(`Step ${Math.min(st.idx + 1, legs.length)} of ${legs.length}${leg ? ` · ${leg.label}` : ''}`);
  } else if (st.mode === 'count' && st.total > 0) {
    parts.push(`${(st.done || 0).toLocaleString('en-US')} of ${st.total.toLocaleString('en-US')}${st.unit ? ` ${st.unit}` : ''}`);
  }
  const eta = sftkProgEta(st, now);
  const elapsed = (now - st.startedAt) / 1000;
  if (eta != null && eta > 0) parts.push(`about ${sftkProgFmtSec(eta)} left`);
  else if (eta === 0) parts.push('finishing…');
  else if (elapsed >= 3) parts.push(`${sftkProgFmtSec(elapsed)} so far`);
  else parts.push('estimating…');
  if (st.lastMs > 0 && (st.mode === 'open' || eta == null)) parts.push(`last time ${sftkProgFmtSec(st.lastMs / 1000)} here`);
  if (st.found) parts.push(`${st.found.toLocaleString('en-US')} ${st.foundWord || 'found'} so far`);
  if (st.note) parts.push(st.note);
  return parts.join(' · ');
}

// ONE ITEM'S OWN PROGRESS, in real time (owner 2026-11-20: "i want to see it fills up for every component that is
// currently removed in real time. one after one with the real time progress"). A change to one component is three
// things, in this order: it is READ from the org (and a restore point kept), it is CHANGED in Salesforce, and it is
// READ AGAIN to verify. Which of the three a call to Salesforce belongs to follows from the call itself: a read
// before the first write is the reading, a write is the change, a read after a write is the verifying. PURE.
const SFTK_ITEM_LEGS = [
  { key: 'read', label: 'Reading it from the org' },
  { key: 'write', label: 'Changing it in Salesforce' },
  { key: 'verify', label: 'Reading it again to verify' },
];
function sftkCallIsRead(type) { return /(_GET|QUERY|_READ|_LIST|DESCRIBE|RETRIEVE|VALIDATE|SESSIONS)/.test(String(type || '')); }
function sftkStepOfCall(type, wrote) {
  if (!/^SF_/.test(String(type || ''))) return '';             // not a call to Salesforce
  if (!sftkCallIsRead(type)) return 'write';
  return wrote > 0 ? 'verify' : 'read';
}
// the line next to an item's bar while it is in work
function sftkItemLineText(leg, wrote, sec) {
  const l = SFTK_ITEM_LEGS.find(x => x.key === leg);
  if (!l) return 'Starting…';
  return l.label + (leg === 'write' && wrote > 1 ? ` — change ${wrote}` : '') + (sec >= 2 ? ` · ${sftkProgFmtSec(sec)}` : '');
}

(function () {
  'use strict';
  // every call a tool sends to Salesforce is told here, as it starts — the trackers below listen
  const watchers = new Set();
  window.sftkBgNote = function (msg) { if (!watchers.size || !msg) return; watchers.forEach(w => { try { w(msg); } catch (_) { /* a tracker never breaks a call */ } }); };
  // sftkItemTrack(listEl) → { start(label), end(ok, text), close() }: one row per item, each with its own three-part
  // bar that fills as that item's calls go out; a finished row keeps its result, the next one opens under it.
  window.sftkItemTrack = function (listEl) {
    const e2 = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    let cur = null;
    const paint = () => {
      if (!cur || !cur.li.isConnected) return;
      const idx = SFTK_ITEM_LEGS.findIndex(l => l.key === cur.leg);
      cur.li.querySelectorAll('.sftk-it-seg').forEach((s, i) => { s.classList.toggle('done', i < idx); s.classList.toggle('now', i === idx); });
      cur.li.querySelector('.sftk-it-line').textContent = sftkItemLineText(cur.leg, cur.wrote, (Date.now() - cur.legAt) / 1000);
    };
    const onCall = msg => {
      if (!cur) return;
      const k = sftkStepOfCall(msg.type, cur.wrote);
      if (!k) return;
      if (k === 'write') cur.wrote++;
      if (k !== cur.leg) { cur.leg = k; cur.legAt = Date.now(); }
      paint();
    };
    watchers.add(onCall);
    const timer = setInterval(paint, 1000);
    const h = {
      start(label) {
        if (cur) h.end(true, '');
        const li = document.createElement('li');
        li.className = 'sftk-it sftk-it-now';
        li.innerHTML = `<span class="sftk-it-name">${e2(label)}</span><span class="sftk-it-bar">${SFTK_ITEM_LEGS.map(l => `<span class="sftk-it-seg" title="${e2(l.label)}"></span>`).join('')}</span><span class="sftk-it-line">Starting…</span>`;
        if (listEl) { listEl.appendChild(li); try { li.scrollIntoView({ block: 'nearest' }); } catch (_) { /* not laid out */ } }
        cur = { li, leg: '', wrote: 0, legAt: Date.now() };
        return h;
      },
      end(ok, text) {
        if (!cur) return h;
        const li = cur.li; cur = null;
        li.className = `sftk-it ${ok ? 'sftk-it-ok' : 'sftk-it-bad'}`;
        li.querySelectorAll('.sftk-it-seg').forEach(s => { s.classList.remove('now'); s.classList.toggle('done', !!ok); });
        li.querySelector('.sftk-it-line').textContent = (ok ? '✓ ' : '✕ ') + (text || (ok ? 'Done' : 'Not done'));
        return h;
      },
      close() { watchers.delete(onCall); clearInterval(timer); cur = null; },
    };
    return h;
  };
})();

(function () {
  'use strict';
  const STORE = 'sftkProgDur';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const host = u => { try { return new URL(u).host; } catch (_) { return String(u || ''); } };
  const storage = () => (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) ? chrome.storage.local : null;

  async function lastDuration(key) {
    const s = storage(); if (!s || !key) return 0;
    try { const all = (await s.get(STORE))[STORE] || {}; return Number(all[key]) || 0; } catch (_) { return 0; }
  }
  async function keepDuration(key, ms) {
    const s = storage(); if (!s || !key || !(ms > 0)) return;
    try {
      const all = (await s.get(STORE))[STORE] || {};
      // a running average with the last run weighing most — a cold cache and a warm one differ
      all[key] = all[key] ? Math.round(all[key] * 0.4 + ms * 0.6) : Math.round(ms);
      const keys = Object.keys(all); if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete all[k];
      await s.set({ [STORE]: all });
    } catch (_) { /* a lost estimate is no error */ }
  }

  // sftkProgress(mount, opts) → handle
  //   opts.what      the sentence under the cat ("Reading every flow of this org…")
  //   opts.key       what this load is ("flows", "switches") — the memory of its duration is per key and org
  //   opts.orgUrl    the org, for that memory
  //   opts.legs      [{ key, label, weight }] → steps mode
  //   opts.total     a number → count mode;   opts.unit the word for the items ("flow versions")
  //   opts.foundWord the word for .found(n) ("places", "flows")
  //   opts.onStop    a Stop button when given
  //   opts.small     the compact cat
  // handle: .step(keyOrLabel) .count(done, total) .found(n) .say(text) .note(text) .done() .fail() .el
  window.sftkProgress = function (mount, opts) {
    opts = opts || {};
    const st = {
      mode: opts.legs ? 'steps' : (opts.total > 0 ? 'count' : 'open'),
      legs: (opts.legs || []).map(l => ({ key: l.key || l.label, label: l.label, weight: l.weight || 1 })),
      idx: 0, doneW: 0, doneMs: 0, legAt: Date.now(), startedAt: Date.now(),
      done: opts.done || 0, base: opts.done || 0, total: opts.total > 0 ? opts.total : 0, unit: opts.unit || '',
      found: 0, foundWord: opts.foundWord || '', note: '', lastMs: 0, finished: false,
    };
    const key = opts.key ? `${opts.key}@${host(opts.orgUrl)}` : '';
    const el = document.createElement('div');
    el.className = `sftk-prog${opts.small ? ' sftk-prog-sm' : ''}`;
    el.setAttribute('data-mode', st.mode);
    const cat = window.sftkCatSvg ? window.sftkCatSvg('load', opts.small ? 48 : 56) : '';
    el.innerHTML = `${cat}<div class="sftk-prog-msg">${esc(opts.what || 'Loading…')}</div>`
      + `<div class="sftk-prog-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"></div>`
      + `<div class="sftk-prog-line"></div>`
      + (opts.onStop ? `<button type="button" class="btn btn-secondary btn-sm sftk-prog-stop">✕ Stop</button>` : '');
    if (mount) { mount.innerHTML = ''; mount.appendChild(el); }
    const bar = el.querySelector('.sftk-prog-bar'), line = el.querySelector('.sftk-prog-line');
    const stopBtn = el.querySelector('.sftk-prog-stop');
    if (stopBtn) stopBtn.addEventListener('click', () => { stopBtn.disabled = true; stopBtn.textContent = 'Stopping…'; try { opts.onStop(); } catch (_) { /* the caller's */ } });

    function drawBar() {
      el.setAttribute('data-mode', st.mode);
      if (st.mode === 'steps') {
        if (bar.children.length !== st.legs.length) bar.innerHTML = st.legs.map((l, i) => `<span class="sftk-prog-seg" data-i="${i}" title="${esc(l.label)}"></span>`).join('');
        bar.querySelectorAll('.sftk-prog-seg').forEach((s, i) => { s.classList.toggle('done', i < st.idx); s.classList.toggle('now', i === st.idx); });
        bar.removeAttribute('aria-valuenow');
      } else if (st.mode === 'count') {
        if (!bar.querySelector('.sftk-prog-fill')) bar.innerHTML = '<span class="sftk-prog-fill"></span>';
        const pct = st.total > 0 ? Math.min(100, Math.round(100 * st.done / st.total)) : 0;
        bar.querySelector('.sftk-prog-fill').style.width = pct + '%';
        bar.setAttribute('aria-valuenow', String(pct));
      } else {
        if (!bar.querySelector('.sftk-prog-sweep')) bar.innerHTML = '<span class="sftk-prog-sweep"></span>';
        bar.removeAttribute('aria-valuenow');
      }
    }
    function paint() {
      if (st.finished || !el.isConnected) return;
      drawBar();
      line.textContent = sftkProgLine(st);
    }
    drawBar(); line.textContent = sftkProgLine(st);
    // the seconds tick while a step runs; the timer ends with the widget
    const timer = setInterval(() => { if (st.finished || !el.isConnected) { clearInterval(timer); return; } paint(); }, 1000);
    if (key) lastDuration(key).then(ms => { st.lastMs = ms; paint(); });

    const h = {
      el, state: st,
      // the leg named by key or by a message that contains its label — the legs before it are done
      step(k) {
        const t = String(k || '').toLowerCase();
        let i = st.legs.findIndex(l => l.key === k);
        if (i < 0) i = st.legs.findIndex(l => t.includes(String(l.label).toLowerCase()));
        if (i < 0 || i === st.idx) return h;
        const now = Date.now();
        for (let j = st.idx; j < i; j++) st.doneW += st.legs[j].weight;
        st.doneMs += now - st.legAt; st.legAt = now; st.idx = i;
        paint(); return h;
      },
      count(done, total) { st.mode = 'count'; st.done = Math.max(0, done || 0); if (total > 0) st.total = total; paint(); return h; },
      found(n) { st.found = n || 0; paint(); return h; },
      say(text) { const m = el.querySelector('.sftk-prog-msg'); if (m) m.textContent = text; return h; },
      note(text) { st.note = text || ''; paint(); return h; },
      done() {
        if (st.finished) return h;
        st.finished = true; clearInterval(timer);
        if (key) keepDuration(key, Date.now() - st.startedAt);
        return h;
      },
      fail() { st.finished = true; clearInterval(timer); return h; },
    };
    return h;
  };
})();
