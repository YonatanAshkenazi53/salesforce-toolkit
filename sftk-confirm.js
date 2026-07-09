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

  return new Promise(resolve => {
    window.showModal(`
      <div class="modal-header modal-danger">
        <span class="modal-icon">${icon}</span>
        <h2>${esc(title)}</h2>
      </div>
      <div class="modal-body">
        ${itemsHtml}
        <div class="sftk-confirm-rev ${rev.cls}">${rev.html}</div>
        ${undoHint ? `<div class="sftk-confirm-undo">↩ ${esc(undoHint)}</div>` : ''}
        ${extraHtml}
        ${rev.needsCheckbox ? `
          <label class="sftk-confirm-ack">
            <input type="checkbox" id="sftkConfirmAck">
            I understand this is permanent
          </label>` : ''}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="sftkConfirmCancel">Cancel</button>
        <button class="btn btn-danger" id="sftkConfirmGo" ${rev.needsCheckbox ? 'disabled' : ''}>${esc(confirmLabel)}</button>
      </div>`);

    const done = val => {
      if (typeof window.closeModal === 'function') window.closeModal();
      resolve(val);
    };
    document.getElementById('sftkConfirmCancel')?.addEventListener('click', () => done(false));
    document.getElementById('sftkConfirmGo')?.addEventListener('click', () => done(true));
    if (rev.needsCheckbox) {
      document.getElementById('sftkConfirmAck')?.addEventListener('change', e => {
        const go = document.getElementById('sftkConfirmGo');
        if (go) go.disabled = !e.target.checked;
      });
    }
    if (typeof onRender === 'function') onRender();
  });
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkConfirmDestructive = sftkConfirmDestructive;
}
