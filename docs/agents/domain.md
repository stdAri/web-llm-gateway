# Domain Docs

How the engineering skills should consume this repository's domain documentation when exploring the codebase.

## Before exploring, read these

- `CONTEXT.md` at the repository root
- `CONTEXT-MAP.md` at the repository root if it exists; it points to context-specific `CONTEXT.md` files
- Relevant ADRs under `docs/adr/`
- Relevant proposals under `docs/design/`, which are drafts awaiting confirmation rather than settled decisions
- Relevant notes under `docs/research/`, which record third-party behavior established by independent investigation

Documents under `reference/` are obsolete early drafts kept only for their survey of existing open-source projects. Their architectural conclusions have been superseded; never treat them as current.

If any of these files do not exist, proceed silently. Do not suggest creating them upfront. `/domain-modeling`, reached through skills such as `/grill-with-docs`, creates them lazily when terms or decisions are actually resolved.

## File structure

This repository uses a single-context layout:

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Use the glossary's vocabulary

When output names a domain concept in an issue title, proposal, hypothesis, or test, use the term defined in `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

If a needed concept is not in the glossary, reconsider whether the language belongs to the project or note the gap for `/domain-modeling`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface the conflict explicitly rather than silently overriding the decision.
