/**
 * Ticket 04: real incremental streaming with declared provenance.
 *
 * A scripted Bridge emits `turn.delta` events the way the userscript does when
 * the page interceptor relays frames mid-flight; the daemon must turn them
 * into a correctly ordered Anthropic SSE stream, keep reasoning in a thinking
 * block, and only claim `network` provenance when a delta really arrived.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { BridgeHub } from "../src/daemon/bridge-hub";
import { GatewayHTTPServer } from "../src/daemon/http-server";
import { BRIDGE_PROTOCOL_VERSION, type BridgeMessage } from "../src/shared/bridge-protocol";
import type { ProviderRegistration } from "../src/shared/canonical";

const PAIRING_TOKEN = "bp_testtoken123";
const GATEWAY_KEY = "gw_testkey123";
const DEEPSEEK_PROVIDER = "deepseek";

function registration(): ProviderRegistration {
  return {
    provider: DEEPSEEK_PROVIDER,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    models: [
      { id: "快速模式", displayName: "快速模式", effort: ["深度思考"] },
      { id: "专家模式", displayName: "专家模式", effort: ["深度思考"] },
    ],
    modelSwitching: "at-conversation-start" as const,
    catalogObservedAt: Date.now(),
    selectedModel: "快速模式",
    capabilities: {
      streaming: true,
      streamSource: "network",
      reasoning: true,
      tools: "prompt-emulated",
      images: false,
      files: true,
      citations: false,
      webSearch: false,
      effort: [],
    },
  };
}

type TurnRequest = Extract<BridgeMessage, { type: "turn.request" }>;

interface ScriptStep {
  delta?: { kind: "text" | "reasoning"; text: string };
  /** Milliseconds to wait before performing this step's send. */
  waitMs?: number;
}

/**
 * A fake Bridge that streams scripted deltas (in order, with optional delays)
 * and then resolves the turn with the given final result.
 */
function connectStreamingBridge(
  wsUrl: string,
  script: (req: TurnRequest) => {
    steps: ScriptStep[];
    result: { text: string; reasoning?: string; error?: { code: string; message: string } };
  },
) {
  const ws = new WebSocket(wsUrl);
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.type !== "turn.request") return;
    const { steps, result } = script(msg as TurnRequest);
    for (const step of steps) {
      if (step.waitMs) await new Promise((r) => setTimeout(r, step.waitMs));
      if (step.delta) {
        ws.send(JSON.stringify({
          type: "turn.delta",
          turnId: msg.turnId,
          provider: DEEPSEEK_PROVIDER,
          delta: step.delta,
        }));
      }
    }
    ws.send(JSON.stringify({
      type: "turn.result",
      turnId: msg.turnId,
      provider: DEEPSEEK_PROVIDER,
      text: result.text,
      reasoning: result.reasoning,
      streamSource: "network",
      error: result.error,
      conversationRef: `https://chat.deepseek.com/a/chat/s/conv-for-${msg.turnId}`,
    }));
  };
  return new Promise<WebSocket>((resolve, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "bridge.hello", pairingToken: PAIRING_TOKEN, registration: registration() }));
      ws.send(JSON.stringify({ type: "tab.registered", tabId: "tab_1", provider: DEEPSEEK_PROVIDER, url: "https://chat.deepseek.com/" }));
      resolve(ws);
    };
    ws.onerror = () => reject(new Error("ws error"));
  });
}

const servers: GatewayHTTPServer[] = [];
const sockets: WebSocket[] = [];

async function startServer(): Promise<number> {
  const hub = new BridgeHub(PAIRING_TOKEN);
  const server = new GatewayHTTPServer({ hub, port: 0, turnTimeoutMs: 5000, gatewayApiKey: GATEWAY_KEY });
  servers.push(server);
  await server.start();
  return server.port!;
}

afterEach(() => {
  while (servers.length > 0) servers.pop()!.stop();
  while (sockets.length > 0) sockets.pop()!.close();
});

function postStream(port: number, body: Record<string, unknown> = {}) {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${GATEWAY_KEY}` },
    body: JSON.stringify({
      model: "deepseek/快速模式",
      stream: true,
      messages: [{ role: "user", content: "say hi" }],
      ...body,
    }),
  });
}

/** Parse an SSE body into [event, data] pairs, in arrival order. */
async function readSse(res: Response): Promise<[string, { type?: string } & Record<string, unknown>][]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      const event = chunk.match(/^event: (.+)$/m)![1]!;
      const data = JSON.parse(chunk.match(/^data: (.+)$/m)![1]!);
      return [event, data];
    });
}

describe("real incremental streaming", () => {
  test("deltas become an Anthropic SSE stream in canonical order, reasoning separate", async () => {
    const port = await startServer();
    sockets.push(await connectStreamingBridge(`ws://127.0.0.1:${port}/bridge`, () => ({
      steps: [
        { delta: { kind: "reasoning", text: "用户想" } },
        { delta: { kind: "reasoning", text: "打招呼" } },
        { delta: { kind: "text", text: "你" } },
        { delta: { kind: "text", text: "好" } },
      ],
      result: { text: "你好", reasoning: "用户想打招呼" },
    })));

    const res = await postStream(port);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-stream-source")).toBe("network");
    expect(res.headers.get("x-gateway-usage")).toBe("estimated");

    const events = await readSse(res);
    expect(events.map(([e]) => e)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    // Reasoning lives in a thinking block, answer in a text block.
    expect(events[1]![1].content_block).toEqual({ type: "thinking", thinking: "" });
    expect(events[2]![1].delta).toEqual({ type: "thinking_delta", thinking: "用户想" });
    expect(events[3]![1].delta).toEqual({ type: "thinking_delta", thinking: "打招呼" });
    expect(events[5]![1].content_block).toEqual({ type: "text", text: "" });
    expect(events[6]![1].delta).toEqual({ type: "text_delta", text: "你" });
    expect(events[7]![1].delta).toEqual({ type: "text_delta", text: "好" });
    expect(events[9]![1].delta).toEqual({ stop_reason: "end_turn", stop_sequence: null });
  });

  test("the first bytes reach the client before the turn completes", async () => {
    const port = await startServer();
    sockets.push(await connectStreamingBridge(`ws://127.0.0.1:${port}/bridge`, () => ({
      steps: [
        { delta: { kind: "text", text: "early" } },
        { waitMs: 400, delta: { kind: "text", text: "late" } },
      ],
      result: { text: "earlylate" },
    })));

    const startedAt = Date.now();
    const res = await postStream(port);
    const reader = res.body!.getReader();
    const first = await reader.read(); // arrives with the first delta
    const firstByteMs = Date.now() - startedAt;
    expect(new TextDecoder().decode(first.value)).toContain("message_start");
    expect(firstByteMs).toBeLessThan(400);
    reader.cancel();
  });

  test("a turn whose Bridge never streams falls back to buffered, and says so", async () => {
    const port = await startServer();
    sockets.push(await connectStreamingBridge(`ws://127.0.0.1:${port}/bridge`, () => ({
      steps: [],
      result: { text: "whole answer", reasoning: "some thinking" },
    })));

    const res = await postStream(port);
    expect(res.headers.get("x-gateway-stream-source")).toBe("buffered");
    const events = await readSse(res);
    const deltas = events.filter(([e]) => e === "content_block_delta").map(([, d]) => d.delta as { type: string });
    expect(deltas.some((d) => d.type === "thinking_delta")).toBe(true);
    expect(deltas.some((d) => d.type === "text_delta")).toBe(true);
    expect(events.map(([e]) => e).at(-1)).toBe("message_stop");
  });

  test("a turn that fails mid-stream reports an SSE error event", async () => {
    const port = await startServer();
    sockets.push(await connectStreamingBridge(`ws://127.0.0.1:${port}/bridge`, () => ({
      steps: [{ delta: { kind: "text", text: "partial" } }],
      result: { text: "", error: { code: "no_stream_captured", message: "stream died" } },
    })));

    const res = await postStream(port);
    expect(res.headers.get("x-gateway-stream-source")).toBe("network");
    const events = await readSse(res);
    expect(events.map(([e]) => e).at(-1)).toBe("error");
    expect(events.at(-1)![1].error).toMatchObject({ message: "stream died" });
  });

  test("a turn that fails before any delta is a plain error envelope", async () => {
    const port = await startServer();
    sockets.push(await connectStreamingBridge(`ws://127.0.0.1:${port}/bridge`, () => ({
      steps: [],
      result: { text: "", error: { code: "composer_not_found", message: "no composer element matched on the page" } },
    })));

    const res = await postStream(port);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.type).toBe("error");
  });

  test("the non-streaming envelope carries reasoning as its own thinking block", async () => {
    const port = await startServer();
    sockets.push(await connectStreamingBridge(`ws://127.0.0.1:${port}/bridge`, () => ({
      steps: [],
      result: { text: "the answer", reasoning: "the thinking" },
    })));

    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${GATEWAY_KEY}` },
      body: JSON.stringify({
        model: "deepseek/快速模式",
        messages: [{ role: "user", content: "say hi" }],
      }),
    });
    expect(res.headers.get("x-gateway-usage")).toBe("estimated");
    const body = await res.json();
    expect(body.content).toEqual([
      { type: "thinking", thinking: "the thinking" },
      { type: "text", text: "the answer" },
    ]);
  });
});
