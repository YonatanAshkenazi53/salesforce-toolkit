// ✂ Remove all / ⇄ Replace all can be paused and continued from the same item, also after the window was closed
// (owner 2026-11-16: "we need a way to close the window and continue from the same place if we want later on …
// when we do a remove all").
// Live: scripts/dev/live/fc-walk-pause.mjs (npc2: paused at item 1 of 30, the bar survived a reopen and a re-scan,
// ▶ Continue opened the same item with no scope question, ✕ End forgot it; nothing written to the org).
// NOT run live: the Skip path (a skipped item is not asked again after Continue) — pinned below from the source.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const { fcWalkSaved, fcWalkResumeWhy, fcWalkPausedText } = extractFunctions('field-cleaner.js', ['fcWalkSaved', 'fcWalkResumeWhy', 'fcWalkPausedText']);

const W = o => fcWalkSaved({ org: 'https://acme.my.salesforce.com', subject: 'Account.Region__c', swap: false, scope: 'all', skipped: ['001000000000001AAA'], total: 30, at: 7, when: '2026-11-16T10:00:00.000Z', ...o });

describe('what is remembered', () => {
  it('only the walk\'s own choices, cleaned', () => {
    const w = fcWalkSaved({ org: 'o', subject: 's', swap: 1, repl: 'New__c', scope: 'weird', skipped: ['001000000000001AAA', '001000000000001', 5], total: '30', at: -2 });
    expect(w).toEqual({ org: 'o', subject: 's', swap: true, repl: 'New__c', scope: 'must', skipped: ['001000000000001', '5'], total: 30, at: 0, when: '' });
    expect(fcWalkSaved(null)).toMatchObject({ subject: '', skipped: [], total: 0 });
  });
});

describe('is it the walk of what is on the page?', () => {
  const now = { org: 'https://ACME.my.salesforce.com/', subject: 'Account.Region__c', repl: '' };
  it('the same org and field → ready', () => { expect(fcWalkResumeWhy(W(), now)).toBe(''); });
  it('another field, another org, or nothing saved → not shown at all', () => {
    expect(fcWalkResumeWhy(W(), { ...now, subject: 'Account.Other__c' })).toBe('none');
    expect(fcWalkResumeWhy(W(), { ...now, org: 'https://other.my.salesforce.com' })).toBe('none');
    expect(fcWalkResumeWhy(null, now)).toBe('none');
    expect(fcWalkResumeWhy(fcWalkSaved({}), now)).toBe('none');
  });
  it('a paused ⇄ walk needs the same replacement picked again, and says which', () => {
    const w = W({ swap: true, repl: 'Area__c' });
    expect(fcWalkResumeWhy(w, now)).toMatch(/pick the replacement field again \(Area__c\)/);
    expect(fcWalkResumeWhy(w, { ...now, repl: 'Zone__c' })).toMatch(/Area__c/);
    expect(fcWalkResumeWhy(w, { ...now, repl: 'Area__c' })).toBe('');
  });
});

describe('the bar\'s sentence', () => {
  it('says which walk, when, where it stopped, how many are left and how many were skipped', () => {
    expect(fcWalkPausedText(W(), 24)).toBe(   // 24 open rows, one of them skipped by the user
      '⏸ ✂ Remove all was paused on 2026-11-16 at item 7 of 30 — 23 left, 1 skipped by you.');
    expect(fcWalkPausedText(W({ swap: true, repl: 'A__c', skipped: [], when: '' }), 1)).toBe('⏸ ⇄ Replace all was paused at item 7 of 30 — 1 left.');
  });
});

describe('the walk', () => {
  const every = FC.slice(FC.indexOf('async function fixEverything(fieldId, swap, resume) {'), FC.indexOf("// An item's buttons while its fix works"));
  const all = FC.slice(FC.indexOf("async function fixAll(type, fieldId, swap, way = '') {"), FC.indexOf('let _inWalk = 0, _walkStop = false;'));
  it('a continued walk asks no scope again and keeps its count and its skipped items', () => {
    expect(every).toContain('const scope = resume ? resume.scope : await _everyScopeAsk(swap);');
    expect(every).toContain('skip: new Set(resume ? resume.skipped : [])');
    expect(every).toContain('const total = resume ? resume.total :');
    expect(every).toContain('at: resume ? Math.max(0, resume.at - 1) : 0');   // the item it was paused ON is asked again
  });
  it('paused with something left → remembered; finished → forgotten', () => {
    expect(every).toContain("=== 'cancel') { stopped = true; break; }");
    expect(every).toContain('await _walkSave(stopped && left > 0 ? {');
    expect(every).toContain(': null);');
    expect(FC).toContain('await chrome.storage.local.set({ [WALK_KEY]: _walkSaved }); else await chrome.storage.local.remove(WALK_KEY);');
  });
  it('an item skipped by the user is not asked again; a done one never is', () => {
    expect(all).toContain("if (_walk && _walk.skip.has(String(it.id).slice(0, 15))) continue;");
    expect(all.indexOf("classList.contains('fc-item-fixed')) continue;")).toBeLessThan(all.indexOf('_walk.skip.has('));
    expect(all.indexOf('_walk.skip.has(')).toBeLessThan(all.indexOf('if (_walk) _walk.at++;'));
    expect(FC).toContain("if (_walk) _walk.skip.add(String(componentId).slice(0, 15));");
  });
  // owner 2026-11-17: 'the pause continue later should be just an X that lets you close the window … and we should
  // have it on any removal card' — every confirmation has ✕ in its head; in a walk the Cancel button is hidden and ✕ pauses
  it('every dialog of a walk says where it is, and is closed with the ✕ (the walk waits)', () => {
    const m = FC.slice(FC.indexOf('function _walkDialogMark() {'), FC.indexOf('// fixEverything') > 0 ? FC.indexOf('// fixEverything') : FC.indexOf('function _refreshFixEvery'));
    expect(m).toContain("c.hidden = true; c.style.display = 'none';");
    expect(m).not.toContain('⏸ Pause — continue later');
    expect(m).toContain("x.title = 'Close — the walk waits here.");
    expect(m).toContain("x.addEventListener('click', () => { _walkStop = true; }, true);");   // beside Skip this one, ✕ pauses — it never skips
    const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    const CF = read('sftk-confirm.js');
    expect(CF.split('class="sftk-cf-x"').length).toBe(3);   // the dialog and its production step
    expect(CF).toContain("document.getElementById('sftkConfirmX')?.addEventListener('click', () => { const c = document.getElementById('sftkConfirmCancel'); if (c) c.click(); else done(false); });");
    for (const f of ['styles.css', 'studio.css']) expect(read(f)).toContain('.sftk-cf-x {');
    expect(m).toContain('· item ${Math.min(_walk.at, _walk.total)');
    expect(every).toContain('new MutationObserver(_walkDialogMark)');
    expect(every).toContain('if (obs) obs.disconnect();');
    expect(FC).toContain('pause the walk here');
  });
  it('▶ Continue is off, with the reason, until the walk can go on; ✕ End only forgets', () => {
    expect(FC).toContain("if (!cont.disabled && pw && !pw.why) fixEverything(_curFieldId, pw.saved.swap, pw.saved);");
    expect(FC).toContain("if (ev.target.closest?.('.fc-walk-end')) { _walkSave(null).then(_refreshFixEvery); return; }");
    expect(FC).toMatch(/fc-walk-continue" \$\{pw\.why \? 'disabled' : ''\}/);
  });
});
