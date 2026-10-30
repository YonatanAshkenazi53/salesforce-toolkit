#!/usr/bin/env bash
# Rebuild EVERY source-org fixture on a fresh org, in one go (trailheads2 expired 2026-09-26).
#   1. sf org login web --alias npc           (the new trial)
#   2. bash docs/fixtures/rebuild-source.sh npc
# Afterwards: docs/fixtures/complex-deployment/profiles.json still names the OLD source URL —
# the harness's importProfiles re-points them (see README), or edit the sourceOrg fields.
set -e
# python on this PC is the launcher only (py -3); the scripts read JSON through $PY
PY="py -3 -I"; python -c "pass" >/dev/null 2>&1 && PY=python   # Windows ships a "python" Store stub that only prints an error
ORG="${1:-npc}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
echo "== 1/7 data deployment source fixture (SFTK CX)"
sf apex run -f docs/fixtures/complex-deployment/seed-source.apex -o "$ORG" | grep -E "Executed|rror" || true
echo "== 2/7 Field Cleaner fixture (field, permset, flow v1-v4, failed interviews) + flow 2"
bash docs/fixtures/field-cleaner-fixture/rebuild.sh "$ORG"
(cd docs/fixtures/field-cleaner-fixture/flow2 && sf project deploy start -o "$ORG" --source-dir force-app --test-level NoTestRun >/dev/null && echo "flow2 deployed")
echo "== 3/7 API versions fixture (3 flows)"
(cd docs/fixtures/apiver-fixture && sf project deploy start -o "$ORG" --source-dir force-app --test-level NoTestRun >/dev/null && echo "apiver deployed")
echo "== 4/7 Flow switches fixture (3 record-triggered flows)"
(cd docs/fixtures/flowswitch-fixture && sf project deploy start -o "$ORG" --source-dir force-app --test-level NoTestRun >/dev/null && echo "flowswitch deployed")
echo "== 5/7 Dependencies fixture (4-level subflow chain)"
(cd docs/fixtures/dep-test-flows && sf project deploy start -o "$ORG" --source-dir force-app --test-level NoTestRun >/dev/null && echo "dep chain deployed")
echo "== 6/7 Lightning page fixture"
(cd docs/fixtures/lightning-page-fixture && sf project deploy start -o "$ORG" --source-dir force-app --test-level NoTestRun >/dev/null && echo "record page deployed")
echo "== 7/7 popup-tools fixture: two Identity users, a group, A gets the permset + group"
PID=$(sf data query -q "SELECT Id FROM Profile WHERE Name='Identity User'" -o "$ORG" --json | $PY -c "import json,sys; r=json.load(sys.stdin)['result']['records']; print(r[0]['Id'] if r else '')")
DOM=$(sf org display -o "$ORG" --json | $PY -c "import json,sys; import re; u=json.load(sys.stdin)['result']['instanceUrl']; print(re.sub(r'^https?://','',u).split('.')[0])")
for n in a b; do
  N=$(echo $n | tr a-z A-Z)
  sf data create record -s User -v "Username=sftk.test.$n@$DOM.sftk.test Email=yonash53@gmail.com LastName='SFTK Test $N' FirstName=SFTK Alias=sftk$N TimeZoneSidKey=Asia/Jerusalem LocaleSidKey=en_US EmailEncodingKey=UTF-8 LanguageLocaleKey=en_US ProfileId=$PID" -o "$ORG" 2>&1 | grep -E "Success|rror" | head -1
done
sf data create record -s Group -v "Name='SFTK Test Group' DeveloperName=SFTK_Test_Group Type=Regular" -o "$ORG" 2>&1 | grep -E "Success|rror" | head -1
UA=$(sf data query -q "SELECT Id FROM User WHERE Username='sftk.test.a@$DOM.sftk.test'" -o "$ORG" --json | $PY -c "import json,sys; r=json.load(sys.stdin)['result']['records']; print(r[0]['Id'] if r else '')")
GID=$(sf data query -q "SELECT Id FROM Group WHERE DeveloperName='SFTK_Test_Group'" -o "$ORG" --json | $PY -c "import json,sys; r=json.load(sys.stdin)['result']['records']; print(r[0]['Id'] if r else '')")
PS=$(sf data query -q "SELECT Id FROM PermissionSet WHERE Name='SFTK_FC_Test_Access'" -o "$ORG" --json | $PY -c "import json,sys; r=json.load(sys.stdin)['result']['records']; print(r[0]['Id'] if r else '')")
sf data create record -s PermissionSetAssignment -v "AssigneeId=$UA PermissionSetId=$PS" -o "$ORG" 2>&1 | grep -E "Success|rror" | head -1
sf data create record -s GroupMember -v "GroupId=$GID UserOrGroupId=$UA" -o "$ORG" 2>&1 | grep -E "Success|rror" | head -1
echo "== done. Source-org URL for profiles.json / harness: $(sf org display -o "$ORG" --json | $PY -c "import json,sys; print(json.load(sys.stdin)['result']['instanceUrl'])")"
echo "   Not rebuilt (optional): the 24,000-row volume tree (seed-volume.apex, four passes)."
