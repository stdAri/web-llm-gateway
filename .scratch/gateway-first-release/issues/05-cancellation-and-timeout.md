# 05: Cancellation and turn timeout

**What to build:** Stopping a task in Claude Code actually stops generation in the Web Product, rather than leaving the page generating an answer nobody will read while consuming the account's capacity. A turn that exceeds its configured limit fails with a clear message instead of hanging until the client gives up.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] Cancelling in Claude Code stops generation in the Web Product, not merely the local stream
- [ ] A cancelled turn ends with the cancelled stop reason rather than an error
- [ ] The leased tab is released and reusable immediately after cancellation
- [ ] A turn exceeding `turn_timeout_ms` fails explicitly, naming the timeout
- [ ] The timeout is configurable, since Pro and high-effort models legitimately run longer
