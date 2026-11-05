// ✓ The Deploy page remembers what you ticked (2026-11-05, a colleague's first
// day with the tool: "I ticked some 40 records from a ticket, remembered a
// parent was missing, went to the parent and deployed it, came back — and all
// my ticks were gone"). The rule worth testing: a tick comes back only when
// its record is still in the list it was ticked in; the rest are dropped and
// counted, never guessed back in; a child not read yet is neither.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

globalThis.sftkOrgKey = u => String(u).replace(/^https?:\/\//, '').replace(/\.my\.salesforce\.com.*$/, '');
const F = extractFunctions('sftk-depsel.js', ['sftkDepSelKinds', 'sftkDepSelKey', 'sftkDepSelPack', 'sftkDepSelCount', 'sftkDepSelEmpty', 'sftkDepSelRestore', 'sftkDepSelLine', 'sftkDepSelStorePut']);
const DEP = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../studio.html', import.meta.url), 'utf8');

const sets = () => ({ push: new Set(), overwrite: new Set(), updSrc: new Set(), del: new Set(), pull: new Set() });
const kid = () => ({ push: new Set(), relink: new Set(), overwrite: new Set(), del: new Set() });
const scan = (runAt, { miss = [], chg = [], ext = [], kids = {} } = {}) => ({
  runAt,
  missingInTarget: miss.map(id => ({ sourceId: id, matchKey: id })),
  changed: chg.map(id => ({ sourceId: id, targetId: 't' + id })),
  onlyInTarget: ext.map(id => ({ targetId: id })),
  children: kids,
});

describe('the key and the packed form', () => {
  it('one memory per deployment AND target org', () => {
    expect(F.sftkDepSelKey('p1', 'https://acme.my.salesforce.com')).toBe('p1|acme');
    expect(F.sftkDepSelKey('p1', 'https://other.my.salesforce.com')).not.toBe(F.sftkDepSelKey('p1', 'https://acme.my.salesforce.com'));
  });
  it('packs the Sets to plain ids, leaves out empty kinds, counts them, and is empty when nothing is ticked', () => {
    const r = sets(); r.push.add('a').add('b'); r.del.add('t1');
    const c = { '0': kid(), '1': kid() }; c['0'].push.add('c1'); c['0'].relink.add('t9');
    const packed = F.sftkDepSelPack(r, c, 123);
    expect(packed).toEqual({ root: { push: ['a', 'b'], del: ['t1'] }, children: { '0': { push: ['c1'], relink: ['t9'] } }, savedAt: 123, n: 5 });
    expect(F.sftkDepSelCount(packed)).toBe(5);
    expect(F.sftkDepSelEmpty(sets(), {})).toBe(true);
    expect(F.sftkDepSelEmpty(r, {})).toBe(false);
    expect(F.sftkDepSelEmpty(sets(), c)).toBe(false);
  });
});

describe('putting the ticks back onto a new scan', () => {
  it('a tick comes back only when its record is still in the list it was ticked in; the rest are dropped and counted', () => {
    const packed = { root: { push: ['a', 'b', 'c'], overwrite: ['x'], del: ['t1', 't2'] }, children: {}, n: 6 };
    // after the run: a and b were inserted (now in the target), x is still changed, t1 was deleted
    const r = F.sftkDepSelRestore(packed, scan(2, { miss: ['c', 'd'], chg: ['x', 'y'], ext: ['t2'] }));
    expect([...r.recSel.push]).toEqual(['c']);
    expect([...r.recSel.overwrite]).toEqual(['x']);
    expect([...r.recSel.del]).toEqual(['t2']);
    expect(r.kept).toBe(3); expect(r.dropped).toBe(3); expect(r.unread).toEqual([]);
  });
  it('a record that moved to another list is NOT ticked there (an insert that became "changed" is not an overwrite)', () => {
    const r = F.sftkDepSelRestore({ root: { push: ['a'] }, children: {} }, scan(2, { chg: ['a'] }));
    expect(r.recSel.push.size).toBe(0); expect(r.recSel.overwrite.size).toBe(0); expect(r.dropped).toBe(1);
  });
  it('a child counts only when read for THIS scan; one not read yet is returned as unread, neither kept nor dropped', () => {
    const packed = { root: {}, children: { '0': { push: ['c1', 'c2'], relink: ['t5'] }, '1': { push: ['k1'] } } };
    const kids = {
      '0': { status: 'success', rootRunAt: 2, missingInTarget: [{ sourceId: 'c1' }], linkMismatch: [{ targetId: 't5' }] },
      '1': { status: 'success', rootRunAt: 1, missingInTarget: [{ sourceId: 'k1' }] },   // read for the OLD scan
    };
    const r = F.sftkDepSelRestore(packed, scan(2, { kids }));
    expect([...r.childSel['0'].push]).toEqual(['c1']); expect([...r.childSel['0'].relink]).toEqual(['t5']);
    expect(r.childSel['1']).toBeUndefined();
    expect(r.kept).toBe(2); expect(r.dropped).toBe(1); expect(r.unread).toEqual(['1']);
    // later, that child read: only it is restored, the root left alone
    kids['1'] = { status: 'success', rootRunAt: 2, missingInTarget: [{ sourceId: 'k1' }] };
    const r2 = F.sftkDepSelRestore({ ...packed, root: { push: ['a'] } }, scan(2, { miss: ['a'], kids }), { root: false, children: ['1'] });
    expect(r2.recSel.push.size).toBe(0);
    expect([...r2.childSel['1'].push]).toEqual(['k1']); expect(r2.childSel['0']).toBeUndefined();
    expect(r2.kept).toBe(1); expect(r2.dropped).toBe(0); expect(r2.unread).toEqual([]);
  });
  it('nothing saved, or no scan: nothing back, nothing said', () => {
    expect(F.sftkDepSelRestore(null, scan(1)).kept).toBe(0);
    expect(F.sftkDepSelRestore({ root: { push: ['a'] }, children: {} }, null).dropped).toBe(0);
    expect(F.sftkDepSelLine(0, 0)).toBe('');
  });
  it('the sentence says what came back and what was dropped, and why', () => {
    expect(F.sftkDepSelLine(5, 0)).toBe('✓ Your 5 ticks from before are back.');
    expect(F.sftkDepSelLine(1, 0)).toBe('✓ Your 1 tick from before is back.');
    expect(F.sftkDepSelLine(0, 3)).toBe('Your 3 ticks from before were dropped — the records are no longer in the list they were ticked in (written since, or changed).');
    expect(F.sftkDepSelLine(2, 1)).toBe('✓ Your 2 ticks from before are back · 1 dropped — the records are no longer in the list they were ticked in (written since, or changed).');
  });
  it('the disk store keeps the newest deployments only', () => {
    let store = {};
    for (let i = 0; i < 5; i++) store = F.sftkDepSelStorePut(store, `k${i}`, { root: {}, children: {}, n: 0, savedAt: i }, 3);
    expect(Object.keys(store).sort()).toEqual(['k2', 'k3', 'k4']);
    store = F.sftkDepSelStorePut(store, 'k0', { root: {}, children: {}, n: 1, savedAt: 99 }, 3);
    expect(Object.keys(store).sort()).toEqual(['k0', 'k3', 'k4']);
  });
});

describe('wiring: saved on the user\'s actions only, put back once per scan, said on the page', () => {
  it('the page loads the module before the Deploy page', () => {
    const a = HTML.indexOf('<script src="sftk-depsel.js"></script>'), b = HTML.indexOf('<script src="studio-deploy.js"></script>');
    expect(a).toBeGreaterThan(0); expect(a).toBeLessThan(b);
  });
  it('every tick made by hand is remembered; a repaint or a scan never writes the memory', () => {
    expect(DEP).toContain('const touched = () => _depSelRemember(p);');
    expect((DEP.match(/\n\s+touched\(\);\n/g) || []).length).toBe(5);   // push box, overwrite/updSrc, del/pull, relink, the All/None buttons
    expect(DEP).toContain("_depRetry = null;\n    _depSelRemember(p);");           // ↻ Retry / ▶ Continue picks
    expect(DEP).toContain("for (const id of ids) { set.add(id); n++; }\n    }\n    _depSelRemember(p);");   // ✓ every insert
    const fn = DEP.slice(DEP.indexOf('function _depSummary('), DEP.indexOf('function _depSummary(') + 3000);
    expect(fn).not.toContain('_depSelRemember');
    const rescan = DEP.slice(DEP.indexOf('async function _depRescan('), DEP.indexOf('async function _depRescan(') + 1500);
    expect(rescan).not.toContain('_depSelRemember');
  });
  it('the ticks are put back once the scan is fresh, once per scan, only onto empty Sets; a child read later gets its own', () => {
    expect(DEP).toContain("if (fresh && scan) { try { await _depSelRestoreIfDue(p, scan); } catch (_) {} }");
    expect(DEP).toContain("const stamp = `${key}|${scan.runAt || ''}`;");
    expect(DEP).toContain('if (!sftkDepSelEmpty(_recSel, _recChildSel)) return;');
    expect(DEP).toContain("const r = sftkDepSelRestore(packed, scan, { root: false, children: _depSelUnread });");
    expect(DEP).toContain('_depSelKept += r.kept; _depSelDropped += r.dropped;');
  });
  it('counts-only mode keeps record ids off the disk; the disk copy is written at once and in order', () => {
    expect(DEP).toContain('if (_settings && _settings.countsOnly) return;   // no record ids on disk in counts-only mode');
    expect(DEP).toContain('_depSelWrite = _depSelWrite.then(async () => {');
    expect(DEP).toContain("await chrome.storage.local.set({ sftk_dep_sel: _depSelStore });");
  });
  it('the sentence is on the page, with what the memory covers', () => {
    expect(DEP).toContain('id="dsDepSelNote"');
    expect(DEP).toContain('Ticks are remembered per deployment and target org — through a refresh, a run and a closed tab.');
  });
});
