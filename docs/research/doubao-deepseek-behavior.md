# Doubao and DeepSeek — Web Behavior Notes

> Source: independent reading of Zotero GPT Connector's site handling as a research lead.
> That userscript is **All Rights Reserved** (see ADR-0003): these notes record **facts about
> the websites themselves** — endpoints, input mechanisms, stream shape — and must not be
> turned into copied selectors, parsers, or adapter code. Every value below is re-verified
> against the live site before an adapter ships.

## Doubao (`www.doubao.com/chat/*`)

- **Primary output path: network interception.** Completion traffic is observable on a
  `chat/completion`-shaped request, so real incremental streaming is achievable —
  `streamSource: "network"`, not buffered replay.
- **Reasoning is separate.** The stream carries thinking blocks distinctly from answer
  content, including an empty-thinking-block boundary convention in older versions. Maps
  cleanly onto `reasoning.delta` vs `text.delta`.
- **Structured frontend state exists as a fallback.** Rendered message nodes carry React
  internals whose props expose a structured `content_blocks_v2` message object. This is a
  genuinely better fallback than scraping rendered text, and justifies
  `streamSource: "frontend-state"` as its own tier between network interception and DOM diffing.
- **Input is paste-oriented** into a `role="textbox"` composer rather than a plain
  `<input>`; file attachment goes through a conventional file input.

## DeepSeek (`chat.deepseek.com`)

- **Primary output path: network interception**, on a completion-suffixed endpoint. Same
  streaming-fidelity conclusion as Doubao.
- **Input requires React-aware value setting.** The composer is a `textarea` whose React
  state will not update from a naive value assignment; the adapter must dispatch input the
  way the framework expects.
- **File attachment is drag-and-drop shaped**, not a plain file input — a materially
  different upload primitive from Doubao's.
- **Class names are build-hashed** (e.g. opaque short hashes for send button and message
  nodes), so any selector-based logic will drift on every frontend release. This is direct
  evidence for treating `adapter_drift` as a first-class error and for preferring network
  interception over CSS selectors wherever possible.

## Implications for the Automation Driver

1. **Text entry is not one primitive.** Paste, React-aware setters, contenteditable, and
   drag-drop upload all appear across just these two sites. The driver interface needs
   distinct primitives rather than a single `type()` that assumes a plain input.
2. **Both sites are network-interceptable**, which is good news for the streaming-fidelity
   requirement — the two first live-verified providers should not need DOM-diff streaming.
3. **A structured-frontend-state tier is real**, not theoretical, and belongs in the
   fallback ladder above rendered-text extraction.
4. **Selector fragility is asymmetric.** DeepSeek's hashed classes will break more often
   than Doubao's testid-style hooks; support tier and fixture refresh cadence should
   reflect that rather than treating all providers as equally stable.
