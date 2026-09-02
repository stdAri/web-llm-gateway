/**
 * Exercised against frames recorded from a real chat.deepseek.com turn.
 *
 * The previous fixture was synthetic and OpenAI-shaped, so these tests passed
 * against a protocol DeepSeek does not speak: 92 live frames parsed to zero
 * while the suite stayed green. Every assertion here traces to a frame the
 * site actually sent.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDeepSeekAssembler } from "../src/bridge/deepseek-adapter";

const fixture = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "..", "fixtures", "deepseek", "completion-stream.json"),
    "utf8",
  ),
) as {
  prompt: string;
  expected: { text: string; reasoningStartsWith: string };
  frames: unknown[];
};

function assembleAll(frames: unknown[]) {
  const asm = createDeepSeekAssembler();
  for (const f of frames) asm.push(f);
  return { ...asm.result(), done: asm.done };
}

describe("createDeepSeekAssembler over a recorded stream", () => {
  test("recovers the answer the site actually produced", () => {
    const { text } = assembleAll(fixture.frames);
    expect(text).toBe(fixture.expected.text);
  });

  test("keeps reasoning out of the answer", () => {
    const { text, reasoning } = assembleAll(fixture.frames);
    expect(reasoning.startsWith(fixture.expected.reasoningStartsWith)).toBe(true);
    expect(text).not.toContain(fixture.expected.reasoningStartsWith);
  });

  test("reports the stream as finished", () => {
    expect(assembleAll(fixture.frames).done).toBe(true);
  });

  test("is not finished partway through", () => {
    const asm = createDeepSeekAssembler();
    for (const f of fixture.frames.slice(0, 10)) asm.push(f);
    expect(asm.done).toBe(false);
  });
});

describe("createDeepSeekAssembler frame shapes", () => {
  test("a bare v continues the fragment the previous frame established", () => {
    // The whole reason assembly is stateful: these frames carry no type.
    const asm = createDeepSeekAssembler();
    asm.push({ p: "response/fragments", o: "APPEND", v: [{ type: "RESPONSE", content: "你" }] });
    asm.push({ v: "好" });
    asm.push({ v: "世界" });
    expect(asm.result().text).toBe("你好世界");
  });

  test("routes a continuation into reasoning when the open fragment is THINK", () => {
    const asm = createDeepSeekAssembler();
    asm.push({ v: { response: { fragments: [{ type: "THINK", content: "先" }] } } });
    asm.push({ v: "想一下" });
    expect(asm.result()).toEqual({ text: "", reasoning: "先想一下" });
  });

  test("a contentless frame ends the fragment rather than corrupting it", () => {
    // `elapsed_secs` arrives between fragments; without the reset, the next
    // bare `v` would be appended to a fragment that has already closed.
    const asm = createDeepSeekAssembler();
    asm.push({ v: { response: { fragments: [{ type: "THINK", content: "思考" }] } } });
    asm.push({ p: "response/fragments/-1/elapsed_secs", o: "SET", v: 0.807 });
    asm.push({ v: "orphan" });
    expect(asm.result()).toEqual({ text: "", reasoning: "思考" });
  });

  test("switches buckets when a new fragment declares its type", () => {
    const asm = createDeepSeekAssembler();
    asm.push({ v: { response: { fragments: [{ type: "THINK", content: "想" }] } } });
    asm.push({ p: "response/fragments", o: "APPEND", v: [{ type: "RESPONSE", content: "答" }] });
    asm.push({ v: "案" });
    expect(asm.result()).toEqual({ text: "答案", reasoning: "想" });
  });

  test("accepts either completion signal the stream sends", () => {
    const viaBatch = createDeepSeekAssembler();
    viaBatch.push({ p: "response", o: "BATCH", v: [{ p: "quasi_status", v: "FINISHED" }] });
    expect(viaBatch.done).toBe(true);

    const viaStatus = createDeepSeekAssembler();
    viaStatus.push({ p: "response/status", o: "SET", v: "FINISHED" });
    expect(viaStatus.done).toBe(true);
  });

  test("ignores frames that carry no content at all", () => {
    const asm = createDeepSeekAssembler();
    for (const junk of [null, undefined, 42, "raw", { updated_at: 1788354489.6 }, {}]) {
      asm.push(junk);
    }
    expect(asm.result()).toEqual({ text: "", reasoning: "" });
    expect(asm.done).toBe(false);
  });
});

describe("incremental deltas (ticket 04)", () => {
  test("every frame's delta concatenates to the assembled answer", () => {
    const asm = createDeepSeekAssembler();
    let answerStream = "";
    let reasoningStream = "";
    for (const f of fixture.frames) {
      const d = asm.push(f);
      if (d.answer) answerStream += d.answer;
      if (d.reasoning) reasoningStream += d.reasoning;
    }
    const { text, reasoning } = asm.result();
    expect(answerStream).toBe(text);
    expect(reasoningStream).toBe(reasoning);
    expect(answerStream).toBe(fixture.expected.text);
  });

  test("per-frame deltas are attributed to the right bucket", () => {
    const asm = createDeepSeekAssembler();
    const thinkFrame = { v: { response: { fragments: [{ type: "THINK", content: "想" }] } } };
    expect(asm.push(thinkFrame)).toEqual({ reasoning: "想" });
    expect(asm.push({ v: "一下" })).toEqual({ reasoning: "一下" });
    const responseFrame = { p: "response/fragments", o: "APPEND", v: [{ type: "RESPONSE", content: "答" }] };
    expect(asm.push(responseFrame)).toEqual({ answer: "答" });
    expect(asm.push({ v: "案" })).toEqual({ answer: "案" });
  });

  test("contentless and truncated frames yield no delta and corrupt nothing", () => {
    const asm = createDeepSeekAssembler();
    asm.push({ v: { response: { fragments: [{ type: "RESPONSE", content: "你" }] } } });
    expect(asm.push({ p: "response/fragments/-1/elapsed_secs", o: "SET", v: 0.8 })).toEqual({});
    expect(asm.push(null)).toEqual({});
    expect(asm.push({})).toEqual({});
    expect(asm.push({ v: "好" })).toEqual({});
    expect(asm.result()).toEqual({ text: "你", reasoning: "" });
  });
});

// Ticket 03: tool envelopes are extracted from surrounding prose, never
// whole-message matched (the experiment showed prose on every DeepSeek turn).
import { extractToolEnvelopes } from "../src/bridge/deepseek-adapter";

describe("extractToolEnvelopes", () => {
  test("extracts one envelope out of surrounding prose", () => {
    const out = extractToolEnvelopes(
      '我先看一下目录。\n<tool_call nonce="7f3a9c2e" id="call_1" name="list_files">\n{"path": "."}\n</tool_call>',
    );
    expect(out.calls).toEqual([
      { nonce: "7f3a9c2e", id: "call_1", name: "list_files", arguments: { path: "." } },
    ]);
    expect(out.text).toBe("我先看一下目录。");
    expect(out.envelopeError).toBeUndefined();
  });

  test("extracts several back-to-back envelopes", () => {
    const out = extractToolEnvelopes(
      '<tool_call nonce="n" id="call_1" name="read_file">\n{"path":"a"}\n</tool_call>\n' +
        '<tool_call nonce="n" id="call_2" name="read_file">\n{"path":"b"}\n</tool_call>',
    );
    expect(out.calls.length).toBe(2);
    expect(out.calls[1]!.id).toBe("call_2");
    expect(out.text).toBe("");
  });

  test("passes plain answers through untouched", () => {
    const out = extractToolEnvelopes("react is ^18.3.1");
    expect(out.calls).toEqual([]);
    expect(out.text).toBe("react is ^18.3.1");
  });

  test("malformed JSON discards the batch and reports the error", () => {
    const out = extractToolEnvelopes('<tool_call nonce="n" id="c" name="t">\n{bad json\n</tool_call>');
    expect(out.calls).toEqual([]);
    expect(out.envelopeError).toContain("malformed JSON");
  });

  test("an unclosed tag discards the batch and reports the error", () => {
    const out = extractToolEnvelopes('text\n<tool_call nonce="n" id="c" name="t">\n{"a":1}');
    expect(out.calls).toEqual([]);
    expect(out.envelopeError).toContain("unclosed");
  });
});
