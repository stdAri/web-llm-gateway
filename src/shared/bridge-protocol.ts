/**
 * Bridge Protocol: the versioned duplex contract between the daemon and the
 * Bridge, per ADR-0014. Messages flow upward as events, downward as commands.
 * Providers are data the Bridge declares at registration.
 */

import type { ProviderRegistration } from "./canonical";

export type BridgeProtocolVersion = 1;

export const BRIDGE_PROTOCOL_VERSION = 1 as const;

export type BridgeMessage =
  | {
      type: "bridge.hello";
      pairingToken: string;
      registration: ProviderRegistration;
    }
  | {
      type: "bridge.hello_ack";
      protocolVersion: number;
      accepted: boolean;
      warning?: string;
    }
  | {
      type: "tab.registered";
      tabId: string;
      provider: string;
      url: string;
    }
  | {
      type: "tab.heartbeat";
      tabId: string;
      provider: string;
    }
  | {
      type: "tab.unregistered";
      tabId: string;
      provider: string;
    }
  | {
      type: "bridge.command";
      command: string;
      payload?: unknown;
    }
  | {
      type: "turn.result";
      turnId: string;
      provider: string;
      text: string;
      streamSource: "network" | "frontend-state" | "dom-diff" | "buffered";
      error?: { code: string; message: string };
    }
  | {
      type: "turn.request";
      turnId: string;
      provider: string;
      prompt: string;
      model?: string;
    }
  | {
      type: "turn.reject";
      turnId: string;
      provider: string;
      reason: string;
    };

export function isBridgeMessage(x: unknown): x is BridgeMessage {
  return (
    typeof x === "object" &&
    x !== null &&
    "type" in x &&
    typeof (x as { type: unknown }).type === "string"
  );
}
