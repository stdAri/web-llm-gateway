# Web LLM Gateway

Web LLM Gateway lets developer-facing agent clients use the behavior of authenticated consumer AI web products as model backends. This glossary distinguishes the web product, the developer client, and the task lifecycle that connects them.

## Language

**Developer User**:
A developer who runs the Gateway Node locally, installs its Bridge into their own browser, and signs in to Web Products through that browser's normal login flow. They are expected to install the project's own Bridge, but never to copy cookies, install site-side connectors such as a ChatGPT Custom Connector, or hand the Gateway a password. The first release serves one Developer User with one account per Web Product.
_Avoid_: End user, operator, administrator

**Agent Client**:
A CLI or application that owns the workspace and executes tools while delegating model turns through the Gateway. Codex, Claude Code, and other compatible applications are peer clients rather than one being the product's privileged target.
_Avoid_: Frontend, caller, harness

**Primary Model Backend**:
The role in which a Web Product supplies the model turns that drive an Agent Client's task, including requests for client-owned tools and continuation after tool results. The Web Product is not merely consulted as an MCP tool or subordinate second-opinion model.
_Avoid_: MCP consult tool, secondary model, embedded agent

**Gateway Node**:
A lightweight local service that presents standard model protocols to Agent Clients while using authenticated Web Products as its upstream backends. It includes a local Control Panel for configuration and visibility, but is not an all-purpose provider marketplace, billing system, or multi-tenant control plane.
_Avoid_: OmniRoute replacement, agent framework, browser plugin, remote model service

**Control Panel**:
The Gateway Node's local Web interface for configuring Web Products, opening login flows, inspecting models and capabilities, and viewing health, tasks, and diagnostics. It is an operational interface, not a hosted account or billing product.
_Avoid_: Cloud console, admin SaaS, provider marketplace

**Gateway API Key**:
A secret issued by the Gateway Node to authenticate a Developer User's local Agent Client. Each client carries it in whatever field its own protocol offers — Claude Code's `ANTHROPIC_AUTH_TOKEN`, a Codex custom provider's `env_key` — but the value belongs to the Gateway and is never a vendor or Web Product credential. It is separate from the Bridge Pairing Token.
_Avoid_: Anthropic API key, provider key, web credential

**Bridge Pairing Token**:
A separate secret authorizing one Bridge installation to connect to the local Gateway Node. It is deliberately not the Gateway API Key: a token exposed inside a Web Product page must not also grant an Agent Client's access to the Gateway. It is reissued on demand through a pairing command rather than being recovered or reused.
_Avoid_: Gateway API key, browser cookie, shared secret

**Web Product**:
A consumer AI website used through an authenticated account, including its selectable models, web-native capabilities, and product-level response behavior.
_Avoid_: Provider API, official API, model API

**Web Provider Adapter**:
A site-specific implementation behind the Gateway Node's common provider contract. It owns Web Product login checks, model and capability discovery, prompt submission, output extraction, cancellation, and any supported conversation or attachment behavior.
_Avoid_: Site script, protocol adapter, provider executor

**Provider Support Tier**:
The evidence level attached to a Web Provider Adapter: verified adapters pass current live acceptance tests, experimental adapters are implemented but not fully verified, and planned adapters are inventory entries only. An adapter is never called supported solely because a reference project once contained selectors for that site.
_Avoid_: Best-effort support, nominal support, copied site list

**Web-available Model**:
A model or capability available through a Web Product when an equivalent CLI or developer API is unavailable, arrives later, differs materially, or carries separate usage cost. GPT Pro and historically web-first providers such as DeepSeek are motivating examples.
_Avoid_: Free model, scraped API, unofficial model

**Web Product Behavior**:
The behavior actually produced by the selected model inside the Web Product, including product-level instructions and answer characteristics. It must come from a real web conversation rather than an official API call prompted to imitate the website.
_Avoid_: Web style, prompt emulation, API-equivalent behavior

**Web Conversation Path**:
An Adapter's route into an actual Web Product conversation. It may use visible UI automation or authenticated browser-context interfaces, provided it preserves the selected model and Web Product Behavior and leaves the conversation observable or continuable in the Web Product.
_Avoid_: Unauthenticated private API, detached inference call, UI-only automation

**Web Model Catalog**:
The models and associated selectable effort levels available to the Developer User's authenticated Web Product account. The Gateway obtains and caches this catalog from the Web Product, marks cached data as potentially stale, and verifies a requested choice against the live Web Product before use. Catalog entries keep the name the Web Product itself displays, qualified by a provider prefix so identically-named models on different sites stay distinguishable; the Gateway adds the prefix and never maintains a static renaming table.
_Avoid_: Hard-coded model list, API model catalog, renamed model ID

**Web Effort**:
A reasoning-depth option that the Web Product genuinely exposes for a selected web model. The Gateway may translate a client protocol's effort field into this option, but must not imitate an unavailable level through prompting or silently ignore it.
_Avoid_: Prompted effort, synthetic thinking level, ignored effort

**Managed Web Session**:
A Developer User's authenticated Web Product session, addressed through whichever browser environment the active Automation Driver targets. Under the Bridge Driver this is the Developer User's own already-authenticated browser; a future Managed Driver could instead own a dedicated Gateway-launched profile. Neither is assumed by default. The first release supports one account per Web Product, and an expired session pauses that provider rather than degrading silently.
_Avoid_: Gateway-launched profile, cookie, credential export

**Tab Lease**:
The temporary assignment of one registered, already-open provider tab to one in-flight Agent Task turn under the Bridge Driver. A tab is a reusable execution slot, not a dedicated container for one subagent: per-provider concurrency is bounded by how many tabs the Developer User currently keeps open and registered, excess demand queues, and zero open tabs for a requested provider fails closed rather than blocking indefinitely. Registration is heartbeat-based over the Bridge's persistent connection, so a tab the browser discards or suspends silently drops out of the pool instead of appearing falsely available. Every matching tab shows an injected toggle defaulting to registered; the Developer User can flip an individual tab off to exclude it, for example one being used for manual personal chat.
_Avoid_: Dedicated subagent tab, one-tab-per-task, pinned conversation tab

**Automation Driver**:
The pluggable execution layer that performs page actions (typing, clicking, page-context evaluation, network/DOM observation, file upload) on behalf of a Web Provider Adapter through one abstract interface. The Bridge Driver, a browser extension or userscript running inside the Developer User's own browser, is the first implementation; a Managed Driver owning a Playwright/CDP-controlled browser is a deferred, interface-compatible alternative. Provider Adapters are written against the interface, never against either driver directly.
_Avoid_: Browser runtime, Playwright wrapper, extension API

**Conversation Continuity**:
The property that later turns, including tool results, preserve the logical context of the same Agent Task while remaining isolated from other tasks. The guarantee is the property itself; the settled mechanism is hybrid, continuing an existing Web Product conversation where that path is valid and reconstructing canonical context where it is not.
_Avoid_: Conversation binding, session affinity, shared chat

**Web Relay**:
A model turn that sends input into a real Web Product conversation and returns the content generated there. A Web Relay alone does not imply support for Agent Client tools.
_Avoid_: Proxy request, API call

**Agent Task**:
An isolated task in which the Web Product can request tools from the Agent Client, receive their results, and continue until it produces a final answer. Its logical context must remain separate from other main or subagent tasks, without prescribing how the Gateway preserves that continuity. The first publishable product must support this lifecycle, while a text-only Web Relay is only the preceding technical proof.
_Avoid_: Chat, request, prompt-response
