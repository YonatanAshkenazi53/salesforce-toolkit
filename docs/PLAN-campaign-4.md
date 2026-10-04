# Campaign 4 — Data Deployment, simpler (written 2026-10-01)

Born from the user's hand test of the Deploy page on 2026-09-30 / 10-01. The verdict, in the
user's words: "it feels like it's too complicated and not intuitive … hard to understand and not
flexible enough"; "the ring thing is too complicated — profiles get broken when we change a
source"; "I'd like to see real-time processing, to see them run live like in Inspector". Six
proposals were made; the user took all of them ("i take all ur suggestions").

Same gate as every campaign: `npm run verify` (EXIT CODE — a chain that does not stop on it
pushed a red build once, 2026-10-01), `npm run pack`, headless boot smoke 1/1/1, a live run of
what the phase touches, commit, push. Model split as always: Fable builds the primitive and
the first migration and runs everything live; Sonnet repeats patterns under test lock and writes
prose. Never Opus.

Org note: the user's hand tests ran reversed (trailheads4 → trailheads5) and inserted volume and
sample-account copies into trailheads5, the fixture SOURCE. Before any live run of phases 1, 4
or 5: `bash docs/fixtures/rebuild-source.sh npc` (after the user has finished looking), and
reset the target with cleanup.apex + seed-target.apex.

---

## Phase 1 — a live run view, Inspector-style

**DONE 2026-10-01** (commit follows): `sftk-run-progress.js` — pure reducer `sftkRunProgressReduce` + formatter `sftkRunProgressCardText` + painter `sftkRunProgressHandler`; Deploy (runReconcile), Transfer, Sequences and the Seeder all wire it; `_trProgressHandler` / `_trRenderBulkRow` / the studio-scan text handler removed. Cards: bar + red failure segment, written/created/failed, elapsed, rate, ETA, batch n of N, Bulk job state + "Salesforce last answered Xs ago", a 1 s ticker while anything is alive. Test `run-progress-1001` (scripted event sequences, fake clock, wiring). Rendered in the harness with the engine's real event shapes (dark). Live run against a Bulk-sized tree deferred until trailheads5 is rebuilt (the user's reversed runs are still writing into it).

**Problem.** On the Deploy page a 5,000-record write sits on "Account: 5000 record(s) fetched —
writing…" for minutes. Root cause found: `runReconcile` wires the RAW `_runProgressHandler`
(studio-scan.js), which ignores `phase:'bulk'` (the Bulk API 2.0 job poll — state, processed,
failed, every 1–5 s) and `phase:'errs'` (the real-time error feed). Only the Transfer page's
wrapper `_trProgressHandler` renders them. Collections runs do update a text line per batch of
200, but there is no bar, no rate, no time.

**Build.**
1. One progress handler for both pages (`sftk-run-progress.js`, loaded by studio.html): bulk,
   batch, fetched, node, step, errs, hb all rendered. Deploy and Transfer both use it.
2. Per object, a live card instead of a text line: a progress bar (done / total), created and
   failed counters, elapsed, records per second, ETA from the rate, the current batch ("batch
   12 of 25 · 200 records"), and for a Bulk job its state plus "Salesforce last answered Xs
   ago" so coarse progress reads as alive, not stuck.
3. The error feed stays as it is (red rows as they land), notes grey (`_recLogEngineLines`).
4. Heartbeat (`hb`, every 20 s) drives the elapsed clocks when no other event arrives.

**Enforce.** A test that both pages wire the shared handler and that no page keeps a private
one; a behavioural test feeding a scripted event sequence into the handler against a jsdom
element and asserting the bar, counters and ETA text.

**Live.** `onepass-tree.mjs` with the volume tree (`vol3`, ≥ 2,000 rows → Bulk) and the CX
tree (< 2,000 → Collections): both cards animate; a run with a deliberate refusal shows red rows
as they land.

**Size.** 1 day.

## Phase 2 — orgs are picked when you deploy; the ring and the crown go away

**Decided 2026-10-01 (user: "maybe profile should run and compare just between all open orgs in
the browser, u select the source and the targets already auto calculate by that" → "sounds
good").** This replaces the earlier Phase 2 (crown behind a confirmation) AND the earlier
Phase 5 (From/To at deploy time); both are folded in here.

**Problem.** A deployment owns its orgs or follows the ring's crown. Switching the top-bar
SOURCE menu crowns an org, re-points every following deployment, marks their scans stale and
rescans them all — and breaks the ones whose root object the new source lacks. An expired org
leaves a deployment "broken". The user read the menu as "which org am I looking at".

**The model.**
- A deployment is a SHAPE: objects, filters, fields and mapping, matching, lookups, engine
  options. It never owns orgs. `sourceOrg` / `targetOrg` stay on the record only as "last used".
- The Deploy page lists the orgs OPEN IN CHROME right now. The user picks the source (default:
  the last used one, if open). The other open orgs are the possible targets — checkboxes,
  NOTHING ticked (the user's law). One target at a time is worked on (scan, select, deploy);
  several ticked = the same page per target, one after another.
- An org that is not open is not offered. A saved deployment is never re-pointed, never stale,
  never broken: it says "open the orgs to run it".
- Production stays guarded: an org being open is not consent to write into it — the typed org
  name gate is unchanged.
- The Sync Ring page becomes "all open orgs at a glance": the same matrix and scans across the
  open orgs with a per-page source pick; no membership to configure, no crown, no re-pointing,
  no automatic rescans. History and match memory already key by pair.

**Build (in this order, each step gated and pushed).**

**Step 4 DONE 2026-10-01** (commit follows): `openReconcile(profileId, targetUrl)` moves the deployment's pair instead of cloning (`pair_` + the target chooser are gone; same-org refused with a toast; the old ring fields deleted on the way); the `_ringOf` branches in studio-scan / studio-reconcile stay only for the Org Seeder's `seedpair_` clones (held back from the store). Pinned in `open-orgs-model-1001`; three obsolete chooser pins retired from `ui-studio`.

**Steps 3 + 5 + 6 DONE 2026-10-01** (commit follows; Fable core + Sonnet sweep, Fable review + live): no crown anywhere — `_ring` is a derived view (`sftkRingView`: preferred source + other open orgs), `currentSourceOrg()` = the last pick, `dsSetPreferredSource` re-points nothing; `syncRingFollowers`, `dsSetSourceOfTruth`, `sftkRingRebaseline`, the ring membership / crown history / scheduled drift probe (background `SF_SET_RING_SCHEDULE` / `SF_RUN_RING_PROBE`), `sourcePinned` / `targetOrgs` / `_srcCrownMoved` writes, the Builder lock / pin / 👑 promote and the 👑 dropdown suffix are gone; the top bar shows a read-only "N orgs open" chip; the ring page is "All open orgs" (source select `#dsRingSrc`, columns = other open orgs, ⚖ sets the pair on the SAVED deployment and opens it — no clone); the Builder has two plain selects (source, default target). Tests rewritten (`ui-studio` ring blocks, `ent-profile-io`, `pure-functions`, …) + new `open-orgs-model-1001`. Live in the harness with both orgs: chip "2 orgs open · trailheads5 · trailheads4"; All open orgs → pick trailheads5 → 🔎 scan the Accounts tree cell → ⚖ → the Deploy page on the saved deployment, trailheads5 → trailheads4, picker on top. Left for step 4: `openReconcile`'s `pair_` clone for a non-primary target and the `_ringOf` branches in studio-scan / studio-reconcile.

**Step 1 + 2 DONE 2026-10-01** (commit follows): `sftkOpenOrgs()` in studio-core.js; `sftkDeployOrgPicker` (pure) + `_depOrgPickerHtml` / `_depSetPair` / `_depWireOrgPicker` in studio-deploy.js — the picker on both Deploy page branches; the pick saves the pair as last-used and (until step 3) pins both sides so the ring plumbing cannot re-point it. Test `deploy-org-picker-1001`; live in the harness with both orgs logged in (`picker-live.mjs`, scratchpad): both orgs offered, ⇄ swap saved and the page asked to read the new pair.
1. `sftkOpenOrgs()` — one function both pages use for "orgs open in Chrome" (label, url, key,
   sandbox/production flag), from the sessions the background already lists.
2. Deploy page: the org picker at the top (From · To). Picking sets the deployment's pair for
   this session and saves it as last-used; `lastScan` comes from the pair's cached scan when one
   exists (the `ringScans` map, renamed `pairScans`), else "Read both orgs". Nothing else on the
   page changes yet.
3. Remove the crown: the top-bar SOURCE menu, `dsSetSourceOfTruth`, `syncRingFollowers`,
   `sftkRingRebaseline`, `sourceFollowsRing` / `sourcePinned`, ring membership, crown history.
   Deployments that followed the ring keep their last pair as defaults — migration = none.
4. Remove the pair clones: `openReconcile(profileId, targetUrl)` sets the pair on the profile
   instead of cloning (`pair_…`, `_ringOf`); the parents-first step keeps its `_parentOf.profile`
   (already there). Org Compare keeps its own ephemeral profile (it is not a deployment).
5. Sync Ring page → "All open orgs": source pick on the page, matrix across the other open
   orgs, 🔎 Scan all on demand, tiles open the Deploy page with that pair set.
6. Builder: the source column locks onto the picked source (it used to lock onto the crown).

**Enforce.** `test/open-orgs-model-*.test.mjs`: no code path creates a `pair_` clone or reads
`_ring.sourceUrl`; the Deploy page never pre-ticks a target; `scan-e2e` on two pairs of the
canned world from one saved shape; every existing ring test rewritten against the open-orgs
matrix (list in the recon report).

**Live.** CX tree trailheads5 → trailheads4 from the picker; then the same saved shape with
trailheads4 as source (after rebuild-source.sh) — no clone, History shows both pairs, rollback
per pair; close one org's tab → the picker drops it, nothing breaks.

**Size.** 4–6 days. The engine is untouched; the risk is the page + profile model, netted by
the live scripts and the canned tests.

## Phase 3 — the words

**Problem.** Ambiguous, pair, insert as new, parents first, crown, ring, ephemeral, Match
review, Identity: the user "will have no idea what it means". The ⚠ Ambiguous tab was fixed
on 2026-10-01 (intro + plain labels); the rest of the page still speaks engine.

**Build.** One glossary (docs/GLOSSARY.md, the public FEATURES.md follows it), then the pass:
- "⚠ Ambiguous" → "Needs a decision"; "In target only" → "Only in <target>"; "Changed" →
  "Different"; "Synced" → "Same in both"; "Insert" → "Missing in <target>".
- "Parents first" → "Records these depend on"; "parents ready ✓" → "nothing to deploy first".
- "Sync Ring" → "All orgs" with a one-line description; "source of truth" stays, explained once
  on the ring page; "crown" never appears in the UI.
- Every tab and card gets a one-sentence "what this is" line like the ⚠ Ambiguous intro.
- Toasts and run-log lines: no SOQL, no API names where a label exists, the org named every time.

**Enforce.** A test that the retired words do not appear in UI strings (allow-list for code
comments and the engine).

**Size.** 1 day (Sonnet, test-locked; Fable reviews the Deploy page wording).

## Phase 4 — ⏸ pause validation rules during the run

**DONE 2026-10-03** (commit follows): `sftk-vrpause.js` (`sftkVrPauseSelect` pure · `sftkVrPauseList` — one Tooling query + one GET per rule for its Metadata · `sftkVrPauseOff` / `sftkVrPauseOn` through `sftkWriteVerifiedAll` with one re-read · memory `sftk_vr_run_paused` · History journals with undo steps). Deploy page: `#dsDepRulePause` + list + leftovers banner (`_depRulePauseWire`, `_depRuleLeftovers`); `_depReconcile` wraps the run — rules go off AFTER the flows and back on BEFORE them, a finally is the safety net; `runReconcile` takes `opts.rulePause` (`_vp`) into its ONE confirmation. **Only the objects in use** (user: "only for the used objects"): `sftkDeployWrittenObjects(objects, _recSel, _recChildSel)` = objects with a selection + their ancestors; rules AND flows are narrowed to them, the confirmation names the rules that stay on. Verified first by CLI that a Tooling PATCH of the rule's own Metadata with `active:false/true` switches it. Live (`scripts/dev/live/vrpause.mjs`, trailheads5 → trailheads4): root inserts only → confirmation "switch OFF 1 validation rule … Rules on objects this run does not write stay ON: SFTK_CX_Lab_Lead_Needs_Phone (Contact)" → 7 of 7 Accounts inserted (the rule normally refuses one) → rule back ON by CLI, memory empty → ↩ rollback clean (4 accounts). Tests `vrpause-1003`. Not yet: the Org health leftovers card counts flows only.

**Problem.** Duplicate rules can be bypassed with Salesforce's header
(`Sforce-Duplicate-Rule-Header: allowSave=true`; Bulk 2.0 cannot, so a bypass run uses
Collections). Validation rules have no header. The user asked for a switch.

**Build.** The `sftk-flowpause.js` pattern, for ValidationRule:
1. `sftk-vrpause.js`: list active rules on the objects in the run (Tooling
   `ValidationRule` with `Metadata`), switch off via Tooling PATCH `Metadata.active=false`
   (`sftkMetaForPatch` strips nulls), remember in `sftk_vr_run_paused` (PRIVACY.md line), switch
   back on after the writes, verify by re-read; leftovers → the Deploy page banner and the Org
   health leftovers card.
2. Deploy page: a second ⏸ checkbox "pause validation rules on these objects during the run",
   nothing pre-selected. The ONE confirmation says, plainly: while the run writes, these rules
   are off for every user in <target>, not only for the Toolkit; names the rules.
3. History: the pause/unpause as part of the run entry; ↩ undo re-activates anything left off.

**Enforce.** write-discipline / confirm-discipline / history-discipline baselines stay zero;
engine test on the canned world: rules off before the first write, on after the last, on
again after a thrown error.

**Live.** The fixture's two validation rules on trailheads4 (Retail without Website, Lab lead
without Phone): with the switch on, both records land; CLI shows the rules active again after.

**Size.** 1 day.

## Phase 5 — (folded into Phase 2 on 2026-10-01)

From/To at deploy time is the core of the new Phase 2; nothing separate remains here.

## Phase 6 — the Deploy page in three steps

**Problem.** Tree, identity, two-org table, parents-first, advisor notes, tabs, engine options
and the run log all compete on one screen.

**Build.** 1) Orgs — From → To and "Read both orgs". 2) What differs — the table and the record
tabs; tree, identity and dependencies fold under "Details". 3) Deploy — selection summary,
options (duplicate rules, ⏸ flows, ⏸ validation rules, restore point), the one button, then the
live run view (Phase 1) in place. The advisor notes become one "Before you deploy" block.

**Size.** 2 days. Last, because Phase 5 changes step 1.

---

## Phase 7 — Roll back is a page, and it says who

**DONE 2026-10-02** (commit follows): studio-undo.js split into `sftkUndoLoadRun` / `sftkUndoBuildPlan` / `sftkUndoExecute` (DOM-free, `io.log/alive/progress`; items carry `nowById`, `personIds`, `key`; picks `{del,res,force}` per item; results carry `deletedRecords` / `restoredRecords` by name, capped 5,000); `studio-rollback.js` = view `rollback` (plan mode: intro, per-object table, automation per org, "how this plan was built" log, tabs To delete · To restore (▸ before ↔ now) · Kept ("delete anyway" per record) · Left alone · Not restorable, filter + Show more, one shared confirmation, live run view, result card; report mode from the History card's 📋 Which records). Live (`onepass-tree.mjs`, trailheads5 → trailheads4): CX tree deployed, ↩ from History → page → confirm → every object ✓ verified, 0 errors, CLI back to 4 · 2 · 0 · 0; the report named the records; `UNTICK_ONE=1` kept one CaseComment on purpose and the CLI agreed. Found and fixed on the way: `CaseHistory2` (Lightning case history) was not in the cascade skip list and cannot be filtered by CreatedDate → the planner kept all 4 Cases → Salesforce refused to delete 3 Accounts + 1 Contact "associated with the following cases"; now skipped, the classifier knows Salesforce's "can not be filtered", and the plan page warns when kept records can block their parents. Still to do: `scripts/dev/live/sequences.mjs` drives the old modal ids — move it to the page flow like retry-and-rollback.mjs.

**Asked 2026-10-02 (user): "The rollback screen is not great. we should make it open a reconcile
screen, like the deployment screen, with all the features there." and, on the History card
("Contact · 1250 deleted ✓ verified"): "there's no info on the operation, who got deleted, etc".**

**Problem.** ↩ Roll back opens a modal: a progress log, a per-object plan in one line each
("delete 812 not in the restore point · restore 2 overwritten · 5 kept …"), a typed word, Go. No
record is named before, and none after: the History card keeps counts only.

**Build.**
1. Split studio-undo.js: `sftkUndoBuildPlan(run, ev, io)` (steps 1-2 of today's `rollbackRun`:
   sessions, locks, org type, automation, re-read, diff, scope-by-time, person contacts, cascade
   checks — DOM-free, `io.log` / `io.alive` callbacks) and `sftkUndoExecute(ctx, picks, io)`
   (step 4: deletes, restores, verify, History record). `rollbackRun` becomes the page's opener.
   Plan items carry the RECORDS, not only ids: for "created → delete" the current rows (Name /
   key fields), for "overwritten → restore" the before-image row and the current row with the
   differing fields; kept / left-alone / not-restorable rows likewise, with their reason.
2. A view `rollback` (studio-rollback.js, Deploy-page pattern): header "↩ Roll back — <deployment>
   · <org> · run <when> · restore point <when>"; "What the run did" table per object (delete /
   restore / kept / left alone / deleted-since / untouched); tabs per object with buckets
   **To delete** (created by the run), **To restore** (overwritten; ▸ record opens the field
   compare before ↔ now), **Kept** (reason; "delete anyway — I checked" per record where the
   children could not be read), **Left alone** (created or edited after the run), **Not
   restorable** (deleted since; hard-deleted). Rows: name, what happens, links to the record.
   Checkboxes on To delete / To restore, ALL TICKED by default — a rollback's purpose is
   everything the run did; unticking is the exception (said in the intro). The automation card
   (validation rules, triggers, flows that can refuse or re-fire) stays, as a card.
3. ONE confirmation through `sftkConfirmDestructive` (word ROLLBACK, typed org name for
   production / unknown), then the live run view (`sftkRunProgressHandler`) in place — the
   execute path posts per-object fetched / batch events like the engine does.
4. The record: the rollback's History entry keeps per object `deletedRecords` / `restoredRecords`
   / `failedRecords` as `{ id, name }` (restored: + the fields put back), capped at 5,000 per
   object and said when capped. The History card's "1,250 deleted" opens the rollback page in
   REPORT mode: the same tabs, read-only, every record named, soft-deleted ones linking to the
   target's Recycle Bin, with the verification per object.
5. Undo of tool writes (History › tool cards) keeps its dialog — one record, one line.

**Enforce.** `test/rollback-page-1002.test.mjs`: the planner is DOM-free (no `eid(`/`document.`
inside `sftkUndoBuildPlan` / `sftkUndoExecute`); items carry rows; defaults all ticked; the one
confirmation; the History entry carries named records; the card opens the report. Existing
rollback tests (`undo-*`, `rollback*`) keep passing against the extracted functions.

**Live.** The CX tree run (7 inserts) then ↩ on its History card → the page lists the 7 created
Accounts by name under To delete, the 1 updated under To restore with before ↔ now; untick one
Account → it survives (CLI); the report names the six deleted and the one restored; the Recycle
Bin link works. Then the volume run (6,000) for the window and the cap note.

**Size.** 2 days. Fable (undo engine, the page's selection → plan); Sonnet may do the report
mode's markup once the data contract exists.

## Phase 8 — Field Cleaner: a way back for a deleted field

**Asked 2026-10-02 (user): "deleted a field. dont see any history and rollback here. maybe we
should give a feature to restore the field from the recycle bin + redeploy all the related
metadata we removed?" → proposal accepted 2026-10-03 ("ok good").**

**Verified live 2026-10-03 (trailheads4, fixture field SFTK_FC_Test_Status on Account):**
- Salesforce has NO API to undelete a custom field. A deleted field stays a Tooling `CustomField`
  row with the SAME Id, renamed `X_del` / `X_del1` / … and is absent from describe.
- The classic page `/p/setup/layout/DeletedFieldList?type=<Object>` lists them; each row's
  Undelete link carries a one-time `_CONFIRMATIONTOKEN`, so a direct link to the Undelete action
  cannot be built ("Unable to Access Page") — the deep link goes to the LIST, the user clicks
  Undelete once (no further confirmation; an "Undeleted a Custom Field" page follows).
- After Undelete the field is live as `X_del__c` (same Id). A Tooling PATCH of
  `{ FullName: '<Object>.X__c', Metadata: <its Metadata, nulls stripped> }` renames it back
  (HTTP 204; describe then shows `X__c`). `{ DeveloperName }` alone is refused
  (REQUIRED_FIELD_MISSING: Metadata).

**Build (popup → Field Cleaner).**
1. `sftk-fieldrestore.js` (pure): `sftkFieldRestoreState(logEntry, toolingRow, liveNames)` →
   `in-bin` | `undeleted` (live under a `_del` name) | `restored` | `gone` | `expired`;
   `sftkFieldRestoreRenameBody(toolingRecord, object, field)` (uses `sftkMetaForPatch`);
   `sftkFieldRestoreListUrl(orgUrl, objectApiOrId)`.
2. A "🗑 Deleted with the Toolkit — the way back" panel in the Field Cleaner tab, from
   `sftk_fc_deletion_log` for this org: per field its state and the ONE next step —
   ① Open Deleted Fields (new tab) + "click Undelete next to <label>" → ② "I undeleted it —
   check" (re-reads Tooling + describe) → ③ "Rename back to X__c" (one confirmation, verified
   write, History journal) → ④ the related Field Cleaner History entries for that field (flow
   fixes, stripped field security, report columns) listed newest first, each with its own
   ↩ Undo (the existing History undo; nothing new in the engine).
3. The delete's History entry and the "Field deleted" card point at the panel.
4. Honest limits, said on the panel: 15 days; the field's place on page layouts and anything
   Salesforce itself dropped at delete time is re-checked and listed, not assumed; `gone` =
   erased or past 15 days → recreate from the saved definition is a later item.

**Enforce.** `test/field-restore-1003.test.mjs`: the state function on every combination; the
rename body strips nulls and names the full name; the panel never offers rename before the
field is live, never offers undo before it is renamed; write/confirm/history disciplines stay
at baseline zero.

**Live.** `scripts/dev/live/field-restore.mjs`: delete the fixture field with the Toolkit →
panel says in-bin → (harness clicks Undelete on the list, standing in for the user) → check →
rename → CLI describe shows `SFTK_FC_Test_Status__c` → undo the flow fix from the panel → CLI
shows the flow version active again.

**Size.** 1 day.

## Phase 9 — "Needs a decision": the ambiguous page, decidable

**DONE 2026-10-03** (user: "we need to make the ambigious page more understandble"). The
2026-10-01 fix was words (an intro, plainer labels); with 350 rows of "Same as #1 · Same as #2 ·
Same as #3" over records that look identical, words were not enough. Now:
- `sftkAmbiguousInsight(groups, fields)` (sftk-matching.js, pure): per group, which compared
  fields tell the copies apart, and the pairs ONE field proves (one distinct non-empty value per
  copy on each side, the same value on exactly one copy across) — never a "new" suggestion.
- The scan (studio-scan.js) annotates each ambiguous row with `tell` / `suggest` / `suggestBy`,
  stores `ambiguousCand` (telling values per candidate target record) and `ambiguousAdvice`.
- The tab is "⚠ Needs a decision" (bucket key unchanged): groups by the shared name, numbered
  target records with their telling values, ONE select per source record (it is #n · it is new),
  suggestions pre-filled and labelled with the proving field, "📌 Apply N decisions" (nothing
  remembered before; two source records cannot claim one target record). `_depAmbGroupsHtml`,
  `_depAmbPick` in studio-deploy.js.
- Tests `ambiguous-help-1001` (rewritten). Live (`scripts/dev/live/ambiguous.mjs`): the fixture's
  duplicate pair shows "BillingCity: Haifa / Eilat" against the target's "Target twin"; decide one
  → Apply → 8 · 2 · 2 · ⚠0 → deploy the other → CLI two records → ↩ rollback → one.
- Next step if wanted: "add <field> to the match key" as one button on the intro (today it names
  the field and points at ✏ Edit → Records → Matching).

## Phase 10 — Lightning Pages QA: the assignment model, rebuilt (DONE 2026-10-04)

Lightning Pages stays in 1.0, so it got the hand-level QA it never had. The first live step
(App Default on an unassigned page) made that page the org-wide Desktop default and then failed.
Everything below was then PROVED BY CLI on trailheads5 before any code changed.

**What Salesforce really does (the tool had all of this wrong):**
- App Default = an entry of `CustomApplication.Metadata.actionOverrides`. App + Record Type +
  Profile = an entry of `.profileActionOverrides` (an entry there without a profile is refused:
  "Required field profile"). The tool wrote app defaults into `profileActionOverrides`.
- The profile is its METADATA name (`Admin`, `Standard`), read with a single-row Tooling query
  (`SELECT Id, FullName FROM Profile WHERE Id = …`). The display name gives
  INVALID_CROSS_REFERENCE_KEY. The record type is `Object.DeveloperName`.
- A Tooling PATCH of a CustomApplication MERGES the two override lists (an entry left out stays;
  an entry is removed by sending `type: 'Default'` for its slot) and REPLACES every other field
  (omit `description` and it is cleared; omit `uiType` and the PATCH is refused). So a PATCH =
  the app's whole current definition (`sftkMetaForPatch`) + only the changed entry.
- `FlexiPage.Metadata` has no `pageAssignments` and no `publishStatus` (v62 and v64): a page's
  app-level assignments can only be read from the apps. There is no profile-only assignment
  without an app ("All Apps" was not a real option).
- An org default is cleared by deploying `type=Default` for the slot — which resets WHATEVER page
  holds it.

**What changed (lightning-pages.js; pure helpers at column 0, pins `test/lp-assignments-1004`):**
- Read model: `ensureApps` (Lightning `CustomApplication` rows), `ensureAppIndex` / `refreshApp`
  (`_appMeta`, batched; a failed read = `_appIndexErr` = assignments UNKNOWN),
  `profileFullName` / `profileNameOfFull` / `resolveProfileNames`; `lpAppAssignments`,
  `lpAppSlotHolder`, `lpAppHas`, `lpOrgSlotHolder`, `lpPageStatus`, `lpAssignmentWords`.
- `openDetail(page, errorMsg, note)` always shows what the org answers (no `assignmentsOverride`,
  no `publishStatusOverride`). Non-record pages: "Activation not read here", no form.
- Writes: `writeOrgDefault` (deploy + describe re-read, 8 x 2.5 s, shown; clearing only while this
  page holds the slot), `writeAppAssignment` (fresh app read, delta via `lpAppDelta`, re-read),
  `orgUndoStep` (History undo with a describe re-read). `doAdd(…, want, ctx)` = one confirmation
  naming every assignment and the page it REPLACES (`currentHolders`), one History entry; no
  pre-activation. `confirmRemove(…, idxs)` / `doRemove` serve ✕ and ⏸ Deactivate (= all).
  No Activate button, no "All Apps", no "Mark as Default".
- Clone: unticked "Also move the original's assignments to the copy" + the shared confirmation.
- `fetchUsers` returns `{ users, error }`; an error is shown with a retry.
- List Pass 3 and `scanAllPageAssignments` read app-level assignments from the app index; the
  audit covers record pages and says how many pages of other types are not in it.
- `sftk-history.js`: an undo step's `verify` may be a REST `path` (not only SOQL), with a list of
  `where` conditions and `retries` — that is how an org-default undo is re-read.

**Verified live (`scripts/dev/live/lightning-pages.mjs`, CLI truth after each step):** app default
on an unassigned page (org default untouched); app + record type + profile for Standard User and
System Administrator (stored as Standard / Admin; a person-account record type is refused by
Salesforce and reported per item); ✕ on one row; ⏸ Deactivate (4 removed, app clean, the OTHER
page's org default untouched); org default set over another page (dialog names it; verified);
History undo of an org default (verified by re-read); clone with move; affected users; the list
dots; the audit card with an app + profile row. Fixture: app `SFTK_LP_Test_App`
(`docs/fixtures/lightning-page-fixture`).

**Not reproduced:** the "Who sees what → Show users" HTTP 404 from the old bug note — the list
loads; a failing query shows a friendly error there.

**Left (backlog):**
- `fetchOrgDefaults` Pass 1 still does one Tooling GET per unmanaged page to read
  `pageAssignments`, a field that does not exist. It is harmless but wasted; removing it changes
  the quoted-cost arithmetic and its pins (`lightning-pages-scale`, `ent-quota-lp`).
- App-level undo from History (needs a safe way to write one entry without carrying a stale copy
  of the app's definition).
- Person-account record types (`PersonAccount.X`) in the App + Record Type + Profile form.
- Home / App page activation is not read.

## Phase 11 — Field Cleaner: replace a field with another one (DONE 2026-10-04)

User, reading the feature guide's Field Cleaner section: "what if we want to remove the old field
and assign a new field instead with the same type?" then "i want to add the replace field feature".

**What it is.** Step 3 of Field Cleaner, optional: "Replace it with another field". Empty = today's
behaviour (references are removed). With a field chosen, every automatic fix MOVES the reference.

**Engine: `sftk-fieldreplace.js` (pure, popup.html loads it before field-cleaner.js).**
- `sftkFieldReplaceCompat(oldDesc, newDesc)` - blockers (other type, other lookup target, a field
  the describe does not list) and warnings (missing picklist values, shorter, cannot be written).
  The picker offers only fields without a blocker, from the object describe (standard fields too).
- `sftkFlowReplaceField(metadata, obj, old, new, { chainOwner })` - walks every string the scanner
  walks (labels / descriptions skipped) and swaps a token ONLY when its object is known to be `obj`:
  `$Record` / `$Record__Prior` (start object), record variables, Get Records elements, loops and
  collection processors over those, a bare field name inside an element with `object` /
  `inputReference`, `Obj.Field`. A same-named field of another object -> `skipped` (why 'other').
  Unknown object -> `skipped` (why 'unknown'). A path through a relationship
  (`$Record.Account.X__c`) -> `needs`; field-cleaner.js resolves the chain against the describes
  (`_chainOwner`; a polymorphic or unreadable hop = not resolved = left alone) and runs it again.
- `sftkLayoutReplaceField` (new field takes the slot; already on the layout -> blank space;
  read-only field -> Readonly), `sftkFlexiReplaceField` (fieldItem, field properties, visibility
  criteria; a related record's field is left), `sftkRptReplaceField` (columns / filters / groupings
  in the token's own spelling; formulas and buckets stay manual), `sftkFlsCopyPlan` (create / raise,
  never lower; read only for a field that cannot be edited).

**Wiring in field-cleaner.js.** `_replField` / `_replCompat` / `_replOn()`; `setupReplacePicker()`
(`#fcReplStep`, `#fcReplInput`, `#fcReplDrop`, `#fcReplNote`, `#fcReplClear`); `_applyReplMode()`
relabels idle buttons (`_fixBtnLabel`: an inactive flow version stays "✂ Remove"), group notes
(`TYPE_CFG[*].replNote`), the `#fcReplBar` and the access panel; `fixOne` computes `swap` once;
flows: `_flowSwap` (preview on a clone AND the run), `_flowSwapHtml`, `sftkFlowSurgeryLines(...,
{ swapTo })`; `fixLayout` / `fixFlexiPage` / `fixReport` branch on `_replOn()` and return their own
label; `_copyFlsAccess` (`#fcFlsCopy`, `#fcFlsCopyBtn`; `sftkWriteVerifiedAll` + one re-read; undo
= delete what was created, lower what was raised).

**Verified live on trailheads5 (`scripts/dev/live/field-replace.mjs`, CLI truth after each):**
- picker: only same-type fields; warning that Status2 has no "Closed"; a scan shows Replace mode.
- 🔑 access: System Administrator got read + edit on the new field (FieldPermissions by CLI).
- flow with the field in a Get Records filter: v2 Active with the new field, v1 deleted.
- the flow removal could NOT fix (assignments would be left empty): 4 references moved, new version
  active, 5 old versions + 5 failed interviews deleted; `MetadataComponentDependency` then shows 0
  flows on the old field.
- layout: the new field sits in the old slot. Lightning page: field component + visibility rule
  moved; History -> Undo put the page back (verified); plain removal now also clears the rule.
- reports: the engine's output was PATCHed by CLI and Salesforce accepted it (column, filter,
  grouping). **Not exercised through the screen:** the dependency index did not list the two
  fixture reports (created by API, moved to Public Reports) during the session, so no report row
  appeared. Re-scan later; if they never appear, that is a scan gap to chase (reports created by
  API / not yet indexed).

**Two real bugs the live run found (both fixed, both pre-date this phase):**
1. *A draft newer than the active version.* Salesforce saves a deployed flow over its newest
   version when that version is a Draft: the draft record is replaced by a NEW record with the same
   number (proven by CLI; with the newest version Obsolete it creates the next number). The tool
   expected a higher number, said "no new version appeared ... Nothing was deleted" and stopped
   with the flow already changed. Now `sftkFlowSurgeryPlan` returns `overwrite`, the dialog names
   the draft and says its content is REPLACED, the draft is in the backup zip and gets a restore
   point, `_verifyFlowActivation(..., before)` takes the record that was not there before as the
   written version, and that version is never among the deletions. Pins:
   `test/flow-draft-overwrite-1004`.
2. *Lightning-page visibility rules.* The Tooling API returns the rule as `visibilityRule` with a
   plain-string right-hand side; the remover looked at `componentVisibilityRule`, so a rule that
   tested the field was never cleaned and the re-read (same function) called the page clean.

**Found on the way — reports are NOT reliably in the scan.** `MetadataComponentDependency` through
the Tooling REST API returned no Report rows at all on trailheads5 (two public reports used the
field; an explicit `MetadataComponentType = 'Report'` filter returned 0; the Bulk API 2.0 route
said "sObject type 'MetadataComponentDependency' is not supported"). The note under the results
said reports "are covered by the scan above"; it now says they appear only when the index returns
them and points at Setup's "Where is this used?". **Decision for the user:** the 2026-09-01 choice
was "no org-wide report sweep"; with the index silent, reports are in practice unscanned. Options:
keep the honest note (done), or add an opt-in, quoted, cancellable sweep (one Analytics describe
per report).

**Limits, stated in the product:** references move, data does not (no value copy); a flow swap has
no History undo (old versions are deleted — the backup zip is the way back); list views, compact
layouts, quick actions, validation rules, formula fields and Apex stay manual exactly as before.

**Backlog from this phase:** copy the stored values old -> new as an optional step before the
delete; replace in validation-rule / formula text; the XML inspector's "Remove selected" is removal
only; a flow whose active version mentions a same-named field of another object is still listed as
"referencing" by the plan (the scanner is by name).

## Scope of the first public release (decided 2026-10-03)

Asked "what would you cut from the scope?", the recommendation was: ship Data Deployment +
History + Connected Orgs, Flows, Field Cleaner, Dependencies, Debugger; hide the rest as Labs.
**The user's decision: "lets cut squences, picklist manager. but we do need the lightning pages".**
So for 1.0:
- **Cut from the public build (kept in the repo and the dev build):** the Picklist Manager
  (`studio-picklists.js`) and Sequences (moved into `studio-sequences.js`). `scripts/pack_store.py`
  `CUT_JS` leaves both files out, strips the Picklist nav button and the changelog bullets titled
  after them; the page degrades by itself: `_viewAvailable('picklists')`, Org health drops its
  picklist-drift card (`needs: '_pkSweepOpenOrgs'`), the Deploy page shows "add the value in Setup"
  instead of "🎚 Fix in Picklist Manager", the Data Deployment page shows the Sequences section only
  when `sequenceCard` exists. Verified in the harness on BOTH builds (store: absent, six Org health
  cards, a stale `#/picklists` link falls back to home, no page errors; dev: present).
- **Taken out of the builder (2026-10-03, "take it out"):** the per-object order switch "⤵ Created after parent / ⤴ Created before parent" (child-first). The engine still honours `insertOrder: 'childFirst'` (26 tests in `engine-childfirst`), but nothing in the builder sets it any more; a deployment that already carries it (older version, imported file) shows "⤴ Created before parent — click for the normal order" and one click removes it. Reason: never run through the Deploy page, its pre-check lived on the retired Transfer page, and a whole tree now deploys in one run with in-tree lookups connected after insert. Checked in the harness with both orgs: 12 object rows, no switch; the legacy chip appears and resets. Test `childfirst-cut-1003`.
- **Stays in:** Lightning Pages — which therefore needs the hand-level QA it never had (app /
  profile assignments, clone, deactivate were never exercised; the "Who sees what → Show users"
  404 is unconfirmed). That is now release work, not optional.
- **Not decided:** All open orgs, Org Compare, Deploy Readiness, Org health, Copy Permissions,
  Licenses, Flow Access — they ship unless the user says otherwise.
- `docs/FEATURES.md` keeps the two cut tools under "Not in the public build yet"; the in-app guide
  must not render that section.

## Backlog (found during the campaign)

- **Synced records beyond the 5,000 window cannot be found (user 2026-10-01: "5000 contacts are in sync and 1740 is not. but where are they").** The Synced tab lists the first 5,000 identical records and says the rest (1,740 here) exist; the filter searches only the loaded 5,000, so a user cannot confirm one specific record is in sync. Fix: keep the match KEY (name) of every synced record in the scan result (keys only — a few bytes each, no fields), list by name with the filter over all of them, and load a record's details on click. Same for the other buckets' windows.

## Order and effort

| phase | days | needs |
|---|---|---|
| 1 live run view | 1 | both orgs (vol tree for a Bulk job) |
| 2 orgs picked at deploy time, ring + crown removed | 4–6 | both orgs, rebuilt source |
| 3 words | 1 | — |
| 4 pause validation rules | 1 | target org with the fixture rules |
| 5 (folded into 2) | — | — |
| 6 three-step page | 2 | — |

About two weeks of sessions. Release decision unchanged: the public launch is 1.0.0 on a new
listing; this campaign lands before it, because every item here came from the first hand test.
