---
status: accepted
---

# Fail Closed Instead of Substituting Models or Providers

When a requested model, effort level, or provider is unavailable — no longer offered to the account, no live tab registered, or the provider is cooling down — the Gateway Node returns an explicit error naming what was requested and what is actually available, and does not silently substitute a different web model, effort level, or Web Product. Silent substitution would change an Agent Task's reasoning quality, cost, and capabilities without the Agent Client or the Developer User knowing, which is worse than a clear failure in an agentic loop that may run for many turns. Cross-provider fallback chains are the job of an upstream router such as CLIProxyAPI or OmniRoute, which can make that policy explicit; this node stays honest about a single selection.
