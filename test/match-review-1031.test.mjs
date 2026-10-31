// 2026-10-31 — Match review, redrawn (user: "how can we take this thing and make it better? and
// more easy to understand? ui and functionality" / "how do we calculate the matching here? show
// it to the user"): the % is the best of three ways of being alike and says so; both records
// open; a pair made here can be taken back; the words say what a pair does.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const M = read('sftk-matching.js'), R = read('studio-reconcile.js'), CSS = read('studio.css');
const slice = (src, name) => { const i = src.indexOf(`function ${name}(`); const j = src.indexOf('\nfunction ', i + 10); return src.slice(i, j > 0 ? j : undefined); };
const F = new Function(`${slice(M, 'sftkPairSimilarityParts')}\n${slice(M, 'sftkPairSimilarity')}\nreturn { sftkPairSimilarityParts, sftkPairSimilarity };`)();
const SEP = String.fromCharCode(1);

describe('sftkPairSimilarityParts: three ways of being alike, the best one counts', () => {
  it('the same text is 100% on every measure', () => {
    expect(F.sftkPairSimilarityParts('acme', 'acme')).toEqual({ score: 1, prefix: 1, bigrams: 1, words: 1 });
  });
  it('a changed ending keeps most of its letter pairs (a typo still ranks high)', () => {
    const p = F.sftkPairSimilarityParts('sftk cx europe gmbh', 'sftk cx europe gmhb');
    expect(p.bigrams).toBeGreaterThan(0.8);
    expect(p.score).toBeGreaterThanOrEqual(p.prefix);
  });
  it('reordered words score through the word measure, not the start', () => {
    const p = F.sftkPairSimilarityParts('household rodriguez', 'rodriguez household');
    expect(p.prefix).toBe(0);
    expect(p.words).toBe(1);
    expect(p.score).toBe(1);
  });
  it('nothing in common is 0', () => {
    expect(F.sftkPairSimilarity('rodriguez household', 'sforce')).toBe(0);
  });
  it('components: the mean over the key parts, a prefix credit as before', () => {
    expect(F.sftkPairSimilarity(`acme${SEP}levy`, `acme${SEP}levi`)).toBeCloseTo((1 + 0.75) / 2);
  });
});

describe('the dialog', () => {
  const d = R.slice(R.indexOf('function openMatchReview(p) {'), R.indexOf('// Execute the selected reconcile actions.'));
  it('says what a pair does, in the title and the intro, and explains the %', () => {
    expect(d).toContain('🔗 Pair records by hand — ${esc(obj)}<span class="ds-dc-modal-sub">the same record under a different name in each org</span>');
    expect(d).toContain('the record then shows under 🟡 Changed or 🟢 Synced instead of 🔴 Insert.</p>');
    expect(d).toContain('<details class="ds-mm-how"><summary>How the % is measured</summary>');
    expect(d).toContain("The % only orders the list — nothing is paired without your click.");
  });
  it('every candidate carries a bar, the %, a word, why, an open link and Pair; the rest fold behind "Show the other N"', () => {
    expect(d).toContain("const word = s => s >= 0.8 ? 'very alike' : s >= 0.5 ? 'alike' : s > 0 ? 'a little alike' : 'nothing in common';");
    expect(d).toContain('title="How alike the two names are — the best of: shares the start ${pct(c.parts.prefix)}% · letter pairs in common ${pct(c.parts.bigrams)}% · words in common ${pct(c.parts.words)}%.');
    expect(d).toContain('<span class="ds-mm-bar"><span style="width:${pct(c.sim)}%"></span></span><b>${pct(c.sim)}%</b>');
    expect(d).toContain('data-mm-pair="${esc(c.r.targetId)}"');
    expect(d).toContain('data-mm-more="1">Show the other ${ranked.length - shown.length}</button>');
    expect(d).toContain('href="${url(p.targetOrg, c.r.targetId)}"');
    expect(d).toContain('href="${url(p.sourceOrg, r.sourceId)}"');
  });
  it('a pair made here is listed and can be taken back: memory forgotten, both rows back in their lists', () => {
    expect(d).toContain('madeHere.push({ srcRow, tgtRow });');
    expect(d).toContain('data-mm-unpair="${i}"');
    expect(d).toContain('await window.sftkForgetPairs?.(p.id, p.targetOrg, [m.srcRow.sourceId]);');
    expect(d).toContain('(scan.missingInTarget = scan.missingInTarget || []).push(m.srcRow);');
    expect(d).toContain('(scan.onlyInTarget = scan.onlyInTarget || []).push(m.tgtRow);');
  });
  it('the truncated-scan note is kept, and no inline styles remain', () => {
    expect(d).toContain('has NOT been ruled out as a match');
    expect(d).not.toMatch(/style="padding:5px 8px/);
    for (const cls of ['.ds-mm-grid', '.ds-mm-col', '.ds-mm-src.ds-mm-on', '.ds-mm-bar > span', '.ds-mm-made']) expect(CSS).toContain(cls);
  });
});
