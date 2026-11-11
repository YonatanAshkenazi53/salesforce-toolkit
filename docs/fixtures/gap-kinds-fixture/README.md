# The kinds found by asking "what are we missing?" (2026-11-11)

Owner: "יש מצב שלא חשבנו על כל סוגי המטאדאטה? … תוסיף את אלו שעלולים לחסום אבל גם custom settings".

Deployed to npc: `sf project deploy start -o npc --source-dir force-app --test-level NoTestRun`, then one record:
`sf data create record -o npc -s SFTK_Gap_Set__c -v "Name=GapRef Field_Name__c='Case.SFTK_Gap__c'"`.

| component | what it proves |
|---|---|
| `Case.SFTK_Gap__c` | the field Field Cleaner scans |
| entitlement process `sftk gap ep` (inactive; exit and milestone criteria on the field) | Salesforce REFUSES the field's delete: "This custom field is referenced elsewhere in salesforce.com. : Entitlement Processes." The dependency index returns nothing. Field Cleaner lists it (🔒) with 🗑; a check-only delete of the process itself is accepted |
| custom setting `SFTK_Gap_Set__c`, record `GapRef` holding `Case.SFTK_Gap__c` as text | does NOT block. Field Cleaner lists it under 👀 Custom Setting Records |

Not built, and why:
- **Omni-Channel** (`ServiceChannel.secondaryRoutingPriorityField`): npc refuses the deploy — "Secondary Routing Priority is not enabled".
- **Territory assignment rules**: Enterprise Territory Management is not enabled in npc (no Territory2 types), and enabling it cannot be undone.
