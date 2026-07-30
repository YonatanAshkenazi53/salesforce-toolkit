# Launch Kit — Admin Toolkit for Salesforce

Everything here is a draft in your voice — edit freely, especially the origin
details. The one rule that matters on every channel: **be the builder sharing a
free tool, never the marketer**. r/salesforce and SFXD eat self-promo alive
unless it's transparent, free, and leads with a pain they recognize.

---

## The one story (use it everywhere)

> Refreshed your sandbox? Get your config data back — with parent-child
> relationships intact — in minutes, not days.

Everything else (debugger, picklists, quota meters) is supporting cast in the
listing. One pain, told by someone who had it.

---

## 1. Reddit post — r/salesforce

**Title:**
> I got tired of rebuilding reference data after every sandbox refresh, so I
> built a free Chrome extension that deploys records between orgs with
> relationships intact

**Body:**

> Admin here. I maintain 5+ orgs that all need the same config data — product
> catalogs, reference records, picklist values — synced from one source of
> truth. Data Loader can't do it (IDs differ between orgs), change sets don't
> move data, and the paid tools in this space cost more than my org would ever
> approve for what is essentially "copy these 400 Accounts and their Contacts."
>
> So over the last few months I built a Chrome extension for it. It's free, and
> honestly the thing I'm proudest of is what it *doesn't* do: there's no
> server. It runs entirely in your browser on the Salesforce sessions you're
> already logged into, and its Content-Security-Policy makes it technically
> impossible for it to call any non-Salesforce host. Your data never leaves
> your machine.
>
> What it does:
> - **Cross-org record deployment** with parent→child trees, field mapping per
>   target, and record matching by fields you pick (Email + Name, external IDs,
>   composite keys) instead of IDs
> - **Dry runs that check your actual data** — restricted picklist values,
>   State/Country mismatches ("TX" vs "Texas"), field lengths — *before*
>   anything is written, and it tells you which validation rules and triggers
>   it *can't* check, instead of pretending a green dry run means safe
> - **A picklist matrix** — one field's values across every org side by side,
>   with record counts and one-click sync plans
> - **Every big operation shows its API cost up front** ("≈160 calls · org has
>   61k of 100k remaining today") so your integration team doesn't ban it
> - Plus a flow manager with dependency mapping, an Apex log analyzer, and a
>   pile of admin tools
>
> Store link: [YOUR STORE URL]
>
> It's been through a lot of testing against a large production org with
> managed packages, but I'm one person — if you try it and something's weird in
> your org, tell me and I'll fix it. That's genuinely the most useful thing you
> could do for me.

**Posting notes:** Tuesday–Thursday, morning US time gets the most traction.
Reply to every comment in the first two hours — the algorithm and the community
both reward it. If a mod asks, say plainly it's your own free tool. Cross-post
the same text to the SFXD Discord's tools channel (they're friendlier and more
technical — lead with the dry-run honesty angle there).

---

## 2. LinkedIn post

> After one too many sandbox refreshes spent manually rebuilding reference
> data, I built the tool I wished existed — and it's free on the Chrome Web
> Store.
>
> Admin Toolkit for Salesforce deploys records between orgs with relationships
> intact, matches records by the fields you choose instead of IDs, and runs a
> dry run that validates your actual data against the target org before
> writing a single record.
>
> The design choice I care most about: there is no server. Everything runs
> locally in your browser on sessions you already have — the extension is
> technically incapable of sending your data anywhere else.
>
> If you manage more than one org, I'd love for you to try it and tell me what
> breaks: [YOUR STORE URL]
>
> #Salesforce #SalesforceAdmin #AppExchange

---

## 3. Demo recording — 60-second storyboard

Record at 1280×800 (same DevTools trick as the store screenshots), light mode,
demo orgs only. Tools: Chrome's built-in recorder or ScreenToGif → export GIF
under 10 MB and add it as the store listing's first screenshot slot *and* embed
in the Reddit post (Reddit loves inline GIFs).

**Option A — "the dry run catches it" (recommended, it's the trust story):**

| Sec | Screen | What you do | Caption overlay |
|---|---|---|---|
| 0–8 | Data Deployment | Open the "Accounts + Contacts" profile, point at the tree | "400 Accounts + their Contacts, org to org" |
| 8–18 | Run panel | Click 🧪 Dry Run | "Dry run first — nothing is written" |
| 18–35 | Run log | Let the ✅ rows scroll, then STOP on the red ❌ | "It checked my actual data… and caught a picklist value the target org would reject" |
| 35–45 | The ❌ row | Zoom/point at "'Prospect - Warm' (12×) — INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST" | "Before the run. Not after 12 failures." |
| 45–55 | The ℹ️ row | Point at the validation-rules line | "And it's honest about what a dry run *can't* test" |
| 55–60 | — | Fade to store listing name | "Free · no server · Chrome Web Store" |

**Option B — the picklist matrix (best visual, good for a second post):**
Load the Account.Type matrix across 3 orgs → point at the missing value in one
org and the counts → click Sync from source → show the plan (don't run it).
Caption arc: "same field, three orgs, one glance" → "one is missing a value —
and 74 records use it in QA" → "one click builds the fix".

---

## 4. Review ask — message to 3–4 admin friends

> Hey — I shipped my Salesforce admin extension to the Chrome store (free, no
> server, everything stays in your browser). Two asks, five minutes total:
> install it and click around one org: [STORE URL] — and if it doesn't break,
> a store review would help me enormously; the first handful decide whether
> anyone else ever finds it. If it DOES break, even better: tell me exactly
> where and I'll fix it within the day.

Don't script what they should write — authentic short reviews beat identical
paragraphs, and the store's spam detection agrees.

---

## 5. Pre-flight checklist

- [ ] Upload the current 1.2.0 zip (dist/) to the dev console → Submit
- [ ] After approval: Distribution → **Public** (it may still be Unlisted)
- [ ] Record Option A GIF → add to store listing + Reddit post
- [ ] Fill [YOUR STORE URL] in all drafts above
- [ ] 3–4 review asks sent → wait until at least 2 reviews exist before posting
      to Reddit (a zero-review listing linked from a popular post looks abandoned)
- [ ] Post Reddit (Tue–Thu am US) → reply to every comment for 2 hours
- [ ] Same week: SFXD Discord, then LinkedIn
- [ ] Watch the store dashboard's user count weekly; every support question is
      a changelog entry waiting to happen
