# QA for the first public release — every shipped feature, end to end

Started 2026-10-06 on branch `work/1.4.3-deploy-view` (HEAD 6147df2 when the first batch
ran). The user asked for "the biggest qa we ever did, we need to test every feature end to end".

**How it is run.** Against the PUBLIC build (`npm run pack` → `dist/store-staging`, the files
the store gets), through the headless harness, on the two trial orgs: `npc` = trailheads5
(source; the Toolkit fixtures live here) and `npc2` = trailheads4 (target). Driver:
`node scripts/dev/qa/run.mjs <batch>` (scripts/dev/qa/batches.mjs); one harness at a time;
every run's full log is kept under `dist/qa/<batch>/<name>.log`, a summary line per run in
`_summary.txt`. A run passes only when (a) its exit code is 0, (b) its log has no page
exception, no console error and no ❌/FAILED line, and (c) what it claims matches the org
(the scripts re-read the org or ask the Salesforce CLI; where a script does not, the CLI
check is noted here). Every write is undone (the tool's own Undo / rollback) or followed by
a fixture restore, so both orgs end as they began, apart from flow version numbers.

Legend: ✅ pass · ❌ defect found (then "fixed <commit>") · ⏭ not run / why · 🧑 hand-only
(cannot be scripted: a file-picker download, a real production org).

## Toolkit (the popup)

| Feature | Scenario | Run | Result |
|---|---|---|---|
| Home | open on one org, org label, tool cards; switch when two orgs are open | video `home` section + `smoke` | ✅ (walkthrough recording 2026-10-05; the public build boots: popup/studio/log viewer 1/1/1) |
| Flows | list grouped by name, versions, 🔗 subflow mark, search | `flows-backup-delete-restore` | ✅ 70 flows listed; search narrows; CLI agrees on the versions |
| Flows | ⬇ Backup of a version (file) | `flows-backup-delete-restore` | ✅ the download was caught through CDP (`Browser.setDownloadBehavior`): SF_Backup_2026-10-06_1flow.zip, 7,862 bytes, and it restored the flow |
| Flows | 🗑 Delete inactive versions: warning, backup offer, "I understand" box, re-read | `flows-backup-delete-restore` | ✅ permanent-delete box gates Go; Draft gone (CLI) |
| Flows | 📥 Restore a backup as a new Draft | `flows-backup-delete-restore` | ❌ said "0 restored, 1 failed" while the Draft existed → fixed (verify by developer name); re-run "✅ 1 Flow Restored", CLI agrees |
| Dependencies | tree, "what uses", 🧨 blast radius, 🔗 chain, export | `dependencies-readonly` | ✅ 250 nodes, blast radius, chain, two searches (1 and 35 hits, 177 managed named as unread), export row |
| Dependencies | ⏻ Flow switches OFF → typed OFF → re-read → Undo from History | `flow-switches-off-undo` | ✅ 3 OFF verified by re-read; Undo 3 steps verified; CLI agrees |
| Dependencies | ⏻ OFF then ON in one session (remembered versions) | `flow-switches-cycle` | ✅ OFF then ON restores v1 (remembered) |
| Dependencies | ⚙ API versions: pick, target, CHANGE, re-read, Undo | `api-versions-change-undo` | ✅ 3 flows → API 49 verified; Undo 4 steps; the in-place Draft is said to be unrestorable (known limitation) — the result now repeats it (fixed) |
| Debugger | pick user, Start Trace → re-check, logs list, open a log, Stop Trace | `debugger-trace-log-viewer` | ✅ TraceFlag seen by CLI; anonymous Apex log listed and opened with the probe line; viewer tab shows it; Stop → flag gone (CLI); History has both |
| Debugger | apex-log-viewer.html opens a log | `debugger-trace-log-viewer` | ✅ TraceFlag seen by CLI; anonymous Apex log listed and opened with the probe line; viewer tab shows it; Stop → flag gone (CLI); History has both |
| Lightning Pages | list, detail of a record page, assignments read | `lp-detail` | ✅ |
| Lightning Pages | org default set → re-read → remove | `lp-orgdefault-set-remove` | ✅ set → "1 assignment written and verified" → removed; first attempt found Desktop already set (fixture state) and said "Tick Desktop or Mobile" |
| Lightning Pages | app default | `lp-appdefault` | ✅ |
| Lightning Pages | app + record type + profile | `lp-artp` | ✅ |
| Lightning Pages | Deactivate (every assignment named) | `lp-deactivate` | ✅ both assignments named, removed |
| Lightning Pages | Clone (unassigned copy) | `lp-clone` | ✅ "created, not shown to anyone yet" |
| Lightning Pages | What a user sees | `lp-users` | ✅ |
| Lightning Pages | Who sees what? (org-wide audit) | `lp-whosees` | ✅ |
| Field Cleaner | scan of the fixture field: every surface listed, fixable vs needs a person | `fc-scan-only`, `fr-scan` | ✅ 4 dependencies, 4 auto-fixable; verdict wording fixed |
| Field Cleaner | 🔑 copy access → Undo | `fr-access-undo` | ✅ copied, verified; Undo verified |
| Field Cleaner | ⇄ Replace on the layout → Undo | `fr-layout-undo` | ✅ |
| Field Cleaner | ⇄ Replace on the Lightning page → Undo | `fr-page-undo` | ✅ |
| Field Cleaner | 📦 Stored values: compare only; fill → re-read → Undo | `fr-copy-compare`, `fr-copy-fill-undo` | ✅ compare: 3 same / 0 empty / 5 not copyable ("Closed" missing in the new field) said plainly; fill path re-run after clearing the new field |
| Field Cleaner | 📊 report sweep: the quoted cost | `fr-report-count` | ✅ cost quoted first |
| Field Cleaner | flow: ✂ Remove · flow keeps running (new active version) | `fr-flow-keep` | ✅ Flow 2: new active v8; on SFTK FC Test Flow Salesforce refuses (empty Assignment) → now refused before the dialog (fixed) |
| Field Cleaner | flow: 🗑 Delete versions · flow off | `fr-flow-off` | ✅ v18 Draft + v17 Active deleted, flow off |
| Field Cleaner | Everything at once: ⇄ Replace all | `fr-every-replace` | ✅ 4 dialogs, layout / 2 flows / page replaced, "Safe to delete" |
| Field Cleaner | 🕐 Deprecate first → Undo | `fc-deprecate-undo` | ✅ label renamed, 1 grant stripped, Slack set named as not editable; undo restored |
| Field Cleaner | 🗑 Delete Field after everything is cleared (+ fixture rebuild) | `fc-remove-all-delete-field` | ✅ (third round) Flow 2 → new active v16, layout, Flow 1 "keep" refused up front → "flow off", page; "Safe to delete"; the field deleted through the Metadata API (the Tooling API refused — said so), restorable ~15 days; fixture rebuilt and scanned again (4 dependencies) |
| Copy Permissions | plan, checkbox, copy → Salesforce's answer → Undo | `copy-perms-undo` | ✅ role set, verified; undo verified |
| Flow Access | grant to a permission set → reload → Undo | `flow-access-undo` | ✅ granted, verified; undo verified |

## Data Studio

| Feature | Scenario | Run | Result |
|---|---|---|---|
| Connected Orgs | list, rename label, forget | `connected-orgs` (new) | ✅ rename shown and reverted; 🔒 lock → a real Flow-switch write refused by the service worker ("Org is marked read-only"), CLI unchanged; 🛑 guard → typed org name asked, cancel wrote nothing |
| Connected Orgs | lock an org → a write to it is refused | `connected-orgs` (new) | ✅ rename shown and reverted; 🔒 lock → a real Flow-switch write refused by the service worker ("Org is marked read-only"), CLI unchanged; 🛑 guard → typed org name asked, cancel wrote nothing |
| Connected Orgs | guard as production → the typed org name is required | `connected-orgs` (new) | ✅ rename shown and reverted; 🔒 lock → a real Flow-switch write refused by the service worker ("Org is marked read-only"), CLI unchanged; 🛑 guard → typed org name asked, cancel wrote nothing |
| Data Deployment | builder: new from template / from scratch, edit, clone, delete, export, import | `builder` (new) | ✅ new (Account > Contacts via the relationship list) → card; rename; clone "Copy of"; export file has no session/scan/ids; delete; import; template; all cleaned up |
| Data Deployment | Deploy page: scan, buckets, nothing ticked, tree cards and counts | `deploy-tree`, `consistency` | ✅ tree and plan agree (Account 10 → 4: 7/1/2/0/2); consistency's ring part re-pointed to the new page |
| Data Deployment | ⚠ Needs a decision: answer one, forget, re-read | `needs-decision` | ✅ nothing written (CLI) |
| Data Deployment | parents first: grandchild ticked, parents added, linked | `parents-first` | ✅ 6 of 8 parents not aligned, journey to Individual |
| Data Deployment | run → failures → ↻ Retry failed → rollback | `retry-and-rollback` | ✅ 6 inserted 1 failed → Retry ticks 1 → rollback deletes 6 |
| Data Deployment | ⏸ pause record-triggered flows around a real run, back on at their versions | `flowpause-run-rollback` | ✅ 3 flows OFF before the write, back ON verified (CLI ON/ON/ON) |
| Data Deployment | validation rules paused around a real run | `vrpause-run-rollback` | ✅ 1 rule off, back on |
| Data Deployment | one-pass tree run and its rollback | `onepass-tree-rollback` | ✅ whole tree in one pass (CLI: 4/2/0/0 → 8/5/3/2), rollback verified per object, CLI back to 4/2/0/0; person-account contacts said to arrive with their account |
| Data Deployment | duplicate rules Respect / Bypass; Engine Bulk threshold | `engine-options` (new) | ✅ Bulk: one ingest job (CLI jobs/ingest), History now says via Bulk (fixed), rolled back · Duplicate rules: Respect refused the near-duplicate with the plain-words line + hint; Bypass against a BLOCK rule still refused — the run now says a Block rule cannot be passed (fixed), both runs rolled back, rule and twin removed |
| Data Deployment | 🪪 Identity field: which org has `SFTK_ID__c`, create it where missing, stamp matched pairs, re-scan matches by it (user 2026-10-06: also missing from the video) | `identity` (new) | ❌ "could not be re-read" after a successful deploy → fixed; re-run ✅ end to end incl. stamp (CLI) and undo |
| History | cards, filters, CSV/JSON export, report, counts-only, retention | `history` (new) | ✅ run-retry-rollback-history HISTORY=1: 2 cards, status filters agree with the entries, deployment filter, run export JSON+CSV and Export all JSON+CSV read back, counts-only strips ids 13 → 0, retention 30 → 7 stored; file name now carries the deployment (fixed) |
| History | 📋 Which records on a rollback without names → Recycle Bin | `rollback-report-bin` | ✅ Recycle Bin read: Account 812 of 812; Contact fewer than counted, said as ⚠ |
| History | Toolkit changes shown in the tool, Data Studio names them | `tool-history` (covered by every `*-undo` run) | ✅ every Toolkit undo ran from the tool's History; Data Studio › History showed the "N changes made with Toolkit tools" note and 0 tool cards |
| All open orgs | pick source, columns, scan a cell, open the Deploy page from it | `allorgs` (new) | ✅ source picked, column scanned, cells counted, ⚖ opened the Deploy page on the right pair with nothing ticked |
| Org Compare | two orgs, objects, strategies, CSV, Deploy from a row | `compare` (new) | ✅ Auto / External Id / typed field; every row's arithmetic consistent; 99.9% fix confirmed live; CSV read back; 🚀 Deploy opened the page |
| Org health | Check all, costs, cards, buttons into tools | `orghealth-ring` | ✅ 6 cards with their API cost, budget line, licences at the cap named |
| Cross-cutting | cut features absent from the public build (Debug, Pro, guidance, Licenses tab, Readiness, Picklists, Sequences) | `scope` (new, static on dist/store-staging) | ✅ release-smoke: SFTK_CUT exact, no Debug/Pro/guidance/Licenses/Readiness/Picklists/Sequences on either page, palette filtered |
| Cross-cutting | What's New, Licence dialog decline → no writes | `licence-gate` (new) | ✅ release-smoke: Decline blocks the page, read again → Accept, remembered on the other two pages |
| Cross-cutting | dark mode draws both pages | `smoke` DARK=1 (new) | ✅ release-smoke: both pages toggle dark and draw |

## Findings

Batches run on the public build (logs under `dist/qa/<batch>/`): `toolkit` (27 runs),
`toolkit2` (9), `toolkit3` (3, the delete of the field), `studio` (10), `studio2` (7),
`fix2` (3 re-runs after fixes). Every script failure was read: the ones below were defects,
the rest were the scripts themselves (listed at the end). All orgs end as they began.

### Defects found and fixed (commit of 2026-10-06, "QA round 1")
1. **Flows › 📥 Restore reported every successful restore as failed.** The verify query
   filtered Tooling `Flow` on `FullName`, which Tooling SOQL refuses; the page said
   "0 restored, 1 failed — could not be found on re-read" while the CLI showed the new
   Draft. Fixed: re-read by `Definition.DeveloperName`, a Draft newer than before is the
   proof (popup.js `sftkFlowRestoreVerify`, test flow-restore-verify-1006). Re-run: page
   "✅ 1 Flow Restored", CLI agrees.
2. **Field Cleaner › ✂ Remove · flow keeps running offered where it cannot work.** On
   SFTK FC Test Flow (the field is the only assignment line) the way was confirmed and
   Salesforce refused "Required field is missing: assignmentItems" — honest, nothing
   deleted, but a confirmation for nothing. Fixed: refused before the dialog from the
   preview's `emptied` list, with the ways that work (test fc-emptied-1006).
3. **Field Cleaner data verdict wording** "Empty on 99.9% of 8 of 10,266 records" →
   "Empty on 99.9% of 10,266 records (8 hold a value)" (test fc-verdict-1006).
4. **↩ Undo result omitted what was not restored** (API versions: the in-place Draft).
   The dialog said it; the result and the undo entry now carry an ℹ "Not restored" line
   (sftk-history.js, test in sftk-history.test.mjs).

5. **Org Compare said "100%" with records missing** (Account 10,075 matched / 7 missing
   → 100%; Contact 6 missing → 100%) — `Math.round`. Fixed: `sftkOcMatchPct` caps at 99.9
   while anything is missing (test oc-pct-1006). The two row buttons both read "Deploy";
   the saver is now "📦 Save as deployment".

6. **🪪 Identity › Create the field said "deploy failed — could not be re-read" after a
   successful deploy** (CLI: field + permission set present in both orgs). The verify was a
   data query the user cannot run before the permission set is assigned. Fixed: verify by
   `FieldDefinition` (no FLS), visibility probed after the assignment (test
   identity-verify-1006). Re-run: created in both, stamped 1 pair (CLI shows the source
   Id), re-scan, undo emptied it, cleanup removed the fields.
7. **History never said "via Bulk" for a Deploy-page run.** Engine = Bulk ran one ingest
   job (CLI `jobs/ingest`: Account insert, JobComplete) but the entry dropped `viaBulk`.
   Fixed in runReconcile (test deploy-viabulk-1006).

8. **Duplicate rules › Bypass claimed success against a Block rule.** Fixture rule
   `Account.SFTK_QA_Block` (Block on insert) + a near-duplicate: Respect refused Berlin Lab
   ("Use one of these records?"), History said "A duplicate rule in the target org flagged
   this record" with the Bypass hint ✅. Bypass → ↻ Retry: the run logged "records a rule
   would have flagged were written" yet the rule blocked them — the header only passes Alert
   rules. Fixed: the diagnostic says so; `[DUPLICATES_DETECTED]` is kept in a refusal whose
   text is the rule's own alert text; the friendly hint names the Block case (test
   dup-bypass-1006).
9. Per-run report file was named after the first summary object ("sftk-run-CaseComment-…")
   — now the deployment name (ent-audit-export pins updated).


### Hand-test findings by the user, 2026-10-07 (all fixed, pinned)
10. Licence page unreadable in dark mode (dark @media block before the light rules).
11. Lightning Pages "Finish the check" looked dead — a repeat run ended identically with no
    feedback; now says "Tried again just now (run N) — the same result" and names the
    objects that could not be described.
12. Field Cleaner: no group button for "Remove · flow keeps running" / "Delete versions ·
    flow off" — added; each flow still confirms on its own.
13. Field Cleaner History lines showed Salesforce ids for deleted versions and runs — now
    "Flow v17 (Active) deleted", "failed flow run “…” deleted".
14. Hard delete: that ↩ Roll back cannot restore hard-deleted records was said only after
    the fact — now next to the Delete mode (note + toast) and in the confirmation.
15. Dependencies rows: created/modified dates without the people — now "created … by …" /
    "modified … by …" as two aligned lines (Tooling `CreatedBy.Name`, `LastModifiedBy.Name`).
Open from the same session: the shared confirmation dialog and the ~50 hand-built modals are
to be redesigned (plan agreed in chat: headline sentence, facts row, severity-coloured stakes,
a real item table with search, pinned action bar, production as a band, 720px, dark tokens).

### Verified and honest (no change needed)
- Flow switches OFF/ON/undo, API versions change/undo, Lightning Pages (detail, org
  default set/remove, app default, app+RT+profile, deactivate, clone, what a user sees,
  who sees what), Field Cleaner scan / copy access / layout / page / stored values /
  report count / flow keep / flow off / Replace all / Deprecate+undo / Delete Field,
  Copy Permissions + undo, Flow Access + undo, Debugger trace→log→viewer→stop: each
  re-read the org and the CLI agreed with what the page said.
- Deprecate said plainly that the Slack Integration User permission set (Salesforce-
  managed) could not be stripped.

### Known limitation (not fixed for 1.0, said in the product)
- ⚙ API versions: a Draft rewritten in place cannot be undone — the tool reads the
  previous metadata and could keep it in the journal to deploy it back (1.0.1).

### Test-harness fixes made on the way (not product)
- `h.popup()/h.studio()` ticked EVERY checkbox on the page while accepting the licence
  (it also ticked the Flows tab's "whole tree" backup option). Now only `#sftkTermsCb`.
- Template-literal regexes in live scripts (`\s` → `s`) stripped letters from logs; the
  API-versions script's default target was the oldest option; the field-cleaner script
  pressed the same refused button again.
