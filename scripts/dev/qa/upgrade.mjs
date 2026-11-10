// The upgrade test: what a store user gets when Chrome replaces 1.0.0 with 1.1.0.
//   node scripts/dev/qa/upgrade.mjs
// One folder (so one extension id) and one browser profile (so one storage):
//   1. the 1.0.0 store zip is unpacked into dist/qa/upgrade/ext and used on npc (PHASE=seed)
//   2. the folder's files are replaced with the packed 1.1.0 build (dist/store-staging)
//   3. the same profile opens it again (PHASE=check): nothing stored is lost, every page and tool opens
// Logs: dist/qa/upgrade/seed.log, check.log. Exit code 1 when either phase failed.
import { spawnSync, execFileSync } from 'node:child_process';
import { rmSync, mkdirSync, cpSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const OLD = process.env.OLD_ZIP || 'dist/salesforce-toolkit-v1.0.0-store.zip';
const NEW = process.env.NEW_DIR || 'dist/store-staging';
const root = resolve('dist/qa/upgrade'), ext = join(root, 'ext'), profile = join(root, 'profile'), state = join(root, 'state.json');
if (!existsSync(OLD)) { console.error(`no ${OLD}`); process.exit(2); }
if (!existsSync(join(NEW, 'manifest.json'))) { console.error(`no build at ${NEW} — pack first`); process.exit(2); }
rmSync(root, { recursive: true, force: true });
mkdirSync(ext, { recursive: true }); mkdirSync(profile, { recursive: true });
execFileSync('tar', ['-xf', resolve(OLD), '-C', ext]);
const ver = () => JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8')).version;

let failed = false;
function phase(name) {
  console.log(`▶ ${name} on ${ver()} …`);
  const r = spawnSync('node', ['scripts/dev/headless-studio.mjs', 'scripts/dev/live/qa-upgrade.mjs'], { encoding: 'utf8', timeout: 25 * 60000,
    env: { ...process.env, SFTK_EXT: ext, SFTK_PROFILE: profile, PHASE: name, STATE_FILE: state } });
  const log = `${r.stdout || ''}${r.stderr || ''}`;
  writeFileSync(join(root, `${name}.log`), log);
  const NL = String.fromCharCode(10);
  const lines = log.split(NL).filter(l => /PHASE|licence gate|storage:|deployments|dark mode|views before|tabs before|studio ·|toolkit ·|PAGE EXCEPTION|CONSOLE error|✅|❌|   · /.test(l) && !/frontdoor|sid=/.test(l));
  console.log(lines.join(NL));
  if (r.status !== 0 || /❌|PAGE EXCEPTION/.test(log) || !/✅/.test(log)) failed = true;
}
phase('seed');
rmSync(ext, { recursive: true, force: true });
cpSync(NEW, ext, { recursive: true });
phase('check');
console.log(failed ? '\n❌ the upgrade test FAILED' : '\n✅ the upgrade test passed');
process.exit(failed ? 1 : 0);
