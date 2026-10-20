import { SseParser } from './sse';
import type {
  ProtocolRawEvent,
  ProtocolStreamMetadata,
  ProtocolStreamDecoder,
  ProtocolStreamResult,
  ProviderProtocol,
} from './types';

export interface ProtocolDecoderState {
  terminal: ProtocolStreamResult['terminal'];
  content: ProtocolStreamResult['content'];
  answerText: string;
  reasoningText: string;
  planText: string;
  refusalText: string;
  usage: unknown | null;
  usageRecords: unknown[];
  errors: unknown[];
  incompleteDetails: unknown[];
  toolRecords: unknown[];
  otherChoices: unknown[];
  unknownEvents: ProtocolRawEvent[];
  malformed: boolean;
  validationIssues: Array<{ eventIndex: number; reason: string }>;
}

export function createProtocolState(): ProtocolDecoderState {
  return {
    terminal: 'truncated',
    content: 'empty',
    answerText: '',
    reasoningText: '',
    planText: '',
    refusalText: '',
    usage: null,
    usageRecords: [],
    errors: [],
    incompleteDetails: [],
    toolRecords: [],
    otherChoices: [],
    unknownEvents: [],
    malformed: false,
    validationIssues: [],
  };
}

export function createSseProtocolDecoder(
  protocol: ProviderProtocol,
  state: ProtocolDecoderState,
  consume: (event: ProtocolRawEvent, state: ProtocolDecoderState) => void,
  finalize: (state: ProtocolDecoderState) => void,
  metadata: ProtocolStreamMetadata = {},
  shouldParsePayload: (event: ProtocolRawEvent) => boolean = () => true,
): ProtocolStreamDecoder {
  const parser = new SseParser();
  const chunks: Uint8Array[] = [];
  const events: ProtocolRawEvent[] = [];
  let aborted = false;
  let result: ProtocolStreamResult | undefined;

  const acceptEvents = (incoming: readonly ProtocolRawEvent[]): void => {
    for (const event of incoming) {
      const parsed = shouldParsePayload(event) ? parsePayload(event) : event;
      events.push(parsed);
      if (!aborted && parsed.frameTerminated) {
        consume(parsed, state);
      }
    }
  };

  return {
    push(chunk) {
      if (result !== undefined) {
        throw new Error('Cannot push bytes after the stream decoder is finished.');
      }
      const captured = chunk.slice();
      chunks.push(captured);
      acceptEvents(parser.push(captured));
    },
    abort() {
      if (result === undefined) {
        aborted = true;
      }
    },
    finish() {
      if (result !== undefined) {
        return result;
      }

      acceptEvents(parser.finish());
      finalize(state);
      if (aborted) {
        state.terminal = 'aborted';
      }

      const completedResult: ProtocolStreamResult = {
        protocol,
        terminal: state.terminal,
        content: state.content,
        answerText: state.answerText,
        reasoningText: state.reasoningText,
        planText: state.planText,
        refusalText: state.refusalText,
        usage: state.usage,
        usageRecords: [...state.usageRecords],
        errors: [...state.errors],
        incompleteDetails: [...state.incompleteDetails],
        toolRecords: [...state.toolRecords],
        otherChoices: [...state.otherChoices],
        unknownEvents: [...state.unknownEvents],
        ...(state.validationIssues.length ? { validationIssues: state.validationIssues.map(issue => ({ ...issue })) } : {}),
        raw: {
          chunks: chunks.map((entry) => entry.slice()),
          events: events.map(cloneEvent),
        },
      };
      if (metadata.httpStatus !== undefined) {
        completedResult.httpStatus = metadata.httpStatus;
      }
      result = completedResult;
      return result;
    },
  };
}

function parsePayload(event: ProtocolRawEvent): ProtocolRawEvent {
  if (event.parseError !== undefined || event.data.length === 0 || event.data === '[DONE]') {
    return event;
  }

  try {
    return { ...event, payload: JSON.parse(event.data) as unknown };
  } catch {
    return { ...event, parseError: 'SSE data is not valid JSON.' };
  }
}

function cloneEvent(event: ProtocolRawEvent): ProtocolRawEvent {
  return {
    ...event,
    dataLines: [...event.dataLines],
    rawBytes: event.rawBytes.slice(),
  };
}
