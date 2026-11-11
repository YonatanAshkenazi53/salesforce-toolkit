// The packaged-object demo, brought level with the Account demo (owner 2026-11-11: "אני רוצה שתכין אובייקט חבילתי בתור
// דוגמא עם אותם רפרנסים למחיקה"). Writes `more-app/` — every kind Account.SFTK_Live_Blk__c has that
// dlrs__LookupChild__c.SFTK_Pkg_Tag__c did not: Apex class + trigger, Visualforce page + component, an LWC with a schema
// import, an Aura component, a custom button, a lookup filter, a scoping rule, an approval process, a quick action, an
// inactive validation rule, an outbound message, a custom metadata record that points at the field.
// Not possible on a Text field: an email alert whose recipient IS the field (Email fields only).
//   node build-more.mjs            → writes more-app/ and the workflow file
//   then: sf project deploy start -o npc --source-dir more-app --source-dir fc-app --test-level NoTestRun
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const D = join(HERE, 'more-app/main/default');
const O = 'dlrs__LookupChild__c', F = 'SFTK_Pkg_Tag__c';
const USER = process.env.SFTK_USER || 'yonash53.b2512850f759@agentforce.com';
const X = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';
const w = (rel, text) => { const p = join(D, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
const meta = (tag, extra = '') => `${X}<${tag} ${NS}><apiVersion>62.0</apiVersion>${extra}</${tag}>\n`;

// ── code ──
w('classes/SFTK_Pkg_Class.cls', `public class SFTK_Pkg_Class {\n    public static String tag(${O} c) { return c.${F}; }\n}\n`);
w('classes/SFTK_Pkg_Class.cls-meta.xml', meta('ApexClass', '<status>Active</status>'));
w('triggers/SFTK_Pkg_Trigger.trigger', `trigger SFTK_Pkg_Trigger on ${O} (before insert) {\n    for (${O} c : Trigger.new) { if (c.${F} == 'sftk-never') c.${F} = 'sftk-never'; }\n}\n`);
w('triggers/SFTK_Pkg_Trigger.trigger-meta.xml', meta('ApexTrigger', '<status>Active</status>'));
w('pages/SFTK_Pkg_VF.page', `<apex:page standardController="${O}">\n    <apex:outputField value="{!${O}.${F}}"/>\n</apex:page>\n`);
w('pages/SFTK_Pkg_VF.page-meta.xml', meta('ApexPage', '<availableInTouch>false</availableInTouch><confirmationTokenRequired>false</confirmationTokenRequired><label>SFTK Pkg VF</label>'));
w('components/SFTK_Pkg_VFC.component', `<apex:component>\n    <apex:attribute name="rec" type="${O}" description="the record"/>\n    <apex:outputText value="{!rec.${F}}"/>\n</apex:component>\n`);
w('components/SFTK_Pkg_VFC.component-meta.xml', meta('ApexComponent', '<label>SFTK Pkg VFC</label>'));
w('lwc/sftkPkgTag/sftkPkgTag.js', `import { LightningElement } from 'lwc';\nimport TAG from '@salesforce/schema/${O}.${F}';\nexport default class SftkPkgTag extends LightningElement { field = TAG; }\n`);
w('lwc/sftkPkgTag/sftkPkgTag.html', '<template><span>SFTK packaged-object demo</span></template>\n');
w('lwc/sftkPkgTag/sftkPkgTag.js-meta.xml', `${X}<LightningComponentBundle ${NS}><apiVersion>62.0</apiVersion><isExposed>false</isExposed></LightningComponentBundle>\n`);
w('aura/sftkPkgAura/sftkPkgAura.cmp', `<aura:component>\n    <aura:attribute name="rec" type="${O}"/>\n    <span>{!v.rec.${F}}</span>\n</aura:component>\n`);
w('aura/sftkPkgAura/sftkPkgAura.cmp-meta.xml', `${X}<AuraDefinitionBundle ${NS}><apiVersion>62.0</apiVersion><description>SFTK packaged-object demo</description></AuraDefinitionBundle>\n`);

// ── on the object ──
w(`objects/${O}/webLinks/SFTK_Pkg_Btn.webLink-meta.xml`, `${X}<WebLink ${NS}><fullName>SFTK_Pkg_Btn</fullName><availability>online</availability><displayType>button</displayType><encodingKey>UTF-8</encodingKey><hasMenubar>false</hasMenubar><hasScrollbars>true</hasScrollbars><hasToolbar>false</hasToolbar><height>600</height><isResizable>true</isResizable><linkType>url</linkType><masterLabel>SFTK Pkg Btn</masterLabel><openType>newWindow</openType><position>none</position><protected>false</protected><showsLocation>false</showsLocation><showsStatus>false</showsStatus><url>https://example.invalid/?x={!${O}.${F}}</url></WebLink>\n`);
w(`objects/${O}/validationRules/SFTK_Pkg_VR_Off.validationRule-meta.xml`, `${X}<ValidationRule ${NS}><fullName>SFTK_Pkg_VR_Off</fullName><active>false</active><description>SFTK packaged-object demo, inactive.</description><errorConditionFormula>${F} = &apos;sftk-never&apos;</errorConditionFormula><errorMessage>SFTK demo</errorMessage></ValidationRule>\n`);
// a lookup on Contact to the packaged object, filtered by the field (the Account demo's shape: Contact.SFTK_Live_Lk__c)
w('objects/Contact/fields/SFTK_Pkg_Lk__c.field-meta.xml', `${X}<CustomField ${NS}><fullName>SFTK_Pkg_Lk__c</fullName><deleteConstraint>SetNull</deleteConstraint><externalId>false</externalId><label>SFTK Pkg Lookup</label><lookupFilter><active>true</active><errorMessage>SFTK demo</errorMessage><filterItems><field>${O}.${F}</field><operation>equals</operation><value>sftk-never</value></filterItems><infoMessage>SFTK demo</infoMessage><isOptional>false</isOptional></lookupFilter><referenceTo>${O}</referenceTo><relationshipLabel>SFTK Pkg contacts</relationshipLabel><relationshipName>SFTK_Pkg_Lk</relationshipName><required>false</required><trackHistory>false</trackHistory><type>Lookup</type></CustomField>
`);
w(`quickActions/${O}.SFTK_Pkg_QA.quickAction-meta.xml`, `${X}<QuickAction ${NS}><label>SFTK Pkg QA</label><optionsCreateFeedItem>false</optionsCreateFeedItem><quickActionLayout><layoutSectionStyle>TwoColumnsLeftToRight</layoutSectionStyle><quickActionLayoutColumns><quickActionLayoutItems><emptySpace>false</emptySpace><field>${F}</field><uiBehavior>Edit</uiBehavior></quickActionLayoutItems></quickActionLayoutColumns><quickActionLayoutColumns/></quickActionLayout><type>Update</type></QuickAction>\n`);
w(`approvalProcesses/${O}.SFTK_Pkg_AP.approvalProcess-meta.xml`, `${X}<ApprovalProcess ${NS}><active>false</active><allowRecall>false</allowRecall><allowedSubmitters><type>owner</type></allowedSubmitters><approvalStep><allowDelegate>false</allowDelegate><assignedApprover><approver><name>${USER}</name><type>user</type></approver><whenMultipleApprovers>FirstResponse</whenMultipleApprovers></assignedApprover><label>Step 1</label><name>Step_1</name></approvalStep><entryCriteria><criteriaItems><field>${O}.${F}</field><operation>equals</operation><value>sftk-never</value></criteriaItems></entryCriteria><finalApprovalRecordLock>true</finalApprovalRecordLock><finalRejectionRecordLock>false</finalRejectionRecordLock><label>SFTK Pkg AP</label><recordEditability>AdminOnly</recordEditability><showApprovalHistory>false</showApprovalHistory></ApprovalProcess>\n`);
w('restrictionRules/SFTK_Pkg_Scope.rule-meta.xml', `${X}<RestrictionRule ${NS}><active>false</active><enforcementType>Scoping</enforcementType><description>SFTK packaged-object demo, matches no user. Safe to delete.</description><masterLabel>SFTK Pkg Scope</masterLabel><recordFilter>${F} = &apos;sftk-never&apos;</recordFilter><targetEntity>${O}</targetEntity><userCriteria>$User.Username = &apos;nobody@sftk.invalid&apos;</userCriteria><version>1</version></RestrictionRule>\n`);
// the Account demo's custom metadata type, one more record: a Field Definition that points at the packaged object's field
w('customMetadata/SFTK_Live_Cmt.PkgRef.md-meta.xml', `${X}<CustomMetadata ${NS} xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><label>PkgRef</label><protected>false</protected><values><field>Entity__c</field><value xsi:type="xsd:string">${O}</value></values><values><field>Field__c</field><value xsi:type="xsd:string">${O}.${F}</value></values></CustomMetadata>\n`);

// ── the workflow file of fc-app gains an outbound message that sends the field ──
const wf = join(HERE, 'fc-app/main/default/workflows', `${O}.workflow-meta.xml`);
let t = readFileSync(wf, 'utf8');
if (!t.includes('SFTK_Pkg_OM')) {
  t = t.replace('    <rules>', `    <outboundMessages>\n        <fullName>SFTK_Pkg_OM</fullName>\n        <apiVersion>62.0</apiVersion>\n        <endpointUrl>https://example.invalid/sftk</endpointUrl>\n        <fields>Id</fields>\n        <fields>${F}</fields>\n        <includeSessionId>false</includeSessionId>\n        <integrationUser>${USER}</integrationUser>\n        <name>SFTK Pkg OM</name>\n        <protected>false</protected>\n        <useDeadLetterQueue>false</useDeadLetterQueue>\n    </outboundMessages>\n    <rules>`);
  writeFileSync(wf, t);
}
console.log('more-app written; the workflow file has the outbound message');
