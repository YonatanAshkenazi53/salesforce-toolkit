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
- 🔴 open: objects with no `Name` field (OpportunityContactRole, CaseComment, OrderItem, CampaignMember) fail the child scan with a raw HTTP 400 — the scan needs a describe-based fallback key and a plain message.
- 🔴 open: no "scan all children" on the Deploy page; 🔄 Refresh does not re-scan previously scanned children; the run log is wiped by the post-run repaint.
- 🔴 open: builder hides in-tree lookups from Lookup Resolution — should show them as informational rows ("connected after insert").
- ⏳ not yet run: Campaigns / Products / Leads / Price books deployments, parents-first flow, Retry failed, rollback of a run, huge trees (thousands of records, >5,000 per list).
