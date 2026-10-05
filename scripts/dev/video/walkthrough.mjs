// The walkthrough: every tool of the public build, live, with captions.
//
//   # 1. record (public build, both trial orgs logged in through the CLI)
//   SFTK_EXT=dist/store-staging SFTK_WINDOW=1600,800 REC_DIR=dist/video/rec \
//     node scripts/dev/headless-studio.mjs scripts/dev/video/walkthrough.mjs
//   # 2. compose (real time: takes as long as the video runs)
//   REC_DIR=dist/video/rec OUT=dist/video/walkthrough.mp4 \
//     node scripts/dev/headless-studio.mjs scripts/dev/video/compose.mjs
//
// ONLY=flows,deploy records just those sections (their ids are in SECTIONS).
// WRITES=0 leaves out the one section that changes an org (a two-record
// deployment into trailheads4 and its rollback) — everything else only reads.
//
// Every section is on its own: one that fails is logged and the tour goes on,
// and the end of the log lists what was recorded and what was not.
// The orgs: npc = trailheads5 (the source, where the Toolkit's fixtures live),
// npc2 = trailheads4 (the target).
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { makeRecorder } from './recorder.mjs';

const J = JSON.stringify;
const NL = String.fromCharCode(10);
const SRC = 'npc', TGT = 'npc2';

// The running user's own name never reaches a frame (e-mail addresses are
// masked by the recorder anyway). Read from the CLI; never logged.
function ownNames() {
  const out = [];
  for (const alias of [SRC, TGT]) {
    try {
      const u = JSON.parse(execFileSync('sf', ['org', 'display', 'user', '-o', alias, '--json'], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })).result;
      const q = JSON.parse(execFileSync('sf', ['data', 'query', '-o', alias, '--json', '-q', `"SELECT Name, FirstName, LastName FROM User WHERE Id = '${u.id}'"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })).result.records[0] || {};
      if (q.Name) out.push([q.Name, 'Demo Admin']);
      if (q.LastName && q.FirstName) out.push([`${q.LastName}, ${q.FirstName}`, 'Admin, Demo']);
      if (u.username) out.push([u.username, 'admin@example.com']);
    } catch (_) { /* the mask still covers every e-mail address */ }
  }
  return out;
}

export default async function (h) {
  const only = String(process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
  const rec = makeRecorder(h, resolve(process.env.REC_DIR || 'dist/video/rec'), { names: ownNames() });
  const text = async (sel, n = 400) => (await h.eval(`(document.querySelector(${J(sel)})?.innerText || '')`)).slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
  const has = sel => h.eval(`!!document.querySelector(${J(sel)})`);
  const popup = async tab => { await h.popup(tab); await rec.resume(); };
  const studio = async hash => { await h.studio(hash); await rec.resume(); };
  // the Toolkit's home page: the popup opened without a tool
  const home = async () => {
    await h.navigate(`chrome-extension://${h.extId}/popup.html`);
    await h.sleep(1200);
    await h.eval(`(() => { if (!window.__sftkTourKiller) window.__sftkTourKiller = setInterval(() => { const b = [...document.querySelectorAll('button, a')].find(b => /skip tour/i.test(b.textContent)); if (b) b.click(); }, 400); return true; })()`);
    await rec.resume();
    await h.waitFor("document.querySelectorAll('.home-card').length > 0 && !document.querySelector('.home-loading')", 60000, 500);
    await h.sleep(800);
  };
  const ctx = { h, rec, text, has, popup, studio, home };

  const { SECTIONS } = await import('./sections.mjs');
  const done = [], failed = [];
  // The Toolkit works on the org of the most recently used Salesforce tab, so
  // only the source is logged in while its tools are shown; the target joins
  // before the first Data Studio section.
  await h.login(SRC);
  let targetIn = false;
  await h.watchErrors();
  // the first page, before the recording starts: the licence is accepted here, off camera
  await h.popup('flows');
  await rec.start();
  for (const s of SECTIONS) {
    if (only.length && !only.includes(s.id)) continue;
    if (s.writes && process.env.WRITES === '0') { h.log('skipped (WRITES=0):', s.id); continue; }
    if (s.needsTarget && !targetIn) { await rec.fast(async () => { await h.login(TGT); }); targetIn = true; }
    h.log('──── section', s.id);
    try { rec.chapter(s.title); await s.run(ctx); done.push(s.id); }
    catch (e) { failed.push(`${s.id}: ${String((e && e.message) || e).split(NL)[0].slice(0, 200)}`); h.log('SECTION FAILED', s.id, (e && e.stack) || e); try { await h.shot(`${h.shots}/walk-fail-${s.id}.png`); } catch (_) {} rec.hush(); }
  }
  await rec.pause(1500);
  await rec.stop();
  h.log('RECORDED:', done.join(', ') || '(nothing)');
  h.log('FAILED:', failed.length ? failed.join(' ‖ ') : '(none)');
  h.log('page exceptions during the tour:', h.exceptions.length);
}
