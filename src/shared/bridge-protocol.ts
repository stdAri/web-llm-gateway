/**
 * Bridge Protocol: the versioned duplex contract between the daemon and the
 * Bridge, per ADR-0014. Messages flow upward as events, downward as commands.
 * Providers are data the Bridge declares at registration.
 */

import type { CatalogModel, ProviderRegistration } from "./canonical";

export type BridgeProtocolVersion = 1;

export const BRIDGE_PROTOCOL_VERSION = 1 as const;

/**
 * A tool envelope as extracted from the model's answer text by the Bridge:
 * the tag attributes plus the parsed JSON body. `id` is model-supplied and
 * only meaningful for pairing a result to a call within one conversation —
 * the daemon rewrites it before anything reaches an Agent Client.
 */
export interface ParsedToolCall {
  nonce?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

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
      type: "turn.delta";
      turnId: string;
      provider: string;
      /** One increment of the in-progress answer. Deltas arrive in order and
       * precede turn.result; a Bridge that cannot stream simply never sends
       * them, which the daemon reports as a buffered turn. */
      delta: { kind: "text" | "reasoning"; text: string };
    }
  | {
      type: "turn.result";
      turnId: string;
      provider: string;
      /** The answer prose with tool envelopes removed. */
      text: string;
      /** Reasoning ("thinking") content, kept separate from the answer. */
      reasoning?: string;
      streamSource: "network" | "frontend-state" | "dom-diff" | "buffered";
      /** Set when the turn ended because it was cancelled rather than finished.
       * Distinct from `error`: a cancelled turn is an outcome, not a failure. */
      cancelled?: boolean;
      /** What the Web Product itself reported as serving this turn, used to
       * verify the selection was honoured rather than assumed. */
      provenance?: Record<string, unknown>;
      error?: { code: string; message: string };
      /** Tool envelopes extracted from the answer, per ADR-0012: parsed in the
       * page, but never trusted — the daemon revalidates every call. */
      toolCalls?: ParsedToolCall[];
      /** A `<tool_call` opener was seen but could not be parsed (unclosed tag
       * or malformed JSON body). The daemon decides nudge vs failure. */
      envelopeError?: string;
      /** The web conversation this turn ran in (provider-side reference, e.g.
       * the conversation URL), so the daemon can bind continuations to it. */
      conversationRef?: string;
      /** What the Bridge observed while driving the page. An empty answer is
       * otherwise indistinguishable between "never submitted the prompt" and
       * "submitted it but captured no stream". */
      diagnostics?: Record<string, unknown>;
    }
  | {
      /** Bridge -> daemon: the catalog became observable (the tab reached the
       * new-chat screen) and may differ from what was reported at registration.
       * Without this the daemon's catalog can only ever be as fresh as the last
       * reconnect. */
      type: "bridge.catalog";
      provider: string;
      models: CatalogModel[];
      selectedModel?: string;
      observedAt: number;
    }
  | {
      /** Daemon -> Bridge: stop generating this turn in the Web Product. The
       * Bridge answers with a `turn.result` carrying `cancelled` and whatever
       * partial text it had assembled. */
      type: "turn.cancel";
      turnId: string;
      provider: string;
    }
  | {
      type: "turn.request";
      turnId: string;
      provider: string;
      prompt: string;
      /** The site's own model name to run this turn with. The Bridge selects it
       * on the page before submitting, or refuses the turn if it cannot. */
      model?: string;
      /** The site's own effort label to enable for this turn (DeepSeek:
       * 深度思考). Absent means explicitly off rather than "leave as-is". */
      effort?: string;
      /** Daemon-issued conversation handle. Present = continue that web
       * conversation; absent = start a fresh one. */
      conversationId?: string;
      /** The provider-side reference the Bridge recorded for this
       * conversation; a continuation while the tab sits elsewhere is
       * rejected rather than posted into the wrong conversation. */
      conversationRef?: string;
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
