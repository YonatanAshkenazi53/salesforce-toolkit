import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const M = readFileSync(new URL('../studio-builder-modals.js', import.meta.url), 'utf8');

// User 2026-10-23: the Composite key can match most specific first, and the panel shows the key
// in the user's words ("name + id number + email") with how a record with fewer values is matched.
const picker = M.slice(M.indexOf('async function openRecordPickerModal('), M.indexOf('function _matchSuggestionsFromDescribe('));

describe('Pick Records › Matching › Composite: most specific first', () => {
  it('the state comes from the node; a NEW composite key starts with it on; it is persisted only for composite', () => {
    expect(picker).toContain('let matchTiered = initialMatching.tiered === true;');
    expect(picker).toContain("if (matchStrategy === 'composite' && was !== 'composite' && !(node.matching && node.matching.strategy === 'composite')) matchTiered = true;");
    expect(picker).toContain("...(matchStrategy === 'composite' && matchTiered ? { tiered: true } : {}) };");
  });
  it('the switch sits under the fields, says what it does, and re-renders without a re-query', () => {
    expect(picker).toContain('<label><input type="radio" name="dsMqTiered" value="1" ${matchTiered ? \'checked\' : \'\'}> Yes</label>');   // 2026-11-20: a question with Yes / No
    // 2026-11-19 (owner, on the old wording "Most specific first — a record that leaves a later field empty is matched by the fields it has": "i dont understand this line.")
    expect(picker).toContain(': match it by <strong>${esc(matchLabelOf(cur[0]))}</strong> alone?</span>');
    expect(picker).toContain(`document.querySelectorAll('input[name="dsMqTiered"]').forEach(rb => rb.addEventListener('change', () => {`);
    const i = picker.indexOf(`input[name="dsMqTiered"]').forEach`);
    expect(picker.slice(i, i + 220)).toContain("matchTiered = rb.value === '1';");
    expect(picker.slice(i, i + 220)).toContain('matchCfgChanged(false);');
  });
  it('the key reads in labels, with how a record with fewer values is matched', () => {
    expect(picker).toContain('const matchLabelOf = f => { const x = candidateFields.find(y => y.name === f); return x ? (x.label || f) : f; };');
    expect(picker).toContain("sftkMatchingReadsAs((fields || []).map(matchLabelOf), tiered)");
    expect(picker).toContain('<span class="ds-mq-w">It has the same</span>');   // 2026-11-20: the rule is a sentence
    expect(picker).toContain(`(i ? '<span class="ds-mq-w">and the same</span>' : '') + sel(f, i)`);
  });
  it('the fold summary uses the labels and says when the key is most specific first', () => {
    expect(picker).toContain("the same <strong>${esc(node.matching.fields.map(matchLabelOf).join(' and '))}</strong>");
  });
});

describe('Normalize options carry an example each (user 2026-10-24)', () => {
  const M2 = readFileSync(new URL('../studio-builder-modals.js', import.meta.url), 'utf8');
  it('every option has a label and an example in its hover tooltip — nothing more on the page (user: "on hover")', () => {
    expect(M2).toContain("['caseFold',    'Ignore case',         'ACME Ltd and acme ltd are the same value']");
    expect(M2).toContain("['phoneDigits', 'Digits-only phones',  '+972 (3) 555-1234 and 035551234 are the same value (phone fields only)']");
    expect(M2).toContain('NORM_OPTS.map(([k, lbl, ex]) => `<label title="${esc(ex)}"><input type="checkbox" data-match-norm="${esc(k)}"');
    expect(M2).not.toContain('ds-match-norm-help');
  });
});
