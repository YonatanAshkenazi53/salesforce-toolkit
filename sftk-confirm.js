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
  // revOverride: { html, needsCheckbox, cls? }.
  const rev = opts.revOverride
    ? { cls: opts.revOverride.cls || 'sftk-rev-permanent', html: opts.revOverride.html,
        needsCheckbox: opts.revOverride.needsCheckbox !== false }
    : (REV[reversibility] || REV.permanent);

  const MAX_SHOWN = 12;
  const shown = items.slice(0, MAX_SHOWN);
  const moreCount = items.length - shown.length;
  const itemsHtml = items.length ? `
    <ul class="sftk-confirm-items">
      ${shown.map(i => `<li>${esc(i.label || i)}${i.sub ? ` <small>${esc(i.sub)}</small>` : ''}</li>`).join('')}
      ${moreCount > 0 ? `<li class="sftk-confirm-more">…and ${moreCount} more</li>` : ''}
    </ul>` : '';

  // Data Studio has its own modal classes (ds-*); the popup uses modal-*/btn.
  const ds = !!document.getElementById('dsModalBox');
  const C = ds
    ? { head: 'ds-modal-header', body: 'ds-modal-body', foot: 'ds-modal-footer', btn: 'ds-btn', primary: 'ds-btn ds-btn-danger', input: 'ds-input' }
    : { head: 'modal-header modal-danger', body: 'modal-body', foot: 'modal-footer', btn: 'btn btn-secondary', primary: 'btn btn-danger', input: 'search-input' };
  const word = String(typedWord || '').trim();
  const prod = production && (production.label || production === true) ? { label: String(production.label || '') } : null;
  const gateOff = rev.needsCheckbox || !!word;

  return new Promise(resolve => {
    window.showModal(`
      <div class="${C.head}">
        ${ds ? `${icon} ${esc(title)}` : `<span class="modal-icon">${icon}</span><h2>${esc(title)}</h2>`}
      </div>
      <div class="${C.body}">
        ${itemsHtml}
        <div class="sftk-confirm-rev ${rev.cls}">${rev.html}</div>
        ${undoHint ? `<div class="sftk-confirm-undo">↩ ${esc(undoHint)}</div>` : ''}
        ${extraHtml}
        ${rev.needsCheckbox ? `
          <label class="sftk-confirm-ack">
            <input type="checkbox" id="sftkConfirmAck">
            I understand this is permanent
          </label>` : ''}
        ${word ? `
          <label class="sftk-confirm-ack sftk-confirm-word">Type <code>${esc(word)}</code> to confirm:
            <input class="${C.input}" id="sftkConfirmWord" autocomplete="off" style="width:110px;padding:2px 6px">
          </label>` : ''}
        ${prod ? `<div class="sftk-confirm-prodnote">🛑 <strong>${esc(prod.label)}</strong> is treated as a PRODUCTION org — one more step asks for its name.</div>` : ''}
      </div>
      <div class="${C.foot}">
        <button class="${C.btn}" id="sftkConfirmCancel">Cancel</button>
        <button class="${C.primary}" id="sftkConfirmGo" ${gateOff ? 'disabled' : ''}>${esc(confirmLabel)}</button>
      </div>`);

    const done = val => {
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
    // The production step: the same dialog, the org's name typed exactly.
    const askProduction = () => {
      const box = document.getElementById('sftkConfirmGo')?.closest(ds ? '#dsModalBox' : '.modal, #modalBox') || document.getElementById('sftkConfirmGo')?.parentElement?.parentElement;
      if (!box) return done(true);
      box.innerHTML = `
        <div class="${C.head}">${ds ? '🛑 Production org' : '<span class="modal-icon">🛑</span><h2>Production org</h2>'}</div>
        <div class="${C.body}">
          <p>You're about to <strong>${esc(confirmLabel.replace(/^[^\w]+/, ''))}</strong> in <strong>${esc(prod.label)}</strong>, which is treated as a <strong>PRODUCTION</strong> org — what you change here affects real users now.</p>
          <p style="margin-top:8px">Type the org name to confirm: <code>${esc(prod.label)}</code></p>
          <input class="${C.input}" id="sftkConfirmProd" autocomplete="off" placeholder="${esc(prod.label)}" style="width:100%;margin-top:6px">
        </div>
        <div class="${C.foot}">
          <button class="${C.btn}" id="sftkConfirmProdCancel">Cancel</button>
          <button class="${C.primary}" id="sftkConfirmProdGo" disabled>Proceed</button>
        </div>`;
      const inp = document.getElementById('sftkConfirmProd'), go = document.getElementById('sftkConfirmProdGo');
      inp?.addEventListener('input', () => { if (go) go.disabled = inp.value.trim() !== prod.label; });
      inp?.focus();
      document.getElementById('sftkConfirmProdCancel')?.addEventListener('click', () => done(false));
      go?.addEventListener('click', () => done(true));
    };
    document.getElementById('sftkConfirmCancel')?.addEventListener('click', () => done(false));
    document.getElementById('sftkConfirmGo')?.addEventListener('click', () => { if (prod) askProduction(); else done(true); });
    document.getElementById('sftkConfirmAck')?.addEventListener('change', syncGo);
    document.getElementById('sftkConfirmWord')?.addEventListener('input', syncGo);
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
  const o = hit ? hit[1] : null;
  const label = (o && o.label) || want.replace(/\.my\.salesforce\.com$/, '');
  if (o && o.guardAsProd === true) return { production: true, label, why: 'guarded as production' };
  if (o && o.orgType === 'production') return { production: true, label, why: 'production org' };
  return { production: false, label, why: o ? (o.orgType || 'unknown type') : 'org not remembered' };
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkOrgWriteGate = sftkOrgWriteGate;
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkConfirmDestructive = sftkConfirmDestructive;
}
