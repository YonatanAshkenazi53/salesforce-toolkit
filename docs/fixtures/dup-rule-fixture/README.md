# Duplicate-rule fixture (QA of Data Deployment's "Duplicate rules" setting)

`Account.SFTK_QA_Block` — an active duplicate rule on Account that **blocks** an insert
the standard Account matching rule (`Standard_Account_Match_Rule_v1_0`: fuzzy name plus a
billing/phone/website field) calls a duplicate. The org's own standard rule only *alerts*
on insert, which an API write never sees — so without this rule the setting cannot be
proved live.

Used by `scripts/dev/live/engine-options.mjs` against **trailheads4 (npc2)**: the script
deploys the rule, creates one near-duplicate target Account ("SFTK CX Berlin Labs",
Berlin — the source has "SFTK CX Berlin Lab", Berlin), runs the Accounts tree with
*Respect* (the insert of Berlin Lab must fail with DUPLICATES_DETECTED, named in the run
log and in History), then with *Bypass* (it must land), rolls the run back, deletes the
near-duplicate and removes the rule again (`destructiveChanges`). Nothing of it stays.

Deploy by hand: `cd docs/fixtures/dup-rule-fixture && sf project deploy start -o npc2 --source-dir force-app`
Remove by hand: `sf project delete source -o npc2 -m DuplicateRule:Account.SFTK_QA_Block --no-prompt`
