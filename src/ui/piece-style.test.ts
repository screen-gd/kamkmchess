import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const values = new Map<string, string>();
const storage = {
  getItem: vi.fn((key: string) => values.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
};

beforeEach(() => {
  vi.resetModules();
  values.clear();
  storage.getItem.mockReset().mockImplementation(key => values.get(key) ?? null);
  storage.setItem.mockReset().mockImplementation((key, value) => { values.set(key, value); });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: storage }));
});

afterEach(() => vi.unstubAllGlobals());

describe('piece style preferences', () => {
  it.each([null, '', 'unknown', 'toString', '__proto__', '{broken'])('defaults to Merida for invalid saved data %s', async saved => {
    const preferences = await import('./piece-style.js');
    if (saved !== null) values.set(preferences.PIECE_STYLE_STORAGE_KEY, saved);
    expect(preferences.getPieceStyle()).toBe('merida');
    preferences.setPieceStyle('unknown');
    expect(preferences.getPieceStyle()).toBe('merida');
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it.each(['merida', 'cburnett', 'firi', 'kaneo'])('restores the saved %s set on a new page', async style => {
    const preferences = await import('./piece-style.js');
    values.set(preferences.PIECE_STYLE_STORAGE_KEY, style);
    expect(preferences.getPieceStyle()).toBe(style);
  });

  it('persists a selection and updates all subscribers in the current tab', async () => {
    const preferences = await import('./piece-style.js');
    const board = vi.fn();
    const picker = vi.fn();
    const unsubscribeBoard = preferences.subscribePieceStyle(board);
    const unsubscribePicker = preferences.subscribePieceStyle(picker);
    try {
      preferences.setPieceStyle('firi');
      expect(preferences.getPieceStyle()).toBe('firi');
      expect(values.get(preferences.PIECE_STYLE_STORAGE_KEY)).toBe('firi');
      expect(board).toHaveBeenCalledOnce();
      expect(picker).toHaveBeenCalledOnce();
      unsubscribeBoard();
      preferences.setPieceStyle('kaneo');
      expect(board).toHaveBeenCalledOnce();
      expect(picker).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribeBoard();
      unsubscribePicker();
    }
  });

  it('applies changes from other tabs and resets after storage is cleared', async () => {
    const preferences = await import('./piece-style.js');
    const listener = vi.fn();
    const unsubscribe = preferences.subscribePieceStyle(listener);
    const notify = (key: string | null) => window.dispatchEvent(Object.assign(new Event('storage'), { key, storageArea: storage }));
    try {
      expect(preferences.getPieceStyle()).toBe('merida');
      values.set(preferences.PIECE_STYLE_STORAGE_KEY, 'cburnett');
      notify('unrelated-key');
      expect(listener).not.toHaveBeenCalled();
      notify(preferences.PIECE_STYLE_STORAGE_KEY);
      expect(preferences.getPieceStyle()).toBe('cburnett');
      values.clear();
      notify(null);
      expect(preferences.getPieceStyle()).toBe('merida');
      expect(listener).toHaveBeenCalledTimes(2);
    } finally { unsubscribe(); }
  });

  it('keeps switching styles in memory when browser storage is blocked', async () => {
    storage.getItem.mockImplementation(() => { throw new Error('Storage blocked'); });
    storage.setItem.mockImplementation(() => { throw new Error('Storage blocked'); });
    const preferences = await import('./piece-style.js');
    const listener = vi.fn();
    const unsubscribe = preferences.subscribePieceStyle(listener);
    try {
      expect(preferences.getPieceStyle()).toBe('merida');
      preferences.setPieceStyle('kaneo');
      expect(preferences.getPieceStyle()).toBe('kaneo');
      expect(listener).toHaveBeenCalledOnce();
    } finally { unsubscribe(); }
  });
});
