/**
 * The Gateway Node's HTTP surface.
 *
 * Two client endpoints:
 * - `/v1/turn` (ticket 01) — a text prompt routed through the BridgeHub to a
 *   registered provider, answer returned complete. Kept as a scaffold surface.
 * - `/v1/messages` (ticket 02) — the Anthropic Messages protocol Claude Code
 *   speaks, translated by ./messages.ts.
 *
 * Both require the Gateway API Key (Authorization: Bearer or x-api-key),
 * generated on first run and stored by ./store.ts. The Bridge's WebSocket
 * authenticates separately with the Bridge Pairing Token; neither secret is
 * accepted in place of the other (ADR-0007).
 *
 * Loopback isolation is enforced at the socket level: the server binds to
 * 127.0.0.1 only, so connections from other interfaces are refused by the OS
 * before any request is handled, per CONTEXT.md "Gateway Node".
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type Server } from "bun";
import { BridgeHub, type BridgeSocketData } from "./bridge-hub";
import { ToolLoop } from "./tool-loop";
import {
  anthropicError,
  executeMessagesTurn,
  executeMessagesTurnStreaming,
  mapCanonicalError,
  messageEnvelope,
  parseMessagesRequest,
  synthesizedEventStream,
} from "./messages";

export interface ServerOptions {
  hub: BridgeHub;
  port: number;
  turnTimeoutMs: number;
  gatewayApiKey: string;
}

export class GatewayHTTPServer {
  private server: Server<BridgeSocketData> | null = null;
  /** Tool conversation state lives beside the hub, shared across requests. */
  private readonly toolLoop = new ToolLoop();

  constructor(private readonly opts: ServerOptions) {}

  get port(): number | undefined {
    return this.server?.port;
  }

  get hostname(): string | undefined {
    return this.server?.hostname;
  }

  async start(): Promise<number> {
    const { hub, port, turnTimeoutMs, gatewayApiKey } = this.opts;
    return new Promise<number>((resolve) => {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        websocket: hub.wsHandler(),
        fetch: (req) => {
          const url = new URL(req.url);

          // WebSocket upgrade for the Bridge (pairing-token auth inside the
          // bridge protocol, not the Gateway API Key)
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

          // GET /bridge.user.js — install and update the Bridge from the
          // running daemon during development. Unauthenticated on purpose: a
          // userscript manager cannot present the Gateway API Key, the listener
          // is loopback-only, and the artifact carries no secret now that
          // pairing happens at runtime.
          if (url.pathname === "/bridge.user.js" && req.method === "GET") {
            return serveBridgeArtifact(url);
          }

          // POST /v1/messages — Anthropic Messages (Claude Code). Query
          // parameters (?beta=true) are accepted; routing matches path only.
          if (url.pathname === "/v1/messages" && req.method === "POST") {
            if (!hasGatewayKey(req, gatewayApiKey)) {
              return anthropicError(401, "authentication_error", "missing or invalid Gateway API Key");
            }
            return handleMessages(req, hub, this.toolLoop, turnTimeoutMs);
          }

          // POST /v1/turn — submit a text prompt
          if (url.pathname === "/v1/turn" && req.method === "POST") {
            if (!hasGatewayKey(req, gatewayApiKey)) {
              return Response.json(
                { error: { code: "unauthorized", message: "missing or invalid Gateway API Key" } },
                { status: 401 },
              );
            }
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

/** The Gateway API Key arrives as `Authorization: Bearer` (Claude Code's
 * ANTHROPIC_AUTH_TOKEN) or `x-api-key`. Only an exact match on the Gateway
 * API Key is accepted — the Bridge Pairing Token does not work here. */
/**
 * Serves the built artifact with its update URLs repointed at this daemon.
 *
 * The committed artifact keeps its GitHub URLs so a published install tracks
 * the repository; only this response rewrites them, so a Bridge installed from
 * the daemon tracks local rebuilds instead. Whichever source it was installed
 * from becomes its update source, which is why no toggle is needed.
 */
export function serveBridgeArtifact(url: URL, distDir?: string): Response {
  const dir = distDir ?? join(import.meta.dirname, "..", "..", "dist");
  const path = join(dir, "bridge.user.js");
  if (!existsSync(path)) {
    return new Response("bridge artifact not built; run `bun run build:bridge`", { status: 404 });
  }
  const local = `${url.origin}/bridge.user.js`;
  const source = readFileSync(path, "utf8")
    .replace(/^\/\/ @downloadURL.*$/m, `// @downloadURL  ${local}`)
    .replace(/^\/\/ @updateURL.*$/m, `// @updateURL    ${local}`);
  return new Response(source, {
    headers: {
      // Tampermonkey keys off the .user.js path, not the content type, but a
      // no-store response keeps it from installing a cached older build.
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function hasGatewayKey(req: Request, gatewayApiKey: string): boolean {
  const bearer = req.headers.get("authorization");
  const presented = bearer?.startsWith("Bearer ")
    ? bearer.slice("Bearer ".length)
    : req.headers.get("x-api-key");
  return presented === gatewayApiKey;
}

async function handleMessages(
  req: Request,
  hub: BridgeHub,
  toolLoop: ToolLoop,
  turnTimeoutMs: number,
): Promise<Response> {
  let parsed;
  try {
    parsed = parseMessagesRequest(await req.json());
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "request body must be valid JSON";
    const { status, type } = mapCanonicalError("invalid_request");
    return anthropicError(status, type, message);
  }

  // Provider routing: an explicit `provider/model` prefix wins; with exactly
  // one registered provider the choice is unambiguous. Anything else fails
  // closed, naming what is available (ADR-0013).
  const available = hub.listProviders().map((p) => p.provider);
  const provider = parsed.providerPrefix ?? (available.length === 1 ? available[0] : undefined);
  if (!provider || !available.includes(provider)) {
    const { status, type } = mapCanonicalError("model_unavailable");
    return anthropicError(
      status,
      type,
      `cannot route model "${parsed.requestedModel}": qualify it as <provider>/<model>. ` +
        `available providers: ${available.join(", ") || "(none — pair a Bridge and open a Web Product tab)"}`,
    );
  }

  const headers: Record<string, string> = {
    "x-gateway-provider": provider,
    // Web products report no accounting; every usage figure is a
    // length-based estimate and must be flagged as such (ticket 04).
    "x-gateway-usage": "estimated",
  };
  if (parsed.unhonouredFields.length > 0) {
    headers["x-gateway-unhonoured-fields"] = parsed.unhonouredFields.join(",");
    console.warn(`[messages] unhonoured request fields: ${parsed.unhonouredFields.join(", ")}`);
  }

  // Real incremental streaming applies to plain text turns. Tool-loop turns
  // stay buffered: calls must be validated atomically before anything reaches
  // the client, so there is nothing honest to stream mid-turn.
  if (parsed.stream && !parsed.tools && !parsed.toolResults) {
    try {
      const readiness = await executeMessagesTurnStreaming(hub, provider, parsed, turnTimeoutMs);
      headers["content-type"] = "text/event-stream; charset=utf-8";
      headers["cache-control"] = "no-cache";
      headers["x-gateway-stream-source"] = readiness.provenance;
      if (readiness.provenance === "buffered") {
        return new Response(
          synthesizedEventStream({ requestedModel: parsed.requestedModel, prompt: parsed.prompt, reply: readiness.reply }),
          { headers },
        );
      }
      return new Response(readiness.body, { headers });
    } catch (err: unknown) {
      const code = (err as Error & { code?: string }).code ?? "internal_error";
      const { status, type } = mapCanonicalError(code);
      return anthropicError(status, type, (err as Error).message ?? "unknown error");
    }
  }

  try {
    const reply = await executeMessagesTurn(hub, toolLoop, provider, parsed, turnTimeoutMs);
    if (parsed.stream) {
      // Tool turns: synthesized from a complete, validated answer — the
      // provenance header must say so.
      headers["content-type"] = "text/event-stream; charset=utf-8";
      headers["cache-control"] = "no-cache";
      headers["x-gateway-stream-source"] = "buffered";
      return new Response(
        synthesizedEventStream({ requestedModel: parsed.requestedModel, prompt: parsed.prompt, reply }),
        { headers },
      );
    }
    return Response.json(
      messageEnvelope({ requestedModel: parsed.requestedModel, prompt: parsed.prompt, reply }),
      { headers },
    );
  } catch (err: unknown) {
    const code = (err as Error & { code?: string }).code ?? "internal_error";
    const { status, type } = mapCanonicalError(code);
    return anthropicError(status, type, (err as Error).message ?? "unknown error");
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
    const result = await hub.submitTurn(provider, prompt, turnTimeoutMs);
    return Response.json({
      provider,
      text: result.text,
      reasoning: result.reasoning,
      streamSource: result.streamSource,
      diagnostics: result.diagnostics,
    });
  } catch (err: unknown) {
    const code = (err as Error & { code?: string }).code ?? "internal_error";
    const message = (err as Error).message ?? "unknown error";
    const diagnostics = (err as Error & { diagnostics?: unknown }).diagnostics;
    return Response.json({ error: { code, message, diagnostics } }, { status: 502 });
  }
}
