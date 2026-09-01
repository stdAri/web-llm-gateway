# 07: Tab Lease pool — registration, heartbeat, opt-out, and queueing

**What to build:** The Developer User keeps a few Web Product tabs open and the Gateway Node uses them as a pool of interchangeable execution slots. Every matching tab registers itself automatically, so the common case needs no configuration, but each tab shows a toggle that can be switched off — a tab being used for a personal conversation must never be taken over by an Agent Task.

A tab the browser discards or suspends stops heartbeating and silently drops out of the pool, so work is never dispatched into a tab that is no longer running. When every tab of a provider is busy, further work queues; when the queue wait exceeds its limit, the caller is told plainly to open another tab rather than left watching a hang. With no live tab at all, requests fail closed.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Matching tabs register automatically and appear as available capacity
- [ ] Each tab shows a toggle, defaulting to registered, that excludes it from the pool when switched off
- [ ] A discarded, suspended, or closed tab stops heartbeating and leaves the pool without manual intervention
- [ ] Concurrent turns for a provider never exceed its live registered tab count
- [ ] Work beyond available capacity queues rather than failing immediately
- [ ] A queue wait exceeding `queue_timeout_ms` fails with a message that explains the remedy
- [ ] A request for a provider with no live tab fails closed rather than blocking indefinitely
- [ ] A tab lost mid-turn is reported distinctly from a site failure
