---
status: accepted
---

# Prompt-Emulated Tools Are the Baseline Tool Channel

Most Web Products expose no native function-calling channel to an outside harness, and the ones that do require site-side setup — a ChatGPT Custom Connector plus an OpenAI tunnel, in the closest reference implementation. Requiring that would exclude Doubao, DeepSeek, and nearly every other Web Product, and would reimpose exactly the per-site connector burden this product exists to avoid. The baseline is therefore prompt emulation: canonical tool definitions are encoded into a structured envelope the Web Product's model can reliably emit, the Gateway parses and validates it, and it is translated into the client's native `tool_use` or `function_call` so the Agent Client executes tools under its own permissions and returns results through its own protocol.

Consequences that must hold:

- **Validation is mandatory, not best-effort.** A tool call is accepted only if the tool name is in the current request's tool set, the arguments validate against that tool's schema, the `call_id` is one the Gateway issued or can bind, and the turn nonce matches — so page content or retrieved web content cannot forge a tool call into the Agent Client.
- **Capability is reported honestly.** The provider capability matrix reports `tools: prompt-emulated`. It is never advertised as native function calling, because reliability is genuinely lower.
- **Native channels are per-provider optimizations only.** If a site later exposes a dependable native tool channel, that provider may report `tools: native` and use it, but no such channel may become a precondition for the product working.
