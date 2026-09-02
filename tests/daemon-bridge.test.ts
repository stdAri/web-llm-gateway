import { describe, expect, test } from "bun:test";
import { BridgeHub } from "../src/daemon/bridge-hub";
import { GatewayHTTPServer } from "../src/daemon/http-server";
import { BRIDGE_PROTOCOL_VERSION } from "../src/shared/bridge-protocol";
import type { ProviderRegistration } from "../src/shared/canonical";

const TOKEN = "bp_testtoken123";
const GATEWAY_KEY = "gw_testkey123";
const DEEPSEEK_PROVIDER = "deepseek";

function registration(provider = DEEPSEEK_PROVIDER, protocolVersion = BRIDGE_PROTOCOL_VERSION): ProviderRegistration {
  return {
    provider,
    protocolVersion,
    models: [{ id: "deepseek-chat", displayName: "DeepSeek Chat" }],
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

/** Open a WebSocket client to the daemon and drive the bridge protocol. */
function openBridge(wsUrl: string, token: string, reg: ProviderRegistration) {
  const ws = new WebSocket(wsUrl);
  const sent: unknown[] = [];
  const received: unknown[] = [];
  ws.onmessage = (ev) => {
    received.push(JSON.parse(String(ev.data)));
  };
  return new Promise<{ ws: WebSocket; sent: unknown[]; received: unknown[] }>((resolvePromise, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "bridge.hello", pairingToken: token, registration: reg }));
      resolvePromise({ ws, sent, received });
    };
    ws.onerror = () => reject(new Error("ws error"));
  });
}

describe("BridgeHub pairing", () => {
  test("rejects a connection with an invalid pairing token", async () => {
    const hub = new BridgeHub(TOKEN);
    const server = new GatewayHTTPServer({ hub, port: 0, turnTimeoutMs: 1000, gatewayApiKey: GATEWAY_KEY });
    await server.start();
    try {
      const port = server.port!;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
      const close = new Promise<{ code: number }>((resolve) => {
        ws.onclose = (ev) => resolve({ code: ev.code });
      });
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "bridge.hello", pairingToken: "wrong", registration: registration() }));
      };
      const { code } = await close;
      expect(code).toBe(4401);
    } finally {
      server.stop();
    }
  });
});

describe("BridgeHub provider registration (no hardcoded list)", () => {
  test("provider is learned from the Bridge announcement", async () => {
    const hub = new BridgeHub(TOKEN);
    const server = new GatewayHTTPServer({ hub, port: 0, turnTimeoutMs: 1000, gatewayApiKey: GATEWAY_KEY });
    await server.start();
    try {
      const port = server.port!;
      const client = await openBridge(`ws://127.0.0.1:${port}/bridge`, TOKEN, registration("some-new-provider"));
      await Bun.sleep(50);
      expect(hub.listProviders()).toEqual([
        { provider: "some-new-provider", tabCount: 0, staleTabCount: 0, bridgeVersions: ["unknown"], tools: "prompt-emulated" },
      ]);
      client.ws.close();
    } finally {
      server.stop();
    }
  });
});

describe("end-to-end text turn", () => {
  test("a prompt routed to a registered provider returns the real answer", async () => {
    const hub = new BridgeHub(TOKEN);
    const server = new GatewayHTTPServer({ hub, port: 0, turnTimeoutMs: 5000, gatewayApiKey: GATEWAY_KEY });
    await server.start();
    try {
      const port = server.port!;
      const client = await openBridge(`ws://127.0.0.1:${port}/bridge`, TOKEN, registration());
      client.ws.send(JSON.stringify({ type: "tab.registered", tabId: "tab_1", provider: DEEPSEEK_PROVIDER, url: "https://chat.deepseek.com/" }));

      const answerPromise = fetch(`http://127.0.0.1:${port}/v1/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: `Bearer ${GATEWAY_KEY}` },
        body: JSON.stringify({ provider: DEEPSEEK_PROVIDER, prompt: "你好" }),
      }).then((r) => r.json());

      // The Bridge should receive turn.request, then reply with a turn.result.
      const turnReq = await waitFor<{ type: string; turnId: string; prompt: string }>(client.received, (m): m is { type: string; turnId: string; prompt: string } => !!(m && (m as Record<string, unknown>).type === "turn.request"), 3000);
      expect(turnReq.prompt).toBe("你好");
      client.ws.send(JSON.stringify({
        type: "turn.result",
        turnId: turnReq.turnId,
        provider: DEEPSEEK_PROVIDER,
        text: "世界，你好。",
        streamSource: "network",
      }));

      const res = await answerPromise as { provider: string; text: string };
      expect(res.provider).toBe(DEEPSEEK_PROVIDER);
      expect(res.text).toBe("世界，你好。");
      client.ws.close();
    } finally {
      server.stop();
    }
  });

  test("fail-closed when no live tab is registered", async () => {
    const hub = new BridgeHub(TOKEN);
    const server = new GatewayHTTPServer({ hub, port: 0, turnTimeoutMs: 1000, gatewayApiKey: GATEWAY_KEY });
    await server.start();
    try {
      const port = server.port!;
      await openBridge(`ws://127.0.0.1:${port}/bridge`, TOKEN, registration());
      const res = await fetch(`http://127.0.0.1:${port}/v1/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: `Bearer ${GATEWAY_KEY}` },
        body: JSON.stringify({ provider: DEEPSEEK_PROVIDER, prompt: "hi" }),
      }).then((r) => r.json());
      expect((res as { error: { code: string } }).error.code).toBe("provider_unavailable");
    } finally {
      server.stop();
    }
  });
});

describe("loopback binding", () => {
  test("server binds to 127.0.0.1 only", async () => {
    const hub = new BridgeHub(TOKEN);
    const server = new GatewayHTTPServer({ hub, port: 0, turnTimeoutMs: 1000, gatewayApiKey: GATEWAY_KEY });
    await server.start();
    try {
      expect(server.hostname).toBe("127.0.0.1");
    } finally {
      server.stop();
    }
  });
});

async function waitFor<T>(
  arr: unknown[],
  pred: (x: unknown) => x is T,
  timeoutMs: number,
): Promise<T> {
  const existing = arr.find(pred);
  if (existing) return existing;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = arr.find(pred);
    if (found) return found;
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting for message");
}
