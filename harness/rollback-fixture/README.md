# ↩ Rollback live test — fixture and runbook

Dev-org test for the data-deployment rollback (Data Studio → History → ↩ Roll back).
Source: **ashkenazy6**. Target: **ashkenazy7**. Nothing here touches any other org.
This folder is not shipped (the packer copies top-level files only).

## 0. One-time: log the two orgs into the Salesforce CLI (you, in the browser)

```bash
sf org login web --alias ashkenazy6 --instance-url https://login.salesforce.com
```

```bash
sf org login web --alias ashkenazy7 --instance-url https://login.salesforce.com
```

## 1. Load the fixture (Claude runs these once the orgs are logged in)

```bash
sf data import tree --target-org ashkenazy6 --files harness/rollback-fixture/source-accounts.json
```

```bash
sf data import tree --target-org ashkenazy7 --files harness/rollback-fixture/target-accounts.json
```

What lands:

| Org | Account | Purpose |
|---|---|---|
| ashkenazy6 | SFTK Rollback Fixture - Alpha (+2 Contacts) | exists in the target too, with different Industry/Phone → Reconcile overwrite test |
| ashkenazy6 | SFTK Rollback Fixture - Beta (+2 Contacts) | not in the target → insert then roll back (delete) |
| ashkenazy6 | SFTK Rollback Fixture - Gamma (+2 Contacts) | as Beta, plus a child added AFTER the run → the parent must be KEPT |
| ashkenazy7 | SFTK Rollback Fixture - Alpha (Retail, +972-3-999-9999, +1 Contact) | the drifted twin; must be exactly this again after the rollback |
| ashkenazy7 | SFTK Control - Do Not Touch | must never change |

## 2. Phase 1 — insert, then roll back (the delete path)

1. Reload the unpacked extension. Accept the new terms (version 2).
2. Data Studio → a deployment with tree **Account → Contacts**, source ashkenazy6, target ashkenazy7.
   Pick records **Beta and Gamma only** (not Alpha). Write mode **Insert**. Leave **📸 restore point** ticked.
3. ▶ Run Transfer. In the run log expect, before the writes:
   `📸 Restore point: reading N Account in ashkenazy7 (Ids only …)` and the same for Contact, then `✅ … restore point saved`.
4. After the run, **add a Contact by hand** under the new *Gamma* account in ashkenazy7 (any name). This is "someone else's later work".
5. History → the run's card shows **↩ Roll back**. Click it. Expect in the plan:
   - Contact: delete 4 · Account: delete 1 (Beta) · **1 kept** — Gamma, "other records were added under them after the run (1 Contact)".
   - `✅ No active validation rule … (every category was checked)` or a `❔ Could not check` line — never a green line above a "could not check".
   - Type `ROLLBACK`, click ↩ Roll back.
6. Expect: Contact `4 deleted`, Account `1 deleted`, verify lines `verified — nothing the rollback acted on remains` with `1 record(s) were deliberately left alone`. The card flips to **↩ Rolled back**; a new **↩ rollback** entry appears with `✓ verified`.
7. Check in ashkenazy7: Beta and its 2 Contacts are in the Recycle Bin; Gamma and your hand-added Contact still exist; Alpha and Control untouched.

## 3. Phase 2 — overwrite, then roll back (the restore path)

1. Same deployment, **Reconcile** view, scan. Alpha should show as **drift** (Industry Retail vs Technology).
2. Select Alpha for **Overwrite** and run. Expect the 📸 lines in the reconcile log first.
3. Check in ashkenazy7: Alpha now has Industry Technology, Phone +972-3-000-0001.
4. History → ↩ Roll back on the reconcile entry. Expect: Account `restore 1 overwritten`, `0` to delete. Type the word.
5. Expect: `1 restored`, `verified — nothing from the run remains`. Alpha is back to Retail / +972-3-999-9999 / alpha-old website; "Alpha Existing" Contact still there; Control untouched.

## 4. What to paste back to Claude

- The run log lines that start with 📸.
- The whole ↩ Roll back plan text (copy the modal) and the final 🏁 / ⚠ line.
- The History card text of the run and of the rollback entry.
- Anything that looked wrong, in your words.

## 5. Cleanup (Claude runs this when you say so)

```bash
sf data query --target-org ashkenazy7 --query "SELECT Id FROM Account WHERE Name LIKE 'SFTK Rollback Fixture%' OR Name LIKE 'SFTK Control%'" --result-format csv > harness/rollback-fixture/_ids7.csv
```

```bash
sf data delete bulk --target-org ashkenazy7 --sobject Account --file harness/rollback-fixture/_ids7.csv --wait 5
```

```bash
sf data query --target-org ashkenazy6 --query "SELECT Id FROM Account WHERE Name LIKE 'SFTK Rollback Fixture%'" --result-format csv > harness/rollback-fixture/_ids6.csv
```

```bash
sf data delete bulk --target-org ashkenazy6 --sobject Account --file harness/rollback-fixture/_ids6.csv --wait 5
```

Deleting an Account deletes its Contacts with it. The fixture uses the marker
`sftk-rollback-fixture` in every Description/Title, so nothing else matches.
