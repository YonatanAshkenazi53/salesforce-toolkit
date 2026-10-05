// The narration: every caption of the recorded sections, spoken into a WAV
// file by a voice that is already on this PC (Windows System.Speech — offline,
// the text goes nowhere, nothing is installed).
//
//   REC_DIR=dist/video/rec node scripts/dev/video/voice.mjs
//   VOICE="Microsoft David Desktop"  (default — the installed male voice)   RATE=1  (-10 … 10)
//
// Files land in REC_DIR/voice/<hash>.wav, keyed by a hash of text + voice +
// rate, so a caption that did not change is not spoken again. compose.mjs
// (VOICE=1) finds them through the same hash (voiceFile below).
//
// The speech commands go to PowerShell on its standard input: this PC does not
// run PowerShell script FILES, and that setting is left as it is.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const VOICE = process.env.VOICE_NAME || 'Microsoft David Desktop';
export const RATE = Number.isFinite(Number(process.env.RATE)) && process.env.RATE !== undefined && process.env.RATE !== '' ? Number(process.env.RATE) : 1;

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
  const hash = createHash('sha1').update(`${VOICE}|${RATE}|${text}`).digest('hex').slice(0, 16);
  return join(dir, 'voice', `${hash}.wav`);
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
  if (todo.length) {
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
  const total = list.reduce((n, x) => n + wavSeconds(x.file), 0);
  return { captions: list.length, made: todo.length, seconds: total };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dir = resolve(process.env.REC_DIR || 'dist/video/rec');
  const r = speakAll(dir);
  console.log(`voice: ${VOICE}, rate ${RATE} — ${r.captions} captions, ${r.made} newly spoken, ${r.seconds.toFixed(0)} s of speech → ${join(dir, 'voice')}`);
}
