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
16. All open orgs had a scan button per target column and one per cell (user 2026-10-08:
    "why do we need two scan buttons?") — now ONE Scan for the page, every deployment
    against every open org, progress on the button; cells keep ⚖ only.
17. No way to pause a long deployment and continue later; closing the tab mid-run neither
    asked nor said what happened (user 2026-10-09). Now: ⏸ Pause on the live run view
    (stops between batches, never mid-write), History chip "⏸ paused" + ▶ Continue (re-ticks
    the records not reached; written ones left alone), a beforeunload prompt while a run is on,
    and a page that closed stops the engine after the batch in flight — the next Data Studio
    page says it once (`sftk_run_interrupted`), a re-scan lists the rest.
    Live (`scripts/dev/live/pause-continue.mjs`, batch size 1): pause after 1 of 7 → History
    ⏸ paused, Continue ticked 6, the rest landed, both runs rolled back, CLI agrees at every
    step. `STEP=closed`: the browser asked (beforeunload), the engine stopped (CLI count
    frozen 8 s later), the reopened page showed the notice once, re-scan listed the rest.
18. `sftkConfirmDestructive` threw "Cannot access 'C' before initialization" for any list of
    more than eight items (the filter box used the class map before its `const`): the rollback
    of a 29-record run never showed its confirmation (walkthrough recording, 2026-10-10). The
    declaration moved above the list; `test/confirm-many-items-1010.test.mjs` pins the order for
    both dialogs. Earlier live rollbacks passed only because they had eight items or fewer.
19. The Deploy page's footer said "The real, rolled-back dry run is the next step of this page
    and is not built yet" — a roadmap note from the mock-up days, shipped to users (seen in a
    video frame, 2026-10-10). Removed; the plan stays in docs. The test that pinned the sentence
    now pins its absence.
20. Field Cleaner: the per-group "… all N" buttons were removed when a walk started and never
    came back, so after a cancelled walk three open flows had no group button (walkthrough
    recording, 2026-10-10). Disabled for the walk, redrawn afterwards for what is still open;
    `test/fc-group-walk-1010.test.mjs`.
Done the same evening: `sftkConfirmDestructive` redesigned (34 callers inherit it) and a shared
`sftkDialog` for the rest; 22 hand-built dialogs migrated (popup: the Flows gates, backups,
restores, delete results; Data Studio: rename / remove org, swap orgs, clear cached / clear
history, run report, export all, pick the target, delete a deployment, the production step).
The content-heavy panels (lookups, match review, identity, field mapping, pick / filter
records, schema check, PII masks, record detail) keep their own layouts for now.

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

## Pre-ship QA, 2026-10-31 (HEAD 7fcaedf + this round) — the packed build on the new orgs

The source trial expired on 2026-10-28; `npc` is now the Developer Edition
orgfarm-c449e108c2-dev-ed (never expires), `npc2` stays orgfarm-e2c4511b2b-dev-ed. Every
fixture was rebuilt on the new source (`docs/fixtures/rebuild-source.sh`), the flow-pause flows
deployed to the target, and every live script run against `dist/store-staging` through the
headless harness (`%TEMP%\sftk-qa*/`), one at a time, in three rounds. All 23 pass.

| Script | Covers | Result |
|---|---|---|
| flows-one-page | Flows page views, whole-flow delete with restore points, ↩ Undo brings the versions back (CLI) | ✅ |
| flow-switches MODE=cycle | three fixture flows OFF then ON, the typed word, CLI | ✅ |
| api-versions | three fixture flows moved to the org's API version, verified | ✅ |
| field-cleaner ONLY_FLOW=1 UNDO=1 | the flow fix (keeps running) and its new ↩ Undo from the tool's History: the version that used the field back and active (CLI) | ✅ |
| lightning-pages | org default set, assignment removed, CLI between steps | ✅ |
| copy-perms | A's permission set + group copied to B, read back | ✅ |
| flow-access | flow granted to a permission set, CLI | ✅ |
| debugger | trace on, a log made by the CLI, viewer tab, trace off (CLI) | ✅ |
| connected-orgs | rename, 🔒 Lock writes refuses a real write (CLI shows the flows untouched), guard as production gate | ✅ |
| builder | new deployment, edit, clone, export (no session / ids in the file), delete | ✅ |
| value-edit | ▸ record: a typed Description deployed, read back by the CLI, rolled back | ✅ |
| merge-both | 🔀 Merge both sides on the fixture pair (the redrawn picker), the pair put back | ✅ |
| vrpause / flowpause | validation rules / record-triggered flows paused for a run, back on after, rolled back | ✅ |
| identity | 🪪 field created in both orgs, stamped, re-scan still matched, undo emptied, cleaned up | ✅ |
| run-accounts-tree | the whole Accounts tree deployed, every child linked; target reset after | ✅ |
| allorgs-compare / orghealth | ring scan cells, Org Compare counts, Org health cards | ✅ |
| activity-look / edit-one-look / parents-loading-look / needs-decision-look / pii-cut-look | the 2026-10-27…31 screens on the packed build, light and dark; no PII surface in the public build | ✅ |

**Defects in the product: none.** Fourteen first-round failures were all in the harness side:
scripts still naming trailheads5/trailheads4, the Dependencies tab (a view of the Flows page
since 2026-10-17), the History sidebar row (gone 2026-10-28), the merge dialog's columns
(rows since 2026-10-30), a duplicate view click that cancelled the API-versions compare;
fixtures not yet on the new orgs (flow-pause flows in the target, `cleanup.apex` assuming
person accounts, a stale identity field on Opportunity in the target, an expired Trailhead
TraceFlag the debugger check counted as ours). All fixed in the scripts and fixtures; both
orgs end as they began (target 4 fixture Accounts, source 8).

Not scripted: a clean install by hand (the harness starts every run from an empty profile
with the packed build, which covers the gate and first open), an expired-session path, the
store assets (listing text and README now say Activity; screenshots still to be retaken).

### The rest (same day): install from the zip, an expired session, the store screenshots, UI bugs

- **Install from the zip.** `dist/salesforce-toolkit-v1.0.0-store.zip` unzipped and loaded as-is in a fresh profile: both pages boot, the licence gate shows once, no console error, version 1.0.0, the cut tabs and buttons absent. ✅
- **Expired session** (`scripts/dev/live/session-expired.mjs`: the source org's cookie replaced by garbage, the page reloaded). The Toolkit silently works on the other open org. Data Studio's scan toast read `source query failed: SESSION_EXPIRED` → ❌ fixed: it names the org and says to sign in again and refresh (test/session-toast-1031). The parents card on a dead session: checked in the same script after the fix.
- **Store screenshots** (`scripts/dev/live/screenshots.mjs`): every screen in both themes plus Activity in both pages, into `dist/store-shots/`. The first run showed light rows on dark pages — the capture caught rows mid-transition; the script now switches transitions off before each shot. Org Compare picks the new orgs.
- **UI review of the frames** led to: the pairing dialog redrawn (Match review), the per-copy question folded behind the merge, the Flows page drawn tighter with "+ subflows", the bulk-edit button renamed with its count, plain words for an expired session and a refused merge. All in CHANGELOG 1.0.0.
