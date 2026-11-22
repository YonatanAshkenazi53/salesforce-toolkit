// QA 1.1 regression run, lane owners-rec (studio-reconcile.js).
//  #12  Update path: a fallback QUEUE that does not take the object was reported as "no fallback user set".
//  #20  Compare window's owner line said "the user that matches" and "the fallback user" for a queue.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const R = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const { sftkRecOwnerWarnings: warn, sftkOwnerLineText: line, sftkQueueOwnerMap: qmap, sftkOwnerFallbackFor: fbFor, sftkRecOwnerThenTyped: own } =
  extractFunctions('studio-reconcile.js', ['sftkRecOwnerWarnings', 'sftkOwnerLineText', 'sftkQueueOwnerMap', 'sftkOwnerFallbackFor', 'sftkRecOwnerThenTyped']);

const USER = '005000000000001AAA', QUEUE = '00G999000000055AAA';

describe('#12 the update says why an unmatched owner was kept', () => {
  it('a fallback queue that does not take the object: named as the reason, never "no fallback user set"', () => {
    // the scenario end to end on the pure parts: a Case-only queue, an Account update
    const m = qmap([], []);                       // the target has no queue that takes Account
    const nodeFallback = fbFor(QUEUE, m);
    expect(nodeFallback).toBe(null);
    const p = {};
    const ot = own(p, { wantOwners: true, ownerName: 'Dana Levi', ownerByName: new Map(), ownerFallback: nodeFallback, srcOwnerId: USER, queueBySrc: m.bySrc }, null);
    expect(p.OwnerId).toBeUndefined();
    expect(ot.kept).toBe(1);
    const out = warn({ fellBack: 0, kept: ot.kept, fallbackId: QUEUE, nodeFallback, objType: 'Account', queuesUnread: false });
    expect(out).toEqual(['⚠ owners: the fallback queue does not take Account records in the target, so 1 record(s) with no matching owner kept their current target owner']);
    expect(out.join(' ')).not.toContain('no fallback user set');
  });
  it('the queues could not be read: the fallback queue is said to be unchecked, not refused', () => {
    const out = warn({ kept: 3, fallbackId: QUEUE, nodeFallback: null, objType: 'Account', queuesUnread: true });
    expect(out).toEqual(['⚠ owners: 3 record(s) with no matching owner kept their current target owner (the fallback queue could not be checked for Account, so it was not used)']);
  });
  it('no fallback at all, and a fallback user: the sentences are the ones the run always printed', () => {
    expect(warn({ kept: 2, fallbackId: null, nodeFallback: null, objType: 'Account' }))
      .toEqual(['⚠ owners: 2 record(s) kept their current target owner (no name match and no fallback user set)']);
    expect(warn({ fellBack: 4, kept: 0, fallbackId: USER, nodeFallback: USER, objType: 'Account' }))
      .toEqual(['⚠ owners: 4 record(s) reassigned to the fallback user (owner had no name match in the target)']);
  });
  it('a fallback queue that takes the object is called a queue; nothing to say → no line', () => {
    expect(warn({ fellBack: 4, fallbackId: QUEUE, nodeFallback: QUEUE, objType: 'Case' }))
      .toEqual(['⚠ owners: 4 record(s) reassigned to the fallback queue (owner had no match in the target)']);
    expect(warn({ fellBack: 0, kept: 0, fallbackId: QUEUE, nodeFallback: null, objType: 'Case' })).toEqual([]);
    expect(warn(null)).toEqual([]);
  });
  it('is wired into the update, guarded, with the queue read failure remembered', () => {
    expect(R).toContain("if (typeof sftkRecOwnerWarnings === 'function') {");
    expect(R).toContain('warnings.push(...sftkRecOwnerWarnings({ fellBack: ownerFellBack, kept: ownerKept, fallbackId: ownerFallback, nodeFallback, objType, queuesUnread }));');
    expect(R).toContain('queuesUnread = true;');
    expect(R).toContain('the fallback queue is not used on ${objType}, so those records keep their current target owner');
  });
});

describe('#20 the compare window owner line knows a queue from a user', () => {
  const L = { srcLabel: 'npc', tgtLabel: 'npc2' };
  it('a queue-owned source record: given the queue of the same API name, when it takes the object', () => {
    const t = line({ src: 'Tier 1', tgt: 'Integration User', mode: 'match', srcIsQueue: true, ...L });
    expect(t).toBe('Tier 1 in npc · Integration User in npc2. This deployment matches owners: on ▶ Deploy the record is given the queue in npc2 with the same API name as Tier 1, when that queue takes this object — when there is none, no fallback user is set, so the owner there stays as it is.');
    expect(t).not.toContain('the user in npc2 that matches');
  });
  it('a fallback queue is called a queue, with its condition', () => {
    const t = line({ src: 'Dana Levi', tgt: 'Integration User', mode: 'match', fallbackName: 'Support', fallbackIsQueue: true, ...L });
    expect(t).toBe('Dana Levi in npc · Integration User in npc2. This deployment matches owners: on ▶ Deploy the record is given the user in npc2 that matches Dana Levi — when there is none, the fallback queue Support when it takes this object (otherwise the owner there stays as it is).');
    expect(t).not.toContain('the fallback user');
  });
  it('the stored queue name carries " (queue)" (the builder writes it so): the word is said once', () => {
    const t = line({ src: 'Dana Levi', tgt: 'Integration User', mode: 'match', fallbackName: 'Support (queue)', fallbackIsQueue: true, ...L });
    expect(t).toContain('the fallback queue Support when it takes this object');
    expect(t).not.toContain('(queue)');
    // a user whose name happens to end so is left alone
    expect(line({ src: 'Dana Levi', tgt: 'Integration User', mode: 'match', fallbackName: 'Ops (queue)', ...L })).toContain('the fallback user Ops (queue).');
  });
  it('a queue-owned source record with a fallback queue: both conditions are said', () => {
    expect(line({ src: 'Tier 1', tgt: 'Integration User', mode: 'match', srcIsQueue: true, fallbackName: 'Support (queue)', fallbackIsQueue: true, ...L }))
      .toBe('Tier 1 in npc · Integration User in npc2. This deployment matches owners: on ▶ Deploy the record is given the queue in npc2 with the same API name as Tier 1, when that queue takes this object — when there is none, the fallback queue Support when it takes this object (otherwise the owner there stays as it is).');
  });
  it('a user owner with a user fallback reads as before', () => {
    expect(line({ src: 'Dana Levi', tgt: 'Integration User', mode: 'match', fallbackName: 'Admin User', ...L }))
      .toBe('Dana Levi in npc · Integration User in npc2. This deployment matches owners: on ▶ Deploy the record is given the user in npc2 that matches Dana Levi — when there is none, the fallback user Admin User.');
  });
  it('the read asks for OwnerId and passes what it tells', () => {
    expect(R).toContain('`SELECT OwnerId, Owner.Name FROM ${obj} WHERE Id = ');
    expect(R).toContain("isQueue: /^00G/.test(String((r && r.OwnerId) || ''))");
    expect(R).toContain('srcIsQueue: src.isQueue, fallbackIsQueue: fbIsQueue,');
    expect(R).toContain("const fbIsQueue = /^00G/.test(String(om.fallbackUserId || ''));");
  });
});
