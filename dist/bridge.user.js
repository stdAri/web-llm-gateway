// ==UserScript==
// @name         Web LLM Gateway Bridge
// @namespace    web-llm-gateway
// @version      0.1.0
// @description  Registers Web Product tabs and executes turns against real web conversations.
// @downloadURL  https://raw.githubusercontent.com/stdAri/web-llm-gateway/main/dist/bridge.user.js
// @updateURL    https://raw.githubusercontent.com/stdAri/web-llm-gateway/main/dist/bridge.user.js
// @match        https://chat.deepseek.com/*
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function () {
  const CONFIG = {"daemonUrl":"ws://127.0.0.1:8100/bridge","pairingToken":"PAIRING_TOKEN","autoRegister":true};
  
const CONFIG = window.__CONFIG__;
const STREAM_CHANNEL = "web-llm-gateway:deepseek-stream";
const PROVIDER = "deepseek";
let ws = null;
let heartbeatTimer = null;
let tabId = null;

function log(...args) { console.log('[bridge]', ...args); }

function injectPageInterceptor() {
  try {
    const target = unsafeWindow || window;
    const script = document.createElement('script');
    script.textContent = "(function () {\n    const CHANNEL = \"web-llm-gateway:deepseek-stream\";\n    const SUFFIX = \"/chat/completion\";\n    const w = window;\n    const post = function (payload) {\n      try { w.postMessage({ channel: CHANNEL, payload }, \"*\"); } catch (e) {}\n    };\n    function observeResponseBody(body, isSSE) {\n      try {\n        if (typeof body === \"string\" && isSSE) {\n          const lines = body.split(/\\r?\\n/);\n          for (const line of lines) {\n            if (line.startsWith(\"data:\")) {\n              const data = line.slice(5).trim();\n              if (data && data !== \"[DONE]\") {\n                try { post(JSON.parse(data)); } catch (e) {}\n              }\n            }\n          }\n        }\n      } catch (e) {}\n    }\n    const origFetch = w.fetch;\n    if (origFetch) {\n      w.fetch = function (input, init) {\n        const url = typeof input === \"string\" ? input : (input && input.url) || \"\";\n        const isCompletion = url.indexOf(SUFFIX) !== -1;\n        const promise = origFetch.apply(this, arguments);\n        if (isCompletion) {\n          promise.then(function (res) {\n            try {\n              res.clone().text().then(function (body) { observeResponseBody(body, true); });\n            } catch (e) {}\n          }).catch(function () {});\n        }\n        return promise;\n      };\n    }\n    const origOpen = XMLHttpRequest.prototype.open;\n    XMLHttpRequest.prototype.open = function (method, url) {\n      this.__llmIsCompletion = typeof url === \"string\" && url.indexOf(SUFFIX) !== -1;\n      return origOpen.apply(this, arguments);\n    };\n    const origSend = XMLHttpRequest.prototype.send;\n    XMLHttpRequest.prototype.send = function (body) {\n      const self = this;\n      if (this.__llmIsCompletion) {\n        this.addEventListener(\"readystatechange\", function () {\n          if (self.readyState === 4 && self.status === 200) {\n            observeResponseBody(self.responseText, true);\n          }\n        });\n      }\n      return origSend.apply(this, arguments);\n    };\n  })();";
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
    protocolVersion: 1,
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
  return location.host === "chat.deepseek.com";
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

})();
