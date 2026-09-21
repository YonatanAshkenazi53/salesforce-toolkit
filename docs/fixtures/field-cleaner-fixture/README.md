# Field Cleaner test fixture

Deployed to trailheads2 (CLI alias `npc`) on 2026-09-21 at the owner's request.

What it builds
- `Account.SFTK_FC_Test_Status__c` — a restricted picklist (New / Reviewed / Closed)
- permission set `SFTK_FC_Test_Access` — grants access to the field (a second kind of reference)
- flow `SFTK_FC_Test_Flow` — FOUR versions, every one references the field:
  - v1 Obsolete — Decision + a record create that sets the field · 2 failed interviews
  - v2 Obsolete — adds an Assignment that reads the field · 2 failed interviews
  - v3 **Active** — adds a second Decision outcome · 1 failed interview
  - v4 Draft — adds a formula `TEXT({!acct.SFTK_FC_Test_Status__c})`

The flow fails ON PURPOSE (it creates an Account with no name), which is how the
failed interviews (`FlowInterview`, `InterviewStatus = Error`) come to exist.
Nothing calls the flow. Each failure sends Salesforce's standard flow-error email.

Rebuild (each deploy of a changed flow creates a new version):
1. `cd base && sf project deploy start -o npc --source-dir force-app --test-level NoTestRun`
2. `sf org assign permset -o npc --name SFTK_FC_Test_Access`
3. for v in 1 2 3 4: copy `versions/SFTK_FC_Test_Flow.v$v.flow-meta.xml` to a project's
   `flows/SFTK_FC_Test_Flow.flow-meta.xml`, deploy it, and after v1–v3 run
   `sf api request rest "services/data/v64.0/actions/custom/flow/SFTK_FC_Test_Flow" --method POST --body @inputs.json -o npc`

What Field Cleaner should offer for the field
- v1, v2, v4 (inactive, reference the field) → delete the version, backup offered first
- the 4 failed interviews on v1/v2 → deleted with their version
- v3 (active) → save a NEW version without the reference, verify it is active, then delete v3 (and its interview)
- the permission set → its own reference row
