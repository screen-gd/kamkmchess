import { describe, expect, it } from 'vitest';
import { BoundedLineReader } from './lines.js';

describe('bounded worker line reader', () => {
  it('assembles lines across chunks and preserves split UTF-8 code points', async () => {
    const lines: string[] = [];
    const reader = new BoundedLineReader({
      maxBytes: 16,
      onLine: async (line) => {
        lines.push(line);
        return true;
      },
    });
    const encoded = Buffer.from('one\né😀\n', 'utf8');
    const emojiStart = encoded.indexOf(Buffer.from('😀'));

    await reader.push(encoded.subarray(0, emojiStart + 2));
    await reader.push(encoded.subarray(emojiStart + 2));
    await reader.end();

    expect(lines).toEqual(['one', 'é😀']);
  });

  it('rejects an oversized unterminated line once, retains no excess bytes, then resumes', async () => {
    const lines: string[] = [];
    let oversized = 0;
    const reader = new BoundedLineReader({
      maxBytes: 8 * 1024,
      onLine: async (line) => {
        lines.push(line);
        return true;
      },
      onOversized: async () => {
        oversized += 1;
        return true;
      },
    });

    // Send 4 MiB without a newline. The old process reader appended every
    // chunk indefinitely; this reader must retain none once it crosses 8 KiB.
    const chunk = Buffer.alloc(100 * 1024, 0x78);
    for (let index = 0; index < 40; index += 1) {
      await reader.push(chunk);
      expect(reader.bufferedBytes).toBeLessThanOrEqual(8 * 1024);
      expect(reader.bufferedBytes).toBe(0);
    }
    expect(reader.discardingOversizedLine).toBe(true);
    expect(oversized).toBe(1);

    await reader.push(Buffer.from('\nvalid\n', 'utf8'));
    expect(reader.discardingOversizedLine).toBe(false);
    expect(lines).toEqual(['valid']);
    expect(oversized).toBe(1);
  });

  it('handles a large chunk containing an oversized line and a following valid line', async () => {
    const lines: string[] = [];
    let oversized = 0;
    const reader = new BoundedLineReader({
      maxBytes: 4,
      onLine: async (line) => {
        lines.push(line);
        return true;
      },
      onOversized: async () => {
        oversized += 1;
        return true;
      },
    });

    await reader.push(Buffer.from('toolong\nok\n', 'utf8'));
    expect(oversized).toBe(1);
    expect(lines).toEqual(['ok']);
  });

  it('dispatches a final unterminated line when stdin closes', async () => {
    const lines: string[] = [];
    const reader = new BoundedLineReader({
      maxBytes: 16,
      onLine: async (line) => {
        lines.push(line);
        return true;
      },
    });

    await reader.push('last-line');
    await reader.end();
    expect(lines).toEqual(['last-line']);
  });
});
