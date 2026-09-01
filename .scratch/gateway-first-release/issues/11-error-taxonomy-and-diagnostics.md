# 11: Canonical error taxonomy, adapter drift, and redacted diagnostics

**What to build:** Failures tell the Developer User what actually went wrong and what to do about it. An expired login, an exhausted tab pool, a vanished model, a lost tab, and a changed website are distinct conditions, and conflating them turns every problem into a guessing game.

Suspected site drift gets its own error class. It is the signal that a Web Provider Adapter needs updating rather than that the Developer User misconfigured something, and it is what makes fixture regeneration and Provider Support Tier downgrades actionable.

Diagnostics carry an identifier that correlates to a redacted record. Cookies, tokens, and full prompts stay out of ordinary logs so diagnostics are safe to read and share.

**Blocked by:** 04, 07

**Status:** ready-for-agent

- [ ] Each canonical error code maps to a distinct, recognisable condition
- [ ] Errors state whether they are retryable and whether they need user action
- [ ] Suspected site drift is reported as its own class, distinct from generic failure
- [ ] An expired Web Product session pauses that provider and says so, rather than failing every queued task in a burst
- [ ] Failures carry a diagnostic identifier that locates a redacted record
- [ ] Cookies, tokens, and full prompt content never appear in ordinary logs
- [ ] Each canonical error maps correctly onto the client protocol in use
