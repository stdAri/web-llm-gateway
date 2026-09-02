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
import { BRIDGE_PROTOCOL_VERSION, type BridgeMessage, isBridgeMessage } from "../shared/bridge-protocol";

export interface RegisteredTab {
  tabId: string;
  provider: string;
  url: string;
  lastHeartbeat: number;
}

interface PendingTurn {
  resolve: (result: TurnOutcome) => void;
  reject: (err: Error) => void;
}

export interface TurnOutcome {
  text: string;
  streamSource: string;
  diagnostics?: Record<string, unknown>;
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

  constructor(private readonly validPairingToken: string) {}

  static readonly TAB_TTL_MS = 30_000;

  listProviders(): {
    provider: string;
    tabCount: number;
    staleTabCount: number;
    bridgeVersions: string[];
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

  /** Submit a text prompt to a provider and wait for the complete answer. */
  submitTurn(
    provider: string,
    prompt: string,
    timeoutMs: number,
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
      byProvider.set(turnId, { resolve: safeResolve, reject: safeReject });

      timer = setTimeout(() => {
        byProvider.delete(turnId);
        safeReject(
          Object.assign(new Error(`turn timed out after ${timeoutMs}ms`), {
            code: "turn_timeout",
          }),
        );
      }, timeoutMs);

      const command: BridgeMessage = {
        type: "turn.request",
        turnId,
        provider,
        prompt,
      };
      // A turn is routed to any authenticated Bridge connection for the
      // provider; the Bridge itself picks which registered tab to use.
      let delivered = false;
      for (const ws of this.connections) {
        if (ws.data.provider === provider) {
          ws.send(JSON.stringify(command));
          delivered = true;
          break;
        }
      }
      if (!delivered) {
        clearTimeout(timer);
        byProvider.delete(turnId);
        safeReject(
          Object.assign(new Error(`no live bridge connection for provider "${provider}"`), {
            code: "provider_unavailable",
          }),
        );
      }
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
      case "turn.result": {
        const byProvider = this.pendingTurns.get(msg.provider);
        const pending = byProvider?.get(msg.turnId);
        if (!pending) break;
        byProvider!.delete(msg.turnId);
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
            streamSource: msg.streamSource,
            diagnostics: msg.diagnostics,
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
      },
    };
  }
}
