// owner 2026-11-20: "also text help with live example of words. on hover please." (the Match owners by options)
// and "can we put source and target in the same height."
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const BL = read('studio-builder.js'), CSS = read('studio.css');
const { bldOwnerMatchHelp: help } = extractFunctions('studio-builder.js', ['bldOwnerMatchHelp']);
const U = { Name: 'Omer Paz', Email: 'omer.paz@north.co', Username: 'omer.paz@north.co.uat', Alias: 'opaz' };
const KEYS = ['Email', 'Name', 'Username', 'Alias', 'FederationIdentifier', 'caseFold', 'trim', 'emailLower'];

describe('the hover text of a match option', () => {
  it('every option has one, with an example', () => {
    for (const k of KEYS) { const t = help(k, null); expect(t.length, k).toBeGreaterThan(60); expect(t, k).toContain('Example'); }
    expect(help('nope', null)).toBe('');
  });
  it('before the target is read the example user is said to be invented', () => {
    expect(help('Email', null)).toContain('Dana Levi, an invented user');
    expect(help('Email', null)).not.toContain('a user of');
  });
  it('with the target read, the example is a real user of it, in words', () => {
    expect(help('Email', U, 'npc2')).toBe('Compares the owner’s Email in the source with the Email of the users in npc2. Example with Omer Paz, a user of npc2: a record owned in the source by the user whose Email is "omer.paz@north.co" is given to Omer Paz. With more than one field ticked, all of them must be the same.');
    expect(help('caseFold', U, 'npc2')).toContain('"OMER PAZ" in the source matches "Omer Paz"');
    expect(help('trim', U, 'npc2')).toContain('" Omer Paz " in the source matches "Omer Paz"');
    expect(help('emailLower', U, 'npc2')).toContain('"Omer.paz@north.co" in the source matches "omer.paz@north.co"');
    expect(help('Username', U, 'npc2')).toContain('it rarely matches');
  });
  it('the options are gone from the Builder (owner 2026-11-22): no label carries it, and no real user is named in a help text', () => {
    expect(BL).not.toContain('data-owner-help="${name}"');
    expect(BL).not.toContain('l.dataset.help = bldOwnerMatchHelp(');
    expect(BL).toContain('SELECT Id, Name, Username, Email, Alias FROM User');
  });
});

describe('source and target', () => {
  it('hold the same three lines in the same order, and stretch to one height', () => {
    const src = BL.slice(BL.indexOf('ds-bld-col-src'), BL.indexOf('ds-builder-orgs-flow'));
    const tgt = BL.slice(BL.indexOf('ds-bld-col-tgt'), BL.indexOf('ds-builder-owner-row'));
    for (const col of [src, tgt]) expect(col.indexOf('<select')).toBeLessThan(col.indexOf('ds-bld-tgt-hint'));
    const row = CSS.slice(CSS.lastIndexOf('.ds-builder-orgs-row {\n  display: grid;'));
    expect(row.slice(0, row.indexOf('}'))).toContain('align-items: stretch;');
  });
});
