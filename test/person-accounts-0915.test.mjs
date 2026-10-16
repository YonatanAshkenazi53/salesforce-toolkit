import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// 2026-09-15 — user's live run trailheads2 → trailheads4: 10 × "Unable to
// create/update fields: Name". Verified on npc by CLI: the records are Person
// Accounts (IsPersonAccount = true). Salesforce derives a person account's Name
// from FirstName/LastName and refuses the whole Name on insert AND update.
const BG = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');

describe('Person Accounts: the whole Name is never sent', () => {
  it('the engine payload drops Name on a person account when the target takes the parts', () => {
    const i = BG.indexOf('const payloads = recs.map((r, recIdx) => {');
    expect(i).toBeGreaterThan(0);
    const fn = BG.slice(i, i + 3000);
    expect(fn).toContain("f.name === 'Name' && r.IsPersonAccount === true");
    expect(fn).toContain("tgtCreatable.has('LastName')");
    expect(fn).toContain('personAsBusiness++');
  });
  it('the run says how many person accounts it handled, and when they landed as business accounts', () => {
    expect(BG).toContain('Person Account(s) — Name is derived from FirstName/LastName');
    expect(BG).toContain('written as BUSINESS accounts');
  });
  it('the source SELECT carries the flag the payload builder keys on', () => {
    const i = BG.indexOf('function buildCopyFields(describe)');
    expect(BG.slice(i, i + 2500)).toContain("f.name === 'IsPersonAccount'");
  });
  it('⚖ Transfer overwrite reads the flag and skips Name on person accounts', () => {
    const fn = RC.slice(RC.indexOf('async function reconcileOverwrite('));
    expect(fn).toContain("descByLower['ispersonaccount'] ? ['IsPersonAccount'] : []");
    expect(fn).toContain("sf === 'Name' && sr.IsPersonAccount === true");
  });
});


// 2026-09-16 — the follow-up on the same orgs: the Accounts went in, then
// Contact failed 10 × "Cannot select a person account". Those are the hidden
// Contacts Salesforce creates with each Person Account — not records to deploy.
const SC = readFileSync(new URL('../studio-scan.js', import.meta.url), 'utf8');
const HI = readFileSync(new URL('../studio-history.js', import.meta.url), 'utf8');
describe('Person Account CONTACTS are left out everywhere, and said so', () => {
  it('the engine drops them before anything else uses the record set, counts them, and discloses', () => {
    const i = BG.indexOf("if (objType === 'Contact') {");
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(BG.indexOf('nodeSourceIds.set(node, recs.map(r => r.Id));'));
    expect(BG).toContain("recs = recs.filter(r => r.IsPersonAccount !== true);");
    expect(BG).toContain('Person Account contact(s) left out');
    expect(BG).toContain('...(personContactsSkipped ? { personContactsSkipped } : {}),');
  });
  it('the scan reads the flag on the side that has it, and they still take part in matching', () => {
    expect(SC).toContain("(side === 'src' ? srcTypes : tgtTypes).has('IsPersonAccount') ? ['IsPersonAccount'] : []");
    expect(SC).toContain('if (r && r.IsPersonAccount === true) _paSrc.add(r.Id);');
    expect(SC).not.toContain('const keep = all.filter(r => r.IsPersonAccount !== true);');
    expect(SC).toContain('...(_paContacts ? { personContacts: _paContacts } : {}),');
  });
  it('2026-09-18: a matched pair SHOWS as synced; nothing about them is ever offered', () => {
    const i = SC.indexOf('Person Account contacts: never OFFERED.');
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(SC.indexOf('const BUCKET_CAP = 5000;'));
    const pass = SC.slice(i, SC.indexOf('const BUCKET_CAP = 5000;'));
    expect(pass).toContain('c.waiting    = drop(missingInTarget, bySrc);');
    expect(pass).toContain('drop(changed, r => bySrc(r) || byTgt(r)) + drop(linkMismatch');
    expect(pass).toContain('c.targetOnly = drop(onlyInTarget, byTgt);');
    expect(pass).toContain('r.personAccount = true; c.synced++;');
    expect(pass).not.toMatch(/drop\(identical/);
  });
  it('History and the Transfer header show the count', () => {
    expect(HI).toContain('Person Account contact(s) left out');
    expect(RC).toContain('scan.personContacts');
  });
});


import { extractFunction } from './extract.mjs';
describe('the Person Account contacts line says what happened to each group', () => {
  const line = extractFunction('studio-reconcile.js', 'sftkPaContactsLine');
  it('says nothing when there are none', () => {
    expect(line(null, 'A', 'B')).toBe('');
    expect(line({ src: 0, tgt: 0 }, 'A', 'B')).toBe('');
  });
  it('names synced, waiting, following and target-only separately', () => {
    const s = line({ src: 10, tgt: 10, synced: 10, waiting: 0, follows: 0, targetOnly: 0 }, 'trailheads2', 'trailheads4');
    expect(s).toContain('10 in trailheads2, 10 in trailheads4');
    expect(s).toContain('10 synced');
    expect(s).toContain('never offered for insert, update or delete');
    const w = line({ src: 10, tgt: 0, synced: 0, waiting: 10, follows: 0, targetOnly: 0 }, 'A', 'B');
    expect(w).toContain('10 arrive with their Person Account');
    const f = line({ src: 3, tgt: 4, synced: 1, waiting: 0, follows: 2, targetOnly: 1 }, 'A', 'B');
    expect(f).toContain("2 differ — they follow their Account");
    expect(f).toContain('1 exist only in B');
  });
  it('the synced rows carry the tag', () => {
    expect(RC).toContain("r.personAccount ? '<span class=\"ds-rec-pnote\"");
  });
});
