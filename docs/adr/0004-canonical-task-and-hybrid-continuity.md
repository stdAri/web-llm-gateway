---
status: accepted
---

# Keep Canonical Task State and Use Hybrid Web Continuity

The Gateway Node owns durable canonical Agent Task state rather than treating a Web Product conversation as the sole source of truth. A Web Provider Adapter should continue an existing Web conversation when that path is valid, but must be able to reconstruct or replay canonical context when the conversation, browser surface, login session, or process cannot be recovered; Temporary Chat is the default where available, with regular saved conversations as a configurable provider capability.
