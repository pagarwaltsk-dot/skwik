import globals from '/tmp/aud/node_modules/globals/index.js';
export default [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node, __DEV__: 'readonly' },
    },
    linterOptions: { reportUnusedDisableDirectives: false },
    rules: {
      'no-undef': 'error',          // the one that matters: a name used and never bound
    },
  },
];
