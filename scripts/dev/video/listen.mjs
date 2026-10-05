// Check the sound of a finished video without playing it: decode its audio
// track in headless Chrome and report its length, when the first sound comes,
// and how much of the time something is being said.
//   VIDEO=dist/video/walkthrough.mp4 node scripts/dev/headless-studio.mjs scripts/dev/video/listen.mjs
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export default async function (h) {
  const file = resolve(process.env.VIDEO || 'dist/video/walkthrough.mp4');
  const buf = readFileSync(file);
  await h.navigate('about:blank');
  await h.eval(`(() => { window.__parts = []; return 1; })()`);
  const SLICE = 3 * 1024 * 1024;
  for (let off = 0; off < buf.length; off += SLICE) await h.eval(`(() => { __parts.push(Uint8Array.from(atob(${JSON.stringify(buf.subarray(off, off + SLICE).toString('base64'))}), c => c.charCodeAt(0))); return 1; })()`);
  const r = JSON.parse(await h.eval(`(async () => {
    const all = new Blob(__parts); const ac = new OfflineAudioContext(1, 48000, 48000);
    const a = await ac.decodeAudioData(await all.arrayBuffer());
    const d = a.getChannelData(0), sr = a.sampleRate, win = Math.floor(sr / 4);
    let first = -1, loud = 0, n = 0, peak = 0; const gaps = []; let quietSince = 0, inQuiet = true;
    for (let i = 0; i + win <= d.length; i += win) {
      let s = 0; for (let j = i; j < i + win; j += 8) { s += d[j] * d[j]; if (Math.abs(d[j]) > peak) peak = Math.abs(d[j]); }
      const rms = Math.sqrt(s / (win / 8)); n++;
      if (rms > 0.01) { loud++; if (first < 0) first = i / sr; if (inQuiet && i / sr - quietSince > 6) gaps.push([Math.round(quietSince), Math.round(i / sr)]); inQuiet = false; }
      else if (!inQuiet) { inQuiet = true; quietSince = i / sr; }
    }
    return JSON.stringify({ seconds: a.duration, channels: a.numberOfChannels, sampleRate: sr, firstSound: first, speaking: loud / n, peak, longSilences: gaps.slice(0, 12) });
  })()`));
  h.log(`audio: ${r.seconds.toFixed(1)} s, ${r.channels} channel(s), ${r.sampleRate} Hz · first sound at ${r.firstSound.toFixed(1)} s · something is said ${(r.speaking * 100).toFixed(0)}% of the time · peak ${r.peak.toFixed(2)}`);
  h.log('silences longer than 6 s (from → to, seconds):', JSON.stringify(r.longSilences));
}
