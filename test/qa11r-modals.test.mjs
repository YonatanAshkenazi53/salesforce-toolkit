// QA 1.1 regression run, the Pick Records matching panel (studio-builder-modals.js):
//   #5 / #11  a rule never set showed the forgiving switch on while Apply saved nothing
//   #6        a cached result did not stop an older read from painting
//   #7        a tiered rule's examples came from equal full keys, its counts from the tiered pairing
//   #15       an object without a Name opened as "Name" and its live check failed
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const BM = read('studio-builder-modals.js');
const { bldMatchTieredExamples: tieredEx, bldMatchSeedNoName: seed, bldMatchExamples: exactEx } =
  extractFunctions('studio-builder-modals.js', ['bldMatchTieredExamples', 'bldMatchSeedNoName', 'bldMatchExamples']);
const { sftkTieredPairs: pairs, sftkTieredPreview: preview, sftkMatchingFallback: fallback, sftkMatchingFromNode: fromNode } =
  extractFunctions('sftk-matching.js', ['sftkNormalizeValue', 'sftkPathValue', 'sftkMatchParts', 'sftkTieredScore', 'sftkTieredPairs', 'sftkTieredPreview', 'sftkMatchingFallback', 'sftkMatchingFromNode']);
const SEP = String.fromCharCode(1);
const lab = k => String(k).split(SEP).map(p => p === '' ? 'none' : p).join(' · ');
const body = (from, to) => { const a = BM.indexOf(from); const b = BM.indexOf(to, a); expect(a).toBeGreaterThan(-1); expect(b).toBeGreaterThan(a); return BM.slice(a, b); };

describe('#5 / #11 — a rule never set: what is shown is what the scan uses', () => {
  it('the scan reads a never-set rule as an exact comparison, and the panel no longer opens with anything else', () => {
    expect(fromNode({}).normalize).toEqual({});
    const open = body('const initialMatching = sftkMatchingFromNode(node);', 'let upsertOn =');
    expect(open).toContain('caseFold: false, trim: false, collapseWs: false, emailLower: false, phoneDigits: false,');
    // the only forgiving default left in the opening code is none: all five on is set in a handler
    expect(open.includes('caseFold: true')).toBe(false);
  });
  it('the forgiving start belongs to the first field the user picks, and that step saves the rule', () => {
    const h = body("document.querySelectorAll('[data-mq-field]').forEach(selEl => selEl.addEventListener('change', () => {", "eid('dsMqForgive')?.addEventListener");
    expect(h).toContain('if (!node.matching) matchNormalize = { caseFold: true, trim: true, collapseWs: true, emailLower: true, phoneDigits: true };');
    expect(h).toContain('matchCfgChanged(true);');
    expect(h.indexOf('if (!node.matching) matchNormalize')).toBeLessThan(h.indexOf('matchCfgChanged(true);'));
    const ch = body('async function matchCfgChanged(requery) {', 'matchTestHtml');
    expect(ch).toContain('persistMatching();');
  });
  it('the switch itself saves what it shows', () => {
    const h = body("eid('dsMqForgive')?.addEventListener('change', e => {", "document.querySelectorAll('input[name=\"dsMqTiered\"]')");
    expect(h).toContain('for (const [k] of NORM_OPTS) matchNormalize[k] = e.target.checked;');
    expect(h).toContain('matchCfgChanged(false);');
  });
});

describe('#6 — a newer rule on screen drops an older read, also when it is answered from the cache', () => {
  const fn = body('async function runMatchLive() {', 'function wireLive() {');
  it('the sequence advances and the timer is cleared before any early return', () => {
    const bump = fn.indexOf('const seq = ++matchLiveSeq;');
    const clear = fn.indexOf('clearTimeout(matchLiveTimer);');
    const noTgt = fn.indexOf('if (!tgtUrl) {');
    const cache = fn.indexOf('if (matchLive && matchLive.sig === sig) {');
    for (const i of [bump, clear, noTgt, cache]) expect(i).toBeGreaterThan(-1);
    expect(bump).toBeLessThan(noTgt); expect(clear).toBeLessThan(noTgt);
    expect(bump).toBeLessThan(cache); expect(clear).toBeLessThan(cache);
  });
  it('there is one bump per call, and the older read still checks it after its wait and after its queries', () => {
    expect(fn.split('++matchLiveSeq').length - 1).toBe(1);
    expect(fn.split('if (seq !== matchLiveSeq) return;').length - 1).toBe(2);
    const wait = fn.indexOf('await new Promise(r => { matchLiveTimer = setTimeout(r, 350); });');
    const query = fn.indexOf('res = await sftkAnalyzeMatchKey(');
    const store = fn.indexOf('matchLive = { sig, html,');
    const c1 = fn.indexOf('if (seq !== matchLiveSeq) return;'), c2 = fn.indexOf('if (seq !== matchLiveSeq) return;', c1 + 1);
    expect(wait).toBeLessThan(c1); expect(c1).toBeLessThan(query);
    expect(query).toBeLessThan(c2); expect(c2).toBeLessThan(store);
  });
  it('the search for a better rule ends when another rule is on screen, not when the same rule is drawn again', () => {
    // a letter typed in the search box re-renders the modal and asks for the same rule: the cache answers, the
    // sequence advances, and the offer still being worked out for that rule must survive it
    const noTgt = fn.indexOf('if (!tgtUrl) { matchLiveShown = null;');
    const shown = fn.indexOf('matchLiveShown = sig;');
    const cache = fn.indexOf('if (matchLive && matchLive.sig === sig) {');
    expect(noTgt).toBeGreaterThan(-1);
    expect(shown).toBeGreaterThan(noTgt); expect(shown).toBeLessThan(cache);
    expect(fn).toContain('const stale = () => matchLive !== mine || matchLiveShown !== sig;');
    const after = fn.slice(fn.indexOf('const mine = matchLive;'));
    expect(after).toContain('for (const c of cands) { if (stale()) return; await _gradeSuggestion(c); }');
    expect(after.includes('seq !== matchLiveSeq')).toBe(false);
    expect(after).toContain('if (el && !stale()) {');
  });
});

describe('#7 — a tiered rule: the examples come from the pairing the counts come from', () => {
  // the finding's case: Acme has an e-mail in the source and none in the target; Beta is new
  const src = [['acme', 'a@acme.com'], ['beta', 'b@beta.com']];
  const tgt = [['acme', '']];
  it('a record counted as already in the target is its example, never the example of a new one', () => {
    const c = preview(src, tgt);
    expect(c.matchedUnique).toBe(1); expect(c.unmatched).toBe(1);
    const ex = tieredEx(src, tgt, lab, pairs);
    expect(ex.both).toBe('acme · a@acme.com');
    expect(ex.onlySrc).toBe('beta · b@beta.com');
    expect(ex.clash).toBe(null);
    // the exact-key examples, for the same data, called Acme new: that was the defect
    const km = rows => ({ keyCounts: new Map(rows.map(p => [p.join(SEP), 1])) });
    expect(exactEx(km(src), km(tgt), lab).onlySrc).toBe('acme · a@acme.com');
  });
  it('records it cannot tell apart: the group of the pairing, with its own counts', () => {
    const s = [['acme', ''], ['acme', '']], t = [['acme', 'x@acme.com'], ['acme', 'y@acme.com'], ['acme', 'z@acme.com']];
    const c = preview(s, t);
    expect(c.ambiguous).toBe(2);
    const ex = tieredEx(s, t, lab, pairs);
    expect(ex.clash).toEqual({ label: 'acme', src: 2, tgt: 3 });
    expect(ex.both).toBe(''); expect(ex.onlySrc).toBe('');
  });
  it('an example exists only where the count is not zero', () => {
    const cases = [[src, tgt], [[['a', '1']], [['a', '2']]], [[['', 'x']], [['a', 'x']]], [[], []]];
    for (const [s, t] of cases) {
      const c = preview(s, t), ex = tieredEx(s, t, lab, pairs);
      if (!c.matchedUnique) expect(ex.both).toBe('');
      if (!c.unmatched) expect(ex.onlySrc).toBe('');
      if (!c.ambiguous) expect(ex.clash).toBe(null);
      if (c.matchedUnique) expect(ex.both).not.toBe('');
    }
  });
  it('no pairing function, or no lists: no examples and no throw', () => {
    expect(tieredEx(src, tgt, lab, null)).toEqual({ both: '', onlySrc: '', clash: null });
    expect(tieredEx(null, undefined, lab, pairs)).toEqual({ both: '', onlySrc: '', clash: null });
  });
  it('the live result takes them when the counts are tiered, and the exact ones otherwise', () => {
    const fn = body('async function runMatchLive() {', 'function wireLive() {');
    expect(fn).toContain("ex: (res.cross && res.cross.tiered && res.src && res.tgt && res.src.parts && res.tgt.parts && typeof sftkTieredPairs === 'function')");
    expect(fn).toContain('? bldMatchTieredExamples(res.src.parts, res.tgt.parts, exLabel, sftkTieredPairs)');
    expect(fn).toContain(': bldMatchExamples(res.src, res.tgt, exLabel),');
  });
});

describe('#15 — an object without a Name', () => {
  const CASE = [
    { name: 'Id', type: 'id' },
    { name: 'CaseNumber', type: 'string', nameField: true, autoNumber: true, createable: false },
    { name: 'Subject', type: 'string', createable: true },
    { name: 'AccountId', type: 'reference', relationshipName: 'Account', referenceTo: ['Account'], createable: true, nillable: true },
  ];
  it('a never-set node opens with the key the scan falls back to, not with Name', () => {
    const s = seed(CASE, {}, fallback);
    const fb = fallback(CASE, {});
    expect(s.fields).toEqual(fb.fields);
    expect(s.strategy).toBe(fb.strategy);
    expect(s.normalize).toEqual(fb.normalize);
    expect(s.fields.includes('Name')).toBe(false);
    expect(s.fields[0]).toBe('Subject');
  });
  it('a name field under another name that is not a number is the key, as in the scan', () => {
    const TASKLIKE = [{ name: 'Id', type: 'id' }, { name: 'Subject', type: 'string', nameField: true }, { name: 'Code__c', type: 'string', externalId: true }];
    expect(seed(TASKLIKE, {}, fallback)).toEqual({ strategy: 'field', fields: ['Subject'], normalize: {} });
  });
  it('an object with a Name, a node with a rule, a legacy field that exists, or no describe: nothing is changed', () => {
    const ACC = [{ name: 'Id', type: 'id' }, { name: 'Name', type: 'string', nameField: true }];
    expect(seed(ACC, {}, fallback)).toBe(null);
    expect(seed(CASE, { matching: { strategy: 'field', fields: ['Subject'], normalize: {} } }, fallback)).toBe(null);
    expect(seed(CASE, { matchField: 'Subject' }, fallback)).toBe(null);
    expect(seed(null, {}, fallback)).toBe(null);
    expect(seed([], {}, fallback)).toBe(null);
  });
  it('a legacy field that is not on the object is replaced the same way', () => {
    expect(seed(CASE, { matchField: 'Gone__c' }, fallback).fields[0]).toBe('Subject');
  });
  it('nothing usable, or no fallback loaded: the caller keeps its own start', () => {
    const BARE = [{ name: 'Id', type: 'id' }, { name: 'Num', type: 'string', nameField: true, autoNumber: true, createable: false }];
    expect(seed(BARE, {}, fallback)).toBe(null);
    expect(seed(CASE, {}, null)).toBe(null);
  });
  it('a per-lookup match field of the node reaches the fallback', () => {
    const s = seed(CASE, { lookupResolutions: { AccountId: { matchField: 'Code__c' } } }, fallback);
    expect(s.fields).toContain('Account.Code__c');
  });
  it('the modal seeds before the suggestions are sized, and the summary names the rule on screen', () => {
    const seedAt = BM.indexOf("const seed = bldMatchSeedNoName(desc && desc.fields, node, (typeof sftkMatchingFallback === 'function') ? sftkMatchingFallback : null);");
    expect(seedAt).toBeGreaterThan(-1);
    expect(seedAt).toBeLessThan(BM.indexOf('let matchSuggestDepth ='));
    expect(BM).toContain("${esc(matchFields.filter(Boolean).map(matchLabelOf).join(' and ') || 'Name')}</strong> — not checked yet`;");
    expect(BM.includes("'the same <strong>Name</strong> — not checked yet'")).toBe(false);
  });
});
