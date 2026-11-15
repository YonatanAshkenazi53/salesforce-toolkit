# fc-undo-all — throwaway fixture for scripts/dev/live/fc-undo-all.mjs

Account.SFTK_UA_Field__c with two validation rules that can never fire, a list view that shows it, and a
permission set that gives the running user access to it. The script deploys it to npc, drives Field Cleaner
(✎ XML editor with ✓ Validate, 🗑 delete, ↩ Undo all) and removes everything at the end (cleanup/).

Deploy: `sf project deploy start -o npc --source-dir force-app` then `sf org assign permset -o npc -n SFTK_UA_Access`.
Remove: delete the PermissionSetAssignment of SFTK_UA_Access first (Salesforce refuses to delete an assigned set), then `sf project deploy start -o npc --metadata-dir cleanup`.
