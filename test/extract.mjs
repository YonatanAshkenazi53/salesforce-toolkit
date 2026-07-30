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

function sliceFunction(src, file, name) {
  const marker = new RegExp(`^(?:async )?function ${name}\\(`, 'm');
  const m = marker.exec(src);
  if (!m) throw new Error(`top-level function ${name} not found in ${file}`);
  const end = src.indexOf('\n}', m.index);
  if (end === -1) throw new Error(`no column-0 closing brace found after ${name} in ${file}`);
  return src.slice(m.index, end + 2);
}

export function extractFunction(file, name) {
  const src = readFileSync(join(root, file), 'utf8');
  return new Function(`return (${sliceFunction(src, file, name)});`)();
}

// Like extractFunction, but materializes several functions from the same file
// in ONE scope so they can call each other (e.g. sftkBuildStoredZip →
// sftkCrc32). Returns { name: fn, ... }.
export function extractFunctions(file, names, alsoFrom) {
  const src = readFileSync(join(root, file), 'utf8');
  const parts = names.map(n => sliceFunction(src, file, n));
  // Optional cross-file dependencies: { 'other-file.js': ['fnA', 'fnB'] }.
  // Materialized into the SAME scope first, so an extracted function can call
  // a helper that lives in another file (e.g. studio-core's _orgKey → the
  // shared sftkOrgKey). They are not returned — only `names` are.
  for (const [depFile, depNames] of Object.entries(alsoFrom || {})) {
    const depSrc = readFileSync(join(root, depFile), 'utf8');
    for (const n of depNames) parts.unshift(sliceFunction(depSrc, depFile, n));
  }
  return new Function(`${parts.join('\n')}\nreturn { ${names.join(', ')} };`)();
}
