// Deploy Readiness — keyboard-operable result cards.
//
// The bug these tests exist for: both result-card render sites emitted a
// click-only <div class="dr-obj-card-hdr"> with no tabindex, no role and no
// aria-expanded, and both wiring sites bound click only — so the collapsed
// warn/clean/unknown cards (only critical/error default-open) could never be
// opened by keyboard. The fix keeps the header a div (a real <button> would
// drag in UA styles the CSS never resets) and hand-keeps the button
// contract: role="button", tabindex="0", Enter+Space activation, and
// aria-expanded tracking the open class. drWireObjCardHeaders is the ONE
// shared wiring path for fresh runs and cache restores.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction } from './extract.mjs';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'studio-readiness.js'), 'utf8');

const drWireObjCardHeaders = extractFunction('studio-readiness.js', 'drWireObjCardHeaders');

// ── Minimal element stand-ins (npm test has no DOM harness) ─────
function stubCard(open) {
  const classes = new Set(['dr-obj-card']);
  if (open) classes.add('dr-obj-card-open');
  return {
    classList: {
      contains: c => classes.has(c),
      toggle:   c => { if (classes.has(c)) classes.delete(c); else classes.add(c); },
    },
    isOpen: () => classes.has('dr-obj-card-open'),
  };
}

function stubHdr(card, attrs) {
  const listeners = {};
  return {
    attrs: Object.assign({}, attrs || {}),
    setAttribute(name, value) { this.attrs[name] = value; },
    closest(sel) { return sel === '.dr-obj-card' ? card : null; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type, ev) { (listeners[type] || []).forEach(fn => fn(ev)); },
    listenerTypes: () => Object.keys(listeners),
  };
}

const stubRoot = hdrs => ({
  querySelectorAll: sel => (sel === '.dr-obj-card-hdr' ? hdrs : []),
});

const keyEvent = key => ({
  key,
  defaultPrevented: false,
  preventDefault() { this.defaultPrevented = true; },
});

describe('drWireObjCardHeaders — keyboard + click behaviour', () => {
  it('binds BOTH click and keydown on every header', () => {
    const hdr = stubHdr(stubCard(false));
    drWireObjCardHeaders(stubRoot([hdr]));
    expect(hdr.listenerTypes()).toContain('click');
    expect(hdr.listenerTypes()).toContain('keydown');
  });

  it('re-syncs aria-expanded to the open class at wire time (cached innerHTML can be stale either way)', () => {
    const openHdr   = stubHdr(stubCard(true),  { 'aria-expanded': 'false' });
    const closedHdr = stubHdr(stubCard(false), { 'aria-expanded': 'true' });
    drWireObjCardHeaders(stubRoot([openHdr, closedHdr]));
    expect(openHdr.attrs['aria-expanded']).toBe('true');
    expect(closedHdr.attrs['aria-expanded']).toBe('false');
  });

  it('click toggles the open class and aria-expanded together', () => {
    const card = stubCard(false);
    const hdr  = stubHdr(card);
    drWireObjCardHeaders(stubRoot([hdr]));
    hdr.fire('click', {});
    expect(card.isOpen()).toBe(true);
    expect(hdr.attrs['aria-expanded']).toBe('true');
    hdr.fire('click', {});
    expect(card.isOpen()).toBe(false);
    expect(hdr.attrs['aria-expanded']).toBe('false');
  });

  it('Enter opens a collapsed card and consumes the event', () => {
    const card = stubCard(false);
    const hdr  = stubHdr(card);
    drWireObjCardHeaders(stubRoot([hdr]));
    const ev = keyEvent('Enter');
    hdr.fire('keydown', ev);
    expect(card.isOpen()).toBe(true);
    expect(hdr.attrs['aria-expanded']).toBe('true');
    expect(ev.defaultPrevented).toBe(true);
  });

  it('Space toggles and prevents default so the results pane does not scroll', () => {
    const card = stubCard(true);
    const hdr  = stubHdr(card);
    drWireObjCardHeaders(stubRoot([hdr]));
    const ev = keyEvent(' ');
    hdr.fire('keydown', ev);
    expect(card.isOpen()).toBe(false);
    expect(hdr.attrs['aria-expanded']).toBe('false');
    expect(ev.defaultPrevented).toBe(true);
  });

  it('other keys neither toggle nor swallow the event (Tab must keep moving focus)', () => {
    const card = stubCard(false);
    const hdr  = stubHdr(card);
    drWireObjCardHeaders(stubRoot([hdr]));
    for (const key of ['Tab', 'Escape', 'ArrowDown', 'a']) {
      const ev = keyEvent(key);
      hdr.fire('keydown', ev);
      expect(card.isOpen()).toBe(false);
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(hdr.attrs['aria-expanded']).toBe('false');
  });

  it('null root and a header outside any card are safe no-ops', () => {
    expect(() => drWireObjCardHeaders(null)).not.toThrow();
    const orphan = stubHdr(null);
    expect(() => drWireObjCardHeaders(stubRoot([orphan]))).not.toThrow();
    expect(orphan.listenerTypes()).toEqual([]);
  });
});

describe('studio-readiness.js — render + wiring source contract', () => {
  it('every rendered header carries role="button", tabindex="0" and aria-expanded', () => {
    const emissions = [...src.matchAll(/class="dr-obj-card-hdr[^"]*"([^>]*)>/g)];
    // Two render sites: the org-settings panel and the per-object card.
    expect(emissions.length).toBe(2);
    for (const [, rest] of emissions) {
      expect(rest).toContain('role="button"');
      expect(rest).toContain('tabindex="0"');
      expect(rest).toContain('aria-expanded');
    }
  });

  it('the org-settings header (always default-open) renders aria-expanded="true"', () => {
    expect(src).toMatch(
      /class="dr-obj-card-hdr" role="button" tabindex="0" aria-expanded="true"/);
  });

  it('the object-card header mirrors its default-open state into aria-expanded', () => {
    expect(src).toMatch(
      /aria-expanded="\$\{isDefaultOpen \? 'true' : 'false'\}"/);
  });

  it('fresh-run and cache-restore paths both go through the shared wiring helper', () => {
    // 1 definition + 2 call sites (runReadinessCheck, drRestoreCachedResults).
    expect((src.match(/drWireObjCardHeaders\(/g) || []).length).toBe(3);
    // The only header query lives inside the helper — no click-only stragglers.
    expect((src.match(/querySelectorAll\('\.dr-obj-card-hdr'\)/g) || []).length).toBe(1);
  });
});
