// Syntax gate: node --check every .js file in the extension root.
// Fails loud with the first parser error. Run via `npm run check`.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(root).filter(f => f.endsWith('.js'));
let failed = 0;

for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', join(root, f)], { stdio: 'pipe' });
    console.log(`OK    ${f}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${f}\n${e.stderr?.toString().split('\n').slice(0, 4).join('\n')}`);
  }
}

console.log(failed ? `\n${failed} file(s) FAILED` : `\nAll ${files.length} files parse.`);
process.exit(failed ? 1 : 0);
