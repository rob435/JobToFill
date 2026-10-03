import js from '@eslint/js';
import globals from 'globals';

const extension = { ...globals.browser, ...globals.webextensions };

export default [
  { ignores: ['node_modules/', 'dist/'] },
  js.configs.recommended,
  {
    // Classic scripts shared by the background, content scripts, extension pages and the Node tests.
    files: ['extension/background.js', 'extension/lib/**/*.js', 'extension/content/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...extension, ...globals.serviceworker, module: 'readonly' } },
  },
  {
    files: [
      'extension/ui/**/*.js',
      'extension/popup/**/*.js',
      'extension/options/**/*.js',
      'extension/studio/**/*.js',
      'extension/quick/**/*.js',
    ],
    languageOptions: { sourceType: 'module', globals: extension },
  },
  {
    files: ['scripts/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: { sourceType: 'module', globals: globals.node },
  },
  {
    // Test callbacks passed to page.evaluate() run in the browser.
    files: ['tests/**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node, ...extension } },
  },
  {
    // Fixture pages that use real React widgets (bundled by tests/fixtures/serve.mjs).
    files: ['tests/fixtures/src/**/*.jsx'],
    languageOptions: {
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node, chrome: 'writable' } },
  },
  {
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
    },
  },
];
