# 09: Hybrid continuity and restart recovery

**What to build:** A task's later turns, including tool results, land in the right context. Where the existing web conversation can be continued, it is, so follow-up turns do not resend everything. Where it cannot — the conversation is gone, the tab was closed, the login expired, the daemon restarted — the task recovers by replaying its canonical context into a fresh conversation instead of losing the work.

Per ADR-0004 canonical Agent Task state is the durable source of truth; the web conversation is a performance optimization over it, not the record.

**Blocked by:** 08

**Status:** ready-for-agent

- [ ] A follow-up turn continues the existing web conversation where that path is valid
- [ ] A task whose web conversation is unavailable recovers by replaying canonical context
- [ ] A task survives a daemon restart and continues through canonical replay
- [ ] A tool result delivered after a recovery lands in the correct task context
- [ ] Recovery is observable, so a replayed turn is not mistaken for a continued one
