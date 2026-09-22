# Dependencies fixture: a 4-level subflow chain

`SFTK_Dep_Test_Account_Trigger` (record-triggered, Account) → `SFTK_Dep_Test_L1` → `L2` → `L3` → `L4`, all Active, on trailheads2 (alias `npc`).

Deploy / reset: `cd docs/fixtures/dep-test-flows && sf project deploy start -o npc --source-dir force-app --test-level NoTestRun`
(a redeploy after a deletion recreates the chain; over an existing Obsolete version it adds an Active one).


Live run: `node scripts/dev/headless-studio.mjs scripts/dev/live/dependencies.mjs` — read-only:
the tree under the trigger, 🧨 blast radius, 🔗 chain, "What uses…", ⬇ Export. With `DELETE=1`
and `CHOICE=cancel|ignore|parents` it right-clicks L4 → "Select this flow for deletion" → Flows
tab → 🗑 Delete and takes that choice at the parents modal. Redeploy the fixture afterwards.

## Findings log (campaign 2, 2026-09-23)

- ✅ verified: the tree shows all five levels (the old 3-level cap is gone); 🧨 on the trigger
  lists Account (trigger), Account.Name, calls L1; 🔗 on L2 lists L3+L4 downstream and L1+trigger
  upstream, 0 cycles; "What uses SFTK_Dep_Test_L4" finds L3 (×1), "Account" finds 54 flows and
  says 177 managed flows were not searchable; scan-only writes nothing.
- ✅ verified: the delete path warns about ACTIVE flows (backup offered), then the parents modal
  lists the whole calling chain transitively (L4←L3←L2←L1←trigger) with "chain deeper than 3
  levels" and Cancel works.
- ✅ fixed: "Proceed anyway, ignore broken parents" on L4 — Salesforce refused (DEPENDENCY_EXISTS
  "referenced by at least one subflow element … SFTK_Dep_Test_L3"): the raw JSON was shown, and the
  tool had switched L4 OFF for the attempt and left it off while saying "0 deleted, 1 failed".
  Now the version is switched back ON on a refused delete and the message says so; the error
  reads "Salesforce refuses to delete this flow: another flow still calls it as a subflow (L3)";
  the modal explains the rule.
- ✅ fixed: "Deactivate + delete selected parents" with all parents ticked — "4 deleted, 1 failed":
  the selected child went first and was refused while its parents still existed. Parents are
  deleted first now, and anything refused for a subflow reference is retried once its callers are
  gone. Rerun: all six versions deleted (trigger, L1, L2, L3, L4 v1+v2), CLI shows 0 flows.
- Not exercised: the scan-before-delete / stale-map modals (the map had just been read), backup
  download and Restore mode (no download sink in headless), the interviews modal (no interviews).
