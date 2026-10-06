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
| Flows | list grouped by name, versions, 🔗 subflow mark, search | `flows-list` (new) | pending |
| Flows | ⬇ Backup of a version (file) | 🧑 download | pending — hand step |
| Flows | 🗑 Delete inactive versions: warning, backup offer, "I understand" box, re-read | `flows-delete` (new, fixture Draft) | pending |
| Flows | 📥 Restore a backup as a new Draft | `flows-restore` (new) | pending |
| Dependencies | tree, "what uses", 🧨 blast radius, 🔗 chain, export | `dependencies-readonly` | pending |
| Dependencies | ⏻ Flow switches OFF → typed OFF → re-read → Undo from History | `flow-switches-off-undo` | pending |
| Dependencies | ⏻ OFF then ON in one session (remembered versions) | `flow-switches-cycle` | pending |
| Dependencies | ⚙ API versions: pick, target, CHANGE, re-read, Undo | `api-versions-change-undo` | pending |
| Debugger | pick user, Start Trace → re-check, logs list, open a log, Stop Trace | `debugger` (new) | pending |
| Debugger | apex-log-viewer.html opens a log | `debugger` (new) | pending |
| Lightning Pages | list, detail of a record page, assignments read | `lp-detail` | pending |
| Lightning Pages | org default set → re-read → remove | `lp-orgdefault-remove` | pending |
| Lightning Pages | app default | `lp-appdefault` | pending |
| Lightning Pages | app + record type + profile | `lp-artp` | pending |
| Lightning Pages | Deactivate (every assignment named) | `lp-deactivate` | pending |
| Lightning Pages | Clone (unassigned copy) | `lp-clone` | pending |
| Lightning Pages | What a user sees | `lp-users` | pending |
| Lightning Pages | Who sees what? (org-wide audit) | `lp-whosees` | pending |
| Field Cleaner | scan of the fixture field: every surface listed, fixable vs needs a person | `fc-scan-only`, `fr-scan` | pending |
| Field Cleaner | 🔑 copy access → Undo | `fr-access-undo` | pending |
| Field Cleaner | ⇄ Replace on the layout → Undo | `fr-layout-undo` | pending |
| Field Cleaner | ⇄ Replace on the Lightning page → Undo | `fr-page-undo` | pending |
| Field Cleaner | 📦 Stored values: compare only; fill → re-read → Undo | `fr-copy-compare`, `fr-copy-fill-undo` | pending |
| Field Cleaner | 📊 report sweep: the quoted cost | `fr-report-count` | pending |
| Field Cleaner | flow: ✂ Remove · flow keeps running (new active version) | `fr-flow-keep` | pending |
| Field Cleaner | flow: 🗑 Delete versions · flow off | `fr-flow-off` | pending |
| Field Cleaner | Everything at once: ⇄ Replace all | `fr-every-replace` | pending |
| Field Cleaner | 🕐 Deprecate first → Undo | `fc-deprecate` (new) | pending |
| Field Cleaner | 🗑 Delete Field after everything is cleared (+ fixture rebuild) | `fc-delete-field` (new) | pending |
| Copy Permissions | plan, checkbox, copy → Salesforce's answer → Undo | `copy-perms-undo` | pending |
| Flow Access | grant to a permission set → reload → Undo | `flow-access-undo` | pending |

## Data Studio

| Feature | Scenario | Run | Result |
|---|---|---|---|
| Connected Orgs | list, rename label, forget | `connected-orgs` (new) | pending |
| Connected Orgs | lock an org → a write to it is refused | `connected-orgs` (new) | pending |
| Connected Orgs | guard as production → the typed org name is required | `connected-orgs` (new) | pending |
| Data Deployment | builder: new from template / from scratch, edit, clone, delete, export, import | `builder` (new) | pending |
| Data Deployment | Deploy page: scan, buckets, nothing ticked, tree cards and counts | `deploy-tree`, `consistency` | pending |
| Data Deployment | ⚠ Needs a decision: answer one, forget, re-read | `needs-decision` | pending |
| Data Deployment | parents first: grandchild ticked, parents added, linked | `parents-first` | pending |
| Data Deployment | run → failures → ↻ Retry failed → rollback | `retry-and-rollback` | pending |
| Data Deployment | ⏸ pause record-triggered flows around a real run, back on at their versions | `flowpause-run-rollback` | pending |
| Data Deployment | validation rules paused around a real run | `vrpause-run-rollback` | pending |
| Data Deployment | one-pass tree run and its rollback | `onepass-tree-rollback` | pending |
| Data Deployment | duplicate rules Respect / Bypass; Engine Bulk threshold | `engine-options` (new) | pending |
| Data Deployment | 🪪 Identity field: which org has `SFTK_ID__c`, create it where missing, stamp matched pairs, re-scan matches by it (user 2026-10-06: also missing from the video) | `identity` (new) | pending |
| History | cards, filters, CSV/JSON export, report, counts-only, retention | `history` (new) | pending |
| History | 📋 Which records on a rollback without names → Recycle Bin | `rollback-report-bin` | pending |
| History | Toolkit changes shown in the tool, Data Studio names them | `tool-history` (covered by every `*-undo` run) | pending |
| All open orgs | pick source, columns, scan a cell, open the Deploy page from it | `allorgs` (new) | pending |
| Org Compare | two orgs, objects, strategies, CSV, Deploy from a row | `compare` (new) | pending |
| Org health | Check all, costs, cards, buttons into tools | `orghealth-ring` | pending |
| Cross-cutting | cut features absent from the public build (Debug, Pro, guidance, Licenses tab, Readiness, Picklists, Sequences) | `scope` (new, static on dist/store-staging) | pending |
| Cross-cutting | What's New, Licence dialog decline → no writes | `licence-gate` (new) | pending |
| Cross-cutting | dark mode draws both pages | `smoke` DARK=1 (new) | pending |

## Findings

Batches run so far on the public build: `toolkit` (27 runs, all exit 0), `toolkit2`
(9 runs; two script failures fixed and re-run). Logs under `dist/qa/`.

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
