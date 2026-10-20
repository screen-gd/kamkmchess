import { describe, expect, it } from 'vitest';
import fixtureRaw from '../../backend/online/testdata/online-contracts.json?raw';
import {
  ONLINE_CONTRACTS_SCHEMA_VERSION,
  ONLINE_DEFAULT_RULES_POLICY_VERSION,
  ONLINE_PUBLIC_PROJECTION_SCHEMA_VERSION,
  OnlineContractError,
  parseCandidate,
  parseCommand,
  parseDeletionMarker,
  parsePublicProjection,
  parseQueueEntry,
  parseReceipt,
  parseRunnerLease,
  parseTimeoutFacts,
} from './contracts';

const fixture = JSON.parse(fixtureRaw) as {
  schemaVersion: number;
  command: unknown;
  cancelCommand: unknown;
  offerDrawCommand: unknown;
  acceptDrawCommand: unknown;
  offerTakebackCommand: unknown;
  acceptTakebackCommand: unknown;
  recoveryAttemptCommand: unknown;
  offerEvent: unknown;
  candidate: unknown;
  timeoutFacts: unknown;
  receipt: unknown;
  publicProjection: unknown;
  queueEntry: unknown;
  runnerLease: unknown;
  deletionMarker: unknown;
};

function clone<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

describe('online shared contracts', () => {
  it('accepts checkmate only for the mover, with the opponent next to move', () => {
    const base = parseCandidate(fixture.candidate);
    const mate = {
      ...base,
      move: { ...base.move, seat: 'white', uci: 'h6g7', san: 'Qg7#', resultingFen: '6k1/6Q1/5K2/8/8/8/8/8 b - - 1 1' },
      result: { kind: 'win', winner: 'white', reason: 'checkmate' },
    };
    expect(parseCandidate(mate).result?.winner).toBe('white');
    expect(() => parseCandidate({ ...mate, result: { ...mate.result, winner: 'black' } })).toThrow(OnlineContractError);
    expect(() => parseCandidate({ ...mate, result: { ...mate.result, reason: 'resignation' } })).toThrow(OnlineContractError);
    expect(() => parseCandidate({ ...mate, move: { ...mate.move, resultingFen: '6k1/6Q1/5K2/8/8/8/8/8 w - - 1 1' } })).toThrow(OnlineContractError);
    expect(() => parseCandidate({ ...mate, move: { ...mate.move, san: 'e4\nprivate' } })).toThrow(OnlineContractError);
  });

  it('parses the shared Go/TypeScript fixture', () => {
    const command = parseCommand(fixture.command);
    expect(command.schemaVersion).toBe(ONLINE_CONTRACTS_SCHEMA_VERSION);
    expect(command.action.kind).toBe('create_match');
    if (command.action.kind === 'create_match') {
      expect(command.action.setup.timeControl.startingTimeMs).toBe(300_000);
      expect(command.action.setup.seats.white.publicLabel).toBe('Alice');
      expect(command.action.setup.seats.black.participant.id).toBe('user_b');
    }

    const candidate = parseCandidate(fixture.candidate);
    expect(candidate.evaluatedVersion).toBe(1);
    expect(candidate.move?.uci).toBe('e2e4');

    const timeout = parseTimeoutFacts(fixture.timeoutFacts);
    expect(timeout.expiredSeat).toBe('black');
    expect(timeout.winner).toBe('white');

    const receipt = parseReceipt(fixture.receipt);
    expect(receipt.outcome).toBe('accepted');
    expect(receipt.event?.kind).toBe('match_created');

    const projection = parsePublicProjection(fixture.publicProjection);
    expect(projection.schemaVersion).toBe(ONLINE_PUBLIC_PROJECTION_SCHEMA_VERSION);
    expect(projection.moves.map((move) => move.san)).toEqual(['e4']);
    expect(projection.result.winner).toBe('white');
    expect(projection.rulesPolicyVersion).toBe(ONLINE_DEFAULT_RULES_POLICY_VERSION);

    const queue = parseQueueEntry(fixture.queueEntry);
    expect(queue.status).toBe('waiting');
    expect(queue.control.kind).toBe('agent');

    const lease = parseRunnerLease(fixture.runnerLease);
    expect(lease.status).toBe('active');
    expect(lease.controlEpoch).toBe(2);

    const marker = parseDeletionMarker(fixture.deletionMarker);
    expect(marker.kind).toBe('replay_removal');
    expect(marker.matchId).toBe('match-contract-01');
  });

  it('parses the shared cancel, draw, takeback and recovery commands', () => {
    const cancel = parseCommand(fixture.cancelCommand);
    expect(cancel.action.kind).toBe('cancel');

    const offerDraw = parseCommand(fixture.offerDrawCommand);
    expect(offerDraw.action.kind).toBe('offer_draw');

    const acceptDraw = parseCommand(fixture.acceptDrawCommand);
    expect(acceptDraw.action.kind).toBe('accept_draw');
    expect(acceptDraw.seat).toBe('black');
    if (acceptDraw.action.kind === 'accept_draw') {
      expect(acceptDraw.action.offerId).toBe('offer-contract-draw-01');
    }

    const offerTakeback = parseCommand(fixture.offerTakebackCommand);
    expect(offerTakeback.action.kind).toBe('offer_takeback');
    if (offerTakeback.action.kind === 'offer_takeback') {
      expect(offerTakeback.action.targetVersion).toBe(3);
    }

    const acceptTakeback = parseCommand(fixture.acceptTakebackCommand);
    expect(acceptTakeback.action.kind).toBe('accept_takeback');
    if (acceptTakeback.action.kind === 'accept_takeback') {
      expect(acceptTakeback.action.offerId).toBe('offer-contract-takeback-01');
    }

    const recovery = parseCommand(fixture.recoveryAttemptCommand);
    expect(recovery.action.kind).toBe('record_recovery_attempt');
    if (recovery.action.kind === 'record_recovery_attempt') {
      expect(recovery.action.attempt).toBe('illegal_move');
    }
  });

  it('rejects an unknown or unsafe payload for the new actions', () => {
    const takeback = fixture.offerTakebackCommand as Record<string, unknown>;
    expect(() =>
      parseCommand({
        ...takeback,
        action: { kind: 'offer_takeback', targetVersion: 0 },
      }),
    ).toThrow(OnlineContractError);
    expect(() =>
      parseCommand({
        ...takeback,
        action: { kind: 'offer_takeback', targetVersion: 3, position: 'arbitrary' },
      }),
    ).toThrow(OnlineContractError);
    const recovery = fixture.recoveryAttemptCommand as Record<string, unknown>;
    expect(() =>
      parseCommand({
        ...recovery,
        action: { kind: 'record_recovery_attempt', attempt: 'anything' },
      }),
    ).toThrow(OnlineContractError);
    expect(() =>
      parseCommand({
        ...recovery,
        action: { kind: 'record_recovery_attempt', attempt: 'illegal_move', token: 'secret' },
      }),
    ).toThrow(OnlineContractError);
    const cancel = fixture.cancelCommand as Record<string, unknown>;
    expect(() =>
      parseCommand({
        ...cancel,
        action: { kind: 'cancel', reason: 'resign' },
      }),
    ).toThrow(OnlineContractError);
  });

  it('requires the exact offered identity for a consent', () => {
    const acceptTakeback = fixture.acceptTakebackCommand as Record<string, unknown>;
    expect(() =>
      parseCommand({
        ...acceptTakeback,
        action: { kind: 'accept_takeback' },
      }),
    ).toThrow(OnlineContractError);
    expect(() =>
      parseCommand({
        ...acceptTakeback,
        action: { kind: 'accept_takeback', offerId: 'short' },
      }),
    ).toThrow(OnlineContractError);
    expect(() =>
      parseCommand({
        ...acceptTakeback,
        action: { kind: 'accept_takeback', offerId: 'offer-contract-takeback-01', targetVersion: 3 },
      }),
    ).toThrow(OnlineContractError);
    const acceptDraw = fixture.acceptDrawCommand as Record<string, unknown>;
    expect(() =>
      parseCommand({
        ...acceptDraw,
        action: { kind: 'accept_draw' },
      }),
    ).toThrow(OnlineContractError);
  });

  it('parses the offer event of the shared fixture', () => {
    const receipt = parseReceipt({
      ...(fixture.receipt as Record<string, unknown>),
      event: fixture.offerEvent,
    });
    expect(receipt.event?.kind).toBe('offer_created');
    expect(receipt.event?.offer?.offerId).toBe('offer-contract-takeback-01');
    expect(receipt.event?.offer?.kind).toBe('takeback');
    expect(receipt.event?.offer?.targetVersion).toBe(3);
  });

  it('is stable across a JSON round trip', () => {
    const first = parseCommand(fixture.command);
    const second = parseCommand(clone(first));
    expect(second).toEqual(first);
    const projection = parsePublicProjection(fixture.publicProjection);
    expect(parsePublicProjection(clone(projection))).toEqual(projection);
  });

  it('rejects unknown envelope or action fields instead of storing arbitrary state', () => {
    const command = fixture.command as Record<string, unknown>;
    expect(() => parseCommand({ ...command, sql: 'delete from online_matches' })).toThrow(OnlineContractError);
    const action = command.action as Record<string, unknown>;
    expect(() => parseCommand({ ...command, action: { ...action, state: { apiKey: 'secret' } } })).toThrow(OnlineContractError);
    expect(() => parseCommand({ ...command, action: { kind: 'resign', token: 'secret' } })).toThrow(OnlineContractError);
  });

  it('rejects unsafe or ambiguous action payloads', () => {
    const command = fixture.command as Record<string, unknown>;
    expect(() =>
      parseCommand({
        ...command,
        action: { kind: 'submit_move', move: 'E2E4' },
      }),
    ).toThrow(OnlineContractError);
    expect(() =>
      parseCommand({
        ...command,
        action: { kind: 'set_control', control: { kind: 'agent', modelLabel: 'owner@example.com' } },
      }),
    ).toThrow(OnlineContractError);
    expect(() =>
      parseCommand({
        ...command,
        action: {
          kind: 'create_match',
          setup: {
            variant: 'orthodox',
            startingFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            timeControl: { startingTimeMs: 300000, incrementMs: 0 },
            seats: {
              white: {
                participant: { kind: 'account', id: 'same-owner' },
                publicLabel: 'Alice',
                control: { kind: 'human' },
              },
              black: {
                participant: { kind: 'account', id: 'same-owner' },
                publicLabel: 'Bob',
                control: { kind: 'human' },
              },
            },
          },
        },
      }),
    ).toThrow(OnlineContractError);
  });

  it('rejects a public projection carrying private identity or route fields', () => {
    const projection = fixture.publicProjection as Record<string, unknown>;
    expect(() => parsePublicProjection({ ...projection, ownerId: 'clerk_user_secret' })).toThrow(OnlineContractError);
    expect(() => parsePublicProjection({ ...projection, providerEndpoint: 'https://private.example' })).toThrow(OnlineContractError);
    const participants = projection.participants as unknown[];
    const first = participants[0] as Record<string, unknown>;
    expect(() =>
      parsePublicProjection({
        ...projection,
        participants: [{ ...first, participant: { kind: 'account', id: 'clerk_user_secret' } }, participants[1]],
      }),
    ).toThrow(OnlineContractError);
  });

  it('rejects inconsistent terminal results and queue controls', () => {
    const receipt = fixture.receipt as Record<string, unknown>;
    expect(() =>
      parseReceipt({
        ...receipt,
        result: { kind: 'draw', winner: 'white', reason: 'agreement' },
      }),
    ).toThrow(OnlineContractError);
    expect(() =>
      parseReceipt({
        ...receipt,
        result: { kind: 'win', winner: null, reason: 'resignation' },
      }),
    ).toThrow(OnlineContractError);
    const queue = fixture.queueEntry as Record<string, unknown>;
    expect(() =>
      parseQueueEntry({
        ...queue,
        control: { kind: 'engine', modelLabel: 'Stockfish' },
      }),
    ).toThrow(OnlineContractError);
  });

  it('rejects unsupported versions and malformed hashes', () => {
    const command = fixture.command as Record<string, unknown>;
    expect(() => parseCommand({ ...command, schemaVersion: 3 })).toThrow(OnlineContractError);
    const candidate = fixture.candidate as Record<string, unknown>;
    expect(() => parseCandidate({ ...candidate, evaluatedInputHash: 'not-a-hash' })).toThrow(OnlineContractError);
    expect(() => parseCandidate({ ...candidate, schemaVersion: 2 })).toThrow(OnlineContractError);
  });

  it('rejects a timeout adjudication for the flagged seat or unbound facts', () => {
    const facts = fixture.timeoutFacts as Record<string, unknown>;
    expect(() => parseTimeoutFacts({ ...facts, winner: 'black' })).toThrow(OnlineContractError);
    expect(() => parseTimeoutFacts({ ...facts, schemaVersion: 2 })).toThrow(OnlineContractError);
    expect(() => parseTimeoutFacts({ ...facts, evaluatedVersion: 0 })).toThrow(OnlineContractError);
    expect(() => parseTimeoutFacts({ ...facts, winner: null })).not.toThrow();
    expect(parseTimeoutFacts({ ...facts, winner: null }).winner).toBeNull();
  });
});
