# Complex-deployment fixture + live test runbook

Everything here is prefixed `SFTK CX`. It exists to test Data Deployment against
what breaks vanilla Salesforce deployments — hierarchies, self-lookups, junctions,
pricebooks, person accounts, duplicates, files, validation rules — in two real
trial orgs, driven headlessly by Claude (or by hand).

## Orgs (as of 2026-09-22)

| alias | org | role | CLI |
|---|---|---|---|
| `npc`  | trailheads2.my.salesforce.com — **EXPIRED 2026-09-26**; log a new trial in under the same alias and run `bash docs/fixtures/rebuild-source.sh npc` | source | `sf org login web --alias npc` |
| `npc2` | trailheads4.my.salesforce.com | target | `sf org login web --alias npc2 --instance-url https://trailheads4.my.salesforce.com` |

Both are trials → the Toolkit classifies them `dev`; use **🛑 Guard as production**
(Connected Orgs) to exercise the typed production gates.

## Files

| file | what |
|---|---|
| `seed-source.apex` | source fixture: 10 Accounts (3-level hierarchy, dup pair, unicode, 2 person accounts), 9 Contacts (ReportsTo chain, dup pair), Opps + line items + contact roles, Cases (+ parent, comments), Campaign hierarchy + members (Contact and Lead), Leads, Tasks/Events (polymorphic), Assets (+ parent), Contract, Order + items, Individual, 2 files |
| `seed-target.apex` | target state a real org has BEFORE a deployment: drifted parent, only-in-target record, dup twin, a same-name Contact under the wrong account, catalogue products + standard pricebook entries |
| `target-metadata/` | two target-only validation rules that reject exactly one Account (Retail, no Website) and one Contact (Lab lead, no Phone). Deploy: `cd target-metadata && sf project deploy start --source-dir force-app --test-level NoTestRun -o npc2` |
| `profiles.json` | five deployments in `sftk-profile` export format, imported by the harness (`h.importProfiles`) |
| `cleanup.apex` | removes everything `SFTK CX` from an org (children first) |
| `seed-volume.apex` / `cleanup-volume.apex` | the HUGE tree: 6,000 Accounts × 2 Contacts × 1 Opportunity (`SFTK VOL`), seeded in four transactions (substitute `__PASS__`/`__FROM__`/`__TO__`: acc 0 6000 · con 0 3000 · con 3000 6000 · opp 0 6000); profile `SFTK VOL — Accounts` |

## Reset the target between runs

```bash
sf apex run -f docs/fixtures/complex-deployment/cleanup.apex -o npc2
sf apex run -f docs/fixtures/complex-deployment/seed-target.apex -o npc2
```

## Run the live tests

```bash
node scripts/dev/headless-studio.mjs scripts/dev/live/run-accounts-tree.mjs
```

The harness (`scripts/dev/headless-studio.mjs`) starts a FRESH headless Chrome
profile every run, loads the repo as an unpacked extension over the DevTools pipe,
logs both orgs in through the CLI's frontdoor links (each in its own tab — the
extension finds sessions by open tabs), opens Data Studio, accepts the licence,
kills the tour, answers native `confirm()` dialogs, and logs page exceptions.
Screenshots land in `%LOCALAPPDATA%\Temp\sftk-headless-shots`. Kill stray
`chrome.exe` before a run. Other scripts in `scripts/dev/live/` inspect History,
the Contact buckets, the child-scan error path, and the source-only pages.

## Findings log (what the fixture caught)

- ✅ fixed: 3-level Account hierarchy arrived flat at level 2 — self-lookups now connected after insert (engine late-link pass).
- ✅ fixed: same-name child records (two "Mia Schmidt") vanished from every bucket with no word — child scans now record `dupKeys` and warn.
- ✅ fixed: Field Mapping said "No connected orgs" above the connected source's fields.
- ✅ fixed: Deploy page silent on an offline target; the builder tree squeezed by a CSS class collision.
- ✅ fixed: objects with no `Name` field failed the child scan with a raw HTTP 400 — keys can be relationship paths now (Opportunity.Name + Contact.Name); the scan picks that fallback from the describe and says so.
- ✅ fixed: unconfigured lookups at objects outside the deployment were dropped on insert (every Opportunity lost its Pricebook) — they match by Name like ← update; only createable, non-polymorphic, named objects; a broken bridge is a note, not a dead object.
- ✅ fixed: a child Case and its parent Case inserted by two STEPS of one Deploy run were never linked — one run ledger (shared id map + waiting lookups) across all steps that write into the target, closed before History.
- ✅ fixed: every line item was rejected ("specify either unit price or total price, not both") — TotalPrice is left out, the target computes it.
- ✅ fixed: Contract and Order were inserted again on every pass (autonumber-only name) — an autonumber name is not a usable key; the scan falls back to parent + subject-like field and points to the 🪪 identity field. Two passes now leave 1 Contract, 1 Order.
- ✅ fixed: a child inserted under an EXISTING parent was attached by re-matching the parent's key with one exact value (OrderItem lost its Order once Order had a composite key) — attached by the scan's own srcId→tgtId pairing now; key matching is the fallback.
- ✅ fixed: PricebookEntry (Name = product name, shared by every price book) fell out of every bucket — a child scan whose single key collides for most rows re-keys by the parents (Product2.ProductCode + Pricebook2.Name) and says so.
- ✅ verified: Price books, Products & prices, Campaigns (+members, parent link connected after insert), Leads deploy; CampaignMember needs Leads deployed first — the parents card says so.
- 🟡 by design, worth revisiting for big trees: grandchildren (line items, contact roles, comments, order items) are not selectable while their parent is still missing in the target — a two-pass deployment (R5 rule).
- ✅ fixed: 🔎 Scan all children; 🔄 Refresh re-reads children read before; the run log stays after the post-run repaint.
- ✅ fixed (huge tree, run vol1): "✓ All listed" over "5,000 of 6,000" selected the 300 painted rows — now the whole list; the target's fuzzy name duplicate rule blocked 100/300 Accounts — Duplicate rules engine setting (Respect / Bypass) + the friendly error names it.
- ✅ fixed (huge tree, run vol2): Bulk API 2.0 runs duplicate rules and has no bypass header → a bypass run stays on Collections; and Bulk result rows never correlated ("no result row" ×5,000 while failedResults held every error) — Salesforce echoes "200000" as "200000.0"; values are compared as values now.
- ✅ fixed: in-tree lookups shown as informational rows in the builder.
- ✅ verified (huge tree, run vol3, two passes): 6,000 Accounts, 6,000 Opportunities, 10,250 of 12,000 Contacts (5,000-per-pass cap; a third pass takes the rest), every child linked, both runs success, ~2.5 min per 15,000 records on synchronous calls with duplicate rules bypassed.
- 🔴 open: builder hides in-tree lookups from Lookup Resolution — should show them as informational rows ("connected after insert").
- ✅ verified live: ↻ Retry failed ticks the failed record on the Deploy page; the parents-first journey (➕ Deploy Individual first → journey page → deploy → ‹ Back) returns with the parent ✓ in sync and the count down by one.
- ✅ verified live: ↩ Roll back of a run that inserted 6 Accounts — typed ROLLBACK, "Account · 6 deleted ✓ verified", target back to its seeded 4. Two findings fixed on the way: a child object Salesforce refuses to query (ActionableListMember, implementation restriction) kept every created parent — now reported without blocking, with "delete these anyway — I checked" for truly unreadable children; person-account contacts were counted as failed deletions — they go with their Account.
- ✅ final rerun: rollback ✅ success, "Contact · ✓ verified 2 left alone", Account · 6 deleted ✓ verified.

Campaign complete 2026-09-22. Note: trailheads4 still holds the SFTK VOL volume data (6,000 Accounts etc.) — `cleanup-volume.apex` removes it in 9,000-account passes.

## Campaign 2 - Org Compare, Sync Ring and the Deploy page on the same data (2026-09-23)

Scripts: `scripts/dev/live/consistency.mjs` (SKIP_OC=1 skips Org Compare; PROFILE=...) and
`scripts/dev/live/bucket-dump.mjs` (the engine's buckets next to the Deploy page's).

- verified: Org Compare (no filter, by Name) on Account / Contact / Opportunity: 10,892 vs 10,879
  Accounts, 15 missing, 2 only in target, 100%; Contact 16,874 vs 15,118, 1,756 missing; the
  🚀 Deploy button per row. Its scope is the whole object, so its numbers are not the profile's.
- verified: the Sync Ring needs a source of truth (topbar SOURCE) and a ticked target; the
  Accounts-tree cell then reads "7 missing · 2 changed · 2 only in target", and the Deploy page's
  root buckets for the same deployment read 7 / 2 / 2 in the same session.
- fixed: they did NOT agree at first - Ring 7, Deploy 8 a minute later. The ring scan had
  auto-learned a match on an AMBIGUOUS key (two source Accounts "SFTK CX Duplicate Name", one in
  the target): the pinned twin matched, the other twin became a confident "to insert" - and that
  insert would have created a duplicate. Pairs on keys the scan lists in dupKeys are never learned
  now (pins: scan-learn-dupkeys-0923); Match Review can pin them by hand.
- note: the root scan still pairs ONE of the twins as "changed" and warns (dupKeys: 3 rows); the
  other twin is in no bucket, as before. Person accounts "Person SFTK CX One/Two" match the
  `%SFTK CX%` filter and count among the 7 missing.

## Campaign 2 - Sequences (2026-09-23)

Script: `scripts/dev/live/sequences.mjs` (STEPS="SFTK CX - Leads,SFTK CX - Campaigns", SCAN_ONLY=1,
ROLLBACK=1 rolls the run back from History in the same session). Reset the target afterwards
with cleanup.apex + seed-target.apex.

- fixed: "Run" wrote on the click - no summary, no acknowledgement, no typed org name for a
  production target, while a sequence takes NO per-record selection. It now confirms (steps with
  object / children / insert-or-upsert, the stakes, an acknowledgement box) and asks for the org
  name when the target is production (pins: sequence-confirm-0923).
- verified: Leads (3 created) then Campaigns (2 campaigns, parent connected after insert; 2 of 5
  members created, 3 refused by Salesforce because their Contacts are not in the target - the
  result says which lookups were null and quotes Salesforce; status "partial"); CLI agrees.
- verified: "Roll back sequence" from History: plan lists CampaignMember (permanent, no Recycle
  Bin), Campaign, Lead with the duplicate rule that could reject it; typed ROLLBACK; every object
  deleted and re-read ("verified - nothing from the run remains"); CLI 0 / 0 / 0.
- note: the History card of a sequence run carries the FIRST step's name ("SFTK CX - Leads"),
  not the sequence's name and step count.
