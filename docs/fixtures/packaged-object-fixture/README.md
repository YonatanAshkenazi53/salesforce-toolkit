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
| `SFTK_Pkg_Screen` | screen flow | the 🖥 Screen flow group; reads the packaged object filtered by the field |
| `SFTK_Pkg_Access` | permission set | field access to both fields (👀) |

Deploy: `cd docs/fixtures/packaged-object-fixture && sf project deploy start -o npc --source-dir force-app --test-level NoTestRun`
(then `-o npc2` for the deployment proofs). Deployed to npc 2026-11-08.

Records for the Data Deployment proof (npc → npc2): a few `dlrs__LookupParent__c` with `dlrs__LookupChild__c` children,
some of them red with no tag, so the target's validation rule refuses them unless the panel pauses it — inserted in
npc BEFORE the rule is deployed there, by the live script.
