// ==UserScript==
// @name         Web LLM Gateway Bridge
// @namespace    web-llm-gateway
// @version      0.7.0
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
  stopButtonSelector: 'div[role="button"].ds-button--primary.ds-button--filled',
  disabledClass: "ds-button--disabled",
  modeRadioSelector: 'div[role="radio"]',
  modeSelectedClass: "_31a22b0",
  effortToggleLabel: "深度思考",
  webSearchToggleLabel: "智能搜索"
};
function createDeepSeekAssembler() {
  let text = "";
  let reasoning = "";
  let bucket = "none";
  let done = false;
  return {
    push(payload) {
      if (payload === null || typeof payload !== "object")
        return {};
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
        return {};
      }
      if (bucket === "answer") {
        text += content;
        return { answer: content };
      }
      if (bucket === "reasoning") {
        reasoning += content;
        return { reasoning: content };
      }
      return {};
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
function readFrameProvenance(payload, into) {
  if (payload === null || typeof payload !== "object")
    return into;
  const frame = payload;
  if (typeof frame.model_type === "string")
    into.modelType = frame.model_type;
  const v = frame.v;
  if (v && typeof v === "object" && !Array.isArray(v) && "response" in v) {
    const response = v.response;
    if (response) {
      if (typeof response.conversation_mode === "string") {
        into.conversationMode = response.conversation_mode;
      }
      if (typeof response.thinking_enabled === "boolean") {
        into.thinkingEnabled = response.thinking_enabled;
      }
      if (typeof response.search_enabled === "boolean") {
        into.searchEnabled = response.search_enabled;
      }
    }
  }
  return into;
}

  
const BRIDGE_VERSION = "0.7.0";
const STREAM_CHANNEL = "web-llm-gateway:deepseek-stream";
const PROVIDER = "deepseek";
let ws = null;
let heartbeatTimer = null;
let tabId = null;
/** turnId -> finish(opts), so a cancel arriving later can end that exact turn. */
const inFlightTurns = {};

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
      announceCatalogIfChanged();
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

const CATALOG_KEY = 'modelCatalog';

/**
 * Read the model catalog off the page.
 *
 * The mode radios only exist on the new-chat screen, so this returns null
 * inside a conversation. Callers fall back to the last observation rather than
 * claiming the account has no models -- but the observation timestamp travels
 * with it so the daemon can say how old it is.
 */
function readModeCatalog() {
  try {
    const radios = Array.from(document.querySelectorAll("div[role=\"radio\"]"));
    const models = [];
    let selected;
    for (const el of radios) {
      const name = (el.innerText || '').trim();
      if (!name) continue;
      models.push(name);
      if ((el.className || '').toString().indexOf("_31a22b0") !== -1) {
        selected = name;
      }
    }
    if (models.length === 0) return null;
    return { models, selected, observedAt: Date.now() };
  } catch (e) {
    log('could not read the model catalog', e);
    return null;
  }
}

function rememberCatalog(catalog) {
  try {
    if (typeof GM_setValue === 'function') GM_setValue(CATALOG_KEY, JSON.stringify(catalog));
  } catch (e) {}
}

function recallCatalog() {
  try {
    const raw = typeof GM_getValue === 'function' ? GM_getValue(CATALOG_KEY, '') : '';
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

/** Freshly observed if the page allows it, otherwise the last thing we saw. */
function currentCatalog() {
  const fresh = readModeCatalog();
  if (fresh) {
    rememberCatalog(fresh);
    return fresh;
  }
  return recallCatalog();
}

let lastAnnouncedCatalog = '';

function announceCatalogIfChanged() {
  const fresh = readModeCatalog();
  if (!fresh) return;
  rememberCatalog(fresh);
  const key = fresh.models.join('|') + '#' + (fresh.selected || '');
  if (key === lastAnnouncedCatalog) return;
  lastAnnouncedCatalog = key;
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({
    type: 'bridge.catalog',
    provider: PROVIDER,
    models: fresh.models.map(function (name) {
      return { id: name, displayName: name, effort: ["深度思考"] };
    }),
    selectedModel: fresh.selected,
    observedAt: fresh.observedAt
  }));
  log('announced catalog: ' + fresh.models.join(', '));
}

/**
 * Make the page use the requested mode before the prompt is submitted.
 *
 * Clicking a mode radio is asynchronous -- verified live, the selected class
 * has not moved yet on the next statement and lands about a second later -- so
 * this waits for the selection to actually take rather than assuming the click
 * worked. Submitting in between would run the turn on the previous mode while
 * reporting the requested one, which is the substitution ADR-0013 forbids.
 */
function ensureModelSelected(wanted, done) {
  if (!wanted) { done(true); return; }
  const radios = Array.from(document.querySelectorAll("div[role=\"radio\"]"));
  const selectedNow = function () {
    for (const el of radios) {
      if ((el.className || '').toString().indexOf("_31a22b0") !== -1) {
        return (el.innerText || '').trim();
      }
    }
    return undefined;
  };

  if (radios.length === 0) {
    // The mode radios only exist on the new-chat screen. Inside a conversation
    // the model is fixed for its lifetime, so this cannot be honoured here.
    const catalog = recallCatalog();
    const running = catalog && catalog.selected ? catalog.selected : 'unknown';
    if (running === wanted) { done(true); return; }
    done(false, 'this conversation is running "' + running + '" and DeepSeek fixes the model when a conversation is created; start a new conversation to use "' + wanted + '"');
    return;
  }

  if (selectedNow() === wanted) { done(true); return; }
  const target = radios.find(function (el) { return (el.innerText || '').trim() === wanted; });
  if (!target) {
    done(false, 'the page offers no mode called "' + wanted + '"');
    return;
  }
  target.click();

  const deadline = Date.now() + 5000;
  const check = setInterval(function () {
    if (selectedNow() === wanted) {
      clearInterval(check);
      rememberCatalog({ models: radios.map(function (el) { return (el.innerText || '').trim(); }), selected: wanted, observedAt: Date.now() });
      done(true);
      return;
    }
    if (Date.now() > deadline) {
      clearInterval(check);
      done(false, 'clicked "' + wanted + '" but the page did not switch to it');
    }
  }, 150);
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
    script.textContent = "(function () {\n    const CHANNEL = \"web-llm-gateway:deepseek-stream\";\n    const SUFFIX = \"/chat/completion\";\n    const w = window;\n    const post = function (payload) {\n      try { w.postMessage({ channel: CHANNEL, payload }, \"*\"); } catch (e) {}\n    };\n    const emitLine = function (line) {\n      if (line.startsWith(\"data:\")) {\n        const data = line.slice(5).trim();\n        if (data && data !== \"[DONE]\") {\n          try { post(JSON.parse(data)); } catch (e) {}\n        }\n      }\n    };\n    // Incremental SSE splitter: frames are posted as the network delivers\n    // them, not after the response completes, so the daemon can stream.\n    function makeObserver() {\n      let pending = \"\";\n      return {\n        feed: function (text) {\n          try {\n            pending += text;\n            const lines = pending.split(/\\r?\\n/);\n            pending = lines.pop() || \"\";\n            for (const line of lines) emitLine(line);\n          } catch (e) {}\n        },\n        flush: function () {\n          try {\n            if (pending) emitLine(pending);\n            pending = \"\";\n          } catch (e) {}\n        }\n      };\n    }\n    const noteRequest = function (url) {\n      try { post({ __gatewayMeta: \"request\", url: String(url) }); } catch (e) {}\n    };\n    const origFetch = w.fetch;\n    if (origFetch) {\n      w.fetch = function (input, init) {\n        const url = typeof input === \"string\" ? input : (input && input.url) || \"\";\n        const isCompletion = url.indexOf(SUFFIX) !== -1;\n        noteRequest(url);\n        const promise = origFetch.apply(this, arguments);\n        if (isCompletion) {\n          promise.then(function (res) {\n            try {\n              // The page keeps the original response; the clone is ours to\n              // drain incrementally.\n              const clone = res.clone();\n              const observer = makeObserver();\n              if (!clone.body || typeof clone.body.getReader !== \"function\") {\n                clone.text().then(function (body) { observer.feed(body); observer.flush(); });\n                return;\n              }\n              const reader = clone.body.getReader();\n              const decoder = new TextDecoder();\n              const pump = function () {\n                reader.read().then(function (r) {\n                  if (r.value) observer.feed(decoder.decode(r.value, { stream: true }));\n                  if (r.done) { observer.flush(); return; }\n                  pump();\n                }).catch(function () {});\n              };\n              pump();\n            } catch (e) {}\n          }).catch(function () {});\n        }\n        return promise;\n      };\n    }\n    const origOpen = XMLHttpRequest.prototype.open;\n    XMLHttpRequest.prototype.open = function (method, url) {\n      this.__llmIsCompletion = typeof url === \"string\" && url.indexOf(SUFFIX) !== -1;\n      noteRequest(url);\n      return origOpen.apply(this, arguments);\n    };\n    const origSend = XMLHttpRequest.prototype.send;\n    XMLHttpRequest.prototype.send = function (body) {\n      const self = this;\n      if (this.__llmIsCompletion) {\n        const observer = makeObserver();\n        let seen = 0;\n        this.addEventListener(\"readystatechange\", function () {\n          if (self.readyState >= 3 && self.status === 200) {\n            const text = self.responseText || \"\";\n            if (text.length > seen) {\n              observer.feed(text.slice(seen));\n              seen = text.length;\n            }\n            if (self.readyState === 4) observer.flush();\n          }\n        });\n      }\n      return origSend.apply(this, arguments);\n    };\n  })();";
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
  // The catalog is whatever the site shows this account, never a compiled-in
  // list: the previous hardcoded deepseek-chat/deepseek-reasoner entries were
  // API names that appear nowhere in the web product.
  const catalog = currentCatalog();
  const models = (catalog && catalog.models ? catalog.models : []).map(function (name) {
    return { id: name, displayName: name, effort: ["深度思考"] };
  });
  return {
    provider: PROVIDER,
    protocolVersion: 1,
    bridgeVersion: BRIDGE_VERSION,
    modelSwitching: 'at-conversation-start',
    catalogObservedAt: catalog ? catalog.observedAt : undefined,
    selectedModel: catalog ? catalog.selected : undefined,
    models: models,
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
    case 'turn.cancel':
      cancelTurn(msg.turnId);
      break;
    default:
      break;
  }
}

function executeTurn(msg) {
  const { turnId, provider, prompt, conversationRef, model } = msg;
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
  const provenance = {};
  let modelError;

  const sendDelta = function (kind, text) {
    if (!text) return;
    try {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'turn.delta', turnId, provider: PROVIDER, delta: { kind, text } }));
      }
    } catch (e) {}
  };

  const onFrame = function (payload) {
    if (payload && payload.__gatewayMeta === 'request') {
      if (diagnostics.requestUrls.length < 25 && diagnostics.requestUrls.indexOf(payload.url) === -1) {
        diagnostics.requestUrls.push(payload.url);
      }
      return;
    }
    diagnostics.rawFrames++;
    readFrameProvenance(payload, provenance);
    const delta = assembler.push(payload);
    if (delta.reasoning) sendDelta('reasoning', delta.reasoning);
    if (delta.answer) sendDelta('text', delta.answer);
    if (assembler.done) finished = true;
  };

  window.addEventListener('message', onStreamMessage);
  function onStreamMessage(event) {
    const data = event.data;
    if (data && data.channel === STREAM_CHANNEL) {
      onFrame(data.payload);
    }
  }

  // One exit for every way a turn can end -- stream finished, deadline passed,
  // or cancelled -- so a cancelled turn reports the same shape, and the poll
  // loop and listener are always torn down exactly once.
  let settled = false;
  const finish = function (opts) {
    if (settled) return;
    settled = true;
    delete inFlightTurns[turnId];
    clearInterval(timer);
    window.removeEventListener('message', onStreamMessage);
    {
      const cancelled = !!(opts && opts.cancelled);
      const { text, reasoning } = assembler.result();
      diagnostics.answerChars = text.length;
      // Failing to drive the composer is a real error, not an empty answer:
      // reporting it as text would let a broken selector look like a model
      // that simply said nothing.
      let error;
      if (modelError) {
        error = modelError;
      } else if (cancelled) {
        // A cancelled turn is an outcome, not a failure: the partial answer is
        // returned as-is and no diagnostic error is synthesised.
      } else if (!diagnostics.composerFound) {
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
      // Partial output cannot be trusted to contain a complete tool envelope,
      // so a cancelled turn never yields tool calls.
      if (!error && !cancelled && text) {
        const extraction = extractToolEnvelopes(text);
        answerText = extraction.text;
        if (extraction.calls.length > 0) toolCalls = extraction.calls;
        envelopeError = extraction.envelopeError;
      }
      ws.send(JSON.stringify({
        type: 'turn.result',
        turnId,
        provider: PROVIDER,
        text: answerText || (toolCalls || cancelled ? '' : '(no answer received)'),
        reasoning: reasoning || undefined,
        streamSource: 'network',
        cancelled: cancelled || undefined,
        provenance: provenance,
        error,
        toolCalls,
        envelopeError,
        conversationRef: location.href,
        diagnostics
      }));
      setStatus('connected');
    }
  };

  const poll = function () {
    if (finished || Date.now() > deadline) finish({ cancelled: false });
  };
  inFlightTurns[turnId] = finish;
  timer = setInterval(poll, 400);

  // Selection first: a turn must never run on a different model than the one
  // it was asked for, so a mode that cannot be set ends the turn instead.
  ensureModelSelected(model, function (ok, reason) {
    if (!ok) {
      modelError = { code: 'model_switch_unavailable', message: reason };
      finish({ cancelled: false });
      return;
    }
    diagnostics.model = model || undefined;
    submitPrompt(prompt, diagnostics);
  });
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

/**
 * Cancel one in-flight turn: stop the Web Product generating, then settle the
 * turn locally. The stop click alone is not enough -- generation halts but the
 * completion stream emits no terminating frame, so nothing would ever end the
 * turn except its own deadline.
 */
function cancelTurn(turnId) {
  const finish = inFlightTurns[turnId];
  if (!finish) return;
  stopGeneration();
  finish({ cancelled: true });
}

function stopGeneration() {
  try {
    const stop = document.querySelector("div[role=\"button\"].ds-button--primary.ds-button--filled");
    // Disabled means the page is already idle; clicking would do nothing, and
    // on an idle composer it is the send control instead.
    if (stop && !isSendDisabled(stop)) {
      stop.click();
      log('stopped generation in the page');
    } else {
      log('nothing to stop -- the page is already idle');
    }
  } catch (e) {
    log('could not stop generation', e);
  }
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
