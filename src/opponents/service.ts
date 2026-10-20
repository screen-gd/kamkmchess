import { classifyCompletedAnswer } from '../moves/index.js';
import type { ReplyClassification } from '../moves/index.js';
import {
  checkConnection,
  classifyConnectionRoute,
  createManualModelReference,
  hasCurrentDisclosureConsent,
  prepareGenerationRequest,
} from '../providers/connections/index.js';
import type {
  CachedCatalogState,
  ConnectionCatalogSnapshot,
  ConnectionNamespace,
  ConnectionProfile,
  ConnectionStore,
} from '../providers/connections/index.js';
import {
  createAnthropicMessagesDecoder,
  createChatCompletionsDecoder,
  createResponsesDecoder,
  encodeAnthropicMessagesRequest,
  encodeChatCompletionsRequest,
  encodeResponsesRequest,
} from '../providers/protocols/index.js';
import type { ProtocolGenerationConfig, ProtocolHistory, ProtocolStreamDecoder, ProtocolStreamResult, ProviderProtocol } from '../providers/protocols/index.js';
import { createDiagnosticLog, summarizeDiagnosticStream } from './diagnostic-log.js';
import type { DiagnosticLog } from './diagnostic-log.js';

export const DIAGNOSTIC_MAX_OUTPUT_TOKENS = 256;
const DIAGNOSTIC_SYSTEM = 'You are checking a chess client conversation contract. Do not make an independent chess decision. Follow the latest request exactly. Return only the requested JSON object.';

function diagnosticHttpFailure(status: number): string {
  const detail = status === 401 ? 'The endpoint rejected the API key. Check the connection key and try again.'
    : status === 402 ? 'The endpoint rejected the check because of insufficient credit or a spending limit. Check provider billing.'
    : status === 403 ? 'The endpoint denied access. Check this connection\'s permissions.'
      : status === 404 ? 'The endpoint or model was not found. Check the API URL and exact model ID.'
        : status === 429 ? 'The endpoint rate-limited the check. Wait before trying again.'
          : 'The endpoint could not complete the check. Review the connection and try again.';
  return `${detail} HTTP ${status}.`;
}

export type CompatibilityStateV1 = 'not-checked' | 'passed-current-session' | 'incompatible' | 'temporary-failure' | 'unknown';

export interface CompatibilityEvidenceV1 {
  readonly state: CompatibilityStateV1;
  readonly requestedModelId: string;
  readonly reportedModelId: string | null;
  readonly profileId: string;
  readonly configRevision: string;
  readonly credentialRevision: number;
  readonly protocol: ConnectionProfile['protocol'];
  readonly sessionId: string;
  readonly diagnosticId: string;
  readonly requestCount: number;
  readonly completedAtMs: number;
  readonly detail: string;
  readonly capabilityClaims: readonly [];
}

export interface DiagnosticResultV1 {
  readonly evidence: CompatibilityEvidenceV1;
  readonly stream: ProtocolStreamResult | null;
  readonly expected: { readonly coordinate: 'e2e4'; readonly marker: string; readonly priorPlan: string };
  readonly observed: { readonly answerText: string; readonly reportedModelId: string | null };
}

export interface CatalogViewV1 {
  readonly profileId: string;
  readonly state: CachedCatalogState;
  readonly entries: ConnectionCatalogSnapshot['entries'];
  readonly checkedAtMs: number | null;
  readonly lastSuccessfulAtMs: number | null;
  readonly nextUrl?: string;
  readonly error?: ConnectionCatalogSnapshot['error'];
  readonly cooldownUntilMs: number | null;
  readonly manualIds: readonly string[];
  /** Advertised metadata is descriptive only; no capability is inferred from names or logos. */
  readonly capabilityClaims: readonly [];
}

export interface OpponentIdentityV1 {
  readonly profileId: string;
  readonly configRevision: string;
  readonly credentialRevision: number;
  readonly modelId: string;
  readonly protocol: ConnectionProfile['protocol'];
  readonly diagnosticId: string;
}

export interface OpponentSelectionInputV1 {
  readonly profileId: string;
  readonly modelId: string;
}

export interface OpponentCandidateV1 {
  readonly id: string;
  readonly identity: OpponentIdentityV1;
  readonly state: 'queued' | 'awaiting-first-reply' | 'failed';
  readonly failure?: string;
}

export interface HandoffSnapshotV1 {
  readonly committed: OpponentIdentityV1 | null;
  readonly queued: OpponentCandidateV1 | null;
  readonly producing: OpponentIdentityV1 | null;
}

export interface ProducingReplyV1 {
  readonly candidateId: string;
  readonly classification: ReplyClassification;
  readonly committedSelection: OpponentIdentityV1 | null;
  readonly blocked: boolean;
}

export interface OpponentServiceOptions {
  readonly connections: ConnectionStore;
  readonly namespace: ConnectionNamespace;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly sessionId?: string;
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

export class OpponentServiceError extends Error {
  constructor(readonly code: 'not-found' | 'credential' | 'disclosure' | 'route' | 'diagnostic-required' | 'candidate' | 'invalid-id', message: string) {
    super(message);
    this.name = 'OpponentServiceError';
  }
}

/**
 * Session-scoped catalog, diagnostic and handoff state. Network actions only occur from
 * refreshCatalog/runCompatibilityDiagnostic; constructor and selection staging are local.
 */
export class OpponentService {
  readonly sessionId: string;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly manualIds = new Map<string, Set<string>>();
  private readonly evidence = new Map<string, CompatibilityEvidenceV1>();
  private readonly listeners = new Set<(snapshot: HandoffSnapshotV1) => void>();
  private handoff: HandoffSnapshotV1 = { committed: null, queued: null, producing: null };

  constructor(private readonly options: OpponentServiceOptions) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
    this.sessionId = options.sessionId ?? this.idFactory();
  }

  async refreshCatalog(profileId: string, signal?: AbortSignal): Promise<CatalogViewV1> {
    const profile = await this.requireProfile(profileId);
    const [credentials, previous] = await Promise.all([
      this.options.connections.resolveCredentials(this.options.namespace, profile),
      this.options.connections.getCatalogSnapshot(this.options.namespace, profile),
    ]);
    const cooldownUntilMs = previous?.error?.retryAfterMs === undefined
      ? null
      : previous.checkedAtMs + previous.error.retryAfterMs;
    if (cooldownUntilMs !== null && this.now() < cooldownUntilMs) return this.catalogView(profile, previous);
    if (credentials.status !== 'bound') return this.catalogView(profile, previous, credentials.status === 'missing' ? 'Connection credentials are not assigned.' : 'The connection credential binding changed.');
    const result = await checkConnection(profile, credentials.credentials, { fetch: this.options.fetch as typeof fetch, now: this.now, ...(signal === undefined ? {} : { signal }) });
    const stored = await this.options.connections.recordCatalogCheck(this.options.namespace, profile, result);
    return this.catalogView(profile, stored);
  }

  async getCatalog(profileId: string): Promise<CatalogViewV1> {
    const profile = await this.requireProfile(profileId);
    const snapshot = await this.options.connections.getCatalogSnapshot(this.options.namespace, profile);
    return this.catalogView(profile, snapshot);
  }

  async addManualModel(profileId: string, modelId: string): Promise<string> {
    const profile = await this.requireProfile(profileId);
    try {
      const reference = createManualModelReference(profile, modelId);
      const ids = this.manualIds.get(profileId) ?? new Set<string>();
      ids.add(reference.requestedModelId);
      this.manualIds.set(profileId, ids);
      return reference.requestedModelId;
    } catch {
      throw new OpponentServiceError('invalid-id', 'Enter an exact model ID without leading or trailing whitespace.');
    }
  }

  async runCompatibilityDiagnostic(input: OpponentSelectionInputV1, signal?: AbortSignal): Promise<DiagnosticResultV1> {
    const profile = await this.requireProfile(input.profileId);
    let modelId: string;
    try { modelId = createManualModelReference(profile, input.modelId).requestedModelId; }
    catch { throw new OpponentServiceError('invalid-id', 'Enter an exact model ID without leading or trailing whitespace.'); }
    const diagnosticId = this.idFactory();
    const log = createDiagnosticLog(profile, modelId, diagnosticId, this.now);
    log.write('started');
    try {
      const result = await this.performCompatibilityDiagnostic(profile, modelId, diagnosticId, log, signal);
      log.write('completed', { state: result.evidence.state, requestCount: result.evidence.requestCount }, result.evidence.state !== 'passed-current-session');
      return result;
    } catch (error) {
      log.write('preflight-failed', { errorName: error instanceof Error ? error.name : 'UnknownError', code: error instanceof OpponentServiceError ? error.code : null }, true);
      throw error;
    }
  }

  private async performCompatibilityDiagnostic(profile: ConnectionProfile, modelId: string, diagnosticId: string, log: DiagnosticLog, signal?: AbortSignal): Promise<DiagnosticResultV1> {
    const planToken = `KAMKM-PRIOR-PLAN-${this.idFactory()}`;
    const marker = `KAMKM-COMPAT-${this.idFactory()}`;
    let credentials: Awaited<ReturnType<ConnectionStore['resolveCredentials']>>;
    try { credentials = await this.options.connections.resolveCredentials(this.options.namespace, profile); }
    catch {
      log.write('blocked', { reason: 'credential-read-failed' }, true);
      return this.diagnosticFailure(profile, modelId, diagnosticId, 'unknown', 'Credential state could not be read.', null, marker, planToken);
    }
    if (credentials.status !== 'bound') {
      log.write('blocked', { reason: 'credentials', credentialStatus: credentials.status }, true);
      return this.diagnosticFailure(profile, modelId, diagnosticId, 'temporary-failure', `Connection credentials are ${credentials.status}.`, null, marker, planToken);
    }
    const route = classifyConnectionRoute(profile);
    if (route.evidence === 'unverified') {
      log.write('blocked', { reason: 'unverified-route' }, true);
      return this.diagnosticFailure(profile, modelId, diagnosticId, 'incompatible', `Route is unverified: ${route.statement}`, null, marker, planToken, credentials.credentials.credentialRevision);
    }
    const disclosure = await this.options.connections.getDisclosureChoice(this.options.namespace, profile);
    if (!hasCurrentDisclosureConsent(profile, disclosure)) throw new OpponentServiceError('disclosure', 'Accept the current connection disclosure before running this generation diagnostic.');

    const protocol = protocolFor(profile.protocol);
    const config: ProtocolGenerationConfig = { model: modelId, maxOutputTokens: DIAGNOSTIC_MAX_OUTPUT_TOKENS, temperature: 0 };
    const history: ProtocolHistory = {
      instructions: DIAGNOSTIC_SYSTEM,
      records: [
        { id: `${diagnosticId}:plan`, role: 'assistant', text: `A synthetic prior-plan record for this diagnostic only. Unique plan marker: ${planToken}.` },
        { id: `${diagnosticId}:check`, role: 'user', text: `Fixed standard-position coordinate exercise: return exactly one JSON object with keys "move", "plan", and "marker". Set move to "e2e4", copy the unique plan marker from the preceding assistant message into plan, and set marker to "${marker}". Do not invent a plan marker. This checks response format and conversation carry only; it is not a chess-strength test.` },
      ],
    };
    let stream: ProtocolStreamResult | null = null;
    let requestCount = 0;
    try {
      const encoded = encode(protocol, history, config);
      const prepared = prepareGenerationRequest(profile, credentials.credentials, JSON.stringify(encoded.body), config);
      log.request(prepared, config.maxOutputTokens);
      requestCount = 1;
      const response = await this.options.fetch(prepared.url, { ...prepared.init, ...(signal === undefined ? {} : { signal }) });
      log.response(response);
      const decoder = createDecoder(protocol, response.status);
      if (response.body) await readStream(response.body, decoder, signal);
      else if (!response.ok) decoder.push(new TextEncoder().encode('event: error\ndata: {}\n\n'));
      stream = decoder.finish();
      const reportedModelId = extractReportedModelId(stream);
      // Inspect JSON separately so malformed framing does not masquerade as invalid JSON.
      // Selection still requires a fully completed answer stream.
      const parsed = parseDiagnosticAnswer(stream.answerText);
      const passed = response.ok && stream.terminal === 'complete' && stream.content === 'answer' && parsed?.move === 'e2e4' && parsed.plan === planToken && parsed.marker === marker;
      log.write('result', {
        ...summarizeDiagnosticStream(stream, passed), reportedModelId,
        contract: { validJsonObject: parsed !== null, coordinateMatches: parsed?.move === 'e2e4', priorPlanMatches: parsed?.plan === planToken, markerMatches: parsed?.marker === marker },
      }, !passed);
      const state: CompatibilityStateV1 = passed ? 'passed-current-session'
        : response.ok && stream.terminal === 'complete' && stream.content !== 'empty' ? 'incompatible'
          : response.status === 429 || response.status === 402 || response.status >= 500 ? 'temporary-failure' : 'unknown';
      const detail = passed
        ? `One disclosed diagnostic request completed with the fixed coordinate, unique prior-plan marker and response marker. Reported routing ID: ${reportedModelId ?? 'not reported'}.`
        : !response.ok ? diagnosticHttpFailure(response.status)
          : `The diagnostic did not satisfy the fixed coordinate and unique prior-plan marker contract (${stream.terminal}/${stream.content}).`;
      const evidence = this.makeEvidence(profile, modelId, diagnosticId, state, detail, credentials.credentials.credentialRevision, reportedModelId, 1);
      this.evidence.set(evidenceKey(evidence), evidence);
      return { evidence, stream, expected: { coordinate: 'e2e4', marker, priorPlan: planToken }, observed: { answerText: stream.answerText, reportedModelId } };
    } catch (error) {
      log.write(requestCount ? 'request-failed' : 'preflight-failed', {
        aborted: signal?.aborted ?? false, errorName: error instanceof Error ? error.name : 'UnknownError',
        ...(requestCount ? { message: error instanceof Error ? error.message : 'Diagnostic request failed.' } : {}),
      }, true);
      const state: CompatibilityStateV1 = signal?.aborted ? 'unknown' : 'temporary-failure';
      return this.diagnosticFailure(profile, modelId, diagnosticId, state, error instanceof Error ? error.message : 'Diagnostic request failed.', stream, marker, planToken, credentials.credentials.credentialRevision, requestCount);
    }
  }

  /** Set the exact current model attribution before queueing any handoff. */
  setCommittedSelection(identity: OpponentIdentityV1 | null): void {
    this.handoff = { ...this.handoff, committed: identity };
    this.emit();
  }

  setProducingSelection(identity: OpponentIdentityV1 | null): void {
    this.handoff = { ...this.handoff, producing: identity };
    this.emit();
  }

  async prepareSelection(input: OpponentSelectionInputV1): Promise<HandoffSnapshotV1> {
    const current = this.handoff.committed;
    if (current && current.profileId === input.profileId && current.modelId === input.modelId) {
      const profile = await this.requireProfile(input.profileId);
      const credential = await this.options.connections.resolveCredentials(this.options.namespace, profile);
      if (credential.status === 'bound' && current.configRevision === profile.configRevision
        && current.credentialRevision === credential.credentials.credentialRevision && current.protocol === profile.protocol) {
        this.handoff = { ...this.handoff, queued: null };
        this.emit();
        return this.getSnapshot();
      }
    }
    const identity = await this.requirePassedIdentity(input);
    if (sameIdentity(this.handoff.committed, identity)) {
      this.handoff = { ...this.handoff, queued: null };
    } else {
      this.handoff = { ...this.handoff, queued: { id: this.idFactory(), identity, state: 'queued' } };
    }
    this.emit();
    return this.getSnapshot();
  }

  /** Call when the producing response has settled; a queued candidate awaits its own real turn. */
  producingReplySettled(): HandoffSnapshotV1 {
    const queued = this.handoff.queued;
    this.handoff = { ...this.handoff, producing: null, ...(queued ? { queued: { ...queued, state: 'awaiting-first-reply' } } : {}) };
    this.emit();
    return this.getSnapshot();
  }

  /** Only complete, interpretable candidate replies qualify the staged identity for controller application. */
  settleCandidateReply(candidateId: string, reply: { readonly answerText: string; readonly complete: boolean; readonly content: 'answer' | 'refusal' | 'other'; readonly position?: import('../rules/index.js').Position }): ProducingReplyV1 {
    const candidate = this.handoff.queued;
    if (!candidate || candidate.id !== candidateId || candidate.state !== 'awaiting-first-reply') {
      throw new OpponentServiceError('candidate', 'This candidate is no longer awaiting its first reply.');
    }
    const classification = reply.complete && (reply.content === 'answer' || reply.content === 'refusal')
      ? classifyCompletedAnswer({ answerText: reply.answerText, ...(reply.position === undefined ? {} : { position: reply.position }) })
      : { kind: 'format-failure', reason: 'no-action', fragment: '', retainedFields: [] } as const;
    if (classification.kind === 'format-failure') {
      this.handoff = { ...this.handoff, queued: { ...candidate, state: 'failed', failure: 'The first candidate reply was not interpretable. Choose Retry, another candidate, or Resume the prior model.' } };
      this.emit();
      return { candidateId, classification, committedSelection: null, blocked: true };
    }
    this.handoff = { committed: candidate.identity, queued: null, producing: candidate.identity };
    this.emit();
    return { candidateId, classification, committedSelection: candidate.identity, blocked: false };
  }

  failCandidate(candidateId: string, reason: string): HandoffSnapshotV1 {
    const candidate = this.handoff.queued;
    if (!candidate || candidate.id !== candidateId) return this.getSnapshot();
    this.handoff = { ...this.handoff, queued: { ...candidate, state: 'failed', failure: reason } };
    this.emit();
    return this.getSnapshot();
  }

  recoverCandidate(action: 'retry' | 'replace' | 'resume-prior'): HandoffSnapshotV1 {
    if (action === 'resume-prior') this.handoff = { ...this.handoff, queued: null, producing: this.handoff.committed };
    else if (action === 'retry' && this.handoff.queued?.state === 'failed') this.handoff = { ...this.handoff, queued: { id: this.idFactory(), identity: this.handoff.queued.identity, state: 'queued' } };
    this.emit();
    return this.getSnapshot();
  }

  getSnapshot(): HandoffSnapshotV1 { return structuredClone(this.handoff); }
  subscribe(listener: (snapshot: HandoffSnapshotV1) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async requirePassedIdentity(input: OpponentSelectionInputV1): Promise<OpponentIdentityV1> {
    const profile = await this.requireProfile(input.profileId);
    let modelId: string;
    try { modelId = createManualModelReference(profile, input.modelId).requestedModelId; }
    catch { throw new OpponentServiceError('invalid-id', 'Enter an exact model ID without leading or trailing whitespace.'); }
    const credentials = await this.options.connections.resolveCredentials(this.options.namespace, profile);
    if (credentials.status !== 'bound') throw new OpponentServiceError('candidate', `Connection credential state is ${credentials.status}.`);
    const matches = [...this.evidence.values()].filter((item) => item.state === 'passed-current-session'
      && item.profileId === profile.id && item.configRevision === profile.configRevision
      && item.credentialRevision === credentials.credentials.credentialRevision
      && item.protocol === profile.protocol && item.requestedModelId === modelId && item.sessionId === this.sessionId);
    const item = matches.at(-1);
    if (!item) throw new OpponentServiceError('diagnostic-required', 'Run an explicit compatibility diagnostic for this exact model and current connection configuration first.');
    return { profileId: profile.id, configRevision: profile.configRevision, credentialRevision: item.credentialRevision, modelId, protocol: profile.protocol, diagnosticId: item.diagnosticId };
  }

  private async requireProfile(profileId: string): Promise<ConnectionProfile> {
    const profile = await this.options.connections.getProfile(this.options.namespace, profileId);
    if (!profile) throw new OpponentServiceError('not-found', 'The selected connection profile is unavailable.');
    return profile;
  }

  private async catalogView(profile: ConnectionProfile, snapshot?: ConnectionCatalogSnapshot, fallbackError?: string): Promise<CatalogViewV1> {
    const state: CachedCatalogState = snapshot?.state ?? 'unavailable';
    const error = snapshot?.error ?? (fallbackError ? { code: 'credential-required' as const, message: fallbackError } : undefined);
    const cooldownUntilMs = error?.retryAfterMs === undefined ? null : (snapshot?.checkedAtMs ?? this.now()) + error.retryAfterMs;
    const catalogIds = new Set(snapshot?.entries.map((entry) => entry.id) ?? []);
    return {
      profileId: profile.id, state, entries: snapshot?.entries ?? [],
      checkedAtMs: snapshot?.checkedAtMs ?? null, lastSuccessfulAtMs: snapshot?.lastSuccessfulAtMs ?? null,
      ...(snapshot?.nextUrl === undefined ? {} : { nextUrl: snapshot.nextUrl }), ...(error === undefined ? {} : { error }),
      cooldownUntilMs, manualIds: [...(this.manualIds.get(profile.id) ?? [])].filter((id) => !catalogIds.has(id)), capabilityClaims: [],
    };
  }

  private diagnosticFailure(profile: ConnectionProfile, modelId: string, diagnosticId: string, state: CompatibilityStateV1, detail: string, stream: ProtocolStreamResult | null, marker: string, priorPlan: string, credentialRevision = 0, requestCount = 0): DiagnosticResultV1 {
    const evidence = this.makeEvidence(profile, modelId, diagnosticId, state, detail, credentialRevision, stream ? extractReportedModelId(stream) : null, requestCount);
    if (state === 'passed-current-session') this.evidence.set(evidenceKey(evidence), evidence);
    return { evidence, stream, expected: { coordinate: 'e2e4', marker, priorPlan }, observed: { answerText: stream?.answerText ?? '', reportedModelId: stream ? extractReportedModelId(stream) : null } };
  }

  private makeEvidence(profile: ConnectionProfile, modelId: string, diagnosticId: string, state: CompatibilityStateV1, detail: string, credentialRevision: number, reportedModelId: string | null, requestCount: number): CompatibilityEvidenceV1 {
    return { state, requestedModelId: modelId, reportedModelId, profileId: profile.id, configRevision: profile.configRevision, credentialRevision, protocol: profile.protocol, sessionId: this.sessionId, diagnosticId, requestCount, completedAtMs: this.now(), detail, capabilityClaims: [] };
  }

  private emit(): void { const snapshot = this.getSnapshot(); for (const listener of this.listeners) listener(snapshot); }
}

function evidenceKey(value: CompatibilityEvidenceV1): string { return JSON.stringify([value.profileId, value.configRevision, value.credentialRevision, value.protocol, value.requestedModelId, value.sessionId]); }
function sameIdentity(a: OpponentIdentityV1 | null, b: OpponentIdentityV1): boolean { return a !== null && a.profileId === b.profileId && a.configRevision === b.configRevision && a.credentialRevision === b.credentialRevision && a.modelId === b.modelId && a.protocol === b.protocol; }
function protocolFor(protocol: ConnectionProfile['protocol']): ProviderProtocol { return protocol === 'messages' ? 'anthropic-messages' : protocol; }
function encode(protocol: ProviderProtocol, history: ProtocolHistory, config: ProtocolGenerationConfig) {
  switch (protocol) {
    case 'chat-completions': return encodeChatCompletionsRequest(history, config);
    case 'responses': return encodeResponsesRequest(history, config);
    case 'anthropic-messages': return encodeAnthropicMessagesRequest(history, config);
  }
}
function createDecoder(protocol: ProviderProtocol, status: number): ProtocolStreamDecoder {
  switch (protocol) {
    case 'chat-completions': return createChatCompletionsDecoder({ httpStatus: status });
    case 'responses': return createResponsesDecoder({ httpStatus: status });
    case 'anthropic-messages': return createAnthropicMessagesDecoder({ httpStatus: status });
  }
}
async function readStream(body: ReadableStream<Uint8Array>, decoder: ProtocolStreamDecoder, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader();
  try {
    while (true) {
      if (signal?.aborted) { decoder.abort(); return; }
      const { done, value } = await reader.read();
      if (done) return;
      decoder.push(value);
    }
  } finally { reader.releaseLock(); }
}
function parseDiagnosticAnswer(text: string): { move?: unknown; plan?: unknown; marker?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as { move?: unknown; plan?: unknown; marker?: unknown };
  } catch { return null; }
}
function extractReportedModelId(result: ProtocolStreamResult): string | null {
  for (const event of result.raw.events) {
    const payload = event.payload;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) continue;
    const value = payload as Record<string, unknown>;
    if (typeof value.model === 'string') return value.model;
    if (typeof value.response === 'object' && value.response !== null && !Array.isArray(value.response)) {
      const model = (value.response as Record<string, unknown>).model;
      if (typeof model === 'string') return model;
    }
    if (typeof value.message === 'object' && value.message !== null && !Array.isArray(value.message)) {
      const model = (value.message as Record<string, unknown>).model;
      if (typeof model === 'string') return model;
    }
  }
  return null;
}
