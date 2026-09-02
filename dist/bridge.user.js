// ==UserScript==
// @name         Web LLM Gateway Bridge
// @namespace    web-llm-gateway
// @version      0.3.0
// @description  Registers Web Product tabs and executes turns against real web conversations.
// @downloadURL  https://raw.githubusercontent.com/stdAri/web-llm-gateway/main/dist/bridge.user.js
// @updateURL    https://raw.githubusercontent.com/stdAri/web-llm-gateway/main/dist/bridge.user.js
// @match        https://chat.deepseek.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
  const CONFIG = {"daemonUrl":"ws://127.0.0.1:8100/bridge","autoRegister":true};

  const DEEPSEEK = {
  provider: "deepseek",
  chatHost: "chat.deepseek.com",
  completionSuffix: "/chat/completion",
  composerSelector: "textarea",
  sendButtonSelector: 'div[role="button"].ds-button--primary.ds-button--filled',
  disabledClass: "ds-button--disabled"
};
function createDeepSeekAssembler() {
  let text = "";
  let reasoning = "";
  let bucket = "none";
  let done = false;
  return {
    push(payload) {
      if (payload === null || typeof payload !== "object")
        return;
      const frame = payload;
      if (isFinished(frame))
        done = true;
      const block = contentBlock(frame);
      const type = typeof block.type === "string" ? block.type : undefined;
      if (type)
        bucket = type === "RESPONSE" ? "answer" : type === "THINK" ? "reasoning" : "none";
      const content = typeof block.content === "string" ? block.content : "";
      if (!content) {
        bucket = "none";
        return;
      }
      if (bucket === "answer")
        text += content;
      else if (bucket === "reasoning")
        reasoning += content;
    },
    get done() {
      return done;
    },
    result() {
      return { text, reasoning };
    }
  };
}
function contentBlock(frame) {
  const v = frame.v;
  if (v && typeof v === "object" && !Array.isArray(v) && "response" in v) {
    const fragments = v.response?.fragments;
    if (Array.isArray(fragments) && fragments[0] && typeof fragments[0] === "object") {
      return fragments[0];
    }
    return {};
  }
  if (Array.isArray(v)) {
    return v[0] && typeof v[0] === "object" ? v[0] : {};
  }
  if (typeof v === "string")
    return { content: v };
  return {};
}
function isFinished(frame) {
  if (frame.p === "response/status" && frame.v === "FINISHED")
    return true;
  if (frame.o === "BATCH" && Array.isArray(frame.v)) {
    return frame.v.some((entry) => entry !== null && typeof entry === "object" && entry.p === "quasi_status" && entry.v === "FINISHED");
  }
  return false;
}
function extractToolEnvelopes(text) {
  if (text.indexOf("<tool_call") === -1)
    return { text, calls: [] };
  const re = /<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call>/g;
  const calls = [];
  let stripped = "";
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    stripped += text.slice(last, m.index);
    last = m.index + m[0].length;
    const attrs = {};
    const attrRe = /(\w+)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(m[1])) !== null)
      attrs[a[1]] = a[2];
    const body = m[2].trim();
    let args = {};
    try {
      args = body ? JSON.parse(body) : {};
    } catch {
      return { text, calls: [], envelopeError: "malformed JSON in tool_call body" };
    }
    calls.push({ nonce: attrs.nonce, id: attrs.id, name: attrs.name, arguments: args });
  }
  stripped += text.slice(last);
  if (calls.length === 0 || stripped.indexOf("<tool_call") !== -1) {
    return { text, calls: [], envelopeError: "unclosed tool_call tag" };
  }
  return { text: stripped.trim(), calls };
}

  
const BRIDGE_VERSION = "0.3.0";
const STREAM_CHANNEL = "web-llm-gateway:deepseek-stream";
const PROVIDER = "deepseek";
let ws = null;
let heartbeatTimer = null;
let tabId = null;

function log(...args) { console.log('[bridge]', ...args); }

const TOKEN_KEY = "pairingToken";

function readToken() {
  try {
    if (typeof GM_getValue === 'function') return GM_getValue(TOKEN_KEY, '') || '';
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch (e) {
    return '';
  }
}

function writeToken(value) {
  try {
    if (typeof GM_setValue === 'function') GM_setValue(TOKEN_KEY, value);
    else localStorage.setItem(TOKEN_KEY, value);
  } catch (e) {
    log('could not persist the pairing token', e);
  }
}

/** One-time pairing: the Gateway Node prints the token, the Developer User
 * pastes it here, and Tampermonkey storage keeps it across script updates. */
function promptForToken(reason) {
  const entered = window.prompt(
    reason + '\n\nRun \'bun run pair\' in the gateway repo and paste the Bridge Pairing Token:',
    readToken()
  );
  if (entered === null) return '';
  const trimmed = entered.trim();
  writeToken(trimmed);
  return trimmed;
}

/**
 * On-page status indicator. The Bridge is otherwise invisible inside the Web
 * Product tab, so pairing and connection state are only observable from the
 * console or the daemon; this surfaces both where the Developer User is
 * already looking.
 */
const STATUS_STYLE = {
  unpaired:   { color: '#9ca3af', label: 'not paired' },
  connecting: { color: '#f59e0b', label: 'connecting' },
  connected:  { color: '#22c55e', label: 'connected' },
  busy:       { color: '#3b82f6', label: 'running turn' },
  rejected:   { color: '#ef4444', label: 'token rejected' },
  offline:    { color: '#ef4444', label: 'daemon offline' }
};

let badgeEl = null;
let badgeDot = null;
let badgeText = null;
let badgeCollapsed = false;
let statusState = 'connecting';

function ensureBadge() {
  if (badgeEl || !document.body) return;
  badgeEl = document.createElement('div');
  badgeEl.setAttribute('data-web-llm-gateway', 'status');
  badgeEl.style.cssText = [
    'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
    'display:flex', 'align-items:center', 'gap:7px',
    'padding:6px 11px', 'border-radius:999px',
    'font:12px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif',
    'color:#e5e7eb', 'background:rgba(17,24,39,.88)',
    'border:1px solid rgba(255,255,255,.12)',
    'box-shadow:0 2px 10px rgba(0,0,0,.28)',
    'cursor:pointer', 'user-select:none', 'opacity:.72',
    'transition:opacity .15s ease'
  ].join(';');
  badgeEl.onmouseenter = function () { badgeEl.style.opacity = '1'; };
  badgeEl.onmouseleave = function () { badgeEl.style.opacity = '.72'; };

  badgeDot = document.createElement('span');
  badgeDot.style.cssText = 'width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:#9ca3af';

  badgeText = document.createElement('span');
  badgeText.style.cssText = 'white-space:nowrap';

  badgeEl.appendChild(badgeDot);
  badgeEl.appendChild(badgeText);
  // Unpaired or rejected, the useful action is pairing; otherwise the badge
  // just gets out of the way.
  badgeEl.onclick = function () {
    if (statusState === 'unpaired' || statusState === 'rejected') {
      if (promptForToken('Pair this Bridge with your local Gateway Node.')) {
        if (ws) { try { ws.close(); } catch (e) {} } else connect();
      }
      return;
    }
    badgeCollapsed = !badgeCollapsed;
    renderBadge();
  };
  document.body.appendChild(badgeEl);
  log('status badge attached');
}

/**
 * The Web Product is a single-page app that owns the DOM and re-renders it
 * freely, and document-idle does not guarantee a body on every site. Keep
 * re-attaching rather than assuming one successful append holds forever.
 */
function keepBadgeAttached() {
  setInterval(function () {
    try {
      if (!document.body) return;
      if (!badgeEl) { ensureBadge(); renderBadge(); return; }
      if (!document.body.contains(badgeEl)) {
        document.body.appendChild(badgeEl);
        log('status badge re-attached');
      }
    } catch (e) {
      log('badge keeper failed', e);
    }
  }, 2000);
}

function renderBadge() {
  if (!badgeEl) return;
  const style = STATUS_STYLE[statusState] || STATUS_STYLE.connecting;
  badgeDot.style.background = style.color;
  badgeText.textContent = 'Gateway: ' + style.label;
  badgeText.style.display = badgeCollapsed ? 'none' : '';
  badgeEl.style.padding = badgeCollapsed ? '7px' : '6px 11px';
}

function setStatus(state, detail) {
  statusState = state;
  try {
    ensureBadge();
  } catch (e) {
    log('status badge could not be created', e);
  }
  if (!badgeEl) return;
  const style = STATUS_STYLE[state] || STATUS_STYLE.connecting;
  badgeEl.title = 'Web LLM Gateway Bridge v' + BRIDGE_VERSION + '\n' + PROVIDER + ' -- ' + style.label +
    (detail ? '\n' + detail : '') +
    (tabId ? '\ntab ' + tabId : '') +
    '\n' + CONFIG.daemonUrl +
    (state === 'unpaired' || state === 'rejected' ? '\n\nClick to pair.' : '\n\nClick to collapse.');
  renderBadge();
}

function registerMenu() {
  if (typeof GM_registerMenuCommand !== 'function') return;
  GM_registerMenuCommand('Pair with Gateway Node...', function () {
    if (!promptForToken('Re-pair this Bridge with your local Gateway Node.')) return;
    if (ws) { try { ws.close(); } catch (e) {} }
    else connect();
  });
}

function injectPageInterceptor() {
  try {
    const target = unsafeWindow || window;
    const script = document.createElement('script');
    script.textContent = "(function () {\n    const CHANNEL = \"web-llm-gateway:deepseek-stream\";\n    const SUFFIX = \"/chat/completion\";\n    const w = window;\n    const post = function (payload) {\n      try { w.postMessage({ channel: CHANNEL, payload }, \"*\"); } catch (e) {}\n    };\n    function observeResponseBody(body, isSSE) {\n      try {\n        if (typeof body === \"string\" && isSSE) {\n          const lines = body.split(/\\r?\\n/);\n          for (const line of lines) {\n            if (line.startsWith(\"data:\")) {\n              const data = line.slice(5).trim();\n              if (data && data !== \"[DONE]\") {\n                try { post(JSON.parse(data)); } catch (e) {}\n              }\n            }\n          }\n        }\n      } catch (e) {}\n    }\n    const noteRequest = function (url) {\n      try { post({ __gatewayMeta: \"request\", url: String(url) }); } catch (e) {}\n    };\n    const origFetch = w.fetch;\n    if (origFetch) {\n      w.fetch = function (input, init) {\n        const url = typeof input === \"string\" ? input : (input && input.url) || \"\";\n        const isCompletion = url.indexOf(SUFFIX) !== -1;\n        noteRequest(url);\n        const promise = origFetch.apply(this, arguments);\n        if (isCompletion) {\n          promise.then(function (res) {\n            try {\n              res.clone().text().then(function (body) { observeResponseBody(body, true); });\n            } catch (e) {}\n          }).catch(function () {});\n        }\n        return promise;\n      };\n    }\n    const origOpen = XMLHttpRequest.prototype.open;\n    XMLHttpRequest.prototype.open = function (method, url) {\n      this.__llmIsCompletion = typeof url === \"string\" && url.indexOf(SUFFIX) !== -1;\n      noteRequest(url);\n      return origOpen.apply(this, arguments);\n    };\n    const origSend = XMLHttpRequest.prototype.send;\n    XMLHttpRequest.prototype.send = function (body) {\n      const self = this;\n      if (this.__llmIsCompletion) {\n        this.addEventListener(\"readystatechange\", function () {\n          if (self.readyState === 4 && self.status === 200) {\n            observeResponseBody(self.responseText, true);\n          }\n        });\n      }\n      return origSend.apply(this, arguments);\n    };\n  })();";
    (document.head || document.documentElement).appendChild(script);
    script.remove();
    log('page interceptor injected');
  } catch (e) {
    log('page interceptor injection failed', e);
  }
}

function connect() {
  const token = readToken() || promptForToken('This Bridge is not paired with a Gateway Node yet.');
  if (!token) {
    log('not paired -- click the status badge or use the "Pair with Gateway Node..." menu command');
    setStatus('unpaired');
    return;
  }
  setStatus('connecting');
  ws = new WebSocket(CONFIG.daemonUrl);
  ws.onopen = function () {
    log('connected');
    register(token);
  };
  ws.onmessage = function (event) {
    handleMessage(JSON.parse(event.data));
  };
  ws.onclose = function (event) {
    log('disconnected');
    clearInterval(heartbeatTimer);
    ws = null;
    // 4401 is the hub rejecting the token; a stale one must not be retried in
    // a reconnect loop, so drop it and pair again.
    if (event && event.code === 4401) {
      log('pairing token rejected -- clearing it');
      writeToken('');
      setStatus('rejected', 'the daemon refused this pairing token');
    } else {
      setStatus('offline', 'reconnecting...');
    }
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
    bridgeVersion: BRIDGE_VERSION,
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

function register(token) {
  ws.send(JSON.stringify({
    type: 'bridge.hello',
    pairingToken: token,
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
      if (!msg.accepted) {
        log('rejected: ' + (msg.warning || ''));
        setStatus('rejected', msg.warning || 'registration refused');
        return;
      }
      if (msg.warning) log('warning: ' + msg.warning);
      setStatus('connected', msg.warning || undefined);
      break;
    case 'turn.request':
      executeTurn(msg);
      break;
    default:
      break;
  }
}

function executeTurn(msg) {
  const { turnId, provider, prompt, conversationRef } = msg;
  if (provider !== PROVIDER) {
    ws.send(JSON.stringify({ type: 'turn.reject', turnId, provider, reason: 'unknown provider: ' + provider }));
    return;
  }
  if (!isDeepSeekPage()) {
    ws.send(JSON.stringify({ type: 'turn.reject', turnId, provider, reason: 'not on chat.deepseek.com' }));
    return;
  }
  // A continuation must land in the same web conversation the earlier turns
  // ran in; if the Developer User navigated the tab away, say so instead of
  // posting tool results into an unrelated conversation.
  if (conversationRef && location.href !== conversationRef) {
    ws.send(JSON.stringify({
      type: 'turn.reject',
      turnId,
      provider,
      reason: 'tab is on ' + location.href + ', not the conversation it is asked to continue (' + conversationRef + ')'
    }));
    return;
  }

  setStatus('busy');
  let finished = false;
  let timer = null;
  const deadline = Date.now() + 120000;
  // An empty answer has several very different causes; record enough to tell
  // them apart without needing the browser console.
  const diagnostics = { rawFrames: 0, answerChars: 0, requestUrls: [], composerFound: false, sendButtonFound: false };
  const assembler = createDeepSeekAssembler();

  const onFrame = function (payload) {
    if (payload && payload.__gatewayMeta === 'request') {
      if (diagnostics.requestUrls.length < 25 && diagnostics.requestUrls.indexOf(payload.url) === -1) {
        diagnostics.requestUrls.push(payload.url);
      }
      return;
    }
    diagnostics.rawFrames++;
    assembler.push(payload);
    if (assembler.done) finished = true;
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
      const { text } = assembler.result();
      diagnostics.answerChars = text.length;
      // Failing to drive the composer is a real error, not an empty answer:
      // reporting it as text would let a broken selector look like a model
      // that simply said nothing.
      let error;
      if (!diagnostics.composerFound) {
        error = { code: 'composer_not_found', message: 'no composer element matched on the page' };
      } else if (!diagnostics.sendButtonFound) {
        error = { code: 'send_button_not_found', message: 'composer was filled but no send control matched' };
      } else if (!text) {
        error = { code: 'no_stream_captured', message: 'prompt was submitted but no completion stream was captured' };
      }
      // Tool envelopes are extracted in the page (ADR-0012); the daemon
      // revalidates every call before anything reaches an Agent Client.
      let answerText = text;
      let toolCalls;
      let envelopeError;
      if (!error && text) {
        const extraction = extractToolEnvelopes(text);
        answerText = extraction.text;
        if (extraction.calls.length > 0) toolCalls = extraction.calls;
        envelopeError = extraction.envelopeError;
      }
      ws.send(JSON.stringify({
        type: 'turn.result',
        turnId,
        provider: PROVIDER,
        text: answerText || (toolCalls ? '' : '(no answer received)'),
        streamSource: 'network',
        error,
        toolCalls,
        envelopeError,
        conversationRef: location.href,
        diagnostics
      }));
      setStatus('connected');
      return;
    }
  };
  timer = setInterval(poll, 400);

  submitPrompt(prompt, diagnostics);
}

function submitPrompt(prompt, diagnostics) {
  const composer = document.querySelector("textarea");
  if (!composer) {
    log('no composer found');
    return;
  }
  diagnostics.composerFound = true;
  // React-aware value setting: DeepSeek's composer is a textarea whose React
  // state will not update from a naive value assignment.
  const proto = window.HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(composer, prompt);
  composer.dispatchEvent(new Event('input', { bubbles: true }));
  setTimeout(function () {
    const send = findSendButton();
    if (send) {
      diagnostics.sendButtonFound = true;
      send.click();
    } else {
      log('no send button found');
    }
  }, 300);
}

/**
 * Two strategies, because neither alone holds. The adapter's selector is exact
 * but tied to DeepSeek's build-hashed classes; the label scan is portable but
 * finds nothing on an icon-only control. A disabled match is rejected rather
 * than clicked: the page has not accepted the composer content yet, and
 * clicking through would silently do nothing.
 */
function findSendButton() {
  const bySelector = document.querySelector("div[role=\"button\"].ds-button--primary.ds-button--filled");
  if (bySelector && !isSendDisabled(bySelector)) return bySelector;

  const candidates = Array.from(document.querySelectorAll('button, div[role="button"]'));
  const byLabel = candidates.find(function (el) {
    const aria = el.getAttribute('aria-label') || '';
    return /send|发送|submit/i.test(aria);
  });
  if (byLabel && !isSendDisabled(byLabel)) return byLabel;
  return null;
}

function isSendDisabled(el) {
  if (el.getAttribute('aria-disabled') === 'true' || el.disabled) return true;
  return (el.className || '').toString().indexOf("ds-button--disabled") !== -1;
}

setStatus('connecting');
keepBadgeAttached();
registerMenu();
injectPageInterceptor();
connect();

})();
