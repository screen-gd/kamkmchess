import { describe, expect, it } from 'vitest';
import fixtureRaw from '../../backend/httpapi/testdata/online-updates.json?raw';
import { createMemoryCursorStorage, createSseParser, parseOnlineUpdateEnvelope } from './updates';

describe('Go/TypeScript online update wire contract', () => {
  it('accepts the canonical Go HTTP projection through polling and SSE', () => {
    const polled = parseOnlineUpdateEnvelope(JSON.parse(fixtureRaw) as unknown, 'match-wire');
    const parser = createSseParser();
    const events = parser.push(`event: snapshot\nid: 3\ndata: ${JSON.stringify(polled)}\n\n`);
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe('3');
    expect(parseOnlineUpdateEnvelope(JSON.parse(events[0]!.data) as unknown, 'match-wire')).toEqual(polled);
    expect(polled.schemaVersion).toBe(1);
    expect(polled.snapshot.schemaVersion).toBe(2);
    expect(polled.snapshot.moves[0]?.uci).toBe('e2e4');
    expect(polled.snapshot.pendingOffers[0]?.offerId).toBe('offer-wire');
    expect(polled.snapshot.clock.replySeat).toBe('black');
    expect(polled.snapshot.seats[1]?.control).toEqual({ kind: 'agent', modelLabel: 'Public model' });
    expect(polled.snapshot.yourSeat).toBe('white');
  });

  it('retains the newer stored cursor when subscribers write out of order', () => {
    const storage = createMemoryCursorStorage();
    const scope = { matchId: 'match-wire', identity: 'account:alice' };
    storage.write(scope, 9);
    storage.write(scope, 8);
    expect(storage.read(scope)).toBe(9);
  });
});
