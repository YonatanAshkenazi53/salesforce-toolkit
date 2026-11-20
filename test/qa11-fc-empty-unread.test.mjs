// QA 1.1 finding C2 — a scan with no rows but with kinds it could not read names them and keeps Delete Field locked.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const { fcEmptyScanView: view, fcPartialAskLock: lock } = extractFunctions('field-cleaner.js', ['fcEmptyScanView', 'fcPartialAskLock']);

describe('the view of a scan that lists nothing', () => {
  it('everything read: no dependencies, the button is open', () => {
    const v = view(0, true);
    expect(v.locked).toBe(false);
    expect(v.title).toBe('No dependencies found');
    expect(v.note).toBe('');
  });
  it('something unread: it does not say "No dependencies found", and the button starts locked', () => {
    for (const n of [1, 3]) {
      const v = view(n, true);
      expect(v.locked).toBe(true);
      expect(v.title).not.toMatch(/No dependencies found/);
      expect(v.title).toBe('Nothing found, but the scan is incomplete');
      expect(v.sub).toContain(`${n} kind${n === 1 ? '' : 's'} of metadata could not be read`);
      expect(v.icon).not.toBe('✅');
      expect(v.note).toMatch(/^🔒 .*Asking Salesforce whether it would accept the delete…$/);
    }
  });
  it('a scope that does not ask Salesforce says what to do instead of promising an answer', () => {
    const v = view(2, false);
    expect(v.locked).toBe(true);
    expect(v.note).toBe('🔒 The scan could not read everything — see above. Press 🔍 Re-scan.');
  });
  it('a missing count is no unread kind', () => {
    expect(view(undefined, true).locked).toBe(false);
    expect(view(null, true).locked).toBe(false);
  });
});

describe('what Salesforce’s own check does to a locked button', () => {
  it('accepts with nothing listed: unlocked, and the note says the scan was incomplete', () => {
    const l = lock('ok', 0);
    expect(l.disabled).toBe(false);
    expect(l.note).toContain('could not read everything');
  });
  it('accepts while rows are still open: left as it is', () => {
    expect(lock('ok', 2)).toBe(null);
  });
  it('could not be asked: locked, and told to re-scan', () => {
    expect(lock('error', 0)).toEqual({ disabled: true, note: '🔒 The scan could not read everything and Salesforce could not be asked — press 🔍 Re-scan.' });
    expect(lock('error', 1)).toEqual({ disabled: true, note: null });
  });
  it('refuses: the lock of a refusal is drawn elsewhere, for every scan', () => {
    expect(lock('blocked', 0)).toBe(null);
  });
});

describe('the empty branch of renderResults is drawn from them', () => {
  const empty = FC.slice(FC.indexOf('    if (!deps.length) {'), FC.indexOf('    // Group\n    _groups = {};'));
  it('reads the unread kinds of the scan and draws the title, the note and the lock from the view', () => {
    expect(empty.length).toBeGreaterThan(300);
    expect(empty).toContain('const unread0 = (_lastScan && _lastScan.unread) || [];');
    expect(empty).toContain("const ev = fcEmptyScanView(unread0.length, fcScopeNorm(_lastScan && _lastScan.scope) !== 'mentions');");
    expect(empty).toContain('<div class="fc-clean-title">${esc(ev.title)}</div>');
    expect(empty).toContain('${ev.locked ? `<div class="fc-delete-note" id="fcDeleteNote">${esc(ev.note)}</div>` : \'\'}');
    expect(empty).toContain('<button class="btn btn-danger" id="fcDelFreeBtn" ${ev.locked ? \'disabled\' : \'\'}>');
  });
  it('names the unread kinds above the note that points at them', () => {
    const block = empty.indexOf('${_unreadBlockHtml(unread0, true)}');
    expect(block).toBeGreaterThan(0);
    expect(block).toBeLessThan(empty.indexOf('${_unscannedNoteHtml()}'));
  });
  it('the block is the one a list with rows shows, with each kind and its reason', () => {
    const fn = FC.slice(FC.indexOf('  function _unreadBlockHtml(unread, emptyList) {'), FC.indexOf('  async function renderResults('));
    expect(fn).toContain("if (!unread || !unread.length) return '';");
    expect(fn).toContain('id="fcUnreadNote"');
    expect(fn).toContain('<li><b>${esc(u.leg)}</b> — ${esc(u.why)}</li>');
    expect(fn).toContain("emptyList ? 'the empty result above' : 'the list below'");
    expect(FC).toContain('const unreadBlock = _unreadBlockHtml(unread, false);');
  });
  it('Salesforce’s check locks and unlocks the button of the empty view too', () => {
    const paint = FC.slice(FC.indexOf('  function _paintAsk(ask) {'), FC.indexOf('  function _autoAsk() {'));
    expect(paint).toContain("const d = eid('fcDelBtn') || eid('fcDelFreeBtn'), note = eid('fcDeleteNote');");
    expect(paint).toContain('const lock = fcPartialAskLock(view.kind, open);');
    expect(paint).toContain('if (lock) { if (d) d.disabled = lock.disabled; if (note && lock.note) note.textContent = lock.note; }');
  });
});
