import {
  createProtocolState,
  createSseProtocolDecoder,
  type ProtocolDecoderState,
} from './decoder-base';
import { validateGenerationConfig } from './request-config';
import type {
  ProtocolGenerationConfig,
  ProtocolHistory,
  ProtocolStreamDecoder,
  EncodedProtocolRequest,
  ProtocolRawEvent,
  ProtocolStreamMetadata,
} from './types';

interface ChatState extends ProtocolDecoderState {
  doneSeen: boolean;
  finishReason: string | undefined;
  failed: boolean;
  eventIndex: number;
}

export function createChatCompletionsDecoder(
  metadata?: ProtocolStreamMetadata,
): ProtocolStreamDecoder {
  const state: ChatState = {
    ...createProtocolState(),
    doneSeen: false,
    finishReason: undefined,
    failed: false,
    eventIndex: -1,
  };

  return createSseProtocolDecoder(
    'chat-completions',
    state,
    consumeChatEvent,
    finalizeChat,
    metadata,
    (event) => event.event === 'message',
  );
}

export function encodeChatCompletionsRequest(
  history: ProtocolHistory,
  config: ProtocolGenerationConfig,
): EncodedProtocolRequest {
  validateGenerationConfig(config);
  if (
    config.cache?.openRouterSessionId !== undefined &&
    (config.cache.promptCacheKey !== undefined ||
      config.cache.promptCacheRetention !== undefined)
  ) {
    throw new TypeError(
      'OpenRouter session affinity cannot be combined with OpenAI prompt-cache options.',
    );
  }
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: history.instructions },
    ...history.records.map((record) => ({
      role: record.role,
      content: record.text,
    })),
  ];
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: config.maxOutputTokens,
    store: false,
  };
  if (config.temperature !== undefined) {
    body.temperature = config.temperature;
  }
  if (config.topP !== undefined) {
    body.top_p = config.topP;
  }
  if (config.cache?.promptCacheKey !== undefined) {
    body.prompt_cache_key = config.cache.promptCacheKey;
  }
  if (config.cache?.promptCacheRetention !== undefined) {
    body.prompt_cache_retention = config.cache.promptCacheRetention;
  }
  if (config.cache?.openRouterSessionId !== undefined) {
    body.session_id = config.cache.openRouterSessionId;
  }

  return {
    body,
    sourceRecordIds: history.records.map((record) => record.id),
  };
}

function consumeChatEvent(
  event: ProtocolRawEvent,
  base: ProtocolDecoderState,
): void {
  const state = base as ChatState;
  state.eventIndex += 1;

  if (event.parseError !== undefined) {
    markMalformed(state, 'invalid-event-json-or-utf8');
    return;
  }
  if (state.doneSeen && event.data.length > 0) {
    markMalformed(state, 'data-after-done');
    return;
  }
  if (event.event !== 'message') {
    state.unknownEvents.push(event);
    return;
  }
  if (event.data === '[DONE]') {
    state.doneSeen = true;
    return;
  }
  if (event.data.length === 0) {
    return;
  }

  if (!isRecord(event.payload)) {
    markMalformed(state, 'invalid-payload');
    return;
  }

  const payload = event.payload;
  if (payload.error !== undefined && payload.error !== null) {
    state.errors.push(payload.error);
    state.failed = true;
  }
  if (payload.usage !== undefined) {
    state.usage = payload.usage;
    state.usageRecords.push(payload.usage);
  }

  if (payload.choices === undefined) {
    if (payload.error === undefined && payload.usage === undefined) {
      state.unknownEvents.push(event);
    }
    return;
  }
  if (!Array.isArray(payload.choices)) {
    markMalformed(state, 'invalid-choices');
    return;
  }

  for (const rawChoice of payload.choices) {
    if (
      !isRecord(rawChoice) ||
      !Number.isInteger(rawChoice.index) ||
      (rawChoice.index as number) < 0
    ) {
      markMalformed(state, 'invalid-choice-index');
      continue;
    }
    const index = rawChoice.index as number;
    if (index !== 0) {
      state.otherChoices.push({ index, choice: rawChoice });
      continue;
    }

    const delta = isRecord(rawChoice.delta)
      ? rawChoice.delta
      : isRecord(rawChoice.message)
        ? rawChoice.message
        : {};
    const finishReason = rawChoice.finish_reason;
    if (state.finishReason !== undefined) {
      // OpenRouter repeats the finish reason with empty content and role metadata
      // in its final usage chunk. This is accounting, not additional output.
      const usageOnlyFinish = (finishReason === null || finishReason === undefined) && isRecord(payload.usage);
      if (finishReason !== state.finishReason && !usageOnlyFinish) markMalformed(state, 'conflicting-finish-reason');
      if (!isContentFreeDelta(delta)) markMalformed(state, 'choice-output-after-finish');
      continue;
    }

    if (
      delta.content !== undefined &&
      delta.content !== null &&
      typeof delta.content !== 'string'
    ) {
      markMalformed(state, 'invalid-content');
    }
    appendString(state, 'answerText', delta.content);
    appendString(state, 'reasoningText', delta.reasoning);
    appendString(state, 'reasoningText', delta.reasoning_content);
    appendString(state, 'reasoningText', delta.analysis);
    appendString(state, 'planText', delta.plan);
    appendString(state, 'refusalText', delta.refusal);

    if (delta.tool_calls !== undefined) {
      state.toolRecords.push({ index, calls: delta.tool_calls });
    }
    if (delta.function_call !== undefined) {
      state.toolRecords.push({ index, call: delta.function_call });
    }

    if (typeof finishReason === 'string') {
      state.finishReason = finishReason;
      if (!['stop', 'tool_calls', 'function_call', 'length', 'content_filter'].includes(finishReason)) markMalformed(state, 'unsupported-finish-reason');
    } else if (finishReason !== undefined && finishReason !== null) {
      markMalformed(state, 'invalid-finish-reason');
    }
  }
}

function finalizeChat(state: ProtocolDecoderState): void {
  const chat = state as ChatState;

  if (chat.failed) {
    chat.terminal = 'failed';
  } else if (chat.malformed) {
    chat.terminal = 'malformed';
  } else if (
    chat.finishReason === 'length' ||
    chat.finishReason === 'content_filter'
  ) {
    chat.terminal = chat.doneSeen ? 'incomplete' : 'truncated';
    chat.incompleteDetails.push({ reason: chat.finishReason });
  } else if (
    chat.finishReason === 'tool_calls' ||
    chat.finishReason === 'function_call'
  ) {
    chat.terminal = chat.doneSeen ? 'incomplete' : 'truncated';
    chat.incompleteDetails.push({ reason: chat.finishReason });
  } else if (
    chat.doneSeen && chat.finishReason === 'stop'
  ) {
    if (chat.toolRecords.length > 0) {
      chat.terminal = 'incomplete';
      chat.incompleteDetails.push({ reason: 'tool_interruption' });
    } else if (
      chat.answerText.length === 0 &&
      chat.refusalText.length === 0
    ) {
      chat.terminal = 'incomplete';
      chat.incompleteDetails.push({ reason: 'empty_answer' });
    } else {
      chat.terminal = 'complete';
    }
  } else if (
    chat.finishReason !== undefined &&
    !['stop', 'tool_calls', 'function_call', 'length', 'content_filter'].includes(
      chat.finishReason,
    )
  ) {
    chat.terminal = 'malformed';
  } else {
    chat.terminal = 'truncated';
  }

  classifyContent(chat);
}

function markMalformed(state: ChatState, reason: string): void {
  state.malformed = true;
  state.validationIssues.push({ eventIndex: state.eventIndex, reason });
}

function isContentFreeDelta(delta: Record<string, unknown>): boolean {
  return Object.entries(delta).every(([key, value]) => {
    if (key === 'role') return value === 'assistant';
    if (['content', 'reasoning', 'reasoning_content', 'analysis', 'plan', 'refusal'].includes(key)) return value === null || value === '';
    if (key === 'tool_calls' || key === 'reasoning_details') return value === null || (Array.isArray(value) && value.length === 0);
    return false;
  });
}

function classifyContent(state: ProtocolDecoderState): void {
  if (state.refusalText.length > 0) {
    state.content = 'refusal';
  } else if (state.toolRecords.length > 0 && state.answerText.length > 0) {
    state.content = 'tool-interrupted';
  } else if (state.toolRecords.length > 0) {
    state.content = 'tool-only';
  } else if (state.answerText.length > 0) {
    state.content = 'answer';
  } else {
    state.content = 'empty';
  }
}

function appendString(
  state: ProtocolDecoderState,
  key: 'answerText' | 'reasoningText' | 'planText' | 'refusalText',
  value: unknown,
): void {
  if (typeof value === 'string') {
    state[key] += value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
