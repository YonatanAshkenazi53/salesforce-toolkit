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
