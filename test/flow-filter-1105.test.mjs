// A filter box over the ⏻ Switches and ⚙ API versions lists, and a 🗂 Versions
// search that matches the API name (2026-11-05, a colleague's first day with
// the tool: "paste one flow name from the ticket, tick it, go down a line in
// the ticket, paste the next, tick it too"). The rule worth testing: a ticked
// row the filter hides STAYS ticked, is counted, and is said — nothing is
// switched blind.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const F = extractFunctions('sftk-flowbulk.js', ['sftkFlowFilterNorm', 'sftkFlowFilterKey', 'sftkFlowFilterHit', 'sftkFlowFilterLine']);
const DEP = readFileSync(new URL('../dependency-map.js', import.meta.url), 'utf8');
const POP = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../popup.html', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

describe('the search key and the match', () => {
  it('a row is found by its label, its API name, or a pasted label whose API name was derived from it', () => {
    const key = F.sftkFlowFilterKey('Account Status Update', 'Account_Status_Update');
    expect(F.sftkFlowFilterHit('Account Status Update', key)).toBe(true);
    expect(F.sftkFlowFilterHit('Account_Status_Update', key)).toBe(true);
    expect(F.sftkFlowFilterHit('account status', key)).toBe(true);
    expect(F.sftkFlowFilterHit('status account', key)).toBe(true);       // words in any order
    expect(F.sftkFlowFilterHit('  Account   Status  ', key)).toBe(true);  // pasted with spaces around
    expect(F.sftkFlowFilterHit('Contact', key)).toBe(false);
    expect(F.sftkFlowFilterHit('account status contact', key)).toBe(false);   // every word must be there
  });
  it('an empty or blank term matches everything; a missing label or API name does not break the key', () => {
    expect(F.sftkFlowFilterHit('', 'anything')).toBe(true);
    expect(F.sftkFlowFilterHit('   ', 'anything')).toBe(true);
    expect(F.sftkFlowFilterHit(undefined, 'anything')).toBe(true);
    expect(F.sftkFlowFilterKey(null, 'Only_Api')).toBe('only api');
    expect(F.sftkFlowFilterKey('Only label', undefined)).toBe('only label');
    expect(F.sftkFlowFilterHit('x', undefined)).toBe(false);
  });
});

describe('the line under the box', () => {
  it('says nothing without a term, "N of M shown" with one, and names the ticked rows the filter hides', () => {
    expect(F.sftkFlowFilterLine('', 13, 13, 0)).toBe('');
    expect(F.sftkFlowFilterLine('sftk', 3, 13, 0)).toBe('3 of 13 shown');
    expect(F.sftkFlowFilterLine('sftk', 1, 13, 1)).toBe('1 of 13 shown · 1 ticked flow hidden by the filter — still counted below');
    expect(F.sftkFlowFilterLine('zzz', 0, 13, 2)).toBe('No flow name or API name matches “zzz” · 2 ticked flows hidden by the filter — still counted below');
  });
});

describe('wiring: both panels carry the box, the key on every row, and count hidden ticks', () => {
  it('⏻ Switches and ⚙ API versions draw the box above their list and key each row by label + API name', () => {
    expect(DEP).toContain("${depListFilterRow('switches')}");
    expect(DEP).toContain("${depListFilterRow('apiver')}");
    expect(DEP).toContain('style="--fb-depth:${depth}" data-dep-search="${escHtml(sftkFlowFilterKey(f.label, f.apiName))}">');   // the row carries its depth in the hierarchy (2026-11-08)
    expect(DEP).toContain('data-dep-search="${escHtml(sftkFlowFilterKey(r.label, r.apiName))}"');
  });
  it('a hidden row keeps its tick: the class only hides it, the footers count it and say so', () => {
    expect(CSS).toContain('.dep-list-hid { display: none !important; }');
    expect(DEP).toContain("r.classList.toggle('dep-list-hid', !hit);");
    expect(DEP).toContain("if (hit) n++; else { const cb = r.querySelector(cbSel); if (cb && cb.checked) hiddenTicked++; }");
    expect(DEP).toContain("${hid ? ` \\u00b7 ${hid} hidden by the filter` : ''}");   // ⏻ footer
    expect(DEP).toContain('<span id="depAvCount" class="dep-tool-count">0 selected</span>');   // ⚙ footer, new
  });
  it('the group buttons and "Select the N behind" tick only what the filter shows; ⚙ Update all still means all', () => {
    expect(DEP).toContain("const vis = new Set(fbShown().map(r => r.querySelector('.dep-fb-cb')));");
    expect(DEP).toContain("const mine = cbs.filter(c => vis.has(c) && c.dataset.grp === b.dataset.grp && c.dataset.on === b.dataset.want);");
    expect(DEP).toContain("out.querySelector('#depAvSelDrift')?.addEventListener('click', () => tickFixable(true));");
    expect(DEP).toContain('tickFixable(false);');
  });
  it('Enter with exactly one row left ticks that row; the term survives a repaint', () => {
    expect(DEP).toContain("if (vis.length !== 1) return;");
    expect(DEP).toContain("cb.dispatchEvent(new Event('change', { bubbles: true }));");
    expect(DEP).toContain('const _depListFilterTerm = {};');
    expect(DEP).toContain("value=\"${escHtml(_depListFilterTerm[key] || '')}\"");
  });
  it('a group header says what the filter left of it', () => {
    expect(DEP).toContain('nEl.textContent = sftkFlowFilterNorm(term) && vis !== mine.length ? `${vis} of ${nEl.dataset.n}` : nEl.dataset.n;');
  });
});

describe('🗂 Versions: the search matches the API name too', () => {
  it('the list and Select All use the same key and rule as the panels', () => {
    // the list is cut into tree blocks since 2026-11-08; the same key and rule decide which rows a search keeps
    expect(POP).toContain("const hit = label => !search || sftkFlowFilterHit(search, sftkFlowFilterKey(label, (flowGroups[label][0] || {}).ApiName));");
    expect(POP).toContain("if (search && !sftkFlowFilterHit(search, sftkFlowFilterKey(label, (versions[0] || {}).ApiName))) continue;");
    expect(POP).not.toContain('if (search && !label.toLowerCase().includes(search)) continue;');
    expect(POP).toContain('No flow name or API name matches');
    expect(HTML).toContain('placeholder="🔍 Search flows by name or API name…"');
  });
});
