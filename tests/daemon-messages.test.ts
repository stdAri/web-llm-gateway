import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeHub } from "../src/daemon/bridge-hub";
import { GatewayHTTPServer } from "../src/daemon/http-server";
import { GatewayStore } from "../src/daemon/store";
import { BRIDGE_PROTOCOL_VERSION } from "../src/shared/bridge-protocol";
import type { ProviderRegistration } from "../src/shared/canonical";

const PAIRING_TOKEN = "bp_testtoken123";
const GATEWAY_KEY = "gw_testkey123";
const DEEPSEEK_PROVIDER = "deepseek";

function registration(provider = DEEPSEEK_PROVIDER): ProviderRegistration {
  return {
    provider,
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

interface FakeBridge {
  ws: WebSocket;
  received: unknown[];
}

/** Connect a fake Bridge that registers one tab and answers every turn. */
function connectFakeBridge(
  wsUrl: string,
  provider: string,
  answer: string,
): Promise<FakeBridge> {
  const ws = new WebSocket(wsUrl);
  const received: unknown[] = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    received.push(msg);
    if (msg.type === "turn.request") {
      ws.send(JSON.stringify({
        type: "turn.result",
        turnId: msg.turnId,
        provider,
        text: answer,
        streamSource: "network",
      }));
    }
  };
  return new Promise((resolve, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "bridge.hello", pairingToken: PAIRING_TOKEN, registration: registration(provider) }));
      ws.send(JSON.stringify({ type: "tab.registered", tabId: "tab_1", provider, url: "https://chat.deepseek.com/" }));
      resolve({ ws, received });
    };
    ws.onerror = () => reject(new Error("ws error"));
  });
}

const servers: GatewayHTTPServer[] = [];

async function startServer(): Promise<{ hub: BridgeHub; port: number }> {
  const hub = new BridgeHub(PAIRING_TOKEN);
  const server = new GatewayHTTPServer({ hub, port: 0, turnTimeoutMs: 5000, gatewayApiKey: GATEWAY_KEY });
  servers.push(server);
  await server.start();
  return { hub, port: server.port! };
}

afterEach(() => {
  while (servers.length > 0) servers.pop()!.stop();
});

/** The body and headers Claude Code 2.x actually sends to /v1/messages. */
function claudeCodeRequest(overrides: Record<string, unknown> = {}) {
  return {
    model: "deepseek/快速模式",
    max_tokens: 32000,
    stream: false,
    system: [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "You are an interactive agent that helps with software engineering." },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "Reply with exactly: pong", cache_control: { type: "ephemeral" } }] },
    ],
    tools: [{ name: "Bash", description: "Executes a bash command", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
    tool_choice: { type: "auto" },
    thinking: { type: "enabled", budget_tokens: 1024 },
    metadata: { user_id: "user_123" },
    ...overrides,
  };
}

function postMessages(port: number, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${GATEWAY_KEY}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "interleaved-thinking-2025-05-14",
      "x-app": "cli",
      "user-agent": "claude-cli/2.1.257 (external, cli)",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("Gateway API Key authentication", () => {
  test("requests without a key are rejected with an Anthropic auth error", async () => {
    const { port } = await startServer();
    const res = await postMessages(port, claudeCodeRequest(), { authorization: "" });
    expect(res.status).toBe(401);
    const body = await res.json() as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("authentication_error");
  });

  test("the Bridge Pairing Token is not accepted as a Gateway API Key", async () => {
    const { port } = await startServer();
    const res = await postMessages(port, claudeCodeRequest(), { authorization: `Bearer ${PAIRING_TOKEN}` });
    expect(res.status).toBe(401);
  });

  test("the Gateway API Key is not accepted as a Bridge Pairing Token", async () => {
    const { port } = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
    const close = new Promise<number>((resolve) => {
      ws.onclose = (ev) => resolve(ev.code);
    });
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "bridge.hello", pairingToken: GATEWAY_KEY, registration: registration() }));
    };
    expect(await close).toBe(4401);
  });

  test("the key is also accepted via x-api-key", async () => {
    const { port } = await startServer();
    const bridge = await connectFakeBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, "pong");
    const res = await postMessages(port, claudeCodeRequest(), { authorization: "", "x-api-key": GATEWAY_KEY });
    expect(res.status).toBe(200);
    bridge.ws.close();
  });
});

describe("POST /v1/messages — what Claude Code sends", () => {
  test("accepts system blocks, version/beta headers and query params; returns a valid Message envelope", async () => {
    const { port } = await startServer();
    const bridge = await connectFakeBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, "pong");

    const res = await postMessages(port, claudeCodeRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as {
      type: string; role: string; model: string;
      content: { type: string; text: string }[];
      stop_reason: string; usage: { input_tokens: number; output_tokens: number };
    };
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.model).toBe("deepseek/快速模式");
    expect(body.content).toEqual([{ type: "text", text: "pong" }]);
    expect(body.stop_reason).toBe("end_turn");
    expect(body.usage.input_tokens).toBeGreaterThan(0);
    expect(body.usage.output_tokens).toBeGreaterThan(0);

    // The Bridge received system content and the user turn as one submission.
    const turnReq = bridge.received.find((m) => (m as { type?: string }).type === "turn.request") as { prompt: string };
    expect(turnReq.prompt).toContain("You are Claude Code");
    expect(turnReq.prompt).toContain("Human: Reply with exactly: pong");
    bridge.ws.close();
  });

  test("fields the release cannot honour are reported on the response", async () => {
    const { port } = await startServer();
    const bridge = await connectFakeBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, "pong");
    const res = await postMessages(port, claudeCodeRequest());
    const unhonoured = res.headers.get("x-gateway-unhonoured-fields") ?? "";
    for (const field of ["max_tokens", "metadata", "thinking"]) {
      expect(unhonoured).toContain(field);
    }
    // tools and tool_choice are honoured since ticket 03 — they must no
    // longer appear in this report.
    const listed = unhonoured.split(",");
    expect(listed).not.toContain("tools");
    expect(listed).not.toContain("tool_choice");
    bridge.ws.close();
  });

  test("non-text content blocks are dropped but reported", async () => {
    const { port } = await startServer();
    const bridge = await connectFakeBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, "pong");
    const res = await postMessages(port, claudeCodeRequest({
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } },
        { type: "text", text: "describe this" },
      ] }],
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-unhonoured-fields")).toContain("non-text message blocks");
    const turnReq = bridge.received.find((m) => (m as { type?: string }).type === "turn.request") as { prompt: string };
    expect(turnReq.prompt).toContain("Human: describe this");
    bridge.ws.close();
  });
});

describe("POST /v1/messages — synthesized streaming", () => {
  test("stream:true returns a well-formed SSE event sequence with buffered provenance", async () => {
    const { port } = await startServer();
    const answer = "答：".repeat(120); // multi-chunk answer
    const bridge = await connectFakeBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, answer);

    const res = await postMessages(port, claudeCodeRequest({ stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-gateway-stream-source")).toBe("buffered");

    const text = await res.text();
    const events = text.split("\n\n").filter(Boolean).map((frame) => {
      const [eventLine, dataLine] = frame.split("\n");
      return { event: eventLine.replace("event: ", ""), data: JSON.parse(dataLine.replace("data: ", "")) };
    });
    const order = events.map((e) => e.event);
    expect(order[0]).toBe("message_start");
    expect(order[1]).toBe("content_block_start");
    expect(order.at(-2)).toBe("message_delta");
    expect(order.at(-1)).toBe("message_stop");
    expect(order.filter((e) => e === "content_block_delta").length).toBeGreaterThan(1);

    const assembled = events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => e.data.delta.text)
      .join("");
    expect(assembled).toBe(answer);
    const delta = events.find((e) => e.event === "message_delta");
    expect(delta?.data.delta.stop_reason).toBe("end_turn");
    bridge.ws.close();
  });
});

describe("POST /v1/messages — fail-closed routing (ADR-0013)", () => {
  test("an unqualified model is rejected when several providers are registered", async () => {
    const { port } = await startServer();
    const a = await connectFakeBridge(`ws://127.0.0.1:${port}/bridge`, "deepseek", "pong");
    const b = await connectFakeBridge(`ws://127.0.0.1:${port}/bridge`, "doubao", "pong");
    const res = await postMessages(port, claudeCodeRequest({ model: "deepseek-chat" }));
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe("not_found_error");
    expect(body.error.message).toContain("deepseek");
    expect(body.error.message).toContain("doubao");
    a.ws.close();
    b.ws.close();
  });

  test("an unknown provider prefix is rejected naming what is available", async () => {
    const { port } = await startServer();
    const bridge = await connectFakeBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, "pong");
    const res = await postMessages(port, claudeCodeRequest({ model: "nosuch/x" }));
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain("nosuch");
    expect(body.error.message).toContain(DEEPSEEK_PROVIDER);
    bridge.ws.close();
  });

  test("a registered provider without a live tab fails as provider_unavailable", async () => {
    const { port } = await startServer();
    // Bridge connects (provider announced) but never registers a tab.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
    await new Promise<void>((resolve) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "bridge.hello", pairingToken: PAIRING_TOKEN, registration: registration() }));
        resolve();
      };
    });
    const res = await postMessages(port, claudeCodeRequest());
    expect(res.status).toBe(503);
    const body = await res.json() as { error: { type: string } };
    expect(body.error.type).toBe("overloaded_error");
    ws.close();
  });
});

describe("GatewayStore API key lifecycle", () => {
  test("generated on first run, persisted, and backfilled for pre-ticket-02 state", () => {
    const dir = mkdtempSync(join(tmpdir(), "gateway-store-"));
    try {
      const store = new GatewayStore(dir);
      const state = store.loadOrCreate();
      expect(state.gatewayApiKey).toMatch(/^gw_/);
      expect(state.gatewayApiKey).not.toBe(state.pairingToken);

      // Reload: same key survives a restart.
      const reloaded = new GatewayStore(dir).loadOrCreate();
      expect(reloaded.gatewayApiKey).toBe(state.gatewayApiKey);

      // Simulate a state file written by ticket 01 (no gatewayApiKey field).
      const file = join(dir, "state.json");
      const legacy = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      delete legacy.gatewayApiKey;
      writeFileSync(file, JSON.stringify(legacy));
      const backfilled = new GatewayStore(dir).loadOrCreate();
      expect(backfilled.gatewayApiKey).toMatch(/^gw_/);
      expect(backfilled.pairingToken).toBe(state.pairingToken);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GET /v1/models — the catalog the account can reach", () => {
  test("lists the site's own names, provider-qualified, with freshness", async () => {
    const { port } = await startServer();
    await connectFakeBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, "pong");
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { "x-api-key": GATEWAY_KEY },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; fresh: boolean; effort: string[] }[] };
    expect(body.data.map((m) => m.id)).toEqual(["deepseek/快速模式", "deepseek/专家模式"]);
    expect(body.data[0]!.effort).toEqual(["深度思考"]);
    expect(body.data[0]!.fresh).toBe(true);
  });

  test("requires the Gateway API Key", async () => {
    const { port } = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
    expect(res.status).toBe(401);
  });
});

describe("model selection is fail-closed on the wire", () => {
  test("a qualified model the site does not offer is refused, naming what is", async () => {
    const { port } = await startServer();
    await connectFakeBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, "pong");
    const res = await postMessages(port, claudeCodeRequest({ model: "deepseek/deepseek-reasoner" }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("deepseek/快速模式");
  });

  test("an unqualified client model is served and the header says what ran", async () => {
    // Claude Code sends its own model names, which express no web-model choice;
    // refusing them would break every unqualified client for no honesty gained.
    const { port } = await startServer();
    await connectFakeBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, "pong");
    const res = await postMessages(port, claudeCodeRequest({ model: "claude-sonnet-4-5" }));
    expect(res.status).toBe(200);
    expect(decodeURIComponent(res.headers.get("x-gateway-model") ?? "")).toBe("快速模式");
  });
});
