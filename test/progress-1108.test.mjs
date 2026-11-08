// The shared long-load progress widget (user 2026-11-08: "when we scan these on enterprises it may take time. i want
// to show the animation and progress + estimation every loading that might take time") — the pure estimate and line
// on text, the wiring into every long loader pinned; and the Flows › Versions tree card ("should look more like the
// other pages").
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const P = extractFunctions('sftk-progress.js', ['sftkProgFmtSec', 'sftkProgEta', 'sftkProgLine']);
const SRC = readFileSync(new URL('../sftk-progress.js', import.meta.url), 'utf8');
const POP = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../popup.html', import.meta.url), 'utf8');
const DEP = readFileSync(new URL('../dependency-map.js', import.meta.url), 'utf8');
const LP = readFileSync(new URL('../lightning-pages.js', import.meta.url), 'utf8');
const FP = readFileSync(new URL('../flow-permissions.js', import.meta.url), 'utf8');
const UC = readFileSync(new URL('../user-copy.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

describe('sftkProgFmtSec', () => {
  it('seconds, minutes, hours', () => {
    expect(P.sftkProgFmtSec(12)).toBe('12 s');
    expect(P.sftkProgFmtSec(59.6)).toBe('1 min');
    expect(P.sftkProgFmtSec(150)).toBe('3 min');
    expect(P.sftkProgFmtSec(4200)).toBe('1 h 10 min');
    expect(P.sftkProgFmtSec(-5)).toBe('0 s');
  });
});

describe('sftkProgEta — steps', () => {
  const legs = [{ label: 'a', weight: 3 }, { label: 'b', weight: 2 }, { label: 'c', weight: 5 }];
  it('says nothing before three units of weight are done (no memory)', () => {
    expect(P.sftkProgEta({ mode: 'steps', legs, idx: 0, doneW: 0, doneMs: 0, legAt: 0, startedAt: 0 }, 1000)).toBeNull();
  });
  it('uses the memory of last time until the legs can speak', () => {
    expect(P.sftkProgEta({ mode: 'steps', legs, idx: 0, doneW: 0, doneMs: 0, legAt: 0, startedAt: 0, lastMs: 20000 }, 5000)).toBe(15);
  });
  it('from the legs done: 3 weight in 3 s → 1 s per unit; 7 left minus 1 s already in the leg → 6 s', () => {
    expect(P.sftkProgEta({ mode: 'steps', legs, idx: 1, doneW: 3, doneMs: 3000, legAt: 3000, startedAt: 0 }, 4000)).toBe(6);
  });
});

describe('sftkProgEta — count', () => {
  it('needs three items and 1.5 s, else memory, else nothing', () => {
    expect(P.sftkProgEta({ mode: 'count', startedAt: 0, done: 2, total: 100 }, 5000)).toBeNull();
    expect(P.sftkProgEta({ mode: 'count', startedAt: 0, done: 2, total: 100, lastMs: 30000 }, 5000)).toBe(25);
    expect(P.sftkProgEta({ mode: 'count', startedAt: 0, done: 10, total: 100 }, 1000)).toBeNull();
  });
  it('the rate so far: 10 of 100 in 5 s → 45 s left', () => {
    expect(P.sftkProgEta({ mode: 'count', startedAt: 0, done: 10, total: 100 }, 5000)).toBe(45);
  });
  it('a warm cache: the rate counts only what THIS run settled', () => {
    // 50 came from the cache, 10 settled in 5 s → 0.5 s each, 40 left → 20 s (not 5/60*40)
    expect(P.sftkProgEta({ mode: 'count', startedAt: 0, done: 60, base: 50, total: 100 }, 5000)).toBe(20);
  });
  it('done is 0 left', () => { expect(P.sftkProgEta({ mode: 'count', startedAt: 0, done: 100, total: 100 }, 9000)).toBe(0); });
});

describe('sftkProgEta — open', () => {
  it('only the memory of last time here', () => {
    expect(P.sftkProgEta({ mode: 'open', startedAt: 0 }, 5000)).toBeNull();
    expect(P.sftkProgEta({ mode: 'open', startedAt: 0, lastMs: 12000 }, 5000)).toBe(7);
    expect(P.sftkProgEta({ mode: 'open', startedAt: 0, lastMs: 12000 }, 20000)).toBe(1);   // never "0 left" while it still runs
  });
});

describe('sftkProgLine', () => {
  it('steps: the step, the leg, the estimate', () => {
    const legs = [{ label: 'the flows', weight: 2 }, { label: 'flow definitions', weight: 2 }, { label: 'access', weight: 3 }];
    expect(P.sftkProgLine({ mode: 'steps', legs, idx: 0, doneW: 0, doneMs: 0, legAt: 0, startedAt: 0 }, 1000)).toBe('Step 1 of 3 · the flows · estimating…');
    expect(P.sftkProgLine({ mode: 'steps', legs, idx: 2, doneW: 4, doneMs: 4000, legAt: 4000, startedAt: 0 }, 4000)).toBe('Step 3 of 3 · access · about 3 s left');
  });
  it('count: N of M, the unit, the time left, what was found', () => {
    expect(P.sftkProgLine({ mode: 'count', startedAt: 0, done: 10, total: 1500, unit: 'flow versions' }, 5000)).toBe('10 of 1,500 flow versions · about 12 min left');
    expect(P.sftkProgLine({ mode: 'count', startedAt: 0, done: 1, total: 20, unit: 'pages', found: 3, foundWord: 'places' }, 4000)).toBe('1 of 20 pages · 4 s so far · 3 places so far');
  });
  it('open: the seconds so far, then last time’s duration', () => {
    expect(P.sftkProgLine({ mode: 'open', startedAt: 0 }, 1000)).toBe('estimating…');
    expect(P.sftkProgLine({ mode: 'open', startedAt: 0 }, 7000)).toBe('7 s so far');
    expect(P.sftkProgLine({ mode: 'open', startedAt: 0, lastMs: 48000 }, 7000)).toBe('about 41 s left · last time 48 s here');
  });
});

describe('the widget and its wiring (pins)', () => {
  it('sftk-progress.js: the DOM part, a base for a warm cache, the duration memory per key and org', () => {
    expect(SRC).toMatch(/window\.sftkProgress = function \(mount, opts\)/);
    expect(SRC).toMatch(/base: opts\.done \|\| 0/);
    expect(SRC).toMatch(/const STORE = 'sftkProgDur'/);
    expect(SRC).toMatch(/sftk-prog-stop"/);
    expect(SRC).toMatch(/data-mode/);
  });
  it('popup.html loads it right after the cat helper', () => {
    expect(HTML).toMatch(/debug-logger\.js"><\/script>\s*<script src="sftk-progress\.js">/);
  });
  it('popup.js: the Flows list, the Dependencies tab (with Stop) and the scan strip’s time left', () => {
    expect(POP).toMatch(/flowsProg = window\.sftkProgress \? sftkProgress\(document\.getElementById\('loadingState'\), \{ what: 'Reading every flow of this org…', key: 'flows'/);
    expect(POP).toMatch(/_depScanProg = sftkProgress\(container, \{ what: 'Building the dependency map[^']*', *\n?\s*key: 'depscan', orgUrl, total: st\.total, done: st\.done, unit: 'flow versions', onStop: \(\) => DependencyMap\.cancelScan\(\) \}\)/);
    expect(POP).toMatch(/showScanProgress\(true, `🔍 Building dependency map · \$\{sftkProgLine\(scanEta\)\}`, stop\)/);
    expect(POP).toMatch(/base: st0\.done/);
    expect(POP).not.toMatch(/depScanLive/);
  });
  it('dependency-map.js: the scan fallback, the versions read says its page, Switches and API versions count pages', () => {
    expect(DEP).toMatch(/async function depFlowVersions\(orgUrl, sid, onPage\)/);
    expect(DEP).toMatch(/if \(onPage\) onPage\(0, pages\);/);
    expect(DEP).toMatch(/if \(onPage\) onPage\(i \/ 100 \+ 1, pages\);/);
    expect(DEP).toMatch(/key: 'switches'/);
    expect(DEP).toMatch(/key: 'apiver'/);
    expect(DEP).toMatch(/fallbackProg = sftkProgress\(depContainer, \{[^}]*key: 'depscan'/);
    expect(DEP).not.toMatch(/Scanning flow metadata…/);
    expect(DEP).toMatch(/if \(wid\) \{ if \(okRun && !_avCancel\) wid\.done\(\); else wid\.fail\(\); \}/);
  });
  it('Lightning Pages, Flow Access (steps), Copy Permissions (steps)', () => {
    expect(LP).toMatch(/key: 'lpages'/);
    expect(FP).toMatch(/key: 'flowaccess'/);
    expect(FP).toMatch(/prog\.step\('defs'\)/); expect(FP).toMatch(/prog\.step\('access'\)/);
    expect(UC).toMatch(/key: 'usercopy'/);
    for (const k of ['psg', 'locale', 'groups', 'perms']) expect(UC).toMatch(new RegExp(`prog\\.step\\('${k}'\\)`));
  });
  it('styles: the three bar shapes', () => {
    expect(CSS).toMatch(/\.sftk-prog-seg\.now \{[^}]*animation: fcScanPulse/);
    expect(CSS).toMatch(/\.sftk-prog-fill \{[^}]*transition: width/);
    expect(CSS).toMatch(/\.sftk-prog-sweep \{[^}]*animation: sftkProgSweep/);
  });
});

describe('Flows › Versions: a tree is a card (pins)', () => {
  it('the list is cut into tree blocks in the list’s own order; the card has tick-all, badge, hint, twigs', () => {
    expect(POP).toMatch(/sftkFlowTreeBlocks\(sftkFlowTreeOrder\(rows, calls, rank\)\)/);
    expect(POP).toMatch(/blocks\.sort\(\(a, b\) => a\.rows\[0\]\.row\.label\.localeCompare\(b\.rows\[0\]\.row\.label\)\)/);
    expect(POP).toMatch(/function buildTreeBox\(bk, depMap\)/);
    expect(POP).toMatch(/' tick the whole tree'/);
    expect(POP).toMatch(/`🌳 tree · \$\{n\} flows/);
    expect(POP).toMatch(/twig\.className = 'dep-fb-twig'/);
    expect(POP).toMatch(/if \(subNames\.length && !o\.inTree\)/);
    expect(POP).toMatch(/function updateTreeAllBoxes\(\)/);
    expect(CSS).toMatch(/\.flow-treebox \{ margin: 6px 8px; border: 1px solid var\(--brand\)/);
    expect(CSS).toMatch(/\.flow-treebox \.flow-group-header \{ padding-left: calc\(10px \+ var\(--fb-depth, 0\) \* 20px\); \}/);
  });
});
