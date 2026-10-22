import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PieceStyleOptions } from './PieceStyleOptions.js';

describe('piece style settings', () => {
  it('offers all four styles with an accessible label and a complete preview', () => {
    const markup = renderToStaticMarkup(<PieceStyleOptions />);
    expect(markup).toContain('<label>Piece style<select');
    for (const label of ['Merida', 'Cburnett', 'Firi', 'Kaneo']) expect(markup).toContain(`>${label}</option>`);
    expect(markup).toContain('role="img" aria-label="Merida pieces"');
    expect(markup.match(/<img /g)).toHaveLength(12);
    expect(markup).toContain('By Armando Hernandez Marroquin');
  });
});
