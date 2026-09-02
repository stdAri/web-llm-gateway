/**
 * Build the Bridge userscript artifact from the TypeScript source.
 * Outputs a single installable .user.js file to dist/bridge.user.js.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { buildUserscript, BRIDGE_CONFIG_DEFAULT } from "../src/bridge/bridge";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

// No secret is compiled in: the artifact published at @updateURL is public, and
// the Bridge Pairing Token is entered once in the browser instead.
const artifact = buildUserscript(BRIDGE_CONFIG_DEFAULT, {
  version: pkg.version,
  updateUrl: "https://raw.githubusercontent.com/stdAri/web-llm-gateway/main/dist/bridge.user.js",
});
const outPath = join(dist, "bridge.user.js");
writeFileSync(outPath, artifact, "utf8");
console.log(`Bridge artifact written to ${outPath} (${artifact.length} bytes)`);