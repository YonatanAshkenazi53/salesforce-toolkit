// Live, read-only: every loader the Toolkit and Data Studio show while a page loads, caught as it appears, with the
// size the cat is drawn at (owner 2026-11-19: "also here kitty is too small when loading the page. please check all
// the places both in toolkit and data studio"). Each tab / view is opened and polled for the first .sftk-cat; its
// size, its container and a screenshot (dark) are kept. Nothing is clicked beyond opening the page.
const TABS = ['copy-perms', 'fields', 'pages', 'flows', 'flow-access', 'licenses', 'debugger'];
const VIEWS = ['profiles', 'orgs', 'picklists', 'compare', 'readiness', 'orghealth', 'seed', 'ring'];
const catch1 = async (h, name) => {
  let seen = null;
  for (let i = 0; i < 60 && !seen; i++) {
    try {
      seen = await h.eval(`(() => { const all = [...document.querySelectorAll('.sftk-cat')].filter(c => c.getBoundingClientRect().width > 0 && !c.closest('.ds-empty-icon, .topbar, header, .ds-topbar, .sftk-brand')); if (!all.length) return null; return all.map(c => { const r = c.getBoundingClientRect(); const box = c.closest('.lp-robot-loading, .sftk-prog, .ds-prog-cat, .ds-rec-opening') || c.parentElement; return Math.round(r.width) + 'px in .' + String(box.className).split(' ').slice(0, 2).join('.') + ' "' + (box.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 50) + '"'; }); })()`);
    } catch (_) { seen = null; }
    if (!seen) await h.sleep(100);
  }
  if (seen) { try { await h.eval(`(() => { document.body.classList.add('sftk-dark'); document.documentElement.classList.add('ds-dark'); return true; })()`); await h.shot(h.shots + '/cat-' + name + '.png'); } catch (_) { /* gone already */ } }
  h.log(name.padEnd(22), seen ? JSON.stringify(seen) : '(no loader seen in 6 s)');
  return seen;
};

export default async function (h) {
  await h.login('npc'); await h.login('npc2');
  await h.popup('flows');                         // the licence gate, once
  const ext = await h.eval('location.origin');
  h.log('— Toolkit —');
  for (const t of TABS) {
    await h.eval(`(() => { location.href = ${JSON.stringify(ext)} + '/popup.html?tab=${t}'; return true; })()`).catch(() => {});
    await catch1(h, 'toolkit-' + t);
    await h.sleep(2500);
  }
  h.log('— Data Studio —');
  await h.studio('');
  for (const v of VIEWS) {
    await h.eval(`(() => { const b = document.querySelector('.ds-nav-btn[data-view="${v}"]'); if (b) b.click(); return !!b; })()`).catch(() => {});
    await catch1(h, 'studio-' + v);
    await h.sleep(1500);
  }
}
