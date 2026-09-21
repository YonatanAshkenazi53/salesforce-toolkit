# One Deploy page — parity checklist and verified dry-run design

Status: STEP 1 BUILT 2026-09-19 as `studio-deploy.js`, a beta BESIDE the classic pages (switch on Data Deployment; classic pages unchanged). It is a presentation over Reconcile's scan, selection Sets and `runReconcile`. Still to build: the real dry run, then the items below that are not ticked. Not yet verified live. Mockup: `docs/mockups/deploy-merged.html`
(artifact https://claude.ai/artifact/WBc8n7hbijzTciLC3NsGgJ).

The user's rule for the merge (2026-09-18): **"we need to make sure each
functionality of the old UI is there."** This file is the checklist. It was
produced by two read-only inventories of the code on 2026-09-18 (Run Transfer:
`studio-transfer.js`; Reconcile: `studio-reconcile.js` + `studio-scan.js`).
Tick an item only when the merged page does it and a test pins it. Line
numbers are as of that date — search by function name.

---

## A. Real dry run — what Salesforce actually does (verified on npc, 2026-09-18)

The old dry run (`sftkDryRunAgainst`, ~760 lines in `studio-transfer.js`) is a
second, hand-written copy of the engine's rules. It can never see validation
rules, triggers or duplicate rules, and it did not know Person Accounts. It is
to be REPLACED by a real write that Salesforce rolls back.

Verified by CLI against npc (API v62.0). After every test a SOQL count
confirmed **0 records persisted**.

1. **Flat, one level** — `POST composite/sobjects` with `allOrNone: true` and
   one poisoned record at the end. Result: every failing record reports ITS
   OWN error (`STRING_TOO_LONG`, `REQUIRED_FIELD_MISSING`…), valid records
   report `ALL_OR_NONE_OPERATION_ROLLED_BACK`. Mixed object types in one call
   are fine. This is the per-record dry run.
2. **Composite Graph — NOT usable.** `POST composite/graph` stops at the first
   failure; every other node reports `PROCESSING_HALTED`, so bad records are
   never named. Also: a poison node with an EMPTY body `{}` makes the whole
   graph fail to parse (`JSON_PARSER_ERROR`) — a poison must be a valid body
   that fails a rule, e.g. `{"Description": "poison"}` on Account (no Name).
3. **Parents + children in one transaction — usable, with a rule.**
   `POST composite` with `allOrNone: true`, subrequests:
   (a) `composite/sobjects` `{allOrNone:false, records:[parents]}` as `refP`,
   (b) `composite/sobjects` `{allOrNone:false, records:[children]}` with
   `"AccountId": "@{refP[0].id}"`, (c) a poison `sobjects/Account`.
   Observed:
   - a child WAS evaluated against a parent created in the same request
     (it came back `success:true` with an id) and then rolled back;
   - **the first subrequest that contains any failed record keeps its full
     per-record body; every other subrequest reports `PROCESSING_HALTED`;**
   - when nothing fails, only the poison fails → "probe passed".
   Consequence: errors surface ONE LEVEL AT A TIME. To see child errors when a
   parent level has failures, re-probe with the failing parents removed (at
   most depth+1 rounds).
4. Limits to state in the UI: it is a SAMPLE (200 records per collections
   call); triggers really execute (emails and queued jobs roll back with the
   transaction, immediately-published platform events do not); production
   goes behind the typed confirmation; auto-number gaps are possible.

Build rule: the probe must send payloads built by the REAL engine
(`executeProfileTransfer`'s payload builder), never a second implementation.

---

## B. Run Transfer page — must survive

Entry points
- [ ] ▶ on a deployment card; target picker modal when the ring has >1 target (`window.runProfile`)
- [ ] Org card "Transfer" (seeds a run-time target override) (`window.startTransferFrom`)
- [ ] History "↻ Run again" (same org pair as that run; filters NOT restored) (`window.runAgain`)
- [ ] History "↻ Retry failed (N)" → seeds failed ids as a run-time filter (`window.retryFailedRun`)
- [ ] Retry of failed CHILD records whose parents were written must never open a run with the parent unfiltered (`sftkRetrySplit`, 2026-09-18) — on the merged page this should be a first-class path: insert the children under their existing parents

Profile and orgs
- [ ] Profile select; change resets filters, org override and stale counts
- [ ] ✏ Edit profile → builder; empty state "Go to Data Deployment"
- [ ] Source fixed; target limited to the ring's targets, never the source itself (`profileTargets`)
- [ ] "Target changed for this run only" note + ↺ Reset to profile; override never saved
- [ ] Session-ready dots, session-expired banner, Run/Dry disabled until both sessions live and src≠tgt

Plan and counts
- [ ] Per-object counts scoped like the engine reads (`sftkChildCountWhere`); grandchild under a filtered parent = **"≤ N" upper bound** on the plan, the button and the confirm
- [ ] 👁 Refresh counts; per-object breakdown text (`sftkCountBreakdown`)
- [ ] 📋 Records preview: per-record operation from the last scan (Insert / Update / Update no changes / Insert — would DUPLICATE), 200-row cap, refuses on a stale scan

Record filter
- [ ] 🎯 Filter <Object> per node: WHERE input, Load records, show-field select, search, All/None, 200-row list, ↺ Reset to profile default, ✓ Apply — **run-time only, never mutates the profile** (`buildTransferProfile` patches a clone)

Write mode
- [ ] Insert / Upsert; External-ID picker from the TARGET describe, "Other…", disabled+explained when the target has none
- [ ] Upsert on `SFTK_ID__c` sets `tree.stampField`
- [ ] Write mode, upsert field, filters, org override = SESSION state; engine / batch size / threads = SAVED on the profile immediately

Engine
- [ ] Auto / Synchronous / Async + threshold; batch size 1–200; threads 1–6; both disabled for Bulk; hint text
- [ ] 📸 restore point checkbox = GLOBAL setting; row caps 50,000 (250,000 insert-only), newest 10 runs

Run
- [ ] Guard: upsert with no field
- [ ] Big-run / PRODUCTION confirm (>2,000 records or prod) with by-object breakdown and "≤" caveat; asks again next time
- [ ] ✋ Cancel in BOTH phases: during restore-point capture (nothing written, nothing recorded) and during the run (current batch finishes, Bulk job aborted, "not processed" → Retry failed)
- [ ] Live progress rows, Bulk job row, real-time error feed with "+N more"
- [ ] Per-object result lines (created/failed/notProcessed/connected/orphaned/⚡ Bulk/skipped fields), session-expired hint
- [ ] 🧮 API-call actuals line; budget meters invalidated and repainted
- [ ] Match Memory learning ONLY when the run's source = the profile's own source
- [ ] History entry always written (both key pairs srcOrgUrl/sourceOrg), even on hard failure, with the undo stub
- [ ] Post-run auto-refresh only for the profile's own org pair; "📜 View History" link
- [ ] ≈ API-call estimate + daily-limit line, orange when over budget, never blocks (`sftkEstimateRunCalls`)
- [ ] "Write operation" banner wording (insert-only default, source never modified)

Dry run (old validator) — checks the REAL probe must still cover or disclose
- [ ] PII policy without a salt = hard stop before anything
- [ ] Three-state verdict: clean / dirty / **could not check** (never "clean" when something was unchecked)
- [ ] "✓ dry run passed" is FINGERPRINTED (effective tree + write mode + org pair); any edit un-validates it
- [ ] Child-first feasibility (parent link nillable + updateable)
- [ ] PII: validate the MASKED value, masked-anchor lookup warnings, covered-but-unwritable fields
- [ ] Field-mapping collisions; fields that won't transfer (not createable in target)
- [ ] Lookup bridge probes (0 / some / all resolve), hand-pick note
- [ ] Record-type match preview; owner-matching sanity; PII vs owner/upsert key collisions
- [ ] Automation it could not test — obsolete once the probe is real, but keep the list as "what ran"

Sequences stay separate (`SF_EXECUTE_SEQUENCE`, launched from the profiles page).
Pure helpers left from fan-out (`sftkFanoutDryVerdict` is LIVE — it is the dry-run verdict).

---

## C. Reconcile page — must survive

Header
- [ ] Back link, title line (orgs, PROD/sandbox badge, scan age, read counts, WHERE chip, 🧠 memory chip, 🎯 accuracy chip)
- [ ] 💾 Save as deployment (ephemeral pairs); 🔄 Refresh state (clears selections)
- [ ] ⛓ Journey-back banner for `_parentOf` parents-first journeys
- [ ] Target chooser modal with each target's last verdict; ephemeral `_ringOf` clone for non-primary targets
- [ ] Stale-scan gate; auto-refresh when a History run touched either org after the scan

Cards and notes
- [ ] Session-offline banner; still-needed chips; duplicate-name details; memory note; 👤 Person Account contacts note; legend; truncation note; near-miss note; phantom State/Country note; blank-key note; scan warnings; picklist gap note + 🎚 Fix in Picklist Manager

Four columns (the 4th, 🟢 Synced, is a COLUMN not a tab)
- [ ] Insert: checkbox, 🔗 lookup hand-picks with badge, ≈ near-match chip, ✓ All / ✗ None (cap-aware tooltip)
- [ ] Changed: → / ← (mutually exclusive, click again = skip), "why" chip, ▸ fields, 🔗; → all / ← all / ✗ None; sub-counts
- [ ] In target only: ← Pull / 🗑 Delete; Pull all / Delete all / None; sub-counts
- [ ] Synced: open-in-both links, 🪪 Stamp identity, 🗂 Table, 📎 file drift with select & move (direct, no Run; PII fail-closed)
- [ ] Live summary bar; ▶ Run enabled only with a selection; 🔗 Match review (manual pairing, 🧠 clear memory)

Field compare (wide modal, `sftkOpenDriftCompare`)
- [ ] Differing first, matching folded; tags (lookup by X, ≡ normalized, ≈ case/space only, ⚠ type differs)
- [ ] Per-field push with current→new confirm, lookup re-match (exactly one match or reported), PII masking, typed prod confirm, repaint from a fresh read; disabled rows say why

🔗 Lookup panel
- [ ] Current value on BOTH sides, "will connect →" suggestion with 📌 pin, search (debounced, 15 results), picked chip with ✕
- [ ] Stored at `node.lookupOverrides[targetOrgKey][srcId][field]`, keyed by org IDENTITY, saved immediately unless ephemeral; Priority 0 in engine, overwrite and per-field push; child clones carry it (2026-09-16)

Children and grandchildren
- [ ] Toggle, 🔎 Scan, badges, staleness vs root `runAt`
- [ ] Insert order ⤴ before / ⤵ after parent — run-scoped, disabled for grandchildren and master-detail
- [ ] Master-detail guardrail (forces parent-first, disables Relink, warns at run time)
- [ ] Parent groups (>30 rows) with group ✓/✗ and live counters; parent-status chips
- [ ] ⇄ Relink (+ All/None, block reasons); child drift → (+ ▸ fields and 🔗 since 2026-09-16); child 🗑 with ⚠ orphan excluded from bulk
- [ ] Key-collision, blank-key, near-miss, scope-truncation notes per child; grandchildren need a fresh parent child-scan

⛓ Parents advisor (Deployment order)
- [ ] One probe per referenced object; live verdicts; ➕ Deploy / ⚖ Open & fix / 🔍 Compare & fix open an ephemeral parents-first journey
- [ ] RUN GATE: doomed inserts (required lookup → empty object) = hard STOP; empties = warning
- [ ] `_parentSyncVerdicts` persisted in `sftk_parent_sync`

Org write lock (Connected Orgs -> Lock writes)
- [ ] Locked source: every source-writing control is off with a tooltip naming the org; locked target: stated in the header; Run refuses by org and direction before the restore point (`window.sftkOrgLocked`, identity match); chokepoint in background.js stays the enforcement

Action bar and run
- [ ] Engine / batch / threads (saved; mirrored to the real profile through `_ringOf`); Delete mode Recycle Bin / Hard (NOT saved); Cancel = back
- [ ] Confirm modal only when delete / pull / update-source / child actions / capped buckets are involved; numbered execution plan
- [ ] Truncated-set write guard wording (`sftkCappedWriteNote`) — warns, never blocks
- [ ] Hard delete refused on production; typed prod confirm for deletes, stamp and per-field push
- [ ] Restore point legs (target objects + source root when ← is used); ✋ cancel
- [ ] Phase order: child deletes → root delete → pull → push (tree, auto-parents, group A) → group B child inserts → relink → child overwrites → root overwrite → reverse drift
- [ ] Progress log + run port; post-run re-check, child rescans parents-before-grandchildren, ring tile writeback, unmissable toast on total failure
- [ ] History entry shape (`kind:'reconcile'`, per-DML counts, failedSourceIds, errors ≤50)

Scan internals that the counting mode must keep
- [ ] Completeness gate (INCOMPLETE refusal, side-specific); key collisions (root counts, child excludes); near-miss pass; match memory (learn, cap 5,000); bucket caps 5,000 / 2,000 with the sanctioned wording builders; orphan probe cap; source blank-link count; multi-select order-insensitive compare; RecordType by DeveloperName; owner drift only in match mode; autonumber-key warning; engine compare-set expansion; org-type cache; Person Account contacts excluded both sides

---

## D. Easy to miss (from both inventories)

1. "≤ N" upper bounds propagate to three surfaces.
2. Session state vs saved state (write mode/filters/override vs engine settings) — do not mix.
3. Dry-run verdict is three-state and fingerprinted.
4. Cancel has two phases with different consequences.
5. PII: masked values are what gets validated; no salt = hard stop; files cannot be masked → blocked.
6. Target choice is limited to the ring; an org must never target itself.
7. Match Memory only learns under the profile's own source.
8. Delete mode is not persisted.
9. `_ringOf` / `_parentOf` stamps route writebacks and journeys to the real profile.
10. Phantom State/Country differences belong in `identical`, or overwrite never converges.
11. Post-run child rescans must go parents-before-grandchildren.
12. **Possible fail-open to verify:** the inventory reports that an org whose type is `unknown` gets the typed confirmation for 🪪 Stamp but not for Delete (only exact `production` triggers it). Law: fail closed on ambiguity. Verify in `runReconcile` before the rewrite and fix either way.
