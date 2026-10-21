// @ts-check
import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'tests/.generated/**',
      'coverage/**',
      'docs/**',
      'node_modules/**',
      '*.config.js',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      // Mapped types like `{ [P in K]?: T }` are clearer than Partial<Record<K, T>> here.
      '@typescript-eslint/consistent-indexed-object-style': 'off',
      // `Record<never, never>` is used on purpose as the "no routes yet" type.
      '@typescript-eslint/no-generated-empty-object-type': 'off',
    },
  },
  {
    files: ['examples/**/*.{ts,tsx}'],
    rules: {
      // Examples mirror app code; React components read better without return annotations.
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      // Async generators without await stand in for real event sources.
      '@typescript-eslint/require-await': 'off',
    },
  },
  eslintConfigPrettier,
);
