// QA 1.1 regression run, lane "sweep" (docs/qa/qa-1.1-regression-result.json, findings #18 and #21).
// #18: a Metadata API retrieve returns a bot as ONE file, bots/<Name>.bot — it was listed as "<Name>.bot".
// #21: at the API version the scan retrieves, an agent's plan may arrive under genAiPlanners/ (the older type
//      GenAiPlanner) — it fell into "Other components" and a field in its description was called descriptive text.
// The file shapes are from the Metadata API's documented layout, NOT seen live (no org may be touched here).
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';
const S = extractFunctions('sftk-sweep.js', [
  'sftkSweepForms', 'sftkSweepHits', 'sftkSweepSections', '_sftkSweepSectionAt', 'sftkSweepKind', 'sftkSweepRun',
  'sftkSweepKindTable', '_sftkSweepSkip', '_sftkSweepBinary', 'sftkSweepIsText',
]);
const F = S.sftkSweepForms('Experience__c', 'Rating__c');
const XML = '<?xml version="1.0" encoding="UTF-8"?>\n';

describe('QA 1.1 #18 — a bot that arrives as one file', () => {
  it('is named without its file suffix', () => {
    const r = S.sftkSweepRun(new Map([
      ['unpackaged/bots/Astro.bot', XML + '<Bot><botVersions><botDialogs><botSteps><botMessages><message>Your Experience__c.Rating__c is saved</message></botMessages></botSteps></botDialogs></botVersions></Bot>'],
    ]), F);
    expect(Object.keys(r.byType)).toEqual(['Bot']);
    expect(r.byType.Bot.items[0].component).toBe('Astro');
    expect(r.hits[0].section).toBe(null);
  });
  it('a bot, an action and a plan that arrive as a folder keep the folder name, with the file as the section', () => {
    const k = (p) => S.sftkSweepKind(p, '<x>Experience__c.Rating__c</x>', { offset: 3, text: '<x>Experience__c.Rating__c</x>' }, F);
    expect(k('unpackaged/bots/Resort_Bot/v1.botVersion')).toMatchObject({ type: 'Bot', component: 'Resort_Bot', section: 'v1.botVersion' });
    expect(k('unpackaged/genAiFunctions/Rate_It/output/schema.json')).toMatchObject({ type: 'GenAiFunction', component: 'Rate_It', section: 'output/schema.json' });
    expect(k('unpackaged/genAiPlannerBundles/Resort_Agent/Resort_Agent.genAiPlannerBundle')).toMatchObject({ type: 'GenAiPlannerBundle', component: 'Resort_Agent' });
  });
  it('an action or a plan that arrives as one file is named without its suffix too', () => {
    const k = (p) => S.sftkSweepKind(p, '<x>Experience__c.Rating__c</x>', { offset: 3, text: '<x>Experience__c.Rating__c</x>' }, F);
    expect(k('unpackaged/genAiFunctions/Rate_It.genAiFunction').component).toBe('Rate_It');
    expect(k('unpackaged/genAiPlannerBundles/Resort_Agent.genAiPlannerBundle').component).toBe('Resort_Agent');
  });
});

describe('QA 1.1 #21 — an agent plan under genAiPlanners/', () => {
  const plan = XML + '<GenAiPlanner xmlns="http://soap.sforce.com/2006/04/metadata">\n    <description>Answer with Experience__c.Rating__c when asked for a rating.</description>\n    <masterLabel>Resort Agent</masterLabel>\n    <plannerType>AiCopilot__ReAct</plannerType>\n</GenAiPlanner>';
  it('lands in the Agentforce agents group, named by its file', () => {
    const r = S.sftkSweepRun(new Map([['unpackaged/genAiPlanners/Resort_Agent.genAiPlanner', plan]]), F);
    expect(Object.keys(r.byType)).toEqual(['GenAiPlannerBundle']);
    expect(r.byType.GenAiPlannerBundle.label).toBe('Agentforce agents');
    expect(r.byType.GenAiPlannerBundle.items[0].component).toBe('Resort_Agent');
  });
  it('a field named in the plan’s description is not relabelled as descriptive text', () => {
    const r = S.sftkSweepRun(new Map([['unpackaged/genAiPlanners/Resort_Agent.genAiPlanner', plan]]), F);
    expect(r.hits.length).toBe(1);
    expect(r.hits[0].type).toBe('GenAiPlannerBundle');
    expect(r.byType.DocText).toBeUndefined();
    expect(r.byType.Other).toBeUndefined();
  });
  it('the planner type is not skipped by the retrieve list', () => {
    expect(S._sftkSweepSkip().has('GenAiPlanner')).toBe(false);
    expect(S._sftkSweepSkip().has('GenAiPlannerBundle')).toBe(false);
  });
});
