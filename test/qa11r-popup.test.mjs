// QA 1.1 regression run, the popup lane: findings #19 and #22 of docs/qa/qa-1.1-regression-result.json.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const PJ = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const { sftkFlowKindSearchEmpty: emptyLine, sftkDepsFoldRedrawOnReturn: redraw } =
  extractFunctions('popup.js', ['sftkFlowKindSearchEmpty', 'sftkDepsFoldRedrawOnReturn']);
const body = (name) => { const i = PJ.indexOf(`function ${name}(`); return PJ.slice(i, PJ.indexOf('\n}', i)); };

describe('#19 a search under a kind tab that matches flows of other kinds only', () => {
  it('says the kind has no match, how many flows of other kinds match, and where they are', () => {
    expect(emptyLine('account', 3)).toBe('No flow of this kind matches “account”. 3 flows of other kinds do: see the All tab.');
    expect(emptyLine('account', 1)).toBe('No flow of this kind matches “account”. 1 flow of other kinds does: see the All tab.');
    expect(emptyLine('a', 1200)).toContain('1,200 flows of other kinds do');
    expect(emptyLine(null, 2)).toContain('matches “”.');
  });
  it('the list uses it only with a search, a kind tab and a match elsewhere; the other two sentences stay', () => {
    const fn = body('renderFlowList');
    expect(fn).toContain("if (visibleCount === 0 && sortedLabels.length > 0 && search && _flowTypeFilter !== 'all') {");
    expect(fn).toContain('const others = rows.filter(hit).length;');
    expect(fn).toContain("if (others) emptyState.textContent = sftkFlowKindSearchEmpty(document.getElementById('searchInput').value.trim(), others);");
    // a name no flow of any kind carries still reads as before, and so does a kind tab with no search
    expect(fn).toContain('emptyState.textContent = `No flow name or API name matches');
    expect(fn).toContain("emptyState.textContent = 'No flow of this kind in the org.';");
    // the new sentence is written after the other two
    expect(fn.indexOf('sftkFlowKindSearchEmpty(')).toBeGreaterThan(fn.indexOf("'No flow of this kind in the org.'"));
  });
});

describe('#22 the dependency fold after a scan or reload that ended under another view', () => {
  it('a redraw skipped while Switches or API versions shows is owed', () => {
    const fn = body('_depsFoldOpen');
    expect(fn).toContain("if (d && d.open && _flowView !== 'versions') _depsFoldOwed = true;");
    expect(fn).toContain("return !!(d && d.open && _flowView === 'versions');");
    expect(PJ).toContain('let _depsFoldOwed = false;');
  });
  it('the open fold is redrawn on the way back only when a redraw is owed', () => {
    expect(redraw(true, true)).toBe(true);
    expect(redraw(true, false)).toBe(false);    // nothing happened meanwhile: the tree is left as the user had it
    expect(redraw(false, true)).toBe(false);    // a closed fold draws itself when it is opened
    expect(redraw(undefined, undefined)).toBe(false);
  });
  it('setFlowView pays the debt on a plain return to Flows and clears it', () => {
    const fn = body('setFlowView');
    expect(fn).toContain('const owed = _depsFoldOwed;');
    expect(fn).toContain('_depsFoldOwed = false;');
    expect(fn).toContain('} else if (fold && sftkDepsFoldRedrawOnReturn(fold.open, owed)) renderDependenciesTab();');
    // the view is already the Flows view when the redraw runs, so it sees the scan and the org as they are now
    expect(fn.indexOf('_flowView = v;')).toBeLessThan(fn.indexOf('sftkDepsFoldRedrawOnReturn('));
    // a link to the old Dependencies view still opens the fold and draws it
    expect(fn).toContain('if (fold) { fold.open = true; renderDependenciesTab();');
  });
  it('the mechanism, run: a scan that ends under Switches leaves a debt that the return pays once', () => {
    const make = new Function(`
      let _flowView = 'versions', _depsFoldOwed = false, drawn = 0;
      const foldEl = { open: true };
      const document = { getElementById: () => foldEl };
      ${body('_depsFoldOpen')}\n}
      ${body('sftkDepsFoldRedrawOnReturn')}\n}
      const back = () => { _flowView = 'versions'; const owed = _depsFoldOwed; _depsFoldOwed = false; if (sftkDepsFoldRedrawOnReturn(foldEl.open, owed)) drawn++; };
      return { go: v => { _flowView = v; }, scanEnds: () => { if (_depsFoldOpen()) drawn++; }, back, drawn: () => drawn };
    `);
    const p = make();
    p.scanEnds(); expect(p.drawn()).toBe(1);         // on the Flows view: drawn at once
    p.go('switches'); p.back(); expect(p.drawn()).toBe(1);   // nothing ended meanwhile: no redraw
    p.go('switches'); p.scanEnds(); expect(p.drawn()).toBe(1);
    p.back(); expect(p.drawn()).toBe(2);
    p.go('apiver'); p.back(); expect(p.drawn()).toBe(2);     // paid once
  });
});
