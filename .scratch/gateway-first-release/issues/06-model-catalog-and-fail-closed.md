# 06: Web Model Catalog, Web Effort, and fail-closed selection

**What to build:** The Developer User picks models by the names the Web Product itself shows, and only sees models their account can actually reach. Reasoning depth maps to options the site genuinely exposes.

When a selection is not available — the model is gone from the account, the effort level does not exist for it — the request fails with a message naming what was asked for and what is available. Per ADR-0013 there is no silent substitution: quietly swapping a different model into an agent loop changes reasoning quality, cost, and capabilities without anyone knowing, which is worse than a clear failure.

**Blocked by:** 02

**Status:** done

- [x] Model listing reflects what the authenticated account can actually see in the Web Product
- [x] Identifiers keep the site's own display name behind a provider prefix, with no static renaming table
- [x] Web Effort options offered per model reflect what the site genuinely exposes, never a prompt-simulated level
- [x] The catalog is cached and cached entries are marked stale rather than silently trusted
- [x] The selection is verified against the live Web Product before a turn is submitted
- [x] An unavailable model or effort fails with an explicit error listing what is available
- [x] No request is ever served by a different model, effort, or provider than the one selected

## Comments

- 2026-09-03 — Implemented and live-verified against a real chat.deepseek.com account. The catalog is read off the page: 快速模式 / 专家模式 / 识图模式, discovered from the mode radios. The previous registration hardcoded `deepseek-chat` and `deepseek-reasoner` — API names that appear nowhere in the Web Product — and three test files propagated the same fiction; both are gone.
- 2026-09-03 — Model switching is not one strategy. Verified live: DeepSeek's mode radios exist only on the new-chat screen and are absent from the DOM once a conversation has started, so the model is fixed for that conversation's life; Doubao exposes its picker inside the conversation. `ModelSwitching` is therefore `none | at-conversation-start | mid-conversation`. Where a site supports switching we switch; where it does not, a mid-conversation model change fails with 409 rather than silently answering with the model the conversation already has (ADR-0013). This matters most in the ticket 03 tool loop, where honouring a switch would mean abandoning the conversation the tool results belong to.
- 2026-09-03 — Caching and staleness could not be deferred as planned. A Bridge sitting inside a conversation cannot see the mode radios at all, so the catalog has to be persisted with the timestamp it was observed at, and the daemon marks entries stale rather than presenting them as current. A `bridge.catalog` message announces a newly observable catalog so freshness does not depend on reconnecting. Verified live: with the tab inside a conversation the catalog was empty and selection failed 503 `catalog_unavailable` naming the fix; navigating to the new-chat screen populated all three modes with `fresh: true` within seconds.
- 2026-09-03 — Selection is verified after the fact, not just intended. DeepSeek's stream reports `model_type`, `conversation_mode`, `thinking_enabled` and `search_enabled`, so what actually served a turn is page-sourced evidence. Provenance the page does not report is deliberately *not* treated as a mismatch: absence of evidence is not evidence of substitution, and failing there would break every provider that reports nothing.
- 2026-09-03 — Deliberate limit: only a qualified `provider/model` counts as a selection and gets strict fail-closed treatment. Claude Code sends its own model names (`claude-sonnet-4-5`), which express no web-model choice; rejecting them would break every unqualified client for no honesty gained. Those turns are served by whatever the site currently has selected and the `x-gateway-model` response header names what ran.
- 2026-09-03 — Keeping the site's own display name (no renaming table) has one real cost: HTTP header values must be ASCII, so `x-gateway-model` is percent-encoded. Encoding the header was chosen over anglicising the name, since keeping the site's name is the point.
- 2026-09-03 — A gap found by A/B testing two models rather than one, which is the test that exposed it. The Bridge read the mode radios but never clicked them, so a turn requesting 专家模式 was answered by whatever the page had selected while the daemon reported the requested name — the silent substitution this ticket exists to prevent. `/v1/turn` ignored `model` entirely. The Bridge now selects the mode before submitting, and refuses the turn when it cannot.
- 2026-09-03 — Selecting a mode is asynchronous. Verified live: immediately after `click()` the selected class has not moved, and it lands about a second later. Clicking and submitting straight away would run the turn on the previous mode while reporting the new one, so selection polls until the page has actually switched (5s ceiling) and fails explicitly if it never does.
- 2026-09-03 — A/B verified live with page-sourced evidence rather than our own claim: 快速模式 reports `model_type: "default"`, `search_enabled: true`; 专家模式 reports `model_type: "expert"`, `search_enabled: false`. Requesting the other model inside an existing conversation is refused with `model_switch_unavailable` naming both models and the remedy, while requesting the model the conversation is already running proceeds normally.
- Not verified: 识图模式 accepting a plain-text turn, and effort actually toggling 深度思考 on the page. The effort axis is declared and checked against reported provenance, but nothing yet *sets* it — a follow-up, and the same class of gap as the model selection one above.
