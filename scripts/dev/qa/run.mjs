// The QA driver: runs live scripts one after another against the PUBLIC build
// (dist/store-staging) and keeps every log, then prints one line per run.
//
//   node scripts/dev/qa/run.mjs <batch>        a batch from scripts/dev/qa/batches.mjs
//   node scripts/dev/qa/run.mjs <batch> <name> only the run called <name> in it
//   ONLY=a,b   SFTK_EXT=.  (the dev build instead)
//
// Logs: dist/qa/<batch>/<name>.log. The summary line per run: exit code, page
// exceptions, console errors, lines with ❌ / FAILED / timeout, and the last
// line the script printed. The scripts themselves say what they verified
// (CLI truth, re-reads); this driver only runs them and gathers.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BATCHES } from './batches.mjs';

const [batchName, onlyArg] = process.argv.slice(2);
const batch = BATCHES[batchName];
if (!batch) { console.error(`batches: ${Object.keys(BATCHES).join(', ')}`); process.exit(2); }
const only = (process.env.ONLY || onlyArg || '').split(',').map(s => s.trim()).filter(Boolean);
const outDir = resolve('dist/qa', batchName);
mkdirSync(outDir, { recursive: true });
const ext = process.env.SFTK_EXT || 'dist/store-staging';
if (!existsSync(resolve(ext, 'manifest.json'))) { console.error(`no build at ${ext} — run npm run pack first`); process.exit(2); }

const summary = [];
const NL = String.fromCharCode(10);
for (const run of batch) {
  if (only.length && !only.includes(run.name)) continue;
  const t0 = Date.now();
  process.stdout.write(`▶ ${run.name} … `);
  let r;
  if (run.node) {
    r = spawnSync('node', ['-e', run.node], { encoding: 'utf8', env: { ...process.env, ...(run.env || {}) }, timeout: (run.timeoutMin || 20) * 60000 });
  } else {
    r = spawnSync('node', ['scripts/dev/headless-studio.mjs', run.script], { encoding: 'utf8', env: { ...process.env, SFTK_EXT: ext, ...(run.env || {}) }, timeout: (run.timeoutMin || 20) * 60000 });
  }
  const log = `${r.stdout || ''}${r.stderr || ''}`;
  writeFileSync(join(outDir, `${run.name}.log`), log);
  const lines = log.split(NL).map(l => l.trimEnd()).filter(Boolean);
  const count = re => lines.filter(l => re.test(l)).length;
  const exc = count(/PAGE EXCEPTION/), cerr = count(/CONSOLE error/), bad = count(/❌(?! Failed 0)|FAILED|timeout waiting|SECTION FAILED|Not finished|INCOMPLETE/i);   // a report's own "❌ Failed 0" is not a failure
  const last = lines.length ? lines[lines.length - 1].slice(0, 160) : '(no output)';
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const line = `${r.status === 0 ? '✓' : '✗'} ${run.name} · exit ${r.status === null ? 'timeout' : r.status} · ${secs}s · exceptions ${exc} · console errors ${cerr} · ❌/FAILED lines ${bad} · last: ${last}`;
  console.log(line);
  summary.push(line);
}
writeFileSync(join(outDir, '_summary.txt'), summary.join(NL) + NL);
console.log(`\nlogs: ${outDir}`);
