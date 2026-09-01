import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assembleDeepSeekAnswer,
  parseDeepSeekFrame,
} from "../src/bridge/deepseek-adapter";

const fixturePath = resolve(import.meta.dirname, "..", "fixtures", "deepseek", "completion-stream.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  frames: { label: string; payload: unknown }[];
};

describe("parseDeepSeekFrame", () => {
  test("classifies reasoning frames", () => {
    const f = fixture.frames.find((x) => x.label === "reasoning-delta")!;
    expect(parseDeepSeekFrame(f.payload)).toEqual({
      type: "reasoning",
      text: "用户希望我回答一个简单问题。让我先想一下……",
    });
  });

  test("classifies reasoning inside delta", () => {
    const f = fixture.frames.find((x) => x.label === "reasoning-inside-delta")!;
    expect(parseDeepSeekFrame(f.payload)).toEqual({
      type: "reasoning",
      text: "思考过程在 delta 内。",
    });
  });

  test("classifies answer deltas", () => {
    const f = fixture.frames.find((x) => x.label === "answer-delta-1")!;
    expect(parseDeepSeekFrame(f.payload)).toEqual({
      type: "answer",
      text: "你好，世界。",
    });
  });

  test("classifies finish reason", () => {
    const f = fixture.frames.find((x) => x.label === "finish-reason")!;
    expect(parseDeepSeekFrame(f.payload)).toEqual({
      type: "done",
      done: true,
    });
  });

  test("returns null for non-object / unrelated payloads", () => {
    expect(parseDeepSeekFrame(null)).toBeNull();
    expect(parseDeepSeekFrame("hello")).toBeNull();
    expect(parseDeepSeekFrame({ foo: 1 })).toBeNull();
  });
});

describe("assembleDeepSeekAnswer", () => {
  test("concatenates answer deltas and keeps reasoning separate", () => {
    const frames = fixture.frames
      .map((f) => parseDeepSeekFrame(f.payload))
      .filter((f): f is NonNullable<typeof f> => f !== null);
    const { text, reasoning } = assembleDeepSeekAnswer(frames);
    expect(text).toBe("你好，世界。这是一个测试回答。");
    expect(reasoning).toContain("用户希望我回答一个简单问题");
    expect(reasoning).toContain("思考过程在 delta 内。");
  });
});
