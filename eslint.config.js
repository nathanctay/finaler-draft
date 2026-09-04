import js from '@eslint/js';
import globals from 'globals';
import astro from 'eslint-plugin-astro';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/routeTree.gen.ts',
      'playwright-report/**',
      'test-results/**',
      // Astro's generated content-collection types cache (apps/landing) -- not source.
      '**/.astro/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Lints apps/landing's .astro files: astro-eslint-parser for the template, with the frontmatter
  // script block still checked by typescript-eslint underneath (see astro's own `parserOptions`
  // in this config, which points its embedded TS parsing at `tseslint.parser`).
  ...astro.configs['flat/recommended'],
  {
    files: ['**/*.astro'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.astro'] },
    },
  },
  {
    files: [
      'apps/api/scripts/**/*.mjs',
      'apps/landing/*.mjs',
      'packages/database/scripts/**/*.mjs',
      'scripts/**/*.mjs',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
