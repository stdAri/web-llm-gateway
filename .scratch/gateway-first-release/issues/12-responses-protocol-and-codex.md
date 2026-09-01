# 12: Responses protocol and Codex acceptance

**What to build:** Codex points at the Gateway Node as a custom provider and runs a real task against a web model, with the same capabilities Claude Code already has. Per ADR-0002 the two protocols are peers: neither client is a second-class citizen, and the behaviour available through one must be available through the other.

Codex expects Responses semantics, discovers models through its own listing, and attempts a WebSocket upgrade before falling back to HTTP and SSE. Its request shape carries fields Claude Code does not send.

Nothing here may reach into the Web Provider Adapters: per ADR-0005 the adapters must remain unaware of which client is calling.

**Blocked by:** 03, 04, 06

**Status:** ready-for-agent

- [ ] `POST /v1/responses` accepts what Codex actually sends and returns valid Responses SSE
- [ ] Model listing works through Codex's own discovery mechanism
- [ ] The WebSocket upgrade attempt is declined cleanly so Codex falls back to HTTP and SSE
- [ ] Streaming, tool calls, tool results, cancellation, and model selection behave equivalently across both protocols
- [ ] Real Codex completes a multi-round task with at least one tool round trip against a web model
- [ ] No Web Provider Adapter contains protocol-specific behaviour
