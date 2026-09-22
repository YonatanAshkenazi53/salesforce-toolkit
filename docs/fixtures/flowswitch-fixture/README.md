# ⏻ Flow switches fixture (campaign 2)

Three record-triggered flows on trailheads2 (CLI alias `npc`), after-save on create, one
no-op assignment each, all Active — nothing in the org creates records through them:

| flow | object |
|---|---|
| `SFTK_FS_Test_Acc1` | Account |
| `SFTK_FS_Test_Acc2` | Account |
| `SFTK_FS_Test_Con1` | Contact |

Deploy / reset: `cd docs/fixtures/flowswitch-fixture && sf project deploy start -o npc --source-dir force-app --test-level NoTestRun`
(the flows are Active in the XML; a redeploy adds a version and activates it — the org setting
"Deploy processes and flows as active" is on in this org).

Live run: `node scripts/dev/headless-studio.mjs scripts/dev/live/flow-switches.mjs`
with `MODE=off|on|cycle` (cycle = OFF then ON in ONE session — the remembered active versions
live in the extension's storage, and the harness starts a fresh profile per run, so a separate
`MODE=on` run cannot see what an earlier `MODE=off` run remembered), `PICK=^SFTK_FS_Test`,
`ORGS=npc,npc2`, `SCAN_ONLY=1`.

## Findings log (2026-09-22/23)

- ✅ verified: the panel groups the org's 23 triggered flows by object (+ ⏰ Scheduled), rows
  read "After-save ON v1 API 64"; the typed OFF confirmation says automation stops for everyone,
  records created while off are never processed retroactively, active versions are remembered.
- ✅ fixed: the report said "✅ 3 switched OFF" straight from the PATCH result — nothing re-read
  the org. Now one FlowDefinitionView query after the PATCHes decides: confirmed flows are ✅
  "verified by re-reading the org" and remembered; a flow the org still reads the other way, or an
  org that cannot be re-read, is ❌ and never remembered (pins: flowswitch-live-0922).
- ✅ verified: OFF → CLI ActiveVersionId null for all three; ↻ Reload shows "OFF↩ v1" (the ↩ =
  a remembered version); ON in the same session offers "restores v1 (was active before the
  switch-off)"; ON in a fresh session offers "activates LATEST v1 — no record of what was active
  before" (honest); after ON the CLI shows the versions active again.
- Not exercised: two orgs at once, a flow with several versions where the remembered one is not
  the latest (would prove the "restores vN" path chooses the remembered version), a refused PATCH.
