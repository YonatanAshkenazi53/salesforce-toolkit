// No org is changed: the Field Cleaner's done line, drawn on the real page with the real CSS, light and dark
// (owner 2026-11-20: "can we make the success line more satisfying to look at"). The rows are built the way
// markFixed builds them, from labels the fixes really return.
const LABELS = [
  ['SFTK_Pkg_Formula__c', '✅ Deleted — the formula or roll-up field is gone — verified by re-reading the org'],
  ['SFTK_Pkg_Class', '✅ Deleted — the Apex class is gone — verified by re-reading the org'],
  ['SFTK_Pkg_Red_Needs_Tag', '✅ Removed — 1 condition that uses the field taken out of the formula — the rule stays active on its other conditions — verified by re-reading the org'],
  ['Lookup Child → Parent filter', '✅ Removed — the filter had no other condition — the whole lookup filter is removed; the lookup field and its data stay — verified by re-reading the org'],
  ['SFTK_Pkg_FieldSet', '↩ Undone — put back, verified by re-reading the org'],
  ['SFTK_Pkg_Page', '✅ Nothing uses the field here — Salesforce lists it because its description or another text mentions the field’s name. Nothing to remove.'],
];
export default async function (h) {
  await h.login('npc2'); await h.popup('fields'); await h.sleep(1500);
  const draw = `(() => {
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const rows = ${JSON.stringify(LABELS)}.map(([n, l], i) => { const p = fcDoneParts(l); const undone = /^↩/.test(l);
      return '<div class="fc-item fc-item-fixed' + (undone ? ' fc-item-undone' : '') + '"><span class="fc-item-name">' + esc(n) + '</span><span class="fc-item-ok"><span class="fc-ok-chip' + (undone ? ' fc-ok-chip-undo' : '') + '"><span class="fc-ok-tick">' + (undone ? '↩' : '✓') + '</span>' + esc(p.verb) + '</span>' + (p.detail ? '<span class="fc-ok-what">' + esc(p.detail) + '</span>' : '') + (p.verified ? '<span class="fc-ok-ver">verified in the org</span>' : '') + '</span>' + (i < 4 ? '<button type="button" class="btn btn-secondary btn-sm fc-item-undo">↩ Undo</button>' : '') + '</div>'; }).join('');
    const host = document.getElementById('fcResults') || document.querySelector('.tab-panel.active') || document.body;
    host.style.display = ''; host.innerHTML = '<div class="fc-group"><div class="fc-group-items">' + rows + '</div></div>'; host.scrollIntoView({ block: 'start' }); return host.id || host.className;
  })()`;
  h.log('drawn in', await h.eval(draw));
  await h.sleep(700); await h.shot(h.shots + '/done-line-light.png');
  await h.eval(`(() => { document.body.classList.add('sftk-dark'); return true; })()`); await h.sleep(700);
  await h.shot(h.shots + '/done-line-dark.png');
}
