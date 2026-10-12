// The walkthrough: every tool of the public build, live, with captions.
//
//   # 1. record (public build, both trial orgs logged in through the CLI)
//   SFTK_EXT=dist/store-staging SFTK_WINDOW=1600,800 REC_DIR=dist/video/rec \
//     node scripts/dev/headless-studio.mjs scripts/dev/video/walkthrough.mjs
//   # 2. compose (real time: takes as long as the video runs)
//   REC_DIR=dist/video/rec OUT=dist/video/walkthrough.mp4 \
//     node scripts/dev/headless-studio.mjs scripts/dev/video/compose.mjs
//
// Each section is recorded into its own folder (REC_DIR/<id>/), so
// ONLY=flows,deploy records just those again and the composer joins them with
// the ones already there (their ids are in SECTIONS).
// WRITES=0 leaves out the sections that use a tool for real (Flow switches,
// API versions, Field Cleaner, Deploy and roll back — each on fixtures, each
// undone or restored); everything else only reads.
//
// Every section is on its own: one that fails is logged and the tour goes on,
// and the end of the log lists what was recorded and what was not.
// The orgs: npc = trailheads5 (the source, where the Toolkit's fixtures live),
// npc2 = trailheads4 (the target).
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { writeFileSync, rmSync, renameSync, existsSync, cpSync } from 'node:fs';
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
  // The video shows the PUBLIC build (dist/store-staging: no Pro, no Debug, no Labs tools). A chapter
  // recorded from the source folder once slipped through (2026-10-12) — refused here, not found later.
  if (!/store-staging/i.test(String(process.env.SFTK_EXT || "")) && process.env.SFTK_DEV !== "1") {
    throw new Error("the walkthrough records the public build: run with SFTK_EXT=dist/store-staging (npm run pack first), or SFTK_DEV=1 to record the source folder on purpose");
  }
  const only = String(process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
  const base = resolve(process.env.REC_DIR || 'dist/video/rec');
  const rec = makeRecorder(h, base, { names: ownNames() });
  const text = async (sel, n = 400) => (await h.eval(`(document.querySelector(${J(sel)})?.innerText || '')`)).slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
  const has = sel => h.eval(`!!document.querySelector(${J(sel)})`);
  // A Toolkit tool works on ONE org. Several sections now change things, so a
  // tool that opened on the wrong org stops the section instead of acting there.
  const popup = async tab => {
    await h.popup(tab); await rec.resume();
    const on = await h.eval(`document.querySelector('#topbarOrgLabel')?.textContent || ''`);
    if (on !== 'trailheads5') throw new Error(`the Toolkit opened on "${on}", not on trailheads5`);
  };
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
  // Both orgs are open from the start (the home chapter shows switching between
  // them). The Toolkit opens on the org of the most recently used Salesforce
  // tab, so the source is logged in last.
  await h.login(TGT);
  await h.login(SRC);
  await h.watchErrors();
  // The licence gate: the home chapter shows the first activation on camera (user 2026-10-10:
  // "show how first activation looks"), so it is accepted off camera only when home is not recorded.
  if (only.length && !only.includes('home')) await h.popup('flows');
  for (const s of SECTIONS) {
    if (only.length && !only.includes(s.id)) continue;
    if (s.writes && process.env.WRITES === '0') { h.log('skipped (WRITES=0):', s.id); continue; }
    h.log('──── section', s.id);
    // into <id>.new first: a section that fails keeps the recording it had
    const dir = join(base, s.id), tmp = join(base, s.id + '.new');
    await rec.begin(tmp);
    rec.chapter(s.title);
    let err = null;
    try { await s.run(ctx); await rec.pause(900); } catch (e) { err = e; }
    await rec.end({ id: s.id, title: s.title });
    // off camera: put back what the section used (a fixture it changed for real)
    if (s.cleanup) { try { await s.cleanup(ctx); } catch (e) { h.log('CLEANUP FAILED', s.id, (e && e.message) || e); } }
    if (!err) {
      // Windows (and a synced folder) can hold a just-written folder for a moment: try again, then copy
      try {
        let moved = false;
        for (let i = 0; i < 8 && !moved; i++) {
          try { rmSync(dir, { recursive: true, force: true }); renameSync(tmp, dir); moved = true; } catch (_) { await h.sleep(1500); }
        }
        if (!moved) { rmSync(dir, { recursive: true, force: true }); cpSync(tmp, dir, { recursive: true }); try { rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
        done.push(s.id);
      } catch (e) { failed.push(`${s.id}: recorded, but its folder could not be put in place (${(e && e.message) || e}) — it is in ${tmp}`); }
    } else {
      failed.push(`${s.id}: ${String((err && err.message) || err).split(NL)[0].slice(0, 200)}${existsSync(dir) ? ' (its earlier recording is kept)' : ''}`);
      h.log('SECTION FAILED', s.id, (err && err.stack) || err);
      try { await h.shot(`${h.shots}/walk-fail-${s.id}.png`); } catch (_) {}
      try { rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
  }
  // the order the composer joins the sections in
  writeFileSync(join(base, 'order.json'), JSON.stringify(SECTIONS.map(s => s.id)));
  h.log('RECORDED:', done.join(', ') || '(nothing)');
  h.log('FAILED:', failed.length ? failed.join(' ‖ ') : '(none)');
  h.log('page exceptions during the tour:', h.exceptions.length);
}
