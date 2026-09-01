/**
 * Build the Bridge userscript artifact from the TypeScript source.
 * Outputs a single installable .user.js file to dist/bridge.user.js.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { buildUserscript, BRIDGE_CONFIG_DEFAULT } from "../src/bridge/bridge";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

const config = {
  ...BRIDGE_CONFIG_DEFAULT,
  pairingToken: process.env.BRIDGE_PAIRING_TOKEN || "PAIRING_TOKEN",
};

const artifact = buildUserscript(config);
const outPath = join(dist, "bridge.user.js");
writeFileSync(outPath, artifact, "utf8");
console.log(`Bridge artifact written to ${outPath} (${artifact.length} bytes)`);