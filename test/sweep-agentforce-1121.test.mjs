// owner 2026-11-19: "Also what about agentforce components like form templates, actions, etc" — prompt templates were
// done that day; actions, topics, the agent's plan and bots landed in "Other components" of the full metadata text
// scan. They have groups of their own now. The file shapes below are Salesforce's own (the public sample app
// trailheadapps/coral-cloud, read 2026-11-21). NOT seen live: npc2 refuses the deploy of an action.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';
const S = extractFunctions('sftk-sweep.js', [
  'sftkSweepForms', 'sftkSweepHits', 'sftkSweepSections', '_sftkSweepSectionAt', 'sftkSweepKind', 'sftkSweepRun',
  'sftkSweepKindTable', '_sftkSweepSkip', '_sftkSweepBinary', 'sftkSweepIsText',
]);
const KINDS = ['GenAiFunction', 'GenAiPlugin', 'GenAiPlannerBundle', 'Bot'];
const F = S.sftkSweepForms('Experience__c', 'Rating__c');
const lines = (...l) => l.join('\n');

describe('Agentforce in the full metadata text scan', () => {
  it('the four kinds are asked for and each has its own group, as something that breaks later', () => {
    const skip = S._sftkSweepSkip(), k = S.sftkSweepKindTable();
    for (const t of KINDS) { expect(skip.has(t), t).toBe(false); expect(k[t].sev, t).toBe('mention'); expect(k[t].label, t).toBeTruthy(); }
    expect(k.GenAiFunction.label).toBe('Agentforce actions'); expect(k.GenAiPlugin.label).toBe('Agentforce topics');
  });
  it('an action is named by its folder, whichever of its three files holds the name', () => {
    const meta = lines('<?xml version="1.0" encoding="UTF-8"?>', '<GenAiFunction xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <description>Reads Experience__c.Rating__c and says what it holds.</description>', '    <invocationTarget>Get_Experience_Details</invocationTarget>',
      '    <invocationTargetType>flow</invocationTargetType>', '    <masterLabel>Get Experience Details</masterLabel>', '</GenAiFunction>');
    const schema = lines('{', '    "properties": {', '        "rating": {', '            "title": "rating",',
      '            "description": "The Experience__c.Rating__c of the record.",', '            "lightning:type": "lightning__textType"', '        }', '    },',
      '    "lightning:type": "lightning__objectType"', '}');
    const r = S.sftkSweepRun(new Map([
      ['unpackaged/genAiFunctions/Get_Experience_Details/Get_Experience_Details.genAiFunction', meta],
      ['unpackaged/genAiFunctions/Rate_It/output/schema.json', schema],
    ]), F);
    expect(Object.keys(r.byType)).toEqual(['GenAiFunction']);
    expect(r.byType.GenAiFunction.items.map(i => i.component).sort()).toEqual(['Get_Experience_Details', 'Rate_It']);
  });
  it('a topic whose instructions name the field is listed under Agentforce topics', () => {
    const xml = lines('<?xml version="1.0" encoding="UTF-8"?>', '<GenAiPlugin xmlns="http://soap.sforce.com/2006/04/metadata">', '    <canEscalate>false</canEscalate>',
      '    <developerName>Guest_Help</developerName>', '    <genAiPluginInstructions>',
      '        <description>When asked for a rating, read Experience__c.Rating__c and never guess it.</description>',
      '        <developerName>instruction_rating0</developerName>', '    </genAiPluginInstructions>', '    <pluginType>Topic</pluginType>', '    <scope>Ratings of experiences.</scope>', '</GenAiPlugin>');
    const r = S.sftkSweepRun(new Map([['unpackaged/genAiPlugins/Guest_Help.genAiPlugin', xml]]), F);
    expect(Object.keys(r.byType)).toEqual(['GenAiPlugin']);
    expect(r.byType.GenAiPlugin.items[0].component).toBe('Guest_Help');
  });
  it('an agent’s plan and a bot are named by their folder', () => {
    const r = S.sftkSweepRun(new Map([
      ['unpackaged/genAiPlannerBundles/Resort_Agent/Resort_Agent.genAiPlannerBundle', '<GenAiPlannerBundle><description>uses Experience__c.Rating__c</description></GenAiPlannerBundle>'],
      ['unpackaged/bots/Resort_Bot/v1.botVersion', '<BotVersion><botDialogs><label>asks Experience__c.Rating__c</label></botDialogs></BotVersion>'],
    ]), F);
    expect(Object.keys(r.byType).sort()).toEqual(['Bot', 'GenAiPlannerBundle']);
    expect(r.byType.Bot.items[0].component).toBe('Resort_Bot'); expect(r.byType.GenAiPlannerBundle.items[0].component).toBe('Resort_Agent');
  });
});
