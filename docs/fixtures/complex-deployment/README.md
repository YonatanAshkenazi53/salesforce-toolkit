# Complex-deployment fixture + live test runbook

Everything here is prefixed `SFTK CX`. It exists to test Data Deployment against
what breaks vanilla Salesforce deployments — hierarchies, self-lookups, junctions,
pricebooks, person accounts, duplicates, files, validation rules — in two real
trial orgs, driven headlessly by Claude (or by hand).

## Orgs (as of 2026-09-22)

| alias | org | role | CLI |
|---|---|---|---|
| `npc`  | trailheads2.my.salesforce.com | source | `sf org login web --alias npc` |
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
- 🔴 open: no "scan all children" on the Deploy page; 🔄 Refresh does not re-scan previously scanned children; the run log is wiped by the post-run repaint.
- 🔴 open: builder hides in-tree lookups from Lookup Resolution — should show them as informational rows ("connected after insert").
- ⏳ not yet run: Campaigns / Products / Leads / Price books deployments, parents-first flow, Retry failed, rollback of a run, huge trees (thousands of records, >5,000 per list).
