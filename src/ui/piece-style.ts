export const PIECE_STYLES = {
  merida: { label: 'Merida', artist: 'Armando Hernandez Marroquin' },
  cburnett: { label: 'Cburnett', artist: 'Colin M. L. Burnett' },
  firi: { label: 'Firi', artist: 'James Faure' },
  kaneo: { label: 'Kaneo', artist: 'Kadagaden' },
};

export type PieceStyle = keyof typeof PIECE_STYLES;
export const DEFAULT_PIECE_STYLE: PieceStyle = 'merida';
export const PIECE_STYLE_STORAGE_KEY = 'kamkmchess.piece-style.v1';
const CHANGE_EVENT = 'kamkmchess:piece-style';
let currentStyle: PieceStyle | undefined;

export function isPieceStyle(value: unknown): value is PieceStyle {
  return typeof value === 'string' && Object.hasOwn(PIECE_STYLES, value);
}

function readStoredStyle(): PieceStyle {
  try {
    const saved = window.localStorage.getItem(PIECE_STYLE_STORAGE_KEY);
    return isPieceStyle(saved) ? saved : DEFAULT_PIECE_STYLE;
  } catch {
    return currentStyle ?? DEFAULT_PIECE_STYLE;
  }
}

export function getPieceStyle(): PieceStyle {
  return currentStyle ??= readStoredStyle();
}

/** Notify every board and picker in this tab, even when storage is blocked. */
export function setPieceStyle(value: string): void {
  if (!isPieceStyle(value)) return;
  currentStyle = value;
  try { window.localStorage.setItem(PIECE_STYLE_STORAGE_KEY, value); }
  catch { /* Keep the selected style for this page when storage is unavailable. */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribePieceStyle(onChange: () => void): () => void {
  const update = (event: StorageEvent) => {
    if (event.storageArea !== null && event.storageArea !== window.localStorage) return;
    if (event.key !== PIECE_STYLE_STORAGE_KEY && event.key !== null) return;
    currentStyle = readStoredStyle();
    onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener('storage', update);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', update);
  };
}
