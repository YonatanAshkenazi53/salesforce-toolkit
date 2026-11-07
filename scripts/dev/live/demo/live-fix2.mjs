// Second half of the live demo fixture (2026-11-06, "המטרה היא לראות ולאפשר מחיקה או שינוי של התלויות וגם להראות את כל שאר הדברים שיכולים להשבר"):
// on top of live-fix.mjs — an ACTIVE real flow the tool can rewrite (Remove / Replace), and the silent mentions that break without
// blocking: a list view, a quick action, a compact layout, a report. live-clean2.mjs undoes it.
import { writeFileSync, mkdirSync } from 'node:fs';
import { NS, ORG, sf, tooling, soql, deploySrc } from './lib.mjs';
const X = '<?xml version="1.0" encoding="UTF-8"?>\n';
const w = (p, s) => { mkdirSync(p.slice(0, p.lastIndexOf('/')), { recursive: true }); writeFileSync(p, s); };
const F = 'SFTK_Live_Blk__c';
const A = 'live4/force-app/main/default';
// an active autolaunched flow: one decision on the field, nothing written, nothing calls it
w(`${A}/flows/SFTK_Live_Flow.flow-meta.xml`, `${X}<Flow ${NS}>
    <apiVersion>62.0</apiVersion>
    <decisions><name>Check_Email</name><label>Check Email</label><locationX>176</locationX><locationY>134</locationY><defaultConnectorLabel>Anything else</defaultConnectorLabel>
        <rules><name>Is_Fixture</name><conditionLogic>and</conditionLogic><conditions><leftValueReference>acct.${F}</leftValueReference><operator>EqualTo</operator><rightValue><stringValue>never@sftk.invalid</stringValue></rightValue></conditions><label>Is fixture</label></rules>
    </decisions>
    <description>SFTK live demo fixture. Reads Account.${F} in one decision, writes nothing, nothing calls it. Safe to delete.</description>
    <interviewLabel>SFTK Live Flow {!$Flow.CurrentDateTime}</interviewLabel>
    <label>SFTK Live Flow</label>
    <processMetadataValues><name>BuilderType</name><value><stringValue>LightningFlowBuilder</stringValue></value></processMetadataValues>
    <processMetadataValues><name>CanvasMode</name><value><stringValue>AUTO_LAYOUT_CANVAS</stringValue></value></processMetadataValues>
    <processType>AutoLaunchedFlow</processType>
    <start><locationX>50</locationX><locationY>0</locationY><connector><targetReference>Check_Email</targetReference></connector></start>
    <status>Active</status>
    <variables><name>acct</name><dataType>SObject</dataType><isCollection>false</isCollection><isInput>true</isInput><isOutput>false</isOutput><objectType>Account</objectType></variables>
</Flow>\n`);
// the silent mentions
w(`${A}/objects/Account/listViews/SFTK_Live_LV.listView-meta.xml`, `${X}<ListView ${NS}><fullName>SFTK_Live_LV</fullName><columns>ACCOUNT.NAME</columns><columns>ACCOUNT.${F}</columns><filterScope>Everything</filterScope><filters><field>ACCOUNT.${F}</field><operation>equals</operation><value>never@sftk.invalid</value></filters><label>SFTK Live LV</label></ListView>\n`);
w(`${A}/objects/Account/compactLayouts/SFTK_Live_CL.compactLayout-meta.xml`, `${X}<CompactLayout ${NS}><fullName>SFTK_Live_CL</fullName><fields>Name</fields><fields>${F}</fields><label>SFTK Live CL</label></CompactLayout>\n`);
w(`${A}/quickActions/Account.SFTK_Live_QA.quickAction-meta.xml`, `${X}<QuickAction ${NS}><label>SFTK Live QA</label><optionsCreateFeedItem>false</optionsCreateFeedItem><quickActionLayout><layoutSectionStyle>TwoColumnsLeftToRight</layoutSectionStyle><quickActionLayoutColumns><quickActionLayoutItems><emptySpace>false</emptySpace><field>${F}</field><uiBehavior>Edit</uiBehavior></quickActionLayoutItems></quickActionLayoutColumns><quickActionLayoutColumns/></quickActionLayout><type>Update</type></QuickAction>\n`);
console.log('G4', (await deploySrc('deploy live4 (flow + mentions)', 'live4')).status);

// a report with the field as a column and a filter (Reports REST API; the sweep button in the tool reads it)
writeFileSync('live4-report.json', JSON.stringify({ reportMetadata: { name: 'SFTK Live Report', reportFormat: 'TABULAR', reportType: { type: 'AccountList' }, detailColumns: ['ACCOUNT.NAME', `Account.${F}`], reportFilters: [{ column: `Account.${F}`, operator: 'equals', value: 'never@sftk.invalid' }] } }));
const existing = await soql("SELECT Id FROM Report WHERE Name = 'SFTK Live Report'");
if (existing.length) console.log('report: already there', existing[0].Id);
else { const r = await sf(['api', 'request', 'rest', '/services/data/v62.0/analytics/reports', '--method', 'POST', '--body', '@live4-report.json', '-o', ORG]); console.log('report:', r.reportMetadata ? r.reportMetadata.id : JSON.stringify(r).slice(0, 300)); }

console.log('flows on the field:', JSON.stringify((await tooling("SELECT Definition.DeveloperName, ProcessType, Status FROM Flow WHERE Definition.DeveloperName LIKE 'SFTK_Live%'")).map(r => [r.Definition.DeveloperName, r.ProcessType, r.Status])));
