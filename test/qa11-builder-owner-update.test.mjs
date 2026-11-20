// QA 1.1 finding 47 — the Owner row said "Will belong to <you>" on a Changed record, where the update leaves or matches the target's owner.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const VE = readFileSync(new URL('../studio-valueedit.js', import.meta.url), 'utf8');
const { sftkVeOwnerLine: line } = extractFunctions('studio-valueedit.js', ['sftkVeOwnerLine', 'sftkVeOwnerWill']);
const { sftkRecOwnerThenTyped: engine } = extractFunctions('studio-reconcile.js', ['sftkRecOwnerThenTyped']);
const T = { tgtL: 'npc2', me: 'Dana Levi' };
const U = { ...T, upd: true, tgtName: 'Rina Gold' };

describe('a new record (insert): the sentence is what it was', () => {
  it('"Will belong to …", the running user when owners are not copied', () => {
    expect(line({ mapOn: false, ...T })).toBe('Will belong to Dana Levi (you — the user who runs the deployment). This deployment does not copy owners — pick a user or a queue here to give the record to someone else.');
    expect(line({ mapOn: true, src: { name: 'Omer Paz' }, fallbackName: 'Admin User', ...T })).toBe('Will belong to the user in npc2 that matches Omer Paz — and when there is no such user, the fallback owner Admin User.');
  });
});

describe('a Changed record (update): the running user is never named as the owner', () => {
  const cases = [
    { mapOn: false },
    { mapOn: false, many: true },
    { mapOn: true, src: { name: 'Omer Paz' } },
    { mapOn: true, src: { name: 'Omer Paz' }, fallbackName: 'Admin User' },
    { mapOn: true, src: { name: 'Support', queue: true } },
    { mapOn: true, src: { name: 'Support', queue: true }, fallbackName: 'Admin User' },
    { mapOn: true, src: null },
    { mapOn: true, many: true },
    { mapOn: true, many: true, fallbackName: 'Admin User' },
  ];
  it('in every case', () => {
    for (const c of cases) {
      const s = line({ ...c, ...U });
      expect(s, JSON.stringify(c)).not.toMatch(/Dana Levi|\byou\b|Will belong to/);
      expect(s.length).toBeGreaterThan(20);
    }
  });
  it('owners not copied: the record stays with its owner in the target, by name', () => {
    expect(line({ mapOn: false, ...U })).toBe('Stays with Rina Gold in npc2 — the update does not change the owner. This deployment does not copy owners — pick a user or a queue here to give the record to someone else.');
    expect(line({ mapOn: false, ...U, tgtName: '' })).toBe('Stays with its current owner in npc2 — the update does not change the owner. This deployment does not copy owners — pick a user or a queue here to give the record to someone else.');
    expect(line({ mapOn: false, many: true, ...U })).toBe('Each record keeps its current owner in npc2 — the update does not change owners. This deployment does not copy owners.');
  });
  it('owners matched: the active user of the same name; with none, the fallback user — or, with none set, the owner stays', () => {
    expect(line({ mapOn: true, src: { name: 'Omer Paz' }, ...U })).toBe('Will be given to the active user in npc2 named Omer Paz — and when there is no such user, it stays with Rina Gold.');
    expect(line({ mapOn: true, src: { name: 'Omer Paz' }, fallbackName: 'Admin User', ...U })).toBe('Will be given to the active user in npc2 named Omer Paz — and when there is no such user, the fallback owner Admin User.');
    expect(line({ mapOn: true, many: true, ...U })).toBe('Each record is given the active user in npc2 with the same name as its owner — and where there is no such user, the record keeps its current owner.');
    expect(line({ mapOn: true, many: true, fallbackName: 'Admin User', ...U })).toBe('Each record is given the active user in npc2 with the same name as its owner — and where there is no such user, the fallback owner Admin User.');
  });
  it('a queue is not matched; an owner that could not be read changes nothing', () => {
    expect(line({ mapOn: true, src: { name: 'Support', queue: true }, ...U })).toBe('Will be given to the queue in npc2 with the same API name as Support, when it takes this object — and when there is none, it stays with Rina Gold.');
    expect(line({ mapOn: true, src: { name: 'Support', queue: true }, fallbackName: 'Admin User', ...U })).toBe('Will be given to the queue in npc2 with the same API name as Support, when it takes this object — and when there is none, the fallback owner Admin User.');
    expect(line({ mapOn: true, src: null, fallbackName: 'Admin User', ...U })).toBe('Stays with Rina Gold in npc2 — the source record’s owner could not be read, so the update does not change the owner.');
  });
});

describe('the sentence is what the update engine does', () => {
  const users = new Map([['Omer Paz', '005OMER']]);
  const run = o => { const p = {}; const out = engine(p, o, null); return { owner: p.OwnerId, ...out }; };
  it('owners not copied: OwnerId is not sent', () => {
    expect(run({ wantOwners: false, ownerName: 'Omer Paz', ownerByName: users, ownerFallback: '005FB' }).owner).toBeUndefined();
  });
  it('matched by name; else the fallback; else kept — and nothing at all when the source owner is not read', () => {
    expect(run({ wantOwners: true, ownerName: 'Omer Paz', ownerByName: users, ownerFallback: null }).owner).toBe('005OMER');
    expect(run({ wantOwners: true, ownerName: 'Nobody', ownerByName: users, ownerFallback: '005FB' })).toMatchObject({ owner: '005FB', fellBack: 1 });
    const kept = run({ wantOwners: true, ownerName: 'Nobody', ownerByName: users, ownerFallback: null });
    expect(kept.owner).toBeUndefined(); expect(kept.kept).toBe(1);
    expect(run({ wantOwners: true, ownerName: null, ownerByName: users, ownerFallback: '005FB' }).owner).toBeUndefined();
  });
});

describe('the Owner row is told the mode and the target’s owner', () => {
  it('a Changed row is an update', () => {
    expect(VE).toContain("const dfl = sftkVeOwnerLine({ many, mapOn, src, me: runMe, fallbackName: (p.ownerMapping && p.ownerMapping.fallbackUserName) || '', tgtL, upd: mode === 'chg', tgtName: tgtOwn ? tgtOwn.name : '' });");
    expect(VE).not.toContain("'Will belong to ' + sftkVeOwnerWill({ many,");
  });
});
