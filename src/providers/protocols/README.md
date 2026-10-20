# Provider protocol core

This module converts byte-fragmented server-sent events into protocol results and encodes text history into concrete request bodies. It has no fetch client, endpoint selection, credential handling, model fallback, generation retry, or chess-move parser. The local entry point is index.ts.

## Decoder contract

Create one decoder per response stream. Pass each received Uint8Array to push(), pass the real response status as metadata when creating the decoder, call abort() when the caller fences the stream, and call finish() after reading ends.

The decoder copies each input chunk. Its raw result keeps those chunks in receive order and keeps each SSE event's original bytes, event name, data lines, parsed JSON payload, and parse failure. An unterminated final event remains visible with frameTerminated false, but the decoder does not normalize it. Unknown fields remain in the parsed payload and exact raw bytes.

terminal describes whether the stream supplied a usable complete answer:

| Value | Meaning |
| --- | --- |
| complete | Normal protocol termination with text or an explicit refusal. |
| incomplete | The protocol ended, but the content was truncated, unsupported, empty, or tool-interrupted. |
| failed | The stream contained a protocol error. |
| truncated | The response ended before its required terminal sequence. |
| malformed | The stream violated the protocol shape or carried invalid UTF-8/JSON. |
| aborted | The caller fenced the decoder. Late bytes are captured raw and never normalized. |

content identifies normalized content separately as answer, refusal, tool-only, tool-interrupted, or empty. Callers must require terminal complete and inspect content before using answerText. These decoders never validate chess moves or authorize a game transition.

Chat Completions accepts data-only SSE `message` frames with choice-zero deltas. Named event types are not part of this adapter's wire contract, so it retains them as unknown events without parsing their data as JSON or normalizing their payloads. Invalid UTF-8 in a terminated frame makes the stream malformed; an unterminated final frame remains raw and does not change the truncated terminal state. It requires finish_reason stop followed by a framed [DONE] sentinel for a complete answer. Choice-zero output after its finish reason makes the stream malformed. length, content_filter, tool_calls, and function_call do not produce complete answers. Other choices remain in otherChoices and raw events.

Content-free terminal or usage chunks can repeat the finish reason with empty/null text and assistant-role metadata. OpenRouter [documents this final usage chunk](https://openrouter.ai/docs/api/reference/streaming#the-final-usage-chunk-chat-completions), which repeats `stop` before `[DONE]`. Usage chunks with no new finish reason also preserve the preceding finish. These chunks retain usage and raw bytes without appending content. Actual answer, reasoning or tool output after finishing, conflicting finish reasons, and data after `[DONE]` remain malformed. Chat validation failures include structural `validationIssues` with zero-based raw event indices and rejection reasons.

Responses accepts documented event names such as `response.output_text.delta` and `response.completed`. A known named event must carry the matching JSON `type`; a missing or mismatched type makes the stream malformed. An unknown named event remains raw and does not interrupt decoding. Data-only SSE `message` frames continue to route by their JSON `type`. The decoder selects the first final message item for `answerText`, keeps reasoning items and analysis-phase messages separate, and retains additional message items. `ProtocolStreamMetadata.responsesSchema` selects the response object contract. It defaults to `openai`, which matches the native OpenAI preset; the OpenRouter alternative must pass `openrouter-r12` explicitly.

The native OpenAI contract follows the official [Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create). Its response requires `access_programs`, `id`, `created_at`, `error`, `incomplete_details`, `instructions`, `metadata`, `model`, `object`, `output`, `parallel_tool_calls`, `temperature`, `tool_choice`, `tools`, and `top_p`. The stream contract also requires `status` to agree with its terminal event. `instructions` and `metadata` are required in this schema. `completed_at` is optional and nullable, and the schema has no `frequency_penalty` or `presence_penalty` fields. The decoder checks `completed_at` when present and rejects a non-null timestamp on failed or incomplete responses.

The OpenRouter contract follows the pinned R12 schema in `research/provider-stream-reference.md`. Its required nullable fields include `completed_at`, `frequency_penalty`, and `presence_penalty`; those keys must be present even when their values are null. This contract does not require the native-only `access_programs` field. The R12 requirements apply only when the caller selects `openrouter-r12`. On R12 `response.output_text.delta` and `.done` events, `sequence_number` must be a non-negative safe integer and `logprobs` must be an array of entries with string `token` and numeric `logprob`. R12 `error` events require `type: "error"`, `code`, `message`, `param`, and `sequence_number`; `code` and `param` may be null. Missing or wrongly shaped required fields make the event malformed. Optional `bytes` fields must be integer arrays; optional `top_logprobs` fields must be arrays whose entries have valid optional `token`, `logprob`, and `bytes` fields. Unknown extension fields remain in raw events. These event checks do not apply to the native OpenAI schema. For either response schema, optional envelope fields may be absent and unknown extension fields remain in the raw event. Completion, failure, and incomplete status fields must agree. A framed terminal event must carry a non-negative integer `sequence_number`. For streamed answer text, each content index's accumulated deltas must match its done text and final message part, and each streamed part must have a done event. Mismatched item IDs or text make the response malformed. The selected assistant message must also have status completed. `response.output_text.done`, `[DONE]`, EOF, and undocumented aliases do not complete a response.

Anthropic Messages requires `message_start`, a `message_delta` with a recognized stop reason, and `message_stop`. The JSON `type` must match each documented named SSE event; a missing or mismatched type on a known event makes the stream malformed. Unknown event names remain raw and do not interrupt decoding. Every started content block must stop before the first `message_delta`; later content-block events make the stream malformed. Cumulative `message_delta` usage updates the normalized summary without discarding fields omitted from that event. `end_turn` and `stop_sequence` can complete text; refusal remains a separate content state. `max_tokens`, `model_context_window_exceeded`, `pause_turn`, `tool_use`, unsupported blocks, and usage-only responses do not complete an answer. No tool is executed.

The optional httpStatus is copied from caller-supplied response metadata. A stream error served over HTTP 200 remains a stream failure with status 200; the decoder does not invent an HTTP status. An abort fences local normalization but cannot promise upstream cancellation or billing cessation.

## Request encoders

ProtocolHistory carries current instructions separately from ordered user/assistant text records. Each record has a local ID. Encoders return the IDs beside the body; provider wire formats do not receive invented message-ID fields. Every supplied record is included in order. Historical records cannot become a system instruction because their role type excludes system.

Each encoder receives the exact model ID, a positive output-token limit, and optional temperature/top-p values as data. Chat uses messages, max_completion_tokens, streaming usage, and store false. Responses uses explicit input history, max_output_tokens, truncation disabled, and store false. Messages uses system plus messages and max_tokens. All set streaming and declare no tools. Responses never uses previous_response_id.

The encoders return bodies only. Authentication headers, Anthropic version and browser headers, final URLs, custom endpoint controls, OpenRouter context-compression controls, organization eligibility, and ZDR restrictions belong to the connection/transport layer. No native or live acceptance follows from these fixtures.
