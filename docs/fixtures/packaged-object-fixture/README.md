# Packaged-object fixture (2026-11-08)

The owner (2026-11-08): "צריך ליצור אובייקט חבילתי או פלואו מהסוגים האלו על אובייקט חבילתי ולבדוק" and "כל הטולקיט
שלנו צריך להתחשב ולהציג גם מטאדאטה על אובייקטים חבילתיים".

The managed package is **Declarative Lookup Rollup Summaries Tool (DLRS) 2.25**, namespace `dlrs`, installed by the
owner in npc and npc2 (the CLI's package install is refused by the session's permission classifier). It ships two
test objects with a lookup between them — `dlrs__LookupParent__c` and `dlrs__LookupChild__c` — createable, updateable,
triggerable. (`dlrs__LookupRollupSummary2` is custom metadata, not an object.)

What this folder deploys on top of them:

| component | kind | why |
|---|---|---|
| `dlrs__LookupChild__c.SFTK_Pkg_Tag__c` | Text field on the packaged object | the field Field Cleaner scans and deletes |
| `dlrs__LookupChild__c.SFTK_Pkg_Tag2__c` | Text field | the replacement for ⇄ |
| `SFTK_Pkg_Red_Needs_Tag` | validation rule on the packaged object | names the field (🔒); blocks a red child without a tag — the deploy fixture's records — unless the ⏸ panel pauses it |
| `SFTK_Pkg_Child_Trigger` | record-triggered flow (after save) on the packaged object | ⏻ Switches under the packaged object; reads the field in a decision (Field Cleaner rewrites it); calls the subflow |
| `SFTK_Pkg_Sub` | autolaunched subflow | "↰ called by 2"; a Get Records with two filters, one the field |
| `SFTK_Pkg_Auto` | autolaunched, no trigger | calls the subflow ("↳ calls 1") |
| `SFTK_Pkg_Parent_Sched` | scheduled flow on `dlrs__LookupParent__c` | the ⏰ Scheduled group on a packaged object |
| `SFTK_Pkg_Screen` | screen flow | the 🖥 Screen flow group; reads the packaged object filtered by the field; calls the child screen flow |
| `SFTK_Pkg_Screen_Child` → `SFTK_Pkg_Screen_Leaf` | child screen flow, then an autolaunched leaf | a three-level SCREEN tree (user 2026-11-08: "screen flow with child screen flow") |
| `SFTK_Pkg_Parent_Trigger` | record-triggered (after save, on create) on `dlrs__LookupParent__c` with a SCHEDULED PATH an hour later | "record triggered with subflows … with a scheduled path": the immediate path calls `SFTK_Pkg_Path_Now_Sub`, the scheduled path `SFTK_Pkg_Path_Later_Sub` → `SFTK_Pkg_Path_Deep_Sub` |
| `SFTK_Pkg_Sched_Sub` | autolaunched subflow of the scheduled flow | the ⏰ Scheduled tree |
| `SFTK_Pkg_Access` | permission set | field access to both fields (👀) |

Deploy: `cd docs/fixtures/packaged-object-fixture && sf project deploy start -o npc --source-dir force-app --test-level NoTestRun`
(then `-o npc2` for the deployment proofs). Deployed to npc 2026-11-08.

Records for the Data Deployment proof (npc → npc2): a few `dlrs__LookupParent__c` with `dlrs__LookupChild__c` children,
some of them red with no tag, so the target's validation rule refuses them unless the panel pauses it — inserted in
npc BEFORE the rule is deployed there, by the live script.

2026-11-10: `matchingRules/dlrs__LookupParent__c` (SFTK_Pkg_Parent_Name, exact Name) and `duplicateRules/dlrs__LookupParent__c.SFTK_Pkg_Parent_Dupes` (Allow + Alert, never blocks) — a duplicate rule on a packaged object for the Deploy page's ⏸ panel. Deployed to npc and npc2.


## fc-app — Field Cleaner on a packaged object (2026-11-10)

A second package directory. Org-built metadata on `dlrs__LookupChild__c` that uses `SFTK_Pkg_Tag__c`: a formula field, a list view, a field set, a compact layout, a page layout, a workflow rule (inactive) and a field update, a matching rule (inactive) and a report type. With the validation rule and the three flows of `force-app` the field has 13 places.

```bash
sf project deploy start -o npc -d fc-app
```

Redeploy after a Field Cleaner write test to put the references back.
