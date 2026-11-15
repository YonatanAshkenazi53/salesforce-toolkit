// Regressions of release QA 1.1 (f0334a0), css area — 2026-11-15.
//  1. Toolkit topbar: with a tool open (Home, the org chip, History in the
//     action row) the brand box collapsed to 0 px, the 28px logo overflowed it
//     and the What's New button was laid out on top of the logo.
//  2. The 1114 CSS tests compared declarations as text; the one on .app-brand
//     pinned `min-width: 0`, i.e. the defect itself.
//
// WHY a solver and not a browser: npm test has no layout engine (no jsdom
// layout, and a headless Chrome run is not part of the gate). So this file
// RUNS the CSS flexbox "resolve flexible lengths" algorithm (css-flexbox-1
// §9.7, the shrink branch with min-width clamping and the freeze loop) on the
// values the real styles.css cascades to for the topbar row. The sheet
// supplies every declared value (padding, gap, margin, floor, shrink factor,
// logo size); only the two TEXT widths are inputs, because text cannot be
// measured here. They are the widths the independent review measured in
// Chrome: the brand name 195 px; the action row 500 px on the home page,
// 758 px with a tool open and 850 px with the tool's History button too.
// The solver is checked against those same Chrome measurements first (the
// f0334a0 floor gives the reviewer's 0 / 9 / 24 px brand and What's New at
// x = 36 / 45 / 60), so a pass below is a statement about layout, not text.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// ── the cascade, as far as the topbar needs it ─────────────────────────────
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const _seen = new Map();   // the sheet is 7,000+ lines and the sweep below asks thousands of times
function last(sel, prop) {
  const k = sel + '|' + prop;
  if (!_seen.has(k)) _seen.set(k, lastUncached(sel, prop));
  return _seen.get(k);
}
function lastUncached(sel, prop) {
  let v;
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(CSS))) {
    if (!m[1].split(',').map(s => s.trim()).includes(sel)) continue;
    const d = m[2].match(new RegExp(`(?:^|;)\\s*${esc(prop)}\\s*:\\s*([^;]+)`));
    if (d) v = d[1].trim();
  }
  return v;
}
const px = (v) => {
  for (let i = 0; i < 5 && v; i++) {
    const m = /^var\((--[\w-]+)\)$/.exec(v);
    if (!m) break;
    v = last(':root', m[1]);
  }
  if (v === '0') return 0;
  const n = /^(-?[\d.]+)px$/.exec(v || '');
  if (!n) throw new Error('not a px length: ' + v);
  return +n[1];
};
// `flex: G S B` → the shrink factor; no flex declaration → the initial 1.
const shrinkOf = (sel) => {
  const own = last(sel, 'flex-shrink');
  if (own != null) return +own;
  const f = last(sel, 'flex');
  if (f == null) return 1;
  if (f === 'none') return 0;
  const parts = f.split(/\s+/);
  return parts.length > 1 && /^[\d.]+$/.test(parts[1]) ? +parts[1] : 1;
};

// ── css-flexbox-1 §9.7, shrinking only (nothing in this row grows) ─────────
// items: [{ base, shrink, min }] → used main sizes.
function resolveFlexLine(items, available) {
  if (items.reduce((s, it) => s + it.base, 0) <= available) return items.map(it => Math.max(it.base, it.min));
  const size = items.map(it => Math.max(it.base, it.min));
  const frozen = items.map(it => it.shrink === 0 || it.base <= it.min);
  for (let guard = 0; guard <= items.length; guard++) {
    if (frozen.every(Boolean)) break;
    const free = available - items.reduce((s, it, i) => s + (frozen[i] ? size[i] : it.base), 0);
    const scaled = items.reduce((s, it, i) => s + (frozen[i] ? 0 : it.shrink * it.base), 0);
    const clamped = [];
    items.forEach((it, i) => {
      if (frozen[i]) return;
      const want = it.base + (scaled ? free * (it.shrink * it.base) / scaled : 0);
      size[i] = Math.max(want, it.min);
      if (size[i] > want) clamped.push(i);
    });
    if (!clamped.length) break;                      // nobody hit a floor: done
    clamped.forEach(i => { frozen[i] = true; });     // freeze the min violations, share the rest again
  }
  return size;
}

// ── the topbar row, from the sheet ─────────────────────────────────────────
// brandFloor is a parameter so the f0334a0 value can be replayed; everything
// else is read from styles.css as it is now.
function topbar({ width, nameText, actionsText, brandFloor }) {
  const padL = px(last('.app-topbar', 'padding').split(/\s+/)[1]);
  const logo = px(last('.app-logo', 'width'));
  const gap = px(last('.app-brand', 'gap'));
  const marginR = px(last('.app-brand', 'margin-right'));
  const logoShrinks = shrinkOf('.app-logo') !== 0;
  // The name is the brand's only shrinkable child: it may go to 0 only when
  // it clips (min-width 0 + a non-visible overflow); otherwise it keeps its text.
  const nameClips = last('.app-brand-name', 'min-width') === '0' && last('.app-brand-name', 'overflow') === 'hidden';
  // .app-topbar-actions: no min-width in the sheet → auto → its (nowrap) content.
  const actMin = last('.app-topbar-actions', 'min-width');
  const [brand, actions] = resolveFlexLine([
    { base: logo + gap + nameText, shrink: shrinkOf('.app-brand'), min: brandFloor },
    { base: actionsText, shrink: shrinkOf('.app-topbar-actions'), min: actMin == null ? actionsText : px(actMin) },
  ], width - 2 * padL - marginR);
  const name = nameClips ? Math.min(nameText, Math.max(0, brand - logo - gap)) : nameText;
  return {
    brand, name,
    logoLeft: padL, logoRight: padL + (logoShrinks ? Math.min(logo, brand) : logo),
    firstActionLeft: padL + brand + marginR,
    actionsRight: padL + brand + marginR + actions,
  };
}
const NAME = 195, HOME = 500, TOOL = 758, TOOL_HISTORY = 850;
const floorNow = () => px(last('.app-brand', 'min-width'));

describe('the solver reproduces what Chrome measured at f0334a0 (brand floor 0)', () => {
  const at = (width, actionsText) => topbar({ width, nameText: NAME, actionsText, brandFloor: 0 });
  it('viewport 774, tool open: brand 0 px, the first button at x 36 — 16 px on top of the logo', () => {
    const r = at(774, TOOL);
    expect(r.brand).toBe(0);
    expect(r.firstActionLeft).toBe(36);
    expect(r.logoRight - r.firstActionLeft).toBe(16);
    expect(r.name).toBe(0);
  });
  it('viewport 827, tool open: brand 9 px, the first button at x 45', () => {
    const r = at(827, TOOL);
    expect(r.brand).toBe(9);
    expect(r.firstActionLeft).toBe(45);
  });
  it('viewport 827 / 934 with History: brand 0 / 24 px, the first button at x 36 / 60', () => {
    expect(at(827, TOOL_HISTORY).firstActionLeft).toBe(36);
    expect(at(934, TOOL_HISTORY).brand).toBe(24);
    expect(at(934, TOOL_HISTORY).firstActionLeft).toBe(60);
  });
  it('viewport 934, tool open, no History: the name is 76 px', () => {
    expect(at(934, TOOL).name).toBe(76);
  });
});

describe('Toolkit topbar with a tool open: the logo keeps its box (2026-11-15)', () => {
  const at = (width, actionsText) => topbar({ width, nameText: NAME, actionsText, brandFloor: floorNow() });

  it('no action button is laid out over the logo, at any width from 600 to 1366 px', () => {
    for (const actionsText of [HOME, TOOL, TOOL_HISTORY, 950]) {
      for (let width = 600; width <= 1366; width += 1) {
        const r = at(width, actionsText);
        if (r.firstActionLeft < r.logoRight || r.logoRight - r.logoLeft < 28) {
          throw new Error(`overlap at ${width}px / actions ${actionsText}px: logo ${r.logoLeft}-${r.logoRight}, first action at ${r.firstActionLeft}`);
        }
      }
    }
  });

  it('the widths the review named: 774, 827 and 934 px, with and without History', () => {
    for (const [width, actionsText] of [[774, TOOL], [827, TOOL], [827, TOOL_HISTORY], [934, TOOL_HISTORY]]) {
      const r = at(width, actionsText);
      expect(r.brand).toBeGreaterThanOrEqual(28);
      expect(r.firstActionLeft - r.logoRight).toBeGreaterThanOrEqual(12);   // the brand's own margin survives
    }
  });

  it('the name is what gives way: cut to what is left of the brand, never wider than its text', () => {
    expect(at(774, TOOL).name).toBe(0);
    expect(at(934, TOOL).name).toBe(76);
    expect(at(1366, TOOL_HISTORY).name).toBe(NAME);
  });

  it('home page (no tool open): the name is unchanged — 180 px at 780, whole at 853', () => {
    expect(at(780, HOME).name).toBe(180);
    expect(at(853, HOME).name).toBe(NAME);
    expect(at(853, HOME).actionsRight).toBeLessThanOrEqual(853 - 24);
  });

  it('the brand still shrinks before the bar grows: a one-line name, never a taller bar', () => {
    // The 1114 defect this must not bring back: a brand that cannot shrink.
    const r = at(853, TOOL);
    expect(r.brand).toBeLessThan(28 + 12 + NAME);
    expect(last('.app-brand-name', 'white-space')).toBe('nowrap');
  });
});
