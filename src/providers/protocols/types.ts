export type ProviderProtocol =
  | 'chat-completions'
  | 'responses'
  | 'anthropic-messages';

export type ProtocolTerminal =
  | 'complete'
  | 'incomplete'
  | 'failed'
  | 'truncated'
  | 'malformed'
  | 'aborted';

export type ResponsesSchema = 'openai' | 'openrouter-r12';

export type ProtocolContent =
  | 'answer'
  | 'refusal'
  | 'tool-only'
  | 'tool-interrupted'
  | 'empty';

export interface ProtocolRawEvent {
  event: string;
  data: string;
  dataLines: readonly string[];
  frameTerminated: boolean;
  rawBytes: Uint8Array;
  id?: string;
  retry?: number;
  payload?: unknown;
  parseError?: string;
}

export interface ProtocolStreamResult {
  protocol: ProviderProtocol;
  httpStatus?: number;
  terminal: ProtocolTerminal;
  content: ProtocolContent;
  answerText: string;
  reasoningText: string;
  planText: string;
  refusalText: string;
  usage: unknown | null;
  usageRecords: readonly unknown[];
  errors: readonly unknown[];
  incompleteDetails: readonly unknown[];
  toolRecords: readonly unknown[];
  otherChoices: readonly unknown[];
  unknownEvents: readonly ProtocolRawEvent[];
  /** Structural rejection reasons only. No provider content or credentials. */
  validationIssues?: readonly { readonly eventIndex: number; readonly reason: string }[];
  raw: {
    chunks: readonly Uint8Array[];
    events: readonly ProtocolRawEvent[];
  };
}

export interface ProtocolStreamDecoder {
  push(chunk: Uint8Array): void;
  abort(): void;
  finish(): ProtocolStreamResult;
}

export interface ProtocolStreamMetadata {
  httpStatus?: number;
  responsesSchema?: ResponsesSchema;
}

export interface ProtocolTextRecord {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface ProtocolHistory {
  instructions: string;
  records: readonly ProtocolTextRecord[];
  /** Number of leading records that belong to the stable retained-history prefix. */
  cachePrefixRecordCount?: number;
  /** Optional tokenizer count for instructions plus the stable retained-history prefix. */
  cachePrefixTokenCount?: number;
}

export interface ProtocolCacheOptions {
  /** OpenAI Chat/Responses prompt-cache affinity. Only pass for a selected supported model. */
  promptCacheKey?: string;
  /** OpenAI prompt-cache retention. Only pass when supported by the selected model and route. */
  promptCacheRetention?: 'in_memory' | '24h';
  /** OpenRouter Chat session affinity. Only pass for a selected OpenRouter Chat route. */
  openRouterSessionId?: string;
  /** Anthropic ephemeral prompt caching minimum from the selected model's provider metadata. */
  anthropicCacheMinimumTokens?: number;
  /** Anthropic ephemeral prompt caching, explicitly enabled for a supported model. */
  anthropicEphemeral?: boolean;
}

export interface ProtocolGenerationConfig {
  model: string;
  maxOutputTokens: number;
  temperature?: number;
  topP?: number;
  cache?: ProtocolCacheOptions;
}

export interface EncodedProtocolRequest {
  body: Readonly<Record<string, unknown>>;
  sourceRecordIds: readonly string[];
}
