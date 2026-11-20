// QA 1.1 finding 32: a field named only inside a comment of Apex or LWC JavaScript is plain text, not a blocker.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

const S = extractFunctions('sftk-sweep.js', ['sftkSweepForms', 'sftkSweepHits', 'sftkSweepKindTable', 'sftkSweepSections', '_sftkSweepSectionAt', 'sftkSweepKind', 'sftkSweepRun', 'sftkSweepJoinKind', 'sftkSweepCsv']);
const NL = '\n';
const run = (files) => S.sftkSweepRun(new Map(files.map(([p, ...lines]) => [p, lines.join(NL)])), S.sftkSweepForms('Account', 'Status__c', 'Picklist'));
const rows = r => r.hits.map(h => `${h.line}:${h.type}/${h.sev}`);
const COMMENT = { type: 'DocText', sev: 'mention', section: 'named only in a code comment' };

describe('a comment is no reference', () => {
  it('the scenario: a class that names the object in live code and the field only in comments', () => {
    const r = run([['unpackaged/classes/A.cls',
      'public class A {',
      '  // Account.Status__c was removed from this query in 2023',
      '  /* old: acc.Status__c */',
      '  List<Account> q() { return [SELECT Id FROM Account]; }',
      '}']]);
    expect(r.hits).toHaveLength(2);
    for (const h of r.hits) expect(h).toMatchObject(COMMENT);
    expect(r.hits.some(h => h.sev === 'blocker')).toBe(false);
    expect(S.sftkSweepJoinKind('DocText')).toBeNull();                       // never joins the list
    expect(r.byType.DocText.why).toContain('in a comment of its code');
    expect(S.sftkSweepCsv(r, 'Account', 'Status__c')).toContain('plain text only - nothing breaks');
  });
  it('a block comment opened lines earlier, and a doc comment', () => {
    const r = run([['unpackaged/classes/B.cls',
      'public class B {',
      '  /**',
      '   * Reads the account.',
      '   * Used to copy Status__c to the contact.',
      '   */',
      '  void go(Account a) { a.Name = \'x\'; }',
      '  /* a.Status__c = null;',
      '     a.Status__c = \'Open\'; */',
      '}']]);
    expect(rows(r)).toEqual(['4:DocText/mention', '7:DocText/mention', '8:DocText/mention']);
  });
  it('a trigger and an LWC’s JavaScript the same way', () => {
    const r = run([
      ['unpackaged/triggers/T.trigger', 'trigger T on Account (before update) {', '  // Status__c is stamped by a flow now', '}'],
      ['unpackaged/lwc/card/card.js', "import NAME from '@salesforce/schema/Account.Name';", '// import STATUS from "@salesforce/schema/Account.Status__c";', 'export default class Card {}'],
    ]);
    expect(rows(r)).toEqual(['2:DocText/mention', '2:DocText/mention']);
  });
});

describe('live code keeps its kind', () => {
  it('a live mention beside a comment on the same line, and code after a block comment closes', () => {
    const r = run([['unpackaged/classes/C.cls',
      'public class C {',
      '  void go(Account a) {',
      '    a.Status__c = null; // clears Status__c',
      '    /* was: */ a.Status__c = \'x\';',
      '  }',
      '}']]);
    expect(rows(r)).toEqual(['3:ApexClass/blocker', '4:ApexClass/blocker']);
  });
  it('comment marks inside a string are text: the Accept header, a URL, dynamic SOQL', () => {
    const r = run([['unpackaged/classes/D.cls',
      'public class D {',
      "  String h = '*/*';",
      "  String u = 'https://x.example/a';   String q = 'SELECT Status__c FROM Account';",
      "  String w = '/* not a comment'; String z = 'SELECT Status__c FROM Account'; // */",
      '}']]);
    expect(rows(r)).toEqual(['3:ApexClass/blocker', '4:ApexClass/blocker']);
  });
  it('a JavaScript template literal that runs over lines is code, whatever it holds', () => {
    const r = run([['unpackaged/lwc/q/q.js',
      "import ACCOUNT from '@salesforce/schema/Account';",
      'const q = `SELECT Id, // first',
      '  Status__c FROM Account`;',
      'export default class Q {}']]);
    expect(rows(r)).toEqual(['3:LightningComponentBundle/blocker']);
  });
  it('Visualforce is not judged by its comments: a page evaluates a merge field wherever it stands', () => {
    const r = run([['unpackaged/pages/P.page', '<apex:page standardController="Account">', '<!-- {!Account.Status__c} -->', '<script>// {!Account.Status__c}</script>', '</apex:page>']]);
    expect(rows(r)).toEqual(['2:ApexPage/blocker', '3:ApexPage/blocker']);
  });
});
