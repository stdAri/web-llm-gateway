---
status: accepted
---

# Verify Doubao and DeepSeek Before ChatGPT

Live acceptance testing runs against Developer-User-provided accounts, starting with Doubao and DeepSeek because those accounts carry lower consequences if automation-shaped traffic draws enforcement, and only then extending to ChatGPT where account loss would be more costly. CI runs without credentials against recorded, redacted network and DOM fixtures; live suites report skipped providers explicitly rather than passing silently when credentials are absent.
