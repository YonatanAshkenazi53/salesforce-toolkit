# Popup write tools - live fixture and findings (2026-09-23)

Org: trailheads2 (alias `npc`). Fixture made by CLI (no files):
- users `sftk.test.a@trailheads2.sftk.test` / `sftk.test.b@...` (profile Identity User, Identity
  license - the only Salesforce license is the admin's), public group `SFTK_Test_Group`;
  user A holds the permission set `SFTK_FC_Test_Access` and the group.
- flow `SFTK_AV_Test_A` (apiver fixture) and permission set `SFTK_FC_Test_Access` for Flow Access.
- Lightning record page `SFTK_LP_Test_Account_Page` (`docs/fixtures/lightning-page-fixture`,
  deploy with `sf project deploy start -o npc --source-dir force-app`).

Scripts (all `node scripts/dev/headless-studio.mjs scripts/dev/live/<name>.mjs`):

| tool | script | env |
|---|---|---|
| Copy Permissions | `copy-perms.mjs` | SRC, TGT, SCAN_ONLY=1 |
| Licenses | `licenses.mjs` | USER, ACTION=deactivate/reactivate/cycle, SCAN_ONLY=1 |
| Flow Access | `flow-access.mjs` | FLOW, PS, SCAN_ONLY=1 |
| Lightning Pages | `lightning-pages.mjs` | PAGE, STEP=detail/orgdefault/appdefault/artp/remove/deactivate/clone/users/whosees/cycle, APP, PROFILE, RT, ROW, FF, COPY=1, UNDO=1, SCAN_ONLY=1 |

## Findings

- fixed: Copy Permissions wrote on the click (profile, permission sets, groups, user fields) with
  no summary and no acknowledgement. It confirms now, naming every planned operation
  (pins: copy-perms-confirm-0923).
- verified: copy A to B - preview correct (profile same, 1 permission set, 1 group, user
  permissions off for both), result "1 permission set assigned, added to 1 group"; CLI agrees.
- verified: Licenses deactivate and reactivate (confirm modal each), CLI agrees. Fixed: after a
  deactivation the user vanishes from the list (Active filter by default) so Reactivate could not
  find them; the result now says they moved to the Inactive filter (pins: licenses-hint-0923).
- verified: Flow Access - grant one flow to one permission set (confirm modal, Metadata deploy of
  flowAccesses), result "1 Flow Assigned"; CLI shows the SetupEntityAccess row.
- verified: Lightning Pages - detail of the fixture page, Set as Org Default (Desktop) deploys a
  CustomObject.actionOverrides View override (CLI shows it), the detail re-reads "Active, Org
  Default, Desktop"; removing the assignment asks, deploys, and the override is gone (CLI).
- fixed (user 2026-09-23: "if there's no assignment you should say no assignments"): before any
  assignment the detail read "Unknown / Could not determine assignments - status unknown for this
  page type". Salesforce has NO publish status for a FlexiPage (the Tooling field does not exist;
  activation IS the assignments), so every untouched page read that way. It now reads "Not
  assigned - this page is not shown to anyone yet. Add one below: ..."; "Unknown - check failed"
  is kept only when the org-default probe itself failed, with the reason (pins: lp-unassigned-0923).
  Verified live on the fixture page.
- not exercised: Change License, permission set groups, App default / App+RecordType+Profile
  assignments, Clone, Deactivate page, the user-lens pages.

**Role (2026-09-29):** trailheads5 has one role, `SFTK Test Role` (00E9k0000002CmfEAE), held by SFTK Test A; SFTK Test B has none — `copy-perms.mjs UNDO=1` copies it to B and the History undo takes it off again. Identity-licence users accept a role.
- rebuilt 2026-10-04 (campaign 4 phase 10): app default and app + record type + profile had never
  been accepted by Salesforce, an app assignment silently made the page the org default, and
  Deactivate could reset another page's org default. Fixture app `SFTK_LP_Test_App` added
  (`docs/fixtures/lightning-page-fixture`). All steps above verified with CLI truth; baseline after
  the session: `SFTK_LP_Test_Account_Page` is Account's Desktop org default, the app holds nothing.
