// QA 1.1 regression, finding 13: the record editor's Owner row named the deployment's fallback owner on every
// object. The engine (background.js, sftkOwnerFallbackFor) uses a fallback QUEUE only on an object that queue
// takes: elsewhere a new record goes to the running user and a changed record keeps its owner.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const VE = readFileSync(new URL('../studio-valueedit.js', import.meta.url), 'utf8');
const { sftkVeFallbackSaid: said, sftkVeOwnerLine: line } = extractFunctions('studio-valueedit.js', ['sftkVeFallbackSaid', 'sftkVeOwnerLine', 'sftkVeOwnerWill']);
const { sftkOwnerFallbackFor: engine } = extractFunctions('background.js', ['sftkOwnerFallbackFor']);
const Q = '00G000000000001AAA', U = '005000000000001AAA';

describe('the fallback the Owner row may name on this object', () => {
  it('a fallback user is named on every object', () => {
    expect(said({ id: U, name: 'Admin User', canQueue: false, takes: null, obj: 'Account', tgtL: 'npc2' })).toEqual({ name: 'Admin User', note: '' });
    expect(said({ id: U, name: 'Admin User', canQueue: true, takes: false, obj: 'Case', tgtL: 'npc2' })).toEqual({ name: 'Admin User', note: '' });
  });
  it('no fallback: nothing is named and nothing is added', () => {
    expect(said({ id: '', name: '', canQueue: true, takes: null, obj: 'Case' })).toEqual({ name: '', note: '' });
    expect(said()).toEqual({ name: '', note: '' });
  });
  it('a fallback queue on an object a queue cannot own is not named', () => {
    expect(said({ id: Q, name: 'Support (queue)', canQueue: false, takes: null, obj: 'Account', tgtL: 'npc2' }))
      .toEqual({ name: '', note: 'The fallback owner Support (queue) is not used here — Account records cannot be owned by a queue.' });
  });
  it('a fallback queue that does not take the object is not named', () => {
    expect(said({ id: Q, name: 'Support (queue)', canQueue: true, takes: false, obj: 'Lead', tgtL: 'npc2' }))
      .toEqual({ name: '', note: 'The fallback owner Support (queue) is not used here — that queue does not take Lead in npc2.' });
  });
  it('a fallback queue that takes the object is named as before', () => {
    expect(said({ id: Q, name: 'Support (queue)', canQueue: true, takes: true, obj: 'Case', tgtL: 'npc2' })).toEqual({ name: 'Support (queue)', note: '' });
  });
  it('when the target could not be asked, the promise carries its condition', () => {
    expect(said({ id: Q, name: 'Support (queue)', canQueue: true, takes: null, obj: 'Case', tgtL: 'npc2' })).toEqual({ name: 'Support (queue), when that queue takes Case', note: '' });
  });
  it('says what the engine does: named exactly when the engine keeps the fallback', () => {
    const takes = { [Q.slice(0, 15)]: true };
    expect(engine(Q, { takes })).toBe(Q);
    expect(said({ id: Q, name: 'S', canQueue: true, takes: true }).name).toBe('S');
    expect(engine(Q, { takes: {} })).toBeNull();
    expect(engine(Q, null)).toBeNull();
    expect(said({ id: Q, name: 'S', canQueue: true, takes: false }).name).toBe('');
    expect(engine(U, null)).toBe(U);
    expect(said({ id: U, name: 'A' }).name).toBe('A');
  });
});

describe('the sentence of the Owner row, with a fallback queue that does not take the object', () => {
  const s = said({ id: Q, name: 'Support (queue)', canQueue: false, takes: null, obj: 'Account', tgtL: 'npc2' });
  it('a New record goes to the running user', () => {
    const t = line({ mapOn: true, src: { name: 'Omer Paz' }, me: 'Dana Levi', fallbackName: s.name, tgtL: 'npc2' });
    expect(t).toBe('Will belong to the user in npc2 that matches Omer Paz — and when there is no such user, Dana Levi (you — the user who runs the deployment).');
    expect(t).not.toContain('fallback owner');
  });
  it('a Changed record keeps its owner', () => {
    const t = line({ mapOn: true, src: { name: 'Omer Paz' }, fallbackName: s.name, tgtL: 'npc2', upd: true, tgtName: 'Noa Bar' });
    expect(t).toBe('Will be given to the active user in npc2 named Omer Paz — and when there is no such user, it stays with Noa Bar.');
  });
});

describe('the editor asks the target and passes the answer on', () => {
  it('the fallback queue is looked up in QueueSobject for this object, only when owners are matched', () => {
    expect(VE).toContain("if (hasOwner && om.mode === 'match' && fbName && /^00G/.test(fbId) && ownerCanQueue && tgtSess && tgtSess.sid) {");
    expect(VE).toContain("query: `SELECT QueueId FROM QueueSobject WHERE SobjectType = '${String(obj).replace(/[^A-Za-z0-9_]/g, '')}' AND QueueId = '${fbId.replace(/[^A-Za-z0-9]/g, '')}' LIMIT 1` });");
    expect(VE).toContain('if (r && !r.error && Array.isArray(r.records)) fbTakes = r.records.length > 0;');
  });
  it('the row is built from what applies to this object, and the reason is escaped with the sentence', () => {
    expect(VE).toContain('sftkVeFallbackSaid({ id: fbId, name: fbName, canQueue: ownerCanQueue, takes: fbTakes, obj, tgtL })');
    expect(VE).toContain("const dfl = sftkVeOwnerLine({ many, mapOn, src, me: runMe, fallbackName: fbSaid.name, tgtL, upd: mode === 'chg', tgtName: tgtOwn ? tgtOwn.name : '' })");
    expect(VE).toContain("+ (mapOn && fbSaid.note ? ' ' + fbSaid.note : '');");
    expect(VE).not.toContain("fallbackName: (p.ownerMapping && p.ownerMapping.fallbackUserName) || ''");
    expect(VE).toContain('data-ve-own-dfl="${esc(dfl)}"');
    expect(VE).toContain('${esc(dfl)}</span>`;');   // 2026-11-27: the final owner's name leads the sentence (ownWillHtml)
    expect(VE).toContain(': ownWillHtml(fin, dfl)}</div>');
  });
});
