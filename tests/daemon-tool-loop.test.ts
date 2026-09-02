import { afterEach, describe, expect, test } from "bun:test";
import { BridgeHub } from "../src/daemon/bridge-hub";
import { GatewayHTTPServer } from "../src/daemon/http-server";
import { ToolLoop, validateAgainstSchema } from "../src/daemon/tool-loop";
import { BRIDGE_PROTOCOL_VERSION, type BridgeMessage } from "../src/shared/bridge-protocol";
import type { ProviderRegistration } from "../src/shared/canonical";

const PAIRING_TOKEN = "bp_testtoken123";
const GATEWAY_KEY = "gw_testkey123";
const DEEPSEEK_PROVIDER = "deepseek";

function registration(provider = DEEPSEEK_PROVIDER): ProviderRegistration {
  return {
    provider,
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

type TurnRequest = Extract<BridgeMessage, { type: "turn.request" }>;
type Responder = (req: TurnRequest) => {
  text: string;
  toolCalls?: { nonce?: string; id?: string; name?: string; arguments?: unknown }[];
  envelopeError?: string;
};

/**
 * A fake Bridge whose per-turn behavior is scripted. `responder` sees each
 * turn.request (including the prompt, which carries the nonce the daemon
 * expects) and decides what the "page" answered.
 */
function connectScriptedBridge(wsUrl: string, provider: string, responder: Responder) {
  const ws = new WebSocket(wsUrl);
  const requests: TurnRequest[] = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.type !== "turn.request") return;
    requests.push(msg);
    const out = responder(msg);
    ws.send(JSON.stringify({
      type: "turn.result",
      turnId: msg.turnId,
      provider,
      text: out.text,
      streamSource: "network",
      toolCalls: out.toolCalls,
      envelopeError: out.envelopeError,
      conversationRef: `https://chat.deepseek.com/a/chat/s/conv-for-${msg.turnId}`,
    }));
  };
  return new Promise<{ ws: WebSocket; requests: TurnRequest[] }>((resolve, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "bridge.hello", pairingToken: PAIRING_TOKEN, registration: registration(provider) }));
      ws.send(JSON.stringify({ type: "tab.registered", tabId: "tab_1", provider, url: "https://chat.deepseek.com/" }));
      resolve({ ws, requests });
    };
    ws.onerror = () => reject(new Error("ws error"));
  });
}

const servers: GatewayHTTPServer[] = [];

async function startServer(): Promise<{ hub: BridgeHub; port: number }> {
  const hub = new BridgeHub(PAIRING_TOKEN);
  const server = new GatewayHTTPServer({ hub, port: 0, turnTimeoutMs: 5000, gatewayApiKey: GATEWAY_KEY });
  servers.push(server);
  await server.start();
  return { hub, port: server.port! };
}

afterEach(() => {
  while (servers.length > 0) servers.pop()!.stop();
});

const TOOLS = [
  {
    name: "list_files",
    description: "list files in a directory",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "read a file's contents",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

function toolTaskRequest(overrides: Record<string, unknown> = {}) {
  return {
    model: "deepseek/deepseek-chat",
    max_tokens: 8000,
    messages: [{ role: "user", content: "Which react version does package.json declare?" }],
    tools: TOOLS,
    ...overrides,
  };
}

function postMessages(port: number, body: unknown) {
  return fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${GATEWAY_KEY}`,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
}

/** The nonce the daemon embedded in a submission prompt. */
function nonceFrom(prompt: string): string {
  const m = prompt.match(/nonce="([0-9a-f]+)"/);
  if (!m) throw new Error("no nonce found in prompt");
  return m[1]!;
}

function envelope(nonce: string, id: string, name: string, args: unknown) {
  return { nonce, id, name, arguments: args };
}

async function jsonBody(res: Response) {
  return (await res.json()) as {
    stop_reason: string;
    content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
    error?: { type: string; message: string };
  };
}

describe("tool definitions are encoded into the envelope setup prompt", () => {
  test("the Bridge submission carries the tool list, schema, and nonce rules", async () => {
    const { port } = await startServer();
    const bridge = await connectScriptedBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, () => ({ text: "done" }));

    const res = await postMessages(port, toolTaskRequest());
    expect(res.status).toBe(200);

    const prompt = bridge.requests[0]!.prompt;
    expect(prompt).toContain("<tool_call nonce=\"");
    expect(prompt).toContain("list_files");
    expect(prompt).toContain("read_file");
    expect(prompt).toContain('"path"');
    expect(prompt).toContain("Copy the nonce");
    expect(prompt).toContain("Never invent a tool");
    // The actual task rides after the setup block.
    expect(prompt).toContain("Which react version does package.json declare?");
    bridge.ws.close();
  });

  test("capability reports tools as prompt-emulated, never native", async () => {
    const { port } = await startServer();
    const bridge = await connectScriptedBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, () => ({ text: "x" }));
    const res = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.json()) as {
      providers: { tools?: string }[];
    };
    expect(res.providers[0]!.tools).toBe("prompt-emulated");
    bridge.ws.close();
  });
});

describe("an emitted envelope becomes a native tool_use", () => {
  test("prose plus one envelope yields stop_reason tool_use with a rewritten id", async () => {
    const { port } = await startServer();
    const bridge = await connectScriptedBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, (req) => {
      const nonce = nonceFrom(req.prompt);
      return {
        text: "Let me look at the project first.",
        toolCalls: [envelope(nonce, "call_1", "list_files", { path: "." })],
      };
    });

    const res = await postMessages(port, toolTaskRequest());
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.stop_reason).toBe("tool_use");
    const toolUse = body.content.find((b) => b.type === "tool_use")!;
    expect(toolUse.name).toBe("list_files");
    expect(toolUse.input).toEqual({ path: "." });
    // The model's call_1 never reaches the client; the daemon rewrites ids.
    expect(toolUse.id).toMatch(/^toolu_/);
    const prose = body.content.find((b) => b.type === "text");
    expect(prose?.text).toContain("Let me look at the project first");
    bridge.ws.close();
  });

  test("the result is fed back into the same conversation, paired to the model's own id", async () => {
    const { port } = await startServer();
    let round = 0;
    const bridge = await connectScriptedBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, (req) => {
      round++;
      const nonce = nonceFrom(req.prompt);
      if (round === 1) {
        return { text: "", toolCalls: [envelope(nonce, "call_1", "read_file", { path: "package.json" })] };
      }
      return { text: "react is declared as ^18.3.1" };
    });

    const first = await postMessages(port, toolTaskRequest());
    const firstBody = await jsonBody(first);
    const toolUse = firstBody.content.find((b) => b.type === "tool_use")!;

    const second = await postMessages(port, {
      ...toolTaskRequest(),
      messages: [
        { role: "user", content: "Which react version does package.json declare?" },
        { role: "assistant", content: [{ type: "tool_use", id: toolUse.id, name: "read_file", input: { path: "package.json" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: '{"dependencies":{"react":"^18.3.1"}}' }] },
      ],
    });
    expect(second.status).toBe(200);
    const secondBody = await jsonBody(second);
    expect(secondBody.stop_reason).toBe("end_turn");
    expect(secondBody.content[0]!.text).toContain("^18.3.1");

    // The continuation was submitted into the same conversation, with the
    // result labelled by the model's own call id, and the nonce rotated.
    const continuation = bridge.requests[1]!;
    expect(continuation.conversationId).toBe(bridge.requests[0]!.conversationId);
    expect(continuation.prompt).toContain('<tool_result id="call_1">');
    expect(continuation.prompt).toContain('"react":"^18.3.1"');
    expect(nonceFrom(continuation.prompt)).not.toBe(nonceFrom(bridge.requests[0]!.prompt));
    bridge.ws.close();
  });

  test("a trailing system-reminder message after tool_result still routes the continuation", async () => {
    const { port } = await startServer();
    let round = 0;
    const bridge = await connectScriptedBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, (req) => {
      round++;
      const nonce = nonceFrom(req.prompt);
      if (round === 1) {
        return { text: "", toolCalls: [envelope(nonce, "call_1", "read_file", { path: "package.json" })] };
      }
      return { text: "react is declared as ^18.3.1" };
    });

    const first = await postMessages(port, toolTaskRequest());
    const firstBody = await jsonBody(first);
    const toolUse = firstBody.content.find((b) => b.type === "tool_use")!;

    // Claude Code appends role:"system" reminder messages after the
    // tool_result user message; the continuation must still be recognised.
    const second = await postMessages(port, {
      ...toolTaskRequest(),
      messages: [
        { role: "user", content: "Which react version does package.json declare?" },
        { role: "assistant", content: [{ type: "tool_use", id: toolUse.id, name: "read_file", input: { path: "package.json" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: '{"dependencies":{"react":"^18.3.1"}}' }] },
        { role: "system", content: "Reminder: answer concisely." },
      ],
    });
    expect(second.status).toBe(200);
    const secondBody = await jsonBody(second);
    expect(secondBody.stop_reason).toBe("end_turn");

    const continuation = bridge.requests[1]!;
    expect(continuation.conversationId).toBe(bridge.requests[0]!.conversationId);
    expect(continuation.prompt).toContain('<tool_result id="call_1">');
    expect(continuation.prompt).toContain("Reminder: answer concisely.");
    bridge.ws.close();
  });

  test("a task needing several rounds completes", async () => {
    const { port } = await startServer();
    const bridge = await connectScriptedBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, (req) => {
      const nonce = nonceFrom(req.prompt);
      if (req.prompt.includes("tool_result")) {
        if (req.prompt.includes("dependencies")) {
          return { text: "react is ^18.3.1" };
        }
        return { text: "", toolCalls: [envelope(nonce, "call_2", "read_file", { path: "package.json" })] };
      }
      return { text: "", toolCalls: [envelope(nonce, "call_1", "list_files", { path: "." })] };
    });

    // Round 1: list_files
    const r1 = await postMessages(port, toolTaskRequest());
    const b1 = await jsonBody(r1);
    const call1 = b1.content.find((b) => b.type === "tool_use")!;
    expect(call1.name).toBe("list_files");

    // Round 2: result → read_file call
    const r2 = await postMessages(port, {
      ...toolTaskRequest(),
      messages: [
        { role: "user", content: "Which react version does package.json declare?" },
        { role: "assistant", content: [{ type: "tool_use", id: call1.id, name: call1.name, input: call1.input }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: call1.id, content: "package.json\nsrc/" }] },
      ],
    });
    const b2 = await jsonBody(r2);
    const call2 = b2.content.find((b) => b.type === "tool_use")!;
    expect(call2.name).toBe("read_file");
    expect(call2.id).not.toBe(call1.id);

    // Round 3: result → final answer
    const r3 = await postMessages(port, {
      ...toolTaskRequest(),
      messages: [
        { role: "user", content: "Which react version does package.json declare?" },
        { role: "assistant", content: [{ type: "tool_use", id: call2.id, name: call2.name, input: call2.input }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: call2.id, content: '{"dependencies":{"react":"^18.3.1"}}' }] },
      ],
    });
    const b3 = await jsonBody(r3);
    expect(b3.stop_reason).toBe("end_turn");
    expect(b3.content[0]!.text).toContain("^18.3.1");
    expect(bridge.requests.length).toBe(3);
    bridge.ws.close();
  });
});

describe("daemon-side validation (ADR-0012: never trust the page)", () => {
  test("a call naming a tool the request did not offer is nudged, never forwarded", async () => {
    const { port } = await startServer();
    let round = 0;
    const bridge = await connectScriptedBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, (req) => {
      round++;
      const nonce = nonceFrom(req.prompt);
      if (round === 1) return { text: "", toolCalls: [envelope(nonce, "call_1", "send_email", { to: "team" })] };
      return { text: "", toolCalls: [envelope(nonce, "call_1", "list_files", { path: "." })] };
    });

    const res = await postMessages(port, toolTaskRequest());
    const body = await jsonBody(res);
    // The client only ever sees the valid, offered tool.
    const toolUse = body.content.find((b) => b.type === "tool_use")!;
    expect(toolUse.name).toBe("list_files");
    // Round 2 was the nudge: it names the valid tools and rotates the nonce.
    expect(bridge.requests[1]!.prompt).toContain('no tool named "send_email"');
    expect(nonceFrom(bridge.requests[1]!.prompt)).not.toBe(nonceFrom(bridge.requests[0]!.prompt));
    bridge.ws.close();
  });

  test("schema-invalid arguments earn one nudge, then the turn fails", async () => {
    const { port } = await startServer();
    const bridge = await connectScriptedBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, (req) => {
      const nonce = nonceFrom(req.prompt);
      return { text: "", toolCalls: [envelope(nonce, "call_1", "list_files", { wrong: true })] };
    });

    const res = await postMessages(port, toolTaskRequest());
    expect(res.status).toBe(500);
    const body = await res.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe("api_error");
    expect(body.error.message).toContain("nudge");
    // The nudge round carried the validation problem back to the model.
    expect(bridge.requests[1]!.prompt).toContain("arguments.path is required");
    expect(bridge.requests.length).toBe(2);
    bridge.ws.close();
  });

  test("a wrong nonce is rejected outright — no nudge", async () => {
    const { port } = await startServer();
    const bridge = await connectScriptedBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, () => ({
      text: "",
      toolCalls: [envelope("00000000", "evil", "list_files", { path: "." })],
    }));

    const res = await postMessages(port, toolTaskRequest());
    expect(res.status).toBe(500);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain("nonce");
    expect(bridge.requests.length).toBe(1);
    bridge.ws.close();
  });

  test("a missing nonce is rejected outright", async () => {
    const { port } = await startServer();
    const bridge = await connectScriptedBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, () => ({
      text: "",
      toolCalls: [{ id: "call_1", name: "list_files", arguments: { path: "." } }],
    }));

    const res = await postMessages(port, toolTaskRequest());
    expect(res.status).toBe(500);
    bridge.ws.close();
  });

  test("fresh conversations reusing call_1 stay distinct across tasks", async () => {
    const { port } = await startServer();
    const bridge = await connectScriptedBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, (req) => {
      const nonce = nonceFrom(req.prompt);
      if (req.prompt.includes("task A")) {
        return { text: "", toolCalls: [envelope(nonce, "call_1", "list_files", { path: "a" })] };
      }
      return { text: "", toolCalls: [envelope(nonce, "call_1", "read_file", { path: "b" })] };
    });

    const a = await jsonBody(await postMessages(port, toolTaskRequest({
      messages: [{ role: "user", content: "task A" }],
    })));
    const b = await jsonBody(await postMessages(port, toolTaskRequest({
      messages: [{ role: "user", content: "task B" }],
    })));
    const callA = a.content.find((x) => x.type === "tool_use")!;
    const callB = b.content.find((x) => x.type === "tool_use")!;
    expect(callA.id).not.toBe(callB.id);
    // The two tasks ran in separate web conversations.
    expect(bridge.requests[0]!.conversationId).not.toBe(bridge.requests[1]!.conversationId);
    bridge.ws.close();
  });

  test("a tool_result for an unknown tool_use id fails explicitly", async () => {
    const { port } = await startServer();
    const bridge = await connectScriptedBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, () => ({ text: "x" }));
    const res = await postMessages(port, toolTaskRequest({
      messages: [
        { role: "user", content: "hi" },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_nonexistent", content: "data" }] },
      ],
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("no live web conversation");
    bridge.ws.close();
  });
});

describe("dead turns and malformed envelopes", () => {
  test("a malformed envelope gets one nudge round and recovers", async () => {
    const { port } = await startServer();
    let round = 0;
    const bridge = await connectScriptedBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, (req) => {
      round++;
      const nonce = nonceFrom(req.prompt);
      if (round === 1) return { text: "<tool_call nonce=\"x\">{bad json", envelopeError: "malformed JSON in tool_call body" };
      return { text: "", toolCalls: [envelope(nonce, "call_1", "list_files", { path: "." })] };
    });

    const res = await postMessages(port, toolTaskRequest());
    const body = await jsonBody(res);
    expect(body.stop_reason).toBe("tool_use");
    expect(bridge.requests[1]!.prompt).toContain("could not be parsed");
    bridge.ws.close();
  });

  test("an empty answer is nudged once rather than stalling the task", async () => {
    const { port } = await startServer();
    let round = 0;
    const bridge = await connectScriptedBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, () => {
      round++;
      if (round === 1) return { text: "" };
      return { text: "the answer" };
    });

    const res = await postMessages(port, toolTaskRequest());
    const body = await jsonBody(res);
    expect(body.stop_reason).toBe("end_turn");
    expect(body.content[0]!.text).toBe("the answer");
    expect(bridge.requests.length).toBe(2);
    bridge.ws.close();
  });
});

describe("streaming with tool calls", () => {
  test("stream:true emits a tool_use content block with input_json_delta", async () => {
    const { port } = await startServer();
    const bridge = await connectScriptedBridge(`ws://127.0.0.1:${port}/bridge`, DEEPSEEK_PROVIDER, (req) => ({
      text: "",
      toolCalls: [envelope(nonceFrom(req.prompt), "call_1", "list_files", { path: "." })],
    }));

    const res = await postMessages(port, toolTaskRequest({ stream: true }));
    expect(res.status).toBe(200);
    const text = await res.text();
    const events = text.split("\n\n").filter(Boolean).map((frame) => {
      const [eventLine, dataLine] = frame.split("\n");
      return { event: eventLine!.replace("event: ", ""), data: JSON.parse(dataLine!.replace("data: ", "")) };
    });
    const start = events.find((e) => e.event === "content_block_start");
    expect(start?.data.content_block.type).toBe("tool_use");
    const delta = events.find((e) => e.event === "content_block_delta");
    expect(delta?.data.delta.type).toBe("input_json_delta");
    expect(JSON.parse(delta?.data.delta.partial_json)).toEqual({ path: "." });
    const messageDelta = events.find((e) => e.event === "message_delta");
    expect(messageDelta?.data.delta.stop_reason).toBe("tool_use");
    bridge.ws.close();
  });
});

describe("validateAgainstSchema", () => {
  const schema = {
    type: "object",
    properties: {
      path: { type: "string" },
      depth: { type: "integer" },
      flags: { type: "array", items: { type: "string" } },
    },
    required: ["path"],
    additionalProperties: false,
  };

  test("accepts valid values", () => {
    expect(validateAgainstSchema({ path: ".", depth: 2, flags: ["a"] }, schema, "arguments")).toBeNull();
  });
  test("rejects missing required, wrong types, and unknown keys", () => {
    expect(validateAgainstSchema({}, schema, "arguments")).toContain("path is required");
    expect(validateAgainstSchema({ path: 1 }, schema, "arguments")).toContain("must be a string");
    expect(validateAgainstSchema({ path: ".", extra: 1 }, schema, "arguments")).toContain("not an allowed property");
    expect(validateAgainstSchema({ path: ".", flags: [1] }, schema, "arguments")).toContain("flags[0]");
  });
});

describe("ToolLoop internals", () => {
  test("every continuation rotates the nonce", () => {
    const loop = new ToolLoop();
    const conv = loop.begin("deepseek", [{ name: "t", inputSchema: { type: "object" } }]);
    const first = conv.nonce;
    const setup = loop.buildSetupPrompt(conv, "do the thing");
    expect(setup).toContain(`nonce="${first}"`);

    // Simulate one validated call, then feed its result.
    const assessed = loop.assess(conv, {
      text: "",
      toolCalls: [{ nonce: first, id: "call_1", name: "t", arguments: {} }],
    });
    if (assessed.kind !== "calls") throw new Error("expected calls");
    const msg = loop.buildResultMessage(conv, [{ toolUseId: assessed.calls[0]!.id, content: "ok" }]);
    expect(msg).toContain('<tool_result id="call_1">');
    expect(conv.nonce).not.toBe(first);
    expect(msg).toContain(`nonce="${conv.nonce}"`);
  });
});
