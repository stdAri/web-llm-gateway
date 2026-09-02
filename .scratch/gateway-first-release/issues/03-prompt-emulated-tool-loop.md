# 03: Prompt-emulated tool loop

**What to build:** The web model can use Claude Code's tools. Claude Code sends its tool definitions, the model asks to run one, Claude Code executes it under its own permissions and sandbox, the result is fed back into the same web conversation, and the model continues until it produces a final answer — across multiple rounds if the task needs them.

This is the load-bearing unknown of the whole project, which is why it is scheduled this early. Every reference implementation with a dependable same-response tool loop achieved it through a site connector and a vendor tunnel; the connector-free precedent is primitive. If structured envelope emission proves unreliable across heterogeneous sites, the first release's central claim weakens, and that must surface now rather than at acceptance.

Per ADR-0012, parsing happens in the page but validation does not. The daemon revalidates every envelope before anything reaches an Agent Client, because the page it came from is not trusted.

**Blocked by:** 02

**Status:** done

- [x] Tool definitions supplied by Claude Code are encoded into an envelope the web model can emit reliably
- [x] An emitted tool call is delivered to Claude Code as a native `tool_use`, and Claude Code's normal approval and execution flow runs unchanged
- [x] A tool result returned by Claude Code is fed back into the same web conversation and the model continues from it
- [x] A task requiring several tool rounds completes and produces a final answer
- [x] The daemon rejects a call naming a tool the request did not offer
- [x] The daemon rejects a call whose arguments fail their schema
- [x] The daemon rejects a call carrying a wrong or missing turn nonce, so page or retrieved content cannot forge one
- [x] Provider capability reports `tools: prompt-emulated`, never native function calling
- [x] Envelopes are extracted from surrounding prose rather than requiring the whole message to be one, which DeepSeek was observed to produce
- [x] A turn that ends with neither an envelope nor a final answer is handled explicitly, with a bounded nudge or retry rather than a stalled task
- [x] Model-supplied call ids are namespaced or rewritten per turn, since fresh conversations were observed to reuse `call_1`

## Comments

- 2026-09-02 — Implemented. Daemon owns the whole protocol: `ToolLoop` (`src/daemon/tool-loop.ts`) keeps in-memory conversations (persistence is ticket 09), encodes offered tools into a setup prompt with envelope format `<tool_call nonce=N id=ID name=NAME>{json}</tool_call>`, validates every reply (allowlist, JSON-schema subset, per-round nonce — a wrong or missing nonce is a hard `ToolProtocolError`, never nudged), rewrites model call ids to `toolu_<24hex>` and maps results back onto the model's own ids so cross-task `call_1` collisions cannot pair wrongly. One corrective nudge per round; a second malformed round fails the turn. The Bridge (`extractToolEnvelopes` in the DeepSeek adapter) strips envelopes out of surrounding prose — all-or-nothing, so one malformed envelope fails the whole reply instead of half-executing — and refuses to submit into a tab whose URL does not match the conversation it was opened on (`conversationRef`). The hub routes continuation turns to the same Bridge connection by conversation id and reports `tab_lost` if it died. Provider capability now reports `tools: "prompt-emulated"` on `GET /`. SSE streams tool_use blocks as `content_block_start` + `input_json_delta` + `content_block_stop`.
- 2026-09-02 — Live verification caught a bug the synthetic tests structurally could not: Claude Code 2.1.257 appends trailing `role:"system"` reminder messages *inside* the `messages` array, after the `tool_result` user message, so the continuation detector (which looked only at the last message) never fired. Every tool_result then started a **fresh** web conversation — the model re-read the same file 13 times in 13 conversations and finally hallucinated an answer (`@anthropic/claude-code-bridge`, then `connector`) because no tool result ever reached it. `parseToolResults` now scans backwards for the last user message carrying tool_result blocks and forwards trailing system-reminder text as a note; regression test added. This is the second time a synthetic fixture certified a protocol reality does not speak (first: the stateless DeepSeek parser in ticket 01).
- 2026-09-02 — Live pass after the fix: real Claude Code 2.1.257, `--model deepseek/deepseek-chat`, task "读取当前目录 package.json，报告 name 字段". Daemon log shows one conversation: `tool_use: Read({"file_path":"/Users/young/Project/Connector/package.json"})` → result fed back into the same web conversation → `final: The name field in package.json is "web-llm-gateway"` — the correct answer, in ~10s end to end. The loop (envelope → validation → native tool_use → local execution → tool_result → final answer) works against the real site. 71 tests pass, typecheck clean.
- Known limitations, deliberately out of scope here: a reply that *announces* tool use in prose without emitting an envelope ("Let me check...") is still treated as a final answer — only empty answers and malformed envelopes are nudged; a new task does not open a new web conversation (isolation is ticket 08, and testing showed a polluted conversation biases the model into repeating earlier answers without calling tools); conversations are in-memory, so a daemon restart orphans live tool conversations with a 400 telling the client why (recovery is ticket 09).
