// Onboarding tour — keyboard/AT regression guards (backlog: onboarding.js:103).
//
// The QA finding: the tour overlay had no Escape key, never moved focus into
// the card, and had no focus trap — a keyboard user had to Tab through the
// entire obscured application shell behind the dim wash to reach "Next", and
// could not dismiss the tour at all without a mouse.
//
// These are SOURCE assertions: the extension has no build step and `npm test`
// has no DOM harness. tour() is defined inside the SFTKOnboard IIFE (indented,
// so extract.mjs cannot lift it); each assertion is bounded to the slice of
// onboarding.js it is about so unrelated code can neither satisfy nor break it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(root, 'onboarding.js'), 'utf8');

// Anchor-checked slice: a silently-empty slice would let every assertion pass
// for the wrong reason.
function slice(src, from, to, what) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  expect(a, `${what}: start anchor "${from}" not found`).toBeGreaterThan(-1);
  expect(b, `${what}: end anchor "${to}" not found`).toBeGreaterThan(a);
  return src.slice(a, b);
}

const TOUR    = slice(SRC, 'function tour(steps, onDone)', 'async function firstRun', 'tour()');
const FINISH  = slice(TOUR, 'function finish()', 'function onKeydown', 'finish()');
const KEYDOWN = slice(TOUR, 'function onKeydown(', 'function positionCard', 'onKeydown()');
const RENDER  = slice(TOUR, 'function render()', 'document.addEventListener', 'render()');

describe('tour card is a focusable dialog', () => {
  it('marks the card role=dialog / aria-modal / tabindex=-1', () => {
    expect(TOUR).toContain(`card.setAttribute('role', 'dialog')`);
    expect(TOUR).toContain(`card.setAttribute('aria-modal', 'true')`);
    expect(TOUR).toContain(`card.setAttribute('tabindex', '-1')`);
  });

  it('labels the dialog with the step title on every render', () => {
    expect(RENDER).toMatch(/card\.setAttribute\('aria-label',\s*step\.title/);
  });

  it('moves focus onto the card when a step renders, without stealing it back mid-step', () => {
    // The guard matters: resize re-renders too, and refocusing unconditionally
    // would yank focus the user already placed inside the card.
    expect(RENDER).toMatch(/if\s*\(!card\.contains\(document\.activeElement\)\)/);
    expect(RENDER).toMatch(/card\.focus\(/);
  });

  it('suppresses the focus ring only on the programmatic-focus card, not its buttons', () => {
    expect(SRC).toContain('.sftk-tour-card:focus { outline: none; }');
  });
});

describe('Escape dismisses the tour', () => {
  it('registers a capture-phase document keydown listener when the tour starts', () => {
    expect(TOUR).toContain(`document.addEventListener('keydown', onKeydown, true)`);
  });

  it('routes Escape through finish() — the same path as Skip/Got it', () => {
    expect(KEYDOWN).toMatch(/e\.key === 'Escape'/);
    expect(KEYDOWN).toMatch(/'Escape'[\s\S]*?finish\(\)/);
  });

  it('stops Escape from also firing host-app shortcuts underneath the overlay', () => {
    expect(KEYDOWN).toMatch(/'Escape'[^\n]*\n?[^\n]*e\.stopPropagation\(\)/);
  });
});

describe('Tab is trapped inside the card', () => {
  it('cycles first/last button on Tab and Shift+Tab', () => {
    expect(KEYDOWN).toMatch(/e\.key !== 'Tab'/);
    expect(KEYDOWN).toMatch(/e\.shiftKey/);
    expect(KEYDOWN).toMatch(/first\.focus\(\)/);
    expect(KEYDOWN).toMatch(/last\.focus\(\)/);
    expect(KEYDOWN).toMatch(/e\.preventDefault\(\)/);
  });

  it('pulls focus back into the card if it somehow escaped (e.g. backdrop click)', () => {
    expect(KEYDOWN).toMatch(/card\.contains\(document\.activeElement\)/);
  });

  it('MUST-FIX pin: Shift+Tab from the CARD itself is a trap boundary too', () => {
    // Every step STARTS with focus on the card (render() lands there,
    // tabindex=-1). Without the onCard branch, backward Shift+Tab from that
    // default state walked straight out into the page behind the wash —
    // found by the adversarial review of this batch.
    expect(KEYDOWN).toMatch(/onCard = document\.activeElement === card/);
    expect(KEYDOWN).toMatch(/\|\| onCard \|\|/);
  });
});

describe('finish() cleans up everything the tour registered', () => {
  it('removes the keydown listener with the same capture flag it was added with', () => {
    expect(FINISH).toContain(`document.removeEventListener('keydown', onKeydown, true)`);
  });

  it('still removes the resize listener and the overlay', () => {
    expect(FINISH).toContain(`window.removeEventListener('resize', render)`);
    expect(FINISH).toContain('overlay.remove()');
  });

  it('returns focus to the element that had it before the tour', () => {
    expect(TOUR).toContain('const prevFocus = document.activeElement');
    expect(FINISH).toMatch(/prevFocus\.focus\(\)/);
    // Guarded: the origin element may be gone by the time the tour ends.
    expect(FINISH).toMatch(/document\.contains\(prevFocus\)/);
  });
});

describe('regression guards from the adjacent QA fix', () => {
  it('still omits the Skip button on the last step (no empty focusable button)', () => {
    expect(RENDER).toMatch(/last \? '' : `<button class="sftk-tour-skip">/);
  });
});
