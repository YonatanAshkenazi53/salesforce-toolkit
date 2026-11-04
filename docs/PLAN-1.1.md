# 1.1 — the real dry run, then PII fabrication (started 2026-11-03)

Owner's words (2026-11-03): the PII masking that shipped in the repo (cut from
1.0) "is not good enough" — seeding a dev sandbox from a Full Copy needs
*fabricated* values that look real and pass validation, not hashes; and the old
dry run was dropped because it "did not work well enough" (it was a second copy
of the engine's rules and could never see validation rules, triggers or
duplicate rules). Build both, iterate until it is the highest standard, break
nothing on the way.

## A. 🧪 Dry run — a real write that Salesforce rolls back   ✅ engine + pages (2026-11-04)

What: the engine builds its REAL payloads (same builder, same lookups, same
masking, same identity stamp) and, instead of writing, hands every chunk to one
`POST /composite` with `allOrNone: true`, parents before children, each child
referencing its parent as `@{n0[3].id}`, and a poison subrequest last (an
Account with no Name) so the transaction always rolls back after every record
was evaluated — validation rules, triggers, flows, duplicate rules included.
Verified by CLI on npc on 2026-09-18 (docs/deploy-merge-parity.md §A).

Facts the parser relies on: the first subrequest with a failing record keeps its
per-record body, every other subrequest reports `PROCESSING_HALTED`; so errors
surface one level per round — the refused rows and every row pointing at them
(the cascade) leave the next round, until a round fails on the poison alone.
Up to 8 rounds, 24 objects, 200 records per object (one subrequest each).

Where:
- `background.js` — helpers above `executeProfileTransfer` (`sftkProbe*`,
  `sfProbeComposite`, `sftkProbeStatus`); `profile.probe === true` switches the
  engine: sampling at fetch, the write site registers the chunk and answers
  tokens, bulk/threads/late links/files/child-first connect/post-run re-read
  are skipped and said, the rounds run after the node loop; the result carries
  `probe: { byObj, rounds, sample, persisted }`, `summary[obj].probe`,
  `summary[obj].failedSourceIds` = the refused records with Salesforce's error
  and the field values sent, `status` from `sftkProbeStatus`.
- `studio-reconcile.js` — `runReconcile(p, obj, buckets, { probe: true })`: its
  own dialog (what is checked, what is not, how it works, the limits; typed
  name on production), no restore point, no pauses, deletes / overwrites /
  relinks / pulls named as not covered, inserts flagged for the engine, a
  History entry of kind `dryrun` (no undo, no retry, no continue), no rescan —
  the selections stay for the ▶ Deploy that follows.
- `studio-deploy.js` — 🧪 Dry run next to ▶ Deploy.
- `sftk-run-progress.js` — the card: built → checking (round n) → verdict.
- `studio-history.js` — the dry-run card: chip, sentence, verdict chips,
  "would be refused" links to the source records.
- Tests: `test/dryrun-probe-1103.test.mjs` (helpers + the engine in probe mode
  against a Salesforce double), `test/dryrun-view-1104.test.mjs` (the card,
  the pages).
- Live: `scripts/dev/live/dryrun.mjs` — the CX Accounts tree against npc2's
  two validation rules; CLI counts before == after.

Honest limits, said in the dialog and the run: a sample; triggers and flows
really run and roll back (e-mails and queued jobs too; platform events
published immediately do not); 🔗 late links and 📎 files unchecked; ⏸ pauses
not applied; row locks and limits at full volume can differ. If Salesforce ever
answers a real id (the poison accepted), the run re-reads, deletes what it
finds and says so — status `failed`.

Open: overwrite / relink / delete probing (flat `allOrNone` + poison per
kind), a "🧪 passed ✓" hint on ▶ Deploy keyed to the selection fingerprint.

## B. PII v2 — fabrication   ✅ built + live-verified (2026-11-04)

Where: `sftk-pii.js` (+ the byte-parity block in `background.js`): persona per
record, Hebrew lists, phone-keep, card-last4, IBAN, street, date-shift, scrub,
the span detectors, `sftkPiiAudit`; `sftkPiiMaskValue(…, ctx)`; the engine's
`sftkPiiMaskRows` builds the persona and the Account domain; the post-write
audit reads 200 written records back. Builder: Suggest PII treatments (200 rows,
a treatment per row, two previews), the 🎭 chooser, `bldPiiSetRule` /
`bldPiiApplyRules`. 'pii' left the pack cut list. Live: `scripts/dev/live/pii-v2.mjs`
(the Leads fixture: fabricated values written, none real, rollback verified).
Open: Hebrew street/company lists are short; a per-field "keep last N" for IDs;
a walkthrough chapter. The design as planned:

1. **Discovery**: Data Classification (`FieldDefinition.ComplianceGroup`,
   `SecurityClassification` — v1 reads it), name/type heuristics (v1), and
   **content sampling** (new): 200 rows per object through the detectors —
   Luhn-valid 16 digits, Israeli ID checksum, phone shapes, e-mail, IBAN —
   "Description__c: 38% of values contain something that looks like a card".
   Result: a table of fields to fabricate, each with its reason, the user
   approves (like Needs a decision).
2. **Generators**, deterministic from hash(salt + value) (v1's contract, so
   joins and re-seeds survive), format-preserving and *valid*: card (brand
   digit kept, Luhn check digit computed, "keep last 4" option), Israeli ID
   (checksum), SSN (900–999 area), phone (country code + format kept, fiction
   ranges where they exist: US 555-01xx, UK 07700 900xxx), e-mail (from the
   fabricated name on a non-routing domain, never the real domain), names
   (lists by locale, first/last apart, script detected — Hebrew stays Hebrew),
   dates (±180 days, same age bracket), address (city/state/postal prefix
   kept, street fabricated), free text (scrub: the detectors replace only the
   matched spans; or null).
3. **Persona per record**, not per field: the seed is the record; a Contact's
   fabricated name drives its e-mail and name parts; the Contacts of one
   Account share a fabricated domain derived from the Account's fabricated name.
4. **Audit after the write**: re-read a sample of the target, run the detectors
   over every field, one line in the receipt ("0 values that look like a card,
   an ID or a real phone in 200 sampled"); a hit locks the run with Roll back
   offered. Wording everywhere: "fabricated" / "pseudonymized", never
   "anonymous".
5. **Where**: the builder, per field: Fabricate as … / Scrub / Null / Keep;
   "Suggest" fills from discovery; the policy saves with the deployment; the
   dry run (A) is the preview — 5 before/after rows.
6. Locale per rule (IL, US, UK, generic); sampling proposes it.

Order: discovery + six generators + persona + audit; free text and address
second; 1.1 ships with a walkthrough chapter "Seed a dev sandbox from Full Copy,
without the PII".

## Backlog (added 2026-11-04)

- ✅ BUILT the same evening — **Field Cleaner fixes report types (user 2026-11-04: "תוסיף לבאקלוג").**
  Live on npc: the index did NOT list the fixture report type (layout + flows only), so the scan reads
  every custom type (SOAP readMetadata, 1 list + 1 per 10); a column may appear once per type
  (Salesforce refused the first fixture); a section emptied by the fix is dropped with it.
  Was: `ReportType` listed as a blocker with "no modern API" — that note was stale.
  The read is SOAP `readMetadata` (sftk-mdapi.js already does it for Connected
  Apps), the write is REST `deployRequest` (layouts, flows, CMDT already go that
  way), the edit is string-level on the `<sections><columns><field>Obj.Field</field>`
  block: ✂ Remove drops the column, ⇄ Replace renames the field in place, Undo
  redeploys the saved XML, verify re-reads. To settle live on a fixture report
  type in npc before promising: a section left with no columns (accept or
  refuse, as the report fix refuses an only-column edit); joined objects
  (`Contact.X__c` inside an Account report type is NOT this object's field —
  reuse the layout Replace's same-name guard); order of work — reports that use
  the column first, the report type after, since removing the column breaks
  reports built on it. About a day with tests on pinned XML fixtures, a live
  run with CLI truth, and the Undo verified. Not scheduled.
