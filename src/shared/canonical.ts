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
  /** The Bridge has never been able to read the site's model picker. */
  | "catalog_unavailable"
  /** The site fixes the model for the life of a conversation (ADR-0013). */
  | "model_switch_unavailable"
  /** The site served the turn with a different effort than was selected. */
  | "effort_not_honoured"
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
 * When a Web Product lets the model be changed, which differs enough between
 * sites that one strategy cannot cover them.
 *
 * Verified on chat.deepseek.com: the mode radios (快速模式 / 专家模式 /
 * 识图模式) exist only on the new-chat screen and are gone once a conversation
 * has started, so a model change there means a new conversation. Doubao
 * exposes its model picker inside the conversation instead.
 *
 * The distinction is load-bearing rather than cosmetic: under
 * `at-conversation-start`, honouring a model change on a tool-result
 * continuation is impossible without abandoning the conversation the tool
 * results belong to, so it has to fail rather than silently switch (ADR-0013).
 */
export type ModelSwitching =
  /** The site offers no model choice. */
  | "none"
  /** Fixed when the conversation is created (DeepSeek). */
  | "at-conversation-start"
  /** Changeable at any point in an existing conversation (Doubao). */
  | "mid-conversation";

/**
 * Provider identity announced by the Bridge at registration. Providers are
 * data declared by the Bridge, never a compiled-in daemon enum (ADR-0014).
 */
export interface ProviderRegistration {
  provider: string;
  protocolVersion: number;
  /** The Bridge artifact's own @version. Distinct from protocolVersion: it does
   * not affect compatibility, it answers "which build is actually running in
   * the browser right now", which is otherwise unobservable from the daemon. */
  bridgeVersion?: string;
  models: CatalogModel[];
  /** How this site permits model changes; absent means the Bridge predates
   * catalog discovery and the daemon must not assume it can switch. */
  modelSwitching?: ModelSwitching;
  /**
   * When the Bridge last read the catalog off the page, as epoch ms.
   *
   * Not decoration: DeepSeek's mode radios only exist on the new-chat screen,
   * so a Bridge sitting in a conversation is reporting what it saw earlier.
   * The daemon marks that stale rather than presenting it as current.
   */
  catalogObservedAt?: number;
  /** The model the Bridge observed as selected when it last read the catalog. */
  selectedModel?: string;
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
