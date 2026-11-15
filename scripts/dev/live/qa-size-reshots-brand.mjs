// Re-shot (2026-11-15): the Toolkit top bar ON A TOOL PAGE (Home + org chip in the bar) at 853 and 911 CSS px.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const OUT = resolve('dist/qa/any-pc/reshot');
export default async function (h) {
  mkdirSync(OUT, { recursive: true });
  await h.login('npc'); await h.watchErrors();
  const setTheme = dark => h.eval(`new Promise(r => chrome.storage.local.set({ sftk_dark: ${dark}, ds_dark_mode: ${dark}, sftk_oled: false }, () => r(true)))`);
  await h.popup('flows');
  // HIST=1 (2026-11-15): the widest action row is the one WITH the tool's History button — it only shows once the tool has an
  // entry, so one stand-in entry is stored in this run's throwaway profile (nothing is written to Salesforce)
  const HIST = process.env.HIST === '1';
  if (HIST) await h.eval(`new Promise(r => chrome.storage.local.get('sftk_history', g => chrome.storage.local.set({ sftk_history: [...(g.sftk_history || []), { id: 'reshot-standin', kind: 'tool', tool: 'Flow switches', profileName: 'stand-in entry for the size re-shot', status: 'success', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), orgUrl: '', errors: [], undo: { none: 'a stand-in entry' } }] }, () => r(true))))`);
  for (const [label, w, hh, dsf] of [['853', 853, 480, 1.5], ['911', 911, 512, 1.5], ['1024', 1024, 576, 1.25]]) {
    await h.cdp('Emulation.setDeviceMetricsOverride', { width: w, height: hh, deviceScaleFactor: dsf, mobile: false });
    for (const theme of ['light', 'dark']) {
      await setTheme(theme === 'dark');
      await h.navigate('about:blank'); await h.popup('flows');
      await h.waitFor("document.querySelectorAll('.flow-group').length > 0", 60000, 500).catch(() => {});
      await h.sleep(1500);
      const m = await h.eval(`(() => { const tb = document.querySelector('.app-topbar'); const b = document.querySelector('.app-brand'); const kids = [...tb.querySelectorAll('button, a, select')].filter(e => e.getBoundingClientRect().width > 2); return { vw: innerWidth, topbarH: Math.round(tb.getBoundingClientRect().height), overflow: tb.scrollWidth - tb.clientWidth, hscroll: document.documentElement.scrollWidth - innerWidth, brandH: Math.round(b.getBoundingClientRect().height), brandW: Math.round(b.getBoundingClientRect().width), brandTop: Math.round(b.getBoundingClientRect().top), lastRight: Math.round(Math.max(...kids.map(k => k.getBoundingClientRect().right))), dark: document.body.classList.contains('sftk-dark') }; })()`);
      const hist = await h.eval(`(() => { const b = document.querySelector('#sftkThBtn'); return b && b.style.display !== 'none' ? b.innerText.trim() + '@' + Math.round(b.getBoundingClientRect().left) + '-' + Math.round(b.getBoundingClientRect().right) : 'hidden'; })()`);
      h.log(`${label} ${theme}:`, JSON.stringify(m), '| History button:', hist);
      const r = await h.cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: 130, scale: 1 } });
      writeFileSync(`${OUT}/${label}-${theme}-toolkit-topbar-flows${HIST ? '-hist' : ''}.png`, Buffer.from(r.data, 'base64'));
    }
  }
  await h.cdp('Emulation.clearDeviceMetricsOverride', {});
  await setTheme(false);
  h.log('done');
}
