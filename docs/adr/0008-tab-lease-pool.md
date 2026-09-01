---
status: accepted
---

# Tabs Are a Leased Pool, Not One Per Subagent

Under the Bridge Driver, the Developer User manually keeps a small number of tabs open per Web Product rather than the Gateway opening tabs itself. This would conflict with isolating each subagent's Agent Task in its own web conversation if a tab were a dedicated per-subagent container, since subagent count is dynamic and cannot be pre-provisioned by the user. The resolution is a Tab Lease pool: any registered open tab for a provider can serve any turn, isolation comes from starting a fresh or correctly-scoped conversation on each lease rather than from tab ownership, per-provider concurrency is bounded by the number of currently open tabs, and demand beyond that queues instead of requiring more manually opened tabs.

Registration defaults to on for every matching tab, with a per-tab injected toggle the Developer User can turn off to exclude a specific tab, such as one being used for manual personal chat, from automation. This gives zero-setup convenience and per-tab privacy control through one mechanism instead of two.
