// QA 1.1 finding 46: an owner picked in the record editor is written on a Changed record — owner matching runs first.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const { sftkRecOwnerThenTyped: run } = extractFunctions('studio-reconcile.js', ['sftkRecOwnerThenTyped']);
const { sftkValOvApply: apply } = extractFunctions('sftk-valueedit.js', ['sftkValOvApply']);

const PICK = '005PICKED', MATCH = '005MATCHED', FALL = '005FALLBACK';
const byName = new Map([['Ada Owner', MATCH]]);
const allowed = new Set(['OwnerId', 'Name']);
const typed = ov => (ov ? p => apply(p, ov, {}, allowed, () => false) : null);

describe('an update payload: owner mapping, then the typed values', () => {
  it('the source owner has a name match, and an owner was picked → the PICK is written', () => {
    const p = { Id: '001T', Name: 'src' };
    const r = run(p, { wantOwners: true, ownerName: 'Ada Owner', ownerByName: byName, ownerFallback: '' }, typed({ OwnerId: PICK }));
    expect(p.OwnerId).toBe(PICK);
    expect(r).toEqual({ used: 1, masked: 0, fellBack: 0, kept: 0 });
  });
  it('no name match but a fallback user, and an owner was picked → the PICK is written, and no fallback is reported', () => {
    const p = { Id: '001T' };
    const r = run(p, { wantOwners: true, ownerName: 'Nobody Here', ownerByName: byName, ownerFallback: FALL }, typed({ OwnerId: PICK, Name: 'typed' }));
    expect(p).toEqual({ Id: '001T', OwnerId: PICK, Name: 'typed' });
    expect(r).toEqual({ used: 2, masked: 0, fellBack: 0, kept: 0 });
  });
  it('no match, no fallback, a pick → written, and not counted as "kept its current owner"', () => {
    const p = { Id: '001T' };
    const r = run(p, { wantOwners: true, ownerName: 'Nobody Here', ownerByName: byName, ownerFallback: '' }, typed({ OwnerId: PICK }));
    expect(p.OwnerId).toBe(PICK);
    expect(r.kept).toBe(0);
  });
  it('no pick: the mapping is what it was — match, fallback (counted), or the target’s owner kept (counted)', () => {
    const a = { Id: '1' }, b = { Id: '2' }, c = { Id: '3' }, d = { Id: '4' };
    expect(run(a, { wantOwners: true, ownerName: 'Ada Owner', ownerByName: byName, ownerFallback: FALL }, null)).toEqual({ used: 0, masked: 0, fellBack: 0, kept: 0 });
    expect(a.OwnerId).toBe(MATCH);
    expect(run(b, { wantOwners: true, ownerName: 'Nobody Here', ownerByName: byName, ownerFallback: FALL }, typed({ Name: 'n' }))).toEqual({ used: 1, masked: 0, fellBack: 1, kept: 0 });
    expect(b.OwnerId).toBe(FALL);
    expect(run(c, { wantOwners: true, ownerName: 'Nobody Here', ownerByName: byName, ownerFallback: '' }, null)).toEqual({ used: 0, masked: 0, fellBack: 0, kept: 1 });
    expect('OwnerId' in c).toBe(false);
    expect(run(d, { wantOwners: true, ownerName: null, ownerByName: byName, ownerFallback: FALL }, null)).toEqual({ used: 0, masked: 0, fellBack: 0, kept: 0 });
    expect('OwnerId' in d).toBe(false);
  });
  it('owners not copied: only the typed values are written', () => {
    const p = { Id: '001T' };
    run(p, { wantOwners: false, ownerName: 'Ada Owner', ownerByName: byName, ownerFallback: FALL }, typed({ OwnerId: PICK }));
    expect(p.OwnerId).toBe(PICK);
  });
  it('a pick the target would not accept (OwnerId not updateable) is not written; the mapping’s outcome stands and is counted', () => {
    const p = { Id: '001T' };
    const r = run(p, { wantOwners: true, ownerName: 'Nobody Here', ownerByName: byName, ownerFallback: FALL }, pl => apply(pl, { OwnerId: PICK }, {}, new Set(['Name']), () => false));
    expect(p.OwnerId).toBe(FALL);
    expect(r).toEqual({ used: 0, masked: 0, fellBack: 1, kept: 0 });
  });
  it('the overwrite builds every payload through it, and no second owner assignment follows', () => {
    expect(RC).toContain('const ot = sftkRecOwnerThenTyped(p, { wantOwners, ownerName: sr.Owner ? sr.Owner.Name : null, ownerByName, ownerFallback },');
    const at = RC.indexOf('const ot = sftkRecOwnerThenTyped(p,');
    const tail = RC.slice(at, RC.indexOf('payloads.push(p);', at));
    expect(tail).not.toContain('p.OwnerId =');
    expect(tail).toContain('ownerFellBack += ot.fellBack; ownerKept += ot.kept;');
  });
});
