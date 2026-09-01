# 04: Real incremental streaming with declared provenance

**What to build:** Answers appear progressively in Claude Code as the web model produces them, rather than arriving in one block after a long silence. Reasoning content is delivered separately from answer content so the client renders thinking the way it normally does.

Every turn declares how its stream was actually obtained — intercepted network frames, structured frontend state, DOM diffing, or post-completion buffering. Buffered replay must never be presented as native streaming; that honesty is a product requirement, not a diagnostic nicety.

Both DeepSeek and Doubao are network-interceptable, so the first providers should not need DOM-diff streaming. Usage figures, where reported at all, are flagged as estimated.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] A turn streams incrementally, with correct Anthropic SSE event order and shape
- [ ] Reasoning content is emitted separately from answer content
- [ ] Every turn carries stream provenance, and a buffered path reports itself as buffered
- [ ] Usage, when present, is marked estimated
- [ ] Claude Code renders the stream progressively without protocol errors
- [ ] Parser tests over recorded frames cover incremental text, reasoning separation, truncated frames, and completion detection
