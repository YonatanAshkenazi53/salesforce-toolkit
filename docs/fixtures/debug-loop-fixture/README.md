# Debug-loop fixture (the Debugger chapter of the walkthrough video)

User 2026-10-09: "can we show a video of a flow that retriggers code or something in
iterations and how our debug tool helps to recognize it?"

- `Account.SFTK_Dbg_Count__c` — a Number field.
- `SFTK_Dbg_Loop` — an active after-save flow on Account that updates the record it was
  triggered by (`SFTK_Dbg_Count__c + 1`). Updating the triggering record in an after-save flow
  fires the flow again, so one save runs it several times in one transaction; its entry
  condition (`SFTK_Dbg_Count__c < 5`) stops it at 5. That is the recursion the Debugger's
  automation analysis flags (LOOP badge on the log row, the "Recursion" banner with the count).

Deploy: `cd docs/fixtures/debug-loop-fixture && sf project deploy start -o npc --source-dir force-app`
Trigger a run (with a trace on the running user): set the field to 0 on an Account —
`sf data update record -o npc -s Account -i <id> -v "SFTK_Dbg_Count__c=0"` — and read the field back:
it reads 5. The video chapter does this off camera and opens the log on screen.

The flow is ACTIVE on trailheads5 and fires on every Account save while the field is below 5;
leave the field at 5 (or empty — null is not "< 5", so the flow does not fire) when not testing.
Remove: `sf project delete source -o npc -m Flow:SFTK_Dbg_Loop,CustomField:Account.SFTK_Dbg_Count__c`
(mind that this also deletes the local files; prefer a destructiveChanges deploy).
