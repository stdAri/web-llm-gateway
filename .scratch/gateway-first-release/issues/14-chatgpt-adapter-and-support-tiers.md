# 14: ChatGPT Web Provider Adapter and Provider Support Tiers

**What to build:** The third verified provider, and the one whose account carries the highest cost if automation-shaped traffic draws enforcement — which is why ADR-0011 puts it last. ChatGPT brings the models that motivate much of the project, including web-exclusive tiers and a genuine effort range.

Alongside it, the Provider Support Tier becomes visible: verified providers pass current live acceptance, experimental ones are implemented but unproven, and planned ones are inventory entries only. Per ADR-0003 a provider is never called supported because a reference project once contained selectors for that site.

**Blocked by:** 13

**Status:** ready-for-agent

- [ ] ChatGPT registers, discovers the models and effort levels the account can actually see, and reports its capability matrix
- [ ] Web-exclusive tiers available to the account are selectable and are not silently downgraded
- [ ] Text turns stream incrementally with reasoning separated from answer content
- [ ] The prompt-emulated tool loop completes a multi-round task on ChatGPT without any site connector or vendor tunnel
- [ ] Recorded, redacted ChatGPT frames drive parser tests in CI without credentials
- [ ] Every provider exposes a support tier, and inventory entries are visible as planned rather than hidden
