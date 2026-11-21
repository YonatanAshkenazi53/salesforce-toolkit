# Agentforce fixture (2026-11-21) — NOT deployed yet

An agent action (`GenAiFunction` SFTK_AF_Action, target flow `SFTK_Pkg_Auto`) and a topic (`GenAiPlugin`
SFTK_AF_Topic) whose texts name `dlrs__LookupChild__c.SFTK_Pkg_Tag__c`. The file shapes follow Salesforce's public
sample app (trailheadapps/coral-cloud).

State: npc2 refuses the action on a check-only deploy with "An unexpected error occurred" (ErrorId 59220073), with
and without the progress-indicator elements; the topic alone validates. npc and npc2 hold no action, topic, agent
or bot at all (`sf org list metadata -m GenAiFunction` is empty), so Agentforce is most likely not switched on in
them — a Setup switch (Einstein Setup → Agentforce Agents) that only the org's owner can flip.

Once it is on: `sf project deploy start -o npc2 --source-dir force-app --test-level NoTestRun`, then run Field
Cleaner's 🧭 full metadata text scan on dlrs__LookupChild__c.SFTK_Pkg_Tag__c — the two should be listed under
"Agentforce actions" and "Agentforce topics" — and a check-only delete of the field to see whether Salesforce
lets it through (expected: yes, both name the field as text only).
