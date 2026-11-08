// The Owner row of ▸ record (user 2026-11-08: "we need to show ownerid and to make sure user can select queues or
// users"): the source owner by name, a search over the target's active users and the queues that take the object,
// a pick stored as the value OwnerId — which the engine writes after its own owner mapping (the ✏ TYPED VALUES
// stage) and the overwrite applies through sftkValOvApply.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const VE = readFileSync(new URL('../studio-valueedit.js', import.meta.url), 'utf8');
const BG = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../studio.css', import.meta.url), 'utf8');
const V = extractFunctions('sftk-valueedit.js', ['sftkValOvApply', 'sftkValEditFields']);

describe('the Owner row', () => {
  it('reads the source owner (and the target’s) with the record, only on an object that has owners', () => {
    expect(VE).toContain("const ownerFld = (desc.fields || []).find(f => f.name === 'OwnerId');");
    expect(VE).toContain("const ownerCanQueue = !!(ownerFld && (ownerFld.referenceTo || []).includes('Group'));");   // Owner.Type only where a queue can own (Account: "No such column")
    expect(VE).toContain("const ownCols = hasOwner ? ['OwnerId', 'Owner.Name', ...(ownerCanQueue ? ['Owner.Type'] : [])] : [];");
    expect(VE).toContain('records cannot be owned by a queue — users only');
    expect(VE).toContain('srcRec = await q(srcSess, ids[0], [...plain, ...extra, ...refIds, ...refs, ...rtCols, ...ownCols]);');
    expect(VE).toContain('if (!srcRec && ownCols.length) srcRec = await q(srcSess, ids[0], [...plain, ...extra, ...refIds, ...rtCols]);');   // an org that refuses Owner.Type
  });
  it('is drawn after Record Type: the source owner as 👤 / 👥 (queue), the default said in words, a pick with ✕ back to matching', () => {
    expect(VE).toContain('<tbody>${rtRow()}${ownerRow()}${fields.map(row).join(\'\')');
    expect(VE).toContain("const ownerText = o => o ? `${o.queue ? '👥' : '👤'} ${o.name}${o.queue ? ' (queue)' : ''}` : null;");
    expect(VE).toContain('data-ve-row="OwnerId" data-ve-search="owner ownerid user queue"');
    expect(VE).toContain("const mapOn = !!(p.ownerMapping && p.ownerMapping.mode === 'match');");
    expect(VE).toContain('you — the deployment’s owner mapping is off, so the source owner is not copied; pick a user or a queue here to say otherwise');
    expect(VE).toContain('in ${tgtL} if there is one, else the deployment’s fallback owner, else you');
    expect(VE).toContain("' — a queue is not matched by name'");
    expect(VE).toContain('data-ve-own-clear="1" title="Forget this pick — the owner is matched by name again">✕ back to matching</button>');
  });
  it('the search lists the queues that take this object and the active standard users of the target, each a pick', () => {
    expect(VE).toContain("SELECT Id, Name, Username FROM User WHERE IsActive = true AND UserType = 'Standard'${like} ORDER BY Name LIMIT 6");
    expect(VE).toContain("SELECT Id, Name, DeveloperName FROM Group WHERE Type = 'Queue' AND Id IN (SELECT QueueId FROM QueueSobject WHERE SobjectType = '${soql(obj)}')${like} ORDER BY Name LIMIT 6");
    expect(VE).toContain('Queues that take ${esc(obj)}');
    expect(VE).toContain('No queue takes ${esc(obj)} in ${esc(tgtL)}');
    expect(VE).toContain("for (const id2 of ids) sftkValOvSet(node, p.targetOrg, id2, 'OwnerId', id);");
    expect(VE).toContain("for (const id2 of ids) sftkValOvClear(node, p.targetOrg, id2, 'OwnerId');");
    expect(CSS).toContain('.ds-ve-own-hd');
  });
  it('the engine writes the pick: the typed-values stage runs after the owner mapping and does not skip OwnerId', () => {
    const i = BG.indexOf('// ✏ TYPED VALUES — written in place of the source'), j = BG.indexOf('// 🪪 IDENTITY STAMP', i);
    expect(i).toBeGreaterThan(0); expect(j).toBeGreaterThan(i);
    const stage = BG.slice(i, j);
    expect(stage).toContain('p[tf] = tv;');
    expect(stage).not.toContain('SFTK_LOOKUP_SYS');
    expect(BG.indexOf('if (wantOwners) {')).toBeLessThan(i);   // the owner mapping comes first; the pick wins
    // the pure apply used by the overwrite takes OwnerId like any field the target can update
    const p = {}; const out = V.sftkValOvApply(p, { OwnerId: '005xx' }, {}, new Set(['OwnerId', 'Name']), () => false);
    expect(p.OwnerId).toBe('005xx'); expect(out.used).toBe(1);
    // and the field list still leaves OwnerId to its own row
    expect(V.sftkValEditFields([{ name: 'OwnerId', createable: true, type: 'reference', referenceTo: ['User', 'Group'] }], {}, 'ins')).toEqual([]);
  });
});
