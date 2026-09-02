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
  /** The composer. A real textarea, so React-aware value setting applies. */
  composerSelector: "textarea",
  /**
   * The send control. DeepSeek renders it as an icon-only `div[role=button]`
   * with no aria-label and no text, so label matching finds nothing; the
   * semantic classes are what identify it. Verified against the live page:
   * exactly one element matches, and it carries `ds-button--disabled` while the
   * composer is empty, dropping that class once the composer has content.
   */
  sendButtonSelector: 'div[role="button"].ds-button--primary.ds-button--filled',
  /** Present on the send control while it refuses to submit. */
  disabledClass: "ds-button--disabled",
} as const;

/**
 * DeepSeek streams a stateful patch protocol rather than OpenAI-style deltas.
 * Three frame shapes carry content:
 *
 *   {v: {response: {fragments: [{type: "THINK", content: "..."}]}}}  snapshot
 *   {p: "response/fragments", o: "APPEND", v: [{type: "RESPONSE", ...}]}  new fragment
 *   {v: "用户的"}                                                     continuation
 *
 * The third shape is why a per-frame parser cannot work: a bare `v` says
 * nothing about whether it belongs to the reasoning or the answer. Only the
 * fragment type established by an earlier frame decides that, so assembly has
 * to carry state across the stream.
 */
export type DeepSeekBucket = "answer" | "reasoning" | "none";

export interface DeepSeekAssembler {
  /** Feed one decoded SSE payload, in arrival order. */
  push(payload: unknown): void;
  /** True once the stream has declared the response finished. */
  readonly done: boolean;
  result(): { text: string; reasoning: string };
}

export function createDeepSeekAssembler(): DeepSeekAssembler {
  let text = "";
  let reasoning = "";
  let bucket: DeepSeekBucket = "none";
  let done = false;

  return {
    push(payload: unknown) {
      if (payload === null || typeof payload !== "object") return;
      const frame = payload as Record<string, unknown>;
      if (isFinished(frame)) done = true;

      const block = contentBlock(frame);
      const type = typeof block.type === "string" ? block.type : undefined;
      if (type) bucket = type === "RESPONSE" ? "answer" : type === "THINK" ? "reasoning" : "none";

      const content = typeof block.content === "string" ? block.content : "";
      if (!content) {
        // Frames like `{p: ".../elapsed_secs", o: "SET", v: 0.8}` carry no text.
        // Clearing the bucket keeps them from letting a later bare `v` attach
        // itself to a fragment that has already ended.
        bucket = "none";
        return;
      }
      if (bucket === "answer") text += content;
      else if (bucket === "reasoning") reasoning += content;
    },
    get done() {
      return done;
    },
    result() {
      return { text, reasoning };
    },
  };
}

/** The content-bearing block of a frame, whichever shape it arrived in. */
function contentBlock(frame: Record<string, unknown>): Record<string, unknown> {
  const v = frame.v;
  if (v && typeof v === "object" && !Array.isArray(v) && "response" in v) {
    const fragments = (v as { response?: { fragments?: unknown } }).response?.fragments;
    if (Array.isArray(fragments) && fragments[0] && typeof fragments[0] === "object") {
      return fragments[0] as Record<string, unknown>;
    }
    return {};
  }
  if (Array.isArray(v)) {
    return v[0] && typeof v[0] === "object" ? (v[0] as Record<string, unknown>) : {};
  }
  if (typeof v === "string") return { content: v };
  return {};
}

/**
 * Completion is announced twice — inside a BATCH as `quasi_status` and then as
 * a plain status SET. Either is accepted so a turn ends as soon as the stream
 * says so, rather than waiting out the Bridge's deadline.
 */
function isFinished(frame: Record<string, unknown>): boolean {
  if (frame.p === "response/status" && frame.v === "FINISHED") return true;
  if (frame.o === "BATCH" && Array.isArray(frame.v)) {
    return frame.v.some(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        (entry as { p?: unknown; v?: unknown }).p === "quasi_status" &&
        (entry as { v?: unknown }).v === "FINISHED",
    );
  }
  return false;
}
