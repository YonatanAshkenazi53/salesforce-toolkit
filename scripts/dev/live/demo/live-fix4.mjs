// The rest of the live demo (2026-11-07, "אני רוצה לנסות הכל בלייב. חשוב שלא תפספס דברים"): every reference type that was
// live-tested and is NOT yet on Account.SFTK_Live_Blk__c — the blockers the dependency index returns (Apex, Visualforce,
// validation rules, formula, lookup filter, field set, custom button, scoping rule), a matching rule on the field, Aura,
// the two other email template kinds, a report type and a public report, the Lead assignment rule and a Case escalation
// rule on sibling fields, and a SECOND Email field so ⇄ Replace is live. live-clean4.mjs undoes it.
import { writeFileSync, mkdirSync } from 'node:fs';
import { NS, ORG, sf, soql, tooling, deploySrc, fld } from './lib.mjs';
const USER = 'yonash53.b2512850f759@agentforce.com';
const X = '<?xml version="1.0" encoding="UTF-8"?>\n';
const w = (p, s) => { mkdirSync(p.slice(0, p.lastIndexOf('/')), { recursive: true }); writeFileSync(p, s); };
const F = 'SFTK_Live_Blk__c', F2 = 'SFTK_Live_Blk2__c';
const A = 'live6/force-app/main/default';

// the Replace target: another Email field on Account
fld(A, 'Account', F2, '<type>Email</type><unique>false</unique>');
// Apex class + trigger (never fire: nothing matches)
w(`${A}/classes/SFTK_Live_Class.cls`, `public with sharing class SFTK_Live_Class {\n    public static String f(Account a) { return a.${F}; }\n}\n`);
w(`${A}/classes/SFTK_Live_Class.cls-meta.xml`, `${X}<ApexClass ${NS}><apiVersion>62.0</apiVersion><status>Active</status></ApexClass>\n`);
w(`${A}/triggers/SFTK_Live_Trigger.trigger`, `trigger SFTK_Live_Trigger on Account (before insert) {\n    for (Account a : Trigger.new) { if (a.${F} == 'never@sftk.invalid') { a.${F} = null; } }\n}\n`);
w(`${A}/triggers/SFTK_Live_Trigger.trigger-meta.xml`, `${X}<ApexTrigger ${NS}><apiVersion>62.0</apiVersion><status>Active</status></ApexTrigger>\n`);
// Visualforce page + component
w(`${A}/pages/SFTK_Live_VF.page`, `<apex:page standardController="Account">{!Account.${F}}</apex:page>\n`);
w(`${A}/pages/SFTK_Live_VF.page-meta.xml`, `${X}<ApexPage ${NS}><apiVersion>62.0</apiVersion><availableInTouch>false</availableInTouch><confirmationTokenRequired>false</confirmationTokenRequired><label>SFTK Live VF</label></ApexPage>\n`);
w(`${A}/components/SFTK_Live_VFC.component`, `<apex:component><apex:attribute name="acc" type="Account" description="the account"/>{!acc.${F}}</apex:component>\n`);
w(`${A}/components/SFTK_Live_VFC.component-meta.xml`, `${X}<ApexComponent ${NS}><apiVersion>62.0</apiVersion><label>SFTK Live VFC</label></ApexComponent>\n`);
// validation rules: one active (never fires), one inactive (a mention)
for (const [n, active] of [['SFTK_Live_VR', 'true'], ['SFTK_Live_VR_Off', 'false']]) w(`${A}/objects/Account/validationRules/${n}.validationRule-meta.xml`, `${X}<ValidationRule ${NS}><fullName>${n}</fullName><active>${active}</active><description>SFTK live demo, never fires</description><errorConditionFormula>ISBLANK(${F}) &amp;&amp; FALSE</errorConditionFormula><errorMessage>SFTK live demo</errorMessage></ValidationRule>\n`);
// a formula on the same object, a formula and a validation rule on Contact through the relationship, a lookup with a filter
fld(A, 'Account', 'SFTK_Live_Formula__c', `<formula>${F}</formula><type>Text</type>`);
fld(A, 'Contact', 'SFTK_Live_XFormula__c', `<formula>Account.${F}</formula><type>Text</type>`);
w(`${A}/objects/Contact/validationRules/SFTK_Live_XVR.validationRule-meta.xml`, `${X}<ValidationRule ${NS}><fullName>SFTK_Live_XVR</fullName><active>true</active><description>SFTK live demo, never fires</description><errorConditionFormula>Account.${F} = 'never@sftk.invalid'</errorConditionFormula><errorMessage>SFTK live demo</errorMessage></ValidationRule>\n`);
w(`${A}/objects/Contact/fields/SFTK_Live_Lk__c.field-meta.xml`, `${X}<CustomField ${NS}><fullName>SFTK_Live_Lk__c</fullName><deleteConstraint>SetNull</deleteConstraint><externalId>false</externalId><label>SFTK Live Lookup</label><lookupFilter><active>true</active><errorMessage>SFTK live demo</errorMessage><filterItems><field>Account.${F}</field><operation>equals</operation><value>never@sftk.invalid</value></filterItems><infoMessage>SFTK live demo</infoMessage><isOptional>false</isOptional></lookupFilter><referenceTo>Account</referenceTo><relationshipLabel>SFTK Live</relationshipLabel><relationshipName>SFTK_Live_Lk</relationshipName><required>false</required><trackHistory>false</trackHistory><type>Lookup</type></CustomField>\n`);
// field set, custom button
w(`${A}/objects/Account/fieldSets/SFTK_Live_FS.fieldSet-meta.xml`, `${X}<FieldSet ${NS}><fullName>SFTK_Live_FS</fullName><description>SFTK live demo</description><displayedFields><field>${F}</field><isFieldManaged>false</isFieldManaged><isRequired>false</isRequired></displayedFields><label>SFTK Live FS</label></FieldSet>\n`);
w(`${A}/objects/Account/webLinks/SFTK_Live_Btn.webLink-meta.xml`, `${X}<WebLink ${NS}><fullName>SFTK_Live_Btn</fullName><availability>online</availability><displayType>button</displayType><encodingKey>UTF-8</encodingKey><hasMenubar>false</hasMenubar><hasScrollbars>true</hasScrollbars><hasToolbar>false</hasToolbar><height>600</height><isResizable>true</isResizable><linkType>url</linkType><masterLabel>SFTK Live Btn</masterLabel><openType>newWindow</openType><position>none</position><protected>false</protected><showsLocation>false</showsLocation><showsStatus>false</showsStatus><url>https://example.invalid/?x={!Account.${F}}</url></WebLink>\n`);
// a scoping rule (inactive, matches no user)
w(`${A}/restrictionRules/SFTK_Live_Scope.rule-meta.xml`, `${X}<RestrictionRule ${NS}>\n    <active>false</active>\n    <enforcementType>Scoping</enforcementType>
    <description>SFTK live demo, matches no user. Safe to delete.</description>\n    <masterLabel>SFTK Live Scope</masterLabel>\n    <recordFilter>${F} = 'never@sftk.invalid'</recordFilter>\n    <targetEntity>Account</targetEntity>\n    <userCriteria>$User.Username = 'nobody@sftk.invalid'</userCriteria>\n    <version>1</version>\n</RestrictionRule>\n`);
// matching rules: the existing MR (on Name, the duplicate rule needs it) + MR2 on the field, inactive
w(`${A}/matchingRules/Account.matchingRule-meta.xml`, `${X}<MatchingRules ${NS}><matchingRules><fullName>SFTK_Live_MR</fullName><label>SFTK Live MR</label><matchingRuleItems><blankValueBehavior>NullNotAllowed</blankValueBehavior><fieldName>Name</fieldName><matchingMethod>Exact</matchingMethod></matchingRuleItems><ruleStatus>Active</ruleStatus></matchingRules><matchingRules><fullName>SFTK_Live_MR2</fullName><label>SFTK Live MR2 (on the field)</label><matchingRuleItems><blankValueBehavior>NullNotAllowed</blankValueBehavior><fieldName>${F}</fieldName><matchingMethod>Exact</matchingMethod></matchingRuleItems><ruleStatus>Inactive</ruleStatus></matchingRules></MatchingRules>\n`);
// Aura with the field in markup (a pass, not read — shown for the record), a Lightning email template and a Visualforce one
w(`${A}/aura/sftkLiveAura/sftkLiveAura.cmp`, `<aura:component implements="flexipage:availableForRecordHome,force:hasRecordId"><lightning:recordEditForm objectApiName="Account" recordId="{!v.recordId}"><lightning:inputField fieldName="${F}"/></lightning:recordEditForm></aura:component>\n`);
w(`${A}/aura/sftkLiveAura/sftkLiveAura.cmp-meta.xml`, `${X}<AuraDefinitionBundle ${NS}><apiVersion>62.0</apiVersion><description>SFTK live demo</description></AuraDefinitionBundle>\n`);
w(`${A}/email/unfiled$public/SFTK_Live_EmailSFX.email`, `<p>Hello {{{Account.${F}}}}</p>\n`);
w(`${A}/email/unfiled$public/SFTK_Live_EmailSFX.email-meta.xml`, `${X}<EmailTemplate ${NS}><available>true</available><encodingKey>UTF-8</encodingKey><name>SFTK Live Email (Lightning)</name><relatedEntityType>Account</relatedEntityType><style>none</style><subject>SFTK live demo</subject><type>custom</type><uiType>SFX</uiType></EmailTemplate>\n`);
w(`${A}/email/unfiled$public/SFTK_Live_EmailVF.email`, `<messaging:emailTemplate subject="SFTK live demo" recipientType="User" relatedToType="Account"><messaging:plainTextEmailBody>{!relatedTo.${F}}</messaging:plainTextEmailBody></messaging:emailTemplate>\n`);
w(`${A}/email/unfiled$public/SFTK_Live_EmailVF.email-meta.xml`, `${X}<EmailTemplate ${NS}><apiVersion>62.0</apiVersion><available>true</available><encodingKey>UTF-8</encodingKey><name>SFTK Live Email (Visualforce)</name><style>none</style><subject>SFTK live demo</subject><type>visualforce</type></EmailTemplate>\n`);
// a custom report type with the field as a column, and a public report with the field as column + filter
w(`${A}/reportTypes/SFTK_Live_RT.reportType-meta.xml`, `${X}<ReportType ${NS}><baseObject>Account</baseObject><category>accounts</category><deployed>true</deployed><label>SFTK Live RT</label><sections><columns><checkedByDefault>true</checkedByDefault><field>Name</field><table>Account</table></columns><columns><checkedByDefault>false</checkedByDefault><field>${F}</field><table>Account</table></columns><masterLabel>Accounts</masterLabel></sections></ReportType>\n`);
w(`${A}/reports/unfiled$public/SFTK_Live_Report_Public.report-meta.xml`, `${X}<Report ${NS}><columns><field>ACCOUNT.NAME</field></columns><columns><field>Account.${F}</field></columns><filter><criteriaItems><column>Account.${F}</column><operator>equals</operator><value>never@sftk.invalid</value></criteriaItems></filter><format>Tabular</format><name>SFTK Live Report (public)</name><reportType>AccountList</reportType><scope>organization</scope><showDetails>true</showDetails><showGrandTotal>true</showGrandTotal><showSubTotals>true</showSubTotals><timeFrameFilter><dateColumn>CREATED_DATE</dateColumn><interval>INTERVAL_CUSTOM</interval></timeFrameFilter></Report>\n`);
// Lead: an inactive assignment rule on Lead.SFTK_Live_Blk__c (the field exists from live-fix.mjs)
w(`${A}/assignmentRules/Lead.assignmentRules-meta.xml`, `${X}<AssignmentRules ${NS}><assignmentRule><fullName>SFTK_Live_AR</fullName><active>false</active><ruleEntry><assignedTo>${USER}</assignedTo><assignedToType>User</assignedToType><criteriaItems><field>Lead.${F}</field><operation>equals</operation><value>never@sftk.invalid</value></criteriaItems></ruleEntry></assignmentRule></AssignmentRules>\n`);
// Case: the field + an inactive escalation rule on it
fld(A, 'Case', F, '<type>Email</type><unique>false</unique>');
w(`${A}/escalationRules/Case.escalationRules-meta.xml`, `${X}<EscalationRules ${NS}><escalationRule><fullName>SFTK_Live_ER</fullName><active>false</active><ruleEntry><businessHoursSource>None</businessHoursSource><criteriaItems><field>Case.${F}</field><operation>equals</operation><value>never@sftk.invalid</value></criteriaItems><disableEscalationWhenModified>false</disableEscalationWhenModified><escalationAction><assignedTo>${USER}</assignedTo><assignedToType>User</assignedToType><minutesToEscalation>30</minutesToEscalation><notifyTo>${USER}</notifyTo><notifyToTemplate>unfiled$public/SFTK_Live_Email</notifyToTemplate></escalationAction></ruleEntry></escalationRule></EscalationRules>\n`);
// the permission set, now covering every demo field
w(`${A}/permissionsets/SFTK_Live_Access.permissionset-meta.xml`, `${X}<PermissionSet ${NS}>
    <description>SFTK live demo fixture: read/edit on the demo fields. Safe to delete.</description>
    ${[`Account.${F}`, `Account.${F2}`, `Lead.${F}`, `Case.${F}`, 'Contact.SFTK_Live_Lk__c'].map(f => `<fieldPermissions><editable>true</editable><field>${f}</field><readable>true</readable></fieldPermissions>`).join('\n    ')}
    <fieldPermissions><editable>false</editable><field>Account.SFTK_Live_Formula__c</field><readable>true</readable></fieldPermissions>
    <fieldPermissions><editable>false</editable><field>Contact.SFTK_Live_XFormula__c</field><readable>true</readable></fieldPermissions>
    <hasActivationRequired>false</hasActivationRequired>
    <label>SFTK Live Access</label>
</PermissionSet>\n`);
console.log('G6', (await deploySrc('deploy live6 (the rest)', 'live6')).status);
console.log('fields:', (await tooling("SELECT TableEnumOrId, DeveloperName FROM CustomField WHERE DeveloperName LIKE 'SFTK_Live%'")).map(r => r.TableEnumOrId + '.' + r.DeveloperName).join(', '));
console.log('reports:', JSON.stringify((await soql("SELECT Name, FolderName FROM Report WHERE Name LIKE 'SFTK Live%'")).map(r => r.Name + ' @ ' + r.FolderName)));
