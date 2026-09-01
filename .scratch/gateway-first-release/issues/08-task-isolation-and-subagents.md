# 08: Agent Task isolation and subagents

**What to build:** Each Agent Task reasons in its own isolated context, and one task's history never leaks into another's. Claude Code subagents are isolated from the main task and from each other, and this works without the Developer User pre-opening a tab per subagent — subagent count is dynamic and cannot be predicted in advance.

Per ADR-0008 the isolation comes from conversation scoping on lease, not from tab ownership. A tab is a reusable slot; two tasks that run through the same tab at different times must not see each other's context. Where the Web Product offers a Temporary Chat, that is the default, so agent traffic does not fill the Developer User's personal chat history.

**Blocked by:** 03, 07

**Status:** ready-for-agent

- [ ] Two concurrent Agent Tasks on the same provider never observe each other's context
- [ ] Sequential tasks reusing the same tab are isolated from one another
- [ ] Claude Code subagents are isolated from the main task and from each other
- [ ] A dynamic number of subagents works without pre-opening a tab for each
- [ ] Isolated conversations default to a Temporary Chat where the Web Product offers one
- [ ] Where a provider offers no Temporary Chat equivalent, the fallback is established and documented rather than assumed
