# Field Cleaner live matrix fixture (fc-matrix-live)

Proves that Salesforce ACCEPTS the XML / JSON that Field Cleaner's pure transforms produce. Built and run on `npc`
on 2026-11-14; fully removed from the org afterwards (see the run log at the end).

## What it builds

| Component | Names Account.SFTK_MX_Region__c |
|---|---|
| `Account.SFTK_MX_Region__c`, `Account.SFTK_MX_Area__c` (Text 80) | the field / the replacement |
| `Contact.SFTK_MX_Region__c` (Text 80) | Contact's same-named field (must never be touched) |
| validation rules `Account.SFTK_MX_VR_One` / `SFTK_MX_VR_Many` | once / twice + errorDisplayField |
| formula fields `Account.SFTK_MX_Fx1__c` / `SFTK_MX_Fx2__c` | once / twice |
| workflow rule `SFTK_MX_WF` (criteria) and `SFTK_MX_WF_Formula` (formula), field updates `SFTK_MX_FU_Target` (writes the field) and `SFTK_MX_FU_Formula` (formula, twice) | |
| flow `SFTK_MX_RT_Flow` (before-save on Account: decision + assignment + record update) | 3 places |
| flow `SFTK_MX_Screen_Flow` (Get Account + Get Contact + display text) | Account 3, Contact 3 |
| layout `Account-SFTK MX Layout` (section + mini layout; Contacts related list shows Contact's field) | 2 |
| Lightning record page `SFTK_MX_Account_Page` (Dynamic Forms field + visibility rule with `1 AND 2`) | 2 |
| list views `Account.SFTK_MX_View` (column + filter) / `SFTK_MX_View_One` (column) | |
| custom report type `SFTK_MX_RT` (Account column + Contacts column of the same name) | 1 (+1 Contact) |
| reports `SFTK_MX_Report` (column + filter) / `SFTK_MX_Contact_Report` (Contact only) | |
| email templates `SFTK_MX_VF` (Visualforce: subject + markup, plus `recipient.` = Contact) / `SFTK_MX_Text` (text, plus `{!Contact.…}`) | |
| quick action `Account.SFTK_MX_Update` (layout + predefined value) | 2 |
| compact layout, field sets (Account + Contact), custom link `Account.SFTK_MX_Link` (URL, twice), approval process `Account.SFTK_MX_Approval` (criterion + page field) | |
| Contact only: `Contact.SFTK_MX_VR_Contact`, `Contact.SFTK_MX_Contact_View`, `Contact.SFTK_MX_Contact_FS`, `SFTK_MX_Contact_Report` | Contact's field only |
| permission set `SFTK_MX_Access` (FLS on the three fields; the quick action's predefined value needs it at deploy time) | |

Not in the fixture (refused by this org, not by the product): a Create-Contact quick action on Account and any
quick action on Contact (Salesforce: "An unexpected error occurred" on every shape tried); a Lightning (SFX) email
template (no Metadata API form).

## Deploy (two steps: the quick action's predefined value needs the field-level security first)

```
cd docs/fixtures/fc-matrix-live
sf project deploy start -o npc --test-level NoTestRun \
  --source-dir force-app/main/default/objects/Account/fields/SFTK_MX_Region__c.field-meta.xml \
  --source-dir force-app/main/default/objects/Account/fields/SFTK_MX_Area__c.field-meta.xml \
  --source-dir force-app/main/default/objects/Contact/fields/SFTK_MX_Region__c.field-meta.xml \
  --source-dir force-app/main/default/permissionsets
sf org assign permset -o npc --name SFTK_MX_Access
sf project deploy start -o npc --source-dir force-app --test-level NoTestRun
```

A reset between rounds is the second deploy again (it was verified to bring every component back to the baseline).

## Run the matrix (harness/, sf CLI only, no browser, no token handled)

The harness loads the PRODUCT's own functions (sftk-relmap.js first via test/setup-relmap.mjs, then sftk-mdapi.js,
sftk-fieldreplace.js, sftk-emailtpl.js, sftk-reportclean.js and the closure functions of field-cleaner.js) and
writes each result the way the product does: MDAPI deploy of `sftkMdPackageFiles` (and `sftkRtZipFiles`,
`buildFlowXml`), Tooling PATCH for Layout / FlexiPage, Analytics PATCH for reports, REST PATCH for email templates.
Reads use a CLI retrieve (mdapi format) cut into readMetadata's shape.

```
node harness/snap.mjs base        # baseline retrieve (manifest/package.xml)
node harness/run.mjs swap         # ⇄ every component → results in %TEMP%/sftk-fc-matrix-live/results
node harness/snap.mjs swap        # then: diff -r <tmp>/snap/base <tmp>/snap/swap
(redeploy = reset)
node harness/run.mjs cut          # ✂ every component
node harness/snap.mjs cut
node harness/run.mjs swap "CustomField:|WorkflowFieldUpdate:|WorkflowRule:Account.SFTK_MX_WF_Formula|WebLink:|Flow:SFTK_MX_Screen_Flow"
node harness/vers.mjs             # flow versions; the obsolete ones go with a destructive deploy of Flow:<Name>-<n>
node harness/del.mjs '[["CustomField","Account.SFTK_MX_Region__c"]]' field
```

## Cleanup

```
node harness/off.mjs                                   # deactivate both flows
node harness/del.mjs '[["Flow","SFTK_MX_RT_Flow-<n>"],["Flow","SFTK_MX_Screen_Flow-<n>"]]' flows   # every version (vers.mjs lists them)
sf data delete record -o npc -s PermissionSetAssignment -i <the SFTK_MX_Access assignment Id>
sf project deploy start -o npc --manifest cleanup/package.xml --post-destructive-changes cleanup/destructiveChanges.xml --purge-on-delete
# deleted reports sit in the recycle bin and block their folder: empty them (Database.emptyRecycleBin on the two
# reports, ALL ROWS), then delete the folders: Report SFTK_MX_Reports and EmailTemplate SFTK_MX_Email
node harness/gone.mjs                                  # every count 0 (deleted fields show as *_del until erased)
```

Without `--purge-on-delete` the deleted fields stay in Setup → Deleted Fields (`SFTK_MX_*_del`) for 15 days.
