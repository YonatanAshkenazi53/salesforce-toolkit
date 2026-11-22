// Read only: the Flows page, its Versions list and its Dependencies fold, as they are drawn on a real org.
// VIEW=versions|deps (default both), DARK=1.
export default async function (h) {
  await h.login(process.env.ORG || 'npc2'); await h.popup('flows');
  await h.eval("(() => { const st = document.createElement('style'); st.textContent = '* { transition: none !important; }'; document.head.appendChild(st); return true; })()");
  await h.waitFor("document.querySelectorAll('#flowList .flow-group, #flowList [class*=flow-row], #flowList > *').length > 0", 90000, 500).catch(() => {});
  await h.sleep(2500);
  if (process.env.DARK === '1') await h.eval("document.body.classList.add('sftk-dark')");
  h.log('views:', await h.eval("[...document.querySelectorAll('#flowViews .flow-view-btn')].map(b => b.innerText.trim() + (b.classList.contains('active') ? '*' : '')).join(' | ')"));
  h.log('filters on the list:', await h.eval("[...document.querySelectorAll('#flowTypeFilter .dep-filter-btn, #flowTypeFilter button')].map(b => b.innerText.trim() + (b.classList.contains('active') ? '*' : '')).join(' | ') || 'none'"));
  h.log('rows:', await h.eval("document.querySelectorAll('#flowList .flow-group').length"), '· first rows:', await h.eval("[...document.querySelectorAll('#flowList .flow-group')].slice(0, 4).map(g => g.innerText.replace(/\\s+/g, ' ').slice(0, 150)).join(' ## ')"));
  await h.shot(h.shots + '/flows-versions.png');
  if (process.env.STEPS) {
    for (const step of process.env.STEPS.split(';')) { h.log('step', step, '→', String(await h.eval(step)).slice(0, 600)); await h.sleep(1500); }
    await h.shot(h.shots + '/flows-after-steps.png');
  }
  if (process.env.VIEW !== 'versions') {
    // the dependency map is a fold of the Flows page since 2026-11-21 (the Dependencies view button is gone): opening it draws the map
    await h.eval("(() => { const d = document.getElementById('flowDepsFold'); if (d && !d.open) d.querySelector('summary').click(); return !!d; })()"); await h.sleep(6000);
    await h.eval("(() => { document.getElementById('flowDepsFold')?.scrollIntoView({ block: 'start' }); return true; })()"); await h.sleep(300);
    h.log('deps html head:', await h.eval("(document.getElementById('depTreeContainer')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 900)"));
    await h.shot(h.shots + '/flows-deps.png');
  }
}
