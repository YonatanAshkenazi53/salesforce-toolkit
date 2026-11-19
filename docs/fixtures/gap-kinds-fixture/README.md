# The kinds found by asking "what are we missing?" (2026-11-11)

Owner: "יש מצב שלא חשבנו על כל סוגי המטאדאטה? … תוסיף את אלו שעלולים לחסום אבל גם custom settings".

Deployed to npc: `sf project deploy start -o npc --source-dir force-app --test-level NoTestRun`, then one record:
`sf data create record -o npc -s SFTK_Gap_Set__c -v "Name=GapRef Field_Name__c='Case.SFTK_Gap__c'"`.

| component | what it proves |
|---|---|
| `Case.SFTK_Gap__c` | the field Field Cleaner scans |
| entitlement process `sftk gap ep` (inactive; exit and milestone criteria on the field) | Salesforce REFUSES the field's delete: "This custom field is referenced elsewhere in salesforce.com. : Entitlement Processes." The dependency index returns nothing. Field Cleaner lists it (🔒) with 🗑; a check-only delete of the process itself is accepted |
| custom setting `SFTK_Gap_Set__c`, record `GapRef` holding `Case.SFTK_Gap__c` as text | does NOT block. Field Cleaner lists it under 👀 Custom Setting Records |

Added the same day, with the owner's word to switch the features on in npc:

| component | what it proves |
|---|---|
| `omni-app/` — OmniChannel settings: secondary routing priority ON | the switch the channel needs (deploy this first) |
| `chan-app/` — `Case.SFTK_Gap_Pri__c` (picklist) and service channel `SFTK_Gap_Channel` with it as secondary routing priority | Salesforce REFUSES the delete of the picklist: "This custom field is used by the service channel: SFTK_Gap_Channel. : This field is used as the secondary routing priority field." Field Cleaner lists it (🔒 Service Channels) with 🗑 |

Not built, and why:
- **Territory assignment rules**: Enterprise Territory Management cannot be switched on through the Metadata API in npc
  ("You do not have the level of access required to deploy this component") — it is a button in Setup → Territory
  Settings, and it cannot be undone. Every Territory2 type answers "Not available for deploy for this organization".

## kinds-app — the kinds the owner asked to add on 2026-11-17 ("All of them please")

Deployed to npc2: `sf project deploy start -o npc2 --source-dir kinds-app --test-level NoTestRun`, then
`sf org assign permset -o npc2 -n SFTK_Kind_Access` (without it the admin does not see the two fields).

| component | what it proves (check-only delete of the field, npc2, 2026-11-17) |
|---|---|
| `SFTK_Kind__c.Tag__c` named by static resource `SFTK_Kind_Js` (JavaScript) | does NOT block. 🧭 lists it under 👀 Static Resources ("1 of 1 read as text") |
| the same field as an enriched field of channel member `SFTK_Kind_Chn_chn_SFTK_Kind_ChangeEvent` | does NOT block. 🧭 lists it under 👀 Change Data Capture channels |
| `SFTK_Kind__c.Pick__c` with values assigned in record type `SFTK_Kind_RT` | does NOT block. 🧭 already reads record-type picklist values |

Not built yet: bots, Prompt Builder templates (both types exist in npc and npc2), a dashboard filter. Not possible in
these orgs: CRM Analytics (no Wave types), territory rules (see above), Einstein Lead Scoring, field names held in
package data (CPQ, OmniStudio are not installed).

### 2026-11-18 — home page component (owner: "and add all the 4")

`kinds-app/main/default/homePageComponents/SFTK_Kind_Home` — an HTML home page component whose body names
`SFTK_Kind__c.Tag__c`. Deployed to npc2. The check-only delete of the field is ACCEPTED (does not block); 🧭 lists it
under 👀 Home page components. Its `<width>` is `narrow` (`NarrowComponents` is refused by the deploy).

### 2026-11-18 — an LWC that only names the field

`kinds-app/main/default/lwc/sftkKindText` — its template (`field-name="Tag__c"`) and a string in its script name
`SFTK_Kind__c.Tag__c`; there is no `@salesforce/schema` import. Deployed to npc2. The check-only delete of the field is
ACCEPTED. The regular scan lists it under 👀 "Lightning Web Components (name the field as text)".

### 2026-11-18 — Apex that names the field only inside a string

`kinds-app/main/default/classes/SFTK_Kind_Dyn` — `r.get('Tag__c')` and a SOQL string; nothing compiles against the
field. Deployed to npc2. The check-only delete is ACCEPTED. The regular scan lists it under 👀 "Apex Classes (name the
field in a string)". A SOSL search does not look inside class bodies (read live), so the scan reads them by Tooling.

### 2026-11-19 — a related-list column on a parent's layout, and a child object's list view

- `SFTK_Kind__c.Acct__c` (lookup to Account) + layout `Account-SFTK Kind RL Layout`: its related list
  `SFTK_Kind__c.Acct__c` shows `Tag__c` as a column. (An Account layout must hold `ParentId`, or the deploy is refused.)
- object `SFTK_Kind_Child__c` (lookup `Kind__c` → SFTK_Kind__c) + list view `SFTK_Kind_Child_LV` with
  `<columns>SFTK_Kind__c.Tag__c</columns>`. Read live: `Kind__r.Tag__c` and `Kind__c.Tag__c` are refused; Salesforce
  returns the column as `01Ibm00000EVKon.Tag__c` and refuses THAT on a deploy.
Both deployed to npc2. Neither blocks the delete; the regular scan lists both under 👀.

### 2026-11-19 — a prompt template that merges the field (BLOCKS)

`kinds-app/main/default/genAiPromptTemplates/SFTK_Kind_Prompt` — a flex template (`einstein_gpt__flex`) with one input
`SOBJECT://SFTK_Kind__c` and the merge field `{!$Input:Kind.Tag__c}`. Deployed to npc2 with no model to copy from — the
XML above is one Salesforce accepts. The check-only delete of the field is REFUSED: "This custom field is referenced
elsewhere in salesforce.com. : Generative AI Prompt Template Version - 3vN…". `GenAiPromptTemplate` is not an sObject
(SOQL and Tooling: "sObject type 'GenAiPromptTemplate' is not supported").
