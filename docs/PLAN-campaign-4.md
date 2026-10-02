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
