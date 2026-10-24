import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const M = readFileSync(new URL('../studio-builder-modals.js', import.meta.url), 'utf8');

// User 2026-10-23: the Composite key can match most specific first, and the panel shows the key
// in the user's words ("name + id number + email") with how a record with fewer values is matched.
const picker = M.slice(M.indexOf('async function openRecordPickerModal('), M.indexOf('function _matchSuggestionsFromDescribe('));

describe('Pick Records › Matching › Composite: most specific first', () => {
  it('the state comes from the node; a NEW composite key starts with it on; it is persisted only for composite', () => {
    expect(picker).toContain('let matchTiered = initialMatching.tiered === true;');
    expect(picker).toContain("if (matchStrategy === 'composite' && !(node.matching && node.matching.strategy === 'composite')) matchTiered = true;");
    expect(picker).toContain("...(matchStrategy === 'composite' && matchTiered ? { tiered: true } : {}) };");
  });
  it('the switch sits under the fields, says what it does, and re-renders without a re-query', () => {
    expect(picker).toContain('<input type="checkbox" id="dsMatchTiered" ${matchTiered ? \'checked\' : \'\'}>');
    expect(picker).toContain('<strong>Most specific first</strong> — a record that leaves a later field empty is matched by the fields it has');
    expect(picker).toContain("eid('dsMatchTiered')?.addEventListener('change', e => {");
    const i = picker.indexOf("eid('dsMatchTiered')?.addEventListener");
    expect(picker.slice(i, i + 200)).toContain('matchTiered = e.target.checked;');
    expect(picker.slice(i, i + 200)).toContain('matchCfgChanged(false);');
  });
  it('the key reads in labels, with how a record with fewer values is matched', () => {
    expect(picker).toContain('const matchLabelOf = f => { const x = candidateFields.find(y => y.name === f); return x ? (x.label || f) : f; };');
    expect(picker).toContain("sftkMatchingReadsAs((fields || []).map(matchLabelOf), tiered)");
    expect(picker).toContain('<div class="ds-match-readsas ds-subtext" id="dsMatchReadsAs"');
    expect(picker).toContain('Reads as <strong>${esc(ra.key)}</strong>. ${esc(ra.how)}');
  });
  it('the fold summary uses the labels and says when the key is most specific first', () => {
    expect(picker).toContain('<strong>${esc(matchReadsAs(node.matching.fields, false).key)}</strong>${node.matching.tiered ? \' <span class="ds-subtext">— most specific first</span>\' : \'\'}');
  });
});

describe('Normalize options carry an example each (user 2026-10-24)', () => {
  const M2 = readFileSync(new URL('../studio-builder-modals.js', import.meta.url), 'utf8');
  it('every option has a label and an example in its hover tooltip — nothing more on the page (user: "on hover")', () => {
    expect(M2).toContain("['caseFold',    'Ignore case',         'ACME Ltd and acme ltd are the same value']");
    expect(M2).toContain("['phoneDigits', 'Digits-only phones',  '+972 (3) 555-1234 and 035551234 are the same value (phone fields only)']");
    expect(M2).toContain('NORM_OPTS.map(([k, lbl, ex]) => `<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer" title="${esc(ex)}">');
    expect(M2).not.toContain('ds-match-norm-help');
  });
});
