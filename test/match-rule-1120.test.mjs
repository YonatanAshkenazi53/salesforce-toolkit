// owner 2026-11-20: "i think our composite is too hard to understand and use. how can we make it better? a lot
// better." — Pick Records › the matching rule is one question, a sentence, a live result with real examples, and a
// better rule offered only on evidence.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const BM = readFileSync(new URL('../studio-builder-modals.js', import.meta.url), 'utf8');
const { bldMatchStrategyOf: strat, bldMatchExamples: examples, bldMatchLive: live, bldMatchLiveHtml: html, bldMatchBetter: better } =
  extractFunctions('studio-builder-modals.js', ['bldMatchStrategyOf', 'bldMatchExamples', 'bldMatchLive', 'bldMatchLiveHtml', 'bldMatchBetter']);
const W = { src: 'npc', tgt: 'npc2', key: 'Account Name' };

describe('the sentence decides the strategy', () => {
  it('one field, one unique-ID field, several fields', () => {
    expect(strat(['Name'], ['Ext__c'])).toBe('field');
    expect(strat(['Ext__c'], ['Ext__c'])).toBe('externalId');
    expect(strat(['Name', 'Ext__c'], ['Ext__c'])).toBe('composite');
    expect(strat([], [])).toBe('field');
  });
  it('the three radios are gone; the sentence is the control', () => {
    expect(BM).not.toContain('name="dsMatchStrat"');
    expect(BM).toContain('<div class="ds-mq-q">How do we know a record is already in the target?</div>');
    expect(BM).toContain('<option value="">+ and the same…</option>');
    expect(BM).toContain("matchStrategy = bldMatchStrategyOf(next, extIdCandidates.map(f => f.name));");
  });
});

describe('one real example of each outcome', () => {
  const src = { keyCounts: new Map([['acme', 1], ['only here', 1], ['twice', 2]]) };
  const tgt = { keyCounts: new Map([['acme', 1], ['twice', 1], ['only there', 1]]) };
  it('in both, only in the source, and a clash with its two counts', () => {
    expect(examples(src, tgt, k => k.toUpperCase())).toEqual({ both: 'ACME', onlySrc: 'ONLY HERE', clash: { label: 'TWICE', src: 2, tgt: 1 } });
  });
  it('nothing read is no example', () => {
    expect(examples(null, null)).toEqual({ both: '', onlySrc: '', clash: null });
  });
});

describe('what the rule does, in words', () => {
  it('a rule that tells every record apart is said so, in green, with the counts', () => {
    const r = live({ cross: { sourceTotal: 3, matchedUnique: 1, ambiguous: 0, unmatched: 2 }, srcStats: { blank: 0 }, ex: { both: 'acme', onlySrc: 'new co' } }, W);
    expect(r.tone).toBe('ok');
    expect(r.head).toBe('This rule tells all 3 source records apart.');
    expect(r.sub).toBe('Checked on the records of npc against npc2, just now.');
    expect(r.rows.map(x => [x.n, x.what, x.ex])).toEqual([
      [1, 'are already in the target — a run updates them', 'for example “acme”'],
      [2, 'are not in the target yet — a run creates them', 'for example “new co”'],
    ]);
  });
  it('records it cannot tell apart are counted, in red, with the clash named', () => {
    const r = live({ cross: { sourceTotal: 170, matchedUnique: 15, ambiguous: 2, unmatched: 153 }, srcStats: { blank: 0 }, ex: { clash: { label: 'dup name', src: 2, tgt: 1 } } }, W);
    expect(r.tone).toBe('bad');
    expect(r.head).toBe('This rule cannot tell 2 of 170 source records apart.');
    expect(r.rows[2]).toMatchObject({ n: 2, what: 'cannot be told apart — you will be asked about each', ex: 'for example “dup name”: 2 in the source, 1 in the target' });
  });
  it('records with an empty field are a warning that says what a run does with them', () => {
    const r = live({ cross: { sourceTotal: 10, matchedUnique: 4, ambiguous: 0, unmatched: 6 }, srcStats: { blank: 3 }, ex: {} }, W);
    expect(r.tone).toBe('warn');
    expect(r.head).toBe('This rule works for 7 of 10 source records.');
    expect(r.notes[0]).toBe('3 source records have no Account Name and can never be matched: each run creates them again.');
  });
  it('an org that could not be read is said, never shown as zero', () => {
    const r = live({ cross: null, tgtErr: 'npc2 is not open in a tab' }, W);
    expect(r.tone).toBe('idle');
    expect(r.head).toBe('This rule could not be checked: npc2 is not open in a tab.');
    expect(r.rows).toEqual([]);
  });
  it('the text is escaped on its way to the page', () => {
    const out = html({ tone: 'ok', head: '<b>x</b>', sub: '', rows: [{ cls: 'in', n: 1, what: 'w', ex: '<i>' }], notes: [] }, s => String(s).replace(/</g, '&lt;'));
    expect(out).toContain('&lt;b>x&lt;/b>');
    expect(out).toContain('<em>&lt;i></em>');
  });
});

describe('a better rule is offered only on evidence', () => {
  it('it must be good in its own right and clearly ahead of the rule on screen', () => {
    expect(better(40, [{ fields: ['A'], score: 55 }])).toBe(null);                    // least bad is no recommendation
    expect(better(88, [{ fields: ['A'], score: 92 }])).toBe(null);                    // not clearly ahead
    expect(better(40, [{ fields: ['A'], score: 70 }, { fields: ['B'], score: 95 }]).fields).toEqual(['B']);
    expect(better(40, [{ fields: ['A'] }])).toBe(null);                               // not checked is not scored
  });
  it('it is looked for only when the rule leaves records it cannot handle, and adopted only by a press', () => {
    expect(BM).toContain("if (live.tone !== 'bad' && live.tone !== 'warn') return;");
    expect(BM).toContain('<button class="ds-btn ds-btn-xs ds-btn-primary" data-mq-use>Use it</button>');
  });
});

describe('the rest of the panel', () => {
  it('one switch for small differences; a rule never set opens exact as the scan reads it and turns forgiving at the first field picked, a saved rule keeps its own', () => {
    expect(BM).toContain('<span><strong>Ignore small differences</strong> — capitals, extra spaces, phone punctuation</span>');
    expect(BM).toContain('if (!node.matching) matchNormalize = { caseFold: true, trim: true, collapseWs: true, emailLower: true, phoneDigits: true };');
    expect(BM).toContain('for (const [k] of NORM_OPTS) matchNormalize[k] = e.target.checked;');
  });
  it('the result is read once per rule and a newer rule drops an older answer', () => {
    expect(BM).toContain('if (matchLive && matchLive.sig === sig) { el0.innerHTML = matchLive.html; wireLive(); return; }');
    expect(BM).toContain('if (seq !== matchLiveSeq) return;');
  });
  it('the jargon is gone from the panel', () => {
    for (const t of ['ordered, up to 4', 'Reads as <strong>', '>Composite<', 'most specific first</summary>', 'Normalize:</span>']) expect(BM.includes(t), t).toBe(false);
  });
});
