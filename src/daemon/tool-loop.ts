/**
 * The daemon side of the prompt-emulated tool loop (ticket 03, ADR-0012).
 *
 * Tool definitions arrive from the Agent Client (Claude Code) and are encoded
 * into the envelope format validated by docs/research/tool-envelope-experiment.md:
 *
 *   <tool_call nonce="NONCE" id="CALL_ID" name="TOOL_NAME">
 *   {"argument": "value"}
 *   </tool_call>
 *
 * The Bridge extracts envelopes from the model's prose; this module owns every
 * decision that must not trust the page (ADR-0007): the tool allowlist, the
 * argument schema, the per-turn nonce, and the pairing of results to calls.
 * Model-supplied call ids are rewritten to daemon-issued `toolu_…` ids because
 * fresh conversations were observed to reuse `call_1` (experiment T8), and the
 * daemon's id matching is the only correctness guarantee in the loop (T9).
 *
 * Conversation state is in-memory; durability and restart recovery are
 * ticket 09.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { ParsedToolCall } from "../shared/bridge-protocol";

export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ValidatedCall {
  /** Daemon-issued id handed to the Agent Client (`toolu_…`). */
  id: string;
  name: string;
  input: unknown;
  /** The model's own envelope id, needed to pair the result fed back into the
   * web conversation. Meaningless outside this conversation. */
  modelCallId: string;
}

interface Conversation {
  id: string;
  provider: string;
  tools: ToolSpec[];
  /** The nonce the next envelope must carry. Rotated on every continuation. */
  nonce: string;
  /** toolu id -> model call id, for results currently outstanding. */
  pendingCalls: Map<string, string>;
  /** A nudge was already sent for the current round; a second malformed reply
   * fails the turn instead of looping forever. */
  nudgePending: boolean;
}

export type Assessment =
  | { kind: "final"; text: string }
  | { kind: "calls"; prose: string; calls: ValidatedCall[] }
  | { kind: "nudge"; reason: string; prompt: string };

/** Thrown for forgery-shaped failures (bad or missing nonce) — no nudge. */
export class ToolProtocolError extends Error {
  readonly code = "tool_protocol_error" as const;
}

const MAX_TOOL_NAME = 128;

export class ToolLoop {
  private conversations = new Map<string, Conversation>();
  /** toolu id -> conversation id, across all live conversations. */
  private callIndex = new Map<string, string>();

  /** Begin a new tool conversation: fresh id and first nonce. */
  begin(provider: string, tools: ToolSpec[]): Conversation {
    const conv: Conversation = {
      id: `conv_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      provider,
      tools,
      nonce: newNonce(),
      pendingCalls: new Map(),
      nudgePending: false,
    };
    this.conversations.set(conv.id, conv);
    return conv;
  }

  conversationIdFor(toolUseId: string): string | undefined {
    return this.callIndex.get(toolUseId);
  }

  conversation(id: string): Conversation | undefined {
    return this.conversations.get(id);
  }

  /** The setup block prepended to the first submission of a task, in the
   * shape the experiment proved DeepSeek follows. */
  buildSetupPrompt(conv: Conversation, taskText: string): string {
    const toolList = conv.tools
      .map((t, i) => {
        const schema = t.inputSchema ? JSON.stringify(t.inputSchema) : "{}";
        return `${i + 1}. ${t.name} — ${t.description ?? "(no description)"}\n   ${schema}`;
      })
      .join("\n\n");
    const example = conv.tools[0]?.name ?? "tool";
    return (
      `You have access to tools. When you need one, emit a tool call and stop.\n\n` +
      `Available tools:\n\n${toolList}\n\n` +
      `To call a tool, emit exactly this and nothing else:\n\n` +
      `<tool_call nonce="${conv.nonce}" id="call_1" name="${example}">\n` +
      `{"argument": "value"}\n</tool_call>\n\n` +
      `Rules:\n` +
      `- Emit the envelope alone. No text before it, no text after it, no markdown code fences.\n` +
      `- Copy the nonce ${conv.nonce} exactly on every call.\n` +
      `- Give every call a unique id.\n` +
      `- Only use the tools above. Never invent a tool.\n` +
      `- To call several tools at once, emit several envelopes back to back.\n` +
      `- When you have enough information, answer normally with no envelope.\n\n` +
      `I will reply with the tool's output. Then continue.\n\n` +
      taskText
    );
  }

  /** The continuation message carrying tool results back into the same web
   * conversation. Rotates the nonce and says so, so a nonce captured from an
   * earlier round cannot be replayed. */
  buildResultMessage(conv: Conversation, results: { toolUseId: string; content: string }[]): string {
    const blocks = results.map((r) => {
      const modelCallId = conv.pendingCalls.get(r.toolUseId);
      if (!modelCallId) {
        throw new ToolProtocolError(`tool_result for unknown tool_use id "${r.toolUseId}"`);
      }
      return `<tool_result id="${modelCallId}">\n${r.content}\n</tool_result>`;
    });
    for (const r of results) {
      conv.pendingCalls.delete(r.toolUseId);
      this.callIndex.delete(r.toolUseId);
    }
    conv.nonce = newNonce();
    conv.nudgePending = false;
    return (
      blocks.join("\n\n") +
      `\n\nIf you need another tool, emit its envelope exactly as before, ` +
      `with nonce="${conv.nonce}". Otherwise give the final answer.`
    );
  }

  /**
   * Decide what a finished web turn means. Validation order matters: the nonce
   * is checked first, because a call that fails it is page-side forgery and
   * must fail the turn rather than earn a corrective nudge.
   */
  assess(
    conv: Conversation,
    outcome: { text: string; toolCalls?: ParsedToolCall[]; envelopeError?: string },
  ): Assessment {
    // Safety net: the Bridge strips envelopes it parsed; one left in the text
    // carrying the current nonce, with no extraction error reported, means its
    // parser drifted. (A reported envelopeError keeps the raw text by design.)
    if (
      !outcome.envelopeError &&
      outcome.text.includes("<tool_call") &&
      outcome.text.includes(conv.nonce)
    ) {
      throw new ToolProtocolError(
        "a tool envelope with the current nonce survived Bridge-side extraction",
      );
    }

    const calls = outcome.toolCalls ?? [];
    if (calls.length > 0) {
      for (const call of calls) {
        if (call.nonce !== conv.nonce) {
          throw new ToolProtocolError(
            `tool call rejected: nonce mismatch (expected per-turn nonce, got ${JSON.stringify(call.nonce ?? null)})`,
          );
        }
      }
      // Validate every call before registering any: a rejected batch must not
      // leak half-registered ids the client never sees.
      const mistakes: string[] = [];
      for (const call of calls) {
        const problem = this.validateCall(conv, call);
        if (problem) mistakes.push(problem);
      }
      if (mistakes.length > 0) {
        return this.nudge(conv, mistakes.join(" "));
      }
      const validated: ValidatedCall[] = calls.map((call, i) => {
        const id = `toolu_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
        const modelCallId = call.id ?? `call_${i + 1}`;
        conv.pendingCalls.set(id, modelCallId);
        this.callIndex.set(id, conv.id);
        return { id, name: call.name!, input: call.arguments ?? {}, modelCallId };
      });
      conv.nudgePending = false;
      return { kind: "calls", prose: outcome.text.trim(), calls: validated };
    }

    if (outcome.envelopeError) {
      return this.nudge(
        conv,
        `Your last reply contained a <tool_call that could not be parsed (${outcome.envelopeError}). ` +
          `Emit the envelope exactly as specified, or answer normally with no envelope.`,
      );
    }

    if (outcome.text.trim().length === 0) {
      return this.nudge(
        conv,
        "Your reply was empty. Either emit a tool call envelope exactly as specified, or give the final answer.",
      );
    }

    conv.nudgePending = false;
    return { kind: "final", text: outcome.text };
  }

  /** A malformed round gets one corrective nudge; a second one fails. */
  private nudge(conv: Conversation, reason: string): Assessment {
    if (conv.nudgePending) {
      throw new ToolProtocolError(`tool turn failed after one nudge: ${reason}`);
    }
    conv.nudgePending = true;
    conv.nonce = newNonce();
    return {
      kind: "nudge",
      reason,
      prompt:
        `${reason}\n\nReply with either a valid envelope ` +
        `<tool_call nonce="${conv.nonce}" id="..." name="...">{...}</tool_call> ` +
        `or a final answer with no envelope.`,
    };
  }

  /** Allowlist + schema validation. Returns a model-facing problem string. */
  private validateCall(conv: Conversation, call: ParsedToolCall): string | null {
    if (!call.name || typeof call.name !== "string") {
      return "The envelope is missing a tool name.";
    }
    const tool = conv.tools.find((t) => t.name === call.name);
    if (!tool) {
      const offered = conv.tools.map((t) => t.name).join(", ");
      return `There is no tool named "${call.name.slice(0, MAX_TOOL_NAME)}". Use only: ${offered}.`;
    }
    if (tool.inputSchema) {
      return validateAgainstSchema(call.arguments, tool.inputSchema, "arguments");
    }
    return null;
  }
}

function newNonce(): string {
  return randomBytes(4).toString("hex");
}

/**
 * The JSON-Schema subset Claude Code's tool definitions actually use: type,
 * properties, required, items, enum, and additionalProperties:false. Returns
 * the first problem found, or null when the value validates.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): string | null {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${path} must be one of ${JSON.stringify(schema.enum)}.`;
  }
  switch (schema.type) {
    case "string":
      return typeof value === "string" ? null : `${path} must be a string.`;
    case "number":
      return typeof value === "number" ? null : `${path} must be a number.`;
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
        ? null
        : `${path} must be an integer.`;
    case "boolean":
      return typeof value === "boolean" ? null : `${path} must be a boolean.`;
    case "array": {
      if (!Array.isArray(value)) return `${path} must be an array.`;
      const items = schema.items as Record<string, unknown> | undefined;
      if (items) {
        for (let i = 0; i < value.length; i++) {
          const err = validateAgainstSchema(value[i], items, `${path}[${i}]`);
          if (err) return err;
        }
      }
      return null;
    }
    case "object":
    case undefined: {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `${path} must be an object.`;
      }
      const obj = value as Record<string, unknown>;
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      for (const key of (schema.required as string[] | undefined) ?? []) {
        if (!(key in obj)) return `${path}.${key} is required.`;
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!(key in props)) return `${path}.${key} is not an allowed property.`;
        }
      }
      for (const [key, sub] of Object.entries(props)) {
        if (key in obj) {
          const err = validateAgainstSchema(obj[key], sub, `${path}.${key}`);
          if (err) return err;
        }
      }
      return null;
    }
    default:
      return null;
  }
}
