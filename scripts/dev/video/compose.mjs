// Turn a recording folder (recorder.mjs: frames/*.jpg + manifest.json) into an
// MP4 with the captions burned in, plus a chapters list.
//
// The captions are IN the picture. So no subtitle file is written next to the
// video: a player loads a same-named .srt by itself and draws it over the
// burned-in text, and YouTube's CC would do the same (user 2026-10-05: "in the
// video, text is overlapping with another text"). CAPTIONS=track makes the
// other kind instead: a video with NO caption text in the picture
// (<name>-nocaptions.mp4) and the captions as <name>-nocaptions.srt beside it.
//
//   REC_DIR=<folder> OUT=<file.mp4> node scripts/dev/headless-studio.mjs scripts/dev/video/compose.mjs
//
// The encoder is Chrome's own (canvas → MediaRecorder, H.264 in MP4): nothing
// is downloaded or installed. It encodes in real time, so composing takes as
// long as the finished video runs.
//
// Layout, 1920×1080: a browser frame on top (88 px: a tab strip and an address
// bar drawn like Chrome's, showing the page's real title and address — user
// 2026-10-09: "make the demonstration look like it was recorded on a chrome
// browser"), the page under it (1920×872 — the recorder's 1600×727 viewport at
// 1.2×), and a 120-px band below with the chapter on the left and the caption
// in the middle. Stretches the script marked as waiting (rec.fast) play FAST×
// faster, with a "sped up" badge so the viewer knows.
//
// Narration (on by default; VOICE=0 makes a silent video): every caption is
// spoken by a voice that is already on this PC (voice.mjs) and recorded into
// the same file as an audio track. A caption stays, and the picture holds,
// until its sentence has been spoken — so the video runs a little longer than
// the silent one, and voice, caption and screen never drift apart.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { speakAll, voiceFile, voiceSeconds, VOICE as VOICE_NAME, RATE as VOICE_RATE, ENGINE as VOICE_ENGINE } from './voice.mjs';

const FAST = Number(process.env.FAST || 8);
const W = 1920, H = 1080, FRAME_H = 88, PAGE_H = 872, BAND_Y = FRAME_H + PAGE_H;
const MIN_GAP = 66;            // ms between frames sent to the encoder (15 fps ceiling)
// In a sped-up stretch the recording's frames arrive FAST× closer together: 236 pictures
// of a scrolling page in one second of video left the encoder drawing the previous page
// under the next one (user 2026-10-12: "a lot of weird parts like this one"). Inside a
// waiting stretch at most ~3 pictures a second go to the encoder, the last one always.
const FAST_GAP = 350;
const KEYFRAME_MS = Number(process.env.KEYFRAME || 4000);   // a keyframe every 4 s: nothing left over from an earlier picture lives longer (2 s doubled the file)
// SCALE=0.6667 composes a 1280×720 picture (the same layout, drawn smaller) — with
// AUDIO_BITRATE=64000 and BITRATE=1200000 a copy under 30 MB for a phone or a chat
const SCALE = Number(process.env.SCALE || 1);

export default async function (h) {
  const dir = resolve(process.env.REC_DIR || 'dist/video/rec');
  const TRACK = process.env.CAPTIONS === 'track';   // captions as a subtitle file, not in the picture
  const SPEAK = process.env.VOICE !== '0';          // the narration
  const out = resolve(process.env.OUT || 'dist/video/walkthrough.mp4').replace(/\.mp4$/i, TRACK ? '-nocaptions.mp4' : '.mp4');
  // One recording (manifest.json), or the walkthrough's sections (order.json +
  // <id>/manifest.json): joined in order, each shifted to start where the one
  // before it ended. A section with no recording is left out, and said.
  let man;
  if (existsSync(join(dir, 'order.json'))) {
    man = { length: 0, frames: [], cues: [], chapters: [], fast: [], pages: [], pointer: [] };
    const missing = [];
    // ONLY=a,b composes just those sections (a quick check of a chapter)
    const only = String(process.env.ONLY || '').split(',').map(x => x.trim()).filter(Boolean);
    for (const id of JSON.parse(readFileSync(join(dir, 'order.json'), 'utf8')).filter(id => !only.length || only.includes(id))) {
      const f = join(dir, id, 'manifest.json');
      if (!existsSync(f)) { missing.push(id); continue; }
      const m = JSON.parse(readFileSync(f, 'utf8')), off = man.length;
      man.cues.push({ t: off, text: '' });   // a caption never runs on into the next section
      for (const x of (m.frames || [])) man.frames.push({ f: join(id, 'frames', x.f), t: off + x.t, abs: true });
      for (const x of (m.cues || [])) man.cues.push({ t: off + x.t, text: x.text });
      for (const x of (m.chapters || [])) man.chapters.push({ t: off + x.t, title: x.title });
      for (const x of (m.fast || [])) man.fast.push({ a: off + x.a, b: off + x.b, ...(x.v ? { v: x.v } : {}) });   // a stretch keeps the seconds it asked for
      for (const x of (m.pages || [])) man.pages.push({ t: off + x.t, url: x.url, title: x.title });
      for (const x of (m.pointer || [])) man.pointer.push({ t: off + x.t, x: x.x, y: x.y, vw: x.vw, click: x.click });
      man.length = off + (m.length || 0) + 250;
    }
    if (missing.length) h.log('NOT in this video (no recording):', missing.join(', '));
  } else man = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  mkdirSync(dirname(out), { recursive: true });
  // each waiting stretch plays FAST× faster, and a very long one faster still: no stretch takes more
  // than 5 s of video (a 96-s wait for Salesforce took 12 s of badge, 2026-10-15)
  const fast = (man.fast || []).slice().sort((a, b) => a.a - b.a).map(s => ({ ...s, k: s.v ? Math.max(1, (s.b - s.a) / (s.v * 1000)) : Math.max(FAST, (s.b - s.a) / 5000) }));   // a stretch that asked for N s of video gets them, even slower than FAST×
  const mapT = t => { let o = t; for (const s of fast) { if (t >= s.b) o -= (s.b - s.a) * (1 - 1 / s.k); else if (t > s.a) o -= (t - s.a) * (1 - 1 / s.k); } return Math.max(0, o); };
  const inFast = t => fast.some(s => t > s.a && t < s.b);

  // ── narration: where each sentence starts, and how far it pushes what follows ──
  // A caption that would arrive while the one before it is still being spoken
  // waits for it; everything after that moment moves by the same amount, so
  // the picture simply holds for those seconds.
  const said = (man.cues || []).map(c => ({ t: c.t, tau0: mapT(c.t), text: c.text })).sort((a, b) => a.tau0 - b.tau0);
  const breaks = [];
  let spoken = 0;
  if (SPEAK) {
    const v = await speakAll(dir);
    h.log(`voice: ${VOICE_ENGINE} ${VOICE_NAME}, rate ${VOICE_RATE} — ${v.captions} captions, ${v.made} newly spoken, ${v.seconds.toFixed(0)} s of speech`);
    let shift = 0, busyUntil = 0;
    for (const c of said) {
      let start = c.tau0 + shift;
      if (start < busyUntil) { shift += busyUntil - start; start = busyUntil; }
      breaks.push({ at: c.tau0, shift });
      const f = voiceFile(dir, c.text);
      if (f && existsSync(f)) { c.voice = f; c.dur = voiceSeconds(f) * 1000; busyUntil = start + c.dur + 350; spoken++; }
    }
    said.busyUntil = busyUntil;
  }
  const shiftAt = tau0 => { let s = 0; for (const b of breaks) { if (b.at <= tau0) s = b.shift; else break; } return s; };
  const T = t => { const x = mapT(t); return x + shiftAt(x); };   // recording time → video time

  // ── one timeline of everything that changes the picture ──
  const ev = [];
  const fr = man.frames || [];
  let last = -1e9;
  for (let i = 0; i < fr.length; i++) {
    const tau = T(fr[i].t), next = i + 1 < fr.length ? T(fr[i + 1].t) : Infinity;
    const fastHere = inFast(fr[i].t), gap = fastHere ? FAST_GAP : MIN_GAP;
    if (tau - last >= gap || next - tau >= gap) { ev.push({ tau, kind: 'frame', f: fr[i].abs ? join(dir, fr[i].f) : join(dir, 'frames', fr[i].f), fast: fastHere }); last = tau; }
  }
  for (const c of said) ev.push({ tau: T(c.t), kind: 'cue', text: c.text, voice: c.voice || null, dur: c.dur || 0 });
  for (const c of (man.chapters || [])) ev.push({ tau: T(c.t), kind: 'chapter', title: c.title });
  for (const p of (man.pages || [])) ev.push({ tau: T(p.t), kind: 'page', url: p.url || '', title: p.title || '' });
  // the pointer: where it went, and when it pressed (drawn by the encoder page, moving between places)
  for (const q of (man.pointer || [])) ev.push({ tau: T(q.t), kind: 'ptr', x: q.x, y: q.y, vw: q.vw || 1600, click: !!q.click });
  // the "sped up" badge goes when the waiting ends, even if the picture does not change then
  for (const f of fast) { ev.push({ tau: T(f.a), kind: 'faston' }); ev.push({ tau: T(f.b) + 5, kind: 'fastoff' }); }
  ev.sort((a, b) => a.tau - b.tau || (a.kind === 'frame' ? 1 : -1));
  const total = Math.max(T(man.length || (fr.length ? fr[fr.length - 1].t : 0)), said.busyUntil || 0) + 1500;
  for (const f of fast) h.log(`  waiting stretch ${(f.a / 1000).toFixed(0)}–${(f.b / 1000).toFixed(0)} s of the recording → video ${(T(f.a) / 1000).toFixed(1)}–${(T(f.b) / 1000).toFixed(1)} s`);
  h.log(`composing ${ev.filter(e => e.kind === 'frame').length} of ${fr.length} frames · source ${(man.length / 1000).toFixed(0)} s → video ${(total / 1000).toFixed(0)} s (waiting ×${FAST}${SPEAK ? `, ${spoken} captions spoken` : ', silent'})`);

  // TRACE_TEXT=<words of a caption>: print every event from 3 s before that caption to 12 s after it, then stop (no video)
  if (process.env.TRACE_TEXT) {
    const c = ev.find(e => e.kind === 'cue' && String(e.text || '').includes(process.env.TRACE_TEXT));
    if (!c) { h.log('TRACE: no such caption'); return; }
    for (const e of ev) if (e.tau >= c.tau - 3000 && e.tau <= c.tau + 12000) h.log('TRACE', (e.tau / 1000).toFixed(2), e.kind, e.kind === 'frame' ? (e.fast ? 'FAST' : 'plain') + ' ' + basename(e.f) : e.kind === 'cue' ? String(e.text).slice(0, 40) : '');
    return;
  }

  // ── the chapters, and (CAPTIONS=track only) the subtitle file ──
  const stamp = ms => { const p = (n, w = 2) => String(Math.floor(n)).padStart(w, '0'); return `${p(ms / 3600000)}:${p(ms / 60000 % 60)}:${p(ms / 1000 % 60)},${p(ms % 1000, 3)}`; };
  const cues = said.map(c => ({ tau: T(c.t), text: c.text }));
  let srt = '', k = 0;
  for (let i = 0; i < cues.length; i++) {
    if (!cues[i].text) continue;
    const end = Math.min(i + 1 < cues.length ? cues[i + 1].tau : total, cues[i].tau + 12000);
    if (end - cues[i].tau < 300) continue;
    srt += `${++k}\n${stamp(cues[i].tau)} --> ${stamp(end - 50)}\n${cues[i].text}\n\n`;
  }
  if (TRACK) writeFileSync(out.replace(/\.mp4$/i, '') + '.srt', srt);
  // YouTube's chapter rule (user 2026-10-23): the first stamp is 00:00, so every stamp has two-digit minutes
  const mmss = ms => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000 % 60)).padStart(2, '0')}`;
  const ch = (man.chapters || []).map(c => ({ tau: T(c.t), title: c.title }));
  writeFileSync(out.replace(/\.mp4$/i, '') + '.chapters.txt', ch.map((c, i) => `${mmss(i === 0 ? 0 : c.tau)} ${c.title}`).join('\n') + '\n');

  // ── the encoder page ──
  await h.navigate('about:blank');
  const type = await h.eval(`(async () => {
    const c = document.createElement('canvas'); c.width = Math.round(${W} * ${SCALE}); c.height = Math.round(${H} * ${SCALE}); document.body.style.margin = '0'; document.body.appendChild(c);
    const g = c.getContext('2d'); g.scale(${SCALE}, ${SCALE});
    const speak = ${SPEAK ? 'true' : 'false'};
    const pick = list => list.find(t => MediaRecorder.isTypeSupported(t));
    const type = speak ? pick(['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/webm;codecs=vp9,opus'])
      : pick(['video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=vp9']);
    const vstream = c.captureStream(0); const track = vstream.getVideoTracks()[0];
    let ac = null, dest = null, stream = vstream;
    if (speak) {
      ac = new AudioContext({ sampleRate: 48000 }); dest = ac.createMediaStreamDestination();
      // a silent source that never stops: the audio track then runs from the first
      // moment to the last, and a sentence lands exactly where it was started
      const hum = ac.createConstantSource(); const mute = ac.createGain(); mute.gain.value = 0; hum.connect(mute); mute.connect(dest); hum.start();
      stream = new MediaStream([track, dest.stream.getAudioTracks()[0]]);
    }
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: ${Number(process.env.BITRATE || 8000000)}, audioBitsPerSecond: ${Number(process.env.AUDIO_BITRATE || 160000)}, videoKeyFrameIntervalDuration: ${KEYFRAME_MS} });
    const chunks = []; rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const V = window.__v = { c, g, track, rec, chunks, type, ac, dest, clips: {}, img: null, caption: '', chapter: '', fast: false, blob: null, url: '', title: '', ptr: null, ptrFrom: null, ptrT0: 0, clickAt: 0 };
    // the narration: each sentence is decoded before the recording starts, and only started at its moment
    V.load = async (id, b64) => { const bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0)); V.clips[id] = await ac.decodeAudioData(bytes.buffer); return V.clips[id].duration; };
    V.speak = id => { const buf = V.clips[id]; if (!buf) return false; const src = ac.createBufferSource(); src.buffer = buf; src.connect(dest); src.start(); return true; };
    const wrap = (text, max) => { const words = String(text).split(' '); const lines = []; let cur = '';
      for (const w of words) { const t = cur ? cur + ' ' + w : w; if (g.measureText(t).width > max && cur) { lines.push(cur); cur = w; } else cur = t; }
      if (cur) lines.push(cur); return lines; };
    const frame = () => {
      const FH = ${FRAME_H};
      // the tab strip
      g.fillStyle = '#dee1e6'; g.fillRect(0, 0, ${W}, 40);
      g.font = '400 15px "Segoe UI", sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'left';
      const title = V.title || 'New Tab';
      const tw = Math.min(360, Math.max(180, g.measureText(title).width + 84));
      g.fillStyle = '#fff'; g.beginPath(); g.roundRect(12, 8, tw, 40, [10, 10, 0, 0]); g.fill();
      g.fillStyle = '#1b6fd1'; g.beginPath(); g.roundRect(26, 16, 18, 18, 4); g.fill();
      g.fillStyle = '#fff'; g.font = '700 12px "Segoe UI", sans-serif'; g.textAlign = 'center'; g.fillText('A', 35, 26);
      g.textAlign = 'left'; g.font = '400 15px "Segoe UI", sans-serif'; g.fillStyle = '#202124';
      let t = title; while (t && g.measureText(t).width > tw - 84) t = t.slice(0, -1); if (t !== title) t = t.replace(/\s+$/, '') + '…';
      g.fillText(t, 54, 25);
      g.fillStyle = '#5f6368'; g.font = '400 18px "Segoe UI", sans-serif'; g.fillText('×', 12 + tw - 24, 24);
      g.font = '400 22px "Segoe UI", sans-serif'; g.fillText('+', 12 + tw + 14, 24);
      g.font = '400 16px "Segoe UI", sans-serif'; g.textAlign = 'center'; g.fillText('—', ${W} - 114, 20); g.fillText('▢', ${W} - 70, 20); g.fillText('✕', ${W} - 28, 20);
      // the address bar
      g.fillStyle = '#fff'; g.fillRect(0, 40, ${W}, FH - 40);
      g.fillStyle = '#5f6368'; g.font = '400 20px "Segoe UI Symbol", "Segoe UI", sans-serif'; g.textAlign = 'center';
      g.fillText('←', 24, 64); g.fillText('→', 58, 64); g.fillText('↻', 92, 64);
      g.fillStyle = '#f1f3f4'; g.beginPath(); g.roundRect(116, 46, ${W} - 116 - 132, 36, 18); g.fill();
      g.fillStyle = '#5f6368'; g.font = '400 15px "Segoe UI Emoji", "Segoe UI", sans-serif'; g.textAlign = 'left'; g.fillText('🧩', 132, 64);
      g.fillStyle = '#202124'; g.font = '400 16px "Segoe UI", sans-serif';
      let u = String(V.url || ''); while (u && g.measureText(u).width > ${W} - 116 - 132 - 60) u = u.slice(0, -1); if (u !== String(V.url || '')) u += '…';
      g.fillText(u, 160, 64);
      g.fillStyle = '#5f6368'; g.font = '400 18px "Segoe UI Symbol", "Segoe UI", sans-serif'; g.textAlign = 'center';
      g.fillText('☆', ${W} - 100, 64); g.fillText('⋮', ${W} - 24, 64);
      g.fillStyle = '#dadce0'; g.fillRect(0, FH - 1, ${W}, 1);
    };
    V.paint = () => {
      frame();
      g.fillStyle = '#ffffff'; g.fillRect(0, ${FRAME_H}, ${W}, ${PAGE_H});
      if (V.img) {
        // scaled to the width; a taller picture (another tab, at its own size) is cropped at the bottom, never squeezed
        const s = ${W} / V.img.width, hh = Math.min(${PAGE_H}, V.img.height * s);
        g.drawImage(V.img, 0, 0, V.img.width, hh / s, 0, ${FRAME_H}, ${W}, hh);
      }
      if (V.fast) { g.font = '600 26px "Segoe UI", sans-serif'; const t = '⏩ waiting — sped up'; const w = g.measureText(t).width + 36;
        g.fillStyle = 'rgba(11,31,58,.88)'; g.beginPath(); g.roundRect(${W} - w - 24, ${BAND_Y} - 68, w, 48, 24); g.fill(); g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillText(t, ${W} - w - 6, ${BAND_Y} - 44); }
      if (V.ptr) {
        // the pointer glides from where it was to where it is (350 ms), and a press is a ring that grows and fades
        const nowMs = performance.now(), k = Math.min(1, (nowMs - V.ptrT0) / 350), e = 1 - Math.pow(1 - k, 3);
        const from = V.ptrFrom || V.ptr, sc = ${W} / (V.ptr.vw || 1600);
        const x = (from.x + (V.ptr.x - from.x) * e) * sc, y = ${FRAME_H} + (from.y + (V.ptr.y - from.y) * e) * sc;
        if (y < ${BAND_Y}) {
          const age = nowMs - V.clickAt;
          if (V.clickAt && age < 450) { const rr = 10 + 26 * (age / 450); g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.strokeStyle = 'rgba(255,45,120,' + (0.9 * (1 - age / 450)).toFixed(2) + ')'; g.lineWidth = 4; g.stroke(); }
          g.save(); g.translate(x, y); g.scale(1.7, 1.7);
          g.beginPath(); g.moveTo(0, 0); g.lineTo(0, 16); g.lineTo(4, 12.5); g.lineTo(7, 19); g.lineTo(9.5, 18); g.lineTo(6.7, 11.5); g.lineTo(12, 11.5); g.closePath();
          g.fillStyle = '#fff'; g.fill(); g.lineWidth = 1.2; g.strokeStyle = '#111'; g.stroke(); g.restore();
        }
      }
      g.fillStyle = '#0b1f3a'; g.fillRect(0, ${BAND_Y}, ${W}, ${H - BAND_Y});
      g.fillStyle = '#1b6fd1'; g.fillRect(0, ${BAND_Y}, ${W}, 3);
      let left = 40;
      if (V.chapter) { g.font = '700 24px "Segoe UI", sans-serif'; const w = g.measureText(V.chapter).width + 36;
        g.fillStyle = '#1b6fd1'; g.beginPath(); g.roundRect(32, ${BAND_Y} + 38, w, 46, 10); g.fill();
        g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillText(V.chapter, 50, ${BAND_Y} + 62); left = 32 + w + 28; }
      if (V.caption && !${TRACK ? 'true' : 'false'}) { g.font = '500 31px "Segoe UI", sans-serif'; g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.textAlign = 'left';
        let lines = wrap(V.caption, ${W} - left - 40);
        if (lines.length > 2) { g.font = '500 26px "Segoe UI", sans-serif'; lines = wrap(V.caption, ${W} - left - 40).slice(0, 3); }
        const lh = lines.length > 2 ? 32 : 40; const y0 = ${BAND_Y} + 62 - (lines.length - 1) * lh / 2;
        lines.forEach((ln, i) => g.fillText(ln, left, y0 + i * lh)); }
      track.requestFrame();
    };
    V.frame = async b64 => { const im = new Image(); im.src = 'data:image/jpeg;base64,' + b64; try { await im.decode(); V.img = im; } catch (_) {} V.paint(); };
    V.paint();
    return type; })()`);
  h.log('encoder:', type);
  if (SPEAK) {
    // sound needs the page to have been "clicked" once: the protocol can say so
    const st = await h.cdp('Runtime.evaluate', { expression: '__v.ac.resume().then(() => __v.ac.state)', awaitPromise: true, returnByValue: true, userGesture: true });
    if (st.result.value !== 'running') throw new Error(`the audio could not start (${st.result.value})`);
    const files = [...new Set(ev.filter(e => e.voice).map(e => e.voice))];
    for (const f of files) await h.eval(`__v.load(${JSON.stringify(basename(f))}, ${JSON.stringify(readFileSync(f).toString('base64'))})`);
    h.log(`narration loaded: ${files.length} sentences`);
  }
  await h.eval(`(() => { __v.rec.start(1000); __v.keep = setInterval(__v.paint, 50); return 1; })()`);   // a held picture still needs frames, or players stall on it

  // ── play the timeline in real time ──
  const t0 = Date.now();
  let shown = 0, lastLog = 0, cueEnd = 0;
  for (const e of ev) {
    const wait = e.tau - (Date.now() - t0);
    if (wait > 2) await h.sleep(wait);
    if (e.kind === 'frame') {
      const b64 = readFileSync(e.f).toString('base64');
      await h.eval(`(async () => { __v.fast = ${e.fast ? 'true' : 'false'}; await __v.frame(${JSON.stringify(b64)}); return 1; })()`);
      shown++;
    } else if (e.kind === 'cue') { cueEnd = e.tau + (e.dur || 0) + 350; await h.eval(`(() => { __v.caption = ${JSON.stringify(e.text)}; __v.paint(); ${e.voice ? `__v.speak(${JSON.stringify(basename(e.voice))});` : ''} return 1; })()`); }
    // a wait begins: the badge goes on, and a sentence already spoken leaves the screen
    else if (e.kind === 'faston') await h.eval(`(() => { __v.fast = true; ${cueEnd <= e.tau ? "__v.caption = '';" : ''} __v.paint(); return 1; })()`);
    else if (e.kind === 'fastoff') await h.eval(`(() => { __v.fast = false; __v.paint(); return 1; })()`);
    else if (e.kind === 'ptr') await h.eval(`(() => { const V = __v; V.ptrFrom = V.ptr || { x: ${e.x}, y: ${e.y} }; V.ptr = { x: ${e.x}, y: ${e.y}, vw: ${e.vw} }; V.ptrT0 = performance.now(); ${e.click ? 'V.clickAt = performance.now();' : ''} V.paint(); return 1; })()`);
    else if (e.kind === 'page') await h.eval(`(() => { __v.url = ${JSON.stringify(e.url)}; __v.title = ${JSON.stringify(e.title)}; __v.paint(); return 1; })()`);
    else await h.eval(`(() => { __v.chapter = ${JSON.stringify(e.title)}; __v.paint(); return 1; })()`);
    // SNAP=<seconds>: one PNG of the composed picture at that moment, to look at the layout
    if (process.env.SNAP && !ev.snapped && e.tau >= Number(process.env.SNAP) * 1000) {
      ev.snapped = true;
      const png = await h.eval(`__v.c.toDataURL('image/png').slice(22)`);
      writeFileSync(out.replace(/\.mp4$/i, '') + '-snap.png', Buffer.from(png, 'base64'));
      h.log('snapshot written at', (e.tau / 1000).toFixed(1), 's');
    }
    if (Date.now() - lastLog > 30000) { lastLog = Date.now(); h.log(`… ${((Date.now() - t0) / 1000).toFixed(0)} / ${(total / 1000).toFixed(0)} s, ${shown} frames, lag ${Math.max(0, Date.now() - t0 - e.tau).toFixed(0)} ms`); }
  }
  const tail = total - (Date.now() - t0);
  if (tail > 0) await h.sleep(tail);

  // ── stop, and bring the file out of the page in slices ──
  const size = await h.eval(`(async () => { const V = __v; clearInterval(V.keep); const done = new Promise(r => { V.rec.onstop = r; }); V.rec.stop(); await done; V.blob = new Blob(V.chunks, { type: V.type }); return V.blob.size; })()`);
  let file = /mp4/.test(type) ? out : out.replace(/\.mp4$/i, '.webm');
  // A file a player or the cloud sync still holds (EBUSY, 2026-10-10: a 23-minute compose lost
  // at the last step) is left alone: the video goes to a sibling name instead, and it is said.
  try { writeFileSync(file, Buffer.alloc(0)); }
  catch (e) {
    if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
    const alt = file.replace(/\.(mp4|webm)$/i, `-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.$1`);
    h.log(`${basename(file)} is held by another program — writing ${basename(alt)} instead`);
    file = alt; writeFileSync(file, Buffer.alloc(0));
  }
  const SLICE = 3 * 1024 * 1024;
  for (let off = 0; off < size; off += SLICE) {
    const b64 = await h.eval(`(async () => { const buf = new Uint8Array(await __v.blob.slice(${off}, ${off + SLICE}).arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); return btoa(s); })()`);
    appendFileSync(file, Buffer.from(b64, 'base64'));
  }
  const onDisk = existsSync(file) ? statSync(file).size : 0;
  h.log(`video: ${file} — ${(onDisk / 1048576).toFixed(1)} MB (${onDisk === size ? 'complete' : `INCOMPLETE: page had ${size} bytes`}), ${(total / 1000).toFixed(0)} s, ${shown} frames`);
  h.log(TRACK ? `captions: ${out.replace(/\.mp4$/i, '')}.srt (a subtitle file — the picture has none)` : 'captions: burned into the picture (no subtitle file is written)', '· chapters:', out.replace(/\.mp4$/i, '') + '.chapters.txt');
  if (onDisk !== size) throw new Error('the video file is incomplete');
}
