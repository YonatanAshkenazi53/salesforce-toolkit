// ESLint flat config for the Salesforce Toolkit extension.
//
// The extension is classic <script>-tag JS sharing one global scope per page
// (no modules yet — that's the Phase-6b split), so cross-file globals are the
// norm: no-undef / no-unused-vars would fire thousands of false positives and
// are disabled until the module split lands. What remains is the high-signal
// set: real syntax hazards, duplicate keys/cases/args, unreachable code,
// self-assignment — the bug classes that have actually bitten this codebase.
import js from '@eslint/js';

export default [
  {
    ignores: ['node_modules/**', '_harness*', '_smoketest*', '*.min.js'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
    },
    rules: {
      ...js.configs.recommended.rules,
      // Classic-script global scope — meaningless until the module split.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      // Template-heavy UI code trips these stylistically, not dangerously.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
      // The ones that catch real bugs:
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-fallthrough': 'error',
      'no-func-assign': 'error',
      'no-cond-assign': 'error',
      'valid-typeof': 'error',
      'use-isnan': 'error',
    },
  },
  {
    files: ['**/*.mjs', 'test/**'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
  },
];
