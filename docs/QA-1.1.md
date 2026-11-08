# QA — 1.1.0, every CHANGELOG bullet run live (2026-11-08)

The owner: "אני רוצה שתעשה הרבה qa ואיטרציות על כל הדברים שעשינו בשביל 1.1" and "ו-qa". One row per 1.1.0
bullet of `CHANGELOG.md`: what was run live (the headless harness, `node scripts/dev/headless-studio.mjs
<script>`, on the trial orgs npc → npc2), what was found, what was fixed. Light and dark shots were taken where a
screen changed; dark shots are taken with CSS transitions switched off (the headless page renders no frames between
shots, so a transition never ends — a white `.btn` in dark was the harness, not the product; see "Harness notes").
Nothing here ran against a production org.

## Data Studio

| 1.1 bullet | Run live (script, what it did) | Found | Fixed / state |
|---|---|---|---|
| 🎭 PII suggestions on the Deploy page, with the record each example comes from | `pii-deploy.mjs` (Leads fixture): 🎭 for all 2 to insert → 12 candidates, examples "in <record>"; Apply → 8 rules; ▸ record "written as"; 🎭 for this record; a REAL run + ↩ Roll back | ▸ record hashed the persona without the object's Name field (the run reads it): it promised "Emma Levi" while the run wrote "Peter Nguyen" | Fixed (▸ record reads the name field). Re-run: example = ▸ record = CLI (Lior Martin, lior.martin@falcon.invalid); 0 real values in the target; audit line clean; rollback verified (CLI 0 left) |
| The History export says what an update changed, field by field | `history-beforeafter.mjs`: the Changed Account overwritten, the run's JSON export read, the CLI before/after, ↩ Roll back | — | 4 fields exported with before/after, every line equal to the CLI; rollback restored them (CLI). The CSV export and the History card do not show the values (JSON only, as promised on Reddit) |
| Opening a deployment reads every object in it; 🔄 Rescan all; Refresh state | `deploy-scanall.mjs` (Accounts tree) | Before: Refresh re-read only the children read before; opening read nothing | Fixed: open → root + 11/11 children in 13 s; Rescan all 11/11; a changed key re-reads its own subtree only; Refresh 11/11 |
| The Matching kit everywhere on the Deploy page | `matching-kit.mjs`: Individual (parent) → suggestions graded → LastName used → re-read; Contact's card → composite Name + Title → saved → re-read | (1) the builder's window was waited for by its DOM, but closeModal only hides the overlay — the page never saw it close; (2) the builder's Save stores a COPY of the deployment and the page kept painting its own object (the card said the old key) | Both fixed; the card says "Name + Title", Contact read again with it. Composite for a parent OUTSIDE the deployment is shown disabled with the reason (the engine's lookup bridge matches one field) — open in BACKLOG |
| The Deploy page remembers your ticks | `deploy-ticks.mjs`: 3 root + 2 child ticks → Refresh → back to deployments and open → a fresh page → untick | Checked again after "read every object on open" (it re-scans on reopen): no tick lost | Passes: the ticks come back after every step; untick by hand empties the memory |
| ▸ record shows the values that are written (∅ marks, Record Type row, "not readable") | `value-edit.mjs` NOWRITE=1 (one record, many records), `ve-rt.mjs` (Record Type pick stored and cleared) | — | Pass. The "No such column" retry is still NOT live-tested (no field without access exists for this user in npc) — unchanged from 2026-11-07 |
| 🧪 Dry run | `dryrun.mjs` (every Insert + Changed row ticked, 🧪 Dry run, CLI counts before/after) | — | Pass: 24 would be written, the refused rows named, CLI counts equal before and after |
| 🎭 PII treatments in the deployment builder | covered by `pii-deploy.mjs` (the same window, the same engine) | The builder's previews now also name the record each example comes from (the same `bldPiiPreviewHtml`) | — |

## Toolkit (Field Cleaner and the flow tools)

| 1.1 bullet | Run live (script, what it did) | Found | Fixed / state |
|---|---|---|---|
| Field Cleaner's blocker list was put to the test | `fc-demo-scan.mjs` (26 🔒 / 9 👀), `field-cleaner-blockers.mjs`; a Lead and a Case scan through `fc-delete-live.mjs OBJ=Lead/Case` | (1) the custom metadata record (Entity = Account, Field = SFTK_Live_Blk__c) was listed as a blocker for Lead.SFTK_Live_Blk__c and Case.SFTK_Live_Blk__c — a bare field name matched any object; (2) a scan straight after many restore deploys read 21 🔒 / 7 👀 (the dependency index lags), the next one 26 / 9 | (1) Fixed: a bare name belongs to the object the record names (pinned). (2) Not a code bug — said here; re-scan |
| Every blocker can be deleted, with a way back | `fc-delete-live.mjs` pairs with UNDO=1 (WorkflowRule + FieldSet, WebLink + MatchingRule): ↩ Restore and History undo; Lead's assignment rule and Case's escalation rule 🗑 + ↩ Restore | 🗑 of an assignment / auto-response / escalation rule could not read its restore point ("UNKNOWN_EXCEPTION: unexpected metadata" — those three have no readMetadata of their own) | Fixed: read through the object's container; both deleted and restored live, the CLI shows them back |
| ✂ Remove and ⇄ Replace inside a blocker, with its XML on screen | `fc-edit-live.mjs` CLI=1 UNDO=1: ✂ on every kind (7 done, 5 refused with the reason), ⇄ on all 17 kinds, CLI retrieve old 0 / new 1, every edit undone through History | the confirm's item list squeezed the name to one letter per line; "Permanent" on an edit with a restore point; the done label said the new field twice; the details block sat in the flex row | All fixed in the same round; light + dark shots |
| ✎ Edit the XML and deploy it back | `fc-xml-editor.mjs`: malformed → Deploy off; a broken formula → Salesforce's words under the box; a real edit → CLI; History undo → CLI | DOMParser throws under the pages' Trusted Types ("requires TrustedHTML assignment") — the well-formed check failed silently; the last deploy's message stayed under a new edit | Fixed: a pure tag-balance check (`sftkMdWellFormed`); the message clears on input |
| Field Cleaner's "how much data is stored" line was audited | `fc-usage.mjs` | The script stopped at the second field: the field box still held the first field's name, so the drop list was filtered to nothing (the script's pick, not the page — a person clears the box) | Script fixed (clears the box). Five fields read: SFTK_Live_Blk__c 3 of 130 (CLI COUNT: 3), Active__c 10, SFTK_Dbg_Count__c 1, CustomerPriority__c 9, SLAExpirationDate__c 11 |
| Field Cleaner tells blockers from mentions, and scans either | `field-cleaner-scope.mjs` | — | Pass: 🔍 Everything → 🔒 7 (Flows 6, Lightning Pages 1) and 👀 2 (Layout, Report Type); the 👀 scope says "10 blockers hidden by the 👀 scope"; switching scope after a scan says "Scan again — this scope was not read"; the scope is remembered |
| A filter box on ⏻ Switches and ⚙ API versions | `flow-filter.mjs` | — | Pass on ⏻ Switches and ⚙ API versions (138 rows): by label, by API name, Enter ticks, ticked rows hidden by the filter are still counted and said so, clearing keeps the ticks; light + dark shots |
| Field Cleaner fixes custom report types | `field-cleaner-rt.mjs` REPLACE=1 UNDO=1 | — | Pass: ⇄ on "SFTK FC Test Accounts" verified by re-reading the org; ↩ Undo from the Toolkit's History, "Undone — 1 step verified by re-reading the org" |

## The regression set (handover), run before the commits of 2026-11-08

`npm run verify` (green at every commit: 3,711 → 3,739 tests), `field-cleaner-blockers.mjs`, `fc-delete-live.mjs`
on two kinds with UNDO=1 (WorkflowRule + FieldSet, WebLink + MatchingRule), `fc-demo-scan.mjs` 26 🔒 / 9 👀;
after the Deploy-page changes `value-edit.mjs` NOWRITE=1, `ve-rt.mjs`, `deploy-tree.mjs`, `dryrun.mjs`.

## Harness notes (so the next QA round does not trip on them)

- A second `headless-studio.mjs` started while one runs kills the first one's Chrome (it cleans stray
  `sftk-headless` processes at start): one run at a time. An undo loop was cut this way on 2026-11-08 and the
  demo fixture was rebuilt with the builders.
- `scripts/dev/live/demo/live-fix3.mjs` cannot run from the repo: its `live5/` source folder was never copied
  (BACKLOG). The permission set and the private report it builds are still in npc.
- `#sftkDarkToggle` cycles light → dark → OLED; for shots set `body.sftk-dark` (Toolkit) / `html.ds-dark` (Data
  Studio) directly, with `*{transition:none!important}` injected.
- A deployment now reads every object on open: a script that presses Scan right after `runProfile` races that read —
  wait until no card says "not counted yet".
