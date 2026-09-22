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

Rebuild in one go: `bash docs/fixtures/field-cleaner-fixture/rebuild.sh [alias]` (default `npc`).
It does the steps below and prints the versions + interview count at the end.

Rebuild by hand (each deploy of a changed flow creates a new version):
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

Live run (headless): `node scripts/dev/headless-studio.mjs scripts/dev/live/field-cleaner.mjs`
with `SCAN_ONLY=1` (nothing written), `ACTIVE=replace|delete` (the active-version choice),
`DELETE_FIELD=1` (finish with 🗑 Delete Field). Rebuild the fixture after a deleting run.

## Findings log (campaign 2, 2026-09-22 — what the fixture caught)

- ✅ verified: scan finds all 4 flow versions (v3 Active, v4 Draft, v1/v2 Obsolete), the
  data verdict, the permission-set visibility line; nothing is written by a scan.
- ✅ fixed: the fix dialog OFFERED and PRESELECTED "Keep the flow running" although its own
  preview said two elements would be left empty — Salesforce refused the new version
  ("Required field assignmentItems is empty"; nothing deleted, correct). Now replace is not
  preselected when elements would be emptied, and the option says why; the refusal quotes
  Salesforce and points at "Delete the active version too" / Flow Builder instead of the
  data-deployment hint ("map them from a source field").
- ✅ fixed: the interview check found NO interviews — `FlowInterview.FlowVersionViewId`
  matches the 15-character id only, the query used 18-character ids. So every version with a
  failed interview was refused (DEPENDENCY_EXISTS naming the very interviews), yet the row was
  marked ✅ and the delete zone read "All dependencies resolved. Safe to delete." Now: both id
  forms are queried; a refused version / interview is NOT done (the ✂ button comes back with
  "Not finished: …"); the DEPENDENCY_EXISTS text reads as a sentence with the interview ids.
- ✅ fixed: 🗑 Delete Field failed with INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY with
  every dependency gone. Reproduced by CLI on a brand-new text field on Account, on Contact,
  on a brand-new custom object, and in trailheads4: a Tooling API DELETE of CustomField is
  refused in both orgs, while a Metadata API deploy with destructiveChanges.xml deletes the
  same field at once. The delete now falls back to the Metadata API on any Tooling refusal
  (and reports the Metadata API's words, which name the real blocker); the explanation quotes
  Salesforce. Never verified live before this campaign.
- ✅ fixed: after a successful delete the page went BLANK — the "Field deleted" card was
  written and then erased by the reset that follows it. Reset first, card after.
- ✅ verified end to end (run 5): flow switched OFF (verified) · 4 versions deleted · 5
  interviews deleted · field deleted through the Metadata API; CLI: 0 versions, 0 interviews,
  field in Deleted Fields as `SFTK_FC_Test_Status_del2`.
- Not exercised yet: "Keep the flow running" on a flow whose fix leaves nothing empty
  (needs a fixture flow where the field sits in a filter, not an assignment), the XML
  inspector's selective removal, 🕐 Deprecate first, the CSV value backup, the deletion log.
