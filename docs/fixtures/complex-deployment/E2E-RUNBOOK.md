# End-to-end data deployment — runbook for a hand-driven test

Prepared 2026-09-23. Everything below is in place; nothing else needs seeding.

## What is where

| org | alias | role | state |
|---|---|---|---|
| trailheads2 | `npc` | source | the full SFTK CX fixture: 10 Accounts (3-level hierarchy, a duplicate-name pair, unicode, 2 person accounts), 9 Contacts, 4 Opportunities (+ line items, contact roles), 6 Cases (+ comments), 2 Campaigns (+ 5 members), 3 Leads, 3 Products, 1 Price book, Assets, Contract, Order, Individual, 2 files |
| trailheads4 | `npc2` | target | the seeded baseline a real target has: 4 Accounts (one drifted parent, one only-in-target, the duplicate twin, a wrong-parent company), 2 Contacts, catalogue products; two validation rules that reject exactly one Account (Retail without Website) and one Contact (Lab lead without Phone); 24,000 SFTK VOL rows from the volume test (ignore them) |

## Steps

1. Open both orgs in Chrome (any tab in each), then open Data Studio from the Toolkit.
2. Data Deployment → import `docs/fixtures/complex-deployment/profiles.json` (6 deployments arrive).
3. Open **SFTK CX — Accounts tree** → 🚀 Deploy. Expected after the scan, root object Account:
   **7 to insert · 1 changed · 2 only in target · ⚠ 2 ambiguous** (the Sync Ring cell shows the same 7 · 1 · 2 · ⚠2 —
   before campaign 3 phase 5 it read 7 · 2 · 2, one duplicate copy paired arbitrarily).
   Nothing is ticked for you.
4. Tick what you want. A good first run: every insert on Account, then 🔎 Scan all children and
   tick the Contacts and Opportunities. Deploy. Expect:
   - the Retail Account without a Website and the Lab lead Contact without a Phone to be REFUSED
     by the target's validation rules, named in the result with Salesforce's text;
   - the hierarchy connected after insert (Berlin Lab → Europe → Holding);
   - the two "SFTK CX Duplicate Name" Accounts listed under ⚠ Ambiguous, not guessed: 📌 pair one with
     the target's copy and the other becomes an insert (live 2026-09-29: two target records, distinct Ids).
5. History → ↻ Retry failed (fix the two records in the source first, or accept the refusal).
6. History → ↩ Roll back the run: type ROLLBACK; expect every inserted object deleted and
   "verified — nothing from the run remains"; person-account Contacts are left alone (they go
   with their Account).
7. Then the other deployments in this order: Price books → Products & prices → Leads →
   Campaigns (CampaignMember needs the Leads and the Contacts first).

## Reset the target between runs

```bash
sf apex run -f docs/fixtures/complex-deployment/cleanup.apex -o npc2
sf apex run -f docs/fixtures/complex-deployment/seed-target.apex -o npc2
```

## If something looks wrong

The engine's own view of every bucket (names per bucket, dupKeys) for a deployment:

```bash
node scripts/dev/headless-studio.mjs scripts/dev/live/bucket-dump.mjs
```
