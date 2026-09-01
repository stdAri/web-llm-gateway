# 16: Bridge Protocol versioning and independent updates

**What to build:** The two halves update on their own schedules without breaking each other. A site fix reaches the Developer User through a Bridge auto-update, with no daemon release; a daemon-only change leaves a working browser setup untouched.

Per ADR-0014 the protocol is a versioned contract rather than an internal calling convention. Each side declares its version at registration. A mismatch inside the supported window degrades to a reported warning; outside it, the connection fails with a message naming which side is behind, so nobody is left diagnosing subtle misbehaviour.

The consequence that matters most is already required by ticket 01 and must be verified here: providers are data the Bridge declares, not a compiled-in daemon list, so adding or repairing a provider stays a Bridge-only update.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Both sides declare a protocol version at registration
- [ ] A mismatch inside the supported window degrades to a visible warning and keeps working
- [ ] A mismatch outside the window fails explicitly and names which side is behind
- [ ] The Bridge auto-updates from a published artifact without daemon involvement
- [ ] A provider can be added or repaired by updating only the Bridge
- [ ] A daemon-only change requires no Bridge update
