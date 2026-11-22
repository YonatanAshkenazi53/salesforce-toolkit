// owner 2026-11-20: "i want to use the owner from the source if possible, if not to allow selection of a fallback
// user or queue." — a queue-owned record keeps its queue (same API name, where the target queue takes the object);
// the fallback can be a user or a queue, and a queue is used only on an object it takes.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const BG = read('background.js'), RC = read('studio-reconcile.js'), BL = read('studio-builder.js');
const bg = extractFunctions('background.js', ['sftkQueueOwnerMap', 'sftkOwnerFallbackFor']);
const rc = extractFunctions('studio-reconcile.js', ['sftkQueueOwnerMap', 'sftkOwnerFallbackFor', 'sftkRecOwnerThenTyped']);
const fnText = (src, name) => { const i = src.indexOf(`function ${name}(`); return src.slice(i, src.indexOf('\n}', i) + 2); };

const SRC = [{ Id: '00G000000000001AAA', DeveloperName: 'Support' }, { Id: '00G000000000002AAA', DeveloperName: 'Only_In_Source' }];
const TGT = [{ QueueId: '00G999000000001AAA', Queue: { DeveloperName: 'support' } }, { QueueId: '00G999000000007AAA', Queue: { DeveloperName: 'Tier2' } }];

describe('a queue between orgs', () => {
  it('is matched by its API name, whatever the case, to a target queue that takes the object', () => {
    const m = bg.sftkQueueOwnerMap(SRC, TGT);
    expect(m.bySrc).toEqual({ '00G000000000001': '00G999000000001AAA' });
    expect(Object.keys(m.takes).sort()).toEqual(['00G999000000001', '00G999000000007']);
  });
  it('nothing read is nothing matched', () => {
    expect(bg.sftkQueueOwnerMap(null, null)).toEqual({ bySrc: {}, takes: {} });
  });
  it('the page and the engine hold the same two functions', () => {
    for (const n of ['sftkQueueOwnerMap', 'sftkOwnerFallbackFor']) expect(fnText(RC, n)).toBe(fnText(BG, n));
  });
});

describe('the fallback an object can take', () => {
  const m = bg.sftkQueueOwnerMap(SRC, TGT);
  it('a user always; a queue only where it takes the object; none is none', () => {
    expect(bg.sftkOwnerFallbackFor('005000000000001AAA', null)).toBe('005000000000001AAA');
    expect(bg.sftkOwnerFallbackFor('00G999000000007AAA', m)).toBe('00G999000000007AAA');
    expect(bg.sftkOwnerFallbackFor('00G999000000055AAA', m)).toBe(null);
    expect(bg.sftkOwnerFallbackFor('00G999000000007AAA', null)).toBe(null);
    expect(bg.sftkOwnerFallbackFor('', m)).toBe(null);
  });
});

describe('an update: the queue of the source first', () => {
  const m = rc.sftkQueueOwnerMap(SRC, TGT);
  const run = o => { const p = {}; const out = rc.sftkRecOwnerThenTyped(p, { wantOwners: true, ownerByName: new Map([['Support', '005WRONG']]), ...o }, null); return { owner: p.OwnerId, ...out }; };
  it('a queue-owned record gets the target queue, never a user who happens to share its name', () => {
    expect(run({ ownerName: 'Support', srcOwnerId: SRC[0].Id, queueBySrc: m.bySrc }).owner).toBe('00G999000000001AAA');
  });
  it('no such queue: the fallback, and with none the owner stays', () => {
    expect(run({ ownerName: 'Only In Source', srcOwnerId: SRC[1].Id, queueBySrc: m.bySrc, ownerFallback: '005FB' })).toMatchObject({ owner: '005FB', fellBack: 1 });
    expect(run({ ownerName: 'Only In Source', srcOwnerId: SRC[1].Id, queueBySrc: m.bySrc, ownerFallback: null })).toMatchObject({ owner: undefined, kept: 1 });
  });
});

describe('the engine and the Builder', () => {
  it('the insert reads OwnerId only to tell a queue from a user, and never copies it as is', () => {
    expect(BG).toContain("if (!fields.includes('OwnerId')) fields.push('OwnerId');");
    expect(BG).toContain("'CreatedById','LastModifiedById','IsDeleted','OwnerId'].includes(f.name)) continue;");
    expect(BG).toContain('const mq = qMap ? qMap.bySrc[srcOid.slice(0, 15)] : null;');
    expect(BG).toContain('const nodeFallback = sftkOwnerFallbackFor(ownerFallback, qMap);');
  });
  it('a fallback queue that does not take the object is said, with who got the records', () => {
    expect(BG).toContain('the fallback queue does not take ${objType} records in the target, so ${ownerDefaulted} record(s) with no matching owner belong to the user who ran the deployment.');
  });
  it('the picker comes after the match fields, as step 2', () => {
    expect(BL.indexOf('data-owner-match-field')).toBeLessThan(BL.indexOf('id="dsProfileOwnerFallbackWrap"'));
    expect(BL).toContain('1. A user is looked up in the target by these fields, a queue by its API name.');
  });
  it('one picker: you, the target’s users, the target’s queues', () => {
    expect(BL).toContain('<span class="ds-builder-owner-fb-lbl">2. Only when that finds no one, give the record to</span>');
    expect(BL).toContain('<option value="">${esc(bldOwnerYouLabel(me))}</option>');
    expect(BL).toContain('<optgroup label="Users">');
    expect(BL).toContain('<optgroup label="Queues — used on the objects each queue takes">');
    expect(BL).toContain("query: `SELECT Id, Name, DeveloperName FROM Group WHERE Type = 'Queue' ORDER BY Name`");
  });
});
