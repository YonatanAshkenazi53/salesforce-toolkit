// Live QA (2026-10-18), read-only: screenshots of every new element, light and dark, for a human review.
// Popup: the Flows page's four views, the whole-flow button and interview chip, the interviews dialog.
// Data Studio: the Deploy page (folds, About section, engine note with Bulk + Bypass — chosen, never run).
// Screenshots: dist/qa/shots/theme-<light|dark>-*.png
import { mkdirSync } from 'node:fs';
const SHOTS = 'dist/qa/shots';
export default async function (h) {
  mkdirSync(SHOTS, { recursive: true });
  // the popup follows the org opened LAST — trailheads5 holds the fixture flows
  await h.login('npc2'); await h.login('npc'); await h.watchErrors();
  for (const theme of ['light', 'dark']) {
    // ── popup ──
    await h.popup('flows');
    await h.waitFor("document.querySelectorAll('.flow-group').length > 0", 120000, 500);
    await h.waitFor('typeof _flowInterviews === "object" && _flowInterviews.at > 0', 60000, 500).catch(() => {});
    const dark = await h.eval(`document.body.classList.contains('sftk-dark')`);
    if (dark !== (theme === 'dark')) { await h.eval(`document.getElementById('sftkDarkToggle').click()`); await h.sleep(600); }
    await h.eval(`(() => { const i = document.getElementById('searchInput'); i.value = 'SFTK FC'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await h.sleep(800);
    await h.shot(`${SHOTS}/theme-${theme}-flows-versions.png`);
    if (await h.eval(`!!document.querySelector('.flow-int-chip')`)) {
      await h.eval(`document.querySelector('.flow-int-chip').click()`); await h.sleep(800);
      await h.shot(`${SHOTS}/theme-${theme}-flows-interviews-dialog.png`);
      await h.eval(`(() => { const b = document.querySelector('#modalCancel'); if (b) b.click(); return true; })()`); await h.sleep(400);
    }
    for (const v of ['deps', 'switches', 'apiver']) {
      await h.eval(`document.querySelector('#flowViews [data-view="${v}"]').click()`);
      await h.sleep(v === 'deps' ? 2500 : 6000);
      await h.shot(`${SHOTS}/theme-${theme}-flows-${v}.png`);
    }
    // ── Data Studio ──
    await h.studio('');
    const sDark = await h.eval(`document.documentElement.classList.contains('ds-dark')`);
    if (sDark !== (theme === 'dark')) { await h.eval(`document.getElementById('dsDarkToggle').click()`); await h.sleep(600); }
    await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
    const id = await h.eval(`_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id`);
    await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(2000);
    await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
    await h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000); await h.sleep(3000);
    await h.shot(`${SHOTS}/theme-${theme}-deploy-top.png`);
    // the engine note, Bulk + Bypass (the deployment's own settings are put back below)
    const eng0 = await h.eval(`JSON.stringify({ a: document.querySelector('#dsDepApiMode').value, d: document.querySelector('#dsDepDupRules').value })`);
    const set = (sel, v) => h.eval(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await set('#dsDepApiMode', 'bulk'); await h.sleep(1500); await set('#dsDepDupRules', 'bypass'); await h.sleep(1500);
    await h.eval(`document.querySelector('#dsDepEngineNote')?.scrollIntoView({ block: 'center' })`); await h.sleep(500);
    await h.shot(`${SHOTS}/theme-${theme}-deploy-engine-note.png`);
    const e0 = JSON.parse(eng0);
    await set('#dsDepDupRules', e0.d); await h.sleep(1200); await set('#dsDepApiMode', e0.a); await h.sleep(1200);
  }
  // back to light on both pages
  await h.eval("(() => { for (let i = 0; i < 3 && document.documentElement.classList.contains('ds-dark'); i++) document.getElementById('dsDarkToggle').click(); return true; })()"); await h.sleep(400);   // one button cycles light → dark → OLED → light
  await h.popup('flows');
  if (await h.eval(`document.body.classList.contains('sftk-dark')`)) await h.eval(`document.getElementById('sftkDarkToggle').click()`);
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 5)')).slice(0, 500));
}
