// How heavy is the Deploy page after a dry run? (owner 2026-11-14: "after it ran feels very heavy … optimize … large
// operations"). Runs the dry run of a big deployment, then measures: DOM size, running animations, timers firing,
// heap, and how long the main thread is busy over a few idle seconds and over one scroll. READ-ONLY (a dry run rolls back).
//   PROFILE (default "SFTK VOL — Accounts")
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK VOL — Accounts';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (!id) throw new Error('profile missing: ' + NAME);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`);
  await h.waitFor("!!document.querySelector('#dsRecProbeBtn') && !document.querySelector('#dsDepLoader') && !document.querySelector('#dsDepRefresh')?.disabled", 400000, 1000);
  await h.sleep(2000);
  const tick = await h.eval("(() => { const b = [...document.querySelectorAll('button')].find(x => /Tick every insert/.test(x.textContent)); if (b) b.click(); return b ? b.textContent.trim() : null; })()");
  h.log('ticked:', tick); await h.sleep(2500);
  await h.cdp('Performance.enable');
  const metrics = async label => {
    const m = Object.fromEntries((await h.cdp('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
    const page = await h.eval(`(() => ({ nodes: document.getElementsByTagName('*').length, svgs: document.querySelectorAll('svg').length, cats: document.querySelectorAll('.sftk-cat-ringcat').length,
      animations: document.getAnimations().length, rows: document.querySelectorAll('.ds-prog-row').length, logChars: (document.querySelector('#dsRecProgress')?.innerHTML.length || 0) + (document.querySelector('.ds-dep-lastlog')?.innerHTML.length || 0) }))()`);
    h.log(label, JSON.stringify({ ...page, heapMB: Math.round(m.JSHeapUsedSize / 1048576), layouts: m.LayoutCount, recalcs: m.RecalcStyleCount, scriptMs: Math.round(m.ScriptDuration * 1000), layoutMs: Math.round(m.LayoutDuration * 1000), styleMs: Math.round(m.RecalcStyleDuration * 1000) }));
    return m;
  };
  const busy = async (label, ms) => {
    const a = await metrics(label + ' (start)');
    await h.eval(`window.__lt = 0; window.__po && window.__po.disconnect(); window.__po = new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt += e.duration; }); window.__po.observe({ type: 'longtask', buffered: false }); true`);
    await h.sleep(ms);
    const b = await metrics(label + ' (end)');
    h.log(`${label}: over ${ms} ms — script ${Math.round((b.ScriptDuration - a.ScriptDuration) * 1000)} ms, layout ${Math.round((b.LayoutDuration - a.LayoutDuration) * 1000)} ms, style ${Math.round((b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000)} ms, layouts ${b.LayoutCount - a.LayoutCount}, recalcs ${b.RecalcStyleCount - a.RecalcStyleCount}, long tasks ${Math.round(await h.eval('window.__lt'))} ms`);
  };
  await busy('BEFORE the dry run, idle', 4000);
  await h.click('#dsRecProbeBtn'); await h.sleep(1500);
  await h.eval("(() => { const b = document.querySelector('#sftkConfirmGo'); if (b && !b.disabled) b.click(); return true; })()");
  await h.waitFor("/Dry run complete/.test(document.body.innerText)", 600000, 1000);
  await h.sleep(4000);
  await busy('AFTER the dry run, idle', 5000);
  await h.eval("(() => { window.__st = setInterval(() => window.scrollBy(0, 120), 50); setTimeout(() => clearInterval(window.__st), 2500); return true; })()");
  await busy('AFTER, while scrolling', 3000);
  await h.eval("(() => { document.querySelector('[data-dep-obj]')?.click(); return true; })()");
  await busy('AFTER, a tab click', 2500);
  h.log('timers:', await h.eval("(() => { let n = 0; const id = setInterval(() => {}, 100000); clearInterval(id); return id; })()"));
}
