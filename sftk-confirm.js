// ── Shared destructive-operation confirm (C4) ────────────────────────────────
// One consistent last-stop dialog for every destructive popup operation:
// names every item, states TRUE reversibility, requires an explicit checkbox
// for permanent ops, and lets callers surface an undo path. Renders through
// the host page's showModal/closeModal (popup.js provides them; falls back to
// window.confirm when absent, e.g. in a bare harness).
//
// Usage:
//   const ok = await sftkConfirmDestructive({
//     title: 'Delete 3 flows',
//     items: [{ label: 'My Flow v4', sub: 'Active' }, …],
//     reversibility: 'permanent' | 'recycle' | 'new-version',
//     confirmLabel: '🗑 Delete',
//     undoHint: 'Backups downloaded above can be restored via Restore mode.',
//     extraHtml: '<div id="myExtra">…</div>',   // optional, caller wires via onRender
//     onRender: () => { … },                    // after the modal is in the DOM
//   });

function sftkConfirmDestructive(opts) {
  const {
    title = 'Are you sure?',
    icon = '🗑',
    items = [],
    reversibility = 'permanent',
    confirmLabel = 'Delete',
    undoHint = '',
    extraHtml = '',
    onRender = null,
    // Campaign 3, phase 2 — one confirmation for both pages:
    //   production: { label }   → after the acknowledgement, a second step in
    //                             the SAME dialog asks for the org's name
    //                             (typed exactly); false/undefined = no step.
    //   typedWord: 'CHANGE'     → the Go button stays off until that word is
    //                             typed (the ⚙ API versions / ⏻ switches /
    //                             ↩ ROLLBACK rule), in the first step.
    production = null,
    typedWord = '',
  } = opts || {};

  const esc = s => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  if (typeof window.showModal !== 'function') {
    // Bare-environment fallback — still names the items and the stakes.
    const rev = reversibility === 'recycle' ? 'Recoverable from the Recycle Bin for 15 days.'
              : reversibility === 'new-version' ? 'Deploys a new version; the previous one remains.'
              : 'PERMANENT — cannot be undone.';
    return Promise.resolve(window.confirm(
      `${title}\n\n${items.map(i => '• ' + (i.label || i)).join('\n')}\n\n${rev}`));
  }

  const REV = {
    recycle: {
      cls: 'sftk-rev-recycle',
      html: '♻ <strong>Recoverable</strong> — deleted records go to the Recycle Bin and can be restored for 15 days.',
      needsCheckbox: false,
    },
    permanent: {
      cls: 'sftk-rev-permanent',
      html: '⛔ <strong>Permanent</strong> — Salesforce cannot undo this. There is no Recycle Bin for this type.',
      needsCheckbox: true,
    },
    'new-version': {
      cls: 'sftk-rev-newver',
      html: '🔁 <strong>Reversible</strong> — this deploys a new version; the previous version remains and can be re-activated.',
      needsCheckbox: false,
    },
  };
  // Callers with a nuance the three presets can't express (e.g. custom fields:
  // restorable from Setup's "Deleted Fields" for 15 days, THEN permanent) pass
  // revOverride: { html, needsCheckbox, cls?, ack? } — ack: the acknowledgement's
  // own words when "permanent" is not the truth (an ↩ Undo writes a state back).
  const rev = opts.revOverride
    ? { cls: opts.revOverride.cls || 'sftk-rev-permanent', html: opts.revOverride.html,
        needsCheckbox: opts.revOverride.needsCheckbox !== false, ack: opts.revOverride.ack || '' }
    : (REV[reversibility] || REV.permanent);

  // ── The dialog (redesigned 2026-10-07, user: "these type of screens all over
  // should be better") — one shape for every write, on both pages:
  //   head   the sentence (title) + facts chips (how many, how reversible, where)
  //   band   production, when the target is treated as one
  //   body   the stakes (coloured by severity), the items as a real list with a
  //          filter when there are many, the caller's extras, the undo hint
  //   foot   pinned: the acknowledgement / typed word on the left, Cancel · Go
  //          on the right — never scrolled away
  // The ids (sftkConfirmGo / Ack / Word / Cancel / Prod / ProdGo / ProdCancel)
  // and the two-step production flow are unchanged: callers, tests and the
  // live scripts rely on them.
  const MAX_SHOWN = 500;
  const shown = items.slice(0, MAX_SHOWN);
  const moreCount = items.length - shown.length;
  const itemLabel = i => esc(typeof i === 'string' ? i : (i.label || ''));
  const itemSub = i => (i && typeof i === 'object' && i.sub) ? esc(i.sub) : '';
  const itemsHtml = items.length ? `
    <div class="sftk-cf-items">
      <div class="sftk-cf-items-head">
        <span class="sftk-cf-items-count">${items.length} ${items.length === 1 ? 'item' : 'items'}</span>
        ${items.length > 8 ? `<input class="${C.input} sftk-cf-filter" id="sftkConfirmFilter" placeholder="filter…" autocomplete="off" aria-label="Filter the list">` : ''}
      </div>
      <div class="sftk-cf-list sftk-confirm-items" role="list">
        ${shown.map(i => `<div class="sftk-cf-row" role="listitem"><span class="sftk-cf-row-l">${itemLabel(i)}</span>${itemSub(i) ? `<span class="sftk-cf-row-s">${itemSub(i)}</span>` : ''}</div>`).join('')}
        ${moreCount > 0 ? `<div class="sftk-cf-row sftk-confirm-more">…and ${moreCount} more — the list is capped; every one of them is included</div>` : ''}
      </div>
    </div>` : '';

  // Severity drives the colour: red = permanent (needs the acknowledgement),
  // blue = reversible by design (Recycle Bin, a new version), amber = a write
  // that is recorded and may be undone from History.
  const sev = rev.needsCheckbox ? 'red' : (!opts.revOverride && (reversibility === 'recycle' || reversibility === 'new-version')) ? 'blue' : 'amber';
  const revWord = rev.needsCheckbox ? 'Permanent' : reversibility === 'recycle' && !opts.revOverride ? 'Recycle Bin · 15 days'
    : reversibility === 'new-version' && !opts.revOverride ? 'Reversible' : (undoHint && /undo/i.test(undoHint) ? 'Undo in History' : 'Writes');
  const facts = [
    items.length ? `${items.length} ${items.length === 1 ? 'item' : 'items'}` : null,
    revWord,
    ...(Array.isArray(opts.facts) ? opts.facts.map(String) : []),
  ].filter(Boolean);

  // Data Studio has its own modal classes (ds-*); the popup uses modal-*/btn.
  const ds = !!document.getElementById('dsModalBox');
  const C = ds
    ? { head: 'ds-modal-header', body: 'ds-modal-body', foot: 'ds-modal-footer', btn: 'ds-btn', primary: 'ds-btn ds-btn-danger', input: 'ds-input' }
    : { head: 'modal-header modal-danger', body: 'modal-body', foot: 'modal-footer', btn: 'btn btn-secondary', primary: 'btn btn-danger', input: 'search-input' };
  const word = String(typedWord || '').trim();
  const prod = production && (production.label || production === true) ? { label: String(production.label || '') } : null;
  const gateOff = rev.needsCheckbox || !!word;
  const hostBox = () => document.getElementById(ds ? 'dsModalBox' : 'modalBox');

  return new Promise(resolve => {
    window.showModal(`
      <div class="sftk-cf sftk-cf-sev-${sev}">
        <div class="sftk-cf-head">
          <span class="sftk-cf-icon" aria-hidden="true">${icon}</span>
          <div class="sftk-cf-headtext">
            <h2 class="sftk-cf-title">${esc(title)}</h2>
            <div class="sftk-cf-facts">${facts.map(f => `<span class="sftk-cf-fact">${esc(f)}</span>`).join('')}</div>
          </div>
        </div>
        ${prod ? `<div class="sftk-cf-band sftk-confirm-prodnote">🛑 <strong>${esc(prod.label)}</strong> is treated as a PRODUCTION org — one more step asks for its name.</div>` : ''}
        <div class="sftk-cf-body">
          <div class="sftk-cf-stakes sftk-confirm-rev ${rev.cls}">${rev.html}</div>
          ${itemsHtml}
          ${extraHtml ? `<div class="sftk-cf-extra">${extraHtml}</div>` : ''}
          ${undoHint ? `<div class="sftk-cf-undo sftk-confirm-undo">↩ ${esc(undoHint)}</div>` : ''}
        </div>
        <div class="sftk-cf-foot">
          <div class="sftk-cf-gates">
            ${rev.needsCheckbox ? `
              <label class="sftk-confirm-ack sftk-cf-ack">
                <input type="checkbox" id="sftkConfirmAck">
                <span>${esc(rev.ack || 'I understand this is permanent')}</span>
              </label>` : ''}
            ${word ? `
              <label class="sftk-confirm-ack sftk-confirm-word sftk-cf-word">Type <code>${esc(word)}</code> to confirm
                <input class="${C.input}" id="sftkConfirmWord" autocomplete="off" spellcheck="false" aria-label="Type ${esc(word)} to confirm">
              </label>` : ''}
          </div>
          <div class="sftk-cf-actions">
            <button class="${C.btn}" id="sftkConfirmCancel">Cancel</button>
            <button class="${C.primary} sftk-cf-go" id="sftkConfirmGo" ${gateOff ? 'disabled' : ''}>${esc(confirmLabel)}</button>
          </div>
        </div>
      </div>`);
    hostBox()?.classList.add('sftk-cf-host');

    const done = val => {
      hostBox()?.classList.remove('sftk-cf-host');
      if (typeof window.closeModal === 'function') window.closeModal();
      resolve(val);
    };
    const syncGo = () => {
      const go = document.getElementById('sftkConfirmGo');
      if (!go) return;
      const ackOk = !rev.needsCheckbox || !!document.getElementById('sftkConfirmAck')?.checked;
      const wordOk = !word || (document.getElementById('sftkConfirmWord')?.value || '').trim().toUpperCase() === word.toUpperCase();
      go.disabled = !(ackOk && wordOk);
    };
    // The list filter: client-side, on the rendered rows.
    document.getElementById('sftkConfirmFilter')?.addEventListener('input', e => {
      const q = String(e.target.value || '').trim().toLowerCase();
      document.querySelectorAll('.sftk-cf-list .sftk-cf-row:not(.sftk-confirm-more)').forEach(r => { r.style.display = !q || r.textContent.toLowerCase().includes(q) ? '' : 'none'; });
    });
    // The production step: the same dialog, the org's name typed exactly.
    const askProduction = () => {
      const box = document.getElementById('sftkConfirmGo')?.closest(ds ? '#dsModalBox' : '.modal, #modalBox') || document.getElementById('sftkConfirmGo')?.parentElement?.parentElement;
      if (!box) return done(true);
      box.innerHTML = `
        <div class="sftk-cf sftk-cf-sev-red">
          <div class="sftk-cf-head">
            <span class="sftk-cf-icon" aria-hidden="true">🛑</span>
            <div class="sftk-cf-headtext">
              <h2 class="sftk-cf-title">Production org</h2>
              <div class="sftk-cf-facts"><span class="sftk-cf-fact">${esc(prod.label)}</span><span class="sftk-cf-fact">${esc(confirmLabel.replace(/^[^\w]+/, ''))}</span></div>
            </div>
          </div>
          <div class="sftk-cf-body">
            <div class="sftk-cf-stakes sftk-confirm-rev sftk-rev-permanent">You're about to <strong>${esc(confirmLabel.replace(/^[^\w]+/, ''))}</strong> in <strong>${esc(prod.label)}</strong>, which is treated as a <strong>PRODUCTION</strong> org — what you change here affects real users now.</div>
          </div>
          <div class="sftk-cf-foot">
            <div class="sftk-cf-gates">
              <label class="sftk-confirm-ack sftk-cf-word">Type the org name <code>${esc(prod.label)}</code> to confirm
                <input class="${C.input}" id="sftkConfirmProd" autocomplete="off" spellcheck="false" placeholder="${esc(prod.label)}">
              </label>
            </div>
            <div class="sftk-cf-actions">
              <button class="${C.btn}" id="sftkConfirmProdCancel">Cancel</button>
              <button class="${C.primary} sftk-cf-go" id="sftkConfirmProdGo" disabled>Proceed</button>
            </div>
          </div>
        </div>`;
      const inp = document.getElementById('sftkConfirmProd'), go = document.getElementById('sftkConfirmProdGo');
      inp?.addEventListener('input', () => { if (go) go.disabled = inp.value.trim() !== prod.label; });
      inp?.addEventListener('keydown', e => { if (e.key === 'Enter' && go && !go.disabled) go.click(); });
      inp?.focus();
      document.getElementById('sftkConfirmProdCancel')?.addEventListener('click', () => done(false));
      go?.addEventListener('click', () => done(true));
    };
    document.getElementById('sftkConfirmCancel')?.addEventListener('click', () => done(false));
    document.getElementById('sftkConfirmGo')?.addEventListener('click', () => { if (prod) askProduction(); else done(true); });
    document.getElementById('sftkConfirmAck')?.addEventListener('change', syncGo);
    document.getElementById('sftkConfirmWord')?.addEventListener('input', syncGo);
    document.getElementById('sftkConfirmWord')?.addEventListener('keydown', e => { const go = document.getElementById('sftkConfirmGo'); if (e.key === 'Enter' && go && !go.disabled) go.click(); });
    (document.getElementById('sftkConfirmWord') || document.getElementById('sftkConfirmAck') || document.getElementById('sftkConfirmCancel'))?.focus?.();
    if (typeof onRender === 'function') onRender();
  });
}

// Is this org one where a write must also be confirmed by typing its name?
// The Connected Orgs page stores every org seen (sftk_orgs: orgType from the
// org's own IsSandbox / trial answer, and the user's 🛑 Guard as production
// flag). Both pages share that storage, so both answer the same way.
// Returns { production: boolean, label: string, why: string }.
async function sftkOrgWriteGate(orgUrl, orgs) {
  const url = String(orgUrl || '');
  if (!url) return { production: false, label: '', why: 'no org' };
  let all = orgs;
  if (!all) {
    try { all = (await chrome.storage.local.get('sftk_orgs')).sftk_orgs || {}; } catch (_) { all = {}; }
  }
  const key = u => String(u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.lightning\.force\.com$/, '.my.salesforce.com');
  const want = key(url);
  const hit = Object.entries(all || {}).find(([u]) => key(u) === want);
  let o = hit ? hit[1] : null;
  const label = (o && o.label) || want.replace(/\.my\.salesforce\.com$/, '');
  if (o && o.guardAsProd === true) return { production: true, label, why: 'guarded as production' };
  const fresh = !!(o && o.orgType && (Date.now() - (o.orgTypeAt || 0)) < 7 * 864e5);
  // Not remembered, or remembered too long ago: ask the org itself, the way
  // Data Studio's Connected Orgs page does (IsSandbox / trial / Developer
  // Edition → not production; anything else → production), through the live
  // session the background already holds for that tab. Stored for both pages.
  if (!fresh && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    try {
      const ask = msg => new Promise(res => chrome.runtime.sendMessage(msg, r => res(r)));
      const sessions = (await ask({ type: 'GET_ALL_SF_SESSIONS' }))?.sessions || [];
      const sess = sessions.find(x => key(x.orgUrl) === want);
      if (sess && sess.sid) {
        const q = await ask({ type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid, _suppressError: true,
          query: 'SELECT IsSandbox, OrganizationType, TrialExpirationDate FROM Organization' });
        const rec = q && q.records && q.records[0];
        if (rec) {
          const type = rec.IsSandbox ? 'sandbox' : (rec.OrganizationType === 'Developer Edition' || rec.TrialExpirationDate) ? 'dev' : 'production';
          const storeUrl = hit ? hit[0] : sess.orgUrl;
          all = all || {};
          all[storeUrl] = { ...(all[storeUrl] || {}), label: (all[storeUrl] && all[storeUrl].label) || sess.label || label, orgType: type, orgTypeAt: Date.now() };
          try { await chrome.storage.local.set({ sftk_orgs: all }); } catch (_) {}
          o = all[storeUrl];
        }
      }
    } catch (_) { /* fall through to the fail-closed answer below */ }
  }
  if (o && o.orgType === 'production') return { production: true, label: (o.label || label), why: 'production org' };
  if (o && (o.orgType === 'sandbox' || o.orgType === 'dev')) return { production: false, label: (o.label || label), why: o.orgType };
  // Fail closed (the project's rule): an org whose type could not be read is
  // treated as production — the typed name costs a few seconds, a blind
  // write into production costs a lot more.
  return { production: true, label, why: 'org type unknown — treated as production' };
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkOrgWriteGate = sftkOrgWriteGate;
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkConfirmDestructive = sftkConfirmDestructive;
}
