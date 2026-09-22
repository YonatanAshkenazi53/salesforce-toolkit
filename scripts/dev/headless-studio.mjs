// Drive the UNPACKED extension in a headless Chrome over the DevTools
// protocol, with org sessions taken from the Salesforce CLI's own logins
// (`sf org open --url-only` = a frontdoor link; no password is ever handled).
//
//   node scripts/dev/headless-studio.mjs <script.mjs>
//
// Chrome 137+ (branded) ignores --load-extension; the supported route is
// --remote-debugging-pipe + --enable-unsafe-extension-debugging and the CDP
// command Extensions.loadUnpacked. This file speaks that pipe directly
// (fd 3 = to Chrome, fd 4 = from Chrome, messages NUL-terminated).
//
// The script default-exports async (h) => {...}:
//   h.login(alias)         open the CLI frontdoor link for that alias (sets the sid cookie)
//   h.studio(hash?)        open studio.html, accept the licence once, wait for boot
//   h.eval(expr)           Runtime.evaluate in the current tab (awaits promises)
//   h.waitFor(expr, ms)    poll an expression until truthy
//   h.click(selector)      click the first match
//   h.text(selector)       innerText of the first match ('' when absent)
//   h.shot(file)           PNG screenshot
//   h.log(...)             timestamped line
// Chrome profile lives under %LOCALAPPDATA%\Temp (never the user's profile).
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME  = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT     = resolve(process.env.SFTK_EXT || '.');
// A FRESH profile per run. A persisted profile keeps the previously registered
// MV3 service worker: the file on disk was new but the worker that ran was old
// (2026-09-22, the late-link pass "did not work" live until this changed).
// Screenshots go to a stable folder; SFTK_PROFILE pins a profile on purpose.
const SHOTS   = join(process.env.LOCALAPPDATA, 'Temp', 'sftk-headless-shots');
const PROFILE = process.env.SFTK_PROFILE || join(process.env.LOCALAPPDATA, 'Temp', `sftk-headless-${process.pid}`);
mkdirSync(PROFILE, { recursive: true }); mkdirSync(SHOTS, { recursive: true });
process.on('exit', () => { if (!process.env.SFTK_PROFILE && !process.env.SFTK_KEEP) { try { rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {} } });

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
log('profile:', PROFILE, process.env.SFTK_KEEP ? '(kept)' : '(deleted on exit)');

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  `--user-data-dir=${PROFILE}`, '--window-size=1500,1100', 'about:blank'
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
process.on('exit', () => { try { chrome.kill(); } catch (_) {} });

// ── the pipe ──
const toChrome = chrome.stdio[3], fromChrome = chrome.stdio[4];
let seq = 0; const pending = new Map(); const listeners = [];
let buf = '';
fromChrome.setEncoding('utf8');
fromChrome.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\0')) >= 0) {
    const raw = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(raw); } catch (_) { continue; }
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(`${m.error.message}${m.error.data ? ' — ' + m.error.data : ''}`)) : res(m.result); }
    else if (m.method) for (const l of listeners) l(m);
  }
});
function send(method, params = {}, sessionId) {
  const id = ++seq;
  toChrome.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}

const h = {
  log, extId: null, session: null, targetId: null,
  async start() {
    const v = await send('Browser.getVersion');
    log('browser:', v.product);
    const r = await send('Extensions.loadUnpacked', { path: EXT });
    this.extId = r.id;
    log('extension loaded:', this.extId, 'from', EXT);
    const t = await send('Target.createTarget', { url: 'about:blank' });
    this.targetId = t.targetId;
    const a = await send('Target.attachToTarget', { targetId: this.targetId, flatten: true });
    this.session = a.sessionId;
    await send('Page.enable', {}, this.session);
    await send('Runtime.enable', {}, this.session);
    // Native confirm()/alert() dialogs freeze Runtime.evaluate; answer them as
    // a user would (h.dialogAccept, default true) and log what they said.
    listeners.push(m => {
      if (m.method !== 'Page.javascriptDialogOpening') return;
      const msg = (m.params && m.params.message) || '';
      log(`DIALOG (${m.params && m.params.type}):`, msg.slice(0, 400).split(String.fromCharCode(10)).join(' | '), '→', this.dialogAccept ? 'OK' : 'Cancel');
      this.dialogs.push(msg);
      send('Page.handleJavaScriptDialog', { accept: !!this.dialogAccept }, m.sessionId).catch(() => {});
    });
  },
  dialogAccept: true, dialogs: [], exceptions: [],
  // page exceptions and console.error lines, logged as they happen
  async watchErrors() {
    listeners.push(m => {
      if (m.sessionId !== this.session) return;
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        const txt = (d.exception && (d.exception.description || d.exception.value)) || d.text || '';
        this.exceptions.push(txt); log('PAGE EXCEPTION:', String(txt).slice(0, 600).split(String.fromCharCode(10)).join(' | '));
      } else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
        const txt = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
        log(`CONSOLE ${m.params.type}:`, String(txt).slice(0, 400));
      }
    });
  },
  async navigate(url) {
    await send('Page.navigate', { url }, this.session);
    await this.waitFor("document.readyState === 'complete'", 30000);
  },
  async eval(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, this.session);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  },
  async waitFor(expr, ms = 15000, every = 250) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { const v = await this.eval(expr); if (v) return v; } catch (_) {}
      await new Promise(r => setTimeout(r, every));
    }
    throw new Error(`timeout waiting for: ${expr.slice(0, 120)}`);
  },
  async sleep(ms) { return new Promise(r => setTimeout(r, ms)); },
  async click(sel) {
    const ok = await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
    if (!ok) throw new Error(`no element for ${sel}`);
  },
  async text(sel) { return this.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`); },
  async shot(file) {
    const r = await send('Page.captureScreenshot', { format: 'png' }, this.session);
    writeFileSync(file, Buffer.from(r.data, 'base64')); log('screenshot', file);
  },
  // a fresh tab, attached; returns its sessionId (the caller switches this.session)
  async newTab(url = 'about:blank') {
    const t = await send('Target.createTarget', { url });
    const a = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    await send('Page.enable', {}, a.sessionId);
    await send('Runtime.enable', {}, a.sessionId);
    return a.sessionId;
  },
  // The extension discovers org sessions from OPEN Salesforce tabs
  // (chrome.tabs.query on the org globs), then reads their sid cookies — so
  // every org logs in inside its own tab and that tab stays open.
  orgTabs: {},
  async login(alias) {
    const out = execFileSync('sf', ['org', 'open', '-o', alias, '--url-only', '--json'], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const url = JSON.parse(out).result.url;
    const main = this.session;
    this.session = await this.newTab();
    await this.navigate(url);
    await this.sleep(2500);
    log('logged in via CLI frontdoor:', new URL(url).host, '→', await this.eval('location.host'), '(tab kept open)');
    this.orgTabs[alias] = this.session;
    this.session = main;
  },
  async studio(hash = '') {
    await this.navigate(`chrome-extension://${this.extId}/studio.html${hash}`);
    await this.sleep(1500);
    if (await this.eval(`/I confirm that any consequence/.test(document.body.innerText)`)) {
      await this.eval(`(() => { for (const cb of document.querySelectorAll('input[type=checkbox]')) if (!cb.checked) cb.click(); return true; })()`);
      await this.sleep(200);
      const clicked = await this.eval(`(() => { const b = [...document.querySelectorAll('button')].find(b => !b.disabled && /accept|agree|continue|start/i.test(b.textContent)); if (b) b.click(); return b ? b.textContent.trim() : null; })()`);
      log('licence gate: clicked', JSON.stringify(clicked));
      await this.sleep(1200);
    }
    await this.waitFor("!!document.querySelector('.ds-nav-btn')", 20000);
    // first-run tour on a fresh profile: skip it, as a user would
    await this.eval(`(() => { const b = [...document.querySelectorAll('button, a')].find(b => /skip tour/i.test(b.textContent)); if (b) b.click(); return !!b; })()`);
    // the tour can pop again on later views: dismiss it from inside the page whenever it appears
    await this.eval(`(() => { if (!window.__sftkTourKiller) window.__sftkTourKiller = setInterval(() => { const b = [...document.querySelectorAll('button, a')].find(b => /skip tour/i.test(b.textContent)); if (b) b.click(); }, 400); return true; })()`);
    log('studio open:', await this.eval('document.title'));
  },
  // open whatever modal a click produced, return its text (head) — closes it when `close` is true
  async modalText(n = 900) { return (await this.eval(`(() => { const b = document.querySelector('#dsModalBox'); if (!b || !b.offsetParent) return ''; return b.innerText || ''; })()`)).slice(0, n).replace(/\n+/g, ' | '); },
  async closeModal() { await this.eval(`(() => { if (typeof closeModal === 'function') closeModal(); return true; })()`); await this.sleep(300); },
  async clickText(re, within = 'body') {
    const ok = await this.eval(`(() => { const root = document.querySelector(${JSON.stringify(within)}) || document; const b = [...root.querySelectorAll('button')].find(b => ${re}.test(b.textContent) && !b.disabled); if (b) b.click(); return !!b; })()`);
    if (!ok) throw new Error(`no enabled button matching ${re} in ${within}`);
  },
  shots: SHOTS,
  // import deployments from a fixture file of sftk-profile payloads (array or one),
  // through the extension's own parser — replaces same-name deployments
  async importProfiles(file) {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const payloads = Array.isArray(raw) ? raw : [raw];
    const out = await this.eval(`(async () => {
      const out = [];
      for (const payload of ${JSON.stringify(payloads)}) {
        const r = bldProfileImportParse(JSON.stringify(payload), _profiles.map(p => p.id), 'fixture.json');
        if (r.error) { out.push('ERROR ' + r.error); continue; }
        const dup = _profiles.find(p => p.name === r.profile.name);
        if (dup) _profiles.splice(_profiles.indexOf(dup), 1);
        _profiles.push(r.profile); out.push(r.profile.name);
      }
      await storageSaveProfiles();
      return out;
    })()`);
    log('imported:', out.join(' · '));
    return out;
  },
  async close() { try { await send('Browser.close'); } catch (_) {} try { chrome.kill(); } catch (_) {} },
};

const scriptPath = process.argv[2];
if (!scriptPath) { console.error('usage: node scripts/dev/headless-studio.mjs <script.mjs>'); process.exit(2); }
const mod = await import(pathToFileURL(resolve(scriptPath)).href);
let code = 0;
try { await h.start(); await mod.default(h); }
catch (e) { code = 1; console.error('FAILED:', e?.stack || e); try { await h.shot(join(SHOTS, 'failure.png')); } catch (_) {} }
finally { await h.close(); }
process.exit(code);
