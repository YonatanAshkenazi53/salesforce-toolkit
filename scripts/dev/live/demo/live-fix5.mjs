// Demo fixture, part 5 (2026-11-08): the kinds the everyday scan never reads,
// for the 🧭 whole-org text sweep to find on Account.SFTK_Live_Blk__c in npc:
//   • an Aura component whose markup and controller name the field (👀)
//   • an LWC that names the field only in its HTML (👀) — no schema import
//   • Account's search layouts with the field as a results column (👀)
//   • a Contact layout whose Accounts related list shows the field (👀)
// Run from this folder: node live-fix5.mjs   (deploys to npc through the CLI)
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ORG = process.env.ORG || 'npc';
const root = join(process.cwd(), 'live5');
rmSync(root, { recursive: true, force: true });
const w = (p, s) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), s); };
const META = 'http://soap.sforce.com/2006/04/metadata';

w('sfdx-project.json', JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], namespace: '', sourceApiVersion: '62.0' }, null, 2));
// Aura: markup + controller + meta
w('force-app/main/default/aura/sftkLiveAura/sftkLiveAura.cmp', `<aura:component implements="force:hasRecordId,flexipage:availableForRecordHome">
    <aura:attribute name="account" type="Account"/>
    <lightning:formattedText value="{!v.account.SFTK_Live_Blk__c}"/>
</aura:component>`);
w('force-app/main/default/aura/sftkLiveAura/sftkLiveAuraController.js', `({ init: function (cmp) { var v = cmp.get('v.account.SFTK_Live_Blk__c'); } })`);
w('force-app/main/default/aura/sftkLiveAura/sftkLiveAura.cmp-meta.xml', `<?xml version="1.0" encoding="UTF-8"?>
<AuraDefinitionBundle xmlns="${META}"><apiVersion>62.0</apiVersion><description>SFTK demo: names the field in markup only</description></AuraDefinitionBundle>`);
// LWC: the field in HTML only (no @salesforce/schema import — the index does not see it)
w('force-app/main/default/lwc/sftkLiveHtmlOnly/sftkLiveHtmlOnly.html', `<template>
    <lightning-record-view-form record-id={recordId} object-api-name="Account">
        <lightning-output-field field-name="SFTK_Live_Blk__c"></lightning-output-field>
    </lightning-record-view-form>
</template>`);
w('force-app/main/default/lwc/sftkLiveHtmlOnly/sftkLiveHtmlOnly.js', `import { LightningElement, api } from 'lwc';
export default class SftkLiveHtmlOnly extends LightningElement { @api recordId; }`);
w('force-app/main/default/lwc/sftkLiveHtmlOnly/sftkLiveHtmlOnly.js-meta.xml', `<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="${META}"><apiVersion>62.0</apiVersion><isExposed>true</isExposed><targets><target>lightning__RecordPage</target></targets></LightningComponentBundle>`);
// Account search layouts: the field as a search-results column
w('force-app/main/default/objects/Account/Account.object-meta.xml', `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="${META}">
    <searchLayouts>
        <searchResultsAdditionalFields>SFTK_Live_Blk__c</searchResultsAdditionalFields>
    </searchLayouts>
</CustomObject>`);
// a Contact layout with an Accounts-related list? Contact has no Account related list; the Opportunity layout's
// Partners list cannot carry Account fields either — the related-list column case rides on a CUSTOM object
// whose lookup to Account puts an "SFTK Live Children" related list on the Account layout: the field is
// Account's, so it is shown there as a COLUMN of the parent... not possible either (related-list columns are
// the CHILD's fields). The real case: a child object's layout cannot show parent fields in a related list.
// So the related-list example is a Contact layout whose "Account" related list is on ANOTHER object's layout
// that lists Accounts: Campaign has none… Partner Account on Opportunity shows Account fields:
w('force-app/main/default/layouts/Opportunity-SFTK Live Opp Layout.layout-meta.xml', `<?xml version="1.0" encoding="UTF-8"?>
<Layout xmlns="${META}">
    <layoutSections>
        <customLabel>false</customLabel>
        <detailHeading>false</detailHeading>
        <editHeading>true</editHeading>
        <label>Information</label>
        <layoutColumns>
            <layoutItems><behavior>Required</behavior><field>Name</field></layoutItems>
            <layoutItems><behavior>Edit</behavior><field>AccountId</field></layoutItems>
            <layoutItems><behavior>Required</behavior><field>CloseDate</field></layoutItems>
            <layoutItems><behavior>Required</behavior><field>StageName</field></layoutItems>
            <layoutItems><behavior>Edit</behavior><field>Probability</field></layoutItems>
            <layoutItems><behavior>Required</behavior><field>ForecastCategoryName</field></layoutItems>
        </layoutColumns>
        <layoutColumns/>
        <style>TwoColumnsTopToBottom</style>
    </layoutSections>
    <relatedLists>
        <fields>ACCOUNT.NAME</fields>
        <fields>SFTK_Live_Blk__c</fields>
        <relatedList>RelatedPartnerList</relatedList>
    </relatedLists>
    <showEmailCheckbox>false</showEmailCheckbox>
    <showHighlightsPanel>false</showHighlightsPanel>
    <showInteractionLogPanel>false</showInteractionLogPanel>
    <showRunAssignmentRulesCheckbox>false</showRunAssignmentRulesCheckbox>
    <showSubmitAndAttachButton>false</showSubmitAndAttachButton>
</Layout>`);

console.log('deploying live5 to', ORG, '…');
const out = execSync(`sf project deploy start -o ${ORG} -d force-app -w 20 --json`, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const j = JSON.parse(out.slice(out.indexOf('{')));
console.log('status:', j.result && j.result.status, '· components:', (j.result && j.result.numberComponentsDeployed) || 0, '· errors:', JSON.stringify((j.result && j.result.details && j.result.details.componentFailures) || []).slice(0, 800));
