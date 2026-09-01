---
status: accepted
---

# Default to Conservative Per-Provider Limits

Because Web Products may treat automation-shaped traffic as abusive, the Gateway Node ships conservative defaults and lets the Developer User raise them deliberately rather than shipping throughput-oriented defaults that must be discovered as unsafe. Serial execution per provider is the default even when several tabs are registered; submissions are spaced and jittered so cadence is not machine-regular; and repeated failures escalate cooldowns, with any suspected challenge or risk-control response pausing that provider for human attention instead of retrying into it.

Defaults, all per provider and all overridable:

| Setting | Default | Notes |
|---|---|---|
| `concurrency` | 1 | Also capped by the number of live registered tabs |
| `min_interval_ms` | 3000 | Minimum spacing between turn submissions |
| `interval_jitter` | 0.2 | ±20% randomization of the interval |
| `queue_timeout_ms` | 60000 | Wait for a free tab, then fail with a clear error |
| `turn_timeout_ms` | 300000 | Raise for Pro or high-effort models that legitimately run longer |
| `cooldown_after_failures` | 3 / 5 / 8 | Consecutive-failure thresholds |
| `cooldown_durations_ms` | 60000 / 300000 / 1800000 | Escalating backoff at those thresholds |
| `auth_challenge_cooldown_ms` | 1800000 | Also pauses the provider pending user action |
| `soft_hourly_warning` | 60 | Surfaces a warning in the Control Panel; does not block |
