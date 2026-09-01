/**
 * DeepSeek Web Provider Adapter.
 *
 * Authored in the repository as ordinary modules, unit-tested in CI against
 * recorded redacted frames, and bundled into the Bridge artifact at build
 * time (ADR-0007). The parser is a pure function over captured network
 * frames; the page-interaction half is the Bridge Driver implementation.
 *
 * Site facts (docs/research/doubao-deepseek-behavior.md, re-verified before
 * shipping): chat.deepseek.com streams over a completion-suffixed endpoint
 * (streamSource "network"), the composer is a textarea that needs React-aware
 * value setting, and class names are build-hashed so selector logic drifts.
 */

export const DEEPSEEK = {
  provider: "deepseek",
  chatHost: "chat.deepseek.com",
  /**
   * The completion-suffixed streaming endpoint. Matched by URL suffix rather
   * than full path because DeepSeek's exact path has drifted across releases.
   */
  completionSuffix: "/chat/completion",
} as const;

export type DeepSeekFrameType = "reasoning" | "answer" | "done" | "error";

export interface DeepSeekParsedFrame {
  type: DeepSeekFrameType;
  text?: string;
  done?: boolean;
  error?: string;
}

/**
 * Parse a single SSE data payload from DeepSeek's completion stream.
 * Pure over the recorded frame so parser tests run in CI without credentials.
 */
export function parseDeepSeekFrame(payload: unknown): DeepSeekParsedFrame | null {
  if (payload === null || typeof payload !== "object") return null;
  const raw = payload as Record<string, unknown>;

  // Reasoning content comes through a thinking channel; it may sit at the
  // top level or inside the delta.
  const reasoning = pickText(raw, "reasoning_content");
  if (reasoning !== null) {
    return { type: "reasoning", text: reasoning };
  }

  // Delta content in the choices array
  const choices = raw.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    const delta = first.delta;
    if (delta && typeof delta === "object") {
      const reasoningInDelta = pickText(delta as Record<string, unknown>, "reasoning_content");
      if (reasoningInDelta !== null) {
        return { type: "reasoning", text: reasoningInDelta };
      }
      const content = pickText(delta as Record<string, unknown>, "content");
      if (content !== null) {
        return { type: "answer", text: content };
      }
    }
    const finish = first.finish_reason;
    if (typeof finish === "string" && finish !== "") {
      return { type: "done", done: true };
    }
    if (first.error) {
      return { type: "error", error: String(first.error) };
    }
  }

  // Direct error field
  if (typeof raw.error === "string") {
    return { type: "error", error: raw.error };
  }

  return null;
}

function pickText(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

/**
 * Assemble a final answer from an ordered list of parsed frames.
 * Concatenates answer deltas; reasoning is tracked separately so reasoning
 * content never leaks into the answer presented to the caller.
 */
export function assembleDeepSeekAnswer(frames: DeepSeekParsedFrame[]): {
  text: string;
  reasoning: string;
} {
  let text = "";
  let reasoning = "";
  for (const f of frames) {
    if (f.type === "answer" && f.text) text += f.text;
    if (f.type === "reasoning" && f.text) reasoning += f.text;
  }
  return { text, reasoning };
}
