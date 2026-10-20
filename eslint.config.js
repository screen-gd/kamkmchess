import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['dist/**', 'build/**', 'coverage/**', 'node_modules/**', 'public/engines/**', '.scratch/**', 'experiments/**', 'test-results/**', 'playwright-report/**']),
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
  },
  {
    files: ['*.{js,ts}', 'api/**/*.ts', 'server/**/*.ts', 'scripts/**/*.mjs', 'tests/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    // The private rules worker runs in Node, not the browser application.
    files: ['src/online-rules-worker/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    // Quartz's registry deliberately exports icon definitions and variant helpers.
    files: ['src/components/quartz/icon.tsx', 'src/components/quartz/ui/button.tsx', 'src/components/quartz/ui/field.tsx', 'src/components/quartz/ui/input/parts.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  {
    files: ['src/components/quartz/ui/field.tsx'],
    rules: { '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_' }] },
  },
]);
