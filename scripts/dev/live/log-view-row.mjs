// Read only (no trace is started): the log viewer's filter row — Hide noise, and Text size at its right end
// (owner 2026-11-20: "when i click hide noise here nothing happens"; 2026-11-21: "this buttons should be placed in
// the yellow triangle." / "and also say text size"). Opens the newest log the org already holds.
import { execFileSync } from 'node:child_process';
const ORG = process.env.ORG || 'npc';
const cli = args => JSON.parse(execFileSync('sf', [...args, '--json'], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
export default async function (h) {
  const me = cli(['org', 'display', '-o', ORG]).result;
  const user = cli(['data', 'query', '-o', ORG, '-q', `"SELECT Id, Name FROM User WHERE Username = '${me.username}'"`]).result.records[0];
  await h.login(ORG); await h.popup('debugger'); await h.watchErrors();
  await h.eval("(() => { const st = document.createElement('style'); st.textContent = '* { transition: none !important; }'; document.head.appendChild(st); return true; })()");
  await h.waitFor("!!document.querySelector('#adbgUserInput')", 120000, 500); await h.sleep(800);
  await h.eval(`(() => { const i = document.querySelector('#adbgUserInput'); i.focus(); i.value = ${JSON.stringify(user.Name.split(' ')[0])}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('#adbgUserDrop .adbg-uopt[data-id="${user.Id}"]')`, 60000, 500);
  await h.eval(`document.querySelector('#adbgUserDrop .adbg-uopt[data-id="${user.Id}"]').click()`);
  await h.waitFor("document.querySelectorAll('#adbgLogList .adbg-log-row').length > 0", 60000, 500).catch(() => {});
  const n = await h.eval("document.querySelectorAll('#adbgLogList .adbg-log-row').length");
  h.log('logs listed:', n);
  if (!n) { h.log('no log in this org to open — nothing to show'); return; }
  await h.eval("document.querySelector('#adbgLogList .adbg-log-row').click()");
  await h.waitFor("!!document.querySelector('#adbgLogCats')", 90000, 500); await h.sleep(800);
  h.log('row:', await h.eval("[...document.querySelector('#adbgLogCats').children].map(e => e.innerText.replace(/\\s+/g, ' ').trim()).join(' | ')"));
  h.log('text size still in the title bar:', await h.eval("!!document.querySelector('#adbgLogToggle .adbg-log-font-btn')"));
  const size = () => h.eval("getComputedStyle(document.querySelector('#adbgLogView')).fontSize");
  const before = await size();
  await h.eval("document.getElementById('adbgLogFontUp').click()"); await h.sleep(300);
  h.log('A+ :', before, '→', await size(), '· log still open:', await h.eval("!!document.querySelector('#adbgLogView') && getComputedStyle(document.querySelector('#adbgLogView')).display !== 'none'"));
  await h.eval("document.getElementById('adbgLogFontReset').click()");
  await h.eval("document.querySelector('#adbgLogCats [data-cat=\"nonoise\"]').click()"); await h.sleep(600);
  h.log('hide noise:', await h.eval("document.querySelector('.adbg-log-noise-note')?.innerText || 'no note'"));
  await h.eval("document.querySelector('#adbgLogCats').scrollIntoView({ block: 'center' })");
  for (const dark of [false, true]) {
    await h.eval(`document.body.classList.toggle('sftk-dark', ${dark})`); await h.sleep(400);
    await h.shot(h.shots + `/log-view-row-${dark ? 'dark' : 'light'}.png`);
  }
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 3)')).slice(0, 300));
}
