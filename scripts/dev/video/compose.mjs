// Turn a recording folder (recorder.mjs: frames/*.jpg + manifest.json) into an
// MP4 with the captions burned in, plus an .srt and a chapters list.
//
//   REC_DIR=<folder> OUT=<file.mp4> node scripts/dev/headless-studio.mjs scripts/dev/video/compose.mjs
//
// The encoder is Chrome's own (canvas → MediaRecorder, H.264 in MP4): nothing
// is downloaded or installed. It encodes in real time, so composing takes as
// long as the finished video runs.
//
// Layout, 1920×1080: the page on top (1920×960 — the recorder's 1600×800
// viewport at 1.2×), a 120-px band below it with the chapter on the left and
// the caption in the middle. Stretches the script marked as waiting
// (rec.fast) play FAST× faster, with a "sped up" badge so the viewer knows.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const FAST = Number(process.env.FAST || 8);
const W = 1920, H = 1080, PAGE_H = 960;
const MIN_GAP = 40;            // ms between frames sent to the encoder (25 fps ceiling)

export default async function (h) {
  const dir = resolve(process.env.REC_DIR || 'dist/video/rec');
  const out = resolve(process.env.OUT || 'dist/video/walkthrough.mp4');
  const man = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  mkdirSync(dirname(out), { recursive: true });
  const fast = (man.fast || []).slice().sort((a, b) => a.a - b.a);
  const mapT = t => { let o = t; for (const s of fast) { if (t >= s.b) o -= (s.b - s.a) * (1 - 1 / FAST); else if (t > s.a) o -= (t - s.a) * (1 - 1 / FAST); } return Math.max(0, o); };
  const inFast = t => fast.some(s => t > s.a && t < s.b);

  // ── one timeline of everything that changes the picture ──
  const ev = [];
  const fr = man.frames || [];
  let last = -1e9;
  for (let i = 0; i < fr.length; i++) {
    const tau = mapT(fr[i].t), next = i + 1 < fr.length ? mapT(fr[i + 1].t) : Infinity;
    if (tau - last >= MIN_GAP || next - tau >= 120) { ev.push({ tau, kind: 'frame', f: fr[i].f, fast: inFast(fr[i].t) }); last = tau; }
  }
  for (const c of (man.cues || [])) ev.push({ tau: mapT(c.t), kind: 'cue', text: c.text });
  for (const c of (man.chapters || [])) ev.push({ tau: mapT(c.t), kind: 'chapter', title: c.title });
  ev.sort((a, b) => a.tau - b.tau || (a.kind === 'frame' ? 1 : -1));
  const total = mapT(man.length || (fr.length ? fr[fr.length - 1].t : 0)) + 1500;
  h.log(`composing ${ev.filter(e => e.kind === 'frame').length} of ${fr.length} frames · source ${(man.length / 1000).toFixed(0)} s → video ${(total / 1000).toFixed(0)} s (waiting ×${FAST})`);

  // ── the .srt and the chapters (YouTube reads both) ──
  const stamp = ms => { const p = (n, w = 2) => String(Math.floor(n)).padStart(w, '0'); return `${p(ms / 3600000)}:${p(ms / 60000 % 60)}:${p(ms / 1000 % 60)},${p(ms % 1000, 3)}`; };
  const cues = (man.cues || []).map(c => ({ tau: mapT(c.t), text: c.text }));
  let srt = '', k = 0;
  for (let i = 0; i < cues.length; i++) {
    if (!cues[i].text) continue;
    const end = Math.min(i + 1 < cues.length ? cues[i + 1].tau : total, cues[i].tau + 12000);
    if (end - cues[i].tau < 300) continue;
    srt += `${++k}\n${stamp(cues[i].tau)} --> ${stamp(end - 50)}\n${cues[i].text}\n\n`;
  }
  writeFileSync(out.replace(/\.mp4$/i, '') + '.srt', srt);
  const mmss = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000 % 60)).padStart(2, '0')}`;
  const ch = (man.chapters || []).map(c => ({ tau: mapT(c.t), title: c.title }));
  writeFileSync(out.replace(/\.mp4$/i, '') + '.chapters.txt', ch.map((c, i) => `${mmss(i === 0 ? 0 : c.tau)} ${c.title}`).join('\n') + '\n');

  // ── the encoder page ──
  await h.navigate('about:blank');
  const type = await h.eval(`(async () => {
    const c = document.createElement('canvas'); c.width = ${W}; c.height = ${H}; document.body.style.margin = '0'; document.body.appendChild(c);
    const g = c.getContext('2d');
    const type = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.640028') ? 'video/mp4;codecs=avc1.640028' : MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm;codecs=vp9';
    const stream = c.captureStream(0); const track = stream.getVideoTracks()[0];
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: ${Number(process.env.BITRATE || 8000000)} });
    const chunks = []; rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const V = window.__v = { c, g, track, rec, chunks, type, img: null, caption: '', chapter: '', fast: false, blob: null };
    const wrap = (text, max) => { const words = String(text).split(' '); const lines = []; let cur = '';
      for (const w of words) { const t = cur ? cur + ' ' + w : w; if (g.measureText(t).width > max && cur) { lines.push(cur); cur = w; } else cur = t; }
      if (cur) lines.push(cur); return lines; };
    V.paint = () => {
      g.fillStyle = '#0f1722'; g.fillRect(0, 0, ${W}, ${PAGE_H});
      if (V.img) g.drawImage(V.img, 0, 0, ${W}, ${PAGE_H});
      if (V.fast) { g.font = '600 26px "Segoe UI", sans-serif'; const t = '⏩ waiting — sped up'; const w = g.measureText(t).width + 36;
        g.fillStyle = 'rgba(11,31,58,.88)'; g.beginPath(); g.roundRect(${W} - w - 24, 20, w, 48, 24); g.fill(); g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillText(t, ${W} - w - 6, 45); }
      g.fillStyle = '#0b1f3a'; g.fillRect(0, ${PAGE_H}, ${W}, ${H - PAGE_H});
      g.fillStyle = '#1b6fd1'; g.fillRect(0, ${PAGE_H}, ${W}, 3);
      let left = 40;
      if (V.chapter) { g.font = '700 24px "Segoe UI", sans-serif'; const w = g.measureText(V.chapter).width + 36;
        g.fillStyle = '#1b6fd1'; g.beginPath(); g.roundRect(32, ${PAGE_H} + 38, w, 46, 10); g.fill();
        g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillText(V.chapter, 50, ${PAGE_H} + 62); left = 32 + w + 28; }
      if (V.caption) { g.font = '500 31px "Segoe UI", sans-serif'; g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.textAlign = 'left';
        let lines = wrap(V.caption, ${W} - left - 40);
        if (lines.length > 2) { g.font = '500 26px "Segoe UI", sans-serif'; lines = wrap(V.caption, ${W} - left - 40).slice(0, 3); }
        const lh = lines.length > 2 ? 32 : 40; const y0 = ${PAGE_H} + 62 - (lines.length - 1) * lh / 2;
        lines.forEach((ln, i) => g.fillText(ln, left, y0 + i * lh)); }
      track.requestFrame();
    };
    V.frame = async b64 => { const im = new Image(); im.src = 'data:image/jpeg;base64,' + b64; try { await im.decode(); V.img = im; } catch (_) {} V.paint(); };
    V.paint();
    rec.start(1000);
    V.keep = setInterval(V.paint, 200);   // a held picture still needs frames, or players stall on it
    return type; })()`);
  h.log('encoder:', type);

  // ── play the timeline in real time ──
  const t0 = Date.now();
  let shown = 0, lastLog = 0;
  for (const e of ev) {
    const wait = e.tau - (Date.now() - t0);
    if (wait > 2) await h.sleep(wait);
    if (e.kind === 'frame') {
      const b64 = readFileSync(join(dir, 'frames', e.f)).toString('base64');
      await h.eval(`(async () => { __v.fast = ${e.fast ? 'true' : 'false'}; await __v.frame(${JSON.stringify(b64)}); return 1; })()`);
      shown++;
    } else if (e.kind === 'cue') await h.eval(`(() => { __v.caption = ${JSON.stringify(e.text)}; __v.paint(); return 1; })()`);
    else await h.eval(`(() => { __v.chapter = ${JSON.stringify(e.title)}; __v.paint(); return 1; })()`);
    if (Date.now() - lastLog > 30000) { lastLog = Date.now(); h.log(`… ${((Date.now() - t0) / 1000).toFixed(0)} / ${(total / 1000).toFixed(0)} s, ${shown} frames, lag ${Math.max(0, Date.now() - t0 - e.tau).toFixed(0)} ms`); }
  }
  const tail = total - (Date.now() - t0);
  if (tail > 0) await h.sleep(tail);

  // ── stop, and bring the file out of the page in slices ──
  const size = await h.eval(`(async () => { const V = __v; clearInterval(V.keep); const done = new Promise(r => { V.rec.onstop = r; }); V.rec.stop(); await done; V.blob = new Blob(V.chunks, { type: V.type }); return V.blob.size; })()`);
  const file = /mp4/.test(type) ? out : out.replace(/\.mp4$/i, '.webm');
  writeFileSync(file, Buffer.alloc(0));
  const SLICE = 3 * 1024 * 1024;
  for (let off = 0; off < size; off += SLICE) {
    const b64 = await h.eval(`(async () => { const buf = new Uint8Array(await __v.blob.slice(${off}, ${off + SLICE}).arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); return btoa(s); })()`);
    appendFileSync(file, Buffer.from(b64, 'base64'));
  }
  const onDisk = existsSync(file) ? statSync(file).size : 0;
  h.log(`video: ${file} — ${(onDisk / 1048576).toFixed(1)} MB (${onDisk === size ? 'complete' : `INCOMPLETE: page had ${size} bytes`}), ${(total / 1000).toFixed(0)} s, ${shown} frames`);
  h.log('captions:', out.replace(/\.mp4$/i, '') + '.srt', '· chapters:', out.replace(/\.mp4$/i, '') + '.chapters.txt');
  if (onDisk !== size) throw new Error('the video file is incomplete');
}
