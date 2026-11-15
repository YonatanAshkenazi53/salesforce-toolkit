// QA "works on any PC": screen sizes x device scale x theme, Toolkit popup + Data Studio.
// Shots: dist/qa/any-pc/<cfg>-<theme>-<page>.png ; findings: dist/qa/any-pc/findings.json
// Read-only in Salesforce.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const OUT = resolve('dist/qa/any-pc');
// [label, cssW, cssH, dsf] — the listed sizes at 100%, and each physical screen at 125% / 150% (CSS px = physical / scale)
const SCREENS = [[1280, 720], [1366, 768], [1920, 1080], [2560, 1440]];
const CFGS = [];
for (const [w, hh] of SCREENS) for (const s of [1, 1.25, 1.5]) CFGS.push([`${w}x${hh}@${s}`, Math.round(w / s), Math.round(hh / s), s]);
const ONLY_CFG = process.env.CFG ? process.env.CFG.split(',') : null;

const PROBE = `(() => {
  const vw = innerWidth, vh = innerHeight, out = {};
  const de = document.documentElement;
  out.hscroll = Math.max(de.scrollWidth, document.body.scrollWidth) - vw;
  const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw; };
  const name = el => (el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')) + ' "' + (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 40).replace(/\\s+/g, ' ') + '"';
  // topbar: one row?
  const tb = document.querySelector('.ds-topbar, .app-topbar');
  if (tb) { const kids = [...tb.querySelectorAll('button, a, input, select, .app-brand, .ds-brand')].filter(vis); const tops = kids.map(k => Math.round(k.getBoundingClientRect().top)); out.topbar = { h: Math.round(tb.getBoundingClientRect().height), rows: tops.length ? Math.round((Math.max(...tops) - Math.min(...tops))) : 0, overflow: tb.scrollWidth - tb.clientWidth }; }
  // elements wider than the viewport / poking past the right edge
  out.offRight = [...document.querySelectorAll('body *')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 4 && r.right > vw + 2 && vis(el) && getComputedStyle(el).position !== 'fixed'; }).slice(0, 6).map(el => name(el) + ' right=' + Math.round(el.getBoundingClientRect().right));
  // controls overlapping each other
  const ctl = [...document.querySelectorAll('button, a.btn, input:not([type=hidden]), select, textarea, [role=button]')].filter(vis).slice(0, 400);
  const ov = [];
  for (let i = 0; i < ctl.length && ov.length < 8; i++) for (let j = i + 1; j < ctl.length && ov.length < 8; j++) {
    const a = ctl[i], b = ctl[j]; if (a.contains(b) || b.contains(a)) continue;
    const r1 = a.getBoundingClientRect(), r2 = b.getBoundingClientRect();
    const x = Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left), y = Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top);
    if (x > 4 && y > 4) ov.push(name(a) + ' <> ' + name(b) + ' (' + Math.round(x) + 'x' + Math.round(y) + ')');
  }
  out.overlap = ov;
  // text clipped without an ellipsis (overflow hidden/clip, content wider/taller than the box)
  const clip = [];
  for (const el of document.querySelectorAll('body *')) {
    if (clip.length >= 8) break;
    if (!el.childNodes.length || ![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    if (!vis(el)) continue;
    const hidX = /hidden|clip/.test(cs.overflowX), hidY = /hidden|clip/.test(cs.overflowY);
    if (hidX && el.scrollWidth > el.clientWidth + 2 && cs.textOverflow !== 'ellipsis') clip.push(name(el) + ' w ' + el.scrollWidth + '>' + el.clientWidth);
    else if (hidY && el.scrollHeight > el.clientHeight + 3 && !cs.webkitLineClamp?.match(/\\d/) && el.clientHeight > 0) clip.push(name(el) + ' h ' + el.scrollHeight + '>' + el.clientHeight);
  }
  out.clipped = clip;
  // contrast of visible text
  const parse = c => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(',').map(s => parseFloat(s)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const bgOf = el => { const stack = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 0.95) break; } if (getComputedStyle(e).backgroundImage !== 'none') return null; } if (!stack.length) return { r: 255, g: 255, b: 255, a: 1 }; let base = stack.pop(); while (stack.length) { const t = stack.pop(); base = { r: t.r * t.a + base.r * (1 - t.a), g: t.g * t.a + base.g * (1 - t.a), b: t.b * t.a + base.b * (1 - t.a), a: 1 }; } return base; };
  const low = [];
  for (const el of document.querySelectorAll('body *')) {
    if (low.length >= 10) break;
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 1)) continue;
    if (!vis(el)) continue;
    const cs = getComputedStyle(el); const fg = parse(cs.color); const bg = bgOf(el); if (!fg || !bg) continue;
    if (el.closest('button:disabled, [disabled], [aria-disabled=true]')) continue;
    const f = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
    const L1 = lum(f), L2 = lum(bg); const cr = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    if (cr < 3) low.push(name(el) + ' ' + cr.toFixed(2) + ':1 ' + cs.color + ' on rgb(' + [bg.r, bg.g, bg.b].map(Math.round).join(',') + ')');
  }
  out.lowContrast = low;
  return out;
})()`;

export default async function (h) {
  mkdirSync(OUT, { recursive: true });
  await h.login('npc');
  await h.watchErrors();
  const ext = `chrome-extension://${h.extId}`;
  await h.studio('#/orgs');
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const profId = await h.eval(`(_profiles.find(p => /Accounts tree/.test(p.name)) || _profiles[0])?.id`);
  const findings = [];
  const setTheme = async dark => { await h.eval(`new Promise(r => chrome.storage.local.set({ sftk_dark: ${dark}, ds_dark_mode: ${dark}, sftk_oled: false }, () => r(true)))`); };
  const pages = [
    ['studio-home', async () => { await h.studio('#/orgs'); await h.sleep(2500); }],
    ['studio-deployments', async () => { await h.studio('#/profiles'); await h.sleep(2500); }],
    ['studio-deploy', async () => { await h.studio('#/profiles'); await h.sleep(1200); await h.eval(`window.runProfile(${JSON.stringify(profId)})`); await h.sleep(4000); }],
    ['studio-history', async () => { await h.studio('#/history'); await h.sleep(2500); }],
    ['studio-whatsnew', async () => { await h.studio('#/whatsnew'); await h.sleep(2500); }],
    ['popup-home', async () => { await h.navigate(`${ext}/popup.html`); await h.sleep(3500); }],
    ['popup-flows', async () => { await h.popup('flows'); await h.waitFor("document.querySelectorAll('.flow-group').length > 0", 60000, 500).catch(() => {}); await h.sleep(1000); }],
    ['popup-fields', async () => { await h.popup('fields'); await h.sleep(2500); }],
    ['popup-whatsnew', async () => { await h.navigate(`${ext}/popup.html`); await h.sleep(2500); await h.click('#dsWhatsNewTop'); await h.sleep(1500); }],
  ];
  for (const [label, w, hh, dsf] of CFGS) {
    if (ONLY_CFG && !ONLY_CFG.includes(label)) continue;
    await h.cdp('Emulation.setDeviceMetricsOverride', { width: w, height: hh, deviceScaleFactor: dsf, mobile: false });
    for (const theme of ['light', 'dark']) {
      await setTheme(theme === 'dark');
      for (const [pname, open] of pages) {
        try { await h.navigate("about:blank"); await open(); } catch (e) { findings.push({ cfg: label, theme, page: pname, error: String(e.message || e).slice(0, 200) }); continue; }
        const isDark = await h.eval(`document.documentElement.classList.contains('ds-dark') || document.body.classList.contains('sftk-dark')`);
        const file = `${OUT}/${label.replace('@', '_at')}-${theme}-${pname}.png`;
        await h.shot(file);
        const p = await h.eval(PROBE);
        const rec = { cfg: label, css: `${w}x${hh}`, dsf, theme, themeApplied: isDark === (theme === 'dark'), page: pname, shot: file, ...p };
        findings.push(rec);
        const bad = [];
        if (!rec.themeApplied) bad.push('THEME NOT APPLIED');
        if (p.hscroll > 1) bad.push(`hscroll ${p.hscroll}px`);
        if (p.topbar && (p.topbar.rows > 12 || p.topbar.overflow > 1)) bad.push(`topbar rows-spread ${p.topbar.rows} overflow ${p.topbar.overflow} h ${p.topbar.h}`);
        if (p.offRight.length) bad.push(`offRight ${p.offRight.length}`);
        if (p.overlap.length) bad.push(`overlap ${p.overlap.length}`);
        if (p.clipped.length) bad.push(`clipped ${p.clipped.length}`);
        if (p.lowContrast.length) bad.push(`lowContrast ${p.lowContrast.length}`);
        h.log(`${label} ${theme} ${pname}: ${bad.length ? bad.join(' · ') : 'ok'}`);
      }
    }
  }
  await h.cdp('Emulation.clearDeviceMetricsOverride', {});
  await setTheme(false);
  writeFileSync(`${OUT}/findings.json`, JSON.stringify(findings, null, 1));
  h.log(`page exceptions: ${h.exceptions.length}`, h.exceptions.slice(0, 5).join(' ‖ ').slice(0, 600));
  h.log('done');
}
