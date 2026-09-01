/**
 * Bridge Driver: the userscript that runs inside the Developer User's own
 * already-authenticated browser (ADR-0007). It connects to the local Gateway
 * Node over WebSocket, authenticates with the Bridge Pairing Token, registers
 * open DeepSeek tabs, announces the DeepSeek provider identity (no provider
 * list is compiled into the daemon), and executes text turns against a real
 * DeepSeek web conversation.
 *
 * Streaming capture uses page-context interception: a small injected script
 * overrides fetch/XMLHttpRequest in the page, observes the DeepSeek completion
 * stream, and relays frames to the userscript via window.postMessage. The
 * userscript parses frames with the pure parser and assembles the answer.
 *
 * This module is bundled into a single installable userscript artifact by
 * scripts/build-bridge.ts.
 */

import { BRIDGE_PROTOCOL_VERSION } from "../shared/bridge-protocol";
import type { ProviderRegistration } from "../shared/canonical";
import { assembleDeepSeekAnswer, DEEPSEEK, parseDeepSeekFrame } from "./deepseek-adapter";

declare const unsafeWindow: Window | undefined;
declare const GM_xmlhttpRequest:
  | ((opts: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      data?: string;
      onload?: (res: { status: number; responseText: string }) => void;
      onerror?: (err: unknown) => void;
      timeout?: number;
    }) => void)
  | undefined;

export interface BridgeConfig {
  daemonUrl: string;
  pairingToken: string;
  autoRegister: boolean;
}

export const BRIDGE_CONFIG_DEFAULT: BridgeConfig = {
  daemonUrl: "ws://127.0.0.1:8100/bridge",
  pairingToken: "PAIRING_TOKEN",
  autoRegister: true,
};

/** Channel used to relay captured stream frames from page context to userscript. */
export const STREAM_CHANNEL = "web-llm-gateway:deepseek-stream";

/**
 * Page-context interceptor: overrides fetch/XMLHttpRequest to observe the
 * completion-suffixed endpoint and post each SSE payload to the channel.
 * Stringified into the artifact so it runs in the page's own realm.
 */
export function pageInterceptorSource(): string {
  return `(function () {
    const CHANNEL = ${JSON.stringify(STREAM_CHANNEL)};
    const SUFFIX = ${JSON.stringify(DEEPSEEK.completionSuffix)};
    const w = window;
    const post = function (payload) {
      try { w.postMessage({ channel: CHANNEL, payload }, "*"); } catch (e) {}
    };
    function observeResponseBody(body, isSSE) {
      try {
        if (typeof body === "string" && isSSE) {
          const lines = body.split(/\\r?\\n/);
          for (const line of lines) {
            if (line.startsWith("data:")) {
              const data = line.slice(5).trim();
              if (data && data !== "[DONE]") {
                try { post(JSON.parse(data)); } catch (e) {}
              }
            }
          }
        }
      } catch (e) {}
    }
    const origFetch = w.fetch;
    if (origFetch) {
      w.fetch = function (input, init) {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        const isCompletion = url.indexOf(SUFFIX) !== -1;
        const promise = origFetch.apply(this, arguments);
        if (isCompletion) {
          promise.then(function (res) {
            try {
              res.clone().text().then(function (body) { observeResponseBody(body, true); });
            } catch (e) {}
          }).catch(function () {});
        }
        return promise;
      };
    }
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__llmIsCompletion = typeof url === "string" && url.indexOf(SUFFIX) !== -1;
      return origOpen.apply(this, arguments);
    };
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
      const self = this;
      if (this.__llmIsCompletion) {
        this.addEventListener("readystatechange", function () {
          if (self.readyState === 4 && self.status === 200) {
            observeResponseBody(self.responseText, true);
          }
        });
      }
      return origSend.apply(this, arguments);
    };
  })();`;
}

/** Build the userscript metadata block and bootstrap script. */
export function buildUserscript(config: BridgeConfig): string {
  return `// ==UserScript==
// @name         Web LLM Gateway Bridge
// @namespace    web-llm-gateway
// @version      0.1.0
// @description  Registers Web Product tabs and executes turns against real web conversations.
// @match        https://chat.deepseek.com/*
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function () {
  const CONFIG = ${JSON.stringify(config)};
  ${bridgeRuntime()}
})();
`;
}

function bridgeRuntime(): string {
  return `
const CONFIG = window.__CONFIG__;
const STREAM_CHANNEL = ${JSON.stringify(STREAM_CHANNEL)};
const PROVIDER = ${JSON.stringify(DEEPSEEK.provider)};
let ws = null;
let heartbeatTimer = null;
let tabId = null;

function log(...args) { console.log('[bridge]', ...args); }

function injectPageInterceptor() {
  try {
    const target = unsafeWindow || window;
    const script = document.createElement('script');
    script.textContent = ${JSON.stringify(pageInterceptorSource())};
    (document.head || document.documentElement).appendChild(script);
    script.remove();
    log('page interceptor injected');
  } catch (e) {
    log('page interceptor injection failed', e);
  }
}

function connect() {
  ws = new WebSocket(CONFIG.daemonUrl);
  ws.onopen = function () {
    log('connected');
    register();
  };
  ws.onmessage = function (event) {
    handleMessage(JSON.parse(event.data));
  };
  ws.onclose = function () {
    log('disconnected');
    clearInterval(heartbeatTimer);
    setTimeout(connect, 2000);
  };
  ws.onerror = function () {
    log('ws error');
  };
}

function registration() {
  return {
    provider: PROVIDER,
    protocolVersion: ${BRIDGE_PROTOCOL_VERSION},
    models: [
      { id: 'deepseek-chat', displayName: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner' }
    ],
    capabilities: {
      streaming: true,
      streamSource: 'network',
      reasoning: true,
      tools: 'prompt-emulated',
      images: false,
      files: true,
      citations: false,
      webSearch: false,
      effort: []
    }
  };
}

function register() {
  ws.send(JSON.stringify({
    type: 'bridge.hello',
    pairingToken: CONFIG.pairingToken,
    registration: registration()
  }));

  if (isDeepSeekPage() && CONFIG.autoRegister) {
    tabId = 'tab_' + Math.random().toString(36).slice(2, 10);
    ws.send(JSON.stringify({ type: 'tab.registered', tabId, provider: PROVIDER, url: location.href }));
    heartbeatTimer = setInterval(function () {
      ws.send(JSON.stringify({ type: 'tab.heartbeat', tabId, provider: PROVIDER }));
    }, 10000);
  }
}

function isDeepSeekPage() {
  return location.host === ${JSON.stringify(DEEPSEEK.chatHost)};
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'bridge.hello_ack':
      if (!msg.accepted) { log('rejected: ' + (msg.warning || '')); return; }
      if (msg.warning) log('warning: ' + msg.warning);
      break;
    case 'turn.request':
      executeTurn(msg);
      break;
    default:
      break;
  }
}

function executeTurn(msg) {
  const { turnId, provider, prompt } = msg;
  if (provider !== PROVIDER) {
    ws.send(JSON.stringify({ type: 'turn.reject', turnId, provider, reason: 'unknown provider: ' + provider }));
    return;
  }
  if (!isDeepSeekPage()) {
    ws.send(JSON.stringify({ type: 'turn.reject', turnId, provider, reason: 'not on chat.deepseek.com' }));
    return;
  }

  let frames = [];
  let finished = false;
  let timer = null;
  const deadline = Date.now() + 120000;

  const onFrame = function (payload) {
    const parsed = parseDeepSeekFrame(payload);
    if (parsed) {
      frames.push(parsed);
      if (parsed.type === 'done') finished = true;
    }
  };

  window.addEventListener('message', onStreamMessage);
  function onStreamMessage(event) {
    const data = event.data;
    if (data && data.channel === STREAM_CHANNEL) {
      onFrame(data.payload);
    }
  }

  const poll = function () {
    if (finished || Date.now() > deadline) {
      clearInterval(timer);
      window.removeEventListener('message', onStreamMessage);
      const { text } = assembleDeepSeekAnswer(frames);
      ws.send(JSON.stringify({
        type: 'turn.result',
        turnId,
        provider: PROVIDER,
        text: text || '(no answer received)',
        streamSource: 'network'
      }));
      return;
    }
  };
  timer = setInterval(poll, 400);

  submitPrompt(prompt);
}

function submitPrompt(prompt) {
  const composer = document.querySelector('textarea');
  if (!composer) {
    log('no composer found');
    return;
  }
  // React-aware value setting: DeepSeek's composer is a textarea whose React
  // state will not update from a naive value assignment.
  const proto = window.HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(composer, prompt);
  composer.dispatchEvent(new Event('input', { bubbles: true }));
  setTimeout(function () {
    const send = findSendButton();
    if (send) send.click();
    else log('no send button found');
  }, 300);
}

function findSendButton() {
  const candidates = Array.from(document.querySelectorAll('button, div[role="button"]'));
  return candidates.find(function (el) {
    const aria = el.getAttribute('aria-label') || '';
    return /send|发送|submit/i.test(aria);
  }) || null;
}

window.__CONFIG__ = CONFIG;
injectPageInterceptor();
connect();
`;
}

/** Run the bridge directly when executed in a test host (bun). */
export function startBridge(config: BridgeConfig) {
  const meta = buildUserscript(config);
  return { meta, config };
}
