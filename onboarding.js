// ============================================================
// Onboarding & Help — shared component across Toolkit + Data Studio
//
//   SFTKOnboard.tour(steps, onDone)   — run a guided spotlight tour now
//   SFTKOnboard.firstRun(key, steps)  — run the tour once, ever (storage-gated)
//   SFTKOnboard.replayTour(key,steps) — clear the flag and run it again
//   SFTKOnboard.help(text)            — HTML for an inline "?" help badge
//   SFTKOnboard.wireHelp(root)        — activate ? badges within a subtree
//   SFTKOnboard.emptyState(opts)      — teaching empty-state HTML
//
// Self-contained: injects its own CSS, no dependency on either app's JS.
// ============================================================
(function () {
  'use strict';
  if (window.SFTKOnboard) return; // singleton — both apps may include this

  // ── Helpers ───────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Inject styles once ────────────────────────────────────
  const CSS = `
  .sftk-tour-overlay { position: fixed; inset: 0; z-index: 2147483000; }
  .sftk-tour-hole {
    position: fixed; border-radius: 8px; pointer-events: none;
    box-shadow: 0 0 0 9999px rgba(15,23,42,0.66);
    outline: 2px solid #4a9eff; outline-offset: 2px;
    transition: top .2s ease, left .2s ease, width .2s ease, height .2s ease;
  }
  .sftk-tour-card {
    position: fixed; width: 300px; box-sizing: border-box;
    background: #fff; color: #1e293b;
    border-radius: 10px; padding: 14px 16px; z-index: 2147483001;
    box-shadow: 0 12px 44px rgba(0,0,0,0.38);
    font-family: inherit; transition: top .2s ease, left .2s ease;
  }
  .sftk-tour-step {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .06em; color: #64748b;
  }
  .sftk-tour-title { font-size: 15px; font-weight: 700; margin: 3px 0 5px; color: #0f172a; }
  .sftk-tour-text  { font-size: 12.5px; line-height: 1.5; color: #475569; }
  .sftk-tour-actions {
    display: flex; justify-content: space-between; align-items: center; margin-top: 13px;
  }
  .sftk-tour-nav { display: flex; gap: 6px; }
  .sftk-tour-card button {
    font-size: 12px; padding: 5px 13px; border-radius: 6px; cursor: pointer;
    border: 1px solid #cbd5e1; background: #fff; color: #475569; font-weight: 600;
  }
  .sftk-tour-card button:hover { filter: brightness(0.97); }
  .sftk-tour-skip { border: none !important; color: #94a3b8 !important; font-weight: 500 !important; }
  .sftk-tour-next { background: #2563eb !important; color: #fff !important; border-color: #2563eb !important; }

  .sftk-help {
    display: inline-flex; align-items: center; justify-content: center;
    width: 14px; height: 14px; border-radius: 50%;
    background: #cbd5e1; color: #fff; font-size: 10px; font-weight: 700;
    cursor: help; margin-left: 4px; vertical-align: middle;
    user-select: none; -webkit-user-select: none;
  }
  .sftk-help:hover, .sftk-help:focus { background: #2563eb; outline: none; }
  .sftk-help-tip {
    position: fixed; z-index: 2147483002; max-width: 250px;
    background: #1e293b; color: #fff; font-size: 11.5px; line-height: 1.45;
    padding: 7px 10px; border-radius: 6px;
    box-shadow: 0 6px 22px rgba(0,0,0,0.32); pointer-events: none;
  }

  .sftk-empty {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; padding: 38px 24px; gap: 5px;
    color: var(--subtext, #64748b);
  }
  .sftk-empty-icon  { font-size: 38px; line-height: 1; margin-bottom: 4px; }
  .sftk-empty-title { font-size: 15px; font-weight: 700; color: var(--text, #1e293b); }
  .sftk-empty-body  { font-size: 12.5px; line-height: 1.55; max-width: 380px; }
  .sftk-empty-action {
    margin-top: 12px; padding: 7px 16px; border-radius: 7px; cursor: pointer;
    background: var(--brand, #2563eb); color: #fff; border: none;
    font-size: 12.5px; font-weight: 600;
  }
  .sftk-empty-action:hover { filter: brightness(1.06); }
  `;
  const styleEl = document.createElement('style');
  styleEl.id = 'sftk-onboard-css';
  styleEl.textContent = CSS;
  (document.head || document.documentElement).appendChild(styleEl);

  // ── Guided spotlight tour ─────────────────────────────────
  function tour(steps, onDone) {
    // Drop steps whose target element isn't present *or* isn't visible
    // (robust to UI variations — e.g. a nav that's hidden on a home screen).
    steps = (steps || []).filter(s => {
      if (!s.selector) return true;
      const el = document.querySelector(s.selector);
      return !!el && el.getClientRects().length > 0;
    });
    if (!steps.length) { if (onDone) onDone(); return; }

    let idx = 0;
    const overlay = document.createElement('div');
    overlay.className = 'sftk-tour-overlay';
    const hole = document.createElement('div');
    hole.className = 'sftk-tour-hole';
    const card = document.createElement('div');
    card.className = 'sftk-tour-card';
    overlay.appendChild(hole);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    function finish() {
      overlay.remove();
      window.removeEventListener('resize', render);
      if (onDone) onDone();
    }

    function positionCard(el) {
      if (!el) {
        card.style.top = '50%';
        card.style.left = '50%';
        card.style.transform = 'translate(-50%,-50%)';
        return;
      }
      card.style.transform = 'none';
      const r  = el.getBoundingClientRect();
      const cw = 300;
      const ch = card.offsetHeight || 170;
      let top = r.bottom + 14;
      if (top + ch > window.innerHeight - 10) top = Math.max(10, r.top - ch - 14);
      let left = r.left;
      if (left + cw > window.innerWidth - 10) left = window.innerWidth - cw - 10;
      card.style.top  = top + 'px';
      card.style.left = Math.max(10, left) + 'px';
    }

    function render() {
      const step = steps[idx];
      const el   = step.selector ? document.querySelector(step.selector) : null;
      if (el) {
        const r = el.getBoundingClientRect();
        const pad = 6;
        hole.style.display = 'block';
        hole.style.top    = (r.top - pad) + 'px';
        hole.style.left   = (r.left - pad) + 'px';
        hole.style.width  = (r.width + pad * 2) + 'px';
        hole.style.height = (r.height + pad * 2) + 'px';
        try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
      } else {
        hole.style.display = 'none';
      }
      const last = idx === steps.length - 1;
      card.innerHTML =
        `<div class="sftk-tour-step">Step ${idx + 1} of ${steps.length}</div>` +
        `<div class="sftk-tour-title">${esc(step.title || '')}</div>` +
        `<div class="sftk-tour-text">${esc(step.text || '')}</div>` +
        `<div class="sftk-tour-actions">` +
          `<button class="sftk-tour-skip">${last ? '' : 'Skip tour'}</button>` +
          `<div class="sftk-tour-nav">` +
            (idx > 0 ? `<button class="sftk-tour-back">Back</button>` : '') +
            `<button class="sftk-tour-next">${last ? 'Got it' : 'Next'}</button>` +
          `</div>` +
        `</div>`;
      positionCard(el);
      const skip = card.querySelector('.sftk-tour-skip');
      if (skip) skip.onclick = finish;
      card.querySelector('.sftk-tour-next').onclick = () => {
        if (last) finish(); else { idx++; render(); }
      };
      const back = card.querySelector('.sftk-tour-back');
      if (back) back.onclick = () => { idx--; render(); };
    }

    window.addEventListener('resize', render);
    render();
  }

  // Run a tour only once per key (gated by chrome.storage.local).
  async function firstRun(key, steps) {
    try {
      const flag = 'sftk_tour_' + key;
      const d = await chrome.storage.local.get(flag);
      if (d[flag]) return;
      // Let the host UI settle before spotlighting elements.
      setTimeout(() => {
        tour(steps, () => {
          try { chrome.storage.local.set({ [flag]: Date.now() }); } catch (_) {}
        });
      }, 650);
    } catch (_) { /* storage unavailable — skip silently */ }
  }

  // Clear the one-time flag and replay the tour immediately (for a "Take the tour" button).
  async function replayTour(key, steps) {
    try { await chrome.storage.local.remove('sftk_tour_' + key); } catch (_) {}
    tour(steps);
  }

  // ── Inline "?" help badges ────────────────────────────────
  function help(text) {
    return `<span class="sftk-help" data-help="${esc(text)}" tabindex="0"
                  role="img" aria-label="Help">?</span>`;
  }

  function wireHelp(root) {
    (root || document).querySelectorAll('.sftk-help:not([data-wired])').forEach(badge => {
      badge.dataset.wired = '1';
      let tip = null;
      const show = () => {
        if (tip) return;
        tip = document.createElement('div');
        tip.className = 'sftk-help-tip';
        tip.textContent = badge.dataset.help || '';
        document.body.appendChild(tip);
        const r = badge.getBoundingClientRect();
        let left = r.left + r.width / 2 - tip.offsetWidth / 2;
        left = Math.max(8, Math.min(left, window.innerWidth - tip.offsetWidth - 8));
        let top = r.bottom + 6;
        if (top + tip.offsetHeight > window.innerHeight - 8) top = r.top - tip.offsetHeight - 6;
        tip.style.left = left + 'px';
        tip.style.top  = top + 'px';
      };
      const hide = () => { if (tip) { tip.remove(); tip = null; } };
      badge.addEventListener('mouseenter', show);
      badge.addEventListener('mouseleave', hide);
      badge.addEventListener('focus', show);
      badge.addEventListener('blur', hide);
    });
  }

  // ── Teaching empty state ──────────────────────────────────
  // opts: { icon, title, body, actionLabel, actionId }
  // If actionId is given, the button gets id=actionId so the caller can wire it.
  function emptyState(o) {
    o = o || {};
    return `<div class="sftk-empty">
      <div class="sftk-empty-icon">${o.icon || '✨'}</div>
      <div class="sftk-empty-title">${esc(o.title || '')}</div>
      <div class="sftk-empty-body">${esc(o.body || '')}</div>
      ${o.actionLabel
        ? `<button class="sftk-empty-action"${o.actionId ? ` id="${esc(o.actionId)}"` : ''}>${esc(o.actionLabel)}</button>`
        : ''}
    </div>`;
  }

  window.SFTKOnboard = { tour, firstRun, replayTour, help, wireHelp, emptyState };
})();
