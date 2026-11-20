// QA 1.1 finding 9: 🎭 inside Fields & mapping must not destroy the mapping window — it is set aside and comes back when the chooser closes.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const B = readFileSync(new URL('../studio-builder.js', import.meta.url), 'utf8');
const { bldPiiParkModal: park, bldPiiUnparkModal: unpark, bldPiiParkedNext: next } =
  extractFunctions('studio-builder.js', ['bldPiiParkModal', 'bldPiiUnparkModal', 'bldPiiParkedNext']);

// the least of a DOM element the two functions use
function el(id, kids = []) {
  const n = {
    id, kids: [...kids], scrollTop: 0, clicks: 0,
    get firstChild() { return n.kids[0] || null; },
    removeChild(c) { n.kids.splice(n.kids.indexOf(c), 1); return c; },
    appendChild(c) { n.kids.push(c); return c; },
    querySelector(sel) {
      const want = sel.replace('#', '');
      for (const k of n.kids) { if (k.id === want) return k; const d = k.querySelector(sel); if (d) return d; }
      return null;
    },
  };
  return n;
}

describe('the mapping window is set aside, not rebuilt', () => {
  it('the very same nodes come back, with what they carried and where the list was scrolled', () => {
    const list = el('dsFmList'); list.scrollTop = 340;
    const save = el('dsFmSave'); save.onApply = () => 'the per-target exceptions reach the node';
    const header = el('hdr'), body = el('body', [list]), footer = el('foot', [save]);
    const box = el('dsModalBox', [header, body, footer]);

    const parked = park(box);
    expect(box.kids).toEqual([]);                     // the box is free for the chooser
    expect(parked.nodes).toEqual([header, body, footer]);
    expect(parked.scroll).toBe(340);

    box.appendChild(el('chooser', [el('dsPiiFieldApply')]));
    list.scrollTop = 0;                               // a detached list loses its scroll
    unpark(box, parked);
    expect(box.kids).toEqual([header, body, footer]); // the chooser is gone, the window is back
    expect(box.kids[2].kids[0]).toBe(save);           // the same Apply button, listeners and closure with it
    expect(box.querySelector('#dsFmSave').onApply()).toBe('the per-target exceptions reach the node');
    expect(box.querySelector('#dsPiiFieldApply')).toBe(null);
    expect(list.scrollTop).toBe(340);
  });
});

describe('what a closing modal means for the window set aside', () => {
  it('nothing is set aside, or the chooser is still open: wait', () => {
    expect(next(false, true, true)).toBe('wait');
    expect(next(true, false, true)).toBe('wait');
  });
  it('the chooser has closed (Apply, Remove, Cancel, ✕ or Escape): the mapping window returns', () => {
    expect(next(true, true, true)).toBe('restore');
  });
  it('another window took the box meanwhile: the copy set aside is let go, never reopened over it', () => {
    expect(next(true, true, false)).toBe('drop');
  });
});

describe('the wiring', () => {
  it('🎭 on a mapping row asks the chooser to return to the mapping window', () => {
    expect(B).toContain('bldOpenPiiFieldModal(ctx.objType, field, { returnToMapping: true });');
  });
  it('the chooser sets the window aside just before it takes the box, and only while the mapping window is the one up', () => {
    const fm = B.slice(B.indexOf('async function bldOpenPiiFieldModal'));
    const at = fm.indexOf('_bldPiiParked = bldPiiParkModal(mbox);');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(fm.indexOf('showModal('));
    expect(fm).toContain("opts.returnToMapping && mbox && movl && movl.style.display !== 'none' && mbox.querySelector('#dsFmList')");
  });
  it('every way of closing is caught: the overlay itself is watched', () => {
    expect(B).toContain('_bldPiiParkObserver = new MutationObserver(bldPiiReturnToMapping);');
    expect(B).toContain("_bldPiiParkObserver.observe(movl, { attributes: true, attributeFilter: ['style'] });");
    const ret = B.slice(B.indexOf('function bldPiiReturnToMapping()'));
    expect(ret).toContain('bldPiiUnparkModal(box, parked);');
    expect(ret).toContain("overlay.style.display = 'flex';");
  });
});
