import type { ConnectionProfile } from '../providers/connections/index.js';
import type { PreparedProviderRequest } from '../providers/connections/requests.js';
import type { ProtocolStreamResult } from '../providers/protocols/index.js';

/** Local console diagnostics only. Never pass request bodies or raw provider payloads here. */
export function createDiagnosticLog(profile: ConnectionProfile, modelId: string, diagnosticId: string, now: () => number) {
  const startedAt = now();
  const secrets: string[] = [];
  function redact(value: unknown): unknown {
    if (typeof value === 'string') {
      let text = value;
      for (const secret of secrets) text = text.replaceAll(secret, '[redacted]');
      return text.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
        .replace(/sk-[\w-]+/g, '[redacted]').slice(0, 512);
    }
    if (Array.isArray(value)) return value.map(redact);
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]));
    return value;
  }
  function write(event: string, details: Record<string, unknown> = {}, warning = false) {
    const entry = redact({ event, diagnosticId, provider: profile.provider, profileId: profile.id, protocol: profile.protocol, modelId, elapsedMs: now() - startedAt, ...details });
    // Logging must never change the outcome of a generation request.
    try { (warning ? console.warn : console.info)('[model-diagnostic]', entry); } catch { /* Console unavailable. */ }
  }
  return {
    write,
    request(prepared: PreparedProviderRequest, maxOutputTokens: number) {
      for (const [name, value] of Object.entries(prepared.init.headers)) {
        if (!value || ['accept', 'content-type', 'anthropic-version', 'anthropic-dangerous-direct-browser-access'].includes(name.toLowerCase())) continue;
        secrets.push(value);
        if (/^Bearer /i.test(value)) secrets.push(value.slice(7));
      }
      secrets.sort((a, b) => b.length - a.length);
      const url = new URL(prepared.url);
      write('request', { endpoint: `${url.origin}${url.pathname}`, maxOutputTokens, temperature: 0, streaming: true });
    },
    response(response: Response) {
      write('response', {
        httpStatus: response.status, contentType: response.headers.get('content-type'),
        requestId: response.headers.get('x-request-id') ?? response.headers.get('request-id'),
        retryAfter: response.headers.get('retry-after'),
      });
    },
  };
}

export type DiagnosticLog = ReturnType<typeof createDiagnosticLog>;

export function summarizeDiagnosticStream(stream: ProtocolStreamResult, passed: boolean) {
  const errors = [...stream.errors];
  // Error responses are commonly plain JSON, which the SSE decoder cannot interpret.
  if (!stream.raw.events.some(event => event.data.length > 0)) {
    const decoder = new TextDecoder();
    let body = '';
    for (const chunk of stream.raw.chunks) {
      body += decoder.decode(chunk, { stream: true });
      if (body.length > 65_536) break;
    }
    body += decoder.decode();
    try {
      const value: unknown = JSON.parse(body);
      if (isRecord(value) && value.error !== undefined) errors.push(value.error);
    } catch { /* HTML, malformed JSON, and non-SSE responses are identified by content type and terminal state. */ }
  }
  const providerErrors = errors.slice(0, 5).map(value => {
    if (!isRecord(value)) return { message: typeof value === 'string' ? value : 'Unrecognized provider error' };
    const metadata = isRecord(value.metadata) ? value.metadata : {};
    return {
      code: scalar(value.code), message: scalar(value.message), type: scalar(value.type),
      provider: scalar(metadata.provider_name),
    };
  });
  const finishReasons = new Set<string>();
  for (const event of stream.raw.events) {
    const payload = event.payload;
    if (!isRecord(payload)) continue;
    if (Array.isArray(payload.choices)) for (const choice of payload.choices) {
      if (isRecord(choice) && choice.index === 0 && typeof choice.finish_reason === 'string') finishReasons.add(choice.finish_reason);
    }
    if (isRecord(payload.delta) && typeof payload.delta.stop_reason === 'string') finishReasons.add(payload.delta.stop_reason);
  }
  for (const detail of stream.incompleteDetails) {
    if (isRecord(detail) && typeof detail.reason === 'string') finishReasons.add(detail.reason);
  }
  const status = stream.httpStatus ?? 0;
  const codes = providerErrors.map(error => 'code' in error ? Number(error.code) : 0);
  const hasCode = (code: number) => status === code || codes.includes(code);
  const failureKind = passed ? null
    : hasCode(402) ? 'credits'
      : hasCode(401) ? 'authentication'
        : hasCode(403) ? 'permissions'
          : hasCode(429) ? 'rate-limit'
            : status >= 400 || providerErrors.length ? 'provider'
              : finishReasons.has('length') || finishReasons.has('max_tokens') ? 'output-limit'
                : stream.terminal === 'complete' ? 'contract' : 'stream';
  return {
    failureKind, httpStatus: stream.httpStatus, terminal: stream.terminal, content: stream.content,
    answerCharacters: stream.answerText.length, reasoningCharacters: stream.reasoningText.length,
    eventCount: stream.raw.events.length, unknownEventCount: stream.unknownEvents.length,
    receivedBytes: stream.raw.chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    finishReasons: [...finishReasons], providerErrors, validationIssues: stream.validationIssues ?? [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function scalar(value: unknown): string | number | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}
