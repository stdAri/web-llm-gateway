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
