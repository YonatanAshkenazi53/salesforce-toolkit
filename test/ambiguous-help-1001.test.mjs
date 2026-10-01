// ⚠ Ambiguous — the tab explains itself (user 2026-10-01: "what these means?
// insert as new, pair, etc. the user will have no idea what it means" →
// "we need a better help text"). Pins the intro, the plain labels, and the
// wrapping rows. The data attributes the pin/new handlers read are unchanged.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const DV = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../studio.css', import.meta.url), 'utf8');

describe('⚠ Ambiguous help text', () => {
  it('an intro above the list, only on that tab and only when it has rows', () => {
    expect(DV).toContain("${tabDef.k === 'amb' && rows.length ? _depAmbIntro(p, isRoot) : ''}");
    const i = DV.indexOf('function _depAmbIntro(');
    expect(i).toBeGreaterThan(0);
    const fn = DV.slice(i, DV.indexOf('\n}\n', i));
    expect(fn).toContain('Why these records are here.');
    expect(fn).toContain('Nothing in this list is deployed until you decide');
    expect(fn).toContain('<b>📌 Same as #1</b>');
    expect(fn).toContain('<b>➕ New in ${tgtL}</b>');
    expect(fn).toContain('opens that ${tgtL} record in a new tab');
    expect(fn).toContain('remembered for ${tgtL}');
    // a child object cannot be chosen by hand — the intro says what to do instead
    expect(fn).toContain('second match field (✏ Edit → Records → Matching)');
  });
  it('row labels are plain words, the handlers keep their data attributes', () => {
    expect(DV).toContain('data-dep-amb-pin="${esc(r.sourceId)}|${esc(t)}"');
    expect(DV).toContain('📌 Same as #${i + 1}</button>');
    expect(DV).toContain('data-dep-amb-new="${esc(r.sourceId)}"');
    expect(DV).toContain('➕ New in ${esc(tgtL)}</button>');
    expect(DV).toContain('with this name in ${esc(tgtL)}</span>');
    expect(DV).not.toContain('📌 pair with #');
    expect(DV).not.toContain('➕ insert as new</button>');
    expect(DV).not.toContain('possible in ${esc(orgLabel(p.targetOrg))}');
  });
  it('the advisor note uses the same words as the buttons', () => {
    expect(DV).toContain('📌 which ${esc(orgLabel(p.targetOrg))} record it is the same as, or ➕ that it is new there.');
  });
  it('ambiguous rows wrap their choices instead of overflowing the page', () => {
    expect(DV).toContain("ds-dep-row${tabDef.k === 'amb' ? ' ds-dep-row-amb' : ''}");
    expect(CSS).toMatch(/\.ds-dep-row-amb \.ds-dep-tail \{[^}]*flex-wrap: wrap;[^}]*white-space: normal;/);
  });
});
