# 06: Web Model Catalog, Web Effort, and fail-closed selection

**What to build:** The Developer User picks models by the names the Web Product itself shows, and only sees models their account can actually reach. Reasoning depth maps to options the site genuinely exposes.

When a selection is not available — the model is gone from the account, the effort level does not exist for it — the request fails with a message naming what was asked for and what is available. Per ADR-0013 there is no silent substitution: quietly swapping a different model into an agent loop changes reasoning quality, cost, and capabilities without anyone knowing, which is worse than a clear failure.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] Model listing reflects what the authenticated account can actually see in the Web Product
- [ ] Identifiers keep the site's own display name behind a provider prefix, with no static renaming table
- [ ] Web Effort options offered per model reflect what the site genuinely exposes, never a prompt-simulated level
- [ ] The catalog is cached and cached entries are marked stale rather than silently trusted
- [ ] The selection is verified against the live Web Product before a turn is submitted
- [ ] An unavailable model or effort fails with an explicit error listing what is available
- [ ] No request is ever served by a different model, effort, or provider than the one selected
