/**
 * Ticket 05: cancellation and turn timeout.
 *
 * The behaviour under test was established live: clicking DeepSeek's stop
 * control halts generation, but the completion stream emits no terminating
 * frame. A cancelled turn therefore has to be settled explicitly on both
 * sides — otherwise the page sits idle while the turn hangs for its full
 * deadline, which is exactly what happened before this ticket.
 */

import { describe, expect, test } from "bun:test";
import { BridgeHub } from "../src/daemon/bridge-hub";
import { DEFAULT_TURN_TIMEOUT_MS, resolveTurnTimeoutMs } from "../src/daemon/config";
import { GatewayHTTPServer } from "../src/daemon/http-server";
import { BRIDGE_PROTOCOL_VERSION } from "../src/shared/bridge-protocol";
import type { ProviderRegistration } from "../src/shared/canonical";

const TOKEN = "bp_testtoken123";
const GATEWAY_KEY = "gw_testkey123";
const PROVIDER = "deepseek";

function registration(): ProviderRegistration {
  return {
    provider: PROVIDER,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
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

interface FakeBridge {
  ws: WebSocket;
  received: Record<string, unknown>[];
  waitFor(type: string, ms?: number): Promise<Record<string, unknown>>;
  close(): void;
}

/** A Bridge that registers a live tab and records what the daemon sends it. */
async function connectBridge(port: number): Promise<FakeBridge> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  const received: Record<string, unknown>[] = [];
  ws.onmessage = (ev) => received.push(JSON.parse(String(ev.data)));
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws error"));
  });
  ws.send(JSON.stringify({ type: "bridge.hello", pairingToken: TOKEN, registration: registration() }));
  ws.send(
    JSON.stringify({
      type: "tab.registered",
      tabId: "tab_1",
      provider: PROVIDER,
      url: "https://chat.deepseek.com/a/chat/s/x",
    }),
  );
  await Bun.sleep(30);
  return {
    ws,
    received,
    async waitFor(type, ms = 2000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const hit = received.find((m) => m.type === type);
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
        await Bun.sleep(10);
      }
    },
    close: () => ws.close(),
  };
}

async function withServer<T>(
  fn: (ctx: { hub: BridgeHub; port: number; bridge: FakeBridge }) => Promise<T>,
  opts: { turnTimeoutMs?: number } = {},
): Promise<T> {
  const hub = new BridgeHub(TOKEN);
  const server = new GatewayHTTPServer({
    hub,
    port: 0,
    turnTimeoutMs: opts.turnTimeoutMs ?? 5000,
    gatewayApiKey: GATEWAY_KEY,
  });
  await server.start();
  const bridge = await connectBridge(server.port!);
  try {
    return await fn({ hub, port: server.port!, bridge });
  } finally {
    bridge.close();
    server.stop();
  }
}

describe("cancellation reaches the Web Product", () => {
  test("aborting sends turn.cancel for that exact turn", async () => {
    await withServer(async ({ hub, bridge }) => {
      const controller = new AbortController();
      const turn = hub.submitTurn(PROVIDER, "hello", 5000, { signal: controller.signal });

      const request = await bridge.waitFor("turn.request");
      controller.abort();

      const cancel = await bridge.waitFor("turn.cancel");
      // Stopping the wrong turn would leave this one generating.
      expect(cancel.turnId).toBe(request.turnId);
      expect(cancel.provider).toBe(PROVIDER);

      // The Bridge answers with whatever it had assembled.
      bridge.ws.send(
        JSON.stringify({
          type: "turn.result",
          turnId: request.turnId,
          provider: PROVIDER,
          text: "partial ans",
          streamSource: "network",
          cancelled: true,
        }),
      );
      const outcome = await turn;
      expect(outcome.cancelled).toBe(true);
      expect(outcome.text).toBe("partial ans");
    });
  });

  test("a cancelled turn resolves rather than throwing", async () => {
    // Criterion: cancellation is an outcome, not an error.
    await withServer(async ({ hub, bridge }) => {
      const controller = new AbortController();
      const turn = hub.submitTurn(PROVIDER, "hello", 5000, { signal: controller.signal });
      const request = await bridge.waitFor("turn.request");
      controller.abort();
      await bridge.waitFor("turn.cancel");
      bridge.ws.send(
        JSON.stringify({
          type: "turn.result",
          turnId: request.turnId,
          provider: PROVIDER,
          text: "",
          streamSource: "network",
          cancelled: true,
        }),
      );
      await expect(turn).resolves.toMatchObject({ cancelled: true });
    });
  });

  test("settles promptly when the Bridge never answers the cancel", async () => {
    // Otherwise a Bridge that died mid-turn would hold the turn until the full
    // turn timeout, with nothing generating anywhere.
    await withServer(async ({ hub, bridge }) => {
      const controller = new AbortController();
      const turn = hub.submitTurn(PROVIDER, "hello", 60_000, { signal: controller.signal });
      await bridge.waitFor("turn.request");
      controller.abort();

      const started = Date.now();
      const outcome = await turn;
      expect(outcome.cancelled).toBe(true);
      expect(Date.now() - started).toBeLessThan(BridgeHub.CANCEL_GRACE_MS + 2000);
    });
  });

  test("the provider is free for a new turn straight after a cancel", async () => {
    // Criterion: the tab is released and reusable immediately.
    await withServer(async ({ hub, bridge }) => {
      const controller = new AbortController();
      const first = hub.submitTurn(PROVIDER, "first", 60_000, { signal: controller.signal });
      const firstRequest = await bridge.waitFor("turn.request");
      controller.abort();
      await bridge.waitFor("turn.cancel");
      bridge.ws.send(
        JSON.stringify({
          type: "turn.result",
          turnId: firstRequest.turnId,
          provider: PROVIDER,
          text: "",
          streamSource: "network",
          cancelled: true,
        }),
      );
      await first;

      bridge.received.length = 0;
      const second = hub.submitTurn(PROVIDER, "second", 5000);
      const secondRequest = await bridge.waitFor("turn.request");
      expect(secondRequest.turnId).not.toBe(firstRequest.turnId);
      bridge.ws.send(
        JSON.stringify({
          type: "turn.result",
          turnId: secondRequest.turnId,
          provider: PROVIDER,
          text: "done",
          streamSource: "network",
        }),
      );
      expect((await second).text).toBe("done");
    });
  });

  test("an abort before dispatch still stops the page", async () => {
    // The signal can fire in the window between accepting the turn and handing
    // it to a Bridge; the cancel must not be lost.
    await withServer(async ({ hub, bridge }) => {
      const controller = new AbortController();
      controller.abort();
      const turn = hub.submitTurn(PROVIDER, "hello", 60_000, { signal: controller.signal });
      await bridge.waitFor("turn.cancel");
      expect((await turn).cancelled).toBe(true);
    });
  });
});

describe("turn timeout", () => {
  test("fails explicitly and names the knob to change", async () => {
    await withServer(
      async ({ hub, bridge }) => {
        const turn = hub.submitTurn(PROVIDER, "hello", 150);
        await bridge.waitFor("turn.request");
        await expect(turn).rejects.toThrow(/turn_timeout_ms/);
      },
      { turnTimeoutMs: 150 },
    );
  });

  test("stops generation in the page instead of abandoning it", async () => {
    // The whole point of the ticket: a turn nobody is waiting for must not
    // leave the Web Product generating and burning the account's capacity.
    await withServer(async ({ hub, bridge }) => {
      const turn = hub.submitTurn(PROVIDER, "hello", 150);
      const request = await bridge.waitFor("turn.request");
      await turn.catch(() => undefined);
      const cancel = await bridge.waitFor("turn.cancel");
      expect(cancel.turnId).toBe(request.turnId);
    });
  });

  test("carries the turn_timeout code for error mapping", async () => {
    await withServer(async ({ hub, bridge }) => {
      const turn = hub.submitTurn(PROVIDER, "hello", 150);
      await bridge.waitFor("turn.request");
      const err = await turn.catch((e: Error & { code?: string }) => e);
      expect((err as { code?: string }).code).toBe("turn_timeout");
      expect((err as Error).message).toContain("150ms");
    });
  });

  test("is configurable rather than a constant", () => {
    // Pro tiers and high-effort models legitimately run longer than the default.
    expect(resolveTurnTimeoutMs({ GATEWAY_TURN_TIMEOUT_MS: "900000" })).toBe(900_000);
    expect(resolveTurnTimeoutMs({})).toBe(DEFAULT_TURN_TIMEOUT_MS);
  });

  test("refuses a value that would silently disable the timeout", () => {
    // A typo must not turn the budget off; hanging forever is worse than a
    // timeout the user did not intend.
    for (const bad of ["", "0", "-1", "abc", "NaN"]) {
      expect(resolveTurnTimeoutMs({ GATEWAY_TURN_TIMEOUT_MS: bad })).toBe(DEFAULT_TURN_TIMEOUT_MS);
    }
  });
});
