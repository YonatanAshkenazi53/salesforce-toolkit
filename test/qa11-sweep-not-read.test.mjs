// QA 1.1 finding 34: the "Kinds not read" sentence names every skipped kind that can hold a field's name, and no longer says text static resources are unread.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

const S = extractFunctions('sftk-sweep.js', ['_sftkSweepSkip', '_sftkSweepFolderKinds', 'sftkSweepTypes', 'sftkSweepTextResource', 'sftkSweepNotRead']);

describe('sftkSweepNotRead — the sentence matches what the sweep does', () => {
  const line = S.sftkSweepNotRead();
  // each skipped kind that holds field names, and the words that stand for it in the sentence
  const SAID = {
    Territory2Rule: 'territory assignment rules',
    Audience: 'Experience audiences',
    WaveDataflow: 'CRM Analytics dataflows and recipes',
    WaveRecipe: 'CRM Analytics dataflows and recipes',
    MutingPermissionSet: 'muting permission sets',
    Document: 'documents',
    ContentAsset: 'content and site assets',
    Settings: 'settings',
    Certificate: 'certificates',
    InstalledPackage: 'installed from a managed package',
  };
  it('names each of them, and each is really skipped', () => {
    const types = S.sftkSweepTypes(Object.keys(SAID).map(name => ({ name, inFolder: false }))).map(t => t.name);
    for (const [kind, words] of Object.entries(SAID)) {
      expect(types, kind).not.toContain(kind);        // if a kind is read one day, this sentence must change with it
      expect(line, kind).toContain(words);
    }
  });
  it('says binary static resources only: the org’s own text ones are read', () => {
    expect(S.sftkSweepTextResource({ ContentType: 'application/javascript', BodyLength: 2000, NamespacePrefix: null })).toBe(true);
    expect(S.sftkSweepTextResource({ ContentType: 'image/png', BodyLength: 2000, NamespacePrefix: null })).toBe(false);
    expect(S.sftkSweepTextResource({ ContentType: 'text/plain', BodyLength: 1000001, NamespacePrefix: null })).toBe(false);
    expect(line).toContain('binary static resources (images, fonts, zips, or a file over 1 MB)');
    expect(line).not.toMatch(/not read: static resources/);
  });
  it('is one plain sentence', () => {
    expect(line.startsWith('Kinds not read: ')).toBe(true);
    expect(line.endsWith('.')).toBe(true);
    expect(line).not.toMatch(/[<>&]/);                // goes into the page as it is
  });
});
