# 13: Doubao Web Provider Adapter, verified

**What to build:** A second Web Product, chosen to prove the adapter contract is not quietly shaped around the first one. Doubao differs from DeepSeek in every dimension that matters: a different composer and input method, a different upload mechanism, different stream framing, and structured frontend state available as a fallback that rendered-text scraping cannot match.

If adding Doubao requires changing the Automation Driver contract or the canonical event model, that is the finding — the abstraction was DeepSeek-shaped and needs correcting before a third provider is attempted.

**Blocked by:** 03, 04

**Status:** ready-for-agent

- [ ] Doubao registers, discovers its models and Web Effort options, and reports its capability matrix
- [ ] Text turns stream incrementally with reasoning separated from answer content
- [ ] The prompt-emulated tool loop completes a multi-round task on Doubao
- [ ] Structured frontend state is used as the fallback ahead of rendered-text extraction
- [ ] Recorded, redacted Doubao frames drive parser tests in CI without credentials
- [ ] Any change the adapter forced on the shared contract is recorded, not absorbed silently
