/**
 * Canonical event and error types shared between the daemon and the Bridge.
 *
 * Mirrors `docs/design/canonical-events-and-errors.md` (provisionally adopted).
 * The daemon and Bridge are separately deployable halves joined by this one
 * versioned contract, per ADR-0014.
 */

export const PROTOCOL_VERSION = 1 as const;

export type StreamSource =
  | "network"
  | "frontend-state"
  | "dom-diff"
  | "buffered";

export type CanonicalEvent =
  | {
      type: "turn.started";
      turnId: string;
      provider: string;
      model: string;
      effort?: string;
      streamSource: StreamSource;
    }
  | { type: "reasoning.delta"; text: string }
  | { type: "reasoning.done" }
  | { type: "text.delta"; text: string }
  | { type: "text.done" }
  | { type: "tool_call.started"; callId: string; name: string }
  | { type: "tool_call.arguments.delta"; callId: string; delta: string }
  | { type: "tool_call.done"; callId: string; arguments: unknown }
  | { type: "citation"; url: string; title?: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; estimated: boolean }
  | {
      type: "turn.completed";
      stopReason: "end_turn" | "tool_use" | "cancelled" | "max_output";
    }
  | { type: "turn.failed"; error: CanonicalError };

export type CanonicalErrorCode =
  | "auth_required"
  | "auth_challenge"
  | "provider_unavailable"
  | "provider_busy"
  | "model_unavailable"
  | "tab_lost"
  | "adapter_drift"
  | "turn_timeout"
  | "tool_protocol_error"
  | "upstream_refused"
  | "cancelled";

export interface CanonicalError {
  code: CanonicalErrorCode;
  message: string;
  provider?: string;
  retryable: boolean;
  userActionRequired: boolean;
  diagnosticId?: string;
}

/**
 * The capability matrix a Bridge declares for a provider, per the
 * reliability ladder in ADR-0007: network interception is the top
 * fidelity tier, frontend state the next, DOM diffing below it, and
 * rendered-text extraction last.
 */
export interface ProviderCapabilities {
  streaming: boolean;
  streamSource: StreamSource;
  reasoning: boolean;
  tools: "none" | "prompt-emulated" | "native";
  images: boolean;
  files: boolean;
  citations: boolean;
  webSearch: boolean;
  effort: string[];
}

/**
 * The model catalog entry. Keeps the name the Web Product itself displays,
 * qualified by a provider prefix by the daemon; the Gateway maintains no
 * static renaming table (see CONTEXT.md "Web Model Catalog").
 */
export interface CatalogModel {
  id: string;
  displayName: string;
  effort?: string[];
}

/**
 * Provider identity announced by the Bridge at registration. Providers are
 * data declared by the Bridge, never a compiled-in daemon enum (ADR-0014).
 */
export interface ProviderRegistration {
  provider: string;
  protocolVersion: number;
  models: CatalogModel[];
  capabilities: ProviderCapabilities;
}

/**
 * A single text prompt submission for ticket 01. The thinnest complete path:
 * no model selection, no streaming to the caller, no tool loop, no queueing.
 */
export interface TurnRequest {
  prompt: string;
  provider?: string;
  model?: string;
  turnId?: string;
}

export interface TurnResult {
  turnId: string;
  provider: string;
  text: string;
  streamSource: StreamSource;
}
