// 2026-11-22, the owner on the Builder's "Match owners by" row:
//   "i dont think its a correct logic to match owners. just check and find the owner from the source, this matching is
//    confusing we need to check for it alone" / "u used my name as example. dont use my name on help texts"
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
const rd = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const BG = rd('background.js'), RC = rd('studio-reconcile.js'), BL = rd('studio-builder.js'), TR = rd('studio-transfer.js');
const block = s => s.slice(s.indexOf('// ── OWNER MATCHING ON ITS OWN'), s.indexOf('// ── end of OWNER MATCHING ON ITS OWN'));
const { index, find, byText, keys } = new Function(block(BG) + '\nreturn { index: sftkOwnerAutoIndex, find: sftkOwnerAutoFind, byText: sftkOwnerAutoByText, keys: sftkOwnerAutoKeys };')();

describe('one rule, in two places', () => {
  it('the insert engine and the update path carry the same text', () => {
    expect(block(BG).length).toBeGreaterThan(1500);
    expect(block(RC)).toBe(block(BG));
  });
});

describe('an owner is found on its own', () => {
  const T = [
    { Id: 'T1', Name: 'Dana Levi', Email: 'dana@acme.test', FederationIdentifier: 'F-1' },
    { Id: 'T2', Name: 'Avi Cohen', Email: 'shared@acme.test' },
    { Id: 'T3', Name: 'Noa Bar', Email: 'shared@acme.test' },
    { Id: 'T4', Name: 'Omer Paz', Email: 'omer@acme.test.invalid' },
    { Id: 'T5', Name: 'Twin Name', Email: 'a@acme.test' },
    { Id: 'T6', Name: 'Twin Name', Email: 'b@acme.test' },
  ];
  const idx = index(T);
  it('by Federation ID first, whatever the name and the email say', () => {
    expect(find(idx, { Name: 'D. Levi', Email: 'other@x.test', FederationIdentifier: ' f-1 ' })).toEqual({ id: 'T1', by: 'fed' });
  });
  it('then by email and name: an email two users share is settled by the name', () => {
    expect(find(idx, { Name: 'noa  bar', Email: 'Shared@Acme.test' })).toEqual({ id: 'T3', by: 'emailName' });
  });
  it('then by email alone, when the name is written differently', () => {
    expect(find(idx, { Name: 'Dana L.', Email: 'DANA@acme.test ' })).toEqual({ id: 'T1', by: 'email' });
  });
  it('a sandbox email (".invalid") is the same email', () => {
    expect(find(idx, { Name: 'Omer P', Email: 'omer@acme.test' })).toEqual({ id: 'T4', by: 'email' });
    expect(keys({ Email: 'X@Y.test.INVALID' }).email).toBe('x@y.test');
  });
  it('then by name, when the email is another one', () => {
    expect(find(idx, { Name: 'avi cohen', Email: 'avi@elsewhere.test' })).toEqual({ id: 'T2', by: 'name' });
    expect(find(idx, { Name: 'Avi Cohen' })).toEqual({ id: 'T2', by: 'name' });
  });
  it('more than one user and nothing to settle it is never a guess', () => {
    expect(find(idx, { Name: 'Twin Name', Email: 'c@acme.test' })).toEqual({ id: '', by: '', several: true });
    expect(find(idx, { Name: 'Somebody Else', Email: 'shared@acme.test' })).toEqual({ id: '', by: '', several: true });
  });
  it('no one is no one', () => {
    expect(find(idx, { Name: 'Nobody', Email: 'nobody@acme.test' })).toEqual({ id: '', by: '', several: false });
    expect(find(idx, null)).toEqual({ id: '', by: '', several: false });
    expect(find(index([]), { Name: 'Dana Levi' })).toEqual({ id: '', by: '', several: false });
  });
  it('the run says by what the owners were found', () => {
    expect(byText({ email: 3, emailName: 8, name: 1 })).toBe('8 by email and name, 3 by email, 1 by name');
    expect(byText({})).toBe('');
  });
});

describe('the engine reads no setting', () => {
  it('inserts: the saved "match by" fields are not read; the target users are indexed once, the source owners read once', () => {
    expect(BG).not.toContain('profile.ownerMapping.matching');
    expect(BG).toContain("ownerAutoIdx = sftkOwnerAutoIndex(users);");
    expect(BG).toContain('const found = su ? sftkOwnerAutoFind(ownerAutoIdx, su) : { id: \'\', by: \'\', several: false };');
    expect(BG).toContain('if (ownerKeyDup || ownerFellBack || ownerDefaulted) {');
    expect(BG).toContain('found more than once → fallback');
  });
  it('updates: the same rule, not a lookup by name', () => {
    expect(RC).not.toContain('SELECT Id, Name FROM User WHERE IsActive = true AND Name IN (');
    expect(RC).toContain('ownerBySrc[k] = su ? sftkOwnerAutoFind(idx, su).id : \'\';');
    expect(RC).toContain(": (o.ownerBySrc ? o.ownerBySrc[String(o.srcOwnerId || '').slice(0, 15)] : (o.ownerByName && o.ownerByName.get(o.ownerName)));");
  });
  it('the Builder shows no "match by" boxes and names no real user in a help text', () => {
    const blk = BL.slice(BL.indexOf('<div id="dsOwnerMatchBlock"'), BL.indexOf('id="dsProfileOwnerFallbackWrap"'));
    expect(blk).not.toContain('checkbox');
    expect(blk).not.toContain('Match owners by');
    expect(BL).not.toContain('the hover examples now speak of a real user of this target');
  });
  it('the dry run warns when the PII policy masks what an owner is found by', () => {
    expect(TR).toContain("for (const ownerField of ['Email', 'Name', 'FederationIdentifier']) {");
  });
});
