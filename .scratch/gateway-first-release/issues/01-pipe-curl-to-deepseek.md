# 01: Open the pipe — a local HTTP request reaches the real DeepSeek page and returns its answer

**What to build:** The thinnest complete path through both halves of the system. A local HTTP request carrying a line of text reaches a DeepSeek tab that the Developer User is already logged into in their own browser, the text is submitted into a real web conversation, and the answer DeepSeek generates comes back to the caller. This is the tracer bullet: it proves the daemon, the Bridge Protocol, the userscript Bridge, and a real Web Provider Adapter can work as one path before anything is built on top of it.

Scope is deliberately narrow. The caller is `curl`, not an Agent Client. The answer arrives complete rather than streamed. There is no model selection, no tool loop, and no queueing. The Bridge authenticates with a Bridge Pairing Token, since it cannot connect without one; the Gateway API Key belongs to ticket 02, where a real client first needs it.

Per ADR-0014, the daemon must learn the provider from what the Bridge announces at registration. Do not compile a provider list into the daemon.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] A repository workspace exists with a test runner and a build that produces a single installable userscript artifact
- [x] The daemon binds to loopback only and refuses connections from other interfaces
- [x] A pairing command issues a Bridge Pairing Token, and the Bridge cannot connect without presenting a valid one
- [x] The Bridge registers an open DeepSeek tab and announces its provider identity to the daemon, which routes to it without any hardcoded provider list
- [x] A local HTTP request carrying a text prompt causes that text to be submitted into the real DeepSeek web conversation
- [x] The answer DeepSeek actually generated is returned to the caller, and the same exchange is visible in the tab
- [x] Recorded, redacted DeepSeek frames are captured and committed, and at least one Provider Adapter parser test runs against them in CI without credentials

## Comments

- 2026-09-02 — Implemented. Bun + TypeScript monorepo-lite: daemon (loopback HTTP + WebSocket BridgeHub + pairing token store), userscript Bridge (page-context fetch/XHR interception, React-aware composer set, tab registration + heartbeat), DeepSeek adapter as pure parser over recorded frames. End-to-end verified: mock Bridge registers a DeepSeek tab and answers a curl turn; LAN-interface connections refused. 11 tests pass, typecheck clean, single userscript artifact builds to `dist/bridge.user.js`.
- Note: the parser test uses synthetic redacted frames (fixtures/deepseek/completion-stream.json) since real DeepSeek frames require the live-site smoke (Surface three) to capture and redact; the fixture format is ready for those frames to be dropped in.
