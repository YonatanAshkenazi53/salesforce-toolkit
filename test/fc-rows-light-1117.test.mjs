// owner 2026-11-17: "some components are missing the setup ridrection" · "we need to make sure they all have it and
// that it looks in order" · "its a mess right now" · "can we improve the ui? make it easier to understand and lighter"
// — every row ends with ↗ Setup; one column per action, the same on every row; buttons without a box; the button says
// Delete (the kind is the group's title, and stays in the button's text for a screen reader and the scripts).
// Live: scripts/dev/live/fc-rows-shot.mjs on npc2 — 30 rows, each ends with ↗ Setup.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const FC = read('field-cleaner.js'), CSS = read('styles.css');

describe('↗ Setup on every row', () => {
  it('a row with an action, a row without one and a flow card all draw it — never behind a condition', () => {
    expect(FC.split('class="btn btn-sm fc-setup-btn"').length - 1).toBe(3);
    expect(FC).not.toMatch(/canDel \? `<button class="btn btn-sm fc-setup-btn"/);
    expect(FC).toContain(`data-type="\${c.pb ? 'ProcessBuilder' : 'Flow'}" title="Open this kind in Salesforce Setup, in a new tab">↗ Setup</button>`);
  });
  it('every kind a row can be of opens its own Setup page', () => {
    const paths = FC.slice(FC.indexOf('function openSetup(type) {'), FC.indexOf('// ── Delete field ──'));
    const cfg = FC.slice(FC.indexOf('const TYPE_CFG = {'), FC.indexOf('const TYPE_CFG_DEFAULT'));
    const kinds = [...cfg.matchAll(/^    ([A-Za-z0-9]+):\s*\{/gm)].map(m => m[1]).filter(k => k !== 'AskNamed');
    expect(kinds.length).toBeGreaterThan(35);
    const keys = new Set(paths.split(/\r?\n/).map(l => (l.trim().match(/^([A-Za-z0-9]+):/) || [])[1]).filter(Boolean));
    for (const k of kinds) expect(keys.has(k), k).toBe(true);
  });
});

describe('the row, lighter', () => {
  it('one column per action: ⇄ Replace, ✂ Remove, 🗑 Delete, 🔍, ↗ Setup', () => {
    expect(CSS).toContain('.fc-item:not(.fc-flow-card) > .fc-item-btns { display: grid; grid-template-columns: 84px 84px 74px 30px 66px;');
    expect(CSS).toContain('.fc-item:not(.fc-flow-card) > .fc-item-btns .fc-fix-btn[data-swap="1"] { grid-column: 1; }');
    expect(CSS).toContain('.fc-item:not(.fc-flow-card) > .fc-item-btns .fc-del-btn { grid-column: 3; }');
    expect(CSS).toContain('.fc-item:not(.fc-flow-card) > .fc-item-btns .fc-inspect-btn { grid-column: 4; }');
    expect(CSS).toContain('.fc-item:not(.fc-flow-card) > .fc-item-btns .fc-setup-btn { grid-column: 5; }');
  });
  it('the button says Delete; what it deletes stays in its text and its label', () => {
    expect(FC).toContain('aria-label="Delete ${esc(spec.what)}">🗑 Delete<span class="fc-del-what"> ${esc(spec.what)}</span></button>');
    expect(CSS).toContain('.fc-item:not(.fc-flow-card) .fc-del-what { display: none; }');
  });
  it('a ✂ that is not possible is said once, by the note under the row', () => {
    expect(CSS).toContain('.fc-item:not(.fc-flow-card) > .fc-item-btns .fc-pre-no { visibility: hidden; }');
  });
});
