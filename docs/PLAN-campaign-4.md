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

## Phase 2 — the crown leaves the top bar

**Problem.** The top-bar SOURCE menu crowns the org it switches to. Crowning re-points every
ring-following deployment, marks their scans stale and rescans all of them — and fails loudly
for a deployment whose root object the new source lacks. The user read the menu as "which org
am I looking at". Decision (user 2026-10-01): remove it from the top bar.

**Build.**
1. The top-bar chip shows the working pair read-only (or disappears once Phase 5 lands).
2. The crown moves only on the Sync Ring page, behind `sftkConfirmDestructive` whose text lists
   what will change: "7 deployments will now read from trailheads4 · 1 cannot: Load_Parent__c
   does not exist there" — computed before the dialog, no surprises after.
3. No automatic rescan storm: after the move, the ring page offers "🔎 Scan all" as a button;
   stale tiles say stale.
4. Crown history (↩ restore) stays.

**Enforce.** `dsSetSourceOfTruth` is reachable only from the ring page (test on the html + core
wiring); the confirmation text names every deployment that cannot follow.

**Live.** A ring with the CX deployments plus one deployment rooted in an object only one org
has: crown moves with the dialog naming it; nothing rescans until asked.

**Size.** 1 day.

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

## Phase 5 — pick From and To when you deploy

**Problem.** A deployment carries its orgs (or follows the ring). Opening it against another
target makes a temporary copy; the crown re-points it; a parents-first step born from a copy
had no way back (fixed 2026-10-01, but the shape stays fragile). Users want to deploy the same
shape between any two orgs.

**Build.**
1. A deployment is a SHAPE: objects, filters, fields and mapping, matching, lookups, engine
   options. `sourceOrg` / `targetOrg` become defaults ("last used").
2. The Deploy page opens with From → To selectors (open orgs first, then known orgs), and
   reads both orgs on Confirm. Scans, match memory, run ledgers and History are keyed by the
   pair, as the ring already keys `ringScans`.
3. Follow-the-ring vs pinned modes, `pair_` clones and `_ringOf` go away; the Sync Ring page
   becomes "run this shape across these targets" (one scan per pair, the matrix as today).
4. Migration: existing profiles keep their orgs as defaults; nothing else to convert.

**Enforce.** Engine tests unchanged (the engine never cared); scan-e2e on two pairs of the
canned world; a test that no code path creates an ephemeral clone any more.

**Live.** CX tree trailheads5 → trailheads4, then the same shape trailheads4 → trailheads5
(after rebuild), from the same saved deployment; History shows both pairs; rollback per pair.

**Size.** 3–5 days. The risky one. After 1–4 so every surface it touches is already honest.

## Phase 6 — the Deploy page in three steps

**Problem.** Tree, identity, two-org table, parents-first, advisor notes, tabs, engine options
and the run log all compete on one screen.

**Build.** 1) Orgs — From → To and "Read both orgs". 2) What differs — the table and the record
tabs; tree, identity and dependencies fold under "Details". 3) Deploy — selection summary,
options (duplicate rules, ⏸ flows, ⏸ validation rules, restore point), the one button, then the
live run view (Phase 1) in place. The advisor notes become one "Before you deploy" block.

**Size.** 2 days. Last, because Phase 5 changes step 1.

---

## Order and effort

| phase | days | needs |
|---|---|---|
| 1 live run view | 1 | both orgs (vol tree for a Bulk job) |
| 2 crown off the top bar | 1 | — |
| 3 words | 1 | — |
| 4 pause validation rules | 1 | target org with the fixture rules |
| 5 From/To at deploy time | 3–5 | both orgs, rebuilt source |
| 6 three-step page | 2 | — |

About two weeks of sessions. Release decision unchanged: the public launch is 1.0.0 on a new
listing; this campaign lands before it, because every item here came from the first hand test.
