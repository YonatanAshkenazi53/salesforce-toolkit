# End User Licence Agreement — Admin Toolkit for Salesforce

**Version 2 · Effective 3 September 2026 · Contact: the developer contact on this extension's Chrome Web Store page**

*Version 2 makes one thing explicit that version 1 implied: by accepting, you
confirm that any consequence of using the Software — both the Toolkit and Data
Studio, and every one of their components — is your responsibility.*

This agreement is between you (**"you"**, the person installing the extension,
and any company you install it for) and **Yonatan Ashkenazi** (**"we"**, **"us"**).

It covers the **Admin Toolkit for Salesforce** browser extension in its entirety
(the **"Software"**) — **both** the Toolkit and Data Studio, **and every one of
their components**, including but not limited to: Field Cleaner, the flow tools
and dependency map, Lightning page tools, permission and flow-access tools, the
Apex debugger and log viewer, data deployments and rollbacks, All open orgs, Org
Compare, Org health, and anything added to the Software in future. Nothing in
this agreement is limited to one feature.

**By installing or using the Software you accept this agreement.** If you do not
accept it, do not install or use the Software. The Software asks you to accept
before it will run, and records the version you accepted and when.

---

## 1. What you may do

We grant you a **free, personal, non-exclusive, non-transferable, revocable**
licence to install and use the Software for your own work, including work you do
for your employer or your clients.

## 2. What you may not do

You may not:

- copy, redistribute, publish, sell, rent, lease, sublicense, or host the
  Software for others;
- modify the Software or create derivative works from it;
- reverse engineer, decompile, or disassemble it, except where applicable law
  expressly permits this despite this clause;
- remove or obscure any copyright, licence, or attribution notice;
- use the Software to break the law, to breach your agreement with Salesforce,
  or to access an org you are not authorised to access.

## 3. You are responsible for what you do to your orgs — read this part

**Everything the Software does, it does because you told it to, to orgs you
chose, and the consequences are yours.** This section applies to every part of
the Software, not only to data deployment.

The Software performs **destructive and irreversible operations** when you ask
it to. Among other things, it can:

**To your data —**

- **delete every record** of an object you select, in every org you select
  ("Wipe targets", "Reset & Seed");
- **permanently purge** deleted records past the Recycle Bin ("Hard delete"),
  after which nothing can recover them;
- **overwrite** existing field values and files in one or more orgs at once;
- **replace** Custom Setting rows, deleting what the target had.

**To your configuration and metadata —**

- **delete custom fields**, and rewrite the Layouts, Flows, Lightning pages and
  other components that referenced them (Field Cleaner);
- **delete flow versions**, and **deploy** flows — which creates new versions,
  can activate them, and can change how they behave at runtime, including when
  only their API version changes;
- **modify permission sets, picklists, Lightning pages and other setup**;
- **deploy metadata** — Flows, Layouts, Lightning pages and their activation
  overrides, permission sets, Custom Metadata records, Custom Labels and their
  translations — into one or several orgs at once.

You accept that:

1. **You choose what runs, and where.** Every destructive action requires your
   explicit confirmation, and several require you to type a confirmation phrase.
   You are responsible for reading those confirmations before approving them,
   and for the orgs you tick as targets — including production.
2. **You are responsible for backups.** You must have your own, independently
   verified backups of both data and metadata before running anything
   destructive. The Software is not a backup product.
3. **Rollback is limited, and the Software tells you how.** Where a rollback or
   undo is offered, it restores what it captured — it does **not** undo the
   consequences of automation that already ran (emails sent, records created by
   triggers or flows, roll-ups recalculated), it cannot recover hard-deleted
   records, and it can itself be rejected by validation rules, duplicate rules
   or before-save flows. The Software states these limits before you use it; you
   are responsible for reading them.
4. **You verify the result.** The Software reports what it did and marks
   uncertain outcomes as UNKNOWN rather than as success. You are responsible for
   checking the outcome in Salesforce before relying on it.
5. **Masking is pseudonymisation, not anonymisation.** The PII masking features
   make data less identifying; they do not make it anonymous, and they do not by
   themselves make a copy of production data lawful. Deciding whether you may
   copy personal data into another org — and complying with GDPR, Israeli
   Privacy Protection Law, or any other law that applies to you — is **your**
   responsibility, not ours.
6. **You are responsible for your own compliance and authority.** That includes
   having the right to make these changes in the orgs you make them in, your
   Salesforce agreement, your employer's or client's policies, and any data
   protection or confidentiality obligation you are under.

**If something breaks, that is your responsibility, not ours.** You use the
Software, and every one of its components, entirely at your own risk.

**By accepting this agreement you confirm that any consequence of using the
Software — both the Toolkit and Data Studio, and every one of their components,
including anything added in future — is your responsibility and not ours:** your
data, your metadata, your backups, and every org you run it against, including
production. The acceptance dialog asks you to confirm exactly this before the
Software will run.

## 4. No warranty

**THE SOFTWARE — ALL OF IT, EVERY COMPONENT OF THE TOOLKIT AND OF DATA STUDIO —
IS PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED.** To the fullest extent permitted by law we disclaim
all warranties, including any implied warranty of merchantability, fitness for a
particular purpose, accuracy, and non-infringement.

We do not warrant that the Software is free of defects, that it will run without
interruption, that it will be compatible with any future Salesforce release, or
that any operation it performs will produce a correct or complete result.

Salesforce changes its APIs, metadata types and behaviour several times a year.
Functionality that works today may stop working, or behave differently, after a
Salesforce release.

## 5. Limitation of liability

**To the fullest extent permitted by law, we are not liable to you for any loss
or damage arising out of or connected with the Software — any part of it — or
this agreement**, including:

- loss, corruption, deletion or disclosure of **data or metadata**, including
  fields, flows, layouts, permission sets and any other configuration;
- loss of profit, revenue, business, goodwill, or anticipated savings;
- business interruption or the cost of restoring data or systems;
- any indirect, incidental, special, consequential, exemplary or punitive damage,

whether the claim is in contract, tort (including negligence), or otherwise, and
whether or not we were told such loss was possible.

**Our total aggregate liability** for all claims is limited to the greater of
(a) the total amount you paid us for the Software in the twelve months before
the claim, or (b) **US $50**. The Software is currently supplied free of charge,
so (a) is presently zero.

Nothing in this agreement limits liability that cannot be limited by law —
including liability for death or personal injury caused by negligence, or for
fraud or fraudulent misrepresentation.

## 6. Not affiliated with Salesforce

The Software is an independent tool. It is **not affiliated with, endorsed by,
sponsored by, or supported by Salesforce, Inc.** "Salesforce" and related names
and logos are trademarks of Salesforce, Inc., used here only descriptively to
identify the platform the Software works with. Your relationship with Salesforce
is governed by your own agreement with Salesforce.

## 7. Privacy

The Software runs entirely in your browser. It has no servers, no accounts, no
analytics and no telemetry, and it sends your data nowhere except the Salesforce
orgs you are signed in to. See [PRIVACY.md](PRIVACY.md) for the detail, including
how data you copy between orgs is handled.

## 8. Paid features in future

The Software is free today. We may in future offer paid features or paid tiers.
If we do, the terms for those will be presented to you before you buy anything,
and this agreement will continue to govern the free functionality. **We will not
start charging you for something you are already using without asking you
first.**

## 9. Changes to this agreement

We may update this agreement. If we make a material change, the Software will
ask you to accept the new version before it will run again. The version you
accepted and the date you accepted it are recorded locally in your browser.

## 10. Termination

This licence ends automatically if you breach it. You may end it at any time by
uninstalling the Software. Sections 3, 4, 5, 6 and 11 survive termination.

## 11. Governing law

This agreement is governed by the laws of the State of Israel, and the competent
courts of Tel Aviv-Jaffa have exclusive jurisdiction, except where mandatory
consumer-protection law in your country of residence gives you the right to bring
proceedings elsewhere.

## 12. Whole agreement

This agreement, with LICENSE and PRIVACY.md, is the whole agreement between you
and us about the Software. If any part of it is found unenforceable, the rest
continues to apply.
