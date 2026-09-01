# 15: Control Panel

**What to build:** A local page where the Developer User configures the node and sees what it is doing, without editing files or reading logs by hand. Providers with their health, support tier, and live tab count in one view. Keys and pairing. Models and their discovered capabilities. Limits, editable. Current work and queue depth. Recent failures with their diagnostic records.

Per ADR-0009 the panel is organised by resource, mirroring the split CLIProxyAPI uses, and it is not a chat window. Its only request-issuing feature is a connectivity self-test, so a Developer User can confirm the path works before blaming their Agent Client. Agent Tasks are never authored or run here.

**Blocked by:** 07, 10, 11

**Status:** ready-for-agent

- [ ] The panel is served locally by the daemon and reachable in the Developer User's browser
- [ ] Providers show health, support tier, login state, and live registered tab count
- [ ] Keys and pairing are manageable from the panel
- [ ] Discovered models, Web Effort options, capabilities, and catalog staleness are visible
- [ ] Limits are editable and take effect without an opaque restart cycle
- [ ] Current work, queue depth, and recent failures with diagnostic identifiers are visible
- [ ] A connectivity self-test confirms the path end to end
- [ ] The panel contains no chat surface and no way to author or run an Agent Task
