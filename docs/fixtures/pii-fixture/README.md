# PII fixture (2026-11-13)

Six Leads in the source org with every kind of value the PII engine knows, and some it should catch by the field's name:
e-mail, Israeli / US / UK phones, credit-card numbers (published TEST numbers, Luhn-valid), US SSN shapes, IBANs,
Israeli ID numbers, tax IDs (US EIN, Israeli company number, UK VAT), passport numbers, a birthdate, a salary, an
address, and a free-text note that CONTAINS an e-mail, a phone, a card number, an SSN, a tax ID and an IBAN.
Lead 5 has few of them, Lead 6 none.

- `force-app/` — nine custom fields on Lead (`SFTK_PII_*__c`) and the permission set `SFTK_PII_Access`; deploy to BOTH
  orgs and assign it: `sf project deploy start -o <org> --source-dir force-app --test-level NoTestRun`,
  `sf org assign permset -o <org> --name SFTK_PII_Access`
- `seed-source.apex` — the six Leads, in the source org: `sf apex run -o npc -f seed-source.apex`
- `profiles.json` — the deployment "SFTK PII — Leads" (import it in Data Deployment)
- `cleanup.apex` — removes the Leads (run in either org)
