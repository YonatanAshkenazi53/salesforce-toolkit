// owner 2026-11-19: "when you click data deployment record and look for the owner field, we will not see who is the
// owner in the target" · "what about owners in the record?" — the record's compare window names the owner in both orgs
// and says what the deployment does about it. The owner stays out of the field compare when owners are not copied.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const R = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const { sftkOwnerLineText: f } = extractFunctions('studio-reconcile.js', ['sftkOwnerLineText']);
const L = { srcLabel: 'npc', tgtLabel: 'npc2' };

describe('the owner line', () => {
  it('names the owner in both orgs; without owner copying it says the record keeps its owner in the target', () => {
    expect(f({ src: 'Dana Levi', tgt: 'Integration User', mode: 'skip', ...L })).toBe('Dana Levi in npc · Integration User in npc2. This deployment does not copy owners — the record keeps Integration User in npc2.');
  });
  it('with owner matching: the same owner is said; a different one says what ▶ Deploy does, with the fallback', () => {
    expect(f({ src: 'Dana Levi', tgt: 'dana levi', mode: 'match', ...L })).toBe('Dana Levi in npc · dana levi in npc2. The same owner on both sides.');
    expect(f({ src: 'Dana Levi', tgt: 'Integration User', mode: 'match', fallbackName: 'Admin User', ...L })).toBe('Dana Levi in npc · Integration User in npc2. This deployment matches owners: on ▶ Deploy the record is given the user in npc2 that matches Dana Levi — when there is none, the fallback user Admin User.');
    expect(f({ src: 'Dana Levi', tgt: 'Integration User', mode: 'match', ...L })).toContain('no fallback user is set, so the owner there stays as it is');
  });
  it('an owner that could not be read on one side is said, never guessed; none on both → no line', () => {
    expect(f({ src: 'Dana Levi', tgt: '', mode: 'skip', ...L })).toBe('Dana Levi in npc · not read in npc2. This deployment does not copy owners — the record keeps its owner in npc2.');
    expect(f({ src: '', tgt: '', mode: 'skip', ...L })).toBe('');
    expect(f(null)).toBe('');
  });
  it('is read beside the fields, from both orgs, and drawn above them', () => {
    expect(R).toContain('const ownerP = sftkOwnerLineFetch(prof, obj, srcId, tgtId);');
    expect(R).toContain("const [src, tgt] = await Promise.all([one(prof.sourceOrg, srcId), one(prof.targetOrg, tgtId)]);");
    expect(R).toContain('`SELECT OwnerId, Owner.Name FROM ${obj} WHERE Id = ');
    expect(R).toContain('<div class="ds-dc-owner" id="dsDcOwner" hidden></div>');
  });
});
