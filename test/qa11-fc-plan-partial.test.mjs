// QA 1.1 finding 15 — the run report never says "nothing was changed" over a row that was changed and not finished.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const { fcPlanPartial: partial } = extractFunctions('field-cleaner.js', ['fcPlanPartial']);

describe('a row that was changed and not finished is told apart from one that was not touched', () => {
  it('a flow whose new version went in and whose old versions could not all be deleted', () => {
    expect(partial('Not finished: v7 deployed and ACTIVE (verified by re-reading the org) · 2 version(s) deleted · ⚠ 1 version(s) couldn\'t be deleted. The field stays locked until every version that references it is gone — clear the cause, then press ✂ Remove again (what was deleted stays deleted).')).toBe(true);
    expect(partial('Not finished: 2 old version(s) couldn\'t be deleted — still blocking the field delete (1 purged).')).toBe(true);
  });
  it('a deploy Salesforce accepted that the re-read did not confirm', () => {
    expect(partial('The deploy was accepted but no new version of "My_Flow" appeared (latest is still v3). Nothing was deleted.')).toBe(true);
    expect(partial('Acme layout: the deploy was accepted, but on re-read the layout does not show Region__c yet')).toBe(true);
    expect(partial('"Pipeline": the report was updated, but the org could not be re-read to confirm what remains — treat this as unverified.')).toBe(true);
    expect(partial('My_Page was saved, but on re-read the related list still shows Region__c — check it in Setup.')).toBe(true);
    expect(partial('treat "My_Flow" as UNVERIFIED and check it in Flow Builder')).toBe(true);
  });
  it('a refusal before any write is plain "not done"', () => {
    expect(partial('No direct field references found in this page — this is a Contact record page')).toBe(false);
    expect(partial('that way is no longer offered on the row')).toBe(false);
    expect(partial('Salesforce refused the deploy: the formula does not compile')).toBe(false);
    expect(partial('nothing was changed')).toBe(false);
    expect(partial('')).toBe(false);
    expect(partial(null)).toBe(false);
  });
});

describe('the report', () => {
  const rep = FC.slice(FC.indexOf('  function _planReport('), FC.indexOf('  function _rowBusy('));
  it('no longer states that nothing was changed in the rows that are not done', () => {
    expect(rep).not.toContain('nothing was changed in these');
    expect(rep).not.toContain('Every change has ↩ Undo on its row');
  });
  it('lists the changed-and-not-finished rows under their own heading, which says they have no Undo button', () => {
    expect(rep).toContain('const part = notAll.filter(x => fcPlanPartial(x.text)), not = notAll.filter(x => !fcPlanPartial(x.text));');
    expect(rep).toContain('Changed, but not finished or not confirmed. Each line says what was done and what is left. These rows have no ↩ Undo button');
    expect(rep).toContain('changed, not finished</span>');
    expect(rep).toContain('Every finished change has ↩ Undo on its row.');
  });
});
