# 03: Prompt-emulated tool loop

**What to build:** The web model can use Claude Code's tools. Claude Code sends its tool definitions, the model asks to run one, Claude Code executes it under its own permissions and sandbox, the result is fed back into the same web conversation, and the model continues until it produces a final answer — across multiple rounds if the task needs them.

This is the load-bearing unknown of the whole project, which is why it is scheduled this early. Every reference implementation with a dependable same-response tool loop achieved it through a site connector and a vendor tunnel; the connector-free precedent is primitive. If structured envelope emission proves unreliable across heterogeneous sites, the first release's central claim weakens, and that must surface now rather than at acceptance.

Per ADR-0012, parsing happens in the page but validation does not. The daemon revalidates every envelope before anything reaches an Agent Client, because the page it came from is not trusted.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] Tool definitions supplied by Claude Code are encoded into an envelope the web model can emit reliably
- [ ] An emitted tool call is delivered to Claude Code as a native `tool_use`, and Claude Code's normal approval and execution flow runs unchanged
- [ ] A tool result returned by Claude Code is fed back into the same web conversation and the model continues from it
- [ ] A task requiring several tool rounds completes and produces a final answer
- [ ] The daemon rejects a call naming a tool the request did not offer
- [ ] The daemon rejects a call whose arguments fail their schema
- [ ] The daemon rejects a call carrying a wrong or missing turn nonce, so page or retrieved content cannot forge one
- [ ] Provider capability reports `tools: prompt-emulated`, never native function calling
- [ ] Envelopes are extracted from surrounding prose rather than requiring the whole message to be one, which DeepSeek was observed to produce
- [ ] A turn that ends with neither an envelope nor a final answer is handled explicitly, with a bounded nudge or retry rather than a stalled task
- [ ] Model-supplied call ids are namespaced or rewritten per turn, since fresh conversations were observed to reuse `call_1`
