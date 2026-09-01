---
status: accepted
---

# The Bridge Protocol Is a Versioned Contract Between Independently Updatable Halves

The Bridge and the Gateway Node are deployed by different mechanisms on different cadences — a userscript auto-updates in the browser, a daemon updates by release — so the protocol between them is treated as a stable versioned contract rather than an internal calling convention. Each side declares its protocol version at registration, a version mismatch inside the supported window degrades to a reported warning rather than a failure, and a mismatch outside it fails with an explicit message naming which side is behind instead of misbehaving subtly.

The consequence that matters most: the Gateway Node treats providers as **data declared by the Bridge at registration**, not as a compiled-in list. A Bridge that has learned a new Web Product announces its identity, model catalog, Web Effort options, and capability matrix on connect, and the daemon routes to it without a daemon release. Adding or repairing a provider is therefore a Bridge-only update, which is the right cost profile given that site drift is the most frequent change and that the Provider Inventory is intended to grow well beyond the first three verified providers.

Conversely, daemon-only concerns — protocol translation, the tool loop, continuity, limits, error mapping, the Control Panel — must not require a Bridge update, so the Bridge stays free of anything but page interaction, parsing, and transport.
