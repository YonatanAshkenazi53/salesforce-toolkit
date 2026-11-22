// QA 1.1 regression run, finding #14: when the target's queues cannot be read, a fallback QUEUE was dropped (every
// unmatched record went to the running user) while the run said "queue-owned records go to the fallback" and then
// "the fallback queue does not take <Object> records in the target" — which nobody had established.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const BG = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const { sftkQueueOwnerMap: qmap, sftkOwnerFallbackFor: fbFor } = extractFunctions('background.js', ['sftkQueueOwnerMap', 'sftkOwnerFallbackFor']);

const QUEUE = '00G999000000007AAA', USER = '005000000000001AAA';
// what the catch of the queue read builds
const unread = ownerFallback => { const fbIsQueue = /^00G/.test(String(ownerFallback || '')); return qmap([], fbIsQueue ? [{ QueueId: ownerFallback }] : []); };

describe('#14 the queues of the target could not be read', () => {
  it('a fallback queue is kept, in its 15 or 18 character form', () => {
    expect(fbFor(QUEUE, unread(QUEUE))).toBe(QUEUE);
    expect(fbFor(QUEUE.slice(0, 15), unread(QUEUE.slice(0, 15)))).toBe(QUEUE.slice(0, 15));
  });
  it('a fallback user stays, no fallback stays none, and no source queue is matched to anything', () => {
    expect(fbFor(USER, unread(USER))).toBe(USER);
    expect(fbFor('', unread(''))).toBe(null);
    expect(unread(QUEUE).bySrc).toEqual({});
    expect(unread(USER).takes).toEqual({});
  });
  it('the old behaviour (an empty map) is what dropped it; a read that worked still drops a queue that does not take the object', () => {
    expect(fbFor(QUEUE, qmap([], []))).toBe(null);
    expect(fbFor(QUEUE, qmap([], [{ QueueId: '00G999000000055AAA', Queue: { DeveloperName: 'Other' } }]))).toBe(null);
  });
  it('the engine builds that map in the catch and no longer an empty one', () => {
    expect(BG).toContain("qMap = sftkQueueOwnerMap([], fbIsQueue ? [{ QueueId: ownerFallback }] : []);");
    expect(BG).not.toContain('qMap = sftkQueueOwnerMap([], []);');
    expect(BG.indexOf('const fbIsQueue =')).toBeLessThan(BG.indexOf('qMap = sftkQueueOwnerMap([], fbIsQueue'));
    expect(BG.indexOf('qMap = sftkQueueOwnerMap([], fbIsQueue')).toBeLessThan(BG.indexOf('const nodeFallback = sftkOwnerFallbackFor(ownerFallback, qMap);'));
  });
  it('the run says the fallback queue was used unchecked, and "does not take" is said only when the read worked', () => {
    expect(BG).toContain("queue-owned records go to the fallback${fbIsQueue ? `, and the fallback queue is used without a check that it takes ${objType} records (the target refuses a record if it does not)` : ''}.");
    // "does not take" needs a null nodeFallback, which a failed read can no longer produce for a queue
    expect(BG).toContain('if (fbIsQueue && !nodeFallback && ownerDefaulted) errors.push(');
  });
});
