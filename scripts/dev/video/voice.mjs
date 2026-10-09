// The narration: every caption of the recorded sections, spoken into a file.
//
// Two engines:
//   edge (the default since 2026-10-09, user: "less robotic", "like NotebookLM")
//        — Microsoft's neural voices through the edge-tts package (the voices
//        Edge's Read Aloud uses), MP3 + a subtitle file whose last cue gives the
//        duration. The caption text goes to Microsoft's speech endpoint.
//        VOICE_NAME=en-US-AndrewNeural (default)  RATE="+0%"  PY=<python.exe>
//   sapi — Windows System.Speech (offline, the old robotic voice) → WAV.
//        VOICE_ENGINE=sapi VOICE_NAME="Microsoft David Desktop" RATE=1
//
//   REC_DIR=dist/video/rec node scripts/dev/video/voice.mjs
//
// Files land in REC_DIR/voice/<hash>.(mp3|wav), keyed by a hash of engine +
// text + voice + rate, so a caption that did not change is not spoken again.
// compose.mjs (VOICE=1) finds them through the same hash (voiceFile below) and
// reads their length with voiceSeconds.
//
// SAPI's speech commands go to PowerShell on its standard input: this PC does
// not run PowerShell script FILES, and that setting is left as it is.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const ENGINE = (process.env.VOICE_ENGINE || 'edge').toLowerCase() === 'sapi' ? 'sapi' : 'edge';
export const VOICE = process.env.VOICE_NAME || (ENGINE === 'edge' ? 'en-US-AndrewNeural' : 'Microsoft David Desktop');
export const RATE = ENGINE === 'edge'
  ? (process.env.RATE && /^[+-]\d+%$/.test(process.env.RATE) ? process.env.RATE : '+0%')
  : (Number.isFinite(Number(process.env.RATE)) && process.env.RATE !== undefined && process.env.RATE !== '' ? Number(process.env.RATE) : 1);
// The Python that has edge-tts (the bare `python` on this PC can be the Store alias).
const PY = process.env.PY || 'C:/Users/yonas/AppData/Local/Python/pythoncore-3.14-64/python.exe';

// What is said for a caption: the caption itself, minus what a voice should not read aloud.
export function spokenText(caption) {
  return String(caption || '')
    .replace(/[“”"]/g, '')
    .replace(/›/g, ', ')
    .replace(/×/g, ' times ')
    .replace(/\s+/g, ' ')
    .trim();
}
export function voiceFile(dir, caption) {
  const text = spokenText(caption);
  if (!text) return null;
  const hash = createHash('sha1').update(`${ENGINE === 'edge' ? 'edge|' : ''}${VOICE}|${RATE}|${text}`).digest('hex').slice(0, 16);
  return join(dir, 'voice', `${hash}.${ENGINE === 'edge' ? 'mp3' : 'wav'}`);
}
// Seconds of a voice file: a WAV from its header; an MP3 from the subtitle file
// edge-tts wrote beside it (the last cue's end, plus the tail it leaves after
// the final word).
export function voiceSeconds(file) {
  if (/\.wav$/i.test(file)) return wavSeconds(file);
  const srt = file.replace(/\.mp3$/i, '.srt');
  if (!existsSync(srt)) return 0;
  const ends = [...readFileSync(srt, 'utf8').matchAll(/--> (\d\d):(\d\d):(\d\d)[,.](\d{3})/g)].map(m => (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000);
  return ends.length ? Math.max(...ends) + 0.25 : 0;
}
// Seconds of a PCM WAV file, from its own header (data bytes / byte rate).
export function wavSeconds(file) {
  const b = readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return 0;
  let off = 12, byteRate = 0, data = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') byteRate = b.readUInt32LE(off + 16);
    if (id === 'data') { data = Math.min(size, b.length - off - 8); break; }
    off += 8 + size + (size % 2);
  }
  return byteRate ? data / byteRate : 0;
}
// Every caption of the recording, in order (one recording, or the walkthrough's sections).
export function captionsOf(dir) {
  const out = [];
  const add = f => { for (const c of (JSON.parse(readFileSync(f, 'utf8')).cues || [])) if (c.text) out.push(c.text); };
  if (existsSync(join(dir, 'order.json'))) {
    for (const id of JSON.parse(readFileSync(join(dir, 'order.json'), 'utf8'))) { const f = join(dir, id, 'manifest.json'); if (existsSync(f)) add(f); }
  } else add(join(dir, 'manifest.json'));
  return out;
}

export function speakAll(dir) {
  const texts = [...new Set(captionsOf(dir))];
  mkdirSync(join(dir, 'voice'), { recursive: true });
  const list = texts.map(t => ({ text: spokenText(t), file: voiceFile(dir, t) })).filter(x => x.file);
  const todo = list.filter(x => !existsSync(x.file) || statSync(x.file).size < 1000);
  if (todo.length && ENGINE === 'edge') {
    for (const it of todo) {
      const r = spawnSync(PY, ['-m', 'edge_tts', '--voice', VOICE, `--rate=${RATE}`, '--text', it.text, '--write-media', it.file, '--write-subtitles', it.file.replace(/\.mp3$/i, '.srt')], { encoding: 'utf8' });
      if (r.status !== 0 || !existsSync(it.file)) throw new Error(`edge-tts could not speak a caption: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
    }
  } else if (todo.length) {
    const listFile = join(dir, 'voice', 'list.json');
    writeFileSync(listFile, JSON.stringify(todo), 'utf8');
    const q = s => `'${String(s).replace(/'/g, "''")}'`;
    const ps = [
      'Add-Type -AssemblyName System.Speech',
      `$items = Get-Content -Raw -Encoding UTF8 -LiteralPath ${q(listFile)} | ConvertFrom-Json`,
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      `$s.SelectVoice(${q(VOICE)})`,
      `$s.Rate = ${Math.max(-10, Math.min(10, Math.round(RATE)))}`,
      '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(44100, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
      'foreach ($it in $items) { $s.SetOutputToWaveFile($it.file, $fmt); $s.Speak([string]$it.text); $s.SetOutputToNull() }',
      '$s.Dispose()',
      "'done'",
      '',
    ].join('\n');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], { input: ps, encoding: 'utf8' });
    if (r.status !== 0 || !/done/.test(r.stdout || '')) throw new Error(`the voice could not be made: ${(r.stderr || r.stdout || '').trim().slice(0, 400)}`);
  }
  const missing = list.filter(x => !existsSync(x.file));
  if (missing.length) throw new Error(`${missing.length} caption(s) have no voice file`);
  const total = list.reduce((n, x) => n + voiceSeconds(x.file), 0);
  return { captions: list.length, made: todo.length, seconds: total };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dir = resolve(process.env.REC_DIR || 'dist/video/rec');
  const r = speakAll(dir);
  console.log(`voice: ${ENGINE} ${VOICE}, rate ${RATE} — ${r.captions} captions, ${r.made} newly spoken, ${r.seconds.toFixed(0)} s of speech → ${join(dir, 'voice')}`);
}
