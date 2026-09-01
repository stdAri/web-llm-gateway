/**
 * The Gateway Node's HTTP surface for ticket 01.
 *
 * Exposes a single endpoint `/v1/turn` that accepts a text prompt, routes it
 * through the BridgeHub to a registered provider, and returns the complete
 * answer.
 *
 * Loopback isolation is enforced at the socket level: the server binds to
 * 127.0.0.1 only, so connections from other interfaces are refused by the OS
 * before any request is handled, per CONTEXT.md "Gateway Node".
 *
 * Ticket 01 scope: no model selection, no streaming, no tool loop, no queueing.
 * The caller is `curl`, not an Agent Client (ticket 02).
 */

import { type Server } from "bun";
import { BridgeHub, type BridgeSocketData } from "./bridge-hub";

export interface ServerOptions {
  hub: BridgeHub;
  port: number;
  turnTimeoutMs: number;
}

export class GatewayHTTPServer {
  private server: Server<BridgeSocketData> | null = null;

  constructor(private readonly opts: ServerOptions) {}

  get port(): number | undefined {
    return this.server?.port;
  }

  get hostname(): string | undefined {
    return this.server?.hostname;
  }

  async start(): Promise<number> {
    const { hub, port, turnTimeoutMs } = this.opts;
    return new Promise<number>((resolve) => {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        websocket: hub.wsHandler(),
        fetch: (req) => {
          const url = new URL(req.url);

          // WebSocket upgrade for the Bridge
          if (url.pathname === "/bridge" && req.method === "GET") {
            const upgrade = server.upgrade(req, {
              data: { tokenPresented: false, provider: undefined },
            });
            if (upgrade) return undefined;
            return new Response("WebSocket upgrade failed", { status: 400 });
          }

          // GET / — health check listing declared providers
          if (url.pathname === "/" && req.method === "GET") {
            return Response.json({ ok: true, providers: hub.listProviders() });
          }

          // POST /v1/turn — submit a text prompt
          if (url.pathname === "/v1/turn" && req.method === "POST") {
            return handleTurn(req, hub, turnTimeoutMs);
          }

          return new Response("not found", { status: 404 });
        },
      });
      this.server = server;
      resolve(server.port ?? port);
    });
  }

  stop() {
    this.server?.stop();
  }
}

async function handleTurn(
  req: Request,
  hub: BridgeHub,
  turnTimeoutMs: number,
): Promise<Response> {
  try {
    const body = (await req.json()) as { provider?: string; prompt?: unknown };
    const provider = body.provider ?? "deepseek";
    const prompt = body.prompt;
    if (!prompt || typeof prompt !== "string") {
      return Response.json({ error: { code: "invalid_request", message: "missing or invalid 'prompt' field" } }, { status: 400 });
    }
    const text = await hub.submitTurn(provider, prompt, turnTimeoutMs);
    return Response.json({ provider, text });
  } catch (err: unknown) {
    const code = (err as Error & { code?: string }).code ?? "internal_error";
    const message = (err as Error).message ?? "unknown error";
    return Response.json({ error: { code, message } }, { status: 502 });
  }
}
