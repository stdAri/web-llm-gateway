# 10: Conservative limits, escalating cooldowns, and challenge pause

**What to build:** The Gateway Node behaves conservatively by default so a Developer User's account is not exposed to obviously machine-shaped traffic before they have tuned anything. Submissions are spaced and jittered so cadence is not perfectly regular. Repeated failures escalate cooldowns instead of hammering a broken provider. A suspected challenge or risk-control response pauses that provider for human attention rather than retrying into an enforcement signal.

Per ADR-0010 the defaults are deliberately conservative and all overridable. They are unvalidated starting points, not measured findings, and should be revisited once real usage exists.

**Blocked by:** 07

**Status:** ready-for-agent

- [ ] Default per-provider concurrency is serial even when several tabs are registered
- [ ] Submissions are spaced by a minimum interval with jitter applied
- [ ] Consecutive failures escalate cooldowns at the configured thresholds
- [ ] A suspected challenge or risk-control response pauses the provider and is surfaced for human attention
- [ ] A paused provider does not retry automatically
- [ ] Crossing the hourly soft threshold produces a warning without blocking work
- [ ] Every limit is overridable, and raising one is a deliberate act
