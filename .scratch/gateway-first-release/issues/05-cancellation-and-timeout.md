# 05: Cancellation and turn timeout

**What to build:** Stopping a task in Claude Code actually stops generation in the Web Product, rather than leaving the page generating an answer nobody will read while consuming the account's capacity. A turn that exceeds its configured limit fails with a clear message instead of hanging until the client gives up.

**Blocked by:** 04

**Status:** done

- [x] Cancelling in Claude Code stops generation in the Web Product, not merely the local stream
- [x] A cancelled turn ends with the cancelled stop reason rather than an error
- [x] The leased tab is released and reusable immediately after cancellation
- [x] A turn exceeding `turn_timeout_ms` fails explicitly, naming the timeout
- [x] The timeout is configurable, since Pro and high-effort models legitimately run longer

## Comments

- 2026-09-02 — Implemented and live-verified against a real chat.deepseek.com tab. Three findings from driving the live page shaped the design. (1) DeepSeek's stop control is the *same element* as the send control with a swapped icon, so the adapter deliberately points both selectors at it. (2) Clicking stop halts generation but the completion stream emits **no terminating frame** — a cancelled turn therefore has to be settled explicitly on both sides, and the earlier code would have waited out the Bridge's full 120s deadline with the page already idle. (3) Cancellation must reach the specific connection the turn was dispatched to, because ticket 03 pins a conversation to one Bridge; broadcasting would stop the wrong tab and leave this one generating.
- 2026-09-02 — Scope correction found during live verification. The five criteria only require the *cancel* path to stop the page, but a timed-out turn left DeepSeek generating a 3000-word answer nobody would read — precisely what this ticket's opening statement forbids. Measured live: after a 4s timeout the page was still generating. The timeout path now stops upstream generation too, re-verified live (`pageIdle: true` immediately after the timeout error).
- 2026-09-02 — Also fixed a latent streaming bug that cancellation makes reachable: `emit()` wrote to the SSE controller without guarding for a closed body, so a client hanging up mid-stream threw `Controller is already closed`. `controller.close()` was guarded but `emit` was not; the guard now lives in `emit`/`endBody` since every call site is equally exposed.
- Not live-verified: the `cancelled` stop reason reaching a client. A client that cancels by disconnecting cannot by definition read the response, so this is covered by unit tests over the outcome and the Anthropic `message_delta` mapping rather than end-to-end.
