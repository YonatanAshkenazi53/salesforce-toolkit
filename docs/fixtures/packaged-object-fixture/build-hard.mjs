// Writes hard-app/ — the HARDER Field Cleaner fixture on the packaged test field dlrs__LookupChild__c.SFTK_Pkg_Tag__c
// (owner 2026-11-20: "I want to test on the field a remove from more complex metadata items. and to test remove with
// a few diferent refrences per xml or metadata type."). One item per kind, each naming the field SEVERAL times, so one
// ✂ must take every reference out and leave the rest of the XML as it was.
//   node build-hard.mjs && sf project deploy start -o npc2 --source-dir hard-app --test-level NoTestRun
// Needs force-app, fc-app and all-app of this folder deployed first (the two fields, the report type).
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url)), H = join(HERE, 'hard-app/main/default');
const put = (rel, text) => { const f = join(H, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text.replace(/^\n/, '')); };
const X = '<?xml version="1.0" encoding="UTF-8"?>\n';
const MD = 'xmlns="http://soap.sforce.com/2006/04/metadata"';
const O = 'objects/dlrs__LookupChild__c';

// 1. a validation rule: the field three times, inside nested AND / OR / IF. Never fires (the Name test).
put(`${O}/validationRules/SFTK_Hard_VR.validationRule-meta.xml`, `${X}<ValidationRule ${MD}>
    <fullName>SFTK_Hard_VR</fullName>
    <active>true</active>
    <description>Admin Toolkit HARD fixture: the field three times, inside nested AND / OR / IF. Never fires. Safe to delete.</description>
    <errorConditionFormula>AND(
  Name = &quot;SFTK_NEVER_FIRES&quot;,
  OR( ISBLANK(SFTK_Pkg_Tag__c), LEN(SFTK_Pkg_Tag__c) &gt; 5 ),
  IF( BEGINS(SFTK_Pkg_Tag__c, &quot;x&quot;), TRUE, CONTAINS(Name, &quot;y&quot;) )
)</errorConditionFormula>
    <errorMessage>SFTK hard fixture: never shown.</errorMessage>
</ValidationRule>
`);

// 2. a formula field that uses it three ways
put(`${O}/fields/SFTK_Hard_Formula__c.field-meta.xml`, `${X}<CustomField ${MD}>
    <fullName>SFTK_Hard_Formula__c</fullName>
    <description>Admin Toolkit HARD fixture: a formula that uses SFTK_Pkg_Tag__c three ways. Safe to delete.</description>
    <externalId>false</externalId>
    <formula>IF( ISBLANK(SFTK_Pkg_Tag__c), &quot;none&quot;, UPPER(SFTK_Pkg_Tag__c) &amp; &quot;-&quot; &amp; TEXT(LEN(SFTK_Pkg_Tag__c)) )</formula>
    <label>SFTK Hard Formula</label>
    <required>false</required>
    <type>Text</type>
    <unique>false</unique>
</CustomField>
`);

// 3. a list view: one column, two of three filters
put(`${O}/listViews/SFTK_Hard_View.listView-meta.xml`, `${X}<ListView ${MD}>
    <fullName>SFTK_Hard_View</fullName>
    <columns>NAME</columns>
    <columns>SFTK_Pkg_Tag__c</columns>
    <columns>CREATED_DATE</columns>
    <filterScope>Everything</filterScope>
    <filters>
        <field>SFTK_Pkg_Tag__c</field>
        <operation>contains</operation>
        <value>demo</value>
    </filters>
    <filters>
        <field>NAME</field>
        <operation>notEqual</operation>
        <value>SFTK never</value>
    </filters>
    <filters>
        <field>SFTK_Pkg_Tag__c</field>
        <operation>notEqual</operation>
        <value>skip</value>
    </filters>
    <label>SFTK Hard View</label>
</ListView>
`);

// 4. a flow: a Get Records filter, a decision, an assignment and a formula at once. Nothing calls it.
put('flows/SFTK_Hard_Flow.flow-meta.xml', `${X}<Flow ${MD}>
    <apiVersion>63.0</apiVersion>
    <assignments>
        <name>Set_Tag</name><label>Set Tag</label><locationX>50</locationX><locationY>350</locationY>
        <assignmentItems><assignToReference>Find_Child.SFTK_Pkg_Tag__c</assignToReference><operator>Assign</operator><value><elementReference>TagUpper</elementReference></value></assignmentItems>
        <assignmentItems><assignToReference>Note</assignToReference><operator>Assign</operator><value><stringValue>kept</stringValue></value></assignmentItems>
    </assignments>
    <decisions>
        <name>Has_Tag</name><label>Has Tag</label><locationX>176</locationX><locationY>242</locationY>
        <defaultConnectorLabel>No</defaultConnectorLabel>
        <rules>
            <name>Tagged</name><conditionLogic>and</conditionLogic>
            <conditions><leftValueReference>Find_Child.SFTK_Pkg_Tag__c</leftValueReference><operator>IsNull</operator><rightValue><booleanValue>false</booleanValue></rightValue></conditions>
            <conditions><leftValueReference>Find_Child.Name</leftValueReference><operator>NotEqualTo</operator><rightValue><stringValue>SFTK never</stringValue></rightValue></conditions>
            <connector><targetReference>Set_Tag</targetReference></connector>
            <label>Tagged</label>
        </rules>
    </decisions>
    <description>Admin Toolkit HARD fixture: one flow that uses SFTK_Pkg_Tag__c in a Get Records filter, a decision, an assignment and a formula at once. Nothing calls it. Safe to delete.</description>
    <formulas>
        <name>TagUpper</name><dataType>String</dataType>
        <expression>UPPER({!Find_Child.SFTK_Pkg_Tag__c}) &amp; &quot;-&quot; &amp; {!Find_Child.Name}</expression>
    </formulas>
    <interviewLabel>SFTK Hard Flow {!$Flow.CurrentDateTime}</interviewLabel>
    <label>SFTK Hard Flow</label>
    <processMetadataValues><name>BuilderType</name><value><stringValue>LightningFlowBuilder</stringValue></value></processMetadataValues>
    <processMetadataValues><name>CanvasMode</name><value><stringValue>AUTO_LAYOUT_CANVAS</stringValue></value></processMetadataValues>
    <processMetadataValues><name>OriginBuilderType</name><value><stringValue>LightningFlowBuilder</stringValue></value></processMetadataValues>
    <processType>AutoLaunchedFlow</processType>
    <recordLookups>
        <name>Find_Child</name><label>Find Child</label><locationX>176</locationX><locationY>134</locationY>
        <assignNullValuesIfNoRecordsFound>false</assignNullValuesIfNoRecordsFound>
        <connector><targetReference>Has_Tag</targetReference></connector>
        <filterLogic>and</filterLogic>
        <filters><field>Name</field><operator>StartsWith</operator><value><stringValue>SFTK Hard</stringValue></value></filters>
        <filters><field>SFTK_Pkg_Tag__c</field><operator>EqualTo</operator><value><stringValue>demo</stringValue></value></filters>
        <getFirstRecordOnly>true</getFirstRecordOnly>
        <object>dlrs__LookupChild__c</object>
        <storeOutputAutomatically>true</storeOutputAutomatically>
    </recordLookups>
    <start><locationX>50</locationX><locationY>0</locationY><connector><targetReference>Find_Child</targetReference></connector></start>
    <status>Active</status>
    <variables><name>Note</name><dataType>String</dataType><isCollection>false</isCollection><isInput>false</isInput><isOutput>false</isOutput></variables>
</Flow>
`);

// 5. the object's own layout: a section and the mini layout (a field sits on a layout once per section list)
put('layouts/dlrs__LookupChild__c-SFTK Hard Layout.layout-meta.xml', `${X}<Layout ${MD}>
    <layoutSections>
        <customLabel>false</customLabel>
        <detailHeading>false</detailHeading>
        <editHeading>true</editHeading>
        <label>Information</label>
        <layoutColumns>
            <layoutItems><behavior>Required</behavior><field>Name</field></layoutItems>
            <layoutItems><behavior>Edit</behavior><field>SFTK_Pkg_Tag__c</field></layoutItems>
        </layoutColumns>
        <layoutColumns>
            <layoutItems><behavior>Edit</behavior><field>SFTK_Pkg_Tag2__c</field></layoutItems>
        </layoutColumns>
        <style>TwoColumnsTopToBottom</style>
    </layoutSections>
    <miniLayout>
        <fields>Name</fields>
        <fields>SFTK_Pkg_Tag__c</fields>
    </miniLayout>
</Layout>
`);
// 6. the PARENT's layout: the field as a column of the related list and as its sort field
put('layouts/dlrs__LookupParent__c-SFTK Hard Parent Layout.layout-meta.xml', `${X}<Layout ${MD}>
    <layoutSections>
        <customLabel>false</customLabel>
        <detailHeading>false</detailHeading>
        <editHeading>true</editHeading>
        <label>Information</label>
        <layoutColumns>
            <layoutItems><behavior>Required</behavior><field>Name</field></layoutItems>
        </layoutColumns>
        <layoutColumns/>
        <style>TwoColumnsTopToBottom</style>
    </layoutSections>
    <relatedLists>
        <fields>NAME</fields>
        <fields>SFTK_Pkg_Tag__c</fields>
        <relatedList>dlrs__LookupChild__c.dlrs__LookupParent__c</relatedList>
        <sortField>SFTK_Pkg_Tag__c</sortField>
        <sortOrder>Asc</sortOrder>
    </relatedLists>
</Layout>
`);

// 7. a report: a grouping and two of three filters
put('reports/unfiled$public/SFTK_Hard_Report.report-meta.xml', `${X}<Report ${MD}>
    <columns><field>dlrs__LookupChild__c$Name</field></columns>
    <description>Admin Toolkit HARD fixture: the field as a grouping and in two of three filters.</description>
    <filter>
        <criteriaItems><column>dlrs__LookupChild__c$SFTK_Pkg_Tag__c</column><columnToColumn>false</columnToColumn><isUnlocked>true</isUnlocked><operator>notEqual</operator><value>never-sftk</value></criteriaItems>
        <criteriaItems><column>dlrs__LookupChild__c$Name</column><columnToColumn>false</columnToColumn><isUnlocked>true</isUnlocked><operator>notEqual</operator><value>SFTK never</value></criteriaItems>
        <criteriaItems><column>dlrs__LookupChild__c$SFTK_Pkg_Tag__c</column><columnToColumn>false</columnToColumn><isUnlocked>true</isUnlocked><operator>notEqual</operator><value>skip</value></criteriaItems>
    </filter>
    <format>Summary</format>
    <groupingsDown><dateGranularity>Day</dateGranularity><field>dlrs__LookupChild__c$SFTK_Pkg_Tag__c</field><sortOrder>Asc</sortOrder></groupingsDown>
    <name>SFTK Hard Report</name>
    <reportType>SFTK_Pkg_RT__c</reportType>
    <scope>organization</scope>
    <showDetails>true</showDetails>
    <showGrandTotal>true</showGrandTotal>
    <showSubTotals>true</showSubTotals>
</Report>
`);

// 8. a Lightning page: the fc-app page (a field component and a visibility filter) with a SECOND component whose
//    visibility filter names the field too — three places in one page
{
  let page = readFileSync(join(HERE, 'fc-app/main/default/flexipages/SFTK_Pkg_Page.flexipage-meta.xml'), 'utf8')
    .replace(/SFTK Pkg Page/g, 'SFTK Hard Page').replace('a record page of a PACKAGED object, never assigned.', 'HARD fixture, never assigned.');
  const second = `        <itemInstances>
            <componentInstance>
                <componentName>force:relatedListContainer</componentName>
                <identifier>force_relatedListContainer</identifier>
                <visibilityRule>
                    <criteria>
                        <leftValue>{!Record.SFTK_Pkg_Tag__c}</leftValue>
                        <operator>NE</operator>
                        <rightValue>hide</rightValue>
                    </criteria>
                </visibilityRule>
            </componentInstance>
        </itemInstances>
        <name>header</name>`;
  if (page.split('        <name>header</name>').length !== 2) throw new Error('the page fixture changed shape');
  page = page.replace('        <name>header</name>', second);
  put('flexipages/SFTK_Hard_Page.flexipage-meta.xml', page);
}

// 9. code: several lines each (✂ is not offered for code — these are for ⇄ and ✎)
put('classes/SFTK_Hard_Class.cls', `public class SFTK_Hard_Class {
    // Admin Toolkit HARD fixture: SFTK_Pkg_Tag__c on several lines, in SOQL, a read, a write and a comparison.
    public static List<dlrs__LookupChild__c> tagged() {
        return [SELECT Id, Name, SFTK_Pkg_Tag__c FROM dlrs__LookupChild__c WHERE SFTK_Pkg_Tag__c != null ORDER BY SFTK_Pkg_Tag__c LIMIT 5];
    }
    public static String upper(dlrs__LookupChild__c c) {
        String t = c.SFTK_Pkg_Tag__c;
        return t == null ? null : t.toUpperCase();
    }
    public static void clear(dlrs__LookupChild__c c) {
        if (c.SFTK_Pkg_Tag__c == 'sftk-never') c.SFTK_Pkg_Tag__c = null;
    }
}
`);
put('classes/SFTK_Hard_Class.cls-meta.xml', `${X}<ApexClass ${MD}><apiVersion>62.0</apiVersion><status>Active</status></ApexClass>\n`);
put('triggers/SFTK_Hard_Trigger.trigger', `trigger SFTK_Hard_Trigger on dlrs__LookupChild__c (before update) {
    // Admin Toolkit HARD fixture: reads SFTK_Pkg_Tag__c on several lines and changes nothing.
    for (dlrs__LookupChild__c c : Trigger.new) {
        dlrs__LookupChild__c old = Trigger.oldMap.get(c.Id);
        Boolean changed = c.SFTK_Pkg_Tag__c != old.SFTK_Pkg_Tag__c;
        if (changed && c.SFTK_Pkg_Tag__c == 'sftk-never') System.debug(old.SFTK_Pkg_Tag__c);
    }
}
`);
put('triggers/SFTK_Hard_Trigger.trigger-meta.xml', `${X}<ApexTrigger ${MD}><apiVersion>62.0</apiVersion><status>Active</status></ApexTrigger>\n`);
console.log('hard-app written');
