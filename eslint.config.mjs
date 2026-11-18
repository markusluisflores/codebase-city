import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    '.next/**',
    'dist/**',
    'node_modules/**',
    '.claude/**',
    'spikes/**',
    'coverage/**',
    'next-env.d.ts',
  ]),
  {
    rules: {
      'no-console': 'warn',
      '@typescript-eslint/no-explicit-any': 'error',
      // Repo-derived strings render only as text (plan Global Constraints).
      'react/no-danger': 'error',
      'no-restricted-properties': [
        'error',
        {
          property: 'innerHTML',
          message: 'Repo-derived strings render only as text; innerHTML is banned.',
        },
        {
          property: 'outerHTML',
          message: 'Repo-derived strings render only as text; outerHTML is banned.',
        },
        { property: 'insertAdjacentHTML', message: 'Repo-derived strings render only as text.' },
      ],
    },
  },
]);
