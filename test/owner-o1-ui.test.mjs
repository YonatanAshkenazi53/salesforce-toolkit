// Owner matching field picker (O1-UI) — the pure state helpers behind the
// Profile Builder's "Match owners by" block. The invariant that matters:
// profiles saved BEFORE configurable matching must keep rendering (and
// running) the legacy Name-only path until the user touches a control.
import { describe, it, expect } from 'vitest';
import { extractFunction } from './extract.mjs';

const display      = extractFunction('studio-builder.js', 'bldOwnerMatchingDisplay');
const fromControls = extractFunction('studio-builder.js', 'bldOwnerMatchingFromControls');

describe('bldOwnerMatchingDisplay (studio-builder.js) — what the block shows', () => {
  it('legacy match-mode profile WITHOUT matching config shows Name-only, no normalization', () => {
    expect(display({ mode: 'match', fallbackUserId: '005xx0000012345' }))
      .toEqual({ fields: ['Name'], normalize: {} });
  });

  it('skip mode / absent ownerMapping previews the fresh-switch default', () => {
    const def = { fields: ['Email', 'Name'], normalize: { emailLower: true, trim: true } };
    expect(display(undefined)).toEqual(def);
    expect(display(null)).toEqual(def);
  });

  it('an existing matching config wins and round-trips', () => {
    const m = { fields: ['Username', 'Alias'], normalize: { caseFold: true } };
    expect(display({ mode: 'match', matching: m }))
      .toEqual({ fields: ['Username', 'Alias'], normalize: { caseFold: true } });
  });

  it('sanitizes stored config: canonical order, unknown fields dropped, capped at 4', () => {
    const out = display({ mode: 'match', matching: {
      fields: ['Alias', 'Bogus__c', 'FederationIdentifier', 'Email', 'Username', 'Name'],
      normalize: {}
    } });
    // canonical order, Bogus__c gone, 5 known → capped to first 4
    expect(out.fields).toEqual(['Email', 'Name', 'Username', 'Alias']);
  });

  it('matching with an empty/blank fields list falls back to the legacy display', () => {
    expect(display({ mode: 'match', matching: { fields: ['', null], normalize: {} } }))
      .toEqual({ fields: ['Name'], normalize: {} });
  });
});

describe('bldOwnerMatchingFromControls (studio-builder.js) — persisting control state', () => {
  it('orders fields canonically regardless of click order', () => {
    expect(fromControls(['Alias', 'Email'], {}).fields).toEqual(['Email', 'Alias']);
  });

  it('caps at 4 fields and drops unknown names', () => {
    const out = fromControls(
      ['FederationIdentifier', 'Username', 'Nope', 'Name', 'Alias', 'Email'], {});
    expect(out.fields).toEqual(['Email', 'Name', 'Username', 'Alias']);
    expect(out.fields).toHaveLength(4);
  });

  it('coerces the three normalize toggles to booleans, absent → false', () => {
    expect(fromControls(['Email'], { emailLower: 1, caseFold: undefined }).normalize)
      .toEqual({ emailLower: true, caseFold: false, trim: false });
  });

  it('tolerates junk input without throwing', () => {
    expect(fromControls(null, null))
      .toEqual({ fields: [], normalize: { emailLower: false, caseFold: false, trim: false } });
  });

  it('the seeded default survives a store round-trip unchanged (display ↔ controls agree)', () => {
    const seeded = fromControls(['Email', 'Name'], { emailLower: true, trim: true });
    expect(seeded.fields).toEqual(['Email', 'Name']);
    // what display would then show for that stored config
    expect(display({ mode: 'match', matching: seeded }).fields).toEqual(['Email', 'Name']);
  });
});
