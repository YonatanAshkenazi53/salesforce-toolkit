// Fixture for the LIVE Field Cleaner scan (2026-11-06): one Email field on Account, Account.SFTK_Live_Blk__c, with one of
// every blocker the new legs read (and a layout + email template as mentions). Nothing is deleted here; live-clean.mjs undoes it.
import { writeFileSync, mkdirSync } from 'node:fs';
import { NS, tooling, soql, deploySrc, fld } from './lib.mjs';
const USER = 'yonash53.b2512850f759@agentforce.com';
const X = '<?xml version="1.0" encoding="UTF-8"?>\n';
const w = (p, s) => { mkdirSync(p.slice(0, p.lastIndexOf('/')), { recursive: true }); writeFileSync(p, s); };
const F = 'SFTK_Live_Blk__c';
const A = 'live1/force-app/main/default';
fld(A, 'Account', F, '<type>Email</type><unique>false</unique>');
// workflow: inactive rule (criteria), orphan field update on the field, alert to the field, outbound message with the field
w(`${A}/workflows/Account.workflow-meta.xml`, `${X}<Workflow ${NS}>
<alerts><fullName>SFTK_Live_Alert</fullName><description>live fixture</description><protected>false</protected><recipients><field>${F}</field><type>email</type></recipients><senderType>CurrentUser</senderType><template>unfiled$public/SFTK_Live_Email</template></alerts>
<fieldUpdates><fullName>SFTK_Live_FU</fullName><field>${F}</field><literalValue>x@sftk.invalid</literalValue><name>SFTK Live FU</name><notifyAssignee>false</notifyAssignee><operation>Literal</operation><protected>false</protected><reevaluateOnChange>false</reevaluateOnChange></fieldUpdates>
<outboundMessages><fullName>SFTK_Live_OM</fullName><apiVersion>62.0</apiVersion><endpointUrl>https://example.invalid/sftk</endpointUrl><fields>Id</fields><fields>${F}</fields><includeSessionId>false</includeSessionId><integrationUser>${USER}</integrationUser><name>SFTK Live OM</name><protected>false</protected><useDeadLetterQueue>false</useDeadLetterQueue></outboundMessages>
<rules><fullName>SFTK_Live_WR</fullName><active>false</active><criteriaItems><field>Account.${F}</field><operation>equals</operation><value>never@sftk.invalid</value></criteriaItems><description>live fixture, inactive</description><triggerType>onCreateOrTriggeringUpdate</triggerType></rules>
</Workflow>\n`);
w(`${A}/email/unfiled$public/SFTK_Live_Email.email`, `Hello {!Account.${F}}\n`);
w(`${A}/email/unfiled$public/SFTK_Live_Email.email-meta.xml`, `${X}<EmailTemplate ${NS}><available>true</available><encodingKey>UTF-8</encodingKey><name>SFTK Live Email</name><style>none</style><subject>SFTK live fixture</subject><type>text</type></EmailTemplate>\n`);
// inactive approval process with entry criteria on the field
w(`${A}/approvalProcesses/Account.SFTK_Live_AP.approvalProcess-meta.xml`, `${X}<ApprovalProcess ${NS}><active>false</active><allowRecall>false</allowRecall><allowedSubmitters><type>owner</type></allowedSubmitters><approvalStep><allowDelegate>false</allowDelegate><assignedApprover><approver><name>${USER}</name><type>user</type></approver><whenMultipleApprovers>FirstResponse</whenMultipleApprovers></assignedApprover><label>Step 1</label><name>Step_1</name></approvalStep><entryCriteria><criteriaItems><field>Account.${F}</field><operation>equals</operation><value>never@sftk.invalid</value></criteriaItems></entryCriteria><finalApprovalRecordLock>true</finalApprovalRecordLock><finalRejectionRecordLock>false</finalRejectionRecordLock><label>SFTK Live AP</label><recordEditability>AdminOnly</recordEditability><showApprovalHistory>false</showApprovalHistory></ApprovalProcess>\n`);
// criteria sharing rule
w(`${A}/sharingRules/Account.sharingRules-meta.xml`, `${X}<SharingRules ${NS}><sharingCriteriaRules><fullName>SFTK_Live_SR</fullName><accessLevel>Read</accessLevel><accountSettings><caseAccessLevel>None</caseAccessLevel><contactAccessLevel>None</contactAccessLevel><opportunityAccessLevel>None</opportunityAccessLevel></accountSettings><description>live fixture, matches nothing</description><label>SFTK Live SR</label><sharedTo><allInternalUsers></allInternalUsers></sharedTo><criteriaItems><field>${F}</field><operation>equals</operation><value>never@sftk.invalid</value></criteriaItems></sharingCriteriaRules></SharingRules>\n`);
// matching rule on Name + INACTIVE duplicate rule whose filter names the field (fixture rules only; the standard rule is untouched)
w(`${A}/matchingRules/Account.matchingRule-meta.xml`, `${X}<MatchingRules ${NS}><matchingRules><fullName>SFTK_Live_MR</fullName><label>SFTK Live MR</label><matchingRuleItems><blankValueBehavior>NullNotAllowed</blankValueBehavior><fieldName>Name</fieldName><matchingMethod>Exact</matchingMethod></matchingRuleItems><ruleStatus>Active</ruleStatus></matchingRules></MatchingRules>\n`);
const existing = await soql("SELECT DeveloperName FROM DuplicateRule WHERE SobjectType = 'Account'");
w(`${A}/duplicateRules/Account.SFTK_Live_DR.duplicateRule-meta.xml`, `${X}<DuplicateRule ${NS}><actionOnInsert>Allow</actionOnInsert><actionOnUpdate>Allow</actionOnUpdate><description>live fixture, inactive, matches nothing</description><duplicateRuleFilter><duplicateRuleFilterItems><field>${F}</field><operation>equals</operation><sortOrder>1</sortOrder><table>Account</table><value>never@sftk.invalid</value></duplicateRuleFilterItems></duplicateRuleFilter><duplicateRuleMatchRules><matchRuleSObjectType>Account</matchRuleSObjectType><matchingRule>SFTK_Live_MR</matchingRule></duplicateRuleMatchRules><isActive>false</isActive><masterLabel>SFTK Live DR</masterLabel><operationsOnInsert>Report</operationsOnInsert><operationsOnUpdate>Report</operationsOnUpdate><securityOption>EnforceSharingRules</securityOption><sortOrder>${(existing.findIndex(r => r.DeveloperName === 'SFTK_Live_DR') + 1) || (existing.length + 1)}</sortOrder></DuplicateRule>\n`);
// LWC with the schema import
w(`${A}/lwc/sftkLiveBlk/sftkLiveBlk.js`, `import { LightningElement } from 'lwc';\nimport F from '@salesforce/schema/Account.${F}';\nexport default class SftkLiveBlk extends LightningElement { f = F; }\n`);
w(`${A}/lwc/sftkLiveBlk/sftkLiveBlk.html`, '<template><p>{f}</p></template>\n');
w(`${A}/lwc/sftkLiveBlk/sftkLiveBlk.js-meta.xml`, `${X}<LightningComponentBundle ${NS}><apiVersion>62.0</apiVersion><isExposed>false</isExposed></LightningComponentBundle>\n`);
// custom metadata type with a Field Definition relationship + one record
w(`${A}/objects/SFTK_Live_Cmt__mdt/SFTK_Live_Cmt__mdt.object-meta.xml`, `${X}<CustomObject ${NS}><label>SFTK Live Cmt</label><pluralLabel>SFTK Live Cmts</pluralLabel><visibility>Public</visibility></CustomObject>\n`);
const mf = (n, extra) => w(`${A}/objects/SFTK_Live_Cmt__mdt/fields/${n}.field-meta.xml`, `${X}<CustomField ${NS}><fullName>${n}</fullName><externalId>false</externalId><label>${n}</label><required>false</required><fieldManageability>DeveloperControlled</fieldManageability>${extra}</CustomField>\n`);
mf('Entity__c', '<type>MetadataRelationship</type><referenceTo>EntityDefinition</referenceTo><relationshipLabel>SFTK Live Cmts</relationshipLabel><relationshipName>SFTK_Live_Cmts_E</relationshipName><unique>false</unique>');
mf('Field__c', '<type>MetadataRelationship</type><referenceTo>FieldDefinition</referenceTo><metadataRelationshipControllingField>SFTK_Live_Cmt__mdt.Entity__c</metadataRelationshipControllingField><relationshipLabel>SFTK Live Cmts</relationshipLabel><relationshipName>SFTK_Live_Cmts_F</relationshipName><unique>false</unique>');
w(`${A}/customMetadata/SFTK_Live_Cmt.Ref.md-meta.xml`, `${X}<CustomMetadata ${NS} xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><label>Ref</label><protected>false</protected><values><field>Entity__c</field><value xsi:type="xsd:string">Account</value></values><values><field>Field__c</field><value xsi:type="xsd:string">Account.${F}</value></values></CustomMetadata>\n`);
// a Lightning page with the field (blocker) and a layout (mention)
w(`${A}/flexipages/SFTK_Live_Page.flexipage-meta.xml`, `${X}<FlexiPage ${NS}>
    <description>SFTK live fixture, never assigned. Safe to delete.</description>
    <flexiPageRegions>
        <itemInstances><fieldInstance><fieldInstanceProperties><name>uiBehavior</name><value>required</value></fieldInstanceProperties><fieldItem>Record.Name</fieldItem><identifier>RecordNameField</identifier></fieldInstance></itemInstances>
        <itemInstances><fieldInstance><fieldInstanceProperties><name>uiBehavior</name><value>none</value></fieldInstanceProperties><fieldItem>Record.${F}</fieldItem><identifier>RecordSFTKLiveBlkField</identifier></fieldInstance></itemInstances>
        <name>Facet-col1</name><type>Facet</type>
    </flexiPageRegions>
    <flexiPageRegions><itemInstances><componentInstance><componentInstanceProperties><name>body</name><value>Facet-col1</value></componentInstanceProperties><componentName>flexipage:column</componentName><identifier>flexipage_column</identifier></componentInstance></itemInstances><name>Facet-cols</name><type>Facet</type></flexiPageRegions>
    <flexiPageRegions><itemInstances><componentInstance><componentName>force:highlightsPanel</componentName><identifier>force_highlightsPanel</identifier></componentInstance></itemInstances><name>header</name><type>Region</type></flexiPageRegions>
    <flexiPageRegions><itemInstances><componentInstance><componentInstanceProperties><name>columns</name><value>Facet-cols</value></componentInstanceProperties><componentInstanceProperties><name>label</name><value>Fixture fields</value></componentInstanceProperties><componentName>flexipage:fieldSection</componentName><identifier>flexipage_fieldSection</identifier></componentInstance></itemInstances><name>main</name><type>Region</type></flexiPageRegions>
    <masterLabel>SFTK Live Page</masterLabel>
    <sobjectType>Account</sobjectType>
    <template><name>flexipage:recordHomeTemplateDesktop</name></template>
    <type>RecordPage</type>
</FlexiPage>\n`);
w(`${A}/layouts/Account-SFTK Live Layout.layout-meta.xml`, `${X}<Layout ${NS}><layoutSections><customLabel>false</customLabel><detailHeading>false</detailHeading><editHeading>true</editHeading><label>Information</label><layoutColumns><layoutItems><behavior>Required</behavior><field>Name</field></layoutItems><layoutItems><behavior>Edit</behavior><field>ParentId</field></layoutItems><layoutItems><behavior>Edit</behavior><field>${F}</field></layoutItems></layoutColumns><layoutColumns/><style>TwoColumnsTopToBottom</style></layoutSections></Layout>\n`);
console.log('G1', (await deploySrc('deploy live1', 'live1')).status);

// G2: a DRAFT Process Builder process on the field
const pmv = (n, v) => `<processMetadataValues><name>${n}</name><value>${v}</value></processMetadataValues>`;
const str = s => `<stringValue>${s}</stringValue>`;
const B = 'live2/force-app/main/default';
w(`${B}/flows/SFTK_Live_PB.flow-meta.xml`, `${X}<Flow ${NS}>
    <apiVersion>50.0</apiVersion>
    <decisions>${pmv('index', '<numberValue>0.0</numberValue>')}<name>myDecision</name><label>myDecision</label><locationX>50</locationX><locationY>0</locationY><defaultConnectorLabel>default</defaultConnectorLabel>
        <rules><name>myRule_1</name><conditionLogic>and</conditionLogic>
            <conditions>${pmv('inputDataType', str('String'))}${pmv('leftHandSideType', str('Field'))}${pmv('operatorDataType', str('String'))}${pmv('rightHandSideType', str('String'))}<leftValueReference>myVariable_current.${F}</leftValueReference><operator>EqualTo</operator><rightValue>${str('never@sftk.invalid')}</rightValue></conditions>
            <connector><targetReference>myRule_1_A1</targetReference></connector><label>never</label>
        </rules>
    </decisions>
    <description>live fixture, draft</description>
    <interviewLabel>SFTK_Live_PB-1_InterviewLabel</interviewLabel>
    <label>SFTK Live PB</label>
    ${pmv('ObjectType', str('Account'))}${pmv('ObjectVariable', '<elementReference>myVariable_current</elementReference>')}${pmv('OldObjectVariable', '<elementReference>myVariable_old</elementReference>')}${pmv('TriggerType', str('onAllChanges'))}
    <processType>Workflow</processType>
    <recordUpdates>${pmv('evaluationType', str('always'))}${pmv('isChildRelationship', '<booleanValue>false</booleanValue>')}${pmv('reference', str('[Account]'))}${pmv('referenceTargetField', str(''))}<name>myRule_1_A1</name><label>set description</label><locationX>100</locationX><locationY>100</locationY>
        <filters>${pmv('implicit', '<booleanValue>true</booleanValue>')}<field>Id</field><operator>EqualTo</operator><value><elementReference>myVariable_current.Id</elementReference></value></filters>
        <inputAssignments>${pmv('dataType', str('String'))}${pmv('isRequired', '<booleanValue>false</booleanValue>')}${pmv('leftHandSideLabel', str('Account Description'))}${pmv('leftHandSideReferenceTo', str(''))}${pmv('rightHandSideType', str('String'))}<field>Description</field><value>${str('sftk')}</value></inputAssignments>
        <object>Account</object>
    </recordUpdates>
    <startElementReference>myDecision</startElementReference>
    <status>Draft</status>
    <variables><name>myVariable_current</name><dataType>SObject</dataType><isCollection>false</isCollection><isInput>true</isInput><isOutput>true</isOutput><objectType>Account</objectType></variables>
    <variables><name>myVariable_old</name><dataType>SObject</dataType><isCollection>false</isCollection><isInput>true</isInput><isOutput>false</isOutput><objectType>Account</objectType></variables>
</Flow>\n`);
console.log('G2', (await deploySrc('deploy live2 (PB)', 'live2')).status);

// G3: lead field mapping onto the Account field
const C = 'live3/force-app/main/default';
fld(C, 'Lead', F, '<type>Email</type><unique>false</unique>');
w(`${C}/LeadConvertSettings/LeadConvertSettings.LeadConvertSetting-meta.xml`, `${X}<LeadConvertSettings ${NS}><allowOwnerChange>true</allowOwnerChange><objectMapping><inputObject>Lead</inputObject><mappingFields><inputField>${F}</inputField><outputField>${F}</outputField></mappingFields><outputObject>Account</outputObject></objectMapping><opportunityCreationOptions>VisibleOptional</opportunityCreationOptions></LeadConvertSettings>\n`);
console.log('G3', (await deploySrc('deploy live3 (lead mapping)', 'live3')).status);

console.log('field in org:', (await tooling(`SELECT Id FROM CustomField WHERE DeveloperName = 'SFTK_Live_Blk' AND TableEnumOrId = 'Account'`)).length, '| PB:', JSON.stringify((await tooling("SELECT ProcessType, Status FROM Flow WHERE Definition.DeveloperName = 'SFTK_Live_PB'")).map(r => [r.ProcessType, r.Status])), '| dupe rules:', JSON.stringify((await soql("SELECT DeveloperName, IsActive FROM DuplicateRule WHERE SobjectType = 'Account'")).map(r => [r.DeveloperName, r.IsActive])));
