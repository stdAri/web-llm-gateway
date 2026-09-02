/**
 * Guards the built Bridge userscript itself, which no other test covers: it is
 * generated as a string, installed by hand, and fails silently in Tampermonkey.
 * An earlier artifact shipped with a duplicate `const CONFIG` and could not be
 * parsed at all, while every unit test stayed green.
 *
 * The stub DOM here is deliberately small — just enough to run the artifact and
 * drive the pairing/connection state machine the way the daemon would.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BRIDGE_CONFIG_DEFAULT, buildUserscript } from "../src/bridge/bridge";

const fixture = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "..", "fixtures", "deepseek", "completion-stream.json"),
    "utf8",
  ),
) as { expected: { text: string }; frames: unknown[] };

const UPDATE_URL = "https://example.invalid/bridge.user.js";
const artifact = buildUserscript(BRIDGE_CONFIG_DEFAULT, {
  version: "0.0.0-test",
  updateUrl: UPDATE_URL,
});

interface StubEl {
  style: Record<string, string>;
  children: StubEl[];
  attrs: Record<string, string>;
  title: string;
  textContent: string;
  onclick?: () => void;
  setAttribute(k: string, v: string): void;
  appendChild(c: StubEl): StubEl;
  remove(): void;
  addEventListener(): void;
  querySelector(): null;
  querySelectorAll(): never[];
}

interface StubSocket {
  url: string;
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: (e: { code: number }) => void;
  sent: string[];
}

/** Runs the artifact against a stub DOM and returns handles into it. */
function runArtifact(
  opts: {
    storedToken?: string;
    promptAnswer?: string | null;
    sendButtonLabel?: string | null;
    /** Mimics DeepSeek: an icon-only control with no aria-label. */
    sendButtonClass?: string;
  } = {},
) {
  const created: StubEl[] = [];
  const makeEl = (): StubEl => {
    const el: StubEl = {
      style: {},
      children: [],
      attrs: {},
      title: "",
      textContent: "",
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      appendChild(c) {
        this.children.push(c);
        return c;
      },
      remove() {},
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    return el;
  };

  const body = makeEl();
  const head = makeEl();
  const composer = { ...makeEl(), dispatchEvent: () => true, value: "" };
  const sockets: StubSocket[] = [];
  const intervals: { fn: () => void; ms: number; id: number; cleared: boolean }[] = [];
  const timeouts: { fn: () => void; ms: number }[] = [];
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const clicked: string[] = [];
  const sendButton =
    opts.sendButtonLabel === null && opts.sendButtonClass === undefined
      ? null
      : {
          className: opts.sendButtonClass ?? "",
          getAttribute: () => opts.sendButtonLabel ?? null,
          click: () => clicked.push("send"),
        };
  // Only a control carrying DeepSeek's classes answers the adapter selector.
  const selectorMatches = opts.sendButtonClass !== undefined;
  const menu: { label: string; fn: () => void }[] = [];
  const store: Record<string, string> = { pairingToken: opts.storedToken ?? "" };
  let promptCount = 0;

  const scope: Record<string, unknown> = {
    document: {
      body,
      head,
      documentElement: head,
      createElement: () => {
        const e = makeEl();
        created.push(e);
        return e;
      },
      querySelector: (sel: string) => {
        if (sel === "textarea") return composer;
        if (sel.includes("ds-button--primary")) return selectorMatches ? sendButton : null;
        return null;
      },
      querySelectorAll: () => (sendButton && opts.sendButtonLabel ? [sendButton] : []),
      addEventListener() {},
    },
    Event: class {
      constructor(public type: string) {}
    },
    WebSocket: class {
      url: string;
      sent: string[] = [];
      constructor(url: string) {
        this.url = url;
        sockets.push(this as unknown as StubSocket);
      }
      send(data: string) {
        this.sent.push(data);
      }
      close() {}
    },
    GM_getValue: (k: string, d: string) => store[k] ?? d,
    GM_setValue: (k: string, v: string) => {
      store[k] = v;
    },
    GM_registerMenuCommand: (label: string, fn: () => void) => menu.push({ label, fn }),
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { host: "chat.deepseek.com", href: "https://chat.deepseek.com/" },
    prompt: () => {
      promptCount += 1;
      return opts.promptAnswer === undefined ? "bp_from_prompt" : opts.promptAnswer;
    },
    unsafeWindow: undefined,
    HTMLTextAreaElement: composerClass(),
    setInterval: (fn: () => void, ms: number) => {
      intervals.push({ fn, ms, id: intervals.length + 1, cleared: false });
      return intervals.length;
    },
    clearInterval: (id: number) => {
      const slot = intervals[id - 1];
      if (slot) slot.cleared = true;
    },
    setTimeout: (fn: () => void, ms: number) => {
      timeouts.push({ fn, ms });
      return timeouts.length;
    },
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
    console: { log: () => {} },
  };
  scope.window = scope;

  const keys = Object.keys(scope);
  new Function(...keys, artifact)(...keys.map((k) => scope[k]));

  const badge = created.find((e) => e.attrs["data-web-llm-gateway"] === "status");
  return {
    badge,
    label: () => badge?.children[1]?.textContent,
    dot: () => badge?.children[0]?.style.background,
    body,
    sockets,
    menu,
    store,
    promptCount: () => promptCount,
    intervals,
    clicked,
    /** The Bridge defers the send click; nothing clicks it in a stub browser. */
    flushTimeouts: () => {
      const pending = timeouts.splice(0);
      for (const t of pending) t.fn();
    },
    emitStreamFrame: (payload: unknown) => {
      for (const fn of listeners.message ?? []) {
        fn({ data: { channel: "web-llm-gateway:deepseek-stream", payload } });
      }
    },
    sent: () => (sockets[0]?.sent ?? []).map((s) => JSON.parse(s) as Record<string, unknown>),
  };
}

/** A textarea stand-in whose prototype carries a real `value` setter, which is
 * what the Bridge reaches for to drive React's controlled composer. */
function composerClass() {
  class StubTextArea {
    set value(_v: string) {}
    get value() {
      return "";
    }
  }
  return StubTextArea;
}

describe("bridge userscript artifact", () => {
  test("parses as JavaScript", () => {
    // The failure this guards against is a duplicate top-level binding, which
    // only surfaces when the whole artifact is parsed as one unit.
    expect(() => new Function(artifact)).not.toThrow();
  });

  test("carries no pairing token, so it is safe to publish at @updateURL", () => {
    expect(artifact).not.toMatch(/bp_[0-9a-f]{8}/);
    expect(artifact).not.toContain("PAIRING_TOKEN");
    expect(artifact).toContain("@updateURL");
  });

  test("grants the storage APIs runtime pairing depends on", () => {
    for (const grant of ["GM_getValue", "GM_setValue", "GM_registerMenuCommand"]) {
      expect(artifact).toContain(`// @grant        ${grant}`);
    }
  });

  test("shows a status badge and offers a pairing menu command", () => {
    const h = runArtifact({ storedToken: "bp_stored" });
    expect(h.badge).toBeDefined();
    expect(h.body.children).toContain(h.badge!);
    expect(h.menu.map((m) => m.label)).toEqual(["Pair with Gateway Node..."]);
  });

  test("prompts once when unpaired and persists what is entered", () => {
    const h = runArtifact({ storedToken: "" });
    expect(h.promptCount()).toBe(1);
    expect(h.store.pairingToken).toBe("bp_from_prompt");
    expect(h.sockets).toHaveLength(1);
  });

  test("reports being unpaired instead of connecting when pairing is declined", () => {
    const h = runArtifact({ storedToken: "", promptAnswer: null });
    expect(h.sockets).toHaveLength(0);
    expect(h.label()).toBe("Gateway: not paired");
  });

  test("tracks the connection through the daemon handshake", () => {
    const h = runArtifact({ storedToken: "bp_stored" });
    expect(h.label()).toBe("Gateway: connecting");

    h.sockets[0]!.onopen!();
    h.sockets[0]!.onmessage!({
      data: JSON.stringify({ type: "bridge.hello_ack", accepted: true }),
    });
    expect(h.label()).toBe("Gateway: connected");
    expect(h.dot()).toBe("#22c55e");
  });

  test("surfaces a rejected token and clears it so the next load re-pairs", () => {
    const h = runArtifact({ storedToken: "bp_stale" });
    h.sockets[0]!.onclose!({ code: 4401 });
    expect(h.label()).toBe("Gateway: token rejected");
    expect(h.store.pairingToken).toBe("");
  });

  test("distinguishes a dropped daemon from a rejected token", () => {
    const h = runArtifact({ storedToken: "bp_stored" });
    h.sockets[0]!.onclose!({ code: 1006 });
    expect(h.label()).toBe("Gateway: daemon offline");
    expect(h.store.pairingToken).toBe("bp_stored");
  });
});

describe("bridge userscript artifact — executing a turn", () => {
  /** Brings a Bridge up to the point where the daemon has dispatched a turn. */
  function openTurn(opts: { sendButtonLabel?: string | null } = {}) {
    const h = runArtifact({ storedToken: "bp_stored", sendButtonLabel: "Send message", ...opts });
    h.sockets[0]!.onopen!();
    h.sockets[0]!.onmessage!({
      data: JSON.stringify({ type: "bridge.hello_ack", accepted: true }),
    });
    h.sockets[0]!.onmessage!({
      data: JSON.stringify({
        type: "turn.request",
        turnId: "t_test",
        provider: "deepseek",
        prompt: "hello",
      }),
    });
    return h;
  }

  test("every adapter symbol the runtime calls is defined in the artifact", () => {
    // A userscript has no module loader, so an artifact that merely references
    // an imported symbol parses fine and then throws ReferenceError mid-turn.
    // Definitions, not mentions, are what matter here.
    expect(artifact).toContain("function createDeepSeekAssembler");
    expect(artifact).toContain("function contentBlock");
    expect(artifact).toContain("function isFinished");
    expect(artifact).toContain("const DEEPSEEK = {");
  });

  test("shows the turn as running", () => {
    const h = openTurn();
    expect(h.label()).toBe("Gateway: running turn");
  });

  test("parses real recorded frames and returns the assembled answer", () => {
    const h = openTurn();
    h.flushTimeouts();
    expect(h.clicked).toEqual(["send"]);
    for (const frame of fixture.frames) h.emitStreamFrame(frame);

    // The stream is complete; the poll loop is what publishes the result.
    const poll = h.intervals.find((i) => i.ms === 400)!;
    poll.fn();

    const result = h.sent().find((m) => m.type === "turn.result");
    expect(result).toBeDefined();
    expect(result!.turnId).toBe("t_test");
    expect(result!.provider).toBe("deepseek");
    expect(result!.text).toBe(fixture.expected.text);
    expect(result!.streamSource).toBe("network");
    expect(poll.cleared).toBe(true);
  });

  test("returns to connected once the turn is published", () => {
    const h = openTurn();
    h.flushTimeouts();
    for (const frame of fixture.frames) h.emitStreamFrame(frame);
    h.intervals.find((i) => i.ms === 400)!.fn();
    expect(h.label()).toBe("Gateway: connected");
  });

  test("still answers the daemon when no frames are captured at all", () => {
    // Otherwise the caller hangs until the daemon's turn timeout, which is how
    // the missing-parser bug presented: a turn that never came back.
    const h = openTurn();
    h.flushTimeouts();
    const poll = h.intervals.find((i) => i.ms === 400)!;
    const realNow = Date.now;
    Date.now = () => realNow() + 200_000; // past the Bridge's own deadline
    try {
      poll.fn();
    } finally {
      Date.now = realNow;
    }
    const result = h.sent().find((m) => m.type === "turn.result");
    expect(result).toBeDefined();
    expect(result!.text).toBe("(no answer received)");
  });

  test("rejects a turn for a provider it does not serve", () => {
    const h = runArtifact({ storedToken: "bp_stored" });
    h.sockets[0]!.onopen!();
    h.sockets[0]!.onmessage!({
      data: JSON.stringify({
        type: "turn.request",
        turnId: "t_x",
        provider: "chatgpt",
        prompt: "hi",
      }),
    });
    const reject = h.sent().find((m) => m.type === "turn.reject");
    expect(reject).toBeDefined();
    expect(reject!.turnId).toBe("t_x");
  });
});

describe("bridge userscript artifact — diagnosing an empty answer", () => {
  /** Runs a turn to completion and returns the published turn.result. */
  function turnResult(opts: { sendButtonLabel?: string | null } = {}) {
    const h = runArtifact({ storedToken: "bp_stored", sendButtonLabel: "Send message", ...opts });
    h.sockets[0]!.onopen!();
    h.sockets[0]!.onmessage!({
      data: JSON.stringify({
        type: "turn.request",
        turnId: "t_diag",
        provider: "deepseek",
        prompt: "hello",
      }),
    });
    h.flushTimeouts();
    const realNow = Date.now;
    Date.now = () => realNow() + 200_000;
    try {
      h.intervals.find((i) => i.ms === 400)!.fn();
    } finally {
      Date.now = realNow;
    }
    return { h, result: h.sent().find((m) => m.type === "turn.result")! };
  }

  test("reports a missing send control rather than an empty answer", () => {
    // A broken selector must not look like a model that said nothing — the two
    // have completely different fixes.
    const { result } = turnResult({ sendButtonLabel: null });
    expect((result.error as { code: string }).code).toBe("send_button_not_found");
  });

  test("distinguishes a submitted prompt that captured no stream", () => {
    const { result } = turnResult();
    expect((result.error as { code: string }).code).toBe("no_stream_captured");
  });

  test("reports which requests the page interceptor actually saw", () => {
    // The completion endpoint is matched by URL suffix; if DeepSeek moves it,
    // the observed URLs are what makes that visible.
    const h = runArtifact({ storedToken: "bp_stored" });
    h.sockets[0]!.onopen!();
    h.sockets[0]!.onmessage!({
      data: JSON.stringify({
        type: "turn.request",
        turnId: "t_urls",
        provider: "deepseek",
        prompt: "hello",
      }),
    });
    h.emitStreamFrame({ __gatewayMeta: "request", url: "https://chat.deepseek.com/api/v0/chat/completion" });
    h.emitStreamFrame({ __gatewayMeta: "request", url: "https://chat.deepseek.com/api/v0/chat/completion" });
    h.flushTimeouts();
    const realNow = Date.now;
    Date.now = () => realNow() + 200_000;
    try {
      h.intervals.find((i) => i.ms === 400)!.fn();
    } finally {
      Date.now = realNow;
    }
    const result = h.sent().find((m) => m.type === "turn.result")!;
    const diag = result.diagnostics as { requestUrls: string[]; rawFrames: number };
    expect(diag.requestUrls).toEqual(["https://chat.deepseek.com/api/v0/chat/completion"]);
    // Meta frames are bookkeeping, not stream content.
    expect(diag.rawFrames).toBe(0);
  });
});

describe("bridge userscript artifact — finding DeepSeek's send control", () => {
  function runTurn(opts: { sendButtonLabel?: string | null; sendButtonClass?: string }) {
    const h = runArtifact({ storedToken: "bp_stored", ...opts });
    h.sockets[0]!.onopen!();
    h.sockets[0]!.onmessage!({
      data: JSON.stringify({
        type: "turn.request",
        turnId: "t_send",
        provider: "deepseek",
        prompt: "hello",
      }),
    });
    h.flushTimeouts();
    const realNow = Date.now;
    Date.now = () => realNow() + 200_000;
    try {
      h.intervals.find((i) => i.ms === 400)!.fn();
    } finally {
      Date.now = realNow;
    }
    return { h, result: h.sent().find((m) => m.type === "turn.result")! };
  }

  test("clicks an icon-only control that carries no aria-label", () => {
    // This is DeepSeek's actual shape, and the reason label matching found
    // nothing among 117 candidates on the live page.
    const { h, result } = runTurn({
      sendButtonLabel: null,
      sendButtonClass: "ds-button ds-button--primary ds-button--filled ds-button--circle",
    });
    expect(h.clicked).toEqual(["send"]);
    expect((result.diagnostics as { sendButtonFound: boolean }).sendButtonFound).toBe(true);
  });

  test("refuses a send control the page has disabled", () => {
    // Clicking a disabled control does nothing, which would look identical to
    // a submitted prompt that produced no stream.
    const { h, result } = runTurn({
      sendButtonLabel: null,
      sendButtonClass: "ds-button ds-button--primary ds-button--filled ds-button--disabled",
    });
    expect(h.clicked).toEqual([]);
    expect((result.error as { code: string }).code).toBe("send_button_not_found");
  });

  test("still honours an aria-label when a provider offers one", () => {
    const { h } = runTurn({ sendButtonLabel: "Send message" });
    expect(h.clicked).toEqual(["send"]);
  });
});
