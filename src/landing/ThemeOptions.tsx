import { T3_PALETTES } from '../ui/t3-palettes.js';
import type { useTheme } from '../use-theme.js';
import { PieceStyleOptions } from '../ui/PieceStyleOptions.js';

export function ThemeOptions({ theme, appearance, setTheme, setAppearance }: ReturnType<typeof useTheme>) {
  return (
    <div className="theme-options">
      <label>Theme
        <select value={theme} onChange={event => setTheme(event.target.value)}>
          {T3_PALETTES.map(palette => <option key={palette.id} value={palette.id}>{palette.label}</option>)}
        </select>
      </label>
      <label>Appearance
        <select value={appearance} onChange={event => setAppearance(event.target.value)}>
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <PieceStyleOptions />
    </div>
  );
}
