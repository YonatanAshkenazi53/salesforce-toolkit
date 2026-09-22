#!/usr/bin/env bash
# Rebuild the Field Cleaner fixture on an org (default alias: npc) from scratch.
# Each flow version deploy creates the next version number; the flow runs (and
# fails on purpose) after v1–v3 so failed interviews exist. Safe to re-run: a
# field / permission set that already exists is simply redeployed.
#   bash docs/fixtures/field-cleaner-fixture/rebuild.sh [alias]
set -e
ORG="${1:-npc}"
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/base"
echo "== base (field + permission set)"
sf project deploy start -o "$ORG" --source-dir force-app --test-level NoTestRun >/dev/null
sf org assign permset -o "$ORG" --name SFTK_FC_Test_Access >/dev/null 2>&1 || true
mkdir -p force-app/main/default/flows
for v in 1 2 3 4; do
  echo "== flow v$v"
  cp "$HERE/versions/SFTK_FC_Test_Flow.v$v.flow-meta.xml" force-app/main/default/flows/SFTK_FC_Test_Flow.flow-meta.xml
  sf project deploy start -o "$ORG" --source-dir force-app/main/default/flows --test-level NoTestRun >/dev/null
  if [ "$v" -le 3 ]; then
    n=$([ "$v" -eq 3 ] && echo 1 || echo 2)
    for i in $(seq 1 "$n"); do
      sf api request rest "services/data/v64.0/actions/custom/flow/SFTK_FC_Test_Flow" --method POST --body @"$HERE/inputs.json" -o "$ORG" >/dev/null 2>&1 || true
    done
  fi
done
rm -f force-app/main/default/flows/SFTK_FC_Test_Flow.flow-meta.xml
echo "== state"
sf data query -q "SELECT VersionNumber, Status FROM Flow WHERE Definition.DeveloperName = 'SFTK_FC_Test_Flow' ORDER BY VersionNumber" -o "$ORG" --use-tooling-api 2>/dev/null | tail -n +1
sf data query -q "SELECT COUNT() FROM FlowInterview WHERE InterviewLabel LIKE 'SFTK_FC_Test_Flow%'" -o "$ORG" 2>/dev/null | tail -3
