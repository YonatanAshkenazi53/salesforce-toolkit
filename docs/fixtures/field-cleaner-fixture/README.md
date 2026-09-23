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

## Picklist Manager on this field (campaign 2, 2026-09-23)

Seed records: `sf apex run -f docs/fixtures/field-cleaner-fixture/seed-pk.apex -o npc` (8 Accounts
"SFTK PK Account N": 5 on Closed, 3 on Reviewed). Live run:
`node scripts/dev/headless-studio.mjs scripts/dev/live/picklists.mjs` with `ACTION=none|toggle|delete|fix`,
`VALUE=Closed`, `FIX=remap|clear|skip`, `TARGET=New`, `TYPE_IT=1` (type the org name at a production gate).
The view opens in the mode last used (compare by default) - the script clicks "Single org".

- verified: inventory (3 values, usage counts, record types, notes), the wizard (automation scan
  first, then remap / clear / skip), the data fix (5 records moved Closed to New, 3 cleared; History
  entries "Picklist fix: ..."), Activate, Deactivate - all confirmed by CLI.
- fixed: a value nobody holds read "-" (the "not counted" mark) - a counted zero reads 0.
- fixed: EVERY metadata PATCH (CustomField, RecordType, StandardValueSet, GlobalValueSet, and the
  Field Cleaner Deprecate / Undo deprecate) sent the Metadata back as read, nulls and all, and
  Salesforce refused it: "Cannot deserialize instance of complexvalue from VALUE_NULL value null".
  Proven by CLI (same body, nulls stripped = accepted). sftkMetaForPatch (sftk-zip.js) strips
  null keys and urls before every such PATCH (pins: meta-for-patch-0923). The data fix had
  already moved the records when the metadata step failed - the tool said so, nothing hidden.
- fixed: "Delete value" claimed "Value deleted from the value set" while Salesforce KEPT the
  value as inactive - its API cannot delete a picklist value (only Setup can). The tool re-reads
  the field and says "kept as INACTIVE ... Setup > Object Manager > ... > Values > Del"; the wizards
  say so up front; the bulk summary counts values Salesforce kept (pins: picklists-live-0923).
- Not exercised: multi-org compare / bulk / Sync from source (next), record-type matrix edits,
  standard and global value sets, the typed production gate (needs Guard as production).

## Picklist Manager, compare mode (2026-09-23)

The field also exists in trailheads4 (`base` deployed there; permission set assigned - without
FLS the org's describe does not list the field and the matrix says "not found ... or hidden from
your user by field-level security"). trailheads4 got a fourth value "Archived" (scratchpad deploy)
so the orgs drift. Live: `node scripts/dev/headless-studio.mjs scripts/dev/live/picklists-compare.mjs`
with `MODE=matrix|sync|bulk`, `VALUE=Archived`, `FIX=skip|clear|remap`, `SCAN_ONLY=1`.

- verified: the 2-org matrix (active / inactive / absent per org, usage counts), the sync plan
  (source = trailheads2; deactivate Closed + Reviewed in the target, "Deactivate extra: Archived -
  never deleted automatically" unticked by default, record-type alignment, automation check with
  its honest caps) and the run: target values match the source, CLI agrees, matrix re-read agrees.
- verified: bulk deactivate of Archived across both orgs - "not present - skipped" where absent,
  deactivated where present, one History entry per org; CLI agrees.
- fixed: the automation verdict said "no flow or validation rule ... names this value" next to
  "scanned 40 of 147 active flows - the other 107 were NOT checked" - a partial scan now says
  "nothing that was scanned ... names this value".
- fixed: the bulk wizard's Apply was clickable while the automation check was still running;
  it waits for every org's answer now, like the sync plan's Run.
- fixed: "not found on Account" for a field the user cannot see now mentions field-level security.

## Field Cleaner - Deprecate first / Undo (2026-09-23)

Live: `DEPRECATE=1 [UNDO=0] node scripts/dev/headless-studio.mjs scripts/dev/live/field-cleaner.mjs`
(Deprecate, then Undo in the SAME session - the record lives in the extension's storage and the
harness starts a fresh profile per run). Restore by hand: redeploy `base` (label, description,
permission-set grant).

- fixed: the label rename PATCH itself was refused (nulls - see sftkMetaForPatch above).
- fixed: one grant Salesforce refuses to strip - the "Slack Integration User" session permission
  set (sfdcInternalInt, nobody can edit it) - made the whole step "fail": the field was renamed
  and the permission set's grant stripped, but nothing was recorded and no Undo was offered; a
  second click stamped the description twice. Now the refusing grant is named in the banner
  ("1 could NOT be: Slack Integration User ... the field stays visible there"), the record is
  saved, Undo exists, the description is stamped once.
- fixed: Undo did not bring the grant back - Salesforce DELETES a FieldPermissions row once both
  permissions are false, so the update by the old Id did nothing. Undo re-creates each grant
  (insert; update by Id as the fallback) and names anything that did not come back.
- verified end to end: Deprecate (label zz_DEPRECATED..., description stamped, permission set's
  grant gone, Slack kept) then Undo (label, description and the grant read+edit back) - CLI agrees.

## Pass 2 - "Keep the flow running" succeeds (2026-09-23)

`flow2/` holds `SFTK_FC_Test_Flow2` (Active): the field is ONE of two filters of a record lookup,
so the automatic fix leaves nothing empty. Deploy: `cd flow2 && sf project deploy start -o npc --source-dir force-app`.
Live: `ACTIVE=replace FLOW="SFTK FC Test Flow 2" node scripts/dev/headless-studio.mjs scripts/dev/live/field-cleaner.mjs`
(FLOW picks that flow's button; without it the first flow's button is taken).

- verified: the dialog preselects "Keep the flow running" (nothing left empty); the run deploys
  v2, verifies it ACTIVE by re-reading the org, deletes v1; CLI: only v2 Active, the lookup keeps
  its Name filter. The old fixture flow (v3 Active with assignments) is still refused on replace
  and left untouched, as in pass 1.
