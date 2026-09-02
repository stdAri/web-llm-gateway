# 04: Real incremental streaming with declared provenance

**What to build:** Answers appear progressively in Claude Code as the web model produces them, rather than arriving in one block after a long silence. Reasoning content is delivered separately from answer content so the client renders thinking the way it normally does.

Every turn declares how its stream was actually obtained — intercepted network frames, structured frontend state, DOM diffing, or post-completion buffering. Buffered replay must never be presented as native streaming; that honesty is a product requirement, not a diagnostic nicety.

Both DeepSeek and Doubao are network-interceptable, so the first providers should not need DOM-diff streaming. Usage figures, where reported at all, are flagged as estimated.

**Blocked by:** 02

**Status:** done

- [x] A turn streams incrementally, with correct Anthropic SSE event order and shape
- [x] Reasoning content is emitted separately from answer content
- [x] Every turn carries stream provenance, and a buffered path reports itself as buffered
- [x] Usage, when present, is marked estimated
- [x] Claude Code renders the stream progressively without protocol errors
- [x] Parser tests over recorded frames cover incremental text, reasoning separation, truncated frames, and completion detection

## Comments

- 2026-09-02 — Implemented end to end. The page interceptor no longer waits for `res.text()`: it drains a `res.clone().body.getReader()` incrementally (the page keeps the original body), splits SSE lines with a carry buffer, and posts each frame as the network delivers it; the XHR fallback slices `responseText` at readyState 3 the same way. The DeepSeek assembler's `push` now returns what each frame appended, and the Bridge relays it as a new `turn.delta` protocol message (`{kind: "text"|"reasoning", text}`) ahead of `turn.result`. Protocol version stays 1: an old daemon ignores unknown message types, and a Bridge that never sends deltas simply produces a buffered turn — degradation in both directions without a version dance (ticket 16 may revisit).
- 2026-09-02 — Daemon side: `executeMessagesTurnStreaming` converts deltas into Anthropic SSE in canonical order (message_start → thinking block while reasoning flows → text block → message_delta with stop_reason → message_stop), reasoning strictly separated from answer text. Provenance is structural, not declarative: the handler only returns `x-gateway-stream-source: network` after the first real delta has arrived; a turn that completes without any delta falls back to `synthesizedEventStream` with `x-gateway-stream-source: buffered`. Tool-loop turns are always buffered by design — calls must be validated atomically before the client sees anything, so there is no honest mid-turn stream. Usage is length-based estimation, flagged on every response via `x-gateway-usage: estimated`. Non-streaming replies now carry reasoning as a separate `thinking` content block; `/v1/turn` returns it as its own field.
- 2026-09-02 — Live verified. Raw curl against `/v1/messages` with `stream:true`: headers showed `x-gateway-stream-source: network` and `x-gateway-usage: estimated`, and timestamped capture showed thinking deltas arriving over ~2.6s (not a single end-of-turn burst), then the text block, then end_turn. Real Claude Code 2.1.257 `-p "用一句话介绍苏州" --model deepseek/deepseek-chat` completed in ~8s with no protocol errors and a correct answer, consuming unsigned thinking blocks without complaint. 80 tests pass (9 new: per-frame delta attribution, truncated/contentless frames, delta-concatenation vs assembled result, SSE event order, first-bytes-before-completion timing, buffered fallback, mid-stream SSE error, pre-stream error envelope, non-stream thinking block), typecheck clean.
