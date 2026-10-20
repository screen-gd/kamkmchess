import { describe, expect, it } from 'vitest';
import { parsePosition } from '../rules/index.js';
import { ONLINE_DEFAULT_RULES_POLICY_VERSION } from '../online/contracts.js';
import {
  forbiddenWorkerEnvironmentKeys,
  sanitizeWorkerEnvironment,
  WORKER_ENV_ALLOWLIST,
} from './environment.js';
import { handleRulesWorkerLine } from './evaluate.js';
import {
  inputFingerprint,
  LIMITS,
  materialSummary,
  parseRulesWorkerRequest,
  RULES_POLICY_VERSION,
  RulesWorkerRequestError,
} from './protocol.js';

const INITIAL = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function baseRequest(fen = INITIAL): Record<string, unknown> {
  return {
    protocolVersion: 1,
    requestId: 'req-1',
    rulesPolicyVersion: RULES_POLICY_VERSION,
    matchVersion: 7,
    fen,
    history: [fen],
  };
}

function rejectionCode(value: unknown): string {
  const response = handleRulesWorkerLine(JSON.stringify(value));
  expect(response.status).toBe('rejected');
  if (response.status !== 'rejected') throw new Error('Expected a rejection.');
  return response.code;
}

describe('rules worker request validation', () => {
  it('parses and evaluates a strict initial request', () => {
    const request = parseRulesWorkerRequest(baseRequest());

    expect(request.protocolVersion).toBe(1);
    expect(request.matchVersion).toBe(7);
    expect(request.position.fen).toBe(INITIAL);
    expect(request.history).toEqual([INITIAL]);
    expect(request.repetition.entries).toEqual([{ identity: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -', occurrences: '1' }]);
    expect(request.intent).toBeNull();
  });

  it('matches the shared online contract policy version', () => {
    expect(RULES_POLICY_VERSION).toBe(ONLINE_DEFAULT_RULES_POLICY_VERSION);
  });

  it('rejects unsupported protocol, policy, correlation, and version shapes', () => {
    const cases: [string, (request: Record<string, unknown>) => void, string][] = [
      ['protocol', (request) => { request.protocolVersion = 2; }, 'unsupported-protocol-version'],
      ['policy', (request) => { request.rulesPolicyVersion = 'kha-2026-10-17.1'; }, 'rules-policy-version-mismatch'],
      ['unknown field', (request) => { request.extra = true; }, 'invalid-request'],
      ['zero version', (request) => { request.matchVersion = 0; }, 'invalid-request'],
      ['fractional version', (request) => { request.matchVersion = 1.5; }, 'invalid-request'],
      ['unsafe version', (request) => { request.matchVersion = Number.MAX_SAFE_INTEGER + 1; }, 'invalid-request'],
      ['string version', (request) => { request.matchVersion = '7'; }, 'invalid-request'],
      ['empty request id', (request) => { request.requestId = ''; }, 'invalid-request'],
      ['long request id', (request) => { request.requestId = 'a'.repeat(LIMITS.maxRequestIdLength + 1); }, 'invalid-request'],
      ['unsafe request id', (request) => { request.requestId = 'two words'; }, 'invalid-request'],
    ];

    for (const [name, mutate, code] of cases) {
      const request = baseRequest();
      mutate(request);
      expect(rejectionCode(request), name).toBe(code);
    }
  });

  it('enforces strict FEN fields and counters', () => {
    const cases = [
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0',
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - +1 1',
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e3 0 1',
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - -1 1',
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 0',
      '8/8/8/8/8/8/8/8 w - - 0 1',
    ];

    for (const fen of cases) {
      expect(rejectionCode({ ...baseRequest(), fen, history: [INITIAL] }), fen).toBe('invalid-fen');
    }
  });

  it('rejects malformed history or history that does not end at the evaluated FEN', () => {
    const other = '4k3/8/8/8/8/8/8/4K3 w - - 0 1';
    const request = baseRequest();

    expect(rejectionCode({ ...request, history: [] })).toBe('invalid-history');
    expect(rejectionCode({ ...request, history: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' })).toBe('invalid-history');
    expect(rejectionCode({
      ...request,
      history: Array.from({ length: LIMITS.maxHistoryFens + 1 }, () => INITIAL),
    })).toBe('invalid-history');
    expect(rejectionCode({ ...request, history: [INITIAL, 'not-a-fen'] })).toBe('invalid-fen');
    expect(rejectionCode({ ...request, history: [other] })).toBe('history-mismatch');
    expect(rejectionCode({ ...request, history: [INITIAL, other] })).toBe('history-mismatch');
    expect(rejectionCode({ ...request, history: [INITIAL, ''] })).toBe('invalid-fen');
  });

  it('derives repetition counts from the ordered history', () => {
    const request = parseRulesWorkerRequest({ ...baseRequest(), history: [INITIAL, INITIAL, INITIAL] });
    expect(request.history).toHaveLength(3);
    expect(request.repetition.entries).toEqual([
      { identity: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -', occurrences: '3' },
    ]);
  });

  it('validates move and timeout intent shapes', () => {
    const request = baseRequest();
    expect(rejectionCode({ ...request, intent: { kind: 'resign' } })).toBe('invalid-request');
    expect(rejectionCode({ ...request, intent: { kind: 'move', from: 'e2', to: 'e9' } })).toBe('invalid-request');
    expect(rejectionCode({ ...request, intent: { kind: 'move', from: 'e2', to: 'e4', promotion: 'k' } })).toBe('invalid-request');
    expect(rejectionCode({ ...request, intent: { kind: 'move', from: 'e2', to: 'e4', extra: true } })).toBe('invalid-request');
    expect(rejectionCode({ ...request, intent: { kind: 'timeout', expiredColor: 'x' } })).toBe('invalid-request');
    expect(rejectionCode({ ...request, intent: { kind: 'timeout', expiredColor: 'w', from: 'e2' } })).toBe('invalid-request');
  });

  it('rejects illegal and terminal move intents without a candidate', () => {
    const illegal = handleRulesWorkerLine(JSON.stringify({
      ...baseRequest(),
      intent: { kind: 'move', from: 'e2', to: 'e5' },
    }));
    expect(illegal.status).toBe('rejected');
    expect(illegal).not.toHaveProperty('candidate');
    if (illegal.status === 'rejected') expect(illegal.code).toBe('illegal-move');

    const mateFen = '7k/5Q2/6K1/8/8/8/8/8 b - - 100 60';
    const terminal = handleRulesWorkerLine(JSON.stringify({
      ...baseRequest(mateFen),
      history: [mateFen, mateFen, mateFen],
      intent: { kind: 'move', from: 'h8', to: 'h7' },
    }));
    expect(terminal.status).toBe('rejected');
    if (terminal.status === 'rejected') expect(terminal.code).toBe('position-terminal');
  });

  it('turns malformed JSON into a rejection', () => {
    const response = handleRulesWorkerLine('{"protocolVersion":');
    expect(response).toEqual({
      protocolVersion: 1,
      status: 'rejected',
      requestId: null,
      code: 'malformed-json',
      message: 'Request line is not valid JSON.',
    });
  });

  it('reports a request error with its code', () => {
    const request = baseRequest();
    request.protocolVersion = 9;
    expect(() => parseRulesWorkerRequest(request)).toThrowError(RulesWorkerRequestError);
    try {
      parseRulesWorkerRequest(request);
    } catch (error) {
      expect(error).toBeInstanceOf(RulesWorkerRequestError);
      expect((error as RulesWorkerRequestError).code).toBe('unsupported-protocol-version');
    }
  });
});

describe('rules worker input fingerprint and material', () => {
  it('is stable across correlation tokens and changes with semantic input', () => {
    const first = parseRulesWorkerRequest({ ...baseRequest(), requestId: 'one' });
    const second = parseRulesWorkerRequest({ ...baseRequest(), requestId: 'two' });
    const moved = parseRulesWorkerRequest({ ...baseRequest(), matchVersion: 8 });
    const intent = parseRulesWorkerRequest({ ...baseRequest(), intent: { kind: 'move', from: 'e2', to: 'e4' } });
    const repeated = parseRulesWorkerRequest({ ...baseRequest(), history: [INITIAL, INITIAL] });

    expect(inputFingerprint(first)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(inputFingerprint(first)).toBe(inputFingerprint(second));
    expect(inputFingerprint(first)).not.toBe(inputFingerprint(moved));
    expect(inputFingerprint(first)).not.toBe(inputFingerprint(intent));
    expect(inputFingerprint(first)).not.toBe(inputFingerprint(repeated));
  });

  it('summarises material deterministically', () => {
    const material = materialSummary(parsePosition(INITIAL));
    expect(material.total).toBe(32);
    expect(material.white).toEqual({ p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 });
    expect(material.black).toEqual({ p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 });
  });
});

describe('rules worker environment', () => {
  it('identifies and removes private authority and provider variables', () => {
    const environment: Record<string, string | undefined> = {
      PATH: 'C:\\node',
      SystemRoot: 'C:\\Windows',
      DATABASE_URL: 'postgres://private',
      CLERK_SECRET_KEY: 'clerk-secret',
      OPENAI_API_KEY: 'provider-secret',
      HTTPS_PROXY: 'http://proxy',
    };

    const forbidden = forbiddenWorkerEnvironmentKeys(environment);
    expect(forbidden).toContain('DATABASE_URL');
    expect(forbidden).toContain('CLERK_SECRET_KEY');
    expect(forbidden).toContain('OPENAI_API_KEY');
    expect(forbidden).toContain('HTTPS_PROXY');
    expect(forbidden).not.toContain('PATH');
    expect(forbidden).not.toContain('SystemRoot');

    sanitizeWorkerEnvironment(environment);
    expect(Object.keys(environment).sort()).toEqual(['PATH', 'SystemRoot']);
    expect(WORKER_ENV_ALLOWLIST).not.toContain('DATABASE_URL');
  });
});
