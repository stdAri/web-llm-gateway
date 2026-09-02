/**
 * Gateway Node CLI entry point.
 *
 * Commands:
 * - `serve` — start the daemon (loopback HTTP + WebSocket for Bridge)
 * - `pair` — reissue the Bridge Pairing Token (print it, don't start the daemon)
 */

import { resolve } from "node:path";
import { GatewayStore } from "./store";
import { resolveTurnTimeoutMs } from "./config";
import { BridgeHub } from "./bridge-hub";
import { GatewayHTTPServer } from "./http-server";

const GATEWAY_DIR = resolve(process.env.GATEWAY_DIR ?? ".gateway");
const DEFAULT_PORT = 8100;
const TURN_TIMEOUT_MS = resolveTurnTimeoutMs();

const command = process.argv[2] ?? "serve";

switch (command) {
  case "serve": {
    const store = new GatewayStore(GATEWAY_DIR);
    const state = store.loadOrCreate();
    const hub = new BridgeHub(state.pairingToken);
    const server = new GatewayHTTPServer({
      hub,
      port: DEFAULT_PORT,
      turnTimeoutMs: TURN_TIMEOUT_MS,
      gatewayApiKey: state.gatewayApiKey!,
    });
    const port = await server.start();
    console.log(`Gateway Node listening on http://127.0.0.1:${port}`);
    console.log(`Bridge Pairing Token: ${state.pairingToken}`);
    console.log("");
    console.log("Claude Code configuration:");
    console.log(`  export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`);
    console.log(`  export ANTHROPIC_AUTH_TOKEN=${state.gatewayApiKey}`);
    process.on("SIGINT", () => {
      server.stop();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      server.stop();
      process.exit(0);
    });
    break;
  }
  case "pair": {
    const store = new GatewayStore(GATEWAY_DIR);
    const state = store.rotatePairingToken();
    console.log(state.pairingToken);
    break;
  }
  default:
    console.error("usage: bun run <serve|pair>");
    process.exit(1);
}