import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { pieceImage, pieceImageVariables } from '../../src/ui/piece-image.js';
import { isPieceStyle, PIECE_STYLES } from '../../src/ui/piece-style.js';

describe('piece artwork', () => {
  it.each(Object.keys(PIECE_STYLES))('supplies every piece in the %s style to both rendering paths', async style => {
    if (!isPieceStyle(style)) throw new Error(`Unknown style: ${style}`);
    const variables = pieceImageVariables(style);
    const urls = new Set<string>();
    for (const color of ['w', 'b'] as const) {
      for (const type of ['k', 'q', 'r', 'b', 'n', 'p'] as const) {
        const url = pieceImage(color, type, style);
        const svg = await readFile(new URL(url), 'utf8');
        expect(svg).toContain('<svg');
        expect(svg).toMatch(/viewBox="[^"]+"/);
        expect(variables[`--piece-${color}${type}`]).toBe(`url("${url}")`);
        urls.add(url);
      }
    }
    expect(urls.size).toBe(12);
    expect(Object.keys(variables)).toHaveLength(12);
  });
});
