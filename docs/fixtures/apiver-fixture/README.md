# ⚙ API versions fixture (campaign 2)

Three trivial autolaunched flows on trailheads2 (CLI alias `npc`), each one assignment,
nothing calls them:

| flow | API | status |
|---|---|---|
| `SFTK_AV_Test_A` | 60.0 | Active |
| `SFTK_AV_Test_B` | 62.0 | Active |
| `SFTK_AV_Test_C` | 58.0 | Draft |

Deploy / reset: `cd docs/fixtures/apiver-fixture && sf project deploy start -o npc --source-dir force-app --test-level NoTestRun`
(a deploy over an Active flow adds a version; over a Draft it rewrites the Draft in place —
to get back to the table above, delete the flows first:
`sf project delete source --metadata Flow:SFTK_AV_Test_A,Flow:SFTK_AV_Test_B,Flow:SFTK_AV_Test_C -o npc --no-prompt`
deletes them from the org AND removes the local files — restore those with `git checkout -- docs/fixtures/apiver-fixture`).

Live run: `node scripts/dev/headless-studio.mjs scripts/dev/live/api-versions.mjs`
with `TARGET=67.0` (an option value of the target list; default = the LAST option, which is the
oldest — always pass it), `PICK=^SFTK_AV_Test` (rows to tick), `ORGS=npc,npc2`, `SCAN_ONLY=1`.

## Findings log (2026-09-22)

- ✅ verified: the panel lists 243 flows of the org, 177 locked (managed etc.), the fixture rows
  read "API 58 · 9 behind" etc.; the typed CHANGE confirmation names every (flow, org) pair with
  from→to and (active)/(Draft), says all-or-nothing per org; scan-only writes nothing.
- ✅ verified: A 60→67 and B 62→67 — one package, v2 created and ACTIVE, verified by re-reading;
  CLI agrees (v1 Obsolete, v2 Active 67).
- ✅ fixed: the Draft flow C was rewritten IN PLACE (v1 now at API 67, still Draft) but reported
  "no new version appeared … nothing changed for this flow". The verdict now recognises the
  in-place rewrite (same version number, not active before, at the target now) as verified.
- ✅ fixed: the summary read "2 flow(s) changed across 0 org(s); 1 org(s) unchanged" — an org
  whose package was accepted counted as unchanged because one verdict was a warning. Now:
  "N flow(s) changed and verified, M with a warning above, across K org(s); J org(s) refused
  the package (unchanged)".
- ✅ verified: downgrades 67→66 and 66→65 (the case that used to fail before the package was
  stamped with the org's own release): A and B got v3/v4 ACTIVE at the target, C (Draft) was
  rewritten in place; the log reads "3 flow(s) changed and verified, across 1 org(s); 0 org(s)
  refused the package"; CLI agrees after each run.
- 🟡 UI nit, left: the target list offers both "67.0 (this org's release)" and a plain "67".
- Not exercised: a package Salesforce refuses (all-or-nothing wording on failure), two orgs at
  once (`ORGS=npc,npc2` — the fixture would have to exist in trailheads4 too), an org whose
  "Deploy processes and flows as active" setting is off (the ⏻ activation path).

State after the campaign: A v4 Active 65, B v4 Active 65, C v1 Draft 65 (older versions Obsolete).
