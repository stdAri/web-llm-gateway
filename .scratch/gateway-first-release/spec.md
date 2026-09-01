# Gateway Node — First Release

Status: ready-for-agent

## Problem Statement

A developer pays for consumer AI web subscriptions and wants their coding agents to use those models. Today they cannot.

The models they want are frequently reachable only through a Web Product. Some are web-exclusive, like GPT Pro. Some appear on the web well before the CLI or developer API catches up. Some belong to providers that, at least for a period, shipped no usable CLI at all and charged separately for API access. Meanwhile their Agent Clients — Codex, Claude Code — can only talk to API-shaped backends, so the developer is left choosing between the model they want and the agent workflow they want.

The existing ways around this all give up something essential:

- Copying prompts and answers between a terminal and a browser abandons the agent loop entirely; the model cannot read files, run commands, or edit code.
- Cookie-scraping proxies require extracting session material by hand, break when it rotates, and generally deliver text rather than a tool-capable agent turn.
- Consulting a Web Product as an MCP tool keeps some other model as the primary reasoner, so the developer still pays for and depends on the model they were trying to replace.
- Existing browser bridges that do support a real tool loop require site-side setup — a custom connector plus a vendor tunnel — and only work for one site and one client.
- General multi-provider gateways solve routing and protocol breadth, but their web providers are cookie-first and their harness-grade web path accepts only one client's native requests.

Underneath all of it sits a risk the developer is acutely aware of: a gateway that drives a website through a launched automation browser presents automation fingerprints that anti-bot systems specifically look for, which is exactly why this developer already does their web work in a dedicated fingerprint browser.

## Solution

A lightweight, local-first **Gateway Node** that makes an authenticated **Web Product** the **Primary Model Backend** for any **Agent Client**.

The Developer User runs the daemon, installs the Bridge into their own browser, and stays logged into the Web Products they already use. The daemon exposes standard OpenAI Responses and Anthropic Messages endpoints, so Codex and Claude Code connect the same way they would connect to any gateway: a base URL and a **Gateway API Key**. Models are chosen by the name the Web Product itself shows, qualified by a provider prefix.

When a task runs, the Agent Client keeps everything that makes it an agent — the workspace, the permission prompts, the sandbox, the UI — and the Web Product supplies the reasoning. The web model can ask for the client's tools; the Gateway Node translates that into the client's native tool call, the client executes it under its own rules, and the result is fed back into the same web conversation until a final answer arrives.

Nothing about this requires copying cookies, installing a site-side connector, or letting the Gateway launch and drive a browser of its own. Page interaction happens inside the Developer User's own already-trusted browser through a **Bridge Driver**, which is a userscript, so the environment the Web Product sees is the same environment it saw when the developer was using it by hand.

## User Stories

### Setup and pairing

1. As a Developer User, I want to start the Gateway Node with a single command, so that I can try it without reading a deployment guide.
2. As a Developer User, I want the daemon to bind to loopback by default, so that nothing on my network can reach my logged-in Web Products.
3. As a Developer User, I want the daemon to generate a Gateway API Key on first run, so that a stray local process cannot call my gateway.
4. As a Developer User, I want to install the Bridge as a userscript from a single build artifact, so that setup is one install rather than a per-site chore.
5. As a Developer User, I want to pair the Bridge with a one-time Bridge Pairing Token, so that an arbitrary page in my browser cannot connect to my daemon just because it can reach loopback.
6. As a Developer User, I want a command that reissues the Bridge Pairing Token, so that I can re-pair after reinstalling the script or rotating the secret.
7. As a Developer User, I want the Bridge Pairing Token to be separate from the Gateway API Key, so that a token exposed inside a web page does not also grant my Agent Clients' access.
8. As a Developer User, I want copy-pasteable configuration snippets for Codex and Claude Code, so that I do not have to work out which environment variable each client reads.

### Providers, login, and tabs

9. As a Developer User, I want to keep using my normal browser and its normal login flow, so that the Web Product sees the same environment it has always seen for my account.
10. As a Developer User, I want every matching Web Product tab to register itself automatically, so that the common case takes no configuration.
11. As a Developer User, I want a visible per-tab toggle that I can switch off, so that a tab I am using for a personal conversation is never taken over by an Agent Task.
12. As a Developer User, I want to see which tabs are currently registered and alive per provider, so that I can tell at a glance whether the gateway has capacity.
13. As a Developer User, I want a tab the browser has discarded or suspended to drop out of the pool automatically, so that tasks are never dispatched into a tab that is no longer running.
14. As a Developer User, I want to be told clearly when a Web Product session has expired, so that I know to log in again rather than guessing why tasks fail.
15. As a Developer User, I want an expired session to pause that provider rather than fail every queued task in a burst, so that a re-login recovers cleanly.

### Models and capabilities

16. As a Developer User, I want the model list to come from what my account can actually see in the Web Product, so that I am not offered models my subscription does not include.
17. As a Developer User, I want models to keep the names the Web Product displays, so that what I select matches what I see on the website.
18. As a Developer User, I want provider-qualified model identifiers, so that identically-named models on different sites remain distinguishable.
19. As a Developer User, I want the Web Effort options offered per model to reflect what the site genuinely exposes, so that a reasoning depth I select is a real setting rather than a prompt trick.
20. As an Agent Client, I want `/v1/models` to list available web models, so that model discovery works through the client's normal mechanism.
21. As a Developer User, I want a stale catalog to be marked stale rather than silently trusted, so that I can tell the difference between confirmed and remembered capability.
22. As a Developer User, I want the selection verified against the live Web Product before a turn is submitted, so that a model that disappeared does not silently become a different one.
23. As a Developer User, I want each provider to publish a capability matrix, so that I know before I start whether it supports images, files, citations, or web-native search.

### Running tasks

24. As a Codex user, I want to point Codex at the Gateway Node as a custom provider, so that I can run my normal Codex workflow against a web model.
25. As a Claude Code user, I want to point Claude Code at the Gateway Node with a base URL and token, so that I can run my normal Claude Code workflow against a web model.
26. As an Agent Client, I want Responses and Messages to behave equivalently, so that neither client is a second-class citizen.
27. As a Developer User, I want output to stream as it is produced, so that a long answer does not look like a hang.
28. As a Developer User, I want reasoning content delivered separately from answer content, so that my client renders thinking the way it normally does.
29. As a Developer User, I want to know how a stream was actually obtained, so that a replayed buffer is never presented to me as native streaming.
30. As a Developer User, I want cancelling in my Agent Client to stop generation in the Web Product, so that an abandoned task stops consuming my account's capacity.
31. As a Developer User, I want a turn that exceeds its timeout to fail explicitly, so that a stuck page does not hold a task open forever.

### The tool loop

32. As a Developer User, I want the web model to be able to request my Agent Client's tools, so that it can read files, run commands, and edit code rather than only answering.
33. As a Developer User, I want tools executed by my Agent Client under its own permissions and sandbox, so that the Gateway never becomes a second, unreviewed execution path.
34. As an Agent Client, I want tool requests delivered as my protocol's native tool call, so that my existing approval and execution flow works unchanged.
35. As an Agent Client, I want to return tool results through my protocol's normal mechanism, so that I do not need gateway-specific handling.
36. As a Developer User, I want tool results fed back into the same web conversation, so that the model continues the task instead of starting over.
37. As a Developer User, I want multi-round tool loops to work, so that non-trivial tasks can finish.
38. As a Developer User, I want tool calls validated against the tools my client actually offered, so that page content cannot invent a tool that was never on the table.
39. As a Developer User, I want tool arguments validated against their schema, so that malformed calls fail loudly instead of reaching my machine.
40. As a Developer User, I want a turn nonce checked on every tool call, so that text inside a page or a retrieved document cannot forge one.
41. As a Developer User, I want tool support reported honestly as prompt-emulated, so that I calibrate my expectations against how it actually works.

### Isolation, concurrency, and continuity

42. As a Developer User, I want each Agent Task to have its own isolated conversation context, so that one task's history never leaks into another's.
43. As a Developer User, I want subagents to be isolated from the main task and from each other, so that parallel work does not cross-contaminate.
44. As a Developer User, I want subagents to work without pre-opening a tab for each one, so that a dynamic number of subagents does not require me to predict it.
45. As a Developer User, I want tasks to queue when every tab of a provider is busy, so that demand above capacity waits rather than failing immediately.
46. As a Developer User, I want a queue wait to time out with a clear message, so that I learn to open another tab instead of watching my client hang.
47. As a Developer User, I want a task to continue its existing web conversation where that is possible, so that follow-up turns do not resend everything.
48. As a Developer User, I want a task to recover by replaying its canonical context when the conversation, tab, or daemon is gone, so that a restart does not destroy work in progress.
49. As a Developer User, I want isolated conversations to default to a Temporary Chat where the Web Product offers one, so that agent traffic does not fill my personal chat history.

### Safety and limits

50. As a Developer User, I want conservative default limits, so that my account is not exposed to obviously machine-shaped traffic before I have tuned anything.
51. As a Developer User, I want submissions spaced and jittered, so that my request cadence is not perfectly regular.
52. As a Developer User, I want repeated failures to trigger escalating cooldowns, so that a broken provider is not hammered.
53. As a Developer User, I want a suspected challenge or risk-control response to pause the provider for my attention, so that automation never retries into an enforcement signal.
54. As a Developer User, I want a warning when my hourly volume gets high, so that I notice before a pattern becomes a problem.
55. As a Developer User, I want to raise limits deliberately, so that throughput is a choice I make rather than a default I inherit.
56. As a Developer User, I want cookies, tokens, and full prompts kept out of ordinary logs, so that diagnostics are safe to read and share.

### Failure behavior

57. As a Developer User, I want an unavailable model to fail with a message naming what I asked for and what is available, so that I can correct the request.
58. As a Developer User, I want no silent substitution of a different model, effort, or provider, so that an agent loop cannot quietly change what is reasoning about my code.
59. As a Developer User, I want a lost tab mid-turn reported distinctly, so that I can tell an infrastructure blip from a site problem.
60. As a Developer User, I want suspected site drift reported as its own error class, so that I know an adapter needs updating rather than suspecting my configuration.
61. As a Developer User, I want a diagnostic identifier on failures, so that I can find the corresponding redacted record.

### Control Panel

62. As a Developer User, I want a local Control Panel in my browser, so that I can configure and inspect the node without editing files.
63. As a Developer User, I want the panel organized by resource, so that providers, keys, limits, models, and diagnostics each have an obvious place.
64. As a Developer User, I want provider health, support tier, and live tab count in one view, so that I can diagnose capacity at a glance.
65. As a Developer User, I want to edit limits in the panel, so that tuning does not require a restart cycle I have to reason about.
66. As a Developer User, I want a connectivity self-test, so that I can confirm the path works before blaming my Agent Client.
67. As a Developer User, I want the panel to never be a chat window, so that it stays a control surface rather than becoming a second client.

### Independent updates

68. As a Developer User, I want the Bridge to auto-update, so that site fixes reach me without a daemon release.
69. As a Developer User, I want a provider fix to require only a Bridge update, so that the most frequent kind of breakage has the cheapest remedy.
70. As a Developer User, I want daemon-only changes to leave my Bridge alone, so that unrelated updates do not disturb a working browser setup.
71. As a Developer User, I want a version mismatch reported plainly, naming which side is behind, so that I am not left diagnosing subtle misbehavior.

## Implementation Decisions

### Component split

Two independently deployable halves, connected by one versioned contract, per ADR-0014.

**Gateway Node (daemon)** owns: the HTTP surface for Responses, Messages, and model listing; the Canonical Core with the Agent Task lifecycle, tool loop, and Conversation Continuity; the Tab Lease pool and queueing; rate limits and cooldowns; error mapping; the Bridge server; and the Control Panel.

**Bridge (browser)** owns: tab registration and heartbeat, Provider Adapters, page interaction, model and capability discovery, output parsing, and transport. It contains nothing else — no protocol translation, no tool-loop policy, no limit enforcement.

### Client protocols

Responses and Messages are peers, per ADR-0002. Both translate into one canonical request, event, tool, and task model, per ADR-0005, so Provider Adapters never learn which client is calling. Chat Completions is not implemented. There is no MCP surface, per ADR-0006.

Authentication uses a Gateway API Key carried in whatever field each client's protocol provides. The Bridge authenticates separately with a Bridge Pairing Token, reissuable by command, per ADR-0007.

### Bridge Protocol

A versioned duplex contract carrying canonical events upward and commands downward, negotiated at registration. Providers are **data declared by the Bridge**, not a compiled-in daemon enum: a Bridge announces provider identity, Web Model Catalog, Web Effort options, and capability matrix on connect. Mismatch inside the supported window degrades to a warning; outside it, an explicit error naming the lagging side.

Canonical events and error codes follow `docs/design/canonical-events-and-errors.md`, which is provisionally adopted and expected to change under implementation feedback. Every turn event carries stream provenance so buffered replay is never presented as native streaming, and usage is flagged as estimated.

### Provider Adapters

Adapters execute inside the page but are authored in the repository as ordinary modules and bundled into the Bridge artifact at build time, per ADR-0007. They follow the reliability ladder established by research: intercepted network frames first, structured frontend state second, DOM diffing third, rendered-text extraction last. Text entry is not one primitive — paste, framework-aware value setting, contenteditable, and drag-drop upload all appear across the first three providers — so the adapter environment exposes distinct primitives rather than a single generic typing call.

First release implements and live-verifies ChatGPT, Doubao, and DeepSeek; every other Web Product exists as inventory with a Provider Support Tier, per ADR-0003. Zotero GPT Connector informs research only; none of its code, selectors, parsers, or upload strategies may be copied.

### Model selection

The catalog is derived from the authenticated account, cached with explicit staleness, and re-verified against the live Web Product before submission. Identifiers keep the site's own display name behind a provider prefix; the Gateway maintains no static renaming table. Web Effort maps to genuinely exposed site options only — never prompt-simulated, never silently dropped.

Unavailable model, effort, provider, or capacity fails closed with an explicit error, per ADR-0013. No automatic substitution, no fallback chain; that policy belongs to an upstream router.

### Tool lifecycle

Prompt-emulated tools are the baseline, per ADR-0012. Canonical tool definitions are encoded into a structured envelope the web model emits; the Bridge parses it; the **daemon** revalidates tool allowlist, argument schema, `call_id`, and turn nonce before anything reaches an Agent Client. Bridge-supplied structure is never trusted for a security decision, because the page it came from is not trusted. Capability reports `tools: prompt-emulated`. Native site channels are per-provider optimizations only and may never become a precondition.

### Tasks, tabs, and continuity

A Tab Lease pool assigns any registered live tab to any turn; isolation comes from conversation scoping on lease, not from tab ownership, per ADR-0008. Registration defaults on with a per-tab opt-out toggle. Heartbeat governs liveness so discarded tabs leave the pool. Per-provider concurrency is bounded by live tab count and by configured limits; excess queues and then times out explicitly; zero tabs fails closed.

Canonical Agent Task state is durable and authoritative; web conversations are continued where valid and reconstructed by replay where not, defaulting to Temporary Chat where the Web Product offers one, per ADR-0004.

### Limits

Defaults per ADR-0010: concurrency 1, minimum interval 3000ms with 20% jitter, queue timeout 60000ms, turn timeout 300000ms, escalating cooldowns at 3/5/8 consecutive failures of 60s/300s/1800s, 1800s cooldown plus provider pause on a suspected challenge, and a soft hourly warning at 60 turns. All overridable. These numbers are unvalidated starting points, not measured findings.

### Packaging and Control Panel

A daemon plus CLI, with the Control Panel served locally, per ADR-0009. No desktop shell. The panel is organized by resource — providers, access, models, limits, activity, diagnostics — mirroring CLIProxyAPI's management split, and contains no execution surface beyond a connectivity self-test.

## Testing Decisions

A good test here asserts externally observable behavior: what an Agent Client receives over HTTP, what canonical events a recorded page interaction produces, what error a caller gets. Tests must not assert internal call sequences, private structure, or which branch of the reliability ladder an adapter took, because those are exactly the things expected to change as sites drift.

**There is no prior art in this codebase — it is empty.** External prior art worth following: `codex-chatgpt-web` keeps fixture-driven parser tests separate from live browser behavior, and CLIProxyAPI tests protocol translators independently of upstream providers. Both patterns are adopted below.

### Surface one — daemon end-to-end

Entry at the real HTTP surface, with a fake Bridge emitting canonical events in place of a browser. This exercises protocol translation, the Canonical Core, the tool loop, Tab Lease and queueing, continuity, limits, and error mapping in one pass, for both Responses and Messages.

Covers: streaming event order and shape for both protocols; equivalence of behavior between the two; a full multi-round tool loop including result feedback; rejection of a forged tool call with a bad nonce, unknown tool name, or schema-invalid arguments; cancellation propagating to a stop command; queue timeout; zero-tab fail-closed; unavailable model producing an explicit error with the available list; no-substitution guarantees; cooldown escalation; provider pause on a challenge signal; protocol version mismatch reporting.

### Surface two — Provider Adapter parsers

Adapters are pure functions over recorded, redacted frames captured from real sites, run in CI without credentials. A site change makes these fail precisely, which is the intended detector for the `adapter_drift` error class.

Covers, per provider: model and Web Effort discovery from a captured catalog state; incremental text parsing; reasoning separated from answer content; tool envelope extraction including the multi-call case; completion detection; stop/cancel recognition; malformed and truncated frames.

### Surface three — live smoke

Real accounts, run deliberately rather than in CI. Order is Doubao and DeepSeek first, ChatGPT afterward, per ADR-0011. Without credentials these must report skipped explicitly; passing silently is a defect.

Covers: real login detection, real catalog discovery, one real streamed turn, one real tool round trip, real cancellation, and fixture regeneration.

### Acceptance

The release is accepted when real Codex and real Claude Code each complete a multi-turn task with at least one tool round trip against a live web model, and when the same task survives a daemon restart through canonical replay.

## Out of Scope

- Chat Completions, and any MCP surface.
- A Managed Driver using Playwright or CDP; the interface must accommodate it later, but nothing ships that launches a browser.
- A browser extension; the userscript is the first Bridge, with extension migration deferred until the protocol is stable.
- Any desktop shell.
- Auto-opening tabs, focusing windows, or otherwise driving the browser outside a registered tab.
- More than one account per Web Product, account pools, load balancing, and multi-tenant use.
- Fallback chains, model combos, quota accounting, and billing.
- Remote or shared access; loopback only.
- Attachments, citations, and web-native search as guaranteed cross-provider features; they are capability-gated per provider and reported honestly, not part of the common baseline.
- Any attempt to bypass captchas, verification, or risk controls.
- CLIProxyAPI or OmniRoute integration.
- Providers beyond ChatGPT, Doubao, and DeepSeek as verified adapters; the rest remain inventory.

## Further Notes

**The load-bearing unknown is prompt-emulated tool reliability.** Every reference implementation with a dependable same-response tool loop achieved it through a site connector and vendor tunnel. The nearest connector-free precedent works but is primitive. If envelope emission proves too unreliable across three heterogeneous sites, the first release's central claim weakens, and that should be discovered early rather than at acceptance.

**Site drift is the expected steady-state cost.** DeepSeek's build-hashed class names will break selector-dependent paths on ordinary frontend releases. This is why network interception is preferred, why `adapter_drift` is a distinct error class, and why Bridge-only updates matter.

**Temporary Chat availability is unverified** for Doubao and DeepSeek. ADR-0004 hedges with "where available"; the adapters must establish what each site actually offers and fall back to canonical replay where it offers nothing.

**The default limits are guesses.** They are deliberately conservative, but no measurement backs them. They should be revisited once real usage exists.

**Account risk is real and not fully mitigated by architecture.** Running inside the Developer User's own browser removes automation-environment fingerprints but not behavioral signals. Volume, cadence, and duration remain the developer's exposure, which is why limits are conservative by default and why a challenge response pauses rather than retries.
