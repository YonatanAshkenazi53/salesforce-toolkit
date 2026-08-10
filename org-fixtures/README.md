# Org fixtures — repeatable test-data preparation

The Data Deployment test cycle runs on THREE org roles. Each script below
puts an org into a known state via Developer Console → Debug → Open Execute
Anonymous Window (or ask Claude to run them — data prep is fully drivable
through the browser; only the Studio's own buttons need a human).

| Role    | Org (current)            | State after prep |
|---------|--------------------------|------------------|
| SOURCE  | ashkenazy6-dev-ed        | 20 PD + 50 SN + 400 SO, unique names, all lookups filled |
| TARGET  | ashkenazy7-dev-ed        | baseline-aligned, then DIVERGED for reconcile testing |
| SPARE   | orgfarm-c449e108c2-dev-ed| empty or aligned — fresh-target scenarios |

## The cycle

1. `01-seed-source.apex`        → SOURCE gets the canonical dataset (idempotent-ish: run once; re-run duplicates — use 03 first to reset)
2. Deploy baseline via the Studio (parents first: SN → PD → SO — the app's own numbered plan guides this)
3. `02-diverge-target.apex`     → TARGET gets controlled chaos (see traps below)
4. Reconcile in the Studio      → every trap must land in its bucket
5. `04-verify-counts.soql`      → org-side truth, independent of any UI
6. `03-reset-seeded.apex`       → wipe seeded data from an org to restart

## Traps planted by 02 (what the reconcile MUST catch)

- ~57 lookup drifts (every 7th SO repointed)         → Changed, naming Step_Order_Name__c
- 30 deletions (SO-0040..SO-0069)                    → Insert (missing in target)
- 20 impostors (SO-900..SO-919)                      → In target only
- ' SO-0301' leading space + 'so-0302' case flip     → near-miss ≈ chips on the Insert/extra pair
- second 'SO-0100'                                   → duplicate-key disclosure

Files testing (W9): attach any small file to a SOURCE record, flip 📎 on
the node, run — then RUN AGAIN and expect "already present (checksum
match)". The second run is the real test.
