// owner 2026-11-19: "we can't select here the owner matching like we once had i think." · "we said it will look for the
// same user, if not it will fallback to the current user" · "but record should also let you edit if you want" ·
// "here you dont see who will be the user in the target." — the record editor's Owner row says who the record will
// belong to, by name; the Builder's setting says the rule in those words and a NEW deployment starts on it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const VE = read('studio-valueedit.js'), BL = read('studio-builder.js');
const { sftkVeOwnerWill: w } = extractFunctions('studio-valueedit.js', ['sftkVeOwnerWill']);
const T = { tgtL: 'npc2' };

describe('who the record will belong to', () => {
  it('owners not copied: the user who runs the deployment, by name — and how to give it to someone else', () => {
    expect(w({ mapOn: false, me: 'Dana Levi', ...T })).toBe('Dana Levi (you — the user who runs the deployment). This deployment does not copy owners — pick a user or a queue here to give the record to someone else.');
    expect(w({ mapOn: false, me: '', ...T })).toBe('you — the user who runs the deployment. This deployment does not copy owners — pick a user or a queue here to give the record to someone else.');
    expect(w({ mapOn: false, many: true, me: 'Dana Levi', ...T })).toBe('Dana Levi (you — the user who runs the deployment). This deployment does not copy owners.');
  });
  it('owners matched: the same user in the target; when there is none, the fallback user — or, with none set, the running user', () => {
    expect(w({ mapOn: true, src: { name: 'Omer Paz' }, me: 'Dana Levi', ...T })).toBe('the user in npc2 that matches Omer Paz — and when there is no such user, Dana Levi (you — the user who runs the deployment).');
    expect(w({ mapOn: true, src: { name: 'Omer Paz' }, me: 'Dana Levi', fallbackName: 'Admin User', ...T })).toBe('the user in npc2 that matches Omer Paz — and when there is no such user, the fallback owner Admin User.');
    expect(w({ mapOn: true, many: true, me: 'Dana Levi', ...T })).toBe('each record’s owner, matched in npc2 — and where there is no such user, Dana Levi (you — the user who runs the deployment).');
  });
  it('a queue is not matched between orgs, and that is said', () => {
    expect(w({ mapOn: true, src: { name: 'Support', queue: true }, me: 'Dana Levi', ...T })).toBe('the queue in npc2 with the same API name as Support, when it takes this object — and when there is none, Dana Levi (you — the user who runs the deployment).');
  });
  it('the running user’s name is read from the target with the record, once per org', () => {
    expect(VE).toContain("path: 'services/oauth2/userinfo'");
    expect(VE).toContain('runMe = await sftkVeRunningUser(ts);');
    expect(VE).toContain('<span class="ds-ve-own-will">${esc(dfl)}</span>');
  });
});

describe('the deployment’s Record owners setting', () => {
  it('says the rule in plain words, the matching way first; no fallback means the running user', () => {
    expect(BL).toContain('>Keep the source’s owner — the same user or queue in the target</option>');
    expect(BL).toContain(">Don't copy owners — every record belongs to you (the user who runs the deployment)</option>");
    expect(BL).toContain("'You — the user who runs the deployment'");
    expect(BL.indexOf('<option value="match"')).toBeLessThan(BL.indexOf('<option value="skip"'));
  });
  it('a new deployment keeps the same owner; a saved one is opened as it was saved', () => {
    expect(BL).toContain("ownerMapping: { mode: 'match', fallbackUserId: null, fallbackUserName: null, matching: bldOwnerMatchingFromControls(['Email', 'Name'], { emailLower: true, trim: true }) },");
    expect(BL).toContain('? JSON.parse(JSON.stringify(existingProfile))');
  });
});
