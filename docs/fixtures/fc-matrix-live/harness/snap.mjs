import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { SCR, REPO } from './lib.mjs';
const label = process.argv[2], dir = join(SCR, 'snap', label);
rmSync(dir, { recursive: true, force: true });
const r = spawnSync('sf', ['project', 'retrieve', 'start', '-o', 'npc', '--manifest', `"${join(REPO, 'docs/fixtures/fc-matrix-live/manifest/package.xml')}"`, '--target-metadata-dir', `"${dir}"`, '--unzip', '--json'], { encoding: 'utf8', shell: true, maxBuffer: 64 << 20 });
const j = JSON.parse(r.stdout); console.log(label, j.status === 0 ? 'retrieved' : r.stdout.slice(0, 400));
