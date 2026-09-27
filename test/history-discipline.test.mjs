// Every write reaches History, with an undo statement (campaign 3, phase 3).
//
// Rule 1 — every sftkWriteVerified / sftkWriteVerifiedAll call names a
//   journal (`journal:` inside the call, within twelve lines) or is marked
//   `// history-by: <the entry that records it>` within eight lines above
//   (writes that are steps of a bigger entry: the engine's run, a Deploy
//   page rollback, a Field Cleaner restore point).
// Rule 2 — every sftkHistoryEnd call states `undo:` within six lines
//   (steps as data, or `{ none: 'why' }`); a reviewer reads the reason.
//
// The baseline is the offender count per file on the day the rule landed
// (2026-09-27). Exact and only going down, like test/write-discipline.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI_FILES = readdirSync(root).filter(f => f.endsWith('.js') && !f.startsWith('_') && !f.startsWith('eslint')
  && !['background.js', 'content.js', 'trusted-types-policy.js', 'sftk-write.js', 'sftk-history.js', 'sftk-confirm.js'].includes(f));

const BASELINE = {
  'apex-debugger.js': 6,
  'dependency-map.js': 2,
  'field-cleaner.js': 14,
  'flow-permissions.js': 1,
  'license-manager.js': 2,
  'lightning-pages.js': 3,
  'popup.js': 3,
  'studio-picklists.js': 5,
  'studio-reconcile.js': 9,
  'studio-scan.js': 1,
  'studio-seed.js': 5,
  'user-copy.js': 5,
};

export function offenders(src, file) {
  const lines = src.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    if (/\bsftkWriteVerified(All)?\(/.test(line)) {
      const above = lines.slice(Math.max(0, i - 8), i).join('\n');
      const call = lines.slice(i, i + 12).join('\n');
      if (/history-by:/.test(above) || /\bjournal:/.test(call) || /\bjournal\b\s*[,}]/.test(call)) return;
      out.push(`${file}:${i + 1}  ${line.trim().slice(0, 90)}`);
    }
    if (/\bsftkHistoryEnd\(/.test(line)) {
      const call = lines.slice(i, i + 6).join('\n');
      if (/\bundo:/.test(call) || /\bundo\b\s*[,}]/.test(call)) return;
      out.push(`${file}:${i + 1}  (End without an undo statement) ${line.trim().slice(0, 70)}`);
    }
  });
  return out;
}

describe('every verified write names its History journal; every End states its undo', () => {
  for (const file of UI_FILES) {
    it(`${file}: ${BASELINE[file] || 0} write(s) outside History, no more and no fewer`, () => {
      const found = offenders(readFileSync(join(root, file), 'utf8'), file);
      const expected = BASELINE[file] || 0;
      const msg = found.length > expected
        ? `NEW write(s) outside History in ${file} — pass journal: j (from sftkHistoryBegin) and end it with sftkHistoryEnd(j, { undo }), or add "// history-by: <entry>" above:\n  ${found.join('\n  ')}`
        : found.length < expected ? `${file} has ${found.length} write(s) outside History now — lower its BASELINE to ${found.length}` : '';
      expect(found.length, msg).toBe(expected);
    });
  }
  it('sftk-history.js is loaded by both pages after sftk-write.js and before the tools; the popup also loads the archive', () => {
    for (const page of ['popup.html', 'studio.html']) {
      const html = readFileSync(join(root, page), 'utf8');
      const h = html.indexOf('src="sftk-history.js"'), w = html.indexOf('src="sftk-write.js"'), a = html.indexOf('src="sftk-archive.js"');
      expect(h, page).toBeGreaterThan(w);
      expect(a, `${page} loads the archive before the history module`).toBeGreaterThan(-1);
      expect(a).toBeLessThan(h);
      for (const tool of ['field-cleaner.js', 'user-copy.js', 'dependency-map.js', 'studio-picklists.js', 'studio-history.js']) {
        const j = html.indexOf(`src="${tool}"`);
        if (j > 0) expect(h, `${tool} before the history module in ${page}`).toBeLessThan(j);
      }
    }
  });
  it('the write helper hands every verdict to the journal (single and batched)', () => {
    const src = readFileSync(join(root, 'sftk-write.js'), 'utf8');
    expect(src).toContain("if (spec && spec.journal && typeof sftkHistoryNote === 'function') sftkHistoryNote(spec.journal, out, spec.describe);");
    expect(src).toContain('const j = list[i].journal || (opts && opts.journal);');
  });
  it('the History page renders tool entries with ↩ Undo through sftkToolUndoState, and the action is routed', () => {
    const hist = readFileSync(join(root, 'studio-history.js'), 'utf8');
    expect(hist).toContain("if (run.kind === 'tool') return _histToolCard(run);");
    expect(hist).toContain('data-dsaction="undoTool"');
    expect(hist).toContain('sftkToolUndoState(run)');
    expect(readFileSync(join(root, 'studio-core.js'), 'utf8')).toContain("case 'undoTool':              window.undoTool?.(arg); break;");
  });
});
