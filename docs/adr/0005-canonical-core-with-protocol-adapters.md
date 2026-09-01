---
status: accepted
---

# Put Client Protocols Around One Canonical Core

OpenAI Responses and Anthropic Messages are peer external protocols translated into one canonical request, event, tool, and Agent Task model. Web Provider Adapters consume only that canonical contract, so adding a client protocol or MCP facade does not fork browser, provider, conversation, or tool-lifecycle implementations.
