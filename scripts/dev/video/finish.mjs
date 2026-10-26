// From the composer's VP9 recording (compose.mjs → walkthrough.webm) to the files
// that are shared: the 1080p H.264 MP4 for YouTube, a 720p copy, and the parts
// that fit a chat upload — all with ffmpeg (on this PC since 2026-10-27; the
// Chrome encoder that wrote the MP4 before painted every page of text soft).
//
//   node scripts/dev/video/finish.mjs                 # dist/video/walkthrough.webm → dist/video/share/*
//   IN=<file.webm> SHARE=<dir> CAP_MB=29.5 node scripts/dev/video/finish.mjs
//   STEPS=full,720p,parts                             # a subset
//
// The parts are cut at section boundaries (order.json beside the recording and
// the <name>.chapters.txt the composer wrote: one chapter per section), each
// starting at 00:00 with its own chapters file, 720p, two-pass to the size cap.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';

const IN = resolve(process.env.IN || 'dist/video/walkthrough.webm');
const REC = resolve(process.env.REC_DIR || 'dist/video/rec');
const SHARE = resolve(process.env.SHARE || 'dist/video/share');
const CAP_MB = Number(process.env.CAP_MB || 29.5);
const STEPS = String(process.env.STEPS || 'full,720p,parts').split(',').map(s => s.trim());
const STEM = IN.replace(/\.(webm|mp4)$/i, '');
const PARTS = {
  part1a: ['home', 'flows', 'dependencies', 'flow-switches', 'api-versions'],
  part1b: ['debugger'],
  part1c: ['pages'],
  part1d: ['fields'],
  part1e: ['copy-perms', 'flow-access'],
  part2a: ['orgs', 'builder', 'deploy'],
  part2b: ['run', 'identity', 'rollback', 'ring', 'history', 'compare', 'orghealth', 'outro'],
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const mb = f => (statSync(f).size / 1048576).toFixed(1) + ' MB';
function ff(args, what) {
  log('ffmpeg', what);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${what}`);
}
const probe = f => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout.trim());
const mmss = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

if (!existsSync(IN)) throw new Error(`no recording at ${IN} — compose first`);
mkdirSync(SHARE, { recursive: true });
const full = STEM + '.mp4';
const AUDIO = ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2'];

// ── 1. the 1080p MP4: constant quality, a keyframe every 4 s, playable while it downloads ──
if (STEPS.includes('full')) {
  ff(['-i', IN, '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-g', '120', '-keyint_min', '30', ...AUDIO, '-movflags', '+faststart', full], '1080p MP4');
  copyFileSync(full, join(SHARE, basename(full)));
  if (existsSync(STEM + '.chapters.txt')) copyFileSync(STEM + '.chapters.txt', join(SHARE, basename(STEM) + '.chapters.txt'));
  log('1080p:', full, mb(full));
}
const src = existsSync(full) ? full : IN;

// ── 2. the 720p copy ──
if (STEPS.includes('720p')) {
  const out = join(SHARE, basename(STEM) + '-720p.mp4');
  ff(['-i', src, '-vf', 'scale=1280:-2:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p', '-g', '120', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out], '720p copy');
  log('720p:', out, mb(out));
}

// ── 3. the parts: section boundaries → time ranges → 720p two-pass under the cap ──
if (STEPS.includes('parts')) {
  const order = JSON.parse(readFileSync(join(REC, 'order.json'), 'utf8'));
  const chapters = readFileSync(STEM + '.chapters.txt', 'utf8').trim().split('\n').map(l => {
    const m = /^(\d+):(\d\d) (.*)$/.exec(l); return { t: Number(m[1]) * 60 + Number(m[2]), title: m[3] };
  });
  if (chapters.length !== order.length) throw new Error(`${chapters.length} chapters for ${order.length} sections — the parts need one chapter per section`);
  const total = probe(src);
  for (const [name, ids] of Object.entries(PARTS)) {
    const idx = ids.map(id => order.indexOf(id)).filter(i => i >= 0);
    if (!idx.length) { log(name, '— none of its sections were recorded, left out'); continue; }
    const a = Math.min(...idx), b = Math.max(...idx);
    const t0 = chapters[a].t, t1 = b + 1 < chapters.length ? chapters[b + 1].t : total;
    const dur = t1 - t0;
    const audioK = 64;
    const videoK = Math.max(150, Math.min(2500, Math.floor(CAP_MB * 8192 / dur) - audioK - 12));   // kbit/s, with a little headroom for the container
    const out = join(SHARE, `${basename(STEM)}-${name}.mp4`);
    const common = ['-ss', String(t0), '-to', String(t1), '-i', src, '-vf', 'scale=1280:-2:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-b:v', `${videoK}k`, '-maxrate', `${Math.floor(videoK * 1.5)}k`, '-bufsize', `${videoK * 3}k`, '-pix_fmt', 'yuv420p', '-g', '120'];
    const passlog = join(SHARE, `.${name}-2pass`);
    ff([...common, '-pass', '1', '-passlogfile', passlog, '-an', '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null'], `${name} pass 1 (${mmss(t0)}–${mmss(t1)}, ${videoK} kbit/s)`);
    ff([...common, '-pass', '2', '-passlogfile', passlog, '-c:a', 'aac', '-b:a', `${audioK}k`, '-ac', '2', '-movflags', '+faststart', out], `${name} pass 2`);
    for (const f of [`${passlog}-0.log`, `${passlog}-0.log.mbtree`]) rmSync(f, { force: true });   // the first pass's notes, not a share file
    writeFileSync(out.replace(/\.mp4$/, '.chapters.txt'), chapters.slice(a, b + 1).map((c, i) => `${mmss(i === 0 ? 0 : c.t - t0)} ${c.title}`).join('\n') + '\n');
    log(name + ':', out, mb(out), `(${ids.filter(id => order.includes(id)).join(', ')})`);
  }
}
log('done');
