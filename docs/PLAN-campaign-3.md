# Campaign 3 — plan (written 2026-09-26)

Eight improvements, in the order to build them. Each phase ends with the usual gate
(`npm run verify` exit code, `npm run pack`, boot smoke 1/1/1), a live run of the scripts it
touches, and one commit. Nothing is pushed. Phases 1–3 are one round; they mostly remove
duplication. Phase 4 is the hard one. Phase 7 needs a decision from the user first.

Before any phase: a source org again (`sf org login web --alias npc`, then
`bash docs/fixtures/rebuild-source.sh npc`). Phases 1–3 and 6 can be unit-tested without it.

---

## Phase 1 — one write discipline (`sftkWriteVerified`)

**DONE 2026-09-27** (commit follows): `sftk-write.js` (`sftkWriteVerified`, `sftkWriteVerifiedAll` with a batched `verifyAll`), `test/write-discipline.test.mjs` at baseline zero, every UI write migrated (two Sonnet sweeps, Fable review), the ENGINE given a post-run re-read (`summary[obj].verified`, History ✓/⚠), and every migrated tool re-run live on trailheads5. Found on the way: the flow-delete toast was erased by the list re-render; a deleted field stays readable under `X_del`.

**Problem.** Five tools reported success from the request result. Each was fixed by hand this
week; the next tool will repeat it.

**Build.** `sftk-write.js`, loaded by popup.html and studio.html, one function:

```
sftkWriteVerified({ write, verify, describe })
  write   → the bg call (PATCH / DELETE / deploy / collections)
  verify  → re-reads the org and returns { ok, text } from what it saw
  describe → the sentence for the user
  returns { ok, verified, text, raw }   — ok only when verify saw it
```

Move the five existing re-reads onto it: flow switches (`applyFlowBulk`), API versions
(`avVerifyAndActivate`), picklist metadata (`_pkApplyMetadataCore`), Field Cleaner flow fix
and field delete, deprecate / undo. Then the writes that still have no re-read: Copy
Permissions (PSA / GroupMember / profile), Licenses (User.IsActive), Flow Access (the
SetupEntityAccess row), Lightning Pages (the override / assignment after deploy), Sequences
(already via the engine), picklist sync core.

**Enforce.** `test/write-discipline.test.mjs`: every `SF_PATCH`, `SF_TOOLING_DELETE`,
`SF_REST_DELETE`, `SF_COLLECTIONS_UPDATE`, `SF_REST_POST` to an sobject, and
`SF_METADATA_DEPLOY` in a UI file must sit inside a `sftkWriteVerified(` call or carry a
`// verified-by:` comment naming the re-read. The test lists offenders by file:line.

**Live.** Re-run: flow-switches, api-versions, picklists, field-cleaner (DEPRECATE and
DELETE_FIELD), copy-perms, licenses, flow-access, lightning-pages. Expect identical outcomes.

**Size.** 2 days. Risk: low — behaviour-preserving refactor with the live scripts as the net.

---

## Phase 2 — one confirmation, both pages

**DONE 2026-09-27** (commit follows): `sftk-confirm.js` renders in both pages (`typedWord`, `production: { label }` as a second step in the same dialog, `icon`), `sftkOrgWriteGate` classifies an org through the background when it is not remembered and fails closed (unknown = production); `test/confirm-discipline.test.mjs` at baseline zero (`// confirmed-by:` for dialogs living in callers, `// not-destructive:` for the five debug-trace writes); every popup dialog and every Data Studio wizard moved onto it by two Sonnet sweeps, Fable review; the typed production step reached live (sequence run into a guarded target, wrong name refused).

**Problem.** `sftk-confirm.js` (checkbox acknowledgement) is popup-only; Data Studio uses
`showModal` and each tool writes its own dialog (Picklist Manager, Sequences, Copy Permissions
had none until this week). The typed production gate exists only in Data Studio
(`confirmTypedProd`), the popup has none.

**Build.**
1. Load `sftk-confirm.js` in studio.html; make it theme-agnostic (it already renders its own
   overlay). Move `confirmTypedProd` + `cachedOrgType` into it as the second step: when the org
   is production (or 🛑 guarded), the acknowledgement is followed by the typed org name, in one
   flow, in both pages.
2. Route every write through it: Deploy (already typed), rollback (typed), Picklist Manager
   single + bulk + sync, Sequences (`_seqConfirmRun` → the shared one), Copy Permissions,
   Licenses (`confirmModal` → shared), Flow Access (`modalConfirm` → shared), Lightning Pages
   (activate / remove / add), Field Cleaner (already shared).
3. The popup needs `cachedOrgType`: share `sftk-org-identity.js`'s classification (it already
   knows sandbox / production from the org's `IsSandbox` + the user's guard setting).

**Enforce.** `test/confirm-discipline.test.mjs`: no `showModal(` whose HTML contains a button
labelled Delete / Deactivate / Apply / Run / Copy outside `sftkConfirmDestructive`; every
`sftkWriteVerified` caller has a `sftkConfirmDestructive` within the same function or names a
`// confirmed-by:`.

**Live.** Every write script with `SCAN_ONLY=1` (the dialog must appear) + one run each with
🛑 Guard as production on the target and `TYPE_IT=1` (the typed step must appear and refuse
until typed). This closes the "typed gate never reached live" gap.

**Size.** 2 days.

---

## Phase 3 — History with undo for every write

**DONE 2026-09-27** (commits f1fe928 + the sweep commit): `sftk-history.js` in both pages — a journal per tool action (`sftkHistoryBegin` → `sftkWriteVerified({ journal })` → `sftkHistoryEnd(j, { undo })`), undo steps as data (message + re-read spec judged by `sftkUndoVerifyEval`), `kind:'tool'` entries in the shared History with `_histToolCard` and ↩ Undo through the shared dialog (word UNDO, typed org name); `test/history-discipline.test.mjs` at baseline zero; two Sonnet sweeps, Fable review; live with `UNDO=1` (scripts/dev/live/_undo.mjs) on flow switches, API versions, picklists (single, sync), copy permissions, licences, flow access, lightning pages, field cleaner — the CLI showed the original state after each undo. Not undoable, and said so: deleted flow versions, deleted debug logs, a Draft rewritten in place, a wipe.

**Problem.** Deploy has a verified rollback; Field Cleaner has restore points. A picklist value
deactivated, a flow's API version changed, a flow switched off, a permission copied, a licence
toggled, a page assigned: no History entry, no way back — though each is cheaply reversible.

**Build.**
1. One History entry shape for tool writes: `{ kind: 'tool', tool, orgUrl, at, what: [...],
   undo: { steps: [...] } | null }`. Entries come from `sftkWriteVerified` (Phase 1) — the helper
   writes the entry itself, with `undo` supplied by the caller, so no tool can forget.
2. Undo steps per tool (all re-verified through Phase 1):
   - Picklist value: re-activate / re-add (the value is only ever inactive — Salesforce never
     deletes via API); data fix: restore from the run's before-values (already captured in the
     picklist-fix run summary? — no: capture Id + old value per record, cap 5,000).
   - API versions: re-activate the previous version (still exists); a rewritten Draft cannot
     be undone → `undo: null` and the entry says so.
   - Flow switches: the remembered version (already stored) becomes the undo step.
   - Copy Permissions: delete the PSA / GroupMember rows created, restore ProfileId.
   - Licenses: flip IsActive back (re-activation can fail on licence caps → verified + said).
   - Flow Access: remove the SetupEntityAccess row (REST DELETE).
   - Lightning Pages: reverse the override / assignment deploy.
3. History view: tool entries alongside deployments, an ↩ Undo button, the plan shown before
   the typed word (reuse the rollback plan dialog).

**Enforce.** Every `sftkWriteVerified` call passes `undo` (a function or `null` with a
reason); a test lists callers with neither.

**Live.** Each tool: do → undo → CLI shows the original state. Add `UNDO=1` to each script.

**Size.** 3 days.

---

## Phase 4 — whole-tree deployment in one pass

**DONE 2026-09-29** (commit follows): recon showed the engine already wrote N levels in one call and linked children through the run's id map — the block was page-side (`deepblock` at depth > 1, the run-time skip, the one-level `cc.children = []`). `sftkRecOnePassPlan` (closure pulls missing ancestors in, deepest first; anchors pick the call — the root tree call, or a call rooted at the level whose parent exists) + `sftkRecPruneTree` (per-call tree, any depth, only the riding records); grandchildren selectable at any depth; the engine names children whose parents failed in the run (all, or some). Tests `onepass-plan-0929`, `engine-onepass-0929`. Live (`scripts/dev/live/onepass-tree.mjs`): the Accounts tree from the first scan in ONE run on trailheads5 → trailheads4 — line items, contact roles, case comments and order items written with their parents; the fixture's deliberate refusals (a Retail account without a Website, a Lab lead without a Phone) left their children out; ↩ Roll back restored the target (CLI 4 accounts · 2 contacts · 0 opportunities · 0 line items before and after).

**Problem.** A grandchild (line item, comment, order item) is not selectable while its parent
is missing in the target (rule R5); a real hierarchy takes two or three runs.

**Build.**
1. Selection: a missing parent no longer greys out its children; ticking a child auto-ticks
   its missing ancestors (with a note: "+2 parents added so this record has somewhere to go").
2. Engine: the run ledger already connects children after insert (`_runLedgerStore`). Extend
   it so a step can insert a child whose parent id resolves from the ledger *of the same run*
   — today the ledger links lookups after insert; here the parent must exist BEFORE the child.
   Order of writes = topological order of the tree (root → children → grandchildren), which the
   engine already walks; the change is: resolve `parentField` from the ledger when the parent
   was inserted earlier in this run, not only from the scan's pairing.
3. Rollback: the ledger already knows everything created; nothing new.
4. Preview: the plan says "3 steps in one run: 7 Accounts → 12 Contacts → 4 line items".

**Enforce.** `test/engine-onepass-*.test.mjs` on the canned two-org world: a tree with a
grandchild whose parent and grandparent are missing deploys in one run; a failed parent leaves
its children un-inserted and named.

**Live.** `run-accounts-tree.mjs PASSES=1` with line items ticked from the first scan; CLI shows
every line item under its opportunity under its account. Then the huge tree (`vol`) in one pass.

**Size.** 4–5 days. Risk: the highest here — the engine's ordering and the ledger. Do it after
1–3 so every write is verified and undoable while it is being changed.

---

## Phase 5 — ambiguous keys as a bucket

**DONE 2026-09-29** (commit follows): `sftkScanKeyClasses` decides per key (pair / insertAll / extraAll / ambiguous) after memory pairs are out — the old last-copy-wins indexes are gone, root and child alike; bucket `ambiguous` rows carry `candidates` and `twins`; "insert as new" is the match-memory value `SFTK_MEM_NEW`, so it is kept, exported and cleared with the pairs; Deploy tab ⚠ Ambiguous (root: 📌 pair / ➕ insert as new → remember + rescan; child: add a second match field), plan column, notes line; all ring summaries + the ring cell count it; the accuracy grade reads it. Tests `ambiguous-bucket-0929` + four real-scan cases in `scan-e2e`. Live (`scripts/dev/live/ambiguous.mjs`): Account 7 · 1 · 2 · ⚠2 → pin one copy → 8 · 2 · ⚠0 → deploy the other → CLI two target records with distinct Ids → ↩ Roll back → CLI one.

**Problem.** Two source rows with the same key: one lands in "changed", the other in no bucket,
plus a warning. Users cannot see, choose or fix it where they are.

**Build.**
1. Scan: rows whose key is in `dupKeys` go to a new bucket `ambiguous` (both twins, and the
   target rows sharing the key), and out of every other bucket. Ring and Deploy counts show it
   (`7 · 2 · 2 · ⚠2`).
2. Deploy page: a fifth tab "⚠ Ambiguous" listing the twins with the candidate target(s) and
   inline Match Review pinning (this source ↔ that target, or "insert as new"). A pin becomes
   matchMemory (the only way memory gets an ambiguous pair — Phase 3 of campaign 2 stopped the
   scan from learning them).
3. The parents card and the ring cell say "N ambiguous — resolve in Match Review".

**Enforce.** engine tests: a duplicate pair never appears in insert/changed; pinning moves it.

**Live.** The CX fixture's "SFTK CX Duplicate Name" pair: shows in ⚠, pin one twin, the other
becomes an insert, deploy, CLI shows two records in the target with distinct Ids.

**Size.** 2 days.

---

## Phase 6 — complete safety scans

**DONE 2026-09-29** (commit follows): the record-triggered listing had filtered on `TriggerObjectOrEventApiName`, a column FlowDefinitionView does not have — it failed on every org. Now ONE listing (`ApiName, Label, ProcessType, TriggerType, TriggerObjectOrEventId, ActiveVersionId, ManageableState`), record-triggered on the object first (`TriggerObjectOrEventId` = API name, or the entity Id for a custom object), the Metadata read 25 per Tooling composite/batch call, `FLOW_CAP` removed, `pkBulkScanCalls` = 6 + ⌈flows/25⌉. Managed-package flows (`ManageableState = installed`) are counted and said, never requested — Salesforce does not expose their Metadata (their ActiveVersionId is not a record Id). Step 1 (reuse the Dependencies cache) was not needed: Data Studio reads 63 flows in 3 calls. Test `picklists-fullscan-0929`. Live (`scripts/dev/live/picklists-fullscan.mjs`, trailheads5): 63 of 63 own active flows read (4 record-triggered on Account), the fixture flow naming “Closed” found, 100 installed flows named.

**Problem.** The automation check before switching off a picklist value scans 40 of 147 active
flows (`FLOW_CAP = 40` in studio-picklists.js) and says so; record-triggered flows "could not
be enumerated".

**Build.**
1. Reuse the Dependencies tab's flow metadata cache (`dependency-map.js` stores every flow's
   Metadata per org, with the size-aware cache) instead of re-reading flows per check: a
   literal search over cached metadata is free and complete.
2. Where the cache is absent (Data Studio has no Dependencies tab), read flow metadata through
   `SF_COMPOSITE_BATCH` in pages of 25 with a progress line and no cap; keep the API-budget
   estimate honest before starting ("≈150 calls").
3. Record-triggered flows: enumerate from `FlowDefinitionView` (TriggerType != null), which the
   flow-switches panel already does — the check must use the same read.
4. Remove `FLOW_CAP`; the "scanned N of M" note stays only for a read that failed.

**Enforce.** picklists-t9 tests for the new reader; the pin that a partial scan says
"nothing that was scanned" stays for the failure path.

**Live.** picklists-compare `MODE=sync` — the verdict must read "no flow or validation rule …"
with no cap note; the run log must show the full count.

**Size.** 1–2 days.

---

## Phase 7 — nightly live runs

**Problem.** The live scripts run only when Claude runs them; a regression (something that used
to work and stops after a later change) surfaces at work, from a user.

**Needs from the user.** A Developer Edition org as the permanent target (does not expire) and
a Nonprofit Cloud trial or a second DE org as the source — or one DE org as both, with the
person-account scenario dropped. Decide whether the runner is this PC (Task Scheduler, the
laptop must be on) or a small cloud VM.

**Build.**
1. `scripts/dev/nightly.mjs`: runs the scripts in order (each with its known env), resets the
   orgs between them (cleanup + seed apex, fixture redeploys — all exist), and writes
   `dist/nightly/<date>.json` with each script's key lines and the CLI counts after it.
2. `scripts/dev/nightly-expect.json`: the expected values (7·1·2·⚠2, "3 version(s) deleted",
   0/0/0 after rollback, …), taken from the fixture READMEs.
3. A diff step: expected vs actual → `dist/nightly/<date>.md` with ✅ / ❌ per script, and a
   Windows toast (or an email through `sf`'s org? no — a plain file plus the toast).
4. Task Scheduler entry at 02:00 running `node scripts/dev/nightly.mjs`; the morning check is
   opening the .md.

**Size.** 1 day after the orgs exist.

---

## Phase 8 — org health page

**DONE 2026-09-29** (commits d98d62c + the cards commit): `studio-orghealth.js` — view `orghealth` (nav, `#/orghealth`, command palette, popup Home tile), the card contract (`calls` shown before Check — a number or a formula; `run` → tone / headline / lines / fix; optional `input`), answers kept per org in `sftk_orghealth` (in 🧹 Clear cached org data and PRIVACY.md). Seven cards: licences at the cap, idle users (integration licences left out, said), flows left off, flows ≥ 3 releases below the org's release (`sftk-apiver.js` now loaded in Data Studio), Lightning pages assigned to nobody (a faithful port of the Lightning Pages reads; a parity test runs its describe matcher against `lpOrgDefaultsFromDescribe`), picklist drift across the ring (the Picklist Manager's sweep split into reusable readers `_pkSweepOpenOrgs/_pkSweepPickSource/_pkSweepFieldUnion/_pkSweepReadField`), custom fields with no data and no references (candidates — the dependency index misses reports / list views / pages). Tests `orghealth-0929`, `orghealth-cards-0929`. Live (`scripts/dev/live/orghealth.mjs RING=1`, trailheads5 + trailheads4): all seven answered — 2 full licence types, 2 idle users (+2 integration users said), 62 flows ≥ 3 releases behind, 43 pages assigned to nobody + 4 could not be checked, the fixture picklist drifting between the two orgs, the Account field card honest about 3 FLS-hidden fields. Live fixes: pages that share a label named by API name; the Check-all total keeps its “+”.

**Problem.** The tools know the answers; nothing shows them together.

**Build.** Data Studio view "Org health" (and the popup Home tile): one card per finding, each
a jump into the tool that fixes it:
- fields with no references and no data (Field Cleaner's scan + data verdict, read-only)
- flows pinned below the org's release (API versions matrix, read-only)
- Lightning pages assigned to nobody (Phase Lightning Pages read, "Not assigned")
- users inactive but holding a licence; licences at the cap (Licenses overview)
- picklists drifting between ring orgs (the picklist sweep verdicts)
- flows switched off with a remembered version (flow switches)
Every card shows when it was computed, the API cost before computing, and reads nothing until
the user presses "Check" (the same budget-first rule as everywhere).

**Size.** 2–3 days. Best done last: it reuses every read the phases above make trustworthy.

---

## Order and effort

| phase | days | needs |
|---|---|---|
| 1 write discipline | 2 | source org for the live pass |
| 2 confirmations | 2 | — |
| 3 History + undo | 3 | — |
| 4 one-pass trees | 4–5 | source + target org |
| 5 ambiguous bucket | 2 | source + target org |
| 6 complete scans | 1–2 | source org |
| 7 nightly runs | 1 | the user's org decision |
| 8 org health | 2–3 | — |

About three weeks of sessions. Release 1.5.0 first (it is gated and packed); this campaign is
1.6.

## Who does what (model split, per the standing policy)

- **Fable** (engine, security, debugging, review): Phase 4 entirely; the engine half of Phase 5;
  the helper design in Phases 1–3 (`sftkWriteVerified`, the shared confirmation with the typed
  gate, the undo step semantics) and every live run + its debugging; the diff step of Phase 7;
  the review of every phase before its commit.
- **Sonnet** (recon, prose, test-locked sweeps): the mechanical sweeps once the helper exists —
  moving each tool's writes onto `sftkWriteVerified` (Phase 1) and onto the shared confirmation
  (Phase 2), because every one of them is pinned by a test and a live script; the History view
  markup and wording (Phase 3); the nightly runner's plumbing (Phase 7); the org-health cards
  (Phase 8); all README / CHANGELOG / HANDOVER text.
- **Never Opus.**

Rule of thumb: Fable writes the primitive and the first migration of one tool as the pattern,
Sonnet repeats the pattern across the other tools with the tests as the lock, Fable reviews
the diff and runs it live.

---

## Backlog (after campaign 3)

- **Copy Permissions: copy the role too** (user request 2026-09-29, parked by the user until campaign 3 is done). Design, ready to build (~1 hour + live):
  - `user-copy.js`: add `UserRoleId,UserRole.Name` to `USER_FIELDS`; a 🏢 Role option next to 👤 Profile (`#ucOptRole`, `getOptions().role`).
  - Preview: a Role row like the Profile row (`#ucRoleCb`); disabled with "same" when the roles match; disabled with "has no role — nothing to copy" when the source has none (clearing a role is not offered); an ℹ️ line that the role decides which records the user sees through the hierarchy and sharing rules.
  - The Copy access confirmation lists `Role → <name>` ("replaces the current role (<name|none>)"); its text says profile OR role is replaced and that ↩ Undo lives in History.
  - Write: `SF_PATCH` User `{ UserRoleId }` through `sftkWriteVerified` (journal, verify `SELECT UserRoleId FROM User WHERE Id=…`); `roleOk` in the result sentence ("role updated").
  - Undo: PATCH the previous `UserRoleId` back (null when the target had no role), verify `equals` the previous value.
  - Live: give SFTK Test A a role by CLI, run `copy-perms.mjs UNDO=1`, CLI shows B's role before/after. Check first whether the fixture users' licence (Identity) accepts a role at all — if Salesforce refuses, the result quotes it; test with a Salesforce-licence user instead.
