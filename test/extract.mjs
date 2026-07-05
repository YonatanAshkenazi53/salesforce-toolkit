// Test-time function extraction.
//
// The extension is classic-script JS (one global scope, no exports), so unit
// tests can't import functions directly until the Phase-6b module split.
// Until then: slice a top-level `function NAME(...)` out of its source file
// and materialize it with new Function. Only works for PURE functions (no
// free variables) — which is exactly what unit tests should target anyway.
//
// End-of-function detection relies on this codebase's formatting invariant:
// top-level functions close with a `}` at column 0. (A balanced-brace scanner
// was tried first and defeated by regex literals like /\/\//ig.)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function extractFunction(file, name) {
  const src = readFileSync(join(root, file), 'utf8');
  const marker = new RegExp(`^(?:async )?function ${name}\\(`, 'm');
  const m = marker.exec(src);
  if (!m) throw new Error(`top-level function ${name} not found in ${file}`);
  const start = m.index;
  const end = src.indexOf('\n}', start);
  if (end === -1) throw new Error(`no column-0 closing brace found after ${name} in ${file}`);
  const fnSrc = src.slice(start, end + 2);
  return new Function(`return (${fnSrc});`)();
}
