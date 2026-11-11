# QA audit 2026-11-11 — "a failed read taken as nothing there"

Asked by the owner after Field Cleaner said "Could not locate this field" for a field that exists. Three read-only
reviews of the shipped code (Field Cleaner · Data Studio · the popup tools and the background query layer), each
finding then checked in the code before a fix. Status: FIXED (with the commit) · OPEN · DISMISSED (why).

Transport facts (background.js): a failed query reaches the caller as `{ error }`, never as an empty list;
`SF_QUERY_ALL` answers `{ records, incomplete: { expected, got } }` with NO error when it came back short;
`SF_QUERY` / `SF_REST_QUERY` return one page; a metadata deploy that times out while polling answers `{ error }`
although the job may still finish.

## Field Cleaner (field-cleaner.js)

| id | sev | finding | status |
|---|---|---|---|
| FC-1 | HIGH | every leg of `scanSupplemental` swallowed its failure → kind missing, "the scan lists no blocker", Delete enabled | see below |
| FC-2 | HIGH | one failed item read in `eachMetadata` / `scanFlexiPages` / quick-action / list-view describes = "does not use the field" | see below |
| FC-3 | HIGH | `scanFlexiPages` returned `[]` when the page LIST failed | see below |
| FC-4 | HIGH | `incomplete` never checked (dependency index and every `sfQ` list) | see below |
| FC-5 | HIGH | `_snapshotFix` swallows a storage failure; the write proceeds while the dialog says a restore point is saved | OPEN |
| FC-6 | HIGH | `fixFlowSelective` (inspector "✂ Remove selected") deletes flow versions with no restore point; `purgeOldFlowVersions` swallows its failures and the row is marked ✅ Done | OPEN |
| FC-7 | HIGH | `_loadFlowVersionInfo` swallows its error → a Process Builder process is treated as a flow | OPEN |
| FC-8 | — | WorkflowRule / WorkflowFieldUpdate filtered by API name on a custom object | DISMISSED: checked by CLI on npc, both hold the API name for a packaged object |
| FC-9 | MED | `doDelete` says a metadata snapshot was saved even when the read before the delete failed | OPEN |
| FC-10 | MED | `_deleteFullName` falls back to the raw id after a failed lookup → "was not found in the org — it may be gone already" | OPEN |
| FC-11 | MED | flow fix: a failed re-read after the deploy reads as "no more mentions" | OPEN |
| FC-12 | MED | the full text scan can end green over an incomplete plan (`/sobjects` or folder listing failed) | OPEN |
| FC-13 | MED | a failed report-type batch dropped every report-type hit | see below |
| FC-14 | MED | list views / compact layouts / quick actions: a failed read = absent | see below |
| FC-15 | MED | duplicate-rule restore point gets `sortOrder` 1 when the COUNT fails | OPEN |
| FC-16 | MED | restoring a Flow / Layout restore point is not re-read; a restored flow is forced Active | OPEN |
| FC-17 | MED | the data verdict says SAFE on a 5,000-row sample | OPEN |
| FC-18 | MED | the deprecation banner says "It's safe to delete"; a failed FLS read leaves the label renamed with no undo banner | OPEN |
| FC-19..21 | LOW | green "read N of N reports" with failures; `_resolveErr` blame after a later empty answer; `_cmtUnread` not reset | OPEN |
| FC-o | — | `_rtScanned` dead; picker offers only `__c` (not `__pc`); "nobody can see it" for a field with no FieldPermissions rows; the inspector's "nothing uses the field here" can disagree with the scan | OPEN |

## Data Studio

| id | sev | finding | status |
|---|---|---|---|
| DS-1 | HIGH | sftk-merge.js ~338: a failed read of a copy's children → "skipped", and the copy is still deleted | OPEN |
| DS-2 | HIGH | studio-transfer.js ~1407: a failed source describe skips the value checks, the dry run "passed … including value-level checks" | OPEN |
| DS-3 | HIGH | studio-transfer.js ~1347: a failed sample skips the required-field null check, "all required fields present" | OPEN |
| DS-4 | HIGH | studio-transfer.js ~1467, 1259, 1564, 1578, 1670: warnings or silent skips never count as unchecked | OPEN |
| DS-5 | HIGH | studio-undo.js ~368: an IndexedDB read error marks the restore point expired for good | OPEN |
| DS-6..8 | MED | studio-transfer: false "all required fields present" / false required-field issues / "no match in target" record types after a failed read | OPEN |
| DS-9 | MED | studio-builder.js ~797 + studio-core `describe()` returns null on error: "object X does not exist here" | OPEN |
| DS-10 | MED | studio-builder-modals.js ~943: a failed file-drift check reads as in sync | OPEN |
| DS-11 | MED | studio-compare.js ~378: a failed source describe makes Org Compare key on Id (0% match shown as data) | OPEN |
| DS-12 | MED | studio-compare.js ~422: `incomplete` ignored | OPEN |
| DS-13 | MED | studio-valueedit.js ~39: one shared `readErr` overwritten by the second read; wrong org named | OPEN |
| DS-14 | MED | studio-valueedit.js ~68: a failed target describe = "has no record type named X" | OPEN |
| DS-15 | MED | studio-undo.js ~447: automation check ignores `incomplete` / no answer → "every category was checked" | OPEN |
| DS-16 | MED | studio-undo.js ~520: any HTTP 400 on the cascade probe waives that child object | OPEN |
| DS-17 | MED | studio-undo.js ~274: run-end clock labelled "server" after a partial failure | OPEN |
| DS-18 | MED | sftk-merge.js ~329/375: a failed verify read labels merged copies "left as they were" | OPEN |
| DS-19 | MED | match-key grading drops a side that failed to load ("Strong key 100/100" from one side) | OPEN |
| DS-20..25 | LOW | misleading "log in first" after a session-list error; clear-cache reports success over a store error; archive bar hidden on error; previewAll ignores a failed read; the "automation a dry run cannot test" line drops a failed category; green "Org Compare complete" with errored rows | OPEN |
| DS-o1 | HIGH? | sftk-merge.js ~275/262: 15- vs 18-char id compared as strings — the survivor could stay in the list of copies and be deleted | OPEN |
| DS-o2 | MED | ids from an imported profile put into SOQL with plain quotes (studio-transfer 1162, studio-builder 1749, studio-builder-modals 998/1041/1070, studio-valueedit 46) | OPEN |
| DS-o3 | LOW | `getOrgSession` keeps stale sessions when the fresh answer is empty; describe cache keyed by the raw URL; `matched` counts rows not distinct values (studio-transfer 1630) | OPEN |

## The popup tools and the background layer

| id | sev | finding | status |
|---|---|---|---|
| TK-1 | HIGH | lightning-pages.js ~2253: a failed describe → "Not assigned" (`_lpProbeFailed` set only in a catch that cannot fire) | OPEN |
| TK-2 | HIGH | background.js ~4797: a deploy poll timeout / mid-poll error answers "failed" while the job may still land (API versions, restore, org default, clone, flow access) | OPEN |
| TK-3 | HIGH | popup.js ~2873: a failed re-read after a flow-version DELETE = "the org still shows it" → no undo step, tries to switch a deleted version back on | OPEN |
| TK-4 | HIGH | user-copy.js ~657: none of the seven reads checks `.error` → "Source user has no permission sets", everything "can be copied" | OPEN |
| TK-5 | HIGH | flow-permissions.js ~270/689: a failed access chunk is dropped → ↩ Undo deletes grants the run did not create | OPEN |
| TK-6 | HIGH | dependency-map.js ~4165/4097: "low-risk to delete — nothing calls this" with no caveat when the map is partial | OPEN |
| TK-7 | HIGH | dependency-map.js ~1113: a live-read map is "safe" for delete however old it is | OPEN |
| TK-8 | HIGH | popup.js ~979: `incomplete` of the flow list ignored; delete not gated on a short list | OPEN |
| TK-9 | MED | popup.js ~2262: "✅ All Downloaded" after a swallowed backup failure | OPEN |
| TK-10/11 | MED | flow-permissions.js ~217/270: a failed read = "No active assignable flows found" / "No permission sets have flows enabled" | OPEN |
| TK-12 | MED | lightning-pages.js ~1409/2402: a failed Profile read = "profiles are not present in this org" | OPEN |
| TK-13 | MED | interviews list capped at 2000, one page, not flagged | OPEN |
| TK-14 | MED | "accepted, but the org still shows the old state" when the RE-READ failed (user-copy, lightning-pages) | OPEN |
| TK-15 | MED | lightning-pages.js ~2388: `RecordType WHERE SObjectType = '<01I id>'` for a custom object's page → no record types | OPEN |
| TK-16 | MED | lightning-pages.js ~2402: failed record-type read → empty picker | OPEN |
| TK-17 | MED | dependency-map.js ~3173/3209: `FlowDefinitionView.ApiName IN (ns__Name)` for a namespaced flow never matches → the switch is reported failed | OPEN |
| TK-18 | MED | popup.js ~2787: a failed read before a restore gives `beforeMax = 0` → any Draft counts as "the restore landed" | OPEN |
| TK-19 | MED | sftk-sweep.js ~172 (`sftkUnzip`) and sftk-mdapi.js ~153: a damaged zip / unbalanced element yields a partial result with no flag | OPEN |
| TK-o | LOW | flows keyed by MasterLabel collapse; "all flows appear standalone" on a cycle; COUNT() unavailable = coverage silently unchecked; hex entities not unescaped | OPEN |

Not audited: license-manager (cut from the public build), apex-debugger.js, studio-history rendering, the composite
write engine inside background.js.
