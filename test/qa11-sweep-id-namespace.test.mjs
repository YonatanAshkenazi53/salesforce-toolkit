// QA 1.1 finding 36: the Tooling id lookup of a joined code hit asks for the org's own (unnamespaced) component only.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

const S = extractFunctions('sftk-sweep.js', ['sftkSweepIdQuery']);

// a tiny stand-in for the Tooling query: the rows of one sobject, filtered the way the SOQL asks
function answer(soql, rows) {
  const m = /^SELECT Id FROM (\w+) WHERE (Name|DeveloperName) = '((?:[^'\\]|\\.)*)'( AND NamespacePrefix = null)?$/.exec(soql);
  if (!m) throw new Error('unexpected query: ' + soql);
  const name = m[3].replace(/\\'/g, "'");
  return rows.filter(r => r.sobject === m[1] && r[m[2]] === name && (!m[4] || r.NamespacePrefix == null));
}

describe('sftkSweepIdQuery — an own class and a packaged class of the same name', () => {
  const rows = [
    { sobject: 'ApexClass', Id: '01pPACKAGED', Name: 'Utils', NamespacePrefix: 'ns' },      // listed first, as an org may answer
    { sobject: 'ApexClass', Id: '01pOWN', Name: 'Utils', NamespacePrefix: null },
    { sobject: 'ApexClass', Id: '01pONLYPKG', Name: 'PkgOnly', NamespacePrefix: 'ns' },
    { sobject: 'LightningComponentBundle', Id: '0RbPACKAGED', DeveloperName: 'card', NamespacePrefix: 'ns' },
    { sobject: 'LightningComponentBundle', Id: '0RbOWN', DeveloperName: 'card', NamespacePrefix: null },
  ];
  it('the first row is the org’s own one', () => {
    expect(answer(S.sftkSweepIdQuery('ApexClass', 'Utils'), rows)[0].Id).toBe('01pOWN');
    expect(answer(S.sftkSweepIdQuery('LightningComponentBundle', 'lwc/card'), rows)[0].Id).toBe('0RbOWN');
  });
  it('only a packaged one of that name: nothing is found, so the hit stays in the sweep’s box', () => {
    expect(answer(S.sftkSweepIdQuery('ApexClass', 'PkgOnly'), rows)).toEqual([]);
  });
  it('every code kind carries the filter; other kinds have no lookup', () => {
    for (const k of ['ApexClass', 'ApexTrigger', 'ApexPage', 'ApexComponent']) expect(S.sftkSweepIdQuery(k, 'X')).toBe(`SELECT Id FROM ${k} WHERE Name = 'X' AND NamespacePrefix = null`);
    expect(S.sftkSweepIdQuery('LightningComponentBundle', 'x')).toBe("SELECT Id FROM LightningComponentBundle WHERE DeveloperName = 'x' AND NamespacePrefix = null");
    expect(S.sftkSweepIdQuery('ApexPage', "O'Brien")).toBe("SELECT Id FROM ApexPage WHERE Name = 'O\\'Brien' AND NamespacePrefix = null");
    expect(S.sftkSweepIdQuery('ValidationRule', 'Account.X')).toBeNull();
  });
});
