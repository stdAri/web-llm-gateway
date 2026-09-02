/**
 * The Bridge connection hub. Accepts WebSocket connections from the userscript
 * Bridge, authenticates them with the Bridge Pairing Token, collects provider
 * registrations (data the Bridge declares — no compiled-in provider list, per
 * ADR-0014), and routes text turns to a registered tab of the right provider.
 *
 * Ticket 01 scope: single text turn, answer returned complete, no streaming,
 * no queueing, no model selection.
 */

import type { ServerWebSocket, WebSocketHandler } from "bun";
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeMessage,
  isBridgeMessage,
  type ParsedToolCall,
} from "../shared/bridge-protocol";
import type { ProviderRegistration } from "../shared/canonical";

export interface RegisteredTab {
  tabId: string;
  provider: string;
  url: string;
  lastHeartbeat: number;
}

interface PendingTurn {
  resolve: (result: TurnOutcome) => void;
  reject: (err: Error) => void;
  /** Incremental answer fragments as the Bridge observes them (ticket 04). */
  onDelta?: (delta: TurnDelta) => void;
  /** The daemon conversation this turn belongs to, so the provider-side
   * reference reported in the result lands on the right record. */
  conversationId?: string;
}

export interface TurnDelta {
  kind: "text" | "reasoning";
  text: string;
}

export interface TurnOutcome {
  text: string;
  reasoning?: string;
  streamSource: string;
  diagnostics?: Record<string, unknown>;
  toolCalls?: ParsedToolCall[];
  envelopeError?: string;
  conversationRef?: string;
}

/** A daemon-issued conversation pinned to the Bridge connection that ran its
 * first turn, so continuation turns return to the same web conversation. */
interface ConversationRoute {
  provider: string;
  ws: ServerWebSocket<BridgeSocketData>;
  ref?: string;
}

export interface BridgeSocketData {
  tokenPresented?: boolean;
  provider?: string;
  bridgeVersion?: string;
}

export class BridgeHub {
  /** provider -> map of tabId -> tab */
  private tabs = new Map<string, Map<string, RegisteredTab>>();
  /** provider -> map of turnId -> pending turn */
  private pendingTurns = new Map<string, Map<string, PendingTurn>>();
  private connections = new Set<ServerWebSocket<BridgeSocketData>>();
  private providerOrder: string[] = [];
  /** provider -> registration announced at hello (capabilities included, so
   * the honest `tools: prompt-emulated` report is observable). */
  private registrations = new Map<string, ProviderRegistration>();
  /** conversationId -> the connection that conversation is bound to */
  private conversations = new Map<string, ConversationRoute>();

  constructor(private readonly validPairingToken: string) {}

  static readonly TAB_TTL_MS = 30_000;

  listProviders(): {
    provider: string;
    tabCount: number;
    staleTabCount: number;
    bridgeVersions: string[];
    tools?: ProviderRegistration["capabilities"]["tools"];
  }[] {
    return this.providerOrder.map((p) => {
      const all = [...(this.tabs.get(p)?.values() ?? [])];
      const live = all.filter((t) => t.lastHeartbeat >= Date.now() - BridgeHub.TAB_TTL_MS);
      return {
        provider: p,
        tabCount: live.length,
        staleTabCount: all.length - live.length,
        bridgeVersions: [
          ...new Set(
            [...this.connections]
              .filter((c) => c.data.provider === p)
              .map((c) => c.data.bridgeVersion ?? "unknown"),
          ),
        ],
        tools: this.registrations.get(p)?.capabilities.tools,
      };
    });
  }

  tabCount(provider: string): number {
    return this.tabs.get(provider)?.size ?? 0;
  }

  /** Record a provider identity announced by a Bridge at registration. */
  private noteProvider(provider: string) {
    if (!this.providerOrder.includes(provider)) this.providerOrder.push(provider);
    if (!this.tabs.has(provider)) this.tabs.set(provider, new Map());
  }

  private registerTab(provider: string, tabId: string, url: string) {
    let byProvider = this.tabs.get(provider);
    if (!byProvider) {
      byProvider = new Map();
      this.tabs.set(provider, byProvider);
      if (!this.providerOrder.includes(provider)) this.providerOrder.push(provider);
    }
    byProvider.set(tabId, { tabId, provider, url, lastHeartbeat: Date.now() });
  }

  /** Submit a text prompt to a provider and wait for the complete answer.
   * With `conversationId`, the turn continues that conversation on the Bridge
   * connection it is bound to; a new conversation id pins itself to whichever
   * live connection takes the first turn. */
  submitTurn(
    provider: string,
    prompt: string,
    timeoutMs: number,
    opts: {
      conversationId?: string;
      conversationRef?: string;
      onDelta?: (delta: TurnDelta) => void;
    } = {},
  ): Promise<TurnOutcome> {
    const tab = this.pickTab(provider);
    if (!tab) {
      return Promise.reject(
        Object.assign(new Error(`no registered live tab for provider "${provider}"`), {
          code: "provider_unavailable",
        }),
      );
    }
    const turnId = `t_${Math.random().toString(36).slice(2, 12)}`;
    return new Promise<TurnOutcome>((resolve, reject) => {
      let byProvider = this.pendingTurns.get(provider);
      if (!byProvider) {
        byProvider = new Map();
        this.pendingTurns.set(provider, byProvider);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const safeResolve = (result: TurnOutcome) => {
        clearTimeout(timer);
        resolve(result);
      };
      const safeReject = (err: Error) => {
        clearTimeout(timer);
        reject(err);
      };
      byProvider.set(turnId, {
        resolve: safeResolve,
        reject: safeReject,
        onDelta: opts.onDelta,
        conversationId: opts.conversationId,
      });

      timer = setTimeout(() => {
        byProvider.delete(turnId);
        safeReject(
          Object.assign(new Error(`turn timed out after ${timeoutMs}ms`), {
            code: "turn_timeout",
          }),
        );
      }, timeoutMs);

      // Continuations go back to the connection that owns the conversation;
      // anything else goes to any authenticated connection for the provider.
      const route = opts.conversationId ? this.conversations.get(opts.conversationId) : undefined;
      let target: ServerWebSocket<BridgeSocketData> | undefined;
      if (route) {
        if (this.connections.has(route.ws)) {
          target = route.ws;
        } else {
          this.conversations.delete(opts.conversationId!);
          byProvider.delete(turnId);
          clearTimeout(timer);
          safeReject(
            Object.assign(
              new Error(`the bridge connection for conversation "${opts.conversationId}" is gone`),
              { code: "tab_lost" },
            ),
          );
          return;
        }
      } else {
        for (const ws of this.connections) {
          if (ws.data.provider === provider) {
            target = ws;
            break;
          }
        }
        if (target && opts.conversationId) {
          this.conversations.set(opts.conversationId, { provider, ws: target });
        }
      }
      if (!target) {
        clearTimeout(timer);
        byProvider.delete(turnId);
        safeReject(
          Object.assign(new Error(`no live bridge connection for provider "${provider}"`), {
            code: "provider_unavailable",
          }),
        );
        return;
      }

      const command: BridgeMessage = {
        type: "turn.request",
        turnId,
        provider,
        prompt,
        conversationId: opts.conversationId,
        // The hub fills in the provider-side reference it recorded, so the
        // Bridge can verify the tab still sits on that conversation.
        conversationRef: route?.ref,
      };
      target.send(JSON.stringify(command));
    });
  }

  private pickTab(provider: string): RegisteredTab | undefined {
    const byProvider = this.tabs.get(provider);
    if (!byProvider) return undefined;
    const live = Date.now() - BridgeHub.TAB_TTL_MS;
    for (const tab of byProvider.values()) {
      if (tab.lastHeartbeat >= live) {
        return tab;
      }
    }
    return undefined;
  }

  private onBridgeMessage(ws: ServerWebSocket<BridgeSocketData>, raw: string) {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: "bridge.error", message: "malformed JSON" }));
      return;
    }
    if (!isBridgeMessage(msg)) {
      ws.send(JSON.stringify({ type: "bridge.error", message: "unknown message shape" }));
      return;
    }
    switch (msg.type) {
      case "bridge.hello": {
        if (msg.pairingToken !== this.validPairingToken) {
          ws.close(4401, "invalid pairing token");
          return;
        }
        ws.data.tokenPresented = true;
        ws.data.provider = msg.registration.provider;
        ws.data.bridgeVersion = msg.registration.bridgeVersion;
        this.noteProvider(msg.registration.provider);
        this.registrations.set(msg.registration.provider, msg.registration);
        const version = msg.registration.protocolVersion;
        if (version !== BRIDGE_PROTOCOL_VERSION) {
          if (Math.abs(version - BRIDGE_PROTOCOL_VERSION) <= 1) {
            ws.send(
              JSON.stringify({
                type: "bridge.hello_ack",
                protocolVersion: BRIDGE_PROTOCOL_VERSION,
                accepted: true,
                warning: `bridge protocol version ${version} vs daemon ${BRIDGE_PROTOCOL_VERSION}; degraded within supported window`,
              } satisfies BridgeMessage),
            );
          } else {
            ws.close(
              4402,
              `protocol version mismatch: bridge ${version} is behind daemon ${BRIDGE_PROTOCOL_VERSION}`,
            );
            return;
          }
        } else {
          ws.send(
            JSON.stringify({
              type: "bridge.hello_ack",
              protocolVersion: BRIDGE_PROTOCOL_VERSION,
              accepted: true,
            } satisfies BridgeMessage),
          );
        }
        break;
      }
      case "tab.registered": {
        if (!ws.data.tokenPresented) break;
        this.registerTab(msg.provider, msg.tabId, msg.url);
        ws.data.provider = msg.provider;
        break;
      }
      case "tab.heartbeat": {
        const byProvider = this.tabs.get(msg.provider);
        const tab = byProvider?.get(msg.tabId);
        if (tab) tab.lastHeartbeat = Date.now();
        break;
      }
      case "tab.unregistered": {
        const byProvider = this.tabs.get(msg.provider);
        byProvider?.delete(msg.tabId);
        break;
      }
      case "turn.delta": {
        const pending = this.pendingTurns.get(msg.provider)?.get(msg.turnId);
        if (pending?.onDelta && msg.delta && typeof msg.delta.text === "string") {
          pending.onDelta({
            kind: msg.delta.kind === "reasoning" ? "reasoning" : "text",
            text: msg.delta.text,
          });
        }
        break;
      }
      case "turn.result": {
        const byProvider = this.pendingTurns.get(msg.provider);
        const pending = byProvider?.get(msg.turnId);
        if (!pending) break;
        byProvider!.delete(msg.turnId);
        if (pending.conversationId && msg.conversationRef) {
          const route = this.conversations.get(pending.conversationId);
          if (route) route.ref = msg.conversationRef;
        }
        if (msg.error) {
          pending.reject(
            Object.assign(new Error(msg.error.message), {
              code: msg.error.code,
              diagnostics: msg.diagnostics,
            }),
          );
        } else {
          pending.resolve({
            text: msg.text,
            reasoning: msg.reasoning,
            streamSource: msg.streamSource,
            diagnostics: msg.diagnostics,
            toolCalls: msg.toolCalls,
            envelopeError: msg.envelopeError,
            conversationRef: msg.conversationRef,
          });
        }
        break;
      }
      case "turn.reject": {
        const byProvider = this.pendingTurns.get(msg.provider);
        const pending = byProvider?.get(msg.turnId);
        if (!pending) break;
        byProvider!.delete(msg.turnId);
        pending.reject(Object.assign(new Error(msg.reason), { code: "upstream_refused" }));
        break;
      }
      case "bridge.command":
        // ticket 01 has no daemon->bridge commands beyond turn.request
        break;
    }
  }

  /** WebSocket handler object for Bun.serve, bound to this hub. */
  wsHandler(): WebSocketHandler<BridgeSocketData> {
    const hub = this;
    return {
      open(ws) {
        hub.connections.add(ws);
      },
      message(ws, message) {
        if (typeof message === "string") {
          hub.onBridgeMessage(ws, message);
        }
      },
      close(ws) {
        hub.connections.delete(ws);
        // Conversation routes are deliberately kept: a continuation aimed at a
        // dead connection must fail as tab_lost, which requires remembering
        // that the conversation existed and who owned it.
      },
    };
  }
}
