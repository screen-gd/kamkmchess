import { describe, expect, it } from 'vitest';
import {
  createChatCompletionsDecoder,
  encodeChatCompletionsRequest,
} from './index';

describe('Chat Completions protocol decoder', () => {
  it('[MOV-03, HIS-05] reassembles fragmented UTF-8, CRLF, and multiline SSE data while retaining raw input', () => {
    const fixture =
      'data: {"choices":\r\n' +
      'data: [{"index":0,"delta":{"content":"café","reasoning":"checking"},"finish_reason":null}],"ignored":"kept"}\r\n\r\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"provider_note":"kept"}}\r\n\r\n' +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\r\n\r\n' +
      'data: [DONE]\r\n\r\n';
    const bytes = new TextEncoder().encode(fixture);
    const decoder = createChatCompletionsDecoder();

    for (let offset = 0; offset < bytes.length; offset += 1) {
      decoder.push(bytes.slice(offset, offset + 1));
    }

    const result = decoder.finish();

    expect(result.terminal).toBe('complete');
    expect(result.answerText).toBe('café');
    expect(result.reasoningText).toBe('checking');
    expect(result.usage).toMatchObject({
      prompt_tokens: 3,
      completion_tokens: 1,
      provider_note: 'kept',
    });
    expect(result.raw.events).toHaveLength(4);
    expect(result.raw.events[0]?.payload).toMatchObject({ ignored: 'kept' });
    expect(result.raw.events[1]?.payload).toMatchObject({
      usage: { provider_note: 'kept' },
    });
    expect(result.raw.chunks.flatMap((chunk) => Array.from(chunk))).toEqual(Array.from(bytes));
  });

  it('[MOV-03] requires choice-zero stop and the DONE sentinel for a normal completion', () => {
    const doneOnly = decodeChat('[DONE]');
    const stopOnly = decodeChat(
      chatChunk({ index: 0, delta: { content: 'e2e4' }, finish_reason: 'stop' }),
    );
    const complete = decodeChat(
      chatChunk({ index: 0, delta: { content: 'e2e4' }, finish_reason: 'stop' }),
      '[DONE]',
    );

    expect(doneOnly.terminal).toBe('truncated');
    expect(doneOnly.answerText).toBe('');
    expect(stopOnly.terminal).toBe('truncated');
    expect(stopOnly.answerText).toBe('e2e4');
    expect(complete.terminal).toBe('complete');
    expect(complete.content).toBe('answer');
  });

  it('[MOV-03, HIS-05] does not normalize a DONE sentinel without its terminating SSE frame', () => {
    const stop = frame(
      chatChunk({ index: 0, delta: { content: 'e2e4' }, finish_reason: 'stop' }),
    );
    const decoder = createChatCompletionsDecoder();
    decoder.push(new TextEncoder().encode(stop + 'data: [DONE]'));

    const result = decoder.finish();

    expect(result.terminal).toBe('truncated');
    expect(result.answerText).toBe('e2e4');
    expect(result.raw.events.at(-1)?.frameTerminated).toBe(false);
  });

  it('[MOV-03, HIS-05] rejects invalid UTF-8 frames and retains their exact bytes', () => {
    const stop = new TextEncoder().encode(
      frame(chatChunk({ index: 0, delta: { content: 'e2e4' }, finish_reason: 'stop' })),
    );
    const invalid = joinBytes(
      new TextEncoder().encode('data: '),
      Uint8Array.from([0xc3, 0x28]),
      new TextEncoder().encode('\n\n'),
    );
    const done = new TextEncoder().encode(frame('[DONE]'));
    const bytes = joinBytes(stop, invalid, done);
    const decoder = createChatCompletionsDecoder();
    decoder.push(bytes);

    const result = decoder.finish();

    expect(result.terminal).toBe('malformed');
    expect(result.answerText).toBe('e2e4');
    expect(result.raw.events[1]?.parseError).toBe('SSE line contains invalid UTF-8.');
    expect(result.validationIssues).toContainEqual({ eventIndex: 1, reason: 'invalid-event-json-or-utf8' });
    expect(Array.from(result.raw.events[1]?.rawBytes ?? [])).toEqual(
      Array.from(invalid),
    );
    expect(result.raw.chunks.flatMap((chunk) => Array.from(chunk))).toEqual(
      Array.from(bytes),
    );
  });

  it('[MOV-03, HIS-05] keeps an EOF-truncated UTF-8 frame raw and reports truncation', () => {
    const stop = new TextEncoder().encode(
      frame(chatChunk({ index: 0, delta: { content: 'e2e4' }, finish_reason: 'stop' })),
    );
    const incomplete = joinBytes(
      new TextEncoder().encode('data: '),
      Uint8Array.from([0xc3]),
    );
    const bytes = joinBytes(stop, incomplete);
    const decoder = createChatCompletionsDecoder();
    decoder.push(bytes);

    const result = decoder.finish();

    expect(result.terminal).toBe('truncated');
    expect(result.answerText).toBe('e2e4');
    expect(result.raw.events.at(-1)?.frameTerminated).toBe(false);
    expect(result.raw.events.at(-1)?.parseError).toBe('SSE line contains invalid UTF-8.');
    expect(Array.from(result.raw.events.at(-1)?.rawBytes ?? [])).toEqual(
      Array.from(incomplete),
    );
    expect(result.raw.chunks.flatMap((chunk) => Array.from(chunk))).toEqual(
      Array.from(bytes),
    );
  });

  it('[MOV-03] keeps length and content-filter finishes incomplete, and needs DONE to terminate', () => {
    const length = decodeChat(
      chatChunk({ index: 0, delta: { content: 'partial' }, finish_reason: 'length' }),
      '[DONE]',
    );
    const filtered = decodeChat(
      chatChunk({ index: 0, delta: { content: 'filtered' }, finish_reason: 'content_filter' }),
      '[DONE]',
    );
    const lengthWithoutDone = decodeChat(
      chatChunk({ index: 0, delta: {}, finish_reason: 'length' }),
    );

    expect(length.terminal).toBe('incomplete');
    expect(length.incompleteDetails).toContainEqual({ reason: 'length' });
    expect(filtered.terminal).toBe('incomplete');
    expect(filtered.incompleteDetails).toContainEqual({ reason: 'content_filter' });
    expect(lengthWithoutDone.terminal).toBe('truncated');
  });

  it('[MOV-03] keeps usage-only chunks and nonzero choices separate from answer text', () => {
    const result = decodeChat(
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 8, completion_tokens: 0, vendor_usage: 'kept' },
      }),
      JSON.stringify({
        choices: [
          {
            index: 1,
            delta: { content: 'other choice', reasoning: 'other reasoning' },
            finish_reason: 'stop',
          },
        ],
      }),
      '[DONE]',
    );

    expect(result.terminal).toBe('truncated');
    expect(result.content).toBe('empty');
    expect(result.answerText).toBe('');
    expect(result.usage).toMatchObject({ vendor_usage: 'kept' });
    expect(result.otherChoices).toHaveLength(1);
    expect(result.raw.events[1]?.payload).toMatchObject({
      choices: [
        {
          index: 1,
          delta: { content: 'other choice', reasoning: 'other reasoning' },
        },
      ],
    });
    expect(result.reasoningText).toBe('');
  });

  it('[MOV-03] does not report a usage-only stream as a completed answer', () => {
    const result = decodeChat(
      JSON.stringify({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 0 } }),
      chatChunk({ index: 0, delta: {}, finish_reason: 'stop' }),
      '[DONE]',
    );

    expect(result.terminal).toBe('incomplete');
    expect(result.content).toBe('empty');
    expect(result.answerText).toBe('');
    expect(result.usage).toMatchObject({ prompt_tokens: 8 });
  });

  it('[CON-05, MOV-03] fails on an in-stream error before or after partial text', () => {
    const beforeText = decodeChat(JSON.stringify({ error: { code: 'overloaded', message: 'busy' } }));
    const afterTextDecoder = createChatCompletionsDecoder({ httpStatus: 200 });
    afterTextDecoder.push(
      new TextEncoder().encode(
        frame(chatChunk({ index: 0, delta: { content: 'partial' }, finish_reason: null })) +
          frame(JSON.stringify({ error: { code: 'rate_limit', message: 'slow down' } })),
      ),
    );
    const afterText = afterTextDecoder.finish();

    expect(beforeText.terminal).toBe('failed');
    expect(afterText.terminal).toBe('failed');
    expect(afterText.httpStatus).toBe(200);
    expect(afterText.answerText).toBe('partial');
    expect(afterText.errors).toContainEqual({ code: 'rate_limit', message: 'slow down' });
  });

  it('[MOV-03, MOV-09] preserves refusal and tool output without treating tool calls as complete answers', () => {
    const refusal = decodeChat(
      chatChunk({
        index: 0,
        delta: { refusal: 'I cannot choose a move.' },
        finish_reason: 'stop',
      }),
      '[DONE]',
    );
    const toolOnly = decodeChat(
      chatChunk({
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'tool-1',
              function: { name: 'unexpected', arguments: '{}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      }),
      '[DONE]',
    );

    expect(refusal.terminal).toBe('complete');
    expect(refusal.content).toBe('refusal');
    expect(refusal.refusalText).toBe('I cannot choose a move.');
    expect(toolOnly.terminal).toBe('incomplete');
    expect(toolOnly.content).toBe('tool-only');
    expect(toolOnly.answerText).toBe('');
    expect(toolOnly.toolRecords).toHaveLength(1);
  });

  it('[MOV-03, HIS-05] keeps a duplicate stop chunk idempotent and preserves both raw events', () => {
    const stop = chatChunk({
      index: 0,
      delta: {},
      finish_reason: 'stop',
    });
    const result = decodeChat(
      chatChunk({
        index: 0,
        delta: { content: 'e2e4' },
        finish_reason: null,
      }),
      stop,
      stop,
      '[DONE]',
    );

    expect(result.terminal).toBe('complete');
    expect(result.answerText).toBe('e2e4');
    expect(result.raw.events).toHaveLength(4);
  });

  it.each([{}, { content: '' }, { content: null, reasoning: '', reasoning_details: [] }, { content: '', role: 'assistant' }])('[MOV-03] accepts an empty usage trailer after stop: %j', delta => {
    const trailer = JSON.stringify({
      choices: [{ index: 0, delta, finish_reason: null }],
      usage: { prompt_tokens: 40, completion_tokens: 20 },
    });
    const result = decodeChat(
      chatChunk({ index: 0, delta: { content: '{"move":"e2e4"}' }, finish_reason: 'stop' }),
      trailer,
      '[DONE]',
    );
    expect(result.terminal).toBe('complete');
    expect(result.answerText).toBe('{"move":"e2e4"}');
    expect(result.usage).toMatchObject({ completion_tokens: 20 });
    expect(result.raw.events[1]?.data).toBe(trailer);
  });

  it('[MOV-03] accepts OpenRouter documented repeated stop and assistant-role usage trailer', () => {
    const terminal = { index: 0, delta: { content: '', role: 'assistant' }, finish_reason: 'stop', native_finish_reason: 'stop' };
    const result = decodeChat(
      chatChunk({ index: 0, delta: { content: 'e2e4' }, finish_reason: null }),
      chatChunk(terminal),
      JSON.stringify({ choices: [terminal], usage: { completion_tokens: 20 } }),
      '[DONE]',
    );
    expect(result.terminal).toBe('complete');
    expect(result.answerText).toBe('e2e4');
    expect(result.usage).toEqual({ completion_tokens: 20 });
  });

  it.each([
    { delta: { content: 'late' }, finish_reason: 'stop' },
    { delta: { reasoning: 'late reasoning' }, finish_reason: 'stop' },
    { delta: { tool_calls: [{ id: 'late-tool' }] }, finish_reason: 'stop' },
    { delta: { content: '' }, finish_reason: 'length' },
  ])('[MOV-03] rejects output or conflicting finish reasons in a usage trailer: %j', choice => {
    const result = decodeChat(
      chatChunk({ index: 0, delta: { content: 'e2e4' }, finish_reason: 'stop' }),
      JSON.stringify({ choices: [{ index: 0, ...choice }], usage: { completion_tokens: 20 } }),
      '[DONE]',
    );
    expect(result.terminal).toBe('malformed');
    expect(result.answerText).toBe('e2e4');
    expect(result.reasoningText).toBe('');
    expect(result.validationIssues).toContainEqual({ eventIndex: 1, reason: choice.finish_reason === 'length' ? 'conflicting-finish-reason' : 'choice-output-after-finish' });
  });

  it('[MOV-03] does not normalize choice-zero output after its finish reason', () => {
    const result = decodeChat(
      chatChunk({ index: 0, delta: { content: 'e2e4' }, finish_reason: 'stop' }),
      chatChunk({ index: 0, delta: { content: 'late' }, finish_reason: null }),
      '[DONE]',
    );

    expect(result.terminal).toBe('malformed');
    expect(result.answerText).toBe('e2e4');
    expect(result.raw.events.at(-2)?.payload).toMatchObject({
      choices: [{ delta: { content: 'late' } }],
    });
  });

  it('[MOV-03] still rejects a usage trailer after DONE', () => {
    const result = decodeChat(
      chatChunk({ index: 0, delta: { content: 'e2e4' }, finish_reason: 'stop' }),
      '[DONE]',
      JSON.stringify({ choices: [{ index: 0, delta: { content: '', role: 'assistant' }, finish_reason: 'stop' }], usage: { completion_tokens: 20 } }),
    );
    expect(result.terminal).toBe('malformed');
    expect(result.validationIssues).toContainEqual({ eventIndex: 2, reason: 'data-after-done' });
  });

  it('[MOV-07, HIS-05] keeps an aborted stream fenced while retaining late raw bytes', () => {
    const decoder = createChatCompletionsDecoder();
    const partial = chatChunk({
      index: 0,
      delta: { content: 'partial' },
      finish_reason: null,
    });
    const late = chatChunk({
      index: 0,
      delta: { content: 'late' },
      finish_reason: 'stop',
    });
    decoder.push(new TextEncoder().encode(frame(partial)));
    decoder.abort();
    decoder.push(new TextEncoder().encode(frame(late) + frame('[DONE]')));
    const result = decoder.finish();

    expect(result.terminal).toBe('aborted');
    expect(result.answerText).toBe('partial');
    expect(result.raw.events).toHaveLength(3);
    expect(result.raw.events[1]?.payload).toMatchObject({
      choices: [{ delta: { content: 'late' } }],
    });
  });

  it('[HIS-01, MOV-09] encodes every supplied history record without tools or response handles', () => {
    const request = encodeChatCompletionsRequest(
      {
        instructions: 'Choose a move.',
        records: [
          { id: 'one', role: 'user', text: 'Position A' },
          { id: 'two', role: 'assistant', text: 'Plan A' },
          { id: 'three', role: 'assistant', text: 'e2e4' },
        ],
      },
      { model: 'exact-model-id', maxOutputTokens: 256 },
    );

    expect(request.sourceRecordIds).toEqual(['one', 'two', 'three']);
    expect(request.body).toMatchObject({
      model: 'exact-model-id',
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 256,
      store: false,
      messages: [
        { role: 'system', content: 'Choose a move.' },
        { role: 'user', content: 'Position A' },
        { role: 'assistant', content: 'Plan A' },
        { role: 'assistant', content: 'e2e4' },
      ],
    });
    expect(request.body).not.toHaveProperty('tools');
    expect(request.body).not.toHaveProperty('previous_response_id');
  });

  it('[CST-01] keeps OpenAI prompt caching and OpenRouter session affinity on separate routes', () => {
    const history = { instructions: 'Rules', records: [] };
    const config = { model: 'selected-model', maxOutputTokens: 20 };

    const openAi = encodeChatCompletionsRequest(history, {
      ...config,
      cache: { promptCacheKey: 'cache-key', promptCacheRetention: '24h' },
    });
    const openRouter = encodeChatCompletionsRequest(history, {
      ...config,
      cache: { openRouterSessionId: 'session-id' },
    });

    expect(openAi.body).toMatchObject({
      prompt_cache_key: 'cache-key',
      prompt_cache_retention: '24h',
    });
    expect(openAi.body).not.toHaveProperty('session_id');
    expect(openRouter.body).toHaveProperty('session_id', 'session-id');
    expect(openRouter.body).not.toHaveProperty('prompt_cache_key');
    expect(() => encodeChatCompletionsRequest(history, {
      ...config,
      cache: { promptCacheKey: 'cache-key', openRouterSessionId: 'session-id' },
    })).toThrow(/cannot be combined/);
    expect(() => encodeChatCompletionsRequest(history, {
      ...config,
      cache: { promptCacheRetention: '24h', openRouterSessionId: 'session-id' },
    })).toThrow(/cannot be combined/);
  });
});

function decodeChat(...data: string[]) {
  const decoder = createChatCompletionsDecoder();
  decoder.push(new TextEncoder().encode(data.map(frame).join('')));
  return decoder.finish();
}

function frame(data: string): string {
  return 'data: ' + data + '\n\n';
}

function joinBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

function chatChunk(choice: Record<string, unknown>): string {
  return JSON.stringify({ choices: [choice] });
}
