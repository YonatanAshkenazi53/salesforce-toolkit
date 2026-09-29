# HANDOVER — Admin Toolkit for Salesforce

Written 2026-09-12 at the end of a long multi-day session. Everything below is
UNCOMMITTED in git (last commit: `07cd84a Org Seeder: seed without deleting…`).
Gate at handover: `npm run verify` → 68 files, **2240 tests passing**.
Store zip packed: `dist/salesforce-toolkit-v1.4.3-store.zip` (manifest 1.4.3).
Store currently has **1.4.2** — 1.4.3 has NOT been uploaded yet.

> **UPDATE 2026-09-12, second session (see §3a):** every §3 finding is FIXED,
> the two cut-off reviews were re-run and their 16 findings FIXED, 🔀 Cross-org
> diff was REMOVED at the user's request. Gate now `npm run verify` → 70 files,
> **2295 tests passing**; zip re-packed (60 files, 1023 KB); headless boot smoke
> 1/1/1. Still UNCOMMITTED (last commit still `07cd84a`).

---

> **RESUME HERE (2026-09-22, live test campaign in progress).** Read
> `docs/fixtures/complex-deployment/README.md` first — it is the runbook and the
> findings log. State: 1.5.0 built and gated (92 files / 2568 tests), NOT
> uploaded, NOT released. Branch `work/1.4.3-deploy-view`; everything committed
> at the end of each round (see git log). The user's standing order: "test every
> feature of the data deployment in the open orgs … huge trees … see if records
> really drift, if we catch all the data and advise the user what to do … vanilla
> Salesforce scenarios like person accounts" — BEFORE releasing to the public.
> - Harness: `node scripts/dev/headless-studio.mjs scripts/dev/live/<script>.mjs`
>   (fresh profile per run; both orgs via CLI frontdoor; see README). Orgs:
>   `npc` = trailheads2 (source), `npc2` = trailheads4 (target), both in the CLI.
> - Fixture seeded on trailheads2. Target reset = cleanup.apex + seed-target.apex
>   on npc2 (validation rules already deployed there).
> - DONE this campaign: engine late-link pass (self/in-tree lookups connected
>   after insert, proven live: Berlin Lab → Europe → Holding), child dupKeys +
>   warning, Field Mapping org list, Deploy offline banner, builder CSS collision.
> - DONE 2026-09-22 late: no-Name objects (path keys + describe fallback), default
> match-by-Name for unconfigured out-of-tree lookups (createable only; broken
> bridge = note), one run LEDGER across Deploy steps (runId → SF_RUN_LEDGER_CLOSE).
> Live run 8: 12-object tree deployed; hierarchy, case parents, pricebook, task
> who/what all correct in trailheads4. Gate 94 / 2580.
> - DONE round 3 (2026-09-22): two-pass live runs work (PASSES=2); line items
> deploy (TotalPrice rule); autonumber-named objects no longer double; contact
> roles / comments / line items deploy under existing parents. Gate 94 / 2582.
> - DONE round 4: group-B children attach by the scan's parent pairing (OrderItem fixed).
> - DONE round 5: the four other deployments ran live; PricebookEntry re-key.
> - DONE round 6: Deploy UX (scan all, refresh re-reads children, run log kept), whole-list ✓ All,
> duplicate-rules Respect/Bypass. Volume fixture seeded (24,000 rows on trailheads2).
> - DONE round 7: Bulk result correlation by value; bypass ⇒ Collections; in-tree lookup rows.
> - DONE: huge tree verified live (vol3: 6,000/6,000/10,250 after two passes, all linked).
> - DONE: Retry failed, parents-first journey, rollback all verified live (rollback fixes:
> restricted child objects don't block; 'delete anyway' choice; person contacts skipped).
> - DONE: rollback8 clean. **LIVE CAMPAIGN COMPLETE.** Gate 96 files / 2601 tests, zip packed.
> - **CAMPAIGN 2 (write-capable tools) started 2026-09-22 — Field Cleaner DONE, ⚙ API versions DONE, ⏻ Flow switches DONE, Dependencies + flow delete DONE, Picklist Manager single-org + compare mode DONE, Field Cleaner Deprecate/Undo DONE, Org Compare + Sync Ring consistency DONE, Sequences gated** (`docs/fixtures/complex-deployment/README.md` § Campaign 2; scripts `consistency.mjs`, `bucket-dump.mjs`, `sequences.mjs`; fixes: no learned pairs on dupKeys (scan-learn-dupkeys-0923), sequence run confirmation + typed prod gate (sequence-confirm-0923)) (findings in `docs/fixtures/field-cleaner-fixture/README.md`; scripts `scripts/dev/live/picklists.mjs`, `picklists-compare.mjs` MODE=matrix|sync|bulk, `field-cleaner.mjs` DEPRECATE=1; pins picklists-live-0923, fc-deprecate-live-0923) (findings in `docs/fixtures/field-cleaner-fixture/README.md` § Picklist Manager; script `scripts/dev/live/picklists.mjs`; `sftkMetaForPatch` in sftk-zip.js strips nulls before EVERY Metadata PATCH — Salesforce refuses nulls; the API cannot delete a picklist value — re-read + honest toast; pins meta-for-patch-0923, picklists-live-0923) (`docs/fixtures/dep-test-flows/README.md`, script `scripts/dev/live/dependencies.mjs` DELETE=1 CHOICE=cancel|ignore|parents; parents-first + retry + re-activate on refusal, pins flow-delete-live-0923) (`docs/fixtures/flowswitch-fixture/README.md`, script `scripts/dev/live/flow-switches.mjs` MODE=off|on|cycle; switch now verified by re-reading FlowDefinitionView, pins flowswitch-live-0922) (fixture + findings: `docs/fixtures/apiver-fixture/README.md`, script `scripts/dev/live/api-versions.mjs`, pins apiver-live-0922; Draft rewritten in place now verified; summary counts fixed). Field Cleaner runbook +
> findings: `docs/fixtures/field-cleaner-fixture/README.md` (rebuild.sh, live script
> `scripts/dev/live/field-cleaner.mjs`, env SCAN_ONLY / ACTIVE / DELETE_FIELD). Four fixes,
> all pinned (fc-flow-refusal-0922, fc-interviews-0922, fc-field-delete-0922): flow-fix dialog
> no longer preselects a replace that leaves elements empty; FlowInterview lookup by 15-char id
> (refused versions are NOT marked done any more); 🗑 Delete Field falls back to a Metadata API
> destructiveChanges deploy (Tooling DELETE of CustomField is refused in BOTH orgs — even a fresh
> field nothing references); the "Field deleted" card is no longer wiped. Verified end to end
> by CLI. Fixture rebuilt on trailheads2, ready. Harness gained `h.popup(tab)`.
> - **CAMPAIGN 2 COMPLETE (2026-09-23)** — every tool in the proposal was run live and verified by CLI: Field Cleaner (flow fix, interviews, field delete via Metadata API, Deprecate/Undo), ⚙ API versions, ⏻ Flow switches, Dependencies + flow delete, Picklist Manager (single + compare + sync + bulk), Org Compare, Sync Ring, Sequences (run + rollback). 20 fixes, all pinned. Last live commit `c95bcbe` + the History sequence chip. Gate 108 files / ~2666 tests.
> - **Popup write tools DONE (2026-09-23):** Copy Permissions (confirmation added), Licenses (hint added), Flow Access, Lightning Pages — all verified by CLI; fixture + findings in `docs/fixtures/popup-tools/README.md` (test users sftk.test.a/b, group, LP page fixture). Field Cleaner pass 2 DONE (`flow2/`, "Keep the flow running" verified). Lightning Pages: "Unknown" for an unassigned page → "Not assigned" (user's ask; FlexiPage has no PublishStatus in Salesforce; pins lp-unassigned-0923). E2E runbook for a hand-driven deployment: `docs/fixtures/complex-deployment/E2E-RUNBOOK.md` (expected 7 · 2 · 2 on Account).
> - NOT exercised: standard/global value sets; the typed production gates end to end (needs 🛑 Guard as production — set `_settings` in the harness and TYPE_IT=1); Licenses Change License; Lightning Pages app/profile assignments, clone, deactivate.
> - Org state: trailheads2 fixtures rebuilt (FC field all-active, dep chain, AV flows at 65, FS flows on); trailheads4 re-seeded (4 CX accounts, catalogue), plus 24,000 SFTK VOL rows still there (`cleanup-volume.apex`); Deleted Fields hold several `SFTK_FC_Test_Status_del*` twins (15-day purge).
> - **2026-09-26 later: new source = trailheads5 (`npc`, yonash53_bgxtpune@gmail.com), rebuilt by rebuild-source.sh; live scripts re-pointed (trailheads2 → trailheads5). CLI login tip: `sf org login web --browser edge` when Chrome's default profile is the work account; a stopped login leaves node.exe holding port 1717 — kill it first.**
> - 2026-09-26: trailheads2 (alias `npc`, the SOURCE) EXPIRED — CLI refresh fails. trailheads4 (`npc2`, target) still answers. Every source fixture is scripted: after `sf org login web --alias npc` on a new trial, `bash docs/fixtures/rebuild-source.sh npc` rebuilds all of it (CX data, Field Cleaner + flow2, apiver, flowswitch, dep chain, Lightning page, test users + group); the volume tree is optional. The harness now re-points imported deployments to the logged-in orgs (first login = source), so profiles.json need not be edited; the live scripts that match org LABELS by name (consistency, picklists, picklists-compare, sequences, copy-perms/field-cleaner/flow-access only log in) still say `trailheads2` — grep and replace once the new org's name is known.
> - NEXT: the user decides on the 1.5.0 release (CHANGELOG 1.5.0 = store notes; zip in dist/). The 🪪 chips question (A/B/C) is still open.
> - **RELEASE DECISIONS (user, 2026-09-26):** the public launch is a NEW Chrome Web Store listing starting at **1.0.0** (a new extension id; the 1.4.2 listing is not updated — the store refuses a lower version on the same listing; users install fresh, their old storage stays with the old id). NO release notes / What's New history in the public build: the in-app page and the store text describe **what every feature does**, Toolkit tabs and Data Studio views alike — `docs/FEATURES.md` is the source (being drafted), `studio-whatsnew.js` must render it instead of CHANGELOG.md at launch. CHANGELOG stays in the repo for us. The new listing keeps the name **Admin Toolkit for Salesforce** (user, 2026-09-26).
> - **Deploy option (2026-09-29, user request):** ⏸ pause record-triggered flows during a run — `sftk-flowpause.js` (list / off / on, memory `sftk_flow_run_paused`), `runReconcile(…, opts)` hooks `flowPause` (in the one confirmation) / `beforeWrites` / `afterWrites`, Deploy page checkbox + leftover banner, Org health counts leftovers. Live `scripts/dev/live/flowpause.mjs`.
> - **Backlog item DONE (2026-09-29):** Copy Permissions copies the role (preview, confirmation, verified write, History undo). Fixture: `SFTK Test Role` on SFTK Test A.
> - **CAMPAIGN 3 PHASE 8 DONE (2026-09-29):** Data Studio → Org health (`studio-orghealth.js`, seven cards, budget-first, answers in `sftk_orghealth`); live script `scripts/dev/live/orghealth.mjs RING=1`. **Phase 7 (nightly runs) SKIPPED by the user (2026-09-29)** — campaign 3 is complete. Backlog: Copy Permissions role copy.
> - **CAMPAIGN 3 PHASE 6 DONE (2026-09-29):** the picklist automation check reads every own active flow (no FLOW_CAP; one listing with ActiveVersionId; Metadata 25 per Tooling composite/batch); installed-package flows counted and said. Live script `scripts/dev/live/picklists-fullscan.mjs`. Next: phase 7 (nightly live runs — needs the user's org decision).
> - **CAMPAIGN 3 PHASE 5 DONE (2026-09-29):** ⚠ Ambiguous bucket — `sftkScanKeyClasses` (sftk-matching.js) decides per key; "insert as new" = match-memory value `SFTK_MEM_NEW`; Deploy tab + plan column + ring ⚠N. Fixture root now reads 7 · 1 · 2 · ⚠2 (runbook updated). Live script `scripts/dev/live/ambiguous.mjs`. Next: phase 6 (complete safety scans).
> - **CAMPAIGN 3 PHASE 4 DONE (2026-09-29):** whole record tree in one run — `sftkRecOnePassPlan` + `sftkRecPruneTree` in studio-reconcile.js drive both engine calls; grandchildren selectable at any depth; failed-parent children named. Live script `scripts/dev/live/onepass-tree.mjs` (run + in-session CLI + rollback). Backlog: Copy Permissions role copy (PLAN § Backlog). Next: phase 5 (ambiguous keys as a bucket).
> - **CAMPAIGN 3 PHASE 3 DONE (2026-09-27):** History with undo for every tool write — `sftk-history.js` (journal + undo steps as data + `sftkHistoryUndo`), tool cards on the History page, `test/history-discipline.test.mjs` baseline zero; live scripts take `UNDO=1` (`scripts/dev/live/_undo.mjs` drives History › ↩ Undo). Next: phase 4 (whole-tree deployment in one pass).
> - **CAMPAIGN 3 PHASE 2 DONE (2026-09-27):** one confirmation (`sftk-confirm.js`) in both pages with the typed production step; `sftkOrgWriteGate` fails closed; `test/confirm-discipline.test.mjs` baseline zero; live scripts drive `#sftkConfirmAck/#sftkConfirmGo/#sftkConfirmWord/#sftkConfirmProd/#sftkConfirmProdGo`; `GUARD=1 TYPE_IT=1` in sequences.mjs exercises the typed step. Next: phase 3 (History + undo for every write).
> - **CAMPAIGN 3 PHASE 1 DONE (2026-09-27):** the one write discipline. `sftk-write.js` in both pages; `test/write-discipline.test.mjs` scans every UI file for write message types and fails any not inside a `write:` arm or marked `// verified-by:` (BASELINE {} = zero offenders). The engine re-reads written ids after every run (`summary[obj].verified`), History chips show ✓ / ⚠found/checked. Live: every tool re-run on trailheads5 (batch logs under %LOCALAPPDATA%/Temp/live-batch-*/summary.txt). Next: phase 2 (one confirmation + typed prod gate in both pages), then phase 3 (History + undo for every write).
> - **Campaign 3 plan:** `docs/PLAN-campaign-3.md` — 8 phases (write discipline, one confirmation, History+undo for every write, one-pass trees, ambiguous bucket, complete scans, nightly live runs, org health). Model split per phase is in the plan's last section. (was: Dependencies
> (fixture `SFTK_Dep_Test_*`), Picklist Manager (typed prod gates), Sync Ring + Org Compare
> consistency, Sequences. Then the user decides on the 1.5.0 release.
> - NEXT: the user decides on release (upload dist/salesforce-toolkit-v1.5.0-store.zip;
> CHANGELOG 1.5.0 section = store notes); 🪪 chips question still open. (old: read retry-rollback.log; run
> scripts/dev/live/retry-and-rollback.mjs (Retry failed + ↩ Roll back live);
> then (3) Retry failed, rollback, parents-first; then UX; then release. (Campaigns /
> Products / Leads / Price books deployments; (3) parents-first flow, Retry failed,
> rollback; (4) huge trees (Apex loops, thousands of records, >5,000 per list);
> (5) UX: scan-all-children, Refresh re-scans children, run log survives the
> repaint, builder shows in-tree lookups as info rows; (6) release.
> - Open UI question for the user: 🪪 chips — A (target only) / B (both, only when
>   missing) / C. Unanswered.

> **UPDATE 2026-09-21 — RELEASE 1.5.0 PREPARED (user: "i want to use the new view
> on it … and only the new view").** manifest 1.5.0, zip
> `dist/salesforce-toolkit-v1.5.0-store.zip` (63 files), gate 86 files /
> **2541 tests**, boot smoke 1/1/1, page rendered once with
> `scripts/dev/deploy-preview.mjs`. Store still has 1.4.2 (1.4.3 was never
> uploaded; its notes sit under 1.5.0 in CHANGELOG). Last commit `37819ec` on
> branch `work/1.4.3-deploy-view`; the 1.5.0 work below is UNCOMMITTED.
> - **The Deploy view is the only page.** `sftkDeployViewOn()` is true unless the
>   no-button fallback key `_settings.deployViewClassic === true`. ONE seam: the
>   first line of `renderReconcile()` sends everything to `renderDeploy()`, so
>   the card (🚀 Deploy — ▶ Run and ⚖ Reconcile are gone), palette, builder,
>   History ↻ Run again / ↻ Retry failed, Org Compare, Ring ⚖ and the Seeder
>   all land there. The switch, the beta badge, ↩ Classic view are removed.
>   Classic code is still shipped (the engine and shared functions live in it)
>   but no button reaches `renderTransfer()` except Sequences' own runner.
> - **↻ Retry failed** → `window.sftkDeployRetry` → pure `sftkDeployRetryPicks`:
>   ticks failed ids still under 🔴 Insert (children only when the row is
>   selectable), counts 🟡 Changed, reports the rest.
> - **SAFETY FIX:** `runReconcile` typed-confirmed production DELETES only; a
>   plain insert/overwrite into production ran on one click. Now
>   `sftkRecGuardedWrites` names every write per org and `confirmTypedProd`
>   gates target AND source, fail-closed on an unknown org type.
> - Scan chokepoint (studio-scan.js) now repaints when `_currentView==='deploy'`.
> - Added to the page: 💾 Save as deployment, 🔗 Match review (only when both
>   sides have rows), 📸 restore point checkbox.
> - **Knowingly NOT on the page (said in CHANGELOG):** old 🧪 Dry Run, run-time
>   record filter, Upsert mode, API-call estimate, records preview; >5,000 per
>   list = run, refresh, repeat. Still missing from classic Reconcile: 📎 file
>   drift move, 🗂 table, group-by-parent, insert-order toggle, picklist-gap
>   notes, accuracy chip, auto-refresh on a stale run. NEXT: the real
>   rolled-back dry run (`docs/deploy-merge-parity.md` §A).
> - 2026-09-22: **🛑 Guard as production** on the Connected Orgs card
> (`_orgs[url].guardAsProd`, pure `sftkOrgGuardedAsProd` wins inside
> `ensureOrgType`/`cachedOrgType`). Both of the user's orgs are trials = 'dev',
> so without it the typed gates could never be seen. Gate now 87 files / 2545.
> - 2026-09-22: **false 'partial' fixed** — `runReconcile` counted every ⚠/🔗
> warning as a hard error (only ℹ exempt) while History called them notes. Now
> `sftkRunLineIsError` (= sftkFriendlyError kind) decides for both. History notes
> amber (`.ds-history-note-row`), skip hints per reason (`sftkSkipHints`).
> Gate 88 files / 2549.
> - 2026-09-22 after commit: the Deploy tree's CSS reused the builder's `.ds-tree-node`
> and squeezed the builder's object tree — renamed to `.ds-dtree-*` (test pins it).
> - 2026-09-22 smoke-test fixes (uncommitted): rollback refuses a locked org up front
> (`lockedLeg`) and says why the typed word is the org name; picker's Only
> needs-deploy loads the scan's ids by Id (`fetchTodoRecords`); pure
> `sftkScanStaleRun` (rollbacks count) drives classic + Deploy auto-refresh and a
> 🔄 button in the picker. Gate 90 files / 2558.
> - 2026-09-22: tree 🪪 chips name the org (orgLabel) not source/target; Bulk mode
> hides batch/threads and says Bulk splits the job itself. Gate 90 / 2560.
> - 2026-09-22 **LIVE TESTING NOW POSSIBLE**: `scripts/dev/headless-studio.mjs` drives the
> unpacked extension in headless Chrome (CDP Extensions.loadUnpacked over the pipe;
> `--load-extension` is ignored by branded Chrome 137+) with sessions from `sf org open
> --url-only`. Complex fixture seeded on trailheads2 (docs/fixtures/complex-deployment:
> 10 Accounts incl. 2 person accounts, hierarchies, ReportsTo, opps+OLI+OCR, cases+
> comments, campaigns+members, leads, tasks/events, assets, contract/order/items,
> individual, files); 5 deployments imported via bldProfileImportParse. Source-only pass
> found+fixed: Field Mapping 'No connected orgs' (allOrgs ignored _orgUrl), Deploy page
> silent on an offline target (now `sftkDeployOffline` banner + Read disabled).
> **OPEN DESIGN GAP to prove live:** self-lookups (Account.ParentId, Contact.ReportsToId,
> Case/Campaign/Asset.ParentId) — builder hides lookups to in-tree objects
> (studio-builder.js ~1028) and the engine only remaps them via idMap when the referenced
> record was inserted EARLIER in the run; otherwise the field is omitted with no note
> (background.js ~1404-1420). Fix = post-insert self-link pass + a diagnostic.
> BLOCKED on the target: trailheads4 is not in the CLI (`sf org login web --alias npc2`).
> Then: seed-target.apex + deploy target-metadata (2 validation rules), run the 5
> deployments headlessly, check drift/advice/rollback. Gate 91 / 2563.
> - Committed as `b731fb0` on `work/1.4.3-deploy-view` (2026-09-22); nothing pushed.
> - NOTHING here was exercised in a live org by Claude — the user must run the
>   smoke list before uploading.

## 1. What was done this session (short)

**Data Studio**
- **↩ Rollback for data deployments** — `sftk-undo.js` (pure core) + new
  `studio-undo.js` (wiring). Restore point (before-image) read BEFORE every
  write path: Run Transfer, fan-out, sequences, Reconcile (target + source
  legs), ring sync-plan push. Evidence lives in IndexedDB `sftk_undo`
  (newest 10 runs). History card offers ↩ Roll back: re-read → diff →
  cascade-children check → automation check → typed word (ROLLBACK / org
  name for prod) → soft delete + restore in 200-record slices → identity-based
  verify → own History entry (kind `rollback`). 26 defects fixed across two
  adversarial review rounds. 📸 checkbox on Run Transfer (`_settings.undoCapture`).
- **Completeness invariant** — `sfQueryAll` attaches `incomplete:{expected,got}`;
  scan and engine root read refuse partial data.
- **🪪 Identity stamp** (`SFTK_ID__c`), lookups on update, per-field push with
  preview, drift compare v2.
- **Org Seeder**: match-key column/picker, files, archived emails, CMDT /
  Custom Settings / Custom Labels + translations config pass. **Held back from
  the store build** (`HELD_BACK_JS` in `scripts/pack_store.py`) until tested.
- **Licence gate v2** (`sftk-terms.js`, EULA.md v2, LICENSE, PRIVACY.md): the
  user must confirm that any consequence of using BOTH the Toolkit and Data
  Studio, and every component, is their responsibility. Re-gates v1
  acceptances. Read-again view: popup top-bar **Licence** button + Data Studio
  security modal.

**Toolkit (popup)**
- **⚙ API versions** (compare/change flow API versions across orgs) and
  **⏻ Flow switches** (bulk activate/deactivate by object, cross-org, with
  remembered versions), clickable flows → Flow Builder.
- **Managed flows** now appear: root cause found live — FlowVersionView
  REFUSES an unfiltered query, so the read had always fallen back to Tooling
  `Flow`, which never returns managed flows. Fixed with a two-step REST read
  (FlowDefinitionView → FlowVersionView WHERE FlowDefinitionViewId IN …).
  Main Dependencies list has a 🔒 section; contents are hidden by Salesforce
  (dependencies UNKNOWN, disclosed).
- **Scan-state honesty**: unscanned flows show "⏳ not scanned — calls
  unknown"; chain panel lists per-version what the scan read (answers the
  user's "Copy of test has a subflow and it won't show").
- **API-version change fixed** (reproduced with check-only deploys via `sf`):
  package.xml must carry the ORG's version, and a deploy only creates a
  version — the tool now activates and re-reads (`avVerifyAndActivate`).
- **Field Cleaner**: Reports (fixable via Analytics REST + restore point),
  Report Types, Email Templates, Approval Processes ride the everyday
  MetadataComponentDependency scan (no org-wide sweep).
- Subflow health removed; Seeder org list dynamic.

**Rules added to memory**: always latest Salesforce tech (SOAP last resort);
Bash tool truncates very long commands → write scripts with the Write tool.

---

## 2. Current state — files changed / added (from `git status`)

**Modified (35):** CHANGELOG.md, PRIVACY.md, apex-log-viewer.html,
apex-log-viewer.js, background.js, dependency-map.js, eslint-globals.json,
field-cleaner.js, manifest.json, popup.html, popup.js, scripts/pack_store.py,
sftk-flow-xml.js, sftk-pii.js, studio-builder-modals.js, studio-core.js,
studio-history.js, studio-profiles.js, studio-reconcile.js, studio-ring.js,
studio-scan.js, studio-seed.js, studio-transfer.js, studio.css, studio.html,
and tests: dep-incremental, engine-childfirst, ent-pro-mode,
field-cleaner-objects, org-seed, pii-mask, pii-patterns, pure-functions,
scan-buckets, ui-popup.

**New, untracked (23):** EULA.md, LICENSE, harness/ (rollback-fixture/:
source-accounts.json, target-accounts.json, README.md runbook),
sftk-apiver.js, sftk-cmdt.js, sftk-flowbulk.js, sftk-identity.js,
sftk-mdapi.js (SOAP primitives, unused), sftk-reportclean.js, sftk-terms.js,
sftk-undo.js, studio-undo.js, and tests: apiver, cmdt-package,
drift-compare-v2, fetch-integrity, flowbulk, mdapi-retrieve, reportclean,
terms-gate, undo-rollback, undo-wiring.

**Ignore:** `Saleforce Toolkit/` (a nested folder) is a stale copy from June
2026, not from this session. Do not commit it; consider deleting it.

Diff size: 35 files, +14,977 / −1,947 lines.

---

## 3a. Second session — 2026-09-12 (everything below in §3 is now DONE)

**Fixed — all 14 §3 findings**, pinned in `test/audit-0912.test.mjs` (38 tests).
Notes on the non-obvious ones:
- (1) `handleMessage` retry now reads the sid with `sftkCookieSessFor(message.orgUrl)`
  and retries only when `sftkOrgKey` matches; `{ ...message, sid }` only (orgUrl
  untouched); messages with no `orgUrl` (transfer/sequence) are never re-run.
- (3) new top-level `sftkIncompleteErr(objType, what, inc, consequence)`;
  parent-scope refusals say the CHILD was skipped.
- (4) deploy poll goes through `sfFetchWithProxy`; a mid-poll session loss is a
  non-retryable error naming the job.
- (7) ⏻ gate is in-panel: type `OFF` / `ON`; the write moved to `applyFlowBulk`.
- (8) `renderDependencyTreeTab(allFlows, container, orgUrl, sid)`; `_lastSid`.
- (9) `_depActiveFilter` shared with the async 🔒 paint.

**Removed — 🔀 Cross-org diff** (user: "changing api and turning on and off is
strong enough"): button, `renderCrossOrgPanel/runCrossOrgDiff/renderCrossOrgResult`,
pure `depRefsMissingIn/depMissingNames`, report §4 + CSV rows, `getCrossOrgResult`,
their tests. `depLoadOrgs`/`_xoOrgs` stay (⚙/⏻ pickers). CHANGELOG has a Removed entry.

**Re-review (two Fable agents, read-only) — 16 real findings, all FIXED**, pinned
in `test/rereview-0912.test.mjs` (30 tests):
- A1 per-field push (`sftkPushFieldsToTarget`) now masks by PII policy / refuses PII
  match fields; A2 scan INCOMPLETE refusal is side-specific + flagged so the
  dot-path fallback never swallows it; A3 Run Transfer upsert on `SFTK_ID__c` sets
  `tree.stampField`; A4 `sftkIdHowToCreate()` (store build has no Seeder);
  A5/B4 restore-point cap is GROUP-aware (`groupId`, IndexedDB `sftk_undo` v2 with a
  `groupId` index, `sftkUndoPrune` groups); A6 wording; A7 ✋ Cancel exists before the
  capture (`shouldCancel` polled between objects; a cancelled capture stores nothing).
- B1 sync-plan job: ONE restore point per job, `sftkUndoRunEnd` AFTER the overwrite,
  both History cards share the evidence; B2 Seeder `sftkSeedIdDeploy` typed-gated per
  org (prod/unknown); B3 Custom Setting replace refuses BEFORE the delete on any
  incomplete/unresolvable read (+ CMDT incomplete skip); B5 retention marks cards
  expired (`_sftkUndoMarkExpired`); B6 Stamp identity: unknown org type → typed;
  B7 ring capture warnings persist in the note; B8 limits text matches the
  CreatedDate-only filter; B9 put/prune in separate try blocks.

**C1 — managed subflow targets (reproduced on the npc org with the CLI):** a
subflow call into a managed package rendered "❓ Not found — no flow with this
API name in this org" (tree), "Not found in this org" (chain panel) and
"missing" (dead-subflow report), because those three only consulted the Tooling
flow list, which never contains managed flows. Fixed: `depManagedRow/depManagedMap`
(from `_managedFlows`), `depDeadSubflows(map, flows, managedByApiName)` gained a
`managedTargets` bucket (+ `counts.managed`), tree paints a 🔒 node, chain flags
"🔒 managed · contents hidden", report §1.4 + CSV 'Managed subflow target'. Pins in
`test/rereview-0912.test.mjs` (C1). The user's own "still doesn't show subflows"
report is NOT yet confirmed to be this — details (org, flow, what the row says)
were requested. Gate after: 70 files / 2299 tests, packed, smoke 1/1/1.

**2026-09-13 additions (gate 71 files / 2325 tests, packed, smoke 1/1/1):**
- **Field Cleaner flow surgery** (user request): new pure `sftk-flowsurgery.js`
  (`sftkFlowSurgeryPlan/Lines`) + field-cleaner `fixFlowPlan/fixFlowExecute`,
  `_flowVersionsOf`, `_verifyFlowActivation` (re-read → activate via
  FlowDefinition PATCH if needed → re-read; nothing deleted otherwise),
  `_flowInterviewsFor/_deleteFlowInterviews` (FlowInterview by
  FlowVersionViewId, REST delete first), `_deleteFlowVersionIds`,
  `_markFlowSiblings`, `_loadFlowVersionInfo` (per-row "v3 · Active" badge).
  Confirm shows the exact plan + backup zip checkbox (default on, via
  popup's `downloadFlowBackupZip`) + interview list; inactive-only refs →
  delete just those; active ref → new version verified active, then delete.
  XML-inspector path (`fixFlowSelective`) verifies activation; its purge is
  interview-aware. `renderResults` became async. Tests: `test/flow-surgery.test.mjs`.
- **Dependencies tab**: ↻ Rescan (`window.sftkRescanDependencies` in popup.js:
  clearCache → loadFlows → scan even if 'skipped'); every row shows vN, API,
  status, created/modified (popup FLOW_FIELDS += ApiVersion,CreatedDate);
  managed rows show modified (FlowVersionView.LastModifiedDate →
  `sftkFlowVerRows` entry.lastModified); DEP_CACHE_SCHEMA 2→3. Root cause of
  the user's "still doesn't show subflows" screenshot (trailheads4, v2 edited
  in Builder at 20:07 while the popped-out tab stayed open): stale in-session
  scan state — Rescan is the fix; pins C2 in rereview-0912.
- CHANGELOG: the "Removed: Cross-org diff" entry was dropped (user: never
  shipped to any user); Added entries for flow surgery + Dependencies rows.
- User signed up two fresh Nonprofit Cloud trials (npc2/npc3, "trailheads4"
  seen in a screenshot); CLI logins NOT done yet — `sf org login web` from
  the user's own terminal is required (my run timed out unapproved).

**2026-09-14 — ROOT CAUSE of "subflows don't show" FOUND AND FIXED (gate 71 files /
2331 tests, packed, smoke 1/1/1):** `sfCompositeBatch` posted every batch to the
GENERAL `/composite/batch`; for a Tooling `sobjects/Flow/<id>` subrequest that
endpoint answers 200 WITHOUT the `Metadata` field (reproduced with the CLI on
npc: general endpoint → Metadata absent; `/tooling/composite/batch` → Metadata
+ subflows present). So every version counted as read with "no subflows", the
tree showed subflow-calling flows as Standalone, and ⚙ Apply's "could not be
read" (audit #6) had this as a second cause. Fix: all-Tooling batches now go to
`/tooling/composite/batch` (mixed batches are refused); `depBatchApply` treats a
200 without a Metadata field as UNREAD (`noMetadata` count), never as an
answer. Pins: composite-batch.test.mjs (Tooling endpoint), dep-incremental
(no-Metadata = unread; the old "covered" pin was the bug's accomplice). The
user must press ↻ Rescan once (cache schema bumped to 4 on 2026-09-14 so the blind cache is dropped without a click; trigger types ride in the cache too, which is why record-triggered flows showed as Auto-launched). The earlier
"stale popped-out tab" explanation was WRONG for this case — the map had been
blind since the batch refactor.

**Flow TYPE from the trigger column (2026-09-14, gate 71 files / 2334 tests, packed, smoke 1/1/1):** Salesforce's own Setup list stores record-triggered flows as "Autolaunched Flow" + Trigger "Record—Run After Save". New pure `depResolveFlowType(processType, triggerType)` (any `Record…` trigger → RecordTriggeredFlow; Scheduled; PlatformEvent; other process types such as PromptFlow untouched); `depFlowVersions` now selects `TriggerType, TriggerObjectOrEventLabel` from FlowDefinitionView, refines managed rows' ProcessType and fills `_defTriggerByApiName` (`getDefinitionTriggerMap()`); popup chains `loadManagedFlows(...).then(() => patchFlowTypesFromDefinitions(loadOrgUrl))` which refines `allFlows` and repaints the Flows tab + Dependencies tab. popup's `resolveFlowType` also accepts any `Record…` trigger. So the type is right with or without a scan. Pins C3 in rereview-0912; reportclean pin updated.

**Flows tab — dependencies + whole-tree backup (2026-09-14, gate 72 files, packed, smoke 1/1/1):** pure `depSubflowClosure(map, roots, cap)` (transitive callees, cycle-safe, cap reported as `truncated`); API `flowScanState(apiName)`, `subflowClosure(apiNames)`; popup `buildCallsChip` ("↘ calls N" with the tree in the tooltip; "↘ calls ?" when unscanned — never "calls nothing"); Backup mode option `#backupWithSubflows` → `planTreeBackup` (refuses with "The tree is not known yet" when any root/reached flow is unscanned; adds the ACTIVE version of each reached subflow else newest; discloses managed / not-in-org exclusions) → `confirmTreeBackup` modal → one zip `SF_Backup_<date>_tree_<n>flows.zip`; a read shortfall is shown inline (`toast-error`). Tests `test/flow-tree-backup.test.mjs`.

**Legal documents (2026-09-14, gate 73 files / 2354 tests, packed, smoke 1/1/1 + rendered-EULA smoke):** the "template, not legal advice … not reviewed by a lawyer" blockquote was REMOVED from the shipped `EULA.md` (user: must never reach an end user) and moved to repo-only `LEGAL_NOTES.md` (packer whitelist never ships it — pinned). New `legal.html` + `legal.js` render EULA.md / PRIVACY.md / LICENSE as a real page (charset, headings; pure `sftkLegalParse`/`sftkLegalInline`, DOM built node by node — no innerHTML, Trusted-Types safe; only http(s) links become links). `sftk-terms.js` gate + read-again view link to `legal.html?doc=eula` / `?doc=privacy`. Tests `test/legal-page.test.mjs`; terms-gate pins updated (lawyer note must NOT be in EULA; links → legal.html).

**⚙ panel wording (2026-09-14):** the panel and its button called themselves "Read-only" although ⚙ Apply writes (typed CHANGE) — reworded ("Comparing changes nothing; ⚙ Apply … deploys a new flow version per org"); "This org" now reads "This org (<host>)" in both ⚙ and ⏻ (checked-by-default test uses /^This org/). Pins in apiver.test.mjs + audit-0912. Verified live by the user's screenshot that the subflow fix works: four parents now show their managed subflow children.

**⚙ / ⏻ are SINGLE-ORG now (2026-09-14, user: "you can still compare against other orgs" was the thing wrong; cross-org pickers confuse users):** org pickers removed from both panels, `depLoadOrgs` + `_xoOrgs` deleted, `_avOrgsAll`/`_fbOrgsAll` = [connected org], "Pick at least two orgs" gone, wording "in this org"; the multi-org matrix/plan machinery (sftkFlowVerMatrix, sftkApiVerPlan, per-org remembered versions) is unchanged underneath. Pins: apiver.test.mjs ("⚙ and ⏻ are single-org"), flowbulk pin → "in this org". The earlier interpretation (that the user was merely confirming cross-org still works) was WRONG — three messages said the opposite.

**Packer fix + honesty correction (2026-09-14 19:27):** `scripts/pack_store.py`'s referenced-file check treated `legal.html?doc=eula` as a missing file, so every pack since the legal page (three "packed" claims in HANDOVER/chat) had FAILED silently — the grep for ✅ hid it. Fixed (query/fragment stripped before the existence check). Repacked: **63 files, 1039 KB**, zip includes legal.html/legal.js/sftk-flowsurgery.js, LEGAL_NOTES.md absent; smoke 1/1/1 + rendered EULA page; gate 73 files / 2359 tests. LESSON: check the packer's exit line, not a grep for a checkmark.

**DATA STUDIO RESTRUCTURE — PHASE 1 DONE (2026-09-14 evening; gate 73 files / 2320 tests — 40 pins of the removed features retired; packed 62 files 1018 KB; smoke 1/1/1):** user decision (AskUserQuestion): REMOVE 🌳 Tree diff + 🌐 Multi-org fan-out (incl. Sync Ring "Push…" and "Sync plan…"); KEEP Sequences and Org Compare; Sync Ring stays as the place you define source + targets with its drift matrix and per-cell ⚖. Done: `studio-treediff.js` DELETED (+ script tag, `treediff` view, `openTreeDiff` action); `dryRunFanOut`/`window.openFanOut`/`runFanOut` deleted from studio-transfer.js (pure `sftkFanoutTargetAdvice/DryVerdict/DrySummary/ScanAge` kept — Run Transfer's dry run uses the verdict); `_ringOpenPlan` deleted + ring row buttons; profile card lost Tree diff + Multi-org buttons; `window.runProfile(profileId, targetUrl)` asks WHICH target (modal like Reconcile's) when the ring has several, then runs ONE; Run page's org pair: source static, target `<select>` limited to `profileTargets(p)`, swap removed; builder targets hint says "▶ Run and ⚖ Reconcile ask which target, one at a time"; Reconcile help points at the Sync Ring matrix. Engine/scan/matching UNTOUCHED (user: it works at work; "small issues" to be asked about later). CHANGELOG Removed entry added. Tests updated: fanout-dryrun (fan-out dialog/runner describes removed, validator+verdict tests kept), pii-dryrun, undo-wiring, rereview-0912 (A5 fan-out pin + B1 removed), ui-studio, pure-functions (tree-diff helpers), viewheader, scan-buckets (Sync Plan cap describe). Studio-profiles.js is CRLF — patch scripts must convert anchors (no backslashes in heredoc Python: the shell eats them; use chr(10)/chr(13)).

**Work-session findings fixed (2026-09-14 night; gate 74 files / 2331 tests, packed, smoke 1/1/1):** (1) ⚖ Reconcile no longer pre-selects every missing/drifted record — the seed block in renderReconcile (which also RE-ARMED on every re-render once all sets were empty) is gone; ✓ All per column remains. (2) Run page counts: new pure `sftkChildCountWhere(node, parent)` scopes each child count to its parents' filter via a semi-join (a grandchild under a filtered parent cannot be scoped → `unscoped`, shown as "≤ N"); `sftkCountBreakdown` gives "2 Account · 16 Contact"; the big-run/prod confirm shows the breakdown; `_trLastTotalIsBound`. The user's "picked 2, it said 18" happened WITHOUT children, so the reconcile seeding is the likely cause; if it recurs the user should say which screen showed 18. Tests `test/reconcile-selection-counts.test.mjs`. Engine untouched.

**⏻/⚙ state-aware selection + UI pass (2026-09-14 night):** ⏻ checkboxes carry `data-on` (on/off/absent from this org's cell); group buttons are "all ON" / "all OFF" (`data-want`); the two actions read "⏻ Switch OFF (N ON selected)" / "▶ Switch ON (M OFF selected)", disabled at zero; `runFlowBulk` acts only on ticked flows in the right state (user: "the user can select flows who are inactive here"). UI: both panels re-rendered as class-based lists (`.dep-tool-sum`, `.dep-list`, `.dep-list-grp(-hd)`, `.dep-list-row`, `.dep-list-state`, `.dep-pill-{on,off,ok,warn,bad,api,absent,hint}`, `.dep-tool-foot`, `.dep-btn-primary`) with tokens appended to styles.css; sticky group headers; the "apply here" org box is hidden+checked (single org); ⚙ summary shows the org's release, "N behind the org release", rows sorted by lag, "✓ Select the N behind". Pins updated in apiver.test.mjs + flowbulk.test.mjs.

**Phase 2 candidates (not started):** builder step 1 labelled "Ring"; profile card shows the ring (source → each target with its last scan) with per-target ▶/⚖ buttons; History filter by target; Org Seeder still held back.

**⚙/⏻ auto-load (2026-09-14 late):** the 🔍 Compare and 🔍 Load flows buttons are gone; both panels run on open (single org, a few read-only calls quoted in the progress line); post-run notes offer ↻ Reload (⏻) / say reopen or ↻ Rescan (⚙). Also the post-read `orgs.length < 2` gate in runApiVerCompare → `!orgs.length` ("Not enough orgs could be read" was still shown after the single-org change). Pins in apiver.test.mjs. NOTE for the user: after every rebuild the extension must be reloaded at chrome://extensions and the popped-out tab reopened — stale JS produced two false bug reports today.

**User direction (2026-09-14, Data Studio):** remove "scan tree difference" and
multi-org deployment (fan-out etc.) — "confusing for the users". Wanted shape:
when you start a profile you pick a RING (source + targets); Reconcile asks
which target and you do it one target at a time. The Toolkit's ⏻ / ⚙ cross-org
tools stay as they are (user confirmed they still compare across orgs). NOT
started — next task.

**Other:** `eslint.config.mjs` now ignores `Saleforce Toolkit/**` (stale nested
copy) and `dist/**` — the stale copy was failing lint.

**User question answered (advice only, nothing built):** "How can we make data
deployment easier to understand?" — recommended a 3-step guided flow (Source →
Records → Target), a plain-language preview card before every run (counts,
match key, restore point, PROD flag), intent-based names for the modes,
vocabulary cut, one Deployments home, result screen mirroring the preview;
mockup first, then code. Not started.

**Still pending on the user's side:** `sf org login web --alias ashkenazy6/7`
for the rollback live test, uploading 1.4.3 to the EXISTING store listing,
"commit it".

**Reconcile header UI pass + two live findings (2026-09-15 evening; gate 75 files / 2342 tests, packed 62 files / 1021 KB, headless smoke 1/1/1; still UNCOMMITTED on `07cd84a`):** (1) Reconcile header redesigned (user: "can we improve the following ui section so it looks better?") — the "To be IN SYNC" banner is a `.ds-rec-card` with count chips (`.ds-rec-stat`: N to insert / changed / target-only / files, dashed per-child chips) and one hint line; the duplicate-name warning is a folded `<details class="ds-rec-dups">` listing the copies; the "Pushing X → Y" box is a one-line `.ds-rec-legend` (→ / ← / 🗑 / "nothing writes until you ▶ Run"); truncation + near-miss notes are `.ds-rec-card-tight`; the advisor's order stepper uses the same card family ("Deployment order"). CSS appended to `studio.css`; ui-studio pin updated ("children unverified"). Engine untouched. (2) **Person Accounts:** the user's live run trailheads2 → trailheads4 failed 10/10 with "Unable to create/update fields: Name". Verified on npc by CLI that those records are Person Accounts (IsPersonAccount = true, RT "Person Account") — Salesforce derives a PA's Name from FirstName/LastName and refuses the whole on insert AND update. Fix: `buildCopyFields` keeps `IsPersonAccount` (read-only, needed by the builder); the engine payload builder skips `Name` when `r.IsPersonAccount === true` and the target takes the parts (`tgtCreatable.has('LastName')` or target describe unknown) — counted as `personRows` (diagnostic line) — else counts `personAsBusiness` (errors line: target has no Person Accounts, records landed as business accounts); `reconcileOverwrite` selects the flag (`descByLower['ispersonaccount']`) and skips Name on PA rows. Tests `test/person-accounts-0915.test.mjs` + a pure-functions pin. NOT re-run live yet — the user should reload the extension and press ↻ Retry failed (10). (3) **History offered ↩ Roll back on that run although nothing was written:** new pure `sftkUndoRunWrote(run)` in `sftk-undo.js` (true / false / null from the run summary; `skipped` objects ignored; `error` / `notProcessed` / `unconfirmed` / an entry without any count key → null) and `sftkUndoCardState` returns a disabled "↩ Nothing to roll back" only on a definite false — unknown keeps the button. Pins in undo-rollback. (4) The Claude session's working directory was moved to `C:\Users\yonas\OneDrive\Desktop\Saleforce Toolkit` — the only copy on this PC (no non-OneDrive path exists; git repo + today's edits are there). (5) **Person Account CONTACTS (2026-09-16; gate 75 files / 2345 tests, packed 62 files / 1023 KB, smoke 1/1/1):** the user's retry inserted the 10 Accounts (PA fix confirmed live) and then Contact failed 10 × "Cannot select a person account" — the hidden Contact Salesforce creates with each Person Account. Not a matching bug: at scan time the target had no PAs, so no hidden Contacts, so "10 to insert" was true; the Account insert created them seconds before the Contact insert. Fix: engine drops `IsPersonAccount === true` Contacts before `nodeSourceIds` (diagnostic + `summary.personContactsSkipped`); the scan selects the flag on whichever side has it and removes those rows from BOTH sides before bucketing (`scan.personContacts = {src,tgt}`); History tag/chip 👤 and a Reconcile header line show the count. Pins appended to `test/person-accounts-0915.test.mjs`. Not re-run live yet — user: reload extension, rescan, Contact section should no longer list them. User asked what a "gotcha catalogue" means — answered (readiness rows per known trap, verified by query, yes/no/unknown; complementary to a one-record probe); not built; candidates: PA contacts (now handled), duplicate rules, validation rules, restricted picklists. (6) **Reconcile child rows + wide compare (2026-09-16; gate 76 files / 2352 tests, packed 62 files / 1024 KB, smoke 1/1/1):** user: "On child records who are changed you can't open them and see their lookups" and "you can't see the field values because it's too small". Child changed rows (childSectionHtml driftRows) now carry `▸ fields` (`data-recc-drift` + `data-rec-pair`) and 🔗 (`lkpLinkC`: `data-rec-lkp` + `data-recc-lkp`, counts the CHILD node's picks); handlers use `childView(pathKey)` = `{ node, cs, obj, prof: { ...p, tree: node, lastScan: cs } }` (a VIEW rooted at the real node, not a clone, so picks persist with the profile); the root 🔗 selector is `[data-rec-lkp]:not([data-recc-lkp])`. Both child run clones (bProfile insert, cProfile overwrite) now carry `lookupOverrides: a.node.lookupOverrides` so child hand-picks reach the engine / reconcileOverwrite. New module-level `sftkOpenDriftCompare(prof, obj, srcId, tgtId, srcFields, tgtFields, keyLabel, fallbackFields)` opens the field compare in the shared modal (`.ds-modal-box:has(.ds-dc-modal-body)` → 1100px; values wrap; `body.isConnected` guards a closed modal); the root `[data-rec-drift]` handler uses it too (inline expander gone). `.ds-dc-v` carries `title` = full value everywhere. Tests `test/reconcile-child-rows-0916.test.mjs`; drift-compare-v2 pin updated. Child INSERT rows still have no 🔗 (only changed rows were asked for). Not verified live.

**APPROVED DIRECTION — one Deploy page (2026-09-18, user: "I like this one"; NOT built):** the user asked what the difference is between the Run Transfer page and Reconcile, then "why do we need this feature?", then "why can't we enjoy both worlds together?" -> mockup approved. Mock lives in the repo at docs/mockups/deploy-merged.html (not packed, not linted) and at https://claude.ai/artifact/WBc8n7hbijzTciLC3NsGgJ. Design: ONE page replaces Run Transfer + Reconcile. (1) Plan card first: per object In source / New / Already there / Changed / Only in target, read by running the existing scan in COUNTING mode (no 5,000 bucket cap; id sets held in memory for the run, never saved). (2) Records panel under it with four tabs; every count opens its list; New rows are ticked by default, Changed rows are skip by default with the existing arrows, Only-in-target rows never default to delete; big buckets page (first 50 + filter, "the count is the truth, the list is a window"). (3) Defaults card: insert new ON, update changed OFF (disabled when none), delete never a default, restore point ON. (4) Exceptions strip (duplicate names, near matches, changed, no-key objects) with one link each. (5) Three states: target already has some / empty target (plain copy, no matching) / object with no usable key (copied, not compared, says so and points to the SFTK_ID stamp). (6) Button states the number and disables at zero. ENGINE UNCHANGED - Reconcile inserts already call SF_EXECUTE_PROFILE_TRANSFER with recordIds. New work: uncapped id sets, the plan card, the no-key rule. Open questions put to the user: open the New list by default under ~200 records? label "Already there" vs "In sync"? verb "Deploy"? Suggested build order: (a) counting-mode scan + plan card on top of today's Reconcile page, behind no flag but additive; (b) records panel replaces the three columns; (c) Run Transfer page folds in and its nav entry is removed; (d) sequences keep calling the engine directly. Do (a) first - it is additive and cannot regress the engine the user tested at work.

**REAL DRY RUN + PARITY CHECKLIST (2026-09-18; gate 77 files / 2355 tests, packed 62 files / 1024 KB, smoke 1/1/1; uncommitted):** user: "ok so we need the real dry run. but we need to make sure each functionality of the old ui is there." (1) docs/deploy-merge-parity.md is THE checklist for the merge - two read-only inventories (Run Transfer 61 items, Reconcile 113 items) condensed into tick-boxes plus an easy-to-miss list; tick an item only when the merged page does it and a test pins it. (2) The old dry run (sftkDryRunAgainst, ~760 lines in studio-transfer.js) is a second hand-written copy of the engine rules (it did not know Person Accounts, can never see validation rules / triggers / duplicate rules) and is to be REPLACED by a real write that Salesforce rolls back. VERIFIED on npc by CLI, 0 records persisted after every test: (a) POST composite/sobjects allOrNone:true + one poisoned record -> every failing record reports its OWN error, valid ones report ALL_OR_NONE_OPERATION_ROLLED_BACK; (b) composite/graph is NOT usable - stops at the first failure, every other node PROCESSING_HALTED, and an empty-body poison makes the whole graph JSON_PARSER_ERROR; (c) POST composite allOrNone:true wrapping composite/sobjects {allOrNone:false} subrequests + a poison: a child IS evaluated against a parent created in the same request via "@{refP[0].id}", the FIRST subrequest containing any failed record keeps its full per-record body and everything else is PROCESSING_HALTED, nothing failing -> only the poison fails = "probe passed". So errors surface one level at a time; re-probe without the failing parents to see child errors. Poison must be a valid body that fails a rule, e.g. Account {Description} with no Name. Limits: sample of 200 per call, triggers really run (immediately-published platform events do not roll back), prod behind typed confirm. Build rule: the probe sends payloads built by the REAL engine, never a second implementation. (3) Mock v3 (same artifact URL + docs/mockups/deploy-merged.html): every row opens the WHOLE record in a wide dialog on all four tabs (All fields / Lookups only / Differences only), lookups show where they land in the target and can be hand-picked (badge on the row), changed records tick fields to push; the parents advisor is a "Deployment order" card with one-click fixes; the dry run button shows a rolled-back result. User feedback that drove v3: "we don't show the records here", "i dont see the parents suggestion", "you can't select lookups and see the whole records". (4) FIX from the inventory: Reconcile delete guards checked === 'production' only, so an org of UNKNOWN type allowed hard delete and skipped the typed confirm; now tgtGuarded = not sandbox and not dev (same rule as Stamp identity); test/reconcile-delete-failclosed-0918.test.mjs. (5) Explained to the user: "object with no usable key" = an object with no name / external id, so the scan cannot tell whether a target record is the same record; it is copied, not compared, until it carries the SFTK_ID stamp.

**Mock v5 (2026-09-18) - naming + children:** CORRECTION: the user did NOT accept v4's tab names; quoting my mapping table they said "this one is better" = keep TODAY'S Reconcile names, colours and order: red Insert / yellow Changed / blue In target only / green Synced (plan chips, plan table and tabs all use them). Then: "we need to support child records" -> the records panel is now PER OBJECT: an Object switcher (root, then each child with its count of records to act on), each child object has its own four buckets PLUS a Link differs tab with Relink, parent chips on rows (parent in this run / parent exists in target / orphan), group by parent with group select/clear and live n/N, insert order before/after parent (disabled for master-detail), child Changed rows are source-wins only, child target-only rows delete only with orphans left out of bulk delete, a no-key child shows why its other buckets cannot be filled. The three situation buttons at the top are mock-only. Lesson: a headless --dump-dom render with --enable-logging=stderr catches a runtime error that a syntax parse misses (an edit had deleted a constant and the page silently stopped painting). Still open: auto-open small Insert lists, the verb "Deploy". Waiting for "build it".

**ORG WRITE LOCK KEPT (2026-09-18 late; gate 78 files / 2360 tests, packed 62 files / 1025 KB, smoke 1/1/1):** user said the per-org "Read-only" button is not a viable feature; after the assessment (it is the only guard covering writes INTO THE SOURCE via the back-arrow, and it does not depend on Salesforce reporting the org type) the user said "keep it". Presentation fixed, enforcement untouched (background.js chokepoint "Org is marked read-only"): button now "Lock writes" / "Unlock writes", badge "writes locked", tooltip "A safety lock, not a mode"; new window.sftkOrgLocked(orgUrl) matches by org identity (_orgKey); Reconcile shows a locked source/target in the header card, disables the four source-writing controls (back-arrow per row, back-arrow all, Pull, Pull all) when the source is locked, and runReconcile refuses by org and direction BEFORE the restore point. test/org-write-lock-0918.test.mjs. The merged Deploy page must carry the same behaviour (added to docs/deploy-merge-parity.md).

**FOUR LIVE FINDINGS FIXED (2026-09-18 evening; gate 80 files / 2374 tests, packed 62 files / 1027 KB, smoke 1/1/1; uncommitted):** (1) chrome://extensions error "Cannot read properties of null (reading 'replace')" at lightning-pages.js init: a sidebar click reached a tool tab before any Salesforce session existed. New popup helper toolTabHasSession() (same behaviour as loadFlows: initSession() shows the connect screen) is the first line of all six tool-tab inits (Lightning Pages, Debugger, Field Cleaner, Copy Permissions, Licenses, Flow Access); lightning-pages key uses String(orgUrl || ''). test/tool-tab-session-0918.test.mjs. (2) DANGEROUS: "Retry failed (10)" for failed CONTACTS opened the Run page with the Contact node filtered and the ACCOUNT node unfiltered - Run would have inserted all 5,058 Accounts again. Cause: retryFailedRun seeds filters only on nodes that had failures. New pure sftkRetrySplit(filters) in studio-scan.js (a node is safe when it is the root or EVERY ancestor is filtered); child-only failures now open Reconcile with an explanation (Reconcile attaches children to existing parents via its group-B bridge), mixed retries drop the unsafe nodes and the toast says so. The user was told NOT to press Run on the screen they had open. (3) Dependencies showed managed subflow targets as "Not found" again: with a CACHED map the tree paints before loadManagedFlows lands, and the only later repaint was conditional on a flow TYPE changing. New _treePaintedBeforeManaged + DependencyMap.treeStaleForManaged(); the popup chain repaints when it returns true. (4) Run page footer overflowed its card (flex-wrap, nowrap labels). Tests test/three-fixes-0918.test.mjs; two rereview-0912 pins updated. Seen working live in the user's History screenshot: "Nothing to roll back" on the all-failed runs. NOTE for the Deploy-page build: retry of failed children must be a first-class path there (parity list updated).

**Person Account fix CONFIRMED LIVE + empty child section (2026-09-18 night; gate 81 files / 2377 tests, packed 62 files / 1027 KB, smoke 1/1/1):** the user's rescan of Account + Contacts on trailheads2 -> trailheads4 shows the Contact child section with Insert 0 / Link differs 0 / Changed 0 / In target only 0 - the ten hidden Person Account contacts are no longer offered anywhere. The same screenshot showed a layout bug: .ds-rec-cols carries a viewport-bounded height (clamp up to 700px, right for the root columns) and a child section stacks TWO such grids, so an all-empty section cost two screens of "none". Now .ds-rec-cols-child is content-sized (columns capped at clamp(220px, 52vh, 480px), still scrolling inside) and when all four child buckets are empty both grids are hidden behind one strip: "Nothing to do for <Object>" + synced count + the Person Account contacts note. test/child-empty-0918.test.mjs.

**Person Account contacts now SHOW as synced (2026-09-18 night; gate 81 files / 2381 tests):** user: "yea but i dont see the contacts as synced?" - removing them from the scan on both sides (2026-09-16) made a matched pair vanish. New rule in runDiffScan: they take part in matching (id sets _paSrc/_paTgt, records no longer filtered out); a pass right before the bucket caps drops them from every ACTIONABLE bucket (missingInTarget -> waiting, changed + linkMismatch -> follows, onlyInTarget -> targetOnly) and tags matched identical rows personAccount:true (counted as synced). scan.personContacts = {src,tgt,synced,waiting,follows,targetOnly}. Pure sftkPaContactsLine(pa, srcLabel, tgtLabel) words it for the Reconcile header, the all-empty child strip and a note on non-empty child sections; synced rows carry a person-account tag. Engine unchanged (still skips them at insert). The merged Deploy page must show them the same way.

**Secret scan + personal email removed (2026-09-19; gate 82 files / 2455 tests, packed 62 files / 1028 KB, smoke 1/1/1):** user asked whether any API keys are exposed. Scanned all 183 tracked+untracked files, the full git history and the store zip for known key formats, literal Salesforce session ids and secret-looking assignments: NONE. The extension has no key of its own (no backend, no OAuth client; it uses the tab's session cookie). Session id handling verified: never logged, never in chrome.storage (28 keys checked; sftk_orgs holds label/lastSeen/orgType/readOnly only; sftk_active_run holds kind+startedAt), never in a URL, redacted by debug-logger before storage/export; CSP connect-src is Salesforce-only; manifest has no key/oauth2/externally_connectable. GitHub repo YonatanAshkenazi53/salesforce-toolkit confirmed PRIVATE. The one finding: the owner's personal Gmail was on the Contact line of the shipped EULA.md, PRIVACY.md and LICENSE. User: "I dont want to publish my email if not needed" -> replaced with a ROUTE ("the developer contact on this extension's Chrome Web Store page"); EULA version NOT bumped (editorial). test/no-personal-email-0919.test.mjs fails if any personal-mail address appears in a shipped text file. NOTE told to the user: the Chrome Web Store listing itself shows a developer contact email, set in the developer dashboard - to keep Gmail private they need a separate address there (only they can create it).

**DEPLOY VIEW (BETA) BUILT - STEP 1 of the merge (2026-09-19; gate 84 files / 2479 tests, packed 63 files / 1041 KB, smoke 1/1/1; uncommitted; NOT yet seen live by the user):** user: "Can you implement it with the option for us to go back to the current view?" New file studio-deploy.js (loaded after studio-reconcile.js / studio-profiles.js, shipped in the zip). ARCHITECTURE RULE: it is a PRESENTATION - no engine, no scan, no selection state of its own. It reads p.lastScan / scan.children[pathKey], writes into the SAME Sets as Reconcile (_recSel, _recChildSel, _recDeleteMode), runs through runReconcile(p, objType, {missing, drift, extras}) using the classic element ids (dsRecRunBtn, dsRecProgress, dsRecParentGaps so sftkRecParentGapAdvisor paints and gates), opens sftkOpenDriftCompare / renderLkpOverridePanel; a test pins that the file never calls sendBg / chrome.runtime / any SF_* message. SWITCH: _settings.deployViewBeta === true (absent = classic). Button "New Deploy view: ON/off" on Data Deployment (studio-profiles.js header) -> sftkDeployViewSet. With it ON, window.openReconcile sets _currentView = 'deploy' and window.runProfile (wrapped in studio-deploy.js; the original kept as window.sftkClassicRunProfile) routes to openReconcile, so both card buttons open the merged page. SEAM: first line of renderReconcile -> if (_currentView === 'deploy') return renderDeploy(); so every repaint the classic code asks for (after a run, rescan, child scan, advisor journey) lands on the new page. Classic Reconcile header has a "New view" button (dsaction openDeployView, per visit); the new page has "Classic view" (dsaction deployToClassic, per visit, switch unchanged). Three pure EXTRACTIONS in studio-reconcile.js so both pages share one copy of each safety rule: sftkRecResetSelectionFor(p), sftkRecScanFresh(p) (the delete-by-id objectType guard), sftkRecChildRowState(r, depth, pMissingSet, pExistsSet). PAGE: header + beta chip; plan card with four chips and a per-object table (In source / In target / Insert / Changed / In target only / Link differs / Synced) using MEASURED totals via sftkScanBucketInfo + sftkBucketCountLabel, per-child Scan/Rescan, "unknown, not zero" for unscanned children; notes card (locks, truncation, duplicate names, near misses, Person Account line, scan warnings); Deployment order host; records panel PER OBJECT (object switcher incl. grandchildren, tabs in today's names/colours/order, filter by name or parent, 300-row window, truncation note, bulk all-listed/none); row controls: root Insert checkbox, Changed -> / <- (mutually exclusive, <- off when the source is write-locked), target-only delete / Pull, child Insert with the classic parent rules (deepblock + untracked not selectable, 'missing' says the parent comes along), child Changed source-wins only, child delete with orphans excluded from bulk, Link differs with Relink (off when master-detail not reparentable), record view on changed/link rows, lookups modal on insert/changed rows; sticky action bar with the selection in words, Delete mode, Deploy button showing the count and disabled at zero. NOTHING is pre-selected (the user's 2026-09-14 rule outranks the mockup's default). NOT in it yet (said on the page): the real rolled-back dry run, engine/batch/threads (classic page), Match review, Stamp identity, file drift move, per-parent grouping, insert-order toggle, journey banner is minimal. Tests: test/deploy-view-0919.test.mjs (contract + pure helpers) and test/deploy-view-runtime.test.mjs (EXECUTES the page in a vm against a fake scan: every tab of root and child, capped total '5,000 of 5,048', 300-row window, child parent rules, Deploy arming). NEXT: user looks at it live on trailheads2 -> trailheads4; then step 2 = real dry run.

**Deploy view polish after the first LIVE look (2026-09-19; gate 84 files / 2482 tests, packed 63 files / 1041 KB, smoke 1/1/1):** user (dark-theme screenshot): "I like the idea, but it looks a bit weird now". Seen and fixed: (1) the sticky Deploy bar floated OVER the record list -> now static under a list bounded to the viewport (clamp(220px, 100vh - 360px, 640px)); (2) cards were 960px and the records panel 1200px -> everything lives in .ds-dep-page, same width as the view header; (3) every number appeared twice (chip row + table) -> chip row removed, the table carries coloured totals per bucket plus an "All objects" row, column hints moved to header tooltips; (4) the truncation warning appeared twice with a doubled warning sign -> one line in the notes card (leading sign stripped, first sentence only), full wording on the truncated tab, and the Synced tab has its own wording (nothing to "run" there). The live screenshot also CONFIRMS the page works on the real orgs: Account 5,058 / 5,058, 1 changed, 5,000 of 5,052 synced, child scan + Rescan. HOW I LOOKED: scripts/dev/deploy-preview.mjs renders the page's REAL markup (vm, fake scan) with styles.css + studio.css into _preview_deploy.html in the repo root, then chrome --headless --screenshot; the preview's body class "sftk-dark dark" gave a faithful dark render (verified against the user's own dark screenshot). Use: node scripts/dev/deploy-preview.mjs <tab> <pathKey> <dark|light>. Delete the _preview file afterwards. This is the way to SEE a Data Studio page without opening the extension (memory note: Chrome tools cannot open extension pages).

**2026-09-21 — five asks from the live Deploy view + a test fixture + API versions bulk (gate 84 files / 2495 tests, packed 63 files / 1048 KB, smoke 1/1/1; uncommitted):** LIVE CONFIRMED by the user's screenshot: the Deploy view runs on trailheads2 -> trailheads4 and the Person Account rule works (4,716 Contacts synced and tagged, "2 differ - they follow their Account"). (1) "where is the start with parents first. of both root and its childs?" - the classic advisor paints ONLY when the root has inserts and inspects ONLY the root object's lookups. New always-on card in the Deploy view (#dsDepOrder, _depPaintOrder) covering EVERY object of the tree: one numbered step per OUTSIDE object with every object.field that needs it (pure sftkDeployOrderSteps), states done/behind/empty/checking/unknown, the same one-click journey, a final step "Account -> Contact, this deployment"; it feeds the same run gate. The data side was EXTRACTED from the classic advisor into shared functions in studio-reconcile.js, and the classic advisor now calls them (behaviour unchanged, its root-only rule pinned): sftkParentStepState (pure), sftkParentGapsFor (probe, optional probeCache), sftkParentOrderFor (walks the whole tree), sftkParentVerifyOne, sftkOpenParentsFirst, sftkParentGapSetGate. studio-deploy.js still never calls sendBg. (2) "in the synced, i want to be able to see the comparison" - Synced rows have "compare" (sftkOpenDriftCompare); the compare unfolds its matching fields when nothing differs. (3) "i dont see the bulk api, threads" - Engine / batch size / threads on the Deploy bar via shared sftkRecSetEngine + sftkRecEnginePersist (the classic closure now delegates). (4) "who are they?" + "What operations we can suggest in order to fix" - shared sftkRecDupsHtml(scan, p) lists each duplicated name with links to every copy in both orgs and the fixes SAFEST FIRST: merge/rename/delete the copies -> make the match key unique (editProfile) -> Match review -> Stamp identity LAST (stamping while copies are ambiguous would cement a coin flip); sftkRecWireDupFix wires the buttons on both pages. (5) TEST FIXTURE deployed to trailheads2 (npc) on request: record-triggered flow SFTK_Dep_Test_Account_Trigger (Account, after save, entry condition Name = SFTK_DEP_TEST_NEVER_MATCHES_A_REAL_ACCOUNT so it never runs) -> SFTK_Dep_Test_L1 -> L2 -> L3 -> L4, all Active, API 64; source kept in docs/fixtures/dep-test-flows (deploy with: sf project deploy start -o npc --source-dir force-app --test-level NoTestRun; "deploy validate" fails there only because the org's Apex coverage is 42%). (6) API VERSIONS panel: "can we suggest the user to update them all in bulk" + "must not be able to select flows that can't be modified ... check if there's more scenarios". MEASURED on trailheads2: 239 FlowDefinitionView rows = 177 ManageableState installed (all namespaced: 105 templates, 64 overridable) + 62 unmanaged (57 Flow Builder, 5 Cloud Flow Designer); Tooling Flow lists only the unmanaged. The read now selects ManageableState on FlowDefinitionView and FlowVersionView.FlowDefinitionView (verified live, no MALFORMED_QUERY). New pure sftkFlowIsLocked (installed = locked; installedEditable and packaging-org states stay editable; namespace only as fallback) and sftkApiVerSelectable -> {ok, why}: absent / managed / InvalidDraft / no record id. Locked rows are disabled with the reason, never counted as ticked, "Select the N behind" and the new suggestion count only what can be changed; the suggestion "Update all N to API x" ticks them, sets the target to the org release and opens the SAME confirmation (pinned: it never calls applyApiVerChange). NOT blocked because not verified as unchangeable: Cloud Flow Designer flows, IndicatorResultFlow, Obsolete (deactivated) flows, flows reporting no API version. The preview tool scripts/dev/deploy-preview.mjs was updated for the new stubs.

**Dependencies tree depth (2026-09-21 evening; gate 85 files / 2498 tests):** the user's fixture (SFTK_Dep_Test_Account_Trigger -> L1 -> L2 -> L3 -> L4 on trailheads2) showed the tree stopping at depth 3 with "deeper than 3 levels. Manual review recommended" - L4 never drawn. LIVE CONFIRMED in the same screenshot: the record-triggered type is resolved correctly, the four managed subflow targets show the lock row (the 2026-09-18 repaint fix works), and the fixture renders. Cause: a hard `if (depth >= 3)` in renderFlowNode that predates the per-branch `visited` set. Now DEP_TREE_MAX_DEPTH = 25 (bound for pathological trees only, with a pointer to the chains tool), and a flow that calls back into its own chain gets an explicit loop line instead of an expand arrow with nothing under it. test/tree-depth-0921.test.mjs. depChain (blast/chains panel) keeps its own cap of 6, which it already reports as truncated.

**Field Cleaner fixture on trailheads2 + Match review advice fixed (2026-09-21 night; gate 85 files / 2501 tests, packed, smoke 1/1/1):** on request ("create a flow example for field cleaner using a picklist field that is using a multiple flow versions with failed interviews") I deployed to npc: restricted picklist Account.SFTK_FC_Test_Status__c, permission set SFTK_FC_Test_Access (assigned to the CLI user), and flow SFTK_FC_Test_Flow with FOUR versions that all reference the field - v1 Obsolete (Decision + record create setting the field), v2 Obsolete (+ Assignment), v3 ACTIVE (+ second Decision outcome), v4 Draft (+ formula TEXT(field)). VERIFIED by query: 5 FlowInterview rows with InterviewStatus = Error (2 on v1, 2 on v2, 1 on v3). HOW failed interviews are made: the autolaunched flow creates an Account with no name and has no fault path; invoking it through REST (POST services/data/v64.0/actions/custom/flow/<ApiName>, body {"inputs":[{}]}) fails the interview and Salesforce KEEPS it as a FlowInterview (so REST-invoked autolaunched failures are saved; each also sends the standard flow-error email). Each deploy of a changed flow with status Active makes the previous version Obsolete; status Draft adds a draft above the active one. Source + rebuild notes + what Field Cleaner should offer: docs/fixtures/field-cleaner-fixture/README.md. NOT yet run through Field Cleaner by anyone. ALSO: the user pressed Match review from my duplicate-fix list and got an empty dialog - Match review pairs UNMATCHED rows (missingInTarget vs onlyInTarget) and the scan had none; already-matched duplicates cannot be re-paired. sftkRecDupsHtml now shows that step's button only when BOTH unmatched buckets hold rows (with both counts), otherwise it says why pairing by hand is not possible and points to merge / unique match key. Both fixtures live on npc; the trial expires around 2026-09-22 per my earlier note - if it does, the fixtures must be rebuilt in another org.

**2026-09-21 late — Field Cleaner flow surgery grew a preview and a choice; parents card round 2 (gate 85 files / 2520 tests, packed 63 files / 1056 KB, smoke 1/1/1; uncommitted):** (A) WORDING: a flow interview is not always paused - sftkFlowInterviewKinds / sftkFlowInterviewWords (pure, sftk-flowsurgery.js) read FlowInterview.InterviewStatus (Error = failed); confirm lines, the interviews dialog and the done-label say "N flow interview(s) (x paused, y failed)" and what deleting each kind costs. The lookup never filtered by status, so failed ones were always found. (B) KEY FINDING: removeFieldRefs deliberately does NOT touch Decisions, formulas or free text. On a mixed flow the run used to deploy a new active version that STILL mentioned the field, delete the old one, and only then set stillMentions. (C) PREVIEW (user: "visualize what he is about to delete" / "reconnect it himself in the flow builder, highlighted somehow"): pure sftkFlowRefScan (skips label/description/interviewLabel - a field name TYPED into a description is not a dependency; flowReferencesField now uses it via _fieldStringTester, which removes a false "still references" forever), sftkFlowRefWhere (Flow Builder words: Decision "Check Status" - outcome "Is New" - condition 1), sftkFlowRefPreview(before, after, isRef) -> removed / remaining / emptied. fixFlowPlan builds it by running the REAL removeFieldRefs on a clone, so preview and run cannot disagree. Flow Builder cannot be driven or highlighted from outside - the manual route names each element by label + API name (Toolbox -> Manager search) and links to the version. (D) CHOICE (user: "select if the active version is also deleted or only the field ref is deleted"): sftkFlowSurgeryPlan(versions, refs, {activeMode:'delete'}) -> mode 'active-delete' (deactivate via FlowDefinition Metadata.activeVersionNumber = 0, re-read, refuse if anything is still Active, then interviews, then versions; same toDelete set so the same interviews). Dialog radios: "Keep the flow running" is offered only when the preview has something to remove; otherwise NOTHING is pre-chosen and the button stays disabled until the ack is ticked AND a way is chosen. (E) VERIFIED on the live fixture v3 (metadata fetched from npc, real remover): comes out = Assignment line + Create Records field value; stays locked = 2 Decision conditions; left empty = both of those elements -> "keep the flow running" will likely be refused by Salesforce for the fixture; the dialog says so beforehand. NOT yet clicked through in the extension by anyone. (F) PARENTS CARD round 2 (live screenshot: sent to "deploy Individual first" with 0 Individuals in BOTH orgs): sftkParentOrderFor adds srcCount per parent object (one COUNT()); sftkParentStepState returns 'notneeded' when the source has none, and the run gate ignores such objects; alignment is checked ON LOAD only when srcCount <= SFTK_DEPLOY_AUTOCHECK_MAX (5000), bigger ones show "N records - Check now"; pure sftkDeployParentsVerdict feeds a chip in the card title AND in the page header (#dsDepParentsChip) so aligned / not aligned is visible at first sight; a parents-first step now has "Back to <origin deployment>" as its header back link and a primary button in the journey banner. WAS PENDING, now BUILT (see the 2026-09-21 night entry): (1) create the SFTK_ID__c identity field from the page for every object of the selected tree (recipe exists only in the held-back Seeder: sftkSeedIdDeploy - field Text(18) External ID unique case-sensitive + permission set SFTK_Identity assigned to the running user, typed confirm for prod/unknown; EntityDefinition.IsCustomizable verified on npc as the way to know which objects accept custom fields; the missing-field probe error is INVALID_FIELD "No such column"); (2) a VISUAL TREE of the deployment (the user sees Data Deployment as the tool for "defining cross org data").

**2026-09-21 night — identity for a whole tree + the visual tree (gate 85 files / 2527 tests, packed, smoke 1/1/1; uncommitted; NOT yet clicked in the extension, and the field-creation deploy has NOT been run against an org from this code):** user: "we should offer the field creation and do it ourselves for the selected trees. i see data deployment also as a tool for defining cross org data. and than the user should be presented with the trees also in visual way". FINDING: the only code that could create SFTK_ID__c lived in the Org Seeder (sftkSeedIdDeploy), which the store build holds back - the shipped product could not create the field at all. NEW, shipped, in studio-reconcile.js: sftkIdStatusFor(p) (per object of the tree x both orgs: 1-row probe SELECT SFTK_ID__c -> yes / no on INVALID_FIELD / unknown, plus EntityDefinition.IsCustomizable); sftkIdDeployTo(orgUrls, objects) - same recipe and gates as the Seeder (typed confirm for production or unknown BEFORE the zip is built; field Text(18) External ID unique case-sensitive; permission set SFTK_Identity; assign to the running user; already-assigned = success), generalised to many objects, and the permission set is deployed with every object it ALREADY covers in that org (SELECT Field FROM FieldPermissions WHERE Parent.Name = 'SFTK_Identity') so one tree never narrows another; clears _describeCache; sftkOpenIdentityModal(p, scan) - table object x source / target / matched pairs, Stamp N per object (through a view so child nodes named by childSObject work with reconcileStampPairs), target ticked by default, SOURCE opt-in (needed when that org is later a source, or for back-pulls), duplicate-name warning before stamping. Pure sftkIdCreatable(objects, side) in sftk-identity.js (missing AND customizable; unknown is never created blind). reconcileStampPairs now opens that dialog when it finds no field; sftkIdHowToCreate leads with it. The Seeder's own copy was left alone (pinned by test B2, not shipped) - a later cleanup can make it delegate. VISUAL TREE: Deploy view card "This deployment" above the plan (pure sftkDeployTreeNodes; CSS connectors, left to right): per object - via <link field> / root, "recognised by <match key>" from the scan that was actually used, identity pill per org, "N to act on" / in sync / unknown, and "points at" chips from the parents data (dashed; red when the target has none, dim when the source has none). Click a node = select that object in the records panel. Footer: Identity button + a line naming the objects that cannot be recognised exactly yet. The tree repaints itself when identity status and the parents data arrive. scripts/dev/deploy-preview.mjs now renders a 4-object tree.

## 3. Where the session stopped / next step (FIRST session — historical)

A **full bug + regression audit** was running (five reviewer agents, one per
area). Three reported; all their findings were verified against the code and
are REAL but **NOT YET FIXED**. Two reviewers (Studio core/scan/transfer and
Studio reconcile/rollback/history) were cut off by rate limits and never
reported.

### Verified, unfixed findings — fix these first

**background.js**
1. **CRITICAL** `background.js` ~L2381: on `SESSION_EXPIRED` the retry calls
   `getSfSession(message.orgUrl)`, which falls back to ANY open org tab — a
   WRITE (collections create, PATCH, metadata deploy…) can be re-dispatched
   against a DIFFERENT org. Fix: retry only when
   `sftkOrgKey(fresh.orgUrl) === sftkOrgKey(message.orgUrl)` (or use
   `sftkCookieSessFor(message.orgUrl)`), else rethrow.
2. **HIGH** ~L1543: upsert-key injection in `sendChunk` overwrites the identity
   stamp when `upsertField === node.stampField` (Seeder with SFTK_ID__c as
   match key). Fix: skip injection when `upsertField === node.stampField`.
3. **HIGH** ~L946 / `fetchByIdChunks` ~L899 / `getScopeIds` ~L756: only the
   root REST read checks `.incomplete`; child chunk reads, picked-id reads and
   scope prefetch deploy from partial pages silently. Fix: throw/refuse on
   `r.incomplete` in all three.
4. **MEDIUM** ~L3492: metadata deploy poll uses raw `sid`; a 401 mid-poll
   throws SESSION_EXPIRED → whole message retried → zip deployed TWICE. Fix:
   poll via `sfFetchWithProxy` or refresh sid and keep polling the same jobId.
5. **MEDIUM** ~L2145 `sftkWipeObject`: ignores `q.incomplete`, reports a full
   wipe over a partial Id read. Fix: refuse when incomplete.

**dependency-map.js**
6. **CRITICAL** ~L3732 `applyApiVerChange`: reads batch items as
   `items[i].result || items[i]` but SF_COMPOSITE_BATCH items are
   `{ok,status,body,…}` with the record in `body` → every ⚙ apply fails with
   "could not be read"; feature is dead end-to-end. Fix: `const rec = it && it.ok
   && it.body && typeof it.body === 'object' ? it.body : null`.
7. **HIGH** ~L3182 ⏻ Flow switches: production writes behind plain
   `window.confirm()`. Fix: in-panel typed confirmation (type OFF / ON) like
   the ⚙ panel's CHANGE gate.
8. **MEDIUM** ~L2967 / ~L3241: "This org" carries `sid: _scanSid`, which is
   '' whenever the dependency scan did not run (large orgs) → validator
   rejects every call for the current org. Fix: pass `sid` into
   `renderDependencyTreeTab(allFlows, container, orgUrl, sid)` from both
   popup.js call sites (~L2766, ~L2779), keep `_lastSid`, use
   `_scanSid || _lastSid`.
9. **LOW** ~L2490: 🔒 managed nodes ignore the process-type filter buttons
   (only `allNodes` closure is dimmed). Fix: dim via
   `treeContainer.querySelectorAll('.dep-node[data-process-type]')` and apply
   the stored filter in `paintManagedSection`.

**sftk-terms.js / popup.js / field-cleaner.js**
10. **MEDIUM** `sftk-terms.js` ~L202–204: Decline → "Read the terms again" →
    Accept never unblocks the page, because `resolve(false)` already fired.
    Fix: do not resolve on Decline; leave the promise pending.
11. **MEDIUM** `popup.js` ~L803: `SF_SESSION_REFRESHED` listener re-boots the
    popup after the licence was declined. Fix: `_termsOk` flag set after the
    gate; guard the listener.
12. **MEDIUM** `field-cleaner.js` ~L2091/2144: XML inspector's ✂ button (class
    `fc-fix-btn fc-xml-fix`) survives `markFixed`, so "Delete Field" never
    re-enables. Fix: remove it in `markFixed` or scope the count to
    `.fc-item .fc-fix-btn:not([disabled])`.
13. **LOW** `field-cleaner.js` ~L3110–3120: delete-error text still says
    reports "aren't scanned". Update to match `_unscannedNoteHtml`.
14. **LOW** `field-cleaner.js` ~L2022: Report/Layout/FlexiPage fix confirm
    says "there is no undo" though a restore point is saved. Branch the text.

### Then
- Re-run the two cut-off reviewers (Studio core/scan/transfer;
  reconcile/rollback/history/other views) — or re-review those areas.
- `npm run verify` → `npm run pack` → headless boot smoke:
  `chrome.exe --headless=new --disable-gpu --dump-dom file:///…/dist/store-staging/popup.html | grep -c "I confirm that any consequence"` (expect 1 for popup, studio, apex-log-viewer).
- Update `project_sf_flow_cleaner.md` memory.
- **Commit** only when the user says "commit it" (never said yet).

---

## 4. Open issues to be careful about

- **Nothing from this session has been run live in an org.** Rollback, managed
  flows, API-version change, licence v2, reports — all code-reviewed and
  unit-tested only. The rollback live test needs the user to run
  `sf org login web --alias ashkenazy6` and `--alias ashkenazy7`, then
  `sf data import tree` of `harness/rollback-fixture/*.json`, then the runbook
  in `harness/rollback-fixture/README.md`.
- **Claude cannot drive the extension UI** on this PC (Chrome tools cannot open
  `chrome-extension://` pages; computer-use cannot click browsers). The `sf`
  CLI works (only org alias `npc` is authenticated). See memory
  `ref_live_testing_limits.md`.
- ~~The ⚙ API versions Apply is currently broken (finding 6)~~ FIXED 2026-09-12.
- ~~⏻ Flow switches can write to production with one OK click (finding 7)~~ FIXED
  (typed OFF/ON in-panel).
- ~~SESSION_EXPIRED retry can write to the wrong org (finding 1)~~ FIXED (org-pinned).
- IndexedDB `sftk_undo` is now schema **v2** (groupId index); an existing v1 store
  upgrades in place on first open.
- **Org Seeder** is excluded from the store build on purpose (`HELD_BACK_JS`);
  it still loads in the dev (unpacked) build.
- **Main dependency map cannot read managed flow contents** — Salesforce hides
  them from every API (verified live, both directions of the dependency
  index). This is disclosed in the UI, not fixable.
- **`sftk-mdapi.js`** (SOAP metadata primitives) is built but intentionally
  unused (latest-tech rule). Connected App retrieve→deploy provably fails on
  the globally unique consumer key; integration-metadata UI not built.
- **User asked for a Dependencies page UI redesign** ("hard to understand");
  plan was: mockup first, then code. Not started.
- Tests pin source TEXT heavily (regex on code). When refactoring, expect pins
  to break; update the pin, don't weaken the law it encodes.
- Python patch scripts: write to the scratchpad with the Write tool, run with
  a short Bash call; atomic write via tmp + `os.replace`; repair surrogates;
  keep CRLF for `studio-profiles.js`.
- Store: update the EXISTING listing (do not create a new item); versions must
  ascend.
