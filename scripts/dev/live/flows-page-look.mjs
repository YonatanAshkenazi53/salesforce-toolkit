// Live, read-only: the Flows page after its 2026-10-31 polish (user: "the ui there looks bad") and
// the "whole flow + subflows" pick. Versions view with the dependency scan done (the chips need
// it), Restore view, light and dark; the chip's selection is counted and cleared — nothing deleted.
const NL = String.fromCharCode(10);
const dump = async (h, sel, n = 1200) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
export default async function (h) {
  await h.login('npc'); await h.popup('flows'); await h.watchErrors();
  await h.waitFor("document.querySelectorAll('.flow-group').length > 0", 240000, 1000);
  // the dependency scan, so the ↘ calls and "+ subflows" chips can be drawn
  await h.eval("document.querySelector('#flowViews [data-view=\"deps\"]')?.click()"); await h.sleep(2500);
  await h.eval("(() => { const b = [...document.querySelectorAll('button')].find(b => /Scan dependencies/.test(b.textContent)); if (b) b.click(); return !!b; })()");
  await h.waitFor("!!document.querySelector('#depExportBtn')", 240000, 1000); await h.sleep(800);
  await h.eval("document.querySelector('#flowViews [data-view=\"versions\"]')?.click()"); await h.sleep(1500);
  h.log('TOOLBAR:', await dump(h, '#toolbar', 400));
  h.log('tree chips:', await h.eval(`[...document.querySelectorAll('.flow-tree-btn')].map(b => b.closest('.flow-group').dataset.label + ' → ' + b.textContent).join(' | ')`));
  await h.eval("(() => { const g = [...document.querySelectorAll('.flow-group')].find(g => /Account Trigger/.test(g.dataset.label)); g?.scrollIntoView({ block: 'center' }); return true; })()"); await h.sleep(300);
  await h.shot(h.shots + '/flows-1-light.png');
  // + subflows on the trigger: the four levels get selected with it
  const before = await h.eval("selectedIds.size");
  await h.eval("(() => { const g = [...document.querySelectorAll('.flow-group')].find(g => /Account Trigger/.test(g.dataset.label)); g?.querySelector('.flow-tree-btn')?.click(); return true; })()"); await h.sleep(800);
  h.log('selected before/after + subflows:', before, '→', await h.eval("selectedIds.size"), '| summary:', await dump(h, '#selectionSummary', 200), '| delete button:', await dump(h, '#deleteBtn', 80));
  h.log('selected labels:', await h.eval("[...new Set(allFlows.filter(f => selectedIds.has(f.Id)).map(f => f.MasterLabel))].join(' | ')"));
  await h.shot(h.shots + '/flows-2-selected.png');
  await h.eval("document.querySelector('#deselectAllBtn')?.click()"); await h.sleep(300);
  await h.eval("document.querySelector('#sftkDarkToggle')?.click()"); await h.sleep(1500);
  await h.shot(h.shots + '/flows-3-dark.png');
  await h.eval("document.querySelector('.mode-btn[data-mode=\"restore\"]')?.click()"); await h.sleep(800);
  h.log('RESTORE view:', await dump(h, '#restorePanel', 300), '|', await dump(h, '#deleteArea', 100));
  await h.shot(h.shots + '/flows-4-restore-dark.png');
  await h.eval("document.querySelector('#sftkDarkToggle')?.click(); document.querySelector('#sftkDarkToggle')?.click()"); await h.sleep(800);
  await h.shot(h.shots + '/flows-5-restore-light.png');
}
