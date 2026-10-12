// Measure, in a finished MP4, how far the voice is from the caption it belongs to —
// at the start and at the end of the file (drift), without playing it.
//
//   VIDEO=dist/video/walkthrough-part2.mp4 node scripts/dev/headless-studio.mjs scripts/dev/video/avsync.mjs
//
// Method: the file is served to the harness's Chrome over a local http server. The audio
// track is decoded with WebAudio and turned into speech ONSETS (energy after ≥ 0.5 s of
// quiet). The caption band at the bottom of the picture is sampled every 0.25 s through a
// <video> element drawn to a canvas, and a caption CHANGE is a jump in that band's pixel
// sum. Each caption change is paired with the next speech onset within 3 s; the offsets
// (onset − change) at the beginning and the end of the file say whether the voice drifts.
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { resolve, basename } from 'node:path';

export default async function (h) {
  const file = resolve(process.env.VIDEO || 'dist/video/walkthrough-part2.mp4');
  const size = statSync(file).size;
  const srv = createServer((req, res) => {
    // the page itself comes from the same server, so the file is same-origin (a fetch from about:blank was refused)
    if (req.url === '/' || req.url === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>avsync</title><body></body>'); return; }
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const a = range ? Number(range[1]) : 0, b = range && range[2] ? Number(range[2]) : size - 1;
    const buf = readFileSync(file);
    res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': b - a + 1, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Access-Control-Allow-Origin': '*' });
    res.end(buf.subarray(a, b + 1));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/${encodeURIComponent(basename(file))}`;
  h.log('serving', basename(file), `${(size / 1048576).toFixed(1)} MB`);
  await h.navigate(`http://127.0.0.1:${srv.address().port}/`);
  const out = await h.eval(`(async () => {
    const url = ${JSON.stringify('/' + encodeURIComponent(basename(file)))};
    // ── audio: speech onsets ──
    const ab = await (await fetch(url)).arrayBuffer();
    const ac = new OfflineAudioContext(1, 1, 16000);
    const audio = await ac.decodeAudioData(ab.slice(0));
    const data = audio.getChannelData(0), sr = audio.sampleRate, win = Math.round(sr * 0.05);
    const env = [];
    for (let i = 0; i + win <= data.length; i += win) { let s = 0; for (let j = i; j < i + win; j++) s += data[j] * data[j]; env.push(Math.sqrt(s / win)); }
    const sorted = [...env].sort((a, b) => a - b), noise = sorted[Math.floor(sorted.length * 0.3)], peak = sorted[Math.floor(sorted.length * 0.98)];
    const thr = noise + (peak - noise) * 0.15;
    const onsets = []; let quiet = 0;
    for (let i = 0; i < env.length; i++) { if (env[i] < thr) quiet++; else { if (quiet >= 10) onsets.push(i * 0.05); quiet = 0; } }
    // ── video: caption-band changes ──
    const v = document.createElement('video'); v.src = url; v.muted = true; v.preload = 'auto'; document.body.appendChild(v);
    await new Promise((r, j) => { v.onloadedmetadata = r; v.onerror = () => j(new Error('video failed to load')); });
    const W = v.videoWidth, H = v.videoHeight, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d', { willReadFrequently: true });
    const bandY = Math.round(H * (960 / 1080)) + Math.round(H * 0.03), bandH = H - bandY - Math.round(H * 0.02);
    const seek = t => new Promise(r => { v.onseeked = () => r(); v.currentTime = t; });
    const sample = async t => { await seek(t); g.drawImage(v, 0, 0); const d = g.getImageData(Math.round(W * 0.12), bandY, Math.round(W * 0.86), bandH).data; let s = 0; for (let i = 0; i < d.length; i += 16) s += d[i]; return s; };
    const changes = []; let prev = null;
    const step = 0.25, end = v.duration;
    for (let t = 0; t < end; t += step) { const s = await sample(t); if (prev !== null && Math.abs(s - prev) > prev * 0.04 + 500) changes.push(+t.toFixed(2)); prev = s; }
    // ── pair them ──
    const pairs = [];
    for (const ch of changes) { const on = onsets.find(o => o >= ch - 0.3 && o <= ch + 3); if (on != null) pairs.push({ change: ch, onset: +on.toFixed(2), offset: +(on - ch).toFixed(2) }); }
    const third = Math.max(1, Math.floor(pairs.length / 3));
    const med = arr => { const s = arr.map(p => p.offset).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
    return { duration: +end.toFixed(1), onsets: onsets.length, changes: changes.length, paired: pairs.length,
      firstThirdMedianOffset: med(pairs.slice(0, third)), lastThirdMedianOffset: med(pairs.slice(-third)),
      samples: pairs.filter((_, i) => i % Math.max(1, Math.floor(pairs.length / 12)) === 0) };
  })()`);
  srv.close();
  h.log('RESULT:', JSON.stringify(out));
  h.log(`voice vs caption: first third ${out.firstThirdMedianOffset}s, last third ${out.lastThirdMedianOffset}s (positive = voice starts after the caption appears; the two should be equal if nothing drifts)`);
}
