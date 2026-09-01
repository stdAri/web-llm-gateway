/**
 * Durable daemon state: the Gateway API Key (ticket 02) and the Bridge
 * Pairing Token. Stored under `.gateway/` in the working directory.
 *
 * The Bridge Pairing Token is deliberately separate from the Gateway API Key
 * (CONTEXT.md): a token exposed inside a Web Product page must not also grant
 * an Agent Client's access to the Gateway.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GatewayState {
  pairingToken: string;
  gatewayApiKey?: string;
  createdAt: string;
}

export class GatewayStore {
  private readonly file: string;

  constructor(private readonly dir: string) {
    this.file = join(dir, "state.json");
  }

  loadOrCreate(): GatewayState {
    if (existsSync(this.file)) {
      const raw = readFileSync(this.file, "utf8");
      return JSON.parse(raw) as GatewayState;
    }
    mkdirSync(this.dir, { recursive: true });
    const state: GatewayState = {
      pairingToken: this.newToken(),
      createdAt: new Date().toISOString(),
    };
    writeFileSync(this.file, JSON.stringify(state, null, 2), { mode: 0o600 });
    return state;
  }

  rotatePairingToken(): GatewayState {
    const state = this.loadOrCreate();
    state.pairingToken = this.newToken();
    writeFileSync(this.file, JSON.stringify(state, null, 2), { mode: 0o600 });
    return state;
  }

  private newToken(): string {
    return `bp_${randomBytes(24).toString("hex")}`;
  }
}

export function randomToken(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
