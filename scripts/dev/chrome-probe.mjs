// Why does the headless harness die on this Chrome? Launches Chrome with the harness's flags (and two
// variants), captures stderr and the exit code, and tries the first two protocol calls.
//   node scripts/dev/chrome-probe.mjs
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = resolve(process.env.SFTK_EXT || 'dist/store-staging');
const BLOCK = process.env.BLOCK || '';
const variants = {
  harness: ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging'],
  'no-ext-flag': ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--remote-debugging-pipe'],
  'old-headless': ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging'],
};
for (const [name, flags] of Object.entries(variants).filter(([n]) => !process.env.ONLYV || n === process.env.ONLYV)) {
  const profile = join(process.env.LOCALAPPDATA, 'Temp', `sftk-headless-probe-${name}`);
  rmSync(profile, { recursive: true, force: true }); mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, [...flags, `--user-data-dir=${profile}`, '--window-size=1600,800', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let err = ''; chrome.stderr.setEncoding('utf8'); chrome.stderr.on('data', d => { err += d; });
  const to = chrome.stdio[3], from = chrome.stdio[4];
  let buf = '', seq = 0; const pending = new Map();
  from.setEncoding('utf8');
  from.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\0')) >= 0) { const raw = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch (_) {} } });
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); to.write(JSON.stringify({ id, method, params }) + '\0'); setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ timeout: true }); } }, 8000); });
  const exited = new Promise(r => chrome.on('exit', (code, sig) => r({ code, sig })));
  const v = await send('Browser.getVersion');
  console.log(`[${name}] getVersion:`, v.result ? v.result.product : JSON.stringify(v).slice(0, 200));
  const e = await send('Extensions.loadUnpacked', { path: EXT });
  console.log(`[${name}] loadUnpacked:`, JSON.stringify(e).slice(0, 300));
  if (BLOCK === 'sync') { const t0 = Date.now(); while (Date.now() - t0 < 20000) {} console.log('[' + name + '] 20 s synchronous block done'); }
  if (BLOCK === 'attach-sf') {
    const a = await send('Target.attachToTarget', { targetId: (await send('Target.createTarget', { url: 'about:blank' })).result.targetId, flatten: true });
    console.log('[' + name + '] attached', JSON.stringify(a).slice(0, 120));
    const t0 = Date.now(); let out = '';
    try { out = execFileSync('sf', ['org', 'open', '-o', 'npc2', '--url-only', '--json'], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { out = 'sf failed: ' + e.message; }
    console.log('[' + name + '] sf org open took', Date.now() - t0, 'ms, got', out.length, 'chars');
  }
  if (BLOCK === 'async') { await new Promise(r => setTimeout(r, 20000)); console.log('[' + name + '] 20 s async wait done'); }
  const t = await send('Target.createTarget', { url: 'about:blank' });
  console.log(`[${name}] createTarget:`, JSON.stringify(t).slice(0, 200));
  const ex = await Promise.race([exited, new Promise(r => setTimeout(() => r('still running'), 1500))]);
  console.log(`[${name}] chrome:`, JSON.stringify(ex), '| stderr:', err.trim().split('\n').slice(-6).join(' ¦ ').slice(0, 900));
  try { chrome.kill(); } catch (_) {}
  await new Promise(r => setTimeout(r, 800));
  rmSync(profile, { recursive: true, force: true });
}
