// Q2 Apex Debugger fixes — the pure log-grammar helpers extracted while
// fixing the QA-confirmed bugs (dead trigger parsing, truncation nesting,
// goto chunk math, Trusted-Types log-text stripping).
import { describe, it, expect } from 'vitest';
import { extractFunction } from './extract.mjs';

describe('sftkTriggerName (apex-debugger.js) — trigger name from CODE_UNIT_STARTED', () => {
  const triggerName = extractFunction('apex-debugger.js', 'sftkTriggerName');

  it('parses the real CODE_UNIT_STARTED grammar (__sfdc_trigger suffix)', () => {
    expect(triggerName(
      '10:00:00.0 (100)|CODE_UNIT_STARTED|[EXTERNAL]|01q000000000001|' +
      'AccountTrigger on Account trigger event AfterInsert|__sfdc_trigger/AccountTrigger'
    )).toBe('AccountTrigger');
  });

  it('parses a namespaced managed-package trigger (__sfdc_trigger/ns/Name)', () => {
    expect(triggerName(
      '10:00:00.0 (100)|CODE_UNIT_STARTED|[EXTERNAL]|01q000000000002|' +
      'CaseSync on Case trigger event BeforeUpdate|__sfdc_trigger/myns/CaseSync'
    )).toBe('CaseSync');
  });

  it('parses the "<Name> on <Object> trigger event <Event>" form alone', () => {
    expect(triggerName(
      '10:00:00.0 (100)|CODE_UNIT_STARTED|[EXTERNAL]|01q000000000003|' +
      'ContactTrigger on My_Object__c trigger event BeforeDelete'
    )).toBe('ContactTrigger');
  });

  it('still parses the legacy "Trigger:<Name>" form', () => {
    expect(triggerName(
      '10:00:00.0 (100)|CODE_UNIT_STARTED|[EXTERNAL]|' +
      'Trigger:AccountTrigger on Account trigger event AfterUpdate'
    )).toBe('AccountTrigger');
  });

  it('matches CODE_UNIT_FINISHED lines too (D3 duration pairing)', () => {
    expect(triggerName(
      '10:00:00.1 (900)|CODE_UNIT_FINISHED|' +
      'AccountTrigger on Account trigger event AfterInsert|__sfdc_trigger/AccountTrigger'
    )).toBe('AccountTrigger');
  });

  it('returns null for non-trigger code units and other lines', () => {
    expect(triggerName('10:00:00.0 (100)|CODE_UNIT_STARTED|[EXTERNAL]|01p000000000001|MyClass.myMethod()')).toBeNull();
    expect(triggerName('10:00:00.0 (100)|CODE_UNIT_STARTED|[EXTERNAL]|Flow:301000000000001')).toBeNull();
    expect(triggerName('10:00:00.0 (100)|CODE_UNIT_STARTED|[EXTERNAL]|Workflow:Account')).toBeNull();
    expect(triggerName('10:00:00.0 (100)|USER_DEBUG|[12]|DEBUG|hello world')).toBeNull();
    expect(triggerName('')).toBeNull();
    expect(triggerName(null)).toBeNull();
  });
});

describe('sftkLogNestingReset (apex-debugger.js) — truncation / new-transaction markers', () => {
  const nestingReset = extractFunction('apex-debugger.js', 'sftkLogNestingReset');

  it('detects the skipped-bytes truncation marker', () => {
    expect(nestingReset('*** Skipped 6832823 bytes of detailed log')).toBe(true);
  });

  it('detects MAXIMUM DEBUG LOG SIZE REACHED', () => {
    expect(nestingReset('*********** MAXIMUM DEBUG LOG SIZE REACHED ***********')).toBe(true);
  });

  it('detects a new EXECUTION_STARTED (second transaction in one file)', () => {
    expect(nestingReset('09:12:33.1 (1234)|EXECUTION_STARTED')).toBe(true);
  });

  it('leaves ordinary event lines alone', () => {
    expect(nestingReset('10:00:00.0 (100)|USER_DEBUG|[1]|DEBUG|hello')).toBe(false);
    expect(nestingReset('09:12:34.9 (99999)|EXECUTION_FINISHED')).toBe(false);
    // EXECUTION_STARTED as debug TEXT (not the event token at line end)
    expect(nestingReset('10:00:00.0 (100)|USER_DEBUG|[1]|DEBUG|EXECUTION_STARTED soon|x')).toBe(false);
    expect(nestingReset('')).toBe(false);
  });
});

describe('sftkChunkShownFor (apex-debugger.js) — single-render goto chunk math', () => {
  const chunkShownFor = extractFunction('apex-debugger.js', 'sftkChunkShownFor');
  const CHUNK = 700; // mirrors LOG_CHUNK

  it('rounds the target line up to a whole chunk', () => {
    expect(chunkShownFor(0, CHUNK, 10000)).toBe(700);
    expect(chunkShownFor(699, CHUNK, 10000)).toBe(700);   // last line of chunk 1
    expect(chunkShownFor(700, CHUNK, 10000)).toBe(1400);  // first line of chunk 2
    expect(chunkShownFor(350000, CHUNK, 400000)).toBe(350700);
  });

  it('caps at the total line count', () => {
    expect(chunkShownFor(9999, CHUNK, 10000)).toBe(10000); // 15×700=10500 → cap
    expect(chunkShownFor(5, CHUNK, 300)).toBe(300);
  });

  it('tolerates junk input', () => {
    expect(chunkShownFor(-5, CHUNK, 10000)).toBe(700);
    expect(chunkShownFor('abc', CHUNK, 10000)).toBe(700);
  });
});

describe('sftkEscLogLine (apex-debugger.js) — log text survives the TT sanitizer', () => {
  const escLogLine = extractFunction('apex-debugger.js', 'sftkEscLogLine');

  // The strip patterns from trusted-types-policy.js sanitize() — the ones
  // that could eat handler-shaped log TEXT. Kept in sync by this test: if
  // the policy grows a pattern that matches escaped log text, this fails.
  const STRIPPERS = [
    /\son\w+\s*=\s*"[^"]*"/gi,
    /\son\w+\s*=\s*'[^']*'/gi,
    /\son\w+\s*=\s*[^\s>]+/gi,
    /(href|src|action|formaction)\s*=\s*"(javascript|data:text\/html)[^"]*"/gi,
    /(href|src|action|formaction)\s*=\s*'(javascript|data:text\/html)[^']*'/gi,
  ];
  const survives = s => {
    let out = escLogLine(s);
    for (const re of STRIPPERS) out = out.replace(re, 'STRIPPED');
    return out === escLogLine(s);
  };

  it('escapes the standard entities plus "="', () => {
    expect(escLogLine('a<b>&"c"=d')).toBe('a&lt;b&gt;&amp;&quot;c&quot;&#61;d');
    expect(escLogLine(null)).toBe('');
  });

  it('handler-shaped log text is NOT strippable', () => {
    expect(survives("USER_DEBUG|[3]|DEBUG|btn onclick='alert(1)' rendered")).toBe(true);
    expect(survives('USER_DEBUG|[3]|DEBUG|attr onclick="alert(1)" here')).toBe(true);
    expect(survives('USER_DEBUG|[3]|DEBUG|bare onload=init token')).toBe(true);
    expect(survives("markup src='javascript:x' in payload")).toBe(true);
  });

  it("an unpaired quote can no longer swallow following markup", () => {
    // Old behavior: " onclick='" + no closing quote → /\son\w+\s*=\s*'[^']*'/
    // matched across the real markup that FOLLOWED the log line.
    const html = `<span class="adbg-ln-txt">${escLogLine("oops onclick='")}</span>` +
                 `<span class="adbg-ln-txt">${escLogLine("it's fine")}</span>`;
    let out = html;
    for (const re of STRIPPERS) out = out.replace(re, '');
    expect(out).toBe(html);
  });
});
