# Legal notes — INTERNAL, never shipped

This file is not copied into the store build (`scripts/pack_store.py` ships
only `CHANGELOG.md`, `LICENSE`, `EULA.md` and `PRIVACY.md`). It holds what
must never reach an end user (user 2026-09-14: "the first lines here are
something that should never come out to the end user").

## Status of EULA.md and PRIVACY.md

**They are templates, not legal advice.** They were drafted to cover the
obvious risks of a tool that can delete and overwrite Salesforce data. They
have **not been reviewed by a lawyer**. Before charging money for this
software, have a lawyer review both against Israeli consumer and contract law
and against the law of any market it is sold into.

## How the documents reach the user

`legal.html` (+ `legal.js`) renders the shipped markdown as a real page with a
charset — the raw `.md` used to open as a source dump with broken punctuation.
The licence gate and the "read again" view link to `legal.html?doc=eula` and
`legal.html?doc=privacy`.
