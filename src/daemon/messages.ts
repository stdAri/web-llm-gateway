/**
 * Anthropic Messages protocol adapter (tickets 02 and 03).
 *
 * Translates between what Claude Code actually sends on `POST /v1/messages`
 * and the daemon's canonical turn, per ADR-0002 (Responses and Messages are
 * peer protocols) and ADR-0005 (one canonical core, protocol adapters at the
 * edge).
 *
 * Scope:
 * - Honoured request fields: `model` (echo + provider routing), `messages`,
 *   `system`, `stream`, `tools`, `tool_choice` ("none" strips tools; every
 *   other value behaves as "auto" — a web model cannot be forced). Everything
 *   else present on the request is reported explicitly (response header +
 *   daemon log), never silently dropped.
 * - `stream: true` on a plain text turn is answered with a *real* incremental
 *   SSE stream fed by Bridge `turn.delta` events (ticket 04), provenance
 *   `x-gateway-stream-source: network`. Turns that never produce a delta
 *   (older Bridge, interception missed the stream) and tool-loop turns (calls
 *   must be validated atomically) fall back to a synthesized stream from the
 *   complete answer, declared `x-gateway-stream-source: buffered`. Buffered
 *   replay is never presented as native streaming.
 * - Usage figures are rough length-based estimates; responses carry
 *   `x-gateway-usage: estimated`.
 * - Tools are prompt-emulated per ADR-0012: definitions are encoded into the
 *   envelope setup prompt (tool-loop.ts), the model's envelopes come back as
 *   parsed calls, and the daemon validates allowlist, schema, and per-turn
 *   nonce before emitting native `tool_use` blocks. Tool results arrive in a
 *   later request's `tool_result` blocks and are fed back into the same web
 *   conversation.
 *
 * Query parameters (Claude Code appends `?beta=true`) and version/beta
 * headers are accepted without validation — routing matches the path only.
 */

import { randomUUID } from "node:crypto";
import type { CanonicalErrorCode, StreamSource } from "../shared/canonical";
import { ToolLoop, ToolProtocolError, type ToolSpec, type ValidatedCall } from "./tool-loop";
import type { BridgeHub, TurnDelta, TurnOutcome } from "./bridge-hub";

/** Request fields this adapter actually honours. */
const HONOURED_FIELDS = new Set(["model", "messages", "system", "stream", "tools", "tool_choice"]);

export interface ToolResultBlock {
  toolUseId: string;
  content: string;
}

export interface ParsedMessagesRequest {
  /** The model name as requested, echoed back in the response envelope. */
  requestedModel: string;
  /** Provider routing key parsed from a `provider/model` qualified name. */
  providerPrefix?: string;
  /** System + conversation flattened into one submission text. Empty when the
   * request is a tool-result continuation (`toolResults` set). */
  prompt: string;
  stream: boolean;
  /** Tool definitions from the request, present only when usable. */
  tools?: ToolSpec[];
  /** Tool results answering our earlier tool_use blocks; set when the last
   * user message consists of tool_result content. */
  toolResults?: ToolResultBlock[];
  /** Top-level request fields present but not honoured by this release. */
  unhonouredFields: string[];
}

export class MessagesRequestError extends Error {
  readonly code = "invalid_request" as const;
}

type ContentBlock = {
  type?: string;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
};

/** Parse and validate the request body Claude Code sends. */
export function parseMessagesRequest(body: unknown): ParsedMessagesRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new MessagesRequestError("request body must be a JSON object");
  }
  const req = body as Record<string, unknown>;

  const model = req.model;
  if (typeof model !== "string" || model.length === 0) {
    throw new MessagesRequestError("missing or invalid 'model' field");
  }
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw new MessagesRequestError("missing or invalid 'messages' field");
  }

  const tools = parseTools(req);
  const toolResults = parseToolResults(req.messages as { role?: unknown; content?: unknown }[]);
  console.log(
    "[messages] payload: " +
      (req.messages as { role?: unknown; content?: unknown }[])
        .map((m) => {
          const role = typeof m?.role === "string" ? m.role : "?";
          const blocks = Array.isArray(m?.content)
            ? (m.content as { type?: string }[]).map((b) => b?.type ?? "?").join("|")
            : "text";
          return `${role}[${blocks}]`;
        })
        .join(" ") +
      ` toolResults=${toolResults ? toolResults.length : "no"}`,
  );

  const notes: string[] = [];
  let prompt = "";
  if (!toolResults) {
    const parts: string[] = [];
    const systemText = flattenSystem(req.system, notes);
    if (systemText) parts.push(systemText);
    for (const message of req.messages as { role?: unknown; content?: unknown }[]) {
      const role = typeof message?.role === "string" ? message.role : "user";
      const text = flattenContent(message?.content, notes);
      if (text) parts.push(`${roleLabel(role)}: ${text}`);
    }
    prompt = parts.join("\n\n");
    if (prompt.length === 0) {
      throw new MessagesRequestError("request carries no text content to submit");
    }
  }

  const unhonouredFields = Object.keys(req)
    .filter((k) => !HONOURED_FIELDS.has(k))
    .sort();
  unhonouredFields.push(...notes);

  const slash = model.indexOf("/");
  return {
    requestedModel: model,
    providerPrefix: slash > 0 ? model.slice(0, slash) : undefined,
    prompt,
    stream: req.stream === true,
    tools,
    toolResults,
    unhonouredFields,
  };
}

/** `tools` becomes honoured here; `tool_choice: "none"` strips them. */
function parseTools(req: Record<string, unknown>): ToolSpec[] | undefined {
  if (req.tools === undefined) return undefined;
  if (!Array.isArray(req.tools)) {
    throw new MessagesRequestError("'tools' must be an array");
  }
  const choice = req.tool_choice as { type?: string } | undefined;
  if (choice?.type === "none") return undefined;
  const specs = req.tools.map((t) => {
    const tool = t as { name?: unknown; description?: unknown; input_schema?: unknown };
    if (typeof tool?.name !== "string" || tool.name.length === 0) {
      throw new MessagesRequestError("every tool needs a 'name'");
    }
    return {
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : undefined,
      inputSchema:
        typeof tool.input_schema === "object" && tool.input_schema !== null
          ? (tool.input_schema as Record<string, unknown>)
          : undefined,
    };
  });
  return specs.length > 0 ? specs : undefined;
}

/** Tool results live in a user message as tool_result content blocks; their
 * presence marks the request as a continuation of a tool conversation.
 * Claude Code can append trailing role:"system" reminder messages after the
 * tool_result user message, so scan backwards for the last user message that
 * carries tool_result blocks instead of looking only at the final message. */
function parseToolResults(
  messages: { role?: unknown; content?: unknown }[],
): ToolResultBlock[] | undefined {
  let carrier: { role?: unknown; content?: unknown } | undefined;
  let carrierIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user" || !Array.isArray(m.content)) continue;
    if ((m.content as ContentBlock[]).some((b) => b?.type === "tool_result")) {
      carrier = m;
      carrierIndex = i;
      break;
    }
  }
  if (!carrier) return undefined;
  const blocks = carrier.content as ContentBlock[];
  const results = blocks.filter((b) => b?.type === "tool_result");
  const out: ToolResultBlock[] = [];
  for (const r of results) {
    if (typeof r.tool_use_id !== "string" || r.tool_use_id.length === 0) {
      throw new MessagesRequestError("tool_result block missing 'tool_use_id'");
    }
    out.push({ toolUseId: r.tool_use_id, content: flattenContent(r.content, []) });
  }
  // A user note can ride alongside the results, and trailing system-reminder
  // text after the carrier message is kept too; both are appended after the
  // tool output by the caller.
  const noteParts = blocks
    .filter((b) => b?.type === "text")
    .map((b) => b.text ?? "")
    .filter((t) => t.length > 0);
  for (const m of messages.slice(carrierIndex + 1)) {
    const text = flattenContent(m?.content, []);
    if (text) noteParts.push(text);
  }
  const note = noteParts.join("\n");
  if (note) out.push({ toolUseId: "", content: note });
  return out;
}

function flattenSystem(system: unknown, notes: string[]): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    const texts = (system as ContentBlock[])
      .filter((b) => b?.type === undefined || b.type === "text")
      .map((b) => b.text ?? "")
      .filter((t) => t.length > 0);
    const dropped = system.length - texts.length;
    if (dropped > 0) notes.push("non-text system blocks");
    return texts.join("\n\n");
  }
  return "";
}

function flattenContent(content: unknown, notes: string[]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = (content as ContentBlock[])
      .filter((b) => b?.type === "text")
      .map((b) => b.text ?? "")
      .filter((t) => t.length > 0);
    const dropped = content.length - texts.length;
    if (dropped > 0 && !notes.includes("non-text message blocks")) {
      notes.push("non-text message blocks");
    }
    return texts.join("\n\n");
  }
  return "";
}

function roleLabel(role: string): string {
  if (role === "user") return "Human";
  if (role === "assistant") return "Assistant";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/** Rough token estimate; web products report no accounting, per the design doc. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export type ResponseContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface TurnReply {
  content: ResponseContentBlock[];
  stopReason: "end_turn" | "tool_use";
  /** Text the usage estimate is computed from. */
  outputText: string;
}

/** A plain-text outcome as a reply: reasoning becomes its own thinking block
 * so clients render it the way they render native thinking. */
function plainReply(outcome: TurnOutcome): TurnReply {
  const content: ResponseContentBlock[] = [];
  if (outcome.reasoning) content.push({ type: "thinking", thinking: outcome.reasoning });
  content.push({ type: "text", text: outcome.text });
  return {
    content,
    stopReason: "end_turn",
    outputText: (outcome.reasoning ?? "") + outcome.text,
  };
}

/**
 * Drive one web conversation until it produces something an Agent Client can
 * consume: a final answer, or validated tool calls. Malformed rounds get one
 * nudge (decided inside ToolLoop.assess); forgery throws ToolProtocolError.
 */
export async function executeMessagesTurn(
  hub: BridgeHub,
  toolLoop: ToolLoop,
  provider: string,
  parsed: ParsedMessagesRequest,
  turnTimeoutMs: number,
): Promise<TurnReply> {
  let prompt: string;
  let conv;
  if (parsed.toolResults) {
    const firstRealResult = parsed.toolResults.find((r) => r.toolUseId.length > 0);
    const convId = firstRealResult
      ? toolLoop.conversationIdFor(firstRealResult.toolUseId)
      : undefined;
    const conversation = convId ? toolLoop.conversation(convId) : undefined;
    if (!conversation) {
      throw new MessagesRequestError(
        "no live web conversation for these tool results (the daemon keeps tool " +
          "conversations in memory; restart recovery is ticket 09)",
      );
    }
    if (conversation.provider !== provider) {
      throw new MessagesRequestError(
        `these tool results belong to a "${conversation.provider}" conversation, not "${provider}"`,
      );
    }
    conv = conversation;
    const results = parsed.toolResults.filter((r) => r.toolUseId.length > 0);
    const note = parsed.toolResults.find((r) => r.toolUseId.length === 0)?.content;
    prompt = toolLoop.buildResultMessage(conversation, results) + (note ? `\n\n${note}` : "");
  } else if (parsed.tools) {
    conv = toolLoop.begin(provider, parsed.tools);
    prompt = toolLoop.buildSetupPrompt(conv, parsed.prompt);
  } else {
    // No tools: the ticket 01/02 path, with reasoning split out (ticket 04).
    const outcome = await hub.submitTurn(provider, parsed.prompt, turnTimeoutMs);
    return plainReply(outcome);
  }

  for (;;) {
    const outcome = await hub.submitTurn(provider, prompt, turnTimeoutMs, {
      conversationId: conv.id,
    });
    const assessment = toolLoop.assess(conv, outcome);
    if (assessment.kind === "nudge") {
      console.log(`[tool-loop] ${conv.id} nudge: ${assessment.reason}`);
      prompt = assessment.prompt;
      continue;
    }
    if (assessment.kind === "final") {
      console.log(
        `[tool-loop] ${conv.id} final: ${assessment.text.slice(0, 120).replaceAll("\n", " ")}`,
      );
      return {
        content: [{ type: "text", text: assessment.text }],
        stopReason: "end_turn",
        outputText: assessment.text,
      };
    }
    const content: ResponseContentBlock[] = assessment.calls.map((c: ValidatedCall) => ({
      type: "tool_use",
      id: c.id,
      name: c.name,
      input: c.input,
    }));
    console.log(
      `[tool-loop] ${conv.id} tool_use: ` +
        assessment.calls.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join(", "),
    );
    if (assessment.prose.length > 0) {
      content.unshift({ type: "text", text: assessment.prose });
    }
    const outputText =
      assessment.prose + assessment.calls.map((c) => JSON.stringify(c.input)).join("");
    return { content, stopReason: "tool_use", outputText };
  }
}

/**
 * Real incremental streaming for plain text turns (ticket 04).
 *
 * The Bridge relays each DeepSeek frame's freshly appended content as a
 * `turn.delta`; here those deltas become Anthropic SSE events in canonical
 * order: message_start, a thinking block while reasoning flows, then a text
 * block, message_delta with the stop reason, message_stop. Reasoning is
 * emitted separately from answer content so the client renders thinking the
 * way it normally does.
 *
 * Provenance honesty is structural: the returned promise only resolves to
 * `network` once the first real delta has arrived — a turn whose Bridge never
 * streams (older build, interception missed) resolves to `buffered` with the
 * complete reply, and the caller replays it through synthesizedEventStream
 * with `x-gateway-stream-source: buffered`. Buffered replay is never
 * presented as native streaming.
 */
export type StreamReadiness =
  | { provenance: "network"; body: ReadableStream<Uint8Array> }
  | { provenance: "buffered"; reply: TurnReply };

export function executeMessagesTurnStreaming(
  hub: BridgeHub,
  provider: string,
  parsed: ParsedMessagesRequest,
  turnTimeoutMs: number,
): Promise<StreamReadiness> {
  const encoder = new TextEncoder();
  const id = `msg_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const emit = (event: string, data: unknown) => {
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  let started = false;
  let resolveReady!: (r: StreamReadiness) => void;
  let rejectReady!: (err: unknown) => void;
  const ready = new Promise<StreamReadiness>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  let openBlock: "thinking" | "text" | null = null;
  let blockIndex = -1;
  let outputText = "";

  const closeBlock = () => {
    if (openBlock === null) return;
    emit("content_block_stop", { type: "content_block_stop", index: blockIndex });
    openBlock = null;
  };
  const openBlockOf = (kind: "thinking" | "text") => {
    closeBlock();
    blockIndex += 1;
    openBlock = kind;
    emit("content_block_start", {
      type: "content_block_start",
      index: blockIndex,
      content_block: kind === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" },
    });
  };

  const onDelta = (delta: TurnDelta) => {
    if (!started) {
      started = true;
      emit("message_start", {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model: parsed.requestedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: estimateTokens(parsed.prompt), output_tokens: 1 },
        },
      });
      resolveReady({ provenance: "network", body });
    }
    if (delta.kind === "reasoning") {
      // Thinking only precedes the answer; a late reasoning fragment after
      // the text block opened has no honest place to go.
      if (openBlock === "text") return;
      if (openBlock !== "thinking") openBlockOf("thinking");
      emit("content_block_delta", {
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "thinking_delta", thinking: delta.text },
      });
      outputText += delta.text;
      return;
    }
    if (openBlock !== "text") openBlockOf("text");
    emit("content_block_delta", {
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "text_delta", text: delta.text },
    });
    outputText += delta.text;
  };

  hub
    .submitTurn(provider, parsed.prompt, turnTimeoutMs, { onDelta })
    .then((outcome) => {
      if (!started) {
        resolveReady({ provenance: "buffered", reply: plainReply(outcome) });
        return;
      }
      closeBlock();
      emit("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: estimateTokens(outputText) },
      });
      emit("message_stop", { type: "message_stop" });
      controller.close();
    })
    .catch((err: unknown) => {
      if (!started) {
        rejectReady(err);
        return;
      }
      // The stream is already with the client; report mid-stream the way the
      // Anthropic API does, then end the body.
      const e = err as Error & { code?: string };
      const mapped = mapCanonicalError(e.code ?? "internal_error");
      emit("error", { type: "error", error: { type: mapped.type, message: e.message } });
      try {
        controller.close();
      } catch {
        // already closed
      }
    });

  return ready;
}

/** Non-streaming Anthropic Message envelope. */
export function messageEnvelope(opts: {
  requestedModel: string;
  prompt: string;
  reply: TurnReply;
}): Record<string, unknown> {
  return {
    id: `msg_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    type: "message",
    role: "assistant",
    model: opts.requestedModel,
    content: opts.reply.content,
    stop_reason: opts.reply.stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: estimateTokens(opts.prompt),
      output_tokens: estimateTokens(opts.reply.outputText),
    },
  };
}

/**
 * Synthesized SSE stream from a complete, buffered reply. Event order follows
 * the mapping sketch in docs/design/canonical-events-and-errors.md. This is
 * not native streaming and the wire must say so (x-gateway-stream-source).
 */
export function synthesizedEventStream(opts: {
  requestedModel: string;
  prompt: string;
  reply: TurnReply;
}): string {
  const id = `msg_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const frames: [string, unknown][] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model: opts.requestedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: estimateTokens(opts.prompt), output_tokens: 1 },
        },
      },
    ],
  ];
  opts.reply.content.forEach((block, index) => {
    if (block.type === "thinking") {
      frames.push([
        "content_block_start",
        { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } },
      ]);
      for (const chunk of chunkText(block.thinking, 200)) {
        frames.push([
          "content_block_delta",
          { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: chunk } },
        ]);
      }
      frames.push(["content_block_stop", { type: "content_block_stop", index }]);
    } else if (block.type === "text") {
      frames.push([
        "content_block_start",
        { type: "content_block_start", index, content_block: { type: "text", text: "" } },
      ]);
      for (const chunk of chunkText(block.text, 200)) {
        frames.push([
          "content_block_delta",
          { type: "content_block_delta", index, delta: { type: "text_delta", text: chunk } },
        ]);
      }
      frames.push(["content_block_stop", { type: "content_block_stop", index }]);
    } else {
      frames.push(
        [
          "content_block_start",
          {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
          },
        ],
        ["content_block_stop", { type: "content_block_stop", index }],
      );
    }
  });
  frames.push(
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: opts.reply.stopReason, stop_sequence: null },
        usage: { output_tokens: estimateTokens(opts.reply.outputText) },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  );
  return frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function chunkText(text: string, size: number): string[] {
  if (text.length === 0) return [""];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

/** Anthropic-shaped error envelope for both plain and streaming requests. */
export function anthropicError(
  status: number,
  type: string,
  message: string,
): Response {
  return Response.json({ type: "error", error: { type, message } }, { status });
}

/** Map a canonical error code onto an Anthropic error type and HTTP status. */
export function mapCanonicalError(code: string): { status: number; type: string } {
  switch (code as CanonicalErrorCode | "invalid_request") {
    case "invalid_request":
      return { status: 400, type: "invalid_request_error" };
    case "model_unavailable":
      return { status: 404, type: "not_found_error" };
    case "provider_unavailable":
    case "provider_busy":
      return { status: 503, type: "overloaded_error" };
    default:
      return { status: 500, type: "api_error" };
  }
}

export { ToolProtocolError };
