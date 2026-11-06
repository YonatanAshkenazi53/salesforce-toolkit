# Backlog

Every ask the owner fires in chat lands here the same day, with how it was verified when it closed.
"Verified" means a live run, a test that pins it, or the owner's own hands — never "it should work".
Dates are absolute. Newest asks at the top of each list.

## Open

| Ask (owner's words) | Date | Status | How it will be verified |
|---|---|---|---|
| "matching of parents selection should have all of the features from the pic above" / "כולל ההמלצות וכ"ו" — the Parents synced rows (DandBCompany, OperatingHours, Individual: "matched by Name") get the deployment's own Matching kit: Single field / Composite / External ID, Match on source ↔ target, Test this key, Suggestions | 2026-11-07 | in progress | harness on the fixture deployment: a parent's key changed to a composite, tested, the suggestion taken; the alignment check uses the chosen key; tests pin it |
| Deploy page: "we dont need this message. we need the behevior" — the "✓ Your N ticks from before is back…" card goes; the ticks stay remembered | 2026-11-07 | in progress | the card is gone from the page; the remembered-ticks tests still pass |
| ▸ Record dialog, empty fields: "by default זה יסומן בתור ריק אלא אם כן המשתמש אמר אחרת. כמובן שאפשר לתת לו לבטל ולהכניס ערך" — a field empty in the source shows as ∅ empty by default, a typed value takes it back | 2026-11-07 | in progress | harness: open ▸ record on a fixture record, the empty rows carry the ∅ state, typing a value lifts it; a test pins the markup |
| ▸ Record dialog: the source record could not be read — "HTTP 400 … No such column 'SFTK_Dbg_Count__c' on entity 'Account'" (screenshot 2026-11-07). The describe lists a field the running user cannot query; the read should drop the columns it cannot read and say which | 2026-11-07 | open | harness on npc: the dialog shows the record's values with the unreadable column named in a note |
| "אני רוצה לנסות הכל בלייב. חשוב שלא תפספס דברים" — a demo field in npc with EVERY reference type that was live-tested, blockers and mentions alike, reports and report types included | 2026-11-07 | in progress: scratchpad `blk/live-fix.mjs` + `live-fix2.mjs` + `live-fix3.mjs` are in the org (13 blockers, 5 mentions, a private report); `live-fix4.mjs` adds the rest | the owner's own scan in Chrome; a read-only harness scan lists every group |
| Clean the demo fixture out of npc when the owner is done (`live-clean4` → `live-clean2` → `live-clean`) | 2026-11-07 | waiting for the owner's word | `fieldsLeft()` and the Tooling counts print none; Standard_Account_Duplicate_Rule untouched |
| master fast-forward to the 1.1 branch | 2026-11-02 | waiting for the owner's word | `git log master..work/1.1-dryrun-pii` empty |
| 1.1.0 Chrome Web Store submission (`dist/salesforce-toolkit-v1.1.0-store.zip` is packed) | 2026-11-02 | waiting for the owner's word; the owner uploads | store listing shows 1.1.0 |
| LinkedIn post (`dist/linkedin/post.md`) | 2026-11-02 | drafted; the owner posts | — |
| Walkthrough video chapters for 1.1 | 2026-11-02 | not started | recorded through scripts/dev/video, dark theme |
| Delete-zone count refresh after a fix (Field Cleaner) | 2026-11-02 | not started | harness: fix one item, the gate's count drops without a re-scan |
| Dark-mode Cancel button in sftkConfirm | 2026-11-02 | not started | harness screenshot, dark |
| WhatsApp RTL bug (Hebrew text direction in the share text) | 2026-11-02 | not started | the owner's phone |
| Paths (picklist), record-type picklist values, controlling picklists, search layouts: none of them block, none are scanned — decide whether the mentions list should read them | 2026-11-07 | open question for the owner | — |

## Done (verified)

| Ask | Date | Closed | Verified by |
|---|---|---|---|
| "תכין לי טסט נסיון בא לי לראות בלייב" — demo field Account.SFTK_Live_Blk__c with one of each blocker the index never returns, an active flow the tool rewrites, the silent mentions | 2026-11-06 | 2026-11-06, commit 741c6eb | read-only harness scan: 13 blockers, 5 mentions, no bulk buttons on 1 rewritable flow |
| The demo scan missed an unassigned compact layout and the object's own quick action | 2026-11-06 | 741c6eb | harness scan lists both; test/fc-blockers-1106.test.mjs pins the reads |
| "אנחנו חייבים להוציא את השיפור/תיקון הזה" — every blocker outside the dependency index gets a scan leg; Lightning page → blocker, email template → mention; Process Builder shown, never rewritten | 2026-11-06 | b39d582 | scripts/dev/live/field-cleaner-blockers.mjs on npc: 12 blocker groups + 2 mentions, PB note, gate 11 by hand; 3,658 tests |
| "תבדוק הכל" / Process Builder / workflow / restriction rules — the full live blocker map (60+ cases) | 2026-11-06 | 2026-11-06 | destructive deletes in npc, Salesforce's own refusal text; results in scratchpad blk/results-*.json and docs/FEATURES.md |
