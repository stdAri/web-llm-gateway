---
status: accepted
---

# Support Responses and Messages as Peer Client Protocols

The Gateway Node serves Codex, Claude Code, and other Agent Clients as peers, so its first publishable version must support both OpenAI Responses and Anthropic Messages with equivalent streaming, cancellation, tool-call, tool-result, and model-selection semantics. A shared internal task and event model must keep Web Provider Adapters independent of either wire protocol; Chat Completions may remain a later compatibility layer.
