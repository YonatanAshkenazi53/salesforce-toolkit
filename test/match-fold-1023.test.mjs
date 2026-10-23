import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const M = readFileSync(new URL('../studio-builder-modals.js', import.meta.url), 'utf8');

// User 2026-10-23, Pick Records › Matching: "when selecting one of the options in the radio buttons
// it will minimize the section". Every change inside the fold re-renders the modal; the fold now
// opens the way the user left it, and only defaults (open until configured) when never touched.
describe('Pick Records › the Matching fold keeps its state across re-renders', () => {
  const picker = M.slice(M.indexOf("  let matchTestHtml    = '';"), M.indexOf('function _matchSuggestionsFromDescribe('));
  it('remembers the fold as the user left it (null = the default)', () => {
    expect(picker).toContain('let matchFoldOpen    = null;');
    expect(picker).toContain(`<details class="ds-match-fold" \${matchFoldOpen === null ? (cfgd ? '' : 'open') : (matchFoldOpen ? 'open' : '')}>`);
  });
  it('the toggle is recorded when the modal is wired, so a re-render after a radio keeps it open', () => {
    const wire = picker.slice(picker.indexOf("  function wireModal(filter = '') {"));
    expect(wire.indexOf("eid('dsModalBox')?.querySelector('.ds-match-fold')?.addEventListener('toggle', e => { matchFoldOpen = e.target.open; });")).toBeGreaterThan(0);
    expect(wire.indexOf('.ds-match-fold')).toBeLessThan(wire.indexOf('async function matchCfgChanged(requery)'));
  });
});
