/**
 * Anthropic Messages protocol adapter (ticket 02).
 *
 * Translates between what Claude Code actually sends on `POST /v1/messages`
 * and the daemon's canonical text turn, per ADR-0002 (Responses and Messages
 * are peer protocols) and ADR-0005 (one canonical core, protocol adapters at
 * the edge).
 *
 * Scope for this ticket:
 * - Honoured request fields: `model` (echo + provider routing), `messages`,
 *   `system`, `stream`. Everything else present on the request is reported
 *   explicitly (response header + daemon log), never silently dropped.
 * - `stream: true` is answered with a *synthesized* SSE stream built from the
 *   complete answer, because the Bridge path (ticket 01) still returns answers
 *   whole. Provenance is declared on the wire as `x-gateway-stream-source:
 *   buffered`; real incremental streaming replaces this in ticket 04.
 * - The tool loop (`tools`, `thinking`, ...) is ticket 03; model catalog
 *   verification and fail-closed selection are ticket 06.
 *
 * Query parameters (Claude Code appends `?beta=true`) and version/beta
 * headers are accepted without validation — routing matches the path only.
 */

import { randomUUID } from "node:crypto";
import type { CanonicalErrorCode, StreamSource } from "../shared/canonical";

/** Request fields this adapter actually honours. */
const HONOURED_FIELDS = new Set(["model", "messages", "system", "stream"]);

export interface ParsedMessagesRequest {
  /** The model name as requested, echoed back in the response envelope. */
  requestedModel: string;
  /** Provider routing key parsed from a `provider/model` qualified name. */
  providerPrefix?: string;
  /** System + conversation flattened into one submission text. */
  prompt: string;
  stream: boolean;
  /** Top-level request fields present but not honoured by this release. */
  unhonouredFields: string[];
}

export interface ResolvedTurn {
  text: string;
  streamSource: StreamSource;
}

export class MessagesRequestError extends Error {
  readonly code = "invalid_request" as const;
}

type ContentBlock = { type?: string; text?: string };

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

  const notes: string[] = [];
  const parts: string[] = [];

  const systemText = flattenSystem(req.system, notes);
  if (systemText) parts.push(systemText);

  for (const message of req.messages as { role?: unknown; content?: unknown }[]) {
    const role = typeof message?.role === "string" ? message.role : "user";
    const text = flattenContent(message?.content, notes);
    if (text) parts.push(`${roleLabel(role)}: ${text}`);
  }

  const prompt = parts.join("\n\n");
  if (prompt.length === 0) {
    throw new MessagesRequestError("request carries no text content to submit");
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
    unhonouredFields,
  };
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

/** Non-streaming Anthropic Message envelope. */
export function messageEnvelope(opts: {
  requestedModel: string;
  answer: string;
  prompt: string;
}): Record<string, unknown> {
  return {
    id: `msg_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    type: "message",
    role: "assistant",
    model: opts.requestedModel,
    content: [{ type: "text", text: opts.answer }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: estimateTokens(opts.prompt),
      output_tokens: estimateTokens(opts.answer),
    },
  };
}

/**
 * Synthesized SSE stream from a complete, buffered answer. Event order follows
 * the mapping sketch in docs/design/canonical-events-and-errors.md. This is
 * not native streaming and the wire must say so (x-gateway-stream-source).
 */
export function synthesizedEventStream(opts: {
  requestedModel: string;
  answer: string;
  prompt: string;
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
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
  ];
  for (const chunk of chunkText(opts.answer, 200)) {
    frames.push([
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } },
    ]);
  }
  frames.push(
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: estimateTokens(opts.answer) },
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
