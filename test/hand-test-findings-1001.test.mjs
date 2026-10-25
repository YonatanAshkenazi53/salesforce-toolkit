// Findings from the user's hand test of the Deploy page (2026-09-30 / 10-01).
//  1. The ring rescan toast named the TARGET org and quoted Salesforce's raw
//     SOQL error when the crowned SOURCE lacked a deployment's root object.
//  2. The run log painted the engine's ℹ notes (Bulk API choice, person-account
//     name parts, the 🔗 lookups disclosure) as red ❌ after one real failure.
//  3. The duplicated-names summary said "5 name(s)" — the number of EXAMPLES
//     shown — while 350 records sat under ⚠ Ambiguous.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const FE = readFileSync(new URL('../sftk-friendly-error.js', import.meta.url), 'utf8');
const RG = readFileSync(new URL('../studio-ring.js', import.meta.url), 'utf8');
const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../studio.css', import.meta.url), 'utf8');

const RAW = "HTTP 400: SELECT Id,Ext_Id__c FROM Load_Parent__c ^ ERROR at Row:1:Column:26 sObject type 'Load_Parent__c' is not supported. If you are attempting to use a custom object, be sure to append the '__c' after the entity name. Please reference your WSDL or the describe call for the appropriate names.";

// The helper file is a classic script with one top-level function; materialize
// it whole (the regex-heavy body defeats the slice-based extractor).
const friendly = new Function(`${FE}\nreturn sftkFriendlyError;`)();
// Source slice of a page-global function, closing brace included.
const src = (file, name) => {
  const i = file.indexOf(`function ${name}(`);
  if (i < 0) return '';
  return file.slice(i, file.indexOf('\n}\n', i) + 3);
};

describe('1. a missing root object is said in words, about the org that was read', () => {
  it('sftkFriendlyError names the object and says the org has no such object', () => {
    const out = friendly(RAW);
    expect(out.type).toBe('missing-object');
    expect(out.object).toBe('Load_Parent__c');
    expect(out.message).toBe('This org has no object named Load_Parent__c');
    expect(out.hint).toMatch(/built for an org that has it/);
    expect(out.message).not.toMatch(/WSDL|HTTP 400/);
  });
  it('the ring toast names the source for a source read, the target otherwise', () => {
    const i = RG.indexOf('const onSrc = /^source query failed/i.test(msg);');
    expect(i).toBeGreaterThan(0);
    const block = RG.slice(i, i + 700);
    expect(block).toContain('reading ${orgLabel(ringSrc)} (the source)');
    expect(block).toContain('reading ${orgLabel(tgtUrl)}');
    expect(block).toContain("msg.replace(/^(source|target) query failed:\\s*/i, '')");
    expect(RG).not.toContain('showToast(`Scan failed for ${orgLabel(tgtUrl)}: ${fe.message}`');
  });
});

describe('2. engine notes stay notes in the run log', () => {
  const fn = src(RC, '_recLogEngineLines');
  it('ℹ / 🔗 / 📎 / ⚠ lines log as ℹ with the note class, failures as ❌', () => {
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).toContain("t.includes('ℹ') || t.includes('🔗') || t.includes('📎') || t.includes('⚠')");
    expect(fn).toContain("log('  ℹ', t.replace(/^\\s*[ℹ⚠]\\s*/, ''), 'ds-prog-note')");
    expect(fn).toContain("log('  ❌', t, 'ds-prog-err')");
    expect(CSS).toContain('.ds-prog-note { color: var(--subtext); }');
  });
  it('every per-line dump of engine errors goes through it (pull, push, child insert, child update, overwrite, update-source)', () => {
    expect((RC.match(/_recLogEngineLines\(log, (res|result)\.errors\);/g) || []).length).toBe(6);
    expect(RC).not.toMatch(/\.errors \|\| \[\]\)\.slice\(0, 5\)\.forEach\(e2? => log\('  ❌'/);
  });
  it('behaves: the classifier splits a mixed list', () => {
    const calls = [];
    const log = (icon, text, cls) => calls.push([icon.trim(), text, cls]);
    const run = new Function('log', 'lines', `${fn}\nreturn _recLogEngineLines(log, lines);`);
    run(log, [
      'ℹ Account: 5000 record(s) ≥ 2000 — using Bulk API 2.0 (one async job).',
      'Account: DUPLICATES_DETECTED:Use one of these records?:-- (×4800)',
      '🔗 2 lookup(s) included and resolved by matching: ParentId (by Name)',
    ]);
    expect(calls.map(c => c[0])).toEqual(['ℹ', '❌', 'ℹ']);
    expect(calls[0][1]).toBe('Account: 5000 record(s) ≥ 2000 — using Bulk API 2.0 (one async job).');
    expect(calls.map(c => c[2])).toEqual(['ds-prog-note', 'ds-prog-err', 'ds-prog-note']);
  });
});

describe('3. the duplicated-names summary counts all of them', () => {
  it('uses the total number of duplicated keys, not the examples shown', () => {
    expect(RC).toContain('const n = ((scan.dupKeys.keys || []).length || ex.length).toLocaleString();');   // 2026-10-25: the one-line head of the note
    expect(RC).toContain('${n} name${n === '1' ? '' : 's'} used by more than one record');
    expect(RC).not.toContain('${ex.length} name');
  });
});
