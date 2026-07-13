// A4: generate the cross-file globals map for eslint no-undef.
//
// The extension is classic <script>-tag JS: every script in a page shares one
// global scope, so a function declared in studio-core.js is a valid free
// reference in studio-transfer.js. eslint's no-undef can't see that on its own
// — it would fire thousands of false positives. This script reads each HTML
// page's <script src> list, collects every TOP-LEVEL declared name across that
// group (+ window.X / globalThis.X assignments from the shared libs), and emits
// eslint-globals.json: { "<file>": { "<name>": "readonly", ... } }.
//
// Run: node scripts/gen-globals.mjs   (re-run after adding a top-level symbol)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Page groups: an HTML file → the ordered scripts that share its scope.
const HTML_PAGES = ['popup.html', 'studio.html', 'apex-log-viewer.html'];
// Standalone scripts that don't belong to an HTML page.
const STANDALONE = ['background.js', 'content.js'];

// Column-0 declarations: function / async function / const / let / var / class.
const DECL_RE = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)|^class\s+([A-Za-z_$][\w$]*)/gm;
// Names published on the shared global object from inside an IIFE module.
const WINDOW_RE = /(?:window|globalThis)\.([A-Za-z_$][\w$]*)\s*=/g;

function namesIn(src) {
  const out = new Set();
  let m;
  DECL_RE.lastIndex = 0;
  while ((m = DECL_RE.exec(src))) out.add(m[1] || m[2] || m[3]);
  WINDOW_RE.lastIndex = 0;
  while ((m = WINDOW_RE.exec(src))) out.add(m[1]);
  return out;
}

function scriptsOf(html) {
  const src = readFileSync(join(root, html), 'utf8');
  const re = /<script\s+src="([^"]+\.js)"/g;
  const files = [];
  let m;
  while ((m = re.exec(src))) files.push(m[1]);
  return files;
}

const groups = [];
for (const html of HTML_PAGES) {
  if (!existsSync(join(root, html))) continue;
  groups.push({ files: scriptsOf(html) });
}
for (const f of STANDALONE) groups.push({ files: [f] });

// Per file, the globals are the OTHER group files' top-level names — NOT the
// file's own declarations (those are ordinary declarations eslint sees, and
// listing them as globals would make no-global-assign/no-redeclare misfire on
// every module IIFE and every `let x` reassignment). So: union of the group,
// minus this file's own names.
const perFile = {};
const ownNames = {};
for (const g of groups) {
  for (const f of g.files) {
    if (existsSync(join(root, f)) && !ownNames[f]) ownNames[f] = namesIn(readFileSync(join(root, f), 'utf8'));
  }
}
for (const g of groups) {
  const union = new Set();
  for (const f of g.files) for (const n of (ownNames[f] || [])) union.add(n);
  for (const f of g.files) {
    const globalsObj = {};
    for (const n of [...union].sort()) {
      if (!ownNames[f]?.has(n)) globalsObj[n] = 'writable';
    }
    perFile[f] = Object.assign(perFile[f] || {}, globalsObj);
  }
}

writeFileSync(join(root, 'eslint-globals.json'), JSON.stringify(perFile, null, 2) + '\n');
const fileCount = Object.keys(perFile).length;
const total = new Set(Object.values(perFile).flatMap(o => Object.keys(o))).size;
console.log(`eslint-globals.json: ${fileCount} files, ${total} distinct cross-file names`);
