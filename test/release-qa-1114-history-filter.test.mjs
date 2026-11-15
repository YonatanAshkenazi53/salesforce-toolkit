// QA 2026-11-14 (run-retry-rollback-history): the History "deployment" filter
// named a deployment after its newest rollback ("↩ Rollback of X") although
// that one option filters both the deployment's card and the rollback's.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunctions } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { _histProfileOptions } = extractFunctions('studio-history.js', ['_histProfileOptions']);

describe('History deployment filter options', () => {
  it('a newer rollback does not rename its deployment option', () => {
    const runs = [ // newest first, as renderHistory sorts them
      { id: 'r2', kind: 'rollback', profileId: 'p1', profileName: '↩ Rollback of SFTK CX — Accounts tree' },
      { id: 'r1', profileId: 'p1', profileName: 'SFTK CX — Accounts tree' },
    ];
    const opts = _histProfileOptions(runs);
    expect([...opts]).toEqual([['p1', 'SFTK CX — Accounts tree']]);
  });

  it('only a rollback left: the prefix is stripped, never empty', () => {
    expect(_histProfileOptions([{ kind: 'rollback', profileId: 'p1', profileName: '↩ Rollback of Deals' }]).get('p1')).toBe('Deals');
    expect(_histProfileOptions([{ kind: 'rollback', profileId: 'p2', profileName: '↩ Rollback of ' }]).get('p2')).toBe('Unnamed');
  });

  it('keeps first-seen order, one option per profile, junk tolerated', () => {
    const opts = _histProfileOptions([null, { profileId: 'b', profileName: 'B' }, { profileId: 'a' }, { profileId: 'b', profileName: 'B old' }, { kind: 'rollback' }]);
    expect([...opts]).toEqual([['b', 'B'], ['a', 'Unnamed']]);
    expect(_histProfileOptions(null).size).toBe(0);
  });

  it('renderHistory builds the dropdown from the helper', () => {
    const src = readFileSync(join(root, 'studio-history.js'), 'utf8');
    expect(src).toMatch(/const profSeen = _histProfileOptions\(sorted\)/);
  });
});
