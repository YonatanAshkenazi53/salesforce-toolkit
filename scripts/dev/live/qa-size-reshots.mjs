// Live QA: re-shots of the five spots the 1.1 size sweep found (2026-11-15). Read-only in Salesforce.
// Out: dist/qa/any-pc/reshot/<css width>-<theme>-<spot>.png (+ reshot.json with measurements)
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const OUT = resolve('dist/qa/any-pc/reshot');
// [label, cssW, cssH, dsf]
const CFGS = [['1280', 1280, 720, 1], ['1200', 1200, 700, 1], ['1093', 1093, 614, 1.25], ['1024', 1024, 576, 1.25], ['911', 911, 512, 1.5], ['853', 853, 480, 1.5]];
const ONLY = process.env.CFG ? process.env.CFG.split(',') : null;
const rectOf = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: Math.max(0, r.left - 8) + scrollX, y: Math.max(0, r.top - 8) + scrollY, width: Math.min(innerWidth, r.width + 16), height: Math.min(700, r.height + 16) }; })()`;
const MEASURE = `(() => { const vw = innerWidth; const tb = document.querySelector('.ds-topbar, .app-topbar'); const out = { vw, hscroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - vw };
  if (tb) { const vis = e => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(e).display !== 'none'; };
    out.topbarH = Math.round(tb.getBoundingClientRect().height); out.topbarOverflow = tb.scrollWidth - tb.clientWidth;
    out.offRight = [...tb.querySelectorAll('*')].filter(e => vis(e) && e.getBoundingClientRect().right > vw + 1).map(e => (e.id ? '#' + e.id : e.className) + ' right=' + Math.round(e.getBoundingClientRect().right)).slice(0, 6);
    out.right = [...tb.querySelectorAll('button, a')].filter(vis).map(e => (e.innerText || e.title || '').trim().replace(/\\s+/g, ' ').slice(0, 24) + '@' + Math.round(e.getBoundingClientRect().left) + '-' + Math.round(e.getBoundingClientRect().right)).slice(-6);
    const brand = document.querySelector('.app-brand, .ds-brand'); if (brand) out.brand = { h: Math.round(brand.getBoundingClientRect().height), w: Math.round(brand.getBoundingClientRect().width), text: brand.innerText.replace(/\\s+/g, ' ').slice(0, 60) }; }
  return out; })()`;
// The Toolkit top bar on a TOOL page (Home + org chip in the bar) is shot by qa-size-reshots-brand.mjs.
export default async function (h) {
  mkdirSync(OUT, { recursive: true });
  await h.login('npc'); await h.watchErrors();
  const ext = `chrome-extension://${h.extId}`;
  await h.studio('#/orgs');
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const setTheme = dark => h.eval(`new Promise(r => chrome.storage.local.set({ sftk_dark: ${dark}, ds_dark_mode: ${dark}, sftk_oled: false }, () => r(true)))`);
  const clip = async (file, rect) => { if (!rect) { h.log('NO ELEMENT for', file); return; } await h.eval('scrollTo(0, 0)'); const r = await h.cdp('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } }); writeFileSync(file, Buffer.from(r.data, 'base64')); };
  const all = [];
  for (const [label, w, hh, dsf] of CFGS) {
    if (ONLY && !ONLY.includes(label)) continue;
    await h.cdp('Emulation.setDeviceMetricsOverride', { width: w, height: hh, deviceScaleFactor: dsf, mobile: false });
    for (const theme of ['light', 'dark']) {
      await setTheme(theme === 'dark');
      const f = spot => `${OUT}/${label}-${theme}-${spot}.png`;
      // 1 + 2: Data Studio topbar, Connected Orgs card
      await h.navigate('about:blank'); await h.studio('#/orgs'); await h.sleep(2500);
      const m1 = await h.eval(MEASURE);
      await clip(f('studio-topbar'), { x: 0, y: 0, width: w, height: 64 });
      await clip(f('orgs-card'), await h.eval(rectOf('.ds-org-row')));
      const orgRow = await h.eval(`(() => { const r = document.querySelector('.ds-org-row'); if (!r) return null; const i = r.querySelector('.ds-org-row-info'), a = r.querySelector('.ds-org-row-actions'); return { rowW: Math.round(r.getBoundingClientRect().width), infoW: i ? Math.round(i.getBoundingClientRect().width) : null, infoH: i ? Math.round(i.getBoundingClientRect().height) : null, actionsRight: a ? Math.round(a.getBoundingClientRect().right) : null, rowRight: Math.round(r.getBoundingClientRect().right) }; })()`);
      // 3: the deployment card's delete button
      await h.navigate('about:blank'); await h.studio('#/profiles'); await h.sleep(2500);
      const del = await h.eval(`(() => { const b = [...document.querySelectorAll('.ds-btn-danger')].find(b => b.offsetParent); if (!b) return null; let card = b.parentElement; for (let i = 0; i < 6 && card.parentElement && card.getBoundingClientRect().height < 110; i++) card = card.parentElement; const chain = []; for (let e = b; e && chain.length < 6; e = e.parentElement) chain.push(e.className); card.setAttribute('data-reshot', '1'); const cs = getComputedStyle(b); return { color: cs.color, bg: cs.backgroundColor, border: cs.borderColor, text: b.innerText.trim(), chain: chain.join(' < ') }; })()`);
      await clip(f('deployment-card'), await h.eval(rectOf('[data-reshot]')));
      // 4 + 5: Toolkit home (the Data Studio card), Toolkit topbar brand
      await h.navigate('about:blank'); await h.navigate(`${ext}/popup.html`); await h.sleep(3500);
      const m2 = await h.eval(MEASURE);
      await clip(f('toolkit-topbar'), { x: 0, y: 0, width: w, height: 64 });
      const card = await h.eval(`(() => { const d = document.querySelector('.home-studio-desc'); if (!d) return null; const c = d.closest('.home-studio, .home-studio-card, a, button, div[class*="studio"]') || d.parentElement; c.setAttribute('data-reshot', '1'); const cs = getComputedStyle(d); const bg = getComputedStyle(c).backgroundColor; return { descColor: cs.color, cardBg: bg, cls: c.className }; })()`);
      await clip(f('home-studio-card'), await h.eval(rectOf('[data-reshot]')));
      const isDark = await h.eval(`document.body.classList.contains('sftk-dark')`);
      const rec = { cfg: label, css: `${w}x${hh}`, dsf, theme, themeApplied: isDark === (theme === 'dark'), studio: m1, orgRow, del, toolkit: m2, card };
      all.push(rec);
      h.log(`${label} ${theme}:`, JSON.stringify(rec).slice(0, 1500));
    }
  }
  await h.cdp('Emulation.clearDeviceMetricsOverride', {});
  await setTheme(false);
  writeFileSync(`${OUT}/reshot.json`, JSON.stringify(all, null, 1));
  h.log('page exceptions:', h.exceptions.length, '| done');
}
