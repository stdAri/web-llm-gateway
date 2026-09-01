---
status: accepted
---

# Control Panel Is Configuration and Visibility Only

The Control Panel follows CLIProxyAPI's management surface, which is organized by resource — credentials, config, downstream keys, routing, retry policy, logs, usage, plugins — and deliberately contains no execution surface, since generation happens on the `/v1/*` API instead. The Gateway Node's panel mirrors that split: it configures Providers, logins, keys, limits, and model visibility, and it reports health, tab registration, queue state, and redacted diagnostics, but it is not a chat playground and never becomes the place where Agent Tasks are authored or run. Its only request-issuing feature is a minimal connectivity self-test, equivalent to CLIProxyAPI's management `api-call`.

The Gateway Node ships as a daemon plus CLI, with the Control Panel served locally by that daemon and opened in the Developer User's browser. No Electron or Tauri desktop shell is built: the panel's job is configuration and visibility, which a served page already does, and a desktop shell would add packaging and update weight disproportionate to that job.
