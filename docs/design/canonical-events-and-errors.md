# Canonical Events and Errors

> Status: **provisionally adopted**. Build against this shape; revise it as implementation
> and live-provider feedback arrive. It is deliberately not an ADR, because it is expected
> to change with evidence rather than to be defended as a settled trade-off.

The Canonical Core defines one event stream and one error taxonomy. Responses and
Messages adapters translate outward; Web Provider Adapters emit inward. Neither side
invents its own vocabulary.

## Events

```ts
type CanonicalEvent =
  | { type: "turn.started"; turnId: string; provider: string; model: string
      effort?: string; streamSource: "network" | "frontend-state" | "dom-diff" | "buffered" }
  | { type: "reasoning.delta"; text: string }
  | { type: "reasoning.done" }
  | { type: "text.delta"; text: string }
  | { type: "text.done" }
  | { type: "tool_call.started"; callId: string; name: string }
  | { type: "tool_call.arguments.delta"; callId: string; delta: string }
  | { type: "tool_call.done"; callId: string; arguments: unknown }
  | { type: "citation"; url: string; title?: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; estimated: boolean }
  | { type: "turn.completed"; stopReason: "end_turn" | "tool_use" | "cancelled" | "max_output" }
  | { type: "turn.failed"; error: CanonicalError }
```

Design points worth keeping:

- **`streamSource` is first-class.** A Web Product read through intercepted network
  frames is not the same fidelity as one reconstructed from DOM mutations or replayed
  after completion. Clients and the Control Panel should be able to tell which they got,
  so buffered replay is never silently presented as native streaming.
- **`usage.estimated` is almost always `true`.** Web Products do not report token
  accounting; anything reported is inferred and must say so.
- **Argument deltas are optional.** Some Web Products emit a complete tool envelope in
  one chunk. Adapters may go straight from `tool_call.started` to `tool_call.done`, and
  protocol adapters synthesize whatever intermediate deltas their wire format requires.
- **Reasoning is separated from text**, since several Web Products expose thinking
  blocks distinctly and clients render them differently.

### Mapping sketch

| Canonical | Anthropic Messages | OpenAI Responses |
|---|---|---|
| `turn.started` | `message_start` | `response.created` |
| `text.delta` | `content_block_delta` (text_delta) | `response.output_text.delta` |
| `reasoning.delta` | `content_block_delta` (thinking) | reasoning item delta |
| `tool_call.started` | `content_block_start` (tool_use) | `response.output_item.added` |
| `tool_call.arguments.delta` | `content_block_delta` (input_json_delta) | `response.function_call_arguments.delta` |
| `tool_call.done` | `content_block_stop` | `response.output_item.done` |
| `turn.completed` | `message_delta` + `message_stop` | `response.completed` |
| `turn.failed` | `error` event | `response.failed` |

## Errors

```ts
interface CanonicalError {
  code: CanonicalErrorCode
  message: string          // human-facing, redacted
  provider?: string
  retryable: boolean
  userActionRequired: boolean
  diagnosticId?: string    // correlates to a redacted diagnostic record
}
```

| Code | Cause | Retryable | User action |
|---|---|---|---|
| `auth_required` | Web Product session expired or logged out | no | re-login in the browser |
| `auth_challenge` | Captcha, verification, or risk-control interception | no | human attention; provider pauses |
| `provider_unavailable` | No live registered tab for that provider | no | open/enable a tab |
| `provider_busy` | Queue timeout waiting for a free tab | yes | open another tab or retry |
| `model_unavailable` | Requested model or effort not offered to this account | no | pick from the returned list |
| `tab_lost` | Leased tab discarded, closed, or heartbeat lost mid-turn | yes | usually retried internally |
| `adapter_drift` | Submission or parsing failed in a way that suggests the site changed | no | adapter fix; surfaces diagnostics |
| `turn_timeout` | Generation exceeded `turn_timeout_ms` | sometimes | raise timeout for slow models |
| `tool_protocol_error` | Tool envelope malformed, unknown tool, or nonce mismatch | limited internal retry | none |
| `upstream_refused` | Web Product declined to answer | no | none; surfaced as a normal stop |
| `cancelled` | Client disconnected or cancelled | — | none |

`adapter_drift` is deliberately distinct from generic failure: it is the signal that a
Provider Adapter needs updating, and it is what makes fixture regeneration and support
tier downgrades actionable rather than guesswork.
